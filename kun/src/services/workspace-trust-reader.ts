import { readFile, realpath } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { WorkspaceTrustLevelSchema, type WorkspaceTrustLevel } from '../contracts/permissions.js'

export type WorkspaceTrustSnapshot = { canonicalRoot: string; level: WorkspaceTrustLevel; revision: number }
export interface WorkspaceTrustReader { get(workspaceRoot: string): Promise<WorkspaceTrustSnapshot> }

/** Electron and its managed child must use the same isolated trust manifest. */
export function defaultWorkspaceTrustManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WORKWISE_CANDIDATE !== '1') return join(homedir(), '.workwise', 'workspace-trust.json')
  const root = env.WORKWISE_CANDIDATE_ROOT?.trim()
  const home = env.WORKWISE_CANDIDATE_HOME?.trim() || (root && join(root, 'home'))
  const canonical = (path: string): string => {
    let ancestor = resolve(path)
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor)
      if (parent === ancestor) throw new Error('Candidate workspace trust path cannot be resolved.')
      ancestor = parent
    }
    return resolve(realpathSync(ancestor), relative(ancestor, resolve(path)))
  }
  const contained = (parent: string, child: string): boolean => {
    const tail = relative(parent, child)
    return tail !== '' && tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail)
  }
  if (!root || !home || !isAbsolute(root) || !isAbsolute(home) ||
      !contained(resolve(root), resolve(home)) || !contained(canonical(root), canonical(home))) {
    throw new Error('Candidate workspace trust must stay inside its isolated root.')
  }
  const manifest = join(resolve(home), '.workwise', 'workspace-trust.json')
  if (!contained(canonical(root), canonical(manifest))) throw new Error('Candidate workspace trust must stay inside its isolated root.')
  return manifest
}

/** Reads the same versioned manifest written by Electron WorkspaceTrustService.
 * Reads are deliberately uncached: revocation must reach already-running Turns. */
export class FileWorkspaceTrustReader implements WorkspaceTrustReader {
  constructor(private readonly manifestPath = defaultWorkspaceTrustManifestPath()) {}

  async get(workspaceRoot: string): Promise<WorkspaceTrustSnapshot> {
    if (!workspaceRoot.trim()) return { canonicalRoot: '', level: 'read-only', revision: 0 }
    const canonicalRoot = await canonicalTrustRoot(workspaceRoot)
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.manifestPath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // An unregistered external folder is never inferred to be trusted from
        // the selected agent or a legacy danger-full-access setting.
        return { canonicalRoot, level: 'read-only', revision: 0 }
      }
      throw Object.assign(new Error('Workspace trust manifest is unreadable; reconnect workspace permissions.'), { code: 'workspace_trust_unavailable', cause: error })
    }
    if (!raw || typeof raw !== 'object') throw invalidManifest()
    const manifest = raw as { schema?: unknown; version?: unknown; workspaces?: unknown }
    if (manifest.schema !== 'workwise.workspace-trust' || manifest.version !== 1 || !Array.isArray(manifest.workspaces)) throw invalidManifest()
    const matches = manifest.workspaces.filter(entry => entry && typeof entry === 'object' && normalizedRoot((entry as { canonicalRoot?: unknown }).canonicalRoot) === normalizedRoot(canonicalRoot))
    if (matches.length > 1) throw invalidManifest()
    const entry = matches[0] as { level?: unknown; revision?: unknown } | undefined
    if (!entry) return { canonicalRoot, level: 'read-only', revision: 0 }
    const level = WorkspaceTrustLevelSchema.safeParse(entry.level)
    if (!level.success || typeof entry.revision !== 'number' || !Number.isInteger(entry.revision) || entry.revision < 0) throw invalidManifest()
    return { canonicalRoot, level: level.data, revision: entry.revision }
  }
}

function invalidManifest(): Error { return Object.assign(new Error('Invalid workspace trust manifest; permissions were not granted.'), { code: 'workspace_trust_unavailable' }) }
function normalizedRoot(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = resolve(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export async function canonicalTrustRoot(workspaceRoot: string): Promise<string> {
  const absolute = resolve(workspaceRoot)
  let existing = absolute
  const suffix: string[] = []
  for (;;) {
    try { return resolve(await realpath(existing), ...suffix.reverse()) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      suffix.push(existing.slice(parent.length).replace(/^[\\/]+/, ''))
      existing = parent
    }
  }
}
