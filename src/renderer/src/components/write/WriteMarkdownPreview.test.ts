// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { WriteMarkdownPreview } from './WriteMarkdownPreview'

let container: HTMLDivElement
let root: Root
beforeEach(async () => {
  await i18n.changeLanguage('zh')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })

describe('preview local document link routing', () => {
  it.each([
    ['../notes/100%25.md', '/tmp/workspace/notes/100%.md'],
    ['../notes/literal%2541.md', '/tmp/workspace/notes/literal%41.md'],
    ['../notes/space%20%23%3F.md', '/tmp/workspace/notes/space #?.md'],
    ['../notes/%E7%9B%91%E6%B5%8B%20%E6%8A%A5%E5%91%8A.md?view=print#section', '/tmp/workspace/notes/监测 报告.md']
  ])('opens %s without double decoding the filename', async (href, path) => {
    const resolveWorkspaceFile = vi.fn(async () => ({ ok: true, path }))
    const onOpenDocument = vi.fn()
    Object.defineProperty(window, 'workwise', { configurable: true, value: { resolveWorkspaceFile } })
    await act(async () => root.render(createElement(WriteMarkdownPreview, {
      content: `[打开文档](<${href}>)`, isMarkdown: true,
      filePath: '/tmp/workspace/docs/current.md', workspaceRoot: '/tmp/workspace', onOpenDocument
    })))
    const link = container.querySelector('a')!
    expect(link).not.toBeNull()
    await act(async () => link.click())
    expect(resolveWorkspaceFile).toHaveBeenCalledExactlyOnceWith({ path, workspaceRoot: '/tmp/workspace' })
    expect(onOpenDocument).toHaveBeenCalledExactlyOnceWith(path)
  })
})
