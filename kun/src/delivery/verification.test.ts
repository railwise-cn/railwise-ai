import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TaskRun } from '../contracts/tasks.js'
import { TaskRunRepository } from '../services/task-run-repository.js'
import { verifyTaskDelivery } from './verification.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
describe('task delivery final version verification', () => {
  it('keeps old candidate evidence but requires exports only for its explicit replacement, and detects changed output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-delivery-version-'))
    const repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
    const task: TaskRun = { id: 'task', threadId: 'thread', childTaskIds: [], templateId: 'research-document', workspaceRoot: root, goal: '合成研究', status: 'running', agentId: 'document-delivery', acceptance: { kind: 'files', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: true }, budget: { maxAttempts: 3, maxDurationMs: 60000 }, attempts: 1, replans: 0, noProgressCount: 0, nodes: [], artifacts: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), revision: 0 }
    repository.create(task)
    const receipt = (key: string, kind: string, request: Record<string, unknown>, result: unknown) => { repository.beginOperation({ ownerId: task.id, idempotencyKey: key, kind, request, nowIso: task.createdAt }); repository.finishOperation(task.id, key, { status: 'succeeded', result }, task.updatedAt) }
    try {
      await writeFile(join(root, 'draft.md'), '# 合成\n旧正文')
      await writeFile(join(root, 'draft-v2.md'), '# 合成\n新正文')
      receipt('draft', 'document_candidate', {}, { path: 'draft.md', candidateHash: sha('# 合成\n旧正文'), sources: [] })
      receipt('draft-v2', 'document_candidate', {}, { path: 'draft-v2.md', candidateHash: sha('# 合成\n新正文'), sources: [], supersedesCandidatePath: 'draft.md', supersedesCandidateHash: sha('# 合成\n旧正文') })
      expect(verifyTaskDelivery(repository, { ...task, deliveryFormats: ['md'] })).toMatchObject({ complete: true, files: [{ path: 'draft-v2.md', format: 'md' }] })
      expect(verifyTaskDelivery(repository, task).complete).toBe(false)
      expect(verifyTaskDelivery(repository, { ...task, deliveryFormats: ['md', 'docx'] }).complete).toBe(false)
      for (const format of ['docx', 'pdf']) {
        const bytes = `synthetic ${format} receipt fixture, not a renderer test`
        await writeFile(join(root, `draft-v2.${format}`), bytes)
        receipt(format, 'document_export', { format, expectedHash: sha('# 合成\n新正文'), sourcePath: join(root, 'draft-v2.md') }, { status: 'exported', path: `draft-v2.${format}`, sha256: sha(bytes) })
      }
      expect(verifyTaskDelivery(repository, task)).toMatchObject({ complete: true, reasons: [], files: [{ path: 'draft-v2.md', format: 'md' }, { path: 'draft-v2.docx', format: 'docx' }, { path: 'draft-v2.pdf', format: 'pdf' }] })
      expect(repository.operation(task.id, 'draft')?.status).toBe('succeeded')
      await writeFile(join(root, 'draft-v2.docx'), 'external edit')
      expect(verifyTaskDelivery(repository, task).complete).toBe(false)
    } finally { repository.close(); await rm(root, { recursive: true, force: true }) }
  })
})
