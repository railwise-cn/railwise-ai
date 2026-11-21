import { recoveryCoversReceipt } from './browser-public-query-recovery-proof.js'
import type { BrowserPublicQueryRecoveryService } from './browser-public-query-recovery.js'
import { ThreadTodoListSchema } from '../contracts/threads.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { operationFingerprint } from './task-run-repository.js'
import type { OperationReceipt } from '../contracts/tasks.js'
import type { TaskRun } from '../contracts/tasks.js'
import type { StartTurnResponse } from '../contracts/turns.js'
import { StartTurnRequest } from '../contracts/turns.js'
import type { TaskController } from './task-controller.js'
import type { TaskRunRepository } from './task-run-repository.js'
import type { ThreadService } from './thread-service.js'
import type { TurnService } from './turn-service.js'
import { preflightExternalTask, type ExternalTaskCapability, type ExternalTaskPreflight } from './external-task-capability.js'
import { externalPreflightThreadContext } from './contextual-external-task-preflight.js'
import { workspacePermissionCapability } from './workspace-write-preflight.js'
import { externalOperationForTool } from './external-effect-evidence.js'
import { toolCanProveExternalEffect } from '../loop/turn-completion-guard.js'
import { createHash } from 'node:crypto'
import { taskPermissionCapability, taskPermissionFailure } from './task-permission-recovery.js'
import type { ApprovalRequest } from '../domain/approval.js'

export type TaskControlAction = 'resume' | 'retry' | 'pause' | 'cancel' | 'extend_budget' | 'revalidate_artifacts' | 'prepare_public_query_recovery' | 'revoke_public_query_recovery'
export type TaskControlRequest = { expectedRevision:number; idempotencyKey:string; model?:string; reason?:string; additionalExecutionMs?:number; confirmed?:boolean; publicQueryRecoveryReceiptId?:string; scopeConfirmation?:import('../contracts/browser-public-query-recovery.js').OneOffScopeConfirmation; consentReceiptId?:string }
export type TaskControlResult = { task:TaskRun; corrected?:boolean; completed?:boolean; reason?:string; turn?:StartTurnResponse; capability?:ExternalTaskCapability; attentionId?:string; receipt?:{userMessageItemId:string;resultMessageItemId:string} }

/** One deterministic mutation path for chat commands and the task HTTP API. */
export class TaskControlService {
  private readonly pending = new Map<string,Promise<unknown>>()
  constructor(private readonly deps:{publicQueryRecovery?:BrowserPublicQueryRecoveryService;repository:TaskRunRepository;tasks:TaskController;threads:ThreadService;turns:TurnService;runTurn(threadId:string,turnId:string):unknown;cancelChildRuns?(threadId:string,reason:string):unknown;isEngineeringTask?(task:TaskRun):Promise<boolean>;preflightExternalTask?:ExternalTaskPreflight;preflightRecoveryTask?(text:string,thread:import('../contracts/threads.js').ThreadRecord,binding:import('../contracts/browser-public-query-recovery.js').BrowserPublicQueryRecoveryBinding):ReturnType<ExternalTaskPreflight>;validateTaskPermission?(threadId:string,sourceTaskId?:string):Promise<unknown>;validateRecoveryExecution?(task:TaskRun):Promise<void>;validateRecoveryPermission?(threadId:string):Promise<unknown>;assertRetryContext?(task:TaskRun):void;validateRetryLocalSchedule?(task:TaskRun,receipt:OperationReceipt,recovery?:import('../contracts/browser-public-query-recovery.js').BrowserPublicQueryRecoveryBinding):Promise<boolean>;nowIso():string}) {}

  async mutate(taskId:string, action:TaskControlAction, data:TaskControlRequest):Promise<TaskControlResult> {
    return this.serialize(taskId, () => this.execute(taskId, action, data))
  }

  async continueDetachedApproval(approval: ApprovalRequest): Promise<void> {
    const { repository, tasks, turns } = this.deps
    const taskId = repository.attention(approval.id)?.taskId
    if (!taskId) return
    await this.serialize(taskId, async () => {
      const task = repository.get(taskId)
      if (!task || !tasks.canContinueDetachedApproval(task, approval) || turns.getAbortController(approval.turnId)) return
      try {
        await this.execute(task.id, 'resume', {
          expectedRevision: task.revision, idempotencyKey: `approval-resume:${approval.id}`
        }, approval.turnId)
      } catch (error) {
        // The approval is still saved. Leave the original task available for
        // review if its current scope or earlier outcome cannot be verified.
        console.warn('[kun] Could not continue the approved task:', (error as { code?: string }).code ?? 'resume_unavailable')
      }
    })
  }

