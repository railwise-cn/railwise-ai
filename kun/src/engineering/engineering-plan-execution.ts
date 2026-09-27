import { z } from 'zod'
import type { EngineeringContextSnapshotV1, EngineeringPlanStepV1, EngineeringRunPlanV1 } from '../contracts/engineering-ai.js'
import { EngineeringPlanParametersV1 } from '../contracts/engineering-ai.js'
import { engineeringPlanToolRisk } from './engineering-plan-tools.js'

type Step = EngineeringPlanStepV1
type Context = EngineeringContextSnapshotV1
type Parameters = NonNullable<Step['parameters']>
const id = z.string().min(1).max(200)
const revision = z.number().int().positive()
const network = z.object({ networkId: id, expectedRevision: revision, method: z.string().min(1).max(100).optional() }).strict()
const report = z.object({ projectId: id, expectedRevision: revision, datasetId: id.optional(), analysisId: id.optional(), adjustmentIds: z.array(id).min(1).max(200).optional(), deformationIds: z.array(id).min(1).max(200).optional() }).strict().refine(value => Boolean(value.datasetId || value.adjustmentIds?.length || value.deformationIds?.length), 'select delivery inputs')
const definitions: Record<string, { schema: z.ZodType; outputs: string[]; reversibility: NonNullable<Step['reversibility']> }> = {
  survey_network_validate: { schema: z.object({ networkId: id, expectedRevision: revision }).strict(), outputs: ['network-validation'], reversibility: 'revisioned-write' },
  survey_adjustment_read: { schema: z.object({ networkId: id, adjustmentId: id.optional() }).strict(), outputs: ['existing-adjustment-evidence'], reversibility: 'read-only' },
  monitoring_data_first_check: { schema: z.object({ datasetId: id, expectedRevision: revision }).strict(), outputs: ['dataset-validation'], reversibility: 'revisioned-write' },
  deformation_rate: { schema: z.object({ projectId: id, datasetId: id, expectedRevision: revision }).strict(), outputs: ['deterministic-analysis'], reversibility: 'append-only' },
  chart_generator: { schema: z.object({ analysisId: id, chartType: z.enum(['trend']).optional() }).strict(), outputs: ['chart-svg'], reversibility: 'append-only' },
  report_export: { schema: report, outputs: ['candidate-docx', 'candidate-pdf', 'evidence-xlsx'], reversibility: 'append-only' },
  excel_export: { schema: report, outputs: ['candidate-docx', 'candidate-pdf', 'evidence-xlsx'], reversibility: 'append-only' },
  standard_query: { schema: z.object({ source: z.string().min(1).max(4000) }).strict(), outputs: ['citation-placeholder'], reversibility: 'read-only' },
  tool_norm_cite: { schema: z.object({ source: z.string().min(1).max(4000) }).strict(), outputs: ['citation-placeholder'], reversibility: 'read-only' }
}
for (const tool of ['survey_calculator', 'control_network', 'cpiii_adjustment', 'coord_transform', 'distance_calculator', 'angle_convert']) definitions[tool] = { schema: network, outputs: ['adjustment-run', 'deterministic-adjustment-evidence'], reversibility: 'append-only' }
export const planToolName = (name: string): string => name.startsWith('railwise.') ? name.slice(9) : name
const definition = (tool: string) => engineeringPlanToolRisk(tool) ? definitions[planToolName(tool)] : undefined

/** Compile exact literals and explicit result bindings; never select the first of several inputs. */
export function compilePlanSteps(steps: Step[], context: Context): Step[] {
  const net = context.surveyNetworks.length === 1 ? context.surveyNetworks[0] : undefined
  const dataset = context.datasets.length === 1 ? context.datasets[0] : undefined
  const previous: Step[] = []
  return steps.map(step => {
    const def = definition(step.tool)
    if (!def) throw new Error(`tool is not allowlisted: ${step.tool}`)
    const parameters: Parameters = { ...step.parameters }
    const bindings = [...step.parameterBindings ?? []]
    const bind = (parameter: string, source: Step | undefined, output: NonNullable<Step['parameterBindings']>[number]['output'], asArray = false): boolean => {
      if (!source) return false
      bindings.push({ parameter, stepId: source.id, output, ...(asArray ? { asArray: true } : {}) }); return true
    }
    const prior = (tool: string): Step | undefined => [...previous].reverse().find(item => planToolName(item.tool) === tool)
    const priorAdjustment = [...previous].reverse().find(item => definition(item.tool)?.outputs.includes('adjustment-run'))
    if (step.parameters === undefined) {
      const tool = planToolName(step.tool)
      if (tool.startsWith('survey_') || definition(tool)?.outputs.includes('adjustment-run')) {
        if (net) parameters.networkId = net.id
        if (tool === 'survey_adjustment_read') bind('adjustmentId', priorAdjustment, 'run.id')
        if (tool !== 'survey_adjustment_read') {
          if (!bind('expectedRevision', prior('survey_network_validate'), 'network.revision') && net) parameters.expectedRevision = net.revision
        }
      } else if (tool === 'monitoring_data_first_check' || tool === 'deformation_rate') {
        if (dataset) parameters.datasetId = dataset.id
        if (tool === 'deformation_rate') parameters.projectId = context.projectId
        if (!bind('expectedRevision', prior('monitoring_data_first_check'), 'dataset.revision') && dataset) parameters.expectedRevision = dataset.revision
      } else if (tool === 'chart_generator') {
        bind('analysisId', prior('deformation_rate'), 'analysis.id')
        parameters.chartType = 'trend'
      } else if (tool === 'report_export' || tool === 'excel_export') {
        parameters.projectId = context.projectId
        if (priorAdjustment) {
          parameters.expectedRevision = context.projectRevision
          bind('adjustmentIds', priorAdjustment, 'run.id', true)
        } else if (dataset) {
          parameters.datasetId = dataset.id
          if (!bind('expectedRevision', prior('monitoring_data_first_check'), 'dataset.revision')) parameters.expectedRevision = dataset.revision
          bind('analysisId', prior('deformation_rate'), 'analysis.id')
        }
      }
    }
    const compiled = { ...step, parameters, parameterBindings: bindings, expectedOutputs: def.outputs, reversibility: def.reversibility }
    previous.push(compiled)
    return compiled
  })
}

