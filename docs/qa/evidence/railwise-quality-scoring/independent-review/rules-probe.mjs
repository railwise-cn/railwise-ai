import {readFileSync,writeFileSync} from 'node:fs'
import {dirname,resolve,join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
const dir=dirname(fileURLToPath(import.meta.url)),repo=resolve(process.argv[2]);const prefix=process.env.REVIEW_COMPILED?'kun/dist/engineering/':'kun/src/engineering/',extension=process.env.REVIEW_COMPILED?'.js':'.ts';const R=await import(pathToFileURL(join(repo,prefix+'survey-quality-scoring-rules'+extension)).href);const X=await import(pathToFileURL(join(repo,prefix+'survey-quality-scoring-exact'+extension)).href)
const rational=x=>x&&typeof x==='object'&&'numerator'in x?X.exact(BigInt(x.numerator),BigInt(x.denominator)):X.parseExact(String(x))
const opt=x=>x===null?null:rational(x)
const row=x=>({...x,...(x.score===undefined?{}:{score:rational(x.score)})})
const encoded=x=>typeof x==='bigint'?String(x):Array.isArray(x)?x.map(encoded):x&&typeof x==='object'?('n'in x&&'d'in x?{numerator:String(x.n),denominator:String(x.d)}:Object.fromEntries(Object.entries(x).map(([k,v])=>[k,encoded(v)]))):x
const cases=JSON.parse(readFileSync(join(dir,'original-boundaries.json'))).cases,outputs=[]
for(const c of cases){const i=c.input;let r
switch(c.operation){case'accuracy':r=R.accuracy(rational(i.m),rational(i.m0));break;case'accuracy_aggregate':r=R.multiple(i.scores.map(opt),i.weights?.map(rational));break;case'deduction':r=R.deduction(i.a,i.b,i.c,i.d,rational(i.t));break;case'grade':r=R.grade(rational(i.score));break;case'unit':r=R.unit(i.scores.map(opt),i.weights.map(rational),i.a,i.complete);break;case'sample':r=R.sample(i.units.map(row));break;case'overview':r=R.overview(i.a,i.b);break;case'final_batch':r=R.finalBatch(i.e,i.g,i.q,i.qualified,i.complete);break;case'acceptance_batch':r=R.acceptance(i.detailed,i.overview,i.fabricated,i.major);break;case'hierarchical_partial':continue;default:throw new Error('Unmapped operation '+c.operation)}
const actual=encoded(r);for(const[k,v]of Object.entries(c.expected)){if(k==='reason')continue;assert.deepEqual(actual[k],typeof v==='number'&&actual[k]&&typeof actual[k]==='object'&&'numerator'in actual[k]?{numerator:String(v),denominator:'1'}:v,c.id+':'+k)}outputs.push({id:c.id,actual})}
writeFileSync(join(dir,'rules-results.json'),JSON.stringify({passed:outputs.length,skipped:'2 generic hierarchical cases replaced by public profile corpus',outputs},null,2)+'\n');console.log(JSON.stringify({passed:outputs.length}))
