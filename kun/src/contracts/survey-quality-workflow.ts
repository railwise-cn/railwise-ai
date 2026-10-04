import { z } from 'zod';
import { SurveyQualityEventV1, SurveyStandardRuleRefV1 } from './survey-standard-quality.js';
const id = z.string().trim().min(1).max(160);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().trim().min(8).max(160);
export const QUALITY_WORKFLOW_LIMITS = Object.freeze({ workflowsPerProject: 128, eventsPerWorkflow: 128, sourcesPerWorkflow: 8, sourceBytesPerPass: 128 * 1024 * 1024, pageSize: 20, requestBytes: 32768, recordBytes: 2 * 1024 * 1024 });
export const SurveyQualityWorkflowSourceV1 = z.object({ planId: id, recordId: id, expectedRetentionHeadHash: hash }).strict();
export const SurveyQualityWorkflowEvidenceV1 = SurveyQualityWorkflowSourceV1.extend({ memberId: id }).strict();
export const SurveyQualityWorkflowCreateV1 = SurveyQualityWorkflowSourceV1.extend({
    expectedProjectRevision: z.number().int().positive(), idempotencyKey: key
}).strict();
export const SurveyQualityWorkflowDeclaredEventV1 = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('check'), checkId: id, outcome: z.enum(['failed', 'not-evaluated']), evidence: SurveyQualityWorkflowEvidenceV1 }).strict(),
    z.object({ kind: z.literal('issue-opened'), issueId: id, checkId: id, evidence: SurveyQualityWorkflowEvidenceV1 }).strict(),
    z.object({ kind: z.literal('correction-recorded'), issueId: id, correctionId: id, corrected: SurveyQualityWorkflowSourceV1, evidence: SurveyQualityWorkflowEvidenceV1 }).strict(),
    z.object({ kind: z.literal('issue-rechecked'), issueId: id, correctionId: id, rechecked: SurveyQualityWorkflowSourceV1, outcome: z.enum(['resolved', 'unresolved']), evidence: SurveyQualityWorkflowEvidenceV1 }).strict(),
    z.object({ kind: z.literal('stage-started'), stageId: id, stageKind: z.enum(['planning', 'process', 'final', 'acceptance']),
        policyVersion: id, checkedScope: id, evidence: SurveyQualityWorkflowEvidenceV1 }).strict(),
    z.object({ kind: z.literal('stage-completed'), stageId: id, stageKind: z.enum(['planning', 'process', 'final', 'acceptance']),
        outcome: z.enum(['completed', 'blocked']), evidence: SurveyQualityWorkflowEvidenceV1 }).strict(),
    z.object({ kind: z.literal('rule-applicability'), declarationId: id, rule: SurveyStandardRuleRefV1,
        status: z.enum(['applicable', 'not-applicable', 'pending']), rationale: id, evidence: SurveyQualityWorkflowEvidenceV1 }).strict(),
    z.object({ kind: z.literal('rule-revoked'), declarationId: id, reason: id, evidence: SurveyQualityWorkflowEvidenceV1 }).strict(),
    z.object({ kind: z.literal('signoff-declared'), signoffId: id,
        purpose: z.enum(['quality-review', 'delivery-approval']), actorKey: id, evidence: SurveyQualityWorkflowEvidenceV1 }).strict(),
    z.object({ kind: z.literal('signoff-revoked'), signoffId: id, reason: id, evidence: SurveyQualityWorkflowEvidenceV1 }).strict(),
    z.object({ kind: z.literal('delivery-approval-requested'), approvalId: id, requiredSignoffIds: z.array(id).min(1).max(32)
        .refine(ids => new Set(ids).size === ids.length, 'Duplicate signoff ID'),
        evidence: SurveyQualityWorkflowEvidenceV1 }).strict()
]);
export const SurveyQualityWorkflowAppendV1 = z.object({ expectedHeadHash: hash, idempotencyKey: key, event: SurveyQualityWorkflowDeclaredEventV1 }).strict();
export const SurveyQualityWorkflowBindingV1 = z.object({
    projectId: id, projectRevision: z.number().int().positive(), projectBindingHash: hash,
    planId: id, planHash: hash, recordId: id, recordHash: hash, retentionHeadHash: hash,
    artifactId: id, artifactHash: hash, manifestId: id, manifestHash: hash
}).strict();
export const SurveyQualityWorkflowV1 = z.object({
    schemaVersion: z.literal(1), id, projectId: id, createdAt: z.iso.datetime({ offset: true }),
    binding: SurveyQualityWorkflowBindingV1, request: SurveyQualityWorkflowCreateV1,
    semantics: z.literal('caller-declared-workflow-only')
}).strict();
export const SurveyQualityWorkflowEntryV1 = z.object({
    request: SurveyQualityWorkflowAppendV1, event: SurveyQualityEventV1,
    evidenceBinding: SurveyQualityWorkflowBindingV1,
    targetBinding: SurveyQualityWorkflowBindingV1.nullable()
}).strict();
export const SurveyQualityWorkflowGateV1 = z.object({
    schemaVersion: z.literal(1),
    status: z.enum(['not-evaluated', 'blocked', 'ready-for-external-approval']),
    reasons: z.array(z.enum([
        'versioned-stage-record-missing', 'acceptance-stage-incomplete', 'open-issues', 'blocking-stage',
        'applicability-not-evaluated', 'rule-revoked', 'signoff-missing', 'signoff-revoked',
        'approval-request-missing', 'approval-request-incomplete', 'record-integrity-failed',
        'failed-quality-check', 'quality-check-not-evaluated'
    ])).max(16),
    completedStageKinds: z.array(z.enum(['planning', 'process', 'final', 'acceptance'])).max(4),
    activeApplicableRuleIds: z.array(id).max(QUALITY_WORKFLOW_LIMITS.eventsPerWorkflow),
    revokedRuleIds: z.array(id).max(QUALITY_WORKFLOW_LIMITS.eventsPerWorkflow),
    activeSignoffIds: z.array(id).max(QUALITY_WORKFLOW_LIMITS.eventsPerWorkflow),
    revokedSignoffIds: z.array(id).max(QUALITY_WORKFLOW_LIMITS.eventsPerWorkflow),
    approvalRequestIds: z.array(id).max(QUALITY_WORKFLOW_LIMITS.eventsPerWorkflow)
}).strict();
export const SurveyQualityWorkflowReadV1 = z.object({
    workflow: SurveyQualityWorkflowV1, entries: z.array(SurveyQualityWorkflowEntryV1).max(QUALITY_WORKFLOW_LIMITS.eventsPerWorkflow),
    headHash: hash, recordIntegrity: z.literal(true), openIssueCount: z.number().int().nonnegative(),
    recordedCheckCount: z.number().int().nonnegative(), semantics: z.literal('caller-declared-workflow-only'),
    checkpointTrust: z.literal('local-records-only'), standardConformity: z.literal('not-evaluated'), humanSignatureVerification: z.literal('not-evaluated'),
    deliveryApproval: z.literal('not-granted'), qualityGate: SurveyQualityWorkflowGateV1
}).strict();
export const SurveyQualityWorkflowListV1 = z.object({
    workflows: z.array(SurveyQualityWorkflowReadV1).max(QUALITY_WORKFLOW_LIMITS.pageSize),
    unavailable: z.array(z.object({ id, reason: z.enum(['stale', 'integrity', 'source-changed', 'not-found', 'unavailable']) }).strict()).max(QUALITY_WORKFLOW_LIMITS.pageSize),
    nextOffset: z.number().int().nonnegative().nullable()
}).strict();
export type SurveyQualityWorkflowReadV1 = z.infer<typeof SurveyQualityWorkflowReadV1>;
export type SurveyQualityWorkflowBindingV1 = z.infer<typeof SurveyQualityWorkflowBindingV1>;
export type SurveyQualityWorkflowEntryV1 = z.infer<typeof SurveyQualityWorkflowEntryV1>;
export type SurveyQualityWorkflowSourceV1 = z.infer<typeof SurveyQualityWorkflowSourceV1>;
export type SurveyQualityWorkflowAppendV1 = z.infer<typeof SurveyQualityWorkflowAppendV1>;
export type SurveyQualityWorkflowGateV1 = z.infer<typeof SurveyQualityWorkflowGateV1>;
