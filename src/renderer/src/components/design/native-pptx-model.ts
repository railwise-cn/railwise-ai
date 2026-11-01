import type { ElementUpdate, PptxElement, PptxSlide } from 'pptx-vanilla-viewer'

export type NativePptxSnapshot = {
  documentId: string
  slideId: string
  slideIndex: number
  revision: number
  selectedIds: string[]
  slide: PptxSlide
  preview: string
}

const PROTECTED_TYPES = new Set(['smartArt', 'unknown', 'ole', 'media', 'model3d', 'contentPart', 'zoom'])
const PATCH_KEYS = new Set([
  'name', 'x', 'y', 'width', 'height', 'rotation', 'flipHorizontal', 'flipVertical',
  'opacity', 'text', 'textStyle', 'textSegments', 'paragraphIndents', 'shapeStyle',
  'tableData', 'chartData'
])
const TEXT_STYLE_KEYS = new Set(['fontFamily', 'fontSize', 'bold', 'italic', 'underline', 'strikethrough', 'color', 'align', 'vAlign', 'lineSpacing', 'lineSpacingExactPt', 'paragraphSpacingBefore', 'paragraphSpacingAfter', 'characterSpacing', 'textWrap', 'bodyInsetLeft', 'bodyInsetTop', 'bodyInsetRight', 'bodyInsetBottom'])

function patchedRunStyle(existing: Record<string, unknown> = {}, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...existing, ...patch }
  if ('color' in patch) {
    const color = String(patch.color).replace(/^#/, '')
    if (!/^[\dA-F]{6}$/i.test(color)) throw new Error('AI text color must be a six-digit hex value.')
    Object.assign(next, { colorXml: { 'a:srgbClr': { '@_val': color.toUpperCase() } }, colorRef: undefined })
  }
  return next
}

function normalizeTextPatch(element: PptxElement, patch: Record<string, unknown>): void {
  if (Array.isArray(patch.textSegments)) {
    if (!patch.textSegments.every((segment) => segment && typeof segment.text === 'string' &&
      Object.keys(segment).every((key) => ['text', 'style'].includes(key)) &&
      (!segment.style || Object.keys(segment.style).every((key) => TEXT_STYLE_KEYS.has(key))))) throw new Error('Unsupported AI rich text property.')
    patch.textSegments = patch.textSegments.map((segment, index) => ({ ...segment, style: patchedRunStyle(element.textSegments?.[index]?.style ?? element.textStyle, segment.style ?? {}) }))
  }
  if (patch.textStyle) {
    const style = patch.textStyle as Record<string, unknown>
    if (Object.keys(style).some((key) => !TEXT_STYLE_KEYS.has(key))) throw new Error('Unsupported AI text style property.')
    patch.textStyle = patchedRunStyle(element.textStyle, style)
    if (!('textSegments' in patch) && element.textSegments) patch.textSegments = element.textSegments.map((segment: { style: Record<string, unknown> }) => ({ ...segment, style: patchedRunStyle(segment.style, style) }))
  }
  if (typeof patch.text === 'string' && !('textSegments' in patch)) {
    patch.textSegments = [{ text: patch.text, style: (patch.textStyle ?? element.textSegments?.[0]?.style ?? element.textStyle ?? {}) }]
  }
}

export function isProtectedNativeElement(element: PptxElement): boolean {
  return PROTECTED_TYPES.has(element.type) || element.locks?.noSelect === true || element.railwiseProtected === true ||
    element.textSegments?.some((segment: { fieldType?: string }) => Boolean(segment.fieldType)) === true
}

export function nativeElementEntries(elements: readonly PptxElement[], ancestors: PptxElement[] = []): Array<{ element: PptxElement; ancestors: PptxElement[] }> {
  return elements.flatMap((element) => [
    { element, ancestors },
    ...(element.type === 'group' ? nativeElementEntries(element.children, [...ancestors, element]) : [])
  ])
}

