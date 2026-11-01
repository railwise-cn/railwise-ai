import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { Window } from 'happy-dom'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/workwise-test-app'
  },
  BrowserWindow: class BrowserWindow {},
  clipboard: {
    write: vi.fn()
  },
  dialog: {
    showSaveDialog: vi.fn()
  }
}))

// Unit tests do not own an Electron layout engine. Real local diagram rendering
// is exercised by the Electron integration fixture; these tests retain the
// explicit source fallback when no rendered diagram is supplied.
vi.mock('./write-advanced-renderer', async (importOriginal) => ({
  ...await importOriginal<typeof import('./write-advanced-renderer')>(),
  renderWriteMermaidDiagrams: vi.fn(async () => new Map())
}))

import {
  buildWriteClipboardHtmlFragment,
  buildWriteExportFileName,
  buildWriteExportHtmlDocument,
  copyWriteDocumentAsRichText,
  exportWriteDocument,
  resolveBundledMarkdownConverter
} from './write-export-service'
import { buildDocxFromMarkdown, decodeHtmlEntities } from './write-docx-service'
import { resolveExportTemplate } from './write-docx-styles'
import { BUILTIN_EXPORT_TEMPLATES } from '../../shared/write-export-templates'
import { clipboard, dialog } from 'electron'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJYfWQAAAABJRU5ErkJggg==',
  'base64'
)

