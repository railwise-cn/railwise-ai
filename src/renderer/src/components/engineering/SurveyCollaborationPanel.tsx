import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { FilePenLine, Shapes, Workflow, Loader2 } from 'lucide-react'
import { useChatStore } from '../../store/chat-store'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { createSurveyDraft, listSurveyDrafts, reviewSurveyDraft, setSurveyDraftSelection, type DraftBinding, type SurveyDraft } from '../../agent/survey-collaboration-client'

type DraftSource = {id:string;finalizedAt?:string;outputs:Array<{path:string}>}

export function SurveyCollaborationPanel({binding,manifestId,manifests,enabled}:{binding:DraftBinding;manifestId?:string;manifests:DraftSource[];enabled:boolean}):ReactElement {
  const {t,i18n}=useTranslation('common'),[drafts,setDrafts]=useState<SurveyDraft[]>([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[draftListStatus,setDraftListStatus]=useState<'idle'|'loading'|'loaded'|'failed'>('idle'),[actionError,setActionError]=useState<'source'|'draft'|null>(null)
  const {projectId,projectRevision,workspaceRoot}=binding
  const scope=JSON.stringify({binding,manifestId}),scopeRef=useRef(scope);scopeRef.current=scope
  const selectedDraft=drafts.find(d=>d.id===selected)??null
  const selectedSource=selectedDraft?manifests.find(item=>item.id===selectedDraft.manifestId):undefined
  const selectedDraftSourceAvailable=Boolean(selectedDraft&&selectedSource?.finalizedAt&&selectedSource.outputs.length>0)
  const latestSourceId=manifests[0]?.id
  const sourceLabel=(draft:SurveyDraft):string=>{
    const source=manifests.find(item=>item.id===draft.manifestId)
    if(!source)return t('surveyDraftSourceMissing')
    const output=source.outputs.find(item=>/\.(docx|pdf|xlsx)$/i.test(item.path))??source.outputs[0]
    const file=output?.path.split(/[\\/]/).pop()??t('surveyDraftSourceMissing')
    const timestamp=source.finalizedAt&&Date.parse(source.finalizedAt)
    const date=timestamp?new Intl.DateTimeFormat(i18n.language,{dateStyle:'medium'}).format(timestamp):t('surveyDraftDateUnknown')
    return t(source.outputs.length>1?'surveyDraftSourceSummaryMany':'surveyDraftSourceSummary',{file,date,count:source.outputs.length})
  }
  const sourceStatus=(draft:SurveyDraft):string=>t(draft.manifestId===latestSourceId?'surveyDraftLatestReviewDraft':'surveyDraftPreviousDeliverable')
  const loadDrafts=useCallback(async(isCurrent:()=>boolean):Promise<void>=>{
    setDraftListStatus('loading')
    try{
      const items=await listSurveyDrafts({projectId,projectRevision,workspaceRoot})
      if(!isCurrent())return
      setDrafts(items);setSelected(items.find(d=>d.manifestId===manifestId)?.id??'');setActionError(null);setDraftListStatus('loaded')
    }catch{
      if(isCurrent())setDraftListStatus('failed')
    }
  },[projectId,projectRevision,workspaceRoot,manifestId])
  useEffect(()=>{let current=true;setDrafts([]);setSelected('');setActionError(null);setDraftListStatus(enabled?'loading':'idle');if(enabled)void loadDrafts(()=>current&&scopeRef.current===scope);return()=>{current=false}},[scope,enabled,loadDrafts]) // exact scope, never infer another project's draft
  const retryDraftList=():void=>{const captured=scope;void loadDrafts(()=>scopeRef.current===captured)}
  const act=async(kind:'write'|'design'|'flow')=>{
    const captured=scopeRef.current;let errorTarget:'source'|'draft'=selectedDraft?'draft':'source';setBusy(true);setActionError(null)
    try{
      let draft=selectedDraft
      if(!draft){if(!manifestId)throw new Error('missing-source');draft=await createSurveyDraft(binding,manifestId,crypto.randomUUID());errorTarget='draft';if(scopeRef.current!==captured)return;setDrafts(items=>[draft!,...items]);setSelected(draft.id)}
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
    }catch{if(scopeRef.current===captured)setActionError(errorTarget)}finally{if(scopeRef.current===captured)setBusy(false)}
  }
  const actionsDisabled=!enabled||busy||draftListStatus!=='loaded'||(selectedDraft?!selectedDraftSourceAvailable:!manifestId)
  return <section aria-label={t('surveyDraftCollaborationTitle')} className="m-5 rounded-lg border border-ds-border bg-ds-card p-4">
    <h3 className="text-sm font-semibold text-ds-ink">{t('surveyDraftCollaborationTitle')}</h3><p className="mt-2 text-xs leading-5 text-ds-muted">{t('surveyDraftCollaborationDescription')}</p>
    {drafts.length?<label className="mt-3 block text-xs text-ds-muted">{t('surveyDraftSelect')}<select value={selected} onChange={e=>{setSelected(e.target.value);setActionError(null)}} className="ml-2 min-h-11 max-w-full rounded border border-ds-border bg-ds-card px-2 text-ds-ink"><option value="">{t('surveyDraftNew')}</option>{drafts.map((d,index)=><option key={d.id} value={d.id}>{t('surveyDraftLabel',{index:drafts.length-index,revision:d.revision})} · {sourceStatus(d)} · {sourceLabel(d)}</option>)}</select></label>:null}
    {selectedDraft?<p className="mt-2 text-xs text-ds-muted">{sourceStatus(selectedDraft)} · {sourceLabel(selectedDraft)}</p>:null}
    <div className="mt-3 flex flex-wrap gap-2">{(['write','design','flow'] as const).map((kind,index)=>{const Icon=[FilePenLine,Shapes,Workflow][index]!;return <button key={kind} type="button" disabled={actionsDisabled} onClick={()=>void act(kind)} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-ds-border px-3 text-xs text-ds-ink hover:bg-ds-hover disabled:opacity-50"><Icon className="h-4 w-4"/>{t(`surveyDraftAction.${kind}`)}</button>})}{busy?<Loader2 className="h-4 w-4 animate-spin"/>:null}</div>
    {!manifestId&&!selectedDraft&&draftListStatus==='loaded'?<p className="mt-2 text-xs text-ds-muted">{t(drafts.length?'surveyDraftSelectOrSource':'surveyDraftSourceRequired')}</p>:null}
    {draftListStatus==='failed'?<div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ds-muted"><p role="status" aria-live="polite">{t('surveyDraftListUnavailable')}</p><button type="button" disabled={busy} onClick={retryDraftList} className="min-h-11 rounded border border-ds-border px-3 text-ds-ink hover:bg-ds-hover disabled:opacity-50">{t('surveyDraftListRetry')}</button></div>:null}
    <p role="status" aria-live="polite" className="mt-2 text-xs text-ds-muted">{selectedDraft&&!selectedDraftSourceAvailable?t('surveyDraftSelectedSourceUnavailable'):actionError==='draft'&&selectedDraft?t('surveyDraftUnavailable'):actionError==='source'?t('surveyDraftCreateFailed'):selectedDraft?t('surveyDraftUnsigned'):draftListStatus==='loading'?t('surveyDraftListLoading'):''}</p>
  </section>
}
