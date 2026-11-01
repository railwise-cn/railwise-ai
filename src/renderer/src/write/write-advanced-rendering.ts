import { createWriteMarkdownIt, escapeWriteHtml, renderWriteMath } from '@shared/write-advanced-markdown'
import { sanitizeWriteMermaidSvg, validateWriteMermaidSource } from '@shared/write-mermaid-policy'
import { loadWriteMarkdownImage } from './markdown-image'
import 'katex/dist/katex.min.css'

const markdown = createWriteMarkdownIt()
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index]
  return `<span data-write-preview-image="${encodeURIComponent(token.attrGet('src') ?? '')}" data-write-alt="${encodeURIComponent(token.content)}"><span>${escapeWriteHtml(token.content || 'Image')}</span></span>`
}
markdown.renderer.rules.link_open = (tokens, index) => `<a data-write-link="${encodeURIComponent(tokens[index].attrGet('href') ?? '')}" href="#">`

export function renderWriteAdvancedPreview(source: string, focusSourceOffset?: number): string {
  if (focusSourceOffset === undefined) return markdown.render(source)
  const env: Record<string, unknown> = {}
  const tokens = markdown.parse(source, env)
  const line = source.slice(0, Math.max(0, focusSourceOffset)).split('\n').length - 1
  const index = tokens.findIndex((token) => token.type !== 'inline' && token.map && token.map[0] <= line && line < token.map[1])
  if (index < 0) return markdown.renderer.render(tokens, markdown.options, env)
  // A trusted inert marker locates the edited syntax without splitting the
  // document parse, so footnote numbering and definitions retain full context.
  return markdown.renderer.render(tokens.slice(0, index), markdown.options, env)
    + '<span data-write-preview-focus="true" aria-hidden="true"></span>'
    + markdown.renderer.render(tokens.slice(index), markdown.options, env)
}

export async function renderWriteMermaid(source: string): Promise<string> {
  const policy = validateWriteMermaidSource(source)
  if (!policy.ok) throw new Error(policy.message)
  if (typeof window.workwise?.renderWriteMermaidPreview !== 'function') throw new Error('The local diagram renderer is unavailable.')
  const result = await window.workwise.renderWriteMermaidPreview({ source })
  if (!result.ok) throw new Error(result.message)
  return sanitizeWriteMermaidSvg(result.svg)
}

export async function hydrateWriteAdvancedDiagrams(root: HTMLElement): Promise<void> {
  await Promise.all(Array.from(root.querySelectorAll<HTMLElement>('[data-write-mermaid]')).map(async (placeholder) => {
    if (placeholder.dataset.writeDiagramReady === 'true') return
    let source: string
    try { source = decodeURIComponent(placeholder.dataset.writeMermaid ?? '') } catch { return }
    try {
      const svg = await renderWriteMermaid(source)
      if (!root.contains(placeholder)) return
      // An SVG image has its own document: diagram styles cannot affect the
      // workbench, and event handlers/resources cannot become live app nodes.
      const image = document.createElement('img')
      image.alt = 'Mermaid diagram'
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
      image.dataset.writeDiagramImage = 'true'
      placeholder.replaceChildren(image)
      placeholder.dataset.writeDiagramReady = 'true'
    } catch (error) {
      if (!root.contains(placeholder)) return
      placeholder.dataset.writeDiagramError = 'true'
      placeholder.replaceChildren()
      const message = document.createElement('p')
      message.className = 'write-advanced-error'
      message.setAttribute('role', 'status')
      message.textContent = `Mermaid: ${error instanceof Error ? error.message : String(error)}`
      const code = document.createElement('pre')
      code.textContent = source
      placeholder.append(message, code)
    }
  }))
}

export async function hydrateWriteAdvancedImages(root: HTMLElement, filePath?: string | null, workspaceRoot?: string): Promise<void> {
  await Promise.all(Array.from(root.querySelectorAll<HTMLElement>('[data-write-preview-image]')).map(async (placeholder) => {
    let source: string; let alt: string
    try { source = decodeURIComponent(placeholder.dataset.writePreviewImage ?? ''); alt = decodeURIComponent(placeholder.dataset.writeAlt ?? '') } catch { return }
    const image = await loadWriteMarkdownImage(source, filePath, workspaceRoot)
    if (!root.contains(placeholder)) return
    if (!image.ok) { placeholder.title = image.message; return }
    const element = document.createElement('img')
    element.alt = alt
    element.src = image.src
    placeholder.replaceChildren(element)
  }))
}

export { renderWriteMath }
