import type { Router } from '../router.js'
import { jsonResponse } from '../response.js'
import { ERRORS } from './runtime-error.js'
import type { FlowRuntimeService } from '../../flow/service.js'
import { SurveyCollaborationError, type SurveyCollaborationService } from '../../engineering/survey-collaboration.js'
import { SurveyDraftSealV1 } from '../../contracts/survey-collaboration.js'
import { z } from 'zod'

async function body(request:Request):Promise<unknown> {
  if(Number(request.headers.get('content-length'))>8192||!request.body)throw new SurveyCollaborationError('validation')
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0,timer:ReturnType<typeof setTimeout>|undefined
  const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{void reader.cancel().catch(()=>undefined);reject(new SurveyCollaborationError('validation'))},20000);timer.unref?.()})
  try{while(true){const chunk=await Promise.race([reader.read(),timeout]);if(chunk.done)break;size+=chunk.value.byteLength;if(size>8192){await reader.cancel();throw new SurveyCollaborationError('validation')}chunks.push(chunk.value)}return JSON.parse(Buffer.concat(chunks).toString('utf8'))}
  finally{clearTimeout(timer);reader.releaseLock()}
}
export function registerSurveyCollaborationRoutes(router:Router,deps:{getService:()=>SurveyCollaborationService|undefined;getFlow:()=>FlowRuntimeService|undefined;authorize:(request:Request)=>boolean}):void {
  router.add('POST','/v1/engineering/collaboration-drafts/resolve',async(request)=>{
    if(!deps.authorize(request))return ERRORS.unauthorized()
    const service=deps.getService();if(!service)return ERRORS.unavailable('Survey draft workspace is unavailable')
    try{const input=z.object({workspace:z.string().min(1).max(4096),path:z.string().min(1).max(4096).optional(),documentId:z.string().min(1).max(180).optional()}).strict().parse(await body(request));const response=jsonResponse({draft:service.resolveEditor(input.workspace,input.path,input.documentId)});response.headers['cache-control']='no-store';return response}catch{return ERRORS.validation('Invalid draft selection')}
  })
  const base='/v1/engineering/projects/:projectId/collaboration-drafts'
  for(const operation of ['list','create','detail','seal','review'] as const){
    router.add(operation==='list'||operation==='detail'?'GET':'POST',base+(operation==='create'||operation==='list'?'':'/:draftId'+(operation==='detail'?'':`/${operation}`)),async(request,context)=>{
      if(!deps.authorize(request))return ERRORS.unauthorized()
      const service=deps.getService();if(!service)return ERRORS.unavailable('Survey draft workspace is unavailable')
      try{
        const pid=context.params.projectId!,id=context.params.draftId!;let value:unknown
        if(operation==='list')value={drafts:service.list(pid)}
        else if(operation==='create')value=await service.create(pid,await body(request))
        else if(operation==='detail')value=service.get(pid,id)
        else {const input=SurveyDraftSealV1.parse(await body(request));if(operation==='seal')value=await service.seal(pid,id,input.expectedRevision);else{const flow=deps.getFlow();if(!flow)throw new SurveyCollaborationError('unavailable');value=await service.startReview(pid,id,input.expectedRevision,flow)}}
        const response=jsonResponse(value,operation==='create'?201:200);response.headers['cache-control']='no-store';return response
      }catch(error){const reason=error instanceof SurveyCollaborationError?error.reason:(error as {name?:string})?.name==='ZodError'||error instanceof SyntaxError?'validation':'integrity';const response=jsonResponse({code:`survey_draft_${reason}`,message:'The selected draft could not be checked. Review its source and saved changes before continuing.'},reason==='not-found'?404:reason==='validation'?400:reason==='unavailable'?503:409);response.headers['cache-control']='no-store';return response}
    })
  }
}
