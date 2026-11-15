import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { InMemorySessionStore } from '../src/adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../src/adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../src/domain/thread.js'
import { TaskController } from '../src/services/task-controller.js'
import { TaskRunRepository } from '../src/services/task-run-repository.js'
import { makeAssistantTextItem, makeToolResultItem } from '../src/domain/item.js'
const cleanup:string[]=[]
afterEach(async()=>{await Promise.all(cleanup.splice(0).map(p=>rm(p,{recursive:true,force:true})))})
it.each(['retired-browser-no-links','same-browser-index-links'] as const)('must not complete a WIP HTML using disconnected historical origin coverage: %s',async variation=>{
 const root=await mkdtemp(join(tmpdir(),'railwise-web-evidence-red-'));cleanup.push(root)
 const repository=new TaskRunRepository(join(root,'tasks.sqlite3'))
 try{
  const threadStore=new InMemoryThreadStore(),sessionStore=new InMemorySessionStore()
  const thread=createThreadRecord({id:'thread_private_red',title:'isolated',workspace:root,model:'synthetic_no_model'})
  await threadStore.upsert(thread)
  const controller=new TaskController({repository,threadStore,sessionStore,nowIso:()=> '2026-11-15T00:00:00.000Z',ownerId:'isolated-read-evidence-test'})
  const task=controller.ensureTask({thread,turnId:'old-turn',request:{prompt:'读取两个平台正式公告正文，核验预算和截止时间，生成HTML报告。'}})
  let current=repository.get(task.id)!
  repository.update(task.id,current.revision,t=>({...t,acceptance:{kind:'files',requiredNodeKinds:['execute','verify','deliver'],requiredFormats:['html'],minimumArtifacts:1,requiresWebEvidence:true,requiredSourceOrigins:['https://a.example.test','https://b.example.test'],requireFinalResponse:true,requireActionableArtifactCard:true}}))
  controller.beginAttempt(thread.id,'old-turn')
  const oldScope={browserInstanceId:variation==='retired-browser-no-links'?'old-c9':'current-f84',origins:['https://a.example.test','https://b.example.test'],interaction:'interact' as const,verificationPolicy:'public_query_target' as const,revision:variation==='retired-browser-no-links'?3:4}
  const grant={id:'grant-old-turn',taskId:task.id,threadId:thread.id,turnId:'old-turn',workspaceRoot:root,workspaceTrust:'read-only' as const,agentTrust:'full-access' as const,sandboxMode:'read-only' as const,approvalPolicy:'on-request' as const,pathAllowlist:[root],networkAllowlist:oldScope.origins,connectorScopes:[],externalTargets:[],workspaceRevision:0,agentRevision:0,revision:0,idempotencyKey:'grant-old-turn',issuedAt:'2026-11-15T00:00:00.000Z',expiresAt:'2026-11-15T00:15:00.000Z',browserScope:oldScope}
  for(const [index,origin]of oldScope.origins.entries()){
   const call={callId:`old-read-${index}`,toolName:'browser_get_html',arguments:{sessionId:'old-session'}}
   const operation=controller.beginToolOperation('old-turn',call,grant)!
   const result={approved:true,item:makeToolResultItem({id:`result-old-read-${index}`,threadId:thread.id,turnId:'old-turn',callId:call.callId,toolName:call.toolName,output:{status:'succeeded',sourceUrl:origin+'/list',resultHash:'a'.repeat(64),html:'<main>历史合同列表，已结束</main>',evidence:{verified:true,contentRead:true}}})}
   controller.finishToolOperation(operation.token,operation.key,result);await sessionStore.appendItem(thread.id,result.item)
  }
  current=repository.get(task.id)!;controller.pauseTask(task.id,current.revision)
  current=repository.get(task.id)!;controller.prepareResume(task.id,current.revision)
  controller.ensureTask({thread,turnId:'new-turn',continuationTaskId:task.id,request:{prompt:'继续原任务，补齐正式公告正文。'}})
  current=repository.get(task.id)!
  repository.update(task.id,current.revision,t=>({...t,authority:{...t.authority!,browserScope:{...oldScope,browserInstanceId:'current-f84',revision:4}}}))
  controller.beginAttempt(thread.id,'new-turn')
  const links=variation==='same-browser-index-links'?'<a href="https://a.example.test/list">检索入口</a><a href="https://b.example.test/list">检索入口</a>':''
  await writeFile(join(root,'report.html'),`<!doctype html><html lang="zh-CN"><head><title>招标报告</title></head><body><h1>七条线索</h1><p>公告URL、预算、投标截止、资格均待核验，详情页未打开。</p>${links}</body></html>`)
  await sessionStore.appendItem(thread.id,makeToolResultItem({id:'report-path',threadId:thread.id,turnId:'new-turn',callId:'write-report',toolName:'write',output:{path:join(root,'report.html')}}))
  await sessionStore.appendItem(thread.id,makeAssistantTextItem({id:'final',threadId:thread.id,turnId:'new-turn',text:'HTML报告已保存，采集成果已交付。',status:'completed'}))
  const decision=await controller.assessCandidate(thread.id,'new-turn')
  expect(decision.kind).not.toBe('completed')
  expect(repository.events(task.id).some(e=>e.kind==='task_completed')).toBe(false)
 }finally{repository.close()}
})
