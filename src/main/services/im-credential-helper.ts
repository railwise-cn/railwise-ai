import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { app, safeStorage } from 'electron'
import { isCandidateCredentialAccessAllowed } from '../candidate-runtime'

const HELPER_ARG = '--im-credential-helper'
const HELPER_INTERACTIVE_ARG = '--im-credential-helper-interactive'
const HELPER_SOCKET_ARG = '--im-credential-helper-socket='
const HELPER_SOCKET_ROOT_ARG = '--im-credential-helper-socket-root='
const MAX_HELPER_MESSAGE_BYTES = 512 * 1024
// Background reads are bounded so optional credentials cannot delay recovery.
// Explicit retries give the user time to answer the system authorization prompt.
export const IM_CREDENTIAL_HELPER_TIMEOUT_MS = 30_000
export const IM_CREDENTIAL_HELPER_INTERACTIVE_TIMEOUT_MS = 120_000
const HELPER_SOCKET_ROOT_NAME = `workwise-im-${process.pid}-${randomBytes(6).toString('hex')}`
const activeCredentialHelperProcesses = new Set<ChildProcess>()
let interactiveCredentialHelperRequested = false
const CANDIDATE_HELPER_ENV_KEYS = [
  'WORKWISE_CANDIDATE',
  'WORKWISE_CANDIDATE_ROOT',
  'WORKWISE_CANDIDATE_USER_DATA',
  'WORKWISE_CANDIDATE_CACHE',
  'WORKWISE_CANDIDATE_LOGS',
  'WORKWISE_CANDIDATE_HOME',
  'WORKWISE_CANDIDATE_CREDENTIAL_ACCESS'
] as const

export type CredentialHelperRequest = {
  operation: 'encrypt' | 'decrypt'
  value: string
  /** Local scheduling metadata, omitted from the helper socket protocol. */
  interactive?: boolean
}

export type CredentialHelperErrorCode =
  | 'credential_helper_access_denied'
  | 'credential_helper_protocol'
  | 'credential_helper_socket'
  | 'credential_helper_start_failed'
  | 'credential_helper_timeout'

type CredentialHelperResponse = {
  type?: 'result'
  ok: boolean
  value?: string
}

type CredentialHelperReady = {
  type: 'ready'
  pid: number
}

type CredentialHelperMessage = CredentialHelperRequest | CredentialHelperResponse | CredentialHelperReady

function credentialHelperError(code: CredentialHelperErrorCode, message: string): Error {
  return Object.assign(new Error(message), { code })
}

export function isCredentialHelperAuthorizationFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  const code = String(error.code)
  return code === 'credential_helper_access_denied' || code === 'credential_helper_timeout'
}

export function isImCredentialHelperProcess(argv: readonly string[] = process.argv): boolean {
  return argv.includes(HELPER_ARG)
}

export function isInteractiveImCredentialHelperProcess(argv: readonly string[] = process.argv): boolean {
  return argv.includes(HELPER_ARG) && argv.includes(HELPER_INTERACTIVE_ARG)
}

export function requestInteractiveCredentialHelperAccess(): void {
  interactiveCredentialHelperRequested = true
}

export function consumeInteractiveCredentialHelperAccess(): boolean {
  const requested = interactiveCredentialHelperRequested
  interactiveCredentialHelperRequested = false
  return requested
}

export function credentialHelperUserDataPath(
  source: NodeJS.ProcessEnv = process.env,
  applicationUserDataPath: string = app.getPath('userData')
): string {
  if (source.WORKWISE_CANDIDATE === '1') {
    const candidateUserData = source.WORKWISE_CANDIDATE_USER_DATA?.trim()
    if (candidateUserData && isAbsolute(candidateUserData)) {
      return join(resolve(candidateUserData), 'credential-helper')
    }
    const candidateRoot = source.WORKWISE_CANDIDATE_ROOT?.trim()
    if (candidateRoot && isAbsolute(candidateRoot)) {
      return join(resolve(candidateRoot), 'user-data', 'credential-helper')
    }
  }
  return join(applicationUserDataPath, 'credential-helper')
}

