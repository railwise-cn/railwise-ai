// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeAppSettings, type AppSettingsV1 } from '@shared/app-settings'
import type { SettingsRouteSection } from '../store/chat-store'
import { SettingsView } from './SettingsView'

const harness = vi.hoisted(() => ({
  section: 'general' as SettingsRouteSection,
  getSettings: vi.fn(),
  applyI18n: vi.fn()
}))

vi.mock('../store/chat-store', () => ({
  useChatStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    settingsSection: harness.section,
    settingsReturnRoute: 'code',
    applyI18nFromSettings: harness.applyI18n
  })
}))
vi.mock('../agent/runtime-client', () => ({ rendererRuntimeClient: { getSettings: harness.getSettings } }))
vi.mock('../agent/registry', () => ({ getProvider: vi.fn() }))
vi.mock('../lib/apply-theme', () => ({ applyTheme: vi.fn(), applyUiFontScale: vi.fn() }))
vi.mock('./use-settings-gui-update', () => ({ useSettingsGuiUpdate: () => ({}) }))
vi.mock('./SettingsSidebar', () => ({ SettingsSidebar: () => null }))
vi.mock('./settings-debug-log', () => ({ WriteDebugLogModal: () => null }))
vi.mock('./settings-sections', () => ({
  GeneralSettingsSection: () => createElement('section', { 'data-settings-section': 'general' }, 'DingTalk connector configuration'),
  ProvidersSettingsSection: () => createElement('section', { 'data-settings-section': 'providers' }, 'Model provider configuration'),
  AgentsSettingsSection: () => createElement('section', { 'data-settings-section': 'agents' }),
  WriteSettingsSection: () => createElement('section', { 'data-settings-section': 'write' }),
  ImageGenerationSettingsSection: () => null,
  KeyboardShortcutsSettingsSection: () => null,
  ClawSettingsSection: () => null,
  HelpSettingsSection: () => null
}))
vi.mock('react-i18next', async importOriginal => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key })
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  harness.section = 'general'
  Object.defineProperty(window, 'workwise', { configurable: true, value: {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'workwise')
})

describe('settings deep links without a model API key', () => {
  it.each(['general', 'providers', 'write', 'agents'] as const)('keeps the requested %s destination when asynchronous settings finish loading', async section => {
    harness.section = section
    let resolveSettings!: (value: ReturnType<typeof normalizeAppSettings>) => void
    harness.getSettings.mockReturnValue(new Promise(resolve => { resolveSettings = resolve }))
    await act(async () => root.render(createElement(SettingsView)))
    expect(container.textContent).toContain('loading')

    const settings = normalizeAppSettings({ provider: { apiKey: '', providers: [] } } as unknown as AppSettingsV1)
    await act(async () => resolveSettings(settings))

    expect(container.querySelector(`[data-settings-section="${section}"]`)).not.toBeNull()
    // A missing model key remains visible as a notice; it cannot replace a
    // connector, workspace, or Agent configuration route with Providers.
    expect(container.textContent).toContain('apiKeyRequiredTitle')
    if (section !== 'providers') expect(container.querySelector('[data-settings-section="providers"]')).toBeNull()
  })
})
