import { BrowserTaskBindingConfirmation } from '../../contracts/browser-skill.js'
import { hostShellReceiptProjection } from '../../services/host-shell-verification.js'
import { z } from 'zod'
import { TaskControlService } from '../../services/task-control-service.js'
import { TaskPermissionRevocationSchema, TaskPermissionConfirmationSchema } from '../../contracts/permissions.js'
import { jsonResponse, type JsonResponse } from '../response.js'
import { readJsonBody } from '../read-json-body.js'
import { TaskRunStatusSchema, type TaskRun } from '../../contracts/tasks.js'
import { TaskSourceKindSchema } from '../../contracts/task-context.js'
import { ResultEvidenceSchema } from '../../contracts/harness.js'
import { externalOperationForTool, receiptEffectDefinition } from '../../services/external-effect-evidence.js'
import { WorkspaceReferenceSchema } from '../../contracts/workspace-references.js'
import { WorkspaceReferenceService } from '../../services/workspace-reference-service.js'
import { ERRORS } from './runtime-error.js'
import type { ServerRuntime } from './server-runtime.js'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { authorizedArtifactWrites, containedArtifact } from '../../services/task-artifact-proof.js'
import { validateArtifactFile } from '../../services/artifact-validator.js'

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

export async function getTaskArtifactProof(runtime: ServerRuntime, taskId: string, artifactId: string): Promise<JsonResponse> {
  const task = runtime.taskRepository?.get(taskId)
  const artifact = task?.artifacts.find(item => item.id === artifactId)
  if (!task || !artifact) return ERRORS.notFound('Task artifact was not found.')
  if (artifact.validation !== 'valid' || !artifact.sha256) {
    return ERRORS.conflict('该成果尚未通过授权与内容验证。')
  }
  const workspace = artifact.absolutePath ? '' : await realpath(task.workspaceRoot).catch(() => '')
  if (!artifact.absolutePath && (!workspace || !containedArtifact(workspace, resolve(workspace, artifact.relativePath)))) return ERRORS.conflict('成果超出当前工作区范围。')
  const path = artifact.absolutePath ?? resolve(workspace, artifact.relativePath)
  const canonical = await realpath(path).catch(() => '')
  if (!canonical || canonical !== path) return ERRORS.conflict('成果路径已变化，请重新核验。')
  const thread = await runtime.threadService.get(task.threadId)
  const proof = (await authorizedArtifactWrites(task, runtime.taskRepository!.operations(task.id, 'tool'), thread?.turns ?? [])).get(canonical)
  if (!proof || (artifact.executionGrantId && proof.executionGrantId !== artifact.executionGrantId) || (artifact.authorizedRoot && proof.authorizedRoot !== artifact.authorizedRoot) || proof.sha256 !== artifact.sha256) {
    return ERRORS.conflict('无法核对该成果的写入回执与执行授权。')
  }
  const verified = await validateArtifactFile(canonical, artifact.format ?? '').catch(() => null)
  if (!verified?.valid || verified.sha256 !== artifact.sha256) return ERRORS.conflict('成果内容在交付后已变化，请重新审阅。')
  return jsonResponse({ taskId, artifactId, ...proof })
}

export async function getTaskPermissions(runtime:ServerRuntime,taskId:string):Promise<JsonResponse> {
  if(!runtime.taskPermissionService)return ERRORS.unavailable('task permission service is unavailable')
  try{return jsonResponse(await runtime.taskPermissionService.snapshot(taskId))}catch(error){return taskPermissionError(error)}
}

export async function confirmTaskPermissions(runtime:ServerRuntime,taskId:string,request:Request):Promise<JsonResponse|Response> {
  if(!runtime.taskPermissionService)return ERRORS.unavailable('task permission service is unavailable')
  const body=await readJsonBody(request)
  if(!body.ok)return body.response
  const parsed=TaskPermissionConfirmationSchema.safeParse(body.value)
  if(!parsed.success)return ERRORS.validation('invalid scoped task permission confirmation',parsed.error.issues)
  try{return jsonResponse(await runtime.taskPermissionService.confirm(taskId,parsed.data))}catch(error){return taskPermissionError(error)}
}

