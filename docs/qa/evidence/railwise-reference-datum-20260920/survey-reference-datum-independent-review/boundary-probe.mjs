import {readFileSync,writeFileSync} from 'node:fs'
import {dirname,resolve,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
const dir=dirname(fileURLToPath(import.meta.url)),repo=resolve(process.argv[2]);const {compareSurveyReferenceDatumV1:run}=await import(pathToFileURL(join(repo,'kun/dist/engineering/survey-reference-datum.js')).href)
const cases=JSON.parse(readFileSync(join(dir,'boundaries.json'))).cases,outputs=[]
for(const {name,request,expected} of cases){const result=run(request);for(const[k,v]of Object.entries(expected))assert.equal(k==='classification'?result.covarianceCheck?.classification:result[k],v,name+':'+k);assert.equal(result.formalCoordinatesModified,false);assert.equal(result.sourceRecordsVerified,false);assert.equal(result.referenceSelection,'caller-declared-no-automatic-selection');if(result.covarianceCheck)assert.equal(result.covarianceCheck.matrixRepair,'none');if(name.startsWith('near-indefinite-retained')){assert.ok(result.covarianceCheck.minimumCorrelationEigenvalueEstimate<0);assert.deepEqual(result.request,request);assert.equal(result.differenceCovariance[0][1],2*request.firstEpoch.covariance[0][1]);assert.equal(result.displacementCovariance.length,3)}outputs.push({name,result})}
writeFileSync(join(dir,'boundary-results.json'),JSON.stringify({node:process.version,passed:outputs.length,outputs},null,2)+'\n');console.log(JSON.stringify({passed:outputs.length}))
