import { expect, it } from 'vitest'
import { createEgoBrowserFixture } from '../../tests/ego-browser-test-fixture.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { makeAssistantTextItem } from '../domain/item.js'
import { TaskController } from './task-controller.js'
import { RuntimeSpanService } from './runtime-span-service.js'
import type { TurnItem } from '../contracts/items.js'

async function fixture() {
  const f = await createEgoBrowserFixture()
  await f.execute('ego_browser_open', { url: 'https://feed.test/list' })
  const original = f.repo.get(f.task.id)!
  f.repo.update(original.id, original.revision, task => ({ ...task, acceptance: { ...task.acceptance, kind: 'answer', requiredFormats: undefined, minimumArtifacts: undefined } }))
  const threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: f.task.threadId, workspace: f.task.workspaceRoot, title: 'Controlled Ego finish', model: 'no-model' })
  await threadStore.upsert({ ...thread, turns: [{ ...createTurnRecord({ id: f.grant().turnId, threadId: thread.id, prompt: f.task.goal }), executionGrant: f.grant() }] })
  for (const receipt of f.repo.operations(f.task.id, 'tool')) await sessionStore.appendItem(thread.id, (receipt.result as { item: TurnItem }).item)
  const spans = new RuntimeSpanService(f.repo, () => '2026-11-16T00:00:01.000Z')
  const controller = new TaskController({ repository: f.repo, threadStore, sessionStore, spans, nowIso: () => '2026-11-16T00:00:01.000Z' })
  controller.beginAttempt(thread.id, f.grant().turnId)
  const snapshot = () => JSON.stringify({ task: f.repo.get(f.task.id), operations: f.repo.operations(f.task.id), spans: spans.diagnostics(f.task.id) })
  return { ...f, controller, threadStore, sessionStore, thread, snapshot }
}

it('can finish a genuine read/answer task without requiring an HTML file or mutating ledgers/spans', async () => {
  const f = await fixture()
  try {
    const before = f.snapshot()
    expect(await f.controller.egoFinishReadiness(f.task.id, f.grant().turnId)).toEqual({ ready: true })
    expect(f.snapshot()).toBe(before)
  } finally { await f.dispose() }
})

it('does not complete a genuine Ego-source answer before the actual finish, and identifies finish rather than missing origins', async () => {
  const f = await fixture()
  try {
    await f.sessionStore.appendItem(f.thread.id, makeAssistantTextItem({ id: 'final-answer', threadId: f.thread.id, turnId: f.grant().turnId,
      text: '读取结果：测绘监测项目，列表日期为2026-11-16。', status: 'completed' }))
    const decision = await f.controller.assessCandidate(f.thread.id, f.grant().turnId)
    expect(decision).toMatchObject({ kind: 'continue', reason: expect.stringContaining('ego_browser_finish') })
    expect(f.repo.get(f.task.id)!.status).not.toBe('completed')
    expect(f.repo.events(f.task.id).some(event => event.kind === 'task_completed')).toBe(false)
  } finally { await f.dispose() }
})

it.each(['files-not-written', 'hard-wait', 'unknown-operation', 'wrong-host', 'wrong-turn'] as const)('refuses premature cleanup without writes or releasing the execution lease: %s', async boundary => {
  const f = await fixture()
  try {
    const current = f.repo.get(f.task.id)!, now = '2026-11-16T00:00:01.000Z'
    if (boundary === 'files-not-written') f.repo.update(current.id, current.revision, task => ({ ...task, acceptance: { ...task.acceptance, kind: 'files', requiredFormats: ['html'], minimumArtifacts: 1 },
      artifacts: [{ id: 'missing-report', relativePath: 'report.html', format: 'html', validation: 'invalid', createdAt: now }] }))
    if (boundary === 'hard-wait') {
      f.repo.beginOperation({ ownerId: current.id, idempotencyKey: 'ego-wait:'+f.grant().turnId, kind: 'ego_browser_wait', request: { turnId: f.grant().turnId }, nowIso: now })
      f.repo.finishOperation(current.id, 'ego-wait:'+f.grant().turnId, { status: 'succeeded' }, now)
    }
    if (boundary === 'unknown-operation') {
      f.repo.beginOperation({ ownerId: current.id, idempotencyKey: 'unresolved-original', kind: 'tool', request: { toolName: 'ego_browser_read', turnId: f.grant().turnId }, nowIso: now })
      f.repo.finishOperation(current.id, 'unresolved-original', { status: 'outcome_unknown' }, now)
    }
    const before = f.snapshot(), token = f.controller.tokenForTurn(f.grant().turnId)
    expect(await f.controller.egoFinishReadiness(current.id, boundary === 'wrong-turn' ? 'wrong-turn' : f.grant().turnId,
      boundary === 'wrong-host' ? 'not-an-actual-host' : undefined)).toMatchObject({ ready: false })
    expect(f.snapshot()).toBe(before)
    expect(f.controller.tokenForTurn(f.grant().turnId)).toBe(token)
  } finally { await f.dispose() }
})
