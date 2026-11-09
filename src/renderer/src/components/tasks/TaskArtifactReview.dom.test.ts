// @vitest-environment happy-dom
import {act,createElement} from 'react'
import {createRoot} from 'react-dom/client'
import {it,expect,vi} from 'vitest'
import type {TaskRunV1,TaskArtifactV1} from '@shared/agent-workbench'
import i18n from '../../i18n'
import {TaskArtifactReview} from './TaskArtifactReview'

it('regenerates only affected sections through the original scoped execution context',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true})
 await i18n.changeLanguage('en')
 const revision={fingerprint:'candidate-hash',sizeBytes:20,mtimeMs:1}
 const readDocumentCandidate=vi.fn(async()=>({path:'/workspace/.workwise/delivery-candidates/task/draft.md',content:'# Findings\nOld',candidateRevision:revision,status:'pending',sourcesStale:true,sources:[{path:'data.csv',stale:true}],affectedSections:[{id:'findings',heading:'Findings',level:1,startLine:1,endLine:6,sourcePaths:['data.csv']},{id:'nested',heading:'Nested detail',level:2,startLine:3,endLine:6,sourcePaths:['data.csv']}]}))
 const coordinateTaskCommand=vi.fn(async(_request:unknown)=>({kind:'input_queued'}))
 Object.defineProperty(window,'workwise',{configurable:true,value:{readDocumentCandidate,coordinateTaskCommand}})
 const container=document.createElement('div');document.body.append(container);const root=createRoot(container)
 const task={id:'task',threadId:'hidden-execution',originThreadId:'generic-chat',workspaceRoot:'/workspace',status:'completed',model:'deepseek-flash'} as unknown as TaskRunV1
 const artifact={relativePath:'.workwise/delivery-candidates/task/draft.md'} as TaskArtifactV1
 try{
  await act(async()=>root.render(createElement(TaskArtifactReview,{task,artifact,onOpen:vi.fn()})))
  await act(async()=>container.querySelector('button')!.click())
  expect(container.textContent).toContain('Findings')
  const button=[...container.querySelectorAll('button')].find(button=>button.textContent?.includes('Regenerate'))!
  expect(button).toBeTruthy()
  await act(async()=>button.click())
  expect(coordinateTaskCommand).toHaveBeenCalledWith(expect.objectContaining({threadId:'hidden-execution',taskId:'task',intent:'new',idempotencyKey:expect.any(String),request:expect.objectContaining({model:'deepseek-flash',prompt:expect.stringContaining('section_patches')})}))
  const request=coordinateTaskCommand.mock.calls[0][0] as unknown as {request:{prompt:string}}
  expect(request.request.prompt).toContain('candidate-hash')
  expect(request.request.prompt).toContain('data.csv')
  expect(request.request.prompt).toContain('["findings"]')
  expect(request.request.prompt).not.toContain('"nested"')
 }finally{
  await act(async()=>root.unmount());container.remove();Reflect.deleteProperty(window,'workwise')
 }
})
