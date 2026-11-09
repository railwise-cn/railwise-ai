import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,it,expect} from 'vitest'
import type {TaskRun} from '../contracts/tasks.js'
import {TaskRunRepository} from './task-run-repository.js'
import {TaskViewService,taskFeedResponse} from './task-view-service.js'
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
