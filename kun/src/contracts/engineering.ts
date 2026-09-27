import { z } from 'zod'
import { AdjustmentResultV1, DeformationComparisonV1, SurveySourceFileV1 } from './survey.js'

export const ENGINEERING_SCHEMA_VERSION = 1 as const
export const ENGINEERING_MAX_OBSERVATIONS = 500_000
export const ENGINEERING_TREND_RENDERER_VERSION = 'engineering-trend-2' as const
export const ENGINEERING_ANALYSIS_ALGORITHM_VERSION = 'workwise-engineering-2' as const

export const EngineeringTaskTypeV1 = z.enum(['control-network', 'leveling-network', 'traverse-network', 'resection', 'deformation', 'gnss'])
export type EngineeringTaskTypeV1 = z.infer<typeof EngineeringTaskTypeV1>

/** Unknown legacy classifications remain readable without inventing a task type. */
export function inferEngineeringTaskType(monitoringType: string): EngineeringTaskTypeV1 | undefined {
  const aliases: Record<string, EngineeringTaskTypeV1> = {
    leveling: 'leveling-network', traverse: 'traverse-network', 'plane-control': 'control-network',
    'cpiii-free-station': 'resection', 'cpiii-resection': 'resection'
  }
  const parsed = EngineeringTaskTypeV1.safeParse(monitoringType)
  return parsed.success ? parsed.data : aliases[monitoringType]
}

export const RevisionMutationV1 = z.object({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(8).max(200)
}).strict()
export type RevisionMutationV1 = z.infer<typeof RevisionMutationV1>

export const EngineeringTaskContextV1 = z.object({
  networkType: z.string().max(100).optional(),
  coordinateSystem: z.string().max(200).optional(),
  verticalDatum: z.string().max(200).optional(),
  measurementGrade: z.string().max(100).optional(),
  standard: z.string().max(200).optional(),
  standardVersion: z.string().max(100).optional(),
  standardClause: z.string().max(200).optional()
}).strict()

