import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { engineeringProfessionalText } from './engineering-professional-text'
import { engineeringTaskLabel, engineeringTaskTypes } from './engineering-task-types'

type Suggestion = { id: string; projectId: string; expectedRevision: number; reason: string; before: Record<string, unknown>; patch: Record<string, unknown>; status: 'pending' | 'applied' | 'rejected' | 'stale' }
type Entry = { suggestion: Suggestion; token: string }
type Props = { projectId: string; threadId: string | null; connected: boolean; busy: boolean; refreshKey: number; onRefresh: () => void }

const fieldLabels: Record<string, string> = {
  name: 'engineeringProjectName', taskType: 'engineeringTaskType', taskContext: 'engineeringSuggestionTaskContext',
  monitoringType: 'engineeringSuggestionMonitoringType', unit: 'engineeringUnit', signConvention: 'engineeringSuggestionSign',
  thresholds: 'engineeringSuggestionThresholds', reportPeriod: 'engineeringSuggestionReportPeriod'
}

const contextFieldKeys = new Set(['coordinateSystem', 'verticalDatum', 'networkType', 'measurementGrade', 'standard', 'standardVersion', 'standardClause'])
const visibleSuggestionFields = new Set([...Object.keys(fieldLabels), ...contextFieldKeys])
const visibleNestedKeys = new Set([
  'coordinateSystem', 'verticalDatum', 'networkType', 'measurementGrade', 'standard', 'standardVersion', 'standardClause',
  'warning', 'alarm', 'control', 'normal', 'limit', 'value', 'unit', 'enabled'
])

// A project patch is runtime data. Keep unknown fields out of the work
// surface so implementation metadata cannot become user-facing by accident.
function suggestionValue(value: unknown, t: ReturnType<typeof useTranslation>['t'], field?: string, depth = 0): string {
  if (depth > 4) return '—'
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') {
    if (field === 'taskType') return engineeringTaskTypes.includes(value as typeof engineeringTaskTypes[number]) ? engineeringTaskLabel(value, t) : '—'
    if (field === 'signConvention') {
      const key = ({ positive: 'engineeringSignPositiveOption', negative: 'engineeringSignNegativeOption', custom: 'engineeringSignCustomOption' } as Record<string, string>)[value]
      return key ? t(key) : '—'
    }
    const cleaned = engineeringProfessionalText(value)
    if (cleaned) return cleaned
    // Human-entered project values such as a short project name can be
    // neutral rather than survey terminology. Preserve those values after
    // the implementation-vocabulary filter instead of rendering an empty
    // placeholder; structured/internal strings remain hidden.
    return /^[\p{L}\p{N}][\p{L}\p{N} _.,()（）-]{0,79}$/u.test(value) && !/[=/:`{}[\]]/.test(value)
      ? value
      : '—'
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—'
  if (typeof value === 'boolean') return engineeringProfessionalText(String(value))
  if (Array.isArray(value)) return value.map(item => suggestionValue(item, t, undefined, depth + 1)).filter(item => item !== '—').join('、') || '—'
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => visibleNestedKeys.has(key))
      .map(([key, item]) => `${suggestionKey(key)}: ${suggestionValue(item, t, key, depth + 1)}`)
      .filter(entry => !entry.endsWith(': —'))
      .join('；')
  }
  return String(value)
}

function suggestionKey(key: string): string {
  const labels: Record<string, string> = {
    coordinateSystem: '平面坐标系统',
    verticalDatum: '高程基准',
    networkType: '网型',
    measurementGrade: '测量等级',
    standard: '采用规范',
    standardVersion: '规范版本',
    standardClause: '规范条款',
    reportPeriod: '报告周期',
    warning: '预警阈值',
    alarm: '报警阈值',
    control: '控制阈值',
    normal: '正常范围',
    limit: '限差',
    value: '数值',
    unit: '单位',
    enabled: '启用'
  }
  return labels[key] ?? (engineeringProfessionalText(key) || '项目设置')
}

export function EngineeringProjectSuggestions({ projectId, threadId, connected, busy, refreshKey, onRefresh }: Props): ReactElement | null {
  const { t } = useTranslation('common')
  const suggestionFieldLabel = (field: string): string => fieldLabels[field]
    ? t(fieldLabels[field]!)
    : contextFieldKeys.has(field)
      ? t(`engineeringTaskContext.${field}`)
      : suggestionKey(field)
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
    } catch { setError(t('engineeringSuggestionApplyFailed')) } finally { setActing(false) }
  }
  if (!entries.length && !error) return null
  return <section aria-label={t('engineeringSuggestionTitle')} className="max-h-[35%] shrink-0 space-y-3 overflow-y-auto border-t border-ds-border-muted p-3 text-[12px]">
    <h3 className="font-semibold">{t('engineeringSuggestionTitle')}</h3>
    {error ? <p role="alert" className="text-amber-700 dark:text-amber-300">{error} <button type="button" disabled={!connected || busy || acting} onClick={() => setRetry(value => value + 1)} className="underline">{t('engineeringSessionRetry')}</button></p> : null}
    {entries.map(entry => <article key={entry.suggestion.id} data-testid="engineering-project-suggestion" className="space-y-2 border-b border-ds-border-muted pb-3">
      <p className="break-words">{engineeringProfessionalText(entry.suggestion.reason)}</p>
      <p className="text-ds-muted">{t(`engineeringSuggestionStatus.${entry.suggestion.status}`)}</p>
      <dl className="space-y-2">{Object.entries(entry.suggestion.patch).filter(([field]) => visibleSuggestionFields.has(field)).map(([field, value]) => <div key={field}>
        <dt className="font-medium">{suggestionFieldLabel(field)}</dt>
        <dd className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          <div><span className="text-ds-muted">{t('engineeringSuggestionBefore')}</span><p className="whitespace-pre-wrap break-words">{suggestionValue(entry.suggestion.before[field], t, field)}</p></div>
          <div><span className="text-ds-muted">{t('engineeringSuggestionAfter')}</span><p className="whitespace-pre-wrap break-words">{suggestionValue(value, t, field)}</p></div>
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
