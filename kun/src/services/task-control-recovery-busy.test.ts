import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { TaskControlService } from './task-control-service.js'
import { TaskRunRepository } from './task-run-repository.js'
import { TaskRunSchema } from '../contracts/tasks.js'

const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{while(cleanup.length)await cleanup.pop()!()})
async function fixture(path:'claimed'|'standing-plan',status:'queued'|'running'){
  const root=await mkdtemp(join(tmpdir(),'recovery-busy-boundary-')),repository=new TaskRunRepository(join(root,'tasks.sqlite'))
  cleanup.push(async()=>{repository.connection().close();await rm(root,{recursive:true,force:true})})
  const now='2026-11-15T12:00:00.000Z'
  const task=repository.create(TaskRunSchema.parse({id:'source',threadId:'thread',workspaceRoot:'/workspace',goal:'公开查询并读回原计划',status:path==='claimed'?'stalled':'failed',agentId:'general',childTaskIds:[],
    acceptance:{kind:'answer',requiredNodeKinds:['execute'],requireFinalResponse:true,requireActionableArtifactCard:false},budget:{maxAttempts:8,maxDurationMs:1800000},attempts:1,replans:0,noProgressCount:0,nodes:[],artifacts:[],createdAt:now,updatedAt:now,revision:0}))
  if(path==='standing-plan'){
    // This is only a strictness hint: it cannot authorize a query. The full
    // native/plan proof remains the Runtime test's responsibility.
    repository.beginOperation({ownerId:task.id,idempotencyKey:'existing-plan-link',kind:'browser_public_query_recovery_plan',request:{},nowIso:now})
    repository.finishOperation(task.id,'existing-plan-link',{status:'succeeded'},now)
  }
  const getThread=vi.fn(async()=>({id:'thread',turns:[{id:'settling',status}]}))
  const runTurn=vi.fn(), startTurn=vi.fn()
  const service=new TaskControlService({repository,tasks:{} as never,threads:{get:getThread} as never,turns:{startTurn} as never,runTurn,nowIso:()=>now})
  const request={expectedRevision:0,idempotencyKey:'continue',...(path==='claimed'?{publicQueryRecoveryReceiptId:'prepared-query'}:{})}
  return {repository,service,task,request,getThread,runTurn,startTurn,now}
}
it.each([['claimed','queued'],['claimed','running'],['standing-plan','queued'],['standing-plan','running']] as const)('rejects %s recovery Retry before any writes while its old Turn is %s',async(path,status)=>{
  const f=await fixture(path,status),before=JSON.stringify({task:f.repository.get(f.task.id),receipts:f.repository.operations(f.task.id)})
  const begin=vi.spyOn(f.repository,'beginOperation'),update=vi.spyOn(f.repository,'update')
  await expect(f.service.mutate(f.task.id,'retry',f.request)).rejects.toMatchObject({code:'turn_in_progress'})
  expect(begin).not.toHaveBeenCalled();expect(update).not.toHaveBeenCalled()
  expect(f.repository.list()).toHaveLength(1)
  expect(JSON.stringify({task:f.repository.get(f.task.id),receipts:f.repository.operations(f.task.id)})).toBe(before)
  expect(f.startTurn).not.toHaveBeenCalled();expect(f.runTurn).not.toHaveBeenCalled()
})
it('replays a succeeded Retry response even while a subsequent Turn is busy',async()=>{
  const f=await fixture('standing-plan','running')
  f.repository.beginOperation({ownerId:f.task.id,idempotencyKey:f.request.idempotencyKey,kind:'retry',request:f.request,nowIso:f.now})
  f.repository.finishOperation(f.task.id,f.request.idempotencyKey,{status:'succeeded',result:{task:f.task}},f.now)
  const before=JSON.stringify(f.repository.operations(f.task.id))
  expect(await f.service.mutate(f.task.id,'retry',f.request)).toEqual({task:f.task})
  expect(JSON.stringify(f.repository.operations(f.task.id))).toBe(before)
  expect(f.getThread).not.toHaveBeenCalled();expect(f.startTurn).not.toHaveBeenCalled();expect(f.runTurn).not.toHaveBeenCalled()
})
