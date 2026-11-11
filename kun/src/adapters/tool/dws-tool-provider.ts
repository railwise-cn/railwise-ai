import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { DwsCapabilityConfig } from '../../contracts/dws.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { defineLocalTool } from './local-tool-definition.js'
import { assertGrantAllowsExternalTarget, assertGrantAllowsNetwork } from './sandbox-policy.js'
import { assertDwsCredentialAccess, resolveDwsEnvironment } from '../../services/dws-cli-environment.js'
import { parseDwsIdentityBinding } from '../../services/dws-cli-identity.js'

type Json=Record<string,unknown>
export type DwsCommandResult={ok:boolean;output:unknown;errorCode?:string}
export type DwsRunner=(path:string,args:string[],signal:AbortSignal,expectedHash:string)=>Promise<DwsCommandResult>
const exec=promisify(execFile)
const defaultRunner:DwsRunner=async(path,args,signal,expectedHash)=>{
  assertDwsCredentialAccess()
  const env=resolveDwsEnvironment()
  let hash:string
  try{hash=createHash('sha256').update(await readFile(path)).digest('hex')}catch{throw fail('connector_executable_unverified')}
  if(hash!==expectedHash)throw fail('connector_executable_changed')
  try{const result=await exec(path,args,{env,signal,timeout:30_000,maxBuffer:4*1024*1024});return {ok:true,output:parse(String(result.stdout))}}
  catch(error){
    const result=error as {stdout?:string;stderr?:string;code?:string;killed?:boolean;name?:string}
    const errorCode = result.killed || result.name === 'AbortError'
      ? 'connector_request_timeout'
      : ['ENOTFOUND','ECONNREFUSED','ECONNRESET','EAI_AGAIN'].includes(result.code ?? '')
        ? 'connector_network_failed'
        : undefined
    return {ok:false,output:parse(String(result.stdout||result.stderr||'')),errorCode}
  }
}
// Exact flags at upstream 63a7c4906c7d. No raw command, URL, user selector or token is accepted.
// eslint-disable-next-line no-control-regex
const id=z.string().trim().min(1).max(512).refine(value=>!/[\u0000-\u001f]/u.test(value))
const approvalTask=id.refine(value=>/^\d+$/.test(value)&&Number.isSafeInteger(Number(value)))
const todo=z.object({taskId:id}).strict(),instance=z.object({instanceId:id}).strict()
const action=z.object({instanceId:id,taskId:approvalTask,remark:z.string().max(2000).optional()}).strict()
const transfer = action.extend({ toUserId: id }).strict()
const list=z.object({page:z.number().int().min(1).max(1000).default(1),pageSize:z.number().int().min(1).max(100).default(20)}).strict()

