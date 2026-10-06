import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePenLine, Shapes, Workflow, Loader2 } from 'lucide-react'
import { useChatStore } from '../../store/chat-store'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { createSurveyDraft, listSurveyDrafts, reviewSurveyDraft, setSurveyDraftSelection, type DraftBinding, type SurveyDraft } from '../../agent/survey-collaboration-client'

export function SurveyCollaborationPanel({binding,manifestId,enabled}:{binding:DraftBinding;manifestId?:string;enabled:boolean}):ReactElement {
  const {t}=useTranslation('common'),[drafts,setDrafts]=useState<SurveyDraft[]>([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(false)
  const {projectId,projectRevision,workspaceRoot}=binding
  const scope=JSON.stringify(binding),scopeRef=useRef(scope);scopeRef.current=scope
  const selectedDraft=drafts.find(d=>d.id===selected)??null
  useEffect(()=>{let current=true;setDrafts([]);setSelected('');setError(false);if(enabled)void listSurveyDrafts({projectId,projectRevision,workspaceRoot}).then(items=>{if(current){setDrafts(items);setSelected(items.find(d=>d.manifestId===manifestId)?.id??'')}}).catch(()=>{if(current)setError(true)});return()=>{current=false}},[projectId,projectRevision,workspaceRoot,manifestId,enabled]) // exact scope, never infer another project's draft
  const act=async(kind:'write'|'design'|'flow')=>{
    const captured=scopeRef.current;setBusy(true);setError(false)
    try{
      let draft=selectedDraft
      if(!draft){if(!manifestId)throw new Error('missing-source');draft=await createSurveyDraft(binding,manifestId,crypto.randomUUID());if(scopeRef.current!==captured)return;setDrafts(items=>[draft!,...items]);setSelected(draft.id)}
      if(scopeRef.current!==captured)return
      const chat=useChatStore.getState()
      if(kind==='write'){
        const write=useWriteWorkspaceStore.getState();if(write.workspaceRoot&&!await write.flushSave(write.workspaceRoot))throw new Error('save-failed')
        await write.selectWriteWorkspace(binding.workspaceRoot);await useWriteWorkspaceStore.getState().openFile(binding.workspaceRoot,draft.notesPath)
        if(scopeRef.current!==captured)return
        await chat.ensureWriteThreadForWorkspace(binding.workspaceRoot,draft.notesPath);await chat.openWrite()
      }else if(kind==='design'){
        setSurveyDraftSelection({kind:'design',workspace:binding.workspaceRoot,documentId:draft.designDocumentId});chat.openDesign()
      }else{
        draft=await reviewSurveyDraft(binding,draft);if(scopeRef.current!==captured)return
        setDrafts(items=>items.map(item=>item.id===draft!.id?draft!:item))
        if(!draft.flowId||!draft.runId)throw new Error('missing-review')
        setSurveyDraftSelection({kind:'flow',flowId:draft.flowId,runId:draft.runId});chat.openFlow()
      }
    }catch{if(scopeRef.current===captured)setError(true)}finally{if(scopeRef.current===captured)setBusy(false)}
  }
  return <section aria-label={t('surveyDraftCollaborationTitle')} className="m-5 rounded-lg border border-ds-border bg-ds-card p-4">
    <h3 className="text-sm font-semibold text-ds-ink">{t('surveyDraftCollaborationTitle')}</h3><p className="mt-2 text-xs leading-5 text-ds-muted">{t('surveyDraftCollaborationDescription')}</p>
    {drafts.length?<label className="mt-3 block text-xs text-ds-muted">{t('surveyDraftSelect')}<select value={selected} onChange={e=>setSelected(e.target.value)} className="ml-2 min-h-11 rounded border border-ds-border bg-ds-card px-2 text-ds-ink"><option value="">{t('surveyDraftNew')}</option>{drafts.map((d,index)=><option key={d.id} value={d.id}>{t('surveyDraftLabel',{index:drafts.length-index,revision:d.revision})}</option>)}</select></label>:null}
    <div className="mt-3 flex flex-wrap gap-2">{(['write','design','flow'] as const).map((kind,index)=>{const Icon=[FilePenLine,Shapes,Workflow][index]!;return <button key={kind} type="button" disabled={!enabled||busy||!selectedDraft&&!manifestId} onClick={()=>void act(kind)} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-ds-border px-3 text-xs text-ds-ink hover:bg-ds-hover disabled:opacity-50"><Icon className="h-4 w-4"/>{t(`surveyDraftAction.${kind}`)}</button>})}{busy?<Loader2 className="h-4 w-4 animate-spin"/>:null}</div>
    {!manifestId&&!selectedDraft?<p className="mt-2 text-xs text-ds-muted">{t('surveyDraftSourceRequired')}</p>:null}<p role="status" aria-live="polite" className="mt-2 text-xs text-ds-muted">{error?t('surveyDraftUnavailable'):selectedDraft?t('surveyDraftUnsigned'):''}</p>
  </section>
}
