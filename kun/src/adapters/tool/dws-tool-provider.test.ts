import { afterEach,describe,expect,it,vi } from 'vitest'
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionGrantSchema } from '../../contracts/permissions.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { LocalToolHost } from './local-tool-host.js'
import { buildDwsToolProvider,_dwsToolProviderInternals } from './dws-tool-provider.js'
import { dwsTestConfig,dwsTestIdentity,withDwsTestIdentity } from '../../../tests/helpers/dws-identity.js'

const context=():ToolHostContext=>({threadId:'thread',turnId:'turn',workspace:'',approvalPolicy:'auto',sandboxMode:'read-only',abortSignal:new AbortController().signal,
  awaitApproval:vi.fn(async()=> 'allow' as const),assertExternalTarget:vi.fn(),executionGrant:ExecutionGrantSchema.parse({id:'grant',threadId:'thread',turnId:'turn',workspaceRoot:'',workspaceTrust:'read-only',agentTrust:'full-access',sandboxMode:'read-only',approvalPolicy:'auto',
    networkAllowlist:['https://mcp.dingtalk.com'],connectorIdentityFingerprints:{dingtalk:dwsTestConfig.identityFingerprint},workspaceRevision:0,agentRevision:0,revision:0,idempotencyKey:'grant',issuedAt:'2026-11-10T00:00:00.000Z'})})
