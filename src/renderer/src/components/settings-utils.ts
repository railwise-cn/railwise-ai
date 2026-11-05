import {
  DEFAULT_GUI_UPDATE_CHANNEL,
  defaultManagedRuntimeSettings,
  applyManagedRuntimePatch,
  getManagedRuntimeSettings,
  kunSettingsEnvelope,
  mergeManagedRuntimeSettings,
  mergeClawSettings,
  mergeModelProviderSettings,
  mergeScheduleSettings,
  mergeWriteSettings,
  mergeNotificationSettings,
  normalizeAppBehaviorSettings,
  normalizeClawSettings,
  normalizeGuiUpdateChannel,
  normalizeKeyboardShortcuts,
  normalizeModelProviderSettings,
  normalizeScheduleSettings,
  normalizeWriteSettings,
  type AppSettingsPatch,
  type AppSettingsV1,
  type WorkWiseSettingsV2
} from '@shared/app-settings'
import type { GuiUpdateInfo } from '@shared/gui-update'

type RendererSettingsShape = Partial<AppSettingsV1>
type SettingsPatch = AppSettingsPatch

export const DEFAULT_WORKSPACE_ROOT = '~/.workwise/default_workspace'

export function splitSettingsList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function listSettingsText(values: string[]): string {
  return values.join('\n')
}

