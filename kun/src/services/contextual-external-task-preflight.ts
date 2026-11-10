import type { CapabilityPreflight } from '../contracts/harness.js'
import type { SandboxMode } from '../contracts/policy.js'
import type { WorkspaceTrustLevel } from '../contracts/permissions.js'
import type { ThreadRecord } from '../contracts/threads.js'
import type { StartTurnRequest } from '../contracts/turns.js'
import type { ToolHost, ToolHostContext } from '../ports/tool-host.js'
import { externalTaskIntent, type ExternalTaskPreflight } from './external-task-capability.js'
import type { WorkspaceTrustReader } from './workspace-trust-reader.js'

const TRUST_ORDER: WorkspaceTrustLevel[] = ['read-only', 'workspace-write', 'trusted', 'full-access']
const SCOPE_TOOLS = ['get_external_effect_scope', 'confirm_external_effect_scope']

/** A request can narrow an admission check, but cannot bypass persisted authority. */
export function externalPreflightThreadContext(thread: ThreadRecord, request: Pick<StartTurnRequest, 'approvalPolicy' | 'sandboxMode' | 'mode'>): ThreadRecord {
  const policies = ['auto', 'suggest', 'on-request', 'untrusted', 'never'] as const
  const modes = ['danger-full-access', 'workspace-write', 'external-sandbox', 'read-only'] as const
  return {
    ...thread,
    mode: request.mode ?? thread.mode,
    approvalPolicy: policies[Math.max(policies.indexOf(thread.approvalPolicy), policies.indexOf(request.approvalPolicy ?? thread.approvalPolicy))]!,
    sandboxMode: modes[Math.max(modes.indexOf(thread.sandboxMode), modes.indexOf(request.sandboxMode ?? thread.sandboxMode))]!
  }
}

/** Checks the actual Runtime catalog before a model Turn is allocated. No tool executes here. */
export function contextualExternalTaskPreflight(deps: {
  providerPreflight: ExternalTaskPreflight
  workspaceTrust: WorkspaceTrustReader
  toolHost: Pick<ToolHost, 'listTools'>
  validateTaskPermission?: (threadId: string) => Promise<unknown>
}): ExternalTaskPreflight {
  return async (text, thread) => {
    const capability = await deps.providerPreflight(text)
    if (!capability || !thread) return capability
    const intent = externalTaskIntent(text)
    if (!intent) return capability
    let workspace: Awaited<ReturnType<WorkspaceTrustReader['get']>>
    try { workspace = await deps.workspaceTrust.get(thread.workspace) }
    catch {
      return blocked(capability, 'workspace_trust_unavailable', '当前工作区权限记录无法读取。请检查工作区权限后继续原任务。',
        { workspaceState: 'blocked' }, { kind: 'grant', route: 'settings', label: '检查工作区权限' })
    }
    const executionContext = {
      workspaceRoot: workspace.canonicalRoot, workspaceTrust: workspace.level,
      agentTrust: thread.agentProfile?.trustLevel ?? 'full-access' as const,
      sandboxMode: effectiveSandbox(thread, workspace.level), approvalPolicy: thread.approvalPolicy
    }
    const checked: CapabilityPreflight = { ...capability, executionContext, workspaceState: 'allowed', sandboxState: 'allowed' }
    try { await deps.validateTaskPermission?.(thread.id) }
    catch (error) {
      return blocked(checked, (error as { code?: string }).code ?? 'task_permission_revoked', '当前任务的临时权限已到期或范围发生变化。请重新确认任务权限后继续。',
        { approvalState: 'denied' }, { kind: 'grant', route: 'settings', label: '重新确认当前任务权限' })
    }
    if (capability.status !== 'available' || intent.kind !== 'external_task') return checked
    // LocalToolHost blocks these tools under never, including automatic reads.
    if (thread.approvalPolicy === 'never') return blocked(checked, 'approval_policy_blocked', '当前任务策略禁止工具执行。请调整审批策略后继续原任务。',
      { approvalState: 'denied' }, { kind: 'grant', route: 'settings', label: '调整任务审批策略' })
    const toolNames = requiredExternalToolNames(text)
    const allowlist = normalizedAllowlist(thread.agentProfile?.toolAllowlist)
    const requiredNames = [...toolNames, ...(intent.mutation ? SCOPE_TOOLS : [])]
    if (allowlist && requiredNames.some(name => !allowlist.includes(name))) return blocked(checked, 'agent_tool_blocked', '当前 Agent 的工具范围不包含此任务所需能力。请调整 Agent 工具范围或切换 Agent。',
      {}, { kind: 'grant', route: 'settings', label: '检查 Agent 工具范围' })
    const context: ToolHostContext = {
      threadId: thread.id, turnId: `preflight:${thread.id}`, workspace: workspace.canonicalRoot,
      threadMode: thread.mode, approvalPolicy: thread.approvalPolicy,
      sandboxMode: effectiveSandbox(thread, workspace.level),
      allowedProviderIds: [intent.provider === 'lark' ? 'lark-cli' : 'dingtalk'],
      ...(allowlist ? { allowedToolNames: allowlist } : {}),
      abortSignal: new AbortController().signal, awaitApproval: async () => 'deny'
    }
    try {
      const catalog = await deps.toolHost.listTools(context)
      checked.executionContext = { ...executionContext, availableTools: catalog.slice(0, 256).map(tool => tool.name) }
      const available = new Set(catalog.map(tool => tool.name))
      if (toolNames.every(name => available.has(name))) return checked
      if (thread.mode === 'plan') return blocked(checked, 'task_mode_blocked', '当前处于计划模式，外部工具不会执行。请切换到执行模式后继续原任务。',
        {}, { kind: 'grant', route: 'settings', label: '切换任务执行模式' })
      const unrestricted = await deps.toolHost.listTools({ ...context, sandboxMode: 'danger-full-access' })
      if (toolNames.every(name => unrestricted.some(tool => tool.name === name))) return blocked(checked, 'sandbox_tool_blocked', '当前沙箱不允许此任务所需工具。请检查任务权限，系统不会通过 Shell 绕过限制。',
        { sandboxState: 'blocked' }, { kind: 'grant', route: 'settings', label: '检查任务沙箱权限' })
      return blocked(checked, 'connector_tool_unavailable', '连接器已配置，但当前 Runtime 没有可执行的对应工具。请刷新连接器后继续原任务。',
        {}, { kind: 'retry', route: 'marketplace', label: '刷新连接器能力' })
    } catch {
      return blocked(checked, 'connector_catalog_unavailable', '当前工具目录无法读取。请重新检查连接器后继续原任务。',
        {}, { kind: 'retry', route: 'marketplace', label: '重新检查工具能力' })
    }
  }
}

