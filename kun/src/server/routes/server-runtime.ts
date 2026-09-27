import type { SurveyQualityAssessmentService } from '../../engineering/survey-quality-assessment.js'
import type { SurveyQualityWorkflowService } from '../../engineering/survey-quality-workflow.js'
import type { SurveyQualityScoringWorkspaceService } from '../../engineering/survey-quality-scoring-workspace.js'
import type { ThreadService } from '../../services/thread-service.js'
import type { TurnService } from '../../services/turn-service.js'
import type { UsageService } from '../../services/usage-service.js'
import type { ReviewService } from '../../services/review-service.js'
import type { EventBus } from '../../ports/event-bus.js'
import type { SessionStore } from '../../ports/session-store.js'
import type { ApprovalGate } from '../../ports/approval-gate.js'
import type { UserInputGate } from '../../ports/user-input-gate.js'
import type { WorkspaceInspector } from '../../ports/workspace-inspector.js'
import type { ToolHost, ToolProviderPolicy } from '../../ports/tool-host.js'
import type { RuntimeEventRecorder } from '../../services/runtime-event-recorder.js'
import type { RuntimeInfoResponse } from '../../contracts/runtime-info.js'
import type { McpServerDiagnostic } from '../../adapters/tool/mcp-tool-provider.js'
import type { McpSearchRuntimeDiagnostic } from '../../adapters/tool/mcp-tool-search.js'
import type { WebProviderDiagnostic } from '../../adapters/tool/web-tool-provider.js'
import type { ImageGenDiagnostic } from '../../adapters/tool/image-gen-tool-provider.js'
import type { SkillRuntimeDiagnostics } from '../../skills/skill-runtime.js'
import type { AttachmentDiagnostics } from '../../contracts/attachments.js'
import type { AttachmentStore } from '../../attachments/attachment-store.js'
import type { MemoryDiagnostics } from '../../contracts/memory.js'
import type { MemoryStore } from '../../memory/memory-store.js'
import type { ReviewTarget } from '../../contracts/review.js'
import type { TaskController } from '../../services/task-controller.js'
import type { TaskRunRepository } from '../../services/task-run-repository.js'
import type { RuntimeSpanService } from '../../services/runtime-span-service.js'
import type { FlowRuntimeService } from '../../flow/service.js'
import type { WorkspaceReferenceService } from '../../services/workspace-reference-service.js'
import type { UiActionService } from '../../services/ui-action-service.js'
import type { EngineeringService } from '../../engineering/engineering-service.js'
import type { EngineeringContextService } from '../../engineering/engineering-context-service.js'
import type { EngineeringAiOrchestrator } from '../../engineering/engineering-ai-orchestrator.js'
import type { SurveyService } from '../../engineering/survey-service.js'
import type { SurveyAdvancedTrialsWorkspaceService } from '../../engineering/survey-advanced-trials-workspace.js'
import type { SurveySamplingWorkspaceService } from '../../engineering/survey-sampling-workspace.js'
import type { SurveyQualityWorkspaceService } from '../../engineering/survey-quality-workspace.js'

export type RuntimeToolDiagnostics = {
  providers: ToolProviderPolicy[]
  mcpServers: McpServerDiagnostic[]
  mcpSearch?: McpSearchRuntimeDiagnostic
  webProviders: WebProviderDiagnostic[]
  skills: SkillRuntimeDiagnostics
  attachments: AttachmentDiagnostics
  memory: MemoryDiagnostics
  imageGen?: ImageGenDiagnostic[]
  visionEvidence?: {
    enabled: boolean
    available: boolean
    reason?: string
  }
}

/**
 * Dependencies that the HTTP router needs. Bundled into a single
 * type so callers can compose the runtime from the in-memory or
 * file-backed adapters without leaking concrete types into routes.
 */
export type ServerRuntime = {
  threadService: ThreadService
  turnService: TurnService
  uiActionService?: UiActionService
  taskController?: TaskController
  taskRepository?: TaskRunRepository
  spanService?: RuntimeSpanService
  usageService: UsageService
  reviewService?: ReviewService
  eventBus: EventBus
  sessionStore: SessionStore
  events: RuntimeEventRecorder
  approvalGate: ApprovalGate
  userInputGate: UserInputGate
  workspaceInspector: WorkspaceInspector
  workspaceReferenceService: WorkspaceReferenceService
  toolHost?: ToolHost
  attachmentStore?: AttachmentStore
  memoryStore?: MemoryStore
  flowService?: FlowRuntimeService
  engineeringService?: EngineeringService
  engineeringContext?: EngineeringContextService
  engineeringAi?: EngineeringAiOrchestrator
  surveyService?: SurveyService
  surveyQualityAssessmentService?: SurveyQualityAssessmentService
  surveyQualityWorkflowService?: SurveyQualityWorkflowService
  surveyQualityWorkspaceService?: SurveyQualityWorkspaceService
  surveyQualityScoringWorkspaceService?: SurveyQualityScoringWorkspaceService
  surveyAdvancedTrialsWorkspaceService?: SurveyAdvancedTrialsWorkspaceService
  surveySamplingWorkspaceService?: SurveySamplingWorkspaceService
  runTurn(threadId: string, turnId: string): Promise<'completed' | 'failed' | 'aborted'> | void
  cancelChildRuns?(parentThreadId: string, reason?: string): number
  runReview?(input: {
    threadId: string
    turnId: string
    reviewItemId: string
    target: ReviewTarget
    model?: string
  }): Promise<'completed' | 'failed' | 'aborted'> | void
  runtimeToken: string
  insecure: boolean
  allocateSeq: (threadId: string) => number
  nowIso: () => string
  info(): RuntimeInfoResponse
  toolDiagnostics?(): RuntimeToolDiagnostics | Promise<RuntimeToolDiagnostics>
  skills?(): SkillRuntimeDiagnostics | Promise<SkillRuntimeDiagnostics>
  shutdown?(): Promise<void>
}
