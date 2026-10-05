import { z } from 'zod'
import { SurveyFormatIdV1, SurveyNetworkTypeV1, SurveyPointV1, SurveyXyErrorEllipseV1 } from './survey.js'
import { SurveyResidualStatisticV1 } from './survey-statistical-semantics.js'

export const SURVEY_PROFESSIONAL_PROJECTION_VERSION = 'survey-professional-review-1' as const
export const SurveyProfessionalReasonV1 = z.enum([
  'no-network-snapshot', 'input-mismatch', 'source-unverified', 'source-integrity-failed',
  'no-height-route', 'closure-tolerance-not-configured', 'station-readings-not-evaluated',
  'reference-missing', 'no-point-standard-errors', 'cross-covariance-unavailable',
  'standards-not-evaluated', 'missing-source-anchor', 'no-redundancy',
  'numerical-result-invalid', 'blocking-quality-finding', 'precision-tolerance-not-configured', 'plane-closures-not-evaluated'
])
export type SurveyProfessionalReasonV1 = z.infer<typeof SurveyProfessionalReasonV1>

export const SurveyProfessionalCheckV1 = z.object({
  id: z.enum(['source-binding', 'source-coverage', 'reference', 'field-checks', 'closure', 'precision', 'numerical-result', 'standards']),
  status: z.enum(['pass', 'fail', 'not-evaluated']),
  reason: SurveyProfessionalReasonV1.optional()
}).strict()

export const SurveyProfessionalClosureMemberV1 = z.object({
  observationId: z.string().min(1),
  direction: z.union([z.literal(1), z.literal(-1)]),
  from: z.string().min(1),
  to: z.string().min(1),
  heightDifferenceMetres: z.number().finite(),
  routeLengthMetres: z.number().finite().positive().optional(),
  stationCount: z.number().int().positive().optional(),
  sourceRecordId: z.string().min(1).optional(),
  sourceRow: z.number().int().positive().optional()
}).strict()

export const SurveyProfessionalClosureV1 = z.object({
  id: z.string().min(1),
  kind: z.enum(['loop', 'attached-route']),
  from: z.string().min(1),
  to: z.string().min(1),
  members: z.array(SurveyProfessionalClosureMemberV1).min(1),
  sumObservedMetres: z.number().finite(),
  knownHeightDifferenceMetres: z.number().finite(),
  misclosureMetres: z.number().finite(),
  totalLengthMetres: z.number().finite().positive().optional(),
  stationCount: z.number().int().positive().optional(),
  /** An explicit absolute metre limit from this network, never an inferred standard. */
  toleranceMetres: z.number().finite().nonnegative().optional(),
  toleranceBasis: z.literal('network.instrumentParameters.closureTolerance').optional(),
  status: z.enum(['pass', 'fail', 'not-evaluated']),
  reason: SurveyProfessionalReasonV1.optional()
}).strict()

