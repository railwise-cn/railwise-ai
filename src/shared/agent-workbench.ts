export const TASK_RUN_STATUSES = [
  'queued',
  'running',
  'paused',
  'waiting_user',
  'waiting_approval',
  'retrying',
  'stalled',
  'completed',
  'failed',
  'cancelled'
] as const

export type TaskRunStatus = typeof TASK_RUN_STATUSES[number]
export type TaskNodeKind = 'plan' | 'execute' | 'verify' | 'deliver'
export type TaskNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked'
export type ConversationViewMode = 'concise' | 'standard' | 'developer'
export type WorkspaceTrustLevel = 'read-only' | 'workspace-write' | 'trusted' | 'full-access'
export type DocumentEngineId = 'markitdown' | 'unlimited-ocr-local' | 'mineru-local' | 'mineru-private'
export type DocumentParsingMode = 'auto' | 'fast' | 'accurate'

export const DOCUMENT_QUALITY_REASONS_V1 = [
  'low_text_density',
  'weak_text_layer',
  'scanned_document',
  'scanned_or_sparse_pages',
  'garbled_text',
  'formula_dense',
  'table_dense',
  'complex_layout',
  'engine_fallback'
] as const

export type DocumentQualityReasonV1 = typeof DOCUMENT_QUALITY_REASONS_V1[number]

export function isDocumentQualityReasonV1(value: unknown): value is DocumentQualityReasonV1 {
  return typeof value === 'string'
    && (DOCUMENT_QUALITY_REASONS_V1 as readonly string[]).includes(value)
}

export type RevisionMutation = {
  expectedRevision: number
  idempotencyKey: string
}

export type TaskArtifactV1 = {
  storage?: 'task'
  id: string
  relativePath: string
  absolutePath?: string
  authorizedRoot?: string
  executionGrantId?: string
  mediaType?: string
  format?: string
  sizeBytes?: number
  sha256?: string
  validation: 'pending' | 'valid' | 'invalid'
  validationMessage?: string
  createdAt: string
}

export type TaskAcceptanceV1 = {
  kind: 'answer' | 'files' | 'effect'
  requiredNodeKinds: TaskNodeKind[]
  requiredFormats?: string[]
  minimumArtifacts?: number
  requireFinalResponse: boolean
  requireActionableArtifactCard: boolean
  requiresExternalEffects?: boolean
  effect?: Omit<TaskRequiredEffectV1, 'target'> & { target?: string; requiredEffects?: TaskRequiredEffectV1[] }
}

export type TaskRequiredEffectV1 = {
  provider: string
  operation: string
  target: string
  requiredScopes?: string[]
  requiresConfirmation?: boolean
  successStatus?: string[]
  verification?: 'provider_readback'
}

export type TaskResultEvidenceV1 = {
  kind: 'external_operation' | 'file' | 'tool_result' | 'human_confirmation'
  provider: string
  operation: string
  target: string
  status: string
  verified: boolean
  verifiedAt: string
  remoteOperationId?: string
  resultHash: string
  sourceVersion?: string
  targetVersion?: string
}

/** Read-only projection: raw requests, results, credentials and execution IDs stay in Runtime. */
export type TaskOperationReceiptV1 = {
  purpose?: 'assistant_reply' | 'host_shell' | 'browser_action'
  phase?: 'upload' | 'send'
  shell?: { canPoll?: boolean; exitCode?: number; outputSha256?: string; message?: string }
  browser?: { action: 'click' | 'fill'; pageUrl?: string; canReview: boolean }
  id: string
  taskId: string
  provider: string
  operation: string
  toolName: string
  target?: string
  requestHash: string
  status: 'prepared' | 'running' | 'succeeded' | 'failed' | 'outcome_unknown'
  remoteOperationId?: string
  evidence?: TaskResultEvidenceV1
  resolution?: { status: 'verified'; receiptId: string; evidence: TaskResultEvidenceV1; resolvedAt: string }
  errorCode?: string
  createdAt: string
  updatedAt: string
}

