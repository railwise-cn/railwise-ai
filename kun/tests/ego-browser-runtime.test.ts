import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
const controlled=vi.hoisted(()=>({calls:0}))
vi.mock('../src/services/ego-browser-cli.js',async original=>({...await original<typeof import('../src/services/ego-browser-cli.js')>(),runEgoBrowserScript:vi.fn(async(_config:unknown,script:string)=>{
 const p=JSON.parse(script.split('\n')[0]!.slice('const p = '.length,-1)) as Record<string,unknown>;controlled.calls++
 return {ok:true,taskSpaceId:27,spaceName:p.spaceName,ownership:'agent',pageLabel:'p1',sourceUrl:'https://feed.test/list',html:'<body><article><h2>离线合成测绘项目</h2><time>2026-11-16</time></article></body>',documentHtml:'<body><article>离线合成测绘项目</article></body>',truncated:false,candidates:[]}
})}))
const clean:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{while(clean.length)await clean.pop()!();controlled.calls=0})
it('runs explicit Ego through the existing Coordinator/Task/Host/Turn Grant without advertising BrowserSkill',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'ego-kun-runtime-')));clean.push(()=>rm(root,{recursive:true,force:true}));const workspace=join(root,'workspace');await mkdir(workspace)
 let modelCalls=0
 const model=createServer(async(request,response)=>{
  const bytes:Buffer[]=[];for await(const chunk of request)bytes.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(bytes).toString()) as {tools?:Array<{function:{name:string}}>};modelCalls++
  const names=body.tools?.map(t=>t.function.name)??[];expect(names).toContain('ego_browser_open');expect(names).not.toContain('browser_session_start');expect(names).not.toContain('request_host_shell');expect(names).not.toContain('bash')
  const delta=modelCalls===1?{tool_calls:[{index:0,id:'controlled-ego-open',type:'function',function:{name:'ego_browser_open',arguments:JSON.stringify({url:'https://feed.test/list'})}}]}:{content:'当前列表记录为：离线合成测绘项目。该结论仅来自订阅列表。'}
  response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({id:'controlled',choices:[{index:0,delta,finish_reason:modelCalls===1?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)
 })
 await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));clean.push(()=>new Promise<void>(resolve=>{model.close(()=>resolve());model.closeAllConnections()}))
 const runtime=await createKunServeRuntime({host:'127.0.0.1',port:0,dataDir:join(root,'runtime'),runtimeToken:'controlled',apiKey:'controlled-local-only',baseUrl:`http://127.0.0.1:${(model.address() as {port:number}).port}/v1`,endpointFormat:'chat_completions',model:'controlled',approvalPolicy:'on-request',sandboxMode:'read-only',insecure:false,tokenEconomyMode:false,storage:{backend:'file'},capabilities:KunCapabilitiesConfig.parse({egoBrowser:{state:'installed',executablePath:'/controlled/ego-browser',executableHash:'a'.repeat(64),version:'0.6.3.14',revision:0}})})
 clean.push(async()=>runtime.shutdown?.())
 const origin=await runtime.threadService.create({workspace,mode:'agent',model:'controlled',approvalPolicy:'on-request'})
 const started=await runtime.taskCoordinator!.command({threadId:origin.id,intent:'new',idempotencyKey:'ego-controlled-only',request:{prompt:'请使用Ego浏览器只读 https://feed.test/list 已授权的订阅列表，把列表中项目标题告诉我，不要生成文件。'}})
 expect(started.kind).not.toBe('capability_required')
 await expect.poll(()=>controlled.calls,{timeout:5000}).toBe(1)
 const tasks=runtime.taskRepository!.list({limit:10}),task=tasks.find(t=>t.authority?.browserScope?.provider==='ego-browser')!
 expect(task).toBeDefined()
 await expect.poll(()=>runtime.taskRepository!.operations(task.id,'tool').filter(o=>o.request?.providerId==='ego-browser'&&o.status==='succeeded').length,{timeout:5000}).toBe(1)
 const thread=(await runtime.threadService.get(task.threadId))!,grant=thread.turns.find(t=>t.executionGrant?.taskId===task.id)?.executionGrant
 expect(grant).toMatchObject({browserScope:{provider:'ego-browser'},connectorIdentityFingerprints:{'ego-browser':expect.stringMatching(/^[a-f0-9]{64}$/)}})
 expect(grant?.allowedToolNames).toContain('ego_browser_read');expect(grant?.allowedProviderIds).not.toContain('browser-skill')
})
