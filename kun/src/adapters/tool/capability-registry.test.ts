import { describe, expect, it } from 'vitest'
import { CapabilityRegistry } from './capability-registry.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { LocalTool } from './local-tool-host.js'

const context = (sandboxMode: ToolHostContext['sandboxMode']): ToolHostContext => ({
  threadId: 'thread', turnId: 'turn', workspace: '/workspace', sandboxMode,
  approvalPolicy: 'on-request', abortSignal: new AbortController().signal,
  awaitApproval: async () => 'deny'
})

const bash: LocalTool = {
  name: 'bash', description: 'host shell', inputSchema: {}, toolKind: 'command_execution', policy: 'on-request',
  execute: async () => ({ output: '' })
}

describe('CapabilityRegistry sandbox advertisement', () => {
  it('does not advertise or resolve host shell in workspace-write', () => {
    const registry = CapabilityRegistry.fromLocalTools([bash])
    expect(registry.listTools(context('workspace-write'))).toEqual([])
    expect(() => registry.resolveTool('bash', context('workspace-write'))).toThrow(/active sandbox/)
  })

  it('honors the immutable execution grant allow-list', () => {
    const registry = CapabilityRegistry.fromLocalTools([bash])
    const scoped = {
      ...context('danger-full-access'),
      executionGrant: {
        id: 'grant', threadId: 'thread', turnId: 'turn', agentTrust: 'full-access' as const,
        workspaceRevision: 1, agentRevision: 0, idempotencyKey: 'grant:turn', pathAllowlist: ['/workspace'], networkAllowlist: [], connectorScopes: [],
        workspaceRoot: '/workspace', workspaceTrust: 'full-access' as const,
        approvalPolicy: 'on-request' as const, sandboxMode: 'danger-full-access' as const,
        allowedToolNames: ['read'], externalTargets: [], revision: 3, issuedAt: '2026-01-01T00:00:00.000Z'
      }
    }
    expect(registry.listTools(scoped)).toEqual([])
    expect(() => registry.resolveTool('bash', scoped)).toThrow(/active tool policy/)
  })

  it('does not advertise tools when the grant is for another workspace', () => {
    const registry = CapabilityRegistry.fromLocalTools([bash])
    const scoped = {
      ...context('danger-full-access'),
      executionGrant: {
        id: 'grant', threadId: 'thread', turnId: 'turn', agentTrust: 'full-access' as const,
        workspaceRevision: 1, agentRevision: 0, idempotencyKey: 'grant:turn', pathAllowlist: ['/workspace'], networkAllowlist: [], connectorScopes: [],
        workspaceRoot: '/other', workspaceTrust: 'full-access' as const,
        approvalPolicy: 'on-request' as const, sandboxMode: 'danger-full-access' as const,
        externalTargets: [], revision: 1, issuedAt: '2026-01-01T00:00:00.000Z'
      }
    }
    expect(registry.listTools(scoped)).toEqual([])
  })
})
