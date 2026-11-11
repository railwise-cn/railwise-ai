import { describe, expect, it, vi } from 'vitest'
import { KunCapabilitiesConfig } from '../contracts/capabilities.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { CapabilityRegistry } from '../adapters/tool/capability-registry.js'
import { LocalToolHost } from '../adapters/tool/local-tool-host.js'
import { buildMcpToolProviders, type McpClientLike } from '../adapters/tool/mcp-tool-provider.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import { ManagedMcpRuntime } from './managed-mcp-runtime.js'

const configuration = (enabled = true) => KunCapabilitiesConfig.parse({ mcp: { enabled: true, search: { enabled: false }, servers: {
  docs: { enabled, transport: 'stdio', command: 'synthetic-only', trustScope: 'user', env: { AUTH: '${SYNTHETIC_TOKEN}' } }
} } }).mcp

function context(fingerprints: Record<string, string>): ToolHostContext {
  return { threadId: 'thread', turnId: 'turn', workspace: '/synthetic', approvalPolicy: 'on-request', sandboxMode: 'workspace-write',
    abortSignal: new AbortController().signal, awaitApproval: async () => 'allow',
    executionGrant: ExecutionGrantSchema.parse({ id: 'grant', threadId: 'thread', turnId: 'turn', workspaceRoot: '/synthetic',
      workspaceTrust: 'workspace-write', agentTrust: 'workspace-write', approvalPolicy: 'on-request', sandboxMode: 'workspace-write',
      pathAllowlist: ['/synthetic'], networkAllowlist: ['*'], connectorScopes: [], externalTargets: [], allowedProviderIds: ['mcp:docs'],
      connectorIdentityFingerprints: fingerprints, workspaceRevision: 1, agentRevision: 1, revision: 1, idempotencyKey: 'grant', issuedAt: new Date().toISOString() }) }
}

