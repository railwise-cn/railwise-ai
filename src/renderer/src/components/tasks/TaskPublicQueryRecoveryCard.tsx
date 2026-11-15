import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskPublicQueryRecoverySnapshotV1, TaskRunV1 } from '@shared/agent-workbench'
import type { TaskPublicQueryRecoveryPrepareRequest } from '@shared/workwise-api'

type Projection = Pick<TaskPublicQueryRecoverySnapshotV1, 'taskId' | 'state' | 'reason'>
type RecoveryRequest = { taskId: string; action: 'prepare' | 'continue' | 'revoke'; expectedRevision: number; idempotencyKey: string; receiptId?: string; consentReceiptId?: string; reviewHash?: string; scopeConfirmation?: TaskPublicQueryRecoveryPrepareRequest['scopeConfirmation'] }
type Props = {
  task: TaskRunV1
  runtimeReady: boolean
  disabled?: boolean
  onChanged: () => Promise<unknown>
  onProjectionChange?: (projection: Projection) => void
  onNotice?: (message: string) => void
}

function reviewedScope(snapshot: TaskPublicQueryRecoverySnapshotV1): NonNullable<TaskPublicQueryRecoverySnapshotV1['scopeReview']> | undefined {
  const review = snapshot.mode === 'task_reauthorization' ? snapshot.scopeReview : undefined
  return review && typeof review.reviewHash === 'string' && /^[a-f0-9]{64}$/.test(review.reviewHash)
    && typeof review.purpose === 'string' && review.purpose.length > 0 && typeof review.browserLabel === 'string'
    && review.maxTtlSeconds === 900 && typeof review.scope?.browserInstanceId === 'string' && review.scope.browserInstanceId.length > 0 && Number.isInteger(review.scope.revision)
    && review.scope.revision >= 0 && Array.isArray(review.scope.origins) && review.scope.origins.length > 0 && review.scope.origins.every(origin => typeof origin === 'string' && origin.length > 0) ? review : undefined
}

function hasConsent(snapshot: TaskPublicQueryRecoverySnapshotV1): boolean {
  return snapshot.mode === 'task_reauthorization' && typeof snapshot.consentReceiptId === 'string' && snapshot.consentReceiptId.length > 0
    && !snapshot.consentRevoked && typeof snapshot.consentExpiresAt === 'string' && Number.isFinite(Date.parse(snapshot.consentExpiresAt))
    && Date.parse(snapshot.consentExpiresAt) > Date.now()
}

function actionable(snapshot: TaskPublicQueryRecoverySnapshotV1): boolean {
  return Number.isInteger(snapshot.unknownOperationCount) && snapshot.unknownOperationCount > 0
    && (snapshot.state === 'eligible' && snapshot.mode !== 'task_reauthorization'
      || snapshot.state === 'needs_scope_review' && Boolean(reviewedScope(snapshot))
      || snapshot.state === 'prepared' && typeof snapshot.receiptId === 'string' && Boolean(snapshot.receiptId)
        && (snapshot.mode !== 'task_reauthorization' || hasConsent(snapshot)))
}

function revocable(snapshot: TaskPublicQueryRecoverySnapshotV1): boolean {
  return hasConsent(snapshot) && (snapshot.state === 'prepared' || snapshot.state === 'unavailable' && snapshot.reason === 'browser_public_query_current_scope_active')
}

