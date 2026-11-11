import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { OperationReceipt, TaskInput, TaskRun } from '../src/contracts/tasks.js'
import { makeAssistantTextItem } from '../src/domain/item.js'
import { RequiredEffectSchema } from '../src/contracts/tasks.js'
import { TaskControlService } from '../src/services/task-control-service.js'

const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{while(cleanup.length)await cleanup.pop()!()})

async function fixture(prompt='执行本地合成资料检查并交付结果。',permission?:'active'|'expired'|'consumed'|'cancelled',queued:Array<{text:string;kind?:TaskInput['kind'];consumed?:boolean}>=[]) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'railwise-retry-ledger-')))
  cleanup.push(()=>rm(root,{recursive:true,force:true}))
  const runtime=await createKunServeRuntime({host:'127.0.0.1',port:0,dataDir:join(root,'state'),runtimeToken:'fixture',apiKey:'',baseUrl:'http://127.0.0.1:9',model:'fixture',approvalPolicy:'auto',sandboxMode:'workspace-write',tokenEconomyMode:false,insecure:false,storage:{backend:'file'},capabilities:KunCapabilitiesConfig.parse({})})
  cleanup.push(async()=>runtime.shutdown?.())
  const origin=await runtime.threadService.create({workspace:root,model:'fixture',mode:'agent'})
  const thread=permission?await runtime.threadService.fork(origin.id,{relation:'side'}):origin
  const started=await runtime.turnService.startTurn({threadId:thread.id,request:{prompt,taskIntent:'new',taskVisibility:'task',...(permission?{taskOriginThreadId:origin.id}:{})}})
  const task=runtime.taskRepository!.findByTurn(started.turnId)!
  let originalPermissionId:string|undefined
  if(permission){
    runtime.taskRepository!.update(task.id,task.revision,value=>({...value,status:'waiting_user'}))
    const snapshot=await runtime.taskPermissionService!.snapshot(task.id)
    const granted=await runtime.taskPermissionService!.confirm(task.id,{expectedRevision:snapshot.taskRevision,scopeHash:snapshot.scopeHash,idempotencyKey:'original-permission',confirmed:true,approvalPolicy:'on-request',ttlSeconds:900,duration:'next_operation',scope:{readPaths:[root]}})
    originalPermissionId=granted.permission.grant!.id
    if(permission==='consumed')await runtime.taskPermissionService!.claimOperation(thread.id,originalPermissionId,'original-dispatch')
    if(permission==='expired')runtime.taskRepository!.update(task.id,granted.task.revision,value=>({...value,authority:{...value.authority!,taskApprovalGrant:{...value.authority!.taskApprovalGrant!,expiresAt:new Date(Date.now()-1000).toISOString()}}}))
  }
  const originalInputs=queued.map((input,index)=>{
    const current=runtime.taskRepository!.get(task.id)!
    const saved=runtime.taskRepository!.appendInput({taskId:task.id,expectedRevision:current.revision,idempotencyKey:`input-${index}`,text:input.text,kind:input.kind,nowIso:runtime.nowIso()}).input
    if(input.consumed)runtime.taskRepository!.consumeInput(saved.id,runtime.nowIso())
    return saved
  })
  if(permission&&permission!=='cancelled')runtime.taskController!.recordAttemptFailure(thread.id,started.turnId,'max_tokens','Synthetic failure before dispatch')
  else runtime.taskController!.cancelTask(task.id,runtime.taskRepository!.get(task.id)!.revision,'synthetic cancellation after operation')
  await runtime.turnService.finishTurn({threadId:thread.id,turnId:started.turnId,status:'aborted'})
  const runTurn=vi.fn(),preflight=vi.fn(async()=>null)
  const controls=new TaskControlService({repository:runtime.taskRepository!,tasks:runtime.taskController!,threads:runtime.threadService,turns:runtime.turnService,runTurn,preflightExternalTask:preflight,validateTaskPermission:threadId=>runtime.taskPermissionService!.executionRestriction(threadId),nowIso:runtime.nowIso})
  const receipt=(owner:TaskRun,key:string,status:OperationReceipt['status'],input?:{kind?:string;toolName?:string;operation?:string;result?:unknown})=>{
    const kind=input?.kind??'tool',toolName=input?.toolName??'lark_task_complete',operation=input?.operation??'complete'
    const saved=runtime.taskRepository!.beginOperation({ownerId:owner.id,idempotencyKey:key,kind,request:{provider:'lark',providerId:'lark-cli',toolName,operation,target:'task-a'},nowIso:runtime.nowIso()}).receipt
    if(status!=='prepared')return runtime.taskRepository!.finishOperation(owner.id,key,{status,...(input?.result?{result:input.result}:{})},runtime.nowIso())
    return saved
  }
  const retry=(target=task,key='retry-once')=>controls.mutate(target.id,'retry',{expectedRevision:runtime.taskRepository!.get(target.id)!.revision,idempotencyKey:key})
  return {root,runtime,thread,task,controls,runTurn,preflight,receipt,retry,originalPermissionId,originalInputs}
}

