import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { BrowserPublicQueryRecoveryService } from './browser-public-query-recovery.js'
import type { BrowserOperationVerificationService } from './browser-operation-verification.js'
import { TaskRunRepository, operationFingerprint as fp } from './task-run-repository.js'
import type { TaskRun, OperationReceipt } from '../contracts/tasks.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { assertRecoveryGrant, publicQueryRecoveryForPlan, recoveryCoversReceipt, recoveryExecutionScope, verifiedPublicQueryRecovery, type PublicQueryRecoveryContext } from './browser-public-query-recovery-proof.js'
import type { BrowserPublicQueryRecoveryBinding } from '../contracts/browser-public-query-recovery.js'

// Synthetic persisted-contract unit tests. Runtime/CLI provenance is covered separately.
const dispose: Array<()=>Promise<unknown>>=[]
afterEach(async()=>{while(dispose.length)await dispose.pop()!()})
const now='2026-11-15T12:00:00.000Z', identity='b'.repeat(64), goal='使用BrowserSkill公开检索工程测量公告，生成HTML，每天九点前。'
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'public-query-recovery-proof-')),repo=new TaskRunRepository(join(root,'tasks.sqlite3'))
  dispose.push(async()=>{repo.connection().close();await rm(root,{recursive:true,force:true})})
  const acceptance:TaskRun['acceptance']={kind:'files',requiredNodeKinds:['execute','verify','deliver'],requireFinalResponse:true,requireActionableArtifactCard:true,requiredFormats:['html'],minimumArtifacts:1,requiresWebEvidence:true}
  const schedule={kind:'daily' as const,times:['09:00'],timezone:'Asia/Shanghai',leadMinutes:30}
  function task(id:string,extra:Partial<TaskRun>={}):TaskRun{return {id,threadId:`thread-${id}`,originThreadId:'origin',workspaceRoot:'/workspace',goal,status:'stalled',agentId:'general',childTaskIds:[],acceptance,budget:{maxAttempts:8,maxDurationMs:1800000,version:2,maxExecutionMs:1800000},attempts:1,replans:0,noProgressCount:0,nodes:[],artifacts:[],createdAt:now,updatedAt:now,revision:0,...extra}}
  repo.create(task('source',{status:'failed',acceptance:{...acceptance,schedule}}))
  const save=(ownerId:string,key:string,kind:string,request:Record<string,unknown>,status:OperationReceipt['status']='succeeded',result?:unknown)=>{repo.beginOperation({ownerId,idempotencyKey:key,kind,request,nowIso:now});return repo.finishOperation(ownerId,key,{status,...(result!==undefined?{result}:{})},now)}
  const bind=repo.beginOperation({ownerId:'source',idempotencyKey:'bind',kind:'browser_binding',request:{confirmed:true,publicQueryAuthorization:'schedule',interaction:'interact',browserInstanceId:'browser',expectedBrowserRevision:1,origins:['https://public.test']},nowIso:now}).receipt
  const authorization={receiptId:bind.id,purposeHash:fp({purpose:goal}),duration:'schedule' as const,requirementHash:fp({requirement:schedule})}
  const scope={browserInstanceId:'browser',revision:1,origins:['https://public.test'],interaction:'interact' as const,verificationPolicy:'public_query_target' as const,publicQueryAuthorization:authorization}
  repo.finishOperation('source','bind',{status:'succeeded',result:{taskId:'source',browserInstanceId:'browser',browserRevision:1,interaction:'interact',purpose:goal,origins:scope.origins,verificationPolicy:'public_query_target',publicQueryAuthorization:authorization}},now)
  const authority={source:'user' as const,workspaceRoot:'/workspace',externalTargets:[],grantedAt:now,browserScope:scope}
  repo.update('source',0,t=>({...t,authority}))
  let owner=repo.create(task('occurrence',{activeTurnId:'old-turn',authority,scheduledBy:{scheduleId:'schedule_source',dueAt:now}}))
  const plan={scheduleId:'schedule_source',versionId:'version-1',scopeHash:'d'.repeat(64),sourceTaskId:'source',actionsHash:fp([])}
  const grant=ExecutionGrantSchema.parse({id:'old-grant',taskId:owner.id,threadId:owner.threadId,turnId:'old-turn',workspaceRoot:'/workspace',workspaceTrust:'read-only',agentTrust:'full-access',approvalPolicy:'on-request',sandboxMode:'read-only',browserScope:scope,browserScheduleBinding:plan,connectorIdentityFingerprints:{'browser-skill':identity},allowedToolNames:['browser_session_start','browser_observe','browser_get_html','browser_navigate','browser_read','browser_click','publish_artifact','read_artifact','verify_web_artifact','request_host_shell','send_message'],allowedProviderIds:['browser-skill','managed-artifacts','host-shell','mcp:send'],pathAllowlist:[],networkAllowlist:scope.origins,connectorScopes:[],externalTargets:[],workspaceRevision:0,agentRevision:0,revision:0,idempotencyKey:'old-grant',issuedAt:now,expiresAt:'2026-11-15T12:15:00.000Z'})
  const actionRequest={taskId:owner.id,sourceTaskId:'source',turnId:'old-turn',grantId:grant.id,binding:plan,scopeAuthorizationReceiptId:bind.id,purposeHash:authorization.purposeHash,requirementHash:authorization.requirementHash,sessionId:'old-session',pageUrl:'https://public.test/query',elementHash:'a'.repeat(64),action:'click',browserInstanceId:'browser',browserRevision:1,verificationPolicy:'public_query_target',contextHash:'c'.repeat(64),rule:'search_trigger'}
  const scoped=repo.beginOperation({ownerId:owner.id,idempotencyKey:'scope',kind:'browser_scope_action_authorization',request:actionRequest,nowIso:now}).receipt
  const actionResult={id:fp(actionRequest),authorizationSource:'task_scope',scopeAuthorizationReceiptId:bind.id,sourceTaskId:'source',verificationPolicy:'public_query_target',access:'public_query',accountState:'unknown',summary:'Synthetic exact public search'}
  repo.finishOperation(owner.id,'scope',{status:'succeeded',result:actionResult},now)
  const derivedRequest={...actionRequest,actionId:actionResult.id,scopeActionReceiptId:scoped.id}
  save(owner.id,`browser-derived-scope-action:${fp(derivedRequest)}`,'browser_derived_action_authorization',derivedRequest,'succeeded',{...actionResult,scopeActionReceiptId:scoped.id})
  const hostRequest={providerId:'browser-skill',toolName:'browser_click',turnId:'old-turn',callId:'call-old',argumentsHash:'args-old',executionGrant:grant}
  const host=save(owner.id,'host','tool',hostRequest,'outcome_unknown',{approved:true,item:{kind:'tool_result',status:'completed',isError:true,toolName:'browser_click',callId:'call-old',turnId:'old-turn',threadId:owner.threadId,output:{status:'outcome_unknown',provider:'browser-skill',action:'click'}}})
  const dispatch=save(owner.id,'dispatch','browser_action_dispatch',{...actionRequest,toolName:'browser_click',argumentsHash:'args-old',scopeActionReceiptId:scoped.id,scopeAuthorizationReceiptId:bind.id},'outcome_unknown',{})
  const lock=save('source','lock','browser_schedule_action_outcome',{...plan,taskId:owner.id,turnId:'old-turn',action:'click'},'outcome_unknown')
  const context:PublicQueryRecoveryContext={taskId:owner.id,threadId:owner.threadId,sourceTaskId:'source',goalHash:fp(goal),acceptanceHash:fp(owner.acceptance),sourceAcceptanceHash:fp(repo.get('source')!.acceptance),authorityHash:fp(owner.authority),browserScope:scope,browserIdentity:identity,unknowns:[host,dispatch,lock].map(r=>({ownerId:r.ownerId,id:r.id,kind:r.kind,fingerprint:r.fingerprint})),sessionIds:['old-session'],grantIds:[grant.id],allowedToolNames:grant.allowedToolNames!.filter(n=>!['request_host_shell','send_message'].includes(n)),allowedProviderIds:grant.allowedProviderIds!,plan}
  const audit=repo.beginOperation({ownerId:owner.id,idempotencyKey:'recovery',kind:'browser_public_query_recovery',request:{expectedRevision:0,idempotencyKey:'recovery',confirmed:true,context},nowIso:now}).receipt
  const binding:BrowserPublicQueryRecoveryBinding={ownerTaskId:owner.id,sourceTaskId:'source',receiptId:audit.id,scopeHash:fp(context),browserIdentity:identity,scheduleId:plan.scheduleId,versionId:plan.versionId,planScopeHash:plan.scopeHash}
  owner=repo.update(owner.id,owner.revision,t=>({...t,publicQueryRecovery:binding}))
  repo.finishOperation(owner.id,'recovery',{status:'succeeded',result:{binding,preparedTaskRevision:owner.revision}},now)
  owner=repo.update(owner.id,owner.revision,t=>({...t,status:'failed'}))
  const control=repo.beginOperation({ownerId:owner.id,idempotencyKey:'retry','kind':'retry',request:{expectedRevision:1,publicQueryRecoveryReceiptId:audit.id},nowIso:now}).receipt
  let child=repo.create(task('retry',{threadId:owner.threadId,status:'running',activeTurnId:'new-turn',authority,scheduledBy:owner.scheduledBy,rootTaskId:owner.id,retryOfTaskId:owner.id,publicQueryRecovery:binding}))
  child=repo.update(child.id,child.revision,t=>t,{key:'retried',kind:'task_retried',payload:{retryOfTaskId:owner.id,rootTaskId:owner.id},createdAt:now})
  repo.finishOperation(owner.id,control.idempotencyKey,{status:'succeeded',result:{task:child}},now)
  save(owner.id,'use','browser_public_query_recovery_use',{recoveryReceiptId:audit.id,scopeHash:binding.scopeHash,retryTaskId:child.id},'succeeded',{unresolved:true})
  save('source','link','browser_public_query_recovery_plan',{recoveryReceiptId:audit.id,ownerTaskId:owner.id,scopeHash:binding.scopeHash},'succeeded',{binding})
  const scopeInput={browserScope:scope,browserPublicQueryRecovery:binding,browserScheduleBinding:plan,connectorIdentityFingerprints:{'browser-skill':identity},allowedToolNames:grant.allowedToolNames,allowedProviderIds:grant.allowedProviderIds,networkAllowlist:['*'],connectorScopes:[],externalTargets:['external-write']}
  const mutate=(row:OperationReceipt,change:Partial<OperationReceipt>)=>repo.connection().prepare('UPDATE operation_receipts SET data_json=? WHERE owner_id=? AND idempotency_key=?').run(JSON.stringify({...row,...change}),row.ownerId,row.idempotencyKey)
  return {repo,owner,child,grant,host,dispatch,lock,context,binding,scopeInput,mutate,save}
}
it('keeps all three unknown rows unresolved while narrowing only a fresh proven retry Grant',async()=>{
  const f=await fixture(), raw=[f.host,f.dispatch,f.lock].map(r=>JSON.stringify(r))
  expect(verifiedPublicQueryRecovery(f.repo,f.binding)).toBeTruthy()
  expect([f.host,f.dispatch,f.lock].every(r=>recoveryCoversReceipt(f.repo,r,f.binding))).toBe(true)
  const scope=recoveryExecutionScope(f.repo,f.child,f.scopeInput,Date.parse(now))
  expect(scope.allowedProviderIds).toEqual(['browser-skill','managed-artifacts'])
  expect(scope.allowedToolNames).not.toContain('request_host_shell');expect(scope.allowedToolNames).not.toContain('send_message')
  expect(scope.externalTargets).toEqual([]);expect(scope.networkAllowlist).toEqual(['https://public.test'])
  const fresh=ExecutionGrantSchema.parse({...f.grant,...scope,id:'fresh',taskId:f.child.id,turnId:'new-turn',issuedAt:now})
  expect(()=>assertRecoveryGrant(f.repo,fresh)).not.toThrow()
  expect(()=>recoveryExecutionScope(f.repo,f.owner,f.scopeInput,Date.parse(now))).toThrow()
  expect([f.host,f.dispatch,f.lock].map(r=>JSON.stringify(f.repo.operations(r.ownerId).find(x=>x.id===r.id)))).toEqual(raw)
  expect([f.host,f.dispatch,f.lock].map(r=>f.repo.verifiedOperationResolution(r))).toEqual([undefined,undefined,undefined])
})
it.each(['provider','payload','scope','derived','use'] as const)('rejects tampered %s provenance instead of treating a future-consent flag as proof',async field=>{
  const f=await fixture()
  if(field==='provider')f.mutate(f.host,{request:{...f.host.request,providerId:'mcp:browser'}})
  if(field==='payload')f.mutate(f.host,{result:{approved:true,item:{kind:'tool_result',status:'completed',isError:true,callId:'call-old',turnId:'old-turn',threadId:f.owner.threadId,output:{status:'failed',provider:'browser-skill'}}}})
  if(field==='scope')f.binding={...f.binding,planScopeHash:'f'.repeat(64)}
  if(field==='derived'){const row=f.repo.operations(f.owner.id,'browser_derived_action_authorization')[0]!;f.mutate(row,{status:'failed'})}
  if(field==='use'){const row=f.repo.operations(f.owner.id,'browser_public_query_recovery_use')[0]!;f.mutate(row,{status:'failed'})}
  expect(verifiedPublicQueryRecovery(f.repo,f.binding)).toBeUndefined();expect(recoveryCoversReceipt(f.repo,f.lock,f.binding)).toBe(false)
})
it('does not cover another due lock or inherit a different plan/version/identity',async()=>{
  const f=await fixture(), other=f.save('source','other','browser_schedule_action_outcome',{...f.lock.request,taskId:'another-due'},'outcome_unknown')
  expect(recoveryCoversReceipt(f.repo,other,f.binding)).toBe(false)
  const base={sourceTaskId:'source',scheduleId:'schedule_source',versionId:'version-1',scopeHash:f.binding.planScopeHash!,browserIdentity:identity}
  expect(publicQueryRecoveryForPlan(f.repo,base)).toEqual(f.binding)
  for(const patch of [{versionId:'version-2'},{scheduleId:'another-plan'},{browserIdentity:'f'.repeat(64)},{scopeHash:'0'.repeat(64)}])expect(publicQueryRecoveryForPlan(f.repo,{...base,...patch})).toBeUndefined()
})
it('rejects a new external unknown and forbids widening an otherwise valid recovered Grant',async()=>{
  const f=await fixture()
  const scope=recoveryExecutionScope(f.repo,f.child,f.scopeInput,Date.parse(now))
  const fresh=ExecutionGrantSchema.parse({...f.grant,...scope,id:'fresh',taskId:f.child.id,turnId:'new-turn',issuedAt:now})
  expect(()=>assertRecoveryGrant(f.repo,{...fresh,allowedProviderIds:['browser-skill','mcp:send']})).toThrow()
  expect(()=>assertRecoveryGrant(f.repo,{...fresh,allowedToolNames:['request_host_shell']})).toThrow()
  expect(()=>assertRecoveryGrant(f.repo,{...fresh,taskId:f.owner.id})).toThrow()
  f.save(f.owner.id,'business-unknown','tool',{providerId:'lark-cli',toolName:'send_message'},'outcome_unknown')
  expect(verifiedPublicQueryRecovery(f.repo,f.binding)).toBeUndefined()
})

