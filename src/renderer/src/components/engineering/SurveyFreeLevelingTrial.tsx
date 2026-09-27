import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SurveyFreeLevelingTrialListV1, SurveyFreeLevelingTrialV1 } from '@shared/survey-free-leveling'
import { createFreeLevelingTrial, listFreeLevelingTrials, readFreeLevelingTrial, FreeLevelingRequestError, type FreeLevelingBinding } from '../../agent/survey-free-leveling-client'
import { EngineeringEvidenceQuestion, EngineeringSelectedEvidence } from './EngineeringEvidenceQuestion'

type Props = {
  binding: FreeLevelingBinding | null
  contextRevision: number
  runtimeReady: boolean
  eligible: boolean
  renderSourceRecord: (id: string, dismiss: () => void) => ReactNode
}
const number = (value: number): string => Number(value.toPrecision(10)).toString()
const buttonClass = 'min-h-9 border border-ds-border px-3 py-2 text-left text-[11px] hover:bg-ds-hover disabled:opacity-50'
function canFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = window.getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
  }
  return true
}
const errorLabels: Record<string, string> = {
  stale: 'surveyFreeStale', 'invalid-response': 'surveyFreeInvalid', unavailable: 'surveyFreeUnavailable',
  'source-ineligible': 'surveyFreeSourceIneligible', 'unsupported-network': 'surveyFreeUnsupportedNetwork',
  'unsupported-observations': 'surveyFreeUnsupportedObservations', 'mixed-weights': 'surveyFreeMixedWeights',
  'dimension-limit': 'surveyFreeDimensionLimit', 'idempotency-conflict': 'surveyFreeIdempotencyConflict',
  'numeric-unresolved': 'surveyFreeNumericUnresolved', 'disconnected-network': 'surveyFreeDisconnected',
  'insufficient-redundancy': 'surveyFreeInsufficientRedundancy'
}

