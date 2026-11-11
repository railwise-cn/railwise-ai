import { app } from 'electron'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { DEFAULT_WEIXIN_BRIDGE_RPC_URL } from '../shared/app-settings'
import {
  IM_HEALTH_SUPERVISOR_INTERVAL_MS,
  IM_LEDGER_LEASE_RENEW_INTERVAL_MS,
  IM_STALE_AFTER_MS,
  retryDelayMs
} from '../shared/im-communication'
import type { WeixinBridgeAccountStatusV1 } from '../shared/workwise-api'
import type { ImCredentialRefV1 } from '../shared/im-communication'
import { logError, logInfo, logWarn } from './logger'
import { isCandidateOutboundDisabled } from './candidate-runtime'

const requireFromHere = createRequire(import.meta.url)
const WEIXIN_BRIDGE_PORT = 18790
const WEIXIN_BRIDGE_MAX_PORT_ATTEMPTS = 20
const WEIXIN_BRIDGE_HEALTH_TIMEOUT_MS = 3_000
const WEIXIN_BRIDGE_STATE_DIR_NAME = 'weixin-bridge'
const WEIXIN_PLUGIN_ID = 'openclaw-weixin'
const WEIXIN_API_BASE_URL = 'https://ilinkai.weixin.qq.com'
const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
const WEIXIN_DEFAULT_BOT_TYPE = '3'
const LOGIN_TTL_MS = 5 * 60_000
const QR_LONG_POLL_TIMEOUT_MS = 35_000
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000
const DEFAULT_API_TIMEOUT_MS = 15_000
const WEIXIN_SEND_RETRY_DELAYS_MS = [0, 750, 2_000] as const
const WEIXIN_SLOW_REPLY_NOTICE_MS = 8_000
const WEIXIN_SLOW_REPLY_TEXT = '收到，正在处理，请稍候…'
const WEIXIN_SESSION_EXPIRED_ERRCODE = -14
// The bundled Tencent channel uses the same limit for plain text messages.
// Keep each request below it because the iLink API does not reliably expose
// an oversized-message error to the caller.
const WEIXIN_TEXT_CHUNK_LIMIT = 4_000
const WEIXIN_FAILED_REPLY_TEXT = '任务未完成，RailWise AI Runtime 没有产生可交付结果。请稍后重试。'
const WEIXIN_WEB_SEARCH_FAILED_REPLY_TEXT =
  '在线搜索连续失败，暂时无法核实最新资讯。本次任务未完成，请稍后重试，或发来可访问的网页链接。'
const WEIXIN_TIMEOUT_REPLY_TEXT = '任务处理超时，尚未完成。请稍后重试。'
const WEIXIN_FILE_FAILED_REPLY_TEXT = '回复文字已发送，但附件发送失败。请稍后再让我发送该文件。'
const MessageType = {
  BOT: 2
} as const
const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5
} as const
const MessageState = {
  FINISH: 2
} as const

type JsonRecord = Record<string, unknown>

class WeixinWebhookError extends Error {
  constructor(readonly replyText: string) {
    super('RailWise AI Runtime webhook failed')
  }
}

class WorkWiseDeliveryLeaseLostError extends Error {
  constructor(message = 'RailWise AI delivery lease is no longer owned by this sender.') {
    super(message)
    this.name = 'WorkWiseDeliveryLeaseLostError'
  }
}

function safeWeixinFailureReply(message: string): string {
  if (/web_access_exhausted|在线搜索连续失败|web (?:access|search).*fail/i.test(message)) {
    return WEIXIN_WEB_SEARCH_FAILED_REPLY_TEXT
  }
  if (/timed out|timeout|超时/i.test(message)) return WEIXIN_TIMEOUT_REPLY_TEXT
  if (/file delivery failed|attachment.*fail|附件.*失败/i.test(message)) return WEIXIN_FILE_FAILED_REPLY_TEXT
  return WEIXIN_FAILED_REPLY_TEXT
}

function webhookReplyText(data: JsonRecord): string {
  return recordString(data, 'reply') || recordString(data, 'text')
}

function buildBoundLoginResult(input: {
  sessionKey: string
  existingAccountId: string
}): JsonRecord {
  return {
    connected: true,
    alreadyConnected: true,
    accountId: normalizeAccountId(input.existingAccountId),
    sessionKey: input.sessionKey,
    message: '已连接过此 RailWise AI Runtime，无需重复连接。'
  }
}

export function splitWeixinText(text: string, maxLength = WEIXIN_TEXT_CHUNK_LIMIT): string[] {
  const normalized = text.trim()
  if (!normalized) return []
  const limit = Math.max(1, Math.floor(maxLength))
  const chunks: string[] = []
  let remaining = normalized
  while (remaining.length > limit) {
    const newline = remaining.lastIndexOf('\n', limit - 1)
    const whitespace = remaining.lastIndexOf(' ', limit - 1)
    const splitAt = newline >= Math.floor(limit / 2)
      ? newline + 1
      : whitespace >= Math.floor(limit / 2)
        ? whitespace + 1
        : limit
    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }
  if (remaining) chunks.push(remaining)
  return chunks
}

type WeixinBridgeRuntimeContext = {
  webhookUrl: string
  webhookSecret: string
  channelId: string
}

type WeixinPackageInfo = {
  version: string
  appId: string
}

type WeixinLoginSession = {
  sessionKey: string
  qrcode: string
  qrcodeUrl: string
  startedAt: number
  currentApiBaseUrl?: string
  /**
   * A forced QR login can return `binded_redirect` instead of issuing a new
   * token. Keep the local account id that supplied the token list so the
   * caller restarts the real account rather than the temporary session UUID.
   */
  existingAccountId?: string
}

type WeixinAccountData = {
  credentialRef?: ImCredentialRefV1
  /** Legacy plaintext token, migrated after secure-storage verification. */
  token?: string
  baseUrl?: string
  userId?: string
  savedAt?: string
}

export type WeixinBridgeCredentialProvider = {
  set: (namespace: string, key: string, value: string) => Promise<ImCredentialRefV1>
  migrate: (namespace: string, key: string, legacySecret: string, ref?: ImCredentialRefV1) => Promise<ImCredentialRefV1>
  resolve: (ref: ImCredentialRefV1) => Promise<string | undefined>
  remove: (ref: ImCredentialRefV1 | undefined) => Promise<void>
}

type WeixinPersistedAccountStatus = Omit<WeixinBridgeAccountStatusV1, 'accountId'>

type WeixinAccount = {
  accountId: string
  baseUrl: string
  cdnBaseUrl: string
  token?: string
  configured: boolean
  userId?: string
}

type WeixinMessageItem = {
  type?: number
  text_item?: { text?: unknown }
  voice_item?: { text?: unknown }
}

type WeixinMessage = {
  // Tencent may return this 64-bit id as a JSON number even though the
  // adapter contract documents it as a string.
  message_id?: string | number
  message_type?: number
  from_user_id?: string
  create_time_ms?: number
  context_token?: string
  item_list?: WeixinMessageItem[]
}

function weixinMessageId(message: WeixinMessage): string {
  const value = message.message_id
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const sender = message.from_user_id?.trim() ?? ''
  const createdAt = message.create_time_ms
  if (sender && typeof createdAt === 'number' && Number.isFinite(createdAt)) {
    const digest = createHash('sha256')
      .update(JSON.stringify([
        sender,
        createdAt,
        message.message_type ?? null,
        message.context_token ?? '',
        message.item_list ?? []
      ]))
      .digest('hex')
      .slice(0, 32)
    return `wx-fallback-${digest}`
  }
  return ''
}

type WeixinMonitor = {
  accountId: string
  runId: string
  startedAt: string
  controller: AbortController
  promise: Promise<void>
  watchdog: ReturnType<typeof setInterval>
}

export type WeixinBridgeSendResult =
  | { ok: true; messageId: string }
  | { ok: false; message: string }

let server: HttpServer | null = null
let startPromise: Promise<string> | null = null
let bridgeRuntimeStopping = false
let runtimeContextProvider: (() => Promise<WeixinBridgeRuntimeContext>) | null = null
let credentialProvider: WeixinBridgeCredentialProvider | null = null
let activeBridgePort = WEIXIN_BRIDGE_PORT
let packageInfoCache: WeixinPackageInfo | null = null
const activeLogins = new Map<string, WeixinLoginSession>()
const contextTokenStore = new Map<string, string>()
const contextTokenRefs = new Map<string, ImCredentialRefV1>()
const monitors = new Map<string, WeixinMonitor>()
const accountStatuses = new Map<string, WeixinPersistedAccountStatus>()
let accountStatusesLoaded = false
let accountStatusWritePromise: Promise<void> = Promise.resolve()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sleepUntilAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })
}

function resolveRpcUrl(port = activeBridgePort): string {
  const url = new URL(DEFAULT_WEIXIN_BRIDGE_RPC_URL)
  url.port = String(port)
  return url.toString()
}

export function configureWeixinBridgeRuntimeContextProvider(
  provider: (() => Promise<WeixinBridgeRuntimeContext>) | null
): void {
  runtimeContextProvider = provider
}

export function configureWeixinBridgeCredentialProvider(provider: WeixinBridgeCredentialProvider | null): void {
  credentialProvider = provider
}

async function requirePersistentWeixinCredential(
  ref: ImCredentialRefV1
): Promise<ImCredentialRefV1> {
  if (ref.storage !== 'session') return ref
  throw Object.assign(new Error('Protected WeChat credential storage is temporarily unavailable.'), {
    code: 'credential_unavailable'
  })
}

async function resolveRuntimeContext(): Promise<WeixinBridgeRuntimeContext> {
  return runtimeContextProvider
    ? runtimeContextProvider()
    : {
        webhookUrl: 'http://127.0.0.1:8787/claw/im',
        webhookSecret: '',
        channelId: ''
      }
}

function resolvePackagePath(packageName: string, subpath: string): string | null {
  try {
    return requireFromHere.resolve(`${packageName}/${subpath}`)
  } catch {
    return null
  }
}

function resolveWeixinPluginRoot(): string | null {
  const packageJson = resolvePackagePath('@tencent-weixin/openclaw-weixin', 'package.json')
  return packageJson ? dirname(packageJson) : null
}

function readWeixinPackageInfo(): WeixinPackageInfo {
  if (packageInfoCache) return packageInfoCache
  const packageJson = resolvePackagePath('@tencent-weixin/openclaw-weixin', 'package.json')
  if (!packageJson) {
    throw new Error(
      'Built-in WeChat login component is missing. Reinstall RailWise AI Runtime or rebuild with @tencent-weixin/openclaw-weixin bundled.'
    )
  }
  const parsed = JSON.parse(readFileSync(packageJson, 'utf8')) as JsonRecord
  packageInfoCache = {
    version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    appId: typeof parsed.ilink_appid === 'string' ? parsed.ilink_appid : 'bot'
  }
  return packageInfoCache
}

function buildClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => Number.isFinite(part) ? part : 0)
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

function buildBaseInfo(): JsonRecord {
  const info = readWeixinPackageInfo()
  return {
    channel_version: info.version,
    bot_agent: `RailWise AI Runtime/${app.getVersion() || '0.0.0'}`
  }
}

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf8').toString('base64')
}

