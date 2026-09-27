import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createQualitySamplingPlan, qualitySamplingPopulationHash } from '../engineering/survey-quality-sampling.js'
import {
  SurveySamplingPopulationCreateV1, SurveySamplingPopulationDetailV1, SurveySamplingPopulationRecordV1,
  SurveySamplingPopulationListV1, SurveySamplingRunCreateV1, SurveySamplingRunSummaryV1, SurveySamplingRunRecordV1,
  SurveySamplingUnitPageV1, SurveySamplingSamplePageV1, SurveySamplingVerificationV1
} from './survey-quality-sampling-workspace.js'

const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const hash = 'a'.repeat(64), time = '2026-09-20T09:00:00.000Z'
function fixture() {
  const body = { idempotencyKey: 'freeze-frame-key', expectedProjectRevision: 1, productType: '水准成果', unitProductType: '测段',
    definitionStatement: '声明：每个编号为一份独立测段成果。\n不是专业签认。\n', orderedUnitProductIds: Array.from({ length: 30 }, (_, index) => `unit-${index + 1}`) }
  const population = { schemaVersion: 1, id: 'population', projectId: 'project', projectRevision: 1, projectBindingHash: hash,
    productType: body.productType, unitProductType: body.unitProductType, definitionEvidenceSha256: digest(body.definitionStatement),
    definitionSizeBytes: new TextEncoder().encode(body.definitionStatement).byteLength, populationHash: qualitySamplingPopulationHash(body.orderedUnitProductIds),
    unitCount: body.orderedUnitProductIds.length, createdAt: time, definitionTrust: 'user-declared-not-professionally-verified',
    populationCompleteness: 'caller-declared-not-verified', definitionStatement: body.definitionStatement, orderedUnitProductIds: body.orderedUnitProductIds }
  const plan = createQualitySamplingPlan({ schemaVersion: 1, projectId: population.projectId, populationId: population.id,
    productType: body.productType, unitProductType: body.unitProductType, definitionEvidenceSha256: population.definitionEvidenceSha256,
    orderedUnitProductIds: population.orderedUnitProductIds, populationHash: population.populationHash, stage: 'acceptance', inspectionMode: 'table-1-simple-random', round: 1,
    randomSource: { seedHex: '0'.repeat(64), receiptSha256: hash, sourceDescription: 'runtime-crypto-randomBytes-32/local-unwitnessed', trust: 'caller-declared-not-authenticated' } })
  const summary = { schemaVersion: 1, id: 'sample-run', projectId: population.projectId, projectRevision: 1, projectBindingHash: hash,
    populationId: population.id, populationHash: population.populationHash, definitionEvidenceSha256: population.definitionEvidenceSha256,
    unitCount: population.unitCount, stage: plan.request.stage, inspectionMode: plan.request.inspectionMode, round: 1,
    algorithmVersion: plan.algorithmVersion, source: plan.source, requestHash: plan.requestHash, planHash: plan.planHash, runHash: hash,
    sampleSize: plan.sampleSize, batchCount: plan.batches.length,
    batches: plan.batches.map(({ batchIndex, batchSize, nominalTableSampleSize, sampleSize, census }) => ({ batchIndex, batchSize, nominalTableSampleSize, sampleSize, census })),
    randomSource: 'runtime-generated-local-unwitnessed', createdAt: time, decision: 'not-evaluated', standardConformity: 'not-evaluated',
    humanSignatureVerification: 'not-evaluated', populationCompleteness: 'caller-declared-not-verified', spatialUniformity: 'not-evaluated' }
  return { body, population, plan, summary }
}

