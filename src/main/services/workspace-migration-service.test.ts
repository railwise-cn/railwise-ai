import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceMigrationService } from './workspace-migration-service'
import Database from 'better-sqlite3'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function home(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'railwise-workspace-migration-')); roots.push(root); return root }

describe('WorkspaceMigrationService', () => {
  it.each(['.workgpt', '.workwise', '.kun', '.deepseekgui'])('imports a consistent live WAL database and preserves plugin, MCP, Skill and credential references from %s', async namespace => {
    const root = await home()
    const source = join(root, namespace, 'default_workspace')
    await mkdir(join(source, '.workwise', 'skills', 'custom'), { recursive: true })
    const files = {
      '.workwise/plugins.json': JSON.stringify({ plugins: [{ id: 'synthetic-custom', enabled: true, source: 'local' }] }),
      '.workwise/mcp.json': JSON.stringify({ servers: [{ id: 'synthetic-mcp', credentialRef: 'keychain:synthetic-reference' }] }),
      '.workwise/skills/custom/SKILL.md': '# 用户技能\n保留用户原文。',
      'draft.md': '# 用户草稿\n原始资料。'
    }
    for (const [path, content] of Object.entries(files)) await writeFile(join(source, path), content)
    const databasePath = join(source, 'tasks.sqlite3')
    const database = new Database(databasePath)
    database.pragma('journal_mode=WAL')
    database.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, state TEXT)')
    database.prepare('INSERT INTO tasks VALUES (?, ?)').run('synthetic-task', 'waiting_user')
    try {
      const service = new WorkspaceMigrationService({ home: root, stateRoot: join(root, 'migration-state') })
      const item = (await service.scan()).entries.find(entry => entry.id === `${namespace}:default`)!
      expect(item.status).toBe('populated')
      const request = { sourceId: item.id, expectedFingerprint: item.fingerprint!, confirmed: true, idempotencyKey: 'with-live-database' }
      const result = await service.importSnapshot(request)
      expect(result).toMatchObject({ status: 'completed', fileCount: 5 })
      const copied = new Database(join(result.snapshotPath, 'tasks.sqlite3'), { readonly: true, fileMustExist: true })
      try {
        expect(copied.pragma('quick_check', { simple: true })).toBe('ok')
        expect(copied.prepare('SELECT * FROM tasks').get()).toEqual({ id: 'synthetic-task', state: 'waiting_user' })
      } finally { copied.close() }
      for (const [path, content] of Object.entries(files)) {
        expect(await readFile(join(source, path), 'utf8')).toBe(content)
        expect(await readFile(join(result.snapshotPath, path), 'utf8')).toBe(content)
      }
      expect(database.prepare('SELECT state FROM tasks').get()).toEqual({ state: 'waiting_user' })
      expect(await service.importSnapshot(request)).toEqual(result)
      database.prepare('UPDATE tasks SET state = ?').run('paused')
      await expect(service.importSnapshot({ ...request, idempotencyKey: 'stale-database' })).rejects.toMatchObject({ code: 'source_version_conflict' })
    } finally { database.close() }
  })
  it('reports the four namespaces, verified directory aliases, identical copies and conflicting content', async () => {
    const root = await home()
    const current = join(root, '.workwise', 'default_workspace')
    await mkdir(current, { recursive: true })
    await writeFile(join(current, 'brief.md'), '# same\n')
    await mkdir(join(root, '.workgpt'), { recursive: true })
    await symlink(current, join(root, '.workgpt', 'default_workspace'), 'dir')
    const identical = join(root, '.kun', 'default_workspace')
    await mkdir(identical, { recursive: true })
    await writeFile(join(identical, 'brief.md'), '# same\n')
    const conflict = join(root, '.deepseekgui', 'default_workspace')
    await mkdir(conflict, { recursive: true })
    await writeFile(join(conflict, 'brief.md'), '# different\n')
    const service = new WorkspaceMigrationService({ home: root, stateRoot: join(root, '.workwise', 'migrations', 'workspaces') })

    const report = await service.scan()
    expect(await service.aliases()).toEqual([{ path: join(root, '.workgpt', 'default_workspace'), canonicalRoot: current }])
    expect(report.entries).toHaveLength(12)
    expect(report.entries.find(entry => entry.id === '.workgpt:default')).toMatchObject({ status: 'populated', aliasOf: '.workwise:default' })
    expect(report.entries.find(entry => entry.id === '.kun:default')).toMatchObject({ status: 'populated', identicalTo: '.workwise:default', aliasOf: undefined })
    expect(report.entries.find(entry => entry.id === '.deepseekgui:default')).toMatchObject({ status: 'populated', conflictWith: expect.arrayContaining(['.workwise:default']) })
  })

  it('rechecks aliases after a symlink is replaced by an independent workspace', async () => {
    const root = await home()
    const current = join(root, '.workwise', 'default_workspace')
    const legacy = join(root, '.workgpt', 'default_workspace')
    await mkdir(current, { recursive: true })
    await mkdir(join(root, '.workgpt'), { recursive: true })
    await symlink(current, legacy, 'dir')
    const service = new WorkspaceMigrationService({ home: root, stateRoot: join(root, 'state') })
    expect(await service.aliases()).toHaveLength(1)
    await rm(legacy)
    await mkdir(legacy)
    await writeFile(join(legacy, 'user.md'), 'independent content')
    expect(await service.aliases()).toEqual([])
  })

  it('creates an exclusive, hash-verified copy, preserves originals, and replays the same receipt', async () => {
    const root = await home()
    const source = join(root, '.workgpt', 'write_workspace')
    await mkdir(join(source, 'nested'), { recursive: true })
    await writeFile(join(source, 'nested', 'note.md'), 'local draft')
    const stateRoot = join(root, 'state')
    const service = new WorkspaceMigrationService({ home: root, stateRoot })
    const item = (await service.scan()).entries.find(entry => entry.id === '.workgpt:write')!
    const request = { sourceId: item.id, expectedFingerprint: item.fingerprint!, confirmed: true, idempotencyKey: 'snapshot-1' }

    const result = await service.importSnapshot(request)
    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ status: 'completed', fileCount: 1 })
    expect(await readFile(join(result.snapshotPath, 'nested', 'note.md'), 'utf8')).toBe('local draft')
    expect(await readFile(join(source, 'nested', 'note.md'), 'utf8')).toBe('local draft')
    expect(await service.importSnapshot(request)).toEqual(result)
    await expect(service.importSnapshot({ ...request, sourceId: '.workgpt:default' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('rejects stale fingerprints and never overwrites an interrupted destination', async () => {
    const root = await home()
    const source = join(root, '.workwise', 'default_workspace')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'draft.md'), 'before')
    const stateRoot = join(root, 'state')
    const service = new WorkspaceMigrationService({ home: root, stateRoot })
    const entry = (await service.scan()).entries.find(item => item.id === '.workwise:default')!
    await writeFile(join(source, 'draft.md'), 'after')
    await expect(service.importSnapshot({ sourceId: entry.id, expectedFingerprint: entry.fingerprint!, confirmed: true, idempotencyKey: 'stale' })).rejects.toMatchObject({ code: 'source_version_conflict' })

    const interruptedKey = 'snapshot-interrupted'
    const operationHash = createHash('sha256').update(interruptedKey).digest('hex')
    await mkdir(join(stateRoot, 'imports', operationHash), { recursive: true })
    const fresh = (await service.scan()).entries.find(item => item.id === '.workwise:default')!
    const result = await service.importSnapshot({ sourceId: fresh.id, expectedFingerprint: fresh.fingerprint!, confirmed: true, idempotencyKey: interruptedKey })
    expect(result.status).toBe('outcome_unknown')
    expect(await readFile(join(source, 'draft.md'), 'utf8')).toBe('after')
  })

  it('blocks links, special files, and invalid databases while preserving sources', async () => {
    const root = await home()
    const database = join(root, '.kun', 'default_workspace')
    await mkdir(database, { recursive: true })
    await writeFile(join(database, 'tasks.sqlite3'), 'database')
    const linked = join(root, '.deepseekgui', 'write_workspace')
    await mkdir(join(root, 'outside'))
    await mkdir(join(root, '.deepseekgui'), { recursive: true })
    await symlink(join(root, 'outside'), linked, 'dir')
    const service = new WorkspaceMigrationService({ home: root, stateRoot: join(root, 'state') })
    const report = await service.scan()
    expect(report.entries.find(entry => entry.id === '.kun:default')).toMatchObject({ status: 'blocked', reason: expect.stringContaining('Database consistent backup failed') })
    expect(report.entries.find(entry => entry.id === '.deepseekgui:write')).toMatchObject({ status: 'blocked', reason: expect.stringContaining('link') })

    const outsideLink = join(root, '.workgpt', 'default_workspace')
    await mkdir(join(root, '.workgpt'), { recursive: true })
    await symlink(join(root, 'outside'), outsideLink, 'dir')
    expect((await service.scan()).entries.find(entry => entry.id === '.workgpt:default')).toMatchObject({ status: 'blocked', reason: expect.stringContaining('outside the recognized') })
  })
})
