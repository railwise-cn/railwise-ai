// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatBlockFromItem } from '../../agent/runtime-mapper'
import type { ChatBlock } from '../../agent/types'
import i18n from '../../i18n'
import { useChatStore } from '../../store/chat-store'
import { RuntimeBanner } from '../RuntimeBanner'
import { MessageTimeline } from './MessageTimeline'
import { MessageBubble } from './message-timeline-bubbles'

const failedTools: ChatBlock[] = [
  { kind: 'tool', id: 'retry-first', summary: 'browser_open: target page', detail: 'First diagnostic: token=top-secret', status: 'error' },
  { kind: 'tool', id: 'retry-second', summary: 'browser_read: list', detail: 'Second diagnostic: timed out', status: 'error' }
]
const pendingQuestion: ChatBlock = {
  kind: 'user_input',
  id: 'input',
  requestId: 'input-request',
  status: 'pending',
  questions: [{ id: 'scope', header: 'Choose', question: 'Which document should I use?', options: [] }]
}
const failedCommand: ChatBlock = {
  kind: 'tool', id: 'command', status: 'error', toolKind: 'command_execution',
  summary: 'bash: run command', detail: 'Command stderr: token=diagnostic-secret',
  meta: { toolName: 'bash', command: 'cmd.exe /c echo shotcraft-test', exit_code: 1 }
}

let container: HTMLDivElement
let root: Root

