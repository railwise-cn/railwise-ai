import { verifiedOneOffRecovery,oneOffExecutionScope,assertOneOffGrant } from './one-off-public-query-proof.js'
import { assertGrantAllowsNetwork } from '../adapters/tool/sandbox-policy.js'
import { verifiedTaskPublicQueryAction } from './browser-public-query-authority.js'
import { verifiedTaskRetryLineage } from './task-retry-lineage.js'
import type { BrowserExecutionScope } from '../contracts/browser-skill.js'
import type { BrowserPublicQueryRecoveryBinding } from '../contracts/browser-public-query-recovery.js'
import { ExecutionGrantSchema, type ExecutionGrant, type ExecutionScope } from '../contracts/permissions.js'
import type { OperationReceipt, TaskRun } from '../contracts/tasks.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
export const RECOVERY_PROVIDERS = ['browser-skill', 'managed-artifacts', 'document-delivery', 'todo', 'task-schedule']
export const RECOVERY_TOOLS = ['browser_session_start', 'browser_session_stop', 'browser_observe', 'browser_navigate', 'browser_get_html', 'browser_read', 'browser_extract', 'browser_screenshot', 'browser_click', 'browser_fill', 'publish_artifact', 'read_artifact', 'verify_web_artifact', 'read_task_context', 'todo_list', 'todo_write', 'schedule_task', 'list_schedules']
export type PublicQueryRecoveryContext = {
  taskId: string; threadId: string; sourceTaskId: string; goalHash: string; acceptanceHash: string; authorityHash: string; sourceAcceptanceHash: string;
  browserScope: BrowserExecutionScope; browserIdentity: string;
  unknowns: { ownerId: string; id: string; kind: string; fingerprint: string }[];
  sessionIds: string[]; grantIds: string[]; allowedToolNames: string[]; allowedProviderIds:string[];
  previousRecovery?:BrowserPublicQueryRecoveryBinding;
  plan?: { scheduleId: string; versionId: string; scopeHash: string; sourceTaskId: string; actionsHash: string }
}

