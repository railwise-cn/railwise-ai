import { z } from 'zod'
import {
  runtimeSurveyQualityPath, SurveyQualityPlanCreateV1, SurveyQualityRecordCreateV1, SurveyQualityEvidenceCreateV1,
  SurveyQualityCheckAppendV1, SurveyQualityWorkspacePlanReadV1, SurveyQualityWorkspaceRecordReadV1,
  SurveyQualityWorkspaceVerificationV1, SurveyQualityRecordV1, SurveyQualityEvidenceV1
} from '@shared/survey-quality-workspace'
import { rendererRuntimeClient } from './runtime-client'

export type QualityPlan = z.infer<typeof SurveyQualityWorkspacePlanReadV1>
export type QualityRecord = z.infer<typeof SurveyQualityWorkspaceRecordReadV1>
export type QualityBinding = { projectId: string; projectRevision: number; manifestId: string; outputs: Array<{ path: string; sha256: string; sizeBytes: number; mediaType: string }> }
export type QualityRequirements = z.infer<typeof SurveyQualityPlanCreateV1>['requiredEvidence']
export class QualityRequestError extends Error {
  constructor(readonly reason: 'stale' | 'integrity' | 'conflict' | 'limit' | 'invalid-reference' | 'unavailable' | 'invalid-response' | 'request-failed') { super(reason) }
}
const invalid = (): never => { throw new QualityRequestError('invalid-response') }
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const unavailableSchema = z.array(z.object({ id: z.string().min(1).max(160), reason: z.enum(['stale', 'integrity']) }).strict()).max(20).default([])
export type QualityUnavailable = z.infer<typeof unavailableSchema>
const listPlanSchema = z.object({ plans: z.array(SurveyQualityWorkspacePlanReadV1).max(20), unavailable: unavailableSchema, nextOffset: z.number().int().min(0).max(10000).nullable() }).strict()
const summarySchema = z.object({ record: SurveyQualityRecordV1, verification: SurveyQualityWorkspaceVerificationV1 }).strict()
const listRecordSchema = z.object({ records: z.array(summarySchema).max(20), unavailable: unavailableSchema, nextOffset: z.number().int().min(0).max(10000).nullable() }).strict()
export type QualityRecordSummary = z.infer<typeof summarySchema>

async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  let response: Awaited<ReturnType<typeof rendererRuntimeClient.runtimeRequest>>
  try { response = await rendererRuntimeClient.runtimeRequest(path, method, body === undefined ? undefined : JSON.stringify(body)) }
  catch { throw new QualityRequestError('request-failed') }
  if (!response.ok) {
    if (response.status === 409 && response.body.length < 16_384) {
      try {
        const parsed = JSON.parse(response.body) as { code?: unknown }
        const reason = (['stale', 'integrity', 'conflict', 'limit', 'invalid-reference'] as const).find(value => parsed.code === `quality_workspace_${value.replaceAll('-', '_')}`)
        if (reason) throw new QualityRequestError(reason)
      } catch (failure) { if (failure instanceof QualityRequestError) throw failure }
    }
    throw new QualityRequestError(response.status === 409 ? 'stale' : [404, 503].includes(response.status) ? 'unavailable' : 'request-failed')
  }
  try {
    if (response.body.length > 4 * 1024 * 1024 || new TextEncoder().encode(response.body).byteLength > 4 * 1024 * 1024) return invalid()
    return JSON.parse(response.body)
  } catch { return invalid() }
}

export function parseQualityPlan(value: unknown, binding: QualityBinding, expectedId?: string): QualityPlan {
  const parsed = SurveyQualityWorkspacePlanReadV1.safeParse(value)
  if (!parsed.success) return invalid()
  const { plan, artifact } = parsed.data
  if (plan.projectId !== binding.projectId || plan.projectRevision !== binding.projectRevision || plan.manifestId !== binding.manifestId
    || (expectedId !== undefined && plan.id !== expectedId) || artifact.id !== plan.artifactId || artifact.projectId !== binding.projectId
    || artifact.manifestId !== binding.manifestId || artifact.manifestHash !== plan.manifestHash || artifact.bundleHash !== plan.artifactHash
    || !equal(plan.requiredCheckIds, ['artifact-bytes', ...plan.requiredEvidence.map(item => `evidence:${item.id}`)])
    || new Set(artifact.members.map(member => member.id)).size !== artifact.members.length
    || new Set(artifact.members.map(member => member.path)).size !== artifact.members.length
    || plan.requiredEvidence.some(requirement => !artifact.members.some(member => member.id === requirement.memberId))
    || artifact.members.length !== binding.outputs.length + 1 || artifact.members[0]?.id !== 'manifest'
    || artifact.members.slice(1).some((member, index) => {
      const output = binding.outputs[index]
      return !output || member.id !== `output-${index + 1}` || member.path !== output.path || member.sha256 !== output.sha256 || member.sizeBytes !== output.sizeBytes || member.mediaType !== output.mediaType
    })) return invalid()
  return parsed.data
}

