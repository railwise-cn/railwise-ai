import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { OperationReceipt, TaskRun } from '../src/contracts/tasks.js'
import { TaskControlService } from '../src/services/task-control-service.js'

const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{while(cleanup.length)await cleanup.pop()!()})

async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'railwise-retry-ledger-')))
  cleanup.push(()=>rm(root,{recursive:true,force:true}))
  const runtime=await createKunServeRuntime({host:'127.0.0.1',port:0,dataDir:join(root,'state'),runtimeToken:'fixture',apiKey:'',baseUrl:'http://127.0.0.1:9',model:'fixture',approvalPolicy:'auto',sandboxMode:'workspace-write',tokenEconomyMode:false,insecure:false,storage:{backend:'file'},capabilities:KunCapabilitiesConfig.parse({})})
  cleanup.push(async()=>runtime.shutdown?.())
  const thread=await runtime.threadService.create({workspace:root,model:'fixture',mode:'agent'})
  const started=await runtime.turnService.startTurn({threadId:thread.id,request:{prompt:'执行本地合成资料检查并交付结果。',taskIntent:'new',taskVisibility:'task'}})
  const task=runtime.taskRepository!.findByTurn(started.turnId)!
  runtime.taskController!.cancelTask(task.id,task.revision,'synthetic cancellation after operation')
  await runtime.turnService.finishTurn({threadId:thread.id,turnId:started.turnId,status:'aborted'})
  const runTurn=vi.fn(),preflight=vi.fn(async()=>null)
  const controls=new TaskControlService({repository:runtime.taskRepository!,tasks:runtime.taskController!,threads:runtime.threadService,turns:runtime.turnService,runTurn,preflightExternalTask:preflight,nowIso:runtime.nowIso})
  const receipt=(owner:TaskRun,key:string,status:OperationReceipt['status'],input?:{kind?:string;toolName?:string;operation?:string;result?:unknown})=>{
    const kind=input?.kind??'tool',toolName=input?.toolName??'lark_task_complete',operation=input?.operation??'complete'
    const saved=runtime.taskRepository!.beginOperation({ownerId:owner.id,idempotencyKey:key,kind,request:{provider:'lark',providerId:'lark-cli',toolName,operation,target:'task-a'},nowIso:runtime.nowIso()}).receipt
    if(status!=='prepared')return runtime.taskRepository!.finishOperation(owner.id,key,{status,...(input?.result?{result:input.result}:{})},runtime.nowIso())
    return saved
  }
  const retry=(target=task,key='retry-once')=>controls.mutate(target.id,'retry',{expectedRevision:runtime.taskRepository!.get(target.id)!.revision,idempotencyKey:key})
  return {root,runtime,thread,task,controls,runTurn,preflight,receipt,retry}
}

describe('whole-task retries retain the original operation ledger safety',()=>{
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
