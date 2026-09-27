import { z } from 'zod'
import { jsonResponse, type JsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import { TaskRunStatusSchema } from '../../contracts/tasks.js'
import { ERRORS } from './runtime-error.js'
import type { ServerRuntime } from './server-runtime.js'
import type { TaskRun } from '../../contracts/tasks.js'

async function isEngineeringExecutionTask(runtime: ServerRuntime, task: TaskRun): Promise<boolean> {
  if (task.engineeringPlanId || runtime.engineeringAi?.planForTask(task.threadId, task.id)) return true
  const thread = await runtime.threadService.get(task.threadId)
  return Boolean(thread?.turns.find(turn => turn.id === task.activeTurnId)?.engineeringExecution)
}

const TaskMutationRequest = z.object({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().min(1).max(256),
  model: z.string().trim().min(1).max(256).optional(),
  reason: z.string().trim().min(1).max(2_000).optional()
}).strict()

export function getTask(runtime: ServerRuntime, taskId: string): JsonResponse {
  const task = runtime.taskRepository?.get(taskId)
  return task ? jsonResponse(task) : ERRORS.notFound(`task not found: ${taskId}`)
}

export function listTasks(runtime: ServerRuntime, request: Request): JsonResponse {
  if (!runtime.taskRepository) return ERRORS.unavailable('task engine is unavailable')
  const url = new URL(request.url)
  const statusValue = url.searchParams.get('status')
  const parsedStatus = statusValue ? TaskRunStatusSchema.safeParse(statusValue) : null
  if (parsedStatus && !parsedStatus.success) return ERRORS.validation('invalid task status', parsedStatus.error.issues)
  const limitValue = Number(url.searchParams.get('limit') || 100)
  return jsonResponse(runtime.taskRepository.list({
    ...(url.searchParams.get('threadId') ? { threadId: url.searchParams.get('threadId')! } : {}),
    ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
    limit: Number.isFinite(limitValue) ? Math.max(1, Math.min(Math.trunc(limitValue), 500)) : 100
  }))
}

export function getTaskDiagnostics(runtime: ServerRuntime, taskId: string): JsonResponse {
  const task = runtime.taskRepository?.get(taskId)
  if (!task) return ERRORS.notFound(`task not found: ${taskId}`)
  if (!runtime.spanService) return ERRORS.unavailable('runtime diagnostics are unavailable')
  return jsonResponse({
    schema: 'workwise.task-diagnostics',
    version: 1,
    generatedAt: runtime.nowIso(),
    task: {
      id: task.id,
      status: task.status,
      attempts: task.attempts,
      replans: task.replans,
      nodeStatuses: task.nodes.map((node) => ({ id: node.id, kind: node.kind, status: node.status })),
      artifactCount: task.artifacts.length,
      stalledReason: task.stalledReason
    },
    ...runtime.spanService.diagnostics(taskId)
  })
}

export async function resumeTask(runtime: ServerRuntime, taskId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.taskController || !runtime.taskRepository) return ERRORS.unavailable('task engine is unavailable')
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = TaskMutationRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid task resume body', parsed.error.issues)
  try {
    const current = runtime.taskRepository.get(taskId)
    if (current && await isEngineeringExecutionTask(runtime, current)) return ERRORS.conflict('engineering_plan_typed_resume_required: continue or replan from the approved engineering plan')
    const prepared = runtime.taskController.prepareResume(taskId, parsed.data.expectedRevision, parsed.data.model)
    const checkpoint = runtime.taskRepository.latestCheckpoint(taskId)
    const response = await runtime.turnService.startTurn({
      threadId: prepared.threadId,
      continuationTaskId: prepared.id,
      request: {
        prompt: [
          'Continue the persisted task from its last verified checkpoint.',
          `Goal: ${prepared.goal}`,
          checkpoint?.resumeSummary ? `Checkpoint: ${checkpoint.resumeSummary}` : '',
          'Do not repeat completed external side effects. Verify the acceptance contract before stopping.'
        ].filter(Boolean).join('\n'),
        displayText: '继续未完成任务',
        model: parsed.data.model ?? prepared.model,
        providerId: prepared.providerId,
        reasoningEffort: prepared.reasoningEffort,
        mode: 'agent'
      }
    })
    runtime.runTurn(response.threadId, response.turnId)
    return jsonResponse({ task: runtime.taskRepository.get(taskId), turn: response }, 202)
  } catch (error) {
    return taskError(error)
  }
}

