import { createHash } from 'node:crypto'
import type { TaskCommand, TaskCommandResult } from '../contracts/execution.js'
import { TaskCommandSchema } from '../contracts/execution.js'
import type { TaskRun } from '../contracts/tasks.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { TaskRunRepository } from './task-run-repository.js'
import type { ThreadService } from './thread-service.js'
import type { TurnService } from './turn-service.js'
import type { TaskController } from './task-controller.js'
import type { TaskContextRuntime } from './task-context-runtime.js'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import { WorkspaceReferenceService } from './workspace-reference-service.js'
import { TaskControlService } from './task-control-service.js'

export class TaskCoordinator {
  private readonly pending = new Map<string, Promise<TaskCommandResult>>()
  private flushingMessages = false
  private readonly controls:TaskControlService
  constructor(private readonly deps: { repository: TaskRunRepository; threads: ThreadService; threadStore: ThreadStore; turns: TurnService; tasks: TaskController; controls?:TaskControlService; context?: TaskContextRuntime; attachments?:AttachmentStore; classifyIntent?: (text:string,task:TaskRun) => Promise<'supplement'|'new'|'chat'|'ambiguous'>; runTurn(threadId:string,turnId:string):unknown; nowIso():string }) {this.controls=deps.controls ?? new TaskControlService(deps)}
  async command(raw: TaskCommand): Promise<TaskCommandResult> {
    const command = TaskCommandSchema.parse(raw)
    const queueKey = `${command.threadId}:${command.idempotencyKey}`
    const pending = this.pending.get(queueKey)
    if(pending) { await pending; return this.command(raw) }
    const promise = this.execute(command)
    this.pending.set(queueKey,promise)
    try { return await promise } finally { this.pending.delete(queueKey) }
  }
  private resolveTask(threadId:string, taskId?:string):TaskRun|null {
    if(taskId) return this.deps.repository.currentExecution(taskId)
    return this.deps.repository.findActiveByOrigin(threadId)
  }
  private async execute(command: ReturnType<typeof TaskCommandSchema.parse>): Promise<TaskCommandResult> {
    const origin = await this.deps.threads.get(command.threadId)
    if(!origin) throw Object.assign(new Error('thread not found'),{code:'not_found'})
    const task = this.resolveTask(command.threadId,command.taskId)
    if(task && task.workspaceRoot !== origin.workspace) throw Object.assign(new Error('task belongs to another workspace'),{code:'scope_conflict'})
    const userText = command.request.displayText ?? command.request.prompt
    let intent = command.intent === 'auto' ? classifyTaskInput(userText,Boolean(task)) : command.intent
    if(intent==='status') { const result:TaskCommandResult={kind:'snapshot',task}; await this.recordResult(command,result); return result }
    const resolving = command.resolveAttentionId ? this.deps.repository.attention(command.resolveAttentionId) : null
    if (command.resolveAttentionId && (!resolving || resolving.threadId !== origin.id || resolving.payload?.kind !== 'task_input_intent' || !['supplement','new'].includes(intent))) throw Object.assign(new Error('attention decision does not match this task command'), {code:'scope_conflict'})
    const receipt = this.deps.repository.execution.command(command.threadId,command.idempotencyKey,command)
    if(receipt.result) { const result=receipt.result as TaskCommandResult;await this.recordResult(command,result);return result }
    if (intent === 'ambiguous' && task && this.deps.classifyIntent) {
      try { intent = await this.deps.classifyIntent(userText,task) } catch { /* uncertainty remains a durable human decision */ }
    }
    let result:TaskCommandResult
    if(intent==='ambiguous') {
      const id = `input_intent_${createHash('sha256').update(`${command.threadId}:${command.idempotencyKey}`).digest('hex').slice(0,32)}`
      const now = this.deps.nowIso()
      const message = '请选择补充当前任务或新建任务；当前任务会继续保留。'
      this.deps.repository.putAttention({ id, ownerKind:'task', ownerId:task?.id ?? command.threadId, ...(task?{taskId:task.id}:{}), threadId:command.threadId, kind:'question', title:'确定这条补充的归属', message, status:'pending', revision:0, createdAt:now, updatedAt:now, payload:{ kind:'task_input_intent', commandKey:command.idempotencyKey, text:userText, request:command.request, choices:['supplement','new'] } })
      result={kind:'attention_required',...(task?{task}:{}),message,attentionId:id}
    }
    else if(intent==='pause'||intent==='resume'||intent==='cancel') {
      if(!task)result={kind:'attention_required',message:'没有可操作的任务，请先选择任务。'}
      else {
        const changed=await this.controls.mutate(task.id,intent,{expectedRevision:command.expectedRevision ?? task.revision,idempotencyKey:`command:${command.idempotencyKey}`,model:command.request.model})
        if(intent==='resume') {
          if(!changed.turn)throw new Error('task resume did not create a Turn')
          result={kind:'task_started',task:changed.task,turn:changed.turn}
        } else result={kind:'task_updated',action:intent,task:changed.task}
      }
    }
    else if(intent==='supplement') {
      if(!task) result={kind:'attention_required',message:'没有可接收补充的任务，请选择任务或新建任务。'}
      else {
        await this.validateReferences(command,origin.workspace,task.threadId)
        const saved=this.deps.tasks.appendInput(task.id,command.expectedRevision ?? task.revision,command.idempotencyKey,userText,'supplement',undefined,{attachmentIds:command.request.attachmentIds,workspaceReferences:command.request.workspaceReferences})
        // The durable queue is authoritative; no in-memory steering acknowledgement.
        result={kind:'input_queued',task:saved.task,input:saved.input}
      }
    } else {
      const isTask=intent==='new'
      const suffix=createHash('sha256').update(`${command.threadId}:${command.idempotencyKey}`).digest('hex').slice(0,24)
      const executionThreadId=isTask?`thr_task_${suffix}`:command.threadId
      await this.validateReferences(command,origin.workspace,executionThreadId)
      if(isTask && !await this.deps.threads.get(executionThreadId)) {
        const created=await this.deps.threads.create({workspace:origin.workspace,model:command.request.model ?? origin.model,mode:origin.mode,approvalPolicy:origin.approvalPolicy,sandboxMode:origin.sandboxMode,domain:origin.domain,projectId:origin.projectId},{id:executionThreadId,title:command.request.prompt.slice(0,100)})
        await this.deps.threadStore.upsert({...created,relation:'side',parentThreadId:origin.id,agentId:origin.agentId,agentRevision:origin.agentRevision,agentProfile:origin.agentProfile})
      }
      const turnKey=`command:${command.idempotencyKey}`
      const oldTurn=(await this.deps.threads.get(executionThreadId))?.turns.find(turn=>turn.idempotencyKey===turnKey)
      const turn=await this.deps.turns.startTurn({threadId:executionThreadId,request:{...command.request,idempotencyKey:turnKey,taskIntent:isTask?'new':undefined,taskVisibility:isTask?'task':'chat',...(isTask?{taskOriginThreadId:origin.id}:{})}})
      const linked=this.deps.repository.findByTurn(turn.turnId)
      if (linked && isTask) this.deps.context?.subscribeTask(linked, origin.id)
      result={kind:isTask?'task_started':'chat_started',...(linked&&isTask?{task:linked}:{}),turn}
      if (resolving) this.deps.repository.putAttention({...resolving,status:'answered',revision:resolving.revision+1,updatedAt:this.deps.nowIso()})
      this.deps.repository.execution.finishCommand(command.threadId,command.idempotencyKey,result)
      if(!oldTurn)void this.deps.runTurn(turn.threadId,turn.turnId)
      await this.recordResult(command,result)
      return result
    }
    if (resolving && result.kind !== 'attention_required') this.deps.repository.putAttention({...resolving,status:'answered',revision:resolving.revision+1,updatedAt:this.deps.nowIso()})
    this.deps.repository.execution.finishCommand(command.threadId,command.idempotencyKey,result)
    await this.recordResult(command,result)
    return result
  }