it('keeps shorter expiry and narrow or empty network scope, and rejects missing or non-source tool lists',async()=>{
  const f=await fixture(),tenSeconds='2026-11-15T12:00:10.000Z'
  const narrow=recoveryExecutionScope(f.repo,f.child,{...f.scopeInput,expiresAt:tenSeconds,networkAllowlist:['public.test']},Date.parse(now))
  expect(narrow.expiresAt).toBe(tenSeconds);expect(narrow.networkAllowlist).toEqual(['https://public.test'])
  expect(recoveryExecutionScope(f.repo,f.child,{...f.scopeInput,networkAllowlist:[]},Date.parse(now)).networkAllowlist).toEqual([])
  expect(recoveryExecutionScope(f.repo,f.child,{...f.scopeInput,networkAllowlist:['https://other.test']},Date.parse(now)).networkAllowlist).toEqual([])
  const fresh=ExecutionGrantSchema.parse({...f.grant,...narrow,id:'fresh',taskId:f.child.id,turnId:'new-turn',issuedAt:now})
  expect(()=>assertRecoveryGrant(f.repo,{...fresh,allowedToolNames:undefined})).toThrow()
  // browser_extract belongs to the general recovery set but was absent from this original Grant.
  expect(()=>assertRecoveryGrant(f.repo,{...fresh,allowedToolNames:[...fresh.allowedToolNames!,'browser_extract']})).toThrow()
})

