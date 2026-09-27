import { z } from 'zod'

export const SURVEY_REFERENCE_DATUM_POLICY_V1 = {
  maxPoints: 32, maxCoordinateMagnitude: 1e9, minPositiveVariance: 1e-100, maxVariance: 1e100,
  maxVarianceRatio: 1e12, maxReferenceCorrelationCondition: 1e10, maxWeightAbsoluteSum: 1e6,
  covarianceEigenvalueTolerance: 1e-10, backwardTolerance: 1e-10
} as const
const scalar = z.number().finite()
const id = z.string().min(1).max(160).refine(s => s.trim() === s && new TextDecoder().decode(new TextEncoder().encode(s)) === s, 'Exact nonblank Unicode ID required')
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const vector = z.array(scalar).min(2).max(SURVEY_REFERENCE_DATUM_POLICY_V1.maxPoints)
const matrix = z.array(vector).min(2).max(SURVEY_REFERENCE_DATUM_POLICY_V1.maxPoints)
const epoch = z.object({
  id, sourceAnchor: id, sourceSha256: hash,
  covarianceBasis: z.literal('caller-declared-full-coordinate-covariance-not-cofactor'),
  points: z.array(z.object({ id, coordinate: scalar.min(-1e9).max(1e9) }).strict()).min(2).max(32), covariance: matrix
}).strict()
export const SurveyReferenceDatumInputV1 = z.object({
  schemaVersion: z.literal(1), model: z.literal('two-epoch-one-dimensional-declared-reference-datum'),
  unit: z.enum(['m', 'mm']),
  method: z.enum(['gls-reference-mean', 'equal-reference-mean']),
  referenceDeclaration: z.literal('caller-selected-reference-set-not-verified-stable'),
  testingStrategy: z.literal('none-datum-comparison-only'),
  firstEpoch: epoch, secondEpoch: epoch,
  mapping: z.array(z.object({ id, firstPointId: id, secondPointId: id }).strict()).min(2).max(32),
  referenceIds: z.array(id).min(2).max(32),
  dependence: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('caller-declared-independent'), sourceAnchor: id }).strict(),
    z.object({ kind: z.literal('caller-declared-cross-covariance'), sourceAnchor: id, firstToSecondCovariance: matrix }).strict()
  ])
}).strict().superRefine((value, ctx) => {
  const issue = (message: string): void => ctx.addIssue({ code: 'custom', message })
  const n = value.mapping.length
  if (value.firstEpoch.id === value.secondEpoch.id) issue('Epoch IDs must be distinct')
  for (const ids of [value.firstEpoch.points.map(p => p.id), value.secondEpoch.points.map(p => p.id), value.mapping.map(m => m.id), value.mapping.map(m => m.firstPointId), value.mapping.map(m => m.secondPointId), value.referenceIds]) {
    if (new Set(ids).size !== ids.length) issue('Epoch, mapping and reference IDs must be unique within their collection')
  }
  for (const e of [value.firstEpoch, value.secondEpoch]) if (e.points.length !== n || e.covariance.length !== n || e.covariance.some(row => row.length !== n)) issue('Each epoch must contain exactly the mapped points and their full square covariance')
  if (value.mapping.some(m => !value.firstEpoch.points.some(p => p.id === m.firstPointId) || !value.secondEpoch.points.some(p => p.id === m.secondPointId))) issue('The mapping must be a complete point bijection')
  if (value.referenceIds.some(id => !value.mapping.some(m => m.id === id))) issue('Every reference ID must name a mapped point')
  if (value.dependence.kind === 'caller-declared-cross-covariance' && (value.dependence.firstToSecondCovariance.length !== n || value.dependence.firstToSecondCovariance.some(row => row.length !== n))) issue('Cross covariance rows must match first epoch and columns second epoch native point order')
})
export type SurveyReferenceDatumInputV1 = z.infer<typeof SurveyReferenceDatumInputV1>

