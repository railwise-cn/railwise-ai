import { describe, expect, it } from 'vitest'
import {
  DEFAULT_AGNES_BASE_URL,
  DEFAULT_AGNES_PROVIDER_ID,
  DEFAULT_AGNES_TEXT_MODEL,
  DEFAULT_MANAGED_RUNTIME_MODEL,
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings,
  normalizeModelProviderSettings,
  getModelProviderPreset,
  modelProviderPresetProfile,
  defaultScheduleSettings,
  defaultWriteSettings,
  resolveKunImageGenerationSettings,
  resolveManagedRuntimeSettings,
  isOfficialDeepSeekBaseUrl,
  type AppSettingsV1
} from './app-settings'

function settings(): AppSettingsV1 {
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 'small',
    provider: {
      ...defaultModelProviderSettings(),
      providers: [
        ...defaultModelProviderSettings().providers,
        {
          id: 'custom',
          name: 'Custom Provider',
          apiKey: 'sk-custom',
          baseUrl: 'https://custom.example/v1',
          endpointFormat: 'messages',
          models: ['custom-model']
        }
      ]
    },
    agents: {
      kun: {
        ...defaultManagedRuntimeSettings(),
        providerId: 'custom',
        model: 'custom-model'
      }
    },
    workspaceRoot: '/tmp/workspace',
    log: { enabled: false, retentionDays: 7 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    schedule: defaultScheduleSettings(),
    guiUpdate: { channel: 'stable' },
    codePromptPrefix: ''
  }
}

