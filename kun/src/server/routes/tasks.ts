import { z } from 'zod'
import { TaskControlService } from '../../services/task-control-service.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import { TaskRunStatusSchema, type TaskRun } from '../../contracts/tasks.js'
import { TaskSourceKindSchema } from '../../contracts/task-context.js'
import { WorkspaceReferenceSchema } from '../../contracts/workspace-references.js'
import { WorkspaceReferenceService } from '../../services/workspace-reference-service.js'
import { ERRORS } from './runtime-error.js'
import type { ServerRuntime } from './server-runtime.js'

const TaskMutationRequest = z.object({
  expectedRevision: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(1).max(256),
  model: z.string().trim().min(1).max(256).optional(),
  reason: z.string().trim().min(1).max(2_000).optional()
}).strict()
const TaskInputRequest = TaskMutationRequest.extend({
  text: z.string().trim().min(1).max(100_000),
  kind: z.enum(['supplement', 'user_answer', 'tool_result', 'handoff']).default('supplement'),
  attachmentIds:z.array(z.string().min(1)).max(32).optional(),workspaceReferences:z.array(WorkspaceReferenceSchema).max(32).optional()
})
const fallbackControls=new WeakMap<ServerRuntime,TaskControlService>()

async function isEngineeringExecutionTask(runtime: ServerRuntime, task: TaskRun): Promise<boolean> {
  if (task.engineeringPlanId || runtime.engineeringAi?.planForTask(task.threadId, task.id)) return true
  const thread = await runtime.threadService.get(task.threadId)
  return Boolean(thread?.turns.find(turn => turn.id === task.activeTurnId)?.engineeringExecution)
}

export function getTask(runtime: ServerRuntime, taskId: string): JsonResponse {
  const task = runtime.taskRepository?.get(taskId)
  return task ? jsonResponse(task) : ERRORS.notFound(`task not found: ${taskId}`)
}

export function listTasks(runtime: ServerRuntime, request: Request): JsonResponse {
  if (!runtime.taskRepository) return ERRORS.unavailable('task engine is unavailable')
  const url = new URL(request.url)
  if (url.searchParams.get('pagination') === 'cursor' && runtime.taskViewService) {
    const filter = url.searchParams.get('filter') ?? 'all'
    if (!['ongoing', 'attention', 'completed', 'all'].includes(filter)) return ERRORS.validation('invalid task filter')
    try { return jsonResponse(runtime.taskViewService.page({ workspaceRoot: url.searchParams.get('workspaceRoot') ?? undefined, threadId: url.searchParams.get('threadId') ?? undefined, search: url.searchParams.get('search') ?? undefined, filter: filter as 'all'|'ongoing'|'attention'|'completed', limit: numericQuery(url, 'limit', 50, 200), cursor: url.searchParams.get('cursor') ?? undefined })) } catch (error) { if ((error as {code?:string}).code === 'invalid_cursor') return ERRORS.validation((error as Error).message); throw error }
  }
  const status = url.searchParams.get('status')
  const parsed = status ? TaskRunStatusSchema.safeParse(status) : null
  if (parsed && !parsed.success) return ERRORS.validation('invalid task status', parsed.error.issues)
  try {
    return jsonResponse(runtime.taskRepository.list({
      threadId: url.searchParams.get('threadId') ?? undefined,
      workspaceRoot: url.searchParams.get('workspaceRoot') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
      ...(parsed?.success ? { status: parsed.data } : {}),
      limit: numericQuery(url, 'limit', 100, 500), offset: numericQuery(url, 'offset', 0, Number.MAX_SAFE_INTEGER),
      cursor: url.searchParams.get('cursor') ?? undefined
    }))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && String(error.code) === 'invalid_cursor') return ERRORS.validation('invalid task cursor')
    throw error
  }
}

