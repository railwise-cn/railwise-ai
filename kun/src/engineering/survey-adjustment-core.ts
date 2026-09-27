/**
 * Canonical numerical primitives for engineering-survey adjustment.
 *
 * All Runtime survey strategies use this module. Agent Pack and RailWise
 * adapters must call the Runtime strategies instead of carrying another
 * executable matrix implementation.
 */
export type Matrix = number[][]

/** Relative rounding allowance for symmetric covariance/cofactor matrices. */
export const SURVEY_COVARIANCE_SYMMETRY_TOLERANCE = 1e-12

export type WeightedEquation = {
  coefficients: number[]
  misclosure: number
  weight: number
}

export type LinearAdjustmentResult = {
  corrections: number[]
  residuals: number[]
  covariance: Matrix
  varianceFactor: number
  varianceFactorEstimated: boolean
  unitWeightStdDev: number
  dof: number
  rank: number
  conditionEstimate: number
}

export type MatrixInversionResult = {
  inverse: Matrix | null
  rank: number
  conditionEstimate: number
}

export type IterativeAdjustmentResult = LinearAdjustmentResult & {
  parameters: number[]
  iterations: number
  converged: boolean
  maxCorrection: number
}

export type LinearAdjustmentOutcome =
  | { ok: true; result: LinearAdjustmentResult }
  | { ok: false; reason: 'empty' | 'invalid-equation' | 'rank-deficient'; rank: number; conditionEstimate: number }

export type CorrelatedEquationBlock = {
  coefficients: Matrix
  misclosures: number[]
  covariance: Matrix
}

export const surveyMatrix = {
  transpose(source: Matrix): Matrix {
    if (!source.length) return []
    return source[0]!.map((_, column) => source.map((row) => row[column] ?? 0))
  },

  multiply(left: Matrix, right: Matrix): Matrix {
    if (!left.length || !right.length) return []
    return left.map((row) => right[0]!.map((_, column) => row.reduce((sum, value, index) => sum + value * (right[index]?.[column] ?? 0), 0)))
  },

  multiplyVector(source: Matrix, vector: number[]): number[] {
    return source.map((row) => row.reduce((sum, value, index) => sum + value * (vector[index] ?? 0), 0))
  },

  invert(source: Matrix): MatrixInversionResult {
    const dimension = source.length
    if (!dimension || source.some((row) => row.length !== dimension || row.some((value) => !Number.isFinite(value)))) {
      return { inverse: null, rank: 0, conditionEstimate: Number.POSITIVE_INFINITY }
    }
    const scale = Math.max(1, ...source.flatMap((row) => row.map((value) => Math.abs(value))))
    const threshold = scale * 1e-12
    const augmented = source.map((row, rowIndex) => [
      ...row,
      ...Array.from({ length: dimension }, (_, columnIndex) => rowIndex === columnIndex ? 1 : 0)
    ])
    const pivots: number[] = []
    for (let column = 0; column < dimension; column += 1) {
      let pivotRow = column
      for (let row = column + 1; row < dimension; row += 1) {
        if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivotRow]![column]!)) pivotRow = row
      }
      const pivotMagnitude = Math.abs(augmented[pivotRow]![column]!)
      if (pivotMagnitude <= threshold) {
        return { inverse: null, rank: column, conditionEstimate: Number.POSITIVE_INFINITY }
      }
      pivots.push(pivotMagnitude)
      ;[augmented[column], augmented[pivotRow]] = [augmented[pivotRow]!, augmented[column]!]
      const pivot = augmented[column]![column]!
      for (let index = 0; index < 2 * dimension; index += 1) augmented[column]![index]! /= pivot
      for (let row = 0; row < dimension; row += 1) {
        if (row === column) continue
        const factor = augmented[row]![column]!
        if (Math.abs(factor) <= Number.EPSILON) continue
        for (let index = 0; index < 2 * dimension; index += 1) augmented[row]![index]! -= factor * augmented[column]![index]!
      }
    }
    const smallestPivot = Math.min(...pivots)
    const largestPivot = Math.max(...pivots)
    return {
      inverse: augmented.map((row) => row.slice(dimension)),
      rank: dimension,
      conditionEstimate: smallestPivot > 0 ? largestPivot / smallestPivot : Number.POSITIVE_INFINITY
    }
  }
}

/**
 * Cholesky factorisation C = L L^T for a symmetric positive-definite
 * covariance matrix. Returning null is intentional: callers turn malformed
 * covariance into a typed quality blocker before any normal matrix is built.
 */