export async function revokeTaskPermissions(runtime:ServerRuntime,taskId:string,request:Request):Promise<JsonResponse|Response> {
  if(!runtime.taskPermissionService || !runtime.taskControlService)return ERRORS.unavailable('task permission service is unavailable')
  const body=await readJsonBody(request)
  if(!body.ok)return body.response
  const parsed=TaskPermissionRevocationSchema.safeParse(body.value)
  if(!parsed.success)return ERRORS.validation('invalid task permission revocation',parsed.error.issues)
  try {
    await runtime.taskPermissionService.revoke(taskId,parsed.data)
    const pauseKey=`permission-revoke:${parsed.data.idempotencyKey}`
    let paused=false
    for(let attempt=0;attempt<3;attempt++) {
      const current=runtime.taskRepository!.get(taskId)!
      const previous=runtime.taskRepository!.operation?.(taskId,pauseKey)
      const permission=await runtime.taskPermissionService.snapshot(taskId)
      if(permission.grant?.id && permission.grant.id!==parsed.data.permissionId)throw Object.assign(new Error('原授权已撤销，当前任务已有新的权限。请刷新查看。'),{code:'stale_request'})
      const expectedRevision=typeof previous?.request?.expectedRevision==='number' ? previous.request.expectedRevision : current.revision
      try {
        await runtime.taskControlService.mutate(taskId,'pause',{expectedRevision,idempotencyKey:pauseKey,reason:'临时任务授权已撤销，任务已暂停。'})
        paused=true
        break
      }catch(error) {
        if((error as {code?:string}).code!=='stale_request' || previous)throw error
      }
    }
    if(!paused)throw Object.assign(new Error('临时授权已撤销，任务状态正在变化，请刷新后重试暂停。'),{code:'stale_request'})
    return jsonResponse({task:runtime.taskRepository!.get(taskId),permission:await runtime.taskPermissionService.snapshot(taskId),resumed:false})
  }catch(error){return taskPermissionError(error)}
}

function taskPermissionError(error:unknown):JsonResponse {
  const code=error&&typeof error==='object'&&'code'in error?String(error.code):'task_permission_error'
  const message=error instanceof Error?error.message:String(error)
  return jsonResponse({code,message},code==='not_found'?404:['stale_request','idempotency_conflict','outcome_unknown','task_permission_blocked','task_permission_revoked','task_permission_expired','task_permission_consumed','sandbox_read_only','workspace_path_blocked','network_scope_blocked','execution_grant_scope','external_target_blocked'].includes(code)?409:500)
}

