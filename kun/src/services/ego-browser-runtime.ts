import type { ToolHostContext } from '../ports/tool-host.js'
import type { ThreadRecord } from '../contracts/threads.js'
import type { CapabilityPreflight } from '../contracts/harness.js'
import type { BrowserExecutionScope } from '../contracts/browser-skill.js'
import { browserTaskOrigins } from '../contracts/browser-skill.js'
import type { ExecutionScope } from '../contracts/permissions.js'
import { EgoBrowserCapabilityConfig, EGO_TOOLS, isEgoBrowserTask } from '../contracts/ego-browser.js'
import { buildEgoBrowserToolProvider } from '../adapters/tool/ego-browser-tool-provider.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'
/** One connector inside the existing KUN process, with task-scoped selection. */
export class EgoBrowserRuntime {
  private readonly config: EgoBrowserCapabilityConfig
  constructor(private readonly options: {config?: EgoBrowserCapabilityConfig;repository:TaskRunRepository;canFinishReadiness?:(context:ToolHostContext,hostOperationId:string)=>Promise<{ready:boolean;reason?:string}>}) { this.config=EgoBrowserCapabilityConfig.parse(options.config??{state:'not_installed',revision:0}) }
  state():EgoBrowserCapabilityConfig {return structuredClone(this.config)}
  selected(text:string,scope?:BrowserExecutionScope):boolean { return scope?.provider==='ego-browser'||!scope&&isEgoBrowserTask(text) }
  provider() {return buildEgoBrowserToolProvider({config:this.config,repository:this.options.repository,canFinishReadiness:this.options.canFinishReadiness})}
  fingerprint() {return operationFingerprint(this.config)}
  scope(text:string,inherited?:BrowserExecutionScope,networkOrigins?:readonly string[]):ExecutionScope {
    const origins=inherited?.origins??[...new Set([...browserTaskOrigins(text),...(networkOrigins??[]).filter(v=>v!=='*')])]
    return {allowedToolNames:[...EGO_TOOLS,'publish_artifact','read_artifact','verify_web_artifact','read_task_context','request_user_input','user_input','schedule_task','list_schedules','todo'],networkAllowlist:origins,connectorScopes:[],externalTargets:[],...(origins.length&&this.config.executableHash?{browserScope:inherited??{provider:'ego-browser' as const,browserInstanceId:'ego-browser:'+this.config.executableHash,origins,interaction:'observe' as const,revision:this.config.revision},connectorIdentityFingerprints:{'ego-browser':this.fingerprint()}}:{})}
  }
  async preflight(text:string,thread?:ThreadRecord,scope?:BrowserExecutionScope):Promise<CapabilityPreflight|null> {
    if(!this.selected(text,scope))return null
    const base={provider:'ego-browser' as const,checkedAt:new Date().toISOString(),credentialState:'unknown' as const,networkState:'unknown' as const,workspaceState:'allowed' as const,sandboxState:'allowed' as const,approvalState:'required' as const,workspaceRoot:thread?.workspace}
    const action={kind:'connect' as const,route:'marketplace',label:'检查Ego浏览器连接'}
    if(thread?.mode==='plan')return {...base,status:'blocked',errorCode:'task_mode_blocked',message:'当前任务为计划模式。',action}
    if(this.config.state!=='installed')return {...base,status:this.config.state==='not_installed'?'not_installed':'unsupported',errorCode:'ego_browser_'+this.config.state,message:'Ego外置CLI未通过版本与文件身份核验；未启动浏览器或读取登录。',action}
    const allowed=thread?.agentProfile?.toolAllowlist
    if(allowed?.length&&!allowed.includes('*')&&EGO_TOOLS.some(t=>!allowed.includes(t)))return {...base,status:'blocked',errorCode:'agent_tool_blocked',message:'当前Agent缺少Ego只读工具范围。',action}
    if(!this.scope(text,scope).browserScope)return {...base,status:'needs_authorization',errorCode:'browser_origin_scope_required',message:'请在任务中明确允许读取的Ego目标站点URL。',action}
    if(scope&&(scope.browserInstanceId!=='ego-browser:'+this.config.executableHash||scope.revision!==this.config.revision))return {...base,status:'needs_authorization',errorCode:'browser_binding_changed',message:'Ego工具文件或任务范围已变化，请重新审阅当前任务。',action}
    return {...base,status:'available',toolId:'ego-browser',executablePath:this.config.executablePath,message:'Ego CLI文件与版本已核验；首次只读打开会核对当前TaskSpace与用户控制状态，网站登录状态尚未核验。'}
  }
}
