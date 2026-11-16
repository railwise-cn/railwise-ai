import { createTurnRecord } from '../../domain/turn.js'
import type { TurnItem } from '../../contracts/items.js'
import { createEgoBrowserFixture } from '../../../tests/ego-browser-test-fixture.js'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserExecutionScope } from '../../contracts/browser-skill.js'
import { KunCapabilitiesConfig } from '../../contracts/capabilities.js'
import { EGO_TOOLS } from '../../contracts/ego-browser.js'
import { buildEgoBrowserToolProvider, egoReadScript, egoFinishScript, egoSpaceStatusScript } from './ego-browser-tool-provider.js'
import { validEgoDocumentEvidence, validEgoNavigationProgress, verifiedEgoTaskSpaceFinish } from '../../services/ego-browser-evidence.js'
import { operationFingerprint } from '../../services/task-run-repository.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { EGO_PERMISSION_CODES, taskPermissionCapability, taskPermissionFailure } from '../../services/task-permission-recovery.js'
const clean:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{while(clean.length)await clean.pop()!()})
const html='<body><article><h2>测绘监测项目</h2><time>2026-11-16</time></article><a href="https://feed.test/list?page=2">下一页</a></body>'
const date='2026-11-16T00:00:00.000Z'
const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
async function fixture(){const f=await createEgoBrowserFixture();clean.push(f.dispose);return f}
describe('Ego controlled read protocol; no external CLI/browser',()=>{
 it('preserves legacy absent-provider/config bytes',()=>{const legacy={browserInstanceId:'legacy',origins:['https://feed.test'],interaction:'observe' as const,revision:0};expect(BrowserExecutionScope.parse(legacy)).toEqual(legacy);expect(KunCapabilitiesConfig.parse({})).not.toHaveProperty('egoBrowser')})
 it('persists one server TaskSpace and sealed source reads',async()=>{
  const f=await fixture(),out=await f.execute('ego_browser_open',{url:'https://feed.test/list'})
  expect(out).toMatchObject({status:'succeeded',provider:'ego-browser',sourceKind:'actual_ego_document',readScope:'document',resultHash:hash(html)});expect(validEgoDocumentEvidence(f.repo,f.task,out,f.grant())).toBe(true)
  await f.execute('ego_browser_read');expect(f.calls[1]?.spaceId).toBe(7);expect(f.calls[1]?.spaceName).toBe(f.calls[0]?.spaceName);expect(f.repo.operations(f.task.id,'ego_task_space')).toHaveLength(1)
  for(const bad of [{...out,html:html+'forged'},{...out,evidence:{...(out.evidence as object),taskSpaceId:8}},{...out,resultHash:'b'.repeat(64)}])expect(validEgoDocumentEvidence(f.repo,f.task,bad,f.grant())).toBe(false)
  expect(validEgoDocumentEvidence(f.repo,{...f.task,id:'other'},out,f.grant())).toBe(false)
 })
 it('requires sealed actual new-page progress before releasing read storm counts',async()=>{
  const f=await fixture(),out=await f.execute('ego_browser_open',{url:'https://feed.test/list'})
  const call=(n:number,toolName:string)=>({callId:'call-'+n,toolName,providerId:'ego-browser',arguments:{}})
  expect(validEgoNavigationProgress(f.repo,f.task,out,f.grant(),call(1,'ego_browser_open'))).toBe(true)
  let repeated=await f.execute('ego_browser_open',{url:'https://feed.test/list'})
  expect(validEgoNavigationProgress(f.repo,f.task,repeated,f.grant(),call(2,'ego_browser_open'))).toBe(false)
  f.setHtml(html.replace('测绘监测项目','第二页测绘项目'))
  repeated=await f.execute('ego_browser_next_page',{observationId:repeated.observationId,targetId:(repeated.nextPages as Array<{targetId:string}>)[0]!.targetId})
  expect(validEgoNavigationProgress(f.repo,f.task,repeated,f.grant(),call(3,'ego_browser_next_page'))).toBe(true)
  expect(validEgoNavigationProgress(f.repo,f.task,{...repeated,evidence:{}},f.grant(),call(3,'ego_browser_next_page'))).toBe(false)
  expect(validEgoDocumentEvidence(f.repo,f.task,{...repeated,sourceUrl:'bad url'},f.grant())).toBe(false)
 })
 it('reads a no-link element under fresh server context and preserves element scope',async()=>{
  const f=await fixture(),opened=await f.execute('ego_browser_open',{url:'https://feed.test/list'}),out=await f.execute('ego_browser_read',{selector:'article',observationId:opened.observationId})
  expect(out).toMatchObject({status:'succeeded',readScope:'element',evidence:{selection:{selector:'article',matchedCount:1}}});expect(validEgoDocumentEvidence(f.repo,f.task,out,f.grant())).toBe(true)
  expect(validEgoDocumentEvidence(f.repo,f.task,{...out,readScope:'document'},f.grant())).toBe(false)
  const before=f.calls.length;expect(await f.execute('ego_browser_read',{selector:'article',observationId:opened.observationId})).toMatchObject({code:'ego_browser_observation_stale'});expect(f.calls).toHaveLength(before);expect(f.repo.operations(f.task.id,'ego_browser_wait')).toHaveLength(0);expect(await f.execute('ego_browser_observe')).toMatchObject({status:'succeeded'})
 })
 it('requires observed same-origin next links and stops after ten navigations',async()=>{
  const f=await fixture();let out=await f.execute('ego_browser_open',{url:'https://feed.test/list'})
  expect(await f.execute('ego_browser_next_page',{observationId:out.observationId,targetId:'forged'})).toMatchObject({code:'ego_browser_observation_stale'})
  for(let i=1;i<10;i++)out=await f.execute('ego_browser_next_page',{observationId:out.observationId,targetId:(out.nextPages as Array<{targetId:string}>)[0]!.targetId})
  expect(f.calls).toHaveLength(10);expect(await f.execute('ego_browser_next_page',{observationId:out.observationId,targetId:(out.nextPages as Array<{targetId:string}>)[0]!.targetId})).toMatchObject({code:'ego_browser_page_limit'});expect(f.calls).toHaveLength(10)
 })
 it('does not open a model-invented same-origin business URL',async()=>{const f=await fixture();expect(await f.execute('ego_browser_open',{url:'https://feed.test/logout'})).toMatchObject({code:'ego_browser_target_required'});expect(f.calls).toHaveLength(0);expect(f.repo.operations(f.task.id,'ego_task_space')).toHaveLength(0)})
 it('rejects model JS/spaceId and exposes no click/form tools',async()=>{const f=await fixture();expect(f.provider.tools.map(t=>t.name)).toEqual(EGO_TOOLS);expect(await f.execute('ego_browser_open',{url:'https://feed.test/list',spaceId:999,code:'fetch("evil")'})).toMatchObject({status:'blocked'});expect(f.calls).toHaveLength(0)})
 it.each(['expired','scope','identity'] as const)('blocks %s before CLI',async boundary=>{const f=await fixture(),g=f.grant();f.setGrant(boundary==='expired'?{...g,expiresAt:date}:boundary==='identity'?{...g,connectorIdentityFingerprints:{'ego-browser':'b'.repeat(64)}}:{...g,browserScope:{...g.browserScope!,provider:undefined}});expect(await f.execute('ego_browser_open',{url:'https://feed.test/list'})).toMatchObject({status:'blocked'});expect(f.calls).toHaveLength(0)})
 it('records takeover without changing Task and resumes same Space only in a new user Turn',async()=>{
  const f=await fixture();await f.execute('ego_browser_open',{url:'https://feed.test/list'});f.setOwnership('user');expect(await f.execute('ego_browser_read')).toMatchObject({code:'ego_browser_user_control'})
  const count=f.calls.length;expect(await f.execute('ego_browser_observe')).toMatchObject({code:'ego_browser_waiting_user'});expect(f.calls).toHaveLength(count);expect(f.repo.get(f.task.id)?.status).toBe('running')
  f.setGrant({...f.grant(),id:'new-grant',turnId:'new-user-turn'});f.repo.update(f.task.id,0,t=>({...t,activeTurnId:'new-user-turn'}));f.setOwnership('agent');expect(await f.execute('ego_browser_read')).toMatchObject({status:'succeeded'});expect(f.calls.at(-1)?.spaceId).toBe(7);expect(f.repo.operations(f.task.id,'ego_task_space')).toHaveLength(1)
 })
 it('records a real in-flight expiry with its saved Host proof without reacquiring an expired closure',async()=>{const f=await fixture();f.setExpireDuringRun();expect(await f.execute('ego_browser_open',{url:'https://feed.test/list'})).toMatchObject({code:'ego_browser_grant_expired'});expect(f.calls).toHaveLength(1);expect(f.repo.operations(f.task.id,'ego_browser_wait')).toEqual([expect.objectContaining({status:'succeeded',request:expect.objectContaining({hostOperationId:expect.any(String),callId:'call-1',code:'ego_browser_grant_expired'})})])})
 it('never silently retries an uncertain first open',async()=>{const f=await fixture();f.setThrown();expect(await f.execute('ego_browser_open',{url:'https://feed.test/list'})).toMatchObject({code:'ego_browser_command_timeout'});expect(await f.execute('ego_browser_open',{url:'https://feed.test/list'})).toMatchObject({code:'ego_browser_waiting_user'});expect(f.calls).toHaveLength(1);f.setGrant({...f.grant(),id:'new-grant',turnId:'resumed'});f.setThrown(false);f.repo.update(f.task.id,0,t=>({...t,activeTurnId:'resumed'}));expect(await f.execute('ego_browser_open',{url:'https://feed.test/list'})).toMatchObject({status:'succeeded'});expect(f.calls).toHaveLength(2);expect(f.calls.at(-1)?.recoverExistingOnly).toBe(true)})
 it('routes hard failures to original Task while stale observations remain repairable',()=>{for(const code of EGO_PERMISSION_CODES){const failure=taskPermissionFailure({code});expect(failure).not.toBeNull();expect(taskPermissionCapability(failure!,{})).toMatchObject({provider:'ego-browser',resolution:{route:'task/ego-browser-review'}})}expect(taskPermissionFailure({code:'ego_browser_observation_stale'})).toBeNull()})
 it('fixed scripts have exact-match read selectors and no model code/credential/business APIs',()=>{const s=egoReadScript({action:'read',selector:'article'});expect(s).toContain('querySelectorAll(argumentsSelection)');expect(s).toContain('matches.length!==1');for(const bad of ['page.fill(','page.click(','page.fetch(','page.cdp(','document.cookie','localStorage','claimTaskSpace','takeOverTaskSpace','newPage('])expect(s).not.toContain(bad)})
})

