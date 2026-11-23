import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { defaultWorkspaceTrustManifestPath } from '../../../kun/src/services/workspace-trust-reader'
import type { SandboxMode } from '../../shared/app-settings'
import type { WorkspaceTrustLevel, WorkspaceTrustV1 } from '../../shared/agent-workbench'
import { atomicWriteFile, readRecoveredFile, recoverAtomicFile, runSerialized } from './durable-file'
import { canonicalizeContainmentRoot } from './canonical-containment'

const TRUST_ORDER: WorkspaceTrustLevel[] = [
  'read-only',
  'workspace-write',
  'trusted',
  'full-access'
]

type TrustManifestV1 = {
  schema: 'workwise.workspace-trust'
  version: 1
  revision: number
  workspaces: WorkspaceTrustV1[]
  mutationResults: Record<string, WorkspaceTrustV1>
  mutationFingerprints?: Record<string, string>
}

export type SetWorkspaceTrustRequest = {
  workspaceRoot: string
  level: WorkspaceTrustLevel
  expectedRevision: number
  confirmed: boolean
  source?: WorkspaceTrustV1['source']
  idempotencyKey?: string
}

function rank(level: WorkspaceTrustLevel): number {
  return TRUST_ORDER.indexOf(level)
}

export function effectiveTrustLevel(
  workspace: WorkspaceTrustLevel,
  agent: WorkspaceTrustLevel
): WorkspaceTrustLevel {
  return TRUST_ORDER[Math.min(rank(workspace), rank(agent))] ?? 'read-only'
}

export function trustLevelFromLegacySandbox(mode: SandboxMode): WorkspaceTrustLevel {
  if (mode === 'read-only' || mode === 'external-sandbox') return 'read-only'
  if (mode === 'workspace-write') return 'workspace-write'
  return 'full-access'
}

function emptyManifest(): TrustManifestV1 {
  return {
    schema: 'workwise.workspace-trust',
    version: 1,
    revision: 0,
    workspaces: [],
    mutationResults: {}
  }
}

function normalizeManifest(value: unknown): TrustManifestV1 {
  if (!value || typeof value !== 'object') return emptyManifest()
  const raw = value as Partial<TrustManifestV1>
  if (raw.schema !== 'workwise.workspace-trust' || raw.version !== 1 || !Array.isArray(raw.workspaces)) {
    return emptyManifest()
  }
  return {
    schema: 'workwise.workspace-trust',
    version: 1,
    revision: typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
    workspaces: raw.workspaces.filter((entry): entry is WorkspaceTrustV1 =>
      Boolean(entry && typeof entry.canonicalRoot === 'string' && TRUST_ORDER.includes(entry.level))
    ),
    mutationFingerprints: raw.mutationFingerprints && typeof raw.mutationFingerprints === 'object' ? raw.mutationFingerprints : {},
    mutationResults: raw.mutationResults && typeof raw.mutationResults === 'object'
      ? Object.fromEntries(Object.entries(raw.mutationResults).filter(([, entry]) => {
          const candidate = entry as Partial<WorkspaceTrustV1> | undefined
          return Boolean(candidate && typeof candidate.canonicalRoot === 'string' && candidate.level && TRUST_ORDER.includes(candidate.level))
        })) as Record<string, WorkspaceTrustV1>
      : {}
  }
}

export class WorkspaceTrustService {
  private readonly manifestPath: string

  constructor(manifestPath = defaultWorkspaceTrustManifestPath()) {
    this.manifestPath = resolve(manifestPath)
  }

