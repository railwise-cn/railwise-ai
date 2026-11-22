import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,it,expect,vi} from 'vitest'
import type {TaskRun} from '../contracts/tasks.js'
import {TaskRunRepository} from './task-run-repository.js'
import {TaskViewService,taskFeedResponse} from './task-view-service.js'
import { processIdentity } from './process-identity.js'
const roots:string[]=[];const repos:TaskRunRepository[]=[]
afterEach(async()=>{repos.splice(0).forEach(r=>r.close());await Promise.all(roots.splice(0).map(r=>rm(r,{recursive:true,force:true})))})
const task=(id:string):TaskRun=>({id,threadId:`thread-${id}`,childTaskIds:[],workspaceRoot:'/tmp/work',goal:id,status:'running',agentId:'general',budget:{maxAttempts:3,maxDurationMs:60000},attempts:1,replans:0,noProgressCount:0,nodes:[],artifacts:[],acceptance:{kind:'answer',requiredNodeKinds:['deliver'],requireFinalResponse:true,requireActionableArtifactCard:false},createdAt:'2026-11-09T00:00:00Z',updatedAt:'2026-11-09T00:00:00Z',revision:0})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'railwise-task-view-'));roots.push(root);const repo=new TaskRunRepository(join(root,'tasks.sqlite'));repos.push(repo);return repo}
it('fixes members, order and counts for a cursor snapshot while new tasks change the live feed',async()=>{const repo=await fixture();let now=1;const service=new TaskViewService(repo,()=>now);repo.create(task('a'));repo.create(task('b'));const first=service.page({filter:'all',limit:1});expect(first.total).toBe(2);repo.create(task('c'));const second=service.page({filter:'all',limit:1,cursor:first.nextCursor});expect(second.total).toBe(2);expect(new Set([...first.items,...second.items].map(t=>t.id))).toEqual(new Set(['a','b']));expect(service.page({filter:'all'}).total).toBe(3);expect(service.changes(first.eventWatermark).some(e=>e.taskId==='c')).toBe(true);expect(()=>service.page({filter:'all',search:'changed',cursor:first.nextCursor})).toThrow(/filters/);now+=16*60000;expect(()=>service.page({filter:'all',cursor:first.nextCursor})).toThrow(/expired/)})
it('groups roots and children, hides chat records, and replays a global sequence after restart',async()=>{const repo=await fixture();const service=new TaskViewService(repo);repo.create(task('root'));repo.create({...task('child'),parentTaskId:'root',rootTaskId:'root',visibility:'internal'});repo.create({...task('chat'),visibility:'chat'});const page=service.page({filter:'all'});expect(page.items.map(t=>t.id)).toEqual(['root']);expect(page.relatedTasks.map(t=>t.id)).toEqual(['child']);const event=service.changes(0)[0];const abort=new AbortController();const reader=taskFeedResponse(service,new Request('http://localhost/v1/tasks/stream',{headers:{'Last-Event-ID':String(event.seq)},signal:abort.signal})).body!.getReader();const chunk=new TextDecoder().decode((await reader.read()).value);expect(chunk).not.toContain(`id: ${event.seq}\n`);expect(chunk).toContain('task_changed');abort.abort();await reader.cancel()})
it('uses the latest retry status without erasing the failed root or its history',async()=>{
 const repo=await fixture();const service=new TaskViewService(repo)
 repo.create({...task('root'),status:'failed'})
 repo.create({...task('retry'),rootTaskId:'root',retryOfTaskId:'root',status:'completed',createdAt:'2026-11-09T00:01:00Z'})
 expect(service.page({filter:'attention'}).total).toBe(0)
 const page=service.page({filter:'completed'});expect(page.total).toBe(1);expect(page.items[0].id).toBe('root');expect(page.relatedTasks[0].status).toBe('completed')
 expect(repo.get('root')?.status).toBe('failed')
})
it('records queue and human waiting intervals without inventing old history',async()=>{
 const repo=await fixture();let now=Date.parse('2026-11-09T00:00:00Z');const service=new TaskViewService(repo,()=>now)
 repo.create({...task('timed'),status:'queued'})
 now+=1000;repo.update('timed',0,t=>({...t,status:'running',updatedAt:new Date(now).toISOString()}))
 repo.execution.beginWork('model','timed','model',now)
 now+=2000;repo.execution.finishWork('model',now)
 repo.update('timed',1,t=>({...t,status:'waiting_user',updatedAt:new Date(now).toISOString()}))
 now+=4000
 const timing=(service.page({filter:'all'}).items[0] as TaskRun & {timing:{executionMs:number;queuedMs:number;humanWaitMs:number;coverage:string}}).timing
 expect(timing).toMatchObject({executionMs:2000,queuedMs:1000,humanWaitMs:4000,coverage:'complete'})
})

