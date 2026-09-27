import { describe, expect, it } from 'vitest'
import { diagnoseAprioriResiduals, diagnoseDeletedResiduals, type AprioriResidualDiagnosticsInput, type DeletedResidualDiagnosticsInput } from './survey-statistical-diagnostics.js'

const input = (residuals: number[], residualCovariance: number[][], degreesOfFreedom: number): AprioriResidualDiagnosticsInput => ({ varianceBasis: 'known-apriori', covarianceKind: 'residual-covariance', residuals, residualCovariance, degreesOfFreedom })

describe('a-priori residual diagnostics', () => {
  it('matches a three-observation mean model with known variance 4, rather than dividing by observation sigma', () => {
    // xhat=mean(0,2,4)=2; Cov(v)=4(I-J/3), rank=2.
    const source = input([-2, 0, 2], [[8 / 3, -4 / 3, -4 / 3], [-4 / 3, 8 / 3, -4 / 3], [-4 / 3, -4 / 3, 8 / 3]], 2)
    const before = JSON.stringify(source)
    const result = diagnoseAprioriResiduals(source)
    expect(result.observations[0]!.standardizedResidual).toBeCloseTo(-Math.sqrt(1.5), 12)
    expect(result.observations[2]!.standardizedResidual).toBeCloseTo(Math.sqrt(1.5), 12)
    expect(result.observations[0]!.standardizedResidual).not.toBe(-1)
    expect(result.covarianceRank).toBe(2)
    expect(result.decision).toBe('not-evaluated')
    expect(JSON.stringify(source)).toBe(before)
  })

  it('matches closed-form unequal-weight mean: xhat=10/7, Cov(xhat)=36/49', () => {
    const q = 36 / 49
    const result = diagnoseAprioriResiduals(input([-3 / 7, 4 / 7, 18 / 7], [[1 - q, -q, -q], [-q, 4 - q, -q], [-q, -q, 9 - q]], 2))
    const expected = [-3 / Math.sqrt(13), 4 / Math.sqrt(160), 18 / Math.sqrt(405)]
    expected.forEach((value, i) => expect(result.observations[i]!.standardizedResidual).toBeCloseTo(value, 12))
  })

  it('matches correlated-observation GLS with singular residual covariance', () => {
    // Cll=[[4,1],[1,9]], xhat=(8*l1+3*l2)/11; l=[0,11].
    // Cov(v)=Cll-35/11*J = [[9,-24],[-24,64]]/11.
    const result = diagnoseAprioriResiduals(input([-3, 8], [[9 / 11, -24 / 11], [-24 / 11, 64 / 11]], 1))
    expect(result.observations[0]!.standardizedResidual).toBeCloseTo(-Math.sqrt(11), 12)
    expect(result.observations[1]!.standardizedResidual).toBeCloseTo(Math.sqrt(11), 12)
  })

  it('preserves statistics when residual units and corresponding covariance axes change', () => {
    const result = diagnoseAprioriResiduals(input([-3e-3, 8e3], [[9 / 11 * 1e-6, -24 / 11], [-24 / 11, 64 / 11 * 1e6]], 1))
    expect(result.observations[0]!.standardizedResidual).toBeCloseTo(-Math.sqrt(11), 12)
    expect(result.observations[1]!.standardizedResidual).toBeCloseTo(Math.sqrt(11), 12)
  })

  it('rejects zero redundancy, zero-variance components, a-posteriori substitution and dimension errors', () => {
    expect(() => diagnoseAprioriResiduals(input([0], [[1]], 0))).toThrow('invalid_redundancy')
    expect(() => diagnoseAprioriResiduals(input([0, 0], [[0, 0], [0, 1]], 1))).toThrow('nonpositive_residual_variance')
    expect(() => diagnoseAprioriResiduals({ ...input([0], [[1]], 1), varianceBasis: 'estimated-aposteriori' as never })).toThrow('requires_apriori')
    expect(() => diagnoseAprioriResiduals(input([0, 1], [[1]], 1))).toThrow('invalid_dimension')
    expect(() => diagnoseAprioriResiduals(input([0], [[Number.NaN]], 1))).toThrow('nonfinite')
  })

  it('rejects asymmetric and indefinite covariance even when every diagonal is positive', () => {
    expect(() => diagnoseAprioriResiduals(input([0, 0], [[1, 0.4], [0.3, 1]], 2))).toThrow('asymmetric')
    expect(() => diagnoseAprioriResiduals(input([0, 0], [[1, 2], [2, 1]], 2))).toThrow('indefinite')
    // Positive pairwise principal minors do not suffice for PSD of the full matrix.
    expect(() => diagnoseAprioriResiduals(input([0, 0, 0], [[1, -0.8, -0.8], [-0.8, 1, -0.8], [-0.8, -0.8, 1]], 3))).toThrow('indefinite')
  })

  it('rejects a mismatched model rank or residual vector outside the covariance range', () => {
    expect(() => diagnoseAprioriResiduals(input([-1, 1], [[1, -1], [-1, 1]], 2))).toThrow('rank_mismatch')
    expect(() => diagnoseAprioriResiduals(input([1, 1], [[1, -1], [-1, 1]], 1))).toThrow('outside_covariance_range')
  })

  it('checks the covariance range relative to residual magnitude, including very small residuals', () => {
    // A repeated mean contrast has range span((1,-1)), regardless of magnitude.
    for (const scale of [1e-200, 1e-12, 1, 1e200]) {
      expect(() => diagnoseAprioriResiduals(input([scale, scale], [[1, -1], [-1, 1]], 1))).toThrow('outside_covariance_range')
      const result = diagnoseAprioriResiduals(input([scale, -scale], [[1, -1], [-1, 1]], 1))
      expect(result.observations.map(item => item.standardizedResidual)).toEqual([scale, -scale])
    }
    expect(diagnoseAprioriResiduals(input([0, 0], [[1, -1], [-1, 1]], 1)).observations.map(item => item.standardizedResidual)).toEqual([0, 0])
  })

  it('keeps rank and range checks correct when the Schur step must permute a singular pivot', () => {
    // range(C)=span((1,1,0),(0,0,1)); the second diagonal vanishes after step one.
    const covariance = [[1, 1, 0], [1, 1, 0], [0, 0, 1]]
    const result = diagnoseAprioriResiduals(input([2, 2, 3], covariance, 2))
    expect(result.covarianceRank).toBe(2)
    expect(result.observations.map(item => item.standardizedResidual)).toEqual([2, 2, 3])
    expect(() => diagnoseAprioriResiduals(input([1e-20, -1e-20, 0], covariance, 2))).toThrow('outside_covariance_range')
  })

  it('rejects nonfinite residuals, negative variances and unbounded matrix work', () => {
    expect(() => diagnoseAprioriResiduals(input([Infinity], [[1]], 1))).toThrow('nonfinite')
    expect(() => diagnoseAprioriResiduals(input([0], [[-1]], 1))).toThrow('nonpositive')
    expect(() => diagnoseAprioriResiduals(input(Array(257).fill(0), [], 1))).toThrow('invalid_dimension')
  })
})

