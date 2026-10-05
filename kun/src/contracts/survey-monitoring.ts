import { z } from 'zod'

const id = z.string().trim().min(1).max(200)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
export const SurveyInitialValueChangeRequestV1 = z.object({
  adjustmentId: id,
  expectedPreviousEventId: id.nullable(),
  reason: z.string().trim().min(1).max(500),
  confirmed: z.literal(true),
  idempotencyKey: id
}).strict()
export const SurveyInitialValueEventV1 = z.object({
  schemaVersion: z.literal(1), id, projectId: id,
  previousEventId: id.nullable(), previousHash: hash.nullable(),
  adjustmentId: id, resultId: id, resultHash: hash, inputHash: z.string().min(1),
  sourceSha256: hash, networkRevision: z.number().int().positive(),
  reason: z.string().min(1), confirmation: z.literal('user-confirmed'),
  signoff: z.literal('unsigned'), createdAt: z.string().min(1), eventHash: hash
}).strict()
export type SurveyInitialValueEventV1 = z.infer<typeof SurveyInitialValueEventV1>

export const SurveySegmentComparisonRequestV1 = z.object({
  referenceAdjustmentId: id, currentAdjustmentId: id,
  segments: z.array(z.object({
    id, from: id, to: id,
    referenceObservationIds: z.array(id).min(1).max(1000),
    currentObservationIds: z.array(id).min(1).max(1000)
  }).strict()).min(1).max(100),
  idempotencyKey: id
}).strict()
export type SurveySegmentComparisonRequestV1 = z.infer<typeof SurveySegmentComparisonRequestV1>

/**
 * Identifiability of a repeat-survey segment at the raw-observation layer.
 *
 * This is deliberately additive: historical segment comparisons do not carry
 * the projection and remain readable.  A numeric period difference can still
 * be displayed when this status is unavailable, but it must not be presented
 * as a fully identifiable stochastic observation-layer result.
 */
export const SurveyObservationLayerIdentifiabilityV1 = z.object({
  status: z.enum(['available', 'unavailable']),
  reason: z.enum(['reference-point-insufficient', 'overall-translation-unidentifiable', 'raw-random-model-unavailable']).optional(),
  referencePointCount: z.number().int().nonnegative(),
  connectedReferencePointCount: z.number().int().nonnegative(),
  rawRandomModel: z.enum(['provided', 'unavailable'])
}).strict().superRefine((value, context) => {
  if (value.status === 'available' && (value.reason !== undefined || value.rawRandomModel !== 'provided' || value.referencePointCount < 1 || value.connectedReferencePointCount < 1)) {
    context.addIssue({ code: 'custom', message: 'available observation-layer identifiability requires a connected reference point and raw random model' })
  }
  if (value.status === 'unavailable' && value.reason === undefined) context.addIssue({ code: 'custom', message: 'unavailable observation-layer identifiability requires a reason' })
  if (value.reason === 'reference-point-insufficient' && value.referencePointCount > 0) context.addIssue({ code: 'custom', message: 'reference-point-insufficient requires zero reference points' })
  if (value.reason === 'overall-translation-unidentifiable' && (value.referencePointCount < 1 || value.connectedReferencePointCount > 0)) context.addIssue({ code: 'custom', message: 'overall-translation-unidentifiable requires an unconnected reference point' })
  if (value.reason === 'raw-random-model-unavailable' && value.rawRandomModel !== 'unavailable') context.addIssue({ code: 'custom', message: 'raw-random-model-unavailable requires an unavailable raw random model' })
})
export type SurveyObservationLayerIdentifiabilityV1 = z.infer<typeof SurveyObservationLayerIdentifiabilityV1>

/**
 * A deliberately trial-only projection of a two-epoch raw-observation
 * congruence check.  This is a descriptive cluster of selected segment
 * differences; it is not a free-network adjustment, a reference-point
 * stability test, or an engineering approval.
 */
