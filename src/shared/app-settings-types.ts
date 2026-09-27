import type { GuiUpdateChannel } from './gui-update'
import type { KeyboardShortcutsConfigV1 } from './keyboard-shortcuts'
import type { ApprovalPolicy, SandboxMode } from '../../kun/src/contracts/policy.js'
import type { ModelEndpointFormat } from '../../kun/src/contracts/model-endpoint-format.js'
import type { ImCredentialRefV1 } from './im-communication'
export {
  DEFAULT_MODEL_ENDPOINT_FORMAT,
  MODEL_ENDPOINT_FORMATS,
  modelEndpointPath,
  normalizeModelEndpointFormat
} from '../../kun/src/contracts/model-endpoint-format.js'
export { DEFAULT_GUI_UPDATE_CHANNEL, normalizeGuiUpdateChannel, type GuiUpdateChannel } from './gui-update'
export {
  DEFAULT_APPROVAL_POLICY,
  DEFAULT_SANDBOX_MODE,
  type ApprovalPolicy,
  type SandboxMode
} from '../../kun/src/contracts/policy.js'
export type UiFontScale = 'small' | 'medium' | 'large'
export type ScheduleRunMode = 'agent' | 'plan'
export type ScheduleKind = 'manual' | 'interval' | 'daily' | 'at'
export type ScheduleTaskStatus = 'idle' | 'running' | 'success' | 'error'
export type ScheduleModel = 'auto' | 'deepseek-flash' | 'deepseek-v4-pro' | 'deepseek-v4-flash'
export type ScheduleReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max'
export type ClawRunMode = ScheduleRunMode
export type ClawImProvider = 'feishu' | 'weixin'
export type ClawScheduleKind = ScheduleKind
export type ClawTaskStatus = ScheduleTaskStatus
export type ClawModel = ScheduleModel

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const CUSTOM_IMAGE_GENERATION_PROVIDER_ID = 'custom'
export const IMAGE_GENERATION_PROTOCOLS = ['openai-images', 'minimax-image'] as const
export type ImageGenerationProtocol = (typeof IMAGE_GENERATION_PROTOCOLS)[number]
export const DEFAULT_IMAGE_GENERATION_PROTOCOL: ImageGenerationProtocol = 'openai-images'
export const DEFAULT_CLAW_MODEL = 'auto'
export const DEFAULT_PHONE_AGENT_NAME = 'RailWise AI'
export const CLAW_MODEL_IDS = ['auto', 'deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'] as const
export const DEFAULT_SCHEDULE_MODEL = DEFAULT_CLAW_MODEL
export const SCHEDULE_MODEL_IDS = CLAW_MODEL_IDS
export const DEFAULT_SCHEDULE_REASONING_EFFORT = 'medium'
export const SCHEDULE_REASONING_EFFORT_IDS = ['off', 'low', 'medium', 'high', 'max'] as const
export const DEFAULT_SCHEDULE_INTERNAL_PORT = 8788
// New installations only write WorkWise-owned paths. The dedicated legacy
// import module may copy older data here without mutating its source.
export const DEFAULT_WORKSPACE_ROOT = '~/.workwise/default_workspace'
export const DEFAULT_WRITE_WORKSPACE_ROOT = '~/.workwise/write_workspace'
export const DEFAULT_MANAGED_RUNTIME_DATA_DIR = '~/.workwise/runtime'
export const DEFAULT_MANAGED_RUNTIME_MODEL = 'deepseek-flash'
export const DEFAULT_WRITE_INLINE_COMPLETION_BASE_URL = 'https://api.deepseek.com/beta'
export const DEFAULT_WRITE_INLINE_COMPLETION_MODEL = 'deepseek-flash'
export const WRITE_INLINE_COMPLETION_MODEL_IDS = ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash'] as const
export const DEFAULT_WRITE_INLINE_COMPLETION_DEBOUNCE_MS = 650
export const DEFAULT_WRITE_INLINE_COMPLETION_MIN_ACCEPT_SCORE = 0.52
export const DEFAULT_WRITE_INLINE_COMPLETION_MAX_TOKENS = 96
export const DEFAULT_WRITE_INLINE_LONG_COMPLETION_DEBOUNCE_MS = 2_800
export const DEFAULT_WRITE_INLINE_LONG_COMPLETION_MIN_ACCEPT_SCORE = 0.36
export const DEFAULT_WRITE_INLINE_LONG_COMPLETION_MAX_TOKENS = 256
export const DEFAULT_WRITE_KNOWLEDGE_API_BASE_URL = 'https://api.railwise.cn'
export const DEFAULT_WRITE_KNOWLEDGE_PUBLIC_BASE_URL = 'https://kb.railwise.cn'
export const DEFAULT_MANAGED_RUNTIME_PORT = 8899
/** @deprecated Internal compatibility alias. */
export const DEFAULT_KUN_DATA_DIR = DEFAULT_MANAGED_RUNTIME_DATA_DIR
/** @deprecated Internal compatibility alias. */
export const DEFAULT_KUN_MODEL = DEFAULT_MANAGED_RUNTIME_MODEL
/** @deprecated Internal compatibility alias. */
export const DEFAULT_KUN_PORT = DEFAULT_MANAGED_RUNTIME_PORT
export const DEFAULT_WEIXIN_BRIDGE_RPC_URL = 'http://127.0.0.1:18790/api/v1/admin/rpc'
export const DEFAULT_MODEL_PROVIDER_ID = 'deepseek'
export const DEFAULT_AGNES_PROVIDER_ID = 'agnes-ai'
export const DEFAULT_AGNES_BASE_URL = 'https://apihub.agnes-ai.com/v1'
export const DEFAULT_AGNES_TEXT_MODEL = 'agnes-2.0-flash'
export const DEFAULT_AGNES_IMAGE_MODEL = 'agnes-image-2.1-flash'
export const FALLBACK_AGNES_IMAGE_MODEL = 'agnes-image-2.0-flash'
export type { ModelEndpointFormat }
export type ModelProviderImageCapabilityV1 = {
  protocol: ImageGenerationProtocol
  baseUrl: string
  models: string[]
}
export type ModelProviderProfileV1 = {
  id: string
  name: string
  apiKey: string
  baseUrl: string
  endpointFormat: ModelEndpointFormat
  models: string[]
  image?: ModelProviderImageCapabilityV1
}
export type ModelProviderSettingsV1 = {
  apiKey: string
  baseUrl: string
  providers: ModelProviderProfileV1[]
}

