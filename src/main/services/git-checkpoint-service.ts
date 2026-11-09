import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createTwoFilesPatch } from 'diff'
import type {
  GitCheckpointV1,
  GitRollbackPreviewV1
} from '../../shared/agent-workbench'
import { atomicWriteFile, readRecoveredFile } from './durable-file'
import {
  canonicalizeContainmentRoot,
  isCanonicalPathContained,
  recheckContainedParent,
  resolveContainedPath
} from './canonical-containment'
import { findNearestGitRoot } from './git-discovery'
import { assertGitWorkspaceAllowed } from './git-service'

const execFileAsync = promisify(execFile)
const MAX_CHECKPOINT_FILES = 512
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024
const MAX_DIFF_CHARS = 200_000

type SnapshotRecord = {
  relativePath: string
  existed: boolean
  snapshotPath?: string
  beforeSha256?: string
  originallyModified: boolean
}

type StoredGitCheckpoint = {
  schema: 'workwise.git-checkpoint'
  version: 1
  idempotencyKey: string
  checkpoint: GitCheckpointV1
  snapshots: SnapshotRecord[]
  rollbackResults?: Record<string, GitRollbackPreviewV1>
}

export type CreateGitCheckpointRequest = {
  taskId: string
  workspaceRoot: string
  repositoryRoot?: string
  relatedPaths?: string[]
  idempotencyKey: string
}

export type PreviewGitRollbackRequest = {
  checkpointId: string
  relatedPaths?: string[]
}

export type ApplyGitRollbackRequest = PreviewGitRollbackRequest & {
  expectedRevision: number
  idempotencyKey: string
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

function porcelainPaths(output: string): string[] {
  const tokens = output.split('\0').filter(Boolean)
  const paths: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.length < 4) continue
    const status = token.slice(0, 2)
    const path = normalizedRelativePath(token.slice(3))
    paths.push(path)
    if (status.includes('R') || status.includes('C')) index += 1
  }
  return paths
}

async function runGit(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 20_000,
    maxBuffer,
    encoding: 'utf8'
  })
  return String(stdout)
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

export class GitCheckpointService {
  private readonly root: string

  constructor(root = join(homedir(), '.workwise', 'git-checkpoints')) {
    this.root = resolve(root)
  }