function buildCommonHeaders(): Record<string, string> {
  const info = readWeixinPackageInfo()
  return {
    'iLink-App-Id': info.appId,
    'iLink-App-ClientVersion': String(buildClientVersion(info.version))
  }
}

function buildHeaders(token?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
    ...(token?.trim() ? { Authorization: `Bearer ${token.trim()}` } : {})
  }
}

async function readJsonResponse(res: Response): Promise<JsonRecord> {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) as JsonRecord : {}
  } catch {
    return { message: text.trim() || res.statusText }
  }
}

async function apiGet(
  baseUrl: string,
  endpoint: string,
  timeoutMs: number,
  label: string
): Promise<JsonRecord> {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: buildCommonHeaders(),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const data = await readJsonResponse(res)
  if (!res.ok) {
    throw new Error(`${label} ${res.status}: ${recordString(data, 'message') || JSON.stringify(data)}`)
  }
  return data
}

async function apiPost(
  baseUrl: string,
  endpoint: string,
  body: JsonRecord,
  options: { token?: string; timeoutMs?: number; signal?: AbortSignal; label: string }
): Promise<JsonRecord> {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  const timeoutSignal = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined
  const signal = options.signal && timeoutSignal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : options.signal ?? timeoutSignal
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: buildHeaders(options.token),
    body: JSON.stringify(body),
    signal
  })
  const data = await readJsonResponse(res)
  if (!res.ok) {
    throw new Error(`${options.label} ${res.status}: ${recordString(data, 'message') || JSON.stringify(data)}`)
  }
  return data
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

function recordString(record: JsonRecord, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

function stateRoot(): string {
  return join(app.getPath('userData'), WEIXIN_BRIDGE_STATE_DIR_NAME)
}

function weixinStateDir(): string {
  return join(stateRoot(), WEIXIN_PLUGIN_ID)
}

function accountsIndexPath(): string {
  return join(weixinStateDir(), 'accounts.json')
}

function accountsDir(): string {
  return join(weixinStateDir(), 'accounts')
}

function accountPath(accountId: string): string {
  return join(accountsDir(), `${accountId}.json`)
}

function syncBufPath(accountId: string): string {
  return join(accountsDir(), `${accountId}.sync.json`)
}

function contextTokensPath(accountId: string): string {
  return join(accountsDir(), `${accountId}.context-tokens.json`)
}

function accountStatusesPath(): string {
  return join(weixinStateDir(), 'account-status.json')
}

function configPath(): string {
  return join(stateRoot(), 'weixin-bridge.json')
}

function legacyOpenClawConfigPath(): string {
  return join(stateRoot(), 'openclaw.json')
}

function isBlockedObjectKey(value: string): boolean {
  return value === '__proto__' || value === 'prototype' || value === 'constructor'
}

function normalizeAccountId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return 'default'
  const lowered = trimmed.toLowerCase()
  const normalized = /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)
    ? lowered
    : lowered
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+/, '')
        .replace(/-+$/, '')
        .slice(0, 64)
  return normalized && !isBlockedObjectKey(normalized) ? normalized : 'default'
}

function deriveRawAccountId(normalizedId: string): string | undefined {
  if (normalizedId.endsWith('-im-bot')) return `${normalizedId.slice(0, -7)}@im.bot`
  if (normalizedId.endsWith('-im-wechat')) return `${normalizedId.slice(0, -10)}@im.wechat`
  return undefined
}

async function ensureStateDirs(): Promise<void> {
  await mkdir(accountsDir(), { recursive: true })
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw) as unknown
}

async function writeJsonIfChanged(filePath: string, value: unknown): Promise<void> {
  const next = `${JSON.stringify(value, null, 2)}\n`
  try {
    const current = await readFile(filePath, 'utf8')
    if (current === next) return
  } catch {
    /* create the file below */
  }
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, next, 'utf8')
}

function normalizeAccountStatus(value: unknown): WeixinPersistedAccountStatus | null {
  const raw = asRecord(value)
  const status = raw.status
  if (
    status !== 'unknown' &&
    status !== 'starting' &&
    status !== 'connected' &&
    status !== 'retrying' &&
    status !== 'stale' &&
    status !== 'expired' &&
    status !== 'error' &&
    status !== 'stopped'
  ) return null
  const errorCode = Number(raw.errorCode)
  return {
    status,
    message: recordString(raw, 'message'),
    ...(Number.isFinite(errorCode) ? { errorCode } : {}),
    ...(recordString(raw, 'updatedAt') ? { updatedAt: recordString(raw, 'updatedAt') } : {}),
    ...(recordString(raw, 'lastSuccessfulPollAt')
      ? { lastSuccessfulPollAt: recordString(raw, 'lastSuccessfulPollAt') }
      : {}),
    ...(recordString(raw, 'runId') ? { runId: recordString(raw, 'runId') } : {}),
    ...(recordString(raw, 'startedAt') ? { startedAt: recordString(raw, 'startedAt') } : {}),
    ...(recordString(raw, 'lastInboundAt') ? { lastInboundAt: recordString(raw, 'lastInboundAt') } : {}),
    ...(recordString(raw, 'lastOutboundAt') ? { lastOutboundAt: recordString(raw, 'lastOutboundAt') } : {}),
    ...(recordString(raw, 'lastErrorAt') ? { lastErrorAt: recordString(raw, 'lastErrorAt') } : {}),
    ...(Number.isFinite(Number(raw.failureCount)) ? { failureCount: Number(raw.failureCount) } : {}),
    ...(recordString(raw, 'nextRetryAt') ? { nextRetryAt: recordString(raw, 'nextRetryAt') } : {}),
    ...(recordString(raw, 'reasonCode') ? { reasonCode: recordString(raw, 'reasonCode') } : {})
  }
}

async function loadAccountStatuses(): Promise<void> {
  if (accountStatusesLoaded) return
  accountStatusesLoaded = true
  try {
    const parsed = asRecord(await readJsonFile(accountStatusesPath()))
    for (const [id, value] of Object.entries(parsed)) {
      const status = normalizeAccountStatus(value)
      if (status) accountStatuses.set(normalizeAccountId(id), status)
    }
  } catch {
    /* Diagnostic state must never block login. */
  }
}

async function setAccountStatus(
  accountId: string,
  status: WeixinPersistedAccountStatus['status'],
  detail: Partial<Omit<WeixinPersistedAccountStatus, 'status'>> = {}
): Promise<void> {
  await loadAccountStatuses()
  const normalizedId = normalizeAccountId(accountId)
  const previous = accountStatuses.get(normalizedId)
  const healthy = status === 'connected' || status === 'starting'
  const next: WeixinPersistedAccountStatus = {
    ...previous,
    status,
    message: detail.message !== undefined ? detail.message.trim() : previous?.message ?? '',
    errorCode: detail.errorCode !== undefined ? detail.errorCode : healthy ? undefined : previous?.errorCode,
    updatedAt: detail.updatedAt || new Date().toISOString(),
    ...(detail.lastSuccessfulPollAt ? { lastSuccessfulPollAt: detail.lastSuccessfulPollAt } : {}),
    ...(detail.runId ? { runId: detail.runId } : {}),
    ...(detail.startedAt ? { startedAt: detail.startedAt } : {}),
    ...(detail.lastInboundAt ? { lastInboundAt: detail.lastInboundAt } : {}),
    ...(detail.lastOutboundAt ? { lastOutboundAt: detail.lastOutboundAt } : {}),
    lastErrorAt: detail.lastErrorAt || (healthy ? undefined : previous?.lastErrorAt),
    ...(detail.failureCount !== undefined ? { failureCount: detail.failureCount } : {}),
    nextRetryAt: detail.nextRetryAt || (healthy || status === 'stopped' || status === 'expired' ? undefined : previous?.nextRetryAt),
    ...(detail.reasonCode ? { reasonCode: detail.reasonCode } : {})
  }
  accountStatuses.set(normalizedId, next)
  accountStatusWritePromise = accountStatusWritePromise
    .catch(() => undefined)
    .then(() => writeJsonIfChanged(accountStatusesPath(), Object.fromEntries(accountStatuses)))
  await accountStatusWritePromise
}

function isWeixinSessionExpiredResponse(response: JsonRecord): boolean {
  return Number(response.errcode ?? 0) === WEIXIN_SESSION_EXPIRED_ERRCODE ||
    Number(response.ret ?? 0) === WEIXIN_SESSION_EXPIRED_ERRCODE
}

function buildWeixinQrRequest(localTokens: string[], includeLocalTokens: boolean): JsonRecord {
  return { local_token_list: includeLocalTokens ? localTokens : [] }
}

function canReuseWeixinAccountStatus(
  status: WeixinPersistedAccountStatus['status'] | undefined
): boolean {
  return status !== 'expired' && status !== 'stopped'
}

function canTrustActiveWeixinCredential(
  monitorActive: boolean,
  status: WeixinPersistedAccountStatus['status'] | undefined
): boolean {
  return monitorActive && status === 'connected'
}

async function listIndexedWeixinAccountIds(): Promise<string[]> {
  try {
    const parsed = await readJsonFile(accountsIndexPath())
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      : []
  } catch {
    return []
  }
}

async function registerWeixinAccountId(accountId: string): Promise<void> {
  await ensureStateDirs()
  const existing = await listIndexedWeixinAccountIds()
  if (existing.includes(accountId)) return
  await writeJsonIfChanged(accountsIndexPath(), [...existing, accountId])
}

async function readAccountFile(filePath: string): Promise<WeixinAccountData | null> {
  try {
    const parsed = await readJsonFile(filePath)
    const raw = asRecord(parsed)
    const ref = asRecord(raw.credentialRef)
    const credentialRef = typeof ref.id === 'string' && typeof ref.storage === 'string' && typeof ref.createdAt === 'string'
      ? ref as unknown as ImCredentialRefV1
      : undefined
    return {
      ...(credentialRef ? { credentialRef } : {}),
      ...(typeof raw.token === 'string' ? { token: raw.token } : {}),
      ...(typeof raw.baseUrl === 'string' ? { baseUrl: raw.baseUrl } : {}),
      ...(typeof raw.userId === 'string' ? { userId: raw.userId } : {}),
      ...(typeof raw.savedAt === 'string' ? { savedAt: raw.savedAt } : {})
    }
  } catch {
    return null
  }
}

type LoadedWeixinAccountData = {
  data: WeixinAccountData
  sourcePath: string
  legacyCredentialFile: boolean
}

async function loadLegacyToken(): Promise<LoadedWeixinAccountData | null> {
  const sourcePath = join(stateRoot(), 'credentials', WEIXIN_PLUGIN_ID, 'credentials.json')
  try {
    const parsed = await readJsonFile(sourcePath)
    const token = asRecord(parsed).token
    return typeof token === 'string' && token.trim()
      ? { data: { token: token.trim() }, sourcePath, legacyCredentialFile: true }
      : null
  } catch {
    return null
  }
}

async function loadWeixinAccountEntry(accountId: string): Promise<LoadedWeixinAccountData | null> {
  const primaryPath = accountPath(accountId)
  const primary = await readAccountFile(primaryPath)
  if (primary) return { data: primary, sourcePath: primaryPath, legacyCredentialFile: false }
  const rawId = deriveRawAccountId(accountId)
  if (rawId) {
    const compatPath = accountPath(rawId)
    const compat = await readAccountFile(compatPath)
    if (compat) return { data: compat, sourcePath: compatPath, legacyCredentialFile: false }
  }
  return loadLegacyToken()
}

