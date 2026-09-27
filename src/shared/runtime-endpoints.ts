/**
 * WorkWise Agent Runtime HTTP endpoint path templates. The renderer and main
 * process IPC allow-list both derive their paths from this table, so
 * adding a new endpoint is a one-file change.
 *
 * `*TEMPLATE` constants carry the `{id}` / `{turn}` placeholders
 * literally. `*PATH(...)` builders perform the URL encoding and
 * return a concrete path for runtime use.
 */

export const RUNTIME_HEALTH_PATH = '/health'
export const RUNTIME_HEALTH_TEMPLATE = '/health'

export const RUNTIME_INFO_PATH = '/v1/runtime/info'
export const RUNTIME_INFO_TEMPLATE = '/v1/runtime/info'

export const RUNTIME_TOOLS_PATH = '/v1/runtime/tools'
export const RUNTIME_TOOLS_TEMPLATE = '/v1/runtime/tools'

export const RUNTIME_SKILLS_PATH = '/v1/skills'
export const RUNTIME_SKILLS_TEMPLATE = '/v1/skills'

export const RUNTIME_ATTACHMENTS_PATH = '/v1/attachments'
export const RUNTIME_ATTACHMENTS_TEMPLATE = '/v1/attachments'
export const RUNTIME_ATTACHMENT_DIAGNOSTICS_PATH = '/v1/attachments/diagnostics'
export const RUNTIME_ATTACHMENT_DIAGNOSTICS_TEMPLATE = '/v1/attachments/diagnostics'
export const RUNTIME_ATTACHMENT_TEMPLATE = '/v1/attachments/{id}'
export function runtimeAttachmentPath(attachmentId: string): string {
  return `/v1/attachments/${encodeURIComponent(attachmentId)}`
}
export const RUNTIME_ATTACHMENT_CONTENT_TEMPLATE = '/v1/attachments/{id}/content'
export function runtimeAttachmentContentPath(attachmentId: string): string {
  return `${runtimeAttachmentPath(attachmentId)}/content`
}

export const RUNTIME_FLOWS_TEMPLATE = '/v1/flows'
export const RUNTIME_FLOW_TEMPLATE = '/v1/flows/{id}'
export const RUNTIME_FLOW_VALIDATE_TEMPLATE = '/v1/flows/validate'
export const RUNTIME_FLOW_PUBLISH_TEMPLATE = '/v1/flows/publish'
export const RUNTIME_FLOW_RUN_TEMPLATE = '/v1/flows/run'
export const RUNTIME_FLOW_TEST_NODE_TEMPLATE = '/v1/flows/test-node'
export const RUNTIME_FLOW_HISTORY_TEMPLATE = '/v1/flows/{id}/history'
export const RUNTIME_FLOW_EXPORT_TEMPLATE = '/v1/flows/{id}/export'
export const RUNTIME_FLOW_RUN_DETAILS_TEMPLATE = '/v1/flow-runs/{id}'
export const RUNTIME_FLOW_RUN_CANCEL_TEMPLATE = '/v1/flow-runs/{id}/cancel'
export const RUNTIME_FLOW_RUN_RESUME_TEMPLATE = '/v1/flow-runs/{id}/resume'
export const RUNTIME_FLOW_RUN_RETRY_TEMPLATE = '/v1/flow-runs/{id}/retry'
export const RUNTIME_FLOW_RUN_DECISION_TEMPLATE = '/v1/flow-runs/decision'

