import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultWriteSettings } from '@shared/app-settings'
import { createWriteFileActions } from './write-workspace-file-actions'
import { activeFileStorageKey, initialState, readWorkspaceSession, workspaceSessionStorageKey } from './write-workspace-store-helpers'
import type { WriteWorkspaceGet, WriteWorkspaceSet, WriteWorkspaceState } from './write-workspace-store-types'

function makeBaseState(): WriteWorkspaceState {
  return {
    defaultWorkspaceRoot: '',
    workspaceRoots: [],
    inlineCompletion: defaultWriteSettings().inlineCompletion,
    knowledgeBase: defaultWriteSettings().knowledgeBase,
    inlineCompletionApiReady: false,
    imageGenReady: false,
    settingsLoading: false,
    settingsError: null,
    ...initialState(),
    previewMode: 'live',
    assistantOpen: true,
    assistantModel: 'auto',
    loadWriteSettings: async () => undefined,
    selectWriteWorkspace: async () => undefined,
    addWriteWorkspace: async () => undefined,
    removeWriteWorkspace: async () => undefined,
    initializeWorkspace: async () => undefined,
    loadDirectory: async () => null,
    toggleDirectory: async () => undefined,
    refreshWorkspace: async () => undefined,
    openFile: async () => undefined,
    selectTab: async () => undefined,
    relocateActiveDocument: async () => false,
    closeFile: async () => true,
    restoreClosedFile: async () => undefined,
    toggleTabPinned: () => undefined,
    setFileContent: () => undefined,
    syncActiveFileFromDisk: async () => false,
    syncActiveImageFromDisk: async () => false,
    flushSave: async () => true,
    createFile: async () => null,
    createDirectory: async () => null,
    renameEntry: async () => null,
    deleteEntry: async () => false,
    setFileError: () => undefined,
    setPreviewMode: () => undefined,
    setAssistantOpen: () => undefined,
    setAssistantModel: () => undefined,
    setSelection: () => undefined,
    recordRecentEdits: () => undefined,
    quoteCurrentSelection: () => undefined,
    removeQuotedSelection: () => undefined,
    clearQuotedSelections: () => undefined,
    resetWorkspace: () => undefined
  }
}

function createHarness(overrides: Partial<WriteWorkspaceState> = {}): {
  actions: ReturnType<typeof createWriteFileActions>
  get: WriteWorkspaceGet
  set: WriteWorkspaceSet
} {
  let state = { ...makeBaseState(), ...overrides }
  const set: WriteWorkspaceSet = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...patch }
  }
  const get: WriteWorkspaceGet = () => state
  const actions = createWriteFileActions({
    set,
    get,
    cancelExternalSyncAnimation: vi.fn(),
    setLastSavedContent: vi.fn()
  })
  state = { ...state, ...actions }
  return { actions, get, set }
}

