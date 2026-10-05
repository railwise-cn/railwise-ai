import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it, onTestFinished } from 'vitest'
import { SurveyNetworkV1, type SurveyNetworkV1 as SurveyNetwork } from '../contracts/survey.js'
import type { SurveyProfessionalReviewV1 } from '../contracts/survey-professional.js'
import { SurveyObservationLayerIdentifiabilityV1, SurveyRawObservationCongruenceV1 } from '../contracts/survey-monitoring.js'
import { SurveyMonitoringRecords } from './survey-monitoring-records.js'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'
import { Router } from '../server/router.js'
import { registerSurveyMonitoringRoutes } from '../server/routes/survey-monitoring.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'survey-monitoring-'))
  const service = new SurveyService({ rootDir: root })
  onTestFinished(() => service.close())
  const outputs = []
  for (let period = 0; period < 3; period++) {
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'monitoring', expectedRevision: 0, idempotencyKey: `monitoring-import-${period}`,
      network: { networkType: 'leveling', coordinateSystem: 'LOCAL', verticalDatum: 'LOCAL-BM', observationEpoch: `2026-09-0${period + 1}T00:00:00.000Z`,
        knownPoints: [{ id: 'BM', height: 10, known: true }], unknownPoints: [{ id: 'P', height: 11 }],
        observations: [
          { id: 'fwd', type: 'height-difference', from: 'BM', to: 'P', value: 1-period*0.002, unit: 'm', routeLength: 100 },
          { id: 'back', type: 'height-difference', from: 'P', to: 'BM', value: -1+period*0.002, unit: 'm', routeLength: 100 }
        ] }
    })
    const checked = service.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: `monitoring-validate-${period}` })
    outputs.push(service.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: `monitoring-adjust-${period}` }))
  }
  const request = {
    referenceAdjustmentId: outputs[0]!.run.id, currentAdjustmentId: outputs[1]!.run.id,
    segments: [{ id: 'BM-P', from: 'BM', to: 'P', referenceObservationIds: ['fwd'], currentObservationIds: ['back'] }],
    idempotencyKey: 'monitoring-segment-comparison'
  }
  return { root, service, outputs, request }
}