describe('whole-task retries retain the original operation ledger safety',()=>{
  it.each(['生成 Markdown 报告并交付文件。','请查询飞书待办。','同意钉钉审批。'])('retains the original goal and acceptance through the production retry entry (%s)',async prompt=>{
    const f=await fixture(prompt)
    const retried=await f.retry()
    expect(retried.task.goal).toBe(f.task.goal)
    expect(retried.task.acceptance).toEqual(f.task.acceptance)
    expect(retried.task.rootTaskId).toBe(f.task.id)
    expect(retried.task.budget).toEqual(f.task.budget)
    const turnId=retried.turn!.turnId
    await f.runtime.turnService.applyItem(f.thread.id,makeAssistantTextItem({id:'retry-explanation',threadId:f.thread.id,turnId,text:'已说明如何操作。',status:'completed'}))
    f.runtime.taskController!.beginAttempt(f.thread.id,turnId)
    const decision=await f.runtime.taskController!.assessCandidate(f.thread.id,turnId)
    expect(decision?.kind).not.toBe('completed')
  })

  it.each(['active','expired','consumed','cancelled'] as const)('applies %s original permission before allocating the retry Turn',async state=>{
    const f=await fixture('生成 Markdown 报告并交付文件。',state)
    const before=(await f.runtime.threadService.get(f.thread.id))!.turns.length
    const retried=await f.retry()
    expect(retried.task.authority?.taskApprovalGrant).toBeUndefined()
    if(state==='active'){
      expect(retried.turn).toBeDefined()
      expect(f.runTurn).toHaveBeenCalledOnce()
      expect(await f.runtime.taskPermissionService!.executionRestriction(f.thread.id)).toMatchObject({taskPermissionId:f.originalPermissionId})
    }else{
      expect(retried.turn).toBeUndefined()
      expect(retried.task.status).toBe('waiting_user')
      expect(f.runTurn).not.toHaveBeenCalled()
      expect((await f.runtime.threadService.get(f.thread.id))!.turns).toHaveLength(before)
      expect((await f.runtime.taskPermissionService!.snapshot(retried.task.id)).canConfirm).toBe(true)
    }
    expect(retried.task.acceptance).toEqual(f.task.acceptance)
  })

  it('keeps a previously confirmed finite combined scope intact and refuses an incomplete scope after retry',async()=>{
    const f=await fixture('同意钉钉审批，然后拒绝另一条钉钉审批。')
    const original=f.runtime.taskRepository!.get(f.task.id)!
    const requiredEffects=[RequiredEffectSchema.parse({provider:'dingtalk',operation:'approve',target:'approve-target'}),RequiredEffectSchema.parse({provider:'dingtalk',operation:'reject',target:'reject-target'})]
    const scoped=f.runtime.taskRepository!.update(original.id,original.revision,task=>({...task,acceptance:{...task.acceptance,effect:{...task.acceptance.effect!,requiredEffects,scopeConfirmationId:'original-reviewed-scope',scopeRevision:1}}}))
    const retried=await f.retry(scoped)
    expect(retried.task.acceptance).toEqual(scoped.acceptance)
    f.runtime.taskController!.beginAttempt(f.thread.id,retried.turn!.turnId)
    expect(()=>f.runtime.taskController!.validateEffectScopeOperations(retried.turn!.turnId,[requiredEffects[0]!])).toThrow(expect.objectContaining({code:'effect_scope_incomplete'}))
    expect(()=>f.runtime.taskController!.confirmEffectScope(retried.turn!.turnId,1,'replace-scope',requiredEffects)).toThrow(expect.objectContaining({code:'effect_scope_conflict'}))
  })

  it('delivers an unconsumed original supplement into the retry and acknowledges its original input only at a checkpoint',async()=>{
    const f=await fixture('生成 Markdown 报告并交付文件。','active',[{text:'报告还需包含原始数据来源。'}])
    const source=f.runtime.taskRepository!.get(f.task.id)!
    const input=f.originalInputs[0]!
    const retried=await f.retry()
    const controller=f.runtime.taskController!,turnId=retried.turn!.turnId
    controller.beginAttempt(f.thread.id,turnId)
    const deliveries=controller.pendingDeliveries(f.thread.id,turnId)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]!.input).toMatchObject({id:input.id,taskId:source.id,text:input.text})
    expect(f.runtime.taskRepository!.inputs(source.id,true)).toHaveLength(1)
    controller.markInputsDelivered(turnId,deliveries.map(item=>item.delivery),'retry-input-message','a'.repeat(64))
    expect(f.runtime.taskRepository!.inputs(source.id,true)).toHaveLength(1)
    const pending=controller.pendingDeliveries(f.thread.id,turnId)
    controller.acknowledgeInputs(turnId,pending.map(item=>item.delivery),'retry-input-message','a'.repeat(64))
    expect(f.runtime.taskRepository!.inputs(source.id,true)).toEqual([])
    expect(f.runtime.taskRepository!.inputs(retried.task.id)).toEqual([])
    expect(f.runtime.taskRepository!.latestCheckpoint(retried.task.id)?.consumedInputIds).toEqual([input.id])
  })

  it('excludes consumed supplements and old question answers, and keeps cancellation as an input boundary',async()=>{
    const queued=[{text:'有效的未消费补充'},{text:'已经纳入上下文的补充',consumed:true},{text:'旧问题的迟到回答',kind:'user_answer' as const}]
    const failed=await fixture('生成 Markdown 报告并交付文件。','active',queued)
    const retry=await failed.retry()
    expect(failed.runtime.taskController!.taskInputs(retry.task.id,true).map(input=>input.text)).toEqual(['有效的未消费补充'])
    const cancelled=await fixture('生成 Markdown 报告并交付文件。',undefined,queued)
    const replacement=await cancelled.retry()
    expect(cancelled.runtime.taskController!.taskInputs(replacement.task.id,true)).toEqual([])
    expect(cancelled.runtime.taskRepository!.inputs(cancelled.task.id,true)).toHaveLength(2)
  })

  it('persists the retry contract when Turn creation fails and allows continuing that same task',async()=>{
    const f=await fixture('同意钉钉审批。')
    const start=vi.spyOn(f.runtime.turnService,'startTurn').mockRejectedValueOnce(new Error('synthetic turn persistence failure'))
    await expect(f.retry()).rejects.toThrow('synthetic turn persistence failure')
    const prepared=f.runtime.taskRepository!.currentExecution(f.task.id)!
    expect(prepared).toMatchObject({status:'waiting_user',goal:f.task.goal,acceptance:f.task.acceptance,retryOfTaskId:f.task.id})
    expect(prepared.activeTurnId).toBeUndefined()
    start.mockRestore()
    const resumed=await f.controls.mutate(prepared.id,'resume',{expectedRevision:prepared.revision,idempotencyKey:'resume-prepared'})
    expect(resumed.task.id).toBe(prepared.id)
    expect(resumed.task.acceptance).toEqual(f.task.acceptance)
    expect(f.runTurn).toHaveBeenCalledOnce()
  })

  it.each(['prepared','running','outcome_unknown'] as const)('does not create a new ledger for an unresolved %s operation',async status=>{
    const f=await fixture(),operation=f.receipt(f.task,'original-unknown',status)
    await expect(f.retry()).rejects.toMatchObject({code:'outcome_unknown'})
    expect(f.runtime.taskRepository!.list({threadId:f.thread.id})).toHaveLength(1)
    expect(f.runtime.taskRepository!.operation(f.task.id,'original-unknown')?.id).toBe(operation.id)
    expect(f.preflight).not.toHaveBeenCalled()
    expect(f.runTurn).not.toHaveBeenCalled()
  })

  it('does not bypass an unknown host command or a known process through task cancellation/retry',async()=>{
    const f=await fixture()
    f.receipt(f.task,'shell-unknown','outcome_unknown',{kind:'host_shell'})
    await expect(f.retry()).rejects.toMatchObject({code:'outcome_unknown'})
    f.runtime.taskRepository!.finishOperation(f.task.id,'shell-unknown',{status:'failed'},f.runtime.nowIso())
    f.runtime.taskRepository!.createShellSession({id:'still-running',taskId:f.task.id,nodeId:f.task.nodes[0]!.id,workspaceRoot:f.root,cwd:f.root,commandSummary:'synthetic',status:'running',outputPath:join(f.root,'shell.log'),outputBytes:0,createdAt:f.runtime.nowIso(),revision:0})
    await expect(f.retry(f.task,'retry-process')).rejects.toMatchObject({code:'outcome_unknown'})
    expect(f.runTurn).not.toHaveBeenCalled()
    expect(f.runtime.taskRepository!.list({threadId:f.thread.id})).toHaveLength(1)
  })

  it('checks all retry ancestors, rather than just the new task ledger',async()=>{
    const f=await fixture()
    f.receipt(f.task,'ancestor-effect','outcome_unknown')
    const ancestor=f.runtime.taskRepository!.get(f.task.id)!
    const child=f.runtime.taskRepository!.create({...ancestor,id:'legacy-retry-with-empty-ledger',retryOfTaskId:ancestor.id,rootTaskId:ancestor.id,createdAt:new Date(Date.parse(ancestor.createdAt)+1).toISOString(),nodes:ancestor.nodes.map(node=>({...node,id:`retry-${node.id}`,taskId:'legacy-retry-with-empty-ledger'}))})
    await expect(f.retry(child)).rejects.toMatchObject({code:'outcome_unknown'})
    expect(f.runtime.taskRepository!.list({threadId:f.thread.id})).toHaveLength(2)
    expect(f.runTurn).not.toHaveBeenCalled()
  })

  it('rejects a previously successful external write even when the old task is cancelled',async()=>{
    const f=await fixture()
    f.receipt(f.task,'already-completed','succeeded',{result:{approved:true,item:{kind:'tool_result',isError:false,output:{ok:true,status:'succeeded'}}}})
    await expect(f.retry()).rejects.toMatchObject({code:'external_effect_retry_blocked'})
    expect(f.preflight).not.toHaveBeenCalled()
    expect(f.runTurn).not.toHaveBeenCalled()
    expect(f.runtime.taskRepository!.list({threadId:f.thread.id})).toHaveLength(1)
  })

  it('does not mistake prose or a forged resolution for verified unknown-result recovery',async()=>{
    const f=await fixture(),operation=f.receipt(f.task,'unknown-with-prose','outcome_unknown',{result:{approved:true,item:{kind:'tool_result',output:{text:'The task was probably completed.'}}}})
    await expect(f.retry()).rejects.toMatchObject({code:'outcome_unknown'})
    expect(f.runtime.taskRepository!.verifiedOperationResolution(operation)).toBeUndefined()
    expect(f.runTurn).not.toHaveBeenCalled()
  })

  it('keeps a verified successful readback from enabling a second dispatch of that external write',async()=>{
    const f=await fixture(),operation=f.receipt(f.task,'resolved-write','outcome_unknown')
    const evidence={kind:'external_operation' as const,provider:'lark',operation:'complete',target:'task-a',status:'completed',verified:true,verifiedAt:f.runtime.nowIso(),resultHash:'a'.repeat(64)}
    const verification=f.runtime.taskRepository!.beginOperation({ownerId:f.task.id,idempotencyKey:'verified-readback',kind:'effect_verification',request:{originalReceiptId:operation.id,originalFingerprint:operation.fingerprint},nowIso:f.runtime.nowIso()}).receipt
    f.runtime.taskRepository!.finishOperation(f.task.id,'verified-readback',{status:'succeeded',result:{evidence}},f.runtime.nowIso())
    f.runtime.taskRepository!.resolveOperation(f.task.id,'resolved-write',{status:'verified',receiptId:verification.id,evidence,resolvedAt:f.runtime.nowIso()})
    expect(f.runtime.taskRepository!.unsettledOperations(f.task.id)).toHaveLength(0)
    await expect(f.retry()).rejects.toMatchObject({code:'external_effect_retry_blocked'})
    expect(f.runTurn).not.toHaveBeenCalled()
  })

  it('preserves ordinary retry after known successful reads and after a write was explicitly not dispatched',async()=>{
    const f=await fixture()
    f.receipt(f.task,'read-only','succeeded',{toolName:'lark_task_list',operation:'list',result:{approved:true,item:{kind:'tool_result',isError:false,output:{ok:true,status:'succeeded'}}}})
    f.receipt(f.task,'write-blocked-before-dispatch','failed',{result:{approved:false,item:{kind:'tool_result',isError:true,output:{code:'connector_scope_missing'}}}})
    const retried=await f.retry()
    expect(retried.task.id).not.toBe(f.task.id)
    expect(retried.task.retryOfTaskId).toBe(f.task.id)
    expect(f.runTurn).toHaveBeenCalledOnce()
    const repeated=await f.retry(f.task)
    expect(repeated.task.id).toBe(retried.task.id)
    expect(f.runTurn).toHaveBeenCalledOnce()
    expect(f.runtime.taskRepository!.operations(f.task.id,'tool')).toHaveLength(2)
  })

  it('rejects failed write receipts that lack evidence they were never dispatched',async()=>{
    const f=await fixture()
    f.receipt(f.task,'failed-after-approval','failed',{result:{approved:true,item:{kind:'tool_result',isError:true,output:{code:'remote_failed'}}}})
    await expect(f.retry()).rejects.toMatchObject({code:'external_effect_retry_blocked'})
    expect(f.runTurn).not.toHaveBeenCalled()
  })
})