/** A future-consent record never changes OperationReceipt.status/resolution. */
export function verifiedPublicQueryRecovery(repository: TaskRunRepository, binding: BrowserPublicQueryRecoveryBinding, consumed = true) {
  if(binding.mode==='task_reauthorization')return verifiedOneOffRecovery(repository,binding,consumed)
  const receipt = repository.operationById(binding.ownerTaskId, binding.receiptId, 'browser_public_query_recovery')
  const request = object(receipt?.request), result = object(receipt?.result), context = request.context as PublicQueryRecoveryContext | undefined
  const owner = repository.get(binding.ownerTaskId)
  if (!receipt || receipt.status !== 'succeeded' || receipt.fingerprint !== operationFingerprint(request) || request.confirmed !== true ||
    !context || context.taskId !== binding.ownerTaskId || !owner || context.threadId !== owner.threadId ||
    context.goalHash !== operationFingerprint(owner.goal) || context.acceptanceHash !== operationFingerprint(owner.acceptance) ||
    context.authorityHash !== operationFingerprint(owner.authority) || context.sourceTaskId !== binding.sourceTaskId ||
    context.browserIdentity !== binding.browserIdentity || binding.scopeHash !== operationFingerprint(context) ||
    operationFingerprint(result.binding) !== operationFingerprint(binding) || result.preparedTaskRevision !== Number(request.expectedRevision) + 1 ||
    !Array.isArray(context.allowedToolNames)||!context.allowedToolNames.length||!Array.isArray(context.allowedProviderIds)||!context.allowedProviderIds.includes('browser-skill')||
    !Array.isArray(context.unknowns) || !context.unknowns.length || context.unknowns.length > 64 ||
    operationFingerprint(context.browserScope) !== operationFingerprint(owner.authority?.browserScope) || owner.authority?.revokedAt ||
    (binding.scheduleId !== context.plan?.scheduleId || binding.versionId !== context.plan?.versionId || binding.planScopeHash !== context.plan?.scopeHash)) return undefined
  const refs: OperationReceipt[] = []
  for (const ref of context.unknowns) {
    if (typeof ref.ownerId !== 'string' || typeof ref.id !== 'string' || typeof ref.kind !== 'string') return undefined
    const row = repository.operationById(ref.ownerId, ref.id)
    if (!row || row.kind !== ref.kind || row.fingerprint !== ref.fingerprint || row.status !== 'outcome_unknown') return undefined
    refs.push(row)
  }
  const hosts=refs.filter(r=>r.kind==='tool')
  if(!hosts.length||hosts.some(host=>{
    const dispatches=refs.filter(r=>r.kind==='browser_action_dispatch'&&r.ownerId===host.ownerId&&r.request?.turnId===host.request?.turnId&&r.request?.toolName===host.request?.toolName&&r.request?.argumentsHash===host.request?.argumentsHash)
    if(dispatches.length!==1)return true
    const dispatch=dispatches[0]!, scoped=verifiedTaskPublicQueryAction(repository,host,dispatch,true)
    const item=object(object(host.result).item),output=object(item.output),parsed=ExecutionGrantSchema.safeParse(host.request?.executionGrant)
    if(!parsed.success)return true
    const grant=parsed.data
    if(context.allowedToolNames.some(name=>!RECOVERY_TOOLS.includes(name)||!grant.allowedToolNames?.includes(name))||
      context.allowedProviderIds.some(id=>!grant.allowedProviderIds?.includes(id))||
      operationFingerprint(context.previousRecovery)!==operationFingerprint(grant.browserPublicQueryRecovery)||!scoped||object(host.result).approved!==true||item.toolName!==host.request?.toolName||host.request?.providerId!=='browser-skill'||!['browser_click','browser_fill'].includes(String(host.request.toolName))||
      item.kind!=='tool_result'||item.status!=='completed'||item.isError!==true||item.callId!==host.request.callId||item.turnId!==host.request.turnId||item.threadId!==owner.threadId||
      output.status!=='outcome_unknown'||output.provider!=='browser-skill'||!context.sessionIds.includes(String(dispatch.request?.sessionId))||!context.grantIds.includes(String(grant.id))||
      !['search_input','search_trigger','pagination','filter_control','sort_control','result_link'].includes(String(scoped.request.rule)))return true
    const derivedRequest={...scoped.request,actionId:scoped.result.id,scopeActionReceiptId:scoped.receipt.id}
    const derived=repository.operation(owner.id,`browser-derived-scope-action:${operationFingerprint(derivedRequest)}`)
    return derived?.kind!=='browser_derived_action_authorization'||derived.status!=='succeeded'||derived.fingerprint!==operationFingerprint(derivedRequest)||
      operationFingerprint(derived.result)!==operationFingerprint({...scoped.result,scopeActionReceiptId:scoped.receipt.id})
  }))return undefined
  if(refs.some(row=>{
    if(row.kind==='tool')return row.ownerId!==owner.id
    if(row.kind==='browser_action_dispatch')return row.ownerId!==owner.id||!hosts.some(h=>row.request?.argumentsHash===h.request?.argumentsHash&&row.request?.turnId===h.request?.turnId&&row.request?.toolName===h.request?.toolName)
    return row.kind!=='browser_schedule_action_outcome'||row.ownerId!==binding.sourceTaskId||row.request?.taskId!==owner.id||
      !context.plan||['scheduleId','versionId','scopeHash','sourceTaskId','actionsHash'].some(k=>row.request?.[k]!==object(context.plan)[k])||
      !hosts.some(h=>h.request?.turnId===row.request?.turnId&&h.request?.toolName===`browser_${row.request?.action}`)
  }))return undefined
  const ownUnknowns=repository.unsettledOperations(owner.id)
  if(ownUnknowns.some(r=>!refs.some(ref=>ref.ownerId===r.ownerId&&ref.id===r.id))||ownUnknowns.length!==refs.filter(r=>r.ownerId===owner.id).length)return undefined
  const use = repository.operations(binding.ownerTaskId, 'browser_public_query_recovery_use').find(r => r.status === 'succeeded' &&
    r.fingerprint === operationFingerprint(r.request) && r.request?.recoveryReceiptId === binding.receiptId && r.request?.scopeHash === binding.scopeHash)
  if (consumed) {
    const childId = use?.request?.retryTaskId, child = typeof childId === 'string' ? repository.get(childId) : undefined
    const control = child && repository.operations(binding.ownerTaskId, 'retry').find(r => r.status === 'succeeded' && r.fingerprint === operationFingerprint(r.request) &&
      object(object(r.result).task).id === child.id && r.request?.publicQueryRecoveryReceiptId === binding.receiptId)
    if (!child || child.retryOfTaskId !== owner.id || operationFingerprint(child.publicQueryRecovery) !== operationFingerprint(binding) ||
      !control || !repository.events(child.id).some(e => e.kind === 'task_retried' && e.payload?.retryOfTaskId === owner.id)) return undefined
  }
  return { receipt, context, owner, use }
}

