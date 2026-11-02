import { useState, type ReactElement } from 'react'
import type {
  AppSettingsPatch,
  AppSettingsV1,
  ImageGenerationProtocol,
  ModelEndpointFormat,
  ModelProviderImageCapabilityV1,
  ModelProviderProfileV1,
  ModelProviderSettingsV1
} from '@shared/app-settings'
import {
  DEFAULT_IMAGE_GENERATION_PROTOCOL,
  DEFAULT_MODEL_PROVIDER_ID,
  MODEL_ENDPOINT_FORMATS,
  MODEL_PROVIDER_PRESETS,
  defaultModelProviderSettings,
  getModelProviderPreset,
  modelProviderPresetProfile,
  normalizeModelProviderId
} from '@shared/app-settings'
import { Plus, Trash2 } from 'lucide-react'
import { SecretInput, SettingsCard, SettingRow } from './settings-controls'

const MODEL_ENDPOINT_FORMAT_LABEL_KEYS: Record<ModelEndpointFormat, string> = {
  chat_completions: 'modelEndpointChatCompletions',
  responses: 'modelEndpointResponses',
  messages: 'modelEndpointMessages'
}

const IMAGE_GENERATION_PROTOCOL_LABEL_KEYS: Record<ImageGenerationProtocol, string> = {
  'openai-images': 'imageGenProtocolOpenAi',
  'minimax-image': 'imageGenProtocolMiniMax'
}

export function modelProvidersSettingsPatch(input: {
  provider: ModelProviderSettingsV1
  providers: ModelProviderProfileV1[]
  kun?: Partial<AppSettingsV1['agents']['kun']>
}): AppSettingsPatch {
  const defaultProvider = input.providers.find((item) => item.id === DEFAULT_MODEL_PROVIDER_ID)
  return {
    provider: {
      apiKey: defaultProvider?.apiKey ?? input.provider.apiKey,
      baseUrl: defaultProvider?.baseUrl ?? input.provider.baseUrl,
      providers: input.providers
    },
    ...(input.kun ? { agents: { kun: input.kun } } : {})
  }
}

function mergeProviderModelIds(primary: readonly string[], secondary: readonly string[]): string[] {
  const ids = new Set<string>()
  for (const model of [...primary, ...secondary]) {
    const trimmed = model.trim()
    if (trimmed) ids.add(trimmed)
  }
  return [...ids]
}

function defaultImageCapability(baseUrl: string): ModelProviderImageCapabilityV1 {
  return {
    protocol: DEFAULT_IMAGE_GENERATION_PROTOCOL,
    baseUrl: baseUrl.trim(),
    models: []
  }
}

