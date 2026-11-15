// @vitest-environment happy-dom
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SettingsSidebar } from './SettingsSidebar'

it('preserves every settings category and exposes the active category to scrolling and assistive technology', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), back = vi.fn()
  function Harness() {
    const [category, setCategory] = useState<'general'|'providers'|'write'|'imageGeneration'|'agents'|'shortcuts'|'claw'|'help'>('general')
    return createElement(SettingsSidebar, { category, setCategory, goBack: back, t: key => key })
  }
  try {
    await act(async () => root.render(createElement(Harness)))
    const categories = [...container.querySelectorAll('nav button')] as HTMLButtonElement[]
    expect(categories.map(button => button.textContent)).toEqual(['general', 'providers', 'write', 'imageGen', 'agents', 'keyboardShortcuts', 'claw', 'help'])
    for (const button of categories) {
      await act(async () => button.click())
      expect(button.getAttribute('aria-current')).toBe('page')
      expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
    }
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' })
    await act(async () => (container.querySelector('button') as HTMLButtonElement).click())
    expect(back).toHaveBeenCalledTimes(1)
  } finally { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() }
})