export type ModelProviderImageCapabilityPatchV1 = Partial<ModelProviderImageCapabilityV1>
export type ModelProviderProfilePatchV1 = Partial<Omit<ModelProviderProfileV1, 'image'>> & {
  image?: ModelProviderImageCapabilityPatchV1 | null
}
export type ModelProviderSettingsPatchV1 = Partial<
  Omit<ModelProviderSettingsV1, 'providers'>
> & {
  providers?: ModelProviderProfilePatchV1[]
}

export type KunRuntimeSettingsV1 = {
  binaryPath: string
  port: number
  autoStart: boolean
  /** Optional override. Leave empty to inherit the General model provider API key. */
  apiKey: string
  /** Optional override. Leave empty to inherit the General model provider Base URL. */
  baseUrl: string
  /** Selected General model provider profile. Empty or missing means the default provider. */
  providerId: string
  /** Effective model request format. Resolved from the selected model provider. */
  endpointFormat: ModelEndpointFormat
  runtimeToken: string
  dataDir: string
  model: string
  approvalPolicy: ApprovalPolicy
  sandboxMode: SandboxMode
  /** Compress safe tool context before each model call. */
  tokenEconomyMode: boolean
  /** Detailed token-saving behavior used when building WorkWise Runtime model requests. */
  tokenEconomy: KunTokenEconomySettingsV1
  /** When true, the runtime skips bearer-token auth. Local dev only. */
  insecure: boolean
  /** GUI-managed MCP progressive discovery/search settings written into WorkWise Runtime config.json. */
  mcpSearch: KunMcpSearchSettingsV1
  /** Persistent store backend used by WorkWise Runtime. */
  storage: KunStorageSettingsV1
  /** Fallback compaction thresholds and summary behavior. Per-model thresholds live in WorkWise Runtime config models.profiles. */
  contextCompaction: KunContextCompactionSettingsV1
  /** Low-level loop guards and model argument repair tuning. */
  runtimeTuning: KunRuntimeTuningSettingsV1
  /** OpenAI-compatible image generation provider shared by chat agents and Write image tools. */
  imageGeneration: KunImageGenerationSettingsV1
  /** Optional structured image analysis for text-only models. */
  visionEvidence: KunVisionEvidenceSettingsV1
}

