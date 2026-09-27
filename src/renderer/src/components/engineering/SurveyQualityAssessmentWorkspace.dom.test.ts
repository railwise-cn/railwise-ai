// @vitest-environment happy-dom
import {act,createElement} from 'react'
import {createRoot,type Root} from 'react-dom/client'
import {webcrypto} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest'
import {assessmentFixture} from '../../../../../kun/src/engineering/survey-quality-assessment-test-helpers'
import {SurveyQualityAssessmentWorkspace} from './SurveyQualityAssessmentWorkspace'
import {checkAssessmentRecord,createAssessment,readAssessment,reverifyAssessment,saveAssessmentExport,type AssessmentBinding} from '../../agent/survey-quality-assessment-client'
import i18n from '../../i18n'
import {EngineeringEvidenceQuestions} from './EngineeringEvidenceQuestion'
import {useEngineeringConversationDrafts} from './engineering-conversation-drafts'
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
describe('declared linkage desktop integration',()=>{
 it('binds a unit question to the restored assessment and disables it during revalidation',async()=>{
  const record=storedRecord(),focus=vi.fn()
  useEngineeringConversationDrafts.setState({drafts:{}})
  await act(async()=>root.render(createElement(EngineeringEvidenceQuestions,{scope:{workspace:binding.workspaceRoot,projectId:binding.projectId,projectRevision:binding.projectRevision,ready:true,focus},children:createElement(SurveyQualityAssessmentWorkspace,{binding,runtimeReady:true,manifests:[f.manifest]})})))
  await restore('assessments',record.id)
  const question=()=>host.querySelector(`button[aria-label="${i18n.t('surveyAskEvidence',{ns:'common',label:record.result.unitRows[0]!.unitId})}"]`) as HTMLButtonElement
  runtimeRequest.mockClear();await click(question());expect(runtimeRequest).not.toHaveBeenCalled();expect(focus).toHaveBeenCalledOnce()
  expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify([binding.workspaceRoot,binding.projectId])]?.evidenceContext?.typedEvidence).toEqual({schemaVersion:1,projectId:binding.projectId,projectRevision:binding.projectRevision,kind:'assessment',recordId:record.id,recordHash:record.recordHash,selector:{path:['result','unitRows',0],identity:{unitId:record.result.unitRows[0]!.unitId}}})
  const wait=deferred<ReturnType<typeof response>>();runtimeRequest.mockImplementationOnce(()=>wait.promise);await click(button('Reverify linkage'));expect(question().disabled).toBe(true);await click(question());expect(focus).toHaveBeenCalledOnce()
  await act(async()=>wait.resolve(response({record,checkedAt:'2026-09-20T00:00:00Z'})));await settled()
 })
 it('has complete bilingual controls and state strings',()=>{const source=readFileSync(join(process.cwd(),'src/renderer/src/components/engineering/SurveyQualityAssessmentWorkspace.tsx'),'utf8');for(const [,key]of source.matchAll(/\bt\('([^']+)'/g))for(const lng of ['en','zh'])expect(i18n.exists(key!,{ns:'qualityAssessment',lng}),`${lng}:${key}`).toBe(true)})
 it('freezes an actual complete run with explicit mappings using real source APIs',async()=>{
  await render();await edit('Actual deliverable manifest',f.manifest.id);await click(button('Load retention plans for this deliverable'));await edit('Material retention plan',f.planRequest.retentionPlanId);await settled();await edit('Retention record of this plan',f.planRequest.retentionRecordId);await click(button('Load existing sampling runs'));await edit('Complete first-round sampling run',f.planRequest.samplingRunId);await vi.waitFor(()=>expect(host.textContent).toContain('All 3 selected units'))
  await edit('Association basis (exact text retained)','Explicit synthetic basis 😀')
  for(let i=0;i<3;i++){await edit('Exact evidence reference in scoring record','synthetic',i);await edit('Fixed material requirement in retention plan','evidence:support',i);await edit('Material location and unit association',`Synthetic unit ${i}`,i)}
  await click(host.querySelector('input[type=checkbox]')!);expect(button('Freeze complete linkage plan').disabled).toBe(false);await click(button('Freeze complete linkage plan'));await vi.waitFor(()=>expect(host.textContent).toContain('Frozen linkage plan'))
  expect(f.assessment.list(f.project.id,'assessment_plans').records).toHaveLength(1)
  expect(runtimeRequest.mock.calls.filter(([p,m])=>m==='POST'&&(p as string).endsWith('quality-assessment-plans'))).toHaveLength(1)
  expect(runtimeRequest.mock.calls.filter(([p,m])=>m!=='POST'&&/quality-assessment-plans\//.test(p as string))).toHaveLength(0)
  expect([...host.querySelectorAll('select')].every(s=>s.value==='')).toBe(true)
 })
 it.each(['en','zh'])('shows veto and missing coverage simultaneously with pending draft in %s',async lng=>{
  const r=storedRecord(true);await render();await restore('assessments',r.id);await act(async()=>{await i18n.changeLanguage(lng)})
  const text=host.textContent!;expect(text).toContain(lng==='en'?'Contains declared nonconforming results':'包含已声明不合格结果');expect(text).toContain(lng==='en'?'Unit results missing, partial or unavailable':'单位结果缺失、部分或不可用');expect(text).toContain(lng==='en'?'Pending review':'待审查');expect(text).not.toContain(lng==='en'?'Declared linkage complete (':'声明关联齐全（')
  expect([...host.querySelectorAll('button')].some(b=>/^(Approve|批准|签字|Sign)$/.test(b.textContent??''))).toBe(false)
 })
 it('restores immutable plan and saves missing scores with one POST and no extra GET',async()=>{
  const p=storedPlan();await render();await restore('plans',p.id);runtimeRequest.mockClear();await click(button('Save declared linkage assessment'));await vi.waitFor(()=>expect(host.textContent).toContain('Original manifest status'))
  expect(runtimeRequest).toHaveBeenCalledTimes(1);expect(runtimeRequest.mock.calls[0]![1]).toBe('POST');expect(host.textContent).toContain('Unit results missing, partial or unavailable')
  runtimeRequest.mockClear();await click(button('Reverify linkage'));await settled();expect(runtimeRequest).toHaveBeenCalledTimes(1);expect(runtimeRequest.mock.calls[0]![0]).toMatch(/\/reverify$/)
 })
 it.each(['project','revision','workspace','offline','cancel'] as const)('ignores late assessment creation after %s',async kind=>{
  const p=storedPlan();await render();await restore('plans',p.id);const wait=deferred<ReturnType<typeof response>>();let saved!:ReturnType<typeof response>;runtimeRequest.mockImplementationOnce((path,method,raw)=>{saved=handle(path,method,raw);return wait.promise});runtimeRequest.mockClear();await click(button('Save declared linkage assessment'))
  if(kind==='cancel')await click(button('Cancel waiting'));else await render(kind==='offline'?{runtimeReady:false}:{binding:{...binding,...(kind==='project'?{projectId:'other'}:kind==='revision'?{projectRevision:2}:{workspaceRoot:'/other'})}})
  await act(async()=>wait.resolve(saved));await settled();expect(runtimeRequest).toHaveBeenCalledTimes(1);expect(button('Reverify linkage')).toBeUndefined()
 })
 it('retries exact original request bytes after an uncertain save',async()=>{
  const p=storedPlan();await render();await restore('plans',p.id);runtimeRequest.mockClear();runtimeRequest.mockImplementationOnce((path,method,raw)=>{handle(path,method,raw);throw new Error('lost response')});await click(button('Save declared linkage assessment'));const first=runtimeRequest.mock.calls[0]![2];await click(button('Retry original request'));await vi.waitFor(()=>expect(button('Reverify linkage')).toBeDefined());expect(runtimeRequest.mock.calls[1]![2]).toBe(first);expect(f.assessment.list(f.project.id,'assessments').records).toHaveLength(1)
 })
 it('performs fresh export and labels native cancellation without success',async()=>{
  const r=storedRecord();await render();await restore('assessments',r.id);runtimeRequest.mockClear();saveWorkspaceFileAs.mockResolvedValueOnce({ok:false,canceled:true});await click(button('Save freshly verified record as'));await vi.waitFor(()=>expect(host.textContent).toContain('Export cancelled; no file saved.'));expect(runtimeRequest).toHaveBeenCalledTimes(1);expect(runtimeRequest.mock.calls[0]![0]).toMatch(/\/export$/);expect(saveWorkspaceFileAs).toHaveBeenCalledTimes(1)
  await click(button('Save freshly verified record as'));await vi.waitFor(()=>expect(host.textContent).toContain('Export saved.'));const payload=saveWorkspaceFileAs.mock.calls[1]![0];expect(JSON.parse(Buffer.from(payload.dataBase64,'base64').toString())).toEqual(r)
 })
 it('checks real records and export without browser Buffer, rejecting wrong workspace and changed hashes',async()=>{
  const r=storedRecord(),p=storedPlan();runtimeRequest.mockResolvedValue(response(r));vi.stubGlobal('Buffer',undefined)
  expect(await checkAssessmentRecord(r,binding)).toEqual(r);await expect(checkAssessmentRecord({...r,resultHash:'0'.repeat(64)},binding)).rejects.toMatchObject({reason:'invalid-response'});await expect(checkAssessmentRecord(r,{...binding,workspaceRoot:'/other'})).rejects.toMatchObject({reason:'invalid-response'})
  runtimeRequest.mockResolvedValueOnce(response({...r,requestJson:r.requestJson}));await expect(createAssessment(binding,p,[],'different-key')).rejects.toMatchObject({reason:'invalid-response'})
  runtimeRequest.mockResolvedValueOnce(response({record:r,checkedAt:'2026-09-20T00:00:00Z'}));expect(await reverifyAssessment(binding,r)).toEqual(r)
  expect(await saveAssessmentExport(binding,r,()=>true)).toMatchObject({ok:true});await expect(saveAssessmentExport(binding,r,()=>false)).rejects.toMatchObject({reason:'stale'});expect(saveWorkspaceFileAs).toHaveBeenCalledTimes(1)
 })
 it('clears previous verified detail and export after sources change',async()=>{
  const r=storedRecord();await render();await restore('assessments',r.id);f.append('artifact-bytes')
  await click(button('Reverify linkage'));await vi.waitFor(()=>expect(host.querySelector('[role=alert]')).not.toBeNull())
  expect(button('Save freshly verified record as')).toBeUndefined();expect(host.textContent).not.toContain('Original manifest status')
 })
 it('does not leave a different frozen plan below a restored assessment',async()=>{
  const r=storedRecord(),other=f.assessment.createPlan(f.project.id,Buffer.from(JSON.stringify({...f.planRequest,idempotencyKey:'different-plan-key',basisStatement:'OTHER PLAN BASIS'})))
  await render();await restore('plans',other.id);expect(host.textContent).toContain('OTHER PLAN BASIS');await restore('assessments',r.id)
  expect(host.textContent).not.toContain('OTHER PLAN BASIS');expect(button('Save declared linkage assessment')).toBeUndefined();expect(button('Freeze complete linkage plan')).toBeUndefined()
 })
 it('rejects swapped plan and assessment response roles',async()=>{
  const r=storedRecord(),p=storedPlan();runtimeRequest.mockResolvedValueOnce(response(p));await expect(readAssessment(binding,'assessments',p.id)).rejects.toMatchObject({reason:'invalid-response'})
  runtimeRequest.mockResolvedValueOnce(response(r));await expect(readAssessment(binding,'plans',r.id)).rejects.toMatchObject({reason:'invalid-response'})
 })
})