it('settles only the exact queued recovery child after a crash, retaining unknown rows and requiring separate continuation',async()=>{
  const f=await fixture(),control=f.repo.operations(f.owner.id,'retry')[0]!
  f.mutate(control,{status:'prepared',result:undefined})
  let child=f.repo.update(f.child.id,f.child.revision,t=>({...t,status:'queued',activeTurnId:undefined}))
  f.repo.update(f.owner.id,f.owner.revision,t=>t,{key:'abandoned',kind:'public_query_context_abandoned',payload:{recoveryReceiptId:f.binding.receiptId,unresolved:true}})
  f.repo.putAttention({id:`unknown_${f.owner.id}`,ownerKind:'task',ownerId:f.owner.id,taskId:f.owner.id,threadId:f.owner.threadId,kind:'blocked',title:'旧结果未知',message:'旧结果未知',status:'pending',revision:0,createdAt:now,updatedAt:now,payload:{operationIds:[f.host.id,f.dispatch.id]}})
  const service=new BrowserPublicQueryRecoveryService({repository:f.repo,verification:{} as BrowserOperationVerificationService,nowIso:()=>now,browserIdentity:()=>identity,validatePlan:async()=>{}})
  const raw=[f.host,f.dispatch,f.lock].map(r=>JSON.stringify(r))
  const waiting=service.recoverPreparedRetry(f.owner.id,{...control,status:'prepared',result:undefined},child.id)!
  expect(waiting.id).toBe(child.id);expect(waiting.status).toBe('waiting_user');expect(waiting.activeTurnId).toBeUndefined()
  expect(f.repo.operations(f.owner.id,'retry')[0]!.status).toBe('succeeded')
  expect(f.repo.attention(`unknown_${f.owner.id}`)?.status).toBe('answered')
  expect(f.repo.attention(`unknown_${f.owner.id}`)?.payload?.unresolved).toBe(true)
  expect([f.host,f.dispatch,f.lock].map(r=>JSON.stringify(f.repo.operations(r.ownerId).find(x=>x.id===r.id)))).toEqual(raw)
  expect(verifiedPublicQueryRecovery(f.repo,f.binding)).toBeTruthy()
  child=f.repo.update(child.id,waiting.revision,t=>({...t,status:'running',activeTurnId:'new-turn'}))
  expect(()=>service.recoverPreparedRetry(f.owner.id,{...control,status:'prepared',result:undefined},child.id)).toThrow('outcome_unknown')
})

