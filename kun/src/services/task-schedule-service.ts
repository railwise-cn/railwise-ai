import { createHash } from 'node:crypto'
import type { BrowserCapabilityConfig } from '../contracts/browser-skill.js'
import type { ExecutionGrant, ExecutionScope } from '../contracts/permissions.js'
import type { TaskRun } from '../contracts/tasks.js'
import type { FlowDefinitionV1 } from '../contracts/flow.js'
import { scheduleForRequirement, type ScheduleRequirement } from '../contracts/schedule.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { FlowRuntimeService } from '../flow/service.js'
import type { TaskRunRepository } from './task-run-repository.js'
import type { TaskController } from './task-controller.js'
import type { TaskCoordinator } from './task-coordinator.js'
import type { WorkspaceTrustReader } from './workspace-trust-reader.js'

type ScheduledTaskAuthority = {
  taskId: string
  threadId: string
  originThreadId: string
  model: string
  providerId?: string
  prompt: string
  requirement: ScheduleRequirement
  grant: ExecutionGrant
  permissionExpiresAt?: string
}
export type ScheduledTaskDispatch = { scheduleId: string; versionId: string; dueAt: string }
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fail(message: string): never { throw Object.assign(new Error(message), { code: 'schedule_authority_changed' }) }

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
    const authority: ScheduledTaskAuthority = {
      taskId: task.id, threadId: context.threadId, originThreadId: task.originThreadId ?? context.threadId,
      model: task.model ?? context.model?.id ?? 'auto', providerId: task.providerId, prompt: task.goal, requirement: task.acceptance.schedule, grant,
      ...(task.authority?.taskApprovalGrant ? { permissionExpiresAt: task.authority.taskApprovalGrant.expiresAt } : {})
    }
    const id = `schedule_${task.id}`
    const existing = this.deps.flows.get(id)
    if (existing) {
      const saved = this.authority(existing)
      if (saved.taskId !== task.id || fingerprint(saved.requirement) !== fingerprint(authority.requirement)) fail('已有计划与当前要求不同，请先更新原计划。')
      return this.snapshot(existing)
    }
    const policy = { timeoutMs: 120000, retryAttempts: 0, retryBackoffMs: 1000, errorBehavior: 'fail' as const, concurrencyLimit: 1, resumable: true, breakpoint: false }
    this.deps.flows.repository.transaction(() => {
      this.deps.flows.create({ schemaVersion: 1, id, name: task.goal.slice(0, 80), description: '按已授权任务范围定时执行',
        nodes: [{ id: 'schedule', type: 'schedule_trigger', label: '每日计划', position: { x: 120, y: 120 }, bindings: {}, config: scheduleForRequirement(authority.requirement), policy, disabled: false }],
        edges: [], variables: { enabled: true, taskSchedule: authority }, workspace: grant.workspaceRoot })
      const published = this.deps.flows.publish(id)
      if (!published.published) throw new Error(published.validation.issues.map(issue => issue.message).join('\n'))
    })
    return this.snapshot(this.deps.flows.get(id)!)
  }

  readback(context: ToolHostContext) {
    const task = this.deps.tasks.activeTask(context.threadId)
    if (!task) fail('当前任务不存在。')
    const schedules = this.deps.flows.list().filter(flow => {
      const value = flow.variables.taskSchedule as ScheduledTaskAuthority | undefined
      return value?.taskId === task.id && flow.workspace === context.workspace
    }).map(flow => this.snapshot(flow))
    const key = `schedule-readback:${fingerprint(schedules)}`
    this.deps.repository.beginOperation({ ownerId: task.id, idempotencyKey: key, kind: 'schedule_readback', request: { schedules }, nowIso: this.deps.nowIso() })
    this.deps.repository.finishOperation(task.id, key, { status: 'succeeded', result: { schedules } }, this.deps.nowIso())
    return { schedules }
  }

  assessCompletion(task: TaskRun): { reason: string; fingerprint: string } | null {
    if (!task.acceptance.schedule || task.scheduledBy) return null
    const flow = this.deps.flows.get(`schedule_${task.id}`)
    const current = flow ? this.snapshot(flow) : undefined
    const verified = current?.enabled && current.nextRunAt && fingerprint(current.requirement) === fingerprint(task.acceptance.schedule) &&
      this.deps.repository.operations(task.id, 'schedule_readback').some(receipt => receipt.status === 'succeeded' &&
        fingerprint((receipt.result as { schedules?: unknown[] })?.schedules) === fingerprint([current]))
    return verified ? null : { reason: '请用 schedule_task 建立本任务的每日计划，再用 list_schedules 读回并核对执行时刻、时区和下一次执行时间。', fingerprint: `schedule:${fingerprint(current ?? task.acceptance.schedule)}` }
  }

  async executionScope(task: TaskRun): Promise<ExecutionScope | undefined> {
    if (!task.scheduledBy) return undefined
    const flow = this.deps.flows.get(task.scheduledBy.scheduleId)
    if (!flow) fail('计划已不存在。')
    const authority = this.authority(flow)
    await this.validateAuthority(authority)
    const grant = authority.grant
    return { allowedToolNames: grant.allowedToolNames, allowedProviderIds: grant.allowedProviderIds,
      pathAllowlist: grant.pathAllowlist, readPathAllowlist: grant.readPathAllowlist, writePathAllowlist: grant.writePathAllowlist,
      networkAllowlist: grant.networkAllowlist, connectorScopes: grant.connectorScopes, externalTargets: grant.externalTargets,
      connectorIdentityFingerprints: grant.connectorIdentityFingerprints, connectorBackends: grant.connectorBackends, browserScope: grant.browserScope,
      ...(authority.permissionExpiresAt ? { expiresAt: authority.permissionExpiresAt } : {}) }
  }

  async dispatch(input: ScheduledTaskDispatch): Promise<void> {
    const current = this.deps.flows.get(input.scheduleId)
    if (!current || current.variables.archived === true || current.variables.enabled === false) return
    const version = this.deps.flows.repository.getVersion(input.versionId)
    if (!version || current.publishedVersionId !== input.versionId) fail('计划配置已变化，请核对待执行计划。')
    const authority = this.authority(version.definition)
    try {
      await this.validateAuthority(authority)
      await this.deps.coordinator.command({ threadId: authority.originThreadId, intent: 'new',
        idempotencyKey: `schedule:${input.scheduleId}:${input.dueAt}`,
        request: { prompt: authority.prompt, model: authority.model, providerId: authority.providerId, mode: 'agent' }
      }, { prepareTask: task => {
        if (task.scheduledBy) return
        this.deps.repository.update(task.id, task.revision, value => {
          const { schedule: _schedule, ...acceptance } = value.acceptance
          return { ...value, scheduledBy: { scheduleId: input.scheduleId, dueAt: input.dueAt }, acceptance }
        }, { key: `scheduled:${input.dueAt}`, kind: 'scheduled_task_created', payload: input, createdAt: this.deps.nowIso() })
      } })
    } catch (error) {
      const now = this.deps.nowIso()
      this.deps.repository.putAttention({ id: `schedule:${input.scheduleId}`, ownerKind: 'flow', ownerId: input.scheduleId,
        flowId: input.scheduleId, threadId: authority.originThreadId, kind: 'blocked', title: '定时计划等待核对',
        message: error instanceof Error ? error.message : String(error), status: 'pending', revision: 0, createdAt: now, updatedAt: now,
        payload: { scheduleId: input.scheduleId, dueAt: input.dueAt } })
      throw error
    }
  }

  private async validateAuthority(authority: ScheduledTaskAuthority) {
    const { grant } = authority
    const source = this.deps.repository.get(authority.taskId)
    const thread = await this.deps.threads.get(authority.originThreadId)
    const workspace = await this.deps.workspaceTrust.get(grant.workspaceRoot)
    if (!source || source.authority?.revokedAt || !thread || thread.status === 'deleted' || thread.workspace !== grant.workspaceRoot ||
      workspace.revision !== grant.workspaceRevision || workspace.level !== grant.workspaceTrust ||
      (thread.agentRevision ?? 0) !== grant.agentRevision || (thread.agentProfile?.trustLevel ?? 'full-access') !== grant.agentTrust ||
      thread.approvalPolicy !== grant.approvalPolicy || authority.permissionExpiresAt && Date.parse(authority.permissionExpiresAt) <= Date.parse(this.deps.nowIso())) fail('原计划的工作区、Agent 或授权范围已变化，请核对后再执行。')
    if (grant.browserScope) {
      const browser = this.deps.browserState?.()
      if (!browser || !browser.enabled || browser.browserInstanceId !== grant.browserScope.browserInstanceId || browser.revision !== grant.browserScope.revision) fail('计划绑定的浏览器或授权来源已变化，请核对原计划。')
    }
    const identities = this.deps.connectorIdentities()
    if (Object.entries(grant.connectorIdentityFingerprints ?? {}).some(([id, identity]) => identities[id] !== identity)) fail('计划绑定的连接器身份已变化，请核对原计划。')
  }

  private authority(flow: FlowDefinitionV1): ScheduledTaskAuthority {
    const authority = flow.variables.taskSchedule as ScheduledTaskAuthority | undefined
    if (!authority?.grant || !authority.requirement) fail('计划缺少原始任务授权。')
    return authority
  }

  private snapshot(flow: FlowDefinitionV1) {
    const trigger = this.deps.flows.repository.getTriggerState(flow.id, 'schedule')
    const authority = this.authority(flow)
    return { id: flow.id, requirement: authority.requirement, schedule: flow.nodes.find(node => node.id === 'schedule')?.config,
      enabled: trigger?.enabled === true && flow.variables.archived !== true, nextRunAt: trigger?.nextRunAt,
      workspaceRoot: flow.workspace, sourceTaskId: authority.taskId }
  }
}
