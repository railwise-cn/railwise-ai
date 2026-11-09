import { createServer } from 'node:http'
import { mkdtemp,rm,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'

const cleanup:Array<()=>Promise<unknown>>=[]
afterEach(async()=>{while(cleanup.length)await cleanup.pop()!()})
describe('production task coordinator and durable Worker delivery',()=>{
  it('keeps task data readable with background scheduling disabled and still runs ordinary chat',async()=>{
    const root=await mkdtemp(join(tmpdir(),'railwise-task-rollback-'))
    cleanup.push(()=>rm(root,{recursive:true,force:true}))
    let requests=0
    const server=createServer(async(request,response)=>{
      for await(const _data of request){/* Consume the synthetic request. */}
      requests++
      response.writeHead(200,{'content-type':'text/event-stream'})
      response.end(`data: ${JSON.stringify({id:'chat_reply',choices:[{index:0,delta:{content:'普通聊天仍可使用。'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    cleanup.push(()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections()}))
    const address=server.address();if(!address||typeof address==='string')throw new Error('listener unavailable')
    const options={host:'127.0.0.1',port:0,dataDir:join(root,'state'),runtimeToken:'fixture',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'',endpointFormat:'chat_completions' as const,model:'fixture',approvalPolicy:'auto' as const,sandboxMode:'workspace-write' as const,tokenEconomyMode:false,insecure:false,storage:{backend:'file' as const},capabilities:KunCapabilitiesConfig.parse({})}
    vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED','1')
    try {
      const before=await createKunServeRuntime(options)
      const thread=await before.threadService.create({workspace:root,model:'fixture',mode:'agent'})
      const queued=await before.turnService.startTurn({threadId:thread.id,request:{prompt:'整理资料任务',taskIntent:'new',taskVisibility:'task',taskOriginThreadId:'origin-fixture'}})
      const task=before.taskRepository!.findByTurn(queued.turnId)!
      await before.shutdown?.()
      const runtime=await createKunServeRuntime(options)
      cleanup.push(async()=>runtime.shutdown?.())
      expect(runtime.taskRepository!.get(task.id)).toMatchObject({revision:task.revision,status:'queued'})
      expect(runtime.taskViewService!.page({}).items.map(item=>item.id)).toContain(task.id)
      const origin=await runtime.threadService.create({workspace:root,model:'fixture',mode:'agent'})
      const chat=await runtime.taskCoordinator!.command({threadId:origin.id,intent:'chat',idempotencyKey:'ordinary',request:{prompt:'你好',reasoningEffort:'off'}})
      if(chat.kind!=='chat_started')throw new Error('expected ordinary chat')
      await runtime.runTurn(chat.turn.threadId,chat.turn.turnId)
      expect(requests).toBe(1)
      expect(runtime.taskRepository!.get(task.id)).toMatchObject({revision:task.revision,status:'queued'})
    } finally {vi.unstubAllEnvs()}
  },15_000)

  it('pauses and resumes the same task before Turn routing, keeps paused input queued, and cancels the resumed Worker',async()=>{
    const root=await mkdtemp(join(tmpdir(),'railwise-task-controls-'))
    cleanup.push(()=>rm(root,{recursive:true,force:true}))
    const requests:Record<string,unknown>[]=[]
    const releases:Array<()=>void>=[],arrivals:Array<()=>void>=[]
    const barriers=[0,1].map(()=>new Promise<void>(resolve=>releases.push(resolve)))
    const arrived=[0,1].map(()=>new Promise<void>(resolve=>arrivals.push(resolve)))
    const server=createServer(async(request,response)=>{
      let raw='';for await(const data of request)raw+=data.toString()
      const index=requests.length
      requests.push(JSON.parse(raw) as Record<string,unknown>)
      arrivals[index]?.()
      await barriers[index]
      response.writeHead(200,{'content-type':'text/event-stream'})
      response.end(`data: ${JSON.stringify({id:`reply_${index}`,choices:[{index:0,delta:{content:'合成资料整理完毕。'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    cleanup.push(()=>new Promise<void>((resolve,reject)=>{for(const release of releases)release();server.close(error=>error?reject(error):resolve());server.closeAllConnections()}))
    const address=server.address();if(!address||typeof address==='string')throw new Error('listener unavailable')
    const runtime=await createKunServeRuntime({host:'127.0.0.1',port:0,dataDir:join(root,'state'),runtimeToken:'fixture',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'',endpointFormat:'chat_completions',model:'fixture',approvalPolicy:'auto',sandboxMode:'workspace-write',tokenEconomyMode:false,insecure:false,storage:{backend:'file'},capabilities:KunCapabilitiesConfig.parse({})})
    cleanup.push(async()=>{for(const release of releases)release();await runtime.shutdown?.()})
    const origin=await runtime.threadService.create({workspace:root,model:'fixture',mode:'agent'})
    const started=await runtime.taskCoordinator!.command({threadId:origin.id,intent:'new',idempotencyKey:'start',request:{prompt:'整理合成资料并直接回答结论。',reasoningEffort:'off'}})
    if(started.kind!=='task_started')throw new Error('expected task')
    await arrived[0]
    const paused=await runtime.taskCoordinator!.command({threadId:origin.id,idempotencyKey:'pause',request:{prompt:'先暂停'}})
    expect(paused).toMatchObject({kind:'task_updated',action:'pause',task:{id:started.task!.id,status:'paused'}})
    await runtime.runTurn(started.turn.threadId,started.turn.turnId)
    releases[0]!()
    await runtime.taskCoordinator!.command({threadId:origin.id,idempotencyKey:'supplement',request:{prompt:'再补充风险项：阈值待确认。'}})
    expect(requests).toHaveLength(1)
    expect(runtime.taskRepository!.inputs(started.task!.id,true)).toHaveLength(1)
    expect(runtime.taskRepository!.get(started.task!.id)?.status).toBe('paused')
    const resumed=await runtime.taskCoordinator!.command({threadId:origin.id,idempotencyKey:'resume',request:{prompt:'继续'}})
    if(resumed.kind!=='task_started')throw new Error('expected resumed task')
    expect(resumed.task!.id).toBe(started.task!.id)
    expect(resumed.turn.threadId).toBe(started.turn.threadId)
    expect(resumed.turn.turnId).not.toBe(started.turn.turnId)
    await arrived[1]
    expect(JSON.stringify(requests[1])).toContain('阈值待确认')
    expect(runtime.taskRepository!.latestCheckpoint(started.task!.id)?.consumedInputIds).toHaveLength(1)
    const cancelled=await runtime.taskCoordinator!.command({threadId:origin.id,idempotencyKey:'cancel',request:{prompt:'取消任务'}})
    expect(cancelled).toMatchObject({kind:'task_updated',action:'cancel',task:{id:started.task!.id,status:'cancelled'}})
    await runtime.runTurn(resumed.turn.threadId,resumed.turn.turnId)
    releases[1]!()
    expect(requests).toHaveLength(2)
    expect((await runtime.threadService.get(started.turn.threadId))?.turns).toHaveLength(2)
  },15_000)

  it('queries locally, delivers a supplementary file reference to the original Worker and checkpoints before consuming',async()=>{
    const root=await mkdtemp(join(tmpdir(),'railwise-task-production-'))
    cleanup.push(()=>rm(root,{recursive:true,force:true}))
    await writeFile(join(root,'source.md'),'# 合成资料\n本期数据完整。\n')
    await writeFile(join(root,'risk.md'),'# 风险\n需要继续核查阈值。\n')
    const requests:Record<string,unknown>[]=[]
    let firstArrived!:()=>void, releaseFirst!:()=>void
    const arrived=new Promise<void>(resolve=>{firstArrived=resolve})
    const release=new Promise<void>(resolve=>{releaseFirst=resolve})
    const server=createServer(async(request,response)=>{
      let raw='';for await(const data of request)raw+=data.toString()
      const body=JSON.parse(raw) as Record<string,unknown>;requests.push(body)
      const first=requests.length===1
      if(first){firstArrived();await release}
      const delta=first?{tool_calls:[{index:0,id:'read_source',type:'function',function:{name:'read',arguments:JSON.stringify({path:'source.md'})}}]}:{content:'合成测试结论：资料记载本期数据完整，风险分析需继续核查阈值。'}
      response.writeHead(200,{'content-type':'text/event-stream'})
      response.end(`data: ${JSON.stringify({id:`reply_${requests.length}`,choices:[{index:0,delta,finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})}\n\ndata: [DONE]\n\n`)
    })
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    cleanup.push(()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections()}))
    const address=server.address();if(!address||typeof address==='string')throw new Error('listener unavailable')
    const runtime=await createKunServeRuntime({host:'127.0.0.1',port:0,dataDir:join(root,'state'),runtimeToken:'fixture',baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKey:'',endpointFormat:'chat_completions',model:'fixture',approvalPolicy:'auto',sandboxMode:'workspace-write',tokenEconomyMode:false,insecure:false,storage:{backend:'file'},capabilities:KunCapabilitiesConfig.parse({})})
    cleanup.push(async()=>{releaseFirst();await runtime.shutdown?.()})
    const origin=await runtime.threadService.create({workspace:root,model:'fixture',mode:'agent'})
    await runtime.taskCoordinator!.command({threadId:origin.id,idempotencyKey:'status',request:{prompt:'wrapper',displayText:'现在做到哪了'}})
    expect(requests).toHaveLength(0)
    const started=await runtime.taskCoordinator!.command({threadId:origin.id,intent:'new',idempotencyKey:'task',request:{prompt:'分析指定合成资料，直接给出结论。',reasoningEffort:'off',workspaceReferences:[{kind:'file',path:'source.md'}]}})
    if(started.kind!=='task_started')throw new Error('expected task')
    await arrived
    const task=runtime.taskRepository!.get(started.task!.id)!
    const supplement=await runtime.taskCoordinator!.command({threadId:origin.id,taskId:task.id,expectedRevision:task.revision,intent:'supplement',idempotencyKey:'supplement',request:{prompt:'再补充风险分析，按 risk.md 的资料说明。',workspaceReferences:[{kind:'file',path:'risk.md'}]}})
    expect(supplement.kind).toBe('input_queued')
    expect(runtime.taskRepository!.inputs(task.id,true)).toHaveLength(1)
    expect(runtime.taskRepository!.execution.pending(runtime.taskRepository!.execution.sessionForTask(task.id)!.id)).toHaveLength(1)
    let deliveredBeforeCheckpoint=false
    const acknowledge=runtime.taskController!.acknowledgeInputs.bind(runtime.taskController)
    vi.spyOn(runtime.taskController!,'acknowledgeInputs').mockImplementation((...args)=>{
      const stored=runtime.taskRepository!.execution.pending(runtime.taskRepository!.execution.sessionForTask(task.id)!.id)
      expect(stored).toHaveLength(1)
      expect(stored[0]).toMatchObject({status:'delivered',sessionItemId:args[2],sessionHash:args[3]})
      expect(runtime.taskRepository!.inputs(task.id,true)).toHaveLength(1)
      deliveredBeforeCheckpoint=true
      acknowledge(...args)
    })
    releaseFirst()
    expect(await runtime.runTurn(started.turn.threadId,started.turn.turnId)).toBe('completed')
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain('再补充风险分析')
    expect(JSON.stringify(requests[1])).toContain('risk.md')
    expect(runtime.taskRepository!.inputs(task.id,true)).toHaveLength(0)
    expect(runtime.taskRepository!.latestCheckpoint(task.id)?.consumedInputIds).toHaveLength(1)
    expect(deliveredBeforeCheckpoint).toBe(true)
    expect(runtime.taskRepository!.get(task.id)?.status).toBe('completed')
    expect((await runtime.threadService.list()).map(thread=>thread.id)).toEqual([origin.id])
    const bundles=runtime.taskContextRuntime!.repository.listContextBundles(task.id)
    expect(bundles.length).toBeGreaterThan(0)
  },15_000)
})
