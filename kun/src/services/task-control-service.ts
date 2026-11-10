import type { TaskRun } from '../contracts/tasks.js'
import type { StartTurnResponse } from '../contracts/turns.js'
import type { TaskController } from './task-controller.js'
import type { TaskRunRepository } from './task-run-repository.js'
import type { ThreadService } from './thread-service.js'
import type { TurnService } from './turn-service.js'
import { preflightExternalTask, type ExternalTaskCapability, type ExternalTaskPreflight } from './external-task-capability.js'
import { externalPreflightThreadContext } from './contextual-external-task-preflight.js'
import { externalOperationForTool } from './external-effect-evidence.js'
import { toolCanProveExternalEffect } from '../loop/turn-completion-guard.js'

export type TaskControlAction = 'resume' | 'retry' | 'pause' | 'cancel'
export type TaskControlRequest = { expectedRevision:number; idempotencyKey:string; model?:string; reason?:string }
export type TaskControlResult = { task:TaskRun; turn?:StartTurnResponse; capability?:ExternalTaskCapability }

/** One deterministic mutation path for chat commands and the task HTTP API. */
export class TaskControlService {
  private readonly pending = new Map<string,Promise<unknown>>()
  constructor(private readonly deps:{repository:TaskRunRepository;tasks:TaskController;threads:ThreadService;turns:TurnService;runTurn(threadId:string,turnId:string):unknown;cancelChildRuns?(threadId:string,reason:string):unknown;isEngineeringTask?(task:TaskRun):Promise<boolean>;preflightExternalTask?:ExternalTaskPreflight;nowIso():string}) {}

  async mutate(taskId:string, action:TaskControlAction, data:TaskControlRequest):Promise<TaskControlResult> {
    const previous=this.pending.get(taskId) ?? Promise.resolve()
    const operation=previous.catch(()=>undefined).then(()=>this.execute(taskId,action,data))
    this.pending.set(taskId,operation)
    try { return await operation } finally { if(this.pending.get(taskId)===operation)this.pending.delete(taskId) }
  }

