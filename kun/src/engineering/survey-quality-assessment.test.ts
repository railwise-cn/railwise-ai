import { afterEach,describe,expect,it,vi } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { assessmentFixture } from './survey-quality-assessment-test-helpers.js'
import { assessmentDigest } from './survey-quality-assessment.js'
const clean:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of clean.splice(0))await close()})
const raw=(v:unknown)=>Buffer.from(JSON.stringify(v))
async function fixture(n=3){const f=await assessmentFixture(n);clean.push(f.close);return f}
function request(plan:{id:string;planHash:string},scores:Array<{unitId:string;scoringRecordId:string}>,key='assessment-result-key'){return {schemaVersion:1,acknowledged:true,expectedProjectRevision:1,idempotencyKey:key,assessmentPlanId:plan.id,expectedPlanHash:plan.planHash,unitScores:scores}}
describe('real cross-service declared linkage',()=>{
 it('freezes all three census units, preserves exact request bytes and draft files, performs exactly two score reads per unit, and restarts',async()=>{
  const f=await fixture();f.completeRetention();const before=await f.outputBytes(),audits=f.auditCount()
  expect(f.manifest.outputs.map(o=>o.mediaType)).toEqual(expect.arrayContaining(['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']))
  const planRaw=Buffer.from(` \n${JSON.stringify(f.planRequest,null,2)}\n`),plan=f.assessment.createPlan(f.project.id,planRaw)
  const scores=f.unitIds.map(unitId=>({unitId,scoringRecordId:f.score(unitId).id}));f.advance()
  const spy=vi.spyOn(f.sources,'getScore'),r=f.assessment.createAssessment(f.project.id,raw(request(plan,[...scores].reverse())))
  expect(spy).toHaveBeenCalledTimes(6);expect(r.result.overallLinkage).toBe('complete-declared-linkage');expect(r.result.unitRows.map(u=>u.unitId)).toEqual(f.unitIds)
  expect(r.result.unitRows[0]?.score?.result.score).toEqual({numerator:'100',denominator:'1'})
  expect(r.request.unitScores.map(u=>u.unitId)).toEqual([...f.unitIds].reverse());expect(plan.requestJson).toBe(planRaw.toString());expect(r.manifestReviewStatus).toBe('draft');expect(r.deliverableNumericalReplay).toBe('not-performed-by-assessment')
  expect(await f.outputBytes()).toEqual(before);expect(f.auditCount()).toBe(audits);f.advance();expect(f.restart().getAssessment(f.project.id,r.id)).toEqual(r)
  expect(f.assessment.createPlan(f.project.id,planRaw).id).toBe(plan.id)
  expect(()=>f.assessment.createPlan(f.project.id,raw(f.planRequest))).toThrow('conflict')
 })
 it.each(['partial','pending','multi60'] as const)('keeps %s unit scope unresolved instead of complete',async kind=>{
  const f=await fixture();f.completeRetention();const plan=f.assessment.createPlan(f.project.id,raw(f.planRequest))
  const scores=f.unitIds.map((unitId,i)=>({unitId,scoringRecordId:f.score(unitId,i?undefined:d=>{
   if(kind==='multi60'){const leaf=d.leaves[0]!;if(leaf.state==='checked'&&leaf.record.kind==='accuracy'){const m=leaf.record.model;m.items=[{...m.items[0]!,m:'1'},{...m.items[0]!,id:'second',m:'0.1'}]}}
   else d.leaves[6]={elementId:'material-quality',subelementId:'completeness',state:kind==='partial'?'excluded':'pending',reason:'Synthetic scope',evidenceRefs:['synthetic']}
  }).id}));f.advance()
  const r=f.assessment.createAssessment(f.project.id,raw(request(plan,scores)))
  expect(r.result.scoreCoverage).toBe('incomplete-full-profile-unit-results');expect(r.result.declaredResultSummary).toBe('unresolved')
 })
 it('shows explicit veto alongside missing unit and checks every original retention requirement',async()=>{
  const f=await fixture();f.append('artifact-bytes');f.append('evidence:support')
  const plan=f.assessment.createPlan(f.project.id,raw(f.planRequest));const veto=f.score(f.unitIds[0]!,d=>{const l=d.leaves[1]!;if(l.state==='checked'&&l.record.kind==='deduction')l.record.defects.b=4})
  f.advance();const r=f.assessment.createAssessment(f.project.id,raw(request(plan,[{unitId:f.unitIds[0]!,scoringRecordId:veto.id}])))
  expect(r.result).toMatchObject({scoreCoverage:'incomplete-full-profile-unit-results',retentionCoverage:'incomplete-declared-requirements',declaredResultSummary:'contains-declared-nonconforming',overallLinkage:'incomplete-declared-linkage'})
  expect(r.result.counts.fullProfileUnits).toBe(1)
  f.append('evidence:other');f.advance();expect(()=>f.assessment.getAssessment(f.project.id,r.id)).toThrow('source-changed')
  expect(f.assessment.getPlan(f.project.id,plan.id)).toEqual(plan)
 })
 it('resolves each explicit reference location only to the same unit and passed mapping',async()=>{
  const f=await fixture();f.completeRetention();const plan=f.assessment.createPlan(f.project.id,raw(f.planRequest))
  const s=f.score(f.unitIds[0]!,d=>{d.evidenceRefs=['root'];d.leaves[6]={elementId:'material-quality',subelementId:'completeness',state:'pending',reason:'synthetic',evidenceRefs:['pending']};d.leaves[5]={elementId:'material-quality',subelementId:'presentation-quality',state:'excluded',reason:'synthetic',evidenceRefs:['excluded']};const l=d.leaves[0]!;if(l.state==='checked'&&l.record.kind==='accuracy'){l.record.model.aEvidenceRefs=['a'];l.record.model.items[0]!.evidenceRefs=['item'];l.record.model.aggregation={kind:'weighted',weights:['1'],basisStatement:'synthetic',evidenceRefs:['weights']}}const other=d.leaves[1]!;if(other.state==='checked'&&other.record.kind==='deduction')other.record.defects.evidenceRefs=['deduction']})
  f.advance();const r=f.assessment.createAssessment(f.project.id,raw(request(plan,[{unitId:f.unitIds[0]!,scoringRecordId:s.id}])))
  expect(r.result.unitRows[0]!.references.filter(x=>!x.resolved).map(x=>x.reference).sort()).toEqual(['root','pending','excluded','a','item','weights','deduction'].sort());expect(r.result.counts.unresolvedReferences).toBe(7)
 })
 it('rejects subset/order/member/duplicate/unsupported sample scopes without slicing',async()=>{
  const f=await fixture();for(const materials of [f.planRequest.unitMaterials.slice(0,2),[...f.planRequest.unitMaterials].reverse(),[...f.planRequest.unitMaterials,f.planRequest.unitMaterials[0]!]]){expect(()=>f.assessment.createPlan(f.project.id,raw({...f.planRequest,unitMaterials:materials}))).toThrow('validation')}
  expect(()=>f.assessment.createPlan(f.project.id,raw({...f.planRequest,unitMaterials:f.planRequest.unitMaterials.map(u=>({...u,requirements:[{...u.requirements[0]!,retentionCheckId:'artifact-bytes'}]}))}))).toThrow('validation')
  const big=await fixture(9);expect(()=>big.assessment.createPlan(big.project.id,raw({...big.planRequest,unitMaterials:big.planRequest.unitMaterials.slice(0,8)}))).toThrow('unsupported-scope')
 })
 it('rejects duplicate keys, escaped-equivalent keys, surrogates and invalid UTF-8',async()=>{
  const f=await fixture();const valid=JSON.stringify(f.planRequest)
  for(const v of [valid.replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1'),valid.replace('"schemaVersion":1','"schemaVersion":1,"schema\\u0056ersion":1'),valid.replace('合成资料','\\ud800'),Buffer.from([0xc3,0x28])])expect(()=>f.assessment.createPlan(f.project.id,typeof v==='string'?Buffer.from(v):v)).toThrow('validation')
 })
 it('does not replay sources for list and isolates own damaged rows',async()=>{
  const f=await fixture();const plan=f.assessment.createPlan(f.project.id,raw(f.planRequest)),r=f.assessment.createAssessment(f.project.id,raw(request(plan,[])))
  const spy=vi.spyOn(f.sources,'retentionSnapshot');spy.mockImplementation(()=>{throw new Error('source unavailable')})
  expect(f.assessment.list(f.project.id,'assessments').records[0]).toMatchObject({id:r.id,view:'saved-summary-only',dependencyVerification:'not-performed-on-list'});expect(spy).not.toHaveBeenCalled()
  const db=new Database(join(f.runtime,'survey-quality-assessment.sqlite3'));db.exec('DROP TRIGGER assessments_no_update');db.prepare('UPDATE assessments SET data_json=? WHERE id=?').run('{}',r.id);db.close()
  expect(f.assessment.list(f.project.id,'assessments').unavailable).toEqual([{id:r.id,reason:'integrity'}])
 })
 it('rejects coherent result+all hash forgery through recomputation',async()=>{
  const f=await fixture();const plan=f.assessment.createPlan(f.project.id,raw(f.planRequest)),r=f.assessment.createAssessment(f.project.id,raw(request(plan,[])))
  const db=new Database(join(f.runtime,'survey-quality-assessment.sqlite3'));db.exec('DROP TRIGGER assessments_no_update')
  const row=db.prepare('SELECT * FROM assessments WHERE id=?').get(r.id) as Record<string,unknown>;const changed=JSON.parse(row.data_json as string);changed.result.overallLinkage='complete-declared-linkage';changed.resultHash=assessmentDigest(changed.result);delete changed.recordHash;changed.recordHash=assessmentDigest(changed);row.data_json=JSON.stringify(changed);row.content_hash=changed.recordHash;delete row.storage_hash
  const {request_bytes,...metadata}=row;const storageHash=assessmentDigest({...metadata,request_bytes_sha256:createHash('sha256').update(request_bytes as Buffer).digest('hex')})
  db.prepare('UPDATE assessments SET data_json=?,content_hash=?,storage_hash=? WHERE id=?').run(row.data_json,row.content_hash,storageHash,r.id);db.close()
  expect(()=>f.assessment.getAssessment(f.project.id,r.id)).toThrow('integrity')
 })
 it('isolates malformed SQL identities without hiding healthy history',async()=>{
  const f=await fixture(),plan=f.assessment.createPlan(f.project.id,raw(f.planRequest)),bad=f.assessment.createAssessment(f.project.id,raw(request(plan,[])))
  const good=f.assessment.createAssessment(f.project.id,raw(request(plan,[],'healthy-assessment-key')))
  const db=new Database(join(f.runtime,'survey-quality-assessment.sqlite3'));db.exec('DROP TRIGGER assessments_no_update');db.prepare('UPDATE assessments SET id=? WHERE id=?').run(' ',bad.id);db.close()
  const page=f.assessment.list(f.project.id,'assessments');expect(page.records.map(r=>r.id)).toEqual([good.id]);expect(page.unavailable).toEqual([{id:expect.stringMatching(/^unavailable-slot-/),reason:'integrity'}])
 })
 it('rejects source mutation between passes and unchanged bytes after altered output',async()=>{
  const f=await fixture();const original=f.sources.retentionSnapshot;let reads=0
  f.sources.retentionSnapshot=(...args)=>{const value=original(...args);if(++reads===1)f.append('artifact-bytes');return value}
  expect(()=>f.assessment.createPlan(f.project.id,raw(f.planRequest))).toThrow('source-changed');expect(f.assessment.list(f.project.id,'assessment_plans').records).toHaveLength(0)
  f.sources.retentionSnapshot=original;const p=f.assessment.createPlan(f.project.id,raw(f.planRequest))
  await writeFile(join(f.project.workspace,f.manifest.outputs[0]!.path),'changed');expect(()=>f.assessment.getPlan(f.project.id,p.id)).toThrow('stale')
 })
 it('uses exactly 224 scoring work units for eight maximum unit records; next replay is rate-limited',async()=>{
  const f=await fixture(8);f.completeRetention();const plan=f.assessment.createPlan(f.project.id,raw(f.planRequest))
  const scores=f.unitIds.map(unitId=>({unitId,scoringRecordId:f.score(unitId,d=>{const l=d.leaves[0]!;if(l.state==='checked'&&l.record.kind==='accuracy'){const item=l.record.model.items[0]!;l.record.model.items=Array.from({length:64},(_,i)=>({...item,id:`accuracy-${i}`}))}}).id}));f.advance()
  const spy=vi.spyOn(f.sources,'getScore');const r=f.assessment.createAssessment(f.project.id,raw(request(plan,scores)))
  expect(spy).toHaveBeenCalledTimes(16);expect(r.result.overallLinkage).toBe('complete-declared-linkage');expect(()=>f.assessment.getAssessment(f.project.id,r.id)).toThrow('rate-limit')
 })
})
