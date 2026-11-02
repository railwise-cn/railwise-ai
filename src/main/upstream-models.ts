import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getModelProviderProfile,
  getModelProviderSettings,
  isOfficialDeepSeekBaseUrl,
  listModelProviderModelIds,
  resolveManagedRuntimeSettings,
  type AppSettingsV1
} from '../shared/app-settings'
import { DEFAULT_COMPOSER_MODEL_IDS, isVisibleComposerModelId } from '../shared/default-composer-models'
import type { ModelProviderModelGroup } from '../shared/workwise-api'
import { upstreamOpenAiModelsUrl } from '../shared/openai-compat-url'

export type FetchUpstreamModelsResult =
  | { ok: true; modelIds: string[]; modelGroups?: ModelProviderModelGroup[] }
  | { ok: false; message: string }

const UPSTREAM_MODELS_TIMEOUT_MS = 8_000
const RETIRED_DEEPSEEK_MODEL_IDS = new Set(['deepseek-chat', 'deepseek-reasoner'])

export function fallbackModelIds(): string[] {
  return sortComposerModelIds(DEFAULT_COMPOSER_MODEL_IDS)
}

export async function fetchUpstreamModelIds(
  settings: AppSettingsV1,
  apiKey: string
): Promise<FetchUpstreamModelsResult> {
  const configuredModelIds = visibleConfiguredModelIds(
    settings,
    await readConfiguredKunModelIds(settings)
  )
  const configuredGroups = await readConfiguredModelGroups(settings)
  const key = apiKey.trim()
  if (!key) {
    return modelListOrError(configuredModelIds, configuredGroups, 'Missing API key; cannot query upstream /v1/models.')
  }
  const runtime = resolveManagedRuntimeSettings(settings)
  const activeProvider = getModelProviderProfile(settings, runtime.providerId)
  const url = upstreamOpenAiModelsUrl(runtime.baseUrl)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${key}`
      },
      signal: AbortSignal.timeout(UPSTREAM_MODELS_TIMEOUT_MS)
    })
    const text = await res.text()
    if (!res.ok) {
      return modelListOrError(
        configuredModelIds,
        configuredGroups,
        `Upstream models request failed (${res.status}): ${text.slice(0, 400)}`
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      return modelListOrError(configuredModelIds, configuredGroups, 'Upstream /v1/models returned non-JSON body.')
    }
    const data = (parsed as { data?: unknown }).data
    if (!Array.isArray(data)) {
      return modelListOrError(configuredModelIds, configuredGroups, 'Upstream /v1/models JSON missing data[] array.')
    }
    const ids = new Set<string>()
    for (const row of data) {
      if (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
        const id = (row as { id: string }).id.trim()
        if (id) ids.add(id)
      }
    }
    const upstreamIds = visibleProviderModelIds(activeProvider.baseUrl, [...ids])
    const sorted = mergeModelIds([...upstreamIds, ...configuredModelIds])
    if (sorted.length === 0) {
      return { ok: false, message: 'Upstream returned an empty model list.' }
    }
    return {
      ok: true,
      modelIds: sorted,
      modelGroups: mergeModelGroups([
        ...configuredGroups,
        {
          providerId: activeProvider.id,
          label: activeProvider.name,
          modelIds: upstreamIds,
          discoveredModelIds: upstreamIds
        }
      ])
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return modelListOrError(configuredModelIds, configuredGroups, msg)
  }
}

export async function readConfiguredKunModelIds(settings: AppSettingsV1): Promise<string[]> {
  const runtime = resolveManagedRuntimeSettings(settings)
  const configPath = join(expandHome(runtime.dataDir), 'config.json')
  const ids = [runtime.model, ...listModelProviderModelIds(settings)]
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown
  } catch {
    return mergeModelIds(ids)
  }
  const root = objectValue(parsed)
  const models = objectValue(root.models)
  const contextCompaction = objectValue(root.contextCompaction)
  const configured = mergeModelIds([
    ...ids,
    ...modelIdsFromProfiles(objectValue(contextCompaction.modelProfiles)),
    ...modelIdsFromProfiles(objectValue(models.profiles))
  ])
  return isOfficialDeepSeekBaseUrl(runtime.baseUrl)
    ? configured.filter((id) => isVisibleComposerModelId(id))
    : configured
}

function modelListOrError(
  ids: readonly string[],
  groups: readonly ModelProviderModelGroup[],
  message: string
): FetchUpstreamModelsResult {
  return hasCustomModelId(ids)
    ? { ok: true, modelIds: mergeModelIds(ids), modelGroups: mergeModelGroups(groups) }
    : { ok: false, message }
}

async function readConfiguredModelGroups(settings: AppSettingsV1): Promise<ModelProviderModelGroup[]> {
  const groups: ModelProviderModelGroup[] = []
  for (const provider of getModelProviderSettings(settings).providers) {
    if (provider.models.length === 0) continue
    groups.push({
      providerId: provider.id,
      label: provider.name,
      modelIds: visibleProviderModelIds(provider.baseUrl, provider.models)
    })
  }
  return mergeModelGroups([
    ...groups,
    ...(await readConfiguredProfileAliasGroups(settings, groups))
  ])
}

function mergeModelGroups(groups: readonly ModelProviderModelGroup[]): ModelProviderModelGroup[] {
  const byProvider = new Map<string, ModelProviderModelGroup>()
  for (const group of groups) {
    const providerId = group.providerId.trim()
    if (!providerId) continue
    const existing = byProvider.get(providerId)
    const modelIds = sortComposerModelIds([
      ...(existing?.modelIds ?? []),
      ...group.modelIds
    ]).filter((id) => id !== 'auto')
    const discoveredModelIds = sortComposerModelIds([
      ...(existing?.discoveredModelIds ?? []),
      ...(group.discoveredModelIds ?? [])
    ]).filter((id) => id !== 'auto')
    byProvider.set(providerId, {
      providerId,
      label: group.label.trim() || providerId,
      modelIds,
      ...(discoveredModelIds.length > 0 ? { discoveredModelIds } : {})
    })
  }
  return [...byProvider.values()].filter((group) => group.modelIds.length > 0)
}

function modelIdsFromProfiles(profiles: Record<string, unknown>): string[] {
  const ids: string[] = []
  for (const [modelId, rawProfile] of Object.entries(profiles)) {
    const trimmed = modelId.trim()
    if (trimmed) ids.push(trimmed)
    const aliases = objectValue(rawProfile).aliases
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias !== 'string') continue
        const trimmedAlias = alias.trim()
        if (trimmedAlias) ids.push(trimmedAlias)
      }
    }
  }
  return ids
}

async function readConfiguredProfileAliasGroups(
  settings: AppSettingsV1,
  providerGroups: readonly ModelProviderModelGroup[]
): Promise<ModelProviderModelGroup[]> {
  const runtime = resolveManagedRuntimeSettings(settings)
  const configPath = join(expandHome(runtime.dataDir), 'config.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8')) as unknown
  } catch {
    return []
  }
  const root = objectValue(parsed)
  const models = objectValue(root.models)
  const contextCompaction = objectValue(root.contextCompaction)
  const aliasesByModel = new Map<string, string[]>()
  collectModelProfileAliases(aliasesByModel, objectValue(contextCompaction.modelProfiles))
  collectModelProfileAliases(aliasesByModel, objectValue(models.profiles))
  const providers = new Map(
    getModelProviderSettings(settings).providers.map((provider) => [provider.id, provider])
  )

  const aliasGroups: ModelProviderModelGroup[] = []
  for (const group of providerGroups) {
    const aliases: string[] = []
    for (const modelId of group.modelIds) {
      aliases.push(...(aliasesByModel.get(modelId.trim()) ?? []))
    }
    if (aliases.length === 0) continue
    const provider = providers.get(group.providerId)
    aliasGroups.push({
      providerId: group.providerId,
      label: group.label,
      modelIds: provider ? visibleProviderModelIds(provider.baseUrl, aliases) : aliases
    })
  }
  return aliasGroups
}

function collectModelProfileAliases(
  target: Map<string, string[]>,
  profiles: Record<string, unknown>
): void {
  for (const [modelId, rawProfile] of Object.entries(profiles)) {
    const trimmed = modelId.trim()
    if (!trimmed) continue
    const aliases = objectValue(rawProfile).aliases
    if (!Array.isArray(aliases)) continue
    const ids = target.get(trimmed) ?? []
    for (const alias of aliases) {
      if (typeof alias !== 'string') continue
      const trimmedAlias = alias.trim()
      if (trimmedAlias) ids.push(trimmedAlias)
    }
    target.set(trimmed, ids)
  }
}

function visibleProviderModelIds(baseUrl: string, ids: readonly string[]): string[] {
  if (!isOfficialDeepSeekBaseUrl(baseUrl)) return sortComposerModelIds(ids)
  return sortComposerModelIds(ids).filter((id) => isVisibleComposerModelId(id) && !RETIRED_DEEPSEEK_MODEL_IDS.has(id.toLowerCase()))
}

function visibleConfiguredModelIds(settings: AppSettingsV1, ids: readonly string[]): string[] {
  const officialRuntime = isOfficialDeepSeekBaseUrl(resolveManagedRuntimeSettings(settings).baseUrl)
  const explicitlyConfiguredByCompatibleProvider = new Set(
    getModelProviderSettings(settings).providers
      .filter((provider) => !isOfficialDeepSeekBaseUrl(provider.baseUrl))
      .flatMap((provider) => provider.models.map((id) => id.trim().toLowerCase()))
  )
  return ids.filter((id) => {
    const normalized = id.trim().toLowerCase()
    if (officialRuntime && !isVisibleComposerModelId(id)) return false
    return !RETIRED_DEEPSEEK_MODEL_IDS.has(normalized) ||
      explicitlyConfiguredByCompatibleProvider.has(normalized)
  })
}

function mergeModelIds(ids: readonly string[]): string[] {
  return sortComposerModelIds([...DEFAULT_COMPOSER_MODEL_IDS, ...ids])
}

function hasCustomModelId(ids: readonly string[]): boolean {
  const defaults = new Set<string>(DEFAULT_COMPOSER_MODEL_IDS)
  return ids.some((id) => {
    const trimmed = id.trim()
    return trimmed !== '' && !defaults.has(trimmed as typeof DEFAULT_COMPOSER_MODEL_IDS[number])
  })
}

function sortComposerModelIds(ids: readonly string[]): string[] {
  const ordered = new Set<string>()
  for (const id of ids) {
    const trimmed = id.trim()
    if (trimmed) ordered.add(trimmed)
  }
  const tail = [...ordered].filter((id) => id !== 'auto').sort((a, b) => a.localeCompare(b))
  return ordered.has('auto') ? ['auto', ...tail] : tail
}

function expandHome(path: string): string {
  return path.startsWith('~') ? path.replace(/^~(?=$|[\\/])/, homedir()) : path
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
