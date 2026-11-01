import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWriteWorkspaceStore } from './write-workspace-store'

function installDsGui(overrides: Partial<Window['workwise']>): void {
  vi.stubGlobal('window', {
    workwise: overrides
  })
}

function activateTextFile(path = '/tmp/write/draft.md'): void {
  useWriteWorkspaceStore.setState({
    activeFilePath: path,
    activeFileKind: 'text',
    fileContent: 'old content',
    fileError: null,
    fileLoading: false,
    saveStatus: 'saved'
  })
}

afterEach(() => {
  useWriteWorkspaceStore.getState().resetWorkspace()
  vi.unstubAllGlobals()
})

describe('write workspace store', () => {
  it('reports read errors when syncing the active text file from disk', async () => {
    installDsGui({
      readWorkspaceFile: vi.fn(async () => {
        throw new Error('read failed')
      })
    })
    activateTextFile()

    const result = await useWriteWorkspaceStore.getState().syncActiveFileFromDisk('/tmp/write')

    expect(result).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      fileError: 'read failed',
      saveStatus: 'error'
    })
  })

  it('does not apply late read errors after the active text file changes', async () => {
    installDsGui({
      readWorkspaceFile: vi.fn(async () => {
        useWriteWorkspaceStore.setState({ activeFilePath: '/tmp/write/next.md' })
        throw new Error('late read failed')
      })
    })
    activateTextFile()

    const result = await useWriteWorkspaceStore.getState().syncActiveFileFromDisk('/tmp/write')

    expect(result).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      activeFilePath: '/tmp/write/next.md',
      fileError: null,
      saveStatus: 'saved'
    })
  })

  it('preserves current and external content when a checked save conflicts', async () => {
    const baseline = { fingerprint: 'baseline', size: 3, modifiedAt: 1 }
    const writeDocumentChecked = vi.fn(async () => ({ ok: false as const, conflict: {
      path: '/tmp/write/draft.md', expectedRevision: baseline,
      currentRevision: { fingerprint: 'external', size: 8, modifiedAt: 2 },
      currentContent: 'external', attemptedContent: 'my edit'
    } }))
    installDsGui({
      readWorkspaceFile: vi.fn(async () => ({ ok: true as const, path: '/tmp/write/draft.md', content: 'old', size: 3, truncated: false })),
      readDocumentSnapshot: vi.fn(async () => ({ path: '/tmp/write/draft.md', content: 'old', revision: baseline })),
      writeDocumentChecked
    })
    await useWriteWorkspaceStore.getState().openFile('/tmp/write', '/tmp/write/draft.md')
    useWriteWorkspaceStore.getState().setFileContent('my edit')
    expect(await useWriteWorkspaceStore.getState().flushSave('/tmp/write')).toBe(false)
    expect(writeDocumentChecked).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: baseline }))
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: 'my edit', documentConflict: { currentContent: 'external', attemptedContent: 'my edit' }, saveStatus: 'error' })
  })

  it('keeps mid-save edits dirty and uses the newly saved revision on the next write', async () => {
    const first = deferred<Awaited<ReturnType<Window['workwise']['writeDocumentChecked']>>>()
    const revision = { fingerprint: 'first', size: 5, modifiedAt: 1 }
    const writeDocumentChecked = vi.fn<Window['workwise']['writeDocumentChecked']>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(async ({ path, content }) => ({ ok: true as const, snapshot: { path, content, revision: { ...revision, fingerprint: 'second' } } }))
    installDsGui({ writeDocumentChecked })
    activateTextFile()
    useWriteWorkspaceStore.getState().setFileContent('first')
    const saving = useWriteWorkspaceStore.getState().flushSave('/tmp/write')
    useWriteWorkspaceStore.getState().setFileContent('second')
    first.resolve({ ok: true, snapshot: { path: '/tmp/write/draft.md', content: 'first', revision } })
    expect(await saving).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: 'second', saveStatus: 'dirty', documentRevision: revision })
    expect(await useWriteWorkspaceStore.getState().flushSave('/tmp/write')).toBe(true)
    expect(writeDocumentChecked.mock.calls[1][0]).toMatchObject({ content: 'second', expectedRevision: revision })
  })

  it('serializes concurrent saves and omits a missing legacy baseline', async () => {
    const pending = deferred<Awaited<ReturnType<Window['workwise']['writeDocumentChecked']>>>()
    const writeDocumentChecked = vi.fn<Window['workwise']['writeDocumentChecked']>(() => pending.promise)
    installDsGui({ writeDocumentChecked })
    activateTextFile()
    useWriteWorkspaceStore.getState().setFileContent('new content')
    const first = useWriteWorkspaceStore.getState().flushSave('/tmp/write')
    const second = useWriteWorkspaceStore.getState().flushSave('/tmp/write')
    expect(writeDocumentChecked).toHaveBeenCalledTimes(1)
    expect(writeDocumentChecked.mock.calls[0]?.[0]?.expectedRevision).toBeUndefined()
    pending.resolve({ ok: true, snapshot: { path: '/tmp/write/draft.md', content: 'new content', revision: { fingerprint: 'new', size: 11, modifiedAt: 1 } } })
    expect(await first).toBe(true)
    expect(await second).toBe(true)
    expect(writeDocumentChecked).toHaveBeenCalledTimes(1)
  })

  it('ignores an older watch payload and rebaselines from authoritative content', async () => {
    installDsGui({
      readWorkspaceFile: vi.fn(async () => ({ ok: true as const, path: '/tmp/write/draft.md', content: 'legacy stale', size: 12, truncated: false })),
      readDocumentSnapshot: vi.fn(async () => ({ path: '/tmp/write/draft.md', content: 'actual disk', revision: { fingerprint: 'actual', size: 11, modifiedAt: 1 } }))
    })
    activateTextFile()
    expect(await useWriteWorkspaceStore.getState().syncActiveFileFromDisk('/tmp/write', { content: 'older event', animate: false })).toBe(true)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: 'actual disk', documentRevision: { fingerprint: 'actual' } })
  })

  it('does not overwrite an edit entered during a forced disk read', async () => {
    const pending = deferred<Awaited<ReturnType<Window['workwise']['readWorkspaceFile']>>>()
    installDsGui({ readWorkspaceFile: vi.fn(() => pending.promise) })
    activateTextFile()
    const sync = useWriteWorkspaceStore.getState().syncActiveFileFromDisk('/tmp/write', { force: true })
    useWriteWorkspaceStore.getState().setFileContent('typed while reading')
    pending.resolve({ ok: true, path: '/tmp/write/draft.md', content: 'external', size: 8, truncated: false })
    expect(await sync).toBe(false)
    expect(useWriteWorkspaceStore.getState().fileContent).toBe('typed while reading')
  })


  it('keeps both versions when an external edit arrives immediately after a checked write', async () => {
    installDsGui({ writeDocumentChecked: vi.fn(async ({ path }) => ({ ok: true as const, snapshot: { path, content: 'external after save', revision: { fingerprint: 'external', size: 19, modifiedAt: 2 } } })) })
    activateTextFile()
    useWriteWorkspaceStore.getState().setFileContent('my edit')
    expect(await useWriteWorkspaceStore.getState().flushSave('/tmp/write')).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: 'my edit', documentConflict: { attemptedContent: 'my edit', currentContent: 'external after save' }, saveStatus: 'error' })
  })


  it('commits a growing external snapshot atomically before accepting typing', async () => {
    installDsGui({})
    activateTextFile()
    await useWriteWorkspaceStore.getState().syncActiveFileFromDisk('/tmp/write', { content: 'old content plus a complete external paragraph', animate: true })
    expect(useWriteWorkspaceStore.getState().fileContent).toBe('old content plus a complete external paragraph')
    useWriteWorkspaceStore.getState().setFileContent(useWriteWorkspaceStore.getState().fileContent + '!')
    expect(useWriteWorkspaceStore.getState().fileContent).toBe('old content plus a complete external paragraph!')
  })

  it('sends an intentional missing-file baseline as null when recreating a retained draft', async () => {
    const writeDocumentChecked = vi.fn<Window['workwise']['writeDocumentChecked']>(async ({ path, content }) => ({ ok: true as const, snapshot: { path, content, revision: { fingerprint: 'recreated', size: content.length, modifiedAt: 1 } } }))
    installDsGui({ writeDocumentChecked })
    activateTextFile()
    useWriteWorkspaceStore.setState({ documentRevision: null, documentBaselineKnown: true })
    expect(await useWriteWorkspaceStore.getState().flushSave('/tmp/write')).toBe(true)
    expect(writeDocumentChecked.mock.calls[0]?.[0]?.expectedRevision).toBeNull()
  })

  it('blocks saves while a relocated destination conflict is awaiting review', async () => {
    const writeDocumentChecked = vi.fn<Window['workwise']['writeDocumentChecked']>()
    installDsGui({ writeDocumentChecked })
    activateTextFile()
    useWriteWorkspaceStore.setState({ documentConflict: { path: '/tmp/write/draft.md', expectedRevision: null, currentRevision: null, currentContent: 'other', attemptedContent: 'old content' } })
    expect(await useWriteWorkspaceStore.getState().flushSave('/tmp/write')).toBe(false)
    expect(writeDocumentChecked).not.toHaveBeenCalled()
  })


  it('shows missing-file watch errors while retaining dirty content', async () => {
    installDsGui({})
    activateTextFile()
    useWriteWorkspaceStore.getState().setFileContent('unsaved draft')
    expect(await useWriteWorkspaceStore.getState().syncActiveFileFromDisk('/tmp/write', { path: '/tmp/write/draft.md', message: 'File was moved or deleted.' })).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({ fileContent: 'unsaved draft', fileError: 'File was moved or deleted.', saveStatus: 'error' })
  })

})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value) => resolve(value) }
}
