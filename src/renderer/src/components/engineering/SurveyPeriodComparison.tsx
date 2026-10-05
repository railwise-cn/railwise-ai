import { surveyObservationDisplayLabel } from './survey-professional-labels'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowDown, ArrowUp, CheckCircle2, FileOutput, GitCompareArrows, History, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SurveyInitialValueChangeRequestV1, SurveyInitialValueEventV1, SurveySegmentComparisonRequestV1, SurveySegmentComparisonV1 } from '@shared/survey-monitoring'
import { SurveyProfessionalReviewV1 } from '@shared/survey-professional'
import { rendererRuntimeClient } from '../../agent/runtime-client'

type PeriodAdjustment = { run: { id: string; networkId: string }; result: { id: string }; observationEpoch?: string }
type Segment = { id: string; from: string; to: string; referenceObservationIds: string[]; currentObservationIds: string[] }
type ReviewRecord = { binding: string; review: SurveyProfessionalReviewV1 }
type HistoryRecord = { context: string; state: 'loading' | 'loaded' | 'failed'; events: SurveyInitialValueEventV1[] }
type Operation = { context: string; token: number }
const controlClass = 'mt-1 min-h-11 w-full rounded-md border border-ds-border bg-ds-card px-2 text-[12px] text-ds-ink disabled:opacity-50'
const newSegment = (id: string): Segment => ({ id, from: '', to: '', referenceObservationIds: [], currentObservationIds: [] })

async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
  const response = await rendererRuntimeClient.runtimeRequest(path, method, body === undefined ? undefined : JSON.stringify(body))
  if (!response.ok) throw new Error(response.body || `Request failed (${response.status})`)
  return JSON.parse(response.body) as T
}

