import { createHash } from 'node:crypto'
import type { TaskApprovalGrant } from '../contracts/permissions.js'
import type { TaskRun } from '../contracts/tasks.js'
import type { TaskRunRepository } from './task-run-repository.js'
import type { CapabilityPreflight } from '../contracts/harness.js'
import { EGO_SITE_SIGN_IN_REQUIRED } from '../contracts/ego-browser.js'
import { workspacePermissionCapability } from './workspace-write-preflight.js'

export const EGO_PERMISSION_CODES = [EGO_SITE_SIGN_IN_REQUIRED,'ego_browser_user_control','ego_browser_grant_expired','ego_browser_scope_required','ego_browser_executable_changed','ego_browser_task_space_unconfirmed','ego_browser_task_space_missing','ego_browser_task_space_ambiguous','ego_browser_origin_denied','ego_browser_read_failed','ego_browser_command_failed','ego_browser_command_timeout','ego_browser_protocol_invalid','ego_browser_finish_unconfirmed'] as const
const permissionCodes = new Set([...EGO_PERMISSION_CODES,'task_permission_expired', 'task_permission_revoked', 'task_permission_consumed', 'task_permission_blocked',
  'execution_grant_expired', 'execution_grant_revoked', 'execution_grant_scope', 'workspace_trust_changed', 'approval_policy_blocked',
  'sandbox_read_only', 'sandbox_write_blocked', 'workspace_path_blocked', 'network_scope_blocked',
  'browser_public_query_recovery_changed', 'browser_public_query_fresh_scope_required', 'browser_binding_changed',
  'browser_schedule_authority_changed', 'schedule_authority_changed'])
export type TaskPermissionFailure = { code: string; message: string }
export function taskPermissionFailure(error: unknown): TaskPermissionFailure | null {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return permissionCodes.has(code) ? { code, message: error instanceof Error ? error.message : '请重新核对当前任务权限。' } : null
}

/** Preserve the failed authority's own review surface; a browser proof is not a workspace grant. */
export function taskPermissionCapability(failure:TaskPermissionFailure,task:Pick<TaskRun,'scheduledBy'|'publicQueryRecovery'>,
  checkedAt=new Date().toISOString()):CapabilityPreflight {
  const {code}=failure
  let provider:CapabilityPreflight['provider'],resolution:NonNullable<CapabilityPreflight['resolution']>,summary:string
  if (code === EGO_SITE_SIGN_IN_REQUIRED) {
    provider = 'ego-browser'
    resolution = { kind: 'retry', route: 'task/ego-browser-site-sign-in', label: '登录后继续' }
    summary = '大单网要求重新登录。请在 Ego 中完成登录，再回到原对话继续。'
  } else if((EGO_PERMISSION_CODES as readonly string[]).includes(code)) {
    provider='ego-browser'
    resolution={kind:'retry',route:'task/ego-browser-review',label:'查看当前任务并检查Ego连接'}
    summary='Ego只读连接、任务范围或用户控制状态需要核对。请处理后继续原任务；原TaskSpace与资料已保留，不会另建空间或重放业务操作。'
  } else if(code==='browser_binding_changed') {
    provider='browser-skill'
    resolution={kind:'grant',route:'task/browser-binding',label:'确认当前任务的浏览器范围'}
    summary='浏览器实例或连接配置已变化。请审阅当前任务的浏览器和站点范围，确认后继续原任务。'
  } else if(code==='browser_schedule_authority_changed'||code==='schedule_authority_changed') {
    provider='schedule'
    const scheduleId=task.scheduledBy?.scheduleId??task.publicQueryRecovery?.scheduleId
    resolution=scheduleId?{kind:'grant',route:`flow/${scheduleId}`,label:'查看并核对定时计划'}
      :{kind:'retry',route:'task/schedule-review',label:'继续原任务并审阅周期动作'}
    summary='计划的浏览器或授权范围已变化，请审阅定时计划后继续。'
  } else if(code==='browser_public_query_recovery_changed'||code==='browser_public_query_fresh_scope_required') {
    provider='browser-skill'
    resolution={kind:'grant',route:'task/public-query-recovery',label:'查看原任务的恢复范围'}
    summary='公开查询恢复范围需要重新核对。请在原任务中审阅浏览器和公开站点范围，再单独确认是否继续。'
  } else return {...workspacePermissionCapability(code,failure.message),checkedAt}
  return {provider,status:code==='browser_binding_changed'?'needs_authorization':'blocked',errorCode:code,
    message:failure.message===code?summary:failure.message,credentialState:'unknown',networkState:'unknown',workspaceState:'unknown',
    sandboxState:'allowed',approvalState:code===EGO_SITE_SIGN_IN_REQUIRED?'not_required':'required',action:resolution,resolution,checkedAt}
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
