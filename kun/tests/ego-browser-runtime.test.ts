import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
const controlled=vi.hoisted(()=>({calls:0,finishes:0,timeoutFirstOpen:false,timeoutSent:false,parameters:[] as Record<string,unknown>[],html:'<body><article><h2>离线合成测绘项目</h2><time>2026-11-16</time></article></body>'}))
vi.mock('../src/services/ego-browser-cli.js',async original=>({...await original<typeof import('../src/services/ego-browser-cli.js')>(),runEgoBrowserScript:vi.fn(async(_config:unknown,script:string)=>{
 const first=script.split('\n')[0]!;const p=JSON.parse(first.slice(first.startsWith('const p = ')?'const p = '.length:'const p='.length,-1)) as Record<string,unknown>;controlled.calls++;controlled.parameters.push(p);if(controlled.timeoutFirstOpen&&!controlled.timeoutSent&&p.action==='open'){controlled.timeoutSent=true;throw new Error('ego_browser_command_timeout')}if(!p.action){controlled.finishes++;return {ok:true,taskSpaceId:27,spaceName:p.spaceName,finishResolved:true,keep:[]}}
 return {ok:true,taskSpaceId:27,spaceName:p.spaceName,ownership:'agent',pageLabel:'p1',sourceUrl:'https://feed.test/list',html:controlled.html,documentHtml:controlled.html,truncated:false,candidates:[]}
})}))
const clean:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{while(clean.length)await clean.pop()!();controlled.calls=0;controlled.finishes=0;controlled.timeoutFirstOpen=false;controlled.timeoutSent=false;controlled.parameters=[]})
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

