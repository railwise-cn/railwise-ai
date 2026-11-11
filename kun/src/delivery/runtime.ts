import { createHash } from 'node:crypto'
import type { FlowAdapterContext, FlowNodeAdapter } from '../flow/executor.js'
import type { TaskRun } from '../contracts/tasks.js'
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
  if (previous) return flowTaskResult(runtime, previous)

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
      await this.resumeDurableHumanAnswers()
      for (const message of service.repository.pendingOutbox('delivery_task')) {
        const reference = message.payload as { taskId: string; threadId: string; turnId: string }
        const task = this.runtime.taskRepository.get(reference.taskId)
        const flow = service.repository.getRun(message.ownerId)
        if (!task || !flow) continue
        if (flow.status === 'cancelled') {
          if (!['completed', 'failed', 'cancelled'].includes(task.status)) {
            this.runtime.cancelChildRuns?.(task.threadId, '流程已取消')
            if (task.activeTurnId) await this.runtime.turnService.interruptTurn({ threadId: task.threadId, turnId: task.activeTurnId })
            const latest = this.runtime.taskRepository.get(task.id)
            if (latest && !['completed', 'failed', 'cancelled'].includes(latest.status)) this.runtime.taskController?.cancelTask(latest.id, latest.revision, '流程已取消')
          }
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