async function loadWeixinAccountData(accountId: string): Promise<WeixinAccountData | null> {
  return (await loadWeixinAccountEntry(accountId))?.data ?? null
}

async function protectWeixinAccountData(
  accountId: string,
  data: WeixinAccountData,
  provider: WeixinBridgeCredentialProvider | null = credentialProvider
): Promise<{ data: WeixinAccountData; token?: string; migrated: boolean }> {
  if (data.credentialRef) {
    const token = await provider?.resolve(data.credentialRef)
    if (token?.trim()) return { data: { ...data, token: undefined }, token: token.trim(), migrated: Boolean(data.token) }
  }
  const legacyToken = data.token?.trim()
  if (!legacyToken || !provider) return { data, token: legacyToken || undefined, migrated: false }
  const credentialRef = await requirePersistentWeixinCredential(
    await provider.migrate('weixin-account', accountId, legacyToken, data.credentialRef)
  )
  const verified = await provider.resolve(credentialRef)
  if (verified !== legacyToken) throw new Error('WeChat credential migration verification failed.')
  return {
    data: {
      credentialRef,
      ...(data.baseUrl?.trim() ? { baseUrl: data.baseUrl.trim() } : {}),
      ...(data.userId?.trim() ? { userId: data.userId.trim() } : {}),
      savedAt: new Date().toISOString()
    },
    token: verified,
    migrated: true
  }
}

async function latestConfiguredWeixinAccountId(): Promise<string> {
  await loadAccountStatuses()
  const accountIds = await listIndexedWeixinAccountIds()
  for (let index = accountIds.length - 1; index >= 0; index -= 1) {
    const accountId = normalizeAccountId(accountIds[index])
    const account = await resolveWeixinAccount(accountId)
    const status = accountStatuses.get(accountId)?.status
    if (account.token?.trim() && canReuseWeixinAccountStatus(status)) return accountId
  }
  return ''
}

async function saveWeixinAccount(accountId: string, update: WeixinAccountData): Promise<void> {
  await ensureStateDirs()
  const existingEntry = await loadWeixinAccountEntry(accountId)
  const existing = existingEntry?.data ?? {}
  let credentialRef = update.credentialRef ?? existing.credentialRef
  const token = update.token?.trim() || existing.token?.trim()
  if (token) {
    if (!credentialProvider) throw new Error('Secure WeChat credential storage is unavailable.')
    credentialRef = await requirePersistentWeixinCredential(update.token?.trim()
      ? await credentialProvider.set('weixin-account', accountId, token)
      : await credentialProvider.migrate('weixin-account', accountId, token, credentialRef))
    if (await credentialProvider.resolve(credentialRef) !== token) {
      throw new Error('WeChat credential write verification failed.')
    }
  }
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl?.trim()
  const userId = update.userId !== undefined
    ? update.userId.trim() || undefined
    : existing.userId?.trim() || undefined
  await writeJsonIfChanged(accountPath(accountId), {
    ...(credentialRef ? { credentialRef, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {})
  })
  await registerWeixinAccountId(accountId)
}

async function resetWeixinConversationState(accountId: string): Promise<void> {
  for (const filePath of [syncBufPath(accountId), contextTokensPath(accountId)]) {
    try {
      await unlink(filePath)
    } catch {
      /* A first login has no previous conversation state. */
    }
  }
  const prefix = `${normalizeAccountId(accountId)}:`
  for (const key of contextTokenStore.keys()) {
    if (key.startsWith(prefix)) {
      contextTokenStore.delete(key)
      contextTokenRefs.delete(key)
    }
  }
}

function credentialRefFromValue(value: unknown): ImCredentialRefV1 | undefined {
  const raw = asRecord(value)
  return typeof raw.id === 'string' && typeof raw.storage === 'string' && typeof raw.createdAt === 'string'
    ? raw as unknown as ImCredentialRefV1
    : undefined
}

async function persistedContextCredentialRefs(accountId: string): Promise<ImCredentialRefV1[]> {
  try {
    const parsed = asRecord(await readJsonFile(contextTokensPath(accountId)))
    return Object.values(parsed).flatMap((value) => {
      const ref = credentialRefFromValue(asRecord(value).credentialRef)
      return ref ? [ref] : []
    })
  } catch {
    return []
  }
}

async function removePersistedAccountStatus(accountId: string): Promise<void> {
  await loadAccountStatuses()
  accountStatuses.delete(normalizeAccountId(accountId))
  accountStatusWritePromise = accountStatusWritePromise
    .catch(() => undefined)
    .then(() => writeJsonIfChanged(accountStatusesPath(), Object.fromEntries(accountStatuses)))
  await accountStatusWritePromise
}

async function preserveStaleAccountsForUserId(currentAccountId: string, userId: string): Promise<void> {
  if (!userId.trim()) return
  for (const id of await listIndexedWeixinAccountIds()) {
    if (id === currentAccountId) continue
    const data = await loadWeixinAccountData(id)
    if (data?.userId?.trim() !== userId) continue
    monitors.get(normalizeAccountId(id))?.controller.abort()
    await setAccountStatus(id, 'stopped', {
      message: `此旧连接已由账号 ${currentAccountId} 替代，配置保留用于诊断。`
    })
  }
}

async function resolveWeixinAccount(accountId: string): Promise<WeixinAccount> {
  const id = normalizeAccountId(accountId)
  const entry = await loadWeixinAccountEntry(id)
  const protectedAccount = entry ? await protectWeixinAccountData(id, entry.data) : undefined
  if (entry && protectedAccount?.migrated) {
    const destination = entry.legacyCredentialFile ? accountPath(id) : entry.sourcePath
    await writeJsonIfChanged(destination, protectedAccount.data)
    if (entry.legacyCredentialFile && destination !== entry.sourcePath) {
      await unlink(entry.sourcePath).catch(() => undefined)
    }
    await registerWeixinAccountId(id)
  }
  const data = protectedAccount?.data
  const token = protectedAccount?.token?.trim()
  return {
    accountId: id,
    baseUrl: data?.baseUrl?.trim() || WEIXIN_API_BASE_URL,
    cdnBaseUrl: WEIXIN_CDN_BASE_URL,
    token,
    configured: Boolean(token),
    userId: data?.userId?.trim() || undefined
  }
}

async function readBridgeConfig(): Promise<JsonRecord> {
  try {
    const parsed = await readJsonFile(configPath())
    return asRecord(parsed)
  } catch {
    try {
      const parsed = await readJsonFile(legacyOpenClawConfigPath())
      return asRecord(parsed)
    } catch {
      return {}
    }
  }
}

async function prepareBridgeState(port: number): Promise<void> {
  if (!resolveWeixinPluginRoot()) {
    throw new Error(
      'Built-in WeChat login component is missing. Reinstall RailWise AI Runtime or rebuild with @tencent-weixin/openclaw-weixin bundled.'
    )
  }
  await ensureStateDirs()
  await writeJsonIfChanged(configPath(), {
    gateway: {
      mode: 'local',
      bind: 'loopback',
      port,
      auth: { mode: 'none' }
    },
    channels: {
      [WEIXIN_PLUGIN_ID]: {
        enabled: true
      }
    }
  })
}

function isLoginFresh(login: WeixinLoginSession): boolean {
  return Date.now() - login.startedAt < LOGIN_TTL_MS
}

function purgeExpiredLogins(): void {
  for (const [key, login] of activeLogins) {
    if (!isLoginFresh(login)) activeLogins.delete(key)
  }
}

async function localTokenList(): Promise<string[]> {
  await loadAccountStatuses()
  const ids = await listIndexedWeixinAccountIds()
  const tokens: string[] = []
  for (let index = ids.length - 1; index >= 0 && tokens.length < 10; index -= 1) {
    const account = await resolveWeixinAccount(ids[index])
    const token = account.token?.trim()
    const status = accountStatuses.get(normalizeAccountId(ids[index]))?.status
    if (token && canReuseWeixinAccountStatus(status)) tokens.push(token)
  }
  return tokens
}

async function fetchQRCode(
  botType = WEIXIN_DEFAULT_BOT_TYPE,
  options: { includeLocalTokens?: boolean } = {}
): Promise<JsonRecord> {
  const includeLocalTokens = options.includeLocalTokens !== false
  const localTokens = includeLocalTokens ? await localTokenList() : []
  return apiPost(
    WEIXIN_API_BASE_URL,
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    buildWeixinQrRequest(localTokens, includeLocalTokens),
    { label: 'fetchQRCode' }
  )
}

async function pollQRStatus(baseUrl: string, qrcode: string): Promise<JsonRecord> {
  try {
    return await apiGet(
      baseUrl,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      QR_LONG_POLL_TIMEOUT_MS,
      'pollQRStatus'
    )
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return { status: 'wait' }
    logWarn('weixin-bridge', 'QR status polling failed; retrying.', {
      message: error instanceof Error ? error.message : String(error)
    })
    return { status: 'wait' }
  }
}

async function startWeixinLogin(params: JsonRecord): Promise<JsonRecord> {
  readWeixinPackageInfo()
  purgeExpiredLogins()
  const force = params.force === true
  const sessionKey = recordString(params, 'accountId') || randomUUID()
  const existing = activeLogins.get(sessionKey)
  if (!force && existing && isLoginFresh(existing) && existing.qrcodeUrl) {
    return {
      qrcode: existing.qrcodeUrl,
      qrUrl: existing.qrcodeUrl,
      qrDataUrl: existing.qrcodeUrl,
      sessionKey,
      message: '二维码已显示，请用手机微信扫描。'
    }
  }

  // An explicit reconnect must obtain a new bot token. Sending the expired
  // local token can make Tencent return binded_redirect, which confirms only
  // the server-side binding and does not provide credentials to replace it.
  const existingAccountId = force ? '' : await latestConfiguredWeixinAccountId()
  const qr = await fetchQRCode(recordString(params, 'botType') || WEIXIN_DEFAULT_BOT_TYPE, {
    includeLocalTokens: !force
  })
  const qrcode = recordString(qr, 'qrcode')
  const qrcodeUrl = recordString(qr, 'qrcode_img_content') || recordString(qr, 'qrcodeUrl')
  if (!qrcode || !qrcodeUrl) {
    throw new Error(recordString(qr, 'message') || 'WeChat QR response is incomplete.')
  }
  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode,
    qrcodeUrl,
    startedAt: Date.now(),
    currentApiBaseUrl: WEIXIN_API_BASE_URL,
    ...(existingAccountId ? { existingAccountId } : {})
  })
  return {
    qrcode: qrcodeUrl,
    qrUrl: qrcodeUrl,
    qrDataUrl: qrcodeUrl,
    sessionKey,
    message: '用手机微信扫描二维码，以继续连接。'
  }
}

