import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it, onTestFinished } from 'vitest'
import { AdjustmentResultV1, SurveyNetworkV1 } from '../contracts/survey.js'
import { SurveyProfessionalReviewV1 } from '../contracts/survey-professional.js'
import { getSurveyProfessionalReview } from '../server/routes/engineering.js'
import { buildSurveyProfessionalReview, professionalLevelingClosures, surveyProfessionalInputHash } from './survey-professional-review.js'
import { levelingNetworkClosures } from './survey-leveling-closure.js'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'

function network(observations: unknown[], additions: Record<string, unknown> = {}): SurveyNetworkV1 {
  return SurveyNetworkV1.parse({ schemaVersion: 1, id: 'net', projectId: 'professional', networkType: 'leveling',
    coordinateSystem: 'LOCAL', verticalDatum: 'LOCAL-BM', knownPoints: [{ id: 'A', height: 10, known: true }],
    unknownPoints: [{ id: 'P', height: 11 }], observations, revision: 1, createdAt: '2026-09-30', updatedAt: '2026-09-30', ...additions })
}
function result(input: SurveyNetworkV1, additions: Record<string, unknown> = {}): AdjustmentResultV1 {
  return AdjustmentResultV1.parse({ schemaVersion: 1, id: 'result', runId: 'run', networkId: input.id,
    observationCount: input.observations.length, unknownCount: 1, redundancy: 1, degreesOfFreedom: 1,
    unitWeightStdDev: 0.001, varianceFactor: 0.000001, varianceFactorEstimated: true,
    points: [{ id: 'A', height: 10 }, { id: 'P', height: 11.001, standardError: 0.0005 }],
    observations: input.observations.map((observation) => ({ observationId: observation.id, correction: -0.001, residual: -0.001, unit: 'm' })),
    qualityFindings: [], precision: { maxPointStdDev: 0.0005, passed: true },
    inputHash: surveyProfessionalInputHash(input), algorithmVersion: 'workwise-survey-adjustment-8', validation: 'valid', createdAt: '2026-09-30', ...additions })
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'survey-professional-'))
  const service = new SurveyService({ rootDir: root })
  onTestFinished(() => service.close())
  const imported = await importWorkwiseSurveyNetwork(service, { projectId: 'professional', expectedRevision: 0, idempotencyKey: 'professional-import',
    network: { networkType: 'leveling', coordinateSystem: 'LOCAL', verticalDatum: 'LOCAL-BM',
      knownPoints: [{ id: 'A', height: 10, known: true }], unknownPoints: [{ id: 'P', height: 11 }],
      instrumentParameters: { closureTolerance: 0.004 }, observations: [
        { id: 'forward', type: 'height-difference', from: 'A', to: 'P', value: 1000, unit: 'mm', routeLength: 100, rawFields: { stationCount: 2 } },
        { id: 'back', type: 'height-difference', from: 'P', to: 'A', value: -0.998, unit: 'm', routeLength: 200, rawFields: { stationCount: 3 } }
      ] } })
  const checked = service.validateNetwork(imported.id, { expectedRevision: imported.revision, idempotencyKey: 'professional-validation' })
  const output = service.createAdjustment({ networkId: imported.id, expectedRevision: checked.revision, idempotencyKey: 'professional-adjustment' })
  return { root, service, output, network: service.getNetwork(imported.id)! }
}

