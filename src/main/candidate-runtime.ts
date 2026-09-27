import { mkdirSync, readFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { AppSettingsPatch } from '../shared/app-settings'
import { isRuntimeHealthResponseBody } from './runtime-health'

export const UNCONFIGURED_RECOVERY_CANDIDATE_EXIT_CODE = 78

export type CandidateRuntimePaths = {
  root: string
  userData: string
  cache: string
  sessionData: string
  crashDumps: string
  logs: string
  home: string
  workwiseHome: string
  toolsRoot: string
}

export type CandidateServicePorts = {
  runtime: number
  schedule: number
  im: number
}

export type CandidateServiceReservations = {
  ports: CandidateServicePorts
  scheduleServer: HttpServer
  imServer: HttpServer
  close: () => Promise<void>
}

const USER_DATA_ARG = '--user-data-dir='
const CANDIDATE_ENV_FILE_ARG = '--workwise-candidate-env-file='
const CANDIDATE_BUNDLE_IDENTIFIER = 'com.wangjiawei508.workwise.imcandidate.recovery'
const CANDIDATE_BUNDLE_NAME = 'WorkWise IM Recovery Candidate.app'
const SOURCE_HEAD_CANDIDATE_BUNDLE_PATTERN = /^(?:WorkWise|RailWise AI) Candidate [0-9a-f]{12}\.app$/i
const SOURCE_HEAD_CANDIDATE_IDENTIFIER_PATTERN = /^com\.wangjiawei508\.workwise\.candidate\.head[0-9a-f]{12}$/i
const CANDIDATE_ENV_KEYS = new Set([
  'WORKWISE_CANDIDATE',
  'WORKWISE_CANDIDATE_ROOT',
  'WORKWISE_CANDIDATE_USER_DATA',
  'WORKWISE_CANDIDATE_CACHE',
  'WORKWISE_CANDIDATE_LOGS',
  'WORKWISE_CANDIDATE_HOME',
  'WORKWISE_TOOLS_ROOT',
  'WORKWISE_CANDIDATE_OUTBOUND_DISABLED',
  'WORKWISE_CANDIDATE_OUTBOUND_PROVIDER',
  'WORKWISE_CANDIDATE_INBOUND_DISABLED',
  'WORKWISE_CANDIDATE_INBOUND_PROVIDER',
  'WORKWISE_CANDIDATE_ALLOWED_FEISHU_CHAT_ID',
  'WORKWISE_CANDIDATE_ALLOWED_FEISHU_COMMAND',
  'WORKWISE_CANDIDATE_ALLOWED_WEIXIN_CHAT_ID',
  'WORKWISE_CANDIDATE_ALLOWED_WEIXIN_COMMAND',
  'WORKWISE_CANDIDATE_CREDENTIAL_HELPER',
  'WORKWISE_CANDIDATE_CREDENTIAL_ACCESS'
])

export function candidateServicePortPatch(ports: CandidateServicePorts): AppSettingsPatch {
  const values = [ports.runtime, ports.schedule, ports.im]
  if (
    !Number.isInteger(ports.runtime) ||
    (ports.runtime !== 0 && (ports.runtime < 1_024 || ports.runtime > 65_535)) ||
    !Number.isInteger(ports.schedule) || ports.schedule < 1_024 || ports.schedule > 65_535 ||
    !Number.isInteger(ports.im) || ports.im < 1_024 || ports.im > 65_535
  ) {
    throw new Error('Candidate service ports must be valid user-space TCP ports.')
  }
  if (new Set(values).size !== values.length) {
    throw new Error('Candidate service ports must be distinct.')
  }
  return {
    agents: { kun: { port: ports.runtime } },
    schedule: { internal: { port: ports.schedule } },
    claw: { im: { port: ports.im } }
  }
}

function reserveHttpLoopbackServer(): Promise<HttpServer> {
  return new Promise<HttpServer>((resolveServer, reject) => {
    const server = createHttpServer()
    const onError = (error: Error): void => {
      server.removeListener('error', onError)
      try { server.close() } catch { /* listener never became active */ }
      reject(error)
    }
    server.once('error', onError)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.removeListener('error', onError)
      resolveServer(server)
    })
  })
}

/**
 * Reserve the candidate's HTTP ports and keep the listeners open until the
 * corresponding runtime takes ownership of them. This closes the check/use
 * race that allowed another process to claim a port between startup phases.
 */
