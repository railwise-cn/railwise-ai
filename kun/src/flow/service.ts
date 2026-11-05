import type { FlowDefinitionV1, FlowNodeRegistryEntryV1, FlowRunV1 } from '../contracts/flow.js'
import { FLOW_INVOCATION_DEPTH_LIMIT } from '../contracts/flow.js'
import { FlowExecutor } from './executor.js'
import { FlowRepository } from './repository.js'
import { validateFlowDefinition } from './validator.js'
import type { FlowWebhookSecurity } from './webhook-security.js'

export class FlowRuntimeService {
  readonly executor: FlowExecutor
  private scheduleTimer?: ReturnType<typeof setInterval>
  constructor(readonly repository: FlowRepository, readonly registry: FlowNodeRegistryEntryV1[], adapters: ConstructorParameters<typeof FlowExecutor>[1], nowIso?: () => string, readonly webhooks?: FlowWebhookSecurity, defaultModelProviderId = 'deepseek') {
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
      if (task.model !== 'deepseek-v4-pro' && task.model !== 'deepseek-v4-flash') continue
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
  publish(flowId: string) { const definition = this.repository.get(flowId); if (!definition) throw new Error(`flow not found: ${flowId}`); const validation = this.validate(definition); if (!validation.valid) return { published: false as const, validation }; const version = this.repository.publish(flowId); this.activateScheduleTriggers(definition); return { published: true as const, version, validation } }
  run(flowId: string, input: unknown, invocationStack: string[] = []) { if (invocationStack.length >= FLOW_INVOCATION_DEPTH_LIMIT || invocationStack.includes(flowId)) throw new Error('recursive Flow invocation rejected'); return this.executor.start(flowId, input, invocationStack) }
  history(flowId: string, limit?: number) { return this.repository.listRuns(flowId, limit) }
  versions(flowId: string) { if (!this.repository.get(flowId)) throw new Error(`flow not found: ${flowId}`); return this.repository.listVersions(flowId) }
  runDetails(runId: string) { const run = this.repository.getRun(runId); return run ? { run, nodeRuns: this.repository.listNodeRuns(runId), events: this.repository.listEvents(runId) } : null }
  cancel(runId: string) { return this.executor.cancel(runId) }
  resume(runId: string) { return this.executor.resume(runId) }
  testNode(definition: FlowDefinitionV1, nodeId: string, input: unknown) { return this.executor.testNode(definition, nodeId, input) }
  decide(runId: string, nodeId: string, decision: 'approve' | 'reject', note?: string) {
    const waiting = this.repository.listNodeRuns(runId).filter((item) => item.nodeId === nodeId && item.status === 'waiting_approval').at(-1)
    if (!waiting) throw new Error('approval wait not found')
    const runBeforeDecision = this.repository.getRun(runId); const version = runBeforeDecision ? this.repository.getVersion(runBeforeDecision.versionId) : null; const node = version?.definition.nodes.find((item) => item.id === nodeId)
    if (decision === 'approve' && node?.type === 'restricted_code' && runBeforeDecision) {
      const current = Array.isArray(runBeforeDecision.checkpoint?.restrictedCodePermissionGrants) ? runBeforeDecision.checkpoint.restrictedCodePermissionGrants.filter((item): item is string => typeof item === 'string') : []
      this.repository.deleteNodeRuns(runId, [nodeId]); this.repository.saveRun({ ...runBeforeDecision, status: 'waiting_approval', checkpoint: { ...runBeforeDecision.checkpoint, restrictedCodePermissionGrants: [...new Set([...current, nodeId])] }, updatedAt: new Date().toISOString() })
      return this.executor.resume(runId)
    }
    this.repository.saveNodeRun({ ...waiting, status: decision === 'approve' ? 'succeeded' : 'failed', output: { decision, note }, error: decision === 'reject' ? 'Approval rejected' : undefined, completedAt: new Date().toISOString() })
    if (decision === 'reject') { const run = this.repository.getRun(runId); if (run) this.repository.saveRun({ ...run, status: 'failed', output: { error: 'Approval rejected', nodeId }, updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() }); return run }
    return this.executor.resume(runId)
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
  async handleWebhook(triggerId: string, request: Request) { if (!this.webhooks) throw new Error('Webhook security is unavailable'); const verified = await this.webhooks.verify(triggerId, request); return this.run(verified.flowId, { triggerNodeId: verified.nodeId, payload: verified.input }) }
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
  listLegacySchedules(): LegacyScheduledTaskInput[] { return this.scheduleMigration().compatibilityTasks }
  createLegacySchedule(task: LegacyScheduledTaskInput): LegacyScheduledTaskInput {
    const migration = this.scheduleMigration(); if (migration.mappings.some((item) => item.taskId === task.id)) throw new Error(`schedule task already exists: ${task.id}`)
    const flowId = `flow_schedule_${task.id.replace(/[^A-Za-z0-9_-]/g, '_')}`; const definition = this.repository.create(legacyScheduleFlow(flowId, task)); const validation = this.validate(definition); if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join('; ')); this.repository.publish(flowId)
    this.repository.saveTriggerState({ flowId, nodeId: 'schedule', enabled: task.enabled, ...(task.nextRunAt ? { nextRunAt: task.nextRunAt } : {}), ...(task.lastRunAt ? { lastRunAt: task.lastRunAt } : {}), state: { legacyTaskId: task.id, lastStatus: task.lastStatus, lastMessage: task.lastMessage, lastThreadId: task.lastThreadId } })
    this.saveScheduleMigration({ ...migration, mappings: [...migration.mappings, { taskId: task.id, flowId }], compatibilityTasks: [...migration.compatibilityTasks, task] }); return task
  }
  updateLegacySchedule(taskId: string, task: LegacyScheduledTaskInput): LegacyScheduledTaskInput {
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
    let started = 0
    for (const trigger of this.repository.listAllTriggerStates().filter((item) => item.enabled)) {
      const flow = this.repository.get(trigger.flowId); const node = flow?.nodes.find((item) => item.id === trigger.nodeId && item.type === 'schedule_trigger'); if (!flow?.publishedVersionId || !node || flow.variables.archived === true) continue
      const kind = String(node.config.kind ?? 'manual'); if (kind === 'manual') continue
      const due = trigger.nextRunAt ? Date.parse(trigger.nextRunAt) : NaN; if (!Number.isFinite(due) || due > now.getTime()) continue
      const next = nextScheduleOccurrence(node.config, now)
      const { nextRunAt: _previousNextRunAt, ...triggerWithoutNext } = trigger
      this.repository.saveTriggerState({ ...triggerWithoutNext, enabled: kind === 'at' ? false : trigger.enabled, lastRunAt: now.toISOString(), ...(next ? { nextRunAt: next } : {}), state: { ...trigger.state, lastDispatchAt: now.toISOString() } })
      await this.run(trigger.flowId, { triggerNodeId: trigger.nodeId, scheduledAt: trigger.nextRunAt, dispatchedAt: now.toISOString() }); started += 1
    }
    return started
  }
  shutdown() { if (this.scheduleTimer) clearInterval(this.scheduleTimer); this.scheduleTimer = undefined; this.executor.checkpointActiveRuns(); this.repository.close() }
  private scheduleMigration(): ScheduleMigrationRecord { const raw = this.repository.getMigration('schedule-to-flow-v1'); if (!raw || typeof raw !== 'object') throw new Error('schedule migration not completed'); const value = raw as Partial<ScheduleMigrationRecord>; return { version: 1, migratedAt: String(value.migratedAt ?? ''), mappings: Array.isArray(value.mappings) ? value.mappings : [], compatibilityTasks: Array.isArray(value.compatibilityTasks) ? value.compatibilityTasks : Array.isArray(value.readOnlyBackup) ? value.readOnlyBackup : [], readOnlyBackup: Array.isArray(value.readOnlyBackup) ? value.readOnlyBackup : [], archivedMappings: Array.isArray(value.archivedMappings) ? value.archivedMappings : [] } }
  private saveScheduleMigration(value: ScheduleMigrationRecord): void { this.repository.saveMigration('schedule-to-flow-v1', value) }
  private activateScheduleTriggers(definition: FlowDefinitionV1): void { for (const node of definition.nodes.filter((item) => item.type === 'schedule_trigger')) { const current = this.repository.getTriggerState(definition.id, node.id); const nextRunAt = current?.nextRunAt ?? nextScheduleOccurrence(node.config, new Date()); this.repository.saveTriggerState({ flowId: definition.id, nodeId: node.id, enabled: current?.enabled ?? definition.variables.enabled !== false, ...(nextRunAt ? { nextRunAt } : {}), state: current?.state ?? {} }) } }
}

export type LegacyScheduledTaskInput = {
  id: string; title: string; enabled: boolean; prompt: string; workspaceRoot: string; model: string; reasoningEffort: string; mode: string
  schedule: { kind: string; everyMinutes: number; timeOfDay: string; atTime: string }
  createdAt: string; updatedAt: string; lastRunAt: string; nextRunAt: string; lastStatus: string; lastMessage: string; lastThreadId: string
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
function nextScheduleOccurrence(config: Record<string, unknown>, from: Date): string | undefined { const kind = String(config.kind ?? 'manual'); if (kind === 'manual') return undefined; if (kind === 'at') { const value = String(config.atTime ?? ''); const time = Date.parse(value); return Number.isFinite(time) && time > from.getTime() ? value : undefined } if (kind === 'interval') return new Date(from.getTime() + Math.max(1, Number(config.everyMinutes) || 60) * 60_000).toISOString(); if (kind === 'daily') { const match = String(config.timeOfDay ?? '09:00').match(/^(\d{1,2}):(\d{2})$/); if (!match) return undefined; const next = new Date(from); next.setHours(Number(match[1]), Number(match[2]), 0, 0); if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1); return next.toISOString() } return undefined }

function descendants(definition: FlowDefinitionV1, start: string): Set<string> { const result = new Set([start]); const queue = [start]; while (queue.length) { const id = queue.shift()!; for (const edge of definition.edges.filter((item) => item.sourceNodeId === id)) if (!result.has(edge.targetNodeId)) { result.add(edge.targetNodeId); queue.push(edge.targetNodeId) } } return result }
function redact(value: unknown, key = ''): unknown { if (/secret|token|password|credential|api.?key/i.test(key)) return '${' + (key || 'secret') + '}'; if (typeof value === 'string') { if (/^(?:[A-Za-z]:[\\/]|\/)/.test(value)) return '${LOCAL_PATH}'; return value } if (Array.isArray(value)) return value.map((item) => redact(item)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([entry]) => !/attachmentContent/i.test(entry)).map(([entry, item]) => [entry, redact(item, entry)])); return value }
