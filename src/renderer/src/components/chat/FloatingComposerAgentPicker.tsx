import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { Bot, Check, ChevronDown, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AnchoredMenu } from '../ui/AnchoredMenu'

export type ComposerAgentOption = { id: string; name: string; role?: string }

export function FloatingComposerAgentPicker({ profiles, value, disabled, applying, onChange }: {
  profiles: readonly ComposerAgentOption[]
  value: string
  disabled?: boolean
  applying?: boolean
  onChange: (id: string) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const id = useId()
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (disabled || applying) setOpen(false) }, [disabled, applying])
  const current = profiles.find(profile => profile.id === value)
  return (
    <div className="ds-composer-agent-picker ds-no-drag min-w-0 max-w-44 shrink">
      <button ref={anchorRef} type="button" disabled={disabled || applying}
        aria-label={t('agentSwitcherMenuTitle')} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        title={t('agentSwitcherTitleWith', { agent: current?.name ?? value })}
        className="flex h-9 w-full min-w-0 items-center gap-1.5 rounded-lg border border-ds-border-muted bg-ds-card px-2.5 text-[12.5px] font-medium text-ds-muted transition hover:bg-ds-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-55"
        onClick={() => setOpen(previous => !previous)}
        onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}
      >
        {applying ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <Bot className="h-3.5 w-3.5 shrink-0" />}
        <span className="min-w-0 truncate">{current?.name ?? t('agentUnavailable')}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" />
      </button>
      <AnchoredMenu id={id} open={open && !disabled && !applying} onOpenChange={setOpen} anchorRef={anchorRef}
        label={t('agentSwitcherMenuTitle')} width={288}>
        {profiles.map(profile => (
          <button type="button" key={profile.id} role="menuitemradio" aria-checked={profile.id === value}
            className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-ds-muted hover:bg-ds-hover focus-visible:bg-ds-hover focus-visible:outline-none"
            onClick={() => { onChange(profile.id); setOpen(false); anchorRef.current?.focus({ preventScroll: true }) }}>
            <span className="min-w-0 flex-1"><span className="block break-words font-semibold">{profile.name}</span>
              {profile.role ? <span className="mt-0.5 block break-words text-[11.5px] leading-4 text-ds-faint">{profile.role}</span> : null}</span>
            {profile.id === value ? <Check className="h-4 w-4 shrink-0 text-accent" /> : null}
          </button>
        ))}
      </AnchoredMenu>
    </div>
  )
}
