// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskAttentionV1, TaskRunV1 } from '@shared/agent-workbench'
import type { ChatBlock } from '../../agent/types'
import { TaskRunStatusBar } from './TaskRunStatusBar'
import { MessageTimeline } from './MessageTimeline'
import { activeConversationControls, composerReplyQuestion } from './conversation-visibility'
import { useChatStore } from '../../store/chat-store'
import { refreshTaskState, resetTaskStateForTests } from '../../store/task-live-store'
import i18n from '../../i18n'

const threadId = 'original-conversation'
function run(id: string, status: TaskRunV1['status'], updates: Partial<TaskRunV1> = {}): TaskRunV1 {
  return {
    id, threadId: `worker-${id}`, originThreadId: threadId, childTaskIds: [], workspaceRoot: '/project', goal: `制作 ${id}`, status,
    acceptance: { kind: 'answer', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false },
    agentId: 'general', budget: { maxAttempts: 3, maxDurationMs: 600000 }, attempts: 1, replans: 0, noProgressCount: 0,
    nodes: [], artifacts: [], revision: 9, createdAt: '2026-11-20T08:00:00Z', updatedAt: '2026-11-20T08:00:00Z', ...updates
  }
}

let container: HTMLDivElement, root: Root
let tasks: TaskRunV1[], attention: TaskAttentionV1[]
const api = {
  listTaskPage: vi.fn(async () => ({ items: tasks, relatedTasks: [], attention, eventWatermark: 1 })),
  startTaskSse: vi.fn(async () => undefined), stopSse: vi.fn(async () => undefined),
  onSseEvent: vi.fn(() => () => undefined), onSseEnd: vi.fn(() => () => undefined), onSseError: vi.fn(() => () => undefined),
  notifyTask: vi.fn(async () => undefined), resumeTask: vi.fn(), retryTask: vi.fn(), pauseTask: vi.fn(),
  runtimeRequest: vi.fn(async (_path: string, _method?: string, _body?: string) => ({ ok: true, body: '{}' })),
  openTaskArtifact: vi.fn(async () => ({ ok: true })), openWorkspaceFile: vi.fn(async () => ({ ok: true }))
}

async function render(props: Partial<ComponentProps<typeof TaskRunStatusBar>> = {}): Promise<void> {
  await act(async () => {
    await refreshTaskState()
    root.render(createElement(TaskRunStatusBar, { threadId, runtimeReady: true, ...props }))
  })
}

async function renderConversation(blocks: ChatBlock[], replyQuestionId?: string,
  onComposerQuestionChange?: ComponentProps<typeof TaskRunStatusBar>['onComposerQuestionChange']): Promise<void> {
  const activeControls = activeConversationControls(blocks)
  await act(async () => {
    await refreshTaskState()
    root.render(createElement('div', null,
      createElement(MessageTimeline, { blocks, activeControls, replyQuestionId,
        activeThreadId: threadId, runtimeConnection: 'ready', liveReasoning: '', live: '',
        onRetryConnection: () => undefined, onOpenSettings: () => undefined,
        taskActivity: createElement(TaskRunStatusBar, { threadId, runtimeReady: true, composerReplies: true,
          conversationControls: activeControls, onComposerQuestionChange }) }),
      createElement('div', { className: 'ds-composer-shell' }, createElement('textarea'))
    ))
  })
}

function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find(button => button.textContent === label)
}

beforeEach(async () => {
  vi.clearAllMocks()
  api.runtimeRequest.mockResolvedValue({ ok: true, body: '{}' })
  resetTaskStateForTests()
  tasks = []; attention = []
  await i18n.changeLanguage('zh')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { workwise: api })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); resetTaskStateForTests(); container.remove() })

