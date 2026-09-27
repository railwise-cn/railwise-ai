import { fileURLToPath } from 'node:url'
const { runSurveyVceTrial } = await import(process.env.VCE_REVIEW_WORKTREE ? `${process.env.VCE_REVIEW_WORKTREE}/kun/src/engineering/survey-vce-trial.ts` : new URL('../../../../../../kun/src/engineering/survey-vce-trial.ts', import.meta.url).href)
import { writeFileSync } from 'node:fs'
const failures=[];const counts:Record<string,number>={}
for(const n of [3,4,5,6])for(const a of [.01,.02,.03,.1])for(const y0 of [.1,.3,1,Math.PI,10,1e4])for(const shift of [0,100,1e4]){
 const input={schemaVersion:1,model:'fixed-linear-independent-disjoint-variance-groups',unit:'mm',parameterIds:['common','first-only'],groups:[{id:'first',initialVariance:1e-6,sourceAnchor:'exact'},{id:'remaining',initialVariance:1e6,sourceAnchor:'exact'}],observations:Array.from({length:n},(_,i)=>({id:`o${i}`,value:shift+(i?i*2-1:y0),coefficients:i?[a,0]:[1,1],groupId:i?'remaining':'first',relativeVariance:i?1e-6:1e6,sourceAnchor:'exact'})),maxIterations:100,relativeTolerance:1e-10}
 const result=runSurveyVceTrial(input);counts[result.outcome]=(counts[result.outcome]??0)+1
 if(result.outcome==='converged'||result.iterations.some(step=>step.candidateVariances[0]>0))failures.push({n,a,y0,shift,outcome:result.outcome,converged:result.convergedVariances,iterations:result.iterations})
}
const output={description:'First observation is fully fitted by a dedicated parameter; its variance is exactly unidentifiable independent of y.',counts,spuriousPositiveCandidateOrConvergence:failures.length,failures:failures.slice(0,8)}
writeFileSync(new URL('./false-convergence-after-fix.json', import.meta.url),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({counts,count:failures.length,first:failures[0]},null,2))
