// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentComment } from '@shared/write-document'
import i18n from '../../i18n'
import { useWriteWorkspaceStore } from '../../write/write-workspace-store'
import { WriteWorkspaceView } from './WriteWorkspaceView'

vi.mock('../../store/chat-store', () => ({ useChatStore: (selector: (state: unknown) => unknown) => selector({ ensureWriteThreadForWorkspace: vi.fn(), runtimeConnection: 'idle' }) }))
vi.mock('../../agent/runtime-client', () => ({ rendererRuntimeClient: {} }))
vi.mock('../engineering/SurveyDraftEditorNotice', () => ({ SurveyDraftEditorNotice: () => null }))
vi.mock('./WriteWorkspaceToolbar', () => ({ WriteWorkspaceToolbar: () => null }))
vi.mock('./WriteWorkspaceDocumentPane', () => ({ WriteWorkspaceDocumentPane: () => null }))
vi.mock('./WriteDocumentTabs', () => ({ WriteDocumentTabs: () => null }))
vi.mock('./WriteDocumentSearchPanel', () => ({ WriteDocumentSearchPanel: () => null }))
vi.mock('./WriteDocumentAiActions', () => ({ WriteDocumentAiActions: () => null }))
vi.mock('./WriteRelocateDocumentDialog', () => ({ WriteRelocateDocumentDialog: () => null }))
vi.mock('./WriteInlineAgent', () => ({ WriteInlineAgent: () => null }))
vi.mock('./WriteAgnesImageDialog', () => ({ WriteAgnesImageDialog: () => null }))
vi.mock('./WriteExportDialog', () => ({ WriteExportDialog: () => null }))
vi.mock('./WriteWorkspaceEmptyState', () => ({ WriteWorkspaceEmptyState: () => null }))

const path = '/tmp/synthetic-comments/report.md'
const content = '---\ntitle: Synthetic\n---\n\n# Draft\n\nBefore. Target text. After.\n'
const from = content.indexOf('Target text.')
const comment: DocumentComment = { id: 'c1', path, text: 'Make this synthetic wording formal.', anchor: { from, to: from + 'Target text.'.length, text: 'Target text.' }, status: 'open', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' }
let container: HTMLDivElement
let root: Root
const request = vi.fn()
const setInput = vi.fn()

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label) || item.getAttribute('aria-label') === label)
  if (!match) throw new Error(`Missing button: ${label}`)
  return match
}
async function openComments(): Promise<void> {
  await act(async () => root.render(createElement(WriteWorkspaceView, { leftSidebarCollapsed: false, onToggleLeftSidebar: vi.fn(), input: '', setInput })))
  await act(async () => button('批注').click())
}

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  request.mockReset(); setInput.mockReset()
  request.mockResolvedValue({ ok: true, completion: 'Formal target text.', action: { kind: 'edit', replacement: 'Formal target text.' } })
  useWriteWorkspaceStore.setState({
    ...useWriteWorkspaceStore.getInitialState(), workspaceRoot: '/tmp/synthetic-comments', rootDirectory: '/tmp/synthetic-comments',
    activeFilePath: path, activeFileKind: 'text', fileContent: content, fileSize: content.length,
    saveStatus: 'saved', previewMode: 'source', inlineCompletionApiReady: true,
    loadWriteSettings: vi.fn(async () => undefined), flushSave: vi.fn(async () => true)
  }, true)
  Object.defineProperty(window, 'workwise', { configurable: true, value: { listDocumentComments: vi.fn(async () => [comment]), requestWriteInlineCompletion: request } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })

