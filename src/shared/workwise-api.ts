import type { WorkspaceMigrationReport, WorkspaceImportRequest, WorkspaceImportResult } from './workspace-migration'
import type { ManagedDwsResult, ManagedDwsTaskAccessResult } from './managed-dws'
import type {
  AppSettingsPatch,
  WorkWiseSettingsV2,
  ClawRunResult,
  ClawTaskFromTextResult,
  ClawRuntimeStatus,
  ScheduleRunResult,
  ScheduleRuntimeStatus,
  ScheduleTaskFromTextResult
} from './app-settings'
import type { EditorListResult, EditorOpenResult, OpenEditorPathOptions } from './editor'
import type { GitBranchesResult } from './git-branches'
import type {
  GuiUpdateChannel,
  GuiUpdateDownloadResult,
  GuiUpdateInfo,
  GuiUpdateInstallPreflight,
  GuiUpdateInstallRequest,
  GuiUpdateInstallResult,
  GuiUpdateState
} from './gui-update'
import type {
  ClipboardImageReadResult,
  WorkspaceClipboardImageSavePayload,
  WorkspaceClipboardImageSaveResult,
  WorkspaceFileReadResult,
  WorkspaceFileSaveAsPayload,
  WorkspaceFileSaveAsResult,
  WorkspaceImageReadResult,
  WorkspaceDirectoryCreatePayload,
  WorkspaceDirectoryCreateResult,
  WorkspaceDirectoryListResult,
  WorkspaceDirectoryTarget,
  WorkspaceEntryRenamePayload,
  WorkspaceEntryRenameResult,
  WorkspaceEntryDeletePayload,
  WorkspaceEntryDeleteResult,
  WorkspaceFileChangePayload,
  WorkspaceFileCreatePayload,
  WorkspaceFileCreateResult,
  WorkspaceFileResolveResult,
  WorkspaceFileTarget,
  WorkspaceFileWatchPayload,
  WorkspaceFileWatchResult,
  WorkspaceFileWritePayload,
  WorkspaceFileWriteResult
} from './workspace-file'
import type {
  CheckedDocumentWritePayload,
  CheckedDocumentWriteResult,
  DocumentReadPayload,
  DocumentSearchPayload,
  DocumentSnapshot,
  DocumentHistoryEntry,
  DocumentHistoryListResult,
  DocumentHistoryPayload,
  DocumentRestorePayload,
  DocumentComment,
  DocumentCommentCreatePayload,
  DocumentCommentUpdatePayload,
  DocumentSemantics,
  DocumentSemanticsPayload,
  WorkspaceSearchResponse
} from './write-document'
import type {
  PptMasterDeliverableVerifyRequest,
  PptMasterDeliverableVerifyResult,
  PptMasterPythonEnvEnsureResult,
  PptMasterPythonEnvProgress,
  PptMasterPythonEnvStatus
} from './ppt-master-services'
import type {
  WriteInlineCompletionDebugEntry,
  WriteInlineCompletionRequest,
  WriteInlineCompletionResult
} from './write-inline-completion'
import type {
  WriteInfographicRequest,
  WriteInfographicResult
} from './write-infographic'
import type {
  WriteExportPayload,
  WriteExportResult,
  WriteRichClipboardPayload,
  WriteRichClipboardResult
} from './write-export'
import type { DesignWriteAssetPayload, DesignWriteAssetResult } from './design-write'
import type { WriteMermaidPreviewRequest, WriteMermaidPreviewResult } from './write-mermaid-preview'
import type {
  DesignAssetReadPayload,
  DesignAssetReadResult,
  DesignDocumentListPayload,
  DesignDocumentListResult,
  DesignDocumentLoadPayload,
  DesignDocumentLoadResult,
  DesignDocumentSavePayload,
  DesignDocumentSaveResult,
  DesignImageImportPayload,
  DesignImageImportResult,
  DesignPptxImportPayload,
  DesignPptxImportResult,
  DesignPptxRevisionReadPayload,
  DesignPptxRevisionReadResult,
  DesignPptxRevisionSavePayload,
  DesignPptxRevisionSaveResult,
  DesignPptxBytesExportPayload,
  DesignPptxBytesExportResult
} from './design-workspace'
import type {
  AgnesImageGenerationPayload,
  AgnesImageGenerationResult
} from './agnes-image'
import type { CancelOperationRequest, CancelOperationResult } from './cancellation'
import type {
  AgentProfileSnapshotV1,
  AgentProfileV1,
  ThreadAgentSelectionV1,
  DocumentEngineId,
  DocumentEngineStatusV1,
  DocumentParseRequestV1,
  DocumentParseResultV1,
  DocumentParsingMode,
  DocumentQualityReasonV1,
  WorkspaceTrustLevel,
  WorkspaceTrustV1
} from './agent-workbench'
import type {
  CatalogSnapshotV1,
  CatalogSourceV1,
  CatalogCredentialStatusV1,
  InstalledPackagePermissionV1,
  InstalledPackageV1,
  MarketplaceCatalogPackagesResultV1,
  MarketplaceCatalogSyncResultV1,
  PreparedPluginImportV1,
  PluginUpdateDiagnosticV1
} from './marketplace'
import type { WindowAppearanceV1 } from './window-appearance'
import type { ImChannelHealthV1, ImDiagnosticsV1, ImLifecycleResultV1, ImSelfCheckResultV1 } from './im-communication'
import type {
  GitCheckpointV1,
  GitRollbackPreviewV1,
  LspRequestV1,
  LspResponseV1,
  McpServerConfigV2,
  McpServerStatusV1,
  RepoMapResultV1,
  ShellSessionV1,
  RuntimeSpanV1,
  TaskRunListQuery,
  TaskRunV1,
  TaskOperationReceiptV1,
  TaskInputV1,
  TaskEventV1,
  TaskAttentionV1,
  TaskTemplateV1,
  TaskTemplateId,
  TaskTemplateStartV1,
  WorkspacePreviewResultV1
} from './agent-workbench'

