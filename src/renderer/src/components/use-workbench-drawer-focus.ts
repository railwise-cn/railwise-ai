import { useEffect, useRef } from 'react'

/** One keyboard session per open drawer, including focus restoration on close. */
export function useWorkbenchDrawerFocus(open: boolean, id: string, close: () => void): void {
  const closeRef = useRef(close)
  useEffect(() => { closeRef.current = close }, [close])
  useEffect(() => {
    if (!open) return
    const panel = document.getElementById(id)
    if (!panel) return
    const previous = document.activeElement as HTMLElement | null
    const items = (): HTMLElement[] => Array.from(panel.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled),select:not(:disabled),webview,[tabindex="0"]'
    )).filter(node => node.getClientRects().length > 0 && !node.closest('[inert]'))
    const frame = requestAnimationFrame(() => (items()[0] ?? panel).focus())
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const nodes = items(), first = nodes[0], last = nodes.at(-1)
      if (!first || !last) { event.preventDefault(); panel.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault(); last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
    // Inner menus receive the bubbling event first and can consume Escape/Tab.
    window.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKey)
      if (previous?.isConnected && !previous.closest('[inert]')) previous.focus()
    }
  }, [open, id])
}
