import type { ReactElement } from 'react'
import { ArrowUpCircle, ExternalLink, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { applyGuiUpdate, useGuiUpdate } from '../../store/gui-update-store'

export function SidebarUpdateControl(): ReactElement | null {
  const { t } = useTranslation(['settings', 'common'])
  const { state, pending, error } = useGuiUpdate()
  const info = state.info
  if (!info?.ok || !info.hasUpdate || info.withdrawn) return null
  const busy = pending || state.status === 'downloading' || state.status === 'installing'
  const Icon = busy ? Loader2 : info.manualOnly ? ExternalLink : ArrowUpCircle
  const label = state.status === 'downloading'
    ? t('guiUpdateCompactDownloading', { percent: Math.min(100, Math.max(0, Math.round(state.progress.percent))) })
    : state.status === 'installing' ? t('guiUpdateCompactInstalling')
      : info.manualOnly ? t('guiUpdateManualDownload') : error ? t('guiUpdateRetry') : t('guiUpdateUpgrade')
  return (
    <div>
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
      {error ? <p role="alert" className="px-3 pb-2 text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  )
}
