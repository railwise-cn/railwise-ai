import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { invalidateWriteDocumentIndex, loadWriteDocumentIndex, WRITE_DOCUMENT_INDEX_LIMITS } from './write-document-index'

const roots: string[] = []
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'railwise-document-index-'))
  roots.push(root)
  return root
}
afterEach(async () => {
  invalidateWriteDocumentIndex()
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('shared local document index', () => {
  it('indexes beyond the previous 160-file ceiling and includes text for AI while marking Markdown', async () => {
    const root = await workspace()
    await Promise.all(Array.from({ length: 180 }, (_, index) => writeFile(join(root, `${String(index).padStart(3, '0')}.md`), `# File ${index}\nComplete source ${index}`)))
    await writeFile(join(root, 'plain.txt'), 'Plain source')
    await writeFile(join(root, 'ignored.jsonl'), 'not a writing document')
    const result = await loadWriteDocumentIndex(root)
    expect(result.workspaceRoot).toBe(await realpath(root))
    expect(result.documents).toHaveLength(181)
    expect(result.documents.find((document) => document.relativePath === '179.md')?.content).toContain('Complete source 179')
    expect(result.documents.find((document) => document.relativePath === 'plain.txt')?.markdown).toBe(false)
    expect(result.truncated).toBe(false)
    expect(result.limits.maxFiles).toBe(20_000)
  })

  it('shares cached content, refreshes external edit/rename/delete, and invalidates internal writes', async () => {
    const root = await workspace()
    const path = join(root, 'draft.md')
    await writeFile(path, 'original')
    const first = await loadWriteDocumentIndex(root)
    const parallel = await Promise.all([loadWriteDocumentIndex(root), loadWriteDocumentIndex(root)])
    expect(parallel[0]).toBe(first)
    expect(parallel[1]).toBe(first)
    await writeFile(path, 'externally edited content')
    const refreshed = await loadWriteDocumentIndex(root, { forceRefresh: true })
    expect(refreshed.documents[0].content).toBe('externally edited content')
    await rename(path, join(root, 'moved.md'))
    const renamed = await loadWriteDocumentIndex(root, { forceRefresh: true })
    expect(renamed.documents.map((document) => document.relativePath)).toEqual(['moved.md'])
    await rm(join(root, 'moved.md'))
    await writeFile(path, 'internal write')
    invalidateWriteDocumentIndex(root)
    expect((await loadWriteDocumentIndex(root)).documents[0].content).toBe('internal write')
    expect(await readFile(path, 'utf8')).toBe('internal write')
  })

  it('does not read symlink files/directories, generated folders or binary documents', async () => {
    const root = await workspace()
    const external = await workspace()
    await writeFile(join(root, 'valid.md'), 'safe')
    await writeFile(join(external, 'secret.md'), 'sensitive')
    await symlink(join(external, 'secret.md'), join(root, 'linked.md'))
    await symlink(external, join(root, 'outside'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'package.md'), 'generated')
    await writeFile(join(root, 'binary.md'), Buffer.from([65, 0, 66]))
    const result = await loadWriteDocumentIndex(root)
    expect(result.documents.map((document) => document.relativePath)).toEqual(['valid.md'])
    expect(result.skippedFiles).toBeGreaterThanOrEqual(3)
  })

  it('skips oversized documents completely and reports the limit instead of indexing a truncated prefix', async () => {
    const root = await workspace()
    await writeFile(join(root, 'huge.md'), 'x'.repeat(WRITE_DOCUMENT_INDEX_LIMITS.maxFileBytes + 1))
    await writeFile(join(root, 'small.md'), 'complete')
    const result = await loadWriteDocumentIndex(root)
    expect(result.documents.map((document) => document.relativePath)).toEqual(['small.md'])
    expect(result.skippedFiles).toBe(1)
    expect(result.truncated).toBe(true)
  })
})