export async function reserveCandidateServicePorts(): Promise<CandidateServiceReservations> {
  let scheduleServer: HttpServer | null = null
  let imServer: HttpServer | null = null
  try {
    scheduleServer = await reserveHttpLoopbackServer()
    imServer = await reserveHttpLoopbackServer()
    const scheduleAddress = scheduleServer.address()
    const imAddress = imServer.address()
    if (!scheduleAddress || typeof scheduleAddress === 'string' || !imAddress || typeof imAddress === 'string') {
      throw new Error('Candidate service port reservation returned no TCP port.')
    }
    const ports = { runtime: 0, schedule: scheduleAddress.port, im: imAddress.port }
    if (ports.schedule === ports.im) throw new Error('Candidate services require distinct loopback ports.')
    let closed = false
    const reservedServers = [scheduleServer, imServer]
    return {
      ports,
      scheduleServer,
      imServer,
      close: async (): Promise<void> => {
        if (closed) return
        closed = true
        await Promise.all(reservedServers.map((server) => new Promise<void>((resolveClose) => {
          try {
            if (!server.listening) {
              resolveClose()
              return
            }
            server.close(() => resolveClose())
          } catch {
            resolveClose()
          }
        })))
      }
    }
  } catch (error) {
    await Promise.all([scheduleServer, imServer].filter((server): server is HttpServer => Boolean(server)).map((server) => new Promise<void>((resolveClose) => {
      try { server.close(() => resolveClose()) } catch { resolveClose() }
    })))
    throw error
  }
}

async function probeCandidateListener(url: string, expectedService: 'kun' | 'schedule' | 'claw'): Promise<void> {
  let response: Response
  try {
    response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(2_000) })
  } catch (error) {
    throw new Error(`Candidate service is not listening at ${url}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    throw new Error(`Candidate ${expectedService} health check failed at ${url} with HTTP ${response.status}.`)
  }
  const body = await response.text()
  if (expectedService === 'kun') {
    if (!isRuntimeHealthResponseBody(body)) {
      throw new Error(`Candidate Runtime health check at ${url} returned an unexpected service identity.`)
    }
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body) as unknown
  } catch {
    parsed = null
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null
  if (record?.status !== 'ok' || record.service !== expectedService) {
    throw new Error(`Candidate ${expectedService} health check at ${url} returned an unexpected service identity.`)
  }
}

export async function verifyCandidateServiceListeners(ports: CandidateServicePorts): Promise<CandidateServicePorts> {
  const values = [ports.runtime, ports.schedule, ports.im]
  if (values.some((port) => !Number.isInteger(port) || port < 1_024 || port > 65_535) || new Set(values).size !== values.length) {
    throw new Error('Candidate service probe requires three distinct listening ports.')
  }
  await Promise.all([
    probeCandidateListener(`http://127.0.0.1:${ports.runtime}/health`, 'kun'),
    probeCandidateListener(`http://127.0.0.1:${ports.schedule}/schedule/internal/health`, 'schedule'),
    probeCandidateListener(`http://127.0.0.1:${ports.im}/claw/internal/health`, 'claw')
  ])
  return ports
}

function recoveryCandidateBundleIdentifier(resourcesPath: string | undefined): string {
  if (!resourcesPath) return ''
  try {
    const plist = readFileSync(join(resolve(resourcesPath), '..', 'Info.plist'), 'utf8')
    const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    return match?.[1]?.trim() ?? ''
  } catch {
    return ''
  }
}

function isRecoveryCandidateExecutable(
  executablePath: string,
  resourcesPath: string | undefined = process.resourcesPath
): boolean {
  if (/^WorkWise IM Recovery Candidate(?:\.exe)?$/i.test(basename(executablePath))) return true
  if (/^(?:WorkWise|RailWise AI) Candidate [0-9a-f]{12}(?:\.exe)?$/i.test(basename(executablePath))) return true
  if (/\/(?:WorkWise|RailWise AI) Candidate [0-9a-f]{12}\.app(?:\/|$)/i.test(executablePath)) return true
  const bundleName = basename(resolve(resourcesPath ?? '', '..', '..'))
  if (bundleName !== CANDIDATE_BUNDLE_NAME && !SOURCE_HEAD_CANDIDATE_BUNDLE_PATTERN.test(bundleName)) return false
  const identifier = recoveryCandidateBundleIdentifier(resourcesPath)
  return identifier === CANDIDATE_BUNDLE_IDENTIFIER || SOURCE_HEAD_CANDIDATE_IDENTIFIER_PATTERN.test(identifier)
}

