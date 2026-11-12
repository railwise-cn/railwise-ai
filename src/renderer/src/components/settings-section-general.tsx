import type { ReactElement } from 'react'
import type {
  ApprovalPolicy,
  AppSettingsV1,
  ConversationViewMode,
  SandboxMode,
  TerminalNotificationKindV1
} from '@shared/app-settings'
import {
  DEFAULT_WRITE_INLINE_COMPLETION_BASE_URL,
  DEFAULT_WRITE_INLINE_COMPLETION_MAX_TOKENS,
  DEFAULT_WRITE_INLINE_COMPLETION_MODEL,
  DEFAULT_WRITE_INLINE_LONG_COMPLETION_MAX_TOKENS,
  DEFAULT_MANAGED_RUNTIME_DATA_DIR,
  WRITE_INLINE_COMPLETION_MODEL_IDS,
  isManagedRuntimeInsecure
} from '@shared/app-settings'
import type { GuiUpdateChannel } from '@shared/gui-update'
import type { SkillRootId } from '../lib/skill-root-preference'
import { FolderOpen, Loader2, PencilLine, RefreshCw, Settings } from 'lucide-react'
import { GuiUpdateControl } from './settings-gui-update'
import { DocumentEngineSettingsCard } from './document-engine-settings-card'
import { WorkspaceMigrationCard } from './workspace-migration-card'
import { WorkspaceTrustControl } from './workspace-trust-control'
import { DingTalkConnectorSettingsCard } from './dingtalk-connector-settings-card'
import {
  InlineNoticeView,
  SectionJumpButton,
  SettingsCard,
  SettingRow,
  Toggle
} from './settings-controls'

const TERMINAL_NOTIFICATION_OPTIONS: Array<{ value: TerminalNotificationKindV1; label: string }> = [
  { value: 'completed', label: 'turnTerminalKind_completed' },
  { value: 'error', label: 'turnTerminalKind_error' },
  { value: 'aborted', label: 'turnTerminalKind_aborted' },
  { value: 'blocked', label: 'turnTerminalKind_blocked' },
  { value: 'max_tokens', label: 'turnTerminalKind_max_tokens' },
  { value: 'waiting_approval', label: 'turnTerminalKind_waiting_approval' }
]

