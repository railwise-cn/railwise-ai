import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { LEGACY_USER_DATA_DIR_NAMES, isRecognizedSettingsText } from './legacy-data-migration'
import {
  atomicWriteFile,
  backupFileIfPresent,
  runSerialized
} from './services/durable-file'
import {
  applyManagedRuntimePatch,
  kunSettingsEnvelope,
  DEFAULT_WORKSPACE_ROOT,
  DEFAULT_GUI_UPDATE_CHANNEL,
  DEFAULT_WRITE_WORKSPACE_ROOT,
  defaultClawSettings,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  getManagedRuntimeSettings,
  mergeManagedRuntimeSettings,
  mergeModelProviderSettings,
  defaultWriteSettings,
  mergeClawSettings,
  mergeScheduleSettings,
  mergeWriteSettings,
  mergeNotificationSettings,
  isLegacyManagedWeixinBridgeUrl,
  normalizeAppBehaviorSettings,
  normalizeKeyboardShortcuts,
  migrateLegacyAppSettings,
  normalizeAppSettings,
  type AppSettingsPatch,
  type AppSettingsV1,
  type WorkWiseSettingsV2,
  type ClawImChannelV1,
  type ClawImConversationV1
} from '../shared/app-settings'

export type { AppSettingsV1, WorkWiseSettingsV2 }

export function workwiseRuntimeHomeDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const candidateHome = env.WORKWISE_CANDIDATE === '1'
    ? env.WORKWISE_CANDIDATE_HOME?.trim()
    : ''
  return candidateHome ? resolve(candidateHome) : homedir()
}

export function resolveWorkwiseHome(
  explicitWorkwiseHome?: string,
  runtimeHomeDirectory: string = workwiseRuntimeHomeDirectory()
): string {
  return explicitWorkwiseHome ?? join(runtimeHomeDirectory, '.workwise')
}

const SETTINGS_FILE_NAME = 'workwise-settings.json'
const COMPATIBLE_SETTINGS_FILE_NAMES = ['workgpt-settings.json', 'kun-settings.json', 'deepseek-gui-settings.json'] as const
const COMPATIBLE_USER_DATA_DIR_NAMES = LEGACY_USER_DATA_DIR_NAMES
const WELCOME_MARKDOWN_EN = `# Welcome to Write

This is your default writing workspace.

- Create Markdown drafts from the sidebar.
- Select text in the editor and ask the writing assistant about it.
- Switch between source, live, split, and preview modes from the top bar.
`
const WELCOME_MARKDOWN_ZH = `# 欢迎使用 RailWise AI 写作台

这是你的默认写作空间。

- 从左侧新建或打开 Markdown 草稿。
- 选中文本后引用给写作助手，或直接向助手提问。
- 使用顶部工具栏切换实时、源码、分屏和预览模式。
- 本地编辑和导出不依赖 AI；配置模型后可使用知识库、配图和 PPT 等能力。
`

export function expandHomePath(
  raw: string | null | undefined,
  homeDirectory: string = workwiseRuntimeHomeDirectory()
): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (!value) return ''
  if (value === '~') return homeDirectory
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homeDirectory, value.slice(2))
  }
  return value
}

function normalizeWorkspaceRoot(raw: string | null | undefined, homeDirectory?: string): string {
  // Empty is an intentional selection (e.g. after removing a workspace).
  // Only first launch supplies DEFAULT_WORKSPACE_ROOT below.
  return expandHomePath(raw, homeDirectory)
}

function normalizeWriteWorkspaceRoot(raw: string | null | undefined, homeDirectory?: string): string {
  return expandHomePath(raw, homeDirectory) || expandHomePath(DEFAULT_WRITE_WORKSPACE_ROOT, homeDirectory)
}

function sanitizePathSegment(raw: string | null | undefined, fallback: string): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  const sanitized = value
    .replace(/[\\/]/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || fallback
}

function defaultClawChannelWorkspaceRoot(channel: ClawImChannelV1, workwiseHome: string): string {
  const credential = channel.platformCredential
  const domain = credential?.kind === 'feishu'
    ? credential.domain
    : credential?.kind === 'weixin'
      ? 'weixin'
      : channel.provider
  const credentialId = credential?.kind === 'feishu'
    ? credential.appId
    : credential?.kind === 'weixin'
      ? credential.accountId
      : ''
  const workspaceId = sanitizePathSegment(credentialId || channel.id, 'channel')
  return join(workwiseHome, 'claw', channel.provider, domain, workspaceId)
}