/** WorkWise-owned selector view over the persisted `agents.kun` compatibility key. */
export type ManagedRuntimeSettingsV1 = KunRuntimeSettingsV1
export type ManagedRuntimeSettingsPatchV1 = KunRuntimeSettingsPatchV1

export type KunImageGenerationSettingsV1 = {
  enabled: boolean
  /** Existing provider profile to use for image generation. Empty or "custom" uses the fields below. */
  providerId: string
  /** Request protocol used when providerId is custom. Provider presets override this with their image capability. */
  protocol: ImageGenerationProtocol
  /** Custom image API root, or an override for the selected provider image API root. */
  baseUrl: string
  /** Custom image API key override. Empty inherits the selected provider API key when providerId is set. */
  apiKey: string
  model: string
  /** Default "WxH" or "auto" used when the model omits aspect ratio and size. Empty means provider default. */
  defaultSize: string
  timeoutMs: number
}

export type KunVisionEvidenceSettingsV1 = {
  enabled: boolean
  endpoint: string
  timeoutMs: number
  analyzer: string
}

export type KunMcpSearchMode = 'direct' | 'search' | 'auto'

export type KunMcpSearchSettingsV1 = {
  enabled: boolean
  mode: KunMcpSearchMode
  autoThresholdToolCount: number
  topKDefault: number
  topKMax: number
  minScore: number
}

export type KunStorageBackend = 'hybrid' | 'file'

export type KunStorageSettingsV1 = {
  backend: KunStorageBackend
  sqlitePath: string
}

export type KunCompactionSummaryMode = 'heuristic' | 'model'

export type KunHistoryHygieneSettingsV1 = {
  maxToolResultLines: number
  maxToolResultBytes: number
  maxToolResultTokens: number
  maxToolArgumentStringBytes: number
  maxToolArgumentStringTokens: number
  maxArrayItems: number
}

export type KunTokenEconomySettingsV1 = {
  enabled: boolean
  compressToolDescriptions: boolean
  compressToolResults: boolean
  conciseResponses: boolean
  historyHygiene: KunHistoryHygieneSettingsV1
}

export type KunContextCompactionSettingsV1 = {
  defaultSoftThreshold: number
  defaultHardThreshold: number
  summaryMode: KunCompactionSummaryMode
  summaryTimeoutMs: number
  summaryMaxTokens: number
  summaryInputMaxBytes: number
}

export type KunToolStormSettingsV1 = {
  enabled: boolean
  windowSize: number
  threshold: number
}

export type KunToolArgumentRepairSettingsV1 = {
  maxStringBytes: number
}

export type KunRuntimeTuningSettingsV1 = {
  toolStorm: KunToolStormSettingsV1
  toolArgumentRepair: KunToolArgumentRepairSettingsV1
}

/**
 * Compatibility shell kept because persisted settings still use the
 * `agents.kun` envelope. Prefer operating on the contained
 * `KunRuntimeSettingsV1` directly in new code.
 */
export type KunSettingsEnvelopeV1 = {
  kun: KunRuntimeSettingsV1
}

/** @deprecated Use `KunSettingsEnvelopeV1`. */
export type AgentRuntimeSettingsMapV1 = KunSettingsEnvelopeV1

export type KunRuntimeTuningSettingsPatchV1 = {
  toolStorm?: Partial<KunToolStormSettingsV1>
  toolArgumentRepair?: Partial<KunToolArgumentRepairSettingsV1>
}

export type KunTokenEconomySettingsPatchV1 = Partial<
  Omit<KunTokenEconomySettingsV1, 'historyHygiene'>
> & {
  historyHygiene?: Partial<KunHistoryHygieneSettingsV1>
}

