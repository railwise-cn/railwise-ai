import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckedDocumentWriteResult, DocumentSnapshot } from '@shared/write-document'
import { isWriteWorkspaceReadyForUpdate, useWriteWorkspaceStore } from './write-workspace-store'

const workspaceRoot = '/tmp/restore-races'
const path = `${workspaceRoot}/a.md`
const otherPath = `${workspaceRoot}/b.md`
const original: DocumentSnapshot = { path, content: 'Reviewed current content', revision: { fingerprint: 'baseline', size: 24, modifiedAt: 1 } }
const historical: DocumentSnapshot = { path, content: 'Historical content', revision: { fingerprint: 'restored', size: 18, modifiedAt: 2 } }
const input = { workspaceRoot, path, id: 'history-1', content: original.content, historyContent: historical.content }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value) => resolve(value) }
}

async function openOriginal(overrides: Partial<Window['workwise']> = {}): Promise<void> {
  vi.stubGlobal('window', { workwise: {
    readWorkspaceFile: vi.fn(async ({ path: requested }: { path: string }) => ({ ok: true, path: requested, content: requested === path ? original.content : 'Other content', size: 24, truncated: false })),
    readDocumentSnapshot: vi.fn(async ({ path: requested }: { path: string }) => requested === path ? original : { path: otherPath, content: 'Other content', revision: { fingerprint: 'other', size: 13, modifiedAt: 1 } }),
    writeDocumentChecked: vi.fn(),
    restoreDocumentHistory: vi.fn(async () => ({ ok: true, snapshot: historical })),
    ...overrides
  } })
  useWriteWorkspaceStore.setState({ workspaceRoot })
  await useWriteWorkspaceStore.getState().openFile(workspaceRoot, path)
}

beforeEach(() => useWriteWorkspaceStore.getState().resetWorkspace())
afterEach(() => { useWriteWorkspaceStore.getState().resetWorkspace(); vi.unstubAllGlobals() })

