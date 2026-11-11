import type { WorkspaceTrustReader } from '../services/workspace-trust-reader.js'
import type { ExecutionGrant, ExecutionScope } from '../contracts/permissions.js'
import { InMemoryApprovalGate } from '../adapters/in-memory-approval-gate.js'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemoryUserInputGate } from '../adapters/in-memory-user-input-gate.js'
import { FileSessionStore } from '../adapters/file/file-session-store.js'
import { FileThreadStore } from '../adapters/file/file-thread-store.js'
import { atomicWriteFile } from '../adapters/file/atomic-write.js'
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { canonicalWorkspace } from '../memory/memory-store.js'
import { setSystemPrompt, type ImmutablePrefix } from '../cache/immutable-prefix.js'
import type { ModelCapabilityMetadata } from '../contracts/capabilities.js'
import type { TurnItem } from '../contracts/items.js'
import type { StartTurnRequest } from '../contracts/turns.js'
import type { ApprovalPolicy, SandboxMode } from '../contracts/policy.js'
import type { ThreadRecord, ThreadAgentProfile } from '../contracts/threads.js'
import type { ApprovalGate } from '../ports/approval-gate.js'
import type { UserInputGate } from '../ports/user-input-gate.js'
import type { EventBus } from '../ports/event-bus.js'
import type { RuntimeTuningConfig } from '../config/kun-config.js'
import { AgentLoop } from '../loop/agent-loop.js'
import type { ContextCompactionConfig, ModelConfig } from '../loop/model-context-profile.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import type { TokenEconomyConfig } from '../loop/token-economy.js'
import type { MemoryStore } from '../memory/memory-store.js'
import type { ModelClient } from '../ports/model-client.js'
import { RandomIdGenerator } from '../ports/id-generator.js'
import type { ToolHost } from '../ports/tool-host.js'
import type { SkillRuntime } from '../skills/skill-runtime.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { ThreadService } from '../services/thread-service.js'
import { TurnService } from '../services/turn-service.js'
import { TaskController } from '../services/task-controller.js'
import type { TaskRunRepository } from '../services/task-run-repository.js'
import type { CapacityManager } from '../services/capacity-manager.js'
import { UsageService } from '../services/usage-service.js'
import type { ChildRunExecutor } from './delegation-runtime.js'
import { childDraftToolHost } from './child-draft-tool-host.js'
import { resolveWorkspacePath } from '../adapters/tool/builtin-tool-utils.js'
import { intersectGrantedPaths } from '../services/execution-permission-scope.js'

export type ChildAgentExecutorOptions = {
  workspaceTrust?: WorkspaceTrustReader
  executionScope?: (threadId: string, turnId: string) => Promise<ExecutionScope>
  validateTaskPermission?: (threadId: string, permissionId?: string) => Promise<unknown>
  claimTaskPermission?: (threadId: string, permissionId: string, operationId: string) => Promise<void>
  dataDir?: string
  parentContext?: (threadId: string, turnId: string) => Promise<ThreadRecord | null>
  approvalGate?: ApprovalGate
  userInputGate?: UserInputGate
  eventBus?: EventBus
  parentSelection?: (threadId: string, turnId: string) => Promise<Pick<StartTurnRequest, 'model' | 'providerId' | 'reasoningEffort'>>
  model: ModelClient
  toolHost: ToolHost
  prefix: ImmutablePrefix
  defaultModel: string
  models?: ModelConfig
  contextCompaction?: ContextCompactionConfig
  approvalPolicy?: ApprovalPolicy
  sandboxMode?: SandboxMode
  tokenEconomy?: TokenEconomyConfig
  runtime?: RuntimeTuningConfig
  nowIso?: () => string
  modelCapabilities?: (model: string) => ModelCapabilityMetadata
  skillRuntime?: SkillRuntime
  memoryStore?: MemoryStore
  taskRepository?: TaskRunRepository
  taskController?: TaskController
  capacityManager?: CapacityManager
}

