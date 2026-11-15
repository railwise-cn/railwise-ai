import { publicQueryRecoveryForPlan, recoveryCoversReceipt, recoveryExecutionScope } from './browser-public-query-recovery-proof.js'
import type { BrowserPublicQueryRecoveryBinding } from '../contracts/browser-public-query-recovery.js'
import { createHash, randomUUID } from 'node:crypto'
import { BrowserExecutionScope, browserVerificationPolicy, type BrowserCapabilityConfig } from '../contracts/browser-skill.js'
import type { ExecutionGrant, ExecutionScope } from '../contracts/permissions.js'
import type { OperationReceipt, TaskRun } from '../contracts/tasks.js'
import type { FlowDefinitionV1 } from '../contracts/flow.js'
import { scheduleForRequirement, type ScheduleRequirement } from '../contracts/schedule.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { ThreadRecord } from '../contracts/threads.js'
import { createApprovalRequest } from '../domain/approval.js'
import { waitForApprovalDecision } from '../ports/approval-gate.js'
import type { FlowRuntimeService } from '../flow/service.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'
import type { TaskController } from './task-controller.js'
import type { TaskCoordinator } from './task-coordinator.js'
import type { WorkspaceTrustReader } from './workspace-trust-reader.js'
import { taskPublicQueryAuthority, taskPublicQueryGrant, verifiedTaskPublicQueryAction, verifiedTaskPublicQueryDocumentNavigation } from './browser-public-query-authority.js'
import { listApprovedBrowserScheduleActions } from './browser-schedule-action-authority.js'
import { BrowserScheduleActionSchema, type BrowserScheduleAction, type BrowserScheduleBinding } from '../contracts/browser-schedule-actions.js'
import { browserScheduleApprovalSummary, sanitizeBrowserApprovalSummary } from '../security/browser-approval-summary.js'
import { verifiedTaskRetryLineage } from './task-retry-lineage.js'
import { isTaskScheduleBridgeProvider, taskScheduleConnectorIdentities } from '../contracts/task-schedule-policy.js'

type ThreadAuthority = Pick<ThreadRecord, 'workspace' | 'agentId' | 'agentRevision' | 'agentProfile' | 'approvalPolicy' | 'sandboxMode' | 'mode'>
type RetiredBrowserActionEvidence = {
  dispatchReceiptId: string; toolReceiptId: string; retiredBindingReceiptId: string; currentBindingReceiptId: string; bindingLineageReceiptIds: string[]
  evidenceKind: 'historical_task_scope' | 'historical_exact_approval'; settlementReceiptId?: string
  authorizationReceiptId?: string; approvedScheduleActionId?: string; recordedScheduleActionId?: string; legacyActionLinkMismatch: boolean
}
type ScheduledTaskAuthority = {
  taskId: string
  threadId: string
  originThreadId: string
  model: string
  providerId?: string
  prompt: string
  requirement: ScheduleRequirement
  grant: ExecutionGrant
  execution: ThreadAuthority
  origin: ThreadAuthority
  sourceAuthorityHash: string
  scope: ExecutionScope
  authorization: { kind: 'requested_schedule' | 'confirmed_scope' | 'confirmed_task_scope'; sourceScopeReceiptId?: string; expiresAt: null; until: 'disabled'; scopeHash: string; approvalId?: string; receiptKey?: string }
}
export type ScheduledTaskDispatch = { scheduleId: string; versionId: string; dueAt: string }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Read-only projection, including for sealed legacy plans. Never rewrite the
 * saved Grant, its authority hash, or historical approval/operation records.
 */
function taskScheduleScope(scope: ExecutionScope): ExecutionScope {
  return { ...scope,
    ...(scope.allowedProviderIds ? { allowedProviderIds: scope.allowedProviderIds.filter(id => !isTaskScheduleBridgeProvider(id)) } : {}),
    ...(scope.connectorIdentityFingerprints ? { connectorIdentityFingerprints: taskScheduleConnectorIdentities(scope.connectorIdentityFingerprints) } : {}) }
}
function threadAuthority(thread: ThreadRecord): ThreadAuthority {
  return { workspace: thread.workspace, agentId: thread.agentId, agentRevision: thread.agentRevision, agentProfile: thread.agentProfile,
    approvalPolicy: thread.approvalPolicy, sandboxMode: thread.sandboxMode, mode: thread.mode }
}
function fail(message: string): never { throw Object.assign(new Error(message), { code: 'schedule_authority_changed' }) }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const browserOutput = (receipt: OperationReceipt) => record(record(record(receipt.result).item).output)
const validTimes = (...values: unknown[]): boolean => values.every(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))
function browserScopeRequired(detail: string): never {
  throw Object.assign(new Error(`${detail} 请重新观察目标，使用 browser_authorize_action 的 scope=schedule、scheduleAccess=public_query 审阅真实元素与精确输入，再保存计划。`), { code: 'browser_schedule_action_scope_required' })
}
function browserOutcomeUnknown(): never {
  throw Object.assign(new Error('浏览器操作结果尚未核验，请核验原操作结果后处理计划，不能自动重放或发布。'), { code: 'browser_schedule_outcome_unknown' })
}

/** Uses Flow's durable trigger/outbox while running each occurrence through the ordinary task harness. */
export class TaskScheduleService {
  constructor(private readonly deps: {
    flows: FlowRuntimeService; repository: TaskRunRepository; tasks: TaskController
    coordinator: TaskCoordinator; threads: ThreadStore; workspaceTrust: WorkspaceTrustReader
    connectorIdentities(): Record<string, string>; browserState?(): BrowserCapabilityConfig; nowIso(): string
  }) {}

  canCreate(context: ToolHostContext): boolean {
    const task = this.deps.tasks.activeTask(context.threadId)
    return Boolean(task?.acceptance.schedule && !task.scheduledBy)
  }

