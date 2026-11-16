import type { ToolCallLike } from '../ports/tool-host.js'
import { createHash } from 'node:crypto'
import type { ExecutionGrant } from '../contracts/permissions.js'
import type { OperationReceipt, TaskRun } from '../contracts/tasks.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export type EgoClosedSpaceReopenAuthorization = { controlOwnerId: string; resumeReceiptId: string; turnId: string; priorBindingReceiptId: string }

/** Append-only incarnations: an incomplete latest create must never revive an older Space. */
export function currentEgoTaskSpaceBinding(repository: TaskRunRepository, taskId: string): OperationReceipt | null {
  return verifiedEgoBindingThrough(repository, taskId)
}

function verifiedEgoBindingThrough(repository: TaskRunRepository, taskId: string, receiptId?: string): OperationReceipt | null {
  const bindings = repository.operations(taskId, 'ego_task_space')
  if (!bindings.length) return null
  const task = repository.get(taskId), reject = (): never => { throw Object.assign(new Error('Ego task space binding chain is not verified.'), { code: 'ego_browser_task_space_unconfirmed' }) }
  if (!task) return reject()
  let current: OperationReceipt | undefined
  for (const binding of bindings) {
    const request = object(binding.request), space = object(binding.result)
    if (binding.ownerId !== taskId || binding.fingerprint !== operationFingerprint(binding.request) || request.taskId !== taskId || request.threadId !== task.threadId ||
      typeof request.nonce !== 'string' || !request.nonce || request.spaceName !== `RailWise read-only ${taskId} ${request.nonce}` ||
      typeof request.createdTurnId !== 'string' || !request.createdTurnId || typeof request.configurationFingerprint !== 'string' || !Array.isArray(request.origins)) return reject()
    if (binding.status === 'succeeded' && (!Number.isSafeInteger(space.taskSpaceId) || Number(space.taskSpaceId) < 1 || space.ownership !== 'agent' || space.pageLabel !== 'p1')) return reject()
    if (!current) {
      if (binding.idempotencyKey !== 'ego-task-space' || request.priorBindingReceiptId !== undefined || request.resumeReceiptId !== undefined || request.reopenReceiptId !== undefined) return reject()
    } else {
      const previous = object(current.result), reopen = repository.operationById(taskId, String(request.reopenReceiptId), 'ego_task_space_reopen')
      const consume = object(reopen?.request), closed = object(reopen?.result)
      const resume = typeof request.controlOwnerId === 'string' ? repository.operationById(request.controlOwnerId, String(request.resumeReceiptId), 'resume') : null
      const resumed = object(resume?.result), resumedTask = object(resumed.task), resumedTurn = object(resumed.turn)
      const host = repository.operationById(taskId, String(consume.hostOperationId), 'tool'), invocation = object(host?.request), grant = object(invocation.executionGrant)
      const owners = new Set<string>(); let ancestor: TaskRun | null = task
      while (ancestor && !owners.has(ancestor.id)) { owners.add(ancestor.id); ancestor = ancestor.retryOfTaskId ? repository.get(ancestor.retryOfTaskId) : null }
      if (current.status !== 'succeeded' || request.priorBindingReceiptId !== current.id || current.request?.createdTurnId === request.createdTurnId ||
        request.nonce === current.request?.nonce || request.configurationFingerprint !== current.request?.configurationFingerprint || operationFingerprint(request.origins) !== operationFingerprint(current.request?.origins) ||
        !owners.has(String(request.controlOwnerId)) || !resume || resume.status !== 'succeeded' || resume.fingerprint !== operationFingerprint(resume.request) ||
        resumedTask.id !== taskId || resumedTask.threadId !== task.threadId || resumedTurn.threadId !== task.threadId || resumedTurn.turnId !== request.createdTurnId ||
        binding.idempotencyKey !== `ego-task-space:resume:${resume.id}` || !reopen || reopen.status !== 'succeeded' || reopen.fingerprint !== operationFingerprint(reopen.request) ||
        reopen.idempotencyKey !== `ego-reopen:${resume.id}` || consume.controlOwnerId !== request.controlOwnerId || consume.resumeReceiptId !== resume.id || consume.turnId !== request.createdTurnId ||
        consume.priorBindingReceiptId !== current.id || consume.newBindingKey !== binding.idempotencyKey || consume.nonce !== request.nonce || consume.spaceName !== request.spaceName ||
        consume.configurationFingerprint !== request.configurationFingerprint || consume.priorTaskSpaceId !== previous.taskSpaceId || consume.priorSpaceName !== current.request?.spaceName ||
        !host || host.fingerprint !== operationFingerprint(host.request) || invocation.providerId !== 'ego-browser' || invocation.toolName !== 'ego_browser_open' || invocation.turnId !== request.createdTurnId ||
        invocation.callId !== consume.callId || grant.taskId !== taskId || grant.threadId !== task.threadId || grant.turnId !== request.createdTurnId ||
        consume.grantFingerprint !== operationFingerprint(invocation.executionGrant) || object(grant.connectorIdentityFingerprints)['ego-browser'] !== request.configurationFingerprint ||
        !Number.isSafeInteger(previous.taskSpaceId) || Number(previous.taskSpaceId) < 1 || previous.ownership !== 'agent' || previous.pageLabel !== 'p1' ||
        closed.closed !== true || closed.priorTaskSpaceId !== previous.taskSpaceId || closed.priorSpaceName !== current.request?.spaceName || closed.idMatch !== false || closed.nameMatches !== 0) return reject()
    }
    current = binding
    if (binding.id === receiptId) return binding
  }
  return receiptId ? null : current ?? null
}

