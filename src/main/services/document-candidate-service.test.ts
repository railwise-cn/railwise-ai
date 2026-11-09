import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,describe,it,expect} from 'vitest'
import {reviewDocumentCandidate,decideDocumentCandidate} from './document-candidate-service'
import {readDocumentSnapshot,listDocumentHistory} from './write-document-service'
const roots:string[]=[]
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function fixture(){const root=await mkdtemp(join(tmpdir(),'railwise-review-'));roots.push(root);const dir=join(root,'.workwise','delivery-candidates','task-1');await mkdir(dir,{recursive:true});const path=join(dir,'draft.md');const targetPath=join(root,'report.md');await writeFile(path,'# New report\n');await writeFile(targetPath,'# Original report\n');await writeFile(`${path}.sources.json`,JSON.stringify({sources:[{path:'source.md',location:'L1'}]}));return {root,path,targetPath}}
describe('task candidate review through real file/history service',()=>{
 it('accepts once, retains actual original and returns the same receipt after replay',async()=>{const f=await fixture();const review=await reviewDocumentCandidate({workspaceRoot:f.root,path:f.path,targetPath:f.targetPath});const request={workspaceRoot:f.root,path:f.path,targetPath:f.targetPath,decision:'accept' as const,idempotencyKey:'accept-1',candidateRevision:review.candidateRevision,expectedRevision:review.current!.revision};const first=await decideDocumentCandidate(request);expect(first.ok).toBe(true);expect(await readFile(f.targetPath,'utf8')).toBe('# New report\n');expect(await readFile(first.preservedPath!,'utf8')).toBe('# Original report\n');const count=(await listDocumentHistory({workspaceRoot:f.root,path:f.targetPath})).total;expect(count).toBe(2);expect(await decideDocumentCandidate(request)).toEqual(first);expect((await listDocumentHistory({workspaceRoot:f.root,path:f.targetPath})).total).toBe(count)})
 it('does not overwrite external edits or silently accept a changed candidate',async()=>{const f=await fixture();const review=await reviewDocumentCandidate({workspaceRoot:f.root,path:f.path,targetPath:f.targetPath});await writeFile(f.targetPath,'External edit');const request={workspaceRoot:f.root,path:f.path,targetPath:f.targetPath,decision:'accept' as const,idempotencyKey:'accept-2',candidateRevision:review.candidateRevision,expectedRevision:review.current!.revision};const conflict=await decideDocumentCandidate(request);expect(conflict.status).toBe('conflict');expect(await readFile(f.targetPath,'utf8')).toBe('External edit');await writeFile(f.path,'Candidate edit');expect((await decideDocumentCandidate({...request,idempotencyKey:'accept-3'})).status).toBe('conflict')})
 it('rejects path escapes and binds each key to the original decision',async()=>{const f=await fixture();await expect(reviewDocumentCandidate({workspaceRoot:f.root,path:f.path,targetPath:join(f.root,'..','outside.md')})).rejects.toThrow();const review=await reviewDocumentCandidate({workspaceRoot:f.root,path:f.path});const req={workspaceRoot:f.root,path:f.path,decision:'reject' as const,idempotencyKey:'review',candidateRevision:review.candidateRevision,expectedRevision:null};expect((await decideDocumentCandidate(req)).status).toBe('rejected');await expect(decideDocumentCandidate({...req,decision:'accept'})).rejects.toThrow(/different/);expect((await readDocumentSnapshot(f.path,f.root)).content).toBe('# New report\n')})
})