describe('comment to document AI review', () => {
  it('uses the anchored selection through explicit edit completion, requires review, and applies only on Accept', async () => {
    await openComments()
    await act(async () => button('生成修改建议').click())
    expect(request).toHaveBeenCalledOnce()
    const payload = request.mock.calls[0][0]
    expect(payload).toMatchObject({ mode: 'edit', currentFilePath: path, editCandidate: { original: 'Target text.', selectedText: 'Target text.' } })
    expect(payload.policy.instruction).toContain(comment.text)
    expect(container.textContent).toContain('审阅 AI 修改')
    expect(useWriteWorkspaceStore.getState().fileContent).toBe(content)
    expect(setInput).not.toHaveBeenCalled()
    await act(async () => button('放弃修改').click())
    expect(useWriteWorkspaceStore.getState().fileContent).toBe(content)
    await act(async () => button('批注').click())
    expect(container.textContent).toContain(comment.text)
    await act(async () => button('生成修改建议').click())
    await act(async () => button('接受修改').click())
    expect(useWriteWorkspaceStore.getState().fileContent).toBe(content.replace('Target text.', 'Formal target text.'))
    expect(setInput).not.toHaveBeenCalled()
  })

  it('rejects changed/missing anchors before calling a model and retains the comment', async () => {
    useWriteWorkspaceStore.setState({ fileContent: content.replace('Target text.', 'Changed text.') })
    await openComments()
    await act(async () => button('生成修改建议').click())
    expect(request).not.toHaveBeenCalled()
    expect(container.textContent).toContain('批注原文已变化或不可用')
    expect(container.textContent).toContain(comment.text)
    expect(useWriteWorkspaceStore.getState().fileContent).toBe(content.replace('Target text.', 'Changed text.'))
  })

  it('does not offer an accept-ready proposal after the document changes during generation', async () => {
    let resolve: (value: unknown) => void = () => undefined
    request.mockReturnValue(new Promise((complete) => { resolve = complete }))
    await openComments()
    await act(async () => { const generate = button('生成修改建议'); generate.click(); generate.click() })
    expect(request).toHaveBeenCalledOnce()
    expect(button('生成修改建议').disabled).toBe(true)
    expect(container.textContent).toContain('正在生成修改建议')
    const external = content + '\nExternal synthetic update.\n'
    await act(async () => useWriteWorkspaceStore.setState({ fileContent: external }))
    await act(async () => resolve({ ok: true, completion: 'Formal target text.', action: { kind: 'edit', replacement: 'Formal target text.' } }))
    expect(container.textContent).not.toContain('审阅 AI 修改')
    expect(container.textContent).toContain(comment.text)
    expect(useWriteWorkspaceStore.getState().fileContent).toBe(external)
  })

  it('keeps the document/comment on completion failure and blocks stale acceptance after review', async () => {
    request.mockResolvedValueOnce({ ok: false, message: 'The model response was incomplete.' })
    await openComments()
    await act(async () => button('生成修改建议').click())
    expect(container.textContent).toContain('incomplete')
    expect(container.textContent).toContain(comment.text)
    expect(useWriteWorkspaceStore.getState().fileContent).toBe(content)
    await act(async () => button('生成修改建议').click())
    const external = content + '\nChanged after review.\n'
    await act(async () => useWriteWorkspaceStore.setState({ fileContent: external }))
    await act(async () => button('接受修改').click())
    expect(container.textContent).toContain('选区附近的内容已经变化')
    expect(useWriteWorkspaceStore.getState().fileContent).toBe(external)
  })

  it('blocks read-only comment requests', async () => {
    useWriteWorkspaceStore.setState({ fileTruncated: true })
    await openComments()
    expect(button('生成修改建议').disabled).toBe(true)
    await act(async () => button('生成修改建议').click())
    expect(request).not.toHaveBeenCalled()
    expect(useWriteWorkspaceStore.getState().fileContent).toBe(content)
  })

  it('drops completion after a file switch without leaking the old error into the new document', async () => {
    let reject: (error: Error) => void = () => undefined
    request.mockReturnValue(new Promise((_resolve, fail) => { reject = fail }))
    await openComments()
    await act(async () => button('生成修改建议').click())
    const otherPath = '/tmp/synthetic-comments/other.md'
    await act(async () => useWriteWorkspaceStore.setState({ activeFilePath: otherPath, fileContent: 'Other synthetic content.', fileError: null }))
    await act(async () => button('批注').click())
    await act(async () => reject(new Error('Original document request failed.')))
    expect(container.textContent).not.toContain('Original document request failed')
    expect(container.textContent).not.toContain('审阅 AI 修改')
    expect(container.querySelector('[role="dialog"]')).not.toBeNull()
    expect(useWriteWorkspaceStore.getState().fileError).toBeNull()
    expect(useWriteWorkspaceStore.getState().fileContent).toBe('Other synthetic content.')
  })

  it.each(['conflict', 'truncated', 'workspace'] as const)('rejects %s introduced after review even when text is byte-identical', async (change) => {
    await openComments()
    await act(async () => button('生成修改建议').click())
    await act(async () => {
      if (change === 'conflict') useWriteWorkspaceStore.setState({ documentConflict: { path, expectedRevision: null, currentRevision: null, currentContent: 'External content.', attemptedContent: content } })
      else if (change === 'truncated') useWriteWorkspaceStore.setState({ fileTruncated: true })
      else useWriteWorkspaceStore.setState({ workspaceRoot: '/tmp/different-workspace' })
    })
    await act(async () => button('接受修改').click())
    expect(container.textContent).toContain('选区附近的内容已经变化')
    expect(useWriteWorkspaceStore.getState().fileContent).toBe(content)
  })
})