async function waitForWeixinLogin(params: JsonRecord): Promise<JsonRecord> {
  const sessionKey = recordString(params, 'accountId') || recordString(params, 'sessionKey')
  const login = activeLogins.get(sessionKey)
  if (!login) return { connected: false, message: '当前没有进行中的登录，请先发起登录。' }
  if (!isLoginFresh(login)) {
    activeLogins.delete(sessionKey)
    return { connected: false, message: '二维码已过期，请重新生成。' }
  }

  const timeoutMs = Math.max(Number(params.timeoutMs) || 480_000, 1_000)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await pollQRStatus(login.currentApiBaseUrl ?? WEIXIN_API_BASE_URL, login.qrcode)
    switch (recordString(status, 'status')) {
      case 'wait':
      case 'scaned':
        break
      case 'need_verifycode':
        return {
          connected: false,
          message: '微信要求输入手机端验证码。当前 GUI 登录流程暂不支持验证码，请重新生成二维码后再试。'
        }
      case 'expired':
        activeLogins.delete(sessionKey)
        return { connected: false, message: '二维码已过期，请重新生成。' }
      case 'verify_code_blocked':
        activeLogins.delete(sessionKey)
        return { connected: false, message: '多次输入错误，连接流程已停止。请稍后再试。' }
      case 'binded_redirect':
        activeLogins.delete(sessionKey)
        if (!login.existingAccountId) {
          return {
            connected: false,
            message: '微信服务端仍保留旧绑定，但当前二维码没有下发新的登录凭据。请重新生成二维码；如持续出现，请先在微信中解除旧绑定后再连接。'
          }
        }
        return buildBoundLoginResult({
          sessionKey,
          existingAccountId: login.existingAccountId
        })
      case 'scaned_but_redirect': {
        const redirectHost = recordString(status, 'redirect_host')
        if (redirectHost) login.currentApiBaseUrl = `https://${redirectHost}`
        break
      }
      case 'confirmed': {
        const rawAccountId = recordString(status, 'ilink_bot_id')
        const token = recordString(status, 'bot_token')
        if (!rawAccountId || !token) {
          activeLogins.delete(sessionKey)
          return { connected: false, message: '登录失败：服务器未返回完整账号信息。' }
        }
        const accountId = normalizeAccountId(rawAccountId)
        const baseUrl = recordString(status, 'baseurl') || WEIXIN_API_BASE_URL
        const userId = recordString(status, 'ilink_user_id')
        await saveWeixinAccount(accountId, { token, baseUrl, userId })
        await resetWeixinConversationState(accountId)
        await setAccountStatus(accountId, 'starting', { message: '正在启动微信连接。' })
        await preserveStaleAccountsForUserId(accountId, userId)
        activeLogins.delete(sessionKey)
        return {
          connected: true,
          accountId,
          sessionKey,
          baseUrl,
          userId,
          message: '已将此 RailWise AI Runtime 连接到微信。'
        }
      }
    }
    await sleep(1_000)
  }
  activeLogins.delete(sessionKey)
  return { connected: false, message: '登录超时，请重试。' }
}

function contextTokenKey(accountId: string, userId: string): string {
  return `${accountId}:${userId}`
}

async function persistContextTokens(accountId: string): Promise<void> {
  const prefix = `${accountId}:`
  const tokens: Record<string, string | { credentialRef: ImCredentialRefV1 }> = {}
  for (const [key, value] of contextTokenStore) {
    if (!key.startsWith(prefix)) continue
    const userId = key.slice(prefix.length)
    if (!credentialProvider) {
      tokens[userId] = value
      continue
    }
    const currentRef = contextTokenRefs.get(key)
    const currentValue = currentRef ? await credentialProvider.resolve(currentRef) : undefined
    const ref = await requirePersistentWeixinCredential(currentValue === value && currentRef
      ? currentRef
      : await credentialProvider.set('weixin-context', key, value))
    if (await credentialProvider.resolve(ref) !== value) {
      throw new Error('WeChat context credential write verification failed.')
    }
    contextTokenRefs.set(key, ref)
    tokens[userId] = { credentialRef: ref }
  }
  await writeJsonIfChanged(contextTokensPath(accountId), tokens)
}

async function restoreContextTokens(accountId: string): Promise<void> {
  try {
    const parsed = await readJsonFile(contextTokensPath(accountId))
    let migrated = false
    for (const [userId, value] of Object.entries(asRecord(parsed))) {
      const key = contextTokenKey(accountId, userId)
      if (typeof value === 'string' && value) {
        contextTokenStore.set(key, value)
        if (credentialProvider) {
          const ref = await requirePersistentWeixinCredential(
            await credentialProvider.migrate('weixin-context', key, value)
          )
          if (await credentialProvider.resolve(ref) !== value) {
            throw new Error('WeChat context credential migration verification failed.')
          }
          contextTokenRefs.set(key, ref)
          migrated = true
        }
        continue
      }
      const rawRef = asRecord(asRecord(value).credentialRef)
      if (typeof rawRef.id !== 'string' || typeof rawRef.storage !== 'string' || typeof rawRef.createdAt !== 'string') continue
      const ref = rawRef as unknown as ImCredentialRefV1
      const token = await credentialProvider?.resolve(ref)
      if (!token) continue
      contextTokenRefs.set(key, ref)
      contextTokenStore.set(key, token)
    }
    if (migrated) await persistContextTokens(accountId)
  } catch {
    /* no persisted tokens */
  }
}

async function setContextToken(accountId: string, userId: string, token: string): Promise<void> {
  contextTokenStore.set(contextTokenKey(accountId, userId), token)
  await persistContextTokens(accountId)
}

function getContextToken(accountId: string, userId: string): string | undefined {
  return contextTokenStore.get(contextTokenKey(accountId, userId))
}

async function loadSyncBuf(accountId: string): Promise<string> {
  try {
    const parsed = await readJsonFile(syncBufPath(accountId))
    const value = asRecord(parsed).get_updates_buf
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

async function saveSyncBuf(accountId: string, getUpdatesBuf: string): Promise<void> {
  await writeJsonIfChanged(syncBufPath(accountId), { get_updates_buf: getUpdatesBuf })
}

async function notifyStart(account: WeixinAccount): Promise<void> {
  await apiPost(
    account.baseUrl,
    'ilink/bot/msg/notifystart',
    { base_info: buildBaseInfo() },
    { token: account.token, timeoutMs: 10_000, label: 'notifyStart' }
  )
}

async function notifyStop(account: WeixinAccount): Promise<void> {
  await apiPost(
    account.baseUrl,
    'ilink/bot/msg/notifystop',
    { base_info: buildBaseInfo() },
    { token: account.token, timeoutMs: 10_000, label: 'notifyStop' }
  )
}

async function getUpdates(
  account: WeixinAccount,
  getUpdatesBuf: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<JsonRecord> {
  try {
    return await apiPost(
      account.baseUrl,
      'ilink/bot/getupdates',
      {
        get_updates_buf: getUpdatesBuf,
        base_info: buildBaseInfo()
      },
      { token: account.token, timeoutMs, signal, label: 'getUpdates' }
    )
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf }
    }
    throw error
  }
}

function generateMessageId(): string {
  return `workwise-weixin-${randomUUID()}`
}

function buildWeixinOutboundMessageBody(params: {
  to: string
  clientId: string
  item: JsonRecord
  contextToken?: string
  runId?: string
}): JsonRecord {
  return {
    msg: {
      from_user_id: '',
      to_user_id: params.to,
      client_id: params.clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [params.item],
      context_token: params.contextToken,
      run_id: params.runId
    },
    base_info: buildBaseInfo()
  }
}

async function sendMessageWeixin(params: {
  account: WeixinAccount
  to: string
  text: string
  contextToken?: string
  runId?: string
  timeoutMs?: number
  clientId?: string
  signal?: AbortSignal
}): Promise<{ messageId: string }> {
  if (isCandidateOutboundDisabled('weixin', params.to)) {
    throw new Error('Candidate IM outbound is disabled.')
  }
  const messageId = params.clientId?.trim() || generateMessageId()
  const response = await apiPost(
    params.account.baseUrl,
    'ilink/bot/sendmessage',
    buildWeixinOutboundMessageBody({
      to: params.to,
      clientId: messageId,
      item: { type: MessageItemType.TEXT, text_item: { text: params.text } },
      contextToken: params.contextToken,
      runId: params.runId
    }),
    {
      token: params.account.token,
      timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
      signal: params.signal,
      label: 'sendMessage'
    }
  )
  const ret = Number(response.ret ?? 0)
  const errcode = Number(response.errcode ?? 0)
  if (ret !== 0 || errcode !== 0) {
    throw new Error(
      `sendMessage rejected (ret=${ret}, errcode=${errcode}, errmsg=${recordString(response, 'errmsg') || recordString(response, 'message') || 'unknown error'})`
    )
  }
  logInfo('weixin-bridge', `sent WeChat text message (messageId=${messageId}, textLen=${params.text.length})`)
  const currentStatus = accountStatuses.get(params.account.accountId)
  if (currentStatus) {
    await setAccountStatus(params.account.accountId, currentStatus.status, {
      message: currentStatus.message,
      lastOutboundAt: new Date().toISOString()
    })
  }
  return { messageId }
}

async function retryWithDelays<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[] = WEIXIN_SEND_RETRY_DELAYS_MS,
  signal?: AbortSignal
): Promise<T> {
  throwIfWeixinRetryAborted(signal)
  const attempts = delaysMs.length > 0 ? delaysMs : [0]
  let lastError: unknown = new Error('Operation failed without an error.')
  for (const delayMs of attempts) {
    if (delayMs > 0) {
      if (signal) await sleepUntilAbort(delayMs, signal)
      else await sleep(delayMs)
      throwIfWeixinRetryAborted(signal)
    }
    try {
      return await operation()
    } catch (error) {
      throwIfWeixinRetryAborted(signal)
      lastError = error
    }
  }
  throw lastError
}

function throwIfWeixinRetryAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new DOMException('WeChat delivery was aborted.', 'AbortError')
}

async function retryWithStableClientId<T>(
  requestedClientId: string | undefined,
  operation: (clientId: string) => Promise<T>,
  delaysMs: readonly number[] = WEIXIN_SEND_RETRY_DELAYS_MS,
  signal?: AbortSignal
): Promise<T> {
  const clientId = requestedClientId?.trim() || generateMessageId()
  // A client ID alone does not establish the provider's deduplication window.
  // Delivery failures are recorded for verification instead of replaying writes.
  void delaysMs
  throwIfWeixinRetryAborted(signal)
  return operation(clientId)
}

async function sendMessageWeixinWithRetry(
  params: Parameters<typeof sendMessageWeixin>[0],
  signal?: AbortSignal
): Promise<{ messageId: string }> {
  return retryWithStableClientId(params.clientId, (clientId) => sendMessageWeixin({ ...params, clientId, signal }), WEIXIN_SEND_RETRY_DELAYS_MS, signal)
}

function weixinChunkClientId(clientId: string | undefined, index: number, count: number): string | undefined {
  const stable = clientId?.trim()
  if (!stable) return undefined
  return count === 1 ? stable : `${stable}-${index + 1}`
}

async function sendWeixinTextWithRetry(
  params: Parameters<typeof sendMessageWeixin>[0],
  beforeSend?: () => void,
  signal?: AbortSignal
): Promise<{ messageId: string }> {
  const chunks = splitWeixinText(params.text)
  let firstMessageId = ''
  for (let index = 0; index < chunks.length; index += 1) {
    beforeSend?.()
    const stableClientId = weixinChunkClientId(params.clientId, index, chunks.length)
    const sent = await sendMessageWeixinWithRetry({
      ...params,
      text: chunks[index],
      clientId: stableClientId
    }, signal)
    if (!firstMessageId) firstMessageId = sent.messageId
    logInfo('weixin-bridge', `delivered WeChat reply chunk ${index + 1}/${chunks.length} (textLen=${chunks[index].length})`)
  }
  return { messageId: firstMessageId }
}

