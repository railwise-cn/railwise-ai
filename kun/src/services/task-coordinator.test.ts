import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { RuntimeEventRecorder } from './runtime-event-recorder.js'
import { ThreadService } from './thread-service.js'
import { TurnService } from './turn-service.js'
import { TaskController } from './task-controller.js'
import { TaskCoordinator, classifyTaskInput } from './task-coordinator.js'
import { TaskRunRepository } from './task-run-repository.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { makeUserItem } from '../domain/item.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async()=>{ for(const close of cleanup.splice(0)) await close() })
async function fixture() {
  const root=await mkdtemp(join(tmpdir(),'railwise-coordinator-'))
  const repository=new TaskRunRepository(join(root,'tasks.sqlite3'))
  cleanup.push(async()=>{repository.close();await rm(root,{recursive:true,force:true})})
  const threadStore=new InMemoryThreadStore(), sessionStore=new InMemorySessionStore(), bus=new InMemoryEventBus(),ids=new SequentialIdGenerator()
  const nowIso=()=>new Date().toISOString()
  const events=new RuntimeEventRecorder({eventBus:bus,sessionStore,allocateSeq:id=>bus.allocateSeq(id),nowIso})
  const threads=new ThreadService({threadStore,sessionStore,events,ids,nowIso})
  const tasks=new TaskController({repository,threadStore,sessionStore,nowIso})
  const turns=new TurnService({threadStore,sessionStore,events,ids,nowIso,inflight:new InflightTracker(),steering:new SteeringQueue(),compactor:new ContextCompactor(),tasks})
  const runTurn=vi.fn()
  const coordinator=new TaskCoordinator({repository,threadStore,threads,turns,tasks,runTurn,nowIso})
  const origin=await threads.create({workspace:root,model:'fixture',mode:'agent'})
  return {root,repository,threadStore,sessionStore,threads,tasks,turns,runTurn,coordinator,origin}
}

