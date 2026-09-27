import { z } from 'zod'

export const SURVEY_STATIC_INCREMENTAL_POLICY_V1 = {
  maxObservations: 256, maxParameters: 16, maxAppended: 128, maxVarianceRatio: 1e12,
  maxTriangularCondition: 1e8, relativeRankTolerance: 1e-12, comparisonTolerance: 1e-8
} as const
const finite = z.number().finite()
const id = z.string().min(1).max(160).refine(s => s.trim() === s && new TextDecoder().decode(new TextEncoder().encode(s)) === s, 'Exact nonblank Unicode required')
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const coefficients = z.array(finite.min(-1e6).max(1e6)).min(1).max(16)
const observation = z.object({ id, value: finite.min(-1e9).max(1e9), coefficients, aprioriVariance: finite.min(1e-100).max(1e100), sourceAnchor: id }).strict()
export const SurveyStaticIncrementalBaseV1 = z.object({
  schemaVersion: z.literal(1), model: z.literal('fixed-datum-full-column-rank-independent-linear-observations'),
  covarianceBasis: z.literal('caller-declared-known-apriori-independent-absolute-variances'),
  errorModel: z.literal('caller-declared-zero-mean-independent-errors-no-normality-claim'),
  coefficientMeaning: z.literal('dimensionless-all-parameters-share-observation-unit'),
  networkId: id, revision: z.number().int().min(1).max(1e9 + 1), unit: z.enum(['m', 'mm']),
  parameterIds: z.array(id).min(1).max(16), sourceAnchor: id, sourceSha256: hash,
  observations: z.array(observation).min(2).max(256)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.parameterIds).size !== value.parameterIds.length || new Set(value.observations.map(o => o.id)).size !== value.observations.length) ctx.addIssue({ code: 'custom', message: 'Base parameter and observation IDs must be unique' })
  if (value.observations.length <= value.parameterIds.length) ctx.addIssue({ code: 'custom', message: 'Base model must have positive functional redundancy' })
  if (value.observations.some(o => o.coefficients.length !== value.parameterIds.length)) ctx.addIssue({ code: 'custom', message: 'Base design rows must match the fixed parameter list' })
})
export type SurveyStaticIncrementalBaseV1 = z.infer<typeof SurveyStaticIncrementalBaseV1>
export const SurveyStaticIncrementalInputV1 = z.object({
  schemaVersion: z.literal(1), operation: z.literal('append-independent-observations-only'),
  base: SurveyStaticIncrementalBaseV1, expectedBaseFingerprint: hash,
  append: z.object({
    batchId: id, nextRevision: z.number().int().min(2).max(1e9 + 1), sourceAnchor: id,
    observations: z.array(observation).min(1).max(128)
  }).strict()
}).strict().superRefine((value, ctx) => {
  if (value.append.nextRevision !== value.base.revision + 1) ctx.addIssue({ code: 'custom', message: 'Append revision must equal base revision plus one' })
  const observations = [...value.base.observations, ...value.append.observations]
  if (observations.length > 256) ctx.addIssue({ code: 'custom', message: 'Total observation limit is 256' })
  if (new Set(observations.map(o => o.id)).size !== observations.length) ctx.addIssue({ code: 'custom', message: 'Appending must never duplicate or overwrite an existing observation ID' })
  if (value.append.observations.some(o => o.coefficients.length !== value.base.parameterIds.length)) ctx.addIssue({ code: 'custom', message: 'Appending cannot change the fixed parameter dimension' })
})
export type SurveyStaticIncrementalInputV1 = z.infer<typeof SurveyStaticIncrementalInputV1>
const parameterVector = z.array(finite).min(1).max(16)
const parameterMatrix = z.array(parameterVector).min(1).max(16)
const fit = z.object({
  parameters: parameterVector, aprioriParameterCovariance: parameterMatrix,
  adjustedObservations: z.array(finite).min(2).max(256), residuals: z.array(finite).min(2).max(256),
  weightedResidualSumSquares: finite.nonnegative(), degreesOfFreedom: z.number().int().positive(),
  posteriorVarianceFactorEstimate: finite.nonnegative(),
  posteriorEstimateUse: z.literal('diagnostic-only-not-applied-to-prior-covariance-or-weights')
}).strict()
const qrState = z.object({ upper: parameterMatrix, transformedRightHandSide: parameterVector, residualNorm: finite.nonnegative(), columnScales: z.array(finite.positive()).min(1).max(16), stateSha256: hash }).strict()
const flags = {
  algorithmVersion: z.literal('declared-static-linear-append-1'), status: z.literal('trial-only'),
  modelAssumptions: z.literal('not-verified'), sourceRecordsVerified: z.literal(false), priorRuntimeStateVerified: z.literal(false),
  formalResultsModified: z.literal(false), originalObservationsModified: z.literal(false), engineeringDecision: z.literal('not-evaluated'),
  persistenceAndCrossRequestIdempotency: z.literal('not-implemented-pure-replay-only'),
  computation: z.literal('replay-base-then-givens-append-with-householder-batch-check')
}
const common = { ...flags, request: SurveyStaticIncrementalInputV1, requestSha256: hash, computedBaseFingerprint: hash }
export const SurveyStaticIncrementalOutputV1 = z.discriminatedUnion('outcome', [
  z.object({ ...flags, outcome: z.literal('invalid-input'), message: z.string() }).strict(),
  z.object({ ...common, outcome: z.literal('unavailable'), code: z.enum(['base-fingerprint-mismatch', 'variance-ratio-outside-supported-domain', 'base-rank-or-conditioning', 'updated-rank-or-conditioning', 'numeric-range-or-resolution', 'incremental-batch-disagreement']), message: z.string() }).strict(),
  z.object({
    ...common, outcome: z.literal('calculated'), finalFingerprint: hash,
    observationIds: z.array(id).min(3).max(256), appendedObservationIds: z.array(id).min(1).max(128),
    parameterIds: z.array(id).min(1).max(16), unit: z.enum(['m', 'mm']), squaredUnit: z.enum(['m2', 'mm2']),
    residualConvention: z.literal('observed-minus-adjusted'),
    baseFit: fit, updatedFit: fit, baseQrState: qrState, updatedQrState: qrState,
    steps: z.array(z.object({
      observationId: id, totalObservationCount: z.number().int().min(3).max(256),
      rotationCosines: parameterVector, rotationSines: parameterVector, transformedResidual: finite,
      accumulatedResidualNorm: finite.nonnegative(), stateSha256: hash
    }).strict()).min(1).max(128),
    batchCheck: z.object({
      method: z.literal('independent-from-scratch-householder-qr-same-declared-model'),
      referenceFit: fit, maximumScaledParameterDifference: finite.nonnegative(), scaledSseDifference: finite.nonnegative(),
      maximumScaledCovarianceDifference: finite.nonnegative(), relativeTolerance: z.literal(1e-8),
      meaning: z.literal('software-consistency-check-not-certified-error-bound')
    }).strict(),
    numerical: z.object({
      baseTriangularConditionInfinity: finite.min(1).max(1e8), updatedTriangularConditionInfinity: finite.min(1).max(1e8),
      weightedResidualBackwardDifference: finite.nonnegative(), maximumWeightedObservationNorm: finite.nonnegative()
    }).strict()
  }).strict()
]).superRefine((value, ctx) => {
  if (value.outcome !== 'calculated') return
  const issue = (message: string): void => ctx.addIssue({ code: 'custom', message })
  const p = value.request.base.parameterIds.length
  const baseCount = value.request.base.observations.length
  const appended = value.request.append.observations
  const count = baseCount + appended.length
  if (JSON.stringify(value.parameterIds) !== JSON.stringify(value.request.base.parameterIds) || JSON.stringify(value.observationIds) !== JSON.stringify([...value.request.base.observations, ...appended].map(o => o.id)) || JSON.stringify(value.appendedObservationIds) !== JSON.stringify(appended.map(o => o.id))) issue('Output identities must match the original and appended declarations')
  if (value.unit !== value.request.base.unit || value.squaredUnit !== `${value.unit}2`) issue('Covariance units must be squared observation units')
  if (value.computedBaseFingerprint !== value.request.expectedBaseFingerprint) issue('A calculated append must bind the exact declared base fingerprint')
  for (const [f, n] of [[value.baseFit, baseCount], [value.updatedFit, count], [value.batchCheck.referenceFit, count]] as const) {
    if (f.parameters.length !== p || f.aprioriParameterCovariance.length !== p || f.aprioriParameterCovariance.some(row => row.length !== p) || f.adjustedObservations.length !== n || f.residuals.length !== n || f.degreesOfFreedom !== n - p) issue('Fit dimensions and degrees of freedom must match the fixed model')
    if (f.posteriorVarianceFactorEstimate !== f.weightedResidualSumSquares / f.degreesOfFreedom) issue('Posterior variance estimate must remain an explicit diagnostic')
    if (f.aprioriParameterCovariance.some((row, i) => !(row[i]! > 0) || row.some((v, j) => v !== f.aprioriParameterCovariance[j]?.[i]))) issue('Prior parameter covariance must be symmetric with positive diagonal')
  }
  for (const state of [value.baseQrState, value.updatedQrState]) {
    if (state.upper.length !== p || state.upper.some(row => row.length !== p) || state.transformedRightHandSide.length !== p || state.columnScales.length !== p || state.upper.some((row, i) => row.some((v, j) => i > j && v !== 0))) issue('QR state dimensions and triangular structure must match the fixed model')
  }
  if (JSON.stringify(value.baseQrState.columnScales) !== JSON.stringify(value.updatedQrState.columnScales)) issue('Appending must not change the original column scales')
  if (value.steps.length !== appended.length || value.steps.some((step, i) => step.observationId !== appended[i]?.id || step.totalObservationCount !== baseCount + i + 1 || step.rotationCosines.length !== p || step.rotationSines.length !== p)) issue('Every appended row must have one ordered update step')
  if (value.steps.at(-1)?.stateSha256 !== value.updatedQrState.stateSha256) issue('Final step must bind the updated state')
  if (Math.max(value.batchCheck.maximumScaledParameterDifference, value.batchCheck.scaledSseDifference, value.batchCheck.maximumScaledCovarianceDifference) > value.batchCheck.relativeTolerance) issue('Calculated output must pass the independent batch comparison policy')
})
export type SurveyStaticIncrementalOutputV1 = z.infer<typeof SurveyStaticIncrementalOutputV1>
