import i18n from '../i18n'
import { isWriteImageFilePath, isWriteWorkspaceFilePath } from '@shared/write-text-file'
import { writePathToFileUrl } from '@shared/write-markdown-resource'
import type { WriteWorkspaceGet, WriteWorkspaceSet, WriteWorkspaceState } from './write-workspace-store-types'
import type { WriteActiveFileKind } from './write-workspace-store-types'
import { readWriteDocument } from './write-document-reader'
import {
  emptySelection,
  filterWriteEntries,
  formatWriteImageLoadError,
  imageMimeTypeFromPath,
  initialState,
  isMissingImageIpc,
  normalizePath,
  readRememberedActiveFile,
  readWorkspaceSession,
  rememberActiveFile,
  rememberWorkspaceSession,
  writeDirnameFromPath
} from './write-workspace-store-helpers'
import {
  archiveWriteFileContext,
  moveWriteFileContext,
  readWriteThreadRegistry,
  saveWriteThreadRegistry
} from './write-thread-registry'

type WriteFileActions = Pick<
  WriteWorkspaceState,
  | 'initializeWorkspace'
  | 'loadDirectory'
  | 'toggleDirectory'
  | 'refreshWorkspace'
  | 'openFile'
  | 'selectTab'
  | 'relocateActiveDocument'
  | 'closeFile'
  | 'restoreClosedFile'
  | 'toggleTabPinned'
  | 'createFile'
  | 'createDirectory'
  | 'renameEntry'
  | 'deleteEntry'
>

type WriteFileActionContext = {
  set: WriteWorkspaceSet
  get: WriteWorkspaceGet
  cancelExternalSyncAnimation: () => void
  setLastSavedContent: (content: string) => void
  getLastSavedContent?: () => string
}

function formatActionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function withoutLoadingDirs(
  loadingDirs: Record<string, boolean>,
  keys: Array<string | undefined>
): Record<string, boolean> {
  const next = { ...loadingDirs }
  for (const key of keys) {
    if (key) delete next[key]
  }
  return next
}

function tabIdForPath(path: string): string {
  return path.replaceAll('\\', '/').trim()
}

function upsertActiveTab(
  get: WriteWorkspaceGet,
  set: WriteWorkspaceSet,
  path: string,
  kind: WriteActiveFileKind
): void {
  const id = tabIdForPath(path)
  const now = Date.now()
  set((state) => {
    const existing = state.tabs.find((tab) => tab.id === id)
    const tabs = existing
      ? state.tabs.map((tab) => tab.id === id ? { ...tab, kind, openedAt: tab.openedAt } : tab)
      : [...state.tabs, { id, path, kind, pinned: false, openedAt: now }]
    return {
      tabs, activeTabId: id,
      recentlyOpenedTabs: [{ path, kind, openedAt: now }, ...state.recentlyOpenedTabs.filter((tab) => tab.path !== path)].slice(0, 50)
    }
  })
  // Keep the legacy active path as the source of truth for existing consumers.
  if (get().activeTabId !== id) set({ activeTabId: id })
}

