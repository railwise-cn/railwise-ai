import { createHash, randomBytes } from 'node:crypto'
import type { DingTalkCapabilityConfig, DingTalkCredential } from '../contracts/dingtalk.js'

export interface ConnectorSecretStore { set(key:string,value:Buffer):Promise<void>;get(key:string):Promise<Buffer|null> }
type PrivateCredential=DingTalkCredential&{refreshToken?:string}
type PendingAuth={state:string;expiresAt:string;status:'pending'|'exchanging'|'finished';credentialRef?:string;clientId:string;redirectUri:string}
const API='https://api.dingtalk.com'
const key=(prefix:string,value:string)=>`${prefix}_${createHash('sha256').update(value).digest('hex')}`
const authError=(code:string)=>Object.assign(new Error(code),{code})

/** The production secret store must encrypt values (e.g. existing AES-GCM Flow store).
 * Tokens, application secrets and authorization codes never enter config or model history.
 */
export class DingTalkAuthService {
  constructor(private readonly deps:{config:DingTalkCapabilityConfig;secrets:ConnectorSecretStore;fetch?:typeof fetch;now?:()=>number}){}
  private now(){return (this.deps.now??Date.now)()}
  async credential(reference:string):Promise<DingTalkCredential|null>{
    const raw=await this.deps.secrets.get(reference)
    if(!raw)return null
    try {const value=JSON.parse(raw.toString('utf8')) as PrivateCredential
      return value.accessToken&&value.unionId&&Number.isFinite(Date.parse(value.expiresAt))?value:null
    }catch{return null}
  }
  async begin():Promise<{authorizationUrl:string;expiresAt:string}>{
    const config=this.deps.config
    if(!config.enabled||!config.clientId||!config.clientSecretRef||!config.redirectUri)throw authError('connector_configuration_required')
    const redirect=new URL(config.redirectUri)
    if(redirect.username||redirect.password||redirect.hash||!(redirect.protocol==='https:'||(redirect.protocol==='http:'&&['127.0.0.1','[::1]'].includes(redirect.hostname))))throw authError('connector_redirect_invalid')
    if(!await this.deps.secrets.get(config.clientSecretRef))throw authError('connector_client_secret_missing')
    const state=randomBytes(32).toString('base64url'),expiresAt=new Date(this.now()+10*60_000).toISOString()
    const pending:PendingAuth={state,expiresAt,status:'pending',clientId:config.clientId,redirectUri:config.redirectUri}
    await this.deps.secrets.set(key('dingtalk_oauth_state',state),Buffer.from(JSON.stringify(pending)))
    const url=new URL('https://login.dingtalk.com/oauth2/auth')
    url.search=new URLSearchParams({client_id:config.clientId,redirect_uri:config.redirectUri,state,response_type:'code',prompt:'consent',scope:['openid','corpid',...config.userScopes].join(' ')}).toString()
    return {authorizationUrl:url.href,expiresAt}
  }
  async complete(callbackUrl:string,signal?:AbortSignal):Promise<{credentialRef:string;unionId:string;expiresAt:string}>{
    const config=this.deps.config
    if(!config.redirectUri||!config.clientId||!config.clientSecretRef)throw authError('connector_configuration_required')
    const callback=new URL(callbackUrl),redirect=new URL(config.redirectUri)
    if(callback.origin!==redirect.origin||callback.pathname!==redirect.pathname)throw authError('connector_redirect_invalid')
    const state=callback.searchParams.get('state')??'',code=callback.searchParams.get('authCode')??''
    if(!/^[\w-]{43}$/.test(state)||!code||code.length>2048)throw authError('connector_oauth_callback_invalid')
    const pendingRaw=await this.deps.secrets.get(key('dingtalk_oauth_state',state))
    if(!pendingRaw)throw authError('connector_oauth_state_invalid')
    const pending=JSON.parse(pendingRaw.toString('utf8')) as PendingAuth
    if(pending.clientId!==config.clientId||pending.redirectUri!==config.redirectUri||Date.parse(pending.expiresAt)<=this.now())throw authError('connector_oauth_state_expired')
    if(pending.status==='finished'&&pending.credentialRef){const existing=await this.credential(pending.credentialRef);if(existing)return {credentialRef:pending.credentialRef,unionId:existing.unionId,expiresAt:existing.expiresAt}}
    if(pending.status!=='pending')throw authError('connector_oauth_outcome_unknown')
    const secret=await this.deps.secrets.get(config.clientSecretRef)
    if(!secret)throw authError('connector_client_secret_missing')
    // Persist before exchange. After an ambiguous network result the code is not replayed.
    await this.deps.secrets.set(key('dingtalk_oauth_state',state),Buffer.from(JSON.stringify({...pending,status:'exchanging'})))
    const body=await this.request('/v1.0/oauth2/userAccessToken',{clientId:config.clientId,clientSecret:secret.toString('utf8'),code,grantType:'authorization_code'},signal)
    if(typeof body.accessToken!=='string'||typeof body.expireIn!=='number'||body.expireIn<=0)throw authError('connector_oauth_response_invalid')
    const identity=await this.identity(body.accessToken,signal)
    const expiresAt=new Date(this.now()+body.expireIn*1000).toISOString()
    const reference=`dingtalk_user_${randomBytes(18).toString('hex')}`
    // User login proves identity only. Do not fabricate application/API permissions.
    const credential:PrivateCredential={kind:'user',accessToken:body.accessToken,refreshToken:typeof body.refreshToken==='string'?body.refreshToken:undefined,unionId:identity,expiresAt,scopes:[...config.userScopes]}
    await this.deps.secrets.set(reference,Buffer.from(JSON.stringify(credential)))
    await this.deps.secrets.set(key('dingtalk_oauth_state',state),Buffer.from(JSON.stringify({...pending,status:'finished',credentialRef:reference})))
    return {credentialRef:reference,unionId:identity,expiresAt}
  }
  /** Administrator-provisioned internal app authorization is separate from user OAuth.
   * Fixed user and declared scopes must be confirmed by setup UI before invoking this method.
   */
  async connectInternalApp(input:{confirmed:boolean;unionId:string;userId:string;scopes:string[]},signal?:AbortSignal):Promise<{credentialRef:string;expiresAt:string}>{
    const config=this.deps.config
    if(!input.confirmed||!config.clientId||!config.clientSecretRef||config.userId!==input.userId||config.unionId!==input.unionId)throw authError('connector_admin_confirmation_required')
    if(input.scopes.some(scope=>!config.scopes.includes(scope)))throw authError('connector_scope_missing')
    const secret=await this.deps.secrets.get(config.clientSecretRef)
    if(!secret)throw authError('connector_client_secret_missing')
    const body=await this.request('/v1.0/oauth2/accessToken',{appKey:config.clientId,appSecret:secret.toString('utf8')},signal)
    if(typeof body.accessToken!=='string'||typeof body.expireIn!=='number'||body.expireIn<=0)throw authError('connector_oauth_response_invalid')
    const expiresAt=new Date(this.now()+body.expireIn*1000).toISOString(),reference=`dingtalk_app_${randomBytes(18).toString('hex')}`
    const credential:DingTalkCredential={kind:'internal-app',accessToken:body.accessToken,unionId:input.unionId,userId:input.userId,scopes:[...input.scopes],expiresAt}
    await this.deps.secrets.set(reference,Buffer.from(JSON.stringify(credential)))
    return {credentialRef:reference,expiresAt}
  }
  private async request(path:string,body:Record<string,unknown>,signal?:AbortSignal):Promise<Record<string,unknown>>{
    let response:Response
    try{response=await (this.deps.fetch??fetch)(`${API}${path}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000)})}catch{throw authError('connector_oauth_outcome_unknown')}
    if(!response.ok)throw authError(response.status===401?'connector_authorization_required':'connector_oauth_failed')
    let result:Record<string,unknown>
    try{const text=await response.text();if(Buffer.byteLength(text)>1024*1024)throw new Error();result=JSON.parse(text)}catch{throw authError('connector_oauth_response_invalid')}
    if(!result||typeof result!=='object'||Array.isArray(result)||result.code)throw authError('connector_oauth_failed')
    return result
  }
  private async identity(token:string,signal?:AbortSignal):Promise<string>{
    const response=await (this.deps.fetch??fetch)(`${API}/v1.0/contact/users/me`,{method:'GET',redirect:'error',headers:{'x-acs-dingtalk-access-token':token},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30_000)]):AbortSignal.timeout(30_000)})
    if(!response.ok)throw authError('connector_identity_unverified')
    const result=await response.json() as Record<string,unknown>
    if(typeof result.unionId!=='string'||!result.unionId)throw authError('connector_identity_unverified')
    return result.unionId
  }
}
