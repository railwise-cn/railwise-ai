import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'
import type {
  AppSettingsV1,
  ScheduleReasoningEffort,
  ScheduleRunMode,
  ScheduleRunResult,
  ScheduleRuntimeStatus,
  ScheduleTaskFromTextResult,
  ScheduledTaskV1
} from '../shared/app-settings'
import {
  DEFAULT_SCHEDULE_MODEL,
  buildScheduleRuntimePrompt,
  getManagedRuntimeSettings,
  normalizeScheduleModelForProvider,
  normalizeScheduleReasoningEffort
} from '../shared/app-settings'
import { readLegacyWebhookSecret } from './compat/legacy-http'
import {
  buildScheduledTaskFromDetectedRequest,
  detectClawScheduledTaskRequest
} from './claw-scheduled-task-detector'
import {
  SCHEDULER_INTERVAL_MS,
  TASK_RESPONSE_TIMEOUT_MS,
  asString,
  computeScheduleNextRunAt,
  hasEnabledScheduledTask,
  internalUrl,
  isRunningStatus,
  latestAssistantText,
  nestedRecord,
  normalizeTaskModel,
  parseJsonObject,
  readRequestBody,
  runtimeErrorMessage,
  sleep,
  summarizeTaskResult,
  writeJson,
  type RunPromptOptions,
  type ScheduleRuntimeDeps,
  type ThreadDetailJson,
  type ThreadRecordJson
} from './schedule-runtime-helpers'
import { appCancellationRegistry } from './cancellation-registry'
import { runtimeThreadInterruptPath } from '../shared/runtime-endpoints'

export { computeScheduleNextRunAt } from './schedule-runtime-helpers'

export function scheduledThreadTitle(title: string): string {
  const trimmed = title.trim()
  const prefix = '[Scheduled task]'
  const suffix = Array.from(trimmed).slice(0, 4).join('')
  return suffix ? `${prefix} ${suffix}` : prefix
}

export class ScheduleRuntime {
  private readonly deps: ScheduleRuntimeDeps
  private scheduler: ReturnType<typeof setInterval> | null = null
  private server: Server | null = null
  private serverOwned = false
  private serverRequestHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null
  private serverKey = ''
  private runningTaskIds = new Set<string>()
  private powerSaveBlockerId: number | null = null
  private legacyScheduleModelMigrations = new Map<string, Promise<ScheduledTaskV1[]>>()
  private legacyScheduleModelMigrationQueue: Promise<void> = Promise.resolve()
  private reconcilingWaitingTasks = false
  private waitingTaskCursor = 0

  constructor(deps: ScheduleRuntimeDeps) {
    this.deps = deps
  }

  sync(settings: AppSettingsV1): void {
    this.syncInternalServer(settings)
    this.startScheduler()
    this.syncPowerSaveBlocker(settings)
    void this.ensureNextRuns(settings)
    if (this.usesFlowCompatibility(settings)) {
      void this.listFlowCompatibleTasks(settings).catch((error) => {
        this.deps.logError('schedule-task', 'Failed to migrate legacy Flow model selections', {
          message: error instanceof Error ? error.message : String(error)
        })
      })
    }
  }

  stop(): void {
    if (this.scheduler) {
      clearInterval(this.scheduler)
      this.scheduler = null
    }
    this.closeInternalServer()
    this.stopPowerSaveBlocker()
    for (const taskId of this.runningTaskIds) {
      void appCancellationRegistry.cancel({ scope: 'schedule', id: taskId }, 'schedule_runtime_stopped')
    }
  }

  async status(): Promise<ScheduleRuntimeStatus> {
    const settings = await this.deps.store.load()
    return {
      internalServerRunning: this.server !== null,
      internalUrl: internalUrl(settings),
      runningTaskIds: [...this.runningTaskIds],
      powerSaveBlockerActive: this.isPowerSaveBlockerActive()
    }
  }

  async runTask(taskId: string): Promise<ScheduleRunResult> {
    const settings = await this.deps.store.load()
    if (this.usesFlowCompatibility(settings)) {
      await this.listFlowCompatibleTasks(settings)
      const result = await this.deps.runtimeRequest(settings, `/v1/legacy-schedules/${encodeURIComponent(taskId)}/run`, { method: 'POST', body: '{}' })
      if (!result.ok) return { ok: false, message: runtimeErrorMessage(result, 'Failed to run migrated Flow.') }
      const parsed = parseJsonObject(result.body); const run = nestedRecord(parsed?.run); const runId = asString(run.id)
      return runId ? { ok: true, threadId: runId, message: 'Flow started.' } : { ok: false, message: 'Runtime did not return a Flow run.' }
    }
    const task = settings.schedule.tasks.find((item) => item.id === taskId)
    if (!task) return { ok: false, message: 'Task not found.' }
    return this.runTaskInternal(task, false)
  }

