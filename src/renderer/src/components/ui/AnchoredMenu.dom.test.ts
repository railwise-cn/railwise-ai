// @vitest-environment happy-dom
import { act, createElement, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnchoredMenu } from './AnchoredMenu'
import { FloatingComposerAgentPicker } from '../chat/FloatingComposerAgentPicker'
import { FloatingComposerExecutionPicker } from '../chat/FloatingComposerExecutionPicker'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
let root: Root, container: HTMLDivElement
const settle = async (): Promise<void> => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) }) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function Harness({ name = 'first' }: { name?: string }) {
  const anchor = useRef<HTMLButtonElement>(null), [open, setOpen] = useState(false)
  return createElement('div', { style: { transform: 'translateX(30px)', overflow: 'hidden' } },
    createElement('button', { ref: anchor, onClick: () => setOpen(!open), 'data-trigger': name }, name),
    createElement(AnchoredMenu, { id: name, open, onOpenChange: setOpen, anchorRef: anchor, label: name,
      children: [
        createElement('button', { key: 'a', role: 'menuitemradio', 'aria-checked': false }, 'a'),
        createElement('button', { key: 'disabled', role: 'menuitemradio', disabled: true }, 'disabled'),
        createElement('button', { key: 'b', role: 'menuitemradio', 'aria-checked': true }, 'b')
      ] }))
}

describe('anchored selector interaction', () => {
  it('escapes transformed/clipping ancestors, focuses the selection, navigates enabled rows and restores the trigger', async () => {
    await act(async () => root.render(createElement(Harness)))
    const trigger = container.querySelector('button')!
    await act(async () => trigger.click()); await settle()
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!
    expect(menu.parentElement).toBe(document.body)
    const rows = menu.querySelectorAll<HTMLButtonElement>('button')
    expect(document.activeElement).toBe(rows[2])
    await act(async () => rows[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expect(document.activeElement).toBe(rows[0])
    await act(async () => rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    expect(document.activeElement).toBe(rows[2])
    await act(async () => rows[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('keeps a single menu open and dismisses on an outside pointer', async () => {
    await act(async () => root.render(createElement('div', {}, createElement(Harness), createElement(Harness, { name: 'second' }))))
    await act(async () => container.querySelector<HTMLButtonElement>('[data-trigger="first"]')!.click())
    await act(async () => container.querySelector<HTMLButtonElement>('[data-trigger="second"]')!.click())
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1)
    expect(document.querySelector('[role="menu"]')?.getAttribute('aria-label')).toBe('second')
    await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })

  it.each(['inert', 'hidden', 'disabled', 'disconnected'])('closes a body portal when its anchor becomes %s', async state => {
    await act(async () => root.render(createElement(Harness)))
    const trigger = container.querySelector('button')!
    await act(async () => trigger.click())
    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    await act(async () => {
      if (state === 'disconnected') trigger.remove()
      else if (state === 'disabled') trigger.disabled = true
      else trigger.parentElement!.setAttribute(state, '')
    })
    await settle()
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull(), { timeout: 1000 })
  })

  it('delegates Tab to the enclosing modal while consuming Escape locally', async () => {
    await act(async () => root.render(createElement(Harness)))
    const trigger = container.querySelector('button')!
    const delegated = vi.fn()
    window.addEventListener('keydown', delegated)
    try {
      await act(async () => trigger.click())
      const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      await act(async () => document.querySelector('[role="menu"] button')!.dispatchEvent(tab))
      expect(tab.defaultPrevented).toBe(false)
      expect(delegated).toHaveBeenCalledOnce()
      expect(document.activeElement).toBe(trigger)
      delegated.mockClear()
      await act(async () => trigger.click())
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      await act(async () => document.querySelector('[role="menu"] button')!.dispatchEvent(escape))
      expect(escape.defaultPrevented).toBe(true)
      expect(delegated).not.toHaveBeenCalled()
    } finally { window.removeEventListener('keydown', delegated) }
  })

  it('repositions on scrolling and UI zoom changes without scaling visualViewport twice', async () => {
    const viewport = new EventTarget()
    Object.assign(viewport, { width: 600, height: 400, offsetLeft: 0, offsetTop: 0, scale: 1.5 })
    vi.stubGlobal('visualViewport', viewport)
    document.body.style.zoom = '1.25'
    await act(async () => root.render(createElement(Harness)))
    const trigger = container.querySelector('button')!
    let left = 250
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => ({ left, right: left + 100, top: 300, bottom: 336 }) as DOMRect)
    await act(async () => trigger.click()); await settle()
    expect(Number.parseFloat((document.querySelector('[role="menu"]') as HTMLElement).style.left)).toBe(200)
    left = 125
    await act(async () => window.dispatchEvent(new Event('scroll'))); await settle()
    expect(Number.parseFloat((document.querySelector('[role="menu"]') as HTMLElement).style.left)).toBe(100)
    document.body.style.zoom = '1'
    await settle()
    expect(Number.parseFloat((document.querySelector('[role="menu"]') as HTMLElement).style.left)).toBe(125)
    document.body.style.zoom = ''
  })

  it('keeps long agent names readable and emits only the selected trusted id', async () => {
    const change = vi.fn(), name = '工程测量与轨道控制网数据处理和质量核验专用智能体'
    await act(async () => root.render(createElement(FloatingComposerAgentPicker, {
      profiles: [{ id: 'general', name: 'General' }, { id: 'survey', name, role: '输入预检与资料核验' }], value: 'general', onChange: change
    })))
    await act(async () => container.querySelector('button')!.click())
    const menu = document.querySelector('[role="menu"]')!
    expect(menu.textContent).toContain(name)
    await act(async () => [...menu.querySelectorAll<HTMLButtonElement>('button')].find(row => row.textContent?.includes(name))!.click())
    expect(change).toHaveBeenCalledExactlyOnceWith('survey')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('button'))
  })

  it('preserves execution values and closes after one explicit setting change', async () => {
    const change = vi.fn()
    await act(async () => root.render(createElement(FloatingComposerExecutionPicker, {
      value: { approvalPolicy: 'on-request', sandboxMode: 'read-only' }, onChange: change
    })))
    await act(async () => container.querySelector('button')!.click())
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    expect(rows).toHaveLength(9)
    await act(async () => rows.find(row => row.textContent === 'sandboxWorkspaceWriteShort')!.click())
    expect(change).toHaveBeenCalledExactlyOnceWith({ sandboxMode: 'workspace-write' })
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})