it('projects actual Host work and sampled execution time without changing the task or durable event cursor', async () => {
 const repo=await fixture();const start=Date.parse('2026-11-09T00:00:00Z');vi.useFakeTimers();vi.setSystemTime(start)
 const abort=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
 try {
  const service=new TaskViewService(repo);const owner={...task('working'),activeTurnId:'active-turn'};repo.create(owner)
  const lease=repo.acquireLease(owner.id,'runtime-owner',new Date(start).toISOString(),new Date(start+60000).toISOString())!
  const session=repo.execution.ensureSession(owner,new Date(start).toISOString())
  const token={taskId:owner.id,sessionId:session.id,executionId:'actual-attempt',turnId:'active-turn',ownerId:'runtime-owner',leaseRevision:lease.revision,process:processIdentity()!}
  repo.execution.beginAttempt(token,new Date(start).toISOString());repo.execution.beginWork('actual-tool-work',owner.id,'tool',start,token.executionId)
  const operation=repo.beginOperation({ownerId:owner.id,idempotencyKey:'actual-host-tool',kind:'tool',request:{providerId:'browser-skill',toolName:'browser_get_html',dispatchTracking:'host-v1',executionId:token.executionId,turnId:token.turnId},nowIso:new Date(start).toISOString()})
  repo.finishOperation(owner.id,operation.receipt.idempotencyKey,{status:'running'},new Date(start).toISOString())
  const before=repo.get(owner.id),cursor=service.watermark()
  reader=taskFeedResponse(service,new Request('http://localhost/v1/tasks/stream',{signal:abort.signal})).body!.getReader()
  await reader.read()
  await vi.advanceTimersByTimeAsync(15000)
  let frame=new TextDecoder().decode((await reader.read()).value)
  expect(frame).toContain('event: task_progress')
  if(frame.includes('"executionMs":0'))frame=new TextDecoder().decode((await reader.read()).value)
  const progress=frame.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))).find(event=>event.kind==='task_progress')
  expect(progress.payload).toMatchObject({taskId:owner.id,taskRevision:owner.revision,turnId:token.turnId,activity:{phase:'reading'},timing:{executionMs:15000}})
  expect(frame).not.toContain('id: ')
  expect(repo.get(owner.id)).toEqual(before)
  expect(service.watermark()).toBe(cursor)
 } finally { abort.abort();await reader?.cancel();expect(vi.getTimerCount()).toBe(0);vi.useRealTimers() }
})

