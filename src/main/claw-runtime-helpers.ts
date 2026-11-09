import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, isAbsolute, join } from 'node:path'
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk'
import type {
  AppSettingsV1,
  ClawGeneratedFileV1,
  ClawImChannelV1,
  ClawImProvider,
  ClawImRemoteSessionV1,
  ClawRunMode,
  ScheduleTaskFromTextResult
} from '../shared/app-settings'
import type { WeixinBridgeAccountStatusV1 } from '../shared/workwise-api'
import { CLAW_FEISHU_INBOUND_MESSAGE_HEADING } from '../shared/app-settings'
import type { JsonSettingsStore } from './settings-store'
import type { ImDeliveryLedger } from './services/im-delivery-ledger'
import type { ImHealthService } from './services/im-health-service'

export type RuntimeRequestResult = { ok: boolean; status: number; body: string }

export type RuntimeRequestFn = (
  settings: AppSettingsV1,
  pathAndQuery: string,
  init: { method?: string; body?: string; headers?: Record<string, string> }
) => Promise<RuntimeRequestResult>

export type ClawRuntimeDeps = {
  store: JsonSettingsStore
  runtimeRequest: RuntimeRequestFn
  logError: (category: string, message: string, detail?: unknown) => void
  createFeishuChannel?: typeof import('@larksuiteoapi/node-sdk').createLarkChannel
  notifyChannelActivity?: (payload: { channelId: string; threadId: string }) => void
  sendWeixinBridgeMessage?: (options: {
    accountId: string
    to: string
    text: string
    clientId?: string
    files?: ClawGeneratedFileV1[]
  }) => Promise<{ ok: true; messageId: string } | { ok: false; message: string }>
  /** WeChat owner (`ilink_user_id`) for a bridge account; '' when unknown. */
  resolveWeixinAccountUserId?: (accountId: string) => Promise<string>
  getWeixinBridgeAccountStatuses?: (accountId?: string) => Promise<WeixinBridgeAccountStatusV1[]>
  startWeixinBridgeAccount?: (accountId: string) => Promise<void>
  stopWeixinBridgeAccount?: (accountId: string) => Promise<void>
  reconnectWeixinBridgeAccount?: (accountId: string) => Promise<void>
  disconnectWeixinBridgeAccount?: (accountId: string) => Promise<void>
  imLedger?: ImDeliveryLedger
  imHealth?: ImHealthService
  imMaxConcurrency?: number
  resolveImCredential?: (channel: ClawImChannelV1) => Promise<string | undefined>
  createScheduledTaskFromText?: (
    text: string,
    options?: { workspaceRoot?: string | null; modelHint?: string | null; mode?: ClawRunMode | null }
  ) => Promise<ScheduleTaskFromTextResult>
  /** Candidate mode may reserve this listener before runtime handoff. */
  webhookServer?: import('node:http').Server
}

export type ThreadRecordJson = {
  id: string
  status?: string
}

export type TurnRecordJson = {
  id: string
  status?: string
  error?: string | null
  items?: TurnItemJson[]
}

export type TurnItemJson = {
  kind: string
  turnId?: string
  status?: string
  toolName?: string
  toolKind?: string
  output?: unknown
  isError?: boolean | null
  text?: string | null
  summary?: string
  detail?: string | null
}

export type ThreadDetailJson = {
  thread?: ThreadRecordJson
  id?: string
  status?: string
  turns?: TurnRecordJson[]
  items?: TurnItemJson[]
}

export type RunPromptOptions = {
  prompt: string
  displayText?: string
  title: string
  workspaceRoot: string
  model: string
  mode: ClawRunMode
  waitForResult: boolean
  responseTimeoutMs: number
  source: 'task' | 'im'
  threadId?: string
  /** Stable provider message key used to recover a headless turn after a restart. */
  idempotencyKey?: string
  channel?: ClawImChannelV1
  /** Persist the selected Runtime thread before starting the idempotent Turn. */
  onThreadSelected?: (payload: { threadId: string }) => Promise<void> | void
  onTurnStarted?: (payload: { threadId: string; turnId: string }) => Promise<void> | void
}

