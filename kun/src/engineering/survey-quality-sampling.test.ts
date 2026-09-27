import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SurveyQualitySamplingPlanV1, SurveyQualitySamplingRequestV1, isSurveySamplingUnicode } from '../contracts/survey-quality-sampling.js'
import {
  GBT24356_SAMPLE_TABLE, GBT24356_SAMPLING_SOURCE, balancedMinimumBatches,
  createQualitySamplingPlan, qualitySamplingPopulationHash, samplingIndexFromUint32,
  table1SampleSize, verifyQualitySamplingPlan
} from './survey-quality-sampling.js'

function request(count = 30) {
  const ids = Array.from({ length: count }, (_, i) => `unit-${String(i + 1).padStart(3, '0')}`)
  return {
    schemaVersion: 1, projectId: 'sample-project', populationId: 'sample-population',
    productType: 'height-control', unitProductType: 'survey-section', definitionEvidenceSha256: '1'.repeat(64),
    orderedUnitProductIds: ids, populationHash: qualitySamplingPopulationHash(ids), stage: 'acceptance',
    inspectionMode: 'table-1-simple-random', round: 1,
    randomSource: { seedHex: '0'.repeat(64), sourceDescription: 'independent-test-seed', receiptSha256: '2'.repeat(64), trust: 'caller-declared-not-authenticated' }
  }
}

// Independent transcription from the visually reviewed table, not read from
// the implementation's exported table to generate expected sample sizes.
const intervals = [
  [1, 20, 3], [21, 40, 5], [41, 60, 7], [61, 80, 9], [81, 100, 10],
  [101, 120, 11], [121, 140, 12], [141, 160, 13], [161, 180, 14], [181, 200, 15],
  [201, 232, 17], [233, 282, 20], [283, 362, 24], [363, 487, 30], [488, 686, 40], [687, 1000, 56]
]