  private async validateReferences(command:ReturnType<typeof TaskCommandSchema.parse>,workspace:string,targetThreadId:string):Promise<void> {
    if(command.request.workspaceReferences?.length) await new WorkspaceReferenceService().validateReferences(workspace,command.request.workspaceReferences)
    for(const id of command.request.attachmentIds ?? []) {
      if(!this.deps.attachments?.grantTaskReference) throw Object.assign(new Error('attachment reference service unavailable'),{code:'scope_conflict'})
      await this.deps.attachments.grantTaskReference(id,{threadId:command.threadId,workspace},{threadId:targetThreadId,workspace})
    }
  }

  private async recordResult(command:ReturnType<typeof TaskCommandSchema.parse>,result:TaskCommandResult):Promise<void> {
    if (result.kind === 'chat_started') return
    const commandId=createHash('sha256').update(`${command.threadId}:${command.idempotencyKey}`).digest('hex').slice(0,32)
    result.receipt={userMessageItemId:`item_command_${commandId}_user`,resultMessageItemId:`item_command_${commandId}_receipt`}
    const assistantText=result.kind==='snapshot' ? result.task ? `${result.task.goal}\n${result.task.waitingReason ?? result.task.stalledReason ?? ({queued:'已接收任务',running:'正在执行',retrying:'正在继续',paused:'已暂停',waiting_user:'等待你补充',waiting_approval:'等待必要授权',completed:'已完成',stalled:'需要处理阻塞',failed:'执行失败',cancelled:'已取消'} as const)[result.task.status]}` : '当前没有进行中的任务。' : result.kind==='input_queued' ? result.task.status==='paused'?'补充已保存，将在你继续任务后送达。':'补充已保存，将送达当前任务。' : result.kind==='task_updated'?result.action==='pause'?'任务已暂停，补充会继续保存。':'任务已取消，已有成果和记录已保留。': result.kind==='attention_required'?result.message:`已接收任务：${result.task?.goal ?? command.request.displayText ?? command.request.prompt}`
    this.deps.repository.enqueueOutbox({id:`command-message:${commandId}`,ownerId:command.threadId,kind:'task_command_message',payload:{threadId:command.threadId,commandId,userText:command.request.displayText ?? command.request.prompt,assistantText,createdAt:this.deps.nowIso()},createdAt:this.deps.nowIso()})
    await this.flushCommandMessages()
  }

