import { OneOffPublicQueryRecoveryService,type OneOffPrepare } from './one-off-public-query-recovery.js'
import { oneOffChildBinding,verifiedOneOffRecovery } from './one-off-public-query-proof.js'
import type { BrowserPublicQueryRecoveryBinding, BrowserPublicQueryRecoverySnapshot } from '../contracts/browser-public-query-recovery.js'
import type { OperationReceipt, TaskRun } from '../contracts/tasks.js'
import type { BrowserOperationVerificationService } from './browser-operation-verification.js'
import { publicQueryRecoveryForPlan, verifiedPublicQueryRecovery, RECOVERY_TOOLS, RECOVERY_PROVIDERS, type PublicQueryRecoveryContext } from './browser-public-query-recovery-proof.js'
import { verifiedTaskRetryLineage } from './task-retry-lineage.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
function fail(code:string):never { throw Object.assign(new Error(code),{code}) }
export class BrowserPublicQueryRecoveryService {
  constructor(private readonly deps: { repository: TaskRunRepository; verification: BrowserOperationVerificationService; nowIso(): string;
    oneOff?:OneOffPublicQueryRecoveryService; browserIdentity(): string; validatePlan(binding: BrowserPublicQueryRecoveryBinding): Promise<void> }) {}

  async snapshot(taskId: string): Promise<BrowserPublicQueryRecoverySnapshot> {
    const task = this.deps.repository.get(taskId)
    if (!task) fail('not_found')
    if(this.deps.oneOff&&(task.publicQueryRecovery?.mode==='task_reauthorization'||task.authority?.browserScope?.publicQueryAuthorization?.duration==='task'&&!task.acceptance.schedule&&!task.scheduledBy))return this.deps.oneOff.snapshot(task)
    try {
      const context = await this.context(task)
      const binding = task.publicQueryRecovery, saved = binding && verifiedPublicQueryRecovery(this.deps.repository, binding, false)
      const prepared = saved && !saved.use && binding.ownerTaskId === task.id && binding.scopeHash === operationFingerprint(context)
      return { taskId, taskRevision: task.revision, state: prepared ? 'prepared' : 'eligible',
        ...(prepared ? { receiptId: binding.receiptId } : {}), unknownOperationCount: context.unknowns.length, origins:[...context.browserScope.origins],
        message: '旧公开查询结果仍未知，原记录将保留。可准备新的受限检索；准备不会执行网页动作，仍需单独继续。' }
    } catch (error) {
      const reason = String(object(error).code ?? 'browser_public_query_recovery_unavailable')
      return { taskId, taskRevision: task.revision, state: 'unavailable', reason, unknownOperationCount: 0,
        message: reason==='browser_public_query_schedule_scope_required'?'原授权仅用于一次性查询，不能延续到新的执行。旧未知记录已保留，需要重新审阅并确认新的任务范围。':'当前记录尚不满足安全重新检索条件。原未知操作仍保留，请先处理原执行记录中的具体阻断。' }
    }
  }

  async prepare(taskId: string, input: OneOffPrepare) {
    const candidate=this.deps.repository.get(taskId)
    if(this.deps.oneOff&&(input.scopeConfirmation||candidate?.publicQueryRecovery?.mode==='task_reauthorization'||candidate?.authority?.browserScope?.publicQueryAuthorization?.duration==='task'&&!candidate.acceptance.schedule))return this.deps.oneOff.prepare(taskId,input)
    const repository = this.deps.repository, key = `public-query-recovery:${input.idempotencyKey}`
    const previous = repository.operation(taskId, key)
    if (previous) {
      if (operationFingerprint({ expectedRevision: previous.request?.expectedRevision, idempotencyKey: previous.request?.idempotencyKey, confirmed: previous.request?.confirmed }) !== operationFingerprint(input) || previous.status !== 'succeeded') fail('idempotency_conflict')
      const task = repository.get(taskId)!
      return { task, recovery: await this.snapshot(taskId), prepared: true as const, resumed: false as const }
    }
    const task = repository.get(taskId)
    if (!task || task.revision !== input.expectedRevision) fail('stale_request')
    if (input.confirmed !== true) fail('confirmation_required')
    const context = await this.context(task)
    return repository.transact(() => {
      if (repository.get(taskId)?.revision !== input.expectedRevision) fail('stale_request')
      const now = this.deps.nowIso(), request = { ...input, context }
      const receipt = repository.beginOperation({ ownerId: taskId, idempotencyKey: key, kind: 'browser_public_query_recovery', request, nowIso: now }).receipt
      const binding: BrowserPublicQueryRecoveryBinding = { ownerTaskId: taskId, receiptId: receipt.id, scopeHash: operationFingerprint(context),
        sourceTaskId: context.sourceTaskId, browserIdentity: context.browserIdentity,
        ...(context.plan ? { scheduleId: context.plan.scheduleId, versionId: context.plan.versionId, planScopeHash: context.plan.scopeHash } : {}) }
      const updated = repository.update(taskId, task.revision, value => ({ ...value, publicQueryRecovery: binding, updatedAt: now }),
        { key, kind: 'browser_public_query_recovery_prepared', payload: { receiptId: receipt.id, unresolved: true }, createdAt: now })
      repository.finishOperation(taskId, key, { status: 'succeeded', result: { binding, preparedTaskRevision: updated.revision } }, now)
      const recovery: BrowserPublicQueryRecoverySnapshot = { taskId, taskRevision: updated.revision, state: 'prepared', receiptId: receipt.id,
        unknownOperationCount: context.unknowns.length, origins:[...context.browserScope.origins], message: '新的受限公开检索已准备。旧结果仍未知且不会重放；请单独继续。' }
      return { task: updated, recovery, prepared: true as const, resumed: false as const }
    })
  }

