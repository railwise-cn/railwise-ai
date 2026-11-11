import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import type { LarkCapabilityConfig } from '../../contracts/capabilities.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { LocalTool } from './local-tool-host.js'
import type { LarkCommandResult } from './lark-cli-tool-provider.js'
import { defineLocalTool } from './local-tool-definition.js'
import { grantPathBlock } from './sandbox-policy.js'

type Json = Record<string, unknown>
type Run = (args: string[], scopes: string[], context: ToolHostContext, action?: { operation: string; target: string }, cwd?: string) => Promise<LarkCommandResult>
// Scopes and argv are pinned to official larksuite/cli ac22a60 (v1.0.100).
export const LARK_DELIVERY_SCOPES = {
  mail: ['mail:user_mailbox.message:send', 'mail:user_mailbox.message:modify', 'mail:user_mailbox:readonly', 'mail:user_mailbox.message:readonly'],
  im: ['im:message.send_as_user', 'im:message', 'im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user'],
  drive: ['drive:file:upload', 'drive:drive.metadata:readonly', 'drive:file:download']
} as const
const readScopes = {
  mail: ['mail:user_mailbox.message:readonly'],
  im: ['im:message.group_msg:get_as_user', 'im:message.p2p_msg:get_as_user'],
  drive: ['drive:file:download']
}
const jsonFlags = ['--format', 'json', '--as', 'user']
// eslint-disable-next-line no-control-regex
const identifier = z.string().trim().min(1).max(512).regex(/^[^\s\u0000-\u001f]+$/u)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const recipient = z.email().max(320)
const mailInput = z.object({ recipient, subject: z.string().min(1).max(1000), body: z.string().min(1).max(64_000) }).strict()
const imInput = z.object({ chatId: identifier, text: z.string().min(1).max(20_000) }).strict()
const uploadInput = z.object({ path: z.string().min(1).max(4096), folderToken: identifier, expectedHash: digest }).strict()
const mailReadInput = z.object({ messageId: identifier, recipient }).strict()
const imReadInput = z.object({ messageId: identifier, chatId: identifier, contentHash: digest }).strict()
const fileReadInput = z.object({ fileToken: identifier, expectedHash: digest }).strict()

