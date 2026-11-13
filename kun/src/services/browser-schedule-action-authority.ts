import { createHash } from 'node:crypto'
import { BrowserScheduleActionSchema, BrowserScheduleBindingSchema, type BrowserScheduleAction, type BrowserScheduleResolution } from '../contracts/browser-schedule-actions.js'
import type { BrowserExecutionScope } from '../contracts/browser-skill.js'
import type { TaskRun } from '../contracts/tasks.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import type { TaskRunRepository } from './task-run-repository.js'

const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
function fail(code: string): never { throw Object.assign(new Error(code), { code }) }
type Candidate = Omit<BrowserScheduleAction, 'approvalId' | 'summary'>
export type BrowserActionTarget = {
  action: 'click' | 'fill'; pageUrl: string; elementHash: string; valueHash?: string
}
export type BrowserActionBinding = BrowserActionTarget & { sessionId: string; taskId: string }

export function listApprovedBrowserScheduleActions(repository: TaskRunRepository, task: TaskRun): BrowserScheduleAction[] {
  if (!task.acceptance.schedule || task.authority?.revokedAt) return []
  const browser = task.authority?.browserScope
  return repository.operations(task.id, 'browser_schedule_action_authorization').flatMap(receipt => {
    const parsed = BrowserScheduleActionSchema.safeParse(receipt.result)
    if (receipt.status !== 'succeeded' || !parsed.success || receipt.request?.revoked === true) return []
    const action = parsed.data
    if (action.sourceTaskId !== task.id || action.scheduleId !== `schedule_${task.id}` || action.purposeHash !== hash(task.goal) ||
      action.requirementHash !== hash(task.acceptance.schedule) || browser && (browser.interaction !== 'interact' ||
      action.browserInstanceId !== browser.browserInstanceId || action.browserRevision !== browser.revision || !browser.origins.includes(action.origin))) return []
    return [action]
  }).sort((a, b) => a.id.localeCompare(b.id))
}

/** A continuous approval stays with its plan. Each occurrence gets a separate short-lived receipt. */
export class BrowserScheduleActionAuthority {
  constructor(private readonly options: { repository: TaskRunRepository; resolveSchedule?: (context: ToolHostContext, sourceActionId?: string) => Promise<BrowserScheduleResolution | undefined> }) {}

  prepare(taskId: string, scope: BrowserExecutionScope, target: BrowserActionTarget): Candidate {
    const task = this.options.repository.get(taskId)
    if (!task || task.scheduledBy || task.parentTaskId || !task.acceptance.schedule || task.authority?.revokedAt ||
      !['running', 'waiting_approval'].includes(task.status) || scope.interaction !== 'interact') fail('browser_schedule_authorization_unavailable')
    const url = new URL(target.pageUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !scope.origins.includes(url.origin) ||
      [...url.searchParams.keys()].some(key => /token|secret|password|authorization|session|oauth/i.test(key))) fail('browser_schedule_public_query_required')
    const fields = { sourceTaskId: taskId, scheduleId: `schedule_${taskId}`, purposeHash: hash(task.goal), requirementHash: hash(task.acceptance.schedule),
      browserInstanceId: scope.browserInstanceId, browserRevision: scope.revision, origin: url.origin,
      ...target, accountState: 'unknown' as const, access: 'public_query' as const }
    return { id: hash(fields), ...fields }
  }

  save(candidate: Candidate, approvalId: string, summary: string): BrowserScheduleAction {
    const result = BrowserScheduleActionSchema.parse({ ...candidate, approvalId, summary })
    const key = `browser-schedule-action:${candidate.id}`
    const prior = this.options.repository.operation(candidate.sourceTaskId, key)
    if (prior?.request?.revoked === true) fail('browser_schedule_authorization_revoked')
    if (prior?.status === 'succeeded') return BrowserScheduleActionSchema.parse(prior.result)
    this.options.repository.transact(() => {
      this.options.repository.beginOperation({ ownerId: candidate.sourceTaskId, idempotencyKey: key, kind: 'browser_schedule_action_authorization', request: candidate, nowIso: new Date().toISOString() })
      this.options.repository.finishOperation(candidate.sourceTaskId, key, { status: 'succeeded', result })
    })
    return result
  }

