// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { ReleaseHighlights } from './ReleaseHighlights'

afterEach(() => vi.unstubAllGlobals())

it.each(['0.5.9', '0.5.10', '0.5.11'])('presents the %s highlights once and supports dismissal', async (version) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('zh')
  const getAppVersion = vi.fn(async () => '0.5.8')
  const openExternal = vi.fn(async () => undefined)
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubGlobal('workwise', { getAppVersion, openExternal })
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => root.render(createElement(ReleaseHighlights, { key: 'old' })))
    expect(container.textContent).toBe('')
    getAppVersion.mockResolvedValue(version)
    await act(async () => root.render(createElement(ReleaseHighlights, { key: 'first' })))
    expect(container.textContent).toContain(`本版更新 · ${version}`)
    expect(storage.has(`railwise.release-highlights.${version}`)).toBe(false)

    await act(async () => root.render(null))
    await act(async () => root.render(createElement(ReleaseHighlights, { key: 'remounted' })))
    expect(container.textContent).toContain(`本版更新 · ${version}`)
    expect(storage.has(`railwise.release-highlights.${version}`)).toBe(false)

    await act(async () => container.querySelector('button')?.click())
    expect(openExternal).toHaveBeenCalledWith('https://www.railwise.cn/products/railwise-ai/#download')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭本版更新"]')?.click())
    expect(container.textContent).toBe('')
    expect(storage.get(`railwise.release-highlights.${version}`)).toBe('1')
    await act(async () => root.render(createElement(ReleaseHighlights, { key: 'later' })))
    expect(container.textContent).toBe('')
  } finally {
    await act(async () => root.unmount())
  }
})
