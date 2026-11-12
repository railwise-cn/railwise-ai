import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TaskRunRepository } from '../../services/task-run-repository.js'
import { TaskRunSchema } from '../../contracts/tasks.js'
import { verifiedEffectReceipts } from '../../services/external-effect-evidence.js'
import { buildRouter } from './index.js'
import type { ServerRuntime } from './server-runtime.js'

describe('IM transport observations', () => {
  it('authenticates, binds the original thread/turn, deduplicates, and never creates business-effect evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'im-delivery-route-'))
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite'))
    try {
      const now = new Date().toISOString()
      const task = repository.create(TaskRunSchema.parse({ id: 'task', threadId: 'thread', activeTurnId: 'turn', childTaskIds: [], workspaceRoot: root,
        goal: '发送飞书消息', status: 'waiting_user', agentId: 'general', acceptance: { kind: 'effect', requiredNodeKinds: ['deliver'], requireFinalResponse: true, requireActionableArtifactCard: false,
          effect: { provider: 'lark', operation: 'send', target: 'target', requiresConfirmation: true, requiredScopes: [], successCriteria: 'verified', verification: 'provider_readback' } },
        budget: { maxAttempts: 3, maxDurationMs: 60000 }, attempts: 1, replans: 0, noProgressCount: 0, nodes: [], artifacts: [], createdAt: now, updatedAt: now, revision: 0 }))
      const runtime = { runtimeToken: 'local-token', insecure: false, taskRepository: repository,
        threadService: { get: async (id: string) => id === 'thread' || id === 'chat-only' ? { id, turns: [{ id: 'turn' }] } : undefined } } as unknown as ServerRuntime
      const router = buildRouter(runtime)
      const observation = { operationId: 'im-stable:send', purpose: 'assistant_reply', provider: 'feishu', phase: 'send', accountFingerprint: 'a'.repeat(64),
        targetFingerprint: 'b'.repeat(64), requestHash: 'c'.repeat(64), runtimeThreadId: 'thread', runtimeTurnId: 'turn', status: 'started', observedAt: now }
      const send = async (body: Record<string, unknown>, auth = true) => {
        const id = String(body.runtimeThreadId)
        const route = router.match('POST', `/v1/threads/${id}/delivery-observations`)!
        return route.handler(new Request(`http://runtime/v1/threads/${id}/delivery-observations`, { method: 'POST',
          headers: auth ? { authorization: 'Bearer local-token' } : {}, body: JSON.stringify(body) }), { params: { id } })
      }
      expect((await send(observation, false)).status).toBe(401)
      expect((await send(observation)).status).toBe(200)
      const success = { ...observation, status: 'succeeded', remoteOperationId: 'om-1' }
      expect((await send(success)).status).toBe(200)
      expect((await send(success)).status).toBe(200)
      expect(repository.operations(task.id, 'im_delivery')).toHaveLength(1)
      expect(repository.unsettledOperations(task.id)).toEqual([])
      expect(verifiedEffectReceipts(task, repository.operations(task.id))).toEqual([])
      expect((await send({ ...success, requestHash: 'd'.repeat(64) })).status).toBe(409)
      expect((await send({ ...success, runtimeTurnId: 'other-turn' })).status).toBe(404)
      expect((await send({ ...success, taskId: 'other-task' })).status).toBe(400)
      expect((await send({ ...success, runtimeThreadId: 'chat-only' })).status).toBe(200)
      expect(repository.operations(task.id)).toHaveLength(1)
    } finally { repository.close(); await rm(root, { recursive: true, force: true }) }
  })
})