// Exercise the actual fixed SDK program with an offline DOM, not a fabricated stdout.
import { Window } from 'happy-dom'
it('runs the fixed TaskSpace SDK script and distinguishes exact selector matches without any network',async()=>{
 const window=new Window({url:'https://feed.test/list'});window.document.body.innerHTML='<article><h2>无独立链接的测绘项目</h2><time>2026-11-16</time></article><div hidden>hidden record never export</div><div style="display:none" role="progressbar">hidden loading never export</div><textarea>never export</textarea><form><input value="never export"><button>提交</button></form><script>window.secret="never export"</script>'
 const globals=globalThis as unknown as Record<string,unknown>,oldDocument=globals.document,oldLocation=globals.location
 globals.document=window.document;globals.location=window.location
 const AsyncFunction=Object.getPrototypeOf(async()=>undefined).constructor as new(...args:string[])=>(...args:unknown[])=>Promise<void>
 let injectedReadError:Record<string,unknown>|undefined,unknownEvaluationFailure=false
 const task={spaceId:7,name:'server-task-space-nonce',ownership:'agent',page:()=>({label:'p1',url:async()=>window.location.href,evaluate:async(fn:(arg:unknown)=>unknown,arg:unknown)=>{if(injectedReadError)return injectedReadError;try{if(unknownEvaluationFailure)throw new Error('private page/selector diagnostic');return JSON.parse(JSON.stringify(await fn(arg))) as unknown}catch{throw new Error('SDK remote evaluation failed')}},snapshot:async()=> 'article 无独立链接的测绘项目'})}
 const run=async(params:Record<string,unknown>)=>{const rows:Record<string,unknown>[]=[];await new AsyncFunction('taskSpace','console','listTaskSpaces','setTimeout',egoReadScript({spaceId:7,spaceName:task.name,origins:['https://feed.test'],maxBytes:4096,deadline:Date.now()+60000,...params}))(async(id:unknown)=>{if(params.recoverExistingOnly)expect(id).toBe(7);return task},{log:(s:string)=>rows.push(JSON.parse(s.slice('RAILWISE_EGO_RESULT:'.length)) as Record<string,unknown>)},async()=>params.matchingSpaces??[{id:7,name:task.name,ownership:task.ownership}],(callback:()=>void,ms:number)=>{expect(ms).toBe(500);callback()});return rows[0]!}
 try{
  const full=await run({action:'read'});expect(full).toMatchObject({ok:true,truncated:false});expect(String(full.html)).not.toContain('never export');expect(full.loadingObserved).toBe(false)
  expect(await run({action:'open',recoverExistingOnly:true,url:'https://feed.test/list'})).toMatchObject({ok:true,taskSpaceId:7})
  expect(await run({action:'open',recoverExistingOnly:true,matchingSpaces:[]})).toMatchObject({ok:false,code:'ego_browser_task_space_missing'})
  expect(await run({action:'open',recoverExistingOnly:true,matchingSpaces:[{id:7,name:task.name,ownership:'agent'},{id:8,name:task.name,ownership:'agent'}]})).toMatchObject({ok:false,code:'ego_browser_task_space_ambiguous'})
  const selected=await run({action:'read',selector:'article',expectedDocumentHtml:full.documentHtml,expectedSourceUrl:'https://feed.test/list'})
  expect(selected).toMatchObject({ok:true,selection:{selector:'article',matchedCount:1}});expect(String(selected.html)).toContain('无独立链接的测绘项目')
  const select=(selector:string)=>run({action:'read',selector,expectedDocumentHtml:full.documentHtml,expectedSourceUrl:'https://feed.test/list'})
  expect(await select('textarea')).toMatchObject({ok:false,code:'ego_browser_element_unsupported',failurePhase:'selection'})
  expect(await select('[')).toMatchObject({ok:false,code:'ego_browser_selector_invalid',failurePhase:'selection'})
  expect(await select('.absent-record')).toMatchObject({ok:false,code:'ego_browser_element_ambiguous',failurePhase:'selection'})
  expect(await select('div[hidden]')).toMatchObject({ok:false,code:'ego_browser_element_not_visible',failurePhase:'selection'})
  for(const readError of [{version:1,code:'ego_browser_user_control',failurePhase:'selection'},{version:1,code:'unknown',failurePhase:'selection'},{version:1,code:'ego_browser_element_ambiguous',failurePhase:'selection',raw:'private page/selector diagnostic'}]) {
   injectedReadError={readError};const rejected=await run({action:'read'});expect(rejected).toMatchObject({ok:false,code:'ego_browser_protocol_invalid',failurePhase:'dom_read'});expect(JSON.stringify(rejected)).not.toContain('private page/selector diagnostic')
  }
  injectedReadError=undefined;unknownEvaluationFailure=true
  expect(await run({action:'read'})).toMatchObject({ok:false,code:'ego_browser_read_failed',failurePhase:'dom_read'})
  unknownEvaluationFailure=false
  window.document.body.innerHTML+='<article>第二条</article>'
  expect(await run({action:'read',selector:'article',expectedDocumentHtml:full.documentHtml,expectedSourceUrl:'https://feed.test/list'})).toMatchObject({ok:false,code:'ego_browser_element_ambiguous',failurePhase:'selection'})
  window.document.body.innerHTML+='<div role="progressbar">正在加载</div>';expect(await run({action:'read'})).toMatchObject({loadingObserved:true})
  task.ownership='user';expect(await run({action:'observe'})).toMatchObject({ok:false,code:'ego_browser_user_control'})
 }finally{globals.document=oldDocument;globals.location=oldLocation;await window.happyDOM.close()}
})


