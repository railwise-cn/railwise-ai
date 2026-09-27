import {useEffect,useRef,useState,type ReactElement} from 'react'
import {useTranslation} from 'react-i18next'
import {EngineeringEvidenceQuestion,EngineeringSelectedEvidence} from './EngineeringEvidenceQuestion'
import {SurveyQualityAssessmentPlanCreateV1} from '@shared/survey-quality-assessment'
import {listQualityPlans,listQualityRecords,type QualityPlan,type QualityRecordSummary} from '../../agent/survey-quality-client'
import {listSamplingRuns,readSamplingSamples,type SamplingRun} from '../../agent/survey-quality-sampling-client'
import {listQualityScorings,type QualityScoringSummary} from '../../agent/survey-quality-scoring-client'
import {createAssessmentPlan,createAssessment,readAssessment,reverifyAssessment,listAssessments,assessmentPopulation,saveAssessmentExport,
 type AssessmentBinding,type AssessmentPlan,type AssessmentPlanInput,type AssessmentRecord,type AssessmentHistory} from '../../agent/survey-quality-assessment-client'
const button='min-h-9 rounded border border-ds-border px-3 py-2 text-left disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
const input='block w-full min-w-0 rounded border border-ds-border bg-ds-card px-2 py-2 text-ds-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent'
type Manifest={id:string;reviewStatus:string;outputs:Array<{path:string;sha256:string;sizeBytes:number;mediaType:string}>}
type Props={binding:AssessmentBinding;runtimeReady:boolean;manifests:Manifest[]}
export function SurveyQualityAssessmentWorkspace(props:Props):ReactElement{
 const scope=JSON.stringify([props.binding.projectId,props.binding.projectRevision,props.binding.workspaceRoot,props.runtimeReady,props.manifests.map(m=>m.id)])
 return <AssessmentSession key={scope} {...props}/>
}
function AssessmentSession({binding,runtimeReady,manifests}:Props):ReactElement{
 const {t}=useTranslation('qualityAssessment')
 const [manifestId,setManifest]=useState(''),[retentionPlans,setRetentionPlans]=useState<QualityPlan[]>([]),[retentionRecords,setRetentionRecords]=useState<QualityRecordSummary[]>([])
 const [retentionPlan,setRetentionPlan]=useState<QualityPlan|null>(null),[retentionRecordId,setRetentionRecord]=useState(''),[runs,setRuns]=useState<SamplingRun[]>([]),[run,setRun]=useState<SamplingRun|null>(null)
 const [definition,setDefinition]=useState(''),[unitMaterials,setMaterials]=useState<AssessmentPlanInput['unitMaterials']>([]),[profile,setProfile]=useState<AssessmentPlanInput['productProfileId']>('planar-control-point')
 const [basis,setBasis]=useState(''),[ack,setAck]=useState(false),[plan,setPlan]=useState<AssessmentPlan|null>(null),[record,setRecord]=useState<AssessmentRecord|null>(null)
 const [scores,setScores]=useState<QualityScoringSummary[]>([]),[selections,setSelections]=useState<Record<string,string>>({}),[page,setPage]=useState<{kind:'plans'|'assessments';data:AssessmentHistory}|null>(null)
 const [next,setNext]=useState<{plans:number|null;records:number|null;runs:number|null;scores:number|null}>({plans:null,records:null,runs:null,scores:null})
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
 const generation=useRef(0),alive=useRef(true),flight=useRef(false),retry=useRef<null|((current:()=>boolean)=>Promise<void>)>(null)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const ready=runtimeReady&&!busy
 const manifest=manifests.find(m=>m.id===manifestId)
 const qualityBinding=manifest?{projectId:binding.projectId,projectRevision:binding.projectRevision,manifestId,outputs:manifest.outputs}:null
 function invalidate(){generation.current++;flight.current=false;setBusy(false);setError('');setNotice('');retry.current=null;setAck(false)}
 async function execute(action:(current:()=>boolean)=>Promise<void>){
  if(!runtimeReady||flight.current)return
  const token=++generation.current,current=()=>alive.current&&token===generation.current
  flight.current=true;retry.current=action;setBusy(true);setError('');setNotice('')
  try{await action(current);if(current())retry.current=null}catch(cause){if(current()){setRecord(null);setError(cause instanceof Error?cause.message:'request-failed')}}
  finally{if(current()){flight.current=false;setBusy(false)}}
 }
 function sourceWarning(count:number){if(count)setNotice(t('unavailableRows',{count}))}
 function loadPlans(offset=0){if(!qualityBinding)return;void execute(async current=>{const data=await listQualityPlans(qualityBinding,offset);if(current()){setRetentionPlans(old=>offset?[...old,...data.plans]:data.plans);setNext(old=>({...old,plans:data.nextOffset}));sourceWarning(data.unavailable.length)}})}
 function loadRecords(p:QualityPlan,offset=0){if(!qualityBinding)return;void execute(async current=>{const data=await listQualityRecords(qualityBinding,p,offset);if(current()){setRetentionRecords(old=>offset?[...old,...data.records]:data.records);setNext(old=>({...old,records:data.nextOffset}));sourceWarning(data.unavailable.length)}})}
 function loadRuns(offset=0){void execute(async current=>{const data=await listSamplingRuns(binding,offset);if(current()){setRuns(old=>offset?[...old,...data.items]:data.items);setNext(old=>({...old,runs:data.nextOffset}));sourceWarning(data.unavailable.length)}})}
 function selectRun(id:string){invalidate();setRun(null);setMaterials([]);setDefinition('');const selected=runs.find(r=>r.id===id);if(!selected)return
  void execute(async current=>{if(selected.sampleSize>8)throw new Error('unsupported-scope');const units=await readSamplingSamples(binding,selected);if(!current())return
   if(units.total!==selected.sampleSize||units.ids.length!==units.total||units.nextOffset!==null||units.ids.some(u=>u.length>160))throw new Error('unsupported-scope')
   const population=await assessmentPopulation(binding,selected.populationId);if(current()){setRun(selected);setDefinition(population.definitionStatement);setMaterials(units.ids.map(unitId=>({unitId,requirements:[{reference:'',retentionCheckId:'',memberId:'',locatorStatement:''}]})))}})
 }
 function loadScores(offset=0){void execute(async current=>{const data=await listQualityScorings(binding,offset);if(current()){setScores(old=>offset?[...old,...data.records.filter(s=>s.kind==='unit')]:data.records.filter(s=>s.kind==='unit'));setNext(old=>({...old,scores:data.nextOffset}));sourceWarning(data.unavailable.length)}})}
 const candidate:AssessmentPlanInput={retentionPlanId:retentionPlan?.plan.id??'',retentionRecordId,samplingRunId:run?.id??'',productProfileId:profile,basisStatement:basis,unitMaterials}
 const valid=SurveyQualityAssessmentPlanCreateV1.safeParse({...candidate,schemaVersion:1,acknowledged:true,expectedProjectRevision:binding.projectRevision,idempotencyKey:'validation-only'}).success
 function freeze(){if(!valid||!ack)return;const saved=structuredClone(candidate),key=crypto.randomUUID();void execute(async current=>{const value=await createAssessmentPlan(binding,saved,key);if(current()){setPlan(value);setRecord(null);setSelections({});setAck(false)}})}
 function assess(){if(!plan)return;const selected=plan.snapshot.selectedUnitIds.flatMap(unitId=>selections[unitId]?[{unitId,scoringRecordId:selections[unitId]!}]:[]),key=crypto.randomUUID();void execute(async current=>{const value=await createAssessment(binding,plan,selected,key);if(current())setRecord(value)})}
 function history(kind:'plans'|'assessments',offset=0){void execute(async current=>{const data=await listAssessments(binding,kind,offset);if(current())setPage({kind,data})})}
 function open(kind:'plans'|'assessments',id:string,hash:string){void execute(async current=>{const value=await readAssessment(binding,kind,id,hash);if(current()){if('snapshot'in value){setPlan(value);setSelections({});setRecord(null)}else{setPlan(null);setSelections({});setRecord(value)}}})}
 function editMapping(unitIndex:number,index:number,patch:Partial<AssessmentPlanInput['unitMaterials'][number]['requirements'][number]>){setAck(false);setMaterials(old=>old.map((u,i)=>i===unitIndex?{...u,requirements:u.requirements.map((r,j)=>j===index?{...r,...patch}:r)}:u))}
 return <section className="mt-5 min-w-0 space-y-4 border border-ds-border-muted bg-ds-card p-4 text-[12px] text-ds-ink" aria-label={t('title')}>
  <h3 className="text-[14px] font-semibold">{t('title')}</h3><p className="leading-5 text-ds-muted">{t('boundary')}</p>
  <p>{t('scopeLimit')}</p>{!runtimeReady&&<p role="status">{t('offline')}</p>}
  <div className="flex flex-wrap gap-2"><button className={button} disabled={!ready} onClick={()=>history('plans')}>{t('savedPlans')}</button><button className={button} disabled={!ready} onClick={()=>history('assessments')}>{t('savedAssessments')}</button>
   <button className={button} disabled={!ready} onClick={()=>{invalidate();setPlan(null);setRecord(null);setSelections({});setPage(null)}}>{t('newPlan')}</button>
   {busy&&<button className={button} onClick={()=>{generation.current++;flight.current=false;setBusy(false);setNotice(t('cancelled'))}}>{t('cancel')}</button>}
   {error&&retry.current&&<button className={button} disabled={!ready} onClick={()=>{if(retry.current)void execute(retry.current)}}>{t('retry')}</button>}
  </div>
  {error&&<p role="alert" className="break-words text-red-700 dark:text-red-300">{t(`errors.${error}`,{defaultValue:t('errors.request-failed')})}</p>}{notice&&<p role="status">{notice}</p>}
  {record&&<EngineeringSelectedEvidence reference={{kind:'assessment',recordId:record.id,recordHash:record.recordHash}}><div className="space-y-3" aria-label={t('result')}>
   <h4 className="font-semibold">{t('result')}<EngineeringEvidenceQuestion label={t('result')} disabled={!ready}/></h4>
   <div className="grid gap-3 sm:grid-cols-3">{[['materials','retentionCoverage'],['unitCoverage','scoreCoverage'],['declaredVeto','declaredResultSummary']].map(([label,key])=><div key={label} className="border border-ds-border-muted p-3"><p className="font-semibold">{t(label!)}<EngineeringEvidenceQuestion label={t(label!)} selector={{path:['result',key!]}} disabled={!ready}/></p><p className="mt-2 leading-5">{t(`states.${record.result[key as 'retentionCoverage'|'scoreCoverage'|'declaredResultSummary']}`)}</p></div>)}</div>
   <p>{t('originalManifest')}: {t(`manifest.${record.manifestReviewStatus}`)} · {t(`states.${record.result.overallLinkage}`)}</p>
   <p>{t('counts',{...record.result.counts})}</p><p className="break-all font-mono text-[10px]">{record.id}</p>
   {record.result.unitRows.map((row,index)=><div key={row.unitId} className="space-y-2 border-t border-ds-border-muted pt-3"><p className="break-all font-semibold">{row.unitId}<EngineeringEvidenceQuestion label={row.unitId} selector={{path:['result','unitRows',index],identity:{unitId:row.unitId}}} disabled={!ready}/></p><p>{row.score?`${t(`scope.${row.score.scopeAssessment}`)} · ${t(`outcome.${row.score.result.state}`)}`:t('missingScore')}{row.score?.result.score&&` · ${row.score.result.score.numerator}/${row.score.result.score.denominator}`}</p>
    {row.score&&<p className="break-all text-ds-muted">{t('existingAssociation')} · {row.score.recordId} · {t(`qualityScoring:reasons.${row.score.result.reason}`,{defaultValue:row.score.result.reason})}</p>}
    {row.materials.map((m,materialIndex)=><p key={m.reference} className="break-words">{m.reference} → {m.memberId} · {t(`material.${m.status}`)} · {m.locatorStatement}<EngineeringEvidenceQuestion label={`${row.unitId} · ${m.reference}`} selector={{path:['result','unitRows',index,'materials',materialIndex],identity:{reference:m.reference,memberId:m.memberId}}} disabled={!ready}/></p>)}
    {row.references.filter(r=>!r.resolved).map(r=><p key={r.reference} className="break-words text-amber-700 dark:text-amber-300">{t('unresolvedReference')}: {r.reference}</p>)}
   </div>)}
   <div className="flex flex-wrap gap-2"><button className={button} disabled={!ready} onClick={()=>void execute(async current=>{const value=await reverifyAssessment(binding,record);if(current())setRecord(value)})}>{t('reverify')}</button>
    <button className={button} disabled={!ready} onClick={()=>void execute(async current=>{const result=await saveAssessmentExport(binding,record,current);if(current())setNotice(t(result.ok?'exportSaved':result.canceled?'exportCancelled':'exportFailed'))})}>{t('export')}</button></div>
  </div></EngineeringSelectedEvidence>}
  {plan?<EngineeringSelectedEvidence reference={{kind:'assessment-plan',planId:plan.id,planHash:plan.planHash}}><div className="space-y-3"><h4 className="font-semibold">{t('frozenPlan')}<EngineeringEvidenceQuestion label={t('frozenPlan')} disabled={!ready}/></h4><p className="break-all">{plan.id}</p><p>{t(`profiles.${plan.snapshot.profile.profileId}`)} · {t(`stages.${plan.snapshot.run.stage}`)} · {t(`modes.${plan.snapshot.run.inspectionMode}`)}</p><p className="whitespace-pre-wrap break-words">{plan.snapshot.population.definitionStatement}</p><p className="whitespace-pre-wrap break-words">{plan.request.basisStatement}</p>
   <p>{t('scoreSelectionHint')}</p><button className={button} disabled={!ready} onClick={()=>loadScores()}>{t('loadScores')}</button>{next.scores!==null&&<button className={button} disabled={!ready} onClick={()=>loadScores(next.scores!)}>{t('more')}</button>}
   {plan.request.unitMaterials.map((unit,index)=><div key={unit.unitId} className="space-y-2 border border-ds-border-muted p-3"><p className="break-all font-semibold">{unit.unitId}<EngineeringEvidenceQuestion label={unit.unitId} selector={{path:['request','unitMaterials',index],identity:{unitId:unit.unitId}}} disabled={!ready}/></p>{unit.requirements.map((r,requirementIndex)=><p className="break-words" key={r.reference}>{r.reference} → {r.retentionCheckId} / {r.memberId} · {r.locatorStatement}<EngineeringEvidenceQuestion label={`${unit.unitId} · ${r.reference}`} selector={{path:['request','unitMaterials',index,'requirements',requirementIndex],identity:{reference:r.reference,retentionCheckId:r.retentionCheckId,memberId:r.memberId}}} disabled={!ready}/></p>)}
    <label>{t('unitScore',{unit:unit.unitId})}<select className={input} disabled={!ready} value={selections[unit.unitId]??''} onChange={e=>setSelections(old=>({...old,[unit.unitId]:e.target.value}))}><option value="">{t('missingScore')}</option>{scores.map(s=><option key={s.id} value={s.id}>{s.id} · {s.createdAt} · {t(`outcome.${s.outcome}`)}</option>)}</select></label></div>)}
   <button className={button} disabled={!ready} onClick={assess}>{t('assess')}</button>
  </div></EngineeringSelectedEvidence>:record?null:<fieldset disabled={!ready} className="min-w-0 space-y-3">
   <label>{t('manifestSelect')}<select className={input} value={manifestId} onChange={e=>{invalidate();setManifest(e.target.value);setRetentionPlans([]);setRetentionRecords([]);setRetentionPlan(null);setRetentionRecord('')}}><option value="">{t('choose')}</option>{manifests.map(m=><option key={m.id} value={m.id}>{m.id} · {t(`manifest.${m.reviewStatus}`)}</option>)}</select></label>
   <button className={button} disabled={!qualityBinding} onClick={()=>loadPlans()}>{t('loadRetention')}</button>{next.plans!==null&&<button className={button} onClick={()=>loadPlans(next.plans!)}>{t('more')}</button>}
   <label>{t('retentionPlan')}<select className={input} value={retentionPlan?.plan.id??''} onChange={e=>{invalidate();const p=retentionPlans.find(p=>p.plan.id===e.target.value)??null;setRetentionPlan(p);setRetentionRecord('');setRetentionRecords([]);setMaterials(old=>old.map(u=>({...u,requirements:[{reference:'',memberId:'',retentionCheckId:'',locatorStatement:''}]})));if(p)loadRecords(p)}}><option value="">{t('choose')}</option>{retentionPlans.map(p=><option key={p.plan.id} value={p.plan.id}>{p.plan.id}</option>)}</select></label>
   <label>{t('retentionRecord')}<select className={input} value={retentionRecordId} onChange={e=>{setAck(false);setRetentionRecord(e.target.value)}}><option value="">{t('choose')}</option>{retentionRecords.map(r=><option key={r.record.id} value={r.record.id}>{r.record.id}</option>)}</select></label>{next.records!==null&&retentionPlan&&<button className={button} onClick={()=>loadRecords(retentionPlan,next.records!)}>{t('more')}</button>}
   <button className={button} onClick={()=>loadRuns()}>{t('loadRuns')}</button>{next.runs!==null&&<button className={button} onClick={()=>loadRuns(next.runs!)}>{t('more')}</button>}
   <label>{t('samplingRun')}<select className={input} value={run?.id??''} onChange={e=>selectRun(e.target.value)}><option value="">{t('choose')}</option>{runs.map(r=><option key={r.id} value={r.id}>{r.id} · {t(`stages.${r.stage}`)} · {r.sampleSize}</option>)}</select></label>
   {run&&<p>{t(`stages.${run.stage}`)} · {t(`modes.${run.inspectionMode}`)} · {t('selectedCount',{count:run.sampleSize})}</p>}<p className="whitespace-pre-wrap break-words">{definition}</p>
   <label>{t('profile')}<select className={input} value={profile} onChange={e=>{setAck(false);setProfile(e.target.value as typeof profile)}}>{(['planar-control-point','height-control-section'] as const).map(p=><option key={p} value={p}>{t(`profiles.${p}`)}</option>)}</select></label>
   <label>{t('basis')}<textarea className={input} rows={3} value={basis} onChange={e=>{setAck(false);setBasis(e.target.value)}}/></label>
   {unitMaterials.map((unit,i)=><div key={unit.unitId} className="space-y-3 border border-ds-border-muted p-3"><h4 className="break-all font-semibold">{unit.unitId}</h4>{unit.requirements.map((mapping,j)=><div key={j} className="space-y-2 border-t border-ds-border-muted pt-2">
    <label>{t('reference')}<input className={input} value={mapping.reference} onChange={e=>editMapping(i,j,{reference:e.target.value})}/></label>
    <label>{t('materialSelect')}<select className={input} value={mapping.retentionCheckId} onChange={e=>{const required=retentionPlan?.plan.requiredEvidence.find(r=>`evidence:${r.id}`===e.target.value);editMapping(i,j,{retentionCheckId:e.target.value,memberId:required?.memberId??''})}}><option value="">{t('choose')}</option>{retentionPlan?.plan.requiredEvidence.map(r=><option key={r.id} value={`evidence:${r.id}`}>{r.title} · {r.memberId}</option>)}</select></label>
    <label>{t('locator')}<textarea className={input} rows={2} value={mapping.locatorStatement} onChange={e=>editMapping(i,j,{locatorStatement:e.target.value})}/></label>
    {unit.requirements.length>1&&<button className={button} onClick={()=>{setAck(false);setMaterials(old=>old.map((u,n)=>n===i?{...u,requirements:u.requirements.filter((_,k)=>k!==j)}:u))}}>{t('removeMapping')}</button>}
   </div>)}<button className={button} disabled={unitMaterials.reduce((n,u)=>n+u.requirements.length,0)>=64} onClick={()=>{setAck(false);setMaterials(old=>old.map((u,n)=>n===i?{...u,requirements:[...u.requirements,{reference:'',memberId:'',retentionCheckId:'',locatorStatement:''}]}:u))}}>{t('addMapping')}</button></div>)}
   <label className="flex items-start gap-2"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/><span>{t('acknowledge')}</span></label><button className={button} disabled={!valid||!ack} onClick={freeze}>{t('freeze')}</button>
  </fieldset>}
  {page&&<div className="space-y-2 border-t border-ds-border-muted pt-3"><p>{t('savedOnly')}</p>{page.data.records.map(r=><button className={`${button} block w-full break-all`} key={r.id} disabled={!ready} onClick={()=>open(page.kind,r.id,r.contentHash)}>{r.createdAt} · {r.id}{r.result&&` · ${t(`states.${r.result.overallLinkage}`)}`}</button>)}{page.data.unavailable.map(r=><p key={r.id} className="break-all">{r.id} · {t(`errors.${r.reason}`)}</p>)}{page.data.nextOffset!==null&&<button className={button} disabled={!ready} onClick={()=>history(page.kind,page.data.nextOffset!)}>{t('more')}</button>}</div>}
 </section>
}
