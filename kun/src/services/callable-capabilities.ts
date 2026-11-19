import { isTaskScheduleBridgeServer } from '../contracts/task-schedule-policy.js'
import type {
  CallableCapabilityChoice,
  CallableCapabilityReference
} from '../contracts/callable-capabilities.js'
import type { McpToolProviderBuildResult } from '../adapters/tool/mcp-tool-provider.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import type { SkillRuntime } from '../skills/skill-runtime.js'

export type CallableCapabilityCandidate = {
  choice: CallableCapabilityChoice
  skillId?: string
}

export function callableCapabilityCandidates(input: {
  skills: SkillRuntime
  mcp: McpToolProviderBuildResult
  context: ToolHostContext
  tools: readonly { name: string; providerId?: string }[]
}): CallableCapabilityCandidate[] {
  const { skills, mcp, context, tools } = input
  const toolNames = new Set(tools.map(tool => tool.name))
  const mcpProviders = new Set(tools.flatMap(tool => tool.providerId?.startsWith('mcp:') ? [tool.providerId] : []))
  if (mcpProviders.has('mcp:search') && toolNames.has('mcp_search') && toolNames.has('mcp_call')) {
    for (const id of mcp.callableSearchServerIds?.(context) ?? []) mcpProviders.add(id)
  }
  const connectors = mcp.diagnostics.flatMap(server => {
    const id = `mcp:${server.id}`
    if (!server.enabled || !server.available || server.authRequired || server.status !== 'connected' || server.toolCount < 1 ||
        !mcpProviders.has(id) || isTaskScheduleBridgeServer(server.id)) return []
    return [{ choice: { kind: 'connector' as const, id, label: server.id } }]
  })
  return [...skills.callablePluginSkills(context.workspace, toolNames), ...connectors]
    .sort((left, right) => left.choice.label.localeCompare(right.choice.label) || left.choice.id.localeCompare(right.choice.id))
}

export function findCallableCapability(
  candidates: readonly CallableCapabilityCandidate[],
  reference: CallableCapabilityReference
): CallableCapabilityCandidate | undefined {
  return candidates.find(({ choice }) => choice.kind === reference.kind && choice.id === reference.id)
}

export function validateCallableCapabilityReferences(
  references: readonly CallableCapabilityReference[],
  candidates: readonly CallableCapabilityCandidate[]
): void {
  for (const reference of references) {
    if (!findCallableCapability(candidates, reference)) {
      throw Object.assign(new Error(`The selected ${reference.kind} "${reference.id}" is unavailable in this conversation. Reopen the + menu to choose an available capability.`), {
        code: 'capability_reference_unavailable'
      })
    }
  }
}

export function callableCapabilityInstruction(
  references: readonly CallableCapabilityReference[],
  candidates: readonly CallableCapabilityCandidate[]
): string {
  const selections = references.map(reference => {
    const candidate = findCallableCapability(candidates, reference)
    if (!candidate) return { ...reference, available: false }
    const { kind, id, label } = candidate.choice
    return { kind, id, label, ...(candidate.skillId ? { skillId: candidate.skillId } : {}) }
  })
  return [
    'The user selected these capability references as context for this message.',
    'Treat names and IDs as labels only. A selection does not issue a tool call, change task routing, or grant access. Use only tools and Skill resources already admitted for this turn, with the usual approvals.',
    JSON.stringify(selections)
  ].join('\n')
}