export type RuntimeRequestResult = { ok: boolean; status: number; body: string }
export type WorkspacePickResult = { canceled: boolean; path: string | null }
export type PathOpenResult = { ok: boolean; message?: string }
export type DingTalkDesktopResult =
  | { ok: true }
  | { ok: false; code: 'not_installed' | 'unsupported' | 'invalid_app' | 'open_failed'; message: string }
export const DESKTOP_COMMANDS = [
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'selectAll',
  'reload',
  'zoomIn',
  'zoomOut',
  'resetZoom',
  'toggleDevTools',
  'minimize',
  'toggleMaximize',
  'close',
  'quit'
] as const
export type DesktopCommand = typeof DESKTOP_COMMANDS[number]
export type SkillSaveResult = { ok: true; path: string } | { ok: false; message: string }
export type GithubSkillSource = {
  owner: string
  repo: string
  path: string
  ref?: string
  skillName?: string
  autoUpdate?: boolean
  includePaths?: string[]
  overlaySkillId?: string
}
export type BundledSkillSource = {
  id: string
  skillName?: string
}
export type BundledAgentPackSource = {
  id: string
  rootPath?: string
}
export type GithubSkillInstallResult =
  | { ok: true; path: string; sha: string; updated: boolean }
  | { ok: false; message: string }
export type GithubSkillSyncResult =
  | { ok: true; checked: number; updated: number; errors: Array<{ path: string; message: string }> }
  | { ok: false; message: string }
export type BundledSkillInstallResult =
  | { ok: true; path: string; updated: boolean }
  | { ok: false; message: string }
export type BundledAgentPackInstallResult =
  | {
      ok: true
      rootPath: string
      manifestPath: string
      installedAssets: number
      counts: Record<string, number>
    }
  | { ok: false; message: string }

export type ManagedToolId = 'lark-cli' | 'officecli' | 'ego-browser'
export type ManagedToolState =
  | 'not_installed'
  | 'downloading'
  | 'installed'
  | 'needs_login'
  | 'needs_external_app'
  | 'update_available'
  | 'error'
export type ManagedToolStatus = {
  id: ManagedToolId
  state: ManagedToolState
  installedVersion?: string
  latestVersion?: string
  executablePath?: string
  message?: string
  externalUrl?: string
  scopes?: string[]
  brand?: 'feishu' | 'lark'
  appId?: string
  profile?: string
  userOpenId?: string
  identityFingerprint?: string
  executableHash?: string
}
export type ManagedToolResult =
  | { ok: true; status: ManagedToolStatus }
  | { ok: false; message: string }
export type ManagedLarkLoginResult =
  | { ok: true; verificationUrl: string; userCode?: string; expiresAt: string }
  | { ok: false; message: string; reason?: 'app_configuration_required' | 'candidate_credentials_disabled' }
export type ManagedLarkAppSetupResult =
  | { ok: true; state: 'configured' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'expired'; verificationUrl?: string; expiresAt?: string }
  | { ok: false; message: string }
export type ManagedToolListResult =
  | { ok: true; tools: ManagedToolStatus[] }
  | { ok: false; message: string }
