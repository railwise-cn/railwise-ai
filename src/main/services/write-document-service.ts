import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type {
  DocumentConflict,
  CheckedDocumentWritePayload,
  CheckedDocumentWriteResult,
  DocumentHistoryEntry,
  DocumentHistoryListResult,
  DocumentHistoryPayload,
  DocumentReadPayload,
  DocumentRestorePayload,
  DocumentComment,
  DocumentCommentCreatePayload,
  DocumentCommentUpdatePayload,
  DocumentSemantics,
  DocumentSemanticsPayload,
  DocumentRevision,
  DocumentSnapshot,
  FrontmatterParseResult,
  MarkdownLink,
  WorkspaceSearchResponse
} from '../../shared/write-document'
import { atomicWriteFile, runSerialized } from './durable-file'
import { expandHomePath } from './workspace-paths'
import { canonicalizeContainmentRoot, recheckContainedParent, resolveContainedPath } from './canonical-containment'
import { invalidateWriteDocumentIndex, loadWriteDocumentIndex, WRITE_DOCUMENT_INDEX_LIMITS } from './write-document-index'

const MAX_SEARCH_RESULTS = 200
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024
const MAX_SIDECAR_BYTES = MAX_DOCUMENT_BYTES * 6 + 8192
const HISTORY_ID = /^\d{13}-[a-f0-9-]{36}$/
const COMMENT_ID = /^[a-f0-9-]{36}$/

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

async function documentTarget(path: string, workspaceRoot: string): Promise<{ root: string; path: string }> {
  const expandedRoot = expandHomePath(workspaceRoot)
  const root = await canonicalizeContainmentRoot(expandedRoot)
  const target = await resolveContainedPath({ root: expandedRoot, target: expandHomePath(path), expect: 'file', rejectFinalLink: true })
  return { root, path: target }
}

async function readRegularFile(path: string, maxBytes: number): Promise<{ content: string; size: number; modifiedAt: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) throw new Error('Document target is not a regular file.')
    if (metadata.size > maxBytes) throw new Error(`Document exceeds the ${maxBytes} byte read limit.`)
    const content = await handle.readFile('utf8')
    const size = Buffer.byteLength(content, 'utf8')
    if (size > maxBytes) throw new Error(`Document exceeds the ${maxBytes} byte read limit.`)
    return { content, size, modifiedAt: metadata.mtimeMs }
  } finally { await handle.close() }
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function computeDocumentRevision(content: string, metadata?: { size?: number; modifiedAt?: number }): DocumentRevision {
  return {
    fingerprint: createHash('sha256').update(content, 'utf8').digest('hex'),
    size: metadata?.size ?? Buffer.byteLength(content, 'utf8'),
    modifiedAt: metadata?.modifiedAt ?? 0
  }
}

export function revisionsEqual(a: DocumentRevision | null | undefined, b: DocumentRevision | null | undefined): boolean {
  if (!a || !b) return a === b
  return a.fingerprint === b.fingerprint && a.size === b.size
}

export async function readDocumentSnapshot(path: string, workspaceRoot: string): Promise<DocumentSnapshot> {
  const target = await documentTarget(path, workspaceRoot)
  const file = await readRegularFile(target.path, MAX_DOCUMENT_BYTES)
  return { path: target.path, content: file.content, revision: computeDocumentRevision(file.content, file) }
}

async function readCurrent(path: string, root: string): Promise<DocumentSnapshot | null> {
  try { return await readDocumentSnapshot(path, root) }
  catch (error) { if (isMissing(error)) return null; throw error }
}

class BaselineChangedError extends Error {
  constructor(readonly conflict: DocumentConflict) { super('Document changed while saving.') }
}

function conflictFor(path: string, expected: DocumentRevision | null, current: DocumentSnapshot | null, attemptedContent: string): DocumentConflict {
  return { path, expectedRevision: expected, currentRevision: current?.revision ?? null, currentContent: current?.content ?? null, attemptedContent }
}