export function GeneralSettingsSection({ ctx }: { ctx: Record<string, any> }): ReactElement {
  const {
    t,
    tCommon,
    form,
    kun,
    update,
    updateKun,
    showRuntimeToken,
    setShowRuntimeToken,
    portError,
    selectControlClass,
    openOnboardingPreview,
    pickWorkspace,
    resetWorkspaceToDefault,
    workspacePickerError,
    guiUpdateInfo,
    checkingGuiUpdate,
    downloadingGuiUpdate,
    installingGuiUpdate,
    guiUpdateDownloaded,
    guiUpdateProgress,
    guiUpdateError,
    checkGuiUpdate,
    downloadGuiUpdate,
    installGuiUpdate,
    logPath,
    logDirOpenError,
    setLogDirOpenError,
    pickWriteWorkspace,
    resetWriteWorkspaceToDefault,
    writeWorkspacePickerError,
    writeInlineBaseUrlInherited,
    effectiveWriteInlineBaseUrl,
    writeInlineModelInherited,
    effectiveWriteInlineModel,
    setWriteDebugModalOpen,
    loadWriteDebugEntries,
    scrollToAgentSection,
    agentsSectionRef,
    skillSectionRef,
    mcpSectionRef,
    permissionsSectionRef,
    selectedSkillRoot,
    skillRootOptions,
    skillRootId,
    setSkillRootId,
    skillNotice,
    openSkillRoot,
    openPlugins,
    mcpConfigPath,
    mcpConfigExists,
    mcpConfigText,
    setMcpConfigText,
    mcpLoading,
    mcpBusy,
    mcpNotice,
    saveMcpConfig,
    loadMcpConfig,
    openMcpConfigDir,
    pickClawWorkspace,
    resetClawWorkspaceToDefault,
    clawWorkspacePickerError,
    splitSettingsList,
    listSettingsText
  } = ctx
  const platform = typeof window !== 'undefined' ? window.workwise?.platform ?? '' : ''
  const openAtLoginSupported = platform === 'win32' || platform === 'darwin'
  const startMinimizedSupported = platform === 'win32'
  const desktopBehavior = form.appBehavior
  const terminalNotifications = form.notifications.turnTerminal ?? {
    enabled: form.notifications.turnComplete,
    kinds: ['completed'] as TerminalNotificationKindV1[],
    suppressActiveThread: false,
    include: [],
    exclude: []
  }
  const updateTerminalNotifications = (patch: Partial<typeof terminalNotifications>): void => {
    update({ notifications: { turnTerminal: patch } })
  }

  return (
            <>
              <SettingsCard title={t('sectionGeneral')}>
                <SettingRow
                  title={t('language')}
                  description={t('languageDesc')}
                  control={
                    <select
                      className={selectControlClass}
                      value={form.locale}
                      onChange={(e) => update({ locale: e.target.value as 'en' | 'zh' })}
                    >
                      <option value="en">English</option>
                      <option value="zh">简体中文</option>
                    </select>
                  }
                />
                <SettingRow
                  title={t('theme')}
                  description={t('themeDesc')}
                  control={
                    <select
                      className={selectControlClass}
                      value={form.theme}
                      onChange={(e) => update({ theme: e.target.value as AppSettingsV1['theme'] })}
                    >
                      <option value="system">{t('themeSystem')}</option>
                      <option value="light">{t('themeLight')}</option>
                      <option value="dark">{t('themeDark')}</option>
                    </select>
                  }
                />
                <SettingRow
                  title={t('onboardingPreview')}
                  description={t('onboardingPreviewDesc')}
                  control={
                    <button
                      type="button"
                      onClick={openOnboardingPreview}
                      className="w-full rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                    >
                      {t('onboardingPreviewOpen')}
                    </button>
                  }
                />
                <SettingRow
                  title={t('fontScale')}
                  description={t('fontScaleDesc')}
                  control={
                    <select
                      className={selectControlClass}
                      value={form.uiFontScale}
                      onChange={(e) =>
                        update({
                          uiFontScale: e.target.value as AppSettingsV1['uiFontScale']
                        })
                      }
                    >
                      <option value="small">{t('fontScaleSmall')}</option>
                      <option value="medium">{t('fontScaleMedium')}</option>
                      <option value="large">{t('fontScaleLarge')}</option>
                    </select>
                  }
                />
                <SettingRow
                  title={t('conversationViewMode')}
                  description={t('conversationViewModeDesc')}
                  control={
                    <select
                      className={selectControlClass}
                      value={form.conversation.viewMode}
                      onChange={(e) =>
                        update({
                          conversation: {
                            viewMode: e.target.value as ConversationViewMode
                          }
                        })
                      }
                    >
                      <option value="concise">{t('conversationViewModeConcise')}</option>
                      <option value="standard">{t('conversationViewModeStandard')}</option>
                      <option value="developer">{t('conversationViewModeDeveloper')}</option>
                    </select>
                  }
                />
                <SettingRow
                  title={t('turnCompleteNotification')}
                  description={t('turnCompleteNotificationDesc')}
                  wideControl
                  control={
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[12px] text-ds-muted">{t('turnTerminalEnabled')}</span>
                        <Toggle checked={terminalNotifications.enabled} onChange={(enabled) => update({ notifications: { turnComplete: enabled, turnTerminal: { enabled } } })} />
                      </div>
                      <fieldset className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] text-ds-muted">
                        <legend className="mb-1 text-[12px] text-ds-muted">{t('turnTerminalKinds')}</legend>
                        {TERMINAL_NOTIFICATION_OPTIONS.map((option) => (
                          <label key={option.value} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={terminalNotifications.kinds.includes(option.value)}
                              onChange={(event) => updateTerminalNotifications({
                                kinds: event.target.checked
                                  ? [...new Set([...terminalNotifications.kinds, option.value])]
                                  : terminalNotifications.kinds.filter((kind: TerminalNotificationKindV1) => kind !== option.value)
                              })}
                            />
                            {t(option.label)}
                          </label>
                        ))}
                      </fieldset>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[12px] text-ds-muted">{t('turnTerminalSuppressActive')}</span>
                        <Toggle checked={terminalNotifications.suppressActiveThread} onChange={(suppressActiveThread) => updateTerminalNotifications({ suppressActiveThread })} />
                      </div>
                      <label className="block text-[12px] text-ds-muted">
                        <span className="mb-1 block">{t('turnTerminalInclude')}</span>
                        <input className="w-full rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-ink shadow-sm" value={terminalNotifications.include.join(', ')} onChange={(event) => updateTerminalNotifications({ include: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder={t('turnTerminalPatternPlaceholder')} />
                      </label>
                      <label className="block text-[12px] text-ds-muted">
                        <span className="mb-1 block">{t('turnTerminalExclude')}</span>
                        <input className="w-full rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-ink shadow-sm" value={terminalNotifications.exclude.join(', ')} onChange={(event) => updateTerminalNotifications({ exclude: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} placeholder={t('turnTerminalPatternPlaceholder')} />
                      </label>
                    </div>
                  }
                />
                <SettingRow
                  title={t('workspaceRoot')}
                  description={t('workspaceRootDesc')}
                  control={
                    <div className="w-full min-w-[200px] md:max-w-xl">
                      <div className="flex items-center gap-2">
                        <input
                          className="w-full rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                          value={form.workspaceRoot}
                          onChange={(e) => update({ workspaceRoot: e.target.value })}
                          placeholder={t('workspaceRootPlaceholder')}
                        />
                        <button
                          type="button"
                          onClick={resetWorkspaceToDefault}
                          className="shrink-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                        >
                          {t('restoreWorkspaceDefault')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void pickWorkspace()}
                          className="shrink-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                        >
                          {t('browse')}
                        </button>
                      </div>
                      {workspacePickerError ? (
                        <p className="mt-2 text-[13px] leading-5 text-amber-700 dark:text-amber-300">
                          {workspacePickerError}
                        </p>
                      ) : null}
                    </div>
                  }
                />
                <WorkspaceTrustControl workspaceRoot={form.workspaceRoot} t={t} />
              </SettingsCard>

              <WorkspaceMigrationCard t={t} />
              <DingTalkConnectorSettingsCard />

              <SettingsCard title={t('desktopBehavior')} className="mt-6">
                <SettingRow
                  title={t('desktopOpenAtLogin')}
                  description={
                    openAtLoginSupported
                      ? t('desktopOpenAtLoginDesc')
                      : t('desktopOpenAtLoginUnsupportedDesc')
                  }
                  control={
                    <Toggle
                      checked={desktopBehavior.openAtLogin}
                      disabled={!openAtLoginSupported}
                      onChange={(v) =>
                        update({
                          appBehavior: {
                            openAtLogin: v,
                            startMinimized: v ? desktopBehavior.startMinimized : false
                          }
                        })
                      }
                    />
                  }
                />
                <SettingRow
                  title={t('desktopStartMinimized')}
                  description={
                    desktopBehavior.openAtLogin && startMinimizedSupported
                      ? t('desktopStartMinimizedDesc')
                      : t('desktopStartMinimizedDisabledDesc')
                  }
                  control={
                    <Toggle
                      checked={desktopBehavior.startMinimized}
                      disabled={!desktopBehavior.openAtLogin || !startMinimizedSupported}
                      onChange={(v) => update({ appBehavior: { startMinimized: v } })}
                    />
                  }
                />
                <SettingRow
                  title={t('desktopCloseToTray')}
                  description={t('desktopCloseToTrayDesc')}
                  control={
                    <Toggle
                      checked={desktopBehavior.closeToTray}
                      onChange={(v) => update({ appBehavior: { closeToTray: v } })}
                    />
                  }
                />
              </SettingsCard>

              <DocumentEngineSettingsCard
                documents={form.documents}
                workspaceRoot={form.workspaceRoot}
                selectControlClass={selectControlClass}
                update={update}
                t={t}
              />

              <SettingsCard title={t('guiUpdate')} className="mt-6">
                <SettingRow
                  title={t('guiUpdateChannel')}
                  description={t('guiUpdateChannelDesc')}
                  control={
                    <select
                      className={selectControlClass}
                      value={form.guiUpdate.channel}
                      onChange={(e) =>
                        update({
                          guiUpdate: { channel: e.target.value as GuiUpdateChannel }
                        })
                      }
                    >
                      <option value="frontier">{t('guiUpdateChannelFrontier')}</option>
                      <option value="stable">{t('guiUpdateChannelStable')}</option>
                    </select>
                  }
                />
                <SettingRow
                  title={t('guiUpdate')}
                  description={t('guiUpdateDesc')}
                  control={
                    <GuiUpdateControl
                      info={guiUpdateInfo}
                      checking={checkingGuiUpdate}
                      downloading={downloadingGuiUpdate}
                      installing={installingGuiUpdate}
                      downloaded={guiUpdateDownloaded}
                      progress={guiUpdateProgress}
                      error={guiUpdateError}
                      onCheck={checkGuiUpdate}
                      onDownload={downloadGuiUpdate}
                      onInstall={installGuiUpdate}
                      t={t}
                    />
                  }
                />
              </SettingsCard>

              <SettingsCard title={t('logTitle')} className="mt-6">
                <SettingRow
                  title={t('logEnabled')}
                  description={t('logEnabledDesc')}
                  control={
                    <Toggle
                      checked={form.log.enabled}
                      onChange={(v) => update({ log: { enabled: v } })}
                    />
                  }
                />
                <SettingRow
                  title={t('logRetention')}
                  description={t('logRetentionDesc')}
                  control={
                    <select
                      className={selectControlClass}
                      value={form.log.retentionDays}
                      onChange={(e) =>
                        update({ log: { retentionDays: Number(e.target.value) } })
                      }
                    >
                      <option value={1}>{t('logRetentionOne')}</option>
                      <option value={2}>{t('logRetentionTwo')}</option>
                      <option value={3}>{t('logRetentionThree')}</option>
                      <option value={5}>{t('logRetentionFive')}</option>
                      <option value={7}>{t('logRetentionSeven')}</option>
                    </select>
                  }
                />
                <SettingRow
                  title={t('logDir')}
                  description={t('logDirDesc')}
                  wideControl
                  control={
                    <div className="flex w-full min-w-0 flex-col items-start gap-2">
                      {logPath ? (
                        <code className="block w-full max-w-full break-all rounded-xl bg-ds-main/70 px-3 py-2 font-mono text-[12px] text-ds-muted shadow-sm">
                          {logPath}
                        </code>
                      ) : (
                        <span className="text-[13px] text-ds-faint">…</span>
                      )}
                      <button
                        type="button"
                        className="inline-flex items-center gap-1.5 rounded-xl border border-ds-border bg-ds-card px-3 py-1.5 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:opacity-50"
                        disabled={typeof window.workwise?.openLogDir !== 'function'}
                        onClick={async () => {
                          if (typeof window.workwise?.openLogDir !== 'function') return
                          setLogDirOpenError(null)
                          try {
                            const result = await window.workwise.openLogDir()
                            if (!result.ok) setLogDirOpenError(result.message ?? 'Unknown error')
                          } catch (e) {
                            setLogDirOpenError(e instanceof Error ? e.message : String(e))
                          }
                        }}
                      >
                        <FolderOpen className="h-4 w-4" />
                        {t('logDirOpen')}
                      </button>
                      {logDirOpenError ? (
                        <p className="text-[12px] text-red-700 dark:text-red-300">
                          {logDirOpenError}
                        </p>
                      ) : null}
                    </div>
                  }
                />
              </SettingsCard>
            </>
  )
}
