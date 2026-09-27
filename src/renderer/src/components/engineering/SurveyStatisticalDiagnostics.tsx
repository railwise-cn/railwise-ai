import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Download, LocateFixed } from 'lucide-react'
import type { SurveyStatisticalDiagnosticsV1 } from '@shared/survey-statistics'
import { readSurveyStatisticalDiagnostics, SurveyStatisticalRequestError, type SurveyStatisticalBinding } from '../../agent/survey-statistics-client'
import { saveGeneratedWorkspaceFileAs } from '../../lib/generated-file-actions'
import { EngineeringEvidenceQuestion, EngineeringSelectedEvidence } from './EngineeringEvidenceQuestion'

const unavailableKeys = {
  'unsupported-network-type': 'surveyStatsUnsupported', 'dimension-limit': 'surveyStatsDimensionLimit',
  'insufficient-redundancy': 'surveyStatsInsufficientRedundancy', 'inconsistent-weight-basis': 'surveyStatsMixedWeights',
  'correlated-observations': 'surveyStatsCorrelated', 'unresolved-residual-model': 'surveyStatsUnresolvedModel',
  'zero-or-unresolved-deleted-variance': 'surveyStatsUnresolvedVariance'
} as const
const errorKeys = { stale: 'surveyStatsStale', unavailable: 'surveyStatsServiceUnavailable',
  'invalid-response': 'surveyStatsInvalidResponse', 'request-failed': 'surveyStatsRequestFailed' } as const

