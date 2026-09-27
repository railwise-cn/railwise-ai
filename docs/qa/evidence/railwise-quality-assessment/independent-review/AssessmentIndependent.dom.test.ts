// @vitest-environment happy-dom
import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {webcrypto} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {assessmentFixture} from '../../../../../kun/src/engineering/survey-quality-assessment-test-helpers'
import {SurveyQualityAssessmentWorkspace} from './SurveyQualityAssessmentWorkspace'
import {checkAssessmentRecord,createAssessment,reverifyAssessment,saveAssessmentExport,readAssessment,listAssessments,type AssessmentBinding} from '../../agent/survey-quality-assessment-client'
import i18n from '../../i18n'
// DOM fixture isolates the PDF renderer; actual three-format generation is covered by Runtime cross-service tests.
vi.mock('../../../../../kun/src/engineering/engineering-report-pdf',()=>({makeReportPdf:async()=>Buffer.from('Synthetic DOM fixture PDF bytes')}))
let f:Awaited<ReturnType<typeof assessmentFixture>>,binding:AssessmentBinding,host:HTMLDivElement,root:Root
const runtimeRequest=vi.fn(),saveWorkspaceFileAs=vi.fn()
const response=(body:unknown)=>({ok:true,status:200,body:JSON.stringify(body)})
function handle(path:string,method='GET',raw?:string){f.advance();const u=new URL(path,'http://localhost'),[, , , ,pid,collection,id,action]=u.pathname.split('/'),offset=Number(u.searchParams.get('offset')??0)
 try{if(collection==='quality-assessment-plans'){return response(method==='POST'?f.assessment.createPlan(pid!,Buffer.from(raw!)):id?f.assessment.getPlan(pid!,id):f.assessment.list(pid!,'assessment_plans',10,offset))}
 if(collection==='quality-assessments'){return response(method==='POST'?id?f.assessment.reverifyAssessment(pid!,id):f.assessment.createAssessment(pid!,Buffer.from(raw!)):id?f.assessment.getAssessment(pid!,id):f.assessment.list(pid!,'assessments',10,offset))}
 if(collection==='quality-plans')return response(f.retention.listPlans(pid!,20,offset))
 if(collection==='quality-records')return response(f.retention.listRecords(pid!,20,offset))
 if(collection==='sampling-runs')return response(id&&action==='samples'?f.sampling.listSamples(pid!,id,50,offset):f.sampling.listRuns(pid!,20,offset))
 if(collection==='sampling-populations')return response(f.sampling.getPopulation(pid!,id!))
 if(collection==='quality-scoring')return response(f.scoring.listRecords(pid!,10,offset))
 throw new Error('unknown path')
 }catch(error){return {ok:false,status:409,body:JSON.stringify({code:(error as Error).message.replaceAll('-','_')})}}
}
function storedPlan(){return f.assessment.createPlan(f.project.id,Buffer.from(JSON.stringify(f.planRequest)))}
function storedRecord(veto=false){const plan=storedPlan();f.completeRetention();const score=f.score(f.unitIds[0]!,veto?d=>{const leaf=d.leaves[1]!;if(leaf.state==='checked'&&leaf.record.kind==='deduction')leaf.record.defects.b=4}:undefined);f.advance();return f.assessment.createAssessment(f.project.id,Buffer.from(JSON.stringify({schemaVersion:1,acknowledged:true,expectedProjectRevision:1,idempotencyKey:'desktop-assessment-key',assessmentPlanId:plan.id,expectedPlanHash:plan.planHash,unitScores:[{unitId:f.unitIds[0],scoringRecordId:score.id}]})))}
const button=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===label)!
const containsButton=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.includes(text))!
async function click(el:HTMLElement){expect(el).toBeDefined();await act(async()=>el.click())}
async function settled(){await act(async()=>{await new Promise(r=>setTimeout(r,0))})}
async function render(overrides:Partial<Parameters<typeof SurveyQualityAssessmentWorkspace>[0]>={}){await act(async()=>root.render(createElement(SurveyQualityAssessmentWorkspace,{binding,runtimeReady:true,manifests:[f.manifest],...overrides})))}
async function edit(label:string,value:string,index=0){const el=[...host.querySelectorAll('label')].filter(l=>l.firstChild?.textContent===label)[index]!.querySelector('input,select,textarea')!;await act(async()=>{const proto=el instanceof HTMLSelectElement?HTMLSelectElement.prototype:el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value')!.set!.call(el,value);el.dispatchEvent(new Event(el instanceof HTMLSelectElement?'change':'input',{bubbles:true}))})}
async function restore(kind:'plans'|'assessments',id:string){await click(button(kind==='plans'?'Saved plans':'Saved assessments'));await vi.waitFor(()=>expect(containsButton(id)).toBeDefined());await click(containsButton(id));await vi.waitFor(()=>expect(host.textContent).toContain(kind==='plans'?'Frozen linkage plan':'Original manifest status'))}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return{resolve,promise}}
beforeEach(async()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(crypto,'subtle',{configurable:true,value:webcrypto.subtle});await i18n.changeLanguage('en');f=await assessmentFixture();binding={projectId:f.project.id,projectRevision:1,workspaceRoot:f.project.workspace};runtimeRequest.mockReset().mockImplementation(handle);saveWorkspaceFileAs.mockReset().mockResolvedValue({ok:true,path:'/chosen/assessment.json'});Object.assign(window,{workwise:{runtimeRequest,saveWorkspaceFileAs}});host=document.createElement('div');document.body.append(host);root=createRoot(host)})
afterEach(async()=>{vi.unstubAllGlobals();await act(async()=>root.unmount());host.remove();await f.close();vi.restoreAllMocks()})

describe('independent assessment interface probes',()=>{
 it('clears a previously complete result when current source reverify fails',async()=>{
  const p=storedPlan();f.completeRetention();const scores=f.unitIds.map(unitId=>({unitId,scoringRecordId:f.score(unitId).id}));f.advance();const r=f.assessment.createAssessment(f.project.id,Buffer.from(JSON.stringify({schemaVersion:1,acknowledged:true,expectedProjectRevision:1,idempotencyKey:'independent-complete-ui',assessmentPlanId:p.id,expectedPlanHash:p.planHash,unitScores:scores})));await render();await restore('assessments',r.id);expect(host.textContent).toContain('Declared linkage complete (no engineering approval)');f.append('artifact-bytes');await click(button('Reverify linkage'));await vi.waitFor(()=>expect(host.querySelector('[role=alert]')).not.toBeNull());expect(button('Save freshly verified record as')).toBeUndefined();const result=host.querySelector('[aria-label="Linkage assessment result"]');expect(result).toBeNull()
 })
 it('does not retain a different frozen plan below an opened historical assessment',async()=>{
  const r=storedRecord();f.advance();const another=f.assessment.createPlan(f.project.id,Buffer.from(JSON.stringify({...f.planRequest,idempotencyKey:'another-plan-ui',basisStatement:'DISTINCT PLAN B CONTEXT'})));await render();await restore('plans',another.id);expect(host.textContent).toContain('DISTINCT PLAN B CONTEXT');await restore('assessments',r.id);expect(host.textContent).not.toContain('DISTINCT PLAN B CONTEXT')
 })
 it.each(['cancel','project'] as const)('late export after %s never invokes native save',async kind=>{
  const r=storedRecord();await render();await restore('assessments',r.id);const wait=deferred<ReturnType<typeof response>>();runtimeRequest.mockImplementationOnce(()=>wait.promise);await click(button('Save freshly verified record as'));if(kind==='cancel')await click(button('Cancel waiting'));else await render({binding:{...binding,projectId:'other-project'}});await act(async()=>wait.resolve(response(r)));await settled();expect(saveWorkspaceFileAs).not.toHaveBeenCalled();expect(host.textContent).not.toContain('Export saved.')
 })
 it('shows an original approved string as signature unverified without inventing an approval action',async()=>{
  const r=storedRecord();await render();await restore('assessments',r.id);expect(host.textContent).toContain('Pending review');expect(host.textContent).toContain('signatures are not verified');expect([...host.querySelectorAll('button')].some(b=>/^(Approve|Sign|批准|签字)$/.test(b.textContent??''))).toBe(false)
 })
 it('lists saved summaries with no source replay and labels saved-time scope in both languages',async()=>{
  storedRecord();for(const lng of ['en','zh']){await act(async()=>{await i18n.changeLanguage(lng)});await render();await click(button(lng==='en'?'Saved assessments':'已保存评估'));await vi.waitFor(()=>expect(host.textContent).toContain(lng==='en'?'dependencies are not replayed on this list':'此列表未重放依赖'));expect(button(lng==='en'?'Reverify linkage':'重新核验关联')).toBeUndefined()}
 })
 it('does not automatically choose a score after loading source records',async()=>{
  const p=storedPlan();f.unitIds.forEach(unitId=>f.score(unitId));f.advance();await render();await restore('plans',p.id);await click(button('Load existing unit scores'));await settled();const selects=[...host.querySelectorAll('select')];expect(selects).toHaveLength(3);expect(selects.every(s=>s.value==='')).toBe(true)
 })
 it('rejects response role substitution at the client detail boundary',async()=>{
  const p=storedPlan();runtimeRequest.mockResolvedValue(response(p));await expect(readAssessment(binding,'assessments',p.id,p.planHash)).rejects.toMatchObject({reason:'invalid-response'})
 })
 it('rejects duplicate response keys before displaying a valid record',async()=>{
  const p=storedPlan();runtimeRequest.mockResolvedValue({ok:true,status:200,body:JSON.stringify(p).replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1')});await expect(readAssessment(binding,'plans',p.id,p.planHash)).rejects.toMatchObject({reason:'invalid-response'})
 })
 it('blocks a list response from another project before history display',async()=>{
  storedRecord();const list=f.assessment.list(f.project.id,'assessments');list.records[0]!.projectId='foreign';runtimeRequest.mockResolvedValue(response(list));await expect(listAssessments(binding,'assessments')).rejects.toMatchObject({reason:'invalid-response'})
 })
})
