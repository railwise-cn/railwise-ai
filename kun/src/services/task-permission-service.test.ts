import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { createThreadRecord } from '../domain/thread.js'
import type { WorkspaceTrustSnapshot } from './workspace-trust-reader.js'
import { TaskController } from './task-controller.js'
import { TaskRunRepository } from './task-run-repository.js'
import { TaskPermissionService } from './task-permission-service.js'
import { ThreadAgentProfileSchema } from '../contracts/threads.js'
import { TurnSchema } from '../contracts/turns.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { LocalToolHost } from '../adapters/tool/local-tool-host.js'
import type { ToolEffectDefinition } from '../ports/tool-effect.js'

const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0))await close()})

async function fixture(toolEffects: ToolEffectDefinition[] = []) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'railwise-task-permission-')))
  const repository=new TaskRunRepository(join(root,'tasks.sqlite3'))
  cleanup.push(async()=>{repository.close();await rm(root,{recursive:true,force:true})})
  const threadStore=new InMemoryThreadStore(),sessionStore=new InMemorySessionStore()
  const origin=createThreadRecord({id:'origin',title:'origin',workspace:root,model:'fixture',approvalPolicy:'never',sandboxMode:'workspace-write'})
  const hidden={...createThreadRecord({id:'hidden',title:'task',workspace:root,model:'fixture',approvalPolicy:'never',sandboxMode:'workspace-write'}),relation:'side' as const,parentThreadId:origin.id}
  await threadStore.upsert(origin);await threadStore.upsert(hidden)
  let now='2026-11-10T00:00:00.000Z',rejectWrite=false
  let workspace:WorkspaceTrustSnapshot={canonicalRoot:root,level:'workspace-write',revision:3}
  const controller=new TaskController({repository,threadStore,sessionStore,nowIso:()=>now})
  const task=controller.createWaitingTask({id:'permission-task',thread:hidden,request:{prompt:'帮我处理飞书待办',taskOriginThreadId:origin.id},reason:'任务审批策略禁止工具执行。'})
  const service=new TaskPermissionService({repository,toolEffects:()=>toolEffects,workspaceTrust:{get:async()=>workspace},nowIso:()=>now,threads:{get:id=>threadStore.get(id),update:async(id,patch)=>{
    if(rejectWrite)throw new Error('synthetic file persistence failure')
    const current=(await threadStore.get(id))!
    return threadStore.upsert({...current,...patch,updatedAt:now})
  }}})
  const request=async(key='permission-1')=>{const snapshot=await service.snapshot(task.id);return {expectedRevision:snapshot.taskRevision,idempotencyKey:key,scopeHash:snapshot.scopeHash,confirmed:true as const,approvalPolicy:'on-request' as const,ttlSeconds:900}}
  return {root,repository,threadStore,origin,hidden,task,controller,service,request,advance:(seconds:number)=>{now=new Date(Date.parse(now)+seconds*1000).toISOString()},setWorkspace:(next:WorkspaceTrustSnapshot)=>{workspace=next},rejectWrite:(value:boolean)=>{rejectWrite=value}}
}


async function retryTask(f:Awaited<ReturnType<typeof fixture>>,status:'failed'|'cancelled'='failed') {
  const source=f.repository.get(f.task.id)!
  if(status==='cancelled')f.controller.cancelTask(source.id,source.revision,'synthetic cancellation')
  else f.repository.update(source.id,source.revision,task=>({...task,status:'failed'}))
  const terminal=f.repository.get(source.id)!
  return f.controller.createRetryTask({id:'retry-task',sourceTaskId:terminal.id,expectedRevision:terminal.revision,
    thread:(await f.threadStore.get(f.hidden.id))!,request:{prompt:terminal.goal}})
}

