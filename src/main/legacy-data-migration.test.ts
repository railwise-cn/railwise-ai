import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  migrateLegacyHomeDataDirs,
  migrateLegacyUserDataDir,
  rewriteLegacyPathsInSettingsFile,
  runLegacyDataImport,
  verifyImportedUserData,
  USER_DATA_MIGRATION_MARKER
} from './legacy-data-migration'

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'workwise-migration-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('legacy data import', () => {
  it('imports committed WAL state through the synchronous startup path and retains credential references', async () => {
    const root = await makeTempRoot()
    const source = join(root, 'WorkGPT')
    const target = join(root, 'RailWise AI')
    await mkdir(source)
    await writeFile(join(source, 'workgpt-settings.json'), JSON.stringify({ version: 1, credentialRef: 'keychain:synthetic' }))
    const database = new Database(join(source, 'History'))
    database.pragma('journal_mode=WAL')
    database.exec('CREATE TABLE task_history(id TEXT, status TEXT)')
    database.prepare('INSERT INTO task_history VALUES (?, ?)').run('synthetic', 'waiting_user')
    try {
      const result = migrateLegacyUserDataDir({ userDataPath: target })
      expect(result.outcome).toBe('imported')
      expect(result.files?.find(file => file.path === 'History')?.database).toBe(true)
      expect(verifyImportedUserData(target)).toBe(true)
      const copy = new Database(join(target, 'History'), { readonly: true, fileMustExist: true })
      try { expect(copy.prepare('SELECT * FROM task_history').get()).toEqual({ id: 'synthetic', status: 'waiting_user' }) }
      finally { copy.close() }
      expect(JSON.parse(await readFile(join(target, 'workgpt-settings.json'), 'utf8')).credentialRef).toBe('keychain:synthetic')
      expect(database.prepare('SELECT status FROM task_history').get()).toEqual({ status: 'waiting_user' })
      expect(migrateLegacyUserDataDir({ userDataPath: target }).outcome).toBe('target-exists')
    } finally { database.close() }
  })

  it('selects populated legacy home data and preserves conflicting namespace sources', async () => {
    const root = await makeTempRoot()
    await mkdir(join(root, '.kun', 'default_workspace'), { recursive: true })
    await mkdir(join(root, '.workgpt', 'default_workspace'), { recursive: true })
    await writeFile(join(root, '.workgpt', 'default_workspace', 'user.md'), 'user content')
    const first = migrateLegacyHomeDataDirs({ homeDir: root })
    expect(first.find(item => item.legacyPath === join(root, '.kun', 'default_workspace'))?.outcome).toBe('skipped-empty')
    expect(await readFile(join(root, '.workwise', 'default_workspace', 'user.md'), 'utf8')).toBe('user content')
    const conflictRoot = await makeTempRoot()
    for (const namespace of ['.kun', '.workgpt']) {
      await mkdir(join(conflictRoot, namespace, 'write_workspace'), { recursive: true })
      await writeFile(join(conflictRoot, namespace, 'write_workspace', 'draft.md'), namespace)
    }
    const conflicts = migrateLegacyHomeDataDirs({ homeDir: conflictRoot })
    expect(conflicts.filter(item => item.outcome === 'conflict')).toHaveLength(2)
    await expect(lstat(join(conflictRoot, '.workwise', 'write_workspace'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(conflictRoot, '.workgpt', 'write_workspace', 'draft.md'), 'utf8')).toBe('.workgpt')
  })
  it('copies user data into WorkWise without moving or linking the source', async () => {
    const appData = await makeTempRoot()
    const source = join(appData, 'WorkGPT')
    const target = join(appData, 'WorkWise')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'workgpt-settings.json'), '{"version":1}', 'utf8')

    const result = migrateLegacyUserDataDir({ userDataPath: target })

    expect(result).toMatchObject({ userDataPath: target, migrated: true, usedLegacyFallback: false, sourcePath: source })
    expect(await readFile(join(target, 'workgpt-settings.json'), 'utf8')).toBe('{"version":1}')
    expect((await lstat(source)).isDirectory()).toBe(true)
    expect((await lstat(source)).isSymbolicLink()).toBe(false)
    const marker = JSON.parse(await readFile(join(target, USER_DATA_MIGRATION_MARKER), 'utf8'))
    expect(marker).toMatchObject({ schema: 'workwise.migration', version: 2, sourcePath: source })
  })

  it('does not overwrite an existing WorkWise user data directory', async () => {
    const appData = await makeTempRoot()
    const target = join(appData, 'WorkWise')
    const source = join(appData, 'WorkGPT')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'current.txt'), 'current', 'utf8')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'legacy.txt'), 'legacy', 'utf8')

    expect(migrateLegacyUserDataDir({ userDataPath: target }).migrated).toBe(false)
    expect(await readFile(join(target, 'current.txt'), 'utf8')).toBe('current')
  })

  it.each(['WorkWise', 'workwise', 'RailWise AI', 'RailWise-AI', 'Railwise AI', 'railwise-ai'])('recognizes %s profiles and verifies copied file hashes without changing their source', async name => {
    const appData = await makeTempRoot()
    const source = join(appData, name)
    const target = join(appData, 'CurrentProfile')
    const settings = '{"schema":"workwise.settings","version":2,"revision":4}'
    await mkdir(join(source, 'credentials'), { recursive: true })
    await writeFile(join(source, 'workwise-settings.json'), settings)
    await writeFile(join(source, 'credentials', 'reference.json'), '{"credentialRef":"local-only"}')
    const result = migrateLegacyUserDataDir({ userDataPath: target })
    expect(result.outcome).toBe('imported')
    expect(result.files).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'workwise-settings.json', sha256: createHash('sha256').update(settings).digest('hex') })]))
    expect(verifyImportedUserData(target)).toBe(true)
    expect(await readFile(join(source, 'workwise-settings.json'), 'utf8')).toBe(settings)
    await writeFile(join(target, 'workwise-settings.json'), 'changed by user')
    expect(verifyImportedUserData(target)).toBe(false)
  })

  it('reports multiple valid profile sources without selecting, merging or copying either one', async () => {
    const appData = await makeTempRoot()
    for (const name of ['WorkWise', 'RailWise AI']) {
      await mkdir(join(appData, name))
      await writeFile(join(appData, name, 'workwise-settings.json'), JSON.stringify({ version: 1, workspaceRoot: name }))
    }
    const target = join(appData, 'CurrentProfile')
    const logs: unknown[] = []
    const result = migrateLegacyUserDataDir({ userDataPath: target, log: (...args) => logs.push(args) })
    expect(result).toMatchObject({ migrated: false, outcome: 'conflict', conflictPaths: expect.arrayContaining([join(appData, 'WorkWise'), join(appData, 'RailWise AI')]) })
    expect(await readdir(appData)).not.toContain('CurrentProfile')
    expect(logs).toHaveLength(1)
    expect(await readFile(join(appData, 'WorkWise', 'workwise-settings.json'), 'utf8')).toContain('WorkWise')
  })

  it('ignores empty, cache-only and malformed sources and keeps a verified previous migration receipt', async () => {
    const appData = await makeTempRoot()
    for (const name of ['WorkGPT', 'Kun']) await mkdir(join(appData, name))
    await writeFile(join(appData, 'WorkGPT', 'workgpt-settings.json'), '{ invalid')
    await writeFile(join(appData, 'Kun', 'cache.bin'), 'cache')
    const source = join(appData, 'RailWise AI')
    await mkdir(source)
    await writeFile(join(source, 'workwise-settings.json'), '{"version":1}')
    await writeFile(join(appData, 'outside.txt'), 'outside content stays outside')
    await symlink(join(appData, 'outside.txt'), join(source, 'external-reference'))
    await writeFile(join(source, USER_DATA_MIGRATION_MARKER), '{"historical":true}')
    const target = join(appData, 'CurrentProfile')
    expect(migrateLegacyUserDataDir({ userDataPath: target }).outcome).toBe('imported')
    expect(verifyImportedUserData(target)).toBe(true)
    expect((await lstat(join(target, 'external-reference'))).isSymbolicLink()).toBe(true)
    expect((await readdir(target)).includes('outside.txt')).toBe(false)
    expect(JSON.parse(await readFile(join(target, USER_DATA_MIGRATION_MARKER), 'utf8')).previousMarker).toBe('{"historical":true}')
  })

  it('deduplicates profile aliases without following external content during import', async () => {
    const appData = await makeTempRoot()
    const source = join(appData, 'WorkWise')
    await mkdir(source)
    await writeFile(join(source, 'workwise-settings.json'), '{"version":1}')
    await symlink(source, join(appData, 'RailWise AI'), 'dir')
    const target = join(appData, 'CurrentProfile')
    expect(migrateLegacyUserDataDir({ userDataPath: target }).outcome).toBe('imported')
    expect(verifyImportedUserData(target)).toBe(true)
  })

  it('copies known home data to WorkWise paths and preserves every source', async () => {
    const home = await makeTempRoot()
    await mkdir(join(home, '.kun', 'data'), { recursive: true })
    await writeFile(join(home, '.kun', 'data', 'db.sqlite'), 'db', 'utf8')
    await mkdir(join(home, '.deepseekgui', 'write_workspace'), { recursive: true })
    await writeFile(join(home, '.deepseekgui', 'write_workspace', 'draft.md'), 'draft', 'utf8')

    const results = migrateLegacyHomeDataDirs({ homeDir: home })

    expect(results.some((entry) => entry.outcome === 'imported')).toBe(true)
    expect(await readFile(join(home, '.workwise', 'runtime', 'db.sqlite'), 'utf8')).toBe('db')
    expect(await readFile(join(home, '.workwise', 'write_workspace', 'draft.md'), 'utf8')).toBe('draft')
    expect(await readFile(join(home, '.kun', 'data', 'db.sqlite'), 'utf8')).toBe('db')
    expect(results.every((entry) => entry.rewriteSafe === false)).toBe(true)
  })

  it('does not repeatedly import an intentionally empty home directory', async () => {
    const home = await makeTempRoot()
    await mkdir(join(home, '.kun', 'default_workspace'), { recursive: true })

    const first = migrateLegacyHomeDataDirs({ homeDir: home })
    const second = migrateLegacyHomeDataDirs({ homeDir: home })

    expect(first.find((entry) => entry.mapping.legacySegments.at(-1) === 'default_workspace')?.outcome).toBe('imported')
    expect(second.find((entry) => entry.mapping.legacySegments.at(-1) === 'default_workspace')?.outcome).toBe('target-exists')
  })

  it('never rewrites legacy settings files', async () => {
    const home = await makeTempRoot()
    const path = join(home, 'workgpt-settings.json')
    await writeFile(path, '{"workspaceRoot":"~/.kun/default_workspace"}', 'utf8')

    expect(rewriteLegacyPathsInSettingsFile()).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('{"workspaceRoot":"~/.kun/default_workspace"}')
  })

  it('runs idempotently and never requests a legacy userData fallback', async () => {
    const root = await makeTempRoot()
    const home = join(root, 'home')
    const appData = join(root, 'appData')
    await mkdir(join(appData, 'WorkGPT'), { recursive: true })
    await writeFile(join(appData, 'WorkGPT', 'workgpt-settings.json'), '{"version":1}', 'utf8')
    await mkdir(join(home, '.kun', 'data'), { recursive: true })
    await writeFile(join(home, '.kun', 'data', 'db.sqlite'), 'db', 'utf8')

    const first = runLegacyDataImport({ userDataPath: join(appData, 'WorkWise'), homeDir: home })
    const second = runLegacyDataImport({ userDataPath: join(appData, 'WorkWise'), homeDir: home })

    expect(first.userData).toMatchObject({ migrated: true, usedLegacyFallback: false })
    expect(second.userData).toMatchObject({ migrated: false, usedLegacyFallback: false })
    expect(first.settingsRewritten).toBe(false)
    expect(await readFile(join(home, '.workwise', 'runtime', 'db.sqlite'), 'utf8')).toBe('db')
  })
})
