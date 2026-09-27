import { z } from 'zod'

export const QUALITY_STANDARD_DIGEST = '96a8a6ca677e86292f02ee277f4ca612d5d0a25c532980288a17fa0a92676487' as const
export const QUALITY_PROFILE_VERSION = 'gbt24356-2023-control-declared-counts-1' as const
export const QUALITY_SCORING_LIMITS = Object.freeze({ accuracyItems: 64, sampleUnits: 128, evidenceRefs: 32, count: 1_000_000, rationalBits: 16_384 })
const exactText = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && new TextDecoder().decode(new TextEncoder().encode(value)) === value)
const id = exactText(160).refine(value => value.trim() === value)
const evidence = z.array(id).min(1).max(QUALITY_SCORING_LIMITS.evidenceRefs).refine(values => new Set(values).size === values.length)
// Decimal or fraction strings only: no exponent, implicit float, zero denominator or unbounded BigInt parse.
export const QualityExactInput = z.string().max(52).regex(/^-?(?:0|[1-9]\d{0,23})(?:\.\d{1,24}|\/[1-9]\d{0,23})?$/)
export const QualityExactValue = z.object({ numerator: z.string().max(5000).regex(/^-?(?:0|[1-9]\d*)$/), denominator: z.string().max(5000).regex(/^[1-9]\d*$/) }).strict()
export type QualityExactValue = z.infer<typeof QualityExactValue>
const count = z.number().int().min(0).max(QUALITY_SCORING_LIMITS.count)
export const QUALITY_CONTROL_TREE = [
  { id: 'data-quality', weight: '1/2', children: [{ id: 'mathematical-accuracy', weight: '3/10' }, { id: 'observation-quality', weight: '2/5' }, { id: 'calculation-quality', weight: '3/10' }] },
  { id: 'point-quality', weight: '3/10', children: [{ id: 'selection-quality', weight: '1/2' }, { id: 'marking-quality', weight: '1/2' }] },
  { id: 'material-quality', weight: '1/5', children: [{ id: 'presentation-quality', weight: '3/10' }, { id: 'completeness', weight: '7/10' }] }
] as const
export const QualityProfile = z.enum(['planar-control-point', 'height-control-section'])
const leafIdentity = { elementId: id, subelementId: id }
const defects = z.object({ a: count.nullable(), b: count.nullable(), c: count.nullable(), d: count.nullable(), t: QualityExactInput,
  classification: z.literal('caller-declared-profile-table-counts-not-automatically-classified'), evidenceRefs: evidence }).strict()
const accuracyItem = z.object({ id, m: QualityExactInput.nullable(), m0: QualityExactInput.nullable(), unit: id,
  source: z.literal('caller-declared-error-magnitude-not-derived-from-adjustment-residuals'), evidenceRefs: evidence }).strict()
const accuracyModel = z.object({ items: z.array(accuracyItem).min(1).max(QUALITY_SCORING_LIMITS.accuracyItems),
  aggregation: z.discriminatedUnion('kind', [z.object({ kind: z.literal('arithmetic') }).strict(),
    z.object({ kind: z.literal('weighted'), weights: z.array(QualityExactInput).min(1).max(QUALITY_SCORING_LIMITS.accuracyItems), basisStatement: exactText(4000), evidenceRefs: evidence }).strict()]),
  aCount: count.nullable(), aEvidenceRefs: evidence
}).strict().superRefine((v, ctx) => {
  if (new Set(v.items.map(item => item.id)).size !== v.items.length || new Set(v.items.map(item => item.unit)).size !== 1
    || v.aggregation.kind === 'weighted' && v.aggregation.weights.length !== v.items.length) ctx.addIssue({ code: 'custom', message: 'Accuracy identities, units or weights are inconsistent' })
})
const leaf = z.discriminatedUnion('state', [
  z.object({ ...leafIdentity, state: z.literal('checked'), record: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('accuracy'), model: accuracyModel }).strict(),
    z.object({ kind: z.literal('deduction'), defects }).strict()
  ]) }).strict(),
  z.object({ ...leafIdentity, state: z.literal('pending'), reason: exactText(1000), evidenceRefs: evidence }).strict(),
  z.object({ ...leafIdentity, state: z.literal('excluded'), reason: exactText(1000), evidenceRefs: evidence }).strict()
])
const common = { schemaVersion: z.literal(1), standardCode: z.literal('GB/T 24356-2023'), sourceDigest: z.literal(QUALITY_STANDARD_DIGEST),
  productProfileId: QualityProfile, productProfileVersion: z.literal(QUALITY_PROFILE_VERSION), profileWeightTable: z.union([z.literal(43), z.literal(45)]),
  profileClassificationTable: z.union([z.literal(44), z.literal(46)]), declaredBasis: z.literal('caller-declared-inspection-records-not-authenticated'),
  evidenceRefs: evidence }