export type WriteKnowledgeBaseStatus = {
  state: 'api' | 'static' | 'stale_cache' | 'offline' | 'disabled'
  lastUpdated?: string
  referenceCount: number
  message?: string
}
export type WriteKnowledgeSnippet = {
  title: string
  url: string
  text: string
  score: number
  source: 'railwise-api' | 'railwise-static'
}
export type WriteKnowledgeSearchResult = {
  source: 'api' | 'static' | 'stale-cache' | 'unavailable'
  keywords: string[]
  snippets: WriteKnowledgeSnippet[]
  totalEntries?: number
  categories?: Array<{ name: string; count: number }>
  refreshedAt?: string
}
export type SkillListItem = {
  id: string
  name: string
  description?: string
  version?: string
  updateSource?: string
  root: string
  entryPath: string
  scope: 'project' | 'global'
  legacy: boolean
  source?: {
    type: 'github'
    owner: string
    repo: string
    path: string
    ref: string
    installedSha?: string
    autoUpdate: boolean
    includePaths?: string[]
    overlaySkillId?: string
  } | {
    type: 'bundled'
    id: string
    autoUpdate: false
  }
}
export type SkillCatalogSnapshot = {
  generation: number
  skills: SkillListItem[]
  validationErrors: Array<{ root: string; message: string }>
}
export type SkillListResult =
  | ({ ok: true } & SkillCatalogSnapshot)
  | { ok: false; message: string }
export type RuntimeConfigFileResult = { path: string; content: string; exists: boolean }
export type RuntimeConfigSaveResult = { ok: true; path: string }
export type TurnCompleteNotificationPayload = {
  threadId?: string
  turnId?: string
  approvalId?: string
  reason?: 'completed' | 'error' | 'aborted' | 'blocked' | 'max_tokens' | 'waiting_approval'
  activeThread?: boolean
  title: string
  body: string
}
export type SystemNotificationResult =
  | { ok: true; shown: boolean; reason?: string }
  | { ok: false; message: string }
export type ClawChannelActivityPayload = {
  channelId: string
  threadId: string
}
export type ClawChannelMirrorResult =
  | { ok: true }
  | { ok: false; message: string }
export type UpstreamModelsResult =
  | { ok: true; modelIds: string[]; modelGroups?: ModelProviderModelGroup[] }
  | { ok: false; message: string }
export type ModelProviderModelGroup = {
  providerId: string
  label: string
  modelIds: string[]
  /** Models confirmed by the active provider's latest successful /v1/models response. */
  discoveredModelIds?: string[]
}
export type ClawImInstallQrResult =
  | { ok: true; url: string; deviceCode: string; userCode: string; interval: number; expireIn: number }
  | { ok: false; message: string }
export type ClawImInstallPollResult =
  | { done: true; kind: 'feishu'; appId: string; appSecret: string; domain: string }
  | { done: true; kind: 'weixin'; accountId: string; sessionKey: string }
  | { done: false; error?: string; retryable?: boolean }
export type WeixinBridgeAccountStatusV1 = {
  accountId: string
  status: 'unknown' | 'starting' | 'connected' | 'retrying' | 'stale' | 'expired' | 'error' | 'stopped'
  message: string
  errorCode?: number
  updatedAt?: string
  lastSuccessfulPollAt?: string
  runId?: string
  startedAt?: string
  lastInboundAt?: string
  lastOutboundAt?: string
  lastErrorAt?: string
  failureCount?: number
  nextRetryAt?: string
  reasonCode?: string
}
export type ConfirmDialogOptions = {
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
}
/** One IPC message carries every SSE event parsed from a network chunk. */
export type SseEventPayload = { streamId: string; events: unknown[] }
export type SseEndPayload = { streamId: string }
export type SseErrorPayload = { streamId: string; status?: number; message?: string }
export type ApplicationMenuAction =
  | 'new-chat'
  | 'choose-workspace'
  | 'settings'
  | 'help-center'
  | 'check-updates'

