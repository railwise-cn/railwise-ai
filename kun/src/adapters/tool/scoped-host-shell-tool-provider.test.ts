import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryThreadStore } from '../in-memory-thread-store.js'
import { InMemorySessionStore } from '../in-memory-session-store.js'
import { PersistentApprovalGate } from '../persistent-human-gates.js'
import { createThreadRecord } from '../../domain/thread.js'
import { TaskController } from '../../services/task-controller.js'
import { TaskRunRepository } from '../../services/task-run-repository.js'
import { ExecutionGrantSchema } from '../../contracts/permissions.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { CapabilityRegistry } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import { createBashLocalTool, stopAllBashSessions } from './builtin-bash-tool.js'
import { buildScopedHostShellToolProviders } from './scoped-host-shell-tool-provider.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { await stopAllBashSessions('test_cleanup'); for (const close of cleanup.splice(0)) await close() })

async function fixture(prompt = '在工作区运行一次本地检查命令。') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-scoped-shell-')))
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
  cleanup.push(async () => { repository.close(); await rm(root, { recursive: true, force: true }) })
  const threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: 'thread', title: 'scoped shell fixture', workspace: root, model: 'fixture' })
  await threadStore.upsert(thread)
  let now = '2026-11-10T00:00:00.000Z'
  const nowIso = () => now
  const tasks = new TaskController({ repository, threadStore, sessionStore, nowIso })
  const task = tasks.ensureTask({ thread, turnId: 'turn', request: { prompt } })
  tasks.beginAttempt(thread.id, 'turn')
  const gate = new PersistentApprovalGate(repository, nowIso), abort = new AbortController()
  const bashTool = createBashLocalTool({ sessionOutputRoot: join(root, 'shell-output'), sessionLifecycle: {
    onStarted(input) {
      const token = tasks.tokenForTurn('turn')!
      repository.createShellSession({ id: input.sessionId, taskId: task.id, nodeId: task.nodes[0]!.id, workspaceRoot: root, commandSummary: input.commandSummary,
        cwd: input.cwd, status: 'running', outputPath: input.outputPath, outputBytes: 0, createdAt: input.startedAt, startedAt: input.startedAt, revision: 0,
        pid: input.pid, processFingerprint: input.processFingerprint, processGroup: input.processGroup, ownerId: token.ownerId, executionId: token.executionId })
    },
    onFinished(input) {
      const session = repository.getShellSession(input.sessionId)
      if (session) repository.updateShellSession(input.sessionId, session.revision, current => ({ ...current, status: input.status, finishedAt: input.finishedAt, exitCode: input.exitCode }))
    }
  } })
  const execute = vi.spyOn(bashTool, 'execute'), onAuthorized = vi.fn(async () => {})
  const providers = buildScopedHostShellToolProviders({ repository, tasks, bashTool, nowIso, onAuthorized })
  const host = new LocalToolHost({ registry: new CapabilityRegistry([{ id: 'builtin', kind: 'built-in', enabled: true, available: true, tools: [bashTool] }, ...providers]) })
  const context: ToolHostContext = { threadId: 'thread', turnId: 'turn', workspace: root, approvalPolicy: 'auto', sandboxMode: 'workspace-write', abortSignal: abort.signal,
    assertExecution: () => tasks.assertToken(tasks.tokenForTurn('turn')!), awaitApproval: approval => gate.request(approval),
    executionGrant: ExecutionGrantSchema.parse({ id: 'grant', taskId: task.id, threadId: 'thread', turnId: 'turn', workspaceRoot: root,
      workspaceTrust: 'workspace-write', agentTrust: 'workspace-write', approvalPolicy: 'auto', sandboxMode: 'workspace-write',
      revision: 0, workspaceRevision: 0, agentRevision: 0, idempotencyKey: 'grant', issuedAt: nowIso() }) }
  const command = `"${process.execPath.replaceAll('"', '\\"')}" -e "process.stdout.write('approved-once')"`
  const args = { command, idempotency_key: 'one-command', ttl_seconds: 60, timeout_seconds: 10 }
  const run = async (callId: string, raw = args, decision: 'allow' | 'deny' = 'allow', activeContext = context) => {
    const pending = host.execute({ callId, toolName: 'request_host_shell', arguments: raw }, activeContext)
    await vi.waitFor(() => expect(gate.pending()).toHaveLength(1))
    gate.decide(gate.pending()[0]!.id, decision)
    return pending
  }
  return { root, repository, tasks, task, gate, abort, bashTool, execute, onAuthorized, providers, host, context, args, run, advance: (seconds: number) => { now = new Date(Date.parse(now) + seconds * 1000).toISOString() } }
}

