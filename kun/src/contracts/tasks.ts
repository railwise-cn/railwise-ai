import { z } from 'zod'
import { WorkspaceReferenceSchema } from './workspace-references.js'
import type { ContextBundle, HandoffPacket } from './task-context.js'

export const TaskRunStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'waiting_user',
  'waiting_approval',
  'retrying',
  'stalled',
  'completed',
  'failed',
  'cancelled'
])
export type TaskRunStatus = z.infer<typeof TaskRunStatusSchema>

export const TaskNodeKindSchema = z.enum(['plan', 'execute', 'verify', 'deliver'])
export const TaskNodeStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
  'blocked'
])

export const TaskArtifactSchema = z.object({
  id: z.string().min(1),
  relativePath: z.string().min(1),
  mediaType: z.string().optional(),
  format: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().optional(),
  validation: z.enum(['pending', 'valid', 'invalid']),
  validationMessage: z.string().optional(),
  createdAt: z.string().min(1)
})
export type TaskArtifact = z.infer<typeof TaskArtifactSchema>

export const TaskAcceptanceSchema = z.object({
  kind: z.enum(['answer', 'files']),
  requiredNodeKinds: z.array(TaskNodeKindSchema),
  requiredFormats: z.array(z.string().min(1)).optional(),
  minimumArtifacts: z.number().int().nonnegative().optional(),
  requireFinalResponse: z.boolean(),
  requireActionableArtifactCard: z.boolean()
})
export type TaskAcceptance = z.infer<typeof TaskAcceptanceSchema>

export const TaskNodeSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  kind: TaskNodeKindSchema,
  title: z.string().min(1),
  status: TaskNodeStatusSchema,
  dependsOn: z.array(z.string()),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
  progressFingerprint: z.string().optional(),
  evidence: z.array(z.string()),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  revision: z.number().int().nonnegative()
})
export type TaskNode = z.infer<typeof TaskNodeSchema>

export const TaskCheckpointSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  completedNodeIds: z.array(z.string()),
  pendingNodeIds: z.array(z.string()),
  artifactIds: z.array(z.string()),
  eventSequence: z.number().int().nonnegative(),
  resumeSummary: z.string(),
  progressFingerprint: z.string().optional(),
  executionId: z.string().optional(),
  consumedInputIds: z.array(z.string()).optional(),
  sessionItemId: z.string().optional(),
  sessionHash: z.string().optional(),
  createdAt: z.string().min(1),
  revision: z.number().int().nonnegative()
})
export type TaskCheckpoint = z.infer<typeof TaskCheckpointSchema>

export const TaskAuthoritySchema = z.object({
  source: z.enum(['user', 'inherited', 'legacy']),
  workspaceRoot: z.string().min(1),
  toolAllowlist: z.array(z.string()).optional(),
  mcpAllowlist: z.array(z.string()).optional(),
  approvalPolicy: z.string().optional(),
  sandboxMode: z.string().optional(),
  externalTargets: z.array(z.string()).default([]),
  grantedAt: z.string(),
  revokedAt: z.string().optional()
})
export type TaskAuthority = z.infer<typeof TaskAuthoritySchema>

export const TaskInputSchema = z.object({
  id: z.string().min(1), taskId: z.string().min(1),
  kind: z.enum(['supplement', 'user_answer', 'tool_result', 'handoff']),
  text: z.string().min(1), idempotencyKey: z.string().min(1),
  sourceId: z.string().optional(), createdAt: z.string(), deliveredAt: z.string().optional(), consumedAt: z.string().optional()
  ,attachmentIds: z.array(z.string().min(1)).max(32).optional()
  ,workspaceReferences: z.array(WorkspaceReferenceSchema).max(32).optional()
})
export type TaskInput = z.infer<typeof TaskInputSchema>

export const AttentionItemSchema = z.object({
  id: z.string().min(1), ownerKind: z.enum(['task', 'flow']), ownerId: z.string().min(1),
  taskId: z.string().optional(), threadId: z.string().optional(), requestId: z.string().optional(),
  workspaceRoot:z.string().optional(),flowId:z.string().optional(),flowRunId:z.string().optional(),nodeId:z.string().optional(),
  kind: z.enum(['question', 'approval', 'conflict', 'blocked']),
  title: z.string(), message: z.string(),
  status: z.enum(['pending', 'answered', 'cancelled', 'expired']),
  revision: z.number().int().nonnegative(), createdAt: z.string(), updatedAt: z.string(),
  payload: z.record(z.string(), z.unknown()).optional()
})
export type AttentionItem = z.infer<typeof AttentionItemSchema>

