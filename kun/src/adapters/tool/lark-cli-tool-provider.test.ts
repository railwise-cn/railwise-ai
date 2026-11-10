import { describe, expect, it, vi } from 'vitest'
import { LarkCapabilityConfig } from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { LocalToolHost } from './local-tool-host.js'
import { buildLarkCliToolProvider, _larkCliToolProviderInternals } from './lark-cli-tool-provider.js'

const scopes = ['task:task:read', 'task:task:write', 'approval:task:read', 'approval:instance:read', 'approval:task:write']
const config = () => LarkCapabilityConfig.parse({ enabled: true, authState: 'installed', executablePath: '/managed/lark-cli', brand: 'feishu', scopes })
const context = (awaitApproval: ToolHostContext['awaitApproval'] = vi.fn(async () => 'allow' as const)): ToolHostContext => ({ threadId: 'thread', turnId: 'turn', workspace: '/workspace', approvalPolicy: 'auto', sandboxMode: 'workspace-write', abortSignal: new AbortController().signal, awaitApproval })

describe('verified typed Lark CLI provider', () => {
  it('requires diagnosed user identity, brand, and actual scopes', () => {
    expect(buildLarkCliToolProvider(LarkCapabilityConfig.parse({ enabled: true, authState: 'needs_login' }))).toBeUndefined()
    expect(buildLarkCliToolProvider(LarkCapabilityConfig.parse({ enabled: true, authState: 'installed', executablePath: '/managed/cli' }))).toBeUndefined()
    const readOnly = buildLarkCliToolProvider({ ...config(), scopes: ['approval:task:read'] })!
    expect(readOnly.tools.map(tool => tool.name)).toEqual(['lark_approval_list'])
  })

  it('maps validated task reads without shell interpolation and normalizes successful evidence', async () => {
    const runner = vi.fn(async (_path: string, _args: string[], _signal: AbortSignal) => ({ ok: true, output: { code: 0, data: { items: [] } } }))
    const provider = buildLarkCliToolProvider(config(), runner)!
    const tool = provider.tools.find(tool => tool.name === 'lark_task_list')!
    const result = await tool.execute({ query: '$(touch /tmp/not-run)' }, context())
    expect(runner.mock.calls[0]?.[1]).toEqual(['task', '+get-my-tasks', '--complete=false', '--query', '$(touch /tmp/not-run)', '--format', 'json', '--as', 'user'])
    expect(result).toMatchObject({ output: { status: 'succeeded', evidence: { provider: 'lark', operation: 'list', verified: true } } })
    await expect(provider.tools.find(tool => tool.name === 'lark_task_get')!.execute({ taskId: '' }, context())).rejects.toThrow()
  })

  it('always requests explicit confirmation for writes even under runtime auto policy', async () => {
    const runner = vi.fn(async (_path: string, _args: string[], _signal: AbortSignal) => ({ ok: true, output: { code: 0, data: { guid: 'guid-1', status: 'done', completed_at: '100' } } }))
    const provider = buildLarkCliToolProvider(config(), runner)!
    const approval = vi.fn(async () => 'deny' as const)
    const host = new LocalToolHost({ tools: [...provider.tools] })
    await host.execute({ callId: 'c1', toolName: 'lark_task_complete', arguments: { taskId: 'guid-1' } }, context(approval))
    expect(approval).toHaveBeenCalledOnce()
    expect(runner).not.toHaveBeenCalled()
  })

  it('checks the exact approval task state after mutation and produces target-bound evidence', async () => {
    const runner = vi.fn(async (_path: string, args: string[], _signal: AbortSignal) => ({ ok: true, output: args.includes('approve') ? { code: 0, request_id: 'trace-1', data: {} } : { code: 0, data: { instance_code: 'ic-1', tasks: [{ id: 'task-1', status: 'APPROVED' }] } } }))
    const tool = buildLarkCliToolProvider(config(), runner)!.tools.find(tool => tool.name === 'lark_approval_approve')!
    const result = await tool.execute({ instanceCode: 'ic-1', taskId: 'task-1', comment: '同意' }, context())
    expect(runner.mock.calls.map(call => call[1].slice(0, 3))).toEqual([['approval', 'tasks', 'approve'], ['approval', 'instances', 'get']])
    expect(result).toMatchObject({ output: { status: 'succeeded', evidence: { operation: 'approve', target: 'task-1', status: 'APPROVED', verified: true } } })
    expect(result).not.toHaveProperty('output.evidence.remoteOperationId')
    expect(result.output).toHaveProperty('evidence.resultHash')
  })

  it('does not mistake another task or transport success for a verified mutation', async () => {
    const runner = vi.fn(async (_path: string, _args: string[], _signal: AbortSignal) => ({ ok: true, output: { code: 0, data: { guid: 'other', completed_at: '100' } } }))
    const tool = buildLarkCliToolProvider(config(), runner)!.tools.find(tool => tool.name === 'lark_task_complete')!
    const result = await tool.execute({ taskId: 'guid-1' }, context())
    expect(result).toMatchObject({ isError: true, output: { status: 'outcome_unknown', code: 'external_outcome_unknown' } })
    // One write followed by one read; no blind replay.
    expect(runner.mock.calls[0]?.[1][1]).toBe('+complete')
    expect(runner.mock.calls[1]?.[1].slice(0, 3)).toEqual(['task', 'tasks', 'get'])
  })

  it.each([undefined, {}, { code: 999 }, { error: 'denied' }, { ok: false }, []])('rejects exit-zero invalid/API-error payload %j', output => {
    expect(_larkCliToolProviderInternals.normalizeLarkResult({ ok: true, output }).ok).toBe(false)
  })
})
