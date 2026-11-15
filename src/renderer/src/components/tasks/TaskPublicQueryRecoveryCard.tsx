import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskPublicQueryRecoverySnapshotV1, TaskRunV1 } from '@shared/agent-workbench'

type Projection = Pick<TaskPublicQueryRecoverySnapshotV1, 'taskId' | 'state' | 'reason'>
type RecoveryRequest = { taskId: string; action: 'prepare' | 'continue'; expectedRevision: number; idempotencyKey: string; receiptId?: string }
type Props = {
  task: TaskRunV1
  runtimeReady: boolean
  disabled?: boolean
  onChanged: () => Promise<unknown>
  onProjectionChange?: (projection: Projection) => void
  onNotice?: (message: string) => void
}

function actionable(snapshot: TaskPublicQueryRecoverySnapshotV1): boolean {
  return Number.isInteger(snapshot.unknownOperationCount) && snapshot.unknownOperationCount > 0
    && (snapshot.state === 'eligible' || snapshot.state === 'prepared' && typeof snapshot.receiptId === 'string' && Boolean(snapshot.receiptId))
}

/** Eligibility and consent come from the server; old unknown results stay unknown. */
export function TaskPublicQueryRecoveryCard({ task, runtimeReady, disabled, onChanged, onProjectionChange, onNotice }: Props): ReactElement | null {
  const { t } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<TaskPublicQueryRecoverySnapshotV1 | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const owner = useRef({ taskId: task.id, revision: task.revision, runtimeReady })
  owner.current = { taskId: task.id, revision: task.revision, runtimeReady }
  const request = useRef<RecoveryRequest | null>(null)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

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

  const run = async (): Promise<void> => {
    if (!runtimeReady || disabled || busyRef.current || !snapshot || !actionable(snapshot)) return
    const action = snapshot.state === 'prepared' ? 'continue' : 'prepare'
    const taskId = task.id
    const startedRevision = task.revision
    const stillCurrent = (): boolean => mounted.current && owner.current.runtimeReady && owner.current.taskId === taskId && owner.current.revision === startedRevision
    const previous = request.current
    const pending: RecoveryRequest = previous?.taskId === taskId && previous.action === action && previous.expectedRevision === snapshot.taskRevision && previous.receiptId === snapshot.receiptId
      ? previous
      : { taskId, action, expectedRevision: snapshot.taskRevision, idempotencyKey: `public-query-${action}:${crypto.randomUUID()}`, ...(snapshot.receiptId ? { receiptId: snapshot.receiptId } : {}) }
    request.current = pending
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      if (action === 'prepare') {
        const result = await window.workwise.prepareTaskPublicQueryRecovery(taskId, { expectedRevision: pending.expectedRevision, idempotencyKey: pending.idempotencyKey, confirmed: true })
        if (!stillCurrent()) return
        if (result.prepared !== true || result.resumed !== false || result.task.id !== taskId || result.recovery.taskId !== taskId || result.recovery.taskRevision !== result.task.revision || result.recovery.state !== 'prepared' || !actionable(result.recovery)) throw new Error('Invalid recovery projection')
        request.current = null
        setSnapshot(result.recovery)
        onProjectionChange?.({ taskId, state: 'prepared' })
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
      setError(t(conflict ? 'taskPublicQueryRecoveryChanged' : action === 'prepare' ? 'taskPublicQueryRecoveryPrepareFailed' : 'taskPublicQueryRecoveryContinueFailed'))
      if (conflict) {
        request.current = null
        setSnapshot(null)
        onProjectionChange?.({ taskId, state: 'unavailable' })
        await onChanged().catch(() => undefined)
        setReload(value => value + 1)
      }
      // An uncertain transport response retains the same idempotency key.
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }

  if (!runtimeReady || !snapshot || snapshot.taskId !== task.id) return null
  const needsFreshScope = snapshot.state === 'unavailable' && snapshot.reason === 'browser_public_query_schedule_scope_required'
  if (!actionable(snapshot) && !needsFreshScope) return null
  const prepared = snapshot.state === 'prepared'
  return <section aria-label={t('taskPublicQueryRecoveryTitle')} className="mb-4 min-w-0 max-w-full break-words rounded-xl border border-ds-border bg-ds-main p-3 text-xs">
    <h3 className="font-semibold">{t('taskPublicQueryRecoveryTitle')}</h3>
    <p className="mt-2 leading-relaxed text-ds-muted">{t(needsFreshScope ? 'taskPublicQueryRecoveryFreshScopeRequired' : 'taskPublicQueryRecoveryHint')}</p>
    {!needsFreshScope && snapshot.origins?.length ? <p className="mt-2 break-all leading-relaxed text-ds-muted">{t('taskPublicQueryRecoverySites')}: {snapshot.origins.join(' · ')}</p> : null}
    {prepared ? <p role="status" className="mt-2 text-ds-muted">{t('taskPublicQueryRecoveryPrepared')}</p> : null}
    {!needsFreshScope ? <button type="button" disabled={busy || disabled} onClick={() => void run()} className="mt-3 max-w-full whitespace-normal rounded-lg bg-accent px-3 py-2 text-left font-semibold text-white disabled:opacity-50">{t(prepared ? 'taskPublicQueryRecoveryContinue' : 'taskPublicQueryRecoveryPrepare')}</button> : null}
    {error ? <p role="alert" className="mt-2 text-ds-muted">{error}</p> : null}
  </section>
}