function helperRoot(source: NodeJS.ProcessEnv = process.env): string {
  return credentialHelperUserDataPath(source)
}

export function imCredentialHelperSocketBase(
  platform: NodeJS.Platform = process.platform,
  systemTempDir: string = tmpdir()
): string {
  // macOS limits Unix-domain socket paths to roughly 104 bytes. /tmp is kept
  // deliberately short even when the isolated candidate userData path is long.
  return platform === 'darwin' ? '/tmp' : systemTempDir
}

function helperSocketRoot(): string {
  return join(imCredentialHelperSocketBase(), HELPER_SOCKET_ROOT_NAME)
}

function helperArgs(socketPath: string, socketRoot: string, interactive: boolean, userData: string): string[] {
  return [
    ...(app.isPackaged ? [] : [app.getAppPath()]),
    HELPER_ARG,
    ...(interactive ? [HELPER_INTERACTIVE_ARG] : []),
    `${HELPER_SOCKET_ARG}${socketPath}`,
    `${HELPER_SOCKET_ROOT_ARG}${socketRoot}`,
    `--user-data-dir=${userData}`
  ]
}

export function credentialHelperEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: source.HOME,
    USER: source.USER,
    LOGNAME: source.LOGNAME,
    PATH: source.PATH,
    TMPDIR: source.TMPDIR,
    LANG: source.LANG,
    LC_ALL: source.LC_ALL,
    WORKWISE_STARTUP_TRACE: '0'
  }
  for (const key of CANDIDATE_HELPER_ENV_KEYS) {
    const value = source[key]
    if (typeof value === 'string' && value) env[key] = value
  }
  return env
}

export function credentialHelperExecutable(
  env: NodeJS.ProcessEnv = process.env,
  currentExecutable: string = process.execPath
): string {
  if (env.WORKWISE_CANDIDATE !== '1') return currentExecutable
  const override = env.WORKWISE_CANDIDATE_CREDENTIAL_HELPER?.trim()
  if (!override) return currentExecutable
  const candidateRoot = env.WORKWISE_CANDIDATE_ROOT?.trim()
  if (!candidateRoot || !isAbsolute(candidateRoot) || !isAbsolute(override)) {
    throw new Error('Candidate credential helper paths must be absolute.')
  }
  const root = resolve(candidateRoot)
  const executable = resolve(override)
  const rel = relative(root, executable)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('Candidate credential helper must remain inside WORKWISE_CANDIDATE_ROOT.')
  }
  return executable
}

export function credentialHelperProcessConfig(
  source: NodeJS.ProcessEnv = process.env,
  currentExecutable: string = process.execPath
): { env: NodeJS.ProcessEnv; executable: string } {
  return {
    // Select the stable candidate helper from the original environment, then
    // pass only the allowlisted process state to the credential subprocess.
    env: credentialHelperEnvironment(source),
    executable: credentialHelperExecutable(source, currentExecutable)
  }
}

export function credentialHelperLaunch(
  env: NodeJS.ProcessEnv,
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  packaged = app.isPackaged
): { command: string; args: string[] } {
  if (platform !== 'darwin' || !packaged || env.WORKWISE_CANDIDATE !== '1') {
    return { command: executable, args: [...args] }
  }
  const root = env.WORKWISE_CANDIDATE_ROOT?.trim()
  const appBundle = resolve(executable, '..', '..', '..')
  if (!root || !isAbsolute(root) || !appBundle.endsWith('.app')) {
    return { command: executable, args: [...args] }
  }
  return {
    command: '/usr/bin/open',
    // macOS can abort when Electron is directly exec'd from a packaged app.
    // Waiting for this single-use helper keeps the parent socket alive until
    // Safe Storage returns, without exposing any credential on the command line.
    args: ['-n', '-W', appBundle, '--args', ...args, `--workwise-candidate-env-file=${join(resolve(root), 'candidate.env')}`]
  }
}