export const WEBHOOK_BODY_LIMIT_BYTES = 1_000_000

export function sanitizePathSegment(raw: string, fallback: string): string {
  const sanitized = raw
    .trim()
    .replace(/[\\/]/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return sanitized || fallback
}

export function feishuSenderLabel(message: NormalizedMessage): string {
  return message.senderName?.trim() || message.senderId.trim() || 'feishu-user'
}

export function buildFeishuPrompt(message: NormalizedMessage): string {
  const content = message.content.trim()
  const sender = feishuSenderLabel(message)
  const lines = [
    CLAW_FEISHU_INBOUND_MESSAGE_HEADING,
    `Chat type: ${message.chatType}`,
    `Sender: ${sender}`
  ]
  if (message.mentions.length > 0) {
    const mentionNames = message.mentions
      .map((mention) => mention.name?.trim() || mention.openId?.trim() || mention.userId?.trim() || '')
      .filter(Boolean)
    if (mentionNames.length > 0) {
      lines.push(`Mentions: ${mentionNames.join(', ')}`)
    }
  }
  if (message.rawContentType !== 'text') {
    lines.push(`Message type: ${message.rawContentType}`)
  }
  lines.push('', content || '[No text content]')
  return lines.join('\n')
}

export function formatFeishuMirrorText(text: string, direction: 'user' | 'assistant'): { markdown: string } {
  const trimmed = text.trim()
  if (direction === 'user') {
    return {
      markdown: `**From RailWise AI Runtime**\n\n> ${trimmed.replace(/\n/g, '\n> ')}`
    }
  }
  return { markdown: trimmed || '(empty reply)' }
}

export function clawConversationKey(chatId: string, remoteThreadId: string): string {
  return `${chatId.trim()}::${remoteThreadId.trim()}`
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export function runtimeErrorMessage(result: RuntimeRequestResult, fallback: string): string {
  const parsed = parseJsonObject(result.body)
  if (parsed) {
    const message = parsed.message
    if (typeof message === 'string' && message.trim()) return message.trim()
    const error = parsed.error
    if (typeof error === 'string' && error.trim()) return error.trim()
    if (typeof error === 'object' && error !== null) {
      const nested = (error as Record<string, unknown>).message
      if (typeof nested === 'string' && nested.trim()) return nested.trim()
    }
  }
  return result.body.trim() || fallback
}

export function isRunningStatus(status: string | undefined): boolean {
  return status === 'queued' || status === 'in_progress' || status === 'started' || status === 'running'
}

export function latestAssistantText(
  detail: ThreadDetailJson,
  options: { turnId?: string } = {}
): string {
  const turnId = options.turnId?.trim()
  const items = turnId
    ? threadItems(detail).filter((item) => item.turnId === turnId)
    : threadItems(detail)
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== 'assistant_text' && item.kind !== 'agent_message') continue
    const text = (item.text ?? item.detail ?? item.summary ?? '').trim()
    if (text) return text
  }
  return ''
}

function outputRecord(output: unknown): Record<string, unknown> | null {
  return typeof output === 'object' && output !== null && !Array.isArray(output)
    ? output as Record<string, unknown>
    : null
}

function generatedFileFromRecord(
  record: Record<string, unknown>,
  workspaceRoot: string
): ClawGeneratedFileV1 | null {
  const path = asString(record.path)
  const absolutePath = asString(record.absolutePath) || asString(record.absolute_path)
  const relativePath = asString(record.relativePath) || asString(record.relative_path)
  const relativeCandidate = relativePath || (!isAbsolute(path) ? path : '')
  const resolvedPath = absolutePath ||
    (isAbsolute(path) ? path : '') ||
    (workspaceRoot && relativeCandidate ? join(workspaceRoot, relativeCandidate) : path)
  if (!resolvedPath) return null
  return {
    path: resolvedPath,
    ...(relativePath ? { relativePath } : {}),
    fileName: asString(record.fileName) || asString(record.name) || basename(relativePath || resolvedPath)
  }
}

