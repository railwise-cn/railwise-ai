// @vitest-environment happy-dom
import { act, createElement, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import i18n from '../../i18n'
import { useChatStore } from '../../store/chat-store'
import { FloatingComposer } from './FloatingComposer'
import type { CallableCapabilityChoice } from '@shared/callable-capabilities'

type Menu = 'skill' | 'file' | 'slash' | 'toolbar'
let host: HTMLDivElement, root: Root
let previous: ReturnType<typeof useChatStore.getState>
let pageScroll: ReturnType<typeof vi.spyOn>, globalReveal: ReturnType<typeof vi.spyOn>
const onAddFileReference = vi.fn()
const rect = (top: number, height: number): DOMRect => ({ top, bottom: top + height, left: 0, right: 500, width: 500, height, x: 0, y: top, toJSON: () => ({}) })
const skillCommands = Array.from({ length: 6 }, (_, index) => ({ id: `engineering-${index}`, name: `工程技能 ${index}`, description: '工程资料检查' }))
function Harness({ menu, seed, available, onSend = vi.fn(), composerProps }: {
  menu: Menu; seed?: string; available?: typeof skillCommands; onSend?: () => void
  composerProps?: Partial<ComponentProps<typeof FloatingComposer>>
}) {
  const [input, setInput] = useState(seed ?? (menu === 'slash' ? '/' : '@工程'))
  const [selected, setSelected] = useState<CallableCapabilityChoice[]>([])
  return createElement(FloatingComposer, {
    input, setInput, mode: 'agent', setMode: vi.fn(), busy: false, runtimeReady: true, hasActiveThread: true,
    composerModel: 'auto', composerPickList: ['auto'], onComposerModelChange: vi.fn(),
    queuedMessages: [], onRemoveQueuedMessage: vi.fn(), onSend, onInterrupt: vi.fn(),
    fileReferenceEnabled: menu === 'file', onAddFileReference,
    skillCommands: available ?? (menu === 'file' ? [] : skillCommands),
    selectedCapabilities: selected,
    onSelectCapability: choice => setSelected(current => [...current.filter(item => item.kind !== choice.kind || item.id !== choice.id), choice]),
    onRemoveCapability: choice => setSelected(current => current.filter(item => item.kind !== choice.kind || item.id !== choice.id)),
    ...composerProps
  })
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  await i18n.changeLanguage('en')
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
async function key(textarea: HTMLElement, value: string): Promise<void> {
  await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })))
}

function buttonByLabel(text: string, scope: ParentNode = host): HTMLButtonElement {
  const button = [...scope.querySelectorAll('button')].find(element =>
    element.getAttribute('aria-label') === text || element.textContent?.trim() === text
  )
  if (!button) throw new Error(`Missing button ${text}`)
  return button
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => button.click())
}

async function paint(): Promise<void> {
  await act(async () => { await new Promise(requestAnimationFrame) })
}

it('places task controls inside the input shell and keeps the existing draft', async () => {
  await act(async () => root.render(createElement(Harness, {
    menu: 'toolbar', seed: '当前草稿',
    composerProps: { renderTaskControls: () => createElement('button', { type: 'button' }, '审批') }
  })))
  const shell = host.querySelector('.ds-composer-shell')!
  expect(shell.contains(buttonByLabel('审批'))).toBe(true)
  expect(shell.querySelector('textarea')?.value).toBe('当前草稿')
})

