import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'

vi.mock('electron', () => ({ app: { getAppPath: () => '/tmp/workwise-test-app' }, BrowserWindow: class {}, clipboard: { write: vi.fn() }, dialog: { showSaveDialog: vi.fn() } }))
vi.mock('./write-advanced-renderer', async (importOriginal) => ({
  ...await importOriginal<typeof import('./write-advanced-renderer')>(),
  renderWriteMermaidDiagrams: vi.fn(async () => new Map()),
  renderWriteMathImage: vi.fn(async () => null)
}))

import { buildWriteExportHtmlDocument } from './write-export-service'
import { buildDocxFromMarkdown } from './write-docx-service'
import { renderWriteMathImage, renderWriteMermaidDiagrams } from './write-advanced-renderer'
import { BUILTIN_EXPORT_TEMPLATES, cloneExportTemplate } from '../../shared/write-export-templates'

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lJYfWQAAAABJRU5ErkJggg==', 'base64')
const documentText = (xml: string): string => {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  return Array.from(document.getElementsByTagName('w:t')).map((node) => node.textContent).join('')
}

describe('advanced Markdown export semantics', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'workwise-advanced-export-'))
    vi.mocked(renderWriteMermaidDiagrams).mockReset().mockResolvedValue(new Map())
    vi.mocked(renderWriteMathImage).mockReset().mockResolvedValue(null)
  })

  it('embeds bounded formula HTML, MathML and local fonts in standalone HTML', async () => {
    const html = await buildWriteExportHtmlDocument({ sourcePath: join(root, 'formula.md'), content: '面积 $A=\\pi r^2$。\n\n$$\n\\frac{a+b}{\\sqrt{c}}\n$$' })
    expect(html).toContain('class="katex"')
    expect(html).toContain('<mfrac>')
    expect(html).toContain('<msqrt>')
    expect(html).toContain('font/woff2;base64,')
    expect(html).toContain('font-src data:')
    expect(html).not.toMatch(/url\(["']?(?:https?:|file:|fonts\/)/)
    expect(html).not.toContain('<script')
  })

  it('writes editable OMML fractions, roots, matrix rows, scripts and limits', async () => {
    const content = '结果 $x_1^2+\\frac{a}{b}$。\n\n$$\\sqrt{x}+\\sum_{i=1}^{n}i+\\begin{bmatrix}1&2\\\\3&4\\end{bmatrix}$$'
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath: join(root, 'formula.md'), content }))
    const xml = await zip.file('word/document.xml')!.async('string')
    for (const marker of ['<m:oMath>', '<m:sSubSup>', '<m:f>', '<m:rad>', '<m:limUpp>', '<m:m>', '<m:mr>']) expect(xml).toContain(marker)
    expect(xml).not.toContain('<undefined>')
    expect(xml).not.toContain('\\frac')
    expect(Object.keys(zip.files).filter((name) => name.startsWith('word/media/'))).toHaveLength(0)
    expect(renderWriteMathImage).not.toHaveBeenCalled()
  })

  it('writes actual Word footnotes with repeated references and formatted content', async () => {
    const content = '结果[^survey]，复核见同一注[^survey]。\n\n[^survey]: **复核依据**：$s=\\sqrt{v}$。\n\n    第二段说明。'
    const html = await buildWriteExportHtmlDocument({ sourcePath: join(root, 'notes.md'), content })
    expect(html).toContain('class="footnotes"')
    expect(html).toContain('href="#fn1"')
    expect(html).toContain('href="#fnref1:1"')
    expect(html).not.toContain('href="file:')
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath: join(root, 'notes.md'), content }))
    const body = await zip.file('word/document.xml')!.async('string')
    const notes = await zip.file('word/footnotes.xml')!.async('string')
    expect(body.match(/<w:footnoteReference w:id="1"\/>/g)).toHaveLength(1)
    expect(body).toContain('w:instr="NOTEREF RailWiseFootnote1 \\h \\f"')
    expect(body).toContain('w:name="RailWiseFootnote1"')
    expect(body).toContain('<w:vertAlign w:val="superscript"/>')
    expect(body).not.toContain('复核依据')
    expect(notes).toContain('复核依据')
    expect(notes).toContain('第二段说明')
    expect(notes).toContain('<w:b/>')
    expect(notes).toContain('<m:rad>')
  })

  it('keeps repeated, distinct and inline footnotes associated with a single native note each', async () => {
    const content = 'First[^source], repeated[^source], inline ^[Inline explanation], repeated again[^source] and second[^other].\n\n[^source]: Source explanation.\n\n[^other]: Other explanation.'
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath: join(root, 'repeat.md'), content }))
    const body = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml')
    const notes = new DOMParser().parseFromString(await zip.file('word/footnotes.xml')!.async('string'), 'application/xml')
    const refs = Array.from(body.getElementsByTagName('w:footnoteReference')).map((node) => node.getAttribute('w:id'))
    expect(refs).toEqual(['1', '2', '3'])
    const fields = Array.from(body.getElementsByTagName('w:fldSimple'))
    expect(fields).toHaveLength(2)
    for (const field of fields) {
      expect(field.getAttribute('w:instr')).toBe('NOTEREF RailWiseFootnote1 \\h \\f')
      expect(field.getElementsByTagName('w:t')[0]?.textContent).toBe('1')
      expect(field.getElementsByTagName('w:vertAlign')[0]?.getAttribute('w:val')).toBe('superscript')
    }
    const bookmarks = Array.from(body.getElementsByTagName('w:bookmarkStart'))
    expect(bookmarks.map((node) => node.getAttribute('w:name'))).toEqual(['RailWiseFootnote1', 'RailWiseFootnote2', 'RailWiseFootnote3'])
    expect(new Set(bookmarks.map((node) => node.getAttribute('w:id'))).size).toBe(3)
    const bodies = Array.from(notes.getElementsByTagName('w:footnote')).filter((note) => !note.hasAttribute('w:type'))
    expect(bodies.map((note) => [note.getAttribute('w:id'), documentText(note.toString())])).toEqual([
      ['1', 'Source explanation.'], ['2', 'Inline explanation'], ['3', 'Other explanation.']
    ])
    for (const note of Array.from(notes.getElementsByTagName('w:footnote'))) {
      expect(note.getElementsByTagName('w:footnoteRef').length).toBe(note.hasAttribute('w:type') ? 0 : 1)
    }
    expect(await zip.file('word/settings.xml')!.async('string')).toContain('<w:updateFields/>')
  })

  it('shares footnote targets across paragraphs, heading text and table cells without leaking between exports', async () => {
    const content = '# Heading[^same]\n\nBody[^same].\n\n| Column |\n| --- |\n| Cell[^same] |\n\n[^same]: Shared note.'
    const outputs = await Promise.all([1, 2].map(async () => {
      const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath: join(root, 'contexts.md'), content }))
      return zip.file('word/document.xml')!.async('string')
    }))
    for (const body of outputs) {
      expect(body.match(/<w:footnoteReference w:id="1"\/>/g)).toHaveLength(1)
      expect(body.match(/NOTEREF RailWiseFootnote1/g)).toHaveLength(2)
      expect(body).toContain('w:name="RailWiseFootnote1"')
      const xml = new DOMParser().parseFromString(body, 'application/xml')
      const starts = Array.from(xml.getElementsByTagName('w:bookmarkStart'))
      const ids = starts.map((node) => node.getAttribute('w:id'))
      expect(starts).toHaveLength(2)
      expect(new Set(ids).size).toBe(2)
      expect(starts.map((node) => node.getAttribute('w:name'))).toEqual(expect.arrayContaining([
        'RailWiseFootnote1', expect.stringMatching(/^RailWiseHeading/)
      ]))
      // A heading can enclose a note reference; both must share one allocator
      // while each start still has exactly one corresponding end.
      expect(Array.from(xml.getElementsByTagName('w:bookmarkEnd')).map((node) => node.getAttribute('w:id')).sort()).toEqual([...ids].sort())
    }
  })

  it('sizes fallback formulas from the paragraph/table template while preserving captured PNG bytes', async () => {
    vi.mocked(renderWriteMathImage).mockResolvedValue({ png: TINY_PNG, width: 300, height: 120 })
    const template = cloneExportTemplate(BUILTIN_EXPORT_TEMPLATES[0])
    template.styles.p.fontSize = 12
    template.styles.table.fontSize = 6
    const source = '\\color{red}{x}'
    const content = `Inline $${source}$.\n\n$$${source}$$\n\n| Formula |\n| --- |\n| $${source}$ |`
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath: join(root, 'sizes.md'), content, template }))
    const xml = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml')
    const sizes = Array.from(xml.getElementsByTagName('wp:extent')).map((node) => [Number(node.getAttribute('cx')) / 9525, Number(node.getAttribute('cy')) / 9525])
    expect(sizes).toEqual([[160, 64], [160, 64], [80, 32]])
    const images = Object.keys(zip.files).filter((path) => path.startsWith('word/media/') && !zip.files[path].dir)
    expect(images.length).toBeGreaterThan(0)
    for (const image of images) expect(await zip.file(image)!.async('nodebuffer')).toEqual(TINY_PNG)
  })

  it('keeps binomial and atop stacks without inventing a fraction bar', async () => {
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath: join(root, 'binomial.md'), content: '$\\binom{n}{k}$ 和 $a \\atop b$' }))
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml.match(/<m:type m:val="noBar"\/>/g)).toHaveLength(2)
    expect(xml.match(/<m:f>/g)).toHaveLength(2)
    expect(renderWriteMathImage).not.toHaveBeenCalled()
  })

  it.each([
    '\\begin{aligned}a&=b+c\\\\d&=e\\end{aligned}',
    '\\begin{cases}a&x>0\\\\b&x<0\\end{cases}',
    '\\overset{!}{=}',
    '\\color{red}{x}',
    'a\\hspace{2em}b'
  ])('uses a visual formula fallback for unmapped layout %s', async (source) => {
    vi.mocked(renderWriteMathImage).mockResolvedValue({ png: TINY_PNG, width: 160, height: 70 })
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath: join(root, 'aligned.md'), content: `$$${source}$$` }))
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:drawing>')
    expect(xml).not.toContain('<m:m>')
    expect(renderWriteMathImage).toHaveBeenCalledWith(source, true)
  })

  it('embeds the same supplied local diagram as SVG in HTML and PNG in Word', async () => {
    const source = 'flowchart LR\n  A[资料] --> B[审定]\n'
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" role="img"><text x="4" y="20">资料 → 审定</text></svg>'
    vi.mocked(renderWriteMermaidDiagrams).mockResolvedValue(new Map([[source, { svg, png: TINY_PNG, width: 100, height: 40 }]]))
    const content = `\`\`\`mermaid\n${source}\`\`\``
    const html = await buildWriteExportHtmlDocument({ sourcePath: join(root, 'diagram.md'), content })
    expect(html).toContain(svg)
    expect(html).not.toContain('data-write-mermaid')
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath: join(root, 'diagram.md'), content }))
    const images = Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !zip.files[name].dir)
    expect(images).toHaveLength(1)
    expect(await zip.file(images[0])!.async('nodebuffer')).toEqual(TINY_PNG)
    expect(await zip.file('word/document.xml')!.async('string')).toContain('<w:drawing>')
    expect(renderWriteMermaidDiagrams).toHaveBeenCalledWith([source])
  })

  it('keeps malformed formulas and rejected diagrams visible as explicit source fallbacks', async () => {
    const content = '$\\unknownRailWise{x}$\n\n```mermaid\nflowchart LR\nclick A "https://example.invalid"\n```'
    const html = await buildWriteExportHtmlDocument({ sourcePath: join(root, 'invalid.md'), content })
    expect(html).toContain('katex-error')
    expect(html).toContain('Mermaid 图表未能绘制')
    expect(html).toContain('https://example.invalid')
    expect(html).not.toContain('<script')
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath: join(root, 'invalid.md'), content }))
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(documentText(xml)).toContain('公式无法排版：\\unknownRailWise{x}')
    expect(documentText(xml)).toContain('Mermaid 图表未能绘制')
  })
})
