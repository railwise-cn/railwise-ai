import { useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskRunV1 } from '@shared/agent-workbench'

/** Adding time is a separate explicit action; it never resumes or changes authority. */
export function TaskBudgetControl({ task, onChanged }: { task: TaskRunV1; onChanged: () => Promise<unknown> }): ReactElement | null {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const request = useRef<{ expectedRevision: number; idempotencyKey: string; additionalExecutionMs: number } | null>(null)
  if (task.budget.version !== 2 || task.status !== 'paused' || task.parentTaskId || task.retryOfTaskId || task.rootTaskId && task.rootTaskId !== task.id) return null
  const extend = async (): Promise<void> => {
    if (busy) return
    request.current ??= { expectedRevision: task.revision, idempotencyKey: `budget:${crypto.randomUUID()}`, additionalExecutionMs: 600_000 }
    setBusy(true)
    setNotice('')
    try {
      await window.workwise.extendTaskBudget(task.id, request.current)
      request.current = null
      setNotice(t('taskBudgetExtended'))
      await onChanged().catch(() => undefined)
    } catch (error) {
      // Preserve the same key after an uncertain response. Refreshing cannot
      // turn a transport retry into a second extension.
      setNotice(error instanceof Error ? error.message : t('taskBudgetExtendFailed'))
      if ((error as { status?: number })?.status === 409) {
        request.current = null
        await onChanged().catch(() => undefined)
      }
    } finally { setBusy(false) }
  }
  return <div className="mb-4 rounded-lg border border-ds-border p-3 text-xs">
    <button type="button" disabled={busy} onClick={() => void extend()} className="rounded-lg border border-ds-border px-3 py-2 disabled:opacity-50">{t('taskBudgetExtend')}</button>
    <p className="mt-2 text-ds-muted">{t('taskBudgetExtendHint')}</p>
    {notice ? <p role="status" className="mt-2 text-ds-muted">{notice}</p> : null}
  </div>
}
