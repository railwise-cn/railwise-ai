import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { SubagentsCapabilityConfig } from '../contracts/capabilities.js'
import type { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import type { UsageSnapshot } from '../contracts/usage.js'
import type { TaskRunRepository } from '../services/task-run-repository.js'
import type { RuntimeSpanService } from '../services/runtime-span-service.js'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { canonicalWorkspace } from '../memory/memory-store.js'
import { relative } from 'node:path'
import type { CapacityManager } from '../services/capacity-manager.js'
import type { TaskContextRuntime } from '../services/task-context-runtime.js'
import type { TaskController } from '../services/task-controller.js'
import { inspectProcess, processIdentity } from '../services/process-identity.js'

const ChildHandoff = z.object({
  summary: z.string(),
  evidenceItemIds: z.array(z.string()),
  completedOperationIds: z.array(z.string()),
  pendingOperationIds: z.array(z.string()),
  status: z.enum(['completed', 'failed', 'aborted'])
}).strict()

const ChildRunUsage = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  cachedTokens: z.number().int().nonnegative().optional(),
  cacheHitTokens: z.number().int().nonnegative().optional(),
  cacheMissTokens: z.number().int().nonnegative().optional(),
  cacheHitRate: z.number().min(0).max(1).nullable().optional(),
  turns: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  costCny: z.number().nonnegative().optional(),
  cacheSavingsUsd: z.number().nonnegative().optional(),
  cacheSavingsCny: z.number().nonnegative().optional(),
  tokenEconomySavingsTokens: z.number().int().nonnegative().optional(),
  tokenEconomySavingsUsd: z.number().nonnegative().optional(),
  tokenEconomySavingsCny: z.number().nonnegative().optional()
})

export const ChildRunRecord = z.object({
  id: z.string().min(1),
  parentThreadId: z.string().min(1),
  parentTurnId: z.string().min(1),
  label: z.string().optional(),
  prompt: z.string().min(1),
  workspace: z.string().optional(),
  model: z.string().optional(),
  taskId: z.string().min(1).optional(),
  parentTaskId: z.string().min(1).optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'aborted', 'interrupted']),
  executionMode: z.enum(['foreground', 'background', 'detached']).default('foreground'),
  attempt: z.number().int().nonnegative().default(0),
  maxDurationMs: z.number().int().positive().default(10 * 60 * 1000),
  summary: z.string().optional(),
  sessionRef: z.string().optional(),
  stagingDirectory: z.string().optional(),
  handoff: ChildHandoff.optional(),
  executionMs: z.number().nonnegative().optional(),
  ownerPid: z.number().int().positive().optional(),
  ownerStartedAt: z.string().optional(),
  error: z.string().optional(),
  usage: ChildRunUsage.default({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
  createdAt: z.string(),
  updatedAt: z.string(),
  revision: z.number().int().nonnegative().default(0)
}).strict()
export type ChildRunRecord = z.infer<typeof ChildRunRecord>

export type ChildRunExecutor = (input: {
  childId: string
  parentThreadId: string
  parentTurnId: string
  label?: string
  prompt: string
  workspace?: string
  model?: string
  recovering?: boolean
  signal: AbortSignal
}) => Promise<{ summary: string; usage?: ChildRunRecord['usage']; sessionRef?: string; handoff?: z.infer<typeof ChildHandoff> }>

export type ChildRunAggregate = {
  key: string
  label?: string
  model?: string
  runs: number
  completed: number
  failed: number
  aborted: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsd?: number
  costCny?: number
  averageTotalTokens: number
  averageCostUsd?: number
  averageCostCny?: number
}

export class FileDelegationStore {
  constructor(private readonly rootDir: string) {}