function installDsGui(overrides: Partial<Window['workwise']>): void {
  vi.stubGlobal('window', {
    workwise: overrides
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('write workspace file actions', () => {
  it('clears loading state and records list errors when directory IPC throws', async () => {
    installDsGui({
      listWorkspaceDirectory: vi.fn(async () => {
        throw new Error('bridge down')
      })
    })
    const { actions, get } = createHarness()

    const result = await actions.loadDirectory('/tmp/write')

    expect(result).toBeNull()
    expect(get().loadingDirs).toEqual({})
    expect(get().treeError).toBe('bridge down')
  })

  it('returns null and reports file errors when create file IPC throws', async () => {
    installDsGui({
      createWorkspaceFile: vi.fn(async () => {
        throw new Error('create failed')
      })
    })
    const { actions, get } = createHarness()

    const result = await actions.createFile('/tmp/write', 'draft.md')

    expect(result).toBeNull()
    expect(get().fileError).toBe('create failed')
  })

  it('returns null and reports file errors when rename IPC throws', async () => {
    installDsGui({
      renameWorkspaceEntry: vi.fn(async () => {
        throw new Error('rename failed')
      })
    })
    const { actions, get } = createHarness()

    const result = await actions.renameEntry('/tmp/write', '/tmp/write/draft.md', 'final.md')

    expect(result).toBeNull()
    expect(get().fileError).toBe('rename failed')
  })

  it('returns false and reports file errors when delete IPC throws', async () => {
    installDsGui({
      deleteWorkspaceEntry: vi.fn(async () => {
        throw new Error('delete failed')
      })
    })
    const { actions, get } = createHarness()

    const result = await actions.deleteEntry('/tmp/write', '/tmp/write/draft.md')

    expect(result).toBe(false)
    expect(get().fileError).toBe('delete failed')
  })

  it('opens files as tabs and closes the active tab to the previous tab', async () => {
    installDsGui({
      readWorkspaceFile: vi.fn(async ({ path }: { path: string }) => ({
        ok: true as const,
        path,
        content: path.endsWith('one.md') ? '# one' : '# two',
        size: 5,
        truncated: false
      }))
    })
    const { actions, get } = createHarness()

    await actions.openFile('/tmp/write', '/tmp/write/one.md')
    await actions.openFile('/tmp/write', '/tmp/write/two.md')
    expect(get().tabs.map((tab) => tab.path)).toEqual(['/tmp/write/one.md', '/tmp/write/two.md'])
    expect(get().activeFilePath).toBe('/tmp/write/two.md')

    await actions.closeFile('/tmp/write', '/tmp/write/two.md')
    expect(get().activeFilePath).toBe('/tmp/write/one.md')
    expect(get().recentlyClosedTabs[0]?.path).toBe('/tmp/write/two.md')
  })

  it('keeps the newest requested tab when reads finish out of order', async () => {
    const first = deferred<Awaited<ReturnType<Window['workwise']['readWorkspaceFile']>>>()
    const second = deferred<Awaited<ReturnType<Window['workwise']['readWorkspaceFile']>>>()
    installDsGui({ readWorkspaceFile: vi.fn(({ path }) => path.endsWith('one.md') ? first.promise : second.promise) })
    const { actions, get } = createHarness()
    const openingFirst = actions.openFile('/tmp/write', '/tmp/write/one.md')
    await Promise.resolve()
    const openingSecond = actions.openFile('/tmp/write', '/tmp/write/two.md')
    await Promise.resolve()
    second.resolve(textFile('/tmp/write/two.md', 'second'))
    await openingSecond
    first.resolve(textFile('/tmp/write/one.md', 'first'))
    await openingFirst
    expect(get().activeFilePath).toBe('/tmp/write/two.md')
    expect(get().fileContent).toBe('second')
    expect(get().tabs).toHaveLength(1)
  })

  it('does not replace edits typed while the destination is loading', async () => {
    const next = deferred<Awaited<ReturnType<Window['workwise']['readWorkspaceFile']>>>()
    installDsGui({ readWorkspaceFile: vi.fn(() => next.promise) })
    const { actions, get, set } = createHarness({ activeFilePath: '/tmp/write/current.md', activeFileKind: 'text', fileContent: 'draft' })
    const opening = actions.openFile('/tmp/write', '/tmp/write/next.md')
    await Promise.resolve()
    set({ fileContent: 'new user edit', saveStatus: 'dirty' })
    next.resolve(textFile('/tmp/write/next.md', 'next'))
    await opening
    expect(get()).toMatchObject({ activeFilePath: '/tmp/write/current.md', fileContent: 'new user edit', fileLoading: false })
  })

  it('uses content and baseline from the same authoritative snapshot', async () => {
    installDsGui({
      readWorkspaceFile: vi.fn(async () => textFile('/tmp/write/draft.md', 'older read')),
      readDocumentSnapshot: vi.fn(async () => ({ path: '/tmp/write/draft.md', content: 'new snapshot', revision: { fingerprint: 'new', size: 12, modifiedAt: 2 } }))
    })
    const { actions, get } = createHarness()
    await actions.openFile('/tmp/write', '/tmp/write/draft.md')
    expect(get()).toMatchObject({ fileContent: 'new snapshot', documentRevision: { fingerprint: 'new' } })
  })

  it('keeps the dirty tab when the replacement fails, and supports cancel/discard', async () => {
    const flushSave = vi.fn(async () => false)
    const tabs = ['one', 'two'].map((name) => ({ id: `/tmp/write/${name}.md`, path: `/tmp/write/${name}.md`, kind: 'text' as const, pinned: false, openedAt: 1 }))
    installDsGui({ readWorkspaceFile: vi.fn(async () => ({ ok: false as const, message: 'missing destination' })) })
    const { actions, get } = createHarness({ tabs, activeTabId: tabs[1].id, activeFilePath: tabs[1].path, activeFileKind: 'text', fileContent: 'unsaved', saveStatus: 'dirty', flushSave })
    expect(await actions.closeFile('/tmp/write', tabs[1].path, 'cancel')).toBe(false)
    expect(flushSave).not.toHaveBeenCalled()
    expect(await actions.closeFile('/tmp/write', tabs[1].path, 'discard')).toBe(false)
    expect(get()).toMatchObject({ fileContent: 'unsaved', activeFilePath: tabs[1].path, recentlyClosedTabs: [] })
    expect(get().tabs).toHaveLength(2)
    expect(flushSave).not.toHaveBeenCalled()
    installDsGui({ readWorkspaceFile: vi.fn(async () => textFile(tabs[0].path, 'one')) })
    expect(await actions.closeFile('/tmp/write', tabs[1].path, 'discard')).toBe(true)
    expect(get().activeFilePath).toBe(tabs[0].path)
  })

  it('persists open, pinned, recently closed and recently opened tabs across restart', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    installDsGui({
      readWorkspaceFile: vi.fn(async ({ path }) => textFile(path, path)),
      listWorkspaceDirectory: vi.fn(async () => ({ ok: true as const, root: '/tmp/write', entries: [] }))
    })
    const first = createHarness({ workspaceRoot: '/tmp/write' })
    await first.actions.openFile('/tmp/write', '/tmp/write/one.md')
    first.actions.toggleTabPinned('/tmp/write/one.md')
    await first.actions.openFile('/tmp/write', '/tmp/write/two.md')
    await first.actions.closeFile('/tmp/write', '/tmp/write/two.md')
    const second = createHarness()
    await second.actions.initializeWorkspace('/tmp/write')
    expect(second.get().tabs).toMatchObject([{ path: '/tmp/write/one.md', pinned: true }])
    expect(second.get().activeTabId).toBe('/tmp/write/one.md')
    expect(second.get().recentlyClosedTabs[0]?.path).toBe('/tmp/write/two.md')
    expect(second.get().recentlyOpenedTabs.map((tab) => tab.path)).toContain('/tmp/write/two.md')
    await second.actions.restoreClosedFile('/tmp/write')
    expect(second.get().activeFilePath).toBe('/tmp/write/two.md')
    expect(second.get().recentlyClosedTabs).toEqual([])
  })

  it('migrates the legacy active path while rejecting unsafe persisted session paths', async () => {
    const storage = memoryStorage()
    vi.stubGlobal('localStorage', storage)
    storage.setItem(activeFileStorageKey('/tmp/write'), '/tmp/write/legacy.md')
    installDsGui({
      readWorkspaceFile: vi.fn(async ({ path }) => textFile(path, 'legacy')),
      listWorkspaceDirectory: vi.fn(async () => ({ ok: true as const, root: '/tmp/write', entries: [] }))
    })
    const { actions, get } = createHarness()
    await actions.initializeWorkspace('/tmp/write')
    expect(get().tabs[0]?.path).toBe('/tmp/write/legacy.md')
    expect(storage.getItem(activeFileStorageKey('/tmp/write'))).toBe('/tmp/write/legacy.md')
    storage.setItem(workspaceSessionStorageKey('/tmp/write'), JSON.stringify({ version: 1, tabs: [{ path: '/tmp/write/../escape.md' }, { path: '/other/private.md' }, { path: '/tmp/write/valid.md' }] }))
    expect(readWorkspaceSession('/tmp/write')?.tabs.map((tab) => tab.path)).toEqual(['/tmp/write/valid.md'])
  })

  it('updates descendant identities on directory rename and selects another tab after deletion', async () => {
    installDsGui({
      readWorkspaceFile: vi.fn(async ({ path }) => textFile(path, path)),
      listWorkspaceDirectory: vi.fn(async () => ({ ok: true as const, root: '/tmp/write', entries: [] })),
      renameWorkspaceEntry: vi.fn(async () => ({ ok: true as const, path: '/tmp/write/new', previousPath: '/tmp/write/old', renamedAt: '' })),
      deleteWorkspaceEntry: vi.fn(async ({ path }) => ({ ok: true as const, path, deletedAt: '' }))
    })
    const { actions, get } = createHarness({ workspaceRoot: '/tmp/write' })
    await actions.openFile('/tmp/write', '/tmp/write/keep.md')
    await actions.openFile('/tmp/write', '/tmp/write/old/draft.md')
    await actions.renameEntry('/tmp/write', '/tmp/write/old', 'new')
    expect(get().activeTabId).toBe('/tmp/write/new/draft.md')
    expect(get().recentlyOpenedTabs[0]?.path).toBe('/tmp/write/new/draft.md')
    await actions.deleteEntry('/tmp/write', '/tmp/write/new')
    expect(get().activeFilePath).toBe('/tmp/write/keep.md')
    expect(get().tabs.map((tab) => tab.path)).toEqual(['/tmp/write/keep.md'])
  })


  it('relocates a moved file with matching baseline without losing unsaved edits', async () => {
    const baseline = { fingerprint: 'original', size: 4, modifiedAt: 1 }
    installDsGui({
      readWorkspaceFile: vi.fn(async ({ path }) => textFile(path, 'base')),
      readDocumentSnapshot: vi.fn(async ({ path }) => ({ path, content: 'base', revision: baseline }))
    })
    const { actions, get, set } = createHarness()
    await actions.openFile('/tmp/write', '/tmp/write/original.md')
    set({ fileContent: 'unsaved additions', saveStatus: 'dirty' })
    expect(await actions.relocateActiveDocument('/tmp/write', '/tmp/write/moved.md')).toBe(true)
    expect(get()).toMatchObject({ activeFilePath: '/tmp/write/moved.md', fileContent: 'unsaved additions', documentRevision: baseline, documentBaselineKnown: true, documentConflict: null, saveStatus: 'dirty' })
    expect(get().tabs.map((tab) => tab.path)).toEqual(['/tmp/write/moved.md'])
  })

  it('requires conflict review when relocation points at different content and retains the draft', async () => {
    installDsGui({
      readWorkspaceFile: vi.fn(async ({ path }) => textFile(path, 'other')),
      readDocumentSnapshot: vi.fn(async ({ path }) => ({ path, content: 'other', revision: { fingerprint: 'other', size: 5, modifiedAt: 2 } }))
    })
    const { actions, get } = createHarness({ activeFilePath: '/tmp/write/missing.md', activeFileKind: 'text', fileContent: 'retained draft', documentRevision: { fingerprint: 'old', size: 3, modifiedAt: 1 }, documentBaselineKnown: true })
    expect(await actions.relocateActiveDocument('/tmp/write', '/tmp/write/other.md')).toBe(true)
    expect(get()).toMatchObject({ activeFilePath: '/tmp/write/other.md', fileContent: 'retained draft', documentConflict: { attemptedContent: 'retained draft', currentContent: 'other' } })
  })

  it('retains the original path and buffer when relocation validation fails', async () => {
    installDsGui({ readWorkspaceFile: vi.fn(async () => ({ ok: false as const, message: 'Path is outside the workspace.' })) })
    const { actions, get } = createHarness({ activeFilePath: '/tmp/write/missing.md', activeFileKind: 'text', fileContent: 'draft' })
    expect(await actions.relocateActiveDocument('/tmp/write', '../outside.md')).toBe(false)
    expect(get()).toMatchObject({ activeFilePath: '/tmp/write/missing.md', fileContent: 'draft', fileError: 'Path is outside the workspace.', fileLoading: false })
  })

})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value) => resolve(value) }
}
function textFile(path: string, content: string) {
  return { ok: true as const, path, content, size: content.length, truncated: false }
}
function memoryStorage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
