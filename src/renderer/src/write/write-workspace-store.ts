import { create } from 'zustand'
import {
  DEFAULT_WRITE_INLINE_COMPLETION_DEBOUNCE_MS,
  DEFAULT_WRITE_INLINE_COMPLETION_MAX_TOKENS,
  DEFAULT_WRITE_INLINE_COMPLETION_MIN_ACCEPT_SCORE,
  DEFAULT_WRITE_INLINE_COMPLETION_MODEL,
  DEFAULT_WRITE_INLINE_LONG_COMPLETION_DEBOUNCE_MS,
  DEFAULT_WRITE_INLINE_LONG_COMPLETION_MAX_TOKENS,
  DEFAULT_WRITE_INLINE_LONG_COMPLETION_MIN_ACCEPT_SCORE
} from '@shared/app-settings'
import { quotedSelectionFromEditor } from './quoted-selection'
import { writeSelectionStatesEqual } from './write-selection'
import { trimWriteRecentEdits } from './recent-edits'
import type { WriteWorkspaceState } from './write-workspace-store-types'
import { createWriteSettingsActions } from './write-workspace-settings-actions'
import { createWriteFileActions } from './write-workspace-file-actions'
import { readWriteDocument } from './write-document-reader'
import type { DocumentRevision, DocumentSnapshot } from '@shared/write-document'
import { writeBrowserStorageItem } from '../lib/browser-storage'
import {
  WRITE_ASSISTANT_MODEL_KEY,
  WRITE_ASSISTANT_SELECTION_KEY,
  WRITE_ASSISTANT_OPEN_KEY,
  WRITE_PREVIEW_MODE_KEY,
  emptySelection,
  formatWriteImageLoadError,
  initialState,
  isMissingImageIpc,
  pathsEqual,
  readStoredAssistantModel,
  readStoredAssistantSelection,
  readStoredAssistantOpen,
  readStoredPreviewMode,
  writeBasenameFromPath,
  writeJoinPath,
  writeRelativeToWorkspace
} from './write-workspace-store-helpers'
import { normalizeComposerModelForProvider } from '@shared/default-composer-models'
export type { WriteActiveFileKind, WritePreviewMode, WriteSaveStatus, WriteWorkspaceState } from './write-workspace-store-types'
export { writeBasenameFromPath, writeDirnameFromPath, writeJoinPath, writeRelativeToWorkspace } from './write-workspace-store-helpers'

let lastSavedContent = ''
let baselineEpoch = 0
let externalReadRequest = 0
let pendingSave: Promise<boolean> | null = null
let pendingRestore: { workspaceRoot: string; path: string } | null = null

function sameRevision(left: DocumentRevision | null, right: DocumentRevision | null): boolean {
  return left?.fingerprint === right?.fingerprint && left?.size === right?.size && left?.modifiedAt === right?.modifiedAt
}

function cancelExternalSyncAnimation(): void {
  // External snapshots always commit atomically. Never animate the authoritative buffer.
}

export function isWriteWorkspaceReadyForUpdate(): boolean {
  const state = useWriteWorkspaceStore.getState()
  return !pendingSave && !pendingRestore && state.saveStatus === 'saved' && !state.documentConflict && !state.fileLoading
}