  async create(context: ToolHostContext) {
    const task = this.deps.tasks.activeTask(context.threadId)
    const grant = context.executionGrant
    if (!task?.acceptance.schedule || task.scheduledBy || !grant || grant.taskId !== task.id) fail('当前任务没有已明确的每日计划要求。')
    await context.validateExecutionGrant?.()
    const execution = await this.deps.threads.get(context.threadId)
    const origin = await this.deps.threads.get(task.originThreadId ?? context.threadId)
    if (!execution || !origin || execution.workspace !== origin.workspace) fail('原始对话与执行工作区不一致。')
    const permission = task.authority?.taskApprovalGrant
    if (task.authority?.revokedAt || permission?.revokedAt || permission && (permission.status !== 'active' || Date.parse(permission.expiresAt) <= Date.parse(this.deps.nowIso()))) fail('任务的临时权限已变化，请重新确认后建立计划。')
    const browserActions = listApprovedBrowserScheduleActions(this.deps.repository, task)
    const taskQuery = taskPublicQueryGrant(this.deps.repository, grant, task, Date.parse(this.deps.nowIso()))
    const scopedSchedule = taskQuery?.authorization.duration === 'schedule' ? taskQuery : undefined
    this.validateBrowserDispatches(task, browserActions)
    const scope: ExecutionScope = taskScheduleScope({ allowedToolNames: grant.allowedToolNames, allowedProviderIds: grant.allowedProviderIds,
      pathAllowlist: grant.pathAllowlist, readPathAllowlist: grant.readPathAllowlist, writePathAllowlist: grant.writePathAllowlist,
      networkAllowlist: grant.networkAllowlist, connectorScopes: grant.connectorScopes, externalTargets: grant.externalTargets,
      connectorIdentityFingerprints: grant.connectorIdentityFingerprints, connectorBackends: grant.connectorBackends, browserScope: grant.browserScope,
      ...(permission?.scope ? { permissionScope: permission.scope } : {}), ...(grant.workspaceWriteException ? { workspaceWriteException: true } : {}),
      ...(browserActions.length || scopedSchedule ? { browserScheduleActions: browserActions } : {}) })
    const scopeHash = fingerprint({ taskId: task.id, requirement: task.acceptance.schedule, scope, execution: threadAuthority(execution), origin: threadAuthority(origin) })
    let authority: ScheduledTaskAuthority = {
      taskId: task.id, threadId: context.threadId, originThreadId: task.originThreadId ?? context.threadId,
      model: task.model ?? context.model?.id ?? 'auto', providerId: task.providerId, prompt: task.goal, requirement: task.acceptance.schedule, grant,
      execution: threadAuthority(execution), origin: threadAuthority(origin), sourceAuthorityHash: fingerprint(task.authority ?? null), scope,
      authorization: { kind: scopedSchedule ? 'confirmed_task_scope' : 'requested_schedule', expiresAt: null, until: 'disabled', scopeHash,
        ...(scopedSchedule ? { sourceScopeReceiptId: scopedSchedule.binding.id } : {}) }
    }
    const source = this.planSource(task)
    const id = `schedule_${source.id}`
    const existing = this.deps.flows.get(id)
    let extendsBrowserActions = false
    if (existing) {
      const saved = this.authority(existing)
      if (task.retryOfTaskId) {
        await this.validateRetryPlan(task, saved, context, scope)
        return this.snapshot(existing)
      }
      if (saved.taskId !== task.id || fingerprint(saved.requirement) !== fingerprint(authority.requirement)) fail('已有计划与当前要求不同，请先更新原计划。')
      await this.validateAuthority(saved, browserActions)
      const previous = saved.scope.browserScheduleActions ?? []
      if (fingerprint(previous) === fingerprint(browserActions)) return this.snapshot(existing)
      if (browserActions.length <= previous.length || previous.some(action => !browserActions.some(candidate => fingerprint(candidate) === fingerprint(action)))) fail('已有浏览器动作范围已变化，请先核对原计划授权。')
      const { browserScheduleActions: _previousActions, ...previousScope } = taskScheduleScope(saved.scope)
      const { browserScheduleActions: _nextActions, ...nextScope } = scope
      if (fingerprint(previousScope) !== fingerprint(nextScope)) fail('重新保存浏览器动作不能扩大原计划的其他权限。')
      extendsBrowserActions = true
    }
    const authorizationKey = `schedule-authority:${id}:${scopeHash}`
    authority.authorization.receiptKey = authorizationKey
    const savedApproval = this.deps.repository.operation(task.id, authorizationKey)
    if (savedApproval) {
      const result = savedApproval.result as { authorityHash?: string; authority?: ScheduledTaskAuthority } | undefined
      const saved = result?.authority
      if (savedApproval.status !== 'succeeded' || savedApproval.kind !== 'schedule_authority' ||
        savedApproval.request?.scopeHash !== scopeHash || !saved || fingerprint(saved) !== result?.authorityHash ||
        saved.authorization.scopeHash !== scopeHash || fingerprint(saved.scope) !== fingerprint(scope) ||
        saved.taskId !== task.id || saved.sourceAuthorityHash !== authority.sourceAuthorityHash) fail('计划范围确认尚未核验，不能重复提交。')
      await this.validateAuthority(saved)
      authority = saved
    }
    if (!savedApproval && (permission?.scope || grant.workspaceWriteException || !scopedSchedule && (extendsBrowserActions || browserActions.length))) {
      const schedule = scheduleForRequirement(authority.requirement)
      const browser = this.deps.browserState?.()
      const label = browser?.browsers.find(item => item.id === grant.browserScope?.browserInstanceId)
      const browserSummary = browserActions.length && schedule.kind === 'daily' ? browserScheduleApprovalSummary({
        purpose: task.goal, times: schedule.times, timezone: schedule.timezone,
        readPaths: scope.readPathAllowlist ?? scope.pathAllowlist ?? [], writePaths: scope.writePathAllowlist ?? scope.pathAllowlist ?? [],
        origins: scope.browserScope?.origins ?? [], browserLabel: label?.label || label?.name || '已选择的浏览器实例',
        actions: browserActions, scopeHash
      }) : undefined
      const approval = createApprovalRequest({ id: `appr_schedule_${randomUUID()}`, threadId: context.threadId, turnId: context.turnId,
        toolName: 'schedule_task', requestHash: scopeHash,
        summary: browserSummary ?? `确认此任务的持续计划权限\n任务 ${task.id}\n执行时间 ${JSON.stringify(schedule)}\n工作区 ${grant.workspaceRoot}\n读取路径 ${JSON.stringify(scope.readPathAllowlist ?? scope.pathAllowlist)}\n写入路径 ${JSON.stringify(scope.writePathAllowlist ?? scope.pathAllowlist)}\n网络来源 ${JSON.stringify(scope.networkAllowlist)}\n连接器及目标 ${JSON.stringify({ providers: scope.allowedProviderIds, targets: scope.externalTargets })}\n此范围按计划持续至禁用计划或撤销原任务权限。原临时权限仍按其到期时间结束。` })
      const decision = await waitForApprovalDecision(() => context.awaitApproval(approval), context.abortSignal)
      if (decision !== 'allow') fail('持续计划权限未获确认，尚未建立周期任务。')
      await context.validateExecutionGrant?.()
      authority.authorization = { ...authority.authorization, kind: 'confirmed_scope', approvalId: approval.id }
    }
    const browserHistory = await this.validateAuthority(authority)
    if (existing && this.deps.flows.get(id)?.revision !== existing.revision) fail('计划在确认期间已变化，请核对最新版本后重试。')
    if (!savedApproval) this.deps.repository.transact(() => {
      this.deps.repository.beginOperation({ ownerId: task.id, idempotencyKey: authorizationKey, kind: 'schedule_authority', request: { scopeHash }, nowIso: this.deps.nowIso() })
      this.deps.repository.finishOperation(task.id, authorizationKey, { status: 'succeeded', result: { authorityHash: fingerprint(authority), authority,
        ...(browserHistory.length ? { retiredBrowserActions: browserHistory } : {}) } }, this.deps.nowIso())
    })
    const policy = { timeoutMs: 120000, retryAttempts: 0, retryBackoffMs: 1000, errorBehavior: 'fail' as const, concurrencyLimit: 1, resumable: true, breakpoint: false }
    this.deps.flows.repository.transaction(() => {
      if (existing) {
        this.deps.flows.update({ ...existing, variables: { ...existing.variables, taskSchedule: authority } }, existing.revision)
      } else {
        this.deps.flows.create({ schemaVersion: 1, id, name: task.goal.slice(0, 80), description: '按已授权任务范围定时执行',
          nodes: [{ id: 'schedule', type: 'schedule_trigger', label: '每日计划', position: { x: 120, y: 120 }, bindings: {}, config: scheduleForRequirement(authority.requirement), policy, disabled: false }],
          edges: [], variables: { enabled: true, taskSchedule: authority }, workspace: grant.workspaceRoot })
      }
      const published = this.deps.flows.publish(id)
      if (!published.published) throw new Error(published.validation.issues.map(issue => issue.message).join('\n'))
    })
    return this.snapshot(this.deps.flows.get(id)!)
  }

  async readback(context: ToolHostContext) {
    const task = this.deps.tasks.activeTask(context.threadId)
    if (!task) fail('当前任务不存在。')
    const source = this.planSource(task)
    const flows = this.deps.flows.list().filter(flow => flow.id === `schedule_${source.id}` && flow.workspace === context.workspace)
    const schedules = []
    for (const flow of flows) {
      const authority = this.authority(flow)
      if (task.retryOfTaskId) await this.validateRetryPlan(task, authority, context)
      else await this.validateAuthority(authority)
      schedules.push(this.snapshot(flow))
    }
    const key = `schedule-readback:${fingerprint(schedules)}`
    this.deps.repository.beginOperation({ ownerId: task.id, idempotencyKey: key, kind: 'schedule_readback', request: { schedules, ...(task.retryOfTaskId ? { retrySourceTaskId: source.id, taskAuthorityHash: fingerprint(task.authority ?? null) } : {}) }, nowIso: this.deps.nowIso() })
    this.deps.repository.finishOperation(task.id, key, { status: 'succeeded', result: { schedules } }, this.deps.nowIso())
    return { schedules }
  }

  assessCompletion(task: TaskRun): { reason: string; fingerprint: string; retryable?: boolean } | null {
    if (!task.acceptance.schedule || task.scheduledBy) return null
    let source: TaskRun
    try { source = this.planSource(task) } catch { return { reason: '重试来源尚未核验，请核对原任务记录。', fingerprint: 'schedule:retry-lineage', retryable: false } }
    const flow = this.deps.flows.get(`schedule_${source.id}`)
    if (flow) try { this.validateConnectorBindings(this.authority(flow)) } catch (error) {
      return { reason: error instanceof Error ? error.message : '计划连接器授权需要重新核对。',
        fingerprint: `schedule-authority:${fingerprint({ connectors: this.deps.connectorIdentities(), browser: this.deps.browserState?.() })}`, retryable: false }
    }
    const current = flow ? this.snapshot(flow) : undefined
    const verified = current?.enabled && current.nextRunAt && fingerprint(current.requirement) === fingerprint(task.acceptance.schedule) &&
      fingerprint(current.schedule) === fingerprint(scheduleForRequirement(task.acceptance.schedule)) &&
      this.deps.repository.operations(task.id, 'schedule_readback').some(receipt => receipt.status === 'succeeded' &&
        (!task.retryOfTaskId || receipt.request?.retrySourceTaskId === source.id && receipt.request.taskAuthorityHash === fingerprint(task.authority ?? null)) &&
        fingerprint((receipt.result as { schedules?: unknown[] })?.schedules) === fingerprint([current]))
    return verified ? null : { reason: '请用 schedule_task 建立本任务的每日计划，再用 list_schedules 读回并核对执行时刻、时区和下一次执行时间。', fingerprint: `schedule:${fingerprint(current ?? task.acceptance.schedule)}` }
  }

