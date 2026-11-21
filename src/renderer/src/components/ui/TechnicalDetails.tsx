import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

export function TechnicalDetails({ detail, label }: { detail?: string; label?: string }): ReactElement | null {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  if (!detail) return null

  return (
    <details className="mt-2 min-w-0 text-xs text-ds-muted" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
        {label ?? t('technicalDetails')}
      </summary>
      {open ? <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed">{detail}</pre> : null}
    </details>
  )
}
