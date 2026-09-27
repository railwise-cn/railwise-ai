import { afterEach,describe,expect,it } from 'vitest'
import { Router } from '../router.js'
import type {JsonResponse} from '../response.js'
import { registerSurveyQualityAssessmentRoutes } from './survey-quality-assessment.js'
import { assessmentFixture } from '../../engineering/survey-quality-assessment-test-helpers.js'
const clean:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const f of clean.splice(0))await f()})
describe('authenticated declared linkage routes',()=>{
 it('requires auth and returns full create/reverify/export detail with no-store and no follow-up read',async()=>{
  const f=await assessmentFixture();clean.push(f.close);const router=new Router()
  registerSurveyQualityAssessmentRoutes(router,{getService:()=>f.assessment,authorize:r=>r.headers.get('authorization')==='Bearer local-test-secret'})
  const base=`/v1/engineering/projects/${f.project.id}`
  const call=async(path:string,method='GET',body?:string,auth=true)=>{const route=router.match(method,path.split('?')[0]!)!;return await route.handler(new Request(`http://localhost${path}`,{method,body,headers:auth?{authorization:'Bearer local-test-secret'}:{}}),{params:route.params}) as JsonResponse}
  expect((await call(`${base}/quality-assessment-plans`,'POST',JSON.stringify(f.planRequest),false)).status).toBe(401)
  const p=await call(`${base}/quality-assessment-plans`,'POST',JSON.stringify(f.planRequest));expect(p.status).toBe(201);expect(p.headers['cache-control']).toBe('no-store');const plan=JSON.parse(p.body)
  const created=await call(`${base}/quality-assessments`,'POST',JSON.stringify({schemaVersion:1,acknowledged:true,expectedProjectRevision:1,idempotencyKey:'http-assessment-key',assessmentPlanId:plan.id,expectedPlanHash:plan.planHash,unitScores:[]}));expect(created.status).toBe(201)
  const record=JSON.parse(created.body);expect(record.result.overallLinkage).toBe('incomplete-declared-linkage');expect(record.requestJson).toBeDefined()
  f.advance();const verified=await call(`${base}/quality-assessments/${record.id}/reverify`,'POST','{}');expect(JSON.parse(verified.body).record).toEqual(record);expect(JSON.parse(verified.body).checkedAt).toBeDefined()
  const exported=await call(`${base}/quality-assessments/${record.id}/export`);expect(exported.headers['content-disposition']).toContain('attachment');expect(JSON.parse(exported.body)).toEqual(record)
  for(const query of ['limit=11','limit=0','offset=129','limit=1&limit=2','seed=x'])expect((await call(`${base}/quality-assessments?${query}`)).status).toBe(400)
  expect((await call(`${base}/quality-assessments/${record.id}/reverify`,'POST','{"approved":true}')).status).toBe(400)
  expect((await call(`${base}/quality-assessments/missing`)).status).toBe(404)
  f.advance();f.append('artifact-bytes');const stale=await call(`${base}/quality-assessments/${record.id}`);expect(stale.status).toBe(409);expect(JSON.parse(stale.body).code).toBe('quality_assessment_source_changed')
  expect(f.auditCount()).toBe(0)
 })
 it('preserves resource, unavailable and corruption classifications',async()=>{
  const f=await assessmentFixture();clean.push(f.close);const router=new Router()
  registerSurveyQualityAssessmentRoutes(router,{getService:()=>f.assessment,authorize:()=>true})
  const path=`/v1/engineering/projects/${f.project.id}/quality-assessment-plans`,route=router.match('POST',path)!
  const call=()=>route.handler(new Request(`http://localhost${path}`,{method:'POST',body:JSON.stringify(f.planRequest)}),{params:route.params}) as Promise<JsonResponse>
  for(const [reason,status,retry] of [['limit',429,false],['rate-limit',429,true],['integrity',409,false],['unavailable',503,false]] as const){f.advance();f.sources.retentionSnapshot=()=>{throw Object.assign(new Error('source'),{reason})};const r=await call();expect(r.status).toBe(status);expect(Boolean(r.headers['retry-after'])).toBe(retry);expect(r.headers['cache-control']).toBe('no-store')}
 })
})
