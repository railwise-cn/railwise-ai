import { describe, expect, it,vi } from 'vitest'
import { mkdtemp,readFile,rm,writeFile,stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { CapabilityRegistry } from '../src/adapters/tool/capability-registry.js'
import { LocalToolHost,buildDefaultLocalTools } from '../src/adapters/tool/local-tool-host.js'
import { buildDocumentDeliveryToolProviders } from '../src/adapters/tool/document-delivery-tool-provider.js'
import { TaskRunRepository } from '../src/services/task-run-repository.js'
import { createThreadRecord } from '../src/domain/thread.js'
import { TaskController } from '../src/services/task-controller.js'
import { CapacityManager } from '../src/services/capacity-manager.js'
import { DelegationRuntime,FileDelegationStore } from '../src/delegation/delegation-runtime.js'
import { InMemoryThreadStore } from '../src/adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../src/adapters/in-memory-session-store.js'
import { InMemoryUserInputGate } from '../src/adapters/in-memory-user-input-gate.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { createImmutablePrefix } from '../src/cache/immutable-prefix.js'
import { createChildAgentExecutor } from '../src/delegation/child-agent-executor.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'

function model(chunks: ModelStreamChunk[], seen: ModelRequest[] = []): ModelClient {
  return {
    provider: 'child-test',
    model: 'child-test',
    async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
      seen.push(request)
      for (const chunk of chunks) yield chunk
    }
  }
}