export function SurveyStatisticalDiagnostics({ binding, contextRevision, networkRevision, runtimeReady, eligible, workspace,
  renderSourceRecord }: {
  binding: SurveyStatisticalBinding | null
  contextRevision: string
  networkRevision?: number
  runtimeReady: boolean
  eligible: boolean
  workspace?: string
  renderSourceRecord: (sourceRecordId: string, onDismiss: () => void) => ReactNode
}): React.JSX.Element {
  const { t, i18n } = useTranslation('common')
  const [result, setResult] = useState<{ scope: string; diagnostic: SurveyStatisticalDiagnosticsV1 } | null>(null)
  const [busy, setBusy] = useState<'read' | 'save' | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [sourceRecordId, setSourceRecordId] = useState<string | null>(null)
  const sourcePanel = useRef<HTMLDivElement>(null)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const scope = JSON.stringify([binding, contextRevision, networkRevision, runtimeReady, eligible])
  const activeScope = useRef(scope)
  activeScope.current = scope
  useEffect(() => {
    generation.current += 1
    inFlight.current = false
    setResult(null); setBusy(null); setMessage(''); setError(''); setSourceRecordId(null)
    return () => { generation.current += 1 }
  }, [scope])
  useEffect(() => { if (sourceRecordId) sourcePanel.current?.focus() }, [sourceRecordId])
  const diagnostic = runtimeReady && eligible && result?.scope === scope ? result.diagnostic : null
  const canRead = runtimeReady && eligible && Boolean(binding)
  const read = async (download = false): Promise<void> => {
    if (!canRead || !binding || inFlight.current) return
    inFlight.current = true
    const current = ++generation.current
    const stillCurrent = (): boolean => current === generation.current && activeScope.current === scope
    setBusy(download ? 'save' : 'read'); setResult(null); setSourceRecordId(null); setMessage(''); setError('')
    try {
      const value = await readSurveyStatisticalDiagnostics(binding, download)
      if (!stillCurrent()) return
      setResult({ scope, diagnostic: value })
      if (download) {
        let binary = ''
        for (const byte of new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)) binary += String.fromCharCode(byte)
        const saved = await saveGeneratedWorkspaceFileAs({ suggestedName: 'survey-statistical-diagnostics.json',
          workspaceRoot: workspace, mimeType: 'application/json', dataBase64: btoa(binary) })
        if (!stillCurrent()) return
        if (saved.ok) setMessage('surveyStatsSaved')
        else if (!saved.canceled) setError('surveyStatsSaveFailed')
      }
    } catch (failure) {
      if (stillCurrent()) setError(failure instanceof SurveyStatisticalRequestError ? errorKeys[failure.reason] : 'surveyStatsRequestFailed')
    } finally {
      if (stillCurrent()) { inFlight.current = false; setBusy(null) }
    }
  }
  const number = (value: number): string => value !== 0 && Math.abs(value) < 1e-5
    ? value.toExponential(4) : value.toLocaleString(i18n.language, { maximumSignificantDigits: 7 })
  return <section aria-label={t('surveyStatsTitle')} className="mt-4 min-w-0 border-t border-ds-border-muted pt-4 text-[11px]">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h5 className="text-[12px] font-semibold text-ds-ink">{t('surveyStatsTitle')}</h5>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void read()} disabled={!canRead || busy !== null}
          className="inline-flex min-h-8 items-center gap-1.5 rounded border border-ds-border px-2.5 text-ds-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
          <Activity aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />{t(busy === 'read' ? 'surveyStatsReading' : 'surveyStatsRead')}
        </button>
        <button type="button" onClick={() => void read(true)} disabled={!canRead || !diagnostic || busy !== null}
          aria-label={t('surveyStatsDownload')} title={t('surveyStatsDownload')}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded border border-ds-border text-ds-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
          <Download aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
    <div role="status" aria-live="polite" className="mt-2 text-ds-muted">
      {!runtimeReady ? <p>{t('surveyStatsOffline')}</p> : !eligible ? <p>{t('surveyStatsIneligible')}</p> : !binding ? <p>{t('surveyStatsMissingBinding')}</p> : null}
      {busy === 'save' ? <p>{t('surveyStatsSaving')}</p> : null}
      {error ? <p className="text-red-700 dark:text-red-300">{t(error)}</p> : null}
      {message ? <p>{t(message)}</p> : null}
      {diagnostic?.status === 'unavailable' ? <p>{t(unavailableKeys[diagnostic.reason])}</p> : null}
    </div>
    {diagnostic && binding ? <EngineeringSelectedEvidence reference={{ kind: 'statistics', networkId: diagnostic.networkId, networkRevision: networkRevision ?? 0, sourceSha256: diagnostic.sourceSha256, adjustmentId: diagnostic.runId, inputHash: diagnostic.inputHash, calculationHash: diagnostic.calculationHash, diagnosticsVersion: diagnostic.diagnosticsVersion }}>
      <EngineeringEvidenceQuestion label={t('surveyStatsTitle')} />
      <p className="mt-2 text-amber-800 dark:text-amber-200">{t('surveyStatsNoDecision')}</p>
      {diagnostic.status === 'available' ? <>
        <p className="mt-2 font-medium text-ds-ink">{t('surveyStatsMethod')}</p>
        <p className="mt-1 text-ds-muted">{t('surveyStatsAssumptionsUnverified')}</p>
        <p className="mt-1 leading-5 text-ds-muted">{t('surveyStatsAssumptions')}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          <div><dt className="text-ds-faint">{t('surveyStatsFullDf')}</dt><dd className="mt-0.5 tabular-nums text-ds-ink">{diagnostic.fullModelDegreesOfFreedom}</dd></div>
          <div><dt className="text-ds-faint">{t('surveyStatsDeletedDf')}</dt><dd className="mt-0.5 tabular-nums text-ds-ink">{diagnostic.degreesOfFreedom}</dd></div>
          <div><dt className="text-ds-faint">{t('surveyStatsWeights')}</dt><dd className="mt-0.5 text-ds-ink">{t(diagnostic.weightBasis === 'inverse-declared-sigma-squared' ? 'surveyStatsDeclaredSigma' : 'surveyStatsRouteWeight')}</dd></div>
        </dl>
        <div role="region" tabIndex={0} aria-label={t('surveyStatsTable')} className="mt-3 max-h-72 overflow-auto border border-ds-border-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          <table className="w-full min-w-[580px] text-left text-[10.5px]">
            <thead className="sticky top-0 bg-ds-subtle text-ds-muted"><tr>
              <th scope="col" className="px-3 py-2">{t('surveyStatObservations')}</th><th scope="col" className="px-3 py-2">{t('surveyStatsResidual')}</th>
              <th scope="col" className="px-3 py-2">{t('surveyStatsT')}</th><th scope="col" className="px-3 py-2">{t('surveyStatsRedundancy')}</th>
              <th scope="col" className="px-3 py-2">{t('surveyRawRecord')}</th>
            </tr></thead>
            <tbody className="divide-y divide-ds-border-muted">{diagnostic.observations.map((observation, index) => <tr key={observation.observationId}>
              <th scope="row" className="max-w-44 break-all px-3 py-2 text-left font-mono font-normal text-ds-ink">{observation.observationId}<EngineeringEvidenceQuestion label={observation.observationId} selector={{ path: ['observations', index], identity: { observationId: observation.observationId } }} /></th>
              <td className="px-3 py-2 tabular-nums text-ds-ink">{number(observation.residual)}</td>
              <td className="px-3 py-2 tabular-nums text-ds-ink">{number(observation.externallyStudentizedResidual)}</td>
              <td className="px-3 py-2 tabular-nums text-ds-ink">{number(observation.redundancy)}</td>
              <td className="px-3 py-2">{observation.sourceRecordId ? <div className="flex items-center gap-2">
                <code className="max-w-40 truncate font-mono text-[9.5px] text-ds-muted" title={observation.sourceRecordId}>{observation.sourceRecordId}</code>
                <button type="button" onClick={() => setSourceRecordId(observation.sourceRecordId!)}
                  aria-label={t('surveyLocateRecordAria', { observation: observation.observationId, record: observation.sourceRecordId })}
                  title={t('surveyLocateRecord')} className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                  <LocateFixed aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </div> : <span className="text-ds-faint">{t('surveyRecordUnlinked')}</span>}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {sourceRecordId ? <div ref={sourcePanel} tabIndex={-1} className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">{renderSourceRecord(sourceRecordId, () => setSourceRecordId(null))}</div> : null}
      </> : null}
      <details className="mt-3 text-[10px] text-ds-muted"><summary className="cursor-pointer py-1">{t('surveyStatsProvenance')}</summary>
        <dl className="mt-2 space-y-2">{[['surveyStatsRun', diagnostic.runId], ['surveyStatsVersion', diagnostic.diagnosticsVersion],
          ['surveyStatsInputHash', diagnostic.inputHash], ['surveyStatsSourceHash', diagnostic.sourceSha256],
          ['surveyStatsCalculationHash', diagnostic.calculationHash]].map(([label, value]) => <div key={label}><dt>{t(label!)}</dt><dd className="mt-0.5 break-all font-mono text-ds-ink">{value}</dd></div>)}</dl>
      </details>
    </EngineeringSelectedEvidence> : null}
  </section>
}
