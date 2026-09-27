import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Calculator } from 'lucide-react'
import type { MonitoringReplayVerificationV1 } from '@shared/engineering-verification'
import { InvalidVerificationResponse } from './engineering-verification'
import { monitoringReplayReasonKeys, parseMonitoringReplay } from './engineering-monitoring-replay'
import { EngineeringEvidenceQuestion } from './EngineeringEvidenceQuestion'

const statusKeys = {
  passed: 'monitoringReplayPassed', failed: 'monitoringReplayFailed',
  'not-evaluated': 'monitoringReplayNotEvaluated', 'not-applicable': 'engineeringVerifyNotApplicable'
} as const

export function EngineeringMonitoringReplay({ projectId, manifestId, reviewStatus, contextRevision, runtimeReady, request }: {
  projectId: string; manifestId: string; reviewStatus: string; contextRevision: number; runtimeReady: boolean
  request: <T>(path: string, method?: string, body?: unknown) => Promise<T>
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const scope = JSON.stringify([projectId, manifestId, reviewStatus, contextRevision, runtimeReady])
  const activeScope = useRef(scope)
  activeScope.current = scope
  const generation = useRef(0)
  const inFlight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [stored, setStored] = useState<{ scope: string; result: MonitoringReplayVerificationV1 } | null>(null)
  const [failure, setFailure] = useState<{ scope: string; key: string } | null>(null)
  useEffect(() => {
    generation.current += 1
    inFlight.current = false
    setStored(null); setFailure(null); setBusy(false)
    return () => { generation.current += 1 }
  }, [scope])

  const replay = async (): Promise<void> => {
    if (!runtimeReady || inFlight.current) return
    inFlight.current = true
    const current = ++generation.current
    const stillCurrent = (): boolean => current === generation.current && activeScope.current === scope
    setBusy(true); setStored(null); setFailure(null)
    try {
      const envelope = await request<unknown>(`/v1/engineering/projects/${encodeURIComponent(projectId)}/manifests/${encodeURIComponent(manifestId)}/monitoring-replay`, 'POST')
      if (!stillCurrent()) return
      if (!envelope || typeof envelope !== 'object' || !('replay' in envelope)) throw new InvalidVerificationResponse()
      setStored({ scope, result: parseMonitoringReplay(envelope.replay, { projectId, manifestId }) })
    } catch (error) {
      if (stillCurrent()) setFailure({ scope, key: error instanceof InvalidVerificationResponse ? 'engineeringVerifyInvalidResponse' : 'monitoringReplayRequestFailed' })
    } finally {
      if (stillCurrent()) { inFlight.current = false; setBusy(false) }
    }
  }

  const result = runtimeReady && stored?.scope === scope ? stored.result : null
  const error = runtimeReady && failure?.scope === scope ? failure.key : null
  const field = (label: string, value: string): React.JSX.Element => <div className="min-w-0"><dt className="text-ds-muted">{t(label)}</dt><dd className="break-all font-mono">{value}</dd></div>
  return <section aria-label={t('monitoringReplayTitle')} className="mt-3 min-w-0 border-t border-ds-border-muted pt-3 text-[11px]">
    <button type="button" onClick={() => void replay()} disabled={!runtimeReady || busy} className="inline-flex min-h-7 items-center gap-1 rounded border border-ds-border-muted px-2 py-1 text-ds-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-50">
      <Calculator size={14} aria-hidden="true" />{t(busy ? 'monitoringReplayRunning' : 'monitoringReplayAction')}
    </button>
    <div role="status" aria-live="polite" className="mt-2 min-w-0 space-y-2">
      {error ? <p className="text-red-700 dark:text-red-300">{t(error)}</p> : null}
      {result ? <>
        <p className={result.status === 'failed' ? 'text-red-700 dark:text-red-300' : result.status === 'not-evaluated' ? 'text-amber-800 dark:text-amber-300' : 'text-ds-ink'}>
          {t(statusKeys[result.status])} · <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString(i18n.language)}</time>
        </p>
        <p>{t(monitoringReplayReasonKeys[result.reasonCode])}</p>
        <EngineeringEvidenceQuestion label={result.attemptId} reference={{ kind: 'monitoring-replay', manifestId: result.manifestId, attemptId: result.attemptId, checkedAt: result.checkedAt }} />
        {result.analyses.length ? <ul className="space-y-1">{result.analyses.map(item => <li key={item.analysisId} className="break-words">
          <span className="break-all font-mono">{item.analysisId}</span>: {t(statusKeys[item.status])} · {t(monitoringReplayReasonKeys[item.reasonCode])}
        </li>)}</ul> : null}
        <details className="min-w-0">
          <summary className="cursor-pointer">{t('monitoringReplayEvidence')}</summary>
          <dl className="mt-2 grid min-w-0 gap-2">
            {field('monitoringReplayAttempt', result.attemptId)}
            {field('monitoringReplayComparison', result.comparisonVersion)}
            {field('monitoringReplayEnvironment', JSON.stringify(result.execution))}
          </dl>
            {result.analyses.map(item => <dl key={item.analysisId} className="mt-2 min-w-0 space-y-2 border-t border-ds-border-muted pt-2">
              {field('monitoringReplayAnalysis', item.analysisId)}
              {field('monitoringReplayDataset', item.datasetId)}
              {field('monitoringReplayAlgorithm', item.algorithmVersion)}
              {field('monitoringReplayInputHash', item.inputHash)}
              {item.sourceFileHash ? field('monitoringReplaySourceHash', item.sourceFileHash) : null}
              {item.sourceContextHash ? field('monitoringReplaySourceContext', item.sourceContextHash) : null}
              {field('monitoringReplayStoredHash', item.storedResultsHash)}
              {item.recomputedResultsHash ? field('monitoringReplayRecomputedHash', item.recomputedResultsHash) : null}
            </dl>)}
        </details>
        <p className="text-ds-muted">{t('monitoringReplayBoundary')}</p>
      </> : null}
    </div>
  </section>
}