export function nativePptxPrompt(request: string, snapshot: NativePptxSnapshot): string {
  const slideProperties = Object.fromEntries(Object.entries(snapshot.slide).filter(([key]) => key !== 'elements'))
  const entries = nativeElementEntries(snapshot.slide.elements)
  return [
    'You are proposing edits to the currently open RailWise AI native PPTX slide.',
    'Return ONLY one JSON object: {"summary":"short description","updates":[{"elementId":"existing id","patch":{...}}]}.',
    'Do not call tools, write files or execute commands. This is a proposal; the user reviews it before applying.',
    'All updates must target existing objects on this slide, including objects nested in groups. A batch is one undo step.',
    `Allowed patch keys: ${[...PATCH_KEYS].join(', ')}. Nested properties replace the full property: retain existing unrelated values.`,
    'Do not change locked/protected objects. No source, URLs, raw XML, relationship, lock or object identity changes.',
    'When changing text, update textSegments as well so the rich-text runs agree with text.',
    'For table/chart edits preserve existing structure and change only requested cells or data.',
    `Context: ${JSON.stringify({
      documentId: snapshot.documentId, slideId: snapshot.slideId, slideIndex: snapshot.slideIndex, revision: snapshot.revision,
      slide: slideProperties,
      selectedIds: snapshot.selectedIds,
      renderPreview: snapshot.preview ? { attachment: `slide-${snapshot.slideIndex + 1}.png`, mimeType: 'image/png' } : null,
      selectedObjects: snapshot.selectedIds.map((id) => entries.find((entry) => entry.element.id === id)?.element),
      objects: entries.map(({ element, ancestors }) => ({
        id: element.id, type: element.type, name: element.name, x: element.x, y: element.y,
        width: element.width, height: element.height, rotation: element.rotation, opacity: element.opacity,
        text: 'text' in element ? element.text : undefined, locks: element.locks,
        parentId: ancestors.at(-1)?.id,
        protected: isProtectedNativeElement(element) || ancestors.some(isProtectedNativeElement)
      })),
      capabilities: { update: [...PATCH_KEYS], atomicUndo: true, add: false, delete: false, editProtected: false }
    })}`,
    `User request: ${request}`
  ].join('\n')
}

export type NativePptxProposal = { summary: string; updates: ElementUpdate[]; snapshot: NativePptxSnapshot }

function preserveSourceProperties(existing: unknown, proposed: unknown): unknown {
  if (Array.isArray(existing) && Array.isArray(proposed)) {
    if (existing.length !== proposed.length) throw new Error('AI cannot change table or chart structure in a property patch.')
    return proposed.map((item, index) => preserveSourceProperties(existing[index], item))
  }
  if (existing && proposed && typeof existing === 'object' && typeof proposed === 'object' && !Array.isArray(proposed)) {
    const merged = { ...existing }
    for (const [key, value] of Object.entries(proposed)) (merged as Record<string, unknown>)[key] = preserveSourceProperties((existing as Record<string, unknown>)[key], value)
    return merged
  }
  return proposed
}

function patchNested(element: PptxElement, targetId: string, patch: Partial<PptxElement>): PptxElement {
  if (element.id === targetId) return { ...element, ...patch }
  if (element.type !== 'group') return element
  return { ...element, children: element.children.map((child: PptxElement) => patchNested(child, targetId, patch)) }
}