/** Scope-specific retirement for a NEW execution only; not an outcome verification. */
export function recoveryCoversReceipt(repository: TaskRunRepository, receipt: OperationReceipt, binding?: BrowserPublicQueryRecoveryBinding): boolean {
  // Settled and unrelated history needs no exception. Do not repeatedly prove a
  // recovery chain for every successful source read during each Grant check.
  if(!binding||receipt.status!=='outcome_unknown'||!['tool','browser_action_dispatch','browser_schedule_action_outcome'].includes(receipt.kind)||repository.verifiedOperationResolution(receipt))return false
  const seen=new Set<string>();let current:BrowserPublicQueryRecoveryBinding|undefined=binding
  while(current&&!seen.has(current.receiptId)&&seen.size<32){
    seen.add(current.receiptId);const proof=verifiedPublicQueryRecovery(repository,current)
    if(!proof)return false
    if(proof.context.unknowns.some(ref=>ref.ownerId===receipt.ownerId&&ref.id===receipt.id&&ref.kind===receipt.kind&&ref.fingerprint===receipt.fingerprint))return true
    const previous=proof.context.previousRecovery
    if(current.mode!=='task_reauthorization'&&previous&&(previous.sourceTaskId!==current.sourceTaskId||previous.scheduleId!==current.scheduleId||previous.versionId!==current.versionId||previous.planScopeHash!==current.planScopeHash||previous.browserIdentity!==current.browserIdentity))return false
    current=previous
  }
  return false
}

/** A consumed, sealed plan link can be inherited by future NEW Grants, never the old Turn. */
export function publicQueryRecoveryForPlan(repository: TaskRunRepository, input: { sourceTaskId: string; scheduleId: string; versionId: string; scopeHash: string; browserIdentity: string }) {
  for (const link of repository.operations(input.sourceTaskId, 'browser_public_query_recovery_plan').reverse()) {
    const binding = object(link.result).binding as BrowserPublicQueryRecoveryBinding | undefined
    if (link.status !== 'succeeded' || link.fingerprint !== operationFingerprint(link.request) || !binding ||
      link.request?.recoveryReceiptId!==binding.receiptId||link.request?.ownerTaskId!==binding.ownerTaskId||link.request?.scopeHash!==binding.scopeHash||
      binding.sourceTaskId !== input.sourceTaskId || binding.scheduleId !== input.scheduleId || binding.versionId !== input.versionId ||
      binding.planScopeHash !== input.scopeHash || binding.browserIdentity !== input.browserIdentity || !verifiedPublicQueryRecovery(repository, binding)) continue
    return binding
  }
  return undefined
}

export function recoveryExecutionScope(repository: TaskRunRepository, task: TaskRun, scope: ExecutionScope, now=Date.now()): ExecutionScope {
  const binding = task.publicQueryRecovery ?? scope.browserPublicQueryRecovery
  if (!binding) return scope
  if(binding.mode==='task_reauthorization')return oneOffExecutionScope(repository,task,scope,now)
  const proof = verifiedPublicQueryRecovery(repository, binding)
  if (!proof || task.id === binding.ownerTaskId || operationFingerprint(task.goal) !== proof.context.goalHash ||
    ![proof.context.acceptanceHash, proof.context.sourceAcceptanceHash].includes(operationFingerprint(task.acceptance)) || !recoveryConsumer(repository, task, binding, proof.use, scope, proof.context.plan) || operationFingerprint(scope.browserScope) !== operationFingerprint(proof.context.browserScope) ||
    scope.connectorIdentityFingerprints?.['browser-skill'] !== binding.browserIdentity) throw Object.assign(new Error('公开查询恢复范围已变化。'), { code: 'browser_public_query_recovery_changed' })
  const allowedToolNames = RECOVERY_TOOLS.filter(name => proof.context.allowedToolNames.includes(name) && (!scope.allowedToolNames || scope.allowedToolNames.includes(name)))
  const expiresAt=Math.min(now+15*60_000,scope.expiresAt?Date.parse(scope.expiresAt):Infinity)
  if(!Number.isFinite(expiresAt))throw Object.assign(new Error('公开查询恢复有效期无效。'),{code:'execution_grant_expired'})
  const networkAllowlist=proof.context.browserScope.origins.filter(origin=>{try{assertGrantAllowsNetwork(origin,{executionGrant:{networkAllowlist:scope.networkAllowlist} as ExecutionGrant});return true}catch{return false}})
  return { ...scope, browserPublicQueryRecovery: binding, allowedToolNames,
    allowedProviderIds: RECOVERY_PROVIDERS.filter(id => proof.context.allowedProviderIds.includes(id)&&(!scope.allowedProviderIds || scope.allowedProviderIds.includes(id))),
    externalTargets: [], networkAllowlist,
    expiresAt: new Date(expiresAt).toISOString() }
}

