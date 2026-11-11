import type { CapabilityPreflight, ExternalTaskProvider, TaskIntent } from '../contracts/harness.js'
import type { ThreadRecord } from '../contracts/threads.js'
export type { ExternalTaskProvider } from '../contracts/harness.js'
export type ExternalTaskCapability = CapabilityPreflight
/** The context comes from the persisted thread store, never a request's arbitrary Grant. */
export type ExternalTaskPreflight = (text: string, thread?: ThreadRecord) => ExternalTaskCapability | null | Promise<ExternalTaskCapability | null>

const KNOWLEDGE = /^(?:(?:请|帮我)\s*)?(?:如何|怎么|怎样|介绍|解释|什么是|对比|比较|how\s+(?:to|do|does)|what\s+is|explain|compare\b)/i
const WORK = /待办|审批|任务|工单|处理|办理|代办|办结|同意|批准|拒绝|驳回|完成|查询|列出|查看|详情|发送|消息|邮件|邮箱|上传|云盘|转交|转办|approvals?|todo|task|complete|approve|reject|send|upload|transfer|detail|list|show/i
const CONNECT = /连接|接入|授权|登录|配置|安装|connect|authorize|login|setup|install/i
// Query filters describe stored state. Keep independent imperative clauses so
// “list unfinished tasks, then complete one” still requires write authority.
const QUERY_STATE = /(?:需要|需)(?:完成|审批|处理|办理)(?=的)|(?:尚未|已经|已被|曾被|未|待|已|被)(?:完成|审批|同意|批准|拒绝|驳回|发送|上传|转交|转办|处理|办理|办结)|(?:完成|审批|同意|批准|拒绝|驳回|发送|上传|转交|转办|处理|办理)(?:状态|情况|结果|记录|历史|进度|时间)|\b(?:incomplete|uncompleted|completed|unapproved|approved|rejected|sent|uploaded|transferred|not(?:\s+yet)?\s+completed?)\b/gi
const NEGATED_QUERY_ACTION = /(?:不要|请勿|禁止|不必|勿)(?:自动|批量)?(?:完成|审批|同意|批准|拒绝|驳回|发送|上传|转交|转办|处理|办理)(?:(?:或|和|及|、)(?:完成|审批|同意|批准|拒绝|驳回|发送|上传|转交|转办|处理|办理))*|\b(?:do\s+not|don't|never)\s+(?:complete|approve|reject|send|upload|transfer)\b/gi

/** Remove permission narration from approval candidates while retaining each requested action. */
function approvalActionText(text: string): string {
  return text.replace(/同意|批准|\bapprove\b/gi, (verb: string, offset: number) => {
    const before = text.slice(0, offset)
    const after = text.slice(offset + verb.length).split(/[，,。.;；!！?？\n]/, 1)[0]!
    const describesPastApproval = /(?:已经|已)(?:明确|事先|正式|书面|再次)*$/.test(before)
    const delivery = after.match(/^(.*?)(?:上传|发送|发(?:一封)?邮件|发(?:一条)?消息|\b(?:upload|send)(?:ing)?\b)/i)
    // Approval targets and subsequent actions keep their own approval verb,
    // e.g. “批准报销申请后上传” or “同意那一个并发送通知”.
    const deliveryRequest = /(?:上传|发送|\b(?:upload|send)(?:ing)?\b).{0,12}(?:申请|\brequest\b)/i.test(after)
    const permitsDelivery = delivery !== null && !deliveryRequest && !/审批|申请|报销|流程|然后|随后|再|并|后|\b(?:approval|request|then|and)\b/i.test(delivery[1]!)
    return describesPastApproval || permitsDelivery ? ' ' : verb
  })
}


/** Multiple providers require a durable, explicit choice; never fall back to unrestricted chat. */
export function externalProviderAmbiguity(text: string): boolean {
  const value = text.trim()
  return !KNOWLEDGE.test(value) && (WORK.test(value) || CONNECT.test(value)) && /钉钉|dingtalk/i.test(value) && /飞书|lark|feishu/i.test(value)
}

function writeOperation(text: string): NonNullable<TaskIntent['operations']>[number] | undefined {
  return /拒绝|驳回|\breject\b/i.test(text) ? 'reject' : /转交|转办|\btransfer\b/i.test(text) ? 'transfer'
    : /同意|批准|自动审批|\bapprove\b/i.test(approvalActionText(text)) ? 'approve'
    : /上传|\bupload(?:ing)?\b/i.test(text) ? 'upload'
    : /发送|发(?:一封)?邮件|发(?:一条)?消息|\bsend(?:ing)?\b/i.test(text) ? 'send'
    : /完成|\bcomplete\b/i.test(text) ? 'complete' : undefined
}

/** Preserve explicit sequential/conjoined platform actions without counting a report's completion as a todo write. */
function combinedOperations(text: string, primary: ReturnType<typeof writeOperation>) {
  const clauses = text.split(/[，,。；;\n]|并且?|然后|随后|接着|再(?!次)|后|\b(?:and|then)\b/i)
  const operations = clauses.flatMap(clause => {
    const operation = writeOperation(clause)
    if (!operation || (operation === 'complete' && primary !== 'complete' && !/待办|\b(?:todo|task)\b|任务\s*[A-Za-z0-9“「]/i.test(clause))) return []
    return [operation]
  })
  return [...new Set(primary ? [primary, ...operations] : operations)]
}

/** Deterministic classification before any model/tool execution. */
export function externalTaskIntent(text: string): TaskIntent | null {
  const value = text.trim()
  if (KNOWLEDGE.test(value) || (!WORK.test(value) && !CONNECT.test(value))) return null
  const ding = /钉钉|dingtalk/i.test(value), lark = /飞书|lark|feishu/i.test(value)
  if (ding === lark) return null
  const hasWorkIntent = WORK.test(value)
  const provider = ding ? 'dingtalk' : 'lark'
  const readOperation = /详情|\bdetail/i.test(value) ? 'detail'
    : /查询|列出|查看|读取|列表|有哪些|\b(?:list|show|read)\b/i.test(value) ? 'list' : undefined
  const actionText = readOperation ? value.replace(QUERY_STATE, ' ').replace(NEGATED_QUERY_ACTION, ' ') : value
  const primaryWrite = writeOperation(actionText)
  const operations = combinedOperations(actionText, primaryWrite)
  const genericMutation = /处理|办理|代办|办结/.test(actionText)
  const operation = primaryWrite ?? (genericMutation ? undefined : readOperation)
  return { kind: CONNECT.test(value) && !hasWorkIntent ? 'connect_provider' : 'external_task', provider, operation,
    ...(operations.length > 1 ? { operations } : {}), mutation: Boolean(primaryWrite || genericMutation), confidence: 'rule' }

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
