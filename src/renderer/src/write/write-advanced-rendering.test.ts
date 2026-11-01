// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hydrateWriteAdvancedDiagrams, renderWriteAdvancedPreview } from './write-advanced-rendering'

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

describe('local advanced preview hydration', () => {
  it('focuses an edited diagram within the full-document preview and keeps footnote context', () => {
    const source = '# Beginning\n\nText[^source].\n\n```mermaid\ngraph LR\nA-->B\n```\n\n[^source]: Reference.\n'
    const root = document.createElement('div')
    root.innerHTML = renderWriteAdvancedPreview(source, source.indexOf('```mermaid'))
    const focus = root.querySelector('[data-write-preview-focus]')!
    expect(focus).not.toBeNull()
    expect(focus.nextElementSibling?.hasAttribute('data-write-mermaid')).toBe(true)
    expect(root.querySelector('#fn1')?.textContent).toContain('Reference.')
    expect(root.querySelector('#fnref1')?.getAttribute('href')).toBe('#fn1')
  })

  it('renders diagrams through the IPC boundary and installs isolated SVG images', async () => {
    const render = vi.fn(async () => ({ ok: true, svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><style>.label {fill:red}</style><text x="2" y="10">Survey</text><script>alert(1)</script></svg>', width: 100, height: 50 }))
    Object.defineProperty(window, 'workwise', { value: { renderWriteMermaidPreview: render }, configurable: true })
    const root = document.createElement('div')
    root.innerHTML = renderWriteAdvancedPreview('```mermaid\ngraph LR\nA[Survey] --> B[Report]\n```')
    document.body.append(root)
    await hydrateWriteAdvancedDiagrams(root)
    expect(render).toHaveBeenCalledWith({ source: 'graph LR\nA[Survey] --> B[Report]\n' })
    expect(root.querySelector('svg,style,script')).toBeNull()
    const image = root.querySelector<HTMLImageElement>('img[data-write-diagram-image]')!
    expect(image.alt).toBe('Mermaid diagram')
    const svg = decodeURIComponent(image.src.split(',')[1])
    expect(svg).toContain('Survey')
    expect(svg).not.toContain('<script')
  })

  it('rejects active Mermaid source before IPC and keeps source with a visible failure', async () => {
    const render = vi.fn()
    Object.defineProperty(window, 'workwise', { value: { renderWriteMermaidPreview: render }, configurable: true })
    const root = document.createElement('div')
    root.innerHTML = renderWriteAdvancedPreview('```mermaid\ngraph LR\nclick A "https://bad.test"\n```')
    await hydrateWriteAdvancedDiagrams(root)
    expect(render).not.toHaveBeenCalled()
    expect(root.querySelector('[role="status"]')?.textContent).toContain('disabled')
    expect(root.querySelector('pre')?.textContent).toContain('click A')
    expect(root.querySelector('[src]')).toBeNull()
  })

  it('discards diagram responses for a replaced source node', async () => {
    let finish!: (result: unknown) => void
    Object.defineProperty(window, 'workwise', { value: { renderWriteMermaidPreview: vi.fn(() => new Promise((resolve) => { finish = resolve })) }, configurable: true })
    const root = document.createElement('div')
    root.innerHTML = renderWriteAdvancedPreview('```mermaid\ngraph LR\nA-->B\n```')
    const hydration = hydrateWriteAdvancedDiagrams(root)
    root.replaceChildren(document.createTextNode('New document'))
    finish({ ok: true, svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Old</text></svg>', width: 100, height: 50 })
    await hydration
    expect(root.textContent).toBe('New document')
    expect(root.querySelector('img')).toBeNull()
  })
})
