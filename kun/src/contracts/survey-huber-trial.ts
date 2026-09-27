import { z } from 'zod'

export const SURVEY_HUBER_TRIAL_LIMITS = Object.freeze({ observations: 128, parameters: 16, iterations: 200 })
const finite = z.number().finite()
const bounded = finite.min(-1e150).max(1e150)
const exact = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && new TextDecoder().decode(new TextEncoder().encode(value)) === value)
const id = exact(160).refine(value => value.trim() === value)
const vector = z.array(finite).max(128)
const tolerance = finite.min(1e-12).max(1e-4)
export const SurveyHuberTrialInputV1 = z.object({
  schemaVersion: z.literal(1), model: z.literal('fixed-linear-full-column-rank'),
  independenceDeclaration: z.literal('caller-declared-independent-observations'),
  residualConvention: z.literal('observed-minus-fitted'), observationUnit: z.enum(['m', 'mm']),
  parameterIds: z.array(id).min(1).max(16), parameterUnits: z.array(id).min(1).max(16),
  initialParameters: z.array(bounded).min(1).max(16),
  scale: z.object({ kind: z.literal('fixed-external'), value: finite.min(1e-12).max(1e12), unit: z.enum(['m', 'mm']), basisStatement: exact(4000) }).strict(),
  loss: z.object({ kind: z.literal('huber'), k: finite.min(1e-6).max(1e6) }).strict(),
  observations: z.array(z.object({ id, value: bounded, coefficients: z.array(bounded).min(1).max(16),
    relativeSigma: finite.min(1e-8).max(1e8), sourceAnchor: exact(1000) }).strict()).min(2).max(128),
  stopping: z.object({ maxIterations: z.number().int().min(1).max(200),
    standardizedPredictionStepTolerance: tolerance, relativeObjectiveTolerance: tolerance, normalizedScoreTolerance: tolerance }).strict()
}).strict().superRefine((value, context) => {
  const p = value.parameterIds.length
  if (value.observations.length <= p || value.parameterUnits.length !== p || value.initialParameters.length !== p
    || value.observations.some(row => row.coefficients.length !== p) || value.scale.unit !== value.observationUnit) {
    context.addIssue({ code: 'custom', message: 'Matching model dimensions, units and positive redundancy are required' })
  }
  if (new Set(value.parameterIds).size !== p || new Set(value.observations.map(row => row.id)).size !== value.observations.length) {
    context.addIssue({ code: 'custom', message: 'Parameter and observation identities must be unique' })
  }
})
export type SurveyHuberTrialInputV1 = z.infer<typeof SurveyHuberTrialInputV1>

export const SurveyHuberTrialStateV1 = z.object({
  iteration: z.number().int().min(0).max(200), parameters: vector, fittedObservations: vector, residuals: vector,
  standardizedResiduals: vector, robustMultipliers: z.array(finite.positive().max(1)).max(128),
  derivedIrlsWeights: z.array(finite.positive()).max(128),
  objective: finite.nonnegative(), objectiveRoundoffEstimate: finite.nonnegative(),
  normalizedScore: vector, normalizedScoreInfinity: finite.nonnegative(), scoreRoundoffEstimate: finite.nonnegative(),
  standardizedPredictionStep: finite.nonnegative().nullable(), relativeObjectiveChange: finite.nonnegative().nullable(),
  irlsDesignConditionEstimate: finite.min(1).nullable()
}).strict()
export type SurveyHuberTrialStateV1 = z.infer<typeof SurveyHuberTrialStateV1>