export function ProvidersSettingsSection({ ctx }: { ctx: Record<string, any> }): ReactElement {
  const {
    t,
    provider: providerFromContext,
    kun,
    update,
    showApiKey,
    setShowApiKey,
    selectControlClass
  } = ctx
  const provider = providerFromContext ?? defaultModelProviderSettings()
  const modelProviders = provider.providers as ModelProviderProfileV1[]
  const [selectedProviderId, setSelectedProviderId] = useState<string>(
    kun.providerId?.trim() || modelProviders[0]?.id || DEFAULT_MODEL_PROVIDER_ID
  )
  const [selectedModelProviderPresetId, setSelectedModelProviderPresetId] = useState<string>(
    ''
  )
  const selectedModelProviderPreset = getModelProviderPreset(selectedModelProviderPresetId)
  const activeProvider =
    modelProviders.find((item) => item.id === selectedProviderId) ??
    modelProviders[0]
  const canEditActiveProviderId = Boolean(activeProvider && activeProvider.id !== DEFAULT_MODEL_PROVIDER_ID)

  const updateModelProviders = (
    providers: ModelProviderProfileV1[],
    kunPatch?: Partial<AppSettingsV1['agents']['kun']>
  ): void => {
    update(modelProvidersSettingsPatch({
      provider,
      providers,
      kun: kunPatch
    }))
  }

  const updateModelProvider = (id: string, patch: Partial<ModelProviderProfileV1>): void => {
    updateModelProviders(modelProviders.map((item) => item.id === id ? { ...item, ...patch } : item))
  }

  const updateModelProviderImage = (id: string, patch: Partial<ModelProviderImageCapabilityV1>): void => {
    updateModelProviders(modelProviders.map((item) => item.id === id
      ? {
          ...item,
          image: {
            ...(item.image ?? defaultImageCapability(item.baseUrl)),
            ...patch
          }
        }
      : item))
  }

  const removeModelProviderImage = (id: string): void => {
    updateModelProviders(modelProviders.map((item) => {
      if (item.id !== id) return item
      const { image: _image, ...rest } = item
      void _image
      return rest
    }))
  }

  const updateModelProviderId = (id: string, value: string): void => {
    if (id === DEFAULT_MODEL_PROVIDER_ID) return
    const nextId = normalizeModelProviderId(value)
    if (!nextId || nextId === id) return
    if (modelProviders.some((item) => item.id === nextId && item.id !== id)) return
    setSelectedProviderId(nextId)
    updateModelProviders(
      modelProviders.map((item) => item.id === id ? { ...item, id: nextId } : item),
      kun.providerId === id ? { providerId: nextId } : undefined
    )
  }

  const addModelProvider = (): void => {
    const baseId = 'custom-provider'
    let index = modelProviders.length + 1
    let id = `${baseId}-${index}`
    const used = new Set(modelProviders.map((item) => item.id))
    while (used.has(id)) {
      index += 1
      id = `${baseId}-${index}`
    }
    const nextProvider: ModelProviderProfileV1 = {
      id,
      name: t('modelProviderNewName', { index }),
      apiKey: '',
      baseUrl: 'https://api.example.com/v1',
      endpointFormat: 'chat_completions',
      models: []
    }
    setSelectedProviderId(id)
    updateModelProviders([...modelProviders, nextProvider], { providerId: id })
  }

  const addPresetModelProvider = (): void => {
    if (!selectedModelProviderPreset) return
    const presetProvider = modelProviderPresetProfile(selectedModelProviderPreset)
    const existingProvider = modelProviders.find((item) => item.id === presetProvider.id)
    const nextProvider: ModelProviderProfileV1 = existingProvider
      ? {
          ...presetProvider,
          name: existingProvider.name.trim() || presetProvider.name,
          apiKey: existingProvider.apiKey,
          models: mergeProviderModelIds(presetProvider.models, existingProvider.models),
          image: presetProvider.image ?? existingProvider.image
        }
      : presetProvider
    const nextProviders = existingProvider
      ? modelProviders.map((item) => item.id === presetProvider.id ? nextProvider : item)
      : [...modelProviders, nextProvider]
    setSelectedProviderId(nextProvider.id)
    updateModelProviders(nextProviders, {
      providerId: nextProvider.id,
      model: nextProvider.models[0] ?? kun.model
    })
  }

  const removeModelProvider = (id: string): void => {
    if (id === DEFAULT_MODEL_PROVIDER_ID) return
    const nextProviders = modelProviders.filter((item) => item.id !== id)
    setSelectedProviderId(DEFAULT_MODEL_PROVIDER_ID)
    updateModelProviders(
      nextProviders,
      kun.providerId === id ? { providerId: DEFAULT_MODEL_PROVIDER_ID } : undefined
    )
  }

  return (
    <SettingsCard title={t('providers')}>
      <SettingRow
        title={t('modelProviderPreset')}
        description={t('modelProviderPresetDesc')}
        control={
          <div className="grid w-full min-w-0 gap-2 md:max-w-md">
            <select
              aria-label={t('modelProviderPreset')}
              className={selectControlClass}
              value={selectedModelProviderPresetId}
              onChange={(e) => setSelectedModelProviderPresetId(e.target.value)}
            >
              <option value="">{t('modelProviderPresetPlaceholder')}</option>
              {MODEL_PROVIDER_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.name}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={!selectedModelProviderPreset}
              onClick={addPresetModelProvider}
              className="inline-flex h-9 w-fit items-center gap-2 rounded-full border border-ds-border bg-ds-card px-3 text-[12.5px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-ds-card disabled:hover:text-ds-muted"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
              {t('modelProviderAddPreset')}
            </button>
          </div>
        }
      />
      <SettingRow
        title={t('providers')}
        description={t('providersDesc')}
        wideControl
        control={
          <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
            <div className="space-y-2">
              <select
                className={selectControlClass}
                value={activeProvider?.id ?? DEFAULT_MODEL_PROVIDER_ID}
                onChange={(e) => setSelectedProviderId(e.target.value)}
              >
                {modelProviders.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={addModelProvider}
                className="inline-flex h-9 items-center gap-2 rounded-full border border-ds-border bg-ds-card px-3 text-[12.5px] font-medium text-ds-muted shadow-sm transition hover:bg-ds-hover hover:text-ds-ink"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
                {t('modelProviderAdd')}
              </button>
            </div>
            {activeProvider ? (
              <div className="grid gap-3 rounded-xl border border-ds-border-muted bg-ds-main/35 p-3">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="grid gap-1.5 text-[12px] font-semibold text-ds-muted">
                    {t('modelProviderName')}
                    <input
                      className="w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] font-normal text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                      value={activeProvider.name}
                      onChange={(e) => updateModelProvider(activeProvider.id, { name: e.target.value })}
                    />
                  </label>
                  <label className="grid gap-1.5 text-[12px] font-semibold text-ds-muted">
                    {t('modelProviderId')}
                    <input
                      className={`w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 font-mono text-[13px] font-normal shadow-sm ${
                        canEditActiveProviderId
                          ? 'text-ds-ink focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30'
                          : 'text-ds-faint'
                      }`}
                      value={activeProvider.id}
                      readOnly={!canEditActiveProviderId}
                      spellCheck={false}
                      onChange={(e) => updateModelProviderId(activeProvider.id, e.target.value)}
                    />
                  </label>
                </div>
                <label className="grid gap-1.5 text-[12px] font-semibold text-ds-muted">
                  {t('modelProviderApiKey')}
                  <SecretInput
                    value={activeProvider.apiKey}
                    onChange={(value) => updateModelProvider(activeProvider.id, { apiKey: value })}
                    visible={showApiKey}
                    onToggleVisibility={() => setShowApiKey((value: boolean) => !value)}
                    placeholder={t('kunApiKeyPlaceholder')}
                    autoComplete="off"
                    showLabel={t('showSecret')}
                    hideLabel={t('hideSecret')}
                  />
                </label>
                <label className="grid gap-1.5 text-[12px] font-semibold text-ds-muted">
                  {t('modelProviderBaseUrl')}
                  <input
                    className="w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] font-normal text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                    value={activeProvider.baseUrl}
                    placeholder={t('baseUrlPlaceholder')}
                    onChange={(e) => updateModelProvider(activeProvider.id, { baseUrl: e.target.value })}
                  />
                </label>
                <label className="grid gap-1.5 text-[12px] font-semibold text-ds-muted">
                  {t('modelProviderEndpointFormat')}
                  <select
                    className={selectControlClass}
                    value={activeProvider.endpointFormat}
                    onChange={(e) => updateModelProvider(activeProvider.id, {
                      endpointFormat: e.target.value as ModelEndpointFormat
                    })}
                  >
                    {MODEL_ENDPOINT_FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {t(MODEL_ENDPOINT_FORMAT_LABEL_KEYS[format])}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5 text-[12px] font-semibold text-ds-muted">
                  {t('modelProviderModels')}
                  <textarea
                    className="min-h-24 w-full min-w-0 resize-y rounded-xl border border-ds-border bg-ds-card px-3 py-2 font-mono text-[12.5px] font-normal text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                    value={activeProvider.models.join('\n')}
                    placeholder="deepseek-flash"
                    onChange={(e) => updateModelProvider(activeProvider.id, {
                      models: e.target.value.split('\n').map((item) => item.trim()).filter(Boolean)
                    })}
                  />
                </label>
                <div className="grid gap-3 rounded-xl border border-ds-border-muted bg-ds-card/45 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[12px] font-semibold text-ds-muted">{t('modelProviderImageCapability')}</div>
                      <div className="mt-1 text-[12px] leading-5 text-ds-faint">{t('modelProviderImageCapabilityDesc')}</div>
                    </div>
                    {activeProvider.image ? (
                      <button
                        type="button"
                        onClick={() => removeModelProviderImage(activeProvider.id)}
                        className="inline-flex h-8 items-center gap-2 rounded-full border border-ds-border bg-ds-card px-3 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                      >
                        {t('modelProviderImageDisable')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => updateModelProvider(activeProvider.id, {
                          image: defaultImageCapability(activeProvider.baseUrl)
                        })}
                        className="inline-flex h-8 items-center gap-2 rounded-full border border-ds-border bg-ds-card px-3 text-[12px] font-medium text-ds-muted transition hover:bg-ds-hover hover:text-ds-ink"
                      >
                        <Plus className="h-3.5 w-3.5" strokeWidth={1.9} />
                        {t('modelProviderImageEnable')}
                      </button>
                    )}
                  </div>
                  {activeProvider.image ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <label className="grid gap-1.5 text-[12px] font-semibold text-ds-muted">
                        {t('imageGenProtocol')}
                        <select
                          className={selectControlClass}
                          value={activeProvider.image.protocol}
                          onChange={(e) => updateModelProviderImage(activeProvider.id, {
                            protocol: e.target.value as ImageGenerationProtocol
                          })}
                        >
                          {Object.entries(IMAGE_GENERATION_PROTOCOL_LABEL_KEYS).map(([protocol, key]) => (
                            <option key={protocol} value={protocol}>{t(key)}</option>
                          ))}
                        </select>
                      </label>
                      <label className="grid gap-1.5 text-[12px] font-semibold text-ds-muted">
                        {t('imageGenBaseUrl')}
                        <input
                          className="w-full min-w-0 rounded-xl border border-ds-border bg-ds-card px-3 py-2 text-[14px] font-normal text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                          value={activeProvider.image.baseUrl}
                          placeholder={t('imageGenBaseUrlPlaceholder')}
                          onChange={(e) => updateModelProviderImage(activeProvider.id, { baseUrl: e.target.value })}
                        />
                      </label>
                      <label className="grid gap-1.5 text-[12px] font-semibold text-ds-muted md:col-span-2">
                        {t('imageGenModel')}
                        <textarea
                          className="min-h-20 w-full min-w-0 resize-y rounded-xl border border-ds-border bg-ds-card px-3 py-2 font-mono text-[12.5px] font-normal text-ds-ink shadow-sm focus:border-accent/40 focus:outline-none focus:ring-1 focus:ring-accent/30"
                          value={activeProvider.image.models.join('\n')}
                          placeholder="image-01"
                          onChange={(e) => updateModelProviderImage(activeProvider.id, {
                            models: e.target.value.split('\n').map((item) => item.trim()).filter(Boolean)
                          })}
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
                {activeProvider.id !== DEFAULT_MODEL_PROVIDER_ID ? (
                  <button
                    type="button"
                    onClick={() => removeModelProvider(activeProvider.id)}
                    className="inline-flex h-9 w-fit items-center gap-2 rounded-full border border-red-200/70 bg-red-50 px-3 text-[12.5px] font-medium text-red-700 transition hover:bg-red-100 dark:border-red-900/70 dark:bg-red-950/25 dark:text-red-200 dark:hover:bg-red-950/40"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.9} />
                    {t('modelProviderRemove')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        }
      />
    </SettingsCard>
  )
}