export type BrowserOperationReviewV1 = { id: string; expiresAt: string; action: 'click' | 'fill'; pageUrl: string; observationText: string; targetLabel?: string; value?: string }
export type BrowserOperationConfirmationV1 = { expectedRevision: number; idempotencyKey: string; reviewId: string; decision: 'confirmed_complete' }
export type TaskOperationVerificationV1 = { taskId: string; receiptId: string; status: 'verified' | 'outcome_unknown' | 'running' | 'failed'; evidence?: TaskResultEvidenceV1; errorCode?: string; browserReview?: BrowserOperationReviewV1; shell?: { status: 'verified' | 'running' | 'failed' | 'outcome_unknown'; message: string; exitCode?: number; outputSha256?: string } }

export type TaskPermissionScopeV1 = {
  readPaths?: string[]; writePaths?: string[]; networkOrigins?: string[]; providerIds?: string[]; externalTargets?: string[]
}
export type TaskExecutionPermissionV1 = {
  id?: string
  turnId: string; workspaceRoot: string; workspaceTrust: WorkspaceTrustLevel; agentTrust: WorkspaceTrustLevel
  sandboxMode: string; approvalPolicy: string; allowedToolNames?: string[]; allowedProviderIds?: string[]
  pathAllowlist: string[]; readPathAllowlist?: string[]; writePathAllowlist?: string[]; networkAllowlist: string[]
  connectorScopes: string[]; externalTargets: string[]; issuedAt: string; expiresAt?: string
  browserScope?: import('../../kun/src/contracts/browser-skill').BrowserExecutionScope
}
export type TaskPermissionSnapshotV1 = {
  taskId: string; taskRevision: number; taskTitle: string; scopeHash: string
  workspaceRoot: string; workspaceTrust: WorkspaceTrustLevel; workspaceRevision: number; agentRevision: number
  approvalPolicy: string; targetApprovalPolicy: 'on-request'; maxTtlSeconds: 900
  /** Server-derived authority ceilings; these are not the current executable tool catalog. */
  sandboxMode?: string; agentTrust?: WorkspaceTrustLevel; agentName?: string
  toolAllowlist?: string[]; mcpAllowlist?: string[]; externalTargets?: string[]
  connectorScopeSources?: Array<{ provider: string; scopes: string[]; source: 'task_requirements' | 'tool_catalog' | 'last_execution_grant'; issuedAt?: string; expiresAt?: string }>
  canWritePaths?: boolean
  canConfirm: boolean; reason?: string
  executionGrants?: TaskExecutionPermissionV1[]
  grant?: { id: string; status: 'active' | 'expired' | 'invalid' | 'prepared' | 'consumed'; confirmedAt: string; expiresAt: string; scope?: TaskPermissionScopeV1; duration?: 'task'|'next_operation' }
}
export type TaskPermissionConfirmationV1 = {
  expectedRevision: number; idempotencyKey: string; scopeHash: string; confirmed: true; approvalPolicy: 'on-request'; ttlSeconds: number
  scope?: TaskPermissionScopeV1; duration?: 'task'|'next_operation'
}

export type TaskNodeV1 = {
  id: string
  taskId: string
  kind: TaskNodeKind
  title: string
  status: TaskNodeStatus
  dependsOn: string[]
  attempt: number
  maxAttempts: number
  idempotencyKey: string
  progressFingerprint?: string
  evidence: string[]
  errorCode?: string
  errorMessage?: string
  startedAt?: string
  finishedAt?: string
  revision: number
}

export type TaskCheckpointV1 = {
  id: string
  taskId: string
  completedNodeIds: string[]
  pendingNodeIds: string[]
  artifactIds: string[]
  eventSequence: number
  resumeSummary: string
  progressFingerprint?: string
  createdAt: string
  revision: number
}

export type TaskRunV1 = {
  id: string
  threadId: string
  originThreadId?: string
  executionSessionId?: string
  visible?: boolean
  visibility?: string
  retryOfTaskId?: string
  timing?: { executionMs: number; queuedMs: number; humanWaitMs: number; pausedMs: number; sampledAt: string; coverage: 'complete' | 'partial' }
  activeTurnId?: string
  parentTaskId?: string
  rootTaskId?: string
  childTaskIds: string[]
  workspaceRoot: string
  repositoryRoot?: string
  goal: string
  templateId?: string
  deliveryFormats?: Array<'md' | 'docx' | 'pdf'>
  status: TaskRunStatus
  acceptance: TaskAcceptanceV1
  agentId: string
  model?: string
  budget: {
    version?: 1 | 2
    maxAttempts: number
    maxDurationMs: number
    maxExecutionMs?: number
    maxElapsedMs?: number
    maxCostUsd?: number
  }
  attempts: number
  replans: number
  noProgressCount: number
  nodes: TaskNodeV1[]
  artifacts: TaskArtifactV1[]
  resultEvidence?: TaskResultEvidenceV1[]
  finalResponse?: string
  stalledReason?: string
  waitingReason?: string
  createdAt: string
  updatedAt: string
  finishedAt?: string
  revision: number
}

