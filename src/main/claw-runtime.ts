import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { URL } from 'node:url'
import {
  createLarkChannel,
  Domain,
  LoggerLevel,
  type LarkChannel,
  type NormalizedMessage,
  type SendInput,
  type SendOptions,
  type SendResult
} from '@larksuiteoapi/node-sdk'
import type {
  AppSettingsV1,
  ClawGeneratedFileV1,
  ClawImFeishuPlatformCredentialV1,
  ClawImChannelV1,
  ClawImConversationV1,
  ClawModel,
  ClawImProvider,
  ClawImRemoteSessionV1,
  ClawRunResult,
  ClawRunFailureReasonV1,
  ClawRuntimeStatus
} from '../shared/app-settings'
import type { WeixinBridgeAccountStatusV1 } from '../shared/workwise-api'
import {
  IM_LEDGER_LEASE_MS,
  IM_LEDGER_PROVIDER_DELIVERY_LEASE_MS,
  IM_LEDGER_LEASE_RENEW_INTERVAL_MS,
  type ImChannelHealthV1
} from '../shared/im-communication'
import type { ImLedgerMessageV1 } from './services/im-delivery-ledger'
import {
  isCandidateImProviderConnectionAllowed,
  isCandidateInboundAllowed,
  isCandidateOutboundDisabled
} from './candidate-runtime'
import {
  CLAW_MODEL_IDS,
  DEFAULT_CLAW_MODEL,
  buildClawRuntimePrompt,
  getManagedRuntimeSettings,
  normalizeClawModel,
  parseClawUserPromptForDisplay
} from '../shared/app-settings'
import { isVisibleComposerModelIdForProvider } from '../shared/default-composer-models'
import { parseClawCommand } from '../shared/claw-commands'
import { readLegacyWebhookSecret } from './compat/legacy-http'
import {
  asString,
  buildFeishuPrompt,
  clawConversationKey,
  extractIncomingChannelId,
  extractIncomingProvider,
  extractIncomingPrompt,
  extractIncomingRemoteSession,
  extractSenderLabel,
  feishuSenderLabel,
  filterGeneratedFilesForPrompt,
  formatFeishuMirrorText,
  generatedFilesFromTaskRuns,
  isRunningStatus,
  latestGeneratedFiles,
  latestAssistantText,
  nestedRecord,
  normalizeTaskModel,
  parseJsonObject,
  pendingTurnInteraction,
  readRequestBody,
  replyTextForGeneratedFiles,
  runtimeErrorMessage,
  sanitizePathSegment,
  shouldDirectSendExistingGeneratedFilesForPrompt,
  shouldSendGeneratedFilesForPrompt,
  sleep,
  webhookUrl,
  writeJson,
  type ClawRuntimeDeps,
  type RunPromptOptions,
  type ThreadDetailJson,
  type ThreadRecordJson
} from './claw-runtime-helpers'

const MAX_IM_FILE_UPLOAD_BYTES = 50 * 1024 * 1024
const CLAW_IM_APPROVAL_POLICY = 'auto'
const CLAW_IM_SANDBOX_MODE = 'danger-full-access'
const LEGACY_IM_RESPONSE_TIMEOUT_MS = 120_000
const LONG_IM_RESPONSE_TIMEOUT_MS = 600_000
const IM_DELIVERY_RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000] as const
export const FEISHU_HANDSHAKE_TIMEOUT_MS = 30_000
export const FEISHU_PING_TIMEOUT_SECONDS = 15

export function feishuWebSocketReliabilityOptions(): {
  transport: 'websocket'
  handshakeTimeoutMs: number
  wsConfig: { pingTimeout: number }
} {
  return {
    transport: 'websocket',
    handshakeTimeoutMs: FEISHU_HANDSHAKE_TIMEOUT_MS,
    wsConfig: { pingTimeout: FEISHU_PING_TIMEOUT_SECONDS }
  }
}

type ImStoredDeliveryV1 = {
  ok: boolean
  reply: string
  files?: ClawGeneratedFileV1[]
  threadId?: string
  turnId?: string
  message?: string
  createdTaskId?: string
  failureReason?: ClawRunFailureReasonV1
  deliveryId?: string
  outboundId?: string
  /** The ledger owner that must acquire the provider-send lease before sending. */
  deliveryLeaseRunId?: string
  /** Authoritative provider-delivery lease deadline returned to the bridge. */
  deliveryLeaseUntil?: string
}

type FeishuClawChannel = ClawImChannelV1 & {
  platformCredential: ClawImFeishuPlatformCredentialV1
}

function hasFeishuPlatformCredential(channel: ClawImChannelV1): channel is FeishuClawChannel {
  const credential = channel.platformCredential
  return credential?.kind === 'feishu' &&
    typeof credential.appId === 'string' &&
    !!credential.appId.trim()
}

function isMissingThreadResult(result: { ok: boolean; status: number; body: string }): boolean {
  if (result.ok) return false
  const message = runtimeErrorMessage(result, '').toLowerCase()
  return result.status === 404 && message.includes('thread') && message.includes('not found')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function localMirrorOutboundId(
  provider: ClawImProvider,
  threadId: string,
  turnId: string | undefined,
  direction: 'user' | 'assistant'
): string | undefined {
  const normalizedTurnId = turnId?.trim()
  if (!normalizedTurnId) return undefined
  const digest = createHash('sha256')
    .update(`${provider}\0${threadId.trim()}\0${normalizedTurnId}\0${direction}`)
    .digest('hex')
    .slice(0, 32)
  return `ww_mirror_${digest}`
}

class ImTurnResultError extends Error {
  constructor(
    readonly reason: Exclude<ClawRunFailureReasonV1, 'failed'>,
    message: string
  ) {
    super(message)
    this.name = 'ImTurnResultError'
  }
}

type InboundLeaseGuard = {
  stop: () => void
  assertOwned: () => void
}

class InboundLeaseLostError extends Error {
  constructor() {
    super('IM delivery lease was lost; outbound delivery was stopped.')
    this.name = 'InboundLeaseLostError'
  }
}

function isInboundLeaseLostError(error: unknown): error is InboundLeaseLostError {
  return error instanceof InboundLeaseLostError
}

function traceImStartup(label: string, detail?: Record<string, unknown>): void {
  if (process.env.WORKWISE_STARTUP_TRACE !== '1') return
  if (detail) console.info(`[im-startup] ${label}`, detail)
  else console.info(`[im-startup] ${label}`)
}

function imOutboundId(record: ImLedgerMessageV1, suffix = 'reply'): string {
  return `ww_${createHash('sha256').update(`${record.idempotencyKey}:${suffix}`).digest('hex').slice(0, 32)}`
}

function deliveryRetryDelayMs(retryCount: number): number {
  return IM_DELIVERY_RETRY_DELAYS_MS[Math.min(Math.max(0, retryCount), IM_DELIVERY_RETRY_DELAYS_MS.length - 1)]
}

function parseStoredDelivery(record: ImLedgerMessageV1): ImStoredDeliveryV1 | undefined {
  if (!record.resultJson) return undefined
  try {
    const value = JSON.parse(record.resultJson) as Partial<ImStoredDeliveryV1>
    if (typeof value !== 'object' || value === null || typeof value.reply !== 'string') return undefined
    return {
      ...value,
      ok: value.ok === true,
      reply: value.reply,
      deliveryId: record.id,
      outboundId: value.outboundId || imOutboundId(record),
      deliveryLeaseRunId: typeof value.deliveryLeaseRunId === 'string'
        ? value.deliveryLeaseRunId
        : record.leaseRunId
    }
  } catch {
    return undefined
  }
}

function recoverableFeishuMessage(record: ImLedgerMessageV1): NormalizedMessage | undefined {
  if (!record.remoteMessageId.trim() || !record.chatId.trim()) return undefined
  const payload = parseJsonObject(record.payloadJson)
  if (!payload) return undefined
  const chatType = asString(payload.chatType) === 'group' ? 'group' : 'p2p'
  return {
    ...payload,
    messageId: asString(payload.messageId) || record.remoteMessageId,
    chatId: asString(payload.chatId) || record.chatId,
    chatType,
    senderId: asString(payload.senderId) || record.senderId,
    senderName: asString(payload.senderName) || undefined,
    content: asString(payload.content) || asString(payload.text) || record.prompt,
    rawContentType: asString(payload.rawContentType) || 'text',
    resources: Array.isArray(payload.resources) ? payload.resources : [],
    mentions: Array.isArray(payload.mentions) ? payload.mentions : [],
    mentionAll: payload.mentionAll === true,
    mentionedBot: payload.mentionedBot === true,
    threadId: asString(payload.threadId) || record.threadId || undefined
  } as NormalizedMessage
}

function feishuReceiveIdType(to: string): 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id' {
  if (to.startsWith('oc_')) return 'chat_id'
  if (to.startsWith('ou_')) return 'open_id'
  if (to.startsWith('on_')) return 'union_id'
  if (to.includes('@')) return 'email'
  return 'user_id'
}

function stableFeishuContent(input: SendInput, options: SendOptions): { msgType: 'post' | 'text' | 'file'; content: string } | undefined {
  const mentions = (options.mentions ?? [])
    .filter((mention) => mention.openId)
    .map((mention) => `<at user_id="${mention.openId}">${mention.name ?? ''}</at>`)
    .join(' ')
  const prefix = mentions ? `${mentions} ` : ''
  if ('markdown' in input) {
    return {
      msgType: 'post',
      content: JSON.stringify({
        zh_cn: {
          title: '',
          content: [[{ tag: 'md', text: `${prefix}${input.markdown}` }]]
        }
      })
    }
  }
  if ('text' in input) {
    return { msgType: 'text', content: JSON.stringify({ text: `${prefix}${input.text}` }) }
  }
  return undefined
}

export function resolveImResponseTimeoutMs(provider: ClawImProvider, configuredTimeoutMs: number): number {
  return (provider === 'feishu' || provider === 'weixin') && configuredTimeoutMs >= LEGACY_IM_RESPONSE_TIMEOUT_MS
    ? Math.max(configuredTimeoutMs, LONG_IM_RESPONSE_TIMEOUT_MS)
    : configuredTimeoutMs
}

function imRuntimeFailureMessage(settings: AppSettingsV1, rawMessage: string): string {
  const message = rawMessage.trim()
  if (!isChineseLocale(settings)) {
    if (message === 'Agent turn completed without a deliverable result.') return 'The task completed without text or files to deliver.'
    if (message === 'Agent turn is waiting for approval.') return 'The task is waiting for authorization and has not completed.'
    if (message === 'Agent turn is waiting for user input.') return 'The task is waiting for user input and has not completed.'
    return message || 'The task failed before it could produce a verified result.'
  }
  if (message === 'Agent turn completed without a deliverable result.') {
    return '任务已结束，但没有产生可交付的文本或文件。'
  }
  if (message === 'Agent turn is waiting for approval.') {
    return '任务正在等待授权，尚未完成。请在 RailWise AI 中处理授权后重试。'
  }
  if (message === 'Agent turn is waiting for user input.') {
    return '任务正在等待补充信息，尚未完成。请在 RailWise AI 中处理后重试。'
  }
  if (isWebAccessFailure(message)) {
    return '在线搜索连续失败，暂时无法核实最新资讯。本次任务未完成，请稍后重试，或发来可访问的网页链接。'
  }
  if (/timed out|timeout|超时/i.test(message)) {
    return '任务处理超时，尚未完成。请稍后重试。'
  }
  return message && !/^agent turn (?:failed|aborted)\.?$/i.test(message)
    ? `任务未完成：${message}`
    : '任务未完成，RailWise AI Runtime 没有产生可交付结果。请稍后重试。'
}

function isWebAccessFailure(message: string): boolean {
  return /web_access_exhausted|在线搜索连续失败|web (?:access|search).*fail/i.test(message)
}

function isChineseLocale(settings: AppSettingsV1): boolean {
  return settings.locale.toLowerCase().startsWith('zh')
}

function currentImModel(settings: AppSettingsV1, channel?: ClawImChannelV1): string {
  return channel?.model?.trim() || settings.claw.im.model.trim() || DEFAULT_CLAW_MODEL
}

function imCommandHelpText(settings: AppSettingsV1): string {
  const models = CLAW_MODEL_IDS.filter((model) => isVisibleComposerModelIdForProvider(
    model,
    getManagedRuntimeSettings(settings).providerId || undefined
  ))
  const commandModels = models.map((model) => model === 'deepseek-flash' ? 'flash' : model)
  const command = `/model ${commandModels.join('|')}`
  if (isChineseLocale(settings)) {
    return [
      'Claw IM 命令：',
      '- `/help`：查看命令帮助',
      '- `/status`：查看当前连接状态',
      '- `/new`：当前 IM 连接开启新话题',
      '- `/model`：查看当前模型',
      `- \`${command}\`：切换当前 IM 连接模型`,
      '也支持 `-new`、`-help`、`-model flash` 这种写法。'
    ].join('\n')
  }
  return [
    'Claw IM commands:',
    '- `/help`: show command help',
    '- `/status`: show the current connection status',
    '- `/new`: start a new topic for this IM connection',
    '- `/model`: show the current model',
    `- \`${command}\`: switch this IM connection model`,
    '`-new`, `-help`, and `-model flash` are supported too.'
  ].join('\n')
}

function imModelCommandHint(settings: AppSettingsV1): string {
  const providerId = getManagedRuntimeSettings(settings).providerId || undefined
  const models = CLAW_MODEL_IDS.filter((model) => isVisibleComposerModelIdForProvider(model, providerId))
  const ids = models.join(', ')
  const commandModels = models.map((model) => model === 'deepseek-flash' ? 'flash' : model)
  const command = `/model ${commandModels.join('|')}`
  return isChineseLocale(settings)
    ? `可使用 ${command}。可用模型：${ids}。`
    : `Use ${command}. Available models: ${ids}.`
}

function imModelCurrentText(settings: AppSettingsV1, model: string): string {
  return isChineseLocale(settings)
    ? `当前 Claw IM 模型是 \`${model}\`。`
    : `Current Claw IM model: \`${model}\`.`
}

function imModelChangedText(settings: AppSettingsV1, model: string): string {
  return isChineseLocale(settings)
    ? `Claw IM 模型已切换到 \`${model}\`。`
    : `Claw IM model switched to \`${model}\`.`
}

function imNewTopicText(settings: AppSettingsV1): string {
  return isChineseLocale(settings)
    ? '新话题已开启。下一条消息会创建新的本地会话。'
    : 'Started a new topic. The next message will create a fresh local conversation.'
}

function formatLocalTime(value: string, locale: AppSettingsV1['locale']): string {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return value
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'medium'
  }).format(new Date(time))
}

