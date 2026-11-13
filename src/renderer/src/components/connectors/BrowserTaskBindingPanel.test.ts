// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { BrowserTaskBindingPanel } from './BrowserTaskBindingPanel'

describe('browser task reauthorization', () => {
  it('shows the reviewed browser and original origins, confirms the exact revision and leaves resume explicit', async () => {
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const snapshot = { taskId: 'task', taskRevision: 5, browserRevision: 3, browserInstanceId: 'browser', browserLabel: '测试 Chrome', origins: ['https://example.com'], interaction: 'observe' }
    const api = { getBrowserTaskBinding: vi.fn(async () => snapshot), confirmBrowserTaskBinding: vi.fn(async () => ({ binding: snapshot, resumed: false })), coordinateTaskCommand: vi.fn() }
    Object.assign(window, { workwise: api })
    const element = document.createElement('div'), root = createRoot(element), confirmed = vi.fn()
    try {
      await act(async () => root.render(createElement(BrowserTaskBindingPanel, { taskId: 'task', onConfirmed: confirmed })))
      expect(element.textContent).toContain('测试 Chrome')
      expect(element.textContent).toContain('https://example.com')
      expect(api.confirmBrowserTaskBinding).not.toHaveBeenCalled()
      await act(async () => element.querySelector('button')!.click())
      expect(api.confirmBrowserTaskBinding).toHaveBeenCalledWith('task', { confirmed: true, expectedTaskRevision: 5, expectedBrowserRevision: 3, browserInstanceId: 'browser', origins: ['https://example.com'], idempotencyKey: expect.any(String) })
      expect(confirmed).toHaveBeenCalledOnce()
      expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
  })
})
