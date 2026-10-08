import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveSurveyEditorDraft, reviewSurveyDraft, setSurveyDraftSelection, type SurveyDraft } from '../../agent/survey-collaboration-client'
import { useChatStore } from '../../store/chat-store'

export function SurveyDraftEditorNotice({workspace,path,documentId,save}:{workspace:string;path?:string;documentId?:string;save:()=>Promise<boolean>}):ReactElement|null {
  const {t}=useTranslation('common'),[draft,setDraft]=useState<SurveyDraft|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false)
  const scope=JSON.stringify([workspace,path,documentId]),scopeRef=useRef(scope);scopeRef.current=scope
  useEffect(()=>{let current=true;setDraft(null);setError(false);if(workspace&&(path||documentId))void resolveSurveyEditorDraft(workspace,{path,documentId}).then(value=>{if(current)setDraft(value)}).catch(()=>undefined);return()=>{current=false}},[workspace,path,documentId])
  if(!draft)return null
  const review=async()=>{const captured=scopeRef.current;setBusy(true);setError(false);try{
    if(!await save())throw new Error('save-failed')
    if(scopeRef.current!==captured)return
    const fresh=await reviewSurveyDraft({projectId:draft.projectId,projectRevision:draft.projectRevision,workspaceRoot:workspace},draft)
    if(scopeRef.current!==captured)return
    setDraft(fresh)
    if(!fresh.flowId||!fresh.runId)throw new Error('review-unavailable')
    setSurveyDraftSelection({kind:'flow',flowId:fresh.flowId,runId:fresh.runId});useChatStore.getState().openFlow()
  }catch{if(scopeRef.current===captured)setError(true)}finally{if(scopeRef.current===captured)setBusy(false)}}
  return <aside className="flex flex-wrap items-center gap-3 border-b border-ds-border bg-ds-card px-4 py-3 text-xs text-ds-muted"><p className="min-w-0 flex-1">{t('surveyDraftEditorNotice')}</p><button type="button" disabled={busy} onClick={()=>void review()} className="min-h-11 rounded-md border border-ds-border px-3 font-medium text-ds-ink disabled:opacity-50">{t('surveyDraftAction.flow')}</button><span role="status" aria-live="polite">{error?t('surveyDraftUnavailable'):''}</span></aside>
}