function control(text: string): HTMLElement {
  const button = [...container.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .find(element => element.textContent?.includes(text))
  if (!button) throw new Error(`Missing control ${text}`)
  return button
}

describe('conversation execution details', () => {
  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    await i18n.changeLanguage('en')
    useChatStore.setState({ activeThreadId: 'thread-test', route: 'chat', busy: false, currentTurnId: null, runActivity: null })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('shows current protocol activity without using progress from a previous turn', async () => {
    const activity = { threadId: 'thread-test', runId: 'current', status: 'waiting_approval', phase: 'working' } as const
    useChatStore.setState({ currentTurnId: activity.runId, busy: true, runActivity: activity })
    await act(async () => root.render(createElement(MessageTimeline, {
      blocks: [{ kind: 'user', id: 'user', text: 'Read the announcement' }],
      activeThreadId: 'thread-test', runtimeConnection: 'ready', liveReasoning: '', live: '',
      onRetryConnection: () => undefined, onOpenSettings: () => undefined
    })))

    expect(container.querySelector('[role="status"]')?.textContent).toContain('Waiting for approval')
    await act(async () => useChatStore.setState({ runActivity: { ...activity, status: 'running', phase: 'researching' } }))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Researching…')
    await act(async () => useChatStore.setState({ currentTurnId: 'newer' }))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Continuing the task…')
  })

  it('places a conversation failure below the relevant messages with collapsed neutral details', async () => {
    const onRetryConnection = () => undefined
    const onOpenSettings = () => undefined
    await act(async () => root.render(createElement(MessageTimeline, {
      blocks: [
        { kind: 'user', id: 'url', text: 'www.railwise.cn' },
        { kind: 'assistant', id: 'partial', text: 'I will read the website.' }
      ],
      activeThreadId: 'thread-test', runtimeConnection: 'ready', liveReasoning: '', live: '',
      onRetryConnection, onOpenSettings,
      runtimeNotice: createElement(RuntimeBanner, {
        message: 'The website could not be read.', detail: 'Connection timed out.',
        inConversation: true, runtimeReady: true, stageInsetClass: 'px-3.5',
        t: (key: string) => i18n.t(`common:${key}`), onRetryConnection, onOpenSettings
      })
    })))
    const summary = container.querySelector('[role="status"]')
    expect(summary?.textContent).toContain('The website could not be read.')
    expect(summary?.className).toContain('text-ds-muted')
    const text = container.textContent ?? ''
    expect(text.indexOf('I will read the website.')).toBeLessThan(text.indexOf('The website could not be read.'))
    expect(text).not.toContain('Connection timed out.')
    const details = control(i18n.t('common:runtimeErrorDetails'))
    expect(details.getAttribute('aria-expanded')).toBe('false')
    await act(async () => details.click())
    expect(container.querySelector('pre')?.textContent).toContain('Connection timed out.')
    expect(container.querySelector('pre')?.className).toContain('text-ds-muted')
  })

  it.each(['concise', 'standard', 'developer'] as const)('keeps recoverable errors behind neutral disclosures in %s mode', async viewMode => {
    await act(async () => root.render(createElement(MessageTimeline, {
      blocks: [
        { kind: 'user', id: 'user', text: 'Read the announcement' },
        ...failedTools,
        pendingQuestion
      ],
      activeThreadId: 'thread-test',
      runtimeConnection: 'ready',
      liveReasoning: '',
      live: '',
      viewMode,
      onRetryConnection: () => undefined,
      onOpenSettings: () => undefined
    })))

    const details = control('Execution details')
    expect(details.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('Which document should I use?')
    expect(container.querySelector('textarea')).toBeTruthy()
    expect(container.textContent).not.toMatch(/Used 2 tools|Execution failed|diagnostic:/)
    expect(container.querySelector('[class*="text-red-"]')).toBeNull()

    await act(async () => details.click())
    const group = control('Used 2 tools')
    expect(group.getAttribute('aria-expanded')).toBe('false')
    expect(group.className).not.toContain('text-red-')
    await act(async () => group.click())
    expect(container.textContent).not.toMatch(/First diagnostic|Second diagnostic/)
    expect(container.querySelector('[class*="text-red-"]')).toBeNull()

    const firstFailure = control(viewMode === 'developer' ? 'Browser open' : 'Execution failed')
    await act(async () => firstFailure.click())
    expect(firstFailure.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('First diagnostic: token=[REDACTED]')
    expect(container.querySelector('[class*="text-red-"]')).toBeNull()
    expect(container.textContent).not.toMatch(/top-secret|Second diagnostic/)
    await act(async () => firstFailure.click())
    expect(container.textContent).not.toContain('First diagnostic')
    await act(async () => details.click())
    expect(container.textContent).not.toContain('Used 2 tools')
    expect(container.textContent).toContain('Which document should I use?')
  })

  it.each(['live', 'replayed'] as const)('keeps a %s command, retry and tool-level input request behind quiet disclosures', async lifecycle => {
    await i18n.changeLanguage('zh-CN')
    const timestamp = '2026-11-18T05:40:00.000Z'
    const retryText = '本次模型或工具尝试异常，任务将从检查点自动继续。'
    const retry = lifecycle === 'replayed'
      ? chatBlockFromItem({
          id: 'retry', turnId: 'turn', threadId: 'thread-test', role: 'system', status: 'failed',
          kind: 'error', createdAt: timestamp, code: 'turn_attempt_exception', message: retryText, severity: 'warning'
        })
      : { kind: 'system' as const, id: 'retry', createdAt: timestamp, code: 'turn_attempt_exception', text: retryText, severity: 'warning' as const }
    if (!retry) throw new Error('Missing replayed retry record')
    const user: ChatBlock = { kind: 'user', id: 'request', text: '制作视频' }
    const toolPrompt: ChatBlock = {
      kind: 'tool', id: 'tool-input', status: lifecycle === 'live' ? 'running' : 'success',
      summary: 'request_user_input: input preparation', detail: 'raw tool prompt payload', meta: { toolName: 'request_user_input' }
    }
    const render = async (blocks: ChatBlock[]): Promise<void> => {
      await act(async () => root.render(createElement(MessageTimeline, {
        blocks, activeThreadId: 'thread-test', runtimeConnection: 'ready', liveReasoning: '', live: '',
        viewMode: 'developer', onRetryConnection: () => undefined, onOpenSettings: () => undefined
      })))
    }
    if (lifecycle === 'live') {
      useChatStore.setState({ busy: true, currentTurnId: 'turn' })
      await render([user, toolPrompt])
      expect(control('执行详情').getAttribute('aria-expanded')).toBe('false')
    }
    await render([user, failedCommand, retry, toolPrompt, pendingQuestion])

    const disclosure = control('执行详情')
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(disclosure.className).toContain('text-ds-muted')
    expect(container.textContent).toContain('Which document should I use?')
    expect(container.textContent).not.toMatch(/执行失败|重试记录|检查点|cmd\.exe|raw tool prompt/)

    await act(async () => disclosure.click())
    const group = control('运行了 1 条命令')
    expect(group.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toMatch(/重试记录|检查点|cmd\.exe|raw tool prompt/)

    await act(async () => group.click())
    const retryRecord = control('重试记录')
    const command = control('cmd.exe /c echo shotcraft-test')
    expect(retryRecord.getAttribute('aria-expanded')).toBe('false')
    expect(command.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toMatch(/检查点|Command stderr|raw tool prompt/)

    await act(async () => command.click())
    expect(container.textContent).toContain('Command stderr: token=[REDACTED]')
    expect(container.textContent).not.toContain('diagnostic-secret')
    expect(container.querySelector('[class*="text-red-"], [class*="bg-red-"]')).toBeNull()
    await act(async () => retryRecord.click())
    expect(container.textContent).toContain(retryText)
    expect(container.textContent).not.toContain('Command stderr')
    expect(retryRecord.className).toContain('text-ds-muted')
  })

  it('keeps approval decisions and approval errors available outside the execution history', async () => {
    const approval: ChatBlock = {
      kind: 'approval', id: 'approval', approvalId: 'approval-request', status: 'pending', summary: 'Allow access to the workspace?'
    }
    const render = async (block: ChatBlock): Promise<void> => {
      await act(async () => root.render(createElement(MessageTimeline, {
        blocks: [failedCommand, block], activeThreadId: 'thread-test', runtimeConnection: 'ready', liveReasoning: '', live: '',
        onRetryConnection: () => undefined, onOpenSettings: () => undefined
      })))
    }

    await render(approval)
    expect(control('Allow')).toBeTruthy()
    expect(control('Deny')).toBeTruthy()
    expect(control('Execution details').getAttribute('aria-expanded')).toBe('false')
    await render({ ...approval, status: 'error', errorMessage: 'Workspace access could not be approved.' })
    expect(container.textContent).toContain('Workspace access could not be approved.')
    expect(container.textContent).not.toContain('Command stderr')
    expect(control('Execution details').getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps the standalone command bubble collapsed and neutral on expansion', async () => {
    await act(async () => root.render(createElement(MessageBubble, { block: failedCommand })))
    const command = control('Command')
    expect(command.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toMatch(/run command|Command stderr|exit 1/)
    await act(async () => command.click())
    expect(container.textContent).toContain('Command stderr: token=[REDACTED]')
    expect(container.textContent).toContain('exit 1')
    expect(container.querySelector('[class*="text-red-"], [class*="bg-red-"]')).toBeNull()
  })
})

describe('conversation empty state scrolling', () => {
  it('leaves room for the empty hero and follows the first actual message', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const host = document.createElement('div')
    document.body.append(host)
    const timeline = createRoot(host)
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined)
    const render = (activeThreadId: string, blocks: ChatBlock[]) => act(async () => timeline.render(createElement(MessageTimeline, {
      blocks, activeThreadId, runtimeConnection: 'ready', liveReasoning: '', live: '',
      onRetryConnection: () => undefined, onOpenSettings: () => undefined
    })))
    try {
      await render('new-thread', [])
      const scroller = host.querySelector<HTMLElement>('.ds-chat-timeline')!
      expect(scroller.scrollTop).toBe(0)
      expect(scrollIntoView).not.toHaveBeenCalled()

      await render('new-thread', [{ kind: 'user', id: 'first-message', text: 'Check the file' }])
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' })
      scrollIntoView.mockClear()

      scroller.scrollTop = 300
      await render('another-empty-thread', [])
      expect(scroller.scrollTop).toBe(0)
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      await act(async () => timeline.unmount())
      host.remove()
      scrollIntoView.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