/** The provider identity stays dingtalk; only one backend is registered at a time. */
export function buildDwsToolProvider(config:DwsCapabilityConfig|undefined,runner:DwsRunner=defaultRunner):CapabilityToolProvider|undefined {
  if(!config?.enabled||config.authState!=='installed'||!config.executablePath||!config.executableHash||!config.corpId||!config.userId||!config.identityFingerprint||config.profile!==`${config.corpId}:${config.userId}`)return undefined
  const flags=['--profile',config.profile,'--format','json']
  const run=async(args:string[],context:ToolHostContext):Promise<Json>=>{
    assertDwsCredentialAccess();context.abortSignal.throwIfAborted()
    const identity=context.executionGrant?.connectorIdentityFingerprints?.dingtalk
    if(!identity)throw fail('connector_identity_unverified')
    if(identity!==config.identityFingerprint)throw fail('connector_identity_changed')
    const backend = context.executionGrant?.connectorBackends?.dingtalk
    if (backend && backend !== 'dws') throw fail('connector_backend_changed')
    assertGrantAllowsNetwork('https://mcp.dingtalk.com',context)
    context.assertExecution?.()
    const auth=await runner(config.executablePath!,['auth','status','--readonly',...flags],context.abortSignal,config.executableHash!)
    const live=auth.ok?parseDwsIdentityBinding(JSON.stringify(auth.output)):undefined
    if(live?.state!=='installed')throw fail('connector_authorization_required')
    if(live.identityFingerprint!==identity||live.profile!==config.profile)throw fail('connector_identity_changed')
    await context.validateExecutionGrant?.();context.assertExecution?.()
    const response=await runner(config.executablePath!,[...args,...flags],context.abortSignal,config.executableHash!)
    return business(response)
  }
  const evidence=(operation:string,target:string,data:Json,status:string)=>({output:{ok:true,status:'succeeded',provider:'dingtalk',backend:'dws',accountFingerprint:config.identityFingerprint,operation,target,data,
    evidence:{kind:'external_operation',provider:'dingtalk',backend:'dws',accountFingerprint:config.identityFingerprint,operation,target,verified:true,verifiedAt:new Date().toISOString(),status,resultHash:createHash('sha256').update(JSON.stringify(data)).digest('hex')}}})
  const readTodo=async(target:string,context:ToolHostContext)=>{
    const raw=await run(['todo','task','get','--task-id',target],context)
    const detail=findObject(raw,['todoDetailModel','todo','task'])??(stableId(raw)?raw:undefined)
    if(!detail||stableId(detail)!==target)throw fail('connector_target_mismatch')
    return {id:target,...(typeof detail.isDone==='boolean'?{done:detail.isDone}:{}),raw:detail}
  }
  const readApproval=async(target:string,context:ToolHostContext)=>{
    const raw=await run(['oa','approval','detail','--instance-id',target],context)
    const detail=findObject(raw,['processInstance','processInstanceDetail','processInstanceVO'])??raw
    const returned=detail.processInstanceId??detail.process_instance_id
    if(returned!==undefined&&String(returned)!==target)throw fail('connector_target_mismatch')
    const source=Array.isArray(detail.tasks)?detail.tasks:Array.isArray(detail.taskList)?detail.taskList:undefined
    if(!Object.keys(detail).length)throw fail('connector_invalid_response')
    return {processInstanceId:target,tasks:(source??[]).map(value=>{
      const task=object(value)
      return {...task,taskId:String(task.taskId??task.task_id??task.id??''),userId:task.userId??task.user_id??task.actionerUserId,status:task.status??task.taskStatus,result:task.result??task.taskResult}
    }),raw:detail}
  }
  const readTasks=async(target:string,context:ToolHostContext)=>{
    const raw=await run(['oa','approval','tasks','--instance-id',target],context)
    const tasks=findArray(raw,['taskIds','tasks','list'])
    if(!tasks)throw fail('connector_invalid_response')
    return tasks.map(value=>typeof value==='string'?value:typeof value==='number'&&Number.isSafeInteger(value)?String(value):String(object(value).taskId??object(value).id??''))
      .filter(value=>/^\d+$/.test(value)&&Number.isSafeInteger(Number(value)))
  }
  type Spec={name:string;description:string;schema:z.ZodType;operation:string;write?:boolean;execute:(args:Json,context:ToolHostContext,target:string)=>Promise<Json>}
  const define=(spec:Spec)=>defineLocalTool({name:spec.name,description:spec.description,inputSchema:z.toJSONSchema(spec.schema) as Json,
    effect: { provider: 'dingtalk', operation: spec.operation, mutation: Boolean(spec.write), targetFields: ['taskId', 'instanceId'],
      ...(spec.write ? { readbackToolName: spec.operation === 'complete' ? 'dingtalk_get_task' : 'dingtalk_get_approval' } : {}) },
    policy:spec.write?'on-request':'auto',...(spec.write?{requireExplicitApproval:true}:{}),
    async execute(raw,context){
      let dispatched=false
      let target='current_user'
      try{
        const args=spec.schema.parse(raw) as Json
        target=String(args.taskId??args.instanceId??'current_user')
        if(spec.write)assertGrantAllowsExternalTarget('dingtalk',spec.operation,target,context)
        const dispatchContext={...context,assertExecution:()=>{context.assertExecution?.();if(spec.write)assertGrantAllowsExternalTarget('dingtalk',spec.operation,target,context)}}
        let data:Json
        if(spec.write){
          // Establish exact current target and ownership before the mutation.
          if(spec.operation==='complete'){
            const before=await readTodo(target,dispatchContext)
            if(typeof before.done!=='boolean')throw fail('connector_invalid_response')
            if(before.done)return evidence(spec.operation,target,before,'done')
          }else{
            const pending=await readTasks(String(args.instanceId),dispatchContext)
            if(!pending.includes(target))throw fail('connector_target_not_actionable')
          }
          dispatched=true
          await spec.execute(args,dispatchContext,target)
          data=spec.operation==='complete'?await readTodo(target,dispatchContext):await readApproval(String(args.instanceId),dispatchContext)
          const status=spec.operation==='complete'?data.done===true?'done':undefined:verifiedApproval(data,target,spec.operation,args.toUserId)
          if(!status)throw fail('connector_readback_unverified')
          return evidence(spec.operation,target,data,status)
        }
        data=await spec.execute(args,dispatchContext,target)
        return evidence(spec.operation,target,data,'read')
      }catch(error){return {isError:true,output:{ok:false,provider:'dingtalk',backend:'dws',operation:spec.operation,target,status:dispatched?'outcome_unknown':'failed',code:code(error)}}}
    }})
  return {id:'dingtalk',kind:'skill',enabled:true,available:true,tools:[
    define({name:'dingtalk_list_tasks',description:'读取当前已连接钉钉组织和账号的未完成待办；按页返回，不代表全部任务。',schema:list,operation:'list',execute:async(args,context)=>{
      const requestedSize = Number(args.pageSize)
      const pageSize = Math.min(requestedSize, 20)
      const cards: unknown[] = []
      const pages: Json[] = []
      // Upstream's >20 auto-page path drops its success envelope. Validate
      // each normal page before merging, retaining the upstream start page.
      for (let page = Number(args.page); cards.length < requestedSize; page++) {
        const raw = await run(['todo','task','list','--status','false','--page',String(page),'--size',String(pageSize)],context)
        const pageCards = findArray(raw,['todoCards'])
        if (!pageCards) throw fail('connector_invalid_response')
        pages.push(raw)
        cards.push(...pageCards.slice(0, requestedSize - cards.length))
        if (pageCards.length < pageSize) break
      }
      return {todoCards:cards,page:args.page,pageSize:args.pageSize,raw:pages.length === 1 ? pages[0] : {pages}}
    }}),
    define({name:'dingtalk_get_task',description:'按准确ID读取钉钉待办详情。',schema:todo,operation:'detail',execute:async(_args,context,target)=>readTodo(target,context)}),
    define({name:'dingtalk_complete_task',description:'用户确认后完成一个准确钉钉待办，回读验证结果。',schema:todo,operation:'complete',write:true,execute:async(_args,context,target)=>run(['todo','task','done','--task-id',target,'--status','true'],context)}),
    define({name:'dingtalk_list_approvals',description:'读取当前钉钉账号待我审批列表；按页返回，不能代替审批。',schema:list,operation:'list',execute:async(args,context)=>{
      const raw=await run(['oa','approval','list-pending','--page',String(args.page),'--limit',String(args.pageSize)],context)
      const values=findArray(raw,['values']);if(!values)throw fail('connector_invalid_response')
      return {values,page:args.page,pageSize:args.pageSize,raw}
    }}),
    define({name:'dingtalk_get_approval',description:'读取钉钉审批实例及每个节点状态。',schema:instance,operation:'detail',execute:async(_args,context,target)=>readApproval(target,context)}),
    define({name:'dingtalk_get_approval_tasks',description:'读取当前账号在指定审批实例中可操作的精确taskId。',schema:instance,operation:'detail',execute:async(_args,context,target)=>({instanceId:target,taskIds:await readTasks(target,context)})}),
    ...(['approve','reject'] as const).map(operation=>define({name:`dingtalk_${operation}`,description:`用户逐项确认后${operation==='approve'?'同意':'拒绝'}准确审批节点，校验归属并回读节点结果。`,schema:action,operation,write:true,
      execute:async(args,context,target)=>run(['oa','approval',operation,'--instance-id',String(args.instanceId),'--task-id',target,...(args.remark?['--remark',String(args.remark)]:[])],context)})),
    define({
      name: 'dingtalk_transfer', description: '经确认后将一个可操作审批节点转交给准确用户，回读原节点和新负责人。',
      schema: transfer, operation: 'transfer', write: true,
      execute: (args, context, target) => run(['oa', 'approval', 'redirect-task', '--task-id', target,
        '--to-actioner-id', String(args.toUserId), ...(args.remark ? ['--remark', String(args.remark)] : [])], context)
    })
  ]}
}
function fail(code:string){return Object.assign(new Error(code),{code})}
function code(error:unknown):string{const value=(error as {code?:unknown})?.code;return typeof value==='string'&&/^[a-z_]+$/.test(value)?value:'connector_request_failed'}
function parse(value:string):unknown{try{return JSON.parse(value.trim())}catch{return {success:false}}}
function object(value:unknown):Json{return value&&typeof value==='object'&&!Array.isArray(value)?value as Json:{}}
function business(response:DwsCommandResult):Json{
  const root=object(response.output)
  if(!response.ok||root.ok===false||root.success===false||root.error||root.dry_run===true||root.outcome&&root.outcome!=='success')throw fail(remoteErrorCode(root,response.errorCode))
  if(root.ok!==true&&root.success!==true)throw fail('connector_invalid_response')
  const data=root.outcome==='success'?object(root.data):root
  if(data.success===false||data.error||data.errorCode!==undefined&&data.errorCode!==0&&data.errorCode!=='0')throw fail('connector_remote_failed')
  if(data.result&&typeof data.result==='object'&&!Array.isArray(data.result))return object(data.result)
  // Preserve a legitimate array result under result for bounded parsers.
  return data
}
function remoteErrorCode(root:Json, transportCode?:string):string {
  const error = object(root.error)
  const status = error.http_status
  if (error.type === 'auth' || status === 401) return 'connector_authorization_required'
  if (error.type === 'permission' || status === 403) return 'connector_access_denied'
  if (status === 429) return 'connector_rate_limited'
  if (status === 408 || status === 504) return 'connector_request_timeout'
  if (error.subtype === 'network') return 'connector_network_failed'
  return transportCode ?? 'connector_remote_failed'
}
function findArray(value:Json,keys:string[],depth=0):unknown[]|undefined{if(depth>4)return undefined;for(const key of keys)if(Array.isArray(value[key]))return value[key] as unknown[];for(const key of ['result','data']){if(Array.isArray(value[key]))return value[key] as unknown[];const found=findArray(object(value[key]),keys,depth+1);if(found)return found}return undefined}
function findObject(value:Json,keys:string[],depth=0):Json|undefined{if(depth>4)return undefined;for(const key of keys){const found=object(value[key]);if(Object.keys(found).length)return found}for(const key of ['result','data']){const found=findObject(object(value[key]),keys,depth+1);if(found)return found}return undefined}
function stableId(value:Json):string{return String(value.taskId??value.todoId??value.id??'')}
function verifiedApproval(data: Json, target: string, operation: string, toUserId?: unknown): string | undefined {
  const tasks = data.tasks as Json[]
  const task = tasks.find(item => item.taskId === target)
  if (operation === 'transfer') {
    const redirected = task && String(task.result).toUpperCase() === 'REDIRECTED'
    const recipient = tasks.some(item => item.taskId !== target && item.userId === toUserId && ['NEW', 'RUNNING'].includes(String(item.status)))
    return redirected && recipient ? 'REDIRECTED' : undefined
  }
  return task && task.status === 'COMPLETED' && task.result === (operation === 'approve' ? 'AGREE' : 'REFUSE') ? 'done' : undefined
}
export const _dwsToolProviderInternals={defaultRunner,business}
