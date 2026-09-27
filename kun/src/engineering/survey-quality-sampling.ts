import { createHash, createHmac } from 'node:crypto'
import { SurveyQualitySamplingRequestV1 } from '../contracts/survey-quality-sampling.js'

/** Visually transcribed in full from printed page 5 / PDF page 8, table 1.
 * Values are inclusive [minimum batch size, maximum batch size, sample size]. */
export const GBT24356_SAMPLE_TABLE = Object.freeze([
  [1, 20, 3], [21, 40, 5], [41, 60, 7], [61, 80, 9],
  [81, 100, 10], [101, 120, 11], [121, 140, 12], [141, 160, 13],
  [161, 180, 14], [181, 200, 15], [201, 232, 17], [233, 282, 20],
  [283, 362, 24], [363, 487, 30], [488, 686, 40], [687, 1000, 56]
].map(row => Object.freeze(row)))

export const GBT24356_SAMPLING_SOURCE = Object.freeze({
  standard: 'GB/T 24356-2023', table: '1', clauses: '4.2.2(b);4.2.3(b);4.2.4(c);5.1;5.2;5.3',
  officialUrl: 'https://zrzy.guizhou.gov.cn/wzgb/ztzl/lszt/zrzyzljc/202308/P020230829590929227708.pdf',
  sourceSha256: '96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487',
  tablePrintedPage: 5, tablePdfPage: 8,
  /** Existing reviewed PNG bytes, not a promise of renderer-independent pixels. */
  tablePagePngSha256: '6bf3dbeaa964903ab5504c8a3cad2a4c7e1f3e97d7ddf10f6153f4b4aaa9d79c',
  stagePdfPage: 6, stagePagePngSha256: '94f9323e9653435a1e14c36ed79c04a898a7150c09282790cc4dfdaa667e9617',
  sampleMaterialsPdfPage: 9, sampleMaterialsPagePngSha256: '5575818fd93325a1c6914f745bb96a848a20d68d3375b0b9f1bfd923669f5b9f',
  tableEncoding: 'utf8-json-array-of-inclusive-min-max-nominal-size-triples',
  tableSha256: '1a5e4aa0cf43412f0663f6ce619d829a703c84dc7c3b67c1eb7c626fa402c363',
  reviewIdentity: 'agent-source-transcription-not-professional-signoff'
})

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

export function table1SampleSize(batchSize: number) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('sampling_batch_size_outside_table')
  const row = GBT24356_SAMPLE_TABLE.find(([minimum, maximum]) => batchSize >= minimum! && batchSize <= maximum!)!
  return { nominalSampleSize: row[2]!, sampleSize: Math.min(batchSize, row[2]!), census: batchSize <= row[2]! }
}

/** Minimum count of batches with maximum 1000 and integer sizes differing by
 * at most one. Extra units go to the first batches, a documented software tie
 * breaker rather than an extra rule attributed to the standard. */
export function balancedMinimumBatches(populationSize: number): number[] {
  if (!Number.isSafeInteger(populationSize) || populationSize < 1 || populationSize > 100_000) throw new Error('sampling_population_size_outside_limit')
  const count = Math.ceil(populationSize / 1000), base = Math.floor(populationSize / count), remainder = populationSize % count
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0))
}

/** Ordered frame hash. Different orders are different frames and change batch
 * membership; this cannot certify population completeness or unit definition. */
export function qualitySamplingPopulationHash(orderedUnitProductIds: readonly string[]): string {
  if (!orderedUnitProductIds.length || orderedUnitProductIds.length > 100_000
    || new Set(orderedUnitProductIds).size !== orderedUnitProductIds.length
    || orderedUnitProductIds.some(id => typeof id !== 'string' || !id.length || id.length > 200 || id.trim() !== id || Buffer.from(id, 'utf8').toString('utf8') !== id)) throw new Error('sampling_invalid_population_frame')
  return digest(JSON.stringify(['survey-unit-product-frame-1', orderedUnitProductIds]))
}

/** A null result consumes the draw but selects nothing: the rejected upper
 * tail removes modulo bias. Exposed for exact boundary verification. */
export function samplingIndexFromUint32(draw: number, width: number): number | null {
  if (!Number.isInteger(draw) || draw < 0 || draw >= 0x1_0000_0000 || !Number.isInteger(width) || width < 1 || width > 1000) throw new Error('sampling_invalid_random_draw')
  const threshold = Math.floor(0x1_0000_0000 / width) * width
  return draw >= threshold ? null : draw % width
}