function textFromItemList(itemList: unknown): string {
  if (!Array.isArray(itemList)) return ''
  for (const item of itemList) {
    const record = asRecord(item)
    if (record.type === MessageItemType.TEXT) {
      const text = asRecord(record.text_item).text
      if (text != null) return String(text).trim()
    }
    if (record.type === MessageItemType.VOICE) {
      const text = asRecord(record.voice_item).text
      if (text != null) return String(text).trim()
    }
  }
  return ''
}

function buildWebhookMessage(
  message: WeixinMessage,
  accountId: string,
  text: string,
  messageId = weixinMessageId(message) || generateMessageId()
): JsonRecord {
  const from = message.from_user_id || ''
  return {
    provider: 'weixin',
    platform: 'weixin',
    text,
    sender: from || 'WeChat',
    from,
    chatId: from,
    messageId,
    senderId: from,
    senderName: from || 'WeChat',
    threadId: '',
    message: {
      provider: 'weixin',
      text,
      sender: from || 'WeChat',
      accountId
    }
  }
}

const MAX_WEBHOOK_FILES_PER_REPLY = 3

type WeixinOutboundFile = { path: string; fileName: string }

/**
 * Generated files the Claw webhook attached to its reply (already gated and
 * workspace-validated on the GUI side). Capped defensively; the webhook caps
 * extraction at the same count.
 */
function webhookGeneratedFiles(result: JsonRecord): WeixinOutboundFile[] {
  if (!Array.isArray(result.files)) return []
  const files: WeixinOutboundFile[] = []
  for (const entry of result.files) {
    const record = asRecord(entry)
    const path = recordString(record, 'path')
    if (!path) continue
    files.push({
      path,
      fileName: recordString(record, 'fileName') || path.split(/[\\/]/).pop() || 'attachment'
    })
    if (files.length >= MAX_WEBHOOK_FILES_PER_REPLY) break
  }
  return files
}

type SendWeixinMediaFile = (params: {
  filePath: string
  fileName?: string
  to: string
  text: string
  clientId: string
  runId?: string
  opts: { baseUrl: string; token?: string; timeoutMs?: number; contextToken?: string }
  cdnBaseUrl: string
  beforeProviderSend?: () => void
  signal?: AbortSignal
}) => Promise<{ messageId: string }>

type UploadedWeixinMedia = {
  downloadEncryptedQueryParam: string
  aeskey: string
  fileSize: number
  fileSizeCiphertext: number
}

type WeixinMediaUploadModule = {
  uploadVideoToWeixin: (params: JsonRecord) => Promise<UploadedWeixinMedia>
  uploadFileToWeixin: (params: JsonRecord) => Promise<UploadedWeixinMedia>
  uploadFileAttachmentToWeixin: (params: JsonRecord) => Promise<UploadedWeixinMedia>
}

type WeixinMimeModule = {
  getMimeFromFilename: (filePath: string) => string
}

type WeixinMediaDelivery = {
  sent: WeixinOutboundFile[]
  failed: Array<{ file: WeixinOutboundFile; message: string }>
}

type LoadWeixinMediaFile = () => Promise<SendWeixinMediaFile>

async function deliverWeixinFilesBeforeSuccessText<T>(
  files: readonly WeixinOutboundFile[],
  sendFiles: () => Promise<WeixinMediaDelivery>,
  sendText: () => Promise<T>,
  beforeSend?: () => void
): Promise<T> {
  beforeSend?.()
  if (files.length > 0) {
    const mediaDelivery = await sendFiles()
    if (mediaDelivery.failed.length > 0) {
      throw new Error(`WeChat file delivery failed: ${mediaDelivery.failed[0]?.message || 'unknown upload error'}`)
    }
  }
  beforeSend?.()
  return sendText()
}

let sendWeixinMediaFilePromise: Promise<SendWeixinMediaFile> | null = null

function encodeWeixinCdnAesKey(aesKeyHex: string): string {
  // Tencent's outbound file contract uses base64(hex text), not base64(raw
  // key bytes). The receiver decodes the 32 ASCII hex characters first and
  // then parses them into the 16-byte AES key.
  if (!/^[0-9a-f]{32}$/i.test(aesKeyHex)) {
    throw new Error('Invalid WeChat CDN AES key')
  }
  return Buffer.from(aesKeyHex.toLowerCase(), 'utf8').toString('base64')
}

async function validateUploadedWeixinMedia(
  filePath: string,
  uploaded: UploadedWeixinMedia
): Promise<void> {
  const expected = await readFile(filePath)
  if (expected.byteLength !== uploaded.fileSize) {
    throw new Error(
      `WeChat CDN verification failed: source size changed during upload (${expected.byteLength} != ${uploaded.fileSize}).`
    )
  }
  if (!uploaded.downloadEncryptedQueryParam.trim()) {
    throw new Error('WeChat CDN upload returned an empty download parameter.')
  }
  encodeWeixinCdnAesKey(uploaded.aeskey)
  if (!Number.isSafeInteger(uploaded.fileSizeCiphertext) || uploaded.fileSizeCiphertext <= 0) {
    throw new Error('WeChat CDN upload returned an invalid encrypted file size.')
  }
}

/**
 * Reuse the bundled plugin's encrypted CDN uploader, but send the resulting
 * media item here so retries can retain the ledger's stable client id.
 */
function createSendWeixinMediaFile(
  upload: WeixinMediaUploadModule,
  mime: WeixinMimeModule,
  post: typeof apiPost = apiPost
): SendWeixinMediaFile {
  return async (params): Promise<{ messageId: string }> => {
    const uploadOptions = {
      filePath: params.filePath,
      toUserId: params.to,
      opts: { baseUrl: params.opts.baseUrl, token: params.opts.token },
      cdnBaseUrl: params.cdnBaseUrl
    }
    const contentType = mime.getMimeFromFilename(params.filePath)
    let uploaded: UploadedWeixinMedia
    let item: JsonRecord
    if (contentType.startsWith('video/')) {
      uploaded = await upload.uploadVideoToWeixin(uploadOptions) as UploadedWeixinMedia
      item = {
        type: MessageItemType.VIDEO,
        video_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: encodeWeixinCdnAesKey(uploaded.aeskey),
            encrypt_type: 1
          },
          video_size: uploaded.fileSizeCiphertext
        }
      }
    } else if (contentType.startsWith('image/')) {
      uploaded = await upload.uploadFileToWeixin(uploadOptions) as UploadedWeixinMedia
      item = {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: encodeWeixinCdnAesKey(uploaded.aeskey),
            encrypt_type: 1
          },
          mid_size: uploaded.fileSizeCiphertext
        }
      }
    } else {
      const fileName = params.fileName?.trim() || basename(params.filePath)
      uploaded = await upload.uploadFileAttachmentToWeixin({ ...uploadOptions, fileName }) as UploadedWeixinMedia
      item = {
        type: MessageItemType.FILE,
        file_item: {
          media: {
            encrypt_query_param: uploaded.downloadEncryptedQueryParam,
            aes_key: encodeWeixinCdnAesKey(uploaded.aeskey),
            encrypt_type: 1
          },
          file_name: fileName,
          len: String(uploaded.fileSize)
        }
      }
    }
    await validateUploadedWeixinMedia(params.filePath, uploaded)
    // The CDN upload can outlive the provider-delivery lease. Revalidate at
    // the last possible point before the irreversible provider send.
    params.beforeProviderSend?.()
    const response = await post(
      params.opts.baseUrl,
      'ilink/bot/sendmessage',
      buildWeixinOutboundMessageBody({
        to: params.to,
        clientId: params.clientId,
        item,
        contextToken: params.opts.contextToken,
        runId: params.runId
      }),
      {
        token: params.opts.token,
        timeoutMs: params.opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
        signal: params.signal,
        label: 'sendMediaMessage'
      }
    )
    const ret = Number(response.ret ?? 0)
    const errcode = Number(response.errcode ?? 0)
    if (ret !== 0 || errcode !== 0) {
      throw new Error(
        `sendMediaMessage rejected (ret=${ret}, errcode=${errcode}, errmsg=${recordString(response, 'errmsg') || recordString(response, 'message') || 'unknown error'})`
      )
    }
    logInfo(
      'weixin-bridge',
      `sent WeChat media message (messageId=${params.clientId}, fileName=${basename(params.filePath)}, bytes=${uploaded.fileSize})`
    )
    return { messageId: params.clientId }
  }
}

function loadSendWeixinMediaFile(): Promise<SendWeixinMediaFile> {
  const uploadModuleId: string = '@tencent-weixin/openclaw-weixin/dist/src/cdn/upload.js'
  const mimeModuleId: string = '@tencent-weixin/openclaw-weixin/dist/src/media/mime.js'
  sendWeixinMediaFilePromise ??= Promise.all([
    import(uploadModuleId) as Promise<WeixinMediaUploadModule>,
    import(mimeModuleId) as Promise<WeixinMimeModule>
  ])
    .then(([upload, mime]) => createSendWeixinMediaFile(upload, mime))
    .catch((error) => {
      sendWeixinMediaFilePromise = null
      throw error
    })
  return sendWeixinMediaFilePromise
}

/**
 * Upload each generated file to the WeChat C2C CDN and deliver it as an
 * image / video / file message (routed by MIME). Any failed file makes the
 * delivery fail so the ledger can retry it with the same outbound id.
 */
async function sendGeneratedFilesWeixin(
  account: WeixinAccount,
  to: string,
  files: readonly WeixinOutboundFile[],
  contextToken: string | undefined,
  runId?: string,
  outboundId?: string,
  loadMediaFile: LoadWeixinMediaFile = loadSendWeixinMediaFile,
  beforeSend?: () => void,
  signal?: AbortSignal
): Promise<WeixinMediaDelivery> {
  if (isCandidateOutboundDisabled('weixin', to)) {
    const message = 'Candidate IM outbound is disabled.'
    return {
      sent: [],
      failed: files.map((file) => ({ file, message }))
    }
  }
  const sent: WeixinOutboundFile[] = []
  const failed: Array<{ file: WeixinOutboundFile; message: string }> = []
  for (const [index, file] of files.entries()) {
    try {
      beforeSend?.()
      const sendWeixinMediaFile = await loadMediaFile()
      const clientId = outboundId?.trim() ? `${outboundId.trim()}-file-${index + 1}` : undefined
      await retryWithStableClientId(clientId, (stableClientId) => {
        beforeSend?.()
        return sendWeixinMediaFile({
          filePath: file.path,
          fileName: file.fileName,
          to,
          text: '',
          clientId: stableClientId,
          runId,
          opts: { baseUrl: account.baseUrl, token: account.token, contextToken },
          cdnBaseUrl: account.cdnBaseUrl,
          beforeProviderSend: beforeSend,
          signal
        })
      }, WEIXIN_SEND_RETRY_DELAYS_MS, signal)
      sent.push(file)
    } catch (error) {
      if (error instanceof WorkWiseDeliveryLeaseLostError) throw error
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ file, message })
      logWarn('weixin-bridge', 'Failed to send generated file to WeChat.', {
        accountId: account.accountId,
        filePath: file.path,
        message
      })
    }
  }
  return { sent, failed }
}