  async executionScope(task: TaskRun): Promise<ExecutionScope | undefined> {
    if (!task.scheduledBy) return undefined
    const scope = await this.executionScopeForThread(task.threadId)
    const prepared = this.deps.repository.operation(task.threadId, 'scheduled-task-context')
    if (!scope || prepared?.request?.scheduleId !== task.scheduledBy.scheduleId || prepared?.request?.dueAt !== task.scheduledBy.dueAt) fail('周期任务缺少对应的持久授权。')
    return scope
  }

  /** This record is written only by the server's coordinator hook, before admission. */
  async executionScopeForThread(threadId: string): Promise<ExecutionScope | undefined> {
    const prepared = this.deps.repository.operation(threadId, 'scheduled-task-context')
    if (!prepared) return undefined
    if (prepared.status !== 'succeeded') fail('周期执行上下文尚未完成准备。')
    const flow = this.deps.flows.get(String(prepared.request?.scheduleId))
    if (!flow || flow.variables.archived === true || flow.variables.enabled === false || flow.publishedVersionId !== prepared.request?.versionId) fail('计划已禁用或范围已变化。')
    const authority = this.authority(flow)
    await this.validateAuthority(authority,undefined,undefined,this.recoveryForAuthority(authority))
    const thread = await this.deps.threads.get(threadId)
    if (!thread || thread.status === 'deleted' || fingerprint(threadAuthority(thread)) !== fingerprint(authority.execution) || prepared.request?.authorityHash !== fingerprint(authority)) fail('周期执行的 Agent 或权限已变化。')
    const actions = authority.scope.browserScheduleActions
    return { ...taskScheduleScope(authority.scope), ...(this.recoveryForAuthority(authority)?{browserPublicQueryRecovery:this.recoveryForAuthority(authority)}:{}), scheduleScopeHash: authority.authorization.scopeHash,
      ...(actions?.length || authority.scope.browserScope?.publicQueryAuthorization?.duration === 'schedule' ? { browserScheduleBinding: {
        scheduleId: flow.id, versionId: flow.publishedVersionId!, scopeHash: authority.authorization.scopeHash,
        sourceTaskId: authority.taskId, actionsHash: fingerprint(actions ?? [])
      } } : {}) }
  }

  /** A provider may derive a short action grant only from this server-owned occurrence. */
  async resolveBrowserActions(context: ToolHostContext, sourceActionId?: string): Promise<{ binding: BrowserScheduleBinding; actions: BrowserScheduleAction[] } | undefined> {
    const grant = context.executionGrant
    if (!grant?.taskId || !grant.browserScheduleBinding && !sourceActionId) return undefined
    const task = this.deps.repository.get(grant.taskId)
    if (!task || task.threadId !== context.threadId || task.activeTurnId !== context.turnId ||
      !['running', 'waiting_approval'].includes(task.status)) fail('计划浏览器动作不属于当前有效执行。')
    if (sourceActionId && !grant.browserScheduleBinding) {
      const scoped = grant.browserScope && taskPublicQueryAuthority(this.deps.repository, task, grant.browserScope)
      const scopeSource = scoped?.authorization.duration === 'schedule' && scoped.binding.id === sourceActionId
      if (task.scheduledBy || !scopeSource && !listApprovedBrowserScheduleActions(this.deps.repository, task).some(action => action.id === sourceActionId)) fail('当前任务的持续动作授权已变化。')
      const flow = this.deps.flows.get(`schedule_${this.planSource(task).id}`)
      if (!flow) return undefined
      if (flow.variables.archived === true || flow.variables.enabled === false || !flow.publishedVersionId) fail('计划已停用，当前任务的计划动作授权不再可用。')
      if (task.retryOfTaskId) await this.validateRetryPlan(task, this.authority(flow), context)
      else await this.validateAuthority(this.authority(flow), undefined, context)
      return undefined
    }
    const scope = await this.executionScope(task)
    if (!scope?.browserScheduleBinding || fingerprint(scope.browserScheduleBinding) !== fingerprint(grant.browserScheduleBinding) ||
      scope.scheduleScopeHash !== grant.scheduleScopeHash || fingerprint(scope.browserScope) !== fingerprint(grant.browserScope)) fail('周期浏览器动作的计划或执行授权已变化。')
    return { binding: scope.browserScheduleBinding, actions: scope.browserScheduleActions ?? [] }
  }

  async dispatch(input: ScheduledTaskDispatch): Promise<void> {
    const current = this.deps.flows.get(input.scheduleId)
    if (!current || current.variables.archived === true || current.variables.enabled === false) return
    const version = this.deps.flows.repository.getVersion(input.versionId)
    if (!version || current.publishedVersionId !== input.versionId) fail('计划配置已变化，请核对待执行计划。')
    const authority = this.authority(version.definition)
    const attentionId = `schedule:${input.scheduleId}`
    const pending = this.deps.repository.attention(attentionId)
    // Legacy items did not store versionId. Only the original durable dispatch
    // outbox may prove their version; a matching name or current Flow is insufficient.
    const pendingVersion = pending?.payload?.versionId ?? (pending && this.deps.flows.repository.pendingOutbox('scheduled_task_dispatch').some(item => {
      const payload = record(item.payload)
      return item.ownerId === input.scheduleId && payload.scheduleId === input.scheduleId && payload.dueAt === input.dueAt && payload.versionId === input.versionId
    }) ? input.versionId : undefined)
    const matchingPending = pending?.status === 'pending' && pending.ownerKind === 'flow' && pending.ownerId === input.scheduleId &&
      pending.flowId === input.scheduleId && pending.threadId === authority.originThreadId && pending.payload?.scheduleId === input.scheduleId &&
      pending.payload.dueAt === input.dueAt && pendingVersion === input.versionId
    try {
      const recovery=this.recoveryForAuthority(authority)
      await this.validateAuthority(authority,undefined,undefined,recovery)
      const result = await this.deps.coordinator.command({ threadId: authority.originThreadId, intent: 'new',
        idempotencyKey: `schedule:${input.scheduleId}:${input.dueAt}`,
        request: { prompt: authority.prompt, model: authority.model, providerId: authority.providerId, mode: 'agent' }
      }, { prepareExecutionThread: async thread => {
        if (thread.workspace !== authority.execution.workspace) fail('周期执行工作区与原授权不一致。')
        const prepared = this.deps.repository.beginOperation({ ownerId: thread.id, idempotencyKey: 'scheduled-task-context', kind: 'scheduled_task_prepare',
          request: { ...input, authorityHash: fingerprint(authority) }, nowIso: this.deps.nowIso() })
        if (prepared.receipt.status === 'succeeded') {
          await this.executionScopeForThread(thread.id)
          return
        }
        if (thread.turns.length) fail('已存在执行记录的对话不能重新绑定周期权限。')
        await this.deps.threads.upsert({ ...thread, ...authority.execution, updatedAt: this.deps.nowIso() })
        this.deps.repository.finishOperation(thread.id, 'scheduled-task-context', { status: 'succeeded', result: { prepared: true } }, this.deps.nowIso())
      }, prepareTask: task => {
        if (task.scheduledBy) return
        this.deps.repository.update(task.id, task.revision, value => {
          const { schedule: _schedule, ...acceptance } = value.acceptance
          return { ...value, ...(recovery?{publicQueryRecovery:recovery}:{}), scheduledBy: { scheduleId: input.scheduleId, dueAt: input.dueAt },
            ...(authority.scope.browserScope ? { authority: { ...value.authority!, browserScope: authority.scope.browserScope } } : {}),
            acceptance: { ...acceptance,
              ...(authority.scope.browserScope && acceptance.requiresWebEvidence && !acceptance.requiredSourceOrigins?.length
                ? { requiredSourceOrigins: authority.scope.browserScope.origins } : {}) } }
        }, { key: `scheduled:${input.dueAt}`, kind: 'scheduled_task_created', payload: input, createdAt: this.deps.nowIso() })
      } })
      if (result.kind === 'task_started' && matchingPending) this.deps.repository.transact(() => {
        const latest = this.deps.repository.attention(attentionId), flow = this.deps.flows.get(input.scheduleId)
        if (!latest || latest.status !== 'pending' || latest.revision !== pending.revision || fingerprint(latest) !== fingerprint(pending) ||
          !flow || flow.variables.archived === true || flow.variables.enabled === false || flow.publishedVersionId !== input.versionId ||
          this.deps.flows.repository.getTriggerState(input.scheduleId, 'schedule')?.enabled !== true) return
        this.deps.repository.putAttention({ ...latest, status: 'answered', revision: latest.revision + 1, updatedAt: this.deps.nowIso() })
      })
    } catch (error) {
      const now = this.deps.nowIso()
      this.deps.repository.transact(() => {
        const previous = this.deps.repository.attention(attentionId), flow = this.deps.flows.get(input.scheduleId)
        if (!flow || flow.variables.archived === true || flow.variables.enabled === false || flow.publishedVersionId !== input.versionId ||
          previous && (previous.ownerKind !== 'flow' || previous.ownerId !== input.scheduleId || previous.flowId !== input.scheduleId)) return
        const previousCreated = previous ? Date.parse(previous.createdAt) : undefined
        const createdAt = previous?.status === 'pending' ? previous.createdAt
          : previousCreated !== undefined && Number.isFinite(previousCreated) && Date.parse(now) <= previousCreated ? new Date(previousCreated + 1).toISOString() : now
        this.deps.repository.putAttention({ id: attentionId, ownerKind: 'flow', ownerId: input.scheduleId,
          flowId: input.scheduleId, threadId: authority.originThreadId, kind: 'blocked', title: '定时计划等待核对',
          message: error instanceof Error ? error.message : String(error), status: 'pending', revision: (previous?.revision ?? -1) + 1,
          createdAt, updatedAt: Date.parse(now) < Date.parse(createdAt) ? createdAt : now,
          payload: { scheduleId: input.scheduleId, versionId: input.versionId, dueAt: input.dueAt } })
      })
      throw error
    }
  }

