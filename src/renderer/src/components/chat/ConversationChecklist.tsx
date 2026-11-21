import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { ThreadTodoStatus } from '../../agent/types'
import { useChatStore } from '../../store/chat-store'

const statuses: ThreadTodoStatus[] = ['pending', 'in_progress', 'completed']

export function ConversationChecklist({ threadId, onOpenPlan }: {
  threadId: string
  onOpenPlan: () => void
}): ReactElement | null {
  const { t } = useTranslation('common')
  const checklist = useChatStore(state => state.activeThreadTodos?.threadId === threadId ? state.activeThreadTodos : null)
  const updateStatus = useChatStore(state => state.setActiveThreadTodoStatus)
  const clearChecklist = useChatStore(state => state.clearActiveThreadTodos)
  if (!checklist?.items.length) return null

  const completed = checklist.items.filter(item => item.status === 'completed').length
  return (
    <details className="min-w-0 border-ds-border-muted py-1.5 text-xs text-ds-muted [&:not(:first-child)]:border-t">
      <summary className="cursor-pointer focus-visible:outline-offset-2">
        {t('conversationChecklistProgress', { completed, total: checklist.items.length })}
      </summary>
      <ul className="mt-1 max-h-[min(22dvh,9rem)] space-y-0.5 overflow-y-auto pl-3">
        {checklist.items.map(item => (
          <li key={item.id} className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 py-1">
            <span className="min-w-0 flex-1 basis-32 break-words text-ds-ink">{item.content}</span>
            <select
              className="max-w-full rounded-md border border-ds-border bg-ds-card px-1 py-0.5 text-xs text-ds-muted"
              aria-label={t('conversationChecklistItemStatus', { item: item.content })}
              value={item.status}
              onChange={event => void updateStatus(item.id, event.currentTarget.value as ThreadTodoStatus)}
            >
              {statuses.map(status => <option key={status} value={status}>{t(`todoStatus.${status}`)}</option>)}
            </select>
          </li>
        ))}
      </ul>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-3">
        {checklist.items.some(item => item.source?.kind === 'plan') ? (
          <button type="button" className="text-accent hover:underline" onClick={onOpenPlan}>{t('rightPanelPlan')}</button>
        ) : null}
        <button type="button" className="hover:underline" onClick={() => void clearChecklist()}>{t('todoClear')}</button>
      </div>
    </details>
  )
}
