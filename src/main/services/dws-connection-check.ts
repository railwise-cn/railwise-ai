import { randomUUID } from 'node:crypto'
import type { ManagedDwsStatus, ManagedDwsTaskAccessResult } from '../../shared/managed-dws'
import { DwsCapabilityConfig } from '../../../kun/src/contracts/dws.js'
import { ExecutionGrantSchema } from '../../../kun/src/contracts/permissions.js'
import { CapabilityRegistry } from '../../../kun/src/adapters/tool/capability-registry.js'
import { LocalToolHost } from '../../../kun/src/adapters/tool/local-tool-host.js'
import { buildDwsToolProvider, type DwsRunner } from '../../../kun/src/adapters/tool/dws-tool-provider.js'

const failureMessages: Record<string, string> = {
  connector_disabled: '钉钉连接器已停用，请先启用。',
  connector_not_installed: '请先安装钉钉连接依赖。',
  connector_authorization_required: '钉钉登录已失效，请重新授权。',
  connector_identity_unverified: '钉钉账号尚未核验，请重新检查连接。',
  connector_identity_changed: '钉钉账号已发生变化，请重新检查连接后测试。',
  connector_access_denied: '钉钉拒绝了待办读取，请在官方授权页检查账号和组织权限。',
  connector_network_failed: '无法连接钉钉服务，请检查网络后重试。',
  connector_request_timeout: '钉钉待办读取超时，请稍后重试。',
  connector_rate_limited: '钉钉服务请求过于频繁，请稍后重试。',
  connector_remote_failed: '钉钉服务未能完成待办读取，请稍后重试。',
  connector_invalid_response: '钉钉返回的待办结果无法核验，请重试或查看连接诊断。',
  connector_executable_changed: '钉钉连接依赖发生变化，请重新检查安装。',
  candidate_credentials_disabled: '当前候选环境未开启连接器凭据访问。'
}

export function dwsTaskAccessFailure(code: string): ManagedDwsTaskAccessResult {
  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    code,
    message: failureMessages[code] ?? '钉钉待办读取检查失败，请检查连接后重试。'
  }
}

/** Runs the same typed provider as tasks, with a grant restricted to one read. */
export async function checkDingTalkTaskAccess(
  status: ManagedDwsStatus | undefined,
  runner?: DwsRunner
): Promise<ManagedDwsTaskAccessResult> {
  if (status?.enabled === false) return dwsTaskAccessFailure('connector_disabled')
  if (!status || status.state === 'not_installed') return dwsTaskAccessFailure('connector_not_installed')
  if (status.state !== 'installed') return dwsTaskAccessFailure('connector_authorization_required')

  try {
    const config = DwsCapabilityConfig.parse({
      enabled: true,
      authState: status.state,
      executablePath: status.executablePath,
      executableHash: status.executableHash,
      profile: status.profile,
      corpId: status.corpId,
      userId: status.userId,
      identityFingerprint: status.identityFingerprint,
      scopes: status.scopes ?? []
    })
    const provider = buildDwsToolProvider(config, runner)
    if (!provider) return dwsTaskAccessFailure('connector_identity_unverified')
    const checkId = `dingtalk-read-check-${randomUUID()}`
    const grant = ExecutionGrantSchema.parse({
      id: checkId,
      threadId: checkId,
      turnId: checkId,
      workspaceRoot: '',
      workspaceTrust: 'read-only',
      agentTrust: 'read-only',
      sandboxMode: 'read-only',
      approvalPolicy: 'auto',
      allowedToolNames: ['dingtalk_list_tasks'],
      allowedProviderIds: ['dingtalk'],
      networkAllowlist: ['https://mcp.dingtalk.com'],
      connectorIdentityFingerprints: { dingtalk: config.identityFingerprint },
      workspaceRevision: 0,
      agentRevision: 0,
      revision: 0,
      idempotencyKey: checkId,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 45_000).toISOString()
    })
    const host = new LocalToolHost({ registry: new CapabilityRegistry([provider]) })
    const result = await host.execute({
      callId: checkId,
      providerId: 'dingtalk',
      toolName: 'dingtalk_list_tasks',
      arguments: { page: 1, pageSize: 1 }
    }, {
      threadId: checkId,
      turnId: checkId,
      workspace: '',
      approvalPolicy: 'auto',
      sandboxMode: 'read-only',
      allowedToolNames: grant.allowedToolNames,
      allowedProviderIds: grant.allowedProviderIds,
      executionGrant: grant,
      abortSignal: AbortSignal.timeout(45_000),
      awaitApproval: async () => 'deny'
    })
    const output = result.item.kind === 'tool_result' ? result.item.output as {
      status?: string
      code?: string
      data?: { todoCards?: unknown[] }
      evidence?: { verified?: boolean }
    } : undefined
    if (output?.status !== 'succeeded' || output.evidence?.verified !== true || !Array.isArray(output.data?.todoCards)) {
      return dwsTaskAccessFailure(output?.code ?? 'connector_invalid_response')
    }
    // Return only a bounded count. Never copy todo titles, IDs, or raw output to IPC.
    const itemCount = output.data.todoCards.length
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      itemCount,
      message: itemCount === 0 ? '待办读取已验证，本次查询未返回待办。' : '待办读取已验证。'
    }
  } catch (error) {
    const code = (error as { code?: unknown })?.code
    return dwsTaskAccessFailure(typeof code === 'string' ? code : 'connector_request_failed')
  }
}
