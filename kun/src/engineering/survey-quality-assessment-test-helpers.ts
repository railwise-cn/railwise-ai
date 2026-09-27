import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { EngineeringService } from './engineering-service.js'
import { SurveyQualityWorkspaceService } from './survey-quality-workspace.js'
import { SurveySamplingWorkspaceService } from './survey-sampling-workspace.js'
import { SurveyQualityScoringWorkspaceService } from './survey-quality-scoring-workspace.js'
import { SurveyQualityAssessmentService, type AssessmentSources } from './survey-quality-assessment.js'
import { qualityScoringTestDeclaration } from './survey-quality-scoring-test-helpers.js'
import type { SurveyQualityScoringInputV1 } from '../contracts/survey-quality-scoring.js'
export async function assessmentFixture(unitCount=3) {
  const root=await mkdtemp(join(tmpdir(),'quality-assessment-')),runtime=join(root,'runtime'),workspace=join(root,'workspace')
  let clock=Date.parse('2026-09-20T00:00:00Z')
  const nowIso=()=>new Date(clock).toISOString(),clockMs=()=>clock,advance=()=>{clock+=61_000}
  const engineering=new EngineeringService({rootDir:runtime,nowIso})
  const project=engineering.createProject({name:'Synthetic declared linkage only',workspace,expectedRevision:0,idempotencyKey:'assessment-project'})
  const dataset=await engineering.importDataset({projectId:project.id,expectedRevision:project.revision,idempotencyKey:'assessment-import',name:'synthetic.csv',dataBase64:Buffer.from('point,time,value\nP1,2026-09-01,1\nP1,2026-09-02,2').toString('base64')})
  const validated=engineering.validateDataset({datasetId:dataset.id,expectedRevision:dataset.revision,idempotencyKey:'assessment-validate'})
  const analysis=engineering.createAnalysis({projectId:project.id,datasetId:dataset.id,expectedRevision:validated.revision,idempotencyKey:'assessment-analysis'})
  const manifest=await engineering.finalize({projectId:project.id,datasetId:dataset.id,analysisId:analysis.id,expectedRevision:validated.revision,idempotencyKey:'assessment-finalize',acknowledgeWarnings:true})
  const getProject=(pid:string)=>engineering.getProject(pid),getManifest=(pid:string,id:string)=>engineering.getManifestForProject(pid,id)
  const retention=new SurveyQualityWorkspaceService({rootDir:runtime,nowIso,getProject,getManifest})
  const sampling=new SurveySamplingWorkspaceService({rootDir:runtime,nowIso,getProject})
  const scoring=new SurveyQualityScoringWorkspaceService({rootDir:runtime,nowIso,clockMs,getProject})
  const frozen=retention.createPlan(project.id,{manifestId:manifest.id,expectedProjectRevision:project.revision,idempotencyKey:'assessment-retention-plan',requiredEvidence:[{id:'support',title:'Synthetic source reference',memberId:'output-1'},{id:'other',title:'Original unmapped required check',memberId:'output-2'}]})
  let retained=retention.createRecord(project.id,{planId:frozen.plan.id,idempotencyKey:'assessment-retention-record'})
  let sequence=0
  const append=(checkId:string)=>{
    const requirement=frozen.plan.requiredEvidence.find(r=>`evidence:${r.id}`===checkId)
    const evidence=requirement?retention.retainEvidence(project.id,{artifactId:frozen.artifact.id,memberId:requirement.memberId,idempotencyKey:`assessment-retain-${sequence}`}):null
    retained=retention.appendCheck(project.id,retained.record.id,{checkId,expectedHeadHash:retained.verification.headHash,idempotencyKey:`assessment-check-${sequence++}`,...(evidence?{evidenceId:evidence.id}:{})})
  }
  const completeRetention=()=>{for(const id of frozen.plan.requiredCheckIds)append(id)}
  const unitIds=Array.from({length:unitCount},(_,i)=>`unit-${i+1}`)
  const population=sampling.createPopulation(project.id,{idempotencyKey:'assessment-population',expectedProjectRevision:project.revision,productType:'synthetic control',unitProductType:'declared point',definitionStatement:'Synthetic census; no professional inspection authenticated.',orderedUnitProductIds:unitIds})
  const run=sampling.createRun(project.id,{populationId:population.id,idempotencyKey:'assessment-sampling',stage:'final-office',inspectionMode:'census'})
  const sources:AssessmentSources={getProject,getManifest,retentionSnapshot:(pid,p,r)=>retention.getAssessmentSnapshot(pid,p,r),getPopulation:(pid,id)=>sampling.getPopulation(pid,id),getRun:(pid,id)=>sampling.getRun(pid,id),listSamples:(pid,id,l,o)=>sampling.listSamples(pid,id,l,o),getScore:(pid,id)=>scoring.getRecord(pid,id)}
  const options={rootDir:runtime,nowIso,clockMs,sources}
  let assessment=new SurveyQualityAssessmentService(options)
  const planRequest={schemaVersion:1 as const,acknowledged:true as const,expectedProjectRevision:project.revision,idempotencyKey:'assessment-plan-key',retentionPlanId:frozen.plan.id,retentionRecordId:retained.record.id,samplingRunId:run.id,productProfileId:'planar-control-point' as const,basisStatement:' 合成资料 😀\n仅声明关联。 ',unitMaterials:unitIds.map(unitId=>({unitId,requirements:[{reference:'synthetic',retentionCheckId:'evidence:support',memberId:'output-1',locatorStatement:' Explicit synthetic row; shared file. '}]}))}
  let scoreKey=0
  const score=(unitId:string,mutate?:(input:Extract<SurveyQualityScoringInputV1,{operation:'unit'}>)=>void)=>{
    const declaration=qualityScoringTestDeclaration('unit') as Extract<SurveyQualityScoringInputV1,{operation:'unit'}>;declaration.unitId=unitId;mutate?.(declaration)
    return scoring.createRecord(project.id,Buffer.from(JSON.stringify({kind:'unit',acknowledged:true,expectedProjectRevision:project.revision,idempotencyKey:`assessment-score-${scoreKey++}`,declarationJson:JSON.stringify(declaration),modelBasisStatement:'Synthetic declared unit record.'})))
  }
  const auditCount=()=>{const db=new Database(join(runtime,'engineering.sqlite3'));try{return (db.prepare('SELECT count(*) AS n FROM engineering_verification_attempts').get() as {n:number}).n}finally{db.close()}}
  const outputBytes=()=>Promise.all([...manifest.outputs.map(o=>join(workspace,o.path)),join(workspace,'.workwise','deliverables',project.id,manifest.runId,'manifest.json')].map(p=>readFile(p)))
  const close=async()=>{assessment.close();scoring.close();sampling.close();retention.close();await engineering.flush();engineering.close();await rm(root,{recursive:true,force:true})}
  return {root,runtime,project,manifest,engineering,retention,sampling,scoring,sources,planRequest,unitIds,score,advance,append,completeRetention,auditCount,outputBytes,close,
    get assessment(){return assessment}, restart(){assessment.close();assessment=new SurveyQualityAssessmentService(options);return assessment}}
}