  private async serialize<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    const previous=this.pending.get(taskId) ?? Promise.resolve()
    const operation=previous.catch(()=>undefined).then(run)
    this.pending.set(taskId,operation)
    try { return await operation } finally { if(this.pending.get(taskId)===operation)this.pending.delete(taskId) }
  }

  private async execute(taskId:string, action:TaskControlAction, data:TaskControlRequest, detachedApprovalTurnId?: string):Promise<TaskControlResult> {
    const {repository,tasks,threads,turns,nowIso}=this.deps
    if (action === 'prepare_public_query_recovery') { if (!this.deps.publicQueryRecovery) throw new Error('recovery unavailable'); return this.deps.publicQueryRecovery.prepare(taskId, data) }
    if(action==='revoke_public_query_recovery'){const task=repository.get(taskId);if(!task||!this.deps.publicQueryRecovery)throw new Error('recovery unavailable');return this.deps.publicQueryRecovery.revoke(task,data)}
    if (action === 'revalidate_artifacts') return tasks.revalidateLocalArtifacts(taskId, data)
    if (action === 'extend_budget') return repository.transact(() => {
      const previous = repository.operation(taskId, data.idempotencyKey)
      // A committed request must be replayable even after the task revision changes.
      if (previous) {
        repository.beginOperation({ ownerId: taskId, idempotencyKey: data.idempotencyKey, kind: action, request: data, nowIso: nowIso() })
        if (previous.status !== 'succeeded') throw Object.assign(new Error('预算变更记录需要核验，请刷新后重试。'), { code: 'outcome_unknown' })
        return { task: previous.result as TaskRun }
      }
      const now = nowIso()
      const task = repository.extendExecutionBudget(taskId, data.expectedRevision, data.additionalExecutionMs, data.idempotencyKey, now)
      repository.beginOperation({ ownerId: taskId, idempotencyKey: data.idempotencyKey, kind: action, request: data, nowIso: now })
      repository.finishOperation(taskId, data.idempotencyKey, { status: 'succeeded', result: task }, now)
      return { task }
    })
    let current=repository.currentExecution(taskId)
    let externalTaskProvider: 'dingtalk' | 'lark' | undefined
    let blockedCapability: ExternalTaskCapability | undefined
    if(!current)throw Object.assign(new Error('task not found'),{code:'not_found'})
    const prior=repository.operation(taskId,data.idempotencyKey)
    if(action==='retry'&&prior?.status!=='succeeded'){
      const recoveryRequested=Boolean(data.publicQueryRecoveryReceiptId||current.publicQueryRecovery||repository.get(taskId)?.publicQueryRecovery||
        repository.operations(taskId,'browser_public_query_recovery_plan').some(receipt=>receipt.status==='succeeded'))
      if(recoveryRequested){
        // A stalled Task may precede its old Turn's durable terminal update.
        // Do not consume future consent or create a retry while that Turn settles.
        const thread=await threads.get(current.threadId)
        if(!thread)throw Object.assign(new Error('task execution thread not found'),{code:'not_found'})
        if(thread.turns.some(turn=>turn.status==='queued'||turn.status==='running'))throw Object.assign(new Error('a turn is already running for this thread'),{code:'turn_in_progress'})
      }
    }
    if(prior?.status==='prepared'&&action==='retry'){
      repository.beginOperation({ownerId:taskId,idempotencyKey:data.idempotencyKey,kind:action,request:data,nowIso:nowIso()})
      const childId=`task_retry_${createHash('sha256').update(`task:${taskId}:retry:${data.idempotencyKey}`).digest('hex')}`
      const child=repository.get(childId), source=child?.retryOfTaskId?repository.get(child.retryOfTaskId):repository.get(taskId)
      const explicitRecovery=Boolean(data.publicQueryRecoveryReceiptId||child?.publicQueryRecovery||source?.publicQueryRecovery)
      const inheritedRecovery=!explicitRecovery&&source?await this.deps.publicQueryRecovery?.forRetry(source):undefined
      // Ordinary partial retries retain their existing permission-recovery path.
      // A claimed or inherited browser recovery still requires its exact child binding.
      if(explicitRecovery||inheritedRecovery){
        const waiting=this.deps.publicQueryRecovery?.recoverPreparedRetry(taskId,prior,childId)
        if(waiting)return {task:waiting}
      }
    }
    let recovery: Awaited<ReturnType<BrowserPublicQueryRecoveryService['forRetry']>>
    if(prior?.status!=='succeeded'&&action==='retry')recovery=await this.deps.publicQueryRecovery?.forRetry(current,data.publicQueryRecoveryReceiptId)
    if(prior) {
      repository.beginOperation({ownerId:taskId,idempotencyKey:data.idempotencyKey,kind:action,request:data,nowIso:nowIso()})
      if(prior.status==='succeeded') {
        const result=prior.result as TaskControlResult|TaskRun
        const resolved='task' in result ? result : {task:result}
        if ((action==='pause' || action==='cancel') && resolved.task.activeTurnId && current.id===resolved.task.id && current.activeTurnId===resolved.task.activeTurnId) {
          // The DB receipt may commit before the in-process cancellation is delivered.
          // Replay the cancellation for that exact Turn without repeating the state change.
          const thread=await threads.get(resolved.task.threadId)
          const turn=thread?.turns.find(turn=>turn.id===resolved.task.activeTurnId)
          if(turn && ['running','pending'].includes(turn.status)) {
            if(action==='cancel')this.deps.cancelChildRuns?.(resolved.task.threadId,data.reason ?? '用户取消了任务。')
            await turns.interruptTurn({threadId:resolved.task.threadId,turnId:resolved.task.activeTurnId})
          }
        }
        return resolved
      }
      if(prior.status==='failed'||prior.status==='outcome_unknown')throw Object.assign(new Error(prior.error ?? 'previous operation requires inspection'),{code:'outcome_unknown'})
      if(action==='retry')await this.assertRetrySafe(current,recovery?.context.unknowns.map(ref=>ref.id),recovery?.binding,recovery?.context.previousRecovery)
    } else {
      if(current.revision!==data.expectedRevision)throw Object.assign(new Error('task revision conflict'),{code:'stale_request'})
      if((action==='resume'||action==='retry')&&await this.deps.isEngineeringTask?.(current))throw Object.assign(new Error('engineering_plan_typed_resume_required: continue or replan from the approved engineering plan'),{code:'invalid_state'})
      if(action==='retry'&&!['failed','cancelled'].includes(current.status)&&!recovery?.direct)throw Object.assign(new Error('retry is only valid for failed or cancelled tasks'),{code:'invalid_state'})
      if(action==='retry')await this.assertRetrySafe(current,recovery?.context.unknowns.map(ref=>ref.id),recovery?.binding,recovery?.context.previousRecovery)
    }
    if(action==='resume'||action==='retry') {
      // Prove persisted recovery scope before a new control/child/Turn can consume an attempt.
      // Explicit first-use preparation is validated by forRetry against the
      // unconsumed proof; its owner is deliberately not an execution consumer.
      try { if(!recovery?.direct)await this.deps.validateRecoveryExecution?.(current) }
      catch(error) {
        const failure=taskPermissionFailure(error)
        if(action==='resume'&&failure)return this.persistResumeCapability(taskId,current,data,taskPermissionCapability(failure,current,nowIso()))
        throw error
      }
      if (action === 'resume') {
        try { await this.deps.validateTaskPermission?.(current.threadId, current.id) }
        catch (error) {
          const failure = taskPermissionFailure(error)
          if (!failure) throw error
          return this.persistResumeCapability(taskId, current, data, taskPermissionCapability(failure,current,nowIso()))
        }
      }
      if (action === 'resume' && !current.retryOfTaskId && !current.activeTurnId && !repository.inputs(current.id).some(input => input.sourceId === 'capability-original')) {
        const original = StartTurnRequest.safeParse(repository.attention(`capability_${current.id}`)?.payload?.request)
        if (original.success) current = tasks.appendInput(current.id, current.revision, `capability-original:${current.id}`, original.data.prompt, 'supplement', 'capability-original',
          { attachmentIds: original.data.attachmentIds, workspaceReferences: original.data.workspaceReferences, capabilityReferences: original.data.capabilityReferences }).task
      }
      const executionThread = await threads.get(current.threadId)
      if (!executionThread) throw Object.assign(new Error('task execution thread not found'), { code: 'not_found' })
      const capabilities = [current.goal, ...tasks.taskInputs(current.id, true).filter(input => !tasks.approvalForInput(input)).map(input => input.text)]
        .map(text => recovery&&this.deps.preflightRecoveryTask ? this.deps.preflightRecoveryTask(text,externalPreflightThreadContext(executionThread,{mode:'agent'}),recovery.binding) : this.deps.preflightExternalTask ? this.deps.preflightExternalTask(text, externalPreflightThreadContext(executionThread, { mode: 'agent' }), action === 'retry' ? current! : undefined) : preflightExternalTask(text))
      const checked = await Promise.all(capabilities)
      const requiredCapabilities = checked.filter((capability): capability is ExternalTaskCapability => capability !== null)
      const capability = requiredCapabilities.find(item => item.status !== 'available')
      if(capability) {
        if (action === 'resume') return this.persistResumeCapability(taskId, current, data, capability)
        blockedCapability = capability
      }
      const providers = [...new Set(requiredCapabilities.map(item => item.provider).filter((provider): provider is 'lark' | 'dingtalk' => provider === 'lark' || provider === 'dingtalk'))]
      if (providers.length > 1) {
        const first = requiredCapabilities[0]!
        const ambiguity: ExternalTaskCapability = {...first,status:'blocked',errorCode:'multiple_external_providers',
          message:'一个任务的执行授权只能绑定一个外部平台。请将钉钉和飞书请求拆分为两个独立任务。'}
        if (action === 'resume') return this.persistResumeCapability(taskId, current, data, ambiguity)
        blockedCapability = ambiguity
      }
      externalTaskProvider = providers[0]
    }
    if (!prior) repository.beginOperation({ownerId:taskId,idempotencyKey:data.idempotencyKey,kind:action,request:data,nowIso:nowIso()})
    let preparedRetryId:string|undefined
    let retryHistory = ''
    let preparedResume:{previous:TaskRun;revision:number}|undefined
    try {
      if(action==='retry')this.deps.assertRetryContext?.(current)
      if(action==='pause'||action==='cancel') {
        const reason=data.reason ?? (action==='pause'?'用户暂停了任务。':'用户取消了任务。')
        const result=repository.transact(()=>{
          if(action==='cancel'&&['completed','failed'].includes(current!.status))throw Object.assign(new Error(`task cannot be cancelled from ${current!.status}`),{code:'invalid_state'})
          const next=action==='pause' ? current!.status==='paused'?current!:tasks.pauseTask(current!.id,current!.revision,reason) : current!.status==='cancelled'?current!:tasks.cancelTask(current!.id,current!.revision,reason)
          repository.finishOperation(taskId,data.idempotencyKey,{status:'succeeded',result:next},nowIso())
          return {task:next}
        })
        if(action==='pause'&&result.task.activeTurnId)await turns.interruptTurn({threadId:result.task.threadId,turnId:result.task.activeTurnId})
        if(action==='cancel') {
          this.deps.cancelChildRuns?.(result.task.threadId,reason)
          if(result.task.activeTurnId)await turns.interruptTurn({threadId:result.task.threadId,turnId:result.task.activeTurnId})
        }
        return result
      }
      const turnKey=`task:${taskId}:${action}:${data.idempotencyKey}`
      const thread=await threads.get(current.threadId)
      if(!thread)throw Object.assign(new Error('task execution thread not found'),{code:'not_found'})
      if(action==='retry') {
        retryHistory = [tasks.retryHistory(current.id), ...current.artifacts.filter(file => file.storage === 'task').map(file => JSON.stringify({ source_task_id: current!.id, path: file.relativePath, sha256: file.sha256 }))].filter(Boolean).join('\n')
        const retryId=`task_retry_${createHash('sha256').update(turnKey).digest('hex')}`
        current=repository.transact(()=>{
          if(recovery?.direct) current=repository.update(current!.id,current!.revision,value=>({...value,status:'failed',waitingReason:'原公开查询上下文无法核验，已保留未知记录；用户要求另次受限检索。',updatedAt:nowIso()}),{key:`public-query-recovery-terminal:${recovery.binding.receiptId}`,kind:'public_query_context_abandoned',payload:{recoveryReceiptId:recovery.binding.receiptId,unresolved:true}})
          const oneOffBrowserScope=recovery?.binding.mode==='task_reauthorization'?this.deps.publicQueryRecovery!.issueOneOffChildScope(current!,retryId,recovery.binding):undefined
          const retry=tasks.createRetryTask({id:retryId,...(oneOffBrowserScope?{oneOffBrowserScope}:{}),sourceTaskId:current!.id,expectedRevision:current!.revision,thread,retryControl:{ownerId:taskId,idempotencyKey:data.idempotencyKey},...(recovery?{publicQueryRecovery:recovery.binding}:{}),
            request:{prompt:current!.goal,model:data.model ?? current!.model,providerId:current!.providerId,reasoningEffort:current!.reasoningEffort}})
          if(recovery?.direct)this.deps.publicQueryRecovery!.consume(repository.get(recovery.context.taskId)!,retry,recovery.binding)
          return retry
        })
        preparedRetryId=current.id
        try { if (!blockedCapability) {if(recovery)await this.deps.validateRecoveryPermission?.(thread.id);else await this.deps.validateTaskPermission?.(thread.id)} }
        catch(error) {
          const reason=error instanceof Error?error.message:String(error)
          blockedCapability = workspacePermissionCapability((error as {code?:string}).code ?? 'task_permission_revoked', reason)
        }
        if (blockedCapability) {
          const capability = blockedCapability
          return repository.transact(() => {
            const latest = repository.get(current!.id)!
            const now = nowIso()
            const waiting = repository.update(latest.id, latest.revision, task => ({ ...task, status: 'waiting_user', waitingReason: capability.message, updatedAt: now }),
              { key: `retry-permission:${data.idempotencyKey}`, kind: 'task_waiting_user', payload: { reason: capability.message, code: capability.errorCode } })
            repository.putAttention({ id: `capability_${waiting.id}`, ownerKind: 'task', ownerId: waiting.id, taskId: waiting.id,
              threadId: waiting.originThreadId ?? waiting.threadId, workspaceRoot: waiting.workspaceRoot, kind: 'blocked', title: '继续原任务前需要处理',
              message: capability.message, status: 'pending', revision: 0, createdAt: now, updatedAt: now,
              payload: { kind: 'capability_required', capability, request: { prompt: waiting.goal } } })
            const result = { task: waiting, capability }
            repository.finishOperation(taskId, data.idempotencyKey, { status: 'succeeded', result }, now)
            return result
          })
        }
      }
      const oldTurn=thread?.turns.find(turn=>turn.idempotencyKey===turnKey)
      if(action==='resume'&&!oldTurn&&current.status!=='retrying') {
        const previous=current
        current=tasks.prepareResume(current.id,current.revision,data.model)
        preparedResume={previous,revision:current.revision}
        if (detachedApprovalTurnId && thread.turns.some(turn => turn.id === detachedApprovalTurnId && turn.status === 'running')) {
          await turns.finishTurn({ threadId: current.threadId, turnId: detachedApprovalTurnId, status: 'aborted' })
        }
      }
      // Same-task continuation keeps the document references already granted to
      // this execution thread. It never imports attachments from another task.
      const previousTurn = thread.turns.find(turn => turn.id === current!.activeTurnId)
      const attachmentIds = action === 'resume' ? (oldTurn?.attachmentIds ?? [...new Set([
        ...(previousTurn?.attachmentIds ?? []),
        ...repository.inputs(current.id).filter(input => input.consumedAt).flatMap(input => input.attachmentIds ?? [])
      ])].slice(0, 8)) : []
      const checkpoint=repository.latestCheckpoint(current.id)
      const collectionClock = nowIso()
      const observedFeedResume = current.acceptance.webEvidenceBasis === 'observed_feed'
        ? `本轮时间 UTC ${collectionClock}；北京时间 ${new Date(Date.parse(collectionClock) + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00')}。旧来源、旧报告和完成回执仅作为历史素材保留，不代表本轮已采集当前订阅列表。必须先用原任务已授权的原生浏览器工具实际打开并读取当前列表或真实单条记录，再整理、发布并核验本轮报告；不要把 read_task_context 的旧快照当作新读取。公告/列表标注日期按原文保留，与本轮实际采集日期分开。旧空间确已关闭时遵循已有继续授权恢复，不另建任务、不扩大权限、不重复外部副作用。`
        : ''
      const started=await turns.startTurn({threadId:current.threadId,...(externalTaskProvider?{externalTaskProvider}:{}),continuationTaskId:current.id,request:{
        prompt:action==='resume'?['Continue the persisted task from its last verified checkpoint.',`Goal: ${current.goal}`,checkpoint?.resumeSummary?`Checkpoint: ${checkpoint.resumeSummary}`:'',observedFeedResume,'Read persisted task inputs. Reuse completed artifacts and operation receipts. Do not repeat external side effects.'].filter(Boolean).join('\n'):[`Retry the failed persisted task and satisfy its original acceptance contract.\nGoal: ${current.goal}`,tasks.retryHistory(current.id) || (retryHistory ? `Read-only ancestor drafts (read_artifact with source_task_id/path): ${retryHistory}. These are not this Task's writer or source verification. Publish your own corrected file at the same relative filename, re-read source pages and verify it. Do not replay external side effects.` : '')].filter(Boolean).join('\n'),
        displayText:action==='resume'?'继续未完成任务':'重试未完成任务',idempotencyKey:turnKey,model:data.model ?? current.model,providerId:current.providerId,reasoningEffort:current.reasoningEffort,mode:'agent',attachmentIds,
        ...(action === 'resume' ? { capabilityReferences: (oldTurn ?? previousTurn)?.capabilityReferences } : {})
      }})
      const next=repository.findByTurn(started.turnId)
      if(!next)throw new Error('task continuation was not created')
      const result={task:next,turn:started}
      const attention=repository.attention(`capability_${current.id}`)
      if(attention?.status==='pending')repository.putAttention({...attention,status:'answered',revision:attention.revision+1,updatedAt:nowIso()})
      repository.finishOperation(taskId,data.idempotencyKey,{status:'succeeded',result},nowIso())
      if(!oldTurn)void this.deps.runTurn(started.threadId,started.turnId)
      return result
    } catch(error) {
      if(preparedResume)tasks.restorePreparedResume(preparedResume.previous,preparedResume.revision)
      const retry=preparedRetryId?repository.get(preparedRetryId):undefined
      if(retry?.status==='queued'&&!retry.activeTurnId)repository.update(retry.id,retry.revision,task=>({...task,status:'waiting_user',waitingReason:'重试执行尚未启动，请继续原任务。',updatedAt:nowIso()}),
        {key:`retry-start-failed:${data.idempotencyKey}`,kind:'task_waiting_user',payload:{reason:'retry_turn_not_started'}})
      const receipt=repository.operation(taskId,data.idempotencyKey)
      if(receipt&&receipt.status!=='succeeded')repository.finishOperation(taskId,data.idempotencyKey,{status:'failed',error:error instanceof Error?error.message:String(error)},nowIso())
      throw error
    }
  }

  private persistResumeCapability(taskId: string, current: TaskRun, request: TaskControlRequest, capability: ExternalTaskCapability): TaskControlResult {
    const { repository, nowIso } = this.deps
    return repository.transact(() => {
      const latest = repository.currentExecution(taskId)
      if (!latest || latest.id !== current.id || latest.revision !== current.revision) {
        throw Object.assign(new Error('task revision conflict'), { code: 'stale_request' })
      }
      const now = nowIso()
      const attentionId = `capability_${current.id}`
      // Probe timestamps do not create new user work. A changed blocker replaces its pending card.
      const fingerprint = createHash('sha256').update(JSON.stringify({ taskId: current.id, capability: { ...capability, checkedAt: undefined } })).digest('hex')
      const previous = repository.attention(attentionId)
      const same = previous?.status === 'pending' && previous.payload?.resumeFingerprint === fingerprint
      const attentionRevision = same ? previous.revision : (previous?.revision ?? -1) + 1
      const commandId = createHash('sha256').update(`resume-capability:${current.id}:${fingerprint}:${attentionRevision}`).digest('hex').slice(0, 32)
      const threadId = current.originThreadId ?? current.threadId
      repository.beginOperation({ ownerId: taskId, idempotencyKey: request.idempotencyKey, kind: 'resume', request, nowIso: now })
      if (!same) {
        repository.putAttention({ id: attentionId, ownerKind: 'task', ownerId: current.id, taskId: current.id, threadId,
          workspaceRoot: current.workspaceRoot, kind: 'blocked', title: '继续原任务前需要处理', message: capability.message,
          status: 'pending', revision: attentionRevision, createdAt: previous?.status === 'pending' ? previous.createdAt : now, updatedAt: now,
          payload: { kind: 'capability_required', capability, resumeFingerprint: fingerprint, resumeCommandId: commandId, request: { prompt: current.goal } } })
        repository.enqueueOutbox({ id: `command-message:${commandId}`, ownerId: threadId, kind: 'task_command_message', createdAt: now,
          payload: { threadId, commandId, userText: '继续任务', assistantText: capability.message, createdAt: now,
            capabilityCard: { threadId, taskId: current.id, attentionId, prompt: current.goal, capability } } })
      }
      const result = { task: latest, capability, attentionId, receipt: { userMessageItemId: `item_command_${commandId}_user`, resultMessageItemId: `item_command_${commandId}_receipt` } }
      repository.finishOperation(taskId, request.idempotencyKey, { status: 'succeeded', result }, now)
      return result
    })
  }

  /** A new TaskRun must never erase the old operation ledger's uncertainty or repeat writes. */
  private async assertRetrySafe(current:TaskRun,recoveryIds?:string[],recoveryBinding?:import('../contracts/browser-public-query-recovery.js').BrowserPublicQueryRecoveryBinding, previousRecovery?:import('../contracts/browser-public-query-recovery.js').BrowserPublicQueryRecoveryBinding):Promise<void> {
    const {repository}=this.deps,visited=new Set<string>()
    let task:TaskRun|undefined=current
    while(task){
      if(visited.has(task.id))throw Object.assign(new Error('任务重试历史存在循环，请先核对原始执行记录。'),{code:'outcome_unknown'})
      visited.add(task.id)
      for(const receipt of repository.operations(task.id)) {
        if(!['tool','host_shell'].includes(receipt.kind))continue
        const resolution=repository.verifiedOperationResolution(receipt)
        if(['prepared','running','outcome_unknown'].includes(receipt.status)&&!resolution&&!recoveryIds?.includes(receipt.id)&&!recoveryCoversReceipt(repository,receipt,recoveryBinding)&&!recoveryCoversReceipt(repository,receipt,previousRecovery))throw Object.assign(new Error('原任务或其重试历史仍有待核实操作，不能通过创建新任务重放。请先核实原回执。'),{code:'outcome_unknown'})
        const toolName=typeof receipt.request?.toolName==='string'?receipt.request.toolName:receipt.toolName??''
        const spec=this.deps.tasks.describeToolEffect(toolName) ?? externalOperationForTool(toolName)
        const operation=spec?.operation??(typeof receipt.request?.operation==='string'?receipt.request.operation:'')
        const localSchedule = trustedLocalScheduleReceipt(task, receipt) && await this.deps.validateRetryLocalSchedule?.(task, receipt,recoveryBinding) === true
        const localBookkeeping = trustedLocalBookkeepingReceipt(task, receipt)
        const externalWrite=!localSchedule&&!localBookkeeping&&receipt.kind==='tool'&&(['approve','reject','complete','send','transfer','upload'].includes(operation)||!spec&&toolCanProveExternalEffect(toolName))
        const knownNotDispatched=receipt.status==='failed'&&(receipt.result as {approved?:boolean}|undefined)?.approved===false
        if(externalWrite&&!knownNotDispatched&&(receipt.status==='succeeded'||receipt.status==='failed'||['running','outcome_unknown'].includes(receipt.status)||resolution||receipt.dispatchApproval)) {
          throw Object.assign(new Error('原任务已派发过外部写操作，整任务重试可能重复处理同一目标。请保留原回执并核实结果；如需不同操作，请新建目标明确且重新授权的独立任务。'),{code:'external_effect_retry_blocked'})
        }
      }
      if(repository.listShellSessions(task.id).some(session=>['starting','running','outcome_unknown','interrupted'].includes(session.status)))throw Object.assign(new Error('原任务或其重试历史仍有运行中或结果未核实的命令，不能通过新任务重新启动。'),{code:'outcome_unknown'})
      if(!task.retryOfTaskId)break
      const ancestor=repository.get(task.retryOfTaskId)
      if(!ancestor)throw Object.assign(new Error('原任务重试历史缺少执行记录，请先核实历史操作。'),{code:'outcome_unknown'})
      task=ancestor
    }
  }
}

