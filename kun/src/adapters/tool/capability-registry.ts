import type {
  ToolHostContext,
  ToolProviderKind,
  ToolProviderPolicy
} from '../../ports/tool-host.js'
import type { LocalTool } from './local-tool-host.js'
import type { ToolEffectDefinition } from '../../ports/tool-effect.js'
import { externalOperationForTool } from '../../services/external-effect-evidence.js'
import { executionGrantBlock, isToolAdvertisedInSandbox, sandboxBlockForTool } from './sandbox-policy.js'

export type CapabilityToolRecord = {
  provider: ToolProviderPolicy
  tool: LocalTool
}

export type CapabilityToolProvider = ToolProviderPolicy & {
  tools: readonly LocalTool[]
}

export type CapabilityToolSpec = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  toolKind?: 'tool_call' | 'command_execution' | 'file_change'
  providerId: string
  providerKind: ToolProviderKind
}

const PLAN_MODE_ALLOWED_TOOL_NAMES = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'create_plan',
  'user_input',
  'request_user_input'
])

export class CapabilityRegistry {
  private readonly providers = new Map<string, CapabilityToolProvider>()
  private readonly tools = new Map<string, CapabilityToolRecord>()

  static fromLocalTools(tools: readonly LocalTool[]): CapabilityRegistry {
    return new CapabilityRegistry([
      {
        id: 'builtin',
        kind: 'built-in',
        enabled: true,
        available: true,
        tools
      }
    ])
  }

  constructor(providers: readonly CapabilityToolProvider[] = []) {
    for (const provider of providers) {
      this.registerProvider(provider)
    }
  }

