import MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'
import katex from 'katex'

export const WRITE_MATH_MAX_LENGTH = 8192
export const writeMathOptions = {
  throwOnError: false,
  trust: false,
  strict: 'error' as const,
  maxExpand: 1000,
  maxSize: 20,
  output: 'htmlAndMathml' as const
}

export const escapeWriteHtml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

export function renderWriteMath(source: string, display: boolean): string {
  if (source.length > WRITE_MATH_MAX_LENGTH) return `<code class="write-math-error" role="status">${escapeWriteHtml(source)}</code>`
  try {
    return katex.renderToString(source, { ...writeMathOptions, displayMode: display, macros: {} })
  } catch {
    return `<code class="write-math-error" role="status">${escapeWriteHtml(source)}</code>`
  }
}

function isEscaped(source: string, position: number): boolean {
  let slashes = 0
  for (let index = position - 1; index >= 0 && source[index] === '\\'; index -= 1) slashes += 1
  return slashes % 2 === 1
}

/** Markdown-aware rules run after code/escape rules; currency and escaped dollars stay text. */
export function installWriteAdvancedMarkdown(md: MarkdownIt): void {
  md.use(footnote)
  md.core.ruler.after('inline', 'write_task_list', (state) => {
    for (let index = 2; index < state.tokens.length; index += 1) {
      const inline = state.tokens[index]
      if (inline.type !== 'inline' || state.tokens[index - 1]?.type !== 'paragraph_open' || state.tokens[index - 2]?.type !== 'list_item_open') continue
      const first = inline.children?.[0]
      const task = first?.type === 'text' ? /^\[([ xX])\] /.exec(first.content) : null
      if (!first || !task) continue
      first.content = first.content.slice(task[0].length)
      const token = new state.Token('write_task_checkbox', 'input', 0)
      token.meta = { checked: task[1].toLowerCase() === 'x' }
      inline.children!.unshift(token)
    }
  })
  md.renderer.rules.write_task_checkbox = (tokens, index) => `<input type="checkbox" data-write-task="true" disabled${tokens[index].meta.checked ? ' checked' : ''}> `
  md.inline.ruler.after('escape', 'write_math', (state, silent) => {
    const from = state.pos
    const source = state.src
    const slash = source.startsWith('\\(', from)
    const dollar = source[from] === '$' && source[from + 1] !== '$'
    if (!slash && !dollar) return false
    if (dollar && (/\s/.test(source[from + 1] ?? '') || /\d/.test(source[from - 1] ?? ''))) return false
    const opener = slash ? '\\(' : '$'
    const closer = slash ? '\\)' : '$'
    let to = source.indexOf(closer, from + opener.length)
    while (to !== -1 && isEscaped(source, to)) to = source.indexOf(closer, to + closer.length)
    if (to === -1 || source.slice(from + opener.length, to).includes('\n')) return false
    if (dollar && (/\s/.test(source[to - 1] ?? '') || /\d/.test(source[to + 1] ?? ''))) return false
    const content = source.slice(from + opener.length, to)
    if (!content.trim() || content.includes('`')) return false
    if (!silent) {
      const token = state.push('math_inline', 'math', 0)
      token.content = content
      token.markup = opener
    }
    state.pos = to + closer.length
    return true
  })
  // Backslash delimiters must precede Markdown's escape rule.
  md.inline.ruler.before('escape', 'write_math_slash', (state, silent) => {
    if (!state.src.startsWith('\\(', state.pos)) return false
    const from = state.pos
    const to = state.src.indexOf('\\)', from + 2)
    if (to === -1 || state.src.slice(from + 2, to).includes('\n')) return false
    if (!silent) {
      const token = state.push('math_inline', 'math', 0)
      token.content = state.src.slice(from + 2, to)
      token.markup = '\\('
    }
    state.pos = to + 2
    return true
  })
  md.block.ruler.before('fence', 'write_math_block', (state, startLine, endLine, silent) => {
    const from = state.bMarks[startLine] + state.tShift[startLine]
    const first = state.src.slice(from, state.eMarks[startLine])
    const opener = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : null
    if (!opener || state.sCount[startLine] - state.blkIndent >= 4) return false
    const closer = opener === '$$' ? '$$' : '\\]'
    let end = startLine
    let content = first.slice(opener.length)
    const inlineEnd = content.indexOf(closer)
    if (inlineEnd >= 0 && !content.slice(inlineEnd + closer.length).trim()) content = content.slice(0, inlineEnd)
    else {
      const lines = [content]
      let found = false
      for (end = startLine + 1; end < endLine; end += 1) {
        const line = state.src.slice(state.bMarks[end] + state.tShift[end], state.eMarks[end])
        const close = line.indexOf(closer)
        if (close >= 0 && !line.slice(close + closer.length).trim()) { lines.push(line.slice(0, close)); found = true; break }
        lines.push(line)
      }
      if (!found) return false
      content = lines.join('\n')
    }
    if (silent) return true
    const token = state.push('math_block', 'math', 0)
    token.block = true
    token.content = content.trim()
    token.map = [startLine, end + 1]
    token.markup = opener
    state.line = end + 1
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.renderer.rules.math_inline = (tokens, index) => `<span class="write-math-inline" data-write-math="${encodeURIComponent(tokens[index].content)}">${renderWriteMath(tokens[index].content, false)}</span>`
  md.renderer.rules.math_block = (tokens, index) => `<div class="write-math-block" data-write-math="${encodeURIComponent(tokens[index].content)}">${renderWriteMath(tokens[index].content, true)}</div>\n`
  const fence = md.renderer.rules.fence!
  md.renderer.rules.fence = (tokens, index, options, env, renderer) => {
    const language = tokens[index].info.trim().split(/\s+/)[0].toLowerCase()
    if (language === 'math' || language === 'latex') return `<div class="write-math-block" data-write-math="${encodeURIComponent(tokens[index].content)}">${renderWriteMath(tokens[index].content, true)}</div>\n`
    if (language === 'mermaid') return renderWriteMermaidPlaceholder(tokens[index].content)
    return fence(tokens, index, options, env, renderer)
  }
}

export function renderWriteMermaidPlaceholder(source: string): string {
  return `<div class="write-mermaid" data-write-mermaid="${encodeURIComponent(source)}"><pre>${escapeWriteHtml(source)}</pre></div>\n`
}

export function createWriteMarkdownIt(options: Parameters<MarkdownIt['set']>[0] = {}): MarkdownIt {
  const markdown = new MarkdownIt({ html: false, breaks: false, linkify: false, typographer: false, ...options })
  installWriteAdvancedMarkdown(markdown)
  return markdown
}
