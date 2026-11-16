import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskRunRepository, operationFingerprint as fp } from '../src/services/task-run-repository.js'
import type { TaskRun } from '../src/contracts/tasks.js'
import { ExecutionGrantSchema } from '../src/contracts/permissions.js'
import { EGO_READ_TOOLS } from '../src/contracts/ego-browser.js'
import type { ToolHostContext } from '../src/ports/tool-host.js'
import { buildEgoBrowserToolProvider } from '../src/adapters/tool/ego-browser-tool-provider.js'
const config={state:'installed' as const,executablePath:'/controlled/ego-browser',executableHash:'a'.repeat(64),version:'0.6.3.14',revision:0}
const date='2026-11-16T00:00:00.000Z', html='<body><article><h2>测绘监测项目</h2><time>2026-11-16</time></article><a href="https://feed.test/list?page=2">下一页</a></body>'
export async function createEgoBrowserFixture(){
 const root=await mkdtemp(join(tmpdir(),'ego-browser-protocol-')),repo=new TaskRunRepository(join(root,'tasks.sqlite3'))
 const dispose=async()=>{repo.connection().close();await rm(root,{recursive:true,force:true})}
 const task:TaskRun={id:'task-feed',threadId:'thread-feed',workspaceRoot:'/controlled-workspace',goal:'使用Ego只读 https://feed.test/list 授权订阅列表汇总HTML',status:'running',agentId:'general',childTaskIds:[],acceptance:{kind:'files',requiredNodeKinds:['execute','verify','deliver'],requiresWebEvidence:true,webEvidenceBasis:'observed_feed',requireFinalResponse:true,requireActionableArtifactCard:true},budget:{maxAttempts:8,maxDurationMs:900000,version:2,maxExecutionMs:900000},attempts:1,replans:0,noProgressCount:0,nodes:[],artifacts:[],createdAt:date,updatedAt:date,revision:0,activeTurnId:'turn-feed'}
 repo.create(task)
 let grant=ExecutionGrantSchema.parse({id:'grant-feed',taskId:task.id,threadId:task.threadId,turnId:task.activeTurnId,workspaceRoot:task.workspaceRoot,workspaceTrust:'read-only',agentTrust:'full-access',sandboxMode:'read-only',approvalPolicy:'auto',browserScope:{provider:'ego-browser',browserInstanceId:'ego-browser:'+config.executableHash,origins:['https://feed.test'],interaction:'observe',revision:0},connectorIdentityFingerprints:{'ego-browser':fp(config)},allowedToolNames:[...EGO_READ_TOOLS],allowedProviderIds:['ego-browser'],networkAllowlist:['https://feed.test'],workspaceRevision:0,agentRevision:0,revision:0,idempotencyKey:'grant-feed',issuedAt:date,expiresAt:'2026-11-16T00:15:00.000Z'})
 let count=0,url='https://feed.test/list',ownership='agent',failCode:string|undefined,throwCommand=false,documentHtml=html,clock=Date.parse(date)+1000,expireDuringRun=false
 const calls:Array<Record<string,unknown>>=[]
 const run=async (_config:unknown,script:string)=>{
  const p=JSON.parse(script.split('\n')[0]!.slice('const p = '.length,-1)) as Record<string,unknown>;calls.push(p)
  if(expireDuringRun)clock=Date.parse(grant.expiresAt!)
  if(throwCommand)throw new Error('ego_browser_command_timeout')
  if(p.action==='open'||p.action==='next')url=String(p.url)
  if(failCode)return {ok:false,code:failCode,taskSpaceId:7,spaceName:p.spaceName,ownership,pageLabel:'p1'}
  return {ok:true,taskSpaceId:7,spaceName:p.spaceName,ownership,pageLabel:'p1',sourceUrl:url,html:p.selector?'<article><h2>测绘监测项目</h2><time>2026-11-16</time></article>':documentHtml,documentHtml,truncated:false,snapshot:'article 测绘监测项目',...(p.selector?{selection:{selector:p.selector,matchedCount:1}}:{}),candidates:[{href:'https://feed.test/list?page=2',label:'下一页'}]}
 }
 const provider=buildEgoBrowserToolProvider({config,repository:repo,run,now:()=>clock})
 const execute=async(name:typeof EGO_READ_TOOLS[number],args:Record<string,unknown>={})=>{
  const callId='call-'+(++count),key='tool:'+grant.turnId+':'+callId,request={providerId:'ego-browser',toolName:name,callId,turnId:grant.turnId,argumentsHash:fp(args),executionGrant:grant}
  const host=repo.beginOperation({ownerId:task.id,idempotencyKey:key,kind:'tool',request,nowIso:date}).receipt
  const context:ToolHostContext={threadId:task.threadId,turnId:grant.turnId,workspace:task.workspaceRoot,threadMode:'agent',sandboxMode:'read-only',approvalPolicy:'auto',executionGrant:grant,abortSignal:new AbortController().signal,awaitApproval:async()=>'allow',currentToolOperation:()=>{if(clock>=Date.parse(grant.expiresAt!))throw Object.assign(new Error('grant proof expired'),{code:'execution_grant_expired'});return ({operationId:host.id,idempotencyKey:key,taskId:task.id,turnId:grant.turnId,executionId:'execution',callId,toolName:name,providerId:'ego-browser',argumentsHash:fp(args),executionGrantFingerprint:fp(grant)})}}
  const result=await provider.tools.find(t=>t.name===name)!.execute(args,context)
  repo.finishOperation(task.id,key,{status:result.isError?'failed':'succeeded',result:{approved:true,item:{id:'result-'+callId,kind:'tool_result',status:'completed',createdAt:date,finishedAt:date,threadId:task.threadId,turnId:grant.turnId,callId,toolName:name,isError:Boolean(result.isError),output:result.output}}},date)
  return result.output as Record<string,unknown>
 }
 return {repo,task,provider,calls,execute,dispose,grant:()=>grant,setGrant:(g:typeof grant)=>{grant=g},setOwnership:(s:string)=>{ownership=s},setFailure:(s:string|undefined)=>{failCode=s},setThrown:(value=true)=>{throwCommand=value},setHtml:(value:string)=>{documentHtml=value},setExpireDuringRun:()=>{expireDuringRun=true}}
}