/** Only the exact Runtime-owned Host and immutable original Grant establish built-in provenance. */
function trustedLocalHostOutput(task: TaskRun, receipt: OperationReceipt, provider: string, names: string[]) {
  const request = receipt.request, result = receipt.result as { approved?: boolean; item?: { kind?: string; status?: string; isError?: boolean; toolName?: string; callId?: string; turnId?: string; threadId?: string; output?: unknown } } | undefined
  const item = result?.item, grant = ExecutionGrantSchema.safeParse(request?.executionGrant)
  if (receipt.kind !== 'tool' || request?.providerId !== provider || !names.includes(String(request.toolName)) ||
    receipt.fingerprint !== operationFingerprint(request) || !grant.success || grant.data.taskId !== task.id || grant.data.threadId !== task.threadId ||
    grant.data.turnId !== request.turnId || result?.approved !== true || item?.kind !== 'tool_result' || item.status !== 'completed' ||
    item.toolName !== request.toolName || item.callId !== request.callId || item.turnId !== request.turnId || item.threadId !== task.threadId ||
    grant.data.allowedProviderIds && !grant.data.allowedProviderIds.includes(provider) || grant.data.allowedToolNames && !grant.data.allowedToolNames.includes(item.toolName!)) return undefined
  return { output: item.output && typeof item.output === 'object' ? item.output as Record<string, unknown> : {}, isError: item.isError === true }
}

