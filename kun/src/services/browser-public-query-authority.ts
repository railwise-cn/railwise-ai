import { createHash } from 'node:crypto'
import { BrowserPublicQueryAuthorization, browserVerificationPolicy, type BrowserExecutionScope } from '../contracts/browser-skill.js'
import type { ExecutionGrant } from '../contracts/permissions.js'
import type { OperationReceipt, TaskRun } from '../contracts/tasks.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const publicQueryPurposeHash = (task: Pick<TaskRun, 'goal'>) => operationFingerprint({ purpose: task.goal })
export const publicQueryRequirementHash = (task: Pick<TaskRun, 'acceptance'>) => operationFingerprint({ requirement: task.acceptance.schedule })

/** A real binding receipt grants this capability. Neither policy, model arguments nor page text does. */
export function taskPublicQueryAuthority(repository: TaskRunRepository, task: TaskRun, scope: BrowserExecutionScope,
  options: { sourceTaskId?: string; historical?: boolean } = {}) {
  const parsed = BrowserPublicQueryAuthorization.safeParse(scope.publicQueryAuthorization)
  if (!parsed.success || scope.interaction !== 'interact') return undefined
  const authorization = parsed.data
  let source = options.sourceTaskId ? repository.get(options.sourceTaskId) : task
  let binding: OperationReceipt | undefined
  const seen = new Set<string>()
  while (source && !seen.has(source.id) && seen.size < 32) {
    seen.add(source.id)
    binding = repository.operations(source.id, 'browser_binding').find(receipt => receipt.id === authorization.receiptId)
    if (binding) break
    if (options.sourceTaskId || !source.parentTaskId) return undefined
    if (!options.historical && (source.authority?.revokedAt || operationFingerprint(source.authority?.browserScope?.publicQueryAuthorization) !== operationFingerprint(authorization))) return undefined
    source = repository.get(source.parentTaskId)
  }
  if (!source || !binding || binding.status !== 'succeeded') return undefined
  const request = object(binding.request), result = object(binding.result)
  if (request.confirmed !== true || request.publicQueryAuthorization !== authorization.duration || request.interaction !== 'interact' ||
    request.browserInstanceId !== scope.browserInstanceId || request.expectedBrowserRevision !== scope.revision ||
    result.taskId !== source.id || result.browserInstanceId !== scope.browserInstanceId || result.browserRevision !== scope.revision ||
    result.interaction !== 'interact' || typeof result.purpose !== 'string' ||
    operationFingerprint({ purpose: result.purpose }) !== authorization.purposeHash ||
    operationFingerprint(result.publicQueryAuthorization) !== operationFingerprint(authorization) ||
    operationFingerprint(request.origins) !== operationFingerprint(result.origins) || !Array.isArray(result.origins) ||
    scope.origins.some(origin => !(result.origins as unknown[]).includes(origin)) ||
    browserVerificationPolicy(result.verificationPolicy) !== browserVerificationPolicy(scope.verificationPolicy)) return undefined
  if (!options.historical) {
    const sourceScope = source.authority?.browserScope, currentScope = task.authority?.browserScope
    if (source.authority?.revokedAt || task.authority?.revokedAt || publicQueryPurposeHash(source) !== authorization.purposeHash ||
      operationFingerprint(sourceScope?.publicQueryAuthorization) !== operationFingerprint(authorization) ||
      operationFingerprint(currentScope?.publicQueryAuthorization) !== operationFingerprint(authorization) ||
      sourceScope?.browserInstanceId !== scope.browserInstanceId || sourceScope.revision !== scope.revision || sourceScope.interaction !== 'interact' ||
      browserVerificationPolicy(sourceScope.verificationPolicy) !== browserVerificationPolicy(scope.verificationPolicy) ||
      currentScope?.browserInstanceId !== scope.browserInstanceId || currentScope.revision !== scope.revision || currentScope.interaction !== 'interact' ||
      browserVerificationPolicy(currentScope.verificationPolicy) !== browserVerificationPolicy(scope.verificationPolicy) ||
      scope.origins.some(origin => !sourceScope.origins.includes(origin) || !currentScope.origins.includes(origin)) ||
      authorization.duration === 'task' && (task.scheduledBy || ['completed', 'failed', 'cancelled'].includes(source.status)) ||
      authorization.duration === 'schedule' && (!source.acceptance.schedule || publicQueryRequirementHash(source) !== authorization.requirementHash)) return undefined
  }
  return { source, binding, authorization }
}

export function taskPublicQueryGrant(repository: TaskRunRepository, grant: ExecutionGrant, task: TaskRun, now = Date.now()) {
  if (!grant.browserScope || grant.taskId !== task.id || grant.threadId !== task.threadId || grant.turnId !== task.activeTurnId ||
    task.authority?.revokedAt || !['running', 'waiting_approval'].includes(task.status) ||
    grant.expiresAt && Date.parse(grant.expiresAt) <= now) return undefined
  return taskPublicQueryAuthority(repository, task, grant.browserScope, { sourceTaskId: grant.browserScheduleBinding?.sourceTaskId })
}

