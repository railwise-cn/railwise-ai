import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskIntentCard } from '@shared/task-command'
import { useChatStore } from '../../store/chat-store'
import { refreshTaskState, useTaskState } from '../../store/task-live-store'

export function TaskIntentChoiceCard({ card, message }: { card: TaskIntentCard; message: string }) {
  const { t } = useTranslation('common')
  const state = useTaskState()
  const [busy, setBusy] = useState(false)
  const [resolved, setResolved] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const settled = resolved || (state.ready && !state.attention.some(item => item.id === card.attentionId && item.status === 'pending'))
  const choose = async (intent: 'supplement' | 'new') => {
    if (submitting.current || settled || !card.choices.includes(intent)) return
    submitting.current = true
    setBusy(true); setError('')
    try {
      await window.workwise.coordinateTaskCommand({ threadId: card.threadId, taskId: card.taskId, resolveAttentionId: card.attentionId,
        intent, idempotencyKey: `attention:${card.attentionId}:${intent}`, request: card.request })
      setResolved(true)
      await refreshTaskState()
      const store = useChatStore.getState()
      await store.refreshThreads()
      if (store.activeThreadId === card.threadId) await store.selectThread(card.threadId)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { submitting.current = false; setBusy(false) }
  }
  return <section className="mt-2 rounded-xl border border-ds-border bg-ds-card p-4 text-sm text-ds-ink">
    <p>{settled ? t('capabilityStateChecked') : message}</p>
    {!settled ? <div className="mt-3 flex flex-wrap gap-2">{card.choices.map(choice => <button key={choice} type="button" disabled={busy} onClick={() => void choose(choice)} className="rounded-lg border border-ds-border px-3 py-2 text-xs font-medium disabled:opacity-50">{t(choice === 'supplement' ? 'taskCommandChooseSupplement' : 'taskCommandChooseNew')}</button>)}</div> : null}
    {error ? <p role="alert" className="mt-2 text-xs text-ds-muted">{error}</p> : null}
  </section>
}
