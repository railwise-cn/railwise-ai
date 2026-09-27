import { createHash } from 'node:crypto'
import { SurveyGeneralizedWRequestV1, SurveyGeneralizedWResultV1 } from '../contracts/survey-generalized-w.js'
import { choleskyDecompose, solveLowerTriangular, surveyMatrix, type Matrix } from './survey-adjustment-core.js'

const RANK_TOLERANCE = 1e-10
const DETECTABILITY_TOLERANCE = 1e-10
const BACKWARD_TOLERANCE = 1e-10
const STATISTIC_ERROR_BUDGET = 1e-8
const MIN_NORMAL = 2 ** -1022
const subnormal = (value: number): boolean => value !== 0 && Math.abs(value) < MIN_NORMAL
const norm = (values: readonly number[]): number => Math.hypot(...values)
const dot = (left: readonly number[], right: readonly number[]): number => left.reduce((sum, item, index) => sum + item * right[index]!, 0)
const finite = (values: readonly number[]): boolean => values.every(Number.isFinite)
const infinityNorm = (matrix: Matrix): number => Math.max(...matrix.map(row => row.reduce((sum, value) => sum + Math.abs(value), 0)))
type Reflector = { start: number; vector: number[] }

/** Orthogonal reflectors operate on normalized design columns. Their complete
 * tail is retained for bias detectability rather than subtracting two nearly
 * equal covariance matrices. This private kernel never changes observations. */
function applyReflector(values: number[], reflector: Reflector): void {
  let product = 0
  for (let index = 0; index < reflector.vector.length; index++) product += reflector.vector[index]! * values[reflector.start + index]!
  for (let index = 0; index < reflector.vector.length; index++) values[reflector.start + index]! -= 2 * product * reflector.vector[index]!
}
function transform(values: readonly number[], reflectors: readonly Reflector[], inverse = false): number[] {
  const result = [...values]
  for (const reflector of inverse ? [...reflectors].reverse() : reflectors) applyReflector(result, reflector)
  return result
}
function decompose(design: Matrix): { upper: Matrix; scales: number[]; permutation: number[]; reflectors: Reflector[] } | null {
  const n = design.length, p = design[0]!.length
  const scales = Array.from({ length: p }, (_, column) => norm(design.map(row => row[column]!)))
  if (scales.some(scale => !(scale > 0) || !Number.isFinite(scale))) return null
  const upper = design.map(row => row.map((value, column) => value / scales[column]!))
  const permutation = Array.from({ length: p }, (_, index) => index), reflectors: Reflector[] = []
  for (let column = 0; column < p; column++) {
    let pivot = column, greatest = -1
    for (let candidate = column; candidate < p; candidate++) {
      const length = norm(upper.slice(column).map(row => row[candidate]!))
      if (length > greatest) { greatest = length; pivot = candidate }
    }
    if (!Number.isFinite(greatest) || greatest <= RANK_TOLERANCE) return null
    if (pivot !== column) {
      for (const row of upper) [row[column], row[pivot]] = [row[pivot]!, row[column]!]
      ;[permutation[column], permutation[pivot]] = [permutation[pivot]!, permutation[column]!]
    }
    const vector = upper.slice(column).map(row => row[column]!)
    const diagonal = vector[0]! >= 0 ? -greatest : greatest
    vector[0]! -= diagonal
    const vectorNorm = norm(vector)
    if (!Number.isFinite(vectorNorm) || vectorNorm === 0) return null
    const reflector = { start: column, vector: vector.map(value => value / vectorNorm) }
    for (let target = column; target < p; target++) {
      const values = upper.map(row => row[target]!)
      applyReflector(values, reflector)
      for (let row = column; row < n; row++) upper[row]![target] = values[row]!
    }
    // Exact storage of the structural zero avoids using roundoff as rank.
    upper[column]![column] = diagonal
    for (let row = column + 1; row < n; row++) upper[row]![column] = 0
    reflectors.push(reflector)
  }
  return { upper, scales, permutation, reflectors }
}
function solveUpper(upper: Matrix, values: number[]): number[] {
  const solved = Array.from({ length: values.length }, () => 0)
  for (let row = values.length - 1; row >= 0; row--) {
    let value = values[row]!
    for (let column = row + 1; column < values.length; column++) value -= upper[row]![column]! * solved[column]!
    solved[row] = value / upper[row]![row]!
  }
  return solved
}

/** Generalized single-direction w under a DECLARED known absolute covariance.
 * Full-column-rank fixed linear models only; no datum constraints, normal/t
 * distribution functions, multiple testing, deletion, or approval are implied. */
