import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { buildLarkCliToolProvider } from '../adapters/tool/lark-cli-tool-provider.js'
import { LARK_DELIVERY_SCOPES } from '../adapters/tool/lark-delivery-tools.js'
import { CapabilityRegistry } from '../adapters/tool/capability-registry.js'
import { LocalToolHost } from '../adapters/tool/local-tool-host.js'
import { LarkCapabilityConfig } from '../contracts/capabilities.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { RequiredEffectSchema } from '../contracts/tasks.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { TaskRunRepository } from './task-run-repository.js'
import { TaskController } from './task-controller.js'
import { ExternalOperationVerificationService } from './external-operation-verification.js'
import { larkTestBinding, larkTestIdentity } from '../../tests/helpers/lark-identity.js'

describe('persisted mail delivery recovery', () => {
  it('keeps an accepted but pending send, then verifies through a single read without replaying it', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lark-delivery-recovery-')))
    const now = new Date().toISOString()
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite'))
    try {
      const scopes = [...LARK_DELIVERY_SCOPES.mail]
      let status = 1
      const calls: string[][] = []
      const config = LarkCapabilityConfig.parse({ enabled: true, authState: 'installed', executablePath: '/managed/lark-cli', executableVersion: '1.0.100', ...larkTestBinding, scopes })
      const provider = buildLarkCliToolProvider(config, async (_path, args) => {
        if (args[0] === 'auth') return { ok: true, output: { ...larkTestIdentity, identities: { user: { ...larkTestIdentity.identities.user, scope: scopes.join(' ') } } } }
        calls.push(args)
        return { ok: true, output: { ok: true, data: args[1] === '+send' ? { message_id: 'mail-1' }
          : { message_id: 'mail-1', details: [{ recipient: { mail_address: 'test@example.com' }, status }] } } }
      })!
      const registry = new CapabilityRegistry([provider]), toolHost = new LocalToolHost({ registry })
      const threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
      const thread = createThreadRecord({ id: 'thread', workspace: root, title: 'synthetic', model: 'test' })
      thread.turns.push(createTurnRecord({ id: 'turn', threadId: thread.id, prompt: '通过飞书发送邮件', createdAt: now, status: 'completed' }))
      await threadStore.upsert(thread)
      const controller = new TaskController({ repository, threadStore, sessionStore, nowIso: () => now, resolveToolEffect: name => registry.describeEffect(name) })
      const task = controller.ensureTask({ thread, turnId: 'turn', request: { prompt: '通过飞书发送邮件' } })
      controller.beginAttempt(thread.id, 'turn')
      controller.confirmEffectScope('turn', 0, 'confirmed-mail', [RequiredEffectSchema.parse({ provider: 'lark', operation: 'send', target: 'test@example.com' })])
      const grant = ExecutionGrantSchema.parse({ id: 'grant', taskId: task.id, threadId: thread.id, turnId: 'turn', workspaceRoot: root,
        workspaceTrust: 'workspace-write', agentTrust: 'full-access', sandboxMode: 'workspace-write', approvalPolicy: 'auto',
        allowedProviderIds: ['lark-cli'], allowedToolNames: ['lark_mail_send', 'lark_mail_send_status'],
        networkAllowlist: ['https://open.feishu.cn'], connectorScopes: scopes, connectorBackends: { 'lark-cli': 'lark-cli' },
        connectorIdentityFingerprints: { 'lark-cli': larkTestBinding.identityFingerprint },
        workspaceRevision: 1, agentRevision: 0, revision: 1, idempotencyKey: 'grant', issuedAt: now })
      const args = { recipient: 'test@example.com', subject: 'Synthetic', body: 'private body for approval' }
      const call = { callId: 'send', toolName: 'lark_mail_send', providerId: 'lark-cli', arguments: args }
      const dispatch = controller.beginToolOperation('turn', call, grant)!
      const awaitApproval = vi.fn(async (approval: { summary: string }) => {
        expect(approval.summary).toContain(args.body)
        expect(approval.summary).toContain(createHash('sha256').update(JSON.stringify(args)).digest('hex'))
        return 'allow' as const
      })
      const result = await toolHost.execute(call, { threadId: thread.id, turnId: 'turn', workspace: root,
        approvalPolicy: 'auto', sandboxMode: 'workspace-write', executionGrant: grant, abortSignal: new AbortController().signal, awaitApproval,
        assertExternalTarget: (provider, operation, target) => controller.assertExternalTarget('turn', provider, operation, target),
        recordExplicitApproval: approval => controller.recordToolApproval(dispatch.token, dispatch.key, approval) })
      controller.finishToolOperation(dispatch.token, dispatch.key, result)
      const receipt = repository.operation(task.id, dispatch.key)!
      expect(receipt.status).toBe('outcome_unknown')
      expect(JSON.stringify(receipt.result)).not.toContain(args.body)
      expect(receipt.result).toMatchObject({ item: { output: { verificationLocator: { messageId: 'mail-1', recipient: args.recipient } } } })
      const current = repository.get(task.id)!
      repository.update(task.id, current.revision, value => ({ ...value, status: 'waiting_user' }))
      status = 4
      const verify = new ExternalOperationVerificationService({ repository, controller, toolHost, threadStore,
        workspaceTrust: { get: async () => ({ canonicalRoot: root, level: 'workspace-write', revision: 1 }) },
        refreshProvider: async () => undefined, nowIso: () => now })
      expect(await verify.verify(task.id, receipt.id, { expectedRevision: repository.get(task.id)!.revision, idempotencyKey: 'verify' })).toMatchObject({ status: 'verified', evidence: { operation: 'send', target: args.recipient, status: 'delivered' } })
      expect(calls.filter(args => args[1] === '+send')).toHaveLength(1)
      expect(calls.filter(args => args[2] === 'send_status')).toHaveLength(2)
      expect(repository.get(task.id)?.status).toBe('waiting_user')
    } finally { repository.close(); await rm(root, { recursive: true, force: true }) }
  })
})
