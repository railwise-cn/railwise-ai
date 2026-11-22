import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { LocalToolHost } from './local-tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { assertGrantAllowsNetwork } from './sandbox-policy.js'
import type { CurrentToolOperation, ToolHostContext } from '../../ports/tool-host.js'
import { EGO_SITE_SIGN_IN_REQUIRED as siteSignInRequired, EGO_TOOLS, type EgoBrowserCapabilityConfig } from '../../contracts/ego-browser.js'
import { operationFingerprint, type TaskRunRepository } from '../../services/task-run-repository.js'
import { currentEgoTaskSpaceBinding, validEgoDocumentEvidence, type EgoClosedSpaceReopenAuthorization } from '../../services/ego-browser-evidence.js'
import { EGO_RESULT_MARKER, runEgoBrowserScript, type EgoBrowserCommandRunner } from '../../services/ego-browser-cli.js'
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const hash = (v: string) => createHash('sha256').update(v).digest('hex')
const fail = (code: string) => Object.assign(new Error(code), { code })
const failurePhases = ['navigation','snapshot','dom_read','selection','control'] as const
const safeFailurePhase = (value:unknown):string|undefined => typeof value==='string' && (failurePhases as readonly string[]).includes(value) ? value : undefined
const sdkFailureCodes = ['ego_browser_grant_expired','ego_browser_user_control','ego_browser_task_space_ambiguous','ego_browser_task_space_missing','ego_browser_task_space_unconfirmed','ego_browser_origin_denied','ego_browser_page_changed','ego_browser_element_not_visible','ego_browser_selector_invalid','ego_browser_element_ambiguous','ego_browser_element_unsupported','ego_browser_protocol_invalid','ego_browser_observation_stale','ego_browser_read_failed']
const safeSdkFailureCode = (code:unknown):string => typeof code==='string'&&sdkFailureCodes.includes(code)?code:'ego_browser_read_failed'
const providerFailureCodes = [...sdkFailureCodes,siteSignInRequired,'ego_browser_scope_required','ego_browser_waiting_user','ego_browser_host_operation_required','ego_browser_target_required','ego_browser_task_space_finished','ego_browser_finish_not_ready','ego_browser_finish_unconfirmed','ego_browser_page_limit','ego_browser_open_required','ego_browser_executable_changed','ego_browser_command_failed','ego_browser_command_timeout','ego_browser_aborted','ego_browser_unavailable','ego_browser_output_limit','execution_grant_scope']
const safeProviderFailureCode = (code:unknown):string => typeof code==='string'&&providerFailureCodes.includes(code)?code:'ego_browser_read_failed'
/** Only fixed enums cross the SDK boundary; native messages/stacks are never evidence. */
function safeSdkDiagnostics(value: unknown): Record<string, unknown> {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const stages = ['control_check','space_list','space_attach','identity_check','page_resolve','initial_url','navigation','snapshot','dom_read','final_control','final_url','space_status']
  const names = ['Error','TypeError','RangeError','SyntaxError','DOMException','AbortError','TimeoutError']
  const codes = ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EPIPE','ENOTFOUND','EAI_AGAIN','EGO_TASK_SPACE_NAME_IN_USE']
  const sdkStage = typeof v.sdkStage === 'string' && stages.includes(v.sdkStage) ? v.sdkStage : undefined
  const nativeErrorName = typeof v.nativeErrorName === 'string' && names.includes(v.nativeErrorName) ? v.nativeErrorName : undefined
  const nativeErrorCode = typeof v.nativeErrorCode === 'string' && codes.includes(v.nativeErrorCode) ? v.nativeErrorCode : undefined
  if (!sdkStage && !nativeErrorName && !nativeErrorCode) return {}
  const nativeErrorCategory = nativeErrorCode === 'EGO_TASK_SPACE_NAME_IN_USE' ? 'space_conflict' : nativeErrorCode === 'ETIMEDOUT' || nativeErrorName === 'TimeoutError' ? 'timeout' : nativeErrorCode ? 'connection' : nativeErrorName === 'AbortError' ? 'aborted' : 'unknown'
  return { ...(sdkStage ? {sdkStage} : {}), ...(nativeErrorName ? {nativeErrorName} : {}), ...(nativeErrorCode ? {nativeErrorCode} : {}), nativeErrorCategory }
}
const sdkDiagnosticPrelude = () => `const diagnostics = error => (${safeSdkDiagnostics.toString()})({sdkStage,nativeErrorName:error?.name,nativeErrorCode:error?.code});`
const selectionErrors = new Set(['ego_browser_selector_invalid','ego_browser_element_ambiguous','ego_browser_element_not_visible','ego_browser_element_unsupported'])
const inputs = {
  ego_browser_finish: z.object({}).strict(),
  ego_browser_open: z.object({ url: z.string().url().max(4096) }).strict(),
  ego_browser_observe: z.object({}).strict(),
  ego_browser_read: z.object({ selector: z.string().min(1).max(256).optional(), observationId: z.string().min(1).max(256).optional(), maxBytes: z.number().int().min(4096).max(524288).optional() }).strict(),
  ego_browser_next_page: z.object({ observationId: z.string().min(1).max(256), targetId: z.string().min(1).max(256) }).strict()
}
/** All executable code is adapter-owned. JSON parameters are data, never code. */
export function egoReadScript(input: Record<string, unknown>): string {
  return `const p = ${JSON.stringify(input)};
const emit = v => console.log(${JSON.stringify(EGO_RESULT_MARKER)} + JSON.stringify(v));
let task, page, failurePhase="control",sdkStage='control_check';
${sdkDiagnosticPrelude()}
const check = () => { if (Date.now() >= p.deadline) {failurePhase='control';throw Object.assign(new Error(), {code:'ego_browser_grant_expired'});} if (task && task.ownership !== 'agent') {failurePhase='control';throw Object.assign(new Error(), {code:'ego_browser_user_control'});} };
try {
 check();
 if(p.recoverExistingOnly) {sdkStage='space_list';const matches=(await listTaskSpaces()).filter(s=>s.name===p.spaceName);if(matches.length!==1)throw Object.assign(new Error(),{code:matches.length?'ego_browser_task_space_ambiguous':'ego_browser_task_space_missing'});if(matches[0].ownership!=='agent')throw Object.assign(new Error(),{code:'ego_browser_user_control'});if(p.spaceId&&matches[0].id!==p.spaceId)throw Object.assign(new Error(),{code:'ego_browser_task_space_unconfirmed'});sdkStage='space_attach';task=await taskSpace(matches[0].id)}
 else {sdkStage='space_attach';task = await taskSpace(p.spaceId ?? p.spaceName);} sdkStage='control_check';check();
 sdkStage='identity_check';
 if(task.name !== p.spaceName || p.spaceId && task.spaceId !== p.spaceId) throw Object.assign(new Error(),{code:'ego_browser_task_space_unconfirmed'});
 sdkStage='page_resolve';page = task.page('p1');
 const identity = {taskSpaceId:task.spaceId,spaceName:task.name,ownership:task.ownership,pageLabel:page.label};
 const allowed = url => { const u=new URL(url); return ['http:','https:'].includes(u.protocol) && !u.username && !u.password && p.origins.includes(u.origin); };
 sdkStage='initial_url';
 if(p.action==='open'&&!p.recoverExistingOnly) { if(!allowed(p.url)) throw Object.assign(new Error(),{code:'ego_browser_origin_denied'}); check(); failurePhase='navigation';sdkStage='navigation'; await page.goto(p.url,{timeout:25000}); }
 else if(!allowed(await page.url())) throw Object.assign(new Error(),{code:'ego_browser_origin_denied'});
 if(p.expectedReadSourceUrl&&await page.url()!==p.expectedReadSourceUrl)throw Object.assign(new Error(),{code:'ego_browser_page_changed'});
 const read = async selector => {
  failurePhase=selector?'selection':'dom_read';sdkStage='dom_read';
  const result=await page.evaluate(({maxBytes,selector:argumentsSelection,expectedReadSourceUrl}) => {
   let phase='control';
   try {
   const sourceUrl=location.href;
   if(expectedReadSourceUrl&&sourceUrl!==expectedReadSourceUrl)throw Object.assign(new Error(),{code:'ego_browser_page_changed'});
   phase='dom_read';
   const candidates=[...document.querySelectorAll('a[href]')].filter(a => /^(?:下一页|下页|next(?: page)?|›|»|→)$/i.test((a.getAttribute('aria-label')||a.textContent||'').trim()) && !a.closest('form') && a.getAttribute('aria-disabled')!=='true').map(a=>({href:a.href,label:(a.getAttribute('aria-label')||a.textContent||'').trim()})).slice(0,10);
   const hidden=n=>{const style=document.defaultView.getComputedStyle(n);return n.hidden||n.getAttribute('aria-hidden')==='true'||style.display==='none'||['hidden','collapse'].includes(style.visibility)};
   const visibleClone=root=>{if(hidden(root))throw Object.assign(new Error(),{code:'ego_browser_element_not_visible'});const clone=root.cloneNode(true),originals=[root,...root.querySelectorAll('*')],copies=[clone,...clone.querySelectorAll('*')];for(let i=1;i<originals.length;i++)if(hidden(originals[i]))copies[i].remove();return clone};
   const loadingObserved=[...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(n=>!hidden(n));
   const clone=document.body?visibleClone(document.body):undefined;
   if(!clone) return {sourceUrl,html:'',truncated:false,candidates:[],loadingObserved,visibleText:false};
   clone.querySelectorAll('script,style,noscript,template,iframe,input,textarea,select,[contenteditable]').forEach(n=>n.remove());
   for(const n of [clone,...clone.querySelectorAll('*')]) for(const a of [...n.attributes]) if(!['href','title','datetime','role','aria-label'].includes(a.name)) n.removeAttribute(a.name);
   for(const a of clone.querySelectorAll('a[href]')) { try {const u=new URL(a.getAttribute('href'),sourceUrl); if(!['http:','https:'].includes(u.protocol)||u.username||u.password)a.removeAttribute('href');else a.setAttribute('href',u.href);} catch {a.removeAttribute('href');} }
   // The subscription page can show a re-login modal outside a visually empty app root.
   const url=new URL(sourceUrl);
   const appRoot=document.getElementById('app');
   const siteSignInRequired=url.origin==='https://dadan.vip' && url.hash.startsWith('#/subscribe/')
     && !!appRoot && !appRoot.innerText?.trim()
     && [...clone.querySelectorAll('p,span,div')].some(node=>{
       const text=node.textContent?.replace(/\\s+/g,'').trim()??'';
       return text.length<=120 && /(?:账号|账户).{0,24}(?:其他|其它)设备.{0,24}请重新登录/.test(text);
     });
   const documentHtml=clone.outerHTML; let selection;
   if(argumentsSelection) { phase='selection'; let matches;try {matches=document.querySelectorAll(argumentsSelection);}catch(error){if(error?.name==='SyntaxError'||error?.name==='DOMException')return {readError:{version:1,code:'ego_browser_selector_invalid',failurePhase:phase}};throw error;} if(matches.length!==1)throw Object.assign(new Error(),{code:'ego_browser_element_ambiguous'}); if(matches[0].matches('script,style,noscript,template,iframe,input,textarea,select,[contenteditable]')||matches[0].closest('[contenteditable]'))throw Object.assign(new Error(),{code:'ego_browser_element_unsupported'}); const selected=visibleClone(matches[0]); selected.querySelectorAll('script,style,noscript,template,iframe,input,textarea,select,[contenteditable]').forEach(n=>n.remove()); for(const n of [selected,...selected.querySelectorAll('*')])for(const a of [...n.attributes])if(!['href','title','datetime','role','aria-label'].includes(a.name))n.removeAttribute(a.name); for(const a of [selected,...selected.querySelectorAll('a[href]')])if(a.matches('a[href]')) {try{const u=new URL(a.getAttribute('href'),sourceUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)a.removeAttribute('href');else a.setAttribute('href',u.href)}catch{a.removeAttribute('href')}} selection={selector:argumentsSelection,matchedCount:1}; clone.replaceChildren(selected); }
   const raw=selection?clone.innerHTML:documentHtml, bytes=new TextEncoder().encode(raw), truncated=bytes.length>maxBytes;
   // SVG metadata can fill textContent while the page still shows no text.
   for(const node of clone.querySelectorAll('title,desc,metadata')){
    if(node.namespaceURI==='http://www.w3.org/2000/svg')node.remove();
   }
   const visibleText=Boolean(clone.textContent?.trim());
   return {sourceUrl,html:truncated?new TextDecoder().decode(bytes.slice(0,maxBytes)):raw,truncated,candidates,documentHtml,selection,loadingObserved,visibleText,siteSignInRequired};
   }catch(error){const code=error?.code;if(['ego_browser_element_ambiguous','ego_browser_element_not_visible','ego_browser_element_unsupported','ego_browser_page_changed'].includes(code))return {readError:{version:1,code,failurePhase:phase}};throw error;}
  },{maxBytes:p.maxBytes,selector,expectedReadSourceUrl:p.expectedReadSourceUrl});
  if(result && Object.prototype.hasOwnProperty.call(result,'readError')) {
   const error=result.readError,keys=error&&typeof error==='object'&&!Array.isArray(error)?Object.keys(error).sort():[];
   const valid=Object.keys(result).length===1 && keys.join(',')==='code,failurePhase,version' && error.version===1 &&
    (error.code==='ego_browser_page_changed'&&error.failurePhase==='control'||['ego_browser_selector_invalid','ego_browser_element_ambiguous','ego_browser_element_not_visible','ego_browser_element_unsupported'].includes(error.code)&&(error.failurePhase==='selection'||error.code==='ego_browser_element_not_visible'&&error.failurePhase==='dom_read'));
   if(!valid)throw Object.assign(new Error(),{code:'ego_browser_protocol_invalid'});
   failurePhase=error.failurePhase;throw Object.assign(new Error(),{code:error.code});
  }
  return result;
 };
 const settledRead=async()=>{let current=await read(undefined);for(let attempt=0;attempt<4&&!current.siteSignInRequired&&(current.loadingObserved||!current.visibleText);attempt++){check();await new Promise(resolve=>setTimeout(resolve,500));check();current=await read(undefined)}return p.selector&&!current.siteSignInRequired&&!current.loadingObserved&&current.visibleText?read(p.selector):current};
 if(p.action==='next') {
   check(); const before=await read(undefined);
   if(before.sourceUrl!==p.expectedSourceUrl || before.html!==p.expectedHtml || before.truncated || !before.candidates.some(x=>x.href===p.url&&x.label===p.label) || !allowed(p.url) || new URL(p.url).origin!==new URL(before.sourceUrl).origin) throw Object.assign(new Error(),{code:'ego_browser_observation_stale'});
   check(); failurePhase='navigation';sdkStage='navigation'; await page.goto(p.url,{timeout:25000});
 }
 failurePhase='control';sdkStage='control_check';check();sdkStage='initial_url'; const sourceUrl=await page.url(); if(!allowed(sourceUrl)) throw Object.assign(new Error(),{code:'ego_browser_origin_denied'});
 const reading=await settledRead();
 if(p.selector && !reading.siteSignInRequired && (reading.documentHtml!==p.expectedDocumentHtml || reading.sourceUrl!==p.expectedSourceUrl)){failurePhase='selection';throw Object.assign(new Error(),{code:'ego_browser_observation_stale'});}
 if(p.action==='observe'){check();failurePhase='snapshot';sdkStage='snapshot';}
 const snapshot=p.action==='observe'?await page.snapshot({scope:'full_page'}):undefined;
 failurePhase='control';sdkStage='final_control';check();sdkStage='final_url';if(reading.sourceUrl!==await page.url())throw Object.assign(new Error(),{code:'ego_browser_page_changed'});
 if(p.action==='observe')emit({...identity,ok:true,sourceUrl:reading.sourceUrl,documentHtml:reading.documentHtml,loadingObserved:reading.loadingObserved,visibleText:reading.visibleText,siteSignInRequired:reading.siteSignInRequired,snapshot:String(snapshot).slice(0,64000)});
 else emit({...identity,ok:true,...reading});
} catch(error) { const code=${JSON.stringify(sdkFailureCodes)}.includes(error?.code)?error.code:'ego_browser_read_failed';let identity={};try{if(task&&task.name===p.spaceName&&Number.isSafeInteger(task.spaceId)&&task.spaceId>0&&(!p.spaceId||task.spaceId===p.spaceId)&&['agent','user','inactive','unassigned','agentDelegatedToUser'].includes(task.ownership))identity={identityVerified:true,taskSpaceId:task.spaceId,spaceName:task.name,ownership:task.ownership,...(page?.label==='p1'?{pageHandleLabel:page.label}:{})};}catch{}emit({ok:false,code,failurePhase,...diagnostics(error),...identity}); }`
}

