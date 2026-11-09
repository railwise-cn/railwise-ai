import { randomUUID } from 'node:crypto'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, rm, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalTool } from './local-tool-host.js'
import { defineLocalTool } from './local-tool-definition.js'
import { OutputAccumulator } from './output-accumulator.js'
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from './truncate.js'
import type {
  BashLocalToolOptions,
  BashSessionLifecycle,
  TextSlice,
  TruncateMode
} from './builtin-tool-types.js'
import { DEFAULT_BASH_TIMEOUT_SECONDS } from './builtin-tool-types.js'
import {
  describeKind,
  normalizePositiveInteger,
  shellCommandArgs,
  shellRuntimeInfo,
  terminateSpawnTree,
  waitForSpawnExit,
  withToolBoundary,
  workspaceRoot
} from './builtin-tool-utils.js'
import { safeSpawn } from './safe-spawn.js'
import { RUNTIME_RESOURCE_LIMITS_V1 } from '../../contracts/resource-limits.js'
import { summarizeBashCommandForPersistence } from '../../security/tool-persistence-security.js'
import { processIdentity, inspectProcess } from '../../services/process-identity.js'
import type { CapacityManager, CapacityPermit } from '../../services/capacity-manager.js'

const DEFAULT_BASH_YIELD_SECONDS = 10
const MAX_BASH_YIELD_SECONDS = 60
const SESSION_EXIT_FLUSH_MS = 50
const STOP_GRACE_MS = 1000
const FINISHED_SESSION_RETENTION_MS = 10 * 60 * 1000

type BashSessionStatus = 'running' | 'completed' | 'stopped' | 'failed'

type BashSession = {
  id: string
  command: string
  cwd: string
  shell: string
  child: ChildProcessWithoutNullStreams
  output: OutputAccumulator
  startedAt: string
  finishedAt?: string
  exitCode: number | null
  status: BashSessionStatus
  error?: string
  stopRequested: boolean
  finalized: boolean
  rawOutputBytes: number
  exitWaiters: Set<() => void>
  persistentOutput: boolean
  lifecycle?: BashSessionLifecycle
  capacityPermit?: CapacityPermit
  startedPersistence?: Promise<void>
  finishedPersistence?: Promise<void>
  cleanupExecution?: () => void
}

type BashPayload = {
  cwd: string
  shell: string
  exit_code: number | null
  output: string
  full_output_path: string | null
  truncation: null | {
    total_lines: number
    output_lines: number
    total_bytes: number
    output_bytes: number
    truncated_by: string | null
    last_line_partial: boolean
  }
  session_id?: string
  status?: BashSessionStatus
  started_at?: string
  finished_at?: string
  pid?: number
  partial?: boolean
  stop_sent?: boolean
  error?: string
}

const bashSessions = new Map<string, BashSession>()
let activeTemporaryOutputBytes = 0

async function disposeSession(session: BashSession): Promise<void> {
  activeTemporaryOutputBytes = Math.max(0, activeTemporaryOutputBytes - session.rawOutputBytes)
  session.rawOutputBytes = 0
  await session.output.closeTempFile().catch(() => undefined)
  const path = session.output.snapshot().fullOutputPath
  if (path && !session.persistentOutput) await rm(path, { force: true }).catch(() => undefined)
  bashSessions.delete(session.id)
}

export async function stopAllBashSessions(reason = 'application_exit'): Promise<number> {
  const running = [...bashSessions.values()].filter((session) => session.status === 'running')
  for (const session of running) {
    session.stopRequested = true
    terminateSpawnTree(session.child)
  }
  await Promise.all(running.map((session) => waitForSessionExitOrDelay(session, STOP_GRACE_MS)))
  for (const session of running) {
    if (session.status === 'running') terminateSpawnTree(session.child, { signal: 'SIGKILL' })
  }
  await Promise.all(running.map(session => waitForSessionExitOrDelay(session, STOP_GRACE_MS)))
  if (running.some(session => session.status === 'running')) throw new Error(`Shell shutdown could not confirm process exit (${reason}); results remain unknown.`)
  await Promise.all([...bashSessions.values()].map(session => session.finishedPersistence))
  await Promise.all([...bashSessions.values()].map(disposeSession))
  return running.length
}