describe('model provider settings', () => {
  it('classifies only the exact HTTPS DeepSeek origin as official', () => {
    expect(isOfficialDeepSeekBaseUrl('https://api.deepseek.com')).toBe(true)
    expect(isOfficialDeepSeekBaseUrl('https://api.deepseek.com/v1')).toBe(true)
    expect(isOfficialDeepSeekBaseUrl('http://api.deepseek.com')).toBe(false)
    expect(isOfficialDeepSeekBaseUrl('https://api.deepseek.com:8443')).toBe(false)
    expect(isOfficialDeepSeekBaseUrl('https://user:pass@api.deepseek.com')).toBe(false)
    expect(isOfficialDeepSeekBaseUrl('https://search.deepseek.com')).toBe(false)
  })

  it('includes Agnes AI as a built-in OpenAI-compatible provider preset', () => {
    const provider = defaultModelProviderSettings()

    expect(provider.providers).toContainEqual(expect.objectContaining({
      id: DEFAULT_AGNES_PROVIDER_ID,
      name: 'Agnes AI',
      baseUrl: DEFAULT_AGNES_BASE_URL,
      endpointFormat: 'chat_completions',
      models: [DEFAULT_AGNES_TEXT_MODEL]
    }))
  })

  it('adds the Agnes preset when normalizing older settings', () => {
    const normalized = normalizeModelProviderSettings({
      apiKey: 'sk-deepseek',
      baseUrl: 'https://api.deepseek.com',
      providers: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          apiKey: 'sk-deepseek',
          baseUrl: 'https://api.deepseek.com',
          endpointFormat: 'chat_completions',
          models: ['deepseek-v4-pro']
        }
      ]
    })

    expect(normalized.providers).toContainEqual(expect.objectContaining({
      id: DEFAULT_AGNES_PROVIDER_ID,
      baseUrl: DEFAULT_AGNES_BASE_URL,
      models: [DEFAULT_AGNES_TEXT_MODEL]
    }))
  })

  it('resolves WorkWise Runtime runtime credentials from the selected provider', () => {
    const runtime = resolveManagedRuntimeSettings(settings())

    expect(runtime.apiKey).toBe('sk-custom')
    expect(runtime.baseUrl).toBe('https://custom.example/v1')
    expect(runtime.endpointFormat).toBe('messages')
  })

  it('migrates retired DeepSeek aliases without changing third-party models', () => {
    const deepseekSettings = settings()
    deepseekSettings.agents.kun.providerId = 'deepseek'
    for (const alias of ['deepseek-chat', 'deepseek-reasoner', '  DEEPSEEK-REASONER  ']) {
      deepseekSettings.agents.kun.model = alias
      expect(resolveManagedRuntimeSettings(deepseekSettings).model).toBe(DEFAULT_MANAGED_RUNTIME_MODEL)
    }
    for (const explicit of ['deepseek-v4-flash', 'deepseek-v4-pro', 'custom-model']) {
      deepseekSettings.agents.kun.model = explicit
      expect(resolveManagedRuntimeSettings(deepseekSettings).model).toBe(explicit)
    }

    const customSettings = settings()
    customSettings.agents.kun.model = 'deepseek-reasoner'
    expect(resolveManagedRuntimeSettings(customSettings).model).toBe('deepseek-reasoner')

    const overriddenSettings = settings()
    overriddenSettings.agents.kun.providerId = 'deepseek'
    overriddenSettings.agents.kun.model = 'deepseek-reasoner'
    overriddenSettings.agents.kun.baseUrl = 'https://gateway.example.com/v1'
    expect(resolveManagedRuntimeSettings(overriddenSettings).model).toBe('deepseek-reasoner')
  })

  it('creates Xiaomi and MiniMax provider presets for WorkWise Runtime runtime profiles', () => {
    const xiaomi = getModelProviderPreset('xiaomi')
    const minimax = getModelProviderPreset('minimax')

    expect(xiaomi && modelProviderPresetProfile(xiaomi)).toMatchObject({
      id: 'xiaomi',
      name: 'Xiaomi',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      endpointFormat: 'chat_completions',
      models: expect.arrayContaining(['mimo-v2-flash', 'mimo-v2.5-pro'])
    })
    expect(minimax && modelProviderPresetProfile(minimax)).toMatchObject({
      id: 'minimax',
      name: 'MiniMax',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      endpointFormat: 'messages',
      models: expect.arrayContaining(['MiniMax-M2.5', 'MiniMax-M3']),
      image: {
        protocol: 'minimax-image',
        baseUrl: 'https://api.minimaxi.com',
        models: ['image-01']
      }
    })
  })

  it('resolves MiniMax preset credentials through the selected provider', () => {
    const minimax = getModelProviderPreset('minimax')
    expect(minimax).not.toBeNull()
    const minimaxProfile = modelProviderPresetProfile(minimax!, 'sk-minimax')
    const resolved = resolveManagedRuntimeSettings({
      ...settings(),
      provider: {
        ...defaultModelProviderSettings(),
        providers: [
          ...defaultModelProviderSettings().providers,
          minimaxProfile
        ]
      },
      agents: {
        kun: {
          ...defaultManagedRuntimeSettings(),
          providerId: minimaxProfile.id,
          model: minimaxProfile.models[0]
        }
      }
    })

    expect(resolved).toEqual(expect.objectContaining({
      apiKey: 'sk-minimax',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      endpointFormat: 'messages',
      imageGeneration: expect.objectContaining({
        enabled: false,
        protocol: 'openai-images'
      }),
      model: 'MiniMax-M2.5'
    }))
  })

  it('resolves MiniMax image generation through provider image capability', () => {
    const minimax = getModelProviderPreset('minimax')
    expect(minimax).not.toBeNull()
    const minimaxProfile = modelProviderPresetProfile(minimax!, 'sk-minimax')
    const resolved = resolveKunImageGenerationSettings({
      ...settings(),
      provider: {
        ...defaultModelProviderSettings(),
        providers: [
          ...defaultModelProviderSettings().providers,
          minimaxProfile
        ]
      },
      agents: {
        kun: {
          ...defaultManagedRuntimeSettings(),
          imageGeneration: {
            ...defaultManagedRuntimeSettings().imageGeneration,
            enabled: true,
            providerId: minimaxProfile.id
          }
        }
      }
    })

    expect(resolved).toEqual(expect.objectContaining({
      enabled: true,
      providerId: 'minimax',
      protocol: 'minimax-image',
      baseUrl: 'https://api.minimaxi.com',
      apiKey: 'sk-minimax',
      model: 'image-01'
    }))
  })
})