function generatedFilesFromToolResult(
  item: TurnItemJson,
  workspaceRoot: string
): ClawGeneratedFileV1[] {
  if (item.kind !== 'tool_result' || item.isError === true) return []
  const output = outputRecord(item.output)
  if (!output) return []
  if (item.toolKind === 'file_change') {
    const file = generatedFileFromRecord(output, workspaceRoot)
    return file ? [file] : []
  }
  for (const key of ['files', 'generatedFiles', 'artifacts']) {
    const entries = output[key]
    if (!Array.isArray(entries)) continue
    const files = entries
      .map((entry) => {
        if (typeof entry === 'string' && entry.trim()) {
          return generatedFileFromRecord({ path: entry.trim() }, workspaceRoot)
        }
        const record = outputRecord(entry)
        return record ? generatedFileFromRecord(record, workspaceRoot) : null
      })
      .filter((file): file is ClawGeneratedFileV1 => file != null)
    if (files.length > 0) return files
  }
  if (item.toolKind === 'command_execution' && Number(output.exit_code ?? 0) === 0) {
    const stdout = asString(output.output)
    const files: ClawGeneratedFileV1[] = []
    const seen = new Set<string>()
    // Command-based generators often report their final Office/PDF archive
    // only in stdout. Capture explicit absolute paths; the caller still
    // realpaths, size-checks, and confines every candidate to the IM workspace.
    const deliverablePath = /((?:\/|[A-Za-z]:[\\/])[^"'\r\n]*?\.(?:pptx?|docx?|xlsx?|pdf|csv|md|txt|svg|png|jpe?g|webp|gif|zip))(?=$|[\s"'`])/ig
    for (const line of stdout.split(/\r?\n/)) {
      for (const match of line.matchAll(deliverablePath)) {
        const path = match[1]?.trim()
        if (!path || seen.has(path)) continue
        seen.add(path)
        files.push({ path, fileName: basename(path) })
      }
    }
    return files
  }
  return []
}

function threadItems(detail: ThreadDetailJson): TurnItemJson[] {
  const turns = Array.isArray(detail.turns) ? detail.turns : []
  const singleTurnId = turns.length === 1 ? turns[0].id : ''
  const topLevelItems = Array.isArray(detail.items)
    ? detail.items.map((item) => ({ ...item, turnId: item.turnId || singleTurnId || undefined }))
    : []
  const turnItems = turns.flatMap((turn) =>
    Array.isArray(turn.items)
      ? turn.items.map((item) => ({ ...item, turnId: item.turnId || turn.id }))
      : []
  )
  return [
    ...topLevelItems,
    ...turnItems
  ]
}

function isPathLikeDuplicate(left: ClawGeneratedFileV1, right: ClawGeneratedFileV1): boolean {
  if (left.path === right.path) return true
  if (left.relativePath && left.relativePath === right.relativePath) return true
  if (isAbsolute(left.path) && isAbsolute(right.path)) return left.path === right.path
  return false
}

function extractGeneratedFiles(
  items: readonly TurnItemJson[],
  workspaceRoot: string,
  maxFiles: number
): ClawGeneratedFileV1[] {
  const files: ClawGeneratedFileV1[] = []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    for (const file of generatedFilesFromToolResult(items[index], workspaceRoot).reverse()) {
      if (files.some((existing) => isPathLikeDuplicate(existing, file))) continue
      files.push(file)
      if (files.length >= maxFiles) break
    }
    if (files.length >= maxFiles) break
  }
  return files.reverse()
}

export function latestGeneratedFiles(
  detail: ThreadDetailJson,
  options: { turnId?: string; workspaceRoot?: string; maxFiles?: number; fallbackToThread?: boolean } = {}
): ClawGeneratedFileV1[] {
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 3))
  const workspaceRoot = options.workspaceRoot?.trim() ?? ''
  const items = threadItems(detail)
  const turnId = options.turnId?.trim()
  if (turnId) {
    const currentTurnFiles = extractGeneratedFiles(
      items.filter((item) => item.turnId === turnId),
      workspaceRoot,
      maxFiles
    )
    if (currentTurnFiles.length > 0) return currentTurnFiles
    if (options.fallbackToThread === false) return []
  }
  return extractGeneratedFiles(items, workspaceRoot, maxFiles)
}

