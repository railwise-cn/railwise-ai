import type { FlowDefinitionV1, FlowNodeRegistryEntryV1, FlowRunV1 } from '../contracts/flow.js'
import { FLOW_INVOCATION_DEPTH_LIMIT } from '../contracts/flow.js'
import { FlowExecutor } from './executor.js'
import { FlowRepository, type FlowSourceEvent, type FlowAttentionEvent } from './repository.js'
import { createHash } from 'node:crypto'
import { validateFlowDefinition } from './validator.js'
import type { FlowWebhookSecurity } from './webhook-security.js'
import { nextScheduleOccurrence, normalizeScheduleSpec } from '../contracts/schedule.js'
import type { ScheduledTaskDispatch } from '../services/task-schedule-service.js'

export class FlowRuntimeService {
  readonly executor: FlowExecutor
  private scheduleTimer?: ReturnType<typeof setInterval>
  private sourceEventSink?: (event: FlowSourceEvent) => Promise<void>
  private taskScheduleDispatcher?: (input: ScheduledTaskDispatch) => Promise<void>
  private attentionSink?: (event: FlowAttentionEvent) => Promise<void>
  private flushingSources?: Promise<void>
  private flushSourcesRequested = false
  private backgroundDispatchEnabled = true
  private closed = false
  private updateSuspended = false

  setUpdateSuspended(suspended: boolean): void {
    this.updateSuspended = suspended
    this.executor.setAdmissionSuspended(suspended)
    if (!suspended) void this.flushSourceEvents().catch(() => undefined)
  }

  async awaitSourceDispatch(): Promise<void> { await this.flushingSources }

