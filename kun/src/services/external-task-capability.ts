/**
 * Capability preflight for requests that target an external collaboration
 * provider. This runs before allocating a model Turn so the assistant cannot
 * invent a provider command (for example `dws`) and only discover the missing
 * connector after a shell call fails.
 */
export type ExternalTaskProvider = 'dingtalk' | 'lark'
export type ExternalTaskCapabilityStatus = 'unsupported' | 'needs_authorization' | 'available'

export type ExternalTaskCapability = {
  provider: ExternalTaskProvider
  status: ExternalTaskCapabilityStatus
  message: string
  action?: { kind: 'connect' | 'install'; route: string; label: string }
}

const DINGTALK_PATTERN = /钉钉|dingtalk/i
const LARK_PATTERN = /飞书|lark|feishu/i
const WORK_ITEM_PATTERN = /待办|审批|任务|工单|处理|approvals?|todo|task/i

/** Returns the provider only for an actual work-item request. */
export function detectExternalTaskProvider(text: string): ExternalTaskProvider | null {
  const value = text.trim()
  if (!WORK_ITEM_PATTERN.test(value)) return null
  if (DINGTALK_PATTERN.test(value)) return 'dingtalk'
  if (LARK_PATTERN.test(value)) return 'lark'
  return null
}

/**
 * The current runtime has a managed Lark CLI integration but no DingTalk
 * connector. Keep this default conservative. An authenticated Lark provider
 * can later be injected into TaskCoordinator and return `available`.
 */
export function defaultExternalTaskCapability(provider: ExternalTaskProvider): ExternalTaskCapability {
  if (provider === 'dingtalk') {
    return {
      provider,
      status: 'unsupported',
      message: '当前版本没有可执行的钉钉连接器，因此不能处理钉钉待办。请先安装并配置钉钉连接器。不会生成未经验证的 dws 命令。',
      action: { kind: 'install', route: 'settings/integrations/dingtalk', label: '配置钉钉连接器' }
    }
  }
  return {
    provider,
    status: 'needs_authorization',
    message: '检测到这是飞书待办任务，但飞书/Lark 尚未完成授权。请先连接飞书并完成授权，授权后可继续当前任务。',
    action: { kind: 'connect', route: 'settings/integrations/feishu', label: '连接飞书' }
  }
}

export function preflightExternalTask(text: string): ExternalTaskCapability | null {
  const provider = detectExternalTaskProvider(text)
  return provider ? defaultExternalTaskCapability(provider) : null
}