/** Narrow user-identity delivery commands. Every mutation has a separate readback tool. */
export function buildLarkDeliveryTools(config: LarkCapabilityConfig, run: Run): LocalTool[] {
  if (config.executableVersion !== '1.0.100') return []
  const accountFingerprint = config.identityFingerprint
  const read = async (args: string[], scopes: string[], context: ToolHostContext, cwd?: string) => {
    const result = await run([...args, ...jsonFlags], scopes, context, undefined, cwd)
    if (!result.ok) throw failure('connector_readback_failed')
    return dataOf(result.output)
  }
  const readMail = async (args: Json, context: ToolHostContext) => {
    const data = await read(['mail', 'user_mailbox.messages', 'send_status', '--params', JSON.stringify({ user_mailbox_id: 'me', message_id: args.messageId })], readScopes.mail, context)
    if (data.message_id !== args.messageId || !Array.isArray(data.details)) throw failure('connector_target_mismatch')
    return data
  }
  const readMessage = async (args: Json, context: ToolHostContext) => {
    const data = await read(['im', '+messages-mget', '--message-ids', String(args.messageId), '--no-reactions'], readScopes.im, context)
    const message = Array.isArray(data.messages) ? data.messages.map(object).find(item => item.message_id === args.messageId) : undefined
    if (!message || message.chat_id !== args.chatId) throw failure('connector_target_mismatch')
    return { ...message, contentHash: hashText(String(message.content ?? '')) }
  }
  const readFileHash = async (args: Json, context: ToolHostContext) => {
    const temporary = await mkdtemp(join(tmpdir(), 'railwise-lark-readback-'))
    try {
      await read(['drive', '+download', '--file-token', String(args.fileToken), '--output', './content'], readScopes.drive, context, temporary)
      const path = join(temporary, 'content')
      const info = await stat(path)
      if (!info.isFile()) throw failure('connector_file_size_exceeded')
      const contentHash = await hashFile(path, context.abortSignal)
      return { fileToken: args.fileToken, contentHash, size: info.size }
    } finally { await rm(temporary, { recursive: true, force: true }) }
  }
  const result = (operation: string, target: string, data: Json, status: string, locator?: Json) => ({
    output: {
      ok: true, provider: 'lark', backend: 'lark-cli', accountFingerprint, operation, target, status: 'succeeded', data,
      ...(locator ? { verificationLocator: locator } : {}),
      evidence: { kind: 'external_operation', provider: 'lark', backend: 'lark-cli', accountFingerprint, operation, target,
        verified: true, verifiedAt: new Date().toISOString(), status, resultHash: hashText(JSON.stringify(data)),
        ...(locator?.messageId || locator?.fileToken ? { remoteOperationId: String(locator.messageId ?? locator.fileToken) } : {}) }
    }
  })
  const failed = (operation: string, target: string, code: string, dispatched: boolean, locator?: Json, data?: Json) => ({
    isError: true,
    output: { ok: false, provider: 'lark', backend: 'lark-cli', accountFingerprint, operation, target,
      status: dispatched ? 'outcome_unknown' : 'failed', code,
      ...(locator ? { verificationLocator: locator } : {}), ...(data ? { data } : {}) }
  })
  type ReadSpec = { name: string; description: string; schema: z.ZodType; scopes: string[]; target: string; read: (args: Json, context: ToolHostContext) => Promise<Json> }
  const readTool = (spec: ReadSpec) => defineLocalTool({
    name: spec.name, description: spec.description, inputSchema: z.toJSONSchema(spec.schema) as Json, policy: 'auto',
    effect: { provider: 'lark', operation: 'detail', mutation: false, targetFields: [spec.target], requiredScopes: spec.scopes },
    shouldAdvertise: () => spec.scopes.every(scope => config.scopes.includes(scope)),
    async execute(raw, context) {
      const args = spec.schema.parse(raw) as Json
      const target = String(args[spec.target])
      try { return result('detail', target, await spec.read(args, context), 'read') }
      catch (error) { return failed('detail', target, errorCode(error), false) }
    }
  })
  return [
    readTool({ name: 'lark_mail_send_status', description: '只读查询指定已发送邮件的逐收件人投递状态。', schema: mailReadInput, scopes: readScopes.mail, target: 'messageId', read: readMail }),
    readTool({ name: 'lark_im_get_message', description: '只读核验指定飞书会话中的准确消息及正文指纹。', schema: imReadInput, scopes: readScopes.im, target: 'messageId', read: readMessage }),
    readTool({ name: 'lark_drive_verify_file', description: '只读下载准确远端文件到临时目录，计算指纹并清理临时副本。', schema: fileReadInput, scopes: readScopes.drive, target: 'fileToken', read: readFileHash }),
    defineLocalTool({
      name: 'lark_mail_send', description: '经明确确认后，以当前用户向一个准确邮箱发送纯文本邮件，并查询投递状态。',
      inputSchema: z.toJSONSchema(mailInput) as Json, policy: 'on-request', requireExplicitApproval: true,
      effect: { provider: 'lark', operation: 'send', mutation: true, targetFields: ['recipient'], requiredScopes: LARK_DELIVERY_SCOPES.mail, readbackToolName: 'lark_mail_send_status' },
      shouldAdvertise: () => LARK_DELIVERY_SCOPES.mail.every(scope => config.scopes.includes(scope)),
      async execute(raw, context) {
        const args = mailInput.parse(raw)
        let dispatched = false
        let locator: Json | undefined
        try {
          const sent = await run(['mail', '+send', '--to', args.recipient, '--subject', args.subject, '--body', args.body,
            '--plain-text', '--no-signature', '--confirm-send', ...jsonFlags], [...LARK_DELIVERY_SCOPES.mail],
          dispatchContext(context, () => { dispatched = true }), { operation: 'send', target: args.recipient })
          if (!sent.ok) return failed('send', args.recipient, 'connector_send_unconfirmed', dispatched)
          const data = dataOf(sent.output)
          if (data.automation_send_disable_reason || data.automation_send_disable_reference) return failed('send', args.recipient, 'connector_send_blocked', false, undefined, data)
          if (typeof data.message_id !== 'string' || !data.message_id) return failed('send', args.recipient, 'connector_send_unconfirmed', true)
          locator = { messageId: data.message_id, recipient: args.recipient }
          const state = await readMail(locator, context)
          const status = verifiedLarkDeliveryState('lark_mail_send', locator, state)
          if (!status) {
            const code = mailDeliveryFailure(state, args.recipient)
            return failed('send', args.recipient, code, code !== 'connector_delivery_failed', locator, state)
          }
          return result('send', args.recipient, state, status, locator)
        } catch (error) { return failed('send', args.recipient, errorCode(error), dispatched, locator) }
      }
    }),
    defineLocalTool({
      name: 'lark_im_send', description: '经明确确认后，以当前用户向准确会话发送纯文本消息，并回读核验会话、发送者和正文。',
      inputSchema: z.toJSONSchema(imInput) as Json, policy: 'on-request', requireExplicitApproval: true,
      effect: { provider: 'lark', operation: 'send', mutation: true, targetFields: ['chatId'], requiredScopes: LARK_DELIVERY_SCOPES.im, readbackToolName: 'lark_im_get_message' },
      shouldAdvertise: () => LARK_DELIVERY_SCOPES.im.every(scope => config.scopes.includes(scope)),
      async execute(raw, context) {
        const args = imInput.parse(raw)
        let dispatched = false
        let locator: Json | undefined
        try {
          const approval = context.explicitApproval
          if (!approval) throw failure('connector_confirmation_missing')
          const idempotencyKey = hashText(JSON.stringify([context.executionGrant?.taskId, approval.callId, approval.requestHash]))
          const sent = await run(['im', '+messages-send', '--chat-id', args.chatId, '--text', args.text, '--idempotency-key', idempotencyKey, ...jsonFlags],
            [...LARK_DELIVERY_SCOPES.im], dispatchContext(context, () => { dispatched = true }), { operation: 'send', target: args.chatId })
          if (!sent.ok) return failed('send', args.chatId, 'connector_send_unconfirmed', dispatched)
          const data = dataOf(sent.output)
          if (typeof data.message_id !== 'string' || data.chat_id !== args.chatId) return failed('send', args.chatId, 'connector_target_mismatch', true)
          locator = { messageId: data.message_id, chatId: args.chatId, contentHash: hashText(args.text), senderId: config.userOpenId }
          const state = await readMessage(locator, context)
          const status = verifiedLarkDeliveryState('lark_im_send', locator, state)
          if (!status) return failed('send', args.chatId, 'connector_readback_unverified', true, locator)
          return result('send', args.chatId, state, status, locator)
        } catch (error) { return failed('send', args.chatId, errorCode(error), dispatched, locator) }
      }
    }),
    defineLocalTool({
      name: 'lark_drive_upload', description: '经确认后将本地文件上传到准确飞书文件夹。检查本地预期SHA-256，并下载远端副本核验。',
      inputSchema: z.toJSONSchema(uploadInput) as Json, policy: 'on-request', requireExplicitApproval: true,
      effect: { provider: 'lark', operation: 'upload', mutation: true, targetFields: ['folderToken'], requiredScopes: LARK_DELIVERY_SCOPES.drive, readbackToolName: 'lark_drive_verify_file' },
      shouldAdvertise: () => LARK_DELIVERY_SCOPES.drive.every(scope => config.scopes.includes(scope)),
      async execute(raw, context) {
        const args = uploadInput.parse(raw)
        let dispatched = false
        let locator: Json | undefined
        let temporary: string | undefined
        try {
          const source = await realpath(resolve(context.workspace, args.path))
          const blocked = grantPathBlock(source, context)
          if (blocked) throw failure(blocked.code)
          const info = await stat(source)
          if (!info.isFile()) throw failure('connector_file_size_exceeded')
          temporary = await mkdtemp(join(tmpdir(), 'railwise-lark-upload-'))
          const staged = join(temporary, 'content')
          await copyFile(source, staged)
          if (await hashFile(staged, context.abortSignal) !== args.expectedHash) throw failure('connector_source_changed')
          const sent = await run(['drive', '+upload', '--file', './content', '--name', basename(source), '--folder-token', args.folderToken, ...jsonFlags],
            [...LARK_DELIVERY_SCOPES.drive], dispatchContext(context, () => { dispatched = true }), { operation: 'upload', target: args.folderToken }, temporary)
          if (!sent.ok) return failed('upload', args.folderToken, 'connector_upload_unconfirmed', dispatched)
          const data = dataOf(sent.output)
          if (typeof data.file_token !== 'string' || !data.file_token) return failed('upload', args.folderToken, 'connector_upload_unconfirmed', true)
          locator = { fileToken: data.file_token, expectedHash: args.expectedHash, folderToken: args.folderToken }
          const state = { ...await readFileHash(locator, context), version: data.version, folderToken: args.folderToken }
          if (!verifiedLarkDeliveryState('lark_drive_upload', locator, state)) return failed('upload', args.folderToken, 'connector_readback_unverified', true, locator)
          return result('upload', args.folderToken, state, 'uploaded', locator)
        } catch (error) { return failed('upload', args.folderToken, errorCode(error), dispatched, locator) }
        finally { if (temporary) await rm(temporary, { recursive: true, force: true }) }
      }
    })
  ]
}