export function generatedFilesFromTaskRuns(
  payload: unknown,
  options: { turnId: string; workspaceRoot: string; maxFiles?: number }
): ClawGeneratedFileV1[] {
  if (!Array.isArray(payload)) return []
  const turnId = options.turnId.trim()
  const workspaceRoot = options.workspaceRoot.trim()
  const maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 3))
  if (!turnId || !workspaceRoot) return []

  const files: ClawGeneratedFileV1[] = []
  for (const entry of payload) {
    const task = outputRecord(entry)
    if (
      !task ||
      asString(task.activeTurnId) !== turnId ||
      asString(task.status) !== 'completed' ||
      !Array.isArray(task.artifacts)
    ) continue
    // Existing Runtime threads can retain the channel-level workspace they
    // were created with even after IM conversations gain isolated subfolders.
    // Task artifacts are relative to the Task's recorded workspace, which is
    // authoritative for that completed turn.
    const taskWorkspaceRoot = asString(task.workspaceRoot) || workspaceRoot
    for (const artifactEntry of task.artifacts) {
      const artifact = outputRecord(artifactEntry)
      if (!artifact || asString(artifact.validation) !== 'valid') continue
      const relativePath = asString(artifact.relativePath)
      if (!relativePath) continue
      const file = generatedFileFromRecord({ relativePath }, taskWorkspaceRoot)
      if (!file || files.some((existing) => isPathLikeDuplicate(existing, file))) continue
      files.push(file)
      if (files.length >= maxFiles) return files
    }
  }
  return files
}

export function pendingTurnInteraction(
  detail: ThreadDetailJson,
  turnId: string
): 'approval' | 'user_input' | undefined {
  for (const item of threadItems(detail)) {
    if (item.turnId !== turnId || item.status !== 'pending') continue
    if (item.kind === 'approval' || item.kind === 'user_input') return item.kind
  }
  return undefined
}

export function shouldSendGeneratedFilesForPrompt(prompt: string): boolean {
  const text = prompt.trim()
  if (!text) return false
  return /发给我|发送给我|发一下|发来|发过来|传给我|传过来|上传|附件|以附件|发文件|文件发|文档发/i.test(text) ||
    /\b(send|attach|attachment|upload)\b/i.test(text) ||
    /给我(?:一个|一份)?.{0,24}(文档|文件|\.(?:md|txt|pdf|docx|xlsx|csv|pptx))/i.test(text) ||
    /(生成|画|绘制|做|制作|创建|出).{0,24}(图|图片|图像|照片|海报|插画|表情包|logo)/i.test(text) ||
    /\b(generate|create|draw|make)\b.{0,40}\b(image|picture|photo|poster|illustration|meme|logo)\b/i.test(text)
}

export function shouldDirectSendExistingGeneratedFilesForPrompt(prompt: string): boolean {
  const text = prompt.trim()
  if (!text) return false
  const requestsDelivery =
    /发给我|发送给我|发一下|发来|发过来|传给我|传过来|上传|附件|以附件|直接发|发文件|文件发|文档发/i.test(text) ||
    /\b(send|attach|attachment|upload)\b/i.test(text)
  if (!requestsDelivery) return false

  // A request that also asks for new work must start a new Turn. Treating it
  // as "send the previous file" can deliver stale artifacts with a false
  // success conclusion before the Runtime has created the requested result.
  const requestsNewWork =
    /(创建|新建|生成|制作|写入|导出|转换|修改|编辑|更新|重做|另存(?:为)?|保存为|做(?:好|成|一个|一份|个|份)).{0,100}(文件|文档|附件|演示文稿|幻灯片|表格|图片|图像|\.(?:md|txt|pdf|docx|xlsx|csv|pptx|svg|png|jpe?g|webp|gif|zip))/i.test(text) ||
    /\b(create|generate|make|write|export|convert|edit|modify|update|produce|build)\b.{0,100}\b(file|document|attachment|presentation|slide|spreadsheet|image|md|txt|pdf|docx|xlsx|csv|pptx|svg|png|jpe?g|webp|gif|zip)\b/i.test(text)
  return !requestsNewWork
}

