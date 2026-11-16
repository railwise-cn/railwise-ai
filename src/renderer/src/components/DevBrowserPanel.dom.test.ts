// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { DevBrowserPanel } from './DevBrowserPanel'

it('shows draft provenance beside the managed preview title without hiding the saved page', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('zh')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), url = `http://127.0.0.1:45678/task-preview/${'a'.repeat(48)}/report.html`
  try {
    await act(async () => root.render(createElement(DevBrowserPanel, { blocks: [], preferredUrl: url, sourceEvidenceStatus: 'draft', onCollapse: vi.fn() })))
    expect(container.textContent).toContain('草稿·来源待核验')
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe(url)
    expect(container.textContent).not.toContain('文件及来源已核验')
    await act(async () => root.render(createElement(DevBrowserPanel, { blocks: [], preferredUrl: url, sourceEvidenceStatus: 'verified', onCollapse: vi.fn() })))
    expect(container.textContent).toContain('文件及来源已核验')
    expect(container.textContent).not.toContain('草稿·来源待核验')
  } finally { await act(async () => root.unmount()); container.remove() }
})
