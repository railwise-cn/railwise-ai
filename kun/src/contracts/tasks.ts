import { z } from 'zod'

export const TaskRunStatusSchema = z.enum([
  'queued',
  'running',
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
  createdAt: z.string().min(1),
  revision: z.number().int().nonnegative()
})
export type TaskCheckpoint = z.infer<typeof TaskCheckpointSchema>

export const TaskRunSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  activeTurnId: z.string().optional(),
  parentTaskId: z.string().optional(),
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
  cwd: z.string().min(1),
  status: z.enum(['starting', 'running', 'completed', 'failed', 'terminated', 'interrupted']),
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