export type KunRuntimeSettingsPatchV1 = Partial<
  Omit<
    KunRuntimeSettingsV1,
    'mcpSearch' | 'storage' | 'contextCompaction' | 'runtimeTuning' | 'tokenEconomy' | 'imageGeneration' | 'visionEvidence'
  >
> & {
  mcpSearch?: Partial<KunMcpSearchSettingsV1>
  tokenEconomy?: KunTokenEconomySettingsPatchV1
  storage?: Partial<KunStorageSettingsV1>
  contextCompaction?: Partial<KunContextCompactionSettingsV1>
  runtimeTuning?: KunRuntimeTuningSettingsPatchV1
  imageGeneration?: Partial<KunImageGenerationSettingsV1>
  visionEvidence?: Partial<KunVisionEvidenceSettingsV1>
}

export type KunSettingsEnvelopePatchV1 = {
  kun?: KunRuntimeSettingsPatchV1
}

export type LogConfigV1 = {
  enabled: boolean
  retentionDays: number
}

export type TerminalNotificationKindV1 =
  | 'completed'
  | 'error'
  | 'aborted'
  | 'blocked'
  | 'max_tokens'
  | 'waiting_approval'

export type TurnTerminalNotificationConfigV1 = {
  enabled: boolean
  kinds: TerminalNotificationKindV1[]
  suppressActiveThread: boolean
  include: string[]
  exclude: string[]
}

export type NotificationConfigV1 = {
  /** Legacy mirror retained while older renderers still write this field. */
  turnComplete: boolean
  turnTerminal?: TurnTerminalNotificationConfigV1
}

export type NotificationConfigPatchV1 = {
  turnComplete?: boolean
  turnTerminal?: Partial<TurnTerminalNotificationConfigV1>
}

export type AppBehaviorConfigV1 = {
  openAtLogin: boolean
  startMinimized: boolean
  closeToTray: boolean
}

export type ScheduleSkillSettingsV1 = {
  defaultNames: string[]
  extraDirs: string[]
}

export type ScheduledTaskScheduleV1 = {
  kind: ScheduleKind
  everyMinutes: number
  timeOfDay: string
  atTime: string
}

export type ScheduledTaskV1 = {
  id: string
  title: string
  enabled: boolean
  prompt: string
  workspaceRoot: string
  model: string
  reasoningEffort: ScheduleReasoningEffort
  mode: ScheduleRunMode
  schedule: ScheduledTaskScheduleV1
  createdAt: string
  updatedAt: string
  lastRunAt: string
  nextRunAt: string
  lastStatus: ScheduleTaskStatus
  lastMessage: string
  lastThreadId: string
}

export type ScheduleInternalSettingsV1 = {
  port: number
  secret: string
}

export type ScheduleSettingsV1 = {
  enabled: boolean
  defaultWorkspaceRoot: string
  model: string
  mode: ScheduleRunMode
  promptPrefix: string
  skills: ScheduleSkillSettingsV1
  keepAwake: boolean
  internal: ScheduleInternalSettingsV1
  tasks: ScheduledTaskV1[]
}

export type ClawSkillSettingsV1 = {
  defaultNames: string[]
  extraDirs: string[]
  promptPrefix: string
}

export type ClawImSettingsV1 = {
  enabled: boolean
  provider: ClawImProvider
  port: number
  path: string
  secret: string
  weixinBridgeUrl: string
  workspaceRoot: string
  model: string
  mode: ClawRunMode
  responseTimeoutMs: number
}

export type ClawTaskScheduleV1 = {
  kind: ClawScheduleKind
  everyMinutes: number
  timeOfDay: string
  atTime: string
}

export type ClawTaskV1 = ScheduledTaskV1

export type ClawImAgentProfileV1 = {
  name: string
  description: string
  identity: string
  personality: string
  userContext: string
  replyRules: string
}

export type ClawImFeishuPlatformCredentialV1 = {
  kind: 'feishu'
  appId: string
  /** @deprecated Secrets are stored by the main-process credential service. */
  appSecret?: string
  domain: string
  createdAt: string
}

export type ClawImWeixinPlatformCredentialV1 = {
  kind: 'weixin'
  accountId: string
  /** @deprecated Secrets are stored by the main-process credential service. */
  sessionKey?: string
  createdAt: string
}

