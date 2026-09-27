import {readFileSync,writeFileSync} from 'node:fs'
import {dirname,resolve,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const dir=dirname(fileURLToPath(import.meta.url));const repo=resolve(process.argv[2]);const {compareSurveyReferenceDatumV1:run}=await import(pathToFileURL(join(repo,'kun/dist/engineering/survey-reference-datum.js')).href)
const cases=JSON.parse(readFileSync(join(dir,'cases.json'))).cases
const output=cases.map(({name,request})=>({name,result:run(request)}));writeFileSync(join(dir,'outputs.json'),JSON.stringify({node:process.version,cases:output},null,2)+'\n');console.log(JSON.stringify({count:output.length,unavailable:output.filter(x=>x.result.outcome!=='calculated').map(x=>({name:x.name,outcome:x.result.outcome,code:x.result.code}))}))
