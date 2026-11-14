import Database from 'better-sqlite3'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import type { TaskCheckpoint, TaskRun } from '../src/contracts/tasks.js'

type LegacyFixture = {
  provenance: { version: string; sourceHead: string; asarSha256: string; synthetic: boolean }
  userVersion: number
  tables: Array<{ name: string; sql: string; rows: Array<Record<string, string | number | null>> }>
  indexes: string[]
  files: Record<string, string>
  expected: { threadId: string; task: TaskRun; inputId: string; checkpoint: TaskCheckpoint; session: { id: string }; operations: unknown[] }
}

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.unstubAllGlobals()
})

it('reads the released 0.5.6 SQLite and thread files through the current Runtime twice without resuming paused work', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'railwise-v056-upgrade-'))
  cleanup.push(() => rm(temporary, { recursive: true, force: true }))
  const root = await realpath(temporary)
  const raw = await readFile(new URL('./fixtures/v056-runtime-profile.json', import.meta.url), 'utf8')
  // Forward slashes also work on Windows and remain valid inside the fixture's
  // nested JSON/JSONL strings without changing their escaping depth.
  const fixtureRoot = root.replaceAll('\\', '/')
  const fixture = JSON.parse(raw.replaceAll('__RAILWISE_V056_ROOT__', JSON.stringify(fixtureRoot).slice(1, -1))) as LegacyFixture
  expect(fixture.provenance).toMatchObject({ version: '0.5.6', sourceHead: 'ce5b00cc41c3a53144144c85ecc772efe5872718', synthetic: true })
  const dataDir = join(root, 'runtime')
  await mkdir(dataDir)
  await mkdir(fixture.expected.task.workspaceRoot)
  const database = new Database(join(dataDir, 'tasks.sqlite3'))
  try {
    // This snapshot was written by the exact released app. Keep its DDL and
    // stored rows intact so current constructors actually exercise old readers.
    database.transaction(() => {
      database.pragma('defer_foreign_keys = ON')
      for (const table of fixture.tables) database.exec(table.sql)
      for (const table of fixture.tables) {
        for (const row of table.rows) {
          const columns = Object.keys(row)
          database.prepare(`INSERT INTO "${table.name}" (${columns.map(name => `"${name}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row))
        }
      }
      for (const index of fixture.indexes) database.exec(index)
      database.pragma(`user_version = ${fixture.userVersion}`)
    })()
    expect(database.pragma('quick_check', { simple: true })).toBe('ok')
    expect(database.pragma('foreign_key_check')).toEqual([])
  } finally { database.close() }
  for (const [name, contents] of Object.entries(fixture.files)) {
    const path = join(dataDir, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents)
  }
  const network = vi.fn(() => { throw new Error('Synthetic upgrade fixture forbids external calls') })
  vi.stubGlobal('fetch', network)
  for (let restart = 0; restart < 2; restart++) {
    const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir, runtimeToken: 'synthetic-fixture',
      apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', model: 'synthetic-no-model', approvalPolicy: 'auto', sandboxMode: 'read-only',
      tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
    try {
      const repository = runtime.taskRepository!
      expect(repository.get(fixture.expected.task.id)).toEqual(fixture.expected.task)
      expect(repository.latestCheckpoint(fixture.expected.task.id)).toEqual(fixture.expected.checkpoint)
      expect(repository.operations(fixture.expected.task.id)).toEqual(fixture.expected.operations)
      expect(repository.execution.sessionForTask(fixture.expected.task.id)).toEqual(fixture.expected.session)
      expect(repository.execution.pending(fixture.expected.session.id)).toMatchObject([{ inputId: fixture.expected.inputId, status: 'queued' }])
      const inputs = repository.inputs(fixture.expected.task.id, true)
      expect(inputs).toMatchObject([{ id: fixture.expected.inputId, kind: 'supplement' }])
      expect(inputs[0]?.consumedAt).toBeUndefined()
      const thread = await runtime.threadService.get(fixture.expected.threadId)
      expect(thread).toMatchObject({ title: '0.5.6 合成历史', workspace: fixture.expected.task.workspaceRoot, turns: [] })
      const status = await runtime.taskCoordinator!.command({ threadId: fixture.expected.threadId, taskId: fixture.expected.task.id,
        idempotencyKey: `upgrade-status-${restart}`, request: { prompt: '现在做到哪了' } })
      expect(status.kind).toBe('snapshot')
      expect(repository.get(fixture.expected.task.id)?.status).toBe('paused')
      expect((await runtime.threadService.get(fixture.expected.threadId))?.turns).toHaveLength(0)
      expect(network).not.toHaveBeenCalled()
    } finally { await runtime.shutdown?.() }
  }
})
