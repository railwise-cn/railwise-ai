import { z } from 'zod'
import * as C from '@shared/survey-quality-assessment'
import { rendererRuntimeClient } from './runtime-client'
export type AssessmentBinding = { projectId: string; projectRevision: number; workspaceRoot: string }
export type AssessmentPlan = z.infer<typeof C.SurveyQualityAssessmentPlanV1>
export type AssessmentRecord = z.infer<typeof C.SurveyQualityAssessmentV1>
export type AssessmentPlanInput = Omit<z.infer<typeof C.SurveyQualityAssessmentPlanCreateV1>,'schemaVersion'|'acknowledged'|'expectedProjectRevision'|'idempotencyKey'>
export type AssessmentHistory = z.infer<typeof C.SurveyQualityAssessmentListV1>
export class AssessmentRequestError extends Error { constructor(readonly reason:string){super(reason)} }
const invalid=():never=>{throw new AssessmentRequestError('invalid-response')}
const bytes=(s:string)=>new TextEncoder().encode(s).byteLength
function canonical(v:unknown):string {if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;if(v!==null&&typeof v==='object'){const o=v as Record<string,unknown>;return `{${Object.keys(o).sort().filter(k=>o[k]!==undefined).map(k=>`${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`}return JSON.stringify(v)}
const equal=(a:unknown,b:unknown)=>canonical(a)===canonical(b)
async function hash(v:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)))].map(b=>b.toString(16).padStart(2,'0')).join('')}
async function request(path:string,method='GET',body?:string):Promise<unknown>{
 let response:Awaited<ReturnType<typeof rendererRuntimeClient.runtimeRequest>>
 try{response=await rendererRuntimeClient.runtimeRequest(path,method,body)}catch{throw new AssessmentRequestError('request-failed')}
 if(!response.ok){let code:unknown;try{code=JSON.parse(response.body).code}catch{/* HTTP fallback */}const prefix='quality_assessment_';throw new AssessmentRequestError(typeof code==='string'&&code.startsWith(prefix)?code.slice(prefix.length).replaceAll('_','-'):response.status===503?'unavailable':'request-failed')}
 if(bytes(response.body)>C.QUALITY_ASSESSMENT_LIMITS.recordBytes*10+16384)return invalid()
 try{return C.parseAssessmentJson(response.body)}catch{return invalid()}
}
export async function checkAssessmentRecord(raw:unknown,binding:AssessmentBinding,expectedId?:string,expectedHash?:string):Promise<AssessmentPlan|AssessmentRecord>{
 const plan=C.SurveyQualityAssessmentPlanV1.safeParse(raw),record=plan.success?plan.data:C.SurveyQualityAssessmentV1.safeParse(raw).data
 if(!record || bytes(JSON.stringify(record))>C.QUALITY_ASSESSMENT_LIMITS.recordBytes)return invalid()
 const isPlan='snapshot' in record,project=isPlan?record.snapshot.project:record.projectSnapshot,contentHash=isPlan?record.planHash:record.recordHash
 if(record.projectId!==binding.projectId||record.projectRevision!==binding.projectRevision||!equal(project,{id:binding.projectId,revision:binding.projectRevision,workspace:binding.workspaceRoot})||expectedId&&record.id!==expectedId||expectedHash&&contentHash!==expectedHash)return invalid()
 const unsigned={...record} as Record<string,unknown>;delete unsigned[isPlan?'planHash':'recordHash']
 const requestSchema=isPlan?C.SurveyQualityAssessmentPlanCreateV1:C.SurveyQualityAssessmentCreateV1
 let decoded:unknown;try{decoded=requestSchema.parse(C.parseAssessmentJson(record.requestJson))}catch{return invalid()}
 if(!equal(decoded,record.request)||record.request.expectedProjectRevision!==binding.projectRevision||bytes(record.requestJson)!==record.requestSizeBytes
   ||await hash(record.requestJson)!==record.requestSha256||await hash(canonical(unsigned))!==contentHash||await hash(canonical(project))!==record.projectBindingHash)return invalid()
 if(isPlan){if(!equal(record.snapshot.selectedUnitIds,record.request.unitMaterials.map(u=>u.unitId))||record.snapshot.sampleIdsHash!==await hash(canonical(record.snapshot.selectedUnitIds))||record.snapshot.retentionPlanDigest!==await hash(canonical(record.snapshot.retentionPlan))||record.request.productProfileId!==record.snapshot.profile.profileId)return invalid()}
 else if(record.resultHash!==await hash(canonical(record.result))||record.request.assessmentPlanId!==record.assessmentPlanId||record.request.expectedPlanHash!==record.planHash)return invalid()
 return record
}
export async function createAssessmentPlan(binding:AssessmentBinding,input:AssessmentPlanInput,key:string):Promise<AssessmentPlan>{
 const body=C.SurveyQualityAssessmentPlanCreateV1.parse({...input,schemaVersion:1,acknowledged:true,expectedProjectRevision:binding.projectRevision,idempotencyKey:key}),raw=JSON.stringify(body)
 if(bytes(raw)>C.QUALITY_ASSESSMENT_LIMITS.requestBytes)throw new AssessmentRequestError('validation')
 const result=await checkAssessmentRecord(await request(C.assessmentPath(binding.projectId,'plans'),'POST',raw),binding)
 if(!('snapshot' in result)||result.requestJson!==raw)return invalid();return result
}
export async function createAssessment(binding:AssessmentBinding,plan:AssessmentPlan,unitScores:z.infer<typeof C.SurveyQualityAssessmentCreateV1>['unitScores'],key:string):Promise<AssessmentRecord>{
 const body=C.SurveyQualityAssessmentCreateV1.parse({schemaVersion:1,acknowledged:true,expectedProjectRevision:binding.projectRevision,idempotencyKey:key,assessmentPlanId:plan.id,expectedPlanHash:plan.planHash,unitScores}),raw=JSON.stringify(body)
 const result=await checkAssessmentRecord(await request(C.assessmentPath(binding.projectId,'assessments'),'POST',raw),binding)
 if('snapshot' in result||result.requestJson!==raw||!equal(result.result.unitRows.map(u=>u.unitId),plan.snapshot.selectedUnitIds))return invalid();return result
}
export async function readAssessment(binding:AssessmentBinding,kind:'plans'|'assessments',id:string,contentHash?:string):Promise<AssessmentPlan|AssessmentRecord>{
 const record=await checkAssessmentRecord(await request(C.assessmentPath(binding.projectId,kind,id)),binding,id,contentHash)
 if((kind==='plans')!==('snapshot' in record))return invalid();return record
}
export async function reverifyAssessment(binding:AssessmentBinding,record:AssessmentRecord):Promise<AssessmentRecord>{
 const parsed=C.SurveyQualityAssessmentVerificationV1.safeParse(await request(C.assessmentPath(binding.projectId,'assessments',record.id,'reverify'),'POST','{}'));if(!parsed.success)return invalid()
 const result=await checkAssessmentRecord(parsed.data.record,binding,record.id,record.recordHash);if('snapshot' in result)return invalid();return result
}
export async function exportAssessment(binding:AssessmentBinding,record:AssessmentRecord):Promise<AssessmentRecord>{const result=await checkAssessmentRecord(await request(C.assessmentPath(binding.projectId,'assessments',record.id,'export')),binding,record.id,record.recordHash);if('snapshot' in result)return invalid();return result}
export async function listAssessments(binding:AssessmentBinding,kind:'plans'|'assessments',offset=0):Promise<AssessmentHistory>{
 const parsed=C.SurveyQualityAssessmentListV1.safeParse(await request(`${C.assessmentPath(binding.projectId,kind)}?limit=10&offset=${offset}`));if(!parsed.success)return invalid()
 if(parsed.data.records.some(r=>r.projectId!==binding.projectId||r.projectRevision!==binding.projectRevision)||parsed.data.nextOffset!==null&&parsed.data.nextOffset!==offset+10)return invalid();return parsed.data
}
export async function assessmentPopulation(binding:AssessmentBinding,id:string){
 const {SurveySamplingPopulationDetailV1,runtimeSurveySamplingPath}=await import('@shared/survey-quality-sampling-workspace')
 const parsed=SurveySamplingPopulationDetailV1.safeParse(await request(runtimeSurveySamplingPath(binding.projectId,'populations',id)))
 if(!parsed.success||parsed.data.id!==id||parsed.data.projectId!==binding.projectId||parsed.data.projectRevision!==binding.projectRevision)return invalid();return parsed.data
}
export async function saveAssessmentExport(binding:AssessmentBinding,record:AssessmentRecord,stillCurrent:()=>boolean){
 const fresh=await exportAssessment(binding,record)
 if(!stillCurrent())throw new AssessmentRequestError('stale')
 const {saveGeneratedWorkspaceFileAs}=await import('../lib/generated-file-actions')
 const encoded=new TextEncoder().encode(`${JSON.stringify(fresh)}\n`);let binary=''
 for(let i=0;i<encoded.length;i+=32768)binary+=String.fromCharCode(...encoded.subarray(i,i+32768))
 if(!stillCurrent())throw new AssessmentRequestError('stale')
 return saveGeneratedWorkspaceFileAs({workspaceRoot:binding.workspaceRoot,suggestedName:'survey-declared-linkage-assessment.json',mimeType:'application/json',dataBase64:btoa(binary)})
}
