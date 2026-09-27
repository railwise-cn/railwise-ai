import type { ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { ApprovalPolicy, ConversationViewMode, SandboxMode } from '@shared/app-settings'
import { parseClawCommand } from '@shared/claw-commands'
import { DEFAULT_COMPOSER_MODEL_IDS } from '@shared/default-composer-models'
import { buildGuiPlanId, buildPlanRelativePath } from '@shared/gui-plan'
import { sddDraftTraceRelativePath } from '@shared/sdd'
import { buildSddTraceSnapshot } from '@shared/sdd-trace'
import {
  findKeyboardShortcutCommand,
  keyboardEventToShortcut,
  resolveKeyboardShortcutBindings,
  type KeyboardShortcutCommandId
} from '@shared/keyboard-shortcuts'
import type { DesktopCommand, SkillListItem, WriteKnowledgeSearchResult } from '@shared/workwise-api'
import type { AgentProfileV1 } from '@shared/agent-workbench'
import type { ClipboardImageReadResult } from '@shared/workspace-file'
import type { AttachmentReference, ChatBlock } from '../agent/types'
import type { CoreRuntimeInfoJson, CoreRuntimeSkillJson } from '../agent/runtime-contract'
import { getProvider } from '../agent/registry'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { useChatStore } from '../store/chat-store'
import { isClawThread } from '../store/chat-store-helpers'
import { hasPendingRuntimeWork } from '../store/chat-store-runtime-helpers'
import {
  extractLatestTurnAutoOpenDevPreviewUrls,
  extractLatestTurnDevPreviewUrls
} from '../lib/dev-preview-detection'
import { Sidebar } from './chat/Sidebar'
import { WorkbenchTopBar, type RightPanelMode } from './chat/WorkbenchTopBar'
import { MessageTimeline } from './chat/MessageTimeline'
import { TaskRunStatusBar } from './chat/TaskRunStatusBar'
import {
  FloatingComposer,
  type ComposerExecutionSettings,
  type ComposerFileReference
} from './chat/FloatingComposer'
import { setThreadAgentWithOneRevisionReplay } from './chat/thread-agent-selection'
import {
  composerReasoningEffortRequestValue,
  type ComposerReasoningEffort
} from './chat/FloatingComposerModelPicker'
import { SideConversationPanel } from './chat/SideConversationPanel'
import { SessionHeader } from './SessionHeader'
import { WriteWorkspaceView } from './write/WriteWorkspaceView'
import { WriteSidebar } from './write/WriteSidebar'
import { SddDraftEditorView } from './sdd/SddDraftEditorView'
import { SidebarTitlebarToggleButton } from './sidebar/SidebarPrimitives'
import { composeWritePrompt } from '../write/quoted-selection'
import { useWriteWorkspaceStore } from '../write/write-workspace-store'
import { isWriteThreadId } from '../write/write-thread-registry'
import {
  designDocumentIdForAssistantThread,
  isDesignAssistantThread,
  requestDesignDocumentOpen
} from '../design/design-thread-registry'
import { createSddDraft, forgetRememberedSddDraft, useSddDraftStore } from '../sdd/sdd-draft-store'
import type { SddDraft, SddDraftSaveStatus } from '../sdd/sdd-draft-store'
import { saveActiveSddDraftToDisk } from '../sdd/sdd-draft-actions'
import { restoreRememberedSddDraft } from '../sdd/sdd-draft-restore'
import { composeSddAssistantPrompt } from '../sdd/sdd-assistant-prompt'
import { collectSddDraftImages, withAttachmentIds, type SddDraftImageReference } from '../sdd/sdd-draft-images'
import { buildSddDraftToPlanPrompt } from '../sdd/sdd-plan-prompt'
import {
  isSddAssistantThread,
  markSddAssistantThread,
  releaseSddAssistantThread,
  sddAssistantThreadIdForDraft
} from '../sdd/sdd-thread-registry'
import { parseGuiPlanCommand } from '../plan/plan-command'
import { DevPreviewLaunchCard } from './DevPreviewLaunchCard'
import { RuntimeBanner } from './RuntimeBanner'
import { useWorkbenchLayout } from './workbench-layout'
import { useWorkbenchPlanController } from './workbench-plan-controller'
import { prepareImageAttachmentUpload } from '../lib/image-attachment-upload'
import { isChatAttachmentUploadEnabled } from '../lib/attachment-upload-availability'
import { normalizeWorkspaceRoot } from '../lib/workspace-path'
import { useKeyboardShortcutSettings } from '../lib/keyboard-shortcut-settings'
import { collectComposerChangeSummary } from '../lib/composer-change-summary'
import { selectFilesForAvailableAttachmentSlots } from '../lib/attachment-selection'
import { clearComposerDraftAfterSuccessfulSend } from '../lib/composer-send-result'
import { readFocusModePreference, writeFocusModePreference } from '../lib/focus-mode'
import { WorkbenchRegistry } from './workbench-registry'
import { WorkbenchPanelLoader } from './workbench-panel-loader'
import { builtinRightPanelLoaders } from './workbench-panel-loaders'
import {
  createWorkbenchComposerDrafts,
  setWorkbenchComposerDraft,
  workbenchComposerScope
} from './workbench-composer-drafts'
import {
  buildComposerFileContextPrompt,
  runtimeWorkspaceReferences,
  mergeComposerFileReferences,
  selectComposerWorkspaceReference,
  updateLegacyInlineFallbackKeys,
  type ComposerWorkspaceReference,
  type ComposerFileContextEntry
} from '../lib/composer-file-references'

function writeContentHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}
type BuiltinRightPanelContext = {
  mode: RightPanelMode
  route: string
  activeSddDraft: boolean
  writeAssistantOpen: boolean
  renderers?: Record<string, (module: unknown) => ReactElement | null>
}

const builtinRightPanels = new WorkbenchRegistry<BuiltinRightPanelContext, void, ReactElement | null>()
const registerBuiltinRightPanel = <Module,>(
  id: string,
  order: number,
  availability: (context: BuiltinRightPanelContext) => boolean,
  load: () => Promise<Module>
): void => {
  builtinRightPanels.registerTab({
    id,
    order,
    single: true,
    dedupeKey: () => id,
    availability,
    load,
    render: (module, context) => context.renderers?.[id]?.(module) ?? null,
    onOpen: () => undefined,
    onClose: () => undefined
  })
}
registerBuiltinRightPanel('sdd-ai', 10, (context) => context.mode === 'sdd-ai' && context.activeSddDraft, builtinRightPanelLoaders['sdd-ai'])
registerBuiltinRightPanel('write-assistant', 20, (context) => context.route === 'write' && context.writeAssistantOpen, builtinRightPanelLoaders['write-assistant'])
registerBuiltinRightPanel('changes', 30, (context) => context.mode === 'changes', () => import('./ChangeInspector'))
registerBuiltinRightPanel('todo', 40, (context) => context.mode === 'todo', () => import('./todo/TodoPanel'))
registerBuiltinRightPanel('browser', 50, (context) => context.mode === 'browser', () => import('./DevBrowserPanel'))
registerBuiltinRightPanel('plan', 60, (context) => context.mode === 'plan', () => import('./plan/PlanPanel'))
registerBuiltinRightPanel('file', 70, (context) => context.mode === 'file', () => import('./WorkspaceFilePreviewPanel'))

type BuiltinWorkbenchViewContext = {
  route: string
  renderers?: Record<string, (module: unknown) => ReactElement | null>
}
const builtinWorkbenchViews = new WorkbenchRegistry<BuiltinWorkbenchViewContext, void, ReactElement | null>()
const registerBuiltinWorkbenchView = <Module,>(
  id: string,
  order: number,
  route: string,
  load: () => Promise<Module>
): void => {
  builtinWorkbenchViews.registerTab({
    id,
    order,
    single: true,
    dedupeKey: () => id,
    availability: (context) => context.route === route,
    load,
    render: (module, context) => context.renderers?.[id]?.(module) ?? null,
    onOpen: () => undefined,
    onClose: () => undefined
  })
}
registerBuiltinWorkbenchView('plugins', 10, 'plugins', () => import('./PluginMarketplaceView'))
registerBuiltinWorkbenchView('flow', 20, 'flow', () => import('./flow/FlowWorkspaceView'))
registerBuiltinWorkbenchView('schedule', 30, 'schedule', () => import('./schedule/ScheduleTasksView'))
registerBuiltinWorkbenchView('design', 40, 'design', () => import('./design/DesignWorkspaceView'))
registerBuiltinWorkbenchView('engineering', 50, 'engineering', () => import('./engineering/EngineeringWorkspaceView'))

type PendingSddPlanTarget = {
  planId: string
  relativePath: string
  workspaceRoot: string
}

const COMPOSER_FILE_CONTEXT_MAX_CHARS_PER_FILE = 60_000
const COMPOSER_FILE_CONTEXT_MAX_TOTAL_CHARS = 180_000
const DESKTOP_SHORTCUT_COMMANDS: Partial<Record<KeyboardShortcutCommandId, DesktopCommand>> = {
  quit: 'quit',
  undo: 'undo',
  redo: 'redo',
  cut: 'cut',
  copy: 'copy',
  paste: 'paste',
  'select-all': 'selectAll',
  reload: 'reload',
  'zoom-in': 'zoomIn',
  'zoom-out': 'zoomOut',
  'reset-zoom': 'resetZoom',
  'toggle-devtools': 'toggleDevTools',
  close: 'close',
  minimize: 'minimize',
  'toggle-maximize': 'toggleMaximize'
}

function fileNameFromPath(path: string): string {
  return path.replaceAll('\\', '/').split('/').filter(Boolean).pop() || 'image'
}

function clipComposerFileContext(
  content: string,
  remainingChars: number,
  sourceTruncated: boolean
): { content: string; truncated: boolean; consumed: number } {
  const limit = Math.max(0, Math.min(COMPOSER_FILE_CONTEXT_MAX_CHARS_PER_FILE, remainingChars))
  const clipped = content.slice(0, limit)
  return {
    content: clipped,
    truncated: sourceTruncated || clipped.length < content.length,
    consumed: clipped.length
  }
}

function sddDraftPlanRelativePath(draft: SddDraft): string {
  const parts = draft.relativePath.replaceAll('\\', '/').split('/').filter(Boolean)
  const draftFolder = parts.at(-2)?.trim() || draft.id.split(':').pop()?.trim() || `draft-${Date.now()}`
  return buildPlanRelativePath(`sdd-${draftFolder}`)
}

function sddDraftSourceRequest(markdown: string, fallbackPath: string): string {
  const firstMeaningfulLine = markdown
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find(Boolean)
  return (firstMeaningfulLine || fallbackPath).slice(0, 160)
}

function sddPlanMatchesPendingTarget(
  plan: { id: string; workspaceRoot: string; relativePath: string } | null,
  target: PendingSddPlanTarget | null
): boolean {
  if (!plan || !target) return false
  if (plan.id === target.planId) return true
  return buildGuiPlanId(plan.workspaceRoot, plan.relativePath) === target.planId
}

function mergeSkillCommands(
  runtimeSkills: CoreRuntimeSkillJson[],
  localSkills: SkillListItem[]
): CoreRuntimeSkillJson[] {
  const merged = new Map<string, CoreRuntimeSkillJson>()
  for (const skill of localSkills) {
    merged.set(skill.id, {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      root: skill.root,
      legacy: skill.legacy,
      scope: skill.scope
    })
  }
  for (const skill of runtimeSkills) {
    const existing = merged.get(skill.id)
    merged.set(skill.id, existing ? {
      ...skill,
      ...existing,
      triggers: skill.triggers ?? existing.triggers,
      allowedTools: skill.allowedTools ?? existing.allowedTools
    } : skill)
  }
  return [...merged.values()]
}

function sddAssistantContextFromBlocks(blocks: ChatBlock[], maxMessages = 10): string {
  const messages: string[] = []
  for (const block of blocks) {
    if (block.kind !== 'user' && block.kind !== 'assistant') continue
    if (block.kind === 'user' && block.meta?.displayText) continue
    const text = block.text.trim()
    if (!text) continue
    messages.push(`${block.kind === 'user' ? 'User' : 'Requirement AI'}:\n${text}`)
  }
  return messages.slice(-maxMessages).join('\n\n').slice(0, 12_000)
}

