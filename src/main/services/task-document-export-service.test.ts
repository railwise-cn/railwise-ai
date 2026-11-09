import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getAppPath: () => '/tmp/railwise-test' }, BrowserWindow: class {}, clipboard: {}, dialog: {} }))
vi.mock('./write-advanced-renderer', async original => ({ ...await original<typeof import('./write-advanced-renderer')>(), renderWriteMermaidDiagrams: vi.fn(async () => new Map()) }))
import { exportTaskDocument, startTaskDocumentExportBridge } from './task-document-export-service'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'railwise-task-export-')); roots.push(workspaceRoot)
  const sourcePath = join(workspaceRoot, '.workwise', 'delivery-candidates', 'task1', 'report.md')
  await mkdir(join(sourcePath, '..'), { recursive: true })
  const content = '# 合成监测报告\n\n| 日期 | 位移 |\n|---|---|\n| 11-01 | 1.2 |\n\n```text\n合成资料\n```\n'
  await writeFile(sourcePath, content)
  return { workspaceRoot, sourcePath, targetPath: sourcePath.replace('.md', '.docx'), format: 'docx' as const, expectedHash: createHash('sha256').update(content).digest('hex'), idempotencyKey: 'docx' }
}
it('exports a real DOCX through Write and replays without touching the file', async () => {
  const input = await fixture()
  const result = await exportTaskDocument(input)
  expect(result.ok).toBe(true)
  const zip = await JSZip.loadAsync(await readFile(result.path))
  expect(await zip.file('word/document.xml')!.async('string')).toContain('合成监测报告')
  expect(await zip.file('docProps/core.xml')!.async('string')).toContain('RailWise AI')
  expect(await exportTaskDocument(input)).toEqual(result)
  await writeFile(result.path, 'External edit')
  await expect(exportTaskDocument(input)).rejects.toThrow(/modified/)
})
it('rejects stale sources, escape paths and overwriting existing exports', async () => {
  const input = await fixture()
  await expect(exportTaskDocument({ ...input, expectedHash: '0'.repeat(64) })).rejects.toThrow(/changed/)
  await expect(exportTaskDocument({ ...input, targetPath: join(input.workspaceRoot, 'report.docx') })).rejects.toThrow(/task directory/)
  await writeFile(input.targetPath, 'Existing file')
  await expect(exportTaskDocument(input)).rejects.toThrow()
  expect(await readFile(input.targetPath, 'utf8')).toBe('Existing file')
})
it('requires the private capability before accepting local export requests', async () => {
  const bridge = await startTaskDocumentExportBridge()
  try {
    const input = await fixture()
    expect((await fetch(bridge.url, { method: 'POST', body: JSON.stringify(input) })).status).toBe(401)
    const result = await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ ...input, format: 'html', targetPath: input.targetPath.replace('.docx', '.html') }) })
    expect(result.status).toBe(200)
    const body = await result.json() as { path: string }
    expect(await readFile(body.path, 'utf8')).toContain('合成监测报告')
    const lookup = new URL(bridge.url)
    lookup.search = new URLSearchParams({ workspaceRoot: input.workspaceRoot, sourcePath: input.sourcePath, idempotencyKey: input.idempotencyKey }).toString()
    const receipt = await fetch(lookup, { headers: { authorization: `Bearer ${bridge.token}` } })
    expect(receipt.status).toBe(200)
    expect(await receipt.json()).toEqual(body)
    await writeFile(body.path, 'Changed after export')
    expect((await fetch(lookup, { headers: { authorization: `Bearer ${bridge.token}` } })).status).toBe(409)
  } finally { await bridge.close() }
})