function knownEgoTaskSpaceBinding(repository: TaskRunRepository, taskId: string, receiptId: string): boolean {
  try {
    return verifiedEgoBindingThrough(repository, taskId, receiptId)?.id === receiptId
  } catch { /* A read must prove its own incarnation, without rewriting an earlier verified read. */ }
  return false
}
/** Extra connector seal, in addition to the caller's genuine Host/item/Turn/Grant checks. */
export function validEgoDocumentEvidence(repository: TaskRunRepository, task: TaskRun, output: Record<string, unknown>, grant: ExecutionGrant): boolean {
  let origin:string
  try { const u=new URL(String(output.sourceUrl)); if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return false;origin=u.origin }catch{return false}
  const e = object(output.evidence), binding = repository.operationById(task.id, String(e.bindingReceiptId), 'ego_task_space'), read = repository.operationById(task.id, String(e.readReceiptId), 'ego_document_read')
  if (output.provider !== 'ego-browser' || output.status !== 'succeeded' || output.sourceKind !== 'actual_ego_document' || !['document','element'].includes(String(output.readScope)) ||
    output.truncated !== false || typeof output.html !== 'string' || !output.html.trim() || !binding || !knownEgoTaskSpaceBinding(repository, task.id, binding.id) || !read || binding.status !== 'succeeded' || read.status !== 'succeeded' ||
    binding.fingerprint !== operationFingerprint(binding.request) || read.fingerprint !== operationFingerprint(read.request) || e.verified !== true || e.contentRead !== true ||
    grant.browserScope?.provider !== 'ego-browser' || grant.taskId !== task.id || e.taskId !== task.id || e.turnId !== grant.turnId ||
    e.grantFingerprint !== operationFingerprint(grant) || e.configurationFingerprint !== grant.connectorIdentityFingerprints?.['ego-browser']) return false
  const b = object(binding.result), saved = object(read.result), req = object(read.request)
  if(output.readScope==='element') {
    const selection=object(e.selection), savedSelection=object(saved.selection), context=repository.operationById(task.id,String(selection.contextReceiptId))
    if(typeof selection.selector!=='string'||selection.matchedCount!==1||operationFingerprint(selection)!==operationFingerprint(savedSelection)||req.selector!==selection.selector||req.contextReceiptId!==selection.contextReceiptId||
      !context||!['ego_document_read','ego_observation'].includes(context.kind)||context.status!=='succeeded'||context.fingerprint!==operationFingerprint(context.request)||
      object(context.result).sourceUrl!==output.sourceUrl||object(context.result).taskSpaceId!==e.taskSpaceId||typeof object(context.result).documentHtml!=='string'||
      selection.documentHash!==createHash('sha256').update(String(object(context.result).documentHtml)).digest('hex'))return false
  } else if(e.selection!==undefined||saved.selection!==undefined)return false
  const host=repository.operationById(task.id,String(req.hostOperationId),'tool'), hostResult=object(host?.result), hostItem=object(hostResult.item), hostRequest=object(host?.request)
  if(!host||host.status!=='succeeded'||host.fingerprint!==operationFingerprint(host.request)||hostResult.approved!==true||hostItem.isError===true||hostRequest.providerId!=='ego-browser'||hostRequest.callId!==req.callId||
    hostRequest.turnId!==grant.turnId||operationFingerprint(hostRequest.executionGrant)!==operationFingerprint(grant)||operationFingerprint(hostItem.output)!==operationFingerprint(output))return false
  const hash = createHash('sha256').update(output.html).digest('hex')
  return b.taskSpaceId === e.taskSpaceId && b.pageLabel === e.pageLabel && b.ownership === 'agent' &&
    binding.request?.taskId === task.id && binding.request.threadId === task.threadId && binding.request.configurationFingerprint === e.configurationFingerprint &&
    e.resultHash === hash && output.resultHash === hash && req.taskId === task.id && req.turnId === grant.turnId && req.taskSpaceId === e.taskSpaceId &&
    req.grantFingerprint === e.grantFingerprint && req.configurationFingerprint === e.configurationFingerprint &&
    Array.isArray(binding.request.origins) && binding.request.origins.includes(origin) && grant.browserScope.origins.includes(origin) &&
    operationFingerprint(saved.pagination)===operationFingerprint(output.pagination) && saved.loadingObserved===output.loadingObserved && saved.emptyObserved===output.emptyObserved &&
    saved.sourceUrl === output.sourceUrl && saved.resultHash === hash && saved.html === output.html && saved.truncated === false && saved.taskSpaceId === e.taskSpaceId
}

