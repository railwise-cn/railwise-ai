import {describe,it,expect,vi} from 'vitest'
import {DingTalkCapabilityConfig,type DingTalkCredential} from '../../contracts/dingtalk.js'
import type {ToolHostContext} from '../../ports/tool-host.js'
import {buildDingTalkToolProvider,DINGTALK_SCOPES} from './dingtalk-tool-provider.js'
const scopes=Object.values(DINGTALK_SCOPES)
const config=DingTalkCapabilityConfig.parse({enabled:true,credentialRef:'user-ref',workflowCredentialRef:'app-ref',scopes,userScopes:['Todo.Todo.Read','Todo.Todo.Write'],unionId:'u',userId:'staff',allowedWriteUserIds:['staff']})
const credential:DingTalkCredential={accessToken:'private-token',unionId:'u',userId:'staff',kind:'internal-app',scopes,expiresAt:'2027-01-01T00:00:00Z'}
const context={threadId:'thread',turnId:'turn',workspace:'/synthetic',approvalPolicy:'auto',sandboxMode:'workspace-write',abortSignal:new AbortController().signal,awaitApproval:async()=> 'allow'} as ToolHostContext
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','x-acs-request-id':'req-1'}})
const fixture=(replies:Response[])=>{const fetcher=vi.fn(async(_input:unknown,_init?:RequestInit)=>replies.shift()!);const provider=buildDingTalkToolProvider({config,getCredential:async()=>credential,fetch:fetcher as unknown as typeof fetch,nowIso:()=> '2026-11-10T00:00:00Z'});return {provider,fetcher,run:(name:string,args:Record<string,unknown>)=>provider.tools.find(t=>t.name===name)!.execute(args,context)}}

