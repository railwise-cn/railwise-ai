import { z } from 'zod'
import { isSurveySamplingUnicode, SurveySamplingIdentifierV1 as id, SurveyQualitySamplingPlanV1, SurveyQualitySamplingSourceV1 } from './survey-quality-sampling.js'

export const SURVEY_SAMPLING_WORKSPACE_LIMITS = Object.freeze({ unitsPerPopulation: 10_000, requestBytes: 1024 * 1024,
  definitionBytes: 64 * 1024, populationsPerProject: 128, runsPerProject: 512, pageSize: 100 })
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const time = z.iso.datetime({ offset: true })
const key = z.string().min(8).max(160).refine(value => value.trim() === value && isSurveySamplingUnicode(value))
const stage = z.enum(['process', 'final-office', 'final-field', 'acceptance'])
const mode = z.enum(['census', 'table-1-simple-random'])
const definition = z.string().min(1).max(SURVEY_SAMPLING_WORKSPACE_LIMITS.definitionBytes).refine(value => value.trim().length > 0
  && isSurveySamplingUnicode(value) && new TextEncoder().encode(value).byteLength <= SURVEY_SAMPLING_WORKSPACE_LIMITS.definitionBytes,
  'definition must be exact valid Unicode within its UTF-8 byte limit')
const units = z.array(id).min(1).max(SURVEY_SAMPLING_WORKSPACE_LIMITS.unitsPerPopulation).refine(value => new Set(value).size === value.length, 'duplicate unit product identifier')
const boundaries = {
  decision: z.literal('not-evaluated'), standardConformity: z.literal('not-evaluated'), humanSignatureVerification: z.literal('not-evaluated'),
  populationCompleteness: z.literal('caller-declared-not-verified'), spatialUniformity: z.literal('not-evaluated')
}

/** Clients declare the unit definition and exact ordered frame. They cannot
 * supply hashes, seeds, outcomes or authenticated professional identity. */
export const SurveySamplingPopulationCreateV1 = z.object({
  idempotencyKey: key, expectedProjectRevision: z.number().int().positive(), productType: id, unitProductType: id,
  definitionStatement: definition, orderedUnitProductIds: units
}).strict().refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= SURVEY_SAMPLING_WORKSPACE_LIMITS.requestBytes, 'population request exceeds UTF-8 byte limit')
export type SurveySamplingPopulationCreateV1 = z.infer<typeof SurveySamplingPopulationCreateV1>
export const SurveySamplingPopulationSummaryV1 = z.object({
  schemaVersion: z.literal(1), id, projectId: id, projectRevision: z.number().int().positive(), projectBindingHash: hash,
  productType: id, unitProductType: id, definitionEvidenceSha256: hash,
  definitionSizeBytes: z.number().int().positive().max(SURVEY_SAMPLING_WORKSPACE_LIMITS.definitionBytes),
  populationHash: hash, unitCount: z.number().int().min(1).max(SURVEY_SAMPLING_WORKSPACE_LIMITS.unitsPerPopulation), createdAt: time,
  definitionTrust: z.literal('user-declared-not-professionally-verified'), populationCompleteness: z.literal('caller-declared-not-verified')
}).strict()
export type SurveySamplingPopulationSummaryV1 = z.infer<typeof SurveySamplingPopulationSummaryV1>
export const SurveySamplingPopulationDetailV1 = SurveySamplingPopulationSummaryV1.extend({ definitionStatement: definition }).strict()
  .refine(value => value.definitionSizeBytes === new TextEncoder().encode(value.definitionStatement).byteLength, 'definition byte count mismatch')
export type SurveySamplingPopulationDetailV1 = z.infer<typeof SurveySamplingPopulationDetailV1>
/** Internal persistence only. HTTP exposes detail metadata and paginated units. */
export const SurveySamplingPopulationRecordV1 = SurveySamplingPopulationSummaryV1.extend({ definitionStatement: definition, orderedUnitProductIds: units }).strict()
  .superRefine((value, context) => {
    if (value.unitCount !== value.orderedUnitProductIds.length || value.definitionSizeBytes !== new TextEncoder().encode(value.definitionStatement).byteLength) context.addIssue({ code: 'custom', message: 'population count or definition byte count mismatch' })
  })
