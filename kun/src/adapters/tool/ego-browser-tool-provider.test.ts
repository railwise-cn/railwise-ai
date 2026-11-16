import { createTurnRecord } from '../../domain/turn.js'
import type { TurnItem } from '../../contracts/items.js'
import { createEgoBrowserFixture } from '../../../tests/ego-browser-test-fixture.js'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserExecutionScope } from '../../contracts/browser-skill.js'
import { KunCapabilitiesConfig } from '../../contracts/capabilities.js'
import { EGO_TOOLS } from '../../contracts/ego-browser.js'
import { egoReadScript, egoFinishScript } from './ego-browser-tool-provider.js'
import { validEgoDocumentEvidence, validEgoNavigationProgress, verifiedEgoTaskSpaceFinish } from '../../services/ego-browser-evidence.js'
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
 const task={spaceId:7,name:'server-task-space-nonce',ownership:'agent',page:()=>({label:'p1',url:async()=>window.location.href,evaluate:async(fn:(arg:unknown)=>unknown,arg:unknown)=>fn(arg),snapshot:async()=> 'article 无独立链接的测绘项目'})}
 const run=async(params:Record<string,unknown>)=>{const rows:Record<string,unknown>[]=[];await new AsyncFunction('taskSpace','console','listTaskSpaces','setTimeout',egoReadScript({spaceId:7,spaceName:task.name,origins:['https://feed.test'],maxBytes:4096,deadline:Date.now()+60000,...params}))(async(id:unknown)=>{if(params.recoverExistingOnly)expect(id).toBe(7);return task},{log:(s:string)=>rows.push(JSON.parse(s.slice('RAILWISE_EGO_RESULT:'.length)) as Record<string,unknown>)},async()=>params.matchingSpaces??[{id:7,name:task.name,ownership:task.ownership}],(callback:()=>void,ms:number)=>{expect(ms).toBe(500);callback()});return rows[0]!}
 try{
  const full=await run({action:'read'});expect(full).toMatchObject({ok:true,truncated:false});expect(String(full.html)).not.toContain('never export');expect(full.loadingObserved).toBe(false)
  expect(await run({action:'open',recoverExistingOnly:true,url:'https://feed.test/list'})).toMatchObject({ok:true,taskSpaceId:7})
  expect(await run({action:'open',recoverExistingOnly:true,matchingSpaces:[]})).toMatchObject({ok:false,code:'ego_browser_task_space_missing'})
  expect(await run({action:'open',recoverExistingOnly:true,matchingSpaces:[{id:7,name:task.name,ownership:'agent'},{id:8,name:task.name,ownership:'agent'}]})).toMatchObject({ok:false,code:'ego_browser_task_space_ambiguous'})
  const selected=await run({action:'read',selector:'article',expectedDocumentHtml:full.documentHtml,expectedSourceUrl:'https://feed.test/list'})
  expect(selected).toMatchObject({ok:true,selection:{selector:'article',matchedCount:1}});expect(String(selected.html)).toContain('无独立链接的测绘项目')
  expect(await run({action:'read',selector:'textarea',expectedDocumentHtml:full.documentHtml,expectedSourceUrl:'https://feed.test/list'})).toMatchObject({ok:false,code:'ego_browser_element_unsupported'})
  window.document.body.innerHTML+='<article>第二条</article>'
  expect(await run({action:'read',selector:'article',expectedDocumentHtml:full.documentHtml,expectedSourceUrl:'https://feed.test/list'})).toMatchObject({ok:false,code:'ego_browser_element_ambiguous'})
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