async function postToWorkWiseWebhook(message: WeixinMessage, accountId: string): Promise<JsonRecord> {
  const settings = await resolveRuntimeContext()
  const text = textFromItemList(message.item_list)
  if (!text) return { reply: 'Only text messages are supported right now.' }
  const messageId = weixinMessageId(message) || generateMessageId()
  const body = {
    ...buildWebhookMessage(message, accountId, text, messageId),
    channelId: settings.channelId || undefined
  }
  logInfo('weixin-bridge', `received WeChat inbound message (accountId=${accountId}, messageId=${messageId}, textLen=${text.length})`)
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (settings.webhookSecret) {
    headers.authorization = `Bearer ${settings.webhookSecret}`
    headers['x-workwise-secret'] = settings.webhookSecret
  }
  const res = await fetch(settings.webhookUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(650_000)
  })
  const data = await readJsonResponse(res)
  if (!res.ok || data.ok === false) {
    const reply = webhookReplyText(data) || safeWeixinFailureReply(recordString(data, 'message'))
    logWarn('weixin-bridge', 'RailWise AI webhook did not produce a successful result.', {
      accountId,
      messageId,
      status: res.status,
      message: recordString(data, 'message'),
      hasReply: Boolean(webhookReplyText(data)),
      deliveringReply: true
    })
    return { ...data, reply }
  }
  // The webhook handler owns the inbound lease only until it writes this
  // response. Acquire the provider-send phase before any CDN upload so a
  // recovery worker cannot start a duplicate delivery in the gap.
  try {
    const deliveryLeaseUntil = await reportWorkWiseDelivery(data, 'start')
    if (deliveryLeaseUntil) data.deliveryLeaseUntil = deliveryLeaseUntil
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logWarn('weixin-bridge', 'RailWise AI delivery lease could not be acquired.', {
      accountId,
      messageId,
      message
    })
    return {
      ...data,
      ok: false,
      deliveryLeaseLost: true,
      message,
      reply: safeWeixinFailureReply(message)
    }
  }
  logInfo('weixin-bridge', `RailWise AI webhook completed for WeChat message (accountId=${accountId}, messageId=${messageId}, hasReply=${Boolean(webhookReplyText(data))})`)
  return data
}

type WorkWiseDeliveryPhase = 'start' | 'renew' | 'complete'

async function reportWorkWiseDelivery(
  result: JsonRecord,
  phase: WorkWiseDeliveryPhase,
  ok?: boolean,
  message?: string
): Promise<string | undefined> {
  const deliveryId = recordString(result, 'deliveryId')
  const outboundId = recordString(result, 'outboundId')
  const leaseRunId = recordString(result, 'deliveryLeaseRunId')
  if (!deliveryId || !outboundId) return undefined
  if (!leaseRunId) {
    if (phase === 'complete') return undefined
    throw new Error('RailWise AI delivery response did not include a lease owner.')
  }
  const settings = await resolveRuntimeContext()
  const receiptUrl = new URL(settings.webhookUrl)
  receiptUrl.pathname = `${receiptUrl.pathname.replace(/\/$/, '')}/delivery`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (settings.webhookSecret) {
    headers.authorization = `Bearer ${settings.webhookSecret}`
    headers['x-workwise-secret'] = settings.webhookSecret
  }
  const response = await fetch(receiptUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      deliveryId,
      outboundId,
      leaseRunId,
      phase,
      ...(phase === 'complete' ? { ok: ok === true, message } : {})
    }),
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) {
    if (response.status === 409) {
      throw new WorkWiseDeliveryLeaseLostError()
    }
    throw new Error(`RailWise AI delivery receipt failed with HTTP ${response.status}.`)
  }
  const receipt = await readJsonResponse(response)
  return recordString(receipt, 'leaseUntil') || undefined
}

type WorkWiseDeliveryLeaseHeartbeat = {
  stop: () => void
  assertOwned: () => void
}