  registerProvider(provider: CapabilityToolProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`duplicate tool provider: ${provider.id}`)
    }
    this.providers.set(provider.id, provider)
    for (const tool of provider.tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`duplicate tool name: ${tool.name}`)
      }
      this.tools.set(tool.name, { provider: providerPolicy(provider), tool })
    }
  }

  /** Atomically replace one managed provider after trusted configuration refresh. */
  replaceProvider(id: string, replacement?: CapabilityToolProvider): void {
    if (replacement && replacement.id !== id) throw new Error('provider replacement identity mismatch')
    for (const tool of replacement?.tools ?? []) {
      const owner = this.tools.get(tool.name)?.provider.id
      if (owner && owner !== id) throw new Error(`duplicate tool name: ${tool.name}`)
    }
    const previous = this.providers.get(id)
    for (const tool of previous?.tools ?? []) this.tools.delete(tool.name)
    this.providers.delete(id)
    if (replacement) this.registerProvider(replacement)
  }

  /** Validate a complete provider generation before publishing either index. */
  validateMcpProviders(replacements: readonly CapabilityToolProvider[]): CapabilityRegistry {
    if (replacements.some(provider => provider.kind !== 'mcp' || !provider.id.startsWith('mcp:'))) throw new Error('MCP replacement contains another provider kind')
    const retained = [...this.providers.values()].filter(provider => provider.kind !== 'mcp')
    return new CapabilityRegistry([...retained, ...replacements])
  }

  replaceMcpProviders(replacements: readonly CapabilityToolProvider[]): void {
    const next = this.validateMcpProviders(replacements)
    this.providers.clear()
    this.tools.clear()
    for (const [id, provider] of next.providers) this.providers.set(id, provider)
    for (const [name, tool] of next.tools) this.tools.set(name, tool)
  }

  listTools(context?: ToolHostContext): CapabilityToolSpec[] {
    const specs: CapabilityToolSpec[] = []
    for (const record of this.tools.values()) {
      if (!this.canUseProvider(record.provider, context)) continue
      if (!this.canUseTool(record.tool.name, context)) continue
      if (!isToolAdvertisedInSandbox(record.tool, context)) continue
      if (context && record.tool.contextBlock?.(context)) continue
      if (record.tool.shouldAdvertise) {
        if (!context || !record.tool.shouldAdvertise(context)) continue
      }
      specs.push({
        name: record.tool.name,
        description: record.tool.description,
        inputSchema: record.tool.inputSchema,
        toolKind: record.tool.toolKind,
        providerId: record.provider.id,
        providerKind: record.provider.kind
      })
    }
    return specs
  }

  resolveTool(toolName: string, context: ToolHostContext, providerId?: string): CapabilityToolRecord {
    const record = this.tools.get(toolName)
    const grantBlock = executionGrantBlock(context)
    if (grantBlock) throw Object.assign(new Error(grantBlock.message), { code: grantBlock.code })
    if (!record) {
      throw new Error(`unknown tool: ${toolName}`)
    }
    if (providerId && providerId !== record.provider.id) {
      throw new Error(`tool ${toolName} is not provided by ${providerId}`)
    }
    if (!this.canUseProvider(record.provider, context)) {
      throw new Error(`tool ${toolName} is not advertised by provider ${record.provider.id}`)
    }
    const contextBlock = record.tool.contextBlock?.(context)
    if (contextBlock) throw Object.assign(new Error(contextBlock.message), { code: contextBlock.code })
    if (!this.canUseTool(toolName, context)) {
      throw new Error(`tool ${toolName} is not advertised by active tool policy`)
    }
    const sandboxBlock = sandboxBlockForTool(record.tool, context)
    if (sandboxBlock) {
      throw Object.assign(new Error(`tool ${toolName} is not advertised in the active sandbox: ${sandboxBlock.message}`), { code: sandboxBlock.code })
    }
    if (record.tool.shouldAdvertise && !record.tool.shouldAdvertise(context)) {
      throw new Error(`tool ${toolName} is not advertised in this turn context`)
    }
    return record
  }

  diagnostics(): ToolProviderPolicy[] {
    return [...this.providers.values()].map(providerPolicy)
  }

  describeEffect(toolName: string): ToolEffectDefinition | undefined {
    const record = this.tools.get(toolName)
    if (!record) return undefined
    const effect = record.tool.effect ?? externalOperationForTool(toolName)
    if (!effect) return undefined
    const expectedProvider = effect.providerId ?? (effect.provider === 'lark' ? 'lark-cli' : effect.provider)
    if (record.provider.id !== expectedProvider) return undefined
    return { ...effect, providerId: record.provider.id }
  }

  describeAllEffects(): ToolEffectDefinition[] {
    return [...this.tools.keys()].flatMap(name => {
      const effect = this.describeEffect(name)
      return effect ? [effect] : []
    })
  }

  private canUseProvider(provider: ToolProviderPolicy, context?: ToolHostContext): boolean {
    if (!provider.enabled || !provider.available) return false
    const allowed = context?.allowedProviderIds
    if (allowed && !allowed.includes(provider.id)) return false
    const granted = context?.executionGrant?.allowedProviderIds
    if (granted && !granted.includes(provider.id)) return false
    // Search routes to individual servers, where both MCP allowlists and the
    // immutable server fingerprint are checked again before lookup or dispatch.
    const allowedMcp = context?.allowedMcpProviderIds
    if (provider.kind === 'mcp' && allowedMcp && (provider.id === 'mcp:search' ? allowedMcp.length === 0 : !allowedMcp.includes(provider.id))) return false
    const grantedMcp = context?.executionGrant?.allowedMcpProviderIds
    if (provider.kind === 'mcp' && grantedMcp && (provider.id === 'mcp:search' ? grantedMcp.length === 0 : !grantedMcp.includes(provider.id))) return false
    return true
  }

  private canUseTool(toolName: string, context?: ToolHostContext): boolean {
    if (isPlanModeContext(context) && !PLAN_MODE_ALLOWED_TOOL_NAMES.has(toolName)) {
      return false
    }
    const allowed = context?.allowedToolNames
    if (allowed && !allowed.includes(toolName)) return false
    const granted = context?.executionGrant?.allowedToolNames
    return !granted || granted.includes(toolName)
  }
}

function isPlanModeContext(context: ToolHostContext | undefined): boolean {
  return context?.threadMode === 'plan' || Boolean(context?.guiPlan)
}

function providerPolicy(provider: ToolProviderPolicy): ToolProviderPolicy {
  return {
    id: provider.id,
    kind: provider.kind,
    enabled: provider.enabled,
    available: provider.available,
    ...(provider.reason ? { reason: provider.reason } : {})
  }
}
