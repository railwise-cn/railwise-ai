import { createHash } from 'node:crypto'
import type { FlowAdapterContext, FlowNodeAdapter } from '../flow/executor.js'
import type { FlowRunV1 } from '../contracts/flow.js'
import type { RuntimeOutboxItem, TaskRun } from '../contracts/tasks.js'
import type { ServerRuntime } from '../server/routes/server-runtime.js'
import { deliveryPrompt, type TaskDeliveryParameters } from './templates.js'
import { verifyTaskDelivery } from './verification.js'

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)

/** Each business node has one durable origin and one coordinated task, including after replay. */
export function buildTaskDeliveryAdapters(getRuntime: () => ServerRuntime): Map<string, FlowNodeAdapter> {
  return new Map([
    ['railwise.task_delivery', context => executeFlowTask(getRuntime(), context, true)],
    ['agent', context => executeFlowTask(getRuntime(), context, false)]
  ])
}

async function executeFlowTask(runtime: ServerRuntime, context: FlowAdapterContext, delivery: boolean) {
  const { run, definition, node, input } = context
  const repository = runtime.flowService!.repository
  const tasks = runtime.taskRepository!
  if (!runtime.taskCoordinator) throw new Error('Task coordinator is unavailable')
  const ownerId = `${run.id}:${node.id}`
  const originId = `${delivery ? 'thr_delivery_' : 'thr_flow_'}${digest(ownerId)}`
  const parameters = { ...node.config, workspaceRoot: definition.workspace } as TaskDeliveryParameters
  const templateId = delivery ? String(node.config.templateId) : undefined
  if (delivery && (!parameters.workspaceRoot || !parameters.goal)) throw new Error('Delivery workspace and goal are required')
  const goal = delivery ? parameters.goal.trim() : flowAgentPrompt(node.config, input)
  const prompt = templateId ? deliveryPrompt(templateId, parameters) : goal
  const operation = repository.beginOperation(ownerId, 'task-start', { threadId: originId, prompt, model: parameters.model, providerId: parameters.providerId })
  const reference = operation.operation.result as { taskId?: string } | undefined
  // Old delivery tasks used their origin as the execution thread. Keep their IDs and recovery path.
  const previous = reference?.taskId ? tasks.get(reference.taskId) : tasks.list({ threadId: originId, limit: 1 })[0]
  if (previous) return flowTaskResult(runtime, currentFlowTask(runtime, previous, run.id, definition.id))

  let origin = await runtime.threadService.get(originId)
  if (!origin) {
    const info = runtime.info()
    origin = await runtime.threadService.create({
      title: definition.name, workspace: parameters.workspaceRoot ?? '', model: parameters.model ?? info.model ?? 'auto',
      mode: 'agent', domain: 'flow', approvalPolicy: info.approvalPolicy, sandboxMode: info.sandboxMode
    }, { id: originId })
    await runtime.threadService.update(originId, { relation: 'side' })
    if (delivery) {
      await runtime.threadService.setAgent(originId, { agentId: 'document-delivery', expectedRevision: origin.agentRevision,
        idempotencyKey: `delivery-profile:${ownerId}`, profile: {
          id: 'document-delivery', name: '文档交付', role: '资料、工程成果与文档交付', color: '#0d9488',
          systemPrompt: '持续完成用户指定的文档任务。正文通过 propose_document 提交。按来源撰写并验证每项交付。',
          toolAllowlist: ['read', 'ls', 'find', 'grep', 'list_attachment_sections', 'search_attachment', 'read_attachment_section',
            'propose_document', 'read_delivery_sources', 'export_document', 'analyze_delivery_monitoring', 'read_task_context'],
          mcpAllowlist: [], trustLevel: 'workspace-write', budget: { maxAttempts: 8, maxDurationMs: 30 * 60 * 1000 }, revision: 1
        } })
    }
  }
  const result = await runtime.taskCoordinator.command({
    threadId: originId, intent: 'new', idempotencyKey: `flow-task:${ownerId}`,
    request: { prompt, displayText: goal, model: parameters.model, providerId: parameters.providerId, mode: 'agent' }
  }, {
    prepareTask: task => {
      let current = tasks.get(task.id)!
      if (current.flowRunId && (current.flowRunId !== run.id || current.flowId !== definition.id)) throw new Error('Task belongs to another Flow')
      if (current.flowRunId !== run.id || current.templateId !== templateId) {
        current = tasks.update(current.id, current.revision, saved => ({ ...saved, flowRunId: run.id, flowId: definition.id,
          ...(templateId ? { templateId, deliveryFormats: parameters.outputFormats ?? ['md', 'docx', 'pdf'] } : {}), updatedAt: runtime.nowIso() }))
      }
      repository.transaction(() => {
        repository.finishOperation(ownerId, 'task-start', 'succeeded', { threadId: current.threadId, originThreadId: originId, taskId: current.id, turnId: current.activeTurnId })
        repository.enqueueOutbox(`delivery-task:${ownerId}`, run.id, 'delivery_task', { threadId: current.threadId, taskId: current.id, turnId: current.activeTurnId })
      })
    }
  })
  if (!result.task) {
    return { kind: 'wait' as const, reason: 'task' as const, checkpoint: { originThreadId: originId, resumable: true,
      ...('attentionId' in result ? { attentionId: result.attentionId } : {}) } }
  }
  return flowTaskResult(runtime, tasks.get(result.task.id) ?? result.task)
}

