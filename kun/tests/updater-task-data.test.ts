import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileThreadStore, FileSessionStore } from '../src/adapters/file/index.js'
import { createThreadRecord } from '../src/domain/thread.js'
import { createTurnRecord } from '../src/domain/turn.js'
import { makeUserItem } from '../src/domain/item.js'
import { TaskRunRepository } from '../src/services/task-run-repository.js'
import { buildDocumentDeliveryToolProviders } from '../src/adapters/tool/document-delivery-tool-provider.js'

const script = new URL('../../scripts/updater-task-data.mjs', import.meta.url).href
const { exerciseUpdaterTaskData } = await import(script)

describe('exact-package updater Task and draft preservation fixture', () => {
  it('seeds real SQLite and candidate tools, then reopens twice with paused/waiting inputs and draft intact', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-updater-task-data-')))
    const workspace = join(root, 'workspace')
    const stored = () => ({ threadStore: new FileThreadStore({ dataDir: root }), sessionStore: new FileSessionStore({ dataDir: root }), createThreadRecord, createTurnRecord, makeUserItem })
    let repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
    try {
      const seed = await exerciseUpdaterTaskData({ ...stored(), mode: 'seed', repository, buildProviders: buildDocumentDeliveryToolProviders, workspace })
      expect(seed.evidence).toMatchObject({ status: 'passed', taskStates: ['paused', 'waiting_user'], pendingInputs: 2, pendingQuestions: 1, drafts: 1 })
      const baseline = JSON.parse(JSON.stringify(seed.snapshot))
      for (let reopen = 0; reopen < 2; reopen++) {
        repository.close()
        repository = new TaskRunRepository(join(root, 'tasks.sqlite3'))
        const verified = await exerciseUpdaterTaskData({ ...stored(), mode: 'verify', repository, buildProviders: buildDocumentDeliveryToolProviders, workspace, baseline })
        expect(verified.evidence).toEqual(seed.evidence)
      }
      const draftPath = join(workspace, baseline.candidate.result.path)
      const draft = await readFile(draftPath)
      await writeFile(draftPath, 'unexpected replacement')
      await expect(exerciseUpdaterTaskData({ ...stored(), mode: 'verify', repository, buildProviders: buildDocumentDeliveryToolProviders, workspace, baseline })).rejects.toThrow()
      await writeFile(draftPath, draft)
      const waiting = repository.get('updater-waiting-task')!
      repository.update(waiting.id, waiting.revision, current => ({ ...current, status: 'completed' }))
      await expect(exerciseUpdaterTaskData({ ...stored(), mode: 'verify', repository, buildProviders: buildDocumentDeliveryToolProviders, workspace, baseline })).rejects.toThrow()
    } finally { repository.close(); await rm(root, { recursive: true, force: true }) }
  })
})