  private validateBrowserDispatches(task: TaskRun, actions: BrowserScheduleAction[], currentContext?: ToolHostContext, recovery=currentContext?.executionGrant?.browserPublicQueryRecovery) {
    const receipts = this.deps.repository.operations(task.id)
    const currentOperationId = this.currentUndispatchedBrowserTool(task, receipts, currentContext)
    const dispatches = receipts.filter(receipt => receipt.kind === 'browser_action_dispatch')
    // Rebinding never settles an operation. Check every generation before
    // selecting the action evidence needed by the current forward plan.
    for (const receipt of receipts) {
      if(recoveryCoversReceipt(this.deps.repository,receipt,recovery))continue
      if (receipt.kind === 'browser_action_dispatch' && record(receipt.result).readbackPending === true &&
        !(receipt.status === 'outcome_unknown' && this.deps.repository.verifiedOperationResolution(receipt))) {
        throw Object.assign(new Error('浏览器已确认动作，但页面结果尚未读取，不能保存计划。请只读观察原页面。'), { code: 'browser_readback_blocked' })
      }
      const actionTool = receipt.kind === 'tool' && ['browser_click', 'browser_fill', 'browser_press'].includes(String(receipt.request?.toolName))
      const tracked = ['browser_session', 'browser_action_dispatch', 'browser_schedule_action_outcome'].includes(receipt.kind) || actionTool
      if (tracked && ['prepared', 'running', 'outcome_unknown'].includes(receipt.status) &&
        !(actionTool && receipt.status === 'prepared' && receipt.request?.dispatchTracking === 'host-v1') && receipt.id !== currentOperationId &&
        !this.deps.repository.verifiedOperationResolution(receipt)) browserOutcomeUnknown()
    }
    const retired = this.retiredBrowserDispatches(task, receipts)
    if (receipts.some(receipt => receipt.kind === 'browser_schedule_action_outcome' && receipt.status === 'outcome_unknown' && !this.deps.repository.verifiedOperationResolution(receipt) && !recoveryCoversReceipt(this.deps.repository,receipt,recovery))) browserOutcomeUnknown()
    const scopedMatches = (target: Record<string, unknown>) => {
      const dispatch = dispatches.find(item => fingerprint(item.request) === fingerprint(target))
      const original = dispatch && receipts.find(item => item.kind === 'tool' && item.request?.turnId === dispatch.request?.turnId && item.request?.toolName === dispatch.request?.toolName && item.request?.argumentsHash === dispatch.request?.argumentsHash)
      const scoped = original && dispatch && verifiedTaskPublicQueryAction(this.deps.repository, original, dispatch)
      if (scoped?.request.rule === 'result_link' || target.nativeAction !== undefined) {
        if (!original || !dispatch || !verifiedTaskPublicQueryDocumentNavigation(this.deps.repository, original, dispatch)) return false
      }
      return Boolean(scoped && scoped.authority.authorization.duration === 'schedule' &&
        (target.scheduleActionId === undefined || target.scheduleActionId === scoped.result.id))
    }
    const matches = (target: Record<string, unknown>) => {
      if (target.nativeAction !== undefined) return scopedMatches(target)
      const exact = receipts.find(item => item.id === target.authorizationReceiptId && item.kind === 'browser_action_authorization')
      const approvedId = record(exact?.result).scheduleActionId
      if (target.scheduleActionId !== undefined && approvedId !== undefined && target.scheduleActionId !== approvedId) return false
      return scopedMatches(target) || actions.some(action => action.action === target.action && action.pageUrl === target.pageUrl &&
        action.elementHash === target.elementHash && action.valueHash === target.valueHash && action.browserInstanceId === target.browserInstanceId &&
        action.browserRevision === target.browserRevision && browserVerificationPolicy(action.verificationPolicy) === browserVerificationPolicy(target.verificationPolicy))
    }
    for (const dispatch of dispatches) {
      if (retired.has(dispatch.id)||recoveryCoversReceipt(this.deps.repository,dispatch,recovery)) continue
      if (record(dispatch.result).readbackPending === true &&
        !(dispatch.status === 'outcome_unknown' && this.deps.repository.verifiedOperationResolution(dispatch))) {
        throw Object.assign(new Error('浏览器已确认动作，但页面结果尚未读取，不能保存计划。请只读观察原页面。'), { code: 'browser_readback_blocked' })
      }
      if (this.deps.repository.verifiedOperationResolution(dispatch)?.evidence.kind === 'human_confirmation') {
        if (!matches(dispatch.request ?? {})) browserScopeRequired('已核对的浏览器动作已离开持续授权范围。')
        continue
      }
      if (dispatch.status === 'failed') continue
      if (dispatch.status !== 'succeeded') browserOutcomeUnknown()
      if (!matches(dispatch.request ?? {})) browserScopeRequired('已执行的浏览器动作缺少匹配的持续授权。')
    }
    for (const [index, receipt] of receipts.entries()) {
      if(recoveryCoversReceipt(this.deps.repository,receipt,recovery))continue
      if (receipt.kind !== 'tool' || !['browser_click', 'browser_fill', 'browser_press'].includes(String(receipt.request?.toolName))) continue
      if (receipt.id === currentOperationId) continue
      if (dispatches.some(dispatch => retired.has(dispatch.id) && this.browserDispatchToolMatches(dispatch, receipt))) continue
      if (this.deps.repository.verifiedOperationResolution(receipt)?.evidence.kind === 'human_confirmation') {
        const dispatch = dispatches.find(candidate => candidate.request?.turnId === receipt.request?.turnId && candidate.request?.toolName === receipt.request?.toolName &&
          candidate.request?.argumentsHash === receipt.request?.argumentsHash && this.deps.repository.verifiedOperationResolution(candidate)?.evidence.kind === 'human_confirmation')
        if (!dispatch || !matches(dispatch.request ?? {})) browserScopeRequired('已核对的浏览器回执与原始动作范围不一致。')
        continue
      }
      const output = browserOutput(receipt)
      if (output.recovered === true && record(output.evidence).kind === 'human_confirmation') {
        const dispatch = dispatches.find(candidate => candidate.id === output.dispatchReceiptId)
        const resolution = dispatch && this.deps.repository.verifiedOperationResolution(dispatch)
        const reuse = receipts.find(candidate => candidate.id === output.reuseReceiptId && candidate.kind === 'browser_action_reuse' && candidate.status === 'succeeded' &&
          candidate.request?.dispatchId === dispatch?.id && candidate.request?.turnId === receipt.request?.turnId &&
          candidate.request?.toolName === receipt.request?.toolName && candidate.request?.argumentsHash === receipt.request?.argumentsHash)
        if (!dispatch || !matches(dispatch.request ?? {}) || !reuse || !resolution ||
          fingerprint(record(reuse.result).evidence) !== fingerprint(resolution.evidence) || fingerprint(output.evidence) !== fingerprint(resolution.evidence)) browserScopeRequired('已核对动作的复用凭据与当前工具请求不一致。')
        continue
      }
      if (receipt.status === 'outcome_unknown' || output.status === 'outcome_unknown' || receipt.status === 'running') browserOutcomeUnknown()
      if (receipt.status === 'prepared' && receipt.request?.dispatchTracking === 'host-v1') continue
      if (receipt.status === 'failed' && (record(receipt.result).approved === false ||
        output.provider === 'browser-skill' && output.status === 'failed' ||
        receipt.request?.dispatchTracking === 'host-v1' && output.code === 'operation_not_dispatched')) continue
      if (receipt.status !== 'succeeded') browserOutcomeUnknown()
      const dispatch = dispatches.find(candidate => candidate.id === output.dispatchReceiptId)
      if (dispatch) {
        if (dispatch.status !== 'succeeded' || dispatch.request?.turnId !== receipt.request?.turnId ||
          dispatch.request?.toolName !== receipt.request?.toolName || dispatch.request?.argumentsHash !== receipt.request?.argumentsHash) browserScopeRequired('浏览器执行凭据与原工具请求不匹配。')
        continue
      }
      if (output.dispatchReceiptId) browserScopeRequired('浏览器操作缺少对应的持久执行凭据。')
      const target = this.legacyBrowserTarget(task, receipt, receipts.slice(0, index))
      if (!target) browserScopeRequired('旧操作缺少可核对的执行前页面或逐次目标审批凭据。旧记录已保留，请先核验原始凭据，无法补齐时需在新来源任务中建立计划。')
      if (!matches(target)) browserScopeRequired('旧操作的真实页面、元素、输入或浏览器与持续授权不匹配。')
    }
    return [...retired.values()]
  }

