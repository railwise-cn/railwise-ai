import { useLayoutEffect, useState, type RefObject } from 'react'
import { calculateAnchoredMenuPlacement, type MenuViewport } from '../ui/anchored-menu-placement'

const WORK_SURFACE = 'main, [role="main"], .ds-stage-surface, .ds-chat-stage'

/** The input keeps keyboard focus; only the list above it is height constrained. */
export function composerSuggestionMaxHeight(anchor: DOMRect, viewport: MenuViewport, scale: number): number {
  const top = viewport.top ?? 0
  // Suggestions remain above the composer. Limit the shared placement viewport
  // to that space rather than allowing its bottom placement to cross the input.
  const above = { ...viewport, height: Math.max(0, Math.min(anchor.top, top + viewport.height) - top) }
  return calculateAnchoredMenuPlacement({
    anchor, viewport: above, scale, contentHeight: Number.MAX_SAFE_INTEGER,
    maxHeight: Number.MAX_SAFE_INTEGER, gap: 8
  }).maxHeight
}

export function useComposerSuggestionBounds(open: boolean, anchorRef: RefObject<HTMLElement | null>): number | null {
  const [maxHeight, setMaxHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!open) { setMaxHeight(null); return }
    const anchor = anchorRef.current
    if (!anchor) return
    let frame = 0
    let resize: ResizeObserver | undefined
    const surface = anchor.closest(WORK_SURFACE)
    const observedHeaders = new Set<HTMLElement>()
    const update = (): void => {
      const viewport = window.visualViewport, anchorRect = anchor.getBoundingClientRect()
      const viewportTop = viewport?.offsetTop ?? 0
      const bottom = viewportTop + (viewport?.height ?? window.innerHeight)
      let top = viewportTop
      const headers = Array.from(surface?.querySelectorAll<HTMLElement>('.chat-topbar') ?? [])
        .filter(header => header.closest(WORK_SURFACE) === surface)
      for (const previous of observedHeaders) {
        if (!headers.includes(previous)) { resize?.unobserve(previous); observedHeaders.delete(previous) }
      }
      for (const header of headers) {
        if (!observedHeaders.has(header)) { resize?.observe(header); observedHeaders.add(header) }
        const style = getComputedStyle(header), rect = header.getBoundingClientRect()
        if (style.display !== 'none' && style.visibility !== 'hidden' && !header.hidden &&
          rect.width > 0 && rect.height > 0 && rect.right > anchorRect.left && rect.left < anchorRect.right &&
          rect.top < anchorRect.top && Number.isFinite(rect.bottom)) top = Math.max(top, rect.bottom)
      }
      top = Math.min(top, bottom)
      const next = composerSuggestionMaxHeight(anchorRect, {
        width: viewport?.width ?? window.innerWidth, height: Math.max(0, bottom - top),
        left: viewport?.offsetLeft ?? 0, top
      }, Number.parseFloat(getComputedStyle(document.body).zoom))
      setMaxHeight(previous => previous === next ? previous : next)
    }
    const schedule = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    const mutation = new MutationObserver(schedule)
    for (let node: HTMLElement | null = anchor; node; node = node.parentElement) resize?.observe(node)
    mutation.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] })
    mutation.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
    if (surface) mutation.observe(surface, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] })
    update()
    return () => {
      cancelAnimationFrame(frame); resize?.disconnect(); mutation.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [open, anchorRef])
  return maxHeight
}