function spawnCredentialHelper(socketPath: string, socketRoot: string, interactive: boolean): ChildProcess {
  const { env, executable } = credentialHelperProcessConfig()
  const userData = helperRoot(env)
  if (env.WORKWISE_CANDIDATE === '1') env.WORKWISE_CANDIDATE_USER_DATA = userData
  const args = helperArgs(socketPath, socketRoot, interactive, userData)
  const launch = credentialHelperLaunch(env, executable, args)
  const child = spawn(launch.command, launch.args, {
    env,
    stdio: 'ignore',
    detached: process.platform !== 'win32'
  })
  activeCredentialHelperProcesses.add(child)
  child.once('exit', () => activeCredentialHelperProcesses.delete(child))
  child.once('error', () => activeCredentialHelperProcesses.delete(child))
  return child
}

export function credentialHelperReadyPid(value: unknown): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const message = value as Partial<CredentialHelperReady>
  return message.type === 'ready' && Number.isSafeInteger(message.pid) && Number(message.pid) > 1
    ? Number(message.pid)
    : undefined
}

export function killCredentialHelperPid(
  pid: number | undefined,
  killProcess: typeof process.kill = process.kill
): void {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 1) return
  try {
    killProcess(Number(pid), 'SIGKILL')
  } catch {
    // The single-use helper may already have exited after sending its result.
  }
}

function encodeMessage(value: CredentialHelperMessage): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

function decodeMessage<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as T
}

export function killCredentialHelperProcessTree(
  child: Pick<ChildProcess, 'exitCode' | 'signalCode' | 'pid' | 'kill'> | undefined,
  platform: NodeJS.Platform = process.platform,
  killProcessGroup: typeof process.kill = process.kill
): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (platform !== 'win32' && child.pid) {
    try {
      killProcessGroup(-child.pid, 'SIGKILL')
      return
    } catch {
      // Fall back to killing the direct helper when the process group is gone.
    }
  }
  child.kill(platform === 'win32' ? undefined : 'SIGKILL')
}

export function stopCredentialHelperProcesses(): void {
  for (const child of activeCredentialHelperProcesses) {
    killCredentialHelperProcessTree(child)
  }
  activeCredentialHelperProcesses.clear()
}

export function credentialHelperTimeoutMs(interactive: boolean): number {
  return interactive ? IM_CREDENTIAL_HELPER_INTERACTIVE_TIMEOUT_MS : IM_CREDENTIAL_HELPER_TIMEOUT_MS
}

export function createCredentialHelperWatchdog(
  exitProcess: (code: number) => void = (code) => process.exit(code),
  interactive = isInteractiveImCredentialHelperProcess()
): ReturnType<typeof setTimeout> {
  const watchdog = setTimeout(
    () => exitProcess(1),
    credentialHelperTimeoutMs(interactive) - 1_000
  )
  watchdog.unref?.()
  return watchdog
}