export function getTaskEvents(runtime: ServerRuntime, taskId: string, request: Request): JsonResponse {
  if (!runtime.taskRepository?.get(taskId)) return ERRORS.notFound('task not found')
  return jsonResponse(runtime.taskRepository.events(taskId, numericQuery(new URL(request.url), 'afterSequence', 0, Number.MAX_SAFE_INTEGER)))
}
export function getTaskInputs(runtime: ServerRuntime, taskId: string): JsonResponse {
  if (!runtime.taskRepository?.get(taskId)) return ERRORS.notFound('task not found')
  return jsonResponse(runtime.taskRepository.inputs(taskId))
}
export function getTaskSubscriptions(runtime: ServerRuntime, taskId: string): JsonResponse {
  if (!runtime.taskContextRuntime || !runtime.taskRepository) return ERRORS.unavailable('task context is unavailable')
  const task = runtime.taskRepository.get(taskId)
  if (!task) return ERRORS.notFound('task not found')
  const session = runtime.taskRepository.execution.sessionForTask(taskId)
  return jsonResponse(session ? runtime.taskContextRuntime.repository.listSubscriptions({workerId:session.id}) : [])
}
export async function subscribeTaskSource(runtime: ServerRuntime, taskId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.taskContextRuntime || !runtime.taskRepository) return ERRORS.unavailable('task context is unavailable')
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = TaskMutationRequest.pick({expectedRevision:true,idempotencyKey:true}).extend({source:TaskSourceKindSchema,resourceKey:z.string().trim().min(1).max(1000),allowedFields:z.array(z.string().regex(/^(?:subject|labels|eventType|externalEventId|payload(?:\.[A-Za-z0-9_-]+)?)$/)).max(32).default(['subject','payload'])}).strict().safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid subscription',parsed.error.issues)
  try {
    const result = runtime.taskRepository.transact(() => {
      const repository = runtime.taskRepository!
      const existing = repository.operation(taskId,parsed.data.idempotencyKey)
      if (existing) { repository.beginOperation(taskId,parsed.data.idempotencyKey,parsed.data,'subscribe'); if (existing.status==='succeeded') return existing.result }
      const task = repository.get(taskId)
      if (!task) throw Object.assign(new Error('task not found'),{code:'not_found'})
      if (task.revision !== parsed.data.expectedRevision) throw Object.assign(new Error('task revision conflict'),{code:'stale_request'})
      if (['completed','failed','cancelled'].includes(task.status)) throw Object.assign(new Error('terminal task cannot subscribe'),{code:'invalid_state'})
      repository.beginOperation(taskId,parsed.data.idempotencyKey,parsed.data,'subscribe')
      runtime.taskContextRuntime!.subscribe(taskId,parsed.data.source,parsed.data.resourceKey,parsed.data.allowedFields)
      const next = repository.update(taskId,task.revision,current=>({...current,updatedAt:runtime.nowIso()}),{key:`subscribe:${parsed.data.idempotencyKey}`,kind:'task_subscription_added',payload:{source:parsed.data.source,resourceKey:parsed.data.resourceKey}})
      repository.finishOperation(taskId,parsed.data.idempotencyKey,{status:'succeeded',result:next},runtime.nowIso())
      return next
    })
    return jsonResponse(result,202)
  } catch (error) { return taskError(error) }
}
export function getTaskInbox(runtime: ServerRuntime, request: Request): JsonResponse {
  if (!runtime.taskRepository) return ERRORS.unavailable('task engine is unavailable')
  return jsonResponse(runtime.taskRepository.inbox(new URL(request.url).searchParams.get('workspaceRoot') ?? undefined))
}

export async function appendTaskInput(runtime: ServerRuntime, taskId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.taskController) return ERRORS.unavailable('task engine is unavailable')
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = TaskInputRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid task input', parsed.error.issues)
  try {
    const task = runtime.taskRepository?.get(taskId)
    if (!task) return ERRORS.notFound('task not found')
    if(parsed.data.workspaceReferences?.length) await new WorkspaceReferenceService().validateReferences(task.workspaceRoot,parsed.data.workspaceReferences)
    for(const id of parsed.data.attachmentIds ?? []) {
      if(!runtime.attachmentStore?.grantTaskReference) return ERRORS.unavailable('attachment reference service is unavailable')
      await runtime.attachmentStore.grantTaskReference(id,{threadId:task.originThreadId ?? task.threadId,workspace:task.workspaceRoot},{threadId:task.threadId,workspace:task.workspaceRoot})
    }
    const result = runtime.taskController.appendInput(taskId, parsed.data.expectedRevision, parsed.data.idempotencyKey, parsed.data.text, parsed.data.kind,undefined,{attachmentIds:parsed.data.attachmentIds,workspaceReferences:parsed.data.workspaceReferences})
    return jsonResponse(result, 202)
  } catch (error) { return taskError(error) }
}