/** Reading a spill object or updating local progress never writes an external platform. */
function trustedLocalBookkeepingReceipt(task: TaskRun, receipt: OperationReceipt): boolean {
  const todo = trustedLocalHostOutput(task, receipt, 'todo', ['todo_list', 'todo_write'])
  if (todo && receipt.status === 'succeeded' && !todo.isError && ThreadTodoListSchema.nullable().safeParse(todo.output.todos).success) return true
  const context = trustedLocalHostOutput(task, receipt, 'document-delivery', ['read_task_context'])
  return Boolean(context && receipt.status === 'succeeded' && !context.isError && context.output.untrusted === true &&
    typeof context.output.bundleId === 'string' && typeof context.output.objectId === 'string' && typeof context.output.text === 'string' &&
    typeof context.output.sha256 === 'string' && /^[a-f0-9]{64}$/.test(context.output.sha256) &&
    Number.isInteger(context.output.offset) && Number.isInteger(context.output.totalBytes))
}

/** Local persisted plans have their own idempotent server ledger, not a remote write. Same-name MCP tools never qualify. */
function trustedLocalScheduleReceipt(task: TaskRun, receipt: OperationReceipt): boolean {
  const host = trustedLocalHostOutput(task, receipt, 'task-schedule', ['schedule_task', 'list_schedules'])
  if (!host) return false
  const { output } = host
  if (receipt.status === 'failed' && host.isError && ['schedule_authority_changed', 'browser_schedule_action_scope_required'].includes(String(output.code))) return true
  if (receipt.status !== 'succeeded' || host.isError) return false
  const schedule = output.schedule && typeof output.schedule === 'object' ? output.schedule as Record<string, unknown> : undefined
  const schedules = Array.isArray(output.schedules) ? output.schedules : undefined
  const canonical = `schedule_${task.rootTaskId ?? task.id}`
  return receipt.request?.toolName === 'schedule_task' ? schedule?.id === canonical : Boolean(schedules && schedules.every(value => value && typeof value === 'object' && (value as Record<string, unknown>).id === canonical))
}
