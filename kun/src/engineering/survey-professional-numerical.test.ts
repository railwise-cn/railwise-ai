import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SurveyService } from './survey-service.js'

const fixtures = new URL('./fixtures/survey-formats/', import.meta.url)
const near = (actual: number | undefined, expected: number, tolerance = 1e-10): void => {
  expect(actual).toBeTypeOf('number')
  expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(tolerance)
}

async function withService(run: (service: SurveyService) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'survey-professional-numerical-'))
  const service = new SurveyService({ rootDir: root })
  try { await run(service) } finally { await service.flush(); service.close(); await rm(root, { recursive: true, force: true }) }
}

describe('professional projection against independent numerical references', () => {
  it('matches the exact GSI route-length distribution, cofactor and posterior precision', async () => withService(async service => {
    const bytes = await readFile(new URL('professional/leica-gsi-cumulative-leveling.gsi', fixtures))
    const network = await service.importNetwork({ projectId: 'gsi', expectedRevision: 0, idempotencyKey: 'gsi-source',
      name: 'loop.GSI', networkType: 'leveling', dataBase64: bytes.toString('base64'), knownPoints: [{ id: 'BM', height: 100 }] })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'gsi-calculate' })
    expect(output.run.status).toBe('completed')
    const review = service.getProfessionalReview(output.run.id)!
    expect(review.source).toMatchObject({ status: 'bound', integrity: 'verified', sha256: createHash('sha256').update(bytes).digest('hex') })
    expect(review.solver).toMatchObject({ rank: 3, parameterCount: 3, datumDefect: 0, datumStatus: 'fixed-datum', constraint: 'fixed-known-points', constraintBasis: 'adjustment-run' })
    expect(review.summary.degreesOfFreedom).toBe(1)
    // Independent rational solution: distribute +1/2500 m around a 600 m
    // loop by lengths 100,200,200,100. No product solver computes these values.
    const expectedHeights = [1496999 / 15000, 502999 / 5000, 2993993 / 30000]
    const ids = ['gsi-block-1:Z01', 'P1', 'gsi-block-1:Z02']
    const diagonalCofactor = [250 / 3, 150, 250 / 3]
    const variance = 1 / 3750000000
    ids.forEach((id, index) => {
      const point = review.points.find(row => row.id === id)!
      near(point.height, expectedHeights[index]!)
      near(point.standardError, Math.sqrt(diagonalCofactor[index]! * variance))
      expect(point.precisionBasis).toBe('a-posteriori')
    })
    near(review.summary.varianceFactor, variance, 1e-17)
    const residuals = [-1 / 15000, -1 / 7500, -1 / 7500, -1 / 15000]
    review.observations.forEach((row, index) => {
      near(row.residual, residuals[index]!); near(row.correction, residuals[index]!)
      near(row.adjusted! - row.observed!, residuals[index]!)
      expect(row.sourceRecordId).toBeTruthy()
    })
    expect(review.closures).toHaveLength(1)
    near(review.closures[0]!.misclosureMetres, 1 / 2500)
    expect(review.closures[0]).toMatchObject({ totalLengthMetres: 600, status: 'not-evaluated' })
    expect(review.reviewStatus).toBe('unsigned')
    expect(review.standardsConformity).toBe('not-evaluated')
  }))

  it('matches independent attached IN1 heights, correction signs and precision', async () => withService(async service => {
    const bytes = await readFile(new URL('professional/cosa-in1-level-golden-a.in1', fixtures))
    const mapping = JSON.parse(await readFile(new URL('professional/cosa-in1-mapping.json', fixtures), 'utf8'))
    const network = await service.importNetwork({ projectId: 'in1', expectedRevision: 0, idempotencyKey: 'in1-source',
      name: 'attached.in1', networkType: 'leveling', dataBase64: bytes.toString('base64'), cosaIn1Mapping: mapping })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'in1-calculate' })
    expect(output.run.status).toBe('completed')
    const review = service.getProfessionalReview(output.run.id)!
    // Observed sum=1.499 m; known difference=1.5 m; route lengths=2,2.5,3 m.
    const residuals = [1 / 3750, 1 / 3000, 1 / 2500]
    near(review.points.find(row => row.id === 'P1')!.height, 100 + 1 / 8 + residuals[0]!)
    near(review.points.find(row => row.id === 'P2')!.height, 100 + 1 / 2 + residuals[0]! + residuals[1]!)
    near(review.summary.varianceFactor, 1 / 7500000, 1e-15)
    near(review.points.find(row => row.id === 'P1')!.standardError, Math.sqrt(22 / 15 / 7500000))
    near(review.points.find(row => row.id === 'P2')!.standardError, Math.sqrt(9 / 5 / 7500000))
    review.observations.forEach((row, index) => near(row.correction, residuals[index]!))
    near(review.closures[0]!.misclosureMetres, -0.001)
    expect(review.closures[0]).toMatchObject({ kind: 'attached-route', from: 'BM-A', to: 'BM-B', totalLengthMetres: 7.5 })
  }))

  it('matches separately parsed NumPy IN2 coordinates, corrections, covariance and variance basis', async () => withService(async service => {
    const bytes = await readFile(new URL('cosa-in2/golden-plane-control-e2e.in2', fixtures))
    const oracle = JSON.parse(await readFile(new URL('../../../docs/qa/evidence/railwise-convergence-53213de739d0/oracle/independent-oracle.json', import.meta.url), 'utf8'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(oracle.sourceFileSha256)
    const network = await service.importNetwork({ projectId: 'in2', expectedRevision: 0, idempotencyKey: 'in2-source',
      name: 'plane.in2', networkType: 'plane-control', dataBase64: bytes.toString('base64') })
    const output = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'in2-calculate' })
    expect(output.run.status).toBe('completed')
    const review = service.getProfessionalReview(output.run.id)!, reference = oracle.solutions.rss
    near(review.points.find(row => row.id === 'S1')!.x, reference.station.xNorthM, 2e-6)
    near(review.points.find(row => row.id === 'S1')!.y, reference.station.yEastM, 2e-6)
    expect(review.summary.degreesOfFreedom).toBe(reference.degreesOfFreedom)
    near(review.summary.varianceFactor, reference.weightedSumSquares / reference.degreesOfFreedom, 1e-12)
    near(review.points.find(row => row.id === 'S1')!.standardError,
      Math.sqrt(reference.posteriorCovariance[0][0] + reference.posteriorCovariance[1][1]), 1e-10)
    // Both implementations explicitly use RSS distance sigmas and one shared
    // unknown station orientation, so a-priori covariance can be compared here.
    output.result.covariance!.forEach((row, i) => row.forEach((value, j) => near(value, reference.aprioriCovariance[i][j], 1e-10)))
    review.observations.forEach(row => {
      const expected = reference.observations.find((item: { line: number }) => item.line === row.sourceRow)
      expect(expected).toBeTruthy()
      near(row.correction, expected.adjustedMinusObserved, row.unit === 'rad' ? 2e-8 : 2e-6)
    })
    expect(review.closures).toEqual([])
    expect(review.checks.find(row => row.id === 'closure')).toMatchObject({ status: 'not-evaluated', reason: 'plane-closures-not-evaluated' })
    expect(review.residualNorms.map(row => row.unit)).toEqual(['m', 'rad'])
    expect(review.residualNorms.every(row => row.status === 'descriptive-only')).toBe(true)
  }))
})
