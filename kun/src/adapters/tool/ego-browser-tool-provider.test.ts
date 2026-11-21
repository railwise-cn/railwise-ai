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
  const h=await reopenFixture(true),f=h.f,resumedGrant=f.grant();f.setGrant(h.oldGrant);f.repo.update(f.task.id,f.repo.get(f.task.id)!.revision,t=>({...t,activeTurnId:h.oldGrant.turnId}));f.setOwnership('user');expect(await f.execute('ego_browser_read')).toMatchObject({code:'ego_browser_user_control'})
  const count=f.calls.length;expect(await f.execute('ego_browser_observe')).toMatchObject({code:'ego_browser_waiting_user'});expect(f.calls).toHaveLength(count);expect(f.repo.get(f.task.id)?.status).toBe('running')
  f.setGrant(resumedGrant);f.repo.update(f.task.id,f.repo.get(f.task.id)!.revision,t=>({...t,activeTurnId:resumedGrant.turnId}));h.setState('agent');expect(await h.execute('ego_browser_read')).toMatchObject({status:'succeeded'});expect(h.calls.map(c=>c.action)).toEqual(['space_status','read']);expect(f.repo.operations(f.task.id,'ego_task_space')).toHaveLength(1)
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
 const task={spaceId:7,name:'server-task-space-nonce',ownership:'agent',page:()=>({label:'p1',url:async()=>window.location.href,evaluate:async(fn:(arg:unknown)=>unknown,arg:unknown)=>{if(injectedReadError)return injectedReadError;try{if(unknownEvaluationFailure)throw new Error('private page/selector diagnostic');return JSON.parse(JSON.stringify(await fn(arg))) as unknown}catch{throw new Error('SDK remote evaluation failed')}},snapshot:async()=>window.document.querySelector('article')?.textContent??''})}
 const run=async(params:Record<string,unknown>,onWait?:()=>void)=>{const rows:Record<string,unknown>[]=[];await new AsyncFunction('taskSpace','console','listTaskSpaces','setTimeout',egoReadScript({spaceId:7,spaceName:task.name,origins:['https://feed.test'],maxBytes:4096,deadline:Date.now()+60000,...params}))(async(id:unknown)=>{if(params.recoverExistingOnly)expect(id).toBe(7);return task},{log:(s:string)=>rows.push(JSON.parse(s.slice('RAILWISE_EGO_RESULT:'.length)) as Record<string,unknown>)},async()=>params.matchingSpaces??[{id:7,name:task.name,ownership:task.ownership}],(callback:()=>void,ms:number)=>{expect(ms).toBe(500);onWait?.();callback()});return rows[0]!}
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
  window.document.body.innerHTML='<svg><title>订阅图标</title><desc>装饰说明</desc><metadata>图标信息</metadata></svg>'
  const emptyPage=await run({action:'read'})
  expect(emptyPage).toMatchObject({ok:true,visibleText:false,loadingObserved:false})
  expect(emptyPage.html).toContain('<title>订阅图标</title>')
  let waits=0
  const settled=await run({action:'observe'},()=>{
    waits++
    window.document.body.insertAdjacentHTML('beforeend','<article>已加载的测绘公告</article>')
  })
  expect(waits).toBe(1)
  expect(settled).toMatchObject({ok:true,visibleText:true,snapshot:'已加载的测绘公告'})
  window.document.body.innerHTML='<svg><title>图表</title><text>可见的读数</text></svg>'
  expect(await run({action:'read'})).toMatchObject({ok:true,visibleText:true})
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
async function reopenFixture(native = false) {
 const f=await fixture(),opened=await f.execute('ego_browser_open',{url:'https://feed.test/list'})
 const prior=f.repo.operation(f.task.id,'ego-task-space')!,raw=JSON.stringify(prior)
 const oldGrant=f.grant(),turnId='user-resume-turn'
 f.setGrant({...oldGrant,id:'resumed-grant',turnId})
 f.repo.update(f.task.id,f.repo.get(f.task.id)!.revision,t=>({...t,activeTurnId:turnId}))
 const resume=f.repo.beginOperation({ownerId:f.task.id,idempotencyKey:'user-resume',kind:'resume',request:{expectedRevision:0,idempotencyKey:'user-resume'},nowIso:date}).receipt
 f.repo.finishOperation(f.task.id,resume.idempotencyKey,{status:'succeeded',result:{task:f.repo.get(f.task.id),turn:{threadId:f.task.threadId,turnId,userMessageItemId:'explicit-user-resume'}}},date)
 const authorization={controlOwnerId:f.task.id,resumeReceiptId:resume.id,turnId,priorBindingReceiptId:prior.id}
 let auth:typeof authorization|null=authorization,state='closed',throwMetadata=false,throwCreate=false,thrownMessage:string|undefined,errorResult:Record<string,unknown>|undefined,count=0
 let metadataRows:unknown[]|undefined,afterMetadata:(()=>void)|undefined,clock=Date.parse(date)+1000,controller:AbortController|undefined
 const nativeCalls:string[]=[],window=native?new Window({url:'https://feed.test/list'}):undefined
 if(window){window.document.body.innerHTML=html;clean.push(()=>window.happyDOM.close())}
 let nativeId=7,nativeName=String(prior.request!.spaceName),nativeUrl='https://feed.test/list'
 const calls:Array<Record<string,unknown>>=[]
 const config={state:'installed' as const,executablePath:'/controlled/ego-browser',executableHash:'a'.repeat(64),version:'0.6.3.14',revision:0}
 const provider=buildEgoBrowserToolProvider({config,repository:f.repo,now:()=>clock,
  canReopenClosedSpace:async()=>auth,
  run:async(_config,script)=>{
   const first=script.split('\n')[0]!,p=JSON.parse(first.slice(first.startsWith('const p = ')?'const p = '.length:'const p='.length,-1)) as Record<string,unknown>;calls.push(p)
   if(native) {
    const rows:Record<string,unknown>[]=[],globals=globalThis as unknown as Record<string,unknown>,previous={document:globals.document,location:globals.location}
    globals.document=window!.document;globals.location=new URL(nativeUrl)
    const AsyncFunction=Object.getPrototypeOf(async()=>undefined).constructor as new(...args:string[])=>(...args:unknown[])=>Promise<void>
    try {
     await new AsyncFunction('taskSpace','listTaskSpaces','console','setTimeout','Date',script)(async(id:unknown)=>{
      nativeCalls.push('attach')
      if(typeof id==='number'&&state==='closed')throw new Error('private native missing Space detail ?token=secret')
      if(typeof id==='string'){nativeId=8;nativeName=id;state='agent'}
      return {spaceId:nativeId,name:nativeName,ownership:state,page:()=>{nativeCalls.push('page');return {label:'p1',url:async()=>{nativeCalls.push('url');return nativeUrl},snapshot:async()=>{nativeCalls.push('snapshot');return 'offline fixture snapshot'},goto:async(url:string)=>{nativeCalls.push('goto');nativeUrl=url;globals.location=new URL(url)},evaluate:async(fn:(arg:unknown)=>unknown,arg:unknown)=>{nativeCalls.push('evaluate');return JSON.parse(JSON.stringify(await fn(arg))) as unknown}}}}
     },async()=>{nativeCalls.push('list');if(throwMetadata)throw new Error('private metadata transport error ?token=secret');return metadataRows??(state==='closed'?[]:[{id:nativeId,name:nativeName,ownership:state}])},{log:(line:string)=>rows.push(JSON.parse(line.slice('RAILWISE_EGO_RESULT:'.length)) as Record<string,unknown>)},(callback:()=>void)=>callback(),{now:()=>Date.parse(date)+1000})
     if(p.action==='space_status')afterMetadata?.()
     return rows[0]!
    } finally {globals.document=previous.document;globals.location=previous.location}
   }
   if(p.action==='space_status') {
    if(throwMetadata)throw new Error('ego_browser_command_timeout')
    return {ok:true,kind:'ego_space_status',version:1,taskSpaceId:p.spaceId,spaceName:p.spaceName,idMatch:state!=='closed',nameMatches:state==='name-conflict'?2:state==='closed'?0:1,spaceStatus:state==='closed'?'closed':'existing',identityMatches:state!=='closed'&&state!=='name-conflict',...(state==='closed'?{}:{ownership:state})}
   }
   if(errorResult)return errorResult
   if(thrownMessage)throw new Error(thrownMessage)
   if(throwCreate)throw new Error('ego_browser_command_timeout')
   return {ok:true,taskSpaceId:p.spaceId??8,spaceName:p.spaceName,ownership:'agent',pageLabel:'p1',sourceUrl:'https://feed.test/list',html,documentHtml:html,truncated:false,candidates:[]}
  }})
 const execute=async(name:typeof EGO_TOOLS[number]='ego_browser_open',args:Record<string,unknown>=name==='ego_browser_open'?{url:'https://feed.test/list'}:{})=>{
  const grant=f.grant(),callId='reopen-'+(++count),key='tool:'+grant.turnId+':'+callId
  controller=new AbortController()
  const host=f.repo.beginOperation({ownerId:f.task.id,idempotencyKey:key,kind:'tool',request:{dispatchTracking:'host-v1',executionId:'reopen-execution',providerId:'ego-browser',toolName:name,callId,turnId:grant.turnId,argumentsHash:operationFingerprint(args),executionGrant:grant},nowIso:date}).receipt
  const context:ToolHostContext={threadId:f.task.threadId,turnId:grant.turnId,workspace:f.task.workspaceRoot,threadMode:'agent',sandboxMode:'read-only',approvalPolicy:'auto',executionGrant:grant,abortSignal:controller.signal,awaitApproval:async()=>'allow',currentToolOperation:()=>({operationId:host.id,idempotencyKey:key,taskId:f.task.id,turnId:grant.turnId,executionId:'reopen-execution',callId,toolName:name,providerId:'ego-browser',argumentsHash:operationFingerprint(args),executionGrantFingerprint:operationFingerprint(grant)})}
  const result=await provider.tools.find(t=>t.name===name)!.execute(args,context)
  f.repo.finishOperation(f.task.id,key,{status:result.isError?'failed':'succeeded',result:{approved:true,item:{id:'result-'+callId,kind:'tool_result',status:'completed',createdAt:date,finishedAt:date,threadId:f.task.threadId,turnId:grant.turnId,callId,toolName:name,output:result.output,isError:Boolean(result.isError)}}},date)
  return result.output as Record<string,unknown>
 }
 return {f,prior,raw,opened,oldGrant,authorization,calls,nativeCalls,execute,setAuth:(v:typeof auth)=>{auth=v},setState:(v:string)=>{state=v},setMetadataTimeout:()=>{throwMetadata=true},setMetadataRows:(v:unknown[])=>{metadataRows=v},setAfterMetadata:(v:()=>void)=>{afterMetadata=v},expire:()=>{clock=Date.parse(f.grant().expiresAt!)},abort:()=>controller?.abort(),changeConfig:()=>{config.revision++},setCreateTimeout:(v=true)=>{throwCreate=v},setThrownMessage:(v:string)=>{thrownMessage=v},setError:(v:typeof errorResult)=>{errorResult=v}}
}
it.each(['ego_browser_read','ego_browser_observe','ego_browser_next_page'] as const)('preflights a resumed %s before attaching a closed old Space, then permits only authorized open recovery',async name=>{
 const h=await reopenFixture(true),args=name==='ego_browser_next_page'?{observationId:h.opened.observationId,targetId:(h.opened.nextPages as Array<{targetId:string}>)[0]!.targetId}:{}
 const out=await h.execute(name,args)
 expect(out).toMatchObject({status:'blocked',code:'ego_browser_open_required'})
 expect(String(out.message)).toContain('ego_browser_open');expect(String(out.message)).toContain('https://feed.test/list')
 expect(h.calls.map(c=>c.action)).toEqual(['space_status']);expect(h.nativeCalls).toEqual(['list'])
 expect(h.f.repo.operations(h.f.task.id,'ego_browser_wait')).toHaveLength(0)
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(1)
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space_reopen')).toHaveLength(0)
 expect(h.f.repo.operations(h.f.task.id,'ego_document_read')).toHaveLength(1)
 expect(await h.execute(name,args)).toMatchObject({code:'ego_browser_open_required'});expect(h.nativeCalls).toEqual(['list'])
 expect(await h.execute()).toMatchObject({status:'succeeded',taskSpaceId:8})
 expect(h.calls.map(c=>c.action)).toEqual(['space_status','space_status','open'])
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(2)
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space_reopen')).toHaveLength(1)
})
it('checks a resumed agent Space once per sealed Turn and reuses the exact id and label',async()=>{
 const h=await reopenFixture(true);h.setState('agent')
 expect(await h.execute('ego_browser_read')).toMatchObject({status:'succeeded',taskSpaceId:7,pagination:{navigationActionsUsed:1,currentSpaceNavigationCount:1,documentPageNumber:null}})
 expect(await h.execute('ego_browser_read')).toMatchObject({status:'succeeded',taskSpaceId:7,pagination:{navigationActionsUsed:1,currentSpaceNavigationCount:1,documentPageNumber:null}})
 expect(h.calls.map(c=>c.action)).toEqual(['space_status','read','read'])
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(1)
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space_status')).toHaveLength(1)
})
it.each(['ego_browser_observe','ego_browser_next_page'] as const)('preflights resumed agent %s and keeps its existing binding',async name=>{
 const h=await reopenFixture(true);h.setState('agent')
 const args=name==='ego_browser_next_page'?{observationId:h.opened.observationId,targetId:(h.opened.nextPages as Array<{targetId:string}>)[0]!.targetId}:{}
 expect(await h.execute(name,args)).toMatchObject({status:'succeeded'})
 expect(h.calls.map(c=>c.action)).toEqual(['space_status',name==='ego_browser_observe'?'observe':'next'])
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(1)
 expect(await h.execute('ego_browser_read')).toMatchObject({status:'succeeded'})
 expect(h.calls.filter(c=>c.action==='space_status')).toHaveLength(1)
})
it.each(['user','inactive','unassigned','agentDelegatedToUser','unknown'] as const)('denies resumed %s ownership before any Page operation',async ownership=>{
 const h=await reopenFixture(true);h.setState(ownership)
 expect(await h.execute('ego_browser_read')).toMatchObject({status:'blocked'})
 expect(h.nativeCalls).toEqual(['list']);expect(h.f.repo.operations(h.f.task.id,'ego_browser_wait')).toHaveLength(1)
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(1)
})
it.each(['mismatch','duplicate','protocol','transport'] as const)('fails closed on resumed metadata %s without attaching',async boundary=>{
 const h=await reopenFixture(true);h.setState('agent')
 if(boundary==='transport')h.setMetadataTimeout()
 else h.setMetadataRows(boundary==='mismatch'?[{id:7,name:'other-name',ownership:'agent'}]:boundary==='duplicate'?[{id:7,name:h.prior.request!.spaceName,ownership:'agent'},{id:7,name:h.prior.request!.spaceName,ownership:'agent'}]:[{id:'7',name:h.prior.request!.spaceName,ownership:'agent'}])
 expect(await h.execute('ego_browser_read')).toMatchObject({status:'blocked'})
 expect(h.nativeCalls).toEqual(['list']);expect(h.f.repo.operations(h.f.task.id,'ego_browser_wait')).toHaveLength(1)
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space_reopen')).toHaveLength(0)
})
it('revalidates the active Grant after metadata returns and before any Page attachment',async()=>{
 const h=await reopenFixture(true);h.setState('agent');h.setAfterMetadata(()=>h.f.repo.update(h.f.task.id,h.f.repo.get(h.f.task.id)!.revision,t=>({...t,activeTurnId:'different-turn'})))
 expect(await h.execute('ego_browser_read')).toMatchObject({status:'blocked',code:'ego_browser_scope_required'})
 expect(h.nativeCalls).toEqual(['list'])
})
it('rejects an expired resumed Grant before making a metadata query',async()=>{
 const h=await reopenFixture(true);h.f.setGrant({...h.f.grant(),expiresAt:date})
 expect(await h.execute('ego_browser_read')).toMatchObject({code:'ego_browser_grant_expired'})
 expect(h.nativeCalls).toEqual([])
})
it.each(['expired','abort','configuration'] as const)('preserves %s fencing after a metadata await',async boundary=>{
 const h=await reopenFixture(true);h.setState('agent');h.setAfterMetadata(boundary==='expired'?h.expire:boundary==='abort'?h.abort:h.changeConfig)
 expect(await h.execute('ego_browser_read')).toMatchObject({status:'blocked',code:boundary==='configuration'?'ego_browser_scope_required':'ego_browser_grant_expired'})
 expect(h.nativeCalls).toEqual(['list']);expect(h.f.repo.operations(h.f.task.id,'ego_task_space_status').at(-1)?.status).toBe('failed')
})
it('keeps the finished-Space fence ahead of any resumed metadata or Page call',async()=>{
 const h=await reopenFixture(true);expect(await h.f.execute('ego_browser_finish')).toMatchObject({status:'succeeded'})
 expect(await h.execute('ego_browser_read')).toMatchObject({code:'ego_browser_task_space_finished'})
 expect(h.nativeCalls).toEqual([]);expect(h.calls).toEqual([])
})
it.each(['approval','result-hash','grant'] as const)('does not reuse a metadata verdict after its %s seal changes',async boundary=>{
 const h=await reopenFixture(true);await h.execute('ego_browser_read')
 const status=h.f.repo.operations(h.f.task.id,'ego_task_space_status')[0]!,host=h.f.repo.operationById(h.f.task.id,String(status.request!.hostOperationId),'tool')!,saved=host.result as {approved:boolean;item:{output:Record<string,unknown>}}
 if(boundary==='grant')h.f.setGrant({...h.f.grant(),id:'new-current-grant'})
 else h.f.repo.finishOperation(h.f.task.id,host.idempotencyKey,{status:'succeeded',result:boundary==='approval'?{...saved,approved:false}:{...saved,item:{...saved.item,output:{...saved.item.output,spaceStatusResultHash:'forged'}}}},date)
 expect(await h.execute('ego_browser_read')).toMatchObject({code:'ego_browser_open_required'})
 expect(h.calls.map(c=>c.action)).toEqual(['space_status','space_status'])
})
it('fails closed if the current binding changes while the metadata query is in flight',async()=>{
 const h=await reopenFixture(true);h.setState('agent');h.setAfterMetadata(()=>h.f.repo.beginOperation({ownerId:h.f.task.id,idempotencyKey:'invalid-concurrent-binding',kind:'ego_task_space',request:{},nowIso:date}))
 expect(await h.execute('ego_browser_read')).toMatchObject({code:'ego_browser_task_space_unconfirmed'})
 expect(h.nativeCalls).toEqual(['list']);expect(h.f.repo.operations(h.f.task.id,'ego_browser_wait')).toHaveLength(1)
})
it.each(['space_attach','page_resolve','initial_url'] as const)('reports the exact failing SDK %s boundary without raw native errors or invented Page identity',async stage=>{
 const rows:Record<string,unknown>[]=[],native=Object.assign(new Error('private page content https://feed.test/?token=secret'),{code:'ECONNRESET'})
 const task={spaceId:7,name:'bound-space',ownership:'agent',page:()=>{if(stage==='page_resolve')throw native;return {label:'p1',url:async()=>{throw native}}}}
 const AsyncFunction=Object.getPrototypeOf(async()=>undefined).constructor as new(...args:string[])=>(...args:unknown[])=>Promise<void>
 await new AsyncFunction('taskSpace','console',egoReadScript({action:'read',spaceId:7,spaceName:'bound-space',origins:['https://feed.test'],maxBytes:4096,deadline:Date.now()+60000}))(async()=>{if(stage==='space_attach')throw native;return task},{log:(line:string)=>rows.push(JSON.parse(line.slice('RAILWISE_EGO_RESULT:'.length)) as Record<string,unknown>)})
 expect(rows[0]).toMatchObject({ok:false,code:'ego_browser_read_failed',sdkStage:stage,nativeErrorName:'Error',nativeErrorCode:'ECONNRESET',nativeErrorCategory:'connection'})
 if(stage==='space_attach')expect(rows[0]).not.toHaveProperty('taskSpaceId')
 else {expect(rows[0]).toMatchObject({identityVerified:true,taskSpaceId:7,ownership:'agent'});if(stage==='page_resolve')expect(rows[0]).not.toHaveProperty('pageHandleLabel');else expect(rows[0]?.pageHandleLabel).toBe('p1')}
 expect(rows[0]).not.toHaveProperty('pageLabel')
 expect(JSON.stringify(rows)).not.toMatch(/private page content|token=secret|stack/)
})
it.each([true,false])('persists only allowlisted native diagnostics and verified failure identity (known=%s)',async known=>{
 const h=await reopenFixture();h.setState('agent')
 h.setError({ok:false,code:known?'ego_browser_read_failed':'ego_browser_private_token',failurePhase:'control',sdkStage:'initial_url',identityVerified:true,taskSpaceId:7,spaceName:h.prior.request!.spaceName,ownership:'agent',pageHandleLabel:'p1',nativeErrorName:known?'TimeoutError':'private native name',nativeErrorCode:known?'ETIMEDOUT':'private code ?token=secret',nativeErrorCategory:'invented cause',message:'private page content ?token=secret',stack:'private stack'})
 const out=await h.execute('ego_browser_read'),failed=h.f.repo.operations(h.f.task.id,'ego_page_observation').at(-1)!
 expect(out).toMatchObject({code:'ego_browser_read_failed',sdkStage:'initial_url',nativeErrorCategory:known?'timeout':'unknown',verifiedIdentity:{taskSpaceId:7,ownership:'agent',pageHandleLabel:'p1'}})
 expect(failed).toMatchObject({status:'failed',result:{sdkStage:'initial_url',nativeErrorCategory:known?'timeout':'unknown',verifiedIdentity:{taskSpaceId:7}}})
 if(!known){expect(out).not.toHaveProperty('nativeErrorName');expect(out).not.toHaveProperty('nativeErrorCode')}
 expect(JSON.stringify([out,failed])).not.toMatch(/private native|private code|private page|token=secret|private stack|invented cause/)
})
it('never promotes an unknown native message to a persisted error code',async()=>{
 const h=await reopenFixture();h.setState('agent');h.setThrownMessage('private_page_token_secret')
 const out=await h.execute('ego_browser_read')
 expect(out).toMatchObject({code:'ego_browser_read_failed'})
 expect(JSON.stringify([out,h.f.repo.operations(h.f.task.id,'ego_browser_wait')])).not.toContain('private_page_token_secret')
})
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
it('distinguishes current-Space navigation from the task-wide limit after a closed-Space replacement',async()=>{
 const h=await reopenFixture(true)
 const priorNavigation=h.f.repo.operations(h.f.task.id,'ego_page_navigation')[0]!,priorRead=h.f.repo.operations(h.f.task.id,'ego_document_read')[0]!
 let out=await h.execute()
 expect(out).toMatchObject({status:'succeeded',taskSpaceId:8,pagination:{pageNumber:2,pageNumberMeaning:'task_navigation_actions_used',navigationActionsUsed:2,currentSpaceNavigationCount:1,documentPageNumber:null,pageLimit:10,limitReached:false}})
 const read=await h.execute('ego_browser_read')
 expect(read).toMatchObject({pagination:{navigationActionsUsed:2,currentSpaceNavigationCount:1,documentPageNumber:null}})
 expect(h.f.repo.operations(h.f.task.id,'ego_page_navigation')).toHaveLength(2)
 out=read
 for(let used=2;used<10;used++)out=await h.execute('ego_browser_next_page',{observationId:out.observationId,targetId:(out.nextPages as Array<{targetId:string}>)[0]!.targetId})
 expect(out).toMatchObject({status:'succeeded',pagination:{pageNumber:10,navigationActionsUsed:10,currentSpaceNavigationCount:9,documentPageNumber:null,pageLimit:10,limitReached:true}})
 const before=h.calls.length
 expect(await h.execute('ego_browser_next_page',{observationId:out.observationId,targetId:(out.nextPages as Array<{targetId:string}>)[0]!.targetId})).toMatchObject({code:'ego_browser_page_limit'})
 expect(h.calls).toHaveLength(before)
 expect(h.f.repo.operations(h.f.task.id,'ego_page_navigation')).toHaveLength(10)
 expect(h.f.repo.operationById(h.f.task.id,priorNavigation.id,'ego_page_navigation')).toEqual(priorNavigation)
 expect(h.f.repo.operationById(h.f.task.id,priorRead.id,'ego_document_read')).toEqual(priorRead)
 expect(validEgoDocumentEvidence(h.f.repo,h.f.task,h.opened,h.oldGrant)).toBe(true)
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

// The same fixed SDK program executes against a synthetic live DOM; no browser/CLI/network.
async function liveSelectionFixture(options: { stopAfterFirst?: 'expired'|'revoked'|'abort'|'configuration'; routeAfterFirst?: boolean; routeBeforeEvaluation?:boolean; error?: {code:string;phase:string;spaceId?:number;ownership?:string}; fallbackError?: boolean; large?:boolean; throwFirst?:boolean; shell?:boolean } = {}) {
 const f=await fixture(),opened=await f.execute('ego_browser_open',{url:'https://feed.test/list'})
 const window=new Window({url:'https://feed.test/list'});window.document.body.innerHTML=html
 window.document.body.insertAdjacentHTML('beforeend','<nav><time>new asynchronous navigation clock</time></nav>')
 if(options.shell)window.document.body.innerHTML='<nav>Visible site navigation, records have not arrived</nav>'
 if(options.large)window.document.body.insertAdjacentHTML('beforeend','<p>'+'x'.repeat(6000)+'</p>')
 clean.push(()=>window.happyDOM.close())
 const config={state:'installed' as const,executablePath:'/controlled/ego-browser',executableHash:'a'.repeat(64),version:'0.6.3.14',revision:0}
 const calls:Array<Record<string,unknown>>=[],controller=new AbortController()
 let clock=Date.parse(date)+1000,revoked=false,evaluations=0,racedDomReads=0
 const AsyncFunction=Object.getPrototypeOf(async()=>undefined).constructor as new(...args:string[])=>(...args:unknown[])=>Promise<void>
 const provider=buildEgoBrowserToolProvider({config,repository:f.repo,now:()=>clock,run:async(_config,script)=>{
  const p=JSON.parse(script.split('\n')[0]!.slice('const p = '.length,-1)) as Record<string,unknown>;calls.push(p)
  if(options.throwFirst)throw new Error('ego_browser_command_timeout')
  let result:Record<string,unknown>
  if(options.error || options.fallbackError&&calls.length>1) result={ok:false,code:options.error?.code??'ego_browser_observation_stale',failurePhase:options.error?.phase??'selection',taskSpaceId:options.error?.spaceId??7,spaceName:p.spaceName,ownership:options.error?.ownership??'agent',pageLabel:'p1'}
  else {
   const globals=globalThis as unknown as Record<string,unknown>,previous={document:globals.document,location:globals.location}
   globals.document=window.document;globals.location=window.location
   try {
    const rows:Record<string,unknown>[]=[],task={spaceId:7,name:p.spaceName,ownership:'agent',page:()=>({label:'p1',url:async()=>window.location.href,evaluate:async(fn:(arg:unknown)=>unknown,arg:unknown)=>{
     evaluations++
     if(options.routeBeforeEvaluation&&calls.length>1) {
      window.location.hash='changed-after-url-before-evaluate'
      globals.document=new Proxy(window.document,{get(target,property){const value=Reflect.get(target,property,target);if(property==='querySelectorAll')return (...args:unknown[])=>{racedDomReads++;return Reflect.apply(value,target,args)};return typeof value==='function'?value.bind(target):value}})
     }
     return JSON.parse(JSON.stringify(await fn(arg))) as unknown
    }})}
    await new AsyncFunction('taskSpace','console','listTaskSpaces','setTimeout','Date',script)(async()=>task,{log:(line:string)=>rows.push(JSON.parse(line.slice('RAILWISE_EGO_RESULT:'.length)) as Record<string,unknown>)},async()=>[{id:7,name:p.spaceName,ownership:'agent'}],(callback:()=>void)=>callback(),{now:()=>clock})
    result=rows[0]!
   } finally {globals.document=previous.document;globals.location=previous.location}
  }
  if(calls.length===1) {
   if(options.stopAfterFirst==='expired')clock=Date.parse(f.grant().expiresAt!)
   if(options.stopAfterFirst==='revoked')revoked=true
   if(options.stopAfterFirst==='abort')controller.abort()
   if(options.stopAfterFirst==='configuration')config.revision++
   if(options.routeAfterFirst)window.location.hash='changed-route'
  }
  return result
 }})
 let sequence=0
 const execute=async(args:Record<string,unknown>)=>{
  const grant=f.grant(),callId='live-recovery-'+(++sequence),key='tool:'+grant.turnId+':'+callId
  const request={providerId:'ego-browser',toolName:'ego_browser_read',callId,turnId:grant.turnId,argumentsHash:operationFingerprint(args),executionGrant:grant}
  const host=f.repo.beginOperation({ownerId:f.task.id,idempotencyKey:key,kind:'tool',request,nowIso:date}).receipt
  const context:ToolHostContext={threadId:f.task.threadId,turnId:grant.turnId,workspace:f.task.workspaceRoot,threadMode:'agent',sandboxMode:'read-only',approvalPolicy:'auto',executionGrant:grant,abortSignal:controller.signal,awaitApproval:async()=>'allow',validateExecutionGrant:async()=>{if(revoked)throw Object.assign(new Error('revoked'),{code:'execution_grant_scope'})},currentToolOperation:()=>({operationId:host.id,idempotencyKey:key,taskId:f.task.id,turnId:grant.turnId,executionId:'live-recovery',callId,toolName:'ego_browser_read',providerId:'ego-browser',argumentsHash:operationFingerprint(args),executionGrantFingerprint:operationFingerprint(grant)})}
  const result=await provider.tools.find(tool=>tool.name==='ego_browser_read')!.execute(args,context)
  f.repo.finishOperation(f.task.id,key,{status:result.isError?'failed':'succeeded',result:{approved:true,item:{id:'result-'+callId,kind:'tool_result',status:'completed',threadId:f.task.threadId,turnId:grant.turnId,callId,toolName:'ego_browser_read',output:result.output,isError:Boolean(result.isError)}}},date)
  return result.output as Record<string,unknown>
 }
 return {f,opened,calls,execute,evaluations:()=>evaluations,racedDomReads:()=>racedDomReads}
}

it('recovers one live selection DOM change by a separately sealed same-page current document read',async()=>{
 const h=await liveSelectionFixture(),out=await h.execute({selector:'article',observationId:h.opened.observationId})
 expect(out).toMatchObject({status:'succeeded',readScope:'document',truncated:false,recoveredFrom:{code:'ego_browser_observation_stale',failurePhase:'selection'}})
 expect(String(out.html)).toContain('new asynchronous navigation clock');expect(String(out.html)).toContain('测绘监测项目')
 expect((out.evidence as Record<string,unknown>).selection).toBeUndefined();expect(validEgoDocumentEvidence(h.f.repo,h.f.task,out,h.f.grant())).toBe(true)
 expect(h.calls).toHaveLength(2);expect(h.calls[0]).toHaveProperty('selector','article');expect(h.calls[1]).toMatchObject({action:'read',spaceId:7,recoverExistingOnly:true,expectedReadSourceUrl:'https://feed.test/list'})
 expect(h.calls[1]).not.toHaveProperty('selector');expect(h.calls[1]).not.toHaveProperty('expectedDocumentHtml')
 const observations=h.f.repo.operations(h.f.task.id,'ego_page_observation')
 expect(observations).toHaveLength(2);expect(observations[0]).toMatchObject({status:'failed',result:{code:'ego_browser_observation_stale',failurePhase:'selection'}});expect(observations[1]?.status).toBe('succeeded')
 const read=h.f.repo.operations(h.f.task.id,'ego_document_read').at(-1)!
 expect(read.request).not.toHaveProperty('selector');expect(read.request).toHaveProperty('recoveredFrom.failedDispatchReceiptId',observations[0]!.id)
 expect(h.f.repo.operations(h.f.task.id,'ego_task_space')).toHaveLength(1)
})

it.each(['expired','revoked','abort','configuration'] as const)('retains the failed selector and blocks %s before its recovery read',async stopAfterFirst=>{
 const h=await liveSelectionFixture({stopAfterFirst}),out=await h.execute({selector:'article',observationId:h.opened.observationId})
 expect(out.status).toBe('blocked');expect(out).not.toHaveProperty('evidence');expect(h.calls).toHaveLength(1)
  expect(h.f.repo.operations(h.f.task.id,'ego_page_observation')).toEqual([expect.objectContaining({status:'failed',result:expect.objectContaining({code:'ego_browser_observation_stale',failurePhase:'selection'})})])
 expect(h.f.repo.operations(h.f.task.id,'ego_document_read')).toHaveLength(1)
})

it.each([
 {code:'ego_browser_observation_stale',phase:'control'}, {code:'ego_browser_page_changed',phase:'selection'},
 {code:'ego_browser_selector_invalid',phase:'selection'}, {code:'ego_browser_element_ambiguous',phase:'selection'},
 {code:'ego_browser_origin_denied',phase:'selection'}, {code:'ego_browser_protocol_invalid',phase:'selection'},
 {code:'ego_browser_observation_stale',phase:'selection',spaceId:8}, {code:'ego_browser_observation_stale',phase:'selection',ownership:'user'}
])('does not recover an ineligible read result $code/$phase',async error=>{
 const h=await liveSelectionFixture({error}),out=await h.execute({selector:'article',observationId:h.opened.observationId})
 expect(out.status).toBe('blocked');expect(out).not.toHaveProperty('evidence');expect(h.calls).toHaveLength(1);expect(h.f.repo.operations(h.f.task.id,'ego_document_read')).toHaveLength(1)
})

it('never follows a changed same-origin route during selection recovery',async()=>{
 const h=await liveSelectionFixture({routeAfterFirst:true}),out=await h.execute({selector:'article',observationId:h.opened.observationId})
 expect(out).toMatchObject({status:'blocked',code:'ego_browser_page_changed'});expect(out).not.toHaveProperty('evidence');expect(h.calls).toHaveLength(2)
 expect(h.evaluations()).toBe(2);expect(h.f.repo.operations(h.f.task.id,'ego_document_read')).toHaveLength(1)
})

it('checks the exact recovery URL inside evaluate before reading a raced route DOM',async()=>{
 const h=await liveSelectionFixture({routeBeforeEvaluation:true}),out=await h.execute({selector:'article',observationId:h.opened.observationId})
 expect(out).toMatchObject({status:'blocked',code:'ego_browser_page_changed',failurePhase:'control'});expect(out).not.toHaveProperty('evidence')
 expect(h.calls).toHaveLength(2);expect(h.evaluations()).toBe(3);expect(h.racedDomReads()).toBe(0)
 expect(h.f.repo.operations(h.f.task.id,'ego_document_read')).toHaveLength(1)
 const attempts=h.f.repo.operations(h.f.task.id,'ego_page_observation')
 expect(attempts).toHaveLength(2);expect(attempts[0]).toMatchObject({status:'failed',result:{code:'ego_browser_observation_stale',failurePhase:'selection'}})
 expect(attempts[1]).toMatchObject({status:'failed',result:{code:'ego_browser_page_changed',failurePhase:'control'}})
})

it('never repeats a failed fallback or promotes a capped current document to full evidence',async()=>{
 const failed=await liveSelectionFixture({fallbackError:true}),out=await failed.execute({selector:'article',observationId:failed.opened.observationId})
 expect(out.status).toBe('blocked');expect(failed.calls).toHaveLength(2);expect(failed.f.repo.operations(failed.f.task.id,'ego_document_read')).toHaveLength(1)
 const capped=await liveSelectionFixture({large:true}),limited=await capped.execute({selector:'article',observationId:capped.opened.observationId,maxBytes:4096})
 expect(limited).toMatchObject({status:'succeeded',readScope:'document',truncated:true});expect(capped.calls).toHaveLength(2)
 expect(validEgoDocumentEvidence(capped.f.repo,capped.f.task,limited,capped.f.grant())).toBe(false)
})

it('rejects a foreign receipt before dispatch and guides an old observation to a fresh default read',async()=>{
 const h=await liveSelectionFixture(),foreign=h.f.repo.beginOperation({ownerId:h.f.task.id,kind:'ego_observation',idempotencyKey:'foreign-context',request:{taskId:'another-task',turnId:h.f.grant().turnId},nowIso:'2026-11-16T00:00:02.000Z'}).receipt
 h.f.repo.finishOperation(h.f.task.id,foreign.idempotencyKey,{status:'succeeded',result:{sourceUrl:'https://feed.test/list',taskSpaceId:7,documentHtml:html}},'2026-11-16T00:00:02.000Z')
 const forged=await h.execute({selector:'article',observationId:foreign.id});expect(forged).toMatchObject({code:'ego_browser_observation_stale',failurePhase:'control'});expect(h.calls).toHaveLength(0)
 const stale=await h.execute({selector:'article',observationId:h.opened.observationId});expect(stale).toMatchObject({code:'ego_browser_observation_stale',failurePhase:'control'});expect(String(stale.message)).toContain('ego_browser_read({})');expect(h.calls).toHaveLength(0)
 const fresh=await h.execute({});expect(fresh).toMatchObject({status:'succeeded',readScope:'document'});expect(h.calls).toHaveLength(1)
})

it('does not replay a selector whose dispatched command outcome is unknown',async()=>{
 const h=await liveSelectionFixture({throwFirst:true}),out=await h.execute({selector:'article',observationId:h.opened.observationId})
 expect(out).toMatchObject({status:'blocked',code:'ego_browser_command_timeout'});expect(out).not.toHaveProperty('evidence');expect(h.calls).toHaveLength(1)
 expect(h.f.repo.operations(h.f.task.id,'ego_page_observation')).toHaveLength(1);expect(h.f.repo.operations(h.f.task.id,'ego_document_read')).toHaveLength(1)
 expect(h.f.repo.operations(h.f.task.id,'ego_browser_wait')).toHaveLength(1)
})

it('returns an authentic current SPA shell without inventing records or collection completion',async()=>{
 const h=await liveSelectionFixture({shell:true}),out=await h.execute({selector:'body',observationId:h.opened.observationId})
 expect(out).toMatchObject({status:'succeeded',readScope:'document',truncated:false,loadingObserved:false,emptyObserved:false})
 expect(String(out.html)).toContain('records have not arrived');expect(String(out.html)).not.toContain('测绘监测项目');expect(String(out.html)).not.toContain('2026-11-16')
 expect(out).not.toHaveProperty('complete');expect(out).not.toHaveProperty('noMatches');expect(validEgoDocumentEvidence(h.f.repo,h.f.task,out,h.f.grant())).toBe(true)
 expect(h.calls).toHaveLength(2)
})
