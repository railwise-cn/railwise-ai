// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkbenchLayout } from './workbench-layout'

let host: HTMLDivElement, root: Root, width: number, notifyResize: () => void
function Harness({ route = 'chat' as 'chat' | 'plugins' }) {
  const layout = useWorkbenchLayout({ route, workspaceRoot: '/workspace', activeThreadId: 'thread',
    latestAutoOpenDevPreviewUrl: null, latestDevPreviewUrl: 'http://127.0.0.1/report.html', writeAssistantOpen: false })
  return createElement('div', { ref: layout.shellRef, id: 'layout-host' },
    createElement('output', null, JSON.stringify({ left: layout.leftSidebarWidth, right: layout.rightSidebarWidth,
      collapsed: layout.leftSidebarCollapsed, overlay: layout.activeOverlay, rightVisible: layout.rightPanelVisible })),
    createElement('button', { id: 'navigation', onClick: layout.toggleLeftSidebar }, 'navigation'),
    createElement('button', { id: 'preview', onClick: layout.openDevPreview }, 'preview'),
    createElement('button', { id: 'wide-inspector', onClick: () => layout.setRightSidebarWidth(700) }, 'wide'),
    createElement('div', { id: 'resize-left', onPointerDown: layout.beginLeftResize }))
}
const read = () => JSON.parse(host.querySelector('output')!.textContent!)
async function click(id: string) { await act(async () => host.querySelector<HTMLButtonElement>(`#${id}`)!.click()) }
async function resize(next: number) { width = next; await act(async () => notifyResize()) }

beforeEach(() => {
  width = 1440
  window.localStorage.clear()
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.id === 'layout-host' ? width : 0 })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notifyResize = callback }
    observe() {} disconnect() {}
  })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.style.zoom = ''; vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('measured workbench resize and navigation preferences', () => {
  it('preserves wide-window navigation preference while the compact drawer opens and closes', async () => {
    await act(async () => root.render(createElement(Harness)))
    expect(read().collapsed).toBe(false)
    await resize(960)
    expect(read()).toMatchObject({ collapsed: true, overlay: null })
    await click('navigation')
    expect(read()).toMatchObject({ collapsed: false, overlay: 'navigation' })
    await click('navigation')
    await resize(1440)
    expect(read()).toMatchObject({ collapsed: false, overlay: null })
  })

  it('reacts to the actual container even when the outer window stays the same size', async () => {
    await act(async () => root.render(createElement(Harness)))
    await click('preview'); await click('wide-inspector')
    const preferred = window.localStorage.getItem('workwise.layout.rightInspectorWidth')
    await resize(1280)
    expect(read().right).toBeLessThan(700)
    expect(window.localStorage.getItem('workwise.layout.rightInspectorWidth')).toBe(preferred)
    await resize(1920)
    expect(read().right).toBe(700)
    await resize(1100)
    expect(read()).toMatchObject({ overlay: 'inspector', rightVisible: true })
  })

  it('keeps a hidden-on-wide preference and never leaves an invisible inspector blocking another route', async () => {
    await act(async () => root.render(createElement(Harness)))
    await click('navigation'); await click('preview')
    await resize(960); await click('navigation')
    await resize(1440)
    expect(read().collapsed).toBe(true)
    await act(async () => root.render(createElement(Harness, { route: 'plugins' })))
    expect(read()).toMatchObject({ rightVisible: false, overlay: null })
  })

  it('converts a scaled pointer gesture once and cleans up a cancelled drag', async () => {
    document.body.style.zoom = '1.25'
    await act(async () => root.render(createElement(Harness)))
    const before = read().left
    await act(async () => host.querySelector('#resize-left')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 400 })))
    await act(async () => window.dispatchEvent(new PointerEvent('pointermove', { clientX: 500 })))
    expect(read().left).toBe(before + 80)
    window.dispatchEvent(new PointerEvent('pointercancel'))
    expect(document.body.dataset.workbenchResizing).toBeUndefined()
    expect(document.body.style.cursor).toBe('')
    await act(async () => window.dispatchEvent(new PointerEvent('pointermove', { clientX: 800 })))
    expect(read().left).toBe(before + 80)
  })
})