function decodeCandidateEnvironmentValue(rawValue: string): string {
  const trimmed = rawValue.trim()
  const quoted = trimmed.length >= 2 && (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  )
  const value = quoted ? trimmed.slice(1, -1) : trimmed
  let decoded = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '\\' && index + 1 < value.length) {
      decoded += value[index + 1]
      index += 1
      continue
    }
    decoded += character
  }
  return decoded
}

function readCandidateEnvironmentFile(path: string): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {}
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export[\t ]+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line)
    if (!match || !CANDIDATE_ENV_KEYS.has(match[1]!)) continue
    const value = decodeCandidateEnvironmentValue(match[2]!)
    if (value.includes('\0') || value.length > 8_192) {
      throw new Error('Candidate environment file contains an invalid value.')
    }
    output[match[1]!] = value
  }
  return output
}

/**
 * macOS LaunchServices does not reliably forward `open --env` values to a
 * fresh app instance. Recovery candidates can instead receive their existing
 * isolated candidate.env path through `open --args`. This is deliberately
 * unavailable to production executables and remains fail-closed on errors.
 */
export function candidateEnvironmentFromArgv(
  executablePath: string,
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath: string | undefined = process.resourcesPath
): NodeJS.ProcessEnv {
  let paths = argv
    .filter((arg) => arg.startsWith(CANDIDATE_ENV_FILE_ARG))
    .map((arg) => arg.slice(CANDIDATE_ENV_FILE_ARG.length).trim())
  // Squirrel.Mac relaunches the installed bundle without preserving the
  // original argv. Recovery candidates can recover their in-root environment
  // from the sibling candidate.env file in that isolated delivery root.
  if (paths.length === 0 && isRecoveryCandidateExecutable(executablePath, resourcesPath)) {
    let current = resolve(executablePath)
    for (let index = 0; index < 8; index += 1) {
      current = resolve(current, '..')
      const candidateEnv = join(current, 'candidate.env')
      try {
        readFileSync(candidateEnv, 'utf8')
        paths = [candidateEnv]
        break
      } catch {
        // Continue toward the isolated delivery root.
      }
    }
  }
  if (paths.length === 0) return env
  if (!isRecoveryCandidateExecutable(executablePath, resourcesPath)) {
    throw new Error('Candidate environment files are accepted only by an isolated recovery candidate.')
  }
  if (paths.length !== 1 || !paths[0] || !isAbsolute(paths[0]!)) {
    throw new Error('Recovery candidate requires exactly one absolute candidate environment file path.')
  }
  const environment = readCandidateEnvironmentFile(paths[0]!)
  if (environment.WORKWISE_CANDIDATE !== '1' || !environment.WORKWISE_CANDIDATE_ROOT) {
    throw new Error('Candidate environment file does not enable isolated candidate mode.')
  }
  const root = resolve(environment.WORKWISE_CANDIDATE_ROOT)
  if (resolve(paths[0]!) !== join(root, 'candidate.env')) {
    throw new Error('Candidate environment file must be the candidate.env file inside its isolated root.')
  }
  // LaunchServices may preserve only a subset of the parent candidate
  // environment. The verified in-root file is authoritative for an explicit
  // candidate launch, so helper selection survives app restarts as well.
  const merged = { ...env, ...environment }
  resolveCandidateRuntimePaths(merged)
  return merged
}

export async function runCandidateRuntimeProbe(options: {
  ensureRuntime: () => Promise<void>
  verifyServices?: () => Promise<CandidateServicePorts | void>
  reportReady: (ports?: CandidateServicePorts) => void
  stop: () => Promise<void>
  exit: (code: number) => void
}): Promise<void> {
  await options.ensureRuntime()
  const ports = await options.verifyServices?.() ?? undefined
  options.reportReady(ports)
  await options.stop()
  options.exit(0)
}

export function isCandidateHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WORKWISE_CANDIDATE === '1' && env.WORKWISE_CANDIDATE_HEADLESS === '1'
}

export function isCandidateRuntimeProbe(env: NodeJS.ProcessEnv = process.env): boolean {
  return isCandidateHeadless(env) && env.WORKWISE_CANDIDATE_RUNTIME_PROBE === '1'
}

/**
 * Candidate processes must not contact real IM recipients by default. An
 * explicit `=0` is required for a separately authorized outbound test.
 */
