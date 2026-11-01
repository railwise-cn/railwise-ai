// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { calculateWriteSearchPlacement, WriteDocumentSearchPanel } from './WriteDocumentSearchPanel'

describe('write document search placement', () => {
  it('opens from the left-side trigger without extending outside the viewport', () => {
    expect(calculateWriteSearchPlacement({
      anchor: { left: 340, top: 180, bottom: 210 }, viewportWidth: 1280, viewportHeight: 800, panelHeight: 390
    })).toEqual({ left: 340, top: 218, width: 440, maxHeight: 390 })
    const narrow = calculateWriteSearchPlacement({
      anchor: { left: 270, top: 180, bottom: 210 }, viewportWidth: 360, viewportHeight: 400, panelHeight: 390
    })
    expect(narrow.left).toBe(16)
    expect(narrow.left + narrow.width).toBe(344)
    expect(narrow.top + narrow.maxHeight).toBeLessThanOrEqual(384)
  })

  it('normalizes body zoom and opens above a low trigger', () => {
    expect(calculateWriteSearchPlacement({
      anchor: { left: 800, top: 640, bottom: 680 }, viewportWidth: 1440, viewportHeight: 800, panelHeight: 300, scale: 1.25
    })).toEqual({ left: 640, top: 204, width: 440, maxHeight: 390 })
  })

  it('escapes an overflow-hidden workspace and restores trigger focus on Escape', async () => {
    await i18n.changeLanguage('en')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    container.style.overflow = 'hidden'
    document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(createElement(WriteDocumentSearchPanel, { workspaceRoot: '/tmp/workspace', onOpenFile: vi.fn() })))
      const trigger = container.querySelector('button')!
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ left: 340, top: 180, bottom: 210 } as DOMRect)
      await act(async () => trigger.click())
      const panel = document.querySelector('[role="dialog"]')!
      expect(panel.parentElement).toBe(document.body)
      expect(container.contains(panel)).toBe(false)
      expect(panel.classList.contains('fixed')).toBe(true)
      expect(document.activeElement).toBe(panel.querySelector('input'))
      await act(async () => panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(trigger)
    } finally {
      await act(async () => root.unmount())
      container.remove()
      vi.restoreAllMocks()
    }
  })
})
