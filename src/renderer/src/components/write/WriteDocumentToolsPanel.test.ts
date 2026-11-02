// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { WriteDocumentToolsPanel, replaceDocumentFrontmatter } from './WriteDocumentToolsPanel'
import { WriteAiReviewDialog } from './WriteAiReviewDialog'
import type { DocumentComment, DocumentSemantics } from '@shared/write-document'

let container: HTMLDivElement
let root: Root
const path = '/tmp/docs/test.md'
const frontmatter: DocumentSemantics = {
  frontmatter: { data: { title: 'Original' }, raw: 'title: Original', body: '# Body\n', startOffset: 0, endOffset: 28 },
  outgoing: [{ sourcePath: path, target: './missing.md', kind: 'markdown', line: 4, resolvedPath: '/tmp/docs/missing.md', status: 'broken' }],
  backlinks: [{ sourcePath: '/tmp/docs/parent.md', target: './test.md', kind: 'markdown', line: 2 }],
  relations: { nodes: [], edges: [], skippedFiles: 0, truncated: false }
}

function props(): ComponentProps<typeof WriteDocumentToolsPanel> {
  return {
    workspaceRoot: '/tmp/docs', path, content: '---\ntitle: Original\n---\n# Body\n',
    selection: { text: 'Body', charCount: 4, ranges: [{ from: 25, to: 29, text: 'Body', charCount: 4, startLine: 4, endLine: 4, startColumn: 3, endColumn: 6 }] },
    readOnly: false, saveRevision: 0, onChange: vi.fn(), onOpenFile: vi.fn(), onReviewComment: vi.fn(async () => undefined), aiEditBusy: false,
    onBeforeRestore: vi.fn(async () => ({ fingerprint: 'baseline', size: 4, modifiedAt: 1 })), onRestored: vi.fn(async () => true)
  }
}

function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text) || item.getAttribute('aria-label') === text)
  if (!result) throw new Error(`Missing button: ${text}`)
  return result
}
beforeEach(async () => {
  await i18n.changeLanguage('zh')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })

