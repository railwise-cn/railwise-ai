import { z } from 'zod'
import { QualityProfile, QualityRuleResultV1, QUALITY_PROFILE_VERSION, QUALITY_STANDARD_DIGEST, SurveyQualityScoringOutputV1 } from './survey-quality-scoring.js'
import { SurveyQualityArtifactV1, SurveyQualityPlanV1, SurveyQualityWorkspaceVerificationV1 } from './survey-quality-workspace.js'
import { SurveySamplingPopulationDetailV1, SurveySamplingRunSummaryV1 } from './survey-quality-sampling-workspace.js'

export const QUALITY_ASSESSMENT_ALGORITHM = 'declared-record-linkage-1' as const
export const QUALITY_ASSESSMENT_LIMITS = Object.freeze({ requestBytes: 256 * 1024, recordBytes: 512 * 1024, recordsPerProject: 128,
  storedBytesPerProject: 64 * 1024 * 1024, units: 8, mappings: 64, pageSize: 10, workUnitsPerMinute: 32 })
const unicode = (v: string) => new TextDecoder().decode(new TextEncoder().encode(v)) === v
const id = z.string().min(1).max(160).refine(v => v.trim() === v && unicode(v))
const text = (max: number) => z.string().min(1).max(max).refine(v => unicode(v) && v.trim().length > 0 && new TextEncoder().encode(v).byteLength <= max)
const hash = z.string().regex(/^[a-f0-9]{64}$/), revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), time = z.iso.datetime({ offset: true })
export const QUALITY_ASSESSMENT_BOUNDARIES = Object.freeze({ purpose: 'declared-record-linkage-only', associationTrust: 'caller-declared-not-authenticated',
  inspectionEvidenceAuthenticity: 'not-verified', materialCompletenessBeyondDeclaration: 'not-evaluated', populationCompleteness: 'caller-declared-not-verified',
  classificationAuthenticity: 'not-verified', organizationIndependence: 'not-evaluated', stageCompletion: 'not-evaluated', checkpointTrust: 'local-records-only',
  standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated', engineeringDecision: 'not-evaluated', approvalCapability: 'none',
  formalResultsModified: false, deliverableVerification: 'not-performed-by-assessment', deliverableNumericalReplay: 'not-performed-by-assessment' } as const)
const boundaryShape = { purpose: z.literal(QUALITY_ASSESSMENT_BOUNDARIES.purpose), associationTrust: z.literal(QUALITY_ASSESSMENT_BOUNDARIES.associationTrust),
  inspectionEvidenceAuthenticity: z.literal('not-verified'), materialCompletenessBeyondDeclaration: z.literal('not-evaluated'), populationCompleteness: z.literal('caller-declared-not-verified'),
  classificationAuthenticity: z.literal('not-verified'), organizationIndependence: z.literal('not-evaluated'), stageCompletion: z.literal('not-evaluated'), checkpointTrust: z.literal('local-records-only'),
  standardConformity: z.literal('not-evaluated'), humanSignatureVerification: z.literal('not-evaluated'), engineeringDecision: z.literal('not-evaluated'), approvalCapability: z.literal('none'),
  formalResultsModified: z.literal(false), deliverableVerification: z.literal('not-performed-by-assessment'), deliverableNumericalReplay: z.literal('not-performed-by-assessment') }
const commonRequest = { schemaVersion: z.literal(1), acknowledged: z.literal(true), expectedProjectRevision: revision, idempotencyKey: id.refine(v => v.length >= 8) }
export const AssessmentMaterialV1 = z.object({ reference: id, retentionCheckId: id, memberId: id, locatorStatement: text(1000) }).strict()
export const SurveyQualityAssessmentPlanCreateV1 = z.object({ ...commonRequest, retentionPlanId: id, retentionRecordId: id, samplingRunId: id,
  productProfileId: QualityProfile, basisStatement: text(16 * 1024), unitMaterials: z.array(z.object({ unitId: id,
    requirements: z.array(AssessmentMaterialV1).min(1).max(64).refine(v => new Set(v.map(x => x.reference)).size === v.length) }).strict()).min(1).max(8)
}).strict().refine(v => new Set(v.unitMaterials.map(x => x.unitId)).size === v.unitMaterials.length && v.unitMaterials.reduce((n, x) => n + x.requirements.length, 0) <= 64)
export type SurveyQualityAssessmentPlanCreateV1 = z.infer<typeof SurveyQualityAssessmentPlanCreateV1>
export const SurveyQualityAssessmentCreateV1 = z.object({ ...commonRequest, assessmentPlanId: id, expectedPlanHash: hash,
  unitScores: z.array(z.object({ unitId: id, scoringRecordId: id }).strict()).max(8)
}).strict().refine(v => new Set(v.unitScores.map(x => x.unitId)).size === v.unitScores.length && new Set(v.unitScores.map(x => x.scoringRecordId)).size === v.unitScores.length)
export type SurveyQualityAssessmentCreateV1 = z.infer<typeof SurveyQualityAssessmentCreateV1>
export const AssessmentProjectV1 = z.object({ id, revision, workspace: text(8192) }).strict()
export const AssessmentProfileV1 = z.object({ profileId: QualityProfile, profileVersion: z.literal(QUALITY_PROFILE_VERSION), standardCode: z.literal('GB/T 24356-2023'),
  sourceSha256: z.literal(QUALITY_STANDARD_DIGEST), weightTable: z.union([z.literal(43), z.literal(45)]), classificationTable: z.union([z.literal(44), z.literal(46)]),
  dependencyAlgorithmVersions: z.object({ sampling: z.literal('quality-sampling-hmac-sha256-fy-1'), scoring: z.literal('gbt24356-declared-exact-quality-scoring-1') }).strict()
}).strict().refine(v => v.weightTable === (v.profileId === 'planar-control-point' ? 43 : 45) && v.classificationTable === v.weightTable + 1)
export const AssessmentSnapshotV1 = z.object({ project: AssessmentProjectV1, retentionPlan: SurveyQualityPlanV1, retentionPlanDigest: hash,
  artifact: SurveyQualityArtifactV1, retentionRecordId: id, population: SurveySamplingPopulationDetailV1, run: SurveySamplingRunSummaryV1,
  selectedUnitIds: z.array(id).min(1).max(8), sampleIdsHash: hash, profile: AssessmentProfileV1 }).strict()