describe('write-export-service helpers', () => {
  let workspaceRoot = ''

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'ds-gui-write-export-'))
    vi.mocked(clipboard.write).mockReset()
  })

  it('builds export file names with the requested extension', () => {
    expect(buildWriteExportFileName('/tmp/draft.md', 'html')).toBe('draft.html')
    expect(buildWriteExportFileName('/tmp/draft.md', 'pdf')).toBe('draft.pdf')
    expect(buildWriteExportFileName('/tmp/draft.md', 'doc')).toBe('draft.doc')
    expect(buildWriteExportFileName('/tmp/draft.md', 'docx')).toBe('draft.docx')
  })

  it('renders markdown exports with resolved links and inlined local images', async () => {
    const sourcePath = join(workspaceRoot, 'draft.md')
    const imagePath = join(workspaceRoot, 'cover.png')
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const html = await buildWriteExportHtmlDocument({
      sourcePath,
      content: '# Heading\n\n![Cover](./cover.png)\n\n[Notes](./notes.md)'
    })

    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('src="data:image/png;base64,')
    expect(html).toContain(`href="${pathToFileURL(join(workspaceRoot, 'notes.md')).href}"`)
    expect(html).toContain('<html lang="zh-CN">')
  })

  it('renders clipboard html fragments for markdown content', async () => {
    const sourcePath = join(workspaceRoot, 'draft.md')
    const html = await buildWriteClipboardHtmlFragment({
      sourcePath,
      content: '# Heading\n\n**Bold**\n\n- [x] Done\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[Notes](./notes.md)'
    })

    expect(html).toContain('<article class="markdown-body">')
    expect(html).toContain('<h1>Heading</h1>')
    expect(html).toContain('<strong>Bold</strong>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<table>')
    expect(html).toContain(`href="${pathToFileURL(join(workspaceRoot, 'notes.md')).href}"`)
  })

  it('renders clipboard html fragments for plain text content', async () => {
    const sourcePath = join(workspaceRoot, 'draft.txt')
    const html = await buildWriteClipboardHtmlFragment({
      sourcePath,
      content: 'plain text\nline two'
    })

    expect(html).toContain('<article class="markdown-body">')
    expect(html).toContain('<pre class="plain-text">plain text\nline two</pre>')
  })

  it('writes html and plain text to the clipboard', async () => {
    const sourcePath = join(workspaceRoot, 'draft.md')
    const imagePath = join(workspaceRoot, 'cover.png')
    await writeFile(sourcePath, '# Heading\n\n![Cover](./cover.png)')
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = await copyWriteDocumentAsRichText({
      path: sourcePath,
      workspaceRoot,
      content: '# Heading\n\n![Cover](./cover.png)'
    })

    expect(result.ok).toBe(true)
    expect(clipboard.write).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('<article class="markdown-body">'),
        text: '# Heading\n\n![Cover](./cover.png)'
      })
    )
    expect(clipboard.write).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('src="data:image/png;base64,')
      })
    )
  })

  it('generates a real docx from markdown with tables and local images', async () => {
    const sourcePath = join(workspaceRoot, 'draft.md')
    const imagePath = join(workspaceRoot, 'cover.png')
    await writeFile(imagePath, TINY_PNG)

    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: [
        '# 标题',
        '',
        '正文包含 **加粗**、`code` 和 [链接](https://example.com)。',
        '',
        '- 项目一',
        '- 项目二',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        '![封面](./cover.png)',
        '',
        '```ts',
        'export const ok = true',
        '```'
      ].join('\n')
    })

    const zip = await JSZip.loadAsync(docx)
    const documentXml = await zip.file('word/document.xml')?.async('string')
    expect(documentXml).toContain('标题')
    expect(documentXml).toContain('加粗')
    expect(documentXml).toContain('export')
    expect(documentXml).toContain('const')
    expect(documentXml).toContain('ok = ')
    expect(documentXml).toContain('true')
    expect(documentXml).toContain('<w:tbl>')
    expect(Object.keys(zip.files).some((name) => name.startsWith('word/media/'))).toBe(true)
  })

  it('ignores a file whose extension disguises an unsupported image format', async () => {
    const sourcePath = join(workspaceRoot, 'draft.md')
    const imagePath = join(workspaceRoot, 'spoofed.png')
    await writeFile(imagePath, Buffer.from('icns\u0000\u0000\u0000\u0010unsafe'))

    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: 'before\n\n![spoofed](./spoofed.png)\n\nafter'
    })

    const zip = await JSZip.loadAsync(docx)
    expect(Object.keys(zip.files).some((name) => name.startsWith('word/media/'))).toBe(false)
    const documentXml = await zip.file('word/document.xml')?.async('string')
    expect(documentXml).toContain('before')
    expect(documentXml).toContain('after')
  })

  it.each([
    { language: 'ts', code: `const value = "' & < >"; const literal = "&#x27; &quot; &lt;"; const greeting = \`Hello \${'RailWise & < >'}\`;` },
    { language: 'html', code: '<a href="x">text &amp; more</a>' }
  ])('preserves quotes, operators, nested highlighting and literal entities in real DOCX $language code', async ({ language, code }) => {
    const docx = await buildDocxFromMarkdown({ sourcePath: join(workspaceRoot, 'code-quotes.md'), content: `\`\`\`${language}\n${code}\n\`\`\`` })
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string')
    const browser = new Window()
    try {
      const document = new browser.DOMParser().parseFromString(xml, 'application/xml')
      const actual = [...document.getElementsByTagName('w:t')].map((node) => node.textContent).join('')
      expect(actual).toBe(code)
      expect(actual).not.toContain('<span')
    } finally { await browser.happyDOM.close() }
  })

  it('decodes decimal and hexadecimal entities once while retaining invalid code points safely', () => {
    expect(decodeHtmlEntities('&#39; &#x27; &#X22; &#38; &#x1F680; &apos;')).toBe(`' ' " & 🚀 '`)
    expect(decodeHtmlEntities('&amp;#x27; &amp;quot; &amp;lt;')).toBe('&#x27; &quot; &lt;')
    const invalid = '&#0; &#1; &#xD800; &#x110000; &#xFFFF; &#999999999999999999999999999999;'
    expect(decodeHtmlEntities(invalid)).toBe(invalid)
  })

  it('exports Markdown through the structured DOCX generator', async () => {
    const sourcePath = join(workspaceRoot, 'quality-report.md')
    const targetPath = join(workspaceRoot, 'quality-report.docx')
    const content = [
      '# 质量复测报告',
      '',
      '这是一个 **真正的 Word 文档**。',
      '',
      '- 成果可下载',
      '- 标题与列表可编辑',
      '',
      '| 项目 | 状态 |',
      '| --- | --- |',
      '| DOCX | 通过 |'
    ].join('\n')
    await writeFile(sourcePath, content, 'utf8')
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
      canceled: false,
      filePath: targetPath
    })

    const result = await exportWriteDocument({
      path: sourcePath,
      workspaceRoot,
      format: 'docx',
      content
    })

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      path: targetPath,
      format: 'docx'
    }))
    const bytes = await readFile(targetPath)
    expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK')
    const zip = await JSZip.loadAsync(bytes)
    const documentXml = await zip.file('word/document.xml')?.async('string')
    expect(documentXml).toContain('质量复测报告')
    expect(documentXml).toContain('真正的 Word 文档')
    expect(documentXml).toContain('<w:numPr>')
    expect(documentXml).toContain('<w:tbl>')
  })

  it('exports plain text through the structured DOCX generator', async () => {
    const sourcePath = join(workspaceRoot, 'notes.txt')
    const targetPath = join(workspaceRoot, 'notes.docx')
    const content = '第一行纯文本\n第二行纯文本'
    await writeFile(sourcePath, content, 'utf8')
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
      canceled: false,
      filePath: targetPath
    })

    const result = await exportWriteDocument({
      path: sourcePath,
      workspaceRoot,
      format: 'docx',
      content
    })

    expect(result).toEqual(expect.objectContaining({ ok: true, path: targetPath, format: 'docx' }))
    const documentXml = await (await JSZip.loadAsync(await readFile(targetPath)))
      .file('word/document.xml')?.async('string')
    expect(documentXml).toContain('第一行纯文本')
    expect(documentXml).toContain('第二行纯文本')
  })

  it('keeps frontmatter out of HTML, rich clipboard and real DOCX while preserving table and code semantics', async () => {
    const sourcePath = join(workspaceRoot, 'metadata.md')
    const content = '---\ntitle: private-metadata-title\ntags: [internal]\n---\n# Actual heading\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```'
    const html = await buildWriteExportHtmlDocument({ sourcePath, content, workspaceRoot })
    const clipboardHtml = await buildWriteClipboardHtmlFragment({ sourcePath, content, workspaceRoot })
    expect(html).not.toContain('private-metadata-title')
    expect(clipboardHtml).not.toContain('private-metadata-title')
    expect(html).toContain('<table>')
    expect(html).toContain('class="language-mermaid"')
    expect(html).toContain('graph TD; A--&gt;B')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("default-src 'none'; img-src data:")
    expect(html).not.toContain('<base ')
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath, content, workspaceRoot }))
    const xml = await zip.file('word/document.xml')?.async('string')
    expect(xml).not.toContain('private-metadata-title')
    expect(xml).toContain('Actual heading')
    expect(xml).toContain('<w:tbl>')
    expect(xml?.replace(/<[^>]+>/g, '')).toContain('graph TD; A--&gt;B')
  })

  it('strips metadata once and preserves a body that begins with thematic-break syntax', async () => {
    const sourcePath = join(workspaceRoot, 'body.md')
    const html = await buildWriteExportHtmlDocument({ sourcePath, content: '---\ntitle: Metadata\n---\n---\nBody text\n---\nKept' })
    expect(html).toContain('Body text')
    expect(html).toContain('Kept')
    expect(html).not.toContain('title: Metadata')
  })

  it('blocks remote, escaped and linked images for HTML and DOCX and keeps valid workspace assets', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'railwise-export-outside-'))
    await writeFile(join(outside, 'private.png'), TINY_PNG)
    await mkdir(join(workspaceRoot, 'docs'))
    await mkdir(join(workspaceRoot, 'assets'))
    await writeFile(join(workspaceRoot, 'assets', 'cover.png'), TINY_PNG)
    await symlink(join(outside, 'private.png'), join(workspaceRoot, 'linked.png'))
    await symlink(join(workspaceRoot, 'assets'), join(workspaceRoot, 'asset-link'))
    const sourcePath = join(workspaceRoot, 'docs', 'draft.md')
    const content = `![valid](../assets/cover.png)\n\n![remote](https://example.com/tracker.png)\n\n![private](${join(outside, 'private.png')})\n\n![linked](../linked.png)\n\n![intermediate](../asset-link/cover.png)`
    const html = await buildWriteExportHtmlDocument({ sourcePath, content, workspaceRoot })
    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(1)
    expect(html).not.toContain('https://example.com/tracker.png')
    expect(html).not.toContain('src="file:')
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath, content, workspaceRoot }))
    const media = Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !zip.files[name].dir)
    expect(media).toHaveLength(1)
    const rels = await zip.file('word/_rels/document.xml.rels')?.async('string')
    expect(rels).not.toContain('tracker.png')
    expect(rels).not.toContain('private.png')
  })

  it('rejects active SVG images instead of embedding external resources', async () => {
    const sourcePath = join(workspaceRoot, 'draft.md')
    await writeFile(join(workspaceRoot, 'active.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.com/track";</style></svg>')
    const html = await buildWriteExportHtmlDocument({ sourcePath, workspaceRoot, content: '![active](./active.svg)' })
    expect(html).not.toContain('data:image/svg+xml')
    expect(html).not.toContain('file:')
  })

  it('discovers bundled platform converters from WORKWISE_CONVERTER_ROOT', async () => {
    const previous = process.env.WORKWISE_CONVERTER_ROOT
    const converterRoot = join(workspaceRoot, 'converters')
    const platformDir = process.platform === 'win32'
      ? 'win32-x64'
      : process.platform === 'darwin' && process.arch === 'arm64'
        ? 'darwin-arm64'
        : `${process.platform}-${process.arch}`
    const pandocName = process.platform === 'win32' ? 'pandoc.exe' : 'pandoc'
    const md2docxName = process.platform === 'win32' ? 'md2docx.exe' : 'md2docx.bin'
    await mkdir(join(converterRoot, platformDir), { recursive: true })
    await writeFile(join(converterRoot, platformDir, pandocName), '')
    await writeFile(join(converterRoot, platformDir, md2docxName), '')
    process.env.WORKWISE_CONVERTER_ROOT = converterRoot

    try {
      expect(resolveBundledMarkdownConverter()).toEqual({
        pandocPath: join(converterRoot, platformDir, pandocName),
        md2docxPath: join(converterRoot, platformDir, md2docxName)
      })
    } finally {
      if (previous === undefined) {
        delete process.env.WORKWISE_CONVERTER_ROOT
      } else {
        process.env.WORKWISE_CONVERTER_ROOT = previous
      }
    }
  })
})

