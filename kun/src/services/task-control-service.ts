import type { TaskRun } from '../contracts/tasks.js'
import type { StartTurnResponse } from '../contracts/turns.js'
import type { TaskController } from './task-controller.js'
import type { TaskRunRepository } from './task-run-repository.js'
import type { ThreadService } from './thread-service.js'
import type { TurnService } from './turn-service.js'

export type TaskControlAction = 'resume' | 'retry' | 'pause' | 'cancel'
export type TaskControlRequest = { expectedRevision:number; idempotencyKey:string; model?:string; reason?:string }
export type TaskControlResult = { task:TaskRun; turn?:StartTurnResponse }

/** One deterministic mutation path for chat commands and the task HTTP API. */
export class TaskControlService {
  private readonly pending = new Map<string,Promise<unknown>>()
  constructor(private readonly deps:{repository:TaskRunRepository;tasks:TaskController;threads:ThreadService;turns:TurnService;runTurn(threadId:string,turnId:string):unknown;cancelChildRuns?(threadId:string,reason:string):unknown;isEngineeringTask?(task:TaskRun):Promise<boolean>;nowIso():string}) {}

  async mutate(taskId:string, action:TaskControlAction, data:TaskControlRequest):Promise<TaskControlResult> {
    const previous=this.pending.get(taskId) ?? Promise.resolve()
    const operation=previous.catch(()=>undefined).then(()=>this.execute(taskId,action,data))
    this.pending.set(taskId,operation)
    try { return await operation } finally { if(this.pending.get(taskId)===operation)this.pending.delete(taskId) }
  }

  private async execute(taskId:string, action:TaskControlAction, data:TaskControlRequest):Promise<TaskControlResult> {
    const {repository,tasks,threads,turns,nowIso}=this.deps
    let current=repository.currentExecution(taskId)
    if(!current)throw Object.assign(new Error('task not found'),{code:'not_found'})
    const prior=repository.operation(taskId,data.idempotencyKey)
    if(prior) {
      repository.beginOperation({ownerId:taskId,idempotencyKey:data.idempotencyKey,kind:action,request:data,nowIso:nowIso()})
      if(prior.status==='succeeded') {
        const result=prior.result as TaskControlResult|TaskRun
        return 'task' in result ? result : {task:result}
      }
      if(prior.status==='failed'||prior.status==='outcome_unknown')throw Object.assign(new Error(prior.error ?? 'previous operation requires inspection'),{code:'outcome_unknown'})
    } else {
      if(current.revision!==data.expectedRevision)throw Object.assign(new Error('task revision conflict'),{code:'stale_request'})
      if((action==='resume'||action==='retry')&&await this.deps.isEngineeringTask?.(current))throw Object.assign(new Error('engineering_plan_typed_resume_required: continue or replan from the approved engineering plan'),{code:'invalid_state'})
      if(action==='retry'&&!['failed','cancelled'].includes(current.status))throw Object.assign(new Error('retry is only valid for failed or cancelled tasks'),{code:'invalid_state'})
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
      const started=await turns.startTurn({threadId:current.threadId,...(action==='resume'?{continuationTaskId:current.id}:{}),request:{
        prompt:action==='resume'?['Continue the persisted task from its last verified checkpoint.',`Goal: ${current.goal}`,checkpoint?.resumeSummary?`Checkpoint: ${checkpoint.resumeSummary}`:'','Read persisted task inputs. Reuse completed artifacts and operation receipts. Do not repeat external side effects.'].filter(Boolean).join('\n'):`Retry the failed persisted task and satisfy its original acceptance contract.\nGoal: ${current.goal}`,
        displayText:action==='resume'?'继续未完成任务':'重试未完成任务',idempotencyKey:turnKey,model:data.model ?? current.model,providerId:current.providerId,reasoningEffort:current.reasoningEffort,mode:'agent'
      }})
      let next=repository.findByTurn(started.turnId)
      if(!next)throw new Error('task continuation was not created')
      if(action==='retry'&&next.id!==current.id&&!next.retryOfTaskId)next=repository.update(next.id,next.revision,task=>({...task,retryOfTaskId:current!.id,rootTaskId:current!.rootTaskId ?? current!.id}),{key:`retry-of:${current.id}`,kind:'task_retried',payload:{previousTaskId:current.id}})
      const result={task:next,turn:started}
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
}