async function requestCredentialHelper(request: CredentialHelperRequest): Promise<string> {
  const interactive = request.interactive === true
  const socketRoot = helperSocketRoot()
  await mkdir(helperRoot(), { recursive: true, mode: 0o700 })
  await mkdir(socketRoot, { recursive: true, mode: 0o700 })
  const socketPath = join(socketRoot, `ch-${randomBytes(8).toString('hex')}.sock`)
  await rm(socketPath, { force: true })

  return new Promise((resolveRequest, rejectRequest) => {
    let child: ChildProcess | undefined
    let helperProcessPid: number | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let responseSocket: Socket | undefined
    const server: Server = createServer((socket) => {
      responseSocket = socket
      let response = ''
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8')
        if (Buffer.byteLength(response) > MAX_HELPER_MESSAGE_BYTES) {
          finish(credentialHelperError(
            'credential_helper_protocol',
            'IM credential helper response exceeded its limit.'
          ))
          return
        }
        while (true) {
          const newline = response.indexOf('\n')
          if (newline < 0) return
          const encoded = response.slice(0, newline)
          response = response.slice(newline + 1)
          try {
            const parsed = decodeMessage<CredentialHelperResponse | CredentialHelperReady>(encoded)
            const readyPid = credentialHelperReadyPid(parsed)
            if (readyPid) {
              helperProcessPid = readyPid
              continue
            }
            if (!('ok' in parsed) || !parsed.ok || typeof parsed.value !== 'string') {
              finish(credentialHelperError(
                'credential_helper_access_denied',
                'IM credential helper could not access protected storage.'
              ))
              return
            }
            finish(undefined, parsed.value)
            return
          } catch {
            finish(credentialHelperError(
              'credential_helper_protocol',
              'IM credential helper returned an invalid result.'
            ))
            return
          }
        }
      })
      socket.once('error', () => finish(credentialHelperError(
        'credential_helper_socket',
        'IM credential helper socket failed.'
      )))
      socket.write(`${encodeMessage({ operation: request.operation, value: request.value })}\n`)
    })

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      responseSocket?.destroy()
      try {
        server.close()
      } catch {
        // The server may fail before it starts listening.
      }
      void rm(socketPath, { force: true })
    }
    const finish = (error?: Error, value?: string): void => {
      if (settled) return
      settled = true
      // A helper is single-use. Reap its detached process group even after a
      // successful response because older stable Safe Storage helpers may not
      // honor app.exit() promptly on macOS.
      killCredentialHelperProcessTree(child)
      killCredentialHelperPid(helperProcessPid)
      if (child) activeCredentialHelperProcesses.delete(child)
      cleanup()
      if (error) rejectRequest(error)
      else resolveRequest(value ?? '')
    }

    server.once('error', () => finish(credentialHelperError(
      'credential_helper_socket',
      'IM credential helper socket could not start.'
    )))
    server.listen(socketPath, () => {
      child = spawnCredentialHelper(socketPath, socketRoot, interactive)
      child.once('error', () => finish(credentialHelperError(
        'credential_helper_start_failed',
        'IM credential helper failed to start.'
      )))
      child.once('exit', () => {
        if (!settled) finish(credentialHelperError(
          'credential_helper_start_failed',
          'IM credential helper exited without a result.'
        ))
      })
      timer = setTimeout(
        () => finish(credentialHelperError(
          'credential_helper_timeout',
          'IM credential helper timed out.'
        )),
        credentialHelperTimeoutMs(interactive)
      )
    })
  })
}

export function createCredentialHelperRequestScheduler(
  runRequest: (request: CredentialHelperRequest) => Promise<string>
): (request: CredentialHelperRequest) => Promise<string> {
  let queueTail = Promise.resolve()
  const inFlight = new Map<string, Promise<string>>()

  return (request) => {
    const key = createHash('sha256')
      .update(request.operation)
      .update(request.interactive === true ? ':interactive' : ':background')
      .update('\0')
      .update(request.value)
      .digest('hex')
    const existing = inFlight.get(key)
    if (existing) return existing

    const scheduled = queueTail
      .catch(() => undefined)
      .then(() => runRequest(request))
    queueTail = scheduled.then(() => undefined, () => undefined)
    inFlight.set(key, scheduled)
    void scheduled.finally(() => {
      if (inFlight.get(key) === scheduled) inFlight.delete(key)
    }).catch(() => undefined)
    return scheduled
  }
}

const scheduleCredentialHelperRequest = createCredentialHelperRequestScheduler(requestCredentialHelper)

export async function encryptStringWithCredentialHelper(
  value: string,
  options?: { interactive?: boolean }
): Promise<Buffer> {
  const interactive = options?.interactive ?? consumeInteractiveCredentialHelperAccess()
  if (!isCandidateCredentialAccessAllowed()) {
    throw Object.assign(new Error('Candidate protected storage access is disabled.'), {
      code: 'credential_helper_access_denied'
    })
  }
  const encrypted = await scheduleCredentialHelperRequest({
    operation: 'encrypt',
    value: Buffer.from(value, 'utf8').toString('base64'),
    interactive
  })
  return Buffer.from(encrypted, 'base64')
}