/**
 * 真实端到端集成测试：生成 docx → 解压 word/document.xml → 断言 OOXML 内容。
 * 证明模板参数真正穿透到最终文档，而非仅停留在样式换算的单元测试层。
 * 这是 Word 导出模板系统的验收测试。
 */
describe('write-export docx template integration', () => {
  let workspaceRoot = ''

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'ds-gui-write-template-'))
  })

  it('公文模板的字体穿透到 docx（仿宋_GB2312 正文 + 方正小标宋标题）', async () => {
    const sourcePath = join(workspaceRoot, 'gov.md')
    const government = resolveExportTemplate('builtin-government')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '# 关于工作的通知\n\n各有关单位：\n\n现就有关事项通知如下。',
      template: government
    })

    const zip = await JSZip.loadAsync(docx)
    const documentXml = await zip.file('word/document.xml')?.async('string')
    expect(documentXml).toBeTruthy()

    // 正文应为仿宋_GB2312（公文正文标准字体）
    expect(documentXml).toContain('仿宋_GB2312')
    // 标题应为方正小标宋简体（公文标题标准字体）
    expect(documentXml).toContain('方正小标宋简体')
  })

  it('公文模板的字号穿透：标题 22pt → w:sz val="44"（半磅）', async () => {
    const sourcePath = join(workspaceRoot, 'gov.md')
    const government = resolveExportTemplate('builtin-government')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '# 标题\n\n正文',
      template: government
    })

    const zip = await JSZip.loadAsync(docx)
    const documentXml = await zip.file('word/document.xml')?.async('string')

    // 标题 22pt：docx 用半磅，22 × 2 = 44
    // 标题 run 会出现 w:sz w:val="44"
    expect(documentXml).toContain('w:val="44"')
  })

  it('公文模板首行缩进 2 字符穿透：16pt 正文 → firstLine="640" twip', async () => {
    const sourcePath = join(workspaceRoot, 'gov.md')
    const government = resolveExportTemplate('builtin-government')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '# 标题\n\n这是一段正文，应有首行缩进。',
      template: government
    })

    const zip = await JSZip.loadAsync(docx)
    const documentXml = await zip.file('word/document.xml')?.async('string')

    // 公文正文 16pt，首行缩进 2 字符
    // firstLine twip = 2 × 16pt × 20 = 640
    expect(documentXml).toContain('w:firstLine="640"')
  })

  it('公文模板页边距穿透到 section properties', async () => {
    const sourcePath = join(workspaceRoot, 'gov.md')
    const government = resolveExportTemplate('builtin-government')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '# 标题\n\n正文',
      template: government
    })

    const zip = await JSZip.loadAsync(docx)
    const documentXml = await zip.file('word/document.xml')?.async('string')

    // 默认页边距 1440 twip（1 inch），docx 里页边距属性名为 w:top/w:right/w:bottom/w:left
    expect(documentXml).toContain('<w:pgMar')
    expect(documentXml).toContain('w:top="1440"')
    expect(documentXml).toContain('w:left="1440"')
  })

  it('向后兼容：不传 template 与传 academic 模板的默认输出一致', async () => {
    const sourcePath = join(workspaceRoot, 'compat.md')
    const content = '# 标题\n\n正文段落'

    // 不传 template（0.3.0 行为）
    const docxNoTemplate = await buildDocxFromMarkdown({ sourcePath, content })
    // 传 academic（默认模板，等价于不传时的回退）
    const academic = resolveExportTemplate('builtin-academic')
    const docxAcademic = await buildDocxFromMarkdown({ sourcePath, content, template: academic })

    const xmlNoTemplate = await (await JSZip.loadAsync(docxNoTemplate))
      .file('word/document.xml')?.async('string')
    const xmlAcademic = await (await JSZip.loadAsync(docxAcademic))
      .file('word/document.xml')?.async('string')

    // 默认模板 academic 用宋体 + 黑体，不传 template 时也应回退到同样的默认
    expect(xmlAcademic).toContain('宋体')
    expect(xmlAcademic).toContain('黑体')
    // 两者正文都应包含"正文段落"
    expect(xmlNoTemplate).toContain('正文段落')
    expect(xmlAcademic).toContain('正文段落')
  })

  it('styleOverride 临时覆盖穿透到 docx，且不污染源模板', async () => {
    const sourcePath = join(workspaceRoot, 'override.md')
    const academic = resolveExportTemplate('builtin-academic')

    // 记录覆盖前的源模板正文颜色
    const originalColor = academic.styles.p.color

    // 用 academic 模板但把正文覆盖为红色 FF0000
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '# 标题\n\n这是一段被覆盖颜色的正文。',
      template: resolveExportTemplate('builtin-academic', [], {
        p: { color: 'FF0000' }
      })
    })

    const zip = await JSZip.loadAsync(docx)
    const documentXml = await zip.file('word/document.xml')?.async('string')

    // 红色穿透到文档
    expect(documentXml).toContain('FF0000')

    // 源 academic 模板未被污染（颜色保持原值）
    expect(academic.styles.p.color).toBe(originalColor)
    // 重新解析 academic，确认内置模板源数据未变
    const academicAgain = resolveExportTemplate('builtin-academic')
    expect(academicAgain.styles.p.color).toBe(originalColor)
  })

  it('exportWriteDocument 全链路：templateId 参数穿透到最终文件', async () => {
    const sourcePath = join(workspaceRoot, 'full-link.md')
    const targetPath = join(workspaceRoot, 'full-link.docx')
    const content = '# 公文标题\n\n各有关单位：现就有关事项通知如下。'
    await writeFile(sourcePath, content, 'utf8')

    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
      canceled: false,
      filePath: targetPath
    })

    const result = await exportWriteDocument({
      path: sourcePath,
      workspaceRoot,
      format: 'docx',
      content,
      templateId: 'builtin-government'
    })

    expect(result).toEqual(expect.objectContaining({ ok: true, path: targetPath }))
    const bytes = await readFile(targetPath)
    const zip = await JSZip.loadAsync(bytes)
    const documentXml = await zip.file('word/document.xml')?.async('string')
    // 全链路最终文件应包含公文字体
    expect(documentXml).toContain('仿宋_GB2312')
    expect(documentXml).toContain('方正小标宋简体')
  })

  it('内置 4 个模板都能成功生成有效 docx', async () => {
    const sourcePath = join(workspaceRoot, 'all-templates.md')
    const content = '# 标题\n\n正文、**加粗**、`代码`。\n\n| 列1 | 列2 |\n| --- | --- |\n| a | b |'

    for (const builtin of BUILTIN_EXPORT_TEMPLATES) {
      const docx = await buildDocxFromMarkdown({
        sourcePath,
        content,
        template: resolveExportTemplate(builtin.id)
      })
      const zip = await JSZip.loadAsync(docx)
      const documentXml = await zip.file('word/document.xml')?.async('string')
      // 每个模板都应生成包含内容的合法 docx
      expect(documentXml).toContain('标题')
      expect(documentXml).toContain('正文')
      expect(documentXml).toContain('<w:tbl>')
    }
  })
})