export const RailwiseProjectV1 = z.object({
  schemaVersion: z.literal(ENGINEERING_SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  /** No default on reads: infer from legacy classification without rewriting storage. */
  taskType: EngineeringTaskTypeV1.optional(),
  taskContext: EngineeringTaskContextV1.optional(),
  monitoringType: z.string().min(1).default('deformation'),
  unit: z.string().min(1).default('mm'),
  signConvention: z.string().min(1).default('positive'),
  thresholds: z.record(z.string(), z.number().finite()).default({}),
  reportPeriod: z.object({ start: z.string().optional(), end: z.string().optional() }).strict().default({}),
  workspace: z.string().min(1),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string()
}).strict()
export type RailwiseProjectV1 = z.infer<typeof RailwiseProjectV1>

export const DatasetImportStatusV1 = z.enum(['imported', 'validated', 'failed', 'cancelled'])
export type DatasetImportStatusV1 = z.infer<typeof DatasetImportStatusV1>

export const FieldMappingV1 = z.object({
  project: z.string().optional(), period: z.string().optional(), monitoringItem: z.string().optional(),
  point: z.string().optional(), timestamp: z.string().optional(), value: z.string().optional(),
  unit: z.string().optional(), cumulative: z.string().optional(), rate: z.string().optional(),
  warningThreshold: z.string().optional(), alarmThreshold: z.string().optional(), controlThreshold: z.string().optional(),
  valid: z.string().optional(), note: z.string().optional()
}).strict()
export type FieldMappingV1 = z.infer<typeof FieldMappingV1>

export const MonitoringDatasetV1 = z.object({
  schemaVersion: z.literal(ENGINEERING_SCHEMA_VERSION),
  id: z.string().min(1), projectId: z.string().min(1), sourceAttachmentId: z.string().optional(),
  sourceFileName: z.string().min(1), sourceFileHash: z.string().min(1),
  fieldMapping: FieldMappingV1, unknownColumns: z.array(z.string()), rowCount: z.number().int().nonnegative(),
  columnCount: z.number().int().nonnegative(), observationCount: z.number().int().nonnegative(),
  timeRange: z.object({ start: z.string().optional(), end: z.string().optional() }).strict(),
  status: DatasetImportStatusV1, revision: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string()
}).strict()
export type MonitoringDatasetV1 = z.infer<typeof MonitoringDatasetV1>

export const MonitoringObservationV1 = z.object({
  schemaVersion: z.literal(ENGINEERING_SCHEMA_VERSION), id: z.string().min(1), projectId: z.string().min(1),
  datasetId: z.string().min(1), monitoringItem: z.string().min(1), point: z.string().min(1),
  timestamp: z.string().min(1), value: z.number().finite(), unit: z.string().optional(), cumulative: z.number().finite().optional(),
  rate: z.number().finite().optional(), sourceRow: z.number().int().positive(), sourceFields: z.record(z.string(), z.unknown()).default({})
}).strict()
export type MonitoringObservationV1 = z.infer<typeof MonitoringObservationV1>

export const QualityFindingV1 = z.object({
  schemaVersion: z.literal(ENGINEERING_SCHEMA_VERSION), id: z.string().min(1), datasetId: z.string().min(1),
  code: z.enum(['missing_identifier', 'missing_value', 'invalid_number', 'duplicate_observation', 'time_order', 'unit_conflict', 'missing_threshold', 'row_limit']),
  severity: z.enum(['blocking', 'warning', 'info']), row: z.number().int().positive().optional(),
  message: z.string().min(1), suggestion: z.string().min(1), status: z.enum(['open', 'resolved', 'accepted']).default('open'),
  createdAt: z.string()
}).strict()
export type QualityFindingV1 = z.infer<typeof QualityFindingV1>

export const MonitoringAnalysisV1 = z.object({
  schemaVersion: z.literal(ENGINEERING_SCHEMA_VERSION), id: z.string().min(1), projectId: z.string().min(1), datasetId: z.string().min(1),
  inputHash: z.string().min(1), algorithmVersion: z.string().min(1), results: z.array(z.object({
    monitoringItem: z.string(), point: z.string(), currentValue: z.number().finite().optional(), previousValue: z.number().finite().optional(),
    cumulativeChange: z.number().finite().optional(), changeRate: z.number().finite().optional(), trend: z.enum(['rising', 'falling', 'stable', 'unknown']),
    anomaly: z.boolean(), thresholdStatus: z.enum(['normal', 'warning', 'alarm', 'control', 'unresolved'])
  }).strict()), createdAt: z.string()
}).strict()
export type MonitoringAnalysisV1 = z.infer<typeof MonitoringAnalysisV1>

export const ChartArtifactV1 = z.object({
  schemaVersion: z.literal(ENGINEERING_SCHEMA_VERSION), id: z.string().min(1), analysisId: z.string().min(1), chartType: z.string().min(1),
  /** Missing on legacy artifacts; their historical bytes remain readable. */
  rendererVersion: z.string().min(1).optional(),
  inputHash: z.string().min(1), dataRange: z.object({ min: z.number().finite(), max: z.number().finite() }).strict().optional(),
  relativePath: z.string().min(1), sha256: z.string().min(1), validation: z.enum(['pending', 'valid', 'invalid']), createdAt: z.string()
}).strict()
export type ChartArtifactV1 = z.infer<typeof ChartArtifactV1>

export const KnowledgeCitationV1 = z.object({
  id: z.string().min(1), sourceType: z.enum(['attachment', 'knowledge-base', 'standard', 'other']), source: z.string().min(1),
  page: z.number().int().positive().optional(), worksheet: z.string().optional(), row: z.number().int().positive().optional(), url: z.string().url().optional(), locator: z.string().optional()
}).strict()
export type KnowledgeCitationV1 = z.infer<typeof KnowledgeCitationV1>

export const SurveySourceEvidenceV1 = z.object({
  networkId: z.string().min(1),
  source: SurveySourceFileV1
}).strict()
export type SurveySourceEvidenceV1 = z.infer<typeof SurveySourceEvidenceV1>

export const DeliverableManifestV1 = z.object({
  schemaVersion: z.literal(ENGINEERING_SCHEMA_VERSION), id: z.string().min(1), projectId: z.string().min(1), runId: z.string().min(1),
  inputDatasets: z.array(z.object({ id: z.string(), hash: z.string() }).strict()), analyses: z.array(z.string()), charts: z.array(ChartArtifactV1),
  citations: z.array(KnowledgeCitationV1), outputs: z.array(z.object({ path: z.string(), mediaType: z.string(), sha256: z.string(), sizeBytes: z.number().int().nonnegative() }).strict()),
  /** Deterministic survey adjustment results included in the immutable evidence package. */
  adjustments: z.array(AdjustmentResultV1).default([]),
  /** Immutable comparisons derived only from the linked adjustment results. */
  deformations: z.array(DeformationComparisonV1).default([]),
  /** Instrument/GNSS source provenance linked through adjustment network IDs. */
  surveySources: z.array(SurveySourceEvidenceV1).default([]),
  validation: z.object({ valid: z.boolean(), errors: z.array(z.string()), warnings: z.array(z.string()) }).strict(), reviewStatus: z.enum(['draft', 'approved', 'archived']),
  runtimeVersion: z.string(), createdAt: z.string(), finalizedAt: z.string().optional()
}).strict()
export type DeliverableManifestV1 = z.infer<typeof DeliverableManifestV1>

/** A point-in-time read-only check; never a human review or signature. */
export const DeliverableVerificationV1 = z.object({
  schemaVersion: z.literal(1), projectId: z.string(), manifestId: z.string(), checkedAt: z.string(),
  valid: z.boolean(), reviewStatus: z.enum(['draft', 'approved', 'archived']),
  checks: z.array(z.object({
    id: z.enum(['manifest', 'outputs', 'inputs', 'surveyReplay', 'sources']),
    status: z.enum(['passed', 'failed', 'not-applicable']), detail: z.string().optional()
  }).strict())
}).strict()
export type DeliverableVerificationV1 = z.infer<typeof DeliverableVerificationV1>

export const MonitoringReplayStatusV1 = z.enum(['passed', 'failed', 'not-evaluated', 'not-applicable'])
export const MonitoringReplayReasonV1 = z.enum(['matched', 'no-monitoring-analysis', 'unsupported-algorithm', 'prerequisite-failed', 'input-invalid', 'result-mismatch', 'resource-limit', 'source-unavailable', 'source-mismatch', 'ambiguous-tie-order'])
const replayHash = z.string().regex(/^[a-f0-9]{64}$/)
const replayIdentifier = z.string().min(1).max(240)
const replayEnvironment = z.string().min(1).max(160)
const replayEvidence = z.object({
  analysisId: replayIdentifier, datasetId: replayIdentifier, algorithmVersion: replayIdentifier, inputHash: replayHash,
  storedResultsHash: replayHash, recomputedResultsHash: replayHash.optional(), sourceFileHash: replayHash.optional(), sourceContextHash: replayHash.optional(),
  status: MonitoringReplayStatusV1, reasonCode: MonitoringReplayReasonV1
}).strict()
/** Independent numerical replay; existing five-check verification and historical records stay unchanged. */
export const MonitoringReplayVerificationV1 = z.object({
  schemaVersion: z.literal(1), attemptId: replayIdentifier, projectId: replayIdentifier, manifestId: replayIdentifier, checkedAt: z.string().max(40).datetime({ offset: true }),
  status: MonitoringReplayStatusV1, reasonCode: MonitoringReplayReasonV1, detail: z.string().max(240).optional(),
  comparisonVersion: z.literal('monitoring-results-exact-1'),
  execution: z.object({ runtimeVersion: replayEnvironment, node: replayEnvironment, v8: replayEnvironment, icu: replayEnvironment, platform: replayEnvironment, arch: replayEnvironment, timezone: replayEnvironment, locale: replayEnvironment, timeBasis: z.literal('ISO-unzoned-UTC') }).strict(),
  analyses: z.array(replayEvidence).max(1)
}).strict().superRefine((value, context) => {
  const statusForReason = (reason: z.infer<typeof MonitoringReplayReasonV1>): z.infer<typeof MonitoringReplayStatusV1> =>
    reason === 'matched' ? 'passed' : reason === 'no-monitoring-analysis' ? 'not-applicable' : ['unsupported-algorithm', 'resource-limit', 'source-unavailable', 'ambiguous-tie-order'].includes(reason) ? 'not-evaluated' : 'failed'
  if (value.status !== statusForReason(value.reasonCode)) context.addIssue({ code: 'custom', message: 'replay status does not match reason' })
  if (value.status === 'passed' && !value.analyses.length) context.addIssue({ code: 'custom', message: 'passed replay requires analysis evidence' })
  if (value.status === 'not-applicable' && value.analyses.length) context.addIssue({ code: 'custom', message: 'non-applicable replay cannot include analysis evidence' })
  for (const item of value.analyses) {
    if (item.status !== statusForReason(item.reasonCode) || item.status === 'not-applicable'
      || (item.status === 'passed' && (!item.sourceFileHash || !item.sourceContextHash || !item.recomputedResultsHash || item.storedResultsHash !== item.recomputedResultsHash))
      || (item.reasonCode === 'result-mismatch' && (!item.recomputedResultsHash || item.storedResultsHash === item.recomputedResultsHash))
      || (value.status === 'passed' && item.status !== 'passed')
      || item.status !== value.status || item.reasonCode !== value.reasonCode) context.addIssue({ code: 'custom', message: 'inconsistent replay analysis evidence' })
  }
})
export type MonitoringReplayVerificationV1 = z.infer<typeof MonitoringReplayVerificationV1>

export const EngineeringProjectCreateRequest = RevisionMutationV1.extend({
  name: z.string().min(1).max(200), taskType: EngineeringTaskTypeV1.optional(), taskContext: EngineeringTaskContextV1.optional(), monitoringType: z.string().optional(), unit: z.string().optional(), signConvention: z.string().optional(),
  thresholds: z.record(z.string(), z.number().finite()).optional(), reportPeriod: z.object({ start: z.string().optional(), end: z.string().optional() }).strict().optional(), workspace: z.string().min(1)
}).strict()
export const EngineeringProjectUpdateRequest = RevisionMutationV1.extend({
  name: z.string().min(1).max(200).optional(), taskType: EngineeringTaskTypeV1.optional(), taskContext: EngineeringTaskContextV1.optional(), monitoringType: z.string().min(1).optional(), unit: z.string().min(1).optional(), signConvention: z.string().min(1).optional(),
  thresholds: z.record(z.string(), z.number().finite()).optional(), reportPeriod: z.object({ start: z.string().optional(), end: z.string().optional() }).strict().optional()
}).strict()
export const DatasetImportRequest = RevisionMutationV1.extend({ projectId: z.string().min(1), attachmentId: z.string().optional(), name: z.string().min(1).optional(), dataBase64: z.string().min(1).optional(), fieldMapping: FieldMappingV1.optional() }).strict().refine((v) => Boolean(v.attachmentId || (v.name && v.dataBase64)), { message: 'attachmentId or name/dataBase64 is required' })
export const DatasetValidateRequest = RevisionMutationV1.extend({ datasetId: z.string().min(1) }).strict()
export const AcceptQualityFindingRequest = RevisionMutationV1.extend({ datasetId: z.string().min(1), findingId: z.string().min(1) }).strict()
export const AnalysisRequest = RevisionMutationV1.extend({ projectId: z.string().min(1), datasetId: z.string().min(1) }).strict()
export const ChartRequest = RevisionMutationV1.extend({ analysisId: z.string().min(1), chartType: z.string().default('trend') }).strict()
const DeliveryInputs = {
  projectId: z.string().min(1),
  // With no monitoring dataset, expectedRevision refers to the project.
  datasetId: z.string().min(1).optional(),
  analysisId: z.string().min(1).optional(),
  citations: z.array(KnowledgeCitationV1).default([]),
  adjustmentIds: z.array(z.string().min(1)).max(100).default([]),
  deformationIds: z.array(z.string().min(1)).max(100).default([])
}
const hasDeliveryInputs = (value: { datasetId?: string; analysisId?: string; adjustmentIds: string[]; deformationIds: string[] }): boolean =>
  Boolean(value.datasetId || (!value.analysisId && (value.adjustmentIds.length || value.deformationIds.length)))
const deliveryInputsError = { message: 'a monitoring dataset or selected survey results are required; analysisId requires datasetId' }
export const ReportPreviewRequest = RevisionMutationV1.extend(DeliveryInputs).strict().refine(hasDeliveryInputs, deliveryInputsError)
export const FinalizeDeliverableRequest = RevisionMutationV1.extend({ ...DeliveryInputs, acknowledgeWarnings: z.boolean().default(false) }).strict().refine(hasDeliveryInputs, deliveryInputsError)
export const RunMutationRequest = RevisionMutationV1.extend({}).strict()
export type DatasetImportRequest = z.infer<typeof DatasetImportRequest>