function validateSummary(value: QualityRecordSummary, binding: QualityBinding, plan?: QualityPlan): void {
  const { record, verification } = value
  if (record.projectId !== binding.projectId || verification.projectId !== binding.projectId || verification.recordId !== record.id
    || verification.planId !== record.planId || verification.artifactHash !== record.artifactHash
    || new Set(verification.checks.map(check => check.checkId)).size !== verification.checks.length
    || verification.checks.some(check => (check.status === 'passed') !== (check.eventId !== undefined))
    || (plan && (record.planId !== plan.plan.id || record.artifactId !== plan.artifact.id || record.artifactHash !== plan.plan.artifactHash
      || !equal(verification.checks.map(check => check.checkId), plan.plan.requiredCheckIds)))) invalid()
}

export function parseQualityRecord(value: unknown, binding: QualityBinding, plan: QualityPlan, expectedId?: string): QualityRecord {
  const parsed = SurveyQualityWorkspaceRecordReadV1.safeParse(value)
  if (!parsed.success) return invalid()
  const data = parsed.data
  validateSummary(data, binding, plan)
  if (expectedId !== undefined && data.record.id !== expectedId) return invalid()
  let previousHash = '0'.repeat(64)
  const eventIds = new Set<string>()
  for (const [index, event] of data.events.entries()) {
    if (eventIds.has(event.id) || event.projectId !== binding.projectId || event.artifactSha256 !== plan.plan.artifactHash
      || event.sequence !== index + 1 || event.previousHash !== previousHash || event.actor.kind !== 'system'
      || event.actor.id !== 'survey-quality-workspace' || event.stage !== 'workspace-evidence'
      || (event.event.kind !== 'check' && event.event.kind !== 'artifact-check')) return invalid()
    const detail = event.event
    if (detail.outcome !== 'passed' || detail.rule !== undefined || !plan.plan.requiredCheckIds.includes(detail.checkId)
      || (detail.kind === 'artifact-check' && detail.checkedArtifactSha256 !== plan.plan.artifactHash)
      || (detail.checkId === 'artifact-bytes' && detail.evidenceSha256 !== plan.plan.artifactHash)
      || (detail.checkId !== 'artifact-bytes' && !plan.artifact.members.some(member => member.id === plan.plan.requiredEvidence.find(requirement => `evidence:${requirement.id}` === detail.checkId)?.memberId && member.sha256 === detail.evidenceSha256))) return invalid()
    previousHash = event.thisHash; eventIds.add(event.id)
  }
  if (data.verification.headHash !== previousHash) return invalid()
  for (const check of data.verification.checks) {
    const event = [...data.events].reverse().find(event => (event.event.kind === 'check' || event.event.kind === 'artifact-check') && event.event.checkId === check.checkId)
    if ((event ? 'passed' : 'missing') !== check.status || event?.id !== check.eventId) return invalid()
  }
  return data
}

