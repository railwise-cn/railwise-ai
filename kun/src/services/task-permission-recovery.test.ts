import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { TaskController } from './task-controller.js'
import { taskPermissionCapability, taskPermissionFailure } from './task-permission-recovery.js'
import { CapabilityPreflightSchema } from '../contracts/harness.js'
import { TaskRunRepository } from './task-run-repository.js'

const recoveryCodes=['browser_public_query_recovery_changed','browser_public_query_fresh_scope_required',
  'browser_binding_changed','browser_schedule_authority_changed','schedule_authority_changed']
const dispose:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{while(dispose.length)await dispose.pop()!()})

it.each([
  ['browser_binding_changed','browser-skill','task/browser-binding'],
  ['browser_public_query_recovery_changed','browser-skill','task/public-query-recovery'],
  ['browser_public_query_fresh_scope_required','browser-skill','task/public-query-recovery'],
  ['browser_schedule_authority_changed','schedule','flow/known-plan'],
  ['schedule_authority_changed','schedule','flow/known-plan']
] as const)('maps %s to its typed %s review surface', (code,provider,route)=>{
  const task={scheduledBy:{scheduleId:'known-plan',dueAt:'2026-11-16T00:30:00.000Z'}}
  const result=taskPermissionCapability({code,message:code},task,'2026-11-16T01:00:00.000Z')
  expect(CapabilityPreflightSchema.parse(result)).toMatchObject({provider,errorCode:code,resolution:{route},checkedAt:'2026-11-16T01:00:00.000Z'})
  expect(result.action).toEqual(result.resolution)
  expect(result.message).not.toBe(code)
  expect(taskPermissionCapability({code,message:'保留具体阻断原因'},task).message).toBe('保留具体阻断原因')
})
it.each(['browser_schedule_authority_changed','schedule_authority_changed'])('routes %s without a known plan to schedule review',code=>{
  expect(taskPermissionCapability({code,message:'请审阅周期范围'},{})).toMatchObject({provider:'schedule',resolution:{route:'task/schedule-review'}})
})
it('retains the workspace permission surface for actual workspace failures',()=>{
  expect(taskPermissionCapability({code:'workspace_path_blocked',message:'目标路径超出范围'},{})).toMatchObject({
    provider:'workspace',message:'目标路径超出范围',resolution:{route:'task-permissions'}})
})

it.each(recoveryCodes)('preserves the concrete deterministic recovery failure %s',code=>{
  const error=Object.assign(new Error('公开查询恢复范围已变化。'),{code})
  expect(taskPermissionFailure(error)).toEqual({code,message:error.message})
})
it.each(['model_timeout','browser_navigation_timeout','browser_context_stale','permission_denied','turn_attempt_exception'])(
  'does not classify unrelated or retryable %s as a permission failure',code=>{
    expect(taskPermissionFailure(Object.assign(new Error('Synthetic error'),{code}))).toBeNull()
  }
)
it.each([false,true])('waits once for recovery scope failure afterAttempt=%s without exhausting attempts or changing old unknowns',async afterAttempt=>{
  const root=await mkdtemp(join(tmpdir(),'recovery-permission-stop-')),repository=new TaskRunRepository(join(root,'tasks.sqlite3'))
  dispose.push(async()=>{repository.close();await rm(root,{recursive:true,force:true})})
  const threadStore=new InMemoryThreadStore(),sessionStore=new InMemorySessionStore(),now='2026-11-16T01:00:00.000Z'
  const thread=createThreadRecord({id:'scheduled-retry-thread',title:'Synthetic scheduled retry',workspace:root,model:'synthetic'})
  await threadStore.upsert(thread)
  const controller=new TaskController({repository,threadStore,sessionStore,nowIso:()=>now,ownerId:'synthetic-runtime'})
  const task=controller.ensureTask({thread,turnId:'scheduled-retry-turn',request:{prompt:'继续同一公开检索计划'}})
  repository.beginOperation({ownerId:'old-recovery-owner',idempotencyKey:'old-unknown',kind:'tool',request:{toolName:'browser_click'},nowIso:now})
  repository.finishOperation('old-recovery-owner','old-unknown',{status:'outcome_unknown',error:'Synthetic prior unknown'},now)
  const oldUnknown=JSON.stringify(repository.operations('old-recovery-owner'))
  if(afterAttempt)controller.beginAttempt(thread.id,'scheduled-retry-turn')
  const error=Object.assign(new Error('公开查询恢复范围已变化。'),{code:'browser_public_query_recovery_changed'})
  const result=controller.blockTaskPermission(thread.id,'scheduled-retry-turn',error)
  expect(result).toMatchObject({kind:'waiting_user',task:{status:'waiting_user',attempts:afterAttempt?1:0,budget:task.budget}})
  expect(controller.blockTaskPermission(thread.id,'scheduled-retry-turn',error)).toMatchObject({kind:'waiting_user',task:{attempts:afterAttempt?1:0}})
  expect(repository.inbox()).toHaveLength(1)
  expect(repository.attention(`capability_${task.id}`)?.payload?.capability).toMatchObject({provider:'browser-skill',errorCode:error.code,message:error.message,
    resolution:{route:'task/public-query-recovery'}})
  expect(repository.events(task.id).filter(e=>['attempt_retrying','task_replanned','task_failed'].includes(e.kind))).toHaveLength(0)
  expect(JSON.stringify(repository.operations('old-recovery-owner'))).toBe(oldUnknown)
  controller.endRun('scheduled-retry-turn')
})