  private browserDispatchToolMatches(dispatch: OperationReceipt, tool: OperationReceipt): boolean {
    if (tool.kind !== 'tool' || tool.request?.providerId !== 'browser-skill' || tool.request?.turnId !== dispatch.request?.turnId ||
      tool.request?.toolName !== dispatch.request?.toolName || tool.request?.argumentsHash !== dispatch.request?.argumentsHash) return false
    if (browserOutput(tool).dispatchReceiptId === dispatch.id) return true
    const toolResolution = this.deps.repository.verifiedOperationResolution(tool)
    const dispatchResolution = this.deps.repository.verifiedOperationResolution(dispatch)
    return Boolean(toolResolution && dispatchResolution && toolResolution.outcome === dispatchResolution.outcome &&
      operationFingerprint(toolResolution.evidence) === operationFingerprint(dispatchResolution.evidence))
  }

  /** Completed history is not a request to repeat old actions in a new plan. */
  private retiredBrowserDispatches(task: TaskRun, receipts: OperationReceipt[]): Map<string, RetiredBrowserActionEvidence> {
    const retired = new Map<string, RetiredBrowserActionEvidence>(), scope = task.authority?.browserScope
    const current = scope && taskPublicQueryAuthority(this.deps.repository, task, scope)
    if (!current || current.source.id !== task.id || current.authorization.duration !== 'schedule') return retired
    const binding = current.binding
    const bindings = receipts.filter(item => item.kind === 'browser_binding' && item.status === 'succeeded')
    const currentIndex = bindings.findIndex(item => item.id === binding.id)
    const ancestors: Array<{ previous: OperationReceipt; replacement: OperationReceipt; lineage: string[] }> = []
    // Only adjacent, explicit and fully authenticated replacements form a path.
    // A missing/changed link never permits searching arbitrary older bindings.
    for (let index = currentIndex; index > 0 && ancestors.length < 32; index--) {
      const replacement = bindings[index]!, previous = bindings[index - 1]!
      if (!this.verifiedBrowserBindingTransition(task, previous, replacement)) break
      ancestors.push({ previous, replacement, lineage: bindings.slice(index - 1, currentIndex + 1).map(item => item.id) })
    }
    for (const dispatch of receipts.filter(item => item.kind === 'browser_action_dispatch')) {
      const target = record(dispatch.request), settled = this.deps.repository.verifiedOperationResolution(dispatch)
      const ancestor = ancestors.find(item => target.browserInstanceId === record(item.previous.result).browserInstanceId &&
        target.browserRevision === record(item.previous.result).browserRevision && validTimes(dispatch.createdAt) &&
        Date.parse(dispatch.createdAt) >= Date.parse(item.previous.createdAt) && Date.parse(dispatch.createdAt) < Date.parse(item.replacement.createdAt))
      if (!ancestor) continue
      const { previous, replacement } = ancestor, prior = record(previous.result)
      if (target.browserInstanceId !== prior.browserInstanceId || target.browserRevision !== prior.browserRevision ||
        !validTimes(dispatch.createdAt, dispatch.updatedAt) || Date.parse(dispatch.createdAt) > Date.parse(dispatch.updatedAt) ||
        Date.parse(dispatch.createdAt) < Date.parse(previous.createdAt) ||
        Date.parse(dispatch.updatedAt) >= Date.parse(replacement.createdAt) ||
        settled && (!validTimes(settled.resolvedAt, settled.evidence.verifiedAt) || Date.parse(settled.resolvedAt) < Date.parse(dispatch.updatedAt) ||
          Date.parse(settled.evidence.verifiedAt) > Date.parse(settled.resolvedAt) || Date.parse(settled.resolvedAt) >= Date.parse(replacement.createdAt)) ||
        browserVerificationPolicy(target.verificationPolicy) !== browserVerificationPolicy(prior.verificationPolicy)) continue
      const tool = receipts.find(item => this.browserDispatchToolMatches(dispatch, item) &&
        (item.status === 'succeeded' || this.deps.repository.verifiedOperationResolution(item)))
      if (!tool) continue
      const toolResolution = this.deps.repository.verifiedOperationResolution(tool)
      if (!validTimes(tool.createdAt, tool.updatedAt) || Date.parse(tool.createdAt) > Date.parse(tool.updatedAt) ||
        Date.parse(tool.createdAt) > Date.parse(dispatch.createdAt) || Date.parse(tool.updatedAt) < Date.parse(dispatch.createdAt) ||
        Date.parse(tool.updatedAt) >= Date.parse(replacement.createdAt) ||
        toolResolution && (!validTimes(toolResolution.resolvedAt, toolResolution.evidence.verifiedAt) ||
          Date.parse(toolResolution.resolvedAt) < Date.parse(tool.updatedAt) || Date.parse(toolResolution.evidence.verifiedAt) > Date.parse(toolResolution.resolvedAt) ||
          Date.parse(toolResolution.resolvedAt) >= Date.parse(replacement.createdAt))) continue
      const grant = record(tool.request?.executionGrant), oldScope = record(grant.browserScope), output = browserOutput(tool)
      if (grant.taskId !== task.id || grant.threadId !== task.threadId || grant.turnId !== target.turnId ||
        typeof grant.id !== 'string' || !grant.id ||
        operationFingerprint(oldScope.publicQueryAuthorization) !== operationFingerprint(prior.publicQueryAuthorization) ||
        oldScope.interaction !== 'interact' || oldScope.browserInstanceId !== prior.browserInstanceId || oldScope.revision !== prior.browserRevision ||
        browserVerificationPolicy(oldScope.verificationPolicy) !== browserVerificationPolicy(prior.verificationPolicy) ||
        !Array.isArray(oldScope.origins) || typeof target.pageUrl !== 'string' || !URL.canParse(target.pageUrl) ||
        !oldScope.origins.includes(new URL(target.pageUrl).origin) ||
        typeof grant.issuedAt !== 'string' || !Number.isFinite(Date.parse(grant.issuedAt)) || Date.parse(grant.issuedAt) < Date.parse(previous.createdAt) || Date.parse(grant.issuedAt) > Date.parse(dispatch.createdAt) ||
        typeof grant.expiresAt === 'string' && (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.parse(dispatch.createdAt))) continue
      const historical = verifiedTaskPublicQueryAction(this.deps.repository, tool, dispatch, true)
      const nativeNavigation = verifiedTaskPublicQueryDocumentNavigation(this.deps.repository, tool, dispatch, true)
      if ((historical?.request.rule === 'result_link' || target.nativeAction !== undefined) && !nativeNavigation) continue
      if (!settled && !nativeNavigation && (dispatch.status !== 'succeeded' || record(dispatch.result).actionAcknowledged !== true ||
        typeof record(dispatch.result).acknowledgementHash !== 'string' || record(dispatch.result).readbackPending !== false ||
        typeof record(dispatch.result).resultHash !== 'string' || tool.status !== 'succeeded' || output.provider !== 'browser-skill' ||
        output.status !== 'succeeded' || output.resultHash !== record(dispatch.result).resultHash)) continue
      const scoped = historical?.authority.source.id === task.id && historical.authority.authorization.purposeHash === current.authorization.purposeHash &&
        (historical.authority.authorization.duration !== 'schedule' || historical.authority.authorization.requirementHash === current.authorization.requirementHash)
      const exact = this.historicalBrowserScheduleAction(task, dispatch, tool, receipts)
      if (scoped || exact) retired.set(dispatch.id, { dispatchReceiptId: dispatch.id, toolReceiptId: tool.id,
        retiredBindingReceiptId: previous.id, currentBindingReceiptId: binding.id, bindingLineageReceiptIds: ancestor.lineage, evidenceKind: scoped ? 'historical_task_scope' : 'historical_exact_approval',
        ...(settled ? { settlementReceiptId: settled.receiptId } : {}),
        ...(exact ? { authorizationReceiptId: String(target.authorizationReceiptId), approvedScheduleActionId: exact.id } : {}),
        ...(typeof target.scheduleActionId === 'string' ? { recordedScheduleActionId: target.scheduleActionId } : {}),
        legacyActionLinkMismatch: Boolean(exact && target.scheduleActionId !== exact.id) })
    }
    return retired
  }