function normalizeClawChannelWorkspaceRoot(
  channel: ClawImChannelV1,
  workwiseHome: string = join(workwiseRuntimeHomeDirectory(), '.workwise')
): string {
  return expandHomePath(channel.workspaceRoot, dirname(workwiseHome)) || defaultClawChannelWorkspaceRoot(channel, workwiseHome)
}

function sanitizeConversationWorkspaceSegment(conversation: ClawImConversationV1): string {
  return sanitizePathSegment(
    conversation.remoteThreadId || conversation.chatId,
    conversation.id || 'conversation'
  )
}

function defaultClawConversationWorkspaceRoot(
  channel: ClawImChannelV1,
  conversation: ClawImConversationV1,
  workwiseHome: string
): string {
  return join(
    normalizeClawChannelWorkspaceRoot(channel, workwiseHome),
    'conversations',
    sanitizeConversationWorkspaceSegment(conversation)
  )
}

function normalizeClawConversationWorkspaceRoot(
  channel: ClawImChannelV1,
  conversation: ClawImConversationV1,
  workwiseHome: string = join(workwiseRuntimeHomeDirectory(), '.workwise')
): string {
  return expandHomePath(conversation.workspaceRoot, dirname(workwiseHome)) ||
    defaultClawConversationWorkspaceRoot(channel, conversation, workwiseHome)
}

function normalizeStoredSettings(
  settings: AppSettingsV1,
  workwiseHome: string = join(workwiseRuntimeHomeDirectory(), '.workwise')
): WorkWiseSettingsV2 {
  const homeDirectory = dirname(workwiseHome)
  const normalized = normalizeAppSettings(settings)
  const writeDefaultRoot = normalizeWriteWorkspaceRoot(normalized.write.defaultWorkspaceRoot, homeDirectory)
  const writeActiveRoot = normalizeWriteWorkspaceRoot(
    normalized.write.activeWorkspaceRoot || writeDefaultRoot,
    homeDirectory
  )
  const writeWorkspaces = [...new Set(
    [
      writeDefaultRoot,
      writeActiveRoot,
      ...normalized.write.workspaces.map((root) => normalizeWriteWorkspaceRoot(root, homeDirectory))
    ]
      .filter(Boolean)
  )]
  return {
    ...normalized,
    schema: 'workwise.settings',
    version: 2,
    revision: Number.isSafeInteger(normalized.revision) && (normalized.revision ?? -1) >= 0
      ? normalized.revision as number
      : 0,
    workspaceRoot: normalizeWorkspaceRoot(normalized.workspaceRoot, homeDirectory),
    conversation: normalized.conversation ?? { viewMode: 'concise' },
    documents: normalized.documents ?? {
      parsingMode: 'auto',
      unlimitedOcrServerUrl: '',
      privateMineruServerUrl: '',
      allowPrivateServerUploadByWorkspace: {}
    },
    write: {
      defaultWorkspaceRoot: writeDefaultRoot,
      activeWorkspaceRoot: writeWorkspaces.includes(writeActiveRoot) ? writeActiveRoot : writeDefaultRoot,
      workspaces: writeWorkspaces.length > 0 ? writeWorkspaces : [writeDefaultRoot],
      inlineCompletion: normalized.write.inlineCompletion,
      knowledgeBase: normalized.write.knowledgeBase,
      exportTemplates: normalized.write.exportTemplates,
      defaultExportTemplateId: normalized.write.defaultExportTemplateId
    },
    claw: {
      ...normalized.claw,
      channels: normalized.claw.channels.map((channel) => ({
        ...channel,
        workspaceRoot: normalizeClawChannelWorkspaceRoot(channel, workwiseHome),
        conversations: channel.conversations.map((conversation) => ({
          ...conversation,
          workspaceRoot: normalizeClawConversationWorkspaceRoot(channel, conversation, workwiseHome)
        }))
      }))
    }
  }
}

