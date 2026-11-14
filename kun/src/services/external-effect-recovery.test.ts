import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { makeAssistantTextItem, makeToolResultItem } from '../domain/item.js'
import { TaskController } from './task-controller.js'
import { TaskRunRepository } from './task-run-repository.js'
import { RequiredEffectSchema } from '../contracts/tasks.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(prompt: string) {
  const root = await mkdtemp(join(tmpdir(), 'railwise-effect-recovery-'))
  roots.push(root)
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
  const threadStore = new InMemoryThreadStore()
  const sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: 'thread', title: 'synthetic', workspace: root, model: 'fixture' })
  await threadStore.upsert(thread)
  const controller = new TaskController({ repository, threadStore, sessionStore, nowIso: () => '2026-11-10T00:00:00Z' })
  const task = controller.ensureTask({ thread, turnId: 'turn-1', request: { prompt } })
  controller.beginAttempt(thread.id, 'turn-1')
  return { repository, controller, thread, task, sessionStore }
}

describe('external effect durable recovery', () => {
  it('completes a real read-result path for current-account list tasks', async () => {
    const { repository, controller, task, thread, sessionStore } = await fixture('列出飞书待办')
    expect(task.acceptance.effect).toMatchObject({ operation: 'list', target: 'current_user' })
    const call = { callId: 'list-1', toolName: 'lark_task_list', providerId: 'lark-cli', arguments: {} }
    const operation = controller.beginToolOperation('turn-1', call)!
    controller.finishToolOperation(operation.token, operation.key, { approved: true, item: makeToolResultItem({
      id: 'result-list', threadId: thread.id, turnId: 'turn-1', ...call,
      output: { ok: true, status: 'succeeded', evidence: { kind: 'external_operation', provider: 'lark', operation: 'list', target: 'current_user', status: 'listed', verified: true, verifiedAt: '2026-11-10T00:00:00Z', resultHash: 'fixture-hash' } }
    }) })
    await sessionStore.appendItem(thread.id, makeAssistantTextItem({ id: 'answer', threadId: thread.id, turnId: 'turn-1', text: '飞书待办查询结果为空。', status: 'completed' }))
    expect(await controller.assessCandidate(thread.id, 'turn-1')).toMatchObject({ kind: 'completed' })
    repository.close()
  })

  it('reuses a verified mutation across new call IDs and resumed attempts without dispatching twice', async () => {
    const { repository, controller, task, thread, sessionStore } = await fixture('处理飞书待办')
    controller.confirmEffectScope('turn-1', 0, 'confirmed-set', [RequiredEffectSchema.parse({ provider: 'lark', operation: 'complete', target: 'synthetic-42' })])
    const call = { callId: 'write-1', toolName: 'lark_task_complete', providerId: 'lark-cli', arguments: { taskId: 'synthetic-42' } }
    const operation = controller.beginToolOperation('turn-1', call)!
    controller.finishToolOperation(operation.token, operation.key, { approved: true, item: makeToolResultItem({
      id: 'result-write', threadId: thread.id, turnId: 'turn-1', ...call,
      output: { ok: true, status: 'succeeded', evidence: { kind: 'external_operation', provider: 'lark', operation: 'complete', target: 'synthetic-42', status: 'completed', verified: true, verifiedAt: '2026-11-10T00:00:00Z', resultHash: 'fixture-hash' } }
    }) })
    const current = repository.get(task.id)!
    repository.update(task.id, current.revision, value => ({ ...value, activeTurnId: 'turn-2' }))
    controller.beginAttempt(thread.id, 'turn-2')
    const replay = controller.beginToolOperation('turn-2', { ...call, callId: 'write-2' })!
    expect(replay.prior).toMatchObject({ approved: true, item: { callId: 'write-2', turnId: 'turn-2' } })
    expect(repository.operations(task.id, 'tool')).toHaveLength(1)
    expect(() => controller.beginToolOperation('turn-2', { ...call, callId: 'write-changed', arguments: { ...call.arguments, value: 'changed' } })).toThrow(/already has a different operation/)
    await sessionStore.appendItem(thread.id, makeAssistantTextItem({ id: 'answer', threadId: thread.id, turnId: 'turn-2', text: '已核验指定的飞书待办完成。', status: 'completed' }))
    expect(await controller.assessCandidate(thread.id, 'turn-2')).toMatchObject({ kind: 'completed', task: { resultEvidence: [expect.objectContaining({ target: 'synthetic-42' })] } })
    repository.close()
  })

  it('does not replay unknown mutations with a fresh call ID', async () => {
    const { repository, controller, task } = await fixture('处理飞书待办')
    controller.confirmEffectScope('turn-1', 0, 'confirmed-set', [RequiredEffectSchema.parse({ provider: 'lark', operation: 'complete', target: 'synthetic-42' })])
    const call = { callId: 'unknown-1', toolName: 'lark_task_complete', providerId: 'lark-cli', arguments: { taskId: 'synthetic-42' } }
    const operation = controller.beginToolOperation('turn-1', call)!
    controller.recordToolDispatch(operation.token, operation.key)
    controller.finishToolOperation(operation.token, operation.key)
    expect(repository.operation(task.id, operation.key)?.status).toBe('outcome_unknown')
    expect(() => controller.beginToolOperation('turn-1', { ...call, callId: 'unknown-2' })).toThrow(expect.objectContaining({
      code: 'outcome_unknown', message: 'A previous tool has an unknown outcome. Verify its original receipt before executing another tool.'
    }))
    expect(repository.operations(task.id, 'tool')).toHaveLength(1)
    repository.close()
  })
})
