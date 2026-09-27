import type { AgentProvider, NormalizedThread, ReviewTarget, ThreadEventSink } from '../agent/types'
import { getProvider } from '../agent/registry'
import { rendererRuntimeClient } from '../agent/runtime-client'
import i18n from '../i18n'
import { applyTheme, applyUiFontScale } from '../lib/apply-theme'
import { formatWorkspacePickerError } from '../lib/format-workspace-picker-error'
import { formatRuntimeError, getRuntimeErrorCode } from '../lib/format-runtime-error'
import {
  deriveThreadTitleFromPrompt,
  getDefaultThreadTitle,
  shouldAutoTitleThread
} from '../lib/thread-title'
import { filterThreadsForSidebar } from '../lib/thread-sidebar-visibility'
import {
  enrichThreadsWithForkInfo,
  forgetThreadFork,
  hydrateThreadForkRegistry,
  markThreadFork,
  readThreadForkRegistry,
  saveThreadForkRegistry
} from '../lib/thread-fork-registry'
import { workspaceLabelFromPath } from '../lib/workspace-label'
import { isInternalTemporaryWorkspace, normalizeWorkspaceRoot } from '../lib/workspace-path'
import {
  buildClawRuntimePrompt,
  buildCodeRuntimePrompt,
  getActiveAgentApiKey,
  getModelProviderProfile,
  resolveManagedRuntimeSettings
} from '@shared/app-settings'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'
import {
  activeClawChannel,
  compactCodeWorkspaceRoots,
  forgetCodeWorkspaceRoot,
  hydrateBlockModelLabels,
  isClawThread,
  optimisticUserModelLabel,
  readCodeWorkspaceRoots,
  readStoredComposerModel,
  rememberCodeWorkspaceRoots,
  rememberTurnModel
} from './chat-store-helpers'
import {
  clearedThreadSelection,
  collectAssistantTextForTurn,
  findLatestUserBlockId,
  findReusableEmptyThreadId,
  hasPendingRuntimeWork,
  reconcileOptimisticUserBlock,
  threadSnapshotLooksRunning,
  threadBelongsToWorkspace
} from './chat-store-runtime-helpers'
import {
  WRITE_ASSISTANT_THREAD_TITLE,
  activeWriteThreadForWorkspace,
  forgetWriteThread,
  hydrateWriteThreadRegistry,
  isWriteThreadId,
  markWriteThread,
  pruneWriteThreadRegistry,
  readWriteThreadRegistry,
  saveWriteThreadRegistry,
  writeThreadBelongsToWorkspace,
  writeWorkspaceForThreadId
} from '../write/write-thread-registry'
import {
  clearBusyWatchdog,
  resetBusyRecoveryAttempts,
  scheduleStartupRuntimeProbe,
  stopTurnCompletionPoll
} from './chat-store-schedulers'
import {
  armBusyWatchdog,
  buildFollowupMessageFromUserInput,
  buildThreadEventSink,
  clearWatchedCompletionNotification,
  finalizeTurnTiming,
  flushLiveBlocks,
  forkedMessageCount,
  forkedTurnCount,
  isCodeThread,
  latestThread,
  looksLikeActiveTurnError,
  readActiveWriteWorkspace,
  readWriteWorkspaceRoots,
  rememberPendingClawFeishuMirror,
  runtimeErrorDetail,
  runtimeStreamRecoveringMessage,
  shouldOpenSettingsForError,
  syncTurnCompletionPoll,
  watchTurnCompletionNotification
} from './chat-store-runtime'
import { terminalReasonForTurnSnapshot } from './terminal-notification-projection'
import { hasImageAttachment, resolveAttachmentAwareModel } from '../lib/attachment-aware-model'

type SseAbortRef = { current: AbortController | null }

type StoreActionContext = {
  set: ChatStoreSet
  get: ChatStoreGet
  sseAbortRef: SseAbortRef
}

let drainingQueuedMessages = false

function engineeringThreadContentScore(thread: NormalizedThread): number {
  if (typeof thread.messageCount !== 'number') return 1
  return thread.messageCount > 0 ? 2 : 0
}

function pickEngineeringThreadCandidate(
  threads: NormalizedThread[]
): NormalizedThread | undefined {
  return [...threads].sort((left, right) => {
    const score = engineeringThreadContentScore(right) - engineeringThreadContentScore(left)
    if (score !== 0) return score
    const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    return Number.isNaN(updated) || updated === 0
      ? right.id.localeCompare(left.id)
      : updated
  })[0]
}

