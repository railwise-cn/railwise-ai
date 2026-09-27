import { afterEach, describe, expect, it } from 'vitest'
import { Router } from '../router.js'
import type { JsonResponse } from '../response.js'
import { registerSurveyQualityAssessmentRoutes } from './survey-quality-assessment.js'
import { assessmentFixture } from '../../engineering/survey-quality-assessment-test-helpers.js'
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const c of cleanup.splice(0))await c()})
async function setup(){
 const f=await assessmentFixture(1);cleanup.push(f.close);const router=new Router()
 registerSurveyQualityAssessmentRoutes(router,{getService:()=>f.assessment,authorize:r=>r.headers.get('authorization')==='Bearer independent'})
 const base=`/v1/engineering/projects/${f.project.id}`
 const call=async(suffix:string,method='GET',body?:string,auth=true)=>{const path=base+suffix,route=router.match(method,path.split('?')[0]!)!;return await route.handler(new Request(`http://localhost${path}`,{method,body,headers:auth?{authorization:'Bearer independent'}:{}}),{params:route.params}) as JsonResponse}
 return {f,call}
}
describe('independent authenticated assessment route probes',()=>{
 it('authenticates before reading or saving every available route',async()=>{
  const {f,call}=await setup()
  for(const [path,method,body] of [['/quality-assessment-plans','GET'],['/quality-assessment-plans','POST',JSON.stringify(f.planRequest)],['/quality-assessment-plans/missing','GET'],['/quality-assessments','GET'],['/quality-assessments','POST','{}'],['/quality-assessments/missing','GET'],['/quality-assessments/missing/reverify','POST','{}'],['/quality-assessments/missing/export','GET']]){const r=await call(path!,method,body,false);expect(r.status).toBe(401);expect(r.headers['cache-control']).toBe('no-store')}
  expect(f.assessment.list(f.project.id,'assessment_plans').records).toHaveLength(0)
 })
 it('rejects escaped-equivalent keys and wrong reverify shape without a save',async()=>{
  const {f,call}=await setup();const raw=JSON.stringify(f.planRequest).replace('"schemaVersion":1','"schemaVersion":1,"schema\\u0056ersion":1');expect((await call('/quality-assessment-plans','POST',raw)).status).toBe(400);expect((await call('/quality-assessments/missing/reverify','POST','{"approved":true}')).status).toBe(400);expect(f.assessment.list(f.project.id,'assessment_plans').records).toHaveLength(0)
 })
 it('rejects unknown and duplicate queries on detail/export/create',async()=>{
  const {f,call}=await setup();for(const path of ['/quality-assessments?limit=1&limit=1','/quality-assessments?offset=-1','/quality-assessments?offset=NaN','/quality-assessments/missing?limit=1','/quality-assessments/missing/export?approved=true'])expect((await call(path)).status).toBe(400);expect((await call('/quality-assessment-plans?limit=1','POST',JSON.stringify(f.planRequest))).status).toBe(400)
 })
 it('refuses export after source changed and does not add an attachment header to error',async()=>{
  const {f,call}=await setup();const p=f.assessment.createPlan(f.project.id,Buffer.from(JSON.stringify(f.planRequest)));const r=f.assessment.createAssessment(f.project.id,Buffer.from(JSON.stringify({schemaVersion:1,acknowledged:true,expectedProjectRevision:1,idempotencyKey:'independent-http-record',assessmentPlanId:p.id,expectedPlanHash:p.planHash,unitScores:[]})));f.append('artifact-bytes');f.advance();const exported=await call(`/quality-assessments/${r.id}/export`);expect(exported.status).toBe(409);expect(JSON.parse(exported.body).code).toBe('quality_assessment_source_changed');expect(exported.headers['content-disposition']).toBeUndefined();expect(f.auditCount()).toBe(0)
 })
 it('bounds request bytes before malformed data reaches a persistent row',async()=>{
  const {f,call}=await setup();const r=await call('/quality-assessment-plans','POST',' '.repeat(256*1024+1));expect(r.status).toBe(429);expect(JSON.parse(r.body).code).toBe('quality_assessment_limit');expect(r.headers['retry-after']).toBeUndefined();expect(f.assessment.list(f.project.id,'assessment_plans').records).toHaveLength(0)
 })
})