export function filterGeneratedFilesForPrompt(
  prompt: string,
  files: readonly ClawGeneratedFileV1[]
): ClawGeneratedFileV1[] {
  const text = prompt.trim().toLowerCase()
  if (!text || files.length === 0) return [...files]

  const explicitlyNamed = files.filter((file) => {
    const fileName = (file.fileName || basename(file.path)).trim().toLowerCase()
    return fileName.length > 0 && text.includes(fileName)
  })
  if (explicitlyNamed.length > 0) return explicitlyNamed

  const requested = new Set<string>()
  const add = (...extensions: string[]): void => {
    for (const extension of extensions) requested.add(extension)
  }
  for (const match of text.matchAll(/\.(pptx?|pdf|docx?|xlsx?|csv|md|txt|svg|png|jpe?g|webp|gif|zip)\b/g)) {
    add(`.${match[1]}`)
  }
  if (/\bpptx?\b|演示文稿|幻灯片/.test(text)) add('.ppt', '.pptx')
  if (/\bpdf\b/.test(text)) add('.pdf')
  if (/\b(?:docx?|word)\b|word\s*文档|文字文档/.test(text)) add('.doc', '.docx')
  if (/\b(?:xlsx?|excel)\b|电子表格/.test(text)) add('.xls', '.xlsx')
  if (/\bcsv\b/.test(text)) add('.csv')
  if (/\b(?:markdown|md)\b/.test(text)) add('.md')
  if (/\btxt\b|纯文本/.test(text)) add('.txt')
  if (/\bsvg\b|矢量图/.test(text)) add('.svg')
  if (/\b(?:image|picture|photo|png|jpe?g|webp|gif)\b|图片|图像|照片|海报|插画/.test(text)) {
    add('.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg')
  }
  if (/\bzip\b|压缩包/.test(text)) add('.zip')
  if (requested.size === 0) return [...files]
  return files.filter((file) => requested.has(extname(file.fileName || file.path).toLowerCase()))
}

