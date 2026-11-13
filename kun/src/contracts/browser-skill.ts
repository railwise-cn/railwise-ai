import { z } from 'zod'

export const BrowserOrigin = z.string().refine(value => {
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && url.origin === value
  } catch { return false }
}, 'Expected an exact HTTP(S) origin')

export const BrowserExecutionScope = z.object({
  browserInstanceId: z.string().min(1).max(512),
  origins: z.array(BrowserOrigin).max(64),
  interaction: z.enum(['observe', 'interact']),
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

export const BrowserTaskBindingConfirmation = z.object({
  expectedTaskRevision: z.number().int().nonnegative(),
  expectedBrowserRevision: z.number().int().nonnegative(),
  browserInstanceId: z.string().min(1),
  origins: z.array(BrowserOrigin).min(1).max(64),
  interaction: z.enum(['observe', 'interact']).optional(),
  confirmed: z.literal(true),
  idempotencyKey: z.string().min(1).max(200)
}).strict()
export type BrowserTaskBindingConfirmation = z.infer<typeof BrowserTaskBindingConfirmation>
export type BrowserTaskBindingSnapshot = {
  taskId: string; taskRevision: number; browserRevision: number; browserInstanceId: string;
  browserLabel: string; previousBrowserInstanceId?: string; origins: string[]; interaction: 'observe' | 'interact'; previousInteraction?: 'observe' | 'interact'
}
