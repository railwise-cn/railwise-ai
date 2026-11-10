import { describe, expect, it } from 'vitest'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { assertGrantAllowsExternalTarget, assertGrantAllowsNetwork, assertGrantConnectorScopes, canWritePath, effectiveApprovalPolicy, effectiveSandboxMode, externalTargetGrantKey, sandboxBlockForTool } from './sandbox-policy.js'

const base = (grant: NonNullable<ToolHostContext['executionGrant']>): ToolHostContext => ({
  threadId: 'thread', turnId: 'turn', workspace: '/workspace', sandboxMode: 'danger-full-access',
  approvalPolicy: 'auto', executionGrant: grant,
  abortSignal: new AbortController().signal, awaitApproval: async () => 'deny'
})

const grant = (overrides: Partial<NonNullable<ToolHostContext['executionGrant']>> = {}): NonNullable<ToolHostContext['executionGrant']> => ({
  id: 'grant', threadId: 'thread', turnId: 'turn', taskId: 'task', agentTrust: 'full-access',
  workspaceRevision: 1, agentRevision: 0, idempotencyKey: 'grant:turn', pathAllowlist: ['/workspace'], networkAllowlist: ['api.example.com'], connectorScopes: ['task:read'],
  workspaceRoot: '/workspace', workspaceTrust: 'workspace-write', approvalPolicy: 'on-request',
  sandboxMode: 'danger-full-access', externalTargets: [], revision: 1, issuedAt: '2026-01-01T00:00:00.000Z',
  ...overrides
})

describe('execution grant sandbox and approval enforcement', () => {
  it('treats empty target scopes as no write permission and keys exact provider/action/target', () => {
    const unscoped = base(grant())
    expect(() => assertGrantAllowsExternalTarget('lark', 'list', 'current_user', unscoped)).not.toThrow()
    expect(() => assertGrantAllowsExternalTarget('lark', 'complete', 'a', unscoped)).toThrow(/outside the reviewed/)
    const scoped = base(grant({ externalTargets: [externalTargetGrantKey('lark', 'complete', 'a')] }))
    expect(() => assertGrantAllowsExternalTarget('lark', 'complete', 'a', scoped)).not.toThrow()
    expect(() => assertGrantAllowsExternalTarget('dingtalk', 'complete', 'a', scoped)).toThrow()
    expect(() => assertGrantAllowsExternalTarget('lark', 'approve', 'a', scoped)).toThrow()
    expect(() => assertGrantAllowsExternalTarget('lark', 'complete', 'b', scoped)).toThrow()
  })
  it('rejects reuse of a grant by another Turn', () => {
    const context = { ...base(grant()), turnId: 'different' }
    expect(sandboxBlockForTool({ name: 'read', toolKind: 'tool_call' }, context)?.code).toBe('execution_grant_scope')
  })

  it('enforces path/network/scope intersections even in full access', () => {
    const context = base(grant({ workspaceTrust: 'full-access' }))
    expect(canWritePath('/other/file', context)).toMatchObject({ ok: false, block: { code: 'workspace_path_blocked' } })
    expect(() => assertGrantAllowsNetwork('https://api.example.com/tasks', context)).not.toThrow()
    expect(() => assertGrantAllowsNetwork('https://api.example.com.evil/tasks', context)).toThrow(/outside the execution grant/)
    expect(() => assertGrantConnectorScopes(['task:read'], context)).not.toThrow()
    expect(() => assertGrantConnectorScopes(['task:write'], context)).toThrow(/permission required/)
  })

  it('downgrades a full-access request when workspace trust is not full-access', () => {
    const context = base(grant({ workspaceTrust: 'workspace-write' }))
    expect(effectiveSandboxMode(context)).toBe('workspace-write')
    expect(sandboxBlockForTool({ name: 'bash', toolKind: 'command_execution' }, context)?.code).toBe('sandbox_command_blocked')
  })

  it('allows host commands only when the immutable grant is full-access', () => {
    const context = base(grant({ workspaceTrust: 'full-access', pathAllowlist: ['*'], networkAllowlist: ['*'] }))
    expect(effectiveSandboxMode(context)).toBe('danger-full-access')
    expect(sandboxBlockForTool({ name: 'bash', toolKind: 'command_execution' }, context)).toBeNull()
  })

  it('rejects writes outside the grant workspace and expired grants', () => {
    const outside = base(grant({ workspaceRoot: '/other', workspaceTrust: 'full-access' }))
    expect(canWritePath('/workspace/file.txt', outside)).toMatchObject({ ok: false, block: { code: 'execution_grant_scope' } })
    const expired = base(grant({ expiresAt: '2020-01-01T00:00:00.000Z' }))
    expect(sandboxBlockForTool({ name: 'read', toolKind: 'tool_call' }, expired)?.code).toBe('execution_grant_expired')
  })

  it('uses the stricter approval policy from the grant', () => {
    expect(effectiveApprovalPolicy({ approvalPolicy: 'auto', executionGrant: grant({ approvalPolicy: 'on-request' }) })).toBe('on-request')
    expect(effectiveApprovalPolicy({ approvalPolicy: 'on-request', executionGrant: grant({ approvalPolicy: 'auto' }) })).toBe('on-request')
  })
})
