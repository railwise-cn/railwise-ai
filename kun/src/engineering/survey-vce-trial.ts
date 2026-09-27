import { SurveyVceTrialInputV1, SurveyVceTrialOutputV1, type SurveyVceIterationV1 } from '../contracts/survey-vce-trial.js'
import { surveyMatrix as mat, type Matrix } from './survey-adjustment-core.js'

const MAX_CONDITION = 1e8
const MIN_NORMAL = 2 ** -1022
const infinityNorm = (a: Matrix): number => Math.max(...a.map(row => row.reduce((s, v) => s + Math.abs(v), 0)))

/** Scale before the shared inverter; its pivot floor otherwise depends on units. */
function checkedInverse(a: Matrix): { inverse: Matrix; condition: number } | null {
  const scale = Math.max(...a.flat().map(Math.abs))
  if (!(scale > 0) || !Number.isFinite(scale)) return null
  const scaled = a.map(row => row.map(v => v / scale))
  const inv = mat.invert(scaled).inverse
  if (!inv) return null
  const condition = infinityNorm(scaled) * infinityNorm(inv)
  if (!Number.isFinite(condition) || condition > MAX_CONDITION) return null
  const product = mat.multiply(scaled, inv)
  if (infinityNorm(product.map((row, i) => row.map((v, j) => v - (i === j ? 1 : 0)))) > 1e-8) return null
  return { inverse: inv.map(row => row.map(v => v / scale)), condition }
}

/** Householder QR residual space avoids subtracting near-equal hat matrices. */
function residualProjector(design: Matrix): Matrix | null {
  const m = design.length
  const p = design[0]!.length
  const work = design.map(row => [...row])
  const q = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => i === j ? 1 : 0) as number[])
  for (let j = 0; j < p; j++) {
    const v = work.slice(j).map(row => row[j]!)
    const norm = Math.hypot(...v)
    if (!(norm > 0)) return null
    v[0]! += (v[0]! >= 0 ? 1 : -1) * norm
    const vnorm = Math.hypot(...v)
    for (let i = 0; i < v.length; i++) v[i]! /= vnorm
    for (let c = j; c < p; c++) {
      const dot = v.reduce((sum, x, i) => sum + x * work[j + i]![c]!, 0)
      for (let i = 0; i < v.length; i++) work[j + i]![c]! -= 2 * v[i]! * dot
    }
    for (let r = 0; r < m; r++) {
      const dot = v.reduce((sum, x, i) => sum + x * q[r]![j + i]!, 0)
      for (let i = 0; i < v.length; i++) q[r]![j + i]! -= 2 * v[i]! * dot
    }
  }
  const basis = q.map(row => row.slice(p))
  const bt = mat.transpose(basis)
  const orthogonal = mat.multiply(bt, basis)
  if (infinityNorm(orthogonal.map((row, i) => row.map((v, j) => v - (i === j ? 1 : 0)))) > 1e-10) return null
  if (infinityNorm(mat.multiply(bt, design)) > 1e-10 * Math.max(1, infinityNorm(design))) return null
  return mat.multiply(basis, bt)
}

