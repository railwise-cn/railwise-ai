import { z } from 'zod'
import { StartTurnRequest } from './turns.js'
import type { TaskInput, TaskRun } from './tasks.js'
import type { StartTurnResponse } from './turns.js'
import type { CapabilityPreflight } from './harness.js'

export const ProcessIdentitySchema = z.object({ pid: z.number().int().positive(), fingerprint: z.string().min(1) })
export type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>
export const ExecutionSessionSchema = z.object({
  id: z.string(), taskId: z.string(), threadId: z.string(), originThreadId: z.string(),
  assignmentId: z.string().optional(), visibility: z.enum(['task', 'internal', 'legacy']),
  createdAt: z.string(), updatedAt: z.string(), revision: z.number().int().nonnegative()
})
export type ExecutionSession = z.infer<typeof ExecutionSessionSchema>
export const ExecutionTokenSchema = z.object({
  taskId: z.string(), sessionId: z.string(), executionId: z.string(), turnId: z.string(),
  ownerId: z.string(), leaseRevision: z.number().int().nonnegative(), process: ProcessIdentitySchema
})
export type ExecutionToken = z.infer<typeof ExecutionTokenSchema>
export const ExecutionAttemptSchema = ExecutionTokenSchema.extend({
  status: z.enum(['running', 'completed', 'cancelled', 'lost', 'outcome_unknown']),
  startedAt: z.string(), finishedAt: z.string().optional()
})
export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>
export const InputDeliverySchema = z.object({
  id: z.string(), inputId: z.string(), taskId: z.string(), sessionId: z.string(), sequence: z.number().int().positive(),
  status: z.enum(['queued', 'delivered', 'consumed']), messageItemId: z.string(),
  sessionItemId:z.string().optional(),sessionHash:z.string().optional(),
  deliveredAt: z.string().optional(), consumedAt: z.string().optional(), checkpointId: z.string().optional()
})
export type InputDelivery = z.infer<typeof InputDeliverySchema>
export const TaskCommandSchema = z.object({
  threadId: z.string().min(1), taskId: z.string().min(1).optional(),
  intent: z.enum(['auto', 'status', 'supplement', 'new', 'chat', 'pause', 'resume', 'cancel']).default('auto'),
  idempotencyKey: z.string().trim().min(1).max(256), expectedRevision: z.number().int().nonnegative().optional(),
  resolveAttentionId: z.string().min(1).optional(),
  request: StartTurnRequest
})
export type TaskCommand = z.input<typeof TaskCommandSchema>
export type TaskCommandResult = (
  | { kind: 'snapshot'; task: TaskRun | null }
  | { kind: 'input_queued'; task: TaskRun; input: TaskInput }
  | { kind:'task_updated';action:'pause'|'cancel';task:TaskRun }
  | { kind: 'task_started' | 'chat_started'; task?: TaskRun; turn: StartTurnResponse }
  | { kind: 'attention_required'; task?: TaskRun; message: string; attentionId?: string }
  | { kind: 'capability_required'; task?: TaskRun; attentionId?: string; capability: CapabilityPreflight; message: string }
) & { receipt?: {userMessageItemId:string;resultMessageItemId:string} }
