import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import JSZip from 'jszip'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getAppPath: () => '/tmp/railwise-test' }, BrowserWindow: class {}, clipboard: {}, dialog: {} }))
vi.mock('./write-advanced-renderer', async original => ({ ...await original<typeof import('./write-advanced-renderer')>(), renderWriteMermaidDiagrams: vi.fn(async () => new Map()), renderWriteSvgImage: vi.fn(async () => ({ png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJYfWQAAAABJRU5ErkJggg==', 'base64'), width: 1, height: 1 })) }))
import { exportTaskDocument, lookupTaskDocumentExport, startTaskDocumentExportBridge } from './task-document-export-service'
import { renderWriteSvgImage } from './write-advanced-renderer'
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
it('embeds a workspace SVG chart as a real DOCX media image through the local rasterizer', async () => {
  const input = await fixture()
  await mkdir(join(input.workspaceRoot, 'deliverables', 'charts'), { recursive: true })
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><text x="20" y="30">监测趋势</text></svg>'
  await writeFile(join(input.workspaceRoot, 'deliverables', 'charts', 'trend.svg'), svg)
  const content = '# 合成监测报告\n\n![监测趋势](../../../deliverables/charts/trend.svg)\n'
  await writeFile(input.sourcePath, content)
  const result = await exportTaskDocument({ ...input, expectedHash: createHash('sha256').update(content).digest('hex') })
  const zip = await JSZip.loadAsync(await readFile(result.path))
  expect(Object.keys(zip.files).filter(path => path.startsWith('word/media/') && !zip.files[path].dir)).toHaveLength(1)
  expect(await zip.file('word/document.xml')!.async('string')).toContain('<w:drawing>')
  expect(await zip.file('word/document.xml')!.async('string')).not.toContain('[Image:')
  expect(renderWriteSvgImage).toHaveBeenCalledWith(svg)
})

it.each(['docx', 'html', 'pdf'] as const)('fails strict %s export for missing and out-of-workspace images without a success receipt', async format => {
  for (const kind of ['missing', 'outside']) {
    const input = await fixture()
    let reference = '../../../missing-chart.png'
    if (kind === 'outside') {
      const outside = await mkdtemp(join(tmpdir(), 'railwise-outside-image-')); roots.push(outside)
      const image = join(outside, 'private.png')
      await writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJYfWQAAAABJRU5ErkJggg==', 'base64'))
      reference = relative(dirname(input.sourcePath), image).split(sep).join('/')
    }
    const content = `# 合成资料\n\n![必需图表](${reference})\n`
    await writeFile(input.sourcePath, content)
    const request = { ...input, format, targetPath: input.targetPath.replace('.docx', `.${format}`), expectedHash: createHash('sha256').update(content).digest('hex') }
    await expect(exportTaskDocument(request)).rejects.toMatchObject({ code: 'write_export_image_unavailable' })
    await expect(readFile(request.targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await lookupTaskDocumentExport({ workspaceRoot: request.workspaceRoot, sourcePath: request.sourcePath, idempotencyKey: request.idempotencyKey })).toBeNull()
  }
})

it('fails strict DOCX export when passive SVG rasterization fails', async () => {
  const input = await fixture()
  await writeFile(input.sourcePath.replace('report.md', 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')
  const content = '# 合成资料\n\n![图表](./chart.svg)'
  await writeFile(input.sourcePath, content)
  vi.mocked(renderWriteSvgImage).mockResolvedValueOnce(null)
  await expect(exportTaskDocument({ ...input, expectedHash: createHash('sha256').update(content).digest('hex') })).rejects.toMatchObject({ code: 'write_export_image_unavailable' })
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