async function imConnectionStatusText(
  settings: AppSettingsV1,
  channel: ClawImChannelV1 | undefined,
  getStatuses: ClawRuntimeDeps['getWeixinBridgeAccountStatuses'],
  health?: ImChannelHealthV1
): Promise<string> {
  if (!channel) {
    return isChineseLocale(settings)
      ? '暂时无法确定当前连接。'
      : 'The current connection is unavailable.'
  }
  if (channel.provider === 'feishu') {
    if (!health) {
      return isChineseLocale(settings)
        ? '暂时无法读取当前飞书 / Lark 连接状态。'
        : 'The current Feishu / Lark connection status is unavailable.'
    }
    const providerLabel = channel.platformCredential?.kind === 'feishu' &&
      channel.platformCredential.domain.trim().toLowerCase() === 'lark'
      ? 'Lark'
      : isChineseLocale(settings) ? '飞书' : 'Feishu'
    const connected = health.status === 'connected'
    if (isChineseLocale(settings)) {
      return [
        `${providerLabel}连接：${connected ? '已连接' : health.message || health.status}`,
        `状态：${health.status}`,
        ...(health.lastSuccessfulHeartbeatAt
          ? [`最近成功心跳：${formatLocalTime(health.lastSuccessfulHeartbeatAt, settings.locale)}`]
          : []),
        ...(health.updatedAt
          ? [`状态更新时间：${formatLocalTime(health.updatedAt, settings.locale)}`]
          : []),
        '以上状态由 RailWise AI 主进程直接读取，未调用 AI 模型。'
      ].join('\n')
    }
    return [
      `${providerLabel} connection: ${connected ? 'connected' : health.message || health.status}`,
      `Status: ${health.status}`,
      ...(health.lastSuccessfulHeartbeatAt
        ? [`Last successful heartbeat: ${formatLocalTime(health.lastSuccessfulHeartbeatAt, settings.locale)}`]
        : []),
      ...(health.updatedAt
        ? [`Status updated: ${formatLocalTime(health.updatedAt, settings.locale)}`]
        : []),
      'This status was read directly by the RailWise AI main process without calling the AI model.'
    ].join('\n')
  }
  const credential = channel.platformCredential
  if (credential?.kind !== 'weixin' || !getStatuses) {
    return isChineseLocale(settings)
      ? '暂时无法读取当前微信连接状态。'
      : 'The current WeChat connection status is unavailable.'
  }
  let statuses: WeixinBridgeAccountStatusV1[]
  try {
    statuses = await getStatuses(credential.accountId)
  } catch {
    return isChineseLocale(settings)
      ? '暂时无法读取当前微信连接状态，请稍后重试。'
      : 'The current WeChat connection status is unavailable. Try again shortly.'
  }
  const status = statuses.find((item) => item.accountId === credential.accountId) ?? statuses[0]
  if (!status) {
    return isChineseLocale(settings)
      ? '尚未找到当前微信账号的连接状态。'
      : 'No connection status was found for the current WeChat account.'
  }
  const connected = status.status === 'connected'
  if (isChineseLocale(settings)) {
    return [
      `微信连接：${connected ? '已连接' : status.message || status.status}`,
      `状态：${status.status}`,
      ...(status.lastSuccessfulPollAt
        ? [`最近成功轮询：${formatLocalTime(status.lastSuccessfulPollAt, settings.locale)}`]
        : []),
      ...(status.updatedAt
        ? [`状态更新时间：${formatLocalTime(status.updatedAt, settings.locale)}`]
        : []),
      '以上状态由 RailWise AI 主进程直接读取，未调用 AI 模型。'
    ].join('\n')
  }
  return [
    `WeChat connection: ${connected ? 'connected' : status.message || status.status}`,
    `Status: ${status.status}`,
    ...(status.lastSuccessfulPollAt
      ? [`Last successful poll: ${formatLocalTime(status.lastSuccessfulPollAt, settings.locale)}`]
      : []),
    ...(status.updatedAt
      ? [`Status updated: ${formatLocalTime(status.updatedAt, settings.locale)}`]
      : []),
    'This status was read directly by the RailWise AI main process without calling the AI model.'
  ].join('\n')
}

/**
 * One-time intro sent to an IM conversation when the channel is first
 * connected: who the assistant is, what it can do, and the IM commands.
 */
export function imWelcomeText(settings: AppSettingsV1, channel?: ClawImChannelV1): string {
  const profile = channel?.agentProfile
  const name = profile?.name.trim() || channel?.label.trim() || 'RailWise AI Runtime'
  const description = profile?.description.trim() ?? ''
  if (isChineseLocale(settings)) {
    return [
      `你好，我是 ${name}，通过 RailWise AI Runtime 连接到这个对话的 AI 助手。`,
      ...(description ? [description] : []),
      '你可以直接发消息让我帮忙：回答问题、查资料、读写已连接电脑工作区里的文件、生成文档等，完成后我会在这里回复你。',
      imCommandHelpText(settings),
      '直接发一条消息就可以开始。'
    ].join('\n\n')
  }
  return [
    `Hi, I am ${name}, an AI assistant connected to this chat through RailWise AI Runtime.`,
    ...(description ? [description] : []),
    'Send me a message and I will handle it on the connected computer: answering questions, research, reading and writing workspace files, generating documents — I reply here once done.',
    imCommandHelpText(settings),
    'Send any message to get started.'
  ].join('\n\n')
}

export class ClawRuntime {
  private readonly deps: ClawRuntimeDeps
  private server: Server | null = null
  private serverOwned = false
  private serverRequestHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null
  private serverKey = ''
  private feishuChannels = new Map<string, LarkChannel>()
  private feishuChannelKeys = new Map<string, string>()
  private feishuSyncVersion = 0
  /** Channels with an in-flight first-message welcome delivery. */
  private readonly welcomeInFlight = new Set<string>()
  /** WeChat channels already greeted (or attempted) at connect time this run. */
  private readonly weixinConnectWelcomeAttempted = new Set<string>()
  private readonly inboundQueues = new Map<string, Promise<void>>()
  private inboundActive = 0
  private readonly inboundWaiters: Array<() => void> = []
  private recoveringLedger = false

  constructor(deps: ClawRuntimeDeps) {
    this.deps = deps
  }

  sync(settings: AppSettingsV1, options: { deferProtectedCredentialAccess?: boolean } = {}): void {
    traceImStartup('sync', {
      clawEnabled: settings.claw.enabled,
      imEnabled: settings.claw.im.enabled,
      enabledChannels: settings.claw.channels.filter((channel) => channel.enabled).length
    })
    this.syncWebhook(settings)
    void this.syncFeishuChannels(settings, options).then(() => this.recoverPendingMessages())
    void this.syncWeixinConnectWelcomes(settings)
  }

