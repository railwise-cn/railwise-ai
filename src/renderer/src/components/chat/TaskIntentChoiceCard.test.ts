// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { TaskIntentCard } from '@shared/task-command'
import i18n from '../../i18n'
import { TaskIntentChoiceCard } from './TaskIntentChoiceCard'

const store = vi.hoisted(() => ({ activeThreadId: 'origin', refreshThreads: vi.fn(async () => undefined), selectThread: vi.fn(async () => undefined) }))
vi.mock('../../store/chat-store', () => ({ useChatStore: { getState: () => store } }))
vi.mock('../../store/task-live-store', () => ({ useTaskState: () => ({ ready: false, attention: [] }), refreshTaskState: vi.fn(async () => undefined) }))
const card: TaskIntentCard = { threadId: 'origin', taskId: 'task', attentionId: 'attention', request: { prompt: '需要调整', attachmentIds: ['image'], workspaceReferences: [] }, choices: ['supplement', 'new'] }
let root: ReturnType<typeof createRoot> | undefined
let container: HTMLDivElement | undefined
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it('submits the original request with a stable decision key, suppresses double clicks and renders the settled state', async () => {
  await i18n.changeLanguage('zh')
  const coordinate = vi.fn(async () => ({ kind: 'input_queued' }))
  vi.stubGlobal('window', Object.assign(window, { workwise: { coordinateTaskCommand: coordinate } }))
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => root!.render(createElement(TaskIntentChoiceCard, { card, message: '请选择归属' })))
  expect(container.textContent).toContain('请选择归属')
  const buttons = container.querySelectorAll('button')
  expect(buttons).toHaveLength(2)
  await act(async () => { buttons[0]!.click(); buttons[0]!.click() })
  expect(coordinate).toHaveBeenCalledOnce()
  expect(coordinate).toHaveBeenCalledWith({ threadId: 'origin', taskId: 'task', resolveAttentionId: 'attention', intent: 'supplement', idempotencyKey: 'attention:attention:supplement', request: card.request })
  expect(container.querySelectorAll('button')).toHaveLength(0)
  expect(store.selectThread).toHaveBeenCalledWith('origin')
})
