import type { BrowserCapabilityConfig } from '../../kun/src/contracts/browser-skill'

export type ManagedBrowserSkillStatus = BrowserCapabilityConfig & { ownedDaemon?: boolean; skillInstalled?: boolean }
export type ManagedBrowserSkillResult = { ok: boolean; status: ManagedBrowserSkillStatus; message?: string }
export type BrowserSkillConfigureRequest = {
  enabled: boolean
  browserInstanceId?: string
  origins: string[]
  interaction: 'observe' | 'interact'
  expectedRevision: number
}
