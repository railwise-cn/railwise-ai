import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { assessmentFixture } from './dist/engineering/survey-quality-assessment-test-helpers.js'
const f=await assessmentFixture(3),raw=v=>Buffer.from(JSON.stringify(v));
try{
 f.completeRetention();const p=f.assessment.createPlan(f.project.id,raw(f.planRequest));const scores=f.unitIds.map(unitId=>({unitId,scoringRecordId:f.score(unitId).id}));f.advance();
 const request={schemaVersion:1,acknowledged:true,expectedProjectRevision:1,idempotencyKey:'independent-compiled-1',assessmentPlanId:p.id,expectedPlanHash:p.planHash,unitScores:scores};
 const before=(await f.outputBytes()).map(b=>createHash('sha256').update(b).digest('hex')),audits=f.auditCount();
 const r=f.assessment.createAssessment(f.project.id,raw(request));assert.equal(r.result.overallLinkage,'complete-declared-linkage');assert.equal(r.manifestReviewStatus,'draft');assert.equal(r.approvalCapability,'none');
 f.advance();assert.deepEqual(f.restart().getAssessment(f.project.id,r.id),r);assert.equal(f.auditCount(),audits);assert.deepEqual((await f.outputBytes()).map(b=>createHash('sha256').update(b).digest('hex')),before);
 f.append('artifact-bytes');f.advance();assert.throws(()=>f.assessment.getAssessment(f.project.id,r.id),e=>e.reason==='source-changed');assert.deepEqual(f.assessment.getPlan(f.project.id,p.id),p);
 const fresh=f.assessment.createAssessment(f.project.id,raw({...request,idempotencyKey:'independent-compiled-2'}));assert.equal(fresh.result.overallLinkage,'complete-declared-linkage');assert.notEqual(fresh.sourceVector.retentionHeadHash,r.sourceVector.retentionHeadHash);
 await writeFile('/private/tmp/railwise-assessment-independent-review/compiled-smoke.json',JSON.stringify({scope:'synthetic-cross-service-compiled-not-packaged-acceptance',node:process.versions.node,units:3,tests:['exact full sample linked','restart identical','new head invalidates historical current verification','same plan permits new assessment','draft/output/audit unchanged'],result:r.result,hashes:before,verificationAuditCount:audits,boundaries:{approvalCapability:r.approvalCapability,deliverableVerification:r.deliverableVerification},passed:true},null,2));
 console.log('compiled smoke: 5 checks passed')
}finally{await f.close()}