export async function stopBashSession(sessionId: string): Promise<boolean> {
  const session = bashSessions.get(sessionId)
  if (!session) return false
  if (session.status === 'running') {
    stopSession(session)
    await waitForSessionExitOrDelay(session, STOP_GRACE_MS)
    if (session.status === 'running') settleSession(session, 'stopped', null, 'terminated by user')
  }
  return true
}

async function bashExecute(
  command: string,
  cwd: string,
  signal: AbortSignal,
  timeoutSeconds: number,
  onUpdate?: (update: { output: unknown; isError?: boolean }) => Promise<void> | void,
  execOperation?: (
    command: string,
    cwd: string,
    options: { signal: AbortSignal; timeoutSeconds: number; onData?: (data: Buffer) => void }
  ) => Promise<{ exitCode: number | null; shell?: string }>
): Promise<{
  output: string
  exitCode: number | null
  shell: string
  truncated: TextSlice
  fullOutputPath?: string
}> {
  const shellRuntime = shellRuntimeInfo()
  let resultShell = shellRuntime.name
  const child = execOperation
    ? null
    : await safeSpawn(shellRuntime.shell, shellCommandArgs(shellRuntime, command), {
        cwd,
        workspace: cwd,
        env: process.env,
        detached: process.platform !== 'win32',
        windowsHide: true
      })
  let timedOut = false
  let settled = false
  const output = new OutputAccumulator({
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
    tempFilePrefix: 'workwise-shell'
  })
  let updateDirty = false
  let rawOutputBytes = 0
  let outputLimitExceeded = false
  let updateTimer: NodeJS.Timeout | undefined
  let lastUpdateAt = 0
  const handleData = (chunk: Buffer) => {
    rawOutputBytes += chunk.byteLength
    activeTemporaryOutputBytes += chunk.byteLength
    if (
      rawOutputBytes > RUNTIME_RESOURCE_LIMITS_V1.shellRawBytes ||
      activeTemporaryOutputBytes > RUNTIME_RESOURCE_LIMITS_V1.temporaryToolOutputBytes
    ) {
      outputLimitExceeded = true
      kill()
      return
    }
    output.append(chunk)
    scheduleUpdate()
  }
  const emitUpdate = async () => {
    if (!onUpdate || !updateDirty) return
    updateDirty = false
    lastUpdateAt = Date.now()
    const snapshot = output.snapshot({ persistIfTruncated: true })
    await onUpdate({
      output: {
        cwd,
        shell: resultShell,
        exit_code: null,
        output: snapshot.content,
        full_output_path: snapshot.fullOutputPath ?? null,
        truncation: snapshot.truncation.truncated
          ? {
              total_lines: snapshot.truncation.totalLines,
              output_lines: snapshot.truncation.outputLines,
              total_bytes: snapshot.truncation.totalBytes,
              output_bytes: snapshot.truncation.outputBytes,
              truncated_by: snapshot.truncation.truncatedBy ?? null,
              last_line_partial: snapshot.truncation.lastLinePartial === true
            }
          : null,
        partial: true
      }
    })
  }
  const scheduleUpdate = () => {
    if (!onUpdate) return
    updateDirty = true
    const delay = 100 - (Date.now() - lastUpdateAt)
    if (delay <= 0) {
      void emitUpdate()
      return
    }
    if (updateTimer) return
    updateTimer = setTimeout(() => {
      updateTimer = undefined
      void emitUpdate()
    }, delay)
  }
  const kill = () => {
    if (settled) return
    if (!child) return
    terminateSpawnTree(child)
  }
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, timeoutSeconds * 1000)
  const onAbort = () => kill()
  let exitCode: number | null
  let executionError: unknown
  if (execOperation) {
    try {
      const result = await execOperation(command, cwd, {
        signal,
        timeoutSeconds,
        onData: handleData
      })
      exitCode = result.exitCode
      resultShell = result.shell ?? resultShell
    } catch (error) {
      executionError = error
      exitCode = null
    } finally {
      settled = true
      clearTimeout(timer)
      if (updateTimer) clearTimeout(updateTimer)
    }
  } else {
    if (!child) throw new Error('shell process failed to start')
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer | string) => {
      handleData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      handleData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    exitCode = await waitForSpawnExit(child).finally(() => {
      settled = true
      clearTimeout(timer)
      if (updateTimer) clearTimeout(updateTimer)
      signal.removeEventListener('abort', onAbort)
    })
  }

  output.finish()
  await emitUpdate()
  const snapshot = output.snapshot({ persistIfTruncated: true })
  await output.closeTempFile()
  activeTemporaryOutputBytes = Math.max(0, activeTemporaryOutputBytes - rawOutputBytes)

  if (executionError) throw executionError

  if (signal.aborted) {
    throw new Error('command aborted')
  }
  if (timedOut) {
    throw new Error(`command timed out after ${timeoutSeconds} seconds`)
  }
  if (outputLimitExceeded) {
    throw Object.assign(new Error('shell output exceeded its hard limit'), { code: 'resource_limit' })
  }

  const truncated: TextSlice = {
    text: snapshot.content,
    truncated: snapshot.truncation.truncated,
    totalLines: snapshot.truncation.totalLines,
    shownLines: snapshot.truncation.outputLines,
    totalBytes: snapshot.truncation.totalBytes,
    shownBytes: snapshot.truncation.outputBytes,
    firstLineExceedsLimit: snapshot.truncation.firstLineExceedsLimit,
    truncatedBy: snapshot.truncation.truncatedBy ?? undefined,
    lastLinePartial: snapshot.truncation.lastLinePartial
  }
  return {
    output: snapshot.content,
    exitCode,
    shell: resultShell,
    truncated,
    fullOutputPath: snapshot.fullOutputPath
  }
}