export function createWriteFileActions({
  set,
  get,
  cancelExternalSyncAnimation,
  setLastSavedContent,
  getLastSavedContent
}: WriteFileActionContext): WriteFileActions {
  let openRequest = 0
  const persist = (workspaceRoot: string): void => {
    rememberActiveFile(workspaceRoot, get().activeFilePath)
    rememberWorkspaceSession(workspaceRoot, get())
  }
  const clearActive = (): void => {
    cancelExternalSyncAnimation()
    setLastSavedContent('')
    set({
      activeTabId: null, activeFilePath: null, activeFileKind: null,
      fileContent: '', imageDataUrl: '', imageMimeType: '', fileSize: 0,
      fileTruncated: false, documentRevision: null, documentBaselineKnown: false, documentConflict: null,
      fileLoading: false, fileError: null, saveStatus: 'saved', saveRevision: 0,
      selection: emptySelection(), quotedSelections: []
    })
  }
  const open = async (workspaceRoot: string, path: string, discard = false): Promise<boolean> => {
    const request = ++openRequest
    const workspaceAtStart = get().workspaceRoot
    cancelExternalSyncAnimation()
    if (!discard && !await get().flushSave(workspaceRoot)) {
      if (request === openRequest) set({ fileLoading: false })
      return false
    }
    if (request !== openRequest || get().workspaceRoot !== workspaceAtStart) return false
    if (!isWriteWorkspaceFilePath(path)) {
      set({ fileLoading: false, fileError: i18n.t('common:writeUnsupportedFileType') })
      return false
    }
    const source = get()
    // A late open must never replace a newer selection or edits made while reading.
    const current = (): boolean => request === openRequest && get().workspaceRoot === workspaceAtStart &&
      get().activeFilePath === source.activeFilePath && get().fileContent === source.fileContent
    set({ fileLoading: true, fileError: null })
    try {
      if (isWriteImageFilePath(path)) {
        let image: { path: string; dataUrl: string; mimeType: string; size: number }
        try {
          const result = await window.workwise.readWorkspaceImage({ path, workspaceRoot })
          if (!result.ok) throw new Error(result.message)
          image = result
        } catch (error) {
          if (!isMissingImageIpc(error)) throw error
          image = { path, dataUrl: writePathToFileUrl(path), mimeType: imageMimeTypeFromPath(path), size: 0 }
        }
        if (!current()) {
          if (request === openRequest) set({ fileLoading: false })
          return false
        }
        setLastSavedContent('')
        set({
          activeFilePath: image.path, activeFileKind: 'image', fileContent: '',
          imageDataUrl: image.dataUrl, imageMimeType: image.mimeType, fileSize: image.size,
          fileTruncated: false, documentRevision: null, documentBaselineKnown: false, documentConflict: null,
          fileLoading: false, fileError: null, saveStatus: 'saved', saveRevision: 0,
          selection: emptySelection(), quotedSelections: []
        })
        upsertActiveTab(get, set, image.path, 'image')
      } else {
        const document = await readWriteDocument(workspaceRoot, path)
        if (!current()) {
          if (request === openRequest) set({ fileLoading: false })
          return false
        }
        setLastSavedContent(document.content)
        set({
          activeFilePath: document.path, activeFileKind: 'text', fileContent: document.content,
          imageDataUrl: '', imageMimeType: '', fileSize: document.size,
          fileTruncated: document.truncated, documentRevision: document.documentRevision, documentBaselineKnown: document.documentBaselineKnown, documentConflict: null,
          fileLoading: false, fileError: null, saveStatus: 'saved', saveRevision: 0,
          selection: emptySelection(), quotedSelections: []
        })
        upsertActiveTab(get, set, document.path, 'text')
      }
      persist(workspaceRoot)
      return true
    } catch (error) {
      if (request === openRequest && get().workspaceRoot === workspaceAtStart) {
        set({ fileLoading: false, fileError: isWriteImageFilePath(path) ? formatWriteImageLoadError(error) : formatActionError(error) })
      }
      return false
    }
  }
  return {
    initializeWorkspace: async (workspaceRoot) => {
      const normalized = normalizePath(workspaceRoot.trim())
      if (!normalized) {
        if (get().activeFilePath && !await get().flushSave(get().workspaceRoot)) return
        openRequest += 1
        cancelExternalSyncAnimation()
        setLastSavedContent('')
        set(initialState())
        return
      }
      const current = get()
      if (current.workspaceRoot === normalized && current.rootDirectory) return

      if (current.activeFilePath && !await get().flushSave(current.workspaceRoot)) return
      openRequest += 1
      setLastSavedContent('')
      cancelExternalSyncAnimation()
      set({ ...initialState(), workspaceRoot: normalized })
      const root = await get().loadDirectory(normalized)
      if (!root || get().workspaceRoot !== normalized) return
      set((state) => ({ rootDirectory: root, expandedDirs: new Set([...state.expandedDirs, root]) }))
      const session = readWorkspaceSession(normalized)
      if (session) set({ ...session, activeTabId: null })
      const remembered = session?.activeTabId ?? readRememberedActiveFile(normalized)
      if (remembered.trim() && isWriteWorkspaceFilePath(remembered)) {
        await get().openFile(normalized, remembered)
      } else if (remembered.trim()) {
        rememberActiveFile(normalized, null)
      }
    },

    loadDirectory: async (workspaceRoot, path) => {
      const workspaceAtStart = get().workspaceRoot
      const requestedRoot = normalizePath(path || workspaceRoot)
      const targetKey = path ? requestedRoot : '__root__'
      set((state) => ({ loadingDirs: { ...state.loadingDirs, [targetKey]: true } }))
      let result: Awaited<ReturnType<typeof window.workwise.listWorkspaceDirectory>>
      try {
        result = await window.workwise.listWorkspaceDirectory({ workspaceRoot, path })
      } catch (error) {
        if (get().workspaceRoot !== workspaceAtStart) return null
        set((state) => ({
          loadingDirs: withoutLoadingDirs(state.loadingDirs, [targetKey, requestedRoot]),
          treeError: formatActionError(error)
        }))
        return null
      }
      if (get().workspaceRoot !== workspaceAtStart) return null
      set((state) => {
        const loadingDirs = withoutLoadingDirs(state.loadingDirs, [
          targetKey,
          requestedRoot,
          result.ok ? result.root : undefined
        ])
        return { loadingDirs }
      })
      if (!result.ok) {
        set({ treeError: result.message })
        return null
      }
      const visibleEntries = filterWriteEntries(result.entries)
      set((state) => {
        const entriesByDir = { ...state.entriesByDir, [result.root]: visibleEntries }
        if (requestedRoot && requestedRoot !== result.root) {
          entriesByDir[requestedRoot] = visibleEntries
        }
        const expandedDirs = new Set(state.expandedDirs)
        if (!path) expandedDirs.add(result.root)
        return {
          treeError: null,
          rootDirectory: !path && !state.rootDirectory ? result.root : state.rootDirectory,
          expandedDirs,
          entriesByDir
        }
      })
      return result.root
    },

    toggleDirectory: async (workspaceRoot, path) => {
      const expanded = get().expandedDirs.has(path)
      if (!expanded && !get().entriesByDir[path]) {
        await get().loadDirectory(workspaceRoot, path)
      }
      set((state) => {
        const expandedDirs = new Set(state.expandedDirs)
        if (expandedDirs.has(path)) {
          expandedDirs.delete(path)
        } else {
          expandedDirs.add(path)
        }
        return { expandedDirs }
      })
    },

    refreshWorkspace: async (workspaceRoot) => {
      const state = get()
      const root = state.rootDirectory || await get().loadDirectory(workspaceRoot)
      if (!root) return
      if (!state.rootDirectory) {
        set((latest) => ({ rootDirectory: root, expandedDirs: new Set([...latest.expandedDirs, root]) }))
      }
      const latest = get()
      const targets = new Set([root, ...latest.expandedDirs])
      await Promise.all([...targets].map((dirPath) => get().loadDirectory(workspaceRoot, dirPath)))
    },

    openFile: async (workspaceRoot, path) => { await open(workspaceRoot, path) },

    selectTab: async (workspaceRoot, tabId) => {
      const tab = get().tabs.find((candidate) => candidate.id === tabId)
      if (tab && get().activeTabId !== tab.id) await open(workspaceRoot, tab.path)
    },

    relocateActiveDocument: async (workspaceRoot, path) => {
      const source = get()
      if (!source.activeFilePath || source.activeFileKind !== 'text' || source.fileTruncated) return false
      const request = ++openRequest
      set({ fileLoading: true })
      try {
        // IPC resolves and validates the candidate path inside the workspace.
        const destination = await readWriteDocument(workspaceRoot, path)
        if (request !== openRequest || get().workspaceRoot !== source.workspaceRoot || get().activeFilePath !== source.activeFilePath) return false
        if (destination.truncated) throw new Error('目标文件过大，不能重新定位为可编辑文档。')
        const latest = get()
        const baselineMatches = source.documentRevision && destination.documentRevision
          ? source.documentRevision.fingerprint === destination.documentRevision.fingerprint
          : getLastSavedContent?.() === destination.content
        const conflict = baselineMatches ? null : {
          path: destination.path, expectedRevision: source.documentRevision,
          currentRevision: destination.documentRevision, currentContent: destination.content,
          attemptedContent: latest.fileContent
        }
        const nextId = tabIdForPath(destination.path)
        set({
          activeFilePath: destination.path, activeTabId: nextId,
          documentRevision: destination.documentRevision, documentBaselineKnown: destination.documentBaselineKnown,
          documentConflict: conflict, fileSize: destination.size,
          fileLoading: false, saveStatus: conflict || latest.fileContent !== destination.content ? 'dirty' : 'saved',
          fileError: conflict ? '目标文档与原文档基线不同，已保留双方内容，请确认后继续。' : null,
          tabs: latest.tabs.filter((tab) => tab.path !== destination.path || tab.id === source.activeTabId).map((tab) =>
            tab.id === source.activeTabId ? { ...tab, id: nextId, path: destination.path } : tab)
        })
        if (baselineMatches) setLastSavedContent(destination.content)
        saveWriteThreadRegistry(moveWriteFileContext(workspaceRoot, source.activeFilePath, destination.path, readWriteThreadRegistry()))
        upsertActiveTab(get, set, destination.path, 'text')
        persist(workspaceRoot)
        return true
      } catch (error) {
        if (request === openRequest) set({ fileLoading: false, fileError: formatActionError(error) })
        return false
      }
    },

    closeFile: async (workspaceRoot, path, intent = 'save') => {
      if (intent === 'cancel') return false
      const state = get()
      const targetPath = path ?? state.activeFilePath
      if (!targetPath) return true
      const targetId = tabIdForPath(targetPath)
      const target = state.tabs.find((tab) => tab.id === targetId)
      if (!target) return true
      const index = state.tabs.findIndex((tab) => tab.id === targetId)
      const remaining = state.tabs.filter((tab) => tab.id !== targetId)
      if (state.activeTabId === targetId) {
        const next = remaining[Math.max(0, Math.min(index - 1, remaining.length - 1))]
        if (next) {
          // Commit the close only once the replacement document has loaded.
          if (!await open(workspaceRoot, next.path, intent === 'discard')) return false
        } else {
          const request = ++openRequest
          if (intent === 'save' && !await get().flushSave(workspaceRoot)) return false
          if (request !== openRequest || get().activeTabId !== targetId) return false
          clearActive()
        }
      }
      set((latest) => ({
        tabs: latest.tabs.filter((tab) => tab.id !== targetId),
        recentlyClosedTabs: [
          { path: target.path, kind: target.kind, closedAt: Date.now() },
          ...latest.recentlyClosedTabs.filter((item) => item.path !== target.path)
        ].slice(0, 12)
      }))
      persist(workspaceRoot)
      return true
    },

    restoreClosedFile: async (workspaceRoot) => {
      const recent = get().recentlyClosedTabs[0]
      if (!recent || !await open(workspaceRoot, recent.path)) return
      set((state) => ({ recentlyClosedTabs: state.recentlyClosedTabs.filter((tab) => tab.path !== recent.path) }))
      persist(workspaceRoot)
    },

    toggleTabPinned: (tabId) => {
      set((state) => ({ tabs: state.tabs.map((tab) => tab.id === tabId ? { ...tab, pinned: !tab.pinned } : tab) }))
      persist(get().workspaceRoot)
    },

    createFile: async (workspaceRoot, path, content = '') => {
      let result: Awaited<ReturnType<typeof window.workwise.createWorkspaceFile>>
      try {
        result = await window.workwise.createWorkspaceFile({ workspaceRoot, path, content })
      } catch (error) {
        set({ fileError: formatActionError(error) })
        return null
      }
      if (!result.ok) {
        set({ fileError: result.message })
        return null
      }
      await get().refreshWorkspace(workspaceRoot)
      await get().openFile(workspaceRoot, result.path)
      return result.path
    },

    createDirectory: async (workspaceRoot, path) => {
      let result: Awaited<ReturnType<typeof window.workwise.createWorkspaceDirectory>>
      try {
        result = await window.workwise.createWorkspaceDirectory({ workspaceRoot, path })
      } catch (error) {
        set({ fileError: formatActionError(error) })
        return null
      }
      if (!result.ok) {
        set({ fileError: result.message })
        return null
      }
      set((state) => {
        const expandedDirs = new Set(state.expandedDirs)
        expandedDirs.add(writeDirnameFromPath(result.path))
        return { expandedDirs }
      })
      await get().refreshWorkspace(workspaceRoot)
      return result.path
    },

    renameEntry: async (workspaceRoot, path, newName, targetDirectory) => {
      if (!await get().flushSave(workspaceRoot)) return null
      openRequest += 1
      cancelExternalSyncAnimation()
      const activeFileBeforeRename = get().activeFilePath
      let result: Awaited<ReturnType<typeof window.workwise.renameWorkspaceEntry>>
      try {
        result = await window.workwise.renameWorkspaceEntry({ workspaceRoot, path, newName, targetDirectory })
      } catch (error) {
        set({ fileError: formatActionError(error) })
        return null
      }
      if (!result.ok) {
        set({ fileError: result.message })
        return null
      }
      if (activeFileBeforeRename) {
        const previousPrefixForContext = `${normalizePath(result.previousPath)}/`
        const nextActiveContext = activeFileBeforeRename === result.previousPath
          ? result.path
          : activeFileBeforeRename.startsWith(previousPrefixForContext)
            ? `${result.path}/${activeFileBeforeRename.slice(previousPrefixForContext.length)}`
            : null
        if (nextActiveContext) {
          saveWriteThreadRegistry(
            moveWriteFileContext(
              workspaceRoot,
              activeFileBeforeRename,
              nextActiveContext,
              readWriteThreadRegistry()
            )
          )
        }
      }
      const previousPrefix = `${normalizePath(result.previousPath)}/`
      const movedPath = (value: string): string => value === result.previousPath ? result.path :
        value.startsWith(previousPrefix) ? `${result.path}/${value.slice(previousPrefix.length)}` : value
      set((state) => {
        const nextActiveFilePath = state.activeFilePath === result.previousPath
          ? result.path
          : state.activeFilePath?.startsWith(previousPrefix)
            ? `${result.path}/${state.activeFilePath.slice(previousPrefix.length)}`
            : state.activeFilePath
        const keepActiveFile = nextActiveFilePath ? isWriteWorkspaceFilePath(nextActiveFilePath) : false
        const nextActiveFileKind = keepActiveFile && nextActiveFilePath
          ? isWriteImageFilePath(nextActiveFilePath) ? 'image' : 'text'
          : null
        const nextTabs = state.tabs.map((tab) => {
          const normalizedTab = normalizePath(tab.path)
          if (normalizedTab === normalizePath(result.previousPath)) {
            return { ...tab, id: result.path, path: result.path }
          }
          if (normalizedTab.startsWith(previousPrefix)) {
            const nextPath = `${result.path}/${normalizedTab.slice(previousPrefix.length)}`
            return { ...tab, id: nextPath, path: nextPath }
          }
          return tab
        })
        const expandedDirs = new Set<string>()
        for (const dirPath of state.expandedDirs) {
          if (dirPath === result.previousPath) {
            expandedDirs.add(result.path)
          } else if (dirPath.startsWith(previousPrefix)) {
            expandedDirs.add(`${result.path}/${dirPath.slice(previousPrefix.length)}`)
          } else {
            expandedDirs.add(dirPath)
          }
        }
        return {
          activeFilePath: keepActiveFile ? nextActiveFilePath ?? null : null,
          activeFileKind: nextActiveFileKind,
          tabs: nextTabs,
          activeTabId: keepActiveFile && nextActiveFilePath ? tabIdForPath(nextActiveFilePath) : null,
          recentlyClosedTabs: state.recentlyClosedTabs.map((tab) => ({ ...tab, path: movedPath(tab.path) })),
          recentlyOpenedTabs: state.recentlyOpenedTabs.map((tab) => ({ ...tab, path: movedPath(tab.path) })),
          fileContent: nextActiveFileKind === 'text' ? state.fileContent : '',
          imageDataUrl: nextActiveFileKind === 'image' ? state.imageDataUrl : '',
          imageMimeType: nextActiveFileKind === 'image' ? state.imageMimeType : '',
          fileSize: keepActiveFile ? state.fileSize : 0,
          fileTruncated: keepActiveFile ? state.fileTruncated : false,
          saveStatus: keepActiveFile ? state.saveStatus : 'saved',
          saveRevision: keepActiveFile ? state.saveRevision : 0,
          selection: nextActiveFileKind === 'text' ? state.selection : emptySelection(),
          quotedSelections: nextActiveFileKind === 'text' ? state.quotedSelections : [],
          expandedDirs,
          entriesByDir: {},
          fileError: null
        }
      })
      persist(workspaceRoot)
      await get().refreshWorkspace(workspaceRoot)
      return result.path
    },

    deleteEntry: async (workspaceRoot, path) => {
      const initial = get()
      const affectsActive = initial.activeFilePath === path || initial.activeFilePath?.startsWith(`${normalizePath(path)}/`)
      if (affectsActive && !await get().flushSave(workspaceRoot)) return false
      openRequest += 1
      cancelExternalSyncAnimation()
      const contentBeforeDelete = get().fileContent
      let result: Awaited<ReturnType<typeof window.workwise.deleteWorkspaceEntry>>
      try {
        result = await window.workwise.deleteWorkspaceEntry({ workspaceRoot, path })
      } catch (error) {
        set({ fileError: formatActionError(error) })
        return false
      }
      if (!result.ok) {
        set({ fileError: result.message })
        return false
      }
      saveWriteThreadRegistry(archiveWriteFileContext(workspaceRoot, result.path, readWriteThreadRegistry()))
      const deletedPath = normalizePath(result.path)
      const deleted = (candidate: string): boolean => normalizePath(candidate) === deletedPath || normalizePath(candidate).startsWith(`${deletedPath}/`)
      const latest = get()
      const activeDeleted = latest.activeFilePath && deleted(latest.activeFilePath)
      // Keep new edits if the user typed while deletion was in flight; checked save will detect the missing file.
      const preserveBuffer = activeDeleted && latest.fileContent !== contentBeforeDelete
      set((state) => ({
        tabs: state.tabs.filter((tab) => !deleted(tab.path) || (preserveBuffer && tab.id === state.activeTabId)),
        recentlyClosedTabs: state.recentlyClosedTabs.filter((tab) => !deleted(tab.path)),
        recentlyOpenedTabs: state.recentlyOpenedTabs.filter((tab) => !deleted(tab.path)),
        expandedDirs: new Set([...state.expandedDirs].filter((dir) => !deleted(dir)))
      }))
      if (preserveBuffer) {
        set({ fileError: '文件已删除，当前未保存内容已保留，请重新定位或另存为。', saveStatus: 'error', fileLoading: false })
      } else if (activeDeleted) {
        clearActive()
        const next = get().tabs.at(-1)
        if (next) await open(workspaceRoot, next.path, true)
      }
      persist(workspaceRoot)
      await get().refreshWorkspace(workspaceRoot)
      return true
    }
  }
}