// Engineering delivery endpoints. Keep these in the shared endpoint table so
// renderer calls and the main-process IPC allow-list stay in sync.
export const RUNTIME_ENGINEERING_PROJECTS_TEMPLATE = '/v1/engineering/projects'
export const RUNTIME_ENGINEERING_PROJECT_TEMPLATE = '/v1/engineering/projects/{id}'
export const RUNTIME_ENGINEERING_PROJECT_OVERVIEW_TEMPLATE = '/v1/engineering/projects/{id}/overview'
export const RUNTIME_ENGINEERING_DATASETS_IMPORT_TEMPLATE = '/v1/engineering/datasets/import'
export const RUNTIME_ENGINEERING_DATASET_VALIDATE_TEMPLATE = '/v1/engineering/datasets/{id}/validate'
export const RUNTIME_ENGINEERING_FINDING_ACCEPT_TEMPLATE = '/v1/engineering/datasets/{id}/findings/{turn}/accept'
export const RUNTIME_ENGINEERING_ANALYSES_TEMPLATE = '/v1/engineering/analyses'
export const RUNTIME_ENGINEERING_CHARTS_TEMPLATE = '/v1/engineering/charts'
export const RUNTIME_ENGINEERING_REPORT_PREVIEW_TEMPLATE = '/v1/engineering/reports/preview'
export const RUNTIME_ENGINEERING_DELIVERABLES_FINALIZE_TEMPLATE = '/v1/engineering/deliverables/finalize'
export const RUNTIME_ENGINEERING_RUN_TEMPLATE = '/v1/engineering/runs/{id}'
export const RUNTIME_ENGINEERING_RUN_CANCEL_TEMPLATE = '/v1/engineering/runs/{id}/cancel'
export const RUNTIME_ENGINEERING_RUN_RESUME_TEMPLATE = '/v1/engineering/runs/{id}/resume'
export const RUNTIME_ENGINEERING_AI_CONTEXT_TEMPLATE = '/v1/engineering/ai/context/{id}'
export const RUNTIME_ENGINEERING_AI_EVIDENCE_TEMPLATE = '/v1/engineering/ai/evidence/{id}'
export const RUNTIME_ENGINEERING_AI_WATCH_DRAFTS_TEMPLATE = '/v1/engineering/ai/watch-drafts'
export const RUNTIME_ENGINEERING_AI_PLANS_TEMPLATE = '/v1/engineering/ai/plans'
export const RUNTIME_ENGINEERING_AI_PROJECT_SUGGESTIONS_TEMPLATE = '/v1/engineering/ai/project-suggestions'
export const RUNTIME_ENGINEERING_AI_PROJECT_SUGGESTION_DECISION_TEMPLATE = '/v1/engineering/ai/project-suggestions/{id}/decision'
export const RUNTIME_ENGINEERING_AI_PLAN_TEMPLATE = '/v1/engineering/ai/plans/{id}'
export const RUNTIME_ENGINEERING_AI_PLAN_VALIDATE_TEMPLATE = '/v1/engineering/ai/plans/{id}/validate'
export const RUNTIME_ENGINEERING_AI_PLAN_APPROVE_TEMPLATE = '/v1/engineering/ai/plans/{id}/approve'
export const RUNTIME_ENGINEERING_AI_PLAN_START_TEMPLATE = '/v1/engineering/ai/plans/{id}/start'
export const RUNTIME_ENGINEERING_AI_PLAN_CANCEL_TEMPLATE = '/v1/engineering/ai/plans/{id}/cancel'
export const RUNTIME_ENGINEERING_AI_PLAN_RESUME_TEMPLATE = '/v1/engineering/ai/plans/{id}/resume'
export const RUNTIME_ENGINEERING_CAPABILITIES_TEMPLATE = '/v1/engineering/capabilities'
export const RUNTIME_ENGINEERING_SKILLS_CATALOG_TEMPLATE = '/v1/engineering/skills/catalog'
export const RUNTIME_ENGINEERING_SURVEY_COSA_GROUP_INSPECT_TEMPLATE = '/v1/engineering/survey/source-groups/cosa/inspect'
export const RUNTIME_ENGINEERING_SURVEY_NETWORK_IMPORT_TEMPLATE = '/v1/engineering/survey/networks/import'
export const RUNTIME_ENGINEERING_SURVEY_NETWORKS_TEMPLATE = '/v1/engineering/survey/networks'
export const RUNTIME_ENGINEERING_SURVEY_NETWORK_TEMPLATE = '/v1/engineering/survey/networks/{id}'
export const RUNTIME_ENGINEERING_SURVEY_NETWORK_VALIDATE_TEMPLATE = '/v1/engineering/survey/networks/{id}/validate'
export const RUNTIME_ENGINEERING_SURVEY_NETWORK_CORRECTIONS_TEMPLATE = '/v1/engineering/survey/networks/{id}/corrections'
export const RUNTIME_ENGINEERING_SURVEY_NETWORK_CORRECTIONS_REPLAY_TEMPLATE = '/v1/engineering/survey/networks/{id}/corrections/replay'
export const RUNTIME_ENGINEERING_ADJUSTMENTS_TEMPLATE = '/v1/engineering/adjustments'
export const RUNTIME_ENGINEERING_ADJUSTMENT_TEMPLATE = '/v1/engineering/adjustments/{id}'
export const RUNTIME_ENGINEERING_ADJUSTMENT_CANCEL_TEMPLATE = '/v1/engineering/adjustments/{id}/cancel'
export const RUNTIME_ENGINEERING_ADJUSTMENT_RESUME_TEMPLATE = '/v1/engineering/adjustments/{id}/resume'
export const RUNTIME_ENGINEERING_ADJUSTMENT_PREVIEW_TEMPLATE = '/v1/engineering/adjustments/{id}/preview'
export const RUNTIME_ENGINEERING_STATISTICAL_DIAGNOSTICS_TEMPLATE = '/v1/engineering/projects/{id}/adjustments/{adjustmentId}/statistical-diagnostics'
export const RUNTIME_ENGINEERING_FREE_LEVELING_TRIALS_TEMPLATE = '/v1/engineering/projects/{id}/networks/{networkId}/free-leveling-trials'
export const RUNTIME_ENGINEERING_FREE_LEVELING_TRIAL_TEMPLATE = `${RUNTIME_ENGINEERING_FREE_LEVELING_TRIALS_TEMPLATE}/{trialId}`
export function runtimeSurveyFreeLevelingTrialsPath(projectId: string, networkId: string): string {
  return `/v1/engineering/projects/${encodeURIComponent(projectId)}/networks/${encodeURIComponent(networkId)}/free-leveling-trials`
}
export function runtimeSurveyFreeLevelingTrialPath(projectId: string, networkId: string, trialId: string): string {
  return `${runtimeSurveyFreeLevelingTrialsPath(projectId, networkId)}/${encodeURIComponent(trialId)}`
}
export function runtimeSurveyStatisticalDiagnosticsPath(projectId: string, adjustmentId: string, download = false): string {
  return `/v1/engineering/projects/${encodeURIComponent(projectId)}/adjustments/${encodeURIComponent(adjustmentId)}/statistical-diagnostics${download ? '?download=1' : ''}`
}
export const RUNTIME_ENGINEERING_DEFORMATIONS_TEMPLATE = '/v1/engineering/deformations'
export const RUNTIME_ENGINEERING_DEFORMATION_TEMPLATE = '/v1/engineering/deformations/{id}'

