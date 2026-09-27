import { fileURLToPath } from 'node:url'
const { runSurveyVceTrial } = await import(process.env.VCE_REVIEW_WORKTREE ? `${process.env.VCE_REVIEW_WORKTREE}/kun/src/engineering/survey-vce-trial.ts` : new URL('../../../../../../kun/src/engineering/survey-vce-trial.ts', import.meta.url).href)
import { writeFileSync } from 'node:fs'
const failures: unknown[]=[];const counts: Record<string,number>={}
for (let i=0;i<=2000;i++) {
 const ratio=10**(6+i/1000)
 for (const reversed of [false,true]) {
  const input={schemaVersion:1,model:'fixed-linear-independent-disjoint-variance-groups',unit:'m',parameterIds:['x'],groups:[{id:'g0',initialVariance:reversed?ratio:1,sourceAnchor:'exact'},{id:'g1',initialVariance:reversed?1:ratio,sourceAnchor:'exact'}],observations:[{id:'o0',value:0,coefficients:[1],groupId:'g0',relativeVariance:1,sourceAnchor:'exact'},{id:'o1',value:1,coefficients:[1],groupId:'g1',relativeVariance:1,sourceAnchor:'exact'}],maxIterations:1,relativeTolerance:1e-10}
  const result=runSurveyVceTrial(input);counts[result.outcome]=(counts[result.outcome]??0)+1
  if(result.iterations.length)failures.push({ratio,reversed,result})
 }
}
const output={description:'n=2 p=1 implies scalar residual space; two disjoint variance components are exactly unidentifiable for every positive covariance ratio.',counts,incorrectlyProducedCandidates:failures.length,firstFailures:failures.slice(0,10)}
writeFileSync(new URL('./unidentifiable-probe-output.json', import.meta.url),JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify(output,null,2))
