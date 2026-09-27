import { readFileSync, writeFileSync } from 'node:fs'
const tree = process.argv[2] ?? process.cwd()
const { runSurveyHuberTrial } = await import(`${tree}/kun/src/engineering/survey-huber-trial.ts`)
const base = import.meta.dir
const number = (value: string | number) => typeof value === 'number' ? value : value.includes('/') ? value.split('/').map(Number).reduce((a,b)=>a/b) : Number(value)
function input(model: any, initial?: number[]) {
 const p=model.A[0].length
 return {schemaVersion:1,model:'fixed-linear-full-column-rank',independenceDeclaration:'caller-declared-independent-observations',residualConvention:'observed-minus-fitted',observationUnit:'m',parameterIds:Array.from({length:p},(_,i)=>`parameter-${i}`),parameterUnits:Array(p).fill('m'),initialParameters:initial??Array(p).fill(0),scale:{kind:'fixed-external',value:number(model.scale??1),unit:'m',basisStatement:'Independent synthetic exact-oracle review.'},loss:{kind:'huber',k:number(model.k??1)},observations:model.y.map((v:any,i:number)=>({id:`observation-${i}`,value:number(v),coefficients:model.A[i].map(number),relativeSigma:number(model.sigma?.[i]??1),sourceAnchor:'synthetic-oracle'})),stopping:{maxIterations:200,standardizedPredictionStepTolerance:1e-10,relativeObjectiveTolerance:1e-10,normalizedScoreTolerance:1e-10}}
}
const cases=['huber-exact-cases.json','huber-random-exact-cases.json'].flatMap(file=>JSON.parse(readFileSync(`${base}/${file}`,'utf8')))
const results=cases.map((c:any)=>{const out=runSurveyHuberTrial(input(c.input));const state=out.states.at(-1);const expected=number(c.candidateMinima[0].objective);return{id:c.id,outcome:out.outcome,reason:out.reason,iterations:out.states.length-1,parameters:out.acceptedParameters,lastState:state,objective:state?.objective,objectiveError:state?Math.abs(state.objective-expected)/Math.max(1,Math.abs(expected)):null,score:state?.normalizedScoreInfinity,scoreError:state?.scoreRoundoffEstimate,uniqueness:out.uniquenessAssessment,exactMultiple:c.multipleExactMinimizersFound,...(!c.multipleExactMinimizersFound&&out.acceptedParameters?{parameterError:Math.max(...out.acceptedParameters.map((v:number,i:number)=>Math.abs(v-number(c.candidateMinima[0].parameters[i]))/Math.max(1,Math.abs(number(c.candidateMinima[0].parameters[i])))))}:{})}})
const extras=[
 {id:'quadratic-energy-underflow',A:[[1],[1]],y:[0,1e-150],scale:1e12,sigma:[1e8,1e8]},
 {id:'giant-constant-loss',A:[[1],[1],[0]],y:[0,2,1e150]},
 {id:'huge-offset',A:[[1],[1],[1],[1]],y:[1e16,1e16,1e16+4,1e16+100]},
 {id:'flat-interior-initial',A:[[1],[1],[1],[1]],y:[0,0,10,10],initial:[5]},
 {id:'extreme-product',A:[[1e150],[1e150]],y:[0,1],scale:1e-12,sigma:[1e-8,1e-8],initial:[1e150]},
]
const extraResults=extras.map(c=>{const out=runSurveyHuberTrial(input(c,c.initial));return{id:c.id,outcome:out.outcome,reason:out.reason,uniqueness:out.uniquenessAssessment,parameters:out.acceptedParameters,last:out.states.at(-1)}})
writeFileSync(`${base}/huber-probe-results.json`,JSON.stringify({results,extraResults},null,2)+'\n')
console.log(JSON.stringify({cases:results.length,counts:results.reduce((a:any,x:any)=>(a[x.outcome]=(a[x.outcome]??0)+1,a),{}),maxObjectiveError:Math.max(...results.filter((x:any)=>x.outcome==='stationary').map((x:any)=>x.objectiveError)),maxParameterError:Math.max(...results.filter((x:any)=>x.outcome==='stationary'&&x.parameterError!==undefined).map((x:any)=>x.parameterError)),suspect:results.filter((x:any)=>x.outcome==='stationary'&&(x.objectiveError>1e-8||x.parameterError>1e-7||x.exactMultiple&&x.uniqueness==='strict-inlier-full-rank-sufficient-condition')),extras:extraResults.map(({last,...rest})=>({...rest,iterations:last?.iteration,objective:last?.objective,score:last?.normalizedScoreInfinity}))},null,2))

if (results.some((x:any)=>x.outcome!=='stationary'||x.objectiveError>1e-8||x.parameterError>1e-7||x.exactMultiple&&x.uniqueness==='strict-inlier-full-rank-sufficient-condition')) throw new Error('Independent Huber oracle regression')
