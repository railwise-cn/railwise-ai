import { isAbsolute, resolve } from 'node:path'
import type { CapabilityPreflight } from '../contracts/harness.js'
import type { ThreadRecord } from '../contracts/threads.js'
import type { TaskRun } from '../contracts/tasks.js'
import type { TaskExecutionRestriction } from './task-permission-service.js'
import { canonicalTrustRoot, type WorkspaceTrustReader } from './workspace-trust-reader.js'
import { containedArtifact } from './task-artifact-proof.js'

/** A requested output filename alone is compatible with the managed task directory. */
export function explicitWorkspaceWrite(text: string): { target?: string; edit: boolean } | null {
  if (/^(?:(?:请|帮我)\s*)?(?:如何|怎么|怎样|介绍|解释|how\s|what\s|explain\b)/i.test(text.trim())) return null
  const saves = text.matchAll(/(?:保存|导出|输出|放置|写)(?:[^。！？\n]{0,12}?)(?:到|至|进|入)\s*|(?:save|write|export)\b[^.!?\n]{0,25}?\b(?:to|into)\s+/gi)
  const edit = /(?:修改|编辑|覆盖|替换|更新)[^。！？\n]{0,35}(?:文件|工作区|当前目录|\.\w{1,8})|\b(?:edit|modify|overwrite|replace)\b[^.!?\n]{0,35}(?:file|workspace|\.\w{1,8})/i.exec(text)
  const destinations = Array.from(saves, match => ({ text: text.slice(match.index + match[0].length), managedOutput: true }))
  if (edit) destinations.push({ text: text.slice(edit.index).replace(/^(?:修改|编辑|覆盖|替换|更新|edit|modify|overwrite|replace)\s*/i, ''), managedOutput: false })
  for (const destination of destinations) {
    const rawTarget = destination.text.trim()
    if (destination.managedOutput && /^(?:(?:本|当前)任务的?(?:成果(?:目录|区)?|输出目录)|任务成果(?:目录|区)?)(?=$|[，,。；;！？\n]|并(?:自动)?(?:打开|预览|展示|显示|交付))/u.test(rawTarget)) continue
    const targetText = rawTarget.replace(/^(?:(?:当前|本)(?:工作区|目录|项目)(?:中的|的|中|下)?|(?:工作区|目录|项目)(?:中的|的|中|下))\s*/, '')
    if (/^(?:飞书|钉钉|Lark|Feishu|DingTalk|云盘|网盘|云端|远端|GitHub|Notion|腾讯文档)/i.test(targetText)) continue
    const quoted = /["'`“]([^"'`”\n]+)["'`”]/.exec(targetText)?.[1]
    const absolute = /(?:^|\s)((?:[A-Za-z]:[\\/]|\/)[^\s，。；！？"'`<>]+)/.exec(targetText)?.[1]
    const relative = /^(?:\.\.?[\\/])?[\w\p{L}.-]+(?:[\\/][\w\p{L}.-]+)*(?:\.[\w]+)?/u.exec(targetText)?.[0]
    const target = quoted ?? absolute ?? relative
    if (target && /^(?:https?:|\/\/)/i.test(target)) continue
    return { ...(target && !/^(?:当前|本|工作区|目录|项目|the|this)$/i.test(target) ? { target } : {}), edit: Boolean(edit) }
  }
  return null
}

export function workspacePermissionCapability(code: string, message: string, executionContext?: CapabilityPreflight['executionContext']): CapabilityPreflight {
  const resolution = { kind: 'grant' as const, route: 'task-permissions', label: '确认当前任务权限' }
  return { provider: 'workspace', status: 'blocked', errorCode: code, message, credentialState: 'unknown', networkState: 'unknown', workspaceState: 'blocked',
    sandboxState: code.startsWith('sandbox_') ? 'blocked' : 'allowed', approvalState: 'required', resolution, action: resolution, checkedAt: new Date().toISOString(),
    ...(executionContext ? { executionContext } : {}) }
}