export async function retryTask(runtime: ServerRuntime, taskId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.taskRepository) return ERRORS.unavailable('task engine is unavailable')
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = TaskMutationRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid task retry body', parsed.error.issues)
  const previous = runtime.taskRepository.get(taskId)
  if (!previous) return ERRORS.notFound(`task not found: ${taskId}`)
  if (previous.revision !== parsed.data.expectedRevision) return ERRORS.conflict('task revision conflict')
  if (!['failed', 'cancelled'].includes(previous.status)) {
    return ERRORS.conflict('retry is only valid for a terminal failed or cancelled task; use resume otherwise')
  }
  try {
    if (await isEngineeringExecutionTask(runtime, previous)) return ERRORS.conflict('engineering_plan_typed_resume_required: continue or replan from the approved engineering plan')
    const response = await runtime.turnService.startTurn({
      threadId: previous.threadId,
      request: {
        prompt: `Retry the failed persisted task and satisfy its original acceptance contract.\nGoal: ${previous.goal}`,
        displayText: '重试未完成任务',
        model: parsed.data.model ?? previous.model,
        providerId: previous.providerId,
        reasoningEffort: previous.reasoningEffort,
        mode: 'agent'
      }
    })
    runtime.runTurn(response.threadId, response.turnId)
    return jsonResponse({ task: runtime.taskRepository.findActiveByThread(previous.threadId), turn: response }, 202)
  } catch (error) {
    return taskError(error)
  }
}

export async function cancelTask(runtime: ServerRuntime, taskId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.taskController || !runtime.taskRepository) return ERRORS.unavailable('task engine is unavailable')
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = TaskMutationRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid task cancel body', parsed.error.issues)
  try {
    const current = runtime.taskRepository.get(taskId)
    if (!current) return ERRORS.notFound(`task not found: ${taskId}`)
    if (current.revision !== parsed.data.expectedRevision) return ERRORS.conflict('task revision conflict')
    if (current.status === 'cancelled') return jsonResponse(current)
    if (current.status === 'completed' || current.status === 'failed') {
      return ERRORS.conflict(`task cannot be cancelled from ${current.status}`)
    }

    const reason = parsed.data.reason ?? '用户取消了任务。'
    runtime.cancelChildRuns?.(current.threadId, reason)
    if (current.activeTurnId) {
      await runtime.turnService.interruptTurn({
        threadId: current.threadId,
        turnId: current.activeTurnId
      })
      const interrupted = runtime.taskRepository.get(taskId)
      if (interrupted?.status === 'cancelled') return jsonResponse(interrupted)
      if (interrupted) {
        return jsonResponse(runtime.taskController.cancelTask(taskId, interrupted.revision, reason))
      }
    }
    return jsonResponse(runtime.taskController.cancelTask(taskId, current.revision, reason))
  } catch (error) {
    return taskError(error)
  }
}

function taskError(error: unknown): JsonResponse {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'model_provider_unavailable') return jsonResponse({ code, message }, 400)
  if (code === 'not_found') return ERRORS.notFound(message)
  if (code === 'stale_request' || code === 'invalid_state' || code === 'turn_in_progress') return ERRORS.conflict(message)
  if (code === 'resource_limit') return ERRORS.resourceLimit(message)
  return jsonResponse({ code: code || 'task_error', message }, 500)
}
