// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { useChatStore } from '../../store/chat-store'
import { FloatingComposer } from './FloatingComposer'

type Menu = 'skill' | 'file' | 'slash'
let host: HTMLDivElement, root: Root
let previous: ReturnType<typeof useChatStore.getState>
let pageScroll: ReturnType<typeof vi.spyOn>, globalReveal: ReturnType<typeof vi.spyOn>
const onAddFileReference = vi.fn()
const rect = (top: number, height: number): DOMRect => ({ top, bottom: top + height, left: 0, right: 500, width: 500, height, x: 0, y: top, toJSON: () => ({}) })
const skillCommands = Array.from({ length: 6 }, (_, index) => ({ id: `engineering-${index}`, name: `工程技能 ${index}`, description: '工程资料检查' }))
function Harness({ menu, seed, available, onSend = vi.fn() }: {
  menu: Menu; seed?: string; available?: typeof skillCommands; onSend?: () => void
}) {
  const [input, setInput] = useState(seed ?? (menu === 'slash' ? '/' : '@工程'))
  return createElement(FloatingComposer, {
    input, setInput, mode: 'agent', setMode: vi.fn(), busy: false, runtimeReady: true, hasActiveThread: true,
    composerModel: 'auto', composerPickList: ['auto'], onComposerModelChange: vi.fn(),
    queuedMessages: [], onRemoveQueuedMessage: vi.fn(), onSend, onInterrupt: vi.fn(),
    fileReferenceEnabled: menu === 'file', onAddFileReference,
    skillCommands: available ?? (menu === 'skill' ? skillCommands : [])
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  previous = useChatStore.getState()
  useChatStore.setState({ route: 'chat', workspaceRoot: '/workspace', activeThreadId: null, threads: [], activeThreadGoal: null })
  vi.spyOn(rendererRuntimeClient, 'searchWorkspaceReferences').mockResolvedValue({
    entries: Array.from({ length: 6 }, (_, index) => ({ path: `工程资料${index}.txt`, name: `工程资料${index}.txt`, kind: 'file', depth: 0 })),
    truncated: false, indexedAt: '2026-11-16T00:00:00.000Z'
  })
  const viewport = new EventTarget()
  Object.assign(viewport, { width: 960, height: 640, offsetTop: 0, offsetLeft: 0, scale: 1.6 })
  vi.stubGlobal('visualViewport', viewport)
  onAddFileReference.mockClear()
  pageScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  globalReveal = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove()
  useChatStore.setState(previous)
  document.body.style.zoom = ''
  document.documentElement.scrollTop = 0
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function mounted(menu: Menu, scale: number) {
  document.body.style.zoom = String(scale)
  await act(async () => root.render(createElement(Harness, { menu })))
  // The actual file menu uses its production 80ms search debounce.
  if (menu === 'file') await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
  const list = host.querySelector<HTMLElement>('.ds-card-strong > .overflow-y-auto')!
  expect(list).toBeTruthy()
  const rows = [...list.querySelectorAll<HTMLButtonElement>(':scope > button')]
  expect(rows.length).toBeGreaterThan(1)
  Object.defineProperties(list, { clientHeight: { configurable: true, value: 100 }, offsetHeight: { configurable: true, value: 100 }, clientTop: { configurable: true, value: 0 }, scrollHeight: { configurable: true, value: rows.length * 50 } })
  vi.spyOn(list, 'getBoundingClientRect').mockImplementation(() => rect(100, 100 * scale))
  rows.forEach((row, index) => vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() => rect(100 + (index * 50 - list.scrollTop) * scale, 50 * scale)))
  const textarea = host.querySelector('textarea')!
  await act(async () => { textarea.focus(); textarea.setSelectionRange(textarea.value.length, textarea.value.length) })
  textarea.scrollTop = 17; document.documentElement.scrollTop = 31; host.scrollTop = 19
  return { list, rows, textarea }
}
async function key(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
}

const cases: Array<[Menu, number]> = [['skill', 0.9], ['skill', 1.1], ['file', 0.9], ['file', 1.1], ['slash', 0.9], ['slash', 1.1]]
describe('composer keyboard suggestion visibility', () => {
  it.each(cases)('keeps each keyboard-active %s row in its own list at scale %s', async (menu, scale) => {
    const { list, rows, textarea } = await mounted(menu, scale)
    await key(textarea, 'ArrowUp') // Real production wrapping selects the last row.
    expect(list.scrollTop).toBeGreaterThan(0)
    expect(list.scrollTop).toBeLessThanOrEqual(list.scrollHeight - list.clientHeight)
    expect(rows.at(-1)!.getBoundingClientRect().bottom).toBeLessThanOrEqual(list.getBoundingClientRect().bottom + 0.5)
    expect(rows.at(-1)!.dataset.composerActive).toBe('true')
    await key(textarea, 'ArrowDown')
    expect(list.scrollTop).toBe(0)
    expect(rows[0]!.getBoundingClientRect().top).toBeGreaterThanOrEqual(list.getBoundingClientRect().top - 0.5)
    expect(rows[0]!.dataset.composerActive).toBe('true')
    expect(document.activeElement).toBe(textarea)
    expect(textarea.scrollTop).toBe(17)
    expect(host.scrollTop).toBe(19)
    expect(document.documentElement.scrollTop).toBe(31)
    expect(pageScroll).not.toHaveBeenCalled()
    expect(globalReveal).not.toHaveBeenCalled()
    expect(list.parentElement!.style.backgroundColor).toBe('var(--ds-bg-canvas)')
  })

  it('stops revealing an inactive menu and preserves mouse selection with textarea focus', async () => {
    const { list, rows, textarea } = await mounted('file', 1.1)
    await key(textarea, 'ArrowUp')
    const lastScroll = list.scrollTop
    await key(textarea, 'Escape')
    expect(host.querySelector('.ds-card-strong > .overflow-y-auto')).toBeNull()
    await key(textarea, 'ArrowDown')
    await act(async () => window.dispatchEvent(new Event('resize')))
    expect(list.scrollTop).toBe(lastScroll)
    expect(document.activeElement).toBe(textarea)
    expect(onAddFileReference).not.toHaveBeenCalled()
    expect(rows).toHaveLength(6)
  })

  it('finds a multi-word skill past the previous 40-item cut and inserts its exact ID without sending', async () => {
    const onSend = vi.fn()
    const available = Array.from({ length: 45 }, (_, index) => ({
      id: `sample-${index}`, name: `Analysis ${index}`, description: 'Analysis'
    }))
    available.push({ id: 'vendor-video-shotcraft', name: 'Video Shotcraft', description: '制作和渲染视频' })
    await act(async () => root.render(createElement(Harness, { menu: 'slash', seed: '/Video Shot', available, onSend })))
    const textarea = host.querySelector('textarea')!
    expect(host.querySelector('[role=option]')?.textContent).toContain('Video Shotcraft')
    expect(textarea.getAttribute('aria-activedescendant')).toEqual(host.querySelector('[role=option]')?.id)
    await key(textarea, 'Enter')
    expect(textarea.value).toEqual('/skill:vendor-video-shotcraft ')
    expect(host.querySelector('[role=listbox]')).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps the existing mouse choice and prevents it from taking textarea focus', async () => {
    const { rows, textarea } = await mounted('file', 0.9)
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => { rows[2]!.dispatchEvent(down); rows[2]!.click() })
    expect(down.defaultPrevented).toBe(true)
    expect(onAddFileReference).toHaveBeenCalledWith(expect.objectContaining({ relativePath: '工程资料2.txt' }))
    expect(document.activeElement).toBe(textarea)
    expect(globalReveal).not.toHaveBeenCalled()
  })
})
