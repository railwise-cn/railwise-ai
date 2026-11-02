import {
  DEFAULT_AGNES_BASE_URL,
  DEFAULT_AGNES_PROVIDER_ID,
  DEFAULT_AGNES_TEXT_MODEL,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_IMAGE_GENERATION_PROTOCOL,
  DEFAULT_MODEL_ENDPOINT_FORMAT,
  DEFAULT_MODEL_PROVIDER_ID,
  DEFAULT_MANAGED_RUNTIME_MODEL,
  CUSTOM_IMAGE_GENERATION_PROVIDER_ID,
  type AppSettingsV1,
  type ImageGenerationProtocol,
  type KunImageGenerationSettingsV1,
  type KunRuntimeSettingsV1,
  type ModelProviderImageCapabilityPatchV1,
  type ModelProviderImageCapabilityV1,
  type ModelProviderProfilePatchV1,
  type ModelProviderProfileV1,
  type ModelProviderSettingsPatchV1,
  type ModelProviderSettingsV1
} from './app-settings-types'
import { normalizeModelEndpointFormat } from '../../kun/src/contracts/model-endpoint-format.js'
import { getKunRuntimeSettings } from './app-settings-runtime'
import { normalizeDeepseekBaseUrl } from './app-settings-normalizers'
import { DEFAULT_COMPOSER_MODEL_IDS } from './default-composer-models'

const DEFAULT_MODEL_PROVIDER_NAME = 'DeepSeek'
const DEFAULT_AGNES_PROVIDER_NAME = 'Agnes AI'

export function defaultModelProviderSettings(): ModelProviderSettingsV1 {
  const defaultProvider = defaultModelProviderProfile('', DEFAULT_DEEPSEEK_BASE_URL)
  const agnesProvider = defaultAgnesProviderProfile()
  return {
    apiKey: defaultProvider.apiKey,
    baseUrl: defaultProvider.baseUrl,
    providers: [defaultProvider, agnesProvider]
  }
}

export function normalizeModelProviderSettings(
  input: ModelProviderSettingsPatchV1 | undefined
): ModelProviderSettingsV1 {
  const defaults = defaultModelProviderSettings()
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : defaults.apiKey
  const baseUrl =
    typeof input?.baseUrl === 'string' && input.baseUrl.trim()
      ? normalizeDeepseekBaseUrl(input.baseUrl)
      : defaults.baseUrl
  const rawProviders = Array.isArray(input?.providers) ? input.providers : []
  const providersById = new Map<string, ModelProviderProfileV1>()
  const defaultProvider = defaultModelProviderProfile(apiKey, baseUrl)
  for (const builtInProvider of defaults.providers) {
    providersById.set(
      builtInProvider.id,
      builtInProvider.id === DEFAULT_MODEL_PROVIDER_ID ? defaultProvider : builtInProvider
    )
  }
  for (const rawProvider of rawProviders) {
    const fallback = providersById.get(normalizeModelProviderId(rawProvider?.id))
    const provider = normalizeModelProviderProfile(rawProvider, fallback)
    if (!provider) continue
    providersById.set(provider.id, provider.id === DEFAULT_MODEL_PROVIDER_ID
      ? {
          ...defaultProvider,
          ...provider,
          apiKey,
          baseUrl
        }
      : provider)
  }
  const providers = [...providersById.values()]
  return {
    apiKey,
    baseUrl,
    providers
  }
}

export function mergeModelProviderSettings(
  current: ModelProviderSettingsV1,
  patch: ModelProviderSettingsPatchV1 | undefined
): ModelProviderSettingsV1 {
  return normalizeModelProviderSettings({
    ...current,
    ...(patch ?? {})
  })
}

export function getModelProviderSettings(settings: AppSettingsV1): ModelProviderSettingsV1 {
  return normalizeModelProviderSettings((settings as { provider?: ModelProviderSettingsPatchV1 }).provider)
}