export function SurveyPeriodComparison({ projectId, runtimeReady, adjustments, onExport }: { projectId: string; runtimeReady: boolean; adjustments: PeriodAdjustment[]; onExport?: (comparison: SurveySegmentComparisonV1) => Promise<void> }): ReactElement {
  const { t, i18n } = useTranslation('common')
  const ordered = useMemo(() => [...adjustments].sort((left, right) => Date.parse(left.observationEpoch ?? '') - Date.parse(right.observationEpoch ?? '')), [adjustments])
  const context = JSON.stringify([projectId, runtimeReady, ordered])
  const liveContext = useRef(context)
  liveContext.current = context
  const mounted = useRef(true)
  const nextSegment = useRef(2)
  const nextOperation = useRef(0)
  const activeOperation = useRef<Operation | null>(null)
  const [operation, setOperation] = useState<Operation | null>(null)
  const busy = operation?.context === context
  const [referenceId, setReferenceId] = useState(ordered[0]?.run.id ?? '')
  const [currentId, setCurrentId] = useState(ordered.at(-1)?.run.id ?? '')
  const [referenceRecord, setReferenceRecord] = useState<ReviewRecord | null>(null)
  const [currentRecord, setCurrentRecord] = useState<ReviewRecord | null>(null)
  const [segments, setSegments] = useState<Segment[]>([newSegment('segment-1')])
  const [comparisonRecord, setComparisonRecord] = useState<{ context: string; selection: string; comparison: SurveySegmentComparisonV1 } | null>(null)
  const [history, setHistory] = useState<HistoryRecord | null>(null)
  const [historyReload, setHistoryReload] = useState(0)
  const [initialAdjustmentId, setInitialAdjustmentId] = useState('')
  const [initialReason, setInitialReason] = useState('')
  const [notice, setNotice] = useState<{ context: string; key: string } | null>(null)
  const selectedReference = ordered.find(item => item.run.id === referenceId)
  const selectedCurrent = ordered.find(item => item.run.id === currentId)
  const referenceBinding = JSON.stringify([context, referenceId])
  const currentBinding = JSON.stringify([context, currentId])
  const referenceReview = referenceRecord?.binding === referenceBinding ? referenceRecord.review : null
  const currentReview = currentRecord?.binding === currentBinding ? currentRecord.review : null
  const referenceObservations = referenceReview?.observations.filter(item => item.type === 'height-difference' && item.unit === 'm' && item.sourceRecordId && item.observed !== undefined && item.adjusted !== undefined) ?? []
  const currentObservations = currentReview?.observations.filter(item => item.type === 'height-difference' && item.unit === 'm' && item.sourceRecordId && item.observed !== undefined && item.adjusted !== undefined) ?? []
  const routeOptions = [...new Set([...referenceObservations, ...currentObservations].flatMap(item => [item.from, item.to]).filter((value): value is string => Boolean(value)))]
  const events = history?.context === context ? history.events : []
  const historyReady = history?.context === context && history.state === 'loaded'
  const selection = JSON.stringify([referenceId, currentId, segments])
  const comparison = comparisonRecord?.context === context && comparisonRecord.selection === selection ? comparisonRecord.comparison : null

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; activeOperation.current = null } }, [])
  useEffect(() => {
    activeOperation.current = null; setOperation(null)
    setReferenceId(ordered[0]?.run.id ?? ''); setCurrentId(ordered.at(-1)?.run.id ?? '')
    setReferenceRecord(null); setCurrentRecord(null); setComparisonRecord(null)
    setSegments([newSegment('segment-1')]); nextSegment.current = 2
    setInitialAdjustmentId(''); setInitialReason(''); setNotice(null)
    // Admission, source and result changes invalidate the confirmed comparison.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context])

  useEffect(() => {
    let cancelled = false
    if (!runtimeReady) { setHistory(null); return }
    setHistory({ context, state: 'loading', events: [] })
    void request<{ events: unknown[] }>(`/v1/engineering/projects/${encodeURIComponent(projectId)}/survey/initial-values`, 'GET').then(value => {
      const parsed = value.events.map(event => SurveyInitialValueEventV1.parse(event))
      if (parsed.some(event => event.projectId !== projectId)) throw new Error('Initial-value history project mismatch')
      if (!cancelled && liveContext.current === context) setHistory({ context, state: 'loaded', events: parsed })
    }).catch(error => {
      if (!cancelled && liveContext.current === context) {
        setHistory({ context, state: 'failed', events: [] })
        setNotice({ context, key: 'surveyInitialValueHistoryFailed' })
      }
    })
    return () => { cancelled = true }
  }, [context, projectId, runtimeReady, historyReload])

  useEffect(() => {
    let cancelled = false
    const load = async (adjustment: PeriodAdjustment | undefined, binding: string, setter: (record: ReviewRecord | null) => void): Promise<void> => {
      setter(null)
      if (!adjustment || !runtimeReady) return
      try {
        const value = await request<{ review: unknown }>(`/v1/engineering/adjustments/${encodeURIComponent(adjustment.run.id)}/professional-review`, 'GET')
        const review = SurveyProfessionalReviewV1.parse(value.review)
        if (review.projectId !== projectId || review.runId !== adjustment.run.id || review.resultId !== adjustment.result.id || review.networkId !== adjustment.run.networkId
          || review.source.status !== 'bound' || review.source.integrity !== 'verified' || review.reference.status !== 'declared'
          || review.summary.validation !== 'valid' || review.summary.networkType !== 'leveling') throw new Error('Survey period does not match an eligible leveling result')
        if (!cancelled && liveContext.current === context) setter({ binding, review })
      } catch { if (!cancelled && liveContext.current === context) setter(null) }
    }
    void load(selectedReference, referenceBinding, setReferenceRecord)
    void load(selectedCurrent, currentBinding, setCurrentRecord)
    return () => { cancelled = true }
  }, [context, projectId, runtimeReady, selectedReference, selectedCurrent, referenceBinding, currentBinding])

  const editingBlocked = (): boolean => Boolean(activeOperation.current?.context === context) || !runtimeReady
  const invalidate = (): void => { setComparisonRecord(null); setNotice(null) }
  const updateSegment = (id: string, update: Partial<Segment>): void => {
    if (editingBlocked()) return
    setSegments(items => items.map(segment => segment.id === id ? { ...segment, ...update } : segment)); invalidate()
  }
  const begin = (): Operation => {
    const value = { context, token: ++nextOperation.current }; activeOperation.current = value; setOperation(value); setNotice(null); return value
  }
  const isCurrent = (value: Operation): boolean => mounted.current && liveContext.current === value.context && activeOperation.current?.token === value.token
  const finish = (value: Operation): void => { if (isCurrent(value)) { activeOperation.current = null; setOperation(null) } }
  const compare = async (): Promise<void> => {
    if (editingBlocked() || !referenceReview || !currentReview) return
    const parsed = SurveySegmentComparisonRequestV1.safeParse({ referenceAdjustmentId: referenceId, currentAdjustmentId: currentId, segments, idempotencyKey: `segment-comparison-${crypto.randomUUID()}` })
    if (!parsed.success || referenceId === currentId || !selectedReference?.observationEpoch || !selectedCurrent?.observationEpoch
      || Date.parse(selectedCurrent.observationEpoch) <= Date.parse(selectedReference.observationEpoch)) { setNotice({ context, key: 'surveyPeriodComparisonRequired' }); return }
    const pending = begin()
    try {
      const value = await request<{ comparison: unknown }>(`/v1/engineering/projects/${encodeURIComponent(projectId)}/survey/segment-comparisons`, 'POST', parsed.data)
      const result = SurveySegmentComparisonV1.parse(value.comparison)
      if (result.projectId !== projectId || result.referenceAdjustmentId !== referenceId || result.currentAdjustmentId !== currentId
        || result.referenceEpoch !== selectedReference.observationEpoch || result.currentEpoch !== selectedCurrent.observationEpoch
        || result.referenceResultHash !== referenceReview.resultHash || result.currentResultHash !== currentReview.resultHash
        || result.referenceProjectionHash !== referenceReview.projectionHash || result.currentProjectionHash !== currentReview.projectionHash
        || JSON.stringify(result.segments.map(({ id, from, to, referenceObservationIds, currentObservationIds }) => ({ id, from, to, referenceObservationIds, currentObservationIds }))) !== JSON.stringify(parsed.data.segments)) throw new Error('Segment comparison response does not match the selected inputs')
      if (isCurrent(pending)) { setComparisonRecord({ context, selection, comparison: result }); setNotice({ context, key: 'surveyPeriodComparisonDone' }) }
    } catch { if (isCurrent(pending)) setNotice({ context, key: 'surveyPeriodOperationFailed' }) } finally { finish(pending) }
  }
  const exportComparison = async (): Promise<void> => {
    if (editingBlocked() || !comparison || !onExport) return
    const pending = begin()
    try { await onExport(comparison) }
    catch { if (isCurrent(pending)) setNotice({ context, key: 'surveyPeriodOperationFailed' }) }
    finally { finish(pending) }
  }
  const changeInitialValue = async (): Promise<void> => {
    if (editingBlocked() || !historyReady) return
    const selected = ordered.find(item => item.run.id === initialAdjustmentId)
    const previous = events.at(-1)
    const parsed = SurveyInitialValueChangeRequestV1.safeParse({ adjustmentId: initialAdjustmentId, expectedPreviousEventId: previous?.id ?? null, reason: initialReason.trim(), confirmed: true, idempotencyKey: `initial-value-${crypto.randomUUID()}` })
    if (!parsed.success || !selected) { setNotice({ context, key: 'surveyInitialValueRequired' }); return }
    const pending = begin()
    try {
      const value = await request<{ event: unknown }>(`/v1/engineering/projects/${encodeURIComponent(projectId)}/survey/initial-values`, 'POST', parsed.data)
      const event = SurveyInitialValueEventV1.parse(value.event)
      if (event.projectId !== projectId || event.adjustmentId !== selected.run.id || event.resultId !== selected.result.id || event.reason !== parsed.data.reason
        || event.previousEventId !== parsed.data.expectedPreviousEventId || event.previousHash !== (previous?.eventHash ?? null)) throw new Error('Initial-value response does not match the confirmed change')
      if (isCurrent(pending)) {
        setHistory({ context, state: 'loaded', events: [...events.filter(item => item.id !== event.id), event] })
        setInitialReason(''); setNotice({ context, key: 'surveyInitialValueSaved' })
      }
    } catch {
      if (isCurrent(pending)) {
        setNotice({ context, key: 'surveyPeriodOperationFailed' })
        setHistoryReload(value => value + 1)
      }
    } finally { finish(pending) }
  }
  const controlsDisabled = busy || !runtimeReady
  const comparisonReady = Boolean(referenceReview && currentReview && referenceId !== currentId && segments.every(segment => segment.from && segment.to && segment.referenceObservationIds.length && segment.currentObservationIds.length))

  return <section className="mt-4 border-t border-ds-border-muted bg-ds-card py-4" aria-label={t('surveyPeriodComparisonTitle')} aria-busy={busy}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="flex items-center gap-2 text-[13px] font-semibold"><GitCompareArrows className="h-4 w-4 text-accent" />{t('surveyPeriodComparisonTitle')}</h4><p className="mt-1 text-[12px] text-ds-muted">{t('surveyPeriodComparisonHint')}</p></div><button type="button" onClick={() => void compare()} disabled={controlsDisabled || !comparisonReady} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-3 text-[12px] font-semibold text-white disabled:opacity-50"><CheckCircle2 aria-hidden="true" className="h-4 w-4" />{t('surveyPeriodCompare')}</button></div>
    {!runtimeReady ? <p role="status" className="mt-3 text-[12px] text-ds-muted">{t('surveyProfessionalOffline')}</p> : null}
    {busy ? <p role="status" className="mt-3 text-[12px] text-ds-muted">{t('surveyProcessing')}</p> : null}
    {comparison && onExport ? <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><p className="text-[12px] text-ds-muted">{t('surveyPeriodExportScope', { reference: comparison.referenceEpoch, current: comparison.currentEpoch, count: comparison.segments.length })}</p><button type="button" disabled={controlsDisabled} onClick={() => void exportComparison()} className="inline-flex min-h-11 items-center gap-2 rounded-md bg-accent px-3 text-[12px] font-semibold text-white disabled:opacity-50"><FileOutput aria-hidden="true" className="h-4 w-4" />{t('surveyPeriodExport')}</button></div> : null}
    {comparison?.rawObservationCongruence ? <section className="mt-3 border border-ds-border-muted bg-ds-subtle px-3 py-2.5" aria-label={t('surveyRawCongruenceTitle')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><p className="text-[11px] font-semibold text-ds-ink">{t('surveyRawCongruenceTitle')}</p><p className="mt-0.5 text-[10.5px] text-ds-muted">{t('surveyRawCongruenceHint')}</p></div>
        <span className={`text-[11px] font-medium ${comparison.rawObservationCongruence.status === 'unavailable' ? 'text-amber-700 dark:text-amber-300' : 'text-ds-ink'}`}>
          {t(`surveyRawCongruenceStatus.${comparison.rawObservationCongruence.status}`)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-ds-muted">
        <span>{t('surveyRawCongruenceScope')}</span>
        {comparison.rawObservationCongruence.meanObservedChangeMetres !== undefined ? <span>{t('surveyRawCongruenceMean', { value: comparison.rawObservationCongruence.meanObservedChangeMetres.toFixed(6) })}</span> : null}
        {comparison.rawObservationCongruence.maximumResidualMetres !== undefined && comparison.rawObservationCongruence.toleranceMetres !== undefined ? <span>{t('surveyRawCongruenceResidual', { residual: comparison.rawObservationCongruence.maximumResidualMetres.toFixed(6), tolerance: comparison.rawObservationCongruence.toleranceMetres.toFixed(6) })}</span> : null}
        {comparison.rawObservationCongruence.reason ? <span>{t(`surveyRawCongruenceReason.${comparison.rawObservationCongruence.reason}`)}</span> : null}
      </div>
    </section> : null}
    <fieldset disabled={controlsDisabled} className="mt-4 grid gap-3 sm:grid-cols-2"><PeriodSelect label={t('surveyReferenceEpoch')} periods={ordered} value={referenceId} onChange={value => { if (!editingBlocked()) { setReferenceId(value); setSegments([newSegment(`segment-${nextSegment.current++}`)]); invalidate() } }} /><PeriodSelect label={t('surveyCurrentEpoch')} periods={ordered} value={currentId} onChange={value => { if (!editingBlocked()) { setCurrentId(value); setSegments([newSegment(`segment-${nextSegment.current++}`)]); invalidate() } }} /></fieldset>
    {runtimeReady && (!referenceReview || !currentReview) ? <p role="status" className="mt-3 text-[12px] text-ds-muted">{t('surveyPeriodObservationsPending')}</p> : null}
    <fieldset disabled={controlsDisabled} className="mt-4 space-y-3">{segments.map((segment, index) => <div key={segment.id} data-segment-id={segment.id} className="rounded-md border border-ds-border-muted bg-ds-main p-3"><div className="flex items-center justify-between gap-2"><p className="text-[12px] font-medium">{t('surveyPeriodSegmentNumber', { number: index + 1 })}</p><button type="button" disabled={segments.length < 2 || controlsDisabled} aria-label={t('surveyPeriodRemoveSegment', { number: index + 1 })} title={t('surveyPeriodRemoveSegment', { number: index + 1 })} onClick={() => { if (!editingBlocked()) { setSegments(items => items.filter(item => item.id !== segment.id)); invalidate() } }} className="inline-flex h-11 w-11 items-center justify-center text-ds-muted disabled:opacity-40"><Trash2 aria-hidden="true" className="h-4 w-4" /></button></div><div className="mt-2 grid gap-3 sm:grid-cols-2"><label className="text-[12px]">{t('surveySegmentFrom')}<select aria-label={t('surveySegmentFrom')} value={segment.from} onChange={event => updateSegment(segment.id, { from: event.target.value })} className={controlClass}><option value="">{t('surveyChoose')}</option>{routeOptions.map(option => <option key={option} value={option}>{option}</option>)}</select></label><label className="text-[12px]">{t('surveySegmentTo')}<select aria-label={t('surveySegmentTo')} value={segment.to} onChange={event => updateSegment(segment.id, { to: event.target.value })} className={controlClass}><option value="">{t('surveyChoose')}</option>{routeOptions.map(option => <option key={option} value={option}>{option}</option>)}</select></label><ObservationSelect label={t('surveyReferenceObservations')} observations={referenceObservations} value={segment.referenceObservationIds} disabled={controlsDisabled} onChange={value => updateSegment(segment.id, { referenceObservationIds: value })} /><ObservationSelect label={t('surveyCurrentObservations')} observations={currentObservations} value={segment.currentObservationIds} disabled={controlsDisabled} onChange={value => updateSegment(segment.id, { currentObservationIds: value })} /></div></div>)}<button type="button" disabled={controlsDisabled || segments.length >= 100} onClick={() => { if (!editingBlocked()) { setSegments(items => [...items, newSegment(`segment-${nextSegment.current++}`)]); invalidate() } }} className="inline-flex min-h-11 items-center gap-2 rounded-md border border-ds-border px-3 text-[12px] disabled:opacity-50"><Plus aria-hidden="true" className="h-4 w-4" />{t('surveyAddSegment')}</button></fieldset>
    {comparison ? <div role="region" tabIndex={0} aria-label={t('surveyPeriodComparisonResults')} className="mt-4 overflow-x-auto border border-ds-border-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><table className="min-w-[780px] text-left text-[12px]"><thead className="bg-ds-subtle"><tr><th className="px-3 py-2">{t('surveyPeriodSegment')}</th><th className="px-3 py-2">{t('surveyPeriodReference')}</th><th className="px-3 py-2">{t('surveyPeriodCurrent')}</th><th className="px-3 py-2">{t('surveyPeriodChange')}</th><th className="px-3 py-2">{t('surveyProfessionalStandards')}</th></tr></thead><tbody className="divide-y divide-ds-border-muted">{comparison.segments.map(segment => <tr key={segment.id}><td className="px-3 py-2 font-medium">{segment.from} → {segment.to}</td><td className="px-3 py-2 tabular-nums">{segment.referenceObservedMetres.toFixed(6)} / {segment.referenceAdjustedMetres.toFixed(6)}</td><td className="px-3 py-2 tabular-nums">{segment.currentObservedMetres.toFixed(6)} / {segment.currentAdjustedMetres.toFixed(6)}</td><td className="px-3 py-2 tabular-nums">{segment.observedChangeMetres.toFixed(6)} / {segment.adjustedChangeMetres.toFixed(6)}</td><td className="px-3 py-2 text-ds-muted">{t('surveyProfessionalNotEvaluated')}</td></tr>)}</tbody></table></div> : null}
    <section className="mt-5 border-t border-ds-border-muted pt-4"><h5 className="flex items-center gap-2 text-[13px] font-semibold"><Save className="h-4 w-4 text-accent" />{t('surveyInitialValueTitle')}</h5><p className="mt-1 text-[12px] text-ds-muted">{t('surveyInitialValueHint')}</p><fieldset disabled={controlsDisabled || !historyReady} className="mt-3 grid items-end gap-3 sm:grid-cols-2"><PeriodSelect label={t('surveyAdjustment')} periods={ordered} value={initialAdjustmentId} onChange={value => { if (!editingBlocked()) setInitialAdjustmentId(value) }} placeholder /><label className="text-[12px]">{t('surveyInitialValueReason')}<textarea aria-label={t('surveyInitialValueReason')} maxLength={500} value={initialReason} onChange={event => { if (!editingBlocked()) setInitialReason(event.target.value) }} className={`${controlClass} min-h-20 p-2`} /></label><button type="button" onClick={() => void changeInitialValue()} disabled={controlsDisabled || !historyReady || !initialAdjustmentId || !initialReason.trim()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-accent/40 px-3 text-[12px] font-semibold text-accent disabled:opacity-50 sm:col-start-2"><Save aria-hidden="true" className="h-4 w-4" />{t('surveyInitialValueConfirm')}</button></fieldset><div className="mt-4"><div className="flex items-center justify-between gap-2 border-b border-ds-border-muted py-2"><h5 className="flex items-center gap-2 text-[12px] font-semibold"><History className="h-4 w-4 text-accent" />{t('surveyInitialValueHistory')}</h5><button type="button" disabled={controlsDisabled} onClick={() => { if (!editingBlocked()) setHistoryReload(value => value + 1) }} className="inline-flex min-h-11 items-center gap-2 px-2 text-[12px] text-accent disabled:opacity-50"><RefreshCw aria-hidden="true" className="h-4 w-4" />{t('surveyInitialValueReload')}</button></div>{events.length ? <div className="divide-y divide-ds-border-muted">{events.map(event => <div key={event.id} data-initial-value-event={event.id} className="py-3 text-[12px]"><p className="font-medium">{new Date(event.createdAt).toLocaleString(i18n.language.startsWith('en') ? 'en-US' : 'zh-CN')} · {event.reason}</p><p className="mt-1 text-ds-muted">{ordered.find(item => item.run.id === event.adjustmentId)?.observationEpoch ?? t('surveyInitialValueHistoricalPeriod')} · {t('surveyInitialValueUserConfirmed')} · {t('surveyProfessionalUnsigned')}</p></div>)}</div> : <p role="status" className="py-3 text-[12px] text-ds-muted">{t(historyReady ? 'surveyInitialValueEmpty' : history?.context === context && history.state === 'failed' ? 'surveyInitialValueHistoryFailed' : 'surveyInitialValueHistoryLoading')}</p>}</div></section>
    {notice?.context === context ? <div role="status" aria-live="polite" className="mt-3 border-l-2 border-accent bg-ds-subtle px-3 py-2 text-[12px] text-ds-muted"><p>{t(notice.key)}</p></div> : null}
  </section>
}

function PeriodSelect({ label, periods, value, onChange, placeholder = false }: { label: string; periods: PeriodAdjustment[]; value: string; onChange: (value: string) => void; placeholder?: boolean }): ReactElement { const { t } = useTranslation('common'); return <label className="text-[12px] font-medium">{label}<select aria-label={label} value={value} onChange={event => onChange(event.target.value)} className={controlClass}>{placeholder ? <option value="">{t('surveyChoose')}</option> : null}{periods.map(item => <option key={item.run.id} value={item.run.id}>{item.observationEpoch ?? t('surveyInitialValueHistoricalPeriod')}</option>)}</select></label> }
function ObservationSelect({ label, observations, value, disabled, onChange }: { label: string; observations: Array<{ observationId: string; from?: string; to?: string; type?: string; sourceRow?: number; observed?: number }>; value: string[]; disabled: boolean; onChange: (value: string[]) => void }): ReactElement {
  const { t, i18n } = useTranslation('common')
  const observationLabel = (id: string): string => surveyObservationDisplayLabel({ ...observations.find(item => item.observationId === id), observationId: id, sequence: observations.findIndex(item => item.observationId === id) + 1 }, i18n.language)
  const [candidate, setCandidate] = useState('')
  const available = observations.filter(item => !value.includes(item.observationId))
  const selectedCandidate = available.some(item => item.observationId === candidate) ? candidate : ''
  const move = (index: number, offset: number): void => { if (disabled || index + offset < 0 || index + offset >= value.length) return; const reordered = [...value]; [reordered[index], reordered[index + offset]] = [reordered[index + offset], reordered[index]]; onChange(reordered) }
  return <div><label className="text-[12px]">{label}<select aria-label={label} value={selectedCandidate} disabled={disabled} onChange={event => { if (!disabled) setCandidate(event.target.value) }} className={controlClass}><option value="">{t('surveyChoose')}</option>{available.map(item => <option key={item.observationId} value={item.observationId}>{observationLabel(item.observationId)} · {item.observed ?? '—'} m</option>)}</select></label><button type="button" disabled={disabled || !selectedCandidate} aria-label={t('surveyPeriodAddObservation', { period: label })} onClick={() => { if (!disabled && selectedCandidate) { onChange([...value, selectedCandidate]); setCandidate('') } }} className="mt-1 inline-flex min-h-11 items-center gap-2 px-2 text-[12px] text-accent disabled:opacity-40"><Plus aria-hidden="true" className="h-4 w-4" />{t('surveyPeriodAppendObservation')}</button><ol className="divide-y divide-ds-border-muted">{value.map((id, index) => <li key={id} className="flex items-center gap-2 text-[12px]"><span className="min-w-0 flex-1 break-words">{index + 1}. {observationLabel(id)}</span><button type="button" disabled={disabled || index === 0} aria-label={t('surveyPeriodMoveObservationUp', { id: observationLabel(id) })} title={t('surveyPeriodMoveObservationUp', { id: observationLabel(id) })} onClick={() => move(index, -1)} className="inline-flex h-11 w-11 items-center justify-center text-ds-muted disabled:opacity-30"><ArrowUp aria-hidden="true" className="h-4 w-4" /></button><button type="button" disabled={disabled || index === value.length - 1} aria-label={t('surveyPeriodMoveObservationDown', { id: observationLabel(id) })} title={t('surveyPeriodMoveObservationDown', { id: observationLabel(id) })} onClick={() => move(index, 1)} className="inline-flex h-11 w-11 items-center justify-center text-ds-muted disabled:opacity-30"><ArrowDown aria-hidden="true" className="h-4 w-4" /></button><button type="button" disabled={disabled} aria-label={t('surveyPeriodRemoveObservation', { id: observationLabel(id) })} title={t('surveyPeriodRemoveObservation', { id: observationLabel(id) })} onClick={() => { if (!disabled) onChange(value.filter(item => item !== id)) }} className="inline-flex h-11 w-11 items-center justify-center text-ds-muted disabled:opacity-30"><Trash2 aria-hidden="true" className="h-4 w-4" /></button></li>)}</ol></div>
}
