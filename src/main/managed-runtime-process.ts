import { app } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  defaultManagedRuntimeTokenEconomySettings,
  isManagedRuntimeInsecure,
  resolveManagedRuntimeSettings,
  getModelProviderSettings,
  isOfficialDeepSeekBaseUrl,
  type ManagedRuntimeSettingsV1,
  type AppSettingsV1
} from '../shared/app-settings'
import {
  buildManagedRuntimeServeArgs,
  resolveManagedRuntimeExecutable
} from './resolve-managed-runtime'
import {
  KunConfigSchema as InternalRuntimeConfigSchema,
  KunServeConfigSchema as InternalRuntimeServeConfigSchema,
  ModelConfigSchema,
  ContextCompactionConfigSchema,
  RuntimeTuningConfigSchema,
  VisionEvidenceConfigSchema
} from '../../kun/src/config/kun-config.js'
import {
  AttachmentsCapabilityConfig,
  ImageGenCapabilityConfig,
  McpCapabilityConfig,
  McpServerConfig,
  MemoryCapabilityConfig,
  SkillsCapabilityConfig,
  SubagentsCapabilityConfig,
  WebCapabilityConfig
} from '../../kun/src/contracts/capabilities.js'
import {
  buildClawScheduleMcpArgs,
  GUI_SCHEDULE_MCP_SERVER_NAME,
  resolveClawScheduleMcpCommand,
  resolveRuntimeMcpJsonPath,
  type ClawScheduleMcpLaunchConfig
} from './claw-schedule-mcp-config'
import { defaultManagedRuntimeDataDir } from './runtime/managed-runtime-adapter'
import { isRuntimeHealthResponseBody } from './runtime-health'
import { appendManagedLogLine } from './logger'
import {
  guiSkillRootsForRuntime,
  installBundledSkill,
  normalizeSkillRootPath,
  resolveBundledSkillDirectory
} from './services/skill-service'
import {
  installBundledAgentPack,
  METRO_MONITORING_AGENT_PACK_ID
} from './services/agent-pack-service'
import { safeSpawn } from './services/safe-spawn'
import { atomicWriteFile as durableWriteFile } from './services/durable-file'
import { resolvePptMasterSidecarExecutable } from './services/ppt-master-sidecar'
import { loadOrCreateFlowSecretStoreKey } from './services/flow-secret-store-key'
import { McpConfigService } from './services/mcp-config-service'

let child: ChildProcess | null = null
let childLogCapture: RuntimeLogCapture | null = null
let lastResolvedBinary: string | null = null
let actualManagedRuntimePort: number | null = null
const RUNTIME_READY_PREFIX = 'KUN_READY '
// Cold starts on slow disks (Windows + antivirus scans, sqlite rebuilds,
// MCP server connects) routinely exceed 15s; killing kun that early left
// fresh installs permanently "unable to connect" (#188).
const RUNTIME_STARTUP_TIMEOUT_MS = 45_000
const RUNTIME_STARTUP_HEALTH_POLL_MS = 500
const RUNTIME_STARTUP_HEALTH_REQUEST_TIMEOUT_MS = 1_000
const RUNTIME_STOP_GRACE_MS = 5_000
const RUNTIME_STOP_FORCE_MS = 1_000
const STDERR_TAIL_MAX_CHARS = 4_000
const GUI_SCHEDULE_MCP_TIMEOUT_MS = 5_000
const HISTORICAL_DEFAULT_ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
const MCP_PATH_ENV_KEY = process.platform === 'win32' ? 'Path' : 'PATH'
const DEFAULT_MANAGED_RUNTIME_MODEL_PROFILES: Record<string, Record<string, unknown>> = {
  'deepseek-flash': {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    contextCompaction: {
      softThreshold: 980_000,
      hardThreshold: 990_000
    },
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    messageParts: ['text', 'image_url']
  },
  'deepseek-v4-pro': {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    contextCompaction: {
      softThreshold: 980_000,
      hardThreshold: 990_000
    },
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    messageParts: ['text']
  },
  'deepseek-v4-flash': {
    aliases: ['deepseek-chat', 'deepseek-reasoner'],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    contextCompaction: {
      softThreshold: 980_000,
      hardThreshold: 990_000
    },
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    messageParts: ['text']
  },
  'deepseek-v4-flash-vision-exp': {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 384_000,
    contextCompaction: {
      softThreshold: 980_000,
      hardThreshold: 990_000
    },
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    supportsToolCalling: true,
    messageParts: ['text', 'image_url']
  }
}