export const useWriteWorkspaceStore = create<WriteWorkspaceState>((set, get) => ({
  defaultWorkspaceRoot: '',
  workspaceRoots: [],
  inlineCompletion: {
    enabled: true,
    retrievalEnabled: true,
    longCompletionEnabled: true,
    inheritProvider: true,
    providerId: '',
    apiKey: '',
    baseUrl: '',
    inheritModel: true,
    model: DEFAULT_WRITE_INLINE_COMPLETION_MODEL,
    debounceMs: DEFAULT_WRITE_INLINE_COMPLETION_DEBOUNCE_MS,
    longDebounceMs: DEFAULT_WRITE_INLINE_LONG_COMPLETION_DEBOUNCE_MS,
    minAcceptScore: DEFAULT_WRITE_INLINE_COMPLETION_MIN_ACCEPT_SCORE,
    longMinAcceptScore: DEFAULT_WRITE_INLINE_LONG_COMPLETION_MIN_ACCEPT_SCORE,
    maxTokens: DEFAULT_WRITE_INLINE_COMPLETION_MAX_TOKENS,
    longMaxTokens: DEFAULT_WRITE_INLINE_LONG_COMPLETION_MAX_TOKENS
  },
  knowledgeBase: {
    enabled: true,
    mode: 'hybrid',
    apiBaseUrl: 'https://api.railwise.cn',
    publicBaseUrl: 'https://kb.railwise.cn'
  },
  inlineCompletionApiReady: false,
  imageGenReady: false,
  settingsLoading: false,
  settingsError: null,
  ...initialState(),
  previewMode: readStoredPreviewMode(),
  assistantOpen: readStoredAssistantOpen(),
  assistantModel: readStoredAssistantModel(),
  assistantProviderId: readStoredAssistantSelection()?.providerId,

  ...createWriteSettingsActions({ set, get }),
  ...createWriteFileActions({
    set,
    get,
    cancelExternalSyncAnimation,
    getLastSavedContent: () => lastSavedContent,
    setLastSavedContent: (content) => {
      lastSavedContent = content
      baselineEpoch += 1
    }
  }),

  setFileContent: (content) => {
    if (get().guiUpdateInstallPending) return
    cancelExternalSyncAnimation()
    set((state) => ({
      fileContent: content,
      saveStatus: state.activeFileKind === 'text' && state.activeFilePath && content !== lastSavedContent ? 'dirty' : 'saved'
    }))
  },

  syncActiveFileFromDisk: async (workspaceRoot, options = {}) => {
    const snapshot = get()
    if (snapshot.guiUpdateInstallPending || (pendingRestore?.workspaceRoot === snapshot.workspaceRoot && pendingRestore.path === snapshot.activeFilePath)) return false
    const force = options.force === true
    if (!snapshot.activeFilePath) return false
    if (snapshot.activeFileKind !== 'text') return false
    if (options.path && !pathsEqual(options.path, snapshot.activeFilePath)) return false

    if (options.message) {
      set({ fileError: options.message, saveStatus: 'error' })
      return false
    }
    if (!force && (snapshot.saveStatus === 'dirty' || snapshot.saveStatus === 'saving')) return false

    const request = ++externalReadRequest
    const epoch = baselineEpoch
    let content = options.content
    let resolvedPath = options.path ?? snapshot.activeFilePath
    let size = options.size
    let truncated = options.truncated
    let documentRevision = null as WriteWorkspaceState['documentRevision']
    let documentBaselineKnown = false
    // A watch event may be older than the current disk state. Prefer one checked snapshot.
    if (typeof content !== 'string' || typeof window.workwise.readDocumentSnapshot === 'function') {
      try {
        const document = await readWriteDocument(workspaceRoot, snapshot.activeFilePath)
        content = document.content
        resolvedPath = document.path
        size = document.size
        truncated = document.truncated
        documentRevision = document.documentRevision
        documentBaselineKnown = document.documentBaselineKnown
      } catch (error) {
        if (request === externalReadRequest && epoch === baselineEpoch && pathsEqual(get().activeFilePath ?? '', snapshot.activeFilePath)) {
          set({ fileError: error instanceof Error ? error.message : String(error), saveStatus: 'error' })
        }
        return false
      }
    }

    const nextSize = typeof size === 'number' && Number.isFinite(size)
      ? Math.max(0, Math.floor(size))
      : content.length
    const nextTruncated = truncated === true

    const latest = get()
    if (request !== externalReadRequest || epoch !== baselineEpoch || latest.fileContent !== snapshot.fileContent) return false
    if (!latest.activeFilePath || !pathsEqual(latest.activeFilePath, resolvedPath)) return false
    if (!force && (latest.saveStatus === 'dirty' || latest.saveStatus === 'saving')) return false
    baselineEpoch += 1
    if (
      latest.fileContent === content &&
      lastSavedContent === content &&
      latest.fileSize === nextSize &&
      latest.fileTruncated === nextTruncated
    ) {
      set({
        saveStatus: 'saved',
        fileError: null,
        fileLoading: false,
        fileSize: nextSize,
        fileTruncated: nextTruncated,
        documentConflict: null,
        documentRevision, documentBaselineKnown
      })
      return true
    }

    cancelExternalSyncAnimation()
    lastSavedContent = content


    set({
      fileContent: content,
      fileSize: nextSize,
      fileTruncated: nextTruncated,
      saveStatus: 'saved',
      fileError: null,
      fileLoading: false,
      documentConflict: null,
      documentRevision, documentBaselineKnown
    })
    return true
  },

  syncActiveImageFromDisk: async (workspaceRoot, path) => {
    const snapshot = get()
    if (!snapshot.activeFilePath || snapshot.activeFileKind !== 'image') return false
    if (path && !pathsEqual(path, snapshot.activeFilePath)) return false

    try {
      const result = await window.workwise.readWorkspaceImage({
        path: snapshot.activeFilePath,
        workspaceRoot
      })
      if (!result.ok) {
        if (pathsEqual(get().activeFilePath ?? '', snapshot.activeFilePath)) {
          set({ fileError: result.message })
        }
        return false
      }

      const latest = get()
      if (!latest.activeFilePath || latest.activeFileKind !== 'image' || !pathsEqual(latest.activeFilePath, result.path)) {
        return false
      }

      set({
        imageDataUrl: result.dataUrl,
        imageMimeType: result.mimeType,
        fileSize: result.size,
        fileError: null,
        fileLoading: false,
        saveStatus: 'saved'
      })
      return true
    } catch (error) {
      if (isMissingImageIpc(error)) return false
      if (pathsEqual(get().activeFilePath ?? '', snapshot.activeFilePath)) {
        set({ fileError: formatWriteImageLoadError(error) })
      }
      return false
    }
  },

  flushSave: async (workspaceRoot) => {
    const current = get()
    if (current.guiUpdateInstallPending || (pendingRestore?.workspaceRoot === current.workspaceRoot && pendingRestore.path === current.activeFilePath)) return false
    // Queue writes so every checked save uses the preceding write's revision.
    if (pendingSave) {
      const saved = await pendingSave
      return saved ? get().flushSave(workspaceRoot) : false
    }
    const state = get()
    if (!state.activeFilePath || state.activeFileKind !== 'text') return true
    if (state.fileTruncated) return state.fileContent === lastSavedContent
    if (state.documentConflict) return false
    cancelExternalSyncAnimation()
    if (state.fileContent === lastSavedContent && !(state.documentBaselineKnown && state.documentRevision === null)) {
      set({ saveStatus: 'saved' })
      return true
    }
    const epoch = baselineEpoch
    const isCurrent = (): boolean => epoch === baselineEpoch && get().activeFilePath === state.activeFilePath && get().workspaceRoot === state.workspaceRoot
    set({ saveStatus: 'saving' })
    const operation = (async (): Promise<boolean> => {
      try {
        let revision: WriteWorkspaceState['documentRevision'] = null
        if (typeof window.workwise.writeDocumentChecked === 'function') {
          const checked = await window.workwise.writeDocumentChecked({
            path: state.activeFilePath!, workspaceRoot, content: state.fileContent,
            expectedRevision: state.documentBaselineKnown ? state.documentRevision : undefined
          })
          if (!isCurrent()) return false
          if (!checked.ok) {
            if ('conflict' in checked) {
              set({ saveStatus: 'error', documentConflict: checked.conflict, fileError: '文档已被外部修改，已保留当前内容，请查看冲突后再保存。' })
            } else set({ saveStatus: 'error', fileError: checked.message })
            return false
          }
          if (checked.snapshot.content !== state.fileContent) {
            set({
              saveStatus: 'error',
              documentConflict: {
                path: state.activeFilePath!, expectedRevision: state.documentRevision,
                currentRevision: checked.snapshot.revision, currentContent: checked.snapshot.content,
                attemptedContent: state.fileContent
              },
              fileError: '保存后文件又被外部修改，已保留双方内容，请查看冲突。'
            })
            return false
          }
          revision = checked.snapshot.revision
        } else {
          const result = await window.workwise.writeWorkspaceFile({ path: state.activeFilePath!, workspaceRoot, content: state.fileContent })
          if (!isCurrent()) return false
          if (!result.ok) {
            set({ saveStatus: 'error', fileError: result.message })
            return false
          }
        }
        lastSavedContent = state.fileContent
        const saved = get().fileContent === state.fileContent
        set((latest) => ({
          saveStatus: saved ? 'saved' : 'dirty', saveRevision: latest.saveRevision + 1,
          documentRevision: revision, documentBaselineKnown: typeof window.workwise.writeDocumentChecked === 'function', documentConflict: null, fileError: null,
          fileSize: revision?.size ?? new TextEncoder().encode(state.fileContent).byteLength
        }))
        // Navigation must not discard edits entered while the disk write was pending.
        return saved
      } catch (error) {
        if (isCurrent()) set({ saveStatus: 'error', fileError: error instanceof Error ? error.message : String(error) })
        return false
      }
    })()
    pendingSave = operation
    try { return await operation } finally { if (pendingSave === operation) pendingSave = null }
  },

  restoreHistoryEntry: async (input) => {
    const identityMatches = (): boolean => {
      const state = get()
      return state.workspaceRoot === input.workspaceRoot && state.activeFilePath === input.path && state.activeFileKind === 'text'
    }
    const canStart = (): boolean => identityMatches() && get().fileContent === input.content && !get().fileTruncated &&
      !get().documentConflict && !get().guiUpdateInstallPending
    if (pendingRestore || !canStart()) return false
    if (!await get().flushSave(input.workspaceRoot) || !canStart()) return false
    const baseline = get()
    if (!baseline.documentBaselineKnown || !baseline.documentRevision || baseline.saveStatus !== 'saved') return false
    const revision = baseline.documentRevision
    // Reads begun before this restore must not rebaseline or replace its source.
    externalReadRequest += 1
    const epoch = ++baselineEpoch
    const transaction = { workspaceRoot: input.workspaceRoot, path: input.path }
    pendingRestore = transaction
    const unchanged = (): boolean => canStart() && epoch === baselineEpoch && sameRevision(get().documentRevision, revision)
    const preserveDraft = (snapshot: DocumentSnapshot | null, message: string): void => {
      if (!identityMatches()) return
      const latest = get()
      set({
        saveStatus: 'error', fileError: message,
        documentConflict: {
          path: input.path, expectedRevision: revision, currentRevision: snapshot?.revision ?? null,
          currentContent: snapshot?.content ?? null, attemptedContent: latest.fileContent
        }
      })
    }
    let restoreSucceeded = false
    let committedSnapshot: DocumentSnapshot | null = null
    try {
      // The selected history entry and its reviewed document baseline stay bound
      // through saving, restoring and the authoritative completion read.
      if (!unchanged()) return false
      const result = await window.workwise.restoreDocumentHistory({
        workspaceRoot: input.workspaceRoot, path: input.path, id: input.id, expectedRevision: revision
      })
      if (!identityMatches()) return false
      if (!result.ok) {
        if ('conflict' in result) {
          set({ saveStatus: 'error', fileError: '恢复时检测到外部修改，已保留当前内容，请查看冲突。',
            documentConflict: { ...result.conflict, attemptedContent: get().fileContent } })
        } else set({ fileError: result.message })
        return false
      }
      restoreSucceeded = true
      if (result.snapshot.path === input.path) committedSnapshot = result.snapshot
      if (result.snapshot.path !== input.path) throw new Error('历史恢复返回了不同的文档路径。')
      let snapshot: DocumentSnapshot
      try {
        snapshot = await window.workwise.readDocumentSnapshot({ workspaceRoot: input.workspaceRoot, path: input.path })
      } catch (error) {
        preserveDraft(result.snapshot, '历史已恢复，但无法核对磁盘内容；已保留当前编辑，请重新读取并处理冲突。')
        throw error
      }
      if (!identityMatches()) return false
      if (snapshot.path !== input.path) throw new Error('历史恢复核对返回了不同的文档路径。')
      if (!unchanged() || result.snapshot.content !== input.historyContent || snapshot.content !== result.snapshot.content || !sameRevision(snapshot.revision, result.snapshot.revision)) {
        preserveDraft(snapshot, '恢复期间文档已有新编辑，已保留当前编辑和恢复后的磁盘内容，请查看冲突。')
        return false
      }
      // Never reread whichever document happens to be active at completion.
      // No await follows the final transaction check and this atomic state update.
      lastSavedContent = snapshot.content
      baselineEpoch += 1
      externalReadRequest += 1
      set((state) => ({
        fileContent: snapshot.content, fileSize: snapshot.revision.size, fileTruncated: false,
        documentRevision: snapshot.revision, documentBaselineKnown: true, documentConflict: null,
        saveStatus: 'saved', fileError: null, selection: emptySelection(), saveRevision: state.saveRevision + 1
      }))
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (restoreSucceeded) preserveDraft(committedSnapshot, `历史已恢复，但核对失败；已保留当前编辑并停止自动保存：${message}`)
      else if (identityMatches()) set({ fileError: message })
      return false
    } finally {
      if (pendingRestore === transaction) pendingRestore = null
    }
  },

  setFileError: (message) => {
    set({ fileError: message })
  },

  setPreviewMode: (mode) => {
    writeBrowserStorageItem(WRITE_PREVIEW_MODE_KEY, mode)
    set({ previewMode: mode })
  },

  setAssistantOpen: (open) => {
    writeBrowserStorageItem(WRITE_ASSISTANT_OPEN_KEY, open ? '1' : '0')
    set({ assistantOpen: open })
  },

  setAssistantModel: (model, providerId) => {
    const normalized = normalizeComposerModelForProvider(model, providerId)
    writeBrowserStorageItem(WRITE_ASSISTANT_MODEL_KEY, normalized)
    writeBrowserStorageItem(WRITE_ASSISTANT_SELECTION_KEY, JSON.stringify({ version: 1, model: normalized, providerId }))
    set({ assistantModel: normalized, assistantProviderId: providerId })
  },

  setSelection: (selection) => {
    if (writeSelectionStatesEqual(get().selection, selection)) return
    set({ selection })
  },

  recordRecentEdits: (edits) => {
    if (edits.length === 0) return
    set((state) => ({
      recentEdits: trimWriteRecentEdits([...state.recentEdits, ...edits])
    }))
  },

  quoteCurrentSelection: (workspaceRoot) => {
    const state = get()
    if (!state.activeFilePath) return
    const quote = quotedSelectionFromEditor(state.selection, state.activeFilePath, workspaceRoot)
    if (!quote) return
    set((current) => ({
      assistantOpen: true,
      quotedSelections: [...current.quotedSelections, quote],
      selection: emptySelection()
    }))
  },

  removeQuotedSelection: (id) =>
    set((state) => ({
      quotedSelections: state.quotedSelections.filter((selection) => selection.id !== id)
    })),

  clearQuotedSelections: () => set({ quotedSelections: [] }),

  resetWorkspace: () => {
    if (get().guiUpdateInstallPending) return
    cancelExternalSyncAnimation()
    lastSavedContent = ''
    baselineEpoch += 1
    externalReadRequest += 1
    set(initialState())
  }
}))
