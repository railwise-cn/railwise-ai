import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { WorkspaceImportRequest, WorkspaceImportResult, WorkspaceMigrationEntry, WorkspaceMigrationReport, WorkspaceNamespace } from '../../shared/workspace-migration'
import { atomicWriteFile, runSerialized } from './durable-file'

const NAMESPACES: WorkspaceNamespace[] = ['.workwise', '.workgpt', '.kun', '.deepseekgui']
const WORKSPACES = [{ kind: 'default', directory: 'default_workspace' }, { kind: 'write', directory: 'write_workspace' }, { kind: 'claw', directory: 'claw' }] as const
const MAX_FILES = 20_000
const MAX_BYTES = 512 * 1024 * 1024

type InventoryFile = { path: string; size: number; hash: string; ino: number; dev: number; mtimeMs: number }
type Inventory = { files: InventoryFile[]; directories: string[]; bytes: number; fingerprint: string }
type ImportReceipt = { requestHash: string; state: 'prepared' | 'complete' | 'failed'; result: WorkspaceImportResult }

/** Explicit, non-destructive snapshots only. It never moves, overwrites or rewrites source paths. */
export class WorkspaceMigrationService {
  private readonly home: string
  private readonly stateRoot: string
  constructor(options: { home?: string; stateRoot?: string } = {}) {
    this.home = resolve(options.home ?? homedir())
    this.stateRoot = resolve(options.stateRoot ?? join(this.home, '.workwise', 'migrations', 'workspaces'))
  }

  /** Cheap identity check for navigation; never hash documents or infer aliases from names. */
  async aliases(): Promise<WorkspaceMigrationReport['aliases']> {
    const aliases: WorkspaceMigrationReport['aliases'] = []
    const knownPaths = new Set(NAMESPACES.flatMap(namespace => WORKSPACES.map(workspace => canonicalPath(join(this.home, namespace, workspace.directory)))))
    for (const namespace of NAMESPACES) for (const workspace of WORKSPACES) {
      const path = join(this.home, namespace, workspace.directory)
      try {
        const canonicalRoot = canonicalPath(await realpath(path))
        if (canonicalRoot !== canonicalPath(path) && knownPaths.has(canonicalRoot)) aliases.push({ path, canonicalRoot })
      } catch { /* Unavailable paths remain visible as historical entries, never hidden. */ }
    }
    return aliases
  }

  async scan(): Promise<WorkspaceMigrationReport> {
    const entries: WorkspaceMigrationEntry[] = []
    const knownPaths = new Set(NAMESPACES.flatMap(namespace => WORKSPACES.map(workspace => canonicalPath(resolve(this.home, namespace, workspace.directory)))))
    for (const namespace of NAMESPACES) for (const workspace of WORKSPACES) {
      const path = join(this.home, namespace, workspace.directory)
      const entry: WorkspaceMigrationEntry = { id: `${namespace}:${workspace.kind}`, namespace, kind: workspace.kind, path, status: 'missing', fileCount: 0, bytes: 0, conflictWith: [] }
      try {
        const pathInfo = await lstat(path)
        entry.canonicalRoot = canonicalPath(await realpath(path))
        if (pathInfo.isSymbolicLink() && !knownPaths.has(entry.canonicalRoot)) throw coded('migration_unsafe_entry', 'Workspace root is a link to a directory outside the recognized legacy workspace matrix.')
        const inventory = await inventoryTree(entry.canonicalRoot)
        entry.status = inventory.files.length || inventory.directories.length ? 'populated' : 'empty'
        entry.fileCount = inventory.files.length
        entry.bytes = inventory.bytes
        entry.fingerprint = inventory.fingerprint
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { entry.status = 'blocked'; entry.reason = message(error) }
      }
      entries.push(entry)
    }
    for (const entry of entries) {
      if (!entry.fingerprint) continue
      const earlier = entries.slice(0, entries.indexOf(entry))
      entry.aliasOf = earlier.find(other => other.canonicalRoot === entry.canonicalRoot && other.fingerprint === entry.fingerprint)?.id
      // Byte-identical independent directories are reported, but never hidden as aliases.
      entry.identicalTo = earlier.find(other => other.kind === entry.kind && other.canonicalRoot !== entry.canonicalRoot && other.fingerprint === entry.fingerprint)?.id
      entry.conflictWith = entries.filter(other => other.id !== entry.id && other.kind === entry.kind && other.status === 'populated' && entry.status === 'populated' && other.fingerprint !== entry.fingerprint).map(other => other.id)
    }
    return { schema: 'railwise.workspace-migration', version: 1, checkedAt: new Date().toISOString(), entries, aliases: entries.filter(entry => entry.aliasOf && entry.canonicalRoot).map(entry => ({ path: entry.path, canonicalRoot: entry.canonicalRoot! })) }
  }

