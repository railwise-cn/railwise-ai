import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type AppSettingsV1
} from '../shared/app-settings'
import { fetchUpstreamModelIds, readConfiguredKunModelIds } from './upstream-models'

function settings(dataDir: string, model = 'settings-model'): AppSettingsV1 {
  const provider = defaultModelProviderSettings()
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 'small',
    provider: {
      ...provider,
      providers: [
        ...provider.providers,
        {
          id: 'custom-provider',
          name: 'Custom Provider',
          apiKey: 'sk-custom',
          baseUrl: 'https://custom.example/v1',
          endpointFormat: 'responses',
          models: ['custom-provider-model']
        }
      ]
    },
    agents: {
      kun: {
        ...defaultManagedRuntimeSettings(),
        dataDir,
        model,
        providerId: 'custom-provider'
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

describe('upstream model picker list', () => {
  it('includes WorkWise Runtime config model profiles, aliases, and the configured agent model', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workwise-models-'))
    await mkdir(dataDir, { recursive: true })
    await writeFile(
      join(dataDir, 'config.json'),
      JSON.stringify({
        contextCompaction: {
          modelProfiles: {
            'legacy-model': {}
          }
        },
        models: {
          profiles: {
            'custom-model': {
              aliases: ['vendor/custom-model']
            }
          }
        }
      }),
      'utf8'
    )

    const ids = await readConfiguredKunModelIds(settings(dataDir))

    expect(ids).toEqual(expect.arrayContaining([
      'auto',
      'deepseek-flash',
      'settings-model',
      'legacy-model',
      'custom-model',
      'vendor/custom-model'
    ]))
  })

  it('falls back to configured model ids when upstream cannot be queried', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workwise-models-'))
    await mkdir(dataDir, { recursive: true })
    await writeFile(
      join(dataDir, 'config.json'),
      JSON.stringify({
        models: {
          profiles: {
            'deepseek-v4-flash': {
              aliases: ['deepseek-chat', 'deepseek-reasoner']
            }
          }
        }
      }),
      'utf8'
    )
    const result = await fetchUpstreamModelIds(settings(dataDir, 'local-only-model'), '')

    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.modelIds).toContain('local-only-model')
      expect(result.modelIds).toContain('custom-provider-model')
      expect(result.modelIds).not.toContain('deepseek-chat')
      expect(result.modelIds).not.toContain('deepseek-reasoner')
      expect(result.modelGroups).toEqual(expect.arrayContaining([
        expect.objectContaining({
          providerId: 'custom-provider',
          label: 'Custom Provider',
          modelIds: expect.arrayContaining(['custom-provider-model'])
        })
      ]))
      const deepseek = result.modelGroups?.find((group) => group.providerId === 'deepseek')
      expect(deepseek?.modelIds).toEqual([
        'deepseek-flash'
      ])
    }
  })

  it('hides retired ids returned by the official DeepSeek model catalog', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workwise-models-'))
    const official = settings(dataDir, 'deepseek-v4-pro')
    official.agents.kun.providerId = 'deepseek'
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [
        { id: 'deepseek-chat' },
        { id: 'deepseek-reasoner' },
        { id: 'deepseek-v4-flash' },
        { id: 'deepseek-v4-pro' }
      ]
    }), { status: 200 })

    try {
      const result = await fetchUpstreamModelIds(official, 'sk-deepseek')
      expect(result).toMatchObject({ ok: true })
      if (result.ok) {
        expect(result.modelIds).toEqual([
          'auto',
          'agnes-2.0-flash',
          'custom-provider-model',
          'deepseek-flash'
        ])
        expect(result.modelIds).not.toContain('deepseek-chat')
        expect(result.modelIds).not.toContain('deepseek-reasoner')
        expect(result.modelGroups?.find((group) => group.providerId === 'deepseek')?.modelIds)
          .toEqual([
            'deepseek-flash'
          ])
        expect(result.modelGroups?.find((group) => group.providerId === 'deepseek')?.discoveredModelIds)
          .toBeUndefined()
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps explicitly configured retired ids on third-party compatible providers', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workwise-models-'))
    const custom = settings(dataDir, 'deepseek-reasoner')
    const provider = custom.provider.providers.find((item) => item.id === 'custom-provider')
    if (!provider) throw new Error('missing custom provider fixture')
    provider.models = ['deepseek-chat', 'deepseek-reasoner']

    const result = await fetchUpstreamModelIds(custom, '')
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.modelIds).toEqual(expect.arrayContaining(['deepseek-chat', 'deepseek-reasoner']))
      expect(result.modelGroups?.find((group) => group.providerId === 'custom-provider')?.modelIds)
        .toEqual(['deepseek-chat', 'deepseek-reasoner'])
    }
  })

  it('keeps custom provider ids when the active runtime uses official DeepSeek', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workwise-models-'))
    const mixed = settings(dataDir, 'deepseek-flash')
    mixed.agents.kun.providerId = 'deepseek'
    const provider = mixed.provider.providers.find((item) => item.id === 'custom-provider')!
    provider.models = ['deepseek-v4-pro', 'deepseek-chat']
    await writeFile(join(dataDir, 'config.json'), JSON.stringify({ models: { profiles: {} } }))

    const result = await fetchUpstreamModelIds(mixed, '')
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.modelIds).toEqual(expect.arrayContaining(['deepseek-v4-pro', 'deepseek-chat']))
      expect(result.modelGroups?.find((group) => group.providerId === 'custom-provider')?.modelIds)
        .toEqual(['deepseek-chat', 'deepseek-v4-pro'])
      expect(result.modelGroups?.find((group) => group.providerId === 'deepseek')?.modelIds)
        .toEqual(['deepseek-flash'])
    }
  })

  it('marks models returned by the active third-party catalog as discovered', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workwise-models-'))
    const custom = settings(dataDir, 'custom-provider-model')
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: [{ id: 'custom-provider-model' }, { id: 'deepseek-v4-flash-vision-exp' }]
    }), { status: 200 })

    try {
      const result = await fetchUpstreamModelIds(custom, 'sk-custom')
      expect(result).toMatchObject({ ok: true })
      if (result.ok) {
        expect(result.modelGroups?.find((group) => group.providerId === 'custom-provider'))
          .toMatchObject({
            discoveredModelIds: ['custom-provider-model', 'deepseek-v4-flash-vision-exp']
          })
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