function workWiseDeliveryLeaseDeadline(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function startWorkWiseDeliveryLeaseHeartbeat(
  result: JsonRecord,
  options: {
    renew?: typeof reportWorkWiseDelivery
    now?: () => number
    intervalMs?: number
  } = {}
): WorkWiseDeliveryLeaseHeartbeat {
  if (!recordString(result, 'deliveryId') || !recordString(result, 'outboundId') || !recordString(result, 'deliveryLeaseRunId')) {
    return { stop: () => undefined, assertOwned: () => undefined }
  }
  const renew = options.renew ?? reportWorkWiseDelivery
  const now = options.now ?? Date.now
  let lost = false
  let lastConfirmedLeaseDeadline = workWiseDeliveryLeaseDeadline(result.deliveryLeaseUntil) ?? 0
  const markExpired = (): void => {
    if (lost || now() < lastConfirmedLeaseDeadline) return
    lost = true
  }
  const timer = setInterval(() => {
    if (lost) return
    void renew(result, 'renew').then((leaseUntil) => {
      if (lost) return
      const deadline = workWiseDeliveryLeaseDeadline(leaseUntil)
      if (deadline !== undefined) lastConfirmedLeaseDeadline = deadline
      else markExpired()
    }).catch((error) => {
      if (error instanceof WorkWiseDeliveryLeaseLostError) lost = true
      else markExpired()
      logWarn('weixin-bridge', 'Failed to renew the RailWise AI delivery lease while sending.', {
        message: error instanceof Error ? error.message : String(error)
      })
    })
  }, options.intervalMs ?? IM_LEDGER_LEASE_RENEW_INTERVAL_MS)
  timer.unref?.()
  return {
    stop: () => clearInterval(timer),
    assertOwned: () => {
      markExpired()
      if (lost) throw new WorkWiseDeliveryLeaseLostError()
    }
  }
}

async function monitorWeixinAccount(accountId: string, signal: AbortSignal): Promise<void> {
  const account = await resolveWeixinAccount(accountId)
  if (!account.configured || !account.token?.trim()) {
    await setAccountStatus(accountId, 'error', {
      message: '微信账号凭据不存在。',
      reasonCode: 'credential_missing'
    })
    throw new Error(`WeChat account is not configured: ${accountId}`)
  }
  const monitor = monitors.get(account.accountId)
  const runId = monitor?.runId ?? randomUUID()
  const startedAt = monitor?.startedAt ?? new Date().toISOString()
  await setAccountStatus(account.accountId, 'starting', {
    message: '正在连接微信。',
    runId,
    startedAt,
    failureCount: 0,
    reasonCode: 'none'
  })
  await restoreContextTokens(account.accountId)
  try {
    await notifyStart(account)
  } catch (error) {
    logWarn('weixin-bridge', 'WeChat monitor could not notify the upstream session start.', {
      accountId: account.accountId,
      message: error instanceof Error ? error.message : String(error)
    })
  }

  logInfo('weixin-bridge', `WeChat monitor started (accountId=${account.accountId})`)

  let getUpdatesBuf = await loadSyncBuf(account.accountId)
  let nextTimeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS
  let consecutiveFailures = 0
  // Per-sender dispatch chains. A single agent turn can run for minutes;
  // awaiting it inside the long-poll loop froze the whole channel for
  // every chat until that turn finished (or hit the webhook timeout).
  // Chaining per sender keeps one conversation ordered while other chats
  // and the poll loop keep moving.
  const senderChains = new Map<string, Promise<void>>()
  const dispatchToSender = (message: WeixinMessage, to: string, contextToken: string | undefined): void => {
    const messageRunId = randomUUID()
    const task = async (): Promise<void> => {
      if (signal.aborted) return
      const slowReply = { promise: null as Promise<void> | null }
      const slowReplyTimer = setTimeout(() => {
        slowReply.promise = sendMessageWeixinWithRetry({
          account,
          to,
          text: WEIXIN_SLOW_REPLY_TEXT,
          contextToken,
          runId: messageRunId
        }, signal).then(() => undefined).catch((error) => {
          logWarn('weixin-bridge', 'Failed to send WeChat processing notice.', {
            accountId: account.accountId,
            message: error instanceof Error ? error.message : String(error)
          })
        })
      }, WEIXIN_SLOW_REPLY_NOTICE_MS)
      let result: JsonRecord
      try {
        result = await postToWorkWiseWebhook(message, account.accountId)
      } finally {
        clearTimeout(slowReplyTimer)
      }
      if (slowReply.promise) await slowReply.promise
      const reply = recordString(result, 'reply') || recordString(result, 'text')
      try {
        if (result.deliveryLeaseLost === true) return
        if (!reply) throw new Error('RailWise AI webhook completed without a text reply.')
        const files = webhookGeneratedFiles(result)
        const outboundId = recordString(result, 'outboundId') || undefined
        const deliveryLease = startWorkWiseDeliveryLeaseHeartbeat(result)
        try {
          await deliverWeixinFilesBeforeSuccessText(
            files,
            () => sendGeneratedFilesWeixin(
              account,
              to,
              files,
              contextToken,
              messageRunId,
              outboundId,
              undefined,
              deliveryLease.assertOwned,
              signal
            ),
            () => sendWeixinTextWithRetry({
              account,
              to,
              text: reply,
              contextToken,
              runId: messageRunId,
              clientId: outboundId
            }, deliveryLease.assertOwned, signal),
            deliveryLease.assertOwned
          )
          deliveryLease.assertOwned()
          await reportWorkWiseDelivery(result, 'complete', true)
        } finally {
          deliveryLease.stop()
        }
      } catch (error) {
        if (error instanceof WorkWiseDeliveryLeaseLostError) return
        await reportWorkWiseDelivery(result, 'complete', false, error instanceof Error ? error.message : String(error)).catch((receiptError) => {
          logWarn('weixin-bridge', 'Failed to record WeChat delivery failure in the RailWise AI ledger.', {
            accountId: account.accountId,
            message: receiptError instanceof Error ? receiptError.message : String(receiptError)
          })
        })
        throw error
      }
    }
    const chained = (senderChains.get(to) ?? Promise.resolve())
      .then(task)
      .catch(async (error) => {
        logWarn('weixin-bridge', 'WeChat message dispatch failed.', {
          accountId: account.accountId,
          message: error instanceof Error ? error.message : String(error)
        })
        if (signal.aborted) return
        await sendMessageWeixinWithRetry({
          account,
          to,
          text: error instanceof WeixinWebhookError
            ? error.replyText
            : safeWeixinFailureReply(error instanceof Error ? error.message : String(error)),
          contextToken,
          runId: messageRunId
        }, signal).catch((sendError) => {
          logWarn('weixin-bridge', 'Failed to send WeChat failure notice.', {
            accountId: account.accountId,
            message: sendError instanceof Error ? sendError.message : String(sendError)
          })
        })
      })
    senderChains.set(to, chained)
    void chained.finally(() => {
      if (senderChains.get(to) === chained) senderChains.delete(to)
    })
  }
  while (!signal.aborted) {
    try {
      const resp = await getUpdates(account, getUpdatesBuf, nextTimeoutMs, signal)
      if (typeof resp.longpolling_timeout_ms === 'number' && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms
      }
      const ret = Number(resp.ret ?? 0)
      const errcode = Number(resp.errcode ?? 0)
      if (ret !== 0 || errcode !== 0) {
        logWarn('weixin-bridge', 'WeChat getUpdates returned an error.', {
          accountId: account.accountId,
          ret,
          errcode,
          errmsg: recordString(resp, 'errmsg')
        })
        if (isWeixinSessionExpiredResponse(resp)) {
          await setAccountStatus(account.accountId, 'expired', {
            message: '微信连接已过期，请重新扫码。',
            errorCode: WEIXIN_SESSION_EXPIRED_ERRCODE,
            runId,
            startedAt,
            lastErrorAt: new Date().toISOString(),
            reasonCode: 'auth_expired'
          })
          logWarn('weixin-bridge', 'WeChat monitor paused because the session expired. Scan a new QR code to reconnect.', {
            accountId: account.accountId,
            errcode: WEIXIN_SESSION_EXPIRED_ERRCODE
          })
          break
        }
        consecutiveFailures += 1
        const delayMs = retryDelayMs(consecutiveFailures)
        await setAccountStatus(account.accountId, 'retrying', {
          message: '微信网络连接异常，正在重试。',
          runId,
          startedAt,
          failureCount: consecutiveFailures,
          nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
          lastErrorAt: new Date().toISOString(),
          reasonCode: 'network'
        })
        await sleepUntilAbort(delayMs, signal)
        continue
      }
      consecutiveFailures = 0
      await setAccountStatus(account.accountId, 'connected', {
        message: '微信已连接。',
        lastSuccessfulPollAt: new Date().toISOString(),
        runId,
        startedAt,
        failureCount: 0,
        reasonCode: 'none'
      })
      const nextBuf = typeof resp.get_updates_buf === 'string' ? resp.get_updates_buf : ''
      if (nextBuf) {
        getUpdatesBuf = nextBuf
        await saveSyncBuf(account.accountId, getUpdatesBuf)
      }
      const messages = Array.isArray(resp.msgs) ? resp.msgs as WeixinMessage[] : []
      if (messages.length > 0) {
        logInfo('weixin-bridge', `received ${messages.length} WeChat inbound message(s) from getUpdates (accountId=${account.accountId})`)
        await setAccountStatus(account.accountId, 'connected', {
          runId,
          lastInboundAt: new Date().toISOString(),
          reasonCode: 'none'
        })
      }
      for (const message of messages) {
        if (signal.aborted) return
        if (message.message_type === MessageType.BOT) continue
        const to = message.from_user_id || ''
        if (!to) continue
        const contextToken = message.context_token?.trim() || getContextToken(account.accountId, to)
        if (message.context_token?.trim()) await setContextToken(account.accountId, to, message.context_token.trim())
        dispatchToSender(message, to, contextToken)
      }
    } catch (error) {
      if (signal.aborted) return
      logWarn('weixin-bridge', 'WeChat monitor iteration failed.', {
        accountId: account.accountId,
        message: error instanceof Error ? error.message : String(error)
      })
      consecutiveFailures += 1
      const delayMs = retryDelayMs(consecutiveFailures)
      await setAccountStatus(account.accountId, 'retrying', {
        message: '微信连接异常，正在重试。',
        runId,
        startedAt,
        failureCount: consecutiveFailures,
        nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
        lastErrorAt: new Date().toISOString(),
        reasonCode: 'network'
      })
      await sleepUntilAbort(delayMs, signal)
    }
  }

  try {
    await notifyStop(account)
  } catch {
    /* best-effort */
  }
}

function weixinMonitorHeartbeatTime(status: WeixinPersistedAccountStatus): number {
  const reference = status.status === 'starting'
    ? status.startedAt ?? status.updatedAt ?? ''
    : status.lastSuccessfulPollAt ?? status.startedAt ?? status.updatedAt ?? ''
  return Date.parse(reference)
}

async function startAccountMonitor(accountId: string): Promise<void> {
  const normalized = normalizeAccountId(accountId)
  const existing = monitors.get(normalized)
  if (existing && !existing.controller.signal.aborted) return
  const controller = new AbortController()
  const runId = randomUUID()
  const startedAt = new Date().toISOString()
  let restartRequested = false
  const initialStatus = setAccountStatus(normalized, 'starting', {
    message: '正在连接微信。',
    runId,
    startedAt,
    failureCount: 0,
    reasonCode: 'none'
  })
  const watchdog = setInterval(() => {
    const current = accountStatuses.get(normalized)
    if (!current || controller.signal.aborted) return
    const heartbeat = weixinMonitorHeartbeatTime(current)
    const deadline = current.status === 'starting' ? 90_000 : IM_STALE_AFTER_MS
    if (Number.isFinite(heartbeat) && Date.now() - heartbeat <= deadline) return
    void setAccountStatus(normalized, 'stale', {
      message: '微信连接心跳超时，正在重新连接。',
      runId,
      startedAt,
      failureCount: (current.failureCount ?? 0) + 1,
      nextRetryAt: new Date(Date.now() + retryDelayMs((current.failureCount ?? 0) + 1)).toISOString(),
      lastErrorAt: new Date().toISOString(),
      reasonCode: current.status === 'starting' ? 'first_poll_timeout' : 'poll_stale'
    })
    restartRequested = true
    controller.abort()
  }, IM_HEALTH_SUPERVISOR_INTERVAL_MS)
  const promise = initialStatus.then(() => monitorWeixinAccount(normalized, controller.signal)).catch(async (error) => {
    if (!controller.signal.aborted) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : ''
      const current = accountStatuses.get(normalized)
      if (current?.reasonCode !== 'credential_missing') {
        const failureCount = (current?.failureCount ?? 0) + 1
        const credentialUnavailable = code === 'credential_unavailable'
        await setAccountStatus(normalized, 'error', {
          message: code === 'credential_unavailable'
            ? '现有微信凭据仍在，请通过“重新连接”恢复系统钥匙串访问。'
            : '微信连接进程异常，正在准备重试。',
          runId,
          startedAt,
          failureCount,
          ...(credentialUnavailable
            ? { nextRetryAt: undefined }
            : { nextRetryAt: new Date(Date.now() + retryDelayMs(failureCount)).toISOString() }),
          lastErrorAt: new Date().toISOString(),
          reasonCode: credentialUnavailable ? 'credential_unavailable' : 'bridge_unavailable'
        })
      }
      logError('weixin-bridge', 'WeChat monitor stopped.', {
        accountId: normalized,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }).finally(() => {
    clearInterval(watchdog)
    if (monitors.get(normalized)?.controller === controller) monitors.delete(normalized)
    const current = accountStatuses.get(normalized)
    if (shouldRestartWeixinMonitor(controller.signal.aborted, restartRequested, current?.status, current?.reasonCode)) {
      const retryTimer = setTimeout(() => {
        const latest = accountStatuses.get(normalized)
        if (bridgeRuntimeStopping || !canAutomaticallyStartWeixinMonitor(latest?.status, latest?.reasonCode)) return
        void startAccountMonitor(normalized)
      }, retryDelayMs((current?.failureCount ?? 0) + 1))
      retryTimer.unref?.()
    }
  })
  monitors.set(normalized, { accountId: normalized, runId, startedAt, controller, promise, watchdog })
  await initialStatus
}

function shouldRestartWeixinMonitor(
  aborted: boolean,
  restartRequested: boolean,
  status: WeixinPersistedAccountStatus['status'] | undefined,
  reasonCode?: string
): boolean {
  if (
    reasonCode === 'credential_missing' ||
    reasonCode === 'credential_unavailable' ||
    reasonCode === 'auth_expired' ||
    reasonCode === 'user_stopped'
  ) return false
  return (restartRequested || !aborted) && status !== 'expired' && status !== 'stopped'
}

function canAutomaticallyStartWeixinMonitor(
  status: WeixinPersistedAccountStatus['status'] | undefined,
  reasonCode?: string
): boolean {
  if (status === 'expired' || status === 'stopped') return false
  // A locked Keychain requires an explicit reconnect. Retrying during app
  // startup would reopen the macOS authorization prompt without user intent.
  return reasonCode !== 'credential_missing' &&
    reasonCode !== 'credential_unavailable' &&
    reasonCode !== 'auth_expired' &&
    reasonCode !== 'user_stopped'
}

async function startWeixinChannels(params: JsonRecord): Promise<JsonRecord> {
  await loadAccountStatuses()
  const requestedAccountId = recordString(params, 'accountId')
  const accountIds = requestedAccountId
    ? [normalizeAccountId(requestedAccountId)]
    : await listIndexedWeixinAccountIds()
  const startable = requestedAccountId
    ? accountIds
    : accountIds.filter((accountId) => {
        const persisted = accountStatuses.get(normalizeAccountId(accountId))
        return canAutomaticallyStartWeixinMonitor(persisted?.status, persisted?.reasonCode)
      })
  await Promise.all(startable.map((accountId) => startAccountMonitor(accountId)))
  return { started: startable }
}

async function abortWeixinMonitors(activeMonitors: readonly WeixinMonitor[]): Promise<void> {
  for (const monitor of activeMonitors) monitor.controller.abort()
  await Promise.allSettled(activeMonitors.map((monitor) => monitor.promise))
}

async function stopWeixinChannels(params: JsonRecord): Promise<JsonRecord> {
  const requestedAccountId = recordString(params, 'accountId')
  const targets = requestedAccountId ? [normalizeAccountId(requestedAccountId)] : [...monitors.keys()]
  const activeMonitors = targets
    .map((accountId) => monitors.get(accountId))
    .filter((monitor): monitor is WeixinMonitor => monitor != null)
  for (const monitor of activeMonitors) {
    if (monitors.get(monitor.accountId) === monitor) monitors.delete(monitor.accountId)
  }
  await abortWeixinMonitors(activeMonitors)
  for (const accountId of targets) {
    await setAccountStatus(accountId, 'stopped', {
      message: '微信连接已暂停。',
      reasonCode: 'user_stopped'
    })
  }
  return { stopped: targets }
}

export async function startWeixinBridgeAccount(accountId: string): Promise<void> {
  await ensureWeixinBridgeRpcUrl()
  await startWeixinChannels({ accountId })
}

export async function stopWeixinBridgeAccount(accountId: string): Promise<void> {
  await stopWeixinChannels({ accountId })
}

export async function reconnectWeixinBridgeAccount(accountId: string): Promise<void> {
  await stopWeixinChannels({ accountId })
  await ensureWeixinBridgeRpcUrl()
  await startWeixinChannels({ accountId })
}

export async function disconnectWeixinBridgeAccount(accountId: string): Promise<void> {
  const normalized = normalizeAccountId(accountId)
  const monitor = monitors.get(normalized)
  monitor?.controller.abort()
  monitors.delete(normalized)
  await setAccountStatus(normalized, 'stopped', {
    message: '微信连接已断开，正在清除凭据。',
    reasonCode: 'user_stopped'
  })
  await monitor?.promise

  const entry = await loadWeixinAccountEntry(normalized)
  const refs = new Map<string, ImCredentialRefV1>()
  const addRef = (ref: ImCredentialRefV1 | undefined): void => {
    if (ref) refs.set(`${ref.storage}:${ref.id}`, ref)
  }
  addRef(entry?.data.credentialRef)
  for (const ref of await persistedContextCredentialRefs(normalized)) addRef(ref)
  const prefix = `${normalized}:`
  for (const [key, ref] of contextTokenRefs) {
    if (key.startsWith(prefix)) addRef(ref)
  }
  if (refs.size > 0 && !credentialProvider) {
    throw new Error('Secure WeChat credential storage is unavailable; credentials were not removed.')
  }
  await Promise.all([...refs.values()].map((ref) => credentialProvider?.remove(ref)))

  const rawId = deriveRawAccountId(normalized)
  const files = new Set([
    accountPath(normalized),
    syncBufPath(normalized),
    contextTokensPath(normalized),
    ...(rawId ? [accountPath(rawId), syncBufPath(rawId), contextTokensPath(rawId)] : []),
    ...(entry ? [entry.sourcePath] : [])
  ])
  await Promise.all([...files].map((filePath) => unlink(filePath).catch(() => undefined)))
  const remainingAccountIds = (await listIndexedWeixinAccountIds())
    .filter((id) => normalizeAccountId(id) !== normalized)
  await writeJsonIfChanged(accountsIndexPath(), remainingAccountIds)

  for (const key of [...contextTokenStore.keys()]) {
    if (!key.startsWith(prefix)) continue
    contextTokenStore.delete(key)
    contextTokenRefs.delete(key)
  }
  for (const [sessionKey, login] of activeLogins) {
    if (normalizeAccountId(login.existingAccountId ?? '') === normalized) activeLogins.delete(sessionKey)
  }
  await removePersistedAccountStatus(normalized)
}

async function dispatchRpc(method: string, params: JsonRecord): Promise<JsonRecord> {
  switch (method) {
    case 'web.login.start':
      return startWeixinLogin(params)
    case 'web.login.wait':
      return waitForWeixinLogin(params)
    case 'channels.start':
      if (recordString(params, 'channel') && recordString(params, 'channel') !== WEIXIN_PLUGIN_ID) {
        throw new Error(`Unsupported channel: ${recordString(params, 'channel')}`)
      }
      return startWeixinChannels(params)
    case 'channels.stop':
      return stopWeixinChannels(params)
    case 'accounts.list':
      return { accounts: await listIndexedWeixinAccountIds() }
    default:
      throw new Error(`Unknown WeChat bridge method: ${method}`)
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(body)}\n`)
}

async function handleBridgeRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${activeBridgePort}`)
    if (request.method === 'GET' && url.pathname === '/health') {
      writeJson(response, 200, { ok: true, status: 'live' })
      return
    }
    if (request.method !== 'POST' || url.pathname !== '/api/v1/admin/rpc') {
      writeJson(response, 404, { ok: false, message: 'Not found' })
      return
    }
    const body = asRecord(JSON.parse(await readRequestBody(request)) as unknown)
    const id = body.id ?? null
    const method = recordString(body, 'method')
    const params = asRecord(body.params)
    if (!method) throw new Error('JSON-RPC method is required.')
    const result = await dispatchRpc(method, params)
    writeJson(response, 200, { jsonrpc: '2.0', id, ok: true, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    writeJson(response, 200, {
      jsonrpc: '2.0',
      id: null,
      ok: false,
      error: { message }
    })
  }
}

async function fetchBridgeHealth(port = activeBridgePort): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(WEIXIN_BRIDGE_HEALTH_TIMEOUT_MS)
    })
    if (!res.ok) return false
    const data = await res.json().catch(() => null) as { ok?: unknown; status?: unknown } | null
    return data?.ok === true || data?.status === 'live' || data?.status === 'ok'
  } catch {
    return false
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer()
    probe.unref()
    probe.once('error', () => resolve(false))
    probe.listen({ host: '127.0.0.1', port }, () => {
      probe.close(() => resolve(true))
    })
  })
}

