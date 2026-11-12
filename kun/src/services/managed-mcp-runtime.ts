import { createHash } from 'node:crypto'
import { z } from 'zod'
import { McpCapabilityConfig } from '../contracts/capabilities.js'
import { buildMcpToolProviders, type McpToolProviderBuildResult, type McpToolProviderOptions } from '../adapters/tool/mcp-tool-provider.js'
import type { CapabilityRegistry } from '../adapters/tool/capability-registry.js'

export const McpConfigurationUpdateSchema = z.object({
  config: McpCapabilityConfig,
  environment: z.record(z.string().min(1), z.string()),
  revision: z.number().int().nonnegative()
}).strict()
export type McpConfigurationUpdate = z.infer<typeof McpConfigurationUpdateSchema>
export type McpConfigurationResult = {
  ok: boolean; changed: boolean; revision: number; configuredServers: number; connectedServers: number; toolCount: number
  errors: Array<{ id: string; message: string }>
}

/** Replaces the trusted main-process snapshot without interrupting accepted tool calls. */
export class ManagedMcpRuntime {
  private revision = -1
  private fingerprint = ''
  private queue: Promise<unknown> = Promise.resolve()
  private readonly draining = new Set<Promise<void>>()
  private closing = false
  private lastApplyFailed = false

  constructor(private current: McpToolProviderBuildResult, private config: z.infer<typeof McpCapabilityConfig> | undefined,
    private readonly registries: readonly CapabilityRegistry[], private readonly buildOptions: McpToolProviderOptions = {}) {}

  state(): McpToolProviderBuildResult { return this.current }
  configuration(): z.infer<typeof McpCapabilityConfig> | undefined { return this.config }

  refresh(raw: McpConfigurationUpdate): Promise<McpConfigurationResult> {
    const request = McpConfigurationUpdateSchema.parse(raw)
    const pending = this.queue.catch(() => undefined).then(() => this.apply(request))
    this.queue = pending
    return pending
  }

  private async apply(request: McpConfigurationUpdate): Promise<McpConfigurationResult> {
    if (this.closing) throw configurationError('runtime_shutting_down', 'Runtime is shutting down.')
    const fingerprint = createHash('sha256').update(JSON.stringify({ config: request.config, environment: request.environment })).digest('hex')
    if (request.revision < this.revision || (request.revision === this.revision && fingerprint !== this.fingerprint)) {
      throw configurationError('mcp_configuration_conflict', 'MCP configuration changed. Reload the saved settings before applying them.')
    }
    if (fingerprint === this.fingerprint && !this.lastApplyFailed && this.current.diagnostics.every(server => !server.enabled || server.status === 'connected')) {
      this.revision = request.revision
      return this.result(false)
    }
    const previous = this.current
    // Revoke future dispatch immediately. Already accepted calls retain their client until they settle.
    previous.retire()
    let next = await buildMcpToolProviders(request.config, { ...this.buildOptions, environment: request.environment })
    try {
      // Both registries use the same provider generation, and replacement validates before mutation.
      for (const registry of this.registries) registry.validateMcpProviders(next.providers)
      for (const registry of this.registries) registry.replaceMcpProviders(next.providers)
    } catch {
      await next.close()
      next = await buildMcpToolProviders(undefined)
      for (const registry of this.registries) registry.replaceMcpProviders([])
      this.current = next
      this.config = request.config
      this.revision = request.revision
      this.fingerprint = fingerprint
      this.lastApplyFailed = true
      this.drain(previous)
      throw configurationError('mcp_catalog_conflict', 'The new MCP catalog conflicts with registered tools. The previous configuration has been revoked.')
    }
    this.current = next
    this.config = request.config
    this.revision = request.revision
    this.fingerprint = fingerprint
    this.lastApplyFailed = false
    this.drain(previous)
    return this.result(true)
  }

  private result(changed: boolean): McpConfigurationResult {
    const errors = this.current.diagnostics.filter(server => server.enabled && server.status !== 'connected')
      .map(server => ({ id: server.id, message: server.lastError ?? 'The configured server could not connect.' }))
    return { ok: errors.length === 0, changed, revision: this.revision, configuredServers: Object.keys(this.config?.servers ?? {}).length,
      connectedServers: this.current.connectedServers, toolCount: this.current.toolCount, errors }
  }

  private drain(generation: McpToolProviderBuildResult): void {
    const pending = generation.close()
    this.draining.add(pending)
    void pending.finally(() => this.draining.delete(pending)).catch(() => undefined)
  }

  async close(): Promise<void> {
    this.closing = true
    await this.queue.catch(() => undefined)
    await this.current.close()
    await Promise.allSettled([...this.draining])
  }
}

function configurationError(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
