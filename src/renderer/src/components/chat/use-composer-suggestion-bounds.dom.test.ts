// @vitest-environment happy-dom
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composerSuggestionMaxHeight, useComposerSuggestionBounds } from './use-composer-suggestion-bounds'

let root: Root, container: HTMLDivElement, anchorTop: number
let resizes: Array<{ callback: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn> }>
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
  anchorTop = 311.4375; resizes = []
  vi.stubGlobal('ResizeObserver', class {
    disconnect = vi.fn()
    observe = vi.fn()
    constructor(callback: ResizeObserverCallback) { resizes.push({ callback, disconnect: this.disconnect }) }
  })
  const viewport = new EventTarget()
  Object.assign(viewport, { width: 960, height: 640, offsetLeft: 0, offsetTop: 0, scale: 1.5 })
  vi.stubGlobal('visualViewport', viewport)
  document.body.style.zoom = '1.1'
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(rect)
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
