import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserOperationReviewV1, TaskOperationReceiptV1, TaskOperationVerificationV1 } from '@shared/agent-workbench'

export function BrowserOperationEvidence({ receipt, ended, onVerify, onConfirm, onConfigure }: {
  receipt: TaskOperationReceiptV1
  ended: boolean
  onVerify?: (receipt: TaskOperationReceiptV1) => Promise<TaskOperationVerificationV1>
  onConfirm?: (receipt: TaskOperationReceiptV1, reviewId: string) => Promise<TaskOperationVerificationV1>
  onConfigure?: () => void
}): ReactElement {
  const { t } = useTranslation('common')
  const [review, setReview] = useState<BrowserOperationReviewV1 | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [errorCode, setErrorCode] = useState('')
  const [now, setNow] = useState(Date.now)
  const [verified, setVerified] = useState(false)
  const resolved = receipt.resolution?.evidence.kind === 'human_confirmation' || verified
  const expired = Boolean(review && (!Number.isFinite(Date.parse(review.expiresAt)) || Date.parse(review.expiresAt) <= Math.max(now, Date.now())))
  const isHumanConfirmation = (result: TaskOperationVerificationV1): boolean => result.taskId === receipt.taskId && result.receiptId === receipt.id
    && result.status === 'verified' && result.evidence?.kind === 'human_confirmation' && result.evidence.provider === 'browser-skill'
    && result.evidence.operation === receipt.browser?.action && result.evidence.verified === true
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
    setErrorCode('')
    setMessage('')
    try {
      const result = await onVerify(receipt)
      if (result.taskId === receipt.taskId && result.receiptId === receipt.id && result.browserReview
        && result.browserReview.action === receipt.browser?.action && (!receipt.browser.pageUrl || result.browserReview.pageUrl === receipt.browser.pageUrl)) {
        setReview(result.browserReview)
        setMessage(t('taskBrowserReviewReadOnly'))
      } else {
        if (isHumanConfirmation(result)) setVerified(true)
        setMessage(isHumanConfirmation(result) ? t('taskBrowserHumanConfirmed') : reason(result.errorCode))
        setErrorCode(result.errorCode ?? '')
      }
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      setMessage(reason(code)); setErrorCode(/^[a-z][a-z0-9_]{0,99}$/.test(code) ? code : '')
    } finally { setBusy(false) }
  }

  const confirm = async (): Promise<void> => {
    if (!onConfirm || !review || !confirmed || busy || ended || expired || Date.parse(review.expiresAt) <= Date.now()) return
    setBusy(true)
    setMessage('')
    try {
      const result = await onConfirm(receipt, review.id)
      if (isHumanConfirmation(result)) {
        setVerified(true)
        setReview(null)
        setConfirmed(false)
        setMessage(t('taskBrowserHumanConfirmed'))
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
    <p className="mt-2 text-ds-muted">{t(resolved ? 'taskBrowserHumanConfirmed' : receipt.status === 'outcome_unknown' ? 'taskBrowserOutcomeUnknown' : `taskReceiptStatus_${receipt.status}`)}</p>
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
        <label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy || ended} onChange={event => setConfirmed(event.target.checked)} /><span>{t('taskBrowserConfirmStatement')}</span></label>
        {onConfirm ? <button type="button" disabled={!confirmed || busy || ended} onClick={() => void confirm()} className="mt-3 rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('taskBrowserConfirmComplete')}</button> : null}
      </>}
    </section> : null}
    {message && !resolved ? <p role="status" className="mt-2 whitespace-pre-wrap text-ds-muted">{message}</p> : null}
    <details className="mt-3 break-all text-[11px] text-ds-muted"><summary className="cursor-pointer">{t('taskEffectReceiptDetails')}</summary><p className="mt-1">{receipt.id}</p><p>{receipt.requestHash}</p>{errorCode || receipt.errorCode ? <p>{errorCode || receipt.errorCode}</p> : null}</details>
  </li>
}
