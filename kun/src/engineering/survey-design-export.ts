import { z } from 'zod'

export class SurveyDesignExportError extends Error {
  constructor(readonly reason: 'invalid-document' | 'unsupported-content' | 'invalid-path' | 'invalid-group') {
    super(reason === 'unsupported-content'
      ? '图件包含尚不能可靠导出的图片或形状，请改为矢量图件后重试。'
      : '图件内容不完整或格式有误，请在图件编辑器中检查后重试。')
    this.name = 'SurveyDesignExportError'
  }
}

export type SurveyDesignExportOptions = {
  title?: string
  coordinateSystem?: string
  units?: string
}

// Matches persisted DesignDocumentV1 geometry. The runtime deliberately does
// not normalize broken records: silently dropping a shape is unsafe in a report.
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000)
const color = z.string().regex(/^[a-fA-F0-9]{6}$/)
const id = z.string().min(1).max(160)
const path = z.string().min(1).max(100_000)
const presetPath = z.object({
  d: path,
  fill: color.nullable().optional(),
  stroke: color.nullable().optional(),
  strokeWidth: z.number().finite().min(0).max(20_000).optional(),
  opacity: z.number().finite().min(0).max(1).optional()
})
const element = z.object({
  id,
  type: z.enum(['rect', 'ellipse', 'line', 'path', 'text', 'image', 'preset', 'group']),
  x: coordinate,
  y: coordinate,
  w: coordinate,
  h: coordinate,
  rotation: coordinate,
  zIndex: coordinate,
  fill: color.optional(),
  stroke: color.optional(),
  strokeWidth: z.number().finite().min(0).max(20_000).optional(),
  strokeLinecap: z.enum(['butt', 'round', 'square']).optional(),
  strokeLinejoin: z.enum(['miter', 'round', 'bevel']).optional(),
  opacity: z.number().finite().min(0).max(1).optional(),
  text: z.string().max(256 * 1024).optional(),
  fontSize: z.number().finite().positive().max(20_000).optional(),
  fontFamily: z.string().max(512).optional(),
  fontWeight: z.string().max(64).optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  letterSpacing: coordinate.optional(),
  pathData: path.optional(),
  presetPaths: z.array(presetPath).max(256).optional(),
  childIds: z.array(id).max(5_000).optional(),
  hidden: z.boolean().optional()
}).passthrough().refine(e => e.type === 'line' || (e.w > 0 && e.h > 0))
const page = z.object({
  id,
  name: z.string().max(512),
  width: z.number().int().min(1).max(20_000),
  height: z.number().int().min(1).max(20_000),
  background: color.optional(),
  displayMode: z.enum(['editable', 'fidelity']).optional(),
  fidelityImageAssetId: id.optional(),
  elements: z.array(element).max(5_000)
}).passthrough()
const documentSchema = z.object({
  schemaVersion: z.literal('v1'),
  pages: z.array(page).min(1).max(256),
  assets: z.array(z.unknown()).max(1_024)
}).passthrough()
type VectorElement = z.infer<typeof element>
type VectorPage = z.infer<typeof page>

