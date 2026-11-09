import { createHash } from 'node:crypto'

export type DocumentSection = { id: string; heading: string; level: number; startLine: number; endLine: number; start: number; bodyStart: number; end: number }
export type CandidateSectionDependency = Pick<DocumentSection, 'id'|'heading'|'level'|'startLine'|'endLine'> & { sourcePaths: string[] }

/** Heading spans exclude fenced code/frontmatter and retain exact byte slices of the original string. */
export function documentSections(markdown: string): DocumentSection[] {
  const lines = markdown.match(/.*(?:\r\n|\n|$)/g)?.filter(Boolean) ?? []
  const offsets: number[] = []
  let offset = 0
  for (const line of lines) { offsets.push(offset); offset += line.length }
  const headings: Array<{ heading: string; level: number; line: number; start: number; bodyStart: number }> = []
  let frontmatter = lines[0]?.trim() === '---'
  let contentStart = 0
  let fence: { marker: string; length: number } | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\r?\n$/, '')
    if (frontmatter) {
      if (index > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) { frontmatter = false; contentStart = offsets[index]! + lines[index]!.length }
      continue
    }
    const fenced = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenced) {
      if (!fence) fence = { marker: fenced[1]![0]!, length: fenced[1]!.length }
      else if (fenced[1]![0] === fence.marker && fenced[1]!.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined
      continue
    }
    if (fence) continue
    const atx = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/)
    if (atx) { headings.push({ heading: atx[2]!.replace(/[ \t]+#+[ \t]*$/, '').trim(), level: atx[1]!.length, line: index, start: offsets[index]!, bodyStart: offsets[index]! + lines[index]!.length }); continue }
    if (/^ {0,3}(?:=+|-+)\s*$/.test(line) && index > 0) {
      const previous = lines[index - 1]!.trim()
      if (previous && !/^(?:#{1,6}\s|`{3,}|~{3,})/.test(previous) && !headings.some(item => item.line === index - 1)) headings.push({ heading: previous, level: line.trim()[0] === '=' ? 1 : 2, line: index - 1, start: offsets[index - 1]!, bodyStart: offsets[index]! + lines[index]!.length })
    }
  }
  const seen = new Map<string, number>()
  const result: DocumentSection[] = headings.map((heading, index) => {
    const key = `${heading.level}:${heading.heading}`
    const occurrence = (seen.get(key) ?? 0) + 1; seen.set(key, occurrence)
    const next = headings.slice(index + 1).find(item => item.level <= heading.level)
    return { ...heading, id: `section_${createHash('sha256').update(`${key}:${occurrence}`).digest('hex').slice(0, 20)}`, startLine: heading.line + 1, endLine: next ? next.line : lines.length, end: next?.start ?? markdown.length }
  })
  const first = headings[0]?.start ?? markdown.length
  if (!headings.length || markdown.slice(contentStart, first).trim()) result.unshift({ id: 'document-preamble', heading: headings.length ? '标题前正文' : '正文', level: 0, startLine: lines.findIndex((_line, index) => offsets[index]! >= contentStart) + 1 || 1, endLine: headings[0]?.line ?? lines.length, start: contentStart, bodyStart: contentStart, end: first })
  return result
}

export function resolveSection(sections: DocumentSection[], heading: string): DocumentSection {
  const match = sections.filter(item => item.id === heading || item.heading === heading)
  if (match.length !== 1) throw new Error(`Section heading is missing or ambiguous: ${heading}`)
  return match[0]!
}

export function patchDocumentSections(markdown: string, patches: Array<{ heading: string; content: string }>): { content: string; patched: DocumentSection[] } {
  const sections = documentSections(markdown)
  const changes = patches.map(patch => ({ section: resolveSection(sections, patch.heading), content: patch.content }))
  const sorted = [...changes].sort((a, b) => a.section.start - b.section.start)
  for (let index = 0; index < sorted.length; index += 1) {
    const { section, content } = sorted[index]!
    if (index && sorted[index - 1]!.section.end > section.start) throw new Error('Section patches overlap; patch a parent or its child, not both.')
    const nextHeadings = documentSections(content).filter(item => item.level > 0).map(({ heading, level }) => ({ heading, level }))
    const previousHeadings = documentSections(markdown.slice(section.bodyStart, section.end)).filter(item => item.level > 0).map(({ heading, level }) => ({ heading, level }))
    if (JSON.stringify(nextHeadings) !== JSON.stringify(previousHeadings)) throw new Error('Section patches preserve existing subsection headings; use a whole new candidate to restructure headings.')
  }
  let content = markdown
  for (const change of sorted.reverse()) {
    const newline = markdown.includes('\r\n') ? '\r\n' : '\n'
    const body = change.content.replace(/\r?\n/g, newline)
    const normalized = body && !body.endsWith(newline) ? `${body}${newline}` : body
    const replacement = normalized && change.section.bodyStart > 0 && !/[\r\n]/.test(markdown[change.section.bodyStart - 1]!) ? `${newline}${normalized}` : normalized
    content = `${content.slice(0, change.section.bodyStart)}${replacement}${content.slice(change.section.end)}`
  }
  return { content, patched: changes.map(item => item.section) }
}