async function resolveAvailableBridgePort(): Promise<number> {
  if (server && await fetchBridgeHealth(activeBridgePort)) return activeBridgePort
  for (let offset = 0; offset < WEIXIN_BRIDGE_MAX_PORT_ATTEMPTS; offset += 1) {
    const port = WEIXIN_BRIDGE_PORT + offset
    if (await isPortAvailable(port)) return port
  }
  throw new Error('Built-in WeChat login component could not find an available local port.')
}

async function listen(serverToStart: HttpServer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      serverToStart.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      serverToStart.off('error', onError)
      resolve()
    }
    serverToStart.once('error', onError)
    serverToStart.once('listening', onListening)
    serverToStart.listen({ host: '127.0.0.1', port })
  })
}

async function startBridgeServer(): Promise<string> {
  if (server && await fetchBridgeHealth(activeBridgePort)) return resolveRpcUrl()
  bridgeRuntimeStopping = false
  const port = await resolveAvailableBridgePort()
  activeBridgePort = port
  await prepareBridgeState(port)
  server = createHttpServer((request, response) => {
    void handleBridgeRequest(request, response)
  })
  await listen(server, port)
  logInfo('weixin-bridge', `started built-in GUI WeChat bridge on port ${port}`)
  // Starting the local RPC bridge must not implicitly start persisted accounts.
  // Account startup resolves protected credentials and can trigger a macOS
  // Keychain authorization prompt during a normal app launch. The explicit
  // start/reconnect paths below are the only places allowed to start monitors.
  return resolveRpcUrl()
}

export async function ensureWeixinBridgeRpcUrl(): Promise<string> {
  if (!startPromise) {
    startPromise = startBridgeServer().catch((error) => {
      startPromise = null
      throw error
    })
  }
  return startPromise
}

/**
 * WeChat user id (`ilink_user_id`) that bound this bot account during QR
 * login, or '' when the account is not configured. Used by Claw to greet
 * the owner right after the first connection.
 */
export async function getWeixinBridgeAccountUserId(accountId: string): Promise<string> {
  const normalized = normalizeAccountId(accountId)
  if (!normalized) return ''
  try {
    const account = await resolveWeixinAccount(normalized)
    return account.configured ? account.userId ?? '' : ''
  } catch {
    return ''
  }
}

export async function isWeixinBridgeAccountConfigured(accountId: string): Promise<boolean> {
  const normalized = normalizeAccountId(accountId)
  await loadAccountStatuses()
  if (canTrustActiveWeixinCredential(monitors.has(normalized), accountStatuses.get(normalized)?.status)) return true
  try {
    return (await resolveWeixinAccount(normalized)).configured
  } catch {
    return false
  }
}

export async function getWeixinBridgeAccountStatuses(
  requestedAccountId?: string
): Promise<WeixinBridgeAccountStatusV1[]> {
  await loadAccountStatuses()
  const requested = requestedAccountId?.trim() ? normalizeAccountId(requestedAccountId) : ''
  const indexedIds = await listIndexedWeixinAccountIds()
  const ids = requested
    ? [requested]
    : [...new Set([...indexedIds.map(normalizeAccountId), ...accountStatuses.keys(), ...monitors.keys()])]
  return ids.map((accountId) => {
    const persisted = accountStatuses.get(accountId)
    if (persisted) return { accountId, ...persisted }
    return {
      accountId,
      status: monitors.has(accountId) ? 'starting' : 'unknown',
      message: monitors.has(accountId) ? '正在连接微信。' : '尚未确认微信连接状态。'
    }
  })
}

export async function sendWeixinBridgeMessage(options: {
  accountId: string
  to: string
  text: string
  clientId?: string
  files?: WeixinOutboundFile[]
}): Promise<WeixinBridgeSendResult> {
  if (isCandidateOutboundDisabled('weixin', options.to)) {
    return { ok: false, message: 'Candidate IM outbound is disabled.' }
  }
  const accountId = normalizeAccountId(options.accountId)
  const to = options.to.trim()
  const text = options.text.trim()
  if (!accountId) return { ok: false, message: 'WeChat account id is missing.' }
  if (!to) return { ok: false, message: 'WeChat recipient is missing.' }
  if (!text) return { ok: false, message: 'Message is empty.' }

  try {
    await ensureWeixinBridgeRpcUrl()
    const cfg = await readBridgeConfig()
    void cfg
    const account = await resolveWeixinAccount(accountId)
    const [status] = await getWeixinBridgeAccountStatuses(accountId)
    if (status?.status === 'expired') {
      return { ok: false as const, message: '微信连接已过期，请重新扫码。' }
    }
    if (status?.status === 'stopped' || status?.reasonCode === 'user_stopped') {
      return { ok: false as const, message: '微信连接已暂停，请先重新连接。' }
    }
    if (!account.configured || !account.token?.trim()) {
      return { ok: false as const, message: 'WeChat account is not configured.' }
    }
    await restoreContextTokens(account.accountId)
    const contextToken = getContextToken(account.accountId, to)
    const messageRunId = randomUUID()
    const files = options.files ?? []
    let result: { messageId: string }
    try {
      result = await deliverWeixinFilesBeforeSuccessText(
        files,
        () => sendGeneratedFilesWeixin(
          account,
          to,
          files,
          contextToken,
          messageRunId,
          options.clientId
        ),
        () => sendWeixinTextWithRetry({
          account,
          to,
          text,
          contextToken,
          runId: messageRunId,
          clientId: options.clientId
        })
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/^WeChat file delivery failed:/i.test(message)) {
        await sendWeixinTextWithRetry({
          account,
          to,
          text: WEIXIN_FILE_FAILED_REPLY_TEXT,
          contextToken,
          runId: messageRunId,
          clientId: options.clientId?.trim() ? `${options.clientId.trim()}-failure` : undefined
        }).catch((noticeError) => {
          logWarn('weixin-bridge', 'Failed to send WeChat attachment failure notice.', {
            accountId,
            message: noticeError instanceof Error ? noticeError.message : String(noticeError)
          })
        })
      }
      throw error
    }
    return { ok: true as const, messageId: result.messageId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logError('weixin-bridge', 'Failed to send WeChat message from GUI.', {
      message,
      accountId,
      to
    })
    return { ok: false, message }
  }
}

export async function stopWeixinBridgeRuntime(): Promise<void> {
  bridgeRuntimeStopping = true
  startPromise = null
  const activeMonitors = [...monitors.values()]
  monitors.clear()
  await abortWeixinMonitors(activeMonitors)
  if (!server) return
  const runningServer = server
  server = null
  await new Promise<void>((resolveClose) => {
    try {
      runningServer.close(() => resolveClose())
    } catch {
      resolveClose()
    }
  })
}

export const weixinBridgeRuntimeInternals = {
  buildBaseInfo,
  buildWeixinOutboundMessageBody,
  normalizeAccountId,
  retryWithDelays,
  retryWithStableClientId,
  weixinChunkClientId,
  weixinMessageId,
  weixinMonitorHeartbeatTime,
  getUpdates,
  shouldRestartWeixinMonitor,
  canAutomaticallyStartWeixinMonitor,
  webhookGeneratedFiles,
  sendGeneratedFilesWeixin,
  createSendWeixinMediaFile,
  deliverWeixinFilesBeforeSuccessText,
  encodeWeixinCdnAesKey,
  validateUploadedWeixinMedia,
  buildWebhookMessage,
  webhookReplyText,
  safeWeixinFailureReply,
  splitWeixinText,
  buildBoundLoginResult,
  buildWeixinQrRequest,
  canReuseWeixinAccountStatus,
  canTrustActiveWeixinCredential,
  isWeixinSessionExpiredResponse,
  startWorkWiseDeliveryLeaseHeartbeat,
  protectWeixinAccountData,
  abortWeixinMonitors,
  sleepUntilAbort
}
