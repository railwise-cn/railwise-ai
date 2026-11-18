// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { ReleaseHighlights } from './ReleaseHighlights'

afterEach(() => vi.unstubAllGlobals())

it('presents the release highlights once on the installed version and supports dismissal', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('zh')
  const getAppVersion = vi.fn(async () => '0.5.7')
  const openExternal = vi.fn(async () => undefined)
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubGlobal('workwise', { getAppVersion, openExternal })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(ReleaseHighlights, { key: 'old' })))
    expect(container.textContent).toBe('')
    getAppVersion.mockResolvedValue('0.5.8')
    await act(async () => root.render(createElement(ReleaseHighlights, { key: 'first' })))
    expect(container.textContent).toContain('本版更新 · 0.5.8')
    await act(async () => container.querySelector('button')?.click())
    expect(openExternal).toHaveBeenCalledWith('https://www.railwise.cn/products/railwise-ai/#download')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭本版更新"]')?.click())
    expect(container.textContent).toBe('')
    await act(async () => root.render(createElement(ReleaseHighlights, { key: 'later' })))
    expect(container.textContent).toBe('')
  } finally {
    await act(async () => root.unmount())
  }
})