export async function writeDocumentChecked(input: CheckedDocumentWritePayload): Promise<CheckedDocumentWriteResult> {
  try {
    if (Buffer.byteLength(input.content, 'utf8') > MAX_DOCUMENT_BYTES) return { ok: false, message: 'Document is too large to save safely.' }
    const target = await documentTarget(input.path, input.workspaceRoot)
    return await runSerialized(`document:${target.path}`, async () => {
      const current = await readCurrent(target.path, target.root)
      if (input.expectedRevision !== undefined && !revisionsEqual(input.expectedRevision, current?.revision ?? null)) {
        return { ok: false, conflict: conflictFor(target.path, input.expectedRevision, current, input.content) }
      }
      // A broken or unsafe history location must fail before any document mutation, including creation.
      await sidecarDirectory(target.root, 'document-history', target.path, true)
      if (current) await appendHistory(target.root, current, 'external')
      await mkdir(dirname(target.path), { recursive: true })
      await atomicWriteFile(target.path, input.content, { beforeReplace: async () => {
        await recheckContainedParent(target.root, target.path)
        const latest = await readCurrent(target.path, target.root)
        if (!revisionsEqual(current?.revision ?? null, latest?.revision ?? null)) {
          throw new BaselineChangedError(conflictFor(target.path, current?.revision ?? null, latest, input.content))
        }
      } })
      const snapshot = await readDocumentSnapshot(target.path, target.root)
      invalidateWriteDocumentIndex(target.root)
      await appendHistory(target.root, snapshot, input.source ?? 'user')
      return { ok: true, snapshot }
    })
  } catch (error) {
    if (error instanceof BaselineChangedError) return { ok: false, conflict: error.conflict }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Sidecar directories may never be symbolic links, even when their target is contained. */
async function sidecarDirectory(root: string, kind: string, path: string, create: boolean): Promise<string | null> {
  const key = createHash('sha256').update(relative(root, path)).digest('hex')
  let current = root
  for (const segment of ['.workwise', kind, key]) {
    current = resolve(current, segment)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Document sidecar directory must be a regular directory.')
    } catch (error) {
      if (!isMissing(error)) throw error
      if (!create) return null
      await recheckContainedParent(root, current)
      await mkdir(current).catch((mkdirError: NodeJS.ErrnoException) => { if (mkdirError.code !== 'EEXIST') throw mkdirError })
      const info = await lstat(current)
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Document sidecar directory must be a regular directory.')
    }
    await resolveContainedPath({ root, target: current, expect: 'directory', mustExist: true, rejectFinalLink: true })
  }
  return current
}

async function appendHistory(root: string, snapshot: DocumentSnapshot, source: DocumentHistoryEntry['source']): Promise<DocumentHistoryEntry> {
  const directory = (await sidecarDirectory(root, 'document-history', snapshot.path, true))!
  const entry: DocumentHistoryEntry = { ...snapshot, id: `${Date.now()}-${randomUUID()}`, createdAt: new Date().toISOString(), source }
  const target = resolve(directory, `${entry.id}.json`)
  await atomicWriteFile(target, JSON.stringify(entry), { beforeReplace: async () => {
    await sidecarDirectory(root, 'document-history', snapshot.path, false)
    await recheckContainedParent(root, target)
    await resolveContainedPath({ root, target, expect: 'file', rejectFinalLink: true })
  } })
  return entry
}

function validateHistoryEntry(value: unknown, path: string): DocumentHistoryEntry {
  const entry = value as DocumentHistoryEntry
  if (!entry || !HISTORY_ID.test(entry.id) || entry.path !== path || typeof entry.content !== 'string'
    || !['user', 'agent', 'external', 'restore'].includes(entry.source) || !Number.isFinite(Date.parse(entry.createdAt))
    || !revisionsEqual(entry.revision, computeDocumentRevision(entry.content))) throw new Error('Invalid document history entry.')
  return entry
}

export async function getDocumentHistoryEntry(input: DocumentHistoryPayload): Promise<DocumentHistoryEntry> {
  if (!HISTORY_ID.test(input.id)) throw new Error('Invalid history entry ID.')
  const target = await documentTarget(input.path, input.workspaceRoot)
  const directory = await sidecarDirectory(target.root, 'document-history', target.path, false)
  if (!directory) throw new Error('Document history entry was not found.')
  const file = await readRegularFile(resolve(directory, `${input.id}.json`), MAX_SIDECAR_BYTES)
  return validateHistoryEntry(JSON.parse(file.content), target.path)
}

export async function listDocumentHistory(input: DocumentReadPayload): Promise<DocumentHistoryListResult> {
  const target = await documentTarget(input.path, input.workspaceRoot)
  const directory = await sidecarDirectory(target.root, 'document-history', target.path, false)
  if (!directory) return { entries: [], total: 0, truncated: false, limit: 200 }
  const entries = await readdir(directory, { withFileTypes: true })
  const result: DocumentHistoryListResult['entries'] = []
  const eligible = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json') && HISTORY_ID.test(entry.name.slice(0, -5))).sort((a, b) => b.name.localeCompare(a.name))
  for (const entry of eligible.slice(0, 200)) {
    const file = await readRegularFile(resolve(directory, entry.name), MAX_SIDECAR_BYTES)
    const { content: _content, ...summary } = validateHistoryEntry(JSON.parse(file.content), target.path)
    result.push(summary)
  }
  return { entries: result, total: eligible.length, truncated: eligible.length > 200, limit: 200 }
}

export async function restoreDocumentHistory(input: DocumentRestorePayload): Promise<CheckedDocumentWriteResult> {
  const entry = await getDocumentHistoryEntry(input)
  return writeDocumentChecked({ ...input, content: entry.content, source: 'restore' })
}

function validateComment(value: unknown, path: string): DocumentComment {
  const comment = value as DocumentComment
  if (!comment || !COMMENT_ID.test(comment.id) || comment.path !== path || typeof comment.text !== 'string'
    || !comment.anchor || !Number.isInteger(comment.anchor.from) || !Number.isInteger(comment.anchor.to)
    || comment.anchor.from < 0 || comment.anchor.to < comment.anchor.from || typeof comment.anchor.text !== 'string'
    || !['open', 'resolved'].includes(comment.status) || !Number.isFinite(Date.parse(comment.createdAt))
    || !Number.isFinite(Date.parse(comment.updatedAt))) throw new Error('Invalid document comment.')
  return comment
}

export async function listDocumentComments(input: DocumentReadPayload): Promise<DocumentComment[]> {
  const target = await documentTarget(input.path, input.workspaceRoot)
  const directory = await sidecarDirectory(target.root, 'document-comments', target.path, false)
  if (!directory) return []
  const entries = await readdir(directory, { withFileTypes: true })
  const result: DocumentComment[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || !COMMENT_ID.test(entry.name.slice(0, -5))) continue
    const file = await readRegularFile(resolve(directory, entry.name), MAX_SIDECAR_BYTES)
    result.push(validateComment(JSON.parse(file.content), target.path))
  }
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

async function persistComment(root: string, comment: DocumentComment): Promise<void> {
  const directory = (await sidecarDirectory(root, 'document-comments', comment.path, true))!
  const target = resolve(directory, `${comment.id}.json`)
  await atomicWriteFile(target, JSON.stringify(comment), { beforeReplace: async () => {
    await sidecarDirectory(root, 'document-comments', comment.path, false)
    await resolveContainedPath({ root, target, expect: 'file', rejectFinalLink: true })
    await recheckContainedParent(root, target)
  } })
}

export async function createDocumentComment(input: DocumentCommentCreatePayload): Promise<DocumentComment> {
  if (!input.text.trim() || input.text.length > 20_000) throw new Error('Comment text must contain 1–20000 characters.')
  const snapshot = await readDocumentSnapshot(input.path, input.workspaceRoot)
  const { from, to, text } = input.anchor
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > snapshot.content.length
    || snapshot.content.slice(from, to) !== text) throw new Error('The selected text has changed. Select it again before adding a comment.')
  const now = new Date().toISOString()
  const comment: DocumentComment = { id: randomUUID(), path: snapshot.path, text: input.text.trim(), anchor: { ...input.anchor }, status: 'open', createdAt: now, updatedAt: now }
  const root = await canonicalizeContainmentRoot(expandHomePath(input.workspaceRoot))
  await persistComment(root, comment)
  return comment
}

