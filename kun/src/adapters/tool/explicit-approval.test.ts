import { describe, expect, it } from 'vitest'
import { LocalToolHost } from './local-tool-host.js'
import type { ToolHostContext } from '../../ports/tool-host.js'

const context = (): ToolHostContext => ({ threadId: 'thread', turnId: 'turn', workspace: '/workspace', sandboxMode: 'workspace-write', approvalPolicy: 'auto', abortSignal: new AbortController().signal, awaitApproval: async () => 'deny' })
const call = { callId: 'call', toolName: 'complete_task', arguments: { taskId: 'remote-task' } }

describe('explicit confirmation for external writes', () => {
  it('does not allow legacy auto policy to bypass confirmation', async () => {
    let executed = 0
    const host = new LocalToolHost({ tools: [LocalToolHost.defineTool({ name: 'complete_task', description: 'Complete task', inputSchema: {}, policy: 'on-request', requireExplicitApproval: true, execute: async () => { executed++; return { output: { ok: true } } } })] })
    const result = await host.execute(call, context())
    expect(result.approved).toBe(false)
    expect(executed).toBe(0)
  })

  it('rechecks revocation after confirmation and preserves a distinct failure code', async () => {
    let executed = 0
    let validations = 0
    const host = new LocalToolHost({ tools: [LocalToolHost.defineTool({ name: 'complete_task', description: 'Complete task', inputSchema: {}, policy: 'on-request', requireExplicitApproval: true, execute: async () => { executed++; return { output: { ok: true } } } })] })
    const result = await host.execute(call, { ...context(), awaitApproval: async () => 'allow', validateExecutionGrant: async () => { if (++validations === 2) throw Object.assign(new Error('Grant revoked'), { code: 'execution_grant_revoked' }) } })
    expect(result.item.kind).toBe('tool_result')
    expect(result.item).toMatchObject({ isError: true, output: { code: 'execution_grant_revoked' } })
    expect(executed).toBe(0)
    expect(validations).toBe(2)
  })
})