describe('official DingTalk provider',()=>{
  it('advertises independent typed tools and explicit approval for every write',()=>{
    const {provider}=fixture([])
    expect(provider.id).toBe('dingtalk')
    expect(provider.tools.map(t=>t.name)).toEqual(['dingtalk_list_tasks','dingtalk_get_task','dingtalk_complete_task','dingtalk_list_approvals','dingtalk_get_approval','dingtalk_approve','dingtalk_reject','dingtalk_transfer'])
    for(const name of ['dingtalk_complete_task','dingtalk_approve','dingtalk_reject','dingtalk_transfer'])expect(provider.tools.find(t=>t.name===name)).toMatchObject({requireExplicitApproval:true,policy:'on-request',toolKind:'tool_call'})
  })
  it('uses verified user todo route, fixed official host and does not disclose token',async()=>{
    const f=fixture([response({todoCards:[{id:'a'}]})])
    const result=await f.run('dingtalk_list_tasks',{})
    expect(String(f.fetcher.mock.calls[0]![0])).toBe('https://api.dingtalk.com/v1.0/todo/users/u/tasks/list')
    expect(result).toMatchObject({output:{ok:true,status:'succeeded',evidence:{verified:true,operation:'list'}}})
    expect(JSON.stringify(result)).not.toContain('private-token')
  })
  it('refuses extra arguments rather than accepting model-supplied URL or user identity',async()=>{
    const f=fixture([])
    expect(await f.run('dingtalk_get_task',{taskId:'a',url:'https://evil.example',operatorId:'other'})).toMatchObject({isError:true,output:{code:'connector_invalid_arguments'}})
    expect(f.fetcher).not.toHaveBeenCalled()
  })
  it('encodes target path segments so a task ID cannot change routing',async()=>{
    const f=fixture([response({id:'../other?x=y',done:false})])
    await f.run('dingtalk_get_task',{taskId:'../other?x=y'})
    expect(String(f.fetcher.mock.calls[0]![0])).toContain('/tasks/..%2Fother%3Fx%3Dy')
  })
  it('completes a todo only after ownership check and exact target readback',async()=>{
    const f=fixture([response({id:'a',done:false,executorIds:['u']}),response({result:true}),response({id:'a',done:true})])
    const result=await f.run('dingtalk_complete_task',{taskId:'a'})
    expect(result).toMatchObject({output:{ok:true,status:'succeeded',evidence:{target:'a',operation:'complete',status:'done',verified:true}}})
    expect(result).not.toHaveProperty('output.evidence.remoteOperationId')
    const call=f.fetcher.mock.calls[1]!
    expect(String(call[0])).toBe('https://api.dingtalk.com/v1.0/todo/users/u/tasks/a/executorStatus?operatorId=staff')
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({executorStatusList:[{id:'staff',isDone:true}]})
  })
  it('does not invent a remote operation id when DingTalk omits its request id',async()=>{
    const replies=[new Response(JSON.stringify({id:'a',done:false,executorIds:['u']})),new Response(JSON.stringify({result:true})),new Response(JSON.stringify({id:'a',done:true}))]
    const provider=buildDingTalkToolProvider({config,getCredential:async()=>credential,fetch:vi.fn(async()=>replies.shift()!) as unknown as typeof fetch,nowIso:()=> '2026-11-10T00:00:00Z'})
    const result=await provider.tools.find(t=>t.name==='dingtalk_complete_task')!.execute({taskId:'a'},context)
    expect(result).toMatchObject({output:{ok:true,evidence:{verified:true}}})
    expect(JSON.stringify(result)).not.toContain('task:a:done')
    expect((result.output as {remoteOperationId?:string}).remoteOperationId).toBeUndefined()
  })
  it('keeps an accepted write unknown when readback does not prove completion',async()=>{
    const f=fixture([response({id:'a',done:false,executorIds:['u']}),response({result:true}),response({id:'a',done:false})])
    expect(await f.run('dingtalk_complete_task',{taskId:'a'})).toMatchObject({isError:true,output:{status:'outcome_unknown',code:'connector_readback_unverified'}})
    expect(f.fetcher).toHaveBeenCalledTimes(3)
  })
  it('never executes workflow writes as an unbound or wrong approver',async()=>{
    const f=fixture([response({result:{processInstanceId:'i',tasks:[{taskId:10,userId:'another',status:'RUNNING'}]}})])
    expect(await f.run('dingtalk_approve',{instanceId:'i',taskId:'10'})).toMatchObject({isError:true,output:{status:'failed',code:'connector_target_not_actionable'}})
    expect(f.fetcher).toHaveBeenCalledTimes(1)
  })
  it('verifies a node result rather than accepting an instance HTTP success',async()=>{
    const f=fixture([response({result:{processInstanceId:'i',tasks:[{taskId:10,userId:'staff',status:'RUNNING'}]}}),response({result:true,success:true}),response({result:{processInstanceId:'i',status:'RUNNING',tasks:[{taskId:10,userId:'staff',status:'COMPLETED',result:'AGREE'}]}})])
    expect(await f.run('dingtalk_approve',{instanceId:'i',taskId:'10',remark:'test'})).toMatchObject({output:{ok:true,status:'succeeded',evidence:{operation:'approve',target:'10',status:'AGREE'}}})
    expect(JSON.parse((f.fetcher.mock.calls[1]![1] as RequestInit).body as string)).toEqual({actionerUserId:'staff',processInstanceId:'i',taskId:10,result:'agree',remark:'test'})
  })
  it('keeps transport failure after mutation unknown and never retries it',async()=>{
    const fetcher=vi.fn().mockResolvedValueOnce(response({result:{processInstanceId:'i',tasks:[{taskId:10,userId:'staff',status:'RUNNING'}]}})).mockRejectedValueOnce(new Error('connection reset'))
    const provider=buildDingTalkToolProvider({config,getCredential:async()=>credential,fetch:fetcher,nowIso:()=> '2026-11-10T00:00:00Z'})
    expect(await provider.tools.find(t=>t.name==='dingtalk_reject')!.execute({instanceId:'i',taskId:'10'},context)).toMatchObject({isError:true,output:{status:'outcome_unknown',code:'connector_network_failed'}})
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('rejects expired credentials and insufficient real scopes before networking',async()=>{
    const fetcher=vi.fn()
    for(const value of [{...credential,expiresAt:'invalid'},{...credential,expiresAt:'2020-01-01T00:00:00Z'},{...credential,scopes:[]}]){
      const provider=buildDingTalkToolProvider({config,getCredential:async()=>value,fetch:fetcher})
      expect(await provider.tools[0]!.execute({},context)).toMatchObject({isError:true,output:{status:'failed'}})
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not treat an HTTP 200 business error as success',async()=>{
    const f=fixture([response({code:'Forbidden',message:'scope denied'})])
    expect(await f.run('dingtalk_list_tasks',{})).toMatchObject({isError:true,output:{code:'connector_remote_failed'}})
  })
})
