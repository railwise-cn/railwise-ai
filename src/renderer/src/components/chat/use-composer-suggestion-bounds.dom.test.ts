// @vitest-environment happy-dom
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composerSuggestionMaxHeight, useComposerSuggestionBounds } from './use-composer-suggestion-bounds'

let root: Root, container: HTMLDivElement, anchorTop: number, headerBottom: number
let resizes: Array<{ callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn>; unobserve: ReturnType<typeof vi.fn> }>
const rect = (): DOMRect => ({ top: anchorTop, bottom: 627, left: 26, right: 934, width: 908, height: 627 - anchorTop }) as DOMRect
const settle = async (): Promise<void> => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) }) }
function Harness({ open = true }: { open?: boolean }) {
  const anchor = useRef<HTMLDivElement>(null)
  const maxHeight = useComposerSuggestionBounds(open, anchor)
  return createElement('div', { ref: anchor, 'data-anchor': true },
    createElement('textarea'), open ? createElement('div', { 'data-list': true, style: { maxHeight: maxHeight ?? undefined } }) : null)
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  anchorTop = 311.4375; headerBottom = 57.2; resizes = []
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn()
    observe = vi.fn()
    unobserve = vi.fn()
    constructor(callback: ResizeObserverCallback) { resizes.push({ callback, disconnect: this.disconnect, observe: this.observe, unobserve: this.unobserve }) }
  })
  const viewport = new EventTarget()
  Object.assign(viewport, { width: 960, height: 640, offsetLeft: 0, offsetTop: 0, scale: 1.5 })
  vi.stubGlobal('visualViewport', viewport)
  document.body.style.zoom = '1.1'
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-header')) {
      const bottom = this.dataset.header === 'current' ? headerBottom : 180
      return { ...rect(), top: 10, bottom, height: bottom - 10 }
    }
    return rect()
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); document.body.style.zoom = ''
  vi.unstubAllGlobals(); vi.restoreAllMocks()
})
const height = (): number => Number.parseFloat(container.querySelector<HTMLElement>('[data-list]')!.style.maxHeight)

describe('composer suggestions above the actual input', () => {
  it('bounds the reproduced large-font expanded input and never applies visualViewport.scale twice', () => {
    expect(composerSuggestionMaxHeight(rect(), { width: 960, height: 640 }, 1.1)).toBeCloseTo(263.125)
    // The old 280px inner list plus header/padding produced a 351.98px panel.
    expect(composerSuggestionMaxHeight(rect(), { width: 960, height: 640 }, 1.1) * 1.1).toBeLessThan(311.4375 - 8)
    expect(composerSuggestionMaxHeight({ ...rect(), top: 7 } as DOMRect, { width: 960, height: 640 }, 1.1)).toBeGreaterThanOrEqual(0)
    expect(composerSuggestionMaxHeight({ ...rect(), top: 80 } as DOMRect, { width: 960, height: 640, top: 80 }, 1.1)).toBe(0)
  })

  it('recalculates for input/ancestor resize, scrolling and real body font scaling without taking textarea focus', async () => {
    await act(async () => root.render(createElement(Harness)))
    const textarea = container.querySelector('textarea')!; textarea.focus()
    expect(height()).toBeCloseTo(263.125)
    anchorTop = 260
    await act(async () => resizes[0]!.callback([], {} as ResizeObserver)); await settle()
    expect(height()).toBeCloseTo(260 / 1.1 - 20)
    anchorTop = 200
    await act(async () => window.dispatchEvent(new Event('scroll'))); await settle()
    expect(height()).toBeCloseTo(200 / 1.1 - 20)
    document.body.style.zoom = '0.9'; await settle()
    expect(height()).toBeCloseTo(200 / 0.9 - 20)
    expect(document.activeElement).toBe(textarea)
  })

  it('uses visual viewport offsets and cleans up when suggestions close', async () => {
    await act(async () => root.render(createElement(Harness)))
    Object.assign(window.visualViewport!, { offsetTop: 80 })
    await act(async () => window.visualViewport!.dispatchEvent(new Event('resize'))); await settle()
    expect(height()).toBeCloseTo((311.4375 - 80) / 1.1 - 20)
    await act(async () => root.render(createElement(Harness, { open: false })))
    expect(container.querySelector('[data-list]')).toBeNull()
    expect(resizes[0]!.disconnect).toHaveBeenCalledOnce()
  })
})


