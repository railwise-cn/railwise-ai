import { randomUUID } from 'node:crypto'
import { TaskApprovalGrantSchema, TaskPermissionConfirmationSchema, type TaskPermissionConfirmation, type TaskApprovalGrant, type WorkspaceTrustLevel } from '../contracts/permissions.js'
import type { ThreadRecord } from '../contracts/threads.js'
import type { TaskRun } from '../contracts/tasks.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'
import type { WorkspaceTrustReader } from './workspace-trust-reader.js'

export type TaskPermissionSnapshot = {
  taskId: string; taskRevision: number; taskTitle: string; scopeHash: string
  workspaceRoot: string; workspaceTrust: WorkspaceTrustLevel; workspaceRevision: number; agentRevision: number
  approvalPolicy: ThreadRecord['approvalPolicy']; targetApprovalPolicy: 'on-request'; maxTtlSeconds: 900
  sandboxMode: ThreadRecord['sandboxMode']; agentTrust: WorkspaceTrustLevel; agentName?: string
  toolAllowlist?: string[]; mcpAllowlist?: string[]; externalTargets: string[]
  connectorScopeSources: Array<{ provider: string; scopes: string[]; source: 'task_requirements' | 'last_execution_grant'; issuedAt?: string; expiresAt?: string }>
  canConfirm: boolean; reason?: string
  grant?: { id: string; status: 'active'|'expired'|'invalid'|'prepared'; confirmedAt: string; expiresAt: string }
}
export type TaskPermissionResult = { task: TaskRun; permission: TaskPermissionSnapshot; resumed: false }
export type TaskExecutionRestriction = { taskPermissionId?: string; expiresAt?: string }
const fail = (code:string,message:string):never => {throw Object.assign(new Error(message),{code})}

/** Only the dedicated task thread changes policy. Workspace, Agent and origin authority are untouched. */
export class TaskPermissionService {
  private readonly pending = new Map<string,Promise<unknown>>()
  constructor(private readonly deps:{repository:TaskRunRepository;threads:{get(threadId:string):Promise<ThreadRecord|null>;update(threadId:string,patch:{approvalPolicy:'on-request'}):Promise<ThreadRecord>};workspaceTrust:WorkspaceTrustReader;nowIso():string}) {}

  async snapshot(taskId:string):Promise<TaskPermissionSnapshot> {
    const scope=await this.scope(taskId)
    return this.describe(scope)
  }

  async confirm(taskId:string,raw:TaskPermissionConfirmation):Promise<TaskPermissionResult> {
    const request=TaskPermissionConfirmationSchema.parse(raw)
    const previous=this.pending.get(taskId)??Promise.resolve()
    const next=previous.catch(()=>undefined).then(()=>this.confirmOnce(taskId,request))
    this.pending.set(taskId,next)
    try{return await next}finally{if(this.pending.get(taskId)===next)this.pending.delete(taskId)}
  }

  /** Called before admission, Grant creation and each dispatch. An expired/prepared grant fails closed. */
  async executionRestriction(threadId:string,expectedPermissionId?:string):Promise<TaskExecutionRestriction> {
    const task=this.deps.repository.findActiveByThread(threadId)
    if(!task){if(expectedPermissionId)fail('task_permission_revoked','The task permission no longer has an active task.');return {}}
    if(task.authority?.revokedAt)fail('task_permission_revoked','Task authority was revoked.')
    const grant=task.authority?.taskApprovalGrant
    if(!grant){if(expectedPermissionId)fail('task_permission_revoked','The scoped task permission was removed.');return {}}
    const scope=await this.scope(task.id)
    const state=this.grantState(scope,grant)
    if(state!=='active')fail(state==='expired'?'task_permission_expired':'task_permission_revoked',state==='expired'?'当前任务的临时审批权限已到期，请重新确认后重查原任务。':'当前任务权限范围已变化或尚未完成确认，请重新核对权限卡片。')
    if(expectedPermissionId&&expectedPermissionId!==grant.id)fail('task_permission_revoked','A different task permission replaced this execution grant.')
    return {taskPermissionId:grant.id,expiresAt:grant.expiresAt}
  }

