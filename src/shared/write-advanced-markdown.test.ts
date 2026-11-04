import { describe, expect, it } from 'vitest'
import { createWriteMarkdownIt, renderWriteMath, WRITE_MATH_MAX_LENGTH } from './write-advanced-markdown'
import { sanitizeWriteMermaidSvg, validateWriteMermaidSource } from './write-mermaid-policy'

describe('shared advanced Markdown semantics', () => {
  it('renders inline and display TeX as bounded KaTeX and accessible MathML', () => {
    const html = createWriteMarkdownIt().render('The result is $\\frac{\\alpha}{2}$.\n\n$$\n\\begin{bmatrix}1 & 2\\\\3 & 4\\end{bmatrix}\n$$\n\n\\(x^2\\)\n\n\\[\\int_0^1 x\\,dx\\]\n\n```latex\n\\sqrt{x}\n```\n')
    expect(html.match(/class="katex"/g)).toHaveLength(5)
    expect(html).toContain('<math')
    expect(html).toContain('<mfrac>')
    expect(html).toContain('<mtable')
    expect(html).toContain('display="block"')
  })

  it('leaves escaped dollars, currency and code literal', () => {
    const html = createWriteMarkdownIt().render('A price of $20 and $30. A literal \\$x\\$. `$x$` and `\\(x\\)`.\n\n```ts\nconst amount = "$x$"\n```')
    expect(html).not.toContain('class="katex"')
    expect(html).toContain('$20 and $30')
    expect(html).toContain('<code>$x$</code>')
  })

  it('renders repeated named and inline footnotes with backlinks and math in note bodies', () => {
    const html = createWriteMarkdownIt().render('First[^survey], again[^survey] and inline^[Explanation].\n\n[^survey]: **Measured** with uncertainty $\\sigma=0.2$.\n\n    A second paragraph.\n')
    expect(html).toContain('id="fnref1"')
    expect(html).toContain('id="fnref1:1"')
    expect(html).toContain('id="fn1"')
    expect(html).toContain('id="fn2"')
    expect(html).toContain('<strong>Measured</strong>')
    expect(html).toContain('A second paragraph.')
    expect(html).toContain('class="katex"')
    expect(html).toContain('class="footnote-backref"')
  })

  it('does not authorize KaTeX HTML, URL or image extensions and bounds expressions', () => {
    const html = renderWriteMath('\\href{https://bad.test}{unsafe} \\includegraphics{https://bad.test/a.png}', false)
    expect(html).not.toMatch(/<(?:a|img)\b/)
    expect(html).not.toMatch(/\s(?:href|src)=/)
    const bounded = renderWriteMath('<script>' + 'x'.repeat(WRITE_MATH_MAX_LENGTH), true)
    expect(bounded).toContain('write-math-error')
    expect(bounded).not.toContain('<script>')
  })

  it('leaves Mermaid source inert until the isolated diagram renderer runs', () => {
    const html = createWriteMarkdownIt().render('```mermaid\ngraph LR\nA[Survey] --> B[Report]\n```')
    expect(html).toContain('data-write-mermaid="graph%20LR')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('<script')
  })
})

describe('shared passive Mermaid policy', () => {
  it('allows ordinary labels containing words that resemble disabled directives', () => {
    expect(validateWriteMermaidSource('flowchart LR\nA[Image sensor: click callback href] --> B[Report]').ok).toBe(true)
    expect(validateWriteMermaidSource('sequenceDiagram\nAlice->>Bob: image click callback href').ok).toBe(true)
    expect(validateWriteMermaidSource('flowchart LR\nclick --> B[Report]').ok).toBe(true)
  })

  it('rejects network, configuration and active-language features', () => {
    expect(validateWriteMermaidSource('sequenceDiagram\nAlice->>Bob: Hello').ok).toBe(true)
    for (const source of [
      '%%{init: { securityLevel: "loose" }}%%\ngraph LR\nA-->B',
      'graph LR\nclick A "https://bad.test"',
      'graph LR\nclick A callback handler',
      'graph LR\nclick A call handler()',
      'graph LR\nclick A href "relative-target"',
      'graph LR\nlink A "relative-target"',
      'graph LR\nA[<img src="//bad.test">]',
      'graph LR\nA@{img: "../secret.png"}',
      'graph LR\nstyle A fill:url(//bad.test)',
      'graph LR\nA[data:image/png;base64,AAAA]',
      'x'.repeat(30001)
    ]) expect(validateWriteMermaidSource(source).ok).toBe(false)
  })

  it('keeps useful SVG graphics and local markers while removing active content and external resources', () => {
    const svg = sanitizeWriteMermaidSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 100 40"><defs><marker id="arrow"><path d="M0 0 L2 2"/></marker></defs><style>.edge {marker-end:url(#arrow)}</style><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><image href="https://bad.test/x"/><a href="javascript:alert(1)"><text>bad</text></a><path marker-end="url(#arrow)" style="fill:url(https://bad.test/x)" d="M0 0 L30 30"/><text x="3" y="5">Survey &amp; report</text></svg>')
    expect(svg).toContain('viewBox="0 0 100 40"')
    expect(svg).toContain('marker-end="url(#arrow)"')
    expect(svg).toContain('Survey &amp; report')
    expect(svg).not.toMatch(/script|foreignObject|<image|<a\b|onload|https:\/\/bad|javascript:/)
    expect(svg).toContain('role="img"')
  })

  it('rejects entities and malformed/non-SVG input', () => {
    expect(() => sanitizeWriteMermaidSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]><svg>&x;</svg>')).toThrow()
    expect(() => sanitizeWriteMermaidSvg('<html><body>no</body></html>')).toThrow()
    expect(() => sanitizeWriteMermaidSvg('<svg><g></svg>')).toThrow()
  })
})