/** Follow retries only within the exact persisted Flow/root/thread association. */
function currentFlowTask(runtime: ServerRuntime, reference: TaskRun, runId: string, flowId: string): TaskRun {
  const current = runtime.taskRepository!.currentExecution(reference.id)
  if (!current || (reference.flowRunId && reference.flowRunId !== runId) || (reference.flowId && reference.flowId !== flowId) ||
      current.threadId !== reference.threadId || current.workspaceRoot !== reference.workspaceRoot ||
      (current.rootTaskId ?? current.id) !== (reference.rootTaskId ?? reference.id) ||
      (current.id !== reference.id && (current.flowRunId !== runId || current.flowId !== flowId))) {
    throw Object.assign(new Error('Task retry does not belong to this Flow execution.'), { code: 'flow_task_scope_conflict' })
  }
  return current
}

export function assertFlowTaskRetryAllowed(runtime: ServerRuntime, task: TaskRun): void {
  if (!task.flowRunId) return
  const flow = runtime.flowService?.repository.getRun(task.flowRunId)
  if (!flow || flow.flowId !== task.flowId) throw Object.assign(new Error('The task Flow association is unavailable.'), { code: 'flow_task_scope_conflict' })
  if (flow.status === 'cancelled') throw Object.assign(new Error('流程已取消，请从明确的新任务重新开始。'), { code: 'flow_cancelled' })
  if (flow.status === 'succeeded') throw Object.assign(new Error('The Flow has already completed.'), { code: 'invalid_state' })
  assertFailedFlowTask(runtime, flow, task)
}

function assertFailedFlowTask(runtime: ServerRuntime, flow: FlowRunV1, task: TaskRun): void {
  if (flow.status !== 'failed') return
  let failedTaskId = (flow.output as { taskId?: unknown } | undefined)?.taskId
  // A user can resume a paused Flow after its task has already failed. The
  // executor then records the Agent node failure before the outbox observes it.
  if (!failedTaskId && flow.checkpoint?.reason === 'task' && typeof flow.checkpoint.nodeId === 'string') {
    const nodeId = flow.checkpoint.nodeId
    const failedNode = runtime.flowService!.repository.listNodeRuns(flow.id)
      .filter(node => node.status === 'failed').sort((first, second) => (second.completedAt ?? '').localeCompare(first.completedAt ?? ''))[0]
    const definition = runtime.flowService!.repository.getVersion(flow.versionId)?.definition
    const node = definition?.nodes.find(candidate => candidate.id === nodeId)
    if (failedNode?.nodeId === nodeId && node && ['agent', 'railwise.task_delivery'].includes(node.type)) {
      failedTaskId = (runtime.flowService!.repository.operation(`${flow.id}:${nodeId}`, 'task-start')?.result as { taskId?: unknown } | undefined)?.taskId
    }
  }
  const failedTask = typeof failedTaskId === 'string' ? runtime.taskRepository!.get(failedTaskId) : null
  if (!failedTask || flow.checkpoint?.reason !== 'task' || currentFlowTask(runtime, failedTask, flow.id, flow.flowId).id !== task.id) {
    throw Object.assign(new Error('流程失败属于其它节点，请先处理该节点后继续流程。'), { code: 'flow_retry_failure_conflict' })
  }
}