it('blocks changed source evidence and preserves late external writes to the displaced inode', async () => {
 const {createHash}=await import('node:crypto'); const {open}=await import('node:fs/promises')
 const f=await fixture(); const source=join(f.root,'source.md'); await writeFile(source,'Source v1')
 await writeFile(`${f.path}.sources.json`,JSON.stringify({sources:[{path:'source.md',sha256:createHash('sha256').update('Source v1').digest('hex')}]}))
 const review=await reviewDocumentCandidate({workspaceRoot:f.root,path:f.path,targetPath:f.targetPath})
 const request={workspaceRoot:f.root,path:f.path,targetPath:f.targetPath,decision:'accept' as const,idempotencyKey:'safe-source',candidateRevision:review.candidateRevision,expectedRevision:review.current!.revision}
 await writeFile(source,'Source v2')
 expect((await decideDocumentCandidate(request)).status).toBe('conflict')
 expect(await readFile(f.targetPath,'utf8')).toBe('# Original report\n')
 await writeFile(source,'Source v1')
 const oldHandle=await open(f.targetPath,'r+')
 try{
   const accepted=await decideDocumentCandidate({...request,idempotencyKey:'safe-source-2'})
   expect(accepted.ok).toBe(true)
   await oldHandle.truncate(0); await oldHandle.write('Late external save',0,'utf8'); await oldHandle.sync()
   expect(await readFile(accepted.preservedPath!,'utf8')).toBe('Late external save')
   expect(await readFile(f.targetPath,'utf8')).toBe('# New report\n')
 }finally{await oldHandle.close()}
})
it('reconciles a lost post-write receipt only from its journal and exact target hash',async()=>{
 const {createHash}=await import('node:crypto'); const {realpath}=await import('node:fs/promises')
 const f=await fixture(); const review=await reviewDocumentCandidate({workspaceRoot:f.root,path:f.path,targetPath:f.targetPath});const root=await realpath(f.root)
 const key=createHash('sha256').update(`${review.path}\0lost-reply`).digest('hex')
 const request={workspaceRoot:f.root,path:f.path,targetPath:f.targetPath,decision:'accept' as const,idempotencyKey:'lost-reply',candidateRevision:review.candidateRevision,expectedRevision:review.current!.revision}
 const fingerprint=createHash('sha256').update(JSON.stringify({path:review.path,targetPath:review.targetPath,decision:'accept',candidate:review.candidateRevision.fingerprint,expected:review.current!.revision.fingerprint})).digest('hex')
 const journalRoot=join(root,'.workwise','candidate-operations');await mkdir(journalRoot,{recursive:true})
 await writeFile(join(journalRoot,`${key}.json`),JSON.stringify({fingerprint,state:'writing',candidateHash:review.candidateRevision.fingerprint,targetPath:review.targetPath}))
 await writeFile(f.targetPath,review.content)
 expect((await decideDocumentCandidate(request)).status).toBe('accepted')
 await writeFile(f.targetPath,'User change after receipt')
 expect((await decideDocumentCandidate(request)).status).toBe('accepted')
 expect(await readFile(f.targetPath,'utf8')).toBe('User change after receipt')
})

it('maps changed source versions to affected sections while keeping legacy mappings conservative',async()=>{
 const {createHash}=await import('node:crypto')
 const f=await fixture();await writeFile(join(f.root,'source.md'),'Source v2')
 const sections=[
  {id:'intro',heading:'Introduction',level:2,startLine:1,endLine:3,sourcePaths:['other.md']},
  {id:'findings',heading:'Findings',level:2,startLine:4,endLine:6,sourcePaths:['source.md']}
 ]
 const source={path:'source.md',sha256:createHash('sha256').update('Source v1').digest('hex'),sections:['findings']}
 await writeFile(`${f.path}.sources.json`,JSON.stringify({sources:[source],sections}))
 const review=await reviewDocumentCandidate({workspaceRoot:f.root,path:f.path})
 expect(review.sourcesStale).toBe(true)
 expect(review.sources[0].sections).toEqual(['findings'])
 expect(review.affectedSections?.map(section=>section.id)).toEqual(['findings'])
 await writeFile(`${f.path}.sources.json`,JSON.stringify({sources:[{...source,sections:undefined}],sections:sections.map(section=>({...section,sourcePaths:[]}))}))
 expect((await reviewDocumentCandidate({workspaceRoot:f.root,path:f.path})).affectedSections).toHaveLength(2)
})
