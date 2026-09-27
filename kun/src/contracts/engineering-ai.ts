import { EngineeringTaskContextV1, EngineeringProjectUpdateRequest } from './engineering.js'
import { z } from 'zod'

export const EngineeringAiSchemaVersion = 1 as const

export const EngineeringProjectSuggestionPatchV1 = EngineeringProjectUpdateRequest.omit({ expectedRevision: true, idempotencyKey: true })
  .refine(value => Object.keys(value).length > 0, 'at least one project field is required')
  .refine(value => JSON.stringify(value).length <= 12000, 'project suggestion is too large')
export const EngineeringProjectSuggestionRequestV1 = z.object({
  reason: z.string().trim().min(1).max(2000), patch: EngineeringProjectSuggestionPatchV1
}).strict()
export const EngineeringProjectSuggestionV1 = z.object({
  schemaVersion: z.literal(1), id: z.string(), threadId: z.string(), projectId: z.string(),
  expectedRevision: z.number().int().positive(), contextHash: z.string(),
  reason: z.string(), patch: EngineeringProjectSuggestionPatchV1,
  before: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'applied', 'rejected', 'stale']),
  createdAt: z.string(), updatedAt: z.string(), appliedRevision: z.number().int().positive().optional()
}).strict()
export type EngineeringProjectSuggestionV1 = z.infer<typeof EngineeringProjectSuggestionV1>

export const EngineeringAiThreadMetaV1 = z.object({
  schemaVersion: z.literal(EngineeringAiSchemaVersion),
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  workspace: z.string().min(1),
  projectRevision: z.number().int().positive(),
  contextHash: z.string().min(1),
  updatedAt: z.string().min(1)
}).strict()
export type EngineeringAiThreadMetaV1 = z.infer<typeof EngineeringAiThreadMetaV1>

/**
 * Current admission evidence for an immutable historical adjustment.  A valid
 * result is not automatically eligible for a new computation, deformation
 * comparison, or formal deliverable after its source changes.
 */
export const EngineeringSurveyAdjustmentAdmissionV1 = z.object({
  status: z.enum(['current-admissible', 'historical-non-admissible']),
  rawSourceIntegrity: z.object({
    status: z.enum(['verified', 'legacy-unverified', 'failed']),
    ledgerEntryCount: z.number().int().nonnegative(),
    errors: z.array(z.string().min(1)).max(20)
  }).strict(),
  sourceEligibility: z.object({
    eligible: z.boolean(),
    findings: z.array(z.object({
      code: z.string(), severity: z.string(), message: z.string(), suggestion: z.string().optional()
    }).strict()).max(20)
  }).strict()
}).strict()
export type EngineeringSurveyAdjustmentAdmissionV1 = z.infer<typeof EngineeringSurveyAdjustmentAdmissionV1>

export const EngineeringContextSnapshotV1 = z.object({
  schemaVersion: z.literal(EngineeringAiSchemaVersion),
  projectId: z.string().min(1),
  projectRevision: z.number().int().positive(),
  contextHash: z.string().min(1),
  generatedAt: z.string().min(1),
  project: z.object({
    name: z.string(), taskType: z.string().optional(), taskContext: EngineeringTaskContextV1.optional(), monitoringType: z.string(), unit: z.string(),
    reportPeriod: z.object({ start: z.string().optional(), end: z.string().optional() }).strict(),
    thresholds: z.record(z.string(), z.number())
  }).strict(),
  datasets: z.array(z.object({
    id: z.string(), sourceFileName: z.string(), sourceFileHash: z.string(),
    rowCount: z.number().int().nonnegative(), observationCount: z.number().int().nonnegative(),
    status: z.string(), revision: z.number().int().positive(), findings: z.array(z.object({
      code: z.string(), severity: z.string(), status: z.string(), message: z.string(), row: z.number().int().positive().optional()
    }).strict()).max(200)
  }).strict()).max(20),
  analyses: z.array(z.object({ id: z.string(), datasetId: z.string(), algorithmVersion: z.string(), resultCount: z.number().int().nonnegative(), inputHash: z.string() }).strict()).max(20),
  runs: z.array(z.object({ id: z.string(), status: z.string(), datasetId: z.string().optional(), analysisId: z.string().optional(), revision: z.number().int().nonnegative(), updatedAt: z.string() }).strict()).max(20),
  surveyNetworks: z.array(z.object({
    id: z.string(), networkType: z.string(), transformType: z.string().optional(),
    coordinateSystem: z.string(), verticalDatum: z.string(), pointCount: z.number().int().nonnegative(),
    observationCount: z.number().int().nonnegative(), qualityStatus: z.string(), revision: z.number().int().positive(),
    inputAttachmentHash: z.string().optional(), observationEpoch: z.string().optional()
  }).strict()).max(20).default([]),
  surveyAdjustments: z.array(z.object({
    id: z.string(), networkId: z.string(), status: z.string(), revision: z.number().int().positive(),
    strategyId: z.string().optional(), algorithmVersion: z.string(), inputHash: z.string(),
    validation: z.string().optional(), observationCount: z.number().int().nonnegative().optional(),
    unknownCount: z.number().int().nonnegative().optional(), degreesOfFreedom: z.number().int().nonnegative().optional(),
    sourceAdmission: EngineeringSurveyAdjustmentAdmissionV1
  }).strict()).max(20).default([]),
  citations: z.array(z.object({ id: z.string(), source: z.string(), sourceType: z.string(), locator: z.string().optional() }).strict()).max(100),
  watchDrafts: z.array(z.object({
    id: z.string(), projectId: z.string(), name: z.string(), expression: z.string(), enabled: z.boolean(), revision: z.number().int().positive(), updatedAt: z.string()
  }).strict()).max(20).default([])
}).strict()
export type EngineeringContextSnapshotV1 = z.infer<typeof EngineeringContextSnapshotV1>