const flags = {
  algorithmVersion: z.literal('declared-reference-datum-1'), status: z.literal('trial-only'),
  modelAssumptions: z.literal('not-verified'), sourceRecordsVerified: z.literal(false), epochDependenceVerified: z.literal(false),
  referencePhysicalStability: z.literal('not-evaluated'), referenceSelection: z.literal('caller-declared-no-automatic-selection'),
  engineeringDecision: z.literal('not-evaluated'), observationAction: z.literal('none'),
  significanceTesting: z.literal('not-performed'), formalCoordinatesModified: z.literal(false)
}
const covarianceCheck = z.object({
  method: z.literal('diagonal-equilibrated-cyclic-jacobi-check-original-matrix-retained'),
  dimension: z.number().int().min(4).max(64), activeDimension: z.number().int().min(0).max(64),
  minimumCorrelationEigenvalueEstimate: scalar, maximumOffDiagonalResidual: scalar.nonnegative(),
  eigenvalueTolerance: z.literal(SURVEY_REFERENCE_DATUM_POLICY_V1.covarianceEigenvalueTolerance),
  classification: z.enum(['numerically-positive-definite', 'semidefinite-or-unresolved-within-numerical-tolerance']),
  matrixRepair: z.literal('none')
}).strict()
export type SurveyReferenceDatumCovarianceCheckV1 = z.infer<typeof covarianceCheck>
const requestFields = { request: SurveyReferenceDatumInputV1, requestSha256: hash }
export const SurveyReferenceDatumOutputV1 = z.discriminatedUnion('outcome', [
  z.object({ ...flags, outcome: z.literal('invalid-input'), message: z.string() }).strict(),
  z.object({
    ...flags, ...requestFields, outcome: z.literal('unavailable'),
    code: z.enum(['covariance-not-symmetric', 'covariance-not-positive-semidefinite', 'covariance-scale-outside-supported-domain', 'covariance-eigensolver-iteration-limit', 'reference-covariance-rank-or-conditioning', 'numeric-range-or-resolution']),
    message: z.string(), covarianceCheck: covarianceCheck.nullable()
  }).strict(),
  z.object({
    ...flags, ...requestFields, outcome: z.literal('calculated'),
    pointIds: z.array(id).min(2).max(32), referenceIds: z.array(id).min(2).max(32),
    unit: z.enum(['m', 'mm']), squaredUnit: z.enum(['m2', 'mm2']),
    differenceConvention: z.literal('second-minus-first'), displacementConvention: z.literal('difference-minus-declared-reference-shift'),
    datumMeaning: z.enum(['declared-gls-reference-definition-not-proof-of-stability', 'declared-equal-reference-definition-not-precision-optimality-or-stability']),
    rawDifferences: vector, differenceCovariance: matrix, referenceWeights: vector,
    referenceShift: scalar, referenceShiftVariance: scalar.nonnegative(),
    displacements: vector, displacementCovariance: matrix, shiftDisplacementCovariance: vector,
    transformation: matrix, covarianceCheck,
    numerical: z.object({
      referenceCorrelationConditionInfinity: scalar.min(1).nullable(), referenceSolveRelativeBackwardError: scalar.nonnegative().nullable(),
      referenceWeightAbsoluteSum: scalar.min(1 - 1e-12), referenceConstraintResidual: scalar,
      coordinateRoundoffEstimate: scalar.nonnegative(), covarianceRoundoffEstimate: scalar.nonnegative(),
      errorEstimateMeaning: z.literal('software-resolution-diagnostic-not-certified-bound')
    }).strict()
  }).strict()
]).superRefine((value, ctx) => {
  if (value.outcome === 'invalid-input') return
  const issue = (message: string): void => ctx.addIssue({ code: 'custom', message })
  if (value.covarianceCheck && value.covarianceCheck.dimension !== value.request.mapping.length * 2) issue('Covariance check dimension must match both epochs')
  if (value.outcome !== 'calculated') return
  const n = value.request.mapping.length
  if (value.pointIds.length !== n || value.pointIds.some((id, i) => id !== value.request.mapping[i]?.id) || JSON.stringify(value.referenceIds) !== JSON.stringify(value.request.referenceIds)) issue('Output point and reference identities must match the declaration')
  if (value.unit !== value.request.unit || value.squaredUnit !== `${value.unit}2`) issue('Output covariance units must be squared input units')
  for (const v of [value.rawDifferences, value.referenceWeights, value.displacements, value.shiftDisplacementCovariance]) if (v.length !== n) issue('Output vector dimension mismatch')
  for (const m of [value.differenceCovariance, value.displacementCovariance, value.transformation]) if (m.length !== n || m.some(row => row.length !== n)) issue('Output matrix dimension mismatch')
  if (value.referenceWeights.length !== n) return
  const refs = value.pointIds.flatMap((id, i) => value.referenceIds.includes(id) ? [i] : [])
  if (value.referenceWeights.some((w, i) => !refs.includes(i) && w !== 0)) issue('Weights outside the declared reference set must be zero')
  const weightSum = value.referenceWeights.reduce((a, b) => a + b, 0)
  if (Math.abs(weightSum - 1) > 1e-10) issue('Reference weights must sum to one')
  if (value.transformation.some((row, i) => row.some((entry, j) => entry !== (i === j ? 1 : 0) - value.referenceWeights[j]!))) issue('Transformation must be I minus one times reference weights')
  for (const m of [value.differenceCovariance, value.displacementCovariance]) {
    if (m.some((row, i) => row[i]! < 0 || row.some((entry, j) => entry !== m[j]?.[i]))) issue('Output covariance must be symmetric with nonnegative diagonal')
  }
  if (value.request.method === 'equal-reference-mean') {
    if (refs.some(i => value.referenceWeights[i] !== 1 / refs.length) || value.numerical.referenceCorrelationConditionInfinity !== null || value.numerical.referenceSolveRelativeBackwardError !== null || value.datumMeaning !== 'declared-equal-reference-definition-not-precision-optimality-or-stability') issue('Equal-reference method cannot silently become GLS or claim optimality')
  } else if (value.numerical.referenceCorrelationConditionInfinity === null || value.numerical.referenceSolveRelativeBackwardError === null || value.datumMeaning !== 'declared-gls-reference-definition-not-proof-of-stability') issue('GLS output requires its solve diagnostics')
})
export type SurveyReferenceDatumOutputV1 = z.infer<typeof SurveyReferenceDatumOutputV1>