describe('task commands before Turn allocation',()=>{
  it('routes pause, continue and cancel deterministically without a classification request',async()=>{
    expect(classifyTaskInput('先暂停',true)).toBe('pause')
    expect(classifyTaskInput('继续',true)).toBe('resume')
    expect(classifyTaskInput('取消任务',true)).toBe('cancel')
    expect(classifyTaskInput('继续补充风险分析',true)).toBe('supplement')
    const f=await fixture()
    const start=await f.coordinator.command({threadId:f.origin.id,intent:'new',idempotencyKey:'start',request:{prompt:'完成报告'}})
    if(start.kind!=='task_started')throw new Error('expected task')
    const pause=await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'pause',request:{prompt:'先暂停'}})
    expect(pause).toMatchObject({kind:'task_updated',action:'pause',task:{id:start.task!.id,status:'paused'}})
    expect((await f.threads.get(start.turn.threadId))?.turns).toHaveLength(1)
    expect(f.runTurn).toHaveBeenCalledTimes(1)
    const supplement=await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'paused-input',request:{prompt:'再补充风险分析'}})
    expect(supplement).toMatchObject({kind:'input_queued',task:{status:'paused'}})
    const continued=await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'resume',request:{prompt:'继续'}})
    expect(continued).toMatchObject({kind:'task_started',task:{id:start.task!.id}})
    expect((await f.threads.get(start.turn.threadId))?.turns).toHaveLength(2)
    expect(f.runTurn).toHaveBeenCalledTimes(2)
    expect(f.repository.inputs(start.task!.id,true)).toHaveLength(1)
    const cancel=await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'cancel',request:{prompt:'取消任务'}})
    expect(cancel).toMatchObject({kind:'task_updated',action:'cancel',task:{id:start.task!.id,status:'cancelled'}})
    const replay=await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'cancel',request:{prompt:'取消任务'}})
    expect(replay).toEqual(cancel)
    expect(f.runTurn).toHaveBeenCalledTimes(2)
    expect((await f.threads.get(start.turn.threadId))?.turns).toHaveLength(2)
  })

  it('routes connect requests and how-to questions before model allocation',()=>{
    expect(classifyTaskInput('连接飞书',false)).toBe('new')
    expect(classifyTaskInput('如何使用钉钉审批',false)).toBe('chat')
    expect(classifyTaskInput('帮我处理飞书待办',true)).toBe('new')
  })

  it('preflights external work before allocating a model turn', async()=>{
    const f=await fixture()
    const result=await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'dingtalk',request:{prompt:'处理钉钉里的待办事项'}})
    expect(result).toMatchObject({kind:'capability_required',message:expect.stringContaining('钉钉连接器'),capability:{provider:'dingtalk',status:'unsupported'}})
    expect((await f.threads.get(f.origin.id))?.turns).toHaveLength(0)
    expect(f.runTurn).not.toHaveBeenCalled()
    expect(f.repository.list()).toHaveLength(1)
    expect(result).toMatchObject({task:{status:'waiting_user',attempts:0}})
    const waiting=f.repository.list()[0]!
    expect(waiting.activeTurnId).toBeUndefined()
    expect(f.repository.attention(`capability_${waiting.id}`)).toMatchObject({status:'pending'})
    const repeat=await f.coordinator.command({threadId:f.origin.id,taskId:waiting.id,intent:'resume',idempotencyKey:'retry-blocked',request:{prompt:'继续'}})
    expect(repeat.kind).toBe('capability_required')
    expect(f.runTurn).not.toHaveBeenCalled()
    const items=await f.sessionStore.loadItems(f.origin.id)
    expect(items.at(-1)).toMatchObject({text:expect.stringContaining('不会生成未经验证的 dws 命令')})
  })

  it('answers a wrapped status request locally without allocating a Turn or command receipt',async()=>{
    const f=await fixture()
    const result=await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'status',request:{prompt:'SYSTEM WRAPPER: run tools',displayText:'现在做到哪了'}})
    expect(result).toMatchObject({kind:'snapshot',task:null,receipt:{userMessageItemId:expect.any(String),resultMessageItemId:expect.any(String)}})
    expect((await f.threads.get(f.origin.id))?.turns).toHaveLength(0)
    expect(f.repository.list()).toHaveLength(0)
    expect(f.runTurn).not.toHaveBeenCalled()
    expect(f.repository.connection().prepare('SELECT COUNT(*) AS n FROM task_command_receipts').get()).toEqual({n:0})
    const items=await f.sessionStore.loadItems(f.origin.id)
    expect(items.map(item=>item.id)).toEqual([result.receipt!.userMessageItemId,result.receipt!.resultMessageItemId])
    await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'status',request:{prompt:'SYSTEM WRAPPER: run tools',displayText:'现在做到哪了'}})
    expect(await f.sessionStore.loadItems(f.origin.id)).toHaveLength(2)
  })

  it('replays an interrupted conversation receipt from the SQLite outbox without launching the task twice',async()=>{
    const f=await fixture()
    const append=vi.spyOn(f.sessionStore,'appendItem')
    append.mockImplementationOnce(async()=>{throw new Error('history unavailable')})
    await expect(f.coordinator.command({threadId:f.origin.id,idempotencyKey:'status-outbox',request:{prompt:'任务状态'}})).rejects.toThrow('history unavailable')
    expect(f.repository.pendingOutbox('task_command_message')).toHaveLength(1)
    append.mockRestore()
    await f.coordinator.flushCommandMessages()
    expect(await f.sessionStore.loadItems(f.origin.id)).toHaveLength(2)
    expect(f.repository.pendingOutbox('task_command_message')).toHaveLength(0)
    expect((await f.threads.get(f.origin.id))?.turns).toHaveLength(0)
    expect(f.runTurn).not.toHaveBeenCalled()
  })

  it('starts independent hidden tasks, preserves the old task and inherits only the selected policy',async()=>{
    const f=await fixture()
    const profile={id:'writer',name:'写作',role:'writer',color:'blue',systemPrompt:'Use only the supplied project evidence.',toolAllowlist:['read','write'],mcpAllowlist:[],trustLevel:'workspace-write' as const,budget:{maxAttempts:3,maxDurationMs:60_000},revision:1}
    await f.threadStore.upsert({...f.origin,agentId:profile.id,agentRevision:1,agentProfile:profile})
    await f.sessionStore.appendItem(f.origin.id,makeUserItem({id:'private-parent',threadId:f.origin.id,turnId:'old',text:'private unrelated conversation'}))
    const first=await f.coordinator.command({threadId:f.origin.id,intent:'new',idempotencyKey:'first',request:{prompt:'完成研究报告'}})
    const second=await f.coordinator.command({threadId:f.origin.id,intent:'new',idempotencyKey:'second',request:{prompt:'完成另一份报告'}})
    expect(first.kind).toBe('task_started'); expect(second.kind).toBe('task_started')
    if(first.kind!=='task_started'||second.kind!=='task_started') throw new Error('expected tasks')
    expect(first.turn.threadId).not.toBe(second.turn.threadId)
    expect(f.repository.get(first.task!.id)?.status).toBe('queued')
    expect((await f.threads.get(first.turn.threadId))).toMatchObject({relation:'side',parentThreadId:f.origin.id,agentProfile:profile})
    expect((await f.sessionStore.loadItems(first.turn.threadId)).some(item=>item.id==='private-parent')).toBe(false)
    expect(await f.threads.list()).toHaveLength(1)
    const replay=await f.coordinator.command({threadId:f.origin.id,intent:'new',idempotencyKey:'first',request:{prompt:'完成研究报告'}})
    expect(replay).toEqual(first); expect(f.runTurn).toHaveBeenCalledTimes(2)
    await expect(f.coordinator.command({threadId:f.origin.id,intent:'new',idempotencyKey:'first',request:{prompt:'different'}})).rejects.toMatchObject({code:'idempotency_conflict'})
  })

  it('recovers a lost command result after the task completed without starting the completed Turn again',async()=>{
    const f=await fixture()
    const command={threadId:f.origin.id,intent:'new' as const,idempotencyKey:'lost-result',request:{prompt:'完成研究报告'}}
    const started=await f.coordinator.command(command)
    if(started.kind!=='task_started')throw new Error('expected task')
    await f.turns.finishTurn({threadId:started.turn.threadId,turnId:started.turn.turnId,status:'completed'})
    const task=f.repository.get(started.task!.id)!
    f.repository.update(task.id,task.revision,current=>({...current,status:'completed'}))
    f.repository.connection().prepare('UPDATE task_command_receipts SET result_json=NULL WHERE owner_id=? AND command_key=?').run(f.origin.id,command.idempotencyKey)
    const replay=await f.coordinator.command(command)
    expect(replay).toMatchObject({kind:'task_started',task:{id:task.id,status:'completed'},turn:started.turn})
    expect(f.runTurn).toHaveBeenCalledTimes(1)
    expect((await f.threads.get(started.turn.threadId))?.turns).toHaveLength(1)
  })

  it('persists a paused supplement without waking or acknowledging the worker',async()=>{
    const f=await fixture()
    const start=await f.coordinator.command({threadId:f.origin.id,intent:'new',idempotencyKey:'start',request:{prompt:'完成报告'}})
    if(start.kind!=='task_started') throw new Error('expected task')
    const paused=f.tasks.pauseTask(start.task!.id,start.task!.revision)
    const before=f.runTurn.mock.calls.length
    const result=await f.coordinator.command({threadId:f.origin.id,taskId:paused.id,expectedRevision:paused.revision,idempotencyKey:'supplement',request:{prompt:'wrapper',displayText:'再加一章风险分析'}})
    expect(result).toMatchObject({kind:'input_queued',task:{status:'paused'},input:{text:'再加一章风险分析'}})
    expect(f.repository.inputs(paused.id,true)).toHaveLength(1)
    expect(f.runTurn).toHaveBeenCalledTimes(before)
    const deliveries=f.repository.execution.pending(f.repository.execution.sessionForTask(paused.id)!.id)
    expect(deliveries).toHaveLength(1); expect(deliveries[0]?.status).toBe('queued')
  })

  it('persists ambiguous ownership and resolves it only after an explicit successful decision',async()=>{
    const f=await fixture()
    await f.coordinator.command({threadId:f.origin.id,intent:'new',idempotencyKey:'start',request:{prompt:'完成报告'}})
    const ambiguous=await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'unknown',request:{prompt:'这里需要调整一下'}})
    expect(ambiguous.kind).toBe('attention_required')
    if(ambiguous.kind!=='attention_required') throw new Error('expected decision')
    expect(f.repository.attention(ambiguous.attentionId!)).toMatchObject({status:'pending',payload:{choices:['supplement','new']}})
    const result=await f.coordinator.command({threadId:f.origin.id,taskId:ambiguous.task!.id,intent:'supplement',resolveAttentionId:ambiguous.attentionId,idempotencyKey:'resolved',request:{prompt:'这里需要调整一下'}})
    expect(result.kind).toBe('input_queued')
    expect(f.repository.attention(ambiguous.attentionId!)?.status).toBe('answered')
  })
})
