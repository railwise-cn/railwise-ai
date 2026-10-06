import type { FlowNodeAdapter } from './executor.js'
import { restrictedCodeAdapter } from './restricted-code.js'
import type { RuntimeFlowAdapterDependencies } from './runtime-adapters.js'
import { buildRuntimeFlowAdapters } from './runtime-adapters.js'

export function buildCoreFlowAdapters(overrides: ReadonlyMap<string, FlowNodeAdapter> = new Map(), runtime?: RuntimeFlowAdapterDependencies): Map<string, FlowNodeAdapter> {
  const adapters = new Map<string, FlowNodeAdapter>()
  for (const type of ['manual_trigger', 'schedule_trigger', 'webhook_trigger', 'merge', 'parallel', 'archive', 'publish']) adapters.set(type, passThrough)
  for (const type of ['railwise.monitoring_data_first_check', 'railwise.deformation_rate', 'railwise.chart_generator', 'railwise.report_export', 'railwise.archive']) adapters.set(type, async () => { throw new Error('此历史专业流程尚未接入计算服务；请使用内业处理和草稿复核流程。') })
  adapters.set('condition', async ({ node, input }) => ({ kind: 'output', output: { branch: evaluateCondition(input, node.config), value: input } }))
  adapters.set('switch', async ({ node, input }) => ({ kind: 'output', output: { branch: switchBranch(input, node.config), value: input } }))
  adapters.set('loop', async ({ node, input }) => ({ kind: 'output', output: { value: input, maxIterations: Number(node.config.maxIterations) } }))
  adapters.set('human_approval', async () => ({ kind: 'wait', reason: 'approval' }))
  adapters.set('alert_confirmation', async () => ({ kind: 'wait', reason: 'approval' }))
  adapters.set('restricted_code', restrictedCodeAdapter)
  if (runtime) for (const [key, adapter] of buildRuntimeFlowAdapters(runtime)) adapters.set(key, adapter)
  for (const [key, adapter] of overrides) adapters.set(key, adapter)
  return adapters
}
const passThrough: FlowNodeAdapter = async ({ input }) => ({ kind: 'output', output: input })
function evaluateCondition(input: unknown, config: Record<string, unknown>): boolean { const value = property(input, String(config.path ?? '')); switch (config.operator) { case 'equals': return value === config.value; case 'not_equals': return value !== config.value; case 'exists': return value !== undefined && value !== null; case 'truthy': return Boolean(value); default: return Boolean(value) } }
function switchBranch(input: unknown, config: Record<string, unknown>): string { const value = property(input, String(config.path ?? '')); const cases = Array.isArray(config.cases) ? config.cases : []; const match = cases.find((entry) => entry && typeof entry === 'object' && (entry as { value?: unknown }).value === value) as { branch?: unknown } | undefined; return typeof match?.branch === 'string' ? match.branch : String(config.defaultBranch ?? 'default') }
function property(value: unknown, path: string): unknown { return path.split('.').filter(Boolean).reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value) }
