import { useEffect, useRef, useState, type ReactElement } from 'react'
import { SurveyDraftEditorNotice } from '../engineering/SurveyDraftEditorNotice'
import { useShallow } from 'zustand/react/shallow'
import {
  Columns2,
  Eye,
  FileCode2,
  Type
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WriteExportFormat } from '@shared/write-export'
import {
  BUILTIN_TEMPLATE_IDS,
  mergeBuiltinAndUserTemplates,
  normalizeExportTemplate,
  type ExportElementType,
  type ExportElementStyle,
  type ExportStyleTemplate
} from '@shared/write-export-templates'
import { WRITE_INFOGRAPHIC_MAX_TEXT_CHARS } from '@shared/write-infographic'
import { useChatStore } from '../../store/chat-store'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { formatWorkspacePickerError } from '../../lib/format-workspace-picker-error'
import {
  useWriteWorkspaceStore,
  type WritePreviewMode,
  type WriteSaveStatus,
  writeBasenameFromPath,
  writeJoinPath,
  writeRelativeToWorkspace
} from '../../write/write-workspace-store'
import { getWriteRenderSafety } from '../../write/write-render-safety'
import {
  applyWriteInlineEditReplacement,
  buildWriteInlineEditCompletionRequest,
  buildWriteInlineEditDraft
} from '../../write/inline-edit'
import type { AgnesImageSize } from '@shared/agnes-image'
import { createWriteRecentEdit } from '../../write/recent-edits'
import { startWriteWorkspaceFileWatch } from '../../write/write-file-watch'
import { registerGuiUpdateSaveHandler } from '../../lib/gui-update-install-preflight'
import type { WriteRichEditorHandle } from '../../write/tiptap/WriteRichEditor'
import { useWriteSplitScrollSync } from './use-write-split-scroll-sync'
import { WriteAgnesImageDialog } from './WriteAgnesImageDialog'
import { WriteExportDialog } from './WriteExportDialog'
import { WriteWorkspaceEmptyState } from './WriteWorkspaceEmptyState'
import { WriteWorkspaceToolbar } from './WriteWorkspaceToolbar'
import { WriteInlineAgent } from './WriteInlineAgent'
import { WriteWorkspaceDocumentPane } from './WriteWorkspaceDocumentPane'
import {
  INLINE_EDIT_RECENT_CONTEXT_CHARS,
  WRITE_AUTOSAVE_MS,
  WRITE_EXPORT_NOTICE_MS,
  writePreviewDebounceMs,
  WRITE_RICH_CLIPBOARD_ACTION,
  exportFormatLabel,
  formatSaveLabel,
  inlineAgentPosition,
  isMarkdownFile,
  useDebouncedValue,
  type WriteNotice
} from './write-workspace-view-utils'

type Props = {
  leftSidebarCollapsed: boolean; onToggleLeftSidebar: () => void
  input: string; setInput: (value: string) => void
  onSubmitPrompt?: (value: string) => void
}

