import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {it,expect,vi,afterEach} from 'vitest'
import {mkdtempSync,rmSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {SurveyAdvancedTrialsWorkspaceService as Service} from '../../../../kun/src/engineering/survey-advanced-trials-workspace.ts'
vi.mock('../../../../src/renderer/src/agent/runtime-client.ts',()=>({rendererRuntimeClient:{runtimeRequest:vi.fn()}}))
import {rendererRuntimeClient} from '../../../../src/renderer/src/agent/runtime-client.ts'
import {readAdvancedTrial,advancedTrialSummary,validateAdvancedTrialInput,listAdvancedTrials} from '../../../../src/renderer/src/agent/survey-advanced-trials-client.ts'
const mock=vi.mocked(rendererRuntimeClient.runtimeRequest)
afterEach(()=>{vi.unstubAllGlobals();mock.mockReset()})
function canonical(v:any):string { if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;if(v&&typeof v==='object')return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;return JSON.stringify(v) }
const digest=(v:any)=>createHash('sha256').update(canonical(v)).digest('hex')
function fixture(){const root=mkdtempSync(join(tmpdir(),'railwise-client-source-'));const project={id:'project-a',revision:1,workspace:root+'/workspace'};const service=new Service({rootDir:root,getProject:id=>id===project.id?project:null});try{const model={schemaVersion:1,model:'fixed-linear-independent-disjoint-variance-groups',unit:'mm',parameterIds:[' mean '],groups:[{id:' group ',initialVariance:1,sourceAnchor:' source '}],observations:[0,1,2].map((value,i)=>({id:` observation-${i} `,value,coefficients:[1],groupId:' group ',relativeVariance:1,sourceAnchor:' source '})),maxIterations:5,relativeTolerance:1e-8};const input={kind:'vce',declarationJson:JSON.stringify(model),modelBasisStatement:'工程依据声明'};const summary=service.createTrial(project.id,Buffer.from(JSON.stringify({...input,acknowledged:true,expectedProjectRevision:1,idempotencyKey:'client-review-1'})));return {binding:{projectId:project.id,projectRevision:1,workspaceRoot:project.workspace},record:service.getTrial(project.id,summary.id),summary,input}}finally{service.close();rmSync(root,{recursive:true,force:true})}}
it('restores real Runtime record without global Buffer',async()=>{const f=fixture();mock.mockResolvedValue({ok:true,status:200,body:JSON.stringify(f.record)} as any);vi.stubGlobal('Buffer',undefined);expect(await readAdvancedTrial(f.binding,f.summary)).toEqual(f.record)})
it('rejects input/result convergence policy discrepancy even if all hashes refreshed',async()=>{const f=fixture();f.record.result.convergencePolicy.maxIterations=6;f.record.resultHash=digest(f.record.result);const{recordHash,...unsigned}=f.record;f.record.recordHash=digest(unsigned);mock.mockResolvedValue({ok:true,status:200,body:JSON.stringify(f.record)} as any);await expect(readAdvancedTrial(f.binding,advancedTrialSummary(f.record))).rejects.toMatchObject({reason:'invalid-response'})})
it('rejects ambiguous duplicate-key model in preflight',()=>{const f=fixture();f.input.declarationJson=f.input.declarationJson.replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1');expect(validateAdvancedTrialInput(f.binding,f.input)).toBe(false)})
it('recognizes backend replay_environment code as permanent environment incompatibility',async()=>{const f=fixture();mock.mockResolvedValue({ok:false,status:409,body:JSON.stringify({code:'advanced_trials_replay_environment'})} as any);await expect(listAdvancedTrials(f.binding)).rejects.toMatchObject({reason:'replay-environment'})})
