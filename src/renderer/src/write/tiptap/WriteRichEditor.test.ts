// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hydrateWriteRichImages, renderWriteRichMarkdown, serializeWriteRichHtml, WriteRichEditor, type WriteRichEditorHandle } from './WriteRichEditor'
import { rebaseWriteRichProjection, richSelectionSourceRange } from './write-rich-projection'

function project(source: string): HTMLDivElement {
  const host = document.createElement('div')
  host.innerHTML = renderWriteRichMarkdown(source)
  return host
}
function textNode(element: Element): Text {
  return Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE) as Text
}
function select(node: Node, from: number, to: number): Range {
  const range = document.createRange()
  range.setStart(node, from)
  range.setEnd(node, to)
  return range
}

const mounted: Root[] = []
afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('WriteRichEditor source-preserving projection', () => {
  it('retains exact bytes of every untouched core block, including CRLF and whitespace', () => {
    const source = [
      '---', 'title: "Demo"', 'tags: [a]', '---', '', '# Title  ', '',
      'A **bold**, *italic*, ~~removed~~, `inline` and [link](./other.md).', '',
      '- [x] parent', '  - nested **item**', '- [ ] pending', '',
      '3. third', '4. fourth', '', '> **quoted**', '>', '> - nested', '',
      '~~~~typescript', 'const fence = "```"', '~~~~', '',
      '| A | B |', '| :--- | ---: |', '| x | y |', '',
      '![local image](./assets/chart.png)', '', ''
    ].join('\r\n')
    expect(serializeWriteRichHtml(project(source))).toBe(source)
  })

  it('changes one paragraph without rewriting frontmatter, MDX, HTML, formulas, footnotes, Mermaid or code', () => {
    const source = '---\ntitle: Demo\n---\n\nKeep **format** here.\n\n<Component value={1} />\n\n<script>alert(1)</script>\n\n$x + y$\n\nFootnote[^a]\n\n[^a]: an exact note\n\n```mermaid\ngraph LR; A-->B\n```\n\n```ts\nconst x = 1\n```\n'
    const host = project(source)
    textNode(host.querySelector('p')!).textContent = 'Change '
    expect(serializeWriteRichHtml(host)).toBe(source.replace('Keep **format** here.', 'Change **format** here.'))
    for (const block of host.querySelectorAll<HTMLElement>('[data-write-readonly="true"]')) expect(block.contentEditable).toBe('false')
    expect(host.querySelector('script,iframe,svg')).toBeNull()
  })

  it('renders formulas and interspersed footnotes without changing source bytes or reference identities', () => {
    const source = 'Start **here** with $\\frac{x}{2}$ and first[^first].\r\n\r\n[^first]: Note **one**.\r\n\r\nBetween paragraphs, second[^second] and repeat[^first].\r\n\r\n[^second]: Note two with $y^2$.\r\n\r\nEnd.\r\n'
    const host = project(source)
    expect(host.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2)
    expect(host.querySelector('a#fnref1')?.getAttribute('href')).toBe('#fn1')
    expect(host.querySelector('a#fnref1\\:1')?.getAttribute('href')).toBe('#fn1')
    expect(host.querySelector('a#fnref2')?.getAttribute('href')).toBe('#fn2')
    expect(host.querySelector('section.footnotes')?.textContent).toContain('Note one.')
    expect(host.querySelector('section.footnotes')?.textContent).toContain('Note two')
    expect(serializeWriteRichHtml(host)).toBe(source)
    const end = Array.from(host.querySelectorAll('p')).find((paragraph) => paragraph.textContent === 'End.')!
    textNode(end).textContent = 'Final.'
    expect(serializeWriteRichHtml(host)).toBe(source.replace('End.', 'Final.'))
    const annotation = host.querySelector('annotation')!.firstChild!
    expect(richSelectionSourceRange(host, select(annotation, 0, 1))).toBeNull()
  })

  it('serializes edits to nested lists and task checkboxes with hierarchy intact', () => {
    const source = '- [x] parent\n  - nested **item**\n- [ ] pending\n'
    const host = project(source)
    const strong = host.querySelector('strong')!
    strong.textContent = 'changed'
    const pending = host.querySelectorAll<HTMLInputElement>('input')[1]
    pending.checked = true
    expect(serializeWriteRichHtml(host)).toBe('- [x] parent\n  - nested **changed**\n- [x] pending\n')
  })

  it('keeps code language and produces a fence longer than embedded backticks', () => {
    const host = project('```typescript\nconst value = 1\n```\n')
    host.querySelector('code')!.textContent = 'const value = "```"\n'
    expect(serializeWriteRichHtml(host)).toBe('````typescript\nconst value = "```"\n````\n')
  })

  it('edits fenced HTML as literal code while raw HTML stays protected and inert', () => {
    const code = '<script>alert("original")</script>\n<img src="https://bad.test/x" onerror="alert(1)">\n<div>&lt;literal&gt; &amp;</div>\n'
    const raw = '<iframe src="https://bad.test/embed"></iframe>\n'
    const source = `\`\`\`html\n${code}\`\`\`\n\n${raw}`
    const host = project(source)
    const codeElement = host.querySelector<HTMLElement>('pre > code.language-html')!
    expect(codeElement).not.toBeNull()
    expect(codeElement.textContent).toBe(code)
    expect(codeElement.closest<HTMLElement>('[data-write-rich-block]')?.contentEditable).toBe('true')
    expect(host.querySelector('script,img,iframe,[src],[href],[onerror]')).toBeNull()
    expect(serializeWriteRichHtml(host)).toBe(source)

    const edited = code.replace('original', 'edited')
    codeElement.textContent = edited
    const saved = serializeWriteRichHtml(host)
    expect(saved).toBe(source.replace(code, edited))
    const reprojected = project(saved)
    expect(reprojected.querySelector('code.language-html')?.textContent).toBe(edited)
    expect(reprojected.querySelector('script,img,iframe,[src],[href],[onerror]')).toBeNull()
    const rawBlock = Array.from(reprojected.querySelectorAll<HTMLElement>('[data-write-readonly="true"]'))
      .find((block) => block.textContent === raw)
    expect(rawBlock?.contentEditable).toBe('false')
    expect(serializeWriteRichHtml(reprojected)).toBe(saved)
  })

  it('preserves formatted blockquotes and aligned tables on supported edits', () => {
    const host = project('> **quoted**\n>\n> - item\n\n| A | B |\n| :---: | ---: |\n| x | y |\n')
    host.querySelector('strong')!.textContent = 'edited'
    host.querySelector('td')!.textContent = 'new'
    expect(serializeWriteRichHtml(host)).toBe('> **edited**\n> \n> - item\n\n| A | B |\n| :---: | ---: |\n| new | y |\n')
  })

  it('rebases subsequent blocks after an edit without converting their source spelling', () => {
    const host = project('First.\n\n__second__\n')
    host.querySelector('p')!.textContent = 'A longer first.'
    const result = serializeWriteRichHtml(host)
    rebaseWriteRichProjection(host)
    expect(serializeWriteRichHtml(host)).toBe(result)
    expect(result).toBe('A longer first.\n\n__second__\n')
    expect(host.querySelectorAll<HTMLElement>('[data-write-rich-block]')[2].dataset.writeOffset).toBe('17')
  })

  it('keeps hard breaks, link/image titles and inline backticks after editing the same paragraph', () => {
    const host = project('Edit  \n[link](./file.md "A title") ![pic](./a.png "Image title") `` `code` ``.\n')
    textNode(host.querySelector('p')!).textContent = 'Changed'
    expect(serializeWriteRichHtml(host)).toBe('Changed  \n[link](./file.md "A title") ![pic](./a.png "Image title") `` `code` ``.\n')
  })

  it('provides an editable insertion target for empty, whitespace and frontmatter-only documents', () => {
    for (const source of ['', '\n\n', '---\ntitle: Empty\n---\n']) {
      const host = project(source)
      const target = host.querySelector('[data-write-readonly="false"]')!
      expect(target).not.toBeNull()
      target.innerHTML = '<p>Inserted.</p>'
      expect(serializeWriteRichHtml(host)).toBe(source + 'Inserted.')
    }
  })

  it('maps repeated words to their exact node and UTF-16 source positions', () => {
    const source = 'Repeat repeat.\n\nRepeat **repeat**.\n\nEmoji 😀 repeat.\n'
    const host = project(source)
    const strongText = textNode(host.querySelector('strong')!)
    const start = source.indexOf('**repeat**') + 2
    expect(richSelectionSourceRange(host, select(strongText, 0, 6))).toEqual({ from: start, to: start + 6 })
    const last = textNode(host.querySelectorAll('p')[2])
    const emojiStart = source.indexOf('😀')
    expect(richSelectionSourceRange(host, select(last, 6, 8))).toEqual({ from: emojiStart, to: emojiStart + 2 })
  })

  it('fails closed for unsupported syntax or noncanonical text rather than guessing selection offsets', () => {
    const host = project('__same__ and same\n\n$x$\n')
    expect(richSelectionSourceRange(host, select(textNode(host.querySelector('strong')!), 0, 4))).toBeNull()
    expect(richSelectionSourceRange(host, select(host.querySelector('.write-math-inline')!.querySelector('annotation')!.firstChild!, 0, 1))).toBeNull()
  })

  it('renders links and images as inert metadata and never creates live external elements', () => {
    const source = '[web](https://example.com) ![remote](https://example.com/a.png) ![local](./a.png)\n\n<iframe src="https://example.com"></iframe>\n'
    const host = project(source)
    expect(host.querySelector('[src],[href],script,iframe,svg,object')).toBeNull()
    expect(host.querySelectorAll('[data-write-image]')).toHaveLength(2)
    expect(serializeWriteRichHtml(host)).toBe(source)
  })

  it('loads only contained workspace raster images through IPC, never HTTP, file URLs, traversal or SVG', async () => {
    const host = project('![ok](./ok.png) ![remote](https://example.com/a.png) ![file](file:///tmp/x.png) ![escape](../../secret.png) ![unc](//example.com/x.png) ![svg](./vector.svg)\n')
    const readWorkspaceImage = vi.fn(async ({ path }: { path: string }) => ({ ok: true, dataUrl: path.endsWith('.svg') ? 'data:image/svg+xml;base64,PHN2Zy8+' : 'data:image/png;base64,YQ==' }))
    vi.stubGlobal('workwise', undefined)
    Object.defineProperty(window, 'workwise', { configurable: true, value: { readWorkspaceImage } })
    await hydrateWriteRichImages(host, '/workspace/docs/readme.md', '/workspace')
    expect(readWorkspaceImage.mock.calls.map(([options]) => options)).toEqual([
      { path: '/workspace/docs/ok.png', workspaceRoot: '/workspace' },
      { path: '/workspace/docs/vector.svg', workspaceRoot: '/workspace' }
    ])
    expect(host.querySelectorAll('img')).toHaveLength(1)
    expect(serializeWriteRichHtml(host)).toContain('![ok](./ok.png)')
    expect(serializeWriteRichHtml(host)).not.toContain('data:image')
  })
})