  private verifiedBrowserBindingTransition(task: TaskRun, previous: OperationReceipt, replacement: OperationReceipt): boolean {
    const from = record(previous.result), to = record(replacement.result), before = record(previous.request), after = record(replacement.request)
    if (to.previousBrowserInstanceId !== from.browserInstanceId || typeof after.expectedTaskRevision !== 'number' ||
      typeof before.expectedTaskRevision !== 'number' || after.expectedTaskRevision <= before.expectedTaskRevision ||
      !validTimes(previous.createdAt, previous.updatedAt, replacement.createdAt, replacement.updatedAt) ||
      Date.parse(previous.createdAt) > Date.parse(previous.updatedAt) || Date.parse(replacement.createdAt) > Date.parse(replacement.updatedAt) ||
      Date.parse(previous.updatedAt) >= Date.parse(replacement.createdAt) || !Array.isArray(before.origins) || !Array.isArray(after.origins) ||
      after.origins.some(origin => !(before.origins as unknown[]).includes(origin))) return false
    for (const receipt of [previous, replacement]) {
      const request = record(receipt.request), result = record(receipt.result)
      if (receipt.fingerprint !== operationFingerprint(request) || request.confirmed !== true || request.interaction !== 'interact' ||
        result.interaction !== 'interact' || result.taskId !== task.id || result.purpose !== task.goal ||
        result.taskRevision !== request.expectedTaskRevision || result.browserInstanceId !== request.browserInstanceId ||
        result.browserRevision !== request.expectedBrowserRevision || operationFingerprint(result.origins) !== operationFingerprint(request.origins) ||
        browserVerificationPolicy(result.verificationPolicy) !== browserVerificationPolicy(request.verificationPolicy)) return false
      if (result.scheduleReview !== undefined) {
        const { startTimes: _startTimes, ...requirement } = record(result.scheduleReview)
        if (operationFingerprint(requirement) !== operationFingerprint(task.acceptance.schedule)) return false
      }
      if (result.publicQueryAuthorization !== undefined) {
        const parsed = BrowserExecutionScope.safeParse({ browserInstanceId: result.browserInstanceId, revision: result.browserRevision,
          origins: result.origins, interaction: result.interaction, verificationPolicy: result.verificationPolicy,
          publicQueryAuthorization: result.publicQueryAuthorization })
        const authority = parsed.success && taskPublicQueryAuthority(this.deps.repository, task, parsed.data, { historical: true })
        if (!authority || authority.binding.id !== receipt.id || authority.source.id !== task.id ||
          authority.authorization.purposeHash !== operationFingerprint({ purpose: task.goal }) ||
          authority.authorization.duration === 'schedule' && authority.authorization.requirementHash !== operationFingerprint({ requirement: task.acceptance.schedule })) return false
      }
    }
    return true
  }

  /** Authenticate the old exact approval; it grants nothing to the new scope. */
  private historicalBrowserScheduleAction(task: TaskRun, dispatch: OperationReceipt, tool: OperationReceipt, receipts: OperationReceipt[]): BrowserScheduleAction | undefined {
    const target = record(dispatch.request), grant = record(tool.request?.executionGrant)
    const single = receipts.find(item => item.id === target.authorizationReceiptId && item.kind === 'browser_action_authorization')
    const initial = record(single?.request), saved = record(single?.result)
    // Some old producer versions attached a derived ID from another page with
    // identical HTML. Only the exact action authorization can prove this target.
    const continuous = receipts.find(item => item.kind === 'browser_schedule_action_authorization' && record(item.result).id === saved.scheduleActionId)
    const parsed = BrowserScheduleActionSchema.safeParse(continuous?.result)
    if (!single || single.status !== 'succeeded' || single.fingerprint !== operationFingerprint(initial) || saved.revoked === true ||
      !continuous || continuous.status !== 'succeeded' || continuous.request?.revoked === true || !parsed.success ||
      continuous.fingerprint !== operationFingerprint(continuous.request)) return undefined
    const approved = parsed.data, human = this.deps.repository.humanRequest(approved.approvalId), approval = record(human?.payload.approval)
    const { approvalId: _approvalId, summary: _summary, ...descriptor } = approved
    if (approved.sourceTaskId !== task.id || approved.scheduleId !== `schedule_${task.id}` || approved.access !== 'public_query' ||
      operationFingerprint(descriptor) !== operationFingerprint(continuous.request) ||
      approved.purposeHash !== createHash('sha256').update(task.goal).digest('hex') || approved.requirementHash !== fingerprint(task.acceptance.schedule) ||
      approved.id !== saved.scheduleActionId || saved.approvalId !== approved.approvalId || saved.access !== 'public_query' ||
      initial.taskId !== task.id || initial.sessionId !== target.sessionId || initial.goalHash !== approved.purposeHash ||
      initial.grantRevision !== grant.revision || initial.workspaceRevision !== grant.workspaceRevision || initial.agentRevision !== grant.agentRevision ||
      typeof saved.expiresAt !== 'string' || !Number.isFinite(Date.parse(saved.expiresAt)) || Date.parse(saved.expiresAt) <= Date.parse(dispatch.createdAt) ||
      !validTimes(single.createdAt, single.updatedAt, continuous.createdAt, continuous.updatedAt) ||
      Date.parse(single.createdAt) > Date.parse(single.updatedAt) || Date.parse(continuous.createdAt) > Date.parse(continuous.updatedAt) ||
      Date.parse(single.updatedAt) > Date.parse(dispatch.createdAt) || Date.parse(continuous.updatedAt) > Date.parse(dispatch.createdAt) ||
      Date.parse(single.createdAt) > Date.parse(dispatch.createdAt) || Date.parse(continuous.createdAt) > Date.parse(dispatch.createdAt) ||
      ['action', 'pageUrl', 'elementHash', 'valueHash', 'browserInstanceId', 'browserRevision'].some(key => initial[key] !== target[key] || record(approved)[key] !== target[key]) ||
      browserVerificationPolicy(initial.verificationPolicy) !== browserVerificationPolicy(target.verificationPolicy) ||
      browserVerificationPolicy(approved.verificationPolicy) !== browserVerificationPolicy(target.verificationPolicy) ||
      !human || human.status !== 'answered' || record(human.resolution).decision !== 'allow' || human.threadId !== task.threadId ||
      !validTimes(human.createdAt, human.updatedAt) || Date.parse(human.createdAt) > Date.parse(human.updatedAt) ||
      Date.parse(human.updatedAt) > Date.parse(single.createdAt) ||
      human.turnId !== target.turnId || approval.toolName !== 'browser_authorize_action' || approval.summary !== approved.summary ||
      approval.requestHash !== fingerprint(continuous.request)) return undefined
    return approved
  }

  /** Legacy approvals contain an origin and target digests, never a pre-action page URL. */
  private legacyBrowserTarget(task: TaskRun, receipt: OperationReceipt, earlier: OperationReceipt[]): Record<string, unknown> | undefined {
    const output = browserOutput(receipt)
    if (output.provider !== 'browser-skill' || output.status !== 'succeeded' || typeof output.sessionId !== 'string') return undefined
    const action = receipt.request?.toolName === 'browser_click' ? 'click' : receipt.request?.toolName === 'browser_fill' ? 'fill' : undefined
    if (!action || typeof receipt.request?.approvalRequestHash !== 'string' || typeof receipt.request?.callId !== 'string') return undefined
    const approved = this.deps.repository.humanRequests('approval', false).find(request => {
      const approval = record(request.payload.approval)
      return request.status === 'answered' && record(request.resolution).decision === 'allow' && request.threadId === task.threadId &&
        request.turnId === receipt.request?.turnId && approval.toolName === receipt.request?.toolName &&
        (approval.callId === receipt.request?.callId || request.id === `appr_${receipt.request?.callId}`) &&
        approval.requestHash === receipt.request?.approvalRequestHash
    })
    const summary = record(approved?.payload.approval).summary
    if (typeof summary !== 'string' || !summary.startsWith('确认浏览器操作\n') || !sanitizeBrowserApprovalSummary(summary)) return undefined
    const fields = Object.fromEntries(summary.split('\n').slice(1).map(line => {
      const separator = line.indexOf(' ')
      return [line.slice(0, separator), JSON.parse(line.slice(separator + 1)) as string]
    }))
    if (fields['请求摘要'] !== receipt.request?.approvalRequestHash || fields['动作'] !== (action === 'click' ? '点击网页元素' : '填写网页输入框')) return undefined
    // Only a provider observation that populated the same session's context can
    // establish the earlier URL. A post-click URL may already be a redirect.
    const previous = earlier.filter(candidate => candidate.kind === 'tool' && candidate.status === 'succeeded' &&
      browserOutput(candidate).provider === 'browser-skill' && browserOutput(candidate).sessionId === output.sessionId &&
      typeof record(browserOutput(candidate).observation).context_id === 'string').at(-1)
    const pageUrl = previous && browserOutput(previous).sourceUrl
    if (typeof pageUrl !== 'string' || !URL.canParse(pageUrl) || new URL(pageUrl).origin !== fields['站点']) return undefined
    const scope = record(record(receipt.request?.executionGrant).browserScope)
    if (typeof scope.browserInstanceId !== 'string' || typeof scope.revision !== 'number') return undefined
    return { action, pageUrl, elementHash: fields['目标摘要'], ...(action === 'fill' ? { valueHash: fields['输入摘要'] } : {}),
      browserInstanceId: scope.browserInstanceId, browserRevision: scope.revision }
  }