export function isCandidateOutboundDisabled(
  providerOrEnv?: 'feishu' | 'weixin' | NodeJS.ProcessEnv,
  recipientOrEnv?: string | NodeJS.ProcessEnv,
  configuredEnv: NodeJS.ProcessEnv = process.env
): boolean {
  const provider = typeof providerOrEnv === 'string' ? providerOrEnv : undefined
  const recipient = typeof recipientOrEnv === 'string' ? recipientOrEnv.trim() : ''
  const env = typeof providerOrEnv === 'string'
    ? typeof recipientOrEnv === 'object' && recipientOrEnv !== null
      ? recipientOrEnv
      : configuredEnv
    : providerOrEnv ?? configuredEnv
  if (env.WORKWISE_CANDIDATE !== '1') return false
  if (env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED !== '0') return true
  const allowedProvider = env.WORKWISE_CANDIDATE_OUTBOUND_PROVIDER?.trim().toLowerCase()
  if (!provider || allowedProvider !== provider || !recipient) return true
  const allowedChatId = provider === 'feishu'
    ? env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_CHAT_ID?.trim()
    : env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_CHAT_ID?.trim()
  return !allowedChatId || allowedChatId !== recipient
}

/**
 * Candidate IM reception is also fail-closed. A real provider callback can
 * otherwise start arbitrary work as soon as a test credential is authorized.
 * The opt-in is intentionally a single provider, chat and exact command.
 */
export function isCandidateInboundAllowed(
  provider: 'feishu' | 'weixin',
  chatId: string,
  content: string,
  configuredEnv: NodeJS.ProcessEnv = process.env
): boolean {
  if (configuredEnv.WORKWISE_CANDIDATE !== '1') return true
  if (configuredEnv.WORKWISE_CANDIDATE_INBOUND_DISABLED !== '0') return false
  if (configuredEnv.WORKWISE_CANDIDATE_INBOUND_PROVIDER?.trim().toLowerCase() !== provider) return false
  const allowedChatId = provider === 'feishu'
    ? configuredEnv.WORKWISE_CANDIDATE_ALLOWED_FEISHU_CHAT_ID?.trim()
    : configuredEnv.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_CHAT_ID?.trim()
  if (!allowedChatId || allowedChatId !== chatId.trim()) return false
  const allowedCommand = provider === 'feishu'
    ? configuredEnv.WORKWISE_CANDIDATE_ALLOWED_FEISHU_COMMAND?.trim()
    : configuredEnv.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_COMMAND?.trim()
  return Boolean(allowedCommand) && content.trim() === allowedCommand
}

/**
 * Candidate provider connections are fail-closed. A provider may only start
 * when the candidate has an explicit, bounded IM authorization for that
 * provider. This keeps a disabled candidate from opening Keychain merely to
 * discover that message handling is disabled.
 */
export function isCandidateImProviderConnectionAllowed(
  provider: 'feishu' | 'weixin',
  configuredEnv: NodeJS.ProcessEnv = process.env
): boolean {
  if (configuredEnv.WORKWISE_CANDIDATE !== '1') return true

  const normalizedProvider = configuredEnv.WORKWISE_CANDIDATE_INBOUND_PROVIDER?.trim().toLowerCase()
  const outboundProvider = configuredEnv.WORKWISE_CANDIDATE_OUTBOUND_PROVIDER?.trim().toLowerCase()
  const chatId = provider === 'feishu'
    ? configuredEnv.WORKWISE_CANDIDATE_ALLOWED_FEISHU_CHAT_ID?.trim()
    : configuredEnv.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_CHAT_ID?.trim()
  const inboundCommand = provider === 'feishu'
    ? configuredEnv.WORKWISE_CANDIDATE_ALLOWED_FEISHU_COMMAND?.trim()
    : configuredEnv.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_COMMAND?.trim()

  const inboundAuthorized =
    configuredEnv.WORKWISE_CANDIDATE_INBOUND_DISABLED === '0' &&
    normalizedProvider === provider &&
    Boolean(chatId && inboundCommand)
  const outboundAuthorized =
    configuredEnv.WORKWISE_CANDIDATE_OUTBOUND_DISABLED === '0' &&
    outboundProvider === provider &&
    Boolean(chatId)
  return inboundAuthorized || outboundAuthorized
}

/**
 * Protected storage is an explicit acceptance capability for candidates.
 * Ordinary candidate launches must be able to exercise the GUI and document
 * paths without prompting for the user's production Keychain.
 */