describe('GB/T 24356-2023 table 1 sampling only', () => {
  for (const [minimum, maximum, nominal] of intervals) it(`covers both inclusive endpoints ${minimum}..${maximum} → ${nominal}`, () => {
    for (const count of [minimum!, maximum!]) expect(table1SampleSize(count)).toEqual({ nominalSampleSize: nominal, sampleSize: Math.min(count, nominal!), census: count <= nominal! })
  })

  it('covers every table integer exactly once and binds its full transcription', () => {
    for (let count = 1; count <= 1000; count++) expect(intervals.filter(([minimum, maximum]) => minimum! <= count && count <= maximum!)).toHaveLength(1)
    expect(GBT24356_SAMPLE_TABLE).toEqual(intervals)
    expect(createHash('sha256').update(JSON.stringify(GBT24356_SAMPLE_TABLE)).digest('hex')).toBe(GBT24356_SAMPLING_SOURCE.tableSha256)
    expect(GBT24356_SAMPLING_SOURCE.tablePdfPage).toBe(8)
    expect(GBT24356_SAMPLING_SOURCE.tablePrintedPage).toBe(5)
  })

  it.each([1, 2, 3])('implements the table note as a census when population=%s', count => {
    const plan = createQualitySamplingPlan(request(count))
    expect(plan.sampleSize).toBe(count)
    expect(plan.batches[0]!.selectedUnitProductIds).toEqual(plan.request.orderedUnitProductIds)
    expect(plan.batches[0]!.randomDrawCount).toBe(0)
    expect(plan.batches[0]!.randomTranscriptSha256).toBeNull()
  })

  it.each([0, -1, 1.5, 1001, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid table batch %s', value => {
    expect(() => table1SampleSize(value)).toThrow('sampling_batch_size_outside_table')
  })

  it.each([
    [1, [1]], [1000, [1000]], [1001, [501, 500]], [1999, [1000, 999]],
    [2000, [1000, 1000]], [2001, [667, 667, 667]], [3001, [751, 750, 750, 750]]
  ])('uses the minimum balanced number of lots for %s', (count, expected) => {
    expect(balancedMinimumBatches(count as number)).toEqual(expected)
  })

  it('covers 100,000 units exactly with no duplicates, no remainder loss, and bounded equal lots', () => {
    const plan = createQualitySamplingPlan(request(100_000))
    expect(plan.batches).toHaveLength(100)
    expect(plan.batches.every(batch => batch.batchSize === 1000 && batch.sampleSize === 56)).toBe(true)
    expect(plan.batches.flatMap(batch => batch.unitProductIds)).toEqual(plan.request.orderedUnitProductIds)
    const selected = plan.batches.flatMap(batch => batch.selectedUnitProductIds)
    expect(new Set(selected).size).toBe(5600)
    expect(plan.sampleSize).toBe(5600)
    for (const batch of plan.batches) expect(batch.selectedUnitProductIds.every(id => batch.unitProductIds.includes(id))).toBe(true)
  })

  it('matches an independent Python hashlib/hmac replay, including the random transcript', () => {
    // Python 3 hashlib + hmac, UTF-8 compact JSON, 32-bit BE draws with
    // rejection, independently executed on 2026-09-20 for this fixed vector.
    const plan = createQualitySamplingPlan(request())
    expect(plan.request.populationHash).toBe('e4d9249b0acc89ec6b1b73a24f6f23ead0f4843912a85c792b7dd77785f1535a')
    expect(plan.requestHash).toBe('0ed73999c6a04b70b381d02a1ef66d8737c1c988e461940ea38bd1105dc17f96')
    // Full plan reassembled independently with Python hashlib/hmac on
    // 2026-09-20; adding the renderer-safe contract must not change hash bytes.
    expect(plan.planHash).toBe('095bb4e26f12f6c2274d4ed9cf9c18f35f9facdf3ec6f4d002b852b35a248b57')
    expect(plan.batches[0]!.selectedUnitProductIds).toEqual(['unit-019', 'unit-009', 'unit-030', 'unit-021', 'unit-027'])
    expect(plan.batches[0]!.randomDrawCount).toBe(5)
    expect(plan.batches[0]!.randomTranscriptSha256).toBe('68283403452db55f47c1201b9dd3a21b754a9351f2879c02c1e8ebcd70946807')
  })

  it('validates Unicode in the shared contract without Buffer and preserves exact identifiers', () => {
    const saved = globalThis.Buffer
    const valid = ['测段-甲', '测段-🛤️', 'e\u0301', '\ud800\udc00', 'a\u0000b']
    const invalid = ['\ud800', '\udc00', '\ud800x', 'x\udfff', '\ud800\ud800\udc00']
    const original = request()
    let results: boolean[]
    try {
      Object.defineProperty(globalThis, 'Buffer', { value: undefined, configurable: true, writable: true })
      results = [...valid, ...invalid].map(value => isSurveySamplingUnicode(value)
        && SurveyQualitySamplingRequestV1.safeParse({ ...original, orderedUnitProductIds: [value] }).success)
    } finally { Object.defineProperty(globalThis, 'Buffer', { value: saved, configurable: true, writable: true }) }
    expect(results!).toEqual([...valid.map(() => true), ...invalid.map(() => false)])
  })

  it('round-trips the complete response contract without changing request or plan serialization', () => {
    for (const count of [1, 30, 1001, 100_000]) {
      const plan = createQualitySamplingPlan(request(count))
      const parsed = SurveyQualitySamplingPlanV1.parse(plan)
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(plan))
    }
    const census = createQualitySamplingPlan({ ...request(1001), stage: 'final-office', inspectionMode: 'census', randomSource: undefined })
    expect(SurveyQualitySamplingPlanV1.parse(census)).toEqual(census)
  })

  it('rejects response identity shape, impossible samples, draws and misleading trust declarations', () => {
    const plan = createQualitySamplingPlan(request())
    const changes: Array<(value: unknown) => unknown> = [
      () => ({ ...plan, extra: true }), () => ({ ...plan, algorithmVersion: 'other' }),
      () => ({ ...plan, source: { ...plan.source, table: '2' } }),
      () => ({ ...plan, sampleSize: 99 }), () => ({ ...plan, randomSourceVerification: 'not-applicable' }),
      () => ({ ...plan, previousPlanVerification: 'not-evaluated' }), () => ({ ...plan, standardConformity: 'passed' }),
      () => ({ ...plan, batches: [{ ...plan.batches[0], batchIndex: 1 }] }),
      () => ({ ...plan, batches: [{ ...plan.batches[0], unitProductIds: [...plan.request.orderedUnitProductIds].reverse() }] }),
      () => ({ ...plan, batches: [{ ...plan.batches[0], selectedUnitProductIds: Array(5).fill('unit-001') }] }),
      () => ({ ...plan, batches: [{ ...plan.batches[0], selectedUnitProductIds: ['outside', ...plan.batches[0]!.selectedUnitProductIds.slice(1)] }] }),
      () => ({ ...plan, batches: [{ ...plan.batches[0], randomDrawCount: 0 }] }),
      () => ({ ...plan, batches: [{ ...plan.batches[0], randomTranscriptSha256: null }] })
    ]
    for (const change of changes) expect(SurveyQualitySamplingPlanV1.safeParse(change(plan)).success).toBe(false)
  })

  it('rejects the biased uint32 tail and never maps it by modulo', () => {
    expect(samplingIndexFromUint32(0xffff_ffff, 3)).toBeNull()
    expect(samplingIndexFromUint32(0xffff_fffe, 3)).toBe(2)
    expect(samplingIndexFromUint32(0xffff_ffff, 1000)).toBeNull()
    expect(samplingIndexFromUint32(4_294_966_999, 1000)).toBe(999)
    expect(samplingIndexFromUint32(4_294_967_000, 1000)).toBeNull()
    expect(samplingIndexFromUint32(0xffff_ffff, 1)).toBe(0)
    expect(samplingIndexFromUint32(0xffff_ffff, 256)).toBe(255)
    for (const [draw, width] of [[-1, 5], [2 ** 32, 5], [0.5, 5], [0, 0], [0, 1001]]) expect(() => samplingIndexFromUint32(draw!, width!)).toThrow()
  })

  it.each(['process', 'final-office'])('requires all units for %s and cannot silently apply the sampling table', stage => {
    expect(() => createQualitySamplingPlan({ ...request(), stage })).toThrow()
    const plan = createQualitySamplingPlan({ ...request(1001), stage, inspectionMode: 'census', randomSource: undefined })
    expect(plan.sampleSize).toBe(1001)
    expect(plan.batches.every(batch => batch.census)).toBe(true)
    expect(plan.randomSourceVerification).toBe('not-applicable')
  })

  it.each(['final-field', 'acceptance'])('allows a full census or a versioned sample for %s', stage => {
    expect(createQualitySamplingPlan({ ...request(), stage }).sampleSize).toBe(5)
    expect(createQualitySamplingPlan({ ...request(), stage, inspectionMode: 'census', randomSource: undefined }).sampleSize).toBe(30)
  })

  it('binds the ordered, unique population and rejects missing or ambiguous unit products', () => {
    const initial = request()
    expect(() => createQualitySamplingPlan({ ...initial, orderedUnitProductIds: [...initial.orderedUnitProductIds].reverse() })).toThrow('sampling_population_hash_mismatch')
    for (const ids of [[], ['x', 'x'], [' '], [' x'], ['x '], ['\ud800']]) {
      expect(() => qualitySamplingPopulationHash(ids)).toThrow('sampling_invalid_population_frame')
      expect(() => createQualitySamplingPlan({ ...initial, orderedUnitProductIds: ids })).toThrow()
    }
    for (const change of [{ productType: '' }, { unitProductType: '' }, { definitionEvidenceSha256: 'unknown' }, { populationHash: '0'.repeat(64) }, { unitProductCount: 30 }]) expect(() => createQualitySamplingPlan({ ...initial, ...change })).toThrow()
    expect(() => balancedMinimumBatches(100_001)).toThrow()
  })

  it('requires declared random material without pretending it has been authenticated', () => {
    const initial = request()
    for (const randomSource of [undefined, { ...initial.randomSource, seedHex: 'abc' }, { ...initial.randomSource, trust: 'verified' }, { ...initial.randomSource, receiptSha256: '' }]) expect(() => createQualitySamplingPlan({ ...initial, randomSource })).toThrow()
    const plan = createQualitySamplingPlan(initial)
    expect(plan).toMatchObject({ decision: 'not-evaluated', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated', spatialUniformity: 'not-evaluated', populationCompleteness: 'caller-declared-not-verified', randomSourceVerification: 'caller-declared-not-authenticated' })
    expect(plan.sampleMaterialScope).toContain('all-materials')
  })

  it('replays immutably and detects changes to sample lists, hashes, source attribution and assumptions', () => {
    const initial = request(), before = structuredClone(initial)
    Object.freeze(initial.orderedUnitProductIds); Object.freeze(initial.randomSource); Object.freeze(initial)
    const plan = createQualitySamplingPlan(initial)
    expect(initial).toEqual(before)
    expect(createQualitySamplingPlan(initial)).toEqual(plan)
    expect(verifyQualitySamplingPlan(plan)).toBe(true)
    for (const mutate of [
      (changed: typeof plan) => { changed.batches[0]!.selectedUnitProductIds[0] = 'not-in-population' },
      (changed: typeof plan) => { changed.planHash = '0'.repeat(64) },
      (changed: typeof plan) => { (changed.source as { sourceSha256: string }).sourceSha256 = '0'.repeat(64) },
      (changed: typeof plan) => { changed.batches[0]!.sampleSize = 1 }
    ]) {
      const changed = structuredClone(plan); mutate(changed)
      expect(verifyQualitySamplingPlan(changed)).toBe(false)
    }
  })

  it('requires a new linked round for resampling and preserves the former record', () => {
    const initial = request(), first = createQualitySamplingPlan(initial)
    expect(() => createQualitySamplingPlan({ ...initial, round: 2 })).toThrow()
    expect(() => createQualitySamplingPlan({ ...initial, previousPlanHash: first.planHash })).toThrow()
    const second = createQualitySamplingPlan({ ...initial, round: 2, previousPlanHash: first.planHash })
    expect(second.planHash).not.toBe(first.planHash)
    expect(second.request.previousPlanHash).toBe(first.planHash)
    expect(second.previousPlanVerification).toBe('not-evaluated')
    expect(second.batches[0]!.randomTranscriptSha256).not.toBe(first.batches[0]!.randomTranscriptSha256)
    expect(verifyQualitySamplingPlan(first)).toBe(true)
    // A random second sample may legitimately overlap the first; the standard
    // does not prescribe disjoint samples, so no artificial exclusion is used.
  })
})
