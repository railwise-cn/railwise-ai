import { createHash } from 'node:crypto';
import { ExecutionGrantSchema,type ExecutionGrant,type ExecutionScope } from '../contracts/permissions.js';
import { ONE_OFF_TOOLS,ONE_OFF_PROVIDERS,OneOffScopeConfirmationSchema,OneOffScopeReviewSchema,type BrowserPublicQueryRecoveryBinding,type OneOffScopeReview } from '../contracts/browser-public-query-recovery.js';
import type { OperationReceipt,TaskRun } from '../contracts/tasks.js';
import type { PublicQueryRecoveryContext } from './browser-public-query-recovery-proof.js';
import { verifiedTaskPublicQueryAction } from './browser-public-query-authority.js';
import { operationFingerprint as fp,type TaskRunRepository } from './task-run-repository.js';
import { assertGrantAllowsNetwork } from '../adapters/tool/sandbox-policy.js';
const obj=(v: unknown): Record<string,unknown> => v
  &&typeof v==='object'
  &&!Array.isArray(v)? v as Record<string,unknown>:{};
function fail(): never { throw Object.assign(new Error('本次公开检索的范围同意已到期、撤销或变化，请重新审阅。'),{ code: 'browser_public_query_fresh_scope_required' }); }
export type OneOffContext=PublicQueryRecoveryContext&{
  mode: 'task_reauthorization';
  review: OneOffScopeReview;
  taskPermissionRequired: boolean;
  ceiling: ExecutionGrant;
};
/** Immutable historical fencing facts. Expiry/revocation is checked separately before execution. */
export function verifiedOneOffRecovery(repo: TaskRunRepository,binding: BrowserPublicQueryRecoveryBinding,consumed=true,seen=new Set<string>()): {
  receipt: OperationReceipt;
  context: OneOffContext;
  owner: TaskRun;
  use: OperationReceipt|undefined;
}|undefined {
  if (binding.mode!=='task_reauthorization'
    ||!binding.consentReceiptId
    ||binding.scheduleId
    ||seen.has(binding.receiptId)
    ||seen.size>=32)
    return;
  seen.add(binding.receiptId);
  const receipt=repo.operationById(binding.ownerTaskId,binding.receiptId,'browser_public_query_recovery'),owner=repo.get(binding.ownerTaskId),request=obj(receipt?.request),context=request.context as OneOffContext|undefined,result=obj(receipt?.result);
  if (!owner
    ||!receipt
    ||receipt.status!=='succeeded'
    ||receipt.fingerprint!==fp(request)
    ||request.confirmed!==true
    ||!context
    ||context.mode!=='task_reauthorization'
    ||context.taskId!==owner.id
    ||context.threadId!==owner.threadId
    ||context.goalHash!==fp(owner.goal)
    ||context.acceptanceHash!==fp(owner.acceptance)
    ||context.authorityHash!==fp(owner.authority)
    ||context.plan
    ||owner.scheduledBy
    ||owner.acceptance.schedule
    ||owner.acceptance.effect
    ||context.sourceTaskId!==binding.sourceTaskId
    ||fp(context)!==binding.scopeHash
    ||fp(result.binding)!==fp(binding)
    ||!OneOffScopeReviewSchema.safeParse(context.review).success
    ||context.review.browserIdentity!==binding.browserIdentity
    ||!Array.isArray(context.unknowns)
    ||context.unknowns.length>16)
    return;
  const consent=repo.operationById(owner.id,binding.consentReceiptId,'browser_public_query_scope_consent'),c=obj(consent?.result);
  if (!consent
    ||consent.status!=='succeeded'
    ||consent.fingerprint!==fp(consent.request)
    ||consent.request?.recoveryReceiptId!==receipt.id
    ||consent.request?.reviewHash!==context.review.reviewHash
    ||consent.request.confirmed!==true
    ||fp(c.review)!==fp(context.review)
    ||!Number.isFinite(Date.parse(String(c.confirmedAt)))
    ||!Number.isFinite(Date.parse(String(c.expiresAt)))
    ||Date.parse(String(c.expiresAt))<=Date.parse(String(c.confirmedAt))
    ||Date.parse(String(c.expiresAt))>Date.parse(String(c.confirmedAt))+900000)
    return;
  if (!ExecutionGrantSchema.safeParse(context.ceiling).success
    ||context.review.allowedToolNames.some(t => !ONE_OFF_TOOLS.includes(t)
      ||!context.ceiling.allowedToolNames?.includes(t))
    ||context.review.allowedProviderIds.some(p => !ONE_OFF_PROVIDERS.includes(p)
      ||!context.ceiling.allowedProviderIds?.includes(p)))
    return;
  const confirmation=OneOffScopeConfirmationSchema.safeParse(consent.request?.scopeConfirmation);
  if (!confirmation.success
    ||confirmation.data.reviewHash!==context.review.reviewHash
    ||confirmation.data.expectedBrowserRevision!==context.review.scope.revision
    ||confirmation.data.browserInstanceId!==context.review.scope.browserInstanceId
    ||fp(confirmation.data.origins)!==fp(context.review.scope.origins)
    ||String(c.confirmedAt)!==consent.createdAt
    ||Date.parse(String(c.expiresAt))!==Date.parse(String(c.confirmedAt))+confirmation.data.ttlSeconds*1000
    ||context.review.scope.origins.some(origin => !context.ceiling.browserScope?.origins.includes(origin)
      ||(() => {
        try {
          assertGrantAllowsNetwork(origin,{ executionGrant: context.ceiling });
          return false;
        }
        catch {
          return true;
        }
      })()))
    return;
  const previous=context.previousRecovery
    &&verifiedOneOffRecovery(repo,context.previousRecovery,true,seen);
  if (context.previousRecovery
    &&(!previous
      ||previous.context.sourceTaskId!==context.sourceTaskId
      ||previous.context.goalHash!==context.goalHash
      ||!context.unknowns.length
      &&fp(previous.context.ceiling)!==fp(context.ceiling)))
    return;
  const rows: OperationReceipt[]=[];
  for (const ref of context.unknowns) {
    const row=repo.operationById(ref.ownerId,ref.id);
    if (!row
      ||row.ownerId!==owner.id
      ||row.kind!==ref.kind
      ||row.fingerprint!==ref.fingerprint
      ||row.status!=='outcome_unknown'
      ||!['tool','browser_action_dispatch'].includes(row.kind))
      return;
    rows.push(row);
  }
  const hosts=rows.filter(r => r.kind==='tool');
  if (!hosts.length
    &&!previous)
    return;
  for (const host of hosts) {
    const grant=ExecutionGrantSchema.safeParse(host.request?.executionGrant),item=obj(obj(host.result).item),output=obj(item.output);
    const dispatches=rows.filter(r => r.kind==='browser_action_dispatch'
      &&r.request?.turnId===host.request?.turnId
      &&r.request?.argumentsHash===host.request?.argumentsHash
      &&r.request?.toolName===host.request?.toolName);
    if (!grant.success
      ||fp(grant.data)!==fp(context.ceiling)
      ||dispatches.length!==1
      ||host.fingerprint!==fp(host.request)
      ||host.request?.providerId!=='browser-skill'
      ||obj(host.result).approved!==true
      ||item.kind!=='tool_result'
      ||item.status!=='completed'
      ||item.isError!==true
      ||item.toolName!==host.request.toolName
      ||item.callId!==host.request.callId
      ||item.turnId!==grant.data.turnId
      ||item.threadId!==owner.threadId
      ||output.provider!=='browser-skill'
      ||output.status!=='outcome_unknown'
      ||grant.data.externalTargets.length
      ||grant.data.browserScheduleBinding)
      return;
    const dispatch=dispatches[0]!,scoped=verifiedTaskPublicQueryAction(repo,host,dispatch,true);
    if (!scoped
      ||scoped.authority.authorization.duration!=='task'
      ||dispatch.fingerprint!==fp(dispatch.request)
      ||![
        'search_input',
        'search_trigger',
        'pagination',
        'filter_control',
        'sort_control',
        'result_link'
      ].includes(String(scoped.request.rule)))
      return;
    const derivedRequest={
      ...scoped.request,
      actionId: scoped.result.id,
      scopeActionReceiptId: scoped.receipt.id
    },derived=repo.operation(owner.id,`browser-derived-scope-action:${fp(derivedRequest)}`);
    if (derived?.status!=='succeeded'
      ||derived.kind!=='browser_derived_action_authorization'
      ||derived.fingerprint!==fp(derivedRequest)
      ||fp(derived.result)!==fp({ ...scoped.result,scopeActionReceiptId: scoped.receipt.id })
      ||!repo.operations(owner.id,'browser_action_review').some(r => r.status==='failed'
        &&r.error==='not_found'
        &&r.fingerprint===fp(r.request)
        &&r.request?.originalReceiptId===host.id
        &&r.request.originalFingerprint===host.fingerprint))
      return;
  }
  const unsettled=repo.unsettledOperations(owner.id);
  if (unsettled.length!==rows.length
    ||unsettled.some(r => !rows.some(x => x.id===r.id
      &&x.fingerprint===r.fingerprint)))
    return;
  const use=repo.operations(owner.id,'browser_public_query_recovery_use').find(r => r.status==='succeeded'
    &&r.fingerprint===fp(r.request)
    &&r.request?.recoveryReceiptId===binding.receiptId
    &&r.request?.scopeHash===binding.scopeHash);
  if (consumed) {
    const child=typeof use?.request?.retryTaskId==='string'? repo.get(use.request.retryTaskId):null;
    const control=repo.operations(owner.id,'retry').find(r => r.status==='succeeded'
      &&r.fingerprint===fp(r.request)
      &&r.request?.publicQueryRecoveryReceiptId===receipt.id
      &&obj(obj(r.result).task).id===child?.id);
    if (!child
      ||child.threadId!==owner.threadId
      ||child.workspaceRoot!==owner.workspaceRoot
      ||child.goal!==owner.goal
      ||fp(child.acceptance)!==fp(owner.acceptance)
      ||(child.rootTaskId??child.id)!==(owner.rootTaskId??owner.id)
      ||child.retryOfTaskId!==owner.id
      ||!control
      ||fp(obj(obj(control.result).task).publicQueryRecovery)!==fp(binding)
      ||!repo.events(child.id).some(e => e.kind==='task_retried'
        &&e.payload?.retryOfTaskId===owner.id)
      ||!oneOffChildBinding(repo,obj(obj(control.result).task) as TaskRun,binding,context))
      return;
  }
  return {
    receipt,
    context,
    owner,
    use
  };
}
export function oneOffChildBinding(repo: TaskRunRepository,task: TaskRun,binding: BrowserPublicQueryRecoveryBinding,context: OneOffContext) {
  const scope=task.authority?.browserScope,receipt=repo.operation(task.id,`one-off-browser-binding:${binding.receiptId}`),result=obj(receipt?.result);
  if (!scope
    ||!receipt
    ||receipt.kind!=='browser_binding'
    ||receipt.status!=='succeeded'
    ||receipt.fingerprint!==fp(receipt.request)
    ||receipt.request?.freshConsentReceiptId!==binding.consentReceiptId
    ||receipt.request?.recoveryReceiptId!==binding.receiptId
    ||receipt.request?.confirmed!==true
    ||receipt.request?.publicQueryAuthorization!=='task'
    ||result.taskId!==task.id
    ||result.purpose!==task.goal
    ||fp(result.publicQueryAuthorization)!==fp(scope.publicQueryAuthorization)
    ||scope.publicQueryAuthorization?.receiptId!==receipt.id
    ||scope.publicQueryAuthorization.duration!=='task')
    return;
  const { publicQueryAuthorization: _auth,...actual }=scope;
  return fp(actual)===fp(context.review.scope)
    &&result.browserInstanceId===scope.browserInstanceId
    &&result.browserRevision===scope.revision
    &&fp(result.origins)===fp(scope.origins)? receipt:undefined;
}
export function activeOneOffConsent(repo: TaskRunRepository,binding: BrowserPublicQueryRecoveryBinding,now=Date.now()) {
  const consent=binding.consentReceiptId
    &&repo.operationById(binding.ownerTaskId,binding.consentReceiptId,'browser_public_query_scope_consent'),result=obj(consent
      &&consent.result);
  if (!consent
    ||consent.status!=='succeeded'
    ||consent.fingerprint!==fp(consent.request)
    ||Date.parse(String(result.expiresAt))<=now
    ||!Number.isFinite(Date.parse(String(result.expiresAt)))
    ||repo.operations(binding.ownerTaskId,'browser_public_query_scope_revoke').some(r => r.status==='succeeded'
      &&r.fingerprint===fp(r.request)
      &&r.request?.consentReceiptId===consent.id
      &&r.request.confirmed===true))
    fail();
  return result as {
    confirmedAt: string;
    expiresAt: string;
    review: OneOffScopeReview;
  };
}
export function oneOffConsumer(repo: TaskRunRepository,task: TaskRun) {
  const binding=task.publicQueryRecovery;
  if (binding?.mode!=='task_reauthorization')
    return;
  const proof=verifiedOneOffRecovery(repo,binding);
  return proof
    &&proof.use?.request?.retryTaskId===task.id
    &&!task.scheduledBy
    &&!task.acceptance.schedule
    &&oneOffChildBinding(repo,task,binding,proof.context)? proof:undefined;
}
export function oneOffExecutionScope(repo: TaskRunRepository,task: TaskRun,scope: ExecutionScope,now: number): ExecutionScope {
  const proof=oneOffConsumer(repo,task);
  if (!proof
    ||task.authority?.revokedAt)
    fail();
  const consent=activeOneOffConsent(repo,task.publicQueryRecovery!,now);
  if (scope.connectorIdentityFingerprints?.['browser-skill']!==proof.context.review.browserIdentity
    ||fp(scope.browserScope)!==fp(task.authority?.browserScope))
    fail();
  const allowedToolNames=proof.context.review.allowedToolNames.filter(t => ONE_OFF_TOOLS.includes(t)
    &&(!scope.allowedToolNames
      ||scope.allowedToolNames.includes(t)));
  const allowedProviderIds=proof.context.review.allowedProviderIds.filter(t => ONE_OFF_PROVIDERS.includes(t)
    &&(!scope.allowedProviderIds
      ||scope.allowedProviderIds.includes(t)));
  const networkAllowlist=proof.context.review.scope.origins.filter(origin => {
    try {
      assertGrantAllowsNetwork(origin,{ executionGrant: { networkAllowlist: scope.networkAllowlist } as ExecutionGrant });
      return true;
    }
    catch {
      return false;
    }
  });
  return {
    ...scope,
    browserPublicQueryRecovery: task.publicQueryRecovery,
    allowedToolNames,
    allowedProviderIds,
    networkAllowlist,
    externalTargets: [],
    connectorScopes: [],
    expiresAt: new Date(Math.min(Date.parse(consent.expiresAt),scope.expiresAt? Date.parse(scope.expiresAt):Infinity)).toISOString()
  };
}
export function assertOneOffGrant(repo: TaskRunRepository,grant: ExecutionGrant) {
  const task=grant.taskId? repo.get(grant.taskId):null;
  if (!task)
    fail();
  const proof=oneOffConsumer(repo,task);
  if (!proof)
    fail();
  const consent=activeOneOffConsent(repo,task.publicQueryRecovery!);
  if (Date.parse(grant.issuedAt)<Date.parse(consent.confirmedAt)
    ||grant.taskId!==task.id
    ||grant.turnId!==task.activeTurnId
    ||grant.threadId!==task.threadId
    ||fp(grant.browserScope)!==fp(task.authority?.browserScope)
    ||grant.connectorIdentityFingerprints?.['browser-skill']!==proof.context.review.browserIdentity
    ||!grant.expiresAt
    ||!Number.isFinite(Date.parse(grant.expiresAt))
    ||Date.parse(grant.expiresAt)>Date.parse(consent.expiresAt)
    ||!Array.isArray(grant.networkAllowlist)
    ||grant.networkAllowlist.some(origin => !proof.context.review.scope.origins.includes(origin))
    ||!grant.allowedToolNames
    ||grant.allowedToolNames.some(t => !proof.context.review.allowedToolNames.includes(t)
      ||!ONE_OFF_TOOLS.includes(t))
    ||!grant.allowedProviderIds
    ||grant.allowedProviderIds.some(t => !proof.context.review.allowedProviderIds.includes(t)
      ||!ONE_OFF_PROVIDERS.includes(t))
    ||grant.externalTargets.length)
    fail();
}
/** Only permission-card ownership may inspect the exact pre-Turn child; it is not execution authority. */
export function oneOffPermissionContext(repo: TaskRunRepository,task: TaskRun) {
  const binding=task.publicQueryRecovery;
  if (binding?.mode!=='task_reauthorization')
    return;
  const proof=verifiedOneOffRecovery(repo,binding,false);
  if (!proof
    ||proof.use?.request?.retryTaskId!==task.id
    ||task.retryOfTaskId!==proof.owner.id
    ||!oneOffChildBinding(repo,task,binding,proof.context))
    return;
  const control=repo.operations(proof.owner.id,'retry').find(r => r.fingerprint===fp(r.request)
    &&r.request?.publicQueryRecoveryReceiptId===binding.receiptId
    &&((r.status==='succeeded'
      &&obj(obj(r.result).task).id===task.id)
      ||(r.status==='prepared'
        &&task.id===`task_retry_${createHash('sha256').update(`task:${proof.owner.id}:retry:${r.idempotencyKey}`).digest('hex')}`)));
  return control? proof:undefined;
}
