import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {it,expect} from 'vitest'
import Database from '#repo/node_modules/better-sqlite3/lib/index.js'
import {SurveyAdvancedTrialsWorkspaceService as Service} from '#repo/kun/src/engineering/survey-advanced-trials-workspace.ts'
import {advancedTrialTestRequest,maximumNewAdvancedTrialRequest} from '#repo/kun/src/engineering/survey-advanced-trials-test-helpers.ts'
const sha=(b:any)=>createHash('sha256').update(b).digest('hex')
it.each(['huber','statistical-family'])('replays ten maximum %s records under full declared-model budget',kind=>{
 const dir=mkdtempSync(join(tmpdir(),'integration-max-')),p={id:'max-project',revision:1,workspace:dir+'/workspace'};let ms=Date.parse('2026-09-20T00:00:00Z');const opts={rootDir:dir,getProject:(id:string)=>id===p.id?p:null,clockMs:()=>ms,nowIso:()=>new Date(ms).toISOString()};let s=new Service(opts)
 try {const ids=[];for(let i=0;i<10;i++){ms+=60001;const q=maximumNewAdvancedTrialRequest(kind,'maximum-review-'+i);ids.push(s.createTrial(p.id,Buffer.from(JSON.stringify(q))).id)}
 s.close();s=new Service(opts);const page=s.listTrials(p.id);expect(page.trials).toHaveLength(10);expect(page.unavailable).toEqual([]);expect(page.nextOffset).toBeNull()
 if(kind==='huber'){expect(page.trials.every(x=>x.observationCount===128&&x.parameterCount===16&&!('familyMemberCount'in x))).toBe(true);expect(()=>s.getTrial(p.id,ids[0])).toThrow('rate-limit')}
 else {expect(page.trials.every(x=>x.observationCount===0&&x.parameterCount===0&&x.familyMemberCount===256)).toBe(true);s.getTrial(p.id,ids[0]);s.getTrial(p.id,ids[1]);expect(()=>s.getTrial(p.id,ids[2])).toThrow('rate-limit')}
 ms+=60001;const record=s.getTrial(p.id,ids[0]);expect(Buffer.byteLength(JSON.stringify(record))).toBeLessThan(4*1024*1024)
 if(kind==='huber'){expect(record.result.outcome).toBe('iteration-limit');expect(record.result.states).toHaveLength(201);expect(record.result.acceptedParameters).toBeNull()}
 else {expect(record.result.denominator).toBe(256);expect(record.result.results).toHaveLength(256)}
 const db=new Database(join(dir,'survey-advanced-trials.sqlite3'));try {expect(db.prepare('SELECT count(*) AS n FROM advanced_trials').get()).toEqual({n:10});const row=db.prepare('SELECT request_bytes,declaration_bytes FROM advanced_trials WHERE id=?').get(ids[0]);expect(sha(row.request_bytes)).toBe(record.requestSha256);expect(sha(row.declaration_bytes)).toBe(record.declarationSha256)}finally{db.close()}
 }finally{s.close();rmSync(dir,{recursive:true,force:true})}
})
it.each(['huber','statistical-family'])('preserves raw retry identity and byte conflicts for %s',kind=>{const dir=mkdtempSync(join(tmpdir(),'integration-retry-'));const p={id:'p',revision:1,workspace:dir};let ms=0;const s=new Service({rootDir:dir,getProject:()=>p,clockMs:()=>ms});try{const q=advancedTrialTestRequest(kind),raw=Buffer.from('\t'+JSON.stringify(q)+'\n');const a=s.createTrial(p.id,raw);expect(s.createTrial(p.id,raw)).toEqual(a);expect(()=>s.createTrial(p.id,Buffer.concat([Buffer.from(' '),raw]))).toThrow('conflict');ms+=60001;expect(s.listTrials(p.id).trials).toEqual([a])}finally{s.close();rmSync(dir,{recursive:true,force:true})}})
