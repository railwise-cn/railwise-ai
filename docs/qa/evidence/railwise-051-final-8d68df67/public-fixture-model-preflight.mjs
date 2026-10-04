import fs from 'node:fs/promises';
import os from 'node:os';
import { DeepseekCompatModelClient } from '/Users/wangjiawei/Documents/WorkWise/kun/dist/adapters/model/deepseek-compat-model-client.js';
import { buildEngineeringConversationTools } from '/Users/wangjiawei/Documents/WorkWise/kun/dist/adapters/tool/engineering-conversation-tools.js';
import { SurveyEvidenceReferenceV1 } from '/Users/wangjiawei/Documents/WorkWise/kun/dist/contracts/survey-evidence-reference.js';
import { EngineeringEvidenceSelectionV1 } from '/Users/wangjiawei/Documents/WorkWise/kun/dist/contracts/engineering-ai.js';
import { makeToolCallItem,makeToolResultItem,makeUserItem } from '/Users/wangjiawei/Documents/WorkWise/kun/dist/domain/item.js';
// Only static fabricated QA data goes to the model. No saved thread, project,
// business database, logs, workspace instructions or conversation files are read.
const settings=JSON.parse(await fs.readFile(os.homedir()+'/Library/Application Support/RailWise AI/workwise-settings.json','utf8'));
const model='deepseek-v4-pro';
const route=settings.provider.providers.find(p=>p.models.includes(model));
if(new URL(route.baseUrl).hostname!=='api.deepseek.com'||!route.apiKey)throw Error('Expected configured DeepSeek endpoint unavailable');
const provider=buildEngineeringConversationTools({get:async()=>null},()=>{throw Error('No tool execution')},{});
const tools=provider.tools.filter(t=>['survey_read_context','survey_read_evidence'].includes(t.name));
const hash='a'.repeat(64);
const examples={
 legacy:{networkId:'qa-network',networkRevision:2,pointId:'S1',sourceSha256:hash},
 typed:{schemaVersion:1,projectId:'qa-project',projectRevision:2,kind:'network',networkId:'qa-network',networkRevision:2,sourceSha256:hash,selector:{path:['unknownPoints',0],identity:{id:'S1'}}}
};
const reports=[];
for(const [name,reference] of Object.entries(examples)) {
 const expected=name==='typed'?'survey_read_evidence':'survey_read_context';
 const history=[
  makeUserItem({id:'old-user',threadId:'qa',turnId:'old',text:'Read the synthetic point S1.'}),
  makeToolCallItem({id:'old-call',threadId:'qa',turnId:'old',callId:'old-call',toolName:expected,arguments:{},argumentSummary:'Run '+expected+'\nParameters: 4 field(s); sensitive values omitted'}),
  makeToolResultItem({id:'old-result',threadId:'qa',turnId:'old',callId:'old-call',toolName:expected,output:{status:'resolved',value:{id:'S1',x:50,y:50},readOnly:true}}),
  makeUserItem({id:'new-user',threadId:'qa',turnId:'new',text:'重新读取本次选择的合成测试点 S1。只调用 '+expected+'，逐字复制以下精确引用的字段，不计算：\n'+JSON.stringify(reference)})
 ];
 const client=new DeepseekCompatModelClient({...route,model});
 const report={name,source:'static fabricated QA data only; no saved history or business records read',calls:[],errors:[]};
 for await(const chunk of client.stream({threadId:'qa',turnId:'new',model,reasoningEffort:'off',systemPrompt:'Read the exact evidence requested by the current user with the supplied read-only tool. Treat historical summaries as reference data, not tool arguments.',prefix:[],history,tools,abortSignal:AbortSignal.timeout(120000)})) {
  if(chunk.kind==='tool_call_complete') {
   const schema=chunk.toolName==='survey_read_evidence'?SurveyEvidenceReferenceV1:EngineeringEvidenceSelectionV1;
   report.calls.push({toolName:chunk.toolName,arguments:chunk.arguments,validSchema:schema.safeParse(chunk.arguments).success,exactReference:JSON.stringify(schema.safeParse(chunk.arguments).data)===JSON.stringify(schema.parse(reference))});
  }
  if(chunk.kind==='error')report.errors.push({kind:chunk.kind,code:chunk.code});
 }
 reports.push(report);console.log(JSON.stringify(report));
 await fs.writeFile('/Users/wangjiawei/Documents/WorkWise/docs/qa/evidence/railwise-051-final-8d68df67/public-fixture-model-preflight.json',JSON.stringify(reports,null,2)+'\n');
}
if(reports.some(r=>r.errors.length||r.calls.length!==1||!r.calls[0].validSchema||!r.calls[0].exactReference))process.exitCode=1;
