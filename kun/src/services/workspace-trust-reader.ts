import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { WorkspaceTrustLevelSchema, type WorkspaceTrustLevel } from '../contracts/permissions.js'

export type WorkspaceTrustSnapshot = { canonicalRoot: string; level: WorkspaceTrustLevel; revision: number }
export interface WorkspaceTrustReader { get(workspaceRoot: string): Promise<WorkspaceTrustSnapshot> }

/** Reads the same versioned manifest written by Electron WorkspaceTrustService.
 * Reads are deliberately uncached: revocation must reach already-running Turns. */
export class FileWorkspaceTrustReader implements WorkspaceTrustReader {
  constructor(private readonly manifestPath = join(homedir(), '.workwise', 'workspace-trust.json')) {}

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