function blocked(base: CapabilityPreflight, errorCode: string, message: string,
  changes: Partial<CapabilityPreflight>, resolution: NonNullable<CapabilityPreflight['resolution']>): CapabilityPreflight {
  return { ...base, ...changes, status: 'blocked', errorCode, message, resolution, action: resolution }
}

function normalizedAllowlist(values?: readonly string[]): string[] | undefined {
  return !values || values.includes('*') ? undefined : [...new Set(values)]
}

function effectiveSandbox(thread: ThreadRecord, workspaceTrust: WorkspaceTrustLevel): SandboxMode {
  const agentTrust = thread.agentProfile?.trustLevel ?? 'full-access'
  const trust = TRUST_ORDER[Math.min(TRUST_ORDER.indexOf(workspaceTrust), TRUST_ORDER.indexOf(agentTrust))]!
  if (trust === 'read-only' || thread.sandboxMode === 'read-only') return 'read-only'
  if (thread.sandboxMode === 'external-sandbox') return 'external-sandbox'
  return trust === 'full-access' ? thread.sandboxMode : 'workspace-write'
}

export function requiredExternalToolNames(text: string): string[] {
  const intent = externalTaskIntent(text)
  if (!intent?.provider) return []
  const approval = /审批|approval|workflow/i.test(text) || ['approve', 'reject', 'transfer'].includes(intent.operation ?? '')
  const operation = intent.operation ?? (intent.mutation ? approval ? 'approve' : 'complete' : 'list')
  if (intent.provider === 'lark') {
    const tool = approval ? operation === 'detail' ? 'lark_approval_get' : operation === 'list' ? 'lark_approval_list' : `lark_approval_${operation}`
      : operation === 'list' ? 'lark_task_list' : operation === 'detail' ? 'lark_task_get' : 'lark_task_complete'
    return intent.mutation && !intent.operation ? [approval ? 'lark_approval_list' : 'lark_task_list', tool] : [tool]
  }
  const tool = approval ? operation === 'detail' ? 'dingtalk_get_approval' : operation === 'list' ? 'dingtalk_list_approvals' : `dingtalk_${operation}`
    : operation === 'list' ? 'dingtalk_list_tasks' : operation === 'detail' ? 'dingtalk_get_task' : 'dingtalk_complete_task'
  return intent.mutation && !intent.operation ? [approval ? 'dingtalk_list_approvals' : 'dingtalk_list_tasks', tool] : [tool]
}
