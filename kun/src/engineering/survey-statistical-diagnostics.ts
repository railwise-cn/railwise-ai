/**
 * Independent diagnostic primitive; it is not wired to persisted algorithm-7
 * results. The caller must provide Cov(v), including the KNOWN a-priori scale,
 * from the same linear/linearized model as v. Observation covariance is NOT
 * interchangeable with residual covariance. No critical values or decisions
 * are inferred here, and these statistics are not Student-t statistics.
 */
export type AprioriResidualDiagnosticsInput = {
  varianceBasis: 'known-apriori'
  covarianceKind: 'residual-covariance'
  residuals: readonly number[]
  residualCovariance: readonly (readonly number[])[]
  degreesOfFreedom: number
}

const MAX_RESIDUALS = 256
const COVARIANCE_TOLERANCE = 1e-10

export function diagnoseAprioriResiduals(input: AprioriResidualDiagnosticsInput) {
  const { residuals, residualCovariance: covariance, degreesOfFreedom: dof } = input
  if (input.varianceBasis !== 'known-apriori' || input.covarianceKind !== 'residual-covariance') {
    throw new Error('statistical_diagnostics_requires_apriori_residual_covariance')
  }
  const { deviations, standardized, rank } = validateResidualCovariance(residuals, covariance, dof)
  return {
    diagnosticsVersion: 'apriori-residual-z-1' as const,
    statistic: 'signed-apriori-residual-z' as const,
    varianceBasis: 'known-apriori' as const,
    covarianceRank: rank,
    degreesOfFreedom: dof,
    decision: 'not-evaluated' as const,
    observations: standardized.map((value, index) => ({
      index, residual: residuals[index]!, residualStandardDeviation: deviations[index]!,
      standardizedResidual: value, absoluteStandardizedResidual: Math.abs(value)
    }))
  }
}

export type DeletedResidualDiagnosticsInput = {
  /** Fixed linear model with Cov(l)=sigma0²*diag(1/p_i). No correlated observations. */
  model: 'linear-independent-observations'
  residuals: readonly number[]
  observationWeights: readonly number[]
  /** Qvv = diag(1/p_i) - A(AᵀPA)⁻¹Aᵀ, NOT multiplied by posterior variance. */
  residualCofactor: readonly (readonly number[])[]
  weightedResidualSum: number
  degreesOfFreedom: number
}

/** External studentization with the i-th observation removed from the scale
 * estimate. No critical value, p-value or automatic deletion is supplied. */
export function diagnoseDeletedResiduals(input: DeletedResidualDiagnosticsInput) {
  if (input.model !== 'linear-independent-observations') throw new Error('statistical_diagnostics_requires_independent_linear_model')
  const { residuals, observationWeights: weights, residualCofactor: cofactor, degreesOfFreedom: dof, weightedResidualSum: sse } = input
  if (!Number.isInteger(dof) || dof <= 1) throw new Error('statistical_diagnostics_insufficient_deleted_degrees_of_freedom')
  const { rank } = validateResidualCovariance(residuals, cofactor, dof)
  const n = residuals.length
  if (weights.length !== n || weights.some(weight => !Number.isFinite(weight) || weight <= 0)) throw new Error('statistical_diagnostics_invalid_observation_weights')
  if (!Number.isFinite(sse) || sse <= 0) throw new Error('statistical_diagnostics_invalid_weighted_residual_sum')
  const calculatedSse = residuals.reduce((sum, residual, i) => sum + residual * weights[i]! * residual, 0)
  if (!Number.isFinite(calculatedSse) || Math.abs(calculatedSse - sse) > 1e-10 * Math.max(calculatedSse, sse)) {
    throw new Error('statistical_diagnostics_weighted_residual_sum_mismatch')
  }
  const squareRootWeights = weights.map(Math.sqrt)
  const projection = cofactor.map((row, i) => row.map((value, j) => squareRootWeights[i]! * value * squareRootWeights[j]!))
  if (projection.some(row => row.some(value => !Number.isFinite(value)))) throw new Error('statistical_diagnostics_numeric_range')
  const redundancy = projection.map((row, i) => row[i]!)
  if (redundancy.some(value => value <= COVARIANCE_TOLERANCE || value > 1 + COVARIANCE_TOLERANCE)) {
    throw new Error('statistical_diagnostics_invalid_or_unresolved_leverage')
  }
  // For independent-observation WLS, R=P½QvvP½ is an orthogonal residual
  // projector. This rejects a posteriori-scaled or otherwise unrelated Qvv.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let square = 0
      for (let k = 0; k < n; k++) square += projection[i]![k]! * projection[k]![j]!
      if (Math.abs(square - projection[i]![j]!) > 1e-9) throw new Error('statistical_diagnostics_invalid_residual_projector')
    }
  }
  if (Math.abs(redundancy.reduce((sum, value) => sum + value, 0) - dof) > n * 1e-9) throw new Error('statistical_diagnostics_invalid_residual_projector')
  const observations = residuals.map((residual, index) => {
    const qii = cofactor[index]![index]!
    const deletedSum = sse - residual * (residual / qii)
    // A near-zero subtraction is numerically unresolved, not perfect evidence
    // or permission to replace the denominator with an arbitrary epsilon.
    if (!Number.isFinite(deletedSum) || deletedSum <= sse * 1e-12) throw new Error('statistical_diagnostics_nonpositive_or_unresolved_deleted_variance')
    const deletedVarianceFactor = deletedSum / (dof - 1)
    const denominator = Math.sqrt(deletedVarianceFactor) * Math.sqrt(qii)
    const t = residual / denominator
    if (!Number.isFinite(t) || !Number.isFinite(denominator) || denominator <= 0) throw new Error('statistical_diagnostics_numeric_range')
    return {
      index, residual, residualCofactor: qii,
      redundancy: Math.min(1, redundancy[index]!), leverage: Math.max(0, 1 - redundancy[index]!),
      deletedWeightedResidualSum: deletedSum, deletedVarianceFactor,
      externallyStudentizedResidual: t, absoluteExternallyStudentizedResidual: Math.abs(t)
    }
  })
  return {
    diagnosticsVersion: 'independent-wls-deleted-t-1' as const,
    statistic: 'externally-studentized-residual-t' as const,
    model: 'linear-independent-observations' as const,
    covarianceRank: rank, fullModelDegreesOfFreedom: dof,
    degreesOfFreedom: dof - 1, decision: 'not-evaluated' as const, observations
  }
}