describe('task actions in the original conversation', () => {
  it('shows one approval in message order for a replayed request and submits only one decision', async () => {
    tasks = [run('permission', 'waiting_approval', { presentation: { reason: 'approval_required', actions: ['approve', 'deny'] } })]
    attention = [{ id: 'persisted', requestId: 'approval-id', taskId: 'permission', ownerId: 'permission', ownerKind: 'task',
      threadId: 'worker-permission', kind: 'approval', title: '需要授权', message: 'Approve access', status: 'pending',
      revision: 1, createdAt: tasks[0].createdAt, updatedAt: tasks[0].updatedAt }]
    const previous = useChatStore.getState()
    let finish!: () => void
    const resolveApproval = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const approval: ChatBlock = { kind: 'approval', id: 'initial', approvalId: 'approval-id', summary: 'Approve access', status: 'pending' }
    const blocks: ChatBlock[] = [
      { kind: 'assistant', id: 'before', text: '已收到资料。' }, approval, { ...approval, id: 'replayed' },
      { kind: 'assistant', id: 'after', text: '以下是后续说明。' }
    ]
    expect(activeConversationControls([approval, { ...approval, status: 'allowed' }, ...blocks])).toEqual([])
    useChatStore.setState({ runtimeConnection: 'ready', route: 'chat', activeThreadId: threadId, resolveApproval })
    try {
      await renderConversation(blocks)
      const allow = i18n.t('common:approvalAllow')
      const choices = [...container.querySelectorAll('button')].filter(control => control.textContent === allow)
      expect(choices).toHaveLength(1)
      expect(choices[0].closest('.ds-message-timeline-content')).not.toBeNull()
      expect(choices[0].closest('.ds-composer-shell')).toBeNull()
      const content = container.querySelector('.ds-message-timeline-content')!.textContent!
      expect(content.indexOf('已收到资料。')).toBeLessThan(content.indexOf(allow))
      expect(content.indexOf(allow)).toBeLessThan(content.indexOf('以下是后续说明。'))
      await act(async () => { choices[0].click(); choices[0].click() })
      expect(resolveApproval).toHaveBeenCalledExactlyOnceWith('replayed', 'allow')
      expect(api.runtimeRequest.mock.calls.filter(([, method]) => method !== 'GET')).toEqual([])
      expect(api.resumeTask).not.toHaveBeenCalled()
      expect(button('继续任务')).toBeUndefined()
      await act(async () => finish())
    } finally {
      useChatStore.setState(previous)
    }
  })

  it('uses the ordinary composer for one open question and keeps structured questions available', async () => {
    const open: ChatBlock = { kind: 'user_input', id: 'question', requestId: 'input-id', status: 'pending',
      questions: [{ id: 'document', header: '资料', question: '请提供资料名称', options: [] }] }
    expect(composerReplyQuestion([open])?.id).toBe(open.id)
    await renderConversation([open], open.id)
    expect(container.textContent).toContain('请提供资料名称')
    expect(container.textContent).toContain('在下方输入框直接回复')
    expect(container.querySelectorAll('textarea')).toHaveLength(1)
    expect(container.querySelector('.ds-message-timeline-content textarea')).toBeNull()

    const structured = { ...open, questions: [{ ...open.questions[0], options: [{ label: '报告一', description: '第一份报告' }] }] }
    expect(composerReplyQuestion([structured])).toBeUndefined()
    await renderConversation([structured])
    expect(container.textContent).toContain('报告一')
    expect(container.textContent).not.toContain('在下方输入框直接回复')

    tasks = [run('worker-question', 'waiting_user', { activeTurnId: 'waiting-turn' })]
    attention = [{ id: 'worker-attention', requestId: 'worker-request', taskId: 'worker-question', ownerId: 'worker-question', ownerKind: 'task',
      threadId: 'worker-worker-question', kind: 'question', title: '需要补充信息', message: '请提供资料名称', status: 'pending',
      payload: { questions: open.questions }, revision: 1, createdAt: tasks[0].createdAt, updatedAt: tasks[0].updatedAt }]
    const onComposerQuestionChange = vi.fn()
    await render({ composerReplies: true, onComposerQuestionChange })
    expect(container.textContent).toContain('在下方输入框直接回复')
    expect(container.querySelector('textarea')).toBeNull()
    expect(onComposerQuestionChange).toHaveBeenLastCalledWith({ taskId: 'worker-question', threadId,
      requestId: 'worker-request', questionId: 'document', label: '请提供资料名称' })
    attention = []
    await render({ composerReplies: true, onComposerQuestionChange })
    expect(onComposerQuestionChange).toHaveBeenLastCalledWith(null)
  })

  it('binds a task question to the composer when another conversation control is also open', async () => {
    tasks = [run('worker-question', 'waiting_user', { activeTurnId: 'waiting-turn' })]
    const question = { id: 'website', header: '官网', question: '请提供官网网址。', options: [] }
    attention = [{ id: 'worker-attention', requestId: 'worker-request', taskId: 'worker-question', ownerId: 'worker-question', ownerKind: 'task',
      threadId: 'worker-worker-question', kind: 'question', title: '需要补充信息', message: '请提供官网网址。', status: 'pending',
      payload: { questions: [question] }, revision: 1, createdAt: tasks[0].createdAt, updatedAt: tasks[0].updatedAt }]
    const approval: ChatBlock = { kind: 'approval', id: 'approval-block', approvalId: 'approval-id', summary: '读取本地工作区', status: 'pending' }
    const openQuestion: ChatBlock = { kind: 'user_input', id: 'question-block', requestId: 'worker-request', status: 'pending',
      questions: [{ id: question.id, header: question.header, question: question.question, options: [] }] }
    const onComposerQuestionChange = vi.fn()

    await renderConversation([approval, openQuestion], undefined, onComposerQuestionChange)

    expect(composerReplyQuestion(activeConversationControls([approval, openQuestion]))).toBeUndefined()
    expect(onComposerQuestionChange).toHaveBeenLastCalledWith({ taskId: 'worker-question', threadId,
      requestId: 'worker-request', questionId: 'website', label: '请提供官网网址。' })
  })

  it('continues the same durable run once and uses the existing composer and chooser', async () => {
    tasks = [run('paused-task', 'paused', { presentation: { reason: 'paused', actions: ['resume', 'supplement'] } })]
    api.resumeTask.mockResolvedValue({ task: tasks[0] })
    const onSupplement = vi.fn(), onPickAttachments = vi.fn()
    await render({ onSupplement, onPickAttachments })
    expect(button('打开任务工作台')).toBeUndefined()
    await act(async () => { button('补充当前任务')!.click(); button('选择资料')!.click() })
    expect(onSupplement).toHaveBeenCalledOnce()
    expect(onPickAttachments).toHaveBeenCalledOnce()
    await act(async () => { button('继续任务')!.click(); button('继续任务')!.click() })
    expect(api.resumeTask).toHaveBeenCalledExactlyOnceWith('paused-task', { expectedRevision: 9, idempotencyKey: expect.any(String) })
    expect(container.textContent).toContain('继续请求已提交')
  })

  it('still handles an older worker approval in the conversation without duplicating the timeline card', async () => {
    tasks = [run('newer', 'running', { updatedAt: '2026-11-20T09:00:00Z' }), run('older', 'waiting_approval')]
    attention = [{ id: 'request-row', requestId: 'approval-id', taskId: 'older', ownerId: 'older', ownerKind: 'task',
      threadId: 'worker-older', kind: 'approval', title: '需要授权', message: 'Run request_host_shell\nCommand (JSON): "a command"',
      presentation: { reason: 'approval_host_shell', scope: 'host', actions: ['approve', 'deny'] },
      status: 'pending', revision: 1, createdAt: tasks[1].createdAt, updatedAt: tasks[1].updatedAt }]
    await render()
    expect(container.querySelector('[aria-label="制作 older"]')).not.toBeNull()
    expect(container.querySelector('details')?.open).toBe(false)
    await act(async () => button('允许此操作')!.click())
    expect(api.runtimeRequest.mock.calls.filter(([, method]) => method === 'POST')).toEqual([
      ['/v1/approvals/approval-id', 'POST', JSON.stringify({ decision: 'allow' })]
    ])
    expect(api.resumeTask).not.toHaveBeenCalled()
    await render({ inlineRequests: ['approval-id'] })
    expect(button('允许此操作')).toBeUndefined()
  })

  it('uses the selected card to address one of two ongoing task groups in the conversation', async () => {
    tasks = [run('background-a', 'running'), run('background-b', 'queued')]
    api.pauseTask.mockResolvedValue(tasks[1])
    await render()
    const second = container.querySelector('[aria-label="制作 background-b"]')
    const pause = [...second!.querySelectorAll('button')].find(button => button.textContent === '暂停')
    await act(async () => pause!.click())
    expect(api.pauseTask).toHaveBeenCalledExactlyOnceWith('background-b', { expectedRevision: 9, idempotencyKey: expect.any(String) })
  })

  it('shows legacy worker results, avoids the durable duplicate, and opens an ordinary workspace MP4', async () => {
    tasks = [run('video', 'completed', {
      finalResponse: '影片已生成并验证。',
      artifacts: [{ id: 'video-artifact', relativePath: 'results/output.mp4', validation: 'valid', createdAt: '2026-11-20T08:00:00Z' }]
    })]
    await render()
    expect(container.textContent).toContain('影片已生成并验证。')
    await act(async () => button('1 个成果')!.click())
    await act(async () => button('output.mp4')!.click())
    expect(api.openWorkspaceFile).toHaveBeenCalledExactlyOnceWith({ workspaceRoot: '/project', path: 'results/output.mp4' })
    expect(api.openTaskArtifact).not.toHaveBeenCalled()
    await render({ visibleMessageIds: new Set(['item_command_task_result_video_receipt']) })
    expect(container.textContent).not.toContain('影片已生成并验证。')
    expect(button('output.mp4')).toBeTruthy()
  })

  it('shows the delegated worker steps in the original message flow through completion without mutation controls', async () => {
    tasks = [run('review', 'running')]
    const updatedAt = tasks[0].updatedAt
    const checklist = {
      threadId: 'worker-review', updatedAt,
      items: [
        { id: 'review-report', content: '核对合成报告', status: 'completed', createdAt: updatedAt, updatedAt },
        { id: 'review-heading', content: '复核表头', status: 'pending', createdAt: updatedAt, updatedAt }
      ]
    }
    api.runtimeRequest.mockImplementation(async (path, method) => ({
      ok: true,
      body: JSON.stringify(path === '/v1/threads/worker-review/todos' && method === 'GET' ? { todos: checklist } : {})
    }))
    const blocks: ChatBlock[] = [{ kind: 'assistant', id: 'accepted', text: '开始审核报告。' }]
    await renderConversation(blocks)
    const timeline = container.querySelector('.ds-message-timeline-content')!
    expect(timeline.querySelector('summary')?.textContent).toBe('执行步骤 · 已完成 1 / 2')
    expect(timeline.textContent).toContain('核对合成报告')
    expect(timeline.querySelector('details select')).toBeNull()
    expect(container.querySelector('.ds-composer-shell details')).toBeNull()

    checklist.items[1].status = 'completed'
    tasks = [{ ...tasks[0], status: 'completed', revision: 10 }]
    await renderConversation(blocks)
    expect(timeline.querySelector('summary')?.textContent).toBe('执行步骤 · 已完成 2 / 2')
    expect(timeline.textContent).toContain('复核表头')
    expect(api.runtimeRequest.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  })
})