  async upsert(record: ChildRunRecord): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    const target = this.recordPath(record.id)
    await atomicWriteFile(target, JSON.stringify(record, null, 2))
  }

  async get(childId: string): Promise<ChildRunRecord | null> {
    return readFile(this.recordPath(childId), 'utf8')
      .then((text) => ChildRunRecord.parse(JSON.parse(text)))
      .catch(() => null)
  }

  async list(parentThreadId?: string): Promise<ChildRunRecord[]> {
    await mkdir(this.rootDir, { recursive: true })
    const entries = await readdir(this.rootDir).catch(() => [])
    const records = await Promise.all(entries
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => readFile(join(this.rootDir, entry), 'utf8')
        .then((text) => ChildRunRecord.parse(JSON.parse(text)))
        .catch(() => null)))
    return records
      .filter((record): record is ChildRunRecord => Boolean(record))
      .filter((record) => !parentThreadId || record.parentThreadId === parentThreadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  private recordPath(childId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(childId)) throw new Error('invalid child run id')
    return join(this.rootDir, `${childId}.json`)
  }
}

export class DelegationRuntime {
  private active = 0
  private childSeq = 0
  private readonly activeChildren = new Map<string, {
    parentThreadId: string
    controller: AbortController
    promise: Promise<ChildRunRecord>
  }>()

  constructor(private readonly options: {
    config: SubagentsCapabilityConfig
    store: FileDelegationStore
    events?: RuntimeEventRecorder
    nowIso?: () => string
    idGenerator?: () => string
    executor?: ChildRunExecutor
    recordExternalUsage?: (threadId: string, usage: UsageSnapshot) => void
    taskRepository?: TaskRunRepository
    spanService?: RuntimeSpanService
    capacityManager?: CapacityManager
    taskContextRuntime?: TaskContextRuntime
    taskController?: TaskController
  }) {}

  async runChild(input: {
    parentThreadId: string
    parentTurnId: string
    label?: string
    prompt: string
    workspace?: string
    model?: string
    signal: AbortSignal
    maxDurationMs?: number
  }): Promise<ChildRunRecord> {
    const started = await this.startChild({ ...input, executionMode: 'foreground' })
    return this.activeChildren.get(started.id)?.promise ?? started
  }

