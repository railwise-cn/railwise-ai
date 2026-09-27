import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DeliverableVerificationV1 } from '@shared/engineering-verification'
import { InvalidVerificationResponse, parseEngineeringVerification, verificationFailureKey } from './engineering-verification'
import { EngineeringMonitoringReplay } from './EngineeringMonitoringReplay'
import { EngineeringEvidenceQuestion } from './EngineeringEvidenceQuestion'
const checkKeys = {
  manifest: 'engineeringVerifyManifest', outputs: 'engineeringVerifyOutputs', inputs: 'engineeringVerifyInputs',
  surveyReplay: 'engineeringVerifySurveyReplay', sources: 'engineeringVerifySources'
}
const statusKeys = { passed: 'engineeringVerifyPassed', failed: 'engineeringVerifyFailed', 'not-applicable': 'engineeringVerifyNotApplicable' }

export function EngineeringManifestVerification({ projectId, manifestId, reviewStatus, contextRevision, runtimeReady, request }: {
  projectId: string; manifestId: string; reviewStatus: string; contextRevision: number; runtimeReady: boolean
  request: <T>(path: string, method?: string, body?: unknown) => Promise<T>
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const scope = JSON.stringify([projectId, manifestId, reviewStatus, contextRevision, runtimeReady])
  const activeScope = useRef(scope)
  activeScope.current = scope
  const [stored, setStored] = useState<{ scope: string; result: DeliverableVerificationV1 } | null>(null)
  const [error, setError] = useState<{ scope: string; key: string; detail: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const inFlight = useRef(false)
  useEffect(() => {
    generation.current += 1
    inFlight.current = false
    setStored(null); setError(null); setBusy(false)
    return () => { generation.current += 1 }
  }, [scope])
  const verify = async (): Promise<void> => {
    if (!runtimeReady || inFlight.current) return
    inFlight.current = true
    const current = ++generation.current
    const stillCurrent = (): boolean => current === generation.current && activeScope.current === scope
    setBusy(true); setStored(null); setError(null)
    try {
      const envelope = await request<unknown>(`/v1/engineering/projects/${encodeURIComponent(projectId)}/manifests/${encodeURIComponent(manifestId)}/verify`, 'POST')
      if (!stillCurrent()) return
      if (!envelope || typeof envelope !== 'object' || !('verification' in envelope)) throw new InvalidVerificationResponse()
      const result = parseEngineeringVerification(envelope.verification, { projectId, manifestId, reviewStatus })
      setStored({ scope, result })
    } catch (failure) {
      if (stillCurrent()) {
        const detail = (failure instanceof Error ? failure.message : String(failure)).slice(0, 4096)
        setError({ scope, key: failure instanceof InvalidVerificationResponse ? 'engineeringVerifyInvalidResponse' : verificationFailureKey(detail), detail })
      }
    } finally { if (stillCurrent()) { inFlight.current = false; setBusy(false) } }
  }
  const result = runtimeReady && stored?.scope === scope ? stored.result : null
  const currentError = runtimeReady && error?.scope === scope ? error : null
  const technicalDetail = (detail: string): React.JSX.Element => <details className="mt-1 min-w-0 text-ds-muted"><summary className="cursor-pointer">{t('engineeringVerifyTechnicalDetails')}</summary><p className="mt-1 whitespace-pre-wrap break-all">{detail.slice(0, 4096)}</p></details>
  return <div className="mt-2 min-w-0 space-y-2 text-[11px]">
    <button type="button" disabled={!runtimeReady || busy} onClick={() => void verify()} className="rounded border border-ds-border-muted px-2 py-1 text-ds-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 disabled:opacity-50">{t(busy ? 'engineeringVerifying' : 'engineeringVerifyDelivery')}</button>
    <div role="status" aria-live="polite">
      {currentError ? <><p className="text-red-700 dark:text-red-300">{t(currentError.key)}</p>{technicalDetail(currentError.detail)}</> : null}
      {result ? <>
        <p className={result.valid ? 'text-ds-ink' : 'text-red-700 dark:text-red-300'}>{t(result.valid ? 'engineeringVerifySucceeded' : 'engineeringVerifyFailed')} · <time dateTime={result.checkedAt}>{new Date(result.checkedAt).toLocaleString(i18n.language)}</time></p>
        <ul className="mt-1 space-y-1">{result.checks.map((check, index) => <li key={check.id}>
          {t(checkKeys[check.id])}: {t(statusKeys[check.status])}
          <EngineeringEvidenceQuestion label={t(checkKeys[check.id])} reference={{ kind: 'deliverable-verification', manifestId: result.manifestId, checkedAt: result.checkedAt, selector: { path: ['checks', index], identity: { id: check.id } } }} />
          {check.detail ? <><p className="break-words text-ds-muted">{t(verificationFailureKey(check.detail))}</p>{technicalDetail(check.detail)}</> : null}
        </li>)}</ul>
        <p className="mt-2 text-ds-muted">{t('engineeringVerifyBoundary')}</p>
      </> : null}
    </div>
    <EngineeringMonitoringReplay projectId={projectId} manifestId={manifestId} reviewStatus={reviewStatus} contextRevision={contextRevision} runtimeReady={runtimeReady} request={request} />
  </div>
}