it('keeps projection scoped to readable groups and actual current Host/provider/lease identity', async () => {
 const repo=await fixture();let now=Date.parse('2026-11-09T00:00:00Z');const service=new TaskViewService(repo,()=>now)
 repo.create({...task('root'),status:'failed'});repo.create({...task('private-root'),visibility:'internal'})
 const owner={...task('child'),parentTaskId:'root',rootTaskId:'root',visibility:'internal' as const,activeTurnId:'turn-child'};repo.create(owner)
 const hidden={...task('hidden-child'),parentTaskId:'private-root',rootTaskId:'private-root',activeTurnId:'turn-hidden'};repo.create(hidden)
 const hiddenLease=repo.acquireLease(hidden.id,'private-runtime',new Date(now).toISOString(),new Date(now+60000).toISOString())!
 const hiddenSession=repo.execution.ensureSession(hidden,new Date(now).toISOString())
 repo.execution.beginAttempt({taskId:hidden.id,sessionId:hiddenSession.id,executionId:'private-attempt',turnId:hidden.activeTurnId,ownerId:'private-runtime',leaseRevision:hiddenLease.revision,process:processIdentity()!},new Date(now).toISOString())
 const lease=repo.acquireLease(owner.id,'runtime',new Date(now).toISOString(),new Date(now+60000).toISOString())!
 const session=repo.execution.ensureSession(owner,new Date(now).toISOString())
 const token={taskId:owner.id,sessionId:session.id,executionId:'attempt-child',turnId:owner.activeTurnId,ownerId:'runtime',leaseRevision:lease.revision,process:processIdentity()!}
 repo.execution.beginAttempt(token,new Date(now).toISOString())
 const begin=(key:string,providerId:string,toolName:string,turnId=token.turnId)=>{
  repo.beginOperation({ownerId:owner.id,idempotencyKey:key,kind:'tool',request:{providerId,toolName,turnId,executionId:token.executionId,dispatchTracking:'host-v1'},nowIso:new Date(now).toISOString()})
  repo.finishOperation(owner.id,key,{status:'running'},new Date(now).toISOString())
 }
 begin('arbitrary-mcp','mcp:browser-skill','browser_get_html')
 expect(service.progress()).toMatchObject([{taskId:owner.id,activity:{phase:'working'}}])
 expect(JSON.stringify(service.progress())).not.toContain('browser_get_html')
 begin('old-turn','browser-skill','browser_get_html','old-turn')
 expect(service.progress()[0].activity?.phase).toBe('working')
 begin('current-read','browser-skill','browser_get_html')
 expect(service.progress()[0].activity?.phase).toBe('reading')
 repo.connection().prepare("UPDATE task_runs SET data_json=json_set(data_json,'$.visible',json('false')) WHERE id='root'").run()
 expect(service.page({filter:'all'}).items).toEqual([]);expect(service.progress()).toEqual([])
 repo.connection().prepare("UPDATE task_runs SET data_json=json_remove(data_json,'$.visible') WHERE id='root'").run()
 repo.execution.finishAttempt(token.executionId,'completed',new Date(now).toISOString())
 expect(service.progress()[0]).toMatchObject({active:false});expect(service.progress()[0].activity).toBeUndefined()
 now+=61000;repo.acquireLease(owner.id,'new-runtime',new Date(now).toISOString(),new Date(now+60000).toISOString())
 expect(service.progress()).toEqual([])
 expect(repo.get(owner.id)).toEqual(owner)
})


it('serves the same typed approval presentation in a snapshot and replay while retaining exact audit text', async () => {
  const repo = await fixture()
  const service = new TaskViewService(repo)
  const owner = task('approval-owner')
  repo.create(owner)
  const message = 'Technical audit detail: exact command and request fingerprint'
  repo.saveHumanRequest({
    id: 'pending-approval', kind: 'approval', threadId: owner.threadId, turnId: 'turn-1', message,
    payload: { approval: { toolName: 'request_host_shell' } },
    status: 'pending', createdAt: owner.createdAt, updatedAt: owner.updatedAt
  })
  const card = service.page({ filter: 'attention' }).attention[0]
  const replay = service.changes(0).find(item => item.kind === 'attention_changed')?.payload
  expect(card).toEqual(replay)
  expect(card).toMatchObject({ message, presentation: { reason: 'approval_host_shell', scope: 'host', actions: ['approve', 'deny', 'open_thread'] } })
  expect(repo.humanRequest('pending-approval')?.message).toBe(message)
})