  private async confirmOnce(taskId:string,request:TaskPermissionConfirmation):Promise<TaskPermissionResult> {
    const {repository,threads,nowIso}=this.deps
    const key=`task-permission:${request.idempotencyKey}`,prior=repository.operation(taskId,key)
    if(prior){
      repository.beginOperation({ownerId:taskId,idempotencyKey:key,kind:'task_permission',request,nowIso:nowIso()})
      if(prior.status==='succeeded')return prior.result as TaskPermissionResult
      return fail('outcome_unknown','The previous permission confirmation is incomplete. Recheck the task scope and use a new confirmation key; no execution has been resumed.')
    }
    const scope=await this.scope(taskId),description=this.describe(scope)
    if(scope.task.revision!==request.expectedRevision||description.scopeHash!==request.scopeHash)fail('stale_request','Task, workspace or Agent permissions changed. Reload the permission card before confirming.')
    if(!description.canConfirm)fail('task_permission_blocked',description.reason??'This task cannot receive a scoped approval permission.')
    const confirmedAt=nowIso(),permission=TaskApprovalGrantSchema.parse({id:`task_permission_${randomUUID()}`,taskId,threadId:scope.thread.id,
      previousPolicy:'never',approvalPolicy:'on-request',workspaceRoot:scope.workspace.canonicalRoot,workspaceRevision:scope.workspace.revision,workspaceTrust:scope.workspace.level,
      agentRevision:scope.thread.agentRevision??0,scopeFingerprint:scope.binding,status:'prepared',confirmed:true,confirmedAt,
      expiresAt:new Date(Date.parse(confirmedAt)+request.ttlSeconds*1000).toISOString(),idempotencyKey:request.idempotencyKey})
    const prepared=repository.transact(()=>{
      const latest=repository.get(taskId)!
      if(latest.revision!==request.expectedRevision)fail('stale_request','Task revision changed before confirmation.')
      this.assertIdle(latest)
      repository.beginOperation({ownerId:taskId,idempotencyKey:key,kind:'task_permission',request,nowIso:confirmedAt})
      return repository.update(taskId,latest.revision,current=>({...current,authority:{...current.authority!,taskApprovalGrant:permission},updatedAt:confirmedAt}),
        {key:`task-permission-prepared:${permission.id}`,kind:'task_permission_prepared',payload:{permissionId:permission.id,expiresAt:permission.expiresAt},createdAt:confirmedAt})
    })
    try{
      // No database transaction is held across the file-backed thread update.
      const beforeWrite=await this.scope(taskId)
      if(beforeWrite.binding!==scope.binding||beforeWrite.task.revision!==prepared.revision)fail('stale_request','The reviewed task scope changed before its policy update.')
      await threads.update(scope.thread.id,{approvalPolicy:'on-request'})
      const afterWrite=await this.scope(taskId)
      if(afterWrite.binding!==scope.binding||afterWrite.thread.approvalPolicy!=='on-request'||afterWrite.task.revision!==prepared.revision)fail('stale_request','The reviewed task scope changed while its policy was saved.')
      const task=repository.transact(()=>{
        const latest=repository.get(taskId)!
        if(latest.revision!==prepared.revision||latest.authority?.taskApprovalGrant?.id!==permission.id)fail('stale_request','Task permission was concurrently replaced.')
        this.assertIdle(latest)
        return repository.update(taskId,latest.revision,current=>({...current,authority:{...current.authority!,approvalPolicy:'on-request',taskApprovalGrant:{...permission,status:'active'}},updatedAt:nowIso()}),
          {key:`task-permission-confirmed:${permission.id}`,kind:'task_permission_confirmed',payload:{permissionId:permission.id,previousPolicy:'never',approvalPolicy:'on-request',expiresAt:permission.expiresAt,confirmed:true},createdAt:nowIso()})
      })
      const result:TaskPermissionResult={task,permission:await this.snapshot(taskId),resumed:false}
      repository.transact(()=>{
        repository.finishOperation(taskId,key,{status:'succeeded',result},nowIso())
        // A fresh exact review replaces an incomplete policy-file attempt. This
        // settles only permission configuration, never an unknown tool effect.
        for(const old of repository.operations(taskId,'task_permission')) {
          if(old.idempotencyKey!==key&&['prepared','running','outcome_unknown'].includes(old.status))repository.finishOperation(taskId,old.idempotencyKey,{status:'failed',result:{previousStatus:old.status,supersededBy:permission.id,reason:'A new explicit scope review replaced this incomplete permission configuration.'},error:old.error??'Permission configuration was superseded by a fresh explicit confirmation.'},nowIso())
        }
      })
      return result
    }catch(error){
      repository.finishOperation(taskId,key,{status:'outcome_unknown',error:'Task policy confirmation was interrupted; the prepared permission remains unusable until reviewed again.'},nowIso())
      throw error
    }
  }

