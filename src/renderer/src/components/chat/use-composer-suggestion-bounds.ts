import { useLayoutEffect, useState, type RefObject } from 'react'
import { calculateAnchoredMenuPlacement, type MenuViewport } from '../ui/anchored-menu-placement'

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
    const update = (): void => {
      const viewport = window.visualViewport
      const next = composerSuggestionMaxHeight(anchor.getBoundingClientRect(), {
        width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0
      }, Number.parseFloat(getComputedStyle(document.body).zoom))
      setMaxHeight(previous => previous === next ? previous : next)
    }
    const schedule = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update) }
    update()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    const mutation = new MutationObserver(schedule)
    for (let node: HTMLElement | null = anchor; node; node = node.parentElement) resize?.observe(node)
    mutation.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] })
    mutation.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] })
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
