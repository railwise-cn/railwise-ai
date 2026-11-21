// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { AttachmentReference } from '../../agent/types'
import { FloatingComposerAttachments } from './FloatingComposerAttachments'
import '../../i18n'

it('exposes full document names, shows a mixed batch, and keeps actions bound to the selected file', async () => {
  const longName = `${'很长的工程成果文件名'.repeat(8)}.pdf`
  const attachments: AttachmentReference[] = [
    { id: 'first', name: longName, state: 'ready', byteSize: 4 * 1024 },
    { id: 'second', name: longName, state: 'failed', localSourcePath: '/work/retry.pdf' },
    { id: 'third', name: '照片.png', state: 'ready', previewUrl: 'data:image/png;base64,abc' },
    { id: 'last', name: '记录.csv', state: 'parsing', progress: 0.42 }
  ]
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const retry = vi.fn()
  const remove = vi.fn()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  try {
    await act(async () => root.render(createElement(FloatingComposerAttachments, { attachments, onRetry: retry, onRemove: remove })))
    const list = host.querySelector('ul')!
    const entries = list.querySelectorAll('li')
    const toggle = host.querySelector<HTMLButtonElement>('.ds-composer-attachment-toggle')!
    expect(entries).toHaveLength(4)
    expect(entries[0].querySelector(`[title="${longName}"]`)).not.toBeNull()
    expect(entries[0].querySelector('.ds-chat-attachment-filename > span:last-child')?.textContent).toBe('.pdf')
    expect(entries[2].querySelector('img')).not.toBeNull()
    expect(entries[3].textContent).toContain('42%')
    expect(toggle.textContent).toContain('Needs attention (1)')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    const name = entries[0].querySelector('button')!
    await act(async () => name.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    const retryButton = entries[1].querySelector<HTMLButtonElement>('[aria-label="Retry attachment"]')!
    const removeButton = entries[1].querySelector<HTMLButtonElement>('[aria-label="Remove attachment"]')!
    await act(async () => retryButton.click())
    await act(async () => removeButton.click())
    expect(retry).toHaveBeenCalledExactlyOnceWith('second')
    expect(remove).toHaveBeenCalledExactlyOnceWith('second')

    removeButton.focus()
    await act(async () => removeButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(name)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
