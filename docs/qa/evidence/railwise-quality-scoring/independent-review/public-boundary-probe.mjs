import {writeFileSync} from 'node:fs'
import {dirname,resolve,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {unitRequest,accuracyRequest,accuracyModel,defects,deductionRequest,overviewRequest,sampleRequest,batchRequest,acceptanceRequest,base} from './request-fixtures.mjs'
const dir=dirname(fileURLToPath(import.meta.url)),repo=resolve(process.argv[2]),module=process.env.REVIEW_COMPILED?'kun/dist/engineering/survey-quality-scoring.js':'kun/src/engineering/survey-quality-scoring.ts';const {scoreSurveyQualityV1:run}=await import(pathToFileURL(join(repo,module)).href)
const outputs=[];const E=(n,d=1)=>({numerator:String(n),denominator:String(d)});const clone=structuredClone
function check(name,q,state,extra=()=>{}){const frozen=JSON.stringify(q);const r=run(q);assert.equal(r.result.state,state,name+':'+r.result.reason);assert.equal(JSON.stringify(q),frozen,name+':input-mutated');assert.equal(r.evidenceAuthenticity,'not-verified');assert.equal(r.classificationAuthenticity,'not-verified');assert.equal(r.priorQualificationAuthenticity,'not-verified');assert.equal(r.formalResultsModified,false);assert.equal(r.observationAction,'none');assert.equal(r.humanSignatureVerification,'not-evaluated');if(state!=='calculated'){assert.equal(r.result.score,null);assert.equal(r.result.grade,null);assert.notEqual(r.result.qualified,true)}extra(r);outputs.push({name,result:r});return r}
const pending=leaf=>({elementId:leaf.elementId,subelementId:leaf.subelementId,state:'pending',reason:'Inspection not completed',evidenceRefs:['pending-evidence']})
for(let idx=0;idx<7;idx++){let q=unitRequest();q.leaves[idx]=pending(q.leaves[idx]);check('pending-leaf-'+idx,q,'unavailable',r=>{assert.equal(r.scopeAssessment,'unresolved-declared-product-profile');assert.equal(r.pendingSubelementIds.length,1);assert.equal(r.excludedSubelementIds.length,0)})}
for(let idx=1;idx<7;idx++){let q=unitRequest();q.leaves[idx].record.defects.d=41;check('low-leaf-veto-'+idx,q,'nonconforming',r=>assert.deepEqual(r.trace.find(t=>t.nodeId===q.leaves[idx].subelementId).result.rawScore,E(59)));q.leaves[0]=pending(q.leaves[0]);check('low-leaf-with-missing-sibling-'+idx,q,'nonconforming')}
for(let idx=0;idx<7;idx++){let q=unitRequest();if(idx===0)q.leaves[idx].record.model.aCount=1;else q.leaves[idx].record.defects.a=1;check('A-leaf-veto-'+idx,q,'nonconforming')}
check('partial-explicit-scope',unitRequest({'observation-quality':60},['observation-quality']),'calculated',r=>{assert.equal(r.scopeAssessment,'partial-declared-product-profile');assert.deepEqual(r.result.score,E(60));assert.equal(r.excludedSubelementIds.length,6)})
check('all-excluded',unitRequest({},[]),'unavailable')
let q=unitRequest();q.leaves.pop();check('missing-leaf-not-exclusion',q,'invalid')
q=unitRequest();q.leaves[6]=clone(q.leaves[5]);check('duplicate-leaf',q,'invalid')
q=unitRequest();q.leaves[1].elementId='point-quality';check('wrong-parent',q,'invalid')
q=unitRequest();q.leaves[0].record={kind:'deduction',defects:defects()};check('math-no-deduction-route',q,'invalid')
q=unitRequest();q.leaves[1].record={kind:'accuracy',model:accuracyModel()};check('nonmath-no-accuracy-route',q,'invalid')
q=unitRequest();q.leaves.reverse();check('leaf-order-invariance',q,'calculated',r=>assert.deepEqual(r.result.score,E(100)))
for(const field of ['a','b','c','d']){q=deductionRequest();q.defects[field]=null;check('missing-defect-'+field,q,'unavailable')}
q=deductionRequest();q.defects={...q.defects,a:null,b:4,c:null,d:null};check('known-counts-fail-despite-missing',q,'nonconforming',r=>assert.deepEqual(r.result.diagnosticScoreUpperBound,E(52)))
q=deductionRequest();q.defects.b=9;check('negative-raw-score-retained',q,'nonconforming',r=>assert.deepEqual(r.result.rawScore,E(-8)))
q=deductionRequest();q.defects.a=1;q.defects.t='2';check('A-veto-over-adjusted-t',q,'nonconforming',r=>assert.deepEqual(r.result.fixedADeduction,E(42)))
q.defects.t='0';check('invalid-t-before-A',q,'invalid')
q=deductionRequest();q.defects.t='2';check('adjusted-t-not-supported',q,'unavailable')
q=deductionRequest();q.subelementId='mathematical-accuracy';check('math-zero-counts-not-score100',q,'unavailable');q.defects.b=1;check('math-BCD-profile-invalid',q,'invalid');q.defects.b=0;q.defects.a=1;check('math-A-known-veto',q,'nonconforming')
q=accuracyRequest(accuracyModel(60));check('single-accuracy-60',q,'calculated',r=>assert.deepEqual(r.result.score,E(60)));q.model.items.push({...q.model.items[0],id:'second',m:'0'});check('multi-accuracy-60-unresolved',q,'unavailable')
q.model.items[0].m='0.999999999999999999999999';check('multi-accuracy-strict-above-60-at-24-decimals',q,'calculated',r=>assert.ok(BigInt(r.result.score.numerator)>80n*BigInt(r.result.score.denominator)))
q.model.aggregation={kind:'weighted',weights:['0.5','0.500000000000000000000001'],basisStatement:'Explicit synthetic weights',evidenceRefs:['weights']};check('exact-weight-sum-not-float-rounded',q,'invalid')
q=accuracyRequest();q.model.items[0].m='1.000000000000000000000001';check('accuracy-above-m0-no-extrapolation',q,'unavailable');q.model.aCount=1;check('accuracy-overlimit-with-separate-A',q,'nonconforming')
q=accuracyRequest();q.model.items[0].m=null;check('missing-magnitude',q,'unavailable');q.model.aCount=1;check('A-over-missing-magnitude',q,'nonconforming');q.model.items[0].m='-1';check('invalid-domain-before-A',q,'invalid')
q=accuracyRequest();q.model.aCount=null;check('missing-A-not-zero',q,'unavailable')
q=accuracyRequest();q.model.items[0].m='0.300000000000000000000001';check('above-03-not-rounded-to100',q,'calculated',r=>assert.ok(BigInt(r.result.score.numerator)<100n*BigInt(r.result.score.denominator)))
for(const mutation of [x=>{x.sourceDigest='0'.repeat(64)},x=>{x.profileWeightTable=45},x=>{x.unitType='section'},x=>{x.evidenceRefs=[]},x=>{x.model.items[0].m=0.3},x=>{x.model.items[0].m='1e-10'},x=>{x.model.items[0].m='1/0'},x=>{x.model.items[0].m='0'.repeat(100)},x=>{x.model.aEvidenceRefs=[]}]){q=accuracyRequest();mutation(q);check('invalid-source-or-input-'+outputs.length,q,'invalid')}
const su=(id,score)=>({unitId:id,state:'qualified',declaredUnitCoverage:'full-product-profile',score,evidenceRefs:['declared-complete-unit']})
q=sampleRequest([su('a','60'),su('b','100')]);check('sample-arithmetic-80',q,'calculated',r=>assert.deepEqual(r.result.score,E(80)))
q=sampleRequest([su('a','89.999999999999999999999999')]);check('sample-grade-below90-not-rounded',q,'calculated',r=>assert.equal(r.result.grade,'good'))
q=sampleRequest([su('a','100')]);q.declaredUnitIds.push('b');check('sample-missing-member',q,'unavailable');q.units[0]={unitId:'a',state:'nonconforming',reason:'Known failed record',evidenceRefs:['failed']};check('sample-fail-over-missing',q,'nonconforming')
q=sampleRequest([su('a','100')]);q.units[0].declaredUnitCoverage='partial-product-profile';check('partial-scope-cannot-promote-sample',q,'invalid')
q=sampleRequest([su('a','59'),{unitId:'b',state:'nonconforming',reason:'Failed',evidenceRefs:['failed']}]);check('invalid-qualified-score-before-known-sample-fail',q,'invalid')
for(const [a,b,state]of [[0,3,'calculated'],[0,4,'nonconforming'],[1,null,'nonconforming'],[null,4,'nonconforming'],[null,3,'unavailable']])check('overview-'+a+'-'+b,overviewRequest(a,b),state)
q=batchRequest(499999,400001,100000);check('batch-below50-percent-no-rounding',q,'calculated',r=>assert.equal(r.result.grade,'good'))
for(const status of ['incomplete','unknown']){q=batchRequest(0,0,0);q.declaredBatchUnitCount=10;q.membershipStatus=status;check('empty-known-counts-'+status,q,'unavailable',r=>assert.equal(r.result.count,10));q.priorBatchQualification='failed';check('failed-batch-without-counts-'+status,q,'nonconforming',r=>assert.equal(r.result.count,10))}
q=batchRequest(0,0,0);q.declaredBatchUnitCount=10;check('complete-counts-contradict-N',q,'invalid')
q=batchRequest();q.declaredBatchUnitCount=11;check('denominator-mismatch-not-renormalized',q,'invalid')
q=batchRequest();q.priorBatchQualification='unknown';check('batch-prerequisite-unknown',q,'unavailable')
for(const ov of ['qualified','not-performed','pending','unknown','missing','failed'])check('acceptance-overview-'+ov,acceptanceRequest(ov),ov==='qualified'||ov==='not-performed'?'calculated':ov==='failed'?'nonconforming':'unavailable',r=>assert.equal(r.result.grade,null))
q=acceptanceRequest('not-performed');q.overviewNotPerformedBasis=null;check('not-performed-needs-basis',q,'invalid')
q=acceptanceRequest('pending');q.overviewNotPerformedBasis='claimed omission';check('pending-cannot-claim-omission-basis',q,'invalid')
for(const field of ['fabricatedResults','majorTechnicalRouteDeviation']){q=acceptanceRequest('pending');q[field]=true;check('acceptance-veto-'+field,q,'nonconforming');q=acceptanceRequest();q[field]=null;check('acceptance-unknown-'+field,q,'unavailable')}
writeFileSync(join(dir,'public-boundary-results.json'),JSON.stringify({passed:outputs.length,module,outputs},null,2)+'\n');console.log(JSON.stringify({passed:outputs.length,module}))