type RuntimeLogStream = 'stdout' | 'stderr' | 'lifecycle'
type RuntimeLogCapture = {
  captureStdout: (chunk: Buffer | string) => void
  captureStderr: (chunk: Buffer | string) => void
  logLifecycle: (message: string) => void
  close: () => Promise<void>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function appendTail(current: string, nextChunk: string, maxChars = STDERR_TAIL_MAX_CHARS): string {
  const combined = `${current}${nextChunk}`
  return combined.length > maxChars ? combined.slice(-maxChars) : combined
}

function formatRuntimeLogLine(
  stream: RuntimeLogStream,
  pid: number | undefined,
  message: string
): string {
  const stamp = new Date().toISOString()
  const pidLabel = typeof pid === 'number' ? `runtime pid=${pid}` : 'runtime'
  const publicMessage = message
    .replace(/^KUN_READY\s+/, 'WORKWISE_RUNTIME_READY ')
    .replace(/\[kun\]/gi, '[runtime]')
    .replace(/("service"\s*:\s*)"kun"/gi, '$1"runtime"')
    .replace(/\bkun runtime\b/gi, 'WorkWise Runtime')
  return `[${stamp}] [${stream.toUpperCase()}] [${pidLabel}] ${publicMessage}\n`
}

function normalizeCapturedChunk(chunk: Buffer | string): string {
  return String(chunk).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function createRuntimeLogCapture(pid: number | undefined): RuntimeLogCapture {
  let stdoutRemainder = ''
  let stderrRemainder = ''
  let closed = false
  let pending = Promise.resolve()

  const writeLine = (stream: RuntimeLogStream, message: string): void => {
    pending = pending
      .then(() => appendManagedLogLine('runtime', formatRuntimeLogLine(stream, pid, message)))
      .catch(() => undefined)
  }

  const captureChunk = (
    stream: 'stdout' | 'stderr',
    chunk: Buffer | string
  ): void => {
    if (closed) return
    const text = normalizeCapturedChunk(chunk)
    const buffered = `${stream === 'stdout' ? stdoutRemainder : stderrRemainder}${text}`
    const parts = buffered.split('\n')
    const remainder = parts.pop() ?? ''
    if (stream === 'stdout') {
      stdoutRemainder = remainder
    } else {
      stderrRemainder = remainder
    }
    for (const part of parts) {
      writeLine(stream, part)
    }
  }

  return {
    captureStdout(chunk) {
      captureChunk('stdout', chunk)
    },
    captureStderr(chunk) {
      captureChunk('stderr', chunk)
    },
    logLifecycle(message) {
      if (closed) return
      writeLine('lifecycle', message)
    },
    async close() {
      if (closed) {
        await pending
        return
      }
      closed = true
      if (stdoutRemainder) {
        writeLine('stdout', stdoutRemainder)
        stdoutRemainder = ''
      }
      if (stderrRemainder) {
        writeLine('stderr', stderrRemainder)
        stderrRemainder = ''
      }
      await pending
    }
  }
}

function appRoot(): string {
  return app.isPackaged
    ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked')
    : app.getAppPath()
}

function splitPathEntries(value: string | undefined): string[] {
  return (value ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function pathEntryKey(entry: string): string {
  return process.platform === 'win32' ? entry.toLowerCase() : entry
}

function uniquePathEntries(entries: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of entries) {
    const key = pathEntryKey(entry)
    if (!entry || seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

function existingNodeVersionBins(root: string, childPath: string[]): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, ...childPath))
      .filter((entry) => existsSync(entry))
  } catch {
    return []
  }
}

function commonMcpToolPathEntries(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string[] {
  const managedToolsBin = join(
    env.WORKWISE_TOOLS_ROOT?.trim() || join(home, '.workwise', 'tools'),
    'bin'
  )
  if (process.platform === 'win32') {
    return [
      managedToolsBin,
      dirname(process.execPath),
      env.APPDATA ? join(env.APPDATA, 'npm') : '',
      env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'nodejs') : '',
      env.ProgramFiles ? join(env.ProgramFiles, 'nodejs') : '',
      env['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'nodejs') : ''
    ].filter(Boolean)
  }

  return [
    managedToolsBin,
    dirname(process.execPath),
    env.NVM_BIN ?? '',
    env.PNPM_HOME ?? '',
    env.VOLTA_HOME ? join(env.VOLTA_HOME, 'bin') : '',
    env.ASDF_DATA_DIR ? join(env.ASDF_DATA_DIR, 'shims') : '',
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    join(home, '.local', 'bin'),
    join(home, '.local', 'node', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.bun', 'bin'),
    ...existingNodeVersionBins(join(home, '.nvm', 'versions', 'node'), ['bin']),
    ...existingNodeVersionBins(join(home, '.nodenv', 'versions'), ['bin']),
    ...existingNodeVersionBins(join(home, '.local', 'share', 'fnm', 'node-versions'), ['installation', 'bin'])
  ].filter(Boolean)
}

export function resolveMcpToolPath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  const currentPath = env.PATH ?? env.Path ?? ''
  return uniquePathEntries([
    ...splitPathEntries(currentPath),
    ...commonMcpToolPathEntries(env, home)
  ]).join(delimiter)
}

function mcpServerEnvWithToolPath(env: Record<string, string>): Record<string, string> {
  const currentPath = env.PATH ?? env.Path
  return {
    ...env,
    [MCP_PATH_ENV_KEY]: uniquePathEntries([
      ...splitPathEntries(currentPath),
      ...splitPathEntries(resolveMcpToolPath())
    ]).join(delimiter)
  }
}

export function resolveManagedRuntimeDataDir(
  runtime: { dataDir: string },
  home = homedir()
): string {
  const trimmed = runtime.dataDir?.trim()
  if (trimmed) return expandHomePath(trimmed, home)
  return defaultManagedRuntimeDataDir()
}

function expandHomePath(path: string, home = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(home, path.slice(2).replace(/\\/g, '/'))
  }
  return path
}

function assertCandidatePath(root: string, name: string, path: string): string {
  if (!isAbsolute(root) || !isAbsolute(path)) {
    throw new Error(`${name} must be absolute in candidate mode.`)
  }
  const candidateRoot = resolve(root)
  const target = resolve(path)
  const rel = relative(candidateRoot, target)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`${name} must stay inside WORKWISE_CANDIDATE_ROOT.`)
  }
  return target
}

export function isManagedRuntimeChildRunning(): boolean {
  return child !== null && child.exitCode === null && child.signalCode === null
}

export type StartManagedRuntimeChildOptions = {
  autoInstallBundledAgentPack?: boolean
  autoInstallBundledSpecialistSkills?: boolean
  candidateRoot?: string
  homeDir?: string
  workwiseHome?: string
  mcpConfigPath?: string
  skillRoots?: string[]
  runtimeToken?: string
  flowSecretStoreKey?: string
}

export function resolveManagedRuntimeForStart(
  settings: AppSettingsV1,
  candidateMode = false,
  runtimeToken?: string
): ManagedRuntimeSettingsV1 {
  const runtime = resolveManagedRuntimeSettings(settings)
  return candidateMode
    ? {
        ...runtime,
        approvalPolicy: 'on-request',
        sandboxMode: 'workspace-write',
        insecure: false,
        runtimeToken: runtimeToken?.trim() || runtime.runtimeToken
      }
    : runtime
}

