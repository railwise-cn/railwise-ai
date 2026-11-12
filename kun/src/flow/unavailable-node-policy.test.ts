import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { FlowDefinitionV1, FlowNodeV1 } from '../contracts/flow.js'
import { buildCoreFlowAdapters } from './core-adapters.js'
import { FlowExecutor } from './executor.js'
import { FlowRepository } from './repository.js'
import { buildFlowNodeRegistry } from './node-registry.js'
import { validateFlowDefinition } from './validator.js'

const types = ['publish','archive','subagent'] as const
const node = (type:string,errorBehavior:'fail'|'continue'|'error_edge'='fail'):FlowNodeV1 => ({id:'saved-node',type,label:'Saved node',position:{x:0,y:0},bindings:{},config:{saved:'user configuration'},
  policy:{timeoutMs:1000,retryAttempts:4,retryBackoffMs:0,errorBehavior,concurrencyLimit:1,resumable:true,breakpoint:false},disabled:false})
const definitionFor = (type:string):FlowDefinitionV1 => ({schemaVersion:1,id:'saved-flow',name:'Saved Flow',description:'',revision:1,
  nodes:[node(type)],edges:[],variables:{},createdAt:'2026-11-10T00:00:00.000Z',updatedAt:'2026-11-10T00:00:00.000Z'})

describe('unimplemented Flow nodes remain readable without claiming execution',()=>{
  it('marks missing production implementations unavailable even when a flag claims support',()=>{
    const registry = buildFlowNodeRegistry({publish:{available:true},archive:{available:true},subagents:{available:true}})
    for (const type of types) expect(registry.find(entry=>entry.type===type)).toMatchObject({available:false,disabledReason:expect.any(String),configurationRoute:type==='archive'?'write':'tasks'})
    expect(registry.find(entry=>entry.type==='railwise.task_delivery')).toMatchObject({available:true})
    expect(registry.find(entry=>entry.type==='agent')).toMatchObject({available:true})
    const graph=definitionFor('publish')
    expect(validateFlowDefinition(graph,registry).issues.map(issue=>issue.code)).toContain('capability_unavailable')
  })

  it.each(types)('rejects direct %s adapters and node tests without dispatching an override',async type=>{
    const root=await mkdtemp(join(tmpdir(),'railwise-flow-unavailable-test-'))
    const repository=new FlowRepository(join(root,'flow.sqlite'))
    const definition=definitionFor(type)
    const override=vi.fn(async()=>({kind:'output' as const,output:{claimed:'done'}}))
    try{
      const adapter=buildCoreFlowAdapters().get(type)!
      await expect(adapter({run:{} as never,definition,node:definition.nodes[0],input:{},signal:new AbortController().signal})).rejects.toMatchObject({code:'flow_node_unavailable'})
      await expect(new FlowExecutor(repository,new Map([[type,override]])).testNode(definition,'saved-node',{})).rejects.toMatchObject({code:'flow_node_unavailable'})
      expect(override).not.toHaveBeenCalled()
    }finally{repository.close();await rm(root,{recursive:true,force:true})}
  })

  it.each(types.flatMap(type=>(['fail','continue','error_edge'] as const).map(errorBehavior=>({type,errorBehavior}))))('blocks a published $type node once under $errorBehavior without changing saved data',async({type,errorBehavior})=>{
    const root=await mkdtemp(join(tmpdir(),'railwise-flow-unavailable-run-'))
    const repository=new FlowRepository(join(root,'flow.sqlite'))
    const original=node(type,errorBehavior)
    const graph={schemaVersion:1 as const,id:'saved-flow',name:'Saved Flow',description:'',nodes:[original],edges:[],variables:{userContent:true}}
    const override=vi.fn(async()=>({kind:'output' as const,output:{claimed:'done'}}))
    try{
      repository.create(graph);const version=repository.publish(graph.id)
      const schedule={flowId:graph.id,nodeId:'existing-schedule',enabled:true,nextRunAt:'2026-11-12T00:00:00.000Z',state:{preserved:true}}
      repository.saveTriggerState(schedule)
      const started=await new FlowExecutor(repository,new Map([[type,override]])).start(graph.id,{saved:'input'})
      await vi.waitFor(()=>expect(repository.getRun(started.id)?.status).toBe('failed'))
      expect(repository.getRun(started.id)?.output).toMatchObject({code:'flow_node_unavailable',resolution:expect.any(String)})
      expect(repository.listNodeRuns(started.id)).toMatchObject([{nodeId:'saved-node',status:'failed',attempt:1,output:{code:'flow_node_unavailable'}}])
      expect(override).not.toHaveBeenCalled()
      expect(repository.get(graph.id)?.nodes).toEqual([original])
      expect(repository.getVersion(version.id)?.definition.nodes).toEqual([original])
      expect(repository.getRun(started.id)?.input).toEqual({saved:'input'})
      expect(repository.getTriggerState(graph.id,schedule.nodeId)).toEqual(schedule)
    }finally{repository.close();await rm(root,{recursive:true,force:true})}
  })
})