export type ClawImPlatformCredentialV1 =
  | ClawImFeishuPlatformCredentialV1
  | ClawImWeixinPlatformCredentialV1

export type ClawImRemoteSessionV1 = {
  chatId: string
  messageId: string
  threadId: string
  senderId: string
  senderName: string
  updatedAt: string
}

export type ClawImConversationV1 = {
  id: string
  chatId: string
  remoteThreadId: string
  latestMessageId: string
  senderId: string
  senderName: string
  /** WorkWise Runtime thread id this conversation maps to. */
  localThreadId: string
  workspaceRoot: string
  createdAt: string
  updatedAt: string
}

export type ClawImChannelV1 = {
  id: string
  provider: ClawImProvider
  label: string
  enabled: boolean
  model: string
  /** WorkWise Runtime thread id this channel maps to. */
  threadId: string
  workspaceRoot: string
  agentProfile: ClawImAgentProfileV1
  /** Public identity and legacy compatibility fields. New writes omit secrets. */
  platformCredential?: ClawImPlatformCredentialV1
  credentialRef?: ImCredentialRefV1
  remoteSession?: ClawImRemoteSessionV1
  conversations: ClawImConversationV1[]
  /** When the one-time IM welcome/intro message was delivered. */
  welcomeSentAt?: string
  createdAt: string
  updatedAt: string
}

export type ClawSettingsV1 = {
  enabled: boolean
  skills: ClawSkillSettingsV1
  im: ClawImSettingsV1
  channels: ClawImChannelV1[]
  tasks: ClawTaskV1[]
}

export type WriteInlineCompletionSettingsV1 = {
  enabled: boolean
  retrievalEnabled: boolean
  longCompletionEnabled: boolean
  /** When true, Write inherits WorkWise Runtime's selected provider instead of using `providerId`. */
  inheritProvider: boolean
  /** Selected provider for Write inline completion when `inheritProvider` is false. */
  providerId: string
  apiKey: string
  baseUrl: string
  /** When true, Write inherits WorkWise Runtime's runtime model instead of using `model` as an override. */
  inheritModel: boolean
  model: string
  debounceMs: number
  longDebounceMs: number
  minAcceptScore: number
  longMinAcceptScore: number
  maxTokens: number
  longMaxTokens: number
}

export type WriteKnowledgeBaseSettingsV1 = {
  enabled: boolean
  mode: 'hybrid'
  apiBaseUrl: string
  publicBaseUrl: string
}

export type WriteSettingsV1 = {
  defaultWorkspaceRoot: string
  activeWorkspaceRoot: string
  workspaces: string[]
  inlineCompletion: WriteInlineCompletionSettingsV1
  knowledgeBase: WriteKnowledgeBaseSettingsV1
  /** 用户自定义的导出模板（内置模板不存储于此，运行时合并） */
  exportTemplates: import('./write-export-templates').ExportStyleTemplate[]
  /** 默认导出模板 id（缺省时用内置默认） */
  defaultExportTemplateId: string
}

export type ClawSettingsPatchV1 = Partial<Omit<ClawSettingsV1, 'skills' | 'im' | 'channels' | 'tasks'>> & {
  skills?: Partial<ClawSkillSettingsV1>
  im?: Partial<ClawImSettingsV1>
  channels?: Array<Partial<ClawImChannelV1>>
  tasks?: Array<Partial<ClawTaskV1>>
}

export type ScheduleSettingsPatchV1 = Partial<
  Omit<ScheduleSettingsV1, 'skills' | 'internal' | 'tasks'>
> & {
  skills?: Partial<ScheduleSkillSettingsV1>
  internal?: Partial<ScheduleInternalSettingsV1>
  tasks?: Array<Partial<ScheduledTaskV1>>
}

export type WriteSettingsPatchV1 = Partial<Omit<WriteSettingsV1, 'inlineCompletion' | 'knowledgeBase'>> & {
  inlineCompletion?: Partial<WriteInlineCompletionSettingsV1>
  knowledgeBase?: Partial<WriteKnowledgeBaseSettingsV1>
}

export type ClawGeneratedFileV1 = {
  path: string
  relativePath?: string
  fileName: string
}