export function assertRecoveryGrant(repository: TaskRunRepository, grant: ExecutionGrant): void {
  if (!grant.browserPublicQueryRecovery) return
  if(grant.browserPublicQueryRecovery.mode==='task_reauthorization')return assertOneOffGrant(repository,grant)
  const task = grant.taskId ? repository.get(grant.taskId) : null, binding = grant.browserPublicQueryRecovery
  const proof = verifiedPublicQueryRecovery(repository, binding)
  if (!task || !proof || task.id === binding.ownerTaskId || !recoveryConsumer(repository, task, binding, proof.use, grant, proof.context.plan) || operationFingerprint(grant.browserScope) !== operationFingerprint(proof.context.browserScope) ||
    grant.connectorIdentityFingerprints?.['browser-skill'] !== binding.browserIdentity ||
    grant.externalTargets.length || !Array.isArray(grant.allowedToolNames)||grant.allowedToolNames.some(name => !RECOVERY_TOOLS.includes(name)||!proof.context.allowedToolNames.includes(name)) ||
    !grant.allowedProviderIds || grant.allowedProviderIds.some(id => !RECOVERY_PROVIDERS.includes(id)||!proof.context.allowedProviderIds.includes(id)) ||
    !grant.expiresAt || Date.parse(grant.expiresAt) > Date.parse(grant.issuedAt) + 15 * 60_000 + 1000) throw Object.assign(new Error('公开查询恢复凭据不属于当前受限执行。'), { code: 'browser_public_query_recovery_changed' })
}

function recoveryConsumer(repository: TaskRunRepository, task: TaskRun, binding: BrowserPublicQueryRecoveryBinding, use: OperationReceipt | undefined,
  scope: ExecutionScope, plan: PublicQueryRecoveryContext['plan']) {
  if (use?.request?.retryTaskId === task.id) return true
  if (task.retryOfTaskId) {
    const lineage = verifiedTaskRetryLineage(repository, task)
    return Boolean(lineage && ([binding.ownerTaskId, binding.sourceTaskId].includes(lineage.root.id) ||
      operationFingerprint(lineage.root.publicQueryRecovery) === operationFingerprint(binding) &&
      operationFingerprint(scope.browserScheduleBinding) === operationFingerprint(plan) && scope.scheduleScopeHash === binding.planScopeHash &&
      scheduledRecoveryConsumer(repository, lineage.root, binding)))
  }
  return scheduledRecoveryConsumer(repository, task, binding)
}

/** A later occurrence keeps the server's sealed plan context through a proven Retry family. */
function scheduledRecoveryConsumer(repository: TaskRunRepository, task: TaskRun, binding: BrowserPublicQueryRecoveryBinding) {
  const prepared = repository.operation(task.threadId, 'scheduled-task-context')
  return Boolean(task.scheduledBy && task.scheduledBy.scheduleId === binding.scheduleId && prepared?.kind === 'scheduled_task_prepare' &&
    prepared.status === 'succeeded' && prepared.fingerprint === operationFingerprint(prepared.request) && prepared.request?.scheduleId === binding.scheduleId &&
    prepared.request?.versionId === binding.versionId && prepared.request?.dueAt === task.scheduledBy.dueAt)
}