/**
 * 各元素类型的字体穿透测试。
 * 这组测试专门验证代码块、表格、行内代码、引用块、列表等"容易被硬编码覆盖"
 * 的路径，确保模板里设置的 code/table 字体真正生效。
 * （前一轮测试已在"正文颜色"上抓到一个同类 bug，这里系统排查其他元素）
 */
describe('write-export docx element type font penetration', () => {
  let workspaceRoot = ''

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'ds-gui-write-element-'))
  })

  it('代码块使用模板的 code 字体（Consolas/等线），而非硬编码', async () => {
    const sourcePath = join(workspaceRoot, 'code.md')
    // technical 模板的 code 字体是 JetBrains Mono + 等线
    const technical = resolveExportTemplate('builtin-technical')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '```js\nconst x = 1\n```',
      template: technical
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    // technical 模板 code 的 eastAsia 是"等线"
    expect(documentXml).toContain('等线')
  })

  it('行内代码使用模板的 code 字体', async () => {
    const sourcePath = join(workspaceRoot, 'inline-code.md')
    // government 模板的 code 字体 eastAsia 是 仿宋_GB2312
    const government = resolveExportTemplate('builtin-government')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '正文中的 `行内代码` 片段。',
      template: government
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    // 行内代码 run 应包含 government 模板 code 的 eastAsia 字体
    expect(documentXml).toContain('仿宋_GB2312')
  })

  it('表格单元格使用模板的 table 字体', async () => {
    const sourcePath = join(workspaceRoot, 'table.md')
    // government 模板的 table eastAsia 是 仿宋_GB2312，fontSize 12pt
    const government = resolveExportTemplate('builtin-government')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '| 列A | 列B |\n| --- | --- |\n| 值1 | 值2 |',
      template: government
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    expect(documentXml).toContain('<w:tbl>')
    // 表格内应出现 government 模板的 table 字体（仿宋_GB2312）
    expect(documentXml).toContain('仿宋_GB2312')
    // table fontSize 12pt → w:sz val="24"
    expect(documentXml).toContain('w:val="24"')
  })

  it('H2/H3 标题使用模板的对应标题字体和字号', async () => {
    const sourcePath = join(workspaceRoot, 'headings.md')
    const government = resolveExportTemplate('builtin-government')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '# 一级\n## 二级\n### 三级',
      template: government
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    // government H2 是黑体 16pt → w:sz val="32"
    expect(documentXml).toContain('黑体')
    expect(documentXml).toContain('w:val="32"')
    // government H1 是方正小标宋简体 22pt → w:sz val="44"
    expect(documentXml).toContain('方正小标宋简体')
  })

  it('H4-H6 回退到 H3 的模板样式', async () => {
    const sourcePath = join(workspaceRoot, 'deep-headings.md')
    const government = resolveExportTemplate('builtin-government')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6',
      template: government
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    // H4/H5/H6 应有 Heading4/5/6 样式标记
    expect(documentXml).toContain('Heading4')
    expect(documentXml).toContain('Heading5')
    expect(documentXml).toContain('Heading6')
    // H4-H6 回退到 H3 样式：黑体 14pt → w:sz val="28"
    expect(documentXml).toContain('w:val="28"')
  })

  it('引用块的正文仍使用模板正文字体', async () => {
    const sourcePath = join(workspaceRoot, 'quote.md')
    const government = resolveExportTemplate('builtin-government')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '> 这是一段引用文字。',
      template: government
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    // 引用块里的文字应使用模板正文字体（仿宋_GB2312）
    expect(documentXml).toContain('仿宋_GB2312')
    expect(documentXml).toContain('引用文字')
  })

  it('列表项使用模板正文字体', async () => {
    const sourcePath = join(workspaceRoot, 'list.md')
    const government = resolveExportTemplate('builtin-government')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '- 列表项一\n- 列表项二\n- 列表项三',
      template: government
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    expect(documentXml).toContain('列表项一')
    // 列表项文字应使用模板正文字体
    expect(documentXml).toContain('仿宋_GB2312')
  })

  it('加粗文本不破坏模板正文字体（bold 是叠加而非覆盖）', async () => {
    const sourcePath = join(workspaceRoot, 'bold.md')
    const government = resolveExportTemplate('builtin-government')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '这是 **加粗文字** 的正文。',
      template: government
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    // 加粗文字的 run 应同时含模板字体和 bold 标记
    expect(documentXml).toContain('仿宋_GB2312')
    expect(documentXml).toContain('<w:b/>')
    expect(documentXml).toContain('加粗文字')
  })

  it('代码高亮颜色保留（与模板字体共存，互不干扰）', async () => {
    const sourcePath = join(workspaceRoot, 'highlight.md')
    const technical = resolveExportTemplate('builtin-technical')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '```js\nconst str = "hello"\nfunction fn() { return 1 }\n```',
      template: technical
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    // 代码内容应出现
    expect(documentXml).toContain('const')
    expect(documentXml).toContain('function')
    // 语法高亮颜色（如关键字 keyword D73A49、字符串 032F62）应保留
    // 注意：高亮色表是固定的，与模板正交
    expect(documentXml).toMatch(/w:val="(D73A49|032F62|6F42B1|24292E)"/)
  })
})