function serializeSettingsForDisk(settings: WorkWiseSettingsV2, workwiseHome?: string): string {
  return JSON.stringify(normalizeStoredSettings(settings, workwiseHome), null, 2)
}

export async function ensureWorkspaceRootExists(workspaceRoot: string): Promise<string> {
  const normalized = normalizeWorkspaceRoot(workspaceRoot)
  if (normalized) await mkdir(normalized, { recursive: true })
  return normalized
}

async function ensureWriteWorkspaceRootsExist(settings: AppSettingsV1): Promise<void> {
  for (const workspaceRoot of settings.write.workspaces) {
    if (!workspaceRoot) continue
    await mkdir(workspaceRoot, { recursive: true })
  }

  const welcomePath = join(settings.write.defaultWorkspaceRoot, 'welcome.md')
  const welcomeMarkdown = settings.locale === 'zh' ? WELCOME_MARKDOWN_ZH : WELCOME_MARKDOWN_EN
  try {
    await writeFile(welcomePath, welcomeMarkdown, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error

    // A fresh profile is initially persisted with the neutral English default
    // before the renderer applies the OS/onboarding locale. Translate only an
    // untouched generated welcome file; never overwrite a user's edits.
    const existingWelcome = await readFile(welcomePath, 'utf8')
    const otherDefault = settings.locale === 'zh' ? WELCOME_MARKDOWN_EN : WELCOME_MARKDOWN_ZH
    if (existingWelcome === otherDefault) {
      await atomicWriteFile(welcomePath, welcomeMarkdown)
    }
  }
}

async function ensureClawChannelWorkspaceRootsExist(settings: AppSettingsV1): Promise<void> {
  for (const channel of settings.claw.channels) {
    const workspaceRoot = normalizeClawChannelWorkspaceRoot(channel)
    if (!workspaceRoot) continue
    await mkdir(workspaceRoot, { recursive: true })
    for (const conversation of channel.conversations) {
      const conversationWorkspaceRoot = normalizeClawConversationWorkspaceRoot(channel, conversation)
      if (!conversationWorkspaceRoot) continue
      await mkdir(conversationWorkspaceRoot, { recursive: true })
    }
  }
}

const defaultSettings = (workwiseHome: string): WorkWiseSettingsV2 => ({
  schema: 'workwise.settings',
  version: 2,
  revision: 0,
  locale: 'en',
  theme: 'system',
  uiFontScale: 'small',
  provider: defaultModelProviderSettings(),
  agents: {
    kun: defaultManagedRuntimeSettings()
  },
  workspaceRoot: normalizeWorkspaceRoot(DEFAULT_WORKSPACE_ROOT, dirname(workwiseHome)),
  log: {
    enabled: true,
    retentionDays: 2
  },
  notifications: {
    turnComplete: true,
    turnTerminal: {
      enabled: true,
      kinds: ['completed'],
      suppressActiveThread: false,
      include: [],
      exclude: []
    }
  },
  appBehavior: normalizeAppBehaviorSettings(),
  keyboardShortcuts: normalizeKeyboardShortcuts(),
  guiUpdate: {
    channel: DEFAULT_GUI_UPDATE_CHANNEL
  },
  conversation: {
    viewMode: 'concise'
  },
  documents: {
    parsingMode: 'auto',
    unlimitedOcrServerUrl: '',
    privateMineruServerUrl: '',
    allowPrivateServerUploadByWorkspace: {}
  },
  codePromptPrefix: '',
  write: defaultWriteSettings(),
  claw: defaultClawSettings(),
  schedule: defaultScheduleSettings()
})

function buildMergedSettings(parsed: Partial<AppSettingsV1>, workwiseHome: string): WorkWiseSettingsV2 {
  const migrated = migrateLegacyAppSettings(parsed)
  const defaults = defaultSettings(workwiseHome)
  const runtime = mergeManagedRuntimeSettings(
    getManagedRuntimeSettings(defaults),
    migrated.agents?.kun
  )
  const providerId = runtime.providerId || undefined
  return normalizeStoredSettings({
    ...defaults,
    ...migrated,
    provider: mergeModelProviderSettings(defaults.provider, migrated.provider),
    agents: kunSettingsEnvelope(runtime),
    log: { ...defaults.log, ...migrated.log },
    notifications: mergeNotificationSettings(defaults.notifications, migrated.notifications),
    appBehavior: normalizeAppBehaviorSettings({
      ...defaults.appBehavior,
      ...migrated.appBehavior
    }),
    keyboardShortcuts: normalizeKeyboardShortcuts(migrated.keyboardShortcuts),
    write: mergeWriteSettings(defaults.write, migrated.write),
    claw: mergeClawSettings(defaults.claw, migrated.claw, providerId),
    schedule: mergeScheduleSettings(defaults.schedule, migrated.schedule, providerId),
    guiUpdate: { ...defaults.guiUpdate, ...migrated.guiUpdate },
    conversation: { ...defaults.conversation, ...migrated.conversation },
    documents: {
      ...defaults.documents,
      ...migrated.documents,
      allowPrivateServerUploadByWorkspace: {
        ...defaults.documents.allowPrivateServerUploadByWorkspace,
        ...migrated.documents?.allowPrivateServerUploadByWorkspace
      }
    },
    codePromptPrefix: typeof migrated.codePromptPrefix === 'string' ? migrated.codePromptPrefix : ''
  } as AppSettingsV1, workwiseHome)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null
}

async function loadDefaultSettings(workwiseHome: string): Promise<WorkWiseSettingsV2> {
  const defaults = normalizeStoredSettings(defaultSettings(workwiseHome), workwiseHome)
  await ensureWorkspaceRootExists(defaults.workspaceRoot)
  await ensureWriteWorkspaceRootsExist(defaults)
  await ensureClawChannelWorkspaceRootsExist(defaults)
  return defaults
}

async function writeInvalidSettingsBackup(path: string, raw: string): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = join(
    dirname(path),
    `${basename(path, '.json')}.invalid-${stamp}.json`
  )
  try {
    await writeFile(backupPath, raw, 'utf8')
    return backupPath
  } catch {
    return null
  }
}

