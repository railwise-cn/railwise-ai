import { createHash } from 'node:crypto'
import type { TaskCommand, TaskCommandResult } from '../contracts/execution.js'
import { TaskCommandSchema } from '../contracts/execution.js'
import type { TaskRun } from '../contracts/tasks.js'
import type { ThreadRecord } from '../contracts/threads.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { TaskRunRepository } from './task-run-repository.js'
import { operationFingerprint } from './task-run-repository.js'
import { StartTurnRequest } from '../contracts/turns.js'
import type { ThreadService } from './thread-service.js'
import type { TurnService } from './turn-service.js'
import type { TaskController } from './task-controller.js'
import type { TaskContextRuntime } from './task-context-runtime.js'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import { WorkspaceReferenceService } from './workspace-reference-service.js'
import { TaskControlService } from './task-control-service.js'
import { preflightExternalTask, externalTaskIntent, externalProviderAmbiguity, type ExternalTaskPreflight } from './external-task-capability.js'
import { externalPreflightThreadContext } from './contextual-external-task-preflight.js'
import { explicitWorkspaceWrite } from './workspace-write-preflight.js'
import { promptRequiresFileDeliverable } from '../loop/turn-completion-guard.js'

export type TaskCommandDispatchOptions = {
  /** Server-only preparation of a durable recurrence context before capability admission. */
  prepareExecutionThread?: (thread: ThreadRecord) => Promise<void>
  /** Internal integration hook. Persist source linkage and outbox before any worker dispatch. */
  prepareTask?: (task: TaskRun) => Promise<void> | void
}