it('finishes only once with an actual sealed Host proof, then reads back without any further SDK Page operation',async()=>{
 const f=await fixture();await f.execute('ego_browser_open',{url:'https://feed.test/list'});f.setFinishReady(false)
 expect(await f.execute('ego_browser_finish')).toMatchObject({code:'ego_browser_finish_not_ready'});expect(f.calls).toHaveLength(1)
 f.setFinishReady(true);const finished=await f.execute('ego_browser_finish');expect(finished).toMatchObject({status:'succeeded',finishResolved:true,keep:[]});expect(f.calls).toHaveLength(2)
 expect(await f.execute('ego_browser_finish')).toMatchObject({status:'succeeded',reused:true});expect(f.calls).toHaveLength(2)
 expect(await f.execute('ego_browser_read')).toMatchObject({code:'ego_browser_task_space_finished'});expect(f.calls).toHaveLength(2)
 const items=f.repo.operations(f.task.id,'tool').map(r=>(r.result as {item:TurnItem}).item),turns=[{...createTurnRecord({id:f.grant().turnId,threadId:f.task.threadId,prompt:f.task.goal}),executionGrant:f.grant()}]
 expect(verifiedEgoTaskSpaceFinish(f.repo,f.task,items,turns)?.id).toBe(finished.finishReceiptId)
 expect(verifiedEgoTaskSpaceFinish(f.repo,{...f.task,id:'other'},items,turns)).toBeNull()
 expect(verifiedEgoTaskSpaceFinish(f.repo,f.task,items,turns.map(t=>({...t,executionGrant:{...f.grant(),id:'wrong-grant'}})))).toBeNull()
})
it('never replays an uncertain finish or substitutes another TaskSpace',async()=>{
 const f=await fixture();await f.execute('ego_browser_open',{url:'https://feed.test/list'});f.setThrown();expect(await f.execute('ego_browser_finish')).toMatchObject({code:'ego_browser_command_timeout'})
 expect(f.repo.operations(f.task.id,'ego_task_space_finish')).toEqual([expect.objectContaining({status:'outcome_unknown'})]);const count=f.calls.length
 expect(await f.execute('ego_browser_finish')).toMatchObject({code:'ego_browser_waiting_user'});expect(f.calls).toHaveLength(count)
})
it('awaits the documented fixed SDK finish once, protects user control and never enumerates or closes tabs',async()=>{
 const AsyncFunction=Object.getPrototypeOf(async()=>undefined).constructor as new(...args:string[])=>(...args:unknown[])=>Promise<void>
 let count=0,resolved=false;const rows:Record<string,unknown>[]=[],space={spaceId:7,name:'server-owned-nonce',ownership:'agent',finish:async(value:unknown)=>{expect(value).toEqual({keep:[]});count++;await Promise.resolve();resolved=true}}
 const run=async()=>new AsyncFunction('taskSpace','console',egoFinishScript({spaceId:7,spaceName:space.name,deadline:Date.now()+60000}))(async(id:unknown)=>{expect(id).toBe(7);return space},{log:(line:string)=>{expect(resolved||space.ownership==='user').toBe(true);rows.push(JSON.parse(line.slice('RAILWISE_EGO_RESULT:'.length)) as Record<string,unknown>)}})
 await run();expect(count).toBe(1);expect(rows[0]).toMatchObject({ok:true,finishResolved:true,keep:[]});space.ownership='user';await run();expect(count).toBe(1);expect(rows[1]).toMatchObject({ok:false})
 for(const forbidden of ['newPage','task.page','task.tabs','task.pages','page.close','claimTaskSpace','takeOverTaskSpace','taskSpace(p.spaceName)'])expect(egoFinishScript({})).not.toContain(forbidden)
})


