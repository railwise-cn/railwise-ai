import { z } from 'zod'
import { SurveyQualityScoringInputV1, SurveyQualityScoringOutputV1 } from './survey-quality-scoring.js'

export const SURVEY_QUALITY_SCORING_WORKSPACE_LIMITS = Object.freeze({ requestBytes: 512 * 1024, declarationBytes: 256 * 1024,
  basisBytes: 16 * 1024, recordBytes: 4 * 1024 * 1024, recordsPerProject: 128, storedBytesPerProject: 64 * 1024 * 1024,
  pageSize: 10, workUnitsPerMinute: 240 })
const L = SURVEY_QUALITY_SCORING_WORKSPACE_LIMITS
const unicode = (v: string) => new TextDecoder().decode(new TextEncoder().encode(v)) === v
const id = z.string().min(1).max(160).refine(v => v.trim() === v && unicode(v))
const key = id.refine(v => v.length >= 8)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const time = z.iso.datetime({ offset: true })
const text = (max: number) => z.string().min(1).max(max).refine(v => unicode(v) && new TextEncoder().encode(v).byteLength <= max)
export const SurveyQualityScoringKindV1 = z.enum(['accuracy', 'deduction', 'unit', 'overview', 'sample', 'final-batch', 'acceptance-batch'])
export const SurveyQualityScoringCreateV1 = z.object({ kind: SurveyQualityScoringKindV1, acknowledged: z.literal(true), expectedProjectRevision: revision,
  idempotencyKey: key, declarationJson: text(L.declarationBytes), modelBasisStatement: text(L.basisBytes).refine(v => v.trim().length > 0) }).strict()
export type SurveyQualityScoringCreateV1 = z.infer<typeof SurveyQualityScoringCreateV1>
const boundaries = { status: z.literal('declared-inspection-trial-only'), declarationTrust: z.literal('caller-declared-not-authenticated'),
  evidenceAuthenticity: z.literal('not-verified'), classificationAuthenticity: z.literal('not-verified'), priorQualificationAuthenticity: z.literal('not-verified'),
  engineeringDecision: z.literal('not-evaluated'), formalResultsModified: z.literal(false), checkpointTrust: z.literal('local-records-only') }
const common = { schemaVersion: z.literal(1), id, projectId: id, projectRevision: revision, projectBindingHash: hash,
  kind: SurveyQualityScoringKindV1, acknowledged: z.literal(true), idempotencyKey: key,
  algorithmVersion: z.literal('gbt24356-declared-exact-quality-scoring-1'), createdAt: time,
  modelBasisSha256: hash, modelBasisSizeBytes: z.number().int().positive().max(L.basisBytes), replayEnvironmentHash: hash,
  requestSha256: hash, declarationSha256: hash, modelHash: hash, resultHash: hash, recordHash: hash,
  requestSizeBytes: z.number().int().positive().max(L.requestBytes), declarationSizeBytes: z.number().int().positive().max(L.declarationBytes),
  modelNormalization: z.literal('schema-normalized'), outcome: z.enum(['calculated', 'nonconforming', 'unavailable', 'invalid']),
  scopeAssessment: SurveyQualityScoringOutputV1.shape.scopeAssessment, ...boundaries }
export const SurveyQualityScoringSummaryV1 = z.object(common).strict()
export type SurveyQualityScoringSummaryV1 = z.infer<typeof SurveyQualityScoringSummaryV1>
export const SurveyQualityScoringReplayEnvironmentV1 = z.object({ node: id, v8: id, platform: id, arch: id, bun: id.nullable() }).strict()
export const SurveyQualityScoringRecordV1 = z.object({ ...common, requestJson: text(L.requestBytes), declarationJson: text(L.declarationBytes),
  modelBasisStatement: text(L.basisBytes), replayEnvironment: SurveyQualityScoringReplayEnvironmentV1,
  projectSnapshot: z.object({ id, revision, workspace: text(8192) }).strict(),
  declaration: SurveyQualityScoringInputV1, result: SurveyQualityScoringOutputV1
}).strict().superRefine((v, ctx) => {
  if (v.projectSnapshot.id !== v.projectId || v.projectSnapshot.revision !== v.projectRevision || v.kind !== v.declaration.operation
    || v.result.request === null || v.result.request.operation !== v.kind || v.result.algorithmVersion !== v.algorithmVersion
    || v.outcome !== v.result.result.state || v.scopeAssessment !== v.result.scopeAssessment
    || new TextEncoder().encode(v.requestJson).byteLength !== v.requestSizeBytes
    || new TextEncoder().encode(v.declarationJson).byteLength !== v.declarationSizeBytes
    || new TextEncoder().encode(v.modelBasisStatement).byteLength !== v.modelBasisSizeBytes) ctx.addIssue({ code: 'custom', message: 'Scoring record binding is inconsistent' })
})
export type SurveyQualityScoringRecordV1 = z.infer<typeof SurveyQualityScoringRecordV1>
export const SurveyQualityScoringListV1 = z.object({ records: z.array(SurveyQualityScoringSummaryV1).max(L.pageSize),
  unavailable: z.array(z.object({ id, reason: z.enum(['stale', 'integrity', 'replay-environment']) }).strict()).max(L.pageSize),
  nextOffset: z.number().int().min(0).max(L.recordsPerProject).nullable()
}).strict().refine(v => v.records.length + v.unavailable.length <= L.pageSize && new Set([...v.records, ...v.unavailable].map(v => v.id)).size === v.records.length + v.unavailable.length)
export type SurveyQualityScoringListV1 = z.infer<typeof SurveyQualityScoringListV1>
export const SurveyQualityScoringReverifyRequestV1 = z.object({}).strict()
export const SurveyQualityScoringVerificationV1 = z.object({ schemaVersion: z.literal(1), projectId: id, recordId: id, kind: SurveyQualityScoringKindV1,
  requestSha256: hash, declarationSha256: hash, modelHash: hash, resultHash: hash, recordHash: hash,
  checkedAt: time, recordIntegrity: z.literal('verified'), recomputed: z.literal(true), ...boundaries }).strict()
export type SurveyQualityScoringVerificationV1 = z.infer<typeof SurveyQualityScoringVerificationV1>
