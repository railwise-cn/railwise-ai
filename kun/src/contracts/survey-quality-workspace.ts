import { z } from 'zod'
import { SurveyQualityEventV1 } from './survey-standard-quality.js'

const id = z.string().trim().min(1).max(160)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const time = z.iso.datetime({ offset: true })
const key = z.string().trim().min(8).max(160)
export const SURVEY_QUALITY_WORKSPACE_LIMITS = Object.freeze({
  requiredEvidence: 64, outputFiles: 16, fileBytes: 32 * 1024 * 1024,
  bundleBytes: 128 * 1024 * 1024, projectBlobBytes: 512 * 1024 * 1024,
  plansPerProject: 128, recordsPerProject: 128, evidencePerProject: 512, eventsPerRecord: 512, pageSize: 50
})
export const SurveyQualityPlanCreateV1 = z.object({
  manifestId: id, expectedProjectRevision: z.number().int().positive(), idempotencyKey: key,
  requiredEvidence: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), title: z.string().trim().min(1).max(300), memberId: id }).strict())
    .max(SURVEY_QUALITY_WORKSPACE_LIMITS.requiredEvidence)
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'Duplicate evidence requirement')
}).strict()
export const SurveyQualityArtifactMemberV1 = z.object({
  id, path: z.string().min(1).max(4096), mediaType: z.string().min(1).max(200),
  sha256: hash, sizeBytes: z.number().int().nonnegative().max(SURVEY_QUALITY_WORKSPACE_LIMITS.fileBytes)
}).strict()
export const SurveyQualityArtifactV1 = z.object({
  schemaVersion: z.literal(1), id, projectId: id, manifestId: id, manifestHash: hash,
  bundleHash: hash, snapshotEvidenceSha256: hash,
  members: z.array(SurveyQualityArtifactMemberV1).min(2).max(SURVEY_QUALITY_WORKSPACE_LIMITS.outputFiles + 1),
  createdAt: time
}).strict()
export type SurveyQualityArtifactV1 = z.infer<typeof SurveyQualityArtifactV1>
export const SurveyQualityPlanV1 = z.object({
  schemaVersion: z.literal(1), id, projectId: id, projectRevision: z.number().int().positive(),
  projectBindingHash: hash, manifestId: id, manifestHash: hash, artifactId: id, artifactHash: hash,
  requiredEvidence: SurveyQualityPlanCreateV1.shape.requiredEvidence,
  requiredCheckIds: z.array(id).min(1).max(SURVEY_QUALITY_WORKSPACE_LIMITS.requiredEvidence + 1),
  purpose: z.literal('evidence-retention-only'), createdAt: time,
  standardConformity: z.literal('not-evaluated'), humanSignatureVerification: z.literal('not-evaluated')
}).strict()
export type SurveyQualityPlanV1 = z.infer<typeof SurveyQualityPlanV1>
export const SurveyQualityEvidenceCreateV1 = z.object({ artifactId: id, memberId: id, idempotencyKey: key }).strict()
export const SurveyQualityEvidenceV1 = z.object({
  schemaVersion: z.literal(1), id, projectId: id, artifactId: id, memberId: id,
  sha256: hash, sizeBytes: z.number().int().nonnegative(), createdAt: time,
  semantics: z.literal('retained-bytes-only')
}).strict()
export type SurveyQualityEvidenceV1 = z.infer<typeof SurveyQualityEvidenceV1>
export const SurveyQualityRecordCreateV1 = z.object({ planId: id, idempotencyKey: key }).strict()
export const SurveyQualityRecordV1 = z.object({
  schemaVersion: z.literal(1), id, projectId: id, planId: id, planHash: hash,
  artifactId: id, artifactHash: hash, createdAt: time
}).strict()
export type SurveyQualityRecordV1 = z.infer<typeof SurveyQualityRecordV1>
// Evidence checks accept only the plan's declared member of its exact artifact,
// including when another artifact contains byte-identical members. Passed means
// retained-byte integrity only, never current input validity or numerical replay.
export const SurveyQualityCheckAppendV1 = z.object({
  expectedHeadHash: hash, idempotencyKey: key, checkId: id, evidenceId: id.optional()
}).strict()
export const SurveyQualityWorkspaceVerificationV1 = z.object({
  schemaVersion: z.literal(1), projectId: id, recordId: id, planId: id, artifactHash: hash, headHash: hash,
  checkedAt: time, localRecordIntegrity: z.literal(true), artifactIntegrity: z.literal('verified'),
  checkpointTrust: z.literal('local-records-only'), coverageStatus: z.literal('not-evaluated'),
  reason: z.literal('independent-checkpoint-unavailable'),
  assessmentBasis: z.literal('recorded-retention-checks-only'),
  checks: z.array(z.object({ checkId: id, status: z.enum(['passed', 'missing']), eventId: id.optional() }).strict())
    .max(SURVEY_QUALITY_WORKSPACE_LIMITS.requiredEvidence + 1),
  standardConformity: z.literal('not-evaluated'), humanSignatureVerification: z.literal('not-evaluated')
}).strict()
export type SurveyQualityWorkspaceVerificationV1 = z.infer<typeof SurveyQualityWorkspaceVerificationV1>
export const SurveyQualityWorkspaceRecordReadV1 = z.object({
  record: SurveyQualityRecordV1, events: z.array(SurveyQualityEventV1).max(SURVEY_QUALITY_WORKSPACE_LIMITS.eventsPerRecord),
  verification: SurveyQualityWorkspaceVerificationV1
}).strict()
export type SurveyQualityWorkspaceRecordReadV1 = z.infer<typeof SurveyQualityWorkspaceRecordReadV1>
export const SurveyQualityWorkspacePlanReadV1 = z.object({ plan: SurveyQualityPlanV1, artifact: SurveyQualityArtifactV1 }).strict()
export const SurveyQualityWorkspaceUnavailableV1 = z.object({ id, reason: z.enum(['stale', 'integrity']) }).strict()
export type SurveyQualityWorkspaceUnavailableV1 = z.infer<typeof SurveyQualityWorkspaceUnavailableV1>
