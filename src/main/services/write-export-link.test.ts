import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'

vi.mock('electron', () => ({ app: { getAppPath: () => '/tmp/workwise-test-app' }, BrowserWindow: class {}, clipboard: { write: vi.fn() }, dialog: { showSaveDialog: vi.fn() } }))
vi.mock('./write-advanced-renderer', async (importOriginal) => ({
  ...await importOriginal<typeof import('./write-advanced-renderer')>(),
  renderWriteMermaidDiagrams: vi.fn(async () => new Map())
}))

import { resolveWriteExportLink } from './write-export-link'
import { buildWriteClipboardHtmlFragment, buildWriteExportHtmlDocument } from './write-export-service'
import { buildDocxFromMarkdown } from './write-docx-service'

describe('Markdown export links', () => {
  let root: string
  let sourcePath: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'railwise-export-links-'))
    await mkdir(join(root, 'drafts'))
    sourcePath = join(root, 'drafts', '01-main.md')
  })

  it('resolves document paths independently from query and heading suffixes, including absent targets', async () => {
    for (const suffix of ['', '#results', '?view=full#results']) {
      expect(await resolveWriteExportLink({ href: `../03-section.md${suffix}`, sourcePath, workspaceRoot: root }))
        .toBe(`${pathToFileURL(join(root, '03-section.md')).href}${suffix}`)
    }
    expect(await resolveWriteExportLink({ href: '../中文%20资料%23一.md?view=full#结果', sourcePath, workspaceRoot: root }))
      .toBe(`${pathToFileURL(join(root, '中文 资料#一.md')).href}?view=full#结果`)
    expect(await resolveWriteExportLink({ href: `${pathToFileURL(join(root, '中文 资料#一.md')).href}?view=full#结果`, sourcePath, workspaceRoot: root }))
      .toBe(`${pathToFileURL(join(root, '中文 资料#一.md')).href}?view=full#%E7%BB%93%E6%9E%9C`)
    // Without an explicit workspace only the document directory is in scope.
    expect(await resolveWriteExportLink({ href: './missing.md#heading', sourcePath }))
      .toBe(`${pathToFileURL(join(dirname(sourcePath), 'missing.md')).href}#heading`)
    expect(await resolveWriteExportLink({ href: '../03-section.md', sourcePath })).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('accepts resolved native Windows paths without allowing input backslashes', async () => {
    const target = pathToFileURL(join(root, '中文 资料.md')).href
    expect(await resolveWriteExportLink({ href: '../中文%20资料.md#results', sourcePath, workspaceRoot: root })).toBe(`${target}#results`)
    expect(await resolveWriteExportLink({ href: `${target}#results`, sourcePath, workspaceRoot: root })).toBe(`${target}#results`)
    expect(await resolveWriteExportLink({ href: '../中文%5c资料.md', sourcePath, workspaceRoot: root })).toBeUndefined()
  })

  it.each(['https://example.com/guide#heading', 'http://example.com/?q=中文', 'mailto:author@example.com', '#中文-标题'])('retains supported click target %s', async (href) => {
    expect(await resolveWriteExportLink({ href, sourcePath, workspaceRoot: root })).toBe(href.startsWith('#') ? href : new URL(href).href)
  })

  it.each([
    'javascript:alert(1)', 'data:text/html,test', 'vbscript:alert(1)', 'custom:thing',
    '//example.com/path', '\\server\\share', 'foo\\bar.md', 'https://example.com/\\evil',
    'file://example.com/share.md', 'file://127.0.0.1/share.md', 'file:///etc/passwd',
    '../../outside.md', '..%2F..%2Foutside.md', '%2f%2fexample.com/file.md', '%00bad.md', '%0Abad.md',
    'file:///tmp/%00bad.md', 'file:///tmp/%0Abad.md', 'file:///tmp/%5Cbad.md', 'bad%ZZ.md', 'https://example.com/\nfoo'
  ])('rejects unsafe or malformed target %s', async (href) => {
    expect(await resolveWriteExportLink({ href, sourcePath, workspaceRoot: root })).toBeUndefined()
  })

  it('rejects final links and parent symlink escapes while accepting a symlinked workspace root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'railwise-export-outside-'))
    await writeFile(join(outside, 'secret.md'), 'outside')
    await writeFile(join(root, 'local.md'), 'inside')
    await symlink(outside, join(root, 'escape'), 'dir')
    await symlink(join(root, 'local.md'), join(root, 'alias.md'))
    expect(await resolveWriteExportLink({ href: '../escape/secret.md#heading', sourcePath, workspaceRoot: root })).toBeUndefined()
    expect(await resolveWriteExportLink({ href: '../escape/absent.md', sourcePath, workspaceRoot: root })).toBeUndefined()
    expect(await resolveWriteExportLink({ href: '../alias.md', sourcePath, workspaceRoot: root })).toBeUndefined()
    const linkedRoot = join(outside, 'workspace')
    await symlink(root, linkedRoot, 'dir')
    expect(await resolveWriteExportLink({ href: '../local.md#heading', sourcePath: join(linkedRoot, 'drafts', 'main.md'), workspaceRoot: linkedRoot }))
      .toBe(`${pathToFileURL(join(linkedRoot, 'local.md')).href}#heading`)
    expect(await resolveWriteExportLink({ href: '../drafts', sourcePath, workspaceRoot: root })).toBeUndefined()
  })

  it('writes actual workspace URLs and matching heading IDs in HTML and clipboard output without breaking footnotes', async () => {
    const content = [
      '# 中文 标题', '# 中文 标题', '# Results', '# Results', '# Results-1',
      '[章节](../03-section.md#results) [中文](#中文-标题) [重复](#results-1) [无效](#missing)',
      '来源[^source]，复核[^source]。', '[^source]: 来源说明。'
    ].join('\n\n')
    for (const render of [buildWriteClipboardHtmlFragment, buildWriteExportHtmlDocument]) {
      const html = await render({ sourcePath, workspaceRoot: root, content })
      expect(html).toContain(`href="${pathToFileURL(join(root, '03-section.md')).href}#results"`)
      for (const slug of ['中文-标题', '中文-标题-1', 'results', 'results-1', 'results-1-1']) expect(html).toContain(`id="${slug}"`)
      expect(html).toContain('href="#%E4%B8%AD%E6%96%87-%E6%A0%87%E9%A2%98"')
      expect(html).toContain('href="#results-1"')
      expect(html).not.toContain('href="#missing"')
      expect(html).toContain('href="#fn1"')
      expect(html).toContain('href="#fnref1:1"')
    }
  })

  it('writes real DOCX external relationships and same-document bookmarks for duplicate and non-ASCII headings', async () => {
    const content = [
      '# 中文 标题', '# 中文 标题', '# Results', '# Results',
      '[章节](../03-section.md?view=full#results)', '[网页](https://example.com/guide#results)',
      '[中文](#中文-标题) [中文重复](#中文-标题-1) [重复](#results-1) [无效](#missing)',
      '[越界](../../outside.md) [文件越界](file:///etc/passwd)'
    ].join('\n\n')
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath, workspaceRoot: root, content }))
    const parser = new DOMParser()
    const body = parser.parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml')
    const relationships = parser.parseFromString(await zip.file('word/_rels/document.xml.rels')!.async('string'), 'application/xml')
    const targets = new Map(Array.from(relationships.getElementsByTagName('Relationship')).map((entry) => [entry.getAttribute('Id'), entry.getAttribute('Target')]))
    const links = Array.from(body.getElementsByTagName('w:hyperlink'))
    const externalTargets = links.filter((entry) => entry.hasAttribute('r:id')).map((entry) => targets.get(entry.getAttribute('r:id')))
    expect(externalTargets).toEqual(expect.arrayContaining([`${pathToFileURL(join(root, '03-section.md')).href}?view=full#results`, 'https://example.com/guide#results']))
    expect(externalTargets).toHaveLength(2)
    const starts = Array.from(body.getElementsByTagName('w:bookmarkStart'))
    const names = starts.map((entry) => entry.getAttribute('w:name'))
    const ids = starts.map((entry) => entry.getAttribute('w:id'))
    expect(starts).toHaveLength(4)
    expect(new Set(names).size).toBe(4)
    expect(new Set(ids).size).toBe(4)
    expect(Array.from(body.getElementsByTagName('w:bookmarkEnd')).map((entry) => entry.getAttribute('w:id'))).toEqual(ids)
    for (const name of names) expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)
    const internalTargets = links.filter((entry) => entry.hasAttribute('w:anchor')).map((entry) => entry.getAttribute('w:anchor'))
    expect(internalTargets).toEqual([names[0], names[1], names[3]])
    for (const target of internalTargets) expect(names).toContain(target)
    expect(body.documentElement?.textContent).toContain('无效')
    expect(body.documentElement?.textContent).toContain('越界')
  })

  it('disambiguates heading IDs from generated footnote IDs while preserving source anchor intent', async () => {
    const content = [
      '# fn1', '# fnref1', '# railwise-heading-fn1',
      '[正文标题](#fn1) [引用标题](#fnref1) [原前缀标题](#railwise-heading-fn1)',
      '正文注释[^source]，同一注[^source]。', '[^source]: 注释内容。'
    ].join('\n\n')
    const html = await buildWriteExportHtmlDocument({ sourcePath, workspaceRoot: root, content })
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
    expect(new Set(ids).size).toBe(ids.length)
    expect(html).toContain('<h1 id="railwise-heading-fn1-1">fn1</h1>')
    expect(html).toContain('href="#railwise-heading-fn1-1">正文标题</a>')
    expect(html).toContain('href="#railwise-heading-fnref1">引用标题</a>')
    expect(html).toContain('href="#railwise-heading-fn1">原前缀标题</a>')
    expect(html).toContain('<sup class="footnote-ref"><a href="#fn1" id="fnref1">')
    expect(html).toContain('id="fnref1:1"')
  })

  it('keeps hyperlinks in DOCX headings and combines them with unique heading bookmarks', async () => {
    const content = '# [引用章节](../03-section.md#results)\n\n## [返回标题](#引用章节)'
    const zip = await JSZip.loadAsync(await buildDocxFromMarkdown({ sourcePath, workspaceRoot: root, content }))
    const parser = new DOMParser()
    const body = parser.parseFromString(await zip.file('word/document.xml')!.async('string'), 'application/xml')
    const relationships = parser.parseFromString(await zip.file('word/_rels/document.xml.rels')!.async('string'), 'application/xml')
    const targets = Array.from(relationships.getElementsByTagName('Relationship')).map((entry) => entry.getAttribute('Target'))
    expect(targets).toContain(`${pathToFileURL(join(root, '03-section.md')).href}#results`)
    const bookmarks = Array.from(body.getElementsByTagName('w:bookmarkStart'))
    const links = Array.from(body.getElementsByTagName('w:hyperlink'))
    expect(links).toHaveLength(2)
    expect(links[1].getAttribute('w:anchor')).toBe(bookmarks[0].getAttribute('w:name'))
    expect(new Set(bookmarks.map((entry) => entry.getAttribute('w:id'))).size).toBe(2)
  })
})