function subscribeThreadEventsWithRecovery(
  provider: AgentProvider,
  threadId: string,
  sinceSeq: number,
  sink: ThreadEventSink,
  signal: AbortSignal,
  get: ChatStoreGet
): void {
  void provider.subscribeThreadEvents(threadId, sinceSeq, sink, signal)
    .catch(() => undefined)
    .then(() => {
      if (signal.aborted) return
      const state = get()
      if (state.activeThreadId !== threadId || !state.busy) return
      void state.recoverActiveTurn()
    })
}

export function createThreadActions(
  { set, get, sseAbortRef }: StoreActionContext
): Pick<ChatState, 'createThread' | 'ensureEngineeringThread' | 'recoverActiveTurn' | 'selectThread' | 'drainQueuedMessages' | 'removeQueuedMessage' | 'sendMessage' | 'reviewActiveThread'> {
  return {
  createThread: async (options = {}) => {
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return
    }
    try {
      const p = getProvider()
      const settings = await rendererRuntimeClient.getSettings()
      const activeThread = get().activeThreadId
        ? get().threads.find((thread) => thread.id === get().activeThreadId)
        : null
      const workspaceRoot =
        normalizeWorkspaceRoot(options.workspaceRoot) ||
        (activeThread && !isInternalTemporaryWorkspace(activeThread.workspace)
          ? normalizeWorkspaceRoot(activeThread.workspace)
          : '') ||
        normalizeWorkspaceRoot(settings.workspaceRoot)
      if (!workspaceRoot) {
        await get().chooseWorkspace({ createThreadAfter: true })
        return
      }
      const codeWorkspaceRoots = rememberCodeWorkspaceRoots(get().codeWorkspaceRoots, [workspaceRoot])
      set({ codeWorkspaceRoots })
      const reusableThreadId = options.forceNew
        ? null
        : await findReusableEmptyThreadId(
            get(),
            p,
            workspaceRoot,
            (thread) => isCodeThread(thread, get().clawChannels)
          )
      if (reusableThreadId) {
        if (get().activeThreadId !== reusableThreadId) {
          await get().selectThread(reusableThreadId)
        } else {
          set({ error: null })
        }
        return
      }
      const t = await p.createThread({
        workspace: workspaceRoot,
        title: getDefaultThreadTitle(),
        mode: 'agent'
      })
      // Register + activate optimistically before refreshing. A freshly created
      // WorkWise Runtime thread may not be listed until the first message is written.
      // Setting it active first lets refreshThreads preserve it in the sidebar.
      set((s) => ({
        activeThreadId: t.id,
        codeWorkspaceRoots: rememberCodeWorkspaceRoots(s.codeWorkspaceRoots, [workspaceRoot, t.workspace]),
        threads: s.threads.some((thread) => thread.id === t.id) ? s.threads : [t, ...s.threads]
      }))
      await get().selectThread(t.id)
      await get().refreshThreads()
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
    }
  },

  ensureEngineeringThread: async (projectId, workspaceRoot, title) => {
    const normalizedProjectId = projectId.trim()
    if (!normalizedProjectId) return null
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return null
    }
    try {
      const current = get()
      const targetWorkspace = normalizeWorkspaceRoot(workspaceRoot) || normalizeWorkspaceRoot(current.workspaceRoot)
      const inMemory = pickEngineeringThreadCandidate(current.threads.filter((thread) =>
        thread.domain === 'engineering' &&
        thread.projectId === normalizedProjectId &&
        thread.archived !== true &&
        (!targetWorkspace || normalizeWorkspaceRoot(thread.workspace) === targetWorkspace)
      ))
      if (inMemory) {
        set({ route: 'engineering' })
        if (current.activeThreadId !== inMemory.id) await get().selectThread(inMemory.id)
        return inMemory.id
      }

      const provider = getProvider()
      const remote = (await provider.listThreads({
        domain: 'engineering',
        projectId: normalizedProjectId,
        includeArchived: true,
        limit: 50
      })).filter((thread) =>
        thread.domain === 'engineering' &&
        thread.projectId === normalizedProjectId &&
        thread.archived !== true &&
        (!targetWorkspace || normalizeWorkspaceRoot(thread.workspace) === targetWorkspace)
      )
      const existing = pickEngineeringThreadCandidate(remote)
      if (existing) {
        set((state) => ({
          route: 'engineering',
          threads: state.threads.some((thread) => thread.id === existing.id)
            ? state.threads
            : [existing, ...state.threads]
        }))
        if (get().activeThreadId !== existing.id) await get().selectThread(existing.id)
        return existing.id
      }

      const created = await provider.createThread({
        workspace: targetWorkspace || undefined,
        title: title?.trim() || 'Survey AI 会话',
        mode: 'agent',
        domain: 'engineering',
        projectId: normalizedProjectId
      })
      set((state) => ({
        route: 'engineering',
        activeThreadId: created.id,
        threads: state.threads.some((thread) => thread.id === created.id)
          ? state.threads
          : [created, ...state.threads]
      }))
      await get().selectThread(created.id)
      await get().refreshThreads()
      return created.id
    } catch (error) {
      set({ error: formatRuntimeError(error) })
      return null
    }
  },

  recoverActiveTurn: async () => {
    const state = get()
    if (!state.activeThreadId) return false
    const { activeThreadId } = state
    const p = getProvider()
    sseAbortRef.current?.abort()
    sseAbortRef.current = null
    clearBusyWatchdog()
    set({ error: runtimeStreamRecoveringMessage() })
    try {
      const {
        blocks: rawBlocks,
        latestSeq,
        threadStatus,
        latestTurnId,
        latestTurnStatus,
        latestTurnError,
        latestUserMessageId,
        turnDurationByUserId = {},
        goal,
        todos
      } = await p.getThreadDetail(activeThreadId)
      const blocks = hydrateBlockModelLabels(activeThreadId, rawBlocks)
      const busy = threadSnapshotLooksRunning(blocks, threadStatus)
      const recoveredTerminalTurn = !busy &&
        Boolean(latestTurnId) &&
        latestTurnId === state.currentTurnId &&
        ['completed', 'failed', 'aborted', 'cancelled', 'canceled', 'blocked', 'max_tokens', 'error']
          .includes(latestTurnStatus?.trim().toLowerCase() ?? '')
      const currentTurnUserId = busy || recoveredTerminalTurn
        ? state.currentTurnUserId ?? latestUserMessageId ?? findLatestUserBlockId(blocks)
        : null
      const currentTurnId = busy || recoveredTerminalTurn
        ? state.currentTurnId ?? latestTurnId ?? null
        : null

      set((s) => ({
        activeThreadId,
        activeThreadGoal: goal ?? null,
        activeThreadTodos: todos ?? null,
        blocks,
        lastSeq: latestSeq,
        liveReasoning: '',
        liveAssistant: '',
        error: busy ? runtimeStreamRecoveringMessage() : null,
        busy,
        currentTurnId,
        currentTurnUserId,
        turnDurationByUserId,
        queuedMessages: s.queuedMessages
      }))

      const ac = new AbortController()
      sseAbortRef.current = ac
      const sink = buildThreadEventSink(set, get, { threadId: activeThreadId, signal: ac.signal, sinceSeq: latestSeq })
      if (recoveredTerminalTurn && latestTurnId) {
        const reason = terminalReasonForTurnSnapshot(latestTurnStatus, latestTurnError)
        if (reason === 'completed' || reason === 'aborted') {
          sink.onTurnComplete({ reason, threadId: activeThreadId, turnId: latestTurnId })
        } else {
          sink.onError(new Error(latestTurnError?.trim() || 'WorkWise Runtime turn failed'), {
            terminal: true,
            terminalReason: reason,
            threadId: activeThreadId,
            turnId: latestTurnId
          })
        }
      }
      subscribeThreadEventsWithRecovery(p, activeThreadId, latestSeq, sink, ac.signal, get)
      if (busy) {
        armBusyWatchdog(set, get)
      } else {
        resetBusyRecoveryAttempts()
        if (get().queuedMessages.length > 0) {
          void get().drainQueuedMessages()
        }
      }
      return busy
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
      if (state.busy) armBusyWatchdog(set, get)
      return state.busy
    }
  },

  selectThread: async (id) => {
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return
    }
    const prevId = get().activeThreadId
    const prevBusy = get().busy
    let nextWatch = { ...get().watchTurnCompletion }
    delete nextWatch[id]
    clearWatchedCompletionNotification(id)
    if (prevId && prevId !== id && prevBusy) {
      nextWatch[prevId] = true
      watchTurnCompletionNotification(prevId)
    }
    const nextUnread = { ...get().unreadThreadIds }
    delete nextUnread[id]

    sseAbortRef.current?.abort()
    sseAbortRef.current = null
    const p = getProvider()
    try {
      resetBusyRecoveryAttempts()
      clearBusyWatchdog()
      const {
        blocks: rawBlocks,
        latestSeq,
        threadStatus,
        latestTurnId,
        latestUserMessageId,
        turnDurationByUserId = {},
        usage: threadUsage,
        goal,
        todos
      } = await p.getThreadDetail(id)
      const blocks = hydrateBlockModelLabels(id, rawBlocks)
      const busy = threadSnapshotLooksRunning(blocks, threadStatus)
      const currentTurnUserId = busy
        ? latestUserMessageId ?? findLatestUserBlockId(blocks)
        : null
      set({
        watchTurnCompletion: nextWatch,
        unreadThreadIds: nextUnread,
        activeThreadId: id,
        activeThreadGoal: goal ?? null,
        activeThreadTodos: todos ?? null,
        blocks,
        lastSeq: latestSeq,
        liveReasoning: '',
        liveAssistant: '',
        error: null,
        busy,
        currentTurnId: busy ? latestTurnId ?? null : null,
        currentTurnUserId,
        turnStartedAtByUserId: {},
        turnDurationByUserId,
        turnReasoningFirstAtByUserId: {},
        turnReasoningLastAtByUserId: {},
        inspectorSelectedId: null,
        queuedMessages: []
      })
      syncTurnCompletionPoll(set, get)
      const ac = new AbortController()
      sseAbortRef.current = ac
      const sink = buildThreadEventSink(set, get, { threadId: id, signal: ac.signal, sinceSeq: latestSeq })
      subscribeThreadEventsWithRecovery(p, id, latestSeq, sink, ac.signal, get)
      if (busy) armBusyWatchdog(set, get)
    } catch (e) {
      set({
        error: formatRuntimeError(e),
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
    }
  },

  drainQueuedMessages: async () => {
    if (drainingQueuedMessages) return
    drainingQueuedMessages = true
    try {
      while (true) {
        const state = get()
        const queuedMessages = state.queuedMessages.filter((message) => !message.guiPlan)
        if (queuedMessages.length !== state.queuedMessages.length) {
          set({ queuedMessages })
        }
        const next = queuedMessages[0]
        if (!next || state.busy) return
        const started = await get().sendMessage(next.text, next.mode, { queued: next })
        if (!started) return
      }
    } finally {
      drainingQueuedMessages = false
    }
  },

  removeQueuedMessage: (id) =>
    set((s) => ({
      queuedMessages: s.queuedMessages.filter((message) => message.id !== id)
    })),

  sendMessage: async (text, mode, overrides) => {
    const trimmedText = text.trim()
    if (!trimmedText) return false
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return false
    }
    const p = getProvider()
    if (get().route === 'write') {
      const writeThreadId = await get().ensureWriteThreadForWorkspace()
      if (!writeThreadId) return false
    }
    const queued = overrides?.queued
    const messageAttachments =
      queued?.attachments ??
      overrides?.attachments?.filter((attachment) => attachment.id.trim().length > 0) ??
      []
    const clawModel = activeClawChannel(get())?.model
    const requestedModel =
      queued?.model ??
      overrides?.model?.trim() ??
      (get().route === 'claw' && clawModel ? clawModel : get().composerModel.trim())
    let composerModel = requestedModel
    let providerId = queued ? queued.providerId : overrides?.providerId ?? (overrides?.model !== undefined || get().route === 'claw' ? undefined : get().composerProviderId)
    if (!queued && !providerId) {
      try {
        providerId = resolveManagedRuntimeSettings(await rendererRuntimeClient.getSettings()).providerId
      } catch (error) {
        set({ error: formatRuntimeError(error) })
        return false
      }
    }
    const attachmentRoutingModel = requestedModel || 'auto'
    if (attachmentRoutingModel === 'auto' && hasImageAttachment(messageAttachments)) {
      try {
        const settings = await rendererRuntimeClient.getSettings()
        const runtime = resolveManagedRuntimeSettings(settings)
        const provider = providerId ? settings.provider.providers.find(item => item.id === providerId) : getModelProviderProfile(settings, runtime.providerId)
        if (!provider) throw new Error(`model_provider_unavailable: ${providerId}`)
        const decision = resolveAttachmentAwareModel({
          selectedModel: attachmentRoutingModel,
          attachments: messageAttachments,
          activeProvider: { ...provider, baseUrl: providerId ? provider.baseUrl : runtime.baseUrl },
          modelGroups: get().composerModelGroups
        })
        if (!decision.ok) {
          set({
            error: i18n.t('common:composerVisionModelUnavailable', {
              provider: provider.name,
              model: decision.model
            })
          })
          return false
        }
        composerModel = decision.model
        providerId ??= provider.id
      } catch (error) {
        set({ error: formatRuntimeError(error) })
        return false
      }
    }
    const hasPendingActiveTurn = get().blocks.some(hasPendingRuntimeWork)
    if (get().busy || hasPendingActiveTurn) {
      if (overrides?.guiPlan || overrides?.guiDesign) {
        set({ error: i18n.t('common:composerQueuePlaceholder') })
        return false
      }
      const now = Date.now()
      const activeThreadId = get().activeThreadId
      const threadSnap = activeThreadId
        ? get().threads.find((thread) => thread.id === activeThreadId)
        : undefined
      const userModelChip =
        overrides?.modelLabel ?? optimisticUserModelLabel(composerModel, threadSnap?.model)
      const displayText = overrides?.displayText?.trim()
      const reasoningEffort = overrides?.reasoningEffort?.trim()
      const attachmentIds = overrides?.attachmentIds?.filter((id) => id.trim().length > 0)
      const attachments = overrides?.attachments?.filter((attachment) => attachment.id.trim().length > 0)
      const workspaceReferences = overrides?.workspaceReferences?.filter((reference) => reference.path.trim())
      set((s) => ({
        queuedMessages: [
          ...s.queuedMessages,
          {
            id: `q-${now}-${s.queuedMessages.length}`,
            text: trimmedText,
            ...(displayText ? { displayText } : {}),
            ...(mode ? { mode } : {}),
            ...(composerModel ? { model: composerModel } : {}),
            ...(providerId ? { providerId } : {}),
            ...(userModelChip ? { modelLabel: userModelChip } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(overrides?.guiPlan ? { guiPlan: overrides.guiPlan } : {}),
            ...(attachmentIds?.length ? { attachmentIds } : {}),
            ...(attachments?.length ? { attachments } : {}),
            ...(workspaceReferences?.length ? { workspaceReferences } : {})
          }
        ],
        error: null
      }))
      // UI/runtime can briefly drift (busy=false while runtime still has an active turn).
      // Kick recovery so queued input drains as soon as the in-flight turn settles.
      if (!get().busy && hasPendingActiveTurn) {
        void get().recoverActiveTurn()
      }
      return true
    }
    const now = Date.now()
    const userBlockId = queued?.id ?? `u-${now}`
    const attachmentIds =
      queued?.attachmentIds ??
      overrides?.attachmentIds?.filter((id) => id.trim().length > 0) ??
      []
    const attachments = messageAttachments
    const workspaceReferences =
      queued?.workspaceReferences ??
      overrides?.workspaceReferences?.filter((reference) => reference.path.trim()) ??
      []
    let activeThreadId = get().activeThreadId
    const displayText = queued?.displayText ?? overrides?.displayText?.trim() ?? trimmedText
    const userDisplayText = displayText !== trimmedText ? displayText : undefined
    const generatedTitle = deriveThreadTitleFromPrompt(displayText)
    const shouldAutoRenameForRoute = get().route === 'chat'
    const activeThread = activeThreadId
      ? get().threads.find((thread) => thread.id === activeThreadId) ?? null
      : null
    let shouldRenameThreadAfterSend =
      shouldAutoRenameForRoute &&
      !!activeThreadId &&
      get().blocks.every((block) => block.kind !== 'user') &&
      shouldAutoTitleThread(activeThread)
    const threadSnap = get().threads.find((thread) => thread.id === activeThreadId)
    const reasoningEffort = queued?.reasoningEffort ?? overrides?.reasoningEffort?.trim()
    const userModelChip =
      queued?.modelLabel ?? overrides?.modelLabel ?? optimisticUserModelLabel(composerModel, threadSnap?.model)
    const previousBlocks = get().blocks
    const previousActiveThreadId = get().activeThreadId
    const previousLastSeq = get().lastSeq
    const previousCurrentTurnId = get().currentTurnId
    const previousCurrentTurnUserId = get().currentTurnUserId
    const previousTurnStartedAtByUserId = get().turnStartedAtByUserId
    const previousTurnDurationByUserId = get().turnDurationByUserId
    const previousTurnReasoningFirstAtByUserId = get().turnReasoningFirstAtByUserId
    const previousTurnReasoningLastAtByUserId = get().turnReasoningLastAtByUserId
    const previousQueuedMessages = get().queuedMessages
    resetBusyRecoveryAttempts()
    set((s) => ({
      busy: true,
      blocks: [
        ...s.blocks,
        {
          kind: 'user' as const,
          id: userBlockId,
          createdAt: new Date(now).toISOString(),
          text: displayText,
          ...(userModelChip ? { modelLabel: userModelChip } : {}),
          ...(userDisplayText || attachmentIds.length || attachments.length
            ? {
                meta: {
                  ...(userDisplayText ? { displayText: userDisplayText } : {}),
                  ...(attachmentIds.length ? { attachmentIds } : {}),
                  ...(attachments.length ? { attachments } : {})
                }
              }
            : {})
        }
      ],
      liveReasoning: '',
      liveAssistant: '',
      error: null,
      currentTurnUserId: userBlockId,
      turnStartedAtByUserId: { ...s.turnStartedAtByUserId, [userBlockId]: now },
      queuedMessages: queued ? s.queuedMessages.filter((message) => message.id !== queued.id) : s.queuedMessages
    }))
    if (!activeThreadId) {
      try {
        const settings = await rendererRuntimeClient.getSettings()
        const workspaceRoot = normalizeWorkspaceRoot(settings.workspaceRoot)
        if (!workspaceRoot) {
          set({
            blocks: previousBlocks,
            busy: false,
            currentTurnId: previousCurrentTurnId,
            currentTurnUserId: previousCurrentTurnUserId,
            turnStartedAtByUserId: previousTurnStartedAtByUserId,
            turnDurationByUserId: previousTurnDurationByUserId,
            turnReasoningFirstAtByUserId: previousTurnReasoningFirstAtByUserId,
            turnReasoningLastAtByUserId: previousTurnReasoningLastAtByUserId,
            queuedMessages: previousQueuedMessages,
            error: i18n.t('common:workspaceRequiredToCreateThread')
          })
          return false
        }
        const codeWorkspaceRoots = rememberCodeWorkspaceRoots(get().codeWorkspaceRoots, [workspaceRoot])
        set({ codeWorkspaceRoots })
        const reusableThreadId = await findReusableEmptyThreadId(
          get(),
          p,
          workspaceRoot,
          (thread) => isCodeThread(thread, get().clawChannels)
        )
        const reusableThread = reusableThreadId
          ? get().threads.find((thread) => thread.id === reusableThreadId) ?? null
          : null
        shouldRenameThreadAfterSend =
          shouldAutoRenameForRoute &&
          reusableThreadId != null && shouldAutoTitleThread(reusableThread)
        const createdThread =
          reusableThreadId == null
            ? await p.createThread({
                workspace: workspaceRoot,
                title: generatedTitle,
                mode: mode ?? 'agent'
              })
            : null
        const threadId = reusableThreadId ?? createdThread?.id ?? null
        if (!threadId) {
          throw new Error('Failed to resolve target thread id.')
        }
        activeThreadId = threadId
        set((s) => ({
          activeThreadId: threadId,
          codeWorkspaceRoots: rememberCodeWorkspaceRoots(s.codeWorkspaceRoots, [workspaceRoot, createdThread?.workspace]),
          lastSeq: 0,
          inspectorSelectedId: null,
          threads:
            createdThread && !s.threads.some((thread) => thread.id === createdThread.id)
              ? [createdThread, ...s.threads]
              : s.threads
        }))
        void get().refreshThreads()
      } catch (e) {
        void window.workwise.logError('create-thread', 'Failed to create thread', {
          message: e instanceof Error ? e.message : String(e)
        }).catch(() => undefined)
        set({
          activeThreadId: previousActiveThreadId,
          blocks: previousBlocks,
          lastSeq: previousLastSeq,
          busy: false,
          currentTurnId: previousCurrentTurnId,
          currentTurnUserId: previousCurrentTurnUserId,
          turnStartedAtByUserId: previousTurnStartedAtByUserId,
          turnDurationByUserId: previousTurnDurationByUserId,
          turnReasoningFirstAtByUserId: previousTurnReasoningFirstAtByUserId,
          turnReasoningLastAtByUserId: previousTurnReasoningLastAtByUserId,
          queuedMessages: previousQueuedMessages,
          error: formatRuntimeError(e),
          ...(shouldOpenSettingsForError(e)
            ? { route: 'settings' as const, settingsSection: 'agents' as const }
            : {})
        })
        return false
      }
    }
    sseAbortRef.current?.abort()
    sseAbortRef.current = null
    clearBusyWatchdog()
    try {
      const seqAtSend = get().lastSeq
      const channel = get().route === 'claw' ? activeClawChannel(get()) : null
      const settings = await rendererRuntimeClient.getSettings()
      let runtimeText: string
      if (channel) {
        runtimeText = buildClawRuntimePrompt(settings, trimmedText, { channel })
      } else if (get().threads.find((thread) => thread.id === activeThreadId)?.domain === 'engineering') {
        runtimeText = trimmedText
      } else {
        runtimeText = buildCodeRuntimePrompt(settings, trimmedText)
      }
      const runtimeDisplayText = channel ? displayText : (userDisplayText ?? trimmedText)
      const { turnId, userMessageItemId } = await p.sendUserMessage(activeThreadId, runtimeText, {
        mode,
        ...(composerModel ? { model: composerModel } : {}),
        ...(providerId ? { providerId } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(runtimeDisplayText ? { displayText: runtimeDisplayText } : {}),
        ...((queued?.guiPlan ?? overrides?.guiPlan) ? { guiPlan: queued?.guiPlan ?? overrides?.guiPlan } : {}),
        ...(overrides?.guiDesign ? { guiDesign: overrides.guiDesign } : {}),
        ...(attachmentIds.length ? { attachmentIds } : {}),
        ...(workspaceReferences.length ? { workspaceReferences } : {})
      })
      // Mirror the composer model selection against the runtime's stable
      // user_message item id so the badge survives page refresh / thread
      // re-selection. The runtime itself doesn't persist per-turn metadata.
      if (userMessageItemId && userModelChip) {
        rememberTurnModel(activeThreadId, userMessageItemId, userModelChip)
      }
      if (userMessageItemId && userMessageItemId !== userBlockId) {
        set((s) => ({
          blocks: reconcileOptimisticUserBlock(
            s.blocks,
            userBlockId,
            userMessageItemId,
            displayText,
            userModelChip
          ),
          currentTurnUserId: s.currentTurnUserId === userBlockId ? userMessageItemId : s.currentTurnUserId,
          turnStartedAtByUserId: (() => {
            if (s.turnStartedAtByUserId[userBlockId] === undefined) return s.turnStartedAtByUserId
            const next = { ...s.turnStartedAtByUserId, [userMessageItemId]: s.turnStartedAtByUserId[userBlockId] }
            delete next[userBlockId]
            return next
          })(),
          turnDurationByUserId: (() => {
            if (s.turnDurationByUserId[userBlockId] === undefined) return s.turnDurationByUserId
            const next = { ...s.turnDurationByUserId, [userMessageItemId]: s.turnDurationByUserId[userBlockId] }
            delete next[userBlockId]
            return next
          })(),
          turnReasoningFirstAtByUserId: (() => {
            if (s.turnReasoningFirstAtByUserId[userBlockId] === undefined) return s.turnReasoningFirstAtByUserId
            const next = {
              ...s.turnReasoningFirstAtByUserId,
              [userMessageItemId]: s.turnReasoningFirstAtByUserId[userBlockId]
            }
            delete next[userBlockId]
            return next
          })(),
          turnReasoningLastAtByUserId: (() => {
            if (s.turnReasoningLastAtByUserId[userBlockId] === undefined) return s.turnReasoningLastAtByUserId
            const next = {
              ...s.turnReasoningLastAtByUserId,
              [userMessageItemId]: s.turnReasoningLastAtByUserId[userBlockId]
            }
            delete next[userBlockId]
            return next
          })()
        }))
      }
      if (channel && typeof window.workwise?.mirrorClawChannelMessage === 'function') {
        const userMirror = await window.workwise.mirrorClawChannelMessage(
          activeThreadId,
          trimmedText,
          'user',
          { turnId, requestText: trimmedText }
        )
        if (userMirror.ok) {
          rememberPendingClawFeishuMirror(turnId, {
            threadId: activeThreadId,
            userBlockId: userMessageItemId ?? userBlockId,
            userText: trimmedText
          })
        }
      }
      if (shouldRenameThreadAfterSend) {
        const renamed = await p.renameThread(activeThreadId, generatedTitle).then(() => true).catch(() => {
          /* keep message delivery successful even if auto-title update fails */
          return false
        })
        if (renamed) {
          set((s) => ({
            threads: s.threads.map((thread) =>
              thread.id === activeThreadId ? { ...thread, title: generatedTitle } : thread
            )
          }))
        }
      }
      set({ currentTurnId: turnId })
      const ac = new AbortController()
      sseAbortRef.current = ac
      const sink = buildThreadEventSink(set, get, { threadId: activeThreadId, signal: ac.signal, sinceSeq: seqAtSend })
      subscribeThreadEventsWithRecovery(p, activeThreadId, seqAtSend, sink, ac.signal, get)
      armBusyWatchdog(set, get)
      await get().refreshThreads()
      return true
    } catch (e) {
      clearBusyWatchdog()
      void window.workwise.logError('send-message', 'Failed to send message', {
        message: e instanceof Error ? e.message : String(e),
        threadId: activeThreadId
      }).catch(() => undefined)
      if (looksLikeActiveTurnError(e)) {
        set({
          blocks: previousBlocks,
          busy: false,
          currentTurnId: previousCurrentTurnId,
          currentTurnUserId: previousCurrentTurnUserId,
          turnStartedAtByUserId: previousTurnStartedAtByUserId,
          turnDurationByUserId: previousTurnDurationByUserId,
          turnReasoningFirstAtByUserId: previousTurnReasoningFirstAtByUserId,
          turnReasoningLastAtByUserId: previousTurnReasoningLastAtByUserId,
          queuedMessages: previousQueuedMessages,
          error: i18n.t('common:runtimeActiveTurn')
        })
        await get().recoverActiveTurn()
        await get().refreshThreads()
        return false
      }
      set({
        error: formatRuntimeError(e),
        busy: false,
        currentTurnId: null,
        queuedMessages: previousQueuedMessages,
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
      await get().refreshThreads()
      return false
    }
  },

  reviewActiveThread: async (target: ReviewTarget) => {
    if (get().runtimeConnection !== 'ready') {
      set({ error: i18n.t('common:runtimeActionNeedsConnection') })
      return false
    }
    const p = getProvider()
    if (typeof p.reviewThread !== 'function') {
      set({ error: i18n.t('common:reviewUnavailable') })
      return false
    }
    if (get().busy || get().blocks.some(hasPendingRuntimeWork)) {
      set({ error: i18n.t('common:composerQueuePlaceholder') })
      return false
    }
    let activeThreadId = get().activeThreadId
    try {
      if (!activeThreadId) {
        const settings = await rendererRuntimeClient.getSettings()
        const workspaceRoot = normalizeWorkspaceRoot(settings.workspaceRoot)
        if (!workspaceRoot) {
          set({ error: i18n.t('common:workspaceRequiredToCreateThread') })
          return false
        }
        const codeWorkspaceRoots = rememberCodeWorkspaceRoots(get().codeWorkspaceRoots, [workspaceRoot])
        set({ codeWorkspaceRoots })
        const reusableThreadId = await findReusableEmptyThreadId(
          get(),
          p,
          workspaceRoot,
          (thread) => isCodeThread(thread, get().clawChannels)
        )
        const createdThread =
          reusableThreadId == null
            ? await p.createThread({
                workspace: workspaceRoot,
                title: i18n.t('common:slashCommandReviewTitle'),
                mode: 'agent'
              })
            : null
        activeThreadId = reusableThreadId ?? createdThread?.id ?? null
        if (!activeThreadId) throw new Error('Failed to resolve target thread id.')
        set((s) => ({
          activeThreadId,
          codeWorkspaceRoots: rememberCodeWorkspaceRoots(s.codeWorkspaceRoots, [workspaceRoot, createdThread?.workspace]),
          lastSeq: 0,
          inspectorSelectedId: null,
          threads:
            createdThread && !s.threads.some((thread) => thread.id === createdThread.id)
              ? [createdThread, ...s.threads]
              : s.threads
        }))
      }
      const threadSnap = get().threads.find((thread) => thread.id === activeThreadId)
      const selection = get()
      const composerModel = selection.composerModel.trim()
      const providerId = selection.composerProviderId
      const userModelChip = optimisticUserModelLabel(composerModel, threadSnap?.model)
      const seqAtSend = get().lastSeq
      resetBusyRecoveryAttempts()
      sseAbortRef.current?.abort()
      sseAbortRef.current = null
      clearBusyWatchdog()
      set({
        busy: true,
        liveReasoning: '',
        liveAssistant: '',
        error: null,
        currentTurnId: null,
        currentTurnUserId: null
      })
      const { turnId, userMessageItemId } = await p.reviewThread(activeThreadId, target, {
        ...(composerModel ? { model: composerModel } : {}),
        ...(providerId ? { providerId } : {})
      })
      if (userMessageItemId && userModelChip) {
        rememberTurnModel(activeThreadId, userMessageItemId, userModelChip)
      }
      set({ currentTurnId: turnId })
      const ac = new AbortController()
      sseAbortRef.current = ac
      const sink = buildThreadEventSink(set, get, { threadId: activeThreadId, signal: ac.signal, sinceSeq: seqAtSend })
      subscribeThreadEventsWithRecovery(p, activeThreadId, seqAtSend, sink, ac.signal, get)
      armBusyWatchdog(set, get)
      await get().refreshThreads()
      return true
    } catch (e) {
      clearBusyWatchdog()
      set({
        error: formatRuntimeError(e),
        busy: false,
        currentTurnId: null,
        currentTurnUserId: null,
        ...(shouldOpenSettingsForError(e)
          ? { route: 'settings' as const, settingsSection: 'agents' as const }
          : {})
      })
      await get().refreshThreads()
      return false
    }
  },
  }
}
