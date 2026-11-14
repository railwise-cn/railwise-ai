import { z } from 'zod'

export const BrowserOrigin = z.string().refine(value => {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.origin === value
  } catch { return false }
}, 'Expected an exact HTTP(S) origin')

export const BrowserVerificationPolicy = z.enum(['strict', 'public_query_target'])
export type BrowserVerificationPolicy = z.infer<typeof BrowserVerificationPolicy>
/** Interpret historical grants without rewriting their persisted hashes. */
export function browserVerificationPolicy(value?: unknown): BrowserVerificationPolicy {
  return value === 'public_query_target' ? value : 'strict'
}

export const BrowserExecutionScope = z.object({
  browserInstanceId: z.string().min(1).max(512),
  origins: z.array(BrowserOrigin).max(64),
  interaction: z.enum(['observe', 'interact']),
  verificationPolicy: BrowserVerificationPolicy.optional(),
  revision: z.number().int().nonnegative()
}).strict()
export type BrowserExecutionScope = z.infer<typeof BrowserExecutionScope>

export const BrowserInstance = z.object({
  id: z.string().min(1).max(512),
  name: z.string().max(200),
  label: z.string().max(200),
  extensionVersion: z.string().max(64),
  protocolVersion: z.string().max(64),
  connected: z.boolean(),
  versionSkew: z.boolean()
}).strict()
export type BrowserInstance = z.infer<typeof BrowserInstance>

export const BrowserCapabilityConfig = z.object({
  enabled: z.boolean().default(false),
  state: z.enum(['not_installed', 'daemon_stopped', 'needs_extension', 'needs_browser_selection', 'ready', 'protocol_mismatch', 'unsupported', 'error']).default('not_installed'),
  executablePath: z.string().min(1).optional(),
  executableHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  version: z.string().max(64).optional(),
  homeDirectory: z.string().min(1).optional(),
  browserInstanceId: z.string().min(1).max(512).optional(),
  origins: z.array(BrowserOrigin).max(64).default([]),
  interaction: z.enum(['observe', 'interact']).default('observe'),
  revision: z.number().int().nonnegative().default(0),
  browsers: z.array(BrowserInstance).default([]),
  daemonProtocolVersion: z.string().max(64).optional(),
  checkedAt: z.string().optional(),
  code: z.string().max(100).optional(),
  message: z.string().max(1000).optional()
}).strict()
export type BrowserCapabilityConfig = z.infer<typeof BrowserCapabilityConfig>

export function isBrowserTask(text: string): boolean {
  if (/^(?:如何|怎么|怎样|什么是|介绍|解释|how\s+to\b|what\s+is\b)/i.test(text.trim())) return false
  return /(?:browser|broswer|browse)[-_ ]?skill|浏览器|网页.*(?:点击|填写|填表|操作|截图|提取|打开)|(?:点击|填写|填表|操作|截图|提取).*网页|\b(?:chrome|edge)\b/i.test(text)
}

export function browserTaskOrigins(text: string): string[] {
  const origins = new Set<string>()
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'）)，。]+/gi)) {
    try { const url = new URL(match[0]); if (!url.username && !url.password) origins.add(url.origin) } catch { /* A malformed URL is not a grant. */ }
  }
  return [...origins]
}

/** Recommend a mode from the user's request. Only a binding confirmation grants it. */
export function isPublicBrowserQuery(text: string): boolean {
  if (!isBrowserTask(text)) return false
  const request = text.replace(/(?:不需要|无需|不要|禁止|不必|不)(?:任何)?(?:登录|登陆|提交|发送|支付|购买|转账|审批|发布|删除|账号|账户|密码|验证码)/g, '')
  if (/登录|登陆|账号|账户|密码|验证码|网银|付款|支付|转账|购买|审批|转交|变更|修改|保存|上传|报名|网站授权|网页授权|发布|删除|投递|提交|发送|发邮件|个人资料|私有|内部业务|private\s+account|sign\s*in|log\s*in|purchase|payment|approve|delete|submit\s+form/i.test(request)) return false
  return /公开|检索|搜索|查询|采集|收集|获取.*信息|招标|采购公告|政采云|阳光采购|\b(?:public|search|collect|procurement)\b/i.test(request)
}

export const BrowserTaskBindingConfirmation = z.object({
  expectedTaskRevision: z.number().int().nonnegative(),
  expectedBrowserRevision: z.number().int().nonnegative(),
  browserInstanceId: z.string().min(1),
  origins: z.array(BrowserOrigin).min(1).max(64),
  interaction: z.enum(['observe', 'interact']).optional(),
  verificationPolicy: BrowserVerificationPolicy.optional(),
  confirmed: z.literal(true),
  idempotencyKey: z.string().min(1).max(200)
}).strict()
export type BrowserTaskBindingConfirmation = z.infer<typeof BrowserTaskBindingConfirmation>
export type BrowserTaskBindingSnapshot = {
  taskId: string; taskRevision: number; browserRevision: number; browserInstanceId: string;
  browserLabel: string; previousBrowserInstanceId?: string; origins: string[]; interaction: 'observe' | 'interact'; previousInteraction?: 'observe' | 'interact'
  purpose: string; verificationPolicy: BrowserVerificationPolicy; recommendedVerificationPolicy: BrowserVerificationPolicy;
  allowedVerificationPolicies: BrowserVerificationPolicy[]; policyChangeBlocked?: 'browser_unresolved_operation'
}

export const BrowserOperationConfirmation = z.object({
  expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().trim().min(1).max(256),
  // Keep the original Desktop request readable during migration.
  reviewId: z.string().min(1).max(200), decision: z.enum(['confirmed_complete', 'completed', 'not_completed'])
}).strict()
export type BrowserOperationConfirmation = z.infer<typeof BrowserOperationConfirmation>
export type BrowserOperationReview = { id: string; expiresAt: string; action: 'click' | 'fill'; pageUrl: string;
  observationText: string; targetLabel?: string; value?: string }