function retryAssociationError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && ['flow_task_scope_conflict', 'flow_retry_failure_conflict'].includes((error as { code?: string }).code ?? '')
}

function flowTaskResult(runtime: ServerRuntime, task: TaskRun) {
  if (task.status === 'completed') {
    const verification = task.templateId ? verifyTaskDelivery(runtime.taskRepository!, task) : { complete: true, reasons: [], files: [] }
    if (verification.complete) return { kind: 'output' as const, output: { taskId: task.id, artifacts: task.artifacts,
      files: verification.files, summary: task.finalResponse, text: task.finalResponse, role: 'assistant' } }
    return { kind: 'wait' as const, reason: 'task' as const, checkpoint: { taskId: task.id, threadId: task.threadId, resumable: true, pending: verification.reasons } }
  }
  if (task.status === 'failed' || task.status === 'cancelled') throw new Error(task.stalledReason ?? task.waitingReason ?? `Task ${task.status}`)
  return { kind: 'wait' as const, reason: 'task' as const, checkpoint: { taskId: task.id, threadId: task.threadId, resumable: true } }
}

function flowAgentPrompt(config: Record<string, unknown>, input: unknown): string {
  const instruction = typeof config.prompt === 'string' ? config.prompt.trim() : ''
  const body = typeof input === 'string' ? input : JSON.stringify(input)
  return [instruction, body].filter(Boolean).join('\n\n').slice(0, 256_000)
}