function compatibleSettingsPaths(currentPath: string): string[] {
  const currentUserDataDir = dirname(currentPath)
  const currentDirName = basename(currentUserDataDir)
  const currentFileName = basename(currentPath)
  const parentDir = dirname(currentUserDataDir)
  const directories = [
    currentUserDataDir,
    ...COMPATIBLE_USER_DATA_DIR_NAMES
      .filter((dirName) => dirName !== currentDirName)
      .map((dirName) => join(parentDir, dirName))
  ]
  const fileNames = [currentFileName, ...COMPATIBLE_SETTINGS_FILE_NAMES]
  const candidates = new Set<string>()
  for (const directory of directories) {
    for (const fileName of fileNames) {
      const candidate = join(directory, fileName)
      if (candidate !== currentPath) candidates.add(candidate)
    }
  }
  return [...candidates]
}

type SettingsMigrationManifestV2 = {
  schema: 'workwise.migration'
  version: 2
  completedAt: string
  sourcePath: string
  targetPath: string
  backupPath: string | null
  sourceVersion: number | null
}

function migrationManifestPath(workwiseHome: string): string {
  return join(workwiseHome, 'migrations', 'v2.json')
}

async function recordSettingsMigration(
  sourcePath: string,
  targetPath: string,
  sourceVersion: number | null,
  raw: string,
  workwiseHome: string
): Promise<void> {
  const manifestPath = migrationManifestPath(workwiseHome)
  const migrationRoot = dirname(manifestPath)
  const backupName = `${basename(sourcePath, '.json')}-${Buffer.from(sourcePath).toString('hex').slice(-16)}.json`
  const backupPath = join(migrationRoot, 'backups', backupName)
  let recordedBackup: string | null = null
  try {
    const copied = await backupFileIfPresent(sourcePath, backupPath)
    if (copied) recordedBackup = backupPath
  } catch {
    // The source may disappear between read and backup. Preserve the loaded bytes instead.
    await atomicWriteFile(backupPath, raw)
    recordedBackup = backupPath
  }
  const manifest: SettingsMigrationManifestV2 = {
    schema: 'workwise.migration',
    version: 2,
    completedAt: new Date().toISOString(),
    sourcePath,
    targetPath,
    backupPath: recordedBackup,
    sourceVersion
  }
  await atomicWriteFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

export class SettingsRevisionConflictError extends Error {
  readonly code = 'stale_request'
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Settings revision conflict: expected ${expectedRevision}, found ${actualRevision}`)
    this.name = 'SettingsRevisionConflictError'
  }
}

export class LegacySettingsSourceConflictError extends Error {
  readonly code = 'legacy_profile_conflict'
  constructor(readonly sourcePaths: string[]) {
    super(`检测到多个可用的历史资料目录，请先选择要导入的资料；所有原件已保留：${sourcePaths.join('、')}`)
    this.name = 'LegacySettingsSourceConflictError'
  }
}

async function readSettingsFileWithCompatibility(
  currentPath: string
): Promise<{ raw: string, sourcePath: string } | null> {
  try {
    return {
      raw: await readFile(currentPath, 'utf8'),
      sourcePath: currentPath
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== 'ENOENT') throw error
  }

  const sources = new Map<string, { raw: string; sourcePath: string }>()
  for (const candidatePath of compatibleSettingsPaths(currentPath)) {
    try {
      const raw = await readFile(candidatePath, 'utf8')
      // A legacy filename in the active profile is authoritative, even if it
      // needs the existing invalid-JSON recovery. Only sibling profiles compete.
      if (dirname(candidatePath) === dirname(currentPath)) return { raw, sourcePath: candidatePath }
      if (!isRecognizedSettingsText(raw)) continue
      const info = await stat(dirname(candidatePath))
      const identity = `${info.dev}:${info.ino}`
      if (!sources.has(identity)) sources.set(identity, { raw, sourcePath: candidatePath })
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') continue
      throw error
    }
  }
  if (sources.size > 1) throw new LegacySettingsSourceConflictError([...sources.values()].map(source => dirname(source.sourcePath)))
  return [...sources.values()][0] || null
}

export class JsonSettingsStore {
  private path: string
  private workwiseHome: string
  private cache: WorkWiseSettingsV2 | null = null

  constructor(userDataPath: string, options?: { workwiseHome?: string }) {
    this.path = join(userDataPath, SETTINGS_FILE_NAME)
    this.workwiseHome = resolveWorkwiseHome(options?.workwiseHome)
  }

  async load(): Promise<WorkWiseSettingsV2> {
    if (this.cache) return this.cache

    let raw = ''
    let sourcePath = this.path
    try {
      const loaded = await readSettingsFileWithCompatibility(this.path)
      if (!loaded) {
        const defaults = await loadDefaultSettings(this.workwiseHome)
        await mkdir(dirname(this.path), { recursive: true })
        await atomicWriteFile(this.path, serializeSettingsForDisk(defaults, this.workwiseHome))
        this.cache = defaults
        return this.cache
      }
      raw = loaded.raw
      sourcePath = loaded.sourcePath
    } catch (error) {
      if (error instanceof LegacySettingsSourceConflictError) throw error
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to read settings file ${sourcePath}: ${message}`, { cause: error })
    }

    let parsed: Partial<AppSettingsV1>
    try {
      parsed = JSON.parse(raw) as Partial<AppSettingsV1>
    } catch (error) {
      if (error instanceof SyntaxError) {
        const backupPath = await writeInvalidSettingsBackup(sourcePath, raw)
        const defaults = await loadDefaultSettings(this.workwiseHome)
        await this.save(defaults)
        if (backupPath) {
          console.warn(
            `[workwise] Invalid settings JSON was replaced with defaults. Backup: ${backupPath}`
          )
        } else {
          console.warn(
            `[workwise] Invalid settings JSON was replaced with defaults. Backup could not be written for ${sourcePath}.`
          )
        }
        return defaults
      }
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to parse settings file ${sourcePath}: ${message}`, { cause: error })
    }

    const normalized = normalizeStoredSettings(
      buildMergedSettings(parsed, this.workwiseHome),
      this.workwiseHome
    )
    await ensureWorkspaceRootExists(normalized.workspaceRoot)
    await ensureWriteWorkspaceRootsExist(normalized)
    await ensureClawChannelWorkspaceRootsExist(normalized)
    const parsedClawIm = (parsed.claw as { im?: { weixinBridgeUrl?: unknown } } | undefined)?.im
    const needsV2Commit = sourcePath !== this.path ||
      parsed.schema !== 'workwise.settings' ||
      parsed.version !== 2 ||
      isLegacyManagedWeixinBridgeUrl(parsedClawIm?.weixinBridgeUrl)
    if (needsV2Commit) {
      await recordSettingsMigration(
        sourcePath,
        this.path,
        typeof parsed.version === 'number' ? parsed.version : null,
        raw,
        this.workwiseHome
      )
      await mkdir(dirname(this.path), { recursive: true })
      await atomicWriteFile(this.path, serializeSettingsForDisk(normalized, this.workwiseHome))
    }
    this.cache = normalized
    return this.cache
  }

  async save(data: AppSettingsV1): Promise<WorkWiseSettingsV2> {
    const normalized = normalizeStoredSettings(data, this.workwiseHome)
    await ensureWorkspaceRootExists(normalized.workspaceRoot)
    await ensureWriteWorkspaceRootsExist(normalized)
    await ensureClawChannelWorkspaceRootsExist(normalized)
    await mkdir(dirname(this.path), { recursive: true })
    await atomicWriteFile(this.path, serializeSettingsForDisk(normalized, this.workwiseHome))
    this.cache = normalized
    return normalized
  }

  async patch(partial: AppSettingsPatch, expectedRevision?: number): Promise<WorkWiseSettingsV2> {
    return this.patchPrepared(() => partial, expectedRevision)
  }

  async patchPrepared(
    prepare: (current: WorkWiseSettingsV2) => AppSettingsPatch | Promise<AppSettingsPatch>,
    expectedRevision?: number,
    afterSave?: (previous: WorkWiseSettingsV2, saved: WorkWiseSettingsV2) => Promise<void> | void
  ): Promise<WorkWiseSettingsV2> {
    return runSerialized(`settings:${this.path}`, async () => {
      const cur = await this.load()
      if (expectedRevision !== undefined && expectedRevision !== cur.revision) {
        throw new SettingsRevisionConflictError(expectedRevision, cur.revision)
      }
      const partial = await prepare(cur)
      const {
        agents: agentsPatch,
        provider: providerPatch,
        conversation: conversationPatch,
        documents: documentsPatch,
        ...restPatch
      } = partial
      const runtime = mergeManagedRuntimeSettings(
        getManagedRuntimeSettings(cur),
        agentsPatch?.kun
      )
      const providerId = runtime.providerId || undefined
      const next = normalizeStoredSettings({
        ...applyManagedRuntimePatch(cur, agentsPatch?.kun),
        ...restPatch,
        schema: 'workwise.settings',
        version: 2,
        revision: cur.revision + 1,
        provider: mergeModelProviderSettings(cur.provider, providerPatch),
        log: { ...cur.log, ...(partial.log ?? {}) },
        notifications: mergeNotificationSettings(cur.notifications, partial.notifications),
        appBehavior: normalizeAppBehaviorSettings({
          ...cur.appBehavior,
          ...(partial.appBehavior ?? {})
        }),
        keyboardShortcuts: normalizeKeyboardShortcuts({
          bindings: {
            ...cur.keyboardShortcuts.bindings,
            ...(partial.keyboardShortcuts?.bindings ?? {})
          }
        }),
        write: mergeWriteSettings(cur.write, partial.write),
        claw: mergeClawSettings(cur.claw, partial.claw, providerId),
        schedule: mergeScheduleSettings(cur.schedule, partial.schedule, providerId),
        guiUpdate: { ...cur.guiUpdate, ...(partial.guiUpdate ?? {}) },
        conversation: { ...cur.conversation, ...(conversationPatch ?? {}) },
        documents: {
          ...cur.documents,
          ...(documentsPatch ?? {}),
          allowPrivateServerUploadByWorkspace: {
            ...cur.documents.allowPrivateServerUploadByWorkspace,
            ...(documentsPatch?.allowPrivateServerUploadByWorkspace ?? {})
          }
        }
      }, this.workwiseHome)
      const saved = await this.save(next)
      await afterSave?.(cur, saved)
      return saved
    })
  }
}

export function getRuntimeBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function devServerHintUrl(): string | undefined {
  return process.env.ELECTRON_RENDERER_URL
}
