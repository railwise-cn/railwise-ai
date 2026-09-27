import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe,it,expect} from 'vitest'
import Database from 'better-sqlite3'
import {mkdtempSync,rmSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {SurveyAdvancedTrialsWorkspaceService as Service} from '../../../../kun/src/engineering/survey-advanced-trials-workspace.ts'
const sha=(v:any)=>createHash('sha256').update(v).digest('hex')
function canonical(v:any):string { if(Array.isArray(v))return `[${v.map(canonical).join(',')}]`;if(v&&typeof v==='object')return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;return JSON.stringify(v) }
const digest=(v:any)=>sha(canonical(v))
const model={schemaVersion:1,model:'fixed-linear-independent-disjoint-variance-groups',unit:'mm',parameterIds:[' mean '],groups:[{id:' group ',initialVariance:1,sourceAnchor:' source '}],observations:[0,1,2].map((value,i)=>({id:` observation-${i} `,value,coefficients:[1],groupId:' group ',relativeVariance:1,sourceAnchor:' source '})),maxIterations:5,relativeTolerance:1e-8}
function fixture(run:(f:any)=>void){const root=mkdtempSync(join(tmpdir(),'railwise-advanced-db-'));const project={id:'project-a',revision:1,workspace:root+'/workspace'};const options={rootDir:root,nowIso:()=> '2026-09-20T00:00:00.000Z',getProject:(id:string)=>['project-a','project-b'].includes(id)?{...project,id}:null};const service=new Service(options);const db=new Database(root+'/survey-advanced-trials.sqlite3');try{run({root,project,options,service,db})}finally{service.close();db.close();rmSync(root,{recursive:true,force:true})}}
function raw(key='review-key-1'){return Buffer.from(JSON.stringify({kind:'vce',acknowledged:true,expectedProjectRevision:1,idempotencyKey:key,declarationJson:' \n'+JSON.stringify(model,null,2)+'\n ',modelBasisStatement:'  独立数值接口审查声明；不是专业签认。\n'}))}
function resignRow(row:any){const{storage_hash,...rest}=row;const {request_bytes,declaration_bytes,...meta}=rest;row.storage_hash=digest({...meta,request_bytes_sha256:sha(request_bytes),declaration_bytes_sha256:sha(declaration_bytes)});return row}
function mutate(db:any,id:string,fn:(r:any)=>void){db.exec('DROP TRIGGER IF EXISTS advanced_trials_no_update');const row=db.prepare('SELECT * FROM advanced_trials WHERE id=?').get(id);fn(row);resignRow(row);const keys=Object.keys(row).filter(k=>k!=='id');db.prepare(`UPDATE advanced_trials SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`).run(...keys.map(k=>row[k]),id)}
describe('Independent advanced Runtime boundary probes',()=>{
it('retains exact declarations while normalizing VCE IDs; restart exact replay; cross-project isolation; exact-body retry',()=>fixture(({service,options})=>{const bytes=raw(),summary=service.createTrial('project-a',bytes),record=service.getTrial('project-a',summary.id);expect(record.requestJson).toBe(bytes.toString());expect(record.declarationJson).toBe(JSON.parse(bytes.toString()).declarationJson);expect(record.declaration.parameterIds).toEqual(['mean']);expect(record.declarationSha256).not.toBe(record.modelHash);expect(service.createTrial('project-a',bytes)).toEqual(summary);expect(()=>service.createTrial('project-a',Buffer.concat([bytes,Buffer.from(' ') ]))).toThrow('conflict');expect(()=>service.getTrial('project-b',summary.id)).toThrow('not-found');service.close();const reopened=new Service(options);try{expect(reopened.getTrial('project-a',summary.id)).toEqual(record)}finally{reopened.close()}}))
it('rejects duplicates, escaped duplicate keys and malformed Unicode',()=>fixture(({service})=>{for(const body of [raw().toString().replace('"kind":"vce"','"kind":"vce","kind":"vce"'),raw().toString().replace('"kind":"vce"','"kind":"vce","k\\u0069nd":"vce"'),raw().toString().replace('"modelBasisStatement":','"modelBasisStatement":"\\ud800","extra":')])expect(()=>service.createTrial('project-a',Buffer.from(body))).toThrow('validation')}))
it.each(['kind','project_revision','project_binding_hash','idempotency_key','request_hash','record_hash','created_at'])('rejects SQL %s mismatch even with valid external storage hash',column=>fixture(({service,db})=>{const summary=service.createTrial('project-a',raw());mutate(db,summary.id,row=>{row[column]=column==='project_revision'?2:'changed'});expect(()=>service.getTrial('project-a',summary.id)).toThrow('integrity');expect(service.listTrials('project-a')).toMatchObject({trials:[],unavailable:[{id:summary.id,reason:'integrity'}]})}))
it('rejects one ULP result tampering even when all saved JSON/storage hashes are refreshed',()=>fixture(({service,db})=>{const summary=service.createTrial('project-a',raw());mutate(db,summary.id,row=>{const record=JSON.parse(row.data_json);record.result.iterations[0].fit.parameters[0]+=Number.EPSILON;record.resultHash=digest(record.result);const{recordHash,...unsigned}=record;record.recordHash=digest(unsigned);row.record_hash=record.recordHash;row.data_json=JSON.stringify(record)});expect(()=>service.getTrial('project-a',summary.id)).toThrow('integrity')}))
it('reports environment incompatibility separately without rewriting record',()=>fixture(({service,db})=>{const summary=service.createTrial('project-a',raw());mutate(db,summary.id,row=>{const record=JSON.parse(row.data_json);record.replayEnvironment.node='0.0.0';record.replayEnvironmentHash=digest(record.replayEnvironment);const{recordHash,...unsigned}=record;record.recordHash=digest(unsigned);row.record_hash=record.recordHash;row.data_json=JSON.stringify(record)});expect(()=>service.getTrial('project-a',summary.id)).toThrow('replay-environment');expect(service.listTrials('project-a')).toMatchObject({trials:[],unavailable:[{id:summary.id,reason:'replay-environment'}]})}))
it('isolates corrupt SQL ID from healthy history entries',()=>fixture(({service,db})=>{const broken=service.createTrial('project-a',raw('broken-key-1')),healthy=service.createTrial('project-a',raw('healthy-key-1'));db.exec('DROP TRIGGER advanced_trials_no_update');db.prepare('UPDATE advanced_trials SET id=? WHERE id=?').run(' ',broken.id);const history=service.listTrials('project-a');expect(history.trials.map((x:any)=>x.id)).toContain(healthy.id);expect(history.unavailable).toHaveLength(1)}))
})


it('distinguishes exact source/basis custody from normalized model and output hashes', () => fixture(({ service }) => {
  const firstRaw = raw('hash-semantics-a')
  const first = service.createTrial('project-a', firstRaw)
  const changedSource = JSON.parse(firstRaw.toString())
  changedSource.idempotencyKey = 'hash-semantics-b'
  const parsedModel = JSON.parse(changedSource.declarationJson)
  // Reorder top-level fields and remove indentation without changing the model.
  changedSource.declarationJson = JSON.stringify(Object.fromEntries(Object.entries(parsedModel).reverse()))
  const reordered = service.createTrial('project-a', Buffer.from(JSON.stringify(changedSource)))
  expect(reordered.declarationSha256).not.toBe(first.declarationSha256)
  expect(reordered.requestSha256).not.toBe(first.requestSha256)
  expect(reordered.modelHash).toBe(first.modelHash)
  expect(reordered.resultHash).toBe(first.resultHash)
  const changedBasis = { ...changedSource, idempotencyKey: 'hash-semantics-c', modelBasisStatement: 'Changed caller-declared basis only.' }
  const basis = service.createTrial('project-a', Buffer.from(JSON.stringify(changedBasis)))
  expect(basis.modelBasisSha256).not.toBe(reordered.modelBasisSha256)
  expect(basis.modelHash).toBe(reordered.modelHash)
  expect(basis.resultHash).toBe(reordered.resultHash)
  parsedModel.observations[0].value += 0.25
  const changedValue = { ...changedBasis, idempotencyKey: 'hash-semantics-d', declarationJson: JSON.stringify(parsedModel) }
  const changed = service.createTrial('project-a', Buffer.from(JSON.stringify(changedValue)))
  expect(changed.modelHash).not.toBe(basis.modelHash)
  expect(changed.resultHash).not.toBe(basis.resultHash)
  expect(changed.recordHash).not.toBe(basis.recordHash)
}))
