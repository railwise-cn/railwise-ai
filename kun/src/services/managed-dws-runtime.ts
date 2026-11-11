import { readOptionalKunConfigFile } from '../config/kun-config.js'
import { DwsCapabilityConfig, type DwsCapabilityConfig as DwsConfig } from '../contracts/dws.js'
import type { CapabilityPreflight } from '../contracts/harness.js'
import type { CapabilityToolProvider } from '../adapters/tool/capability-registry.js'
import { buildDwsToolProvider } from '../adapters/tool/dws-tool-provider.js'
import { assertDwsCredentialAccess } from './dws-cli-environment.js'
import { externalTaskIntent } from './external-task-capability.js'

/** Official managed CLI state; legacy app-token integration remains separate. */
export class ManagedDwsRuntime {
  private config:DwsConfig
  constructor(initial:DwsConfig|undefined,private readonly configPath?:string,private readonly apply?:(provider?:CapabilityToolProvider)=>void){
    this.config=DwsCapabilityConfig.parse(initial??{})
  }
  state():DwsConfig{return structuredClone(this.config)}
  toolProvider():CapabilityToolProvider|undefined{return buildDwsToolProvider(this.config)}
  preflight(text:string):CapabilityPreflight|null {
    const intent=externalTaskIntent(text)
    if(intent?.provider!=='dingtalk')return null
    const connect={kind:'connect' as const,route:'marketplace',label:'连接钉钉'}
    const base={provider:'dingtalk' as const,credentialState:'unknown' as const,networkState:'unknown' as const,workspaceState:'unknown' as const,
      sandboxState:'allowed' as const,approvalState:intent.mutation?'required' as const:'not_required' as const,checkedAt:new Date().toISOString()}
    const block=(status:CapabilityPreflight['status'],errorCode:string,message:string,resolution:NonNullable<CapabilityPreflight['resolution']>=connect,credentialState:CapabilityPreflight['credentialState']='missing'):CapabilityPreflight=>({...base,status,errorCode,message,resolution,action:resolution,credentialState})
    if(!this.config.enabled)return block('blocked','connector_disabled','钉钉连接器已关闭，请先启用。')
    if(this.config.authState==='not_installed'||!this.config.executablePath)return block('not_installed','connector_not_installed','尚未安装官方钉钉连接器。安装并扫码登录后可继续原任务。',{kind:'install',route:'marketplace',label:'安装钉钉连接器'})
    try{assertDwsCredentialAccess()}catch{return block('blocked','candidate_credentials_disabled','本候选环境未开启凭据访问，未读取钉钉账号或执行平台操作。')}
    if(this.config.authState!=='installed')return block('needs_authorization','connector_authorization_required','请扫码登录官方钉钉连接器，完成后继续原任务。',connect,this.config.authState==='error'?'invalid':'missing')
    if(!this.toolProvider())return block('needs_authorization','connector_identity_unverified','钉钉账号、组织或连接器文件尚未核验，请重新检查连接。',connect,'unknown')
    if(intent.operation==='send'||intent.operation==='upload')return block('unsupported','connector_operation_unsupported','当前钉钉连接器支持待办与审批读取、完成、同意、拒绝和转交。',connect,'valid')
    if(intent.kind==='connect_provider')return block('blocked','connector_already_authorized','钉钉账号已连接，可返回原任务继续。',{kind:'retry',route:'marketplace',label:'管理钉钉连接'},'valid')
    return {...base,status:'available',credentialState:'valid',toolId:'dingtalk',executablePath:this.config.executablePath,
      message:'钉钉组织和账号已登录；具体平台权限在工具执行时由官方连接器核验。写操作仍须确认并回读结果。'}
  }
  scope(externalTargets:readonly string[]=[]){return {networkAllowlist:['https://api.dingtalk.com','https://mcp.dingtalk.com'],connectorScopes:[],externalTargets:[...externalTargets],
    connectorBackends: { dingtalk: 'dws' as const },
    ...(this.config.identityFingerprint?{connectorIdentityFingerprints:{dingtalk:this.config.identityFingerprint}}:{})}}
  async refresh(){
    if(!this.configPath)throw Object.assign(new Error('Managed DingTalk configuration is unavailable.'),{code:'connector_configuration_unavailable'})
    this.config=readOptionalKunConfigFile(this.configPath)?.config.capabilities.dws??this.config
    const provider=this.toolProvider();this.apply?.(provider)
    return {provider:'dingtalk',backend:'dws',status:provider?'available':this.config.authState==='not_installed'?'not_installed':'needs_authorization',authState:this.config.authState}
  }
}