describe('task-only finite approval permission',()=>{
  it('retains an unexpired failed-task permission by original ownership and consumes it only once across retries',async()=>{
    const f=await fixture()
    const confirmed=await f.service.confirm(f.task.id,{...await f.request(),duration:'next_operation',scope:{readPaths:[f.root],providerIds:['lark-cli']}})
    const original=confirmed.task.authority!.taskApprovalGrant!
    const retry=await retryTask(f)
    expect(retry.authority?.taskApprovalGrant).toBeUndefined()
    expect(await f.service.executionRestriction(f.hidden.id)).toEqual({taskPermissionId:original.id,expiresAt:original.expiresAt,permissionScope:original.scope,permissionDuration:'next_operation'})
    expect((await f.service.snapshot(retry.id)).grant).toMatchObject({id:original.id,status:'active'})
    await f.service.claimOperation(f.hidden.id,original.id,'retry-operation')
    expect(f.repository.get(f.task.id)!.authority!.taskApprovalGrant).toMatchObject({taskId:f.task.id,consumedOperationId:'retry-operation',expiresAt:original.expiresAt})
    expect(f.repository.get(retry.id)!.authority!.taskApprovalGrant).toBeUndefined()
    await expect(f.service.claimOperation(f.hidden.id,original.id,'different-operation')).rejects.toMatchObject({code:'task_permission_consumed'})
  })

  it.each(['cancelled','revoked','expired','consumed','workspace','agent'] as const)('keeps %s permissions unusable through retry',async reason=>{
    const f=await fixture()
    const confirmed=await f.service.confirm(f.task.id,{...await f.request(),duration:'next_operation'})
    const permissionId=confirmed.permission.grant!.id
    if(reason==='consumed')await f.service.claimOperation(f.hidden.id,permissionId,'old-operation')
    if(reason==='expired')f.advance(901)
    if(reason==='workspace')f.setWorkspace({canonicalRoot:f.root,level:'workspace-write',revision:4})
    if(reason==='agent')await f.threadStore.upsert({...((await f.threadStore.get(f.hidden.id))!),agentRevision:8})
    if(reason==='revoked')f.repository.update(f.task.id,confirmed.task.revision,task=>({...task,authority:{...task.authority!,revokedAt:'2026-11-10T00:00:01Z'}}))
    const retry=await retryTask(f,reason==='cancelled'?'cancelled':'failed')
    await expect(f.service.executionRestriction(f.hidden.id)).rejects.toMatchObject({code:reason==='expired'?'task_permission_expired':reason==='consumed'?'task_permission_consumed':'task_permission_revoked'})
    expect((await f.service.snapshot(retry.id)).grant?.status).toBe(reason==='expired'?'expired':reason==='consumed'?'consumed':'invalid')
    expect(f.repository.get(f.task.id)?.authority?.taskApprovalGrant?.id).toBe(permissionId)
  })

  it('allows a fresh explicit retry permission to replace an expired inherited permission without modifying the ancestor',async()=>{
    const f=await fixture()
    const confirmed=await f.service.confirm(f.task.id,await f.request())
    f.advance(901)
    const retry=await retryTask(f)
    f.repository.update(retry.id,retry.revision,task=>({...task,status:'waiting_user'}))
    const review=await f.service.snapshot(retry.id)
    expect(review.canConfirm).toBe(true)
    const renewed=await f.service.confirm(retry.id,{expectedRevision:review.taskRevision,scopeHash:review.scopeHash,idempotencyKey:'renew-retry',confirmed:true,approvalPolicy:'on-request',ttlSeconds:60})
    expect(renewed.permission.grant?.id).not.toBe(confirmed.permission.grant?.id)
    expect(f.repository.get(f.task.id)!.authority!.taskApprovalGrant?.expiresAt).toBe(confirmed.permission.grant?.expiresAt)
    await expect(f.service.executionRestriction(f.hidden.id)).resolves.toMatchObject({taskPermissionId:renewed.permission.grant?.id})
    await expect(f.service.executionRestriction(f.hidden.id,confirmed.permission.grant!.id)).rejects.toMatchObject({code:'task_permission_revoked'})
  })

  it('refuses permission inheritance after the reviewed retry contract changes',async()=>{
    const f=await fixture()
    await f.service.confirm(f.task.id,await f.request())
    const retry=await retryTask(f)
    f.repository.update(retry.id,retry.revision,task=>({...task,goal:'另一个任务的目标'}))
    await expect(f.service.executionRestriction(f.hidden.id)).rejects.toMatchObject({code:'task_permission_revoked'})
  })

  it('shows registered tool scope requirements for mixed file and effect tasks', async () => {
    const f = await fixture([{ provider: 'lark', operation: 'send', mutation: true, targetFields: ['recipient'], requiredScopes: ['mail:user_mailbox.message:send'] }])
    f.repository.update(f.task.id, f.task.revision, task => ({ ...task, acceptance: { ...task.acceptance, kind: 'files', effect: {
      provider: 'lark', operation: 'send', target: 'synthetic@example.test', requiredScopes: [], requiresConfirmation: true, successStatus: ['succeeded'], verification: 'provider_readback'
    } } }))
    expect((await f.service.snapshot(f.task.id)).connectorScopeSources).toEqual([{ provider: 'lark', scopes: ['mail:user_mailbox.message:send'], source: 'tool_catalog' }])
  })
  it('persists explicit task scopes with canonical paths and exact network origins', async () => {
    const f = await fixture()
    f.repository.update(f.task.id, f.task.revision, task => ({ ...task, authority: { ...task.authority!, externalTargets: [JSON.stringify(['lark', 'complete', 'task-42'])] } }))
    const request = { ...await f.request(), duration: 'task' as const, scope: {
      readPaths: [f.root], writePaths: [join(f.root, 'reports')], networkOrigins: ['https://example.com:443'],
      providerIds: ['lark-cli'], externalTargets: [JSON.stringify(['lark', 'complete', 'task-42'])]
    } }
    const result = await f.service.confirm(f.task.id, request)
    expect(await f.service.executionRestriction(f.hidden.id)).toMatchObject({ permissionDuration: 'task', permissionScope: {
      ...request.scope, networkOrigins: ['https://example.com']
    } })
    expect(result.permission.grant?.scope?.writePaths).toEqual([join(f.root, 'reports')])
    expect((await f.threadStore.get(f.origin.id))?.approvalPolicy).toBe('never')
  })

  it('revokes a reviewed scope durably and makes the previous immutable Grant unusable', async () => {
    const f = await fixture()
    const confirmed = await f.service.confirm(f.task.id,{...await f.request(),scope:{writePaths:[f.root]}})
    const permissionId=confirmed.permission.grant!.id
    const request={expectedRevision:confirmed.task.revision,permissionId,idempotencyKey:'revoke-original'}
    const revoked=await f.service.revoke(f.task.id,request)
    expect(revoked.permission.grant).toMatchObject({id:permissionId,status:'invalid'})
    await expect(f.service.executionRestriction(f.hidden.id,permissionId)).rejects.toMatchObject({code:'task_permission_revoked'})
    expect(await f.service.revoke(f.task.id,request)).toEqual(revoked)
    expect(f.repository.operations(f.task.id,'task_permission_revoke')).toHaveLength(1)
    expect(f.repository.get(f.task.id)?.authority?.taskApprovalGrant?.revokedAt).toBeDefined()
  })

  it('replaces an idle task scope with a new immutable permission and rejects the old Grant identity', async () => {
    const f = await fixture()
    const first = await f.service.confirm(f.task.id, {...await f.request('initial-path'), scope:{writePaths:[f.root]}})
    const replacement = await f.service.confirm(f.task.id, {...await f.request('revised-path'), scope:{writePaths:[join(f.root,'reports')]}})
    expect(replacement.permission.grant?.id).not.toBe(first.permission.grant?.id)
    await expect(f.service.executionRestriction(f.hidden.id,first.permission.grant!.id)).rejects.toMatchObject({code:'task_permission_revoked'})
    expect(await f.service.executionRestriction(f.hidden.id,replacement.permission.grant!.id)).toMatchObject({permissionScope:{writePaths:[join(f.root,'reports')]}})
    expect(replacement.task.status).toBe('waiting_user')
  })

  it('keeps an explicit read-only thread as a hard limit when granting a task path', async () => {
    const f = await fixture()
    await f.threadStore.upsert({...f.hidden,sandboxMode:'read-only'})
    expect((await f.service.snapshot(f.task.id)).canWritePaths).toBe(false)
    await expect(f.service.confirm(f.task.id,{...await f.request(),scope:{writePaths:[f.root]}})).rejects.toMatchObject({code:'sandbox_read_only'})
    expect(f.repository.operations(f.task.id)).toHaveLength(0)
  })

  it('rejects invalid scopes and grants a bounded task-only exception for an external read-only workspace', async () => {
    const f = await fixture()
    const credentialUrl = new URL('https://example.invalid')
    credentialUrl.username = 'test-user'
    credentialUrl.password = 'synthetic-password'
    for (const scope of [{ readPaths: ['../elsewhere'] }, { providerIds: ['*'] }, { networkOrigins: [credentialUrl.href] }, { networkOrigins: ['https://example.com/private'] }]) {
      await expect(f.service.confirm(f.task.id, { ...await f.request(), scope })).rejects.toThrow()
    }
    f.setWorkspace({ canonicalRoot: f.root, level: 'read-only', revision: 4 })
    const confirmed = await f.service.confirm(f.task.id, { ...await f.request(), scope: { writePaths: [f.root] } })
    expect(confirmed.task.authority?.taskApprovalGrant).toMatchObject({workspaceWriteException:true,scope:{writePaths:[f.root]}})
    expect(await f.service.executionRestriction(f.hidden.id)).toMatchObject({workspaceWriteException:true})
    expect(confirmed.permission.workspaceTrust).toBe('read-only')
  })

  it('consumes one-operation permission after approval, preserves it on rejection, and never returns it after unknown results', async () => {
    const f = await fixture()
    const confirmed = await f.service.confirm(f.task.id, { ...await f.request(), duration: 'next_operation' })
    const permissionId = confirmed.permission.grant!.id
    let dispatched = 0
    const host = new LocalToolHost({ tools: [{ name: 'fixture_write', description: 'Synthetic operation', inputSchema: { type: 'object' },
      toolKind: 'tool_call', policy: 'on-request', execute: async () => { dispatched++; throw new Error('Connection lost after dispatch') }
    }] })
    const context = { threadId: f.hidden.id, turnId: 'turn', workspace: f.root, sandboxMode: 'workspace-write' as const,
      approvalPolicy: 'on-request' as const, abortSignal: new AbortController().signal,
      awaitApproval: async () => 'deny' as const,
      validateExecutionGrant: async () => { await f.service.executionRestriction(f.hidden.id, permissionId) },
      claimTaskPermission: () => f.service.claimOperation(f.hidden.id, permissionId, 'operation-1')
    }
    await host.execute({ callId: 'first', toolName: 'fixture_write', arguments: {} }, context)
    expect(dispatched).toBe(0)
    expect((await f.service.snapshot(f.task.id)).grant?.status).toBe('active')
    await host.execute({ callId: 'second', toolName: 'fixture_write', arguments: {} }, { ...context, awaitApproval: async () => 'allow' as const })
    expect(dispatched).toBe(1)
    expect((await f.service.snapshot(f.task.id)).grant?.status).toBe('consumed')
    await expect(f.service.claimOperation(f.hidden.id, permissionId, 'operation-1')).resolves.toBeUndefined()
    await expect(f.service.claimOperation(f.hidden.id, permissionId, 'operation-2')).rejects.toMatchObject({ code: 'task_permission_consumed' })
    await expect(f.service.executionRestriction(f.hidden.id)).rejects.toMatchObject({ code: 'task_permission_consumed' })
    await expect(f.service.executionRestriction(f.hidden.id, permissionId)).resolves.toMatchObject({ taskPermissionId: permissionId })
  })

  it('permits only one competing operation across service instances sharing SQLite', async () => {
    const f = await fixture()
    const confirmed = await f.service.confirm(f.task.id, { ...await f.request(), duration: 'next_operation' })
    const otherRepository = new TaskRunRepository(join(f.root, 'tasks.sqlite3'))
    cleanup.push(async () => otherRepository.close())
    const other = new TaskPermissionService({ repository: otherRepository, workspaceTrust: { get: async () => ({ canonicalRoot: f.root, level: 'workspace-write', revision: 3 }) },
      nowIso: () => '2026-11-10T00:00:00.000Z', threads: { get: id => f.threadStore.get(id), update: async () => { throw new Error('No update expected') } } })
    const outcomes = await Promise.allSettled([
      f.service.claimOperation(f.hidden.id, confirmed.permission.grant!.id, 'operation-a'),
      other.claimOperation(f.hidden.id, confirmed.permission.grant!.id, 'operation-b')
    ])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1)
  })
  it('derives visible authority ceilings from persisted task, Agent and workspace records without changing permissions',async()=>{
    const f=await fixture()
    const profile=ThreadAgentProfileSchema.parse({id:'reviewer',name:'项目审阅 Agent',role:'review',color:'blue',systemPrompt:'Review project tasks.',trustLevel:'read-only',
      toolAllowlist:['lark_task_list','lark_task_get'],mcpAllowlist:['mcp-project','mcp-other'],revision:7,budget:{maxAttempts:3,maxDurationMs:60000}})
    await f.threadStore.upsert({...f.hidden,sandboxMode:'danger-full-access',agentProfile:profile,agentRevision:7})
    f.repository.update(f.task.id,f.task.revision,current=>({...current,authority:{...current.authority!,toolAllowlist:['lark_task_list'],mcpAllowlist:['mcp-project'],externalTargets:['project-only']},
      acceptance:{...current.acceptance,kind:'effect',effect:{provider:'lark',operation:'complete',target:'task-42',requiredScopes:['task:task:read','task:task:write'],requiresConfirmation:true,successStatus:['succeeded'],verification:'provider_readback'}}}))
    const snapshot=await f.service.snapshot(f.task.id)
    expect(snapshot).toMatchObject({workspaceRoot:f.root,workspaceTrust:'workspace-write',workspaceRevision:3,agentRevision:7,agentName:'项目审阅 Agent',agentTrust:'read-only',sandboxMode:'read-only',approvalPolicy:'never',
      toolAllowlist:['lark_task_list'],mcpAllowlist:['mcp-project'],externalTargets:['project-only',JSON.stringify(['lark','complete','task-42'])],
      connectorScopeSources:[{provider:'lark',scopes:['task:task:read','task:task:write'],source:'task_requirements'}]})
    expect(snapshot).not.toHaveProperty('availableTools')
    expect(f.repository.operations(f.task.id)).toHaveLength(0)
    expect((await f.threadStore.get(f.hidden.id))?.approvalPolicy).toBe('never')
    const request=await f.request()
    await expect(f.service.confirm(f.task.id,{...request,agentTrust:'full-access',toolAllowlist:['*']} as never)).rejects.toThrow()
    expect(f.repository.operations(f.task.id)).toHaveLength(0)
  })

  it('labels actual prior server Grant scopes as historical and does not infer provider authorization',async()=>{
    const f=await fixture()
    expect((await f.service.snapshot(f.task.id)).connectorScopeSources).toEqual([])
    const grant=ExecutionGrantSchema.parse({id:'prior-grant',taskId:f.task.id,threadId:f.hidden.id,turnId:'prior-turn',workspaceRoot:f.root,workspaceTrust:'workspace-write',agentTrust:'full-access',approvalPolicy:'on-request',sandboxMode:'workspace-write',
      connectorScopes:['task:task:read'],allowedProviderIds:['lark-cli'],workspaceRevision:3,agentRevision:0,revision:3,idempotencyKey:'prior-grant',issuedAt:'2026-11-09T00:00:00.000Z',expiresAt:'2026-11-09T00:15:00.000Z'})
    const turn=TurnSchema.parse({id:'prior-turn',threadId:f.hidden.id,prompt:'读取飞书待办',status:'completed',createdAt:'2026-11-09T00:00:00.000Z',executionGrant:grant,externalTaskProvider:'lark'})
    await f.threadStore.upsert({...f.hidden,turns:[turn]})
    expect((await f.service.snapshot(f.task.id)).connectorScopeSources).toEqual([{provider:'lark',scopes:['task:task:read'],source:'last_execution_grant',issuedAt:'2026-11-09T00:00:00.000Z',expiresAt:'2026-11-09T00:15:00.000Z'}])
    await f.threadStore.upsert({...f.hidden,turns:[{...turn,executionGrant:{...grant,taskId:'another-task'}}]})
    expect((await f.service.snapshot(f.task.id)).connectorScopeSources).toEqual([])
  })

  it('confirms only the hidden task policy without starting a Turn or changing origin, sandbox or workspace trust',async()=>{
    const f=await fixture(),snapshot=await f.service.snapshot(f.task.id),request=await f.request()
    expect(snapshot).toMatchObject({canConfirm:true,approvalPolicy:'never',targetApprovalPolicy:'on-request',workspaceRoot:f.root,maxTtlSeconds:900})
    const result=await f.service.confirm(f.task.id,request)
    expect(result).toMatchObject({resumed:false,task:{status:'waiting_user',attempts:0,authority:{approvalPolicy:'on-request',taskApprovalGrant:{status:'active',confirmed:true,expiresAt:'2026-11-10T00:15:00.000Z'}}},permission:{canConfirm:true,grant:{status:'active'}}})
    expect((await f.threadStore.get(f.hidden.id))).toMatchObject({approvalPolicy:'on-request',sandboxMode:'workspace-write',turns:[]})
    expect(await f.threadStore.get(f.origin.id)).toEqual(f.origin)
    expect(f.repository.operations(f.task.id,'task_permission')).toMatchObject([{status:'succeeded',request:{confirmed:true,scopeHash:snapshot.scopeHash,approvalPolicy:'on-request',ttlSeconds:900}}])
    await expect(f.service.executionRestriction(f.hidden.id)).resolves.toMatchObject({taskPermissionId:result.permission.grant!.id,expiresAt:'2026-11-10T00:15:00.000Z'})
    expect((await f.service.confirm(f.task.id,request)).permission.grant!.id).toBe(result.permission.grant!.id)
    await expect(f.service.confirm(f.task.id,{...request,ttlSeconds:60})).rejects.toMatchObject({code:'idempotency_conflict'})
  })

  it('requires an explicit true confirmation and rejects stale scope/revision after workspace or Agent changes',async()=>{
    const f=await fixture(),request=await f.request()
    await expect(f.service.confirm(f.task.id,{...request,confirmed:false} as never)).rejects.toThrow()
    f.setWorkspace({canonicalRoot:f.root,level:'workspace-write',revision:4})
    await expect(f.service.confirm(f.task.id,request)).rejects.toMatchObject({code:'stale_request'})
    const updated=await f.request()
    await f.threadStore.upsert({...f.hidden,agentRevision:1})
    await expect(f.service.confirm(f.task.id,updated)).rejects.toMatchObject({code:'stale_request'})
    expect(f.repository.operations(f.task.id,'task_permission')).toHaveLength(0)
  })

  it('refuses a running task, an active attempt, unknown tool work and an origin chat',async()=>{
    const f=await fixture()
    const current=f.repository.get(f.task.id)!
    f.repository.update(current.id,current.revision,task=>({...task,status:'running'}))
    expect((await f.service.snapshot(f.task.id)).canConfirm).toBe(false)
    const waiting=f.repository.get(f.task.id)!
    f.repository.update(waiting.id,waiting.revision,task=>({...task,status:'waiting_user'}))
    const attached=f.controller.ensureTask({thread:f.hidden,turnId:'active-turn',continuationTaskId:f.task.id,request:{prompt:'继续'}})
    f.controller.beginAttempt(f.hidden.id,'active-turn')
    f.repository.update(attached.id,f.repository.get(attached.id)!.revision,task=>({...task,status:'waiting_user'}))
    expect((await f.service.snapshot(f.task.id)).reason).toContain('活跃执行')
    f.controller.endRun('active-turn')
    const operation=f.repository.beginOperation({ownerId:f.task.id,idempotencyKey:'unknown',kind:'tool',request:{},nowIso:'2026-11-10T00:00:00.000Z'}).receipt
    f.repository.finishOperation(f.task.id,operation.idempotencyKey,{status:'outcome_unknown'},'2026-11-10T00:00:00.000Z')
    expect((await f.service.snapshot(f.task.id)).reason).toContain('待核实')
    const legacy=f.repository.create({...f.repository.get(f.task.id)!,id:'origin-task',threadId:f.origin.id,originThreadId:undefined,activeTurnId:undefined,nodes:[]})
    expect((await f.service.snapshot(legacy.id)).reason).toContain('独立执行上下文')
  })

  it('expires, rejects old Grant identities and can be explicitly renewed without deleting earlier receipts',async()=>{
    const f=await fixture(),first=await f.service.confirm(f.task.id,await f.request())
    f.advance(901)
    await expect(f.service.executionRestriction(f.hidden.id,first.permission.grant!.id)).rejects.toMatchObject({code:'task_permission_expired'})
    expect(await f.service.snapshot(f.task.id)).toMatchObject({canConfirm:true,grant:{status:'expired'}})
    const renewed=await f.service.confirm(f.task.id,await f.request('permission-2'))
    expect(renewed.permission.grant!.id).not.toBe(first.permission.grant!.id)
    await expect(f.service.executionRestriction(f.hidden.id,first.permission.grant!.id)).rejects.toMatchObject({code:'task_permission_revoked'})
    await expect(f.service.executionRestriction(f.hidden.id,renewed.permission.grant!.id)).resolves.toMatchObject({taskPermissionId:renewed.permission.grant!.id})
    expect(f.repository.operations(f.task.id,'task_permission')).toHaveLength(2)
  })

  it.each(['workspace','agent','revocation'] as const)('blocks dispatch after %s authority changes',async change=>{
    const f=await fixture(),result=await f.service.confirm(f.task.id,await f.request())
    if(change==='workspace')f.setWorkspace({canonicalRoot:f.root,level:'read-only',revision:4})
    if(change==='agent')await f.threadStore.upsert({...f.hidden,approvalPolicy:'on-request',agentRevision:1})
    if(change==='revocation') {const task=f.repository.get(f.task.id)!;f.repository.update(task.id,task.revision,current=>({...current,authority:{...current.authority!,revokedAt:'2026-11-10T00:00:01.000Z'}}))}
    await expect(f.service.executionRestriction(f.hidden.id,result.permission.grant!.id)).rejects.toMatchObject({code:'task_permission_revoked'})
  })

  it('leaves an interrupted cross-store confirmation unusable and supports a new explicit review',async()=>{
    const f=await fixture()
    f.rejectWrite(true)
    await expect(f.service.confirm(f.task.id,await f.request())).rejects.toThrow('synthetic file persistence failure')
    expect(f.repository.operations(f.task.id,'task_permission')).toMatchObject([{status:'outcome_unknown'}])
    await expect(f.service.executionRestriction(f.hidden.id)).rejects.toMatchObject({code:'task_permission_revoked'})
    expect(await f.service.snapshot(f.task.id)).toMatchObject({canConfirm:true,grant:{status:'prepared'}})
    f.rejectWrite(false)
    const fixed=await f.service.confirm(f.task.id,await f.request('fresh-review'))
    expect(fixed.permission.grant?.status).toBe('active')
    expect(f.repository.operations(f.task.id,'task_permission').map(receipt=>receipt.status)).toEqual(['failed','succeeded'])
    expect(f.repository.operations(f.task.id,'task_permission')[0]).toMatchObject({result:{previousStatus:'outcome_unknown',supersededBy:fixed.permission.grant!.id}})
    expect(f.repository.unsettledOperations(f.task.id)).toHaveLength(0)
  })
})
