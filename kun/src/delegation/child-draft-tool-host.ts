import { makeToolResultItem } from '../domain/item.js'
import type { ToolHost, ToolHostContext } from '../ports/tool-host.js'

const builtins=new Set(['read','ls','find','grep','echo','user_input','request_user_input'])
const documents=new Set(['read_delivery_sources','read_task_context','propose_document','export_document','analyze_delivery_monitoring'])
const attachments=new Set(['list_attachment_sections','search_attachment','read_attachment_section'])
type Spec=Awaited<ReturnType<ToolHost['listTools']>>[number]
function permitted(tool:Spec):boolean {
  return tool.providerId==='builtin'&&tool.providerKind==='built-in'&&builtins.has(tool.name)
    ||tool.providerId==='document-delivery'&&tool.providerKind==='built-in'&&documents.has(tool.name)
    ||tool.providerId==='attachment-retrieval'&&tool.providerKind==='attachment'&&attachments.has(tool.name)
}

/** Child workers read authorized sources and write only through task-owned candidate tools.
 * Tool-name and provider checks run again at execution, including unadvertised model calls.
 * The parent's host and capabilities are unchanged; arbitrary commands and final writes stay there.
 */
export function childDraftToolHost(parent:ToolHost):ToolHost {
  const list=async(context?:ToolHostContext)=>(await parent.listTools(context)).filter(permitted)
  return {
    id:`${parent.id}:child-draft`,listTools:list,
    clearReadTracker:threadId=>parent.clearReadTracker?.(threadId),
    async execute(call,context,onUpdate) {
      const advertised=(await list(context)).find(tool=>tool.name===call.toolName&&(!call.providerId||call.providerId===tool.providerId))
      if(!advertised)return {approved:false,item:makeToolResultItem({id:`item_${call.callId}`,turnId:context.turnId,threadId:context.threadId,callId:call.callId,toolName:call.toolName,toolKind:call.toolKind,output:{code:'child_candidate_only',error:'子任务仅可读取已授权资料并生成任务候选成果。Shell、任意文件修改和外部动作必须交由父任务处理。'},isError:true})}
      return parent.execute({...call,providerId:advertised.providerId},context,onUpdate)
    }
  }
}
