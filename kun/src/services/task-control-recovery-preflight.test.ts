import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskRunSchema } from '../contracts/tasks.js'
import { TaskControlService } from './task-control-service.js'
import { TaskRunRepository } from './task-run-repository.js'

const dispose:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{while(dispose.length)await dispose.pop()!()})
async function fixture(action:'resume'|'retry'){
  const root=await mkdtemp(join(tmpdir(),'recovery-admission-')),repository=new TaskRunRepository(join(root,'tasks.sqlite3'))
  dispose.push(async()=>{repository.close();await rm(root,{recursive:true,force:true})})
  const now='2026-11-16T01:00:00.000Z'
  const task=repository.create(TaskRunSchema.parse({id:'scheduled-retry',threadId:'execution-thread',originThreadId:'origin',workspaceRoot:root,
    goal:'继续同一公开检索计划',status:action==='resume'?'waiting_user':'failed',agentId:'general',childTaskIds:[],
    acceptance:{kind:'answer',requiredNodeKinds:['execute'],requireFinalResponse:true,requireActionableArtifactCard:false},
    budget:{maxAttempts:8,maxDurationMs:1800000},attempts:0,replans:0,noProgressCount:0,nodes:[],artifacts:[],createdAt:now,updatedAt:now,revision:0}))
  const error=Object.assign(new Error('公开查询恢复范围已变化。'),{code:'browser_public_query_recovery_changed'})
  const validateRecoveryExecution=vi.fn(async()=>{throw error}),startTurn=vi.fn(async()=>{throw new Error('Unexpected Turn admission')}),runTurn=vi.fn()
  const createRetryTask=vi.fn(()=>{throw new Error('Unexpected child creation')})
  const service=new TaskControlService({repository,tasks:{taskInputs:()=>[],prepareResume:()=>task,restorePreparedResume:()=>{},retryHistory:()=>'',createRetryTask} as never,
    threads:{get:async()=>({id:task.threadId,turns:[]})} as never,preflightExternalTask:async()=>null,
    turns:{startTurn} as never,runTurn,validateRecoveryExecution,nowIso:()=>now})
  return {repository,task,error,service,startTurn,runTurn,validateRecoveryExecution}
}
it('returns one concrete resume blocker before a Turn, attempt or model, without changing task counters',async()=>{
  const f=await fixture('resume'),request={expectedRevision:f.task.revision,idempotencyKey:'one-continue'}
  const before=JSON.stringify(f.repository.get(f.task.id))
  expect(await f.service.mutate(f.task.id,'resume',request)).toMatchObject({task:{id:f.task.id,status:'waiting_user',attempts:0},
    capability:{provider:'browser-skill',errorCode:f.error.code,message:f.error.message,resolution:{route:'task/public-query-recovery'}}})
  await f.service.mutate(f.task.id,'resume',request)
  await f.service.mutate(f.task.id,'resume',{...request,idempotencyKey:'fresh-recheck'})
  expect(JSON.stringify(f.repository.get(f.task.id))).toBe(before)
  expect(f.repository.inbox()).toHaveLength(1)
  expect(f.repository.execution.attempts(f.task.id)).toHaveLength(0)
  expect(f.startTurn).not.toHaveBeenCalled();expect(f.runTurn).not.toHaveBeenCalled()
})
it('rejects a retry recovery error before creating any child, control receipt, Turn or attempt',async()=>{
  const f=await fixture('retry'),before=JSON.stringify(f.repository.list())
  await expect(f.service.mutate(f.task.id,'retry',{expectedRevision:f.task.revision,idempotencyKey:'one-retry'})).rejects.toMatchObject({code:f.error.code,message:f.error.message})
  expect(JSON.stringify(f.repository.list())).toBe(before)
  expect(f.repository.operations(f.task.id)).toHaveLength(0)
  expect(f.repository.execution.attempts(f.task.id)).toHaveLength(0)
  expect(f.startTurn).not.toHaveBeenCalled();expect(f.runTurn).not.toHaveBeenCalled()
})
