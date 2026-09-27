import { z } from 'zod'
import * as C from '@shared/survey-quality-workflow'
import { SurveyQualityWorkspacePlanReadV1, SurveyQualityWorkspaceVerificationV1, SurveyQualityRecordV1, runtimeSurveyQualityPath } from '@shared/survey-quality-workspace'
import { parseQualityPlan, parseQualityRecord, type QualityBinding, type QualityPlan, type QualityRecord, type QualityRecordSummary } from './survey-quality-client'
import { rendererRuntimeClient } from './runtime-client'

export type QualityWorkflow = z.infer<typeof C.SurveyQualityWorkflowReadV1>
export type WorkflowEvent = z.infer<typeof C.SurveyQualityWorkflowAppendV1>['event']
export type WorkflowBinding = z.infer<typeof C.SurveyQualityWorkflowBindingV1>
export type WorkflowContext = { binding: QualityBinding; plan: QualityPlan; record: QualityRecord }
export type WorkflowSourcePlan = { binding: QualityBinding; plan: QualityPlan }
export type WorkflowHistory = z.infer<typeof C.SurveyQualityWorkflowListV1>
export type WorkflowFailure = 'stale' | 'integrity' | 'source-changed' | 'conflict' | 'limit' | 'invalid-transition' | 'invalid-reference' | 'validation' | 'unavailable' | 'invalid-response' | 'request-failed'
export class QualityWorkflowRequestError extends Error { constructor(readonly reason: WorkflowFailure) { super(reason) } }
const invalid = (): never => { throw new QualityWorkflowRequestError('invalid-response') }
const bytes = (value: string): number => new TextEncoder().encode(value).byteLength
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().filter(key => object[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}` }
  return JSON.stringify(value)
}
const equal = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)
async function sha(value: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('') }
const digest = (value: unknown): Promise<string> => sha(canonical(value))
const genesis = '0'.repeat(64)

async function request(path: string, method = 'GET', body?: unknown, maxBytes = C.QUALITY_WORKFLOW_LIMITS.recordBytes): Promise<unknown> {
  let response: Awaited<ReturnType<typeof rendererRuntimeClient.runtimeRequest>>
  try { response = await rendererRuntimeClient.runtimeRequest(path, method, body === undefined ? undefined : JSON.stringify(body)) }
  catch { throw new QualityWorkflowRequestError('request-failed') }
  if (!response.ok) {
    if (bytes(response.body) < 16384) {
      try {
        const code = (C.parseQualityWorkflowJson(response.body) as { code?: unknown }).code
        const reason = typeof code === 'string' && code.startsWith('quality_workflow_') ? code.slice('quality_workflow_'.length).replaceAll('_', '-') : ''
        const known: WorkflowFailure[] = ['stale', 'integrity', 'source-changed', 'conflict', 'limit', 'invalid-transition', 'invalid-reference', 'validation', 'unavailable']
        if (known.includes(reason as WorkflowFailure)) throw new QualityWorkflowRequestError(reason as WorkflowFailure)
      } catch (error) { if (error instanceof QualityWorkflowRequestError) throw error }
    }
    throw new QualityWorkflowRequestError([404, 503].includes(response.status) ? 'unavailable' : response.status === 409 ? 'stale' : 'request-failed')
  }
  if (bytes(response.body) > maxBytes) return invalid()
  try { return C.parseQualityWorkflowJson(response.body) } catch { return invalid() }
}

export function workflowSource(context: WorkflowContext): z.infer<typeof C.SurveyQualityWorkflowSourceV1> {
  return { planId: context.plan.plan.id, recordId: context.record.record.id, expectedRetentionHeadHash: context.record.verification.headHash }
}
export async function workflowBinding(context: WorkflowContext): Promise<WorkflowBinding> {
  const { binding, plan, record } = context
  parseQualityPlan(plan, binding); parseQualityRecord(record, binding, plan)
  if (record.record.planHash !== await digest(plan.plan)) return invalid()
  return {
    projectId: binding.projectId, projectRevision: binding.projectRevision, projectBindingHash: plan.plan.projectBindingHash,
    planId: plan.plan.id, recordId: record.record.id, retentionHeadHash: record.verification.headHash,
    planHash: record.record.planHash, recordHash: await digest(record.record),
    artifactId: plan.artifact.id, artifactHash: plan.artifact.bundleHash, manifestId: plan.plan.manifestId, manifestHash: plan.plan.manifestHash
  }
}
function matchingSource(binding: WorkflowBinding, source: z.infer<typeof C.SurveyQualityWorkflowSourceV1>, origin: WorkflowBinding): boolean {
  return binding.projectId === origin.projectId && binding.projectRevision === origin.projectRevision && binding.projectBindingHash === origin.projectBindingHash
    && binding.planId === source.planId && binding.recordId === source.recordId && binding.retentionHeadHash === source.expectedRetentionHeadHash
}

export async function parseQualityWorkflow(value: unknown, context: WorkflowContext, expectedId?: string): Promise<QualityWorkflow> {
  const parsed = C.SurveyQualityWorkflowReadV1.safeParse(value)
  if (!parsed.success || bytes(JSON.stringify(parsed.data)) > C.QUALITY_WORKFLOW_LIMITS.recordBytes) return invalid()
  const result = parsed.data, origin = await workflowBinding(context), root = result.workflow
  if (!equal(root.binding, origin) || root.projectId !== origin.projectId || expectedId !== undefined && root.id !== expectedId
    || !equal({ planId: root.request.planId, recordId: root.request.recordId, expectedRetentionHeadHash: root.request.expectedRetentionHeadHash }, workflowSource(context))
    || root.request.expectedProjectRevision !== origin.projectRevision) return invalid()
  let previousHash = genesis, previousTime = Date.parse(root.createdAt)
  const ids = new Set<string>(), keys = new Set<string>([root.request.idempotencyKey]), checks = new Set<string>(), corrections = new Set<string>()
  const issues = new Map<string, { resolved: boolean; correctionId?: string; artifactHash?: string }>()
  for (const [index, entry] of result.entries.entries()) {
    const event = entry.event, declared = entry.request.event, actual = event.event
    const { thisHash, ...unsigned } = event
    if (ids.has(event.id) || keys.has(entry.request.idempotencyKey) || event.sequence !== index + 1 || event.previousHash !== previousHash
      || entry.request.expectedHeadHash !== previousHash || event.projectId !== origin.projectId || event.artifactSha256 !== origin.artifactHash
      || event.actor.id !== 'survey-quality-workflow' || event.actor.kind !== 'system' || event.stage !== 'declared-workflow'
      || thisHash !== await sha(JSON.stringify(unsigned)) || Date.parse(event.occurredAt) < previousTime || actual.kind !== declared.kind
      || !matchingSource(entry.evidenceBinding, declared.evidence, origin)) return invalid()
    if (declared.evidence.planId === origin.planId && declared.evidence.recordId === origin.recordId) {
      const member = context.plan.artifact.members.find(item => item.id === declared.evidence.memberId)
      if (!equal(entry.evidenceBinding, origin) || !member || actual.evidenceSha256 !== member.sha256) return invalid()
    }
    if (entry.targetBinding?.planId === origin.planId && entry.targetBinding.recordId === origin.recordId && !equal(entry.targetBinding, origin)) return invalid()
    if (declared.kind === 'check' && actual.kind === 'check') {
      if (actual.checkId !== declared.checkId || actual.outcome !== declared.outcome || actual.rule !== undefined || checks.has(actual.checkId) || entry.targetBinding !== null) return invalid()
      checks.add(actual.checkId)
    } else if (declared.kind === 'issue-opened' && actual.kind === 'issue-opened') {
      if (actual.issueId !== declared.issueId || actual.checkId !== declared.checkId || !checks.has(actual.checkId) || issues.has(actual.issueId) || entry.targetBinding !== null) return invalid()
      issues.set(actual.issueId, { resolved: false })
    } else if (declared.kind === 'correction-recorded' && actual.kind === 'correction-recorded') {
      const issue = issues.get(actual.issueId)
      if (actual.issueId !== declared.issueId || actual.correctionId !== declared.correctionId || !issue || issue.resolved || corrections.has(actual.correctionId)
        || !entry.targetBinding || !matchingSource(entry.targetBinding, declared.corrected, origin) || actual.correctedArtifactSha256 !== entry.targetBinding.artifactHash || actual.correctedArtifactSha256 === origin.artifactHash) return invalid()
      issue.correctionId = actual.correctionId; issue.artifactHash = actual.correctedArtifactSha256; corrections.add(actual.correctionId)
    } else if (declared.kind === 'issue-rechecked' && actual.kind === 'issue-rechecked') {
      const issue = issues.get(actual.issueId)
      if (actual.issueId !== declared.issueId || actual.correctionId !== declared.correctionId || actual.outcome !== declared.outcome || !issue || issue.resolved
        || issue.correctionId !== actual.correctionId || issue.artifactHash !== actual.recheckedArtifactSha256 || !entry.targetBinding
        || !matchingSource(entry.targetBinding, declared.rechecked, origin) || actual.recheckedArtifactSha256 !== entry.targetBinding.artifactHash) return invalid()
      issue.resolved = actual.outcome === 'resolved'
    } else return invalid()
    previousHash = thisHash; previousTime = Date.parse(event.occurredAt); ids.add(event.id); keys.add(entry.request.idempotencyKey)
  }
  if (result.headHash !== previousHash || result.recordedCheckCount !== checks.size || result.openIssueCount !== [...issues.values()].filter(issue => !issue.resolved).length) return invalid()
  return result
}
export async function createQualityWorkflow(context: WorkflowContext, key: string): Promise<QualityWorkflow> {
  const body = C.SurveyQualityWorkflowCreateV1.parse({ ...workflowSource(context), expectedProjectRevision: context.binding.projectRevision, idempotencyKey: key })
  const result = await parseQualityWorkflow(await request(C.runtimeSurveyQualityWorkflowPath(context.binding.projectId), 'POST', body), context)
  if (!equal(result.workflow.request, body)) return invalid()
  return result
}
export async function readQualityWorkflow(context: WorkflowContext, workflowId: string): Promise<QualityWorkflow> {
  return parseQualityWorkflow(await request(C.runtimeSurveyQualityWorkflowPath(context.binding.projectId, workflowId)), context, workflowId)
}
export async function listQualityWorkflows(context: WorkflowContext, offset = 0): Promise<WorkflowHistory> {
  const parsed = C.SurveyQualityWorkflowListV1.safeParse(await request(`${C.runtimeSurveyQualityWorkflowPath(context.binding.projectId)}?limit=20&offset=${offset}`, 'GET', undefined, C.QUALITY_WORKFLOW_LIMITS.recordBytes * 20 + 16384))
  if (!parsed.success || parsed.data.nextOffset !== null && parsed.data.nextOffset !== offset + parsed.data.workflows.length + parsed.data.unavailable.length) return invalid()
  const ids = [...parsed.data.workflows.map(item => item.workflow.id), ...parsed.data.unavailable.map(item => item.id)]
  if (ids.length > 20 || parsed.data.nextOffset !== null && ids.length === 0 || new Set(ids).size !== ids.length || parsed.data.workflows.some(item => item.workflow.projectId !== context.binding.projectId || item.workflow.binding.projectId !== context.binding.projectId)) return invalid()
  const workflows = []
  for (const item of parsed.data.workflows) if (item.workflow.binding.recordId === context.record.record.id && item.workflow.binding.planId === context.plan.plan.id) workflows.push(await parseQualityWorkflow(item, context))
  return { ...parsed.data, workflows }
}
export async function appendQualityWorkflowEvent(context: WorkflowContext, current: QualityWorkflow, event: WorkflowEvent, key: string, evidenceContext: WorkflowContext, targetContext?: WorkflowContext, stillCurrent: () => boolean = () => true): Promise<QualityWorkflow> {
  const body = C.SurveyQualityWorkflowAppendV1.parse({ expectedHeadHash: current.headHash, idempotencyKey: key, event })
  const evidence = await workflowBinding(evidenceContext), target = targetContext ? await workflowBinding(targetContext) : null
  const member = evidenceContext.plan.artifact.members.find(item => item.id === event.evidence.memberId)
  if (!member || !matchingSource(evidence, event.evidence, await workflowBinding(context))
    || (event.kind === 'correction-recorded' || event.kind === 'issue-rechecked') && (!target || !matchingSource(target, event.kind === 'correction-recorded' ? event.corrected : event.rechecked, evidence))) return invalid()
  if (!stillCurrent()) throw new QualityWorkflowRequestError('stale')
  const result = await parseQualityWorkflow(await request(C.runtimeSurveyQualityWorkflowPath(context.binding.projectId, current.workflow.id, 'events'), 'POST', body), context, current.workflow.id)
  const appended = result.entries[current.entries.length]
  if (!equal(result.workflow, current.workflow) || result.entries.length <= current.entries.length
    || current.entries.some((entry, index) => !equal(entry, result.entries[index])) || !appended || !equal(appended.request, body)
    || !equal(appended.evidenceBinding, evidence) || !equal(appended.targetBinding, target) || appended.event.event.evidenceSha256 !== member.sha256) return invalid()
  return result
}

const unavailable = z.array(z.object({ id: z.string().min(1).max(160), reason: z.enum(['stale', 'integrity']) }).strict()).max(20).default([])
const sourcePlanPage = z.object({ plans: z.array(SurveyQualityWorkspacePlanReadV1).max(20), unavailable, nextOffset: z.number().int().min(0).max(10000).nullable() }).strict()
export async function listWorkflowSourcePlans(context: WorkflowContext, offset = 0): Promise<{ plans: WorkflowSourcePlan[]; unavailable: z.infer<typeof unavailable>; nextOffset: number | null }> {
  const parsed = sourcePlanPage.safeParse(await request(`${runtimeSurveyQualityPath(context.binding.projectId, 'plans')}?limit=20&offset=${offset}`))
  if (!parsed.success || parsed.data.nextOffset !== null && parsed.data.nextOffset !== offset + 20) return invalid()
  const ids = [...parsed.data.plans.map(item => item.plan.id), ...parsed.data.unavailable.map(item => item.id)]
  if (ids.length > 20 || new Set(ids).size !== ids.length) return invalid()
  const plans = parsed.data.plans.map(plan => {
    const binding: QualityBinding = { projectId: context.binding.projectId, projectRevision: context.binding.projectRevision, manifestId: plan.plan.manifestId,
      outputs: plan.artifact.members.slice(1).map(({ path, sha256, sizeBytes, mediaType }) => ({ path, sha256, sizeBytes, mediaType })) }
    return { binding, plan: parseQualityPlan(plan, binding) }
  })
  return { ...parsed.data, plans }
}
const recordPage = z.object({ records: z.array(z.object({ record: SurveyQualityRecordV1, verification: SurveyQualityWorkspaceVerificationV1 }).strict()).max(20), unavailable, nextOffset: z.number().int().min(0).max(10000).nullable() }).strict()
export async function listWorkflowSourceRecords(source: WorkflowSourcePlan, offset = 0): Promise<{ records: QualityRecordSummary[]; unavailable: z.infer<typeof unavailable>; nextOffset: number | null }> {
  const parsed = recordPage.safeParse(await request(`${runtimeSurveyQualityPath(source.binding.projectId, 'records')}?limit=20&offset=${offset}`))
  if (!parsed.success || parsed.data.nextOffset !== null && parsed.data.nextOffset !== offset + 20 || parsed.data.records.some(item => item.record.projectId !== source.binding.projectId || item.verification.projectId !== source.binding.projectId)) return invalid()
  const ids = [...parsed.data.records.map(item => item.record.id), ...parsed.data.unavailable.map(item => item.id)]
  if (ids.length > 20 || new Set(ids).size !== ids.length) return invalid()
  return { ...parsed.data, records: parsed.data.records.filter(item => item.record.planId === source.plan.plan.id) }
}
export async function readWorkflowSourceRecord(source: WorkflowSourcePlan, expected: QualityRecordSummary): Promise<WorkflowContext> {
  const plan = parseQualityPlan(await request(runtimeSurveyQualityPath(source.binding.projectId, 'plans', source.plan.plan.id)), source.binding, source.plan.plan.id)
  if (!equal(plan, source.plan)) return invalid()
  const record = parseQualityRecord(await request(runtimeSurveyQualityPath(source.binding.projectId, 'records', expected.record.id)), source.binding, plan, expected.record.id)
  if (!equal(record.record, expected.record) || record.verification.headHash !== expected.verification.headHash) throw new QualityWorkflowRequestError('source-changed')
  const context = { binding: source.binding, plan, record }; await workflowBinding(context); return context
}
