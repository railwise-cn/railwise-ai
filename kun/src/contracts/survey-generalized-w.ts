import { z } from 'zod'

export const SURVEY_GENERALIZED_W_LIMITS = Object.freeze({ observations: 64, parameters: 16, directions: 64 })
const finite = z.number().finite()
const id = z.string().min(1).max(200).refine(value => value.trim() === value
  && new TextDecoder().decode(new TextEncoder().encode(value)) === value, 'exact nonblank Unicode required')
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const vector = z.array(finite).min(1).max(SURVEY_GENERALIZED_W_LIMITS.observations)
const matrix = z.array(vector).min(1).max(SURVEY_GENERALIZED_W_LIMITS.observations)

/** A declared experimental model, never a conversion from relative weights or
 * an estimated posterior scale. No input declaration authenticates its basis. */
export const SurveyGeneralizedWRequestV1 = z.object({
  schemaVersion: z.literal(1), model: z.literal('fixed-linear-full-column-rank'),
  purpose: z.literal('declared-model-readonly-diagnostic'),
  residualConvention: z.literal('observed-minus-adjusted'),
  observationUnit: id, observationIds: z.array(id).min(1).max(SURVEY_GENERALIZED_W_LIMITS.observations),
  parameterIds: z.array(id).min(1).max(SURVEY_GENERALIZED_W_LIMITS.parameters),
  parameterUnits: z.array(id).min(1).max(SURVEY_GENERALIZED_W_LIMITS.parameters),
  designMatrix: matrix, observations: vector,
  covariance: z.object({ kind: z.literal('known-apriori-absolute-observation-covariance'),
    basisStatement: z.string().min(1).max(4000).refine(value => value.trim().length > 0
      && new TextDecoder().decode(new TextEncoder().encode(value)) === value), matrix }).strict(),
  family: z.object({ id, alpha: finite.gt(0).lt(1), tail: z.literal('two-sided'),
    declaration: z.literal('caller-declared-before-evaluation') }).strict(),
  biasDirections: z.array(z.object({ id, coefficients: vector }).strict()).min(1).max(SURVEY_GENERALIZED_W_LIMITS.directions)
}).strict().superRefine((value, context) => {
  const n = value.observationIds.length, p = value.parameterIds.length
  if (value.observations.length !== n || value.designMatrix.length !== n || value.designMatrix.some(row => row.length !== p)
    || value.parameterUnits.length !== p || value.covariance.matrix.length !== n || value.covariance.matrix.some(row => row.length !== n)
    || value.biasDirections.some(direction => direction.coefficients.length !== n || direction.coefficients.every(item => item === 0))) {
    context.addIssue({ code: 'custom', message: 'A, y, C and nonzero bias direction dimensions must match the declared rows and columns' })
  }
  for (const values of [value.observationIds, value.parameterIds, value.biasDirections.map(direction => direction.id)]) {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', message: 'duplicate row, parameter or direction ID' })
  }
})
export type SurveyGeneralizedWRequestV1 = z.infer<typeof SurveyGeneralizedWRequestV1>

const boundaries = {
  assumptionsVerified: z.literal(false), familyDeclarationVerified: z.literal(false),
  distributionEvaluation: z.literal('not-performed'), multipleComparisonAdjustment: z.literal('not-performed'),
  decision: z.literal('not-evaluated'), observationAction: z.literal('none'),
  standardConformity: z.literal('not-evaluated'), humanSignatureVerification: z.literal('not-evaluated')
}
const source = z.object({ id: z.literal('AMIRI-2007'), equation: z.literal('2.39'), printedPage: z.literal(17), pdfPage: z.literal(29),
  sourceSha256: z.literal('4c4b6311f6da13844f559c48a57a62cd5467434b51d563805ae176a7a4ec9207'),
  url: z.literal('https://resolver.tudelft.nl/uuid:bc7f8919-1baf-4f02-b115-dc926c5ec090'),
  provenance: z.literal('previously-recorded-method-source-not-a-new-reading-or-signoff') }).strict()