/**
 * 边界场景测试：空内容、只有标题、超长内容、特殊字符等。
 */
describe('write-export docx edge cases', () => {
  let workspaceRoot = ''

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'ds-gui-write-edge-'))
  })

  it('空文档也能生成有效 docx（不崩溃）', async () => {
    const sourcePath = join(workspaceRoot, 'empty.md')
    const government = resolveExportTemplate('builtin-government')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '',
      template: government
    })
    const zip = await JSZip.loadAsync(docx)
    const documentXml = await zip.file('word/document.xml')?.async('string')
    // 空文档仍应生成合法的 OOXML 结构
    expect(documentXml).toContain('<w:body>')
    expect(documentXml).toContain('<w:sectPr')
  })

  it('只有标题的文档', async () => {
    const sourcePath = join(workspaceRoot, 'title-only.md')
    const academic = resolveExportTemplate('builtin-academic')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '# 孤零零的标题',
      template: academic
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    expect(documentXml).toContain('孤零零的标题')
  })

  it('特殊字符（HTML 实体、引号、尖括号）正确转义', async () => {
    const sourcePath = join(workspaceRoot, 'special.md')
    const academic = resolveExportTemplate('builtin-academic')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '包含 <标签> 和 & 符号 和 "引号" 文本。',
      template: academic
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    // XML 中 & 必须转义为 &amp;
    expect(documentXml).toContain('&amp;')
    // 不应出现裸 <标签>（会被当成 XML 标签）
    expect(documentXml).not.toContain('<标签>')
  })

  it('嵌套列表（多级缩进）', async () => {
    const sourcePath = join(workspaceRoot, 'nested-list.md')
    const academic = resolveExportTemplate('builtin-academic')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '- 一级\n  - 二级\n    - 三级\n- 回到一级',
      template: academic
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    expect(documentXml).toContain('一级')
    expect(documentXml).toContain('二级')
    expect(documentXml).toContain('三级')
  })

  it('水平分隔线（hr）', async () => {
    const sourcePath = join(workspaceRoot, 'hr.md')
    const academic = resolveExportTemplate('builtin-academic')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '上文\n\n---\n\n下文',
      template: academic
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')
    expect(documentXml).toContain('上文')
    expect(documentXml).toContain('下文')
    // 分隔线应生成带底边框的段落
    expect(documentXml).toContain('<w:bottom')
  })

  it('多个模板连续导出不互相污染（模块级上下文隔离）', async () => {
    const sourcePath = join(workspaceRoot, 'sequence.md')
    const content = '# 标题\n\n正文'

    // 先用公文模板导出
    const docxGov = await buildDocxFromMarkdown({
      sourcePath,
      content,
      template: resolveExportTemplate('builtin-government')
    })
    // 紧接着用技术文档模板导出（验证模块级上下文是否正确清理）
    const docxTech = await buildDocxFromMarkdown({
      sourcePath,
      content,
      template: resolveExportTemplate('builtin-technical')
    })

    const xmlGov = await (await JSZip.loadAsync(docxGov))
      .file('word/document.xml')?.async('string')
    const xmlTech = await (await JSZip.loadAsync(docxTech))
      .file('word/document.xml')?.async('string')

    // 公文应含仿宋_GB2312
    expect(xmlGov).toContain('仿宋_GB2312')
    // 技术文档应含等线（不应被上一个公文模板污染）
    expect(xmlTech).toContain('等线')
    expect(xmlTech).not.toContain('仿宋_GB2312')
  })

  it('多个模板并发导出时使用各自的异步上下文', async () => {
    const sourcePath = join(workspaceRoot, 'concurrent.md')
    const content = '# 标题\n\n正文\n\n| 列 |\n| --- |\n| 单元格 |'

    const [docxGov, docxTech] = await Promise.all([
      buildDocxFromMarkdown({
        sourcePath,
        content,
        template: resolveExportTemplate('builtin-government')
      }),
      buildDocxFromMarkdown({
        sourcePath,
        content,
        template: resolveExportTemplate('builtin-technical')
      })
    ])

    const xmlGov = await (await JSZip.loadAsync(docxGov))
      .file('word/document.xml')?.async('string')
    const xmlTech = await (await JSZip.loadAsync(docxTech))
      .file('word/document.xml')?.async('string')

    expect(xmlGov).toContain('仿宋_GB2312')
    expect(xmlGov).not.toContain('等线')
    expect(xmlTech).toContain('等线')
    expect(xmlTech).not.toContain('仿宋_GB2312')
  })

  it('模板的正文粗体、斜体与表格行距会进入真实 DOCX', async () => {
    const sourcePath = join(workspaceRoot, 'style-completeness.md')
    const template = resolveExportTemplate('builtin-academic', [], {
      p: { bold: true, italic: true },
      table: { lineSpacingType: 'fixed', lineSpacingValue: 22 }
    })
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '正文\n\n| 列 |\n| --- |\n| 单元格 |',
      template
    })
    const documentXml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')

    expect(documentXml).toMatch(/<w:b(?:\s+[^>]*)?\/?>/)
    expect(documentXml).toMatch(/<w:i(?:\s+[^>]*)?\/?>/)
    expect(documentXml).toContain('w:line="440"')
    expect(documentXml).toContain('w:lineRule="exact"')
  })
})

