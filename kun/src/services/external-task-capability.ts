import type { CapabilityPreflight, ExternalTaskProvider, TaskIntent } from '../contracts/harness.js'
import type { ThreadRecord } from '../contracts/threads.js'
export type { ExternalTaskProvider } from '../contracts/harness.js'
export type ExternalTaskCapability = CapabilityPreflight
/** The context comes from the persisted thread store, never a request's arbitrary Grant. */
export type ExternalTaskPreflight = (text: string, thread?: ThreadRecord) => ExternalTaskCapability | null | Promise<ExternalTaskCapability | null>

const KNOWLEDGE = /^(?:(?:请|帮我)\s*)?(?:如何|怎么|怎样|介绍|解释|什么是|对比|比较|how\s+(?:to|do|does)|what\s+is|explain|compare\b)/i
const WORK = /待办|审批|任务|工单|处理|办理|代办|办结|同意|批准|拒绝|驳回|完成|查询|列出|查看|详情|发送|消息|转交|转办|approvals?|todo|task|complete|approve|reject|send|transfer|detail|list|show/i
const CONNECT = /连接|接入|授权|登录|配置|安装|connect|authorize|login|setup|install/i

/** Multiple providers require a durable, explicit choice; never fall back to unrestricted chat. */
export function externalProviderAmbiguity(text: string): boolean {
  const value = text.trim()
  return !KNOWLEDGE.test(value) && (WORK.test(value) || CONNECT.test(value)) && /钉钉|dingtalk/i.test(value) && /飞书|lark|feishu/i.test(value)
}

/** Deterministic classification before any model/tool execution. */
export function externalTaskIntent(text: string): TaskIntent | null {
  const value = text.trim()
  if (KNOWLEDGE.test(value) || (!WORK.test(value) && !CONNECT.test(value))) return null
  const ding = /钉钉|dingtalk/i.test(value), lark = /飞书|lark|feishu/i.test(value)
  if (ding === lark) return null
  const hasWorkIntent = WORK.test(value)
  const provider = ding ? 'dingtalk' : 'lark'
  const operation = /拒绝|驳回|reject/i.test(value) ? 'reject' : /转交|转办|transfer/i.test(value) ? 'transfer'
    : /同意|批准|自动审批|approve\b/i.test(value) ? 'approve' : /完成|complete\b/i.test(value) ? 'complete'
    : /发送|send\b/i.test(value) ? 'send' : /详情|detail/i.test(value) ? 'detail' : /查询|列出|查看|列表|list\b|show\b/i.test(value) ? 'list' : undefined
  return { kind: CONNECT.test(value) && !hasWorkIntent ? 'connect_provider' : 'external_task', provider, operation,
    mutation: operation ? ['approve', 'reject', 'complete', 'send', 'transfer'].includes(operation) : /处理|办理|代办|办结/.test(value), confidence: 'rule' }
}
export function detectExternalTaskProvider(text: string): ExternalTaskProvider | null {
  return externalTaskIntent(text)?.provider ?? null
}
type ProviderState = { enabled?: boolean; executablePath?: string; authState?: string; scopes?: string[] }
export type ExternalCapabilityState = { lark?: ProviderState; dingtalk?: ProviderState }

export function defaultExternalTaskCapability(provider: ExternalTaskProvider, state: ExternalCapabilityState = {}, intent?: TaskIntent): CapabilityPreflight {
  const base = { provider, credentialState: 'unknown' as const, networkState: 'unknown' as const,
    workspaceState: 'unknown' as const, sandboxState: 'allowed' as const,
    approvalState: intent?.mutation ? 'required' as const : 'not_required' as const, checkedAt: new Date().toISOString() }
  if (provider === 'dingtalk') {
    const resolution = { kind: 'connect' as const, route: 'marketplace', label: '连接钉钉' }
    return { ...base, status: 'unsupported', credentialState: 'missing', errorCode: 'connector_unavailable',
      message: '钉钉连接器尚未完成配置。请通过官方连接器安装和扫码登录后继续原任务；系统不会通过未经验证的 Shell 命令代理平台操作。', action: resolution, resolution }
  }
  const config = state.lark
  const resolution = { kind: 'connect' as const, route: 'marketplace', label: '连接飞书' }
  if (!config) return { ...base, status: 'needs_authorization', credentialState: 'missing', errorCode: 'connector_authorization_required',
    message: '飞书/Lark 尚未完成授权。请先连接飞书，授权后可继续原任务。', action: resolution, resolution }
  if (config.enabled === false) return { ...base, status: 'blocked', errorCode: 'connector_disabled',
    message: '飞书连接器已关闭，请先在工具设置中启用。', action: resolution, resolution }
  if (config.authState === 'not_installed' || !config.executablePath) {
    const install = { kind: 'install' as const, route: 'marketplace', label: '安装 Lark CLI' }
    return { ...base, status: 'not_installed', credentialState: 'missing', errorCode: 'connector_not_installed',
      message: '尚未安装 Lark CLI。安装并登录后可以继续原任务。', action: install, resolution: install }
  }
  if (config.authState !== 'installed') return { ...base, status: 'needs_authorization', credentialState: config.authState === 'error' ? 'invalid' : 'missing',
    errorCode: 'connector_authorization_required', message: 'Lark CLI 尚未登录或凭据无效，请完成登录后继续原任务。', action: resolution, resolution }
  return { ...base, status: 'available', credentialState: 'valid', toolId: 'lark-cli', executablePath: config.executablePath,
    message: '飞书连接器已登录；工具执行时将再次核验权限和目标。' }
}
export function preflightExternalTask(text: string, state: ExternalCapabilityState = {}): CapabilityPreflight | null {
  const intent = externalTaskIntent(text)
  return intent?.provider ? defaultExternalTaskCapability(intent.provider, state, intent) : null
}