  async createScheduledTaskFromText(
    text: string,
    options: { workspaceRoot?: string | null; modelHint?: string | null; mode?: ScheduleRunMode | null } = {}
  ): Promise<ScheduleTaskFromTextResult> {
    const settings = await this.deps.store.load()
    try {
      const model = normalizeScheduleModelForProvider(
        options.modelHint?.trim() || settings.schedule.model || DEFAULT_SCHEDULE_MODEL,
        getManagedRuntimeSettings(settings).providerId
      )
      const request = await detectClawScheduledTaskRequest(
        settings,
        text,
        model
      )
      if (!request) return { kind: 'noop' }
      const task = buildScheduledTaskFromDetectedRequest({
        request,
        workspaceRoot: options.workspaceRoot?.trim() || this.resolveDefaultWorkspaceRoot(settings),
        model,
        mode: options.mode ?? settings.schedule.mode,
        id: randomUUID()
      })
      await this.createTask(task)
      return {
        kind: 'created',
        taskId: task.id,
        title: task.title,
        scheduleAt: request.scheduleAt,
        confirmationText: request.confirmationText
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logError('schedule-task', 'Failed to create scheduled task from text', { message, text })
      return { kind: 'error', message }
    }
  }

  async listTasks(): Promise<ScheduledTaskV1[]> {
    const settings = await this.deps.store.load()
    if (this.usesFlowCompatibility(settings)) {
      return this.listFlowCompatibleTasks(settings)
    }
    return settings.schedule.tasks
  }

  async createTask(task: ScheduledTaskV1): Promise<ScheduledTaskV1> {
    const settings = await this.deps.store.load()
    const normalizedTask = {
      ...task,
      model: normalizeScheduleModelForProvider(task.model, getManagedRuntimeSettings(settings).providerId)
    }
    if (this.usesFlowCompatibility(settings)) {
      const result = await this.deps.runtimeRequest(settings, '/v1/legacy-schedules', { method: 'POST', body: JSON.stringify(normalizedTask) })
      if (!result.ok) throw new Error(runtimeErrorMessage(result, 'Failed to create migrated schedule.'))
      const parsed = parseJsonObject(result.body); const saved = parsed?.task
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Runtime did not return the migrated schedule.')
      return saved as ScheduledTaskV1
    }
    const saved = await this.deps.store.patch({
      schedule: {
        enabled: true,
        tasks: [...settings.schedule.tasks, normalizedTask]
      }
    })
    this.sync(saved)
    return saved.schedule.tasks.find((item) => item.id === task.id) ?? normalizedTask
  }

  async createTaskFromInput(input: {
    title: string
    prompt: string
    workspaceRoot?: string
    model?: string
    reasoningEffort?: ScheduleReasoningEffort
    mode?: ScheduleRunMode
    enabled?: boolean
    schedule: Partial<ScheduledTaskV1['schedule']> & { kind: ScheduledTaskV1['schedule']['kind'] }
  }): Promise<ScheduledTaskV1> {
    const settings = await this.deps.store.load()
    const now = new Date().toISOString()
    const task: ScheduledTaskV1 = {
      id: randomUUID(),
      title: input.title.trim() || 'New scheduled task',
      enabled: input.enabled !== false,
      prompt: input.prompt,
      workspaceRoot: input.workspaceRoot?.trim() || this.resolveDefaultWorkspaceRoot(settings),
      model: input.model?.trim() || settings.schedule.model || DEFAULT_SCHEDULE_MODEL,
      reasoningEffort: normalizeScheduleReasoningEffort(input.reasoningEffort),
      mode: input.mode ?? settings.schedule.mode,
      schedule: {
        kind: input.schedule.kind,
        everyMinutes: typeof input.schedule.everyMinutes === 'number' ? input.schedule.everyMinutes : 60,
        timeOfDay: input.schedule.timeOfDay?.trim() || '09:00',
        atTime: input.schedule.atTime?.trim() || ''
      },
      createdAt: now,
      updatedAt: now,
      lastRunAt: '',
      nextRunAt: '',
      lastStatus: 'idle',
      lastMessage: '',
      lastThreadId: ''
    }
    const saved = await this.createTask(task)
    await this.ensureNextRuns(await this.deps.store.load())
    return saved
  }

  async updateTaskById(taskId: string, patch: Partial<ScheduledTaskV1>): Promise<ScheduledTaskV1 | null> {
    const settings = await this.deps.store.load()
    const task = (this.usesFlowCompatibility(settings) ? await this.listTasks() : settings.schedule.tasks).find((item) => item.id === taskId)
    if (!task) return null
    const now = new Date().toISOString()
    const shouldRecomputeNextRun =
      Object.prototype.hasOwnProperty.call(patch, 'enabled') || patch.schedule !== undefined
    const nextTask: ScheduledTaskV1 = {
      ...task,
      ...patch,
      model: normalizeScheduleModelForProvider(
        patch.model ?? task.model,
        getManagedRuntimeSettings(settings).providerId
      ),
      schedule: patch.schedule ? { ...task.schedule, ...patch.schedule } : task.schedule,
      ...(shouldRecomputeNextRun ? { nextRunAt: '' } : {}),
      updatedAt: now
    }
    if (this.usesFlowCompatibility(settings)) {
      const result = await this.deps.runtimeRequest(settings, `/v1/legacy-schedules/${encodeURIComponent(taskId)}`, { method: 'PUT', body: JSON.stringify(nextTask) })
      if (!result.ok) throw new Error(runtimeErrorMessage(result, 'Failed to update migrated schedule.'))
      const parsed = parseJsonObject(result.body); return parsed?.task as ScheduledTaskV1 ?? nextTask
    }
    const saved = await this.deps.store.patch({
      schedule: {
        tasks: settings.schedule.tasks.map((item) => (item.id === taskId ? nextTask : item))
      }
    })
    this.sync(saved)
    return saved.schedule.tasks.find((item) => item.id === taskId) ?? nextTask
  }

  async deleteTaskById(taskId: string): Promise<boolean> {
    const settings = await this.deps.store.load()
    const tasks = this.usesFlowCompatibility(settings) ? await this.listTasks() : settings.schedule.tasks
    if (!tasks.some((item) => item.id === taskId)) return false
    if (this.usesFlowCompatibility(settings)) {
      const result = await this.deps.runtimeRequest(settings, `/v1/legacy-schedules/${encodeURIComponent(taskId)}`, { method: 'DELETE' })
      return result.ok
    }
    await appCancellationRegistry.cancel({ scope: 'schedule', id: taskId }, 'schedule_deleted')
    const saved = await this.deps.store.patch({
      schedule: {
        tasks: settings.schedule.tasks.filter((item) => item.id !== taskId)
      }
    })
    this.sync(saved)
    return saved.schedule.tasks.every((item) => item.id !== taskId)
  }

  private startScheduler(): void {
    if (this.scheduler) return
    this.scheduler = setInterval(() => {
      void this.tick()
    }, SCHEDULER_INTERVAL_MS)
    this.scheduler.unref?.()
    void this.tick()
  }

  private usesFlowCompatibility(settings: AppSettingsV1): boolean { return settings.schedule.enabled === false && settings.schedule.tasks.length > 0 }

  private async listFlowCompatibleTasks(settings: AppSettingsV1): Promise<ScheduledTaskV1[]> {
    const providerId = getManagedRuntimeSettings(settings).providerId || undefined
    const migrationKey = providerId || 'deepseek'
    const activeMigration = this.legacyScheduleModelMigrations.get(migrationKey)
    if (activeMigration) return activeMigration

    const migration = this.legacyScheduleModelMigrationQueue.then(async (): Promise<ScheduledTaskV1[]> => {
      const currentSettings = await this.deps.store.load()
      const result = await this.deps.runtimeRequest(currentSettings, '/v1/legacy-schedules', { method: 'GET' })
      if (!result.ok) throw new Error(runtimeErrorMessage(result, 'Failed to list migrated schedules.'))
      const parsed = parseJsonObject(result.body)
      const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks as ScheduledTaskV1[] : []
      for (let index = 0; index < tasks.length; index += 1) {
        const originalTask = tasks[index]
        let currentTask = originalTask
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const writeSettings = await this.deps.store.load()
          const writeProviderId = getManagedRuntimeSettings(writeSettings).providerId || undefined
          const model = normalizeScheduleModelForProvider(originalTask.model, writeProviderId)
          if (model === currentTask.model) break
          const migrated: ScheduledTaskV1 = { ...currentTask, model, updatedAt: new Date().toISOString() }
          const updated = await this.deps.runtimeRequest(
            writeSettings,
            `/v1/legacy-schedules/${encodeURIComponent(originalTask.id)}`,
            { method: 'PUT', body: JSON.stringify(migrated) }
          )
          if (!updated.ok) throw new Error(runtimeErrorMessage(updated, 'Failed to migrate a legacy schedule model.'))
          const saved = parseJsonObject(updated.body)?.task
          currentTask = saved && typeof saved === 'object' && !Array.isArray(saved)
            ? saved as ScheduledTaskV1
            : migrated
          const latestSettings = await this.deps.store.load()
          const latestProviderId = getManagedRuntimeSettings(latestSettings).providerId || undefined
          if (latestProviderId === writeProviderId) break
          if (attempt === 2) throw new Error('Provider changed repeatedly while migrating a legacy schedule model.')
        }
        tasks[index] = currentTask
      }
      return tasks
    })
    this.legacyScheduleModelMigrations.set(migrationKey, migration)
    this.legacyScheduleModelMigrationQueue = migration.then(() => undefined, () => undefined)
    try {
      return await migration
    } finally {
      if (this.legacyScheduleModelMigrations.get(migrationKey) === migration) {
        this.legacyScheduleModelMigrations.delete(migrationKey)
      }
    }
  }

