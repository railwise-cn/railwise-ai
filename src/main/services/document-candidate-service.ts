import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, rename, link, unlink } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import type { CandidateDecisionRequest, CandidateDecisionResult, CandidateReviewRequest, DocumentCandidateReview, CandidateSource, CandidateSection } from '../../shared/document-delivery'
import type { DocumentSnapshot } from '../../shared/write-document'
import { atomicWriteFile, runSerialized } from './durable-file'
import { canonicalizeContainmentRoot, resolveContainedPath, recheckContainedParent } from './canonical-containment'
import { readDocumentSnapshot, revisionsEqual, recordDocumentCommitHistory } from './write-document-service'

const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT'
async function current(path: string, root: string): Promise<DocumentSnapshot | null> { try { return await readDocumentSnapshot(path,root) } catch(e) { if(missing(e)) return null; throw e } }
async function safeRead(path: string, root: string): Promise<string> {
  const safe = await resolveContainedPath({ root,target:path,expect:'file',mustExist:true,rejectFinalLink:true })
  const fd = await open(safe, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { if ((await fd.stat()).size > 12 * 1024 * 1024) throw new Error('Candidate metadata exceeds read limit.'); return await fd.readFile('utf8') } finally { await fd.close() }
}
async function context(request: CandidateReviewRequest) {
  const root = await canonicalizeContainmentRoot(request.workspaceRoot)
  const snapshot = await readDocumentSnapshot(request.path, request.workspaceRoot)
  const rel = relative(root,snapshot.path).split(sep).join('/')
  if (!/^\.workwise\/delivery-candidates\/[^/]+\/.+\.(?:md|mdx|markdown)$/i.test(rel)) throw new Error('Only task-owned Markdown candidates can be reviewed.')
  let metadata: Record<string,unknown> = {}
  try { metadata = JSON.parse(await safeRead(`${snapshot.path}.sources.json`,root)) as typeof metadata } catch(e) { if(!missing(e)) throw e }
  const targetInput = request.targetPath ?? (typeof metadata.targetPath === 'string' ? metadata.targetPath : undefined)
  const targetPath = targetInput ? await resolveContainedPath({root,target:resolve(root,relative(resolve(request.workspaceRoot),resolve(request.workspaceRoot,targetInput))),expect:'file',rejectFinalLink:true}) : undefined
  if(targetPath && relative(root,targetPath).split(sep).join('/').startsWith('.workwise/')) throw new Error('Choose a document path outside the task metadata directory.')
  return {root,snapshot,metadata,targetPath}
}
export async function reviewDocumentCandidate(request: CandidateReviewRequest): Promise<DocumentCandidateReview> {
  const {root,snapshot,metadata,targetPath} = await context(request)
  const sources: CandidateSource[] = []
  for(const value of (Array.isArray(metadata.sources) ? metadata.sources : []).slice(0,500)) {
    if(!value || typeof value !== 'object' || typeof value.path !== 'string') continue
    const source: CandidateSource = {path:value.path,...(typeof value.location === 'string'?{location:value.location}:{}),...(typeof value.excerpt === 'string'?{excerpt:value.excerpt}:{}),...(typeof value.sha256 === 'string'?{sha256:value.sha256}:{}),...(Array.isArray(value.sections)?{sections:value.sections.filter((id:unknown):id is string=>typeof id==='string')}: {})}
    if(source.sha256) { try { source.stale = hash(await safeRead(resolve(root,source.path),root)) !== source.sha256 } catch { source.stale = true } }
    sources.push(source)
  }
  const baseline = metadata.baseline && typeof metadata.baseline === 'object' ? metadata.baseline as DocumentSnapshot : undefined
  const sections:CandidateSection[] = (Array.isArray(metadata.sections)?metadata.sections:[]).slice(0,1000).filter((section:unknown):section is CandidateSection=>Boolean(section && typeof section==='object' && 'id' in section && typeof section.id==='string' && 'heading' in section && typeof section.heading==='string' && 'level' in section && Number.isInteger(section.level) && 'startLine' in section && Number.isInteger(section.startLine) && 'endLine' in section && Number.isInteger(section.endLine) && 'sourcePaths' in section && Array.isArray(section.sourcePaths) && section.sourcePaths.every((path:unknown)=>typeof path==='string')))
  const affectedSections=sections.filter(section=>sources.some(source=>source.stale && (source.sections?.length ? source.sections.includes(section.id) : sections.some(item=>item.sourcePaths.includes(source.path)) ? section.sourcePaths.includes(source.path) : true)))
  const statePath = `${snapshot.path}.review.json`
  let status: DocumentCandidateReview['status'] = 'pending'
  try { const state = JSON.parse(await safeRead(statePath,root)); if(state.candidateHash === snapshot.revision.fingerprint && ['accepted','rejected','conflict','outcome_unknown'].includes(state.status)) status = state.status } catch(e) {if(!missing(e)) throw e}
  return {path:snapshot.path,content:snapshot.content,source:'candidate',sources,candidateRevision:snapshot.revision,targetPath,status,...(typeof metadata.taskId==='string'?{taskId:metadata.taskId}:{}),...(typeof metadata.templateId==='string'?{templateId:metadata.templateId}:{}),...(typeof metadata.createdAt==='string'?{createdAt:metadata.createdAt}:{}),baseline:baseline ?? (targetPath ? await current(targetPath,root) : null),current:targetPath ? await current(targetPath,root) : null,sourcesStale:sources.some(s=>s.stale),sections,affectedSections}
}
export async function decideDocumentCandidate(request: CandidateDecisionRequest): Promise<CandidateDecisionResult> {
  const ctx = await context(request)
  const key = hash(`${ctx.snapshot.path}\0${request.idempotencyKey}`)
  const journalRoot = resolve(ctx.root,'.workwise','candidate-operations')
  await resolveContainedPath({root:ctx.root,target:journalRoot,expect:'directory',rejectFinalLink:true})
  await mkdir(journalRoot,{recursive:true})
  await resolveContainedPath({root:ctx.root,target:journalRoot,expect:'directory',mustExist:true,rejectFinalLink:true})
  const journalPath = resolve(journalRoot,`${key}.json`)
  const fingerprint = hash(JSON.stringify({path:ctx.snapshot.path,targetPath:ctx.targetPath,decision:request.decision,candidate:request.candidateRevision.fingerprint,expected:request.expectedRevision?.fingerprint ?? null}))
  return runSerialized(`candidate-target:${ctx.targetPath ?? ctx.snapshot.path}`,async()=> {
    let journal: {fingerprint:string; state:string; candidateHash:string; targetPath?:string; preservedPath?:string; result?:CandidateDecisionResult} | undefined
    try { journal = JSON.parse(await safeRead(journalPath,ctx.root)) as typeof journal } catch(e) {if(!missing(e)) throw e}
    if(journal && journal.fingerprint !== fingerprint) throw new Error('Idempotency key belongs to a different review request.')
    if(journal?.result) return journal.result
    if(journal) {
      const actual = ctx.targetPath ? await current(ctx.targetPath,ctx.root) : null
      // A prepared operation may have crossed the file/receipt boundary. Only the exact persisted candidate proves completion.
      if(actual && actual.revision.fingerprint===journal.candidateHash && journal.state==='writing') {
        await recordDocumentCommitHistory(ctx.root,actual,'agent',key)
        const result: CandidateDecisionResult={ok:true,status:'accepted',snapshot:actual,preservedPath:journal.preservedPath}
        await atomicWriteFile(journalPath,JSON.stringify({...journal,state:'done',result})); return result
      }
      return {ok:false,status:'outcome_unknown',message:'An interrupted submission requires inspection. The candidate and preserved original remain available.',preservedPath:journal.preservedPath}
    }
    const review = await reviewDocumentCandidate(request)
    if(!revisionsEqual(request.candidateRevision,review.candidateRevision) || !revisionsEqual(request.candidateRevision,ctx.snapshot.revision)) return {ok:false,status:'conflict',message:'Candidate changed. Reload the comparison.'}
    if(request.decision==='accept' && review.sourcesStale) return {ok:false,status:'conflict',message:'Source documents changed. Regenerate or review the candidate against the new sources.'}
    journal={fingerprint,state:'prepared',candidateHash:ctx.snapshot.revision.fingerprint,targetPath:ctx.targetPath}
    await atomicWriteFile(journalPath,JSON.stringify(journal))
    const finish=async(result:CandidateDecisionResult) => {
      await atomicWriteFile(journalPath,JSON.stringify({...journal,state:'done',result}))
      await atomicWriteFile(`${ctx.snapshot.path}.review.json`,JSON.stringify({candidateHash:journal!.candidateHash,status:result.status,targetPath:ctx.targetPath,updatedAt:new Date().toISOString()}))
      return result
    }
    if(request.decision==='reject') return finish({ok:true,status:'rejected'})
    if(!ctx.targetPath) return finish({ok:false,status:'conflict',message:'Choose the destination document before accepting.'})
    const before = await current(ctx.targetPath,ctx.root)
    if(!revisionsEqual(request.expectedRevision,before?.revision ?? null)) return finish({ok:false,status:'conflict',conflict:{path:ctx.targetPath,expectedRevision:request.expectedRevision,currentRevision:before?.revision ?? null,currentContent:before?.content ?? null,attemptedContent:ctx.snapshot.content}})
    await mkdir(dirname(ctx.targetPath),{recursive:true})
    await recheckContainedParent(ctx.root,ctx.targetPath)
    if(before) {
      // Move the actual inode aside and retain it permanently: late writes through an external editor's old handle remain recoverable.
      const preservedPath = resolve(dirname(ctx.targetPath),`.${key}.railwise-preserved`)
      await lstat(preservedPath).then(()=>{throw new Error('Preservation target already exists.')}).catch(e=>{if(!missing(e)) throw e})
      await recordDocumentCommitHistory(ctx.root,before,'external',key)
      journal.preservedPath=preservedPath
      await atomicWriteFile(journalPath,JSON.stringify(journal))
      await rename(ctx.targetPath,preservedPath)
      const preserved = await readDocumentSnapshot(preservedPath,ctx.root)
      if(!revisionsEqual(before.revision,preserved.revision)) {
        await link(preservedPath,ctx.targetPath).catch(()=>undefined)
        return finish({ok:false,status:'conflict',message:'The document changed during submission. Both versions are preserved.',preservedPath})
      }
    }
    journal.state='writing'; await atomicWriteFile(journalPath,JSON.stringify(journal))
    // Exclusive creation cannot overwrite a document recreated concurrently by another application.
    const temp = resolve(dirname(ctx.targetPath),`.railwise-candidate-${randomUUID()}.tmp`)
    await atomicWriteFile(temp,ctx.snapshot.content)
    try { await link(temp,ctx.targetPath) } catch(e) {
      if(journal.preservedPath) await link(journal.preservedPath,ctx.targetPath).catch(()=>undefined)
      return finish({ok:false,status:'conflict',message:missing(e)?'Destination disappeared during submission.':'Another application changed the destination. Candidate and original are preserved.',preservedPath:journal.preservedPath})
    } finally {await unlink(temp).catch(()=>undefined)}
    const snapshot=await readDocumentSnapshot(ctx.targetPath,ctx.root)
    if(snapshot.revision.fingerprint!==journal.candidateHash) return finish({ok:false,status:'conflict',message:'The accepted file was changed externally. All preserved content remains available.',preservedPath:journal.preservedPath})
    // Register through the existing checked document/history path without changing the accepted content.
    await recordDocumentCommitHistory(ctx.root,snapshot,'agent',key)
    return finish({ok:true,status:'accepted',snapshot,preservedPath:journal.preservedPath})
  })
}