export async function updateDocumentComment(input: DocumentCommentUpdatePayload): Promise<DocumentComment> {
  if (!COMMENT_ID.test(input.id) || !['open', 'resolved'].includes(input.status)) throw new Error('Invalid document comment update.')
  const target = await documentTarget(input.path, input.workspaceRoot)
  return runSerialized(`comment:${target.path}:${input.id}`, async () => {
    const current = (await listDocumentComments(input)).find((comment) => comment.id === input.id)
    if (!current) throw new Error('Document comment was not found.')
    const updated = { ...current, status: input.status, updatedAt: new Date().toISOString() }
    await persistComment(target.root, updated)
    return updated
  })
}

/** Copy metadata to the new identity before an internal rename; old records remain available for recovery. */
export async function relocateDocumentSidecars(input: { workspaceRoot: string; previousPath: string; path: string }): Promise<void> {
  const root = await canonicalizeContainmentRoot(expandHomePath(input.workspaceRoot))
  const previousPath = await resolveContainedPath({ root: input.workspaceRoot, target: input.previousPath, expect: 'any', rejectFinalLink: true })
  const nextPath = await resolveContainedPath({ root: input.workspaceRoot, target: input.path, expect: 'any', rejectFinalLink: true })
  if (previousPath === nextPath) return
  const metadataRoot = resolve(root, '.workwise')
  try {
    const info = await lstat(metadataRoot)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Document sidecar directory must be a regular directory.')
  } catch (error) { if (isMissing(error)) return; throw error }
  for (const kind of ['document-history', 'document-comments']) {
    const base = resolve(metadataRoot, kind)
    let directories
    try {
      await resolveContainedPath({ root, target: base, mustExist: true, expect: 'directory', rejectFinalLink: true })
      directories = await readdir(base, { withFileTypes: true })
    } catch (error) { if (isMissing(error)) continue; throw error }
    for (const directory of directories) {
      if (!directory.isDirectory() || !/^[a-f0-9]{64}$/.test(directory.name)) continue
      const sourceDirectory = resolve(base, directory.name)
      const files = await readdir(sourceDirectory, { withFileTypes: true })
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue
        if (kind === 'document-history' ? !HISTORY_ID.test(file.name.slice(0, -5)) : !COMMENT_ID.test(file.name.slice(0, -5))) continue
        const record = JSON.parse((await readRegularFile(resolve(sourceDirectory, file.name), MAX_SIDECAR_BYTES)).content) as DocumentHistoryEntry | DocumentComment
        if (typeof record.path !== 'string' || !isContained(previousPath, record.path)) continue
        const newDocumentPath = resolve(nextPath, relative(previousPath, record.path))
        if (kind === 'document-history') validateHistoryEntry(record, record.path)
        else validateComment(record, record.path)
        const destination = (await sidecarDirectory(root, kind, newDocumentPath, true))!
        const target = resolve(destination, file.name)
        // The copied record keeps its immutable identity and timestamp. Existing matching
        // IDs may already have arrived via a prior interrupted rename; never replace them.
        try { await lstat(target); continue } catch (error) { if (!isMissing(error)) throw error }
        await atomicWriteFile(target, JSON.stringify({ ...record, path: newDocumentPath }), { beforeReplace: async () => {
          await sidecarDirectory(root, kind, newDocumentPath, false)
          await recheckContainedParent(root, target)
          await resolveContainedPath({ root, target, expect: 'file', rejectFinalLink: true })
        } })
      }
    }
  }
  invalidateWriteDocumentIndex(root)
}