export const EngineeringPlanRiskV1 = z.enum(['read', 'write', 'export', 'threshold', 'archive'])
/** Exact, read-only evidence selectors. Project ownership is resolved from the thread. */
export const EngineeringEvidenceSelectionV1 = z.object({
  networkId: z.string().min(1).max(200).optional(),
  networkRevision: z.number().int().positive().optional(),
  sourceSha256: z.string().min(1).max(100).optional(),
  adjustmentId: z.string().min(1).max(200).optional(),
  observationId: z.string().min(1).max(200).optional(),
  sourceRecordId: z.string().min(1).max(200).optional(),
  pointId: z.string().min(1).max(200).optional(),
  diagnosticIndex: z.number().int().nonnegative().optional(),
  manifestId: z.string().min(1).max(200).optional(),
  runId: z.string().min(1).max(200).optional(),
  outputSha256: z.string().min(1).max(100).optional()
}).strict()
export type EngineeringEvidenceSelectionV1 = z.infer<typeof EngineeringEvidenceSelectionV1>

export const EngineeringPlanParameterValueV1 = z.union([
  z.string().max(4000), z.number().finite(), z.boolean(), z.null(),
  z.array(z.union([z.string().max(4000), z.number().finite(), z.boolean()])).max(200)
])
export const EngineeringPlanParametersV1 = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(80), EngineeringPlanParameterValueV1)
export const EngineeringPlanParameterBindingV1 = z.object({
  parameter: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(80),
  stepId: z.string().min(1).max(80),
  output: z.enum(['network.id', 'network.revision', 'dataset.id', 'dataset.revision', 'analysis.id', 'run.id']),
  asArray: z.boolean().optional()
}).strict()

export const EngineeringPlanStepV1 = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  tool: z.string().min(1).max(120),
  risk: EngineeringPlanRiskV1,
  dependsOn: z.array(z.string().min(1)).max(32).default([]),
  inputHash: z.string().min(1),
  // Optional only for non-destructive reads of historical plans. New execution
  // requires complete, reviewed parameters and Runtime-owned effect metadata.
  parameters: EngineeringPlanParametersV1.optional(),
  parameterBindings: z.array(EngineeringPlanParameterBindingV1).max(32).optional(),
  expectedOutputs: z.array(z.string().min(1).max(100)).max(8).optional(),
  reversibility: z.enum(['read-only', 'revisioned-write', 'append-only']).optional(),
  approval: z.enum(['pending', 'approved', 'rejected']).default('pending')
}).strict()
export type EngineeringPlanStepV1 = z.infer<typeof EngineeringPlanStepV1>

export const EngineeringRunPlanV1 = z.object({
  schemaVersion: z.literal(EngineeringAiSchemaVersion),
  id: z.string().min(1),
  threadId: z.string().min(1),
  projectId: z.string().min(1),
  contextHash: z.string().min(1),
  requestHash: z.string().min(1).optional(),
  revision: z.number().int().positive(),
  goal: z.string().trim().min(1).max(4_000),
  steps: z.array(EngineeringPlanStepV1).min(1).max(32),
  status: z.enum(['draft', 'validating', 'awaiting_approval', 'approved', 'stale', 'started', 'queued', 'running', 'completed', 'failed', 'cancelled', 'needs_attention', 'rejected']),
  taskId: z.string().min(1).optional(),
  executionTurnId: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
}).strict()
export type EngineeringRunPlanV1 = z.infer<typeof EngineeringRunPlanV1>

/** Read-only projection from Runtime-owned successful step receipts. */
export const EngineeringPlanExecutionEvidenceV1 = z.object({
  complete: z.boolean(),
  completedStepIds: z.array(z.string().min(1)).max(32),
  pendingStepIds: z.array(z.string().min(1)).max(32)
}).strict()
export type EngineeringPlanExecutionEvidenceV1 = z.infer<typeof EngineeringPlanExecutionEvidenceV1>
export type EngineeringRunPlanViewV1 = EngineeringRunPlanV1 & { execution: EngineeringPlanExecutionEvidenceV1 }

export const EngineeringApprovalV1 = z.object({
  schemaVersion: z.literal(EngineeringAiSchemaVersion),
  planId: z.string().min(1),
  planRevision: z.number().int().positive(),
  contextHash: z.string().min(1),
  stepIds: z.array(z.string().min(1)).min(1).max(32),
  token: z.string().min(16),
  expiresAt: z.string().min(1)
}).strict()
export type EngineeringApprovalV1 = z.infer<typeof EngineeringApprovalV1>

export const EngineeringEvidenceCardV1 = z.object({
  schemaVersion: z.literal(EngineeringAiSchemaVersion),
  id: z.string().min(1),
  planId: z.string().min(1).optional(),
  kind: z.enum(['finding', 'metric', 'trend', 'citation', 'artifact', 'status']),
  title: z.string().min(1).max(200),
  summary: z.string().max(2_000),
  sourceHash: z.string().optional(),
  locator: z.string().optional(),
  createdAt: z.string().min(1)
}).strict()
export type EngineeringEvidenceCardV1 = z.infer<typeof EngineeringEvidenceCardV1>

export const EngineeringWatchRuleV1 = z.object({
  schemaVersion: z.literal(EngineeringAiSchemaVersion),
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).max(200),
  expression: z.string().min(1).max(500),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  updatedAt: z.string().min(1)
}).strict()
export type EngineeringWatchRuleV1 = z.infer<typeof EngineeringWatchRuleV1>
