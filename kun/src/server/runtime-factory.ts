import { SurveyQualityAssessmentService } from '../engineering/survey-quality-assessment.js'
import { SurveyEvidenceReader } from '../engineering/survey-evidence-reader.js'
import { SurveyQualityScoringWorkspaceService } from '../engineering/survey-quality-scoring-workspace.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { buildRouter } from './routes/index.js'
import type { ServerRuntime } from './routes/server-runtime.js'
import { startNodeHttpServer, type NodeHttpServerHandle } from './node-http-server.js'
import { FileAttachmentStore } from '../attachments/attachment-store.js'
import { InMemoryApprovalGate } from '../adapters/in-memory-approval-gate.js'
import { InMemoryUserInputGate } from '../adapters/in-memory-user-input-gate.js'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { FileSessionStore, FileThreadStore } from '../adapters/file/index.js'
import { HybridSessionStore, HybridThreadStore } from '../adapters/hybrid/index.js'
import { DeepseekCompatModelClient } from '../adapters/model/deepseek-compat-model-client.js'
import { ProviderRoutingModelClient, unavailableModelProvider, type ModelProviderRoutes } from '../adapters/model/provider-routing-model-client.js'
import { CapabilityRegistry } from '../adapters/tool/capability-registry.js'
import { buildGoalLocalTools } from '../adapters/tool/goal-tools.js'
import { buildTodoLocalTools } from '../adapters/tool/todo-tools.js'
import { LocalToolHost, buildDefaultLocalTools } from '../adapters/tool/local-tool-host.js'
import { buildMcpToolProviders } from '../adapters/tool/mcp-tool-provider.js'
import { buildMemoryToolProviders } from '../adapters/tool/memory-tool-provider.js'
import { buildAttachmentToolProviders } from '../adapters/tool/attachment-tool-provider.js'
import { buildFlowToolProviders } from '../adapters/tool/flow-tool-provider.js'
import { buildDelegationToolProviders } from '../adapters/tool/delegation-tool-provider.js'
import { buildWebToolProviders } from '../adapters/tool/web-tool-provider.js'
import {
  DeepSeekResponsesWebProvider,
  isDeepSeekResponsesWebSearchConfig
} from '../adapters/tool/deepseek-responses-web-provider.js'
import { buildImageGenToolProviders } from '../adapters/tool/image-gen-tool-provider.js'
import { buildPptMasterToolProviders } from '../adapters/tool/ppt-master-tool-provider.js'
import { buildDesignToolProviders } from '../adapters/tool/design-tool-provider.js'
import { LocalWorkspaceInspector } from '../adapters/workspace/local-workspace-inspector.js'
import { WorkspaceReferenceService } from '../services/workspace-reference-service.js'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import {
  buildRuntimeCapabilityManifest,
  type KunCapabilitiesConfig
} from '../contracts/capabilities.js'
import { RUNTIME_RESOURCE_LIMITS_V1 } from '../contracts/resource-limits.js'
import { buildCoreFlowAdapters } from '../flow/core-adapters.js'
import { buildFlowNodeRegistry } from '../flow/node-registry.js'
import { FlowRepository } from '../flow/repository.js'
import { FlowRuntimeService } from '../flow/service.js'
import { EncryptedFileFlowSecretStore, FlowWebhookSecurity, UnavailableFlowSecretStore } from '../flow/webhook-security.js'
import type { ApprovalPolicy, SandboxMode } from '../contracts/policy.js'
import { AgentLoop } from '../loop/agent-loop.js'
import { ContextCompactor } from '../loop/context-compactor.js'
import type { TokenEconomyConfig } from '../loop/token-economy.js'
import {
  modelCapabilitiesForModel,
  modelContextProfilesFromConfig,
  type ContextCompactionConfig,
  type ModelConfig
} from '../loop/model-context-profile.js'
import {
  DEFAULT_STORAGE_CONFIG,
  expandHomePath,
  type RuntimeTuningConfig,
  type StorageConfig
} from '../config/kun-config.js'
import { InflightTracker } from '../loop/inflight-tracker.js'
import { SteeringQueue } from '../loop/steering-queue.js'
import { RandomIdGenerator } from '../ports/id-generator.js'
import type { SessionStore } from '../ports/session-store.js'
import type { ThreadStore } from '../ports/thread-store.js'
import { KUN_SYSTEM_PROMPT } from '../prompt/kun-system-prompt.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { ThreadService } from '../services/thread-service.js'
import { TurnService } from '../services/turn-service.js'
import { UiActionService } from '../services/ui-action-service.js'
import { TaskController } from '../services/task-controller.js'
import { TaskRunRepository } from '../services/task-run-repository.js'
import { RuntimeSpanService } from '../services/runtime-span-service.js'
import { GitCheckpointCoordinator } from '../services/git-checkpoint-coordinator.js'
import { ReviewService } from '../services/review-service.js'
import { UsageService } from '../services/usage-service.js'
import type { UsageEvent } from '../contracts/events.js'
import {
  DEFAULT_MODEL_ENDPOINT_FORMAT,
  type ModelEndpointFormat
} from '../contracts/model-endpoint-format.js'
import { SkillRuntime } from '../skills/skill-runtime.js'
import { FileMemoryStore } from '../memory/memory-store.js'
import { DelegationRuntime, FileDelegationStore } from '../delegation/delegation-runtime.js'
import { createChildAgentExecutor } from '../delegation/child-agent-executor.js'
import { stopAllBashSessions } from '../adapters/tool/builtin-bash-tool.js'
import { HttpVisionEvidenceService, type VisionEvidenceConfig } from '../vision/vision-evidence-service.js'
import { EngineeringService } from '../engineering/engineering-service.js'
import { EngineeringContextService } from '../engineering/engineering-context-service.js'
import { EngineeringAiOrchestrator } from '../engineering/engineering-ai-orchestrator.js'
import { buildEngineeringConversationTools } from '../adapters/tool/engineering-conversation-tools.js'
import { EngineeringAiRepository } from '../engineering/engineering-ai-repository.js'
import { buildRailwiseToolProviders } from '../adapters/tool/railwise-tool-provider.js'
import { SurveyService } from '../engineering/survey-service.js'
import { SurveyAdvancedTrialsWorkspaceService } from '../engineering/survey-advanced-trials-workspace.js'
import { SurveySamplingWorkspaceService } from '../engineering/survey-sampling-workspace.js'
import { SurveyQualityWorkspaceService } from '../engineering/survey-quality-workspace.js'
import { SurveyQualityWorkflowService } from '../engineering/survey-quality-workflow.js'