export type PublicQueryActionRule = 'search_input' | 'search_trigger' | 'pagination' | 'filter_control' | 'sort_control'
export type ScopeActionBinding = { taskId: string; sessionId: string; browserInstanceId: string; browserRevision: number;
  pageUrl: string; origin: string; elementHash: string; valueHash?: string; action: 'click' | 'fill'; verificationPolicy?: 'strict' | 'public_query_target' }

/** Every exact action has its own evidence; this is not a fabricated human approval. */
export function saveTaskPublicQueryAction(repository: TaskRunRepository, grant: ExecutionGrant, binding: ScopeActionBinding,
  contextId: string, rule: PublicQueryActionRule, summary: string | ((requestHash: string) => string), now = Date.now()) {
  const task = repository.get(binding.taskId), authority = task && taskPublicQueryGrant(repository, grant, task, now)
  if (!authority) return undefined
  const expiresAt = new Date(Math.min(now + 15 * 60_000, Date.parse(grant.expiresAt ?? new Date(now + 15 * 60_000).toISOString()))).toISOString()
  const request = { ...binding, sourceTaskId: authority.source.id, turnId: grant.turnId, grantId: grant.id,
    scopeAuthorizationReceiptId: authority.binding.id, ...(grant.browserScheduleBinding ? { binding: grant.browserScheduleBinding } : {}), purposeHash: authority.authorization.purposeHash,
    ...(authority.authorization.requirementHash ? { requirementHash: authority.authorization.requirementHash } : {}),
    contextHash: createHash('sha256').update(contextId).digest('hex'), rule,
    verificationPolicy: browserVerificationPolicy(binding.verificationPolicy) }
  const id = operationFingerprint(request), key = `browser-scope-action:${id}`, nowIso = new Date(now).toISOString()
  const result = { id, authorizationSource: 'task_scope', scopeAuthorizationReceiptId: authority.binding.id, sourceTaskId: authority.source.id,
    expiresAt, accountState: 'unknown', access: 'public_query', verificationPolicy: request.verificationPolicy, summary: typeof summary === 'function' ? summary(createHash('sha256').update(JSON.stringify(request)).digest('hex')) : summary }
  return repository.transact(() => {
    const receipt = repository.beginOperation({ ownerId: binding.taskId, idempotencyKey: key, kind: 'browser_scope_action_authorization', request, nowIso }).receipt
    repository.finishOperation(binding.taskId, key, { status: 'succeeded', result }, nowIso)
    const derivedRequest = { ...request, actionId: id, scopeActionReceiptId: receipt.id }
    const derivedKey = `browser-derived-scope-action:${operationFingerprint(derivedRequest)}`
    repository.beginOperation({ ownerId: binding.taskId, idempotencyKey: derivedKey, kind: 'browser_derived_action_authorization', request: derivedRequest, nowIso })
    repository.finishOperation(binding.taskId, derivedKey, { status: 'succeeded', result: { ...result, scopeActionReceiptId: receipt.id } }, nowIso)
    return { receipt: repository.operation(binding.taskId, key)!, result, authority }
  })
}

/** Historical source checks survive later rebinding/revocation; creation rechecks live authority separately. */
export function verifiedTaskPublicQueryAction(repository: TaskRunRepository, original: OperationReceipt, dispatch: OperationReceipt, historical = false) {
  const grant = object(original.request?.executionGrant) as ExecutionGrant, task = repository.get(original.ownerId)
  if (!task || !grant.browserScope || grant.taskId !== original.ownerId || grant.threadId !== task.threadId ||
    grant.turnId !== original.request?.turnId || dispatch.request?.turnId !== grant.turnId) return undefined
  const authority = taskPublicQueryAuthority(repository, task, grant.browserScope, { historical, sourceTaskId: grant.browserScheduleBinding?.sourceTaskId })
  if (!authority) return undefined
  const receipt = repository.operations(task.id, 'browser_scope_action_authorization').find(item => item.id === dispatch.request?.scopeActionReceiptId)
  const request = object(receipt?.request), result = object(receipt?.result)
  if (!receipt || receipt.status !== 'succeeded' || receipt.fingerprint !== operationFingerprint(request) || result.id !== operationFingerprint(request) ||
    request.purposeHash !== authority.authorization.purposeHash || request.requirementHash !== authority.authorization.requirementHash ||
    result.sourceTaskId !== authority.source.id || result.verificationPolicy !== browserVerificationPolicy(grant.browserScope.verificationPolicy) || result.authorizationSource !== 'task_scope' || result.access !== 'public_query' || result.accountState !== 'unknown' ||
    request.scopeAuthorizationReceiptId !== authority.binding.id || result.scopeAuthorizationReceiptId !== authority.binding.id ||
    request.taskId !== task.id || request.sourceTaskId !== authority.source.id || request.grantId !== grant.id ||
    request.turnId !== grant.turnId || operationFingerprint(request.binding) !== operationFingerprint(grant.browserScheduleBinding) || typeof result.summary !== 'string' ||
    dispatch.request?.scopeAuthorizationReceiptId !== authority.binding.id ||
    ['action', 'sessionId', 'pageUrl', 'elementHash', 'valueHash', 'browserInstanceId', 'browserRevision', 'verificationPolicy', 'contextHash'].some(key => request[key] !== dispatch.request?.[key])) return undefined
  return { authority, receipt, request, result }
}