export function getTaskDiagnostics(runtime: ServerRuntime, taskId: string): JsonResponse {
  const task = runtime.taskRepository?.get(taskId)
  if (!task) return ERRORS.notFound(`task not found: ${taskId}`)
  if (!runtime.spanService) return ERRORS.unavailable('runtime diagnostics are unavailable')
  return jsonResponse({ schema: 'workwise.task-diagnostics', version: 1, generatedAt: runtime.nowIso(), task: {
    id: task.id, status: task.status, attempts: task.attempts, replans: task.replans,
    nodeStatuses: task.nodes.map(node => ({ id: node.id, kind: node.kind, status: node.status })),
    artifactCount: task.artifacts.length, stalledReason: task.stalledReason
  }, ...runtime.spanService.diagnostics(taskId) })
}

export async function resumeTask(runtime: ServerRuntime, taskId: string, request: Request): Promise<JsonResponse | Response> {
  return mutateTask(runtime, taskId, request, 'resume')
}
export async function retryTask(runtime: ServerRuntime, taskId: string, request: Request): Promise<JsonResponse | Response> {
  return mutateTask(runtime, taskId, request, 'retry')
}
export async function cancelTask(runtime: ServerRuntime, taskId: string, request: Request): Promise<JsonResponse | Response> {
  return mutateTask(runtime, taskId, request, 'cancel')
}
export async function pauseTask(runtime: ServerRuntime, taskId: string, request: Request): Promise<JsonResponse | Response> {
  return mutateTask(runtime, taskId, request, 'pause')
}

type Action = 'resume' | 'retry' | 'cancel' | 'pause'
async function mutateTask(runtime: ServerRuntime, taskId: string, request: Request, action: Action): Promise<JsonResponse | Response> {
  const repository = runtime.taskRepository
  const controller = runtime.taskController
  if (!repository || !controller) return ERRORS.unavailable('task engine is unavailable')
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = TaskMutationRequest.safeParse(body.value)
  if (!parsed.success) return ERRORS.validation(`invalid task ${action} body`, parsed.error.issues)
  try {
    let controls=runtime.taskControlService ?? fallbackControls.get(runtime)
    if(!controls) {
      controls=new TaskControlService({repository,tasks:controller,threads:runtime.threadService,turns:runtime.turnService,runTurn:(threadId,turnId)=>runtime.runTurn(threadId,turnId),cancelChildRuns:runtime.cancelChildRuns,isEngineeringTask:task=>isEngineeringExecutionTask(runtime,task),nowIso:runtime.nowIso})
      fallbackControls.set(runtime,controls)
    }
    const result=await controls.mutate(taskId,action,parsed.data)
    return jsonResponse(action==='resume'||action==='retry'?result:result.task,action==='resume'||action==='retry'?202:200)
  } catch(error) { return taskError(error) }
}

function numericQuery(url: URL, key: string, fallback: number, max: number): number {
  const value = Number(url.searchParams.get(key) ?? fallback)
  return Number.isFinite(value) ? Math.max(0, Math.min(Math.trunc(value), max)) : fallback
}
function taskError(error: unknown): JsonResponse {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'model_provider_unavailable') return jsonResponse({ code, message }, 400)
  if (code === 'not_found') return ERRORS.notFound(message)
  if (['stale_request', 'invalid_state', 'turn_in_progress', 'idempotency_conflict','outcome_unknown'].includes(code)) return ERRORS.conflict(message)
  if (code === 'resource_limit') return ERRORS.resourceLimit(message)
  return jsonResponse({ code: code || 'task_error', message }, 500)
}