afterEach(()=>vi.unstubAllEnvs())
describe('official typed DingTalk DWS provider',()=>{
  it('uses exact upstream atomic commands and an immutable corp:user profile, never a Shell',async()=>{
    const runner=vi.fn(async(_path:string,args:string[])=>({ok:true,output:args[0]==='auth'?dwsTestIdentity:{success:true,result:{todoCards:[],hasMore:false}}}))
    const tool=buildDwsToolProvider(dwsTestConfig,runner)!.tools.find(tool=>tool.name==='dingtalk_list_tasks')!
    expect(await tool.execute({page:2,pageSize:10},context())).toMatchObject({output:{status:'succeeded',evidence:{provider:'dingtalk',operation:'list',target:'current_user',verified:true}}})
    expect(runner.mock.calls.map(call=>call[1])).toEqual([
      ['auth','status','--readonly','--profile','corp-synthetic:user-synthetic','--format','json'],
      ['todo','task','list','--status','false','--page','2','--size','10','--profile','corp-synthetic:user-synthetic','--format','json']
    ])
  })
  it('blocks disabled Candidate credential access, old grants and account changes before a business command',async()=>{
    const runner=vi.fn(async()=>({ok:true,output:{...dwsTestIdentity,user_id:'user-other'}}))
    const tool=buildDwsToolProvider(dwsTestConfig,runner)!.tools[0]
    const old=context();old.executionGrant={...old.executionGrant!,connectorIdentityFingerprints:undefined}
    expect(await tool.execute({},old)).toMatchObject({isError:true,output:{code:'connector_identity_unverified'}})
    expect(runner).not.toHaveBeenCalled()
    expect(await tool.execute({},context())).toMatchObject({isError:true,output:{code:'connector_identity_changed'}})
    expect(runner).toHaveBeenCalledOnce();runner.mockClear()
    vi.stubEnv('WORKWISE_CANDIDATE','1');vi.stubEnv('WORKWISE_CANDIDATE_CREDENTIAL_ACCESS','0')
    expect(await tool.execute({},context())).toMatchObject({isError:true,output:{code:'candidate_credentials_disabled'}})
    expect(runner).not.toHaveBeenCalled()
  })
  it('requires explicit UI confirmation even though upstream atomic commands do not require --yes',async()=>{
    const runner=vi.fn(),provider=buildDwsToolProvider(dwsTestConfig,runner)!,host=new LocalToolHost({tools:[...provider.tools]})
    const scoped=context();scoped.awaitApproval=vi.fn(async()=> 'deny' as const)
    await host.execute({callId:'complete',toolName:'dingtalk_complete_task',arguments:{taskId:'todo-1'}},scoped)
    expect(scoped.awaitApproval).toHaveBeenCalledOnce();expect(runner).not.toHaveBeenCalled()
  })
  it('completes an exact todo once and verifies the same target through the official get response',async()=>{
    let reads=0
    const runner=vi.fn(async(_path:string,args:string[])=>({ok:true,output:{success:true,result:args[2]==='get'?{todoDetailModel:{taskId:'todo-1',isDone:++reads>1}}:true}}))
    const tool=buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name==='dingtalk_complete_task')!
    expect(await tool.execute({taskId:'todo-1'},context())).toMatchObject({output:{status:'succeeded',data:{id:'todo-1',done:true},evidence:{operation:'complete',target:'todo-1',status:'done',verified:true}}})
    expect(runner.mock.calls.map(call=>call[1].slice(0,3))).toEqual([['todo','task','get'],['todo','task','done'],['todo','task','get']])
  })
  it.each(['approve','reject'] as const)('checks current pending task and reads exact approval node after %s',async operation=>{
    const runner=vi.fn(async(_path:string,args:string[])=>({ok:true,output:{success:true,result:args[2]==='tasks'?{taskIds:['42']}:args[2]==='detail'?{processInstanceId:'instance-1',tasks:[{taskId:'42',status:'COMPLETED',result:operation==='approve'?'AGREE':'REFUSE'}]}:true}}))
    const tool=buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name===`dingtalk_${operation}`)!
    expect(await tool.execute({instanceId:'instance-1',taskId:'42',remark:'合成验收'},context())).toMatchObject({output:{status:'succeeded',evidence:{operation,target:'42',verified:true}}})
    expect(runner.mock.calls.map(call=>call[1].slice(0,3))).toEqual([['oa','approval','tasks'],['oa','approval',operation],['oa','approval','detail']])
    expect(runner.mock.calls[1][1]).toContain('合成验收');expect(runner.mock.calls[1][1]).not.toContain('--yes')
  })
  it('keeps mismatched or interrupted write readback unknown without a second mutation',async()=>{
    let reads=0
    const runner=vi.fn(async(_path:string,args:string[])=>({ok:true,output:{success:true,result:args[2]==='get'?{todoDetailModel:{taskId:++reads===1?'todo-1':'other',isDone:false}}:true}}))
    const tool=buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name==='dingtalk_complete_task')!
    expect(await tool.execute({taskId:'todo-1'},context())).toMatchObject({isError:true,output:{status:'outcome_unknown',code:'connector_target_mismatch'}})
    expect(runner.mock.calls.filter(call=>call[1][2]==='done')).toHaveLength(1)
  })
  it('refuses unsafe approval IDs, raw URLs and unreviewed actions before business dispatch',async()=>{
    const runner=vi.fn(),tool=buildDwsToolProvider(dwsTestConfig,runner)!.tools.find(tool=>tool.name==='dingtalk_approve')!
    for(const args of [{instanceId:'i',taskId:'9007199254740993'},{instanceId:'i',taskId:'42',url:'https://invalid.example'}])expect(await tool.execute(args,context())).toMatchObject({isError:true})
    const unscoped={...context(),assertExternalTarget:undefined}
    expect(await tool.execute({instanceId:'i',taskId:'42'},unscoped)).toMatchObject({isError:true,output:{code:'external_target_blocked'}})
    expect(runner).not.toHaveBeenCalled()
  })
  it('does not accept transport success, pending, preview or remote failure as evidence',()=>{
    for(const output of [{},{ok:true,outcome:'pending',data:{}},{ok:true,outcome:'success',dry_run:true,data:{}},{success:false},{success:true,errorCode:403},[]])expect(()=>_dwsToolProviderInternals.business({ok:true,output})).toThrow()
  })
  it('validates normal upstream pages for sizes above 20 while preserving the starting page', async () => {
    const runner = vi.fn(async (_path: string, _args: string[]) => ({ ok: true, output: { success: true, result: { todoCards: Array.from({length:20}, (_, i) => ({taskId:String(i)})) } } }))
    const tool = buildDwsToolProvider(dwsTestConfig, withDwsTestIdentity(runner))!.tools[0]
    const result = await tool.execute({page:3,pageSize:25}, context())
    expect(result).toMatchObject({output:{status:'succeeded',data:{page:3,pageSize:25}}})
    expect((result.output as {data:{todoCards:unknown[]}}).data.todoCards).toHaveLength(25)
    expect(runner.mock.calls.map(call => call[1].slice(0, 9))).toEqual([
      ['todo','task','list','--status','false','--page','3','--size','20'],
      ['todo','task','list','--status','false','--page','4','--size','20']
    ])
  })
  it('keeps an empty page successful and propagates a later page failure', async () => {
    const empty = vi.fn(async () => ({ok:true,output:{success:true,result:{todoCards:[]}}}))
    expect(await buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(empty))!.tools[0].execute({pageSize:100},context())).toMatchObject({output:{status:'succeeded',data:{todoCards:[]}}})
    expect(empty).toHaveBeenCalledOnce()
    const runner = vi.fn(async () => ({ok:true,output:{success:true,result:{todoCards:Array.from({length:20},()=>({taskId:'synthetic'}))}}}))
      .mockResolvedValueOnce({ok:true,output:{success:true,result:{todoCards:Array.from({length:20},()=>({taskId:'synthetic'}))}}})
      .mockResolvedValueOnce({ok:false,output:{success:false,result:{todoCards:[]}}})
    expect(await buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools[0].execute({pageSize:25},context())).toMatchObject({isError:true,output:{code:'connector_remote_failed'}})
  })
  it.each([
    [{type:'auth',http_status:401},'connector_authorization_required'],
    [{type:'permission',http_status:403},'connector_access_denied'],
    [{type:'api',http_status:429},'connector_rate_limited'],
    [{type:'api',http_status:504},'connector_request_timeout'],
    [{type:'api',subtype:'network'},'connector_network_failed']
  ])('retains actionable official error categories', (error, expected) => {
    expect(() => _dwsToolProviderInternals.business({ok:false,output:{ok:false,outcome:'failure',error}})).toThrow(expected)
  })
  it('checks the actual executable hash before launch without reading credentials',async()=>{
    const root=mkdtempSync(join(tmpdir(),'dws-hash-')),path=join(root,'dws')
    writeFileSync(path,'synthetic binary')
    try{await expect(_dwsToolProviderInternals.defaultRunner(path,['never-run'],new AbortController().signal,'0'.repeat(64))).rejects.toMatchObject({code:'connector_executable_changed'})}finally{rmSync(root,{recursive:true,force:true})}
  })
})
