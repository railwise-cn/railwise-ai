import { fileURLToPath } from 'node:url'
const { runSurveyVceTrial } = await import(process.env.VCE_REVIEW_WORKTREE ? `${process.env.VCE_REVIEW_WORKTREE}/kun/src/engineering/survey-vce-trial.ts` : new URL('../../../../../../kun/src/engineering/survey-vce-trial.ts', import.meta.url).href)
import { writeFileSync } from 'node:fs'
const outputs=[]
for(const n of [3,4,5,6])for(const a of [.01,.02,.03,.1]){
 const input={schemaVersion:1,model:'fixed-linear-independent-disjoint-variance-groups',unit:'mm',parameterIds:['common','first-only'],groups:[{id:'first',initialVariance:1e-6,sourceAnchor:'exact'},{id:'remaining',initialVariance:1e6,sourceAnchor:'exact'}],observations:Array.from({length:n},(_,i)=>({id:`o${i}`,value:i?i*2-1:0,coefficients:i?[a,0]:[1,1],groupId:i?'remaining':'first',relativeVariance:i?1e-6:1e6,sourceAnchor:'exact'})),maxIterations:1,relativeTolerance:1e-12}
 const result=runSurveyVceTrial(input);outputs.push({n,a,residualDegreesOfFreedom:n-2,outcome:result.outcome,iterations:result.iterations})
}
writeFileSync(new URL('./projected-zero-group-after-fix.json', import.meta.url),JSON.stringify(outputs,null,2)+'\n');console.log(JSON.stringify(outputs.filter(x=>x.iterations.length),null,2))