export const SurveyProfessionalObservationV1 = z.object({
  id: z.string().min(1),
  observationId: z.string().min(1),
  type: z.string().min(1),
  component: z.enum(['x', 'y', 'z', 'h']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  rawValue: z.number().finite().optional(),
  rawUnit: z.string().optional(),
  observed: z.number().finite().optional(),
  adjusted: z.number().finite().optional(),
  /** Canonical segment length copied from the bound source observation. */
  routeLengthMetres: z.number().finite().positive().optional(),
  correction: z.number().finite(),
  residual: z.number().finite(),
  unit: z.enum(['m', 'rad']).optional(),
  sourceRecordId: z.string().optional(),
  sourceRow: z.number().int().positive().optional(),
  sourceLocator: z.string().optional(),
  outlierCandidate: z.boolean(),
  screening: SurveyResidualStatisticV1.optional(),
  screeningStatus: z.enum(['available', 'not-testable', 'legacy-not-recorded'])
}).strict()

export const SurveyProfessionalPointV1 = z.object({
  id: z.string().min(1),
  role: z.enum(['known', 'unknown', 'check', 'station', 'unverified']),
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  height: z.number().finite().optional(),
  latitude: z.number().finite().optional(),
  longitude: z.number().finite().optional(),
  correctionX: z.number().finite().optional(),
  correctionY: z.number().finite().optional(),
  correctionHeight: z.number().finite().optional(),
  standardError: z.number().finite().nonnegative().optional(),
  xyErrorEllipse: SurveyXyErrorEllipseV1.optional(),
  precisionBasis: z.enum(['a-priori', 'a-posteriori', 'not-recorded']),
  unit: z.literal('m')
}).strict()

/**
 * Numerical rank and datum semantics copied from the immutable adjustment run.
 * `datumDefect` is the algebraic parameter-count-minus-rank quantity; it is
 * not a claim of standards compliance or a substitute for a geodetic datum
 * analysis. The block is optional so historical projections remain readable.
 */
export const SurveyProfessionalSolverV1 = z.object({
  rank: z.number().int().nonnegative().optional(),
  parameterCount: z.number().int().nonnegative(),
  datumDefect: z.number().int().nonnegative().optional(),
  rankStatus: z.enum(['available', 'not-recorded']),
  datumStatus: z.enum(['fixed-datum', 'free-network', 'minimum-constraint', 'not-evaluated']),
  constraint: z.enum(['fixed-known-points', 'free', 'minimum-constraint', 'not-recorded']),
  constraintBasis: z.enum(['adjustment-run', 'not-recorded'])
}).strict()

/** Additive read/report/AI projection; it never changes the persisted result. */
export const SurveyProfessionalReviewV1 = z.object({
  schemaVersion: z.literal(1),
  projectionVersion: z.literal(SURVEY_PROFESSIONAL_PROJECTION_VERSION),
  projectId: z.string().min(1),
  networkId: z.string().min(1),
  runId: z.string().min(1),
  resultId: z.string().min(1),
  inputHash: z.string().min(1),
  resultHash: z.string().regex(/^[0-9a-f]{64}$/),
  projectionHash: z.string().regex(/^[0-9a-f]{64}$/),
  algorithmVersion: z.string().min(1),
  resultCreatedAt: z.string().min(1),
  source: z.object({
    networkRevision: z.number().int().positive().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    formatId: SurveyFormatIdV1.optional(),
    name: z.string().optional(),
    status: z.enum(['bound', 'unverified', 'mismatch', 'unavailable']),
    integrity: z.enum(['verified', 'failed', 'not-verified']),
    reason: SurveyProfessionalReasonV1.optional(),
    anchoredObservationCount: z.number().int().nonnegative(),
    missingAnchorObservationIds: z.array(z.string())
  }).strict(),
  reference: z.object({
    coordinateSystem: z.string().nullable(),
    projection: z.string().nullable(),
    ellipsoid: z.string().nullable(),
    centralMeridian: z.number().finite().optional(),
    verticalDatum: z.string().nullable(),
    linearUnit: z.literal('m'),
    angularUnit: z.literal('rad'),
    knownPoints: z.array(SurveyPointV1),
    status: z.enum(['declared', 'incomplete', 'unavailable'])
  }).strict(),
  summary: z.object({
    networkType: SurveyNetworkTypeV1.optional(),
    observationCount: z.number().int().nonnegative(),
    pointCount: z.number().int().nonnegative(),
    degreesOfFreedom: z.number().int().nonnegative(),
    unitWeightStdDev: z.number().finite().nonnegative(),
    varianceFactor: z.number().finite().nonnegative(),
    varianceBasis: z.enum(['a-priori', 'a-posteriori', 'not-estimated']),
    validation: z.enum(['valid', 'invalid', 'pending'])
  }).strict(),
  solver: SurveyProfessionalSolverV1.optional(),
  closures: z.array(SurveyProfessionalClosureV1),
  residualNorms: z.array(z.object({
    unit: z.enum(['m', 'rad']), value: z.number().finite().nonnegative(),
    count: z.number().int().positive(), status: z.literal('descriptive-only')
  }).strict()),
  observations: z.array(SurveyProfessionalObservationV1),
  points: z.array(SurveyProfessionalPointV1),
  weakestPoint: z.object({
    status: z.enum(['available', 'not-evaluated']),
    criterion: z.literal('largest-reported-point-standard-error'),
    pointId: z.string().optional(), standardErrorMetres: z.number().finite().nonnegative().optional(),
    reason: SurveyProfessionalReasonV1.optional()
  }).strict(),
  weakestEdge: z.object({
    status: z.literal('not-evaluated'), reason: SurveyProfessionalReasonV1
  }).strict(),
  checks: z.array(SurveyProfessionalCheckV1),
  reviewStatus: z.literal('unsigned'),
  standardsConformity: z.literal('not-evaluated')
}).strict()
export type SurveyProfessionalReviewV1 = z.infer<typeof SurveyProfessionalReviewV1>
export type SurveyProfessionalSolverV1 = z.infer<typeof SurveyProfessionalSolverV1>
export type SurveyProfessionalClosureV1 = z.infer<typeof SurveyProfessionalClosureV1>
export type SurveyProfessionalClosureMemberV1 = z.infer<typeof SurveyProfessionalClosureMemberV1>