  async create(request: CreateGitCheckpointRequest, activeWorkspaceRoot?: string): Promise<GitCheckpointV1> {
    if (!request.taskId.trim() || !request.idempotencyKey.trim()) {
      throw Object.assign(new Error('taskId and idempotencyKey are required.'), { code: 'invalid_state' })
    }
    if (activeWorkspaceRoot) await assertGitWorkspaceAllowed(request.workspaceRoot, activeWorkspaceRoot)
    const workspaceRoot = await canonicalizeContainmentRoot(request.workspaceRoot)
    const repositoryCandidate = request.repositoryRoot
      ? await canonicalizeContainmentRoot(request.repositoryRoot)
      : await findNearestGitRoot(workspaceRoot)
    if (!repositoryCandidate) {
      throw Object.assign(new Error('No Git repository was found for this workspace.'), { code: 'not_found' })
    }
    if (!isCanonicalPathContained(workspaceRoot, repositoryCandidate)) {
      throw Object.assign(new Error('Git repository must stay within the active workspace.'), {
        code: 'workspace_not_allowed'
      })
    }
    const repositoryRoot = await resolveContainedPath({
      root: workspaceRoot,
      target: repositoryCandidate,
      allowRoot: true,
      mustExist: true,
      expect: 'directory'
    })
    const id = `gitcp_${sha256(`${request.taskId}:${request.idempotencyKey}`).slice(0, 20)}`
    const existing = await this.read(id).catch(() => null)
    if (existing) return existing.checkpoint

    const [head, originalStatus] = await Promise.all([
      runGit(repositoryRoot, ['rev-parse', 'HEAD']).then((value) => value.trim()),
      runGit(repositoryRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    ])
    const dirtyPaths = porcelainPaths(originalStatus)
    const requestedPaths = (request.relatedPaths ?? []).map(normalizedRelativePath)
    const candidates = [...new Set([...dirtyPaths, ...requestedPaths])].slice(0, MAX_CHECKPOINT_FILES)
    const directory = join(this.root, id)
    const snapshotDirectory = join(directory, 'before')
    await mkdir(snapshotDirectory, { recursive: true })

    const snapshots: SnapshotRecord[] = []
    for (const relativePath of candidates) {
      const target = await resolveContainedPath({ root: repositoryRoot, target: relativePath })
      const info = await lstat(target).catch(() => null)
      if (!info) {
        snapshots.push({ relativePath, existed: false, originallyModified: dirtyPaths.includes(relativePath) })
        continue
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        throw Object.assign(new Error(`Git checkpoint only supports regular files: ${relativePath}`), { code: 'unsafe_path' })
      }
      if (info.size > MAX_SNAPSHOT_BYTES) {
        throw Object.assign(new Error(`Git checkpoint file exceeds 5 MiB: ${relativePath}`), { code: 'resource_limit' })
      }
      const content = await readFile(target)
      const snapshotPath = join(snapshotDirectory, sha256(relativePath))
      await atomicWriteFile(snapshotPath, content)
      snapshots.push({
        relativePath,
        existed: true,
        snapshotPath,
        beforeSha256: sha256(content),
        originallyModified: dirtyPaths.includes(relativePath)
      })
    }

    const createdAt = new Date().toISOString()
    const checkpoint: GitCheckpointV1 = {
      id,
      taskId: request.taskId,
      workspaceRoot,
      repositoryRoot,
      head,
      originalStatus,
      files: snapshots.map((snapshot) => ({
        relativePath: snapshot.relativePath,
        beforeSha256: snapshot.beforeSha256,
        originallyModified: snapshot.originallyModified
      })),
      createdAt,
      revision: 0
    }
    const stored: StoredGitCheckpoint = {
      schema: 'workwise.git-checkpoint',
      version: 1,
      idempotencyKey: request.idempotencyKey,
      checkpoint,
      snapshots
    }
    await atomicWriteFile(join(directory, 'checkpoint.json'), `${JSON.stringify(stored, null, 2)}\n`)
    return checkpoint
  }

  async preview(request: PreviewGitRollbackRequest, activeWorkspaceRoot?: string): Promise<GitRollbackPreviewV1> {
    const stored = await this.read(request.checkpointId)
    await this.validateStoredWorkspace(stored, activeWorkspaceRoot)
    const records = new Map(stored.snapshots.map((entry) => [entry.relativePath, entry]))
    for (const relativePath of request.relatedPaths ?? []) {
      const normalized = normalizedRelativePath(relativePath)
      if (!records.has(normalized)) {
        records.set(normalized, {
          relativePath: normalized,
          existed: false,
          originallyModified: false
        })
      }
    }
    const changedFiles: GitRollbackPreviewV1['changedFiles'] = []
    for (const record of records.values()) {
      const target = await resolveContainedPath({
        root: stored.checkpoint.repositoryRoot,
        target: record.relativePath
      })
      const current = await readFile(target).catch(() => null)
      const before = record.snapshotPath ? await readFile(record.snapshotPath).catch(() => null) : null
      const currentSha = current ? sha256(current) : undefined
      if (currentSha === record.beforeSha256 || (!current && !record.existed)) continue
      const conflict = record.originallyModified
      const diff = createTwoFilesPatch(
        `${record.relativePath} (task start)`,
        `${record.relativePath} (current)`,
        before?.toString('utf8') ?? '',
        current?.toString('utf8') ?? ''
      ).slice(0, MAX_DIFF_CHARS)
      changedFiles.push({ relativePath: record.relativePath, diff, conflict })
    }
    const conflicts = changedFiles.filter((entry) => entry.conflict)
    return {
      checkpointId: stored.checkpoint.id,
      safe: conflicts.length === 0,
      changedFiles,
      ...(conflicts.length > 0
        ? { message: '检测到任务开始前已有改动的文件，为避免覆盖用户修改，已阻止回滚。' }
        : {})
    }
  }

  async apply(request: ApplyGitRollbackRequest, activeWorkspaceRoot?: string): Promise<GitRollbackPreviewV1> {
    const stored = await this.read(request.checkpointId)
    await this.validateStoredWorkspace(stored, activeWorkspaceRoot)
    const replay = stored.rollbackResults?.[request.idempotencyKey]
    if (replay) return replay
    if (request.expectedRevision !== stored.checkpoint.revision) {
      throw Object.assign(new Error('Git checkpoint revision conflict.'), { code: 'stale_request' })
    }
    const preview = await this.preview(request, activeWorkspaceRoot)
    if (!preview.safe) {
      const rescueRef = await this.createRescueRef(stored).catch(() => undefined)
      const result = { ...preview, ...(rescueRef ? { rescueRef } : {}) }
      await this.saveRollbackResult(stored, request.idempotencyKey, result, rescueRef)
      return result
    }
    const records = new Map(stored.snapshots.map((entry) => [entry.relativePath, entry]))
    for (const change of preview.changedFiles) {
      const record = records.get(change.relativePath)
      const target = await resolveContainedPath({
        root: stored.checkpoint.repositoryRoot,
        target: change.relativePath
      })
      await recheckContainedParent(stored.checkpoint.repositoryRoot, target)
      if (!record?.existed) {
        const info = await lstat(target).catch(() => null)
        if (info?.isSymbolicLink() || (info && !info.isFile())) {
          throw Object.assign(new Error(`Unsafe rollback target: ${change.relativePath}`), { code: 'unsafe_path' })
        }
        await rm(target, { force: true })
        continue
      }
      if (!record.snapshotPath || !(await exists(record.snapshotPath))) {
        throw Object.assign(new Error(`Checkpoint content is missing: ${change.relativePath}`), { code: 'not_found' })
      }
      await mkdir(dirname(target), { recursive: true })
      await atomicWriteFile(target, await readFile(record.snapshotPath), {
        beforeReplace: () => recheckContainedParent(stored.checkpoint.repositoryRoot, target)
      })
    }
    await this.saveRollbackResult(stored, request.idempotencyKey, preview)
    return preview
  }

  private async saveRollbackResult(
    stored: StoredGitCheckpoint,
    idempotencyKey: string,
    result: GitRollbackPreviewV1,
    rescueRef?: string
  ): Promise<void> {
    const rollbackResults = Object.fromEntries([
      ...Object.entries(stored.rollbackResults ?? {}).filter(([key]) => key !== idempotencyKey).slice(-31),
      [idempotencyKey, result]
    ])
    const next: StoredGitCheckpoint = {
      ...stored,
      checkpoint: {
        ...stored.checkpoint,
        ...(rescueRef ? { rescueRef } : {}),
        revision: stored.checkpoint.revision + 1
      },
      rollbackResults
    }
    await atomicWriteFile(join(this.root, stored.checkpoint.id, 'checkpoint.json'), `${JSON.stringify(next, null, 2)}\n`)
  }

  private async createRescueRef(stored: StoredGitCheckpoint): Promise<string | undefined> {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
    const safeTask = stored.checkpoint.taskId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40)
    const rescueRef = `workwise/rescue/${stamp}-${safeTask}`
    const commit = (await runGit(stored.checkpoint.repositoryRoot, ['stash', 'create', `RailWise AI rescue ${stored.checkpoint.taskId}`]))
      .trim()
    if (!commit) return undefined
    await runGit(stored.checkpoint.repositoryRoot, ['update-ref', `refs/${rescueRef}`, commit])
    return rescueRef
  }