export function replyTextForGeneratedFiles(replyText: string, files: readonly ClawGeneratedFileV1[]): string {
  const trimmed = replyText.trim()
  if (files.length === 0) return trimmed
  const names = files.map((file) => file.fileName).join(', ')
  const flattened = trimmed.replace(/\s+/g, ' ')
  const deniesFileDelivery =
    /(无法|不能|没办法).{0,40}(直接|通过)?(飞书|Lark|微信)?(发送|发|推送|传|送达).{0,30}(文件|文档|附件)/i.test(flattened) ||
    /(无法|不能|没办法).{0,40}(文件|文档|附件).{0,30}(发送|发|推送|传|送达)/i.test(flattened) ||
    /(没有|缺少|不具备).{0,40}(发送附件|推送文件|附件.{0,15}(工具|通道)|文件.{0,15}(工具|通道))/i.test(flattened) ||
    /(附件|文件).{0,40}(发送|送达).{0,40}(超出|不在).{0,20}(工具|能力|执行)?边界/i.test(flattened) ||
    /验收契约.{0,30}(未满足|未全部满足|没有满足)/i.test(flattened)
  if (!trimmed || deniesFileDelivery) {
    return `文件已生成并发送：${names}。请在当前会话中下载并打开附件。`
  }
  return trimmed
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function normalizeTaskModel(model: string): string | undefined {
  const trimmed = model.trim()
  return trimmed || undefined
}

export function webhookUrl(settings: AppSettingsV1): string {
  return `http://127.0.0.1:${settings.claw.im.port}${settings.claw.im.path}`
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asMessageIdentifier(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

export function asRawString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function nestedRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function extractIncomingPrompt(payload: Record<string, unknown>): string {
  const candidates = [
    payload.text,
    payload.prompt,
    payload.message,
    nestedRecord(payload.message).text,
    nestedRecord(payload.event).text,
    nestedRecord(payload.data).text
  ]
  for (const candidate of candidates) {
    const text = asString(candidate)
    if (text) return text
  }
  return ''
}

export function extractSenderLabel(payload: Record<string, unknown>): string {
  const candidates = [
    payload.sender,
    payload.user,
    payload.from,
    payload.conversationId,
    nestedRecord(payload.message).sender,
    nestedRecord(payload.event).sender,
    nestedRecord(payload.data).sender
  ]
  for (const candidate of candidates) {
    const text = asString(candidate)
    if (text) return text
  }
  return 'webhook'
}

export function normalizeIncomingProvider(value: unknown, fallback: ClawImProvider): ClawImProvider {
  const raw = asString(value).toLowerCase()
  if (raw === 'weixin' || raw === 'wechat') return 'weixin'
  return raw === 'feishu' ? 'feishu' : fallback
}

export function extractIncomingProvider(
  payload: Record<string, unknown>,
  fallback: ClawImProvider
): ClawImProvider {
  const candidates = [
    payload.provider,
    payload.platform,
    payload.im,
    payload.source,
    nestedRecord(payload.message).provider,
    nestedRecord(payload.event).provider,
    nestedRecord(payload.data).provider
  ]
  for (const candidate of candidates) {
    const provider = normalizeIncomingProvider(candidate, fallback)
    if (provider !== fallback || asString(candidate).toLowerCase() === fallback) return provider
  }
  return fallback
}

export function extractIncomingChannelId(payload: Record<string, unknown>): string {
  const candidates = [
    payload.channelId,
    payload.channel_id,
    nestedRecord(payload.message).channelId,
    nestedRecord(payload.event).channelId,
    nestedRecord(payload.data).channelId
  ]
  for (const candidate of candidates) {
    const text = asString(candidate)
    if (text) return text
  }
  return ''
}

export function extractIncomingRemoteSession(
  payload: Record<string, unknown>
): Pick<ClawImRemoteSessionV1, 'chatId' | 'messageId' | 'threadId' | 'senderId' | 'senderName'> | null {
  const message = nestedRecord(payload.message)
  const event = nestedRecord(payload.event)
  const eventMessage = nestedRecord(event.message)
  const header = nestedRecord(event.header)
  const sender = nestedRecord(payload.sender)
  const eventSender = nestedRecord(event.sender)

  const chatId = asString(
    payload.chatId ||
    payload.chat_id ||
    payload.open_chat_id ||
    message.chatId ||
    message.chat_id ||
    eventMessage.chat_id ||
    eventMessage.chatId
  )
  const messageId = asMessageIdentifier(
    payload.messageId ||
    payload.message_id ||
    message.messageId ||
    message.message_id ||
    eventMessage.message_id ||
    eventMessage.messageId ||
    header.message_id
  )
  if (!chatId || !messageId) return null

  const threadId = asString(
    payload.threadId ||
    payload.thread_id ||
    message.threadId ||
    message.thread_id ||
    eventMessage.thread_id ||
    eventMessage.threadId
  )
  const senderId = asString(
    payload.senderId ||
    payload.sender_id ||
    sender.id ||
    sender.open_id ||
    sender.user_id ||
    eventSender.sender_id ||
    eventSender.open_id ||
    eventSender.user_id
  )
  const senderName = asString(
    payload.senderName ||
    payload.sender_name ||
    sender.name ||
    eventSender.sender_name ||
    eventSender.name
  )
  return { chatId, messageId, threadId, senderId, senderName }
}

export function buildConversationLabel(session: Pick<ClawImRemoteSessionV1, 'chatId' | 'senderName'>): string {
  const sender = session.senderName.trim()
  if (sender) return sender
  const chatId = session.chatId.trim()
  return chatId.length > 12 ? chatId.slice(0, 12) : chatId
}

export function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

export async function readRequestBody(req: IncomingMessage): Promise<string> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > WEBHOOK_BODY_LIMIT_BYTES) {
      throw new Error('Request body is too large.')
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}
