import { createHash } from 'node:crypto'
import type { TaskApprovalGrant } from '../contracts/permissions.js'
import type { TaskRun } from '../contracts/tasks.js'
import type { TaskRunRepository } from './task-run-repository.js'

const permissionCodes = new Set(['task_permission_expired', 'task_permission_revoked', 'task_permission_consumed', 'task_permission_blocked',
  'execution_grant_expired', 'execution_grant_revoked', 'execution_grant_scope', 'workspace_trust_changed', 'approval_policy_blocked',
  'sandbox_read_only', 'sandbox_write_blocked', 'workspace_path_blocked', 'network_scope_blocked'])
export function taskPermissionFailure(error: unknown): { code: string; message: string } | null {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return permissionCodes.has(code) ? { code, message: error instanceof Error ? error.message : '请重新核对当前任务权限。' } : null
}

/** Recognize only the old pre-model expiry failure, using its immutable execution ledger.
 * No counters, receipts, historical work spans or authorization are rewritten.
 */
export function recoverablePermissionFailure(repository: TaskRunRepository, task: TaskRun, now: string): boolean {
  if (task.status !== 'failed' || task.parentTaskId || task.retryOfTaskId || task.authority?.revokedAt || !task.activeTurnId || task.budget.version !== 2) return false
  const root = repository.get(task.rootTaskId ?? task.id) ?? task
  if (repository.execution.usedExecutionMs(root.id, Date.parse(now)) >= (root.budget.maxExecutionMs ?? root.budget.maxDurationMs) ||
    root.budget.maxElapsedMs && Date.parse(now) - Date.parse(root.createdAt) >= root.budget.maxElapsedMs ||
    root.budget.maxCostUsd && repository.execution.usedCost(root.id) >= root.budget.maxCostUsd) return false
  const message = '当前任务的临时审批权限已到期，请重新确认后重查原任务。'
  const fingerprint = `turn_attempt_exception:${createHash('sha256').update(message).digest('hex').slice(0, 16)}`
  const terminal = repository.events(task.id).filter(event => event.kind === 'task_failed').at(-1)
  if (!terminal || terminal.eventKey !== `failed:${task.attempts}:${fingerprint}` || terminal.payload.reason !== message || terminal.payload.attempt !== task.attempts || terminal.createdAt !== task.finishedAt ||
    task.nodes.some(node => node.status !== 'completed' && (node.progressFingerprint !== fingerprint || node.errorCode !== 'attempt_budget_exhausted'))) return false
  const attempts = repository.execution.attempts(task.id).filter(attempt => attempt.turnId === task.activeTurnId)
  if (!attempts.length || attempts.some(attempt => attempt.status === 'running' || !attempt.finishedAt || !Number.isFinite(Date.parse(attempt.startedAt)) || !Number.isFinite(Date.parse(attempt.finishedAt)))) return false
  const grants: Array<TaskApprovalGrant | undefined> = [task.authority?.taskApprovalGrant,
    ...repository.operations(task.id, 'task_permission').filter(receipt => receipt.status === 'succeeded')
      .map(receipt => (receipt.result as { task?: TaskRun } | undefined)?.task?.authority?.taskApprovalGrant)]
  const originalGrant = grants.filter((grant): grant is TaskApprovalGrant => Boolean(grant && grant.taskId === task.id && grant.threadId === task.threadId &&
    Number.isFinite(Date.parse(grant.expiresAt)) && Date.parse(grant.confirmedAt) < Date.parse(attempts[0]!.startedAt))).sort((a, b) => Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt))[0]
  if (!originalGrant || Date.parse(originalGrant.expiresAt) > Date.parse(attempts[0]!.startedAt) || Date.parse(originalGrant.confirmedAt) >= Date.parse(originalGrant.expiresAt)) return false
  // Even a zero-duration model/tool work span disqualifies the legacy recovery.
  if (attempts.some(attempt => repository.connection().prepare('SELECT 1 FROM task_work_spans WHERE execution_id=? LIMIT 1').get(attempt.executionId))) return false
  if (repository.operations(task.id).some(receipt => (receipt.turnId ?? receipt.request?.turnId) === task.activeTurnId && ['tool', 'host_shell', 'browser_action_dispatch', 'browser_session'].includes(receipt.kind))) return false
  if (repository.unsettledOperations(task.id).some(receipt => ['tool', 'host_shell', 'browser_action_dispatch', 'browser_session'].includes(receipt.kind)) ||
    repository.operations(task.id).some(receipt => ['browser_action_dispatch', 'browser_session'].includes(receipt.kind) && (receipt.status === 'prepared' || (receipt.result as { readbackPending?: boolean } | undefined)?.readbackPending === true)) ||
    repository.listShellSessions(task.id).some(session => ['running', 'starting', 'outcome_unknown'].includes(session.status))) return false
  return true
}
