import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { rendererRuntimeClient } from '../../agent/runtime-client'

type Suggestion = { id: string; projectId: string; expectedRevision: number; reason: string; before: Record<string, unknown>; patch: Record<string, unknown>; status: 'pending' | 'applied' | 'rejected' | 'stale' }
type Entry = { suggestion: Suggestion; token: string }
type Props = { projectId: string; threadId: string | null; connected: boolean; busy: boolean; refreshKey: number; onRefresh: () => void }

const fieldLabels: Record<string, string> = {
  name: 'engineeringProjectName', taskType: 'engineeringTaskType', taskContext: 'engineeringSuggestionTaskContext',
  monitoringType: 'engineeringSuggestionMonitoringType', unit: 'engineeringUnit', signConvention: 'engineeringSuggestionSign',
  thresholds: 'engineeringSuggestionThresholds', reportPeriod: 'engineeringSuggestionReportPeriod'
}

export function EngineeringProjectSuggestions({ projectId, threadId, connected, busy, refreshKey, onRefresh }: Props): ReactElement | null {
  const { t } = useTranslation('common')
  const [entries, setEntries] = useState<Entry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [acting, setActing] = useState(false)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false
    setEntries([]); setError(null)
    if (!connected || !threadId || busy) return
    const query = new URLSearchParams({ projectId, threadId })
    void rendererRuntimeClient.runtimeRequest(`/v1/engineering/ai/project-suggestions?${query}`).then(response => {
      if (!response.ok) throw new Error(t('engineeringSuggestionReadFailed'))
      const parsed = JSON.parse(response.body) as { suggestions?: Entry[] }
      if (!cancelled) setEntries((parsed.suggestions ?? []).filter(entry => entry.suggestion.projectId === projectId))
    }).catch(() => { if (!cancelled) setError(t('engineeringSuggestionReadFailed')) })
    return () => { cancelled = true }
  }, [projectId, threadId, connected, busy, refreshKey, retry, t])

  const decide = async (entry: Entry, decision: 'apply' | 'reject'): Promise<void> => {
    if (!connected || busy || acting || entry.suggestion.status !== 'pending') return
    setActing(true); setError(null)
    try {
      const response = await rendererRuntimeClient.runtimeRequest(`/v1/engineering/ai/project-suggestions/${encodeURIComponent(entry.suggestion.id)}/decision`, 'POST', JSON.stringify({ token: entry.token, decision }))
      if (!response.ok) throw new Error(response.status === 409 ? t('engineeringSuggestionStale') : t('engineeringSuggestionApplyFailed'))
      const { suggestion } = JSON.parse(response.body) as { suggestion: Suggestion }
      setEntries(current => current.map(item => item.suggestion.id === suggestion.id ? { ...item, suggestion } : item))
      onRefresh()
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('engineeringSuggestionApplyFailed')) } finally { setActing(false) }
  }
  if (!entries.length && !error) return null
  return <section aria-label={t('engineeringSuggestionTitle')} className="max-h-[35%] shrink-0 space-y-3 overflow-y-auto border-t border-ds-border-muted p-3 text-[12px]">
    <h3 className="font-semibold">{t('engineeringSuggestionTitle')}</h3>
    {error ? <p role="alert" className="text-amber-700 dark:text-amber-300">{error} <button type="button" disabled={!connected || busy || acting} onClick={() => setRetry(value => value + 1)} className="underline">{t('engineeringSessionRetry')}</button></p> : null}
    {entries.map(entry => <article key={entry.suggestion.id} data-testid="engineering-project-suggestion" className="space-y-2 border-b border-ds-border-muted pb-3">
      <p className="break-words">{entry.suggestion.reason}</p>
      <p className="text-ds-muted">{t('engineeringSuggestionRevision', { revision: entry.suggestion.expectedRevision })} · {t(`engineeringSuggestionStatus.${entry.suggestion.status}`)}</p>
      <dl className="space-y-2">{Object.entries(entry.suggestion.patch).map(([field, value]) => <div key={field}>
        <dt className="font-medium">{t(fieldLabels[field] ?? field)}</dt>
        <dd className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          <div><span className="text-ds-muted">{t('engineeringSuggestionBefore')}</span><pre className="whitespace-pre-wrap break-all">{JSON.stringify(entry.suggestion.before[field] ?? null, null, 2)}</pre></div>
          <div><span className="text-ds-muted">{t('engineeringSuggestionAfter')}</span><pre className="whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre></div>
        </dd>
      </div>)}</dl>
      <p className="text-ds-muted">{t('engineeringSuggestionImpact')}</p>
      {entry.suggestion.status === 'pending' ? <div className="flex flex-wrap gap-2">
        <button type="button" disabled={!connected || busy || acting} onClick={() => void decide(entry, 'apply')} className="rounded-md bg-accent px-3 py-2 text-white disabled:opacity-50">{t('engineeringSuggestionApply')}</button>
        <button type="button" disabled={!connected || busy || acting} onClick={() => void decide(entry, 'reject')} className="rounded-md border border-ds-border-muted px-3 py-2 disabled:opacity-50">{t('engineeringSuggestionReject')}</button>
      </div> : null}
    </article>)}
  </section>
}
