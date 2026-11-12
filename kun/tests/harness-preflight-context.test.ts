import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { larkTestBinding } from './helpers/lark-identity.js'
import { FileWorkspaceTrustReader } from '../src/services/workspace-trust-reader.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanup.length) await cleanup.pop()!() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'railwise-preflight-context-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const runtime = await createKunServeRuntime({
    host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), runtimeToken: 'fixture',
    baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', endpointFormat: 'chat_completions',
    model: 'fixture', approvalPolicy: 'auto', sandboxMode: 'workspace-write', tokenEconomyMode: false,
    insecure: false, storage: { backend: 'file' },
    capabilities: KunCapabilitiesConfig.parse({ lark: { enabled: true, authState: 'installed', executablePath: '/usr/bin/true', ...larkTestBinding, scopes: ['task:task:read', 'task:task:write'] } })
  })
  cleanup.push(async () => runtime.shutdown?.())
  const origin = await runtime.threadService.create({ workspace: root, model: 'fixture', mode: 'agent' })
  return { root, runtime, origin }
}

describe('production preflight authority before Turn allocation', () => {
  it('persists a never-policy block and rechecks the execution thread on resume', async () => {
    const f = await fixture()
    await f.runtime.threadService.update(f.origin.id, { approvalPolicy: 'never' })
    const result = await f.runtime.taskCoordinator!.command({ threadId: f.origin.id, idempotencyKey: 'new', request: { prompt: '完成飞书待办' } })
    expect(result).toMatchObject({ kind: 'capability_required', capability: { status: 'blocked', approvalState: 'denied', errorCode: 'approval_policy_blocked' }, task: { status: 'waiting_user', attempts: 0 } })
    if (result.kind !== 'capability_required' || !result.task) throw new Error('expected waiting task')
    expect(result.task.activeTurnId).toBeUndefined()
    expect((await f.runtime.threadService.get(result.task.threadId))?.turns).toEqual([])
    await f.runtime.threadService.update(f.origin.id, { approvalPolicy: 'auto' })
    const resumed = await f.runtime.taskCoordinator!.command({ threadId: f.origin.id, taskId: result.task.id, intent: 'resume', idempotencyKey: 'resume', request: { prompt: '继续' } })
    expect(resumed).toMatchObject({ kind: 'capability_required', capability: { errorCode: 'approval_policy_blocked' } })
    expect((await f.runtime.threadService.get(result.task.threadId))?.turns).toEqual([])
  })

  it('refuses an external task outside the selected Agent tool scope', async () => {
    const f = await fixture()
    await f.runtime.threadService.setAgent(f.origin.id, { agentId: 'writer', expectedRevision: f.origin.agentRevision, idempotencyKey: 'select-writer', profile: {
      id: 'writer', name: 'Writer', role: 'writer', color: 'blue', systemPrompt: 'Use local documents.',
      toolAllowlist: ['read', 'write'], mcpAllowlist: [], trustLevel: 'workspace-write', budget: { maxAttempts: 1, maxDurationMs: 1000 }, revision: 1
    } })
    const result = await f.runtime.taskCoordinator!.command({ threadId: f.origin.id, idempotencyKey: 'scope', request: { prompt: '查看飞书待办列表' } })
    expect(result).toMatchObject({ kind: 'capability_required', capability: { errorCode: 'agent_tool_blocked' }, task: { status: 'waiting_user' } })
    if (result.kind !== 'capability_required' || !result.task) throw new Error('expected waiting task')
    expect((await f.runtime.threadService.get(result.task.threadId))?.turns).toEqual([])
  })

  it('does not create a Turn when the persisted workspace authority cannot be read', async () => {
    const f = await fixture()
    vi.spyOn(FileWorkspaceTrustReader.prototype, 'get').mockRejectedValueOnce(new Error('Invalid trust manifest'))
    const startTurn = vi.spyOn(f.runtime.turnService, 'startTurn')
    const result = await f.runtime.taskCoordinator!.command({ threadId: f.origin.id, idempotencyKey: 'bad-manifest', request: { prompt: '查看飞书待办列表' } })
    expect(result).toMatchObject({ kind: 'capability_required', capability: { errorCode: 'workspace_trust_unavailable', workspaceState: 'blocked' }, task: { status: 'waiting_user' } })
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('checks a requested never policy before persisting that Turn', async () => {
    const f = await fixture()
    const startTurn = vi.spyOn(f.runtime.turnService, 'startTurn')
    const result = await f.runtime.taskCoordinator!.command({ threadId: f.origin.id, idempotencyKey: 'requested-never', request: { prompt: '完成飞书待办', approvalPolicy: 'never' } })
    expect(result).toMatchObject({ kind: 'capability_required', capability: { approvalState: 'denied', errorCode: 'approval_policy_blocked' } })
    expect(startTurn).not.toHaveBeenCalled()
  })
})
