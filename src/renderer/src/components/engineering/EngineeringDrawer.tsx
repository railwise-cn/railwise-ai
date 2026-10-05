import { useEffect, useId, useRef, type ReactNode, type ReactElement, type RefObject } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Native modal semantics provide Escape, focus containment and inert background. */
export function EngineeringDrawer({ open, title, onClose, children, wide = false, fallbackFocusRef }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean; fallbackFocusRef?: RefObject<HTMLElement | null>
}): ReactElement {
  const { t } = useTranslation('common')
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      element.showModal()
      closeButton.current?.focus()
    } else if (!open && element.open) {
      element.close()
      if (returnFocus.current?.isConnected && returnFocus.current !== document.body) returnFocus.current.focus()
      else fallbackFocusRef?.current?.focus()
    }
  }, [open, fallbackFocusRef])
  return <dialog ref={dialog} aria-labelledby={titleId} className={`engineering-detail-drawer ${wide ? 'is-wide' : ''}`}
    onCancel={event => { event.preventDefault(); onClose() }}
    onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="flex h-full min-h-0 flex-col bg-ds-main text-ds-ink">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-ds-border-muted bg-ds-card px-4 py-2">
        <h2 id={titleId} className="min-w-0 truncate text-[15px] font-semibold">{title}</h2>
        <button ref={closeButton} type="button" onClick={onClose} aria-label={t('engineeringCloseDetails')}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-ds-muted hover:bg-ds-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><X className="h-4 w-4" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  </dialog>
}