export const RUNTIME_MEMORY_PATH = '/v1/memory'
export const RUNTIME_MEMORY_TEMPLATE = '/v1/memory'
export const RUNTIME_MEMORY_DIAGNOSTICS_PATH = '/v1/memory/diagnostics'
export const RUNTIME_MEMORY_DIAGNOSTICS_TEMPLATE = '/v1/memory/diagnostics'
export const RUNTIME_MEMORY_RECORD_TEMPLATE = '/v1/memory/{id}'
export function runtimeMemoryRecordPath(memoryId: string): string {
  return `/v1/memory/${encodeURIComponent(memoryId)}`
}

export const RUNTIME_THREADS_PATH = '/v1/threads'
export const RUNTIME_THREADS_TEMPLATE = '/v1/threads'

export const RUNTIME_TASKS_PATH = '/v1/tasks'
export const RUNTIME_TASKS_TEMPLATE = '/v1/tasks'
export const RUNTIME_TASK_TEMPLATE = '/v1/tasks/{id}'
export const RUNTIME_TASK_RESUME_TEMPLATE = '/v1/tasks/{id}/resume'
export const RUNTIME_TASK_RETRY_TEMPLATE = '/v1/tasks/{id}/retry'
export const RUNTIME_TASK_CANCEL_TEMPLATE = '/v1/tasks/{id}/cancel'
export const RUNTIME_TASK_DIAGNOSTICS_TEMPLATE = '/v1/tasks/{id}/diagnostics'
export function runtimeTaskPath(taskId: string): string {
  return `/v1/tasks/${encodeURIComponent(taskId)}`
}
export function runtimeTaskResumePath(taskId: string): string {
  return `${runtimeTaskPath(taskId)}/resume`
}
export function runtimeTaskRetryPath(taskId: string): string {
  return `${runtimeTaskPath(taskId)}/retry`
}
export function runtimeTaskCancelPath(taskId: string): string {
  return `${runtimeTaskPath(taskId)}/cancel`
}
export function runtimeTaskDiagnosticsPath(taskId: string): string {
  return `${runtimeTaskPath(taskId)}/diagnostics`
}

export const RUNTIME_SHELL_SESSIONS_PATH = '/v1/shell-sessions'
export const RUNTIME_SHELL_SESSIONS_TEMPLATE = '/v1/shell-sessions'
export const RUNTIME_SHELL_SESSION_TERMINATE_TEMPLATE = '/v1/shell-sessions/{id}/terminate'
export function runtimeShellSessionTerminatePath(sessionId: string): string {
  return `/v1/shell-sessions/${encodeURIComponent(sessionId)}/terminate`
}

export const RUNTIME_THREAD_TEMPLATE = '/v1/threads/{id}'
export function runtimeThreadPath(threadId: string): string {
  return `/v1/threads/${encodeURIComponent(threadId)}`
}

export const RUNTIME_THREAD_FORK_TEMPLATE = '/v1/threads/{id}/fork'
export function runtimeThreadForkPath(threadId: string): string {
  return `${runtimeThreadPath(threadId)}/fork`
}

export const RUNTIME_THREAD_AGENT_TEMPLATE = '/v1/threads/{id}/agent'
export function runtimeThreadAgentPath(threadId: string): string {
  return `${runtimeThreadPath(threadId)}/agent`
}