export async function freezeQualityPlan(binding: QualityBinding, requiredEvidence: QualityRequirements, idempotencyKey: string): Promise<QualityPlan> {
  const body = SurveyQualityPlanCreateV1.parse({ manifestId: binding.manifestId, expectedProjectRevision: binding.projectRevision, requiredEvidence, idempotencyKey })
  const value = parseQualityPlan(await request(runtimeSurveyQualityPath(binding.projectId, 'plans'), 'POST', body), binding)
  if (!equal(value.plan.requiredEvidence, body.requiredEvidence)) return invalid()
  return value
}
export async function readQualityPlan(binding: QualityBinding, expected: QualityPlan): Promise<QualityPlan> {
  const value = parseQualityPlan(await request(runtimeSurveyQualityPath(binding.projectId, 'plans', expected.plan.id)), binding, expected.plan.id)
  if (!equal(value.plan, expected.plan) || !equal(value.artifact, expected.artifact)) return invalid()
  return value
}
export async function listQualityPlans(binding: QualityBinding, offset = 0): Promise<{ plans: QualityPlan[]; unavailable: QualityUnavailable; nextOffset: number | null }> {
  const parsed = listPlanSchema.safeParse(await request(`${runtimeSurveyQualityPath(binding.projectId, 'plans')}?limit=20&offset=${offset}`))
  if (!parsed.success || (parsed.data.nextOffset !== null && parsed.data.nextOffset <= offset)) return invalid()
  const ids = [...parsed.data.plans.map(item => item.plan.id), ...parsed.data.unavailable.map(item => item.id)]
  if (ids.length > 20 || new Set(ids).size !== ids.length
    || parsed.data.plans.some(item => item.plan.projectId !== binding.projectId || item.artifact.projectId !== binding.projectId)) return invalid()
  return { plans: parsed.data.plans.filter(item => item.plan.manifestId === binding.manifestId).map(item => parseQualityPlan(item, binding)), unavailable: parsed.data.unavailable, nextOffset: parsed.data.nextOffset }
}
export async function createQualityRecord(binding: QualityBinding, plan: QualityPlan, idempotencyKey: string): Promise<QualityRecord> {
  return parseQualityRecord(await request(runtimeSurveyQualityPath(binding.projectId, 'records'), 'POST', SurveyQualityRecordCreateV1.parse({ planId: plan.plan.id, idempotencyKey })), binding, plan)
}
export async function listQualityRecords(binding: QualityBinding, plan: QualityPlan, offset = 0): Promise<{ records: QualityRecordSummary[]; unavailable: QualityUnavailable; nextOffset: number | null }> {
  const parsed = listRecordSchema.safeParse(await request(`${runtimeSurveyQualityPath(binding.projectId, 'records')}?limit=20&offset=${offset}`))
  if (!parsed.success || (parsed.data.nextOffset !== null && parsed.data.nextOffset <= offset)) return invalid()
  const ids = [...parsed.data.records.map(item => item.record.id), ...parsed.data.unavailable.map(item => item.id)]
  if (ids.length > 20 || new Set(ids).size !== ids.length) return invalid()
  for (const item of parsed.data.records) validateSummary(item, binding, item.record.planId === plan.plan.id ? plan : undefined)
  return { records: parsed.data.records.filter(item => item.record.planId === plan.plan.id), unavailable: parsed.data.unavailable, nextOffset: parsed.data.nextOffset }
}
export async function readQualityRecord(binding: QualityBinding, plan: QualityPlan, expected: QualityRecordSummary): Promise<QualityRecord> {
  const value = parseQualityRecord(await request(runtimeSurveyQualityPath(binding.projectId, 'records', expected.record.id)), binding, plan, expected.record.id)
  if (!equal(value.record, expected.record)) return invalid()
  return value
}
export async function appendQualityBytesCheck(binding: QualityBinding, plan: QualityPlan, current: QualityRecord, checkId: string, idempotencyKey: string, memberId?: string, evidenceKey?: string, stillCurrent: () => boolean = () => true): Promise<QualityRecord> {
  let evidenceId: string | undefined
  let evidenceHash = current.record.artifactHash
  const requirement = plan.plan.requiredEvidence.find(item => `evidence:${item.id}` === checkId)
  if (checkId === 'artifact-bytes' ? memberId !== undefined : !requirement || requirement.memberId !== memberId) return invalid()
  if (memberId !== undefined) {
    const member = plan.artifact.members.find(item => item.id === memberId)
    if (!member) return invalid()
    const retained = SurveyQualityEvidenceV1.safeParse(await request(runtimeSurveyQualityPath(binding.projectId, 'evidence'), 'POST', SurveyQualityEvidenceCreateV1.parse({ artifactId: plan.artifact.id, memberId, idempotencyKey: evidenceKey })))
    if (!retained.success) return invalid()
    const evidence = retained.data
    if (evidence.projectId !== binding.projectId || evidence.artifactId !== plan.artifact.id || evidence.memberId !== memberId || evidence.sha256 !== member.sha256 || evidence.sizeBytes !== member.sizeBytes) return invalid()
    evidenceId = evidence.id
    evidenceHash = evidence.sha256
  }
  if (!stillCurrent()) throw new QualityRequestError('stale')
  const body = SurveyQualityCheckAppendV1.parse({ expectedHeadHash: current.verification.headHash, idempotencyKey, checkId, ...(evidenceId ? { evidenceId } : {}) })
  const value = parseQualityRecord(await request(runtimeSurveyQualityPath(binding.projectId, 'records', current.record.id, 'checks'), 'POST', body), binding, plan, current.record.id)
  if (!equal(value.record, current.record) || value.events.length <= current.events.length
    || current.events.some((event, index) => !equal(event, value.events[index]))
    || !value.events.slice(current.events.length).some(event => (event.event.kind === 'check' || event.event.kind === 'artifact-check') && event.event.checkId === checkId && event.event.evidenceSha256 === evidenceHash)) return invalid()
  return value
}
export async function verifyQualityRecord(binding: QualityBinding, plan: QualityPlan, current: QualityRecord): Promise<QualityRecord> {
  const parsed = SurveyQualityWorkspaceVerificationV1.safeParse(await request(runtimeSurveyQualityPath(binding.projectId, 'records', current.record.id, 'verify'), 'POST', {}))
  if (!parsed.success) return invalid()
  validateSummary({ record: current.record, verification: parsed.data }, binding, plan)
  const latest = await readQualityRecord(binding, plan, current)
  if (latest.verification.headHash !== parsed.data.headHash || !equal(latest.verification.checks, parsed.data.checks)) throw new QualityRequestError('stale')
  return latest
}
