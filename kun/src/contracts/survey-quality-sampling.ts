import { z } from 'zod'

/** Reject lone UTF-16 surrogates without requiring Node's Buffer in renderer. */
export function isSurveySamplingUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}
export const SurveySamplingIdentifierV1 = z.string().min(1).max(200).refine(value => value.trim() === value && isSurveySamplingUnicode(value), 'identifier must be nonblank, exact and valid Unicode')
const id = SurveySamplingIdentifierV1
const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const SurveyQualitySamplingRequestV1 = z.object({
  schemaVersion: z.literal(1), projectId: id, populationId: id,
  /** Caller-defined unit products, never inferred from raw observations. */
  productType: id, unitProductType: id, definitionEvidenceSha256: hash,
  orderedUnitProductIds: z.array(id).min(1).max(100_000),
  populationHash: hash,
  stage: z.enum(['process', 'final-office', 'final-field', 'acceptance']),
  inspectionMode: z.enum(['census', 'table-1-simple-random']),
  round: z.number().int().positive().max(1_000_000),
  previousPlanHash: hash.optional(),
  randomSource: z.object({
    seedHex: hash, sourceDescription: z.string().trim().min(1).max(500), receiptSha256: hash,
    trust: z.literal('caller-declared-not-authenticated')
  }).strict().optional()
}).strict().superRefine((input, context) => {
  if (new Set(input.orderedUnitProductIds).size !== input.orderedUnitProductIds.length) context.addIssue({ code: 'custom', path: ['orderedUnitProductIds'], message: 'unit product IDs must be unique' })
  if (['process', 'final-office'].includes(input.stage) && input.inspectionMode !== 'census') context.addIssue({ code: 'custom', path: ['inspectionMode'], message: 'this inspection stage requires all units' })
  if ((input.round === 1) !== (input.previousPlanHash === undefined)) context.addIssue({ code: 'custom', path: ['previousPlanHash'], message: 'later rounds require a previous plan binding; first round must not supply one' })
  if (input.inspectionMode === 'table-1-simple-random' && !input.randomSource) context.addIssue({ code: 'custom', path: ['randomSource'], message: 'replayable random-source evidence is required' })
  if (input.inspectionMode === 'census' && input.randomSource) context.addIssue({ code: 'custom', path: ['randomSource'], message: 'census does not use randomness' })
})
export type SurveyQualitySamplingRequestV1 = z.infer<typeof SurveyQualitySamplingRequestV1>

/** Data-only response contract. Cryptographic hashes and random selections
 * still require independent kernel replay; schema success does not prove them. */
