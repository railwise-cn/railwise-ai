import { createHash } from 'node:crypto'
import { appendSurveyQualityEvent, verifySurveyQualityRecord } from '../../../../kun/src/engineering/survey-quality-record'
import type { QualityPlan, QualityRecord } from './survey-quality-client'
import type { WorkflowContext, QualityWorkflow, WorkflowBinding, WorkflowEvent } from './survey-quality-workflow-client'
const hash = (value: string) => value.repeat(64)
const createdAt = '2026-09-24T00:00:00.000Z'
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().filter(key => object[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}` }
  return JSON.stringify(value)
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
export function workflowFixture(suffix = '1'): WorkflowContext {
  const output = { path: `.workwise/deliverables/p/run-${suffix}/report.pdf`, sha256: suffix === '1' ? hash('a') : hash('b'), sizeBytes: 100, mediaType: 'application/pdf' }
  const artifactHash = suffix === '1' ? hash('c') : hash('d')
  const binding = { projectId: 'project', projectRevision: 2, manifestId: `manifest-${suffix}`, outputs: [output] }
  const plan: QualityPlan = {
    plan: { schemaVersion: 1, id: `plan-${suffix}`, projectId: 'project', projectRevision: 2, projectBindingHash: hash('b'), manifestId: binding.manifestId,
      manifestHash: hash('c'), artifactId: `artifact-${suffix}`, artifactHash, requiredEvidence: [{ id: 'output-1', memberId: 'output-1', title: 'Report PDF' }],
      requiredCheckIds: ['artifact-bytes', 'evidence:output-1'], purpose: 'evidence-retention-only', createdAt, standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated' },
    artifact: { schemaVersion: 1, id: `artifact-${suffix}`, projectId: 'project', manifestId: binding.manifestId, manifestHash: hash('c'), bundleHash: artifactHash, snapshotEvidenceSha256: hash('e'), createdAt,
      members: [{ id: 'manifest', path: `.workwise/deliverables/p/run-${suffix}/manifest.json`, mediaType: 'application/json', sha256: hash('f'), sizeBytes: 200 }, { id: 'output-1', ...output }] }
  }
  const record: QualityRecord = {
    record: { schemaVersion: 1, id: `record-${suffix}`, projectId: 'project', planId: plan.plan.id, planHash: digest(plan.plan), artifactId: plan.artifact.id, artifactHash, createdAt }, events: [],
    verification: { schemaVersion: 1, projectId: 'project', recordId: `record-${suffix}`, planId: plan.plan.id, artifactHash, headHash: hash('0'), checkedAt: createdAt,
      localRecordIntegrity: true, artifactIntegrity: 'verified', checkpointTrust: 'local-records-only', coverageStatus: 'not-evaluated', reason: 'independent-checkpoint-unavailable',
      assessmentBasis: 'recorded-retention-checks-only', checks: [{ checkId: 'artifact-bytes', status: 'missing' }, { checkId: 'evidence:output-1', status: 'missing' }],
      standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated' }
  }
  return { binding, plan, record }
}
export function fixtureBinding(context: WorkflowContext): WorkflowBinding {
  return { projectId: context.binding.projectId, projectRevision: context.binding.projectRevision, projectBindingHash: context.plan.plan.projectBindingHash,
    planId: context.plan.plan.id, planHash: context.record.record.planHash, recordId: context.record.record.id, recordHash: digest(context.record.record), retentionHeadHash: context.record.verification.headHash,
    artifactId: context.plan.artifact.id, artifactHash: context.plan.artifact.bundleHash, manifestId: context.plan.plan.manifestId, manifestHash: context.plan.plan.manifestHash }
}
export function emptyWorkflow(context: WorkflowContext, key = 'create-workflow'): QualityWorkflow {
  return { workflow: { schemaVersion: 1, id: 'workflow-1', projectId: context.binding.projectId, createdAt, binding: fixtureBinding(context), request: {
    planId: context.plan.plan.id, recordId: context.record.record.id, expectedRetentionHeadHash: context.record.verification.headHash, expectedProjectRevision: context.binding.projectRevision, idempotencyKey: key
  }, semantics: 'caller-declared-workflow-only' }, entries: [], headHash: hash('0'), recordIntegrity: true, openIssueCount: 0, recordedCheckCount: 0,
    semantics: 'caller-declared-workflow-only', checkpointTrust: 'local-records-only', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated', deliveryApproval: 'not-granted' }
}
export function appendFixture(current: QualityWorkflow, declared: WorkflowEvent, key: string, evidence: WorkflowContext, target?: WorkflowContext): QualityWorkflow {
  const evidenceSha256 = evidence.plan.artifact.members.find(member => member.id === declared.evidence.memberId)!.sha256
  let actual: QualityRecord['events'][number]['event']
  if (declared.kind === 'check') actual = { kind: declared.kind, checkId: declared.checkId, outcome: declared.outcome, evidenceSha256 }
  else if (declared.kind === 'issue-opened') actual = { kind: declared.kind, checkId: declared.checkId, issueId: declared.issueId, evidenceSha256 }
  else if (declared.kind === 'correction-recorded') actual = { kind: declared.kind, issueId: declared.issueId, correctionId: declared.correctionId, correctedArtifactSha256: target!.plan.artifact.bundleHash, evidenceSha256 }
  else actual = { kind: declared.kind, issueId: declared.issueId, correctionId: declared.correctionId, recheckedArtifactSha256: target!.plan.artifact.bundleHash, outcome: declared.outcome, evidenceSha256 }
  const events = appendSurveyQualityEvent(current.entries.map(entry => entry.event), { schemaVersion: 1, id: `event-${current.entries.length + 1}`, projectId: current.workflow.projectId, artifactSha256: current.workflow.binding.artifactHash,
    occurredAt: createdAt, actor: { id: 'survey-quality-workflow', kind: 'system' }, stage: 'declared-workflow', event: actual })
  const event = events.at(-1)!, verified = verifySurveyQualityRecord(events)
  return { ...current, entries: [...current.entries, { event, request: { expectedHeadHash: current.headHash, idempotencyKey: key, event: declared }, evidenceBinding: fixtureBinding(evidence), targetBinding: target ? fixtureBinding(target) : null }],
    headHash: event.thisHash, recordedCheckCount: verified.recordedCheckCount, openIssueCount: verified.openIssueCount }
}