  private async tick(): Promise<void> {
    const settings = await this.deps.store.load()
    if (!settings.schedule.enabled) return
    await this.reconcileWaitingTasks(settings)
    await this.ensureNextRuns(await this.deps.store.load())
    const fresh = await this.deps.store.load()
    const now = Date.now()
    for (const task of fresh.schedule.tasks) {
      if (!task.enabled || task.schedule.kind === 'manual') continue
      // A durable blocked task already owns this occurrence. Continue it from
      // its conversation instead of creating another task on every tick.
      if (task.lastStatus === 'waiting_user') continue
      if (this.runningTaskIds.has(task.id)) continue
      const dueAt = Date.parse(task.nextRunAt)
      if (!Number.isFinite(dueAt) || dueAt > now) continue
      void this.runTaskInternal(task, true)
    }
  }

  private async reconcileWaitingTasks(settings: AppSettingsV1): Promise<void> {
    if (this.reconcilingWaitingTasks) return
    const waiting = settings.schedule.tasks.filter(task => task.lastStatus === 'waiting_user' && task.runtimeTaskId)
    if (!waiting.length) return
    // Bound local snapshot traffic on each 30-second tick and rotate fairly.
    const start = this.waitingTaskCursor % waiting.length
    const batch = Array.from({ length: Math.min(waiting.length, 8) }, (_, index) => waiting[(start + index) % waiting.length])
    this.waitingTaskCursor = (start + batch.length) % waiting.length
    this.reconcilingWaitingTasks = true
    try {
      for (const scheduled of batch) {
        try {
          const response = await this.deps.runtimeRequest(settings, `/v1/tasks/${encodeURIComponent(scheduled.runtimeTaskId!)}`, { method: 'GET' })
          if (!response.ok) continue
          const task = parseJsonObject(response.body)
          if (!task || task.id !== scheduled.runtimeTaskId ||
            task.originThreadId !== scheduled.lastThreadId && task.threadId !== scheduled.lastThreadId) continue
          const status = asString(task.status)
          const completed = status === 'completed' && hasVerifiedScheduledTaskResult(task)
          if (!completed && status !== 'failed' && status !== 'cancelled') continue
          const finishedAt = new Date()
          await this.updateTask(scheduled.id, current => {
            // A user may have edited or re-run the schedule while the read was in flight.
            if (current.lastStatus !== 'waiting_user' || current.runtimeTaskId !== scheduled.runtimeTaskId) return current
            return {
              ...current,
              ...(current.schedule.kind === 'at' ? { enabled: false } : {}),
              nextRunAt: current.schedule.kind === 'at' ? '' : computeScheduleNextRunAt(current, finishedAt),
              lastStatus: completed ? 'success' : 'error',
              lastMessage: completed
                ? summarizeTaskResult(asString(task.finalResponse))
                : asString(task.stalledReason) || asString(task.waitingReason) || (status === 'cancelled' ? 'Task was cancelled.' : 'Task failed.'),
              updatedAt: finishedAt.toISOString()
            }
          })
        } catch (error) {
          // Network/runtime unavailability is not evidence that the task failed.
          this.deps.logError('schedule-task', 'Unable to reconcile waiting task', {
            taskId: scheduled.id,
            runtimeTaskId: scheduled.runtimeTaskId,
            message: error instanceof Error ? error.message : String(error)
          })
        }
      }
    } finally {
      this.reconcilingWaitingTasks = false
    }
  }

