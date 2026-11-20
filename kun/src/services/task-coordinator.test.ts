import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { FileThreadStore } from '../adapters/file/file-thread-store.js'
import { FileSessionStore } from '../adapters/file/file-session-store.js'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { PersistentUserInputGate } from '../adapters/persistent-human-gates.js'
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
import type { AttachmentStore } from '../attachments/attachment-store.js'
import { defaultExternalTaskCapability } from './external-task-capability.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async()=>{ for(const close of cleanup.splice(0)) await close() })
async function fixture(persistent = false, nowIso = () => new Date().toISOString()) {
  const root=await mkdtemp(join(tmpdir(),'railwise-coordinator-'))
  const repository=new TaskRunRepository(join(root,'tasks.sqlite3'))
  cleanup.push(async()=>{repository.close();await rm(root,{recursive:true,force:true})})
  const threadStore=persistent ? new FileThreadStore({dataDir:root}) : new InMemoryThreadStore()
  const sessionStore=persistent ? new FileSessionStore({dataDir:root}) : new InMemorySessionStore()
  const bus=new InMemoryEventBus(),ids=new SequentialIdGenerator()
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
  it('runs a due occurrence without adding its internal prompt to the conversation', async () => {
    const f = await fixture()
    const command = { threadId: f.origin.id, intent: 'new' as const, idempotencyKey: 'due', request: { prompt: '按既有计划整理本期资料' } }
    const first = await f.coordinator.command(command, { source: 'scheduled-occurrence' })
    expect(first.kind).toBe('task_started')
    await f.coordinator.command(command, { source: 'scheduled-occurrence' })
    expect(await f.sessionStore.loadItems(f.origin.id)).toEqual([])
    expect(f.runTurn).toHaveBeenCalledOnce()
  })

  it('keeps durable admission owned while a scheduled task is prepared before worker dispatch', async () => {
    let now = '2026-11-17T00:30:00.000Z'
    const f = await fixture(false, () => now)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { entered = resolve })
    const recovered: string[] = []
    f.tasks.startWatchdog({ intervalMs: 60_000, leaseMs: 60_000, onRecoveryNeeded: async tasks => {
      for (const task of tasks) {
        recovered.push(task.id)
        await f.turns.finishTurn({ threadId: task.threadId, turnId: task.activeTurnId!, status: 'aborted' })
        const turn = await f.turns.startTurn({ threadId: task.threadId, continuationTaskId: task.id,
          request: { prompt: 'Continue the persisted task automatically after an application restart.' } })
        f.tasks.beginAttempt(turn.threadId, turn.turnId)
      }
    } })
    const coordinator = new TaskCoordinator({ ...f, nowIso: () => now, runTurn: (threadId, turnId) => f.tasks.beginAttempt(threadId, turnId) })
    const starting = coordinator.command({ threadId: f.origin.id, intent: 'new', idempotencyKey: 'schedule:formal:0830', request: { prompt: '生成独立 HTML 招标汇总。' } }, {
      prepareTask: async task => {
        f.repository.update(task.id, task.revision, current => ({ ...current,
          scheduledBy: { scheduleId: 'formal', dueAt: now } }))
        entered()
        await held
      }
    })
    try {
      await ready
      now = '2026-11-17T00:30:30.000Z'
      await (f.tasks as unknown as { runWatchdogTick(): Promise<void> }).runWatchdogTick()
      expect(recovered).toEqual([])
      expect(f.repository.list()[0]).toMatchObject({ status: 'queued', attempts: 0, scheduledBy: { scheduleId: 'formal' } })
      expect(f.repository.reconcileExpired(now)).toEqual([])
      expect(f.repository.getLease(f.repository.list()[0]!.id)).toBeNull()
      expect(f.repository.getAdmissionLease(f.repository.list()[0]!.id)).toMatchObject({ turnId: f.repository.list()[0]!.activeTurnId })
      release()
      const started = await starting
      expect(started.kind).toBe('task_started')
      const task = f.repository.list()[0]!
      expect(task).toMatchObject({ status: 'running', attempts: 1 })
      expect((await f.threads.get(task.threadId))?.turns).toHaveLength(1)
      expect(f.repository.events(task.id).filter(event => event.kind === 'attempt_started')).toHaveLength(1)
      expect(f.repository.events(task.id).filter(event => event.kind === 'task_auto_recovery')).toHaveLength(0)
    } finally {
      release()
      await starting
      f.tasks.stopWatchdog()
    }
  })

  it('releases only the pending admission when coordinator preparation fails', async () => {
    const f = await fixture()
    await expect(f.coordinator.command({ threadId: f.origin.id, intent: 'new', idempotencyKey: 'failed-preparation',
      request: { prompt: '生成 HTML 报告。' } }, { prepareTask: () => { throw new Error('preparation interrupted') } })).rejects.toThrow('preparation interrupted')
    const task = f.repository.list()[0]!
    expect(task).toMatchObject({ status: 'queued', attempts: 0 })
    expect(f.runTurn).not.toHaveBeenCalled()
    expect(f.repository.getLease(task.id)).toBeNull()
    expect(f.repository.getAdmissionLease(task.id)?.expiresAt).toBe('1970-01-01T00:00:00.000Z')
    expect(f.tasks.reconcileStartup()).toMatchObject([{ id: task.id, status: 'retrying', attempts: 0 }])
  })

  it('keeps dispatched admission owned when only the conversation receipt fails', async () => {
    const f = await fixture()
    const receipt = vi.spyOn(f.coordinator, 'flushCommandMessages').mockRejectedValueOnce(new Error('receipt unavailable'))
    await expect(f.coordinator.command({ threadId: f.origin.id, intent: 'new', idempotencyKey: 'dispatched-receipt',
      request: { prompt: '生成 HTML 报告。' } })).rejects.toThrow('receipt unavailable')
    const task = f.repository.list()[0]!
    expect(f.runTurn).toHaveBeenCalledTimes(1)
    expect(task).toMatchObject({ status: 'queued', attempts: 0 })
    expect(f.repository.getLease(task.id)).toBeNull()
    expect(Date.parse(f.repository.getAdmissionLease(task.id)!.expiresAt)).toBeGreaterThan(Date.now())
    expect(f.repository.reconcileExpired(new Date().toISOString())).toEqual([])
    receipt.mockRestore()
  })

  it.each(['explicit', 'rule'] as const)('projects a %s resume as a short control without repeating the persisted original request', async origin => {
    const f = await fixture(true)
    let ready = false
    const grantTaskReference = vi.fn(async () => undefined)
    const coordinator = new TaskCoordinator({ ...f, nowIso: () => new Date().toISOString(),
      attachments: { grantTaskReference } as unknown as AttachmentStore,
      preflightExternalTask: () => defaultExternalTaskCapability('lark', ready ? { lark: {
        enabled: true, authState: 'installed', executablePath: '/managed/lark-cli', scopes: ['task:task:read', 'task:task:write']
      } } : {}) })
    const prompt = '帮我处理飞书待办，按附件要求汇总。'
    const waiting = await coordinator.command({ threadId: f.origin.id, intent: 'new', idempotencyKey: 'original-goal',
      request: { prompt, attachmentIds: ['original-image'] } })
    if (waiting.kind !== 'capability_required' || !waiting.task) throw new Error('expected preflight waiting task')
    expect(f.runTurn).not.toHaveBeenCalled()
    ready = true
    const command = { threadId: f.origin.id, taskId: waiting.task.id, idempotencyKey: 'resume-control',
      ...(origin === 'explicit' ? { intent: 'resume' as const, resolveAttentionId: waiting.attentionId } : {}),
      request: origin === 'explicit' ? { prompt, displayText: prompt, attachmentIds: ['original-image'] } : { prompt: '继续' } }
    const resumed = await coordinator.command(command)
    expect(resumed).toMatchObject({ kind: 'task_started', task: { id: waiting.task.id, goal: prompt } })
    expect(f.repository.list()).toHaveLength(1)
    expect(f.runTurn).toHaveBeenCalledTimes(1)
    expect((await f.threads.get(f.origin.id))?.turns).toHaveLength(0)
    expect((await f.threads.get(waiting.task.threadId))?.turns).toHaveLength(1)
    expect(f.repository.operation(waiting.task.id, 'command:resume-control')).toMatchObject({ kind: 'resume', status: 'succeeded' })
    expect(f.repository.inputs(waiting.task.id)).toMatchObject([{ kind: 'supplement', sourceId: 'capability-original', text: prompt, attachmentIds: ['original-image'] }])
    expect(f.repository.attention(waiting.attentionId!)?.payload?.request).toMatchObject({ prompt, attachmentIds: ['original-image'] })
    const readHistory = async () => (await readFile(join(f.root, 'threads', f.origin.id, 'messages.jsonl'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line) as { kind: string; text: string; conversationReceiptId?: string })
    const history = await readHistory()
    expect(history.filter(item => item.kind === 'user_message').map(item => item.text)).toEqual([prompt, '继续任务'])
    expect(history.at(-1)).toMatchObject({ kind: 'assistant_text', text: '正在继续任务。', conversationReceiptId: expect.any(String) })
    await coordinator.command(command)
    expect(await readHistory()).toEqual(history)
    expect(f.runTurn).toHaveBeenCalledTimes(1)
    const supplement = '只保留本周待办，负责人和期限按附件原文保留。'
    await coordinator.command({ threadId: f.origin.id, taskId: waiting.task.id, intent: 'supplement', idempotencyKey: 'actual-supplement', request: { prompt: supplement } })
    expect((await readHistory()).filter(item => item.kind === 'user_message').map(item => item.text)).toEqual([prompt, '继续任务', supplement])
    expect(f.repository.inputs(waiting.task.id).at(-1)).toMatchObject({ kind: 'supplement', text: supplement })
  })

  it('admits the original ordinary-chat video request as a durable file and source task', async () => {
    const f = await fixture()
    const prompt = '使用Video ShotCraft技能，帮我做一个视频，介绍一下宁波睿威工程技术有限公司，相关信息你可去官网上查找。 www.railwise.cn'
    const result = await f.coordinator.command({
      threadId: f.origin.id,
      idempotencyKey: 'video-delivery',
      request: { prompt }
    })
    expect(result).toMatchObject({
      kind: 'task_started',
      task: { originThreadId: f.origin.id, acceptance: {
        kind: 'files',
        requiredFormats: ['mp4'],
        requiresWebEvidence: true,
        requiredSourceOrigins: ['https://www.railwise.cn']
      } }
    })
    expect(f.runTurn).toHaveBeenCalledOnce()
  })

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

  it('keeps an unresolved delivery in its original task when the user supplies the platform', async () => {
    const f = await fixture()
    const started = await f.coordinator.command({ threadId: f.origin.id, intent: 'new', idempotencyKey: 'draft', request: { prompt: '生成报告并发送邮件给客户' } })
    if (started.kind !== 'task_started') throw new Error('expected task')
    const task = started.task!
    f.repository.update(task.id, task.revision, current => ({ ...current, status: 'waiting_user', acceptance: { ...current.acceptance, requiresExternalEffects: true } }))
    await f.turns.finishTurn({ threadId: started.turn.threadId, turnId: started.turn.turnId, status: 'completed' })
    const request = { threadId: f.origin.id, idempotencyKey: 'select-provider', request: { prompt: '通过飞书发送邮件' } }
    vi.spyOn(f.repository.execution, 'finishCommand').mockImplementationOnce(() => { throw new Error('simulated interruption after input commit') })
    await expect(f.coordinator.command(request)).rejects.toThrow('simulated interruption')
    const bound = await f.coordinator.command(request)
    expect(bound).toMatchObject({ kind: 'capability_required', task: { id: task.id, acceptance: { kind: 'files', effect: { provider: 'lark', operation: 'send' } } } })
    expect(f.repository.list()).toHaveLength(1)
    expect(f.repository.inputs(task.id)).toHaveLength(1)
    expect(f.runTurn).toHaveBeenCalledTimes(1)
    await f.coordinator.command(request)
    expect(f.repository.inputs(task.id)).toHaveLength(1)
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
    expect(items.at(-1)).toMatchObject({text:expect.stringContaining('不会通过未经验证的 Shell 命令代理平台操作')})
  })

  it('persists dual-provider requests before allocating a Turn, even with an explicit chat hint', async () => {
    const f = await fixture()
    const original = '帮我处理钉钉和飞书待办'
    const command = { threadId:f.origin.id, intent:'chat' as const, idempotencyKey:'both-platforms', request:{prompt:original} }
    const result = await f.coordinator.command(command)
    expect(result.kind).toBe('attention_required')
    if (result.kind !== 'attention_required') throw new Error('expected platform decision')
    expect(f.repository.attention(result.attentionId!)).toMatchObject({
      status:'pending', threadId:f.origin.id,
      payload:{kind:'external_provider_choice',originalText:original,request:{prompt:original},providers:['dingtalk','lark']}
    })
    expect(await f.coordinator.command(command)).toEqual(result)
    expect((await f.threads.get(f.origin.id))?.turns).toHaveLength(0)
    expect(f.repository.list()).toHaveLength(0)
    expect(f.runTurn).not.toHaveBeenCalled()
    expect((await f.sessionStore.loadItems(f.origin.id)).filter(item => item.kind === 'user_message')).toHaveLength(1)
  })

  it('only resolves a dual-provider decision with a new task explicitly naming the selected platform', async () => {
    const f = await fixture()
    const existing = await f.coordinator.command({threadId:f.origin.id,intent:'new',idempotencyKey:'old-task',request:{prompt:'完成研究报告'}})
    if (existing.kind !== 'task_started') throw new Error('expected existing task')
    const result = await f.coordinator.command({threadId:f.origin.id,intent:'supplement',idempotencyKey:'both',request:{prompt:'再帮我处理钉钉和飞书待办'}})
    if (result.kind !== 'attention_required') throw new Error('expected platform decision')
    const selection = {threadId:f.origin.id,taskId:existing.task!.id,intent:'new' as const,resolveAttentionId:result.attentionId,selectedExternalProvider:'lark' as const}
    await expect(f.coordinator.command({...selection,idempotencyKey:'still-both',request:{prompt:'处理钉钉和飞书待办'}})).rejects.toMatchObject({code:'scope_conflict'})
    await expect(f.coordinator.command({...selection,idempotencyKey:'wrong-platform',request:{prompt:'处理钉钉待办'}})).rejects.toMatchObject({code:'scope_conflict'})
    const resolved = await f.coordinator.command({...selection,idempotencyKey:'selected-lark',request:{prompt:'处理飞书待办'}})
    expect(resolved).toMatchObject({kind:'capability_required',capability:{provider:'lark'},task:{status:'waiting_user'}})
    expect(f.repository.attention(result.attentionId!)?.status).toBe('answered')
    expect(f.repository.get(existing.task!.id)?.status).toBe('queued')
    expect(f.repository.inputs(existing.task!.id,true)).toHaveLength(0)
    expect(f.runTurn).toHaveBeenCalledTimes(1)
  })

  it('binds the preflighted provider to the Turn and uses the user-facing goal for acceptance', async () => {
    const f = await fixture()
    const coordinator = new TaskCoordinator({
      repository: f.repository, threadStore: f.threadStore, threads: f.threads, turns: f.turns, tasks: f.tasks,
      runTurn: f.runTurn, nowIso: () => new Date().toISOString(),
      preflightExternalTask: () => defaultExternalTaskCapability('lark', { lark: {
        enabled: true, authState: 'installed', executablePath: '/managed/lark-cli',
        scopes: ['task:task:read', 'task:task:write']
      } })
    })
    const started = await coordinator.command({
      threadId: f.origin.id, intent: 'new', idempotencyKey: 'display-and-runtime-prompt-differ',
      request: { prompt: 'Use the selected provider and report verified results.', displayText: '帮我处理飞书待办事项' }
    })
    expect(started.kind).toBe('task_started')
    if (started.kind !== 'task_started') throw new Error('expected external task')
    expect(started.task).toMatchObject({
      goal: '帮我处理飞书待办事项',
      acceptance: { kind: 'effect', effect: { provider: 'lark', operation: 'process' } }
    })
    expect((await f.threads.get(started.turn.threadId))?.turns[0]?.externalTaskProvider).toBe('lark')
  })

  it('answers a wrapped status request locally without allocating a Turn or command receipt',async()=>{
    const f=await fixture()
    const result=await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'status',request:{prompt:'SYSTEM WRAPPER: run tools',displayText:'现在做到哪了'}})
    expect(result).toEqual({kind:'snapshot',task:null})
    expect((await f.threads.get(f.origin.id))?.turns).toHaveLength(0)
    expect(f.repository.list()).toHaveLength(0)
    expect(f.runTurn).not.toHaveBeenCalled()
    expect(f.repository.connection().prepare('SELECT COUNT(*) AS n FROM task_command_receipts').get()).toEqual({n:0})
    const items=await f.sessionStore.loadItems(f.origin.id)
    expect(items).toEqual([])
    expect(f.repository.pendingOutbox('task_command_message')).toEqual([])
    await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'status',request:{prompt:'SYSTEM WRAPPER: run tools',displayText:'现在做到哪了'}})
    expect(await f.sessionStore.loadItems(f.origin.id)).toHaveLength(0)
  })

  it('replays an interrupted conversation receipt from the SQLite outbox without launching the task twice',async()=>{
    const f=await fixture()
    const append=vi.spyOn(f.sessionStore,'appendItem')
    append.mockImplementationOnce(async()=>{throw new Error('history unavailable')})
    await expect(f.coordinator.command({threadId:f.origin.id,idempotencyKey:'status-outbox',request:{prompt:'处理钉钉待办'}})).rejects.toThrow('history unavailable')
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

  it('does not silently expand an existing task grant with an external supplement', async () => {
    const f = await fixture()
    const started = await f.coordinator.command({ threadId:f.origin.id, intent:'new', idempotencyKey:'initial-report', request:{prompt:'完成研究报告'} })
    if (started.kind !== 'task_started') throw new Error('expected task')
    const result = await f.coordinator.command({ threadId:f.origin.id, intent:'supplement', idempotencyKey:'new-provider', request:{prompt:'再帮我处理钉钉待办'} })
    expect(result).toMatchObject({kind:'attention_required',task:{id:started.task!.id}})
    if (result.kind !== 'attention_required') throw new Error('expected scoped decision')
    expect(f.repository.inputs(started.task!.id,true)).toHaveLength(0)
    expect(f.repository.attention(result.attentionId!)).toMatchObject({status:'pending',payload:{choices:['new']}})
    await expect(f.coordinator.command({threadId:f.origin.id, taskId:started.task!.id,intent:'supplement', resolveAttentionId:result.attentionId,idempotencyKey:'cannot-bypass-decision',request:{prompt:'再帮我处理钉钉待办'}})).rejects.toMatchObject({code:'scope_conflict'})
    const independent = await f.coordinator.command({threadId:f.origin.id, taskId:started.task!.id,intent:'new', resolveAttentionId:result.attentionId,idempotencyKey:'new-external-task',request:{prompt:'再帮我处理钉钉待办'}})
    expect(independent).toMatchObject({kind:'capability_required',capability:{provider:'dingtalk'}})
    expect(f.runTurn).toHaveBeenCalledTimes(1)
  })

  it('uses ordinary conversational input to supplement the only active task', async () => {
    const f = await fixture()
    const started = await f.coordinator.command({ threadId: f.origin.id, intent: 'new', idempotencyKey: 'start', request: { prompt: '完成报告' } })
    const followup = await f.coordinator.command({ threadId: f.origin.id, idempotencyKey: 'followup', request: { prompt: '这里需要调整一下' } })
    expect(followup).toMatchObject({ kind: 'input_queued', task: { id: started.task!.id }, input: { text: '这里需要调整一下' } })
    const running = await f.coordinator.command({ threadId: f.origin.id, idempotencyKey: 'continue', request: { prompt: '继续' } })
    expect(running).toMatchObject({ kind: 'snapshot', task: { id: started.task!.id } })
    expect(f.repository.inbox(f.root)).toEqual([])
    expect(f.runTurn).toHaveBeenCalledOnce()
  })

  it('uses the chat reply to resume a task that ended while waiting for missing information', async () => {
    const f = await fixture()
    const command = { threadId: f.origin.id, idempotencyKey: 'details', request: { prompt: '采用本月的报告周期。' } }
    const started = await f.coordinator.command({ threadId: f.origin.id, intent: 'new', idempotencyKey: 'start', request: { prompt: '完成合成报告' } })
    if (started.kind !== 'task_started') throw new Error('expected task')
    await f.turns.finishTurn({ threadId: started.turn.threadId, turnId: started.turn.turnId, status: 'failed' })
    const task = f.repository.get(started.task!.id)!
    f.repository.update(task.id, task.revision, current => ({ ...current, status: 'waiting_user', waitingReason: '请补充报告周期。' }))

    const followup = await f.coordinator.command(command)
    expect(followup).toMatchObject({ kind: 'input_queued', task: { id: task.id }, input: { text: command.request.prompt } })
    expect(f.repository.get(task.id)).toMatchObject({ status: 'retrying' })
    expect(f.runTurn).toHaveBeenCalledTimes(2)
    await f.coordinator.command(command)
    expect(f.runTurn).toHaveBeenCalledTimes(2)
    expect(f.repository.inputs(task.id, true)).toHaveLength(1)
  })

  it.each([false, true])('routes a plain chat reply only to an open-ended worker question (hasOptions=%s)', async hasOptions => {
    const f = await fixture()
    const userInputGate = new PersistentUserInputGate(f.repository, () => new Date().toISOString())
    const coordinator = new TaskCoordinator({ ...f, userInputGate, nowIso: () => new Date().toISOString() })
    const started = await coordinator.command({ threadId: f.origin.id, intent: 'new', idempotencyKey: 'start', request: { prompt: '完成合成报告' } })
    if (started.kind !== 'task_started') throw new Error('expected task')
    const requestId = 'input-period'
    const answer = userInputGate.request({ id: requestId, itemId: 'item-period', threadId: started.turn.threadId, turnId: started.turn.turnId,
      prompt: '报告采用什么周期？', questions: [{ id: 'period', header: '周期', question: '采用什么周期？',
        options: hasOptions ? [{ label: '月报', description: '' }, { label: '周报', description: '' }] : [] }] })

    const result = await coordinator.command({ threadId: f.origin.id, idempotencyKey: 'answer', request: { prompt: '采用本月。' } })
    expect(result.kind).toBe('input_queued')
    if (hasOptions) {
      expect(f.repository.humanRequest(requestId)?.status).toBe('pending')
      expect(userInputGate.resolve(requestId, { status: 'cancelled' })).toBe(true)
    } else {
      expect(await answer).toEqual({ status: 'submitted', answers: [{ id: 'period', label: '周期', value: '采用本月。' }] })
    }
    expect(f.runTurn).toHaveBeenCalledOnce()
  })

  it('persists ambiguous ownership across multiple active tasks and keeps explicit decisions supported',async()=>{
    const f=await fixture()
    await f.coordinator.command({threadId:f.origin.id,intent:'new',idempotencyKey:'start',request:{prompt:'完成报告'}})
    await f.coordinator.command({threadId:f.origin.id,intent:'new',idempotencyKey:'second',request:{prompt:'校对另一份资料'}})
    expect(await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'cancel',request:{prompt:'取消任务'}})).toMatchObject({kind:'attention_required'})
    expect(f.repository.list().every(task => task.status === 'queued')).toBe(true)
    const ambiguous=await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'unknown',request:{prompt:'这里需要调整一下'}})
    expect(ambiguous.kind).toBe('attention_required')
    if(ambiguous.kind!=='attention_required') throw new Error('expected decision')
    expect(f.repository.attention(ambiguous.attentionId!)).toMatchObject({status:'pending',payload:{choices:['supplement','new']}})
    expect(ambiguous.intentCard).toMatchObject({ threadId: f.origin.id, attentionId: ambiguous.attentionId, request: { prompt: '这里需要调整一下' }, choices: ['supplement', 'new'] })
    const history = await f.sessionStore.loadItems(f.origin.id)
    expect(history.some(item => item.kind === 'assistant_text' && item.intentCard?.attentionId === ambiguous.attentionId)).toBe(true)
    await expect(f.coordinator.command({threadId:f.origin.id,taskId:ambiguous.task!.id,intent:'supplement',resolveAttentionId:ambiguous.attentionId,idempotencyKey:'changed-request',request:{prompt:'不同的请求'}})).rejects.toMatchObject({ code: 'scope_conflict' })
    const result=await f.coordinator.command({threadId:f.origin.id,taskId:ambiguous.task!.id,intent:'supplement',resolveAttentionId:ambiguous.attentionId,idempotencyKey:'resolved',request:{prompt:'这里需要调整一下'}})
    expect(result.kind).toBe('input_queued')
    expect(f.repository.attention(ambiguous.attentionId!)?.status).toBe('answered')
    await expect(f.coordinator.command({threadId:f.origin.id,taskId:ambiguous.task!.id,intent:'new',resolveAttentionId:ambiguous.attentionId,idempotencyKey:'second-choice',request:{prompt:'这里需要调整一下'}})).rejects.toMatchObject({ code: 'stale_request' })
    expect((await f.coordinator.command({threadId:f.origin.id,taskId:ambiguous.task!.id,intent:'supplement',resolveAttentionId:ambiguous.attentionId,idempotencyKey:'resolved',request:{prompt:'这里需要调整一下'}})).kind).toBe('input_queued')
  })

  it('accepts follow-up commands addressed to the active execution thread', async () => {
    const f = await fixture()
    const started = await f.coordinator.command({
      threadId: f.origin.id, intent: 'new', idempotencyKey: 'root-task', request: { prompt: '完成研究报告' }
    })
    if (started.kind !== 'task_started') throw new Error('expected task')

    const followup = await f.coordinator.command({
      threadId: started.turn.threadId, idempotencyKey: 'execution-followup', request: { prompt: '再补充风险分析' }
    })
    expect(followup).toMatchObject({ kind: 'input_queued', task: { id: started.task!.id } })
    expect(f.repository.inputs(started.task!.id, true)).toHaveLength(1)
    expect(f.runTurn).toHaveBeenCalledTimes(1)
  })
})


