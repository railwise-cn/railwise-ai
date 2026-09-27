import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { assessmentFixture } from './survey-quality-assessment-test-helpers.js'
import { qualityScoringTestRequest } from './survey-quality-scoring-test-helpers.js'
import { SurveyQualityScoringError } from './survey-quality-scoring-workspace.js'
const closes:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const c of closes.splice(0))await c()})
async function make(n=3){const f=await assessmentFixture(n);closes.push(f.close);return f}
const raw=(v:unknown)=>Buffer.from(JSON.stringify(v))
function req(p:{id:string,planHash:string},scores:Array<{unitId:string,scoringRecordId:string}>=[], key='independent-result-001'){return {schemaVersion:1,acknowledged:true,expectedProjectRevision:1,idempotencyKey:key,assessmentPlanId:p.id,expectedPlanHash:p.planHash,unitScores:scores}}
function sha(v:Buffer|string){return createHash('sha256').update(v).digest('hex')}
function stable(v:unknown):string{if(Array.isArray(v))return '['+v.map(stable).join(',')+']';if(v&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).filter(([,v])=>v!==undefined).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';return JSON.stringify(v)}
const digest=(v:unknown)=>sha(stable(v))
describe('independent linkage probes',()=>{
 it('isolates invalid SQL IDs beside healthy records without hiding the healthy page',async()=>{
  const f=await make(1);const p=f.assessment.createPlan(f.project.id,raw(f.planRequest));const healthy=f.assessment.createAssessment(f.project.id,raw(req(p,[],'independent-list-healthy')));f.advance();const bad=f.assessment.createAssessment(f.project.id,raw(req(p,[],'independent-list-bad')));const db=new Database(join(f.runtime,'survey-quality-assessment.sqlite3'));try{db.exec('DROP TRIGGER assessments_no_update');db.prepare('UPDATE assessments SET id=? WHERE id=?').run(' invalid-sql-identity ',bad.id)}finally{db.close()}const page=f.assessment.list(f.project.id,'assessments');expect(page.records.map(r=>r.id)).toEqual([healthy.id]);expect(page.unavailable).toHaveLength(1);expect(page.unavailable[0]!.id).toMatch(/^unavailable-slot-\d+$/);expect(page.unavailable[0]!.reason).toBe('integrity')
 })
 it('accepts all 2336 distinct references in a valid maximal weighted unit, with honest unresolved coverage',async()=>{
  const f=await make(1);f.completeRetention();const p=f.assessment.createPlan(f.project.id,raw(f.planRequest));let index=0;const refs=()=>Array.from({length:32},()=>`ref-${++index}`)
  const score=f.score(f.unitIds[0]!,d=>{d.evidenceRefs=refs();for(const l of d.leaves){if(l.state!=='checked')continue;if(l.record.kind==='deduction')l.record.defects.evidenceRefs=refs();else{const m=l.record.model;m.aEvidenceRefs=refs();m.items=Array.from({length:64},(_,i)=>({...m.items[0]!,id:`precision-${i}`,evidenceRefs:refs()}));m.aggregation={kind:'weighted',weights:Array(64).fill('1'),basisStatement:'Synthetic independent weighted-basis fixture.',evidenceRefs:refs()}}}})
  expect(index).toBe(2336);f.advance();const r=f.assessment.createAssessment(f.project.id,raw(req(p,[{unitId:f.unitIds[0]!,scoringRecordId:score.id}])));expect(r.result.unitRows[0]!.references).toHaveLength(2336);expect(r.result.counts.unresolvedReferences).toBe(2336);expect(r.result.overallLinkage).toBe('incomplete-declared-linkage')
 })
 it('keeps a fully covered nonconforming unit distinct from incomplete coverage and never writes engineering audit',async()=>{
  const f=await make(1);f.completeRetention();const p=f.assessment.createPlan(f.project.id,raw(f.planRequest));const s=f.score(f.unitIds[0]!,d=>{const l=d.leaves[1]!;if(l.state==='checked'&&l.record.kind==='deduction')l.record.defects.b=4});const before=f.auditCount(),bytes=await f.outputBytes();f.advance();const r=f.assessment.createAssessment(f.project.id,raw(req(p,[{unitId:f.unitIds[0]!,scoringRecordId:s.id}])));
  expect(r.result).toMatchObject({scoreCoverage:'complete-full-profile-unit-results',retentionCoverage:'complete-declared-requirements',overallLinkage:'complete-declared-linkage',declaredResultSummary:'contains-declared-nonconforming'});expect(r.approvalCapability).toBe('none');expect(r.manifestReviewStatus).toBe('draft');f.advance();f.assessment.reverifyAssessment(f.project.id,r.id);expect(f.auditCount()).toBe(before);expect(await f.outputBytes()).toEqual(bytes)
 })
 it('does not freeze the head in the plan: incomplete then appended source requires new assessment, preserves original',async()=>{
  const f=await make(1);const p=f.assessment.createPlan(f.project.id,raw(f.planRequest));const s=f.score(f.unitIds[0]!);f.advance();const request=req(p,[{unitId:f.unitIds[0]!,scoringRecordId:s.id}]);const before=f.assessment.createAssessment(f.project.id,raw(request));expect(before.result.retentionCoverage).toBe('incomplete-declared-requirements');f.completeRetention();f.advance();expect(f.assessment.getPlan(f.project.id,p.id)).toEqual(p);expect(()=>f.assessment.getAssessment(f.project.id,before.id)).toThrow('source-changed');const after=f.assessment.createAssessment(f.project.id,raw({...request,idempotencyKey:'independent-result-002'}));expect(after.result.overallLinkage).toBe('complete-declared-linkage');expect(after.sourceVector.retentionHeadHash).not.toBe(before.sourceVector.retentionHeadHash);expect(f.assessment.list(f.project.id,'assessments').records).toHaveLength(2)
 })
 it('never resolves one unit through another unit material mapping',async()=>{
  const f=await make(2);f.completeRetention();const request=structuredClone(f.planRequest);request.unitMaterials[1]!.requirements[0]!.reference='other-reference';const p=f.assessment.createPlan(f.project.id,raw(request));const scores=f.unitIds.map(unitId=>({unitId,scoringRecordId:f.score(unitId).id}));f.advance();const r=f.assessment.createAssessment(f.project.id,raw(req(p,scores)));expect(r.result.unitRows[0]!.references).toEqual([{reference:'synthetic',resolved:true}]);expect(r.result.unitRows[1]!.references).toEqual([{reference:'synthetic',resolved:false}]);expect(r.result.overallLinkage).toBe('incomplete-declared-linkage')
 })
 it('rejects reuse of another unit or another project score and score identity cannot override selection',async()=>{
  const f=await make(2),other=await make(1);const p=f.assessment.createPlan(f.project.id,raw(f.planRequest)),s=f.score(f.unitIds[0]!),foreign=other.score(other.unitIds[0]!);f.advance();expect(()=>f.assessment.createAssessment(f.project.id,raw(req(p,[{unitId:f.unitIds[1]!,scoringRecordId:s.id}])))).toThrow('validation');expect(()=>f.assessment.createAssessment(f.project.id,raw(req(p,[{unitId:f.unitIds[0]!,scoringRecordId:foreign.id}])))).toThrow('not-found');expect(f.assessment.list(f.project.id,'assessments').records).toHaveLength(0)
 })
 it('enforces whole original retention plan even if every linked score and mapping is available',async()=>{
  const f=await make(1);f.append('artifact-bytes');f.append('evidence:support');const p=f.assessment.createPlan(f.project.id,raw(f.planRequest)),s=f.score(f.unitIds[0]!);f.advance();const r=f.assessment.createAssessment(f.project.id,raw(req(p,[{unitId:f.unitIds[0]!,scoringRecordId:s.id}])));expect(r.result.counts.unresolvedReferences).toBe(0);expect(r.result.scoreCoverage).toBe('complete-full-profile-unit-results');expect(r.result.overallLinkage).toBe('incomplete-declared-linkage');expect(r.result.originalRetentionChecks.find(x=>x.checkId==='evidence:other')?.status).toBe('missing')
 })
 it.each([['survey-quality-scoring.sqlite3','quality_scoring_records'],['survey-sampling.sqlite3','sampling_runs'],['survey-quality.sqlite3','quality_events']] as const)('rejects corrupt source %s via strict reader without fallback',async(dbname,table)=>{
  const f=await make(1);f.completeRetention();const p=f.assessment.createPlan(f.project.id,raw(f.planRequest)),s=f.score(f.unitIds[0]!);f.advance();const r=f.assessment.createAssessment(f.project.id,raw(req(p,[{unitId:f.unitIds[0]!,scoringRecordId:s.id}])));const db=new Database(join(f.runtime,dbname));try{db.exec(`DROP TRIGGER ${table}_no_update`);db.prepare(`UPDATE ${table} SET data_json=?`).run('{}')}finally{db.close()}f.advance();expect(()=>f.assessment.getAssessment(f.project.id,r.id)).toThrow('integrity');expect(f.assessment.list(f.project.id,'assessments').records[0]?.dependencyVerification).toBe('not-performed-on-list')
 })
 it('rejects coherent source score result hashes after actual scoring replay',async()=>{
  const f=await make(1);const p=f.assessment.createPlan(f.project.id,raw(f.planRequest)),s=f.score(f.unitIds[0]!);const db=new Database(join(f.runtime,'survey-quality-scoring.sqlite3'));try{const row=db.prepare('SELECT * FROM quality_scoring_records WHERE id=?').get(s.id) as Record<string,unknown>;const record=JSON.parse(row.data_json as string);record.result.result.score={numerator:'99',denominator:'1'};record.resultHash=digest(record.result);delete record.recordHash;record.recordHash=digest(record);row.data_json=JSON.stringify(record);row.record_hash=record.recordHash;delete row.storage_hash;const {request_bytes,declaration_bytes,...metadata}=row;const storage=digest({...metadata,request_bytes_sha256:sha(request_bytes as Buffer),declaration_bytes_sha256:sha(declaration_bytes as Buffer)});db.exec('DROP TRIGGER quality_scoring_records_no_update');db.prepare('UPDATE quality_scoring_records SET data_json=?,record_hash=?,storage_hash=? WHERE id=?').run(row.data_json,row.record_hash,storage,s.id)}finally{db.close()}f.advance();expect(()=>f.assessment.createAssessment(f.project.id,raw(req(p,[{unitId:f.unitIds[0]!,scoringRecordId:s.id}])))).toThrow('integrity')
 })
 it('distinguishes output byte drift as stale from retained blob corruption as integrity',async()=>{
  const f=await make(1);const p=f.assessment.createPlan(f.project.id,raw(f.planRequest));const output=join(f.project.workspace,f.manifest.outputs[0]!.path),original=await readFile(output);await writeFile(output,'changed');expect(()=>f.assessment.getPlan(f.project.id,p.id)).toThrow('stale');await writeFile(output,original);expect(f.assessment.getPlan(f.project.id,p.id).id).toBe(p.id)
 })
 it('returns source transient or rate-limit failure without persisting a false engineering result',async()=>{
  const f=await make(1);const p=f.assessment.createPlan(f.project.id,raw(f.planRequest)),s=f.score(f.unitIds[0]!);f.advance();const spy=vi.spyOn(f.sources,'getScore');spy.mockImplementation(()=>{throw new SurveyQualityScoringError('rate-limit')});expect(()=>f.assessment.createAssessment(f.project.id,raw(req(p,[{unitId:f.unitIds[0]!,scoringRecordId:s.id}])))).toThrow('rate-limit');spy.mockImplementation(()=>{throw new Error('offline')});expect(()=>f.assessment.createAssessment(f.project.id,raw(req(p,[{unitId:f.unitIds[0]!,scoringRecordId:s.id}])))).toThrow('unavailable');expect(f.assessment.list(f.project.id,'assessments').records).toHaveLength(0)
 })
 it('lists ten saved records with zero retention/sampling/scoring source reads and explicit stale summary semantics',async()=>{
  const f=await make(1);const p=f.assessment.createPlan(f.project.id,raw(f.planRequest));for(let i=0;i<11;i++){f.advance();f.assessment.createAssessment(f.project.id,raw(req(p,[],`independent-result-${i}`)))}f.advance();const spies=['retentionSnapshot','getPopulation','getRun','listSamples','getScore'].map(k=>vi.spyOn(f.sources,k as 'getScore'));const list=f.assessment.list(f.project.id,'assessments');expect(list.records).toHaveLength(10);expect(list.nextOffset).toBe(10);expect(list.records.every(r=>r.view==='saved-summary-only'&&r.dependencyVerification==='not-performed-on-list')).toBe(true);for(const s of spies)expect(s).not.toHaveBeenCalled()
 })
 it('strictly rejects approval/signature/status injection before any new record is persisted',async()=>{
  const f=await make(1);for(const extra of [{approved:true},{actor:'engineer'},{humanSignature:'signed'},{reviewStatus:'approved'}])expect(()=>f.assessment.createPlan(f.project.id,raw({...f.planRequest,...extra}))).toThrow('validation');expect(f.assessment.list(f.project.id,'assessment_plans').records).toHaveLength(0)
 })
 it('rejects accuracy component and different product-profile records even when unit IDs match',async()=>{
  const f=await make(1);const p=f.assessment.createPlan(f.project.id,raw(f.planRequest));const component=qualityScoringTestRequest('accuracy','independent-component');const declaration=JSON.parse(component.declarationJson);declaration.unitId=f.unitIds[0]!;component.declarationJson=JSON.stringify(declaration);const record=f.scoring.createRecord(f.project.id,raw(component));const height=f.score(f.unitIds[0]!,d=>{d.productProfileId='height-control-section';d.unitType='section';d.profileWeightTable=45;d.profileClassificationTable=46});f.advance();for(const id of [record.id,height.id])expect(()=>f.assessment.createAssessment(f.project.id,raw(req(p,[{unitId:f.unitIds[0]!,scoringRecordId:id}])))).toThrow('validation')
 })
 it('rejects retained blob replacement independently of unchanged source output',async()=>{
  const f=await make(1);const p=f.assessment.createPlan(f.project.id,raw(f.planRequest)),member=p.snapshot.artifact.members.find(m=>m.id==='output-1')!;const bytes=await f.outputBytes();const path=join(f.runtime,'quality-blobs',member.sha256);const blob=await readFile(path);blob[0]=blob[0]!^1;await writeFile(path,blob);expect(()=>f.assessment.getPlan(f.project.id,p.id)).toThrow('integrity');expect(await f.outputBytes()).toEqual(bytes)
 })
 it('rejects malformed retained JSON as integrity, preserving unavailable for real source outages',async()=>{
  const f=await make(1);f.completeRetention();const p=f.assessment.createPlan(f.project.id,raw(f.planRequest));const db=new Database(join(f.runtime,'survey-quality.sqlite3'));try{db.exec('DROP TRIGGER quality_events_no_update');db.prepare('UPDATE quality_events SET data_json=?').run('{')}finally{db.close()}expect(()=>f.assessment.getPlan(f.project.id,p.id)).toThrow('integrity')
 })
 it('rejects changed project revision before repeating dependency work',async()=>{
  const f=await make(1);const p=f.assessment.createPlan(f.project.id,raw(f.planRequest));const read=vi.spyOn(f.sources,'retentionSnapshot');f.sources.getProject=(pid)=>pid===f.project.id?{...f.project,revision:2}:null;expect(()=>f.assessment.getPlan(f.project.id,p.id)).toThrow('stale');expect(read).not.toHaveBeenCalled();expect(f.assessment.list(f.project.id,'assessment_plans').unavailable).toEqual([{id:p.id,reason:'stale'}])
 })

 it('preserves hard source limit separately from retryable rate-limit',async()=>{
  const f=await make(1);const p=f.assessment.createPlan(f.project.id,raw(f.planRequest)),s=f.score(f.unitIds[0]!);f.advance();vi.spyOn(f.sources,'getScore').mockImplementation(()=>{throw new SurveyQualityScoringError('limit')});try{f.assessment.createAssessment(f.project.id,raw(req(p,[{unitId:f.unitIds[0]!,scoringRecordId:s.id}])));throw new Error('expected rejection')}catch(error){expect((error as {reason:string}).reason).toBe('limit')}
 })

})
