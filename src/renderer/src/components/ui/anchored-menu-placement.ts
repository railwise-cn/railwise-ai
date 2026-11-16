export type MenuAnchorRect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>
export type MenuViewport = { width: number; height: number; left?: number; top?: number }
export type AnchoredMenuPlacement = { left: number; top: number; width: number; maxHeight: number; side: 'top' | 'bottom' }

/** Rects/visualViewport are visual CSS pixels; the body portal uses zoomed layout CSS pixels. */
export function calculateAnchoredMenuPlacement({
  anchor, viewport, contentHeight, preferredWidth = 264, maxHeight = 400,
  scale = 1, align = 'start', margin = 10, gap = 7
}: {
  anchor: MenuAnchorRect
  viewport: MenuViewport
  contentHeight: number
  preferredWidth?: number
  maxHeight?: number
  scale?: number
  align?: 'start' | 'end'
  margin?: number
  gap?: number
}): AnchoredMenuPlacement {
  const zoom = Number.isFinite(scale) && scale > 0 ? scale : 1
  const leftEdge = (viewport.left ?? 0) / zoom
  const topEdge = (viewport.top ?? 0) / zoom
  const viewportWidth = Math.max(0, viewport.width / zoom)
  const viewportHeight = Math.max(0, viewport.height / zoom)
  const inset = Math.min(margin, viewportWidth / 4, viewportHeight / 4)
  const width = Math.max(0, Math.min(preferredWidth, viewportWidth - inset * 2))
  const left = clamp((align === 'end' ? anchor.right / zoom - width : anchor.left / zoom),
    leftEdge + inset, leftEdge + viewportWidth - inset - width)
  const above = Math.max(0, anchor.top / zoom - topEdge - inset - gap)
  const below = Math.max(0, topEdge + viewportHeight - anchor.bottom / zoom - inset - gap)
  const targetHeight = Math.min(Math.max(0, contentHeight), maxHeight)
  const side = above >= targetHeight || above >= below ? 'top' : 'bottom'
  // Never impose a minimum height bigger than the space left in a short window.
  const availableHeight = Math.min(side === 'top' ? above : below, viewportHeight - inset * 2)
  const boundedHeight = Math.max(0, Math.min(maxHeight, availableHeight))
  const visibleHeight = Math.min(targetHeight, boundedHeight)
  const top = clamp(side === 'top' ? anchor.top / zoom - gap - visibleHeight : anchor.bottom / zoom + gap,
    topEdge + inset, topEdge + viewportHeight - inset - visibleHeight)
  return { left, top, width, maxHeight: boundedHeight, side }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