export function createChildAgentExecutor(options: ChildAgentExecutorOptions): ChildRunExecutor {
  return async (input) => {
    const nowIso = options.nowIso ?? (() => new Date().toISOString())
    if (!/^[a-zA-Z0-9_-]+$/.test(input.childId)) throw new Error('invalid child session id')
    const eventBus = options.eventBus ?? new InMemoryEventBus()
    const sessionStore = options.dataDir ? new FileSessionStore({ dataDir: options.dataDir }) : new InMemorySessionStore()
    const threadStore = options.dataDir ? new FileThreadStore({ dataDir: options.dataDir }) : new InMemoryThreadStore()
    const parent = await options.parentContext?.(input.parentThreadId, input.parentTurnId)
    if (options.parentContext && !parent) throw new Error('parent authority is unavailable; child task cannot continue')
    const parentGrant = parent?.turns.find(turn => turn.id === input.parentTurnId)?.executionGrant
    if (options.workspaceTrust && options.parentContext && !parentGrant) {
      throw Object.assign(new Error('Parent execution grant is unavailable; child permissions cannot be inferred.'), { code: 'execution_grant_scope' })
    }
    const parentWorkspace = parent?.workspace
    const requestedWorkspace = input.workspace?.trim() || parentWorkspace || '~'
    if (parentWorkspace && !isWithinWorkspace(parentWorkspace, requestedWorkspace)) {
      throw new Error('child workspace is outside the parent task authority')
    }
    const previous = await threadStore.get(input.childId)
    const previousItems = await sessionStore.loadItems(input.childId)
    if (input.recovering && unresolvedToolCalls(previousItems).length) {
      throw Object.assign(new Error('child_operation_outcome_unknown: inspect unresolved tool calls before resuming; no operation was replayed'), { code: 'child_operation_outcome_unknown' })
    }
    if (previous) {
      const last = previous.turns.at(-1)
      if (last?.status === 'completed') {
        const usageEvents = await sessionStore.loadEventsSince(input.childId, 0)
        const lastUsage = [...usageEvents].reverse().find(event => event.kind === 'usage')
        return {
          summary: summarizeChildTurn(previousItems, last.id, 'completed'),
          ...(lastUsage?.kind === 'usage' ? { usage: lastUsage.usage } : {}),
          sessionRef: `threads/${input.childId}`,
          handoff: childHandoff(previousItems, last.id, 'completed')
        }
      }
      const turns = previous.turns.map(turn => turn.status === 'running' ? { ...turn, status: 'aborted' as const } : turn)
      await threadStore.upsert({ ...previous, status: 'idle', turns })
    }
    const usage = new UsageService()
    const ids = new RandomIdGenerator()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const compactor = new ContextCompactor({
      contextCompaction: options.contextCompaction,
      models: options.models
    })
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (threadId) => eventBus.highestSeq(threadId) + 1,
      nowIso
    })
    const tasks = options.taskRepository ? new TaskController({ repository: options.taskRepository, threadStore, sessionStore, nowIso }) : undefined
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor,
      ids,
      nowIso,
      ...(tasks ? { tasks } : {})
    })
    const threads = new ThreadService({
      threadStore,
      sessionStore,
      events,
      ids,
      nowIso
    })
    const inheritedSelection = await options.parentSelection?.(input.parentThreadId, input.parentTurnId)
    const model = input.model?.trim() || inheritedSelection?.model || options.defaultModel
    const created = previous ?? await threads.create({
      title: childThreadTitle(input.childId, input.label),
      workspace: requestedWorkspace,
      model,
      mode: 'agent',
      approvalPolicy: parent?.approvalPolicy ?? options.approvalPolicy ?? 'auto',
      sandboxMode: parent?.sandboxMode ?? options.sandboxMode,
      ...(parent?.projectId ? { projectId: parent.projectId } : {}),
      ...(parent?.costBudgetUsd ? { costBudgetUsd: parent.costBudgetUsd } : {})
    }, {
      id: input.childId,
      title: childThreadTitle(input.childId, input.label)
    })
    const thread: ThreadRecord = {
      ...created,
      status: 'idle',
      turns: previous ? (await threadStore.get(input.childId))!.turns : created.turns,
      workspace: requestedWorkspace,
      relation: 'side',
      parentThreadId: input.parentThreadId,
      approvalPolicy: intersectApproval(created.approvalPolicy, parent?.approvalPolicy),
      sandboxMode: intersectSandbox(created.sandboxMode, parent?.sandboxMode),
      ...(parent?.agentProfile ? { agentProfile: intersectProfile(created.agentProfile, parent.agentProfile) } : {}),
      ...(parent?.projectId ? { projectId: parent.projectId } : {})
    }
    await threadStore.upsert(thread)
    const usageEvents = await sessionStore.loadEventsSince(thread.id, 0)
    const previousUsage = [...usageEvents].reverse().find(event => event.kind === 'usage')
    if (previousUsage?.kind === 'usage') usage.seedThread(thread.id, previousUsage.usage)
    const currentWorkspaceTrust = await options.workspaceTrust?.get(thread.workspace)
    const parentWorkspaceTrust = parentGrant ? await options.workspaceTrust?.get(parentGrant.workspaceRoot) : undefined
    if (parentGrant && parentWorkspaceTrust && (
      parentWorkspaceTrust.revision !== parentGrant.workspaceRevision
      || parentWorkspaceTrust.level !== parentGrant.workspaceTrust
    )) throw Object.assign(new Error('Workspace trust changed before child dispatch.'), { code: 'execution_grant_revoked' })
    const stagingAllowed = !options.workspaceTrust || (
      currentWorkspaceTrust?.level !== 'read-only'
      && parentGrant?.workspaceTrust !== 'read-only'
      && parentGrant?.agentTrust !== 'read-only'
      && thread.sandboxMode !== 'read-only'
      && thread.sandboxMode !== 'external-sandbox'
    )
    const stagingDirectory = options.dataDir && stagingAllowed ? (await resolveWorkspacePath(join('.workwise','task-staging',input.childId),{threadId:thread.id,turnId:input.parentTurnId,workspace:thread.workspace,approvalPolicy:thread.approvalPolicy,sandboxMode:thread.sandboxMode,abortSignal:input.signal,awaitApproval:async()=> 'deny'})).absolutePath : undefined
    if (stagingDirectory) await mkdir(stagingDirectory, { recursive: true })
    const childInstructions = [
      stagingDirectory ? `Child staging directory: ${stagingDirectory}.` : '',
      'Read only authorized sources in the workspace. When the assignment requires file output, use propose_document for Markdown candidates in this child task\'s isolated directory and export_document for task-owned exports. Shell and arbitrary document mutations are unavailable. Final changes to user documents require the parent document review service.'
    ].filter(Boolean).join('\n')
    const loop = new AgentLoop({
      validateTaskPermission: async () => {
        await options.validateTaskPermission?.(input.parentThreadId, parentGrant?.taskPermissionId)
        const currentParent = await options.parentContext?.(input.parentThreadId, input.parentTurnId)
        if (parentGrant && options.parentContext && (!currentParent || (currentParent.agentRevision ?? 0) !== parentGrant.agentRevision)) {
          throw Object.assign(new Error('Parent Agent authority changed before child dispatch.'), { code: 'execution_grant_revoked' })
        }
        const workspace = parentGrant ? await options.workspaceTrust?.get(parentGrant.workspaceRoot) : undefined
        if (parentGrant && workspace && (workspace.revision !== parentGrant.workspaceRevision || workspace.level !== parentGrant.workspaceTrust)) {
          throw Object.assign(new Error('Parent workspace authority changed before child dispatch.'), { code: 'execution_grant_revoked' })
        }
      },
      claimTaskPermission: options.claimTaskPermission ? (_threadId, permissionId, operationId) => options.claimTaskPermission!(input.parentThreadId, permissionId, `child:${input.childId}:${operationId}`) : undefined,
      ...(options.workspaceTrust ? { workspaceTrust: options.workspaceTrust } : {}),
      ...(parentGrant ? { executionScope: async () => intersectChildExecutionScope(
        parentGrant,
        thread.workspace,
        // Refresh the original task's provider configuration. The child has
        // its own store, so looking up its ID in the root store loses intent.
        await options.executionScope?.(input.parentThreadId, input.parentTurnId)
      ) } : {}),
      threadStore,
      sessionStore,
      approvalGate: options.approvalGate ?? new InMemoryApprovalGate(),
      userInputGate: options.userInputGate ?? new InMemoryUserInputGate(),
      model: options.model,
      toolHost: childDraftToolHost(options.toolHost),
      usage,
      events,
      turns,
      inflight,
      steering,
      compactor,
      // Runtime capability instructions are not part of the user assignment.
      // Keeping them in the system prefix avoids manufacturing file deliverables.
      prefix: setSystemPrompt(options.prefix, [options.prefix.systemPrompt, childInstructions].filter(Boolean).join('\n\n')),
      ids,
      nowIso,
      ...(tasks ? { tasks } : {}),
      ...(options.capacityManager ? { capacityManager: options.capacityManager } : {}),
      ...(options.modelCapabilities ? { modelCapabilities: options.modelCapabilities } : {}),
      ...(options.skillRuntime ? { skillRuntime: options.skillRuntime } : {}),
      ...(options.memoryStore ? { memoryStore: options.memoryStore } : {}),
      ...(options.contextCompaction ? { contextCompaction: options.contextCompaction } : {}),
      ...(options.tokenEconomy ? { tokenEconomy: options.tokenEconomy } : {}),
      ...(options.runtime?.toolStorm ? { toolStorm: options.runtime.toolStorm } : {}),
      ...(options.runtime?.toolArgumentRepair ? { toolArgumentRepair: options.runtime.toolArgumentRepair } : {})
    })
    const started = await turns.startTurn({
      threadId: thread.id,
      ...(tasks?.activeTask(thread.id) ? { continuationTaskId: tasks.activeTask(thread.id)!.id } : {}),
      request: {
        ...inheritedSelection,
        prompt: [input.recovering ? 'Continue the original assignment using the persisted conversation and verified tool results. Completed operations are evidence; do not repeat them.' : '', input.prompt].filter(Boolean).join('\n\n'),
        model,
        taskIntent: 'supplement',
        mode: 'agent'
      }
    })
    const onAbort = () => turns.abortTurn(started.turnId, 'parent_task_cancelled')
    input.signal.addEventListener('abort', onAbort, { once: true })
    if (input.signal.aborted) onAbort()
    let status: 'completed' | 'failed' | 'aborted'
    tasks?.startWatchdog({ onLeaseLost: () => turns.abortTurn(started.turnId, 'task_lease_lost') })
    try { status = await loop.runTurn(thread.id, started.turnId) }
    finally { tasks?.stopWatchdog(); input.signal.removeEventListener('abort', onAbort) }
    const runtimeError = (await sessionStore.loadEventsSince(thread.id, 0))
      .find((event) => event.kind === 'error' && event.turnId === started.turnId)
    if (runtimeError?.kind === 'error') {
      throw new Error(runtimeError.message)
    }
    const items = await sessionStore.loadItems(thread.id)
    const summary = summarizeChildTurn(items, started.turnId, status)
    if (status !== 'completed') {
      throw new Error(summary || `child agent ${status}`)
    }
    const handoff = childHandoff(items, started.turnId, status)
    if (options.dataDir) await atomicWriteFile(join(options.dataDir, 'threads', input.childId, 'handoff.json'), JSON.stringify(handoff, null, 2))
    return {
      summary,
      usage: usage.forThread(thread.id),
      sessionRef: `threads/${input.childId}`,
      handoff
    }
  }
}