export const OperationReceiptSchema = z.object({
  id: z.string(), ownerId: z.string(), idempotencyKey: z.string(), fingerprint: z.string(), kind: z.string(),
  status: z.enum(['prepared', 'running', 'succeeded', 'failed', 'outcome_unknown']),
  request: z.record(z.string(), z.unknown()).optional(), result: z.unknown().optional(),
  createdAt: z.string(), updatedAt: z.string(), error: z.string().optional()
})
export type OperationReceipt = z.infer<typeof OperationReceiptSchema>

export type RuntimeOutboxItem = {
  id: string; ownerId: string; kind: string; payload: Record<string, unknown>;
  createdAt: string; deliveredAt?: string; attempts: number
}

export type TaskAssignment = {
  id: string; parentTaskId: string; childTaskId: string; goal: string;
  acceptance: string[]; authority: TaskAuthority; sessionId: string;
  handoff?: HandoffPacket
}

export const TaskRunSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  activeTurnId: z.string().optional(),
  originThreadId: z.string().optional(),
  executionSessionId: z.string().optional(),
  visibility: z.enum(['task', 'internal', 'chat']).optional(),
  parentTaskId: z.string().optional(),
  rootTaskId: z.string().optional(),
  retryOfTaskId: z.string().optional(),
  flowRunId: z.string().optional(),
  flowId: z.string().optional(),
  templateId: z.string().optional(),
  authority: TaskAuthoritySchema.optional(),
  executionMs: z.number().nonnegative().optional(),
  executionStartedAt: z.string().optional(),
  childTaskIds: z.array(z.string()),
  workspaceRoot: z.string().min(1),
  repositoryRoot: z.string().optional(),
  goal: z.string().min(1),
  status: TaskRunStatusSchema,
  acceptance: TaskAcceptanceSchema,
  agentId: z.string().min(1),
  model: z.string().optional(),
  providerId: z.string().trim().min(1).max(200).optional(),
  engineeringPlanId: z.string().min(1).max(200).optional(),
  reasoningEffort: z.enum(['auto', 'off', 'low', 'medium', 'high', 'max']).optional(),
  budget: z.object({
    maxAttempts: z.number().int().positive(),
    maxDurationMs: z.number().int().positive(),
    version: z.literal(2).optional(),
    maxExecutionMs: z.number().int().positive().optional(),
    maxElapsedMs: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional()
  }),
  attempts: z.number().int().nonnegative(),
  replans: z.number().int().nonnegative(),
  noProgressCount: z.number().int().nonnegative(),
  nodes: z.array(TaskNodeSchema),
  artifacts: z.array(TaskArtifactSchema),
  finalResponse: z.string().optional(),
  stalledReason: z.string().optional(),
  waitingReason: z.string().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  finishedAt: z.string().optional(),
  revision: z.number().int().nonnegative()
})
export type TaskRun = z.infer<typeof TaskRunSchema>

export type TaskLease = {
  taskId: string
  ownerId: string
  acquiredAt: string
  expiresAt: string
  revision: number
}

export type TaskEvent = {
  taskId: string
  sequence: number
  eventKey: string
  kind: string
  payload: Record<string, unknown>
  createdAt: string
}

export type TaskAttemptOutcome =
  | { kind: 'candidate'; finalResponse?: string }
  | { kind: 'retryable'; code: string; message: string }
  | { kind: 'waiting_user'; message: string }
  | { kind: 'waiting_approval'; message: string }
  | { kind: 'failed'; code: string; message: string }
  | { kind: 'cancelled'; reason: string }

export const ShellSessionSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  nodeId: z.string().min(1),
  workspaceRoot: z.string().min(1),
  commandSummary: z.string(),
  pid: z.number().int().positive().optional(),
  processFingerprint: z.string().optional(),
  processGroup: z.number().int().positive().optional(),
  ownerId: z.string().optional(),
  executionId: z.string().optional(),
  cancelRequestedAt: z.string().optional(),
  cwd: z.string().min(1),
  status: z.enum(['starting', 'running', 'completed', 'failed', 'terminated', 'interrupted', 'outcome_unknown']),
  exitCode: z.number().int().optional(),
  outputPath: z.string().min(1),
  outputBytes: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  revision: z.number().int().nonnegative()
})
export type ShellSession = z.infer<typeof ShellSessionSchema>

export const RuntimeSpanSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  parentSpanId: z.string().min(1).optional(),
  kind: z.enum(['task', 'turn', 'model', 'tool', 'mcp', 'child-task', 'shell', 'validation', 'document']),
  name: z.string().min(1).max(256),
  status: z.enum(['running', 'ok', 'error', 'cancelled']),
  startedAt: z.string().min(1),
  finishedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  retryCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheHit: z.boolean().optional(),
  model: z.string().max(256).optional(),
  errorCode: z.string().max(256).optional(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
})
export type RuntimeSpan = z.infer<typeof RuntimeSpanSchema>
