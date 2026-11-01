import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { WorkspaceSearchResponse } from '@shared/write-document'

type Props = {
  workspaceRoot: string
  onOpenFile: (path: string) => void
}

export function WriteDocumentSearchPanel({ workspaceRoot, onOpenFile }: Props): ReactElement {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [response, setResponse] = useState<WorkspaceSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [placement, setPlacement] = useState<WriteSearchPlacement | null>(null)
  const panelId = useId()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useLayoutEffect(() => {
    if (!open) return
    const updatePlacement = (): void => {
      const anchor = triggerRef.current
      if (!anchor) return
      const zoom = Number.parseFloat(window.getComputedStyle(document.body).zoom)
      setPlacement(calculateWriteSearchPlacement({
        anchor: anchor.getBoundingClientRect(),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        panelHeight: panelRef.current?.offsetHeight ?? 390,
        scale: Number.isFinite(zoom) && zoom > 0 ? zoom : 1
      }))
    }
    updatePlacement()
    const observer = new ResizeObserver(updatePlacement)
    if (panelRef.current) observer.observe(panelRef.current)
    window.addEventListener('resize', updatePlacement)
    window.addEventListener('scroll', updatePlacement, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updatePlacement)
      window.removeEventListener('scroll', updatePlacement, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  useEffect(() => {
    const trimmed = query.trim()
    if (!open || !workspaceRoot || !trimmed) {
      setResponse(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    const timer = window.setTimeout(async () => {
      if (typeof window.workwise?.searchWorkspaceDocuments !== 'function') {
        setError(t('writeDocumentSearchUnavailable', { defaultValue: '文档搜索暂不可用' }))
        return
      }
      setLoading(true)
      setError(null)
      try {
        const result = await window.workwise.searchWorkspaceDocuments({
          workspaceRoot,
          query: trimmed,
          limit: 50
        })
        if (!cancelled) setResponse(result)
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setResponse(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [open, query, t, workspaceRoot])

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] text-ds-muted transition hover:bg-ds-hover/70 hover:text-ds-ink"
        title={t('writeSearchDocuments', { defaultValue: '搜索文档' })}
        aria-label={t('writeSearchDocuments', { defaultValue: '搜索文档' })}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Search className="h-3.5 w-3.5" strokeWidth={1.9} />
        <span>{t('writeSearchDocuments', { defaultValue: '搜索文档' })}</span>
      </button>
      {open ? createPortal(
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t('writeSearchDocuments', { defaultValue: '搜索文档' })}
          style={placement ?? { visibility: 'hidden' }}
          className="fixed z-[80] flex flex-col overflow-hidden rounded-2xl border border-ds-border bg-ds-card shadow-[0_20px_48px_rgba(15,23,42,0.18)]"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-ds-border-muted px-3 py-2">
            <Search className="h-4 w-4 shrink-0 text-ds-faint" strokeWidth={1.8} />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('writeSearchDocumentsPlaceholder', { defaultValue: '搜索标题、正文和路径…' })}
              aria-label={t('writeSearchDocuments', { defaultValue: '搜索文档' })}
              className="min-w-0 flex-1 bg-transparent py-1 text-[13px] text-ds-ink outline-none placeholder:text-ds-faint"
            />
            <button type="button" className="rounded-md p-1 text-ds-faint hover:bg-ds-hover hover:text-ds-ink" aria-label={t('close', { defaultValue: '关闭' })} onClick={() => { setOpen(false); triggerRef.current?.focus() }}>
              <X className="h-3.5 w-3.5" strokeWidth={1.9} />
            </button>
          </div>
          <div className="min-h-0 max-h-[340px] overflow-y-auto p-1.5">
            {!query.trim() ? (
              <div className="px-3 py-6 text-center text-[12px] text-ds-faint">{t('writeSearchDocumentsHint', { defaultValue: '输入关键词搜索工作区中的 Markdown 文档' })}</div>
            ) : loading ? (
              <div className="px-3 py-6 text-center text-[12px] text-ds-faint">{t('loading', { defaultValue: '搜索中…' })}</div>
            ) : error ? (
              <div className="px-3 py-6 text-center text-[12px] text-red-600 dark:text-red-300">{error}</div>
            ) : response && response.results.length > 0 ? (
              <>
                {response.results.map((result) => (
                  <button
                    key={`${result.path}:${result.line}`}
                    type="button"
                    className="block w-full rounded-xl px-3 py-2 text-left transition hover:bg-ds-hover"
                    onClick={() => {
                      onOpenFile(result.path)
                      setOpen(false)
                    }}
                  >
                    <div className="truncate text-[12.5px] font-semibold text-ds-ink">{result.title}</div>
                    <div className="mt-0.5 truncate text-[11px] text-ds-faint">{result.relativePath}:{result.line}</div>
                    <div className="mt-1 line-clamp-2 text-[12px] leading-5 text-ds-muted">{result.snippet}</div>
                  </button>
                ))}
                <div className="px-3 pb-1 pt-2 text-[10.5px] text-ds-faint">{t('writeDocumentSearchCount', { defaultValue: '{{matches}} 条匹配 · {{files}} 个文档', matches: response.results.length, files: response.indexedFiles })}</div>
                {response.truncated || response.skippedFiles ? <div className="px-3 pb-2 text-[10.5px] text-amber-700 dark:text-amber-200">{t('writeDocumentSearchLimited', { defaultValue: '已达到结果上限，或有大型/不可读文档未参与搜索。请缩小关键词范围。' })}</div> : null}
              </>
            ) : (
              <div className="px-3 py-6 text-center text-[12px] text-ds-faint">{t('writeSearchDocumentsEmpty', { defaultValue: '没有找到匹配内容' })}
                {response && (response.truncated || response.skippedFiles) ? <div className="mt-2 text-amber-700 dark:text-amber-200">{t('writeDocumentSearchLimited', { defaultValue: '已达到结果上限，或有大型/不可读文档未参与搜索。请缩小关键词范围。' })}</div> : null}
              </div>
            )}
          </div>
        </div>, document.body
      ) : null}
    </div>
  )
}

type WriteSearchPlacement = { left: number; top: number; width: number; maxHeight: number }

export function calculateWriteSearchPlacement({ anchor, viewportWidth, viewportHeight, panelHeight, scale = 1 }: {
  anchor: Pick<DOMRect, 'left' | 'top' | 'bottom'>
  viewportWidth: number
  viewportHeight: number
  panelHeight: number
  scale?: number
}): WriteSearchPlacement {
  const viewport = { width: viewportWidth / scale, height: viewportHeight / scale }
  const margin = Math.min(16, viewport.width / 2, viewport.height / 2)
  const width = Math.min(440, Math.max(0, viewport.width - margin * 2))
  const maxHeight = Math.min(390, Math.max(0, viewport.height - margin * 2))
  const height = Math.min(panelHeight, maxHeight)
  const left = Math.max(margin, Math.min(anchor.left / scale, viewport.width - width - margin))
  const below = anchor.bottom / scale + 8
  const above = anchor.top / scale - height - 8
  const preferredTop = below + height <= viewport.height - margin || above < margin ? below : above
  const top = Math.max(margin, Math.min(preferredTop, viewport.height - height - margin))
  return { left, top, width, maxHeight }
}