function childThreadTitle(childId: string, label?: string): string {
  const suffix = label?.trim() || childId
  return `Child agent: ${suffix}`
}

function summarizeChildTurn(
  items: readonly TurnItem[],
  turnId: string,
  status: 'completed' | 'failed' | 'aborted'
): string {
  const turnItems = items.filter((item) => item.turnId === turnId)
  const assistantText = turnItems
    .filter((item): item is Extract<TurnItem, { kind: 'assistant_text' }> => item.kind === 'assistant_text')
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim()
  if (assistantText) return assistantText
  const errors = turnItems
    .filter((item): item is Extract<TurnItem, { kind: 'error' }> => item.kind === 'error')
    .map((item) => item.message.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  if (errors) return errors
  const toolResult = [...turnItems]
    .reverse()
    .find((item): item is Extract<TurnItem, { kind: 'tool_result' }> => item.kind === 'tool_result')
  if (toolResult) return stringifySummary(toolResult.output)
  return status === 'completed'
    ? 'Child agent completed without a text response.'
    : `Child agent ${status}.`
}

function stringifySummary(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value == null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function isWithinWorkspace(parent: string, requested: string): boolean {
  const path = relative(canonicalWorkspace(parent), canonicalWorkspace(requested))
  return path === '' || (!path.startsWith('..') && !path.startsWith('/') && !/^[a-zA-Z]:/.test(path))
}

function intersectApproval(stored: ApprovalPolicy, parent?: ApprovalPolicy): ApprovalPolicy {
  if (!parent || stored === parent) return stored
  if (stored === 'suggest' || parent === 'suggest') return 'suggest'
  if (stored === 'untrusted' || parent === 'untrusted') return 'untrusted'
  if (stored === 'on-request' || parent === 'on-request') return 'on-request'
  return parent
}

function intersectSandbox(stored: SandboxMode, parent?: SandboxMode): SandboxMode {
  if (!parent || stored === parent) return stored
  if (stored === 'read-only' || parent === 'read-only') return 'read-only'
  if (stored === 'external-sandbox' || parent === 'external-sandbox') return 'external-sandbox'
  if (stored === 'workspace-write' || parent === 'workspace-write') return 'workspace-write'
  return parent
}

function intersectAllowlist(stored: string[] | undefined, parent: string[]): string[] {
  if (!stored || stored.includes('*')) return [...parent]
  if (parent.includes('*')) return [...stored]
  return stored.filter(name => parent.includes(name))
}

function intersectProfile(stored: ThreadAgentProfile | undefined, parent: ThreadAgentProfile): ThreadAgentProfile {
  const levels = ['read-only', 'workspace-write', 'trusted', 'full-access'] as const
  const trustLevel = levels[Math.min(levels.indexOf(stored?.trustLevel ?? parent.trustLevel), levels.indexOf(parent.trustLevel))]!
  const costs = [stored?.budget.maxCostUsd, parent.budget.maxCostUsd].filter((value): value is number => value !== undefined)
  return {
    ...parent,
    toolAllowlist: intersectAllowlist(stored?.toolAllowlist, parent.toolAllowlist),
    mcpAllowlist: intersectAllowlist(stored?.mcpAllowlist, parent.mcpAllowlist),
    trustLevel,
    budget: {
      maxAttempts: Math.min(stored?.budget.maxAttempts ?? parent.budget.maxAttempts, parent.budget.maxAttempts),
      maxDurationMs: Math.min(stored?.budget.maxDurationMs ?? parent.budget.maxDurationMs, parent.budget.maxDurationMs),
      ...(costs.length ? { maxCostUsd: Math.min(...costs) } : {})
    }
  }
}

function unresolvedToolCalls(items: readonly TurnItem[]): Extract<TurnItem, { kind: 'tool_call' }>[] {
  const completed = new Set(items.filter(item => item.kind === 'tool_result').map(item => item.callId))
  return items.filter((item): item is Extract<TurnItem, { kind: 'tool_call' }> => item.kind === 'tool_call' && !completed.has(item.callId))
}

function childHandoff(items: readonly TurnItem[], turnId: string, status: 'completed' | 'failed' | 'aborted') {
  return {
    summary: summarizeChildTurn(items, turnId, status),
    evidenceItemIds: items.filter(item => item.kind === 'tool_result').map(item => item.id),
    completedOperationIds: items.filter((item): item is Extract<TurnItem, { kind: 'tool_result' }> => item.kind === 'tool_result' && !item.isError).map(item => item.callId),
    pendingOperationIds: unresolvedToolCalls(items).map(item => item.callId),
    status
  }
}

export function intersectChildExecutionScope(
  parent: ExecutionGrant,
  childWorkspace: string,
  current?: ExecutionScope
): ExecutionScope {
  const workspace = canonicalWorkspace(childWorkspace)
  const parentPaths = parent.pathAllowlist.includes('*') ? [workspace] : parent.pathAllowlist
  const currentPaths = current?.pathAllowlist ?? ['*']
  const childPaths = currentPaths.includes('*') ? [workspace] : currentPaths
  const pathAllowlist = intersectPaths(parentPaths, childPaths).filter(path => isWithinWorkspace(workspace, path))
  const allowedProviderIds = intersectOptional(parent.allowedProviderIds, current?.allowedProviderIds)
  const allowedToolNames = intersectScope(parent.allowedToolNames ?? [], current?.allowedToolNames ?? ['*'])
  const expiresAt = earliestExpiry(parent.expiresAt, current?.expiresAt)
  for (const [provider, identity] of Object.entries(parent.connectorIdentityFingerprints ?? {})) {
    if (current?.connectorIdentityFingerprints?.[provider] !== identity || current?.connectorBackends?.[provider] !== parent.connectorBackends?.[provider]) {
      throw Object.assign(new Error('Parent connector identity changed before child dispatch.'), { code: 'execution_grant_revoked' })
    }
  }
  return {
    allowedToolNames,
    ...(allowedProviderIds ? { allowedProviderIds } : {}),
    pathAllowlist,
    ...(parent.readPathAllowlist ? { readPathAllowlist: intersectGrantedPaths(intersectGrantedPaths(parent.readPathAllowlist, current?.readPathAllowlist ?? current?.permissionScope?.readPaths), pathAllowlist) } : {}),
    ...(parent.writePathAllowlist ? { writePathAllowlist: intersectGrantedPaths(intersectGrantedPaths(parent.writePathAllowlist, current?.writePathAllowlist ?? current?.permissionScope?.writePaths), pathAllowlist) } : {}),
    // A child may only use externally scoped access that remains present in
    // the current provider configuration as well as the parent grant.
    networkAllowlist: intersectScope(parent.networkAllowlist, current?.networkAllowlist ?? []),
    connectorScopes: intersectScope(parent.connectorScopes, current?.connectorScopes ?? []),
    externalTargets: intersectScope(parent.externalTargets, current?.externalTargets ?? []),
    ...(parent.connectorIdentityFingerprints ? { connectorIdentityFingerprints: parent.connectorIdentityFingerprints } : {}),
    ...(parent.connectorBackends ? { connectorBackends: parent.connectorBackends } : {}),
    ...(parent.taskPermissionId ? { taskPermissionId: parent.taskPermissionId } : {}),
    ...(parent.permissionDuration ? { permissionDuration: parent.permissionDuration } : {}),
    ...(expiresAt ? { expiresAt } : {})
  }
}

function intersectPaths(parent: readonly string[], current: readonly string[]): string[] {
  const result = new Set<string>()
  for (const left of parent) for (const right of current) {
    if (isWithinWorkspace(left, right)) result.add(canonicalWorkspace(right))
    else if (isWithinWorkspace(right, left)) result.add(canonicalWorkspace(left))
  }
  return [...result]
}

function intersectScope(parent: readonly string[], child: readonly string[]): string[] {
  if (parent.includes('*')) return [...child]
  if (child.includes('*')) return [...parent]
  return parent.filter(value => child.includes(value))
}

function intersectOptional(parent: readonly string[] | undefined, child: readonly string[] | undefined): string[] | undefined {
  if (!parent) return child ? [...child] : undefined
  if (!child) return [...parent]
  return intersectScope(parent, child)
}

function earliestExpiry(parent: string | undefined, child: string | undefined): string | undefined {
  if (!parent) return child
  if (!child) return parent
  return Date.parse(parent) <= Date.parse(child) ? parent : child
}