describe('Windows browser-to-HTML task regression', () => {
  const request = '使用broswer-skill，帮我去政采云、阳光采购平台等平台去获取一些招标信息，我们主要是做工程测量、工程监测类的业务，所以需要找的是这一类招标信息，并以html形式将获取到的信息给我汇报，每天执行两次，早上九点前一次，下午五点前一次。'
  it('creates a stable delivery task with HTML and recurring acceptance from the original Chinese request', async () => {
    const f = await fixture()
    const result = await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'original-windows-request',request:{prompt:request}})
    expect(result).toMatchObject({kind:'task_started',task:{goal:request,acceptance:{kind:'files',requiredFormats:['html','htm'],schedule:{kind:'daily',times:['09:00','17:00'],leadMinutes:30}}}})
    expect(result.task?.originThreadId).toBe(f.origin.id)
    expect(result.task?.threadId).not.toBe(f.origin.id)
  })
  it('persists image-only input in the paused original task using attachment metadata', async () => {
    const f = await fixture()
    const started = await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'start-image-task',request:{prompt:'生成一份HTML报告'}})
    if (started.kind !== 'task_started') throw new Error('expected task')
    await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'pause-image-task',request:{prompt:'暂停'}})
    const grantTaskReference = vi.fn()
    const coordinator = new TaskCoordinator({...f,nowIso:()=>new Date().toISOString(),attachments:{grantTaskReference} as unknown as AttachmentStore})
    const result = await coordinator.command({threadId:f.origin.id,idempotencyKey:'image-followup',request:{prompt:'请根据已附加的图片继续处理。',displayText:'已附加图片',attachmentIds:['screenshot-1']}})
    expect(result).toMatchObject({kind:'input_queued',task:{id:started.task!.id,status:'paused'},input:{attachmentIds:['screenshot-1']}})
    expect(grantTaskReference).toHaveBeenCalledOnce()
    expect(f.runTurn).toHaveBeenCalledTimes(1)
  })
  it('projects only persisted approval-linked history as a control while retaining the original transcript', async () => {
    const f = await fixture()
    const started = await f.coordinator.command({threadId:f.origin.id,idempotencyKey:'approval-task',request:{prompt:'生成HTML报告'}})
    if (started.kind !== 'task_started') throw new Error('expected task')
    const task = started.task!, now = new Date().toISOString()
    const approval = {id:'reviewed-command',threadId:task.threadId,turnId:started.turn.turnId,toolName:'request_host_shell',summary:'reviewed scope',status:'pending' as const,createdAt:now}
    f.repository.saveHumanRequest({id:approval.id,threadId:task.threadId,turnId:approval.turnId,kind:'approval',message:approval.summary,payload:{approval},status:'pending',createdAt:now,updatedAt:now})
    f.repository.resolveHumanRequest(approval.id,{decision:'allow'},'answered',now)
    const input = f.repository.inputs(task.id).find(input=>input.sourceId===approval.id)!
    expect(input.kind).toBe('approval_resolution')
    expect(f.tasks.approvalForInput(input)).toMatchObject({status:'allowed'})
    const session = f.repository.execution.sessionForTask(task.id)!
    const delivery = f.repository.execution.enqueue(input.id,task.id,session.id)
    const legacy = makeUserItem({id:delivery.messageItemId,threadId:task.threadId,turnId:approval.turnId,text:input.text})
    await f.sessionStore.appendItem(task.threadId,legacy)
    expect(f.tasks.projectApprovalHistory(task.threadId,[legacy])).toMatchObject([{kind:'approval',role:'system',summary:'已允许本次操作',sourceRequestId:approval.id}])
    expect(f.tasks.projectApprovalHistory(task.threadId,[legacy])[0]).not.toHaveProperty('text')
    expect((await f.sessionStore.loadItems(task.threadId)).at(-1)).toMatchObject({kind:'user_message',text:input.text})
  })
})