function rawLayerFixture(options: { referencePoint?: 'none' | 'disconnected' | 'connected'; randomModel?: boolean; movement?: [number, number] } = {}) {
  const db = new Database(':memory:')
  const control: SurveyNetwork['knownPoints'] = options.referencePoint === 'disconnected'
    ? [{ id: 'CTRL', pointClass: 'known', known: true, height: 0 }]
    : options.referencePoint === 'connected'
      ? [{ id: 'BM', pointClass: 'known', known: true, height: 10 }]
      : []
  const network = (id: string): SurveyNetwork => SurveyNetworkV1.parse({
    schemaVersion: 1, id, projectId: 'raw-layer', networkType: 'leveling', coordinateSystem: 'LOCAL', projection: 'LOCAL', ellipsoid: 'LOCAL', verticalDatum: 'LOCAL', unit: 'm',
    knownPoints: control, unknownPoints: [{ id: 'BM', pointClass: 'unknown', known: false, height: 10 }, { id: 'P', pointClass: 'unknown', known: false, height: 11 }, { id: 'Q', pointClass: 'unknown', known: false, height: 13 }], observations: (() => {
      const change = id === 'network-reference' ? 0 : (options.movement?.[0] ?? 0)
      const secondChange = id === 'network-reference' ? 0 : (options.movement?.[1] ?? 0)
      return [
        { id: 'fwd', type: 'height-difference', from: 'BM', to: 'P', value: 1 + change, unit: 'm', ...(options.randomModel === false ? {} : { sigma: 0.001, sigmaUnit: 'm' }), sourceRecordId: 'raw-fwd' },
        { id: 'back', type: 'height-difference', from: 'P', to: 'BM', value: -1 - change, unit: 'm', ...(options.randomModel === false ? {} : { sigma: 0.001, sigmaUnit: 'm' }), sourceRecordId: 'raw-back' },
        { id: 'p-q', type: 'height-difference', from: 'P', to: 'Q', value: 2 + secondChange, unit: 'm', ...(options.randomModel === false ? {} : { sigma: 0.001, sigmaUnit: 'm' }), sourceRecordId: 'raw-p-q' }
      ]
    })(),
    observationEpoch: id === 'network-reference' ? '2026-10-01T00:00:00.000Z' : '2026-10-02T00:00:00.000Z',
    instrumentParameters: {}, qualityStatus: 'validated', findings: [], revision: 1, createdAt: '2026-10-01', updatedAt: '2026-10-01'
  })
  const review = (id: string): SurveyProfessionalReviewV1 => ({
    schemaVersion: 1, projectionVersion: 'survey-professional-review-1', projectId: 'raw-layer', networkId: id, runId: `run-${id}`, resultId: `result-${id}`, inputHash: `input-${id}`,
    resultHash: 'a'.repeat(64), projectionHash: 'b'.repeat(64), algorithmVersion: 'test', resultCreatedAt: '2026-10-01',
    source: { networkRevision: 1, sha256: 'c'.repeat(64), status: 'bound', integrity: 'verified', anchoredObservationCount: 2, missingAnchorObservationIds: [] },
    reference: { coordinateSystem: 'LOCAL', projection: 'LOCAL', ellipsoid: 'LOCAL', verticalDatum: 'LOCAL', linearUnit: 'm', angularUnit: 'rad', knownPoints: control, status: control.length ? 'declared' : 'incomplete' },
    summary: { networkType: 'leveling', observationCount: 2, pointCount: 3, degreesOfFreedom: 1, unitWeightStdDev: 1, varianceFactor: 1, varianceBasis: 'a-priori', validation: 'valid' },
    closures: [], residualNorms: [{ unit: 'm', value: 0, count: 3, status: 'descriptive-only' }], observations: network(id).observations.map(observation => ({ id: observation.id, observationId: observation.id, type: observation.type, from: observation.from, to: observation.to, rawValue: observation.value, rawUnit: observation.unit, observed: observation.value, adjusted: observation.value, correction: 0, residual: 0, unit: 'm', sourceRecordId: observation.sourceRecordId, outlierCandidate: false, screeningStatus: 'legacy-not-recorded' as const })), points: [], weakestPoint: { status: 'not-evaluated', criterion: 'largest-reported-point-standard-error', reason: 'no-point-standard-errors' }, weakestEdge: { status: 'not-evaluated', reason: 'cross-covariance-unavailable' }, checks: [], reviewStatus: 'unsigned', standardsConformity: 'not-evaluated'
  })
  const reviews = new Map(['reference', 'current'].map((period, index) => [`run-${period}`, review(`network-${period}`)]))
  const surveys = {
    getAdjustmentForProjectNewUse: (_projectId: string, id: string) => ({ run: { id, projectId: 'raw-layer', networkId: id === 'run-reference' ? 'network-reference' : 'network-current' }, result: {} }),
    getProfessionalReview: (id: string) => reviews.get(id) ?? null,
    getNetwork: (id: string) => network(id)
  }
  const records = new SurveyMonitoringRecords(db, surveys as unknown as SurveyService, () => '2026-10-01T00:00:00.000Z')
  return { db, records, request: { referenceAdjustmentId: 'run-reference', currentAdjustmentId: 'run-current', segments: [{ id: 'BM-P', from: 'BM', to: 'P', referenceObservationIds: ['fwd'], currentObservationIds: ['fwd'] }], idempotencyKey: `raw-layer-${options.referencePoint ?? 'none'}-${options.randomModel ?? true}` } }
}