  private async scope(taskId:string) {
    const task=this.deps.repository.currentExecution(taskId)
    if(!task||task.id!==taskId) return fail('not_found','The exact active task was not found; reload its current task card.')
    const thread=await this.deps.threads.get(task.threadId)
    if(!thread)return fail('not_found','The task execution context was not found.')
    const workspace=await this.deps.workspaceTrust.get(thread.workspace)
    const binding=operationFingerprint({taskId:task.id,threadId:thread.id,originThreadId:task.originThreadId,goal:task.goal,workspace:thread.workspace,workspaceRoot:workspace.canonicalRoot,
      workspaceRevision:workspace.revision,workspaceTrust:workspace.level,agentId:thread.agentId??null,agentRevision:thread.agentRevision??0,agentProfile:thread.agentProfile??null,
      sandboxMode:thread.sandboxMode,mode:thread.mode,relation:thread.relation,parentThreadId:thread.parentThreadId,authorityWorkspace:task.authority?.workspaceRoot??null,authoritySandbox:task.authority?.sandboxMode??null,revokedAt:task.authority?.revokedAt??null,
      toolAllowlist:task.authority?.toolAllowlist??null,mcpAllowlist:task.authority?.mcpAllowlist??null,externalTargets:task.authority?.externalTargets??[],previousPolicy:'never'})
    return {task,thread,workspace,binding}
  }

  private describe(scope:Awaited<ReturnType<TaskPermissionService['scope']>>):TaskPermissionSnapshot {
    const {task,thread,workspace}=scope,grant=task.authority?.taskApprovalGrant
    const agentTrust=thread.agentProfile?.trustLevel??'full-access'
    const trustOrder:WorkspaceTrustLevel[]=['read-only','workspace-write','trusted','full-access']
    const trust=trustOrder[Math.min(trustOrder.indexOf(workspace.level),trustOrder.indexOf(agentTrust))]!
    const sandboxMode=trust==='read-only'||thread.sandboxMode==='read-only'?'read-only':trust==='full-access'?thread.sandboxMode:thread.sandboxMode==='external-sandbox'?'external-sandbox':'workspace-write'
    const effect=task.acceptance.kind==='effect'?task.acceptance.effect:undefined
    const effects=effect?.requiredEffects??(effect?.target?[{...effect,target:effect.target}]:[])
    const externalTargets=[...new Set([...(task.authority?.externalTargets??[]),...effects.map(item=>JSON.stringify([item.provider,item.operation,item.target]))])]
    const connectorScopeSources:TaskPermissionSnapshot['connectorScopeSources']=[]
    const requirements=new Map<string,Set<string>>()
    for(const requirement of [effect,...effects])if(requirement?.requiredScopes?.length){
      const scopes=requirements.get(requirement.provider)??new Set<string>()
      for(const name of requirement.requiredScopes)scopes.add(name)
      requirements.set(requirement.provider,scopes)
    }
    for(const [provider,scopes] of requirements)connectorScopeSources.push({provider,scopes:[...scopes],source:'task_requirements'})
    // Historical scopes are explicitly labeled; they never substitute for a fresh catalog/Grant.
    const priorTurn=[...thread.turns].reverse().find(turn=>turn.executionGrant?.taskId===task.id&&turn.executionGrant.threadId===thread.id&&turn.executionGrant.workspaceRoot===workspace.canonicalRoot)
    const priorGrant=priorTurn?.executionGrant
    const priorProviders=priorGrant?.allowedProviderIds?.filter(id=>id==='lark-cli'||id==='dingtalk')??[]
    const priorProvider=priorTurn?.externalTaskProvider??(priorProviders.length===1?(priorProviders[0]==='lark-cli'?'lark':'dingtalk'):undefined)
    if(priorGrant&&priorProvider&&priorGrant.connectorScopes.length)connectorScopeSources.push({provider:priorProvider,scopes:[...priorGrant.connectorScopes],source:'last_execution_grant',issuedAt:priorGrant.issuedAt,...(priorGrant.expiresAt?{expiresAt:priorGrant.expiresAt}:{})})
    const state=grant?this.grantState(scope,grant):undefined
    let reason:string|undefined
    if(!task.originThreadId||task.originThreadId===task.threadId||thread.relation!=='side'||thread.parentThreadId!==task.originThreadId)reason='只能为当前任务的独立执行上下文确认权限，不能修改普通聊天或发起会话。'
    else if(!task.authority||task.authority.revokedAt)reason='任务授权已撤销。'
    else if(!['waiting_user','waiting_approval','stalled','paused'].includes(task.status))reason='请先让任务停止执行并进入等待或暂停状态。'
    else if(thread.approvalPolicy!=='never'&&!(grant?.previousPolicy==='never'&&thread.approvalPolicy==='on-request'))reason='当前任务没有需要解除的禁止执行策略。'
    else if(state==='active')reason='当前任务已有尚未到期的有限期审批权限。'
    else if(!workspace.canonicalRoot)reason='请先为当前任务选择工作区。'
    else {try{this.assertIdle(task)}catch(error){reason=error instanceof Error?error.message:String(error)}}
    return {taskId:task.id,taskRevision:task.revision,taskTitle:task.goal.slice(0,200),workspaceRoot:workspace.canonicalRoot,workspaceTrust:workspace.level,workspaceRevision:workspace.revision,
      agentRevision:thread.agentRevision??0,approvalPolicy:thread.approvalPolicy,targetApprovalPolicy:'on-request',maxTtlSeconds:900,
      sandboxMode,agentTrust,...(thread.agentProfile?.name?{agentName:thread.agentProfile.name}:{}),
      toolAllowlist:intersectAllowlist(thread.agentProfile?.toolAllowlist,task.authority?.toolAllowlist),
      mcpAllowlist:intersectAllowlist(thread.agentProfile?.mcpAllowlist,task.authority?.mcpAllowlist),externalTargets,connectorScopeSources,
      scopeHash:operationFingerprint({taskRevision:task.revision,binding:scope.binding,approvalPolicy:thread.approvalPolicy,permissionId:grant?.id??null}),canConfirm:!reason,...(reason?{reason}:{}),
      ...(grant&&state?{grant:{id:grant.id,status:state,confirmedAt:grant.confirmedAt,expiresAt:grant.expiresAt}}:{})}
  }

