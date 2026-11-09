import { useState, type ReactElement } from 'react'
import { diffLines } from 'diff'
import { Eye, FileCheck2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TaskArtifactV1, TaskRunV1 } from '@shared/agent-workbench'
import type { DocumentCandidateReview, CandidateDecisionRequest } from '@shared/document-delivery'
import { requestTaskDetail } from '../../store/task-live-store'

export function TaskArtifactReview({task,artifact,onOpen}:{task:TaskRunV1;artifact:TaskArtifactV1;onOpen:()=>void|Promise<void>}):ReactElement|null{
  const {t}=useTranslation('common')
  const [review,setReview]=useState<DocumentCandidateReview|null>(null)
  const [target,setTarget]=useState('');const [busy,setBusy]=useState(false);const [message,setMessage]=useState('')
  const [pending,setPending]=useState<CandidateDecisionRequest|null>(null)
  const [regenerationKey,setRegenerationKey]=useState<string|null>(null)
  if(!/\.(?:md|mdx|markdown)$/i.test(artifact.relativePath)||!artifact.relativePath.includes('delivery-candidates'))return null
  const load=async()=>{
    if(busy)return;setBusy(true);setMessage('')
    try{const result=await window.workwise.readDocumentCandidate({workspaceRoot:task.workspaceRoot,path:artifact.relativePath,...(target.trim()?{targetPath:target.trim()}:{})});setReview(result);setTarget(result.targetPath??target);setPending(null)}catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  const decide=async(decision:'accept'|'reject')=>{
    if(!review||busy)return;setBusy(true);setMessage('')
    const request=pending?.decision===decision?pending:{workspaceRoot:task.workspaceRoot,path:artifact.relativePath,targetPath:target.trim()||undefined,decision,idempotencyKey:crypto.randomUUID(),candidateRevision:review.candidateRevision,expectedRevision:review.current?.revision??null}
    setPending(request)
    try{const result=await window.workwise.decideDocumentCandidate(request);setReview({...review,status:result.status});setMessage(result.message??t(result.ok?'taskCandidateDecisionSaved':'taskCandidateConflict'));if(result.ok)setPending(null)}catch(e){setMessage(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }
  const diff=review?diffLines(review.current?.content??'',review.content):[]
  const regenerate=async()=>{
    if(!review || busy)return
    setBusy(true);setMessage('')
    const key=regenerationKey??crypto.randomUUID();setRegenerationKey(key)
    const affected=review.affectedSections??[]
    const sections=affected.filter(section=>!affected.some(parent=>parent.id!==section.id && parent.startLine<=section.startLine && parent.endLine>=section.endLine)).map(section=>section.id)
    try{
      const result=await window.workwise.coordinateTaskCommand({threadId:task.threadId,taskId:task.id,intent:['completed','failed','cancelled'].includes(task.status)?'new':'supplement',idempotencyKey:key,request:{prompt:[
        '请重新读取已变化的来源，只重新生成受影响章节；其余正文必须原样保留，已有用户文档不得直接覆盖。',
        `基线候选：${artifact.relativePath}；SHA-256：${review.candidateRevision.fingerprint}`,
        `变化来源：${JSON.stringify(review.sources.filter(source=>source.stale).map(source=>source.path))}`,
        `受影响章节：${JSON.stringify(sections)}`,
        '使用 propose_document 的 base_candidate_path、expected_candidate_hash 和 section_patches 保存新候选；heading 指定上述章节，content 仅含该章节的新正文。更新所有依赖于变化来源的章节，再真实导出DOCX/PDF；提交后仍需用户差异审阅。'
      ].join('\n'),model:task.model,mode:'agent'}})
      if(result.kind==='attention_required')throw new Error(result.message)
      setRegenerationKey(null);setReview(null)
      if(result.task)requestTaskDetail(result.task.rootTaskId??result.task.id)
    }catch(error){setMessage(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
  }
  return <>
    <button type="button" disabled={busy} onClick={()=>void load()} className="mt-2 inline-flex items-center gap-1 rounded-md border border-ds-border px-2 py-1 text-[11px] text-ds-ink hover:bg-ds-hover"><Eye className="h-3.5 w-3.5"/>{t('taskWorkspaceReviewCandidate')}</button>
    {message&&!review?<p role="alert" className="text-xs text-red-600">{message}</p>:null}
    {review?<div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={t('taskWorkspaceCandidateTitle')}>
      <section className="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-ds-border bg-ds-card p-4 text-ds-ink shadow-2xl">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><FileCheck2 className="h-4 w-4"/>{t('taskWorkspaceCandidateTitle')}</h2>
        <label className="mt-3 text-xs">{t('taskCandidateDestination')}<div className="mt-1 flex gap-2"><input value={target} onChange={event=>{setTarget(event.target.value);setPending(null)}} className="min-w-0 flex-1 rounded border border-ds-border bg-ds-panel p-2"/><button type="button" disabled={busy} onClick={()=>void load()} className="rounded border border-ds-border px-3">{t('taskCandidateCompare')}</button></div></label>
        <p className="mt-1 text-xs text-ds-muted">{t('taskCandidateCompareHint')}</p>
        <div className="mt-3 min-h-0 flex-1 overflow-auto">
          <h3 className="text-xs font-semibold">{t('taskCandidateSources')}</h3>
          {review.sources.length?<ul className="my-2 space-y-1 text-xs">{review.sources.map((source,index)=><li key={`${source.path}:${index}`}><span className="break-all">{source.path}{source.location?` · ${source.location}`:''}</span>{source.stale?<span className="ml-2 text-amber-600">{t('taskCandidateSourceChanged')}</span>:null}{source.excerpt?<p className="text-ds-muted">{source.excerpt}</p>:null}</li>)}</ul>:<p className="my-2 text-xs text-ds-muted">{t('taskCandidateNoSources')}</p>}
          <h3 className="mb-1 text-xs font-semibold">{t('taskCandidateDiff')}</h3>
          {review.affectedSections?.length?<p className="mb-2 text-xs text-amber-700 dark:text-amber-300">{t('taskCandidateAffectedSections')}: {review.affectedSections.map(section=>section.heading).join('、')}</p>:null}
          <pre className="whitespace-pre-wrap rounded border border-ds-border bg-ds-panel p-3 font-mono text-xs leading-5">{diff.map((part,index)=><span key={index} className={part.added?'bg-green-100 text-green-950 dark:bg-green-950 dark:text-green-100':part.removed?'bg-red-100 text-red-950 line-through dark:bg-red-950 dark:text-red-100':''}>{part.value}</span>)}</pre>
        </div>
        {message?<p role="status" className="mt-2 text-xs">{message}</p>:null}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={()=>setReview(null)} className="rounded border border-ds-border px-3 py-2 text-xs">{t('taskWorkspaceClose')}</button>
          <button type="button" onClick={()=>void onOpen()} className="rounded border border-ds-border px-3 py-2 text-xs">{t('taskWorkspaceOpenCandidate')}</button>
          {review.sourcesStale && review.affectedSections?.length?<button type="button" disabled={busy} onClick={()=>void regenerate()} className="rounded border border-ds-border px-3 py-2 text-xs disabled:opacity-50">{t('taskCandidateRegenerateSections')}</button>:null}
          <button type="button" disabled={busy||review.status==='accepted'} onClick={()=>void decide('reject')} className="rounded border border-ds-border px-3 py-2 text-xs">{t('taskCandidateReject')}</button>
          <button type="button" disabled={busy||!target.trim()||target!==review.targetPath||review.sourcesStale||review.status==='accepted'} onClick={()=>void decide('accept')} className="rounded bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{t('taskCandidateAccept')}</button>
        </div>
      </section>
    </div>:null}
  </>
}