function validateResidualCovariance(residuals: readonly number[], covariance: readonly (readonly number[])[], dof: number) {
  const n = residuals.length
  if (!n || n > MAX_RESIDUALS || covariance.length !== n || covariance.some(row => row.length !== n)) {
    throw new Error('statistical_diagnostics_invalid_dimension')
  }
  if (!Number.isInteger(dof) || dof <= 0 || dof > n) throw new Error('statistical_diagnostics_invalid_redundancy')
  if (residuals.some(value => !Number.isFinite(value)) || covariance.some(row => row.some(value => !Number.isFinite(value)))) {
    throw new Error('statistical_diagnostics_nonfinite_input')
  }
  const deviations = covariance.map((row, i) => {
    if (row[i]! <= 0) throw new Error('statistical_diagnostics_nonpositive_residual_variance')
    return Math.sqrt(row[i]!)
  })
  // Normalize to a correlation matrix so the PSD tolerance is dimensionless
  // even when one component is an angle and another a length.
  const correlation = covariance.map((row, i) => row.map((value, j) => value / deviations[i]! / deviations[j]!))
  const standardized = residuals.map((value, i) => value / deviations[i]!)
  if (standardized.some(value => !Number.isFinite(value)) || correlation.some(row => row.some(value => !Number.isFinite(value)))) {
    throw new Error('statistical_diagnostics_numeric_range')
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (Math.abs(correlation[i]![j]! - correlation[j]![i]!) > COVARIANCE_TOLERANCE) {
        throw new Error('statistical_diagnostics_asymmetric_covariance')
      }
      const symmetric = (correlation[i]![j]! + correlation[j]![i]!) / 2
      correlation[i]![j] = symmetric
      correlation[j]![i] = symmetric
    }
  }
  const rank = residualCovarianceRank(correlation, standardized)
  if (rank !== dof) throw new Error('statistical_diagnostics_covariance_rank_mismatch')
  return { deviations, standardized, rank }
}

/** Pivoted Schur elimination accepts singular PSD covariance and checks that
 * the residual vector lies in its range. A zero-variance observation is rejected
 * earlier because it has no defined per-observation standardized statistic. */
function residualCovarianceRank(source: number[][], residuals: number[]): number {
  const matrix = source.map(row => [...row])
  // Range membership is homogeneous: an absolute floor would accept a small
  // vector lying entirely in the nullspace. Scaling also bounds elimination.
  const residualScale = Math.max(...residuals.map(Math.abs))
  const remainder = residuals.map(value => residualScale === 0 ? 0 : value / residualScale)
  const n = matrix.length
  const residualTolerance = 1e-8
  for (let k = 0; k < n; k++) {
    let pivotIndex = k
    for (let i = k + 1; i < n; i++) if (matrix[i]![i]! > matrix[pivotIndex]![pivotIndex]!) pivotIndex = i
    if (pivotIndex !== k) {
      ;[matrix[k], matrix[pivotIndex]] = [matrix[pivotIndex]!, matrix[k]!]
      for (const row of matrix) [row[k], row[pivotIndex]] = [row[pivotIndex]!, row[k]!]
      ;[remainder[k], remainder[pivotIndex]] = [remainder[pivotIndex]!, remainder[k]!]
    }
    const pivot = matrix[k]![k]!
    if (pivot < -COVARIANCE_TOLERANCE) throw new Error('statistical_diagnostics_indefinite_covariance')
    if (pivot <= COVARIANCE_TOLERANCE) {
      for (let i = k; i < n; i++) {
        for (let j = k; j < n; j++) {
          if (Math.abs(matrix[i]![j]!) > COVARIANCE_TOLERANCE) throw new Error('statistical_diagnostics_indefinite_covariance')
        }
        if (Math.abs(remainder[i]!) > residualTolerance) throw new Error('statistical_diagnostics_residual_outside_covariance_range')
      }
      return k
    }
    for (let i = k + 1; i < n; i++) {
      const factor = matrix[i]![k]! / pivot
      remainder[i] = remainder[i]! - factor * remainder[k]!
      if (!Number.isFinite(remainder[i])) throw new Error('statistical_diagnostics_numeric_range')
      for (let j = i; j < n; j++) {
        matrix[i]![j] = matrix[i]![j]! - factor * matrix[k]![j]!
        if (!Number.isFinite(matrix[i]![j])) throw new Error('statistical_diagnostics_numeric_range')
        matrix[j]![i] = matrix[i]![j]!
      }
    }
  }
  return n
}
