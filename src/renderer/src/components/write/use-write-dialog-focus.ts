import { useEffect } from 'react'

/** Keep local workbench dialogs keyboard-contained and return focus on close. */
export function useWriteDialogFocus(open: boolean, id: string, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const heading = document.getElementById(id)
    const dialog = heading?.closest<HTMLElement>('[role="dialog"]')
    if (!dialog) return
    const focusable = (): HTMLElement[] => Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter((item) => !item.hidden)
    focusable()[0]?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return }
      if (event.key !== 'Tab') return
      const items = focusable()
      const first = items[0]; const last = items[items.length - 1]
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous?.isConnected) previous.focus()
    }
    // The caller's inline close callback changes on each edit; the dialog owns
    // one focus session until it closes, rather than stealing focus each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id])
}
