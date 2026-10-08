import {afterEach,describe,expect,it} from 'vitest'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {assessmentFixture} from './survey-quality-assessment-test-helpers.js'
const clean:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of clean.splice(0))await close()})
const raw=(v:unknown)=>Buffer.from(JSON.stringify(v))
async function fixture(n=3){const f=await assessmentFixture(n);clean.push(f.close);return f}
function scoreRequest(plan:{id:string;planHash:string},scores:Array<{unitId:string;scoringRecordId:string}>,key:string){return {schemaVersion:1,acknowledged:true,expectedProjectRevision:1,idempotencyKey:key,assessmentPlanId:plan.id,expectedPlanHash:plan.planHash,unitScores:scores}}
async function initial(f:Awaited<ReturnType<typeof fixture>>){f.completeRetention();const plan=f.assessment.createPlan(f.project.id,raw(f.planRequest)),scores=f.unitIds.map(unitId=>({unitId,scoringRecordId:f.score(unitId).id}));f.advance();return f.assessment.createAssessment(f.project.id,raw(scoreRequest(plan,scores,'first-assessment-result')))}
async function nextInput(f:Awaited<ReturnType<typeof fixture>>,previous:ReturnType<typeof f.assessment.getAssessment>){
 const old=f.sampling.getRun(f.project.id,previous.sourceVector.samplingRunId),run=f.sampling.createRun(f.project.id,{populationId:old.populationId,idempotencyKey:`round-${old.round+1}-sampling-key`,stage:old.stage,inspectionMode:old.inspectionMode,reinspection:{previousRunId:old.id,expectedPreviousPlanHash:old.planHash,reason:'Corrected materials ready for reinspection'}})
 const corrected=await f.correctedRetention();f.advance()
 return {corrected,request:{...f.planRequest,idempotencyKey:`round-${run.round}-assessment-plan`,retentionPlanId:corrected.retentionPlanId,retentionRecordId:corrected.retentionRecordId,samplingRunId:run.id,reinspection:{previousAssessmentId:previous.id,expectedPreviousRecordHash:previous.recordHash,reason:'Corrected measurements and independently declared new scoring records'}}}
}
describe('actual SQLite reinspection assessment lineage',()=>{
 it('preserves the original record and binds real new scores and corrected retained material across restart',async()=>{
  const f=await fixture(),previous=await initial(f),before=JSON.stringify(previous),bytes=await f.outputBytes(),{request}=await nextInput(f,previous)
  const plan=f.assessment.createPlan(f.project.id,raw(request));f.advance();const scores=f.unitIds.map(unitId=>({unitId,scoringRecordId:f.score(unitId).id}));f.advance()
  const next=f.assessment.createAssessment(f.project.id,raw(scoreRequest(plan,scores,'second-assessment-result')))
  expect(plan.snapshot.run.round).toBe(2);expect(next.sourceVector.reinspection).toMatchObject({previousAssessmentId:previous.id,previousRecordHash:previous.recordHash,previousRound:1,previousResultHash:previous.resultHash})
  expect(next.sourceVector.scoring.map(s=>s.recordId)).toEqual(scores.map(s=>s.scoringRecordId));expect(next.result.overallLinkage).toBe('complete-declared-linkage')
  f.advance();expect(f.restart().getAssessment(f.project.id,next.id)).toEqual(next);f.advance();expect(JSON.stringify(f.assessment.getAssessment(f.project.id,previous.id))).toBe(before);expect(await f.outputBytes()).toEqual(bytes)
 })
 it('requires an exact previous assessment and new scoring instead of relabeling a first-round result',async()=>{
  const f=await fixture(),previous=await initial(f),{request}=await nextInput(f,previous)
  expect(()=>f.assessment.createPlan(f.project.id,raw({...request,reinspection:undefined}))).toThrow('validation')
  expect(()=>f.assessment.createPlan(f.project.id,raw({...request,reinspection:{...request.reinspection,expectedPreviousRecordHash:'0'.repeat(64)}}))).toThrow('conflict')
  const plan=f.assessment.createPlan(f.project.id,raw(request));f.advance()
  expect(()=>f.assessment.createAssessment(f.project.id,raw(scoreRequest(plan,previous.request.unitScores,'reused-score-result')))).toThrow('validation')
  f.advance();expect(()=>f.assessment.createAssessment(f.project.id,raw(scoreRequest(plan,[],'empty-score-result')))).toThrow('validation')
 })
 it('fails closed when the earlier material bytes change before read, retry or export verification',async()=>{
  const f=await fixture(),previous=await initial(f),{request}=await nextInput(f,previous),plan=f.assessment.createPlan(f.project.id,raw(request));f.advance()
  const scores=f.unitIds.map(unitId=>({unitId,scoringRecordId:f.score(unitId).id}));f.advance();const input=raw(scoreRequest(plan,scores,'fresh-score-result')),next=f.assessment.createAssessment(f.project.id,input)
  await writeFile(join(f.project.workspace,f.manifest.outputs[0]!.path),'tampered earlier material');f.advance()
  expect(()=>f.assessment.getAssessment(f.project.id,next.id)).toThrow('stale');expect(()=>f.assessment.reverifyAssessment(f.project.id,next.id)).toThrow('stale');expect(()=>f.assessment.createAssessment(f.project.id,input)).toThrow('stale')
 })
})