// Host/provider integration uses the same controlled repository and Grant; no external SDK/browser.
async function callWithReadFailure(f:Awaited<ReturnType<typeof fixture>>,observationId:unknown,code:string,phase:string) {
 const config={state:'installed' as const,executablePath:'/controlled/ego-browser',executableHash:'a'.repeat(64),version:'0.6.3.14',revision:0}
 const provider=buildEgoBrowserToolProvider({config,repository:f.repo,now:()=>Date.parse(date)+1000,run:async(_config,script)=>{
  const params=JSON.parse(script.split('\n')[0]!.slice('const p = '.length,-1)) as Record<string,unknown>
  return {ok:false,code,failurePhase:phase,taskSpaceId:7,spaceName:params.spaceName,ownership:'agent',pageLabel:'p1'}
 }})
 const args={selector:'article',observationId},grant=f.grant(),callId='controlled-phase-failure',key='tool:'+grant.turnId+':'+callId
 const host=f.repo.beginOperation({ownerId:f.task.id,idempotencyKey:key,kind:'tool',request:{providerId:'ego-browser',toolName:'ego_browser_read',callId,turnId:grant.turnId,argumentsHash:operationFingerprint(args),executionGrant:grant},nowIso:date}).receipt
 const context:ToolHostContext={threadId:f.task.threadId,turnId:grant.turnId,workspace:f.task.workspaceRoot,threadMode:'agent',sandboxMode:'read-only',approvalPolicy:'auto',executionGrant:grant,abortSignal:new AbortController().signal,awaitApproval:async()=>'allow',currentToolOperation:()=>({operationId:host.id,idempotencyKey:key,taskId:f.task.id,turnId:grant.turnId,executionId:'controlled-phase',callId,toolName:'ego_browser_read',providerId:'ego-browser',argumentsHash:operationFingerprint(args),executionGrantFingerprint:operationFingerprint(grant)})}
 const result=await provider.tools.find(t=>t.name==='ego_browser_read')!.execute(args,context)
 f.repo.finishOperation(f.task.id,key,{status:result.isError?'failed':'succeeded',result:{approved:true,item:{id:'phase-result',kind:'tool_result',status:'completed',threadId:f.task.threadId,turnId:grant.turnId,callId,toolName:'ego_browser_read',output:result.output,isError:Boolean(result.isError)}}},date)
 return result.output as Record<string,unknown>
}
it.each(['ego_browser_selector_invalid','ego_browser_element_ambiguous','ego_browser_element_not_visible','ego_browser_element_unsupported'])('keeps %s repairable with a safe phase and no source proof or connection wait',async code=>{
 const f=await fixture(),opened=await f.execute('ego_browser_open',{url:'https://feed.test/list'}),reads=f.repo.operations(f.task.id,'ego_document_read').length
 const result=await callWithReadFailure(f,opened.observationId,code,'selection')
 expect(result).toMatchObject({status:'blocked',code,failurePhase:'selection'});expect(String(result.message)).toContain('标准CSS');expect(String(result.message)).toContain('observationId')
 expect(result).not.toHaveProperty('evidence');expect(f.repo.operations(f.task.id,'ego_document_read')).toHaveLength(reads);expect(f.repo.operations(f.task.id,'ego_browser_wait')).toHaveLength(0)
 expect(f.repo.operations(f.task.id,'ego_page_observation').at(-1)).toMatchObject({status:'failed',result:{code,failurePhase:'selection'}})
 expect(await f.execute('ego_browser_observe')).toMatchObject({status:'succeeded'})
})
it('keeps unknown read failures hard and never persists a non-enum diagnostic as failurePhase',async()=>{
 const f=await fixture(),opened=await f.execute('ego_browser_open',{url:'https://feed.test/list'}),reads=f.repo.operations(f.task.id,'ego_document_read').length
 const result=await callWithReadFailure(f,opened.observationId,'ego_browser_read_failed','private selector or page text')
 expect(result).toMatchObject({code:'ego_browser_read_failed'});expect(result).not.toHaveProperty('failurePhase');expect(result).not.toHaveProperty('evidence')
 expect(f.repo.operations(f.task.id,'ego_browser_wait')).toHaveLength(1);expect(f.repo.operations(f.task.id,'ego_document_read')).toHaveLength(reads)
 expect(f.repo.operations(f.task.id,'ego_page_observation').at(-1)?.result).toEqual({code:'ego_browser_read_failed'})
 const count=f.calls.length;expect(await f.execute('ego_browser_observe')).toMatchObject({code:'ego_browser_waiting_user'});expect(f.calls).toHaveLength(count)
 expect(JSON.stringify(result)).not.toContain('private selector or page text')
})


