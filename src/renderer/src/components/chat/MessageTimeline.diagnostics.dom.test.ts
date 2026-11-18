// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock } from '../../agent/types'
import i18n from '../../i18n'
import { useChatStore } from '../../store/chat-store'
import { MessageTimeline } from './MessageTimeline'

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
    useChatStore.setState({ activeThreadId: 'thread-test', route: 'chat', busy: false })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
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
    expect(container.textContent).not.toMatch(/top-secret|Second diagnostic/)
    await act(async () => firstFailure.click())
    expect(container.textContent).not.toContain('First diagnostic')
    await act(async () => details.click())
    expect(container.textContent).not.toContain('Used 2 tools')
    expect(container.textContent).toContain('Which document should I use?')
  })
})
