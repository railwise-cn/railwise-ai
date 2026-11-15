import type { BrowserOperationVerificationService } from './browser-operation-verification.js';
import { operationFingerprint as fp,type TaskRunRepository } from './task-run-repository.js';
import type { ExecutionGrant } from '../contracts/permissions.js';
import { ONE_OFF_TOOLS,ONE_OFF_PROVIDERS,OneOffScopeConfirmationSchema,type OneOffScopeConfirmation,type OneOffScopeReview,type BrowserPublicQueryRecoveryBinding,type BrowserPublicQueryRecoverySnapshot } from '../contracts/browser-public-query-recovery.js';
import type { TaskRun } from '../contracts/tasks.js';
import { verifiedTaskRetryLineage } from './task-retry-lineage.js';
import { activeOneOffConsent,oneOffChildBinding,oneOffConsumer,verifiedOneOffRecovery,type OneOffContext } from './one-off-public-query-proof.js';
function fail(code: string): never { throw Object.assign(new Error(code),{ code }); }
const obj=(v: unknown): Record<string,unknown> => v
  &&typeof v==='object'
  &&!Array.isArray(v)? v as Record<string,unknown>:{};
/** Count immutable unresolved records, including already fenced ancestors. */
function unknownOperationCount(repo: TaskRunRepository,context: OneOffContext): number {
  const refs=new Set(context.unknowns.map(ref => fp(ref)));
  let binding=context.previousRecovery;
  // This verification recursively checks the entire bounded historical chain.
  if (binding
    &&!verifiedOneOffRecovery(repo,binding))
    fail('browser_public_query_recovery_changed');
  while (binding) {
    const previous=repo.operationById(binding.ownerTaskId,binding.receiptId,'browser_public_query_recovery')?.request?.context as OneOffContext;
    for (const ref of previous.unknowns)
      refs.add(fp(ref));
    binding=previous.previousRecovery;
  }
  return refs.size;
}
export type OneOffPrepare={
  expectedRevision: number;
  idempotencyKey: string;
  confirmed?: boolean;
  scopeConfirmation?: OneOffScopeConfirmation;
};
export class OneOffPublicQueryRecoveryService {
  constructor(private readonly deps: {
    repository: TaskRunRepository;
    verification: BrowserOperationVerificationService;
    nowIso(): string;
    review(task: TaskRun,ceiling: ExecutionGrant): Promise<OneOffScopeReview>;
  }) { }
  async context(task: TaskRun): Promise<OneOffContext> {
    const repo=this.deps.repository;
    if (task.parentTaskId
      ||task.authority?.source==='inherited'
      ||task.scheduledBy
      ||task.acceptance.schedule
      ||task.flowId
      ||task.flowRunId
      ||task.acceptance.effect
      ||task.authority?.revokedAt
      ||task.authority?.externalTargets.length
      ||![
        'stalled',
        'paused',
        'waiting_user',
        'failed'
      ].includes(task.status)
      ||repo.currentExecution(task.id)?.id!==task.id
      ||task.childTaskIds.length
      ||repo.execution.latestAttempt(task.id)?.status==='running'
      ||repo.getLease(task.id)
      &&Date.parse(repo.getLease(task.id)!.expiresAt)>Date.parse(this.deps.nowIso())
      ||repo.listShellSessions(task.id).some(s => [
        'starting',
        'running',
        'outcome_unknown',
        'interrupted'
      ].includes(s.status)))
      fail('browser_public_query_recovery_ineligible');
    const unresolved=repo.unsettledOperations(task.id),hosts=unresolved.filter(r => r.kind==='tool');
    if (unresolved.some(r => r.status!=='outcome_unknown'
      ||!['tool','browser_action_dispatch'].includes(r.kind))
      ||hosts.length>8)
      fail('browser_public_query_recovery_ineligible');
    const pending=task.publicQueryRecovery?.mode==='task_reauthorization'? verifiedOneOffRecovery(repo,task.publicQueryRecovery,false):undefined;
    const previousBinding=pending?.owner.id===task.id
      &&!pending.use? pending.context.previousRecovery:task.publicQueryRecovery;
    const previousProof=previousBinding
      &&verifiedOneOffRecovery(repo,previousBinding);
    const previous=previousProof?.use?.request?.retryTaskId===task.id
      &&oneOffChildBinding(repo,task,previousBinding!,previousProof.context)? previousProof:undefined;
    if (!hosts.length
      &&!previous)
      fail('browser_public_query_recovery_ineligible');
    const proofs=[];
    for (const host of hosts) {
      if (!repo.operations(task.id,'browser_action_review').some(r => r.status==='failed'
        &&r.error==='not_found'
        &&r.fingerprint===fp(r.request)
        &&r.request?.originalReceiptId===host.id
        &&r.request.originalFingerprint===host.fingerprint))
        fail('browser_public_query_review_required');
      const proof=await this.deps.verification.oneOffRecoveryProvenance(task.id,host.id,task.revision);
      if (proof.original.browserScheduleBinding
        ||proof.scoped.authority.authorization.duration!=='task')
        fail('browser_public_query_schedule_scope_required');
      proofs.push(proof);
    }
    const original=proofs[0]?.original??previous?.context.ceiling;
    if (!original)
      fail('execution_grant_scope');
    const allowed=new Set(proofs.flatMap(p => [p.receipt.id,p.dispatch.id]));
    if (unresolved.some(r => !allowed.has(r.id)))
      fail('browser_public_query_recovery_ineligible');
    const review=await this.deps.review(task,original);
    for (const r of repo.operations(task.id,'tool'))
      if (!ONE_OFF_PROVIDERS.includes(String(r.request?.providerId))
        ||!ONE_OFF_TOOLS.includes(String(r.request?.toolName)))
        fail('browser_public_query_recovery_external_effect');
    const lineage=task.retryOfTaskId? verifiedTaskRetryLineage(repo,task):{ root: task };
    if (!lineage)
      fail('browser_public_query_recovery_ineligible');
    return {
      mode: 'task_reauthorization',
      ceiling: original,
      review,
      taskPermissionRequired: Boolean(original.taskPermissionId
        ||previous?.context.taskPermissionRequired),
      taskId: task.id,
      threadId: task.threadId,
      sourceTaskId: lineage.root.id,
      goalHash: fp(task.goal),
      acceptanceHash: fp(task.acceptance),
      sourceAcceptanceHash: fp(lineage.root.acceptance),
      authorityHash: fp(task.authority),
      browserScope: task.authority!.browserScope!,
      browserIdentity: review.browserIdentity,
      unknowns: unresolved.map(r => ({
        ownerId: r.ownerId,
        id: r.id,
        kind: r.kind,
        fingerprint: r.fingerprint
      })).sort((a,b) => a.id.localeCompare(b.id)),
      sessionIds: proofs.map(p => p.sessionId),
      grantIds: proofs.map(p => p.original.id),
      allowedToolNames: review.allowedToolNames,
      allowedProviderIds: review.allowedProviderIds,
      ...(previous? { previousRecovery: previousBinding }:{})
    };
  }
  async validateCurrent(task: TaskRun) {
    const proof=oneOffConsumer(this.deps.repository,task);
    if (!proof)
      fail('browser_public_query_recovery_changed');
    activeOneOffConsent(this.deps.repository,task.publicQueryRecovery!,Date.parse(this.deps.nowIso()));
    if (fp(await this.deps.review(task,proof.context.ceiling))!==fp(proof.context.review))
      fail('browser_public_query_fresh_scope_required');
  }
  async snapshot(task: TaskRun): Promise<BrowserPublicQueryRecoverySnapshot> {
    try {
      const context=await this.context(task),binding=task.publicQueryRecovery,proof=binding
        &&verifiedOneOffRecovery(this.deps.repository,binding,false);
      const consent=binding?.consentReceiptId
        &&this.deps.repository.operationById(binding.ownerTaskId,binding.consentReceiptId,'browser_public_query_scope_consent');
      const consentExpiresAt=typeof obj(consent
        &&consent.result).expiresAt==='string'? String(obj(consent
          &&consent.result).expiresAt):undefined;
      const revoked=Boolean(binding
        &&this.deps.repository.operations(binding.ownerTaskId,'browser_public_query_scope_revoke').some(r => r.status==='succeeded'
          &&r.fingerprint===fp(r.request)
          &&r.request?.consentReceiptId===binding.consentReceiptId
          &&r.request?.confirmed===true));
      if (proof?.use?.request?.retryTaskId===task.id
        &&!context.unknowns.length
        &&fp(context.review)===fp(proof.context.review)) {
        try {
          activeOneOffConsent(this.deps.repository,binding!,Date.parse(this.deps.nowIso()));
          return {
            taskId: task.id,
            taskRevision: task.revision,
            state: 'unavailable',
            mode: 'task_reauthorization',
            reason: 'browser_public_query_current_scope_active',
            consentReceiptId: binding!.consentReceiptId,
            consentExpiresAt,
            unknownOperationCount: 0,
            message: '本次范围仍有效，可继续当前任务或撤销本次范围。'
          };
        }
        catch { /* Expired/revoked permission must be reviewed again. */ }
      }
      let active=false,expiresAt: string|undefined;
      if (proof
        &&!proof.use
        &&fp(proof.context)===fp(context))
        try {
          expiresAt=activeOneOffConsent(this.deps.repository,binding!,Date.parse(this.deps.nowIso())).expiresAt;
          active=true;
        }
        catch { /* A new explicit review is required. */ }
      return {
        taskId: task.id,
        taskRevision: task.revision,
        mode: 'task_reauthorization',
        state: active? 'prepared':'needs_scope_review',
        ...(active? { receiptId: binding!.receiptId }:{}),
        ...(proof? {
          consentReceiptId: binding!.consentReceiptId,
          consentExpiresAt: expiresAt??consentExpiresAt,
          consentRevoked: revoked
        }:{}),
        scopeReview: context.review,
        origins: context.review.scope.origins,
        unknownOperationCount: unknownOperationCount(this.deps.repository,context),
        message: '请重新审阅本次公开查询范围；旧操作结果仍未知，准备不会运行网页。'
      };
    }
    catch (e) {
      return {
        taskId: task.id,
        taskRevision: task.revision,
        state: 'unavailable',
        reason: String(obj(e).code??obj(e).message??'browser_public_query_recovery_ineligible'),
        unknownOperationCount: 0,
        message: '当前记录尚不能安全准备新的查询范围。'
      };
    }
  }
  async prepare(taskId: string,input: OneOffPrepare): Promise<{
    task: TaskRun;
    recovery: BrowserPublicQueryRecoverySnapshot;
    prepared: true;
    resumed: false;
  }> {
    const repo=this.deps.repository,key=`public-query-recovery:${input.idempotencyKey}`,prior=repo.operation(taskId,key);
    if (prior) {
      if (prior.status!=='succeeded'
        ||fp({
          expectedRevision: prior.request?.expectedRevision,
          idempotencyKey: prior.request?.idempotencyKey,
          confirmed: prior.request?.confirmed,
          scopeConfirmation: prior.request?.scopeConfirmation
        })!==fp(input))
        fail('idempotency_conflict');
      return {
        task: repo.get(taskId)!,
        recovery: await this.snapshot(repo.get(taskId)!),
        prepared: true as const,
        resumed: false as const
      };
    }
    const task=repo.get(taskId);
    if (!task
      ||task.revision!==input.expectedRevision)
      fail('stale_request');
    const parsed=OneOffScopeConfirmationSchema.safeParse(input.scopeConfirmation);
    if (!parsed.success)
      fail('confirmation_required');
    const confirmation=parsed.data,context=await this.context(task);
    if (input.confirmed!==true
      ||confirmation.reviewHash!==context.review.reviewHash
      ||confirmation.expectedBrowserRevision!==context.review.scope.revision
      ||confirmation.browserInstanceId!==context.review.scope.browserInstanceId
      ||fp(confirmation.origins)!==fp(context.review.scope.origins))
      fail('browser_binding_changed');
    const committed=repo.transact(() => {
      // Another process may commit the same key while context() awaits. Replay
      // before checking the old revision or creating another audit record.
      if (repo.operation(taskId,key))
        return { replayed: true as const };
      if (repo.get(taskId)?.revision!==input.expectedRevision)
        fail('stale_request');
      const now=this.deps.nowIso(),receipt=repo.beginOperation({
        ownerId: taskId,
        idempotencyKey: key,
        kind: 'browser_public_query_recovery',
        request: { ...input,context },
        nowIso: now
      }).receipt;
      const consent=repo.beginOperation({
        ownerId: taskId,
        idempotencyKey: `one-off-consent:${input.idempotencyKey}`,
        kind: 'browser_public_query_scope_consent',
        request: {
          recoveryReceiptId: receipt.id,
          reviewHash: context.review.reviewHash,
          confirmed: true,
          scopeConfirmation: confirmation
        },
        nowIso: now
      }).receipt;
      repo.finishOperation(taskId,consent.idempotencyKey,{
        status: 'succeeded',result: {
          review: context.review,
          confirmedAt: now,
          expiresAt: new Date(Date.parse(now)+confirmation.ttlSeconds*1000).toISOString()
        }
      },now);
      const binding: BrowserPublicQueryRecoveryBinding={
        mode: 'task_reauthorization',
        ownerTaskId: taskId,
        receiptId: receipt.id,
        consentReceiptId: consent.id,
        sourceTaskId: context.sourceTaskId,
        scopeHash: fp(context),
        browserIdentity: context.review.browserIdentity
      };
      const updated=repo.update(taskId,task.revision,t => ({ ...t,publicQueryRecovery: binding }),{
        key,
        kind: 'browser_public_query_recovery_prepared',
        payload: { receiptId: receipt.id,unresolved: true },
        createdAt: now
      });
      repo.finishOperation(taskId,key,{ status: 'succeeded',result: { binding,preparedTaskRevision: updated.revision } },now);
      return {
        replayed: false as const,result: {
          task: updated,
          recovery: {
            taskId,
            taskRevision: updated.revision,
            mode: 'task_reauthorization' as const,
            state: 'prepared' as const,
            receiptId: binding.receiptId,
            consentReceiptId: consent.id,
            consentExpiresAt: new Date(Date.parse(now)+confirmation.ttlSeconds*1000).toISOString(),
            scopeReview: context.review,
            origins: context.review.scope.origins,
            unknownOperationCount: unknownOperationCount(this.deps.repository,context),
            message: '新的范围已准备；请单独继续。'
          },
          prepared: true as const,
          resumed: false as const
        }
      };
    });
    // The normal replay path checks exact input identity; snapshot work remains
    // outside the transaction and never extends the original consent expiry.
    return committed.replayed? this.prepare(taskId,input):committed.result;
  }
  async forRetry(task: TaskRun,receiptId?: string) {
    const binding=task.publicQueryRecovery;
    if (!receiptId
      ||binding?.mode!=='task_reauthorization'
      ||binding.ownerTaskId!==task.id
      ||binding.receiptId!==receiptId)
      fail('browser_public_query_fresh_scope_required');
    const proof=verifiedOneOffRecovery(this.deps.repository,binding,false);
    if (!proof
      ||proof.use
      ||obj(proof.receipt.result).preparedTaskRevision!==task.revision
      ||fp(await this.context(task))!==binding.scopeHash)
      fail('browser_public_query_recovery_changed');
    activeOneOffConsent(this.deps.repository,binding,Date.parse(this.deps.nowIso()));
    return {
      binding,
      context: proof.context,
      direct: true as const
    };
  }
  issueChildScope(task: TaskRun,childId: string,binding: BrowserPublicQueryRecoveryBinding) {
    const repo=this.deps.repository,proof=verifiedOneOffRecovery(repo,binding,false);
    if (!proof
      ||proof.owner.id!==task.id
      ||proof.use)
      fail('browser_public_query_recovery_changed');
    activeOneOffConsent(repo,binding,Date.parse(this.deps.nowIso()));
    const review=proof.context.review,request={
      confirmed: true,
      publicQueryAuthorization: 'task',
      interaction: 'interact',
      verificationPolicy: 'public_query_target',
      expectedBrowserRevision: review.scope.revision,
      browserInstanceId: review.scope.browserInstanceId,
      origins: review.scope.origins,
      freshConsentReceiptId: binding.consentReceiptId,
      recoveryReceiptId: binding.receiptId,
      purposeHash: fp(task.goal)
    };
    const receipt=repo.beginOperation({
      ownerId: childId,
      idempotencyKey: `one-off-browser-binding:${binding.receiptId}`,
      kind: 'browser_binding',
      request,
      nowIso: this.deps.nowIso()
    }).receipt;
    const publicQueryAuthorization={
      receiptId: receipt.id,
      purposeHash: fp({ purpose: task.goal }),
      duration: 'task' as const
    };
    repo.finishOperation(childId,receipt.idempotencyKey,{
      status: 'succeeded',result: {
        taskId: childId,
        ...review.scope,
        browserRevision: review.scope.revision,
        purpose: task.goal,
        publicQueryAuthorization
      }
    },this.deps.nowIso());
    return { ...review.scope,publicQueryAuthorization };
  }
  revoke(task: TaskRun,input: {
    expectedRevision: number;
    idempotencyKey: string;
    consentReceiptId?: string;
    confirmed?: boolean;
  }) {
    const repo=this.deps.repository,binding=task.publicQueryRecovery,key=`one-off-revoke:${input.idempotencyKey}`,prior=repo.operation(task.id,key);
    if (prior) {
      if (prior.fingerprint!==fp(input)
        ||prior.status!=='succeeded')
        fail('idempotency_conflict');
      return { task: repo.get(task.id)! };
    }
    const proof=binding
      &&verifiedOneOffRecovery(repo,binding,false);
    if (!proof
      ||task.id!==proof.owner.id
      &&(!oneOffConsumer(repo,task)
        ||proof.use?.request?.retryTaskId!==task.id)
      ||input.confirmed!==true
      ||binding!.consentReceiptId!==input.consentReceiptId
      ||task.revision!==input.expectedRevision)
      fail('stale_request');
    return repo.transact(() => {
      repo.beginOperation({
        ownerId: task.id,
        idempotencyKey: key,
        kind: 'browser_public_query_scope_revoke',
        request: input,
        nowIso: this.deps.nowIso()
      });
      // Revoke is owned by the original consent; consumer task attribution is explicit.
      const ownerKey=`one-off-consent-revoke:${input.idempotencyKey}`;
      repo.beginOperation({
        ownerId: binding!.ownerTaskId,
        idempotencyKey: ownerKey,
        kind: 'browser_public_query_scope_revoke',
        request: {
          consentReceiptId: input.consentReceiptId,
          consumerTaskId: task.id,
          confirmed: true
        },
        nowIso: this.deps.nowIso()
      });
      repo.finishOperation(binding!.ownerTaskId,ownerKey,{ status: 'succeeded',result: { revoked: true } },this.deps.nowIso());
      const updated=repo.update(task.id,task.revision,t => t,{
        key,
        kind: 'browser_public_query_scope_revoked',
        payload: { consentReceiptId: input.consentReceiptId }
      });
      repo.finishOperation(task.id,key,{ status: 'succeeded',result: { task: updated } },this.deps.nowIso());
      return { task: updated };
    });
  }
}
/** Startup may settle an exact committed pre-Turn transaction, never start its browser/model work. */
export function settleUnstartedOneOffRetry(repo: TaskRunRepository,task: TaskRun,now: string): TaskRun|undefined {
  if (task.publicQueryRecovery?.mode!=='task_reauthorization'
    ||task.activeTurnId
    ||!['queued','waiting_user'].includes(task.status)
    ||repo.execution.latestAttempt(task.id)
    ||repo.getLease(task.id)
    ||repo.listShellSessions(task.id).length)
    return;
  const binding=task.publicQueryRecovery,proof=verifiedOneOffRecovery(repo,binding,false);
  if (!proof
    ||proof.owner.status!=='failed'
    ||task.retryOfTaskId!==proof.owner.id
    ||proof.use?.request?.retryTaskId!==task.id
    ||task.goal!==proof.owner.goal
    ||task.threadId!==proof.owner.threadId
    ||task.workspaceRoot!==proof.owner.workspaceRoot
    ||fp(task.acceptance)!==fp(proof.owner.acceptance))
    return;
  const own=oneOffChildBinding(repo,task,binding,proof.context),operations=repo.operations(task.id);
  if (!own
    ||operations.length!==1
    ||operations[0]!.id!==own.id
    ||!repo.events(task.id).some(e => e.kind==='task_retried'
      &&e.payload?.retryOfTaskId===proof.owner.id))
    return;
  const control=repo.operations(proof.owner.id,'retry').find(r => r.status==='prepared'
    &&r.fingerprint===fp(r.request)
    &&r.request?.publicQueryRecoveryReceiptId===binding.receiptId);
  if (!control)
    return;
  return repo.transact(() => {
    const current=repo.get(task.id)!,latest=repo.operation(proof.owner.id,control.idempotencyKey);
    if (current.revision!==task.revision
      ||latest?.status!=='prepared'
      ||latest.fingerprint!==control.fingerprint)
      return undefined;
    const waiting=repo.update(task.id,task.revision,t => ({
      ...t,
      status: 'waiting_user',
      waitingReason: '新的查询范围已保存；上次启动中断，请检查范围有效期后单独继续。'
    }),{
      key: `one-off-unstarted-recovery:${control.id}`,
      kind: 'task_waiting_user',
      payload: { reason: 'one_off_retry_start_interrupted' },
      createdAt: now
    });
    repo.finishOperation(proof.owner.id,control.idempotencyKey,{ status: 'succeeded',result: { task: waiting } },now);
    return waiting;
  });
}
