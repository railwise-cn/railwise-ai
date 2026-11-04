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

describe('advanced Markdown preview hydration', () => {
  it('hydrates Mermaid fences mounted through the preview component', async () => {
    const renderWriteMermaidPreview = vi.fn(async () => ({
      ok: true,
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text x="2" y="10">Survey</text></svg>',
      width: 100,
      height: 50
    }))
    Object.defineProperty(window, 'workwise', { configurable: true, value: { renderWriteMermaidPreview } })

    await act(async () => root.render(createElement(WriteMarkdownPreview, {
      content: '# Diagram\n\n```mermaid\ngraph LR\nA[Survey] --> B[Report]\n```',
      isMarkdown: true
    })))
    await vi.waitFor(() => expect(container.querySelector('img[data-write-diagram-image]')).not.toBeNull())

    expect(renderWriteMermaidPreview).toHaveBeenCalledExactlyOnceWith({ source: 'graph LR\nA[Survey] --> B[Report]\n' })
    expect(container.querySelector<HTMLImageElement>('img[data-write-diagram-image]')?.alt).toBe('Mermaid diagram')
    expect(container.querySelector('[data-write-mermaid] pre')).toBeNull()
    expect(container.querySelector('[data-write-mermaid] [role="status"]')).toBeNull()
  })

  it('ignores a Mermaid response after React replaces the preview document', async () => {
    const responses: Array<(result: { ok: true; svg: string; width: number; height: number }) => void> = []
    const renderWriteMermaidPreview = vi.fn(() => new Promise<{ ok: true; svg: string; width: number; height: number }>((resolve) => responses.push(resolve)))
    Object.defineProperty(window, 'workwise', { configurable: true, value: { renderWriteMermaidPreview } })

    await act(async () => root.render(createElement(WriteMarkdownPreview, {
      content: '```mermaid\ngraph LR\nA[Old] --> B[Diagram]\n```',
      isMarkdown: true
    })))
    expect(renderWriteMermaidPreview).toHaveBeenCalledTimes(1)

    await act(async () => root.render(createElement(WriteMarkdownPreview, {
      content: '# New document',
      isMarkdown: true
    })))
    await act(async () => responses[0]({
      ok: true,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Old</text></svg>',
      width: 100,
      height: 50
    }))

    expect(container.textContent).toContain('New document')
    expect(container.querySelector('img[data-write-diagram-image]')).toBeNull()
  })
})