describe('professional monitoring history', () => {
  it('compares explicit signed routes and retains reproducible values without changing source/results', async () => {
    const { service, outputs, request } = await fixture()
    const before = outputs.map(output => service.getAdjustment(output.run.id))
    const result = service.comparePeriodSegments('monitoring', request)
    expect(result.segments[0]).toMatchObject({
      referenceObservedMetres: 1, currentObservedMetres: 0.998,
      observedChangeMetres: expect.closeTo(-0.002, 12), adjustedChangeMetres: expect.closeTo(-0.002, 12),
      interpretation: 'current-minus-reference-height-difference', standardsConformity: 'not-evaluated'
    })
    expect(service.comparePeriodSegments('monitoring', request)).toEqual(result)
    expect(outputs.map(output => service.getAdjustment(output.run.id))).toEqual(before)
    expect(() => service.comparePeriodSegments('other-project', request)).toThrow()
    expect(() => service.comparePeriodSegments('monitoring', { ...request, segments: [{ ...request.segments[0], to: 'Q' }] })).toThrow('endpoint')
    expect(() => service.comparePeriodSegments('monitoring', { ...request, segments: [{ ...request.segments[0], currentObservationIds: ['back', 'back'] }] })).toThrow('duplicate')
  })

  it('marks a bound comparison unavailable when the raw observation random model is absent', () => {
    const { db, records, request } = rawLayerFixture({ referencePoint: 'connected', randomModel: false })
    onTestFinished(() => { db.close() })
    const result = records.compareSegments('raw-layer', request)
    expect(result.observationIdentifiability).toEqual({ status: 'unavailable', reason: 'raw-random-model-unavailable', referencePointCount: 1, connectedReferencePointCount: 1, rawRandomModel: 'unavailable' })
    expect(result.rawObservationCongruence).toMatchObject({ status: 'unavailable', reason: 'raw-random-model-unavailable', trialOnly: true, engineeringDecision: 'not-evaluated' })
  })

  it('uses explicit unavailable reasons for insufficient and disconnected references', () => {
    const insufficient = rawLayerFixture({ referencePoint: 'none', randomModel: true })
    onTestFinished(() => { insufficient.db.close() })
    expect(insufficient.records.compareSegments('raw-layer', insufficient.request).observationIdentifiability).toEqual({ status: 'unavailable', reason: 'reference-point-insufficient', referencePointCount: 0, connectedReferencePointCount: 0, rawRandomModel: 'provided' })

    const disconnected = rawLayerFixture({ referencePoint: 'disconnected', randomModel: true })
    onTestFinished(() => { disconnected.db.close() })
    expect(disconnected.records.compareSegments('raw-layer', disconnected.request).observationIdentifiability).toEqual({ status: 'unavailable', reason: 'overall-translation-unidentifiable', referencePointCount: 1, connectedReferencePointCount: 0, rawRandomModel: 'provided' })
  })

  it('validates identifiability contract states while keeping legacy comparisons optional', () => {
    expect(SurveyObservationLayerIdentifiabilityV1.parse({ status: 'available', referencePointCount: 1, connectedReferencePointCount: 1, rawRandomModel: 'provided' })).toMatchObject({ status: 'available' })
    expect(() => SurveyObservationLayerIdentifiabilityV1.parse({ status: 'available', referencePointCount: 0, connectedReferencePointCount: 0, rawRandomModel: 'provided' })).toThrow()
    expect(() => SurveyObservationLayerIdentifiabilityV1.parse({ status: 'unavailable', referencePointCount: 1, connectedReferencePointCount: 0, rawRandomModel: 'provided' })).toThrow()
  })

  it('classifies a bound two-segment raw comparison as common movement in trial-only mode', () => {
    const fixture = rawLayerFixture({ referencePoint: 'connected', movement: [0.002, 0.002] })
    onTestFinished(() => { fixture.db.close() })
    const result = fixture.records.compareSegments('raw-layer', {
      ...fixture.request,
      segments: [
        { id: 'BM-P', from: 'BM', to: 'P', referenceObservationIds: ['fwd'], currentObservationIds: ['fwd'] },
        { id: 'P-Q', from: 'P', to: 'Q', referenceObservationIds: ['p-q'], currentObservationIds: ['p-q'] }
      ],
      idempotencyKey: 'raw-layer-common-movement'
    })
    expect(result.rawObservationCongruence).toMatchObject({ status: 'common-movement', trialOnly: true, engineeringDecision: 'not-evaluated', segmentCount: 2 })
    expect(() => SurveyRawObservationCongruenceV1.parse(result.rawObservationCongruence)).not.toThrow()
  })

  it('labels zero selected height-difference change as an unidentifiable overall translation', () => {
    const fixture = rawLayerFixture({ referencePoint: 'connected', movement: [0, 0] })
    onTestFinished(() => { fixture.db.close() })
    const result = fixture.records.compareSegments('raw-layer', {
      ...fixture.request,
      segments: [
        { id: 'BM-P', from: 'BM', to: 'P', referenceObservationIds: ['fwd'], currentObservationIds: ['fwd'] },
        { id: 'P-Q', from: 'P', to: 'Q', referenceObservationIds: ['p-q'], currentObservationIds: ['p-q'] }
      ],
      idempotencyKey: 'raw-layer-overall-translation'
    })
    expect(result.rawObservationCongruence).toMatchObject({ status: 'overall-translation', trialOnly: true, engineeringDecision: 'not-evaluated', segmentCount: 2, meanObservedChangeMetres: 0 })
  })

  it('does not force inconsistent segment changes into a movement conclusion', () => {
    const fixture = rawLayerFixture({ referencePoint: 'connected', movement: [0.002, 0.02] })
    onTestFinished(() => { fixture.db.close() })
    const result = fixture.records.compareSegments('raw-layer', {
      ...fixture.request,
      segments: [
        { id: 'BM-P', from: 'BM', to: 'P', referenceObservationIds: ['fwd'], currentObservationIds: ['fwd'] },
        { id: 'P-Q', from: 'P', to: 'Q', referenceObservationIds: ['p-q'], currentObservationIds: ['p-q'] }
      ],
      idempotencyKey: 'raw-layer-inconsistent'
    })
    expect(result.rawObservationCongruence).toMatchObject({ status: 'unavailable', reason: 'inconsistent-segment-differences', trialOnly: true, engineeringDecision: 'not-evaluated' })
  })

  it('reconstructs cumulative changes only from an adjacent, identity-consistent comparison chain', async () => {
    const { service, outputs, request } = await fixture()
    const first = service.comparePeriodSegments('monitoring', request)
    const second = service.comparePeriodSegments('monitoring', {
      referenceAdjustmentId: outputs[1]!.run.id, currentAdjustmentId: outputs[2]!.run.id,
      segments: request.segments, idempotencyKey: 'monitoring-segment-comparison-2'
    })
    const summary = service.getContinuousSegmentSummaryForNewUse('monitoring', [first.id, second.id])!
    expect(summary).toMatchObject({ projectId: 'monitoring', comparisonIds: [first.id, second.id] })
    expect(summary.firstEpoch).toBe('2026-09-01T00:00:00.000Z')
    expect(summary.currentEpoch).toBe('2026-09-03T00:00:00.000Z')
    expect(summary.segments[0]).toMatchObject({ id: 'BM-P', from: 'BM', to: 'P', observedCumulativeChangeMetres: expect.closeTo(-0.004, 12), adjustedCumulativeChangeMetres: expect.closeTo(-0.004, 12) })
    expect(summary.segments[0]!.periodChanges.map(item => item.comparisonId)).toEqual([first.id, second.id])
    expect(service.getContinuousSegmentSummaryForNewUse('monitoring', [first.id, second.id])).toEqual(summary)
    expect(() => service.getContinuousSegmentSummaryForNewUse('monitoring', [second.id, first.id])).toThrow('adjacent')
    expect(() => service.getContinuousSegmentSummaryForNewUse('monitoring', [first.id, first.id])).toThrow('duplicate')
    expect(() => service.getContinuousSegmentSummaryForNewUse('monitoring', ['missing'])).toThrow('unavailable')
    const inconsistent = service.comparePeriodSegments('monitoring', {
      referenceAdjustmentId: outputs[1]!.run.id, currentAdjustmentId: outputs[2]!.run.id,
      segments: [{ ...request.segments[0]!, id: 'other-segment' }], idempotencyKey: 'monitoring-segment-comparison-inconsistent'
    })
    expect(() => service.getContinuousSegmentSummaryForNewUse('monitoring', [first.id, inconsistent.id])).toThrow('inconsistent segment identities')
  })

  it('requires unchanged datum/controls, ordered epochs and eligible exact result evidence', async () => {
    const { root, service, outputs, request } = await fixture()
    expect(() => service.comparePeriodSegments('monitoring', { ...request, referenceAdjustmentId: request.currentAdjustmentId, currentAdjustmentId: request.referenceAdjustmentId })).toThrow('ordered')
    expect(() => service.comparePeriodSegments('monitoring', { ...request, currentAdjustmentId: request.referenceAdjustmentId })).toThrow('different periods')
    const database = new Database(join(root, 'survey.sqlite3'))
    onTestFinished(() => { database.close() })
    const network = service.getNetwork(outputs[1]!.run.networkId)!
    database.prepare('UPDATE survey_networks SET data_json=? WHERE id=?').run(JSON.stringify({ ...network, verticalDatum: 'changed' }), network.id)
    expect(() => service.comparePeriodSegments('monitoring', request)).toThrow()
    expect(service.getAdjustment(outputs[1]!.run.id)?.result).toEqual(outputs[1]!.result)
  })

  it('appends confirmed initial-value events with stale-write protection and immutable history', async () => {
    const { root, service, outputs } = await fixture()
    const firstRequest = { adjustmentId: outputs[0]!.run.id, expectedPreviousEventId: null, reason: 'Initial survey accepted for this task', confirmed: true, idempotencyKey: 'initial-value-first' }
    const first = service.changeInitialValue('monitoring', firstRequest)
    const secondRequest = { ...firstRequest, adjustmentId: outputs[1]!.run.id, expectedPreviousEventId: first.id, reason: 'Confirmed control inspection and revised initial period', idempotencyKey: 'initial-value-second' }
    const second = service.changeInitialValue('monitoring', secondRequest)
    expect(second).toMatchObject({ previousEventId: first.id, previousHash: first.eventHash, signoff: 'unsigned' })
    expect(service.listInitialValueEvents('monitoring')).toEqual([first, second])
    expect(service.changeInitialValue('monitoring', firstRequest)).toEqual(first)
    expect(() => service.changeInitialValue('monitoring', { ...firstRequest, idempotencyKey: 'initial-value-stale' })).toThrow('refresh')
    expect(() => service.changeInitialValue('monitoring', { ...firstRequest, reason: 'changed' })).toThrow('idempotency')
    expect(() => service.changeInitialValue('monitoring', { ...secondRequest, confirmed: false })).toThrow()
    expect(() => service.changeInitialValue('monitoring', { ...secondRequest, reason: ' ' })).toThrow()
    const database = new Database(join(root, 'survey.sqlite3'))
    onTestFinished(() => { database.close() })
    expect(() => database.prepare('DELETE FROM survey_initial_value_events WHERE id=?').run(first.id)).toThrow('append-only')
    expect(() => database.prepare('UPDATE survey_initial_value_events SET data_json=? WHERE id=?').run('{}', first.id)).toThrow('append-only')
    expect(() => database.exec('INSERT OR REPLACE INTO survey_initial_value_events SELECT * FROM survey_initial_value_events')).toThrow('append-only')
    const reopened = new SurveyService({ rootDir: root })
    onTestFinished(() => reopened.close())
    expect(reopened.listInitialValueEvents('monitoring')).toEqual([first, second])
    const network = service.getNetwork(outputs[1]!.run.networkId)!
    database.prepare('UPDATE survey_networks SET data_json=? WHERE id=?').run(JSON.stringify({ ...network, verticalDatum: 'changed' }), network.id)
    expect(service.listInitialValueEvents('monitoring')).toEqual([first, second])
    expect(() => service.changeInitialValue('monitoring', { ...secondRequest, expectedPreviousEventId: second.id, idempotencyKey: 'initial-value-invalid-source' })).toThrow()
  })

  it('authenticates all routes and rejects oversized or ambiguous mutations', async () => {
    const { service } = await fixture()
    const router = new Router()
    registerSurveyMonitoringRoutes(router, { getService: () => service, authorize: request => request.headers.get('authorization') === 'Bearer test' })
    const path = '/v1/engineering/projects/monitoring/survey/initial-values'
    const get = router.match('GET',path)!
    expect((await get.handler(new Request(`http://localhost${path}`), { params: get.params })).status).toBe(401)
    expect((await get.handler(new Request(`http://localhost${path}`, { headers: { authorization: 'Bearer test' } }), { params: get.params })).status).toBe(200)
    const post = router.match('POST',path)!
    expect((await post.handler(new Request(`http://localhost${path}`, { method: 'POST', headers: { authorization: 'Bearer test' }, body: '{}' }), { params: post.params })).status).toBe(400)
    expect((await post.handler(new Request(`http://localhost${path}`, { method: 'POST', headers: { authorization: 'Bearer test' }, body: ' '.repeat(256*1024+1) }), { params: post.params })).status).toBe(413)
  })
})