  async importSnapshot(request: WorkspaceImportRequest): Promise<WorkspaceImportResult> {
    if (!request.confirmed) throw coded('approval_required', 'Import requires explicit confirmation; original directories will be preserved.')
    const key = digest(request.idempotencyKey)
    return runSerialized(`workspace-import:${this.stateRoot}:${key}`, async () => {
      const requestHash = digest(JSON.stringify({ sourceId: request.sourceId, expectedFingerprint: request.expectedFingerprint }))
      const operationRoot = join(this.stateRoot, 'imports', key)
      const logPath = join(this.stateRoot, 'receipts', `${key}.json`)
      const snapshotPath = join(operationRoot, 'workspace')
      let prior: ImportReceipt | undefined
      try { prior = JSON.parse(await readFile(logPath, 'utf8')) as ImportReceipt } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw coded('migration_receipt_unreadable', 'The previous import receipt is unreadable; inspect it before retrying.') }
      if (prior) {
        if (prior.requestHash !== requestHash) throw coded('idempotency_conflict', 'This migration key belongs to a different request.')
        if (prior.state === 'complete' || prior.state === 'failed') return prior.result
        // A crash may have happened after copying but before recording completion.
        // Never overwrite or recopy an incomplete destination automatically.
        return { ...prior.result, status: 'outcome_unknown', error: 'A previous snapshot was interrupted. Originals and partial snapshot are preserved for verification.' }
      }
      const source = (await this.scan()).entries.find(entry => entry.id === request.sourceId)
      if (!source?.canonicalRoot || !source.fingerprint || source.status === 'blocked') throw coded('migration_source_unavailable', 'The selected legacy workspace is unavailable or contains unsupported entries.')
      if (source.fingerprint !== request.expectedFingerprint) throw coded('source_version_conflict', 'Workspace content changed after inspection. Scan again before importing.')
      if (inside(source.canonicalRoot, this.stateRoot)) throw coded('migration_destination_overlap', 'The snapshot directory must not be inside the source workspace.')
      const before = await inventoryTree(source.canonicalRoot)
      if (before.fingerprint !== request.expectedFingerprint) throw coded('source_version_conflict', 'Workspace content changed before snapshot preparation.')
      const result: WorkspaceImportResult = { operationId: key, status: 'outcome_unknown', sourcePath: source.path, sourceFingerprint: before.fingerprint, snapshotPath, logPath, fileCount: before.files.length, bytes: before.bytes }
      await mkdir(dirname(operationRoot), { recursive: true })
      try {
        await mkdir(operationRoot)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        return { ...result, error: 'The destination already exists without a matching completion receipt. It is preserved for verification.' }
      }
      await atomicWriteFile(logPath, JSON.stringify({ requestHash, state: 'prepared', result } satisfies ImportReceipt))
      try {
        // Exclusive operation directory creation above protects concurrent
        // runtimes and interrupted copies from being overwritten.
        await mkdir(snapshotPath)
        for (const directory of before.directories) await mkdir(join(snapshotPath, directory), { recursive: true })
        for (const file of before.files) await copyVerified(source.canonicalRoot, snapshotPath, file)
        const after = await inventoryTree(source.canonicalRoot)
        const copied = await inventoryTree(snapshotPath)
        if (after.fingerprint !== before.fingerprint || copied.fingerprint !== before.fingerprint) throw coded('source_version_conflict', 'Source changed during snapshot or the copied fingerprint did not match.')
        result.status = 'completed'
        await atomicWriteFile(logPath, JSON.stringify({ requestHash, state: 'complete', result } satisfies ImportReceipt))
      } catch (error) {
        result.status = 'failed'; result.error = message(error)
        await atomicWriteFile(logPath, JSON.stringify({ requestHash, state: 'failed', result } satisfies ImportReceipt))
      }
      return result
    })
  }
}

