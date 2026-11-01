import { createWriteMarkdownIt } from '@shared/write-advanced-markdown'

const markdown = createWriteMarkdownIt()
const BLOCK_ATTR = 'data-write-rich-block'
const escapeHtml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const encode = (value: string): string => escapeHtml(encodeURIComponent(value))
const decode = (value?: string): string => { try { return decodeURIComponent(value ?? '') } catch { return '' } }

// Resource URLs are metadata, never live DOM attributes. The component resolves local
// images through the workspace bridge after this inert projection has been mounted.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]
  return `<span data-write-image="${encode(token.attrGet('src') ?? '')}" data-write-alt="${encode(token.content)}" data-write-title="${encode(token.attrGet('title') ?? '')}" contenteditable="false"><span>${escapeHtml(token.content || 'Image')}</span></span>`
}
markdown.renderer.rules.link_open = (tokens, index) => `<a data-write-href="${encode(tokens[index].attrGet('href') ?? '')}" data-write-title="${encode(tokens[index].attrGet('title') ?? '')}">`
markdown.renderer.rules.hardbreak = () => '<br data-write-hardbreak="true">'

function lineOffsets(source: string): number[] {
  const result = [0]
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') result.push(i + 1)
  result.push(source.length)
  return result
}

function unsupported(source: string, type: string): boolean {
  if (type === 'fence' || type === 'code_block') return /^\s*(`{3,}|~{3,})\s*(mermaid|math|latex)(?:\s|$)/i.test(source)
  return /<\/?[A-Za-z!]|\{[^\n]*\}|\[\^|\$|^\s*(?:import|export)\s|\]\s*\[[^\]]*\]/m.test(source)
}

function blockHtml(source: string, readOnly: boolean): string {
  if (readOnly) return `<pre class="write-rich-source-block">${escapeHtml(source)}</pre>`
  const container = document.createElement('div')
  container.innerHTML = markdown.render(source)
  for (const checkbox of container.querySelectorAll<HTMLInputElement>('input[data-write-task]')) {
    checkbox.disabled = false
    checkbox.setAttribute('contenteditable', 'false')
  }
  for (const item of container.querySelectorAll('li')) {
    const first = item.firstChild?.nodeType === Node.TEXT_NODE ? item.firstChild : item.querySelector(':scope > p')?.firstChild
    if (!first || first.nodeType !== Node.TEXT_NODE) continue
    const match = /^\[([ xX])\] /.exec(first.textContent ?? '')
    if (!match) continue
    first.textContent = (first.textContent ?? '').slice(match[0].length)
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = match[1].toLowerCase() === 'x'
    if (input.checked) input.setAttribute('checked', '')
    input.setAttribute('data-write-task', 'true')
    input.setAttribute('contenteditable', 'false')
    first.parentNode?.insertBefore(input, first)
    first.parentNode?.insertBefore(document.createTextNode(' '), first)
  }
  return container.innerHTML
}

function projectionChunk(source: string, from: number, readOnly: boolean, gap = false, visualHtml?: string, kind?: string): string {
  const html = gap ? '' : visualHtml !== undefined ? `<div class="write-rich-advanced-body">${visualHtml}</div><button type="button" data-write-edit-advanced="${kind ?? 'syntax'}" contenteditable="false" class="write-rich-edit-advanced">Edit source</button>` : blockHtml(source, readOnly)
  return `<div ${BLOCK_ATTR}="true" class="write-rich-source-projection${!readOnly ? ' min-h-7 outline-none focus-visible:ring-1 focus-visible:ring-ds-border-muted' : ''}" data-write-source="${encode(source)}" data-write-offset="${from}" data-write-readonly="${readOnly}" data-write-gap="${gap}" data-write-initial="${encode(html)}" contenteditable="${!readOnly}"${!readOnly ? ' tabindex="0"' : ''}${gap ? ' hidden' : ''}>${html}</div>`
}

/** Each mapped source block owns its exact original bytes, including invisible gaps. */
export function renderWriteRichMarkdown(source: string): string {
  const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(source)?.[0] ?? ''
  const body = source.slice(frontmatter.length)
  const offsets = lineOffsets(body)
  const env: Record<string, unknown> = {}
  const tokens = markdown.parse(body, env)
  const footnotesFrom = tokens.findIndex((token) => token.type === 'footnote_block_open')
  const notes: Array<{ label?: string; id: number; html: string }> = []
  for (let index = footnotesFrom; index >= 0 && index < tokens.length; index += 1) {
    if (tokens[index].type !== 'footnote_open') continue
    let end = index + 1
    while (end < tokens.length && tokens[end].type !== 'footnote_close') end += 1
    const id = Number(tokens[index].meta.id)
    const noteHtml = markdown.renderer.render(tokens.slice(index, end + 1), markdown.options, env)
    // A definition may occur between body paragraphs. Its own visual entry keeps
    // the document-wide number even when it is the only item in this source gap.
    notes.push({ label: tokens[index].meta.label, id, html: noteHtml.replace('<li ', `<li value="${id + 1}" `) })
    index = end
  }
  const noteSection = (entries: typeof notes): string => `<section class="footnotes"><ol class="footnotes-list">${entries.map((note) => note.html).join('')}</ol></section>`
  const gapHtml = (gap: string): string | undefined => {
    const labels = Array.from(gap.matchAll(/^ {0,3}\[\^([^\]]+)\]:/gm), (match) => match[1])
    if (!labels.length) return undefined
    const owned = notes.filter((note) => note.label !== undefined && labels.includes(note.label))
    return owned.length ? noteSection(owned) : `<pre class="write-rich-source-block">${escapeHtml(gap)}</pre>`
  }
  let consumed = 0
  let html = frontmatter ? projectionChunk(frontmatter, 0, true) : ''
  for (let index = 0; index < (footnotesFrom < 0 ? tokens.length : footnotesFrom); index += 1) {
    const token = tokens[index]
    if (token.level !== 0 || !token.map || token.nesting === -1) continue
    const start = offsets[token.map[0]] ?? body.length
    const end = offsets[token.map[1]] ?? body.length
    if (start < consumed || end <= start) continue
    if (start > consumed) {
      const gap = body.slice(consumed, start)
      html += projectionChunk(gap, frontmatter.length + consumed, true, !gap.trim(), gapHtml(gap), 'footnote')
    }
    const chunk = body.slice(start, end)
    const readOnly = unsupported(chunk, token.type) || token.type === 'math_block'
    let endToken = index + 1
    if (token.nesting === 1) {
      while (endToken < tokens.length && !(tokens[endToken].level === token.level && tokens[endToken].nesting === -1)) endToken += 1
      endToken += 1
    }
    const group = tokens.slice(index, endToken)
    const isMath = token.type === 'math_block' || group.some((item) => item.children?.some((child) => child.type === 'math_inline')) || (token.type === 'fence' && /^(math|latex)(\s|$)/i.test(token.info))
    const isFootnote = group.some((item) => item.children?.some((child) => child.type === 'footnote_ref'))
    const isMermaid = token.type === 'fence' && /^mermaid(\s|$)/i.test(token.info)
    const advanced = isMath || isFootnote || isMermaid
    html += projectionChunk(chunk, frontmatter.length + start, readOnly || advanced, false, advanced ? markdown.renderer.render(group, markdown.options, env) : undefined, isMermaid ? 'mermaid' : isMath ? 'math' : 'footnote')
    consumed = end
  }
  if (consumed < body.length) {
    const tail = body.slice(consumed)
    html += projectionChunk(tail, frontmatter.length + consumed, true, !tail.trim(), gapHtml(tail), 'footnote')
  }
  // Inline notes have no independent source definition. Their source remains in
  // the owning paragraph; this display-only tail must never serialize twice.
  const inlineNotes = notes.filter((note) => note.label === undefined)
  if (inlineNotes.length) html += `<div data-write-rich-display-only="true" contenteditable="false">${noteSection(inlineNotes)}</div>`
  // Empty documents still need an editable insertion target.
  if (!body.trim()) html += projectionChunk('', source.length, false)
  return html
}

type Fragment = { text: string; points: Map<Node, number[]> }
const empty = (): Fragment => ({ text: '', points: new Map() })
function append(target: Fragment, fragment: Fragment | string): void {
  if (typeof fragment === 'string') { target.text += fragment; return }
  const offset = target.text.length
  target.text += fragment.text
  for (const [node, points] of fragment.points) target.points.set(node, points.map((point) => point + offset))
}
function wrap(fragment: Fragment, prefix: string, suffix: string): Fragment {
  const result = empty(); append(result, prefix); append(result, fragment); append(result, suffix); return result
}
function prefixLines(fragment: Fragment, prefix: (line: number) => string): Fragment {
  const starts = [0]
  for (let i = 0; i < fragment.text.length; i += 1) if (fragment.text[i] === '\n' && i + 1 < fragment.text.length) starts.push(i + 1)
  const inserted = (position: number): number => starts.reduce((sum, start, line) => sum + (start <= position ? prefix(line).length : 0), 0)
  const result: Fragment = { text: fragment.text.split('\n').map((line, index) => `${prefix(index)}${line}`).join('\n'), points: new Map() }
  for (const [node, points] of fragment.points) result.points.set(node, points.map((point) => point + inserted(point)))
  return result
}
function textFragment(node: Node, literal = false): Fragment {
  const original = (node.textContent ?? '').replaceAll('\u00a0', ' ')
  const points = [0]
  let text = ''
  // DOM Range offsets count UTF-16 code units, including both emoji surrogates.
  for (let index = 0; index < original.length; index += 1) {
    const char = original[index]
    text += !literal && /[\\`*_[\]<>]/.test(char) ? `\\${char}` : char
    points.push(text.length)
  }
  return { text, points: new Map([[node, points]]) }
}
function children(element: Node, literal = false): Fragment {
  const result = empty()
  for (const child of Array.from(element.childNodes)) append(result, inline(child, literal))
  return result
}
function markdownTarget(value: string, title: string): string {
  const destination = /[\s()<>]/.test(value) ? `<${value.replaceAll('<', '%3C').replaceAll('>', '%3E')}>` : value
  return destination + (title ? ` "${title.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : '')
}
function inline(node: Node, literal = false): Fragment {
  if (node.nodeType === Node.TEXT_NODE) return textFragment(node, literal)
  if (node.nodeType !== Node.ELEMENT_NODE) return empty()
  const element = node as HTMLElement
  const tag = element.tagName.toLowerCase()
  if (element.dataset.writeImage !== undefined) return { text: `![${decode(element.dataset.writeAlt).replace(/[\\[\]]/g, '\\$&')}](${markdownTarget(decode(element.dataset.writeImage), decode(element.dataset.writeTitle))})`, points: new Map() }
  if (tag === 'input') return empty()
  if (tag === 'br') return { text: '  \n', points: new Map() }
  const content = children(element, literal || tag === 'code')
  if (tag === 'strong' || tag === 'b') return wrap(content, '**', '**')
  if (tag === 'em' || tag === 'i') return wrap(content, '*', '*')
  if (tag === 'del' || tag === 's') return wrap(content, '~~', '~~')
  if (tag === 'code') {
    const longest = Math.max(0, ...(content.text.match(/`+/g) ?? []).map((run) => run.length))
    const fence = '`'.repeat(longest + 1)
    const padding = /^`|`$|^ .+ $/s.test(content.text) ? ' ' : ''
    return wrap(content, fence + padding, padding + fence)
  }
  if (tag === 'a') {
    const href = decode(element.dataset.writeHref)
    return href ? wrap(content, '[', `](${markdownTarget(href, decode(element.dataset.writeTitle))})`) : content
  }
  return content
}
function serializeList(element: HTMLElement): Fragment {
  const result = empty()
  const ordered = element.tagName.toLowerCase() === 'ol'
  const start = Number(element.getAttribute('start') ?? 1)
  const items = Array.from(element.children).filter((child) => child.tagName.toLowerCase() === 'li')
  items.forEach((item, index) => {
    const content = empty()
    for (const child of Array.from(item.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && /\n/.test(child.textContent ?? '') && !(child.textContent ?? '').trim()) continue
      const tag = child.nodeType === Node.ELEMENT_NODE ? (child as HTMLElement).tagName.toLowerCase() : ''
      if (tag === 'ul' || tag === 'ol') {
        if (content.text && !content.text.endsWith('\n')) append(content, '\n')
        append(content, serializeList(child as HTMLElement))
      } else if (tag === 'p') {
        if (content.text && !content.text.endsWith('\n')) append(content, '\n\n')
        append(content, children(child))
      } else if (/^(blockquote|pre|table)$/.test(tag)) {
        if (content.text && !content.text.endsWith('\n\n')) append(content, '\n\n')
        append(content, serializeBlock(child))
      } else append(content, inline(child))
    }
    const checkbox = item.querySelector(':scope > input[data-write-task], :scope > p > input[data-write-task]') as HTMLInputElement | null
    const marker = `${ordered ? `${start + index}.` : '-'} `
    const task = checkbox ? `[${checkbox.checked ? 'x' : ' '}]` : ''
    const itemPrefix = marker + task
    const continuation = ' '.repeat(marker.length)
    const normalized = prefixLines(content, (line) => line === 0 ? itemPrefix : continuation)
    if (index) append(result, '\n')
    append(result, normalized)
  })
  return result
}
function serializeBlock(node: Node): Fragment {
  if (node.nodeType === Node.TEXT_NODE) return textFragment(node)
  if (node.nodeType !== Node.ELEMENT_NODE) return empty()
  const element = node as HTMLElement
  const tag = element.tagName.toLowerCase()
  if (tag === 'pre') {
    const code = element.querySelector('code')
    const content = children(code ?? element, true)
    const info = code?.className.match(/(?:^|\s)language-(\S+)/)?.[1] ?? ''
    const longest = Math.max(2, ...(content.text.match(/`+/g) ?? []).map((run) => run.length))
    return wrap(content, `${'`'.repeat(longest + 1)}${info}\n`, `${content.text.endsWith('\n') ? '' : '\n'}${'`'.repeat(longest + 1)}`)
  }
  if (tag === 'ul' || tag === 'ol') return serializeList(element)
  if (tag === 'blockquote') return prefixLines(serializeChildren(element), () => '> ')
  if (tag === 'hr') return { text: '---', points: new Map() }
  if (tag === 'table') {
    const result = empty()
    const rows = Array.from(element.querySelectorAll('tr'))
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      if (rowIndex) append(result, '\n')
      append(result, '| ')
      const cells = Array.from(rows[rowIndex].children)
      cells.forEach((cell, index) => {
        if (index) append(result, ' | ')
        const fragment = children(cell)
        // Pipes must be escaped without changing source positions silently.
        if (fragment.text.includes('|') || fragment.text.includes('\n')) {
          append(result, fragment.text.replaceAll('|', '\\|').replaceAll('\n', '<br />'))
        } else append(result, fragment)
      })
      append(result, ' |')
      if (rowIndex === 0) append(result, `\n| ${cells.map((cell) => cell.getAttribute('style')?.includes('right') ? '---:' : cell.getAttribute('style')?.includes('center') ? ':---:' : '---').join(' | ')} |`)
    }
    return result
  }
  const content = children(element)
  if (/^h[1-6]$/.test(tag)) return wrap(content, `${'#'.repeat(Number(tag[1]))} `, '')
  if (tag === 'div' && Array.from(element.children).some((child) => /^(P|DIV|H[1-6]|UL|OL|BLOCKQUOTE|PRE)$/.test(child.tagName))) return serializeChildren(element)
  return content
}
function serializeChildren(element: Node): Fragment {
  const result = empty()
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && !(child.textContent ?? '').trim()) continue
    const fragment = serializeBlock(child)
    if (result.text && fragment.text) append(result, '\n\n')
    append(result, fragment)
  }
  return result
}
function fingerprint(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement
  for (const image of clone.querySelectorAll('[data-write-local-image]')) image.remove()
  for (const input of clone.querySelectorAll('input')) {
    const original = element.querySelectorAll('input')[Array.from(clone.querySelectorAll('input')).indexOf(input)] as HTMLInputElement | undefined
    input.toggleAttribute('checked', Boolean(original?.checked))
  }
  return clone.innerHTML
}
function initialFingerprint(block: HTMLElement): string {
  const container = document.createElement('div')
  container.innerHTML = decode(block.dataset.writeInitial)
  return fingerprint(container)
}
function currentBlock(block: HTMLElement): { source: string; fragment?: Fragment } {
  const source = decode(block.dataset.writeSource)
  if (block.dataset.writeReadonly === 'true' || fingerprint(block) === initialFingerprint(block)) return { source }
  const fragment = serializeChildren(block)
  const ending = /(?:\r?\n)*$/.exec(source)?.[0] ?? ''
  return { source: fragment.text + ending, fragment }
}

export function serializeWriteRichHtml(root: HTMLElement): string {
  return Array.from(root.children).filter((child) => !child.hasAttribute('data-write-rich-display-only')).map((child) => child.hasAttribute(BLOCK_ATTR) ? currentBlock(child as HTMLElement).source : serializeBlock(child).text).join('')
}

/** Rebase source metadata after a local edit while preserving the browser selection. */
export function rebaseWriteRichProjection(root: HTMLElement): void {
  let offset = 0
  for (const child of Array.from(root.children)) {
    const block = child as HTMLElement
    if (!block.hasAttribute(BLOCK_ATTR)) continue
    const { source } = currentBlock(block)
    block.dataset.writeSource = encodeURIComponent(source)
    block.dataset.writeOffset = String(offset)
    block.dataset.writeInitial = encodeURIComponent(fingerprint(block))
    offset += source.length
  }
}

function pointInBlock(block: HTMLElement, node: Node, offset: number): number | null {
  const fragment = serializeChildren(block)
  const original = currentBlock(block).source
  // Fail closed for noncanonical spelling: never guess against repeated text,
  // escaped entities, reference links or an unsupported syntax extension.
  if (fragment.text.trimEnd() !== original.trimEnd()) return null
  if (node.nodeType === Node.TEXT_NODE) return fragment.points.get(node)?.[offset] ?? null
  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node as HTMLElement
    const candidate = element.childNodes[offset]
    if (candidate) {
      const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT)
      const textNode = candidate.nodeType === Node.TEXT_NODE ? candidate : walker.nextNode()
      if (textNode) return fragment.points.get(textNode)?.[0] ?? null
    }
    const before = element.childNodes[Math.max(0, offset - 1)]
    if (before) {
      const walker = document.createTreeWalker(before, NodeFilter.SHOW_TEXT)
      let last: Node | null = before.nodeType === Node.TEXT_NODE ? before : null
      while (walker.nextNode()) last = walker.currentNode
      const points = last ? fragment.points.get(last) : undefined
      if (points) return points[points.length - 1]
    }
  }
  return null
}

export function richSelectionSourceRange(root: HTMLElement, range: Range): { from: number; to: number } | null {
  const parentBlock = (node: Node): HTMLElement | null => (node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement)?.closest(`[${BLOCK_ATTR}]`) as HTMLElement | null
  const start = parentBlock(range.startContainer)
  const end = parentBlock(range.endContainer)
  if (!start || !end || !root.contains(start) || !root.contains(end) || start.dataset.writeReadonly === 'true' || end.dataset.writeReadonly === 'true') return null
  const from = pointInBlock(start, range.startContainer, range.startOffset)
  const to = pointInBlock(end, range.endContainer, range.endOffset)
  if (from === null || to === null) return null
  return { from: Number(start.dataset.writeOffset) + from, to: Number(end.dataset.writeOffset) + to }
}