const unitCommon = { ...common, unitId: id, unitType: z.enum(['point', 'section']), inspectionStage: z.literal('detailed-inspection') }
const inspectionStatus = z.enum(['qualified', 'failed', 'pending', 'unknown', 'missing'])
export const SurveyQualityScoringInputV1 = z.discriminatedUnion('operation', [
  z.object({ ...unitCommon, operation: z.literal('accuracy'), declaredScope: z.literal('declared-mathematical-accuracy-only'), model: accuracyModel }).strict(),
  z.object({ ...unitCommon, operation: z.literal('deduction'), declaredScope: z.literal('declared-subelement-only'), ...leafIdentity, defects }).strict(),
  z.object({ ...unitCommon, operation: z.literal('unit'), declaredScope: z.literal('explicit-profile-leaves'), leaves: z.array(leaf).length(7) }).strict(),
  z.object({ ...common, operation: z.literal('overview'), inspectionStage: z.literal('overview-inspection'), unitId: id, unitType: z.enum(['point', 'section']),
    declaredScope: z.literal('declared-overview-only'), a: count.nullable(), b: count.nullable() }).strict(),
  z.object({ ...common, operation: z.literal('sample'), inspectionStage: z.literal('detailed-sample'), sampleId: id,
    declaredScope: z.literal('explicit-sample-members'), declaredUnitIds: z.array(id).min(1).max(QUALITY_SCORING_LIMITS.sampleUnits),
    units: z.array(z.discriminatedUnion('state', [
      z.object({ unitId: id, state: z.literal('qualified'), declaredUnitCoverage: z.literal('full-product-profile'), score: QualityExactInput, evidenceRefs: evidence }).strict(),
      z.object({ unitId: id, state: z.literal('nonconforming'), reason: exactText(1000), evidenceRefs: evidence }).strict(),
      z.object({ unitId: id, state: z.literal('pending'), reason: exactText(1000), evidenceRefs: evidence }).strict()
    ])).max(QUALITY_SCORING_LIMITS.sampleUnits) }).strict(),
  z.object({ ...common, operation: z.literal('final-batch'), inspectionStage: z.literal('final-inspection-batch'), batchId: id,
    declaredScope: z.literal('actual-final-inspection-batch-not-sample'), declaredBatchUnitCount: count.min(1),
    excellentCount: count, goodCount: count, qualifiedCount: count,
    membershipStatus: z.enum(['complete', 'incomplete', 'unknown']), priorBatchQualification: z.enum(['qualified', 'failed', 'unknown']) }).strict(),
  z.object({ ...common, operation: z.literal('acceptance-batch'), inspectionStage: z.literal('acceptance-batch'), batchId: id,
    declaredScope: z.literal('declared-acceptance-inspections-only'), detailed: inspectionStatus,
    overview: z.union([inspectionStatus, z.literal('not-performed')]),
    overviewNotPerformedBasis: exactText(4000).nullable(), fabricatedResults: z.boolean().nullable(), majorTechnicalRouteDeviation: z.boolean().nullable()
  }).strict()
]).superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
  const planar = v.productProfileId === 'planar-control-point'
  if (v.profileWeightTable !== (planar ? 43 : 45) || v.profileClassificationTable !== (planar ? 44 : 46)
    || 'unitType' in v && v.unitType !== (planar ? 'point' : 'section')) issue('Profile tables and unit type must match the declared product')
  const checkIdentity = (value: { elementId: string; subelementId: string }) => {
    if (!QUALITY_CONTROL_TREE.some(element => element.id === value.elementId && element.children.some(child => child.id === value.subelementId))) issue('Unknown subelement or parent')
  }
  const checkDefects = (subelementId: string, value: z.infer<typeof defects>) => {
    if (subelementId === 'mathematical-accuracy' && [value.b, value.c, value.d].some(n => n !== null && n > 0)) issue('Tables 44 and 46 do not permit B/C/D mathematical-accuracy defects')
  }
  if (v.operation === 'deduction') { checkIdentity(v); checkDefects(v.subelementId, v.defects) }
  if (v.operation === 'unit') {
    if (new Set(v.leaves.map(item => item.subelementId)).size !== 7) issue('Every profile leaf must be declared exactly once')
    for (const item of v.leaves) {
      checkIdentity(item)
      if (item.state === 'checked') {
        if ((item.subelementId === 'mathematical-accuracy') !== (item.record.kind === 'accuracy')) issue('Mathematical accuracy requires the precision record; other leaves require declared defect counts')
        if (item.record.kind === 'deduction') checkDefects(item.subelementId, item.record.defects)
      }
    }
  }
  if (v.operation === 'sample' && (new Set(v.declaredUnitIds).size !== v.declaredUnitIds.length
    || new Set(v.units.map(item => item.unitId)).size !== v.units.length || v.units.some(item => !v.declaredUnitIds.includes(item.unitId)))) issue('Sample membership must be unique and explicit')
  if (v.operation === 'final-batch' && (v.excellentCount + v.goodCount + v.qualifiedCount > v.declaredBatchUnitCount
    || v.membershipStatus === 'complete' && v.excellentCount + v.goodCount + v.qualifiedCount !== v.declaredBatchUnitCount)) issue('Counts must use the declared actual batch denominator')
  if (v.operation === 'acceptance-batch' && (v.overview === 'not-performed') !== (v.overviewNotPerformedBasis !== null)) issue('Not-performed overview requires its explicit basis and cannot mean missing or pending')
})
export type SurveyQualityScoringInputV1 = z.infer<typeof SurveyQualityScoringInputV1>

