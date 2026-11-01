// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { WriteDocumentTabs } from './WriteDocumentTabs'

describe('write document tabs', () => {
  it('keeps the active document and its controls visible when opening or switching many tabs', async () => {
    await i18n.changeLanguage('en')
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    const props: ComponentProps<typeof WriteDocumentTabs> = {
      tabs: Array.from({ length: 21 }, (_, index) => ({ id: `tab-${index}`, path: `/tmp/workspace/document-${index}.md`, kind: 'text', pinned: false, openedAt: index })),
      activeTabId: 'tab-20', workspaceRoot: '/tmp/workspace', canRestore: false, recent: [], dirty: false,
      onSelect: vi.fn(), onClose: vi.fn(), onPin: vi.fn(), onRestore: vi.fn(), onOpenRecent: vi.fn()
    }
    try {
      await act(async () => root.render(createElement(WriteDocumentTabs, props)))
      expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest', behavior: 'auto' })
      expect(scroll.mock.contexts.at(-1)).toBe(container.querySelector('[aria-selected="true"]')?.parentElement)
      expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('document-20.md')
      await act(async () => root.render(createElement(WriteDocumentTabs, { ...props, activeTabId: 'tab-0' })))
      expect(scroll).toHaveBeenCalledTimes(2)
      expect(scroll.mock.contexts.at(-1)).toBe(container.querySelector('[aria-selected="true"]')?.parentElement)
      expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('document-0.md')
    } finally {
      await act(async () => root.unmount())
      container.remove()
      scroll.mockRestore()
    }
  })
})