export function modelProviderSettingsPatch(
  provider: ModelProviderSettingsPatchV1 | undefined
): ModelProviderSettingsPatchV1 {
  return provider ? { ...provider } : {}
}

export function resolveModelProviderApiKey(settings: AppSettingsV1): string {
  return getDefaultModelProviderProfile(settings).apiKey.trim()
}

export function resolveModelProviderBaseUrl(settings: AppSettingsV1): string {
  return normalizeDeepseekBaseUrl(getDefaultModelProviderProfile(settings).baseUrl)
}

export function getDefaultModelProviderProfile(settings: AppSettingsV1): ModelProviderProfileV1 {
  return getModelProviderProfile(settings, DEFAULT_MODEL_PROVIDER_ID)
}

export function getModelProviderProfile(
  settings: AppSettingsV1,
  providerId: string | undefined
): ModelProviderProfileV1 {
  const provider = getModelProviderSettings(settings)
  const id = normalizeModelProviderId(providerId || DEFAULT_MODEL_PROVIDER_ID)
  return provider.providers.find((profile) => profile.id === id) ?? provider.providers[0] ?? defaultModelProviderProfile(provider.apiKey, provider.baseUrl)
}

export function listModelProviderModelIds(settings: AppSettingsV1): string[] {
  const ids = new Set<string>()
  for (const provider of getModelProviderSettings(settings).providers) {
    for (const model of provider.models) {
      const trimmed = model.trim()
      if (trimmed) ids.add(trimmed)
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function listImageGenerationProviderProfiles(settings: AppSettingsV1): ModelProviderProfileV1[] {
  return getModelProviderSettings(settings).providers.filter((provider) => Boolean(provider.image))
}

export function resolveKunImageGenerationSettings(settings: AppSettingsV1): KunImageGenerationSettingsV1 {
  const runtime = getKunRuntimeSettings(settings)
  const imageGeneration = runtime.imageGeneration
  const providerId = normalizeModelProviderId(imageGeneration.providerId)
  if (!providerId || providerId === CUSTOM_IMAGE_GENERATION_PROVIDER_ID) {
    return {
      ...imageGeneration,
      providerId,
      protocol: normalizeImageGenerationProtocol(imageGeneration.protocol)
    }
  }
  const provider = getModelProviderProfile(settings, providerId)
  const image = provider.image
  if (!image) {
    return {
      ...imageGeneration,
      providerId,
      protocol: normalizeImageGenerationProtocol(imageGeneration.protocol)
    }
  }
  return {
    ...imageGeneration,
    providerId: provider.id,
    protocol: image.protocol,
    baseUrl: imageGeneration.baseUrl.trim() || image.baseUrl,
    apiKey: imageGeneration.apiKey.trim() || provider.apiKey.trim(),
    model: imageGeneration.model.trim() || (image.models[0] ?? '')
  }
}

export function resolveKunRuntimeSettings(settings: AppSettingsV1): KunRuntimeSettingsV1 {
  const runtime = getKunRuntimeSettings(settings)
  const provider = getModelProviderProfile(settings, runtime.providerId)
  const runtimeApiKey = runtime.apiKey?.trim() ?? ''
  const runtimeBaseUrl = runtime.baseUrl?.trim() ?? ''
  const providerBaseUrl = provider.baseUrl.trim() || DEFAULT_DEEPSEEK_BASE_URL
  const baseUrl =
    runtimeBaseUrl && runtimeBaseUrl !== DEFAULT_DEEPSEEK_BASE_URL
      ? normalizeDeepseekBaseUrl(runtimeBaseUrl)
      : normalizeDeepseekBaseUrl(providerBaseUrl)

  return {
    ...runtime,
    apiKey: runtimeApiKey || provider.apiKey.trim(),
    baseUrl,
    endpointFormat: provider.endpointFormat,
    model: resolveProviderModelId({ ...provider, baseUrl }, runtime.model),
    imageGeneration: resolveKunImageGenerationSettings(settings)
  }
}

export const resolveManagedRuntimeSettings = resolveKunRuntimeSettings

export function resolveProviderModelId(provider: ModelProviderProfileV1, model: string): string {
  const trimmed = model.trim()
  if (!isOfficialDeepSeekBaseUrl(provider.baseUrl)) {
    return trimmed
  }
  const normalized = trimmed.toLowerCase()
  return normalized === 'deepseek-chat' || normalized === 'deepseek-reasoner'
    ? DEFAULT_MANAGED_RUNTIME_MODEL
    : trimmed
}

export function isOfficialDeepSeekBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl)
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'api.deepseek.com'
      && !url.username
      && !url.password
      && !url.port
  } catch {
    return false
  }
}

