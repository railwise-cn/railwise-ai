import type { TaskRun } from '../contracts/tasks.js'
import type { TaskRunRepository } from './task-run-repository.js'
import { operationFingerprint } from './task-run-repository.js'

export type TaskProgressProjection = {
  taskId: string
  taskRevision: number
  turnId: string
  executionId: string
  leaseRevision: number
  leaseExpiresAt: string
  active: boolean
  sampledAt: string
  timing?: { executionMs: number; queuedMs: number; humanWaitMs: number; pausedMs: number; sampledAt: string; coverage: 'complete' | 'partial' }
  activity?: { phase: 'thinking' | 'searching' | 'reading' | 'writing' | 'verifying' | 'working' }
}

/** Display-only observations of the current Host attempt. Never reads model text or raw arguments. */
export function projectTaskProgress(repository: TaskRunRepository, task: TaskRun, now: number, timing?: TaskProgressProjection['timing']): TaskProgressProjection | null {
  const attempt = repository.execution.latestAttempt(task.id), lease = repository.getLease(task.id)
  const session = repository.execution.sessionForTask(task.id)
  if (!task.activeTurnId || !Number.isSafeInteger(task.revision) || task.revision < 0 || !['running', 'retrying'].includes(task.status) || !attempt || !attempt.executionId ||
    !session || session.id !== attempt.sessionId || session.threadId !== task.threadId || attempt.taskId !== task.id || attempt.turnId !== task.activeTurnId ||
    !lease || lease.ownerId !== attempt.ownerId || lease.revision !== attempt.leaseRevision || !Number.isFinite(Date.parse(lease.expiresAt))) return null
  const result: TaskProgressProjection = { taskId: task.id, taskRevision: task.revision, turnId: task.activeTurnId, executionId: attempt.executionId,
    leaseRevision: lease.revision, leaseExpiresAt: lease.expiresAt, active: attempt.status === 'running' && Date.parse(lease.expiresAt) > now,
    sampledAt: new Date(now).toISOString(), ...(timing ? { timing } : {}) }
  if (!result.active) return result
  const tool = repository.operations(task.id, 'tool').reverse().find(receipt => receipt.status === 'running' &&
    receipt.fingerprint === operationFingerprint(receipt.request) && receipt.request?.dispatchTracking === 'host-v1' &&
    receipt.request.executionId === attempt.executionId && receipt.request.turnId === attempt.turnId)
  let phase: NonNullable<TaskProgressProjection['activity']>['phase'] = 'working'
  if (tool) {
    const provider = tool.request?.providerId, name = tool.request?.toolName
    if (provider === 'browser-skill') {
      if (['browser_get_html', 'browser_observe'].includes(String(name))) phase = 'reading'
      else if (['browser_navigate', 'browser_click', 'browser_fill', 'browser_session_start'].includes(String(name))) phase = 'searching'
    } else if (provider === 'managed-artifacts') {
      if (name === 'publish_artifact') phase = 'writing'
      else if (name === 'read_artifact' || name === 'verify_web_artifact') phase = 'verifying'
    }
  } else if (repository.listRuntimeSpans({ taskId: task.id, turnId: attempt.turnId, limit: 30 }).some(span =>
    span.kind === 'model' && span.status === 'running' && Date.parse(span.startedAt) >= Date.parse(attempt.startedAt))) phase = 'thinking'
  result.activity = { phase }
  return result
}