export const SurveyQualitySamplingSourceV1 = z.object({
  standard: z.literal('GB/T 24356-2023'), table: z.literal('1'),
  clauses: z.literal('4.2.2(b);4.2.3(b);4.2.4(c);5.1;5.2;5.3'),
  officialUrl: z.literal('https://zrzy.guizhou.gov.cn/wzgb/ztzl/lszt/zrzyzljc/202308/P020230829590929227708.pdf'),
  sourceSha256: z.literal('96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487'),
  tablePrintedPage: z.literal(5), tablePdfPage: z.literal(8),
  tablePagePngSha256: z.literal('6bf3dbeaa964903ab5504c8a3cad2a4c7e1f3e97d7ddf10f6153f4b4aaa9d79c'),
  stagePdfPage: z.literal(6), stagePagePngSha256: z.literal('94f9323e9653435a1e14c36ed79c04a898a7150c09282790cc4dfdaa667e9617'),
  sampleMaterialsPdfPage: z.literal(9), sampleMaterialsPagePngSha256: z.literal('5575818fd93325a1c6914f745bb96a848a20d68d3375b0b9f1bfd923669f5b9f'),
  tableEncoding: z.literal('utf8-json-array-of-inclusive-min-max-nominal-size-triples'),
  tableSha256: z.literal('1a5e4aa0cf43412f0663f6ce619d829a703c84dc7c3b67c1eb7c626fa402c363'),
  reviewIdentity: z.literal('agent-source-transcription-not-professional-signoff')
}).strict()
export const SurveyQualitySamplingBatchV1 = z.object({
  batchIndex: z.number().int().min(0).max(99), batchSize: z.number().int().min(1).max(1000),
  unitProductIds: z.array(id).min(1).max(1000), nominalTableSampleSize: z.number().int().min(3).max(56),
  sampleSize: z.number().int().min(1).max(1000), census: z.boolean(),
  selectedUnitProductIds: z.array(id).min(1).max(1000), randomDrawCount: z.number().int().min(0).max(100_000),
  rejectedDrawCount: z.number().int().min(0).max(100_000), randomTranscriptSha256: hash.nullable()
}).strict()
export const SurveyQualitySamplingPlanV1 = z.object({
  schemaVersion: z.literal(1), algorithmVersion: z.literal('quality-sampling-hmac-sha256-fy-1'),
  source: SurveyQualitySamplingSourceV1, request: SurveyQualitySamplingRequestV1, requestHash: hash,
  batchingPolicy: z.literal('minimum-count-balanced-contiguous-input-frame-extra-first'),
  batches: z.array(SurveyQualitySamplingBatchV1).min(1).max(100), sampleSize: z.number().int().min(1).max(100_000),
  decision: z.literal('not-evaluated'), standardConformity: z.literal('not-evaluated'),
  humanSignatureVerification: z.literal('not-evaluated'), populationCompleteness: z.literal('caller-declared-not-verified'),
  spatialUniformity: z.literal('not-evaluated'),
  randomSourceVerification: z.enum(['caller-declared-not-authenticated', 'not-applicable']),
  previousPlanVerification: z.enum(['not-evaluated', 'not-applicable']),
  sampleMaterialScope: z.literal('all-materials-of-selected-unit-products-and-clause-5.3.3-supplementary-materials'),
  exclusions: z.tuple([z.literal('no-stratified-proportional-sampling'), z.literal('no-quality-scoring'), z.literal('no-stage-completion'), z.literal('no-unit-product-inference'), z.literal('no-professional-signoff')]),
  planHash: hash
}).strict().superRefine((plan, context) => {
  const reject = (message: string): void => context.addIssue({ code: 'custom', message })
  const population = plan.request.orderedUnitProductIds
  const count = Math.ceil(population.length / 1000), base = Math.floor(population.length / count), remainder = population.length % count
  let offset = 0, totalSelected = 0
  if (plan.batches.length !== count) reject('batch count does not match the minimum balanced population split')
  plan.batches.forEach((batch, index) => {
    const expectedSize = base + (index < remainder ? 1 : 0)
    const members = new Set(batch.unitProductIds)
    if (batch.batchIndex !== index || batch.batchSize !== expectedSize || batch.unitProductIds.length !== expectedSize
      || batch.unitProductIds.some((value, position) => value !== population[offset + position])) reject('batch membership does not match the ordered population')
    offset += batch.unitProductIds.length
    if (batch.selectedUnitProductIds.length !== batch.sampleSize || new Set(batch.selectedUnitProductIds).size !== batch.sampleSize
      || batch.selectedUnitProductIds.some(value => !members.has(value))) reject('sample membership or size is inconsistent')
    const expectedSample = plan.request.inspectionMode === 'census' ? batch.batchSize : Math.min(batch.batchSize, batch.nominalTableSampleSize)
    if (batch.sampleSize !== expectedSample || batch.census !== (batch.sampleSize === batch.batchSize)) reject('inspection mode and sample size are inconsistent')
    if (batch.census) {
      if (batch.randomDrawCount !== 0 || batch.rejectedDrawCount !== 0 || batch.randomTranscriptSha256 !== null
        || batch.selectedUnitProductIds.some((value, position) => value !== batch.unitProductIds[position])) reject('census must preserve all units without random draws')
    } else if (batch.randomTranscriptSha256 === null || batch.randomDrawCount !== batch.sampleSize + batch.rejectedDrawCount) reject('random draw accounting is inconsistent')
    totalSelected += batch.sampleSize
  })
  if (offset !== population.length || totalSelected !== plan.sampleSize) reject('population or sample totals are inconsistent')
  if (plan.randomSourceVerification !== (plan.request.randomSource ? 'caller-declared-not-authenticated' : 'not-applicable')
    || plan.previousPlanVerification !== (plan.request.previousPlanHash ? 'not-evaluated' : 'not-applicable')) reject('declared trust boundaries are inconsistent')
})
export type SurveyQualitySamplingPlanV1 = z.infer<typeof SurveyQualitySamplingPlanV1>