  private async ensureNextRuns(settings: AppSettingsV1): Promise<void> {
    if (!settings.schedule.enabled) {
      this.syncPowerSaveBlocker(settings)
      return
    }
    let changed = false
    const now = new Date()
    const tasks = settings.schedule.tasks.map((task) => {
      if (task.lastStatus === 'waiting_user') return task
      const wasInterrupted = task.lastStatus === 'running' && !this.runningTaskIds.has(task.id)
      if (!task.enabled || task.schedule.kind === 'manual' || this.runningTaskIds.has(task.id)) {
        if (!wasInterrupted) return task
        changed = true
        return {
          ...task,
          ...(task.schedule.kind === 'at' ? { enabled: false } : {}),
          nextRunAt: task.schedule.kind === 'at' ? '' : task.nextRunAt,
          lastStatus: 'error' as const,
          lastMessage: 'Task was interrupted before completion.',
          updatedAt: now.toISOString()
        }
      }
      if (task.nextRunAt && !wasInterrupted) return task
      changed = true
      return {
        ...task,
        nextRunAt: computeScheduleNextRunAt(task, now),
        ...(wasInterrupted
          ? {
              lastStatus: 'error' as const,
              lastMessage: 'Task was interrupted before completion.',
              updatedAt: now.toISOString()
            }
          : {})
      }
    })
    if (!changed) {
      this.syncPowerSaveBlocker(settings)
      return
    }
    const saved = await this.deps.store.patch({ schedule: { ...settings.schedule, tasks } })
    this.syncPowerSaveBlocker(saved)
  }