/** Pure diagnostic trial. No persistence, IO, formal-weight mutation or engineering decision. */
export function runSurveyVceTrial(raw: unknown): SurveyVceTrialOutputV1 {
  const parsed = SurveyVceTrialInputV1.safeParse(raw)
  const result: SurveyVceTrialOutputV1 = {
    algorithmVersion: 'disjoint-linear-vce-trial-1', status: 'trial-only', modelAssumptions: 'not-verified',
    engineeringDecision: 'not-evaluated', formalWeightsModified: false, componentCovariance: null,
    outcome: 'invalid-input', message: '', unit: null, squaredUnit: null,
    parameterIds: [], groupIds: [], observationIds: [], degreesOfFreedom: 0, convergencePolicy: null, iterations: [],
    convergedVariances: null, finalFit: null, residualConvention: 'observed-minus-adjusted',
    normalConvention: 'half-trace-with-weights-covarianceScale-over-covariance'
  }
  const stop = (outcome: SurveyVceTrialOutputV1['outcome'], message: string): SurveyVceTrialOutputV1 => {
    result.outcome = outcome
    result.message = message
    return SurveyVceTrialOutputV1.parse(result)
  }
  if (!parsed.success) return stop('invalid-input', parsed.error.issues.map(i => i.message).join('; '))
  const input = parsed.data
  const rows = input.observations
  const m = rows.length
  const p = input.parameterIds.length
  const k = input.groups.length
  Object.assign(result, {
    convergencePolicy: { maxIterations: input.maxIterations, relativeTolerance: input.relativeTolerance },
    unit: input.unit, squaredUnit: `${input.unit}2`, parameterIds: input.parameterIds,
    groupIds: input.groups.map(g => g.id), observationIds: rows.map(o => o.id), degreesOfFreedom: m - p
  })
  const group = rows.map(o => input.groups.findIndex(g => g.id === o.groupId))
  if (k > (m - p) * (m - p + 1) / 2) return stop('stochastic-rank-or-conditioning', 'The number of groups exceeds the dimension of the symmetric residual covariance space')
  const columnScales = input.parameterIds.map((_, j) => Math.max(...rows.map(o => Math.abs(o.coefficients[j]!))))
  if (columnScales.some(v => !(v > 0))) return stop('functional-rank-or-conditioning', 'A design column is zero')
  const a = rows.map(o => o.coefficients.map((v, j) => v / columnScales[j]!))
  const at = mat.transpose(a)
  const y = rows.map(o => o.value)
  // Remove a fitted reference vector before applying residual projections. This
  // avoids subtracting large datum terms in y^T P Q P y; no intercept is inferred.
  const referenceInverse = checkedInverse(mat.multiply(at, a))
  if (!referenceInverse) return stop('functional-rank-or-conditioning', 'The column-normalized design is rank deficient or ill conditioned')
  const reference = mat.multiplyVector(referenceInverse.inverse, mat.multiplyVector(at, y))
  const centered = y.map((v, i) => v - mat.multiplyVector([a[i]!], reference)[0]!)
  let theta = input.groups.map(g => g.initialVariance)
  const fit = (values: number[]): { fit: SurveyVceIterationV1['fit']; projector: Matrix; residualHat: Matrix; weights: number[]; scale: number } | null => {
    const c = rows.map((o, i) => values[group[i]!]! * o.relativeVariance)
    const scale = Math.min(...c)
    if (!(scale > 0) || !c.every(Number.isFinite) || Math.max(...c) / scale > MAX_CONDITION) return null
    const w = c.map(v => scale / v)
    const wa = a.map((row, i) => row.map(v => v * w[i]!))
    const inverse = checkedInverse(mat.multiply(at, wa))
    if (!inverse) return null
    const correction = mat.multiplyVector(inverse.inverse, mat.multiplyVector(at, centered.map((v, i) => v * w[i]!)))
    const parameters = correction.map((v, j) => (v + reference[j]!) / columnScales[j]!)
    const residuals = centered.map((v, i) => v - mat.multiplyVector([a[i]!], correction)[0]!)
    const sqrtW = w.map(Math.sqrt)
    const residualHat = residualProjector(a.map((row, i) => row.map(v => v * sqrtW[i]!)))
    if (!residualHat) return null
    const projector = residualHat.map((row, i) => row.map((v, j) => sqrtW[i]! * v * sqrtW[j]!))
    if (![...parameters, ...residuals, ...projector.flat()].every(Number.isFinite)) return null
    const residualScale = Math.max(...residuals.map(Math.abs))
    const observedScale = Math.max(...y.map(Math.abs))
    // Refuse unresolved variance signals instead of promoting cancellation noise.
    if (residualScale > 0 && residualScale <= 128 * Number.EPSILON * observedScale) return null
    const reconstructed = rows.map(o => o.coefficients.reduce((sum, v, j) => sum + v * parameters[j]!, 0))
    if (reconstructed.some((v, i) => !Number.isFinite(v) || Math.abs(y[i]! - v - residuals[i]!) > 1e-8 * residualScale)) return null
    const stationarity = mat.multiplyVector(at, residuals.map((v, i) => v * w[i]!))
    if (stationarity.some(v => Math.abs(v) > 1e-8 * m * residualScale)) return null
    return { fit: { parameters, residuals, functionalNormalConditionInfinity: inverse.condition }, projector, residualHat, weights: w, scale }
  }
  for (let iteration = 1; iteration <= input.maxIterations; iteration++) {
    const state = fit(theta)
    if (!state) return stop('numerical-boundary', 'Covariance ratio, weighted conditioning, inverse residual, stationarity, reconstruction or residual-resolution check failed')
    // Dimensionless mask Gram detects weak/invisible groups before q magnifies QR noise.
    const groupGram = Array.from({ length: k }, () => Array<number>(k).fill(0))
    for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) groupGram[group[i]!]![group[j]!]! += .5 * state.residualHat[i]![j]! ** 2
    const groupGramInverse = checkedInverse(groupGram)
    if (!groupGramInverse) return stop('stochastic-rank-or-conditioning', 'The dimensionless projected group Gram is dependent or ill conditioned')
    const n = Array.from({ length: k }, () => Array<number>(k).fill(0))
    const rhs = Array<number>(k).fill(0)
    for (let i = 0; i < m; i++) {
      const g = group[i]!
      const qi = rows[i]!.relativeVariance
      const we = state.weights[i]! * state.fit.residuals[i]!
      const squaredWeightedResidual = we * we
      const contribution = .5 * qi * squaredWeightedResidual
      if (state.fit.residuals[i] !== 0 && (we === 0 || squaredWeightedResidual < MIN_NORMAL || contribution < MIN_NORMAL)) {
        return stop('numerical-boundary', 'A nonzero residual energy underflows or enters subnormal precision; no zero-variance inference was made')
      }
      rhs[g]! += contribution
      for (let j = 0; j < m; j++) n[g]![group[j]!]! += .5 * qi * rows[j]!.relativeVariance * state.projector[i]![j]! ** 2
    }
    const inverse = checkedInverse(n)
    if (!inverse) return stop('stochastic-rank-or-conditioning', 'Projected group covariance matrices are dependent or the stochastic normal condition exceeds 1e8')
    const candidate = mat.multiplyVector(inverse.inverse, rhs)
    if (!candidate.every(Number.isFinite)) return stop('numerical-boundary', 'Component solution is not finite')
    const relativeChange = Math.max(...candidate.map((v, i) => Math.abs(v - theta[i]!) / Math.max(Math.abs(v), Math.abs(theta[i]!))))
    result.iterations.push({ iteration, currentVariances: [...theta], candidateVariances: candidate,
      covarianceScale: state.scale, normal: n, rightHandSide: rhs,
      stochasticNormalConditionInfinity: inverse.condition, groupGramConditionInfinity: groupGramInverse.condition, relativeChange, fit: state.fit })
    if (candidate.some(v => v <= 0)) return stop('nonpositive-component', 'An unconstrained estimate is zero or negative; no clamping or alternate initialization was applied')
    if (candidate.some(v => v < 1e-18 || v > 1e18)) return stop('numerical-boundary', 'Estimated component is outside the supported positive numeric range')
    theta = candidate
    if (relativeChange <= input.relativeTolerance) {
      const final = fit(theta)
      if (!final) return stop('numerical-boundary', 'The final accepted components failed the weighted fit checks')
      result.convergedVariances = [...theta]
      result.finalFit = final.fit
      return stop('converged', 'Restricted fixed-model variance trial converged; assumptions and engineering acceptance remain unverified')
    }
  }
  return stop('iteration-limit', 'The declared iteration limit was reached without convergence')
}
