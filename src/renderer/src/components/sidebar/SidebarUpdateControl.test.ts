// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { SidebarUpdateControl } from './SidebarUpdateControl'
import { useGuiUpdateStore } from '../../store/gui-update-store'

afterEach(() => vi.unstubAllGlobals())

describe('sidebar update control', () => {
  it('only renders available updates and presents compact progress and retry feedback', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    await i18n.changeLanguage('zh')
    useGuiUpdateStore.setState({ state: { status: 'idle' }, pending: false, activity: null, error: null })
    const container = document.createElement('div')
    const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(SidebarUpdateControl)))
      expect(container.querySelector('button')).toBeNull()
      const info = { ok: true as const, currentVersion: '0.5.4', latestVersion: '0.5.5', hasUpdate: true, releaseUrl: 'https://railwise.cn/download', channel: 'stable' as const }
      await act(async () => useGuiUpdateStore.setState({ state: { status: 'available', info } }))
      expect(container.querySelector('button')?.textContent).toBe('升级')
      expect(container.textContent).not.toContain('0.5.5')
      await act(async () => useGuiUpdateStore.setState({ state: { status: 'downloading', info, progress: { percent: 42, total: 100, transferred: 42, delta: 42, bytesPerSecond: 10 } } }))
      expect(container.querySelector('button')?.disabled).toBe(true)
      expect(container.textContent).toBe('下载 42%')
      await act(async () => useGuiUpdateStore.setState({ state: { status: 'downloaded', info: { ...info, downloaded: true } }, error: '安全停止超时，更新包已保留。' }))
      expect(container.querySelector('button')?.textContent).toBe('重试升级')
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('更新包已保留')
    } finally { await act(async () => root.unmount()); container.remove() }
  })
})
