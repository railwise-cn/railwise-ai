import type { WriteInlineCompletionSettingsV1, WriteKnowledgeBaseSettingsV1 } from '@shared/app-settings'
import type { WorkspaceEntry } from '@shared/workspace-file'
import type { WriteEditorSelectionState } from '../components/write/WriteMarkdownEditor'
import type { WriteQuotedSelection } from './quoted-selection'
import type { WriteRecentEdit } from './recent-edits'
import type { DocumentConflict, DocumentRevision } from '@shared/write-document'

export type WritePreviewMode = 'rich' | 'source' | 'live' | 'split' | 'preview'
export type WriteSaveStatus = 'saved' | 'dirty' | 'saving' | 'error'
export type WriteActiveFileKind = 'text' | 'image'

export type WriteDocumentTab = {
  id: string
  path: string
  kind: WriteActiveFileKind
  pinned: boolean
  openedAt: number
}

export type WriteRecentlyClosedTab = Pick<WriteDocumentTab, 'path' | 'kind'> & {
  closedAt: number
}

export type WriteRecentlyOpenedTab = Pick<WriteDocumentTab, 'path' | 'kind'> & { openedAt: number }
export type WriteCloseIntent = 'save' | 'discard' | 'cancel'

export type WriteWorkspaceState = {
  defaultWorkspaceRoot: string
  workspaceRoots: string[]
  inlineCompletion: WriteInlineCompletionSettingsV1
  knowledgeBase: WriteKnowledgeBaseSettingsV1
  inlineCompletionApiReady: boolean
  /** True when the image generation provider is fully configured (enables 生成信息图). */
  imageGenReady: boolean
  settingsLoading: boolean
  settingsError: string | null
  workspaceRoot: string
  rootDirectory: string
  entriesByDir: Record<string, WorkspaceEntry[]>
  expandedDirs: Set<string>
  loadingDirs: Record<string, boolean>
  treeError: string | null
  activeFilePath: string | null
  activeFileKind: WriteActiveFileKind | null
  tabs: WriteDocumentTab[]
  activeTabId: string | null
  recentlyClosedTabs: WriteRecentlyClosedTab[]
  recentlyOpenedTabs: WriteRecentlyOpenedTab[]
  fileContent: string
  imageDataUrl: string
  imageMimeType: string
  fileSize: number
  fileTruncated: boolean
  /** Fingerprint of the last disk snapshot used as the write baseline. */
  documentRevision: DocumentRevision | null
  /** Distinguishes an observed missing file (null) from an old IPC without a baseline. */
  documentBaselineKnown: boolean
  /** Populated when a checked write detects an external edit. */
  documentConflict: DocumentConflict | null
  fileError: string | null
  fileLoading: boolean
  saveStatus: WriteSaveStatus
  /** Monotonic revision of the last successfully persisted active file. */
  saveRevision: number
  /** Editing is paused between the final updater validation and installer handoff. */
  guiUpdateInstallPending: boolean
  previewMode: WritePreviewMode
  assistantOpen: boolean
  assistantModel: string
  assistantProviderId?: string
  selection: WriteEditorSelectionState
  quotedSelections: WriteQuotedSelection[]
  recentEdits: WriteRecentEdit[]
  loadWriteSettings: () => Promise<void>
  selectWriteWorkspace: (workspaceRoot: string) => Promise<void>
  addWriteWorkspace: (workspaceRoot: string) => Promise<void>
  removeWriteWorkspace: (workspaceRoot: string) => Promise<void>
  initializeWorkspace: (workspaceRoot: string) => Promise<void>
  loadDirectory: (workspaceRoot: string, path?: string) => Promise<string | null>
  toggleDirectory: (workspaceRoot: string, path: string) => Promise<void>
  refreshWorkspace: (workspaceRoot: string) => Promise<void>
  openFile: (workspaceRoot: string, path: string) => Promise<void>
  selectTab: (workspaceRoot: string, tabId: string) => Promise<void>
  relocateActiveDocument: (workspaceRoot: string, path: string) => Promise<boolean>
  closeFile: (workspaceRoot: string, path?: string, intent?: WriteCloseIntent) => Promise<boolean>
  restoreClosedFile: (workspaceRoot: string) => Promise<void>
  toggleTabPinned: (tabId: string) => void
  setFileContent: (content: string) => void
  syncActiveFileFromDisk: (
    workspaceRoot: string,
    options?: {
      path?: string
      content?: string
      size?: number
      truncated?: boolean
      message?: string
      animate?: boolean
      force?: boolean
    }
  ) => Promise<boolean>
  syncActiveImageFromDisk: (workspaceRoot: string, path?: string) => Promise<boolean>
  flushSave: (workspaceRoot: string) => Promise<boolean>
  restoreHistoryEntry: (input: { workspaceRoot: string; path: string; id: string; content: string; historyContent: string }) => Promise<boolean>
  createFile: (workspaceRoot: string, path: string, content?: string) => Promise<string | null>
  createDirectory: (workspaceRoot: string, path: string) => Promise<string | null>
  renameEntry: (workspaceRoot: string, path: string, newName: string, targetDirectory?: string) => Promise<string | null>
  deleteEntry: (workspaceRoot: string, path: string) => Promise<boolean>
  setFileError: (message: string | null) => void
  setPreviewMode: (mode: WritePreviewMode) => void
  setAssistantOpen: (open: boolean) => void
  setAssistantModel: (model: string, providerId?: string) => void
  setSelection: (selection: WriteEditorSelectionState) => void
  recordRecentEdits: (edits: WriteRecentEdit[]) => void
  quoteCurrentSelection: (workspaceRoot: string) => void
  removeQuotedSelection: (id: string) => void
  clearQuotedSelections: () => void
  resetWorkspace: () => void
}

export type WriteWorkspaceSet = (
  partial: Partial<WriteWorkspaceState> | ((state: WriteWorkspaceState) => Partial<WriteWorkspaceState>)
) => void

export type WriteWorkspaceGet = () => WriteWorkspaceState