  private async resumeWeixinLedgerRecord(record: ImLedgerMessageV1): Promise<ImLedgerMessageV1 | undefined> {
    const settings = await this.deps.store.load()
    const headers: Record<string, string> = {}
    if (settings.claw.im.secret) {
      headers.authorization = `Bearer ${settings.claw.im.secret}`
      headers['x-workwise-secret'] = settings.claw.im.secret
    }
    const request = {
      method: 'POST',
      url: settings.claw.im.path,
      headers,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(record.payloadJson)
      }
    } as unknown as IncomingMessage
    const response = {
      writeHead: () => response,
      end: () => response
    } as unknown as ServerResponse
    await this.handleWebhook(request, response)
    return this.deps.imLedger?.getById(record.id)
  }

  async recoverPendingMessages(): Promise<void> {
    const ledger = this.deps.imLedger
    if (!ledger || this.recoveringLedger) return
    this.recoveringLedger = true
    try {
      ledger.prune()
      for (const record of ledger.listRecoverable()) {
        if (record.provider === 'feishu') {
          const message = recoverableFeishuMessage(record)
          if (!message) {
            const claimed = ledger.claim(record.id, randomUUID())
            if (claimed) this.failInboundDelivery(claimed, 'Stored Feishu inbound payload is invalid.')
          } else {
            await this.handleFeishuMessage(record.channelId, message, record).catch((error) => {
              this.deps.logError('claw-feishu', 'Failed to recover pending Feishu message', {
                channelId: record.channelId,
                remoteMessageId: record.remoteMessageId,
                message: errorMessage(error)
              })
            })
          }
          continue
        }
        if (record.provider !== 'weixin') continue
        // A crashed webhook can leave a pre-Turn record behind. Replaying a
        // malformed payload through the HTTP handler only returns 400 and
        // would leave it recoverable forever, so terminalize it once.
        if (record.status !== 'result_ready' && record.status !== 'delivering') {
          const payload = parseJsonObject(record.payloadJson)
          if (!payload || !extractIncomingPrompt(payload)) {
            const claimed = ledger.claim(record.id, randomUUID())
            if (claimed) this.failInboundDelivery(claimed, 'Stored WeChat inbound payload is invalid.')
            continue
          }
        }
        const resumed = record.status === 'result_ready' || record.status === 'delivering'
          ? record
          : await this.resumeWeixinLedgerRecord(record)
        if (!resumed || (resumed.status !== 'result_ready' && resumed.status !== 'delivering')) continue
        const claimed = record.status === 'result_ready' || record.status === 'delivering'
          ? ledger.claim(record.id, randomUUID())
          : resumed
        if (!claimed) continue
        const delivery = parseStoredDelivery(claimed)
        if (!delivery) {
          this.failInboundDelivery(claimed, 'Stored WeChat delivery payload is invalid.')
          continue
        }
        if (!this.deps.sendWeixinBridgeMessage || !record.chatId.trim()) {
          this.retryInboundDelivery(claimed, 'WeChat recovery target is unavailable.')
          continue
        }
        if (!this.beginInboundDelivery(claimed)) continue
        const leaseGuard = this.startInboundLeaseRenewal(claimed)
        try {
          leaseGuard.assertOwned()
          const result = await this.deps.sendWeixinBridgeMessage({
            accountId: claimed.accountId,
            to: claimed.chatId,
            text: delivery.reply,
            clientId: delivery.outboundId,
            files: delivery.files
          })
          leaseGuard.assertOwned()
          if (result.ok) this.finishInboundDelivery(claimed, delivery)
          else this.retryInboundDelivery(claimed, result.message)
        } catch (error) {
          if (!isInboundLeaseLostError(error)) {
            this.retryInboundDelivery(claimed, errorMessage(error))
          } else {
            this.deps.logError('claw-weixin', 'WeChat recovery stopped after losing the inbound delivery lease.', {
              channelId: claimed.channelId,
              remoteMessageId: claimed.remoteMessageId
            })
          }
        } finally {
          leaseGuard.stop()
        }
      }
    } finally {
      this.recoveringLedger = false
    }
  }

  /**
   * Greets the WeChat owner right after a channel is first connected.
   * The QR login records the owner's user id, so the intro can be
   * pushed before any inbound message. Failures fall back to the
   * first-inbound-message welcome.
   */
  private async syncWeixinConnectWelcomes(settings: AppSettingsV1): Promise<void> {
    if (!settings.claw.enabled || !settings.claw.im.enabled) return
    if (!this.deps.sendWeixinBridgeMessage || !this.deps.resolveWeixinAccountUserId) return
    for (const channel of settings.claw.channels) {
      if (!channel.enabled || channel.provider !== 'weixin' || channel.welcomeSentAt) continue
      const credential = channel.platformCredential
      if (credential?.kind !== 'weixin' || !credential.accountId.trim()) continue
      if (this.weixinConnectWelcomeAttempted.has(channel.id) || this.welcomeInFlight.has(channel.id)) continue
      this.weixinConnectWelcomeAttempted.add(channel.id)
      this.welcomeInFlight.add(channel.id)
      try {
        const owner = (await this.deps.resolveWeixinAccountUserId(credential.accountId)).trim()
        if (!owner) continue
        const result = await this.deps.sendWeixinBridgeMessage({
          accountId: credential.accountId,
          to: owner,
          text: imWelcomeText(settings, channel)
        })
        if (result.ok) {
          await this.markChannelWelcomeSent(channel.id)
        } else {
          this.deps.logError('claw-weixin', 'Failed to greet the WeChat owner after connect; the welcome will be sent on the first inbound message instead.', {
            channelId: channel.id,
            message: result.message
          })
        }
      } catch (error) {
        this.deps.logError('claw-weixin', 'Failed to greet the WeChat owner after connect', {
          channelId: channel.id,
          message: errorMessage(error)
        })
      } finally {
        this.welcomeInFlight.delete(channel.id)
      }
    }
  }

  private async markChannelWelcomeSent(channelId: string): Promise<void> {
    const settings = await this.deps.store.load()
    const now = new Date().toISOString()
    await this.deps.store.patch({
      claw: {
        channels: settings.claw.channels.map((item) =>
          item.id === channelId ? { ...item, welcomeSentAt: now, updatedAt: now } : item
        )
      }
    })
  }

  private async enqueueInbound(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.inboundQueues.get(key) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        await this.acquireInboundSlot()
        try {
          await task()
        } finally {
          this.releaseInboundSlot()
        }
      })
    this.inboundQueues.set(key, current)
    await current.finally(() => {
      if (this.inboundQueues.get(key) === current) this.inboundQueues.delete(key)
    })
  }

  private async acquireInboundSlot(): Promise<void> {
    const limit = Math.max(1, this.deps.imMaxConcurrency ?? 4)
    if (this.inboundActive < limit) {
      this.inboundActive += 1
      return
    }
    await new Promise<void>((resolve) => this.inboundWaiters.push(resolve))
  }

  private releaseInboundSlot(): void {
    const next = this.inboundWaiters.shift()
    if (next) {
      // Transfer the occupied slot directly. Decrementing before waking the
      // waiter lets a newly arriving message steal the slot and exceed the
      // global concurrency limit when the waiter resumes on the next microtask.
      next()
      return
    }
    this.inboundActive = Math.max(0, this.inboundActive - 1)
  }

  private claimInbound(input: {
    provider: ClawImProvider
    accountId: string
    channelId: string
    remoteMessageId: string
    chatId: string
    senderId: string
    threadId: string
    prompt: string
    payload: unknown
  }): ImLedgerMessageV1 | null | undefined {
    const ledger = this.deps.imLedger
    if (!ledger) return undefined
    const idempotencyKey = `im:${input.provider}:${input.accountId}:${input.remoteMessageId}`
    const record = ledger.receive({
      provider: input.provider,
      accountId: input.accountId,
      channelId: input.channelId,
      remoteMessageId: input.remoteMessageId,
      chatId: input.chatId,
      senderId: input.senderId,
      threadId: input.threadId,
      prompt: input.prompt,
      payloadJson: JSON.stringify(input.payload),
      idempotencyKey
    })
    const claimed = ledger.claim(record.id, randomUUID())
    if (claimed) return claimed
    return null
  }

  private updateInboundCounts(record: ImLedgerMessageV1 | null | undefined): void {
    if (!record || !this.deps.imLedger) return
    const counts = this.deps.imLedger.counts(record.provider, record.accountId)
    this.deps.imHealth?.updateCounts(record.channelId, {
      pendingMessages: counts.pending,
      processingMessages: counts.processing,
      deliveryMessages: counts.delivery
    })
  }

  private prepareInboundDelivery(
    record: ImLedgerMessageV1 | null | undefined,
    delivery: ImStoredDeliveryV1,
    runtime?: { threadId?: string; turnId?: string }
  ): ImStoredDeliveryV1 | undefined {
    if (!record || !this.deps.imLedger) return delivery
    const stored = {
      ...delivery,
      deliveryId: record.id,
      outboundId: delivery.outboundId || imOutboundId(record),
      deliveryLeaseRunId: delivery.deliveryLeaseRunId || record.leaseRunId
    }
    const updated = record.leaseRunId
      ? this.deps.imLedger.markResultReady(
          record.id,
          JSON.stringify(stored),
          runtime,
          new Date().toISOString(),
          record.leaseRunId
        )
      : this.deps.imLedger.markResultReady(record.id, JSON.stringify(stored), runtime)
    if (!updated) return undefined
    this.updateInboundCounts(record)
    return stored
  }

  private beginInboundDelivery(record: ImLedgerMessageV1 | null | undefined): boolean {
    if (!record || !this.deps.imLedger) return true
    const updated = record.leaseRunId
      ? this.deps.imLedger.markDelivering(record.id, new Date().toISOString(), record.leaseRunId)
      : this.deps.imLedger.markDelivering(record.id)
    if (!updated) return false
    this.updateInboundCounts(record)
    return true
  }

  private finishInboundDelivery(
    record: ImLedgerMessageV1 | null | undefined,
    delivery?: ImStoredDeliveryV1
  ): ImLedgerMessageV1 | undefined {
    if (!record || !this.deps.imLedger) return undefined
    const completedDelivery = delivery ?? parseStoredDelivery(record)
    if (!completedDelivery) {
      return this.failInboundDelivery(record, 'Stored IM delivery payload is invalid.')
    }
    const leaseRunId = record.leaseRunId?.trim()
    let updated: ImLedgerMessageV1 | undefined
    if (completedDelivery?.ok === false) {
      if (leaseRunId) {
        updated = this.deps.imLedger.markFailed(
          record.id,
          completedDelivery.message?.trim() || completedDelivery.reply.trim(),
          new Date().toISOString(),
          leaseRunId
        )
      } else {
        updated = this.deps.imLedger.markFailed(
          record.id,
          completedDelivery.message?.trim() || completedDelivery.reply.trim()
        )
      }
    } else {
      if (leaseRunId) {
        updated = this.deps.imLedger.markDelivered(record.id, new Date().toISOString(), leaseRunId)
      } else {
        updated = this.deps.imLedger.markDelivered(record.id)
      }
    }
    if (updated) this.updateInboundCounts(updated)
    return updated
  }

  private failInboundDelivery(record: ImLedgerMessageV1 | null | undefined, message: string): ImLedgerMessageV1 | undefined {
    if (!record || !this.deps.imLedger) return undefined
    const failed = record.leaseRunId
      ? this.deps.imLedger.markFailed(record.id, message, new Date().toISOString(), record.leaseRunId)
      : this.deps.imLedger.markFailed(record.id, message)
    if (failed) this.updateInboundCounts(failed)
    return failed
  }

  private retryInboundDelivery(record: ImLedgerMessageV1 | null | undefined, message: string): ImLedgerMessageV1 | undefined {
    if (!record || !this.deps.imLedger) return undefined
    const updated = record.leaseRunId
      ? this.deps.imLedger.markDeliveryRetry(
          record.id,
          message,
          deliveryRetryDelayMs(record.retryCount),
          new Date().toISOString(),
          record.leaseRunId
        )
      : this.deps.imLedger.markDeliveryRetry(record.id, message, deliveryRetryDelayMs(record.retryCount))
    if (updated?.status === 'delivery_failed') {
      this.deps.imHealth?.fail(record.channelId, {
        reasonCode: 'provider_error',
        message: '消息多次发送失败，请运行连接自检。'
      })
    }
    this.updateInboundCounts(record)
    return updated
  }

  private startInboundLeaseRenewal(record: ImLedgerMessageV1 | null | undefined): InboundLeaseGuard {
    const ledger = this.deps.imLedger
    const runId = record?.leaseRunId?.trim()
    if (!ledger || !record || !runId) {
      return { stop: () => undefined, assertOwned: () => undefined }
    }
    let stopped = false
    let lost = false
    const markLost = (cause?: unknown) => {
      if (lost) return
      lost = true
      this.deps.logError('claw-im', 'IM ledger lease renewal was rejected; this worker will not send a stale result.', {
        provider: record.provider,
        channelId: record.channelId,
        remoteMessageId: record.remoteMessageId,
        ...(cause === undefined ? {} : { message: errorMessage(cause) })
      })
    }
    const renew = (): boolean => {
      try {
        if (ledger.renewLease(record.id, runId, IM_LEDGER_LEASE_MS)) return true
      } catch (error) {
        markLost(error)
        return false
      }
      markLost()
      return false
    }
    const refresh = () => {
      if (stopped || lost) return
      renew()
    }
    const timer = setInterval(refresh, IM_LEDGER_LEASE_RENEW_INTERVAL_MS)
    timer.unref?.()
    return {
      stop: () => {
        if (stopped) return
        stopped = true
        clearInterval(timer)
      },
      assertOwned: () => {
        if (stopped) return
        if (lost) throw new InboundLeaseLostError()
        if (!renew()) throw new InboundLeaseLostError()
      }
    }
  }

  /** Welcome text still owed to this channel, or '' when already delivered. */
  private pendingWelcomeText(settings: AppSettingsV1, channel: ClawImChannelV1 | undefined): string {
    if (!channel || channel.welcomeSentAt || this.welcomeInFlight.has(channel.id)) return ''
    return imWelcomeText(settings, channel)
  }

  /**
   * Sends the welcome as its own WeChat bubble so it arrives ahead of
   * the (slow) model reply. Returns false when the channel cannot push
   * (non-WeChat provider, missing bridge, unknown recipient) so the
   * caller falls back to prepending the text to the HTTP reply.
   */
  private async pushWeixinWelcome(
    channel: ClawImChannelV1,
    remoteSession: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'> | undefined,
    text: string
  ): Promise<boolean> {
    if (channel.provider !== 'weixin' || !this.deps.sendWeixinBridgeMessage) return false
    const credential = channel.platformCredential
    if (credential?.kind !== 'weixin' || !credential.accountId.trim()) return false
    const to = remoteSession?.chatId.trim() || channel.remoteSession?.chatId.trim() || ''
    if (!to) return false
    const result = await this.deps.sendWeixinBridgeMessage({
      accountId: credential.accountId,
      to,
      text
    })
    if (!result.ok) {
      this.deps.logError('claw-weixin', 'Failed to push the WeChat welcome message; prepending it to the reply instead.', {
        channelId: channel.id,
        message: result.message
      })
    }
    return result.ok
  }

  async stop(): Promise<void> {
    traceImStartup('stop')
    this.feishuSyncVersion += 1
    await Promise.all([
      this.closeWebhook(),
      this.closeAllFeishuChannels(false)
    ])
  }

  async startChannel(channelId: string): Promise<void> {
    const settings = await this.deps.store.load()
    const channel = settings.claw.channels.find((item) => item.id === channelId && item.enabled)
    if (!channel) return
    if (!isCandidateImProviderConnectionAllowed(channel.provider)) return
    const credential = channel.platformCredential
    const accountId = credential?.kind === 'weixin' ? credential.accountId : credential?.kind === 'feishu' ? credential.appId : channel.id
    this.deps.imHealth?.start({ channelId, provider: channel.provider, accountId, credentialStorage: channel.credentialRef?.storage })
    if (channel.provider === 'weixin') {
      await this.deps.startWeixinBridgeAccount?.(accountId)
      return
    }
    this.sync(settings)
  }

  async reconnectChannel(channelId: string): Promise<void> {
    const settings = await this.deps.store.load()
    const channel = settings.claw.channels.find((item) => item.id === channelId && item.enabled)
    if (!channel) return
    if (!isCandidateImProviderConnectionAllowed(channel.provider)) return
    const credential = channel.platformCredential
    const accountId = credential?.kind === 'weixin' ? credential.accountId : credential?.kind === 'feishu' ? credential.appId : channel.id
    if (channel.provider === 'weixin') {
      this.deps.imHealth?.start({ channelId, provider: channel.provider, accountId, credentialStorage: channel.credentialRef?.storage })
      await this.deps.reconnectWeixinBridgeAccount?.(accountId)
      return
    }
    this.feishuSyncVersion += 1
    await this.closeFeishuChannel(channelId)
    this.deps.imHealth?.start({ channelId, provider: channel.provider, accountId, credentialStorage: channel.credentialRef?.storage })
    this.sync(settings)
  }

  async stopChannel(channelId: string): Promise<void> {
    const settings = await this.deps.store.load()
    const channel = settings.claw.channels.find((item) => item.id === channelId)
    if (!channel) return
    if (channel.provider === 'feishu') {
      this.feishuSyncVersion += 1
      await this.closeFeishuChannel(channelId)
    }
    else {
      const credential = channel.platformCredential
      const accountId = credential?.kind === 'weixin' ? credential.accountId : channel.id
      await this.deps.stopWeixinBridgeAccount?.(accountId)
      this.deps.imHealth?.stop(channelId)
    }
  }

  async disconnectChannel(channelId: string): Promise<void> {
    const settings = await this.deps.store.load()
    const channel = settings.claw.channels.find((item) => item.id === channelId)
    if (!channel) return
    if (channel.provider === 'weixin') {
      const credential = channel.platformCredential
      const accountId = credential?.kind === 'weixin' ? credential.accountId : channel.id
      await this.deps.disconnectWeixinBridgeAccount?.(accountId)
      this.deps.imHealth?.stop(channelId)
    } else {
      await this.stopChannel(channelId)
    }
    const now = new Date().toISOString()
    await this.deps.store.patch({
      claw: {
        channels: settings.claw.channels.map((channel) =>
          channel.id === channelId ? { ...channel, enabled: false, updatedAt: now } : channel
        )
      }
    })
  }

  refreshChannelHealth(settings?: AppSettingsV1): void {
    if (settings && this.deps.imLedger) {
      for (const channel of settings.claw.channels.filter((item) => item.enabled)) {
        const credential = channel.platformCredential
        const accountId = credential?.kind === 'weixin'
          ? credential.accountId
          : credential?.kind === 'feishu'
            ? credential.appId
            : channel.id
        const counts = this.deps.imLedger.counts(channel.provider, accountId)
        this.deps.imHealth?.updateCounts(channel.id, {
          pendingMessages: counts.pending,
          processingMessages: counts.processing,
          deliveryMessages: counts.delivery
        })
      }
    }
    for (const [channelId, bridge] of this.feishuChannels) {
      this.refreshFeishuBridgeHealth(channelId, bridge)
    }
  }

  private refreshFeishuBridgeHealth(channelId: string, bridge: LarkChannel): void {
    const status = bridge.getConnectionStatus()
    if (status?.state === 'connected') {
      this.deps.imHealth?.heartbeat(channelId, '飞书连接正常。')
    } else if (status?.state === 'reconnecting') {
      this.deps.imHealth?.fail(channelId, { reasonCode: 'network', message: '飞书连接正在重连。' })
    } else if (status?.state === 'failed') {
      this.deps.imHealth?.fail(channelId, { reasonCode: 'bridge_unavailable', message: '飞书连接不可用。' })
    }
  }

  async isChannelBridgeAvailable(channelId: string): Promise<boolean> {
    const settings = await this.deps.store.load()
    const channel = settings.claw.channels.find((item) => item.id === channelId)
    if (!channel) return false
    if (channel.provider === 'feishu') {
      const bridge = this.feishuChannels.get(channelId)
      if (!bridge) return false
      try {
        return bridge.getConnectionStatus()?.state === 'connected'
      } catch {
        return false
      }
    }
    const credential = channel.platformCredential
    if (credential?.kind !== 'weixin' || !this.deps.getWeixinBridgeAccountStatuses) return false
    const status = (await this.deps.getWeixinBridgeAccountStatuses(credential.accountId))[0]?.status
    return status === 'starting' || status === 'connected' || status === 'retrying' || status === 'stale'
  }

  async status(): Promise<ClawRuntimeStatus> {
    const settings = await this.deps.store.load()
    return {
      imServerRunning: this.server !== null && settings.claw.enabled && settings.claw.im.enabled,
      imUrl: webhookUrl(settings),
      runningTaskIds: []
    }
  }

  async runTask(_taskId: string): Promise<ClawRunResult> {
    return { ok: false, reason: 'failed', message: 'Claw scheduled tasks have moved to Schedule.' }
  }

  private async runPrompt(settings: AppSettingsV1, options: RunPromptOptions): Promise<ClawRunResult> {
    const workspace = options.workspaceRoot.trim() || settings.workspaceRoot
    const existingThreadId = options.threadId?.trim()
    const model = normalizeTaskModel(options.model) ?? (settings.agents.kun.model.trim() || DEFAULT_CLAW_MODEL)
    const createThread = async (): Promise<ThreadRecordJson | null> => {
      const body: Record<string, unknown> = { workspace, model, mode: options.mode }
      if (options.source === 'im') {
        body.approvalPolicy = CLAW_IM_APPROVAL_POLICY
        body.sandboxMode = CLAW_IM_SANDBOX_MODE
      }
      const create = await this.deps.runtimeRequest(settings, '/v1/threads', {
        method: 'POST',
        body: JSON.stringify(body)
      })
      if (!create.ok) return null
      return JSON.parse(create.body) as ThreadRecordJson
    }
    const patchThreadTitle = (thread: ThreadRecordJson): void => {
      if (!options.title.trim()) return
      void this.deps.runtimeRequest(settings, `/v1/threads/${encodeURIComponent(thread.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: options.title.trim() })
      })
    }
    let thread: ThreadRecordJson | null = existingThreadId ? { id: existingThreadId } : await createThread()
    if (!thread) return { ok: false, reason: 'failed', message: 'Failed to create thread.' }
    if (!existingThreadId) patchThreadTitle(thread)
    if (options.onThreadSelected) await options.onThreadSelected({ threadId: thread.id })

    const runtimePrompt = buildClawRuntimePrompt(settings, options.prompt, { channel: options.channel })
    const displayText = options.displayText?.trim() || parseClawUserPromptForDisplay(options.prompt).text
    const turnBody: Record<string, unknown> = {
      prompt: runtimePrompt,
      mode: options.mode
    }
    if (options.idempotencyKey?.trim()) turnBody.idempotencyKey = options.idempotencyKey.trim()
    if (displayText && displayText !== runtimePrompt) turnBody.displayText = displayText
    if (model) turnBody.model = model
    // IM senders can only reply in their chat app; they cannot answer
    // GUI prompts, so the runtime must not expose user-input tools.
    if (options.source === 'im') {
      turnBody.disableUserInput = true
      turnBody.approvalPolicy = CLAW_IM_APPROVAL_POLICY
      turnBody.sandboxMode = CLAW_IM_SANDBOX_MODE
    }
    let turn = await this.startRuntimeTurn(settings, thread.id, turnBody)
    if (!turn.ok && existingThreadId && isMissingThreadResult(turn)) {
      this.deps.logError('claw-runtime', 'Configured IM thread was missing; creating a replacement thread.', {
        threadId: existingThreadId,
        channelId: options.channel?.id,
        source: options.source
      })
      thread = await createThread()
      if (!thread) return { ok: false, reason: 'failed', message: 'Failed to create thread.' }
      patchThreadTitle(thread)
      if (options.onThreadSelected) await options.onThreadSelected({ threadId: thread.id })
      turn = await this.startRuntimeTurn(settings, thread.id, turnBody)
    }
    if (!turn.ok) return { ok: false, reason: 'failed', message: runtimeErrorMessage(turn, 'Failed to start turn.') }

    const parsedTurn = parseJsonObject(turn.body)
    const turnId = asString(parsedTurn?.turnId) || asString(nestedRecord(parsedTurn?.turn).id)
    if (!turnId) {
      return { ok: false, reason: 'failed', message: 'Failed to start turn: missing turn id.' }
    }
    if (turnId && options.onTurnStarted) {
      await options.onTurnStarted({ threadId: thread.id, turnId })
    }
    if (!options.waitForResult) {
      return { ok: true, threadId: thread.id, turnId, message: 'Started' }
    }

    let result: Awaited<ReturnType<ClawRuntime['waitForAssistantResult']>>
    try {
      result = await this.waitForAssistantResult(
        settings,
        thread.id,
        turnId,
        options.responseTimeoutMs,
        workspace,
        options.source === 'im' && shouldSendGeneratedFilesForPrompt(displayText)
      )
    } catch (error) {
      const reason = error instanceof ImTurnResultError
        ? error.reason
        : /timed out|timeout|超时/i.test(errorMessage(error))
          ? 'timeout'
          : 'failed'
      if (reason === 'timeout') {
        const interrupted = await this.deps.runtimeRequest(
          settings,
          `/v1/threads/${encodeURIComponent(thread.id)}/turns/${encodeURIComponent(turnId)}/interrupt`,
          { method: 'POST', body: JSON.stringify({ discard: false }) }
        )
        if (!interrupted.ok) {
          this.deps.logError('claw-runtime', 'Failed to interrupt timed-out IM Runtime turn.', {
            threadId: thread.id,
            turnId,
            message: runtimeErrorMessage(interrupted, 'Runtime turn interrupt failed.')
          })
        }
      }
      return {
        ok: false,
        reason,
        message: imRuntimeFailureMessage(settings, errorMessage(error))
      }
    }
    return {
      ok: true,
      threadId: thread.id,
      turnId,
      text: result.text,
      message: result.text || 'Completed',
      files: result.files
    }
  }

  private startRuntimeTurn(
    settings: AppSettingsV1,
    threadId: string,
    turnBody: Record<string, unknown>
  ): Promise<{ ok: boolean; status: number; body: string }> {
    return this.deps.runtimeRequest(
      settings,
      `/v1/threads/${encodeURIComponent(threadId)}/turns`,
      { method: 'POST', body: JSON.stringify(turnBody) }
    )
  }

  private async waitForAssistantResult(
    settings: AppSettingsV1,
    threadId: string,
    turnId: string,
    timeoutMs: number,
    workspaceRoot?: string,
    includeTaskArtifacts = false
  ): Promise<{ text: string; files: ClawGeneratedFileV1[] }> {
    const deadline = Date.now() + timeoutMs
    let lastText = ''
    while (Date.now() < deadline) {
      await sleep(1_500)
      const detailRes = await this.deps.runtimeRequest(
        settings,
        `/v1/threads/${encodeURIComponent(threadId)}`,
        { method: 'GET' }
      )
      if (!detailRes.ok) {
        throw new Error(runtimeErrorMessage(detailRes, 'Failed to read thread result.'))
      }
      const detail = JSON.parse(detailRes.body) as ThreadDetailJson
      lastText = latestAssistantText(detail, { turnId }) || lastText
      const targetTurn = Array.isArray(detail.turns)
        ? detail.turns.find((turn) => turn.id === turnId)
        : undefined
      if (!targetTurn) continue
      const pendingInteraction = pendingTurnInteraction(detail, turnId)
      if (pendingInteraction === 'approval') {
        throw new ImTurnResultError('authorization_required', 'Agent turn is waiting for approval.')
      }
      if (pendingInteraction === 'user_input') {
        throw new ImTurnResultError('user_input_required', 'Agent turn is waiting for user input.')
      }
      if (isRunningStatus(targetTurn.status)) continue
      if (targetTurn.status === 'failed' || targetTurn.status === 'aborted') {
        const error = targetTurn.error?.trim()
        throw new Error(error || `Agent turn ${targetTurn.status}.`)
      }
      if (targetTurn.status === 'completed') {
        let files = latestGeneratedFiles(detail, { turnId, workspaceRoot, fallbackToThread: false })
        if (files.length === 0 && includeTaskArtifacts && workspaceRoot?.trim()) {
          files = await this.completedTaskGeneratedFiles(settings, threadId, turnId, workspaceRoot)
        }
        if (!lastText && files.length === 0) {
          throw new ImTurnResultError('empty_result', 'Agent turn completed without a deliverable result.')
        }
        return {
          text: lastText,
          files
        }
      }
    }
    throw new ImTurnResultError('timeout', 'Timed out waiting for agent response.')
  }

  private async completedTaskGeneratedFiles(
    settings: AppSettingsV1,
    threadId: string,
    turnId: string,
    workspaceRoot: string
  ): Promise<ClawGeneratedFileV1[]> {
    const tasks = await this.deps.runtimeRequest(
      settings,
      `/v1/tasks?threadId=${encodeURIComponent(threadId)}&limit=20`,
      { method: 'GET' }
    )
    if (!tasks.ok) {
      this.deps.logError('claw-runtime', 'Failed to read completed Runtime task artifacts.', {
        threadId,
        turnId,
        status: tasks.status
      })
      return []
    }
    try {
      return generatedFilesFromTaskRuns(JSON.parse(tasks.body), { turnId, workspaceRoot })
    } catch (error) {
      this.deps.logError('claw-runtime', 'Failed to parse completed Runtime task artifacts.', {
        threadId,
        turnId,
        message: errorMessage(error)
      })
      return []
    }
  }

  private resolveChannelWorkspaceRoot(settings: AppSettingsV1, channel?: ClawImChannelV1): string {
    return channel?.workspaceRoot.trim() || settings.claw.im.workspaceRoot.trim() || settings.workspaceRoot
  }

  private legacyEmptyBaseConversationWorkspaceRoot(
    session: Pick<ClawImRemoteSessionV1, 'chatId' | 'threadId'>
  ): string {
    const key = sanitizePathSegment(session.threadId.trim() || session.chatId.trim(), 'conversation')
    return `/conversations/${key}`
  }

  private resolveConversationWorkspaceRoot(
    settings: AppSettingsV1,
    channel: ClawImChannelV1,
    session: Pick<ClawImRemoteSessionV1, 'chatId' | 'threadId'>
  ): string {
    const base = this.resolveChannelWorkspaceRoot(settings, channel).trim()
    const rawKey = `${session.chatId.trim()}\0${session.threadId.trim()}`
    const label = sanitizePathSegment(session.threadId.trim() || session.chatId.trim(), 'conversation')
    const key = `${label}-${createHash('sha256').update(rawKey).digest('hex').slice(0, 12)}`
    return base ? `${base.replace(/\/+$/, '')}/conversations/${key}` : ''
  }

  private resolveIncomingWorkspaceRoot(
    settings: AppSettingsV1,
    channel: ClawImChannelV1 | undefined,
    conversation: ClawImConversationV1 | undefined,
    remoteSession: Pick<ClawImRemoteSessionV1, 'chatId' | 'threadId'> | undefined
  ): string {
    const storedConversationRoot = conversation?.workspaceRoot.trim() ?? ''
    if (storedConversationRoot && remoteSession) {
      const legacyEmptyBaseRoot = this.legacyEmptyBaseConversationWorkspaceRoot(remoteSession)
      if (storedConversationRoot !== legacyEmptyBaseRoot) return storedConversationRoot
    } else if (storedConversationRoot) {
      return storedConversationRoot
    }
    const conversationRoot = channel && remoteSession
      ? this.resolveConversationWorkspaceRoot(settings, channel, remoteSession)
      : ''
    return conversationRoot || this.resolveChannelWorkspaceRoot(settings, channel)
  }

  private findChannelConversation(
    channel: ClawImChannelV1,
    session: Pick<ClawImRemoteSessionV1, 'chatId' | 'threadId'>
  ): ClawImConversationV1 | undefined {
    const targetKey = clawConversationKey(session.chatId, session.threadId)
    return channel.conversations.find((conversation) =>
      clawConversationKey(conversation.chatId, conversation.remoteThreadId) === targetKey
    )
  }

  private isConversationBindingUnique(
    settings: AppSettingsV1,
    conversation: ClawImConversationV1
  ): boolean {
    const localThreadId = conversation.localThreadId.trim()
    if (!localThreadId) return true
    let matches = 0
    for (const channel of settings.claw.channels) {
      for (const item of channel.conversations) {
        if (item.localThreadId.trim() === localThreadId) matches += 1
        if (matches > 1) return false
      }
    }
    return matches === 1
  }

  private async resetIncomingImThread(
    input: {
      channel?: ClawImChannelV1
      conversation?: ClawImConversationV1
      remoteSession?: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'>
    }
  ): Promise<void> {
    if (!input.channel) return
    const currentSettings = await this.deps.store.load()
    const currentChannel = currentSettings.claw.channels.find((item) => item.id === input.channel?.id)
    if (!currentChannel) return
    const session = input.remoteSession
    const currentConversation = session
      ? this.findChannelConversation(currentChannel, session)
      : input.conversation
        ? currentChannel.conversations.find((item) => item.id === input.conversation?.id)
        : undefined
    const now = new Date().toISOString()
    await this.deps.store.patch({
      claw: {
        channels: currentSettings.claw.channels.map((item) => {
          if (item.id !== currentChannel.id) return item
          return {
            ...item,
            threadId: '',
            conversations: currentConversation
              ? item.conversations.map((conversation) =>
                  conversation.id === currentConversation.id
                    ? {
                        ...conversation,
                        latestMessageId: session?.messageId || conversation.latestMessageId,
                        senderId: session?.senderId || conversation.senderId,
                        senderName: session?.senderName || conversation.senderName,
                        localThreadId: '',
                        updatedAt: now
                      }
                    : conversation
                )
              : item.conversations,
            updatedAt: now
          }
        })
      }
    })
  }

  private async setIncomingImModel(channel: ClawImChannelV1 | undefined, model: ClawModel): Promise<void> {
    if (!channel) {
      await this.deps.store.patch({ claw: { im: { model } } })
      return
    }
    const currentSettings = await this.deps.store.load()
    const now = new Date().toISOString()
    await this.deps.store.patch({
      claw: {
        channels: currentSettings.claw.channels.map((item) =>
          item.id === channel.id
            ? {
                ...item,
                model,
                updatedAt: now
              }
            : item
        )
      }
    })
  }

  private async handleIncomingImCommand(
    settings: AppSettingsV1,
    input: {
      text: string
      channel?: ClawImChannelV1
      conversation?: ClawImConversationV1
      remoteSession?: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'>
    }
  ): Promise<string | null> {
    const command = parseClawCommand(input.text)
    if (!command) return null
    if (command.kind === 'help') return imCommandHelpText(settings)
    if (command.kind === 'status') {
      const health = input.channel ? this.deps.imHealth?.get(input.channel.id) : undefined
      return imConnectionStatusText(
        settings,
        input.channel,
        this.deps.getWeixinBridgeAccountStatuses,
        health
      )
    }
    if (command.kind === 'showModel') return imModelCurrentText(settings, currentImModel(settings, input.channel))
    if (command.kind === 'invalidModel') return imModelCommandHint(settings)
    if (command.kind === 'model') {
      const model = normalizeClawModel(
        command.model,
        getManagedRuntimeSettings(settings).providerId || undefined
      )
      await this.setIncomingImModel(input.channel, model)
      return imModelChangedText(settings, model)
    }
    if (command.kind === 'clear') {
      await this.resetIncomingImThread({
        channel: input.channel,
        conversation: input.conversation,
        remoteSession: input.remoteSession
      })
      return imNewTopicText(settings)
    }
    return null
  }

  private async processIncomingImPrompt(
    settings: AppSettingsV1,
    input: {
      prompt: string
      sender: string
      provider: ClawImProvider
      channel?: ClawImChannelV1
      conversation?: ClawImConversationV1
      remoteSession?: Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'>
      idempotencyKey?: string
      ledgerRecord?: ImLedgerMessageV1 | null
    }
  ): Promise<ClawRunResult> {
    const { channel, conversation, prompt, provider, remoteSession, sender } = input
    const initialThreadId =
      input.ledgerRecord?.runtimeThreadId?.trim() ||
      conversation?.localThreadId.trim() ||
      (!remoteSession ? channel?.threadId.trim() : '') ||
      ''
    const leaseGuard = this.startInboundLeaseRenewal(input.ledgerRecord)
    try {
      leaseGuard.assertOwned()
      const result = await this.runPrompt(settings, {
        prompt,
        title: channel ? `[Claw IM:${channel.label}] ${sender}` : `[Claw IM:${provider}] ${sender}`,
        workspaceRoot: this.resolveIncomingWorkspaceRoot(settings, channel, conversation, remoteSession),
        model: channel?.model ?? settings.claw.im.model,
        mode: settings.claw.im.mode,
        waitForResult: true,
        responseTimeoutMs: resolveImResponseTimeoutMs(provider, settings.claw.im.responseTimeoutMs),
        source: 'im',
        threadId: initialThreadId || undefined,
        idempotencyKey: input.idempotencyKey,
        channel,
        onThreadSelected: async ({ threadId }) => {
          leaseGuard.assertOwned()
          if (!input.ledgerRecord || !this.deps.imLedger) return
          if (input.ledgerRecord.leaseRunId) {
            this.deps.imLedger.updateClaimed(input.ledgerRecord.id, input.ledgerRecord.leaseRunId, {
              status: 'turn_starting',
              runtimeThreadId: threadId
            })
          } else {
            this.deps.imLedger.update(input.ledgerRecord.id, {
              status: 'turn_starting',
              runtimeThreadId: threadId
            })
          }
          this.updateInboundCounts(input.ledgerRecord)
        },
        onTurnStarted: async ({ threadId, turnId }) => {
          leaseGuard.assertOwned()
          if (input.ledgerRecord && this.deps.imLedger) {
            if (input.ledgerRecord.leaseRunId) {
              this.deps.imLedger.updateClaimed(input.ledgerRecord.id, input.ledgerRecord.leaseRunId, {
                status: 'turn_started',
                runtimeThreadId: threadId,
                runtimeTurnId: turnId
              })
            } else {
              this.deps.imLedger.update(input.ledgerRecord.id, {
                status: 'turn_started',
                runtimeThreadId: threadId,
                runtimeTurnId: turnId
              })
            }
            this.updateInboundCounts(input.ledgerRecord)
          }
        if (!channel) return
        const now = new Date().toISOString()
        // Patch from a fresh settings snapshot: the request-scoped
        // `settings` may be stale by now (e.g. the welcome marker was
        // persisted while this turn was starting).
        const latestSettings = await this.deps.store.load()
        if (remoteSession) {
          const latestChannel = latestSettings.claw.channels.find((item) => item.id === channel.id) ?? channel
          const existingConversation = conversation
            ? latestChannel.conversations.find((item) => item.id === conversation.id) ?? conversation
            : this.findChannelConversation(latestChannel, remoteSession)
          const workspaceConversation = existingConversation && this.isConversationBindingUnique(latestSettings, existingConversation)
            ? existingConversation
            : undefined
          const nextConversation: ClawImConversationV1 = existingConversation
            ? {
                ...existingConversation,
                latestMessageId: remoteSession.messageId,
                senderId: remoteSession.senderId,
                senderName: remoteSession.senderName,
                localThreadId: threadId,
                workspaceRoot: this.resolveIncomingWorkspaceRoot(settings, channel, workspaceConversation, remoteSession),
                updatedAt: now
              }
            : {
                id: randomUUID(),
                chatId: remoteSession.chatId,
                remoteThreadId: remoteSession.threadId,
                latestMessageId: remoteSession.messageId,
                senderId: remoteSession.senderId,
                senderName: remoteSession.senderName,
                localThreadId: threadId,
                workspaceRoot: this.resolveConversationWorkspaceRoot(settings, channel, remoteSession),
                createdAt: now,
                updatedAt: now
              }
          await this.deps.store.patch({
            claw: {
              channels: latestSettings.claw.channels.map((item) =>
                item.id === channel.id
                  ? {
                      ...item,
                      threadId,
                      conversations: existingConversation
                        ? item.conversations.map((entry) => entry.id === existingConversation.id ? nextConversation : entry)
                        : [...item.conversations, nextConversation],
                      updatedAt: now
                    }
                  : item
              )
            }
          })
        } else if (!initialThreadId || threadId !== initialThreadId) {
          await this.deps.store.patch({
            claw: {
              channels: latestSettings.claw.channels.map((item) =>
                item.id === channel.id
                  ? {
                      ...item,
                      threadId,
                      updatedAt: now
                    }
                  : item
              )
            }
          })
        }
          this.deps.notifyChannelActivity?.({ channelId: channel.id, threadId })
        }
      })
      leaseGuard.assertOwned()
      return result
    } finally {
      leaseGuard.stop()
    }
  }

  private resolveFeishuChannels(settings: AppSettingsV1): FeishuClawChannel[] {
    if (!settings.claw.enabled || !isCandidateImProviderConnectionAllowed('feishu')) return []
    return settings.claw.channels.filter(
      (channel): channel is FeishuClawChannel =>
        channel.enabled &&
        channel.provider === 'feishu' &&
        hasFeishuPlatformCredential(channel)
    )
  }

  private buildFeishuRemoteSession(message: NormalizedMessage): ClawImRemoteSessionV1 {
    return {
      chatId: message.chatId.trim(),
      messageId: message.messageId.trim(),
      threadId: message.threadId?.trim() || '',
      senderId: message.senderId.trim(),
      senderName: feishuSenderLabel(message),
      updatedAt: new Date().toISOString()
    }
  }

  private async rememberFeishuRemoteSession(
    settings: AppSettingsV1,
    channel: ClawImChannelV1,
    message:
      | NormalizedMessage
      | Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'>
  ): Promise<void> {
    const nextRemoteSession =
      'chatType' in message
        ? this.buildFeishuRemoteSession(message)
        : {
            ...message,
            updatedAt: new Date().toISOString()
          }
    const current = channel.remoteSession
    if (
      current?.chatId === nextRemoteSession.chatId &&
      current?.messageId === nextRemoteSession.messageId &&
      current?.threadId === nextRemoteSession.threadId &&
      current?.senderId === nextRemoteSession.senderId &&
      current?.senderName === nextRemoteSession.senderName
    ) {
      return
    }
    await this.deps.store.patch({
      claw: {
        channels: settings.claw.channels.map((item) =>
          item.id === channel.id
            ? {
                ...item,
                remoteSession: nextRemoteSession,
                updatedAt: nextRemoteSession.updatedAt
              }
            : item
        )
      }
    })
  }

  private async sendFeishuMessage(
    bridge: LarkChannel,
    to: string,
    input: SendInput,
    options: SendOptions,
    context: Record<string, unknown>,
    outboundId?: string,
    leaseGuard?: InboundLeaseGuard
  ): Promise<SendResult> {
    if (isCandidateOutboundDisabled('feishu', to)) {
      throw new Error('Candidate IM outbound is disabled.')
    }
    leaseGuard?.assertOwned()
    let stableContent = outboundId ? stableFeishuContent(input, options) : undefined
    if (outboundId && !stableContent && 'file' in input) {
      const source = input.file.source
      const buffer = Buffer.isBuffer(source) ? source : await readFile(source)
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          leaseGuard?.assertOwned()
          const uploaded = await bridge.rawClient.im.v1.file.create({
            data: {
              file_type: 'stream',
              file_name: input.file.fileName,
              file: buffer
            }
          }) as unknown as { file_key?: string; data?: { file_key?: string } } | null
          leaseGuard?.assertOwned()
          const fileKey = uploaded?.file_key || uploaded?.data?.file_key
          if (!fileKey) throw new Error('file_key missing from Feishu upload response')
          stableContent = { msgType: 'file', content: JSON.stringify({ file_key: fileKey }) }
          break
        } catch (error) {
          if (isInboundLeaseLostError(error)) throw error
          lastError = error
          if (attempt < 2) await sleep(500 * (attempt + 1))
        }
      }
      if (!stableContent) throw lastError
    }
    if (outboundId && stableContent) {
      const sendWithRetry = async (operation: () => Promise<{ data?: { message_id?: string } } | null>): Promise<SendResult> => {
        let lastError: unknown
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            leaseGuard?.assertOwned()
            const response = await operation()
            leaseGuard?.assertOwned()
            const messageId = response?.data?.message_id
            if (!messageId) throw new Error('message_id missing from Feishu send response')
            return { messageId }
          } catch (error) {
            if (isInboundLeaseLostError(error)) throw error
            lastError = error
            if (attempt < 2) await sleep(500 * (attempt + 1))
          }
        }
        throw lastError
      }
      try {
        if (options.replyTo) {
          return await sendWithRetry(() => bridge.rawClient.im.v1.message.reply({
            path: { message_id: options.replyTo! },
            data: {
              msg_type: stableContent.msgType,
              content: stableContent.content,
              reply_in_thread: options.replyInThread,
              uuid: outboundId
            }
          }))
        }
        return await sendWithRetry(() => bridge.rawClient.im.v1.message.create({
          params: { receive_id_type: feishuReceiveIdType(to) },
          data: {
            receive_id: to,
            msg_type: stableContent.msgType,
            content: stableContent.content,
            uuid: outboundId
          }
        }))
      } catch (error) {
        if (isInboundLeaseLostError(error)) throw error
        const initialMessage = errorMessage(error)
        if (!options.replyTo) {
          this.deps.logError('claw-feishu', 'Failed to send stable Feishu / Lark message', {
            ...context,
            message: initialMessage,
            outboundId,
            to
          })
          throw error
        }
        this.deps.logError('claw-feishu', 'Failed to send stable Feishu / Lark reply; retrying as a chat message.', {
          ...context,
          message: initialMessage,
          outboundId,
          replyTo: options.replyTo,
          to
        })
        return sendWithRetry(() => bridge.rawClient.im.v1.message.create({
          params: { receive_id_type: feishuReceiveIdType(to) },
          data: {
            receive_id: to,
            msg_type: stableContent.msgType,
            content: stableContent.content,
            uuid: outboundId
          }
        }))
      }
    }
    try {
      leaseGuard?.assertOwned()
      const result = await bridge.send(to, input, options)
      leaseGuard?.assertOwned()
      return result
    } catch (error) {
      if (isInboundLeaseLostError(error)) throw error
      const initialMessage = errorMessage(error)
      if (!options.replyTo) {
        this.deps.logError('claw-feishu', 'Failed to send Feishu / Lark message', {
          ...context,
          message: initialMessage,
          to
        })
        throw error
      }

      this.deps.logError('claw-feishu', 'Failed to send Feishu / Lark reply; falling back to plain chat message.', {
        ...context,
        message: initialMessage,
        replyTo: options.replyTo,
        replyInThread: options.replyInThread,
        to
      })
      try {
        leaseGuard?.assertOwned()
        const result = await bridge.send(to, input, {
          ...options,
          replyTo: undefined,
          replyInThread: undefined
        })
        leaseGuard?.assertOwned()
        return result
      } catch (fallbackError) {
        if (isInboundLeaseLostError(fallbackError)) throw fallbackError
        this.deps.logError('claw-feishu', 'Failed to send Feishu / Lark fallback message', {
          ...context,
          initialMessage,
          message: errorMessage(fallbackError),
          to
        })
        throw fallbackError
      }
    }
  }

  private async deliverFeishuReply(
    record: ImLedgerMessageV1 | null | undefined,
    bridge: LarkChannel,
    to: string,
    delivery: ImStoredDeliveryV1 | undefined,
    options: SendOptions,
    context: Record<string, unknown>
  ): Promise<void> {
    if (!delivery || !this.beginInboundDelivery(record)) return
    const leaseGuard = this.startInboundLeaseRenewal(record)
    try {
      leaseGuard.assertOwned()
      const files = delivery.files ?? []
      if (files.length > 0) {
        const fileDelivery = await this.sendFeishuGeneratedFiles(
          bridge,
          to,
          files,
          options,
          context,
          delivery.outboundId ?? (record ? imOutboundId(record) : undefined),
          leaseGuard
        )
        if (fileDelivery.failed.length > 0) {
          await this.sendFeishuFileFailureNotice(
            bridge,
            to,
            options,
            context,
            delivery.outboundId ?? (record ? imOutboundId(record) : undefined),
            leaseGuard
          )
          throw new Error(`Feishu file delivery failed: ${fileDelivery.failed[0]?.message || 'unknown upload error'}`)
        }
      }
      await this.sendFeishuMessage(
        bridge,
        to,
        { markdown: delivery.reply },
        options,
        context,
        delivery.outboundId ?? (record ? imOutboundId(record) : undefined),
        leaseGuard
      )
      leaseGuard.assertOwned()
      const channelId = typeof context.channelId === 'string' ? context.channelId : record?.channelId
      if (channelId) this.deps.imHealth?.outbound(channelId)
      this.finishInboundDelivery(record, delivery)
    } catch (error) {
      if (!isInboundLeaseLostError(error)) {
        this.retryInboundDelivery(record, errorMessage(error))
      }
      throw error
    } finally {
      leaseGuard.stop()
    }
  }

  private async sendFeishuFileFailureNotice(
    bridge: LarkChannel,
    to: string,
    options: SendOptions,
    context: Record<string, unknown>,
    outboundId?: string,
    leaseGuard?: InboundLeaseGuard
  ): Promise<void> {
    try {
      await this.sendFeishuMessage(
        bridge,
        to,
        { markdown: '文件已生成，但附件发送失败，RailWise AI 将自动重试；当前任务尚未完成。' },
        options,
        { ...context, purpose: 'file-delivery-failed' },
        outboundId?.trim() ? `${outboundId.trim()}-failure` : undefined,
        leaseGuard
      )
    } catch (error) {
      if (isInboundLeaseLostError(error)) throw error
      this.deps.logError('claw-feishu', 'Failed to send Feishu / Lark attachment failure notice', {
        ...context,
        message: errorMessage(error),
        to
      })
    }
  }

  private async resolveImGeneratedFiles(
    files: readonly ClawGeneratedFileV1[],
    workspaceRoot: string | readonly string[],
    context: Record<string, unknown>
  ): Promise<ClawGeneratedFileV1[]> {
    const roots = (Array.isArray(workspaceRoot) ? workspaceRoot : [workspaceRoot])
      .map((entry) => entry.trim())
      .filter((entry, index, entries) => entry.length > 0 && entries.indexOf(entry) === index)
    if (roots.length === 0 || files.length === 0) return []
    const realRoots: string[] = []
    for (const root of roots) {
      try {
        const realRoot = await realpath(resolve(root))
        if (!realRoots.includes(realRoot)) realRoots.push(realRoot)
      } catch (error) {
        this.deps.logError('claw-im', 'Failed to resolve IM file workspace root', {
          ...context,
          workspaceRoot: root,
          message: errorMessage(error)
        })
      }
    }
    if (realRoots.length === 0) return []

    const resolvedFiles: ClawGeneratedFileV1[] = []
    const seen = new Set<string>()
    for (const file of files) {
      try {
        const realFile = await realpath(resolve(file.path))
        const insideWorkspace = realRoots.some((realRoot) => {
          const relativePath = relative(realRoot, realFile)
          return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
        })
        if (!insideWorkspace) {
          this.deps.logError('claw-im', 'Skipping generated file outside the IM workspace', {
            ...context,
            filePath: file.path,
            workspaceRoots: roots
          })
          continue
        }
        if (seen.has(realFile)) continue
        const fileStat = await stat(realFile)
        if (!fileStat.isFile()) continue
        if (fileStat.size > MAX_IM_FILE_UPLOAD_BYTES) {
          this.deps.logError('claw-im', 'Skipping generated file because it is too large for IM upload', {
            ...context,
            filePath: realFile,
            bytes: fileStat.size,
            maxBytes: MAX_IM_FILE_UPLOAD_BYTES
          })
          continue
        }
        seen.add(realFile)
        resolvedFiles.push({
          ...file,
          path: realFile,
          fileName: file.fileName || realFile.split(/[\\/]/).pop() || 'attachment'
        })
      } catch (error) {
        this.deps.logError('claw-im', 'Skipping generated file that cannot be read for IM upload', {
          ...context,
          filePath: file.path,
          message: errorMessage(error)
        })
      }
    }
    return resolvedFiles
  }

  private async sendFeishuGeneratedFiles(
    bridge: LarkChannel,
    to: string,
    files: readonly ClawGeneratedFileV1[],
    options: SendOptions,
    context: Record<string, unknown>,
    outboundId?: string,
    leaseGuard?: InboundLeaseGuard
  ): Promise<{ sent: ClawGeneratedFileV1[]; failed: Array<{ file: ClawGeneratedFileV1; message: string }> }> {
    const sent: ClawGeneratedFileV1[] = []
    const failed: Array<{ file: ClawGeneratedFileV1; message: string }> = []
    for (const [index, file] of files.entries()) {
      try {
        leaseGuard?.assertOwned()
        await this.sendFeishuMessage(
          bridge,
          to,
          { file: { source: file.path, fileName: file.fileName } },
          options,
          {
            ...context,
            purpose: 'agent-file',
            filePath: file.path,
            fileName: file.fileName
          },
          outboundId?.trim() ? `${outboundId.trim()}-file-${index + 1}` : undefined,
          leaseGuard
        )
        leaseGuard?.assertOwned()
        sent.push(file)
      } catch (error) {
        if (isInboundLeaseLostError(error)) throw error
        const message = errorMessage(error)
        failed.push({ file, message })
        this.deps.logError('claw-feishu', 'Failed to send Feishu / Lark file attachment', {
          ...context,
          filePath: file.path,
          fileName: file.fileName,
          message
        })
      }
    }
    return { sent, failed }
  }

  private async recentGeneratedFilesForThread(
    settings: AppSettingsV1,
    threadId: string,
    workspaceRoot: string,
    context: Record<string, unknown>,
    options: { turnId?: string; fallbackToThread?: boolean } = {}
  ): Promise<ClawGeneratedFileV1[]> {
    const targetThreadId = threadId.trim()
    if (!targetThreadId) return []
    try {
      const detailRes = await this.deps.runtimeRequest(
        settings,
        `/v1/threads/${encodeURIComponent(targetThreadId)}`,
        { method: 'GET' }
      )
      if (!detailRes.ok) {
        this.deps.logError('claw-im', 'Failed to read recent generated files from RailWise AI Runtime thread', {
          ...context,
          threadId: targetThreadId,
          message: runtimeErrorMessage(detailRes, 'Failed to read thread result.')
        })
        return []
      }
      return latestGeneratedFiles(JSON.parse(detailRes.body) as ThreadDetailJson, {
        turnId: options.turnId,
        workspaceRoot,
        maxFiles: 3,
        fallbackToThread: options.fallbackToThread
      })
    } catch (error) {
      this.deps.logError('claw-im', 'Failed to inspect RailWise AI Runtime thread for recent generated files', {
        ...context,
        threadId: targetThreadId,
        message: errorMessage(error)
      })
      return []
    }
  }

  private findImChannelsForThread(
    settings: AppSettingsV1,
    threadId: string
  ): Array<{ channel: ClawImChannelV1; conversation?: ClawImConversationV1 }> {
    const targetThreadId = threadId.trim()
    if (!targetThreadId) return []
    const conversationTargets: Array<{ channel: ClawImChannelV1; conversation: ClawImConversationV1 }> = []
    for (const channel of settings.claw.channels) {
      if (!channel.enabled) continue
      for (const conversation of channel.conversations) {
        if (conversation.localThreadId.trim() === targetThreadId && conversation.chatId.trim()) {
          conversationTargets.push({ channel, conversation })
        }
      }
    }
    if (conversationTargets.length > 0) return conversationTargets

    // Legacy settings may predate per-conversation bindings. Only allow that
    // fallback when the channel has no conversation rows at all and still has
    // one explicit remote target. Never guess between persisted conversations.
    return settings.claw.channels
      .filter((channel) =>
        channel.enabled &&
        channel.threadId.trim() === targetThreadId &&
        channel.conversations.length === 0 &&
        Boolean(channel.remoteSession?.chatId.trim())
      )
      .map((channel) => ({ channel }))
  }

  private async generatedFilesForLocalMirror(
    settings: AppSettingsV1,
    target: { channel: ClawImChannelV1; conversation?: ClawImConversationV1 },
    threadId: string,
    replyText: string,
    direction: 'user' | 'assistant',
    options: { turnId?: string; requestText?: string }
  ): Promise<ClawGeneratedFileV1[]> {
    if (direction !== 'assistant') return []
    const requestText = options.requestText?.trim() || ''
    const fileRequestText = requestText || replyText
    if (!shouldSendGeneratedFilesForPrompt(fileRequestText)) return []
    const workspaceRoot = target.conversation?.workspaceRoot.trim() ||
      this.resolveChannelWorkspaceRoot(settings, target.channel)
    const candidates = await this.recentGeneratedFilesForThread(
      settings,
      threadId,
      workspaceRoot,
      {
        purpose: 'local-im-mirror-file-lookup',
        provider: target.channel.provider,
        channelId: target.channel.id,
        threadId,
        turnId: options.turnId
      },
      {
        turnId: options.turnId,
        fallbackToThread: !options.turnId?.trim()
      }
    )
    return this.resolveImGeneratedFiles(
      filterGeneratedFilesForPrompt(fileRequestText, candidates),
      workspaceRoot,
      {
        purpose: 'local-im-mirror-file-resolve',
        provider: target.channel.provider,
        channelId: target.channel.id,
        threadId,
        turnId: options.turnId
      }
    )
  }

  private async mirrorThreadMessageToWeixin(
    channel: ClawImChannelV1,
    conversation: ClawImConversationV1 | undefined,
    threadId: string,
    text: string,
    direction: 'user' | 'assistant',
    files: readonly ClawGeneratedFileV1[] = [],
    outboundId?: string
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const credential = channel.platformCredential
    if (credential?.kind !== 'weixin' || !credential.accountId.trim()) {
      return { ok: false, message: 'No target WeChat account is available yet.' }
    }
    const to = conversation?.chatId.trim() || channel.remoteSession?.chatId.trim() || ''
    if (!to) return { ok: false, message: 'No target WeChat conversation is available yet.' }
    if (!this.deps.sendWeixinBridgeMessage) {
      return { ok: false, message: 'Built-in WeChat bridge is not initialized.' }
    }
    const result = await this.deps.sendWeixinBridgeMessage({
      accountId: credential.accountId,
      to,
      text,
      ...(outboundId ? { clientId: outboundId } : {}),
      ...(files.length > 0 ? { files: [...files] } : {})
    })
    if (result.ok) {
      this.deps.imHealth?.outbound(channel.id)
      return { ok: true }
    }
    this.deps.logError('claw-weixin', 'Failed to mirror Claw message to WeChat', {
      message: result.message,
      threadId,
      direction,
      channelId: channel.id,
      to
    })
    return result
  }

  async mirrorThreadMessageToIm(
    threadId: string,
    text: string,
    direction: 'user' | 'assistant',
    options: { turnId?: string; requestText?: string } = {}
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const trimmed = text.trim()
    if (!trimmed) return { ok: false, message: 'Message is empty.' }
    const settings = await this.deps.store.load()
    const targets = this.findImChannelsForThread(settings, threadId)
    if (targets.length === 0) return { ok: false, message: 'Channel not found.' }
    if (targets.length > 1) {
      this.deps.logError('claw-im', 'Blocked outbound mirror because the Runtime thread has multiple remote targets.', {
        threadId,
        targetCount: targets.length,
        targets: targets.map(({ channel, conversation }) => ({
          channelId: channel.id,
          provider: channel.provider,
          conversationId: conversation?.id
        }))
      })
      return {
        ok: false,
        message: 'This Runtime conversation is bound to multiple phone chats. Sending was blocked to prevent delivery to the wrong chat.'
      }
    }
    const target = targets[0]!
    const files = await this.generatedFilesForLocalMirror(
      settings,
      target,
      threadId,
      trimmed,
      direction,
      options
    )
    const mirrorText = replyTextForGeneratedFiles(trimmed, files)
    const outboundId = localMirrorOutboundId(target.channel.provider, threadId, options.turnId, direction)
    if (target.channel.provider === 'weixin') {
      return this.mirrorThreadMessageToWeixin(
        target.channel,
        target.conversation,
        threadId,
        mirrorText,
        direction,
        files,
        outboundId
      )
    }
    if (target.channel.provider !== 'feishu') return { ok: false, message: 'Unsupported IM provider.' }
    const channel = target.channel
    const conversation =
      target.conversation ??
      [...channel.conversations]
        .filter((item) => item.localThreadId.trim() === threadId.trim())
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
    if (!conversation?.chatId.trim()) {
      return { ok: false, message: 'No target Feishu / Lark conversation is available yet.' }
    }
    const bridge = this.feishuChannels.get(channel.id)
    if (!bridge) {
      return { ok: false, message: 'Feishu / Lark bridge is not connected.' }
    }
    try {
      if (files.length > 0) {
        const delivery = await this.sendFeishuGeneratedFiles(
          bridge,
          conversation.chatId,
          files,
          {},
          {
            purpose: 'mirror-file',
            threadId,
            direction,
            channelId: channel.id,
            chatId: conversation.chatId
          },
          outboundId
        )
        if (delivery.failed.length > 0) {
          await this.sendFeishuFileFailureNotice(
            bridge,
            conversation.chatId,
            {},
            {
              purpose: 'mirror-file-failed',
              threadId,
              direction,
              channelId: channel.id,
              chatId: conversation.chatId
            },
            outboundId
          )
          return { ok: false, message: delivery.failed[0]?.message || 'Feishu file delivery failed.' }
        }
      }
      await this.sendFeishuMessage(
        bridge,
        conversation.chatId,
        formatFeishuMirrorText(mirrorText, direction),
        {},
        {
          purpose: 'mirror',
          threadId,
          direction,
          channelId: channel.id,
          chatId: conversation.chatId
        },
        outboundId
      )
      this.deps.imHealth?.outbound(channel.id)
      return { ok: true }
    } catch (error) {
      const message = errorMessage(error)
      this.deps.logError('claw-feishu', 'Failed to mirror Claw message to Feishu / Lark', {
        message,
        threadId,
        direction
      })
      return { ok: false, message }
    }
  }

  async mirrorThreadMessageToFeishu(
    threadId: string,
    text: string,
    direction: 'user' | 'assistant'
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.mirrorThreadMessageToIm(threadId, text, direction)
  }

  private async handleFeishuMessage(
    channelId: string,
    message: NormalizedMessage,
    recoveryRecord?: ImLedgerMessageV1
  ): Promise<void> {
    const key = `feishu:${channelId}:${message.chatId}:${message.threadId || 'root'}`
    await this.enqueueInbound(key, () => this.handleFeishuMessageCore(channelId, message, recoveryRecord))
  }

  private async handleFeishuMessageCore(
    channelId: string,
    message: NormalizedMessage,
    recoveryRecord?: ImLedgerMessageV1
  ): Promise<void> {
    const bridge = this.feishuChannels.get(channelId)
    const settings = await this.deps.store.load()
    const channel = settings.claw.channels.find((item) => item.id === channelId && item.enabled)
    if (!bridge || !channel) return
    if (!recoveryRecord && !isCandidateInboundAllowed('feishu', message.chatId, message.content)) {
      this.deps.logError('claw-feishu', 'Candidate Feishu message ignored by the inbound safety gate.', {
        channelId,
        chatId: message.chatId,
        messageId: message.messageId
      })
      return
    }
    if (!recoveryRecord && bridge.botIdentity?.openId && message.senderId === bridge.botIdentity.openId) return
    if (!recoveryRecord && message.chatType === 'group' && !message.mentionedBot && !message.mentionAll) return
    await this.rememberFeishuRemoteSession(settings, channel, message)
    const remoteSession = this.buildFeishuRemoteSession(message)
    const storedConversation = this.findChannelConversation(channel, {
      chatId: remoteSession.chatId,
      threadId: remoteSession.threadId
    })
    const conversation = storedConversation && this.isConversationBindingUnique(settings, storedConversation)
      ? storedConversation
      : undefined
    const workspaceRoot = this.resolveIncomingWorkspaceRoot(settings, channel, conversation, remoteSession)
    const replyOptions = { replyTo: message.messageId, replyInThread: Boolean(message.threadId) }
    const accountId = channel.platformCredential?.kind === 'feishu'
      ? channel.platformCredential.appId
      : channel.id
    if (!recoveryRecord) this.deps.imHealth?.inbound(channelId)
    const ledgerRecord = recoveryRecord
      ? this.deps.imLedger?.claim(recoveryRecord.id, randomUUID()) ?? null
      : this.claimInbound({
          provider: 'feishu',
          accountId,
          channelId,
          remoteMessageId: message.messageId,
          chatId: message.chatId,
          senderId: message.senderId,
          threadId: message.threadId || '',
          prompt: message.content,
          payload: message
        })
    if (this.deps.imLedger && ledgerRecord === null) return
    if (ledgerRecord && (ledgerRecord.status === 'result_ready' || ledgerRecord.status === 'delivering')) {
      const stored = parseStoredDelivery(ledgerRecord)
      if (!stored) {
        this.failInboundDelivery(ledgerRecord, 'Stored Feishu delivery payload is invalid.')
        return
      }
      try {
        await this.deliverFeishuReply(ledgerRecord, bridge, message.chatId, stored, replyOptions, {
          purpose: 'recovered-delivery',
          channelId,
          chatId: message.chatId,
          inboundMessageId: message.messageId
        })
      } catch (error) {
        this.deps.logError('claw-feishu', 'Failed to recover Feishu / Lark delivery', {
          message: errorMessage(error),
          channelId,
          chatId: message.chatId,
          inboundMessageId: message.messageId
        })
        return
      }
      return
    }

    // Feishu has no recipient until someone messages the bot, so the
    // one-time channel intro goes out before handling the first message.
    const welcomeText = this.pendingWelcomeText(settings, channel)
    if (welcomeText) {
      this.welcomeInFlight.add(channel.id)
      try {
        await this.sendFeishuMessage(
          bridge,
          message.chatId,
          { markdown: welcomeText },
          {},
          {
            purpose: 'welcome',
            channelId,
            chatId: message.chatId,
            inboundMessageId: message.messageId
          }
        )
        await this.markChannelWelcomeSent(channel.id)
      } catch (error) {
        this.deps.logError('claw-feishu', 'Failed to send the Feishu welcome message; it will be retried on the next inbound message.', {
          message: errorMessage(error),
          channelId,
          chatId: message.chatId
        })
      } finally {
        this.welcomeInFlight.delete(channel.id)
      }
    }

    const commandReply = await this.handleIncomingImCommand(settings, {
      text: message.content,
      channel,
      conversation,
      remoteSession
    })
    if (commandReply !== null) {
      const delivery = this.prepareInboundDelivery(ledgerRecord, { ok: true, reply: commandReply })
      await this.deliverFeishuReply(ledgerRecord, bridge, message.chatId, delivery, replyOptions, {
          purpose: 'im-command',
          channelId,
          chatId: message.chatId,
          inboundMessageId: message.messageId
        })
      return
    }

    const sender = feishuSenderLabel(message)
    const taskCreation = await this.deps.createScheduledTaskFromText?.(message.content, {
      workspaceRoot: this.resolveChannelWorkspaceRoot(settings, channel),
      modelHint: channel.model,
      mode: settings.claw.im.mode
    }) ?? { kind: 'noop' as const }
    if (taskCreation.kind === 'created') {
      const delivery = this.prepareInboundDelivery(ledgerRecord, {
        ok: true,
        reply: taskCreation.confirmationText,
        createdTaskId: taskCreation.taskId
      })
      await this.deliverFeishuReply(ledgerRecord, bridge, message.chatId, delivery, replyOptions, {
          purpose: 'schedule-created',
          channelId,
          chatId: message.chatId,
          inboundMessageId: message.messageId
        })
      return
    }
    if (taskCreation.kind === 'error') {
      const reply = `Failed to create the scheduled task: ${taskCreation.message}`
      const delivery = this.prepareInboundDelivery(ledgerRecord, { ok: false, reply, message: taskCreation.message })
      await this.deliverFeishuReply(ledgerRecord, bridge, message.chatId, delivery, replyOptions, {
          purpose: 'schedule-error',
          channelId,
          chatId: message.chatId,
          inboundMessageId: message.messageId
        })
      return
    }
    if (!message.content.trim() && message.rawContentType !== 'text') {
      const delivery = this.prepareInboundDelivery(ledgerRecord, {
        ok: false,
        reply: 'Only text messages are supported right now.',
        message: 'Unsupported message type.'
      })
      try {
        await this.deliverFeishuReply(ledgerRecord, bridge, message.chatId, delivery, replyOptions, {
            purpose: 'unsupported-message',
            channelId,
            chatId: message.chatId,
            inboundMessageId: message.messageId
          })
      } catch (error) {
        this.deps.logError('claw-feishu', 'Failed to send unsupported-message reply', {
          message: errorMessage(error),
          chatId: message.chatId
        })
      }
      return
    }

    if (shouldDirectSendExistingGeneratedFilesForPrompt(message.content)) {
      const existingThreadId = conversation?.localThreadId.trim() || ''
      const existingFiles = filterGeneratedFilesForPrompt(message.content, await this.resolveImGeneratedFiles(
        await this.recentGeneratedFilesForThread(settings, existingThreadId, workspaceRoot, {
          purpose: 'direct-existing-file-lookup',
          channelId,
          chatId: message.chatId,
          inboundMessageId: message.messageId,
          threadId: existingThreadId
        }),
        workspaceRoot,
        {
          purpose: 'direct-existing-file-resolve',
          channelId,
          chatId: message.chatId,
          inboundMessageId: message.messageId,
          threadId: existingThreadId
        }
      ))
      if (existingFiles.length > 0) {
        const confirmation = replyTextForGeneratedFiles('', existingFiles)
        const storedDelivery = this.prepareInboundDelivery(ledgerRecord, {
          ok: true,
          reply: confirmation,
          files: existingFiles,
          threadId: existingThreadId
        })
        try {
          await this.deliverFeishuReply(ledgerRecord, bridge, message.chatId, storedDelivery, replyOptions, {
            purpose: 'direct-existing-file-reply',
            channelId,
            chatId: message.chatId,
            inboundMessageId: message.messageId,
            threadId: existingThreadId
          })
        } catch (error) {
          this.deps.logError('claw-feishu', 'Failed to deliver direct file reply', {
            message: errorMessage(error),
            chatId: message.chatId,
            threadId: existingThreadId
          })
        }
        return
      }
    }

    // Add a "in progress" emoji reaction on the user's inbound message
    // immediately so they see feedback before the agent run completes
    // (which can take seconds). The reaction is targeted at the user's
    // message id (not a new bot message) and is left in place after the
    // agent finishes as a "handled" marker.
    //
    // Emoji type selection: Feishu / Lark's `im.v1.messageReaction.create`
    // endpoint accepts a closed set of `emoji_type` strings; the SDK does
    // NOT validate them locally — invalid values are rejected by the API
    // with `code 231001 "reaction type is invalid"`. Empirically verified:
    //   - `'WORK'`  → REJECTED (production logs, code 231001) — never use
    //   - `'OnIt'`  → CONFIRMED VALID — renders as 🫡 (salute face,
    //                 internet-canonical "got it, doing it" signal;
    //                 best match for the user-requested "在做了")
    //   - `'SMILE'` → CONFIRMED VALID — fallback, renders as 🙂
    //
    // Failure is logged but NOT re-thrown — we never want a reaction
    // failure to drop the user's message or abort the agent run.
    try {
      if (!isCandidateOutboundDisabled('feishu', message.chatId)) await bridge.addReaction(message.messageId, 'OnIt')
    } catch (error) {
      this.deps.logError('claw-feishu', 'Failed to add Feishu / Lark pending reaction; continuing with the agent run.', {
        message: errorMessage(error),
        chatId: message.chatId,
        messageId: message.messageId
      })
    }

    let result: ClawRunResult
    try {
      result = await this.processIncomingImPrompt(settings, {
        prompt: buildFeishuPrompt(message),
        sender,
        provider: 'feishu',
        channel,
        conversation,
        remoteSession,
        idempotencyKey: ledgerRecord?.idempotencyKey ?? `im:feishu:${channel.platformCredential?.kind === 'feishu' ? channel.platformCredential.appId : channel.id}:${message.messageId}`,
        ledgerRecord
      })
    } catch (error) {
      result = { ok: false, reason: 'failed', message: errorMessage(error) }
      this.deps.logError('claw-feishu', 'Failed to handle Feishu inbound message', {
        message: errorMessage(error),
        chatId: message.chatId,
        senderId: message.senderId
      })
    }

    const filesToSend = result.ok && shouldSendGeneratedFilesForPrompt(message.content)
      ? await this.resolveImGeneratedFiles(result.files ?? [], [
          workspaceRoot,
          this.resolveChannelWorkspaceRoot(settings, channel)
        ], {
          purpose: 'agent-file-resolve',
          channelId,
          chatId: message.chatId,
          inboundMessageId: message.messageId,
          threadId: result.threadId,
          turnId: result.turnId
        })
      : []
    const replyText = result.ok
      ? replyTextForGeneratedFiles(result.text?.trim() || result.message?.trim() || 'Completed.', filesToSend)
      : (result.message.trim() || 'Sorry, something went wrong while handling your message.')
    const resultThreadId = result.ok ? result.threadId : undefined
    const resultTurnId = result.ok ? result.turnId : undefined
    const storedDelivery = this.prepareInboundDelivery(ledgerRecord, {
      ok: result.ok,
      reply: replyText,
      files: filesToSend,
      threadId: resultThreadId,
      turnId: resultTurnId,
      message: result.ok ? undefined : result.message,
      failureReason: result.ok ? undefined : result.reason
    }, {
      threadId: resultThreadId,
      turnId: resultTurnId
    })
    try {
      await this.deliverFeishuReply(ledgerRecord, bridge, message.chatId, storedDelivery, replyOptions, {
        purpose: 'agent-reply',
        channelId,
        chatId: message.chatId,
        inboundMessageId: message.messageId,
        runtimeOk: result.ok,
        threadId: resultThreadId,
        turnId: resultTurnId
      })
    } catch (error) {
      this.deps.logError('claw-feishu', 'Failed to deliver Feishu / Lark agent reply', {
        message: errorMessage(error),
        chatId: message.chatId,
        senderId: message.senderId,
        threadId: resultThreadId,
        turnId: resultTurnId
      })
      return
    }
  }

  private async syncFeishuChannels(
    settings: AppSettingsV1,
    options: { deferProtectedCredentialAccess?: boolean } = {}
  ): Promise<void> {
    const version = ++this.feishuSyncVersion
    const targets = this.resolveFeishuChannels(settings)
    traceImStartup('feishu sync', { targets: targets.length })
    const targetMap = new Map(targets.map((channel) => [channel.id, channel]))

    await Promise.all(
      [...this.feishuChannels.keys()]
        .filter((channelId) => !targetMap.has(channelId))
        .map((channelId) => this.closeFeishuChannel(channelId))
    )
    if (version !== this.feishuSyncVersion) return

    for (const target of targets) {
      if (!hasFeishuPlatformCredential(target)) continue
      const credential = target.platformCredential
      const appId = credential.appId.trim()
      const existingBridgeAtStart = this.feishuChannels.get(target.id)
      const existingHealth = this.deps.imHealth?.get?.(target.id)
      if (!existingBridgeAtStart && (
        existingHealth?.status === 'stopped' ||
        existingHealth?.status === 'expired' ||
        existingHealth?.reasonCode === 'credential_unavailable'
      )) {
        continue
      }
      if (
        options.deferProtectedCredentialAccess &&
        !existingBridgeAtStart &&
        target.credentialRef?.storage !== 'session'
      ) {
        // A cold start must not unlock macOS Keychain just because an enabled
        // channel is present. An explicit reconnect calls sync() without this
        // option and is the only path that may authorize protected storage.
        this.deps.imHealth?.start({
          channelId: target.id,
          provider: 'feishu',
          accountId: appId,
          credentialStorage: target.credentialRef?.storage
        })
        this.deps.imHealth?.fail(target.id, {
          reasonCode: 'credential_unavailable',
          message: '现有飞书凭据仍在，请通过“重新连接”恢复系统钥匙串访问。'
        })
        continue
      }
      if (!existingBridgeAtStart && existingHealth?.status !== 'starting') {
        this.deps.imHealth?.start({
          channelId: target.id,
          provider: 'feishu',
          accountId: appId,
          credentialStorage: target.credentialRef?.storage
        })
      }
      let appSecret = ''
      try {
        // Runtime credentials must come from protected storage. Deprecated
        // plaintext values are only retained for explicit migration/retry in
        // the main process and must never be used as a live fallback.
        appSecret = (await this.deps.resolveImCredential?.(target) ?? '').trim()
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : ''
        this.deps.logError('claw-feishu', 'Failed to resolve Feishu channel credential', {
          message: errorMessage(error),
          channelId: target.id
        })
        this.deps.imHealth?.fail(target.id, {
          reasonCode: code === 'credential_unavailable' ? 'credential_unavailable' : 'provider_error',
          message: code === 'credential_unavailable'
            ? '现有飞书凭据仍在，请通过“重新连接”恢复系统钥匙串访问。'
            : '飞书凭据读取失败，正在重试。'
        })
        continue
      }
      traceImStartup('feishu credential resolved', { available: Boolean(appId && appSecret) })
      if (!appId || !appSecret) {
        this.deps.imHealth?.fail(target.id, {
          reasonCode: 'credential_missing',
          message: '飞书凭据不可用，请检查系统钥匙串授权。'
        })
        continue
      }
      const domain = credential.domain.trim().toLowerCase() === 'lark' ? 'lark' : 'feishu'
      const allowedFileDirs = [
        this.resolveChannelWorkspaceRoot(settings, target),
        settings.claw.im.workspaceRoot,
        settings.workspaceRoot
      ]
        .map((entry) => entry.trim())
        .filter((entry, index, entries) => entry && entries.indexOf(entry) === index)
      const nextKey = `${target.id}|${appId}|${appSecret}|${domain}|${allowedFileDirs.join('|')}`
      // Credential resolution is asynchronous. Re-read bridge ownership so a
      // concurrent settings sync cannot create a second connection from a
      // stale snapshot or tear down an equivalent connection already starting.
      const existingBridge = this.feishuChannels.get(target.id)
      const currentKey = this.feishuChannelKeys.get(target.id)
      if (existingBridge && currentKey === nextKey) {
        this.refreshFeishuBridgeHealth(target.id, existingBridge)
        continue
      }
      if (version !== this.feishuSyncVersion) return
      if (existingBridge) {
        await this.closeFeishuChannel(target.id)
        if (version !== this.feishuSyncVersion) return
        this.deps.imHealth?.start({
          channelId: target.id,
          provider: 'feishu',
          accountId: appId,
          credentialStorage: target.credentialRef?.storage
        })
      }

      let bridge: LarkChannel | undefined
      try {
        bridge = (this.deps.createFeishuChannel ?? createLarkChannel)({
          appId,
          appSecret,
          domain: domain === 'lark' ? Domain.Lark : Domain.Feishu,
          loggerLevel: LoggerLevel.warn,
          source: 'kun',
          ...feishuWebSocketReliabilityOptions(),
          policy: {
            dmMode: 'open',
            requireMention: true,
            respondToMentionAll: true
          },
          ...(allowedFileDirs.length > 0
            ? { outbound: { allowedFileDirs } }
            : {})
        })
        bridge.on('message', async (message) => {
          await this.handleFeishuMessage(target.id, message)
        })
        bridge.on('error', (error) => {
          this.deps.imHealth?.fail(target.id, {
            reasonCode: 'provider_error',
            message: '飞书连接发生错误。',
            errorCode: error.code
          })
          this.deps.logError('claw-feishu', 'Feishu channel error', {
            message: error.message,
            code: error.code,
            channelId: target.id
          })
        })
        bridge.on('reject', (event) => {
          this.deps.logError('claw-feishu', 'Feishu message rejected by channel policy', {
            ...event,
            channelId: target.id
          })
        })
        bridge.on('reconnecting', () => {
          this.deps.imHealth?.fail(target.id, {
            reasonCode: 'network',
            message: '飞书连接正在重连。'
          })
          this.deps.logError('claw-feishu', 'Feishu channel reconnecting', {
            channelId: target.id
          })
        })
        bridge.on('reconnected', () => {
          this.deps.imHealth?.heartbeat(target.id, '飞书连接正常。')
          this.deps.logError('claw-feishu', 'Feishu channel reconnected', {
            channelId: target.id
          })
        })
        // The Feishu / Lark App admin subscribes to `im.message.message_read_v1`
        // in the developer console. The high-level `bridge.on(...)` API has no
        // entry for read receipts in its `EventMap`, and the SDK's internal
        // `EventDispatcher` does not pre-register a handler either — so the
        // dispatcher emits a `no im.message.message_read_v1 handle` warn on
        // every receipt. Register a no-op here to silence the warn until we
        // have product behavior for read receipts.
        //
        // TODO: replace this no-op with a real handler once we decide what to
        //       do with read receipts (e.g. track in chat store, update agent
        //       state, drive read-driven follow-ups).
        const dispatcher = (bridge as unknown as {
          dispatcher?: {
            register(handles: Record<string, (raw: unknown) => Promise<void> | void>): void
          }
        }).dispatcher
        dispatcher?.register({
          'im.message.message_read_v1': () => {
            // intentionally empty — see TODO above
          }
        })
        // The SDK can dispatch the first inbound event immediately after the
        // WebSocket handshake, before connect() resolves. Register the bridge
        // first so that event is handled instead of being dropped by the
        // channel lookup in handleFeishuMessageCore().
        this.feishuChannels.set(target.id, bridge)
        this.feishuChannelKeys.set(target.id, nextKey)
        traceImStartup('feishu bridge connect:start')
        await bridge.connect()
        traceImStartup('feishu bridge connect:done')
        if (
          this.feishuChannels.get(target.id) !== bridge ||
          this.feishuChannelKeys.get(target.id) !== nextKey
        ) {
          await bridge.disconnect().catch(() => undefined)
          return
        }
        this.deps.imHealth?.heartbeat(target.id, '飞书连接正常。')
      } catch (error) {
        if (bridge && this.feishuChannels.get(target.id) !== bridge) {
          await bridge.disconnect().catch(() => undefined)
          return
        }
        if (bridge) {
          this.feishuChannels.delete(target.id)
          this.feishuChannelKeys.delete(target.id)
        }
        traceImStartup('feishu bridge connect:failed', {
          errorType: error instanceof Error ? error.name : typeof error
        })
        this.deps.imHealth?.fail(target.id, {
          reasonCode: 'bridge_unavailable',
          message: '飞书通信桥启动失败。'
        })
        this.deps.logError('claw-feishu', 'Failed to start Feishu channel bridge', {
          message: error instanceof Error ? error.message : String(error),
          channelId: target.id
        })
      }
    }
  }

  private async closeFeishuChannel(channelId: string, markUserStopped = true): Promise<void> {
    const bridge = this.feishuChannels.get(channelId)
    if (!bridge) {
      if (markUserStopped) this.deps.imHealth?.stop(channelId)
      return
    }
    this.feishuChannels.delete(channelId)
    this.feishuChannelKeys.delete(channelId)
    if (markUserStopped) this.deps.imHealth?.stop(channelId)
    await bridge.disconnect().catch((error) => {
      this.deps.logError('claw-feishu', 'Failed to stop Feishu channel bridge', {
        message: error instanceof Error ? error.message : String(error),
        channelId
      })
    })
  }

  private async closeAllFeishuChannels(markUserStopped = true): Promise<void> {
    const ids = [...this.feishuChannels.keys()]
    await Promise.all(ids.map((channelId) => this.closeFeishuChannel(channelId, markUserStopped)))
  }

  private syncWebhook(settings: AppSettingsV1): void {
    const im = settings.claw.im
    const key = `${im.port}|${im.path}`
    if (this.server && this.serverKey === key) return
    void this.closeWebhook()

    const reservedServer = this.deps.webhookServer
    const reservedAddress = reservedServer?.address()
    const reservedPort = reservedAddress && typeof reservedAddress !== 'string'
      ? reservedAddress.port
      : null
    if (reservedServer?.listening && reservedPort === im.port) {
      const handler = (req: IncomingMessage, res: ServerResponse): void => {
        void this.handleWebhook(req, res)
      }
      reservedServer.on('request', handler)
      this.server = reservedServer
      this.serverOwned = false
      this.serverRequestHandler = handler
      this.serverKey = key
      traceImStartup('webhook reservation handed off', { port: im.port })
      return
    }

    const server = createServer((req, res) => {
      void this.handleWebhook(req, res)
    })
    server.on('error', (error) => {
      traceImStartup('webhook error', { code: 'code' in error ? error.code : undefined })
      this.deps.logError('claw-webhook', 'Claw IM webhook server failed', {
        message: error instanceof Error ? error.message : String(error)
      })
      if (this.server === server) {
        void this.closeWebhook()
      }
    })
    server.on('listening', () => traceImStartup('webhook listening', { port: im.port }))
    server.listen(im.port, '127.0.0.1')
    this.server = server
    this.serverOwned = true
    this.serverKey = key
  }

  private closeWebhook(): Promise<void> {
    if (!this.server) return Promise.resolve()
    const server = this.server
    const handler = this.serverRequestHandler
    const owned = this.serverOwned
    this.server = null
    this.serverOwned = false
    this.serverRequestHandler = null
    this.serverKey = ''
    if (handler) server.removeListener('request', handler)
    if (!owned) return Promise.resolve()
    return new Promise((resolveClose) => {
      try {
        server.close(() => resolveClose())
      } catch {
        resolveClose()
      }
    })
  }

  private async handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let inboundLeaseGuard: InboundLeaseGuard = {
      stop: () => undefined,
      assertOwned: () => undefined
    }
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/claw/internal/health' && req.method === 'GET') {
        writeJson(res, 200, { status: 'ok', service: 'claw', mode: 'embedded' })
        return
      }
      const settings = await this.deps.store.load()
      const im = settings.claw.im
      if (url.pathname === '/claw/internal/gui-plan/create' && req.method === 'POST') {
        // The legacy `gui_plan_create` MCP bridge is no longer the
        // active plan path. GUI plan creation now flows through the
        // native RailWise AI Runtime `create_plan` tool. Reject legacy calls
        // loudly so older clients see a clear migration error.
        writeJson(res, 410, {
          ok: false,
          code: 'gui_plan_create_retired',
          message:
            'The /claw/internal/gui-plan/create endpoint is no longer active. Use the RailWise AI Runtime create_plan tool.'
        })
        return
      }
      const deliveryPath = `${im.path.replace(/\/$/, '')}/delivery`
      const isDeliveryReceipt = req.method === 'POST' && url.pathname === deliveryPath
      if (req.method !== 'POST' || (url.pathname !== im.path && !isDeliveryReceipt)) {
        writeJson(res, 404, { ok: false, message: 'Not found.' })
        return
      }
      if (!isDeliveryReceipt && (!settings.claw.enabled || !im.enabled)) {
        writeJson(res, 503, { ok: false, message: 'Claw IM webhook is disabled.' })
        return
      }
      if (im.secret) {
        const auth = req.headers.authorization ?? ''
        const rawHeaderSecret = req.headers['x-workwise-secret'] ?? readLegacyWebhookSecret(req.headers)
        const headerSecret = Array.isArray(rawHeaderSecret) ? rawHeaderSecret[0] : rawHeaderSecret
        if (auth !== `Bearer ${im.secret}` && headerSecret !== im.secret) {
          writeJson(res, 401, { ok: false, message: 'Unauthorized.' })
          return
        }
      }

      if (isDeliveryReceipt) {
        const body = await readRequestBody(req)
        const payload = parseJsonObject(body)
        const deliveryId = asString(payload?.deliveryId)
        const outboundId = asString(payload?.outboundId)
        const record = deliveryId ? this.deps.imLedger?.getById(deliveryId) : undefined
        if (!record || !outboundId || outboundId !== imOutboundId(record)) {
          writeJson(res, 404, { ok: false, message: 'Delivery record not found.' })
          return
        }
        // The provider sends after the webhook response has already returned.
        // Require it to carry the owner issued with that response, then renew
        // and transition the lease before uploading or completing delivery.
        const phase = asString(payload?.phase) || 'complete'
        if (phase !== 'start' && phase !== 'renew' && phase !== 'complete') {
          writeJson(res, 400, { ok: false, message: 'Unknown delivery receipt phase.' })
          return
        }
        const requestedLeaseRunId = asString(payload?.leaseRunId)
        if (phase === 'start' || phase === 'renew') {
          if (!requestedLeaseRunId || requestedLeaseRunId !== record.leaseRunId) {
            writeJson(res, 409, { ok: false, message: 'Delivery lease is no longer owned by this sender.' })
            return
          }
          const renewed = this.deps.imLedger?.renewLease(
            record.id,
            requestedLeaseRunId,
            IM_LEDGER_PROVIDER_DELIVERY_LEASE_MS
          )
          if (!renewed) {
            writeJson(res, 409, { ok: false, message: 'Delivery lease is no longer active.' })
            return
          }
          if (phase === 'start') {
            const delivering = this.deps.imLedger?.markDelivering(
              record.id,
              new Date().toISOString(),
              requestedLeaseRunId
            )
            if (!delivering) {
              writeJson(res, 409, { ok: false, message: 'Delivery is already owned by another worker.' })
              return
            }
          }
          writeJson(res, 200, { ok: true, phase, leaseUntil: renewed.leaseUntil })
          return
        }
        // Completion is idempotent after the first successful receipt. The
        // lease is intentionally cleared at that point, so accept only the
        // same stable outbound id and a successful duplicate completion.
        if (phase === 'complete' && record.status === 'delivered' && payload?.ok === true && !record.leaseRunId) {
          writeJson(res, 200, { ok: true, alreadyDelivered: true })
          return
        }
        if (!requestedLeaseRunId || requestedLeaseRunId !== record.leaseRunId) {
          writeJson(res, 409, { ok: false, message: 'Delivery lease is no longer owned by this sender.' })
          return
        }
        const renewed = this.deps.imLedger?.renewLease(
          record.id,
          requestedLeaseRunId,
          IM_LEDGER_PROVIDER_DELIVERY_LEASE_MS
        )
        if (!renewed) {
          // A duplicate completion after a successful receipt is idempotent.
          if (record.status === 'delivered' && payload?.ok === true) {
            writeJson(res, 200, { ok: true, alreadyDelivered: true })
          } else {
            writeJson(res, 409, { ok: false, message: 'Delivery lease is no longer active.' })
          }
          return
        }
        const current = this.deps.imLedger?.getById(deliveryId)
        if (!current || current.leaseRunId !== requestedLeaseRunId) {
          writeJson(res, 409, { ok: false, message: 'Delivery lease changed while completing.' })
          return
        }
        const updated = payload?.ok === true
          ? this.finishInboundDelivery(current)
          : this.retryInboundDelivery(current, asString(payload?.message) || 'Provider delivery failed.')
        if (!updated) {
          writeJson(res, 409, { ok: false, message: 'Delivery state changed before the receipt was applied.' })
          return
        }
        writeJson(res, 200, { ok: true, status: updated.status })
        return
      }

      const body = await readRequestBody(req)
      const payload = parseJsonObject(body)
      if (!payload) {
        writeJson(res, 400, { ok: false, message: 'Expected a JSON object.' })
        return
      }
      const prompt = extractIncomingPrompt(payload)
      if (!prompt) {
        writeJson(res, 400, { ok: false, message: 'No message text found.' })
        return
      }
      const sender = extractSenderLabel(payload)
      const provider = extractIncomingProvider(payload, im.provider)
      const incomingChannelId = extractIncomingChannelId(payload)
      const channel = incomingChannelId
        ? settings.claw.channels.find(
            (item) => item.enabled && item.id === incomingChannelId
          ) ?? settings.claw.channels.find(
            (item) => item.enabled && item.provider === provider
          )
        : settings.claw.channels.find(
            (item) => item.enabled && item.provider === provider
          )
      const remoteSession = extractIncomingRemoteSession(payload)
      if (!isCandidateInboundAllowed(provider, remoteSession?.chatId ?? '', prompt)) {
        this.deps.logError('claw-webhook', 'Candidate IM webhook ignored by the inbound safety gate.', {
          provider,
          channelId: channel?.id ?? incomingChannelId,
          chatId: remoteSession?.chatId,
          messageId: remoteSession?.messageId
        })
        // Acknowledge the provider callback so a blocked candidate message is
        // not retried indefinitely, while keeping it out of the ledger and Runtime.
        writeJson(res, 202, { ok: true, ignored: true })
        return
      }
      if (provider === 'feishu' && channel) {
        if (remoteSession) {
          await this.rememberFeishuRemoteSession(settings, channel, remoteSession)
        }
      }
      const storedConversation =
        channel && remoteSession
          ? this.findChannelConversation(channel, {
              chatId: remoteSession.chatId,
              threadId: remoteSession.threadId
            })
          : undefined
      const conversation = storedConversation && this.isConversationBindingUnique(settings, storedConversation)
        ? storedConversation
        : undefined
      const accountId = channel?.platformCredential?.kind === 'weixin'
        ? channel.platformCredential.accountId
        : channel?.platformCredential?.kind === 'feishu'
          ? channel.platformCredential.appId
          : channel?.id ?? provider
      const remoteMessageId = remoteSession?.messageId?.trim() ||
        asString(payload.messageId)?.trim() ||
        `payload-${createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)}`
      const ledgerRecord = this.claimInbound({
        provider,
        accountId,
        channelId: channel?.id ?? incomingChannelId ?? provider,
        remoteMessageId,
        chatId: remoteSession?.chatId ?? '',
        senderId: remoteSession?.senderId ?? sender,
        threadId: remoteSession?.threadId ?? '',
        prompt,
        payload
      })
      if (this.deps.imLedger && ledgerRecord === null) {
        const existing = this.deps.imLedger.getByRemoteId(provider, accountId, remoteMessageId)
        const stored = existing ? parseStoredDelivery(existing) : undefined
        if (stored) {
          writeJson(res, 200, { ...stored, replayed: true })
        } else {
          writeJson(res, 202, { ok: true, pending: true, idempotencyKey: existing?.idempotencyKey })
        }
        return
      }
      inboundLeaseGuard = this.startInboundLeaseRenewal(ledgerRecord)
      const writeWebhookDelivery = (status: number, delivery: ImStoredDeliveryV1): void => {
        try {
          inboundLeaseGuard.assertOwned()
        } catch (error) {
          this.deps.logError('claw-webhook', 'Inbound delivery lease was lost before the result was persisted.', {
            provider,
            channelId: ledgerRecord?.channelId,
            remoteMessageId: ledgerRecord?.remoteMessageId,
            message: errorMessage(error)
          })
          writeJson(res, 202, { ok: true, pending: true, idempotencyKey: ledgerRecord?.idempotencyKey })
          return
        }
        const prepared = this.prepareInboundDelivery(ledgerRecord, delivery, {
          threadId: delivery.threadId,
          turnId: delivery.turnId
        })
        if (!prepared) {
          writeJson(res, 202, { ok: true, pending: true, idempotencyKey: ledgerRecord?.idempotencyKey })
          return
        }
        if (ledgerRecord?.leaseRunId && this.deps.imLedger) {
          const renewed = this.deps.imLedger.renewLease(
            ledgerRecord.id,
            ledgerRecord.leaseRunId,
            IM_LEDGER_PROVIDER_DELIVERY_LEASE_MS
          )
          if (!renewed) {
            this.deps.logError('claw-webhook', 'Inbound delivery lease was lost before provider handoff.', {
              provider,
              channelId: ledgerRecord.channelId,
              remoteMessageId: ledgerRecord.remoteMessageId
            })
            writeJson(res, 202, { ok: true, pending: true, idempotencyKey: ledgerRecord.idempotencyKey })
            return
          }
        }
        writeJson(res, status, prepared)
      }
      // First inbound message on a freshly connected channel: push the
      // intro over the WeChat bridge when possible (it lands before the
      // model reply), otherwise prepend it to this response.
      let welcomePrefix = ''
      const welcomeText = this.pendingWelcomeText(settings, channel)
      if (welcomeText && channel) {
        this.welcomeInFlight.add(channel.id)
        try {
          const pushed = await this.pushWeixinWelcome(channel, remoteSession ?? undefined, welcomeText)
          if (!pushed) welcomePrefix = `${welcomeText}\n\n---\n\n`
          await this.markChannelWelcomeSent(channel.id)
        } finally {
          this.welcomeInFlight.delete(channel.id)
        }
      }
      const commandReply = await this.handleIncomingImCommand(settings, {
        text: prompt,
        channel,
        conversation,
        remoteSession: remoteSession ?? undefined
      })
      if (commandReply !== null) {
        writeWebhookDelivery(200, { ok: true, reply: `${welcomePrefix}${commandReply}` })
        return
      }
      const taskCreation = await this.deps.createScheduledTaskFromText?.(prompt, {
        workspaceRoot: this.resolveChannelWorkspaceRoot(settings, channel),
        modelHint: channel?.model ?? im.model,
        mode: im.mode
      }) ?? { kind: 'noop' as const }
      if (taskCreation.kind === 'created') {
        writeWebhookDelivery(200, {
          ok: true,
          createdTaskId: taskCreation.taskId,
          reply: `${welcomePrefix}${taskCreation.confirmationText}`
        })
        return
      }
      if (taskCreation.kind === 'error') {
        const reply = `Failed to create the scheduled task: ${taskCreation.message}`
        writeWebhookDelivery(500, { ok: false, message: taskCreation.message, reply })
        return
      }
      if (provider === 'weixin' && shouldDirectSendExistingGeneratedFilesForPrompt(prompt)) {
        const existingThreadId = conversation?.localThreadId.trim() || ''
        const workspaceRoot = this.resolveIncomingWorkspaceRoot(
          settings,
          channel,
          conversation,
          remoteSession ?? undefined
        )
        const existingFiles = filterGeneratedFilesForPrompt(prompt, await this.resolveImGeneratedFiles(
          await this.recentGeneratedFilesForThread(settings, existingThreadId, workspaceRoot, {
            purpose: 'weixin-direct-existing-file-lookup',
            channelId: channel?.id,
            chatId: remoteSession?.chatId,
            inboundMessageId: remoteMessageId,
            threadId: existingThreadId
          }),
          workspaceRoot,
          {
            purpose: 'weixin-direct-existing-file-resolve',
            channelId: channel?.id,
            chatId: remoteSession?.chatId,
            inboundMessageId: remoteMessageId,
            threadId: existingThreadId
          }
        ))
        if (existingFiles.length > 0) {
          writeWebhookDelivery(200, {
            ok: true,
            reply: `${welcomePrefix}${replyTextForGeneratedFiles('', existingFiles)}`,
            files: existingFiles,
            threadId: existingThreadId
          })
          return
        }
      }
      const resultBox: { value?: ClawRunResult } = {}
      const queueKey = `${provider}:${accountId}:${remoteSession?.chatId || sender}:${remoteSession?.threadId || 'root'}`
      await this.enqueueInbound(queueKey, async () => {
        if (
          ledgerRecord?.leaseRunId &&
          !this.deps.imLedger?.renewLease(ledgerRecord.id, ledgerRecord.leaseRunId, IM_LEDGER_LEASE_MS)
        ) {
          resultBox.value = {
            ok: false,
            reason: 'failed',
            message: 'This IM message is already being recovered by another worker.'
          }
          return
        }
        resultBox.value = await this.processIncomingImPrompt(settings, {
          prompt,
          sender,
          provider,
          channel,
          conversation,
          remoteSession: remoteSession ?? undefined,
          idempotencyKey: ledgerRecord?.idempotencyKey ?? `im:${provider}:${channel?.id ?? 'default'}:${remoteSession?.messageId ?? randomUUID()}`,
          ledgerRecord
        })
      })
      const result = resultBox.value ?? { ok: false as const, reason: 'failed' as const, message: 'IM message was not processed.' }
      if (!result.ok) {
        writeWebhookDelivery(500, {
          ok: false,
          failureReason: result.reason,
          message: result.message,
          reply: result.message.trim() || 'Sorry, I could not process your message right now.'
        })
        return
      }
      // Deliverable generated files (e.g. generate_image output) ride along in
      // the response so push-capable bridges (WeChat) can upload them after the
      // text reply. Gated by the same prompt heuristic as the Feishu path.
      const files = shouldSendGeneratedFilesForPrompt(prompt)
        ? await this.resolveImGeneratedFiles(
            result.files ?? [],
            [
              this.resolveIncomingWorkspaceRoot(settings, channel, conversation, remoteSession ?? undefined),
              this.resolveChannelWorkspaceRoot(settings, channel)
            ],
            {
              purpose: 'im-webhook-file-resolve',
              provider,
              channelId: channel?.id,
              threadId: result.threadId,
              turnId: result.turnId
            }
          )
        : []
      writeWebhookDelivery(200, {
        ...result,
        ok: true,
        files,
        reply: `${welcomePrefix}${replyTextForGeneratedFiles(result.text ?? '', files)}`
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logError('claw-webhook', 'Claw IM webhook request failed', { message })
      writeJson(res, 500, { ok: false, message })
    } finally {
      inboundLeaseGuard.stop()
    }
  }
}

export function createClawRuntime(deps: ClawRuntimeDeps): ClawRuntime {
  return new ClawRuntime(deps)
}
