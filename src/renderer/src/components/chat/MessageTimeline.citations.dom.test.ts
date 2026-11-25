// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock } from '../../agent/types'
import i18n from '../../i18n'
import { useChatStore } from '../../store/chat-store'
import { MessageTimeline } from './MessageTimeline'

const sources = [
  { sourceId: 'web_search_overview', title: 'RailWise overview', url: 'https://www.railwise.cn/overview#top' },
  { sourceId: 'web_search_duplicate', title: 'Duplicate with fragment', url: 'https://www.railwise.cn/overview#bottom' },
  { sourceId: 'web_search_product', title: 'Product documentation', url: 'https://docs.example.com/product' },
  { sourceId: 'web_fetch_release', title: 'Release notes', url: 'https://github.com/railwise-cn/railwise-ai/releases' },
  { sourceId: 'web_search_browser', title: 'Browser guide', url: 'https://ego.app/guide' },
  { sourceId: 'web_search_unsafe', title: 'Unsafe link', url: 'javascript:alert(1)' }
]

let host: HTMLDivElement
let root: Root
let previousStore: ReturnType<typeof useChatStore.getState>
let previousLanguage: string

function renderTimeline(blocks: ChatBlock[], live = ''): Promise<void> {
  return act(async () => root.render(createElement(MessageTimeline, {
    blocks,
    activeThreadId: 'citations-thread',
    runtimeConnection: 'ready',
    liveReasoning: '',
    live,
    onRetryConnection: () => undefined,
    onOpenSettings: () => undefined
  })))
}

describe('conversation source citations', () => {
  beforeEach(async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    previousStore = useChatStore.getState()
    previousLanguage = i18n.language
    await i18n.changeLanguage('en')
    useChatStore.setState({ activeThreadId: 'citations-thread', route: 'chat', busy: false, currentTurnId: null, runActivity: null })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    useChatStore.setState(previousStore)
    await i18n.changeLanguage(previousLanguage)
    vi.unstubAllGlobals()
  })

  it('shows verified tool-result sources beneath their saved assistant answer and expands the list', async () => {
    await renderTimeline([
      { kind: 'user', id: 'question', text: 'Search the latest updates.' },
      { kind: 'tool', id: 'search', summary: 'web_search', status: 'success', meta: { toolName: 'web_search', sources: sources.filter(source => source.sourceId?.startsWith('web_search_')) } },
      { kind: 'tool', id: 'fetch', summary: 'web_fetch', status: 'success', meta: { toolName: 'web_fetch', sources: [sources[3]] } },
      { kind: 'assistant', id: 'answer', text: 'Here are the latest updates.' }
    ])

    const answer = [...host.querySelectorAll('.ds-chat-answer')]
      .find(element => element.textContent?.includes('Here are the latest updates.'))
    const citationSection = answer?.querySelector<HTMLElement>('[aria-label="Web sources"]')
    expect(citationSection).toBeTruthy()
    expect(citationSection?.textContent).toContain('RailWise overview')
    expect(citationSection?.textContent).toContain('railwise.cn')
    expect(citationSection?.textContent).toContain('Search result')
    expect(citationSection?.querySelectorAll('li')).toHaveLength(3)
    expect(citationSection?.querySelector('a[href="https://www.railwise.cn/overview#top"]')?.getAttribute('target')).toBe('_blank')
    expect(citationSection?.querySelector('a[href^="javascript:"]')).toBeNull()

    const firstLink = citationSection?.querySelector('a')
    firstLink?.focus()
    expect(document.activeElement).toBe(firstLink)
    const showAll = citationSection?.querySelector('button')
    expect(showAll?.textContent).toBe('Show all 4 sources')
    expect(showAll?.getAttribute('aria-expanded')).toBe('false')
    expect(showAll?.tagName).toBe('BUTTON')
    showAll?.focus()
    expect(document.activeElement).toBe(showAll)
    await act(async () => showAll?.click())
    expect(citationSection?.querySelectorAll('li')).toHaveLength(4)
    expect(citationSection?.textContent).toContain('Page read')
    expect(citationSection?.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('shows live tool-result sources beside the live assistant response', async () => {
    useChatStore.setState({ busy: true, currentTurnId: 'turn-live' })
    await renderTimeline([
      { kind: 'user', id: 'question-live', text: 'Search the page.' },
      { kind: 'tool', id: 'search-live', summary: 'web_search', status: 'success', meta: { toolName: 'web_search', sources: [sources[0]] } }
    ], 'The live response uses this source.')

    const answer = [...host.querySelectorAll('.ds-chat-answer')]
      .find(element => element.textContent?.includes('The live response uses this source.'))
    expect(answer?.querySelector('[aria-label="Web sources"]')?.textContent).toContain('RailWise overview')
    expect(answer?.querySelector('a[href="https://www.railwise.cn/overview#top"]')).toBeTruthy()
  })
})
