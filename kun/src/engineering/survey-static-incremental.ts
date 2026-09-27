import { createHash } from 'node:crypto'
import {
  SURVEY_STATIC_INCREMENTAL_POLICY_V1 as policy, SurveyStaticIncrementalBaseV1, SurveyStaticIncrementalInputV1, SurveyStaticIncrementalOutputV1
} from '../contracts/survey-static-incremental.js'

type Matrix = number[][]
type Observation = SurveyStaticIncrementalBaseV1['observations'][number]
type State = { upper: Matrix; transformedRightHandSide: number[]; residualNorm: number }
type Fit = Extract<SurveyStaticIncrementalOutputV1, { outcome: 'calculated' }>['updatedFit']
type Code = Extract<SurveyStaticIncrementalOutputV1, { outcome: 'unavailable' }>['code']
class IncrementalFailure extends Error { constructor(readonly code: Code, message: string) { super(message) } }
const fail = (code: Code, message: string): never => { throw new IncrementalFailure(code, message) }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const MIN_NORMAL = 2 ** -1022
const subnormal = (value: number): boolean => value !== 0 && Math.abs(value) < MIN_NORMAL
const flags = {
  algorithmVersion: 'declared-static-linear-append-1', status: 'trial-only', modelAssumptions: 'not-verified', sourceRecordsVerified: false,
  priorRuntimeStateVerified: false, formalResultsModified: false, originalObservationsModified: false, engineeringDecision: 'not-evaluated',
  persistenceAndCrossRequestIdempotency: 'not-implemented-pure-replay-only', computation: 'replay-base-then-givens-append-with-householder-batch-check'
} as const
const zeros = (n: number): number[] => Array.from({ length: n }, () => 0)
const square = (n: number): Matrix => Array.from({ length: n }, () => zeros(n))
function sum(values: readonly number[]): number {
  let s = 0
  let c = 0
  for (const value of values) {
    const next = s + value
    c += Math.abs(s) >= Math.abs(value) ? (s - next) + value : (value - next) + s
    s = next
  }
  return s + c
}
const dot = (a: readonly number[], b: readonly number[]): number => sum(a.map((value, i) => value * b[i]!))
const infinityNorm = (a: Matrix): number => Math.max(...a.map(row => sum(row.map(Math.abs))))
export function hashSurveyStaticIncrementalBaseV1(input: unknown): string {
  return hash(SurveyStaticIncrementalBaseV1.parse(input))
}
function whiten(observation: Observation): { row: number[]; right: number } {
  if ([observation.value, ...observation.coefficients].some(subnormal)) return fail('numeric-range-or-resolution', 'Subnormal observation or coefficient inputs are unsupported')
  const sigma = Math.sqrt(observation.aprioriVariance)
  const row = observation.coefficients.map(value => value / sigma)
  const right = observation.value / sigma
  if ([right, ...row].some(value => !Number.isFinite(value) || subnormal(value)) || observation.value !== 0 && right === 0 || row.some((value, i) => value === 0 && observation.coefficients[i] !== 0)) return fail('numeric-range-or-resolution', 'Whitening overflowed or underflowed the supported arithmetic domain')
  return { row, right }
}
function appendRow(state: State, inputRow: readonly number[], inputRight: number): { rotationCosines: number[]; rotationSines: number[]; transformedResidual: number } {
  const row = [...inputRow]
  let right = inputRight
  const p = row.length
  const rotationCosines = zeros(p)
  const rotationSines = zeros(p)
  for (let j = 0; j < p; j++) {
    const a = state.upper[j]![j]!
    const b = row[j]!
    const radius = Math.hypot(a, b)
    const c = radius === 0 ? 1 : a / radius
    const s = radius === 0 ? 0 : b / radius
    rotationCosines[j] = c
    rotationSines[j] = s
    state.upper[j]![j] = radius
    for (let k = j + 1; k < p; k++) {
      const old = state.upper[j]![k]!
      state.upper[j]![k] = c * old + s * row[k]!
      row[k] = -s * old + c * row[k]!
    }
    const oldRight = state.transformedRightHandSide[j]!
    state.transformedRightHandSide[j] = c * oldRight + s * right
    right = -s * oldRight + c * right
  }
  state.residualNorm = Math.hypot(state.residualNorm, right)
  if ([...state.upper.flat(), ...state.transformedRightHandSide, state.residualNorm].some(value => !Number.isFinite(value))) return fail('numeric-range-or-resolution', 'Givens state became nonfinite')
  return { rotationCosines, rotationSines, transformedResidual: right }
}
function solveUpper(upper: Matrix, right: readonly number[]): number[] {
  const p = right.length
  const x = zeros(p)
  for (let i = p - 1; i >= 0; i--) x[i] = (right[i]! - sum(x.slice(i + 1).map((value, j) => value * upper[i]![i + j + 1]!))) / upper[i]![i]!
  return x
}
function inspect(upper: Matrix, code: 'base-rank-or-conditioning' | 'updated-rank-or-conditioning'): { inverse: Matrix; condition: number } {
  const p = upper.length
  const scale = infinityNorm(upper)
  if (!(scale > 0) || upper.some((row, i) => Math.abs(row[i]!) <= policy.relativeRankTolerance * scale)) return fail(code, 'Fixed design is rank-deficient or its triangular factor is numerically unresolved')
  const columns = Array.from({ length: p }, (_, j) => solveUpper(upper, Array.from({ length: p }, (_, i) => i === j ? 1 : 0)))
  const inverse = Array.from({ length: p }, (_, i) => columns.map(column => column[i]!))
  const condition = Math.max(1, scale * infinityNorm(inverse))
  if (!Number.isFinite(condition) || condition > policy.maxTriangularCondition || inverse.flat().some(value => !Number.isFinite(value))) return fail(code, 'Triangular condition exceeds the fixed 1e8 limit')
  return { inverse, condition }
}
function makeFit(state: State, inverse: Matrix, scales: number[], observations: Observation[]): Fit {
  const p = scales.length
  const parameters = solveUpper(state.upper, state.transformedRightHandSide).map((value, j) => value / scales[j]!)
  const inverseRows = inverse.map((row, i) => row.map(value => value / scales[i]!))
  const covariance = square(p)
  for (let i = 0; i < p; i++) for (let j = i; j < p; j++) covariance[j]![i] = covariance[i]![j] = dot(inverseRows[i]!, inverseRows[j]!)
  const adjustedObservations = observations.map(o => dot(o.coefficients, parameters))
  const residuals = observations.map((o, i) => o.value - adjustedObservations[i]!)
  const weightedResidualSumSquares = state.residualNorm * state.residualNorm
  const values = [...parameters, ...covariance.flat(), ...adjustedObservations, ...residuals, weightedResidualSumSquares]
  if (values.some(value => !Number.isFinite(value)) || parameters.some(subnormal) || covariance.some((row, i) => !(row[i]! > 0)) || state.residualNorm !== 0 && (weightedResidualSumSquares === 0 || subnormal(weightedResidualSumSquares))) return fail('numeric-range-or-resolution', 'Fit or prior covariance is nonfinite, unresolved or underflowed')
  const degreesOfFreedom = observations.length - p
  return { parameters, aprioriParameterCovariance: covariance, adjustedObservations, residuals, weightedResidualSumSquares, degreesOfFreedom,
    posteriorVarianceFactorEstimate: weightedResidualSumSquares / degreesOfFreedom, posteriorEstimateUse: 'diagnostic-only-not-applied-to-prior-covariance-or-weights' }
}
/** Independent from-scratch QR algorithm for the same declared, fixed-column-scaled model. */
function householder(rows: Matrix, observations: number[]): State {
  const a = rows.map(row => [...row])
  const right = [...observations]
  const n = rows.length
  const p = rows[0]!.length
  for (let j = 0; j < p; j++) {
    const v = a.slice(j).map(row => row[j]!)
    const length = Math.hypot(...v)
    if (!(length > 0) || !Number.isFinite(length)) return fail('updated-rank-or-conditioning', 'Batch reference design is rank-unresolved')
    const diagonal = v[0]! >= 0 ? -length : length
    v[0]! -= diagonal
    const vnorm = Math.hypot(...v)
    const normalized = v.map(value => value / vnorm)
    for (let k = j; k < p; k++) {
      const product = dot(normalized, a.slice(j).map(row => row[k]!))
      for (let i = j; i < n; i++) a[i]![k]! -= 2 * normalized[i - j]! * product
    }
    const product = dot(normalized, right.slice(j))
    for (let i = j; i < n; i++) right[i]! -= 2 * normalized[i - j]! * product
    a[j]![j] = diagonal
    for (let i = j + 1; i < n; i++) a[i]![j] = 0
  }
  return { upper: a.slice(0, p), transformedRightHandSide: right.slice(0, p), residualNorm: Math.hypot(...right.slice(p)) }
}
function snapshot(state: State, scales: number[]): State & { columnScales: number[]; stateSha256: string } {
  const copy = { upper: state.upper.map(row => [...row]), transformedRightHandSide: [...state.transformedRightHandSide], residualNorm: state.residualNorm, columnScales: [...scales] }
  return { ...copy, stateSha256: hash(copy) }
}