  private async execute(taskId:string, action:TaskControlAction, data:TaskControlRequest):Promise<TaskControlResult> {
    const {repository,tasks,threads,turns,nowIso}=this.deps
    let current=repository.currentExecution(taskId)
    let externalTaskProvider: 'dingtalk' | 'lark' | undefined
    if(!current)throw Object.assign(new Error('task not found'),{code:'not_found'})
    const prior=repository.operation(taskId,data.idempotencyKey)
    if(prior) {
      repository.beginOperation({ownerId:taskId,idempotencyKey:data.idempotencyKey,kind:action,request:data,nowIso:nowIso()})
      if(prior.status==='succeeded') {
        const result=prior.result as TaskControlResult|TaskRun
        return 'task' in result ? result : {task:result}
      }
      if(prior.status==='failed'||prior.status==='outcome_unknown')throw Object.assign(new Error(prior.error ?? 'previous operation requires inspection'),{code:'outcome_unknown'})
      if(action==='retry')this.assertRetrySafe(current)
    } else {
      if(current.revision!==data.expectedRevision)throw Object.assign(new Error('task revision conflict'),{code:'stale_request'})
      if((action==='resume'||action==='retry')&&await this.deps.isEngineeringTask?.(current))throw Object.assign(new Error('engineering_plan_typed_resume_required: continue or replan from the approved engineering plan'),{code:'invalid_state'})
      if(action==='retry'&&!['failed','cancelled'].includes(current.status))throw Object.assign(new Error('retry is only valid for failed or cancelled tasks'),{code:'invalid_state'})
      if(action==='retry')this.assertRetrySafe(current)
      if(action==='resume'||action==='retry') {
        const executionThread = await threads.get(current.threadId)
        if (!executionThread) throw Object.assign(new Error('task execution thread not found'), { code: 'not_found' })
        const capabilities = [current.goal, ...repository.inputs(current.id, true).map(input => input.text)]
          .map(text => this.deps.preflightExternalTask ? this.deps.preflightExternalTask(text, externalPreflightThreadContext(executionThread, { mode: 'agent' })) : preflightExternalTask(text))
        const checked = await Promise.all(capabilities)
        const requiredCapabilities = checked.filter((capability): capability is ExternalTaskCapability => capability !== null)
        const capability = requiredCapabilities.find(item => item.status !== 'available')
        if(capability) {
          // A blocked recheck is durable but does not allocate a Turn or mark an
          // operation as executed. A fresh command can recheck after connection.
          return {task:current,capability}
        }
        const providers = [...new Set(requiredCapabilities.map(item => item.provider))]
        if (providers.length > 1) {
          const first = requiredCapabilities[0]!
          return { task:current, capability:{...first,status:'blocked',errorCode:'multiple_external_providers',
            message:'一个任务的执行授权只能绑定一个外部平台。请将钉钉和飞书请求拆分为两个独立任务。'} }
        }
        externalTaskProvider = providers[0]
      }
      repository.beginOperation({ownerId:taskId,idempotencyKey:data.idempotencyKey,kind:action,request:data,nowIso:nowIso()})
    }
    let preparedResume:{previous:TaskRun;revision:number}|undefined
    try {
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
      const oldTurn=thread?.turns.find(turn=>turn.idempotencyKey===turnKey)
      if(action==='resume'&&!oldTurn&&current.status!=='retrying') {
        const previous=current
        current=tasks.prepareResume(current.id,current.revision,data.model)
        preparedResume={previous,revision:current.revision}
      }
      const checkpoint=repository.latestCheckpoint(current.id)
      const started=await turns.startTurn({threadId:current.threadId,...(externalTaskProvider?{externalTaskProvider}:{}),...(action==='resume'?{continuationTaskId:current.id}:{}),request:{
        prompt:action==='resume'?['Continue the persisted task from its last verified checkpoint.',`Goal: ${current.goal}`,checkpoint?.resumeSummary?`Checkpoint: ${checkpoint.resumeSummary}`:'','Read persisted task inputs. Reuse completed artifacts and operation receipts. Do not repeat external side effects.'].filter(Boolean).join('\n'):`Retry the failed persisted task and satisfy its original acceptance contract.\nGoal: ${current.goal}`,
        displayText:action==='resume'?'继续未完成任务':'重试未完成任务',idempotencyKey:turnKey,model:data.model ?? current.model,providerId:current.providerId,reasoningEffort:current.reasoningEffort,mode:'agent'
      }})
      let next=repository.findByTurn(started.turnId)
      if(!next)throw new Error('task continuation was not created')
      if(action==='retry'&&next.id!==current.id&&!next.retryOfTaskId)next=repository.update(next.id,next.revision,task=>({...task,retryOfTaskId:current!.id,rootTaskId:current!.rootTaskId ?? current!.id}),{key:`retry-of:${current.id}`,kind:'task_retried',payload:{previousTaskId:current.id}})
      const result={task:next,turn:started}
      const attention=repository.attention(`capability_${current.id}`)
      if(attention?.status==='pending')repository.putAttention({...attention,status:'answered',revision:attention.revision+1,updatedAt:nowIso()})
      repository.finishOperation(taskId,data.idempotencyKey,{status:'succeeded',result},nowIso())
      if(!oldTurn)void this.deps.runTurn(started.threadId,started.turnId)
      return result
    } catch(error) {
      if(preparedResume)tasks.restorePreparedResume(preparedResume.previous,preparedResume.revision)
      const receipt=repository.operation(taskId,data.idempotencyKey)
      if(receipt&&receipt.status!=='succeeded')repository.finishOperation(taskId,data.idempotencyKey,{status:'failed',error:error instanceof Error?error.message:String(error)},nowIso())
      throw error
    }
  }

  /** A new TaskRun must never erase the old operation ledger's uncertainty or repeat writes. */
  private assertRetrySafe(current:TaskRun):void {
    const {repository}=this.deps,visited=new Set<string>()
    let task:TaskRun|undefined=current
    while(task){
      if(visited.has(task.id))throw Object.assign(new Error('任务重试历史存在循环，请先核对原始执行记录。'),{code:'outcome_unknown'})
      visited.add(task.id)
      for(const receipt of repository.operations(task.id)) {
        if(!['tool','host_shell'].includes(receipt.kind))continue
        const resolution=repository.verifiedOperationResolution(receipt)
        if(['prepared','running','outcome_unknown'].includes(receipt.status)&&!resolution)throw Object.assign(new Error('原任务或其重试历史仍有待核实操作，不能通过创建新任务重放。请先核实原回执。'),{code:'outcome_unknown'})
        const toolName=typeof receipt.request?.toolName==='string'?receipt.request.toolName:receipt.toolName??''
        const spec=externalOperationForTool(toolName)
        const operation=spec?.operation??(typeof receipt.request?.operation==='string'?receipt.request.operation:'')
        const externalWrite=receipt.kind==='tool'&&(['approve','reject','complete','send','transfer'].includes(operation)||!spec&&toolCanProveExternalEffect(toolName))
        const knownNotDispatched=receipt.status==='failed'&&!receipt.dispatchApproval&&(receipt.result as {approved?:boolean}|undefined)?.approved===false
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