describe('one-shot, explicitly reviewed host shell', () => {
  it('keeps ordinary Bash hidden and dispatches exactly one real command after persisted approval', async () => {
    const f = await fixture()
    expect((await f.host.listTools(f.context)).map(tool => tool.name)).toEqual(['request_host_shell', 'host_shell_session'])
    const pending = f.host.execute({ callId: 'one', toolName: 'request_host_shell', arguments: f.args }, f.context)
    await vi.waitFor(() => expect(f.gate.pending()).toHaveLength(1))
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.gate.pending()[0]!.summary).toContain('Full host access for this exact command only')
    expect(f.gate.pending()[0]!.summary).toContain(`Workspace (JSON): ${JSON.stringify(f.root)}`)
    expect(f.gate.pending()[0]!.summary).toContain('Lifetime seconds: 60')
    f.gate.decide(f.gate.pending()[0]!.id, 'allow')
    const result = await pending
    expect(result).toMatchObject({ approved: true, item: { isError: false, output: { output: 'approved-once', status: 'completed', exit_code: 0 } } })
    expect(f.execute).toHaveBeenCalledOnce()
    expect(f.onAuthorized).toHaveBeenCalledOnce()
    expect(f.context.executionGrant).toMatchObject({ workspaceTrust: 'workspace-write', sandboxMode: 'workspace-write', revision: 0 })
    expect(f.repository.operations(f.task.id, 'host_shell')).toMatchObject([{ status: 'succeeded', request: { workspaceRoot: f.root }, result: { authorization: { executionGrantId: 'grant', leaseRevision: f.tasks.tokenForTurn('turn')!.leaseRevision } } }])
    const repeated = await f.run('repeat')
    expect(repeated.item).toMatchObject({ output: { output: 'approved-once' } })
    expect(f.execute).toHaveBeenCalledOnce()
    const conflicting = await f.run('conflict', { ...f.args, command: `${f.args.command} ` })
    expect(conflicting.item).toMatchObject({ isError: true, output: { code: 'idempotency_conflict' } })
    expect(f.execute).toHaveBeenCalledOnce()
  })

  it('rejects denial, fake approval, changed arguments and revoked grants before any side effect', async () => {
    const f = await fixture(), tool = f.providers[0]!.tools[0]!
    await expect(tool.execute(f.args, { ...f.context, explicitApproval: { callId: 'fake', toolName: 'request_host_shell', requestHash: '0'.repeat(64) } })).rejects.toMatchObject({ code: 'host_shell_approval_required' })
    expect((await f.run('deny', f.args, 'deny')).approved).toBe(false)
    const changing = { ...f.args }
    const pending = f.host.execute({ callId: 'changed', toolName: 'request_host_shell', arguments: changing }, f.context)
    await vi.waitFor(() => expect(f.gate.pending()).toHaveLength(1))
    changing.command += ' '
    f.gate.decide(f.gate.pending()[0]!.id, 'allow')
    await expect(pending).resolves.toMatchObject({ item: { isError: true, output: { code: 'approval_request_changed' } } })
    const revokedContext = { ...f.context, validateExecutionGrant: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('revoked')) }
    const revoked = await f.run('revoked', f.args, 'allow', revokedContext)
    expect(revoked.item).toMatchObject({ isError: true })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.repository.operations(f.task.id, 'host_shell')).toHaveLength(0)
  })

  it('blocks connector proxy commands and never advertises elevation for external tasks', async () => {
    const f = await fixture()
    for (const command of ['dws todo list', 'lark-cli task list', 'curl https://open.larksuite.com/api', 'curl https://oapi.dingtalk.com']) {
      const result = await f.run(`proxy-${command.length}`, { ...f.args, command })
      expect(result.item).toMatchObject({ isError: true, output: { code: 'host_shell_connector_proxy_blocked' } })
    }
    expect(f.execute).not.toHaveBeenCalled()
    const external = await fixture('帮我处理钉钉待办。')
    expect((await external.host.listTools(external.context)).map(tool => tool.name)).not.toContain('request_host_shell')
    await expect(external.providers[0]!.tools[0]!.execute(external.args, external.context)).rejects.toMatchObject({ code: 'host_shell_scope_blocked' })
  })

  it('does not replay unknown results and rejects new scope after lease changes', async () => {
    const f = await fixture()
    f.execute.mockRejectedValue(new Error('lost after spawn'))
    const result = await f.run('unknown')
    expect(result.item).toMatchObject({ isError: true, output: { status: 'outcome_unknown' } })
    expect(f.repository.operations(f.task.id, 'host_shell')).toMatchObject([{ status: 'outcome_unknown' }])
    expect((await f.run('unknown-repeat')).item).toMatchObject({ isError: true, output: { status: 'outcome_unknown' } })
    expect(f.execute).toHaveBeenCalledOnce()
    f.tasks.endRun('turn')
    const direct = f.providers[0]!.tools[0]!
    await expect(direct.execute({ ...f.args, idempotency_key: 'stale' }, f.context)).rejects.toMatchObject({ code: 'host_shell_scope_blocked' })
  })

  it('expires a persisted approval before dispatch instead of accepting a delayed replay', async () => {
    const f = await fixture()
    const context = { ...f.context, awaitApproval: async (approval: Parameters<typeof f.context.awaitApproval>[0]) => {
      const result = f.gate.request(approval)
      f.gate.decide(approval.id, 'allow')
      f.advance(6)
      return result
    } }
    const expired = await f.host.execute({ callId: 'expired', toolName: 'request_host_shell', arguments: { ...f.args, ttl_seconds: 5, timeout_seconds: 1 } }, context)
    expect(expired.item).toMatchObject({ isError: true, output: { code: 'host_shell_authorization_expired' } })
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.repository.operations(f.task.id, 'host_shell')).toHaveLength(0)
  })

  it('returns a real bound session and allows poll/stop but never stdin writes or another task grant', async () => {
    const f = await fixture()
    const command = `"${process.execPath.replaceAll('"', '\\"')}" -e "process.stdout.write('started');setTimeout(()=>{},9000)"`
    const started = await f.run('session', { ...f.args, command })
    expect(started.item).toMatchObject({ output: { status: 'running', session_id: expect.any(String), authorizationId: expect.any(String) } })
    const output = (started.item as { output: Record<string, unknown> }).output
    const sessionArgs = { authorization_id: output.authorizationId, action: 'poll', yield_seconds: 1 }
    const polled = await f.host.execute({ callId: 'poll', toolName: 'host_shell_session', arguments: sessionArgs }, f.context)
    expect(polled.item).toMatchObject({ output: { output: 'started', status: 'running' } })
    const laterGrant = { ...f.context, executionGrant: { ...f.context.executionGrant!, id: 'later-readback-grant' } }
    const laterPoll = await f.host.execute({ callId: 'later-poll', toolName: 'host_shell_session', arguments: sessionArgs }, laterGrant)
    expect(laterPoll.item).toMatchObject({ output: { output: 'started', status: 'running' } })
    const laterStop = await f.host.execute({ callId: 'later-stop', toolName: 'host_shell_session', arguments: { ...sessionArgs, action: 'stop' } }, laterGrant)
    expect(laterStop.item).toMatchObject({ isError: true, output: { code: 'host_shell_scope_blocked' } })
    const write = await f.host.execute({ callId: 'write', toolName: 'host_shell_session', arguments: { ...sessionArgs, action: 'write', input: 'other command' } }, f.context)
    expect(write.item).toMatchObject({ isError: true })
    const changedGrant = await f.host.execute({ callId: 'changed-grant', toolName: 'host_shell_session', arguments: sessionArgs }, { ...f.context, executionGrant: { ...f.context.executionGrant!, agentRevision: 1 } })
    expect(changedGrant.item).toMatchObject({ isError: true, output: { code: 'host_shell_scope_blocked' } })
    const stopped = await f.host.execute({ callId: 'stop', toolName: 'host_shell_session', arguments: { ...sessionArgs, action: 'stop' } }, f.context)
    expect(stopped.item).toMatchObject({ output: { status: 'stopped', stop_sent: true } })
    expect(f.gate.pending()).toHaveLength(0)
  })
})
