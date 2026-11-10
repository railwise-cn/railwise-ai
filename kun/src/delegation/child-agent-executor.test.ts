import { describe, expect, it } from 'vitest'
import type { ExecutionGrant } from '../contracts/permissions.js'
import { intersectChildExecutionScope } from './child-agent-executor.js'

const grant = (overrides: Partial<ExecutionGrant> = {}): ExecutionGrant => ({
  id: 'grant-parent', threadId: 'parent-thread', turnId: 'parent-turn', workspaceRoot: '/repo', allowedProviderIds: ['lark-cli'],
  workspaceTrust: 'full-access', agentTrust: 'workspace-write', approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write', allowedToolNames: ['read', 'lark_list_tasks', 'lark_complete_task'],
  pathAllowlist: ['/repo'], networkAllowlist: ['*'], connectorScopes: ['task:task:read', 'task:task:write'],
  externalTargets: ['task-1'], workspaceRevision: 2, agentRevision: 3, revision: 2,
  idempotencyKey: 'parent-turn', issuedAt: '2026-11-10T00:00:00.000Z',
  expiresAt: '2026-11-10T01:00:00.000Z', ...overrides
})

describe('child execution scope inheritance', () => {
  it('intersects parent and current provider permissions, paths, targets, and expiry', () => {
    const scope = intersectChildExecutionScope(grant(), '/repo/child', {
      allowedToolNames: ['read', 'lark_list_tasks', 'unrelated'],
      allowedProviderIds: ['lark-cli', 'unrelated'],
      pathAllowlist: ['/repo/child/docs'],
      networkAllowlist: ['https://open.feishu.cn'],
      connectorScopes: ['task:task:read', 'approval:task:write'],
      externalTargets: ['task-1', 'task-2'],
      expiresAt: '2026-11-10T00:30:00.000Z'
    })
    expect(scope).toEqual({
      allowedToolNames: ['read', 'lark_list_tasks'],
      allowedProviderIds: ['lark-cli'],
      pathAllowlist: ['/repo/child/docs'],
      networkAllowlist: ['https://open.feishu.cn'],
      connectorScopes: ['task:task:read'],
      externalTargets: ['task-1'],
      expiresAt: '2026-11-10T00:30:00.000Z'
    })
  })

  it('fails closed when current provider configuration is absent or the child path escapes its parent grant', () => {
    expect(intersectChildExecutionScope(grant(), '/repo/child').connectorScopes).toEqual([])
    expect(intersectChildExecutionScope(grant(), '/outside').pathAllowlist).toEqual([])
  })

  it('preserves an explicitly narrower inherited path when the child workspace is its parent', () => {
    expect(intersectChildExecutionScope(grant({ pathAllowlist: ['/repo/child/docs'] }), '/repo/child').pathAllowlist)
      .toEqual(['/repo/child/docs'])
  })
})
