import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

export const WRITE_MERMAID_MAX_LENGTH = 30000

const UNSAFE_MERMAID_SOURCE_PATTERNS = [
  /%%\s*\{|^\s*---|<\/?[A-Za-z!]|@\{|(?:https?|data|javascript|file):|url\s*\(|@import|\\(?:75|72|6c)/im
]

const FLOWCHART_EDGE_START = /^(?:[-=~]|[ox](?:--|-\.))/i

function splitMermaidStatements(source: string): string[] {
  const statements: string[] = []
  const delimiters: string[] = []
  let start = 0
  let inDoubleQuotedText = false
  let escaped = false

  // Mermaid flowcharts use newlines and semicolons between statements. Keep separators inside labels intact.
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (inDoubleQuotedText) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inDoubleQuotedText = false
      continue
    }
    if (character === '"') {
      inDoubleQuotedText = true
      continue
    }
    if (character === '[' || character === '(' || character === '{') delimiters.push(character)
    else if (character === ']' || character === ')' || character === '}') {
      const expected = character === ']' ? '[' : character === ')' ? '(' : '{'
      if (delimiters.at(-1) === expected) delimiters.pop()
    } else if (delimiters.length === 0 && (character === ';' || character === '\n')) {
      statements.push(source.slice(start, index))
      start = index + 1
    }
  }
  statements.push(source.slice(start))
  return statements
}

function hasUnsafeFlowchartInteraction(source: string): boolean {
  const statements = splitMermaidStatements(source)
  const first = statements.find((statement) => statement.trim() && !/^\s*%%/.test(statement))?.trim() ?? ''
  if (!/^(?:flowchart|graph)\b/i.test(first)) return false

  return statements.some((statement) => {
    const directive = /^(?:click|link)[ \t]+(\S+)(?:[ \t]+([\s\S]*))?$/i.exec(statement.trim())
    if (!directive) return false
    const [, nodeOrEdge, action = ''] = directive
    return !FLOWCHART_EDGE_START.test(nodeOrEdge) && Boolean(action.trim()) && !FLOWCHART_EDGE_START.test(action.trimStart())
  })
}

export function validateWriteMermaidSource(source: string): { ok: true } | { ok: false; message: string } {
  if (!source.trim()) return { ok: false, message: 'Diagram source is empty.' }
  if (source.length > WRITE_MERMAID_MAX_LENGTH || source.split('\n').length > 1000) return { ok: false, message: 'Diagram exceeds the local rendering limit.' }
  if (UNSAFE_MERMAID_SOURCE_PATTERNS.some((pattern) => pattern.test(source)) || hasUnsafeFlowchartInteraction(source)) return { ok: false, message: 'Diagram links, HTML, images and configuration directives are disabled.' }
  return { ok: true }
}

const tags = new Set(['svg', 'g', 'defs', 'marker', 'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'text', 'tspan', 'textPath', 'title', 'desc', 'style', 'clipPath', 'linearGradient', 'radialGradient', 'stop', 'use', 'symbol', 'pattern'])
const attributes = new Set(['xmlns', 'xmlns:xlink', 'id', 'class', 'style', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'dy', 'dx', 'letter-spacing', 'marker-start', 'marker-mid', 'marker-end', 'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'markerUnits', 'preserveAspectRatio', 'clip-path', 'clipPathUnits', 'gradientUnits', 'gradientTransform', 'offset', 'stop-color', 'stop-opacity', 'patternUnits', 'patternContentUnits', 'patternTransform', 'href', 'xlink:href', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby'])

function safeCss(value: string): boolean {
  if (/@import|expression\s*\(|javascript:|data:|https?:|file:|\\|</i.test(value)) return false
  return Array.from(value.matchAll(/url\s*\(([^)]*)\)/gi)).every((match) => /^\s*['"]?#[\w:.-]+['"]?\s*$/.test(match[1]))
}

/** The same strict SVG policy is used in the browser and in export. No foreignObject or network URLs survive. */
export function sanitizeWriteMermaidSvg(source: string): string {
  if (source.length > 4_000_000 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('Invalid diagram SVG.')
  let invalid = false
  const document = new DOMParser({ onError: () => { invalid = true } }).parseFromString(source, 'image/svg+xml')
  const root = document.documentElement
  if (invalid || !root || root.localName !== 'svg') throw new Error('Invalid diagram SVG.')
  const clean = (element: Element): void => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name
      const value = attribute.value
      const localReference = /^(?:href|xlink:href)$/.test(name)
      if (!attributes.has(name) || /^on/i.test(name) || (localReference && !/^#[\w:.-]+$/.test(value)) || (!localReference && name !== 'xmlns' && name !== 'xmlns:xlink' && !safeCss(value))) element.removeAttribute(name)
    }
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === 1) {
        const childElement = child as Element
        if (!tags.has(childElement.localName) || (childElement.localName === 'style' && !safeCss(childElement.textContent ?? ''))) element.removeChild(child)
        else clean(childElement)
      } else if (child.nodeType !== 3 && child.nodeType !== 4) element.removeChild(child)
    }
  }
  clean(root as unknown as Element)
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  root.setAttribute('role', 'img')
  return new XMLSerializer().serializeToString(root)
}