function defaultModelProviderProfile(apiKey: string, baseUrl: string): ModelProviderProfileV1 {
  return {
    id: DEFAULT_MODEL_PROVIDER_ID,
    name: DEFAULT_MODEL_PROVIDER_NAME,
    apiKey: apiKey.trim(),
    baseUrl: normalizeDeepseekBaseUrl(baseUrl),
    endpointFormat: DEFAULT_MODEL_ENDPOINT_FORMAT,
    models: DEFAULT_COMPOSER_MODEL_IDS.filter((id) => id !== 'auto')
  }
}

function defaultAgnesProviderProfile(): ModelProviderProfileV1 {
  return {
    id: DEFAULT_AGNES_PROVIDER_ID,
    name: DEFAULT_AGNES_PROVIDER_NAME,
    apiKey: '',
    baseUrl: normalizeDeepseekBaseUrl(DEFAULT_AGNES_BASE_URL),
    endpointFormat: 'chat_completions',
    models: [DEFAULT_AGNES_TEXT_MODEL]
  }
}

function normalizeModelProviderProfile(
  input: ModelProviderProfilePatchV1 | undefined,
  fallback?: ModelProviderProfileV1
): ModelProviderProfileV1 | null {
  const id = normalizeModelProviderId(input?.id)
  if (!id) return null
  const name = typeof input?.name === 'string' && input.name.trim()
    ? input.name.trim()
    : fallback?.name ?? id
  const baseUrl =
    typeof input?.baseUrl === 'string' && input.baseUrl.trim()
      ? normalizeDeepseekBaseUrl(input.baseUrl)
      : DEFAULT_DEEPSEEK_BASE_URL
  const models = normalizeProviderModels(input?.models)
  const image = normalizeModelProviderImageCapability(input?.image)
  return {
    id,
    name,
    apiKey: typeof input?.apiKey === 'string' ? input.apiKey.trim() : fallback?.apiKey ?? '',
    baseUrl,
    endpointFormat: normalizeModelEndpointFormat(input?.endpointFormat),
    models,
    ...(image ? { image } : {})
  }
}

function normalizeModelProviderImageCapability(
  input: ModelProviderImageCapabilityPatchV1 | null | undefined
): ModelProviderImageCapabilityV1 | undefined {
  if (!input || typeof input !== 'object') return undefined
  const baseUrl = typeof input.baseUrl === 'string' && input.baseUrl.trim()
    ? normalizeDeepseekBaseUrl(input.baseUrl)
    : ''
  const models = normalizeProviderModels(input.models)
  if (!baseUrl && models.length === 0) return undefined
  return {
    protocol: normalizeImageGenerationProtocol(input.protocol),
    baseUrl,
    models
  }
}

export function normalizeImageGenerationProtocol(value: unknown): ImageGenerationProtocol {
  return value === 'minimax-image' ? 'minimax-image' : DEFAULT_IMAGE_GENERATION_PROTOCOL
}

function normalizeProviderModels(models: unknown): string[] {
  if (!Array.isArray(models)) return []
  const ids = new Set<string>()
  for (const model of models) {
    if (typeof model !== 'string') continue
    const trimmed = model.trim()
    if (trimmed) ids.add(trimmed)
  }
  return [...ids].sort((a, b) => a.localeCompare(b))
}

export function normalizeModelProviderId(value: unknown): string {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
    : ''
}
