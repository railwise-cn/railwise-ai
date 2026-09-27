import type {
  AgentProvider,
  ChatBlock,
  NormalizedThread,
  ReviewTarget,
  ThreadEventSink,
  ThreadListOptions,
  ThreadUsageSnapshot,
  UserInputAnswer
} from './types'
import { getManagedRuntimeSettings } from '@shared/app-settings'
import {
  RUNTIME_ATTACHMENT_DIAGNOSTICS_PATH,
  RUNTIME_ATTACHMENTS_PATH,
  RUNTIME_MEMORY_DIAGNOSTICS_PATH,
  RUNTIME_MEMORY_PATH,
  RUNTIME_INFO_PATH,
  RUNTIME_TOOLS_PATH,
  RUNTIME_SKILLS_PATH,
  runtimeApprovalPath,
  runtimeThreadCompactPath,
  runtimeThreadEventsPath,
  runtimeThreadForkPath,
  runtimeThreadGoalPath,
  runtimeThreadReviewPath,
  runtimeThreadTodosPath,
  runtimeThreadInterruptPath,
  runtimeThreadPath,
  runtimeThreadSteerPath,
  runtimeThreadTurnsPath,
  runtimeAttachmentContentPath,
  runtimeUserInputPath,
  runtimeMemoryRecordPath,
  runtimeSessionResumePath,
  normalizeThreadMode,
  type RuntimeThreadMode
} from '@shared/runtime-endpoints'
import { parseRuntimeErrorBody, runtimeErrorToError, type RuntimeError } from '@shared/runtime-error'
import type {
  CoreAttachmentDiagnosticsJson,
  CoreAttachmentContentResponseJson,
  CoreAttachmentMetadataJson,
  CoreAttachmentTextFallbackJson,
  CoreAttachmentUploadResponseJson,
  CoreMemoryDiagnosticsJson,
  CoreMemoryListResponseJson,
  CoreMemoryRecordJson,
  CoreResumeSessionResponseJson,
  CoreRuntimeInfoJson,
  CoreRuntimeEventJson,
  CoreRuntimeSkillJson,
  CoreRuntimeSkillsResponseJson,
  CoreRuntimeToolDiagnosticsJson,
  CoreStartReviewResponseJson,
  CoreClearThreadGoalResponseJson,
  CoreClearThreadTodosResponseJson,
  CoreStartTurnResponseJson,
  CoreThreadGoalResponseJson,
  CoreThreadJson,
  CoreThreadSummaryJson,
  CoreThreadTodosResponseJson
} from './runtime-contract'
import {
  buildQuery,
  chatBlockFromItem,
  dispatchRuntimeEvents,
  goalFromCore,
  mergeChatBlocks,
  todosFromCore,
  threadFromCore
} from './runtime-mapper'
import { rendererRuntimeClient } from './runtime-client'

