import { createHash } from 'node:crypto'
import {
  SURVEY_REFERENCE_DATUM_POLICY_V1 as policy, SurveyReferenceDatumInputV1, SurveyReferenceDatumOutputV1,
  type SurveyReferenceDatumCovarianceCheckV1
} from '../contracts/survey-reference-datum.js'

type Matrix = number[][]
const MIN_NORMAL = 2 ** -1022
const subnormal = (value: number): boolean => value !== 0 && Math.abs(value) < MIN_NORMAL
type FailureCode = Extract<SurveyReferenceDatumOutputV1, { outcome: 'unavailable' }>['code']
class DatumFailure extends Error {
  constructor(readonly code: FailureCode, message: string) { super(message) }
}
const fail = (code: FailureCode, message: string): never => { throw new DatumFailure(code, message) }
const flags = {
  algorithmVersion: 'declared-reference-datum-1', status: 'trial-only', modelAssumptions: 'not-verified', sourceRecordsVerified: false,
  epochDependenceVerified: false, referencePhysicalStability: 'not-evaluated', referenceSelection: 'caller-declared-no-automatic-selection',
  engineeringDecision: 'not-evaluated', observationAction: 'none', significanceTesting: 'not-performed', formalCoordinatesModified: false
} as const
function sum(values: readonly number[]): number {
  let total = 0
  let correction = 0
  for (const value of values) {
    const next = total + value
    correction += Math.abs(total) >= Math.abs(value) ? (total - next) + value : (value - next) + total
    total = next
  }
  return total + correction
}
const dot = (a: readonly number[], b: readonly number[]): number => sum(a.map((value, i) => value * b[i]!))
const infinityNorm = (m: Matrix): number => Math.max(...m.map(row => sum(row.map(Math.abs))))
const matrix = (n: number, operation: (i: number, j: number) => number): Matrix => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => operation(i, j)))
function symmetricMatrix(n: number, operation: (i: number, j: number) => number): Matrix {
  const result = matrix(n, () => 0)
  for (let i = 0; i < n; i++) for (let j = i; j < n; j++) result[j]![i] = result[i]![j] = operation(i, j)
  return result
}

