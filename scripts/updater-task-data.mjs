import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sha = value => createHash('sha256').update(value).digest('hex')

/** Uses the selected baseline/target services supplied by the packaged Electron fixture. */
export async function exerciseUpdaterTaskData({ mode, repository, buildProviders, workspace, baseline, threadStore, sessionStore, createThreadRecord, createTurnRecord, makeUserItem }) {
  const taskIds = ['updater-paused-task', 'updater-waiting-task']
  const sourcePath = join(workspace, 'updater-source.md')
  const targetPath = join(workspace, 'updater-report.md')
  if (mode === 'seed') {
    assert.equal(repository.list({ limit: 1 }).length, 0, 'Task fixture must start in an empty store')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(sourcePath, '# 合成来源\n更新验收的固定资料。\n', { flag: 'wx' })
    writeFileSync(targetPath, '# 原始文档\n保留用户编辑内容。\n', { flag: 'wx' })
    const now = '2026-11-11T00:00:00.000Z'
    for (const id of taskIds) repository.create({ id, threadId: `${id}-thread`, activeTurnId: `${id}-turn`, childTaskIds: [], workspaceRoot: workspace,
      goal: '合成更新资料保留验收', status: 'running', agentId: 'general',
      acceptance: { kind: 'answer', requiredNodeKinds: ['deliver'], requireFinalResponse: true, requireActionableArtifactCard: false },
      budget: { maxAttempts: 8, maxDurationMs: 1_800_000 }, attempts: 1, replans: 0, noProgressCount: 0,
      nodes: [{ id: `${id}-node`, taskId: id, kind: 'deliver', title: '交付草稿', status: 'pending', dependsOn: [], attempt: 0, maxAttempts: 8, idempotencyKey: `${id}-node`, evidence: [], revision: 0 }],
      artifacts: [], createdAt: now, updatedAt: now, revision: 0 })
    for (const id of taskIds) {
      const task = repository.get(id)
      const thread = createThreadRecord({ id: task.threadId, title: task.goal, workspace, model: 'synthetic-offline', createdAt: now })
      thread.turns = [createTurnRecord({ id: task.activeTurnId, threadId: task.threadId, prompt: task.goal, status: 'aborted', createdAt: now })]
      await threadStore.upsert(thread)
      await sessionStore.appendItem(thread.id, makeUserItem({ id: `${id}-request`, threadId: thread.id, turnId: task.activeTurnId, text: task.goal }))
    }
    const waiting = repository.get(taskIds[1])
    const propose = buildProviders(repository).flatMap(provider => provider.tools).find(tool => tool.name === 'propose_document')
    assert.ok(propose, 'Selected package must provide its real document candidate tool')
    const proposed = await propose.execute({ path: 'report.md', content: '# 待审草稿\n根据固定来源生成的合成候选正文。\n', target_path: 'updater-report.md',
      source_refs: [{ path: 'updater-source.md' }], idempotency_key: 'updater-draft' }, {
      threadId: waiting.threadId, turnId: waiting.activeTurnId, workspace, approvalPolicy: 'auto', sandboxMode: 'workspace-write',
      abortSignal: new AbortController().signal, awaitApproval: async () => 'deny'
    })
    assert.equal(proposed.isError, undefined)
    assert.equal(proposed.output.status, 'candidate')
    for (const id of taskIds) {
      const task = repository.get(id)
      repository.appendInput({ taskId: id, expectedRevision: task.revision, idempotencyKey: `queued-${id}`, kind: 'supplement', text: '重启后仍待处理的补充要求', nowIso: now })
    }
    const paused = repository.get(taskIds[0])
    repository.update(paused.id, paused.revision, current => ({ ...current, status: 'paused', waitingReason: '用户暂停', updatedAt: now }))
    repository.saveHumanRequest({ id: 'updater-question', kind: 'question', threadId: waiting.threadId, turnId: waiting.activeTurnId,
      message: '请选择交付范围', payload: { input: { id: 'updater-question', threadId: waiting.threadId, turnId: waiting.activeTurnId, itemId: 'updater-question-item', prompt: '请选择交付范围', questions: [] } },
      status: 'pending', createdAt: now, updatedAt: now })
  }
  const tasks = taskIds.map(id => repository.get(id))
  assert.deepEqual(tasks.map(task => task?.status), ['paused', 'waiting_user'])
  const threads = await Promise.all(tasks.map(task => threadStore.get(task.threadId)))
  const messages = await Promise.all(tasks.map(task => sessionStore.loadItems(task.threadId)))
  assert.deepEqual(threads.map(thread => thread?.turns.length), [1, 1])
  assert.deepEqual(messages.map(items => items.length), [1, 1])
  const candidate = repository.operations(taskIds[1], 'document_candidate').find(operation => operation.idempotencyKey === 'updater-draft')
  assert.equal(candidate?.status, 'succeeded')
  const candidatePath = join(workspace, candidate.result.path)
  assert.ok(existsSync(candidatePath))
  const draft = readFileSync(candidatePath)
  const metadata = JSON.parse(readFileSync(`${candidatePath}.sources.json`, 'utf8'))
  assert.equal(metadata.taskId, taskIds[1])
  assert.equal(metadata.candidateHash, sha(draft))
  assert.equal(metadata.baseline.revision.fingerprint, sha(readFileSync(targetPath)))
  assert.equal(metadata.sources[0].sha256, sha(readFileSync(sourcePath)))
  assert.equal(repository.humanRequest('updater-question')?.status, 'pending')
  const inputs = taskIds.map(id => repository.inputs(id, true))
  assert.deepEqual(inputs.map(items => items.length), [1, 1])
  assert.ok(inputs.flat().every(input => !input.consumedAt))
  const snapshot = { tasks, inputs, threads, messages, question: repository.humanRequest('updater-question'), candidate,
    files: { draft: sha(draft), metadata: sha(readFileSync(`${candidatePath}.sources.json`)), source: sha(readFileSync(sourcePath)), target: sha(readFileSync(targetPath)) } }
  if (mode !== 'seed') assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), baseline, 'Paused/waiting tasks, pending inputs and draft must remain unchanged')
  return { snapshot, evidence: { status: 'passed', taskStates: ['paused', 'waiting_user'], pendingInputs: 2, pendingQuestions: 1,
    drafts: 1, readableThreads: 2, preservedMessages: 2, draftSha256: snapshot.files.draft, baselineSha256: snapshot.files.target, candidateReceiptStatus: candidate.status,
    scope: 'Selected package TaskRunRepository and real document candidate tool, reopened in independent packaged Electron processes; no model request or external operation.' } }
}