export function isCandidateCredentialAccessAllowed(
  configuredEnv: NodeJS.ProcessEnv = process.env
): boolean {
  return configuredEnv.WORKWISE_CANDIDATE !== '1' || configuredEnv.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS === '1'
}

export function isUnconfiguredRecoveryCandidate(
  executablePath: string,
  env: NodeJS.ProcessEnv = process.env,
  resourcesPath: string | undefined = process.resourcesPath
): boolean {
  if (env.WORKWISE_CANDIDATE === '1') return false
  return isRecoveryCandidateExecutable(executablePath, resourcesPath)
}

export function sanitizeCandidateProcessEnvironment(
  env: NodeJS.ProcessEnv = process.env
): void {
  if (env.WORKWISE_CANDIDATE !== '1') return
  delete env.DEEPSEEK_API_KEY
}

function containedPath(root: string, name: string, raw: string | undefined, fallback: string): string {
  const value = raw?.trim() || join(root, fallback)
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path in candidate mode.`)
  const target = resolve(value)
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`${name} must stay inside WORKWISE_CANDIDATE_ROOT.`)
  }
  return target
}

export function resolveCandidateRuntimePaths(
  env: NodeJS.ProcessEnv = process.env
): CandidateRuntimePaths | null {
  if (env.WORKWISE_CANDIDATE !== '1') return null
  const rawRoot = env.WORKWISE_CANDIDATE_ROOT?.trim()
  if (!rawRoot || !isAbsolute(rawRoot)) {
    throw new Error('WORKWISE_CANDIDATE_ROOT must be an absolute path in candidate mode.')
  }
  const root = resolve(rawRoot)
  if (root === resolve(root, '..')) throw new Error('WORKWISE_CANDIDATE_ROOT cannot be a filesystem root.')
  const userData = containedPath(root, 'WORKWISE_CANDIDATE_USER_DATA', env.WORKWISE_CANDIDATE_USER_DATA, 'user-data')
  const cache = containedPath(root, 'WORKWISE_CANDIDATE_CACHE', env.WORKWISE_CANDIDATE_CACHE, 'cache')
  const sessionData = containedPath(root, 'WORKWISE_CANDIDATE_SESSION_DATA', undefined, 'session-data')
  const crashDumps = containedPath(root, 'WORKWISE_CANDIDATE_CRASH_DUMPS', undefined, 'crash-dumps')
  const logs = containedPath(root, 'WORKWISE_CANDIDATE_LOGS', env.WORKWISE_CANDIDATE_LOGS, 'logs')
  const home = containedPath(root, 'WORKWISE_CANDIDATE_HOME', env.WORKWISE_CANDIDATE_HOME, 'home')
  return {
    root,
    userData,
    cache,
    sessionData,
    crashDumps,
    logs,
    home,
    workwiseHome: join(home, '.workwise'),
    toolsRoot: join(home, '.workwise', 'tools')
  }
}

type CandidateApplicationPathName = 'userData' | 'cache' | 'sessionData' | 'crashDumps' | 'logs'

export function configureCandidateApplicationPaths(
  paths: CandidateRuntimePaths,
  argv: readonly string[],
  credentialHelper: boolean,
  setPath: (name: CandidateApplicationPathName, path: string) => void
): void {
  const applicationPaths: Record<CandidateApplicationPathName, string> = {
    userData: candidateProcessUserDataPath(paths, argv, credentialHelper),
    cache: paths.cache,
    sessionData: paths.sessionData,
    crashDumps: paths.crashDumps,
    logs: paths.logs
  }
  for (const [name, path] of Object.entries(applicationPaths) as Array<[CandidateApplicationPathName, string]>) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    setPath(name, path)
  }
}

export function candidateProcessUserDataPath(
  paths: CandidateRuntimePaths,
  argv: readonly string[],
  credentialHelper: boolean
): string {
  if (!credentialHelper) return paths.userData
  const raw = argv.find((arg) => arg.startsWith(USER_DATA_ARG))?.slice(USER_DATA_ARG.length).trim()
  if (!raw) return paths.userData
  if (!isAbsolute(raw)) throw new Error('Credential helper user data must be an absolute path.')
  const target = resolve(raw)
  const rel = relative(paths.root, target)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('Credential helper user data must stay inside WORKWISE_CANDIDATE_ROOT.')
  }
  return target
}