/** Spectral check on an equilibrated copy only: no eigenvalue clipping or matrix repair. */
function checkJointCovariance(covariance: Matrix): SurveyReferenceDatumCovarianceCheckV1 {
  const n = covariance.length
  if (covariance.some((row, i) => row.some((value, j) => value !== covariance[j]![i]))) return fail('covariance-not-symmetric', 'Each epoch covariance must be exactly symmetric; no averaging is performed')
  const diag = covariance.map((row, i) => row[i]!)
  if (diag.some(value => value < 0)) return fail('covariance-not-positive-semidefinite', 'A declared variance is negative')
  if (covariance.some((row, i) => diag[i] === 0 && row.some(value => value !== 0))) return fail('covariance-not-positive-semidefinite', 'A zero-variance coordinate must have an exactly zero covariance row')
  const positive = diag.filter(value => value > 0)
  if (positive.some(value => value < policy.minPositiveVariance || value > policy.maxVariance) || (positive.length && Math.max(...positive) / Math.min(...positive) > policy.maxVarianceRatio)) return fail('covariance-scale-outside-supported-domain', 'Positive variances must be in [1e-100,1e100] with a joint diagonal ratio at most 1e12')
  const active = diag.flatMap((value, i) => value > 0 ? [i] : [])
  const scales = diag.map(Math.sqrt)
  const correlation = active.map(i => active.map(j => covariance[i]![j]! / scales[i]! / scales[j]!))
  if (correlation.some(row => row.some(value => !Number.isFinite(value) || Math.abs(value) > 1 + policy.covarianceEigenvalueTolerance))) return fail('covariance-not-positive-semidefinite', 'A declared correlation violates the covariance Cauchy-Schwarz limit')
  const m = active.length
  let residual = 0
  let converged = m < 2
  for (let sweep = 0; sweep < 64 && !converged; sweep++) {
    for (let p = 0; p < m - 1; p++) for (let q = p + 1; q < m; q++) {
      const off = correlation[p]![q]!
      if (Math.abs(off) <= 8 * Number.EPSILON) continue
      const tau = (correlation[q]![q]! - correlation[p]![p]!) / (2 * off)
      const t = (tau < 0 ? -1 : 1) / (Math.abs(tau) + Math.hypot(1, tau))
      const c = 1 / Math.hypot(1, t)
      const s = t * c
      correlation[p]![p]! -= t * off
      correlation[q]![q]! += t * off
      correlation[p]![q] = correlation[q]![p] = 0
      for (let k = 0; k < m; k++) if (k !== p && k !== q) {
        const kp = correlation[k]![p]!
        const kq = correlation[k]![q]!
        correlation[k]![p] = correlation[p]![k] = c * kp - s * kq
        correlation[k]![q] = correlation[q]![k] = s * kp + c * kq
      }
    }
    residual = Math.max(0, ...correlation.flatMap((row, i) => row.filter((_, j) => j !== i).map(Math.abs)))
    converged = residual <= 32 * m * Number.EPSILON
  }
  if (!converged) return fail('covariance-eigensolver-iteration-limit', 'Joint covariance check exceeded 64 Jacobi sweeps')
  const minimum = m ? Math.min(...correlation.map((row, i) => row[i]!)) : 0
  if (!Number.isFinite(minimum) || minimum < -policy.covarianceEigenvalueTolerance) return fail('covariance-not-positive-semidefinite', 'The complete joint covariance has a materially negative correlation eigenvalue')
  return {
    method: 'diagonal-equilibrated-cyclic-jacobi-check-original-matrix-retained', dimension: n, activeDimension: m,
    minimumCorrelationEigenvalueEstimate: minimum, maximumOffDiagonalResidual: residual,
    eigenvalueTolerance: policy.covarianceEigenvalueTolerance,
    classification: m < n || minimum <= policy.covarianceEigenvalueTolerance ? 'semidefinite-or-unresolved-within-numerical-tolerance' : 'numerically-positive-definite', matrixRepair: 'none'
  }
}
function solveCholesky(lower: Matrix, values: number[]): number[] {
  const n = values.length
  const y = Array.from({ length: n }, () => 0)
  for (let i = 0; i < n; i++) y[i] = (values[i]! - sum(y.slice(0, i).map((v, j) => v * lower[i]![j]!))) / lower[i]![i]!
  const x = Array.from({ length: n }, () => 0)
  for (let i = n - 1; i >= 0; i--) x[i] = (y[i]! - sum(x.slice(i + 1).map((v, j) => v * lower[i + 1 + j]![i]!))) / lower[i]![i]!
  return x
}
function referenceGls(covariance: Matrix): { weights: number[]; condition: number; backwardError: number } {
  const n = covariance.length
  const scales = covariance.map((row, i) => Math.sqrt(row[i]!))
  if (scales.some(value => !(value > 0) || !Number.isFinite(value))) return fail('reference-covariance-rank-or-conditioning', 'GLS requires a resolvable positive-definite reference covariance; choose a different explicitly declared datum method if appropriate')
  const corr = covariance.map((row, i) => row.map((value, j) => value / scales[i]! / scales[j]!))
  const lower = matrix(n, () => 0)
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) {
    const remainder = corr[i]![j]! - sum(lower[i]!.slice(0, j).map((value, k) => value * lower[j]![k]!))
    if (i === j) {
      if (!(remainder > 1e-12) || !Number.isFinite(remainder)) return fail('reference-covariance-rank-or-conditioning', 'Reference covariance is singular, indefinite or numerically unresolved; no pseudoinverse or equal-weight fallback is used')
      lower[i]![j] = Math.sqrt(remainder)
    } else lower[i]![j] = remainder / lower[j]![j]!
  }
  const inverseColumns = Array.from({ length: n }, (_, i) => solveCholesky(lower, Array.from({ length: n }, (_, j) => i === j ? 1 : 0)))
  const condition = Math.max(1, infinityNorm(corr) * infinityNorm(matrix(n, (i, j) => inverseColumns[j]![i]!)))
  if (!Number.isFinite(condition) || condition > policy.maxReferenceCorrelationCondition) return fail('reference-covariance-rank-or-conditioning', 'Reference correlation condition exceeds the 1e10 software limit')
  const minimumScale = Math.min(...scales)
  const right = scales.map(scale => minimumScale / scale)
  const solution = solveCholesky(lower, right)
  const solveResidual = corr.map(row => dot(row, solution)).map((value, i) => value - right[i]!)
  const denominatorScale = infinityNorm(corr) * Math.max(...solution.map(Math.abs)) + Math.max(...right.map(Math.abs))
  const backwardError = Math.max(...solveResidual.map(Math.abs)) / denominatorScale
  const relativeInverse = solution.map((value, i) => value * right[i]!)
  const normalization = sum(relativeInverse)
  if (!Number.isFinite(backwardError) || backwardError > policy.backwardTolerance || !(normalization > 0)) return fail('numeric-range-or-resolution', 'GLS solve failed its relative backward-error or positive-normalization check')
  const weights = relativeInverse.map(value => value / normalization)
  if (weights.some(value => !Number.isFinite(value)) || sum(weights.map(Math.abs)) > policy.maxWeightAbsoluteSum) return fail('reference-covariance-rank-or-conditioning', 'Reference weights exceed the permitted cancellation budget')
  return { weights, condition, backwardError }
}

