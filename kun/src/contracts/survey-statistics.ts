import { z } from 'zod'

const binding = {
  schemaVersion: z.literal(1),
  diagnosticsVersion: z.literal('leveling-deleted-t-1'),
  projectId: z.string().min(1), networkId: z.string().min(1),
  runId: z.string().min(1), resultId: z.string().min(1),
  inputHash: z.string().min(1), algorithmVersion: z.string().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  calculationHash: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.literal('not-evaluated')
}

/** A separately versioned read-only supplement, never a replacement for a
 * stored adjustment or an engineering quality/acceptance decision. */
export const SurveyStatisticalDiagnosticsV1 = z.discriminatedUnion('status', [
  z.object({
    ...binding, status: z.literal('available'),
    statistic: z.literal('externally-studentized-residual-t'),
    model: z.literal('linear-independent-observations'),
    varianceBasis: z.literal('deleted-observation-posterior'),
    weightBasis: z.enum(['inverse-declared-sigma-squared', 'inverse-route-length-with-unit-default']),
    assumptions: z.tuple([
      z.literal('fixed-linear-model'), z.literal('independent-gaussian-errors'),
      z.literal('weights-proportional-to-inverse-variance'), z.literal('fixed-known-datum')
    ]),
    assumptionsVerified: z.literal(false),
    residualUnit: z.literal('m'), statisticUnit: z.literal('dimensionless'),
    fullModelDegreesOfFreedom: z.number().int().min(2),
    degreesOfFreedom: z.number().int().positive(),
    observations: z.array(z.object({
      observationId: z.string().min(1), sourceRow: z.number().int().positive().optional(),
      sourceRecordId: z.string().min(1).optional(),
      residual: z.number().finite(), observationWeight: z.number().finite().positive(),
      /** Cofactor and deleted scale are relative to the reported input weights. */
      residualCofactor: z.number().finite().positive(),
      redundancy: z.number().finite().positive().max(1),
      leverage: z.number().finite().min(0).max(1),
      deletedWeightedResidualSum: z.number().finite().positive(),
      deletedVarianceFactor: z.number().finite().positive(),
      externallyStudentizedResidual: z.number().finite()
    }).strict()).min(1).max(256)
  }).strict(),
  z.object({
    ...binding, status: z.literal('unavailable'),
    reason: z.enum([
      'unsupported-network-type', 'dimension-limit', 'insufficient-redundancy',
      'inconsistent-weight-basis', 'correlated-observations', 'unresolved-residual-model',
      'zero-or-unresolved-deleted-variance'
    ]),
    detailCode: z.string().min(1).max(160).optional()
  }).strict()
]).superRefine((diagnostic, context) => {
  if (diagnostic.status !== 'available') return
  if (diagnostic.degreesOfFreedom !== diagnostic.fullModelDegreesOfFreedom - 1) {
    context.addIssue({ code: 'custom', path: ['degreesOfFreedom'], message: 'deleted scale requires full-model degrees of freedom minus one' })
  }
  if (diagnostic.fullModelDegreesOfFreedom > diagnostic.observations.length) {
    context.addIssue({ code: 'custom', path: ['fullModelDegreesOfFreedom'], message: 'degrees of freedom cannot exceed the number of observations' })
  }
  if (new Set(diagnostic.observations.map(observation => observation.observationId)).size !== diagnostic.observations.length) {
    context.addIssue({ code: 'custom', path: ['observations'], message: 'observation ids must be unique' })
  }
})
export type SurveyStatisticalDiagnosticsV1 = z.infer<typeof SurveyStatisticalDiagnosticsV1>