  private readonly stopProjection: () => void
  constructor(readonly repository: FlowRepository, readonly registry: FlowNodeRegistryEntryV1[], adapters: ConstructorParameters<typeof FlowExecutor>[1], nowIso?: () => string, readonly webhooks?: FlowWebhookSecurity, defaultModelProviderId = 'deepseek', backgroundDispatchEnabled = true) {
    this.backgroundDispatchEnabled = backgroundDispatchEnabled
    this.stopProjection = repository.onChange(() => { if (!this.closed && repository.isOpen()) void this.flushSourceEvents().catch(() => undefined) })
    this.executor = new FlowExecutor(repository, adapters, nowIso)
    this.executor.reconcileStartup()
    this.migrateRetiredLegacyScheduleModels(defaultModelProviderId)
  }
  private migrateRetiredLegacyScheduleModels(providerId: string): void {
    if (providerId !== 'deepseek') return
    const raw = this.repository.getMigration('schedule-to-flow-v1')
    if (!raw || typeof raw !== 'object') return
    const migration = raw as Partial<ScheduleMigrationRecord>
    const tasks = Array.isArray(migration.compatibilityTasks) ? migration.compatibilityTasks : []
    for (const task of tasks) {
      if (!isRetiredBuiltInDeepSeekModel(task.model)) continue
      this.updateLegacySchedule(task.id, {
        ...task,
        model: 'deepseek-flash',
        updatedAt: new Date().toISOString()
      })
    }
  }
  list() { return this.repository.list() }
  get(id: string) { return this.repository.get(id) }
  create(input: Omit<FlowDefinitionV1, 'revision' | 'createdAt' | 'updatedAt'>) { return this.repository.create(input) }
  update(definition: FlowDefinitionV1, expectedRevision: number) { return this.repository.update(definition, expectedRevision) }
  validate(definition: FlowDefinitionV1) { return validateFlowDefinition(definition, this.registry) }
  publish(flowId: string) { const definition = this.repository.get(flowId); if (!definition) throw new Error(`flow not found: ${flowId}`); const validation = this.validate(definition); if (!validation.valid) return { published: false as const, validation }; const previous = definition.publishedVersionId ? this.repository.getVersion(definition.publishedVersionId)?.definition : undefined; const version = this.repository.publish(flowId); this.activateScheduleTriggers(definition, previous); return { published: true as const, version, validation } }
  run(flowId: string, input: unknown, invocationStack: string[] = []) { if (invocationStack.length >= FLOW_INVOCATION_DEPTH_LIMIT || invocationStack.includes(flowId)) throw new Error('recursive Flow invocation rejected'); return this.executor.start(flowId, input, invocationStack) }
  history(flowId: string, limit?: number) { return this.repository.listRuns(flowId, limit) }
  versions(flowId: string) { if (!this.repository.get(flowId)) throw new Error(`flow not found: ${flowId}`); return this.repository.listVersions(flowId) }
  runDetails(runId: string) { const run = this.repository.getRun(runId); return run ? { run, nodeRuns: this.repository.listNodeRuns(runId), events: this.repository.listEvents(runId) } : null }
  cancel(runId: string) { return this.executor.cancel(runId) }
  resume(runId: string) { return this.executor.resume(runId) }
  testNode(definition: FlowDefinitionV1, nodeId: string, input: unknown) { return this.executor.testNode(definition, nodeId, input) }
  decide(runId: string, nodeId: string, decision: 'approve' | 'reject', note?: string) {
    let resumeOutboxId = ''
    const accepted = this.repository.transaction(() => {
      const waiting = this.repository.listNodeRuns(runId).filter(item => item.nodeId === nodeId).at(-1)
      if (!waiting) throw new Error('approval wait not found')
      // One receipt belongs to one immutable approval occurrence. A later retry
      // of the same node requires a new decision and cannot inherit an old one.
      const legacyKey = `decision:${nodeId}`
      const key = waiting.status !== 'waiting_approval' && this.repository.operation(runId, legacyKey) ? legacyKey : `${legacyKey}:${waiting.id}`
      const receipt = this.repository.beginOperation(runId, key, { nodeId, decision, note })
      if (!receipt.created) return false
      if (waiting.status !== 'waiting_approval') throw new Error('approval wait not found')
      const run = this.repository.getRun(runId)
      if (!run || run.status !== 'waiting_approval') throw new Error('Flow is not waiting for approval')
      const node = this.repository.getVersion(run.versionId)?.definition.nodes.find(item => item.id === nodeId)
      const now = new Date().toISOString()
      if (decision === 'approve' && node?.type === 'restricted_code') {
        const grants = Array.isArray(run.checkpoint?.restrictedCodePermissionGrants) ? run.checkpoint.restrictedCodePermissionGrants.filter((item): item is string => typeof item === 'string') : []
        this.repository.deleteNodeRuns(runId, [nodeId])
        this.repository.saveRun({ ...run, checkpoint: { ...run.checkpoint, restrictedCodePermissionGrants: [...new Set([...grants, nodeId])] }, updatedAt: now })
      } else {
        this.repository.saveNodeRun({ ...waiting, status: decision === 'approve' ? 'succeeded' : 'failed', output: { decision, note }, error: decision === 'reject' ? 'Approval rejected' : undefined, completedAt: now })
        if (decision === 'reject') this.repository.saveRun({ ...run, status: 'failed', output: { error: 'Approval rejected', nodeId }, updatedAt: now, completedAt: now })
      }
      this.repository.finishOperation(runId, key, 'succeeded', { decision, nodeId })
      if (decision === 'approve') {
        resumeOutboxId = `resume:${runId}:${nodeId}:${waiting.id}`
        this.repository.enqueueOutbox(resumeOutboxId, runId, 'flow_resume', { runId })
      }
      return true
    })
    if (!accepted || decision === 'reject') return this.repository.getRun(runId)
    return this.executor.resume(runId).then(run => { this.repository.acknowledgeOutbox(resumeOutboxId); return run })
  }
  retryFrom(runId: string, nodeId: string) {
    const run = this.repository.getRun(runId); if (!run) throw new Error(`run not found: ${runId}`)
    const version = this.repository.getVersion(run.versionId); if (!version) throw new Error('Flow version not found')
    const reset = descendants(version.definition, nodeId); this.repository.deleteNodeRuns(runId, [...reset])
    this.repository.saveRun({ ...run, status: 'failed', checkpoint: { retryFrom: nodeId }, updatedAt: new Date().toISOString(), completedAt: undefined })
    return this.executor.resume(runId)
  }
  exportRedacted(flowId: string) { const definition = this.repository.get(flowId); if (!definition) throw new Error(`flow not found: ${flowId}`); return redact(definition) }
  provisionWebhook(flowId: string, nodeId: string) { const flow = this.repository.get(flowId); if (!flow?.nodes.some((node) => node.id === nodeId && node.type === 'webhook_trigger')) throw new Error('Webhook trigger node not found'); if (!this.webhooks) throw new Error('Webhook security is unavailable'); return this.webhooks.provision(flowId, nodeId) }
  async handleWebhook(triggerId: string, request: Request) {
    if (!this.webhooks) throw new Error('Webhook security is unavailable')
    const verified = await this.webhooks.verifyForReceipt(triggerId, request)
    const sourceKey = `${triggerId}:${verified.nonce}`
    const previous = this.repository.getSourceEvent('webhook', sourceKey)
    if (previous) {
      if (previous.fingerprint !== verified.fingerprint) throw new Error('Webhook receipt is bound to another request')
      await this.flushSourceEvents()
      return this.repository.getRun(previous.runId)!
    }
    const flow = this.repository.get(verified.flowId)
    if (!flow?.publishedVersionId || flow.variables.archived === true) throw new Error('Webhook Flow is not published')
    const accepted = this.repository.acceptSourceEvent({ source: 'webhook', sourceKey, fingerprint: verified.fingerprint, flowId: flow.id, versionId: flow.publishedVersionId, workspaceRoot: flow.workspace, input: { triggerNodeId: verified.nodeId, payload: verified.input } }, { triggerId, value: verified.nonce, acceptedAt: verified.acceptedAt })
    await this.flushSourceEvents()
    return this.repository.getRun(accepted.event.runId)!
  }