export type TaskRunListQuery = {
  threadId?: string
  workspaceRoot?: string
  status?: TaskRunStatus
  limit?: number
  offset?: number
  search?: string
  cursor?: string
}

export type TaskInputV1 = {
  id: string
  taskId: string
  kind: 'supplement' | 'user_answer' | 'approval_resolution' | 'tool_result' | 'handoff'
  text: string
  createdAt: string
  deliveredAt?: string
  consumedAt?: string
  sourceId?: string
  idempotencyKey: string
}

export type TaskEventV1 = {
  taskId: string
  sequence: number
  eventKey: string
  kind: string
  payload: Record<string, unknown>
  createdAt: string
}

export type TaskAttentionV1 = {
  id: string
  ownerKind: 'task' | 'flow'
  ownerId: string
  taskId?: string
  threadId?: string
  workspaceRoot?: string
  flowId?: string
  flowRunId?: string
  nodeId?: string
  kind: 'question' | 'approval' | 'conflict' | 'blocked'
  title: string
  message: string
  status: 'pending' | 'answered' | 'cancelled' | 'expired'
  revision: number
  createdAt: string
  updatedAt: string
  requestId?: string
  payload?: Record<string, unknown>
}

export type TaskTemplateId = 'monitoring-report' | 'tender-document' | 'research-document'
export type TaskTemplateV1 = {
  id: TaskTemplateId
  name: string
  description: string
  stages: string[]
  outputs: string[]
  requiredInputs: string[]
  availability?: { draftAvailable: boolean; model?: string; exportStatus: 'configured' | 'unavailable' }
}
export type TaskTemplateStartV1 = {
  workspaceRoot: string
  goal: string
  sourcePaths?: string[]
  outputDirectory?: string
  outputFormats?: Array<'md' | 'docx' | 'pdf'>
  model?: string
  providerId?: string
  idempotencyKey: string
}

export type AgentProfileV1 = {
  id: string
  name: string
  role: string
  color: string
  systemPrompt: string
  model?: string
  toolAllowlist: string[]
  mcpAllowlist: string[]
  preferredSkillIds?: string[]
  trustLevel: WorkspaceTrustLevel
  budget: {
    maxAttempts: number
    maxDurationMs: number
    maxCostUsd?: number
  }
  builtIn: boolean
  source: 'built-in' | 'global' | 'workspace'
  path?: string
  revision: number
}

export type AgentProfileDiagnosticV1 = {
  path: string
  code: 'invalid_frontmatter' | 'invalid_profile' | 'duplicate_id' | 'unsafe_path'
  message: string
}

export type AgentProfileSnapshotV1 = {
  generation: number
  profiles: AgentProfileV1[]
  diagnostics: AgentProfileDiagnosticV1[]
}

export type ThreadAgentSelectionV1 = {
  id: string
  workspace: string
  agentId: string
  agentRevision: number
  agentProfile?: Omit<AgentProfileV1, 'builtIn' | 'source' | 'path'>
}

export type WorkspaceTrustV1 = {
  canonicalRoot: string
  level: WorkspaceTrustLevel
  source: 'workwise-created' | 'external' | 'migrated' | 'user'
  confirmedAt?: string
  revision: number
}

export type McpCredentialReferenceV1 = {
  id: string
  storage: 'keychain' | 'dpapi' | 'safe-storage' | 'session'
}