export function SurveyFreeLevelingTrial({ binding, contextRevision, runtimeReady, eligible, renderSourceRecord }: Props): ReactElement {
  const { t } = useTranslation('common')
  const scope = JSON.stringify([binding, contextRevision, runtimeReady, eligible])
  const activeScope = useRef(scope)
  activeScope.current = scope
  const generation = useRef(0)
  const inFlight = useRef(false)
  const attempt = useRef<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState(false)
  const [focusCompletion, setFocusCompletion] = useState(0)
  const [error, setError] = useState('')
  const [trial, setTrial] = useState<{ scope: string; value: SurveyFreeLevelingTrialV1 } | null>(null)
  const [history, setHistory] = useState<{ scope: string; offset: number; value: SurveyFreeLevelingTrialListV1 } | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const sourcePanel = useRef<HTMLDivElement>(null)
  const sourceTrigger = useRef<{ scope: string; button: HTMLButtonElement } | null>(null)
  const historyButton = useRef<HTMLButtonElement>(null)
  const focusAnchor = useRef<HTMLHeadingElement>(null)
  const pendingHistoryFocus = useRef<{ scope: string; operation: number } | null>(null)
  useEffect(() => {
    generation.current += 1
    inFlight.current = false
    attempt.current = null
    sourceTrigger.current = null
    pendingHistoryFocus.current = null
    setAcknowledged(false); setBusy(false); setError(''); setTrial(null); setHistory(null); setSourceId(null)
    return () => { generation.current += 1 }
  }, [scope])
  useEffect(() => {
    if (sourceId && activeScope.current === scope && sourceTrigger.current?.scope === scope && canFocus(sourcePanel.current)) sourcePanel.current.focus()
  }, [sourceId, scope])
  useEffect(() => {
    const pending = pendingHistoryFocus.current
    if (busy || !pending) return
    pendingHistoryFocus.current = null
    // Restore only if the user has not moved elsewhere while the request ran.
    if (pending.scope === scope && activeScope.current === scope && pending.operation === generation.current
      && document.activeElement === focusAnchor.current && canFocus(historyButton.current) && !historyButton.current.disabled) historyButton.current.focus()
  }, [busy, scope, focusCompletion])
  const ready = !!binding && runtimeReady && eligible
  const current = ready && trial?.scope === scope ? trial.value : null
  const page = ready && history?.scope === scope ? history.value : null

  async function run(action: 'create' | 'list' | 'restore', offset = 0, id?: string): Promise<void> {
    if (!binding || !ready || inFlight.current || (action === 'create' && !acknowledged)) return
    inFlight.current = true
    const operation = ++generation.current
    const stillCurrent = (): boolean => activeScope.current === scope && generation.current === operation
    if (action !== 'create' && canFocus(focusAnchor.current)) {
      // Paging and restore remove the clicked history button. Keep focus on a
      // persistent heading until the history control is enabled again.
      pendingHistoryFocus.current = { scope, operation }
      focusAnchor.current.focus()
    }
    setBusy(true); setError(''); setTrial(null); setHistory(null); setSourceId(null)
    try {
      if (action === 'list') {
        const value = await listFreeLevelingTrials(binding, offset)
        if (stillCurrent()) setHistory({ scope, offset, value })
      } else {
        // Ambiguous transport failures can be retried without creating duplicates.
        if (action === 'create') attempt.current ??= crypto.randomUUID()
        const value = action === 'create' ? await createFreeLevelingTrial(binding, attempt.current!) : await readFreeLevelingTrial(binding, id!, page?.trials.find(item => item.id === id))
        if (stillCurrent()) {
          setTrial({ scope, value })
          if (action === 'create') attempt.current = null
        }
      }
    } catch (cause) {
      if (stillCurrent()) setError(cause instanceof FreeLevelingRequestError ? cause.reason : 'request-failed')
    } finally {
      if (stillCurrent()) { inFlight.current = false; setBusy(false); if (action !== 'create') setFocusCompletion(operation) }
    }
  }

  return <section className="min-w-0 space-y-4 p-4 text-[11px] text-ds-ink" aria-label={t('surveyFreeTitle')}>
    <h4 ref={focusAnchor} tabIndex={-1} className="text-[13px] font-semibold">{t('surveyFreeTitle')}</h4>
    <div className="space-y-2 border border-amber-300 bg-amber-50 p-3 leading-5 text-amber-950 dark:border-amber-500/40 dark:bg-amber-950 dark:text-amber-100">
      <p className="font-semibold">{t('surveyFreeBoundary')}</p>
      <p>{t('surveyFreeDatum')}</p>
      <p>{t('surveyFreeWeights')}</p>
    </div>
    <label className="flex items-start gap-2 leading-5">
      <input type="checkbox" className="mt-1 shrink-0" checked={acknowledged} disabled={!ready || busy} onChange={event => setAcknowledged(event.target.checked)} />
      <span>{t('surveyFreeAcknowledge')}</span>
    </label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={buttonClass} disabled={!ready || !acknowledged || busy} onClick={() => void run('create')}>{t('surveyFreeRun')}</button>
      <button ref={historyButton} type="button" className={buttonClass} disabled={!ready || busy} onClick={() => void run('list')}>{t('surveyFreeHistory')}</button>
    </div>
    {!ready ? <p role="status">{!runtimeReady ? t('surveyFreeOffline') : t('surveyFreeUnavailable')}</p> : null}
    {busy ? <p role="status">{t('surveyFreeLoading')}</p> : null}
    {error ? <p role="alert">{t(errorLabels[error] ?? 'surveyFreeFailed')}</p> : null}
    {page ? <div className="space-y-2" aria-label={t('surveyFreeHistory')}>
      {!page.trials.length ? <p>{t('surveyFreeNoHistory')}</p> : null}
      {page.trials.map(item => <button type="button" key={item.id} className={`${buttonClass} block w-full break-words`} disabled={busy} onClick={() => void run('restore', 0, item.id)}>
        {t('surveyFreeRestore')} · {item.createdAt} · {item.id} · {t('surveyFreeDf')}: {item.degreesOfFreedom}
      </button>)}
      <div className="flex flex-wrap gap-2">
        {history && history.offset > 0 ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void run('list', Math.max(0, history.offset - 20))}>{t('surveyFreePrevious')}</button> : null}
        {page.nextOffset !== null ? <button type="button" className={buttonClass} disabled={busy} onClick={() => void run('list', page.nextOffset!)}>{t('surveyFreeNext')}</button> : null}
      </div>
    </div> : null}
    {current ? <EngineeringSelectedEvidence reference={{ kind: 'free-leveling', networkId: current.networkId, networkRevision: current.networkRevision, sourceSha256: current.sourceSha256, trialId: current.id, recordHash: current.recordHash }}>
      <EngineeringEvidenceQuestion label={current.id} />
      <p role="status" className="font-semibold">{t('surveyFreeResultStatus')}</p>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[[t('surveyFreeRank'), current.output.rank], [t('surveyFreeDf'), current.output.degreesOfFreedom], [t('surveyFreeDatumDefect'), current.output.datumDefect], [t('surveyFreeVariance'), number(current.output.posteriorVarianceFactorEstimate)]].map(([label, value]) => <div key={label}><dt className="text-ds-muted">{label}</dt><dd className="break-all font-mono">{value}</dd></div>)}
      </dl>
      <p>{t(current.weightBasis === 'inverse-declared-sigma-squared' ? 'surveyFreeSigmaWeights' : 'surveyFreeLengthWeights')} {t('surveyFreeDefaultWeights', { ids: current.defaultWeightObservationIds.join(', ') || '—' })}</p>
      <div role="region" aria-label={t('surveyFreePointTable')} tabIndex={0} className="min-w-0 overflow-auto border border-ds-border-muted">
        <table className="w-full min-w-[560px] text-left"><caption className="p-2 text-left font-semibold">{t('surveyFreePointTable')}</caption><thead className="bg-ds-subtle"><tr>{['surveyPoint', 'surveyFreeOriginalRole', 'surveyFreeH0', 'surveyFreeCorrection', 'surveyFreeHeight'].map(key => <th key={key} scope="col" className="p-2">{t(key)}</th>)}</tr></thead>
          <tbody>{current.output.points.map((point, index) => {
            const role = current.originalPointRoles.find(item => item.id === point.id)!
            return <tr key={point.id} className="border-t border-ds-border-muted"><th scope="row" className="break-all p-2">{point.id}<EngineeringEvidenceQuestion label={point.id} selector={{ path: ['output', 'points', index], identity: { id: point.id } }} /></th><td className="p-2">{t(role.known ? 'surveyFreeWasFixed' : 'surveyFreeWasUnknown')}</td><td className="p-2 font-mono">{number(point.referenceHeight)}{role.referenceHeightBasis === 'zero-initial-approximation' ? <span className="block font-sans">{t('surveyFreeZeroReference')}</span> : null}</td><td className="p-2 font-mono">{number(point.correction)}</td><td className="p-2 font-mono">{number(point.height)}</td></tr>
          })}</tbody></table>
      </div>
      <div role="region" aria-label={t('surveyFreeObservationTable')} tabIndex={0} className="min-w-0 overflow-auto border border-ds-border-muted">
        <table className="w-full min-w-[720px] text-left"><caption className="p-2 text-left font-semibold">{t('surveyFreeObservationTable')}</caption><thead className="bg-ds-subtle"><tr>{['surveyObservationId', 'surveyPointPair', 'surveyFreeObserved', 'surveyFreeAdjusted', 'surveyFreeResidual', 'surveyFreeWeight', 'surveyFreeSource'].map(key => <th key={key} scope="col" className="p-2">{t(key)}</th>)}</tr></thead>
          <tbody>{current.output.observations.map((observation, index) => <tr key={observation.id} className="border-t border-ds-border-muted"><th scope="row" className="break-all p-2">{observation.id}<EngineeringEvidenceQuestion label={observation.id} selector={{ path: ['output', 'observations', index], identity: { id: observation.id } }} /></th><td className="break-all p-2">{observation.from} → {observation.to}</td><td className="p-2 font-mono">{number(observation.heightDifference)}</td><td className="p-2 font-mono">{number(observation.adjustedHeightDifference)}</td><td className="p-2 font-mono">{number(observation.residual)}</td><td className="p-2 font-mono">{number(observation.weight)}{current.defaultWeightObservationIds.includes(observation.id) ? <span className="block font-sans">{t('surveyFreeUnitWeight')}</span> : null}</td><td className="p-2"><button type="button" className={buttonClass} onClick={event => { sourceTrigger.current = { scope, button: event.currentTarget }; setSourceId(observation.sourceAnchor) }}>{t('surveyFreeLocate', { id: observation.id })}</button></td></tr>)}</tbody></table>
      </div>
      {sourceId ? <div ref={sourcePanel} tabIndex={-1}>{renderSourceRecord(sourceId, () => {
        if (activeScope.current !== scope) return
        const trigger = sourceTrigger.current
        setSourceId(null)
        if (trigger?.scope === scope && canFocus(trigger.button) && !trigger.button.disabled) trigger.button.focus()
      })}</div> : null}
      <details className="min-w-0"><summary className="cursor-pointer">{t('surveyFreeProvenance')}</summary><dl className="mt-2 space-y-2">
        {[[t('surveyFreeRecord'), current.id], [t('surveyFreeCreatedAt'), current.createdAt], [t('surveyFreeNetworkRevision'), current.networkRevision], [t('surveyFreeAlgorithm'), current.algorithmVersion], ['inputHash', current.inputHash], ['sourceSha256', current.sourceSha256], ['sourceAdmissionHash', current.sourceAdmissionHash], ['requestHash', current.requestHash], ['outputHash', current.outputHash], ['recordHash', current.recordHash]].map(([label, value]) => <div key={label}><dt className="text-ds-muted">{label}</dt><dd className="break-all font-mono">{value}</dd></div>)}
      </dl></details>
    </EngineeringSelectedEvidence> : null}
  </section>
}
