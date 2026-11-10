import { describe, expect, it, vi } from 'vitest'
import { LarkCapabilityConfig } from '../contracts/capabilities.js'
import { createThreadRecord } from '../domain/thread.js'
import { CapabilityRegistry } from '../adapters/tool/capability-registry.js'
import { buildLarkCliToolProvider } from '../adapters/tool/lark-cli-tool-provider.js'
import { LocalToolHost } from '../adapters/tool/local-tool-host.js'
import { ManagedLarkRuntime } from './managed-lark-runtime.js'
import { contextualExternalTaskPreflight, externalPreflightThreadContext } from './contextual-external-task-preflight.js'
import { larkTestBinding } from '../../tests/helpers/lark-identity.js'

const scopes = ['task:task:read', 'task:task:write']
const config = LarkCapabilityConfig.parse({ enabled: true, authState: 'installed', executablePath: '/managed/lark-cli', ...larkTestBinding, scopes })
function fixture() {
  const runner = vi.fn()
  const registry = new CapabilityRegistry([buildLarkCliToolProvider(config, runner)!])
  const toolHost = new LocalToolHost({ registry })
  const workspaceTrust = { get: vi.fn(async (workspace: string) => ({ canonicalRoot: workspace, level: 'read-only' as const, revision: 0 })) }
  const runtime = new ManagedLarkRuntime(config)
  const preflight = contextualExternalTaskPreflight({ providerPreflight: text => runtime.preflight(text), workspaceTrust, toolHost })
  const thread = createThreadRecord({ id: 'thread', title: 'fixture', workspace: '/workspace', model: 'fixture', sandboxMode: 'workspace-write' })
  return { preflight, thread, runner, registry, workspaceTrust }
}

describe('external task preflight uses trusted execution context', () => {
  it('includes a request restriction without allowing it to elevate persisted authority', () => {
    const f = fixture()
    expect(externalPreflightThreadContext(f.thread, { approvalPolicy: 'never', sandboxMode: 'read-only' })).toMatchObject({ approvalPolicy: 'never', sandboxMode: 'read-only' })
    expect(externalPreflightThreadContext({ ...f.thread, approvalPolicy: 'never', sandboxMode: 'read-only' }, { approvalPolicy: 'auto', sandboxMode: 'danger-full-access', mode: 'agent' })).toMatchObject({ approvalPolicy: 'never', sandboxMode: 'read-only', mode: 'agent' })
  })
  it('allows pure remote reads with no selected workspace and performs no connector operation', async () => {
    const f = fixture()
    expect(await f.preflight('查看飞书待办列表', { ...f.thread, workspace: '' })).toMatchObject({ status: 'available', workspaceState: 'allowed', sandboxState: 'allowed', executionContext: {
      workspaceRoot: '', workspaceTrust: 'read-only', agentTrust: 'full-access', sandboxMode: 'read-only', approvalPolicy: 'auto', availableTools: expect.arrayContaining(['lark_task_list'])
    } })
    expect(f.workspaceTrust.get).toHaveBeenCalledWith('')
    expect(f.runner).not.toHaveBeenCalled()
  })

  it('uses actual tool policy rather than treating a read-only filesystem as a remote write ban', async () => {
    const f = fixture()
    expect(await f.preflight('处理飞书待办', f.thread)).toMatchObject({ status: 'available', sandboxState: 'allowed', approvalState: 'required' })
    expect(f.runner).not.toHaveBeenCalled()
  })

  it('returns a denied permission card before a never-policy task can allocate a Turn', async () => {
    const f = fixture()
    expect(await f.preflight('完成飞书待办', { ...f.thread, approvalPolicy: 'never' })).toMatchObject({ status: 'blocked', errorCode: 'approval_policy_blocked', approvalState: 'denied', resolution: { kind: 'grant' } })
    expect(f.runner).not.toHaveBeenCalled()
  })

  it('checks the Agent tool list, including the tools needed to review a finite write scope', async () => {
    const f = fixture()
    const thread = { ...f.thread, agentProfile: { id: 'reader', name: 'Reader', role: 'reader', color: 'blue', systemPrompt: 'Read only.',
      toolAllowlist: ['lark_task_list', 'lark_task_complete'], mcpAllowlist: [], trustLevel: 'workspace-write' as const,
      budget: { maxAttempts: 1, maxDurationMs: 1000 }, revision: 1 } }
    expect(await f.preflight('处理飞书待办', thread)).toMatchObject({ status: 'blocked', errorCode: 'agent_tool_blocked', workspaceState: 'allowed', resolution: { kind: 'grant' } })
    expect(await f.preflight('查看飞书待办列表', thread)).toMatchObject({ status: 'available' })
  })

  it('does not advertise a configured provider when its actual Runtime tools are absent', async () => {
    const f = fixture()
    f.registry.replaceProvider('lark-cli', undefined)
    expect(await f.preflight('查看飞书待办列表', f.thread)).toMatchObject({ status: 'blocked', errorCode: 'connector_tool_unavailable', resolution: { kind: 'retry' } })
  })

  it('reports plan-mode filtering without asking for irrelevant connector login', async () => {
    const f = fixture()
    expect(await f.preflight('查看飞书待办列表', { ...f.thread, mode: 'plan' })).toMatchObject({ status: 'blocked', errorCode: 'task_mode_blocked', credentialState: 'valid', resolution: { kind: 'grant' } })
  })

  it('converts unreadable workspace authority to a durable pre-Turn permission block', async () => {
    const f = fixture()
    f.workspaceTrust.get.mockRejectedValueOnce(Object.assign(new Error('Invalid manifest'), { code: 'workspace_trust_unavailable' }))
    expect(await f.preflight('查看飞书待办列表', f.thread)).toMatchObject({ status: 'blocked', errorCode: 'workspace_trust_unavailable', workspaceState: 'blocked', resolution: { kind: 'grant' } })
    expect(f.runner).not.toHaveBeenCalled()
  })
})
