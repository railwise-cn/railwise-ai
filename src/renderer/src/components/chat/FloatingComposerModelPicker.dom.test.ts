// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FloatingComposerModelPicker } from './FloatingComposerModelPicker'
import { persistComposerSelection, readStoredComposerSelection } from '../../store/chat-store-helpers'

vi.mock('react-i18next', () => { const t = (key: string) => key; return { useTranslation: () => ({ t }) } })
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), clear: () => values.clear() })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals() })

describe('provider-aware composer selection', () => {
  it('keeps same-name models under both providers and emits the selected identity', async () => {
    const select = vi.fn()
    await act(async () => root.render(createElement(FloatingComposerModelPicker, {
      compact: false, mode: 'select', composerModel: 'shared-model', composerProviderId: 'b',
      composerPickList: ['shared-model'], canChangeModel: true, onComposerModelChange: select,
      composerModelGroups: [
        { providerId: 'a', label: 'Provider A', modelIds: ['shared-model', 'shared-model'] },
        { providerId: 'b', label: 'Provider B', modelIds: ['shared-model'] }
      ]
    })))
    expect(container.textContent).toContain('Provider B / shared-model')
    await act(async () => container.querySelector('button')!.click())
    const provider = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] button')].find(button => button.textContent?.includes(name))!
    await act(async () => provider('Provider A').click())
    let menu = document.querySelector('[role="menu"][aria-label="Provider A"]')!
    expect(menu.querySelectorAll('button')).toHaveLength(1)
    expect(menu.querySelector('.lucide-check')).toBeNull()
    await act(async () => provider('Provider B').click())
    menu = document.querySelector('[role="menu"][aria-label="Provider B"]')!
    expect(menu.querySelectorAll('button')).toHaveLength(1)
    expect(menu.querySelector('.lucide-check')).not.toBeNull()
    await act(async () => menu.querySelector('button')!.click())
    expect(select).toHaveBeenLastCalledWith('shared-model', 'b')
  })

  it('persists a pair without deleting the legacy model preference and rejects malformed pairs', () => {
    window.localStorage.setItem('workwise.composerModel', 'legacy-model')
    persistComposerSelection('shared-model', 'b')
    expect(readStoredComposerSelection()).toEqual({ model: 'shared-model', providerId: 'b' })
    expect(window.localStorage.getItem('workwise.composerModel')).toBe('legacy-model')
    window.localStorage.setItem('workwise.composerSelection.v1', '{"version":1,"model":3}')
    expect(readStoredComposerSelection()).toBeNull()
  })
})
