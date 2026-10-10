import { z } from 'zod'
import type { EngineeringContextSnapshotV1, EngineeringPlanStepV1, EngineeringRunPlanV1, EngineeringPlanParameterIssueV1 } from '../contracts/engineering-ai.js'
import { EngineeringPlanParametersV1 } from '../contracts/engineering-ai.js'
import { engineeringPlanToolRisk, surveyAdjustmentToolNetworks } from './engineering-plan-tools.js'
import { AdjustmentRequestV1, SurveyNetworkReimportRequest } from '../contracts/survey.js'

type Step = EngineeringPlanStepV1
type Context = EngineeringContextSnapshotV1
type Parameters = NonNullable<Step['parameters']>
const id = z.string().min(1).max(200)
const revision = z.number().int().positive()
const network = z.object({ networkId: id, expectedRevision: revision, method: AdjustmentRequestV1.shape.method }).strict()
const report = z.object({ projectId: id, expectedRevision: revision, datasetId: id.optional(), analysisId: id.optional(), adjustmentIds: z.array(id).min(1).max(200).optional(), deformationIds: z.array(id).min(1).max(200).optional() }).strict().refine(value => Boolean(value.datasetId || value.adjustmentIds?.length || value.deformationIds?.length), 'select delivery inputs')
const definitions: Record<string, { schema: z.ZodType; outputs: string[]; reversibility: NonNullable<Step['reversibility']> }> = {
  survey_network_reimport: { schema: SurveyNetworkReimportRequest.omit({ idempotencyKey: true }), outputs: ['prepared-network'], reversibility: 'append-only' },
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

/** Advertise the same literals checked at approval. Required values can also be bound to predecessor outputs. */
export function planToolParameterSchema(tool: string): Record<string, unknown> {
  const def = definition(tool)
  if (!def) throw new Error('Unknown engineering plan tool')
  const { $schema: _schema, required, ...schema } = z.toJSONSchema(def.schema)
  const delivery = ['report_export', 'excel_export'].includes(planToolName(tool))
  const networkTypes = surveyAdjustmentToolNetworks[planToolName(tool)]
  return { ...schema, description: `Required after resolving predecessor bindings: ${(required as string[] | undefined)?.join(', ') || 'none'}.${networkTypes ? ` Supported network types only: ${networkTypes.join(', ')}. Select the matching tool; method is a solver method, not a network type.` : ''}${delivery ? ' Also select datasetId or nonempty adjustmentIds. expectedRevision is the project revision for survey-only exports, or the dataset revision for monitoring exports. One call generates DOCX, PDF and XLSX; no per-format or manifest operation.' : ''}` }
}

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
    const hasBinding = (parameter: string): boolean => bindings.some(binding => binding.parameter === parameter)
    const setDefault = (parameter: keyof Parameters, value: Parameters[keyof Parameters]): void => {
      if (!Object.prototype.hasOwnProperty.call(parameters, parameter) && !hasBinding(parameter)) parameters[parameter] = value
    }
    const bind = (parameter: string, source: Step | undefined, output: NonNullable<Step['parameterBindings']>[number]['output'], asArray = false): boolean => {
      // Preserve caller bindings for validation, including invalid or duplicate ones.
      if (hasBinding(parameter)) return true
      if (!source) return false
      bindings.push({ parameter, stepId: source.id, output, ...(asArray ? { asArray: true } : {}) }); return true
    }
    const prior = (tool: string): Step | undefined => [...previous].reverse().find(item => planToolName(item.tool) === tool)
    const priorAdjustment = [...previous].reverse().find(item => definition(item.tool)?.outputs.includes('adjustment-run'))
    if (step.parameters === undefined) {
      const tool = planToolName(step.tool)
      if (tool.startsWith('survey_') || definition(tool)?.outputs.includes('adjustment-run')) {
        if (net) setDefault('networkId', net.id)
        if (tool === 'survey_adjustment_read') bind('adjustmentId', priorAdjustment, 'run.id')
        if (tool !== 'survey_adjustment_read') {
          if (!bind('expectedRevision', prior('survey_network_validate'), 'network.revision') && net) setDefault('expectedRevision', net.revision)
        }
      } else if (tool === 'monitoring_data_first_check' || tool === 'deformation_rate') {
        if (dataset) setDefault('datasetId', dataset.id)
        if (tool === 'deformation_rate') setDefault('projectId', context.projectId)
        if (!bind('expectedRevision', prior('monitoring_data_first_check'), 'dataset.revision') && dataset) setDefault('expectedRevision', dataset.revision)
      } else if (tool === 'chart_generator') {
        bind('analysisId', prior('deformation_rate'), 'analysis.id')
        setDefault('chartType', 'trend')
      } else if (tool === 'report_export' || tool === 'excel_export') {
        setDefault('projectId', context.projectId)
        if (priorAdjustment) {
          setDefault('expectedRevision', context.projectRevision)
          bind('adjustmentIds', priorAdjustment, 'run.id', true)
        } else if (dataset) {
          setDefault('datasetId', dataset.id)
          if (!bind('expectedRevision', prior('monitoring_data_first_check'), 'dataset.revision')) setDefault('expectedRevision', dataset.revision)
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
  'network.id': ['survey_network_validate', 'survey_network_reimport'], 'network.revision': ['survey_network_validate', 'survey_network_reimport'],
  'dataset.id': ['monitoring_data_first_check'], 'dataset.revision': ['monitoring_data_first_check'],
  'analysis.id': ['deformation_rate'], 'run.id': ['survey_calculator', 'control_network', 'cpiii_adjustment', 'coord_transform', 'distance_calculator', 'angle_convert', 'survey_adjustment_read', 'report_export', 'excel_export']
}

export function planParameterDiagnostics(steps: Step[], context?: Context): EngineeringPlanParameterIssueV1[] {
  const issues: EngineeringPlanParameterIssueV1[] = []
  for (const step of steps) {
    const def = definition(step.tool)
    if (!def || !step.parameters || !step.parameterBindings || !step.expectedOutputs || step.reversibility !== def.reversibility || JSON.stringify(step.expectedOutputs) !== JSON.stringify(def.outputs)) { issues.push({ stepId: step.id, code: 'review-details', fields: [] }); continue }
    const args: Record<string, unknown> = { ...step.parameters }
    const ancestors = new Set<string>()
    const visit = (id: string): void => { if (ancestors.has(id)) return; ancestors.add(id); steps.find(item => item.id === id)?.dependsOn.forEach(visit) }
    step.dependsOn.forEach(visit)
    for (const binding of step.parameterBindings) {
      const source = steps.find(item => item.id === binding.stepId)
      if (Object.prototype.hasOwnProperty.call(args, binding.parameter) || !source || !ancestors.has(binding.stepId) || !outputTools[binding.output]?.includes(planToolName(source.tool))) issues.push({ stepId: step.id, code: 'invalid-binding', fields: [binding.parameter] })
      args[binding.parameter] = binding.asArray ? [sampleOutputs[binding.output]] : sampleOutputs[binding.output]
    }
    const parsed = def.schema.safeParse(args)
    if (!parsed.success) issues.push({ stepId: step.id, code: 'invalid-parameters', fields: [...new Set(parsed.error.issues.flatMap(issue => issue.code === 'unrecognized_keys' ? issue.keys : issue.path.length ? [String(issue.path[0])] : ['inputs']))].slice(0, 200) })
    if (context) {
      const selectedNetwork = (source: Step, visited = new Set<string>()): { id: string; networkType: string } | undefined => {
        if (visited.has(source.id)) return undefined
        visited.add(source.id)
        if (source.parameters?.networkId !== undefined) return context.surveyNetworks.find(item => item.id === source.parameters!.networkId)
        const binding = source.parameterBindings?.find(item => item.parameter === 'networkId' && item.output === 'network.id' && !item.asArray)
        const parent = binding && steps.find(item => item.id === binding.stepId)
        if (parent && planToolName(parent.tool) === 'survey_network_reimport' && typeof parent.parameters?.networkType === 'string' && typeof parent.parameters.sourceNetworkId === 'string') return { id: parent.parameters.sourceNetworkId, networkType: parent.parameters.networkType }
        return parent && planToolName(parent.tool) === 'survey_network_validate' ? selectedNetwork(parent, visited) : undefined
      }
      const allowed = surveyAdjustmentToolNetworks[planToolName(step.tool)]
      const selected = allowed && selectedNetwork(step)
      if (allowed && (!selected || !allowed.includes(selected.networkType))) issues.push({ stepId: step.id, code: 'invalid-parameters', fields: ['networkId'] })
      if (planToolName(step.tool) === 'survey_network_reimport') {
        const source = context.surveyNetworks.find(item => item.id === step.parameters?.sourceNetworkId)
        if (!source || source.revision !== step.parameters.sourceNetworkRevision || source.inputAttachmentHash !== step.parameters.sourceSha256 || step.parameters.projectId !== context.projectId || step.parameters.expectedRevision !== context.projectRevision) issues.push({ stepId: step.id, code: 'invalid-parameters', fields: ['sourceNetworkId'] })
      }
    }
  }
  return issues
}

export function planParameterIssues(steps: Step[], context?: Context): string[] {
  return planParameterDiagnostics(steps, context).map(issue => `${issue.stepId}: ${issue.code === 'review-details' ? 'review details missing or outdated' : issue.code === 'invalid-binding' ? 'invalid parameter binding' : 'required tool parameters or selected network capability are missing or invalid'}${issue.fields.length ? ` (${issue.fields.join(', ')})` : ''}`)
}

export function assertPlanParameterScope(parameters: Record<string, unknown>, context: Context): void {
  if (parameters.projectId !== undefined && parameters.projectId !== context.projectId) throw new Error('plan parameters refer to another project')
  if (parameters.sourceNetworkId !== undefined && !context.surveyNetworks.some(item => item.id === parameters.sourceNetworkId && item.revision === parameters.sourceNetworkRevision && item.inputAttachmentHash === parameters.sourceSha256)) throw new Error('plan source reference is stale or outside the current project')
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

export function assertPlanReviewable(plan: EngineeringRunPlanV1, context?: Context): void {
  const issues = planParameterIssues(plan.steps, context)
  if (issues.length) throw new Error(`engineering_plan_incomplete: ${issues.join('; ')}`)
}
