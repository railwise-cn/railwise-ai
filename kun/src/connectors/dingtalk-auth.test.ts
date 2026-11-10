import {describe,it,expect,vi} from 'vitest'
import {DingTalkCapabilityConfig} from '../contracts/dingtalk.js'
import {DingTalkAuthService,type ConnectorSecretStore} from './dingtalk-auth.js'
class Secrets implements ConnectorSecretStore {values=new Map<string,Buffer>();async set(k:string,v:Buffer){this.values.set(k,v)}async get(k:string){return this.values.get(k)??null}}
const config=DingTalkCapabilityConfig.parse({enabled:true,clientId:'client',clientSecretRef:'secret-ref',redirectUri:'http://127.0.0.1:45678/callback',userId:'staff',unionId:'u',scopes:['Workflow.Instance.Read'],userScopes:['Contact.User.Read','Todo.Todo.Read']})
const reply=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}})
async function fixture(){const secrets=new Secrets();await secrets.set('secret-ref',Buffer.from('private-secret'));const fetcher=vi.fn().mockResolvedValueOnce(reply({accessToken:'private-token',expireIn:7200,refreshToken:'refresh'})).mockResolvedValueOnce(reply({unionId:'u'}));const service=new DingTalkAuthService({config,secrets,fetch:fetcher,now:()=>0});return {secrets,fetcher,service}}
describe('DingTalk authorization boundary',()=>{
  it('uses official OAuth URL with unique state and never returns application secret',async()=>{
    const f=await fixture(),begin=await f.service.begin(),url=new URL(begin.authorizationUrl)
    expect(url.origin+url.pathname).toBe('https://login.dingtalk.com/oauth2/auth')
    expect(url.searchParams.get('state')).toHaveLength(43)
    expect(url.searchParams.get('scope')).toBe('openid corpid Contact.User.Read Todo.Todo.Read')
    expect(JSON.stringify(begin)).not.toContain('private-secret')
  })
  it('rejects wrong state and callback target without token exchange',async()=>{
    const f=await fixture()
    await expect(f.service.complete('http://evil.example/callback?authCode=c&state=x')).rejects.toMatchObject({code:'connector_redirect_invalid'})
    await expect(f.service.complete(`http://127.0.0.1:45678/callback?authCode=c&state=${'x'.repeat(43)}`)).rejects.toMatchObject({code:'connector_oauth_state_invalid'})
    expect(f.fetcher).not.toHaveBeenCalled()
  })
  it('stores tokens behind secret references and replays completed callback without code reuse',async()=>{
    const f=await fixture(),begin=await f.service.begin(),state=new URL(begin.authorizationUrl).searchParams.get('state')!
    const callback=`http://127.0.0.1:45678/callback?authCode=code&state=${state}`
    const completed=await f.service.complete(callback)
    expect(completed).toMatchObject({credentialRef:expect.stringMatching(/^dingtalk_user_/),unionId:'u'})
    expect(JSON.stringify(completed)).not.toContain('private-token')
    expect(await f.service.credential(completed.credentialRef)).toMatchObject({kind:'user',scopes:['Contact.User.Read','Todo.Todo.Read']})
    expect(await f.service.complete(callback)).toEqual(completed)
    expect(f.fetcher).toHaveBeenCalledTimes(2)
  })
  it('persists exchange state and does not replay a code after unknown transport outcome',async()=>{
    const f=await fixture();f.fetcher.mockReset().mockRejectedValue(new Error('network'))
    const begin=await f.service.begin(),state=new URL(begin.authorizationUrl).searchParams.get('state')!
    const callback=`http://127.0.0.1:45678/callback?authCode=code&state=${state}`
    await expect(f.service.complete(callback)).rejects.toMatchObject({code:'connector_oauth_outcome_unknown'})
    await expect(f.service.complete(callback)).rejects.toMatchObject({code:'connector_oauth_outcome_unknown'})
    expect(f.fetcher).toHaveBeenCalledTimes(1)
  })
  it('requires explicitly confirmed internal app identity before provisioning workflow credentials',async()=>{
    const f=await fixture()
    await expect(f.service.connectInternalApp({confirmed:false,userId:'staff',unionId:'u',scopes:[]})).rejects.toMatchObject({code:'connector_admin_confirmation_required'})
    expect(f.fetcher).not.toHaveBeenCalled()
    const result=await f.service.connectInternalApp({confirmed:true,userId:'staff',unionId:'u',scopes:['Workflow.Instance.Read']})
    expect(await f.service.credential(result.credentialRef)).toMatchObject({kind:'internal-app',userId:'staff',scopes:['Workflow.Instance.Read']})
  })
})
