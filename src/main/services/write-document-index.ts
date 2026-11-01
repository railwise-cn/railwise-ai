import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { isWriteTextFileExtension } from '../../shared/write-text-file'
import { canonicalizeContainmentRoot, resolveContainedPath } from './canonical-containment'
import { expandHomePath } from './workspace-paths'

export const WRITE_DOCUMENT_INDEX_LIMITS = {
  maxFiles: 20_000,
  maxFileBytes: 2_000_000,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 200_000
} as const
const MANIFEST_CACHE_MS = 1_000
const MAX_CACHED_WORKSPACES = 4
const SKIP_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'dist', 'out', 'build', '.workwise', '.next',
  'coverage', '.cache', '.idea', '.pnpm-store', '.turbo', '.venv', '.vscode', '.yarn',
  '.yarn-cache', '.parcel-cache', 'log', 'logs', 'target', 'temp', 'tmp', 'vendor', 'venv'
])

export type WriteIndexedDocument = {
  path: string
  relativePath: string
  content: string
  size: number
  modifiedAt: number
  markdown: boolean
}
export type WriteDocumentIndex = {
  workspaceRoot: string
  builtAt: number
  documents: WriteIndexedDocument[]
  skippedFiles: number
  truncated: boolean
  limits: typeof WRITE_DOCUMENT_INDEX_LIMITS
}
type CachedFile = { size: number; modifiedAt: number; changedAt: number; inode: number; document: WriteIndexedDocument }
type WorkspaceCache = { index: WriteDocumentIndex; files: Map<string, CachedFile> }
const caches = new Map<string, WorkspaceCache>()
const inFlight = new Map<string, Promise<WriteDocumentIndex>>()
let invalidationEpoch = 0

/** Call after internal mutations; external edits are discovered during manifest refresh. */
export function invalidateWriteDocumentIndex(workspaceRoot?: string): void {
  invalidationEpoch += 1
  if (!workspaceRoot) { caches.clear(); inFlight.clear(); return }
  // The caller may use a lexical alias for the canonical root. Clearing all four
  // bounded caches avoids retaining stale source under an equivalent alias.
  caches.clear()
  inFlight.clear()
}

async function buildIndex(root: string, previous?: WorkspaceCache): Promise<WorkspaceCache> {
  const documents: WriteIndexedDocument[] = []
  const files = new Map<string, CachedFile>()
  const stack = [root]
  let skippedFiles = 0
  let truncated = false
  let totalBytes = 0
  let examined = 0
  let scannedEntries = 0
  while (stack.length) {
    const directory = stack.pop()!
    let entries
    try {
      if ((await lstat(directory)).isSymbolicLink()) { skippedFiles++; continue }
      const safeDirectory = await resolveContainedPath({ root, target: directory, allowRoot: true, mustExist: true, expect: 'directory', rejectFinalLink: true })
      // Root is already canonical; a different result means an intermediate
      // directory was replaced with a link, even if its target is inside root.
      if (safeDirectory !== directory) { skippedFiles++; continue }
      entries = await readdir(directory, { withFileTypes: true })
    } catch { skippedFiles++; continue }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++scannedEntries > WRITE_DOCUMENT_INDEX_LIMITS.maxEntries) { truncated = true; break }
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) { skippedFiles++; continue }
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(path)
        continue
      }
      if (!entry.isFile() || !isWriteTextFileExtension(extname(entry.name))) continue
      if (documents.length >= WRITE_DOCUMENT_INDEX_LIMITS.maxFiles) { truncated = true; break }
      if (++examined % 32 === 0) await yieldToEventLoop()
      try {
        const safe = await resolveContainedPath({ root, target: path, mustExist: true, expect: 'file', rejectFinalLink: true })
        if (safe !== path) { skippedFiles++; continue }
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink()) { skippedFiles++; continue }
        if (info.size > WRITE_DOCUMENT_INDEX_LIMITS.maxFileBytes || totalBytes + info.size > WRITE_DOCUMENT_INDEX_LIMITS.maxTotalBytes) {
          skippedFiles++; truncated = true; continue
        }
        const cached = previous?.files.get(safe)
        let record: CachedFile
        if (cached && cached.size === info.size && cached.modifiedAt === info.mtimeMs && cached.changedAt === info.ctimeMs && cached.inode === info.ino) record = cached
        else {
          const handle = await open(safe, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const current = await handle.stat()
            if (!current.isFile() || current.size > WRITE_DOCUMENT_INDEX_LIMITS.maxFileBytes) { skippedFiles++; truncated = true; continue }
            const bytes = await handle.readFile()
            const after = await handle.stat()
            // A changing file cannot become a stable cached authority snapshot.
            if (bytes.length > WRITE_DOCUMENT_INDEX_LIMITS.maxFileBytes || bytes.includes(0) || after.size !== current.size || after.mtimeMs !== current.mtimeMs || after.ctimeMs !== current.ctimeMs) {
              skippedFiles++; truncated = true; continue
            }
            const document: WriteIndexedDocument = {
              path: safe, relativePath: relative(root, safe).replaceAll('\\', '/'),
              content: bytes.toString('utf8'), size: bytes.length, modifiedAt: after.mtimeMs,
              markdown: /\.(md|markdown|mdx)$/i.test(safe)
            }
            record = { size: after.size, modifiedAt: after.mtimeMs, changedAt: after.ctimeMs, inode: after.ino, document }
          } finally { await handle.close() }
        }
        if (totalBytes + record.document.size > WRITE_DOCUMENT_INDEX_LIMITS.maxTotalBytes) { skippedFiles++; truncated = true; continue }
        totalBytes += record.document.size
        files.set(safe, record)
        documents.push(record.document)
      } catch { skippedFiles++ }
    }
    if (scannedEntries > WRITE_DOCUMENT_INDEX_LIMITS.maxEntries) break
    if (documents.length >= WRITE_DOCUMENT_INDEX_LIMITS.maxFiles) { if (stack.length) truncated = true; break }
  }
  return {
    index: { workspaceRoot: root, builtAt: Date.now(), documents, skippedFiles, truncated, limits: WRITE_DOCUMENT_INDEX_LIMITS },
    files
  }
}

/** One local source index serves visible search, relations and BM25 retrieval. */
export async function loadWriteDocumentIndex(workspaceRoot: string, options: { forceRefresh?: boolean } = {}): Promise<WriteDocumentIndex> {
  const root = await canonicalizeContainmentRoot(expandHomePath(workspaceRoot))
  const cached = caches.get(root)
  if (!options.forceRefresh && cached && Date.now() - cached.index.builtAt <= MANIFEST_CACHE_MS) return cached.index
  const pending = inFlight.get(root)
  if (pending) return pending
  const epoch = invalidationEpoch
  const operation = buildIndex(root, cached).then((result) => {
    if (epoch === invalidationEpoch) {
      caches.delete(root)
      caches.set(root, result)
      while (caches.size > MAX_CACHED_WORKSPACES) caches.delete(caches.keys().next().value!)
    }
    return result.index
  }).finally(() => { if (inFlight.get(root) === operation) inFlight.delete(root) })
  inFlight.set(root, operation)
  return operation
}
