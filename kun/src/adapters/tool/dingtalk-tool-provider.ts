import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { DingTalkCapabilityConfig, DingTalkCredential } from '../../contracts/dingtalk.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import type { LocalTool } from './local-tool-host.js'
import { assertGrantAllowsNetwork, assertGrantConnectorScopes } from './sandbox-policy.js'

const API = 'https://api.dingtalk.com'
export const DINGTALK_SCOPES = {
  todoRead: 'Todo.Todo.Read', todoWrite: 'Todo.Todo.Write',
  workflowRead: 'Workflow.Instance.Read', workflowWrite: 'Workflow.Instance.Write', integratedRead: 'qyapi_aflow'
} as const
const id = z.string().trim().min(1).max(200)
const taskId = id.refine(value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)), 'Approval task ID must be a safe integer.')
const todo = z.object({taskId: id}).strict()
const approval = z.object({instanceId: id}).strict()
const action = z.object({instanceId: id, taskId, remark: z.string().max(2000).default('')}).strict()
const transfer = action.extend({toUserId: id})
const list = z.object({nextToken:z.string().max(500).optional()}).strict()
const integratedList = z.object({pageNumber:z.number().int().min(1).default(1), pageSize:z.number().int().min(1).max(100).default(20)}).strict()
type Json = Record<string, unknown>
export type DingTalkProviderDependencies = {
  config: DingTalkCapabilityConfig
  getCredential(reference: string): Promise<DingTalkCredential | null>
  fetch?: typeof fetch
  nowIso?: () => string
}

class RemoteFailure extends Error {
  constructor(readonly code:string, readonly uncertain:boolean) { super(code) }
}
function object(value:unknown):Json { if (!value || typeof value!=='object' || Array.isArray(value)) throw new RemoteFailure('connector_invalid_response',false); return value as Json }
function rows(value:unknown):Json[] { return Array.isArray(value) ? value.filter(v=>v && typeof v==='object'&&!Array.isArray(v)) as Json[] : [] }
function hash(value:unknown):string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function escaped(value:string):string { return encodeURIComponent(value) }