  /** Only a fresh settings profile may call this for its managed default. */
  async initializeDefaultWorkspace(workwiseHome: string, workspaceRoot: string): Promise<void> {
    const home = resolve(workwiseHome)
    const root = resolve(workspaceRoot)
    if (root !== join(home, 'default_workspace') || this.manifestPath !== join(home, 'workspace-trust.json')) return
    await mkdir(home, { recursive: true })
    const homeInfo = await lstat(home)
    if (!homeInfo.isDirectory() || homeInfo.isSymbolicLink()) return
    const canonicalHome = await canonicalizeContainmentRoot(home)
    if (canonicalHome !== join(await realpath(dirname(home)), basename(home))) return
    try {
      // Nonrecursive mkdir is the ownership claim. EEXIST never grants trust.
      await mkdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
      throw error
    }
    const created = await lstat(root)
    const canonicalRoot = join(canonicalHome, 'default_workspace')
    const stillOwned = async (): Promise<void> => {
      const info = await lstat(root)
      const parent = await lstat(home)
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== created.dev || info.ino !== created.ino ||
          !parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== homeInfo.dev || parent.ino !== homeInfo.ino ||
          await realpath(root) !== canonicalRoot) throw new Error('Managed default workspace changed during initialization.')
    }
    await runSerialized(`workspace-trust:${this.manifestPath}`, async () => {
      let manifest: TrustManifestV1
      try {
        await recoverAtomicFile(this.manifestPath)
        if ((await lstat(this.manifestPath)).isSymbolicLink()) return
        const raw = JSON.parse(await readFile(this.manifestPath, 'utf8')) as Partial<TrustManifestV1> | null
        if (!raw || raw.schema !== 'workwise.workspace-trust' || raw.version !== 1 || !Array.isArray(raw.workspaces)) return
        manifest = normalizeManifest(raw)
      } catch (error) {
        if (error instanceof SyntaxError) return
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        manifest = emptyManifest()
      }
      // A user may already have saved even a restrictive rule for this path.
      if (manifest.workspaces.some(entry => process.platform === 'win32'
        ? resolve(entry.canonicalRoot).toLowerCase() === canonicalRoot.toLowerCase() : resolve(entry.canonicalRoot) === canonicalRoot)) return
      await stillOwned()
      await atomicWriteFile(this.manifestPath, `${JSON.stringify({ ...manifest, revision: manifest.revision + 1,
        workspaces: [...manifest.workspaces, { canonicalRoot, level: 'workspace-write', source: 'workwise-created', revision: 1 }]
      }, null, 2)}\n`, { beforeReplace: stillOwned })
    })
  }

  async get(
    workspaceRoot: string,
    options?: { createdByWorkWise?: boolean; legacySandboxMode?: SandboxMode }
  ): Promise<WorkspaceTrustV1> {
    const canonicalRoot = await canonicalizeContainmentRoot(workspaceRoot)
    const manifest = await this.read()
    const existing = manifest.workspaces.find((entry) => entry.canonicalRoot === canonicalRoot)
    if (existing) return existing
    if (options?.legacySandboxMode) {
      return {
        canonicalRoot,
        level: trustLevelFromLegacySandbox(options.legacySandboxMode),
        source: 'migrated',
        revision: 0
      }
    }
    return {
      canonicalRoot,
      level: options?.createdByWorkWise ? 'workspace-write' : 'read-only',
      source: options?.createdByWorkWise ? 'workwise-created' : 'external',
      revision: 0
    }
  }

  async set(request: SetWorkspaceTrustRequest): Promise<WorkspaceTrustV1> {
    return runSerialized(`workspace-trust:${this.manifestPath}`, () => this.setSerialized(request))
  }

  private async setSerialized(request: SetWorkspaceTrustRequest): Promise<WorkspaceTrustV1> {
    const canonicalRoot = await canonicalizeContainmentRoot(request.workspaceRoot)
    const manifest = await this.read()
    const fingerprint = createHash('sha256').update(JSON.stringify({ canonicalRoot, level: request.level, expectedRevision: request.expectedRevision, confirmed: request.confirmed, source: request.source ?? 'user' })).digest('hex')
    if (request.idempotencyKey && manifest.mutationResults[request.idempotencyKey]) {
      const prior = manifest.mutationResults[request.idempotencyKey]!
      const stored = manifest.mutationFingerprints?.[request.idempotencyKey]
      // Old receipts had no fingerprint. Only replay an unambiguous matching
      // result; never let a key for one workspace authorize a different one.
      const legacyMatch = !stored && prior.canonicalRoot === canonicalRoot && prior.level === request.level && prior.source === (request.source ?? 'user') && prior.revision === request.expectedRevision + 1 && (!prior.confirmedAt || request.confirmed)
      if (stored !== fingerprint && !legacyMatch) throw Object.assign(new Error('Workspace trust idempotency key conflicts with a different request.'), { code: 'idempotency_conflict' })
      return prior
    }
    const index = manifest.workspaces.findIndex((entry) => entry.canonicalRoot === canonicalRoot)
    const current = index >= 0
      ? manifest.workspaces[index]!
      : {
          canonicalRoot,
          level: 'read-only' as const,
          source: 'external' as const,
          revision: 0
        }
    if (request.expectedRevision !== current.revision) {
      throw Object.assign(new Error('Workspace trust revision conflict.'), { code: 'stale_request' })
    }
    if (rank(request.level) > rank(current.level) && !request.confirmed) {
      throw Object.assign(new Error('Raising workspace permissions requires explicit confirmation.'), {
        code: 'approval_required'
      })
    }
    const next: WorkspaceTrustV1 = {
      canonicalRoot,
      level: request.level,
      source: request.source ?? 'user',
      ...(rank(request.level) > rank(current.level) ? { confirmedAt: new Date().toISOString() } : {}),
      revision: current.revision + 1
    }
    const workspaces = [...manifest.workspaces]
    if (index >= 0) workspaces[index] = next
    else workspaces.push(next)
    const mutationResults = request.idempotencyKey
      ? Object.fromEntries([
          ...Object.entries(manifest.mutationResults).filter(([key]) => key !== request.idempotencyKey).slice(-255),
          [request.idempotencyKey, next]
        ])
      : manifest.mutationResults
    await atomicWriteFile(this.manifestPath, `${JSON.stringify({
      ...manifest,
      revision: manifest.revision + 1,
      workspaces,
      mutationResults,
      mutationFingerprints: request.idempotencyKey ? Object.fromEntries(Object.keys(mutationResults).map(key => [key, key === request.idempotencyKey ? fingerprint : manifest.mutationFingerprints?.[key]]).filter(([, value]) => typeof value === 'string')) : manifest.mutationFingerprints
    }, null, 2)}\n`)
    return next
  }

  private async read(): Promise<TrustManifestV1> {
    try {
      return normalizeManifest(JSON.parse(await readRecoveredFile(this.manifestPath)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest()
      throw error
    }
  }
}
