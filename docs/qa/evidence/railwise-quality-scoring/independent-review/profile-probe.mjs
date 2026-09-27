import {readFileSync,writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {dirname,resolve,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
import {unitRequest,batchRequest,leafMap} from './request-fixtures.mjs'
const dir=dirname(fileURLToPath(import.meta.url)),repo=resolve(process.argv[2]);const productionPath=process.env.REVIEW_COMPILED?'kun/dist/engineering/survey-quality-scoring.js':'kun/src/engineering/survey-quality-scoring.ts';const {scoreSurveyQualityV1:run}=await import(pathToFileURL(join(repo,productionPath)).href)
const cases=JSON.parse(readFileSync(join(dir,'profile-boundaries.json')));let count=0;const checksum=createHash('sha256');const elementMap={data:'data-quality',point:'point-quality',materials:'material-quality'}
for(const profile of ['planar-control-point','height-control-section'])for(const c of cases.profileCases){const scores=Object.fromEntries(Object.entries(c.scores).map(([k,v])=>[k,Number(v.numerator)/Number(v.denominator)]));const request=unitRequest(scores,c.scope,profile),r=run(request);assert.equal(r.result.state,'calculated',c.name+':'+r.result.reason);assert.deepEqual(r.result.score,c.expected.score,c.name);assert.equal(r.result.grade,c.expected.grade,c.name);assert.equal(r.scopeAssessment,c.scope.length===7?'complete-declared-product-profile':'partial-declared-product-profile');assert.equal(r.checkedSubelementIds.length,c.scope.length);assert.equal(r.excludedSubelementIds.length,7-c.scope.length);assert.deepEqual(r.pendingSubelementIds,[])
for(const[k,v]of Object.entries(c.expected.elementWeights)){const trace=r.trace.find(x=>x.nodeId===elementMap[k]);assert.deepEqual(trace.effectiveWeight,v,c.name+':'+k);assert.deepEqual(trace.result.score,c.expected.elementScores[k]);for(const[leaf,w]of Object.entries(c.expected.leafWeights[k]))assert.deepEqual(r.trace.find(x=>x.nodeId===leafMap[leaf][1]).effectiveWeight,w,c.name+':'+leaf)}
checksum.update(JSON.stringify(r));count++}
for(const c of cases.batchCases){const r=run(batchRequest(c.e,c.g,c.q));assert.equal(r.result.state,'calculated');assert.equal(r.result.grade,c.grade,JSON.stringify(c));assert.equal(r.result.count,c.e+c.g+c.q);checksum.update(JSON.stringify(r));count++}
const summary={passed:count,profileCases:2*cases.profileCases.length,finalBatchCases:cases.batchCases.length,resultSha256:checksum.digest('hex'),module:productionPath};writeFileSync(join(dir,'profile-results.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary))
