import { useCallback, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { calculateAnchoredMenuPlacement, type AnchoredMenuPlacement } from './anchored-menu-placement'

const OPEN_EVENT = 'railwise:anchored-menu-open'
const ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'

export function AnchoredMenu({
  id, open, anchorRef, onOpenChange, label, children, width = 264, maxHeight = 400, align = 'start'
}: {
  id: string
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  onOpenChange: (open: boolean) => void
  label: string
  children: ReactNode
  width?: number
  maxHeight?: number
  align?: 'start' | 'end'
}): ReactElement | null {
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onOpenChange)
  closeRef.current = onOpenChange
  const [placement, setPlacement] = useState<AnchoredMenuPlacement | null>(null)
  const update = useCallback(() => {
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return
    if (!availableAnchor(anchor)) { closeRef.current(false); return }
    const viewport = window.visualViewport
    const bodyZoom = Number.parseFloat(window.getComputedStyle(document.body).zoom)
    const next = calculateAnchoredMenuPlacement({
      anchor: anchor.getBoundingClientRect(),
      viewport: { width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0 },
      scale: bodyZoom, contentHeight: menu.scrollHeight + 2, preferredWidth: width, maxHeight, align
    })
    setPlacement(previous => previous && Object.keys(next).every(key => previous[key as keyof AnchoredMenuPlacement] === next[key as keyof AnchoredMenuPlacement]) ? previous : next)
  }, [anchorRef, width, maxHeight, align])

  useLayoutEffect(() => { if (open) update() })
  useLayoutEffect(() => {
    if (!open) { setPlacement(null); return }
    const anchor = anchorRef.current
    const menu = menuRef.current
    if (!anchor || !menu) return
    let frame = 0
    const schedule = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(update)
    }
    const isInside = (target: EventTarget | null): boolean => target instanceof Node && (anchor.contains(target) || menu.contains(target))
    const pointer = (event: PointerEvent): void => { if (!isInside(event.target)) closeRef.current(false) }
    const focus = (event: FocusEvent): void => { if (!isInside(event.target)) closeRef.current(false) }
    const another = (event: Event): void => { if ((event as CustomEvent<string>).detail !== id) closeRef.current(false) }
    document.addEventListener(OPEN_EVENT, another)
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: id }))
    document.addEventListener('pointerdown', pointer)
    document.addEventListener('focusin', focus)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    const mutation = new MutationObserver(schedule)
    resize?.observe(menu)
    // A sidebar or inspector can move the trigger without resizing the window.
    for (let node: HTMLElement | null = anchor; node; node = node.parentElement) {
      resize?.observe(node)
      mutation.observe(node, { childList: true, attributes: true, attributeFilter: ['style', 'class', 'inert', 'hidden', 'disabled', 'aria-disabled'] })
    }
    const focusFrame = requestAnimationFrame(() => {
      const items = enabledItems(menu)
      const first = items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0]
      first?.focus({ preventScroll: true })
      first?.scrollIntoView?.({ block: 'nearest' })
    })
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(focusFrame)
      resize?.disconnect(); mutation.disconnect()
      document.removeEventListener(OPEN_EVENT, another)
      document.removeEventListener('pointerdown', pointer)
      document.removeEventListener('focusin', focus)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [open, id, anchorRef, update])

  if (!open) return null
  return createPortal(
    <div ref={menuRef} id={id} role="menu" tabIndex={-1} aria-label={label} data-side={placement?.side}
      className="ds-anchored-menu ds-no-drag fixed z-[1100] overflow-auto overscroll-contain rounded-xl border border-ds-border bg-ds-canvas p-1.5 text-[13px] text-ds-ink shadow-[0_16px_48px_rgba(15,23,42,0.18)] outline-none"
      style={placement ? { left: placement.left, top: placement.top, width: placement.width, maxHeight: placement.maxHeight }
        : { left: 0, top: 0, width, visibility: 'hidden' }}
      onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation() }
          anchorRef.current?.focus({ preventScroll: true })
          closeRef.current(false)
          return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault(); event.stopPropagation()
        const items = enabledItems(event.currentTarget)
        if (!items.length) return
        const current = items.findIndex(item => item === document.activeElement)
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[index]?.focus({ preventScroll: true })
        items[index]?.scrollIntoView?.({ block: 'nearest' })
      }}
    >{children}</div>, document.body
  )
}

function enabledItems(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>(ITEMS)].filter(item => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true')
}

function availableAnchor(anchor: HTMLElement): boolean {
  if (!anchor.isConnected || anchor.closest('[inert], [hidden]') || anchor.matches(':disabled, [aria-disabled="true"]')) return false
  for (let node: HTMLElement | null = anchor; node; node = node.parentElement) {
    const style = window.getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}