  private async updateTask(
    taskId: string,
    updater: (task: ScheduledTaskV1, settings: AppSettingsV1) => ScheduledTaskV1
  ): Promise<AppSettingsV1> {
    const settings = await this.deps.store.load()
    const tasks = settings.schedule.tasks.map((task) => task.id === taskId ? updater(task, settings) : task)
    const saved = await this.deps.store.patch({ schedule: { ...settings.schedule, tasks } })
    this.syncPowerSaveBlocker(saved)
    return saved
  }

  private async runTaskInternal(task: ScheduledTaskV1, scheduled: boolean): Promise<ScheduleRunResult> {
    if (this.runningTaskIds.has(task.id)) {
      return { ok: false, message: 'Task is already running.' }
    }
    if (scheduled && (!task.enabled || task.schedule.kind === 'manual')) {
      return { ok: false, message: 'Task is not scheduled.' }
    }
    if (!task.prompt.trim()) {
      return { ok: false, message: 'Task prompt is empty.' }
    }

    this.runningTaskIds.add(task.id)
    await this.updateTask(task.id, (current) => ({
      ...current,
      lastStatus: 'running',
      runtimeTaskId: undefined,
      lastMessage: 'Running',
      nextRunAt: '',
      updatedAt: new Date().toISOString()
    }))

    try {
      const settings = await this.deps.store.load()
      const result = await this.runPrompt(settings, {
        prompt: task.prompt,
        title: scheduledThreadTitle(task.title),
        workspaceRoot: task.workspaceRoot || this.resolveDefaultWorkspaceRoot(settings),
        model: normalizeScheduleModelForProvider(task.model, getManagedRuntimeSettings(settings).providerId),
        reasoningEffort: task.reasoningEffort,
        mode: task.mode,
        waitForResult: false,
        responseTimeoutMs: TASK_RESPONSE_TIMEOUT_MS
      })
      if (!result.ok) {
        const finishedAt = new Date()
        const waiting = result.status === 'waiting_user'
        await this.updateTask(task.id, (current) => ({
          ...current,
          ...(!waiting && current.schedule.kind === 'at' ? { enabled: false } : {}),
          lastRunAt: finishedAt.toISOString(),
          nextRunAt: waiting || current.schedule.kind === 'at' ? '' : computeScheduleNextRunAt(current, finishedAt),
          lastStatus: waiting ? 'waiting_user' : 'error',
          lastMessage: result.message,
          lastThreadId: result.threadId || current.lastThreadId,
          runtimeTaskId: waiting ? result.taskId : undefined,
          updatedAt: finishedAt.toISOString()
        }))
        this.runningTaskIds.delete(task.id)
        return result
      }

      if (!result.turnId) throw new Error('Runtime did not start an executable turn.')
      const startedAt = new Date()
      await this.updateTask(task.id, (current) => ({
        ...current,
        lastRunAt: startedAt.toISOString(),
        nextRunAt: '',
        lastStatus: 'running',
        lastMessage: result.message ?? 'Started',
        lastThreadId: result.threadId,
        updatedAt: startedAt.toISOString()
      }))
      if (result.turnId) {
        appCancellationRegistry.register(
          { scope: 'schedule', id: task.id },
          {
            parent: { scope: 'app', id: 'app' },
            cleanup: async () => {
              await this.deps.runtimeRequest(
                settings,
                runtimeThreadInterruptPath(result.threadId, result.turnId ?? ''),
                { method: 'POST', body: JSON.stringify({ discard: false }) }
              ).catch(() => undefined)
            }
          }
        )
      }
      void this.monitorTaskTurn(task.id, result.threadId, result.turnId)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const finishedAt = new Date()
      await this.updateTask(task.id, (current) => ({
        ...current,
        lastRunAt: finishedAt.toISOString(),
        nextRunAt: computeScheduleNextRunAt(current, finishedAt),
        lastStatus: 'error',
        lastMessage: message,
        updatedAt: finishedAt.toISOString()
      }))
      this.runningTaskIds.delete(task.id)
      return { ok: false, message }
    }
  }

