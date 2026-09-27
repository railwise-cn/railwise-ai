import { surveyMatrix, type Matrix } from './survey-adjustment-core.js'

export const FREE_LEVELING_VERSION = 'free-leveling-trial-1' as const
export const FREE_LEVELING_LIMITS = {
  maxPoints: 64, maxObservations: 256, maxWeightRatio: 1e8,
  maxReducedNormalCondition: 1e8, backwardTolerance: 1e-9,
  outputResolutionTolerance: 1e-8
} as const

export type FreeLevelingInput = {
  model: 'independent-linear-height-differences'
  unit: 'm' | 'mm'
  constraint: 'sum-height-corrections-zero'
  points: readonly { id: string; referenceHeight: number }[]
  observations: readonly {
    id: string; from: string; to: string; heightDifference: number
    /** Cofactor precision, in inverse squared input length units. */
    weight: number; weightSource: string; sourceAnchor: string
  }[]
  /** Known variance factor for Cov(l) = varianceFactor * diag(1/weight). */
  aprioriVarianceFactor?: number
}

export type FreeLevelingFailure =
  | 'unsupported-model' | 'unsupported-unit' | 'unsupported-constraint'
  | 'unsupported-covariance' | 'invalid-dimension' | 'invalid-point'
  | 'duplicate-point-id' | 'invalid-observation' | 'duplicate-observation-id'
  | 'unknown-point' | 'self-loop' | 'invalid-weight' | 'missing-provenance'
  | 'invalid-apriori-variance' | 'disconnected-network' | 'insufficient-redundancy'
  | 'numeric-unresolved'

export class FreeLevelingError extends Error {
  constructor(readonly reason: FreeLevelingFailure, readonly diagnostics: Record<string, string | number | null> = {}) {
    super(`free_leveling_${reason}`)
    this.name = 'FreeLevelingError'
  }
}

function fail(reason: FreeLevelingFailure, diagnostics?: Record<string, string | number | null>): never { throw new FreeLevelingError(reason, diagnostics) }
const finite = (values: number[]) => values.every(Number.isFinite)
const validId = (value: string) => typeof value === 'string' && value.trim().length > 0
const infinityNorm = (matrix: Matrix) => Math.max(...matrix.map(row => row.reduce((sum, value) => sum + Math.abs(value), 0)))
const scaleMatrix = (matrix: Matrix, scale: number) => matrix.map(row => row.map(value => value * scale))

/** Read-only trial, with no engineering decisions, persistence or stable-point
 * inference. Result ordering follows the input point/observation IDs. */
