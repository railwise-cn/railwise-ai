import { createHash } from 'node:crypto'
import { SurveyHuberTrialInputV1, SurveyHuberTrialOutputV1, type SurveyHuberTrialStateV1 } from '../contracts/survey-huber-trial.js'
import { huberQr } from './survey-huber-trial-qr.js'

const MIN_NORMAL = 2 ** -1022
const finite = (values: number[]): boolean => values.every(Number.isFinite)
const dot = (a: number[], b: number[]): number => a.reduce((sum, value, i) => sum + value * b[i]!, 0)

/** Read-only, fixed external scale IRLS. It never estimates a scale, changes a
 * production weight, deletes a reading or supplies Gaussian WLS precision. */
export function runSurveyHuberTrial(raw: unknown): SurveyHuberTrialOutputV1 {
  const parsed = SurveyHuberTrialInputV1.safeParse(raw)
  const output: SurveyHuberTrialOutputV1 = {
    schemaVersion: 1, algorithmVersion: 'fixed-scale-independent-huber-irls-1', status: 'trial-only',
    request: parsed.success ? parsed.data : null, requestHash: parsed.success ? createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex') : null,
    outcome: 'invalid-input', reason: 'invalid-input',
    objectiveConvention: 'sum-huber-of-observed-minus-fitted-over-fixed-scale-times-relative-sigma',
    scoreConvention: 'column-normalized-standardized-design-transpose-times-psi-over-k',
    assumptionsVerified: false, scaleVerified: false, formalWeightsModified: false, observationAction: 'none',
    engineeringDecision: 'not-evaluated', standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated',
    parameterCovariance: null, gaussianWlsPrecision: 'not-provided', uniqueMinimizerCertified: false,
    uniquenessAssessment: 'not-evaluated', strictInlierObservationIds: [], strictInlierNumericalRank: 0, optimality: 'not-evaluated',
    numericalPolicy: 'conditioned-qr-and-conservative-score-budget-1', relativeRankTolerance: 1e-10, maximumConditionEstimate: 1e8,
    inputDesignConditionEstimate: null, states: [], acceptedParameters: null,
    methodSource: { id: 'HUBER-1964', doi: '10.1214/aoms/1177703732', scope: 'previously-recorded-publisher-abstract-loss-formula-not-full-paper-or-signoff' }
  }
  const stop = (outcome: SurveyHuberTrialOutputV1['outcome'], reason: SurveyHuberTrialOutputV1['reason']): SurveyHuberTrialOutputV1 => {
    output.outcome = outcome; output.reason = reason
    if (output.states.length && outcome !== 'stationary') output.optimality = 'not-satisfied'
    return SurveyHuberTrialOutputV1.parse(output)
  }
  if (!parsed.success) return stop('invalid-input', 'invalid-input')
  const input = parsed.data, n = input.observations.length, p = input.parameterIds.length, k = input.loss.k
  const sigma = input.observations.map(row => input.scale.value * row.relativeSigma)
  const a = input.observations.map(row => row.coefficients)
  const standardizedDesign = a.map((row, i) => row.map(value => value / sigma[i]!))
  const columnScales = Array.from({ length: p }, (_, j) => Math.hypot(...standardizedDesign.map(row => row[j]!)))
  if (columnScales.some(value => value > 0 && value < MIN_NORMAL || !Number.isFinite(value))) return stop('numerical-boundary', 'arithmetic-range')
  if (columnScales.some(value => value === 0)) return stop('rank-or-conditioning', 'input-design')
  const b = standardizedDesign.map(row => row.map((value, j) => value / columnScales[j]!))
  const design = huberQr(b)
  output.inputDesignConditionEstimate = design.condition
  if (!design.solution) return stop('rank-or-conditioning', 'input-design')
  const z = input.observations.map((row, i) => row.value / sigma[i]!)
  if (!finite(z)) return stop('numerical-boundary', 'arithmetic-range')

  type Evaluation = { state: SurveyHuberTrialStateV1; residualError: number[] }
  function evaluate(parameters: number[], iteration: number): Evaluation | null {
    if (a.some(row => row.some((value, j) => value !== 0 && parameters[j] !== 0 && Math.abs(value * parameters[j]!) < MIN_NORMAL))) return null
    const fitted = a.map(row => dot(row, parameters))
    const residuals = input.observations.map((row, i) => row.value - fitted[i]!)
    const standardizedResiduals = residuals.map((value, i) => value / sigma[i]!)
    const residualError = input.observations.map((row, i) => 64 * (p + 1) * Number.EPSILON
      * (Math.abs(row.value) + row.coefficients.reduce((sum, value, j) => sum + Math.abs(value * parameters[j]!), 0)) / sigma[i]!)
    if (![parameters, fitted, residuals, standardizedResiduals, residualError].every(finite)
      || residuals.some((value, i) => value !== 0 && standardizedResiduals[i] === 0)) return null
    const multipliers: number[] = [], weights: number[] = [], scores: number[] = [], scoreErrors: number[] = []
    let objective = 0
    for (let i = 0; i < n; i++) {
      const u = standardizedResiduals[i]!, absolute = Math.abs(u)
      const loss = absolute <= k ? .5 * u * u : k * (absolute - .5 * k)
      const multiplier = absolute <= k ? 1 : k / absolute
      const weight = multiplier / sigma[i]! / sigma[i]!
      if (!finite([loss, multiplier, weight]) || absolute !== 0 && loss < MIN_NORMAL || multiplier < MIN_NORMAL || weight < MIN_NORMAL) return null
      objective += loss; multipliers.push(multiplier); weights.push(weight)
      scores.push(Math.sign(u) * Math.min(1, absolute / k))
      // A saturated score is constant only when the entire residual error
      // interval remains beyond the same kink. Otherwise use its Lipschitz bound.
      scoreErrors.push(absolute - residualError[i]! > k ? 0 : Math.min(2, residualError[i]! / k))
    }
    const normalizedScore = Array.from({ length: p }, (_, j) => b.reduce((sum, row, i) => sum + row[j]! * scores[i]!, 0))
    const scoreRoundoffEstimate = Math.max(...Array.from({ length: p }, (_, j) => b.reduce((sum, row, i) => sum
      + Math.abs(row[j]!) * scoreErrors[i]! + 64 * n * Number.EPSILON * Math.abs(row[j]! * scores[i]!), 0)))
    const objectiveRoundoffEstimate = k * residualError.reduce((sum, value) => sum + value, 0) + 64 * n * Number.EPSILON * objective
    if (!finite([objective, objectiveRoundoffEstimate, scoreRoundoffEstimate, ...normalizedScore])) return null
    return { residualError, state: { iteration, parameters: [...parameters], fittedObservations: fitted, residuals, standardizedResiduals,
      robustMultipliers: multipliers, derivedIrlsWeights: weights, objective, objectiveRoundoffEstimate,
      normalizedScore, normalizedScoreInfinity: Math.max(...normalizedScore.map(Math.abs)), scoreRoundoffEstimate,
      standardizedPredictionStep: null, relativeObjectiveChange: null, irlsDesignConditionEstimate: null } }
  }
  function finish(evaluation: Evaluation, reason: 'initial-score' | 'score-step-objective'): SurveyHuberTrialOutputV1 {
    const inliers = evaluation.state.standardizedResiduals.map((u, i) => ({ u, i })).filter(({ u, i }) =>
      k - Math.abs(u) > 8 * evaluation.residualError[i]! + 1e-10 * k)
    const inlierDesign = huberQr(inliers.map(({ i }) => b[i]!))
    output.strictInlierObservationIds = inliers.map(({ i }) => input.observations[i]!.id)
    output.strictInlierNumericalRank = inlierDesign.rank
    output.uniquenessAssessment = inlierDesign.solution ? 'strict-inlier-full-rank-sufficient-condition' : 'not-established'
    output.optimality = 'score-within-declared-tolerance'
    output.acceptedParameters = [...evaluation.state.parameters]
    return stop('stationary', reason)
  }
  let current = evaluate(input.initialParameters, 0)
  if (!current) return stop('numerical-boundary', 'arithmetic-range')
  output.states.push(current.state)
  const scoreReady = (evaluation: Evaluation): boolean => evaluation.state.normalizedScoreInfinity + evaluation.state.scoreRoundoffEstimate <= input.stopping.normalizedScoreTolerance
  const scoreResolved = (evaluation: Evaluation): boolean => evaluation.state.scoreRoundoffEstimate <= .1 * input.stopping.normalizedScoreTolerance
  if (scoreReady(current)) return scoreResolved(current) ? finish(current, 'initial-score') : stop('numerical-boundary', 'score-resolution')
  for (let iteration = 1; iteration <= input.stopping.maxIterations; iteration++) {
    const maxWeight = Math.max(...current.state.robustMultipliers)
    const squareRoots = current.state.robustMultipliers.map(value => Math.sqrt(value / maxWeight))
    const fitted = huberQr(b.map((row, i) => row.map(value => value * squareRoots[i]!)), z.map((value, i) => value * squareRoots[i]!))
    if (!fitted.solution) return stop('rank-or-conditioning', 'irls-design')
    const parameters = fitted.solution.map((value, j) => value / columnScales[j]!)
    const candidate = evaluate(parameters, iteration)
    if (!candidate) return stop('numerical-boundary', 'arithmetic-range')
    const difference = parameters.map((value, j) => value - current!.state.parameters[j]!)
    const predictionStep = Math.max(...standardizedDesign.map(row => Math.abs(dot(row, difference))))
    const objectiveChange = Math.abs(candidate.state.objective - current.state.objective) / Math.max(1, current.state.objective, candidate.state.objective)
    if (!finite([predictionStep, objectiveChange])) return stop('numerical-boundary', 'arithmetic-range')
    candidate.state.standardizedPredictionStep = predictionStep
    candidate.state.relativeObjectiveChange = objectiveChange
    candidate.state.irlsDesignConditionEstimate = fitted.condition
    output.states.push(candidate.state)
    if (candidate.state.objective > current.state.objective + current.state.objectiveRoundoffEstimate + candidate.state.objectiveRoundoffEstimate) return stop('numerical-boundary', 'objective-increase')
    if (scoreReady(candidate)) {
      if (!scoreResolved(candidate)) return stop('numerical-boundary', 'score-resolution')
      if (predictionStep <= input.stopping.standardizedPredictionStepTolerance && objectiveChange <= input.stopping.relativeObjectiveTolerance) return finish(candidate, 'score-step-objective')
    } else if (predictionStep === 0) return stop('numerical-boundary', 'stagnation-before-score')
    current = candidate
  }
  return stop('iteration-limit', 'max-iterations')
}