export function diagnoseGeneralizedW(input: unknown): SurveyGeneralizedWResultV1 {
  const request = SurveyGeneralizedWRequestV1.parse(input), n = request.observations.length, p = request.parameterIds.length
  const common = {
    schemaVersion: 1, diagnosticsVersion: 'fixed-linear-known-covariance-generalized-w-1', request,
    requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    source: { id: 'AMIRI-2007', equation: '2.39', printedPage: 17, pdfPage: 29,
      sourceSha256: '4c4b6311f6da13844f559c48a57a62cd5467434b51d563805ae176a7a4ec9207',
      url: 'https://resolver.tudelft.nl/uuid:bc7f8919-1baf-4f02-b115-dc926c5ec090',
      provenance: 'previously-recorded-method-source-not-a-new-reading-or-signoff' },
    covarianceComputation: 'diagonal-equilibrated-cholesky-whitening', projectionComputation: 'column-scaled-pivoted-householder-qr',
    relativeRankTolerance: RANK_TOLERANCE, relativeDetectabilityTolerance: DETECTABILITY_TOLERANCE,
    statisticErrorPolicy: 'conservative-condition-based-budget-1', relativeStatisticErrorBudget: STATISTIC_ERROR_BUDGET,
    assumptionsVerified: false, familyDeclarationVerified: false, distributionEvaluation: 'not-performed', multipleComparisonAdjustment: 'not-performed',
    decision: 'not-evaluated', observationAction: 'none', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated'
  }
  const unavailable = (reason: Extract<SurveyGeneralizedWResultV1, { modelStatus: 'unavailable' }>['reason']): SurveyGeneralizedWResultV1 =>
    SurveyGeneralizedWResultV1.parse({ ...common, modelStatus: 'unavailable', reason, diagnostics: [] })
  if (n <= p) return unavailable('insufficient-residual-degrees-of-freedom')
  const standardScales = request.covariance.matrix.map((row, index) => Math.sqrt(row[index]!))
  if (standardScales.some(value => !(value > 0) || !Number.isFinite(value))) return unavailable('covariance-not-symmetric-positive-definite-or-numerically-unresolved')
  const lower = choleskyDecompose(request.covariance.matrix.map((row, i) => row.map((value, j) => value / standardScales[i]! / standardScales[j]!)))
  if (!lower) return unavailable('covariance-not-symmetric-positive-definite-or-numerically-unresolved')
  const whiten = (values: number[]): number[] | null => {
    const result = solveLowerTriangular(lower, values.map((value, index) => value / standardScales[index]!))
    return result && finite(result) ? result : null
  }
  const observations = whiten(request.observations)
  const columns = Array.from({ length: p }, (_, column) => whiten(request.designMatrix.map(row => row[column]!)))
  if (!observations || columns.some(column => !column)) return unavailable('numeric-range-or-backward-error')
  const design = Array.from({ length: n }, (_, row) => columns.map(column => column![row]!))
  const qr = decompose(design)
  if (!qr) return unavailable('design-not-full-rank-or-numerically-unresolved')
  const lowerInverseColumns = Array.from({ length: n }, (_, column) => solveLowerTriangular(lower, Array.from({ length: n }, (_, row) => row === column ? 1 : 0)))
  if (lowerInverseColumns.some(column => !column || !finite(column))) return unavailable('numeric-range-or-backward-error')
  const whiteningConditionEstimate = Math.max(1, infinityNorm(lower) * infinityNorm(surveyMatrix.transpose(lowerInverseColumns as Matrix)))
  const upper = qr.upper.slice(0, p)
  const upperInverse = surveyMatrix.transpose(Array.from({ length: p }, (_, column) => solveUpper(upper, Array.from({ length: p }, (_, row) => row === column ? 1 : 0))))
  const designConditionEstimate = Math.max(1, infinityNorm(upper) * infinityNorm(upperInverse))
  const transformed = transform(observations, qr.reflectors)
  if (!finite(transformed)) return unavailable('numeric-range-or-backward-error')
  const scaledParameters = solveUpper(upper, transformed.slice(0, p))
  const parameters = Array.from({ length: p }, () => 0)
  for (let index = 0; index < p; index++) parameters[qr.permutation[index]!] = scaledParameters[index]! / qr.scales[qr.permutation[index]!]!
  const adjustedObservations = surveyMatrix.multiplyVector(request.designMatrix, parameters)
  const residuals = request.observations.map((value, index) => value - adjustedObservations[index]!)
  // Verify that the explicit observed-minus-adjusted residual agrees with the
  // orthogonal residual projection to a scale-aware backward-error bound.
  const whitenedResidual = transform(transformed.map((value, index) => index < p ? 0 : value), qr.reflectors, true)
  const projectedResidual = surveyMatrix.multiplyVector(lower, whitenedResidual).map((value, index) => value * standardScales[index]!)
  if (![parameters, adjustedObservations, residuals, projectedResidual].every(finite)) return unavailable('numeric-range-or-backward-error')
  const errorScale = Math.max(norm(request.observations), norm(adjustedObservations))
  const reconstructionError = norm(residuals.map((value, index) => value - projectedResidual[index]!))
  if (!Number.isFinite(errorScale) || reconstructionError > BACKWARD_TOLERANCE * errorScale) return unavailable('numeric-range-or-backward-error')
  // Cov(v) = D L Q_tail Q_tailᵀ Lᵀ D, evaluated as a Gram matrix. This avoids
  // cancellation in C - A Cov(xhat) Aᵀ and preserves correlated observations.
  const residualFactors = Array.from({ length: n - p }, (_, column) => {
    const axis = Array.from({ length: n }, (_, row) => row === p + column ? 1 : 0)
    return surveyMatrix.multiplyVector(lower, transform(axis, qr.reflectors, true)).map((value, index) => value * standardScales[index]!)
  })
  const residualCovariance = Array.from({ length: n }, (_, row) => Array.from({ length: n }, (_, column) =>
    residualFactors.reduce((sum, factor) => sum + factor[row]! * factor[column]!, 0)))
  const standardizedTail = transformed.slice(p)
  const aprioriWeightedResidualSum = dot(standardizedTail, standardizedTail)
  if (!finite(residualCovariance.flat()) || !Number.isFinite(aprioriWeightedResidualSum)
    || residualCovariance.flat().some(subnormal) || subnormal(aprioriWeightedResidualSum)
    || aprioriWeightedResidualSum === 0 && standardizedTail.some(value => value !== 0)
    || residualCovariance.some((row, index) => row[index] === 0 && residualFactors.some(factor => factor[index] !== 0))) return unavailable('numeric-range-or-backward-error')
  // A normwise fit check alone cannot protect w: a tiny QR tail error relative
  // to a huge mean may be large in prior-standard-deviation units. This is a
  // conservative software budget estimate, not a certified forward-error bound.
  // Correlation and normalized-design conditioning are included; c's relative
  // residual projection is included per direction below.
  const statisticRoundoffEstimate = 64 * n * Number.EPSILON * whiteningConditionEstimate ** 2 * designConditionEstimate * norm(observations)
  if (!Number.isFinite(statisticRoundoffEstimate)) return unavailable('numeric-range-or-backward-error')
  const diagnostics = []
  for (const direction of request.biasDirections) {
    // Normalize c before whitening. Its positive magnitude cancels from w and
    // the detectability ratio; this also avoids tiny/huge c creating false rank.
    const directionScale = Math.max(...direction.coefficients.map(Math.abs))
    const whitenedDirection = whiten(direction.coefficients.map(value => value / directionScale))
    if (!whitenedDirection) return unavailable('numeric-range-or-backward-error')
    const totalNorm = norm(whitenedDirection)
    if (!(totalNorm > 0) || !Number.isFinite(totalNorm)) return unavailable('numeric-range-or-backward-error')
    const transformedDirection = transform(whitenedDirection.map(value => value / totalNorm), qr.reflectors)
    const directionTail = transformedDirection.slice(p), tailNorm = norm(directionTail)
    const detectabilityRatio = tailNorm
    if (!(totalNorm > 0) || !finite([totalNorm, tailNorm, detectabilityRatio]) || detectabilityRatio > 1 + 1e-12) return unavailable('numeric-range-or-backward-error')
    if (detectabilityRatio <= DETECTABILITY_TOLERANCE) {
      diagnostics.push({ id: direction.id, status: 'not-detectable-or-numerically-unresolved', detectabilityRatio,
        reason: 'bias-direction-in-or-too-close-to-model-column-space', generalizedW: null, absoluteGeneralizedW: null })
    } else {
      const generalizedW = dot(directionTail.map(value => value / tailNorm), standardizedTail)
      const statisticErrorEstimate = statisticRoundoffEstimate / detectabilityRatio
      if (!Number.isFinite(generalizedW) || !Number.isFinite(statisticErrorEstimate)
        || statisticErrorEstimate > STATISTIC_ERROR_BUDGET * Math.max(1, Math.abs(generalizedW))) return unavailable('numeric-range-or-backward-error')
      diagnostics.push({ id: direction.id, status: 'resolved', detectabilityRatio, generalizedW, absoluteGeneralizedW: Math.abs(generalizedW), statisticErrorEstimate })
    }
  }
  return SurveyGeneralizedWResultV1.parse({ ...common, modelStatus: 'resolved', rank: p, degreesOfFreedom: n - p,
    parameters, adjustedObservations, residuals, residualCovariance, aprioriWeightedResidualSum,
    whiteningConditionEstimate, designConditionEstimate, diagnostics })
}