/** User-facing receipt summary; never return raw tool output or authority/credential records. */
export function getTaskOperationReceipts(runtime: ServerRuntime, taskId: string): JsonResponse {
  if (!runtime.taskRepository?.get(taskId)) return ERRORS.notFound(`task not found: ${taskId}`)
  const receipts = runtime.taskRepository.operations(taskId, 'tool').flatMap(receipt => {
    const request = receipt.request ?? {}
    const toolName = typeof request.toolName === 'string' ? request.toolName : ''
    const operation = receiptEffectDefinition(receipt) ?? runtime.toolHost?.describeEffect?.(toolName) ?? externalOperationForTool(toolName)
    if (!operation || request.provider !== operation.provider || request.operation !== operation.operation) return []
    const result = receipt.result && typeof receipt.result === 'object' ? receipt.result as Record<string, unknown> : {}
    const item = result.item && typeof result.item === 'object' ? result.item as Record<string, unknown> : {}
    const output = item.output && typeof item.output === 'object' ? item.output as Record<string, unknown> : {}
    const target = typeof request.target === 'string' ? request.target : undefined
    const resolution = runtime.taskRepository!.verifiedOperationResolution(receipt)
    const parsedEvidence = ResultEvidenceSchema.safeParse(output.evidence ?? receipt.evidence)
    const mutating = operation.mutation
    const evidence = receipt.status === 'succeeded' && item.isError !== true && output.ok === true && output.status === 'succeeded' &&
      (!mutating || result.approved === true) && parsedEvidence.success && parsedEvidence.data.kind === 'external_operation' &&
      parsedEvidence.data.verified && parsedEvidence.data.provider === operation.provider &&
      parsedEvidence.data.operation === operation.operation && parsedEvidence.data.target === target
      ? parsedEvidence.data : undefined
    const errorCode = typeof output.code === 'string' && /^[a-z][a-z0-9_.:-]{0,99}$/i.test(output.code) ? output.code : undefined
    return [{ id: receipt.id, taskId, ...operation, toolName, ...(target ? { target } : {}),
      requestHash: receipt.fingerprint, status: receipt.status,
      ...(evidence ? { evidence } : {}), ...(resolution ? { resolution } : {}),
      ...(evidence?.remoteOperationId || receipt.remoteOperationId ? { remoteOperationId: evidence?.remoteOperationId ?? receipt.remoteOperationId } : {}),
      ...(errorCode ? { errorCode } : {}), createdAt: receipt.createdAt, updatedAt: receipt.updatedAt }]
  })
  const deliveries = runtime.taskRepository.operations(taskId, 'im_delivery').flatMap(receipt => {
    const request = receipt.request ?? {}
    if (request.purpose !== 'assistant_reply' || !['feishu', 'weixin'].includes(String(request.provider))) return []
    return [{ id: receipt.id, taskId, purpose: 'assistant_reply', provider: request.provider,
      operation: 'deliver_reply', phase: request.phase, toolName: 'im_delivery', target: request.targetFingerprint,
      requestHash: request.requestHash, status: receipt.status, ...(receipt.remoteOperationId ? { remoteOperationId: receipt.remoteOperationId } : {}),
      createdAt: receipt.createdAt, updatedAt: receipt.updatedAt }]
  })
  const hostShell = runtime.taskRepository.operations(taskId, 'host_shell').map(hostShellReceiptProjection)
  return jsonResponse([...receipts, ...deliveries, ...hostShell])
}

export async function verifyTaskOperationReceipt(runtime: ServerRuntime, taskId: string, receiptId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.verifyTaskOperationReceipt) return ERRORS.unavailable('operation verification is unavailable')
  const body = await readJsonBody(request)
  if (!body.ok) return body.response
  const parsed = TaskMutationRequest.pick({ expectedRevision: true, idempotencyKey: true }).strict().safeParse(body.value)
  if (!parsed.success) return ERRORS.validation('invalid verification request', parsed.error.issues)
  try { return jsonResponse(await runtime.verifyTaskOperationReceipt(taskId, receiptId, parsed.data)) }
  catch (error) { return taskError(error) }
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
    if (result.capability) await runtime.taskCoordinator?.flushCommandMessages()
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
  if (['stale_request', 'invalid_state', 'turn_in_progress', 'idempotency_conflict','outcome_unknown','external_effect_retry_blocked'].includes(code)) return code==='external_effect_retry_blocked'?jsonResponse({code,message},409):ERRORS.conflict(message)
  if (code === 'resource_limit') return ERRORS.resourceLimit(message)
  return jsonResponse({ code: code || 'task_error', message }, 500)
}

export async function taskBrowserBinding(runtime: ServerRuntime, taskId: string, request: Request): Promise<JsonResponse | Response> {
  if (!runtime.browserTaskBinding || !runtime.confirmBrowserTaskBinding) return ERRORS.unavailable('Browser connection is unavailable')
  try {
    if (request.method === 'GET') return jsonResponse(runtime.browserTaskBinding(taskId))
    const body = await readJsonBody(request)
    if (!body.ok) return body.response
    const parsed = BrowserTaskBindingConfirmation.safeParse(body.value)
    if (!parsed.success) return ERRORS.validation('Invalid browser task binding confirmation', parsed.error.issues)
    return jsonResponse(runtime.confirmBrowserTaskBinding(taskId, parsed.data))
  } catch (error) { return ERRORS.conflict(error instanceof Error ? error.message : 'browser_binding_failed') }
}
