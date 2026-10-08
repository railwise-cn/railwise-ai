import { z } from 'zod'
import { SurveyCollaborationDraftV1 } from '@shared/survey-collaboration'
import { rendererRuntimeClient } from './runtime-client'
export type SurveyDraft = z.infer<typeof SurveyCollaborationDraftV1>
export type DraftBinding = {projectId:string;projectRevision:number;workspaceRoot:string}
const base=(pid:string)=>`/v1/engineering/projects/${encodeURIComponent(pid)}/collaboration-drafts`
async function request(path:string,method='GET',value?:unknown):Promise<unknown>{
  const response=await rendererRuntimeClient.runtimeRequest(path,method,value===undefined?undefined:JSON.stringify(value))
  if(!response.ok)throw new Error('survey-draft-unavailable')
  if(new TextEncoder().encode(response.body).length>1024*1024)throw new Error('survey-draft-unavailable')
  return JSON.parse(response.body)
}
function checked(raw:unknown,binding:DraftBinding):SurveyDraft {
  const draft=SurveyCollaborationDraftV1.parse(raw)
  if(draft.projectId!==binding.projectId||draft.projectRevision!==binding.projectRevision||draft.workspace!==binding.workspaceRoot)throw new Error('survey-draft-stale')
  return draft
}
export async function listSurveyDrafts(binding:DraftBinding):Promise<SurveyDraft[]>{return z.object({drafts:z.array(SurveyCollaborationDraftV1).max(30)}).parse(await request(base(binding.projectId))).drafts.filter(d=>d.projectRevision===binding.projectRevision&&d.workspace===binding.workspaceRoot)}
export async function createSurveyDraft(binding:DraftBinding,manifestId:string,key:string):Promise<SurveyDraft>{return checked(await request(base(binding.projectId),'POST',{manifestId,expectedProjectRevision:binding.projectRevision,idempotencyKey:key}),binding)}
export async function reviewSurveyDraft(binding:DraftBinding,draft:SurveyDraft):Promise<SurveyDraft>{return checked(await request(`${base(binding.projectId)}/${encodeURIComponent(draft.id)}/review`,'POST',{expectedRevision:draft.revision}),binding)}
export async function sealSurveyDraft(binding:DraftBinding,draft:SurveyDraft):Promise<SurveyDraft>{return checked(await request(`${base(binding.projectId)}/${encodeURIComponent(draft.id)}/seal`,'POST',{expectedRevision:draft.revision}),binding)}
export async function resolveSurveyEditorDraft(workspace:string,selection:{path?:string;documentId?:string}):Promise<SurveyDraft|null>{
  const value=z.object({draft:SurveyCollaborationDraftV1.nullable()}).parse(await request('/v1/engineering/collaboration-drafts/resolve','POST',{workspace,...selection})).draft
  if(value&&value.workspace!==workspace)throw new Error('survey-draft-stale')
  return value
}

/** Selection survives view remounts. The runtime remains authoritative for source and revision. */
let selection: {kind:'design';workspace:string;documentId:string}|{kind:'flow';flowId:string;runId:string}|null=null
export function setSurveyDraftSelection(next:NonNullable<typeof selection>):void {selection=next;window.dispatchEvent(new Event('survey-draft-selection'))}
export function surveyDraftSelection():typeof selection{return selection}
export function clearSurveyDraftSelection():void{selection=null}