describe('WriteRichEditor guarded editing', () => {
  function mount(source = 'Original text.\n', readOnly = false): { container: HTMLDivElement; changes: ReturnType<typeof vi.fn>; handle: { current: WriteRichEditorHandle | null } } {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    mounted.push(root)
    const changes = vi.fn()
    const handle = { current: null as WriteRichEditorHandle | null }
    act(() => root.render(createElement(WriteRichEditor, { value: source, readOnly, onChange: changes, handleRef: handle })))
    return { container, changes, handle }
  }

  it('always prevents HTML paste and inserts only clipboard plain text', () => {
    const { container, changes } = mount()
    const paragraph = container.querySelector('p')!
    const range = select(textNode(paragraph), 0, 8)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => type === 'text/plain' ? '<img src="https://bad.test/x">' : '<img src="https://bad.test/x" onerror="alert(1)">' } })
    act(() => { container.querySelector('[data-write-editor-mode]')!.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(container.querySelector('[src],script')).toBeNull()
    expect(changes).toHaveBeenCalledWith('\\<img src="https://bad.test/x"\\> text.\n')
  })

  it('prevents native edits that span different source blocks', () => {
    const { container, changes } = mount('One.\n\nTwo.\n')
    const paragraphs = container.querySelectorAll('p')
    const range = document.createRange()
    range.setStart(textNode(paragraphs[0]), 0)
    range.setEnd(textNode(paragraphs[1]), 3)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    const event = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'deleteContentBackward' })
    container.querySelector('[data-write-editor-mode]')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(changes).not.toHaveBeenCalled()
  })

  it('rejects stale, invalid or read-only projected replacements', () => {
    const editable = mount()
    expect(editable.handle.current!.applyProjectedReplacement({ from: -1, to: 8 }, 'Original', 'New')).toBe(false)
    expect(editable.handle.current!.applyProjectedReplacement({ from: 0, to: 8 }, 'outdated', 'New')).toBe(false)
    expect(editable.handle.current!.applyProjectedReplacement({ from: 0, to: 8 }, 'Original', 'New')).toBe(true)
    expect(editable.handle.current!.getProjectionText()).toBe('New text.\n')
    const locked = mount('Locked.\n', true)
    expect(locked.handle.current!.applyProjectedReplacement({ from: 0, to: 6 }, 'Locked', 'New')).toBe(false)
    expect(locked.changes).not.toHaveBeenCalled()
    expect(locked.container.querySelector('[data-write-rich-block]')?.getAttribute('contenteditable')).toBe('false')
  })

  it('opens an accessible advanced source editor with a real formula preview and rejects a document switch', () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    mounted.push(root)
    const changes = vi.fn()
    const source = 'Uncertainty $\\sigma=0.2$.\n'
    act(() => root.render(createElement(WriteRichEditor, { value: source, filePath: '/workspace/one.md', onChange: changes })))
    act(() => { container.querySelector<HTMLButtonElement>('[data-write-edit-advanced]')!.click() })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.querySelector('textarea')?.value).toBe(source)
    expect(dialog.querySelector('math')).not.toBeNull()
    act(() => root.render(createElement(WriteRichEditor, { value: source, filePath: '/workspace/two.md', onChange: changes })))
    act(() => { Array.from(dialog.querySelectorAll('button')).find((button) => /应用修改|Apply changes/.test(button.textContent ?? ''))!.click() })
    expect(changes).not.toHaveBeenCalled()
    expect(dialog.querySelector('[role="alert"]')?.textContent).toMatch(/活动文档|active document/)
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