export function parseMarkdownFrontmatter(content: string): FrontmatterParseResult {
  const bomOffset = content.startsWith('\uFEFF') ? 1 : 0
  const normalized = content.slice(bomOffset)
  if (!normalized.startsWith('---')) return { data: {}, body: content, raw: '', startOffset: 0, endOffset: 0 }
  const firstBreak = normalized.indexOf('\n')
  if (firstBreak < 0 || normalized.slice(0, firstBreak).trim() !== '---') {
    return { data: {}, body: content, raw: '', startOffset: 0, endOffset: 0 }
  }
  const matcher = /\n(?:---|\.\.\.)[ \t]*\r?(?:\n|$)/g
  matcher.lastIndex = firstBreak
  const match = matcher.exec(normalized)
  if (!match) return { data: {}, body: content, raw: '', startOffset: 0, endOffset: 0, error: 'Frontmatter is not closed.' }
  const endOffset = match.index + match[0].length + bomOffset
  const raw = normalized.slice(firstBreak + 1, match.index)
  try {
    const parsed = parseYaml(raw, { maxAliasCount: 100 })
    if (parsed != null && (typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('Frontmatter must be a YAML field mapping.')
    const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
    return { data, body: content.slice(endOffset), raw, startOffset: bomOffset, endOffset }
  } catch (error) {
    return {
      data: {},
      body: content.slice(endOffset),
      raw,
      startOffset: bomOffset,
      endOffset,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length
}

export function extractMarkdownLinks(content: string, sourcePath: string): MarkdownLink[] {
  const links: MarkdownLink[] = []
  const frontmatter = parseMarkdownFrontmatter(content)
  const mask = (value: string): string => value.replace(/[^\r\n]/g, ' ')
  const body = mask(content.slice(0, frontmatter.endOffset)) + content.slice(frontmatter.endOffset)
  const visible = body.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*(?:\n|$)/gm, mask).replace(/(`+)[\s\S]*?\1/g, mask)
  const markdownPattern = /!?(?:\[([^\]]*)\])\((<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\)/g
  for (const match of visible.matchAll(markdownPattern)) {
    const target = match[2].trim().replace(/^<|>$/g, '')
    if (!target || /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(target)) continue
    links.push({ sourcePath, target, label: match[1] || undefined, kind: 'markdown', line: lineAt(content, match.index ?? 0) })
  }
  const wikiPattern = /!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g
  for (const match of visible.matchAll(wikiPattern)) {
    const target = match[1].trim()
    if (!target) continue
    links.push({ sourcePath, target, label: match[2]?.trim() || undefined, kind: 'wiki', line: lineAt(content, match.index ?? 0) })
  }
  return links.sort((a, b) => a.line - b.line)
}

export function resolveDocumentLink(sourcePath: string, target: string, workspaceRoot: string): string | null {
  let clean: string
  try { clean = decodeURIComponent(target.split('#', 1)[0].split('?', 1)[0]).trim() } catch { return null }
  if (!clean || clean.includes('\0') || clean.includes('\\') || /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(clean)) return null
  const root = resolve(workspaceRoot)
  const candidate = clean.startsWith('/') ? resolve(root, `.${clean}`) : resolve(dirname(sourcePath), clean)
  if (!isContained(root, candidate)) return null
  return candidate
}

export function buildBacklinks(files: Array<{ path: string; content: string }>, workspaceRoot: string): Map<string, MarkdownLink[]> {
  const result = new Map<string, MarkdownLink[]>()
  for (const file of files) {
    for (const link of extractMarkdownLinks(file.content, file.path)) {
      const target = resolveDocumentLink(file.path, link.target, workspaceRoot)
      if (!target) continue
      const current = result.get(target) ?? []
      current.push(link)
      result.set(target, current)
    }
  }
  return result
}

function documentTitle(path: string, content: string): string {
  const metadata = parseMarkdownFrontmatter(content)
  return typeof metadata.data.title === 'string' ? metadata.data.title : metadata.body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? basename(path)
}

export async function searchWorkspaceDocuments(input: { workspaceRoot: string; query: string; limit?: number }): Promise<WorkspaceSearchResponse> {
  const root = await canonicalizeContainmentRoot(expandHomePath(input.workspaceRoot))
  const query = input.query.trim().toLocaleLowerCase()
  const limit = Math.max(1, Math.min(input.limit ?? 50, MAX_SEARCH_RESULTS))
  const response: WorkspaceSearchResponse = { query: input.query, results: [], indexedFiles: 0, skippedFiles: 0, truncated: false, limits: { maxFiles: WRITE_DOCUMENT_INDEX_LIMITS.maxFiles, maxFileBytes: WRITE_DOCUMENT_INDEX_LIMITS.maxFileBytes, maxResults: limit } }
  if (!query) return response
  const index = await loadWriteDocumentIndex(root, { forceRefresh: true })
  response.skippedFiles = index.skippedFiles
  response.truncated = index.truncated
  for (const { path, content } of index.documents.filter((document) => document.markdown)) {
    response.indexedFiles++
    const title = documentTitle(path, content)
    const relativePath = relative(root, path)
    const lines = content.split(/\r?\n/)
    let matchedBody = false
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index].toLocaleLowerCase().includes(query)) continue
      matchedBody = true
      if (response.results.length >= limit) { response.truncated = true; continue }
      response.results.push({ path, relativePath, title, line: index + 1, snippet: lines[index].trim().slice(0, 320) })
    }
    if (!matchedBody && (relativePath.toLocaleLowerCase().includes(query) || title.toLocaleLowerCase().includes(query))) {
      if (response.results.length >= limit) response.truncated = true
      else response.results.push({ path, relativePath, title, line: 1, snippet: lines.find((line) => line.trim())?.slice(0, 320) ?? relativePath })
    }
  }
  return response
}

export async function getDocumentSemantics(input: DocumentSemanticsPayload): Promise<DocumentSemantics> {
  const target = await documentTarget(input.path, input.workspaceRoot)
  const content = input.content ?? (await readDocumentSnapshot(target.path, target.root)).content
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('Document exceeds the semantic analysis limit.')
  const index = await loadWriteDocumentIndex(target.root, { forceRefresh: true })
  const files: Array<{ path: string; content: string }> = index.documents.filter((document) => document.markdown).map((document) => ({ path: document.path, content: document.path === target.path ? content : document.content }))
  if (!files.some((file) => file.path === target.path)) files.push({ path: target.path, content })
  const knownPaths = new Set(files.map((file) => file.path))
  const outgoing: DocumentSemantics['outgoing'] = []
  const backlinks: MarkdownLink[] = []
  const edges: DocumentSemantics['relations']['edges'] = []
  for (const file of files) for (const link of extractMarkdownLinks(file.content, file.path)) {
    let resolvedPath = resolveDocumentLink(file.path, link.target, target.root)
    let status: 'valid' | 'broken' | 'unsafe' = resolvedPath ? 'broken' : 'unsafe'
    if (resolvedPath) {
      if (link.kind === 'wiki' && !extname(resolvedPath)) {
        resolvedPath = ['.md', '.markdown', '.mdx'].map((extension) => `${resolvedPath}${extension}`).find((candidate) => knownPaths.has(candidate)) ?? `${resolvedPath}.md`
      }
      try {
        resolvedPath = await resolveContainedPath({ root: target.root, target: resolvedPath, mustExist: true, expect: 'file', rejectFinalLink: true })
        status = 'valid'
      } catch (error) { status = isMissing(error) ? 'broken' : 'unsafe' }
    }
    if (file.path === target.path) outgoing.push({ ...link, resolvedPath, status })
    if (resolvedPath && status === 'valid') {
      if (resolvedPath === target.path && file.path !== target.path) backlinks.push(link)
      if (knownPaths.has(resolvedPath)) edges.push({ from: file.path, to: resolvedPath, line: link.line })
    }
  }
  return { frontmatter: parseMarkdownFrontmatter(content), outgoing, backlinks, relations: { nodes: files.map((file) => ({ path: file.path, title: documentTitle(file.path, file.content) })), edges, truncated: index.truncated, skippedFiles: index.skippedFiles } }
}