export const RUNTIME_THREAD_GOAL_TEMPLATE = '/v1/threads/{id}/goal'
export function runtimeThreadGoalPath(threadId: string): string {
  return `${runtimeThreadPath(threadId)}/goal`
}

export const RUNTIME_THREAD_TODOS_TEMPLATE = '/v1/threads/{id}/todos'
export function runtimeThreadTodosPath(threadId: string): string {
  return `${runtimeThreadPath(threadId)}/todos`
}

export const RUNTIME_THREAD_COMPACT_TEMPLATE = '/v1/threads/{id}/compact'
export function runtimeThreadCompactPath(threadId: string): string {
  return `${runtimeThreadPath(threadId)}/compact`
}

export const RUNTIME_THREAD_REVIEW_TEMPLATE = '/v1/threads/{id}/review'
export function runtimeThreadReviewPath(threadId: string): string {
  return `${runtimeThreadPath(threadId)}/review`
}

export const RUNTIME_THREAD_TURNS_TEMPLATE = '/v1/threads/{id}/turns'
export function runtimeThreadTurnsPath(threadId: string): string {
  return `${runtimeThreadPath(threadId)}/turns`
}

export const RUNTIME_THREAD_UI_ACTIONS_TEMPLATE = '/v1/threads/{id}/ui-actions'
export function runtimeThreadUiActionsPath(threadId: string): string {
  return `${runtimeThreadPath(threadId)}/ui-actions`
}

export const RUNTIME_THREAD_WORKSPACE_REFERENCE_SEARCH_TEMPLATE =
  '/v1/threads/{id}/workspace/references/search'
export function runtimeThreadWorkspaceReferenceSearchPath(threadId: string): string {
  return `${runtimeThreadPath(threadId)}/workspace/references/search`
}

export const RUNTIME_WORKSPACE_REFERENCE_SEARCH_PATH = '/v1/workspace/references/search'
export const RUNTIME_WORKSPACE_REFERENCE_SEARCH_TEMPLATE = RUNTIME_WORKSPACE_REFERENCE_SEARCH_PATH

export const RUNTIME_THREAD_STEER_TEMPLATE = '/v1/threads/{id}/turns/{turn}/steer'
export function runtimeThreadSteerPath(threadId: string, turnId: string): string {
  return `${runtimeThreadTurnsPath(threadId)}/${encodeURIComponent(turnId)}/steer`
}

export const RUNTIME_THREAD_INTERRUPT_TEMPLATE = '/v1/threads/{id}/turns/{turn}/interrupt'
export function runtimeThreadInterruptPath(threadId: string, turnId: string): string {
  return `${runtimeThreadTurnsPath(threadId)}/${encodeURIComponent(turnId)}/interrupt`
}

export const RUNTIME_THREAD_EVENTS_TEMPLATE = '/v1/threads/{id}/events'
export function runtimeThreadEventsPath(threadId: string): string {
  return `${runtimeThreadPath(threadId)}/events`
}

export const RUNTIME_APPROVAL_TEMPLATE = '/v1/approvals/{id}'
export function runtimeApprovalPath(approvalId: string): string {
  return `/v1/approvals/${encodeURIComponent(approvalId)}`
}

export const RUNTIME_USER_INPUT_TEMPLATE = '/v1/user-inputs/{id}'
export function runtimeUserInputPath(inputId: string): string {
  return `/v1/user-inputs/${encodeURIComponent(inputId)}`
}

export const RUNTIME_SESSION_RESUME_TEMPLATE = '/v1/sessions/{id}/resume-thread'
export function runtimeSessionResumePath(sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(sessionId)}/resume-thread`
}

export const RUNTIME_USAGE_PATH = '/v1/usage'
export const RUNTIME_USAGE_TEMPLATE = '/v1/usage'

/** Thread mode shared with the managed runtime contract. */
export type RuntimeThreadMode = 'agent' | 'plan'

const THREAD_MODES: ReadonlySet<RuntimeThreadMode> = new Set<RuntimeThreadMode>(['agent', 'plan'])

export function isRuntimeThreadMode(value: unknown): value is RuntimeThreadMode {
  return typeof value === 'string' && (THREAD_MODES as Set<string>).has(value)
}

export function normalizeThreadMode(value: unknown): RuntimeThreadMode {
  return value === 'plan' ? 'plan' : 'agent'
}

export const RUNTIME_ENGINEERING_MANIFEST_VERIFY_TEMPLATE = '/v1/engineering/projects/{id}/manifests/{manifestId}/verify'
export const RUNTIME_ENGINEERING_MONITORING_REPLAY_TEMPLATE = '/v1/engineering/projects/{id}/manifests/{manifestId}/monitoring-replay'
