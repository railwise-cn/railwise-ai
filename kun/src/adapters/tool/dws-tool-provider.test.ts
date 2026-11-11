import { afterEach,describe,expect,it,vi } from 'vitest'
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ExecutionGrantSchema } from '../../contracts/permissions.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { LocalToolHost } from './local-tool-host.js'
import { buildDwsToolProvider,_dwsToolProviderInternals, type DwsCommandResult } from './dws-tool-provider.js'
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
    const runner=vi.fn(async(_path:string,args:string[])=>({ok:true,output:{success:true,errorCode:null,errorMsg:null,result:args[2]==='get'?{todoDetailModel:{taskId:'todo-1',isDone:++reads>1}}:true}}))
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
  it.each(['approve','reject'] as const)('accepts the official taskIdList objects and taskStatus/taskResult readback for %s',async operation=>{
    const taskId=104969000001
    const runner=vi.fn(async(_path:string,args:string[])=>({ok:true,output:{success:true,errorCode:null,errorMsg:null,result:
      args[2]==='tasks'?{taskIdList:[{taskId}]}:args[2]==='detail'?{
        processInstanceId:'synthetic-instance',tasks:[{taskId,userId:dwsTestConfig.userId,taskStatus:'COMPLETED',taskResult:operation==='approve'?'AGREE':'REFUSE'}]
      }:true}}))
    const tool=buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name===`dingtalk_${operation}`)!
    expect(await tool.execute({instanceId:'synthetic-instance',taskId:String(taskId)},context())).toMatchObject({output:{status:'succeeded',evidence:{provider:'dingtalk',operation,target:String(taskId),status:'done',verified:true}}})
    expect(runner.mock.calls.map(call=>call[1].slice(0,3))).toEqual([['oa','approval','tasks'],['oa','approval',operation],['oa','approval','detail']])
    expect(runner.mock.calls.filter(call=>call[1][2]===operation)).toHaveLength(1)
  })
  it('normalizes the same official taskIdList for readonly task discovery',async()=>{
    const runner=vi.fn(async()=>({ok:true,output:{success:true,result:{taskIdList:[{taskId:104969000001}]}}}))
    const tool=buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name==='dingtalk_get_approval_tasks')!
    expect(await tool.execute({instanceId:'synthetic-instance'},context())).toMatchObject({output:{status:'succeeded',data:{instanceId:'synthetic-instance',taskIds:['104969000001']}}})
  })
  it.each([{taskIdList:[]},{taskIdList:[{taskId:43}]},{taskIdList:[{taskId:9007199254740992}]},{taskIdList:[{taskId:'not-a-task'}]}])('refuses an approval target absent from the current-user taskIdList %j',async({taskIdList})=>{
    const runner=vi.fn(async()=>({ok:true,output:{success:true,result:{taskIdList}}}))
    const tool=buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name==='dingtalk_approve')!
    expect(await tool.execute({instanceId:'synthetic-instance',taskId:'42'},context())).toMatchObject({isError:true,output:{status:'failed',code:'connector_target_not_actionable'}})
    expect(runner).toHaveBeenCalledOnce()
  })
  it('keeps mismatched or interrupted write readback unknown without a second mutation',async()=>{
    let reads=0
    const runner=vi.fn(async(_path:string,args:string[])=>({ok:true,output:{success:true,result:args[2]==='get'?{todoDetailModel:{taskId:++reads===1?'todo-1':'other',isDone:false}}:true}}))
    const tool=buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name==='dingtalk_complete_task')!
    expect(await tool.execute({taskId:'todo-1'},context())).toMatchObject({isError:true,output:{status:'outcome_unknown',code:'connector_target_mismatch'}})
    expect(runner.mock.calls.filter(call=>call[1][2]==='done')).toHaveLength(1)
  })
  it.each([true, false])('verifies transfer only when the old node and new recipient match (%s)', async recipientMatches => {
    const runner = vi.fn(async (_path: string, args: string[]) => ({ ok: true, output: { success: true, result:
      args[2] === 'tasks' ? { taskIds: ['42'] } : args[2] === 'detail' ? { processInstanceId: 'instance-1', tasks: [
        { taskId: '42', result: 'REDIRECTED', status: 'COMPLETED' },
        { taskId: '43', userId: recipientMatches ? 'recipient-1' : 'other', status: 'NEW' }
      ] } : true } }))
    const tool = buildDwsToolProvider(dwsTestConfig, withDwsTestIdentity(runner))!.tools.find(item => item.name === 'dingtalk_transfer')!
    const result = await tool.execute({ instanceId: 'instance-1', taskId: '42', toUserId: 'recipient-1' }, context())
    expect(result).toMatchObject({ output: { status: recipientMatches ? 'succeeded' : 'outcome_unknown' } })
    expect(runner.mock.calls.filter(call => call[1][2] === 'redirect-task')).toHaveLength(1)
    expect(runner.mock.calls[1][1].slice(0, 7)).toEqual(['oa', 'approval', 'redirect-task', '--task-id', '42', '--to-actioner-id', 'recipient-1'])
  })
  it('rejects an explicit backend mismatch before reading identity', async () => {
    const runner = vi.fn()
    const current = context()
    current.executionGrant = { ...current.executionGrant!, connectorBackends: { dingtalk: 'openapi' } }
    expect(await buildDwsToolProvider(dwsTestConfig, runner)!.tools[0].execute({}, current)).toMatchObject({ output: { code: 'connector_backend_changed' } })
    expect(runner).not.toHaveBeenCalled()
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
  it('accepts a null error code only within an explicit successful official envelope', () => {
    const detail = { todoDetailModel: { taskId: 'synthetic-task', subject: 'RailWise 验收', isDone: false } }
    expect(_dwsToolProviderInternals.business({ ok: true, output: { success: true, errorCode: null, errorMsg: null, result: detail } })).toEqual(detail)
    for (const output of [
      { errorCode: null, result: detail },
      { success: false, errorCode: null, result: detail },
      { success: true, errorCode: 403, result: detail },
      { success: true, errorCode: 'null', result: detail }
    ]) expect(() => _dwsToolProviderInternals.business({ ok: true, output })).toThrow()
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
    {page:1,pageSize:1,total:6,start:0,count:1,hasMore:true,pages:[1]},
    {page:5,pageSize:1,total:6,start:4,count:1,hasMore:true,pages:[1]},
    {page:6,pageSize:1,total:6,start:5,count:1,hasMore:false,pages:[1]},
    {page:1,pageSize:100,total:68,start:0,count:68,hasMore:false,pages:[1,2,3,4]},
    {page:2,pageSize:25,total:68,start:25,count:25,hasMore:true,pages:[2,3]},
    {page:3,pageSize:25,total:68,start:50,count:18,hasMore:false,pages:[3,4]},
    {page:2,pageSize:15,total:68,start:15,count:15,hasMore:true,pages:[1,2]},
    {page:5,pageSize:15,total:68,start:60,count:8,hasMore:false,pages:[4]},
    {page:1,pageSize:20,total:20,start:0,count:20,hasMore:false,pages:[1]},
    {page:2,pageSize:20,total:20,start:20,count:0,hasMore:false,pages:[2]},
    {page:1,pageSize:100,total:0,start:0,count:0,hasMore:false,pages:[1]},
    {page:1000,pageSize:100,total:100010,start:99900,count:100,hasMore:true,pages:[4996,4997,4998,4999,5000]}
  ])('maps approval page $page / size $pageSize to exact 20-item transport windows', async sample => {
    const runner = vi.fn(async (_path:string, args:string[]) => {
      const page = Number(args[args.indexOf('--page') + 1])
      const size = Number(args[args.indexOf('--limit') + 1])
      expect(size).toBe(20)
      const start = (page - 1) * size
      return {ok:true,output:{success:true,result:{values:Array.from({length:Math.max(0,Math.min(size,sample.total-start))},(_,index)=>({id:String(start+index)})),hasMore:start+size<sample.total,upstreamMarker:'preserved'}}}
    })
    const tool = buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name==='dingtalk_list_approvals')!
    const result = await tool.execute({page:sample.page,pageSize:sample.pageSize},context())
    expect(result).toMatchObject({output:{status:'succeeded',data:{page:sample.page,pageSize:sample.pageSize,hasMore:sample.hasMore,values:Array.from({length:sample.count},(_,index)=>({id:String(sample.start+index)})),raw:{upstreamMarker:'preserved'}},evidence:{verified:true,operation:'list',target:'current_user'}}})
    expect(runner.mock.calls.map(call=>Number(call[1][call[1].indexOf('--page')+1]))).toEqual(sample.pages)
    const data = (result.output as {data:{values:unknown[];hasMore:boolean;raw:Record<string,unknown>;transportPages:{page:number;count:number;hash:string}[]}}).data
    expect(data.raw.values).toEqual(data.values)
    expect(data.raw.hasMore).toBe(data.hasMore)
    expect(data.raw).not.toHaveProperty('pages')
    expect(data.transportPages.map(item=>item.page)).toEqual(sample.pages)
    for (const item of data.transportPages) {
      expect(Object.keys(item).sort()).toEqual(['count','hash','page'])
      expect(item.hash).toMatch(/^[a-f0-9]{64}$/)
      expect(item.count).toBeLessThanOrEqual(20)
    }
    for (const match of JSON.stringify(data).matchAll(/"id":"(\d+)"/g)) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(sample.start)
      expect(Number(match[1])).toBeLessThan(sample.start + sample.count)
    }
  })
  it.each([{total:20,hasMore:false},{total:21,hasMore:true}])('uses bounded lookahead when approval hasMore is absent ($total items)',async sample=>{
    const runner=vi.fn(async(_path:string,args:string[])=>{
      const start=(Number(args[args.indexOf('--page')+1])-1)*20
      return {ok:true,output:{success:true,result:{values:Array.from({length:Math.max(0,Math.min(20,sample.total-start))},(_,index)=>({id:String(start+index)}))}}}
    })
    const tool=buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name==='dingtalk_list_approvals')!
    const result = await tool.execute({page:1,pageSize:20},context())
    const values = Array.from({length:20},(_,id)=>({id:String(id)}))
    expect(result).toMatchObject({output:{data:{hasMore:sample.hasMore,values,raw:{values,hasMore:sample.hasMore},transportPages:[{page:1,count:20},{page:2,count:sample.total-20}]}}})
    expect(JSON.stringify(result)).not.toContain('"id":"20"')
    expect((result.output as {data:{raw:Record<string,unknown>}}).data.raw).not.toHaveProperty('pages')
    expect(runner).toHaveBeenCalledTimes(2)
  })
  it('normalizes nested legacy values while retaining metadata and excluding upstream page bodies',async()=>{
    const values = Array.from({length:6},(_,id)=>({id:String(id)}))
    const runner=vi.fn(async()=>({ok:true,output:{success:true,result:{data:{values,hasMore:false,totalCount:6},requestId:'synthetic-request',pages:[{values}]}}}))
    const tool=buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name==='dingtalk_list_approvals')!
    const result=await tool.execute({page:3,pageSize:1},context())
    expect(result).toMatchObject({output:{data:{values:[{id:'2'}],hasMore:true,raw:{values:[{id:'2'}],hasMore:true,requestId:'synthetic-request',data:{values:[{id:'2'}],hasMore:true,totalCount:6}}}}})
    expect((result.output as {data:{raw:Record<string,unknown>}}).data.raw).not.toHaveProperty('pages')
    expect([...JSON.stringify(result).matchAll(/"id":"(\d+)"/g)].map(match=>match[1])).toEqual(['2','2','2'])
  })
  it('keeps approval business errors and malformed empty responses failed across pagination',async()=>{
    const failures=[
      {ok:false,output:{error:{code:1,message:'[MCP_TOOL_ERROR] {"errorCode":400002,"error_message":"参数错误","result":{"values":null},"success":false}'}}},
      {ok:true,output:{success:false,errorCode:400002,result:{values:null}}},
      {ok:true,output:{success:true,result:{values:null}}},
      {ok:true,output:{success:true,result:{values:[],hasMore:true}}}
    ]
    for(const response of failures){
      const runner=vi.fn(async()=>response)
      const tool=buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name==='dingtalk_list_approvals')!
      expect(await tool.execute({pageSize:100},context())).toMatchObject({isError:true,output:{status:'failed'}})
    }
    const runner=vi.fn(async():Promise<DwsCommandResult>=>({ok:true,output:{success:true,result:{values:Array.from({length:20},(_,id)=>({id:String(id)})),hasMore:true}}}))
      .mockResolvedValueOnce({ok:true,output:{success:true,result:{values:Array.from({length:20},(_,id)=>({id:String(id)})),hasMore:true}}})
      .mockResolvedValueOnce({ok:true,output:{success:false,errorCode:400002,result:{values:null}}})
    const tool=buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name==='dingtalk_list_approvals')!
    expect(await tool.execute({pageSize:100},context())).toMatchObject({isError:true,output:{status:'failed',code:'connector_remote_failed'}})
    expect(runner).toHaveBeenCalledTimes(2)
  })
  it.each([{page:Number.MAX_SAFE_INTEGER,pageSize:100},{page:1.5,pageSize:20},{page:0,pageSize:20},{page:1,pageSize:101},{page:1,pageSize:NaN}])('rejects unsafe or out-of-contract approval pagination before dispatch',async args=>{
    const runner=vi.fn(async()=>({ok:true,output:{success:true,result:{values:[]}}}))
    const tool=buildDwsToolProvider(dwsTestConfig,withDwsTestIdentity(runner))!.tools.find(tool=>tool.name==='dingtalk_list_approvals')!
    expect(await tool.execute(args,context())).toMatchObject({isError:true,output:{status:'failed'}})
    expect(runner).not.toHaveBeenCalled()
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