describe('managed MCP configuration generations', () => {
  it('checks the target server identity inside search-mode calls and invalidates a changed tool schema', async () => {
    let schemaVersion = 'first'
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'synthetic read' }] }))
    const config = configuration()
    config.search.enabled = true
    config.search.mode = 'search'
    const built = await buildMcpToolProviders(config, { environment: { SYNTHETIC_TOKEN: 'synthetic' }, clientFactory: async () => ({
      listTools: async () => ({ tools: [{ name: 'read', inputSchema: { type: 'object', description: schemaVersion }, annotations: { readOnlyHint: true } }] }),
      callTool, close: async () => undefined
    }) })
    const host = new LocalToolHost({ registry: new CapabilityRegistry(built.providers) })
    const scoped = context(built.authorityFingerprints)
    scoped.executionGrant!.allowedProviderIds = ['mcp:search']
    try {
      schemaVersion = 'changed'
      await host.execute({ callId: 'refresh', toolName: 'mcp_refresh_catalog', arguments: {} }, scoped)
      const stale = await host.execute({ callId: 'stale-read', toolName: 'mcp_call', arguments: { toolId: 'docs/read', arguments: {} } }, scoped)
      expect(stale.item).toMatchObject({ kind: 'tool_result', isError: true })
      expect(callTool).not.toHaveBeenCalled()
      const refreshed = context(built.authorityFingerprints)
      refreshed.executionGrant!.allowedProviderIds = ['mcp:search']
      expect((await host.execute({ callId: 'fresh-read', toolName: 'mcp_call', arguments: { toolId: 'docs/read', arguments: {} } }, refreshed)).item).toMatchObject({ kind: 'tool_result', isError: false })
      expect(callTool).toHaveBeenCalledTimes(1)
    } finally { await built.close() }
  })
  it('updates both catalogs without closing an accepted call, and prevents old Grants using new credentials', async () => {
    let finishOld!: (value: unknown) => void
    const oldResult = new Promise<unknown>(resolve => { finishOld = resolve })
    const closeOld = vi.fn(async () => undefined)
    let calls = 0
    let generation = 0
    const clientFactory = vi.fn(async (): Promise<McpClientLike> => {
      const current = generation++
      return { listTools: async () => ({ tools: [{ name: 'update', annotations: { readOnlyHint: false } }] }),
        callTool: async () => { calls++; return current === 0 ? oldResult : { content: [{ type: 'text', text: 'new generation' }] } },
        close: current === 0 ? closeOld : async () => undefined }
    })
    const config = configuration()
    const first = await buildMcpToolProviders(config, { clientFactory, environment: { SYNTHETIC_TOKEN: 'first' } })
    const root = new CapabilityRegistry(first.providers), child = new CapabilityRegistry(first.providers)
    const host = new LocalToolHost({ registry: root })
    const runtime = new ManagedMcpRuntime(first, config, [root, child], { clientFactory })
    try {
      const originalContext = context(first.authorityFingerprints)
      const active = host.execute({ callId: 'old', toolName: 'mcp_docs_update', arguments: {} }, originalContext)
      await vi.waitFor(() => expect(calls).toBe(1))
      expect(await runtime.refresh({ config, environment: { SYNTHETIC_TOKEN: 'second' }, revision: 2 })).toMatchObject({ ok: true, changed: true, toolCount: 1 })
      expect(closeOld).not.toHaveBeenCalled()
      expect(await host.listTools(originalContext)).toEqual([])
      await expect(host.execute({ callId: 'stale', toolName: 'mcp_docs_update', arguments: {} }, originalContext)).rejects.toThrow(/not advertised/)
      const nextContext = context(runtime.state().authorityFingerprints)
      expect(root.listTools(nextContext).map(tool => tool.name)).toEqual(['mcp_docs_update'])
      expect(child.listTools(nextContext).map(tool => tool.name)).toEqual(['mcp_docs_update'])
      finishOld({ content: [{ type: 'text', text: 'accepted old operation completed' }] })
      await active
      await vi.waitFor(() => expect(closeOld).toHaveBeenCalledTimes(1))
      await expect(runtime.refresh({ config, environment: { SYNTHETIC_TOKEN: 'other' }, revision: 2 })).rejects.toMatchObject({ code: 'mcp_configuration_conflict' })
      await expect(runtime.refresh({ config, environment: { SYNTHETIC_TOKEN: 'first' }, revision: 1 })).rejects.toMatchObject({ code: 'mcp_configuration_conflict' })
      expect(await runtime.refresh({ config, environment: { SYNTHETIC_TOKEN: 'second' }, revision: 3 })).toMatchObject({ changed: false, revision: 3 })
      expect(clientFactory).toHaveBeenCalledTimes(2)
      expect(await runtime.refresh({ config: configuration(false), environment: {}, revision: 4 })).toMatchObject({ ok: true, toolCount: 0 })
      expect(await host.listTools()).toEqual([])
      expect(calls).toBe(1)
    } finally { finishOld({}); await runtime.close() }
  })

  it('reports an enabled preset with no reviewed tools as unavailable and skips disabled credential resolution', async () => {
    const factory = vi.fn(async (): Promise<McpClientLike> => ({ listTools: async () => ({ tools: [{ name: 'unreviewed_write' }] }), callTool: async () => ({}), close: async () => undefined }))
    const config = KunCapabilitiesConfig.parse({ mcp: { enabled: true, servers: { preset: { enabled: false, transport: 'streamable-http', trustScope: 'user', url: 'https://synthetic.invalid/mcp?key=${MISSING}', toolPolicy: { allowedTools: ['read'], readOnlyTools: ['read'] } } } } }).mcp
    const initial = await buildMcpToolProviders(undefined)
    const runtime = new ManagedMcpRuntime(initial, undefined, [new CapabilityRegistry()], { clientFactory: factory })
    try {
      expect(await runtime.refresh({ config, environment: {}, revision: 1 })).toMatchObject({ ok: true, connectedServers: 0 })
      expect(factory).not.toHaveBeenCalled()
      config.servers.preset!.enabled = true
      expect(await runtime.refresh({ config, environment: { MISSING: 'synthetic-secret' }, revision: 2 })).toMatchObject({ ok: false, toolCount: 0, errors: [{ id: 'preset' }] })
      expect(runtime.state().providers).toEqual([])
    } finally { await runtime.close() }
  })
})