it('does not advertise a restart exception for a task-duration query without a sealed plan',async()=>{
  const f=await fixture()
  const once=f.repo.create({...f.owner,id:'once',threadId:'once-thread',rootTaskId:undefined,retryOfTaskId:undefined,publicQueryRecovery:undefined,status:'stalled',revision:0})
  const host=f.save(once.id,'once-host','tool',{...f.host.request,executionGrant:{...f.grant,taskId:once.id,threadId:once.threadId,browserScheduleBinding:undefined}},'outcome_unknown',f.host.result)
  const dispatch=f.save(once.id,'once-dispatch','browser_action_dispatch',{...f.dispatch.request,taskId:once.id},'outcome_unknown')
  const review=f.save(once.id,'once-review','browser_action_review',{originalReceiptId:host.id,originalFingerprint:host.fingerprint},'failed')
  f.mutate(review,{error:'not_found'})
  // This stub isolates the negative eligibility boundary; real native proof is
  // exercised by the independent Runtime/Flow test, not fabricated here.
  const verification={publicQueryRecoveryProof:async()=>({receipt:host,dispatch,original:{...f.grant,browserScheduleBinding:undefined},scoped:{authority:{source:once,authorization:{duration:'task'}}}})} as unknown as BrowserOperationVerificationService
  const service=new BrowserPublicQueryRecoveryService({repository:f.repo,verification,nowIso:()=>now,browserIdentity:()=>identity,validatePlan:async()=>{throw new Error('must not inspect a nonexistent plan')}})
  expect(await service.snapshot(once.id)).toMatchObject({state:'unavailable',reason:'browser_public_query_schedule_scope_required'})
  expect(f.repo.operations(once.id,'browser_public_query_recovery')).toEqual([])
})