  /** Only the provider's current pre-dispatch resolution may identify its own Host row.
   * Save, tick and generic authority checks never receive this runtime-only context.
   */
  private currentUndispatchedBrowserTool(task: TaskRun, receipts: OperationReceipt[], context?: ToolHostContext): string | undefined {
    if (!context?.currentToolOperation) return undefined
    const current = context.currentToolOperation()
    const grant = context.executionGrant
    const receipt = receipts.find(item => item.id === current.operationId)
    if (!grant || current.taskId !== task.id || grant.taskId !== task.id || task.threadId !== context.threadId ||
      task.activeTurnId !== context.turnId || current.turnId !== context.turnId || grant.turnId !== context.turnId ||
      grant.threadId !== context.threadId || !['running', 'waiting_approval'].includes(task.status) ||
      !receipt || receipt.kind !== 'tool' || receipt.status !== 'running' || receipt.idempotencyKey !== current.idempotencyKey ||
      current.providerId !== 'browser-skill' || !['browser_click', 'browser_fill', 'browser_press'].includes(current.toolName) ||
      receipt.request?.dispatchTracking !== 'host-v1' || receipt.request.executionId !== current.executionId ||
      receipt.request.turnId !== current.turnId || receipt.request.toolName !== current.toolName ||
      receipt.request.callId !== current.callId || receipt.request.providerId !== current.providerId ||
      receipt.request.argumentsHash !== current.argumentsHash ||
      operationFingerprint(grant) !== current.executionGrantFingerprint ||
      operationFingerprint(receipt.request.executionGrant) !== current.executionGrantFingerprint ||
      grant.expiresAt && Date.parse(grant.expiresAt) <= Date.parse(this.deps.nowIso())) return undefined
    // Older dispatches lack a Host operation id. Matching the complete Turn,
    // tool and argument digest is deliberately conservative: even a settled
    // identical invocation is not grounds to replay it under this exemption.
    if (receipts.some(item => item.kind === 'browser_action_dispatch' &&
      (item.request?.hostOperationId === receipt.id || item.request?.turnId === current.turnId &&
        item.request.toolName === current.toolName && item.request.argumentsHash === current.argumentsHash))) return undefined
    return receipt.id
  }

  /** Retry safety asks this read-only gate in addition to its exact Host proof. */
  async validateRetryLocalSchedule(task: TaskRun, receipt: OperationReceipt, recovery?:BrowserPublicQueryRecoveryBinding): Promise<boolean> {
    const source = this.planSource(task), flow = this.deps.flows.get(`schedule_${source.id}`)
    const tool = receipt.request?.toolName
    if (!flow || receipt.ownerId !== task.id || receipt.kind !== 'tool' || receipt.request?.providerId !== 'task-schedule' ||
      !['schedule_task', 'list_schedules'].includes(String(tool)) || !['succeeded', 'failed'].includes(receipt.status)) return false
    const authority = this.authority(flow)
    const lineage = task.retryOfTaskId ? verifiedTaskRetryLineage(this.deps.repository, task) : { root: task, tasks: [task] }
    if (!lineage || !lineage.tasks.some(item => item.id === authority.taskId) || task.goal !== authority.prompt ||
      fingerprint(task.acceptance.schedule) !== fingerprint(authority.requirement)) return false
    if(recovery&&fingerprint(this.recoveryForAuthority(authority))!==fingerprint(recovery))return false
    await this.validateAuthority(authority,undefined,undefined,recovery)
    return this.snapshot(flow).enabled
  }

  /** A retry may locate its business Root only through the persisted UI-control lineage. */
  private planSource(task: TaskRun): TaskRun {
    if (!task.retryOfTaskId) return task
    const lineage = verifiedTaskRetryLineage(this.deps.repository, task)
    if (!lineage) fail('重试来源尚未核验，请核对原任务记录。')
    return lineage.root
  }

  /** Reuse the immutable plan, never its old Grant as this attempt's authority. */
  private async validateRetryPlan(task: TaskRun, saved: ScheduledTaskAuthority, context: ToolHostContext, preparedScope?: ExecutionScope): Promise<void> {
    const recovery=context.executionGrant?.browserPublicQueryRecovery
    const lineage = verifiedTaskRetryLineage(this.deps.repository, task), grant = context.executionGrant
    if (!lineage || !lineage.tasks.some(item => item.id === saved.taskId) || !grant || grant.taskId !== task.id ||
      grant.threadId !== task.threadId || grant.threadId !== context.threadId || grant.turnId !== context.turnId || grant.turnId !== task.activeTurnId ||
      grant.workspaceRoot !== task.workspaceRoot || grant.workspaceRoot !== context.workspace || grant.workspaceRoot !== saved.grant.workspaceRoot ||
      grant.workspaceTrust !== saved.grant.workspaceTrust || grant.workspaceRevision !== saved.grant.workspaceRevision ||
      grant.agentTrust !== saved.grant.agentTrust || grant.agentRevision !== saved.grant.agentRevision ||
      grant.approvalPolicy !== saved.grant.approvalPolicy || grant.sandboxMode !== saved.grant.sandboxMode ||
      !['running', 'waiting_approval'].includes(task.status) || grant.expiresAt && Date.parse(grant.expiresAt) <= Date.parse(this.deps.nowIso()) ||
      task.goal !== saved.prompt || fingerprint(task.acceptance.schedule) !== fingerprint(saved.requirement)) fail('重试任务与原计划的来源、目标或有效执行凭证不同，请核对原计划。')
    await context.validateExecutionGrant?.()
    await this.validateAuthority(saved, undefined, context, context.executionGrant?.browserPublicQueryRecovery)
    const permission = task.authority?.taskApprovalGrant
    if (task.authority?.revokedAt || permission?.revokedAt || permission && (permission.status !== 'active' || Date.parse(permission.expiresAt) <= Date.parse(this.deps.nowIso()))) fail('重试任务的临时权限已变化，请重新确认。')
    const execution = await this.deps.threads.get(context.threadId), origin = await this.deps.threads.get(task.originThreadId ?? context.threadId)
    const query = taskPublicQueryGrant(this.deps.repository, grant, task, Date.parse(this.deps.nowIso()))
    if (grant.browserScope?.publicQueryAuthorization && query?.authorization.duration !== 'schedule') fail('重试任务没有已核验的持续浏览器授权。')
    const actions = listApprovedBrowserScheduleActions(this.deps.repository, task)
    this.validateBrowserDispatches(task, actions, context)
    if (this.deps.repository.operations(task.id, 'browser_schedule_action_outcome').some(receipt =>
      receipt.status === 'outcome_unknown' && !this.deps.repository.verifiedOperationResolution(receipt) && !recoveryCoversReceipt(this.deps.repository,receipt,recovery))) browserOutcomeUnknown()
    const scope = preparedScope ?? taskScheduleScope({ allowedToolNames: grant.allowedToolNames, allowedProviderIds: grant.allowedProviderIds,
      pathAllowlist: grant.pathAllowlist, readPathAllowlist: grant.readPathAllowlist, writePathAllowlist: grant.writePathAllowlist,
      networkAllowlist: grant.networkAllowlist, connectorScopes: grant.connectorScopes, externalTargets: grant.externalTargets,
      connectorIdentityFingerprints: grant.connectorIdentityFingerprints, connectorBackends: grant.connectorBackends, browserScope: grant.browserScope,
      ...(permission?.scope ? { permissionScope: permission.scope } : {}), ...(grant.workspaceWriteException ? { workspaceWriteException: true } : {}),
      ...(actions.length || query?.authorization.duration === 'schedule' ? { browserScheduleActions: actions } : {}) })
    if (!execution || !origin || fingerprint(threadAuthority(execution)) !== fingerprint(saved.execution) || fingerprint(threadAuthority(origin)) !== fingerprint(saved.origin) ||
      !this.retryScopeMatches(task,grant,scope,saved.scope)) fail('重试任务的工作区、Agent、路径、站点或连接器范围与原计划不同，请重新核对授权。')
    this.validateConnectorBindings({ ...saved, grant })
  }