export async function decryptStringWithCredentialHelper(
  value: Buffer,
  options?: { interactive?: boolean }
): Promise<string> {
  const interactive = options?.interactive ?? consumeInteractiveCredentialHelperAccess()
  if (!isCandidateCredentialAccessAllowed()) {
    throw Object.assign(new Error('Candidate protected storage access is disabled.'), {
      code: 'credential_helper_access_denied'
    })
  }
  const decrypted = await scheduleCredentialHelperRequest({
    operation: 'decrypt',
    value: value.toString('base64'),
    interactive
  })
  return Buffer.from(decrypted, 'base64').toString('utf8')
}

function helperSocketPath(argv: readonly string[] = process.argv): string {
  const raw = argv.find((arg) => arg.startsWith(HELPER_SOCKET_ARG))?.slice(HELPER_SOCKET_ARG.length) ?? ''
  const rawRoot = argv.find((arg) => arg.startsWith(HELPER_SOCKET_ROOT_ARG))
    ?.slice(HELPER_SOCKET_ROOT_ARG.length) ?? ''
  if (!raw || !isAbsolute(raw)) throw new Error('IM credential helper socket path is invalid.')
  if (!rawRoot || !isAbsolute(rawRoot)) throw new Error('IM credential helper socket root is invalid.')
  const allowedBase = resolve(imCredentialHelperSocketBase())
  const root = resolve(rawRoot)
  const rootRel = relative(allowedBase, root)
  if (
    rootRel === '..' ||
    rootRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rootRel) ||
    !/^workwise-im-\d+-[0-9a-f]{12}$/.test(rootRel)
  ) {
    throw new Error('IM credential helper socket root is not trusted.')
  }
  const target = resolve(raw)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('IM credential helper socket must remain inside its private root.')
  }
  return target
}

function readSocketRequest(socket: Socket): Promise<CredentialHelperRequest> {
  return new Promise((resolveRequest, rejectRequest) => {
    let input = ''
    socket.on('data', (chunk: Buffer) => {
      input += chunk.toString('utf8')
      if (Buffer.byteLength(input) > MAX_HELPER_MESSAGE_BYTES) {
        rejectRequest(new Error('IM credential helper request exceeded its limit.'))
        return
      }
      const newline = input.indexOf('\n')
      if (newline < 0) return
      try {
        const request = decodeMessage<CredentialHelperRequest>(input.slice(0, newline))
        if ((request.operation !== 'encrypt' && request.operation !== 'decrypt') || typeof request.value !== 'string') {
          rejectRequest(new Error('IM credential helper request is invalid.'))
          return
        }
        resolveRequest(request)
      } catch {
        rejectRequest(new Error('IM credential helper request is invalid.'))
      }
    })
    socket.once('error', () => rejectRequest(new Error('IM credential helper socket failed.')))
  })
}

function writeSocketResponse(socket: Socket, response: CredentialHelperResponse): Promise<void> {
  return new Promise((resolveResponse) => {
    socket.end(`${encodeMessage(response)}\n`, () => resolveResponse())
  })
}

export async function runImCredentialHelperProcess(): Promise<void> {
  let socket: Socket | undefined
  const watchdog = createCredentialHelperWatchdog()
  try {
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('disable-software-rasterizer')
    socket = createConnection(helperSocketPath())
    socket.write(`${encodeMessage({ type: 'ready', pid: process.pid })}\n`)
    const requestPromise = readSocketRequest(socket)
    await app.whenReady()
    if (isInteractiveImCredentialHelperProcess()) {
      app.dock?.show()
      app.focus({ steal: true })
    }
    const request = await requestPromise
    if (!isCandidateCredentialAccessAllowed()) throw new Error('Candidate protected storage access is disabled.')
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Protected storage unavailable.')
    const value = request.operation === 'encrypt'
      ? (await safeStorage.encryptStringAsync(
          Buffer.from(request.value, 'base64').toString('utf8')
        )).toString('base64')
      : Buffer.from(
          (await safeStorage.decryptStringAsync(Buffer.from(request.value, 'base64'))).result,
          'utf8'
        ).toString('base64')
    await writeSocketResponse(socket, { ok: true, value })
    app.exit(0)
  } catch {
    if (socket) await writeSocketResponse(socket, { ok: false }).catch(() => undefined)
    app.exit(1)
  } finally {
    clearTimeout(watchdog)
  }
}