  async forRetry(task: TaskRun, receiptId?: string) {
    if(task.publicQueryRecovery?.mode==='task_reauthorization')return this.deps.oneOff?.forRetry(task,receiptId)??fail('browser_public_query_recovery_changed')
    if (!receiptId) {
      if(task.publicQueryRecovery&&verifiedPublicQueryRecovery(this.deps.repository,task.publicQueryRecovery)){
        await this.deps.validatePlan(task.publicQueryRecovery)
        return {binding:task.publicQueryRecovery,context:verifiedPublicQueryRecovery(this.deps.repository,task.publicQueryRecovery)!.context,direct:false}
      }
      const scope = task.authority?.browserScope
      if (!scope?.publicQueryAuthorization || !task.acceptance.schedule) return undefined
      // An exact consumed plan link is future consent, not a global unknown exemption.
      for (const link of this.deps.repository.operations(task.id, 'browser_public_query_recovery_plan').reverse()) {
        const binding = object(link.result).binding as BrowserPublicQueryRecoveryBinding | undefined
        if (!binding || binding.browserIdentity !== this.deps.browserIdentity() || !verifiedPublicQueryRecovery(this.deps.repository, binding)) continue
        const found = publicQueryRecoveryForPlan(this.deps.repository, { sourceTaskId: task.id, scheduleId: binding.scheduleId!, versionId: binding.versionId!, scopeHash: binding.planScopeHash!, browserIdentity: binding.browserIdentity })
        if (!found) continue
        await this.deps.validatePlan(found)
        return { binding: found, context: verifiedPublicQueryRecovery(this.deps.repository, found)!.context, direct: false }
      }
      return undefined
    }
    const binding = task.publicQueryRecovery
    if (!binding || binding.ownerTaskId !== task.id || binding.receiptId !== receiptId) fail('browser_public_query_recovery_changed')
    const proof = verifiedPublicQueryRecovery(this.deps.repository, binding, false)
    if (!proof || proof.use || object(proof.receipt.result).preparedTaskRevision !== task.revision ||
      operationFingerprint(await this.context(task)) !== binding.scopeHash) fail('browser_public_query_recovery_changed')
    return { binding, context: proof.context, direct: true }
  }