describe('child agent executor', () => {
  it('shares worker/model permits at actual execution and releases them while a real child waits for a user',async()=>{
    const root=await mkdtemp(join(tmpdir(),'railwise-child-capacity-'))
    const repository=new TaskRunRepository(join(root,'tasks.sqlite3'))
    const capacity=new CapacityManager({model:1,worker:1,shell:1,workspaceShell:1})
    const inputs=new InMemoryUserInputGate()
    const controller=new TaskController({repository,threadStore:new InMemoryThreadStore(),sessionStore:new InMemorySessionStore(),nowIso:()=>new Date().toISOString()})
    let requests=0
    const executor=createChildAgentExecutor({dataDir:join(root,'sessions'),taskRepository:repository,capacityManager:capacity,userInputGate:inputs,
      model:{provider:'fixture',model:'fixture',async *stream(){
        requests++
        expect(capacity.snapshot().filter(item=>item.resources.model===1&&item.resources.worker===1)).toHaveLength(1)
        expect(capacity.snapshot()).toHaveLength(1)
        if(requests===1){yield {kind:'tool_call_complete' as const,callId:'question',toolName:'user_input',arguments:{prompt:'Choose a synthetic report scope',options:['Summary','Detailed']}};yield {kind:'completed' as const,stopReason:'tool_calls' as const}}
        else {yield {kind:'assistant_text_delta' as const,text:'The synthetic review is complete with the selected scope.'};yield {kind:'completed' as const,stopReason:'stop' as const}}
      }},toolHost:new LocalToolHost({tools:buildDefaultLocalTools()}),prefix:createImmutablePrefix({systemPrompt:'Ask for the missing scope, then answer.'}),defaultModel:'fixture'})
    const runtime=new DelegationRuntime({config:KunCapabilitiesConfig.parse({subagents:{enabled:true,maxParallel:2,maxChildRuns:3}}).subagents,store:new FileDelegationStore(join(root,'runs')),taskRepository:repository,taskController:controller,capacityManager:capacity,executor})
    try {
      const run=runtime.runChild({parentThreadId:'parent',parentTurnId:'parent-turn',prompt:'Ask for the scope and complete the review.',workspace:root,signal:new AbortController().signal})
      await vi.waitFor(()=>expect(inputs.pending()).toHaveLength(1),{timeout:5000})
      expect(requests).toBe(1)
      expect(capacity.snapshot()).toHaveLength(0)
      const other=capacity.reserve({id:'other-main-task',resources:{model:1,worker:1}})
      expect(()=>capacity.reserve({id:'oversubscribed',resources:{model:1,worker:1}})).toThrow(/capacity exhausted/)
      inputs.resolve(inputs.pending()[0]!.id,{status:'submitted',answers:[]})
      // The answer may be persisted while another task owns the execution slot.
      await Promise.resolve()
      expect(requests).toBe(1)
      other.release()
      const completed=await run
      expect(completed.error).toBeUndefined()
      expect(completed.status).toBe('completed')
      expect(requests).toBe(2)
      expect(capacity.snapshot()).toHaveLength(0)
    } finally {runtime.abortAll('test cleanup');inputs.reset();await runtime.awaitIdle();repository.close();await rm(root,{recursive:true,force:true})}
  })

  it('enforces read and task-owned candidate output even if a child requests an unadvertised direct write',async()=>{
    const root=await mkdtemp(join(tmpdir(),'railwise-child-candidate-'))
    const repository=new TaskRunRepository(join(root,'tasks.sqlite3'))
    try {
      await writeFile(join(root,'user.md'),'# User original\n')
      const parent=createThreadRecord({id:'parent',title:'Parent',workspace:root,model:'child-test'})
      const seen:ModelRequest[]=[]
      let step=0
      const executor=createChildAgentExecutor({
        dataDir:join(root,'child-sessions'),parentContext:async()=>parent,taskRepository:repository,
        model:{provider:'fixture',model:'child-test',async *stream(request){seen.push(request);const current=step++;if(current===0){yield {kind:'tool_call_complete' as const,callId:'unsafe-write',toolName:'write',arguments:{path:'user.md',content:'overwritten'}};yield {kind:'completed' as const,stopReason:'tool_calls' as const}}else if(current===1){yield {kind:'tool_call_complete' as const,callId:'safe-candidate',toolName:'propose_document',arguments:{path:'draft.md',target_path:'user.md',content:'# Reviewed candidate\n',idempotency_key:'candidate'}};yield {kind:'completed' as const,stopReason:'tool_calls' as const}}else{yield {kind:'assistant_text_delta' as const,text:'Completed the assigned review. A candidate is preserved for parent review; the original remains intact.'};yield {kind:'completed' as const,stopReason:'stop' as const}}}},
        toolHost:new LocalToolHost({registry:new CapabilityRegistry([{id:'builtin',kind:'built-in',enabled:true,available:true,tools:buildDefaultLocalTools()},...buildDocumentDeliveryToolProviders(repository)])}),prefix:createImmutablePrefix({systemPrompt:'Use authorized source tools and candidate output.'}),defaultModel:'child-test'
      })
      await executor({childId:'child_guarded',parentThreadId:'parent',parentTurnId:'parent_turn',prompt:'Review the supplied content and prepare the candidate with propose_document.',workspace:root,signal:new AbortController().signal})
      expect(await readFile(join(root,'user.md'),'utf8')).toBe('# User original\n')
      const names=seen[0]!.tools.map(tool=>tool.name)
      expect(names).toContain('read');expect(names).toContain('propose_document')
      expect(names).not.toContain('write');expect(names).not.toContain('edit');expect(names).not.toContain('bash')
      expect(JSON.stringify(seen[1]!.history)).toContain('child_candidate_only')
      const task=repository.list({threadId:'child_guarded'})[0]!
      expect(await readFile(join(root,'.workwise','delivery-candidates',task.id,'draft.md'),'utf8')).toBe('# Reviewed candidate\n')
      expect((await stat(join(root,'.workwise','task-staging','child_guarded'))).isDirectory()).toBe(true)
    } finally {repository.close();await rm(root,{recursive:true,force:true})}
  })

  it('runs a real child AgentLoop and returns assistant summary plus usage', async () => {
    const seen: ModelRequest[] = []
    const executor = createChildAgentExecutor({
      model: model([
        { kind: 'assistant_text_delta', text: 'child ' },
        { kind: 'assistant_text_delta', text: 'answer' },
        {
          kind: 'usage',
          usage: {
            promptTokens: 11,
            completionTokens: 3,
            totalTokens: 14,
            cacheHitTokens: 5,
            cacheMissTokens: 6,
            cacheHitRate: 5 / 11,
            cachedTokens: 5,
            turns: 1,
            costUsd: 0.001,
            cacheSavingsUsd: 0.0002
          }
        },
        { kind: 'completed', stopReason: 'stop' }
      ], seen),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    const result = await executor({
      childId: 'child_1',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      label: 'research',
      prompt: 'Research the issue',
      workspace: '/tmp/project',
      signal: new AbortController().signal
    })

    expect(result.summary).toBe('child answer')
    expect(result.usage).toMatchObject({
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
      cacheHitTokens: 5,
      cacheSavingsUsd: 0.0002,
      turns: 1
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      threadId: 'child_1',
      model: 'child-test',
      systemPrompt: expect.stringContaining('child system'),
      history: [
        expect.objectContaining({
          kind: 'user_message',
          text: expect.stringContaining('Research the issue')
        })
      ]
    })
    expect(seen[0]?.tools).toEqual([])
  })

  it('fails the child run when the child loop cannot produce a completed turn', async () => {
    const executor = createChildAgentExecutor({
      model: model([{ kind: 'error', message: 'model failed', code: 'bad_model' }]),
      toolHost: new LocalToolHost({ registry: new CapabilityRegistry([]) }),
      prefix: createImmutablePrefix({ systemPrompt: 'child system' }),
      defaultModel: 'child-test',
      nowIso: () => '2026-06-03T00:00:00.000Z'
    })

    await expect(executor({
      childId: 'child_fail',
      parentThreadId: 'thr_parent',
      parentTurnId: 'turn_parent',
      prompt: 'Fail',
      signal: new AbortController().signal
    })).rejects.toThrow(/child agent failed|model failed/i)
  })
})