export const SurveyHuberTrialOutputV1 = z.object({
  schemaVersion: z.literal(1), algorithmVersion: z.literal('fixed-scale-independent-huber-irls-1'),
  status: z.literal('trial-only'), request: SurveyHuberTrialInputV1.nullable(), requestHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  outcome: z.enum(['stationary', 'invalid-input', 'rank-or-conditioning', 'numerical-boundary', 'iteration-limit']),
  reason: z.enum(['initial-score', 'score-step-objective', 'invalid-input', 'input-design', 'irls-design', 'arithmetic-range',
    'objective-increase', 'score-resolution', 'stagnation-before-score', 'max-iterations']),
  objectiveConvention: z.literal('sum-huber-of-observed-minus-fitted-over-fixed-scale-times-relative-sigma'),
  scoreConvention: z.literal('column-normalized-standardized-design-transpose-times-psi-over-k'),
  assumptionsVerified: z.literal(false), scaleVerified: z.literal(false), formalWeightsModified: z.literal(false), observationAction: z.literal('none'),
  engineeringDecision: z.literal('not-evaluated'), standardConformity: z.literal('not-evaluated'), humanSignatureVerification: z.literal('not-evaluated'),
  parameterCovariance: z.null(), gaussianWlsPrecision: z.literal('not-provided'), uniqueMinimizerCertified: z.literal(false),
  uniquenessAssessment: z.enum(['strict-inlier-full-rank-sufficient-condition', 'not-established', 'not-evaluated']),
  strictInlierObservationIds: z.array(id).max(128), strictInlierNumericalRank: z.number().int().min(0).max(16),
  optimality: z.enum(['score-within-declared-tolerance', 'not-satisfied', 'not-evaluated']),
  numericalPolicy: z.literal('conditioned-qr-and-conservative-score-budget-1'), relativeRankTolerance: z.literal(1e-10), maximumConditionEstimate: z.literal(1e8),
  inputDesignConditionEstimate: finite.min(1).nullable(), states: z.array(SurveyHuberTrialStateV1).max(201),
  acceptedParameters: vector.nullable(),
  methodSource: z.object({ id: z.literal('HUBER-1964'), doi: z.literal('10.1214/aoms/1177703732'),
    scope: z.literal('previously-recorded-publisher-abstract-loss-formula-not-full-paper-or-signoff') }).strict()
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: 'custom', message })
  const equal = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i])
  if (!value.request) {
    if (value.outcome !== 'invalid-input' || value.reason !== 'invalid-input' || value.requestHash !== null || value.states.length || value.acceptedParameters !== null) issue('Invalid input cannot contain a model or result')
    return
  }
  const request = value.request, n = request.observations.length, p = request.parameterIds.length
  if (!value.requestHash || value.outcome === 'invalid-input' || value.states.length > request.stopping.maxIterations + 1) issue('Request and outcome are inconsistent')
  value.states.forEach((state, index) => {
    if (state.iteration !== index || state.parameters.length !== p || state.normalizedScore.length !== p
      || [state.fittedObservations, state.residuals, state.standardizedResiduals, state.robustMultipliers, state.derivedIrlsWeights].some(items => items.length !== n)
      || state.normalizedScoreInfinity !== Math.max(...state.normalizedScore.map(Math.abs))) issue('State dimensions, index or score are inconsistent')
    if (index === 0 ? state.standardizedPredictionStep !== null || state.relativeObjectiveChange !== null || state.irlsDesignConditionEstimate !== null || !equal(state.parameters, request.initialParameters)
      : state.standardizedPredictionStep === null || state.relativeObjectiveChange === null || state.irlsDesignConditionEstimate === null || state.irlsDesignConditionEstimate > 1e8) issue('State transition metadata is inconsistent')
  })
  const last = value.states.at(-1)
  if (value.outcome === 'stationary') {
    if (!last || !value.acceptedParameters || !equal(value.acceptedParameters, last.parameters)
      || value.optimality !== 'score-within-declared-tolerance' || last.normalizedScoreInfinity + last.scoreRoundoffEstimate > request.stopping.normalizedScoreTolerance
      || last.scoreRoundoffEstimate > .1 * request.stopping.normalizedScoreTolerance || value.uniquenessAssessment === 'not-evaluated') issue('Stationary output requires the accepted, numerically resolved score')
    if (value.reason === 'initial-score' ? value.states.length !== 1 : value.reason !== 'score-step-objective'
      || !last || last.standardizedPredictionStep === null || last.standardizedPredictionStep > request.stopping.standardizedPredictionStepTolerance
      || last.relativeObjectiveChange === null || last.relativeObjectiveChange > request.stopping.relativeObjectiveTolerance) issue('Termination does not match the explicit stopping policy')
  } else if (value.acceptedParameters !== null || value.uniquenessAssessment !== 'not-evaluated' || value.optimality === 'score-within-declared-tolerance') issue('Unfinished trial cannot expose an accepted solution')
  if (value.outcome === 'iteration-limit' && (value.reason !== 'max-iterations' || value.states.length !== request.stopping.maxIterations + 1)) issue('Iteration exhaustion must preserve every attempted state')
  if (new Set(value.strictInlierObservationIds).size !== value.strictInlierObservationIds.length || value.strictInlierObservationIds.some(id => !request.observations.some(row => row.id === id))
    || value.strictInlierNumericalRank > p || value.uniquenessAssessment === 'strict-inlier-full-rank-sufficient-condition' && value.strictInlierNumericalRank !== p) issue('Strict-inlier rank evidence is inconsistent')
})
export type SurveyHuberTrialOutputV1 = z.infer<typeof SurveyHuberTrialOutputV1>