// Isolated SDK result protocol; no external CLI, browser, profile or network.
async function reopenFixture() {
 const f=await fixture(),opened=await f.execute('ego_browser_open',{url:'https://feed.test/list'})
 const prior=f.repo.operation(f.task.id,'ego-task-space')!,raw=JSON.stringify(prior)
 const oldGrant=f.grant(),turnId='user-resume-turn'
 f.setGrant({...oldGrant,id:'resumed-grant',turnId})
 f.repo.update(f.task.id,f.repo.get(f.task.id)!.revision,t=>({...t,activeTurnId:turnId}))
 const resume=f.repo.beginOperation({ownerId:f.task.id,idempotencyKey:'user-resume',kind:'resume',request:{expectedRevision:0,idempotencyKey:'user-resume'},nowIso:date}).receipt
 f.repo.finishOperation(f.task.id,resume.idempotencyKey,{status:'succeeded',result:{task:f.repo.get(f.task.id),turn:{threadId:f.task.threadId,turnId,userMessageItemId:'explicit-user-resume'}}},date)
 const authorization={controlOwnerId:f.task.id,resumeReceiptId:resume.id,turnId,priorBindingReceiptId:prior.id}
 let auth:typeof authorization|null=authorization,state='closed',throwMetadata=false,throwCreate=false,errorResult:Record<string,unknown>|undefined,count=0
 const calls:Array<Record<string,unknown>>=[]
 const config={state:'installed' as const,executablePath:'/controlled/ego-browser',executableHash:'a'.repeat(64),version:'0.6.3.14',revision:0}
 const provider=buildEgoBrowserToolProvider({config,repository:f.repo,now:()=>Date.parse(date)+1000,
  canReopenClosedSpace:async()=>auth,
  run:async(_config,script)=>{
   const first=script.split('\n')[0]!,p=JSON.parse(first.slice(first.startsWith('const p = ')?'const p = '.length:'const p='.length,-1)) as Record<string,unknown>;calls.push(p)
   if(p.action==='space_status') {
    if(throwMetadata)throw new Error('ego_browser_command_timeout')
    return {ok:true,kind:'ego_space_status',version:1,taskSpaceId:p.spaceId,spaceName:p.spaceName,idMatch:state!=='closed',nameMatches:state==='name-conflict'?2:state==='closed'?0:1,spaceStatus:state==='closed'?'closed':'existing',identityMatches:state!=='closed'&&state!=='name-conflict',...(state==='closed'?{}:{ownership:state})}
   }
   if(errorResult)return errorResult
   if(throwCreate)throw new Error('ego_browser_command_timeout')
   return {ok:true,taskSpaceId:p.spaceId??8,spaceName:p.spaceName,ownership:'agent',pageLabel:'p1',sourceUrl:'https://feed.test/list',html,documentHtml:html,truncated:false,candidates:[]}
  }})
 const execute=async(name:typeof EGO_TOOLS[number]='ego_browser_open',args:Record<string,unknown>=name==='ego_browser_open'?{url:'https://feed.test/list'}:{})=>{
  const grant=f.grant(),callId='reopen-'+(++count),key='tool:'+grant.turnId+':'+callId
  const host=f.repo.beginOperation({ownerId:f.task.id,idempotencyKey:key,kind:'tool',request:{dispatchTracking:'host-v1',executionId:'reopen-execution',providerId:'ego-browser',toolName:name,callId,turnId:grant.turnId,argumentsHash:operationFingerprint(args),executionGrant:grant},nowIso:date}).receipt
  const context:ToolHostContext={threadId:f.task.threadId,turnId:grant.turnId,workspace:f.task.workspaceRoot,threadMode:'agent',sandboxMode:'read-only',approvalPolicy:'auto',executionGrant:grant,abortSignal:new AbortController().signal,awaitApproval:async()=>'allow',currentToolOperation:()=>({operationId:host.id,idempotencyKey:key,taskId:f.task.id,turnId:grant.turnId,executionId:'reopen-execution',callId,toolName:name,providerId:'ego-browser',argumentsHash:operationFingerprint(args),executionGrantFingerprint:operationFingerprint(grant)})}
  const result=await provider.tools.find(t=>t.name===name)!.execute(args,context)
  f.repo.finishOperation(f.task.id,key,{status:result.isError?'failed':'succeeded',result:{approved:true,item:{id:'result-'+callId,kind:'tool_result',status:'completed',createdAt:date,finishedAt:date,threadId:f.task.threadId,turnId:grant.turnId,callId,toolName:name,output:result.output,isError:Boolean(result.isError)}}},date)
  return result.output as Record<string,unknown>
 }
 return {f,prior,raw,opened,oldGrant,authorization,calls,execute,setAuth:(v:typeof auth)=>{auth=v},setState:(v:string)=>{state=v},setMetadataTimeout:()=>{throwMetadata=true},setCreateTimeout:(v=true)=>{throwCreate=v},setError:(v:typeof errorResult)=>{errorResult=v}}
}
it('appends one closed-Space incarnation only under an actual user-resume authorization, preserving prior source bytes',async()=>{
 const h=await reopenFixture(),out=await h.execute()
 expect(out).toMatchObject({status:'succeeded',taskSpaceId:8})
 expect(h.calls.map(c=>c.action)).toEqual(['space_status','open'])
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(2)
 expect(JSON.stringify(h.f.repo.operation(h.f.task.id,'ego-task-space'))).toBe(h.raw)
 expect(h.f.repo.operation(h.f.task.id,'ego-reopen:'+h.authorization.resumeReceiptId)).toMatchObject({status:'succeeded',request:{priorBindingReceiptId:h.prior.id,resumeReceiptId:h.authorization.resumeReceiptId}})
 expect(h.f.repo.operations(h.f.task.id,'ego_document_read')).toHaveLength(2)
 expect(validEgoDocumentEvidence(h.f.repo,h.f.task,h.opened,h.oldGrant)).toBe(true)
 const again=await h.execute();expect(again).toMatchObject({code:'ego_browser_task_space_missing'})
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(2)
 expect(h.calls.filter(c=>c.action==='open')).toHaveLength(1)
})
it.each(['no-auth','wrong-turn','wrong-binding','user','inactive','unassigned','agentDelegatedToUser','name-conflict','query-timeout','host-unknown'] as const)('never replaces an existing, uncontrolled or unconfirmed Space: %s',async boundary=>{
 const h=await reopenFixture()
 if(boundary==='no-auth')h.setAuth(null)
 else if(boundary==='wrong-turn')h.setAuth({...h.authorization,turnId:'other-turn'})
 else if(boundary==='wrong-binding')h.setAuth({...h.authorization,priorBindingReceiptId:'other-binding'})
 else if(boundary==='query-timeout')h.setMetadataTimeout()
 else if(boundary==='host-unknown'){const old=h.f.repo.beginOperation({ownerId:h.f.task.id,idempotencyKey:'old-unknown',kind:'tool',request:{},nowIso:date}).receipt;h.f.repo.finishOperation(h.f.task.id,old.idempotencyKey,{status:'outcome_unknown'},date)}
 else h.setState(boundary)
 const out=await h.execute();expect(out.status).toBe('blocked')
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(1)
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space_reopen')).toHaveLength(0)
 expect(h.calls.filter(c=>c.action==='open')).toHaveLength(0)
 expect(JSON.stringify(h.f.repo.operation(h.f.task.id,'ego-task-space'))).toBe(h.raw)
})
it('keeps a timed-out replacement prepared and recovers only its saved nonce in a later user Turn',async()=>{
 const h=await reopenFixture();h.setCreateTimeout()
 expect(await h.execute()).toMatchObject({code:'ego_browser_command_timeout'})
 const pending=h.f.repo.operations(h.f.task.id,'ego_task_space').at(-1)!
 expect(pending).toMatchObject({status:'prepared',request:{priorBindingReceiptId:h.prior.id,createdTurnId:h.authorization.turnId}})
 const before=h.calls.length;expect(await h.execute()).toMatchObject({code:'ego_browser_waiting_user'});expect(h.calls).toHaveLength(before)
 const nextTurn='second-user-resume';h.f.setGrant({...h.f.grant(),id:'second-grant',turnId:nextTurn});h.f.repo.update(h.f.task.id,h.f.repo.get(h.f.task.id)!.revision,t=>({...t,activeTurnId:nextTurn}));h.setCreateTimeout(false)
 expect(await h.execute()).toMatchObject({status:'succeeded',taskSpaceId:8})
 expect(h.calls.at(-1)).toMatchObject({recoverExistingOnly:true,spaceName:pending.request?.spaceName})
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(2)
 expect(h.calls.filter(c=>c.action==='open'&&!c.recoverExistingOnly)).toHaveLength(1)
})
it.each(['ego_browser_task_space_missing','ego_browser_read_failed','ego_browser_protocol_invalid'])('preserves %s before requiring successful result identity',async code=>{
 const h=await reopenFixture();h.setError({ok:false,code,failurePhase:'control'});h.setState('agent')
 expect(await h.execute()).toMatchObject({code});expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(1)
})

