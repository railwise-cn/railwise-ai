import { useEffect, useState, type ReactElement } from 'react'
import {
  DEFAULT_WRITE_INLINE_COMPLETION_MAX_TOKENS,
  DEFAULT_WRITE_INLINE_COMPLETION_MODEL,
  DEFAULT_WRITE_INLINE_LONG_COMPLETION_MAX_TOKENS,
  DEFAULT_MODEL_PROVIDER_ID,
  WRITE_INLINE_COMPLETION_MODEL_IDS,
  defaultModelProviderSettings,
  resolveWriteInlineCompletionProviderId
} from '@shared/app-settings'
import type { WriteKnowledgeBaseStatus } from '@shared/workwise-api'
import { ExternalLink, PencilLine, RefreshCw } from 'lucide-react'
import {
  SettingsCard,
  SettingRow,
  Toggle
} from './settings-controls'

export function WriteSettingsSection({ ctx }: { ctx: Record<string, any> }): ReactElement {
  const {
    t,
    form,
    provider,
    update,
    selectControlClass,
    pickWriteWorkspace,
    resetWriteWorkspaceToDefault,
    writeWorkspacePickerError,
    writeInlineModelInherited,
    effectiveWriteInlineModel,
    setWriteDebugModalOpen,
    loadWriteDebugEntries
  } = ctx
  const providerSettings = provider ?? defaultModelProviderSettings()
  const effectiveWriteProviderId = resolveWriteInlineCompletionProviderId(form)
  const effectiveWriteProvider =
    providerSettings.providers.find((item: { id: string }) => item.id === effectiveWriteProviderId) ??
    providerSettings.providers.find((item: { id: string }) => item.id === DEFAULT_MODEL_PROVIDER_ID) ??
    providerSettings.providers[0]
  const writeInlineProviderInherited = form.write.inlineCompletion.inheritProvider !== false
  const writeInlineProviderModels = effectiveWriteProvider?.models ?? []
  const [knowledgeStatus, setKnowledgeStatus] = useState<WriteKnowledgeBaseStatus | null>(null)
  const [knowledgeRefreshing, setKnowledgeRefreshing] = useState(false)

  useEffect(() => {
    if (typeof window.workwise?.getWriteKnowledgeBaseStatus !== 'function') return
    void window.workwise.getWriteKnowledgeBaseStatus().then(setKnowledgeStatus).catch(() => undefined)
  }, [form.write.knowledgeBase.enabled])

  const refreshKnowledgeBase = async (): Promise<void> => {
    if (typeof window.workwise?.refreshWriteKnowledgeBase !== 'function') return
    setKnowledgeRefreshing(true)
    try {
      setKnowledgeStatus(await window.workwise.refreshWriteKnowledgeBase())
    } finally {
      setKnowledgeRefreshing(false)
    }
  }

  return (
            <>
              <SettingsCard title={t('sectionWrite')}>
                <SettingRow
                  title={t('writeWorkspaceRoot')}
                  description={t('writeWorkspaceRootDesc')}
                  control={
                    <div className="w-full min-w-[200px] md:max-w-xl">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <input
                          className="w-full rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                          value={form.write.defaultWorkspaceRoot}
                          onChange={(e) =>
                            update({
                              write: {
                                defaultWorkspaceRoot: e.target.value,
                                activeWorkspaceRoot: e.target.value,
                                workspaces: [e.target.value, ...form.write.workspaces]
                              }
                            })
                          }
                          placeholder={t('writeWorkspaceRootPlaceholder')}
                        />
                        <button
                          type="button"
                          onClick={resetWriteWorkspaceToDefault}
                          className="shrink-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                        >
                          {t('restoreWorkspaceDefault')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void pickWriteWorkspace()}
                          className="shrink-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                        >
                          {t('browse')}
                        </button>
                      </div>
                      {writeWorkspacePickerError ? (
                        <p className="mt-2 text-[13px] leading-5 text-amber-700 dark:text-amber-300">
                          {writeWorkspacePickerError}
                        </p>
                      ) : null}
                    </div>
                  }
                />
                <SettingRow
                  title={t('writeInlineCompletionProvider')}
                  description={t('writeInlineCompletionProviderDesc')}
                  control={
                    <div className="w-full min-w-0 md:max-w-md">
                      <select
                        className={selectControlClass}
                        value={writeInlineProviderInherited ? '' : form.write.inlineCompletion.providerId}
                        onChange={(e) => {
                          const providerId = e.target.value
                          update({
                            write: {
                              inlineCompletion: {
                                inheritProvider: !providerId,
                                providerId
                              }
                            }
                          })
                        }}
                      >
                        <option value="">
                          {t('writeInlineCompletionProviderInherit', {
                            value: effectiveWriteProvider?.name ?? t('modelProviderDefault')
                          })}
                        </option>
                        {providerSettings.providers.map((item: { id: string; name: string }) => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </select>
                      <p className="mt-2 text-[12px] text-ds-muted">
                        {writeInlineProviderInherited
                          ? t('writeInlineCompletionProviderInherited', {
                            value: effectiveWriteProvider?.name ?? effectiveWriteProviderId
                          })
                          : t('writeInlineCompletionProviderOverride', {
                            value: effectiveWriteProvider?.name ?? effectiveWriteProviderId
                          })}
                      </p>
                    </div>
                  }
                />
              </SettingsCard>

              <SettingsCard title={t('writeKnowledgeBaseTitle')} className="mt-5">
                <SettingRow
                  title={t('writeKnowledgeBaseEnabled')}
                  description={t('writeKnowledgeBaseEnabledDesc')}
                  control={
                    <Toggle
                      checked={form.write.knowledgeBase.enabled}
                      onChange={(enabled) => update({ write: { knowledgeBase: { enabled } } })}
                    />
                  }
                />
                <SettingRow
                  title={t('writeKnowledgeBaseMode')}
                  description={t('writeKnowledgeBaseModeDesc')}
                  control={
                    <span className="rounded-lg bg-emerald-500/10 px-3 py-1.5 text-[12px] font-semibold text-emerald-700 dark:text-emerald-300">
                      {t('writeKnowledgeBaseHybrid')}
                    </span>
                  }
                />
                <SettingRow
                  title={t('writeKnowledgeBaseSource')}
                  description={t('writeKnowledgeBaseSourceDesc')}
                  control={
                    <div className="flex flex-col items-end gap-2">
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => void refreshKnowledgeBase()}
                          disabled={knowledgeRefreshing || !form.write.knowledgeBase.enabled}
                          className="inline-flex items-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <RefreshCw className={`h-4 w-4 ${knowledgeRefreshing ? 'animate-spin' : ''}`} strokeWidth={1.75} />
                          {t('writeKnowledgeBaseRefresh')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void window.workwise.openExternal(form.write.knowledgeBase.publicBaseUrl)}
                          className="inline-flex items-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                        >
                          <ExternalLink className="h-4 w-4" strokeWidth={1.75} />
                          kb.railwise.cn
                        </button>
                      </div>
                      <span className="text-right text-[12px] text-ds-muted">
                        {knowledgeStatus
                          ? t(`writeKnowledgeBaseStatus_${knowledgeStatus.state}`, {
                              time: knowledgeStatus.lastUpdated
                                ? new Date(knowledgeStatus.lastUpdated).toLocaleString()
                                : t('writeKnowledgeBaseNever')
                            })
                          : t('writeKnowledgeBaseChecking')}
                      </span>
                    </div>
                  }
                />
                <div className="px-3 py-3 text-[12.5px] leading-5 text-ds-muted">
                  {t('writeKnowledgeBasePrivacy')}
                </div>
              </SettingsCard>

              <SettingsCard title={t('writeInlineCompletion')} className="mt-5">
                <SettingRow
                  title={t('writeInlineCompletionEnabled')}
                  description={t('writeInlineCompletionEnabledDesc')}
                  control={
                    <Toggle
                      checked={form.write.inlineCompletion.enabled}
                      onChange={(enabled) => update({ write: { inlineCompletion: { enabled } } })}
                    />
                  }
                />
                <SettingRow
                  title={t('writeInlineCompletionRetrieval')}
                  description={t('writeInlineCompletionRetrievalDesc')}
                  control={
                    <Toggle
                      checked={form.write.inlineCompletion.retrievalEnabled}
                      onChange={(retrievalEnabled) => update({ write: { inlineCompletion: { retrievalEnabled } } })}
                    />
                  }
                />
                <SettingRow
                  title={t('writeInlineCompletionModel')}
                  description={t('writeInlineCompletionModelDesc')}
                  control={
                    <div className="w-full min-w-0 md:max-w-md">
                      <input
                        list="write-inline-completion-model-options"
                        className="w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                        value={writeInlineModelInherited ? '' : form.write.inlineCompletion.model}
                        placeholder={t('writeInlineCompletionModelPlaceholder')}
                        onChange={(e) => {
                          const value = e.target.value.trim()
                          update({
                            write: {
                              inlineCompletion: {
                                inheritModel: !value,
                                model: value || DEFAULT_WRITE_INLINE_COMPLETION_MODEL
                              }
                            }
                          })
                        }}
                      />
                      <datalist id="write-inline-completion-model-options">
                        {[...new Set([...writeInlineProviderModels, ...WRITE_INLINE_COMPLETION_MODEL_IDS])]
                          .filter((model) => !model.startsWith('deepseek-v4-'))
                          .map((model) => (
                          <option
                            key={model}
                            value={model}
                            label={
                              model === DEFAULT_WRITE_INLINE_COMPLETION_MODEL
                                ? t('writeInlineCompletionModelFlash')
                                : model
                            }
                          />
                          ))}
                      </datalist>
                      <p className="mt-2 text-[12px] text-ds-muted">
                        {writeInlineModelInherited
                          ? t('writeInlineCompletionModelInherited', { value: effectiveWriteInlineModel })
                          : t('writeInlineCompletionModelOverride', { value: effectiveWriteInlineModel })}
                      </p>
                    </div>
                  }
                />
                <SettingRow
                  title={t('writeInlineCompletionDebounce')}
                  description={t('writeInlineCompletionDebounceDesc')}
                  control={
                    <select
                      className={selectControlClass}
                      value={form.write.inlineCompletion.debounceMs}
                      onChange={(e) => update({
                        write: { inlineCompletion: { debounceMs: Number(e.target.value) } }
                      })}
                    >
                      <option value={300}>{t('writeInlineCompletionDelayFast')}</option>
                      <option value={650}>{t('writeInlineCompletionDelayBalanced')}</option>
                      <option value={1000}>{t('writeInlineCompletionDelayCalm')}</option>
                      <option value={1500}>{t('writeInlineCompletionDelaySlow')}</option>
                    </select>
                  }
                />
                <SettingRow
                  title={t('writeInlineCompletionThreshold')}
                  description={t('writeInlineCompletionThresholdDesc')}
                  control={
                    <select
                      className={selectControlClass}
                      value={form.write.inlineCompletion.minAcceptScore}
                      onChange={(e) => update({
                        write: { inlineCompletion: { minAcceptScore: Number(e.target.value) } }
                      })}
                    >
                      <option value={0.38}>{t('writeInlineCompletionThresholdCreative')}</option>
                      <option value={0.52}>{t('writeInlineCompletionThresholdBalanced')}</option>
                      <option value={0.68}>{t('writeInlineCompletionThresholdStrict')}</option>
                      <option value={0.82}>{t('writeInlineCompletionThresholdVeryStrict')}</option>
                    </select>
                  }
                />
                <SettingRow
                  title={t('writeInlineCompletionMaxTokens')}
                  description={t('writeInlineCompletionMaxTokensDesc')}
                  control={
                    <input
                      type="number"
                      min={16}
                      max={512}
                      step={8}
                      className="w-32 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                      value={form.write.inlineCompletion.maxTokens}
                      placeholder={String(DEFAULT_WRITE_INLINE_COMPLETION_MAX_TOKENS)}
                      onChange={(e) => update({
                        write: { inlineCompletion: { maxTokens: Number(e.target.value) } }
                      })}
                    />
                  }
                />
                <SettingRow
                  title={t('writeInlineLongCompletion')}
                  description={t('writeInlineLongCompletionDesc')}
                  control={
                    <Toggle
                      checked={form.write.inlineCompletion.longCompletionEnabled}
                      onChange={(longCompletionEnabled) => update({
                        write: { inlineCompletion: { longCompletionEnabled } }
                      })}
                    />
                  }
                />
                <SettingRow
                  title={t('writeInlineLongCompletionMaxTokens')}
                  description={t('writeInlineLongCompletionMaxTokensDesc')}
                  control={
                    <input
                      type="number"
                      min={64}
                      max={1024}
                      step={16}
                      className="w-32 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                      value={form.write.inlineCompletion.longMaxTokens}
                      placeholder={String(DEFAULT_WRITE_INLINE_LONG_COMPLETION_MAX_TOKENS)}
                      onChange={(e) => update({
                        write: { inlineCompletion: { longMaxTokens: Number(e.target.value) } }
                      })}
                    />
                  }
                />
                <div className="px-3 py-3 text-[12.5px] leading-5 text-ds-muted">
                  {t('writeInlineCompletionApiNote')}
                </div>
              </SettingsCard>

              <SettingsCard title={t('writeDebugLogTitle')} className="mt-5">
                <SettingRow
                  title={t('writeDebugLogOpen')}
                  description={t('writeDebugLogDesc')}
                  control={
                    <button
                      type="button"
                      onClick={() => {
                        setWriteDebugModalOpen(true)
                        void loadWriteDebugEntries()
                      }}
                      className="inline-flex items-center gap-2 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[13px] font-medium text-ds-ink shadow-sm transition hover:bg-ds-hover"
                    >
                      <PencilLine className="h-4 w-4" strokeWidth={1.75} />
                      {t('writeDebugLogOpenButton')}
                    </button>
                  }
                />
              </SettingsCard>
            </>
  )
}
