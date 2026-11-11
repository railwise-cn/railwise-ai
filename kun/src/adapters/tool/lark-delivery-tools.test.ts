import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LarkCapabilityConfig } from '../../contracts/capabilities.js'
import { ExecutionGrantSchema } from '../../contracts/permissions.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { buildLarkCliToolProvider, type LarkCliRunner } from './lark-cli-tool-provider.js'
import { LARK_DELIVERY_SCOPES, verifiedLarkDeliveryState } from './lark-delivery-tools.js'
import { larkTestBinding, larkTestIdentity } from '../../../tests/helpers/lark-identity.js'

const scopes = [...new Set(Object.values(LARK_DELIVERY_SCOPES).flat())]
const roots: string[] = []
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }) })
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fixture(business: LarkCliRunner) {
  const runner: LarkCliRunner = async (...args) => args[1][0] === 'auth'
    ? { ok: true, output: { ...larkTestIdentity, identities: { user: { ...larkTestIdentity.identities.user, scope: scopes.join(' ') } } } }
    : business(...args)
  const config = LarkCapabilityConfig.parse({ enabled: true, authState: 'installed', executablePath: '/managed/lark-cli', executableVersion: '1.0.100', ...larkTestBinding, scopes })
  const provider = buildLarkCliToolProvider(config, runner)!
  const context: ToolHostContext = { threadId: 'thread', turnId: 'turn', workspace: tmpdir(), approvalPolicy: 'auto', sandboxMode: 'read-only',
    abortSignal: new AbortController().signal, awaitApproval: async () => 'allow', assertExternalTarget: vi.fn(),
    explicitApproval: { callId: 'call-1', toolName: 'synthetic', requestHash: hash('request') },
    executionGrant: ExecutionGrantSchema.parse({ id: 'grant', taskId: 'task', threadId: 'thread', turnId: 'turn', workspaceRoot: tmpdir(),
      workspaceTrust: 'read-only', agentTrust: 'full-access', sandboxMode: 'read-only', approvalPolicy: 'auto',
      networkAllowlist: ['https://open.feishu.cn'], pathAllowlist: [tmpdir()], connectorScopes: scopes,
      connectorBackends: { 'lark-cli': 'lark-cli' }, connectorIdentityFingerprints: { 'lark-cli': larkTestBinding.identityFingerprint },
      workspaceRevision: 0, agentRevision: 0, revision: 0, idempotencyKey: 'test', issuedAt: new Date().toISOString() }) }
  return { config, provider, context, tool: (name: string) => provider.tools.find(tool => tool.name === name)! }
}
describe('typed Lark deliveries', () => {
  it('advertises only version-tested tools with their complete write and readback scopes', () => {
    const f = fixture(vi.fn())
    expect(f.provider.tools.map(tool => tool.name)).toContain('lark_drive_upload')
    expect(f.tool('lark_mail_send')).toMatchObject({ requireExplicitApproval: true, effect: { mutation: true, readbackToolName: 'lark_mail_send_status' } })
    expect(buildLarkCliToolProvider({ ...f.config, executableVersion: undefined })).toBeUndefined()
    const limited = buildLarkCliToolProvider({ ...f.config, scopes: ['mail:user_mailbox.message:send'] })
    expect(limited).toBeUndefined()
  })
  it.each([1, 3, 4, 5, 6])('uses exact mail recipient status %s without a second send', async status => {
    const runner = vi.fn(async (_path: string, args: string[]) => ({ ok: true, output: { ok: true, data:
      args[1] === '+send' ? { message_id: 'mail-1' } : { message_id: 'mail-1', details: [{ recipient: { mail_address: 'test@example.com' }, status }] } } }))
    const f = fixture(runner)
    const result = await f.tool('lark_mail_send').execute({ recipient: 'test@example.com', subject: '合成验收', body: '测试正文' }, f.context)
    expect(result).toMatchObject({ output: { status: status === 4 ? 'succeeded' : status === 3 || status === 6 ? 'failed' : 'outcome_unknown', verificationLocator: { messageId: 'mail-1', recipient: 'test@example.com' } } })
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls[0][1]).toContain('--plain-text')
    expect(runner.mock.calls[0][1]).toContain('--confirm-send')
    expect(runner.mock.calls[1][1].slice(0, 3)).toEqual(['mail', 'user_mailbox.messages', 'send_status'])
    expect(JSON.stringify(result)).not.toContain('测试正文')
  })
  it('keeps a blocked mail draft failed and does not query a fabricated message id', async () => {
    const runner = vi.fn(async () => ({ ok: true, output: { ok: true, data: { draft_id: 'draft-1', automation_send_disable_reason: 'policy' } } }))
    const f = fixture(runner)
    expect(await f.tool('lark_mail_send').execute({ recipient: 'test@example.com', subject: 'Synthetic', body: 'body' }, f.context)).toMatchObject({ output: { status: 'failed', code: 'connector_send_blocked' } })
    expect(runner).toHaveBeenCalledOnce()
  })
  it.each(['@./credentials.json', '@@literal', '-', '--body-file=secret.txt', '<img src="./secret.png">'])('keeps mail subject and body literal for %s', async text => {
    const runner = vi.fn<LarkCliRunner>(async (_path, args) => ({ ok: true, output: { data:
      args[1] === '+send' ? { message_id: 'mail-1' } : { message_id: 'mail-1', details: [{ recipient: { mail_address: 'test@example.com' }, status: 4 }] } } }))
    const f = fixture(runner)
    expect(await f.tool('lark_mail_send').execute({ recipient: 'test@example.com', subject: text, body: text }, f.context)).toMatchObject({ output: { status: 'succeeded' } })
    const args = runner.mock.calls[0][1]
    expect(args[args.indexOf('--subject') + 1]).toBe(text)
    expect(args[args.indexOf('--body') + 1]).toBe(text)
    expect(args).toContain('--plain-text')
    expect(args).toContain('--no-signature')
    for (const flag of ['--body-file', '--attach', '--inline']) expect(args).not.toContain(flag)
  })
  it('requires exact chat, sender and content for IM readback, with a stable upstream idempotency key', async () => {
    const text = '合成消息'
    const runner = vi.fn(async (_path: string, args: string[]) => ({ ok: true, output: { ok: true, data:
      args[1] === '+messages-send' ? { message_id: 'om-1', chat_id: 'oc-1' } : { messages: [{ message_id: 'om-1', chat_id: 'oc-1', msg_type: 'text', content: text, sender: { id: 'ou-synthetic' }, deleted: false }] } } }))
    const f = fixture(runner)
    const result = await f.tool('lark_im_send').execute({ chatId: 'oc-1', text }, f.context)
    expect(result).toMatchObject({ output: { status: 'succeeded', evidence: { status: 'sent', remoteOperationId: 'om-1' }, verificationLocator: { contentHash: hash(text), senderId: 'ou-synthetic' } } })
    expect(runner.mock.calls[0][1]).toContain('--idempotency-key')
    expect(runner.mock.calls[1][1]).toContain('--no-reactions')
    const locator = { messageId: 'om-1', chatId: 'oc-1', contentHash: hash(text), senderId: 'ou-synthetic' }
    expect(verifiedLarkDeliveryState('lark_im_send', locator, { message_id: 'om-1', chat_id: 'oc-1', contentHash: hash(text), msg_type: 'text', deleted: false, sender: { id: 'other' } })).toBeUndefined()
  })
  it.each(['@./credentials.json', '@@literal', '-', '--text=secret', '<at id=ou-synthetic/>', '中文正文\n"quoted" \\path'])('sends literal IM text without CLI file or stdin interpretation for %s', async text => {
    const runner = vi.fn<LarkCliRunner>(async (_path, args) => ({ ok: true, output: { data:
      args[1] === '+messages-send' ? { message_id: 'om-1', chat_id: 'oc-1' } : { messages: [{ message_id: 'om-1', chat_id: 'oc-1', msg_type: 'text', content: text, sender: { id: 'ou-synthetic' }, deleted: false }] } } }))
    const f = fixture(runner)
    expect(await f.tool('lark_im_send').execute({ chatId: 'oc-1', text }, f.context)).toMatchObject({ output: { status: 'succeeded', verificationLocator: { contentHash: hash(text) } } })
    const args = runner.mock.calls[0][1]
    expect(args).not.toContain('--text')
    expect(args[args.indexOf('--msg-type') + 1]).toBe('text')
    const content = args[args.indexOf('--content') + 1]
    expect(content.startsWith('{')).toBe(true)
    expect(content).not.toContain('<')
    expect(JSON.parse(content)).toEqual({ text })
  })
  it('does not dispatch on a changed account or revoked grant', async () => {
    const runner = vi.fn()
    const f = fixture(runner)
    f.context.executionGrant = { ...f.context.executionGrant!, connectorIdentityFingerprints: { 'lark-cli': '0'.repeat(64) } }
    expect(await f.tool('lark_mail_send').execute({ recipient: 'test@example.com', subject: 'Synthetic', body: 'body' }, f.context)).toMatchObject({ output: { status: 'failed', code: 'connector_identity_changed' } })
    expect(runner).not.toHaveBeenCalled()
  })
  it('keeps IM idempotency keys within 50 characters, stable for retries and distinct for separate confirmed operations', async () => {
    const runner = vi.fn<LarkCliRunner>(async () => ({ ok: false, output: { code: 1 } }))
    const f = fixture(runner)
    const tool = f.tool('lark_im_send')
    const request = { chatId: 'oc-1', text: '合成消息' }
    await tool.execute(request, f.context)
    await tool.execute(request, f.context)
    await tool.execute(request, { ...f.context, explicitApproval: { ...f.context.explicitApproval!, callId: 'call-2' } })
    await tool.execute(request, { ...f.context, explicitApproval: { ...f.context.explicitApproval!, requestHash: hash('different-request') } })
    await tool.execute(request, { ...f.context, executionGrant: { ...f.context.executionGrant!, taskId: 'different-task' } })
    const keys = runner.mock.calls.map(([, args]) => args[args.indexOf('--idempotency-key') + 1])
    expect(keys).toHaveLength(5)
    for (const key of keys) expect(key).toMatch(/^[a-f0-9]{50}$/)
    expect(keys[0]).toBe(hash(JSON.stringify(['task', 'call-1', hash('request')])).slice(0, 50))
    expect(keys[1]).toBe(keys[0])
    expect(new Set([keys[0], ...keys.slice(2)]).size).toBe(4)
  })
  it('stages the approved file bytes and verifies the downloaded remote hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-upload-test-')); roots.push(root)
    await writeFile(join(root, 'report.txt'), 'synthetic document')
    let uploaded = ''
    const runner = vi.fn<LarkCliRunner>(async (_path, args, _signal, _hash, cwd) => {
      if (args[1] === '+upload') {
        uploaded = await readFile(join(cwd!, 'content'), 'utf8')
        return { ok: true, output: { ok: true, data: { file_token: 'file-1', version: '1' } } }
      }
      await writeFile(join(cwd!, 'content'), uploaded)
      return { ok: true, output: { ok: true, data: {} } }
    })
    const f = fixture(runner)
    f.context.workspace = root
    f.context.executionGrant = { ...f.context.executionGrant!, pathAllowlist: [await realpath(root)] }
    const result = await f.tool('lark_drive_upload').execute({ path: 'report.txt', folderToken: 'folder-1', expectedHash: hash('synthetic document') }, f.context)
    expect(result).toMatchObject({ output: { status: 'succeeded', data: { contentHash: hash('synthetic document'), version: '1' }, verificationLocator: { fileToken: 'file-1', folderToken: 'folder-1' } } })
    expect(runner).toHaveBeenCalledTimes(2)
    for (const call of runner.mock.calls) await expect(statExists(call[4]!)).resolves.toBe(false)
  })
  it('refuses an altered local baseline before uploading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-upload-changed-')); roots.push(root)
    await writeFile(join(root, 'report.txt'), 'changed')
    const runner = vi.fn()
    const f = fixture(runner); f.context.workspace = root
    f.context.executionGrant = { ...f.context.executionGrant!, pathAllowlist: [await realpath(root)] }
    expect(await f.tool('lark_drive_upload').execute({ path: 'report.txt', folderToken: 'folder-1', expectedHash: hash('expected') }, f.context)).toMatchObject({ output: { status: 'failed', code: 'connector_source_changed' } })
    expect(runner).not.toHaveBeenCalled()
  })
})
async function statExists(path: string): Promise<boolean> { try { await readFile(join(path, 'content')); return true } catch { return false } }