  private grantState(scope:Awaited<ReturnType<TaskPermissionService['scope']>>,grant:TaskApprovalGrant):'active'|'expired'|'invalid'|'prepared' {
    if(grant.status==='prepared')return 'prepared'
    if(grant.taskId!==scope.task.id||grant.threadId!==scope.thread.id||scope.thread.approvalPolicy!=='on-request'||grant.scopeFingerprint!==scope.binding||scope.task.authority?.revokedAt)return 'invalid'
    return Date.parse(grant.expiresAt)<=Date.parse(this.deps.nowIso())?'expired':'active'
  }

  private assertIdle(task:TaskRun):void {
    const attempt=this.deps.repository.execution.latestAttempt(task.id)
    if(attempt?.status==='running')fail('task_permission_blocked','当前任务仍有活跃执行，请先暂停并等待工具结果落盘。')
    const lease=this.deps.repository.getLease(task.id)
    if(lease&&Date.parse(lease.expiresAt)>Date.parse(this.deps.nowIso()))fail('task_permission_blocked','当前任务仍持有执行租约，请先暂停并等待执行结束。')
    if(this.deps.repository.unsettledOperations(task.id).some(operation=>['tool','host_shell'].includes(operation.kind)))fail('task_permission_blocked','当前任务有待核实操作，不能通过修改权限绕过。')
    if(this.deps.repository.listShellSessions(task.id).some(session=>['running','starting','outcome_unknown'].includes(session.status)))fail('task_permission_blocked','当前任务仍有运行中或待核实命令，不能通过修改权限绕过。')
  }
}

function intersectAllowlist(first?:readonly string[],second?:readonly string[]):string[]|undefined {
  const normalize=(values?:readonly string[])=>!values||values.includes('*')?undefined:[...new Set(values)]
  const a=normalize(first),b=normalize(second)
  return a&&b?a.filter(value=>b.includes(value)):a??b
}