describe('first-round sampling workspace data contracts', () => {
  it('preserves the actual declared UTF-8 text and rejects inferred trust, invalid Unicode and byte-count mismatch', () => {
    const { body, population } = fixture()
    expect(SurveySamplingPopulationCreateV1.parse(body).definitionStatement).toBe(body.definitionStatement)
    expect(SurveySamplingPopulationRecordV1.parse(population).definitionEvidenceSha256).toBe(digest(body.definitionStatement))
    const { orderedUnitProductIds: _ids, ...detail } = population
    expect(SurveySamplingPopulationDetailV1.parse(detail).definitionStatement).toBe(body.definitionStatement)
    for (const definitionStatement of ['', '   ', '\ud800', '中'.repeat(21_846)]) expect(SurveySamplingPopulationCreateV1.safeParse({ ...body, definitionStatement }).success).toBe(false)
    expect(SurveySamplingPopulationDetailV1.safeParse({ ...detail, definitionSizeBytes: 1 }).success).toBe(false)
    expect(SurveySamplingPopulationRecordV1.safeParse({ ...population, unitCount: 31 }).success).toBe(false)
    expect(SurveySamplingPopulationRecordV1.safeParse({ ...population, definitionTrust: 'professionally-verified' }).success).toBe(false)
  })

  it('bounds both unit count and serialized UTF-8 bytes without truncation', () => {
    const { body } = fixture()
    const ids = Array.from({ length: 10_000 }, (_, index) => `unit-${index}`)
    expect(SurveySamplingPopulationCreateV1.safeParse({ ...body, orderedUnitProductIds: ids }).success).toBe(true)
    expect(SurveySamplingPopulationCreateV1.safeParse({ ...body, orderedUnitProductIds: [...ids, 'unit-10000'] }).success).toBe(false)
    expect(SurveySamplingPopulationCreateV1.safeParse({ ...body, orderedUnitProductIds: ids.map(value => `${'中'.repeat(100)}${value}`) }).success).toBe(false)
    expect(SurveySamplingPopulationCreateV1.safeParse({ ...body, orderedUnitProductIds: ['same', 'same'] }).success).toBe(false)
  })

  it('accepts only explicit client declarations and first-round server-computed sampling requests', () => {
    const { body } = fixture()
    for (const extra of [{ populationHash: hash }, { definitionEvidenceSha256: hash }, { seedHex: hash }, { actor: 'professional' }, { conclusion: 'passed' }]) {
      expect(SurveySamplingPopulationCreateV1.safeParse({ ...body, ...extra }).success).toBe(false)
    }
    const request = { populationId: 'population', idempotencyKey: 'draw-first-key', stage: 'acceptance', inspectionMode: 'table-1-simple-random' }
    expect(SurveySamplingRunCreateV1.parse(request)).toEqual(request)
    for (const extra of [{ round: 1 }, { round: 2 }, { seedHex: hash }, { plan: {} }, { actor: 'system' }, { decision: 'passed' }, { previousPlanHash: hash }]) expect(SurveySamplingRunCreateV1.safeParse({ ...request, ...extra }).success).toBe(false)
    for (const stage of ['process', 'final-office']) {
      expect(SurveySamplingRunCreateV1.safeParse({ ...request, stage }).success).toBe(false)
      expect(SurveySamplingRunCreateV1.safeParse({ ...request, stage, inspectionMode: 'census' }).success).toBe(true)
    }
  })

  it('binds stored runs to exact plan identities, counts, source and the first round', () => {
    const { plan, summary } = fixture()
    expect(SurveySamplingRunSummaryV1.safeParse(summary).success).toBe(true)
    expect(SurveySamplingRunRecordV1.safeParse({ ...summary, plan }).success).toBe(true)
    for (const change of [{ populationId: 'other' }, { projectId: 'other' }, { populationHash: 'b'.repeat(64) },
      { definitionEvidenceSha256: 'b'.repeat(64) }, { requestHash: 'b'.repeat(64) }, { planHash: 'b'.repeat(64) },
      { unitCount: 31 }, { sampleSize: 1 }, { round: 2 }, { randomSource: 'verified' }, { standardConformity: 'passed' }]) {
      expect(SurveySamplingRunRecordV1.safeParse({ ...summary, ...change, plan }).success).toBe(false)
    }
    const second = createQualitySamplingPlan({ ...plan.request, round: 2, previousPlanHash: plan.planHash })
    expect(SurveySamplingRunRecordV1.safeParse({ ...summary, requestHash: second.requestHash, planHash: second.planHash, plan: second }).success).toBe(false)
  })

  it('serves bounded contiguous pages without exposing seed/frame in run metadata', () => {
    const { summary, plan, population } = fixture()
    expect(SurveySamplingRunSummaryV1.safeParse({ ...summary, plan }).success).toBe(false)
    expect(SurveySamplingRunSummaryV1.safeParse({ ...summary, seedHex: '0'.repeat(64) }).success).toBe(false)
    const page = { projectId: 'project', populationId: 'population', populationHash: population.populationHash,
      offset: 0, total: 30, units: [{ index: 0, unitProductId: 'unit-1' }], nextOffset: 1 }
    expect(SurveySamplingUnitPageV1.safeParse(page).success).toBe(true)
    for (const change of [{ nextOffset: null }, { nextOffset: 0 }, { offset: 1 }, { units: [] }, { units: [{ index: 0, unitProductId: 'u' }, { index: 1, unitProductId: 'u' }], nextOffset: 2 }]) {
      expect(SurveySamplingUnitPageV1.safeParse({ ...page, ...change }).success).toBe(false)
    }
    expect(SurveySamplingUnitPageV1.safeParse({ ...page, offset: 30, units: [], nextOffset: null }).success).toBe(true)
    const samples = plan.batches.flatMap(batch => batch.selectedUnitProductIds.map(unitProductId => ({ batchIndex: batch.batchIndex, unitProductId }))).map((item, index) => ({ index, ...item }))
    expect(SurveySamplingSamplePageV1.safeParse({ projectId: 'project', runId: summary.id, planHash: plan.planHash, offset: 0, total: 5, samples, nextOffset: null }).success).toBe(true)
  })

  it('keeps unavailable history IDs bounded, distinct and separate from verified records', () => {
    const { population } = fixture()
    const { definitionStatement: _statement, orderedUnitProductIds: _ids, ...summary } = population
    expect(SurveySamplingPopulationListV1.safeParse({ populations: [summary], unavailable: [{ id: 'old', reason: 'stale' }], nextOffset: null }).success).toBe(true)
    expect(SurveySamplingPopulationListV1.safeParse({ populations: [summary], unavailable: [{ id: summary.id, reason: 'stale' }], nextOffset: null }).success).toBe(false)
    expect(SurveySamplingPopulationListV1.safeParse({ populations: [], unavailable: Array.from({ length: 101 }, (_, i) => ({ id: `bad-${i}`, reason: 'integrity' })), nextOffset: null }).success).toBe(false)
  })

  it('verification never authenticates a person, external checkpoint or quality outcome', () => {
    const { summary } = fixture()
    const result = { schemaVersion: 1, projectId: summary.projectId, populationId: summary.populationId, runId: summary.id,
      planHash: summary.planHash, runHash: summary.runHash, checkedAt: time, recordIntegrity: 'verified', recomputed: true,
      checkpointTrust: 'local-records-only', decision: 'not-evaluated', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated',
      populationCompleteness: 'caller-declared-not-verified', spatialUniformity: 'not-evaluated' }
    expect(SurveySamplingVerificationV1.safeParse(result).success).toBe(true)
    for (const change of [{ decision: 'passed' }, { checkpointTrust: 'independent' }, { humanSignatureVerification: 'verified' }, { recomputed: false }]) expect(SurveySamplingVerificationV1.safeParse({ ...result, ...change }).success).toBe(false)
  })
})