export function WriteWorkspaceView({
  leftSidebarCollapsed,
  onToggleLeftSidebar,
  input,
  setInput,
  onSubmitPrompt
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const ensureWriteThreadForWorkspace = useChatStore((s) => s.ensureWriteThreadForWorkspace)
  const runtimeConnection = useChatStore((s) => s.runtimeConnection)
  // Field-level subscription: this view must follow fileContent, but it should
  // not re-render for sidebar-only state such as the directory tree or quoted
  // selections.
  const {
    workspaceRoot,
    activeFilePath,
    activeFileKind,
    rootDirectory,
    inlineCompletion,
    knowledgeBase,
    inlineCompletionApiReady,
    imageGenReady,
    fileContent,
    imageDataUrl,
    imageMimeType,
    fileSize,
    fileTruncated,
    fileError,
    fileLoading,
    saveStatus,
    previewMode,
    assistantOpen,
    selection,
    recentEdits,
    loadWriteSettings,
    addWriteWorkspace,
    setFileContent,
    syncActiveFileFromDisk,
    syncActiveImageFromDisk,
    flushSave,
    createFile,
    refreshWorkspace,
    setFileError,
    setPreviewMode,
    setAssistantOpen,
    setSelection,
    recordRecentEdits,
    quoteCurrentSelection
  } = useWriteWorkspaceStore(
    useShallow((s) => ({
      workspaceRoot: s.workspaceRoot,
      activeFilePath: s.activeFilePath,
      activeFileKind: s.activeFileKind,
      rootDirectory: s.rootDirectory,
      inlineCompletion: s.inlineCompletion,
      knowledgeBase: s.knowledgeBase,
      inlineCompletionApiReady: s.inlineCompletionApiReady,
      imageGenReady: s.imageGenReady,
      fileContent: s.fileContent,
      imageDataUrl: s.imageDataUrl,
      imageMimeType: s.imageMimeType,
      fileSize: s.fileSize,
      fileTruncated: s.fileTruncated,
      fileError: s.fileError,
      fileLoading: s.fileLoading,
      saveStatus: s.saveStatus,
      previewMode: s.previewMode,
      assistantOpen: s.assistantOpen,
      selection: s.selection,
      recentEdits: s.recentEdits,
      loadWriteSettings: s.loadWriteSettings,
      addWriteWorkspace: s.addWriteWorkspace,
      setFileContent: s.setFileContent,
      syncActiveFileFromDisk: s.syncActiveFileFromDisk,
      syncActiveImageFromDisk: s.syncActiveImageFromDisk,
      flushSave: s.flushSave,
      createFile: s.createFile,
      refreshWorkspace: s.refreshWorkspace,
      setFileError: s.setFileError,
      setPreviewMode: s.setPreviewMode,
      setAssistantOpen: s.setAssistantOpen,
      setSelection: s.setSelection,
      recordRecentEdits: s.recordRecentEdits,
      quoteCurrentSelection: s.quoteCurrentSelection
    }))
  )
  const saveTimerRef = useRef<number | null>(null)
  const exportMenuRef = useRef<HTMLDivElement | null>(null)
  const modeMenuRef = useRef<HTMLDivElement | null>(null)
  const editorPaneRef = useRef<HTMLDivElement | null>(null)
  const previewPaneRef = useRef<HTMLDivElement | null>(null)
  const exportNoticeTimerRef = useRef<number | null>(null)
  const inlineAgentTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const richHandleRef = useRef<WriteRichEditorHandle | null>(null)
  const [inlineAgentValue, setInlineAgentValue] = useState('')
  const [inlineAgentOpen, setInlineAgentOpen] = useState(false)
  const [inlineEditInFlight, setInlineEditInFlight] = useState(false)
  const [infographicInFlight, setInfographicInFlight] = useState(false)
  const [modeMenuOpen, setModeMenuOpen] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exportingFormat, setExportingFormat] = useState<WriteExportFormat | typeof WRITE_RICH_CLIPBOARD_ACTION | null>(null)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  /** 合并后的全部模板（内置 + 用户自定义） */
  const [exportTemplates, setExportTemplates] = useState<ExportStyleTemplate[]>([])
  const [defaultExportTemplateId, setDefaultExportTemplateId] = useState('')
  const [exportNotice, setExportNotice] = useState<WriteNotice | null>(null)
  const [agnesImageDialogOpen, setAgnesImageDialogOpen] = useState(false)
  const [agnesImageGenerating, setAgnesImageGenerating] = useState(false)
  const workspaceReady = workspaceRoot.trim().length > 0
  const activeFileIsImage = activeFileKind === 'image'
  const activeFileIsText = activeFileKind === 'text'
  const isMarkdown = activeFilePath && activeFileIsText ? isMarkdownFile(activeFilePath) : true
  const renderSafety = getWriteRenderSafety({
    isMarkdown,
    contentLength: fileContent.length,
    fileSize,
    truncated: fileTruncated
  })
  const debouncedPreviewContent = useDebouncedValue(fileContent, writePreviewDebounceMs(fileContent.length))
  const saveLabel = activeFileIsImage
    ? t('writeImagePreview')
    : renderSafety.readOnly ? t('writeReadOnly') : formatSaveLabel(saveStatus, t)
  const selectionAction = selection.charCount > 0 ? inlineAgentPosition(selection) : null
  const selectionActionActive = Boolean(selectionAction)
  const selectionActionLeft = selectionAction?.left
  const selectionActionTop = selectionAction?.top
  const activeFileLabel = activeFilePath
    ? writeRelativeToWorkspace(workspaceRoot, activeFilePath)
    : t('writeNoFileOpen')
  const activeFileName = activeFilePath ? writeBasenameFromPath(activeFilePath) : t('writeStudio')
  const workspacePathLabel = rootDirectory || workspaceRoot
  const workspaceName = workspacePathLabel ? writeBasenameFromPath(workspacePathLabel) : t('writeWorkspace')
  const exportInFlight = exportingFormat !== null
  const fileGuardMessage = renderSafety.notice === 'truncated'
    ? t('writeLargeFileTruncated')
    : renderSafety.notice === 'large-file'
      ? t('writeLargeFileSafeMode')
      : ''
  const fileGuardDetail = renderSafety.notice === 'large-file' ? t('writeLargeFileSafeModeSub') : ''

  useWriteSplitScrollSync({
    enabled: workspaceReady && previewMode === 'split' && activeFileIsText,
    editorRootRef: editorPaneRef,
    previewRef: previewPaneRef,
    rebindKey: activeFilePath ?? 'write-preview'
  })

  const showExportNotice = (notice: WriteNotice): void => {
    setExportNotice(notice)
  }

  const createDraftFile = async (): Promise<string | null> => {
    if (!workspaceReady) {
      await pickWriteWorkspace()
      return null
    }
    const root = rootDirectory || workspaceRoot
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = writeJoinPath(root, `draft-${stamp}.md`)
    return createFile(workspaceRoot, path, `# ${t('writeUntitledDraft')}\n\n`)
  }

  const setAssistantPrompt = (prompt: string): void => {
    setAssistantOpen(true)
    setInput(input.trim() ? `${input.trim()}\n\n${prompt}` : prompt)
  }

  const preparePptMaster = async (): Promise<void> => {
    if (typeof window.workwise?.installBundledSkill !== 'function') {
      setFileError(t('writePptMasterUnavailable'))
      return
    }
    if (!workspaceReady) {
      await pickWriteWorkspace()
      return
    }
    const root = rootDirectory || workspaceRoot
    const result = await window.workwise.installBundledSkill(writeJoinPath(root, '.agents/skills'), {
      id: 'ppt-master',
      skillName: 'ppt-master'
    })
    if (!result.ok) {
      setFileError(result.message)
      return
    }
    const documentRef = activeFilePath
      ? `@${writeRelativeToWorkspace(workspaceRoot, activeFilePath)}`
      : t('writePptWorkspaceReference', { workspace: workspaceName })
    setAssistantPrompt(t('writePptMasterPrompt', { document: documentRef }))
    showExportNotice({ tone: 'success', message: t('writePptMasterReady') })
  }

  const openAgnesImageGenerator = async (): Promise<void> => {
    if (!activeFilePath) {
      const createdPath = await createDraftFile()
      if (!createdPath) return
      setFileError(null)
      setAgnesImageDialogOpen(true)
      return
    }
    if (!activeFileIsText) {
      setFileError(t('writeAgnesImageNeedsFile'))
      return
    }
    if (renderSafety.readOnly) {
      setFileError(t('writeReadOnlySaveDisabled'))
      return
    }
    setFileError(null)
    setAgnesImageDialogOpen(true)
  }

  const submitInlineAgent = (prompt: string): void => {
    const trimmed = prompt.trim()
    if (!trimmed || !workspaceReady || !activeFilePath) return
    quoteCurrentSelection(workspaceRoot)
    setAssistantOpen(true)
    setInlineAgentValue('')
    setInlineAgentOpen(false)
    if (onSubmitPrompt) {
      onSubmitPrompt(trimmed)
      return
    }
    setInput(input.trim() ? `${input.trim()}\n\n${trimmed}` : trimmed)
  }

  const submitInlineEdit = async (prompt: string): Promise<void> => {
    const trimmed = prompt.trim()
    if (!trimmed || !workspaceReady || !activeFilePath || inlineEditInFlight) return
    if (renderSafety.readOnly) {
      setFileError(t('writeReadOnlySaveDisabled'))
      return
    }
    if (selection.ranges.length !== 1) {
      setFileError(t(selection.ranges.length > 1 ? 'writeInlineEditMultiSelection' : 'writeInlineEditNoSelection'))
      return
    }
    if (typeof window.workwise?.requestWriteInlineCompletion !== 'function') {
      setFileError(t('writeInlineEditUnavailable'))
      return
    }

    // In rich mode the inline edit operates on the markdown projection: the
    // selection ranges are projection offsets and the replacement is applied
    // through the editor so undo history and node structure stay intact.
    const richHandle = richModeActive ? richHandleRef.current : null
    const richProjectionText = richHandle?.getProjectionText() ?? null
    const editContent = richProjectionText ?? fileContent

    const draft = buildWriteInlineEditDraft(editContent, selection.ranges[0], trimmed, {
      workspaceRoot,
      currentFilePath: activeFilePath,
      model: inlineCompletion.model,
      language: 'markdown',
      recentEdits
    })

    setInlineEditInFlight(true)
    try {
      const result = await window.workwise.requestWriteInlineCompletion(
        buildWriteInlineEditCompletionRequest(draft.request)
      )
      if (!result.ok) {
        setFileError(t('writeInlineEditFailed', { message: result.message }))
        return
      }
      const replacement = result.action?.kind === 'edit'
        ? result.action.replacement
        : result.completion

      if (richHandle) {
        const applied = richHandle.applyProjectedReplacement(
          { from: draft.scope.from, to: draft.scope.to },
          draft.scope.text,
          replacement,
          trimmed
        )
        if (!applied) {
          setFileError(t('writeInlineEditChanged'))
          return
        }
        setSelection({ text: '', ranges: [], charCount: 0 })
        setInlineAgentValue('')
        setInlineAgentOpen(false)
        setFileError(null)
        showExportNotice({ tone: 'success', message: t('writeInlineEditApplied') })
        return
      }

      const latest = useWriteWorkspaceStore.getState()
      if (
        latest.activeFilePath !== activeFilePath ||
        latest.activeFileKind !== 'text' ||
        latest.fileContent.slice(draft.scope.from, draft.scope.to) !== draft.scope.text
      ) {
        setFileError(t('writeInlineEditChanged'))
        return
      }

      const nextContent = applyWriteInlineEditReplacement(latest.fileContent, draft.scope, replacement)
      const inlineEditRecord = createWriteRecentEdit({
        source: 'inline-edit',
        filePath: activeFilePath,
        from: draft.scope.from,
        to: draft.scope.to,
        deletedText: draft.scope.text,
        insertedText: replacement,
        beforeContext: latest.fileContent.slice(
          Math.max(0, draft.scope.from - INLINE_EDIT_RECENT_CONTEXT_CHARS),
          draft.scope.from
        ),
        afterContext: nextContent.slice(
          draft.scope.from + replacement.length,
          Math.min(nextContent.length, draft.scope.from + replacement.length + INLINE_EDIT_RECENT_CONTEXT_CHARS)
        ),
        instruction: trimmed,
        scopeKind: draft.scope.kind
      })

      setFileContent(nextContent)
      if (inlineEditRecord) recordRecentEdits([inlineEditRecord])
      setSelection({ text: '', ranges: [], charCount: 0 })
      setInlineAgentValue('')
      setInlineAgentOpen(false)
      setFileError(null)
      showExportNotice({ tone: 'success', message: t('writeInlineEditApplied') })
    } catch (error) {
      setFileError(t('writeInlineEditFailed', {
        message: error instanceof Error ? error.message : String(error)
      }))
    } finally {
      setInlineEditInFlight(false)
    }
  }

  const generateInfographic = async (): Promise<void> => {
    if (!workspaceReady || !activeFilePath || infographicInFlight) return
    if (renderSafety.readOnly) {
      setFileError(t('writeReadOnlySaveDisabled'))
      return
    }
    if (selection.ranges.length !== 1 || !selection.text.trim()) {
      setFileError(t('writeInlineEditNoSelection'))
      return
    }
    if (typeof window.workwise?.generateWriteInfographic !== 'function') {
      setFileError(t('writeInfographicUnavailable'))
      return
    }
    const range = selection.ranges[0]
    const richHandle = richModeActive ? richHandleRef.current : null
    setInfographicInFlight(true)
    try {
      const result = await window.workwise.generateWriteInfographic({
        text: selection.text.trim().slice(0, WRITE_INFOGRAPHIC_MAX_TEXT_CHARS),
        filePath: activeFilePath,
        workspaceRoot
      })
      if (!result.ok) {
        setFileError(t('writeInfographicFailed', { message: result.message }))
        return
      }
      const insertion = `\n\n![${t('writeInfographicAlt')}](${result.relativePath})\n`
      // Insert after the line containing the selection end, not mid-sentence:
      // a partial selection should never split its own paragraph.
      const lineEndAfter = (content: string, offset: number): number => {
        const nextBreak = content.indexOf('\n', offset)
        return nextBreak < 0 ? content.length : nextBreak
      }
      if (richHandle) {
        // Rich mode: insert at a projection offset so undo history and node
        // structure stay intact.
        const projection = richHandle.getProjectionText() ?? ''
        const insertAt = lineEndAfter(projection, range.to)
        const applied = richHandle.applyProjectedReplacement(
          { from: insertAt, to: insertAt },
          '',
          insertion,
          t('writeInfographicGenerate')
        )
        if (!applied) {
          setFileError(t('writeInlineEditChanged'))
          return
        }
      } else {
        const latest = useWriteWorkspaceStore.getState()
        if (
          latest.activeFilePath !== activeFilePath ||
          latest.activeFileKind !== 'text' ||
          latest.fileContent.slice(range.from, range.to) !== range.text
        ) {
          setFileError(t('writeInlineEditChanged'))
          return
        }
        const insertAt = lineEndAfter(latest.fileContent, range.to)
        setFileContent(
          latest.fileContent.slice(0, insertAt) + insertion + latest.fileContent.slice(insertAt)
        )
      }
      setSelection({ text: '', ranges: [], charCount: 0 })
      setFileError(null)
      showExportNotice({ tone: 'success', message: t('writeInfographicInserted') })
    } catch (error) {
      setFileError(t('writeInfographicFailed', {
        message: error instanceof Error ? error.message : String(error)
      }))
    } finally {
      setInfographicInFlight(false)
    }
  }

  const pickWriteWorkspace = async (): Promise<void> => {
    try {
      setFileError(null)
      if (typeof window.workwise?.pickWorkspaceDirectory !== 'function') {
        throw new Error('workspace:pick-directory unavailable')
      }
      const picked = await window.workwise.pickWorkspaceDirectory(workspaceRoot || undefined)
      if (!picked.canceled && picked.path) {
        await addWriteWorkspace(picked.path)
        if (runtimeConnection === 'ready') void ensureWriteThreadForWorkspace(picked.path)
      }
    } catch (error) {
      setFileError(formatWorkspacePickerError(error))
    }
  }

  // 加载导出模板列表（合并内置 + 用户自定义）
  const loadExportTemplates = async (): Promise<void> => {
    try {
      const settings = await rendererRuntimeClient.getSettings({ forceRefresh: true })
      const merged = mergeBuiltinAndUserTemplates(
        settings.write.exportTemplates,
        settings.write.defaultExportTemplateId
      )
      setExportTemplates(merged)
      setDefaultExportTemplateId(
        settings.write.defaultExportTemplateId ||
          merged.find((tpl) => tpl.isDefault)?.id ||
          ''
      )
    } catch {
      // 加载失败时静默回退到内置模板
      setExportTemplates(mergeBuiltinAndUserTemplates([]))
    }
  }

  // 打开导出对话框（仅 docx）
  const openExportDialog = async (): Promise<void> => {
    await loadExportTemplates()
    setExportDialogOpen(true)
  }

  // 保存用户模板（新增或更新）
  const handleSaveExportTemplate = async (template: ExportStyleTemplate): Promise<void> => {
    const settings = await rendererRuntimeClient.getSettings({ forceRefresh: true })
    const normalizedTemplate = normalizeExportTemplate({
      ...template,
      builtin: false,
      isDefault: false,
      updatedAt: Date.now()
    })
    const existing = settings.write.exportTemplates
    const idx = existing.findIndex((tpl) => tpl.id === normalizedTemplate.id)
    const nextList = idx >= 0
      ? existing.map((tpl) => (tpl.id === normalizedTemplate.id ? normalizedTemplate : tpl))
      : [...existing, normalizedTemplate]
    await rendererRuntimeClient.setSettings({
      write: { exportTemplates: nextList }
    })
    await loadExportTemplates()
  }

  // 删除用户模板（内置不可删）
  const handleDeleteExportTemplate = async (templateId: string): Promise<void> => {
    if (BUILTIN_TEMPLATE_IDS.has(templateId)) return
    const settings = await rendererRuntimeClient.getSettings({ forceRefresh: true })
    const nextList = settings.write.exportTemplates.filter((tpl) => tpl.id !== templateId)
    const nextDefault = settings.write.defaultExportTemplateId === templateId
      ? ''
      : settings.write.defaultExportTemplateId
    await rendererRuntimeClient.setSettings({
      write: { exportTemplates: nextList, defaultExportTemplateId: nextDefault }
    })
    await loadExportTemplates()
  }

  // 设为默认模板
  const handleSetDefaultExportTemplate = async (templateId: string): Promise<void> => {
    await rendererRuntimeClient.setSettings({
      write: { defaultExportTemplateId: templateId }
    })
    await loadExportTemplates()
  }

  // 从对话框执行导出
  const exportFromDialog = async (payload: {
    templateId: string
    styleOverride?: Partial<Record<ExportElementType, Partial<ExportElementStyle>>>
  }): Promise<void> => {
    setExportDialogOpen(false)
    await exportCurrentFile('docx', payload)
  }

  const exportCurrentFile = async (
    format: WriteExportFormat,
    options?: {
      templateId?: string
      styleOverride?: Partial<Record<ExportElementType, Partial<ExportElementStyle>>>
    }
  ): Promise<void> => {
    if (!activeFilePath) return
    if (!activeFileIsText) return
    if (typeof window.workwise?.exportWriteDocument !== 'function') {
      showExportNotice({ tone: 'error', message: t('writeExportUnavailable') })
      return
    }

    setExportMenuOpen(false)
    setExportingFormat(format)
    try {
      const result = await window.workwise.exportWriteDocument({
        path: activeFilePath,
        workspaceRoot,
        format,
        content: fileContent,
        templateId: options?.templateId,
        styleOverride: options?.styleOverride
      })
      if (!result.ok) {
        if (!result.canceled) {
          showExportNotice({
            tone: 'error',
            message: t('writeExportFailed', {
              format: exportFormatLabel(format, t),
              message: result.message
            })
          })
        }
        return
      }
      showExportNotice({
        tone: 'success',
        message: t('writeExportSuccess', { format: exportFormatLabel(format, t) })
      })
    } catch (error) {
      showExportNotice({
        tone: 'error',
        message: t('writeExportFailed', {
          format: exportFormatLabel(format, t),
          message: error instanceof Error ? error.message : String(error)
        })
      })
    } finally {
      setExportingFormat(null)
    }
  }

  const copyCurrentFileAsRichText = async (): Promise<void> => {
    if (!activeFilePath) return
    if (!activeFileIsText) return
    if (typeof window.workwise?.copyWriteDocumentAsRichText !== 'function') {
      showExportNotice({ tone: 'error', message: t('writeCopyRichTextUnavailable') })
      return
    }

    setExportMenuOpen(false)
    setExportingFormat(WRITE_RICH_CLIPBOARD_ACTION)
    try {
      const result = await window.workwise.copyWriteDocumentAsRichText({
        path: activeFilePath,
        workspaceRoot,
        content: fileContent
      })
      if (!result.ok) {
        showExportNotice({
          tone: 'error',
          message: t('writeCopyRichTextFailed', {
            message: result.message
          })
        })
        return
      }
      showExportNotice({
        tone: 'success',
        message: t('writeCopyRichTextSuccess')
      })
    } catch (error) {
      showExportNotice({
        tone: 'error',
        message: t('writeCopyRichTextFailed', {
          message: error instanceof Error ? error.message : String(error)
        })
      })
    } finally {
      setExportingFormat(null)
    }
  }

  const appendGeneratedImageMarkdown = (markdownPath: string): void => {
    const latest = useWriteWorkspaceStore.getState()
    const imageMarkdown = `![${t('writeAgnesImageAlt')}](${markdownPath})`
    const content = latest.fileContent
    const separator = content.trim().length === 0
      ? ''
      : content.endsWith('\n') ? '\n' : '\n\n'
    latest.setFileContent(`${content}${separator}${imageMarkdown}\n`)
  }

  const generateAgnesImage = async (payload: {
    prompt: string
    model: string
    size: AgnesImageSize
  }): Promise<void> => {
    if (!workspaceReady || !activeFilePath || !activeFileIsText) {
      setFileError(t('writeAgnesImageNeedsFile'))
      return
    }
    if (renderSafety.readOnly) {
      setFileError(t('writeReadOnlySaveDisabled'))
      return
    }
    if (typeof window.workwise?.generateAgnesImage !== 'function') {
      showExportNotice({ tone: 'error', message: t('writeAgnesImageUnavailable') })
      return
    }

    setAgnesImageGenerating(true)
    try {
      const result = await window.workwise.generateAgnesImage({
        workspaceRoot,
        currentFilePath: activeFilePath,
        prompt: payload.prompt,
        model: payload.model,
        size: payload.size
      })
      if (!result.ok) {
        showExportNotice({
          tone: 'error',
          message: t('writeAgnesImageFailed', { message: result.message })
        })
        return
      }
      const latest = useWriteWorkspaceStore.getState()
      if (latest.activeFilePath !== activeFilePath || latest.activeFileKind !== 'text') {
        showExportNotice({ tone: 'success', message: t('writeAgnesImageSaved') })
        void refreshWorkspace(workspaceRoot)
        setAgnesImageDialogOpen(false)
        return
      }
      appendGeneratedImageMarkdown(result.markdownPath)
      setFileError(null)
      showExportNotice({ tone: 'success', message: t('writeAgnesImageInserted') })
      void refreshWorkspace(workspaceRoot)
      setAgnesImageDialogOpen(false)
    } catch (error) {
      showExportNotice({
        tone: 'error',
        message: t('writeAgnesImageFailed', {
          message: error instanceof Error ? error.message : String(error)
        })
      })
    } finally {
      setAgnesImageGenerating(false)
    }
  }

  useEffect(() => {
    void loadWriteSettings()
  }, [loadWriteSettings])

  useEffect(() => {
    setExportMenuOpen(false)
  }, [activeFilePath])

  useEffect(() => {
    setModeMenuOpen(false)
  }, [activeFilePath, previewMode])

  useEffect(() => {
    if (!selectionActionActive || !inlineAgentOpen) return
    window.requestAnimationFrame(() => inlineAgentTextareaRef.current?.focus())
  }, [inlineAgentOpen, selectionActionActive, selectionActionLeft, selectionActionTop])

  useEffect(() => {
    setInlineAgentOpen(false)
    setInlineAgentValue('')
  }, [selection.charCount, selection.text])

  useEffect(() => {
    if (!exportMenuOpen && !modeMenuOpen) return

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (
        exportMenuRef.current &&
        target instanceof Node &&
        !exportMenuRef.current.contains(target)
      ) {
        setExportMenuOpen(false)
      }
      if (
        modeMenuRef.current &&
        target instanceof Node &&
        !modeMenuRef.current.contains(target)
      ) {
        setModeMenuOpen(false)
      }
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setExportMenuOpen(false)
      setModeMenuOpen(false)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [exportMenuOpen, modeMenuOpen])

  useEffect(() => {
    if (exportNoticeTimerRef.current) {
      window.clearTimeout(exportNoticeTimerRef.current)
      exportNoticeTimerRef.current = null
    }
    if (!exportNotice) return
    exportNoticeTimerRef.current = window.setTimeout(() => {
      exportNoticeTimerRef.current = null
      setExportNotice(null)
    }, WRITE_EXPORT_NOTICE_MS)
    return () => {
      if (exportNoticeTimerRef.current) {
        window.clearTimeout(exportNoticeTimerRef.current)
        exportNoticeTimerRef.current = null
      }
    }
  }, [exportNotice])

  useEffect(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (saveStatus !== 'dirty' || !workspaceReady || !activeFileIsText || renderSafety.readOnly) return
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushSave(workspaceRoot)
    }, WRITE_AUTOSAVE_MS)
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [flushSave, saveStatus, workspaceReady, workspaceRoot, fileContent, activeFileIsText, renderSafety.readOnly])

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    if (exportNoticeTimerRef.current) {
      window.clearTimeout(exportNoticeTimerRef.current)
      exportNoticeTimerRef.current = null
    }
    void useWriteWorkspaceStore.getState().flushSave(workspaceRoot)
  }, [workspaceRoot])

  useEffect(() => registerGuiUpdateSaveHandler('Write', async () => {
    if (!workspaceRoot.trim()) return true
    await useWriteWorkspaceStore.getState().flushSave(workspaceRoot)
    return useWriteWorkspaceStore.getState().saveStatus !== 'error'
  }), [workspaceRoot])

  useEffect(() => {
    if (!activeFilePath || !workspaceRoot.trim() || (!activeFileIsText && !activeFileIsImage)) return
    if (
      typeof window.workwise?.watchWorkspaceFile !== 'function' ||
      typeof window.workwise?.unwatchWorkspaceFile !== 'function' ||
      typeof window.workwise?.onWorkspaceFileChanged !== 'function'
    ) {
      return
    }

    return startWriteWorkspaceFileWatch({
      api: window.workwise,
      workspaceRoot,
      path: activeFilePath,
      kind: activeFileIsImage ? 'image' : 'text',
      onTextSnapshot: (snapshot) => {
        void syncActiveFileFromDisk(workspaceRoot, snapshot)
      },
      onImageChanged: (path) => {
        void syncActiveImageFromDisk(workspaceRoot, path)
      },
      onError: setFileError
    })
  }, [
    activeFilePath,
    activeFileIsImage,
    activeFileIsText,
    setFileError,
    workspaceRoot,
    syncActiveFileFromDisk,
    syncActiveImageFromDisk
  ])

  if (!workspaceReady) {
    return <WriteWorkspaceEmptyState error={fileError} onPickWorkspace={() => void pickWriteWorkspace()} />
  }

  const editorVisible = activeFileIsText && previewMode !== 'preview'
  const previewVisible = activeFileIsText && (previewMode === 'split' || previewMode === 'preview')
  const editorWidth = previewMode === 'split'
    ? 'min-w-0 flex-1 basis-1/2 border-r border-ds-border-muted'
    : 'min-w-0 flex-1'
  const previewWidth = previewMode === 'split'
    ? 'min-w-0 flex-1 basis-1/2'
    : 'min-w-0 flex-1'
  const richModeActive =
    previewMode === 'rich' && isMarkdown && renderSafety.livePreviewEnabled && activeFileIsText
  const liveModeActive = previewMode === 'live' && renderSafety.livePreviewEnabled
  const sourceModeActive =
    previewMode === 'source' ||
    ((previewMode === 'live' || previewMode === 'rich') && !renderSafety.livePreviewEnabled) ||
    (previewMode === 'rich' && !richModeActive)
  const editorAppearance = sourceModeActive ? 'source' : 'live'

  const modeMenuItems: Array<{ mode: WritePreviewMode; label: string; shortLabel: string; icon: ReactElement; active: boolean }> = [
    {
      mode: 'rich',
      label: t('writeModeRich'),
      shortLabel: t('writeModeRich'),
      icon: <Type className="h-4 w-4" strokeWidth={1.85} />,
      active: richModeActive
    },
    {
      mode: 'source',
      label: t('writeModeSource'),
      shortLabel: t('writeModeSource'),
      icon: <FileCode2 className="h-4 w-4" strokeWidth={1.85} />,
      active: sourceModeActive
    },
    {
      mode: 'split',
      label: t('writeModeSplit'),
      shortLabel: t('writeModeSplit'),
      icon: <Columns2 className="h-4 w-4" strokeWidth={1.85} />,
      active: previewMode === 'split'
    },
    {
      mode: 'preview',
      label: t('writeModePreview'),
      shortLabel: t('writeModePreview'),
      icon: <Eye className="h-4 w-4" strokeWidth={1.85} />,
      active: previewMode === 'preview'
    }
  ]

  return (
    <div className="write-workspace-view ds-no-drag flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-3 sm:px-4 md:px-6 lg:px-8">
      <SurveyDraftEditorNotice workspace={workspaceRoot} path={activeFilePath??undefined} save={()=>flushSave(workspaceRoot)} />
      <WriteWorkspaceToolbar
        activeFileIsImage={activeFileIsImage}
        activeFileIsText={activeFileIsText}
        activeFileLabel={activeFileLabel}
        activeFileName={activeFileName}
        activeFilePath={activeFilePath ?? ''}
        assistantOpen={assistantOpen}
        exportInFlight={exportInFlight}
        exportMenuOpen={exportMenuOpen}
        exportMenuRef={exportMenuRef}
        leftSidebarCollapsed={leftSidebarCollapsed}
        liveModeActive={liveModeActive}
        modeMenuItems={modeMenuItems}
        modeMenuOpen={modeMenuOpen}
        modeMenuRef={modeMenuRef}
        previewMode={previewMode}
        readOnly={renderSafety.readOnly}
        saveLabel={saveLabel}
        saveStatus={saveStatus}
        setAssistantOpen={setAssistantOpen}
        setExportMenuOpen={setExportMenuOpen}
        setModeMenuOpen={setModeMenuOpen}
        setPreviewMode={setPreviewMode}
        onCopyRichText={() => void copyCurrentFileAsRichText()}
        onExportFile={(format) => {
          // docx 走导出对话框（模板选择）；pdf/html/doc 保持原直接导出
          if (format === 'docx') {
            void openExportDialog()
          } else {
            void exportCurrentFile(format)
          }
        }}
        onGenerateImage={() => void openAgnesImageGenerator()}
        onGeneratePresentation={() => void preparePptMaster()}
        onAskKnowledgeBase={() => setAssistantPrompt(t('writeKnowledgeBaseAskPrompt'))}
        knowledgeBaseEnabled={knowledgeBase.enabled}
        onPickWorkspace={() => void pickWriteWorkspace()}
        onSave={() => {
          if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
          void flushSave(workspaceRoot)
        }}
        onToggleLeftSidebar={onToggleLeftSidebar}
      />
      <div className="flex min-h-0 min-w-0 flex-1 gap-3 overflow-hidden pb-3 pt-3">
        <div className="ds-opaque-work-surface min-w-0 flex-1 overflow-hidden rounded-2xl border border-ds-border-muted bg-ds-card/92 shadow-[0_12px_32px_rgba(15,23,42,0.04)]">
          <WriteWorkspaceDocumentPane
            activeFilePath={activeFilePath}
            activeFileIsImage={activeFileIsImage}
            activeFileIsText={activeFileIsText}
            fileLoading={fileLoading}
            fileContent={fileContent}
            imageDataUrl={imageDataUrl}
            imageMimeType={imageMimeType}
            fileSize={fileSize}
            workspaceRoot={workspaceRoot}
            workspaceName={workspaceName}
            workspacePathLabel={workspacePathLabel}
            renderSafety={renderSafety}
            fileGuardMessage={fileGuardMessage}
            fileGuardDetail={fileGuardDetail}
            editorVisible={editorVisible}
            previewVisible={previewVisible}
            editorWidth={editorWidth}
            previewWidth={previewWidth}
            editorAppearance={editorAppearance}
            richModeActive={richModeActive}
            richHandleRef={richHandleRef}
            debouncedPreviewContent={debouncedPreviewContent}
            isMarkdown={isMarkdown}
            inlineCompletion={inlineCompletion}
            inlineCompletionApiReady={inlineCompletionApiReady}
            recentEdits={recentEdits}
            editorPaneRef={editorPaneRef}
            previewPaneRef={previewPaneRef}
            onAskAssistant={() => setAssistantPrompt(t('writeStartAskAiPrompt'))}
            onCreateDraft={() => void createDraftFile()}
            onCreatePresentation={() => void preparePptMaster()}
            onPickWorkspace={() => void pickWriteWorkspace()}
            onRefreshWorkspace={() => void refreshWorkspace(workspaceRoot)}
            onContentChange={setFileContent}
            onDocumentEdit={recordRecentEdits}
            onSelectionChange={setSelection}
            onSaveShortcut={() => {
              if (renderSafety.readOnly) return
              if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
              void flushSave(workspaceRoot)
            }}
            onImagePasteSaved={() => {
              setFileError(null)
              void refreshWorkspace(workspaceRoot)
            }}
            onImagePasteError={(message) => setFileError(message)}
          />
        </div>

      </div>
      {selectionAction && activeFilePath && activeFileIsText ? (
        <WriteInlineAgent
          action={selectionAction}
          open={inlineAgentOpen}
          value={inlineAgentValue}
          inFlight={inlineEditInFlight}
          textareaRef={inlineAgentTextareaRef}
          onOpen={() => setInlineAgentOpen(true)}
          onClose={() => setInlineAgentOpen(false)}
          onValueChange={setInlineAgentValue}
          onSubmitPrompt={submitInlineAgent}
          onApplyEdit={(value) => void submitInlineEdit(value)}
          infographicEnabled={imageGenReady && isMarkdown && !renderSafety.readOnly}
          infographicInFlight={infographicInFlight}
          onGenerateInfographic={() => void generateInfographic()}
        />
      ) : null}

      <WriteAgnesImageDialog
        open={agnesImageDialogOpen}
        disabled={!activeFilePath || !activeFileIsText || renderSafety.readOnly}
        generating={agnesImageGenerating}
        onClose={() => setAgnesImageDialogOpen(false)}
        onGenerate={(payload) => void generateAgnesImage(payload)}
      />

      <WriteExportDialog
        open={exportDialogOpen}
        exporting={exportingFormat === 'docx'}
        templates={exportTemplates}
        defaultTemplateId={defaultExportTemplateId}
        onClose={() => setExportDialogOpen(false)}
        onExport={(payload) => void exportFromDialog(payload)}
        onSaveTemplate={(template) => handleSaveExportTemplate(template)}
        onDeleteTemplate={(templateId) => handleDeleteExportTemplate(templateId)}
        onSetDefaultTemplate={(templateId) => handleSetDefaultExportTemplate(templateId)}
      />

      {fileError ? (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-full border border-red-200/70 bg-red-50/92 px-4 py-2 text-[13px] text-red-700 shadow-[0_14px_32px_rgba(15,23,42,0.12)] dark:border-red-900/60 dark:bg-red-950/84 dark:text-red-200">
          {fileError}
        </div>
      ) : null}
      {exportNotice ? (
        <div
          className={`pointer-events-none fixed left-1/2 z-40 -translate-x-1/2 rounded-full border px-4 py-2 text-[13px] shadow-[0_14px_32px_rgba(15,23,42,0.12)] ${
            exportNotice.tone === 'error'
              ? 'border-red-200/70 bg-red-50/92 text-red-700 dark:border-red-900/60 dark:bg-red-950/84 dark:text-red-200'
              : 'border-emerald-200/80 bg-emerald-50/92 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/84 dark:text-emerald-200'
          }`}
          style={{ bottom: fileError ? 68 : 20 }}
        >
          {exportNotice.message}
        </div>
      ) : null}
    </div>
  )
}