it('checks existing Space metadata with the fixed SDK program without any Space or Page operation',async()=>{
 const AsyncFunction=Object.getPrototypeOf(async()=>undefined).constructor as new(...args:string[])=>(...args:unknown[])=>Promise<void>
 const script=egoSpaceStatusScript({action:'space_status',spaceId:7,spaceName:'bound-name',deadline:Date.now()+60000})
 const run=async(spaces:unknown,throws=false)=>{const rows:Record<string,unknown>[]=[];await new AsyncFunction('listTaskSpaces','console',script)(async()=>{if(throws)throw new Error('private native diagnostic');return spaces},{log:(line:string)=>rows.push(JSON.parse(line.slice('RAILWISE_EGO_RESULT:'.length)) as Record<string,unknown>)});return rows[0]!}
 expect(await run([])).toMatchObject({ok:true,kind:'ego_space_status',spaceStatus:'closed',idMatch:false,nameMatches:0})
 expect(await run([{id:7,name:'bound-name',ownership:'agent'}])).toMatchObject({ok:true,spaceStatus:'existing',identityMatches:true,ownership:'agent'})
 expect(await run([{id:7,name:'bound-name',ownership:'agentDelegatedToUser'}])).toMatchObject({ok:true,spaceStatus:'existing',ownership:'agentDelegatedToUser'})
 expect(await run([{id:9,name:'bound-name',ownership:'agent'}])).toMatchObject({ok:true,spaceStatus:'existing',identityMatches:false,idMatch:false,nameMatches:1})
 expect(await run([{id:'7',name:'bound-name',ownership:'agent'}])).toMatchObject({ok:false,code:'ego_browser_protocol_invalid'})
 const failed=await run([],true);expect(failed).toMatchObject({ok:false,code:'ego_browser_read_failed'});expect(JSON.stringify(failed)).not.toContain('private native diagnostic')
 for(const forbidden of ['taskSpace(','page.','claimTaskSpace','takeOverTaskSpace','finish(','evaluate(','fetch('])expect(script).not.toContain(forbidden)
})
it.each(['taskSpaceId','spaceName','pageLabel','ownership'] as const)('reports an unconfirmed identity, without alleging user control, when successful result lacks %s',async field=>{
 const h=await reopenFixture();h.setState('agent')
 const result:Record<string,unknown>={ok:true,taskSpaceId:7,spaceName:h.prior.request!.spaceName,pageLabel:'p1',ownership:'agent'};delete result[field];h.setError(result)
 expect(await h.execute()).toMatchObject({code:'ego_browser_task_space_unconfirmed'});expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(1)
})