  private async monitorTaskTurn(taskId: string, threadId: string, turnId: string): Promise<void> {
    try {
      const settings = await this.deps.store.load()
      const task = settings.schedule.tasks.find((item) => item.id === taskId)
      const text = await this.waitForAssistantText(
        settings,
        threadId,
        turnId,
        TASK_RESPONSE_TIMEOUT_MS,
        task?.workspaceRoot || this.resolveDefaultWorkspaceRoot(settings)
      )
      const finishedAt = new Date()
      await this.updateTask(taskId, (current) => ({
        ...current,
        ...(current.schedule.kind === 'at' ? { enabled: false } : {}),
        nextRunAt: current.schedule.kind === 'at' ? '' : computeScheduleNextRunAt(current, finishedAt),
        lastStatus: 'success',
        lastMessage: summarizeTaskResult(text),
        lastThreadId: threadId,
        updatedAt: finishedAt.toISOString()
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const finishedAt = new Date()
      await this.updateTask(taskId, (current) => ({
        ...current,
        ...(current.schedule.kind === 'at' ? { enabled: false } : {}),
        nextRunAt: current.schedule.kind === 'at' ? '' : computeScheduleNextRunAt(current, finishedAt),
        lastStatus: 'error',
        lastMessage: message,
        lastThreadId: threadId || current.lastThreadId,
        updatedAt: finishedAt.toISOString()
      }))
      this.deps.logError('schedule-task', 'Scheduled task failed', { message, taskId, threadId })
    } finally {
      this.runningTaskIds.delete(taskId)
      appCancellationRegistry.release({ scope: 'schedule', id: taskId })
    }
  }

  private async runPrompt(settings: AppSettingsV1, options: RunPromptOptions): Promise<ScheduleRunResult> {
    const workspace = options.workspaceRoot.trim() || this.resolveDefaultWorkspaceRoot(settings)
    const model = normalizeTaskModel(options.model) ?? (settings.agents.kun.model.trim() || DEFAULT_SCHEDULE_MODEL)
    const create = await this.deps.runtimeRequest(settings, '/v1/threads', {
      method: 'POST',
      body: JSON.stringify({
        workspace,
        model,
        mode: options.mode,
        ...(options.title.trim() ? { title: options.title.trim() } : {})
      })
    })
    if (!create.ok) return { ok: false, message: runtimeErrorMessage(create, 'Failed to create thread.') }
    const thread = JSON.parse(create.body) as ThreadRecordJson

    const turnBody: Record<string, unknown> = {
      prompt: buildScheduleRuntimePrompt(settings, options.prompt),
      displayText: options.prompt,
      mode: options.mode,
      // Scheduled turns are headless — nobody can answer a user_input
      // prompt, and a turn that asks one hangs until the response timeout.
      disableUserInput: true
    }
    if (model) turnBody.model = model
    if (options.reasoningEffort) {
      turnBody.reasoningEffort = options.reasoningEffort
    }
    const turn = await this.deps.runtimeRequest(
      settings,
      `/v1/threads/${encodeURIComponent(thread.id)}/turns`,
      { method: 'POST', body: JSON.stringify(turnBody) }
    )
    const parsedTurn = parseJsonObject(turn.body)
    if (parsedTurn?.code === 'capability_required' || parsedTurn?.kind === 'capability_required') {
      return {
        ok: false,
        status: 'waiting_user',
        threadId: thread.id,
        taskId: asString(parsedTurn.taskId) || asString(nestedRecord(parsedTurn.task).id) || undefined,
        attentionId: asString(parsedTurn.attentionId) || undefined,
        message: asString(parsedTurn.message) || '任务正在等待连接器配置或授权，请打开原对话继续。'
      }
    }
    if (!turn.ok) return { ok: false, message: runtimeErrorMessage(turn, 'Failed to start turn.') }

    const turnId = asString(nestedRecord(parsedTurn?.turn).id) || asString(parsedTurn?.turnId)
    if (!turnId) {
      const kind = asString(parsedTurn?.kind)
      if (['snapshot', 'input_queued', 'task_updated', 'attention_required'].includes(kind)) {
        return {
          ok: false,
          status: 'waiting_user',
          threadId: thread.id,
          taskId: asString(parsedTurn?.taskId) || undefined,
          attentionId: asString(parsedTurn?.attentionId) || undefined,
          message: asString(parsedTurn?.message) || '请求已保存，但尚未执行。请打开原对话查看并继续。'
        }
      }
      return { ok: false, message: 'Failed to start turn: missing turn id.' }
    }
    const executionThreadId = asString(parsedTurn?.threadId) || thread.id
    if (!options.waitForResult) {
      return { ok: true, threadId: executionThreadId, turnId, message: 'Started' }
    }

    const text = await this.waitForAssistantText(settings, executionThreadId, turnId, options.responseTimeoutMs, workspace)
    return { ok: true, threadId: executionThreadId, turnId, text, message: text || 'Completed' }
  }

  private async waitForAssistantText(
    settings: AppSettingsV1,
    threadId: string,
    turnId: string,
    timeoutMs: number,
    workspaceRoot?: string
  ): Promise<string> {
    void workspaceRoot
    const deadline = Date.now() + timeoutMs
    let lastText = ''
    while (Date.now() < deadline) {
      await sleep(1_500)
      const detailRes = await this.deps.runtimeRequest(
        settings,
        `/v1/threads/${encodeURIComponent(threadId)}`,
        { method: 'GET' }
      )
      if (!detailRes.ok) {
        throw new Error(runtimeErrorMessage(detailRes, 'Failed to read thread result.'))
      }
      const detail = JSON.parse(detailRes.body) as ThreadDetailJson
      lastText = latestAssistantText(detail, { turnId }) || lastText
      const targetTurn = Array.isArray(detail.turns)
        ? detail.turns.find((turn) => turn.id === turnId)
        : undefined
      if (!targetTurn) continue
      if (isRunningStatus(targetTurn.status)) continue
      if (targetTurn.status === 'failed' || targetTurn.status === 'aborted') {
        const error = targetTurn.error?.trim()
        throw new Error(error || `Agent turn ${targetTurn.status}.`)
      }
      if (targetTurn.status === 'completed' && lastText) return lastText
    }
    if (lastText) return lastText
    throw new Error('Timed out waiting for agent response.')
  }

  private resolveDefaultWorkspaceRoot(settings: AppSettingsV1): string {
    return settings.schedule.defaultWorkspaceRoot.trim() || settings.workspaceRoot
  }

  private syncInternalServer(settings: AppSettingsV1): void {
    const internal = settings.schedule.internal
    const key = `${internal.port}`
    if (this.server && this.serverKey === key) return
    this.closeInternalServer()

    const reservedServer = this.deps.internalServer
    const reservedAddress = reservedServer?.address()
    const reservedPort = reservedAddress && typeof reservedAddress !== 'string'
      ? reservedAddress.port
      : null
    if (reservedServer?.listening && reservedPort === internal.port) {
      const handler = (req: IncomingMessage, res: ServerResponse): void => {
        void this.handleInternalRequest(req, res)
      }
      reservedServer.on('request', handler)
      this.server = reservedServer
      this.serverOwned = false
      this.serverRequestHandler = handler
      this.serverKey = key
      return
    }

    const server = createServer((req, res) => {
      void this.handleInternalRequest(req, res)
    })
    server.on('error', (error) => {
      this.deps.logError('schedule-server', 'Schedule internal server failed', {
        message: error instanceof Error ? error.message : String(error)
      })
      if (this.server === server) {
        this.closeInternalServer()
      }
    })
    server.listen(internal.port, '127.0.0.1')
    this.server = server
    this.serverOwned = true
    this.serverKey = key
  }

  private closeInternalServer(): void {
    if (!this.server) return
    const server = this.server
    const handler = this.serverRequestHandler
    const owned = this.serverOwned
    this.server = null
    this.serverOwned = false
    this.serverRequestHandler = null
    this.serverKey = ''
    if (handler) server.removeListener('request', handler)
    if (owned) server.close()
  }

  private async handleInternalRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/schedule/internal/health' && req.method === 'GET') {
        writeJson(res, 200, { status: 'ok', service: 'schedule', mode: 'embedded' })
        return
      }
      if (!url.pathname.startsWith('/schedule/internal/')) {
        writeJson(res, 404, { ok: false, message: 'Not found.' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, message: 'Method not allowed.' })
        return
      }
      const settings = await this.deps.store.load()
      const secret = settings.schedule.internal.secret.trim()
      if (secret) {
        const auth = req.headers.authorization ?? ''
        const rawHeaderSecret = req.headers['x-workwise-secret'] ?? readLegacyWebhookSecret(req.headers)
        const headerSecret = Array.isArray(rawHeaderSecret) ? rawHeaderSecret[0] : rawHeaderSecret
        if (auth !== `Bearer ${secret}` && headerSecret !== secret) {
          writeJson(res, 401, { ok: false, message: 'Unauthorized.' })
          return
        }
      }

      if (url.pathname === '/schedule/internal/list') {
        const tasks = await this.listTasks()
        writeJson(res, 200, { ok: true, tasks })
        return
      }

      const body = await readRequestBody(req)
      const payload = parseJsonObject(body)
      if (!payload) {
        writeJson(res, 400, { ok: false, message: 'Expected a JSON object.' })
        return
      }

      if (url.pathname === '/schedule/internal/create') {
        const input = nestedRecord(payload.input)
        if (!input || Object.keys(input).length === 0) {
          writeJson(res, 400, { ok: false, message: 'Missing task input.' })
          return
        }
        const title = asString(input.title)
        const prompt = asString(input.prompt)
        const schedule = nestedRecord(input.schedule)
        const kind = asString(schedule.kind) as ScheduledTaskV1['schedule']['kind']
        if (!prompt || !kind) {
          writeJson(res, 400, { ok: false, message: 'Missing prompt or schedule.kind.' })
          return
        }
        const saved = await this.createTaskFromInput({
          title,
          prompt,
          workspaceRoot: asString(input.workspaceRoot) || undefined,
          model: asString(input.model) || undefined,
          reasoningEffort: (asString(input.reasoningEffort) as ScheduleReasoningEffort) || undefined,
          mode: (asString(input.mode) as ScheduleRunMode) || undefined,
          enabled: input.enabled === false ? false : true,
          schedule: {
            kind,
            everyMinutes: Number(schedule.everyMinutes),
            timeOfDay: asString(schedule.timeOfDay),
            atTime: asString(schedule.atTime)
          }
        })
        writeJson(res, 200, { ok: true, task: saved })
        return
      }

      if (url.pathname === '/schedule/internal/update') {
        const taskId = asString(payload.taskId)
        const patch = nestedRecord(payload.patch)
        if (!taskId) {
          writeJson(res, 400, { ok: false, message: 'Missing taskId.' })
          return
        }
        const updated = await this.updateTaskById(taskId, patch as Partial<ScheduledTaskV1>)
        if (!updated) {
          writeJson(res, 404, { ok: false, message: 'Task not found.' })
          return
        }
        writeJson(res, 200, { ok: true, task: updated })
        return
      }

      if (url.pathname === '/schedule/internal/delete') {
        const taskId = asString(payload.taskId)
        if (!taskId) {
          writeJson(res, 400, { ok: false, message: 'Missing taskId.' })
          return
        }
        const removed = await this.deleteTaskById(taskId)
        writeJson(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, message: 'Task not found.' })
        return
      }

      writeJson(res, 404, { ok: false, message: 'Not found.' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logError('schedule-server', 'Schedule internal request failed', { message })
      writeJson(res, 500, { ok: false, message })
    }
  }

  private syncPowerSaveBlocker(settings: AppSettingsV1): void {
    const shouldKeepAwake =
      settings.schedule.keepAwake &&
      settings.schedule.enabled &&
      hasEnabledScheduledTask(settings)
    if (!shouldKeepAwake) {
      this.stopPowerSaveBlocker()
      return
    }
    if (this.isPowerSaveBlockerActive()) return
    const blocker = this.deps.powerSaveBlocker
    if (!blocker) return
    this.powerSaveBlockerId = blocker.start('prevent-app-suspension')
  }

  private stopPowerSaveBlocker(): void {
    const blocker = this.deps.powerSaveBlocker
    const id = this.powerSaveBlockerId
    this.powerSaveBlockerId = null
    if (!blocker || id == null) return
    try {
      if (blocker.isStarted(id)) blocker.stop(id)
    } catch (error) {
      this.deps.logError('schedule-power-save', 'Failed to stop power save blocker', {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private isPowerSaveBlockerActive(): boolean {
    const blocker = this.deps.powerSaveBlocker
    const id = this.powerSaveBlockerId
    if (!blocker || id == null) return false
    try {
      return blocker.isStarted(id)
    } catch {
      return false
    }
  }
}

export function createScheduleRuntime(deps: ScheduleRuntimeDeps): ScheduleRuntime {
  return new ScheduleRuntime(deps)
}

/** Do not turn a resumed task's prose or a bare completed flag into success. */
function hasVerifiedScheduledTaskResult(task: Record<string, unknown>): boolean {
  if (!asString(task.finalResponse).trim() || !asString(task.finishedAt)) return false
  const acceptance = nestedRecord(task.acceptance)
  const nodes = Array.isArray(task.nodes) ? task.nodes.map(nestedRecord) : []
  const requiredKinds = Array.isArray(acceptance.requiredNodeKinds) ? acceptance.requiredNodeKinds : []
  if (!requiredKinds.length || !requiredKinds.every(kind => nodes.some(node => node.kind === kind && node.status === 'completed')) ||
    nodes.some(node => node.status !== 'completed')) return false
  if (acceptance.kind === 'answer') return true
  if (acceptance.kind === 'files') {
    const artifacts = Array.isArray(task.artifacts) ? task.artifacts.map(nestedRecord) : []
    const minimum = typeof acceptance.minimumArtifacts === 'number' ? Math.max(1, acceptance.minimumArtifacts) : 1
    return artifacts.filter(artifact => artifact.validation === 'valid' && asString(artifact.relativePath) && asString(artifact.sha256)).length >= minimum
  }
  if (acceptance.kind !== 'effect') return false
  const effect = nestedRecord(acceptance.effect)
  const evidence = Array.isArray(task.resultEvidence) ? task.resultEvidence.map(nestedRecord).filter(item =>
    item.kind === 'external_operation' && item.verified === true && asString(item.resultHash) && asString(item.status) &&
    asString(item.verifiedAt) && asString(item.target) && asString(item.operation) && item.provider === effect.provider) : []
  if (!evidence.length) return false
  const required = Array.isArray(effect.requiredEffects) ? effect.requiredEffects.map(nestedRecord) : []
  if (required.length) return required.every(item => evidence.some(result =>
    result.provider === item.provider && result.operation === item.operation && result.target === item.target))
  // A broad process goal is incomplete until a finite reviewed target set is
  // persisted. Match the Runtime's requiredEffects boundary exactly.
  if (effect.operation === 'process') return false
  return evidence.some(item => item.operation === effect.operation && item.target === effect.target)
}
