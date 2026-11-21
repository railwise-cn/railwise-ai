// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { useChatStore } from '../../store/chat-store'
import { ConversationChecklist } from './ConversationChecklist'

it('shows the existing conversation checklist inside a collapsed section and edits the saved item', async () => {
  await i18n.changeLanguage('zh')
  const previous = useChatStore.getState()
  const now = '2026-11-21T04:00:00Z'
  const item = { id: 'one', content: '核对报告', status: 'in_progress' as const, createdAt: now, updatedAt: now }
  const update = vi.fn(async () => undefined)
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    useChatStore.setState({
      activeThreadTodos: { threadId: 'another-conversation', updatedAt: now, items: [item] },
      setActiveThreadTodoStatus: update
    })
    await act(async () => root.render(createElement(ConversationChecklist, { threadId: 'test-conversation', onOpenPlan: vi.fn() })))
    expect(host.querySelector('details')).toBeNull()
    await act(async () => useChatStore.setState({ activeThreadTodos: { threadId: 'test-conversation', updatedAt: now, items: [item] } }))
    const details = host.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toContain('已完成 0 / 1')
    details.open = true
    const status = details.querySelector('select')!
    expect(status.getAttribute('aria-label')).toBe('核对报告的状态')
    await act(async () => {
      status.value = 'completed'
      status.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(update).toHaveBeenCalledExactlyOnceWith('one', 'completed')
  } finally {
    await act(async () => root.unmount())
    useChatStore.setState(previous)
  }
})
