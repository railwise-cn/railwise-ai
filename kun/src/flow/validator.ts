import type { FlowDefinitionV1, FlowNodeRegistryEntryV1, FlowValidationIssueV1 } from '../contracts/flow.js'
import { normalizeScheduleSpec } from '../contracts/schedule.js'
import { portsCompatible } from './node-registry.js'

export function validateFlowDefinition(definition: FlowDefinitionV1, registry: FlowNodeRegistryEntryV1[]): { valid: boolean; issues: FlowValidationIssueV1[] } {
  const issues: FlowValidationIssueV1[] = []
  const nodes = new Map<string, FlowDefinitionV1['nodes'][number]>()
  const entries = new Map(registry.map((entry) => [entry.type, entry]))
  const issue = (value: FlowValidationIssueV1) => issues.push(value)
  for (const node of definition.nodes) {
    if (nodes.has(node.id)) issue({ code: 'duplicate_node_id', severity: 'error', message: `Duplicate node id: ${node.id}`, nodeId: node.id })
    nodes.set(node.id, node)
    const entry = entries.get(node.type)
    if (!entry) { issue({ code: 'unknown_node_type', severity: 'error', message: `Unknown node type: ${node.type}`, nodeId: node.id }); continue }
    if (!entry.available && !node.disabled) issue({ code: 'capability_unavailable', severity: 'error', message: entry.disabledReason ?? 'Capability unavailable', nodeId: node.id })
    for (const port of entry.inputs.filter((candidate) => candidate.required)) {
      if (!(port.id in node.bindings) && !definition.edges.some((edge) => edge.targetNodeId === node.id && edge.targetPortId === port.id)) {
        issue({ code: 'required_input_missing', severity: 'error', message: `Required input is missing: ${port.label}`, nodeId: node.id })
      }
    }
    if (node.type === 'schedule_trigger' && !node.disabled) {
      try { normalizeScheduleSpec(node.config) } catch {
        issue({ code: 'invalid_schedule', severity: 'error', message: '请填写有效的计划类型、时刻和 IANA 时区。', nodeId: node.id })
      }
    }
    if (node.type === 'loop') {
      const maxIterations = Number(node.config.maxIterations)
      if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 10_000) issue({ code: 'invalid_loop_bound', severity: 'error', message: 'Loop maxIterations must be between 1 and 10000', nodeId: node.id })
    }
    if (node.type === 'run_flow' && node.config.flowId === definition.id) issue({ code: 'recursive_flow', severity: 'error', message: 'A Flow cannot invoke itself', nodeId: node.id })
  }
  const triggers = definition.nodes.filter((node) => entries.get(node.type)?.category === 'trigger' && !node.disabled)
  if (triggers.length === 0) issue({ code: 'trigger_missing', severity: 'error', message: 'Flow requires an enabled trigger' })
  for (const edge of definition.edges) {
    const source = nodes.get(edge.sourceNodeId); const target = nodes.get(edge.targetNodeId)
    if (!source || !target) { issue({ code: 'dangling_edge', severity: 'error', message: `Edge references a missing node: ${edge.id}`, edgeId: edge.id }); continue }
    const sourcePort = entries.get(source.type)?.outputs.find((port) => port.id === edge.sourcePortId)
    const targetPort = entries.get(target.type)?.inputs.find((port) => port.id === edge.targetPortId)
    if (!sourcePort || !targetPort) { issue({ code: 'unknown_port', severity: 'error', message: 'Edge references an unknown port', edgeId: edge.id }); continue }
    if (!portsCompatible(sourcePort.type, targetPort.type, edge.conversionId)) issue({ code: 'incompatible_ports', severity: 'error', message: `${sourcePort.type} cannot connect to ${targetPort.type}`, edgeId: edge.id })
  }
  const reachable = reachableNodeIds(triggers.map((node) => node.id), definition.edges)
  for (const node of definition.nodes) if (!node.disabled && !reachable.has(node.id)) issue({ code: 'unreachable_node', severity: 'error', message: 'Node is not reachable from a trigger', nodeId: node.id })
  for (const component of stronglyConnectedComponents(definition.nodes.map((node) => node.id), definition.edges)) {
    const selfLoop = component.length === 1 && definition.edges.some((edge) => edge.sourceNodeId === component[0] && edge.targetNodeId === component[0])
    if (component.length < 2 && !selfLoop) continue
    const loopCount = component.filter((id) => nodes.get(id)?.type === 'loop').length
    if (loopCount !== 1) issue({ code: 'illegal_cycle', severity: 'error', message: 'A cycle must contain exactly one bounded Loop node', path: component })
  }
  return { valid: !issues.some((entry) => entry.severity === 'error'), issues }
}

function reachableNodeIds(starts: string[], edges: FlowDefinitionV1['edges']): Set<string> {
  const result = new Set(starts); const queue = [...starts]
  while (queue.length) { const id = queue.shift()!; for (const edge of edges.filter((item) => item.sourceNodeId === id)) if (!result.has(edge.targetNodeId)) { result.add(edge.targetNodeId); queue.push(edge.targetNodeId) } }
  return result
}

function stronglyConnectedComponents(ids: string[], edges: FlowDefinitionV1['edges']): string[][] {
  let cursor = 0; const indices = new Map<string, number>(); const lows = new Map<string, number>(); const stack: string[] = []; const stacked = new Set<string>(); const result: string[][] = []
  const visit = (id: string) => { indices.set(id, cursor); lows.set(id, cursor); cursor += 1; stack.push(id); stacked.add(id)
    for (const target of edges.filter((edge) => edge.sourceNodeId === id).map((edge) => edge.targetNodeId)) {
      if (!indices.has(target)) { visit(target); lows.set(id, Math.min(lows.get(id)!, lows.get(target)!)) }
      else if (stacked.has(target)) lows.set(id, Math.min(lows.get(id)!, indices.get(target)!))
    }
    if (lows.get(id) === indices.get(id)) { const component: string[] = []; let value: string; do { value = stack.pop()!; stacked.delete(value); component.push(value) } while (value !== id); result.push(component) }
  }
  for (const id of ids) if (!indices.has(id)) visit(id)
  return result
}