/** Eligibility and consent come from the server; old unknown results stay unknown. */
export function TaskPublicQueryRecoveryCard({ task, runtimeReady, disabled, onChanged, onProjectionChange, onNotice }: Props): ReactElement | null {
  const { t, i18n } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<TaskPublicQueryRecoverySnapshotV1 | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [confirmedReview, setConfirmedReview] = useState<string | null>(null)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const owner = useRef({ taskId: task.id, revision: task.revision, runtimeReady })
  owner.current = { taskId: task.id, revision: task.revision, runtimeReady }
  const request = useRef<RecoveryRequest | null>(null)
  const refreshedExpiry = useRef<string | null>(null)
  const review = snapshot && reviewedScope(snapshot)
  const reviewKey = snapshot?.state === 'needs_scope_review' && review ? JSON.stringify([task.id, task.revision, review.reviewHash, review.scope.browserInstanceId, review.scope.revision, review.scope.origins]) : null
  const checked = Boolean(reviewKey && confirmedReview === reviewKey)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { setConfirmedReview(null) }, [reviewKey])

  useEffect(() => {
    let active = true
    setSnapshot(null)
    setError('')
    onProjectionChange?.({ taskId: task.id, state: 'unavailable' })
    if (!runtimeReady) return
    void (async () => {
      try {
        const next = await window.workwise.getTaskPublicQueryRecovery(task.id)
        if (!active || next.taskId !== task.id || next.taskRevision !== task.revision) return
        setSnapshot(next)
        onProjectionChange?.({ taskId: task.id, state: actionable(next) ? next.state : 'unavailable', reason: next.reason })
      } catch { /* Without a current server projection no recovery action is offered. */ }
    })()
    return () => { active = false }
  }, [task.id, task.revision, runtimeReady, reload, onProjectionChange])

  useEffect(() => {
    if (!runtimeReady || snapshot?.mode !== 'task_reauthorization' || snapshot.consentRevoked || !snapshot.consentReceiptId
      || !(snapshot.state === 'prepared' || snapshot.state === 'unavailable' && snapshot.reason === 'browser_public_query_current_scope_active')) return
    const expiresAt = Date.parse(snapshot.consentExpiresAt ?? '')
    const key = JSON.stringify([task.id, snapshot.consentReceiptId, snapshot.consentExpiresAt])
    if (!Number.isFinite(expiresAt) || refreshedExpiry.current === key) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const checkExpiry = (): void => {
      const remaining = expiresAt - Date.now()
      if (remaining > 0) { timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647)); return }
      refreshedExpiry.current = key
      // Expiry only refreshes the server projection. It never renews consent or starts work.
      setSnapshot(null)
      setReload(value => value + 1)
    }
    checkExpiry()
    return () => { if (timer !== undefined) clearTimeout(timer) }
  }, [runtimeReady, task.id, snapshot])

  const run = async (requestedAction?: 'revoke'): Promise<void> => {
    if (!runtimeReady || disabled || busyRef.current || !snapshot) return
    const action = requestedAction ?? (snapshot.state === 'prepared' ? 'continue' : 'prepare')
    if (action === 'revoke' ? !revocable(snapshot) : !actionable(snapshot)) return
    if (action === 'prepare' && snapshot.mode === 'task_reauthorization' && (!review || !checked)) return
    const taskId = task.id
    const startedRevision = task.revision
    const stillCurrent = (): boolean => mounted.current && owner.current.runtimeReady && owner.current.taskId === taskId && owner.current.revision === startedRevision
    const reviewHash = review?.reviewHash
    const previous = request.current
    const pending: RecoveryRequest = previous?.taskId === taskId && previous.action === action && previous.expectedRevision === snapshot.taskRevision && previous.receiptId === snapshot.receiptId && previous.consentReceiptId === snapshot.consentReceiptId && previous.reviewHash === reviewHash
      ? previous
      : { taskId, action, expectedRevision: snapshot.taskRevision, idempotencyKey: `public-query-${action}:${crypto.randomUUID()}`, receiptId: snapshot.receiptId, consentReceiptId: snapshot.consentReceiptId, reviewHash,
        ...(action === 'prepare' && review ? { scopeConfirmation: { reviewHash: review.reviewHash, expectedBrowserRevision: review.scope.revision, browserInstanceId: review.scope.browserInstanceId, origins: [...review.scope.origins], duration: 'task', ttlSeconds: 900, confirmed: true } } : {}) }
    request.current = pending
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      if (action === 'prepare') {
        const result = await window.workwise.prepareTaskPublicQueryRecovery(taskId, { expectedRevision: pending.expectedRevision, idempotencyKey: pending.idempotencyKey, confirmed: true, ...(pending.scopeConfirmation ? { scopeConfirmation: pending.scopeConfirmation } : {}) })
        if (!stillCurrent()) return
        if (result.prepared !== true || result.resumed !== false || result.task.id !== taskId || result.recovery.taskId !== taskId || result.recovery.taskRevision !== result.task.revision || result.recovery.state !== 'prepared' || !actionable(result.recovery)) throw new Error('Invalid recovery projection')
        request.current = null
        setSnapshot(result.recovery)
        onProjectionChange?.({ taskId, state: 'prepared' })
      } else if (action === 'revoke') {
        const result = await window.workwise.revokeTaskPublicQueryRecovery(taskId, { expectedRevision: pending.expectedRevision, idempotencyKey: pending.idempotencyKey, confirmed: true, consentReceiptId: pending.consentReceiptId! })
        if (!stillCurrent()) return
        if (result.task.id !== taskId) throw new Error('Invalid scope revocation')
        request.current = null
        setSnapshot(null)
        onProjectionChange?.({ taskId, state: 'unavailable' })
        onNotice?.(t('taskPublicQueryRecoveryRevoked'))
        setReload(value => value + 1)
      } else {
        const result = await window.workwise.retryTask(taskId, { expectedRevision: pending.expectedRevision, idempotencyKey: pending.idempotencyKey, publicQueryRecoveryReceiptId: pending.receiptId })
        if (!stillCurrent()) return
        request.current = null
        setSnapshot(null)
        onProjectionChange?.({ taskId, state: 'unavailable' })
        onNotice?.(result.capability?.message ?? t('taskPublicQueryRecoveryStarted'))
      }
      await onChanged().catch(() => undefined)
    } catch (reason) {
      if (!stillCurrent()) return
      const conflict = (reason as { status?: number })?.status === 409
      setError(t(conflict ? 'taskPublicQueryRecoveryChanged' : action === 'prepare' ? 'taskPublicQueryRecoveryPrepareFailed' : action === 'revoke' ? 'taskPublicQueryRecoveryRevokeFailed' : 'taskPublicQueryRecoveryContinueFailed'))
      if (conflict) {
        request.current = null
        setSnapshot(null)
        onProjectionChange?.({ taskId, state: 'unavailable' })
        await onChanged().catch(() => undefined)
        setReload(value => value + 1)
      }
      // An uncertain transport response retains the same key and exact consent.
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }

  if (!runtimeReady || !snapshot || snapshot.taskId !== task.id) return null
  const needsFreshScope = snapshot.state === 'unavailable' && snapshot.reason === 'browser_public_query_schedule_scope_required'
  const canRevoke = revocable(snapshot)
  if (!actionable(snapshot) && !needsFreshScope && !canRevoke) return null
  const prepared = snapshot.state === 'prepared'
  const oneOff = snapshot.mode === 'task_reauthorization'
  const scopeActive = snapshot.state === 'unavailable' && canRevoke
  const origins = review?.scope.origins ?? snapshot.origins
  return <section aria-label={t('taskPublicQueryRecoveryTitle')} className="mb-4 min-w-0 max-w-full break-words rounded-xl border border-ds-border bg-ds-main p-3 text-xs">
    <h3 className="font-semibold">{t('taskPublicQueryRecoveryTitle')}</h3>
    <p className="mt-2 leading-relaxed text-ds-muted">{t(needsFreshScope ? 'taskPublicQueryRecoveryFreshScopeRequired' : scopeActive ? 'taskPublicQueryRecoveryScopeActive' : oneOff ? 'taskPublicQueryRecoveryOneOffHint' : 'taskPublicQueryRecoveryHint')}</p>
    {oneOff && review ? <dl className="mt-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 leading-relaxed">
      <dt>{t('taskPublicQueryRecoveryPurpose')}</dt><dd className="min-w-0 break-words">{review.purpose}</dd>
      <dt>{t('taskPublicQueryRecoveryBrowser')}</dt><dd className="min-w-0 break-words">{review.browserLabel}</dd>
    </dl> : null}
    {!needsFreshScope && origins?.length ? <p className="mt-2 break-all leading-relaxed text-ds-muted">{t('taskPublicQueryRecoverySites')}: {origins.join(' · ')}</p> : null}
    {oneOff && snapshot.consentExpiresAt ? <p className="mt-2 leading-relaxed text-ds-muted">{t('taskPublicQueryRecoveryScopeExpires')}: <time dateTime={snapshot.consentExpiresAt}>{new Date(snapshot.consentExpiresAt).toLocaleString(i18n.language)}</time></p> : null}
    {snapshot.consentRevoked ? <p role="status" className="mt-2 text-ds-muted">{t('taskPublicQueryRecoveryRevoked')}</p> : null}
    {snapshot.state === 'needs_scope_review' ? <label className="mt-3 flex min-w-0 items-start gap-2 leading-relaxed"><input type="checkbox" className="mt-0.5 shrink-0" checked={checked} disabled={busy || disabled} onChange={event => setConfirmedReview(event.currentTarget.checked ? reviewKey : null)} /><span>{t('taskPublicQueryRecoveryConfirmScope')}</span></label> : null}
    {prepared ? <p role="status" className="mt-2 text-ds-muted">{t(oneOff ? 'taskPublicQueryRecoveryOneOffPrepared' : 'taskPublicQueryRecoveryPrepared')}</p> : null}
    <div className="mt-3 flex min-w-0 flex-wrap gap-2">
      {actionable(snapshot) ? <button type="button" disabled={busy || disabled || snapshot.state === 'needs_scope_review' && !checked} onClick={() => void run()} className="max-w-full whitespace-normal rounded-lg bg-accent px-3 py-2 text-left font-semibold text-white disabled:opacity-50">{t(prepared ? 'taskPublicQueryRecoveryContinue' : oneOff ? 'taskPublicQueryRecoveryPrepareScope' : 'taskPublicQueryRecoveryPrepare')}</button> : null}
      {canRevoke ? <button type="button" disabled={busy || disabled} onClick={() => void run('revoke')} className="max-w-full whitespace-normal rounded-lg border border-ds-border px-3 py-2 text-left text-ds-ink disabled:opacity-50">{t('taskPublicQueryRecoveryRevoke')}</button> : null}
    </div>
    {error ? <p role="alert" className="mt-2 text-ds-muted">{error}</p> : null}
  </section>
}
