import { readOptionalKunConfigFile } from '../config/kun-config.js'
import { LarkCapabilityConfig, type LarkCapabilityConfig as LarkConfig } from '../contracts/capabilities.js'
import { buildLarkCliToolProvider } from '../adapters/tool/lark-cli-tool-provider.js'
import type { CapabilityToolProvider } from '../adapters/tool/capability-registry.js'
import { preflightExternalTask, externalTaskIntent } from './external-task-capability.js'

/** Refreshes only trusted local configuration; callers cannot choose a CLI path. */
export class ManagedLarkRuntime {
  private config: LarkConfig

  constructor(
    initial: LarkConfig | undefined,
    private readonly configPath?: string,
    private readonly apply?: (provider?: CapabilityToolProvider) => void
  ) {
    this.config = LarkCapabilityConfig.parse(initial ?? {})
  }

  state(): LarkConfig {
    return structuredClone(this.config)
  }

  preflight(text: string) {
    const result = preflightExternalTask(text, { lark: this.config })
    if (result?.provider !== 'lark') return result

    const intent = externalTaskIntent(text)
    if (!intent) return result
    if (result.status !== 'available') return result
    if (intent?.kind === 'connect_provider') {
      const resolution = { kind: 'retry' as const, route: 'marketplace', label: '管理飞书连接' }
      return {
        ...result,
        status: 'blocked' as const,
        errorCode: 'connector_already_authorized',
        message: '飞书连接器已经授权，无需再次连接。',
        action: resolution,
        resolution
      }
    }
    if (intent.operation === 'send' || intent.operation === 'transfer') {
      const resolution = { kind: 'retry' as const, route: 'marketplace', label: '查看飞书能力' }
      return {
        ...result,
        status: 'unsupported' as const,
        errorCode: 'connector_operation_unsupported',
        message: `当前飞书连接器尚不支持${intent.operation === 'send' ? '发送消息' : '转交审批'}。`,
        action: resolution,
        resolution
      }
    }

    const approval = /审批|approval|workflow/i.test(text) || ['approve', 'reject', 'transfer'].includes(intent.operation ?? '')
    const requiredScopes = intent.mutation
      ? approval
        ? ['approval:task:read', 'approval:task:write', 'approval:instance:read']
        : ['task:task:read', 'task:task:write']
      : approval
        ? intent.operation === 'detail' ? ['approval:instance:read'] : ['approval:task:read']
        : ['task:task:read']
    const toolName = approval
      ? intent.operation === 'detail' ? 'lark_approval_get'
        : intent.operation === 'approve' ? 'lark_approval_approve'
          : intent.operation === 'reject' ? 'lark_approval_reject'
            : intent.mutation ? 'lark_approval_approve' : 'lark_approval_list'
      : intent.operation === 'detail' ? 'lark_task_get'
        : intent.operation === 'complete' || intent.mutation ? 'lark_task_complete' : 'lark_task_list'
    const provider = buildLarkCliToolProvider(this.config)
    const missingScopes = requiredScopes.filter(scope => !this.config.scopes.includes(scope))
    const toolMissing = !provider?.tools.some(tool => tool.name === toolName)
    if (missingScopes.length || toolMissing) {
      const resolution = { kind: 'connect' as const, route: 'marketplace', label: '重新授权飞书' }
      return {
        ...result,
        status: 'needs_authorization' as const,
        credentialState: 'invalid' as const,
        errorCode: 'connector_scope_missing',
        requiredScopes,
        message: `飞书当前授权无法执行此任务。需要权限：${requiredScopes.join('、')}。请重新授权后再继续。`,
        action: resolution,
        resolution
      }
    }
    return { ...result, requiredScopes }
  }

  scope(externalTargets: readonly string[] = []) {
    const ready = this.config.enabled && this.config.authState === 'installed'
    return {
      networkAllowlist: ready
        ? [this.config.brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn']
        : [],
      connectorScopes: ready ? [...this.config.scopes] : [],
      externalTargets: [...externalTargets]
    }
  }

  async refresh() {
    if (!this.configPath) {
      throw Object.assign(new Error('Managed connector configuration is unavailable.'), {
        code: 'connector_configuration_unavailable'
      })
    }
    const next = readOptionalKunConfigFile(this.configPath)?.config.capabilities.lark ?? this.config
    const provider = buildLarkCliToolProvider(next)
    this.apply?.(provider)
    this.config = next
    return {
      provider: 'lark',
      status: provider ? 'available' : next.authState === 'not_installed' ? 'not_installed' : 'needs_authorization',
      authState: next.authState,
      scopes: [...next.scopes]
    }
  }
}