it('does not lower verified control loss to a repairable selection error',async()=>{
 const h=await reopenFixture();h.setState('agent');h.setError({ok:false,code:'ego_browser_element_ambiguous',failurePhase:'selection',taskSpaceId:7,spaceName:h.prior.request!.spaceName,pageLabel:'p1',ownership:'agentDelegatedToUser'})
 expect(await h.execute()).toMatchObject({code:'ego_browser_user_control'});expect(h.f.repo.operations(h.f.task.id,'ego_browser_wait')).toHaveLength(1)
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(1)
})

it('accepts the SDK default user Space id 0 without claiming it or confusing a closed positive binding',async()=>{
 const AsyncFunction=Object.getPrototypeOf(async()=>undefined).constructor as new(...args:string[])=>(...args:unknown[])=>Promise<void>
 const run=async(spaces:unknown,spaceId=27)=>{const rows:Record<string,unknown>[]=[];await new AsyncFunction('listTaskSpaces','console',egoSpaceStatusScript({action:'space_status',spaceId,spaceName:'bound-name',deadline:Date.now()+60000}))(async()=>spaces,{log:(line:string)=>rows.push(JSON.parse(line.slice('RAILWISE_EGO_RESULT:'.length)) as Record<string,unknown>)});return rows[0]!}
 const defaultSpace={id:0,name:'Default',ownership:'user'}
 expect(await run([defaultSpace])).toMatchObject({ok:true,taskSpaceId:27,spaceStatus:'closed',idMatch:false,nameMatches:0})
 expect(await run([defaultSpace,{id:27,name:'bound-name',ownership:'user'}])).toMatchObject({ok:true,taskSpaceId:27,spaceStatus:'existing',identityMatches:true,ownership:'user'})
 for(const id of [-1,1.5,Number.MAX_SAFE_INTEGER+1,'0'])expect(await run([{...defaultSpace,id}])).toMatchObject({ok:false,code:'ego_browser_protocol_invalid'})
 expect(await run([defaultSpace],0)).toMatchObject({ok:false,code:'ego_browser_protocol_invalid'})
 const h=await reopenFixture();h.setState('user');expect(await h.execute()).toMatchObject({code:'ego_browser_user_control'});expect(h.calls.filter(p=>p.action!=='space_status')).toHaveLength(0)
})
