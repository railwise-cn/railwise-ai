import { createHash } from 'node:crypto'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveContainedPath } from './canonical-containment'

type HeadingToken = {
  type: string
  content: string
  children?: HeadingToken[] | null
  attrSet?: (name: string, value: string) => void
  meta?: { id?: number; subId?: number } | null
}

type ExportHeading = { bookmark: string; htmlId: string }

/** Shared source heading anchors, HTML IDs and Word-safe bookmark names. */
export function assignWriteExportHeadings(tokens: HeadingToken[]): Map<string, ExportHeading> {
  const headings = new Map<string, ExportHeading>()
  const usedHtmlIds = new Set<string>()
  const reserveFootnotes = (items: HeadingToken[]): void => {
    for (const token of items) {
      if (token.type === 'footnote_ref' && token.meta?.id !== undefined) {
        const number = token.meta.id + 1
        usedHtmlIds.add(`fn${number}`)
        usedHtmlIds.add(`fnref${number}${token.meta.subId ? `:${token.meta.subId}` : ''}`)
      }
      if (token.children) reserveFootnotes(token.children)
    }
  }
  reserveFootnotes(tokens)
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== 'heading_open') continue
    const inline = tokens[index + 1]
    const text = inline?.children?.map((child) =>
      ['text', 'code_inline', 'math_inline', 'image'].includes(child.type) ? child.content
        : ['softbreak', 'hardbreak'].includes(child.type) ? ' ' : '').join('') ?? inline?.content ?? ''
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, '').replace(/\s+/g, '-') || 'section'
    let slug = base
    for (let suffix = 1; headings.has(slug); suffix += 1) slug = `${base}-${suffix}`
    tokens[index].attrSet?.('id', slug)
    // Word bookmark names are ASCII, begin with a letter and stay below 40 chars.
    headings.set(slug, { bookmark: `RailWiseHeading${createHash('sha256').update(slug).digest('hex').slice(0, 24)}`, htmlId: slug })
  }
  for (const [slug, heading] of headings) {
    if (usedHtmlIds.has(slug)) {
      const base = `railwise-heading-${slug}`
      let id = base
      for (let suffix = 1; usedHtmlIds.has(id) || headings.has(id); suffix += 1) id = `${base}-${suffix}`
      heading.htmlId = id
    }
    usedHtmlIds.add(heading.htmlId)
  }
  return headings
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

/** Resolve clicked links only. Never fetches the target or relaxes image policy. */
export async function resolveWriteExportLink(input: {
  href: string
  sourcePath: string
  workspaceRoot?: string
}): Promise<string | undefined> {
  try {
    const href = input.href.trim()
    if (!href || hasControlCharacters(href) || href.includes('\\') || href.startsWith('//')) return undefined
    if (href.startsWith('#')) return href
    const protocol = /^([a-z][a-z\d+.-]*):/i.exec(href)?.[1].toLowerCase()
    if (protocol && ['http', 'https', 'mailto'].includes(protocol)) {
      const url = new URL(href)
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : undefined
    }
    if (protocol && protocol !== 'file') return undefined
    let candidate: string, suffix: string
    if (protocol === 'file') {
      const url = new URL(href)
      if (url.hostname && url.hostname !== 'localhost') return undefined
      if (/%5c/i.test(url.pathname)) return undefined
      candidate = fileURLToPath(url)
      suffix = `${url.search}${url.hash}`
    } else {
      const split = href.search(/[?#]/)
      const pathname = split === -1 ? href : href.slice(0, split)
      suffix = split === -1 ? '' : href.slice(split)
      const decoded = decodeURIComponent(pathname)
      if (!decoded || hasControlCharacters(decoded) || decoded.includes('\\') || decoded.startsWith('//')) return undefined
      candidate = isAbsolute(decoded) ? decoded : resolve(dirname(input.sourcePath), decoded)
    }
    if (hasControlCharacters(candidate)) return undefined
    // Check the filesystem path separately from the URL suffix. This catches
    // encoded traversal, symlink escapes and explicit file URLs outside root.
    await resolveContainedPath({ root: input.workspaceRoot || dirname(input.sourcePath), target: candidate, expect: 'file', rejectFinalLink: true })
    return `${pathToFileURL(candidate).href}${suffix}`
  } catch { return undefined }
}
