import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { makeAssistantTextItem } from '../domain/item.js'
import type { OperationReceipt, ShellSession } from '../contracts/tasks.js'
import { HostShellAuthorizationSchema } from '../contracts/permissions.js'
import { TaskController } from './task-controller.js'
import { TaskRunRepository } from './task-run-repository.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(),'railwise-controller-host-shell-'))
  const repository = new TaskRunRepository(join(root,'tasks.sqlite3'))
  cleanup.push(async()=>{repository.close();await rm(root,{recursive:true,force:true})})
  const threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({id:'thread-shell',title:'synthetic command verification',workspace:root,model:'fixture'})
  await threadStore.upsert(thread)
  let now = '2026-11-10T00:00:00.000Z'
  const controller = new TaskController({repository,threadStore,sessionStore,nowIso:()=>now,ownerId:'shell-test-runtime'})
  const task = controller.ensureTask({thread,turnId:'turn-shell',request:{prompt:'执行本地合成检查并报告结果。'}})
  controller.beginAttempt(thread.id,'turn-shell')
  const receipt = (key:string,status:OperationReceipt['status'],input?:{session?:boolean;output?:Record<string,unknown>;isError?:boolean}) => {
    const token = controller.tokenForTurn(repository.get(task.id)!.activeTurnId!)!
    const authorization = HostShellAuthorizationSchema.parse({id:`authority-${key}`,taskId:task.id,threadId:thread.id,turnId:token.turnId,
      executionId:token.executionId,ownerId:token.ownerId,leaseRevision:token.leaseRevision,executionGrantId:`grant-${token.turnId}`,workspaceRoot:root,
      workspaceRevision:0,agentRevision:0,commandHash:'a'.repeat(64),requestHash:'b'.repeat(64),approvalId:`approval-${key}`,idempotencyKey:key,
      issuedAt:now,expiresAt:'2026-11-10T00:01:00.000Z'})
    const saved = repository.beginOperation({ownerId:task.id,idempotencyKey:key,kind:'host_shell',request:{commandHash:authorization.commandHash,turnId:token.turnId},nowIso:now}).receipt
    if (input?.session) repository.createShellSession({id:`session-${key}`,taskId:task.id,nodeId:task.nodes[0]!.id,workspaceRoot:root,commandSummary:'synthetic check',
      cwd:root,status:'running',pid:token.process.pid,processFingerprint:token.process.fingerprint,ownerId:token.ownerId,executionId:token.executionId,
      outputPath:join(root,`${key}.log`),outputBytes:0,createdAt:now,startedAt:now,revision:0})
    const shell = input?.output || input?.session ? {output:{...(input?.session?{session_id:`session-${key}`,status:'running'}:{}),...input?.output},...(input?.isError?{isError:true}:{})} : undefined
    return repository.finishOperation(task.id,key,{status,result:{authorization,...(shell?{shell}:{})}},now) ?? saved
  }
  const prose = async(turnId=repository.get(task.id)!.activeTurnId!) => sessionStore.appendItem(thread.id,makeAssistantTextItem({id:`prose-${turnId}`,threadId:thread.id,turnId,text:'本地合成检查已处理完毕。',status:'completed'}))
  const resume = (turnId:string) => {
    const current = repository.get(task.id)!
    controller.prepareResume(task.id,current.revision)
    controller.ensureTask({thread,turnId,continuationTaskId:task.id,request:{prompt:'继续核验原命令，禁止重复执行。'}})
    controller.beginAttempt(thread.id,turnId)
  }
  return {root,repository,controller,thread,task,sessionStore,receipt,prose,resume,setNow:(value:string)=>{now=value}}
}