  async flushCommandMessages():Promise<void> {
    if(this.flushingMessages) return
    this.flushingMessages=true
    try {
      for(const message of this.deps.repository.pendingOutbox('task_command_message')) {
        await this.deps.turns.recordCommandExchange(message.payload as {threadId:string;commandId:string;userText:string;assistantText:string;createdAt:string})
        this.deps.repository.acknowledgeOutbox(message.id,this.deps.nowIso())
      }
    } finally { this.flushingMessages=false }
  }
}
export function classifyTaskInput(text:string,hasTask:boolean):'status'|'supplement'|'new'|'chat'|'ambiguous'|'pause'|'resume'|'cancel' {
  const value=text.trim()
  if(/^(?:现在)?(?:做到哪(?:里|了)?|进度(?:如何|怎样|怎么样)?|任务状态|目前进展|现在做到哪了)[？?！!。\s]*$|^(?:status|progress|how is (?:it|the task) going)[?!.\s]*$/i.test(value)) return 'status'
  if(/^(?:(?:请|先|现在)\s*)?(?:暂停(?:一下)?(?:当前|这个)?(?:任务)?|pause(?:\s+(?:the\s+)?(?:task|it))?)[？?！!。\s]*$/i.test(value))return 'pause'
  if(/^(?:(?:请|先|现在)\s*)?(?:继续(?:当前|这个)?(?:任务)?|恢复(?:当前|这个)?任务|resume(?:\s+(?:the\s+)?task)?|continue(?:\s+(?:the\s+)?task)?)[？?！!。\s]*$/i.test(value))return 'resume'
  if(/^(?:(?:请|先|现在)\s*)?(?:取消(?:当前|这个)?(?:任务)?|停止(?:当前|这个)?任务|cancel(?:\s+(?:the\s+)?task)?)[？?！!。\s]*$/i.test(value))return 'cancel'
  if(/^(?:新建(?:一个)?任务|另(?:起|开)(?:一个)?任务|独立任务|new task)/i.test(value)) return 'new'
  if(hasTask && /^(?:再(?:加|补)|补充|另外(?:加|补)|继续|请继续|还需要|把.*(?:也|一并)|also |add |continue\b)/i.test(value)) return 'supplement'
  if(!hasTask) return /(?:报告|投标|交付|文档|实现|完成.*计划|调研|research|implement|deliver|report)/i.test(value)?'new':'chat'
  return 'ambiguous'
}
