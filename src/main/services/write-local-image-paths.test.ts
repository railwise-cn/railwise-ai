import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'

vi.mock('electron', () => ({ app: { getAppPath: () => '/tmp/workwise-test-app' }, BrowserWindow: class {}, clipboard: { write: vi.fn() }, dialog: { showSaveDialog: vi.fn() } }))
import { createWriteMarkdownIt } from '../../shared/write-advanced-markdown'
import { resolveWriteMarkdownResourcePath } from '../../shared/write-markdown-resource'
import { readWorkspaceImage } from './workspace-service'
import { buildWriteExportHtmlDocument } from './write-export-service'
import { buildDocxFromMarkdown } from './write-docx-service'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJYfWQAAAABJRU5ErkJggg==', 'base64')

describe('local image paths across Markdown preview and exports', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'write-image-paths-'))
    await Promise.all([mkdir(join(root, 'docs')), mkdir(join(root, 'assets'))])
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  for (const name of ['监测 图.png', 'literal%41.png', '100%.png', 'space #?.png']) {
  it.skipIf(process.platform === 'win32' && name.includes('?'))(`loads ${name} from parser output in preview, HTML/PDF input and DOCX`, async () => {
    const imagePath = join(root, 'assets', name)
    await writeFile(imagePath, png)
    const sourcePath = join(root, 'docs', '报告.md')
    const markdown = `![监测图](../assets/${encodeURIComponent(name)})`
    const tokens = createWriteMarkdownIt().parse(markdown, {})
    const src = tokens.flatMap((token) => token.children ?? []).find((token) => token.type === 'image')!.attrGet('src')!
    const localPath = resolveWriteMarkdownResourcePath(src, sourcePath)
    expect(localPath).toBe(imagePath)
    expect(await readWorkspaceImage({ path: localPath!, workspaceRoot: root })).toMatchObject({ ok: true, dataUrl: `data:image/png;base64,${png.toString('base64')}` })
    // PDF receives this same self-contained HTML; actual printed layout is checked on the package.
    const html = await buildWriteExportHtmlDocument({ sourcePath, content: markdown, workspaceRoot: root })
    expect(html).toContain(`src="data:image/png;base64,${png.toString('base64')}"`)
    expect(html).not.toContain('src=""')
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath, content: markdown, workspaceRoot: root }))
    const media = Object.keys(zip.files).filter((entry) => /^word\/media\/[^/]+\.png$/.test(entry))
    expect(media).toHaveLength(1)
    expect(await zip.file(media[0])!.async('nodebuffer')).toEqual(png)
  })
  }

  it.skipIf(process.platform === 'win32')('keeps canonical workspace and symlink restrictions after decoding', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'write-image-outside-'))
    try {
      await writeFile(join(outside, '外部 图.png'), png)
      await symlink(join(outside, '外部 图.png'), join(root, 'assets', '链接 图.png'))
      const sourcePath = join(root, 'docs', '报告.md')
      const markdown = `![link](../assets/${encodeURIComponent('链接 图.png')})\n\n![outside](${encodeURI(join(outside, '外部 图.png'))})`
      const html = await buildWriteExportHtmlDocument({ sourcePath, content: markdown, workspaceRoot: root })
      expect(html).not.toContain('data:image/png;base64,')
      expect(html.match(/src=""/g)).toHaveLength(2)
      const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath, content: markdown, workspaceRoot: root }))
      expect(Object.keys(zip.files).filter((entry) => /^word\/media\/[^/]+$/.test(entry))).toHaveLength(0)
    } finally { await rm(outside, { recursive: true, force: true }) }
  })

  it.skipIf(process.platform === 'win32')('does not reinterpret encoded protocols or separators as local filenames in an export fallback', async () => {
    await writeFile(join(root, 'docs', 'https:example.png'), png)
    await writeFile(join(root, 'assets', 'image.png'), png)
    const sourcePath = join(root, 'docs', '报告.md')
    const content = '![protocol](https%3Aexample.png)\n\n![separator](..%2Fassets%2Fimage.png)'
    const html = await buildWriteExportHtmlDocument({ sourcePath, content, workspaceRoot: root })
    expect(html).not.toContain('data:image/png;base64,')
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath, content, workspaceRoot: root }))
    expect(Object.keys(zip.files).filter((entry) => /^word\/media\/[^/]+$/.test(entry))).toHaveLength(0)
  })
})
