import { useState, type ReactElement } from 'react'
import { Copy, Loader2, RefreshCw } from 'lucide-react'
import type { WorkspaceMigrationReport, WorkspaceImportResult } from '@shared/workspace-migration'
import { SettingsCard } from './settings-controls'

export function WorkspaceMigrationCard({ t }: { t: (key: string, options?: Record<string, unknown>) => string }): ReactElement {
  const [report, setReport] = useState<WorkspaceMigrationReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<WorkspaceImportResult | null>(null)

  const scan = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try { setReport(await window.workwise.scanLegacyWorkspaces()) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const snapshot = async (sourceId: string, fingerprint: string): Promise<void> => {
    if (!window.confirm(t('workspaceMigrationConfirm'))) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      setResult(await window.workwise.importLegacyWorkspaceSnapshot({
        sourceId,
        expectedFingerprint: fingerprint,
        confirmed: true,
        idempotencyKey: crypto.randomUUID()
      }))
      await scan()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  return (
    <SettingsCard title={t('workspaceMigrationTitle')} className="mt-6">
      <div className="space-y-3 px-3 py-4">
        <p className="text-[13px] leading-5 text-ds-muted">{t('workspaceMigrationDescription')}</p>
        <button type="button" disabled={busy} onClick={() => void scan()} className="inline-flex min-h-9 items-center gap-2 rounded-md border border-ds-border px-3 text-[13px] font-medium text-ds-ink hover:bg-ds-hover disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {t('workspaceMigrationScan')}
        </button>
        {error ? <p role="alert" className="break-words text-[13px] text-red-700 dark:text-red-300">{error}</p> : null}
        {result ? <p role="status" className="break-words text-[13px] text-ds-muted">{t(`workspaceMigrationResult_${result.status}`)}<code className="mt-1 block break-all">{result.snapshotPath}</code></p> : null}
        {report ? <div className="divide-y divide-ds-border-muted border-y border-ds-border-muted">
          {report.entries.filter(entry => entry.status !== 'missing').map(entry => (
            <div key={entry.id} className="grid min-w-0 gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium text-ds-ink">
                  <span>{t(`workspaceMigrationNamespace_${entry.namespace.slice(1)}`)} · {t(`workspaceMigrationKind_${entry.kind}`)}</span>
                  <span className="text-ds-muted">{t(`workspaceMigrationStatus_${entry.status}`)}</span>
                </div>
                <code className="mt-1 block break-all text-[11px] leading-4 text-ds-muted">{entry.path}</code>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-4 text-ds-faint">
                  <span>{t('workspaceMigrationFiles', { count: entry.fileCount })}</span>
                  {entry.aliasOf ? <span>{t('workspaceMigrationAlias', { id: entry.aliasOf })}</span> : null}
                  {entry.identicalTo ? <span>{t('workspaceMigrationIdentical', { id: entry.identicalTo })}</span> : null}
                  {entry.conflictWith.length ? <span>{t('workspaceMigrationConflict', { ids: entry.conflictWith.join(', ') })}</span> : null}
                  {entry.reason ? <span>{entry.reason}</span> : null}
                </div>
              </div>
              {entry.status === 'populated' && entry.fingerprint ? <button type="button" disabled={busy} onClick={() => void snapshot(entry.id, entry.fingerprint!)} title={t('workspaceMigrationSnapshot')} aria-label={t('workspaceMigrationSnapshot')} className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-ds-border px-3 text-[12px] text-ds-ink hover:bg-ds-hover disabled:opacity-50">
                <Copy className="h-4 w-4" />{t('workspaceMigrationSnapshot')}
              </button> : null}
            </div>
          ))}
          {!report.entries.some(entry => entry.status !== 'missing') ? <p className="py-3 text-[13px] text-ds-muted">{t('workspaceMigrationNone')}</p> : null}
        </div> : null}
      </div>
    </SettingsCard>
  )
}