export type McpServerConfigV2 = {
  id: string
  name: string
  scope: 'global' | 'workspace'
  workspaceRoot?: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  cwd?: string
  url?: string
  timeoutMs: number
  source: 'user' | 'skill' | 'managed-tool' | 'migration'
  credentialRef?: McpCredentialReferenceV1
  credentialEnvironmentVariables?: string[]
  managedPreset?: 'amap-readonly' | 'zotero-readonly'
  readOnlyTools?: string[]
  oauth?: {
    resource?: string
    authorizationUrl?: string
    tokenUrl?: string
    registrationUrl?: string
    clientId?: string
    redirectUri: string
    scopes: string[]
    discovery?: {
      protectedResourceMetadataUrl?: string
      authorizationServer?: string
      authorizationServerMetadataUrl?: string
      codeChallengeMethodsSupported: string[]
      clientRegistration: 'static' | 'dynamic'
    }
  }
  toolPolicy: Record<string, 'allow' | 'ask' | 'deny'>
  enabled: boolean
  revision: number
  /** Main-process connection evidence. Save requests cannot supply this field. */
  connectionCheck?: McpConnectionCheckV1
}

export type McpConnectionCheckV1 = {
  serverRevision: number
  configurationHash: string
  credentialRefId?: string
  checkedAt: string
  state: McpServerStatusV1['state']
  authorized: boolean
  verification?: 'tool_discovery'
  toolCount?: number
  errorCode?: McpServerStatusV1['errorCode']
}

export type McpServerStatusV1 = {
  id: string
  state: 'disconnected' | 'connecting' | 'connected' | 'needs_authorization' | 'error'
  authorized: boolean
  checkedAt?: string
  verification?: 'tool_discovery'
  latencyMs?: number
  message?: string
  errorCode?: 'missing_credentials' | 'invalid_credentials' | 'insufficient_scope' | 'network_blocked' | 'service_unavailable' | 'connection_failed' | 'tool_manifest_mismatch' | 'local_api_unavailable' | 'configuration_changed' | 'credential_unavailable' | 'credential_helper_timeout' | 'credential_helper_access_denied'
  toolCount?: number
  authorizationUrl?: string
  authorizationState?: string
  authorizationCallback?: 'loopback' | 'manual'
  authorizationExpiresAt?: string
}

export type ShellSessionV1 = {
  id: string
  taskId: string
  nodeId: string
  workspaceRoot: string
  commandSummary: string
  cwd: string
  status: 'starting' | 'running' | 'completed' | 'failed' | 'terminated' | 'interrupted'
  exitCode?: number
  outputPath: string
  outputBytes: number
  createdAt: string
  startedAt?: string
  finishedAt?: string
  revision: number
}

export type GitCheckpointFileV1 = {
  relativePath: string
  beforeSha256?: string
  taskStartContentPath?: string
  originallyModified: boolean
}

export type GitCheckpointV1 = {
  id: string
  taskId: string
  workspaceRoot: string
  repositoryRoot: string
  head: string
  originalStatus: string
  files: GitCheckpointFileV1[]
  rescueRef?: string
  createdAt: string
  revision: number
}

export type GitRollbackPreviewV1 = {
  checkpointId: string
  safe: boolean
  changedFiles: Array<{ relativePath: string; diff: string; conflict: boolean }>
  rescueRef?: string
  message?: string
}

export type RuntimeSpanV1 = {
  id: string
  taskId?: string
  turnId?: string
  parentSpanId?: string
  kind: 'task' | 'turn' | 'model' | 'tool' | 'mcp' | 'child-task' | 'shell' | 'validation' | 'document'
  name: string
  status: 'running' | 'ok' | 'error' | 'cancelled'
  startedAt: string
  finishedAt?: string
  durationMs?: number
  retryCount: number
  inputTokens?: number
  outputTokens?: number
  cacheHit?: boolean
  model?: string
  errorCode?: string
  attributes: Record<string, string | number | boolean>
}

export type DocumentPageReferenceV1 = {
  page: number
  blockId?: string
  kind?: 'text' | 'table' | 'formula' | 'image'
  boundingBox?: [number, number, number, number]
}

export type DocumentParseRequestV1 = {
  parseId?: string
  workspaceRoot: string
  relativePath: string
  outputDirectory?: string
  mode: DocumentParsingMode
  preferredEngine?: DocumentEngineId
  allowPrivateServerUpload?: boolean
  idempotencyKey: string
}