/** Fixed metadata-only query; never opens a Space or reads a Page. */
export function egoSpaceStatusScript(input:Record<string,unknown>):string {
 return `const p = ${JSON.stringify(input)};
const emit=v=>console.log(${JSON.stringify(EGO_RESULT_MARKER)}+JSON.stringify(v));
let sdkStage='space_status';
${sdkDiagnosticPrelude()}
try {
 if(!Number.isSafeInteger(p.spaceId)||p.spaceId<1||typeof p.spaceName!=='string'||!p.spaceName)throw Object.assign(new Error(),{code:'ego_browser_protocol_invalid'});
 if(Date.now()>=p.deadline)throw Object.assign(new Error(),{code:'ego_browser_grant_expired'});
 sdkStage='space_list';const spaces=await listTaskSpaces();
 if(!Array.isArray(spaces)||spaces.some(s=>!s||!Number.isSafeInteger(s.id)||s.id<0||typeof s.name!=='string'||typeof s.ownership!=='string'))throw Object.assign(new Error(),{code:'ego_browser_protocol_invalid'});
 const ids=spaces.filter(s=>s.id===p.spaceId),names=spaces.filter(s=>s.name===p.spaceName);
 if(ids.length>1)throw Object.assign(new Error(),{code:'ego_browser_protocol_invalid'});
 if(Date.now()>=p.deadline)throw Object.assign(new Error(),{code:'ego_browser_grant_expired'});
 emit({ok:true,kind:'ego_space_status',version:1,taskSpaceId:p.spaceId,spaceName:p.spaceName,idMatch:ids.length===1,nameMatches:names.length,spaceStatus:!ids.length&&!names.length?'closed':'existing',identityMatches:ids.length===1&&ids[0].name===p.spaceName&&names.length===1&&names[0].id===p.spaceId,...(ids.length?{ownership:ids[0].ownership}:{})});
}catch(error){const code=${JSON.stringify(sdkFailureCodes)}.includes(error?.code)?error.code:'ego_browser_read_failed';emit({ok:false,code,failurePhase:'control',...diagnostics(error)});}`
}