/** The runner calls validateExecutionGrant immediately before the business command. */
function dispatchContext(context: ToolHostContext, beforeDispatch: () => void): ToolHostContext {
  return { ...context, validateExecutionGrant: async () => { await context.validateExecutionGrant?.(); beforeDispatch() } }
}
export function verifiedLarkDeliveryState(tool: string, locator: Json, data: Json): string | undefined {
  if (tool === 'lark_mail_send') {
    const details = Array.isArray(data.details) ? data.details.map(object) : []
    const matching = details.filter(item => String(object(item.recipient).mail_address).toLowerCase() === String(locator.recipient).toLowerCase())
    return data.message_id === locator.messageId && matching.length > 0 && matching.every(item => item.status === 4) ? 'delivered' : undefined
  }
  if (tool === 'lark_im_send') {
    const sender = object(data.sender)
    return data.message_id === locator.messageId && data.chat_id === locator.chatId && data.msg_type === 'text' &&
      data.deleted === false && data.contentHash === locator.contentHash && sender.id === locator.senderId ? 'sent' : undefined
  }
  if (tool === 'lark_drive_upload') return data.fileToken === locator.fileToken && data.contentHash === locator.expectedHash ? 'uploaded' : undefined
  return undefined
}
function mailDeliveryFailure(data: Json, recipient: string): string {
  const details = Array.isArray(data.details) ? data.details.map(object).filter(item => String(object(item.recipient).mail_address).toLowerCase() === recipient.toLowerCase()) : []
  if (details.some(item => item.status === 3 || item.status === 6)) return 'connector_delivery_failed'
  if (details.some(item => item.status === 5)) return 'connector_delivery_approval_pending'
  return 'connector_delivery_pending'
}
function object(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {} }
function dataOf(value: unknown): Json { const envelope = object(value); return envelope.data ? object(envelope.data) : envelope }
function failure(code: string): Error { return Object.assign(new Error(code), { code }) }
function errorCode(error: unknown): string { return typeof object(error).code === 'string' ? String(object(error).code) : 'connector_request_failed' }
function hashText(value: string): string { return createHash('sha256').update(value).digest('hex') }
async function hashFile(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex')
}