function safeJson(value: unknown, depth = 0, property = ''): boolean {
  if (depth > 35) return false
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return !/(?:javascript:|<script|onerror\s*=)/i.test(value) &&
    (['text', 'name', 'title', 'label'].includes(property) || !/(?:https?:|file:|data:|blob:)/i.test(value))
  if (value === null || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.length <= 30_000 && value.every((item) => safeJson(item, depth + 1, property))
  if (typeof value !== 'object') return false
  return Object.entries(value).every(([key, child]) =>
    !['__proto__', 'constructor', 'prototype', 'rawXml', 'extLstXml', 'source', 'relationships', 'url', 'href', 'imagePath'].includes(key) && safeJson(child, depth + 1, key))
}

export function parseNativePptxProposal(text: string, snapshot: NativePptxSnapshot): NativePptxProposal {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const proposal = JSON.parse(cleaned) as { summary?: unknown; updates?: unknown }
  if (typeof proposal.summary !== 'string' || !Array.isArray(proposal.updates) || proposal.updates.length === 0 || proposal.updates.length > 1000) {
    throw new Error('AI must return a summary and a non-empty update batch.')
  }
  const entries = nativeElementEntries(snapshot.slide.elements)
  const updates = new Map<string, ElementUpdate>()
  for (const value of proposal.updates) {
    if (!value || typeof value !== 'object') throw new Error('Invalid AI update.')
    const candidate = value as { elementId?: unknown; patch?: unknown }
    const entry = entries.find((item) => item.element.id === candidate.elementId)
    const element = entry?.element
    if (!entry || !element || isProtectedNativeElement(element) || entry.ancestors.some(isProtectedNativeElement)) throw new Error('AI targeted an unavailable or protected object.')
    if (snapshot.selectedIds.length > 0 && ![element.id, ...entry.ancestors.map((parent) => parent.id)].some((id) => snapshot.selectedIds.includes(id))) throw new Error('AI targeted an object outside the selected scope.')
    const patch = candidate.patch
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0 || !safeJson(patch)) {
      throw new Error('AI returned an unsafe or empty patch.')
    }
    if (Object.keys(patch).some((key) => !PATCH_KEYS.has(key))) throw new Error('AI returned an unsupported property.')
    const locks = Object.assign({}, ...entry.ancestors.map((parent) => parent.locks ?? {}), element.locks ?? {})
    const blocked = (locks.noMove && ('x' in patch || 'y' in patch)) ||
      (locks.noResize && ('width' in patch || 'height' in patch)) ||
      (locks.noRotation && 'rotation' in patch) ||
      (locks.noTextEdit && ['text', 'textStyle', 'textSegments', 'tableData'].some((key) => key in patch))
    if (blocked) throw new Error('AI attempted to change a locked property.')
    for (const key of ['x', 'y', 'width', 'height', 'rotation', 'opacity']) {
      const value = (patch as Record<string, unknown>)[key]
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`Invalid ${key}.`)
    }
    const geometry = patch as { width?: number; height?: number; opacity?: number }
    if ((geometry.width !== undefined && geometry.width <= 0) || (geometry.height !== undefined && geometry.height <= 0) ||
      (geometry.opacity !== undefined && (geometry.opacity < 0 || geometry.opacity > 1))) throw new Error('AI returned invalid geometry or opacity.')
    const retainedPatch = { ...patch } as Record<string, unknown>
    normalizeTextPatch(element, retainedPatch)
    for (const key of ['tableData', 'chartData', 'textStyle', 'shapeStyle']) {
      if (key in retainedPatch && key !== 'textStyle') retainedPatch[key] = preserveSourceProperties(element[key], retainedPatch[key])
    }
    if ('shapeStyle' in retainedPatch && 'fillColor' in (retainedPatch.shapeStyle as object)) Object.assign(retainedPatch.shapeStyle as object, { fillColorXml: undefined, fillColorRef: undefined })
    const root = entry.ancestors[0] ?? element
    const prior = updates.get(root.id)
    if (entry.ancestors.length === 0) {
      updates.set(root.id, { slideId: snapshot.slideId, elementId: root.id, patch: { ...prior?.patch, ...retainedPatch } })
    } else {
      const updatedRoot = patchNested({ ...root, ...prior?.patch }, element.id, retainedPatch)
      updates.set(root.id, { slideId: snapshot.slideId, elementId: root.id, patch: { ...prior?.patch, children: updatedRoot.children } })
    }
  }
  return { summary: proposal.summary, updates: [...updates.values()], snapshot }
}

function elementSignature(element: PptxElement): unknown {
  const item = element as PptxElement & { children?: PptxElement[]; chartData?: unknown; tableData?: unknown }
  const tableData = item.tableData as {
    rows?: Array<{ cells?: Array<{ text?: string; gridSpan?: number; rowSpan?: number; hMerge?: boolean; vMerge?: boolean }> }>
  } | undefined
  const chartData = item.chartData as {
    title?: string; chartType?: string; categories?: unknown; series?: Array<{ name?: string; values?: unknown }>
  } | undefined
  return {
    type: item.type,
    text: item.type === 'table' ? tableData?.rows?.map((row) => row.cells?.map((cell) => (cell.text ?? '').replace(/\r\n/g, '\n')) ?? []) : ('text' in item ? item.text?.replace(/\r\n/g, '\n') : undefined),
    table: item.type === 'table' ? tableData?.rows?.map((row) => row.cells?.map((cell) => [cell.gridSpan ?? 1, cell.rowSpan ?? 1, cell.hMerge ?? false, cell.vMerge ?? false]) ?? []) : undefined,
    chart: item.type === 'chart' && chartData ? { title: chartData.title, type: chartData.chartType, categories: chartData.categories, series: (chartData.series ?? []).map((series) => ({ name: series.name, values: series.values })) } : undefined,
    geometry: [item.x, item.y, item.width, item.height].map((value) => Math.round(value)),
    children: item.type === 'group' ? item.children?.map(elementSignature) : undefined
  }
}

/** Read back the exported bytes, rather than treating a valid ZIP as proof of preservation. */
export function assertNativePptxRoundTrip(expected: readonly PptxSlide[], actual: readonly PptxSlide[]): void {
  if (expected.length !== actual.length) throw new Error('PPTX round-trip changed the slide count.')
  for (let index = 0; index < expected.length; index += 1) {
    if (JSON.stringify(expected[index].elements.map(elementSignature)) !== JSON.stringify(actual[index].elements.map(elementSignature))) {
      throw new Error(`PPTX round-trip changed object content or geometry on slide ${index + 1}. The previous revision is retained.`)
    }
  }
}
