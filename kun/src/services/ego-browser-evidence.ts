import type { ToolCallLike } from '../ports/tool-host.js'
import { createHash } from 'node:crypto'
import type { ExecutionGrant } from '../contracts/permissions.js'
import type { TaskRun } from '../contracts/tasks.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
/** Extra connector seal, in addition to the caller's genuine Host/item/Turn/Grant checks. */
export function validEgoDocumentEvidence(repository: TaskRunRepository, task: TaskRun, output: Record<string, unknown>, grant: ExecutionGrant): boolean {
  let origin:string
  try { const u=new URL(String(output.sourceUrl)); if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return false;origin=u.origin }catch{return false}
  const e = object(output.evidence), binding = repository.operationById(task.id, String(e.bindingReceiptId), 'ego_task_space'), read = repository.operationById(task.id, String(e.readReceiptId), 'ego_document_read')
  if (output.provider !== 'ego-browser' || output.status !== 'succeeded' || output.sourceKind !== 'actual_ego_document' || !['document','element'].includes(String(output.readScope)) ||
    output.truncated !== false || typeof output.html !== 'string' || !output.html.trim() || !binding || !read || binding.status !== 'succeeded' || read.status !== 'succeeded' ||
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