export type KunServeRuntimeOptions = {
  host: string
  port: number
  configPath?: string
  dataDir: string
  runtimeToken: string
  apiKey: string
  baseUrl: string
  endpointFormat?: ModelEndpointFormat
  model: string
  modelProviders?: ModelProviderRoutes
  defaultModelProviderId?: string
  approvalPolicy: ApprovalPolicy
  sandboxMode: SandboxMode
  tokenEconomyMode: boolean
  tokenEconomy?: TokenEconomyConfig
  insecure: boolean
  models?: ModelConfig
  contextCompaction?: ContextCompactionConfig
  runtime?: RuntimeTuningConfig
  visionEvidence?: VisionEvidenceConfig
  storage?: StorageConfig
  capabilities?: KunCapabilitiesConfig
  startedAt?: string
}

export type KunServeHandle = NodeHttpServerHandle & {
  runtime: ServerRuntime
}

/**
 * Composition root for serve mode. This is intentionally the only
 * place that wires concrete adapters to ports; domain, services, loop,
 * and HTTP handlers stay constructor-injected and testable.
 */
export async function createKunServeRuntime(
  options: KunServeRuntimeOptions
): Promise<ServerRuntime> {
  // Provider credentials are parsed at startup and must not reach tool subprocesses.
  delete process.env.WORKWISE_MODEL_PROVIDERS_SECRET
  await mkdir(options.dataDir, { recursive: true })
  const eventBus = new InMemoryEventBus()
  const stores = await createPersistentStores({
    dataDir: options.dataDir,
    storage: options.storage,
    nowIso: () => new Date().toISOString()
  })
  const sessionStore = stores.sessionStore
  const threadStore = stores.threadStore
  const approvalGate = new InMemoryApprovalGate()
  const userInputGate = new InMemoryUserInputGate()
  const workspaceInspector = new LocalWorkspaceInspector()
  const workspaceReferenceService = new WorkspaceReferenceService()
  const usageService = new UsageService()
  const inflight = new InflightTracker()
  const steering = new SteeringQueue()
  const compactor = new ContextCompactor({
    contextCompaction: options.contextCompaction,
    models: options.models
  })
  const tokenEconomy = tokenEconomyConfigForOptions(options)
  const ids = new RandomIdGenerator()
  const nowIso = () => new Date().toISOString()
  const allocateSeq = (threadId: string) => eventBus.allocateSeq(threadId)
  const events = new RuntimeEventRecorder({ eventBus, sessionStore, allocateSeq, nowIso })
  const taskRepository = new TaskRunRepository(join(options.dataDir, 'tasks.sqlite3'))
  const spanService = new RuntimeSpanService(taskRepository, nowIso)
  spanService.prune()
  const taskController = new TaskController({
    repository: taskRepository,
    threadStore,
    sessionStore,
    nowIso,
    spans: spanService,
    completionGuard: input => engineeringAi.assessCompletion(input)
  })
  const recoveredTasks = taskController.reconcileStartup()
  taskRepository.reconcileShellSessionsStartup(nowIso())
  const gitCheckpointCoordinator = new GitCheckpointCoordinator(taskRepository)
  const mutationLifecycle = {
    beforeMutation(input: {
      absolutePath: string
      relativePath: string
      workspaceRoot: string
      threadId: string
    }) {
      return gitCheckpointCoordinator.beforeMutation(input)
    }
  }
  const shellTools = buildDefaultLocalTools({
    beforeMutation: (input) => gitCheckpointCoordinator.beforeMutation(input)
  }, {
    bash: {
      sessionOutputRoot: join(options.dataDir, 'shell-output'),
      sessionLifecycle: {
        onStarted(input) {
          const task = taskRepository.findActiveByThread(input.threadId)
          if (!task) return
          const node = task.nodes.find((candidate) => candidate.status === 'running')
            ?? task.nodes.find((candidate) => candidate.kind === 'execute')
            ?? task.nodes[0]
          if (!node) return
          taskRepository.createShellSession({
            id: input.sessionId,
            taskId: task.id,
            nodeId: node.id,
            workspaceRoot: input.workspaceRoot,
            commandSummary: input.commandSummary,
            cwd: input.cwd,
            status: 'running',
            outputPath: input.outputPath,
            outputBytes: 0,
            createdAt: input.startedAt,
            startedAt: input.startedAt,
            revision: 0
          })
          spanService.start({
            id: `span_shell_${input.sessionId}`,
            taskId: task.id,
            turnId: input.turnId,
            kind: 'shell',
            name: 'background-shell',
            retryCount: 0,
            attributes: { cwd: input.cwd, command: input.commandSummary }
          })
        },
        onFinished(input) {
          const current = taskRepository.getShellSession(input.sessionId)
          if (!current || current.status === 'interrupted') return
          taskRepository.updateShellSession(current.id, current.revision, (session) => ({
            ...session,
            status: input.status,
            ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
            outputBytes: input.outputBytes,
            finishedAt: input.finishedAt
          }))
          spanService.finish(`span_shell_${input.sessionId}`, {
            status: input.status === 'completed' ? 'ok' : input.status === 'terminated' ? 'cancelled' : 'error',
            ...(input.status === 'failed' ? { errorCode: 'shell_failed' } : {}),
            attributes: { outputBytes: input.outputBytes, exitCode: input.exitCode ?? -1 }
          })
        }
      }
    },
    write: { mutationLifecycle },
    edit: { mutationLifecycle }
  })
  const prefix = createImmutablePrefix({
    systemPrompt: KUN_SYSTEM_PROMPT,
    pinnedConstraints: [
      'system: preserve user intent across compaction',
      'system: keep the HTTP/SSE contract stable for the GUI',
      'system: keep the stable Kun prefix byte-stable for prompt-cache reuse'
    ]
  })
  const turnService = new TurnService({
    threadStore,
    sessionStore,
    events,
    inflight,
    steering,
    compactor,
    ids,
    nowIso,
    tasks: taskController,
    resolveModelSelection: (request, thread) => {
      const providerId = request.providerId ?? options.defaultModelProviderId
      if (!providerId) return { model: request.model }
      const provider = options.modelProviders?.find(route => route.id === providerId)
      if (!provider) throw unavailableModelProvider(providerId)
      return { providerId, model: request.model ?? (thread.agentProfile?.model || thread.model || provider.model) }
    },
    approvalGate,
    userInputGate,
    workspaceReferences: workspaceReferenceService
  })
  const uiActionService = new UiActionService({ sessionStore, turns: turnService })
  await seedUsageCarryover({ threadStore, sessionStore, usageService })
  const defaultModelClient = new DeepseekCompatModelClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    endpointFormat: options.endpointFormat ?? DEFAULT_MODEL_ENDPOINT_FORMAT,
    model: options.model
  })
  const modelClient = new ProviderRoutingModelClient(defaultModelClient, options.modelProviders ?? [])
  const modelProfiles = modelContextProfilesFromConfig({
    contextCompaction: options.contextCompaction,
    models: options.models
  })
  const reviewService = new ReviewService({
    threadStore,
    turns: turnService,
    model: modelClient,
    defaultModel: options.model,
    nowIso,
    modelCapabilities: (model) => modelCapabilitiesForModel(model, modelProfiles),
    ...(options.models ? { models: options.models } : {}),
    ...(options.contextCompaction ? { contextCompaction: options.contextCompaction } : {}),
    ...(tokenEconomy ? { tokenEconomy } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {})
  })
  const mcpProviders = await buildMcpToolProviders(options.capabilities?.mcp)
  const deepSeekWebSearch = isDeepSeekResponsesWebSearchConfig(options)
    ? new DeepSeekResponsesWebProvider({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model,
        nowIso
      })
    : undefined
  const webProviders = buildWebToolProviders(options.capabilities?.web, {
    ...(deepSeekWebSearch ? { searchProvider: deepSeekWebSearch } : {}),
    nowIso
  })
  const skillRuntime = await SkillRuntime.create(options.capabilities?.skills)
  const attachmentStore = options.capabilities?.attachments.enabled
    ? new FileAttachmentStore({
        rootDir: join(options.dataDir, 'attachments'),
        config: options.capabilities.attachments,
        nowIso
      })
    : undefined
  await attachmentStore?.cleanupAbandoned()
  let surveyService: SurveyService
  const engineeringService = new EngineeringService({
    rootDir: join(options.dataDir, 'engineering'),
    ...(attachmentStore ? { attachmentStore } : {}),
    runtimeVersion: '0.5.0',
    getAdjustments: (projectId, ids) => ids.flatMap((id) => {
      const stored = surveyService.getAdjustmentForProjectNewUse(projectId, id)
      if (!stored || !stored.result) return []
      return [stored.result]
    }),
    getAdjustmentEvidence: (projectId, ids) => ids.flatMap((id) => {
      const stored = surveyService.getAdjustmentForProjectNewUse(projectId, id)
      if (!stored || !stored.result) return []
      return [{
        run: {
          id: stored.run.id,
          projectId: stored.run.projectId,
          networkId: stored.run.networkId,
          inputHash: stored.run.inputHash,
          status: stored.run.status
        },
        result: stored.result
      }]
    }),
    getDeformations: (projectId, ids) => ids.flatMap((id) => {
      const result = surveyService.getDeformationForProjectNewUse(projectId, id)
      return result ? [result] : []
    }),
    getSurveyNetworkSnapshot: (projectId, networkId) => {
      const network = surveyService.getNetwork(networkId)
      return network?.projectId === projectId ? network : null
    },
    getSurveySources: (projectId, networkIds) => networkIds.flatMap((id) => {
      const network = surveyService.getNetwork(id)
      return network?.projectId === projectId
        ? [{
          networkId: id,
          ...(network.sourceFile ? { sourceFile: network.sourceFile } : {}),
          rawSourceIntegrity: surveyService.getRawSourceIntegrity(id),
          sourceEligibility: surveyService.getSourceEligibility(id),
          observations: network.observations.map(({ id: observationId, type, sourceRecordId }) => ({ id: observationId, type, sourceRecordId })),
          points: [...network.knownPoints, ...network.unknownPoints].map(({ id: pointId }) => ({ id: pointId }))
        }]
        : []
    }),
    nowIso
  })
  const engineeringAiRepository = new EngineeringAiRepository({
    rootDir: join(options.dataDir, 'engineering'),
    nowIso
  })
  surveyService = new SurveyService({
    rootDir: join(options.dataDir, 'engineering'),
    getProject: (projectId) => engineeringService.getProject(projectId),
    nowIso
  })
  const engineeringContext = new EngineeringContextService(engineeringService, nowIso, surveyService)
  const surveyQualityWorkspaceService = new SurveyQualityWorkspaceService({
    rootDir: join(options.dataDir, 'engineering'),
    nowIso,
    getProject: (projectId) => engineeringService.getProject(projectId),
    getManifest: (projectId, manifestId) => engineeringService.getManifestForProject(projectId, manifestId)
  })
  const surveyQualityScoringWorkspaceService = new SurveyQualityScoringWorkspaceService({
    rootDir: join(options.dataDir, 'engineering'), nowIso,
    getProject: (projectId) => engineeringService.getProject(projectId)
  })
  const surveyQualityWorkflowService = new SurveyQualityWorkflowService({
    rootDir: join(options.dataDir, 'engineering'), nowIso,
    sources: Object.freeze({
      getProject: (projectId: string) => engineeringService.getProject(projectId),
      retentionSnapshot: (pid: string, plan: string, record: string) => surveyQualityWorkspaceService.getAssessmentSnapshot(pid, plan, record)
    })
  })
  const surveyAdvancedTrialsWorkspaceService = new SurveyAdvancedTrialsWorkspaceService({
    rootDir: join(options.dataDir, 'engineering'), nowIso,
    getProject: (projectId) => engineeringService.getProject(projectId)
  })
  const surveySamplingWorkspaceService = new SurveySamplingWorkspaceService({
    rootDir: join(options.dataDir, 'engineering'),
    nowIso,
    getProject: (projectId) => engineeringService.getProject(projectId)
  })
  const surveyQualityAssessmentService = new SurveyQualityAssessmentService({
    rootDir: join(options.dataDir, 'engineering'), nowIso,
    sources: Object.freeze({
      getProject: (pid: string) => engineeringService.getProject(pid),
      getManifest: (pid: string, id: string) => engineeringService.getManifestForProject(pid, id),
      retentionSnapshot: (pid: string, plan: string, record: string) => surveyQualityWorkspaceService.getAssessmentSnapshot(pid, plan, record),
      getPopulation: (pid: string, id: string) => surveySamplingWorkspaceService.getPopulation(pid, id),
      getRun: (pid: string, id: string) => surveySamplingWorkspaceService.getRun(pid, id),
      listSamples: (pid: string, id: string, limit: number, offset: number) => surveySamplingWorkspaceService.listSamples(pid, id, limit, offset),
      getScore: (pid: string, id: string) => surveyQualityScoringWorkspaceService.getRecord(pid, id)
    })
  })
  const visionEvidenceRuntime = createVisionEvidenceService(options.visionEvidence)
  const visionEvidence = visionEvidenceRuntime.service
  const attachmentCleanupTimer = attachmentStore
    ? setInterval(() => { void attachmentStore.cleanupAbandoned() }, 24 * 60 * 60 * 1000)
    : undefined
  attachmentCleanupTimer?.unref()
  const threadService = new ThreadService({
    threadStore, sessionStore, events, ids, nowIso,
    ...(attachmentStore ? { onThreadDeleted: async (threadId: string) => { await attachmentStore.releaseReferences({ threadId }) } } : {})
  })
  const flowRepository = new FlowRepository(join(options.dataDir, 'flow.sqlite'), nowIso)
  const flowSecretKey = process.env.WORKWISE_FLOW_SECRET_STORE_KEY
  const flowSecretStore = flowSecretKey && /^[A-Za-z0-9_-]{43}$/.test(flowSecretKey)
    ? new EncryptedFileFlowSecretStore(join(options.dataDir, 'flow-secrets'), Buffer.from(flowSecretKey, 'base64url'))
    : new UnavailableFlowSecretStore()
  let flowDelegationRuntime: DelegationRuntime | undefined
  const flowService = new FlowRuntimeService(
    flowRepository,
    buildFlowNodeRegistry(),
    buildCoreFlowAdapters(new Map(), {
      model: modelClient,
      defaultModel: options.model,
      attachments: attachmentStore,
      runSubagent: async (input) => {
        if (!flowDelegationRuntime) throw new Error('subagent capability is unavailable')
        return flowDelegationRuntime.runChild(input)
      }
    }),
    nowIso,
    new FlowWebhookSecurity(flowRepository, flowSecretStore)
  )
  const memoryStore = options.capabilities?.memory.enabled
    ? new FileMemoryStore({
        rootDir: join(options.dataDir, 'memory'),
        config: options.capabilities.memory,
        nowIso
      })
    : undefined
  const imageGenProviders = buildImageGenToolProviders(options.capabilities?.imageGen, {
    attachmentStore,
    nowIso
  })
  const pptMasterProviders = buildPptMasterToolProviders({
    beforeMutation: (input) => gitCheckpointCoordinator.beforeMutation(input)
  })
  const designProviders = buildDesignToolProviders({
    beforeMutation: (input: { absolutePath: string; relativePath: string; workspaceRoot: string; threadId: string }) =>
      gitCheckpointCoordinator.beforeMutation(input)
  })
  const baseToolProviders = [
    {
      id: 'builtin',
      kind: 'built-in' as const,
      enabled: true,
      available: true,
      tools: shellTools
    },
    ...mcpProviders.providers,
    ...webProviders.providers,
    ...buildMemoryToolProviders(memoryStore),
    ...buildAttachmentToolProviders(attachmentStore),
    ...buildFlowToolProviders(flowService),
    ...imageGenProviders.providers,
    ...pptMasterProviders.providers,
    ...designProviders.providers,
    ...buildRailwiseToolProviders(engineeringService, surveyService, () => engineeringAi)
  ]
  const childRegistry = new CapabilityRegistry(baseToolProviders)
  const childToolHost = new LocalToolHost({ registry: childRegistry, readTracker: true })
  const delegationRuntime = options.capabilities?.subagents.enabled
    ? new DelegationRuntime({
        config: options.capabilities.subagents,
        store: new FileDelegationStore(join(options.dataDir, 'child-runs')),
        events,
        nowIso,
        executor: createChildAgentExecutor({
          parentSelection: async (threadId, turnId) => {
            const parent = (await threadStore.get(threadId))?.turns.find(turn => turn.id === turnId)
            return { model: parent?.model, providerId: parent?.providerId, reasoningEffort: parent?.reasoningEffort }
          },
          model: modelClient,
          toolHost: childToolHost,
          prefix,
          defaultModel: options.model,
          models: options.models,
          contextCompaction: options.contextCompaction,
          approvalPolicy: options.approvalPolicy,
          sandboxMode: options.sandboxMode,
          modelCapabilities: (model) => modelCapabilitiesForModel(model, modelProfiles),
          skillRuntime,
          tokenEconomy,
          ...(options.runtime ? { runtime: options.runtime } : {}),
          ...(memoryStore ? { memoryStore } : {}),
          nowIso
        }),
        recordExternalUsage: (threadId, usage) => {
          usageService.record(threadId, usage)
        },
        taskRepository,
        spanService
      })
    : undefined
  flowDelegationRuntime = delegationRuntime
  flowService.startSchedules()
  const capabilities = buildRuntimeCapabilityManifest({
    config: options.capabilities,
    model: modelCapabilitiesForModel(options.model, modelProfiles),
    mcp: {
      configuredServers: Object.keys(options.capabilities?.mcp.servers ?? {}).length,
      connectedServers: mcpProviders.connectedServers,
      toolCount: mcpProviders.toolCount,
      lastError: mcpProviders.diagnostics.find((diagnostic) => diagnostic.lastError)?.lastError,
      search: {
        active: mcpProviders.search.active,
        indexedToolCount: mcpProviders.search.indexedToolCount,
        advertisedToolCount: mcpProviders.search.advertisedToolCount
      }
    },
    web: {
      fetchAvailable: webProviders.fetchAvailable,
      searchAvailable: webProviders.searchAvailable,
      provider: webProviders.provider,
      reason: webProviders.diagnostics.find((diagnostic) => diagnostic.reason)?.reason
    },
    skills: {
      configuredRoots: options.capabilities?.skills.roots.length,
      discoveredSkills: skillRuntime.count(),
      reason: skillRuntime.diagnostics().validationErrors[0]?.message
    },
    attachments: {
      available: Boolean(attachmentStore)
    },
    memory: {
      available: Boolean(memoryStore)
    },
    subagents: {
      available: Boolean(delegationRuntime)
    },
    imageGen: {
      available: imageGenProviders.available,
      reason: imageGenProviders.diagnostics.find((diagnostic) => diagnostic.reason)?.reason
    },
    visionEvidence: {
      enabled: visionEvidenceRuntime.enabled,
      available: Boolean(visionEvidence),
      reason: visionEvidenceRuntime.reason
    }
  })
  const registry = new CapabilityRegistry([
    ...baseToolProviders,
    {
      id: 'goal',
      kind: 'gui' as const,
      enabled: true,
      available: true,
      tools: buildGoalLocalTools(threadService)
    },
    {
      id: 'todo',
      kind: 'gui' as const,
      enabled: true,
      available: true,
      tools: buildTodoLocalTools(threadService)
    },
    ...buildDelegationToolProviders(delegationRuntime)
  ])
  let engineeringAi: EngineeringAiOrchestrator
  const toolHost = new LocalToolHost({ registry, readTracker: true })
  let loop: AgentLoop
  registry.registerProvider(buildEngineeringConversationTools(threadStore, () => engineeringAi, new SurveyEvidenceReader({
    engineering: engineeringService, survey: surveyService, advanced: surveyAdvancedTrialsWorkspaceService,
    scoring: surveyQualityScoringWorkspaceService, retention: surveyQualityWorkspaceService,
    sampling: surveySamplingWorkspaceService, assessment: surveyQualityAssessmentService
  })))
  loop = new AgentLoop({
    threadStore,
    sessionStore,
    approvalGate,
    userInputGate,
    model: modelClient,
    toolHost,
    usage: usageService,
    events,
    turns: turnService,
    inflight,
    steering,
    compactor,
    prefix,
    ids,
    nowIso,
    delegationPolicy: options.capabilities?.subagents
      ? {
          enabled: options.capabilities.subagents.enabled,
          maxParallel: options.capabilities.subagents.maxParallel,
          maxChildRuns: options.capabilities.subagents.maxChildRuns
        }
      : { enabled: false },
    modelCapabilities: (model) => modelCapabilitiesForModel(model, modelProfiles),
    skillRuntime,
    tokenEconomy,
    contextCompaction: options.contextCompaction,
    ...(options.runtime?.toolStorm ? { toolStorm: options.runtime.toolStorm } : {}),
    ...(options.runtime?.toolArgumentRepair ? { toolArgumentRepair: options.runtime.toolArgumentRepair } : {}),
    ...(attachmentStore ? { attachmentStore } : {}),
    ...(visionEvidence ? { visionEvidence } : {}),
    ...(memoryStore ? { memoryStore } : {}),
    onPlanWritten: async ({ threadId, planId, relativePath, markdown }) => {
      await threadService.syncTodosFromPlan(threadId, {
        planId,
        relativePath,
        markdown,
        preserveCompleted: true
      })
    },
    tasks: taskController,
    spanService,
    workspaceReferences: workspaceReferenceService,
    engineeringTurnPolicy: (threadId, projectId, turnId) => engineeringAi.conversationPolicy(threadId, projectId, turnId)
  })
  engineeringAi = new EngineeringAiOrchestrator({
    context: engineeringContext,
    engineering: engineeringService,
    repository: engineeringAiRepository,
    threadStore,
    turns: turnService,
    runTurn: (threadId, turnId) => loop.runTurn(threadId, turnId),
    tasks: taskController,
    events,
    nowIso
  })
  const startedAt = options.startedAt ?? nowIso()
  const runtime: ServerRuntime = {
    threadService,
    turnService,
    uiActionService,
    taskController,
    taskRepository,
    spanService,
    reviewService,
    usageService,
    eventBus,
    sessionStore,
    events,
    approvalGate,
    userInputGate,
    workspaceInspector,
    workspaceReferenceService,
    toolHost,
    ...(attachmentStore ? { attachmentStore } : {}),
    ...(memoryStore ? { memoryStore } : {}),
    flowService,
    engineeringService,
    engineeringContext,
    engineeringAi,
    surveyService,
    surveyQualityAssessmentService,
    surveyQualityWorkflowService,
    surveyQualityWorkspaceService,
    surveyQualityScoringWorkspaceService,
    surveyAdvancedTrialsWorkspaceService,
    surveySamplingWorkspaceService,
    runTurn(threadId, turnId) {
      return loop.runTurn(threadId, turnId)
    },
    cancelChildRuns(parentThreadId, reason) {
      return delegationRuntime?.abortParent(parentThreadId, reason) ?? 0
    },
    runReview(input) {
      return reviewService.runReview(input)
    },
    runtimeToken: options.runtimeToken,
    insecure: options.insecure,
    allocateSeq,
    nowIso,
    info: () => ({
      host: options.host,
      port: options.port,
      configPath: options.configPath,
      dataDir: options.dataDir,
      model: options.model,
      endpointFormat: options.endpointFormat ?? DEFAULT_MODEL_ENDPOINT_FORMAT,
      approvalPolicy: options.approvalPolicy,
      sandboxMode: options.sandboxMode,
      tokenEconomyMode: options.tokenEconomyMode,
      insecure: options.insecure,
      startedAt,
      pid: process.pid,
      capabilities,
      resourceLimits: RUNTIME_RESOURCE_LIMITS_V1
    }),
    toolDiagnostics: async () => ({
      providers: registry.diagnostics(),
      mcpServers: mcpProviders.diagnostics,
      mcpSearch: mcpProviders.search,
      webProviders: webProviders.diagnostics,
      skills: skillRuntime.diagnostics(),
      attachments: attachmentStore
        ? await attachmentStore.diagnostics()
        : { enabled: false, rootDir: '', count: 0, totalBytes: 0 },
      memory: memoryStore
        ? await memoryStore.diagnostics()
        : { enabled: false, rootDir: '', activeCount: 0, tombstoneCount: 0, lastInjectedIds: [] },
      imageGen: imageGenProviders.diagnostics,
      visionEvidence: {
        enabled: visionEvidenceRuntime.enabled,
        available: Boolean(visionEvidence),
        ...(visionEvidenceRuntime.reason ? { reason: visionEvidenceRuntime.reason } : {})
      }
    }),
    skills: async () => {
      await skillRuntime.refresh()
      return skillRuntime.diagnostics()
    },
    shutdown: async () => {
      if (attachmentCleanupTimer) clearInterval(attachmentCleanupTimer)
      turnService.abortAll('application_exit')
      delegationRuntime?.abortAll('application_exit')
      approvalGate.expireAll('application_exit')
      userInputGate.reset()
      await stopAllBashSessions('application_exit')
      try {
        await mcpProviders.close()
      } finally {
        try {
          flowService.shutdown()
          taskRepository.close()
          engineeringAiRepository.close()
          await surveyService.flush()
          await engineeringService.flush()
          surveyService.close()
          surveyQualityAssessmentService.close()
          surveyQualityWorkflowService.close()
          surveyQualityWorkspaceService.close()
          surveyQualityScoringWorkspaceService.close()
          surveyAdvancedTrialsWorkspaceService.close()
          surveySamplingWorkspaceService.close()
          engineeringService.close()
        } finally {
          await stores.shutdown?.()
        }
      }
    }
  }
  if (recoveredTasks.length > 0) {
    setImmediate(() => {
      void resumeRecoveredTasks({ recoveredTasks, taskRepository, turnService, loop, engineeringAi, threadStore })
    })
  }
  if (delegationRuntime) {
    setImmediate(() => {
      void delegationRuntime.recoverInterrupted()
    })
  }
  return runtime
}

