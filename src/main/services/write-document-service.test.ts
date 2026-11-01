import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildBacklinks,
  computeDocumentRevision,
  createDocumentComment,
  extractMarkdownLinks,
  getDocumentHistoryEntry,
  getDocumentSemantics,
  listDocumentComments,
  listDocumentHistory,
  parseMarkdownFrontmatter,
  resolveDocumentLink,
  readDocumentSnapshot,
  relocateDocumentSidecars,
  restoreDocumentHistory,
  searchWorkspaceDocuments,
  updateDocumentComment,
  writeDocumentChecked
} from './write-document-service'

describe('write document semantics', () => {
  it('parses YAML frontmatter without losing the document body', () => {
    const result = parseMarkdownFrontmatter('---\ntitle: Hello\ntags:\n  - one\n---\n# Body')
    expect(result.data).toEqual({ title: 'Hello', tags: ['one'] })
    expect(result.body).toBe('# Body')
    expect(result.error).toBeUndefined()
  })

  it('reports unclosed frontmatter', () => {
    const result = parseMarkdownFrontmatter('---\ntitle: Hello\n# Body')
    expect(result.error).toContain('not closed')
  })

  it('extracts and resolves relative markdown and wiki links', () => {
    const source = '/tmp/workspace/docs/spec.md'
    const links = extractMarkdownLinks('[Plan](../plan.md) and [[../notes.md|Notes]]', source)
    expect(links).toHaveLength(2)
    expect(resolveDocumentLink(source, links[0].target, '/tmp/workspace')).toBe('/tmp/workspace/plan.md')
    expect(resolveDocumentLink(source, links[1].target, '/tmp/workspace')).toBe('/tmp/workspace/notes.md')
  })

  it('builds backlinks and refuses links that escape the workspace', () => {
    const root = '/tmp/workspace'
    const files = [
      { path: `${root}/a.md`, content: '[B](./b.md)' },
      { path: `${root}/b.md`, content: '[outside](../../secret.md)' }
    ]
    const backlinks = buildBacklinks(files, root)
    expect(backlinks.get(`${root}/b.md`)).toHaveLength(1)
    expect(resolveDocumentLink(`${root}/b.md`, '../../secret.md', root)).toBeNull()
  })

  it('searches markdown documents with line and path context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-doc-search-'))
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'nested', 'spec.md'), '# Specification\ncritical settlement threshold\n', 'utf8')
    const result = await searchWorkspaceDocuments({ workspaceRoot: root, query: 'settlement' })
    expect(result.results[0]).toMatchObject({ relativePath: 'nested/spec.md', line: 2, title: 'Specification' })
  })

  it('rejects stale checked writes and preserves current content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-doc-write-'))
    const path = join(root, 'draft.md')
    await writeFile(path, 'old', 'utf8')
    const stale = computeDocumentRevision('different', { size: 9, modifiedAt: 0 })
    const result = await writeDocumentChecked({ path, workspaceRoot: root, content: 'new', expectedRevision: stale })
    expect(result.ok).toBe(false)
    if (!result.ok && 'conflict' in result) {
      expect(result.conflict.currentContent).toBe('old')
      expect(result.conflict.attemptedContent).toBe('new')
    }
    expect(await readFile(path, 'utf8')).toBe('old')
  })

  it('treats a null baseline as expecting a missing file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-doc-create-'))
    const path = join(root, 'new.md')
    const created = await writeDocumentChecked({ path, workspaceRoot: root, content: 'created', expectedRevision: null })
    expect(created.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('created')
    const conflict = await writeDocumentChecked({ path, workspaceRoot: root, content: 'overwrite', expectedRevision: null })
    expect(conflict.ok).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('created')
  })

  it('reports external deletion without silently recreating an opened file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'railwise-doc-delete-'))
    const path = join(root, 'draft.md')
    await writeFile(path, 'previous', 'utf8')
    const revision = computeDocumentRevision('previous')
    const { unlink } = await import('node:fs/promises')
    await unlink(path)
    const result = await writeDocumentChecked({ path, workspaceRoot: root, content: 'draft', expectedRevision: revision })
    expect(result.ok).toBe(false)
    if (!result.ok && 'conflict' in result) expect(result.conflict.currentContent).toBeNull()
    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('persists snapshots and restores by appending without discarding later history', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'railwise-doc-history-'))
    const path = join(workspaceRoot, 'draft.md')
    await writeFile(path, 'version one')
    const original = await readDocumentSnapshot(path, workspaceRoot)
    const second = await writeDocumentChecked({ path, workspaceRoot, content: 'version two', expectedRevision: original.revision })
    expect(second.ok).toBe(true)
    const before = (await listDocumentHistory({ path, workspaceRoot })).entries
    expect(before.every((entry) => !('content' in entry))).toBe(true)
    const firstSummary = before.find((entry) => entry.revision.fingerprint === original.revision.fingerprint)!
    const firstEntry = await getDocumentHistoryEntry({ path, workspaceRoot, id: firstSummary.id })
    expect(firstEntry.content).toBe('version one')
    const latest = await readDocumentSnapshot(path, workspaceRoot)
    const restored = await restoreDocumentHistory({ path, workspaceRoot, id: firstEntry.id, expectedRevision: latest.revision })
    expect(restored.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('version one')
    const after = (await listDocumentHistory({ path, workspaceRoot })).entries
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.map((entry) => entry.id)).toEqual(expect.arrayContaining(before.map((entry) => entry.id)))
    expect(after.find((entry) => entry.source === 'restore')?.revision.fingerprint).toBe(original.revision.fingerprint)
    await expect(getDocumentHistoryEntry({ path, workspaceRoot, id: '../../secret' })).rejects.toThrow('Invalid history')
  })

  it('serializes competing saves so only one caller with the same baseline succeeds', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'railwise-doc-race-'))
    const path = join(workspaceRoot, 'draft.md')
    await writeFile(path, 'baseline')
    const baseline = await readDocumentSnapshot(path, workspaceRoot)
    const results = await Promise.all([
      writeDocumentChecked({ path, workspaceRoot, content: 'first', expectedRevision: baseline.revision }),
      writeDocumentChecked({ path, workspaceRoot, content: 'second', expectedRevision: baseline.revision })
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok && 'conflict' in result)).toHaveLength(1)
    const winner = results.find((result) => result.ok)
    if (winner?.ok) expect(await readFile(path, 'utf8')).toBe(winner.snapshot.content)
  })

  it('does not mistake non-file read errors for missing documents', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'railwise-doc-directory-'))
    const path = join(workspaceRoot, 'draft.md')
    await mkdir(path)
    const result = await writeDocumentChecked({ path, workspaceRoot, content: 'new', expectedRevision: null })
    expect(result.ok).toBe(false)
    if (!result.ok) expect('message' in result).toBe(true)
    await expect(readDocumentSnapshot(path, workspaceRoot)).rejects.toThrow('regular file')
  })

  it('stores, resolves and reopens anchored comments without editing Markdown', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'railwise-doc-comments-'))
    const path = join(workspaceRoot, 'draft.md')
    await writeFile(path, '# Draft\nreview this phrase')
    const comment = await createDocumentComment({ path, workspaceRoot, text: 'Check the terminology', anchor: { from: 8, to: 14, text: 'review' } })
    expect(comment.status).toBe('open')
    expect(await listDocumentComments({ path, workspaceRoot })).toEqual([comment])
    expect((await updateDocumentComment({ path, workspaceRoot, id: comment.id, status: 'resolved' })).status).toBe('resolved')
    expect((await updateDocumentComment({ path, workspaceRoot, id: comment.id, status: 'open' })).status).toBe('open')
    expect(await readFile(path, 'utf8')).toBe('# Draft\nreview this phrase')
    await expect(createDocumentComment({ path, workspaceRoot, text: 'stale', anchor: { from: 8, to: 14, text: 'wrong!' } })).rejects.toThrow('selected text has changed')
  })

  it('preserves accessible history and comments after renaming a document directory', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'railwise-doc-relocate-'))
    const folder = join(workspaceRoot, 'drafts')
    await mkdir(folder)
    const path = join(folder, 'draft.md')
    await writeFile(path, 'original')
    await writeDocumentChecked({ path, workspaceRoot, content: 'review me', expectedRevision: computeDocumentRevision('original') })
    const comment = await createDocumentComment({ path, workspaceRoot, text: 'check', anchor: { from: 0, to: 6, text: 'review' } })
    const history = (await listDocumentHistory({ path, workspaceRoot })).entries
    const nextFolder = join(workspaceRoot, 'published')
    await relocateDocumentSidecars({ workspaceRoot, previousPath: folder, path: nextFolder })
    await rename(folder, nextFolder)
    const nextDocument = join(nextFolder, 'draft.md')
    expect((await listDocumentHistory({ path: nextDocument, workspaceRoot })).entries.map((entry) => entry.id)).toEqual(history.map((entry) => entry.id))
    expect((await listDocumentComments({ path: nextDocument, workspaceRoot }))[0]).toMatchObject({ id: comment.id, path: join(await realpath(workspaceRoot), 'published', 'draft.md') })
    expect((await listDocumentHistory({ path, workspaceRoot })).entries).toHaveLength(history.length)
    expect(await listDocumentComments({ path, workspaceRoot })).toHaveLength(1)
  })

  it('refuses symlink documents, skips them in search and rejects unsafe sidecar links before creation', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'railwise-doc-links-'))
    await writeFile(join(workspaceRoot, 'real.md'), 'find me')
    const path = join(workspaceRoot, 'linked.md')
    await symlink(join(workspaceRoot, 'real.md'), path)
    const write = await writeDocumentChecked({ path, workspaceRoot, content: 'overwrite' })
    expect(write.ok).toBe(false)
    const search = await searchWorkspaceDocuments({ workspaceRoot, query: 'find me' })
    expect(search.indexedFiles).toBe(1)
    expect(search.skippedFiles).toBe(1)
    await mkdir(join(workspaceRoot, 'hidden'))
    await symlink(join(workspaceRoot, 'hidden'), join(workspaceRoot, '.workwise'))
    const newPath = join(workspaceRoot, 'new.md')
    expect((await writeDocumentChecked({ path: newPath, workspaceRoot, content: 'new', expectedRevision: null })).ok).toBe(false)
    await expect(readFile(newPath)).rejects.toThrow()
    expect(await readFile(join(workspaceRoot, 'real.md'), 'utf8')).toBe('find me')
  })

  it('returns frontmatter, broken and unsafe links, backlinks, and workspace relations for an unsaved buffer', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'railwise-doc-relations-'))
    const path = join(workspaceRoot, 'a.md')
    await writeFile(path, '# Original')
    await writeFile(join(workspaceRoot, 'b.md'), '# Destination\n[A](./a.md)')
    const result = await getDocumentSemantics({ path, workspaceRoot, content: '---\ntitle: New title\n---\n[B](./b.md)\n[missing](missing.md)\n[escape](%2e%2e/outside.md)\n`[code](ignored.md)`\n```md\n[example](ignored.md)\n```\n[[b]]' })
    expect(result.frontmatter.data.title).toBe('New title')
    expect(result.outgoing.map((link) => link.status)).toEqual(['valid', 'broken', 'unsafe', 'valid'])
    expect(result.backlinks).toHaveLength(1)
    expect(result.relations.nodes).toHaveLength(2)
    const canonicalPath = join(await realpath(workspaceRoot), 'a.md')
    expect(result.relations.nodes.find((node) => node.path === canonicalPath)?.title).toBe('New title')
    expect(result.relations.edges).toHaveLength(3)
  })

  it('validates frontmatter mapping shapes and preserves BOM/CRLF body offsets', () => {
    expect(parseMarkdownFrontmatter('---\n- invalid\n---\nbody').error).toContain('mapping')
    const content = '\uFEFF---\r\ntitle: Hello\r\n---\r\n  body'
    const parsed = parseMarkdownFrontmatter(content)
    expect(parsed.body).toBe('  body')
    expect(content.slice(parsed.endOffset)).toBe(parsed.body)
  })

  it('searches document paths and frontmatter titles and reports omitted matches', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'railwise-doc-search-limit-'))
    await writeFile(join(workspaceRoot, 'settlement.md'), '# Other heading\nfirst match\nsecond match')
    await writeFile(join(workspaceRoot, 'notes.md'), '---\ntitle: Special heading\n---\nNo other match')
    const pathResult = await searchWorkspaceDocuments({ workspaceRoot, query: 'settlement' })
    expect(pathResult.results[0].relativePath).toBe('settlement.md')
    const titleResult = await searchWorkspaceDocuments({ workspaceRoot, query: 'special heading' })
    expect(titleResult.results[0].title).toBe('Special heading')
    const capped = await searchWorkspaceDocuments({ workspaceRoot, query: 'match', limit: 1 })
    expect(capped.results).toHaveLength(1)
    expect(capped.indexedFiles).toBe(2)
    expect(capped.truncated).toBe(true)
    expect(capped.limits.maxResults).toBe(1)
  })
})