export type ClawRunFailureReasonV1 =
  | 'failed'
  | 'timeout'
  | 'authorization_required'
  | 'user_input_required'
  | 'empty_result'

type ClawRunSuccessV1 = {
  ok: true
  threadId: string
  turnId?: string
  text?: string
  message?: string
  files?: ClawGeneratedFileV1[]
}

export type ClawRunResult =
  | ClawRunSuccessV1
  | { ok: false; reason: ClawRunFailureReasonV1; message: string }

export type ScheduleRunResult =
  | ClawRunSuccessV1
  | { ok: false; message: string }

export type ScheduleTaskFromTextResult =
  | { kind: 'noop' }
  | { kind: 'created'; taskId: string; title: string; scheduleAt: string; confirmationText: string }
  | { kind: 'error'; message: string }

export type ClawTaskFromTextResult = ScheduleTaskFromTextResult

export type ClawRuntimeStatus = {
  imServerRunning: boolean
  imUrl: string
  runningTaskIds: string[]
}

export type ScheduleRuntimeStatus = {
  internalServerRunning: boolean
  internalUrl: string
  runningTaskIds: string[]
  powerSaveBlockerActive: boolean
}

export type GuiUpdateConfigV1 = {
  channel: GuiUpdateChannel
}

export type ConversationSettingsV1 = {
  viewMode: import('./agent-workbench').ConversationViewMode
}

export type DocumentSettingsV1 = {
  parsingMode: import('./agent-workbench').DocumentParsingMode
  unlimitedOcrServerUrl: string
  privateMineruServerUrl: string
  allowPrivateServerUploadByWorkspace: Record<string, boolean>
}

export type AppSettingsV1 = {
  /** Present on WorkWise V2 settings; absent on legacy V1 input. */
  schema?: 'workwise.settings'
  /** V1 is accepted only as a migration input. New writes are always V2. */
  version: 1 | 2
  /** Monotonic on WorkWise V2 settings; absent on legacy V1 input. */
  revision?: number
  locale: 'en' | 'zh'
  theme: 'system' | 'light' | 'dark'
  uiFontScale: UiFontScale
  provider: ModelProviderSettingsV1
  agents: KunSettingsEnvelopeV1
  workspaceRoot: string
  log: LogConfigV1
  notifications: NotificationConfigV1
  appBehavior: AppBehaviorConfigV1
  keyboardShortcuts: KeyboardShortcutsConfigV1
  write: WriteSettingsV1
  claw: ClawSettingsV1
  schedule: ScheduleSettingsV1
  guiUpdate: GuiUpdateConfigV1
  /** Optional on legacy V1 input; normalized and required on WorkWise V2 output. */
  conversation?: ConversationSettingsV1
  /** Optional on legacy V1 input; normalized and required on WorkWise V2 output. */
  documents?: DocumentSettingsV1
  codePromptPrefix: string
}

export type WorkWiseSettingsV2 = Omit<AppSettingsV1, 'schema' | 'version' | 'revision' | 'conversation' | 'documents'> & {
  schema: 'workwise.settings'
  version: 2
  revision: number
  conversation: ConversationSettingsV1
  documents: DocumentSettingsV1
}

export type AppSettingsPatch = Partial<
  Omit<AppSettingsV1, 'schema' | 'version' | 'revision' | 'provider' | 'agents' | 'log' | 'notifications' | 'appBehavior' | 'keyboardShortcuts' | 'write' | 'claw' | 'schedule' | 'guiUpdate' | 'conversation' | 'documents'>
> & {
  provider?: ModelProviderSettingsPatchV1
  agents?: KunSettingsEnvelopePatchV1
  log?: Partial<LogConfigV1>
  notifications?: NotificationConfigPatchV1
  appBehavior?: Partial<AppBehaviorConfigV1>
  keyboardShortcuts?: Partial<KeyboardShortcutsConfigV1>
  write?: WriteSettingsPatchV1
  claw?: ClawSettingsPatchV1
  schedule?: ScheduleSettingsPatchV1
  guiUpdate?: Partial<GuiUpdateConfigV1>
  conversation?: Partial<ConversationSettingsV1>
  documents?: Partial<DocumentSettingsV1>
}