/** Pure deterministic plan. HMAC counter expansion + uint32 rejection sampling
 * + partial Fisher-Yates is an implementation choice, NOT specified by GB/T.
 * One block per draw prevents architecture/endianness-dependent buffering.
 * Uniform selection relies on independently, uniformly generated seed material;
 * this pure function cannot authenticate that source or prevent seed shopping. */
export function createQualitySamplingPlan(input: unknown) {
  const request = SurveyQualitySamplingRequestV1.parse(input)
  if (qualitySamplingPopulationHash(request.orderedUnitProductIds) !== request.populationHash) throw new Error('sampling_population_hash_mismatch')
  const requestHash = digest(JSON.stringify(request))
  const batchSizes = balancedMinimumBatches(request.orderedUnitProductIds.length)
  let offset = 0
  const batches = batchSizes.map((batchSize, batchIndex) => {
    const unitProductIds = request.orderedUnitProductIds.slice(offset, offset + batchSize)
    offset += batchSize
    const table = table1SampleSize(batchSize)
    const sampleSize = request.inspectionMode === 'census' ? batchSize : table.sampleSize
    const census = sampleSize === batchSize
    const pool = [...unitProductIds]
    let counter = 0, rejectedDraws = 0
    const transcript = createHash('sha256')
    if (!census) {
      const domain = JSON.stringify(['quality-sampling-hmac-sha256-fy-1', requestHash, batchIndex])
      for (let i = 0; i < sampleSize; i++) {
        const width = batchSize - i
        let index: number | null
        do {
          if (counter >= 100_000) throw new Error('sampling_random_draw_limit')
          const block = createHmac('sha256', Buffer.from(request.randomSource!.seedHex, 'hex')).update(`${domain}\n${counter}`).digest()
          transcript.update(block)
          index = samplingIndexFromUint32(block.readUInt32BE(0), width); counter++
          if (index === null) rejectedDraws++
        } while (index === null)
        const selected = i + index
        ;[pool[i], pool[selected]] = [pool[selected]!, pool[i]!]
      }
    }
    return {
      batchIndex, batchSize, unitProductIds, nominalTableSampleSize: table.nominalSampleSize,
      sampleSize, census, selectedUnitProductIds: pool.slice(0, sampleSize),
      randomDrawCount: counter, rejectedDrawCount: rejectedDraws,
      randomTranscriptSha256: census ? null : transcript.digest('hex')
    }
  })
  const plan = {
    schemaVersion: 1 as const, algorithmVersion: 'quality-sampling-hmac-sha256-fy-1' as const,
    source: { ...GBT24356_SAMPLING_SOURCE }, request, requestHash,
    batchingPolicy: 'minimum-count-balanced-contiguous-input-frame-extra-first' as const,
    batches, sampleSize: batches.reduce((sum, batch) => sum + batch.sampleSize, 0),
    decision: 'not-evaluated' as const, standardConformity: 'not-evaluated' as const,
    humanSignatureVerification: 'not-evaluated' as const,
    populationCompleteness: 'caller-declared-not-verified' as const,
    spatialUniformity: 'not-evaluated' as const,
    randomSourceVerification: request.randomSource ? 'caller-declared-not-authenticated' as const : 'not-applicable' as const,
    previousPlanVerification: request.previousPlanHash ? 'not-evaluated' as const : 'not-applicable' as const,
    sampleMaterialScope: 'all-materials-of-selected-unit-products-and-clause-5.3.3-supplementary-materials' as const,
    exclusions: ['no-stratified-proportional-sampling', 'no-quality-scoring', 'no-stage-completion', 'no-unit-product-inference', 'no-professional-signoff']
  }
  return { ...plan, planHash: digest(JSON.stringify(plan)) }
}

/** Tamper/replay check against a freshly computed plan; no stored status is
 * trusted, and the seed receipt is still only a caller-supplied claim. */
export function verifyQualitySamplingPlan(plan: ReturnType<typeof createQualitySamplingPlan>): boolean {
  try { return JSON.stringify(createQualitySamplingPlan(plan.request)) === JSON.stringify(plan) } catch { return false }
}