  async derive(target: BrowserActionBinding, context: ToolHostContext): Promise<boolean> {
    const captured = context.executionGrant?.browserScheduleBinding
    if (!captured) return false
    let resolved: BrowserScheduleResolution | undefined
    try { resolved = await this.options.resolveSchedule?.(context) }
    catch (error) { fail((error as { code?: string }).code === 'browser_schedule_outcome_unknown' ? 'browser_schedule_outcome_unknown' : 'browser_schedule_authority_changed') }
    if (!resolved || JSON.stringify(BrowserScheduleBindingSchema.parse(resolved.binding)) !== JSON.stringify(BrowserScheduleBindingSchema.parse(captured)) || context.executionGrant?.scheduleScopeHash !== captured.scopeHash ||
      hash(resolved.actions) !== captured.actionsHash) fail('browser_schedule_action_scope_changed')
    const unresolved = this.options.repository.operations(captured.sourceTaskId, 'browser_schedule_action_outcome')
      .some(receipt => receipt.status === 'outcome_unknown' && receipt.request?.scheduleId === captured.scheduleId)
    if (unresolved) fail('browser_schedule_outcome_unknown')
    const scope = context.executionGrant!.browserScope!
    const matched = resolved.actions.find(action => action.action === target.action && action.pageUrl === target.pageUrl &&
      action.elementHash === target.elementHash && action.valueHash === target.valueHash && action.browserInstanceId === scope.browserInstanceId &&
      action.browserRevision === scope.revision && scope.origins.includes(action.origin) && action.accountState === 'unknown' && action.access === 'public_query')
    if (!matched) fail('browser_schedule_action_scope_changed')
    const expiry = Math.min(Date.now() + 15 * 60_000, Date.parse(context.executionGrant!.expiresAt ?? new Date(Date.now() + 15 * 60_000).toISOString()))
    if (expiry <= Date.now()) fail('execution_grant_expired')
    const request = { ...target, binding: captured, actionId: matched.id, grantId: context.executionGrant!.id, turnId: context.turnId }
    const key = `browser-derived-action:${hash(request)}`
    const prior = this.options.repository.operation(target.taskId, key)
    if (prior?.status === 'outcome_unknown') fail('browser_schedule_outcome_unknown')
    const previousExpiry = Date.parse((prior?.result as { expiresAt?: string } | undefined)?.expiresAt ?? '')
    if (prior?.status !== 'succeeded' || !Number.isFinite(previousExpiry) || previousExpiry <= Date.now()) {
      this.options.repository.transact(() => {
        this.options.repository.beginOperation({ ownerId: target.taskId, idempotencyKey: key, kind: 'browser_derived_action_authorization', request, nowIso: new Date().toISOString() })
        this.options.repository.finishOperation(target.taskId, key, { status: 'succeeded', result: { expiresAt: new Date(expiry).toISOString(), sourceApprovalId: matched.approvalId, accountState: 'unknown' } })
      })
    }
    return true
  }

  recordUnknown(context: ToolHostContext, action: 'click' | 'fill'): void {
    const source = context.executionGrant?.taskId ? this.options.repository.get(context.executionGrant.taskId) : null
    const approvedSource = source && !source.scheduledBy && listApprovedBrowserScheduleActions(this.options.repository, source).some(item => item.action === action)
    const binding = context.executionGrant?.browserScheduleBinding ?? (approvedSource ? { sourceTaskId: source.id, scheduleId: `schedule_${source.id}` } : undefined)
    if (!binding) return
    const key = `browser-schedule-outcome:${binding.scheduleId}:${context.executionGrant!.taskId}:${context.turnId}:${action}`
    this.options.repository.transact(() => {
      this.options.repository.beginOperation({ ownerId: binding.sourceTaskId, idempotencyKey: key, kind: 'browser_schedule_action_outcome',
        request: { ...binding, taskId: context.executionGrant!.taskId, turnId: context.turnId, action }, nowIso: new Date().toISOString() })
      this.options.repository.finishOperation(binding.sourceTaskId, key, { status: 'outcome_unknown', error: '页面动作结果需要核验，周期授权不能自动重放。' })
    })
  }
}
