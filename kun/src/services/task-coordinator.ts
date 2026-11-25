import { taskStatusSummary } from './task-user-presentation.js'
import { createHash } from 'node:crypto'
import type { TaskCommand, TaskCommandResult } from '../contracts/execution.js'
import { TaskCommandSchema } from '../contracts/execution.js'
import type { TaskInput, TaskRun } from '../contracts/tasks.js'
import type { ThreadRecord } from '../contracts/threads.js'
import type { ThreadStore } from '../ports/thread-store.js'
import type { UserInputAnswer, UserInputGate } from '../ports/user-input-gate.js'
import type { TaskRunRepository } from './task-run-repository.js'
import { operationFingerprint, TaskRevisionConflictError } from './task-run-repository.js'
import { StartTurnRequest } from '../contracts/turns.js'
import type { ThreadService } from './thread-service.js'
import type { TurnService } from './turn-service.js'
import type { TaskController } from './task-controller.js'
import type { TaskContextRuntime } from './task-context-runtime.js'
import type { AttachmentStore } from '../attachments/attachment-store.js'
import { WorkspaceReferenceService } from './workspace-reference-service.js'
import { TaskControlService, type TaskResumeAttention } from './task-control-service.js'
import { preflightExternalTask, externalTaskIntent, externalProviderAmbiguity, type ExternalTaskPreflight } from './external-task-capability.js'
import { externalPreflightThreadContext } from './contextual-external-task-preflight.js'
import { explicitWorkspaceWrite } from './workspace-write-preflight.js'
import { promptRequiresFileDeliverable } from '../loop/turn-completion-guard.js'

export type TaskCommandDispatchOptions = {
  /** Internal recurrence dispatch does not represent a new user message. */
  source?: 'scheduled-occurrence'
  /** Internal task-question answer verified against its pending request. */
  taskUserInputAnswerRequestId?: string
  /** Recheck the source immediately before creating its durable command receipt. */
  assertMayBegin?: () => void
  /** Server-only preparation of a durable recurrence context before capability admission. */
  prepareExecutionThread?: (thread: ThreadRecord) => Promise<void>
  /** Internal integration hook. Persist source linkage and outbox before any worker dispatch. */
  prepareTask?: (task: TaskRun) => Promise<void> | void
}