describe('bound history restoration', () => {
  it('commits an unchanged transaction from one authoritative reread without writing the reread back', async () => {
    const read = vi.fn<Window['workwise']['readDocumentSnapshot']>().mockResolvedValueOnce(original).mockResolvedValueOnce(historical)
    await openOriginal({ readDocumentSnapshot: read })
    expect(await useWriteWorkspaceStore.getState().restoreHistoryEntry(input)).toBe(true)
    expect(window.workwise.restoreDocumentHistory).toHaveBeenCalledWith({ workspaceRoot, path, id: input.id, expectedRevision: original.revision })
    expect(read.mock.calls[1][0]).toEqual({ workspaceRoot, path })
    expect(window.workwise.writeDocumentChecked).not.toHaveBeenCalled()
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: historical.content, documentRevision: historical.revision, saveStatus: 'saved', documentConflict: null })
  })

  it('refuses stale reviewed content before saving or dispatching a restore', async () => {
    await openOriginal()
    useWriteWorkspaceStore.getState().setFileContent('A new draft after opening history')
    expect(await useWriteWorkspaceStore.getState().restoreHistoryEntry(input)).toBe(false)
    expect(window.workwise.restoreDocumentHistory).not.toHaveBeenCalled()
    expect(window.workwise.writeDocumentChecked).not.toHaveBeenCalled()
    expect(useWriteWorkspaceStore.getState().fileContent).toBe('A new draft after opening history')
  })

  it('refuses a stale restore start when editing continues during the baseline save', async () => {
    const pending = deferred<CheckedDocumentWriteResult>()
    await openOriginal({ writeDocumentChecked: vi.fn(() => pending.promise) })
    useWriteWorkspaceStore.getState().setFileContent('Reviewed draft')
    const restoring = useWriteWorkspaceStore.getState().restoreHistoryEntry({ ...input, content: 'Reviewed draft' })
    useWriteWorkspaceStore.getState().setFileContent('Newer draft during save')
    pending.resolve({ ok: true, snapshot: { ...original, content: 'Reviewed draft' } })
    expect(await restoring).toBe(false)
    expect(window.workwise.restoreDocumentHistory).not.toHaveBeenCalled()
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: 'Newer draft during save', saveStatus: 'dirty' })
  })

  it('preserves new drafts entered before and during the completion read as a structured conflict', async () => {
    const restore = deferred<CheckedDocumentWriteResult>()
    const reread = deferred<DocumentSnapshot>()
    const read = vi.fn<Window['workwise']['readDocumentSnapshot']>().mockResolvedValueOnce(original).mockImplementationOnce(() => reread.promise)
    await openOriginal({ restoreDocumentHistory: vi.fn(() => restore.promise), readDocumentSnapshot: read })
    const restoring = useWriteWorkspaceStore.getState().restoreHistoryEntry(input)
    await Promise.resolve()
    expect(isWriteWorkspaceReadyForUpdate()).toBe(false)
    useWriteWorkspaceStore.getState().setFileContent('New draft while restoring')
    expect(await useWriteWorkspaceStore.getState().flushSave(workspaceRoot)).toBe(false)
    expect(await useWriteWorkspaceStore.getState().syncActiveFileFromDisk(workspaceRoot, { force: true })).toBe(false)
    await useWriteWorkspaceStore.getState().openFile(workspaceRoot, otherPath)
    expect(useWriteWorkspaceStore.getState().activeFilePath).toBe(path)
    expect(useWriteWorkspaceStore.getState().fileContent).toBe('New draft while restoring')
    restore.resolve({ ok: true, snapshot: historical })
    await Promise.resolve(); await Promise.resolve()
    useWriteWorkspaceStore.getState().setFileContent('Latest draft during disk reread')
    reread.resolve(historical)
    expect(await restoring).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      fileContent: 'Latest draft during disk reread', saveStatus: 'error',
      documentConflict: { path, expectedRevision: original.revision, currentRevision: historical.revision, currentContent: historical.content, attemptedContent: 'Latest draft during disk reread' }
    })
    expect(window.workwise.writeDocumentChecked).not.toHaveBeenCalled()
  })

  it('invalidates a forced read that was already in flight before restoration started', async () => {
    const legacy = deferred<Awaited<ReturnType<Window['workwise']['readWorkspaceFile']>>>()
    const restore = deferred<CheckedDocumentWriteResult>()
    const read = vi.fn<Window['workwise']['readDocumentSnapshot']>()
      .mockResolvedValueOnce(original).mockResolvedValueOnce(original).mockResolvedValueOnce(historical)
    const readWorkspaceFile = vi.fn<Window['workwise']['readWorkspaceFile']>()
      .mockResolvedValueOnce({ ok: true, path, content: original.content, size: 24, truncated: false })
      .mockImplementationOnce(() => legacy.promise)
    await openOriginal({ restoreDocumentHistory: vi.fn(() => restore.promise), readDocumentSnapshot: read, readWorkspaceFile })
    const oldRead = useWriteWorkspaceStore.getState().syncActiveFileFromDisk(workspaceRoot, { force: true })
    const restoring = useWriteWorkspaceStore.getState().restoreHistoryEntry(input)
    await Promise.resolve()
    legacy.resolve({ ok: true, path, content: 'Outdated watch payload', size: 22, truncated: false })
    expect(await oldRead).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: original.content, documentRevision: original.revision })
    restore.resolve({ ok: true, snapshot: historical })
    expect(await restoring).toBe(true)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: historical.content, documentRevision: historical.revision })
  })

  it('does not touch a new active document after an explicit discard while restoring', async () => {
    const restore = deferred<CheckedDocumentWriteResult>()
    await openOriginal({ restoreDocumentHistory: vi.fn(() => restore.promise) })
    // Opening B first creates its tab; reopening A preserves the same reviewed baseline.
    await useWriteWorkspaceStore.getState().openFile(workspaceRoot, otherPath)
    await useWriteWorkspaceStore.getState().openFile(workspaceRoot, path)
    const restoring = useWriteWorkspaceStore.getState().restoreHistoryEntry(input)
    await Promise.resolve()
    useWriteWorkspaceStore.getState().setFileContent('Draft explicitly discarded by the user')
    expect(await useWriteWorkspaceStore.getState().closeFile(workspaceRoot, path, 'discard')).toBe(true)
    useWriteWorkspaceStore.getState().setFileContent('Unsaved B draft')
    const readsBeforeCompletion = vi.mocked(window.workwise.readDocumentSnapshot).mock.calls.length
    restore.resolve({ ok: true, snapshot: historical })
    expect(await restoring).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ activeFilePath: otherPath, fileContent: 'Unsaved B draft', saveStatus: 'dirty', documentConflict: null })
    expect(vi.mocked(window.workwise.readDocumentSnapshot).mock.calls.length).toBe(readsBeforeCompletion)
    expect(window.workwise.writeDocumentChecked).not.toHaveBeenCalled()
  })

  it('keeps the current draft when disk changes again between restore and authoritative read', async () => {
    const external = { ...historical, content: 'External content after restore', revision: { ...historical.revision, fingerprint: 'external' } }
    const read = vi.fn<Window['workwise']['readDocumentSnapshot']>().mockResolvedValueOnce(original).mockResolvedValueOnce(external)
    await openOriginal({ readDocumentSnapshot: read })
    expect(await useWriteWorkspaceStore.getState().restoreHistoryEntry(input)).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: original.content, documentConflict: { currentContent: external.content, attemptedContent: original.content }, saveStatus: 'error' })
    expect(window.workwise.writeDocumentChecked).not.toHaveBeenCalled()
  })

  it.each(['read-failure', 'wrong-completion-path', 'wrong-read-path'] as const)('blocks further autosave after a committed restore with %s', async (failure) => {
    const read = vi.fn<Window['workwise']['readDocumentSnapshot']>().mockResolvedValueOnce(original)
    if (failure === 'read-failure') read.mockRejectedValueOnce(new Error('Synthetic read failure'))
    else read.mockResolvedValueOnce({ ...historical, path: failure === 'wrong-read-path' ? otherPath : path })
    await openOriginal({
      readDocumentSnapshot: read,
      restoreDocumentHistory: vi.fn(async () => ({ ok: true as const, snapshot: { ...historical, path: failure === 'wrong-completion-path' ? otherPath : path } }))
    })
    expect(await useWriteWorkspaceStore.getState().restoreHistoryEntry(input)).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      fileContent: original.content, saveStatus: 'error',
      documentConflict: { path, attemptedContent: original.content }
    })
    useWriteWorkspaceStore.getState().setFileContent('Draft retained after failed verification')
    expect(await useWriteWorkspaceStore.getState().flushSave(workspaceRoot)).toBe(false)
    expect(window.workwise.writeDocumentChecked).not.toHaveBeenCalled()
  })
})