function createVisionEvidenceService(config: VisionEvidenceConfig | undefined): {
  enabled: boolean
  service?: HttpVisionEvidenceService
  reason?: string
} {
  if (!config?.enabled) return { enabled: false, reason: 'vision evidence is disabled by config' }
  try {
    return { enabled: true, service: new HttpVisionEvidenceService(config) }
  } catch (error) {
    return {
      enabled: true,
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

async function resumeRecoveredTasks(input: {
  recoveredTasks: ReturnType<TaskController['reconcileStartup']>
  taskRepository: TaskRunRepository
  turnService: TurnService
  loop: AgentLoop
  engineeringAi: EngineeringAiOrchestrator
  threadStore: ThreadStore
}): Promise<void> {
  for (const recovered of input.recoveredTasks) {
    if (recovered.parentTaskId) continue
    try {
      if (recovered.activeTurnId) {
        await input.turnService.finishTurn({
          threadId: recovered.threadId,
          turnId: recovered.activeTurnId,
          status: 'aborted'
        })
      }
      const checkpoint = input.taskRepository.latestCheckpoint(recovered.id)
      const legacyPlan = !recovered.engineeringPlanId ? input.engineeringAi.planForTask(recovered.threadId, recovered.id) : null
      if (legacyPlan) {
        const thread = await input.threadStore.get(recovered.threadId)
        if (thread?.domain !== 'engineering' || legacyPlan.projectId !== thread.projectId || legacyPlan.status !== 'started') throw new Error('engineering_plan_binding_missing')
      }
      const started = await input.turnService.startTurn({
        threadId: recovered.threadId,
        continuationTaskId: recovered.id,
        engineeringPlanId: recovered.engineeringPlanId ?? legacyPlan?.id,
        request: {
          prompt: [
            'Continue the persisted task automatically after an application restart.',
            `Goal: ${recovered.goal}`,
            checkpoint?.resumeSummary ? `Checkpoint: ${checkpoint.resumeSummary}` : '',
            'Do not repeat completed external side effects. Verify the acceptance contract before stopping.'
          ].filter(Boolean).join('\n'),
          displayText: '正在自动恢复未完成任务',
          model: recovered.model,
          providerId: recovered.providerId,
          reasoningEffort: recovered.reasoningEffort,
          mode: 'agent'
        }
      })
      void input.loop.runTurn(started.threadId, started.turnId)
    } catch (error) {
      const current = input.taskRepository.get(recovered.id)
      if (!current || ['completed', 'failed', 'cancelled', 'stalled'].includes(current.status)) continue
      input.taskRepository.update(current.id, current.revision, (task) => ({
        ...task,
        status: 'stalled',
        stalledReason: `自动恢复失败：${error instanceof Error ? error.message : String(error)}`,
        waitingReason: undefined,
        updatedAt: new Date().toISOString()
      }), {
        key: `startup-auto-recovery-failed:${current.revision}`,
        kind: 'task_stalled',
        payload: { code: 'startup_recovery_failed' }
      })
    }
  }
}

function tokenEconomyConfigForOptions(
  options: Pick<KunServeRuntimeOptions, 'tokenEconomyMode' | 'tokenEconomy'>
): TokenEconomyConfig {
  return {
    ...(options.tokenEconomy ?? {}),
    enabled: options.tokenEconomy?.enabled ?? options.tokenEconomyMode
  }
}

async function createPersistentStores(input: {
  dataDir: string
  storage?: StorageConfig
  nowIso: () => string
}): Promise<{ threadStore: ThreadStore; sessionStore: SessionStore; shutdown?: () => Promise<void> }> {
  const storage = input.storage ?? DEFAULT_STORAGE_CONFIG
  if (storage.backend === 'file') {
    return {
      sessionStore: new FileSessionStore({ dataDir: input.dataDir }),
      threadStore: new FileThreadStore({ dataDir: input.dataDir })
    }
  }

  const threadStore = new HybridThreadStore({
    dataDir: input.dataDir,
    sqlitePath: storage.sqlitePath ? expandHomePath(storage.sqlitePath) : undefined,
    nowIso: input.nowIso
  })
  await threadStore.ready()
  return {
    threadStore,
    sessionStore: new HybridSessionStore({
      dataDir: input.dataDir,
      index: threadStore
    }),
    shutdown: async () => {
      threadStore.close()
    }
  }
}

export async function seedUsageCarryover(input: {
  threadStore: ThreadStore
  sessionStore: SessionStore
  usageService: UsageService
}): Promise<void> {
  if (typeof input.sessionStore.loadLatestUsageSnapshots === 'function') {
    try {
      const latest = await input.sessionStore.loadLatestUsageSnapshots()
      for (const record of latest) {
        input.usageService.seedThread(record.threadId, record.usage)
      }
      return
    } catch {
      // Fall through to JSONL replay when the optional index is unavailable.
    }
  }
  const threadSummaries = await input.threadStore.list()
  await Promise.all(threadSummaries.map(async (thread) => {
    const events = await input.sessionStore.loadEventsSince(thread.id, 0)
    const latestUsage = events.reduce<UsageEvent | null>((latest, event) => {
      if (event.kind !== 'usage') return latest
      if (!latest || event.seq > latest.seq) return event
      return latest
    }, null)
    if (latestUsage) input.usageService.seedThread(thread.id, latestUsage.usage)
  }))
}

export async function startKunServe(
  options: KunServeRuntimeOptions
): Promise<KunServeHandle> {
  const runtime = await createKunServeRuntime(options)
  const router = buildRouter(runtime)
  const server = await startNodeHttpServer({
    router,
    host: options.host,
    port: options.port
  })
  return {
    ...server,
    runtime,
    close: async () => {
      try {
        await server.close()
      } finally {
        await runtime.shutdown?.()
      }
    }
  }
}