/** Trusted successful navigation progress only, never a model status or URL assertion. */
export function validEgoNavigationProgress(repository:TaskRunRepository,task:TaskRun,output:Record<string,unknown>,grant:ExecutionGrant,call:ToolCallLike):boolean {
  if(call.providerId!=='ego-browser'||!['ego_browser_open','ego_browser_next_page'].includes(call.toolName)||output.readScope!=='document'||!validEgoDocumentEvidence(repository,task,output,grant))return false
  const e=object(output.evidence), nav=repository.operationById(task.id,String(e.navigationReceiptId),'ego_page_navigation')
  if(!nav||nav.status!=='succeeded'||nav.fingerprint!==operationFingerprint(nav.request))return false
  const req=object(nav.request), result=object(nav.result), read=repository.operationById(task.id,String(e.readReceiptId),'ego_document_read')
  if(req.callId!==call.callId||req.hostOperationId!==read?.request?.hostOperationId||req.turnId!==grant.turnId||req.grantFingerprint!==operationFingerprint(grant)||req.configurationFingerprint!==e.configurationFingerprint||
    result.taskSpaceId!==e.taskSpaceId||result.sourceUrl!==output.sourceUrl||result.resultHash!==output.resultHash)return false
  const binding=repository.operationById(task.id,String(e.bindingReceiptId),'ego_task_space')
  if(req.firstCreatedSpace===true)return call.toolName==='ego_browser_open'&&req.previousReadReceiptId===null&&binding?.request?.nonce!==undefined&&req.taskSpaceId===null
  const previous=repository.operationById(task.id,String(req.previousReadReceiptId),'ego_document_read'), previousResult=object(previous?.result)
  return Boolean(previous?.status==='succeeded'&&previous.fingerprint===operationFingerprint(previous.request)&&previousResult.taskSpaceId===e.taskSpaceId&&
    previousResult.sourceUrl===req.previousSourceUrl&&typeof previousResult.documentHtml==='string'&&createHash('sha256').update(previousResult.documentHtml).digest('hex')===req.previousResultHash&&
    req.previousSourceUrl!==output.sourceUrl&&req.previousResultHash!==output.resultHash)
}

