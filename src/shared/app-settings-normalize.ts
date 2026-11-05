import {
  DEFAULT_GUI_UPDATE_CHANNEL,
  normalizeGuiUpdateChannel,
  type AppBehaviorConfigV1,
  type AppSettingsV1,
  type ClawSettingsPatchV1,
  type GuiUpdateConfigV1,
  type NotificationConfigV1,
  type NotificationConfigPatchV1,
  type ScheduleSettingsPatchV1,
  type TerminalNotificationKindV1,
  type WriteSettingsPatchV1
} from './app-settings-types'
import { normalizeKeyboardShortcuts, type KeyboardShortcutsConfigV1 } from './keyboard-shortcuts'
import {
  defaultManagedRuntimeSettings,
  getManagedRuntimeSettings,
  kunSettingsEnvelope,
  mergeManagedRuntimeSettings,
  migrateLegacyAppSettings
} from './app-settings-runtime'
import { normalizeModelProviderSettings } from './app-settings-provider'
import { normalizeDeepseekBaseUrl } from './app-settings-normalizers'
import { normalizeClawSettings } from './app-settings-claw'
import { normalizeScheduleSettings } from './app-settings-schedule'
import { normalizeWriteSettings } from './app-settings-write'

export function normalizeAppSettings(settings: AppSettingsV1): AppSettingsV1 {
  const migrated = shouldMigrateLegacySettings(settings)
    ? migrateLegacyAppSettings(settings as Parameters<typeof migrateLegacyAppSettings>[0])
    : settings
  const maybeSettings = migrated as AppSettingsV1 & {
    appBehavior?: Partial<AppBehaviorConfigV1>
    keyboardShortcuts?: Partial<KeyboardShortcutsConfigV1>
    notifications?: NotificationConfigPatchV1
    provider?: Parameters<typeof normalizeModelProviderSettings>[0]
    write?: WriteSettingsPatchV1
    claw?: ClawSettingsPatchV1
    schedule?: ScheduleSettingsPatchV1
    guiUpdate?: Partial<GuiUpdateConfigV1>
  }
  const runtime = getManagedRuntimeSettings(maybeSettings)
  const providerId = runtime.providerId || undefined
  return {
    ...migrated,
    schema: 'workwise.settings',
    version: 2,
    revision: Number.isSafeInteger(maybeSettings.revision) && (maybeSettings.revision ?? -1) >= 0
      ? maybeSettings.revision
      : 0,
    locale: maybeSettings.locale === 'zh' ? 'zh' : 'en',
    theme:
      maybeSettings.theme === 'light' || maybeSettings.theme === 'dark' || maybeSettings.theme === 'system'
        ? maybeSettings.theme
        : 'system',
    uiFontScale:
      maybeSettings.uiFontScale === 'small' ||
      maybeSettings.uiFontScale === 'medium' ||
      maybeSettings.uiFontScale === 'large'
        ? maybeSettings.uiFontScale
        : 'small',
    provider: normalizeModelProviderSettings(maybeSettings.provider),
    agents: kunSettingsEnvelope(mergeManagedRuntimeSettings(defaultManagedRuntimeSettings(), {
      ...runtime,
      baseUrl: runtime.baseUrl.trim() ? normalizeDeepseekBaseUrl(runtime.baseUrl) : ''
    })),
    workspaceRoot: typeof maybeSettings.workspaceRoot === 'string' ? maybeSettings.workspaceRoot : '',
    log: {
      enabled: maybeSettings.log?.enabled !== false,
      retentionDays: typeof maybeSettings.log?.retentionDays === 'number' ? maybeSettings.log.retentionDays : 2
    },
    notifications: normalizeNotificationSettings(maybeSettings.notifications),
    appBehavior: normalizeAppBehaviorSettings(maybeSettings.appBehavior),
    keyboardShortcuts: normalizeKeyboardShortcuts(maybeSettings.keyboardShortcuts),
    write: normalizeWriteSettings(maybeSettings.write),
    claw: normalizeClawSettings(maybeSettings.claw, providerId),
    schedule: normalizeScheduleSettings(maybeSettings.schedule, providerId),
    guiUpdate: {
      channel: normalizeGuiUpdateChannel(
        maybeSettings.guiUpdate?.channel ?? DEFAULT_GUI_UPDATE_CHANNEL
      )
    },
    conversation: {
      viewMode:
        maybeSettings.conversation?.viewMode === 'standard' ||
        maybeSettings.conversation?.viewMode === 'developer'
          ? maybeSettings.conversation.viewMode
          : 'concise'
    },
    documents: {
      parsingMode:
        maybeSettings.documents?.parsingMode === 'fast' ||
        maybeSettings.documents?.parsingMode === 'accurate'
          ? maybeSettings.documents.parsingMode
          : 'auto',
      unlimitedOcrServerUrl:
        typeof maybeSettings.documents?.unlimitedOcrServerUrl === 'string'
          ? maybeSettings.documents.unlimitedOcrServerUrl.trim()
          : '',
      privateMineruServerUrl:
        typeof maybeSettings.documents?.privateMineruServerUrl === 'string'
          ? maybeSettings.documents.privateMineruServerUrl.trim()
          : '',
      allowPrivateServerUploadByWorkspace:
        maybeSettings.documents?.allowPrivateServerUploadByWorkspace &&
        typeof maybeSettings.documents.allowPrivateServerUploadByWorkspace === 'object'
          ? Object.fromEntries(
              Object.entries(maybeSettings.documents.allowPrivateServerUploadByWorkspace)
                .filter(([root, allowed]) => root.trim().length > 0 && allowed === true)
            )
          : {}
    },
    codePromptPrefix: typeof maybeSettings.codePromptPrefix === 'string' ? maybeSettings.codePromptPrefix : ''
  }
}