export type SurveySamplingPopulationRecordV1 = z.infer<typeof SurveySamplingPopulationRecordV1>

export const SurveySamplingRunCreateV1 = z.object({ populationId: id, idempotencyKey: key, stage, inspectionMode: mode }).strict()
  .refine(value => !['process', 'final-office'].includes(value.stage) || value.inspectionMode === 'census', 'this stage requires census')
export type SurveySamplingRunCreateV1 = z.infer<typeof SurveySamplingRunCreateV1>
export const SurveySamplingBatchSummaryV1 = z.object({ batchIndex: z.number().int().min(0).max(9), batchSize: z.number().int().min(1).max(1000),
  nominalTableSampleSize: z.number().int().min(3).max(56), sampleSize: z.number().int().min(1).max(1000), census: z.boolean() }).strict()
const runShape = {
  schemaVersion: z.literal(1), id, projectId: id, projectRevision: z.number().int().positive(), projectBindingHash: hash,
  populationId: id, populationHash: hash, definitionEvidenceSha256: hash,
  unitCount: z.number().int().min(1).max(SURVEY_SAMPLING_WORKSPACE_LIMITS.unitsPerPopulation), stage, inspectionMode: mode, round: z.literal(1),
  algorithmVersion: z.literal('quality-sampling-hmac-sha256-fy-1'), source: SurveyQualitySamplingSourceV1,
  requestHash: hash, planHash: hash, runHash: hash, sampleSize: z.number().int().min(1).max(SURVEY_SAMPLING_WORKSPACE_LIMITS.unitsPerPopulation),
  batchCount: z.number().int().min(1).max(10), batches: z.array(SurveySamplingBatchSummaryV1).min(1).max(10),
  randomSource: z.enum(['runtime-generated-local-unwitnessed', 'not-applicable']), createdAt: time, ...boundaries
}
export const SurveySamplingRunSummaryV1 = z.object(runShape).strict().superRefine((value, context) => {
  const count = Math.ceil(value.unitCount / 1000), base = Math.floor(value.unitCount / count), remainder = value.unitCount % count
  if (value.batchCount !== count || value.batches.length !== count || value.sampleSize !== value.batches.reduce((sum, batch) => sum + batch.sampleSize, 0)
    || value.batches.some((batch, index) => batch.batchIndex !== index || batch.batchSize !== base + (index < remainder ? 1 : 0)
      || batch.sampleSize !== (value.inspectionMode === 'census' ? batch.batchSize : Math.min(batch.batchSize, batch.nominalTableSampleSize)) || batch.census !== (batch.sampleSize === batch.batchSize))
    || (['process', 'final-office'].includes(value.stage) && value.inspectionMode !== 'census')
    || value.randomSource !== (value.inspectionMode === 'census' ? 'not-applicable' : 'runtime-generated-local-unwitnessed')) context.addIssue({ code: 'custom', message: 'sampling summary counts, scope or random source mismatch' })
})
export type SurveySamplingRunSummaryV1 = z.infer<typeof SurveySamplingRunSummaryV1>
/** Full plan (including seed/frame) is internal, never returned by list/detail. */
export const SurveySamplingRunRecordV1 = z.object({ ...runShape, plan: SurveyQualitySamplingPlanV1 }).strict().superRefine((value, context) => {
  const { plan, ...summary } = value
  if (!SurveySamplingRunSummaryV1.safeParse(summary).success
    || plan.request.projectId !== value.projectId || plan.request.populationId !== value.populationId || plan.request.populationHash !== value.populationHash
    || plan.request.definitionEvidenceSha256 !== value.definitionEvidenceSha256 || plan.request.orderedUnitProductIds.length !== value.unitCount
    || plan.request.stage !== value.stage || plan.request.inspectionMode !== value.inspectionMode || plan.request.round !== 1 || plan.request.previousPlanHash !== undefined
    || plan.requestHash !== value.requestHash || plan.planHash !== value.planHash || plan.sampleSize !== value.sampleSize
    || JSON.stringify(plan.source) !== JSON.stringify(value.source)
    || JSON.stringify(plan.batches.map(({ batchIndex, batchSize, nominalTableSampleSize, sampleSize, census }) => ({ batchIndex, batchSize, nominalTableSampleSize, sampleSize, census }))) !== JSON.stringify(value.batches)) context.addIssue({ code: 'custom', message: 'sampling record is not bound to its stored plan' })
})
export type SurveySamplingRunRecordV1 = z.infer<typeof SurveySamplingRunRecordV1>