function base64ImageToFile(image: SddDraftImageReference): File {
  return base64ToFile(image.dataBase64, fileNameFromPath(image.relativePath), image.mimeType)
}

function clipboardImageToFile(image: Extract<ClipboardImageReadResult, { ok: true }>): File {
  return base64ToFile(image.dataBase64, image.name, image.mimeType)
}

function base64ToFile(dataBase64: string, name: string, mimeType: string): File {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new File([bytes], name || 'image', { type: mimeType })
}

export function Workbench(): ReactElement {
  const { t } = useTranslation('common')
  const {
    threads,
    threadSearch,
    showArchivedThreads,
    activeThreadId,
    selectThread,
    createThread,
    blocks,
    liveReasoning,
    liveAssistant,
    error,
    runtimeErrorDetail,
    busy,
    route,
    flowFilter,
    pluginHostRoute,
    workspaceRoot,
    runtimeConnection,
    setRoute,
    openCode,
    openWrite,
    ensureWriteThreadForWorkspace,
    createWriteThread,
    openSettings,
    openPlugins,
    openClaw,
    openSchedule,
    openFlow,
    openDesign,
    openEngineering,
    chooseWorkspace,
    clawChannels,
    activeClawChannelId,
    selectClawChannel,
    resetClawChannelSession,
    setClawChannelModel,
    appendLocalClawTurn,
    setError,
    sendMessage,
    reviewActiveThread,
    queuedMessages,
    removeQueuedMessage,
    interrupt,
    probeRuntime,
    composerModel,
    composerProviderId,
    composerPickList,
    composerModelGroups,
    setComposerModel,
    setThreadSearch,
    setShowArchivedThreads,
    renameThread,
    archiveThread,
    deleteThread,
    spawnSideConversation,
    openSideConversationDraft,
    selectSideConversation,
    setSidePanelOpen,
    sideConversations,
    sidePanel
  } = useChatStore(
    useShallow((s) => ({
      threads: s.threads,
      threadSearch: s.threadSearch,
      showArchivedThreads: s.showArchivedThreads,
      activeThreadId: s.activeThreadId,
      selectThread: s.selectThread,
      createThread: s.createThread,
      blocks: s.blocks,
      liveReasoning: s.liveReasoning,
      liveAssistant: s.liveAssistant,
      error: s.error,
      runtimeErrorDetail: s.runtimeErrorDetail,
      busy: s.busy,
      route: s.route,
      flowFilter: s.flowFilter,
      pluginHostRoute: s.pluginHostRoute,
      workspaceRoot: s.workspaceRoot,
      runtimeConnection: s.runtimeConnection,
      setRoute: s.setRoute,
      openCode: s.openCode,
      openWrite: s.openWrite,
      ensureWriteThreadForWorkspace: s.ensureWriteThreadForWorkspace,
      createWriteThread: s.createWriteThread,
      openSettings: s.openSettings,
      openPlugins: s.openPlugins,
      openClaw: s.openClaw,
      openSchedule: s.openSchedule,
      openFlow: s.openFlow,
      openDesign: s.openDesign,
      openEngineering: s.openEngineering,
      chooseWorkspace: s.chooseWorkspace,
      clawChannels: s.clawChannels,
      activeClawChannelId: s.activeClawChannelId,
      selectClawChannel: s.selectClawChannel,
      resetClawChannelSession: s.resetClawChannelSession,
      setClawChannelModel: s.setClawChannelModel,
      appendLocalClawTurn: s.appendLocalClawTurn,
      setError: s.setError,
      sendMessage: s.sendMessage,
      reviewActiveThread: s.reviewActiveThread,
      queuedMessages: s.queuedMessages,
      removeQueuedMessage: s.removeQueuedMessage,
      interrupt: s.interrupt,
      probeRuntime: s.probeRuntime,
      composerModel: s.composerModel,
      composerProviderId: s.composerProviderId,
      composerPickList: s.composerPickList,
      composerModelGroups: s.composerModelGroups,
      setComposerModel: s.setComposerModel,
      setThreadSearch: s.setThreadSearch,
      setShowArchivedThreads: s.setShowArchivedThreads,
      renameThread: s.renameThread,
      archiveThread: s.archiveThread,
      deleteThread: s.deleteThread,
      spawnSideConversation: s.spawnSideConversation,
      openSideConversationDraft: s.openSideConversationDraft,
      selectSideConversation: s.selectSideConversation,
      setSidePanelOpen: s.setSidePanelOpen,
      sideConversations: s.sideConversations,
      sidePanel: s.sidePanel
    }))
  )
  const composerScope = workbenchComposerScope(route)
  const [composerDrafts, setComposerDrafts] = useState(createWorkbenchComposerDrafts)
  const input = composerDrafts[composerScope]
  const setInput = useCallback((value: string): void => {
    setComposerDrafts((drafts) => setWorkbenchComposerDraft(drafts, composerScope, value))
  }, [composerScope])
  const [skillCatalogGeneration, setSkillCatalogGeneration] = useState(0)
  const [mode, setMode] = useState<'plan' | 'agent'>('agent')
  const [composerReasoningEffort, setComposerReasoningEffort] =
    useState<ComposerReasoningEffort>('max')
  const [runtimeInfo, setRuntimeInfo] = useState<CoreRuntimeInfoJson | null>(null)
  const [runtimeSkills, setRuntimeSkills] = useState<CoreRuntimeSkillJson[]>([])
  const [agentProfiles, setAgentProfiles] = useState<AgentProfileV1[]>([])
  const [agentSelectionApplying, setAgentSelectionApplying] = useState(false)
  const [composerAttachments, setComposerAttachments] = useState<AttachmentReference[]>([])
  const [writeAttachments, setWriteAttachments] = useState<AttachmentReference[]>([])
  const [composerFileReferences, setComposerFileReferences] = useState<ComposerWorkspaceReference[]>([])
  const [composerLegacyInlineFallbackKeys, setComposerLegacyInlineFallbackKeys] = useState<string[]>([])
  const [composerExecutionSettings, setComposerExecutionSettings] =
    useState<ComposerExecutionSettings | null>(null)
  const [composerExecutionApplying, setComposerExecutionApplying] = useState(false)
  const [conversationViewMode, setConversationViewMode] =
    useState<ConversationViewMode>('concise')
  const [taskConversationViewMode, setTaskConversationViewMode] =
    useState<ConversationViewMode | null>(null)
  const [attachmentUploadBusy, setAttachmentUploadBusy] = useState(false)
  const [attachmentUploadError, setAttachmentUploadError] = useState<string | null>(null)
  const [writeAttachmentUploadBusy, setWriteAttachmentUploadBusy] = useState(false)
  const [writeAttachmentUploadError, setWriteAttachmentUploadError] = useState<string | null>(null)
  const [connectPhoneSidebarOpen, setConnectPhoneSidebarOpen] = useState(false)
  const [focusModeEnabled, setFocusModeEnabled] = useState(readFocusModePreference)
  const [runtimeLogPath, setRuntimeLogPath] = useState('')
  const writeAssistantOpen = useWriteWorkspaceStore((s) => s.assistantOpen)
  const setWriteAssistantOpen = useWriteWorkspaceStore((s) => s.setAssistantOpen)
  const writeAssistantModel = useWriteWorkspaceStore((s) => s.assistantModel)
  const writeAssistantProviderId = useWriteWorkspaceStore((s) => s.assistantProviderId)
  const setWriteAssistantModel = useWriteWorkspaceStore((s) => s.setAssistantModel)
  const activeWriteWorkspaceRoot = useWriteWorkspaceStore((s) => s.workspaceRoot)
  const activeWriteFilePath = useWriteWorkspaceStore((s) => s.activeFilePath)
  const activeSddDraft = useSddDraftStore((s) => s.activeDraft)
  const sddDraftOperationStatus = useSddDraftStore((s) => s.operationStatus)
  const writeAssistantPickList = useMemo(() => {
    const ordered = new Set<string>()
    for (const id of DEFAULT_COMPOSER_MODEL_IDS) {
      const normalized = id.trim()
      if (normalized) ordered.add(normalized)
    }
    for (const id of composerPickList) {
      const normalized = id.trim()
      if (normalized) ordered.add(normalized)
    }
    const current = writeAssistantModel.trim()
    if (current) ordered.add(current)
    return [...ordered]
  }, [composerPickList, writeAssistantModel])
  const stageInsetClass = 'ds-stage-inset'
  const keyboardShortcuts = useKeyboardShortcutSettings()
  const keyboardShortcutBindings = useMemo(
    () => resolveKeyboardShortcutBindings(keyboardShortcuts),
    [keyboardShortcuts]
  )

  const prevThreadId = useRef<string | null>(null)
  const inputRef = useRef('')
  const dismissedSddDraftWorkspacesRef = useRef<Set<string>>(new Set())
  const restoredSddDraftWorkspaceRef = useRef('')
  const sddUpgradeInFlightRef = useRef(false)
  const sddUpgradeTargetRef = useRef<PendingSddPlanTarget | null>(null)
  const writeContextGenerationRef = useRef(0)
  const pendingNotificationThreadRef = useRef<string | null>(null)

  useEffect(() => {
    if (route !== 'write' || runtimeConnection !== 'ready' || busy) return
    const targetWorkspace = activeWriteWorkspaceRoot || workspaceRoot
    if (!targetWorkspace) return
    const generation = ++writeContextGenerationRef.current
    void ensureWriteThreadForWorkspace(targetWorkspace, activeWriteFilePath).then(() => {
      if (writeContextGenerationRef.current === generation) return
      const latest = useWriteWorkspaceStore.getState()
      void ensureWriteThreadForWorkspace(
        latest.workspaceRoot || workspaceRoot,
        latest.activeFilePath
      )
    })
  }, [
    activeWriteFilePath,
    activeWriteWorkspaceRoot,
    busy,
    ensureWriteThreadForWorkspace,
    route,
    runtimeConnection,
    workspaceRoot
  ])
  const timelineBlocks = blocks
  const timelineLiveReasoning = liveReasoning
  const timelineLiveAssistant = liveAssistant
  const devPreviewBlocks = useMemo<ChatBlock[]>(() => {
    const liveText = timelineLiveAssistant.trim()
    if (!liveText) return timelineBlocks
    return [
      ...timelineBlocks,
      {
        kind: 'assistant',
        id: '__live-assistant-dev-preview',
        text: timelineLiveAssistant
      }
    ]
  }, [timelineBlocks, timelineLiveAssistant])
  const detectedDevPreviewUrls = useMemo(
    () => extractLatestTurnDevPreviewUrls(devPreviewBlocks),
    [devPreviewBlocks]
  )
  const autoOpenDevPreviewUrls = useMemo(
    () => extractLatestTurnAutoOpenDevPreviewUrls(devPreviewBlocks),
    [devPreviewBlocks]
  )
  const activeClawChannel = useMemo(
    () => clawChannels.find((channel) => channel.id === activeClawChannelId) ?? null,
    [activeClawChannelId, clawChannels]
  )
  const activeSkillWorkspace = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId)?.workspace || workspaceRoot || '',
    [activeThreadId, threads, workspaceRoot]
  )
  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [activeThreadId, threads]
  )
  const composerChangeSummary = useMemo(
    () => collectComposerChangeSummary(timelineBlocks, activeSkillWorkspace),
    [activeSkillWorkspace, timelineBlocks]
  )
  const latestDevPreviewUrl = detectedDevPreviewUrls[0] ?? null
  const latestAutoOpenDevPreviewUrl = autoOpenDevPreviewUrls[0] ?? null
  const currentSideConversations = useMemo(
    () =>
      Object.values(sideConversations)
        .filter((side) => side.parentThreadId === activeThreadId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [activeThreadId, sideConversations]
  )
  const currentSideRunningCount = currentSideConversations.reduce(
    (count, side) => count + (side.busy ? 1 : 0),
    0
  )

  useEffect(() => {
    if (
      route !== 'chat'
      || runtimeConnection !== 'ready'
      || !activeThreadId
      || typeof window.workwise?.listAgentProfiles !== 'function'
    ) {
      setAgentProfiles([])
      return
    }
    let cancelled = false
    void window.workwise.listAgentProfiles(activeSkillWorkspace).then(
      (snapshot) => {
        if (!cancelled) setAgentProfiles(snapshot.profiles)
      },
      (cause) => {
        if (!cancelled) {
          setAgentProfiles([])
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [activeSkillWorkspace, activeThreadId, route, runtimeConnection, setError])

  const changeActiveThreadAgent = async (agentId: string): Promise<void> => {
    if (
      !activeThreadId
      || busy
      || agentSelectionApplying
      || typeof window.workwise?.setThreadAgent !== 'function'
    ) return

    setAgentSelectionApplying(true)
    try {
      await setThreadAgentWithOneRevisionReplay({
        threadId: activeThreadId,
        agentId,
        expectedRevision: activeThread?.agentRevision ?? 0,
        setThreadAgent: window.workwise.setThreadAgent,
        refreshThreads: useChatStore.getState().refreshThreads,
        readExpectedRevision: () => useChatStore.getState().threads
          .find((thread) => thread.id === activeThreadId)?.agentRevision
      })
      await useChatStore.getState().refreshThreads()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAgentSelectionApplying(false)
    }
  }
  const {
    beginLeftResize,
    beginRightResize,
    filePreviewTarget,
    leftSidebarCollapsed,
    leftSidebarWidth,
    openDevPreview,
    rightPanelMode,
    rightPanelVisible,
    rightSidebarWidth,
    setFilePreviewTarget,
    setRightPanelMode,
    setRightSidebarWidth,
    shellRef,
    toggleLeftSidebar,
    toggleRightPanelMode,
  } = useWorkbenchLayout({
    activeThreadId,
    latestAutoOpenDevPreviewUrl,
    latestDevPreviewUrl,
    route,
    workspaceRoot,
    writeAssistantOpen
  })
  const {
    activeGuiPlan,
    buildGuiPlan,
    handleGuiPlanCommand,
    openGuiPlanPanel,
    replanChangedRequirements,
    sendPlanTurn,
    verifyGuiPlan
  } = useWorkbenchPlanController({
    blocks,
    busy,
    mode,
    route,
    sendMessage,
    setError,
    setMode,
    setRightPanelMode,
    setRightSidebarWidth,
    t,
    workspaceRoot,
    onPlanBuildStarted: async (plan) => {
      const threadId = plan.threadId?.trim() || useChatStore.getState().activeThreadId
      if (!threadId || !releaseSddAssistantThread(threadId)) return
      await useChatStore.getState().refreshThreads()
    }
  })

  useEffect(() => {
    const runDesktopShortcut = (command: DesktopCommand): void => {
      if (typeof window.workwise?.runDesktopCommand !== 'function') return
      void window.workwise.runDesktopCommand(command)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || event.isComposing) return
      const commandId = findKeyboardShortcutCommand(
        keyboardShortcutBindings,
        keyboardEventToShortcut(event)
      )
      if (!commandId) return
      event.preventDefault()

      if (commandId === 'toggle-plan-mode') {
        if (mode === 'plan') {
          setMode('agent')
        } else {
          setMode('plan')
          void handleGuiPlanCommand()
        }
        return
      }
      if (commandId === 'new-chat') {
        void createThread()
        return
      }
      if (commandId === 'choose-workspace') {
        void chooseWorkspace()
        return
      }
      if (commandId === 'settings') {
        openSettings()
        return
      }

      const desktopCommand = DESKTOP_SHORTCUT_COMMANDS[commandId]
      if (desktopCommand) runDesktopShortcut(desktopCommand)
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [
    chooseWorkspace,
    createThread,
    handleGuiPlanCommand,
    keyboardShortcutBindings,
    mode,
    openSettings,
    setMode
  ])

  useEffect(() => {
    if (typeof window.workwise?.onApplicationMenuAction !== 'function') return
    return window.workwise.onApplicationMenuAction((action) => {
      if (action === 'new-chat') {
        void createThread()
        return
      }
      if (action === 'choose-workspace') {
        void chooseWorkspace()
        return
      }
      if (action === 'settings') {
        openSettings('general')
        return
      }
      if (action === 'help-center') {
        openSettings('help')
        return
      }
      if (action === 'check-updates') {
        openSettings('general')
        if (typeof window.workwise?.checkGuiUpdate === 'function') {
          void window.workwise.checkGuiUpdate().catch(() => undefined)
        }
      }
    })
  }, [chooseWorkspace, createThread, openSettings])

  const showDevPreviewCard =
    route === 'chat' &&
    latestDevPreviewUrl !== null

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.workwise?.getLogPath !== 'function') return
    let cancelled = false
    void window.workwise
      .getLogPath()
      .then((path) => {
        if (!cancelled) setRuntimeLogPath(path)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.setAttribute('data-focus-mode', focusModeEnabled ? 'on' : 'off')
  }, [focusModeEnabled])

  useEffect(() => {
    const previousThreadId = prevThreadId.current
    prevThreadId.current = activeThreadId
    if (previousThreadId !== null && previousThreadId !== activeThreadId && sidePanel.open) {
      setSidePanelOpen(false)
    }
  }, [activeThreadId, setSidePanelOpen, sidePanel.open])

  const openSideChat = (): void => {
    const latestSide = currentSideConversations.at(-1)
    if (latestSide) {
      selectSideConversation(latestSide.threadId)
      return
    }
    openSideConversationDraft()
  }

  useEffect(() => {
    if (typeof window.workwise?.onSkillsChanged !== 'function') return
    let timer: number | null = null
    const unsubscribe = window.workwise.onSkillsChanged((generation) => {
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        setSkillCatalogGeneration((current) => Math.max(current, generation))
        timer = null
      }, 500)
    })
    return () => {
      if (timer != null) window.clearTimeout(timer)
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void rendererRuntimeClient.getSettings()
      .then((settings) => {
        if (cancelled) return
        setComposerExecutionSettings({
          approvalPolicy: settings.agents.kun.approvalPolicy,
          sandboxMode: settings.agents.kun.sandboxMode
        })
        setConversationViewMode(settings.conversation.viewMode)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const updateComposerExecutionSettings = (patch: Partial<ComposerExecutionSettings>): void => {
    if (!composerExecutionSettings || composerExecutionApplying) return
    const previous = composerExecutionSettings
    const next = { ...previous, ...patch }
    setComposerExecutionSettings(next)
    setComposerExecutionApplying(true)
    void rendererRuntimeClient.setSettings({
      agents: {
        kun: {
          ...(patch.approvalPolicy ? { approvalPolicy: patch.approvalPolicy as ApprovalPolicy } : {}),
          ...(patch.sandboxMode ? { sandboxMode: patch.sandboxMode as SandboxMode } : {})
        }
      }
    }).then((settings) => {
      setComposerExecutionSettings({
        approvalPolicy: settings.agents.kun.approvalPolicy,
        sandboxMode: settings.agents.kun.sandboxMode
      })
      void probeRuntime('background')
    }).catch((error: unknown) => {
      setComposerExecutionSettings(previous)
      setError(error instanceof Error ? error.message : String(error))
    }).finally(() => setComposerExecutionApplying(false))
  }

  const codeThreads = useMemo(
    () => threads.filter((thread) =>
      !isWriteThreadId(thread.id) &&
      !isClawThread(thread, clawChannels) &&
      !isSddAssistantThread(thread) &&
      !isDesignAssistantThread(thread) &&
      (thread.domain === undefined || thread.domain === 'code')
    ),
    [clawChannels, threads]
  )

  const mirrorClawCommand = async (userText: string, replyText: string): Promise<void> => {
    if (!activeThreadId || typeof window.workwise?.mirrorClawChannelMessage !== 'function') return
    const userResult = await window.workwise.mirrorClawChannelMessage(
      activeThreadId,
      userText,
      'user'
    )
    if (!userResult.ok) return
    await window.workwise.mirrorClawChannelMessage(
      activeThreadId,
      replyText,
      'assistant'
    )
  }

  const clawHelpText = (): string =>
    [
      t('clawHelpTitle'),
      '',
      `- \`/help\`: ${t('clawHelpCommandHelp')}`,
      `- \`/new\`: ${t('clawHelpCommandNew')}`,
      `- \`/model auto\`: ${t('clawHelpCommandModelAuto')}`,
      `- \`/model pro\`: ${t('clawHelpCommandModelPro')}`,
      `- \`/model flash\`: ${t('clawHelpCommandModelFlash')}`,
      `- \`/model\`: ${t('clawHelpCommandModelShow')}`
    ].join('\n')

  useEffect(() => {
    inputRef.current = input
  }, [input])

  useEffect(() => {
    if (rightPanelMode === 'plan' && !activeGuiPlan) {
      setRightPanelMode(null)
    }
  }, [activeGuiPlan, rightPanelMode, setRightPanelMode])

  useEffect(() => {
    if (
      !activeGuiPlan ||
      !sddUpgradeInFlightRef.current ||
      !sddPlanMatchesPendingTarget(activeGuiPlan, sddUpgradeTargetRef.current)
    ) {
      return
    }
    sddUpgradeInFlightRef.current = false
    sddUpgradeTargetRef.current = null
    useSddDraftStore.getState().setOperationStatus('idle')
    const completedDraft = useSddDraftStore.getState().activeDraft
    if (completedDraft) forgetRememberedSddDraft(completedDraft)
    useSddDraftStore.getState().clearActiveDraft()
  }, [activeGuiPlan])

  useEffect(() => {
    if (
      busy ||
      !sddUpgradeInFlightRef.current ||
      sddDraftOperationStatus !== 'upgrading' ||
      sddPlanMatchesPendingTarget(activeGuiPlan, sddUpgradeTargetRef.current)
    ) {
      return
    }
    const timeout = window.setTimeout(() => {
      if (!sddUpgradeInFlightRef.current) return
      if (useSddDraftStore.getState().operationStatus !== 'upgrading') return
      sddUpgradeInFlightRef.current = false
      sddUpgradeTargetRef.current = null
      useSddDraftStore.getState().setOperationStatus('error', t('planToolResultMissing'))
    }, 800)
    return () => window.clearTimeout(timeout)
  }, [activeGuiPlan, busy, sddDraftOperationStatus, t])

  useEffect(() => {
    let cancelled = false
    const runtimeReady = runtimeConnection === 'ready'
    if (!runtimeReady) setRuntimeInfo(null)
    const provider = getProvider()
    const localSkillsTask = typeof window !== 'undefined' && typeof window.workwise?.listSkills === 'function'
      ? window.workwise.listSkills(activeSkillWorkspace || undefined)
      : Promise.resolve({ ok: true as const, generation: 0, skills: [], validationErrors: [] })
    void Promise.allSettled([
      runtimeReady && provider.getRuntimeInfo ? provider.getRuntimeInfo() : Promise.resolve(null),
      runtimeReady && provider.listSkills ? provider.listSkills() : Promise.resolve([]),
      localSkillsTask
    ])
      .then(([runtimeResult, skillsResult, localSkillsResult]) => {
        if (cancelled) return
        setRuntimeInfo(runtimeResult.status === 'fulfilled' ? runtimeResult.value : null)
        const runtimeSkillList = skillsResult.status === 'fulfilled' ? skillsResult.value : []
        const localSkillList =
          localSkillsResult.status === 'fulfilled' && localSkillsResult.value.ok
            ? localSkillsResult.value.skills
            : []
        setRuntimeSkills(mergeSkillCommands(runtimeSkillList, localSkillList))
      })
      .catch(() => {
        if (!cancelled) {
          if (!runtimeReady) setRuntimeInfo(null)
          setRuntimeSkills([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeSkillWorkspace, runtimeConnection, skillCatalogGeneration])

  const attachmentUploadEnabled = isChatAttachmentUploadEnabled({
    runtimeConnection,
    route,
    mode,
    attachmentStoreAvailable: runtimeInfo?.capabilities.attachments.available
  })
  const webAccessAvailable =
    runtimeInfo?.capabilities.web.fetch.available === true ||
    runtimeInfo?.capabilities.web.search.available === true

  const clearComposerAttachments = (): void => {
    setComposerAttachments([])
  }

  type AttachmentScope = 'chat' | 'write'
  const attachmentsForScope = (scope: AttachmentScope): AttachmentReference[] =>
    scope === 'write' ? writeAttachments : composerAttachments
  const updateAttachmentsForScope = (
    scope: AttachmentScope,
    update: (current: AttachmentReference[]) => AttachmentReference[]
  ): void => {
    if (scope === 'write') setWriteAttachments(update)
    else setComposerAttachments(update)
  }
  const setAttachmentBusyForScope = (scope: AttachmentScope, value: boolean): void => {
    if (scope === 'write') setWriteAttachmentUploadBusy(value)
    else setAttachmentUploadBusy(value)
  }
  const setAttachmentErrorForScope = (scope: AttachmentScope, value: string | null): void => {
    if (scope === 'write') setWriteAttachmentUploadError(value)
    else setAttachmentUploadError(value)
  }

  const clearComposerFileReferences = (): void => {
    setComposerFileReferences([])
    setComposerLegacyInlineFallbackKeys([])
  }

  const addComposerFileReference = (reference: ComposerFileReference): void => {
    const selected = selectComposerWorkspaceReference(reference)
    setComposerFileReferences((current) => mergeComposerFileReferences(current, selected))
    setComposerLegacyInlineFallbackKeys((current) => updateLegacyInlineFallbackKeys(current, {
      type: 'add',
      reference
    }))
  }

  const removeComposerFileReference = (relativePath: string): void => {
    const key = relativePath.trim().replaceAll('\\', '/').replace(/\/+/g, '/').toLowerCase()
    setComposerFileReferences((current) =>
      current.filter((reference) =>
        reference.relativePath.trim().replaceAll('\\', '/').replace(/\/+/g, '/').toLowerCase() !== key
      )
    )
    setComposerLegacyInlineFallbackKeys((current) => updateLegacyInlineFallbackKeys(current, {
      type: 'remove',
      relativePath
    }))
  }

  useEffect(() => {
    if (route !== 'chat') clearComposerFileReferences()
  }, [route])

  const handlePickAttachments = async (
    files: File[],
    scope: AttachmentScope = route === 'write' ? 'write' : 'chat'
  ): Promise<void> => {
    if (!files.length || !attachmentUploadEnabled) return
    const provider = getProvider()
    if (typeof provider.uploadAttachment !== 'function') {
      setAttachmentErrorForScope(scope, t('composerAttachmentUnavailable'))
      return
    }
    setAttachmentBusyForScope(scope, true)
    setAttachmentErrorForScope(scope, null)
    try {
      let targetThreadId = activeThreadId ?? undefined
      let workspace = threads.find((thread) => thread.id === activeThreadId)?.workspace || workspaceRoot || undefined
      if (scope === 'write') {
        const writeState = useWriteWorkspaceStore.getState()
        workspace = writeState.workspaceRoot || workspaceRoot || undefined
        targetThreadId = await ensureWriteThreadForWorkspace(workspace, writeState.activeFilePath) ?? undefined
        if (!targetThreadId) throw new Error(t('runtimeActionNeedsConnection'))
      }
      const attachmentCapabilities = runtimeInfo?.capabilities.attachments
      if (!attachmentCapabilities) {
        setAttachmentErrorForScope(scope, t('composerAttachmentUnavailable'))
        return
      }
      const selected = selectFilesForAvailableAttachmentSlots(
        files,
        attachmentsForScope(scope).length
      )
      if (selected.reduce((total, file) => total + file.size, 0) > 500 * 1024 * 1024) throw new Error('附件批次不能超过 500 MiB')
      const uploaded: AttachmentReference[] = []
      for (const file of selected) {
        if (file.size > 200 * 1024 * 1024) throw new Error(`${file.name} 超过 200 MiB`)
        if (file.type.startsWith('image/') || /\.(?:png|jpe?g|gif|webp)$/i.test(file.name)) {
          const prepared = await prepareImageAttachmentUpload(file, attachmentCapabilities)
          const attachment = await provider.uploadAttachment({
            name: file.name || 'image', mimeType: prepared.mimeType, dataBase64: prepared.dataBase64,
            textFallback: prepared.textFallback, ...(targetThreadId ? { threadId: targetThreadId } : {}), ...(workspace ? { workspace } : {})
          })
          uploaded.push({ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, byteSize: attachment.byteSize, width: attachment.width, height: attachment.height, state: 'ready', previewUrl: `data:${prepared.mimeType};base64,${prepared.dataBase64}` })
          continue
        }
        if (!/\.(?:pdf|docx|xlsx|pptx|txt|md|markdown|csv)$/i.test(file.name)) continue
        if (typeof window.workwise.importChatAttachment !== 'function') throw new Error(t('composerAttachmentUnavailable'))
        const placeholderId = `import_${crypto.randomUUID()}`
        const sourcePath = window.workwise.getPathForFile(file)
        updateAttachmentsForScope(scope, (current) => [...current, { id: placeholderId, name: file.name, mimeType: file.type, byteSize: file.size, state: 'uploading', localSourcePath: sourcePath }])
        updateAttachmentsForScope(scope, (current) => current.map((item) => item.id === placeholderId ? { ...item, state: 'parsing' } : item))
        try {
          const result = await window.workwise.importChatAttachment({ importId: placeholderId, sourcePath, declaredMimeType: file.type || undefined, ...(targetThreadId ? { threadId: targetThreadId } : {}), ...(workspace ? { workspace } : {}) })
          updateAttachmentsForScope(scope, (current) => current.filter((item) => item.id !== placeholderId))
          uploaded.push({ ...result.attachment, managedPath: result.managedPath, localSourcePath: sourcePath })
        } catch (error) {
          updateAttachmentsForScope(scope, (current) => current.map((item) => item.id === placeholderId ? { ...item, state: 'failed', degradationReasons: [error instanceof Error ? error.message : String(error)] } : item))
          throw error
        }
      }
      if (uploaded.length > 0) {
        updateAttachmentsForScope(scope, (current) => {
          const byId = new Map(current.map((attachment) => [attachment.id, attachment]))
          for (const attachment of uploaded) {
            byId.set(attachment.id, attachment)
          }
          return [...byId.values()]
        })
      }
    } catch (error) {
      setAttachmentErrorForScope(scope, error instanceof Error ? error.message : String(error))
    } finally {
      setAttachmentBusyForScope(scope, false)
    }
  }

  const removeComposerAttachment = (id: string, scope: AttachmentScope = 'chat'): void => {
    const attachment = attachmentsForScope(scope).find((item) => item.id === id)
    if (attachment && ['uploading', 'parsing'].includes(attachment.state ?? '')) void window.workwise.cancelChatAttachmentImport(id)
    updateAttachmentsForScope(scope, (current) => current.filter((attachment) => attachment.id !== id))
  }

  const retryComposerAttachment = async (id: string, scope: AttachmentScope = 'chat'): Promise<void> => {
    const attachment = attachmentsForScope(scope).find((item) => item.id === id)
    if (!attachment?.localSourcePath || !['failed', 'cancelled'].includes(attachment.state ?? '')) return
    let targetThreadId = activeThreadId ?? undefined
    let workspace = threads.find((thread) => thread.id === activeThreadId)?.workspace || workspaceRoot || undefined
    if (scope === 'write') {
      const writeState = useWriteWorkspaceStore.getState()
      workspace = writeState.workspaceRoot || workspaceRoot || undefined
      targetThreadId = await ensureWriteThreadForWorkspace(workspace, writeState.activeFilePath) ?? undefined
      if (!targetThreadId) return
    }
    setAttachmentErrorForScope(scope, null)
    updateAttachmentsForScope(scope, (current) => current.map((item) => item.id === id ? { ...item, state: 'parsing', degradationReasons: [] } : item))
    try {
      const result = await window.workwise.importChatAttachment({ importId: id, sourcePath: attachment.localSourcePath, declaredMimeType: attachment.mimeType, ...(targetThreadId ? { threadId: targetThreadId } : {}), ...(workspace ? { workspace } : {}) })
      updateAttachmentsForScope(scope, (current) => current.map((item) => item.id === id ? { ...result.attachment, managedPath: result.managedPath, localSourcePath: attachment.localSourcePath } : item))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateAttachmentsForScope(scope, (current) => current.map((item) => item.id === id ? { ...item, state: 'failed', degradationReasons: [message] } : item))
      setAttachmentErrorForScope(scope, message)
    }
  }

  const handlePasteClipboardImage = async (options: { silentNoImage?: boolean } = {}): Promise<void> => {
    if (!attachmentUploadEnabled) return
    const scope: AttachmentScope = route === 'write' ? 'write' : 'chat'
    if (typeof window.workwise?.readClipboardImage !== 'function') {
      setAttachmentErrorForScope(scope, t('composerAttachmentUnavailable'))
      return
    }
    const image = await window.workwise.readClipboardImage()
    if (!image.ok) {
      if (options.silentNoImage) return
      setAttachmentErrorForScope(scope, image.message)
      return
    }
    await handlePickAttachments([clipboardImageToFile(image)], scope)
  }

  const sendWritePrompt = async (value: string): Promise<void> => {
    const v = value.trim()
    const attachments = writeAttachments
    if (attachments.some((attachment) => attachment.state && !['ready', 'degraded'].includes(attachment.state))) {
      setWriteAttachmentUploadError('请等待附件解析完成，或移除失败的附件后再发送。')
      return
    }
    if (!v && attachments.length === 0) return
    const requestText = v || '请分析已添加的业务文档，先列出文件结构、关键要求和需要我确认的问题。'
    const initialWriteState = useWriteWorkspaceStore.getState()
    const writeWorkspaceRoot = initialWriteState.workspaceRoot || workspaceRoot
    const inputSnapshot = value
    const quoteSnapshot = initialWriteState.quotedSelections.map((quote) => ({ ...quote }))
    const activeFileSnapshot = initialWriteState.activeFilePath

    let savedCurrentRevision = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const saved = await useWriteWorkspaceStore.getState().flushSave(writeWorkspaceRoot)
      const latest = useWriteWorkspaceStore.getState()
      if (!saved) return
      if (
        latest.activeFilePath === activeFileSnapshot &&
        (latest.activeFileKind !== 'text' || latest.saveStatus === 'saved')
      ) {
        savedCurrentRevision = true
        break
      }
    }
    if (!savedCurrentRevision) {
      useWriteWorkspaceStore.getState().setFileError(t('writeSaveBeforeSendFailed'))
      return
    }

    const savedState = useWriteWorkspaceStore.getState()
    let knowledge: WriteKnowledgeSearchResult | undefined
    if (savedState.knowledgeBase.enabled && typeof window.workwise?.searchWriteKnowledge === 'function') {
      knowledge = await Promise.race([
        window.workwise.searchWriteKnowledge(requestText).catch(() => undefined),
        new Promise<undefined>((resolve) => window.setTimeout(() => resolve(undefined), 4_000))
      ])
    }
    const prompt = composeWritePrompt(requestText, quoteSnapshot, {
      workspaceRoot: writeWorkspaceRoot,
      activeFilePath: savedState.activeFilePath,
      contentHash: writeContentHash(savedState.fileContent),
      saveRevision: savedState.saveRevision
    }, knowledge)
    const threadId = await ensureWriteThreadForWorkspace(writeWorkspaceRoot, savedState.activeFilePath)
    if (!threadId) return

    inputRef.current = ''
    setInput('')
    const model = savedState.assistantModel.trim()
    const reasoningEffort = composerReasoningEffortRequestValue(composerReasoningEffort)
    const attachmentIds = attachments.map((attachment) => attachment.id)
    const sent = await sendMessage(prompt, mode === 'plan' ? 'plan' : 'agent', {
      ...(model ? { model } : {}),
      providerId: savedState.assistantProviderId,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(attachmentIds.length ? { attachmentIds, attachments } : {})
    })
    if (!sent) {
      if (!inputRef.current.trim()) setInput(inputSnapshot)
      return
    }
    setWriteAttachments([])
    setWriteAttachmentUploadError(null)
    const currentQuoteIds = new Set(useWriteWorkspaceStore.getState().quotedSelections.map((quote) => quote.id))
    for (const quote of quoteSnapshot) {
      if (currentQuoteIds.has(quote.id)) useWriteWorkspaceStore.getState().removeQuotedSelection(quote.id)
    }
  }

  const createSddAssistantThreadForDraft = async (draft: SddDraft): Promise<string | null> => {
    const normalizedWorkspace = normalizeWorkspaceRoot(draft.workspaceRoot)
    if (!normalizedWorkspace) {
      setError(t('workspaceRequiredToCreateThread'))
      return null
    }
    if (runtimeConnection !== 'ready') {
      setError(t('runtimeActionNeedsConnection'))
      return null
    }
    try {
      const provider = getProvider()
      const thread = await provider.createThread({
        workspace: normalizedWorkspace,
        title: t('sddAssistant'),
        mode: 'agent'
      })
      const normalizedThread = {
        ...thread,
        workspace: normalizeWorkspaceRoot(thread.workspace) || normalizedWorkspace
      }
      markSddAssistantThread(draft, normalizedThread.id)
      useChatStore.setState((state) => ({
        activeThreadId: normalizedThread.id,
        threads: state.threads.some((item) => item.id === normalizedThread.id)
          ? state.threads
          : [normalizedThread, ...state.threads]
      }))
      setRoute('write')
      await selectThread(normalizedThread.id)
      void useChatStore.getState().refreshThreads()
      return normalizedThread.id
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  const ensureSddAssistantThreadForDraft = async (draft: SddDraft): Promise<string | null> => {
    const registeredThreadId = sddAssistantThreadIdForDraft(draft)
    if (registeredThreadId) {
      setRoute('write')
      if (useChatStore.getState().activeThreadId !== registeredThreadId) {
        await selectThread(registeredThreadId)
      }
      if (useChatStore.getState().activeThreadId === registeredThreadId) {
        return registeredThreadId
      }
    }
    return createSddAssistantThreadForDraft(draft)
  }

  const openSddRequirementDraft = async (
    draft: SddDraft,
    content: string,
    options: {
      lastSavedContent?: string
      saveStatus?: SddDraftSaveStatus
      openAssistant?: boolean
    } = {}
  ): Promise<boolean> => {
    useSddDraftStore.getState().setActiveDraft(draft, content, {
      lastSavedContent: options.lastSavedContent,
      saveStatus: options.saveStatus
    })
    dismissedSddDraftWorkspacesRef.current.delete(normalizeWorkspaceRoot(draft.workspaceRoot))
    setInput('')
    setMode('agent')
    setRoute('write')
    if (options.openAssistant ?? runtimeConnection === 'ready') {
      setRightSidebarWidth((width) => Math.max(width, 420))
      const sddThreadId = await ensureSddAssistantThreadForDraft(draft)
      if (sddThreadId) {
        setRightPanelMode('sdd-ai')
      } else {
        setRightPanelMode(null)
      }
    } else {
      setRightPanelMode(null)
    }
    return true
  }

  const dismissActiveSddDraft = (options: { closeAssistant?: boolean } = {}): void => {
    const draft = useSddDraftStore.getState().activeDraft
    if (draft) {
      dismissedSddDraftWorkspacesRef.current.add(normalizeWorkspaceRoot(draft.workspaceRoot))
      void saveActiveSddDraftToDisk()
      useSddDraftStore.getState().clearActiveDraft()
    }
    if (options.closeAssistant && rightPanelMode === 'sdd-ai') setRightPanelMode(null)
  }

  const toggleSddAssistantPanel = async (): Promise<void> => {
    if (rightPanelMode === 'sdd-ai') {
      setRightPanelMode(null)
      return
    }
    const draft = useSddDraftStore.getState().activeDraft
    if (!draft) return
    setRightSidebarWidth((width) => Math.max(width, 420))
    const threadId = await ensureSddAssistantThreadForDraft(draft)
    if (!threadId) return
    setRightPanelMode('sdd-ai')
  }

  const startNewSddRequirement = async (): Promise<void> => {
    let targetWorkspace = normalizeWorkspaceRoot(activeWriteWorkspaceRoot)
    if (!targetWorkspace) {
      await openWrite()
      targetWorkspace = normalizeWorkspaceRoot(useWriteWorkspaceStore.getState().workspaceRoot)
    }
    if (!targetWorkspace) {
      setError(t('workspaceRequiredToCreateThread'))
      return
    }
    const restored = await restoreRememberedSddDraft({
      workspaceRoot: targetWorkspace,
      readWorkspaceFile: window.workwise.readWorkspaceFile
    })
    if (restored.kind === 'restored') {
      await openSddRequirementDraft(restored.draft, restored.content, {
        lastSavedContent: restored.lastSavedContent,
        saveStatus: restored.saveStatus
      })
      return
    }

    const draftUuid = globalThis.crypto?.randomUUID?.() ?? `draft-${Date.now()}`
    const draft = createSddDraft({ id: draftUuid, workspaceRoot: targetWorkspace })
    const initialContent = [
      `# ${t('sddUntitledRequirement')}`,
      '',
      `## ${t('sddTemplateBackground')}`,
      '',
      `## ${t('sddTemplateGoal')}`,
      '',
      `## ${t('sddTemplateAcceptance')}`,
      ''
    ].join('\n')
    const result = await window.workwise.createWorkspaceFile({
      workspaceRoot: targetWorkspace,
      path: draft.relativePath,
      content: initialContent
    })
    if (!result.ok) {
      setError(result.message)
      return
    }
    const activeDraft = { ...draft, absolutePath: result.path }
    await openSddRequirementDraft(activeDraft, initialContent)
  }

  useEffect(() => {
    if (route !== 'write' || activeSddDraft) return
    const targetWorkspace = normalizeWorkspaceRoot(activeWriteWorkspaceRoot || workspaceRoot)
    if (!targetWorkspace || dismissedSddDraftWorkspacesRef.current.has(targetWorkspace)) return
    if (restoredSddDraftWorkspaceRef.current === targetWorkspace) return

    let cancelled = false
    restoredSddDraftWorkspaceRef.current = targetWorkspace
    void restoreRememberedSddDraft({
      workspaceRoot: targetWorkspace,
      readWorkspaceFile: window.workwise.readWorkspaceFile
    }).then((restored) => {
      if (cancelled || restored.kind !== 'restored') return
      if (useSddDraftStore.getState().activeDraft) return
      useSddDraftStore.getState().setActiveDraft(restored.draft, restored.content, {
        lastSavedContent: restored.lastSavedContent,
        saveStatus: restored.saveStatus
      })
      dismissedSddDraftWorkspacesRef.current.delete(targetWorkspace)
      setInput('')
      setMode('agent')
      setRoute('write')
      setRightPanelMode(null)
    })

    return () => {
      cancelled = true
    }
  }, [activeSddDraft, activeWriteWorkspaceRoot, route, setRightPanelMode, setRoute, workspaceRoot])

  const sendSddAssistantPrompt = async (value: string): Promise<void> => {
    const v = value.trim()
    const draft = useSddDraftStore.getState().activeDraft
    if (!v || !draft) return
    const threadId = await ensureSddAssistantThreadForDraft(draft)
    if (!threadId) return
    const snapshot = useSddDraftStore.getState()
    void saveActiveSddDraftToDisk()
    const prompt = composeSddAssistantPrompt({
      userPrompt: v,
      draftMarkdown: snapshot.content,
      draftRelativePath: draft.relativePath,
      workspaceRoot: draft.workspaceRoot
    })
    setInput('')
    const model = writeAssistantModel.trim()
    const reasoningEffort = composerReasoningEffortRequestValue(composerReasoningEffort)
    const sent = await sendMessage(prompt, mode === 'plan' ? 'plan' : 'agent', {
      displayText: v,
      ...(model ? { model } : {}),
      providerId: writeAssistantProviderId,
      ...(reasoningEffort ? { reasoningEffort } : {})
    })
    if (!sent) setInput(v)
  }

  const uploadSddImagesAsAttachments = async (
    images: SddDraftImageReference[],
    threadId: string,
    workspace: string
  ): Promise<{ images: SddDraftImageReference[]; attachmentIds: string[] }> => {
    const provider = getProvider()
    const attachmentCapabilities = runtimeInfo?.capabilities.attachments
    if (!attachmentCapabilities || typeof provider.uploadAttachment !== 'function') {
      throw new Error(t('composerAttachmentUnavailable'))
    }
    const attachmentIds: string[] = []
    for (const image of images) {
      const file = base64ImageToFile(image)
      const prepared = await prepareImageAttachmentUpload(file, attachmentCapabilities)
      const attachment = await provider.uploadAttachment({
        name: fileNameFromPath(image.relativePath),
        mimeType: prepared.mimeType,
        dataBase64: prepared.dataBase64,
        textFallback: prepared.textFallback,
        threadId,
        workspace
      })
      attachmentIds.push(attachment.id)
    }
    return { images: withAttachmentIds(images, attachmentIds), attachmentIds }
  }

  const handleSddNextStep = async (): Promise<void> => {
    const snapshot = useSddDraftStore.getState()
    const draft = snapshot.activeDraft
    if (!draft) return
    if (sddUpgradeInFlightRef.current || snapshot.operationStatus === 'upgrading') return
    if (!snapshot.content.trim()) {
      useSddDraftStore.getState().setOperationStatus('error', t('sddEmptyDraftError'))
      return
    }
    const chatSnapshot = useChatStore.getState()
    if (chatSnapshot.busy || chatSnapshot.blocks.some(hasPendingRuntimeWork)) {
      setError(t('composerQueuePlaceholder'))
      return
    }
    if (chatSnapshot.runtimeConnection !== 'ready') {
      setError(t('runtimeActionNeedsConnection'))
      return
    }
    sddUpgradeInFlightRef.current = true
    useSddDraftStore.getState().setOperationStatus('upgrading')
    const saved = await saveActiveSddDraftToDisk()
    if (!saved) {
      sddUpgradeInFlightRef.current = false
      useSddDraftStore.getState().setOperationStatus('error', useSddDraftStore.getState().error)
      return
    }

    const threadId = await ensureSddAssistantThreadForDraft(draft)
    if (!threadId) {
      sddUpgradeInFlightRef.current = false
      useSddDraftStore.getState().setOperationStatus('idle')
      return
    }

    const collected = await collectSddDraftImages({
      markdown: useSddDraftStore.getState().content,
      draftRelativePath: draft.relativePath,
      workspaceRoot: draft.workspaceRoot
    })
    if (collected.errors.length > 0) {
      sddUpgradeInFlightRef.current = false
      useSddDraftStore.getState().setOperationStatus('error', collected.errors.join('\n'))
      return
    }

    const supportsImageAttachments =
      collected.images.length > 0 &&
      runtimeInfo?.capabilities.model.inputModalities.includes('image') === true &&
      runtimeInfo.capabilities.attachments.available === true &&
      typeof getProvider().uploadAttachment === 'function'

    let imagesForPrompt = collected.images
    let attachmentIds: string[] = []
    let imageMode: 'attachments' | 'unavailable' | 'none' =
      collected.images.length === 0 ? 'none' : 'unavailable'

    if (supportsImageAttachments) {
      try {
        const uploaded = await uploadSddImagesAsAttachments(collected.images, threadId, draft.workspaceRoot)
        imagesForPrompt = uploaded.images
        attachmentIds = uploaded.attachmentIds
        imageMode = 'attachments'
      } catch (error) {
        sddUpgradeInFlightRef.current = false
        useSddDraftStore.getState().setOperationStatus(
          'error',
          error instanceof Error ? error.message : String(error)
        )
        return
      }
    }

    const latestDraftContent = useSddDraftStore.getState().content
    const planRelativePath = sddDraftPlanRelativePath(draft)
    const planId = buildGuiPlanId(draft.workspaceRoot, planRelativePath)
    const sourceRequest = sddDraftSourceRequest(latestDraftContent, draft.relativePath)
    const assistantContext = sddAssistantContextFromBlocks(blocks)
    const prompt = buildSddDraftToPlanPrompt({
      draftMarkdown: latestDraftContent,
      draftRelativePath: draft.relativePath,
      planRelativePath,
      assistantContext,
      workspaceRoot: draft.workspaceRoot,
      images: imagesForPrompt,
      imageMode
    })
    sddUpgradeTargetRef.current = {
      planId,
      relativePath: planRelativePath,
      workspaceRoot: draft.workspaceRoot
    }
    setMode('plan')
    const sent = await sendPlanTurn(prompt, {
      displayText: t('sddGeneratePlanAction'),
      workspaceRoot: draft.workspaceRoot,
      guiPlan: {
        operation: 'draft',
        workspaceRoot: draft.workspaceRoot,
        relativePath: planRelativePath,
        planId,
        sourceRequest
      },
      ...(attachmentIds.length ? { attachmentIds } : {})
    })
    if (!sent) {
      sddUpgradeInFlightRef.current = false
      sddUpgradeTargetRef.current = null
      useSddDraftStore.getState().setOperationStatus('idle')
      return
    }
    // Baseline the trace snapshot so later draft edits can be detected as
    // requirement drift against the plan that is about to be generated.
    const tracePath = sddDraftTraceRelativePath(draft.relativePath)
    if (tracePath) {
      await window.workwise
        .writeWorkspaceFile({
          workspaceRoot: draft.workspaceRoot,
          path: tracePath,
          content: JSON.stringify(
            buildSddTraceSnapshot(latestDraftContent, planRelativePath),
            null,
            2
          )
        })
        .catch(() => undefined)
    }
  }

  const readComposerFileContextEntries = async (
    references: ComposerWorkspaceReference[],
    workspace: string
  ): Promise<ComposerFileContextEntry[]> => {
    const entries: ComposerFileContextEntry[] = []
    let remainingChars = COMPOSER_FILE_CONTEXT_MAX_TOTAL_CHARS
    for (const reference of references) {
      if (remainingChars <= 0) break
      const result = await window.workwise.readWorkspaceFile({
        workspaceRoot: workspace,
        path: reference.relativePath
      })
      if (!result.ok) {
        throw new Error(t('composerFileReadFailed', {
          path: reference.relativePath,
          message: result.message
        }))
      }
      const clipped = clipComposerFileContext(result.content, remainingChars, result.truncated)
      remainingChars -= clipped.consumed
      entries.push({
        relativePath: reference.relativePath,
        content: clipped.content,
        ...(clipped.truncated ? { truncated: true } : {})
      })
    }
    return entries
  }

  const handleSend = (): void => {
    void handleSendAsync()
  }

  const handleSendAsync = async (): Promise<void> => {
    const v = input.trim()
    const attachments = route === 'chat' ? composerAttachments : []
    if (attachments.some((attachment) => attachment.state && !['ready', 'degraded'].includes(attachment.state))) {
      setAttachmentUploadError('请等待附件解析完成，或移除失败的附件后再发送。')
      return
    }
    const attachmentIds = attachments.map((attachment) => attachment.id)
    const fileReferences = route === 'chat' ? composerFileReferences : []
    const reasoningEffort = composerReasoningEffortRequestValue(composerReasoningEffort)
    if (
      !v &&
      attachmentIds.length === 0 &&
      fileReferences.length === 0 &&
      !(route === 'write' && writeAttachments.length > 0)
    ) return
    const emptyPrompt =
      fileReferences.length > 0 && attachmentIds.length > 0
        ? t('composerFileAndImageOnlyPrompt')
        : fileReferences.length > 0
          ? t('composerFileOnlyPrompt')
          : t('composerImageOnlyPrompt')
    const emptyDisplayText = v
      ? undefined
      : fileReferences.length > 0 && attachmentIds.length > 0
        ? t('composerFileAndImageOnlyDisplay', { count: fileReferences.length })
        : fileReferences.length > 0
          ? t('composerFileOnlyDisplay', { count: fileReferences.length })
          : t('composerImageOnlyDisplay')
    const messageText = v || emptyPrompt
    const prepareChatMessage = async (): Promise<{
      text: string
      displayText?: string
      workspaceReferences?: Array<{ path: string; kind: 'file' | 'directory' }>
    } | null> => {
      if (fileReferences.length === 0) {
        return {
          text: messageText,
          ...(emptyDisplayText ? { displayText: emptyDisplayText } : {})
        }
      }
      const workspace = normalizeWorkspaceRoot(
        threads.find((thread) => thread.id === activeThreadId)?.workspace || workspaceRoot
      )
      if (!workspace) {
        setError(t('workspaceRequiredToCreateThread'))
        return null
      }
      const displayText = v || emptyDisplayText
      const structuredReferences = runtimeWorkspaceReferences(activeThreadId, fileReferences, {
        allowLegacyInlineContext: import.meta.env.VITE_WORKWISE_LEGACY_INLINE_FILE_CONTEXT === '1',
        legacyIndexFallback: composerLegacyInlineFallbackKeys.length > 0
      })
      if (structuredReferences) {
        return {
          text: messageText,
          ...(displayText ? { displayText } : {}),
          workspaceReferences: structuredReferences
        }
      }
      try {
        const fileContext = await readComposerFileContextEntries(fileReferences, workspace)
        return {
          text: buildComposerFileContextPrompt(messageText, fileContext),
          ...(displayText ? { displayText } : {})
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error))
        return null
      }
    }

    if (activeSddDraft && rightPanelMode === 'sdd-ai') {
      void sendSddAssistantPrompt(v)
      return
    }
    const planCommand = parseGuiPlanCommand(v)
    if (planCommand) {
      setInput('')
      void handleGuiPlanCommand(planCommand.kind === 'create' ? planCommand.request : undefined)
      return
    }
    if (route === 'chat' && mode === 'plan') {
      const prepared = await prepareChatMessage()
      if (!prepared) return
      const sent = await sendPlanTurn(prepared.text, {
        ...(prepared.displayText ? { displayText: prepared.displayText } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(prepared.workspaceReferences?.length
          ? { workspaceReferences: prepared.workspaceReferences }
          : {}),
        ...(attachmentIds.length ? { attachmentIds, attachments } : {})
      })
      clearComposerDraftAfterSuccessfulSend(sent, {
        clearInput: () => setInput(''),
        clearAttachments: clearComposerAttachments,
        clearFileReferences: clearComposerFileReferences
      })
      return
    }
    if (route === 'write') {
      await sendWritePrompt(v)
      return
    }
    if (route === 'claw') {
      const command = parseClawCommand(v)
      if (command?.kind === 'clear') {
        if (!activeClawChannelId) {
          setError(t('clawNoActiveIm'))
          return
        }
        setInput('')
        void (async () => {
          await resetClawChannelSession(activeClawChannelId)
          const replyText = t('clawNewSessionStarted')
          appendLocalClawTurn(v, replyText)
          await mirrorClawCommand(v, replyText)
        })()
        return
      }
      if (command?.kind === 'help') {
        setInput('')
        const replyText = clawHelpText()
        appendLocalClawTurn(v, replyText)
        void mirrorClawCommand(v, replyText)
        return
      }
      if (command?.kind === 'model') {
        if (!activeClawChannelId) {
          setError(t('clawNoActiveIm'))
          return
        }
        setInput('')
        void (async () => {
          await setClawChannelModel(activeClawChannelId, command.model)
          const replyText = t('clawModelChanged', { model: command.model })
          appendLocalClawTurn(v, replyText)
          await mirrorClawCommand(v, replyText)
        })()
        return
      }
      if (command?.kind === 'showModel') {
        if (!activeClawChannelId) {
          setError(t('clawNoActiveIm'))
          return
        }
        setInput('')
        const replyText = t('clawModelCurrent', {
          model: activeClawChannel?.model ?? 'auto'
        })
        appendLocalClawTurn(v, replyText)
        void mirrorClawCommand(v, replyText)
        return
      }
      if (command?.kind === 'invalidModel') {
        setError(t('clawModelCommandHint'))
        return
      }
      if (!activeClawChannelId) {
        setError(t('clawNoActiveIm'))
        return
      }
      setInput('')
      void (async () => {
        const taskResult = typeof window.workwise?.createClawTaskFromText === 'function'
          ? await window.workwise.createClawTaskFromText(v, {
              channelId: activeClawChannelId,
              modelHint: activeClawChannel?.model,
              mode
            })
          : { kind: 'noop' as const }
        if (taskResult.kind === 'created') {
          appendLocalClawTurn(v, taskResult.confirmationText)
          await mirrorClawCommand(v, taskResult.confirmationText)
          return
        }
        if (taskResult.kind === 'error') {
          appendLocalClawTurn(v, `Failed to create scheduled task: ${taskResult.message}`)
          return
        }
        if (!activeThreadId) {
          await selectClawChannel(activeClawChannelId)
          await useChatStore.getState().sendMessage(v, mode === 'plan' ? 'plan' : 'agent', {
            ...(reasoningEffort ? { reasoningEffort } : {})
          })
          return
        }
        await sendMessage(v, mode === 'plan' ? 'plan' : 'agent', {
          ...(reasoningEffort ? { reasoningEffort } : {})
        })
      })()
      return
    }
    const prepared = await prepareChatMessage()
    if (!prepared) return
    const sent = await sendMessage(prepared.text, mode === 'plan' ? 'plan' : 'agent', {
      ...(prepared.displayText ? { displayText: prepared.displayText } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(prepared.workspaceReferences?.length
        ? { workspaceReferences: prepared.workspaceReferences }
        : {}),
      ...(attachmentIds.length ? { attachmentIds, attachments } : {})
    })
    clearComposerDraftAfterSuccessfulSend(sent, {
      clearInput: () => setInput(''),
      clearAttachments: clearComposerAttachments,
      clearFileReferences: clearComposerFileReferences
    })
  }

  const openThread = (id: string): void => {
    if (activeSddDraft) dismissActiveSddDraft({ closeAssistant: true })
    setConnectPhoneSidebarOpen(false)
    const selectedThread = threads.find((thread) => thread.id === id)
    if (selectedThread && isDesignAssistantThread(selectedThread)) {
      const documentId = designDocumentIdForAssistantThread(selectedThread.id)
      if (documentId) requestDesignDocumentOpen(documentId)
      setRoute('design')
      void selectThread(id)
      return
    }
    if (selectedThread?.domain === 'engineering') {
      setRoute('engineering')
      void selectThread(id)
      return
    }
    setRoute('chat')
    void selectThread(id)
  }

  const notificationOpenThreadRef = useRef(openThread)
  notificationOpenThreadRef.current = (threadId) => {
    pendingNotificationThreadRef.current = threadId
    if (runtimeConnection !== 'ready') return
    pendingNotificationThreadRef.current = null
    openThread(threadId)
  }

  useEffect(() => {
    if (runtimeConnection !== 'ready') return
    const threadId = pendingNotificationThreadRef.current
    if (!threadId) return
    notificationOpenThreadRef.current(threadId)
  }, [runtimeConnection])

  useEffect(() => {
    if (typeof window.workwise?.onNotificationOpenThread !== 'function') return
    return window.workwise.onNotificationOpenThread((threadId) => {
      if (!threadId.trim()) return
      notificationOpenThreadRef.current(threadId)
    })
  }, [])

  const startNewChat = (): void => {
    if (activeSddDraft) dismissActiveSddDraft({ closeAssistant: true })
    setConnectPhoneSidebarOpen(false)
    setRoute('chat')
    void createThread()
  }

  const startNewChatInWorkspace = (workspaceRoot: string): void => {
    if (activeSddDraft) dismissActiveSddDraft({ closeAssistant: true })
    setConnectPhoneSidebarOpen(false)
    setRoute('chat')
    void createThread({ workspaceRoot })
  }

  const openCodeMode = (): void => {
    setConnectPhoneSidebarOpen(false)
    void openCode()
  }

  const openWriteMode = (): void => {
    setConnectPhoneSidebarOpen(false)
    void openWrite()
  }

  const openEngineeringMode = (): void => {
    setConnectPhoneSidebarOpen(false)
    openEngineering()
  }

  const openPluginsView = (): void => {
    setConnectPhoneSidebarOpen(false)
    openPlugins(sidebarView === 'claw' ? 'claw' : 'chat')
  }

  const openScheduleView = (): void => {
    setConnectPhoneSidebarOpen(false)
    openSchedule()
  }

  const openFlowView = (): void => {
    setConnectPhoneSidebarOpen(false)
    openFlow()
  }

  const openDesignView = (): void => {
    setConnectPhoneSidebarOpen(false)
    openDesign()
  }

  const toggleFocusMode = (): void => {
    setFocusModeEnabled((enabled) => {
      const next = !enabled
      writeFocusModePreference(next)
      return next
    })
  }

  const toggleConnectPhone = (): void => {
    if (activeSddDraft) dismissActiveSddDraft({ closeAssistant: true })
    openClaw()
    setConnectPhoneSidebarOpen((open) => !open)
  }

  const sidebarView: 'chat' | 'write' | 'claw' | 'schedule' | 'design' | 'flow' | 'engineering' =
    route === 'claw' || (route === 'plugins' && pluginHostRoute === 'claw')
      ? 'claw'
      : route === 'schedule'
        ? 'schedule'
      : route === 'flow'
        ? 'flow'
      : route === 'write'
        ? 'write'
      : route === 'design'
        ? 'design'
      : route === 'engineering'
        ? 'engineering'
      : 'chat'

  const closeRightPanel = (): void => {
    if (route === 'write' && rightPanelMode === 'sdd-ai') {
      setRightPanelMode(null)
      return
    }
    if (route === 'write') {
      setWriteAssistantOpen(false)
      return
    }
    setRightPanelMode(null)
    setFilePreviewTarget(null)
  }

  const startNewWriteAssistantConversation = (): void => {
    const writeState = useWriteWorkspaceStore.getState()
    const writeWorkspaceRoot = writeState.workspaceRoot || workspaceRoot
    setInput('')
    setWriteAttachments([])
    setWriteAttachmentUploadError(null)
    writeState.clearQuotedSelections()
    void createWriteThread(writeWorkspaceRoot, writeState.activeFilePath)
  }

  const renderRuntimeBanner = (message: string, detail?: string | null): ReactElement => (
    <RuntimeBanner
      message={message}
      detail={detail}
      logPath={runtimeLogPath || null}
      runtimeReady={runtimeConnection === 'ready'}
      stageInsetClass={stageInsetClass}
      t={t}
      onOpenLogDir={
        typeof window !== 'undefined' && typeof window.workwise?.openLogDir === 'function'
          ? () => window.workwise.openLogDir()
          : undefined
      }
      onOpenSettings={() => openSettings('agents')}
      onRetryConnection={() => void probeRuntime('user')}
    />
  )

  const writeRuntimeBannerMessage = runtimeConnection !== 'ready'
    ? (error?.trim() || t('writeRuntimeUnavailable'))
    : null

  const resolvedRightPanelId = builtinRightPanels.resolveTab({
    mode: rightPanelMode,
    route,
    activeSddDraft: Boolean(activeSddDraft),
    writeAssistantOpen
  })?.id ?? rightPanelMode
  const resolvedWorkbenchViewId = builtinWorkbenchViews.resolveTab({ route })?.id ?? null

  useEffect(() => {
    if (!rightPanelVisible || !resolvedRightPanelId) return
    return builtinRightPanels.activateTab(resolvedRightPanelId, {
      mode: rightPanelMode,
      route,
      activeSddDraft: Boolean(activeSddDraft),
      writeAssistantOpen
    })
  }, [activeSddDraft, resolvedRightPanelId, rightPanelMode, rightPanelVisible, route, writeAssistantOpen])

  useEffect(() => {
    if (!resolvedWorkbenchViewId) return
    return builtinWorkbenchViews.activateTab(resolvedWorkbenchViewId, { route })
  }, [resolvedWorkbenchViewId, route])

  const rightPanelRenderers: Record<string, (module: unknown) => ReactElement | null> = {
    'sdd-ai': (module) => {
      const Panel = (module as typeof import('./sdd/SddAssistantPanel')).SddAssistantPanel
      return activeSddDraft ? (
        <Panel
          draft={activeSddDraft}
          input={input}
          setInput={setInput}
          mode={mode}
          setMode={setMode}
          busy={busy}
          runtimeConnection={runtimeConnection}
          activeThreadId={activeThreadId}
          blocks={blocks}
          liveReasoning={liveReasoning}
          liveAssistant={liveAssistant}
          composerModel={writeAssistantModel}
          composerProviderId={writeAssistantProviderId}
          composerPickList={writeAssistantPickList}
          composerModelGroups={composerModelGroups}
          composerReasoningEffort={composerReasoningEffort}
          setComposerModel={setWriteAssistantModel}
          setComposerReasoningEffort={setComposerReasoningEffort}
          queuedMessages={queuedMessages}
          removeQueuedMessage={removeQueuedMessage}
          onSend={handleSend}
          onInterrupt={(options) => void interrupt(options)}
          onRetryConnection={() => void probeRuntime('user')}
          onOpenSettings={() => openSettings('agents')}
          onNewConversation={() => {
            setInput('')
            void createSddAssistantThreadForDraft(activeSddDraft)
          }}
          onCollapse={closeRightPanel}
          className="h-full max-h-full w-full"
        />
      ) : null
    },
    'write-assistant': (module) => {
      const Panel = (module as typeof import('./write/WriteAssistantPanel')).WriteAssistantPanel
      return (
        <Panel
          input={input}
          setInput={setInput}
          mode={mode}
          setMode={setMode}
          busy={busy}
          runtimeConnection={runtimeConnection}
          activeThreadId={activeThreadId}
          blocks={blocks}
          liveReasoning={liveReasoning}
          liveAssistant={liveAssistant}
          composerModel={writeAssistantModel}
          composerProviderId={writeAssistantProviderId}
          composerPickList={writeAssistantPickList}
          composerModelGroups={composerModelGroups}
          composerReasoningEffort={composerReasoningEffort}
          setComposerModel={setWriteAssistantModel}
          setComposerReasoningEffort={setComposerReasoningEffort}
          queuedMessages={queuedMessages}
          removeQueuedMessage={removeQueuedMessage}
          attachments={writeAttachments}
          attachmentUploadEnabled={attachmentUploadEnabled}
          attachmentUploadBusy={writeAttachmentUploadBusy}
          attachmentUploadError={writeAttachmentUploadError}
          onPickAttachments={(files) => void handlePickAttachments(files, 'write')}
          onPasteClipboardImage={(options) => void handlePasteClipboardImage(options)}
          onRemoveAttachment={(id) => removeComposerAttachment(id, 'write')}
          onRetryAttachment={(id) => void retryComposerAttachment(id, 'write')}
          onSend={handleSend}
          onInterrupt={(options) => void interrupt(options)}
          onRetryConnection={() => void probeRuntime('user')}
          onOpenSettings={() => openSettings('agents')}
          onNewConversation={startNewWriteAssistantConversation}
          onCollapse={closeRightPanel}
          className="h-full max-h-full w-full"
        />
      )
    },
    changes: (module) => {
      const Panel = (module as typeof import('./ChangeInspector')).ChangeInspector
      return <Panel blocks={blocks} className="h-full max-h-full w-full flex-col" onCollapse={closeRightPanel} />
    },
    todo: (module) => {
      const Panel = (module as typeof import('./todo/TodoPanel')).TodoPanel
      return <Panel className="h-full max-h-full w-full" onCollapse={closeRightPanel} onOpenPlan={openGuiPlanPanel} />
    },
    browser: (module) => {
      const Panel = (module as typeof import('./DevBrowserPanel')).DevBrowserPanel
      return <Panel blocks={devPreviewBlocks} preferredUrl={latestDevPreviewUrl} className="h-full max-h-full w-full flex-col" onCollapse={closeRightPanel} />
    },
    plan: (module) => {
      const Panel = (module as typeof import('./plan/PlanPanel')).PlanPanel
      return <Panel workspaceRoot={workspaceRoot} activeThreadId={activeThreadId} runtimeReady={runtimeConnection === 'ready'} busy={busy} className="h-full max-h-full w-full" onCollapse={closeRightPanel} onBuildPlan={() => void buildGuiPlan()} onVerifyPlan={() => void verifyGuiPlan()} onReplanChanged={(ids) => void replanChangedRequirements(ids)} />
    },
    file: (module) => {
      const Panel = (module as typeof import('./WorkspaceFilePreviewPanel')).WorkspaceFilePreviewPanel
      return <Panel target={filePreviewTarget} workspaceRoot={workspaceRoot} className="h-full max-h-full w-full" onClose={closeRightPanel} />
    }
  }

  const renderRightPanel = (): ReactElement | null => {
    if (!rightPanelVisible || !resolvedRightPanelId) return null
    const context: BuiltinRightPanelContext = {
      mode: rightPanelMode,
      route,
      activeSddDraft: Boolean(activeSddDraft),
      writeAssistantOpen,
      renderers: rightPanelRenderers
    }
    return (
      <>
        <div
          role="separator"
          aria-orientation="vertical"
          className="ds-workbench-right-divider ds-workbench-divider ds-no-drag relative z-20 shrink-0 cursor-col-resize"
          onPointerDown={beginRightResize}
        />
        <div className="ds-workbench-right-panel h-full min-h-0 shrink-0" style={{ width: rightSidebarWidth }}>
          <WorkbenchPanelLoader
            registry={builtinRightPanels}
            panelId={resolvedRightPanelId}
            context={context}
            title={t('workbenchPanelErrorTitle')}
            retryLabel={t('workbenchPanelRetry')}
            fallback={<div className="h-full w-full bg-ds-sidebar" />}
          />
        </div>
      </>
    )
  }

  const workbenchViewRenderers: Record<string, (module: unknown) => ReactElement | null> = {
    plugins: (module) => {
      const View = (module as typeof import('./PluginMarketplaceView')).PluginMarketplaceView
      return (
        <>
          <div className="ds-no-drag shrink-0 px-4 pt-4">
            <SidebarTitlebarToggleButton
              onClick={toggleLeftSidebar}
              title={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
              ariaLabel={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')}
            />
          </div>
          <View />
        </>
      )
    },
    flow: (module) => {
      const View = (module as typeof import('./flow/FlowWorkspaceView')).FlowWorkspaceView
      return <View leftSidebarCollapsed={leftSidebarCollapsed} onToggleLeftSidebar={toggleLeftSidebar} filter={flowFilter} />
    },
    schedule: (module) => {
      const View = (module as typeof import('./schedule/ScheduleTasksView')).ScheduleTasksView
      return <View leftSidebarCollapsed={leftSidebarCollapsed} onToggleLeftSidebar={toggleLeftSidebar} onOpenThread={openThread} onOpenFlow={() => openFlow('scheduled')} />
    },
    design: (module) => {
      const View = (module as typeof import('./design/DesignWorkspaceView')).DesignWorkspaceView
      return <View leftSidebarCollapsed={leftSidebarCollapsed} onToggleLeftSidebar={toggleLeftSidebar} onOpenWrite={openWriteMode} workspaceRoot={workspaceRoot} />
    },
    engineering: (module) => {
      const View = (module as typeof import('./engineering/EngineeringWorkspaceView')).EngineeringWorkspaceView
      return <View leftSidebarCollapsed={leftSidebarCollapsed} onToggleLeftSidebar={toggleLeftSidebar} workspaceRoot={workspaceRoot} runtimeReady={runtimeConnection === 'ready'} />
    }
  }
  const workbenchViewContext: BuiltinWorkbenchViewContext = { route, renderers: workbenchViewRenderers }

  /*
   * The registry owns view selection and descriptor rendering. The loader
   * below is the only registered-view mount point.
   */
  return (
    <div
      ref={shellRef}
      className="ds-workbench-shell ds-drag relative flex h-full min-h-0 w-full min-w-0 bg-ds-main"
    >
      {!leftSidebarCollapsed ? (
        <>
          <div className="ds-workbench-left-panel min-h-0 shrink-0" style={{ width: leftSidebarWidth }}>
            {route === 'write' ? (
              <WriteSidebar
                navigationRoute={route}
                connectPhoneSidebarOpen={connectPhoneSidebarOpen}
                focusModeEnabled={focusModeEnabled}
                onCodeOpen={openCodeMode}
                onEngineeringOpen={openEngineeringMode}
                onWriteOpen={openWriteMode}
                onOpenPlugins={openPluginsView}
                onScheduleOpen={openScheduleView}
                onFlowOpen={openFlowView}
                onDesignOpen={openDesignView}
                onNewRequirement={() => void startNewSddRequirement()}
                onOpenSettings={(section) => openSettings(section)}
                onToggleFocusMode={toggleFocusMode}
                onToggleConnectPhone={toggleConnectPhone}
                onToggleSidebar={toggleLeftSidebar}
              />
            ) : (
            <Sidebar
              threads={codeThreads}
              activeThreadId={activeThreadId}
              activeView={sidebarView}
              navigationRoute={route}
              connectPhoneSidebarOpen={connectPhoneSidebarOpen}
              focusModeEnabled={focusModeEnabled}
              runtimeReady={runtimeConnection === 'ready'}
              threadSearch={threadSearch}
              showArchivedThreads={showArchivedThreads}
              onThreadSearchChange={setThreadSearch}
              onShowArchivedThreadsChange={setShowArchivedThreads}
              onSelectThread={openThread}
              onRenameThread={renameThread}
              onArchiveThread={(id) => archiveThread(id, true)}
              onDeleteThread={deleteThread}
              onRestoreThread={(id) => archiveThread(id, false)}
              onNewChat={startNewChat}
              onNewChatInWorkspace={startNewChatInWorkspace}
              onOpenSettings={(section) => openSettings(section)}
              onOpenPlugins={openPluginsView}
              onToggleConnectPhone={toggleConnectPhone}
              onCodeOpen={openCodeMode}
              onWriteOpen={openWriteMode}
              onToggleFocusMode={toggleFocusMode}
              onScheduleOpen={openScheduleView}
              onFlowOpen={openFlowView}
              onDesignOpen={openDesignView}
              onEngineeringOpen={openEngineeringMode}
              onToggleSidebar={toggleLeftSidebar}
            />
            )}
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            className="ds-workbench-left-divider ds-workbench-divider ds-no-drag relative z-20 shrink-0 cursor-col-resize"
            onPointerDown={beginLeftResize}
          />
        </>
      ) : null}

      <main
        className={`ds-drag ds-stage-surface relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
          route === 'plugins' ? 'px-0' : ''
        }`}
      >
        {resolvedWorkbenchViewId ? (
          <WorkbenchPanelLoader
            registry={builtinWorkbenchViews}
            panelId={resolvedWorkbenchViewId}
            context={workbenchViewContext}
            title={t('workbenchPanelErrorTitle')}
            retryLabel={t('workbenchPanelRetry')}
          />
        ) : route === 'write' ? (
          <>
            {writeRuntimeBannerMessage ? renderRuntimeBanner(writeRuntimeBannerMessage, runtimeErrorDetail) : null}
            <div className="flex min-h-0 flex-1">
              {activeSddDraft ? (
                <SddDraftEditorView
                  leftSidebarCollapsed={leftSidebarCollapsed}
                  assistantOpen={rightPanelMode === 'sdd-ai'}
                  onToggleLeftSidebar={toggleLeftSidebar}
                  onToggleAssistant={() => void toggleSddAssistantPanel()}
                  onNext={() => void handleSddNextStep()}
                  onClose={() => dismissActiveSddDraft({ closeAssistant: true })}
                  nextDisabled={busy || runtimeConnection !== 'ready' || sddDraftOperationStatus === 'upgrading'}
                />
              ) : (
                <WriteWorkspaceView
                  leftSidebarCollapsed={leftSidebarCollapsed}
                  onToggleLeftSidebar={toggleLeftSidebar}
                  input={input}
                  setInput={setInput}
                  onSubmitPrompt={sendWritePrompt}
                />
              )}
              {renderRightPanel()}
            </div>
          </>
        ) : (
          <>
        {error && !(runtimeConnection !== 'ready' && !activeThreadId) ? renderRuntimeBanner(error, runtimeErrorDetail) : null}

        <div className="flex min-h-0 flex-1">
          <div className={`flex min-h-0 min-w-0 flex-1 ${activeSddDraft ? '' : stageInsetClass}`}>
          {activeSddDraft ? (
            <SddDraftEditorView
              leftSidebarCollapsed={leftSidebarCollapsed}
              assistantOpen={rightPanelMode === 'sdd-ai'}
              onToggleLeftSidebar={toggleLeftSidebar}
              onToggleAssistant={() => void toggleSddAssistantPanel()}
              onNext={() => void handleSddNextStep()}
              onClose={() => dismissActiveSddDraft({ closeAssistant: true })}
              nextDisabled={busy || runtimeConnection !== 'ready' || sddDraftOperationStatus === 'upgrading'}
            />
          ) : (
            <section className="ds-chat-stage ds-drag flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="chat-topbar ds-topbar-surface relative z-10 mt-3 flex min-h-[46px] w-full shrink-0 items-stretch overflow-visible rounded-[24px]">
              <div className="chat-topbar-grid grid w-full min-w-0 items-start gap-2.5 px-3 py-2 sm:px-4 md:pl-5 md:pr-2">
                <div
                  className={`chat-topbar-session flex min-w-0 items-center gap-2.5 ${
                    leftSidebarCollapsed ? 'ds-window-controls-safe-inset' : ''
                  }`}
                >
                  {leftSidebarCollapsed ? (
                    <SidebarTitlebarToggleButton
                      onClick={toggleLeftSidebar}
                      title={t('sidebarExpand')}
                      ariaLabel={t('sidebarExpand')}
                    />
                  ) : null}
                  <SessionHeader compact className="min-w-0 flex-1" />
                </div>
                <div className="chat-topbar-actions flex min-w-0 flex-wrap items-center justify-end gap-2 self-start">
                  {busy ? (
                    <span className="inline-flex shrink-0 rounded-full bg-amber-500/16 px-2.5 py-1 text-[11.5px] font-semibold text-amber-950 dark:text-amber-100">
                      {t('running')}
                    </span>
                  ) : null}
                  <WorkbenchTopBar
                    rightPanelMode={rightPanelMode}
                    onToggleRightPanelMode={toggleRightPanelMode}
                    planPanelEnabled={Boolean(activeGuiPlan)}
                    sideChatCount={currentSideConversations.length}
                    sideChatRunningCount={currentSideRunningCount}
                    sideChatOpen={sidePanel.open}
                    sideChatEnabled={runtimeConnection === 'ready' && Boolean(activeThreadId)}
                    onOpenSideChat={openSideChat}
                  />
                </div>
              </div>
            </header>
            <TaskRunStatusBar
              threadId={activeThreadId}
              runtimeReady={runtimeConnection === 'ready'}
              globalViewMode={conversationViewMode}
              onViewModeOverride={setTaskConversationViewMode}
            />
            <MessageTimeline
              viewMode={taskConversationViewMode ?? conversationViewMode}
              blocks={timelineBlocks}
              liveReasoning={timelineLiveReasoning}
              live={timelineLiveAssistant}
              activeThreadId={activeThreadId}
              runtimeConnection={runtimeConnection}
              runtimeError={error}
              onRetryConnection={() => void probeRuntime('user')}
              onOpenSettings={() => openSettings('agents')}
              onSelectSuggestion={(text) => setInput(text)}
              planActionsBusy={busy}
              onBuildPlan={() => void buildGuiPlan()}
              onOpenPlan={openGuiPlanPanel}
              devPreviewCard={
                showDevPreviewCard ? (
                  <DevPreviewLaunchCard
                    url={latestDevPreviewUrl}
                    opened={rightPanelMode === 'browser'}
                    onOpen={openDevPreview}
                  />
                ) : null
              }
            />
            <div className="ds-no-drag flex shrink-0 justify-center px-2 pb-3 pt-0 sm:px-4 md:px-6 lg:px-8">
              <FloatingComposer
                input={input}
                setInput={setInput}
                mode={mode}
                setMode={setMode}
                busy={busy}
                runtimeReady={runtimeConnection === 'ready'}
                hasActiveThread={Boolean(activeThreadId)}
                composerModel={
                  route === 'claw'
                    ? clawChannels.find((channel) => channel.id === activeClawChannelId)?.model ?? 'auto'
                    : composerModel
                }
                composerPickList={composerPickList}
                composerModelGroups={route === 'claw' ? [] : composerModelGroups}
                composerReasoningEffort={
                  route === 'chat' || route === 'claw' ? composerReasoningEffort : undefined
                }
                composerProviderId={route === 'claw' ? undefined : composerProviderId}
                onComposerModelChange={(modelId, providerId) => {
                  if (route === 'claw' && activeClawChannelId) {
                    void setClawChannelModel(activeClawChannelId, modelId)
                    return
                  }
                  setComposerModel(modelId, providerId)
                }}
                onComposerReasoningEffortChange={
                  route === 'chat' || route === 'claw' ? setComposerReasoningEffort : undefined
                }
                agentProfiles={route === 'chat' ? agentProfiles : undefined}
                activeAgentId={activeThread?.agentId ?? 'general'}
                agentSelectionApplying={agentSelectionApplying}
                onAgentChange={route === 'chat' ? (agentId) => void changeActiveThreadAgent(agentId) : undefined}
                onSend={handleSend}
                attachments={composerAttachments}
                attachmentUploadEnabled={attachmentUploadEnabled}
                attachmentUploadBusy={attachmentUploadBusy}
                attachmentUploadError={attachmentUploadError}
                fileReferenceEnabled={route === 'chat' && !activeSddDraft}
                fileReferences={composerFileReferences}
                webAccessAvailable={webAccessAvailable}
                executionSettings={composerExecutionSettings}
                executionSettingsApplying={composerExecutionApplying}
                changedFiles={composerChangeSummary?.files}
                changedFileStats={composerChangeSummary}
                skillCommands={runtimeSkills}
                onPickAttachments={(files) => void handlePickAttachments(files)}
                onPasteClipboardImage={(options) => void handlePasteClipboardImage(options)}
                onRemoveAttachment={removeComposerAttachment}
                onRetryAttachment={(id) => void retryComposerAttachment(id)}
                onAddFileReference={addComposerFileReference}
                onRemoveFileReference={removeComposerFileReference}
                queuedMessages={queuedMessages}
                onRemoveQueuedMessage={removeQueuedMessage}
                onInterrupt={(options) => void interrupt(options)}
                onPlanCommand={() => void handleGuiPlanCommand()}
                onReviewCommand={(target) => void reviewActiveThread(target)}
                onExecutionSettingsChange={updateComposerExecutionSettings}
                onOpenChanges={() => setRightPanelMode('changes')}
                onReviewChanges={() => void reviewActiveThread({ kind: 'uncommittedChanges' })}
                reviewChangesDisabled={busy || runtimeConnection !== 'ready'}
                onBtwCommand={(seedText) => {
                  if (seedText?.trim()) {
                    void spawnSideConversation(seedText)
                    return
                  }
                  openSideConversationDraft()
                }}
              />
            </div>
          </section>
          )}
          </div>

          {route === 'chat' && !activeSddDraft ? (
            <SideConversationPanel rightOffset={rightPanelVisible ? rightSidebarWidth + 24 : 24} />
          ) : null}

          {renderRightPanel()}
        </div>

          </>
        )}
      </main>
    </div>
  )
}
