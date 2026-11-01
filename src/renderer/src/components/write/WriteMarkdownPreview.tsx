import { Component, useEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveWriteMarkdownResourcePath } from '@shared/write-markdown-resource'
import { renderWriteAdvancedPreview, hydrateWriteAdvancedDiagrams, hydrateWriteAdvancedImages } from '../../write/write-advanced-rendering'
import { highlightCodeHtml } from '../../lib/code-highlighting'

export { resolveWriteMarkdownResource, resolveWriteMarkdownResourcePath, writePathToFileUrl } from '@shared/write-markdown-resource'

// Retained for existing consumers which construct their own hardened AST pipeline.
export const writeMarkdownHardenOptions = { defaultOrigin: 'https://workwise.local', allowedLinkPrefixes: ['*'], allowedImagePrefixes: ['*'] }

type Props = {
  content: string
  isMarkdown: boolean
  filePath?: string | null
  workspaceRoot?: string
  onOpenDocument?: (path: string) => void
  previewErrorMessage?: string
  focusSourceOffset?: number
}

function plainTextFallback(content: string): ReactElement {
  return <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[13.5px] leading-6 text-ds-ink">{content}</pre>
}

class PreviewErrorBoundary extends Component<{ content: string; filePath?: string | null; previewErrorMessage: string; children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null }
  static getDerivedStateFromError(error: unknown): { error: string } { return { error: error instanceof Error ? error.message : String(error) } }
  override componentDidUpdate(previous: { content: string; filePath?: string | null }): void {
    if (this.state.error && (previous.content !== this.props.content || previous.filePath !== this.props.filePath)) this.setState({ error: null })
  }
  override render(): ReactNode {
    return this.state.error ? <div className="min-h-full px-6 py-6"><p role="status" className="mb-4 text-amber-700 dark:text-amber-200">{this.props.previewErrorMessage}</p>{plainTextFallback(this.props.content)}</div> : this.props.children
  }
}

function PreviewContent({ content, isMarkdown, filePath, workspaceRoot, onOpenDocument, focusSourceOffset }: Props): ReactElement {
  const { i18n } = useTranslation()
  const chinese = i18n.resolvedLanguage?.startsWith('zh') ?? true
  const root = useRef<HTMLDivElement | null>(null)
  const frontmatter = /^(?:\uFEFF)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content)?.[0] ?? ''
  const body = content.slice(frontmatter.length)
  const focusBodyOffset = focusSourceOffset === undefined ? undefined : Math.max(0, focusSourceOffset - frontmatter.length)
  const html = useMemo(() => isMarkdown ? renderWriteAdvancedPreview(body, focusBodyOffset) : '', [body, isMarkdown, focusBodyOffset])
  useEffect(() => {
    const element = root.current
    if (!element || !isMarkdown) return
    element.innerHTML = html
    let cancelled = false
    const scrollToFocus = (): void => {
      if (cancelled) return
      const target = element.querySelector<HTMLElement>('[data-write-preview-focus]')
      if (!target) return
      // Scroll the preview pane alone, keeping the dialog controls and the
      // underlying editor at their current positions.
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (!/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) continue
        parent.scrollTop += target.getBoundingClientRect().top - parent.getBoundingClientRect().top - 12
        break
      }
    }
    element.addEventListener('load', scrollToFocus, true)
    scrollToFocus()
    void Promise.allSettled([hydrateWriteAdvancedImages(element, filePath, workspaceRoot), hydrateWriteAdvancedDiagrams(element)]).then(scrollToFocus)
    for (const code of element.querySelectorAll<HTMLElement>('pre > code')) {
      const language = code.className.match(/language-(\S+)/)?.[1] ?? ''
      const source = code.textContent ?? ''
      void highlightCodeHtml(source.replace(/\n$/, ''), language).then((highlighted) => {
        if (cancelled || !element.contains(code)) return
        const wrapper = document.createElement('div')
        wrapper.className = 'ds-code-block'
        const header = document.createElement('div')
        header.className = 'ds-code-block-header'
        const label = document.createElement('span')
        label.className = 'ds-code-block-language'
        label.textContent = language || 'text'
        const copy = document.createElement('button')
        copy.type = 'button'
        copy.className = 'ds-code-block-action'
        copy.setAttribute('aria-label', chinese ? '复制代码' : 'Copy code')
        copy.textContent = chinese ? '复制' : 'Copy'
        copy.addEventListener('click', () => {
          const fallback = (): boolean => {
            const input = document.createElement('textarea')
            input.value = source
            input.style.position = 'fixed'; input.style.left = '-10000px'
            document.body.append(input); input.select()
            try { return document.execCommand('copy') } finally { input.remove() }
          }
          void (navigator.clipboard?.writeText ? navigator.clipboard.writeText(source) : Promise.resolve().then(() => { if (!fallback()) throw new Error('copy') }))
            .then(() => { copy.textContent = chinese ? '已复制' : 'Copied' })
            .catch(() => { copy.textContent = chinese ? '复制失败' : 'Copy failed' })
        })
        header.append(label, copy)
        const rendered = document.createElement('div')
        rendered.className = 'ds-code-block-html'
        rendered.innerHTML = highlighted
        wrapper.append(header, rendered)
        code.parentElement?.replaceWith(wrapper)
        if (rendered.scrollHeight > 200) {
          const expand = document.createElement('button')
          expand.type = 'button'; expand.className = 'ds-code-block-action'
          let expanded = false
          const update = (): void => {
            expand.textContent = expanded ? (chinese ? '收起代码' : 'Collapse code') : (chinese ? '展开代码' : 'Expand code')
            expand.setAttribute('aria-expanded', String(expanded))
            rendered.style.maxHeight = expanded ? '' : '200px'
            rendered.style.overflow = expanded ? '' : 'hidden'
          }
          expand.addEventListener('click', () => { expanded = !expanded; update() })
          update(); header.append(expand)
        }
        scrollToFocus()
      })
    }
    return () => { cancelled = true; element.removeEventListener('load', scrollToFocus, true) }
  }, [html, filePath, workspaceRoot, isMarkdown, chinese])
  if (!isMarkdown) return plainTextFallback(content)
  return <div ref={root} className="ds-markdown write-markdown-preview min-h-full text-ds-ink" dangerouslySetInnerHTML={{ __html: html }} onClick={(event) => {
    const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a')
    if (!link) return
    event.preventDefault()
    let href = link.getAttribute('href') ?? ''
    try { href = link.dataset.writeLink !== undefined ? decodeURIComponent(link.dataset.writeLink) : href } catch { return }
    if (href.startsWith('#')) {
      try { root.current?.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView() } catch { /* Invalid fragment encodings are inert links. */ }
      return
    }
    if (/^(?:https?:\/\/|mailto:)/i.test(href)) { void window.workwise?.openExternal?.(href)?.catch(() => undefined); return }
    if (!filePath || !workspaceRoot || !onOpenDocument) return
    let target: string | undefined
    try { target = resolveWriteMarkdownResourcePath(decodeURIComponent(href.split('#')[0]), filePath) } catch { return }
    if (target) void window.workwise.resolveWorkspaceFile({ path: target, workspaceRoot }).then((result) => { if (result.ok) onOpenDocument(result.path) }).catch(() => undefined)
  }} />
}

export function WriteMarkdownPreview(props: Props): ReactElement {
  return <PreviewErrorBoundary content={props.content} filePath={props.filePath} previewErrorMessage={props.previewErrorMessage ?? 'Markdown preview failed, showing source text instead.'}><PreviewContent {...props} /></PreviewErrorBoundary>
}
