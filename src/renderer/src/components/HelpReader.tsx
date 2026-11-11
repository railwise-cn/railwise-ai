import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ArrowLeft, BookOpen, Search } from 'lucide-react'
import { HELP_HOME, HELP_UPDATED_AT, HELP_VERSION, helpDocuments, helpImages, helpResource, helpSlug, searchHelp } from '../help/content'
import { hydrateWriteAdvancedDiagrams, renderWriteAdvancedPreview } from '../write/write-advanced-rendering'

export function HelpReader(): ReactElement {
  const [location, setLocation] = useState({ document: HELP_HOME, anchor: '' })
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [headings, setHeadings] = useState<Array<{ id: string; text: string; level: number }>>([])
  const article = useRef<HTMLDivElement>(null)
  const body = helpDocuments[location.document] ?? helpDocuments[HELP_HOME]
  const html = useMemo(() => renderWriteAdvancedPreview(body), [body])
  const matches = useMemo(() => searchHelp(query), [query])
  const searching = Boolean(query.trim())
  const navigate = (document: string, anchor = ''): void => {
    setQuery('')
    setError('')
    setLocation({ document, anchor })
  }

  useEffect(() => {
    const root = article.current
    if (!root || searching) return
    root.innerHTML = html
    const occurrences = new Map<string, number>()
    const outline = Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')).map(heading => {
      const text = heading.textContent ?? ''
      const slug = helpSlug(text)
      const count = occurrences.get(slug) ?? 0
      occurrences.set(slug, count + 1)
      heading.id = count ? `${slug}-${count}` : slug
      heading.style.scrollMarginTop = '20px'
      return { id: heading.id, text, level: Number(heading.tagName.slice(1)) }
    })
    setHeadings(outline.filter(heading => heading.level === 2 || heading.level === 3))
    for (const placeholder of root.querySelectorAll<HTMLElement>('[data-write-preview-image]')) {
      const resource = helpResource(location.document, decodeURIComponent(placeholder.dataset.writePreviewImage ?? ''))
      const src = resource ? helpImages[resource.path] : undefined
      if (!src) continue
      const image = document.createElement('img')
      image.src = src
      image.alt = decodeURIComponent(placeholder.dataset.writeAlt ?? '')
      image.loading = 'lazy'
      placeholder.replaceChildren(image)
    }
    const scroll = (): void => {
      const target = Array.from(root.querySelectorAll<HTMLElement>('[id]')).find(element => element.id === location.anchor)
      target?.scrollIntoView({ block: 'start' })
    }
    scroll()
    void hydrateWriteAdvancedDiagrams(root).then(scroll)
  }, [html, location, searching])

  const openLink = (href: string): void => {
    const resource = helpResource(location.document, href)
    if (resource && helpDocuments[resource.path]) { navigate(resource.path, resource.anchor); return }
    const target = resource
      ? `https://github.com/railwise-cn/railwise-ai/blob/main/docs/${resource.path}${resource.anchor ? `#${encodeURIComponent(resource.anchor)}` : ''}`
      : href
    if (!/^https:\/\//i.test(target)) { setError('此链接暂不可打开。'); return }
    void window.workwise.openExternal(target).catch(() => setError('浏览器未能打开链接，请稍后重试。'))
  }

  return <section className="min-w-0" aria-label="用户使用手册">
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="flex items-center gap-2 text-lg font-semibold"><BookOpen className="h-5 w-5" />用户使用手册</h2>
        <p className="mt-1 text-xs text-ds-muted">应用 {HELP_VERSION} · 手册更新 {HELP_UPDATED_AT} · 离线可读</p></div>
      <label className="relative w-full sm:w-72"><Search className="absolute left-3 top-2.5 h-4 w-4 text-ds-muted" />
        <input aria-label="搜索帮助" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索操作、功能或问题" className="h-9 w-full rounded-lg border border-ds-border bg-ds-card pl-9 pr-3 text-sm" /></label>
    </div>
    {error ? <p role="alert" className="mb-3 text-sm text-red-600">{error}</p> : null}
    {query.trim() ? <div aria-label="帮助搜索结果" className="space-y-2">
      {matches.length ? matches.map((match, index) => <button type="button" key={`${match.document}:${index}`} onClick={() => navigate(match.document, match.anchor)} className="block w-full rounded-lg border border-ds-border bg-ds-card p-3 text-left hover:bg-ds-hover">
        <span className="block text-sm font-medium">{match.heading}</span><span className="mt-1 block text-xs leading-5 text-ds-muted">{match.excerpt}</span>
      </button>) : <p className="py-8 text-sm text-ds-muted">没有找到相关内容，请换一个关键词。</p>}
    </div> : <div className="grid gap-6 xl:grid-cols-[210px_minmax(0,1fr)]">
      <nav aria-label="手册目录" className="max-h-[65vh] overflow-y-auto rounded-lg border border-ds-border bg-ds-card p-3 xl:sticky xl:top-0">
        {location.document !== HELP_HOME ? <button type="button" onClick={() => navigate(HELP_HOME)} className="mb-3 flex items-center gap-1 text-xs text-accent"><ArrowLeft className="h-3.5 w-3.5" />返回完整手册</button> : null}
        {headings.map(heading => <button type="button" key={heading.id} onClick={() => navigate(location.document, heading.id)} className={`block w-full rounded px-2 py-1.5 text-left text-xs leading-5 hover:bg-ds-hover ${heading.level === 3 ? 'pl-4 text-ds-muted' : 'font-medium'}`}>{heading.text}</button>)}
      </nav>
      <div ref={article} className="write-markdown-preview prose min-w-0 max-w-none text-ds-ink" onClick={event => {
        const link = (event.target as Element).closest<HTMLAnchorElement>('a')
        if (!link) return
        event.preventDefault()
        openLink(decodeURIComponent(link.dataset.writeLink ?? link.getAttribute('href') ?? ''))
      }} />
    </div>}
  </section>
}