describe('composer suggestions within their own work surface chrome', () => {
  const header = (which = 'current', props = {}) => createElement('header', { className: 'chat-topbar', 'data-header': which, ...props })
  const surface = (open = true) => createElement('main', null, header(), createElement(Harness, { open }))

  it('keeps the reproduced 1.1 zoom menu below the actual same-surface topbar', async () => {
    await act(async () => root.render(surface()))
    expect(height()).toBeCloseTo((anchorTop - headerBottom) / 1.1 - 20)
    expect(anchorTop - height() * 1.1 - 8 * 1.1).toBeGreaterThan(headerBottom)
    expect(resizes[0]!.observe).toHaveBeenCalledWith(container.querySelector('[data-header="current"]'))
  })

  it('does not borrow another main or nested sibling surface header for writing without a topbar', async () => {
    await act(async () => root.render(createElement('div', null,
      createElement('main', null, header('other')),
      createElement('main', null, createElement('section', { className: 'ds-chat-stage' }, header('other')), createElement(Harness)))))
    expect(height()).toBeCloseTo(263.125)
    for (const other of container.querySelectorAll('[data-header]')) expect(resizes[0]!.observe).not.toHaveBeenCalledWith(other)
  })

  it('uses the nearest nested surface rather than its outer main header', async () => {
    await act(async () => root.render(createElement('main', null, header('other'),
      createElement('section', { className: 'ds-chat-stage' }, header(), createElement(Harness)))))
    expect(height()).toBeCloseTo((anchorTop - headerBottom) / 1.1 - 20)
    expect(resizes[0]!.observe).not.toHaveBeenCalledWith(container.querySelector('[data-header="other"]'))
  })

  it('recalculates header resizing with visual viewport offsets and body zoom only once', async () => {
    await act(async () => root.render(surface()))
    const textarea = container.querySelector('textarea')!; textarea.focus()
    Object.assign(window.visualViewport!, { offsetTop: 80 })
    await act(async () => window.visualViewport!.dispatchEvent(new Event('resize'))); await settle()
    expect(height()).toBeCloseTo((anchorTop - 80) / 1.1 - 20)
    headerBottom = 130
    await act(async () => resizes[0]!.callback([], {} as ResizeObserver)); await settle()
    expect(height()).toBeCloseTo((anchorTop - 130) / 1.1 - 20)
    document.body.style.zoom = '0.9'; await settle()
    expect(height()).toBeCloseTo((anchorTop - 130) / 0.9 - 20)
    expect(document.activeElement).toBe(textarea)
  })

  it('ignores hidden chrome, observes a newly rendered header and cleans up on close', async () => {
    const removeViewport = vi.spyOn(window.visualViewport!, 'removeEventListener')
    const disconnectMutation = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const withHeader = (element: ReturnType<typeof header> | null) => createElement('main', null, element, createElement(Harness))
    await act(async () => root.render(withHeader(null)))
    expect(height()).toBeCloseTo(263.125)
    const hiddenHeader = header('current', { style: { display: 'none' } })
    await act(async () => root.render(withHeader(hiddenHeader))); await settle()
    expect(height()).toBeCloseTo(263.125)
    await act(async () => root.render(surface())); await settle()
    expect(height()).toBeCloseTo((anchorTop - headerBottom) / 1.1 - 20)
    const activeHeader = container.querySelector('[data-header="current"]')!
    expect(resizes[0]!.observe).toHaveBeenCalledWith(activeHeader)
    await act(async () => root.render(withHeader(null))); await settle()
    expect(height()).toBeCloseTo(263.125)
    expect(resizes[0]!.unobserve).toHaveBeenCalledWith(activeHeader)
    await act(async () => root.render(surface(false)))
    expect(resizes[0]!.disconnect).toHaveBeenCalledOnce()
    expect(disconnectMutation).toHaveBeenCalledOnce()
    expect(removeViewport).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeViewport).toHaveBeenCalledWith('scroll', expect.any(Function))
    expect(container.querySelector('[data-list]')).toBeNull()
  })
})
