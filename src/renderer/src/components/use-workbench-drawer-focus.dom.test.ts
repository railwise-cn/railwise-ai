// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkbenchDrawerFocus } from './use-workbench-drawer-focus'

let host: HTMLDivElement, root: Root
function Drawer({ open, close }: { open: boolean; close: () => void }) {
  useWorkbenchDrawerFocus(open, 'test-drawer', close)
  return open ? createElement('div', { id: 'test-drawer', role: 'dialog', tabIndex: -1 },
    createElement('button', { id: 'first' }, 'first'), createElement('button', { id: 'hidden', hidden: true }, 'hidden'),
    createElement('input', { id: 'last' })) : null
}
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) { return (this.hidden ? [] : [{}]) as unknown as DOMRectList })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  vi.stubGlobal('cancelAnimationFrame', () => {})
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('adaptive drawer keyboard session', () => {
  it('contains keyboard focus, ignores hidden controls and restores the real trigger on close', async () => {
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus()
    await act(async () => root.render(createElement(Drawer, { open: true, close: vi.fn() })))
    expect(document.activeElement?.id).toBe('first')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement?.id).toBe('last')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement?.id).toBe('first')
    await act(async () => root.render(createElement(Drawer, { open: false, close: vi.fn() })))
    expect(document.activeElement).toBe(trigger); trigger.remove()
  })

  it('does not steal focus on rerender and lets an inner menu consume Escape first', async () => {
    const previous = vi.fn(), current = vi.fn()
    await act(async () => root.render(createElement(Drawer, { open: true, close: previous })))
    host.querySelector<HTMLInputElement>('#last')!.focus()
    await act(async () => root.render(createElement(Drawer, { open: true, close: current })))
    expect(document.activeElement?.id).toBe('last')
    const consumed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }); consumed.preventDefault()
    document.dispatchEvent(consumed); expect(current).not.toHaveBeenCalled()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(current).toHaveBeenCalledOnce(); expect(previous).not.toHaveBeenCalled()
  })
})