describe('composer attachment entry points', () => {
  it.each(['paste', 'drop', 'picker'])('accepts a PDF and image together via %s without duplicating the batch', async (entry) => {
    const onPickAttachments = vi.fn()
    const onPasteClipboardImage = vi.fn()
    await act(async () => root.render(createElement(FloatingComposer, {
      input: '', setInput: vi.fn(), mode: 'agent', setMode: vi.fn(), busy: false, runtimeReady: true,
      hasActiveThread: true, composerModel: 'auto', composerPickList: [], onComposerModelChange: vi.fn(),
      queuedMessages: [], onRemoveQueuedMessage: vi.fn(), onSend: vi.fn(), onInterrupt: vi.fn(),
      attachmentUploadEnabled: true, onPickAttachments, onPasteClipboardImage
    })))

    const pdf = new File(['%PDF'], '工程验收.pdf', { type: 'application/octet-stream' })
    const image = new File(['image'], '照片.png', { type: 'image/png' })
    const transfer = new DataTransfer()
    transfer.items.add(pdf)
    transfer.items.add(image)
    await act(async () => {
      const textarea = host.querySelector('textarea')!
      if (entry === 'picker') {
        const input = host.querySelector('input[type="file"]')!
        Object.defineProperty(input, 'files', { value: transfer.files })
        input.dispatchEvent(new Event('change', { bubbles: true }))
      } else {
        const event = new Event(entry, { bubbles: true, cancelable: true })
        Object.defineProperty(event, entry === 'paste' ? 'clipboardData' : 'dataTransfer', { value: transfer })
        textarea.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(true)
      }
    })

    expect(onPickAttachments).toHaveBeenCalledOnce()
    expect(onPickAttachments.mock.calls[0][0][0]).toBe(pdf)
    expect(onPickAttachments.mock.calls[0][0][1]).toBe(image)
    expect(onPasteClipboardImage).not.toHaveBeenCalled()
  })
})

