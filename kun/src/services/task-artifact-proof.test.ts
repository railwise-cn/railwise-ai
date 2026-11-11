import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { createThreadRecord } from '../domain/thread.js'
import { createTurnRecord } from '../domain/turn.js'
import { makeAssistantTextItem, makeToolResultItem } from '../domain/item.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { createWriteLocalTool } from '../adapters/tool/builtin-file-tools.js'
import { TaskRunRepository } from './task-run-repository.js'
import { TaskController } from './task-controller.js'
import { authorizedArtifactWrites } from './task-artifact-proof.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(authorized = true, wait = false) {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-external-artifact-')); roots.push(temporary)
  const root = await realpath(temporary)
  const workspace = join(root, 'workspace'), destination = join(root, 'delivery')
  await Promise.all([mkdir(workspace), mkdir(destination)])
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
  const threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: 'thread', workspace, model: 'fixture' })
  await threadStore.upsert(thread)
  const nowIso = () => '2026-11-01T00:00:00.000Z'
  const controller = new TaskController({ repository, threadStore, sessionStore, nowIso,
    ...(wait ? { completionGuard: () => ({ reason: '需要审阅', fingerprint: 'review', retryable: false }) } : {}) })
  const task = controller.ensureTask({ thread, turnId: 'turn-1', request: { prompt: '请生成并交付 result.md Markdown 文件。' } })
  const grant = ExecutionGrantSchema.parse({ id: 'grant-1', taskId: task.id, threadId: thread.id, turnId: 'turn-1', workspaceRoot: workspace, workspaceTrust: 'workspace-write', agentTrust: 'workspace-write', approvalPolicy: 'auto', sandboxMode: 'workspace-write', allowedToolNames: ['write'], pathAllowlist: [workspace, destination], writePathAllowlist: authorized ? [workspace, destination] : [workspace], workspaceRevision: 1, agentRevision: 0, revision: 1, idempotencyKey: 'grant-1', issuedAt: nowIso() })
  const turn = { ...createTurnRecord({ id: 'turn-1', threadId: thread.id, prompt: task.goal }), executionGrant: grant }
  await threadStore.upsert({ ...thread, turns: [turn] })
  controller.beginAttempt(thread.id, turn.id)
  const path = join(destination, 'result.md'), content = '# External deliverable\n'
  const call = { callId: 'write-1', toolName: 'write', toolKind: 'file_change' as const, arguments: { path, content } }
  const operation = controller.beginToolOperation(turn.id, call, grant)!
  const output = authorized
    ? await createWriteLocalTool().execute(call.arguments, { threadId: thread.id, turnId: turn.id, workspace, threadMode: 'agent', approvalPolicy: 'auto', sandboxMode: 'workspace-write', abortSignal: new AbortController().signal, awaitApproval: async () => 'allow', executionGrant: grant })
    : { output: { path, sha256: createHash('sha256').update(content).digest('hex') } }
  if (!authorized) await writeFile(path, content)
  const item = makeToolResultItem({ id: 'write-result', threadId: thread.id, turnId: turn.id, callId: call.callId, toolName: call.toolName, toolKind: 'file_change', output: output.output, isError: output.isError })
  controller.finishToolOperation(operation.token, operation.key, { approved: true, item })
  await sessionStore.appendItem(thread.id, item)
  await sessionStore.appendItem(thread.id, makeAssistantTextItem({ id: 'answer-1', threadId: thread.id, turnId: turn.id, text: 'Markdown 成果已经生成并交付。', status: 'completed' }))
  return { root, workspace, destination, path, repository, threadStore, sessionStore, controller, thread, task, grant, turn }
}

describe('authorized external task artifacts', () => {
  it('accepts a real write under its immutable grant and keeps the ordinary relative-path contract scoped', async () => {
    const f = await fixture()
    try {
      const decision = await f.controller.assessCandidate(f.thread.id, f.turn.id)
      expect(decision.kind).toBe('completed')
      expect(decision.task.artifacts).toMatchObject([{ relativePath: 'result.md', absolutePath: f.path, authorizedRoot: f.destination, executionGrantId: f.grant.id, validation: 'valid' }])
      expect(decision.task.artifacts[0].sha256).toHaveLength(64)
    } finally { f.repository.close() }
  })

  it('rejects an external path when the successful receipt grant does not include it', async () => {
    const f = await fixture(false)
    try {
      const decision = await f.controller.assessCandidate(f.thread.id, f.turn.id)
      expect(decision.kind).not.toBe('completed')
      expect(decision.task.artifacts[0].validation).toBe('invalid')
      expect(decision.task.artifacts[0].absolutePath).toBeUndefined()
    } finally { f.repository.close() }
  })

  it('retains the expected hash on later turns and refuses a replaced grant root', async () => {
    const f = await fixture(true, true)
    try {
      const first = await f.controller.assessCandidate(f.thread.id, f.turn.id)
      const hash = first.task.artifacts[0].sha256
      await writeFile(f.path, '# Externally changed\n')
      for (const id of ['turn-2', 'turn-3']) {
        const current = f.repository.get(f.task.id)!
        f.controller.prepareResume(current.id, current.revision)
        f.controller.ensureTask({ thread: (await f.threadStore.get(f.thread.id))!, turnId: id, request: { prompt: '继续', taskIntent: 'supplement' } })
        f.controller.beginAttempt(f.thread.id, id)
        const decision = await f.controller.assessCandidate(f.thread.id, id)
        expect(decision.task.artifacts[0]).toMatchObject({ sha256: hash, validation: 'invalid' })
      }
      await rename(f.destination, join(f.root, 'original-delivery'))
      const elsewhere = join(f.root, 'elsewhere'); await mkdir(elsewhere); await writeFile(join(elsewhere, 'result.md'), '# External deliverable\n')
      await symlink(elsewhere, f.destination, process.platform === 'win32' ? 'junction' : 'dir')
      expect((await authorizedArtifactWrites(f.task, f.repository.operations(f.task.id), [f.turn])).size).toBe(0)
    } finally { f.repository.close() }
  })
})