export const SurveyRawObservationCongruenceV1 = z.object({
  schemaVersion: z.literal(1),
  method: z.literal('raw-observation-two-epoch-congruence-trial'),
  status: z.enum(['overall-translation', 'common-movement', 'unavailable']),
  trialOnly: z.literal(true),
  engineeringDecision: z.literal('not-evaluated'),
  segmentCount: z.number().int().positive(),
  meanObservedChangeMetres: z.number().finite().optional(),
  maximumResidualMetres: z.number().finite().nonnegative().optional(),
  toleranceMetres: z.number().finite().positive().optional(),
  reason: z.enum([
    'segment-insufficient',
    'inconsistent-segment-differences',
    'reference-point-insufficient',
    'overall-translation-unidentifiable',
    'raw-random-model-unavailable'
  ]).optional()
}).strict().superRefine((value, context) => {
  const hasMetrics = value.meanObservedChangeMetres !== undefined
    && value.maximumResidualMetres !== undefined
    && value.toleranceMetres !== undefined
  if (value.status === 'unavailable') {
    if (!value.reason || hasMetrics) context.addIssue({ code: 'custom', message: 'unavailable congruence requires a reason and no numerical decision metrics' })
  } else {
    if (value.reason !== undefined || !hasMetrics) context.addIssue({ code: 'custom', message: 'available congruence requires numerical decision metrics and no unavailable reason' })
    if (value.maximumResidualMetres !== undefined && value.toleranceMetres !== undefined && value.maximumResidualMetres > value.toleranceMetres) {
      context.addIssue({ code: 'custom', message: 'available congruence residual must not exceed its tolerance' })
    }
  }
  if (value.reason === 'segment-insufficient' && value.segmentCount > 1) context.addIssue({ code: 'custom', message: 'segment-insufficient requires one selected segment or fewer' })
})
export type SurveyRawObservationCongruenceV1 = z.infer<typeof SurveyRawObservationCongruenceV1>

export const SurveySegmentComparisonV1 = z.object({
  schemaVersion: z.literal(1), id, projectId: id,
  referenceAdjustmentId: id, currentAdjustmentId: id,
  referenceResultHash: hash, currentResultHash: hash,
  referenceProjectionHash: hash, currentProjectionHash: hash,
  referenceEpoch: z.string().min(1), currentEpoch: z.string().min(1),
  segments: z.array(z.object({
    id, from: id, to: id,
    referenceObservationIds: z.array(id), currentObservationIds: z.array(id),
    referenceObservedMetres: z.number().finite(), currentObservedMetres: z.number().finite(),
    observedChangeMetres: z.number().finite(),
    referenceAdjustedMetres: z.number().finite(), currentAdjustedMetres: z.number().finite(),
    adjustedChangeMetres: z.number().finite(),
    interpretation: z.literal('current-minus-reference-height-difference'),
    standardsConformity: z.literal('not-evaluated')
  }).strict()),
  /** Additive raw-observation identifiability status; absent on legacy records. */
  observationIdentifiability: SurveyObservationLayerIdentifiabilityV1.optional(),
  /** Additive, descriptive-only two-epoch raw-observation projection. */
  rawObservationCongruence: SurveyRawObservationCongruenceV1.optional(),
  inputHash: hash, createdAt: z.string().min(1)
}).strict()
export type SurveySegmentComparisonV1 = z.infer<typeof SurveySegmentComparisonV1>

/** Read-only cumulative continuity projection across adjacent survey periods. */
export const SurveySegmentContinuityV1 = z.object({
  schemaVersion: z.literal(1), id, projectId: id,
  comparisonIds: z.array(id).min(1).max(100),
  firstEpoch: z.string().min(1), currentEpoch: z.string().min(1),
  segments: z.array(z.object({
    id, from: id, to: id,
    observedCumulativeChangeMetres: z.number().finite(),
    adjustedCumulativeChangeMetres: z.number().finite(),
    periodChanges: z.array(z.object({
      comparisonId: id, referenceEpoch: z.string().min(1), currentEpoch: z.string().min(1),
      observedChangeMetres: z.number().finite(), adjustedChangeMetres: z.number().finite()
    }).strict()).min(1).max(100)
  }).strict()).min(1).max(100),
  inputHash: hash, createdAt: z.string().min(1)
}).strict()
export type SurveySegmentContinuityV1 = z.infer<typeof SurveySegmentContinuityV1>