  setTaskScheduleDispatcher(dispatch: (input: ScheduledTaskDispatch) => Promise<void>): void {
    this.taskScheduleDispatcher = dispatch
    void this.flushSourceEvents().catch(() => undefined)
  }

  setSourceEventSink(sink: (event: FlowSourceEvent) => Promise<void>): void {
    this.sourceEventSink = sink
    void this.flushSourceEvents().catch(() => undefined)
  }

  setAttentionSink(sink: (event: FlowAttentionEvent) => Promise<void>): void {
    this.attentionSink = sink
    this.repository.reconcileAttention()
    void this.flushSourceEvents().catch(() => undefined)
  }

  /** Rollback keeps accepted source events and attention readable, without starting background work. */
  setBackgroundDispatchEnabled(enabled: boolean): void {
    this.backgroundDispatchEnabled = enabled
    if (enabled) void this.flushSourceEvents().catch(() => undefined)
  }

  /** Acknowledgement follows durable run creation / destination input commit. */
  flushSourceEvents(): Promise<void> {
    this.flushSourcesRequested = true
    if (this.flushingSources) return this.flushingSources
    this.flushingSources = (async () => {
      do {
        this.flushSourcesRequested = false
        if (this.backgroundDispatchEnabled && !this.updateSuspended) for (const item of this.repository.pendingOutbox('flow_source_dispatch')) {
          const payload = item.payload as { runId: string }
          this.executor.dispatchQueued(payload.runId)
          this.repository.acknowledgeOutbox(item.id)
        }
        if (this.backgroundDispatchEnabled && !this.updateSuspended && this.taskScheduleDispatcher) {
          for (const item of this.repository.pendingOutbox('scheduled_task_dispatch')) {
            try {
              await this.taskScheduleDispatcher(item.payload as ScheduledTaskDispatch)
              this.repository.acknowledgeOutbox(item.id)
            } catch { /* Preserve the occurrence and its task attention for a later bounded retry. */ }
          }
        }
        if (this.backgroundDispatchEnabled && !this.updateSuspended && this.sourceEventSink) for (const item of this.repository.pendingOutbox('task_source_event')) {
          if (this.updateSuspended) break
          await this.sourceEventSink(item.payload as FlowSourceEvent)
          this.repository.acknowledgeOutbox(item.id)
        }
        if (this.attentionSink) for (const item of this.repository.pendingOutbox('flow_attention')) {
          await this.attentionSink(item.payload as FlowAttentionEvent)
          this.repository.acknowledgeOutbox(item.id)
        }
      } while (this.flushSourcesRequested && !this.closed)
    })().then(() => {
      this.flushingSources = undefined
      // A repository listener may request another flush between the last loop
      // condition and this continuation. Do not strand that persisted event.
      if (this.flushSourcesRequested && !this.closed) return this.flushSourceEvents()
    }, error => {
      this.flushingSources = undefined
      throw error
    })
    return this.flushingSources
  }
  migrateLegacySchedules(tasks: LegacyScheduledTaskInput[]) {
    const migrationKey = 'schedule-to-flow-v1'; const completed = this.repository.getMigration(migrationKey)
    if (completed) return { migrated: false as const, idempotent: true as const, result: completed }
    const mappings: Array<{ taskId: string; flowId: string }> = []
    for (const task of tasks) {
      const flowId = `flow_schedule_${task.id.replace(/[^A-Za-z0-9_-]/g, '_')}`; const existing = this.repository.get(flowId)
      if (existing && existing.variables.legacyScheduleTaskId !== task.id) throw new Error(`Flow id collision while migrating schedule task ${task.id}`)
      if (!existing) {
        const definition = this.repository.create(legacyScheduleFlow(flowId, task)); const validation = this.validate(definition)
        if (!validation.valid) throw new Error(`Migrated schedule task ${task.id} is invalid: ${validation.issues.map((issue) => issue.message).join('; ')}`)
        this.repository.publish(flowId)
      }
      this.repository.saveTriggerState({ flowId, nodeId: 'schedule', enabled: task.enabled, ...(task.nextRunAt ? { nextRunAt: task.nextRunAt } : {}), ...(task.lastRunAt ? { lastRunAt: task.lastRunAt } : {}), state: { legacyTaskId: task.id, lastStatus: task.lastStatus, lastMessage: task.lastMessage, lastThreadId: task.lastThreadId } })
      mappings.push({ taskId: task.id, flowId })
    }
    const result = { version: 1, migratedAt: new Date().toISOString(), mappings, compatibilityTasks: tasks, readOnlyBackup: tasks }
    this.repository.setMigration(migrationKey, result)
    return { migrated: true as const, idempotent: false as const, result }
  }
  listLegacySchedules(): LegacyScheduledTaskInput[] {
    const migration = this.scheduleMigration()
    return migration.compatibilityTasks.map(task => {
      const flowId = migration.mappings.find(mapping => mapping.taskId === task.id)?.flowId
      const state = flowId ? this.repository.getTriggerState(flowId, 'schedule') : undefined
      return state ? { ...task, nextRunAt: state.nextRunAt ?? '', lastRunAt: state.lastRunAt ?? task.lastRunAt } : task
    })
  }
  createLegacySchedule(task: LegacyScheduledTaskInput): LegacyScheduledTaskInput {
    task = { ...task, nextRunAt: task.enabled ? task.nextRunAt || nextScheduleOccurrence(task.schedule, new Date()) || '' : '' }
    const migration = this.scheduleMigration(); if (migration.mappings.some((item) => item.taskId === task.id)) throw new Error(`schedule task already exists: ${task.id}`)
    const flowId = `flow_schedule_${task.id.replace(/[^A-Za-z0-9_-]/g, '_')}`; const definition = this.repository.create(legacyScheduleFlow(flowId, task)); const validation = this.validate(definition); if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join('; ')); this.repository.publish(flowId)
    this.repository.saveTriggerState({ flowId, nodeId: 'schedule', enabled: task.enabled, ...(task.nextRunAt ? { nextRunAt: task.nextRunAt } : {}), ...(task.lastRunAt ? { lastRunAt: task.lastRunAt } : {}), state: { legacyTaskId: task.id, lastStatus: task.lastStatus, lastMessage: task.lastMessage, lastThreadId: task.lastThreadId } })
    this.saveScheduleMigration({ ...migration, mappings: [...migration.mappings, { taskId: task.id, flowId }], compatibilityTasks: [...migration.compatibilityTasks, task] }); return task
  }
  updateLegacySchedule(taskId: string, task: LegacyScheduledTaskInput): LegacyScheduledTaskInput {
    task = { ...task, nextRunAt: task.enabled ? nextScheduleOccurrence(task.schedule, new Date()) ?? '' : '' }
    const migration = this.scheduleMigration(); const mapping = migration.mappings.find((item) => item.taskId === taskId); if (!mapping) throw new Error(`schedule task not found: ${taskId}`)
    const current = this.repository.get(mapping.flowId); if (!current) throw new Error(`mapped Flow not found: ${mapping.flowId}`)
    const desired = legacyScheduleFlow(mapping.flowId, { ...task, id: taskId }); const updated = this.repository.update({ ...current, ...desired, revision: current.revision, createdAt: current.createdAt, updatedAt: current.updatedAt, publishedVersionId: current.publishedVersionId }, current.revision); const validation = this.validate(updated); if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join('; ')); this.repository.publish(mapping.flowId)
    this.repository.saveTriggerState({ flowId: mapping.flowId, nodeId: 'schedule', enabled: task.enabled, ...(task.nextRunAt ? { nextRunAt: task.nextRunAt } : {}), ...(task.lastRunAt ? { lastRunAt: task.lastRunAt } : {}), state: { legacyTaskId: taskId, lastStatus: task.lastStatus, lastMessage: task.lastMessage, lastThreadId: task.lastThreadId } })
    const saved = { ...task, id: taskId }; this.saveScheduleMigration({ ...migration, compatibilityTasks: migration.compatibilityTasks.map((item) => item.id === taskId ? saved : item) }); return saved
  }
  async runLegacySchedule(taskId: string) { const mapping = this.scheduleMigration().mappings.find((item) => item.taskId === taskId); if (!mapping) throw new Error(`schedule task not found: ${taskId}`); return this.run(mapping.flowId, { source: 'legacy_schedule_compatibility', taskId }) }
  archiveLegacySchedule(taskId: string): boolean {
    const migration = this.scheduleMigration(); const mapping = migration.mappings.find((item) => item.taskId === taskId); if (!mapping) return false
    const current = this.repository.get(mapping.flowId); if (current) { this.repository.update({ ...current, variables: { ...current.variables, archived: true }, revision: current.revision }, current.revision); const trigger = this.repository.getTriggerState(mapping.flowId, 'schedule'); if (trigger) this.repository.saveTriggerState({ ...trigger, enabled: false }) }
    this.saveScheduleMigration({ ...migration, mappings: migration.mappings.filter((item) => item.taskId !== taskId), compatibilityTasks: migration.compatibilityTasks.filter((item) => item.id !== taskId), archivedMappings: [...migration.archivedMappings, mapping] }); return true
  }
  archive(flowId: string): FlowDefinitionV1 { const current = this.repository.get(flowId); if (!current) throw new Error(`flow not found: ${flowId}`); const archived = this.repository.update({ ...current, variables: { ...current.variables, archived: true }, revision: current.revision }, current.revision); for (const trigger of this.repository.listTriggerStates(flowId)) this.repository.saveTriggerState({ ...trigger, enabled: false }); return archived }
  startSchedules(intervalMs = 30_000): void { if (this.scheduleTimer) return; this.scheduleTimer = setInterval(() => { void this.tickSchedules().catch(() => undefined) }, intervalMs); this.scheduleTimer.unref?.(); void this.tickSchedules().catch(() => undefined) }
  async tickSchedules(now = new Date()): Promise<number> {
    if (!this.backgroundDispatchEnabled || this.updateSuspended) return 0
    let started = 0
    for (const trigger of this.repository.listAllTriggerStates().filter((item) => item.enabled)) {
      const flow = this.repository.get(trigger.flowId); const node = flow?.nodes.find((item) => item.id === trigger.nodeId && item.type === 'schedule_trigger'); if (!flow?.publishedVersionId || !node || flow.variables.archived === true) continue
      const kind = normalizeScheduleSpec(node.config).kind; if (kind === 'manual') continue
      const due = trigger.nextRunAt ? Date.parse(trigger.nextRunAt) : NaN; if (!Number.isFinite(due) || due > now.getTime()) continue
      const next = nextScheduleOccurrence(node.config, now)
      const { nextRunAt: _previousNextRunAt, ...triggerWithoutNext } = trigger
      if (flow.variables.taskSchedule) {
        this.repository.transaction(() => {
          const key = `schedule:${flow.id}:${trigger.nextRunAt}`
          const accepted = this.repository.beginOperation(flow.id, key, { dueAt: trigger.nextRunAt, versionId: flow.publishedVersionId })
          if (accepted.created) {
            this.repository.enqueueOutbox(key, flow.id, 'scheduled_task_dispatch', { scheduleId: flow.id, versionId: flow.publishedVersionId, dueAt: trigger.nextRunAt })
            this.repository.finishOperation(flow.id, key, 'succeeded', { dueAt: trigger.nextRunAt })
            started += 1
          }
          this.repository.saveTriggerState({ ...triggerWithoutNext, enabled: kind === 'at' ? false : trigger.enabled,
            lastRunAt: now.toISOString(), ...(next ? { nextRunAt: next } : {}), state: trigger.state })
        })
        continue
      }
      const input = { triggerNodeId: trigger.nodeId, scheduledAt: trigger.nextRunAt, dispatchedAt: now.toISOString() }
      const accepted = this.repository.acceptSourceEvent({ source: 'schedule', sourceKey: `${trigger.flowId}:${trigger.nodeId}:${trigger.nextRunAt}`, fingerprint: createHash('sha256').update(`${trigger.flowId}:${trigger.nodeId}:${trigger.nextRunAt}`).digest('hex'), flowId: trigger.flowId, versionId: flow.publishedVersionId, workspaceRoot: flow.workspace, input }, undefined, () => {
        this.repository.saveTriggerState({ ...triggerWithoutNext, enabled: kind === 'at' ? false : trigger.enabled, lastRunAt: now.toISOString(), ...(next ? { nextRunAt: next } : {}), state: { ...trigger.state, lastDispatchAt: now.toISOString() } })
      })
      if (accepted.created) started += 1
    }
    await this.flushSourceEvents()
    return started
  }
  shutdown() { this.closed = true; this.stopProjection(); if (this.scheduleTimer) clearInterval(this.scheduleTimer); this.scheduleTimer = undefined; this.executor.checkpointActiveRuns(); this.repository.close() }
  private scheduleMigration(): ScheduleMigrationRecord { const raw = this.repository.getMigration('schedule-to-flow-v1'); if (!raw || typeof raw !== 'object') throw new Error('schedule migration not completed'); const value = raw as Partial<ScheduleMigrationRecord>; return { version: 1, migratedAt: String(value.migratedAt ?? ''), mappings: Array.isArray(value.mappings) ? value.mappings : [], compatibilityTasks: Array.isArray(value.compatibilityTasks) ? value.compatibilityTasks : Array.isArray(value.readOnlyBackup) ? value.readOnlyBackup : [], readOnlyBackup: Array.isArray(value.readOnlyBackup) ? value.readOnlyBackup : [], archivedMappings: Array.isArray(value.archivedMappings) ? value.archivedMappings : [] } }
  private saveScheduleMigration(value: ScheduleMigrationRecord): void { this.repository.saveMigration('schedule-to-flow-v1', value) }
  private activateScheduleTriggers(definition: FlowDefinitionV1, previous?: FlowDefinitionV1): void {
    for (const node of definition.nodes.filter(item => item.type === 'schedule_trigger')) {
      const current = this.repository.getTriggerState(definition.id, node.id)
      const scheduleHash = createHash('sha256').update(JSON.stringify(normalizeScheduleSpec(node.config))).digest('hex')
      const previousNode = previous?.nodes.find(item => item.id === node.id)
      const previousHash = previousNode ? createHash('sha256').update(JSON.stringify(normalizeScheduleSpec(previousNode.config))).digest('hex') : undefined
      const unchanged = (current?.state.scheduleHash ?? previousHash) === scheduleHash
      const nextRunAt = unchanged && current?.nextRunAt ? current.nextRunAt : nextScheduleOccurrence(node.config, new Date())
      this.repository.saveTriggerState({ flowId: definition.id, nodeId: node.id, enabled: !node.disabled && definition.variables.enabled !== false,
        ...(nextRunAt ? { nextRunAt } : {}), state: { ...current?.state, scheduleHash } })
    }
  }
}