/** The supplied reference set defines a datum; it never proves any point physically stable. */
export function compareSurveyReferenceDatumV1(input: unknown): SurveyReferenceDatumOutputV1 {
  const parsed = SurveyReferenceDatumInputV1.safeParse(input)
  if (!parsed.success) return { ...flags, outcome: 'invalid-input', message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
  const request = parsed.data
  const common = { ...flags, request, requestSha256: createHash('sha256').update(JSON.stringify(request)).digest('hex') }
  let covarianceCheck: SurveyReferenceDatumCovarianceCheckV1 | null = null
  try {
    const n = request.mapping.length
    if ([...request.firstEpoch.points, ...request.secondEpoch.points].some(p => subnormal(p.coordinate))) return fail('numeric-range-or-resolution', 'Subnormal coordinate inputs are outside the supported arithmetic domain')
    const firstIndices = request.mapping.map(m => request.firstEpoch.points.findIndex(p => p.id === m.firstPointId))
    const secondIndices = request.mapping.map(m => request.secondEpoch.points.findIndex(p => p.id === m.secondPointId))
    const first = matrix(n, (i, j) => request.firstEpoch.covariance[firstIndices[i]!]![firstIndices[j]!]!)
    const second = matrix(n, (i, j) => request.secondEpoch.covariance[secondIndices[i]!]![secondIndices[j]!]!)
    const dependence = request.dependence
    const cross = matrix(n, (i, j) => dependence.kind === 'caller-declared-independent' ? 0 : dependence.firstToSecondCovariance[firstIndices[i]!]![secondIndices[j]!]!)
    const joint = matrix(2 * n, (i, j) => i < n ? j < n ? first[i]![j]! : cross[i]![j - n]! : j < n ? cross[j]![i - n]! : second[i - n]![j - n]!)
    covarianceCheck = checkJointCovariance(joint)
    const differenceCovariance = symmetricMatrix(n, (i, j) => sum([first[i]![j]! - cross[i]![j]!, second[i]![j]! - cross[j]![i]!]))
    if (differenceCovariance.some((row, i) => row[i]! < 0 || row.some(value => !Number.isFinite(value)))) return fail('numeric-range-or-resolution', 'Difference covariance has a negative variance or nonfinite entry; no variance is clipped')
    const pointIds = request.mapping.map(m => m.id)
    const referenceIndices = request.referenceIds.map(id => pointIds.indexOf(id))
    const gls = request.method === 'gls-reference-mean' ? referenceGls(referenceIndices.map(i => referenceIndices.map(j => differenceCovariance[i]![j]!))) : null
    const localWeights = gls?.weights ?? referenceIndices.map(() => 1 / referenceIndices.length)
    const referenceWeights = pointIds.map((_, i) => { const at = referenceIndices.indexOf(i); return at < 0 ? 0 : localWeights[at]! })
    const rawDifferences = pointIds.map((_, i) => request.secondEpoch.points[secondIndices[i]!]!.coordinate - request.firstEpoch.points[firstIndices[i]!]!.coordinate)
    const anchor = rawDifferences[referenceIndices[0]!]!
    const centered = rawDifferences.map(value => value - anchor)
    const centeredShift = dot(referenceWeights, centered)
    const referenceShift = anchor + centeredShift
    const displacements = centered.map(value => value - centeredShift)
    const transformation = matrix(n, (i, j) => (i === j ? 1 : 0) - referenceWeights[j]!)
    const differenceTimesWeight = differenceCovariance.map(row => dot(row, referenceWeights))
    const referenceShiftVariance = dot(referenceWeights, differenceTimesWeight)
    const shiftDisplacementCovariance = transformation.map(row => dot(row, differenceTimesWeight))
    const leftProduct = matrix(n, (i, j) => dot(transformation[i]!, differenceCovariance.map(row => row[j]!)))
    const displacementCovariance = symmetricMatrix(n, (i, j) => dot(leftProduct[i]!, transformation[j]!))
    const referenceWeightAbsoluteSum = sum(referenceWeights.map(Math.abs))
    const coordinateScale = Math.max(...request.firstEpoch.points.map(p => Math.abs(p.coordinate)), ...request.secondEpoch.points.map(p => Math.abs(p.coordinate)))
    const covarianceScale = Math.max(0, ...joint.flat().map(Math.abs))
    const coordinateRoundoffEstimate = 64 * n * Number.EPSILON * coordinateScale * (1 + referenceWeightAbsoluteSum)
    const covarianceRoundoffEstimate = 256 * n * n * Number.EPSILON * covarianceScale * (1 + referenceWeightAbsoluteSum) ** 2
    const referenceConstraintResidual = dot(referenceWeights, displacements)
    const scalars = [referenceShift, referenceShiftVariance, coordinateRoundoffEstimate, covarianceRoundoffEstimate, referenceConstraintResidual, ...displacements, ...shiftDisplacementCovariance, ...displacementCovariance.flat()]
    if (scalars.some(value => !Number.isFinite(value)) || [referenceShift, ...displacements].some(subnormal) || referenceShiftVariance < 0 || displacementCovariance.some((row, i) => row[i]! < 0)) return fail('numeric-range-or-resolution', 'Propagation produced a negative variance or nonfinite result; original covariance is not repaired')
    if (Math.abs(referenceConstraintResidual) > policy.backwardTolerance * Math.max(1, ...centered.map(Math.abs)) || Math.abs(sum(referenceWeights) - 1) > policy.backwardTolerance) return fail('numeric-range-or-resolution', 'Reference datum constraint failed its numerical resolution check')
    return SurveyReferenceDatumOutputV1.parse({
      ...common, outcome: 'calculated', pointIds, referenceIds: request.referenceIds, unit: request.unit, squaredUnit: `${request.unit}2`,
      differenceConvention: 'second-minus-first', displacementConvention: 'difference-minus-declared-reference-shift',
      datumMeaning: request.method === 'gls-reference-mean' ? 'declared-gls-reference-definition-not-proof-of-stability' : 'declared-equal-reference-definition-not-precision-optimality-or-stability',
      rawDifferences, differenceCovariance, referenceWeights, referenceShift, referenceShiftVariance, displacements, displacementCovariance,
      shiftDisplacementCovariance, transformation, covarianceCheck,
      numerical: { referenceCorrelationConditionInfinity: gls?.condition ?? null, referenceSolveRelativeBackwardError: gls?.backwardError ?? null,
        referenceWeightAbsoluteSum, referenceConstraintResidual, coordinateRoundoffEstimate, covarianceRoundoffEstimate,
        errorEstimateMeaning: 'software-resolution-diagnostic-not-certified-bound' }
    })
  } catch (error) {
    if (!(error instanceof DatumFailure)) throw error
    return SurveyReferenceDatumOutputV1.parse({ ...common, outcome: 'unavailable', code: error.code, message: error.message, covarianceCheck })
  }
}
