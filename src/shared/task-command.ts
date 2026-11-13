import type { TaskRunV1, TaskInputV1 } from './agent-workbench'
/** Public capability snapshot. Runtime identities and credentials stay private. */
export type ExternalTaskCapability = {
  provider: 'dingtalk' | 'lark' | 'feishu' | 'browser-skill' | 'workspace' | 'schedule'
  status: 'available' | 'not_installed' | 'needs_authorization' | 'unsupported' | 'blocked'
  message: string
  errorCode?: string
  credentialState?: 'missing' | 'invalid' | 'valid' | 'unknown'
  networkState?: 'available' | 'blocked' | 'unknown'
  workspaceState?: 'allowed' | 'blocked' | 'unknown'
  sandboxState?: 'allowed' | 'blocked'
  approvalState?: 'not_required' | 'required' | 'denied'
  workspaceRoot?: string
  requiredScopes?: string[]
  checkedAt?: string
  executionContext?: {
    workspaceRoot: string
    workspaceTrust: 'read-only' | 'workspace-write' | 'trusted' | 'full-access'
    agentTrust: 'read-only' | 'workspace-write' | 'trusted' | 'full-access'
    sandboxMode: string
    approvalPolicy: string
    availableTools?: string[]
  }
  action?: { kind: 'install' | 'connect' | 'grant' | 'switch_workspace' | 'retry'; route: string; label: string }
  resolution?: { kind: 'install' | 'connect' | 'grant' | 'switch_workspace' | 'retry'; route: string; label: string }
}
export type ExternalTaskCapabilityCard = {
  threadId: string
  taskId: string
  attentionId?: string
  prompt: string
  capability: ExternalTaskCapability
}
export type TaskIntentCard = {
  threadId: string
  taskId?: string
  attentionId: string
  request: Record<string, unknown> & { prompt: string }
  choices: Array<'supplement' | 'new'>
}
export type TaskCommandRequest = { threadId:string; taskId?:string; resolveAttentionId?:string; selectedExternalProvider?:'dingtalk'|'lark'; intent:'auto'|'status'|'supplement'|'new'|'chat'|'pause'|'resume'|'cancel'; idempotencyKey:string; expectedRevision?:number; request:Record<string,unknown> & {prompt:string} }
export type TaskCommandResult = ({kind:'snapshot';task:TaskRunV1|null} | {kind:'input_queued';task:TaskRunV1;input:TaskInputV1} | {kind:'task_updated';action:'pause'|'cancel';task:TaskRunV1} | {kind:'task_started'|'chat_started';task?:TaskRunV1;turn:{threadId:string;turnId:string;userMessageItemId?:string}} | {kind:'attention_required';task?:TaskRunV1;attentionId?:string;message:string} | {kind:'capability_required';task?:TaskRunV1;attentionId?:string;message:string;capability:ExternalTaskCapability}) & {receipt?:{userMessageItemId:string;resultMessageItemId:string};intentCard?:TaskIntentCard}