const common = { schemaVersion: z.literal(1), id, projectId: id, projectRevision: revision, projectBindingHash: hash,
  createdAt: time, requestSha256: hash, requestSizeBytes: z.number().int().positive().max(QUALITY_ASSESSMENT_LIMITS.requestBytes),
  requestJson: text(QUALITY_ASSESSMENT_LIMITS.requestBytes), algorithmPolicyVersion: z.literal(QUALITY_ASSESSMENT_ALGORITHM), ...boundaryShape }
export const SurveyQualityAssessmentPlanV1 = z.object({ ...common, request: SurveyQualityAssessmentPlanCreateV1, snapshot: AssessmentSnapshotV1, planHash: hash }).strict()
export type SurveyQualityAssessmentPlanV1 = z.infer<typeof SurveyQualityAssessmentPlanV1>
const scoreBinding = z.object({ unitId: id, recordId: id, requestSha256: hash, declarationSha256: hash, modelHash: hash, resultHash: hash, recordHash: hash }).strict()
export const AssessmentSourceVectorV1 = z.object({ manifestId: id, manifestHash: hash, artifactId: id, bundleHash: hash, retentionPlanId: id, retentionPlanDigest: hash,
  retentionRecordId: id, retentionEventCount: z.number().int().min(0).max(512), retentionHeadHash: hash,
  populationId: id, populationHash: hash, populationDefinitionHash: hash, samplingRunId: id, samplingRunHash: hash, samplingPlanHash: hash, sampleIdsHash: hash,
  scoring: z.array(scoreBinding).max(8), profile: AssessmentProfileV1 }).strict()
export const AssessmentUnitRowV1 = z.object({ unitId: id, materials: z.array(AssessmentMaterialV1.extend({ status: z.enum(['retained-bytes-linked', 'missing-retention-check']), eventId: id.nullable() }).strict()).max(64),
  score: z.object({ recordId: id, associationTiming: z.literal('existing-record-linked-after-calculation'), declaredTargetAssociation: z.literal('caller-declared-not-authenticated'),
    scopeAssessment: SurveyQualityScoringOutputV1.shape.scopeAssessment, result: QualityRuleResultV1 }).strict().nullable(),
  references: z.array(z.object({ reference: id, resolved: z.boolean() }).strict()).max(2336), fullProfileResult: z.boolean() }).strict()
export const AssessmentResultV1 = z.object({ bindingIntegrity: z.literal('verified-current-local-records'), retentionCoverage: z.enum(['complete-declared-requirements', 'incomplete-declared-requirements']),
  scoreCoverage: z.enum(['complete-full-profile-unit-results', 'incomplete-full-profile-unit-results']), declaredResultSummary: z.enum(['contains-declared-nonconforming', 'all-declared-unit-results-calculated', 'unresolved']),
  overallLinkage: z.enum(['complete-declared-linkage', 'incomplete-declared-linkage']), originalRetentionChecks: SurveyQualityWorkspaceVerificationV1.shape.checks,
  unitRows: z.array(AssessmentUnitRowV1).min(1).max(8), counts: z.object({ expectedUnits: z.number().int().min(1).max(8), linkedScores: z.number().int().min(0).max(8), fullProfileUnits: z.number().int().min(0).max(8),
    requiredMaterialMappings: z.number().int().min(1).max(64), satisfiedMaterialMappings: z.number().int().min(0).max(64), unresolvedReferences: z.number().int().min(0).max(18688) }).strict() }).strict()
export type AssessmentResultV1 = z.infer<typeof AssessmentResultV1>
export const SurveyQualityAssessmentV1 = z.object({ ...common, request: SurveyQualityAssessmentCreateV1, projectSnapshot: AssessmentProjectV1,
  assessmentPlanId: id, planHash: hash, sourceVector: AssessmentSourceVectorV1, result: AssessmentResultV1, resultHash: hash,
  manifestReviewStatus: z.enum(['draft', 'approved', 'archived']), replayEnvironment: z.object({ node: id, v8: id, platform: id, arch: id, bun: id.nullable() }).strict(), recordHash: hash }).strict()
export type SurveyQualityAssessmentV1 = z.infer<typeof SurveyQualityAssessmentV1>
export const SurveyQualityAssessmentVerificationV1 = z.object({ record: SurveyQualityAssessmentV1, checkedAt: time }).strict()
export const SurveyQualityAssessmentReverifyV1 = z.object({}).strict()
export const AssessmentListSummaryV1 = z.object({ id, projectId: id, projectRevision: revision, createdAt: time, contentHash: hash,
  result: AssessmentResultV1.nullable(), view: z.literal('saved-summary-only'), dependencyVerification: z.literal('not-performed-on-list') }).strict()
export const SurveyQualityAssessmentListV1 = z.object({ records: z.array(AssessmentListSummaryV1).max(10), unavailable: z.array(z.object({ id, reason: z.enum(['stale','integrity','replay-environment']) }).strict()).max(10),
  nextOffset: z.number().int().min(0).max(128).nullable(), view: z.literal('saved-summary-only'), dependencyVerification: z.literal('not-performed-on-list') }).strict()