const sampleOutputs: Record<NonNullable<Step['parameterBindings']>[number]['output'], string | number> = {
  'network.id': 'network-output', 'network.revision': 1, 'dataset.id': 'dataset-output', 'dataset.revision': 1, 'analysis.id': 'analysis-output', 'run.id': 'run-output'
}
const outputTools: Record<string, string[]> = {
  'network.id': ['survey_network_validate'], 'network.revision': ['survey_network_validate'],
  'dataset.id': ['monitoring_data_first_check'], 'dataset.revision': ['monitoring_data_first_check'],
  'analysis.id': ['deformation_rate'], 'run.id': ['survey_calculator', 'control_network', 'cpiii_adjustment', 'coord_transform', 'distance_calculator', 'angle_convert', 'survey_adjustment_read', 'report_export', 'excel_export']
}

export function planParameterIssues(steps: Step[]): string[] {
  const issues: string[] = []
  for (const step of steps) {
    const def = definition(step.tool)
    if (!def || !step.parameters || !step.parameterBindings || !step.expectedOutputs || step.reversibility !== def.reversibility || JSON.stringify(step.expectedOutputs) !== JSON.stringify(def.outputs)) { issues.push(`${step.id}: review details missing or outdated`); continue }
    const args: Record<string, unknown> = { ...step.parameters }
    const ancestors = new Set<string>()
    const visit = (id: string): void => { if (ancestors.has(id)) return; ancestors.add(id); steps.find(item => item.id === id)?.dependsOn.forEach(visit) }
    step.dependsOn.forEach(visit)
    for (const binding of step.parameterBindings) {
      const source = steps.find(item => item.id === binding.stepId)
      if (Object.prototype.hasOwnProperty.call(args, binding.parameter) || !source || !ancestors.has(binding.stepId) || !outputTools[binding.output]?.includes(planToolName(source.tool))) issues.push(`${step.id}: invalid parameter binding ${binding.parameter}`)
      args[binding.parameter] = binding.asArray ? [sampleOutputs[binding.output]] : sampleOutputs[binding.output]
    }
    if (!def.schema.safeParse(args).success) issues.push(`${step.id}: required tool parameters are missing or invalid`)
  }
  return issues
}

export function assertPlanParameterScope(parameters: Record<string, unknown>, context: Context): void {
  if (parameters.projectId !== undefined && parameters.projectId !== context.projectId) throw new Error('plan parameters refer to another project')
  for (const [key, records] of [['networkId', context.surveyNetworks], ['datasetId', context.datasets], ['analysisId', context.analyses]] as const) {
    if (parameters[key] !== undefined && !records.some(item => item.id === parameters[key])) throw new Error(`plan ${key} is not in the current project context`)
  }
  if (parameters.adjustmentIds !== undefined && (!Array.isArray(parameters.adjustmentIds) || parameters.adjustmentIds.some(id => !context.surveyAdjustments.some(item => item.id === id && item.sourceAdmission.status === 'current-admissible')))) throw new Error('plan adjustment inputs are not currently admissible in this project')
  if (parameters.adjustmentId !== undefined && !context.surveyAdjustments.some(item => item.id === parameters.adjustmentId && item.networkId === parameters.networkId)) throw new Error('plan adjustment is not in the selected network')
  // The bounded context has no deformation identifiers yet. Such requests need
  // explicit context support before they can cross the execution boundary.
  if (parameters.deformationIds !== undefined) throw new Error('deformation selection is not available in typed plan context')
}

export function resolvedStepParameters(step: Step, resultForStep: (id: string) => Record<string, unknown> | null): Parameters {
  const parameters: Record<string, unknown> = { ...step.parameters }
  for (const binding of step.parameterBindings ?? []) {
    const result = resultForStep(binding.stepId)
    const value = result?.[binding.output]
    if (value === undefined) throw new Error(`dependency result is unavailable: ${binding.stepId}.${binding.output}`)
    parameters[binding.parameter] = binding.asArray ? [value] : value
  }
  const def = definition(step.tool)
  if (!def?.schema.safeParse(parameters).success) throw new Error(`invalid approved parameters for ${step.id}`)
  return EngineeringPlanParametersV1.parse(parameters)
}

/** Retain only handles for dependency binding, never raw observations or full outputs. */
export function planResultHandles(output: unknown): Record<string, unknown> {
  const handles: Record<string, unknown> = {}
  if (!output || typeof output !== 'object') return handles
  const record = output as Record<string, unknown>
  for (const key of Object.keys(sampleOutputs)) {
    const [object, field] = key.split('.')
    const parent = record[object!]
    const value = parent && typeof parent === 'object' ? (parent as Record<string, unknown>)[field!] : undefined
    if ((field === 'id' && typeof value === 'string') || (field === 'revision' && typeof value === 'number' && Number.isInteger(value) && value > 0)) handles[key] = value
  }
  return handles
}

export function assertPlanReviewable(plan: EngineeringRunPlanV1): void {
  const issues = planParameterIssues(plan.steps)
  if (issues.length) throw new Error(`engineering_plan_incomplete: ${issues.join('; ')}`)
}