function createOutputAccumulator(outputFilePath?: string): OutputAccumulator {
  return new OutputAccumulator({
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
    tempFilePrefix: 'workwise-shell',
    ...(outputFilePath ? { outputFilePath } : {})
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function nextSessionId(): string {
  return `bash_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function textSliceFromSnapshot(snapshot: ReturnType<OutputAccumulator['snapshot']>): TextSlice {
  return {
    text: snapshot.content,
    truncated: snapshot.truncation.truncated,
    totalLines: snapshot.truncation.totalLines,
    shownLines: snapshot.truncation.outputLines,
    totalBytes: snapshot.truncation.totalBytes,
    shownBytes: snapshot.truncation.outputBytes,
    firstLineExceedsLimit: snapshot.truncation.firstLineExceedsLimit,
    truncatedBy: snapshot.truncation.truncatedBy ?? undefined,
    lastLinePartial: snapshot.truncation.lastLinePartial
  }
}

function truncationPayload(truncated: TextSlice): BashPayload['truncation'] {
  return truncated.truncated
    ? {
        total_lines: truncated.totalLines,
        output_lines: truncated.shownLines,
        total_bytes: truncated.totalBytes,
        output_bytes: truncated.shownBytes,
        truncated_by: truncated.truncatedBy ?? null,
        last_line_partial: truncated.lastLinePartial === true
      }
    : null
}

function resultPayload(input: {
  cwd: string
  shell: string
  exitCode: number | null
  output: string
  truncated: TextSlice
  fullOutputPath?: string
}): BashPayload {
  return {
    cwd: input.cwd,
    shell: input.shell,
    exit_code: input.exitCode,
    output: appendTruncationNotice(input.output, input.truncated, 'tail'),
    full_output_path: input.fullOutputPath ?? null,
    truncation: truncationPayload(input.truncated)
  }
}

async function finalizeSessionOutput(session: BashSession): Promise<void> {
  if (session.finalized) return
  await sleep(SESSION_EXIT_FLUSH_MS)
  session.output.finish()
  await session.output.closeTempFile()
  session.finalized = true
}

async function sessionPayload(
  session: BashSession,
  options: { stopSent?: boolean } = {}
): Promise<BashPayload> {
  if (session.status !== 'running') {
    if (session.finishedPersistence) await session.finishedPersistence
    else await finalizeSessionOutput(session)
  }
  const snapshot = session.output.snapshot({ persistIfTruncated: true })
  const truncated = textSliceFromSnapshot(snapshot)
  return {
    cwd: session.cwd,
    shell: session.shell,
    exit_code: session.exitCode,
    output: appendTruncationNotice(snapshot.content, truncated, 'tail'),
    full_output_path: snapshot.fullOutputPath ?? null,
    truncation: truncationPayload(truncated),
    session_id: session.id,
    status: session.status,
    started_at: session.startedAt,
    ...(session.finishedAt ? { finished_at: session.finishedAt } : {}),
    ...(typeof session.child.pid === 'number' ? { pid: session.child.pid } : {}),
    ...(session.status === 'running' ? { partial: true } : {}),
    ...(options.stopSent ? { stop_sent: true } : {}),
    ...(session.error ? { error: session.error } : {})
  }
}

function scheduleSessionCleanup(session: BashSession): void {
  const timer = setTimeout(() => {
    if (session.status !== 'running') void disposeSession(session)
  }, FINISHED_SESSION_RETENTION_MS)
  timer.unref?.()
}

function settleSession(
  session: BashSession,
  status: Exclude<BashSessionStatus, 'running'>,
  exitCode: number | null,
  error?: string
): void {
  if (session.status !== 'running') return
  session.status = status
  session.exitCode = exitCode
  session.finishedAt = new Date().toISOString()
  if (error) session.error = error
  session.cleanupExecution?.()
  session.capacityPermit?.release()
  session.finishedPersistence = Promise.resolve(session.startedPersistence).then(async () => {
    await finalizeSessionOutput(session)
    await session.lifecycle?.onFinished?.({
      sessionId: session.id,
      status: status === 'stopped' ? 'terminated' : status,
      ...(exitCode !== null ? { exitCode } : {}),
      outputBytes: session.rawOutputBytes,
      finishedAt: session.finishedAt!
    })
  })
  // Keep failure observable at shutdown/poll, without an unhandled rejection
  // when a process finishes between tool polls.
  void session.finishedPersistence.catch(() => undefined)
  for (const waiter of session.exitWaiters) waiter()
  session.exitWaiters.clear()
  scheduleSessionCleanup(session)
}

function waitForSessionExitOrDelay(session: BashSession, ms: number): Promise<boolean> {
  if (session.status !== 'running') return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      session.exitWaiters.delete(onExit)
      resolve(false)
    }, Math.max(0, ms))
    const onExit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    session.exitWaiters.add(onExit)
  })
}

function stopSession(session: BashSession): void {
  if (session.status !== 'running') return
  session.stopRequested = true
  terminateSpawnTree(session.child)
}

function normalizeYieldSeconds(value: unknown): number {
  const raw = normalizePositiveInteger(value, DEFAULT_BASH_YIELD_SECONDS)
  return Math.max(1, Math.min(MAX_BASH_YIELD_SECONDS, raw))
}

function sessionById(sessionId: unknown): BashSession | null {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  return id ? bashSessions.get(id) ?? null : null
}

async function startBashSession(
  input: {
    command: string
    cwd: string
    signal: AbortSignal
    timeoutSeconds: number
    yieldSeconds: number
    threadId: string
    turnId: string
    workspaceRoot: string
    sessionOutputRoot?: string
    lifecycle?: BashSessionLifecycle
    capacityManager?: CapacityManager
  },
  onUpdate?: (update: { output: unknown; isError?: boolean }) => Promise<void> | void
): Promise<{ payload: BashPayload; isError?: boolean }> {
  const runningProcessCount = [...bashSessions.values()].filter(
    (session) => session.status === 'running'
  ).length
  if (runningProcessCount >= RUNTIME_RESOURCE_LIMITS_V1.processesApplication) {
    throw Object.assign(new Error('the application process limit has been reached'), {
      code: 'resource_limit'
    })
  }
  const workspaceProcessCount = [...bashSessions.values()].filter(
    (session) => session.status === 'running' && session.cwd === input.cwd
  ).length
  if (workspaceProcessCount >= RUNTIME_RESOURCE_LIMITS_V1.processesPerWorkspace) {
    throw Object.assign(new Error('the workspace process limit has been reached'), {
      code: 'resource_limit'
    })
  }
  const shellRuntime = shellRuntimeInfo()
  const sessionId = nextSessionId()
  const capacityPermit = input.capacityManager?.reserve({ id: `shell:${sessionId}`, workspaceRoot: input.workspaceRoot, resources: { shell: 1 } })
  const outputFilePath = input.sessionOutputRoot
    ? join(input.sessionOutputRoot, `${sessionId}.log`)
    : undefined
  let child: ChildProcessWithoutNullStreams
  try {
    if (input.sessionOutputRoot) await mkdir(input.sessionOutputRoot, { recursive: true })
    child = await safeSpawn(shellRuntime.shell, shellCommandArgs(shellRuntime, input.command), {
      cwd: input.cwd, workspace: input.cwd, env: process.env,
      detached: process.platform !== 'win32', windowsHide: true
    })
  } catch (error) { capacityPermit?.release(); throw error }
  const session: BashSession = {
    id: sessionId,
    command: input.command,
    cwd: input.cwd,
    shell: shellRuntime.name,
    child,
    output: createOutputAccumulator(outputFilePath),
    startedAt: new Date().toISOString(),
    exitCode: null,
    status: 'running',
    stopRequested: false,
    finalized: false,
    rawOutputBytes: 0,
    exitWaiters: new Set(),
    persistentOutput: Boolean(outputFilePath),
    ...(capacityPermit ? { capacityPermit } : {}),
    ...(input.lifecycle ? { lifecycle: input.lifecycle } : {})
  }
  bashSessions.set(session.id, session)
  const identity = child.pid ? processIdentity(child.pid) : null
  session.startedPersistence = Promise.resolve().then(async () => {
    if (outputFilePath) await input.lifecycle?.onStarted?.({
        sessionId,
        threadId: input.threadId,
        turnId: input.turnId,
        workspaceRoot: input.workspaceRoot,
        cwd: input.cwd,
        commandSummary: summarizeBashCommandForPersistence(input.command),
        outputPath: outputFilePath,
        startedAt: session.startedAt,
        ...(child.pid ? { pid: child.pid, ...(process.platform !== 'win32' ? { processGroup: child.pid } : {}) } : {}),
        ...(identity ? { processFingerprint: identity.fingerprint } : {})
      })
  })

  let updateDirty = false
  let updateTimer: NodeJS.Timeout | undefined
  let lastUpdateAt = 0
  let liveUpdates = true
  const emitUpdate = async () => {
    if (!liveUpdates || !onUpdate || !updateDirty) return
    updateDirty = false
    lastUpdateAt = Date.now()
    await onUpdate({ output: await sessionPayload(session) })
  }
  const scheduleUpdate = () => {
    if (!liveUpdates || !onUpdate) return
    updateDirty = true
    const delay = 100 - (Date.now() - lastUpdateAt)
    if (delay <= 0) {
      void emitUpdate()
      return
    }
    if (updateTimer) return
    updateTimer = setTimeout(() => {
      updateTimer = undefined
      void emitUpdate()
    }, delay)
  }
  const handleData = (chunk: Buffer | string) => {
    if (session.finalized) return
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    session.rawOutputBytes += data.byteLength
    activeTemporaryOutputBytes += data.byteLength
    if (
      session.rawOutputBytes > RUNTIME_RESOURCE_LIMITS_V1.shellRawBytes ||
      activeTemporaryOutputBytes > RUNTIME_RESOURCE_LIMITS_V1.temporaryToolOutputBytes
    ) {
      terminateSpawnTree(session.child)
      settleSession(session, 'failed', null, 'shell output exceeded a hard limit')
      return
    }
    session.output.append(data)
    scheduleUpdate()
  }
  child.stdout.on('data', handleData)
  child.stderr.on('data', handleData)
  child.once('error', (error) => {
    settleSession(session, 'failed', null, error.message)
  })
  child.once('exit', (code) => {
    settleSession(session, session.stopRequested ? 'stopped' : 'completed', code)
  })
  // Register exit/output listeners before awaiting the durable start receipt;
  // a short command may otherwise finish while SQLite is being written.
  try { await session.startedPersistence } catch (error) {
    stopSession(session)
    await waitForSessionExitOrDelay(session, STOP_GRACE_MS)
    throw error
  }

  const onAbort = () => stopSession(session)
  input.signal.addEventListener('abort', onAbort, { once: true })
  const timeoutMs = input.timeoutSeconds * 1000
  const commandTimer = setTimeout(() => stopSession(session), timeoutMs)
  commandTimer.unref?.()
  session.cleanupExecution = () => { clearTimeout(commandTimer); input.signal.removeEventListener('abort', onAbort) }
  if (session.status !== 'running') session.cleanupExecution()
  const yieldMs = Math.min(input.yieldSeconds * 1000, timeoutMs)
  const exited = await waitForSessionExitOrDelay(session, yieldMs)
  if (updateTimer) clearTimeout(updateTimer)

  if (input.signal.aborted) {
    liveUpdates = false
    stopSession(session)
    throw new Error('command aborted')
  }
  if (!exited && timeoutMs <= yieldMs) {
    liveUpdates = false
    stopSession(session)
    await waitForSessionExitOrDelay(session, STOP_GRACE_MS)
    throw new Error(`command timed out after ${input.timeoutSeconds} seconds`)
  }

  if (exited) {
    await emitUpdate()
    liveUpdates = false
    const payload = await sessionPayload(session)
    if (session.status === 'failed') return { payload, isError: true }
    return { payload, isError: session.exitCode !== null && session.exitCode !== 0 }
  }

  await emitUpdate()
  liveUpdates = false
  return { payload: await sessionPayload(session) }
}

function appendTruncationNotice(text: string, truncated: TextSlice, mode: TruncateMode): string {
  if (!truncated.truncated) return text
  const prefix = text.trimEnd()
  const notice = truncated.firstLineExceedsLimit
    ? `[first line exceeds ${formatSize(DEFAULT_MAX_BYTES)}; refine the read range or use bash for a byte-limited slice]`
    : `[truncated: showing ${describeKind(mode)} ${truncated.shownLines} of ${truncated.totalLines} lines, ${truncated.shownBytes} of ${truncated.totalBytes} bytes]`
  return prefix ? `${prefix}\n\n${notice}` : notice
}

export function createBashLocalTool(options: BashLocalToolOptions = {}): LocalTool {
  const bashOps = options.operations
  const shellRuntime = shellRuntimeInfo()
  return defineLocalTool({
    name: 'bash',
    description: `Execute a shell command in the workspace using the host platform shell. Current shell: ${shellRuntime.name}. Use ${shellRuntime.syntax} syntax. Return combined stdout and stderr. Long-running commands return a session_id; use action="poll" to block up to yield_seconds (default ${DEFAULT_BASH_YIELD_SECONDS}s, max ${MAX_BASH_YIELD_SECONDS}s) waiting for more output or process exit, action="write" with input to send stdin, or action="stop" to terminate the session.`,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number' },
        yield_seconds: { type: 'number' },
        action: {
          type: 'string',
          enum: ['run', 'poll', 'write', 'stop']
        },
        session_id: { type: 'string' },
        input: { type: 'string' }
      },
      required: [],
      additionalProperties: false
    },
    policy: 'on-request',
    toolKind: 'command_execution',
    execute: async (args, context, onUpdate) => withToolBoundary(async () => {
      const action = typeof args.action === 'string' ? args.action.trim() : ''
      if (action && action !== 'run') {
        if (action !== 'poll' && action !== 'write' && action !== 'stop') {
          return { output: { error: `unsupported bash session action: ${action}` }, isError: true }
        }
        const session = sessionById(args.session_id)
        if (!session) {
          const recovered = typeof args.session_id === 'string' ? options.recoverSession?.(args.session_id, context.threadId) : null
          if (recovered && action === 'poll') {
            let output = ''
            if (recovered.outputPath) {
              const handle = await open(recovered.outputPath, 'r')
              try {
                const info = await handle.stat()
                const buffer = Buffer.alloc(Math.min(info.size, DEFAULT_MAX_BYTES))
                const read = await handle.read(buffer, 0, buffer.length, Math.max(0, info.size - buffer.length))
                output = buffer.subarray(0, read.bytesRead).toString('utf8')
              } finally { await handle.close() }
            }
            const identity = recovered.pid && recovered.processFingerprint ? { pid: recovered.pid, fingerprint: recovered.processFingerprint } : null
            return { output: { session_id: recovered.id, output, cwd: recovered.cwd, status: recovered.status, process_state: identity ? inspectProcess(identity) : 'unknown', full_output_path: recovered.outputPath, recovered: true, read_only: true } }
          }
          if (recovered) return { output: { error: 'Recovered process must be verified before writing or stopping; read-only poll remains available.', session_id: recovered.id, code: 'outcome_unknown' }, isError: true }
          return { output: { error: 'bash session not found', session_id: args.session_id ?? null }, isError: true }
        }
        if (action === 'write') {
          if (session.status !== 'running') {
            return { output: await sessionPayload(session), isError: true }
          }
          const input = typeof args.input === 'string' ? args.input : ''
          session.child.stdin.write(input)
          await waitForSessionExitOrDelay(session, normalizeYieldSeconds(args.yield_seconds) * 1000)
          const payload = await sessionPayload(session)
          return { output: payload, isError: payload.status === 'failed' }
        }
        if (action === 'stop') {
          stopSession(session)
          await waitForSessionExitOrDelay(session, STOP_GRACE_MS)
          const payload = await sessionPayload(session, { stopSent: true })
          return { output: payload, isError: session.status === 'running' || session.status === 'failed' }
        }
        await waitForSessionExitOrDelay(session, normalizeYieldSeconds(args.yield_seconds) * 1000)
        return { output: await sessionPayload(session), isError: session.status === 'failed' }
      }

      const command = typeof args.command === 'string' ? args.command : ''
      if (!command.trim()) return { output: { error: 'command is required' }, isError: true }
      const timeout = normalizePositiveInteger(
        args.timeout,
        options.defaultTimeoutSeconds ?? DEFAULT_BASH_TIMEOUT_SECONDS
      )
      const yieldSeconds = normalizeYieldSeconds(args.yield_seconds)
      const cwd = workspaceRoot(context.workspace)
      try {
        if (!bashOps?.exec) {
          const result = await startBashSession(
            {
              command,
              cwd,
              signal: context.abortSignal,
              timeoutSeconds: timeout,
              yieldSeconds,
              threadId: context.threadId,
              turnId: context.turnId,
              workspaceRoot: context.workspace,
              ...(options.capacityManager ? { capacityManager: options.capacityManager } : {}),
              ...(options.sessionOutputRoot ? { sessionOutputRoot: options.sessionOutputRoot } : {}),
              ...(options.sessionLifecycle ? { lifecycle: options.sessionLifecycle } : {})
            },
            onUpdate
          )
          return {
            output: result.payload,
            isError: result.isError
          }
        }
        const result = await bashExecute(
          command,
          cwd,
          context.abortSignal,
          timeout,
          onUpdate,
          bashOps.exec
        )
        const payload = resultPayload({
          cwd,
          shell: result.shell,
          exitCode: result.exitCode ?? 0,
          output: result.output,
          truncated: result.truncated,
          fullOutputPath: result.fullOutputPath
        })
        if (result.exitCode && result.exitCode !== 0) {
          return {
            output: payload,
            isError: true
          }
        }
        return {
          output: payload
        }
      } catch (error) {
        return {
          output: {
            cwd,
            error: error instanceof Error ? error.message : String(error)
          },
          isError: true
        }
      }
    })
  })
}

export const createBashTool = createBashLocalTool
export const createBashToolDefinition = createBashLocalTool