/** Fixed official OpenAPI routes, no Shell/CLI proxy and no model-supplied hosts. */
export function buildDingTalkToolProvider(deps:DingTalkProviderDependencies):CapabilityToolProvider {
  const config=deps.config, fetcher=deps.fetch ?? fetch, now=deps.nowIso ?? (()=>new Date().toISOString())
  const credentialFor=async(workflow:boolean,scopes:string[],context:ToolHostContext,write:boolean):Promise<DingTalkCredential>=>{
    if(!config.enabled)throw new RemoteFailure('connector_disabled',false)
    const reference=workflow?config.workflowCredentialRef:config.credentialRef
    if(!reference)throw new RemoteFailure('connector_authorization_required',false)
    const credential=await deps.getCredential(reference)
    if(!credential || !credential.accessToken || !Number.isFinite(Date.parse(credential.expiresAt)) || Date.parse(credential.expiresAt)<=Date.parse(now()))throw new RemoteFailure('connector_credential_expired',false)
    if(workflow && credential.kind!=='internal-app')throw new RemoteFailure('connector_internal_app_required',false)
    if(config.unionId && config.unionId!==credential.unionId)throw new RemoteFailure('connector_identity_mismatch',false)
    if(workflow && (!config.userId || config.userId!==credential.userId))throw new RemoteFailure('connector_identity_mismatch',false)
    const configuredScopes=workflow?config.scopes:config.userScopes
    if(scopes.some(scope=>!configuredScopes.includes(scope)||!credential.scopes.includes(scope)))throw new RemoteFailure('connector_scope_missing',false)
    assertGrantAllowsNetwork(API,context);assertGrantConnectorScopes(scopes,context)
    if(write && (!config.userId || !config.allowedWriteUserIds.includes(config.userId)))throw new RemoteFailure('connector_write_user_blocked',false)
    return credential
  }
  const request=async(method:string,path:string,credential:DingTalkCredential,context:ToolHostContext,body?:Json,write=false):Promise<{body:Json;requestId?:string}>=>{
    const url=new URL(path,API)
    if(url.origin!==API)throw new RemoteFailure('network_scope_blocked',false)
    assertGrantAllowsNetwork(url.href,context)
    let response:Response
    try { response=await fetcher(url,{method,redirect:'error',headers:{'content-type':'application/json','x-acs-dingtalk-access-token':credential.accessToken},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([context.abortSignal,AbortSignal.timeout(30_000)])}) }
    catch { throw new RemoteFailure('connector_network_failed',write) }
    if(!response.ok)throw new RemoteFailure(response.status===401?'connector_authorization_required':response.status===403?'connector_scope_missing':'connector_remote_failed',write&&response.status>=500)
    let parsed:Json
    try { const text=await response.text();if(Buffer.byteLength(text)>2*1024*1024)throw new Error('size');parsed=object(JSON.parse(text)) }
    catch { throw new RemoteFailure('connector_invalid_response',write) }
    if((parsed.code!==undefined && parsed.code!==0 && parsed.code!=='0')||parsed.success===false||parsed.result===false)throw new RemoteFailure('connector_remote_failed',false)
    return {body:parsed,requestId:response.headers.get('x-acs-request-id')??(typeof parsed.requestId==='string'?parsed.requestId:undefined)}
  }
  const finish=(operation:string,target:string,data:Json,status:string,remoteRequestId?:string,remoteOperationId?:string)=>({
    output:{ok:true,provider:'dingtalk',operation,target,status:'succeeded',...(remoteRequestId?{remoteRequestId}:{}),...(remoteOperationId?{remoteOperationId}:{}),data,
      evidence:{kind:'external_operation',provider:'dingtalk',operation,target,status,verified:true,verifiedAt:now(),resultHash:hash(data),...(remoteOperationId?{remoteOperationId}:{})}}
  })
  const readInstance=async(instanceId:string,credential:DingTalkCredential,context:ToolHostContext)=>{
    const response=await request('GET',`/v1.0/workflow/processInstances?processInstanceId=${escaped(instanceId)}`,credential,context)
    const instance=object(response.body.result)
    if(instance.processInstanceId!==instanceId)throw new RemoteFailure('connector_target_mismatch',false)
    return {instance,requestId:response.requestId}
  }
  const build=(name:string,description:string,schema:z.ZodType,workflow:boolean,scopes:string[],write:boolean,execute:(args:Json,credential:DingTalkCredential,context:ToolHostContext)=>Promise<{output:unknown;isError?:boolean}>):LocalTool=>({
    name,description,inputSchema:z.toJSONSchema(schema) as Json,toolKind:'tool_call',policy:write?'on-request':'auto',requireExplicitApproval:write,
    shouldAdvertise:(context)=>config.enabled && Boolean(workflow?config.workflowCredentialRef:config.credentialRef) && scopes.every(scope=>(workflow?config.scopes:config.userScopes).includes(scope)) && (!context.executionGrant||scopes.every(scope=>context.executionGrant!.connectorScopes.includes(scope))) && (!write||Boolean(config.userId&&config.allowedWriteUserIds.includes(config.userId))),
    async execute(raw,context){
      try {
        const args=schema.parse(raw) as Json
        const credential=await credentialFor(workflow,scopes,context,write)
        // Context cancellation is checked again immediately before entering adapter logic.
        context.abortSignal.throwIfAborted()
        return await execute(args,credential,context)
      }catch(error){
        const remote=error instanceof RemoteFailure?error:undefined
        const code=remote?.code ?? (error && typeof error==='object'&&'code'in error?String(error.code):error instanceof z.ZodError?'connector_invalid_arguments':'connector_failed')
        return {isError:true,output:{ok:false,provider:'dingtalk',status:remote?.uncertain?'outcome_unknown':'failed',code}}
      }
    }
  })
  const tools:LocalTool[]=[
    build('dingtalk_list_tasks','查询当前授权钉钉用户的待办列表；不执行审批。',list,false,[DINGTALK_SCOPES.todoRead],false,async(args,credential,context)=>{
      const response=await request('POST',`/v1.0/todo/users/${escaped(credential.unionId)}/tasks/list`,credential,context,{isDone:false,...(args.nextToken?{nextToken:args.nextToken}:{})})
      if(!Array.isArray(response.body.todoCards))throw new RemoteFailure('connector_invalid_response',false)
      return finish('list',credential.unionId,response.body,'read',response.requestId)
    }),
    build('dingtalk_get_task','查询指定钉钉待办详情。',todo,false,[DINGTALK_SCOPES.todoRead],false,async(args,credential,context)=>{
      const response=await request('GET',`/v1.0/todo/users/${escaped(credential.unionId)}/tasks/${escaped(String(args.taskId))}`,credential,context)
      if(response.body.id!==args.taskId)throw new RemoteFailure('connector_target_mismatch',false)
      return finish('detail',String(args.taskId),response.body,String(response.body.done??'read'),response.requestId)
    }),
    build('dingtalk_complete_task','完成指定钉钉待办；需要用户确认并回读验证，不能代替审批。',todo,false,[DINGTALK_SCOPES.todoRead,DINGTALK_SCOPES.todoWrite],true,async(args,credential,context)=>{
      const target=String(args.taskId),path=`/v1.0/todo/users/${escaped(credential.unionId)}/tasks/${escaped(target)}`
      // A stale or cross-user task must be rejected before dispatch.
      const before=await request('GET',path,credential,context)
      if(before.body.id!==target || !rows(before.body.executorStatus).length&&!Array.isArray(before.body.executorIds))throw new RemoteFailure('connector_target_mismatch',false)
      if(Array.isArray(before.body.executorIds)&&!before.body.executorIds.some(id=>[credential.unionId,config.userId].includes(String(id))))throw new RemoteFailure('connector_target_not_owned',false)
      if(before.body.done===true) return finish('complete',target,before.body,'done')
      const update=await request('PUT',`${path}/executorStatus?operatorId=${escaped(config.userId!)}`,credential,context,{executorStatusList:[{id:config.userId!,isDone:true}]},true)
      let after:Json
      try {after=(await request('GET',path,credential,context)).body} catch {throw new RemoteFailure('connector_readback_unavailable',true)}
      if(after.id!==target||after.done!==true)throw new RemoteFailure('connector_readback_unverified',true)
      return finish('complete',target,after,'done',update.requestId)
    }),
    build('dingtalk_list_approvals','查询通过钉钉流程中心集成的 OA 待办（不是个人全部审批收件箱）。需要企业内部应用 qyapi_aflow 权限。',integratedList,true,[DINGTALK_SCOPES.integratedRead],false,async(args,credential,context)=>{
      const response=await request('GET',`/v1.0/workflow/processCentres/todoTasks?userId=${escaped(config.userId!)}&pageNumber=${args.pageNumber}&pageSize=${args.pageSize}`,credential,context)
      if(!response.body.result||!Array.isArray(object(response.body.result).list))throw new RemoteFailure('connector_invalid_response',false)
      return finish('list',config.userId!,response.body,'read',response.requestId)
    }),
    build('dingtalk_get_approval','读取指定钉钉审批实例与节点状态。',approval,true,[DINGTALK_SCOPES.workflowRead],false,async(args,credential,context)=>{
      const response=await readInstance(String(args.instanceId),credential,context)
      return finish('detail',String(args.instanceId),response.instance,String(response.instance.status??'read'),response.requestId)
    })
  ]
  for(const [name,operation,result] of [['dingtalk_approve','approve','agree'],['dingtalk_reject','reject','refuse'],['dingtalk_transfer','transfer','REDIRECTED']] as const){
    tools.push(build(name,`${operation==='approve'?'同意':operation==='reject'?'拒绝':'转交'}指定钉钉审批节点。操作者由服务端固定；必须确认，且先检查当前节点归属、再写入并回读。`,operation==='transfer'?transfer:action,true,[DINGTALK_SCOPES.workflowRead,DINGTALK_SCOPES.workflowWrite],true,async(args,credential,context)=>{
      const instanceId=String(args.instanceId),target=String(args.taskId)
      const before=await readInstance(instanceId,credential,context)
      const pending=rows(before.instance.tasks).find(task=>String(task.taskId)===target)
      if(!pending || pending.userId!==config.userId || !['NEW','RUNNING'].includes(String(pending.status)))throw new RemoteFailure('connector_target_not_actionable',false)
      const response=operation==='transfer'
        ?await request('POST','/v1.0/workflow/tasks/redirect',credential,context,{operateUserId:config.userId!,taskId:Number(target),toUserId:args.toUserId,remark:args.remark},true)
        :await request('POST','/v1.0/workflow/processInstances/execute',credential,context,{actionerUserId:config.userId!,processInstanceId:instanceId,taskId:Number(target),result,remark:args.remark},true)
      if(response.body.result!==true)throw new RemoteFailure('connector_write_unverified',true)
      let after:Json
      try {after=(await readInstance(instanceId,credential,context)).instance} catch {throw new RemoteFailure('connector_readback_unavailable',true)}
      const old=rows(after.tasks).find(task=>String(task.taskId)===target)
      const expected=operation==='approve'?'AGREE':operation==='reject'?'REFUSE':'REDIRECTED'
      const verified=Boolean(old && String(old.result).toUpperCase()===expected &&
        (operation==='transfer'?rows(after.tasks).some(task=>task.userId===args.toUserId&&['NEW','RUNNING'].includes(String(task.status))):['COMPLETED','TERMINATED'].includes(String(old.status))))
      if(!verified)throw new RemoteFailure('connector_readback_unverified',true)
      return finish(operation,target,after,expected,response.requestId)
    }))
  }
  return {id:'dingtalk',kind:'built-in',enabled:config.enabled,available:Boolean(config.credentialRef||config.workflowCredentialRef),reason:config.enabled?'请先完成钉钉应用配置和授权。':'钉钉连接器已关闭。',tools}
}