describe('document workbench review tools', () => {
  it('validates frontmatter and leaves the body intact when properties are applied', async () => {
    const next = props()
    Object.defineProperty(window, 'workwise', { configurable: true, value: { getDocumentSemantics: vi.fn(async () => frontmatter) } })
    await act(async () => root.render(createElement(WriteDocumentToolsPanel, next)))
    await act(async () => button('属性').click())
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'title: [bad]')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('应用属性').click())
    expect(next.onChange).not.toHaveBeenCalled()
    expect(container.textContent).toContain('title 字段必须是文本')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'title: Revised\ntags: [one]')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('应用属性').click())
    expect(next.onChange).toHaveBeenCalledWith('---\ntitle: Revised\ntags: [one]\n---\n# Body\n')
  })

  it('shows broken links and opens backlinks using the document action', async () => {
    const next = props()
    Object.defineProperty(window, 'workwise', { configurable: true, value: { getDocumentSemantics: vi.fn(async () => frontmatter) } })
    await act(async () => root.render(createElement(WriteDocumentToolsPanel, next)))
    await act(async () => button('链接与关系').click())
    expect(button('./missing.md').disabled).toBe(true)
    await act(async () => button('parent.md:2').click())
    expect(next.onOpenFile).toHaveBeenCalledWith('/tmp/docs/parent.md')
  })

  it('saves a selected-text comment only after the document baseline has been saved', async () => {
    const next = props()
    const create = vi.fn(async () => ({}))
    Object.defineProperty(window, 'workwise', { configurable: true, value: { listDocumentComments: vi.fn(async () => []), createDocumentComment: create } })
    await act(async () => root.render(createElement(WriteDocumentToolsPanel, next)))
    await act(async () => button('批注').click())
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Check source')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('保存批注').click())
    expect(next.onBeforeRestore).toHaveBeenCalledOnce()
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ text: 'Check source', anchor: { from: 25, to: 29, text: 'Body' } }))
    expect(next.onChange).not.toHaveBeenCalled()
  })

  it('shows AI diff without applying a change until Accept is clicked', async () => {
    const onApply = vi.fn(); const onClose = vi.fn()
    await act(async () => root.render(createElement(WriteAiReviewDialog, {
      edit: { workspaceRoot: '/tmp/docs', path, instruction: 'Polish', replacement: 'New\n', sourceContent: 'Old\n', scope: { kind: 'selection', from: 0, to: 4, text: 'Old\n', selectedText: 'Old\n', startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 } },
      error: null, onApply, onClose
    })))
    expect(container.textContent).toContain('Old')
    expect(container.textContent).toContain('New')
    expect(onApply).not.toHaveBeenCalled()
    await act(async () => button('接受修改').click())
    expect(onApply).toHaveBeenCalledOnce()
  })

  it('requests a reviewed comment proposal, keeps the comment on failure and disables duplicate/read-only requests', async () => {
    const next = props()
    const item: DocumentComment = { id: 'comment-1', path, text: 'Make the report clearer.', anchor: { from: 25, to: 29, text: 'Body' }, status: 'open', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
    let reject: (reason: Error) => void = () => undefined
    next.onReviewComment = vi.fn(() => new Promise<void>((_resolve, rejectRequest) => { reject = rejectRequest }))
    const update = vi.fn()
    Object.defineProperty(window, 'workwise', { configurable: true, value: { listDocumentComments: vi.fn(async () => [item]), updateDocumentComment: update } })
    await act(async () => root.render(createElement(WriteDocumentToolsPanel, next)))
    await act(async () => button('批注').click())
    await act(async () => button('生成修改建议').click())
    expect(next.onReviewComment).toHaveBeenCalledExactlyOnceWith(item)
    expect(button('生成修改建议').disabled).toBe(true)
    expect(next.onChange).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    await act(async () => reject(new Error('The comment anchor changed.')))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('anchor changed')
    expect(container.textContent).toContain(item.text)
    expect(button('生成修改建议').disabled).toBe(false)
    await act(async () => root.render(createElement(WriteDocumentToolsPanel, { ...next, readOnly: true })))
    expect(button('生成修改建议').disabled).toBe(true)
    await act(async () => root.render(createElement(WriteDocumentToolsPanel, { ...next, aiEditBusy: true })))
    expect(button('生成修改建议').disabled).toBe(true)
  })

  it('does not close or add an old request error to a newly opened panel', async () => {
    const next = props()
    const item: DocumentComment = { id: 'c1', path, text: 'Synthetic comment.', anchor: { from: 25, to: 29, text: 'Body' }, status: 'open', createdAt: '', updatedAt: '' }
    let complete: () => void = () => undefined
    next.onReviewComment = vi.fn(() => new Promise<void>((resolve) => { complete = resolve }))
    Object.defineProperty(window, 'workwise', { configurable: true, value: { listDocumentComments: vi.fn(async () => [item]), getDocumentSemantics: vi.fn(async () => frontmatter) } })
    await act(async () => root.render(createElement(WriteDocumentToolsPanel, next)))
    await act(async () => button('批注').click())
    await act(async () => button('生成修改建议').click())
    await act(async () => button('属性').click())
    await act(async () => complete())
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('YAML')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('restores history against the reviewed baseline, without accepting a fresh unseen disk revision', async () => {
    const next = props()
    const revision = { fingerprint: 'baseline', size: 4, modifiedAt: 1 }
    const entry = { id: 'old-id', path, revision, content: 'Previous\n', createdAt: '2026-11-01T00:00:00Z', source: 'user' }
    const restore = vi.fn(async () => ({ ok: true, snapshot: entry }))
    const readFresh = vi.fn(async () => ({ path, content: 'Unseen', revision: { fingerprint: 'external', size: 6, modifiedAt: 2 } }))
    Object.defineProperty(window, 'workwise', { configurable: true, value: {
      listDocumentHistory: vi.fn(async () => ({ entries: [entry], total: 1, truncated: false, limit: 200 })),
      getDocumentHistoryEntry: vi.fn(async () => entry), restoreDocumentHistory: restore, readDocumentSnapshot: readFresh
    } })
    await act(async () => root.render(createElement(WriteDocumentToolsPanel, next)))
    await act(async () => button('历史').click())
    const entryButton = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes('4 B'))!
    await act(async () => entryButton.click())
    await act(async () => button('恢复此版本').click())
    expect(readFresh).not.toHaveBeenCalled()
    expect(restore).toHaveBeenCalledWith({ workspaceRoot: '/tmp/docs', path, id: 'old-id', expectedRevision: revision })
    expect(next.onRestored).toHaveBeenCalledOnce()
  })

  it('does not remove an unclosed metadata block when adding properties', () => {
    expect(replaceDocumentFrontmatter('---\nunclosed\nBody', 'title: Added')).toBe('---\ntitle: Added\n---\n---\nunclosed\nBody')
  })
})