export async function startManagedRuntimeChild(
  settings: AppSettingsV1,
  options: StartManagedRuntimeChildOptions = {}
): Promise<void> {
  const candidateRoot = options.candidateRoot?.trim()
  const runtime = {
    ...resolveManagedRuntimeForStart(settings, Boolean(candidateRoot), options.runtimeToken),
    // Candidate Runtime deliberately asks the child for an ephemeral port;
    // the persisted settings schema only accepts fixed user-space ports.
    ...(candidateRoot ? { port: 0 } : {})
  }
  if (isManagedRuntimeChildRunning()) return
  if (!runtime.autoStart) return
  actualManagedRuntimePort = null
  if (childLogCapture) {
    await childLogCapture.close()
    childLogCapture = null
  }
  const root = appRoot()
  const resolution = resolveManagedRuntimeExecutable(root, runtime.binaryPath)
  if (resolution.command === process.execPath && !existsSync(resolution.args[0])) {
    throw new Error(
      `WorkWise Runtime build is missing at ${resolution.args[0]}. Reinstall WorkWise or rebuild the bundled runtime.`
    )
  }
  const homeDir = candidateRoot
    ? assertCandidatePath(candidateRoot, 'candidate Runtime home', options.homeDir ?? '')
    : options.homeDir ?? homedir()
  const workwiseHome = candidateRoot
    ? assertCandidatePath(candidateRoot, 'candidate WorkWise home', options.workwiseHome ?? '')
    : options.workwiseHome ?? join(homeDir, '.workwise')
  const dataDir = candidateRoot
    ? assertCandidatePath(candidateRoot, 'candidate Runtime data directory', join(workwiseHome, 'runtime'))
    : resolveManagedRuntimeDataDir(runtime, homeDir)
  const mcpConfigPath = candidateRoot
    ? assertCandidatePath(
        candidateRoot,
        'candidate MCP config',
        options.mcpConfigPath ?? join(workwiseHome, 'mcp.json')
      )
    : options.mcpConfigPath
  await ensureBundledAgentPackForRuntime(options)
  await ensureBundledSpecialistSkillsForRuntime(options)
  const mcpV2 = await new McpConfigService(candidateRoot ? {
    manifestPath: join(workwiseHome, 'mcp-v2.json'),
    legacyPath: mcpConfigPath,
    credentialRoot: join(workwiseHome, 'credentials', 'mcp')
  } : {}).runtimeSnapshot()
  await syncManagedRuntimeConfig(dataDir, runtime, {
    mcpConfigPath,
    mcpV2Servers: mcpV2.servers,
    skillRoots: options.skillRoots,
    scheduleMcp: {
      settings,
      launch: {
        appPath: app.getAppPath(),
        execPath: process.execPath,
        isPackaged: app.isPackaged
      }
    }
  })
  lastResolvedBinary = resolution.command === process.execPath
    ? resolution.args.join(' ')
    : resolution.command
  const args = buildManagedRuntimeServeArgs({
    resolution,
    host: '127.0.0.1',
    port: runtime.port,
    dataDir,
    baseUrl: runtime.baseUrl,
    endpointFormat: runtime.endpointFormat,
    model: runtime.model,
    approvalPolicy: runtime.approvalPolicy,
    sandboxMode: runtime.sandboxMode,
    tokenEconomyMode: runtime.tokenEconomyMode,
    insecure: isManagedRuntimeInsecure(runtime)
  })
  const pptMasterSidecarExecutable = resolvePptMasterSidecarExecutable()
  const flowSecretStoreKey = options.flowSecretStoreKey ?? await loadOrCreateFlowSecretStoreKey()
  child = await safeSpawn(resolution.command, args, {
    env: {
      ...process.env,
      ...mcpV2.environment,
      [MCP_PATH_ENV_KEY]: resolveMcpToolPath(process.env, homeDir),
      ELECTRON_RUN_AS_NODE: '1',
      WORKWISE_RUNTIME_TOKEN: runtime.runtimeToken,
      WORKWISE_FLOW_SECRET_STORE_KEY: flowSecretStoreKey ?? '',
      WORKWISE_PPT_MASTER_ROOT: resolveBundledSkillDirectory('ppt-master') || '',
      // Packaged clients require the frozen sidecar. Development builds may
      // intentionally omit it and must retain the audited Python fallback.
      WORKWISE_PPT_MASTER_SIDECAR: existsSync(pptMasterSidecarExecutable)
        ? pptMasterSidecarExecutable
        : '',
      // Managed Python interpreter for full-access workspaces that need to run
      // upstream PPT Master scripts directly (project_manager, quality checker).
      WORKWISE_PPT_MASTER_PYTHON: join(
        workwiseHome,
        'ppt-master-python',
        process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
      ),
      DEEPSEEK_API_KEY: runtime.apiKey || process.env.DEEPSEEK_API_KEY || '',
      WORKWISE_DEFAULT_MODEL_PROVIDER_ID: runtime.providerId,
      WORKWISE_MODEL_PROVIDERS_SECRET: JSON.stringify(getModelProviderSettings(settings).providers.map(provider => ({
        id: provider.id, baseUrl: provider.id === runtime.providerId ? runtime.baseUrl : provider.baseUrl,
        apiKey: provider.id === runtime.providerId ? runtime.apiKey || process.env.DEEPSEEK_API_KEY || '' : provider.apiKey,
        endpointFormat: provider.id === runtime.providerId ? runtime.endpointFormat : provider.endpointFormat,
        model: provider.id === runtime.providerId ? runtime.model : provider.models[0] || runtime.model
      })))
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    workspaceRoot: homeDir
  })
  const startedChild = child
  const startedLogCapture = createRuntimeLogCapture(startedChild.pid)
  childLogCapture = startedLogCapture
  startedLogCapture.logLifecycle(`spawned on port ${runtime.port} using data dir ${dataDir}`)
  startedChild.stdout?.on('data', startedLogCapture.captureStdout)
  startedChild.stderr?.on('data', startedLogCapture.captureStderr)
  child.on('exit', (code, signal) => {
    startedLogCapture.logLifecycle(
      signal
        ? `exited with signal ${signal}`
        : `exited with code ${code ?? 'unknown'}`
    )
    void startedLogCapture.close()
    if (child === startedChild) {
      child = null
      actualManagedRuntimePort = null
    }
  })
  child.on('error', (error) => {
    startedLogCapture.logLifecycle(
      `process error: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  try {
    const readyPort = await waitForRuntimeStartup(startedChild, runtime.port)
    actualManagedRuntimePort = runtime.port === 0 ? readyPort : null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    startedLogCapture.logLifecycle(`startup failed before ready: ${message}`)
    if (child === startedChild) {
      await stopManagedRuntimeChildAndWait()
    }
    throw error
  }
  startedLogCapture.logLifecycle(`ready marker received on port ${actualManagedRuntimePort ?? runtime.port}`)
}

export function getManagedRuntimeActualPort(): number | null {
  return actualManagedRuntimePort
}

async function ensureBundledAgentPackForRuntime(options: StartManagedRuntimeChildOptions): Promise<void> {
  if (options.autoInstallBundledAgentPack === false) return
  const result = await installBundledAgentPack({ id: METRO_MONITORING_AGENT_PACK_ID })
  const message = result.ok
    ? `bundled agent pack ${METRO_MONITORING_AGENT_PACK_ID} available at ${result.rootPath} (${result.installedAssets} assets)`
    : `bundled agent pack ${METRO_MONITORING_AGENT_PACK_ID} could not be installed: ${result.message}`
  await appendManagedLogLine('runtime', formatRuntimeLogLine('lifecycle', undefined, message)).catch(() => undefined)
}

const AUTO_INSTALLED_SPECIALIST_SKILLS = [
  { id: 'tender-master', skillName: 'tender-master' },
  { id: 'document-illustrator', skillName: 'document-illustrator' },
  { id: 'rail-any-station-control-network', skillName: 'rail-any-station-control-network' }
] as const

async function ensureBundledSpecialistSkillsForRuntime(
  options: StartManagedRuntimeChildOptions
): Promise<void> {
  if (
    options.autoInstallBundledSpecialistSkills === false
    || (
      options.autoInstallBundledSpecialistSkills === undefined
      && options.autoInstallBundledAgentPack === false
    )
  ) return
  const root = join(options.workwiseHome ?? join(homedir(), '.workwise'), 'skills')
  for (const source of AUTO_INSTALLED_SPECIALIST_SKILLS) {
    const result = await installBundledSkill(root, source)
    const message = result.ok
      ? `bundled Skill ${source.id} available at ${result.path}`
      : `bundled Skill ${source.id} could not be installed: ${result.message}`
    await appendManagedLogLine(
      'runtime',
      formatRuntimeLogLine('lifecycle', undefined, message)
    ).catch(() => undefined)
  }
}

export async function syncManagedRuntimeConfig(
  dataDir: string,
  runtime: Pick<
    ManagedRuntimeSettingsV1,
    'mcpSearch' | 'tokenEconomy' | 'storage' | 'contextCompaction' | 'runtimeTuning' | 'imageGeneration' | 'visionEvidence'
  > & Partial<Pick<ManagedRuntimeSettingsV1, 'baseUrl' | 'model'>>,
  options?: {
    scheduleMcp?: {
      settings: AppSettingsV1
      launch: ClawScheduleMcpLaunchConfig
    }
    mcpConfigPath?: string
    mcpV2Servers?: Record<string, Record<string, unknown>>
    skillRoots?: string[]
  }
): Promise<void> {
  const configPath = join(dataDir, 'config.json')
  const existing = sanitizeRuntimeConfigSections(await readJsonObjectIfExists(configPath))
  const importedMcpServers = {
    ...(await readGuiManagedMcpServers(options?.mcpConfigPath ?? resolveRuntimeMcpJsonPath())),
    ...(options?.mcpV2Servers ?? {})
  }
  const hasImportedEnabledMcpServer = Object.values(importedMcpServers).some(
    (server) => objectValue(server).enabled !== false
  )

  const serve = objectValue(existing?.serve)
  const existingTokenEconomy = objectValue(serve.tokenEconomy)
  const existingContextCompaction = objectValue(existing?.contextCompaction)
  const existingModels = objectValue(existing?.models)
  const existingRuntimeTuning = objectValue(existing?.runtime)
  const capabilities = objectValue(existing?.capabilities)
  const mcp = objectValue(capabilities.mcp)
  const search = objectValue(mcp.search)
  const attachments = objectValue(capabilities.attachments)
  const web = objectValue(capabilities.web)
  const skills = objectValue(capabilities.skills)
  const imageGen = objectValue(capabilities.imageGen)
  const storage = storageConfigForRuntime(runtime.storage)
  const mcpSearch = runtime.mcpSearch
  const skillCapability = await skillCapabilityConfigForRuntime(
    skills,
    options?.scheduleMcp?.settings,
    options?.skillRoots
  )
  const managedDeepSeekSearch = Boolean(
    runtime.baseUrl &&
    runtime.model &&
    isOfficialDeepSeekBaseUrl(runtime.baseUrl) &&
    /^deepseek-(?:flash|v4-(?:pro|flash))$/i.test(runtime.model)
  )
  const next = {
    serve: {
      ...serve,
      storage,
      tokenEconomy: tokenEconomyConfigForRuntime(runtime.tokenEconomy, existingTokenEconomy)
    },
    models: modelConfigForRuntime(existingModels),
    contextCompaction: contextCompactionConfigForRuntime(runtime.contextCompaction, existingContextCompaction),
    runtime: runtimeTuningConfigForRuntime(runtime.runtimeTuning, existingRuntimeTuning),
    visionEvidence: {
      enabled: runtime.visionEvidence.enabled,
      endpoint: runtime.visionEvidence.endpoint,
      timeoutMs: runtime.visionEvidence.timeoutMs,
      analyzer: runtime.visionEvidence.analyzer
    },
    capabilities: {
      ...capabilities,
      attachments: {
        ...attachments,
        enabled: attachments.enabled === false ? false : true,
        ...(usesHistoricalDefaultAttachmentMimeTypes(attachments.allowedMimeTypes)
          ? { allowedMimeTypes: [...HISTORICAL_DEFAULT_ATTACHMENT_MIME_TYPES, 'image/gif'] }
          : {})
      },
      web: {
        ...web,
        enabled: web.enabled === false ? false : true,
        fetchEnabled: web.fetchEnabled === false ? false : true,
        ...(managedDeepSeekSearch
          ? {
              searchEnabled: true,
              provider: 'deepseek-responses'
            }
          : {})
      },
      skills: skillCapability,
      imageGen: imageGenConfigForRuntime(runtime.imageGeneration, imageGen),
      mcp: {
        ...mcp,
        ...(options?.scheduleMcp || mcpSearch.enabled || hasImportedEnabledMcpServer
          ? { enabled: mcp.enabled === false ? false : true }
          : {}),
        servers: {
          ...objectValue(mcp.servers),
          ...importedMcpServers,
          ...(options?.scheduleMcp
          ? {
              [GUI_SCHEDULE_MCP_SERVER_NAME]: buildGuiScheduleRuntimeMcpServer(
                options.scheduleMcp.settings,
                options.scheduleMcp.launch
              )
            }
          : {})
        },
        search: {
          ...search,
          enabled: mcpSearch.enabled,
          mode: mcpSearch.mode,
          autoThresholdToolCount: mcpSearch.autoThresholdToolCount,
          topKDefault: mcpSearch.topKDefault,
          topKMax: mcpSearch.topKMax,
          minScore: mcpSearch.minScore
        }
      }
    }
  }
  const parsedNext = InternalRuntimeConfigSchema.safeParse(next)
  if (!parsedNext.success) {
    throw new Error(
      `Refusing to write invalid WorkWise Runtime config at ${configPath}: ${JSON.stringify(parsedNext.error.issues, null, 2)}`
    )
  }
  const nextText = `${JSON.stringify(next, null, 2)}\n`
  if (existing && nextText === `${JSON.stringify(existing, null, 2)}\n`) return
  await mkdir(dirname(configPath), { recursive: true })
  await durableWriteFile(configPath, nextText)
}

function usesHistoricalDefaultAttachmentMimeTypes(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== HISTORICAL_DEFAULT_ATTACHMENT_MIME_TYPES.length) {
    return false
  }
  const actual = new Set(value.filter((item): item is string => typeof item === 'string'))
  return actual.size === HISTORICAL_DEFAULT_ATTACHMENT_MIME_TYPES.length &&
    HISTORICAL_DEFAULT_ATTACHMENT_MIME_TYPES.every((mimeType) => actual.has(mimeType))
}

function buildGuiScheduleRuntimeMcpServer(
  settings: AppSettingsV1,
  launch: ClawScheduleMcpLaunchConfig
): Record<string, unknown> {
  return {
    enabled: true,
    transport: 'stdio',
    command: resolveClawScheduleMcpCommand(launch),
    args: buildClawScheduleMcpArgs(settings, launch),
    env: {
      ELECTRON_RUN_AS_NODE: '1'
    },
    trustScope: 'user',
    timeoutMs: GUI_SCHEDULE_MCP_TIMEOUT_MS
  }
}

async function skillCapabilityConfigForRuntime(
  existing: Record<string, unknown>,
  settings?: AppSettingsV1,
  explicitRoots?: string[]
): Promise<Record<string, unknown>> {
  const roots = explicitRoots
    ? uniqueStrings(explicitRoots.map(normalizeSkillRootPath))
    : uniqueStrings([
        ...stringArrayValue(existing.roots).map(normalizeSkillRootPath),
        ...(await guiSkillRootsForRuntime(settings)).map((root) => root.path)
      ])
  return {
    ...existing,
    enabled: existing.enabled === false ? false : roots.length > 0 || existing.enabled === true,
    roots,
    legacySkillMd: existing.legacySkillMd === false ? false : true
  }
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

async function readGuiManagedMcpServers(path: string): Promise<Record<string, unknown>> {
  const parsed = await readJsonObjectIfExists(path)
  if (!parsed) return {}

  const rawServers = mcpServersFromGuiConfig(parsed)
  const normalizedEntries = Object.entries(rawServers)
    .map(([serverId, server]) => {
      const normalized = normalizeGuiManagedMcpServer(serverId, server)
      return normalized ? [serverId, normalized] as const : null
    })
    .filter((entry): entry is readonly [string, Record<string, unknown>] => entry !== null)

  return Object.fromEntries(normalizedEntries)
}

function mcpServersFromGuiConfig(config: Record<string, unknown>): Record<string, unknown> {
  const directServers = objectValue(config.servers)
  if (Object.keys(directServers).length > 0) return directServers

  const capabilities = objectValue(config.capabilities)
  const mcp = objectValue(capabilities.mcp)
  return objectValue(mcp.servers)
}

function normalizeGuiManagedMcpServer(serverId: string, server: unknown): Record<string, unknown> | null {
  const raw = objectValue(server)
  const rawCommand = scalarStringValue(raw.command)
  const url = scalarStringValue(raw.url)
  const rawArgs = stringArrayValue(raw.args)
  const headers = stringRecordValue(raw.headers)
  const env = stringRecordValue(raw.env)
  const known = normalizeKnownGuiManagedMcpServer(serverId, rawCommand, rawArgs, env)
  const command = known.command
  const args = known.args
  const transport = normalizeMcpTransport(raw.transport, command, url)
  if (!transport) return null

  const trustedWorkspaceRoots = stringArrayValue(raw.trustedWorkspaceRoots)
  const trustScope = normalizeMcpTrustScope(raw.trustScope, trustedWorkspaceRoots)
  if (trustScope === 'workspace' && trustedWorkspaceRoots.length === 0) return null

  const timeoutMs = positiveIntegerValue(raw.timeoutMs)
  const serverEnv = transport === 'stdio' ? mcpServerEnvWithToolPath(env) : env
  const parsed = McpServerConfig.safeParse({
    enabled: known.forceDisabled || raw.enabled === false || raw.disabled === true ? false : true,
    transport,
    ...(command ? { command } : {}),
    ...(args.length > 0 ? { args } : {}),
    ...(url ? { url } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(serverEnv).length > 0 ? { env: serverEnv } : {}),
    trustScope,
    ...(trustedWorkspaceRoots.length > 0 ? { trustedWorkspaceRoots } : {}),
    ...(timeoutMs ? { timeoutMs } : {})
  })

  return parsed.success ? objectValue(parsed.data) : null
}

function normalizeKnownGuiManagedMcpServer(
  serverId: string,
  command: string | undefined,
  args: string[],
  env: Record<string, string>
): { command: string | undefined; args: string[]; forceDisabled: boolean } {
  let nextCommand = command
  let nextArgs = args
  const id = serverId.trim().toLowerCase()
  const packageNames = args.map((arg) => arg.trim().toLowerCase())

  if (
    (id === 'puppeteer' || packageNames.some((name) => name.startsWith('@modelcontextprotocol/server-puppeteer'))) &&
    command?.trim().toLowerCase() === 'puppeteer'
  ) {
    nextCommand = 'npx'
    nextArgs = args.length > 0 ? args : ['-y', '@modelcontextprotocol/server-puppeteer']
  }

  return {
    command: nextCommand,
    args: nextArgs,
    forceDisabled:
      shouldDisableKnownFilesystemMcp(id, nextCommand, nextArgs) ||
      shouldDisableKnownGithubMcp(id, nextCommand, nextArgs, env) ||
      shouldDisablePlaceholderCredentialMcp(id, nextCommand, nextArgs, env)
  }
}

function shouldDisablePlaceholderCredentialMcp(
  id: string,
  command: string | undefined,
  args: string[],
  env: Record<string, string>
): boolean {
  if (!command?.trim()) return false
  const normalizedArgs = args.map((arg) => arg.trim().toLowerCase()).filter(Boolean)
  const knownExternalMcp =
    id === 'brave-search' ||
    id === 'slack' ||
    normalizedArgs.some((arg) =>
      arg.includes('server-brave-search') ||
      arg.includes('server-slack')
    )
  if (!knownExternalMcp) return false
  return Object.entries(env).some(([key, value]) => {
    const normalizedKey = key.toLowerCase()
    if (!/(token|api[_-]?key|secret|password|team[_-]?id)/.test(normalizedKey)) return false
    const trimmed = value.trim()
    return !trimmed || /^\$\{[^}]+\}$/.test(trimmed)
  })
}

function shouldDisableKnownGithubMcp(
  id: string,
  command: string | undefined,
  args: string[],
  env: Record<string, string>
): boolean {
  const normalizedCommand = command?.trim().toLowerCase() ?? ''
  const normalizedArgs = args.map((arg) => arg.trim().toLowerCase()).filter(Boolean)
  const isGithub =
    id === 'github' ||
    normalizedArgs.some((arg) =>
      arg.startsWith('@modelcontextprotocol/server-github') ||
      arg.startsWith('@github/github-mcp-server') ||
      arg === 'github-mcp-server'
    )
  if (!isGithub || !normalizedCommand) return false
  if (
    !Object.prototype.hasOwnProperty.call(env, 'GITHUB_PERSONAL_ACCESS_TOKEN') &&
    !Object.prototype.hasOwnProperty.call(env, 'GITHUB_TOKEN')
  ) {
    return false
  }
  const token = (env.GITHUB_PERSONAL_ACCESS_TOKEN ?? env.GITHUB_TOKEN ?? '').trim()
  return !token || /^\$\{[^}]+\}$/.test(token)
}

function shouldDisableKnownFilesystemMcp(
  id: string,
  command: string | undefined,
  args: string[]
): boolean {
  const normalizedCommand = command?.trim().toLowerCase() ?? ''
  const normalizedArgs = args.map((arg) => arg.trim()).filter(Boolean)
  const isFilesystem =
    id === 'filesystem' ||
    normalizedArgs.some((arg) => arg.toLowerCase().startsWith('@modelcontextprotocol/server-filesystem'))
  if (!isFilesystem || !normalizedCommand) return false

  const roots = normalizedArgs
    .filter((arg) => !arg.startsWith('-'))
    .filter((arg) => !arg.toLowerCase().startsWith('@modelcontextprotocol/server-filesystem'))
  if (roots.length === 0) return true
  return roots.some((root) => {
    if (root === '/path/to/project' || root === '/path/to/workspace') return true
    return !existsSync(expandHomePath(root))
  })
}

function normalizeMcpTransport(
  value: unknown,
  command: string | undefined,
  url: string | undefined
): 'stdio' | 'streamable-http' | 'sse' | null {
  if (value === 'stdio' || value === 'streamable-http' || value === 'sse') return value
  if (command) return 'stdio'
  if (url) return 'streamable-http'
  return null
}

function normalizeMcpTrustScope(
  value: unknown,
  trustedWorkspaceRoots: string[]
): 'user' | 'workspace' {
  if (value === 'user' || value === 'workspace') return value
  return trustedWorkspaceRoots.length > 0 ? 'workspace' : 'user'
}

function scalarStringValue(value: unknown): string | undefined {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : undefined
}

function stringRecordValue(value: unknown): Record<string, string> {
  const record = objectValue(value)
  const next: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    const normalized = scalarStringValue(item)
    if (normalized !== undefined) next[key] = normalized
  }
  return next
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function modelConfigForRuntime(existing: Record<string, unknown>): Record<string, unknown> {
  const existingProfiles = objectValue(existing.profiles)
  const profiles: Record<string, unknown> = { ...DEFAULT_MANAGED_RUNTIME_MODEL_PROFILES }
  for (const [modelId, profile] of Object.entries(existingProfiles)) {
    const defaultProfile = objectValue(DEFAULT_MANAGED_RUNTIME_MODEL_PROFILES[modelId])
    const existingProfile = objectValue(profile)
    profiles[modelId] = {
      ...defaultProfile,
      ...existingProfile,
      contextCompaction: {
        ...objectValue(defaultProfile.contextCompaction),
        ...objectValue(existingProfile.contextCompaction)
      }
    }
  }
  return {
    ...existing,
    profiles
  }
}

function tokenEconomyConfigForRuntime(
  tokenEconomy: Pick<ManagedRuntimeSettingsV1, 'tokenEconomy'>['tokenEconomy'] | undefined,
  existing: Record<string, unknown>
): Record<string, unknown> {
  const defaults = defaultManagedRuntimeTokenEconomySettings()
  const normalized = {
    ...defaults,
    ...(tokenEconomy ?? {}),
    historyHygiene: {
      ...defaults.historyHygiene,
      ...(tokenEconomy?.historyHygiene ?? {})
    }
  }
  const existingHistoryHygiene = objectValue(existing.historyHygiene)
  return {
    ...existing,
    enabled: normalized.enabled,
    compressToolDescriptions: normalized.compressToolDescriptions,
    compressToolResults: normalized.compressToolResults,
    conciseResponses: normalized.conciseResponses,
    historyHygiene: {
      ...existingHistoryHygiene,
      maxToolResultLines: normalized.historyHygiene.maxToolResultLines,
      maxToolResultBytes: normalized.historyHygiene.maxToolResultBytes,
      maxToolResultTokens: normalized.historyHygiene.maxToolResultTokens,
      maxToolArgumentStringBytes: normalized.historyHygiene.maxToolArgumentStringBytes,
      maxToolArgumentStringTokens: normalized.historyHygiene.maxToolArgumentStringTokens,
      maxArrayItems: normalized.historyHygiene.maxArrayItems
    }
  }
}

function storageConfigForRuntime(
  storage: Pick<ManagedRuntimeSettingsV1, 'storage'>['storage']
): Record<string, unknown> {
  const sqlitePath = storage.sqlitePath.trim()
  return {
    backend: storage.backend,
    ...(sqlitePath ? { sqlitePath } : {})
  }
}

function contextCompactionConfigForRuntime(
  contextCompaction: Pick<ManagedRuntimeSettingsV1, 'contextCompaction'>['contextCompaction'],
  existing: Record<string, unknown>
): Record<string, unknown> {
  return {
    ...existing,
    defaultSoftThreshold: contextCompaction.defaultSoftThreshold,
    defaultHardThreshold: contextCompaction.defaultHardThreshold,
    summaryMode: contextCompaction.summaryMode,
    summaryTimeoutMs: contextCompaction.summaryTimeoutMs,
    summaryMaxTokens: contextCompaction.summaryMaxTokens,
    summaryInputMaxBytes: contextCompaction.summaryInputMaxBytes
  }
}

function imageGenConfigForRuntime(
  imageGeneration: Pick<ManagedRuntimeSettingsV1, 'imageGeneration'>['imageGeneration'],
  existing: Record<string, unknown>
): Record<string, unknown> {
  // GUI settings own these fields: cleared values must be removed from the
  // config (the zod schema rejects empty strings), while unknown hand-edited
  // keys like maxReferenceImages are preserved via the spread.
  const next: Record<string, unknown> = {
    ...existing,
    enabled: imageGeneration.enabled,
    timeoutMs: imageGeneration.timeoutMs
  }
  const fields = {
    protocol: imageGeneration.protocol,
    baseUrl: imageGeneration.baseUrl,
    apiKey: imageGeneration.apiKey,
    model: imageGeneration.model,
    defaultSize: imageGeneration.defaultSize
  }
  for (const [key, value] of Object.entries(fields)) {
    const trimmed = value.trim()
    if (trimmed) next[key] = trimmed
    else delete next[key]
  }
  return next
}

function runtimeTuningConfigForRuntime(
  runtimeTuning: Pick<ManagedRuntimeSettingsV1, 'runtimeTuning'>['runtimeTuning'],
  existing: Record<string, unknown>
): Record<string, unknown> {
  const existingToolStorm = objectValue(existing.toolStorm)
  const existingToolArgumentRepair = objectValue(existing.toolArgumentRepair)
  return {
    ...existing,
    toolStorm: {
      ...existingToolStorm,
      enabled: runtimeTuning.toolStorm.enabled,
      windowSize: runtimeTuning.toolStorm.windowSize,
      threshold: runtimeTuning.toolStorm.threshold
    },
    toolArgumentRepair: {
      ...existingToolArgumentRepair,
      maxStringBytes: runtimeTuning.toolArgumentRepair.maxStringBytes
    }
  }
}

async function readJsonObjectIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text) as unknown
    return objectValue(parsed)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SyntaxError) return null
    throw error
  }
}

type SafeParseSchema = {
  safeParse: (value: unknown) =>
    | { success: true; data: unknown }
    | { success: false }
}

function parseRuntimeConfigSection(
  schema: SafeParseSchema,
  value: unknown
): Record<string, unknown> {
  const parsed = schema.safeParse(objectValue(value))
  return parsed.success ? objectValue(value) : {}
}

function sanitizeRuntimeCapabilitiesConfig(value: unknown): Record<string, unknown> {
  const raw = objectValue(value)
  const next: Record<string, unknown> = {}
  if ('mcp' in raw) next.mcp = parseRuntimeConfigSection(McpCapabilityConfig, raw.mcp)
  if ('web' in raw) next.web = parseRuntimeConfigSection(WebCapabilityConfig, raw.web)
  if ('skills' in raw) next.skills = parseRuntimeConfigSection(SkillsCapabilityConfig, raw.skills)
  if ('subagents' in raw) {
    next.subagents = parseRuntimeConfigSection(SubagentsCapabilityConfig, raw.subagents)
  }
  if ('attachments' in raw) {
    next.attachments = parseRuntimeConfigSection(AttachmentsCapabilityConfig, raw.attachments)
  }
  if ('memory' in raw) next.memory = parseRuntimeConfigSection(MemoryCapabilityConfig, raw.memory)
  if ('imageGen' in raw) next.imageGen = parseRuntimeConfigSection(ImageGenCapabilityConfig, raw.imageGen)
  return next
}

function sanitizeRuntimeConfigSections(
  existing: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!existing) return null
  return {
    serve: parseRuntimeConfigSection(InternalRuntimeServeConfigSchema, existing.serve),
    models: parseRuntimeConfigSection(ModelConfigSchema, existing.models),
    contextCompaction: parseRuntimeConfigSection(
      ContextCompactionConfigSchema,
      existing.contextCompaction
    ),
    runtime: parseRuntimeConfigSection(RuntimeTuningConfigSchema, existing.runtime),
    visionEvidence: parseRuntimeConfigSection(VisionEvidenceConfigSchema, existing.visionEvidence),
    capabilities: sanitizeRuntimeCapabilitiesConfig(existing.capabilities)
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export async function stopManagedRuntimeChildAndWait(): Promise<void> {
  if (!child) {
    actualManagedRuntimePort = null
    if (childLogCapture) {
      const capture = childLogCapture
      childLogCapture = null
      await capture.close()
    }
    return
  }
  const stoppingChild = child
  const pid = child.pid
  const capture = childLogCapture
  if (stoppingChild.exitCode === null && stoppingChild.signalCode === null) {
    try {
      stoppingChild.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  const exited = await waitForChildExit(stoppingChild, RUNTIME_STOP_GRACE_MS)
  if (!exited) {
    try {
      if (pid) process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
    await waitForChildExit(stoppingChild, RUNTIME_STOP_FORCE_MS)
  }
  if (child === stoppingChild) child = null
  actualManagedRuntimePort = null
  if (capture) {
    childLogCapture = null
    await capture.close()
  }
}

function waitForChildExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => settle(false), timeoutMs)
    const settle = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.removeListener('exit', onExit)
      process.removeListener('error', onError)
      resolve(exited)
    }
    const onExit = (): void => settle(true)
    const onError = (): void => settle(true)
    process.once('exit', onExit)
    process.once('error', onError)
  })
}

export async function reclaimManagedRuntimePort(
  port: number
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (port <= 0) return { ok: true }
  const available = await canBindTcpPort(port, '127.0.0.1')
  return available
    ? { ok: true }
    : { ok: false, message: `port ${port} is in use` }
}

function canBindTcpPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const server = createServer()
    const settle = (available: boolean): void => {
      if (settled) return
      settled = true
      server.removeAllListeners('error')
      resolve(available)
    }
    server.unref()
    server.once('error', () => settle(false))
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => settle(true))
    })
  })
}

async function waitForRuntimeStartup(startedChild: ChildProcess, port?: number): Promise<number> {
  if (startedChild.exitCode !== null) {
    throw new Error(describeRuntimeExit(startedChild.exitCode, null))
  }
  return await new Promise<number>((resolve, reject) => {
    let settled = false
    let stdoutBuffer = ''
    let stderrTail = ''
    let healthProbeInFlight = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(describeRuntimeStartupTimeout(stderrTail)))
    }, RUNTIME_STARTUP_TIMEOUT_MS)
    // The stdout ready marker can lag behind the actual server (pipe
    // buffering) or get lost in unusual spawn environments; the HTTP
    // health endpoint is the ground truth, so poll it in parallel.
    const healthTimer = port
      ? setInterval(() => {
          if (settled || healthProbeInFlight) return
          healthProbeInFlight = true
          void probeRuntimeHealth(port)
            .then((healthy) => {
              if (healthy && port > 0) settleReady(port)
            })
            .finally(() => {
              healthProbeInFlight = false
            })
        }, RUNTIME_STARTUP_HEALTH_POLL_MS)
      : null
    const cleanup = (): void => {
      clearTimeout(timer)
      if (healthTimer) clearInterval(healthTimer)
      startedChild.removeListener('exit', onExit)
      startedChild.removeListener('error', onError)
      startedChild.stdout?.removeListener('data', onStdout)
      startedChild.stderr?.removeListener('data', onStderr)
    }
    const parseReadyPort = (): number | null => {
      const markerIndex = stdoutBuffer.indexOf(RUNTIME_READY_PREFIX)
      if (markerIndex < 0) return null
      const afterPrefix = stdoutBuffer.slice(markerIndex + RUNTIME_READY_PREFIX.length)
      const newlineIndex = afterPrefix.indexOf('\n')
      if (newlineIndex < 0) return null
      const jsonLine = afterPrefix.slice(0, newlineIndex).trim()
      if (!jsonLine) return null
      try {
        const parsed = JSON.parse(jsonLine) as { service?: string; mode?: string; port?: number }
        return parsed.service === 'kun' && parsed.mode === 'serve' && typeof parsed.port === 'number' && parsed.port > 0
          ? parsed.port
          : null
      } catch {
        return null
      }
    }
    const settleReady = (actualPort: number): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(actualPort)
    }
    const onStdout = (chunk: Buffer | string): void => {
      stdoutBuffer = appendTail(stdoutBuffer, String(chunk), STDERR_TAIL_MAX_CHARS * 2)
      const actualPort = parseReadyPort()
      if (actualPort !== null) settleReady(actualPort)
    }
    const onStderr = (chunk: Buffer | string): void => {
      stderrTail = appendTail(stderrTail, String(chunk))
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(describeRuntimeExit(code, signal, stderrTail)))
    }
    const onError = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    startedChild.stdout?.on('data', onStdout)
    startedChild.stderr?.on('data', onStderr)
    startedChild.once('exit', onExit)
    startedChild.once('error', onError)
  })
}

function describeRuntimeExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail = ''
): string {
  const suffix = stderrTail.trim() ? `\n${stderrTail.trim()}` : ''
  if (signal) return `WorkWise Runtime exited during startup with signal ${signal}${suffix}`
  if (typeof code === 'number') return `WorkWise Runtime exited during startup with code ${code}${suffix}`
  return `WorkWise Runtime exited during startup${suffix}`
}

function describeRuntimeStartupTimeout(stderrTail: string): string {
  const suffix = stderrTail.trim() ? `\n${stderrTail.trim()}` : ''
  return `WorkWise Runtime did not report ready within ${RUNTIME_STARTUP_TIMEOUT_MS}ms${suffix}`
}

async function probeRuntimeHealth(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(RUNTIME_STARTUP_HEALTH_REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) return false
    return isRuntimeHealthResponseBody(await response.text())
  } catch {
    return false
  }
}