export class TaskCoordinator {
  private readonly pending = new Map<string, Promise<TaskCommandResult>>()
  private flushingMessages?: Promise<void>
  private readonly controls:TaskControlService
  constructor(private readonly deps: { repository: TaskRunRepository; threads: ThreadService; threadStore: ThreadStore; turns: TurnService; tasks: TaskController; controls?:TaskControlService; context?: TaskContextRuntime; attachments?:AttachmentStore; classifyIntent?: (text:string,task:TaskRun) => Promise<'supplement'|'new'|'chat'|'ambiguous'>; preflightExternalTask?: ExternalTaskPreflight; runTurn(threadId:string,turnId:string):unknown; nowIso():string }) {this.controls=deps.controls ?? new TaskControlService(deps)}
  async command(raw: TaskCommand, options: TaskCommandDispatchOptions = {}): Promise<TaskCommandResult> {
    const command = TaskCommandSchema.parse(raw)
    const queueKey = `${command.threadId}:${command.idempotencyKey}`
    const pending = this.pending.get(queueKey)
    if(pending) { await pending; return this.command(raw, options) }
    const promise = this.execute(command, options)
    this.pending.set(queueKey,promise)
    try { return await promise } finally { this.pending.delete(queueKey) }
  }
  private resolveTask(threadId:string, taskId?:string):TaskRun|null {
    if(taskId) return this.deps.repository.currentExecution(taskId)
    return this.deps.repository.findActiveByOrigin(threadId) ?? this.deps.repository.findActiveByThread(threadId)
  }
  private async execute(command: ReturnType<typeof TaskCommandSchema.parse>, options: TaskCommandDispatchOptions): Promise<TaskCommandResult> {
    const origin = await this.deps.threads.get(command.threadId)
    if(!origin) throw Object.assign(new Error('thread not found'),{code:'not_found'})
    const task = this.resolveTask(command.threadId,command.taskId)
    if(task && task.workspaceRoot !== origin.workspace) throw Object.assign(new Error('task belongs to another workspace'),{code:'scope_conflict'})
    const attachmentLabel = /^(?:已附加图片|attached images?)[。.!！\s]*$/i.test(command.request.displayText?.trim() ?? '')
    const userText = attachmentLabel && command.request.attachmentIds?.length ? command.request.prompt : command.request.displayText ?? command.request.prompt
    let intent = command.intent === 'auto' ? classifyTaskInput(userText,Boolean(task)) : command.intent
    if (command.intent === 'auto' && task && command.request.attachmentIds?.length &&
      /^(?:请根据已附加的图片继续处理[。.!！]?|已附加图片|attached images?)[。.!！\s]*$/i.test(userText.trim())) intent = 'supplement'
    if (command.intent === 'auto' && task?.acceptance.requiresExternalEffects && (!task.acceptance.effect || this.deps.repository.inputs(task.id).some(input => input.sourceId === 'provider-selection' && input.idempotencyKey === command.idempotencyKey)) &&
      ['waiting_user', 'paused', 'stalled'].includes(task.status) && /^(?:请)?(?:使用|用|通过|在).*(?:钉钉|飞书|dingtalk|lark|feishu)/i.test(userText)) intent = 'supplement'
    // An explicit chat hint cannot bypass provider admission for an action.
    if (intent === 'chat' && (externalTaskIntent(userText) || explicitWorkspaceWrite(userText))) intent = 'new'
    if(intent==='status') return {kind:'snapshot',task}
    const resolving = command.resolveAttentionId ? this.deps.repository.attention(command.resolveAttentionId) : null
    if (command.resolveAttentionId && (!resolving || resolving.threadId !== origin.id ||
      !(resolving.payload?.kind === 'task_input_intent' && ['supplement','new'].includes(intent) &&
          (!Array.isArray(resolving.payload.choices) || resolving.payload.choices.includes(intent)) ||
        resolving.payload?.kind === 'external_provider_choice' && intent === 'new' && command.selectedExternalProvider && !externalProviderAmbiguity(userText) && externalTaskIntent(userText)?.provider === command.selectedExternalProvider ||
        resolving.payload?.kind === 'capability_required' && intent === 'resume' && resolving.taskId === task?.id))) {
      throw Object.assign(new Error('attention decision does not match this task command'), {code:'scope_conflict'})
    }
    if (command.selectedExternalProvider && resolving?.payload?.kind !== 'external_provider_choice') throw Object.assign(new Error('Provider selection requires its original pending decision.'), { code: 'scope_conflict' })
    const receipt = this.deps.repository.execution.command(command.threadId,command.idempotencyKey,command)
    if (receipt.result) {
      const result = receipt.result as TaskCommandResult
      if (result.task) await options.prepareTask?.(this.deps.repository.get(result.task.id) ?? result.task)
      await this.recordResult(command, result)
      return result
    }
    if (resolving?.status !== undefined && resolving.status !== 'pending') throw Object.assign(new Error('这条待处理选择已经完成，请刷新当前任务。'), { code: 'stale_request' })
    if (resolving?.payload?.kind === 'task_input_intent' && operationFingerprint(StartTurnRequest.parse(resolving.payload.request)) !== operationFingerprint(command.request)) {
      throw Object.assign(new Error('任务选择必须使用原始请求及附件，请重新打开该待办。'), { code: 'scope_conflict' })
    }
    if (externalProviderAmbiguity(userText) && !['pause', 'resume', 'cancel'].includes(intent)) {
      const id = `provider_choice_${createHash('sha256').update(`${command.threadId}:${command.idempotencyKey}`).digest('hex').slice(0,32)}`
      const now = this.deps.nowIso()
      const message = '这条请求同时涉及钉钉和飞书。请先选择一个平台，并将请求明确为该平台的独立任务；原任务和请求会保留。'
      this.deps.repository.putAttention({ id, ownerKind:'task', ownerId:task?.id ?? origin.id, ...(task ? { taskId:task.id } : {}), threadId:origin.id, workspaceRoot:origin.workspace,
        kind:'question', title:'选择本次执行的平台', message, status:'pending', revision:0, createdAt:now, updatedAt:now,
        payload:{ kind:'external_provider_choice', providers:['dingtalk','lark'], request:command.request, originalText:userText } })
      const result:TaskCommandResult = { kind:'attention_required', ...(task ? {task} : {}), attentionId:id, message }
      this.deps.repository.execution.finishCommand(command.threadId,command.idempotencyKey,result)
      await this.recordResult(command,result)
      return result
    }
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
          if(changed.capability) result={kind:'capability_required',task:changed.task,attentionId:`capability_${changed.task.id}`,capability:changed.capability,message:changed.capability.message}
          else {
            if(!changed.turn)throw new Error('task resume did not create a Turn')
            result={kind:'task_started',task:changed.task,turn:changed.turn}
          }
        } else result={kind:'task_updated',action:intent,task:changed.task}
      }
    }
    else if(intent==='supplement') {
      if(!task) result={kind:'attention_required',message:'没有可接收补充的任务，请选择任务或新建任务。'}
      else {
        const executionThread = await this.deps.threadStore.get(task.threadId)
        if (!executionThread) throw Object.assign(new Error('task execution thread not found'), { code: 'not_found' })
        const unresolvedEffect = task.acceptance.requiresExternalEffects && !task.acceptance.effect
        const priorBinding = this.deps.repository.inputs(task.id).find(input => input.sourceId === 'provider-selection' && input.idempotencyKey === command.idempotencyKey)
        const supplementText = unresolvedEffect || priorBinding ? `${task.goal}\n${userText}` : userText
        const capability = this.deps.preflightExternalTask ? await this.deps.preflightExternalTask(supplementText, executionThread) : preflightExternalTask(supplementText)
        if (capability?.provider === 'workspace' && capability.status !== 'available') {
          await this.validateReferences(command, origin.workspace, task.threadId)
          const saved = this.deps.tasks.appendInput(task.id, command.expectedRevision ?? task.revision, command.idempotencyKey, userText, 'supplement', undefined,
            { attachmentIds: command.request.attachmentIds, workspaceReferences: command.request.workspaceReferences })
          const attentionId = `capability_${task.id}`, now = this.deps.nowIso()
          const prior = this.deps.repository.attention(attentionId)
          this.deps.repository.putAttention({ id: attentionId, ownerKind: 'task', ownerId: task.id, taskId: task.id, threadId: origin.id, workspaceRoot: origin.workspace,
            kind: 'blocked', title: '确认任务执行权限', message: capability.message, status: 'pending', revision: (prior?.revision ?? -1) + 1, createdAt: prior?.status === 'pending' ? prior.createdAt : now, updatedAt: now,
            payload: { kind: 'capability_required', capability, request: command.request } })
          result = { kind: 'capability_required', task: saved.task, attentionId, capability, message: capability.message }
          this.deps.repository.execution.finishCommand(command.threadId, command.idempotencyKey, result)
          await this.recordResult(command, result)
          return result
        }
        if (capability && (unresolvedEffect || priorBinding) && ['waiting_user', 'paused', 'stalled'].includes(task.status)) {
          await this.validateReferences(command, origin.workspace, task.threadId)
          const selected = externalTaskIntent(supplementText)!
          const saved = this.deps.repository.transact(() => {
            if (priorBinding) return { task: this.deps.repository.get(task.id)!, input: priorBinding }
            const bound = this.deps.repository.update(task.id, command.expectedRevision ?? task.revision, current => ({
              ...current, acceptance: { ...current.acceptance, effect: { provider: capability.provider, operation: selected.operation ?? 'process',
                requiredScopes: capability.requiredScopes ?? [], requiresConfirmation: selected.mutation,
                successStatus: ['succeeded'], verification: 'provider_readback' } }, updatedAt: this.deps.nowIso()
            }))
            return this.deps.tasks.appendInput(bound.id, bound.revision, command.idempotencyKey, userText, 'supplement', 'provider-selection',
              { attachmentIds: command.request.attachmentIds, workspaceReferences: command.request.workspaceReferences })
          })
          if (capability.status !== 'available') {
            const attentionId = `capability_${task.id}`
            const now = this.deps.nowIso()
            this.deps.repository.putAttention({ id: attentionId, ownerKind: 'task', ownerId: task.id, taskId: task.id,
              threadId: origin.id, workspaceRoot: origin.workspace, kind: 'blocked', title: '连接并授权目标服务', message: capability.message,
              status: 'pending', revision: 0, createdAt: now, updatedAt: now,
              payload: { kind: 'capability_required', capability, request: command.request } })
            result = { kind: 'capability_required', task: saved.task, attentionId, capability, message: capability.message }
          } else result = { kind: 'input_queued', task: saved.task, input: saved.input }
          this.deps.repository.execution.finishCommand(command.threadId, command.idempotencyKey, result)
          await this.recordResult(command, result)
          return result
        }
        const providerChanged = capability && task.acceptance.effect?.provider !== capability.provider
        const activeTurn = task.activeTurnId
          ? (await this.deps.threadStore.get(task.threadId))?.turns.find(turn=>turn.id===task.activeTurnId)
          : undefined
        const providerId = capability?.provider === 'lark' ? 'lark-cli' : capability?.provider === 'dingtalk' ? 'dingtalk' : undefined
        const outsideActiveGrant = providerId && task.status === 'running' && !activeTurn?.executionGrant?.allowedProviderIds?.includes(providerId)
        if (capability && (capability.status !== 'available' || providerChanged || outsideActiveGrant)) {
          const attentionId = `capability_${task.id}_${createHash('sha256').update(command.idempotencyKey).digest('hex').slice(0,12)}`
          const now = this.deps.nowIso()
          const message = `${capability.status !== 'available' ? capability.message : '此补充引入了原任务之外的外部平台操作。'} 请为这条请求新建独立任务，保留原任务及其权限范围。`
          this.deps.repository.putAttention({ id: attentionId, ownerKind:'task', ownerId:task.id, taskId:task.id,
            threadId:origin.id, workspaceRoot:origin.workspace, kind:'blocked', title:'补充请求需要连接器授权',
            message, status:'pending', revision:0, createdAt:now, updatedAt:now,
            payload:{kind:'task_input_intent',capability,request:command.request,text:userText,choices:['new']} })
          result={kind:'attention_required',task,attentionId,message}
        } else {
          await this.validateReferences(command,origin.workspace,task.threadId)
          const saved=this.deps.tasks.appendInput(task.id,command.expectedRevision ?? task.revision,command.idempotencyKey,userText,'supplement',undefined,{attachmentIds:command.request.attachmentIds,workspaceReferences:command.request.workspaceReferences})
          // The durable queue is authoritative; no in-memory steering acknowledgement.
          result={kind:'input_queued',task:saved.task,input:saved.input}
        }
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
      if (isTask && options.prepareExecutionThread) await options.prepareExecutionThread((await this.deps.threads.get(executionThreadId))!)
      const executionThread = (await this.deps.threads.get(executionThreadId))!
      const capability = isTask ? this.deps.preflightExternalTask ? await this.deps.preflightExternalTask(userText, externalPreflightThreadContext(executionThread, command.request)) : preflightExternalTask(userText) : null
      if (capability && capability.status !== 'available') {
        const waiting = this.deps.tasks.createWaitingTask({ id: `task_capability_${suffix}`, thread: executionThread,
          request: { ...command.request, taskIntent: 'new', taskVisibility: 'task', taskOriginThreadId: origin.id }, reason: capability.message })
        const attentionId = `capability_${waiting.id}`
        const now = this.deps.nowIso()
        this.deps.repository.putAttention({ id: attentionId, ownerKind: 'task', ownerId: waiting.id, taskId: waiting.id,
          threadId: origin.id, workspaceRoot: origin.workspace, kind: 'blocked', title: capability.provider === 'workspace' ? '确认任务执行权限' : '连接并授权目标服务', message: capability.message,
          status: 'pending', revision: 0, createdAt: now, updatedAt: now,
          payload: { kind: 'capability_required', capability, request: command.request } })
        await options.prepareTask?.(waiting)
        result = { kind: 'capability_required', task: this.deps.repository.get(waiting.id) ?? waiting, attentionId, capability, message: capability.message }
        if (resolving) this.deps.repository.putAttention({...resolving,status:'answered',revision:resolving.revision+1,updatedAt:now})
        this.deps.repository.execution.finishCommand(command.threadId, command.idempotencyKey, result)
        await this.recordResult(command, result)
        return result
      }
      const turnKey=`command:${command.idempotencyKey}`
      const oldTurn=(await this.deps.threads.get(executionThreadId))?.turns.find(turn=>turn.idempotencyKey===turnKey)
      const externalProvider = capability?.provider === 'dingtalk' || capability?.provider === 'lark' ? capability.provider : undefined
      const turn=await this.deps.turns.startTurn({threadId:executionThreadId,...(capability?.status==='available' && externalProvider ? {externalTaskProvider:externalProvider}:{}),request:{...command.request,idempotencyKey:turnKey,taskIntent:isTask?'new':undefined,taskVisibility:isTask?'task':'chat',...(isTask?{taskOriginThreadId:origin.id}:{})}})
      const linked=this.deps.repository.findByTurn(turn.turnId)
      if (linked && isTask) {
        await options.prepareTask?.(linked)
        this.deps.context?.subscribeTask(linked, origin.id)
      }
      result={kind:isTask?'task_started':'chat_started',...(linked&&isTask?{task:this.deps.repository.get(linked.id) ?? linked}:{}),turn}
      if (resolving) this.deps.repository.putAttention({...resolving,status:'answered',revision:resolving.revision+1,updatedAt:this.deps.nowIso()})
      this.deps.repository.execution.finishCommand(command.threadId,command.idempotencyKey,result)
      if(!oldTurn)void this.deps.runTurn(turn.threadId,turn.turnId)
      await this.recordResult(command,result)
      return result
    }
    if (resolving && result.kind !== 'attention_required' && result.kind !== 'capability_required') {
      const latest=this.deps.repository.attention(resolving.id) ?? resolving
      if(latest.status==='pending')this.deps.repository.putAttention({...latest,status:'answered',revision:latest.revision+1,updatedAt:this.deps.nowIso()})
    }
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
    const attention = result.kind === 'attention_required' && result.attentionId ? this.deps.repository.attention(result.attentionId) : null
    if (attention?.payload?.kind === 'task_input_intent') {
      const request = StartTurnRequest.parse(attention.payload.request)
      const choices = Array.isArray(attention.payload.choices) ? attention.payload.choices.filter((choice): choice is 'supplement' | 'new' => choice === 'supplement' || choice === 'new') : ['supplement', 'new'] as const
      result.intentCard = { threadId: command.threadId, ...(attention.taskId ? { taskId: attention.taskId } : {}), attentionId: attention.id, request, choices: [...choices] }
    }
    const commandId=createHash('sha256').update(`${command.threadId}:${command.idempotencyKey}`).digest('hex').slice(0,32)
    result.receipt={userMessageItemId:`item_command_${commandId}_user`,resultMessageItemId:`item_command_${commandId}_receipt`}
    const assistantText=result.kind==='snapshot' ? result.task ? `${result.task.goal}\n${result.task.waitingReason ?? result.task.stalledReason ?? ({queued:'已接收任务',running:'正在执行',retrying:'正在继续',paused:'已暂停',waiting_user:'等待你补充',waiting_approval:'等待必要授权',completed:'已完成',stalled:'需要处理阻塞',failed:'执行失败',cancelled:'已取消'} as const)[result.task.status]}` : '当前没有进行中的任务。' : result.kind==='input_queued' ? result.task.status==='paused'?'补充已保存，将在你继续任务后送达。':'补充已保存，将送达当前任务。' : result.kind==='task_updated'?result.action==='pause'?'任务已暂停，补充会继续保存。':'任务已取消，已有成果和记录已保留。': result.kind==='attention_required'?result.message:result.kind==='capability_required'?result.capability.message:`已接收任务：${result.task?.goal ?? command.request.displayText ?? command.request.prompt}`
    this.deps.repository.enqueueOutbox({id:`command-message:${commandId}`,ownerId:command.threadId,kind:'task_command_message',payload:{threadId:command.threadId,commandId,userText:command.request.displayText ?? command.request.prompt,assistantText,...(result.intentCard ? { intentCard: result.intentCard } : {}),...(result.kind==='capability_required'&&result.task?{capabilityCard:{threadId:command.threadId,taskId:result.task.id,attentionId:result.attentionId,prompt:command.request.prompt,capability:result.capability}}:{}),createdAt:this.deps.nowIso()},createdAt:this.deps.nowIso()})
    await this.flushCommandMessages()
  }

  async flushCommandMessages():Promise<void> {
    if(this.flushingMessages) return this.flushingMessages
    this.flushingMessages = (async () => {
      for (;;) {
        const messages = this.deps.repository.pendingOutbox('task_command_message')
        if (!messages.length) return
        for(const message of messages) {
          await this.deps.turns.recordCommandExchange(message.payload as Parameters<TurnService['recordCommandExchange']>[0])
          this.deps.repository.acknowledgeOutbox(message.id,this.deps.nowIso())
        }
      }
    })()
    try { await this.flushingMessages } finally { this.flushingMessages=undefined }
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
  if(externalTaskIntent(value)) return 'new'
  if(explicitWorkspaceWrite(value)) return 'new'
  if(/^(?:(?:请|帮我)\s*)?(?:如何|怎么|怎样|介绍|解释|什么是|对比|比较|how\s|what\s|explain|compare\b)/i.test(value)) return 'chat'
  if (promptRequiresFileDeliverable(value) || /(?:使用|用|通过).{0,30}(?:browser[-\s]?skill|浏览器).{0,80}(?:获取|读取|采集|抓取|查询|搜索|检索|打开)|(?:每天|每日|定时|daily|every day).{0,80}(?:执行|运行|采集|汇报|报告|run|collect)/i.test(value)) return 'new'
  if(!hasTask) return /(?:报告|投标|交付|文档|实现|完成.*计划|调研|research|implement|deliver|report|钉钉|飞书|dingtalk|lark|feishu).*(?:待办|审批|任务|工单|处理|todo|approval|task)|(?:处理|完成|查询|列出).*(?:钉钉|飞书|dingtalk|lark|feishu)/i.test(value)?'new':/(?:报告|投标|交付|文档|实现|完成.*计划|调研|research|implement|deliver|report)/i.test(value)?'new':'chat'
  return 'ambiguous'
}