export type DocumentParseResultV1 = {
  id: string
  engine: DocumentEngineId
  engineVersion: string
  sourceSha256: string
  markdown: string
  headings: Array<{ level: number; text: string; page?: number }>
  tables: Array<{ markdown: string; page?: number }>
  media: Array<{ relativePath: string; mediaType?: string; page?: number }>
  references: DocumentPageReferenceV1[]
  sourceStructure?: {
    pageCount?: number
    worksheets?: string[]
    slideCount?: number
  }
  warnings: string[]
  quality: {
    status: 'good' | 'degraded' | 'enhanced'
    reasons: string[]
  }
  route: {
    requestedMode: DocumentParsingMode
    selectedEngine: DocumentEngineId
    fallbackFrom?: DocumentEngineId
    switchReason?: string[]
  }
  degradedFrom?: DocumentEngineId
  cacheHit: boolean
  durationMs: number
}

export type DocumentParseErrorCode =
  | 'document_engine_unavailable'
  | 'document_parse_failed'
  | 'document_parse_cancelled'
  | 'document_parse_timeout'
  | 'document_upload_not_allowed'
  | 'resource_limit'
  | 'unsupported_format'

export type DocumentEngineStatusV1 = {
  id: DocumentEngineId
  state: 'available' | 'not_installed' | 'installing' | 'needs_configuration' | 'error'
  version?: string
  local: boolean
  capabilities: Array<'pdf' | 'docx' | 'pptx' | 'xlsx' | 'ocr' | 'layout' | 'formula'>
  message?: string
  attribution?: string
}

export type WorkspacePreviewResultV1 =
  | { kind: 'image'; mediaType: string; dataUrl: string; sizeBytes: number }
  | { kind: 'svg'; sanitizedSvg: string; sizeBytes: number }
  | { kind: 'markdown'; html: string; source: string; sizeBytes: number }
  | {
      kind: 'pdf'
      relativePath: string
      pageCount: number
      searchable: boolean
      pageTexts: Array<{ page: number; text: string }>
      dataUrl?: string
      truncated: boolean
      warnings: string[]
      retryReasons?: DocumentQualityReasonV1[]
      documentError?: { code: DocumentParseErrorCode; message: string }
      document?: Pick<DocumentParseResultV1, 'engine' | 'engineVersion' | 'quality' | 'route' | 'headings' | 'references'>
      sizeBytes: number
    }
  | {
      kind: 'office'
      format: 'docx' | 'pptx' | 'xlsx'
      markdown: string
      pageCount?: number
      sheetNames?: string[]
      warnings: string[]
      sizeBytes: number
    }
  | { kind: 'metadata'; name: string; mediaType?: string; sizeBytes: number; message: string }

export type RepoMapResultV1 = {
  repositoryRoot: string
  cacheKey: string
  filesIndexed: number
  bytesIndexed: number
  truncated: boolean
  symbols: Array<{
    name: string
    kind: string
    relativePath: string
    line: number
    exported: boolean
  }>
  imports: Array<{ from: string; to: string }>
}

export type LspRequestV1 = {
  workspaceRoot: string
  repositoryRoot: string
  relativePath: string
  line: number
  column: number
  kind: 'definition' | 'references' | 'symbols' | 'diagnostics' | 'hover'
}

export type LspResponseV1 = {
  kind: LspRequestV1['kind']
  items: Array<{
    relativePath: string
    line: number
    column: number
    name?: string
    kind?: string
    text?: string
    category?: string
  }>
  truncated: boolean
}

export type WorkbenchMutationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'stale_request' | 'unsafe_path' | 'resource_limit' | 'not_found' | 'invalid_state' | 'error'; message: string }

export type TaskPageQuery = { workspaceRoot?: string; threadId?: string; search?: string; filter?: 'ongoing'|'attention'|'completed'|'all'; limit?: number; cursor?: string }
export type TaskRunPage = { items: TaskRunV1[]; relatedTasks: TaskRunV1[]; attention: TaskAttentionV1[]; total: number; counts: Record<'ongoing'|'attention'|'completed'|'all',number>; nextCursor?: string; snapshotId: string; expiresAt: string; eventWatermark: number }
export type TaskChangeEvent = { seq:number; taskId?:string; kind:'task_changed'|'attention_changed'; payload:Record<string,unknown>; createdAt:string }