/** Finish only the persisted existing agent-owned Space; no Page call after await. */
export function egoFinishScript(input:Record<string,unknown>):string {
  return `const p=${JSON.stringify(input)};
const emit=v=>console.log(${JSON.stringify(EGO_RESULT_MARKER)}+JSON.stringify(v));
try {
 if(!Number.isSafeInteger(p.spaceId)||p.spaceId<1||Date.now()>=p.deadline)throw new Error('finish scope unavailable');
 const task=await taskSpace(p.spaceId);
 if(task.spaceId!==p.spaceId||task.name!==p.spaceName||task.ownership!=='agent'||Date.now()>=p.deadline)throw new Error('finish control unavailable');
 await task.finish({keep:[]});
 emit({ok:true,taskSpaceId:p.spaceId,spaceName:p.spaceName,finishResolved:true,keep:[]});
} catch {emit({ok:false,code:'ego_browser_finish_unconfirmed'});}`
}

function spaceStatusVerdict(status:Record<string,unknown>,spaceId:unknown,spaceName:unknown):'closed'|'agent' {
  if(status.ok!==true)throw fail(safeSdkFailureCode(status.code))
  if(status.kind!=='ego_space_status'||status.version!==1||status.taskSpaceId!==spaceId||status.spaceName!==spaceName||
    typeof status.idMatch!=='boolean'||typeof status.identityMatches!=='boolean'||!Number.isSafeInteger(status.nameMatches)||Number(status.nameMatches)<0||
    !['closed','existing'].includes(String(status.spaceStatus)))throw fail('ego_browser_protocol_invalid')
  if(status.spaceStatus==='closed') {
    if(status.idMatch!==false||status.nameMatches!==0||status.identityMatches!==false||status.ownership!==undefined)throw fail('ego_browser_protocol_invalid')
    return 'closed'
  }
  if(status.idMatch!==true||status.nameMatches!==1||status.identityMatches!==true)throw fail('ego_browser_task_space_unconfirmed')
  if(!['agent','user','inactive','unassigned','agentDelegatedToUser'].includes(String(status.ownership)))throw fail('ego_browser_protocol_invalid')
  if(status.ownership!=='agent')throw fail('ego_browser_user_control')
  return 'agent'
}

