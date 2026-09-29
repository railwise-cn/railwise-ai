import { z } from 'zod'

const ResidualBasis = z.object({
  schemaVersion: z.literal(1),
  method: z.enum(['observation-sigma-ratio', 'weight-normalized-residual', 'residual-sigma-ratio']),
  scaleBasis: z.enum(['declared-prior', 'default-prior', 'relative-weight', 'estimated-posterior']),
  scope: z.literal('descriptive-screening'),
  significance: z.literal('not-evaluated')
})

/** A screening ratio is not a normal/t statistic or a standards decision. */
export const SurveyResidualStatisticV1 = z.discriminatedUnion('status', [
  ResidualBasis.extend({
    status: z.literal('available'),
    value: z.number().finite().nonnegative(),
    threshold: z.literal(3),
    thresholdExceeded: z.boolean()
  }).strict(),
  ResidualBasis.extend({
    status: z.literal('not-testable'),
    reason: z.enum(['no-redundancy', 'residual-variance-unresolved', 'numeric-unavailable'])
  }).strict()
])
export type SurveyResidualStatisticV1 = z.infer<typeof SurveyResidualStatisticV1>

export const SurveyStatisticalSummaryV1 = z.object({
  schemaVersion: z.literal(1),
  scope: z.literal('descriptive-screening'),
  numericalStatus: z.enum(['clear', 'review-required', 'incomplete', 'not-evaluated']),
  availableCount: z.number().int().nonnegative(),
  unavailableCount: z.number().int().nonnegative(),
  flaggedCount: z.number().int().nonnegative(),
  varianceBasis: z.enum(['estimated-posterior', 'prior-fallback', 'not-estimated']),
  /** Signed log10 ratios to the solver's nominal unit scale, not accuracy claims. */
  varianceLog10RatioToUnit: z.number().finite().nullable(),
  standardDeviationLog10RatioToUnit: z.number().finite().nullable(),
  significance: z.literal('not-evaluated'),
  standardsConformity: z.literal('not-evaluated')
}).strict()
export type SurveyStatisticalSummaryV1 = z.infer<typeof SurveyStatisticalSummaryV1>