function xml(text: string): string {
  // XML 1.0 cannot contain these control characters, even when escaped.
  const safe = Array.from(text).filter(character => {
    const code = character.codePointAt(0)!
    return !((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 0xfffe || code === 0xffff)
  }).join('')
  return safe
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function validatePath(data: string): string {
  const tokens: Array<string | number> = []
  const tokenPattern = /[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g
  let end = 0
  for (const match of data.matchAll(tokenPattern)) {
    const gap = data.slice(end, match.index)
    const command = /^[a-z]$/i.test(match[0])
    if (!/^[\s,]*$/.test(gap) || (gap.includes(',') && (
      gap.split(',').length !== 2 || command || typeof tokens.at(-1) !== 'number'
    ))) throw new SurveyDesignExportError('invalid-path')
    if (command) tokens.push(match[0])
    else {
      const value = Number(match[0])
      if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new SurveyDesignExportError('invalid-path')
      tokens.push(value)
    }
    end = match.index + match[0].length
  }
  if (!/^\s*$/.test(data.slice(end)) || !/^[Mm]$/.test(String(tokens[0]))) {
    throw new SurveyDesignExportError('invalid-path')
  }
  const arities: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7 }
  for (let index = 0; index < tokens.length;) {
    const command = tokens[index++]
    if (typeof command !== 'string') throw new SurveyDesignExportError('invalid-path')
    const upper = command.toUpperCase()
    const start = index
    while (typeof tokens[index] === 'number') index++
    const count = index - start
    if (upper === 'Z') {
      if (count) throw new SurveyDesignExportError('invalid-path')
      continue
    }
    const arity = arities[upper]!
    if (!count || count % arity !== 0) throw new SurveyDesignExportError('invalid-path')
    if (upper === 'A') {
      for (let arc = start; arc < index; arc += 7) {
        if ((tokens[arc] as number) < 0 || (tokens[arc + 1] as number) < 0 ||
          ![0, 1].includes(tokens[arc + 3] as number) || ![0, 1].includes(tokens[arc + 4] as number)) {
          throw new SurveyDesignExportError('invalid-path')
        }
      }
    }
  }
  return data
}

function validatePage(page: VectorPage): void {
  const byId = new Map<string, VectorElement>()
  for (const element of page.elements) {
    if (byId.has(element.id)) throw new SurveyDesignExportError('invalid-group')
    byId.set(element.id, element)
    if (element.type === 'image') throw new SurveyDesignExportError('unsupported-content')
    if (element.type === 'path') {
      if (!element.pathData) throw new SurveyDesignExportError('invalid-path')
      validatePath(element.pathData)
    }
    if (element.type === 'preset') {
      const paths = element.presetPaths?.length ? element.presetPaths : element.pathData ? [{ d: element.pathData }] : []
      if (!paths.length) throw new SurveyDesignExportError('unsupported-content')
      for (const path of paths) validatePath(path.d)
    }
  }
  const parentByChild = new Map<string, string>()
  for (const group of page.elements.filter(e => e.type === 'group')) {
    for (const child of group.childIds ?? []) {
      if (child === group.id || !byId.has(child) || parentByChild.has(child)) {
        throw new SurveyDesignExportError('invalid-group')
      }
      parentByChild.set(child, group.id)
    }
  }
  const completed = new Set<string>()
  for (const element of page.elements) {
    const chain = new Set<string>()
    let cursor: string | undefined = element.id
    while (cursor && !completed.has(cursor)) {
      if (chain.has(cursor)) throw new SurveyDesignExportError('invalid-group')
      chain.add(cursor)
      cursor = parentByChild.get(cursor)
    }
    for (const id of chain) completed.add(id)
  }
}

function styles(e: VectorElement): string {
  return [
    `fill="${e.fill ? `#${e.fill}` : 'none'}"`,
    ...(e.stroke ? [`stroke="#${e.stroke}"`] : []),
    ...(e.strokeWidth !== undefined ? [`stroke-width="${e.strokeWidth}"`] : []),
    ...(e.opacity !== undefined ? [`opacity="${e.opacity}"`] : []),
    ...(e.strokeLinecap ? [`stroke-linecap="${e.strokeLinecap}"`] : []),
    ...(e.strokeLinejoin ? [`stroke-linejoin="${e.strokeLinejoin}"`] : [])
  ].join(' ')
}

function vector(e: VectorElement): string {
  if (e.hidden || e.type === 'group') return ''
  const rotation = e.rotation % 360
  const transform = rotation ? ` transform="rotate(${rotation} ${e.x + e.w / 2} ${e.y + e.h / 2})"` : ''
  const paint = styles(e)
  switch (e.type) {
    case 'rect': return `<rect x="${e.x}" y="${e.y}" width="${e.w}" height="${e.h}" ${paint}${transform}/>`
    case 'ellipse': return `<ellipse cx="${e.x + e.w / 2}" cy="${e.y + e.h / 2}" rx="${e.w / 2}" ry="${e.h / 2}" ${paint}${transform}/>`
    case 'line': return `<line x1="${e.x}" y1="${e.y}" x2="${e.x + e.w}" y2="${e.y + e.h}" ${styles({ ...e, fill: undefined })}${transform}/>`
    case 'path': return `<path d="${xml(e.pathData!)}" ${paint}${transform}/>`
    case 'text': {
      const size = e.fontSize ?? 24
      const align = e.textAlign ?? 'left'
      const x = align === 'center' ? e.x + e.w / 2 : align === 'right' ? e.x + e.w : e.x
      const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
      const lines = (e.text ?? '').split(/\r?\n/)
      const body = lines.length === 1 ? xml(lines[0]!) : lines.map((line, index) =>
        `<tspan x="${x}" dy="${index ? size * 1.2 : 0}">${xml(line)}</tspan>`).join('')
      return `<text x="${x}" y="${e.y + size}" font-size="${size}" font-family="${xml(e.fontFamily ?? "system-ui, 'Microsoft YaHei', sans-serif")}" font-weight="${xml(e.fontWeight ?? 'normal')}" text-anchor="${anchor}"${e.letterSpacing !== undefined ? ` letter-spacing="${e.letterSpacing}"` : ''} ${paint}${transform}>${body}</text>`
    }
    case 'preset': {
      const paths = e.presetPaths?.length ? e.presetPaths : [{ d: e.pathData! }]
      const body = paths.map(p => `<path d="${xml(p.d)}" ${styles({ ...e,
        fill: p.fill === null ? undefined : p.fill ?? e.fill,
        stroke: p.stroke === null ? undefined : p.stroke ?? e.stroke,
        strokeWidth: p.strokeWidth ?? e.strokeWidth,
        opacity: p.opacity ?? e.opacity
      })}/>`).join('')
      return `<g${transform}><g transform="translate(${e.x} ${e.y}) scale(${e.w / 200} ${e.h / 150})">${body}</g></g>`
    }
    default: throw new SurveyDesignExportError('unsupported-content')
  }
}

/**
 * Safe vector-only Survey output. Pages keep their own dimensions and are
 * stacked vertically; review/scale/reference notices sit outside editable pages.
 * Design groups are metadata: the editor persists transformed child geometry,
 * and children retain their global zIndex. Applying group transforms again
 * would change the reviewed drawing.
 */
export function surveyDesignSvg(raw: unknown, options: SurveyDesignExportOptions = {}): string {
  const parsed = documentSchema.safeParse(raw)
  if (!parsed.success) throw new SurveyDesignExportError('invalid-document')
  const document = parsed.data
  if (document.assets.length || document.pages.some(p => p.displayMode === 'fidelity' || p.fidelityImageAssetId)) {
    throw new SurveyDesignExportError('unsupported-content')
  }
  if (document.pages.reduce((total, page) => total + page.elements.length, 0) > 20_000) {
    throw new SurveyDesignExportError('invalid-document')
  }
  const pageIds = new Set<string>()
  for (const page of document.pages) {
    if (pageIds.has(page.id)) throw new SurveyDesignExportError('invalid-document')
    pageIds.add(page.id)
    validatePage(page)
  }
  const title = xml((options.title ?? '工程测量成果图件').slice(0, 512))
  const references = xml([
    options.coordinateSystem ? `坐标基准：${options.coordinateSystem}` : '基准以所选原成果声明为准',
    options.units ? `单位：${options.units}` : '单位以所选原成果声明为准'
  ].join(' · ').slice(0, 1_024))
  const width = Math.max(...document.pages.map(page => page.width))
  const header = 40, footer = 64, gap = 24
  const height = document.pages.reduce((total, page) => total + header + page.height + footer, 0) + gap * (document.pages.length - 1)
  let y = 0
  const pages = document.pages.map((page, index) => {
    const pageTitle = `<text x="12" y="${y + 26}" fill="#1E293B" font-size="16">${index + 1}. ${xml(page.name)} · 待审草稿</text>`
    y += header
    const body = [...page.elements].sort((a, b) => a.zIndex - b.zIndex).map(vector).join('')
    const drawing = `<svg x="0" y="${y}" width="${page.width}" height="${page.height}" viewBox="0 0 ${page.width} ${page.height}" overflow="hidden"><rect width="${page.width}" height="${page.height}" fill="#${page.background ?? 'FFFFFF'}"/>${body}</svg>`
    y += page.height
    const note = `<text x="12" y="${y + 24}" fill="#475569" font-size="12">待审草稿 · 非比例示意 · 不替代专业签认</text><text x="12" y="${y + 44}" fill="#475569" font-size="12">${references}</text>`
    y += footer + gap
    return pageTitle + drawing + note
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${title} · 待审草稿</title><desc>多页矢量成果图件。非比例示意，基准与单位须按原成果复核，未经专业签认。</desc><rect width="${width}" height="${height}" fill="#FFFFFF"/>${pages}</svg>`
}