describe('professional surveying review projection', () => {
  it('does not present an implicit zero solver start as a declared approximate coordinate', () => {
    const net = network([{ id: '1', type: 'height-difference', from: 'A', to: 'P', value: 1 }], { unknownPoints: [{ id: 'P' }] })
    const frozen = result(net, { points: [{ id: 'A', height: 10 }, { id: 'P', height: 11.001, correctionHeight: 11.001, standardError: 0.0005 }] })
    const review = buildSurveyProfessionalReview({ projectId: net.projectId, network: net, result: frozen })
    expect(review.points.find(point => point.id === 'P')).toMatchObject({ height: 11.001, standardError: 0.0005 })
    expect(review.points.find(point => point.id === 'P')!.correctionHeight).toBeUndefined()
    expect(frozen.points[1]!.correctionHeight).toBe(11.001)
    const declared = network(net.observations, { unknownPoints: [{ id: 'P', height: 11 }] })
    const corrected = result(declared, { points: [{ id: 'P', height: 11.001, correctionHeight: 0.001 }] })
    expect(buildSurveyProfessionalReview({ projectId: declared.projectId, network: declared, result: corrected }).points[0]!.correctionHeight).toBe(0.001)
  })
  it('recomputes the candidate network hash even when an expected hash is supplied', () => {
    const original = network([{ id: '1', type: 'height-difference', from: 'A', to: 'P', value: 1 }])
    const stored = result(original)
    const changed = SurveyNetworkV1.parse({ ...original, verticalDatum: 'CHANGED', revision: original.revision + 1 })
    const review = buildSurveyProfessionalReview({
      projectId: changed.projectId, network: changed, result: stored, expectedInputHash: stored.inputHash
    })
    expect(review.source).toMatchObject({ status: 'mismatch', reason: 'input-mismatch' })
    expect(review.reference.status).toBe('unavailable')
    expect(review.closures).toEqual([])
  })

  it('treats pointClass=known as a control-point marker for legacy snapshots', () => {
    const net = network([
      { id: '1', type: 'height-difference', from: 'A', to: 'P', value: 1 },
      { id: '2', type: 'height-difference', from: 'P', to: 'B', value: 3 }
    ], {
      knownPoints: [
        { id: 'A', pointClass: 'known', known: false, height: 10 },
        { id: 'B', pointClass: 'known', known: false, height: 14 }
      ]
    })
    const review = buildSurveyProfessionalReview({ projectId: net.projectId, network: net, result: result(net) })
    expect(review.reference.knownPoints.map((point) => point.id)).toEqual(['A', 'B'])
    expect(review.reference.status).toBe('declared')
    expect(review.points.find((point) => point.id === 'A')?.role).toBe('known')
    expect(review.closures[0]).toMatchObject({ kind: 'attached-route', from: 'A', to: 'B' })
  })

  it('uses raw observations for closure, canonical adjusted values for results, and preserves immutable storage', async () => {
    const { root, service, output, network: net } = await fixture()
    const db = new Database(join(root, 'survey.sqlite3'))
    onTestFinished(() => { db.close() })
    const before = db.prepare('SELECT data_json FROM survey_adjustments WHERE id = ?').get(output.run.id)
    const evidenceBefore = db.prepare('SELECT data_json FROM survey_adjustment_evidence WHERE adjustment_id = ?').get(output.run.id)
    const review = service.getProfessionalReview(output.run.id)!
    expect(SurveyProfessionalReviewV1.safeParse(review).success).toBe(true)
    expect(review).toEqual(service.getProfessionalReview(output.result.id))
    expect(review.source).toMatchObject({ status: 'bound', integrity: 'verified', anchoredObservationCount: 2, missingAnchorObservationIds: [] })
    const closure = review.closures[0]!
    expect(closure).toMatchObject({ kind: 'loop', from: 'P', to: 'P', totalLengthMetres: 300, stationCount: 5, toleranceMetres: 0.004, status: 'pass' })
    expect(closure.misclosureMetres).toBeCloseTo(0.002, 14)
    expect(review.observations[0]).toMatchObject({ rawValue: 1000, rawUnit: 'mm', observed: 1, sourceRecordId: net.observations[0]!.sourceRecordId })
    expect(review.observations[0]!.adjusted).toBeCloseTo(1 + output.result.observations[0]!.correction, 14)
    expect(review.residualNorms[0]!.value).not.toBeCloseTo(Math.abs(closure.misclosureMetres), 10)
    expect(review.checks.find((item) => item.id === 'field-checks')).toEqual({ id: 'field-checks', status: 'not-evaluated', reason: 'station-readings-not-evaluated' })
    expect(review.checks.find((item) => item.id === 'precision')?.status).toBe('not-evaluated')
    expect(review.reviewStatus).toBe('unsigned')
    expect(review.standardsConformity).toBe('not-evaluated')
    expect(Object.isFrozen(review)).toBe(true)
    expect(Object.isFrozen(review.closures[0]!.members)).toBe(true)
    expect(db.prepare('SELECT data_json FROM survey_adjustments WHERE id = ?').get(output.run.id)).toEqual(before)
    expect(db.prepare('SELECT data_json FROM survey_adjustment_evidence WHERE adjustment_id = ?').get(output.run.id)).toEqual(evidenceBefore)
  })

  it('does not invent tolerance, station counts, field checks or plane closures', () => {
    const net = network([
      { id: '1', type: 'height-difference', from: 'A', to: 'P', value: 1.002 },
      { id: '2', type: 'height-difference', from: 'P', to: 'A', value: -1 }
    ])
    const review = buildSurveyProfessionalReview({ projectId: net.projectId, network: net, result: result(net) })
    expect(review.closures[0]).toMatchObject({ misclosureMetres: expect.closeTo(0.002, 12), status: 'not-evaluated', reason: 'closure-tolerance-not-configured' })
    expect(review.closures[0]!.toleranceMetres).toBeUndefined()
    expect(review.closures[0]!.stationCount).toBeUndefined()
    expect(review.closures[0]!.totalLengthMetres).toBeUndefined()
    const plane = network([{ id: 'dist', type: 'distance', from: 'A', to: 'P', value: 1 }], { networkType: 'plane-control', verticalDatum: '待确认' })
    const planeReview = buildSurveyProfessionalReview({ projectId: plane.projectId, network: plane, result: result(plane, { closure: { horizontal: 0.002, angular: 0.0001 } }) })
    expect(planeReview.closures).toEqual([])
    expect(planeReview.checks.find((item) => item.id === 'closure')).toMatchObject({ status: 'not-evaluated', reason: 'plane-closures-not-evaluated' })
    expect(planeReview.weakestEdge.status).toBe('not-evaluated')
    expect(planeReview.weakestPoint).toMatchObject({ status: 'available', pointId: 'P', standardErrorMetres: 0.0005 })
  })

  it('reconstructs independent loop and attached-route memberships, including reversed edges', () => {
    const net = network([
      { id: '1', type: 'height-difference', from: 'A', to: 'P', value: 1, routeLength: 100 },
      { id: '2', type: 'height-difference', from: 'A', to: 'Q', value: 2, routeLength: 200 },
      { id: '3', type: 'height-difference', from: 'P', to: 'Q', value: 1.003, routeLength: 100 },
      { id: '4', type: 'height-difference', from: 'P', to: 'B', value: 3.002, routeLength: 300 }
    ], { knownPoints: [{ id: 'A', height: 10, known: true }, { id: 'B', height: 14, known: true }], unknownPoints: [{ id: 'P' }, { id: 'Q' }], instrumentParameters: { closureTolerance: 0.0025 } })
    const closures = professionalLevelingClosures(net)
    const loop = closures.find((item) => item.kind === 'loop')!
    expect(loop.members.map((item) => [item.observationId, item.direction])).toEqual([['2', -1], ['1', 1], ['3', 1]])
    expect(loop.misclosureMetres).toBeCloseTo(0.003, 12)
    expect(loop.totalLengthMetres).toBe(400)
    expect(loop.status).toBe('fail')
    const attached = closures.find((item) => item.kind === 'attached-route')!
    expect(attached.members.map((item) => item.observationId)).toEqual(['1', '4'])
    expect(attached.knownHeightDifferenceMetres).toBe(4)
    expect(attached.misclosureMetres).toBeCloseTo(0.002, 12)
    expect(attached.status).toBe('pass')
    const independent = levelingNetworkClosures(new Map([['A', 10], ['B', 14]]), net.observations.map((item) => ({ id: item.id, from: item.from!, to: item.to!, heightDifferenceMetres: item.value })))
    const actualMisclosures = closures.map((item) => item.misclosureMetres).sort((left, right) => left - right)
    const referenceMisclosures = independent.map((item) => item.misclosureMetres).sort((left, right) => left - right)
    expect(actualMisclosures).toHaveLength(referenceMisclosures.length)
    actualMisclosures.forEach((value, index) => expect(value).toBeCloseTo(referenceMisclosures[index]!, 12))
    expect(professionalLevelingClosures({ ...net, observations: [...net.observations].reverse() })).toEqual(closures)
  })

  it('connects consecutive DFS-ordered controls with a linear-size independent route basis', () => {
    const controlCount = 64
    const ids = Array.from({ length: controlCount }, (_, index) => `K${String(index).padStart(3, '0')}`)
    const observations = [
      ...ids.slice(0, -1).map((from, index) => ({
        id: `edge-${String(index).padStart(3, '0')}`, type: 'height-difference', from, to: ids[index + 1], value: 1
      })),
      { id: 'edge-terminal', type: 'height-difference', from: ids.at(-1), to: 'END', value: 1 }
    ]
    const net = network(observations, {
      knownPoints: ids.map((id, index) => ({ id, height: index, known: true })),
      unknownPoints: [{ id: 'END', height: controlCount }]
    })

    const attached = professionalLevelingClosures(net).filter((row) => row.kind === 'attached-route')
    expect(attached).toHaveLength(controlCount - 1)
    expect(attached.map((row) => [row.from, row.to])).toEqual(ids.slice(0, -1).map((id, index) => [id, ids[index + 1]]))
    expect(attached.every((row) => row.members.length === 1)).toBe(true)
    expect(new Set(attached.flatMap((row) => row.members.map((member) => member.observationId))).size).toBe(controlCount - 1)
    expect(attached.reduce((count, row) => count + row.members.length, 0)).toBeLessThanOrEqual(2 * observations.length)
  })

  it('keeps an unanchored loop and an attached route in the same component', () => {
    const net = network([
      { id: '01', type: 'height-difference', from: 'A', to: 'P', value: 2 },
      { id: '02', type: 'height-difference', from: 'P', to: 'Q', value: 1 },
      { id: '03', type: 'height-difference', from: 'Q', to: 'R', value: 1 },
      { id: '04', type: 'height-difference', from: 'R', to: 'P', value: -1.99 },
      { id: '05', type: 'height-difference', from: 'P', to: 'B', value: 3 }
    ], {
      knownPoints: [{ id: 'A', height: 10, known: true }, { id: 'B', height: 15, known: true }],
      unknownPoints: [{ id: 'P' }, { id: 'Q' }, { id: 'R' }],
      instrumentParameters: { closureTolerance: 0.005 }
    })

    const closures = professionalLevelingClosures(net)
    expect(closures.map((row) => row.kind)).toEqual(['attached-route', 'loop'])
    expect(closures[0]).toMatchObject({ from: 'A', to: 'B', misclosureMetres: 0, status: 'pass' })
    expect(closures[1]).toMatchObject({ from: 'R', to: 'R', misclosureMetres: expect.closeTo(0.01, 12), status: 'fail' })
    expect(closures[1]!.members.map((member) => member.observationId).sort()).toEqual(['02', '03', '04'])
  })

  it('checks parallel leveling observations as a two-edge loop', () => {
    const net = network([
      { id: 'forward-1', type: 'height-difference', from: 'A', to: 'P', value: 1 },
      { id: 'forward-2', type: 'height-difference', from: 'A', to: 'P', value: 1.002 }
    ], { instrumentParameters: { closureTolerance: 0.003 } })

    const closures = professionalLevelingClosures(net)
    expect(closures).toHaveLength(1)
    expect(closures[0]).toMatchObject({ kind: 'loop', from: 'P', to: 'P', misclosureMetres: expect.closeTo(0.002, 12), status: 'pass' })
    expect(closures[0]!.members.map((member) => [member.observationId, member.direction])).toEqual([['forward-1', -1], ['forward-2', 1]])
  })

  it('keeps short cycle paths short when a long route has many parallel end observations', () => {
    const chainLength = 8192
    const parallelCount = 256
    const points = Array.from({ length: chainLength + 1 }, (_, index) => `N${String(index).padStart(5, '0')}`)
    const observations = [
      ...points.slice(0, -1).map((from, index) => ({
        id: `chain-${String(index).padStart(5, '0')}`, type: 'height-difference', from, to: points[index + 1], value: 1
      })),
      ...Array.from({ length: parallelCount }, (_, index) => ({
        id: `parallel-${String(index).padStart(3, '0')}`, type: 'height-difference', from: points.at(-2), to: points.at(-1), value: 1 + (index + 1) / 1_000_000
      }))
    ]
    const net = network(observations, {
      knownPoints: [],
      unknownPoints: points.map((id) => ({ id }))
    })

    const loops = professionalLevelingClosures(net).filter((row) => row.kind === 'loop')
    expect(loops).toHaveLength(parallelCount)
    expect(loops.every((row) => row.members.length === 2)).toBe(true)
    expect(loops.reduce((count, row) => count + row.members.length, 0)).toBe(2 * parallelCount)
    expect(loops[0]!.misclosureMetres).toBeCloseTo(0.000001, 12)
  })

  it('keeps adjacent closed loops independent when their misclosures cancel in file order', () => {
    const net = network([
      { id: '1', type: 'height-difference', from: 'A', to: 'B', value: 1 },
      { id: '2', type: 'height-difference', from: 'B', to: 'A', value: -0.99 },
      { id: '3', type: 'height-difference', from: 'A', to: 'C', value: 2 },
      { id: '4', type: 'height-difference', from: 'C', to: 'A', value: -2.01 }
    ], { unknownPoints: [{ id: 'B' }, { id: 'C' }], instrumentParameters: { closureTolerance: 0.004 } })

    const closures = professionalLevelingClosures(net)
    expect(closures).toHaveLength(2)
    const errors = closures.map((closure) => closure.misclosureMetres).sort((left, right) => left - right)
    expect(errors[0]).toBeCloseTo(-0.01, 12)
    expect(errors[1]).toBeCloseTo(0.01, 12)
    expect(closures.every((closure) => closure.status === 'fail')).toBe(true)
    expect(buildSurveyProfessionalReview({ projectId: net.projectId, network: net, result: result(net) }).checks.find((item) => item.id === 'closure')?.status).toBe('fail')
  })

  it('checks closed components that have no known control point', () => {
    const net = network([
      { id: '1', type: 'height-difference', from: 'U1', to: 'U2', value: 0.5 },
      { id: '2', type: 'height-difference', from: 'U2', to: 'U3', value: 0.5 },
      { id: '3', type: 'height-difference', from: 'U3', to: 'U1', value: -0.99 }
    ], { knownPoints: [], unknownPoints: [{ id: 'U1' }, { id: 'U2' }, { id: 'U3' }], instrumentParameters: { closureTolerance: 0.004 } })

    const closures = professionalLevelingClosures(net)
    expect(closures).toHaveLength(1)
    expect(closures[0]).toMatchObject({ kind: 'loop', misclosureMetres: expect.closeTo(0.01, 12), status: 'fail' })
  })

  it('finds attached routes from graph topology when imported rows are not sequential', () => {
    const net = network([
      { id: '02', type: 'height-difference', from: 'P', to: 'B', value: 3 },
      { id: '01', type: 'height-difference', from: 'A', to: 'P', value: 1 }
    ], { knownPoints: [{ id: 'A', height: 10, known: true }, { id: 'B', height: 14, known: true }], unknownPoints: [{ id: 'P' }] })

    expect(professionalLevelingClosures(net)).toEqual([
      expect.objectContaining({ kind: 'attached-route', from: 'A', to: 'B', misclosureMetres: 0, status: 'not-evaluated', reason: 'closure-tolerance-not-configured' })
    ])
  })

  it('omits current datum and observed values when an input changed, while retaining historical result values', async () => {
    const { root, service, output, network: net } = await fixture()
    const db = new Database(join(root, 'survey.sqlite3'))
    onTestFinished(() => { db.close() })
    db.prepare('UPDATE survey_networks SET data_json = ? WHERE id = ?').run(JSON.stringify({ ...net, verticalDatum: 'different', revision: net.revision + 1 }), net.id)
    const review = service.getProfessionalReview(output.run.id)!
    expect(review.source).toMatchObject({ status: 'mismatch', reason: 'input-mismatch' })
    expect(review.closures).toEqual([])
    expect(review.reference.verticalDatum).toBeNull()
    expect(review.reference.knownPoints).toEqual([])
    expect(review.observations[0]!.observed).toBeUndefined()
    expect(review.observations[0]!.residual).toBe(output.result.observations[0]!.residual)
    expect(review.points[1]!.height).toBe(output.result.points[1]!.height)
    expect(service.getAdjustment(output.run.id)?.result).toEqual(output.result)
  })

  it('reports missing snapshots, untestable results and legacy statistics explicitly', () => {
    const net = network([{ id: 'one', type: 'height-difference', from: 'A', to: 'P', value: 1 }])
    const stored = result(net, { varianceFactorEstimated: false, degreesOfFreedom: 0, redundancy: 0 })
    const review = buildSurveyProfessionalReview({ projectId: net.projectId, result: stored })
    expect(review.source).toMatchObject({ status: 'unavailable', integrity: 'not-verified', reason: 'no-network-snapshot' })
    expect(review.reference.status).toBe('unavailable')
    expect(review.summary.varianceBasis).toBe('a-priori')
    expect(review.observations[0]!.screeningStatus).toBe('legacy-not-recorded')
    expect(review.standardsConformity).toBe('not-evaluated')
    expect(review.resultHash).toMatch(/^[0-9a-f]{64}$/)
    expect(review.projectionHash).toEqual(buildSurveyProfessionalReview({ projectId: net.projectId, result: stored }).projectionHash)
    expect(review.solver).toMatchObject({ parameterCount: 1, rankStatus: 'not-recorded', datumStatus: 'not-evaluated', constraint: 'not-recorded', constraintBasis: 'not-recorded' })
  })

  it('reports solver rank, algebraic datum defect and the executed constraint', () => {
    const net = network([{ id: 'one', type: 'height-difference', from: 'A', to: 'P', value: 1 }])
    const stored = result(net, { unknownCount: 3, solverDiagnostics: { rank: 2 } })
    const review = buildSurveyProfessionalReview({ projectId: net.projectId, result: stored, network: net, constraint: 'fixed-known-points' })
    expect(review.solver).toEqual({
      rank: 2, parameterCount: 3, datumDefect: 1, rankStatus: 'available', datumStatus: 'fixed-datum',
      constraint: 'fixed-known-points', constraintBasis: 'adjustment-run'
    })
  })

  it('blocks the professional numerical check when an open blocking finding remains', () => {
    const net = network([{ id: 'one', type: 'height-difference', from: 'A', to: 'P', value: 1 }])
    const stored = result(net, {
      qualityFindings: [{ schemaVersion: 1, id: 'finding-1', networkId: net.id, code: 'missing_datum', severity: 'blocking',
        message: '基准信息缺失', suggestion: '补充基准声明', status: 'open', createdAt: '2026-09-30' }]
    })
    const review = buildSurveyProfessionalReview({ projectId: net.projectId, result: stored, network: net })
    expect(review.checks.find((item) => item.id === 'numerical-result')).toEqual({
      id: 'numerical-result', status: 'fail', reason: 'blocking-quality-finding'
    })
  })

  it('handles GNSS components without using the legacy scalar observation value', () => {
    const net = network([{ id: 'base', type: 'gnss-baseline', from: 'A', to: 'P', value: 0, vectorX: 1, vectorY: 2, vectorZ: 3 }], { networkType: 'gnss' })
    const stored = result(net, { observations: [
      { observationId: 'base:x', residual: 0.001, correction: 0.001, unit: 'm' },
      { observationId: 'base:y', residual: -0.002, correction: -0.002, unit: 'm' },
      { observationId: 'base:z', residual: 0.003, correction: 0.003, unit: 'm' }
    ] })
    const review = buildSurveyProfessionalReview({ projectId: net.projectId, result: stored, network: net })
    expect(review.observations.map((row) => row.observed)).toEqual([1, 2, 3])
    expect(review.observations.map((row) => row.adjusted)).toEqual([1.001, 1.998, 3.003])
    expect(review.observations.map((row) => row.component)).toEqual(['x', 'y', 'z'])
  })

  it('serves the read-only HTTP projection and rejects unavailable/unknown data', async () => {
    const { service, output } = await fixture()
    expect(getSurveyProfessionalReview(undefined, output.run.id).status).toBe(503)
    expect(getSurveyProfessionalReview(service, 'missing').status).toBe(404)
    const response = getSurveyProfessionalReview(service, output.run.id)
    expect(response.status).toBe(200)
    expect(SurveyProfessionalReviewV1.parse(JSON.parse(String(response.body)).review).runId).toBe(output.run.id)
  })
})