export const TERMINAL_NOTIFICATION_KINDS: readonly TerminalNotificationKindV1[] = [
  'completed',
  'error',
  'aborted',
  'blocked',
  'max_tokens',
  'waiting_approval'
]

const TERMINAL_NOTIFICATION_KIND_SET = new Set<TerminalNotificationKindV1>(
  TERMINAL_NOTIFICATION_KINDS
)

function normalizeNotificationPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 100))]
}

export function normalizeNotificationSettings(
  settings?: NotificationConfigPatchV1 | NotificationConfigV1
): NotificationConfigV1 {
  const legacyEnabled = settings?.turnComplete !== false
  const terminal = settings?.turnTerminal
  const kinds: TerminalNotificationKindV1[] = Array.isArray(terminal?.kinds)
    ? [...new Set(terminal.kinds.filter(
        (kind): kind is TerminalNotificationKindV1 => TERMINAL_NOTIFICATION_KIND_SET.has(kind)
      ))]
    : ['completed']
  const enabled = terminal?.enabled ?? legacyEnabled
  return {
    turnComplete: enabled,
    turnTerminal: {
      enabled,
      kinds,
      suppressActiveThread: terminal?.suppressActiveThread === true,
      include: normalizeNotificationPatterns(terminal?.include),
      exclude: normalizeNotificationPatterns(terminal?.exclude)
    }
  }
}

export function mergeNotificationSettings(
  current: NotificationConfigV1,
  patch?: NotificationConfigPatchV1
): NotificationConfigV1 {
  if (!patch) return normalizeNotificationSettings(current)
  return normalizeNotificationSettings({
    ...current,
    ...patch,
    turnTerminal: {
      ...current.turnTerminal,
      ...patch.turnTerminal
    }
  })
}

function terminalNotificationPatternMatches(pattern: string, candidates: readonly string[]): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
  const matcher = new RegExp(`^${escaped}$`, 'i')
  return candidates.some((candidate) => matcher.test(candidate))
}

export function shouldShowTerminalNotification(
  settings: NotificationConfigV1,
  input: {
    reason?: TerminalNotificationKindV1
    threadId?: string
    title?: string
    activeThread?: boolean
  }
): boolean {
  const terminal = normalizeNotificationSettings(settings).turnTerminal!
  const reason = input.reason ?? 'completed'
  if (!terminal.enabled || !terminal.kinds.includes(reason)) return false
  if (terminal.suppressActiveThread && input.activeThread === true) return false
  const candidates = [input.threadId?.trim(), input.title?.trim()].filter(
    (value): value is string => Boolean(value)
  )
  if (terminal.exclude.some((pattern) => terminalNotificationPatternMatches(pattern, candidates))) {
    return false
  }
  return terminal.include.length === 0 || terminal.include.some(
    (pattern) => terminalNotificationPatternMatches(pattern, candidates)
  )
}

export function normalizeAppBehaviorSettings(
  settings?: Partial<AppBehaviorConfigV1>
): AppBehaviorConfigV1 {
  const openAtLogin = settings?.openAtLogin === true
  return {
    openAtLogin,
    startMinimized: openAtLogin && settings?.startMinimized === true,
    closeToTray: settings?.closeToTray === true
  }
}

function shouldMigrateLegacySettings(settings: AppSettingsV1): boolean {
  const raw = settings as AppSettingsV1 & {
    agentProvider?: unknown
    deepseek?: unknown
    agents?: {
      kun?: Partial<ReturnType<typeof defaultManagedRuntimeSettings>>
      codewhale?: unknown
      reasonix?: unknown
    }
  }
  if (!raw.agents?.kun) return true
  if ('agentProvider' in raw || 'deepseek' in raw) return true
  if (raw.agents.codewhale || raw.agents.reasonix) return true
  const dataDir = typeof raw.agents.kun.dataDir === 'string'
    ? raw.agents.kun.dataDir.replace(/\\/g, '/').toLowerCase()
    : ''
  return dataDir === '~/.deepseekgui/coreagent' || dataDir.endsWith('/.deepseekgui/coreagent')
}
