import type { WorkspacePreviewResultV1 } from '@shared/agent-workbench'
import { ChevronLeft, ChevronRight, Minus, Plus, RefreshCw, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import ReactMarkdown from 'react-markdown'
import { harden } from 'rehype-harden'
import remarkGfm from 'remark-gfm'
import type { PluggableList } from 'unified'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const markdownRehypePlugins = [[harden, {
  defaultOrigin: 'https://workwise.local',
  allowedLinkPrefixes: ['https://', 'http://'],
  allowedImagePrefixes: []
}]] as unknown as PluggableList

export function WorkspaceRichPreview({ result, onRequestAccuratePdf }: {
  result: WorkspacePreviewResultV1
  onRequestAccuratePdf?: () => void
}): ReactElement {
  if (result.kind === 'image') {
    return <div className="flex h-full items-center justify-center overflow-auto p-4"><img src={result.dataUrl} alt="" className="max-h-full max-w-full object-contain" /></div>
  }
  if (result.kind === 'svg') {
    return <div className="h-full overflow-auto p-4 [&>svg]:mx-auto [&>svg]:max-h-full [&>svg]:max-w-full" dangerouslySetInnerHTML={{ __html: result.sanitizedSvg }} />
  }
  if (result.kind === 'markdown') return <MarkdownPreview source={result.source} />
  if (result.kind === 'office') {
    return (
      <div className="h-full overflow-auto px-6 py-5">
        <div className="mb-3 flex flex-wrap gap-2 text-[11px] text-ds-muted">
          <span className="rounded border border-ds-border-muted px-2 py-0.5 uppercase">{result.format}</span>
          {result.pageCount ? <span>{result.pageCount} 页</span> : null}
          {result.sheetNames?.length ? <span>{result.sheetNames.length} 个工作表</span> : null}
        </div>
        {result.warnings.map((warning) => <div key={warning} className="mb-2 rounded bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{warning}</div>)}
        <MarkdownBody source={result.markdown} />
      </div>
    )
  }
  if (result.kind === 'pdf') return <PdfJsPreview result={result} onRequestAccuratePdf={onRequestAccuratePdf} />
  return <div className="flex h-full items-center justify-center px-6 text-center text-[12px] leading-6 text-ds-muted">{result.message}</div>
}

function MarkdownPreview({ source }: { source: string }): ReactElement {
  return <div className="h-full overflow-auto px-6 py-5"><MarkdownBody source={source} /></div>
}

function MarkdownBody({ source }: { source: string }): ReactElement {
  return (
    <div className="prose prose-sm max-w-none text-ds-ink dark:prose-invert">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={markdownRehypePlugins}>{source}</ReactMarkdown>
    </div>
  )
}

function PdfJsPreview({ result, onRequestAccuratePdf }: {
  result: Extract<WorkspacePreviewResultV1, { kind: 'pdf' }>
  onRequestAccuratePdf?: () => void
}): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const documentRef = useRef<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [scale, setScale] = useState(1.15)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(Boolean(result.dataUrl))
  const matchingPages = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return []
    return result.pageTexts.filter((page) => page.text.toLowerCase().includes(normalized)).map((page) => page.page)
  }, [query, result.pageTexts])
  const referencePages = useMemo(
    () => [...new Set(result.document?.references.map((reference) => reference.page) ?? [])]
      .filter((page) => page >= 1 && page <= result.pageCount)
      .slice(0, 12),
    [result.document?.references, result.pageCount]
  )
  const headingPages = useMemo(
    () => (result.document?.headings ?? [])
      .filter((heading): heading is typeof heading & { page: number } => (
        typeof heading.page === 'number' && heading.page >= 1 && heading.page <= result.pageCount
      ))
      .slice(0, 24),
    [result.document?.headings, result.pageCount]
  )
  const switchReasons = [...new Set([
    ...(result.document?.route.switchReason ?? []),
    ...(result.retryReasons ?? []),
    ...(result.document?.quality.reasons ?? [])
  ])]

  useEffect(() => {
    if (!result.dataUrl) return
    let cancelled = false
    const base64 = result.dataUrl.slice(result.dataUrl.indexOf(',') + 1)
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const task = getDocument({ data: bytes, useWasm: false, maxImageSize: 20_000_000 })
    void task.promise.then((document) => {
      if (cancelled) return undefined
      documentRef.current = document
      setLoading(false)
      return undefined
    }).catch((reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
      documentRef.current = null
      void task.destroy()
    }
  }, [result.dataUrl])

  useEffect(() => {
    const document = documentRef.current
    const canvas = canvasRef.current
    if (!document || !canvas) return
    let cancelled = false
    let cancelRender: (() => void) | undefined
    void document.getPage(pageNumber).then((page) => {
      if (cancelled) return
      const viewport = page.getViewport({ scale })
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('Canvas is unavailable.')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      canvas.style.width = `${Math.ceil(viewport.width)}px`
      canvas.style.height = `${Math.ceil(viewport.height)}px`
      const renderTask = page.render({ canvas, canvasContext: context, viewport })
      cancelRender = () => renderTask.cancel()
      return renderTask.promise.finally(() => page.cleanup())
    }).catch((reason) => {
      if (!cancelled && reason?.name !== 'RenderingCancelledException') {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    })
    return () => {
      cancelled = true
      cancelRender?.()
    }
  }, [loading, pageNumber, scale])

  const search = (): void => {
    if (matchingPages.length > 0) setPageNumber(matchingPages[0])
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ds-border-muted px-3 py-2 text-[11px] text-ds-muted">
        <button type="button" className="ds-code-sidebar-icon-button" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => Math.max(1, page - 1))}><ChevronLeft className="h-3.5 w-3.5" /></button>
        <span>{pageNumber} / {result.pageCount}</span>
        <button type="button" className="ds-code-sidebar-icon-button" disabled={pageNumber >= result.pageCount} onClick={() => setPageNumber((page) => Math.min(result.pageCount, page + 1))}><ChevronRight className="h-3.5 w-3.5" /></button>
        <button type="button" className="ds-code-sidebar-icon-button" onClick={() => setScale((value) => Math.max(0.6, value - 0.15))}><Minus className="h-3.5 w-3.5" /></button>
        <span>{Math.round(scale * 100)}%</span>
        <button type="button" className="ds-code-sidebar-icon-button" onClick={() => setScale((value) => Math.min(2.5, value + 0.15))}><Plus className="h-3.5 w-3.5" /></button>
        <div className="ml-auto flex min-w-[150px] items-center rounded border border-ds-border-muted bg-ds-main px-2">
          <Search className="h-3.5 w-3.5 shrink-0" />
          <input className="min-w-0 flex-1 bg-transparent px-1.5 py-1 outline-none" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') search() }} placeholder="搜索 PDF" />
          {query ? <span>{matchingPages.length}</span> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-ds-border-muted px-3 py-1.5 text-[11px] text-ds-muted">
        {result.document ? <>
          <span>当前引擎：{result.document.engine} {result.document.engineVersion}</span>
          <span>质量：{result.document.quality.status}</span>
          <span>解析模式：{documentParsingModeLabel(result.document.route.requestedMode)}</span>
          {result.document.route.fallbackFrom ? <span>降级来源：{result.document.route.fallbackFrom}</span> : null}
          {headingPages.length > 0 ? (
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              标题页：
              {headingPages.map((heading, index) => (
                <button
                  key={`${heading.page}:${heading.text}:${index}`}
                  type="button"
                  onClick={() => setPageNumber(heading.page)}
                  className="max-w-[220px] truncate rounded border border-ds-border-muted px-1.5 py-0.5 text-left hover:bg-ds-hover"
                  title={`转到第 ${heading.page} 页：${heading.text}`}
                >
                  {heading.text} · {heading.page}
                </button>
              ))}
            </span>
          ) : null}
          {referencePages.length > 0 ? <span className="flex items-center gap-1">引用页：{referencePages.map((page) => <button key={page} type="button" onClick={() => setPageNumber(page)} className="rounded border border-ds-border-muted px-1.5 py-0.5 hover:bg-ds-hover" title={`转到第 ${page} 页`}>{page}</button>)}</span> : null}
        </> : result.documentError ? (
          <span className="text-red-600 dark:text-red-300">
            解析失败 [{result.documentError.code}]：{result.documentError.message}
          </span>
        ) : <span>解析元数据暂不可用，仍可使用 PDF 阅读和搜索。</span>}
        {switchReasons.length > 0 ? (
          <span>切换原因：{switchReasons.map(documentQualityReasonLabel).join('、')}</span>
        ) : null}
        {onRequestAccuratePdf && (!result.document || result.document.route.requestedMode !== 'accurate') ? (
          <button type="button" className="ml-auto inline-flex items-center gap-1 rounded border border-ds-border-muted px-2 py-1 text-ds-text-primary hover:bg-ds-hover" onClick={onRequestAccuratePdf}>
            <RefreshCw className="h-3 w-3" /> 使用高精度解析
          </button>
        ) : null}
      </div>
      {result.warnings.map((warning) => <div key={warning} className="shrink-0 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{warning}</div>)}
      <div className="min-h-0 flex-1 overflow-auto bg-slate-100 p-4 dark:bg-slate-950">
        {!result.dataUrl ? <div className="py-12 text-center text-[12px] text-ds-muted">PDF 超过内嵌预览上限，请使用顶部“打开”按钮在系统阅读器中查看。</div> : <>
          {loading ? <div className="py-12 text-center text-[12px] text-ds-muted">正在加载 PDF…</div> : null}
          {error ? <div className="py-12 text-center text-[12px] text-red-600">{error}</div> : null}
          <canvas ref={canvasRef} className="mx-auto bg-white shadow" />
        </>}
      </div>
    </div>
  )
}

function documentParsingModeLabel(mode: 'auto' | 'fast' | 'accurate'): string {
  if (mode === 'fast') return '快解析'
  if (mode === 'accurate') return '高精度解析'
  return '自动'
}

function documentQualityReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    low_text_density: '文本密度过低',
    weak_text_layer: 'PDF 文本层较弱',
    scanned_document: '扫描件或 OCR 需求',
    scanned_or_sparse_pages: '扫描或稀疏页面',
    garbled_text: '文本存在乱码',
    formula_dense: '公式密集',
    table_dense: '表格或跨页表格密集',
    complex_layout: '复杂或多栏版式',
    engine_fallback: '高精度引擎失败后已降级'
  }
  return labels[reason] ?? reason
}