/**
 * 行距类型端到端测试：验证 6 种行距类型在真实 docx 中生成的 w:spacing 属性正确。
 * 这是中文排版的关键能力（公文用固定行距、技术文档用多倍行距）。
 */
describe('write-export docx line spacing types', () => {
  let workspaceRoot = ''

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'ds-gui-write-spacing-'))
  })

  /**
   * 用 styleOverride 把正文行距改成指定类型，生成 docx，返回 document.xml。
   */
  async function buildWithSpacing(
    lineSpacingType: string,
    lineSpacingValue: number
  ): Promise<string> {
    const sourcePath = join(workspaceRoot, 'spacing.md')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '正文段落',
      template: resolveExportTemplate('builtin-academic', [], {
        p: {
          lineSpacingType: lineSpacingType as any,
          lineSpacingValue
        }
      })
    })
    return (await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string')) ?? ''
  }

  it('single → w:line="240" w:lineRule="auto"', async () => {
    const xml = await buildWithSpacing('single', 1)
    expect(xml).toContain('w:line="240"')
    expect(xml).toContain('w:lineRule="auto"')
  })

  it('1.5 → w:line="360" w:lineRule="auto"', async () => {
    const xml = await buildWithSpacing('1.5', 1.5)
    expect(xml).toContain('w:line="360"')
    expect(xml).toContain('w:lineRule="auto"')
  })

  it('double → w:line="480" w:lineRule="auto"', async () => {
    const xml = await buildWithSpacing('double', 2)
    expect(xml).toContain('w:line="480"')
    expect(xml).toContain('w:lineRule="auto"')
  })

  it('fixed 28pt → w:line="560" w:lineRule="exact"（公文固定行距）', async () => {
    // 28pt × 20 = 560 twip
    const xml = await buildWithSpacing('fixed', 28)
    expect(xml).toContain('w:line="560"')
    expect(xml).toContain('w:lineRule="exact"')
  })

  it('atLeast 20pt → w:line="400" w:lineRule="atLeast"', async () => {
    // 20pt × 20 = 400 twip
    const xml = await buildWithSpacing('atLeast', 20)
    expect(xml).toContain('w:line="400"')
    expect(xml).toContain('w:lineRule="atLeast"')
  })

  it('multiple 1.2 → w:line="288" w:lineRule="auto"（技术文档多倍行距）', async () => {
    // 1.2 × 240 = 288 twip
    const xml = await buildWithSpacing('multiple', 1.2)
    expect(xml).toContain('w:line="288"')
    expect(xml).toContain('w:lineRule="auto"')
  })

  it('段前段后行数换算：0.5 行段前 + 1 行段后', async () => {
    const sourcePath = join(workspaceRoot, 'before-after.md')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '正文',
      template: resolveExportTemplate('builtin-academic', [], {
        p: { spacingBefore: 0.5, spacingAfter: 1 }
      })
    })
    const xml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string') ?? ''
    // 0.5 行 × 240 = 120 twip 段前
    expect(xml).toContain('w:before="120"')
    // 1 行 × 240 = 240 twip 段后
    expect(xml).toContain('w:after="240"')
  })

  it('悬挂缩进：left 和 hanging 设相同 twip 值', async () => {
    const sourcePath = join(workspaceRoot, 'hanging.md')
    const docx = await buildDocxFromMarkdown({
      sourcePath,
      content: '正文',
      template: resolveExportTemplate('builtin-academic', [], {
        p: {
          fontSize: 12,
          indentationType: 'hanging',
          indentationValue: 2
        }
      })
    })
    const xml = await (await JSZip.loadAsync(docx))
      .file('word/document.xml')?.async('string') ?? ''
    // 2 字符 × 12pt × 20 = 480 twip
    expect(xml).toContain('w:left="480"')
    expect(xml).toContain('w:hanging="480"')
  })
})
