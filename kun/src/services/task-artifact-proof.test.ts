import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
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
async function fixture(authorized = true, wait = false, toolName = 'write', requiredFormats?: string[]) {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-external-artifact-')); roots.push(temporary)
  const root = await realpath(temporary)
  const workspace = join(root, 'workspace'), destination = join(root, 'delivery')
  await Promise.all([mkdir(workspace), mkdir(destination)])
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
  const threadStore = new InMemoryThreadStore(), sessionStore = new InMemorySessionStore()
  const thread = createThreadRecord({ id: 'thread', title: 'Authorized artifact fixture', workspace, model: 'fixture' })
  await threadStore.upsert(thread)
  const nowIso = () => '2026-11-01T00:00:00.000Z'
  const controller = new TaskController({ repository, threadStore, sessionStore, nowIso,
    ...(wait ? { completionGuard: () => ({ reason: '需要审阅', fingerprint: 'review', retryable: false }) } : {}) })
  let task = controller.ensureTask({ thread, turnId: 'turn-1', request: { prompt: '请生成并交付 result.md Markdown 文件。' } })
  if (requiredFormats) {
    task = repository.update(task.id, task.revision, current => ({
      ...current,
      acceptance: { ...current.acceptance, requiredFormats }
    }), { key: 'required-formats', kind: 'task_updated', payload: {}, createdAt: nowIso() })
  }
  const grant = ExecutionGrantSchema.parse({ id: 'grant-1', taskId: task.id, threadId: thread.id, turnId: 'turn-1', workspaceRoot: workspace, workspaceTrust: 'workspace-write', agentTrust: 'workspace-write', approvalPolicy: 'auto', sandboxMode: 'workspace-write', allowedToolNames: [toolName], pathAllowlist: [workspace, destination], writePathAllowlist: authorized ? [workspace, destination] : [workspace], workspaceRevision: 1, agentRevision: 0, revision: 1, idempotencyKey: 'grant-1', issuedAt: nowIso() })
  const turn = { ...createTurnRecord({ id: 'turn-1', threadId: thread.id, prompt: task.goal }), executionGrant: grant }
  await threadStore.upsert({ ...thread, turns: [turn] })
  controller.beginAttempt(thread.id, turn.id)
  const path = join(destination, 'result.md'), content = '# External deliverable\n'
  const call = { callId: 'write-1', toolName, toolKind: 'file_change' as const, arguments: { path, content } }
  const operation = controller.beginToolOperation(turn.id, call, grant)!
  const output = authorized && toolName === 'write'
    ? await createWriteLocalTool().execute(call.arguments, { threadId: thread.id, turnId: turn.id, workspace, threadMode: 'agent', approvalPolicy: 'auto', sandboxMode: 'workspace-write', abortSignal: new AbortController().signal, awaitApproval: async () => 'allow', executionGrant: grant })
    : { output: toolName === 'ppt_master_export'
      ? { ok: true, generatedFiles: [{ name: 'result.md', path: '../delivery/result.md', relativePath: '../delivery/result.md', absolutePath: path, sha256: createHash('sha256').update(content).digest('hex') }] }
      : { path, sha256: createHash('sha256').update(content).digest('hex') } }
  if (!authorized || toolName === 'ppt_master_export') await writeFile(path, content)
  if (toolName === 'ppt_master_export' && requiredFormats?.includes('pptx')) {
    const pptxPath = join(destination, 'result.pptx')
    const pptx = new JSZip()
    pptx.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
    pptx.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>')
    pptx.file('ppt/presentation.xml', '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>')
    pptx.file('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>')
    pptx.file('ppt/slides/slide1.xml', '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree/></p:cSld></p:sld>')
    const bytes = await pptx.generateAsync({ type: 'nodebuffer' })
    await writeFile(pptxPath, bytes)
    const files = (output.output as { generatedFiles: Array<Record<string, unknown>> }).generatedFiles
    files.push({ name: 'result.pptx', path: '../delivery/result.pptx', relativePath: '../delivery/result.pptx',
      absolutePath: pptxPath, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
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

  it('accepts a PPT Master export only from its successful immutable write receipt', async () => {
    const f = await fixture(true, false, 'ppt_master_export')
    try {
      const decision = await f.controller.assessCandidate(f.thread.id, f.turn.id)
      expect(decision.kind).toBe('completed')
      expect(decision.task.artifacts).toMatchObject([{ relativePath: 'result.md', absolutePath: f.path,
        authorizedRoot: f.destination, executionGrantId: f.grant.id, validation: 'valid' }])
    } finally { f.repository.close() }
  })

  it('validates intermediate project files by their own format while requiring a valid PPTX deliverable', async () => {
    const f = await fixture(true, false, 'ppt_master_export', ['pptx'])
    try {
      const decision = await f.controller.assessCandidate(f.thread.id, f.turn.id)
      expect(decision.kind).toBe('completed')
      expect(decision.task.artifacts).toMatchObject([
        { relativePath: 'result.md', format: 'md', validation: 'valid' },
        { relativePath: 'result.pptx', format: 'pptx', validation: 'valid' }
      ])
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