/** Independent scalar sums for a straight-line WLS fit, not the production
 * matrix solver or the diagnostic's deletion identity. */
function fitLine(rows: Array<{ x: number; y: number; weight: number }>) {
  const sum = (value: (row: typeof rows[number]) => number) => rows.reduce((total, row) => total + value(row), 0)
  const sw = sum(row => row.weight)
  const sx = sum(row => row.weight * row.x)
  const sxx = sum(row => row.weight * row.x * row.x)
  const sy = sum(row => row.weight * row.y)
  const sxy = sum(row => row.weight * row.x * row.y)
  const determinant = sw * sxx - sx * sx
  if (determinant <= 0) throw new Error('reference line is rank deficient')
  const intercept = (sxx * sy - sx * sxy) / determinant
  const slope = (sw * sxy - sx * sy) / determinant
  const parameterCovariance = (x1: number, x2: number) => (sxx - sx * (x1 + x2) + sw * x1 * x2) / determinant
  const residuals = rows.map(row => row.y - intercept - slope * row.x)
  const sse = residuals.reduce((total, value, i) => total + rows[i]!.weight * value * value, 0)
  return { intercept, slope, parameterCovariance, residuals, sse }
}

function lineFixture() {
  const rows = [
    { x: -2, y: -1.9, weight: 1 }, { x: -1, y: -0.4, weight: 0.5 },
    { x: 0, y: 1.2, weight: 2 }, { x: 1, y: 1.4, weight: 1.5 },
    { x: 3, y: 4.8, weight: 0.75 }, { x: 4, y: 5.1, weight: 3 }
  ]
  const fit = fitLine(rows)
  const source: DeletedResidualDiagnosticsInput = {
    model: 'linear-independent-observations', residuals: fit.residuals,
    observationWeights: rows.map(row => row.weight), weightedResidualSum: fit.sse,
    degreesOfFreedom: rows.length - 2,
    residualCofactor: rows.map((row, i) => rows.map((other, j) => (i === j ? 1 / row.weight : 0) - fit.parameterCovariance(row.x, other.x)))
  }
  return { rows, source }
}