  private retryScopeMatches(task:TaskRun,grant:ExecutionGrant,current:ExecutionScope,saved:ExecutionScope):boolean {
    if(!grant.browserPublicQueryRecovery)return fingerprint(current)===fingerprint(taskScheduleScope(saved))
    // Reading the already sealed Root plan needs no creation permission. Recheck
    // the exact recovery/Retry lineage, then accept only the fresh Grant's
    // capability intersection. The saved authority and Flow stay immutable.
    const bounded=taskScheduleScope(recoveryExecutionScope(this.deps.repository,task,taskScheduleScope(saved),Date.parse(grant.issuedAt)))
    const {allowedToolNames:tools,allowedProviderIds:providers,networkAllowlist:origins,expiresAt:_expires,browserPublicQueryRecovery:_recovery,...fixed}=bounded
    const {allowedToolNames:actualTools,allowedProviderIds:actualProviders,networkAllowlist:actualOrigins,...actualFixed}=current
    return operationFingerprint(fixed)===operationFingerprint(actualFixed)&&
      Array.isArray(actualTools)&&Array.isArray(tools)&&actualTools.every(name=>tools.includes(name))&&
      Array.isArray(actualProviders)&&Array.isArray(providers)&&actualProviders.every(id=>providers.includes(id))&&
      Array.isArray(actualOrigins)&&Array.isArray(origins)&&actualOrigins.every(origin=>origins.includes(origin))
  }

  private async validateAuthority(authority: ScheduledTaskAuthority, browserActions = authority.scope.browserScheduleActions ?? [], currentContext?: ToolHostContext, recovery=currentContext?.executionGrant?.browserPublicQueryRecovery) {
    const { grant } = authority
    const source = this.deps.repository.get(authority.taskId)
    const origin = await this.deps.threads.get(authority.originThreadId)
    const execution = await this.deps.threads.get(authority.threadId)
    const workspace = await this.deps.workspaceTrust.get(grant.workspaceRoot)
    if (!source || source.goal !== authority.prompt || source.authority?.revokedAt || source.authority?.taskApprovalGrant?.revokedAt || fingerprint(source.authority ?? null) !== authority.sourceAuthorityHash ||
      !origin || origin.status === 'deleted' || !execution || execution.status === 'deleted' ||
      fingerprint(threadAuthority(origin)) !== fingerprint(authority.origin) || fingerprint(threadAuthority(execution)) !== fingerprint(authority.execution) ||
      workspace.canonicalRoot !== grant.workspaceRoot ||
      workspace.revision !== grant.workspaceRevision || workspace.level !== grant.workspaceTrust ||
      (execution.agentRevision ?? 0) !== grant.agentRevision || (execution.agentProfile?.trustLevel ?? 'full-access') !== grant.agentTrust ||
      execution.approvalPolicy !== grant.approvalPolicy) fail('原计划的工作区、Agent 或授权范围已变化，请核对后再执行。')
    if ((source.authority?.taskApprovalGrant?.scope || grant.workspaceWriteException) && authority.authorization.kind !== 'confirmed_scope') fail('持续路径权限尚未确认。')
    const publicScope = grant.browserScope?.publicQueryAuthorization
    if (publicScope) {
      const scoped = grant.browserScope && taskPublicQueryAuthority(this.deps.repository, source, grant.browserScope)
      if (!scoped || scoped.authorization.duration !== 'schedule' || authority.authorization.sourceScopeReceiptId !== scoped.binding.id && authority.authorization.kind !== 'confirmed_scope' ||
        fingerprint(authority.scope.browserScope) !== fingerprint(grant.browserScope)) fail('持续公开查询范围已变化或尚未明确确认。')
    }
    const browserHistory = this.validateBrowserDispatches(source, browserActions, currentContext,recovery)
    if ((authority.scope.browserScheduleActions?.length || publicScope) && this.deps.repository.operations(source.id, 'browser_schedule_action_outcome').some(receipt =>
      receipt.status === 'outcome_unknown' && !this.deps.repository.verifiedOperationResolution(receipt) && !recoveryCoversReceipt(this.deps.repository,receipt,recovery))) browserOutcomeUnknown()
    if (authority.scope.browserScheduleActions?.length) {
      const approved = listApprovedBrowserScheduleActions(this.deps.repository, source)
      if (authority.scope.browserScheduleActions.some(action => !approved.some(candidate => fingerprint(candidate) === fingerprint(action)))) fail('计划浏览器动作已撤销或范围已变化，请重新审阅。')
      if (this.deps.repository.operations(source.id, 'browser_schedule_action_outcome').some(receipt =>
        receipt.status === 'outcome_unknown' && receipt.request?.scheduleId === `schedule_${source.id}` && !this.deps.repository.verifiedOperationResolution(receipt) && !recoveryCoversReceipt(this.deps.repository,receipt,recovery))) {
        throw Object.assign(new Error('browser_schedule_outcome_unknown'), { code: 'browser_schedule_outcome_unknown' })
      }
    }
    this.validateConnectorBindings(authority)
    return browserHistory
  }

  private recoveryForAuthority(authority: ScheduledTaskAuthority) {
    return publicQueryRecoveryForPlan(this.deps.repository,{sourceTaskId:authority.taskId,scheduleId:`schedule_${authority.taskId}`,versionId:this.deps.flows.get(`schedule_${authority.taskId}`)?.publishedVersionId??'',scopeHash:authority.authorization.scopeHash,browserIdentity:this.deps.connectorIdentities()['browser-skill']??''})
  }

  async validatePublicQueryRecoveryPlan(binding: BrowserPublicQueryRecoveryBinding): Promise<void> {
    const flow=binding.scheduleId?this.deps.flows.get(binding.scheduleId):null
    if(!flow||flow.variables.enabled===false||flow.variables.archived===true||flow.publishedVersionId!==binding.versionId)fail('原计划已变化。')
    const authority=this.authority(flow)
    if(fingerprint(this.recoveryForAuthority(authority))!==fingerprint(binding))fail('公开查询恢复计划凭据不匹配。')
    await this.validateAuthority(authority,undefined,undefined,binding)
  }

  private validateConnectorBindings(authority: ScheduledTaskAuthority): void {
    const { grant } = authority
    if (grant.browserScope) {
      const browser = this.deps.browserState?.()
      if (!browser || !browser.enabled || browser.browserInstanceId !== grant.browserScope.browserInstanceId || browser.revision !== grant.browserScope.revision) fail('计划绑定的浏览器或授权来源已变化，请核对原计划。')
    }
    const identities = this.deps.connectorIdentities()
    if (Object.entries(grant.connectorIdentityFingerprints ?? {}).some(([id, identity]) => !isTaskScheduleBridgeProvider(id) && identities[id] !== identity)) fail('计划绑定的连接器身份已变化，请核对原计划。')
  }

  private authority(flow: FlowDefinitionV1): ScheduledTaskAuthority {
    const authority = flow.variables.taskSchedule as ScheduledTaskAuthority | undefined
    if (!authority?.grant || !authority.requirement || !authority.authorization || !authority.scope || !authority.execution || !authority.origin) fail('计划缺少持续任务授权，请核对后重新建立。')
    const receipt = this.deps.repository.operation(authority.taskId, authority.authorization.receiptKey ?? `schedule-authority:${flow.id}`)
    if (receipt?.status !== 'succeeded' || (receipt.result as { authorityHash?: string })?.authorityHash !== fingerprint(authority)) fail('计划授权与原始确认不一致。')
    return authority
  }

  private snapshot(flow: FlowDefinitionV1) {
    const trigger = this.deps.flows.repository.getTriggerState(flow.id, 'schedule')
    const authority = this.authority(flow)
    const published = flow.publishedVersionId ? this.deps.flows.repository.getVersion(flow.publishedVersionId) : null
    const authorizedVersion = published && fingerprint(published.definition.variables.taskSchedule) === fingerprint(authority)
    return { id: flow.id, requirement: authority.requirement, schedule: flow.nodes.find(node => node.id === 'schedule')?.config,
      enabled: Boolean(authorizedVersion) && trigger?.enabled === true && flow.variables.enabled !== false && flow.variables.archived !== true, nextRunAt: trigger?.nextRunAt,
      workspaceRoot: flow.workspace, sourceTaskId: authority.taskId, scope: taskScheduleScope(authority.scope), authorization: authority.authorization }
  }
}