export function solveFreeLevelingTrial(input: FreeLevelingInput) {
  if (input.model !== 'independent-linear-height-differences') fail('unsupported-model')
  if (input.unit !== 'm' && input.unit !== 'mm') fail('unsupported-unit')
  if (input.constraint !== 'sum-height-corrections-zero') fail('unsupported-constraint')
  if ('observationCovariance' in input || 'covariance' in input) fail('unsupported-covariance')
  const { points, observations } = input
  const n = points.length, m = observations.length
  if (n < 2 || n > FREE_LEVELING_LIMITS.maxPoints || m < 1 || m > FREE_LEVELING_LIMITS.maxObservations) fail('invalid-dimension')
  const indexes = new Map<string, number>()
  points.forEach((point, index) => {
    if (!validId(point.id) || !Number.isFinite(point.referenceHeight)) fail('invalid-point')
    if (indexes.has(point.id)) fail('duplicate-point-id')
    indexes.set(point.id, index)
  })
  const ids = new Set<string>()
  const neighbors = Array.from({ length: n }, () => [] as number[])
  const edges = observations.map(observation => {
    if (!validId(observation.id) || !Number.isFinite(observation.heightDifference)) fail('invalid-observation')
    if (ids.has(observation.id)) fail('duplicate-observation-id')
    ids.add(observation.id)
    const from = indexes.get(observation.from), to = indexes.get(observation.to)
    if (from === undefined || to === undefined) fail('unknown-point')
    if (from === to) fail('self-loop')
    if (!Number.isFinite(observation.weight) || observation.weight <= 0) fail('invalid-weight')
    if (!validId(observation.weightSource) || !validId(observation.sourceAnchor)) fail('missing-provenance')
    neighbors[from]!.push(to); neighbors[to]!.push(from)
    return { from, to }
  })
  if (input.aprioriVarianceFactor !== undefined && (!Number.isFinite(input.aprioriVarianceFactor) || input.aprioriVarianceFactor <= 0)) fail('invalid-apriori-variance')
  const visited = new Set<number>([0]), pending = [0]
  while (pending.length) {
    for (const next of neighbors[pending.pop()!]!) if (!visited.has(next)) { visited.add(next); pending.push(next) }
  }
  if (visited.size !== n) fail('disconnected-network')
  const rank = n - 1, dof = m - rank
  if (dof <= 0) fail('insufficient-redundancy')
  const maximumWeight = Math.max(...observations.map(observation => observation.weight))
  const weightRatio = maximumWeight / Math.min(...observations.map(observation => observation.weight))
  if (!Number.isFinite(weightRatio) || weightRatio > FREE_LEVELING_LIMITS.maxWeightRatio) fail('numeric-unresolved', {
    criterion: 'weight-ratio', value: Number.isFinite(weightRatio) ? weightRatio : null, maximum: FREE_LEVELING_LIMITS.maxWeightRatio
  })
  const weights = observations.map(observation => observation.weight / maximumWeight)

  // Helmert columns span exactly the zero-sum correction space. There is no
  // fixed point or damping term; the datum constraint removes only translation.
  const basis = Array.from({ length: n }, (_, row) => Array.from({ length: rank }, (_, column) => {
    const denominator = Math.sqrt((column + 1) * (column + 2))
    return row <= column ? 1 / denominator : row === column + 1 ? -(column + 1) / denominator : 0
  }))
  const design = edges.map(({ from, to }) => basis[to]!.map((value, index) => value - basis[from]![index]!))
  const transpose = surveyMatrix.transpose(design)
  const misclosures = observations.map((observation, i) => observation.heightDifference - (points[edges[i]!.to]!.referenceHeight - points[edges[i]!.from]!.referenceHeight))
  if (!finite(misclosures)) fail('numeric-unresolved')
  const normal = surveyMatrix.multiply(transpose, design.map((row, i) => row.map(value => value * weights[i]!)))
  const inversion = surveyMatrix.invert(normal)
  if (!inversion.inverse || inversion.rank !== rank) fail('numeric-unresolved', {
    criterion: 'reduced-normal-rank', rank: inversion.rank, requiredRank: rank, relativePivotTolerance: 1e-12
  })
  const inverse = inversion.inverse
  const condition = infinityNorm(normal) * infinityNorm(inverse)
  if (!Number.isFinite(condition) || condition > FREE_LEVELING_LIMITS.maxReducedNormalCondition) fail('numeric-unresolved', {
    criterion: 'reduced-normal-infinity-condition', value: Number.isFinite(condition) ? condition : null, maximum: FREE_LEVELING_LIMITS.maxReducedNormalCondition
  })
  const rightHandSide = surveyMatrix.multiplyVector(transpose, misclosures.map((value, i) => value * weights[i]!))
  const solution = surveyMatrix.multiplyVector(inverse, rightHandSide)
  const corrections = surveyMatrix.multiplyVector(basis, solution)
  const heights = corrections.map((value, i) => value + points[i]!.referenceHeight)
  const adjusted = edges.map(({ from, to }) => heights[to]! - heights[from]!)
  const residuals = observations.map((observation, i) => observation.heightDifference - adjusted[i]!)
  const heightCofactor = scaleMatrix(surveyMatrix.multiply(surveyMatrix.multiply(basis, inverse), surveyMatrix.transpose(basis)), 1 / maximumWeight)
  const adjustedCofactor = edges.map(({ from, to }) => edges.map(edge =>
    heightCofactor[to]![edge.to]! - heightCofactor[to]![edge.from]! - heightCofactor[from]![edge.to]! + heightCofactor[from]![edge.from]!))
  const residualCofactor = adjustedCofactor.map((row, i) => row.map((value, j) => (i === j ? 1 / observations[i]!.weight : 0) - value))
  // Whitening before squaring preserves representable sums when v*v alone
  // would underflow/overflow. Scaling also bounds the summation terms.
  const weightedResiduals = residuals.map((value, i) => value * Math.sqrt(observations[i]!.weight))
  if (!finite(weightedResiduals) || weightedResiduals.some((value, i) => value === 0 && residuals[i] !== 0)) fail('numeric-unresolved', { criterion: 'weighted-residual-range' })
  const residualScale = Math.max(...weightedResiduals.map(Math.abs))
  const normalizedSSE = residualScale === 0 ? 0 : weightedResiduals.reduce((sum, value) => sum + (value / residualScale) ** 2, 0)
  const weightedSSE = residualScale * (residualScale * normalizedSSE)
  const posteriorVarianceFactorEstimate = weightedSSE / dof
  if (residualScale > 0 && (weightedSSE === 0 || posteriorVarianceFactorEstimate === 0)) fail('numeric-unresolved', { criterion: 'posterior-variance-underflow' })
  const aprioriCovariance = input.aprioriVarianceFactor === undefined ? null : {
    varianceFactor: input.aprioriVarianceFactor,
    height: scaleMatrix(heightCofactor, input.aprioriVarianceFactor),
    residual: scaleMatrix(residualCofactor, input.aprioriVarianceFactor)
  }
  if (!finite([...solution, ...corrections, ...heights, ...adjusted, ...residuals, ...heightCofactor.flat(), ...residualCofactor.flat(), weightedSSE, posteriorVarianceFactorEstimate,
    ...(aprioriCovariance ? [...aprioriCovariance.height.flat(), ...aprioriCovariance.residual.flat()] : [])])) fail('numeric-unresolved')

  // Refuse outputs whose coordinate rounding, covariance cancellation or
  // stationarity no longer resolves the declared small-network calculation.
  const observationScale = Math.max(...observations.map(observation => Math.abs(observation.heightDifference)))
  const numericScale = Math.max(observationScale, ...misclosures.map(Math.abs), Number.MIN_VALUE)
  const heightResolution = Math.max(...heights.map(Math.abs), ...points.map(point => Math.abs(point.referenceHeight))) * Number.EPSILON
  if (heightResolution > FREE_LEVELING_LIMITS.outputResolutionTolerance * Math.max(observationScale, input.unit === 'm' ? 1e-3 : 1)) fail('numeric-unresolved')
  const gradient = surveyMatrix.multiplyVector(transpose, residuals.map((value, i) => value * weights[i]!))
  const stationarityError = Math.max(...gradient.map(Math.abs)) / numericScale / m
  const constraintError = Math.abs(corrections.reduce((sum, value) => sum + value, 0)) / numericScale / n
  if (!finite([stationarityError, constraintError]) || stationarityError > FREE_LEVELING_LIMITS.backwardTolerance || constraintError > FREE_LEVELING_LIMITS.backwardTolerance) fail('numeric-unresolved')
  if (heightCofactor.some((row, i) => row[i]! <= 0) || aprioriCovariance?.height.some((row, i) => row[i]! <= 0)) fail('numeric-unresolved')
  for (let i = 0; i < m; i++) {
    const redundancy = residualCofactor[i]![i]! * observations[i]!.weight
    if (residualCofactor[i]![i]! < 0 || (residualCofactor[i]![i]! > 0 && aprioriCovariance?.residual[i]![i] === 0)) fail('numeric-unresolved', { criterion: 'residual-variance-range', observationId: observations[i]!.id })
    if (redundancy > 1 + FREE_LEVELING_LIMITS.backwardTolerance) fail('numeric-unresolved')
  }
  return {
    algorithmVersion: FREE_LEVELING_VERSION,
    status: 'trial-only' as const,
    model: input.model, modelAssumptions: 'not-verified' as const, engineeringDecision: 'not-evaluated' as const,
    unit: input.unit, squaredUnit: input.unit === 'm' ? 'm2' as const : 'mm2' as const,
    constraint: { type: input.constraint, pointIds: points.map(point => point.id) },
    pointIds: points.map(point => point.id), observationIds: observations.map(observation => observation.id),
    points: points.map((point, i) => ({ ...point, correction: corrections[i]!, height: heights[i]! })),
    observations: observations.map((observation, i) => ({ ...observation, adjustedHeightDifference: adjusted[i]!, residual: residuals[i]! })),
    residualConvention: 'observed-minus-adjusted' as const,
    rank, datumDefect: 1, degreesOfFreedom: dof,
    heightCofactor, residualCofactor, adjustedHeightDifferenceCofactor: adjustedCofactor,
    weightedSSE, posteriorVarianceFactorEstimate, aprioriCovariance,
    numerical: { reducedNormalConditionInfinity: condition, weightRatio, stationarityError, constraintError, limits: { ...FREE_LEVELING_LIMITS } }
  }
}
