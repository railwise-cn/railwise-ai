import { useEffect, useId, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserOperationReviewV1, TaskOperationReceiptV1, TaskOperationVerificationV1 } from '@shared/agent-workbench'

export function BrowserOperationEvidence({ receipt, ended, onVerify, onConfirm, onConfigure }: {
  receipt: TaskOperationReceiptV1
  ended: boolean
  onVerify?: (receipt: TaskOperationReceiptV1) => Promise<TaskOperationVerificationV1>
  onConfirm?: (receipt: TaskOperationReceiptV1, reviewId: string, decision: 'completed' | 'not_completed') => Promise<TaskOperationVerificationV1>
  onConfigure?: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const [review, setReview] = useState<BrowserOperationReviewV1 | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [decision, setDecision] = useState<'completed' | 'not_completed' | null>(null)
  const decisionName = useId()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [now, setNow] = useState(Date.now)
  const [verifiedOutcome, setVerifiedOutcome] = useState<'succeeded' | 'not_completed' | null>(null)
  const resolved = receipt.resolution?.evidence.kind === 'human_confirmation' || verifiedOutcome !== null
  const outcome = verifiedOutcome ?? receipt.resolution?.outcome ?? 'succeeded'
  const outcomeMessage = (value: 'succeeded' | 'not_completed'): string => t(value === 'not_completed' ? 'taskBrowserHumanIncomplete' : 'taskBrowserHumanConfirmed')
  const expired = Boolean(review && (!Number.isFinite(Date.parse(review.expiresAt)) || Date.parse(review.expiresAt) <= Math.max(now, Date.now())))
  const isHumanConfirmation = (result: TaskOperationVerificationV1): boolean => result.taskId === receipt.taskId && result.receiptId === receipt.id
    && result.status === 'verified' && result.evidence?.kind === 'human_confirmation' && result.evidence.provider === 'browser-skill'
    && result.evidence.operation === receipt.browser?.action && result.evidence.verified === true
    && result.evidence.target === receipt.browser?.pageUrl
    && (result.outcome === 'not_completed' ? result.evidence.status === 'public_query_reviewed_incomplete'
      : (result.outcome === undefined || result.outcome === 'succeeded') && result.evidence.status === 'public_query_confirmed_by_user')
  const reason = (value?: string): string => t(`taskBrowserReviewReason_${value ?? ''}`, { defaultValue: t('taskBrowserReviewUnavailable') })

  useEffect(() => {
    if (!review) return
    const remaining = Date.parse(review.expiresAt) - Date.now()
    if (remaining <= 0 || !Number.isFinite(remaining)) return
    const timer = window.setTimeout(() => { setNow(Date.now()); setConfirmed(false) }, Math.min(remaining, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [review])

  const inspect = async (): Promise<void> => {
    if (!onVerify || busy || ended) return
    setBusy(true)
    setReview(null)
    setConfirmed(false)
    setDecision(null)
    setErrorCode('')
    setMessage('')
    try {
      const result = await onVerify(receipt)
      if (result.taskId === receipt.taskId && result.receiptId === receipt.id && result.browserReview
        && result.browserReview.action === receipt.browser?.action && (!receipt.browser.pageUrl || result.browserReview.pageUrl === receipt.browser.pageUrl)) {
        setReview(result.browserReview)
        setMessage(t('taskBrowserReviewReadOnly'))
      } else {
        if (isHumanConfirmation(result)) setVerifiedOutcome(result.outcome ?? 'succeeded')
        setMessage(isHumanConfirmation(result) ? outcomeMessage(result.outcome ?? 'succeeded') : reason(result.errorCode))
        setErrorCode(result.errorCode ?? '')
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      setMessage(reason(code)); setErrorCode(/^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : '')
    } finally { setBusy(false) }
  }

  const confirm = async (): Promise<void> => {
    if (!onConfirm || !review || !decision || !confirmed || busy || ended || expired || Date.parse(review.expiresAt) <= Date.now()) return
    setBusy(true)
    setMessage('')
    try {
      const result = await onConfirm(receipt, review.id, decision)
      if (isHumanConfirmation(result) && (result.outcome ?? 'succeeded') === (decision === 'not_completed' ? 'not_completed' : 'succeeded')) {
        setVerifiedOutcome(result.outcome ?? 'succeeded')
        setReview(null)
        setConfirmed(false)
        setMessage(outcomeMessage(result.outcome ?? 'succeeded'))
      } else {
        setReview(null)
        setConfirmed(false)
        setMessage(reason(result.errorCode))
        setErrorCode(result.errorCode ?? '')
      }
    } catch (error) {
      setReview(null)
      setConfirmed(false)
      const code = error instanceof Error ? error.message : ''
      setMessage(reason(code)); setErrorCode(/^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : '')
    } finally { setBusy(false) }
  }

  return <li className="rounded-lg border border-ds-border bg-ds-card p-3 text-xs">
    <p className="font-medium">{t(receipt.browser?.action === 'fill' ? 'taskBrowserActionFill' : 'taskBrowserActionClick')}</p>
    {receipt.browser?.pageUrl ? <p className="mt-1 break-all text-ds-muted">{receipt.browser.pageUrl}</p> : null}
    <p className="mt-2 text-ds-muted">{resolved ? outcomeMessage(outcome) : t(receipt.status === 'outcome_unknown' ? 'taskBrowserOutcomeUnknown' : `taskReceiptStatus_${receipt.status}`)}</p>
    {receipt.status === 'outcome_unknown' && !resolved && !ended && receipt.browser?.canReview ? <p className="mt-2 text-ds-muted">{t('taskBrowserReviewSessionLimit')}</p> : null}
    {receipt.status === 'outcome_unknown' && !resolved && !ended ? <div className="mt-3 flex flex-wrap gap-2">
      {onVerify && receipt.browser?.canReview ? <button type="button" disabled={busy} onClick={() => void inspect()} className="rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t(busy ? 'taskEffectVerifying' : 'taskBrowserReview')}</button> : null}
      {onConfigure ? <button type="button" disabled={busy} onClick={onConfigure} className="rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('taskBrowserOpenConnection')}</button> : null}
    </div> : null}
    {receipt.status === 'outcome_unknown' && !resolved && !receipt.browser?.canReview ? <p className="mt-2 text-ds-muted">{t('taskBrowserReviewUnavailable')}</p> : null}
    {review && !resolved ? <section className="mt-3 rounded-lg border border-ds-border bg-ds-main p-3" aria-label={t('taskBrowserReviewTitle')}>
      <h4 className="font-semibold">{t('taskBrowserReviewTitle')}</h4>
      <p className="mt-2 whitespace-pre-wrap break-all">{review.pageUrl}</p>
      {review.targetLabel ? <p className="mt-2 whitespace-pre-wrap break-words">{review.targetLabel}</p> : null}
      {review.value !== undefined ? <div className="mt-2"><p className="font-medium">{t('taskBrowserOriginalInput')}</p><p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{review.value}</p></div> : null}
      <p className="mt-3 font-medium">{t('taskBrowserCurrentObservation')}</p>
      <pre className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words font-sans leading-relaxed">{review.observationText}</pre>
      <p className="mt-2 text-ds-muted">{t('taskBrowserReviewReadOnly')}</p>
      {expired ? <p role="status" className="mt-2 text-amber-700 dark:text-amber-300">{t('taskBrowserReviewExpired')}</p> : <>
        <fieldset className="mt-3 space-y-2" disabled={busy || ended}><legend className="mb-2 font-medium">{t('taskBrowserReviewDecision')}</legend>
          {(['completed', 'not_completed'] as const).map(value => <label key={value} className="flex items-start gap-2"><input type="radio" name={decisionName} value={value} checked={decision === value} onChange={() => { setDecision(value); setConfirmed(false) }} /><span>{t(value === 'completed' ? 'taskBrowserDecisionCompleted' : 'taskBrowserDecisionIncomplete')}</span></label>)}
        </fieldset>
        {decision === 'not_completed' ? <p className="mt-2 text-ds-muted">{t('taskBrowserIncompleteNotice')}</p> : null}
        <label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={!decision || busy || ended} onChange={event => setConfirmed(event.target.checked)} /><span>{t(decision === 'not_completed' ? 'taskBrowserIncompleteStatement' : 'taskBrowserConfirmStatement')}</span></label>
        {onConfirm ? <button type="button" disabled={!decision || !confirmed || busy || ended} onClick={() => void confirm()} className="mt-3 rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('taskBrowserConfirmComplete')}</button> : null}
      </>}
    </section> : null}
    {message && !resolved ? <p role="status" className="mt-2 whitespace-pre-wrap text-ds-muted">{message}</p> : null}
    <details className="mt-3 break-all text-[11px] text-ds-muted"><summary className="cursor-pointer">{t('taskEffectReceiptDetails')}</summary><p className="mt-1">{receipt.id}</p><p>{receipt.requestHash}</p>{errorCode || receipt.errorCode ? <p>{errorCode || receipt.errorCode}</p> : null}</details>
  </li>
}