it.each([false,true])('completes the real Factory/Coordinator/Host chain through verified report, schedule and finish (first navigation timeout=%s)',async recoverInitialTimeout=>{
 controlled.timeoutFirstOpen=recoverInitialTimeout
 const root=await realpath(await mkdtemp(join(tmpdir(),'ego-full-completion-')));clean.push(()=>rm(root,{recursive:true,force:true}));const workspace=join(root,'workspace');await mkdir(workspace)
 const goal='每天09:00使用Ego浏览器只读 https://feed.test/list 我已订阅的招标列表，按工程测量、测绘、监测筛选汇总为HTML，只核对列表，不需要公告正文。'
 const steps=[['open','ego_browser_open'],['read','ego_browser_read'],['publish','publish_artifact'],['read-file','read_artifact'],['verify','verify_web_artifact'],['schedule','schedule_task'],['read-schedule','list_schedules'],['finish','ego_browser_finish']]
 let requests=0
 const model=createServer(async(request,response)=>{
  const bytes:Buffer[]=[];for await(const chunk of request)bytes.push(Buffer.from(chunk))
  const body=JSON.parse(Buffer.concat(bytes).toString()) as {messages?:Array<{tool_call_id?:string;content?:string;tool_calls?:Array<{id:string}>}>};requests++
  const called=new Set(body.messages?.flatMap(m=>m.tool_calls?.map(c=>c.id)??[])),next=steps.find(([id])=>!called.has('full-'+id))
  const result=(id:string)=>{const content=body.messages?.find(m=>m.tool_call_id==='full-'+id)?.content;if(!content)throw new Error('Missing real tool result '+id);return JSON.parse(content.slice(content.indexOf('{'))) as Record<string,unknown>}
  let args:Record<string,unknown>={}
  if(next?.[0]==='open')args={url:'https://feed.test/list'}
  if(next?.[0]==='publish'){
   const read=result('read'),ref={url:read.sourceUrl,resultHash:read.resultHash},title='离线合成测绘项目',quote=title+' 2026-11-16'
   args={path:'feed.html',report:{title:'离线订阅列表汇总',presentation:{screening:[{sectionId:'record-one',decision:'relevant',reason:'列表标题明确包含测绘服务范围',businessTypes:['测绘']}]},evidence:{coverage:[ref],items:[{sectionId:'record-one',title,source:ref,discovery:ref,classification:'source',fields:[{field:'title',value:title,quote},{field:'publication_date',value:'2026-11-16',quote}],unverifiedFields:['budget','deadline','status','qualification']}],noMatches:[]}}}
  }
  if(next?.[0]==='read-file')args={path:'feed.html'}
  if(next?.[0]==='verify')args=result('publish').verificationInput as Record<string,unknown>
  const delta=next?{tool_calls:[{index:0,id:'full-'+next[0],type:'function',function:{name:next[1],arguments:JSON.stringify(args)}}]}:{content:'已保存并核验订阅列表HTML汇总，按每日09:00建立并读回计划；Ego任务空间已完成收尾。列表中的正文、预算与资质尚未核验。'}
  response.writeHead(200,{'content-type':'text/event-stream'});response.end(`data: ${JSON.stringify({id:'controlled-full',choices:[{index:0,delta,finish_reason:next?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})}\n\ndata: [DONE]\n\n`)
 })
 await new Promise<void>(resolve=>model.listen(0,'127.0.0.1',resolve));clean.push(()=>new Promise<void>(resolve=>{model.close(()=>resolve());model.closeAllConnections()}))
 const runtime=await createKunServeRuntime({host:'127.0.0.1',port:0,dataDir:join(root,'runtime'),runtimeToken:'controlled',apiKey:'controlled-local-only',baseUrl:`http://127.0.0.1:${(model.address() as {port:number}).port}/v1`,endpointFormat:'chat_completions',model:'controlled',approvalPolicy:'on-request',sandboxMode:'read-only',insecure:false,tokenEconomyMode:false,storage:{backend:'file'},capabilities:KunCapabilitiesConfig.parse({egoBrowser:{state:'installed',executablePath:'/controlled/ego-browser',executableHash:'a'.repeat(64),version:'0.6.3.14',revision:0}})})
 clean.push(async()=>runtime.shutdown?.())
 let firstFinalizationEntered=false,releaseFirstFinalization=()=>{}
 if(recoverInitialTimeout){
  const finalizeAllowed=new Promise<void>(resolve=>{releaseFirstFinalization=resolve})
  const finishTurn=runtime.turnService.finishTurn.bind(runtime.turnService)
  const finalization=vi.spyOn(runtime.turnService,'finishTurn').mockImplementation(async input=>{
   if(!firstFinalizationEntered){firstFinalizationEntered=true;await finalizeAllowed}
   return finishTurn(input)
  })
  clean.push(async()=>{releaseFirstFinalization();finalization.mockRestore()})
 }
 const origin=await runtime.threadService.create({workspace,mode:'agent',model:'controlled',approvalPolicy:'on-request'}),started=await runtime.taskCoordinator!.command({threadId:origin.id,intent:'new',idempotencyKey:'ego-full-completion',request:{prompt:goal}})
 expect(started.kind).not.toBe('capability_required');const taskId=started.task!.id
 let oldNavigation:{data_json:string}|undefined,oldTurn:string|undefined
 if(recoverInitialTimeout){
  await expect.poll(()=>runtime.taskRepository!.get(taskId)?.status,{timeout:5000}).toBe('waiting_user')
  expect(controlled.calls).toBe(1);expect(requests).toBe(1);expect(controlled.finishes).toBe(0)
  const before=runtime.taskRepository!.get(taskId)!,binding=runtime.taskRepository!.operation(taskId,'ego-task-space')!
  oldTurn=before.activeTurnId;expect(binding.status).toBe('prepared')
  const nav=runtime.taskRepository!.operations(taskId,'ego_page_navigation')[0]!
  expect(nav.status).toBe('prepared');expect(runtime.taskRepository!.operations(taskId,'tool')[0]?.status).toBe('failed')
  oldNavigation=runtime.taskRepository!.connection().prepare('SELECT data_json FROM operation_receipts WHERE owner_id=? AND idempotency_key=?').get(taskId,nav.idempotencyKey) as {data_json:string}
  // Expose the real boundary: Task waiting is persisted before Thread Turn finalization.
  await expect.poll(()=>firstFinalizationEntered,{timeout:5000}).toBe(true)
  expect((await runtime.threadService.get(before.threadId))!.turns.find(turn=>turn.id===oldTurn)).toMatchObject({status:'running'})
  releaseFirstFinalization()
  await expect.poll(async()=>{
   const turn=(await runtime.threadService.get(before.threadId))?.turns.find(turn=>turn.id===oldTurn)
   return turn!==undefined&&['completed','failed','aborted'].includes(turn.status)
  },{timeout:5000}).toBe(true)
  const resumed=await runtime.taskCoordinator!.command({threadId:origin.id,taskId,intent:'resume',idempotencyKey:'same-ego-user-resume',request:{prompt:'继续原任务'}})
  expect(resumed.kind).not.toBe('capability_required');expect(resumed.task?.id).toBe(taskId)
  await expect.poll(()=>runtime.taskRepository!.get(taskId)?.activeTurnId,{timeout:5000}).not.toBe(oldTurn)
 }
 await expect.poll(()=>{const task=runtime.taskRepository!.get(taskId)!,errors=runtime.taskRepository!.operations(taskId,'tool').filter(r=>r.status==='failed').map(r=>((r.result as {item?:{output?:{code?:string}}})?.item?.output?.code));return {status:task.status,reason:task.waitingReason??task.stalledReason??null,errors}},{timeout:15000}).toEqual({status:'completed',reason:null,errors:recoverInitialTimeout?['ego_browser_command_timeout']:[]})
 const task=runtime.taskRepository!.get(taskId)!,tools=runtime.taskRepository!.operations(taskId,'tool')
 expect(task.nodes.filter(n=>['execute','verify','deliver'].includes(n.kind)).map(n=>({kind:n.kind,status:n.status}))).toEqual([{kind:'execute',status:'completed'},{kind:'verify',status:'completed'},{kind:'deliver',status:'completed'}])
 expect(task.artifacts).toEqual([expect.objectContaining({relativePath:'feed.html',validation:'valid',sourceEvidenceStatus:'verified'})]);expect(controlled.finishes).toBe(1)
 expect(tools.map(r=>r.request?.toolName)).toEqual([...(recoverInitialTimeout?['ego_browser_open']:[]),...steps.map(s=>s[1])]);expect(tools.map(r=>r.status)).toEqual([...(recoverInitialTimeout?['failed']:[]),...steps.map(()=>'succeeded')])
 expect(runtime.taskRepository!.operations(taskId,'ego_task_space_finish')).toEqual([expect.objectContaining({status:'succeeded'})]);expect(requests).toBe(recoverInitialTimeout?10:9)
 if(recoverInitialTimeout){
  const nav=runtime.taskRepository!.operations(taskId,'ego_page_navigation')[0]!,raw=runtime.taskRepository!.connection().prepare('SELECT data_json FROM operation_receipts WHERE owner_id=? AND idempotency_key=?').get(taskId,nav.idempotencyKey) as {data_json:string}
  expect(nav.status).toBe('prepared');expect(raw.data_json).toBe(oldNavigation!.data_json)
  const binding=runtime.taskRepository!.operation(taskId,'ego-task-space')!
  expect(binding.status).toBe('succeeded');expect(binding.request?.createdTurnId).toBe(oldTurn)
  expect(runtime.taskRepository!.operations(taskId,'ego_task_space')).toHaveLength(1)
  expect(controlled.parameters.filter(p=>p.action==='open'&&!p.recoverExistingOnly)).toHaveLength(1)
  const recovered=controlled.parameters.find(p=>p.recoverExistingOnly===true)!
  expect(recovered).toMatchObject({action:'open',recoverExistingOnly:true,spaceName:binding.request?.spaceName})
  expect(controlled.parameters.filter(p=>p.spaceName===binding.request?.spaceName)).toHaveLength(4)
 }
})