  /** A crash after child creation may settle only that queued child, never launch or replay it. */
  recoverPreparedRetry(ownerId:string, control:OperationReceipt, childId:string) {
    const repository=this.deps.repository, source=repository.get(ownerId), child=repository.get(childId)
    if(!source||!child||control.kind!=='retry'||control.status!=='prepared'||control.fingerprint!==operationFingerprint(control.request))return undefined
    const binding=child.publicQueryRecovery, proof=binding&&verifiedPublicQueryRecovery(repository,binding,false)
    const direct=binding&&control.request?.publicQueryRecoveryReceiptId===binding.receiptId&&source.id===binding.ownerTaskId
    const sourceRoot=source.retryOfTaskId?verifiedTaskRetryLineage(repository,source)?.root.id:source.id
    const inherited=binding&&!control.request?.publicQueryRecoveryReceiptId&&sourceRoot===binding.sourceTaskId&&verifiedPublicQueryRecovery(repository,binding)
    if(!binding||!proof||(!direct&&!inherited)||source.status!=='failed'||
      child.retryOfTaskId!==source.id||child.rootTaskId!==(source.rootTaskId??source.id)||child.threadId!==source.threadId||child.workspaceRoot!==source.workspaceRoot||
      child.goal!==source.goal||operationFingerprint(child.acceptance)!==operationFingerprint(source.acceptance)||operationFingerprint(child.scheduledBy)!==operationFingerprint(source.scheduledBy)||
      operationFingerprint(child.publicQueryRecovery)!==operationFingerprint(binding)||!repository.events(child.id).some(e=>e.kind==='task_retried'&&e.payload?.retryOfTaskId===source.id)||
      direct&&!repository.events(source.id).some(e=>e.kind==='public_query_context_abandoned'&&e.payload?.recoveryReceiptId===binding.receiptId))fail('browser_public_query_recovery_changed')
    if(child.activeTurnId||!['queued','waiting_user'].includes(child.status)||repository.operations(child.id).some(r=>binding.mode!=='task_reauthorization'||!oneOffChildBinding(repository,child,binding,proof.context as import('./one-off-public-query-proof.js').OneOffContext)||r.id!==oneOffChildBinding(repository,child,binding,proof.context as import('./one-off-public-query-proof.js').OneOffContext)?.id)||repository.getLease(child.id)||
      repository.listShellSessions(child.id).length)fail('outcome_unknown')
    return repository.transact(()=>{
      const now=this.deps.nowIso()
      const waiting=child.status==='waiting_user'?child:repository.update(child.id,child.revision,value=>({...value,status:'waiting_user',waitingReason:'新的受限检索已准备；启动中断，请单独继续原任务。',updatedAt:now}),
        {key:`recovery-retry-start-interrupted:${control.id}`,kind:'task_waiting_user',payload:{reason:'recovery_retry_start_interrupted'}})
      if(direct)this.consume(source,waiting,binding)
      repository.finishOperation(ownerId,control.idempotencyKey,{status:'succeeded',result:{task:waiting}},now)
      return waiting
    })
  }

  issueOneOffChildScope(task:TaskRun,childId:string,binding:BrowserPublicQueryRecoveryBinding){return this.deps.oneOff?.issueChildScope(task,childId,binding)??fail('browser_public_query_recovery_changed')}
  reviewedBrowserScope(binding:BrowserPublicQueryRecoveryBinding){return binding.mode==='task_reauthorization'?verifiedOneOffRecovery(this.deps.repository,binding,false)?.context.review.scope:verifiedPublicQueryRecovery(this.deps.repository,binding,false)?.context.browserScope}
  revoke(task:TaskRun,input:Parameters<OneOffPublicQueryRecoveryService['revoke']>[1]){return this.deps.oneOff?.revoke(task,input)??fail('browser_public_query_recovery_changed')}

  consume(task: TaskRun, retry: TaskRun, binding: BrowserPublicQueryRecoveryBinding) {
    const repository = this.deps.repository, now = this.deps.nowIso(), key = `public-query-recovery-use:${binding.receiptId}`
    repository.beginOperation({ ownerId: binding.ownerTaskId, idempotencyKey: key, kind: 'browser_public_query_recovery_use',
      request: { recoveryReceiptId: binding.receiptId, scopeHash: binding.scopeHash, retryTaskId: retry.id }, nowIso: now })
    repository.finishOperation(binding.ownerTaskId, key, { status: 'succeeded', result: { unresolved: true, oldContextFenced: true } }, now)
    const attention=repository.attention(`unknown_${binding.ownerTaskId}`)
    if(attention?.status==='pending')repository.putAttention({...attention,status:'answered',revision:attention.revision+1,updatedAt:now,
      title:'旧公开查询上下文已封存',message:'旧操作结果仍未知，原记录已保留；由新的受限检索继续，不会重放旧动作。',
      payload:{...attention.payload,handling:'public_query_context_fenced',recoveryReceiptId:binding.receiptId,retryTaskId:retry.id,unresolved:true}})
    if (binding.scheduleId) {
      const planKey = `public-query-recovery-plan:${binding.receiptId}`
      repository.beginOperation({ ownerId: binding.sourceTaskId, idempotencyKey: planKey, kind: 'browser_public_query_recovery_plan',
        request: { recoveryReceiptId: binding.receiptId, ownerTaskId: task.id, scopeHash: binding.scopeHash }, nowIso: now })
      repository.finishOperation(binding.sourceTaskId, planKey, { status: 'succeeded', result: { binding } }, now)
    }
  }