  async startChild(input: {
    parentThreadId: string
    parentTurnId: string
    label?: string
    prompt: string
    workspace?: string
    model?: string
    signal?: AbortSignal
    executionMode?: 'foreground' | 'background' | 'detached'
    maxDurationMs?: number
  }): Promise<ChildRunRecord> {
    if (!this.options.config.enabled) throw new Error('delegation is disabled by config')
    if (this.active >= this.options.config.maxParallel) throw new Error('delegation parallel budget exhausted')
    const existing = await this.options.store.list(input.parentThreadId)
    if (existing.length >= this.options.config.maxChildRuns) throw new Error('delegation child-run budget exhausted')
    const now = this.now()
    const parent = this.options.taskRepository?.findActiveByThread(input.parentThreadId)
    if (parent && ['paused', 'cancelled', 'completed', 'failed'].includes(parent.status)) throw new Error('parent task is not accepting child assignments')
    const workspace = input.workspace?.trim() || parent?.workspaceRoot
    if (parent && workspace) {
      const subpath = relative(canonicalWorkspace(parent.workspaceRoot), canonicalWorkspace(workspace))
      if (subpath.startsWith('..') || subpath.startsWith('/') || /^[a-zA-Z]:/.test(subpath)) throw new Error('child workspace is outside parent task authority')
    }
    const id = this.options.idGenerator?.() ?? `child_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    let record = ChildRunRecord.parse({
      id,
      parentThreadId: input.parentThreadId,
      parentTurnId: input.parentTurnId,
      label: input.label,
      prompt: input.prompt,
      workspace,
      model: input.model,
      status: 'queued',
      executionMode: input.executionMode ?? 'foreground',
      maxDurationMs: Math.min(input.maxDurationMs ?? 10 * 60 * 1000, parent?.budget.maxDurationMs ?? Infinity),
      createdAt: now,
      updatedAt: now
    })
    record = this.createLinkedTask(record)
    this.options.spanService?.start({
      id: `span_child_${record.id}`,
      ...(record.taskId ? { taskId: record.taskId } : {}),
      kind: 'child-task',
      name: record.label?.trim() || 'delegated-task',
      retryCount: record.attempt,
      model: record.model,
      attributes: { executionMode: record.executionMode, parentThreadId: record.parentThreadId }
    })
    await this.options.store.upsert(record)
    await this.recordChildEvent(record)
    const controller = new AbortController()
    const abortFromParent = () => controller.abort(input.signal?.reason ?? new Error('parent task cancelled'))
    input.signal?.addEventListener('abort', abortFromParent, { once: true })
    if (input.signal?.aborted) abortFromParent()
    const promise = this.executeChild(record, controller.signal).finally(() => {
      input.signal?.removeEventListener('abort', abortFromParent)
      this.activeChildren.delete(record.id)
    })
    this.activeChildren.set(record.id, { parentThreadId: record.parentThreadId, controller, promise })
    if (record.executionMode === 'foreground') return promise
    return (await this.options.store.get(record.id)) ?? record
  }

  async terminateChild(childId: string): Promise<ChildRunRecord | null> {
    const active = this.activeChildren.get(childId)
    active?.controller.abort(new Error('child task terminated'))
    if (active) return active.promise
    const record = await this.options.store.get(childId)
    if (!record || ['completed', 'failed', 'aborted'].includes(record.status)) return record
    const stopped = ChildRunRecord.parse({
      ...record,
      status: 'aborted',
      error: 'child task terminated',
      updatedAt: this.now(),
      revision: record.revision + 1
    })
    await this.options.store.upsert(stopped)
    this.finishLinkedTask(stopped)
    await this.recordChildEvent(stopped)
    return stopped
  }

  async recoverInterrupted(): Promise<ChildRunRecord[]> {
    const records = await this.options.store.list()
    // The child JSON record may have committed before the shared task transaction.
    // Reconcile its verified terminal observation instead of re-running the child.
    for (const record of records) if (['completed', 'failed', 'aborted'].includes(record.status)) this.finishLinkedTask(record)
    const candidates = records
      .filter((record) => record.status === 'queued' || record.status === 'running')
    const recovered: ChildRunRecord[] = []
    for (const candidate of candidates) {
      const ownership = childOwnerState(candidate)
      if (this.activeChildren.has(candidate.id) || ownership === 'alive') continue
      const parent = candidate.parentTaskId ? this.options.taskRepository?.get(candidate.parentTaskId) : undefined
      if (parent && ['paused', 'cancelled', 'completed', 'failed'].includes(parent.status)) continue
      const interrupted = ChildRunRecord.parse({
        ...candidate,
        status: 'interrupted',
        error: ownership === 'unknown' ? 'child_operation_outcome_unknown: original process identity is unavailable; inspect before resuming' : 'application restarted while the child task was running',
        updatedAt: this.now(),
        revision: candidate.revision + 1
      })
      await this.options.store.upsert(interrupted)
      await this.recordChildEvent(interrupted)
      if (ownership === 'unknown') { this.finishLinkedTask(interrupted); recovered.push(interrupted); continue }
      const restarted = await this.restartChild(interrupted)
      recovered.push(restarted)
    }
    return recovered
  }

  /**
   * Wait for a specific child when a caller needs a durable completion point.
   * Detached recovery itself remains non-blocking so application startup is
   * never held open by a long child task.
   */
  async waitForChild(childId: string): Promise<ChildRunRecord | null> {
    const active = this.activeChildren.get(childId)
    if (active) return active.promise
    return this.options.store.get(childId)
  }

  abortAll(reason = 'application_exit'): void {
    for (const active of this.activeChildren.values()) active.controller.abort(new Error(reason))
  }

  /** Shutdown waits for cancellation receipts and child file/session writes before databases close. */
  async awaitIdle(): Promise<void> {
    await Promise.allSettled([...this.activeChildren.values()].map(active => active.promise))
  }

  abortParent(parentThreadId: string, reason = 'parent_task_cancelled'): number {
    let count = 0
    for (const active of this.activeChildren.values()) {
      if (active.parentThreadId !== parentThreadId) continue
      active.controller.abort(new Error(reason))
      count += 1
    }
    return count
  }

  private async restartChild(record: ChildRunRecord): Promise<ChildRunRecord> {
    if (this.active >= this.options.config.maxParallel) return record
    const controller = new AbortController()
    const resumed = ChildRunRecord.parse({
      ...record,
      status: 'queued',
      error: undefined,
      executionMode: 'detached',
      updatedAt: this.now(),
      revision: record.revision + 1
    })
    await this.options.store.upsert(resumed)
    const promise = this.executeChild(resumed, controller.signal, true).finally(() => {
      this.activeChildren.delete(resumed.id)
    })
    this.activeChildren.set(resumed.id, {
      parentThreadId: resumed.parentThreadId,
      controller,
      promise
    })
    return resumed
  }

  private async executeChild(recordInput: ChildRunRecord, signal: AbortSignal, recovering = false): Promise<ChildRunRecord> {
    const parentTask = recordInput.parentTaskId ? this.options.taskRepository?.get(recordInput.parentTaskId) : undefined
    const rootTaskId = parentTask?.rootTaskId ?? parentTask?.id
    let record = ChildRunRecord.parse({
      ...recordInput,
      status: 'running',
      attempt: recordInput.attempt + 1,
      updatedAt: this.now(),
      revision: recordInput.revision + 1
      ,ownerPid: process.pid
      ,ownerStartedAt: processIdentity()?.fingerprint
    })
    // The production AgentLoop reserves a worker only while a model executes.
    // Keeping an outer child permit would deadlock a foreground child at capacity
    // and would retain capacity during human/tool waits. Bare legacy executors
    // retain their existing bounded worker reservation.
    const permit = !this.options.taskController ? await this.options.capacityManager?.acquire({ id: `child:${recordInput.id}`, rootTaskId, workspaceRoot: recordInput.workspace, resources: { worker: 1 } }, signal) : undefined
    try {
      if (parentTask && rootTaskId && this.options.taskRepository) {
        const root = this.options.taskRepository.get(rootTaskId) ?? parentTask
        const used = this.options.taskRepository.execution.usedExecutionMs(rootTaskId, Date.now())
        if ((root.budget.version === 2 && used >= (root.budget.maxExecutionMs ?? root.budget.maxDurationMs)) || (root.budget.maxCostUsd && this.options.taskRepository.execution.usedCost(rootTaskId) >= root.budget.maxCostUsd)) throw new Error('root task execution or cost budget exhausted')
        if (!this.options.taskController) this.options.taskRepository.execution.beginWork(`child:${recordInput.id}`, rootTaskId, 'child', Date.now())
      }
      await this.options.store.upsert(record)
      this.markLinkedTaskRunning(record)
      await this.recordChildEvent(record)
    } catch (error) {
      permit?.release()
      if (rootTaskId && !this.options.taskController) this.options.taskRepository?.execution.finishWork(`child:${recordInput.id}`, Date.now())
      throw error
    }
    this.active += 1
    const timeout = setTimeout(() => {
      const active = this.activeChildren.get(record.id)
      active?.controller.abort(new Error('child task duration budget exhausted'))
    }, Math.max(1, record.maxDurationMs - (record.executionMs ?? 0)))
    timeout.unref?.()
    const startedAt = Date.now()
    try {
      const executor: ChildRunExecutor = this.options.executor ?? defaultExecutor
      const result = await executor({
        childId: record.id,
        parentThreadId: record.parentThreadId,
        parentTurnId: record.parentTurnId,
        ...(record.label ? { label: record.label } : {}),
        prompt: recovering
          ? `Resume this interrupted child task. Verify existing workspace results before repeating side effects.\n\n${record.prompt}`
          : record.prompt,
        workspace: record.workspace,
        model: record.model,
        recovering,
        signal
      })
      record = ChildRunRecord.parse({
        ...record,
        status: 'completed',
        summary: result.summary,
        usage: result.usage ?? record.usage,
        sessionRef: result.sessionRef ?? record.sessionRef,
        handoff: result.handoff ?? record.handoff,
        executionMs: (record.executionMs ?? 0) + Date.now() - startedAt,
        ownerPid: undefined,
        ownerStartedAt: undefined,
        updatedAt: this.now(),
        revision: record.revision + 1
      })
      await this.options.store.upsert(record)
      await this.recordChildEvent(record)
      this.finishLinkedTask(record)
      this.options.spanService?.finish(`span_child_${record.id}`, {
        status: 'ok',
        inputTokens: record.usage.promptTokens,
        outputTokens: record.usage.completionTokens
      })
      this.recordExternalUsage(record)
      return record
    } catch (error) {
      record = ChildRunRecord.parse({
        ...record,
        status: signal.aborted ? 'aborted' : (error as { code?: string })?.code === 'child_operation_outcome_unknown' ? 'interrupted' : 'failed',
        error: errorMessage(error),
        executionMs: (record.executionMs ?? 0) + Date.now() - startedAt,
        ownerPid: undefined,
        ownerStartedAt: undefined,
        updatedAt: this.now(),
        revision: record.revision + 1
      })
      await this.options.store.upsert(record)
      await this.recordChildEvent(record)
      this.finishLinkedTask(record)
      this.options.spanService?.finish(`span_child_${record.id}`, {
        status: signal.aborted ? 'cancelled' : 'error',
        errorCode: signal.aborted ? 'operation_cancelled' : 'child_task_failed'
      })
      return record
    } finally {
      clearTimeout(timeout)
      this.active -= 1
      permit?.release()
      if (rootTaskId && this.options.taskRepository && !this.options.taskController) {
        this.options.taskRepository.execution.finishWork(`child:${recordInput.id}`, Date.now())
        if (record.usage.costUsd !== undefined) this.options.taskRepository.execution.recordCost(rootTaskId, `child:${record.id}:${record.attempt}`, record.usage.costUsd)
      }
    }
  }

  async diagnostics(parentThreadId?: string): Promise<{
    enabled: boolean
    active: number
    childRuns: ChildRunRecord[]
    aggregates: ChildRunAggregate[]
  }> {
    const childRuns = await this.options.store.list(parentThreadId)
    return {
      enabled: this.options.config.enabled,
      active: this.active,
      childRuns,
      aggregates: aggregateChildRuns(childRuns)
    }
  }

  private async recordChildEvent(record: ChildRunRecord): Promise<void> {
    await this.options.events?.record({
      kind: record.status === 'completed' ? 'turn_completed' : record.status === 'failed' ? 'turn_failed' : record.status === 'aborted' ? 'turn_aborted' : record.status === 'interrupted' ? 'turn_failed' : 'turn_started',
      threadId: record.parentThreadId,
      turnId: record.parentTurnId,
      status: record.status,
      text: record.summary ?? record.error,
      ...(record.status === 'interrupted' ? { code: 'child_operation_outcome_unknown' } : {}),
      child: {
        parentThreadId: record.parentThreadId,
        parentTurnId: record.parentTurnId,
        childId: record.id,
        childLabel: record.label,
        childStatus: record.status,
        childSeq: ++this.childSeq
      }
    })
  }

  private recordExternalUsage(record: ChildRunRecord): void {
    if (record.status !== 'completed') return
    const usage = toUsageSnapshot(record.usage)
    if (usage.totalTokens <= 0 && usage.costUsd === undefined && usage.costCny === undefined) return
    this.options.recordExternalUsage?.(record.parentThreadId, usage)
  }

  private now(): string {
    return this.options.nowIso?.() ?? new Date().toISOString()
  }

  private createLinkedTask(record: ChildRunRecord): ChildRunRecord {
    const repository = this.options.taskRepository
    const parent = repository?.findActiveByThread(record.parentThreadId)
    if (!repository || !parent) return record
    const taskId = `task_${record.id}`
    const executeNodeId = `${taskId}_execute`
    const deliverNodeId = `${taskId}_deliver`
    repository.create({
      id: taskId,
      threadId: record.id,
      parentTaskId: parent.id,
      rootTaskId: parent.rootTaskId ?? parent.id,
      visibility: 'internal',
      childTaskIds: [],
      workspaceRoot: record.workspace ?? parent.workspaceRoot,
      repositoryRoot: parent.repositoryRoot,
      goal: record.prompt,
      status: 'queued',
      acceptance: {
        kind: 'answer',
        requiredNodeKinds: ['execute', 'deliver'],
        requireFinalResponse: true,
        requireActionableArtifactCard: false
      },
      agentId: record.label?.trim() || 'general',
      model: record.model ?? parent.model,
      authority: parent.authority ? { ...parent.authority, source: 'inherited', workspaceRoot: record.workspace ?? parent.workspaceRoot } : undefined,
      budget: { maxAttempts: Math.min(3, parent.budget.maxAttempts), maxDurationMs: record.maxDurationMs, ...(parent.budget.version === 2 ? { version: 2, maxExecutionMs: Math.min(record.maxDurationMs, parent.budget.maxExecutionMs ?? parent.budget.maxDurationMs) } : {}) },
      attempts: 0,
      replans: 0,
      noProgressCount: 0,
      nodes: [{
        id: executeNodeId,
        taskId,
        kind: 'execute',
        title: '执行子任务',
        status: 'pending',
        dependsOn: [],
        attempt: 0,
        maxAttempts: 3,
        idempotencyKey: `${taskId}:execute`,
        evidence: [],
        revision: 0
      }, {
        id: deliverNodeId,
        taskId,
        kind: 'deliver',
        title: '交付子任务结果',
        status: 'pending',
        dependsOn: [executeNodeId],
        attempt: 0,
        maxAttempts: 3,
        idempotencyKey: `${taskId}:deliver`,
        evidence: [],
        revision: 0
      }],
      artifacts: [],
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      revision: 0
    })
    const latestParent = repository.get(parent.id)
    if (latestParent && !latestParent.childTaskIds.includes(taskId)) {
      repository.update(latestParent.id, latestParent.revision, (task) => ({
        ...task,
        childTaskIds: [...task.childTaskIds, taskId],
        updatedAt: this.now()
      }))
    }
    const child = repository.get(taskId)!
    const session = repository.execution.ensureSession(child, this.now())
    this.options.taskContextRuntime?.createAssignment(parent, child, session.id)
    return ChildRunRecord.parse({ ...record, taskId, parentTaskId: parent.id })
  }

  private markLinkedTaskRunning(record: ChildRunRecord): void {
    const repository = this.options.taskRepository
    if (!repository || !record.taskId) return
    const task = repository.get(record.taskId)
    if (!task || ['completed', 'failed', 'cancelled'].includes(task.status)) return
    repository.update(task.id, task.revision, (current) => ({
      ...current,
      status: 'running',
      attempts: current.attempts + 1,
      nodes: current.nodes.map((node) => node.kind === 'execute'
        ? { ...node, status: 'running', attempt: node.attempt + 1, startedAt: this.now(), revision: node.revision + 1 }
        : node),
      updatedAt: this.now()
    }))
  }

  private finishLinkedTask(record: ChildRunRecord): void {
    if (!this.options.taskRepository) return
    this.options.taskRepository.transact(() => this.finishLinkedTaskTransaction(record))
  }

  private finishLinkedTaskTransaction(record: ChildRunRecord): void {
    const repository = this.options.taskRepository
    if (!repository || !record.taskId) return
    const task = repository.get(record.taskId)
    if (!task) return
    if (['completed', 'failed', 'cancelled'].includes(task.status)) { this.saveHandoff(record); return }
    if (record.status === 'interrupted') {
      repository.update(task.id, task.revision, current => ({ ...current, status: 'stalled', stalledReason: record.error, updatedAt: this.now() }))
      return
    }
    const terminalStatus = record.status === 'completed'
      ? 'completed'
      : record.status === 'aborted' ? 'cancelled' : 'failed'
    const finishedAt = this.now()
    const updated = repository.update(task.id, task.revision, (current) => ({
      ...current,
      status: terminalStatus,
      finalResponse: record.summary,
      stalledReason: record.error,
      nodes: current.nodes.map((node) => ({
        ...node,
        status: terminalStatus === 'completed' ? 'completed' : terminalStatus === 'cancelled' ? 'cancelled' : 'failed',
        evidence: record.summary ? [...node.evidence, record.summary.slice(0, 500)] : node.evidence,
        errorMessage: record.error,
        finishedAt,
        revision: node.revision + 1
      })),
      updatedAt: finishedAt,
      finishedAt
    }), {
      key: `child-terminal:${record.id}:${terminalStatus}`,
      kind: `child_task_${terminalStatus}`,
      payload: { childId: record.id }
    })
    repository.saveCheckpoint({
      id: `checkpoint_${record.id}_${updated.revision}`,
      taskId: updated.id,
      completedNodeIds: updated.nodes.filter((node) => node.status === 'completed').map((node) => node.id),
      pendingNodeIds: [],
      artifactIds: [],
      eventSequence: repository.events(updated.id).at(-1)?.sequence ?? 0,
      resumeSummary: record.summary ?? record.error ?? 'child task finished',
      createdAt: finishedAt,
      revision: updated.revision
    })
    this.saveHandoff(record)
  }

  private saveHandoff(record: ChildRunRecord): void {
    if (!record.taskId) return
    this.options.taskContextRuntime?.finishAssignment(record.taskId, {
      conclusion: record.summary ?? record.error ?? '',
      evidence: record.handoff?.evidenceItemIds ?? [],
      completedOperationIds: record.handoff?.completedOperationIds ?? [],
      remaining: record.handoff?.pendingOperationIds ?? [],
      blockers: record.error ? [record.error] : [],
      success: record.status === 'completed'
    })
    this.options.taskContextRuntime?.flushHandoffs()
  }
}

function childOwnerState(record: ChildRunRecord): 'alive' | 'exited' | 'unknown' {
  if (record.status === 'queued' && record.attempt === 0 && !record.ownerPid) return 'exited'
  if (!record.ownerPid || !record.ownerStartedAt) return 'unknown'
  if (!/^(?:darwin:|linux:|win32:)/.test(record.ownerStartedAt)) return 'unknown'
  return inspectProcess({ pid: record.ownerPid, fingerprint: record.ownerStartedAt })
}

function toUsageSnapshot(usage: ChildRunRecord['usage']): UsageSnapshot {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cachedTokens: usage.cachedTokens,
    cacheHitTokens: usage.cacheHitTokens,
    cacheMissTokens: usage.cacheMissTokens,
    cacheHitRate: usage.cacheHitRate ?? null,
    turns: usage.turns ?? 0,
    costUsd: usage.costUsd,
    costCny: usage.costCny,
    cacheSavingsUsd: usage.cacheSavingsUsd,
    cacheSavingsCny: usage.cacheSavingsCny,
    tokenEconomySavingsTokens: usage.tokenEconomySavingsTokens,
    tokenEconomySavingsUsd: usage.tokenEconomySavingsUsd,
    tokenEconomySavingsCny: usage.tokenEconomySavingsCny
  }
}

export function aggregateChildRuns(records: readonly ChildRunRecord[]): ChildRunAggregate[] {
  const buckets = new Map<string, ChildRunAggregate>()
  for (const record of records) {
    const label = record.label?.trim() || undefined
    const model = record.model?.trim() || undefined
    const key = `${label ?? 'unlabeled'}:${model ?? 'default'}`
    const bucket = buckets.get(key) ?? {
      key,
      ...(label ? { label } : {}),
      ...(model ? { model } : {}),
      runs: 0,
      completed: 0,
      failed: 0,
      aborted: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      averageTotalTokens: 0
    }
    bucket.runs += 1
    if (record.status === 'completed') bucket.completed += 1
    else if (record.status === 'failed') bucket.failed += 1
    else if (record.status === 'aborted' || record.status === 'interrupted') bucket.aborted += 1
    bucket.promptTokens += record.usage.promptTokens
    bucket.completionTokens += record.usage.completionTokens
    bucket.totalTokens += record.usage.totalTokens
    if (record.usage.costUsd !== undefined) bucket.costUsd = (bucket.costUsd ?? 0) + record.usage.costUsd
    if (record.usage.costCny !== undefined) bucket.costCny = (bucket.costCny ?? 0) + record.usage.costCny
    bucket.averageTotalTokens = bucket.runs > 0 ? bucket.totalTokens / bucket.runs : 0
    bucket.averageCostUsd = bucket.costUsd !== undefined && bucket.runs > 0 ? bucket.costUsd / bucket.runs : undefined
    bucket.averageCostCny = bucket.costCny !== undefined && bucket.runs > 0 ? bucket.costCny / bucket.runs : undefined
    buckets.set(key, bucket)
  }
  return [...buckets.values()].sort((a, b) =>
    b.runs - a.runs ||
    b.totalTokens - a.totalTokens ||
    a.key.localeCompare(b.key)
  )
}

const defaultExecutor: ChildRunExecutor = async (input) => {
  return { summary: `Child result: ${input.prompt}` }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
