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
    scoped.allowedMcpProviderIds = ['mcp:docs']
    scoped.executionGrant!.allowedMcpProviderIds = ['mcp:docs']
    try {
      schemaVersion = 'changed'
      await host.execute({ callId: 'refresh', toolName: 'mcp_refresh_catalog', arguments: {} }, scoped)
      const stale = await host.execute({ callId: 'stale-read', toolName: 'mcp_call', arguments: { toolId: 'docs/read', arguments: {} } }, scoped)
      expect(stale.item).toMatchObject({ kind: 'tool_result', isError: true })
      expect(callTool).not.toHaveBeenCalled()
      const refreshed = context(built.authorityFingerprints)
      refreshed.executionGrant!.allowedProviderIds = ['mcp:search']
      refreshed.allowedMcpProviderIds = ['mcp:docs']
      refreshed.executionGrant!.allowedMcpProviderIds = ['mcp:docs']
      expect((await host.execute({ callId: 'fresh-read', toolName: 'mcp_call', arguments: { toolId: 'docs/read', arguments: {} } }, refreshed)).item).toMatchObject({ kind: 'tool_result', isError: false })
      expect(callTool).toHaveBeenCalledTimes(1)
      const excluded = { ...refreshed, allowedMcpProviderIds: ['mcp:other'] }
      expect((await host.execute({ callId: 'excluded-read', toolName: 'mcp_call', arguments: { toolId: 'docs/read', arguments: {} } }, excluded)).item).toMatchObject({ kind: 'tool_result', isError: true })
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
      expect(await runtime.refresh({ config, environment: { SYNTHETIC_TOKEN: 'second' }, revision: 2 })).toMatchObject({ applied: true, ok: true, changed: true, revision: 2, toolCount: 1 })
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
      const current = runtime.state()
      expect(await runtime.refresh({ config, environment: { SYNTHETIC_TOKEN: 'second' }, revision: 2 })).toMatchObject({ applied: true, ok: true, changed: false, revision: 2 })
      expect(runtime.state()).toBe(current)
      expect(await runtime.refresh({ config, environment: { SYNTHETIC_TOKEN: 'second' }, revision: 3 })).toMatchObject({ applied: true, changed: false, revision: 3 })
      expect(clientFactory).toHaveBeenCalledTimes(2)
      expect(await runtime.refresh({ config: configuration(false), environment: {}, revision: 4 })).toMatchObject({ applied: true, ok: true, revision: 4, toolCount: 0 })
      expect(await host.listTools()).toEqual([])
      expect(calls).toBe(1)
    } finally { finishOld({}); await runtime.close() }
  })

  it('acknowledges an installed revision while preserving an unrelated server connection failure', async () => {
    const clientFactory = vi.fn(async (id: string): Promise<McpClientLike> => {
      if (id === 'offline') throw new Error('Synthetic server is offline')
      return { listTools: async () => ({ tools: [{ name: 'read', annotations: { readOnlyHint: true } }] }),
        callTool: async () => ({ content: [] }), close: async () => undefined }
    })
    const config = configuration()
    config.servers.offline = { ...config.servers.docs!, command: 'synthetic-offline' }
    const initial = await buildMcpToolProviders(undefined)
    const root = new CapabilityRegistry(), child = new CapabilityRegistry()
    const runtime = new ManagedMcpRuntime(initial, undefined, [root, child], { clientFactory })
    const request = { config, environment: { SYNTHETIC_TOKEN: 'synthetic' }, revision: 0 }
    try {
      const result = await runtime.refresh(request)
      expect(result).toMatchObject({ applied: true, ok: false, changed: true, revision: 0,
        configuredServers: 2, connectedServers: 1, toolCount: 1, errors: [{ id: 'offline', message: 'Synthetic server is offline' }] })
      expect(runtime.configuration()).toEqual(config)
      expect(runtime.state().diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'docs', status: 'connected' }),
        expect.objectContaining({ id: 'offline', status: 'error' })
      ]))
      const grant = context(runtime.state().authorityFingerprints)
      expect(root.listTools(grant).map(tool => tool.name)).toEqual(['mcp_docs_read'])
      expect(child.listTools(grant).map(tool => tool.name)).toEqual(['mcp_docs_read'])

      // An unhealthy exact retry retains the existing reconnect behavior. Its
      // acknowledgement still identifies precisely the accepted configuration.
      expect(await runtime.refresh(request)).toMatchObject({ applied: true, ok: false, revision: 0, errors: [{ id: 'offline' }] })
      expect(await runtime.refresh({ ...request, revision: 2 })).toMatchObject({ applied: true, ok: false, revision: 2 })
      const calls = clientFactory.mock.calls.length
      const current = runtime.state()
      await expect(runtime.refresh({ ...request, revision: 1 })).rejects.toMatchObject({ code: 'mcp_configuration_conflict' })
      await expect(runtime.refresh({ ...request, config: configuration(false), revision: 2 })).rejects.toMatchObject({ code: 'mcp_configuration_conflict' })
      expect(clientFactory).toHaveBeenCalledTimes(calls)
      expect(runtime.state()).toBe(current)
      expect(runtime.configuration()).toEqual(config)
    } finally { await runtime.close() }
  })

  it('rejects catalog application failure and acknowledges the same revision only after its valid retry', async () => {
    const clientFactory = vi.fn(async (): Promise<McpClientLike> => ({ listTools: async () => ({ tools: [{ name: 'read' }] }),
      callTool: async () => ({ content: [] }), close: async () => undefined }))
    const initial = await buildMcpToolProviders(undefined)
    const registry = new CapabilityRegistry()
    const validate = vi.spyOn(registry, 'validateMcpProviders').mockImplementationOnce(() => { throw new Error('Synthetic catalog conflict') })
    const runtime = new ManagedMcpRuntime(initial, undefined, [registry], { clientFactory })
    const request = { config: configuration(), environment: { SYNTHETIC_TOKEN: 'synthetic' }, revision: 1 }
    try {
      await expect(runtime.refresh(request)).rejects.toMatchObject({ code: 'mcp_catalog_conflict' })
      expect(runtime.state().providers).toEqual([])
      expect(await runtime.refresh(request)).toMatchObject({ applied: true, ok: true, changed: true, revision: 1, toolCount: 1 })
      expect(clientFactory).toHaveBeenCalledTimes(2)
    } finally { validate.mockRestore(); await runtime.close() }
  })

  it('reports an enabled preset with no reviewed tools as unavailable and skips disabled credential resolution', async () => {
    const factory = vi.fn(async (): Promise<McpClientLike> => ({ listTools: async () => ({ tools: [{ name: 'unreviewed_write' }] }), callTool: async () => ({}), close: async () => undefined }))
    const config = KunCapabilitiesConfig.parse({ mcp: { enabled: true, servers: { preset: { enabled: false, transport: 'streamable-http', trustScope: 'user', url: 'https://synthetic.invalid/mcp?key=${MISSING}', toolPolicy: { allowedTools: ['read'], readOnlyTools: ['read'] } } } } }).mcp
    const initial = await buildMcpToolProviders(undefined)
    const runtime = new ManagedMcpRuntime(initial, undefined, [new CapabilityRegistry()], { clientFactory: factory })
    try {
      expect(await runtime.refresh({ config, environment: {}, revision: 1 })).toMatchObject({ applied: true, ok: true, revision: 1, connectedServers: 0 })
      expect(factory).not.toHaveBeenCalled()
      config.servers.preset!.enabled = true
      expect(await runtime.refresh({ config, environment: { MISSING: 'synthetic-secret' }, revision: 2 })).toMatchObject({ applied: true, ok: false, revision: 2, toolCount: 0, errors: [{ id: 'preset' }] })
      expect(runtime.state().providers).toEqual([])
    } finally { await runtime.close() }
  })
})