function createSseStreamId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `sse-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function readRuntimeError(body: string, fallback: string): RuntimeError {
  return parseRuntimeErrorBody(body, fallback)
}

function normalizeApprovalPolicy(value: string | undefined): NormalizedThread['approvalPolicy'] {
  switch (value) {
    case 'auto':
    case 'on-request':
    case 'untrusted':
    case 'suggest':
    case 'never':
      return value
    default:
      return undefined
  }
}

function readRuntimeJson<T>(body: string, fallback: string): T {
  try {
    return JSON.parse(body) as T
  } catch {
    throw runtimeErrorToError({ code: 'unknown', message: fallback })
  }
}

/**
 * Renderer adapter for the WorkWise Agent Runtime HTTP/SSE contract.
 *
 * The provider owns renderer orchestration only: HTTP calls, SSE
 * reconnection, and approval policy decisions. DTO and chat-block
 * mapping live in `runtime-contract.ts` and `runtime-mapper.ts`.
 */
export class WorkWiseRuntimeProvider implements AgentProvider {
  readonly id = 'kun' as const
  readonly displayName = 'WorkWise Agent Runtime'

  getCapabilities(): {
    interrupt: boolean
    stream: boolean
    approvals: boolean
    attachFiles: boolean
    review: boolean
  } {
    return { interrupt: true, stream: true, approvals: true, attachFiles: true, review: true }
  }

  async connect(): Promise<void> {
    const health = await rendererRuntimeClient.runtimeRequest('/health', 'GET')
    if (!health.ok) {
      throw runtimeErrorToError(readRuntimeError(health.body, `runtime unhealthy (${health.status || 0})`))
    }
    const threads = await rendererRuntimeClient.runtimeRequest('/v1/threads?limit=1', 'GET')
    if (!threads.ok) {
      throw runtimeErrorToError(readRuntimeError(threads.body, `failed to list threads (${threads.status || 0})`))
    }
  }

  async listThreads(options: ThreadListOptions = {}): Promise<NormalizedThread[]> {
    const query = buildQuery({
      limit: options.limit ?? 50,
      search: options.search,
      include_archived: options.includeArchived,
      archived_only: options.archivedOnly,
      domain: options.domain,
      project_id: options.projectId
    })
    const response = await rendererRuntimeClient.runtimeRequest(`/v1/threads${query}`, 'GET')
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to list threads'))
    }
    const body = readRuntimeJson<{ threads: CoreThreadSummaryJson[] }>(
      response.body,
      'runtime returned an invalid thread list response'
    )
    return body.threads.map(threadFromCore)
  }

  async createThread(input: {
    workspace?: string
    title?: string
    mode?: RuntimeThreadMode
    domain?: NormalizedThread['domain']
    projectId?: string
  }): Promise<NormalizedThread> {
    const settings = await rendererRuntimeClient.getSettings()
    const runtime = getManagedRuntimeSettings(settings)
    const response = await rendererRuntimeClient.runtimeRequest(
      '/v1/threads',
      'POST',
      JSON.stringify({
        workspace: input.workspace || settings.workspaceRoot || '~',
        title: input.title,
        model: runtime.model,
        mode: normalizeThreadMode(input.mode),
        domain: input.domain,
        projectId: input.projectId,
        approvalPolicy: runtime.approvalPolicy,
        sandboxMode: runtime.sandboxMode
      })
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to create thread'))
    }
    return threadFromCore(readRuntimeJson<CoreThreadJson>(
      response.body,
      'runtime returned an invalid thread response'
    ))
  }

  async getThreadDetail(threadId: string): Promise<{
    blocks: ChatBlock[]
    latestSeq: number
    threadStatus?: string
    latestTurnId?: string
    latestTurnStatus?: string
    latestTurnError?: string
    latestUserMessageId?: string
    turnDurationByUserId?: Record<string, number>
    usage?: ThreadUsageSnapshot
    goal?: NormalizedThread['goal']
    todos?: NormalizedThread['todos']
  }> {
    const response = await rendererRuntimeClient.runtimeRequest(runtimeThreadPath(threadId), 'GET')
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to load thread'))
    }
    const thread = readRuntimeJson<CoreThreadJson>(
      response.body,
      'runtime returned an invalid thread response'
    )
    const turns = Array.isArray(thread.turns) ? thread.turns : []
    const items = turns.flatMap((turn) =>
      (turn.items ?? []).map((item) => ({
        ...item,
        attachmentIds: turn.attachmentIds,
        activeSkillIds: turn.activeSkillIds,
        injectedMemoryIds: turn.injectedMemoryIds,
        skillInjectionBytes: turn.skillInjectionBytes
      }))
    )
    const blocks = mergeChatBlocks(items.flatMap((item) => {
      const block = chatBlockFromItem(item)
      return block ? [block] : []
    }))
    const latestTurn = turns.at(-1)
    const latestUserMessageId = [...items].reverse().find((item) => item.kind === 'user_message')?.id
    return {
      blocks,
      latestSeq: thread.latestSeq ?? 0,
      threadStatus: thread.status ?? latestTurn?.status,
      latestTurnId: latestTurn?.id,
      latestTurnStatus: latestTurn?.status,
      latestTurnError: latestTurn?.error,
      latestUserMessageId,
      goal: thread.goal ? goalFromCore(thread.goal) : null,
      todos: thread.todos ? todosFromCore(thread.todos) : null
    }
  }

  async sendUserMessage(
    threadId: string,
    text: string,
    options?: {
      mode?: RuntimeThreadMode
      model?: string
      providerId?: string
      reasoningEffort?: string
      displayText?: string
      guiPlan?: {
        operation: 'draft' | 'refine'
        workspaceRoot: string
        relativePath: string
        planId: string
        sourceRequest?: string
        title?: string
      }
      guiDesign?: {
        workspaceRoot: string
        documentId: string
        pageId: string
        expectedRevision: number
      }
      attachmentIds?: string[]
      workspaceReferences?: Array<{ path: string; kind: 'file' | 'directory' }>
    }
  ): Promise<{ turnId: string; threadId: string; userMessageItemId?: string }> {
    const settings = await rendererRuntimeClient.getSettings()
    const runtime = getManagedRuntimeSettings(settings)
    const body: Record<string, unknown> = {
      prompt: text,
      model: options?.model,
      ...(options?.providerId ? { providerId: options.providerId } : {}),
      approvalPolicy: runtime.approvalPolicy,
      sandboxMode: runtime.sandboxMode
    }
    if (options?.reasoningEffort?.trim()) {
      body.reasoningEffort = options.reasoningEffort.trim()
    }
    if (options?.displayText?.trim() && options.displayText.trim() !== text.trim()) {
      body.displayText = options.displayText.trim()
    }
    const mode = options?.mode
    if (mode === 'agent' || mode === 'plan') {
      body.mode = mode
    }
    if (options?.guiPlan) {
      body.guiPlan = {
        operation: options.guiPlan.operation,
        workspaceRoot: options.guiPlan.workspaceRoot,
        relativePath: options.guiPlan.relativePath,
        planId: options.guiPlan.planId,
        sourceRequest: options.guiPlan.sourceRequest,
        title: options.guiPlan.title
      }
    }
    if (options?.guiDesign) {
      body.guiDesign = {
        workspaceRoot: options.guiDesign.workspaceRoot,
        documentId: options.guiDesign.documentId,
        pageId: options.guiDesign.pageId,
        expectedRevision: options.guiDesign.expectedRevision
      }
    }
    if (options?.attachmentIds?.length) {
      body.attachmentIds = options.attachmentIds
    }
    if (options?.workspaceReferences?.length) {
      body.workspaceReferences = options.workspaceReferences
    }
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadTurnsPath(threadId),
      'POST',
      JSON.stringify(body)
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to start turn'))
    }
    const parsed = readRuntimeJson<CoreStartTurnResponseJson>(
      response.body,
      'runtime returned an invalid turn response'
    )
    return {
      threadId: parsed.threadId,
      turnId: parsed.turnId,
      userMessageItemId: parsed.userMessageItemId
    }
  }

  async reviewThread(
    threadId: string,
    target: ReviewTarget,
    options?: { model?: string; providerId?: string }
  ): Promise<{ turnId: string; threadId: string; userMessageItemId?: string; reviewItemId?: string }> {
    const body: Record<string, unknown> = { target }
    if (options?.model?.trim()) {
      body.model = options.model.trim()
    }
    if (options?.providerId?.trim()) {
      body.providerId = options.providerId.trim()
    }
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadReviewPath(threadId),
      'POST',
      JSON.stringify(body)
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to start review'))
    }
    const parsed = readRuntimeJson<CoreStartReviewResponseJson>(
      response.body,
      'runtime returned an invalid review response'
    )
    return {
      threadId: parsed.threadId,
      turnId: parsed.turnId,
      userMessageItemId: parsed.userMessageItemId,
      reviewItemId: parsed.reviewItemId
    }
  }

  async steerUserMessage(threadId: string, turnId: string, text: string): Promise<void> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadSteerPath(threadId, turnId),
      'POST',
      JSON.stringify({ text })
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to queue message'))
    }
  }

  async interruptTurn(threadId: string, turnId: string, options?: { discard?: boolean }): Promise<void> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadInterruptPath(threadId, turnId),
      'POST',
      JSON.stringify({ discard: options?.discard === true })
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to interrupt turn'))
    }
  }

  async renameThread(threadId: string, title: string): Promise<void> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadPath(threadId),
      'PATCH',
      JSON.stringify({ title })
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'rename thread failed'))
    }
  }

  async updateThreadWorkspace(threadId: string, workspace: string): Promise<void> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadPath(threadId),
      'PATCH',
      JSON.stringify({ workspace })
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'update thread workspace failed'))
    }
  }

  async archiveThread(threadId: string, archived: boolean): Promise<void> {
    const response = await window.workwise.runtimeRequest(
      runtimeThreadPath(threadId),
      'PATCH',
      JSON.stringify({ status: archived ? 'archived' : 'idle' })
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'archive thread failed'))
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    const response = await rendererRuntimeClient.runtimeRequest(runtimeThreadPath(threadId), 'DELETE')
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'delete thread failed'))
    }
  }

  async compactThread(threadId: string, reason?: string): Promise<void> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadCompactPath(threadId),
      'POST',
      JSON.stringify({ reason: reason?.trim() || undefined })
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'compact thread failed'))
    }
  }

  async getThreadGoal(threadId: string): Promise<NonNullable<NormalizedThread['goal']> | null> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadGoalPath(threadId),
      'GET'
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to load thread goal'))
    }
    const body = readRuntimeJson<CoreThreadGoalResponseJson>(
      response.body,
      'runtime returned an invalid thread goal response'
    )
    return body.goal ? goalFromCore(body.goal) : null
  }

  async setThreadGoal(
    threadId: string,
    patch: {
      objective?: string
      status?: NonNullable<NormalizedThread['goal']>['status']
      tokenBudget?: number | null
    }
  ): Promise<NonNullable<NormalizedThread['goal']>> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadGoalPath(threadId),
      'POST',
      JSON.stringify(patch)
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to set thread goal'))
    }
    const body = readRuntimeJson<CoreThreadGoalResponseJson>(
      response.body,
      'runtime returned an invalid thread goal response'
    )
    if (!body.goal) {
      throw runtimeErrorToError({
        code: 'unknown',
        message: 'set thread goal returned an invalid response'
      })
    }
    return goalFromCore(body.goal)
  }

  async clearThreadGoal(threadId: string): Promise<boolean> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadGoalPath(threadId),
      'DELETE'
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to clear thread goal'))
    }
    return readRuntimeJson<CoreClearThreadGoalResponseJson>(
      response.body,
      'runtime returned an invalid clear thread goal response'
    ).cleared
  }

  async getThreadTodos(threadId: string): Promise<NonNullable<NormalizedThread['todos']> | null> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadTodosPath(threadId),
      'GET'
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to load thread todos'))
    }
    const body = readRuntimeJson<CoreThreadTodosResponseJson>(
      response.body,
      'runtime returned an invalid thread todos response'
    )
    return body.todos ? todosFromCore(body.todos) : null
  }

  async setThreadTodos(
    threadId: string,
    todos: Parameters<NonNullable<AgentProvider['setThreadTodos']>>[1]
  ): Promise<NonNullable<NormalizedThread['todos']>> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadTodosPath(threadId),
      'POST',
      JSON.stringify({ todos })
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to set thread todos'))
    }
    const body = readRuntimeJson<CoreThreadTodosResponseJson>(
      response.body,
      'runtime returned an invalid thread todos response'
    )
    if (!body.todos) {
      throw runtimeErrorToError({
        code: 'unknown',
        message: 'set thread todos returned an invalid response'
      })
    }
    return todosFromCore(body.todos)
  }

  async clearThreadTodos(threadId: string): Promise<boolean> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeThreadTodosPath(threadId),
      'DELETE'
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to clear thread todos'))
    }
    return readRuntimeJson<CoreClearThreadTodosResponseJson>(
      response.body,
      'runtime returned an invalid clear thread todos response'
    ).cleared
  }

  async submitApprovalDecision(
    approvalId: string,
    decision: 'allow' | 'deny'
  ): Promise<void> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeApprovalPath(approvalId),
      'POST',
      JSON.stringify({ decision })
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'approval decision failed'))
    }
  }

  async submitUserInputResponse(inputId: string, answers: UserInputAnswer[]): Promise<void> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeUserInputPath(inputId),
      'POST',
      JSON.stringify({ answers })
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'request_user_input response failed'))
    }
  }

  async cancelUserInput(inputId: string): Promise<void> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeUserInputPath(inputId),
      'POST',
      JSON.stringify({ cancelled: true })
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'request_user_input cancel failed'))
    }
  }

  async getRuntimeInfo(): Promise<CoreRuntimeInfoJson> {
    const response = await rendererRuntimeClient.runtimeRequest(RUNTIME_INFO_PATH, 'GET')
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to load runtime info'))
    }
    return readRuntimeJson<CoreRuntimeInfoJson>(
      response.body,
      'runtime returned an invalid runtime info response'
    )
  }

  async getToolDiagnostics(): Promise<CoreRuntimeToolDiagnosticsJson> {
    const response = await rendererRuntimeClient.runtimeRequest(RUNTIME_TOOLS_PATH, 'GET')
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to load runtime diagnostics'))
    }
    return readRuntimeJson<CoreRuntimeToolDiagnosticsJson>(
      response.body,
      'runtime returned an invalid runtime diagnostics response'
    )
  }

  async listSkills(): Promise<CoreRuntimeSkillJson[]> {
    const response = await rendererRuntimeClient.runtimeRequest(RUNTIME_SKILLS_PATH, 'GET')
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to list skills'))
    }
    return readRuntimeJson<CoreRuntimeSkillsResponseJson>(
      response.body,
      'runtime returned an invalid skills response'
    ).skills ?? []
  }

  async uploadAttachment(input: {
    name: string
    mimeType?: string
    dataBase64: string
    textFallback?: CoreAttachmentTextFallbackJson
    threadId?: string
    workspace?: string
  }): Promise<CoreAttachmentMetadataJson> {
    const response = await rendererRuntimeClient.runtimeRequest(
      RUNTIME_ATTACHMENTS_PATH,
      'POST',
      JSON.stringify(input)
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'attachment upload failed'))
    }
    return readRuntimeJson<CoreAttachmentUploadResponseJson>(
      response.body,
      'runtime returned an invalid attachment upload response'
    ).attachment
  }

  async getAttachmentDiagnostics(): Promise<CoreAttachmentDiagnosticsJson> {
    const response = await rendererRuntimeClient.runtimeRequest(RUNTIME_ATTACHMENT_DIAGNOSTICS_PATH, 'GET')
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to load attachment diagnostics'))
    }
    return readRuntimeJson<CoreAttachmentDiagnosticsJson>(
      response.body,
      'runtime returned an invalid attachment diagnostics response'
    )
  }

  async getAttachmentContent(
    attachmentId: string,
    options: { threadId?: string; workspace?: string } = {}
  ): Promise<CoreAttachmentContentResponseJson> {
    const query = buildQuery({
      thread_id: options.threadId,
      workspace: options.workspace
    })
    const response = await rendererRuntimeClient.runtimeRequest(
      `${runtimeAttachmentContentPath(attachmentId)}${query}`,
      'GET'
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to load attachment content'))
    }
    return readRuntimeJson<CoreAttachmentContentResponseJson>(
      response.body,
      'runtime returned an invalid attachment content response'
    )
  }

  async listMemories(options: { workspace?: string; includeDeleted?: boolean } = {}): Promise<CoreMemoryRecordJson[]> {
    const query = buildQuery({
      workspace: options.workspace,
      include_deleted: options.includeDeleted
    })
    const response = await rendererRuntimeClient.runtimeRequest(`${RUNTIME_MEMORY_PATH}${query}`, 'GET')
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to list memories'))
    }
    return readRuntimeJson<CoreMemoryListResponseJson>(
      response.body,
      'runtime returned an invalid memory list response'
    ).memories ?? []
  }

  async updateMemory(
    memoryId: string,
    patch: { content?: string; tags?: string[]; confidence?: number; disabled?: boolean }
  ): Promise<CoreMemoryRecordJson> {
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeMemoryRecordPath(memoryId),
      'PATCH',
      JSON.stringify(patch)
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to update memory'))
    }
    return readRuntimeJson<{ memory: CoreMemoryRecordJson }>(
      response.body,
      'runtime returned an invalid memory response'
    ).memory
  }

  async deleteMemory(memoryId: string): Promise<CoreMemoryRecordJson> {
    const response = await rendererRuntimeClient.runtimeRequest(runtimeMemoryRecordPath(memoryId), 'DELETE')
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to delete memory'))
    }
    return readRuntimeJson<{ memory: CoreMemoryRecordJson }>(
      response.body,
      'runtime returned an invalid memory response'
    ).memory
  }

  async getMemoryDiagnostics(): Promise<CoreMemoryDiagnosticsJson> {
    const response = await rendererRuntimeClient.runtimeRequest(RUNTIME_MEMORY_DIAGNOSTICS_PATH, 'GET')
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'failed to load memory diagnostics'))
    }
    return readRuntimeJson<CoreMemoryDiagnosticsJson>(
      response.body,
      'runtime returned an invalid memory diagnostics response'
    )
  }

  async forkThread(
    threadId: string,
    options?: { relation?: 'primary' | 'fork' | 'side'; title?: string }
  ): Promise<NormalizedThread> {
    const body: Record<string, unknown> = {}
    if (options?.relation) body.relation = options.relation
    if (options?.title) body.title = options.title
    const url = runtimeThreadForkPath(threadId)
    const response =
      Object.keys(body).length > 0
        ? await rendererRuntimeClient.runtimeRequest(url, 'POST', JSON.stringify(body))
        : await rendererRuntimeClient.runtimeRequest(url, 'POST')
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'fork thread failed'))
    }
    return threadFromCore(readRuntimeJson<CoreThreadJson>(
      response.body,
      'runtime returned an invalid thread response'
    ))
  }

  async resumeSession(
    sessionId: string,
    options?: { model?: string; mode?: RuntimeThreadMode }
  ): Promise<{ threadId: string; sessionId: string }> {
    const settings = await rendererRuntimeClient.getSettings()
    const runtime = getManagedRuntimeSettings(settings)
    const response = await rendererRuntimeClient.runtimeRequest(
      runtimeSessionResumePath(sessionId),
      'POST',
      JSON.stringify({
        workspace: settings.workspaceRoot || undefined,
        model: options?.model?.trim() || runtime.model,
        mode: options?.mode
      })
    )
    if (!response.ok) {
      throw runtimeErrorToError(readRuntimeError(response.body, 'resume session failed'))
    }
    const body = readRuntimeJson<CoreResumeSessionResponseJson>(
      response.body,
      'runtime returned an invalid resume session response'
    )
    const threadId = body.thread_id ?? body.threadId
    if (!threadId) {
      throw runtimeErrorToError({
        code: 'unknown',
        message: 'resume session returned an invalid response'
      })
    }
    return { threadId, sessionId: body.session_id ?? body.sessionId ?? sessionId }
  }

  async subscribeThreadEvents(
    threadId: string,
    sinceSeq: number,
    sink: ThreadEventSink,
    signal: AbortSignal
  ): Promise<void> {
    const streamId = createSseStreamId()
    await new Promise<void>(async (resolve) => {
      let settled = false
      const pendingDispatches = new Set<Promise<void>>()
      // Preserve runtime event order even when an earlier batch pauses for an
      // approval/replay operation. Without a single chain, a later usage
      // delta can arrive before the exact usage snapshot that precedes it.
      let dispatchChain: Promise<void> = Promise.resolve()
      const finish = (): void => {
        if (settled) return
        settled = true
        offData()
        offEnd()
        offErr()
        signal.removeEventListener('abort', onAbort)
        void Promise.allSettled([...pendingDispatches]).then(() => resolve())
      }
      const offData = rendererRuntimeClient.onSseEvent((payload) => {
        if (payload.streamId !== streamId) return
        // Older main processes (pre-batching) deliver a single event under
        // `data`; accept both shapes so a stale main/renderer pair during a
        // dev reload or partial update degrades gracefully instead of
        // silently dropping the stream.
        const legacySingle = (payload as { data?: unknown }).data
        const rawEvents = Array.isArray(payload.events)
          ? payload.events
          : legacySingle !== undefined
            ? [legacySingle]
            : []
        const batch = rawEvents.map((entry): CoreRuntimeEventJson =>
          entry && typeof entry === 'object' ? (entry as CoreRuntimeEventJson) : {}
        )
        if (batch.length === 0) return
        let maxSeq: number | null = null
        for (const event of batch) {
          if (typeof event.seq === 'number') {
            maxSeq = maxSeq === null ? event.seq : Math.max(maxSeq, event.seq)
          }
        }
        if (maxSeq !== null) {
          sink.onSeq(maxSeq)
        }
        const replayReset = batch.find((event) => event.kind === 'replay_reset')
        const eventsToDispatch = replayReset
          ? batch.filter((event) => event.kind !== 'replay_reset')
          : batch
        const task = dispatchChain.then(async () => {
          if (replayReset && typeof replayReset.seq === 'number') {
            await sink.onReplayReset?.(replayReset.seq)
          }
          await dispatchRuntimeEvents(eventsToDispatch, sink, (runtimeEvent, eventSink) =>
            this.handleApprovalRequest(runtimeEvent, eventSink)
          )
        }).finally(() => {
          pendingDispatches.delete(task)
        })
        // Keep the chain alive after a failed batch so a transient approval
        // error cannot prevent subsequent runtime events from being applied.
        dispatchChain = task.catch(() => undefined)
        pendingDispatches.add(task)
      })
      const offErr = rendererRuntimeClient.onSseError(({ streamId: sid, message, status }) => {
        if (sid !== streamId) return
        sink.onError(new Error(message ?? `sse error ${status ?? ''}`))
        finish()
      })
      const offEnd = rendererRuntimeClient.onSseEnd(({ streamId: sid }) => {
        if (sid !== streamId) return
        finish()
      })
      const onAbort = (): void => {
        void rendererRuntimeClient.stopSse(streamId)
        finish()
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        await rendererRuntimeClient.startSse(threadId, sinceSeq, streamId)
      } catch (error) {
        sink.onError(error instanceof Error ? error : new Error(String(error)))
        finish()
      }
    })
    void rendererRuntimeClient.stopSse(streamId)
  }

  private async handleApprovalRequest(event: CoreRuntimeEventJson, sink: ThreadEventSink): Promise<void> {
    const approvalId = event.approvalId ?? event.itemId ?? ''
    if (!approvalId) return
    try {
      const eventPolicy = normalizeApprovalPolicy(event.approvalPolicy)
      const policy = eventPolicy ?? getManagedRuntimeSettings(await rendererRuntimeClient.getSettings()).approvalPolicy
      switch (policy) {
        case 'auto':
          await this.submitApprovalDecision(approvalId, 'allow')
          return
        case 'never':
          await this.submitApprovalDecision(approvalId, 'deny')
          return
        case 'on-request':
        case 'suggest':
        case 'untrusted':
          break
      }
    } catch {
      /* Fall through and render the approval card. */
    }
    sink.onApproval({
      approvalId,
      threadId: event.threadId,
      turnId: event.turnId,
      summary: event.summary ?? 'Approval required',
      toolName: event.toolName,
      ...(event.child ? { meta: { child: event.child } } : {})
    })
  }
}

export { runtimeThreadEventsPath }
