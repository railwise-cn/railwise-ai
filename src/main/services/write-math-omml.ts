import { DOMParser } from '@xmldom/xmldom'
import { ImportedXmlComponent } from 'docx'
import katex from 'katex'
import { WRITE_MATH_MAX_LENGTH, writeMathOptions } from '../../shared/write-advanced-markdown'

type MathElement = ReturnType<Document['createElement']>

function component(name: string, children: Array<ImportedXmlComponent | string> = [], attributes?: Record<string, string>): ImportedXmlComponent {
  const element = new ImportedXmlComponent(`m:${name}`, attributes)
  children.forEach((child) => element.push(child))
  return element
}

function property(name: string, value: string): ImportedXmlComponent {
  return component(name, [], { 'm:val': value })
}

function text(value: string, variant?: string | null, upright = false): ImportedXmlComponent {
  const properties: ImportedXmlComponent[] = []
  if (upright || variant === 'normal') properties.push(property('sty', 'p'))
  else if (variant?.includes('bold')) properties.push(property('sty', variant.includes('italic') ? 'bi' : 'b'))
  const scripts: Record<string, string> = { 'double-struck': 'double-struck', script: 'script', fraktur: 'fraktur', 'sans-serif': 'sans-serif', monospace: 'monospace' }
  const script = Object.keys(scripts).find((name) => variant?.includes(name))
  if (script) properties.push(property('scr', scripts[script]))
  return component('r', [
    ...(properties.length ? [component('rPr', properties)] : []),
    component('t', [value], { 'xml:space': 'preserve' })
  ])
}

function elementChildren(element: MathElement): MathElement[] {
  return Array.from(element.childNodes).filter((node) => node.nodeType === 1) as MathElement[]
}

function mathChildren(element: MathElement): ImportedXmlComponent[] {
  return elementChildren(element).flatMap(convertMathElement)
}

function convertMathElement(element: MathElement): ImportedXmlComponent[] {
  const children = elementChildren(element)
  const child = (index: number): ImportedXmlComponent[] => children[index] ? convertMathElement(children[index]) : []
  const base = (): ImportedXmlComponent => component('e', child(0))
  const name = element.localName
  if (name === 'annotation' || name === 'annotation-xml') return []
  if (name === 'math' || name === 'semantics') return mathChildren(element)
  if (name === 'mstyle') {
    if (['mathsize', 'mathcolor', 'mathbackground'].some((attribute) => element.hasAttribute(attribute))) throw new Error('Styled formula uses visual fallback')
    return mathChildren(element)
  }
  if (name === 'mrow') {
    // Retain stretchy bracket semantics for matrices, cases and nested fractions.
    const first = children[0]
    const last = children.at(-1)
    if (children.length >= 2 && first.getAttribute('fence') === 'true' && last?.getAttribute('fence') === 'true') {
      return [component('d', [component('dPr', [property('begChr', first.textContent ?? ''), property('endChr', last.textContent ?? '')]), component('e', children.slice(1, -1).flatMap(convertMathElement))])]
    }
    if (children.some((child) => child.getAttribute('fence') === 'true')) throw new Error('One-sided formula delimiter uses visual fallback')
    return mathChildren(element)
  }
  if (['mi', 'mn', 'mo', 'mtext', 'ms'].includes(name)) {
    if (children.length) throw new Error('Compound math operator uses visual fallback')
    return [text(element.textContent ?? '', element.getAttribute('mathvariant'), name !== 'mi')]
  }
  if (name === 'mspace') throw new Error('Explicit math spacing uses visual fallback')
  if (name === 'mfrac') {
    if (element.getAttribute('bevelled') === 'true') throw new Error('Bevelled fraction uses visual fallback')
    const thickness = element.getAttribute('linethickness')
    // Binomials and \atop are stacked without a fraction bar. Other explicit
    // rule widths use the visual fallback rather than inventing a default line.
    if (thickness && !/^0(?:\.0+)?(?:px|pt|em|ex)?$/.test(thickness)) throw new Error('Unsupported fraction rule width')
    return [component('f', [
      ...(thickness ? [component('fPr', [property('type', 'noBar')])] : []),
      component('num', child(0)), component('den', child(1))
    ])]
  }
  if (name === 'msqrt') return [component('rad', [component('radPr', [property('degHide', '1')]), component('deg'), component('e', mathChildren(element))])]
  if (name === 'mroot') return [component('rad', [component('deg', child(1)), base()])]
  if (name === 'msub') return [component('sSub', [base(), component('sub', child(1))])]
  if (name === 'msup') return [component('sSup', [base(), component('sup', child(1))])]
  if (name === 'msubsup') return [component('sSubSup', [base(), component('sub', child(1)), component('sup', child(2))])]
  if (name === 'mover' || name === 'munder') {
    if (element.getAttribute('accent') === 'true' || element.getAttribute('accentunder') === 'true') {
      const accent = children[1]?.textContent ?? ''
      if (['‾', '¯', '_', '\u0332'].includes(accent)) return [component('bar', [component('barPr', [property('pos', name === 'mover' ? 'top' : 'bot')]), base()])]
      if (name === 'mover') return [component('acc', [component('accPr', [property('chr', accent)]), base()])]
    }
    return [component(name === 'mover' ? 'limUpp' : 'limLow', [base(), component('lim', child(1))])]
  }
  if (name === 'munderover') return [component('limUpp', [component('e', [component('limLow', [base(), component('lim', child(1))])]), component('lim', child(2))])]
  if (name === 'mtable') {
    if (element.getAttribute('columnalign')?.split(/\s+/).some((alignment) => alignment !== 'center') || ['rowlines', 'columnlines', 'frame'].some((attribute) => element.hasAttribute(attribute))) throw new Error('Aligned formula uses visual fallback')
    return [component('m', children.map((row) => component('mr', elementChildren(row).map((cell) => component('e', mathChildren(cell))))))]
  }
  if (name === 'mphantom') return [component('phant', [component('phantPr', [property('show', '0')]), component('e', mathChildren(element))])]
  // Unsupported layout must use the shared visual fallback rather than flatten
  // a fraction, enclosure or spacing instruction into misleading plain text.
  throw new Error(`Unsupported MathML layout: ${name}`)
}

/** Convert KaTeX's bounded MathML to editable Office Math, without XSLT or external files. */
export function buildWriteMathOmml(source: string, display = false): ImportedXmlComponent | null {
  if (source.length > WRITE_MATH_MAX_LENGTH) return null
  try {
    const markup = katex.renderToString(source, { ...writeMathOptions, output: 'mathml', throwOnError: true, displayMode: display, macros: {} })
    let invalid = false
    const parsed = new DOMParser({ onError: () => { invalid = true } }).parseFromString(markup, 'application/xml')
    const math = parsed.getElementsByTagName('math')[0]
    if (invalid || !math) return null
    return component('oMath', convertMathElement(math as unknown as MathElement))
  } catch {
    return null
  }
}