  private async validateStoredWorkspace(
    stored: StoredGitCheckpoint,
    activeWorkspaceRoot?: string
  ): Promise<void> {
    if (activeWorkspaceRoot) {
      await assertGitWorkspaceAllowed(stored.checkpoint.workspaceRoot, activeWorkspaceRoot)
    }
    if (!isCanonicalPathContained(stored.checkpoint.workspaceRoot, stored.checkpoint.repositoryRoot)) {
      throw Object.assign(new Error('Git repository must stay within the active workspace.'), {
        code: 'workspace_not_allowed'
      })
    }
    await resolveContainedPath({
      root: stored.checkpoint.workspaceRoot,
      target: stored.checkpoint.repositoryRoot,
      allowRoot: true,
      mustExist: true,
      expect: 'directory'
    })
  }

  private async read(id: string): Promise<StoredGitCheckpoint> {
    if (!/^gitcp_[a-f0-9]{20}$/.test(id)) {
      throw Object.assign(new Error('Invalid Git checkpoint id.'), { code: 'unsafe_path' })
    }
    const raw = JSON.parse(await readRecoveredFile(join(this.root, id, 'checkpoint.json'))) as StoredGitCheckpoint
    if (raw.schema !== 'workwise.git-checkpoint' || raw.version !== 1 || raw.checkpoint.id !== id) {
      throw Object.assign(new Error('Invalid Git checkpoint data.'), { code: 'invalid_state' })
    }
    return raw
  }
}
