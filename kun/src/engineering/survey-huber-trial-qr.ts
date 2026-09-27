/** Adapted from the private column-scaled, pivoted Householder QR in
 * survey-generalized-w.ts at 7d8e92b. Kept isolated: no existing solver changes. */
export function huberQr(design: number[][], rhs?: number[]): {
  rank: number; condition: number | null; solution: number[] | null
} {
  const n = design.length, p = design[0]?.length ?? 0
  const failure = (rank: number) => ({ rank, condition: null, solution: null })
  if (!p) return failure(0)
  const scales = Array.from({ length: p }, (_, j) => Math.hypot(...design.map(row => row[j]!)))
  if (scales.some(value => value > 0 && value < 2 ** -1022 || !Number.isFinite(value))) return failure(0)
  const matrix = design.map(row => row.map((value, j) => value / (scales[j] || 1)))
  const values = rhs ? [...rhs] : Array<number>(n).fill(0)
  const permutation = Array.from({ length: p }, (_, i) => i)
  for (let j = 0; j < Math.min(n, p); j++) {
    let pivot = j, length = -1
    for (let c = j; c < p; c++) {
      const norm = Math.hypot(...matrix.slice(j).map(row => row[c]!))
      if (norm > length) { length = norm; pivot = c }
    }
    if (!Number.isFinite(length) || length <= 1e-10) return failure(j)
    if (pivot !== j) {
      for (const row of matrix) [row[pivot], row[j]] = [row[j]!, row[pivot]!]
      ;[permutation[pivot], permutation[j]] = [permutation[j]!, permutation[pivot]!]
    }
    const vector = matrix.slice(j).map(row => row[j]!)
    const diagonal = vector[0]! >= 0 ? -length : length
    vector[0]! -= diagonal
    const norm = Math.hypot(...vector)
    for (let i = 0; i < vector.length; i++) vector[i]! /= norm
    for (let c = j; c < p; c++) {
      const dot = vector.reduce((sum, v, i) => sum + v * matrix[j + i]![c]!, 0)
      for (let i = 0; i < vector.length; i++) matrix[j + i]![c]! -= 2 * vector[i]! * dot
    }
    const product = vector.reduce((sum, v, i) => sum + v * values[j + i]!, 0)
    for (let i = 0; i < vector.length; i++) values[j + i]! -= 2 * vector[i]! * product
    matrix[j]![j] = diagonal
    for (let i = j + 1; i < n; i++) matrix[i]![j] = 0
  }
  if (n < p) return failure(n)
  const upper = matrix.slice(0, p)
  function solve(right: number[]): number[] {
    const result = Array<number>(p).fill(0)
    for (let i = p - 1; i >= 0; i--) {
      let value = right[i]!
      for (let j = i + 1; j < p; j++) value -= upper[i]![j]! * result[j]!
      result[i] = value / upper[i]![i]!
    }
    return result
  }
  const inverseColumns = Array.from({ length: p }, (_, j) => solve(Array.from({ length: p }, (_, i) => i === j ? 1 : 0)))
  const matrixNorm = Math.max(...upper.map(row => row.reduce((sum, value) => sum + Math.abs(value), 0)))
  const inverseNorm = Math.max(...Array.from({ length: p }, (_, i) => inverseColumns.reduce((sum, col) => sum + Math.abs(col[i]!), 0)))
  const condition = Math.max(1, matrixNorm * inverseNorm)
  if (!Number.isFinite(condition) || condition > 1e8) return { rank: p, condition: Number.isFinite(condition) ? condition : null, solution: null }
  const scaled = solve(values.slice(0, p)), solution = Array<number>(p).fill(0)
  for (let j = 0; j < p; j++) solution[permutation[j]!] = scaled[j]! / scales[permutation[j]!]!
  return { rank: p, condition, solution: solution.every(Number.isFinite) ? solution : null }
}