async function inventoryTree(root: string): Promise<Inventory> {
  const files: InventoryFile[] = []
  const directories: string[] = []
  let bytes = 0
  if (!(await lstat(root)).isDirectory()) throw coded('migration_not_directory', 'Workspace path is not a directory.')
  const walk = async (directory: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name)
      const path = relative(root, absolute).split(sep).join('/')
      const info = await lstat(absolute)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw coded('migration_unsafe_entry', `Unsupported link or special file: ${path}`)
      if (info.isDirectory()) { directories.push(path); await walk(absolute); continue }
      // Live SQLite files require their owner's consistent backup API; copying
      // the database/WAL independently would falsely claim a usable snapshot.
      if (/\.(?:sqlite3?|db)(?:-wal|-shm)?$/i.test(name) || /-(?:wal|shm)$/i.test(name)) throw coded('migration_database_requires_backup', `Database requires a consistent backup before import: ${path}`)
      if (files.length >= MAX_FILES || bytes + info.size > MAX_BYTES) throw coded('migration_size_limit', 'Workspace exceeds the local scan limit (20,000 files / 512 MiB). Use a smaller workspace or a verified offline backup.')
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let hash: string
      try {
        const current = await handle.stat()
        if (current.ino !== info.ino || current.dev !== info.dev || !inside(root, await realpath(absolute))) throw coded('source_version_conflict', `Source path changed during inspection: ${path}`)
        const content = await handle.readFile()
        const after = await handle.stat()
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || content.length !== info.size) throw coded('source_version_conflict', `Source changed during inspection: ${path}`)
        hash = digest(content)
      } finally { await handle.close() }
      bytes += info.size
      files.push({ path, size: info.size, hash, ino: info.ino, dev: info.dev, mtimeMs: info.mtimeMs })
    }
  }
  await walk(root)
  const fingerprint = digest(JSON.stringify({ directories, files: files.map(({ path, size, hash }) => ({ path, size, hash })) }))
  return { files, directories, bytes, fingerprint }
}

async function copyVerified(sourceRoot: string, targetRoot: string, file: InventoryFile): Promise<void> {
  const absolute = join(sourceRoot, file.path)
  const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const info = await handle.stat()
    if (info.ino !== file.ino || info.dev !== file.dev || info.size !== file.size || info.mtimeMs !== file.mtimeMs || !inside(sourceRoot, await realpath(absolute))) throw coded('source_version_conflict', `Source changed before copy: ${file.path}`)
    const content = await handle.readFile()
    const after = await handle.stat()
    if (after.mtimeMs !== file.mtimeMs || content.length !== file.size || digest(content) !== file.hash) throw coded('source_version_conflict', `Source changed during copy: ${file.path}`)
    const target = join(targetRoot, file.path)
    await mkdir(dirname(target), { recursive: true })
    const output = await open(target, 'wx', 0o600)
    try { await output.writeFile(content); await output.sync() } finally { await output.close() }
  } finally { await handle.close() }
}
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function canonicalPath(path: string): string {
  const resolved = resolve(path)
  if (process.platform !== 'darwin') return resolved
  return resolved.replace(/^\/private\/(var|tmp)(?=\/)/, '/$1')
}
function inside(root: string, candidate: string): boolean { const rel = relative(canonicalPath(root), canonicalPath(candidate)); return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep)) }
function coded(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
