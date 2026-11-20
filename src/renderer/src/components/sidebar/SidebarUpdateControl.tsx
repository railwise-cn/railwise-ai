import { guiUpdateNotice } from '../settings-utils'
import { TechnicalDetails } from '../ui/TechnicalDetails'
import type { ReactElement } from 'react'
import { ArrowUpCircle, ExternalLink, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { applyGuiUpdate, useGuiUpdate } from '../../store/gui-update-store'

export function SidebarUpdateControl({ docked = false }: { docked?: boolean } = {}): ReactElement | null {
  const { t } = useTranslation(['settings', 'common'])
  const { state, pending, error } = useGuiUpdate()
  const info = state.info
  if (!info?.ok || !info.hasUpdate || info.withdrawn) return null
  const notice = error ? guiUpdateNotice(error, t, Boolean(info.downloaded)) : undefined
  const busy = pending || state.status === 'downloading' || state.status === 'installing'
  const Icon = busy ? Loader2 : info.manualOnly ? ExternalLink : ArrowUpCircle
  const label = state.status === 'downloading'
    ? t('guiUpdateCompactDownloading', { percent: Math.min(100, Math.max(0, Math.round(state.progress.percent))) })
    : state.status === 'installing' ? t('guiUpdateCompactInstalling')
      : info.manualOnly ? t('guiUpdateManualDownload') : error ? t('guiUpdateRetry') : t('guiUpdateUpgrade')
  return (
    <div className={docked ? 'ds-no-drag mx-2 mb-2 max-w-[calc(100%_-_1rem)] shrink-0 self-start rounded-lg border border-ds-border bg-ds-card' : undefined}>
      <button
        type="button"
        disabled={busy}
        onClick={() => void applyGuiUpdate()}
        title={t('guiUpdateUpgradeTitle', { version: info.latestVersion })}
        aria-label={`${label} · ${info.latestVersion}`}
        className="flex min-h-[34px] w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] text-ds-ink transition hover:bg-[var(--ds-sidebar-row-hover)] disabled:cursor-wait disabled:opacity-60"
      >
        <Icon className={`h-4 w-4 shrink-0 ${busy ? 'animate-spin' : ''}`} strokeWidth={1.75} />
        <span aria-live="polite">{label}</span>
      </button>
      {notice ? <div className="px-3 pb-2 text-xs text-ds-muted"><p role="alert" className="break-words">{notice.summary}</p><TechnicalDetails detail={notice.detail} /></div> : null}
    </div>
  )
}