export function choleskyDecompose(source: Matrix): Matrix | null {
  const dimension = source.length
  if (!dimension || source.some((row) => row.length !== dimension || row.some((value) => !Number.isFinite(value)))) return null
  const scale = Math.max(Number.MIN_VALUE, ...source.flatMap((row) => row.map((value) => Math.abs(value))))
  const symmetryTolerance = scale * SURVEY_COVARIANCE_SYMMETRY_TOLERANCE
  for (let row = 0; row < dimension; row += 1) {
    for (let column = 0; column < row; column += 1) {
      if (Math.abs(source[row]![column]! - source[column]![row]!) > symmetryTolerance) return null
    }
  }
  const lower = Array.from({ length: dimension }, () => Array.from({ length: dimension }, () => 0))
  for (let row = 0; row < dimension; row += 1) {
    for (let column = 0; column <= row; column += 1) {
      let value = source[row]![column]!
      for (let index = 0; index < column; index += 1) value -= lower[row]![index]! * lower[column]![index]!
      if (row === column) {
        if (!(value > scale * 1e-15)) return null
        lower[row]![column] = Math.sqrt(value)
      } else {
        const diagonal = lower[column]![column]!
        if (!(diagonal > 0)) return null
        lower[row]![column] = value / diagonal
      }
    }
  }
  return lower
}

export function solveLowerTriangular(lower: Matrix, values: number[]): number[] | null {
  const dimension = lower.length
  if (values.length !== dimension || lower.some((row) => row.length !== dimension) || values.some((value) => !Number.isFinite(value))) return null
  const solved = Array.from({ length: dimension }, () => 0)
  for (let row = 0; row < dimension; row += 1) {
    const diagonal = lower[row]![row]!
    if (!Number.isFinite(diagonal) || Math.abs(diagonal) <= Number.EPSILON) return null
    let value = values[row]!
    for (let column = 0; column < row; column += 1) value -= lower[row]![column]! * solved[column]!
    solved[row] = value / diagonal
  }
  return solved
}

/**
 * Whiten a correlated observation block with L^-1 where covariance = L L^T.
 * The returned unit-weight equations can enter the canonical WLS solver while
 * retaining every off-diagonal covariance term.
 */
export function whitenCorrelatedEquations(block: CorrelatedEquationBlock): WeightedEquation[] | null {
  const rowCount = block.coefficients.length
  if (!rowCount || block.misclosures.length !== rowCount || block.covariance.length !== rowCount) return null
  const parameterCount = block.coefficients[0]!.length
  if (!parameterCount || block.coefficients.some((row) => row.length !== parameterCount || row.some((value) => !Number.isFinite(value)))) return null
  const lower = choleskyDecompose(block.covariance)
  if (!lower) return null
  const whitenedMisclosures = solveLowerTriangular(lower, block.misclosures)
  if (!whitenedMisclosures) return null
  const whitenedColumns: number[][] = []
  for (let column = 0; column < parameterCount; column += 1) {
    const solved = solveLowerTriangular(lower, block.coefficients.map((row) => row[column]!))
    if (!solved) return null
    whitenedColumns.push(solved)
  }
  return Array.from({ length: rowCount }, (_, row) => ({
    coefficients: Array.from({ length: parameterCount }, (_, column) => whitenedColumns[column]![row]!),
    misclosure: whitenedMisclosures[row]!,
    weight: 1
  }))
}

