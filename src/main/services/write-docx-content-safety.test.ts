import { beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'

const pdfProbe = vi.hoisted(() => ({
  loadedHtml: '',
  printToPDF: vi.fn(async () => Buffer.from('%PDF-unit-test-handoff'))
}))

vi.mock('electron', () => ({
  app: { getAppPath: () => '/tmp/workwise-test-app' },
  BrowserWindow: class {
    webContents = {
      session: { webRequest: { onBeforeRequest: vi.fn() }, setPermissionRequestHandler: vi.fn() },
      setWindowOpenHandler: vi.fn(), on: vi.fn(), removeListener: vi.fn(),
      executeJavaScript: vi.fn(async () => undefined),
      printToPDF: pdfProbe.printToPDF
    }
    async loadURL(url: string): Promise<void> {
      const { readFile } = await import('node:fs/promises')
      pdfProbe.loadedHtml = await readFile(new URL(url), 'utf8')
    }
    isDestroyed(): boolean { return false }
    destroy(): void { /* No real Electron window is owned by this test. */ }
  },
  clipboard: { write: vi.fn() }, dialog: { showSaveDialog: vi.fn() }
}))
vi.mock('./write-advanced-renderer', () => ({
  renderWriteMermaidDiagrams: vi.fn(async () => new Map()),
  renderWriteMathImage: vi.fn(async () => null),
  loadWriteMathExportCss: vi.fn(async () => '')
}))

import { buildDocxFromMarkdown } from './write-docx-service'
import { buildWriteExportHtmlDocument, renderWriteExportHtmlToPdf } from './write-export-service'

const parseXml = (source: string): Document => new DOMParser().parseFromString(source, 'application/xml') as unknown as Document
const textContent = (source: string): string => Array.from(parseXml(source).getElementsByTagName('w:t')).map((node) => node.textContent).join('')
const sourcePath = '/workspace/content-safety.md'

describe('DOCX footnote and HTML source preservation', () => {
  beforeEach(() => {
    pdfProbe.loadedHtml = ''
    pdfProbe.printToPDF.mockClear()
  })

  it.each([
    { name: 'table only', definition: '| Column |\n    | --- |\n    | Value |', text: 'ColumnValue', table: true },
    { name: 'table then paragraph', definition: '| Column |\n    | --- |\n    | Value |\n\n    Following paragraph.', text: 'ColumnValueFollowing paragraph.', table: true },
    { name: 'blockquote starting with a table', definition: '> | Column |\n    > | --- |\n    > | Value |', text: 'ColumnValue', table: true },
    { name: 'paragraph then table', definition: 'Leading paragraph.\n\n    | Column |\n    | --- |\n    | Value |', text: 'Leading paragraph.ColumnValue', table: true },
    { name: 'empty note', definition: '', text: '', table: false },
    { name: 'plain paragraph', definition: 'Plain note.', text: 'Plain note.', table: false },
    { name: 'code block', definition: '```text\n    Note code.\n    ```', text: 'Note code.', table: false }
  ])('preserves $name and one native mark across repeated citations', async ({ definition, text, table }) => {
    const content = `Text[^a], repeated[^a].\n\n[^a]:${definition ? ` ${definition}` : ''}`
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath, content }))
    const body = await zip.file('word/document.xml')!.async('string')
    const notes = parseXml(await zip.file('word/footnotes.xml')!.async('string'))
    const note = Array.from(notes.getElementsByTagName('w:footnote')).find((node) => node.getAttribute('w:id') === '1')!

    expect(body.match(/<w:footnoteReference w:id="1"\/>/g)).toHaveLength(1)
    expect(body.match(/NOTEREF RailWiseFootnote1/g)).toHaveLength(1)
    expect(body).toContain('w:name="RailWiseFootnote1"')
    expect(note.getElementsByTagName('w:footnoteRef')).toHaveLength(1)
    expect(note.getElementsByTagName('w:tbl')).toHaveLength(table ? 1 : 0)
    expect(textContent(note.toString())).toBe(text)
    expect(Array.from(note.childNodes).find((node) => node.nodeType === 1)?.nodeName).toBe('w:p')
    for (const separator of Array.from(notes.getElementsByTagName('w:footnote')).filter((node) => node.hasAttribute('w:type'))) {
      expect(separator.getElementsByTagName('w:footnoteRef')).toHaveLength(0)
    }

    const html = await buildWriteExportHtmlDocument({ sourcePath, content })
    expect(html).toContain('class="footnotes"')
    expect(html).toContain('href="#fn1"')
    expect(html).toContain('href="#fnref1:1"')
    expect(html.includes('<table>')).toBe(table)
  })

  it.each(['body', 'footnote'] as const)('keeps %s HTML blocks visible and inert instead of deleting their contents', async (location) => {
    const raw = '<div>Important &amp; content.</div>\n<script>alert("literal")</script>\n<img src="https://example.invalid/pixel.png" onerror="literal()">'
    const content = location === 'body'
      ? `Before.\n\n${raw}\n\nAfter.`
      : `Cite[^a].\n\n[^a]: ${raw.replaceAll('\n', '\n    ')}`
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath, content }))
    const body = await zip.file('word/document.xml')!.async('string')
    const notes = await zip.file('word/footnotes.xml')!.async('string')
    const target = location === 'body' ? body : notes

    expect(textContent(target)).toContain(raw.replaceAll('\n', ''))
    if (location === 'body') expect(textContent(body)).toBe(`Before.${raw.replaceAll('\n', '')}After.`)
    else {
      const note = Array.from(parseXml(notes).getElementsByTagName('w:footnote')).find((node) => node.getAttribute('w:id') === '1')!
      expect(note.getElementsByTagName('w:footnoteRef')).toHaveLength(1)
      expect(textContent(body)).not.toContain('Important')
    }
    expect(target).not.toMatch(/<script|<img\b|<div>/)
    expect(Object.keys(zip.files).filter((name) => name.startsWith('word/media/') && !zip.files[name].dir)).toHaveLength(0)
    for (const name of Object.keys(zip.files).filter((name) => name.endsWith('.rels'))) {
      expect(await zip.file(name)!.async('string')).not.toContain('example.invalid')
    }

    const html = await buildWriteExportHtmlDocument({ sourcePath, content })
    expect(html).toContain('&lt;div&gt;Important &amp; content.&lt;/div&gt;')
    expect(html).not.toMatch(/<script|<img\b|<div>/)
  })

  it('hands table-first notes and inert HTML unchanged to the PDF printing boundary', async () => {
    const content = 'Before.\n\n<div>Important block content.</div>\n\nText[^a].\n\n[^a]: | Column |\n    | --- |\n    | Value |'
    const html = await buildWriteExportHtmlDocument({ sourcePath, content })
    const pdf = await renderWriteExportHtmlToPdf(html)

    expect(pdfProbe.loadedHtml).toBe(html)
    expect(pdfProbe.loadedHtml).toContain('&lt;div&gt;Important block content.&lt;/div&gt;')
    expect(pdfProbe.loadedHtml).toContain('class="footnotes"')
    expect(pdfProbe.loadedHtml).toContain('<table>')
    expect(pdfProbe.printToPDF).toHaveBeenCalledWith({ printBackground: true, preferCSSPageSize: true })
    expect(pdf.toString()).toBe('%PDF-unit-test-handoff')
    // This checks the real HTML/file/print handoff, not PDF layout acceptance.
  })

  it.each(['body', 'footnote'] as const)('preserves unsupported inline HTML in %s as inert text', async (location) => {
    const raw = '<custom-widget label="Important" /> <span>Visible text</span> <u class="annotation">Annotated</u> <img src="https://example.invalid/inline.png" onerror="literal()">'
    const content = location === 'body' ? `Before ${raw} After.` : `Text[^a].\n\n[^a]: Before ${raw} After.`
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath, content }))
    const xml = await zip.file(location === 'body' ? 'word/document.xml' : 'word/footnotes.xml')!.async('string')
    expect(textContent(xml)).toContain(`Before ${raw} After.`)
    expect(xml).not.toMatch(/<custom-widget|<span>|<img\b/)
    expect(Object.keys(zip.files).filter((name) => /^word\/media\/[^/]+$/.test(name))).toHaveLength(0)
    for (const name of Object.keys(zip.files).filter((name) => name.endsWith('.rels'))) {
      expect(await zip.file(name)!.async('string')).not.toContain('example.invalid')
    }
  })

  it('keeps attributed, nested and unmatched underline tags literal while retaining simple underline support', async () => {
    const content = 'Before <u>Underlined <u class="annotation">Annotated</u> tail</u> </u> After.'
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath, content }))
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(textContent(xml)).toBe('Before Underlined <u class="annotation">Annotated</u> tail </u> After.')
    expect(xml).toContain('<w:u w:val="single"')
  })
})