  private async context(task: TaskRun): Promise<PublicQueryRecoveryContext> {
    const repository = this.deps.repository
    if (!['stalled', 'paused', 'waiting_user'].includes(task.status) || repository.currentExecution(task.id)?.id !== task.id ||
      task.authority?.revokedAt || task.childTaskIds.length || task.acceptance.effect || task.authority?.externalTargets.length ||
      repository.getLease(task.id) && Date.parse(repository.getLease(task.id)!.expiresAt) > Date.parse(this.deps.nowIso()) ||
      repository.listShellSessions(task.id).some(s => ['starting', 'running', 'outcome_unknown', 'interrupted'].includes(s.status))) fail('browser_public_query_recovery_ineligible')
    const unsettled = repository.unsettledOperations(task.id)
    const tools = unsettled.filter(r => r.kind === 'tool')
    if (!tools.length || tools.length > 8 || unsettled.some(r => r.status !== 'outcome_unknown' || !['tool', 'browser_action_dispatch'].includes(r.kind))) fail('browser_public_query_recovery_ineligible')
    const proofs = await Promise.all(tools.map(async receipt => {
      const review = repository.operations(task.id, 'browser_action_review').some(r => r.status === 'failed' && r.error === 'not_found' &&
        r.fingerprint === operationFingerprint(r.request) && r.request?.originalReceiptId === receipt.id && r.request.originalFingerprint === receipt.fingerprint)
      if (!review) fail('browser_public_query_review_required')
      return this.deps.verification.publicQueryRecoveryProof(task.id, receipt.id, task.revision)
    }))
    const first = proofs[0]!, sourceId = first.scoped.authority.source.id, original = first.original
    if (original.connectorIdentityFingerprints?.['browser-skill'] !== this.deps.browserIdentity()) fail('browser_binding_changed')
    if(!original.browserScheduleBinding||first.scoped.authority.authorization.duration!=='schedule')fail('browser_public_query_schedule_scope_required')
    if(!original.allowedProviderIds?.includes('browser-skill')||!original.allowedToolNames?.includes('browser_observe'))fail('browser_public_query_recovery_ineligible')
    const allowed = new Set(proofs.flatMap(p => [p.receipt.id, p.dispatch.id]))
    if (unsettled.some(r => !allowed.has(r.id)) || proofs.some(p => p.scoped.authority.source.id !== sourceId || operationFingerprint(p.original.browserScope) !== operationFingerprint(original.browserScope) ||
      operationFingerprint(p.original.browserScheduleBinding) !== operationFingerprint(original.browserScheduleBinding))) fail('browser_public_query_recovery_ineligible')
    // Any remote/host capability in this attempt prevents a read-only restart exception.
    for (const receipt of repository.operations(task.id, 'tool')) {
      if (!RECOVERY_PROVIDERS.includes(String(receipt.request?.providerId)) || !RECOVERY_TOOLS.includes(String(receipt.request?.toolName))) fail('browser_public_query_recovery_external_effect')
    }
    const locks = repository.operations(sourceId, 'browser_schedule_action_outcome').filter(r => r.status === 'outcome_unknown' && !repository.verifiedOperationResolution(r) &&
      r.request?.taskId === task.id && r.request.turnId === original.turnId)
    for (const lock of locks) if (lock.fingerprint !== operationFingerprint(lock.request) || !original.browserScheduleBinding ||
      ['scheduleId', 'versionId', 'scopeHash', 'sourceTaskId', 'actionsHash'].some(k => lock.request?.[k] !== (original.browserScheduleBinding as unknown as Record<string, unknown>)[k]) ||
      !proofs.some(p => p.action.action === lock.request?.action)) fail('browser_public_query_recovery_ineligible')
    const refs = [...unsettled, ...locks].map(r => ({ ownerId: r.ownerId, id: r.id, kind: r.kind, fingerprint: r.fingerprint })).sort((a, b) => a.id.localeCompare(b.id))
    return { taskId: task.id, threadId: task.threadId, sourceTaskId: sourceId, goalHash: operationFingerprint(task.goal), acceptanceHash: operationFingerprint(task.acceptance),
      authorityHash: operationFingerprint(task.authority), sourceAcceptanceHash: operationFingerprint(first.scoped.authority.source.acceptance), browserScope: original.browserScope!, browserIdentity: this.deps.browserIdentity(), unknowns: refs,
      sessionIds: [...new Set(proofs.map(p => p.sessionId))], grantIds: [...new Set(proofs.map(p => p.original.id))],
      allowedToolNames: original.allowedToolNames!.filter(name => RECOVERY_TOOLS.includes(name)),allowedProviderIds:original.allowedProviderIds??[], ...(original.browserPublicQueryRecovery?{previousRecovery:original.browserPublicQueryRecovery}:{}), ...(original.browserScheduleBinding ? { plan: original.browserScheduleBinding } : {}) }
  }
}
