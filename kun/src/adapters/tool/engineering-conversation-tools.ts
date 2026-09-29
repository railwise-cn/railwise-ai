import { EngineeringEvidenceSelectionV1, EngineeringPlanParametersV1, EngineeringPlanParameterBindingV1, EngineeringProjectSuggestionRequestV1 } from '../../contracts/engineering-ai.js'
import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { ThreadStore } from '../../ports/thread-store.js'
import type { EngineeringAiOrchestrator } from '../../engineering/engineering-ai-orchestrator.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import { engineeringPlanToolRisks } from '../../engineering/engineering-plan-tools.js'
import { SurveyEvidenceReferenceV1 } from '../../contracts/survey-evidence-reference.js'
import type { SurveyEvidenceReader } from '../../engineering/survey-evidence-reader.js'
import { planParameterDiagnostics, planToolParameterSchema } from '../../engineering/engineering-plan-execution.js'

const operationRisks = engineeringPlanToolRisks
const operationNames = Object.keys(operationRisks) as [keyof typeof operationRisks, ...Array<keyof typeof operationRisks>]
const selectionSchema = EngineeringEvidenceSelectionV1
const draftSchema = z.object({
  goal: z.string().trim().min(1).max(4_000),
  steps: z.array(z.object({ tool: z.enum(operationNames), title: z.string().min(1).max(200), parameters: EngineeringPlanParametersV1.optional(), parameterBindings: z.array(EngineeringPlanParameterBindingV1).max(32).optional() }).strict()).min(1).max(32)
}).strict()

const draftInputSchema = z.toJSONSchema(draftSchema)
// Parameters may be supplied as literals or bindings; actual required-field
// checks run after compilation. Unknown literal fields remain disallowed.
const planStepSchema = (draftInputSchema.properties!.steps as { items: Record<string, unknown> }).items
;(draftInputSchema.properties!.steps as { items: unknown }).items = {
  anyOf: operationNames.map(tool => ({ ...planStepSchema, properties: {
    ...(planStepSchema.properties as Record<string, unknown>), tool: { type: 'string', const: tool }, parameters: planToolParameterSchema(tool)
  } }))
}

function draftFingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : item
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

export function buildEngineeringConversationTools(
  threadStore: ThreadStore,
  getOrchestrator: () => EngineeringAiOrchestrator,
  evidenceReader?: SurveyEvidenceReader
): CapabilityToolProvider {
  const projectForThread = async (threadId: string): Promise<string> => {
    const thread = await threadStore.get(threadId)
    if (thread?.domain !== 'engineering' || !thread.projectId) throw new Error('an engineering project thread is required')
    return thread.projectId
  }
  return {
    id: 'engineering-conversation', kind: 'gui', enabled: true, available: true,
    tools: [
      ...(evidenceReader ? [LocalToolHost.defineTool({
        name: 'survey_read_evidence',
        shouldAdvertise: context => context.allowedToolNames?.includes('survey_read_evidence') === true,
        description: 'Read the exact selected typed Survey evidence reference. Copy its kind, IDs, revisions, hashes and selector. No latest fallback, new calculation, write, verification attempt or approval. Existing strict readers may replay saved calculations for integrity. Nested selectors use exact own JSON fields and array indices; object rows require identity fields. Output-limit returns selector-required, never a partial result. Trial and caller-declared evidence remain unauthenticated; receipt reads are historical, not fresh verification.',
        // Zod emits a bare oneOf for this object-only union. Model providers
        // require an explicit object root even though each branch has one.
        inputSchema: { ...z.toJSONSchema(SurveyEvidenceReferenceV1), type: 'object' }, policy: 'auto',
        execute: async (args, context) => {
          const thread = await threadStore.get(context.threadId)
          if (thread?.domain !== 'engineering' || !thread.projectId) throw new Error('an engineering project thread is required')
          if (thread.workspace && thread.workspace !== context.workspace) throw new Error('thread workspace does not match the tool workspace')
          return { output: evidenceReader.read(args, { projectId: thread.projectId, workspace: context.workspace }) }
        }
      })] : []),
      LocalToolHost.defineTool({
        name: 'survey_read_context',
        shouldAdvertise: (context) => context.allowedToolNames?.includes('survey_read_context') === true,
        description: 'Read the current Survey project summary and existing deterministic results, residuals, precision, units and evidence. Does not calculate, import or write anything. Results are bounded and project-scoped. Pass exact IDs from selected evidence; revision and hash selectors reject stale evidence. observationId and sourceRecordId read a specific record even beyond the first 20 rows. manifestId or runId plus outputSha256 reads recorded artifact metadata, not a new file-integrity check.',
        inputSchema: z.toJSONSchema(selectionSchema),
        policy: 'auto',
        execute: async (args, context) => ({ output: await getOrchestrator().readConversationContext(context.threadId, await projectForThread(context.threadId), selectionSchema.parse(args)) })
      }),
      LocalToolHost.defineTool({
        name: 'survey_request_plan',
        shouldAdvertise: (context) => context.allowedToolNames?.includes('survey_request_plan') === true,
        description: 'Propose a typed Survey execution plan ONLY for requested computation, analysis or deliverables. Use the per-tool parameter fields below, with exact IDs and revisions from survey_read_context. Required values can be literals or bindings. Steps get IDs step-1, step-2, etc.; bind expectedRevision to step-1 network.revision, or adjustmentIds to step-2 run.id with asArray:true. report_export or excel_export produces all three draft files (DOCX, PDF, XLSX) in one step; neither accepts format or draft. The manifest is created separately in the human Review UI, not by an export step. Include only requested operations in dependency order. Runtime fixes risk, outputs and reversibility. If parameterIssues are returned, correct them and request a new draft in this turn; the previous draft remains blocked. No work executes until UI approval. Never request or return approval tokens.',
        inputSchema: draftInputSchema,
        policy: 'auto',
        execute: async (args, context) => {
          const draft = draftSchema.parse(args)
          const projectId = await projectForThread(context.threadId)
          const { plan } = await getOrchestrator().createPlan({
            threadId: context.threadId, projectId, goal: draft.goal,
            steps: draft.steps.map((step, index) => ({
              id: `step-${index + 1}`, title: step.title, tool: step.tool, risk: operationRisks[step.tool],
              parameters: step.parameters, parameterBindings: step.parameterBindings,
              dependsOn: index ? [`step-${index}`] : [], inputHash: 'server-resolved', approval: 'pending'
            })),
            idempotencyKey: `survey-conversation-plan:${context.turnId}:${draftFingerprint(draft)}`
          }, { conversationTurnId: context.turnId })
          const parameterIssues = planParameterDiagnostics(plan.steps)
          return { output: { plan, parameterIssues, readyForApproval: parameterIssues.length === 0, executed: false, approvalRequired: true }, ...(parameterIssues.length ? { isError: true } : {}) }
        }
      }),
      LocalToolHost.defineTool({
        name: 'survey_propose_project_change',
        shouldAdvertise: context => context.allowedToolNames?.includes('survey_propose_project_change') === true,
        description: 'Propose requested project metadata or parameter changes for explicit human confirmation. Show the reason. Does not apply changes, calculate results or transform coordinates. Nested objects replace their corresponding project settings; include fields that must be retained. Existing observations and results remain unchanged. Never request confirmation tokens.',
        inputSchema: z.toJSONSchema(EngineeringProjectSuggestionRequestV1),
        policy: 'auto',
        execute: async (args, context) => ({ output: { suggestion: await getOrchestrator().proposeProjectChange(context.threadId, context.turnId, args), applied: false, confirmationRequired: true } })
      })
    ]
  }
}