describe('independent-observation WLS externally studentized residuals', () => {
  it('matches six independent leave-one-out refits, including deleted scale and df=n-p-1', () => {
    const { rows, source } = lineFixture()
    const before = JSON.stringify(source)
    const result = diagnoseDeletedResiduals(source)
    expect(result.degreesOfFreedom).toBe(3)
    expect(result.fullModelDegreesOfFreedom).toBe(4)
    expect(result.decision).toBe('not-evaluated')
    rows.forEach((omitted, i) => {
      const remaining = rows.filter((_, j) => i !== j)
      const independentFit = fitLine(remaining)
      const deletedVariance = independentFit.sse / (remaining.length - 2)
      const predictionError = omitted.y - independentFit.intercept - independentFit.slope * omitted.x
      const predictionVariance = 1 / omitted.weight + independentFit.parameterCovariance(omitted.x, omitted.x)
      const referenceT = predictionError / Math.sqrt(deletedVariance * predictionVariance)
      expect(result.observations[i]!.deletedWeightedResidualSum).toBeCloseTo(independentFit.sse, 11)
      expect(result.observations[i]!.deletedVarianceFactor).toBeCloseTo(deletedVariance, 11)
      expect(result.observations[i]!.externallyStudentizedResidual).toBeCloseTo(referenceT, 11)
    })
    expect(JSON.stringify(source)).toBe(before)
  })

  it('matches a closed-form mean with v=(-1,-1,2), SSE=6, df=2', () => {
    // Removing either -1 leaves residuals (-1.5,1.5), SSE=4.5 and t=-1/sqrt(3).
    // The third deletion is perfect fit and therefore undefined: reject all.
    const source: DeletedResidualDiagnosticsInput = {
      model: 'linear-independent-observations', residuals: [-1, -1, 2],
      observationWeights: [1, 1, 1], weightedResidualSum: 6, degreesOfFreedom: 2,
      residualCofactor: [[2 / 3, -1 / 3, -1 / 3], [-1 / 3, 2 / 3, -1 / 3], [-1 / 3, -1 / 3, 2 / 3]]
    }
    expect(() => diagnoseDeletedResiduals(source)).toThrow('nonpositive_or_unresolved_deleted_variance')
  })

  it('is invariant to common weight rescaling with inverse cofactor rescaling', () => {
    const { source } = lineFixture()
    const original = diagnoseDeletedResiduals(source)
    const rescaled = diagnoseDeletedResiduals({
      ...source, observationWeights: source.observationWeights.map(value => value * 7),
      residualCofactor: source.residualCofactor.map(row => row.map(value => value / 7)),
      weightedResidualSum: source.weightedResidualSum * 7
    })
    original.observations.forEach((observation, i) => expect(rescaled.observations[i]!.externallyStudentizedResidual).toBeCloseTo(observation.externallyStudentizedResidual, 11))
  })

  it('rejects correlated or nonlinear models and insufficient deletion degrees of freedom', () => {
    const { source } = lineFixture()
    expect(() => diagnoseDeletedResiduals({ ...source, model: 'correlated-observations' as never })).toThrow('requires_independent_linear_model')
    expect(() => diagnoseDeletedResiduals({ ...source, model: 'nonlinear-independent-observations' as never })).toThrow('requires_independent_linear_model')
    expect(() => diagnoseDeletedResiduals({ ...source, degreesOfFreedom: 1 })).toThrow('insufficient_deleted_degrees')
  })

  it('rejects wrong SSE, weights and posterior covariance substituted for unscaled Qvv', () => {
    const { source } = lineFixture()
    expect(() => diagnoseDeletedResiduals({ ...source, weightedResidualSum: source.weightedResidualSum * 2 })).toThrow('sum_mismatch')
    expect(() => diagnoseDeletedResiduals({ ...source, observationWeights: [1] })).toThrow('invalid_observation_weights')
    expect(() => diagnoseDeletedResiduals({ ...source, observationWeights: source.observationWeights.map((w, i) => i === 1 ? -w : w) })).toThrow('invalid_observation_weights')
    expect(() => diagnoseDeletedResiduals({ ...source, weightedResidualSum: 0 })).toThrow('invalid_weighted_residual_sum')
    expect(() => diagnoseDeletedResiduals({ ...source, residualCofactor: source.residualCofactor.map(row => row.map(value => value * 0.5)) })).toThrow('invalid_residual_projector')
  })

  it('rejects out-of-range leverage and zero-redundancy components', () => {
    const { source } = lineFixture()
    expect(() => diagnoseDeletedResiduals({ ...source, residualCofactor: source.residualCofactor.map(row => row.map(value => value * 10)) })).toThrow('invalid_or_unresolved_leverage')
    expect(() => diagnoseDeletedResiduals({ model: 'linear-independent-observations', residuals: [0, 1, -1], observationWeights: [1, 1, 1], residualCofactor: [[0, 0, 0], [0, 1, 0], [0, 0, 1]], weightedResidualSum: 2, degreesOfFreedom: 2 })).toThrow('nonpositive_residual_variance')
  })
})