export const SurveyGeneralizedWDirectionV1 = z.discriminatedUnion('status', [
  z.object({ id, status: z.literal('resolved'), detectabilityRatio: finite.gt(0).max(1 + 1e-12),
    generalizedW: finite, absoluteGeneralizedW: finite.nonnegative(), statisticErrorEstimate: finite.nonnegative() }).strict(),
  z.object({ id, status: z.literal('not-detectable-or-numerically-unresolved'), detectabilityRatio: finite.min(0).max(1 + 1e-12),
    reason: z.literal('bias-direction-in-or-too-close-to-model-column-space'), generalizedW: z.null(), absoluteGeneralizedW: z.null() }).strict()
])
const common = {
  schemaVersion: z.literal(1), diagnosticsVersion: z.literal('fixed-linear-known-covariance-generalized-w-1'),
  request: SurveyGeneralizedWRequestV1, requestHash: hash, source,
  covarianceComputation: z.literal('diagonal-equilibrated-cholesky-whitening'),
  projectionComputation: z.literal('column-scaled-pivoted-householder-qr'),
  relativeRankTolerance: z.literal(1e-10), relativeDetectabilityTolerance: z.literal(1e-10),
  statisticErrorPolicy: z.literal('conservative-condition-based-budget-1'), relativeStatisticErrorBudget: z.literal(1e-8),
  ...boundaries
}
export const SurveyGeneralizedWResultV1 = z.discriminatedUnion('modelStatus', [
  z.object({ ...common, modelStatus: z.literal('unavailable'),
    reason: z.enum(['insufficient-residual-degrees-of-freedom', 'covariance-not-symmetric-positive-definite-or-numerically-unresolved',
      'design-not-full-rank-or-numerically-unresolved', 'numeric-range-or-backward-error']),
    diagnostics: z.tuple([]) }).strict(),
  z.object({ ...common, modelStatus: z.literal('resolved'),
    rank: z.number().int().min(1).max(SURVEY_GENERALIZED_W_LIMITS.parameters),
    degreesOfFreedom: z.number().int().min(1).max(SURVEY_GENERALIZED_W_LIMITS.observations - 1),
    parameters: vector, adjustedObservations: vector, residuals: vector, residualCovariance: matrix,
    whiteningConditionEstimate: finite.min(1), designConditionEstimate: finite.min(1),
    aprioriWeightedResidualSum: finite.nonnegative(),
    diagnostics: z.array(SurveyGeneralizedWDirectionV1).min(1).max(SURVEY_GENERALIZED_W_LIMITS.directions) }).strict()
]).superRefine((value, context) => {
  if (value.modelStatus !== 'resolved') return
  const n = value.request.observationIds.length, p = value.request.parameterIds.length
  if (value.rank !== p || value.degreesOfFreedom !== n - p || value.parameters.length !== p
    || value.adjustedObservations.length !== n || value.residuals.length !== n || value.residualCovariance.length !== n
    || value.residualCovariance.some(row => row.length !== n) || value.diagnostics.length !== value.request.biasDirections.length
    || value.diagnostics.some((direction, index) => direction.id !== value.request.biasDirections[index]?.id
      || direction.status === 'resolved' && (direction.absoluteGeneralizedW !== Math.abs(direction.generalizedW) || direction.detectabilityRatio <= value.relativeDetectabilityTolerance
        || direction.statisticErrorEstimate > value.relativeStatisticErrorBudget * Math.max(1, direction.absoluteGeneralizedW))
      || direction.status !== 'resolved' && direction.detectabilityRatio > value.relativeDetectabilityTolerance)) {
    context.addIssue({ code: 'custom', message: 'result identity, shape or detection status does not match the declared model' })
  }
})
export type SurveyGeneralizedWResultV1 = z.infer<typeof SurveyGeneralizedWResultV1>