export type WorkWiseApi = {
  platform: string
  initialLocale: 'en' | 'zh'
  windowAppearance: WindowAppearanceV1
  onWindowAppearanceChanged: (handler: (appearance: WindowAppearanceV1) => void) => () => void
  onApplicationMenuAction: (handler: (action: ApplicationMenuAction) => void) => () => void
  onNotificationOpenTask: (handler:(taskId:string)=>void) => ()=>void
  onNotificationOpenFlow: (handler:(reference:{flowId?:string;flowRunId:string})=>void) => ()=>void
  notifyTask: (payload: {key:string;taskId?:string;flowId?:string;flowRunId?:string;kind:'attention'|'artifact';title:string;body:string}) => Promise<{shown:boolean}>
  onNotificationOpenThread: (handler: (threadId: string) => void) => () => void
  getSettings: () => Promise<WorkWiseSettingsV2>
  setSettings: (partial: AppSettingsPatch, expectedRevision?: number) => Promise<WorkWiseSettingsV2>
  runtimeRequest: (path: string, method?: string, body?: string) => Promise<RuntimeRequestResult>
  cancelOperation: (request: CancelOperationRequest) => Promise<CancelOperationResult>
  coordinateTaskCommand: (request: import('./task-command').TaskCommandRequest) => Promise<import('./task-command').TaskCommandResult>
  getTaskRun: (taskId: string) => Promise<TaskRunV1 | null>
  listTaskOperationReceipts: (taskId: string) => Promise<TaskOperationReceiptV1[]>
  getTaskPermissions: (taskId: string) => Promise<import('./agent-workbench').TaskPermissionSnapshotV1>
  confirmTaskPermissions: (taskId: string, request: import('./agent-workbench').TaskPermissionConfirmationV1) => Promise<{ task: TaskRunV1; permission: import('./agent-workbench').TaskPermissionSnapshotV1; resumed: false }>
  verifyTaskOperationReceipt: (taskId: string, receiptId: string, request: Pick<RevisionTaskAction, 'expectedRevision' | 'idempotencyKey'>) => Promise<import('./agent-workbench').TaskOperationVerificationV1>
  readDocumentCandidate: (payload: import('./document-delivery').CandidateReviewRequest) => Promise<import('./document-delivery').DocumentCandidateReview>
  decideDocumentCandidate: (payload: import('./document-delivery').CandidateDecisionRequest) => Promise<import('./document-delivery').CandidateDecisionResult>
  listTaskPage: (query?: import('./agent-workbench').TaskPageQuery) => Promise<import('./agent-workbench').TaskRunPage>
  startTaskSse: (sinceSeq: number, streamId?: string) => Promise<{streamId:string}>
  listTaskRuns: (query?: TaskRunListQuery) => Promise<TaskRunV1[]>
  resumeTask: (taskId: string, request: RevisionTaskAction) => Promise<{ task: TaskRunV1; turn: unknown }>
  retryTask: (taskId: string, request: RevisionTaskAction) => Promise<{ task: TaskRunV1; turn: unknown }>
  cancelTask: (taskId: string, request: RevisionTaskAction) => Promise<TaskRunV1>
  pauseTask: (taskId: string, request: RevisionTaskAction) => Promise<TaskRunV1>
  listTaskInputs: (taskId: string) => Promise<TaskInputV1[]>
  appendTaskInput: (taskId: string, request: RevisionTaskAction & { text: string; kind?: TaskInputV1['kind'] }) => Promise<{ input: TaskInputV1; task: TaskRunV1 }>
  listTaskEvents: (taskId: string, afterSequence?: number) => Promise<TaskEventV1[]>
  listTaskInbox: (workspaceRoot?: string) => Promise<TaskAttentionV1[]>
  listTaskTemplates: () => Promise<{ templates: TaskTemplateV1[] }>
  startTaskTemplate: (templateId: TaskTemplateId, request: TaskTemplateStartV1) => Promise<{ threadId: string; taskId?: string; flowId?: string; flowRunId?: string }>
  saveTaskTemplate: (templateId: TaskTemplateId, request: Omit<TaskTemplateStartV1, 'idempotencyKey'> & { name?: string }) => Promise<{ flow: unknown }>
  getTaskDiagnostics: (taskId: string) => Promise<{
    schema: 'workwise.task-diagnostics'
    version: 1
    generatedAt: string
    taskId: string
    summary: { total: number; running: number; errors: number; retries: number; durationMs: number }
    spans: RuntimeSpanV1[]
  }>
  exportTaskDiagnostics: (taskId: string) => Promise<{
    ok: boolean
    canceled?: boolean
    path?: string
    message?: string
  }>
  listShellSessions: (taskId?: string) => Promise<ShellSessionV1[]>
  terminateShellSession: (sessionId: string, request: RevisionTaskAction) => Promise<ShellSessionV1>
  fetchUpstreamModels: () => Promise<UpstreamModelsResult>
  getClawStatus: () => Promise<ClawRuntimeStatus>
  runClawTask: (taskId: string) => Promise<ClawRunResult>
  getScheduleStatus: () => Promise<ScheduleRuntimeStatus>
  runScheduleTask: (taskId: string) => Promise<ScheduleRunResult>
  startClawImInstallQr: (
    provider: 'feishu' | 'weixin',
    options?: { isLark?: boolean }
  ) => Promise<ClawImInstallQrResult>
  pollClawImInstall: (
    provider: 'feishu' | 'weixin',
    deviceCode: string
  ) => Promise<ClawImInstallPollResult>
  getWeixinBridgeStatus: (accountId?: string) => Promise<WeixinBridgeAccountStatusV1[]>
  getImHealth: (channelId?: string) => Promise<ImChannelHealthV1[]>
  startIm: (channelId?: string) => Promise<ImLifecycleResultV1>
  reconnectIm: (channelId?: string) => Promise<ImLifecycleResultV1>
  stopIm: (channelId?: string) => Promise<ImLifecycleResultV1>
  disconnectIm: (channelId?: string) => Promise<ImLifecycleResultV1>
  selfCheckIm: (channelId: string) => Promise<ImSelfCheckResultV1>
  getImDiagnostics: () => Promise<ImDiagnosticsV1>
  pickWorkspaceDirectory: (defaultPath?: string) => Promise<WorkspacePickResult>
  pickPluginPackage: (mode: 'file' | 'directory') => Promise<WorkspacePickResult>
  confirmDialog: (options: ConfirmDialogOptions) => Promise<boolean>
  listCatalogSources: () => Promise<CatalogSourceV1[]>
  listCatalogPackages: () => Promise<MarketplaceCatalogPackagesResultV1>
  getCatalogSnapshot: (sourceId: string) => Promise<CatalogSnapshotV1 | null>
  upsertCatalogSource: (source: CatalogSourceV1) => Promise<CatalogSourceV1>
  listCatalogCredentialStatuses: () => Promise<CatalogCredentialStatusV1[]>
  setCatalogSourceCredential: (sourceId: string, accessToken: string) => Promise<CatalogCredentialStatusV1>
  clearCatalogSourceCredential: (sourceId: string) => Promise<CatalogCredentialStatusV1>
  removeCatalogSource: (sourceId: string) => Promise<void>
  syncCatalogSource: (sourceId: string) => Promise<MarketplaceCatalogSyncResultV1>
  listInstalledPlugins: () => Promise<InstalledPackageV1[]>
  listPluginUpdateDiagnostics: () => Promise<PluginUpdateDiagnosticV1[]>
  preparePluginImport: (request: {
    sourcePath: string
    format?: 'wwx' | 'codex' | 'mcpb'
    catalogSourceId?: string
  }) => Promise<PreparedPluginImportV1>
  prepareCatalogPlugin: (request: {
    sourceId: string
    packageId: string
  }) => Promise<PreparedPluginImportV1>
  cancelPluginImport: (preparedId: string) => Promise<boolean>
  installPreparedPlugin: (request: {
    preparedId: string
    reviewSha256: string
    expectedCurrentVersion: string | null
    scope: 'user' | 'workspace' | 'team'
    workspaceRoot?: string
    permissions: InstalledPackagePermissionV1[]
    idempotencyKey: string
  }) => Promise<InstalledPackageV1>
  rollbackPlugin: (request: {
    packageId: string
    expectedCurrentVersion: string
    idempotencyKey: string
  }) => Promise<InstalledPackageV1>
  updatePluginPermissions: (request: {
    packageId: string
    expectedCurrentVersion: string
    reviewSha256: string
    permissions: InstalledPackagePermissionV1[]
    workspaceRoot?: string
    idempotencyKey: string
  }) => Promise<InstalledPackageV1>
  listSkills: (workspaceRoot?: string) => Promise<SkillListResult>
  refreshSkills: (workspaceRoot?: string) => Promise<SkillListResult>
  onSkillsChanged: (listener: (generation: number) => void) => () => void
  saveSkillFile: (rootPath: string, skillName: string, content: string) => Promise<SkillSaveResult>
  installGithubSkill: (rootPath: string, source: GithubSkillSource) => Promise<GithubSkillInstallResult>
  installBundledSkill: (rootPath: string, source: BundledSkillSource) => Promise<BundledSkillInstallResult>
  installBundledAgentPack: (source: BundledAgentPackSource) => Promise<BundledAgentPackInstallResult>
  syncGithubSkills: (workspaceRoot?: string) => Promise<GithubSkillSyncResult>
  listManagedTools: () => Promise<ManagedToolListResult>
  installManagedTool: (id: ManagedToolId) => Promise<ManagedToolResult>
  updateManagedTool: (id: ManagedToolId) => Promise<ManagedToolResult>
  diagnoseManagedTool: (id: ManagedToolId) => Promise<ManagedToolResult>
  beginManagedLarkLogin: (input?: { capability?: 'tasks' | 'mail' | 'im' | 'drive' }) => Promise<ManagedLarkLoginResult>
  completeManagedLarkLogin: () => Promise<ManagedToolResult>
  beginManagedLarkAppSetup: () => Promise<ManagedLarkAppSetupResult>
  checkManagedLarkAppSetup: () => Promise<ManagedLarkAppSetupResult>
  cancelManagedLarkAppSetup: () => Promise<ManagedLarkAppSetupResult>
  diagnoseManagedDingTalk: () => Promise<ManagedDwsResult>
  checkManagedDingTalkTaskAccess: () => Promise<ManagedDwsTaskAccessResult>
  installManagedDingTalk: () => Promise<ManagedDwsResult>
  beginManagedDingTalkLogin: () => Promise<ManagedDwsResult>
  checkManagedDingTalkLogin: () => Promise<ManagedDwsResult>
  cancelManagedDingTalkLogin: () => Promise<ManagedDwsResult>
  setManagedDingTalkEnabled: (enabled: boolean) => Promise<ManagedDwsResult>
  removeManagedTool: (id: ManagedToolId) => Promise<ManagedToolResult>
  listAgentProfiles: (workspaceRoot?: string) => Promise<AgentProfileSnapshotV1>
  saveAgentProfile: (request: {
    scope: 'global' | 'workspace'
    workspaceRoot?: string
    profile: Omit<AgentProfileV1, 'builtIn' | 'source' | 'path' | 'revision'> & { revision?: number }
    expectedRevision: number
    idempotencyKey: string
  }) => Promise<AgentProfileV1>
  setThreadAgent: (threadId: string, request: {
    agentId: string
    expectedRevision: number
    idempotencyKey: string
  }) => Promise<ThreadAgentSelectionV1>
  getWorkspaceTrust: (workspaceRoot: string) => Promise<WorkspaceTrustV1>
  scanLegacyWorkspaces: () => Promise<WorkspaceMigrationReport>
  getLegacyWorkspaceAliases: () => Promise<WorkspaceMigrationReport['aliases']>
  importLegacyWorkspaceSnapshot: (request: WorkspaceImportRequest) => Promise<WorkspaceImportResult>
  setWorkspaceTrust: (request: {
    workspaceRoot: string
    level: WorkspaceTrustLevel
    expectedRevision: number
    confirmed: boolean
    idempotencyKey: string
  }) => Promise<WorkspaceTrustV1>
  listMcpServers: (workspaceRoot?: string) => Promise<McpServerConfigV2[]>
  saveMcpServer: (request: {
    config: Omit<McpServerConfigV2, 'revision'> & { revision?: number }
    expectedRevision: number
    idempotencyKey: string
  }) => Promise<McpServerConfigV2>
  testMcpServer: (serverId: string, workspaceRoot?: string) => Promise<McpServerStatusV1>
  openTaskArtifact: (request: { taskId: string; artifactId: string }) => Promise<{ ok: true } | { ok: false; message: string }>
  authorizeMcpServer: (request: {
    serverId: string
    workspaceRoot?: string
    state?: string
    authorizationCode?: string
    useLocalCallback?: boolean
  }) => Promise<McpServerStatusV1>
  waitForMcpAuthorization: (serverId: string, state: string) => Promise<McpServerStatusV1>
  cancelMcpAuthorization: (serverId: string, state: string) => Promise<boolean>
  setMcpServerCredential: (request: {
    serverId: string
    workspaceRoot?: string
    accessToken: string
    tokenType?: string
    expectedRevision: number
    idempotencyKey: string
  }) => Promise<McpServerConfigV2>
  listDocumentEngines: () => Promise<DocumentEngineStatusV1[]>
  installDocumentEngine: (id: DocumentEngineId) => Promise<DocumentEngineStatusV1>
  diagnoseDocumentEngine: (id: DocumentEngineId) => Promise<DocumentEngineStatusV1>
  parseDocument: (request: DocumentParseRequestV1) => Promise<DocumentParseResultV1>
  cancelDocumentParse: (parseId: string) => Promise<boolean>
  importChatAttachment: (request: {
    importId?: string
    sourcePath: string
    declaredMimeType?: string
    threadId?: string
    workspace?: string
  }) => Promise<{ attachment: {
    id: string; name: string; mimeType: string; byteSize: number; kind: string;
    state: 'uploading' | 'parsing' | 'ready' | 'degraded' | 'failed' | 'cancelled';
    degradationReasons?: string[]; progress?: number
  }; managedPath: string }>
  cancelChatAttachmentImport: (importId: string) => Promise<boolean>
  openChatAttachmentOriginal: (managedPath: string) => Promise<void>
  previewWorkspaceFile: (request: {
    workspaceRoot: string
    relativePath: string
    parsingMode?: DocumentParsingMode
    retryReasons?: DocumentQualityReasonV1[]
    idempotencyKey: string
  }) => Promise<WorkspacePreviewResultV1>
  openSkillRoot: (rootPath: string) => Promise<PathOpenResult>
  getRuntimeConfigFile: () => Promise<RuntimeConfigFileResult>
  setRuntimeConfigFile: (content: string) => Promise<RuntimeConfigSaveResult>
  openRuntimeConfigDir: () => Promise<PathOpenResult>
  getGitBranches: (workspaceRoot: string) => Promise<GitBranchesResult>
  switchGitBranch: (workspaceRoot: string, branch: string) => Promise<GitBranchesResult>
  createAndSwitchGitBranch: (workspaceRoot: string, branch: string) => Promise<GitBranchesResult>
  createGitCheckpoint: (request: {
    taskId: string
    workspaceRoot: string
    repositoryRoot?: string
    relatedPaths?: string[]
    idempotencyKey: string
  }) => Promise<GitCheckpointV1>
  previewGitRollback: (request: {
    checkpointId: string
    relatedPaths?: string[]
  }) => Promise<GitRollbackPreviewV1>
  applyGitRollback: (request: {
    checkpointId: string
    relatedPaths?: string[]
    expectedRevision: number
    idempotencyKey: string
  }) => Promise<GitRollbackPreviewV1>
  buildRepoMap: (request: {
    workspaceRoot: string
    repositoryRoot: string
    maxFiles?: number
    maxBytes?: number
    maxDurationMs?: number
    idempotencyKey: string
  }) => Promise<RepoMapResultV1>
  queryRepoMap: (request: {
    repositoryRoot: string
    query: string
    limit?: number
  }) => Promise<RepoMapResultV1>
  lspRequest: (request: LspRequestV1) => Promise<LspResponseV1>
  listEditors: () => Promise<EditorListResult>
  openEditorPath: (options: OpenEditorPathOptions) => Promise<EditorOpenResult>
  listWorkspaceDirectory: (options: WorkspaceDirectoryTarget) => Promise<WorkspaceDirectoryListResult>
  resolveWorkspaceFile: (options: WorkspaceFileTarget) => Promise<WorkspaceFileResolveResult>
  readWorkspaceFile: (options: WorkspaceFileTarget) => Promise<WorkspaceFileReadResult>
  readWorkspaceImage: (options: WorkspaceFileTarget) => Promise<WorkspaceImageReadResult>
  openWorkspaceFile: (options: WorkspaceFileTarget) => Promise<PathOpenResult>
  revealWorkspaceFile: (options: WorkspaceFileTarget) => Promise<PathOpenResult>
  saveWorkspaceFileAs: (payload: WorkspaceFileSaveAsPayload) => Promise<WorkspaceFileSaveAsResult>
  writeWorkspaceFile: (payload: WorkspaceFileWritePayload) => Promise<WorkspaceFileWriteResult>
  readDocumentSnapshot: (payload: DocumentReadPayload) => Promise<DocumentSnapshot>
  searchWorkspaceDocuments: (payload: DocumentSearchPayload) => Promise<WorkspaceSearchResponse>
  writeDocumentChecked: (payload: CheckedDocumentWritePayload) => Promise<CheckedDocumentWriteResult>
  listDocumentHistory: (payload: DocumentReadPayload) => Promise<DocumentHistoryListResult>
  getDocumentHistoryEntry: (payload: DocumentHistoryPayload) => Promise<DocumentHistoryEntry>
  restoreDocumentHistory: (payload: DocumentRestorePayload) => Promise<CheckedDocumentWriteResult>
  listDocumentComments: (payload: DocumentReadPayload) => Promise<DocumentComment[]>
  createDocumentComment: (payload: DocumentCommentCreatePayload) => Promise<DocumentComment>
  updateDocumentComment: (payload: DocumentCommentUpdatePayload) => Promise<DocumentComment>
  getDocumentSemantics: (payload: DocumentSemanticsPayload) => Promise<DocumentSemantics>
  createWorkspaceFile: (payload: WorkspaceFileCreatePayload) => Promise<WorkspaceFileCreateResult>
  createWorkspaceDirectory: (
    payload: WorkspaceDirectoryCreatePayload
  ) => Promise<WorkspaceDirectoryCreateResult>
  saveWorkspaceClipboardImage: (
    payload: WorkspaceClipboardImageSavePayload
  ) => Promise<WorkspaceClipboardImageSaveResult>
  readClipboardImage: () => Promise<ClipboardImageReadResult>
  verifyPptMasterDeliverable: (
    payload: PptMasterDeliverableVerifyRequest
  ) => Promise<PptMasterDeliverableVerifyResult>
  pptMasterPythonEnvStatus: () => Promise<PptMasterPythonEnvStatus>
  pptMasterPythonEnsure: () => Promise<PptMasterPythonEnvEnsureResult>
  onPptMasterPythonEnvProgress: (
    callback: (progress: PptMasterPythonEnvProgress) => void
  ) => () => void
  renameWorkspaceEntry: (
    payload: WorkspaceEntryRenamePayload
  ) => Promise<WorkspaceEntryRenameResult>
  deleteWorkspaceEntry: (
    payload: WorkspaceEntryDeletePayload
  ) => Promise<WorkspaceEntryDeleteResult>
  watchWorkspaceFile: (payload: WorkspaceFileWatchPayload) => Promise<WorkspaceFileWatchResult>
  unwatchWorkspaceFile: (watchId: string) => Promise<boolean>
  onWorkspaceFileChanged: (handler: (payload: WorkspaceFileChangePayload) => void) => () => void
  requestWriteInlineCompletion: (
    payload: WriteInlineCompletionRequest
  ) => Promise<WriteInlineCompletionResult>
  generateWriteInfographic: (
    payload: WriteInfographicRequest
  ) => Promise<WriteInfographicResult>
  listWriteInlineCompletionDebugEntries: () => Promise<WriteInlineCompletionDebugEntry[]>
  clearWriteInlineCompletionDebugEntries: () => Promise<boolean>
  getWriteKnowledgeBaseStatus: () => Promise<WriteKnowledgeBaseStatus>
  refreshWriteKnowledgeBase: () => Promise<WriteKnowledgeBaseStatus>
  searchWriteKnowledge: (query: string) => Promise<WriteKnowledgeSearchResult>
  exportWriteDocument: (payload: WriteExportPayload) => Promise<WriteExportResult>
  renderWriteMermaidPreview: (payload: WriteMermaidPreviewRequest) => Promise<WriteMermaidPreviewResult>
  copyWriteDocumentAsRichText: (
    payload: WriteRichClipboardPayload
  ) => Promise<WriteRichClipboardResult>
  exportDesignToPptx: (
    payload: { name?: string; workspaceRoot?: string; document: Record<string, unknown> }
  ) => Promise<{ ok: boolean; path?: string; message?: string }>
  listDesignDocuments: (payload: DesignDocumentListPayload) => Promise<DesignDocumentListResult>
  loadDesignDocument: (payload: DesignDocumentLoadPayload) => Promise<DesignDocumentLoadResult>
  saveDesignDocument: (payload: DesignDocumentSavePayload) => Promise<DesignDocumentSaveResult>
  importDesignImageAsset: (payload: DesignImageImportPayload) => Promise<DesignImageImportResult>
  readDesignAsset: (payload: DesignAssetReadPayload) => Promise<DesignAssetReadResult>
  importPptxToDesign: (payload: DesignPptxImportPayload) => Promise<DesignPptxImportResult>
  readDesignPptxRevision: (payload: DesignPptxRevisionReadPayload) => Promise<DesignPptxRevisionReadResult>
  saveDesignPptxRevision: (payload: DesignPptxRevisionSavePayload) => Promise<DesignPptxRevisionSaveResult>
  exportDesignPptxBytes: (payload: DesignPptxBytesExportPayload) => Promise<DesignPptxBytesExportResult>
  saveDesignAssetToWrite: (
    payload: DesignWriteAssetPayload
  ) => Promise<DesignWriteAssetResult>
  renderPresetShape: (
    payload: { presetName: string; x: number; y: number; w: number; h: number; fill?: string }
  ) => Promise<{ ok: boolean; svg?: string; message?: string }>
  listPresetShapes: () => Promise<string[]>
  generateAgnesImage: (
    payload: AgnesImageGenerationPayload
  ) => Promise<AgnesImageGenerationResult>
  startSse: (threadId: string, sinceSeq: number, streamId?: string) => Promise<{ streamId: string }>
  stopSse: (streamId: string) => Promise<boolean>
  onSseEvent: (handler: (payload: SseEventPayload) => void) => () => void
  onSseEnd: (handler: (payload: SseEndPayload) => void) => () => void
  onSseError: (handler: (payload: SseErrorPayload) => void) => () => void
  onClawChannelActivity: (handler: (payload: ClawChannelActivityPayload) => void) => () => void
  onImHealthChanged: (handler: (payload: ImChannelHealthV1) => void) => () => void
  mirrorClawChannelMessage: (
    threadId: string,
    text: string,
    direction: 'user' | 'assistant',
    options?: { turnId?: string; requestText?: string }
  ) => Promise<ClawChannelMirrorResult>
  mirrorClawChannelMessageToFeishu: (
    threadId: string,
    text: string,
    direction: 'user' | 'assistant',
    options?: { turnId?: string; requestText?: string }
  ) => Promise<ClawChannelMirrorResult>
  createClawTaskFromText: (
    text: string,
    options?: { channelId?: string; modelHint?: string; mode?: 'agent' | 'plan' }
  ) => Promise<ClawTaskFromTextResult>
  createScheduleTaskFromText: (
    text: string,
    options?: { workspaceRoot?: string; modelHint?: string; mode?: 'agent' | 'plan' }
  ) => Promise<ScheduleTaskFromTextResult>
  runDesktopCommand: (command: DesktopCommand) => Promise<void>
  openExternal: (url: string) => Promise<void>
  openDingTalkDesktop: () => Promise<DingTalkDesktopResult>
  showTurnCompleteNotification: (
    payload: TurnCompleteNotificationPayload
  ) => Promise<SystemNotificationResult>
  getAppVersion: () => Promise<string>
  getGuiUpdateState: () => Promise<GuiUpdateState>
  checkGuiUpdate: (channel?: GuiUpdateChannel) => Promise<GuiUpdateInfo>
  downloadGuiUpdate: (channel?: GuiUpdateChannel) => Promise<GuiUpdateDownloadResult>
  preflightGuiUpdateInstall: () => Promise<GuiUpdateInstallPreflight>
  installGuiUpdate: (request?: GuiUpdateInstallRequest) => Promise<GuiUpdateInstallResult>
  onGuiUpdateState: (handler: (payload: GuiUpdateState) => void) => () => void
  logError: (category: string, message: string, detail?: unknown) => Promise<void>
  getLogPath: () => Promise<string>
  openLogDir: () => Promise<{ ok: boolean; message?: string }>
  getPathForFile: (file: File) => string
}

export type RevisionTaskAction = {
  expectedRevision: number
  idempotencyKey: string
  model?: string
  reason?: string
}