export const SurveySamplingUnavailableV1 = z.object({ id, reason: z.enum(['stale', 'integrity']) }).strict()
const nextOffset = z.number().int().min(0).max(SURVEY_SAMPLING_WORKSPACE_LIMITS.unitsPerPopulation).nullable()
const unavailable = z.array(SurveySamplingUnavailableV1).max(SURVEY_SAMPLING_WORKSPACE_LIMITS.pageSize)
const uniquePage = (ids: string[]): boolean => ids.length <= SURVEY_SAMPLING_WORKSPACE_LIMITS.pageSize && new Set(ids).size === ids.length
export const SurveySamplingPopulationListV1 = z.object({ populations: z.array(SurveySamplingPopulationSummaryV1).max(SURVEY_SAMPLING_WORKSPACE_LIMITS.pageSize), unavailable, nextOffset }).strict()
  .refine(value => uniquePage([...value.populations, ...value.unavailable].map(item => item.id)), 'history page contains duplicate or excess entries')
export const SurveySamplingRunListV1 = z.object({ runs: z.array(SurveySamplingRunSummaryV1).max(SURVEY_SAMPLING_WORKSPACE_LIMITS.pageSize), unavailable, nextOffset }).strict()
  .refine(value => uniquePage([...value.runs, ...value.unavailable].map(item => item.id)), 'history page contains duplicate or excess entries')
export const SurveySamplingUnitV1 = z.object({ index: z.number().int().min(0).max(9999), unitProductId: id }).strict()
function validPage(offset: number, total: number, entries: Array<{ index: number; unitProductId: string }>, next: number | null): boolean {
  const end = offset + entries.length
  return (offset >= total ? entries.length === 0 && next === null : entries.length > 0 && end <= total && next === (end < total ? end : null))
    && entries.every((entry, index) => entry.index === offset + index) && new Set(entries.map(entry => entry.unitProductId)).size === entries.length
}
export const SurveySamplingUnitPageV1 = z.object({ projectId: id, populationId: id, populationHash: hash,
  offset: z.number().int().min(0).max(10000), total: z.number().int().min(1).max(10000), units: z.array(SurveySamplingUnitV1).max(100), nextOffset }).strict()
  .refine(value => validPage(value.offset, value.total, value.units, value.nextOffset), 'unit page membership or continuation mismatch')
export const SurveySamplingSampleV1 = z.object({ index: z.number().int().min(0).max(9999), batchIndex: z.number().int().min(0).max(9), unitProductId: id }).strict()
export const SurveySamplingSamplePageV1 = z.object({ projectId: id, runId: id, planHash: hash,
  offset: z.number().int().min(0).max(10000), total: z.number().int().min(1).max(10000), samples: z.array(SurveySamplingSampleV1).max(100), nextOffset }).strict()
  .refine(value => validPage(value.offset, value.total, value.samples, value.nextOffset), 'sample page membership or continuation mismatch')
export const SurveySamplingVerificationV1 = z.object({ schemaVersion: z.literal(1), projectId: id, populationId: id, runId: id,
  planHash: hash, runHash: hash, checkedAt: time, recordIntegrity: z.literal('verified'), recomputed: z.literal(true),
  checkpointTrust: z.literal('local-records-only'), ...boundaries }).strict()
export type SurveySamplingVerificationV1 = z.infer<typeof SurveySamplingVerificationV1>
export const SurveySamplingVerifyRequestV1 = z.object({}).strict()