export function workspaceWritePreflight(deps: { workspaceTrust: WorkspaceTrustReader; restriction(threadId: string, sourceTaskId?: string): Promise<TaskExecutionRestriction> }) {
  return async (text: string, thread?: ThreadRecord, sourceTask?: TaskRun): Promise<CapabilityPreflight | null> => {
    const requested = explicitWorkspaceWrite(text)
    if (!requested || !thread) return null
    let executionContext: CapabilityPreflight['executionContext']
    const block = (code: string, message: string) => workspacePermissionCapability(code, message, executionContext)
    try {
      const workspace = await deps.workspaceTrust.get(thread.workspace)
      const agentTrust = thread.agentProfile?.trustLevel ?? 'full-access'
      const readOnly = workspace.level === 'read-only' || agentTrust === 'read-only' || thread.sandboxMode === 'read-only'
      const confined = workspace.level !== 'full-access' || agentTrust !== 'full-access'
      executionContext = { workspaceRoot: workspace.canonicalRoot, workspaceTrust: workspace.level, agentTrust, sandboxMode: readOnly ? 'read-only' : confined && thread.sandboxMode === 'danger-full-access' ? 'workspace-write' : thread.sandboxMode, approvalPolicy: thread.approvalPolicy }
      if (thread.agentProfile?.trustLevel === 'read-only' || ['read-only', 'external-sandbox'].includes(thread.sandboxMode)) return block('sandbox_read_only', '当前 Agent 或显式沙箱限制写入。请为此任务选择允许写入的执行权限。')
      if (thread.approvalPolicy === 'never') return block('approval_policy_blocked', '当前任务策略禁止工具执行，请先确认任务权限。')
      const tools = thread.agentProfile?.toolAllowlist
      if (tools && !tools.includes('*') && !tools.includes('write') && !(requested.edit && tools.includes('edit'))) return block('agent_tool_blocked', '当前 Agent 没有文件写入工具，请为此任务选择具备文件编辑能力的 Agent。')
      const restriction = await deps.restriction(thread.id, sourceTask?.id)
      if (restriction.workspaceWriteException || (workspace.level !== 'full-access' && thread.sandboxMode === 'danger-full-access')) executionContext.sandboxMode = 'workspace-write'
      if (!workspace.canonicalRoot) return block('workspace_path_blocked', '请先选择要保存成果的工作区，并确认本任务的目标路径。')
      if (requested.target && /^(?:[A-Za-z]:[\\/]|\\\\)/.test(requested.target) && process.platform !== 'win32') return block('workspace_path_blocked', '所指定的 Windows 路径在当前系统不可用，请选择本机目标路径。')
      const target = await canonicalTrustRoot(requested.target ? isAbsolute(requested.target) ? requested.target : resolve(workspace.canonicalRoot, requested.target) : workspace.canonicalRoot)
      const permitted = restriction.permissionScope?.writePaths
      if (permitted !== undefined) {
        const roots = await Promise.all(permitted.map(canonicalTrustRoot))
        if (!roots.some(root => containedArtifact(root, target))) return block('workspace_path_blocked', `本任务的现有写入范围不包含 ${target}，请确认该目标路径的权限。`)
      }
      if (workspace.level === 'read-only' && !restriction.workspaceWriteException) return block('workspace_path_blocked', `保存到 ${target} 需要当前任务的路径写入授权。`)
      if (!permitted && workspace.level !== 'full-access' && !containedArtifact(workspace.canonicalRoot, target)) return block('workspace_path_blocked', `目标 ${target} 超出当前工作区，请确认该路径的任务授权。`)
      return null
    } catch (error) {
      return block((error as { code?: string }).code ?? 'workspace_trust_unavailable', '当前任务的路径授权无法核验，请检查权限或重新确认已到期的授权。')
    }
  }
}