export function buildEgoBrowserToolProvider(options: { config: EgoBrowserCapabilityConfig; repository: TaskRunRepository; run?: EgoBrowserCommandRunner; now?: () => number; canFinishReadiness?: (context:ToolHostContext,hostOperationId:string)=>Promise<{ready:boolean;reason?:string}>; canReopenClosedSpace?: (context:ToolHostContext,hostOperationId:string,priorBindingReceiptId:string)=>Promise<EgoClosedSpaceReopenAuthorization|null> }): CapabilityToolProvider {
  const config = options.config, repository = options.repository, run = options.run ?? runEgoBrowserScript
  const identity = operationFingerprint(config), now = options.now ?? Date.now
  const guard = async (context: ToolHostContext) => {
    context.assertExecution?.(); await context.validateExecutionGrant?.()
    const grant = context.executionGrant, task = grant?.taskId ? repository.get(grant.taskId) : null
    if (!grant || !task || task.threadId !== context.threadId || task.activeTurnId !== context.turnId || grant.turnId !== context.turnId || grant.threadId !== context.threadId ||
      grant.workspaceRoot !== task.workspaceRoot || grant.browserScope?.provider !== 'ego-browser' || grant.browserScope.browserInstanceId !== 'ego-browser:'+config.executableHash ||
      grant.browserScope.revision !== config.revision || grant.connectorIdentityFingerprints?.['ego-browser'] !== identity ||
      !grant.allowedProviderIds?.includes('ego-browser') || config.state !== 'installed') throw fail('ego_browser_scope_required')
    if(repository.operations(task.id,'ego_browser_wait').some(r=>r.request?.turnId===context.turnId))throw fail('ego_browser_waiting_user')
    if (context.abortSignal.aborted || !grant.expiresAt || Date.parse(grant.expiresAt) <= now()) throw fail('ego_browser_grant_expired')
    return { grant, task }
  }
  const paginationMeaning = '分页结果中的navigationActionsUsed是本任务累计成功导航动作数（含旧TaskSpace历史），currentSpaceNavigationCount只统计当前TaskSpace；documentPageNumber未从站点核验时为null。pageNumber是累计动作数的旧兼容字段，不是网页页码；不得据此声称已读第几页或完整分页。'
  const descriptions = {
    ego_browser_finish: '成功交付后调用一次：先完成报告/显式核验及已要求的计划读回，再用本工具await原Ego任务空间finish({keep:[]})；成功后直接最终回复，不再调用页面工具。错误/用户接管时不要finish。重复调用只读原真实回执，未知结果不重放。',
    ego_browser_open: '首次在当前任务专属 Ego TaskSpace 打开已授权 URL，只读复用用户现有登录。后续读取或等待异步内容使用ego_browser_read({})，不要反复open刷新同一URL。无需传 TaskSpace 或页面ID；不要用此工具执行表单/登录/业务操作。' + paginationMeaning,
    ego_browser_observe: '只读观察本任务 Ego 页面完整语义快照。用户接管或失去控制时停止，不创建替代 TaskSpace。',
    ego_browser_read: '默认使用ego_browser_read({})直接重新读取本任务当前整页的实际文本与链接HTML，不传selector或旧observationId，无需先observe或重新open。异步页面仅有导航壳、空DOM或加载提示时继续原页实际读取，不能宣称采集完成；只有实际零结果标记才能声明零匹配。仅确需局部内容时使用标准CSS selector，恰好匹配一个当前可见元素，并携带最近一次观察的observationId；不要使用文本/XPath。旧观察或页面变化时优先ego_browser_read({})，不要重放旧选择或重开TaskSpace。来源仅代表实际订阅列表，不代表核验官方原文。' + paginationMeaning,
    ego_browser_next_page: '仅打开最近一次完整读取中实际出现的同源“下一页”链接。使用返回的 observationId/targetId，本任务累计最多10次打开/翻页导航（含旧TaskSpace历史）；无链接式分页时停止说明，不提交按钮或业务表单。' + paginationMeaning
  }
  return { id: 'ego-browser', kind: 'skill', enabled: true, available: config.state === 'installed', tools: EGO_TOOLS.map(name => LocalToolHost.defineTool({
    name, description: descriptions[name], policy: 'auto', inputSchema: z.toJSONSchema(inputs[name]),
    validateArguments: raw => { inputs[name].parse(raw) },
    shouldAdvertise: context => context.executionGrant?.browserScope?.provider === 'ego-browser',
    execute: async (raw, context) => {
      let invocation: CurrentToolOperation | undefined, failurePhase:string|undefined='control', currentSpaceId:unknown
      let failureDetails:Record<string,unknown>={},statusProof:Record<string,unknown>={},originalOpenUrl:string|undefined
      try {
        invocation=context.currentToolOperation?.()
        const args = inputs[name].parse(raw) as Record<string, unknown>, { grant, task } = await guard(context)
        const host=invocation
        if(!host||host.taskId!==task.id||host.turnId!==context.turnId||host.providerId!=='ego-browser'||host.toolName!==name||host.argumentsHash!==operationFingerprint(raw)||host.executionGrantFingerprint!==operationFingerprint(grant))throw fail('ego_browser_host_operation_required')
        let originalBinding=currentEgoTaskSpaceBinding(repository,task.id), firstCreatedSpace=!originalBinding
        currentSpaceId=object(originalBinding?.result).taskSpaceId
        let finishKey=originalBinding?'ego-finish:'+originalBinding.id:undefined,previousFinish=finishKey?repository.operation(task.id,finishKey):null
        if(previousFinish&&name!=='ego_browser_finish')throw fail('ego_browser_task_space_finished')
        const sourceBindingId=originalBinding?.id
        const currentReadSealed=originalBinding?.status==='succeeded'&&repository.operations(task.id,'ego_document_read').some(row=>{
          if(row.status!=='succeeded'||row.request?.turnId!==context.turnId||object(row.result).taskSpaceId!==currentSpaceId)return false
          const owner=repository.operationById(task.id,String(row.request.hostOperationId),'tool'),output=object(object(object(owner?.result).item).output)
          return object(output.evidence).bindingReceiptId===sourceBindingId&&validEgoDocumentEvidence(repository,task,output,grant)
        })
        if(['ego_browser_read','ego_browser_observe','ego_browser_next_page'].includes(name)&&originalBinding?.status==='succeeded'&&originalBinding.request?.createdTurnId!==context.turnId&&!currentReadSealed) {
          const prior=originalBinding,bound=object(prior.result),grantFingerprint=operationFingerprint(grant)
          if(prior.request?.configurationFingerprint!==identity||operationFingerprint(prior.request.origins)!==operationFingerprint(grant.browserScope!.origins))throw fail('ego_browser_task_space_unconfirmed')
          const scope={taskId:task.id,threadId:task.threadId,turnId:context.turnId,bindingReceiptId:prior.id,taskSpaceId:bound.taskSpaceId,spaceName:prior.request.spaceName,
            grantFingerprint,configurationFingerprint:identity,origins:grant.browserScope!.origins,deadline:Date.parse(grant.expiresAt!)}
          // A real metadata query is cached only through the enclosing approved Host result.
          // This receipt is not source evidence, navigation, or a successful Page read.
          const cached=repository.operations(task.id,'ego_task_space_status').reverse().find(row=>{
            if(row.status!=='succeeded'||row.fingerprint!==operationFingerprint(row.request))return false
            const request=object(row.request)
            if(Object.entries(scope).some(([key,value])=>operationFingerprint(request[key])!==operationFingerprint(value)))return false
            const owner=repository.operationById(task.id,String(request.hostOperationId),'tool'),ownerRequest=object(owner?.request),saved=object(owner?.result),item=object(saved.item),output=object(item.output)
            return Boolean(owner&&owner.fingerprint===operationFingerprint(owner.request)&&['succeeded','failed'].includes(owner.status)&&saved.approved===true&&
              ownerRequest.providerId==='ego-browser'&&['ego_browser_read','ego_browser_observe','ego_browser_next_page'].includes(String(ownerRequest.toolName))&&
              ownerRequest.turnId===context.turnId&&ownerRequest.callId===request.callId&&ownerRequest.argumentsHash===request.argumentsHash&&operationFingerprint(ownerRequest.executionGrant)===grantFingerprint&&
              item.kind==='tool_result'&&item.status==='completed'&&item.threadId===task.threadId&&item.turnId===context.turnId&&item.callId===request.callId&&item.toolName===ownerRequest.toolName&&
              output.spaceStatusReceiptId===row.id&&output.spaceStatusResultHash===operationFingerprint(row.result)&&
              (object(row.result).spaceStatus==='closed'
                ? owner.status==='failed'&&item.isError===true&&output.status==='blocked'&&output.code==='ego_browser_open_required'
                : owner.status==='succeeded'&&item.isError===false&&output.status==='succeeded'||owner.status==='failed'&&item.isError===true&&output.status==='blocked'))
          })
          let status:Record<string,unknown>,receipt=cached
          if(cached)status=object(cached.result)
          else {
            const key='ego-space-status:'+randomUUID()
            receipt=repository.beginOperation({ownerId:task.id,idempotencyKey:key,kind:'ego_task_space_status',request:{...scope,hostOperationId:host.operationId,callId:host.callId,argumentsHash:host.argumentsHash},nowIso:new Date(now()).toISOString()}).receipt
            let responseReturned=false
            try {
              failureDetails={sdkStage:'space_status',nativeErrorCategory:'unknown'}
              const response=await run(config,egoSpaceStatusScript({action:'space_status',spaceId:bound.taskSpaceId,spaceName:prior.request.spaceName,deadline:scope.deadline}),context.abortSignal)
              responseReturned=true
              failureDetails=safeSdkDiagnostics(response)
              await guard(context)
              if(currentEgoTaskSpaceBinding(repository,task.id)?.id!==prior.id)throw fail('ego_browser_task_space_unconfirmed')
              if(response.ok===true&&response.kind==='ego_space_status'&&response.version===1&&response.taskSpaceId===bound.taskSpaceId&&response.spaceName===prior.request.spaceName&&response.spaceStatus==='existing'&&response.idMatch===true&&response.nameMatches===1&&response.identityMatches===true&&['agent','user','inactive','unassigned','agentDelegatedToUser'].includes(String(response.ownership))) {
                failureDetails.verifiedIdentity={taskSpaceId:bound.taskSpaceId,spaceName:prior.request.spaceName,ownership:response.ownership}
              }
              spaceStatusVerdict(response,bound.taskSpaceId,prior.request.spaceName)
              status={ok:true,kind:'ego_space_status',version:1,taskSpaceId:response.taskSpaceId,spaceName:response.spaceName,idMatch:response.idMatch,nameMatches:response.nameMatches,
                spaceStatus:response.spaceStatus,identityMatches:response.identityMatches,...(response.ownership!==undefined?{ownership:response.ownership}:{})}
              receipt=repository.finishOperation(task.id,key,{status:'succeeded',result:status},new Date(now()).toISOString())
              failureDetails={}
            } catch(error) {
              failureDetails={sdkStage:'space_status',nativeErrorCategory:'unknown',...failureDetails,...(!responseReturned?safeSdkDiagnostics({sdkStage:'space_status',nativeErrorName:object(error).name,nativeErrorCode:object(error).code}):{})}
              repository.finishOperation(task.id,key,{status:'failed',result:{code:safeProviderFailureCode(object(error).code??(error instanceof Error?error.message:undefined)),...failureDetails}},new Date(now()).toISOString())
              throw error
            }
          }
          statusProof={spaceStatusReceiptId:receipt!.id,spaceStatusResultHash:operationFingerprint(status)}
          await guard(context)
          if(currentEgoTaskSpaceBinding(repository,task.id)?.id!==prior.id)throw fail('ego_browser_task_space_unconfirmed')
          if(spaceStatusVerdict(status,bound.taskSpaceId,prior.request.spaceName)==='closed') {
            const initial=repository.operations(task.id,'ego_page_navigation').find(row=>row.status==='succeeded'&&row.fingerprint===operationFingerprint(row.request)&&row.request?.action==='open'&&object(row.result).taskSpaceId===bound.taskSpaceId)
            try {const url=new URL(String(initial?.request?.sourceUrl));if(!url.username&&!url.password&&!url.search&&(!url.hash||/^#\/[A-Za-z0-9/_-]*$/.test(url.hash))&&grant.browserScope!.origins.includes(url.origin))originalOpenUrl=url.href}catch{/* Never echo private URL query tokens in recovery instructions. */}
            throw fail('ego_browser_open_required')
          }
        }
        if(name==='ego_browser_open') {
          const target=new URL(String(args.url)), goalUrls=[...task.goal.matchAll(/https?:\/\/[^\s<>"'`）)，。]+/gi)].flatMap(match=>{try{const u=new URL(match[0]);return u.username||u.password?[]:[u.href]}catch{return []}})
          if(target.username||target.password||!goalUrls.includes(target.href))throw fail('ego_browser_target_required')
          assertGrantAllowsNetwork(target.href,context);if(!grant.browserScope!.origins.includes(target.origin))throw fail('ego_browser_origin_denied')
        }
        if(name==='ego_browser_open'&&originalBinding?.status==='succeeded'&&options.canReopenClosedSpace) {
          const prior=originalBinding, priorSpace=object(prior.result)
          if(prior.request?.configurationFingerprint!==identity||operationFingerprint(prior.request.origins)!==operationFingerprint(grant.browserScope!.origins)||!Number.isSafeInteger(priorSpace.taskSpaceId)||Number(priorSpace.taskSpaceId)<1)throw fail('ego_browser_task_space_unconfirmed')
          const status=await run(config,egoSpaceStatusScript({action:'space_status',spaceId:priorSpace.taskSpaceId,spaceName:prior.request.spaceName,deadline:Date.parse(grant.expiresAt!)}),context.abortSignal)
          await guard(context)
          if(currentEgoTaskSpaceBinding(repository,task.id)?.id!==prior.id)throw fail('ego_browser_task_space_unconfirmed')
          if(spaceStatusVerdict(status,priorSpace.taskSpaceId,prior.request.spaceName)==='closed') {
            if(prior.request.createdTurnId===context.turnId||repository.operations(task.id).some(row=>row.id!==host.operationId&&((row.kind==='tool'&&['prepared','running','outcome_unknown'].includes(row.status))||(row.kind==='ego_task_space_finish'&&['prepared','running','outcome_unknown'].includes(row.status)))))throw fail('ego_browser_task_space_missing')
            const auth=await options.canReopenClosedSpace?.(context,host.operationId,prior.id)
            if(!auth||auth.turnId!==context.turnId||auth.priorBindingReceiptId!==prior.id||!auth.resumeReceiptId||!auth.controlOwnerId)throw fail('ego_browser_task_space_missing')
            await guard(context)
            const consumeKey='ego-reopen:'+auth.resumeReceiptId,newBindingKey='ego-task-space:resume:'+auth.resumeReceiptId,nonce=randomUUID(),spaceName='RailWise read-only '+task.id+' '+nonce
            originalBinding=repository.transact(()=>{
              if(currentEgoTaskSpaceBinding(repository,task.id)?.id!==prior.id||repository.operation(task.id,consumeKey))throw fail('ego_browser_task_space_missing')
              const request={taskId:task.id,...auth,newBindingKey,spaceName,nonce,hostOperationId:host.operationId,callId:host.callId,grantFingerprint:operationFingerprint(grant),configurationFingerprint:identity,priorTaskSpaceId:priorSpace.taskSpaceId,priorSpaceName:prior.request!.spaceName}
              const consume=repository.beginOperation({ownerId:task.id,idempotencyKey:consumeKey,kind:'ego_task_space_reopen',request,nowIso:new Date(now()).toISOString()}).receipt
              const binding=repository.beginOperation({ownerId:task.id,idempotencyKey:newBindingKey,kind:'ego_task_space',request:{taskId:task.id,threadId:task.threadId,spaceName,nonce,createdTurnId:context.turnId,configurationFingerprint:identity,origins:grant.browserScope!.origins,priorBindingReceiptId:prior.id,resumeReceiptId:auth.resumeReceiptId,controlOwnerId:auth.controlOwnerId,reopenReceiptId:consume.id},nowIso:new Date(now()).toISOString()}).receipt
              repository.finishOperation(task.id,consumeKey,{status:'succeeded',result:{closed:true,priorTaskSpaceId:priorSpace.taskSpaceId,priorSpaceName:prior.request!.spaceName,idMatch:false,nameMatches:0}},new Date(now()).toISOString())
              return binding
            })
            firstCreatedSpace=true;currentSpaceId=undefined
          } else {
            if(status.spaceStatus!=='existing'||status.idMatch!==true||status.nameMatches!==1||status.identityMatches!==true)throw fail('ego_browser_task_space_unconfirmed')
            if(typeof status.ownership!=='string')throw fail('ego_browser_protocol_invalid')
            if(status.ownership!=='agent')throw fail('ego_browser_user_control')
          }
        }
        finishKey=originalBinding?'ego-finish:'+originalBinding.id:undefined;previousFinish=finishKey?repository.operation(task.id,finishKey):null
        if(previousFinish&&name!=='ego_browser_finish')throw fail('ego_browser_task_space_finished')
        if(name==='ego_browser_finish') {
          if(previousFinish) {if(previousFinish.status==='succeeded')return {output:{...object(previousFinish.result),reused:true}};throw fail('ego_browser_finish_unconfirmed')}
          if(!originalBinding||originalBinding.status!=='succeeded'||originalBinding.fingerprint!==operationFingerprint(originalBinding.request)||originalBinding.request?.configurationFingerprint!==identity)throw fail('ego_browser_open_required')
          const ready=await options.canFinishReadiness?.(context,host.operationId)
          if(!ready?.ready)return {isError:true,output:{status:'blocked',provider:'ego-browser',code:'ego_browser_finish_not_ready',message:ready?.reason??'尚未通过本任务的成功交付核验，请先完成实际读取、成果验证与已要求的计划读回。'}}
          await guard(context)
          const bound=object(originalBinding.result),request={taskId:task.id,turnId:context.turnId,bindingReceiptId:originalBinding.id,taskSpaceId:bound.taskSpaceId,pageLabel:bound.pageLabel,hostOperationId:host.operationId,callId:host.callId,grantFingerprint:operationFingerprint(grant),configurationFingerprint:identity,keep:[]}
          const receipt=repository.beginOperation({ownerId:task.id,idempotencyKey:finishKey!,kind:'ego_task_space_finish',request,nowIso:new Date(now()).toISOString()}).receipt
          try {
            const result=await run(config,egoFinishScript({spaceId:bound.taskSpaceId,spaceName:originalBinding.request.spaceName,deadline:Date.parse(grant.expiresAt!)}),context.abortSignal)
            if(result.ok!==true||result.taskSpaceId!==bound.taskSpaceId||result.spaceName!==originalBinding.request.spaceName||result.finishResolved!==true||operationFingerprint(result.keep)!==operationFingerprint([]))throw fail('ego_browser_finish_unconfirmed')
            await guard(context)
            const output={status:'succeeded',provider:'ego-browser',action:'finish',finishResolved:true,keep:[],sessionId:String(bound.taskSpaceId),taskSpaceId:bound.taskSpaceId,pageLabel:bound.pageLabel,bindingReceiptId:originalBinding.id,finishReceiptId:receipt.id,turnId:context.turnId,grantFingerprint:operationFingerprint(grant),configurationFingerprint:identity}
            repository.finishOperation(task.id,finishKey!,{status:'succeeded',result:output},new Date(now()).toISOString())
            return {output}
          } catch(error) {
            repository.finishOperation(task.id,finishKey!,{status:'outcome_unknown',result:{code:'ego_browser_finish_unconfirmed',taskSpaceId:bound.taskSpaceId,bindingReceiptId:originalBinding.id}},new Date(now()).toISOString())
            throw error
          }
        }
        const key = originalBinding?.idempotencyKey??'ego-task-space', origins = grant.browserScope!.origins
        let binding = originalBinding
        const previousRead=repository.operations(task.id,'ego_document_read').filter(r=>r.status==='succeeded'&&object(r.result).taskSpaceId===object(binding?.result).taskSpaceId).at(-1), previousDocument=object(previousRead?.result)
        const nonce=String(binding?.request?.nonce??randomUUID()), spaceName=String(binding?.request?.spaceName??'RailWise read-only '+task.id+' '+nonce)
        const bindingRequest = { taskId: task.id, threadId: task.threadId, spaceName,nonce,createdTurnId:binding?.request?.createdTurnId??context.turnId,configurationFingerprint: identity, origins,...(binding?.request?.priorBindingReceiptId?{priorBindingReceiptId:binding.request.priorBindingReceiptId,resumeReceiptId:binding.request.resumeReceiptId,controlOwnerId:binding.request.controlOwnerId,reopenReceiptId:binding.request.reopenReceiptId}:{}) }
        if(['ego_browser_open','ego_browser_next_page'].includes(name)&&repository.operations(task.id,'ego_page_navigation').filter(r=>r.status==='succeeded').length>=10)throw fail('ego_browser_page_limit')
        if (binding && (binding.fingerprint !== operationFingerprint(bindingRequest) || binding.status !== 'succeeded' && !(binding.status==='prepared'&&(firstCreatedSpace||binding.request?.createdTurnId!==context.turnId)))) throw fail('ego_browser_task_space_unconfirmed')
        if (!binding && name !== 'ego_browser_open') throw fail('ego_browser_open_required')
        if (!binding) binding = repository.beginOperation({ownerId:task.id,idempotencyKey:key,kind:'ego_task_space',request:bindingRequest,nowIso:new Date(now()).toISOString()}).receipt
        const recoverExistingOnly=binding.status==='prepared'&&!firstCreatedSpace
        const navigating=['ego_browser_open','ego_browser_next_page'].includes(name)&&!recoverExistingOnly
        if(recoverExistingOnly&&name==='ego_browser_next_page')throw fail('ego_browser_open_required')
        const bound = object(binding.result), action = name.slice('ego_browser_'.length), maxBytes = Number(args.maxBytes ?? 262144)
        const params: Record<string,unknown> = {action:action==='next_page'?'next':action,spaceName,recoverExistingOnly,...(bound.taskSpaceId?{spaceId:bound.taskSpaceId}:{}),origins,maxBytes,deadline:Date.parse(grant.expiresAt!),...('url' in args?{url:args.url}:{}),...(args.selector?{selector:args.selector}:{})}
        if (name==='ego_browser_open') { assertGrantAllowsNetwork(String(args.url),context); if(!origins.includes(new URL(String(args.url)).origin))throw fail('ego_browser_origin_denied') }
        if(args.selector) {
          const current=repository.operationById(task.id,String(args.observationId),'ego_document_read')??repository.operationById(task.id,String(args.observationId),'ego_observation')
          const value=object(current?.result)
          const all=[...repository.operations(task.id,'ego_document_read'),...repository.operations(task.id,'ego_observation')].sort((a,b)=>a.createdAt.localeCompare(b.createdAt))
          if(!current||current.status!=='succeeded'||current.fingerprint!==operationFingerprint(current.request)||all.at(-1)?.id!==current.id||
            current.request?.taskId!==task.id||current.request.turnId!==context.turnId||current.request.grantFingerprint!==operationFingerprint(grant)||current.request.configurationFingerprint!==identity||
            value.taskSpaceId!==bound.taskSpaceId||typeof value.sourceUrl!=='string'||typeof value.documentHtml!=='string')throw fail('ego_browser_observation_stale')
          params.expectedDocumentHtml=value.documentHtml;params.expectedSourceUrl=value.sourceUrl;params.contextReceiptId=current.id
        }
        if (name==='ego_browser_next_page') {
          const observations=repository.operations(task.id,'ego_document_read').filter(r=>r.status==='succeeded'), latest=observations.at(-1), previous=object(latest?.result), targets=Array.isArray(previous.nextPages)?previous.nextPages:[]
          const target=targets.map(object).find(t=>t.targetId===args.targetId)
          if(!latest || latest.id!==args.observationId || !target || previous.truncated!==false || previous.taskSpaceId!==bound.taskSpaceId)throw fail('ego_browser_observation_stale')
          if(repository.operations(task.id,'ego_page_navigation').filter(r=>r.status==='succeeded').length>=10)throw fail('ego_browser_page_limit')
          params.url=target.href;params.label=target.label;params.expectedSourceUrl=previous.sourceUrl;params.expectedHtml=previous.documentHtml
          assertGrantAllowsNetwork(String(target.href),context)
        }
        let dispatchKey='ego-call:'+randomUUID(), request:Record<string,unknown>={taskId:task.id,turnId:context.turnId,taskSpaceId:bound.taskSpaceId??null,
          grantFingerprint:operationFingerprint(grant),configurationFingerprint:identity,hostOperationId:host.operationId,callId:host.callId,action,sourceUrl:params.url??null,firstCreatedSpace,previousReadReceiptId:previousRead?.id??null,previousSourceUrl:previousDocument.sourceUrl??null,previousResultHash:typeof previousDocument.documentHtml==='string'?hash(previousDocument.documentHtml):null}
        const dispatch=repository.beginOperation({ownerId:task.id,idempotencyKey:dispatchKey,kind:navigating?'ego_page_navigation':'ego_page_observation',request,nowIso:new Date(now()).toISOString()}).receipt
        failurePhase=undefined
        let result=await run(config,egoReadScript(params),context.abortSignal), usingSelector=Boolean(args.selector)
        let recoveredFrom:{code:string;failurePhase:string;failedDispatchReceiptId:string;contextReceiptId:string}|undefined
        const recordFailure=(response:Record<string,unknown>)=>{
          failurePhase=safeFailurePhase(response.failurePhase)
          failureDetails=safeSdkDiagnostics(response)
          const knownSpace=response.spaceName===spaceName&&Number.isSafeInteger(response.taskSpaceId)&&Number(response.taskSpaceId)>0&&(response.pageLabel==='p1'||response.identityVerified===true)&&(!bound.taskSpaceId||response.taskSpaceId===bound.taskSpaceId)
          const lostControl=knownSpace&&typeof response.ownership==='string'&&response.ownership!=='agent'
          if(response.identityVerified===true&&response.spaceName===spaceName&&Number.isSafeInteger(response.taskSpaceId)&&Number(response.taskSpaceId)>0&&(!bound.taskSpaceId||response.taskSpaceId===bound.taskSpaceId)&&['agent','user','inactive','unassigned','agentDelegatedToUser'].includes(String(response.ownership))) {
            failureDetails.verifiedIdentity={taskSpaceId:response.taskSpaceId,spaceName,ownership:response.ownership,...(response.pageHandleLabel==='p1'?{pageHandleLabel:'p1'}:{})}
          }
          if(lostControl)failurePhase='control'
          const code=lostControl?'ego_browser_user_control':safeSdkFailureCode(response.code)
          repository.finishOperation(task.id,dispatchKey,{status:'failed',result:{code,...(failurePhase?{failurePhase}:{}),...failureDetails}},new Date(now()).toISOString())
          return {code,knownSpace}
        }
        if(result.ok!==true) {
          const failed=recordFailure(result)
          await guard(context)
          const current=typeof params.contextReceiptId==='string'?repository.operationById(task.id,params.contextReceiptId):null
          const latest=[...repository.operations(task.id,'ego_document_read'),...repository.operations(task.id,'ego_observation')].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).at(-1)
          if(name!=='ego_browser_read'||!usingSelector||failed.code!=='ego_browser_observation_stale'||failurePhase!=='selection'||!failed.knownSpace||result.ownership!=='agent'||
            !current||current.id!==latest?.id||current.status!=='succeeded'||current.fingerprint!==operationFingerprint(current.request)||current.request?.taskId!==task.id||
            current.request.turnId!==context.turnId||current.request.grantFingerprint!==operationFingerprint(grant)||current.request.configurationFingerprint!==identity||
            object(current.result).taskSpaceId!==bound.taskSpaceId||object(current.result).sourceUrl!==params.expectedSourceUrl)throw fail(failed.code)
          recoveredFrom={code:failed.code,failurePhase:'selection',failedDispatchReceiptId:dispatch.id,contextReceiptId:current.id}
          // A new bounded read of the same existing Page, never a selector replay or navigation.
          const freshParams={action:'read',spaceName,spaceId:bound.taskSpaceId,recoverExistingOnly:true,origins,maxBytes,deadline:Date.parse(grant.expiresAt!),expectedReadSourceUrl:params.expectedSourceUrl}
          await guard(context)
          dispatchKey='ego-call:'+randomUUID()
          request={...request,action:'read',taskSpaceId:bound.taskSpaceId,sourceUrl:params.expectedSourceUrl,firstCreatedSpace:false,recoveredFrom}
          repository.beginOperation({ownerId:task.id,idempotencyKey:dispatchKey,kind:'ego_page_observation',request,nowIso:new Date(now()).toISOString()})
          failurePhase=undefined
          result=await run(config,egoReadScript(freshParams),context.abortSignal)
          if(result.ok!==true){const failure=recordFailure(result);await guard(context);throw fail(failure.code)}
          usingSelector=false
          if(result.sourceUrl!==params.expectedSourceUrl) {recordFailure({code:'ego_browser_page_changed',failurePhase:'control'});throw fail('ego_browser_page_changed')}
        }
        failurePhase='control'
        await guard(context)
        if(typeof result.ownership==='string'&&result.ownership!=='agent')throw fail('ego_browser_user_control')
        if (result.spaceName!==spaceName || result.ownership!=='agent' || !Number.isSafeInteger(result.taskSpaceId) || Number(result.taskSpaceId)<1 || result.pageLabel!=='p1' || bound.taskSpaceId && result.taskSpaceId!==bound.taskSpaceId)throw fail('ego_browser_task_space_unconfirmed')
        currentSpaceId=result.taskSpaceId
        if (binding.status==='prepared') binding=repository.finishOperation(task.id,key,{status:'succeeded',result:{taskSpaceId:result.taskSpaceId,pageLabel:'p1',ownership:'agent'}},new Date(now()).toISOString())
        const sourceUrl=String(result.sourceUrl??'');assertGrantAllowsNetwork(sourceUrl,context)
        const observedUrl = new URL(sourceUrl)
        if(!origins.includes(observedUrl.origin))throw fail('ego_browser_origin_denied')
        if (result.siteSignInRequired === true && observedUrl.origin === 'https://dadan.vip' && observedUrl.hash.startsWith('#/subscribe/')) {
          // Keep the observed navigation and the original Space, without sealing this page as subscription evidence.
          repository.finishOperation(task.id,dispatchKey,{status:'succeeded',result:{sourceUrl,taskSpaceId:result.taskSpaceId,siteSignInRequired:true}},new Date(now()).toISOString())
          throw fail(siteSignInRequired)
        }
        if(name==='ego_browser_observe') {repository.finishOperation(task.id,dispatchKey,{status:'succeeded',result:{sourceUrl,taskSpaceId:result.taskSpaceId}},new Date(now()).toISOString());const observationKey='ego-observe:'+randomUUID();const observation=repository.beginOperation({ownerId:task.id,idempotencyKey:observationKey,kind:'ego_observation',request:{...request,taskSpaceId:result.taskSpaceId,...(args.selector?{selector:args.selector,contextReceiptId:params.contextReceiptId}:{})},nowIso:new Date(now()).toISOString()}).receipt;repository.finishOperation(task.id,observationKey,{status:'succeeded',result:{sourceUrl,taskSpaceId:result.taskSpaceId,documentHtml:result.documentHtml}},new Date(now()).toISOString());return {output:{status:'succeeded',provider:'ego-browser',...statusProof,sessionId:String(result.taskSpaceId),sourceUrl,snapshot:result.snapshot,loadingObserved:result.loadingObserved===true,emptyObserved:result.visibleText===false,observationId:observation.id}}}
        if(typeof result.html!=='string' || typeof result.truncated!=='boolean')throw fail('ego_browser_protocol_invalid')
        const resultHash=hash(result.html), readKey='ego-read:'+randomUUID()
        repository.finishOperation(task.id,dispatchKey,{status:'succeeded',result:{sourceUrl,resultHash,taskSpaceId:result.taskSpaceId}},new Date(now()).toISOString())
        const candidates=Array.isArray(result.candidates)?result.candidates.map(object):[]
        const nextPages=candidates.filter(t=>typeof t.href==='string'&&typeof t.label==='string'&&/^(?:下一页|下页|next(?: page)?|›|»|→)$/i.test(t.label)&&new URL(String(t.href)).origin===new URL(sourceUrl).origin).slice(0,10).map(t=>({targetId:hash(String(t.href)+'\n'+t.label),href:t.href,label:t.label}))
        if(!usingSelector&&result.selection!==undefined)throw fail('ego_browser_protocol_invalid')
        const selection=usingSelector?{selector:args.selector,matchedCount:1,contextReceiptId:params.contextReceiptId,documentHash:hash(String(result.documentHtml))}:undefined
        if(selection&&(object(result.selection).selector!==selection.selector||object(result.selection).matchedCount!==1))throw fail('ego_browser_element_ambiguous')
        const navigations=repository.operations(task.id,'ego_page_navigation').filter(r=>r.status==='succeeded')
        const navigationActionsUsed=navigations.length
        const currentSpaceNavigationCount=navigations.filter(r=>object(r.result).taskSpaceId===result.taskSpaceId).length
        // Keep the historical alias readable; neither count attests a site's page number.
        const pagination={pageNumber:navigationActionsUsed,pageNumberMeaning:'task_navigation_actions_used',navigationActionsUsed,currentSpaceNavigationCount,documentPageNumber:null,hasMore:nextPages.length?true:null,nextTargetsCount:nextPages.length,pageLimit:10,limitReached:navigationActionsUsed>=10}
        const saved={pagination,loadingObserved:result.loadingObserved===true,emptyObserved:result.visibleText===false,sourceUrl,html:result.html,resultHash,truncated:result.truncated,taskSpaceId:result.taskSpaceId,nextPages,documentHtml:result.documentHtml,...(selection?{selection}:{}),...(recoveredFrom?{recoveredFrom}:{})}
        const read=repository.beginOperation({ownerId:task.id,idempotencyKey:readKey,kind:'ego_document_read',request:{...request,taskSpaceId:result.taskSpaceId,...(usingSelector?{selector:args.selector,contextReceiptId:params.contextReceiptId}:{})},nowIso:new Date(now()).toISOString()}).receipt
        repository.finishOperation(task.id,readKey,{status:'succeeded',result:saved},new Date(now()).toISOString())
        return {output:{status:'succeeded',provider:'ego-browser',...statusProof,sessionId:String(result.taskSpaceId),sourceKind:'actual_ego_document',readScope:selection?'element':'document',sourceUrl,html:result.html,resultHash,truncated:result.truncated,taskSpaceId:result.taskSpaceId,nextPages,pagination,loadingObserved:result.loadingObserved===true,emptyObserved:result.visibleText===false,observationId:read.id,...(recoveredFrom?{recoveredFrom}:{}),
          evidence:{verified:true,contentRead:Boolean(result.html.trim()),taskId:task.id,turnId:context.turnId,taskSpaceId:result.taskSpaceId,pageLabel:'p1',bindingReceiptId:binding.id,readReceiptId:read.id,...(navigating?{navigationReceiptId:dispatch.id}:{}),...(selection?{selection}:{}),
            grantFingerprint:operationFingerprint(grant),configurationFingerprint:identity,verifiedAt:new Date(now()).toISOString(),resultHash}}}
      } catch(error) {
        failurePhase=safeFailurePhase(object(error).failurePhase)??failurePhase
        const originalCode=String(object(error).code??(error instanceof Error?error.message:''))
        const code=originalCode==='execution_grant_expired'?'ego_browser_grant_expired':safeProviderFailureCode(originalCode),taskId=context.executionGrant?.taskId
        const message=code===siteSignInRequired?'大单网要求重新登录。请在 Ego 中完成登录，再回到原对话继续。':code==='ego_browser_open_required'&&statusProof.spaceStatusReceiptId?'Ego元数据已确认原任务空间关闭。请调用ego_browser_open('+ (originalOpenUrl?JSON.stringify({url:originalOpenUrl}):'{url:任务最初授权的原始URL}') +')；工具将重新核验本轮授权与关闭状态后恢复原任务，不要改用其他URL或创建替代任务。':selectionErrors.has(code)?'读取选择未完成。普通读取请直接ego_browser_read({})，不传selector或旧observationId；仅确需局部内容时先ego_browser_observe，再使用恰好匹配一个可见元素的标准CSS和最新observationId。无需更换连接、TaskSpace或授权。':code==='ego_browser_observation_stale'||code==='ego_browser_page_changed'?'页面或观察已变化。请先ego_browser_read({})读取当前整页，不传selector或旧observationId；只有确需局部时再观察并重选。不要重放旧选择或重新open刷新。':code==='ego_browser_task_space_missing'||code==='ego_browser_task_space_ambiguous'?'原Ego任务空间尚未确认。已确定关闭的空间只能在你明确继续原任务并核验本次授权后重新建立；结果未知或仍存在的空间不会被替代。请检查原任务的Ego控制状态后继续。':'请检查当前任务的Ego连接、站点范围或用户控制状态后继续。'
        if(taskId&&[siteSignInRequired,'ego_browser_user_control','ego_browser_grant_expired','ego_browser_scope_required','ego_browser_executable_changed','ego_browser_task_space_unconfirmed','ego_browser_task_space_missing','ego_browser_task_space_ambiguous','ego_browser_origin_denied','ego_browser_read_failed','ego_browser_command_failed','ego_browser_command_timeout','ego_browser_protocol_invalid','ego_browser_finish_unconfirmed'].includes(code)) {const waitKey='ego-wait:'+context.turnId; if(!repository.operation(taskId,waitKey)) {const operation=invocation; if(operation){repository.beginOperation({ownerId:taskId,idempotencyKey:waitKey,kind:'ego_browser_wait',request:{taskId,turnId:context.turnId,code,hostOperationId:operation.operationId,callId:operation.callId,grantFingerprint:operation.executionGrantFingerprint,configurationFingerprint:identity,...(currentSpaceId?{taskSpaceId:currentSpaceId}:{})},nowIso:new Date(now()).toISOString()});repository.finishOperation(taskId,waitKey,{status:'succeeded',result:{code,message}},new Date(now()).toISOString())}}}
        return {isError:true,output:{status:'blocked',provider:'ego-browser',code,message,...statusProof,...failureDetails,...(failurePhase?{failurePhase}:{})}}}
    }
  })) }
}