export type LegacyScheduledTaskInput = {
  id: string; title: string; enabled: boolean; prompt: string; workspaceRoot: string; model: string; reasoningEffort: string; mode: string
  schedule: { kind: string; everyMinutes: number; timeOfDay: string; atTime: string; times?: string[]; timezone?: string }
  createdAt: string; updatedAt: string; lastRunAt: string; nextRunAt: string; lastStatus: string; lastMessage: string; lastThreadId: string
}
function isRetiredBuiltInDeepSeekModel(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return normalized === 'deepseek-chat' || normalized === 'deepseek-reasoner' || normalized.startsWith('deepseek-v4-')
}
type ScheduleMigrationRecord = { version: 1; migratedAt: string; mappings: Array<{ taskId: string; flowId: string }>; compatibilityTasks: LegacyScheduledTaskInput[]; readOnlyBackup: LegacyScheduledTaskInput[]; archivedMappings: Array<{ taskId: string; flowId: string }> }

function legacyScheduleFlow(flowId: string, task: LegacyScheduledTaskInput): Omit<FlowDefinitionV1, 'revision' | 'createdAt' | 'updatedAt'> {
  const policy = { timeoutMs: 120_000, retryAttempts: 0, retryBackoffMs: 1_000, errorBehavior: 'fail' as const, concurrencyLimit: 1, resumable: true, breakpoint: false }
  return {
    schemaVersion: 1, id: flowId, name: task.title, description: `Migrated from scheduled task ${task.id}`,
    nodes: [
      { id: 'schedule', type: 'schedule_trigger', label: 'Schedule', position: { x: 80, y: 120 }, bindings: {}, config: { ...task.schedule, nextRunAt: task.nextRunAt }, policy, disabled: false },
      { id: 'agent', type: 'agent', label: 'Agent', position: { x: 380, y: 120 }, bindings: { prompt: { kind: 'literal', value: task.prompt } }, config: { prompt: task.prompt, model: task.model, reasoningEffort: task.reasoningEffort, mode: task.mode, workspaceRoot: task.workspaceRoot }, policy, disabled: false }
    ],
    edges: [{ id: 'schedule-agent', sourceNodeId: 'schedule', sourcePortId: 'output', targetNodeId: 'agent', targetPortId: 'input', branch: 'normal' }],
    variables: { enabled: task.enabled, legacyScheduleTaskId: task.id, legacyLastThreadId: task.lastThreadId }, workspace: task.workspaceRoot
  }
}

function descendants(definition: FlowDefinitionV1, start: string): Set<string> { const result = new Set([start]); const queue = [start]; while (queue.length) { const id = queue.shift()!; for (const edge of definition.edges.filter((item) => item.sourceNodeId === id)) if (!result.has(edge.targetNodeId)) { result.add(edge.targetNodeId); queue.push(edge.targetNodeId) } } return result }
function redact(value: unknown, key = ''): unknown { if (/secret|token|password|credential|api.?key/i.test(key)) return '${' + (key || 'secret') + '}'; if (typeof value === 'string') { if (/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) return '${LOCAL_PATH}'; return value } if (Array.isArray(value)) return value.map((item) => redact(item)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([entry]) => !/attachmentContent/i.test(entry)).map(([entry, item]) => [entry, redact(item, entry)])); return value }