export function hasValidPort(settings: AppSettingsV1): boolean {
  const port = getManagedRuntimeSettings(settings).port
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export function canPersistSettingsWithPort(settings: AppSettingsV1, patch: SettingsPatch): boolean {
  const port = getManagedRuntimeSettings(settings).port
  return hasValidPort(settings) || (
    port === 0 && patch.agents?.kun?.port === undefined
  )
}

export function mergeSettings(current: AppSettingsV1, patch: SettingsPatch): WorkWiseSettingsV2 {
  const safeCurrent = coerceRendererSettings(current)
  const { agents: agentsPatch, provider: providerPatch, ...restPatch } = patch
  const runtime = applyManagedRuntimePatch(safeCurrent, agentsPatch?.kun)
  const providerId = getManagedRuntimeSettings(runtime).providerId || undefined
  return {
    ...runtime,
    ...restPatch,
    schema: 'workwise.settings',
    version: 2,
    revision: safeCurrent.revision,
    provider: mergeModelProviderSettings(safeCurrent.provider, providerPatch),
    log: {
      ...safeCurrent.log,
      ...(patch.log ?? {})
    },
    notifications: mergeNotificationSettings(safeCurrent.notifications, patch.notifications),
    appBehavior: normalizeAppBehaviorSettings({
      ...safeCurrent.appBehavior,
      ...(patch.appBehavior ?? {})
    }),
    keyboardShortcuts: normalizeKeyboardShortcuts({
      bindings: {
        ...safeCurrent.keyboardShortcuts.bindings,
        ...(patch.keyboardShortcuts?.bindings ?? {})
      }
    }),
    write: mergeWriteSettings(safeCurrent.write, patch.write),
    claw: mergeClawSettings(safeCurrent.claw, patch.claw, providerId),
    schedule: mergeScheduleSettings(safeCurrent.schedule, patch.schedule, providerId),
    guiUpdate: {
      ...safeCurrent.guiUpdate,
      ...(patch.guiUpdate ?? {})
    },
    conversation: {
      ...safeCurrent.conversation,
      ...(patch.conversation ?? {})
    },
    documents: {
      ...safeCurrent.documents,
      ...(patch.documents ?? {}),
      allowPrivateServerUploadByWorkspace: {
        ...safeCurrent.documents.allowPrivateServerUploadByWorkspace,
        ...(patch.documents?.allowPrivateServerUploadByWorkspace ?? {})
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergePatchValues(current: unknown, next: unknown): unknown {
  if (!isPlainObject(current) || !isPlainObject(next)) return next
  const merged: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue
    merged[key] = mergePatchValues(merged[key], value)
  }
  return merged
}

/**
 * Combines debounced settings edits using the same semantics as the settings
 * store: nested objects merge, while arrays and scalar values replace.
 */
export function mergeSettingsPatches(
  current: AppSettingsPatch,
  next: AppSettingsPatch
): AppSettingsPatch {
  return mergePatchValues(current, next) as AppSettingsPatch
}

export function hasSettingsPatch(patch: AppSettingsPatch): boolean {
  return Object.keys(patch).length > 0
}

export function coerceRendererSettings(settings: AppSettingsV1): WorkWiseSettingsV2 {
  const raw = settings as RendererSettingsShape
  const runtime = getManagedRuntimeSettings(settings)
  const providerId = runtime.providerId || undefined
  const theme =
    raw.theme === 'system' || raw.theme === 'light' || raw.theme === 'dark'
      ? raw.theme
      : 'system'
  const uiFontScale =
    raw.uiFontScale === 'small' || raw.uiFontScale === 'medium' || raw.uiFontScale === 'large'
      ? raw.uiFontScale
      : 'medium'
  return {
    schema: 'workwise.settings',
    version: 2,
    revision:
      Number.isSafeInteger(raw.revision) && (raw.revision ?? -1) >= 0
        ? raw.revision as number
        : 0,
    locale: raw.locale === 'zh' ? 'zh' : 'en',
    theme,
    uiFontScale,
    provider: normalizeModelProviderSettings(raw.provider),
    agents: kunSettingsEnvelope(mergeManagedRuntimeSettings(defaultManagedRuntimeSettings(), runtime)),
    workspaceRoot: typeof raw.workspaceRoot === 'string' ? raw.workspaceRoot : DEFAULT_WORKSPACE_ROOT,
    log: {
      enabled: raw.log?.enabled !== false,
      retentionDays: typeof raw.log?.retentionDays === 'number' ? raw.log.retentionDays : 2
    },
    notifications: mergeNotificationSettings(
      { turnComplete: raw.notifications?.turnComplete !== false },
      raw.notifications
    ),
    appBehavior: normalizeAppBehaviorSettings(raw.appBehavior),
    keyboardShortcuts: normalizeKeyboardShortcuts(raw.keyboardShortcuts),
    write: normalizeWriteSettings(raw.write),
    claw: normalizeClawSettings(raw.claw, providerId),
    schedule: normalizeScheduleSettings(raw.schedule, providerId),
    guiUpdate: {
      channel: normalizeGuiUpdateChannel(raw.guiUpdate?.channel ?? DEFAULT_GUI_UPDATE_CHANNEL)
    },
    conversation: {
      viewMode:
        raw.conversation?.viewMode === 'standard' || raw.conversation?.viewMode === 'developer'
          ? raw.conversation.viewMode
          : 'concise'
    },
    documents: {
      parsingMode:
        raw.documents?.parsingMode === 'fast' || raw.documents?.parsingMode === 'accurate'
          ? raw.documents.parsingMode
          : 'auto',
      unlimitedOcrServerUrl:
        typeof raw.documents?.unlimitedOcrServerUrl === 'string'
          ? raw.documents.unlimitedOcrServerUrl.trim()
          : '',
      privateMineruServerUrl:
        typeof raw.documents?.privateMineruServerUrl === 'string'
          ? raw.documents.privateMineruServerUrl.trim()
          : '',
      allowPrivateServerUploadByWorkspace:
        raw.documents?.allowPrivateServerUploadByWorkspace ?? {}
    },
    codePromptPrefix: typeof raw.codePromptPrefix === 'string' ? raw.codePromptPrefix : ''
  }
}

export function guiUpdateFailureMessage(
  info: Extract<GuiUpdateInfo, { ok: false }>,
  t: (key: string, values?: Record<string, unknown>) => string
): string {
  switch (info.code) {
    case 'not_configured':
      return t('guiUpdateErrNotConfigured')
    case 'unsupported':
      return t('guiUpdateErrUnsupported')
    case 'unsigned_build':
      return t('guiUpdateErrUnsignedBuild')
    case 'manifest_unavailable':
      return t('guiUpdateErrManifestUnavailable')
    case 'network':
      return t('guiUpdateErrNetwork')
    case 'signature_invalid':
      return t('guiUpdateErrSignatureInvalid')
    case 'withdrawn':
      return t('guiUpdateErrWithdrawn')
    case 'download_failed':
      return t('guiUpdateErrDownloadFailed', { message: info.message.trim() })
    case 'install_failed':
      return t('guiUpdateErrInstallFailed', { message: info.message.trim() })
    case 'github_repo_not_found':
      return t('guiUpdateErrRepoNotFound', { repo: info.repo?.trim() || 'owner/repo' })
    case 'github_forbidden':
      return t('guiUpdateErrForbidden')
    case 'github_rate_limited':
      return t('guiUpdateErrRateLimit')
    case 'no_stable_version':
      return t('guiUpdateErrNoStableVersion', { repo: info.repo?.trim() || '—' })
    default:
      return info.message.trim() || t('guiUpdateCheckFailed')
  }
}
