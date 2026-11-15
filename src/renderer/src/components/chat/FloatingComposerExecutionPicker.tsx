import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { Check, ChevronDown, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ApprovalPolicy, SandboxMode } from '@shared/app-settings'
import { AnchoredMenu } from '../ui/AnchoredMenu'

export type ComposerExecutionSettings = {
  approvalPolicy: ApprovalPolicy
  sandboxMode: SandboxMode
}

type Props = {
  value: ComposerExecutionSettings
  applying?: boolean
  disabled?: boolean
  onChange: (patch: Partial<ComposerExecutionSettings>) => void
}

type ApprovalOption = {
  value: ApprovalPolicy
  labelKey: string
}

type SandboxOption = {
  value: SandboxMode
  labelKey: string
}

const APPROVAL_OPTIONS: ApprovalOption[] = [
  { value: 'auto', labelKey: 'approvalAutoShort' },
  { value: 'on-request', labelKey: 'approvalOnRequestShort' },
  { value: 'untrusted', labelKey: 'approvalUntrustedShort' },
  { value: 'suggest', labelKey: 'approvalSuggestShort' },
  { value: 'never', labelKey: 'approvalNeverShort' }
]

const SANDBOX_OPTIONS: SandboxOption[] = [
  { value: 'workspace-write', labelKey: 'sandboxWorkspaceWriteShort' },
  { value: 'read-only', labelKey: 'sandboxReadOnlyShort' },
  { value: 'danger-full-access', labelKey: 'sandboxFullAccessShort' },
  { value: 'external-sandbox', labelKey: 'sandboxExternalShort' }
]

function approvalLabelKey(policy: ApprovalPolicy): string {
  return APPROVAL_OPTIONS.find((option) => option.value === policy)?.labelKey ?? 'approvalAutoShort'
}

function sandboxLabelKey(mode: SandboxMode): string {
  return SANDBOX_OPTIONS.find((option) => option.value === mode)?.labelKey ?? 'sandboxWorkspaceWriteShort'
}

export function FloatingComposerExecutionPicker({
  value,
  applying = false,
  disabled = false,
  onChange
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  useEffect(() => { if (disabled || applying) setOpen(false) }, [disabled, applying])
  const anchorRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const fullAccess = value.sandboxMode === 'danger-full-access'
  const Icon = fullAccess ? ShieldAlert : ShieldCheck
  const title = `${t('composerApprovalShort')}: ${t(approvalLabelKey(value.approvalPolicy))} / ${t('composerAccessShort')}: ${t(sandboxLabelKey(value.sandboxMode))}`

  const update = (patch: Partial<ComposerExecutionSettings>): void => {
    onChange(patch)
    setOpen(false)
    anchorRef.current?.focus({ preventScroll: true })
  }

  return (
    <div className="ds-no-drag min-w-0 shrink">
      <button
        ref={anchorRef}
        type="button"
        disabled={disabled || applying}
        onClick={() => setOpen((current) => !current)}
        className={`inline-flex min-h-7 items-center gap-1.5 rounded-lg border px-2.5 py-0.5 text-[12.5px] font-semibold shadow-sm transition disabled:cursor-not-allowed disabled:opacity-55 ${
          fullAccess
            ? 'border-orange-300/70 bg-orange-50 text-orange-700 hover:bg-orange-100 dark:border-orange-800/70 dark:bg-orange-950/30 dark:text-orange-200'
            : 'border-ds-border-muted bg-ds-card/72 text-ds-muted hover:bg-ds-hover hover:text-ds-ink'
        }`}
        title={title}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? id : undefined}
        aria-label={t('composerExecutionLabel')}
        onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true) } }}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
        <span className="max-w-[120px] truncate">
          {applying ? t('composerExecutionApplying') : t(sandboxLabelKey(value.sandboxMode))}
        </span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
      </button>

      <AnchoredMenu id={id} open={open && !disabled && !applying} onOpenChange={setOpen} anchorRef={anchorRef}
        label={t('composerExecutionLabel')} width={264}>
          <div className="px-2 pb-1 pt-1 text-[11px] font-bold uppercase tracking-[0.08em] text-ds-faint">
            {t('composerApprovalShort')}
          </div>
          {APPROVAL_OPTIONS.map((option) => (
            <ExecutionRow
              key={option.value}
              selected={value.approvalPolicy === option.value}
              label={t(option.labelKey)}
              onClick={() => update({ approvalPolicy: option.value })}
            />
          ))}

          <div className="my-1 h-px bg-ds-border-muted" />

          <div className="px-2 pb-1 pt-1 text-[11px] font-bold uppercase tracking-[0.08em] text-ds-faint">
            {t('composerAccessShort')}
          </div>
          {SANDBOX_OPTIONS.map((option) => (
            <ExecutionRow
              key={option.value}
              selected={value.sandboxMode === option.value}
              label={t(option.labelKey)}
              onClick={() => update({ sandboxMode: option.value })}
            />
          ))}
      </AnchoredMenu>
    </div>
  )
}

function ExecutionRow({
  selected,
  label,
  onClick
}: {
  selected: boolean
  label: string
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2 text-left transition ${
        selected ? 'bg-ds-hover text-ds-ink' : 'hover:bg-ds-hover/70 hover:text-ds-ink'
      }`}
    >
      <span className="min-w-0 truncate font-medium">{label}</span>
      {selected ? <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2} /> : null}
    </button>
  )
}