/** Success cleanup proof, separate from source verification and Task completion. */
export function verifiedEgoTaskSpaceFinish(repository:TaskRunRepository,task:TaskRun,items:import('../contracts/items.js').TurnItem[],turns:import('../contracts/threads.js').ThreadRecord['turns']):import('../contracts/tasks.js').OperationReceipt|null {
  const operations=repository.operations(task.id),binding=currentEgoTaskSpaceBinding(repository,task.id)
  if(!binding||binding.status!=='succeeded'||binding.fingerprint!==operationFingerprint(binding.request))return null
  const space=object(binding.result)
  if(binding.request?.taskId!==task.id||binding.request.threadId!==task.threadId||typeof binding.request.nonce!=='string'||!binding.request.nonce||space.ownership!=='agent'||space.pageLabel!=='p1'||!Number.isSafeInteger(space.taskSpaceId)||Number(space.taskSpaceId)<1)return null
  for(const receipt of operations.filter(r=>r.kind==='ego_task_space_finish'&&r.status==='succeeded').reverse()) {
    if(receipt.fingerprint!==operationFingerprint(receipt.request)||receipt.request?.bindingReceiptId!==binding.id)continue
    const request=object(receipt.request),output=object(receipt.result),host=repository.operationById(task.id,String(request.hostOperationId),'tool'),saved=object(host?.result),hostItem=object(saved.item),hostRequest=object(host?.request)
    const turn=turns.find(t=>t.id===request.turnId),grant=turn?.executionGrant
    const item=items.find(i=>i.kind==='tool_result'&&i.id===hostItem.id&&i.callId===request.callId&&i.turnId===request.turnId&&i.toolName==='ego_browser_finish')
    if(!grant||grant.taskId!==task.id||grant.threadId!==task.threadId||grant.browserScope?.provider!=='ego-browser'||grant.workspaceRoot!==task.workspaceRoot||
      request.taskId!==task.id||request.grantFingerprint!==operationFingerprint(grant)||request.configurationFingerprint!==grant.connectorIdentityFingerprints?.['ego-browser']||
      binding.request?.configurationFingerprint!==request.configurationFingerprint||request.taskSpaceId!==space.taskSpaceId||request.pageLabel!==space.pageLabel||
      !host||host.status!=='succeeded'||host.fingerprint!==operationFingerprint(host.request)||saved.approved!==true||hostItem.isError===true||
      hostRequest.providerId!=='ego-browser'||hostRequest.toolName!=='ego_browser_finish'||hostRequest.callId!==request.callId||hostRequest.turnId!==request.turnId||
      operationFingerprint(hostRequest.executionGrant)!==operationFingerprint(grant)||!item||item.kind!=='tool_result'||item.isError||
      output.status!=='succeeded'||output.provider!=='ego-browser'||output.action!=='finish'||output.finishResolved!==true||output.finishReceiptId!==receipt.id||
      output.bindingReceiptId!==binding.id||output.taskSpaceId!==space.taskSpaceId||output.pageLabel!==space.pageLabel||output.sessionId!==String(space.taskSpaceId)||output.turnId!==request.turnId||
      output.grantFingerprint!==request.grantFingerprint||output.configurationFingerprint!==request.configurationFingerprint||!grant.allowedProviderIds?.includes('ego-browser')||!grant.allowedToolNames?.includes('ego_browser_finish')||operationFingerprint(output.keep)!==operationFingerprint([])||
      operationFingerprint(hostItem.output)!==operationFingerprint(output)||operationFingerprint(item.output)!==operationFingerprint(output))continue
    const at=Date.parse(receipt.createdAt),finished=Date.parse(receipt.updatedAt)
    if(!Number.isFinite(at)||!Number.isFinite(finished)||finished<at||Date.parse(grant.issuedAt)>at||!grant.expiresAt||Date.parse(grant.expiresAt)<finished)continue
    const index=operations.findIndex(r=>r.id===receipt.id)
    if(operations.slice(index+1).some(r=>['ego_document_read','ego_observation','ego_page_navigation'].includes(r.kind)&&r.status==='succeeded'))continue
    return receipt
  }
  return null
}
