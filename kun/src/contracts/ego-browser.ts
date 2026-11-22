import { z } from 'zod'

/** Optional external connector. Absence preserves every legacy capability byte. */
export const EgoBrowserCapabilityConfig = z.object({
  state: z.enum(['not_installed', 'installed', 'unsupported', 'error']),
  executablePath: z.string().min(1).optional(), executableHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  version: z.string().max(64).optional(), revision: z.number().int().nonnegative()
}).strict()
export type EgoBrowserCapabilityConfig = z.infer<typeof EgoBrowserCapabilityConfig>
export const EGO_READ_TOOLS = ['ego_browser_open', 'ego_browser_observe', 'ego_browser_read', 'ego_browser_next_page'] as const
export const EGO_TOOLS = [...EGO_READ_TOOLS, 'ego_browser_finish'] as const
export const EGO_SITE_SIGN_IN_REQUIRED = 'ego_browser_site_sign_in_required'
export function isEgoBrowserTask(text: string): boolean { return /\bego(?:[- ]browser|\s+lite)?\b|Ego浏览器/i.test(text) }