describe('TaskController host command evidence gates',()=>{
  it.each(['outcome_unknown','prepared'] as const)('never completes or resumes a %s command from prose',async status=>{
    const f=await fixture(),operation=f.receipt('unverified',status)
    await f.prose()
    const stalled=await f.controller.assessCandidate(f.thread.id,'turn-shell')
    expect(stalled).toMatchObject({kind:'stalled',task:{status:'stalled'}})
    expect(()=>f.controller.prepareResume(f.task.id,stalled.task.revision)).toThrow(/Verify outstanding/)
    expect(f.repository.operation(f.task.id,'unverified')).toMatchObject({id:operation.id,status})
    expect(f.repository.operations(f.task.id,'host_shell')).toHaveLength(1)
  })

  it('blocks a running command without a known session, even after a different command succeeds',async()=>{
    const f=await fixture()
    const original=f.receipt('lost-session','running')
    f.receipt('newer-success','succeeded',{output:{status:'completed',exit_code:0}})
    await f.prose()
    const stalled=await f.controller.assessCandidate(f.thread.id,'turn-shell')
    expect(stalled.kind).toBe('stalled')
    expect(()=>f.controller.prepareResume(f.task.id,stalled.task.revision)).toThrow(/Verify outstanding/)
    expect(f.repository.operation(f.task.id,'lost-session')?.id).toBe(original.id)
  })

  it('keeps an unknown command stalled when the explanatory model request also fails',async()=>{
    const f=await fixture()
    f.receipt('unknown-on-network-failure','outcome_unknown')
    const decision=f.controller.recordAttemptFailure(f.thread.id,'turn-shell','network_unavailable','synthetic connection loss')!
    expect(decision).toMatchObject({kind:'stalled',task:{status:'stalled'}})
    expect(f.repository.operations(f.task.id,'host_shell')).toHaveLength(1)
  })

  it('lets a later attempt poll one known session, but requires a settled receipt before completion',async()=>{
    const f=await fixture(),operation=f.receipt('background','running',{session:true})
    await f.prose()
    const polling=await f.controller.assessCandidate(f.thread.id,'turn-shell')
    expect(polling).toMatchObject({kind:'continue',task:{status:'retrying'}})
    expect(polling.kind==='continue' && polling.reason).toContain('host_shell_session')
    f.resume('turn-poll')
    const session=f.repository.getShellSession('session-background')!
    f.repository.updateShellSession(session.id,session.revision,current=>({...current,status:'completed',exitCode:0,finishedAt:'2026-11-10T00:00:10.000Z'}))
    await f.prose('turn-poll')
    const stillUnsettled=await f.controller.assessCandidate(f.thread.id,'turn-poll')
    expect(stillUnsettled.kind).toBe('continue')
    const saved=f.repository.operation(f.task.id,'background')!
    const result=saved.result as {authorization:unknown}
    f.repository.finishOperation(f.task.id,'background',{status:'succeeded',result:{...result,shell:{output:{session_id:session.id,status:'completed',exit_code:0,output:'checked'}}}},'2026-11-10T00:00:10.000Z')
    f.resume('turn-verified')
    await f.prose('turn-verified')
    expect(await f.controller.assessCandidate(f.thread.id,'turn-verified')).toMatchObject({kind:'completed',task:{status:'completed'}})
    expect(f.repository.operations(f.task.id,'host_shell')).toHaveLength(1)
    expect(f.repository.operation(f.task.id,'background')?.id).toBe(operation.id)
  })

  it.each([{status:'failed',exit_code:1},{status:'stopped',exit_code:-15}] as const)('does not accept prose after a command is $status',async output=>{
    const f=await fixture()
    f.receipt('not-successful',output.status==='failed'?'failed':'succeeded',{output:{...output},isError:output.status==='failed'})
    await f.prose()
    expect(await f.controller.assessCandidate(f.thread.id,'turn-shell')).toMatchObject({kind:'waiting_user',task:{status:'waiting_user'}})
  })

  it('preserves an earlier failure but allows a newly authorized successful command to close the task',async()=>{
    const f=await fixture()
    f.receipt('failed-original','failed',{output:{status:'failed',exit_code:2},isError:true})
    const failed=f.controller.recordAttemptFailure(f.thread.id,'turn-shell','network_unavailable','explanation request also failed')!
    expect(failed.kind).toBe('waiting_user')
    f.resume('turn-still-unfixed')
    await f.prose('turn-still-unfixed')
    expect((await f.controller.assessCandidate(f.thread.id,'turn-still-unfixed')).kind).toBe('waiting_user')
    f.resume('turn-user-approved-repair')
    f.receipt('new-approved-check','succeeded',{output:{status:'completed',exit_code:0,output:'repair verified'}})
    await f.prose('turn-user-approved-repair')
    expect((await f.controller.assessCandidate(f.thread.id,'turn-user-approved-repair')).kind).toBe('completed')
    expect(f.repository.operations(f.task.id,'host_shell').map(operation=>operation.status)).toEqual(['failed','succeeded'])
  })

  it('keeps a failed command waiting after process exit and restart, rather than dispatching recovery',async()=>{
    const f=await fixture()
    f.receipt('failed-before-crash','failed',{output:{status:'failed',exit_code:1},isError:true})
    const attempt=f.repository.execution.latestAttempt(f.task.id)!
    f.repository.execution.finishAttempt(attempt.executionId,'cancelled','2026-11-10T00:00:30.000Z')
    f.setNow('2026-11-10T00:02:00.000Z')
    const recovered=f.controller.reconcileStartup()
    expect(recovered).toMatchObject([{id:f.task.id,status:'waiting_user'}])
    expect(recovered[0]!.waitingReason).toContain('不会自动重放')
    expect(f.repository.operations(f.task.id,'host_shell')).toHaveLength(1)
  })

  it('rejects a forged or reassigned session as an unknown result',async()=>{
    const f=await fixture()
    f.receipt('wrong-owner','running',{session:true})
    const session=f.repository.getShellSession('session-wrong-owner')!
    f.repository.updateShellSession(session.id,session.revision,current=>({...current,ownerId:'another-runtime'} as ShellSession))
    await f.prose()
    expect((await f.controller.assessCandidate(f.thread.id,'turn-shell')).kind).toBe('stalled')
  })
})