export class TaskCoordinator {
  private readonly pending = new Map<string, Promise<TaskCommandResult>>()
  private flushingMessages?: Promise<void>
  private readonly controls:TaskControlService
  constructor(private readonly deps: { repository: TaskRunRepository; threads: ThreadService; threadStore: ThreadStore; turns: TurnService; tasks: TaskController; controls?:TaskControlService; context?: TaskContextRuntime; attachments?:AttachmentStore; userInputGate?: UserInputGate; classifyIntent?: (text:string,task:TaskRun) => Promise<'supplement'|'new'|'chat'|'ambiguous'>; requiresBrowserScopeRefresh?: (task: TaskRun, turnId: string, text: string) => boolean | Promise<boolean>; waitTurn?: (threadId: string, turnId: string) => Promise<void>; preflightExternalTask?: ExternalTaskPreflight; runTurn(threadId:string,turnId:string):unknown; nowIso():string }) {this.controls=deps.controls ?? new TaskControlService(deps)}
  async command(raw: TaskCommand, options: TaskCommandDispatchOptions = {}): Promise<TaskCommandResult> {
    const command = TaskCommandSchema.parse(raw)
    const queueKey = `${command.threadId}:${command.idempotencyKey}`
    const pending = this.pending.get(queueKey)
    if(pending) { await pending; return this.command(raw, options) }
    const promise = this.execute(command, options)
    this.pending.set(queueKey,promise)
    try { return await promise } finally { this.pending.delete(queueKey) }
  }
  async submitTaskUserInputAnswer(inputId: string, answers: UserInputAnswer[]): Promise<'not_applicable' | 'submitted' | 'stale'> {
    const saved = this.deps.repository.humanRequest(inputId)
    const request = this.deps.userInputGate?.get(inputId)
    const attention = this.deps.repository.attention(inputId)
    if (!saved || saved.kind !== 'question' || !attention?.taskId || !request) return 'not_applicable'

    const task = this.deps.repository.get(attention.taskId)
    if (!task || task.threadId !== request.threadId) return 'stale'
    if (request.questions.length !== 1 || request.questions[0]!.options.length > 0) return 'not_applicable'

    const answer = answers.length === 1 ? answers[0] : undefined
    if (!answer || answer.id !== request.questions[0]!.id || !answer.value.trim()) return 'stale'
    const answerText = answer.value.trim()
    const idempotencyKey = `user-input:${inputId}`
    const existing = this.deps.repository.inputs(task.id).filter(input => input.idempotencyKey === idempotencyKey)
    if (existing.length) {
      return existing.length === 1 && existing[0]!.kind === 'supplement' && existing[0]!.text === answerText
        ? 'submitted'
        : 'stale'
    }
    if (saved.status !== 'pending' || attention.status !== 'pending' || task.status !== 'waiting_user' ||
      task.activeTurnId !== request.turnId) return 'stale'

    try {
      const result = await this.command({
        threadId: task.originThreadId ?? task.threadId,
        taskId: task.id,
        expectedRevision: task.revision,
        intent: 'supplement',
        idempotencyKey,
        request: { prompt: answerText, displayText: answerText, model: task.model }
      }, { taskUserInputAnswerRequestId: inputId })
      const persisted = this.deps.repository.inputs(task.id).filter(input => input.kind === 'supplement' &&
        input.idempotencyKey === idempotencyKey && input.text === answerText)
      return result.task?.id === task.id && persisted.length === 1 ? 'submitted' : 'stale'
    } catch (error) {
      const code = (error as { code?: string }).code
      if (error instanceof TaskRevisionConflictError ||
        ['stale_request', 'invalid_state', 'outcome_unknown', 'scope_conflict', 'idempotency_conflict'].includes(code ?? '')) {
        const persisted = this.deps.repository.inputs(task.id).filter(input => input.idempotencyKey === idempotencyKey)
        return persisted.length === 1 && persisted[0]!.kind === 'supplement' && persisted[0]!.text === answerText
          ? 'submitted'
          : 'stale'
      }
      throw error
    }
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
    if (options.taskUserInputAnswerRequestId) {
      const requestId = options.taskUserInputAnswerRequestId
      const request = this.deps.userInputGate?.get(requestId)
      const humanRequest = this.deps.repository.humanRequest(requestId)
      const attention = this.deps.repository.attention(requestId)
      if (!task || command.intent !== 'supplement' || command.taskId !== task.id ||
        command.idempotencyKey !== `user-input:${requestId}` || task.status !== 'waiting_user' ||
        !task.activeTurnId || request?.threadId !== task.threadId || request.turnId !== task.activeTurnId ||
        humanRequest?.status !== 'pending' || attention?.status !== 'pending' || attention.taskId !== task.id ||
        request.questions.length !== 1 || request.questions[0]!.options.length > 0 || !command.request.prompt.trim()) {
        throw Object.assign(new Error('原任务问题已变化，请在当前对话重新查看。'), { code: 'stale_request' })
      }
    }
    const attachmentLabel = /^(?:已附加图片|attached images?)[。.!！\s]*$/i.test(command.request.displayText?.trim() ?? '')
    const userText = attachmentLabel && command.request.attachmentIds?.length ? command.request.prompt : command.request.displayText ?? command.request.prompt
    let intent = command.intent === 'auto' ? classifyTaskInput(userText,Boolean(task)) : command.intent
    if (command.intent === 'auto' && task && command.request.attachmentIds?.length &&
      /^(?:请根据已附加的图片继续处理[。.!！]?|已附加图片|attached images?)[。.!！\s]*$/i.test(userText.trim())) intent = 'supplement'
    if (command.intent === 'auto' && task?.acceptance.requiresExternalEffects && (!task.acceptance.effect || this.deps.repository.inputs(task.id).some(input => input.sourceId === 'provider-selection' && input.idempotencyKey === command.idempotencyKey)) &&
      ['waiting_user', 'paused', 'stalled'].includes(task.status) && /^(?:请)?(?:使用|用|通过|在).*(?:钉钉|飞书|dingtalk|lark|feishu)/i.test(userText)) intent = 'supplement'
    // An explicit chat hint cannot bypass provider admission for an action.
    if (intent === 'chat' && (externalTaskIntent(userText) || explicitWorkspaceWrite(userText))) intent = 'new'
    let resumeAttention: TaskResumeAttention | undefined
    if (command.expectedAttentionRevision !== undefined) {
      if (command.intent !== 'resume' || !command.resolveAttentionId || !command.taskId || command.expectedRevision === undefined) {
        throw Object.assign(new Error('重新确认任务及待处理事项后继续。'), { code: 'scope_conflict' })
      }
      resumeAttention = { id: command.resolveAttentionId, revision: command.expectedAttentionRevision, threadId: origin.id }
    }
    if(intent==='status') return {kind:'snapshot',task}
    const resolving = command.resolveAttentionId ? this.deps.repository.attention(command.resolveAttentionId) : null
    if (!resumeAttention && command.resolveAttentionId && (!resolving || resolving.threadId !== origin.id ||
      !(resolving.payload?.kind === 'task_input_intent' && ['supplement','new'].includes(intent) &&
          (!Array.isArray(resolving.payload.choices) || resolving.payload.choices.includes(intent)) ||
        resolving.payload?.kind === 'external_provider_choice' && intent === 'new' && command.selectedExternalProvider && !externalProviderAmbiguity(userText) && externalTaskIntent(userText)?.provider === command.selectedExternalProvider ||
        resolving.payload?.kind === 'capability_required' && intent === 'resume' && resolving.taskId === task?.id))) {
      throw Object.assign(new Error('attention decision does not match this task command'), {code:'scope_conflict'})
    }
    if (command.selectedExternalProvider && resolving?.payload?.kind !== 'external_provider_choice') throw Object.assign(new Error('Provider selection requires its original pending decision.'), { code: 'scope_conflict' })
    options.assertMayBegin?.()
    const receipt = this.deps.repository.execution.command(command.threadId,command.idempotencyKey,command)
    if (receipt.result) {
      const result = receipt.result as TaskCommandResult
      if (result.task) await options.prepareTask?.(this.deps.repository.get(result.task.id) ?? result.task)
      await this.recordResult(command, result, intent, options)
      return result
    }
    await this.deps.turns.validateSkillSelection(userText, origin.workspace)
    const skillSelections = command.request.capabilityReferences?.length
      ? await this.deps.turns.validateCapabilitySelection(command.request, origin)
      : undefined
    if (!resumeAttention && resolving?.status !== undefined && resolving.status !== 'pending') throw Object.assign(new Error('这条待处理选择已经完成，请刷新当前任务。'), { code: 'stale_request' })
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
      await this.recordResult(command,result,intent,options,skillSelections)
      return result
    }
    const conversationTasks = task && !command.taskId ? this.deps.repository.listActiveByOrigin(origin.id, 2) : []
    const multipleTasks = conversationTasks.length > 1 && Boolean(conversationTasks[0]?.scheduledBy) === Boolean(conversationTasks[1]?.scheduledBy)
    const focusedTask = task && !multipleTasks
    if (intent === 'ambiguous' && focusedTask && task.status === 'waiting_user') intent = 'supplement'
    if (intent === 'ambiguous' && task && this.deps.classifyIntent) {
      try { intent = await this.deps.classifyIntent(userText,task) } catch { /* use the current conversation context */ }
    }
    if (intent === 'ambiguous' && focusedTask) {
      intent = 'supplement'
    }
    let result:TaskCommandResult
    if(intent==='ambiguous') {
      const id = `input_intent_${createHash('sha256').update(`${command.threadId}:${command.idempotencyKey}`).digest('hex').slice(0,32)}`
      const now = this.deps.nowIso()
      const message = '这段对话有多项工作。请选择将这条消息补充给当前工作，或在本对话处理新请求。'
      this.deps.repository.putAttention({ id, ownerKind:'task', ownerId:task?.id ?? command.threadId, ...(task?{taskId:task.id}:{}), threadId:command.threadId, kind:'question', title:'确定这条补充的归属', message, status:'pending', revision:0, createdAt:now, updatedAt:now, payload:{ kind:'task_input_intent', commandKey:command.idempotencyKey, text:userText, request:command.request, choices:['supplement','new'] } })
      result={kind:'attention_required',...(task?{task}:{}),message,attentionId:id}
    }
    else if(intent==='pause'||intent==='resume'||intent==='cancel') {
      if(!task)result={kind:'attention_required',message:'当前对话没有可操作的任务。你可以直接输入要做的事。'}
      else if(multipleTasks) result={kind:'attention_required',message:'这段对话有多项工作，请在需要操作的进度卡上选择。'}
      else if(intent==='resume' && !resumeAttention && (['queued', 'running'].includes(task.status) ||
        ['waiting_user', 'waiting_approval'].includes(task.status) && this.deps.repository.inbox(task.workspaceRoot)
          .some(item => item.taskId === task.id && (item.kind === 'question' || item.kind === 'approval')))) {
        result={kind:'snapshot',task}
      }
      else {
        const changed=await this.controls.mutate(resumeAttention ? command.taskId! : task.id,intent,{expectedRevision:command.expectedRevision ?? task.revision,idempotencyKey:`command:${command.idempotencyKey}`,model:command.request.model,...(resumeAttention ? { resumeAttention } : {})})
        if(intent==='resume') {
          if(changed.capability) result={kind:'capability_required',task:changed.task,attentionId:`capability_${changed.task.id}`,capability:changed.capability,message:changed.capability.message,...(changed.receipt ? {receipt:changed.receipt} : {})}
          else {
            if(!changed.turn)throw new Error('task resume did not create a Turn')
            result={kind:'task_started',task:changed.task,turn:changed.turn}
          }
        } else result={kind:'task_updated',action:intent,task:changed.task}
      }
    }
    else if(intent==='supplement') {
      if(!task) result={kind:'attention_required',message:'当前对话没有需要补充的任务。你可以直接输入完整要求。'}
      else {
        const executionThread = await this.deps.threadStore.get(task.threadId)
        if (!executionThread) throw Object.assign(new Error('task execution thread not found'), { code: 'not_found' })
        const unresolvedEffect = task.acceptance.requiresExternalEffects && !task.acceptance.effect
        const priorBinding = this.deps.repository.inputs(task.id).find(input => input.sourceId === 'provider-selection' && input.idempotencyKey === command.idempotencyKey)
        const supplementText = unresolvedEffect || priorBinding ? `${task.goal}\n${userText}` : userText
        const answerNeedsBrowserRefresh = Boolean(options.taskUserInputAnswerRequestId && task.status === 'waiting_user' &&
          task.activeTurnId && await this.deps.requiresBrowserScopeRefresh?.(task, task.activeTurnId, userText))
        const capability = this.deps.preflightExternalTask
          ? await this.deps.preflightExternalTask(supplementText, executionThread, task)
          : preflightExternalTask(supplementText)
        const browserScopeNeedsReview = answerNeedsBrowserRefresh && capability?.provider === 'browser-skill' &&
          capability.status === 'needs_authorization' &&
          ['browser_task_scope_required', 'browser_followup_origin_scope_required'].includes(capability.errorCode ?? '')
        if (capability?.provider === 'workspace' && capability.status !== 'available') {
          await this.validateReferences(command, origin.workspace, task.threadId)
          const saved = this.deps.tasks.appendInput(task.id, command.expectedRevision ?? task.revision, command.idempotencyKey, userText, 'supplement', undefined,
            { attachmentIds: command.request.attachmentIds, workspaceReferences: command.request.workspaceReferences, capabilityReferences: command.request.capabilityReferences, skillSelections })
          const attentionId = `capability_${task.id}`, now = this.deps.nowIso()
          const prior = this.deps.repository.attention(attentionId)
          this.deps.repository.putAttention({ id: attentionId, ownerKind: 'task', ownerId: task.id, taskId: task.id, threadId: origin.id, workspaceRoot: origin.workspace,
            kind: 'blocked', title: '确认任务执行权限', message: capability.message, status: 'pending', revision: (prior?.revision ?? -1) + 1, createdAt: prior?.status === 'pending' ? prior.createdAt : now, updatedAt: now,
            payload: { kind: 'capability_required', capability, request: command.request } })
          result = { kind: 'capability_required', task: saved.task, attentionId, capability, message: capability.message }
          this.deps.repository.execution.finishCommand(command.threadId, command.idempotencyKey, result)
          await this.recordResult(command, result, intent, options,skillSelections)
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
              { attachmentIds: command.request.attachmentIds, workspaceReferences: command.request.workspaceReferences, capabilityReferences: command.request.capabilityReferences, skillSelections })
          })
          if (capability.status !== 'available') {
            const attentionId = `capability_${task.id}`
            const now = this.deps.nowIso()
            this.deps.repository.putAttention({ id: attentionId, ownerKind: 'task', ownerId: task.id, taskId: task.id,
              threadId: origin.id, workspaceRoot: origin.workspace, kind: 'blocked', title: '连接并授权目标服务', message: capability.message,
              status: 'pending', revision: 0, createdAt: now, updatedAt: now,
              payload: { kind: 'capability_required', capability, request: command.request } })
            result = { kind: 'capability_required', task: saved.task, attentionId, capability, message: capability.message }
          } else result = await this.continueAfterSupplement(command, saved)
          this.deps.repository.execution.finishCommand(command.threadId, command.idempotencyKey, result)
          await this.recordResult(command, result, intent, options,skillSelections)
          return result
        }
        const providerChanged = capability && task.acceptance.effect?.provider !== capability.provider
        const activeTurn = task.activeTurnId
          ? (await this.deps.threadStore.get(task.threadId))?.turns.find(turn=>turn.id===task.activeTurnId)
          : undefined
        const providerId = capability?.provider === 'lark' ? 'lark-cli' : capability?.provider === 'dingtalk' ? 'dingtalk' : undefined
        const outsideActiveGrant = providerId && task.status === 'running' && !activeTurn?.executionGrant?.allowedProviderIds?.includes(providerId)
        if (capability && !browserScopeNeedsReview && (capability.status !== 'available' || providerChanged || outsideActiveGrant)) {
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
          const saved=this.deps.tasks.appendInput(task.id,command.expectedRevision ?? task.revision,command.idempotencyKey,userText,'supplement',undefined,{attachmentIds:command.request.attachmentIds,workspaceReferences:command.request.workspaceReferences,capabilityReferences:command.request.capabilityReferences,skillSelections})
          result = await this.continueAfterSupplement(command, saved)
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
        await this.recordResult(command, result, intent, options,skillSelections)
        return result
      }
      const turnKey=`command:${command.idempotencyKey}`
      const oldTurn=(await this.deps.threads.get(executionThreadId))?.turns.find(turn=>turn.idempotencyKey===turnKey)
      const externalProvider = capability?.provider === 'dingtalk' || capability?.provider === 'lark' ? capability.provider : undefined
      const turn=await this.deps.turns.startTurn({threadId:executionThreadId,...(capability?.status==='available' && externalProvider ? {externalTaskProvider:externalProvider}:{}),request:{...command.request,idempotencyKey:turnKey,taskIntent:isTask?'new':undefined,taskVisibility:isTask?'task':'chat',...(isTask?{taskOriginThreadId:origin.id}:{})}})
      let dispatched = Boolean(oldTurn)
      try {
        const linked=this.deps.repository.findByTurn(turn.turnId)
        if (linked && isTask) {
          await options.prepareTask?.(linked)
          this.deps.context?.subscribeTask(linked, origin.id)
        }
        result={kind:isTask?'task_started':'chat_started',...(linked&&isTask?{task:this.deps.repository.get(linked.id) ?? linked}:{}),turn}
        if (resolving) this.deps.repository.putAttention({...resolving,status:'answered',revision:resolving.revision+1,updatedAt:this.deps.nowIso()})
        this.deps.repository.execution.finishCommand(command.threadId,command.idempotencyKey,result)
        const history = this.recordResult(command,result,intent,options,skillSelections)
        if(!oldTurn) {
          void this.deps.runTurn(turn.threadId,turn.turnId)
          dispatched = true
        }
        await history
        return result
      } catch (error) {
        if (!dispatched) this.deps.tasks.releasePendingAdmission(turn.threadId, turn.turnId)
        throw error
      }
    }
    if (resolving && result.kind !== 'attention_required' && result.kind !== 'capability_required') {
      const latest=this.deps.repository.attention(resolving.id) ?? resolving
      if(latest.status==='pending')this.deps.repository.putAttention({...latest,status:'answered',revision:latest.revision+1,updatedAt:this.deps.nowIso()})
    }
    this.deps.repository.execution.finishCommand(command.threadId,command.idempotencyKey,result)
    await this.recordResult(command,result,intent,options,skillSelections)
    return result
  }

  private async continueAfterSupplement(
    command: ReturnType<typeof TaskCommandSchema.parse>, saved: { task: TaskRun; input: TaskInput }
  ): Promise<TaskCommandResult> {
    const { repository, threadStore, userInputGate } = this.deps
    const { task, input } = saved
    const queued = { kind: 'input_queued' as const, task, input }
    if (task.status !== 'waiting_user' || !task.activeTurnId || task.blockCode) return queued
    const pending = repository.inbox(task.workspaceRoot).filter(item => item.taskId === task.id)
    const attention = pending.length === 1 && pending[0]?.kind === 'question' ? pending[0] : undefined
    const request = attention?.requestId ? userInputGate?.get(attention.requestId) : undefined
    const question = request?.questions.length === 1 ? request.questions[0] : undefined
    if (request?.turnId === task.activeTurnId && question && question.options.length === 0) {
      if (await this.deps.requiresBrowserScopeRefresh?.(task, request.turnId, input.text)) {
        const current = repository.get(task.id) ?? task
        const paused = this.deps.tasks.pauseTask(current.id, current.revision, '正在根据补充网址更新只读网页读取范围。')
        userInputGate?.resolveForTurnRestart(request.id)
        await this.deps.turns.interruptTurn({ threadId: task.threadId, turnId: request.turnId })
        await this.deps.waitTurn?.(task.threadId, request.turnId)
        const ready = repository.get(task.id) ?? paused
        try {
          const resumed = await this.controls.mutate(task.id, 'resume', {
            expectedRevision: ready.revision, idempotencyKey: `supplement-browser-scope:${input.id}`, model: command.request.model
          })
          if (resumed.capability) return { kind: 'capability_required', task: resumed.task,
            attentionId: `capability_${task.id}`, capability: resumed.capability, message: resumed.capability.message,
            ...(resumed.receipt ? { receipt: resumed.receipt } : {}) }
          return { ...queued, task: resumed.task }
        } catch (error) {
          if (!['stale_request', 'invalid_state', 'outcome_unknown'].includes((error as { code?: string }).code ?? '')) throw error
          return { ...queued, task: repository.get(task.id) ?? ready }
        }
      }
      if (userInputGate?.resolve(request.id, { status: 'submitted', answers: [{ id: question.id, label: question.header || question.question, value: input.text }] })) {
        return { ...queued, task: repository.get(task.id) ?? task }
      }
    }
    if (pending.length) return queued
    const turn = (await threadStore.get(task.threadId))?.turns.find(item => item.id === task.activeTurnId)
    if (!turn || !['completed', 'failed', 'aborted'].includes(turn.status)) return queued
    try {
      // The user's reply is already durable. Reuse the normal scoped recovery
      // checks and bind a single resume to this exact supplement.
      const resumed = await this.controls.mutate(task.id, 'resume', {
        expectedRevision: task.revision, idempotencyKey: `supplement:${input.id}`, model: command.request.model
      })
      if (resumed.capability) return { kind: 'capability_required', task: resumed.task,
        attentionId: `capability_${task.id}`, capability: resumed.capability, message: resumed.capability.message,
        ...(resumed.receipt ? { receipt: resumed.receipt } : {}) }
      return { ...queued, task: resumed.task }
    } catch (error) {
      if (!['stale_request', 'invalid_state', 'outcome_unknown'].includes((error as { code?: string }).code ?? '')) throw error
      return { ...queued, task: repository.get(task.id) ?? task }
    }
  }

  private async validateReferences(command:ReturnType<typeof TaskCommandSchema.parse>,workspace:string,targetThreadId:string):Promise<void> {
    if(command.request.workspaceReferences?.length) await new WorkspaceReferenceService().validateReferences(workspace,command.request.workspaceReferences)
    for(const id of command.request.attachmentIds ?? []) {
      if(!this.deps.attachments?.grantTaskReference) throw Object.assign(new Error('attachment reference service unavailable'),{code:'scope_conflict'})
      await this.deps.attachments.grantTaskReference(id,{threadId:command.threadId,workspace},{threadId:targetThreadId,workspace})
    }
  }

  private async recordResult(command:ReturnType<typeof TaskCommandSchema.parse>,result:TaskCommandResult,intent:ReturnType<typeof classifyTaskInput>,options:TaskCommandDispatchOptions,userSkillSelections?:TaskInput['skillSelections']):Promise<void> {
    if (result.kind === 'chat_started') return
    const scheduled = options.source === 'scheduled-occurrence'
    if (scheduled && result.kind === 'task_started') return
    if (result.kind === 'capability_required' && result.task) {
      const pending = this.deps.repository.attention(result.attentionId ?? `capability_${result.task.id}`)
      if (typeof pending?.payload?.resumeCommandId === 'string') {
        const commandId = pending.payload.resumeCommandId
        result.receipt ??= { userMessageItemId: `item_command_${commandId}_user`, resultMessageItemId: `item_command_${commandId}_receipt` }
        // TaskControl already persisted the same capability card for HTTP and chat resume.
        await this.flushCommandMessages()
        return
      }
    }
    const attention = result.kind === 'attention_required' && result.attentionId ? this.deps.repository.attention(result.attentionId) : null
    if (attention?.payload?.kind === 'task_input_intent') {
      const request = StartTurnRequest.parse(attention.payload.request)
      const choices = Array.isArray(attention.payload.choices) ? attention.payload.choices.filter((choice): choice is 'supplement' | 'new' => choice === 'supplement' || choice === 'new') : ['supplement', 'new'] as const
      result.intentCard = { threadId: command.threadId, ...(attention.taskId ? { taskId: attention.taskId } : {}), attentionId: attention.id, request, choices: [...choices] }
    }
    const commandId=createHash('sha256').update(`${command.threadId}:${command.idempotencyKey}`).digest('hex').slice(0,32)
    result.receipt={userMessageItemId:`item_command_${commandId}_user`,resultMessageItemId:`item_command_${commandId}_receipt`}
    // A resume command retains its original request for execution and audit,
    // but its conversation receipt describes the control instead of resending the goal.
    const userText = scheduled ? undefined : intent === 'resume' ? '继续任务' : command.request.displayText ?? command.request.prompt
    const assistantText=intent==='resume'&&result.kind==='task_started'?'正在继续任务。':result.kind==='snapshot' ? result.task ? `${result.task.goal}\n${taskStatusSummary(result.task)}` : '当前没有进行中的任务。' : result.kind==='input_queued' ? result.task.status==='paused'?'补充已保存，将在你继续任务后送达。':'补充已保存，将送达当前任务。' : result.kind==='task_updated'?result.action==='pause'?'任务已暂停，补充会继续保存。':'任务已取消，已有成果和记录已保留。': result.kind==='attention_required'?result.message:result.kind==='capability_required'?result.capability.message:'开始处理。'
    this.deps.repository.enqueueOutbox({id:`command-message:${commandId}`,ownerId:command.threadId,kind:'task_command_message',payload:{threadId:command.threadId,commandId,userText,assistantText,
      ...(userText !== undefined && intent !== 'resume' ? { userAttachmentIds: command.request.attachmentIds, userWorkspaceReferences: command.request.workspaceReferences, userSkillSelections } : {}),
      ...(result.intentCard ? { intentCard: result.intentCard } : {}),...(result.kind==='capability_required'&&result.task?{capabilityCard:{threadId:command.threadId,taskId:result.task.id,attentionId:result.attentionId,prompt:command.request.prompt,capability:result.capability}}:{}),createdAt:this.deps.nowIso()},createdAt:this.deps.nowIso()})
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