it('does not consume the due consent again when settling an interrupted ordinary Root retry',async()=>{
  const f=await fixture(),source=f.repo.get('source')!
  const control=f.repo.beginOperation({ownerId:source.id,idempotencyKey:'root-retry',kind:'retry',request:{expectedRevision:source.revision,idempotencyKey:'root-retry'},nowIso:now}).receipt
  let child=f.repo.create({...source,id:'root-retry',rootTaskId:source.id,retryOfTaskId:source.id,status:'queued',activeTurnId:undefined,revision:0,publicQueryRecovery:f.binding})
  child=f.repo.update(child.id,child.revision,t=>t,{key:'root-retried',kind:'task_retried',payload:{retryOfTaskId:source.id,rootTaskId:source.id},createdAt:now})
  const previousUse=JSON.stringify(f.repo.operations(f.owner.id,'browser_public_query_recovery_use'))
  const service=new BrowserPublicQueryRecoveryService({repository:f.repo,verification:{} as BrowserOperationVerificationService,nowIso:()=>now,browserIdentity:()=>identity,validatePlan:async()=>{}})
  expect(service.recoverPreparedRetry(source.id,control,child.id)).toMatchObject({id:child.id,status:'waiting_user'})
  expect(JSON.stringify(f.repo.operations(f.owner.id,'browser_public_query_recovery_use'))).toBe(previousUse)
  expect(f.repo.operations(source.id,'retry')[0]!.status).toBe('succeeded')
  expect(()=>recoveryExecutionScope(f.repo,f.repo.get(child.id)!,f.scopeInput,Date.parse(now))).not.toThrow()
})
