import { z } from 'zod'
import { SurveyPointV1 } from './survey.js'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const scalar = z.number().finite()
const matrix = z.array(z.array(scalar).max(256)).max(256)
export const SurveyFreeLevelingTrialRequestV1 = z.object({
  expectedRevision: z.number().int().positive(), idempotencyKey: z.string().min(1).max(160),
  constraint: z.literal('sum-height-corrections-zero'), acknowledgeDatumRelease: z.literal(true),
  weightPolicy: z.literal('source-or-unit-fallback')
}).strict()
export type SurveyFreeLevelingTrialRequestV1 = z.infer<typeof SurveyFreeLevelingTrialRequestV1>

export const SurveyFreeLevelingOutputV1 = z.object({
  algorithmVersion: z.literal('free-leveling-trial-1'), status: z.literal('trial-only'),
  model: z.literal('independent-linear-height-differences'), modelAssumptions: z.literal('not-verified'), engineeringDecision: z.literal('not-evaluated'),
  unit: z.literal('m'), squaredUnit: z.literal('m2'),
  constraint: z.object({ type: z.literal('sum-height-corrections-zero'), pointIds: z.array(z.string()).max(64) }).strict(),
  pointIds: z.array(z.string()).max(64), observationIds: z.array(z.string()).max(256),
  points: z.array(z.object({ id: z.string(), referenceHeight: scalar, correction: scalar, height: scalar }).strict()).max(64),
  observations: z.array(z.object({
    id: z.string(), from: z.string(), to: z.string(), heightDifference: scalar, weight: scalar.positive(),
    weightSource: z.string(), sourceAnchor: z.string(), adjustedHeightDifference: scalar, residual: scalar
  }).strict()).max(256),
  residualConvention: z.literal('observed-minus-adjusted'), rank: z.number().int().positive(), datumDefect: z.literal(1), degreesOfFreedom: z.number().int().positive(),
  heightCofactor: matrix, residualCofactor: matrix, adjustedHeightDifferenceCofactor: matrix,
  weightedSSE: scalar.nonnegative(), posteriorVarianceFactorEstimate: scalar.nonnegative(), aprioriCovariance: z.null(),
  numerical: z.object({
    reducedNormalConditionInfinity: scalar, weightRatio: scalar, stationarityError: scalar, constraintError: scalar,
    limits: z.object({ maxPoints: scalar, maxObservations: scalar, maxWeightRatio: scalar, maxReducedNormalCondition: scalar, backwardTolerance: scalar, outputResolutionTolerance: scalar }).strict()
  }).strict()
}).strict()

export const SurveyFreeLevelingTrialV1 = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), projectId: z.string().min(1), networkId: z.string().min(1),
  networkRevision: z.number().int().positive(), inputHash: hash, sourceSha256: hash, sourceAdmissionHash: hash,
  algorithmVersion: z.literal('free-leveling-trial-1'), constraint: z.literal('sum-height-corrections-zero'),
  acknowledgeDatumRelease: z.literal(true), weightPolicy: z.literal('source-or-unit-fallback'),
  weightBasis: z.enum(['inverse-declared-sigma-squared', 'inverse-route-length-with-unit-default']),
  originalPointRoles: z.array(z.object({
    id: z.string(), known: z.boolean(), collection: z.enum(['knownPoints', 'unknownPoints']), originalPoint: SurveyPointV1,
    referenceHeightBasis: z.enum(['declared-height', 'zero-initial-approximation'])
  }).strict()).max(64),
  defaultWeightObservationIds: z.array(z.string()).max(256),
  pointCount: z.number().int().positive().max(64), observationCount: z.number().int().positive().max(256), degreesOfFreedom: z.number().int().positive(),
  createdAt: z.string().datetime(), requestHash: hash, outputHash: hash, recordHash: hash,
  output: SurveyFreeLevelingOutputV1
}).strict()
export type SurveyFreeLevelingTrialV1 = z.infer<typeof SurveyFreeLevelingTrialV1>
export const SurveyFreeLevelingTrialSummaryV1 = SurveyFreeLevelingTrialV1.omit({ output: true, originalPointRoles: true })
export type SurveyFreeLevelingTrialSummaryV1 = z.infer<typeof SurveyFreeLevelingTrialSummaryV1>
export const SurveyFreeLevelingTrialListV1 = z.object({ trials: z.array(SurveyFreeLevelingTrialSummaryV1).max(50), nextOffset: z.number().int().nonnegative().nullable() }).strict()
export type SurveyFreeLevelingTrialListV1 = z.infer<typeof SurveyFreeLevelingTrialListV1>