export const QualityRuleResultV1 = z.object({
  state: z.enum(['calculated', 'nonconforming', 'unavailable', 'invalid']), reason: id,
  score: QualityExactValue.nullable(), rawScore: QualityExactValue.nullable(), fixedADeduction: QualityExactValue.nullable(), diagnosticScoreUpperBound: QualityExactValue.nullable(),
  grade: z.enum(['excellent', 'good', 'qualified']).nullable(), qualified: z.boolean().nullable(),
  count: count.nullable(), excellentRate: QualityExactValue.nullable(), excellentGoodRate: QualityExactValue.nullable()
}).strict().superRefine((v, ctx) => {
  if (v.state !== 'calculated' && (v.score !== null || v.grade !== null || v.qualified === true)
    || v.state === 'calculated' && v.qualified === false || v.state === 'nonconforming' && v.qualified !== false) ctx.addIssue({ code: 'custom', message: 'Unresolved or failed records cannot expose an accepted score or grade' })
})
export type QualityRuleResultV1 = z.infer<typeof QualityRuleResultV1>
export const SurveyQualityScoringOutputV1 = z.object({
  schemaVersion: z.literal(1), algorithmVersion: z.literal('gbt24356-declared-exact-quality-scoring-1'),
  status: z.literal('declared-inspection-trial-only'), request: SurveyQualityScoringInputV1.nullable(), requestSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  result: QualityRuleResultV1,
  scopeAssessment: z.enum(['not-evaluated', 'declared-component-only', 'complete-declared-product-profile', 'partial-declared-product-profile', 'unresolved-declared-product-profile', 'declared-sample-only', 'declared-batch-only']),
  checkedSubelementIds: z.array(id).max(7), pendingSubelementIds: z.array(id).max(7), excludedSubelementIds: z.array(id).max(7),
  trace: z.array(z.object({ nodeId: id, clause: id, result: QualityRuleResultV1, originalWeight: QualityExactValue.nullable(), effectiveWeight: QualityExactValue.nullable() }).strict()).max(512),
  arithmetic: z.literal('bounded-reduced-bigint-rational-no-rounded-thresholds'),
  evidenceAuthenticity: z.literal('not-verified'), classificationAuthenticity: z.literal('not-verified'), priorQualificationAuthenticity: z.literal('not-verified'),
  engineeringDecision: z.literal('not-evaluated'), standardConformity: z.literal('not-authenticated'), humanSignatureVerification: z.literal('not-evaluated'),
  formalResultsModified: z.literal(false), observationAction: z.literal('none'),
  source: z.object({ standardCode: z.literal('GB/T 24356-2023'), sha256: z.literal(QUALITY_STANDARD_DIGEST),
    reviewedPrintedPageRanges: z.tuple([z.literal('6-8'), z.literal('57-63')]),
    scope: z.literal('limited-declared-inspection-scoring-not-full-standard-implementation') }).strict()
}).strict().superRefine((v, ctx) => {
  if (v.request === null ? v.requestSha256 !== null || v.result.state !== 'invalid' || v.trace.length !== 0 || v.scopeAssessment !== 'not-evaluated' : v.requestSha256 === null) ctx.addIssue({ code: 'custom', message: 'Request identity must match validation outcome' })
})
export type SurveyQualityScoringOutputV1 = z.infer<typeof SurveyQualityScoringOutputV1>