/** Polls only persisted state. Waiting tasks cause zero model requests. */
export class TaskDeliveryCoordinator {
  private timer?: ReturnType<typeof setInterval>
  private busy = false
  constructor(private readonly runtime: ServerRuntime) {}
  start(): void { if (this.timer) return; this.timer = setInterval(() => void this.tick(), 1000); this.timer.unref?.(); void this.tick() }
  shutdown(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }
  async tick(): Promise<void> {
    if (this.busy || !this.runtime.flowService || !this.runtime.taskRepository) return
    this.busy = true
    const service = this.runtime.flowService
    try {
      await service.flushSourceEvents()
      this.restoreRetriedFlowTasks()
      await this.resumeDurableHumanAnswers()
      for (const message of service.repository.pendingOutbox('delivery_task')) {
        const reference = message.payload as { taskId: string; threadId: string; turnId: string }
        const original = this.runtime.taskRepository.get(reference.taskId)
        const flow = service.repository.getRun(message.ownerId)
        if (!original || !flow) continue
        let task: TaskRun
        try { task = currentFlowTask(this.runtime, original, flow.id, flow.flowId) }
        catch (error) {
          if (!retryAssociationError(error)) throw error
          service.repository.transaction(() => {
            const key = `invalid-task-delivery:${message.id}`
            service.repository.beginOperation(flow.id, key, { taskId: reference.taskId })
            service.repository.finishOperation(flow.id, key, 'failed', { code: error.code, reason: error.message })
            service.repository.acknowledgeOutbox(message.id)
          })
          continue
        }
        if (flow.status === 'cancelled') {
          if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
            this.runtime.cancelChildRuns?.(task.threadId, '流程已取消')
            if (task.activeTurnId) await this.runtime.turnService.interruptTurn({ threadId: task.threadId, turnId: task.activeTurnId })
            const latest = this.runtime.taskRepository.get(task.id)
            if (latest && !['completed', 'failed', 'cancelled'].includes(latest.status)) this.runtime.taskController?.cancelTask(latest.id, latest.revision, '流程已取消')
          }
          service.repository.acknowledgeOutbox(message.id)
        } else if (flow.status === 'succeeded') {
          service.repository.acknowledgeOutbox(message.id)
        } else if (task.status === 'queued' && task.activeTurnId &&
          (flow.status === 'running' || flow.status === 'paused' && flow.checkpoint?.reason === 'task')) {
          // Resume a dispatch committed to both stores before a crash. runTurn joins a live attempt.
          if (this.runtime.turnService.getAbortController(task.activeTurnId)) {
            void Promise.resolve(this.runtime.runTurn(task.threadId, task.activeTurnId)).catch(() => undefined)
          }
        } else if (task.status === 'completed' && flow.status === 'paused' && flow.checkpoint?.reason === 'task') {
          const verification = task.templateId ? verifyTaskDelivery(this.runtime.taskRepository, task) : { complete: true }
          if (verification.complete) {
            await service.resume(flow.id)
            service.repository.acknowledgeOutbox(message.id)
          }
        } else if (['failed', 'cancelled'].includes(task.status) && !['succeeded', 'failed', 'cancelled'].includes(flow.status)) {
          service.repository.saveRun({ ...flow, status: task.status === 'failed' ? 'failed' : 'cancelled',
            output: { taskId: task.id, error: task.stalledReason ?? task.waitingReason ?? task.status, artifacts: task.artifacts }, updatedAt: this.runtime.nowIso(), completedAt: this.runtime.nowIso() })
          service.repository.acknowledgeOutbox(message.id)
        }
      }
      for (const message of service.repository.pendingOutbox('flow_resume')) {
        const run = service.repository.getRun(message.ownerId)
        if (run?.status === 'waiting_approval') await service.resume(run.id)
        service.repository.acknowledgeOutbox(message.id)
      }
    } catch (error) {
      // Keep the outbox for the next tick; no accepted work or callback is discarded.
      process.stderr.write(`[delivery] ${error instanceof Error ? error.message : String(error)}\n`)
    } finally { this.busy = false }
  }

  /** Task creation and its retry intent commit together. Cross-database delivery is idempotent. */
  private restoreRetriedFlowTasks(): void {
    const tasks = this.runtime.taskRepository!, flows = this.runtime.flowService!.repository
    for (const message of tasks.pendingOutbox('flow_task_retry')) {
      try {
        const { taskId, sourceTaskId, flowRunId, flowId } = message.payload
        if (typeof taskId !== 'string' || typeof sourceTaskId !== 'string' || typeof flowRunId !== 'string' || typeof flowId !== 'string') {
          throw Object.assign(new Error('Invalid persisted Flow task retry.'), { code: 'flow_task_scope_conflict' })
        }
        const retry = tasks.get(taskId), source = tasks.get(sourceTaskId)
        if (!retry || !source || retry.retryOfTaskId !== source.id || retry.flowRunId !== flowRunId || retry.flowId !== flowId ||
            source.flowRunId !== flowRunId || source.flowId !== flowId) throw Object.assign(new Error('Flow retry source association changed.'), { code: 'flow_task_scope_conflict' })
        const current = currentFlowTask(this.runtime, source, flowRunId, flowId)
        flows.transaction(() => {
          const flow = flows.getRun(flowRunId)
          if (!flow || flow.flowId !== flowId) throw Object.assign(new Error('Flow retry run association changed.'), { code: 'flow_task_scope_conflict' })
          if (flow.status === 'succeeded') return
          if (flow.status === 'failed') {
            assertFailedFlowTask(this.runtime, flow, current)
            flows.saveRun({ ...flow, status: 'paused', output: undefined, completedAt: undefined,
              checkpoint: { ...flow.checkpoint, taskId: current.id, threadId: current.threadId }, updatedAt: this.runtime.nowIso() })
          }
          // Cancelled runs keep their status. The normal delivery consumer cancels
          // any still-active retry if cancellation raced with retry preparation.
          flows.enqueueOutbox(`delivery-task-retry:${current.id}`, flow.id, 'delivery_task',
            { taskId: current.id, threadId: current.threadId, turnId: current.activeTurnId })
        })
        tasks.acknowledgeOutbox(message.id, this.runtime.nowIso())
      } catch (error) {
        if (!retryAssociationError(error)) throw error
        this.rejectRetryDelivery(message, error)
      }
    }
  }

  private rejectRetryDelivery(message: RuntimeOutboxItem, error: Error & { code: string }): void {
    const tasks = this.runtime.taskRepository!, now = this.runtime.nowIso()
    tasks.transact(() => {
      tasks.beginOperation({ ownerId: message.ownerId, idempotencyKey: message.id, kind: 'flow_retry_delivery', request: message.payload, nowIso: now })
      tasks.finishOperation(message.ownerId, message.id, { status: 'failed', error: error.message, result: { code: error.code } }, now)
      const task = tasks.get(message.ownerId)
      if (task) tasks.putAttention({ id: `flow-retry-rejected:${message.id}`, ownerKind: 'flow', ownerId: task.flowRunId ?? task.id,
        taskId: task.id, threadId: task.originThreadId ?? task.threadId, workspaceRoot: task.workspaceRoot, flowId: task.flowId, flowRunId: task.flowRunId,
        kind: 'blocked', title: '流程重试需要处理', message: error.message, status: 'pending', revision: 0, createdAt: now, updatedAt: now,
        payload: { kind: 'flow_retry_rejected', code: error.code } })
      tasks.acknowledgeOutbox(message.id, now)
    })
  }

  /**
   * A live gate resolver resumes the model turn directly. After a restart,
   * the resolver is gone, so the durable answer outbox must create a fresh
   * continuation turn before it can be acknowledged.
   */
  private async resumeDurableHumanAnswers(): Promise<void> {
    const repository = this.runtime.taskRepository
    if (!repository) return
    for (const message of repository.pendingOutbox('human_answer')) {
      const reference = message.payload as { taskId?: string; requestId?: string }
      if (!reference.taskId || !reference.requestId) {
        repository.acknowledgeOutbox(message.id, this.runtime.nowIso())
        continue
      }
      const task = repository.get(reference.taskId)
      const request = repository.humanRequest(reference.requestId)
      if (!task || !request || request.status !== 'answered') {
        repository.acknowledgeOutbox(message.id, this.runtime.nowIso())
        continue
      }
      if (task.status === 'paused') continue
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        repository.acknowledgeOutbox(message.id, this.runtime.nowIso())
        continue
      }
      // A user-initiated resume/retry owns tasks that are already executing;
      // only a task still waiting on this human request may be auto-woken.
      if (!['waiting_user', 'waiting_approval'].includes(task.status)) continue

      const thread = await this.runtime.threadService.get(task.threadId)
      if (!thread) continue
      const baseKey = `human-answer:${request.id}`
      const existing = thread.turns.find(turn => turn.idempotencyKey === baseKey)
      if (existing) {
        if (existing.status === 'running') {
          if (!this.runtime.turnService.getAbortController(existing.id)) {
            void Promise.resolve(this.runtime.runTurn(existing.threadId, existing.id)).catch(() => undefined)
          }
          repository.acknowledgeOutbox(message.id, this.runtime.nowIso())
        } else if (existing.status === 'completed') {
          repository.acknowledgeOutbox(message.id, this.runtime.nowIso())
        }
        continue
      }

      const activeTurn = task.activeTurnId ? thread.turns.find(turn => turn.id === task.activeTurnId) : undefined
      if (activeTurn?.status === 'running') {
        if (this.runtime.turnService.getAbortController(activeTurn.id)) continue
        await this.runtime.turnService.finishTurn({ threadId: task.threadId, turnId: activeTurn.id, status: 'aborted', reason: 'aborted' })
      }
      if (!this.runtime.taskCoordinator) throw new Error('Task coordinator is unavailable')
      const latest = repository.get(task.id)!
      const result = await this.runtime.taskCoordinator.command({
        threadId: task.originThreadId ?? task.threadId, taskId: task.id, intent: 'resume',
        expectedRevision: latest.revision, idempotencyKey: baseKey,
        request: { prompt: '继续处理已持久保存的用户回答', model: task.model, providerId: task.providerId, mode: 'agent' }
      })
      if (result.kind === 'task_started' || result.kind === 'capability_required') {
        repository.acknowledgeOutbox(message.id, this.runtime.nowIso())
      }
    }
  }
}