export function solveWeightedLeastSquares(rows: WeightedEquation[]): LinearAdjustmentOutcome {
  if (!rows.length) return { ok: false, reason: 'empty', rank: 0, conditionEstimate: Number.POSITIVE_INFINITY }
  const dimension = rows[0]!.coefficients.length
  if (!dimension || rows.some((row) => row.coefficients.length !== dimension || !Number.isFinite(row.misclosure) || !Number.isFinite(row.weight) || row.weight <= 0)) {
    return { ok: false, reason: 'invalid-equation', rank: 0, conditionEstimate: Number.POSITIVE_INFINITY }
  }
  const design = rows.map((row) => row.coefficients)
  const transpose = surveyMatrix.transpose(design)
  const weightedDesign = design.map((row, rowIndex) => row.map((value) => value * rows[rowIndex]!.weight))
  const normal = surveyMatrix.multiply(transpose, weightedDesign)
  const rightHandSide = surveyMatrix.multiplyVector(transpose, rows.map((row) => row.misclosure * row.weight))
  const inversion = surveyMatrix.invert(normal)
  if (!inversion.inverse) return { ok: false, reason: 'rank-deficient', rank: inversion.rank, conditionEstimate: inversion.conditionEstimate }
  const corrections = surveyMatrix.multiplyVector(inversion.inverse, rightHandSide)
  const residuals = surveyMatrix.multiplyVector(design, corrections).map((value, index) => value - rows[index]!.misclosure)
  const dof = Math.max(0, rows.length - dimension)
  const weightedResidualSum = residuals.reduce((sum, value, index) => sum + value * value * rows[index]!.weight, 0)
  // With no redundancy sigma0 cannot be estimated from residuals. Preserve
  // the a-priori unit variance instead of falsely reporting zero precision.
  const varianceFactorEstimated = dof > 0
  const varianceFactor = varianceFactorEstimated ? weightedResidualSum / dof : 1
  return { ok: true, result: {
    corrections,
    residuals,
    covariance: inversion.inverse,
    varianceFactor,
    varianceFactorEstimated,
    unitWeightStdDev: Math.sqrt(varianceFactor),
    dof,
    rank: inversion.rank,
    conditionEstimate: inversion.conditionEstimate
  } }
}

export function weightedLeastSquares(rows: WeightedEquation[]): LinearAdjustmentResult | null {
  const outcome = solveWeightedLeastSquares(rows)
  return outcome.ok ? outcome.result : null
}

export function iterativeWeightedLeastSquares(
  initialParameters: number[],
  buildEquations: (parameters: readonly number[]) => WeightedEquation[],
  options: {
    maxIterations?: number
    convergence?: number
    /**
     * Optional weighted misclosure objective for backtracking. It must use the
     * same observation model and weights as buildEquations, but need not
     * allocate a Jacobian for every rejected candidate step.
     */
    objective?: (parameters: readonly number[]) => number
  } = {}
): IterativeAdjustmentResult | null {
  const maxIterations = options.maxIterations ?? 10
  const convergence = options.convergence ?? 1e-5
  const parameters = [...initialParameters]
  let last: LinearAdjustmentResult | null = null
  let maxCorrection = Number.POSITIVE_INFINITY
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const equations = buildEquations(parameters)
    const solved = weightedLeastSquares(equations)
    if (!solved) return null
    last = solved
    maxCorrection = solved.corrections.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    if (maxCorrection <= convergence) return { ...solved, parameters, iterations: iteration, converged: true, maxCorrection }
    const currentObjective = equations.reduce((sum, row) => sum + row.misclosure * row.misclosure * row.weight, 0)
    if (!Number.isFinite(currentObjective)) return null

    // A full Gauss-Newton correction is not always inside the local
    // linearisation domain. Use deterministic backtracking before accepting
    // an update, rather than treating a diverging first step as convergence.
    let stepScale = 1
    let candidate: number[] | null = null
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const proposal = parameters.map((value, index) => value + stepScale * (solved.corrections[index] ?? 0))
      const proposalObjective = options.objective
        ? options.objective(proposal)
        : buildEquations(proposal).reduce((sum, row) => sum + row.misclosure * row.misclosure * row.weight, 0)
      if (Number.isFinite(proposalObjective) && proposalObjective <= currentObjective) {
        candidate = proposal
        break
      }
      stepScale *= 0.5
    }
    if (!candidate) return { ...solved, parameters, iterations: iteration, converged: false, maxCorrection }
    for (let index = 0; index < parameters.length; index += 1) parameters[index] = candidate[index]!
  }
  const final = last ? weightedLeastSquares(buildEquations(parameters)) : null
  return final ? { ...final, parameters, iterations: maxIterations, converged: false, maxCorrection } : null
}

export function wrapRadians(value: number): number {
  let wrapped = value
  while (wrapped > Math.PI) wrapped -= 2 * Math.PI
  while (wrapped < -Math.PI) wrapped += 2 * Math.PI
  return wrapped
}

export function numericalJacobian(
  model: (parameters: readonly number[]) => number,
  parameters: readonly number[],
  options: { angular?: boolean; step?: number } = {}
): number[] {
  const step = options.step ?? 1e-6
  return parameters.map((_, index) => {
    const lower = [...parameters]
    const upper = [...parameters]
    lower[index] = (lower[index] ?? 0) - step
    upper[index] = (upper[index] ?? 0) + step
    const difference = model(upper) - model(lower)
    return (options.angular ? wrapRadians(difference) : difference) / (2 * step)
  })
}