export function appendSurveyStaticLinearObservationsV1(input: unknown): SurveyStaticIncrementalOutputV1 {
  const parsed = SurveyStaticIncrementalInputV1.safeParse(input)
  if (!parsed.success) return { ...flags, outcome: 'invalid-input', message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') }
  const request = parsed.data
  const computedBaseFingerprint = hashSurveyStaticIncrementalBaseV1(request.base)
  const common = { ...flags, request, requestSha256: hash(request), computedBaseFingerprint }
  try {
    if (computedBaseFingerprint !== request.expectedBaseFingerprint) return fail('base-fingerprint-mismatch', 'Existing model, observations, weights, identity or revision differ from the declared base fingerprint')
    const observations = [...request.base.observations, ...request.append.observations]
    const variances = observations.map(o => o.aprioriVariance)
    if (Math.max(...variances) / Math.min(...variances) > policy.maxVarianceRatio) return fail('variance-ratio-outside-supported-domain', 'Complete fixed-model prior variance ratio exceeds 1e12')
    const p = request.base.parameterIds.length
    const baseCount = request.base.observations.length
    const whitened = observations.map(whiten)
    const columnScales = Array.from({ length: p }, (_, j) => Math.hypot(...whitened.slice(0, baseCount).map(o => o.row[j]!)))
    if (columnScales.some(scale => scale === 0)) return fail('base-rank-or-conditioning', 'Base model contains a zero design column')
    if (columnScales.some(scale => !Number.isFinite(scale) || scale < 1e-100 || scale > 1e100)) return fail('numeric-range-or-resolution', 'Original whitened column scales must be in [1e-100,1e100]')
    const rows = whitened.map(o => o.row.map((value, j) => value / columnScales[j]!))
    if (rows.some((row, i) => row.some((value, j) => !Number.isFinite(value) || subnormal(value) || value === 0 && whitened[i]!.row[j] !== 0))) return fail('numeric-range-or-resolution', 'Fixed column scaling produced unsupported numbers')
    const state: State = { upper: square(p), transformedRightHandSide: zeros(p), residualNorm: 0 }
    for (let i = 0; i < baseCount; i++) appendRow(state, rows[i]!, whitened[i]!.right)
    const baseInspection = inspect(state.upper, 'base-rank-or-conditioning')
    const baseFit = makeFit(state, baseInspection.inverse, columnScales, request.base.observations)
    const baseQrState = snapshot(state, columnScales)
    const steps = []
    for (let i = baseCount; i < observations.length; i++) {
      const rotation = appendRow(state, rows[i]!, whitened[i]!.right)
      // Every step retains rank and conditioning gates, not only the final append.
      inspect(state.upper, 'updated-rank-or-conditioning')
      steps.push({ observationId: observations[i]!.id, totalObservationCount: i + 1, ...rotation, accumulatedResidualNorm: state.residualNorm, stateSha256: snapshot(state, columnScales).stateSha256 })
    }
    const updatedInspection = inspect(state.upper, 'updated-rank-or-conditioning')
    const updatedFit = makeFit(state, updatedInspection.inverse, columnScales, observations)
    const updatedQrState = snapshot(state, columnScales)
    const batch = householder(rows, whitened.map(o => o.right))
    const batchInspection = inspect(batch.upper, 'updated-rank-or-conditioning')
    const referenceFit = makeFit(batch, batchInspection.inverse, columnScales, observations)
    const yNorm = Math.hypot(...whitened.map(o => o.right))
    const parameterScales = updatedInspection.inverse.map((row, i) => yNorm * Math.hypot(...row) / columnScales[i]!)
    const scaled = (difference: number, scale: number): number => scale === 0 ? difference === 0 ? 0 : Infinity : Math.abs(difference) / scale
    const maximumScaledParameterDifference = Math.max(...updatedFit.parameters.map((value, i) => scaled(value - referenceFit.parameters[i]!, parameterScales[i]!)))
    const sseScale = Math.max(updatedFit.weightedResidualSumSquares, referenceFit.weightedResidualSumSquares, Number.EPSILON * observations.length * yNorm * yNorm)
    const scaledSseDifference = scaled(updatedFit.weightedResidualSumSquares - referenceFit.weightedResidualSumSquares, sseScale)
    const maximumScaledCovarianceDifference = Math.max(...updatedFit.aprioriParameterCovariance.flatMap((row, i) => row.map((value, j) => scaled(value - referenceFit.aprioriParameterCovariance[i]![j]!, Math.sqrt(updatedFit.aprioriParameterCovariance[i]![i]!) * Math.sqrt(updatedFit.aprioriParameterCovariance[j]![j]!)))))
    const explicitResidualNorm = Math.hypot(...updatedFit.residuals.map((value, i) => value / Math.sqrt(observations[i]!.aprioriVariance)))
    const weightedResidualBackwardDifference = scaled(explicitResidualNorm - state.residualNorm, yNorm + Math.hypot(...updatedFit.adjustedObservations.map((value, i) => value / Math.sqrt(observations[i]!.aprioriVariance))))
    const differences = [maximumScaledParameterDifference, scaledSseDifference, maximumScaledCovarianceDifference, weightedResidualBackwardDifference]
    if (differences.some(value => !Number.isFinite(value) || value > policy.comparisonTolerance)) return fail('incremental-batch-disagreement', 'Incremental and independent full batch outputs exceed the declared scale-aware software comparison policy')
    return SurveyStaticIncrementalOutputV1.parse({
      ...common, outcome: 'calculated', finalFingerprint: hashSurveyStaticIncrementalBaseV1({ ...request.base, revision: request.append.nextRevision, observations }),
      observationIds: observations.map(o => o.id), appendedObservationIds: request.append.observations.map(o => o.id), parameterIds: request.base.parameterIds,
      unit: request.base.unit, squaredUnit: `${request.base.unit}2`, residualConvention: 'observed-minus-adjusted',
      baseFit, updatedFit, baseQrState, updatedQrState, steps,
      batchCheck: { method: 'independent-from-scratch-householder-qr-same-declared-model', referenceFit,
        maximumScaledParameterDifference, scaledSseDifference, maximumScaledCovarianceDifference, relativeTolerance: policy.comparisonTolerance,
        meaning: 'software-consistency-check-not-certified-error-bound' },
      numerical: { baseTriangularConditionInfinity: baseInspection.condition, updatedTriangularConditionInfinity: updatedInspection.condition,
        weightedResidualBackwardDifference, maximumWeightedObservationNorm: yNorm }
    })
  } catch (error) {
    if (!(error instanceof IncrementalFailure)) throw error
    return SurveyStaticIncrementalOutputV1.parse({ ...common, outcome: 'unavailable', code: error.code, message: error.message })
  }
}
