// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { BrowserTaskBindingPanel } from './BrowserTaskBindingPanel'
import type { BrowserTaskBindingSnapshot } from '../../../../../kun/src/contracts/browser-skill'

const binding: BrowserTaskBindingSnapshot = { taskId: 'task', taskRevision: 5, browserRevision: 3, browserInstanceId: 'browser',
  browserLabel: '测试 Chrome', origins: ['https://example.com'], interaction: 'observe', previousInteraction: 'observe' }
function button(element: HTMLElement, key: string): HTMLButtonElement {
  return [...element.querySelectorAll('button')].find(item => item.textContent === i18n.t(`common:${key}`))!
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

describe('browser task reauthorization', () => {
  it.each(['observe', 'interact'] as const)('shows the reviewed browser and original origins, confirms the exact revision and leaves resume explicit for %s', async interaction => {
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const snapshot = { taskId: 'task', taskRevision: 5, browserRevision: 3, browserInstanceId: 'browser', browserLabel: '测试 Chrome', origins: ['https://example.com'], interaction, previousInteraction: 'observe' }
    const api = { getBrowserTaskBinding: vi.fn(async () => snapshot), confirmBrowserTaskBinding: vi.fn(async () => ({ binding: snapshot, resumed: false })), coordinateTaskCommand: vi.fn() }
    Object.assign(window, { workwise: api })
    const element = document.createElement('div'), root = createRoot(element), confirmed = vi.fn()
    try {
      await act(async () => root.render(createElement(BrowserTaskBindingPanel, { taskId: 'task', onConfirmed: confirmed })))
      expect(element.textContent).toContain('测试 Chrome')
      expect(element.querySelector('dt')?.textContent).toBe('所选浏览器')
      expect(element.textContent).not.toContain('browserSkillInstance')
      expect(element.textContent).toContain('https://example.com')
      if (interaction === 'interact') expect(element.textContent).toContain('从仅阅读扩大为允许网页交互')
      expect(api.confirmBrowserTaskBinding).not.toHaveBeenCalled()
      await act(async () => element.querySelector('button')!.click())
      expect(api.confirmBrowserTaskBinding).toHaveBeenCalledWith('task', { confirmed: true, expectedTaskRevision: 5, expectedBrowserRevision: 3, browserInstanceId: 'browser', origins: ['https://example.com'], interaction, idempotencyKey: expect.any(String) })
      expect(confirmed).toHaveBeenCalledOnce()
      expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
  })
  it.each(['zh', 'en'])('localizes an initial IPC failure and reloads before an explicit confirmation in %s', async language => {
    await i18n.changeLanguage(language)
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const raw = 'Error invoking remote method "runtime:request": Error: Invalid request path'
    const api = { getBrowserTaskBinding: vi.fn().mockRejectedValueOnce(new Error(raw)).mockResolvedValueOnce(binding),
      confirmBrowserTaskBinding: vi.fn(async () => ({ binding, resumed: false })), coordinateTaskCommand: vi.fn() }
    Object.assign(window, { workwise: api })
    const element = document.createElement('div'), root = createRoot(element), confirmed = vi.fn()
    try {
      await act(async () => root.render(createElement(BrowserTaskBindingPanel, { taskId: 'task', onConfirmed: confirmed })))
      expect(element.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('common:browserTaskBindingLoadFailed'))
      expect(element.querySelector('[role="alert"]')?.textContent).not.toContain('runtime:request')
      expect(element.querySelector('details')?.open).toBe(false)
      expect(element.querySelector('details pre')?.textContent).toBe(raw)
      expect(button(element, 'browserTaskBindingConfirm').disabled).toBe(true)
      await act(async () => button(element, 'browserTaskBindingReload').click())
      expect(api.getBrowserTaskBinding.mock.calls).toEqual([['task'], ['task']])
      expect(element.querySelector('[role="alert"]')).toBeNull()
      expect(element.textContent).toContain('测试 Chrome')
      expect(element.querySelector('dt')?.textContent).toBe(language === 'zh' ? '所选浏览器' : 'Selected browser')
      expect(element.textContent).not.toContain('browserSkillInstance')
      expect(api.confirmBrowserTaskBinding).not.toHaveBeenCalled()
      expect(button(element, 'browserTaskBindingConfirm').disabled).toBe(false)
      await act(async () => button(element, 'browserTaskBindingConfirm').click())
      expect(api.confirmBrowserTaskBinding).toHaveBeenCalledWith('task', { confirmed: true, expectedTaskRevision: 5,
        expectedBrowserRevision: 3, browserInstanceId: 'browser', origins: ['https://example.com'], interaction: 'observe', idempotencyKey: expect.any(String) })
      expect(confirmed).toHaveBeenCalledOnce()
      expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
  })
  it.each(['conflict', 'stale_request', 'browser_binding_changed'])('requires reload and another explicit review after %s', async code => {
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const changed = { ...binding, taskRevision: 6, browserRevision: 4, browserLabel: '已更新的 Chrome' }
    const api = { getBrowserTaskBinding: vi.fn().mockResolvedValueOnce(binding).mockResolvedValueOnce(changed),
      confirmBrowserTaskBinding: vi.fn().mockRejectedValueOnce(new Error(`[${code}] browser scope changed`)).mockResolvedValueOnce({ binding: changed, resumed: false }), coordinateTaskCommand: vi.fn() }
    Object.assign(window, { workwise: api })
    const element = document.createElement('div'), root = createRoot(element), confirmed = vi.fn()
    try {
      await act(async () => root.render(createElement(BrowserTaskBindingPanel, { taskId: 'task', onConfirmed: confirmed })))
      await act(async () => button(element, 'browserTaskBindingConfirm').click())
      expect(element.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('common:browserTaskBindingChanged'))
      expect(button(element, 'browserTaskBindingConfirm').disabled).toBe(true)
      expect(confirmed).not.toHaveBeenCalled()
      await act(async () => button(element, 'browserTaskBindingReload').click())
      expect(element.textContent).toContain('已更新的 Chrome')
      expect(api.confirmBrowserTaskBinding).toHaveBeenCalledTimes(1)
      await act(async () => button(element, 'browserTaskBindingConfirm').click())
      expect(api.confirmBrowserTaskBinding).toHaveBeenLastCalledWith('task', expect.objectContaining({ expectedTaskRevision: 6, expectedBrowserRevision: 4 }))
      expect(confirmed).toHaveBeenCalledOnce()
      expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
  })
  it.each(['resolve', 'reject'] as const)('ignores a late %s from the previous task while the current task is loading', async outcome => {
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const previous = deferred<BrowserTaskBindingSnapshot>(), current = deferred<BrowserTaskBindingSnapshot>()
    const changed = { ...binding, taskId: 'next-task', taskRevision: 12, browserLabel: '当前任务浏览器' }
    const api = { getBrowserTaskBinding: vi.fn().mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise),
      confirmBrowserTaskBinding: vi.fn(async () => ({ binding: changed, resumed: false })), coordinateTaskCommand: vi.fn() }
    Object.assign(window, { workwise: api })
    const element = document.createElement('div'), root = createRoot(element), confirmed = vi.fn()
    try {
      await act(async () => root.render(createElement(BrowserTaskBindingPanel, { taskId: 'task', onConfirmed: confirmed })))
      await act(async () => root.render(createElement(BrowserTaskBindingPanel, { taskId: 'next-task', onConfirmed: confirmed })))
      await act(async () => {
        if (outcome === 'resolve') previous.resolve(binding)
        else previous.reject(new Error('old task failure'))
      })
      expect(element.querySelector('[role="alert"]')).toBeNull()
      expect(element.querySelector('[role="status"]')?.textContent).toBe(i18n.t('common:browserTaskBindingLoading'))
      expect(button(element, 'browserTaskBindingConfirm').disabled).toBe(true)
      expect(element.textContent).not.toContain(binding.browserLabel)
      await act(async () => current.resolve(changed))
      expect(element.textContent).toContain(changed.browserLabel)
      await act(async () => button(element, 'browserTaskBindingConfirm').click())
      expect(api.confirmBrowserTaskBinding).toHaveBeenCalledWith('next-task', expect.objectContaining({ expectedTaskRevision: 12 }))
      expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
  })
  it('ignores a confirmation response after switching tasks', async () => {
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const previous = deferred<{ binding: BrowserTaskBindingSnapshot; resumed: false }>()
    const changed = { ...binding, taskId: 'next-task', taskRevision: 12, browserLabel: '当前任务浏览器' }
    const api = { getBrowserTaskBinding: vi.fn().mockResolvedValueOnce(binding).mockResolvedValueOnce(changed),
      confirmBrowserTaskBinding: vi.fn().mockReturnValueOnce(previous.promise), coordinateTaskCommand: vi.fn() }
    Object.assign(window, { workwise: api })
    const element = document.createElement('div'), root = createRoot(element), confirmed = vi.fn()
    try {
      await act(async () => root.render(createElement(BrowserTaskBindingPanel, { taskId: 'task', onConfirmed: confirmed })))
      await act(async () => button(element, 'browserTaskBindingConfirm').click())
      await act(async () => root.render(createElement(BrowserTaskBindingPanel, { taskId: 'next-task', onConfirmed: confirmed })))
      await act(async () => previous.resolve({ binding, resumed: false }))
      expect(confirmed).not.toHaveBeenCalled()
      expect(element.textContent).toContain(changed.browserLabel)
      expect(button(element, 'browserTaskBindingConfirm').disabled).toBe(false)
      expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
  })
  it.each(['load', 'confirm'])('requires review when the %s response belongs to another task', async phase => {
    await i18n.changeLanguage('zh')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const wrongTask = { ...binding, taskId: 'other-task' }
    const api = { getBrowserTaskBinding: vi.fn(async () => phase === 'load' ? wrongTask : binding),
      confirmBrowserTaskBinding: vi.fn(async () => ({ binding: wrongTask, resumed: false })), coordinateTaskCommand: vi.fn() }
    Object.assign(window, { workwise: api })
    const element = document.createElement('div'), root = createRoot(element), confirmed = vi.fn()
    try {
      await act(async () => root.render(createElement(BrowserTaskBindingPanel, { taskId: 'task', onConfirmed: confirmed })))
      if (phase === 'confirm') await act(async () => button(element, 'browserTaskBindingConfirm').click())
      expect(element.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('common:browserTaskBindingChanged'))
      expect(button(element, 'browserTaskBindingConfirm').disabled).toBe(true)
      expect(button(element, 'browserTaskBindingReload').disabled).toBe(false)
      expect(confirmed).not.toHaveBeenCalled()
      expect(api.coordinateTaskCommand).not.toHaveBeenCalled()
    } finally { await act(async () => root.unmount()) }
  })
})
