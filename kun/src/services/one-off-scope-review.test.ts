import { mkdtemp,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach,expect,it } from 'vitest'
import { ManagedBrowserSkillRuntime } from './managed-browser-skill-runtime.js'
import { TaskRunRepository } from './task-run-repository.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import type { TaskRun } from '../contracts/tasks.js'
import type { BrowserCapabilityConfig } from '../contracts/browser-skill.js'
const clean:Array<()=>Promise<void>>=[]
afterEach(async()=>{while(clean.length)await clean.pop()!()})
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'oneoff-review-')),repo=new TaskRunRepository(join(dir,'test.sqlite'))
 clean.push(async()=>{repo.connection().close();await rm(dir,{recursive:true,force:true})})
 const browser={id:'new-browser',name:'Chrome',label:'Public research browser',connected:true,extensionVersion:'0.5.0',protocolVersion:'1.9',versionSkew:false}
 const config:BrowserCapabilityConfig={enabled:true,state:'ready',origins:['https://a.test','https://b.test'],interaction:'interact',revision:4,browserInstanceId:browser.id,version:'0.5.0',daemonProtocolVersion:'1.9',browsers:[browser]}
 const oldScope={browserInstanceId:'old-browser',revision:3,origins:config.origins,interaction:'interact' as const,verificationPolicy:'public_query_target' as const}
 const task={goal:'使用浏览器公开检索资料',authority:{browserScope:oldScope}} as TaskRun
 const grant=ExecutionGrantSchema.parse({id:'old',threadId:'thread',turnId:'turn',workspaceRoot:'/work',workspaceTrust:'read-only',agentTrust:'full-access',approvalPolicy:'on-request',sandboxMode:'read-only',allowedToolNames:['browser_session_start','browser_observe','browser_navigate','browser_click','publish_artifact','request_host_shell'],allowedProviderIds:['browser-skill','managed-artifacts','mcp:send'],pathAllowlist:[],networkAllowlist:config.origins,connectorScopes:[],externalTargets:[],workspaceRevision:0,agentRevision:0,revision:0,idempotencyKey:'old',issuedAt:'2026-11-15T00:00:00Z',expiresAt:'2026-11-15T00:00:01Z',browserScope:oldScope})
 const runtime=(changes:Partial<BrowserCapabilityConfig>={})=>new ManagedBrowserSkillRuntime({config:{...config,...changes},configPath:join(dir,'unused'),dataDir:dir,repository:repo,apply:()=>{}})
 return {runtime,task,grant,tools:grant.allowedToolNames!,providers:grant.allowedProviderIds!}
}
it('reviews a current instance without reviving the expired old binding and bounds metadata to safe current capabilities',async()=>{
 const f=await fixture(),review=f.runtime().oneOffScopeReview(f.task,f.grant,'a'.repeat(64),f.tools,f.providers)
 expect(review.scope).toMatchObject({browserInstanceId:'new-browser',revision:4,origins:['https://a.test','https://b.test']})
 expect(review.scope).not.toHaveProperty('publicQueryAuthorization')
 expect(review.allowedToolNames).not.toContain('request_host_shell');expect(review.allowedProviderIds).not.toContain('mcp:send')
 expect(f.runtime().oneOffScopeReview(f.task,f.grant,'b'.repeat(64),f.tools,f.providers).reviewHash).not.toBe(review.reviewHash)
})
it('distinguishes absent network restriction from empty deny and preserves a narrow current network scope',async()=>{
 const f=await fixture(),r=f.runtime()
 expect(r.oneOffScopeReview(f.task,f.grant,'a'.repeat(64),f.tools,f.providers).scope.origins).toHaveLength(2)
 expect(r.oneOffScopeReview(f.task,f.grant,'a'.repeat(64),f.tools,f.providers,['a.test']).scope.origins).toEqual(['https://a.test'])
 expect(()=>r.oneOffScopeReview(f.task,f.grant,'a'.repeat(64),f.tools,f.providers,[])).toThrow()
 expect(()=>r.oneOffScopeReview(f.task,f.grant,'a'.repeat(64),[],f.providers)).toThrow()
 expect(()=>r.oneOffScopeReview(f.task,f.grant,'a'.repeat(64),f.tools,[])).toThrow()
})
it('intersects the historical browser site ceiling before displaying or preparing a fresh scope',async()=>{
 const f=await fixture(),r=f.runtime()
 const ceiling={...f.grant,networkAllowlist:['*'],browserScope:{...f.grant.browserScope!,origins:['https://a.test']}}
 expect(r.oneOffScopeReview(f.task,ceiling,'a'.repeat(64),f.tools,f.providers).scope.origins).toEqual(['https://a.test'])
 expect(()=>r.oneOffScopeReview(f.task,{...ceiling,browserScope:{...ceiling.browserScope,origins:[]}},'a'.repeat(64),f.tools,f.providers)).toThrow('execution_grant_scope')
 expect(()=>r.oneOffScopeReview(f.task,ceiling,'a'.repeat(64),f.tools,f.providers,['b.test'])).toThrow('execution_grant_scope')
})
it('cannot widen an observe-only config, add another site or bypass a disconnected browser',async()=>{
 const f=await fixture()
 expect(()=>f.runtime({interaction:'observe'}).oneOffScopeReview(f.task,f.grant,'a'.repeat(64),f.tools,f.providers)).toThrow('browser_interaction_scope_required')
 expect(()=>f.runtime({origins:['https://other.test']}).oneOffScopeReview(f.task,f.grant,'a'.repeat(64),f.tools,f.providers)).toThrow()
 expect(()=>f.runtime({state:'needs_extension'}).oneOffScopeReview(f.task,f.grant,'a'.repeat(64),f.tools,f.providers)).toThrow()
})