const cases: Array<[Menu, number]> = [['skill', 0.9], ['skill', 1.1], ['file', 0.9], ['file', 1.1], ['slash', 0.9], ['slash', 1.1]]
describe('composer keyboard suggestion visibility', () => {
  it.each(cases)('keeps each keyboard-active %s row in its own list at scale %s', async (menu, scale) => {
    const { list, rows, textarea } = await mounted(menu, scale)
    await key(textarea, 'ArrowUp') // Real production wrapping selects the last row.
    expect(list.scrollTop).toBeGreaterThan(0)
    expect(list.scrollTop).toBeLessThanOrEqual(list.scrollHeight - list.clientHeight)
    const lastEnabled = rows.filter(row => !row.disabled).at(-1)!
    expect(lastEnabled.getBoundingClientRect().bottom).toBeLessThanOrEqual(list.getBoundingClientRect().bottom + 0.5)
    expect(lastEnabled.dataset.composerActive).toBe('true')
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

  it('finds a named skill after the previous 40-item cut and shows its name without exposing an opaque ID', async () => {
    const onSend = vi.fn()
    const available = Array.from({ length: 45 }, (_, index) => ({
      id: `sample-${index}`, name: `Analysis ${index}`, description: 'Analysis'
    }))
    const opaqueId = 'fedcba0123456789'.repeat(4)
    available.push({ id: opaqueId, name: 'Video Shotcraft', description: '制作和渲染视频' })
    await act(async () => root.render(createElement(Harness, { menu: 'slash', seed: '/Video Shot', available, onSend })))
    const textarea = host.querySelector('textarea')!
    expect(host.querySelector('[role=option]')?.textContent).toContain('Video Shotcraft')
    expect(host.querySelector('[role=option]')?.textContent).not.toContain(opaqueId)
    expect(textarea.getAttribute('aria-activedescendant')).toEqual(host.querySelector('[role=option]')?.id)
    await key(textarea, 'Enter')
    expect(textarea.value).toEqual('')
    expect(host.querySelector('[data-composer-skill]')?.textContent).toContain('Video Shotcraft')
    expect(host.textContent).not.toContain(opaqueId)
    expect(host.querySelector('[role=listbox]')).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
    await click(host.querySelector('[data-composer-skill] button')!)
    expect(host.querySelector('[data-composer-skill]')).toBeNull()
  })

  it('keeps the selected skill visible and identifies it as unavailable when the callable list changes', async () => {
    const available = [{ id: 'video-shotcraft', name: 'Video Shotcraft', description: '制作视频' }]
    await act(async () => root.render(createElement(Harness, { menu: 'slash', seed: '/Video Shot', available })))
    await key(host.querySelector('textarea')!, 'Enter')
    await act(async () => root.render(createElement(Harness, { menu: 'slash', available: [] })))
    const chip = host.querySelector('[data-composer-skill]')
    expect(chip?.textContent).toContain('Video Shotcraft')
    expect(chip?.textContent).toContain('Unavailable')
    expect(chip?.querySelector('button')?.disabled).toBe(false)
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

describe('composer plus actions', () => {
  it('shares the skill chooser, leaves draft wording intact, and restores the cursor after keyboard selection', async () => {
    const available = Array.from({ length: 45 }, (_, index) => ({ id: `sample-${index}`, name: `Analysis ${index}`, description: 'Analysis' }))
    available.push({ id: 'video-shotcraft', name: 'Video Shotcraft', description: '制作视频' })
    const onSend = vi.fn()
    await act(async () => root.render(createElement(Harness, { menu: 'toolbar', seed: '前半草稿后半', available, onSend })))
    await paint()
    const textarea = host.querySelector('textarea')!
    textarea.setSelectionRange(4, 6)
    const plus = buttonByLabel('More actions')
    await click(plus)
    expect(plus.getAttribute('aria-expanded')).toBe('true')
    const menu = host.querySelector('[role="menu"]')!
    const skills = buttonByLabel('Skills', menu)
    expect(document.activeElement).toBe(skills)
    await key(skills, 'ArrowDown')
    expect(document.activeElement).toBe(buttonByLabel('Goal', menu))
    await key(document.activeElement as HTMLElement, 'ArrowUp')
    expect(document.activeElement).toBe(skills)
    await click(skills)
    const search = host.querySelector<HTMLInputElement>('input[role="combobox"]')!
    expect(document.activeElement).toBe(search)
    expect(textarea.value).toBe('前半草稿后半')
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(46)
    await key(search, 'ArrowUp')
    expect(host.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Video Shotcraft')
    await key(search, 'Enter')
    await paint()
    expect(textarea.value).toBe('前半草稿后半')
    expect(textarea.selectionStart).toBe(4)
    expect(textarea.selectionEnd).toBe(6)
    expect(host.querySelector('[data-composer-skill]')?.textContent).toContain('Video Shotcraft')
    expect(document.activeElement).toBe(textarea)
    expect(host.querySelector('[role="listbox"]')).toBeNull()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('uses the existing Plan action and opens Goal without changing the durable goal or draft', async () => {
    const setStatus = vi.fn(), setMode = vi.fn(), onPlanCommand = vi.fn(), onSend = vi.fn()
    useChatStore.setState({
      activeThreadGoal: { threadId: 'thread', objective: 'Keep an eye on the project', status: 'active',
        timeUsedSeconds: 0, tokensUsed: 0, tokenBudget: null, createdAt: '', updatedAt: '' },
      setActiveThreadGoalStatus: setStatus
    })
    await act(async () => root.render(createElement(Harness, {
      menu: 'toolbar', seed: 'Draft text remains', onSend, composerProps: { setMode, onPlanCommand }
    })))
    const plus = buttonByLabel('More actions')
    await click(plus)
    const plan = buttonByLabel('Plan mode')
    expect(plan.getAttribute('role')).toBe('menuitemcheckbox')
    expect(plan.getAttribute('aria-checked')).toBe('false')
    await click(plan)
    expect(setMode).toHaveBeenCalledWith('plan')
    expect(onPlanCommand).toHaveBeenCalledOnce()
    await click(plus)
    await click(buttonByLabel('Goal', host.querySelector('[role="menu"]')!))
    expect(host.textContent).toContain('Keep an eye on the project')
    expect(setStatus).not.toHaveBeenCalled()
    expect(host.querySelector('textarea')?.value).toBe('Draft text remains')
    expect(onSend).not.toHaveBeenCalled()
    await click(buttonByLabel('Pause'))
    expect(setStatus).toHaveBeenCalledWith('paused')
  })

  it('refreshes connectors on open, adds a typed choice, and supports removal while the list is unavailable', async () => {
    const connector = { kind: 'connector' as const, id: 'docling', label: 'Docling' }
    const plugin = { kind: 'plugin' as const, id: 'document-workflow', label: 'Document workflow' }
    const onOpenCapabilities = vi.fn(), onManagePlugins = vi.fn(), onSelectCapability = vi.fn(), onRemoveCapability = vi.fn(), onSend = vi.fn()
    const render = (options: Partial<ComponentProps<typeof FloatingComposer>> = {}) => root.render(createElement(Harness, {
      menu: 'toolbar', seed: 'Review the file', onSend, composerProps: {
        callableCapabilities: [connector, plugin], onOpenCapabilities, onManagePlugins, onSelectCapability, onRemoveCapability, ...options
      }
    }))
    await act(async () => render())
    const plus = buttonByLabel('More actions')
    await click(plus)
    await click(buttonByLabel('Plugins and connectors', host.querySelector('[role="menu"]')!))
    expect(onOpenCapabilities).toHaveBeenCalledOnce()
    const search = host.querySelector<HTMLInputElement>('input[role="combobox"]')!
    expect(document.activeElement).toBe(search)
    await key(search, 'ArrowDown')
    expect(host.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain('Document workflow')
    await key(search, 'Enter')
    expect(onSelectCapability).toHaveBeenCalledWith(plugin)
    expect(host.querySelector('textarea')?.value).toBe('Review the file')
    expect(onSend).not.toHaveBeenCalled()

    await act(async () => render({ selectedCapabilities: [plugin], callableCapabilitiesLoading: true }))
    await click(plus)
    await click(buttonByLabel('Plugins and connectors', host.querySelector('[role="menu"]')!))
    expect(onOpenCapabilities).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[role="option"]')).toBeNull()
    expect(host.textContent).toContain('Checking available plugins and connectors')
    await act(async () => render({ selectedCapabilities: [plugin], callableCapabilities: [] }))
    expect(host.textContent).toContain('No plugins or connectors are available for this conversation.')
    await click(buttonByLabel('Manage skills and connectors'))
    expect(onManagePlugins).toHaveBeenCalledOnce()
    await click(buttonByLabel('Remove Document workflow'))
    expect(onRemoveCapability).toHaveBeenCalledWith(plugin)
  })

  it('closes both levels with Escape and keeps focus in the composer', async () => {
    await act(async () => root.render(createElement(Harness, { menu: 'toolbar', seed: 'Draft text remains' })))
    const plus = buttonByLabel('More actions')
    await click(plus)
    await key(document.activeElement as HTMLElement, 'Escape')
    expect(host.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(plus)
    await click(plus)
    await click(buttonByLabel('Skills', host.querySelector('[role="menu"]')!))
    await key(host.querySelector<HTMLInputElement>('input[role="combobox"]')!, 'Escape')
    await paint()
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('textarea'))
  })

  it('bounds the actions menu and skill picker to the space above the composer at zoom', async () => {
    document.body.style.zoom = '1.1'
    await act(async () => root.render(createElement(Harness, { menu: 'toolbar', seed: 'Draft text remains' })))
    const anchor = host.querySelector('.ds-composer-shell')!.parentElement!
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect(260, 140))
    await click(buttonByLabel('More actions'))
    const menu = host.querySelector<HTMLDivElement>('[role="menu"]')!
    const actionsHeight = Number.parseFloat(menu.style.maxHeight)
    expect(actionsHeight).toBeGreaterThan(0)
    expect(actionsHeight * 1.1).toBeLessThan(260)
    expect(menu.className).toContain('overflow-y-auto')
    await click(buttonByLabel('Skills', menu))
    const picker = host.querySelector<HTMLDivElement>('[role="dialog"]')!
    expect(picker.style.maxHeight).toBe(menu.style.maxHeight)
    expect(picker.querySelector('[role="listbox"]')?.className).toContain('overflow-y-auto')
  })
})
