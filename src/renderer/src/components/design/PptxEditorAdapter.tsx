import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { AlertTriangle, Download, Eye, FileSliders, Layers3, LoaderCircle, PanelLeft, PanelRight, Save, ShieldAlert, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { createPptxViewer, exportSlideToSvg, loadPresentation, revokeBlobUrls, renderToCanvas, vermilionDarkTheme, vermilionLightTheme, type PptxElement, type PptxSlide, type PptxViewerInstance, type PptxViewerOptions, type ViewerTheme } from 'pptx-vanilla-viewer'
import 'pptx-vanilla-viewer/styles.css'
import { translationsZhCN } from 'pptx-vanilla-viewer/i18n/zh-CN'
import { PPTX_EDITOR_SOURCE } from '@shared/pptx-editor-adapter'
import type { DesignImportDiagnostic } from '@shared/design-document'
import type { DesignPptxRevisionMetadata } from '@shared/design-workspace'
import { NativePptxAssistant } from './NativePptxAssistant'
import { assertNativePptxRoundTrip, isProtectedNativeElement, nativeElementEntries, type NativePptxProposal, type NativePptxSnapshot } from './native-pptx-model'

type NativeEditorState = 'loading' | 'ready' | 'unavailable' | 'error'
type SaveState = 'saved' | 'dirty' | 'saving' | 'error'
export type NativePptxController = {
  save: () => Promise<boolean>
  exportPptx: () => Promise<void>
  exportImage: (format: 'png' | 'svg') => Promise<void>
  captureImage: (format: 'png' | 'svg') => Promise<string>
  getCurrentSlide: () => number
  goToSlide: (index: number) => void
  addSlide: () => void
  moveSlide: (from: number, to: number) => void
  deleteCurrentSlide: () => void
  undo: () => void
  redo: () => void
  isDirty: () => boolean
}
export type PptxEditorAdapterProps = {
  documentName: string
  documentId: string
  workspaceRoot: string
  expectedSourceSha256?: string
  slidesRailOpen: boolean
  panelsOpen: boolean
  onUseCanvas: () => void
  onToggleSlides: () => void
  onTogglePanels: () => void
  onControllerReady?: (controller: NativePptxController | null) => void
  onActiveSlideChange?: (index: number) => void
  onDirtyChange?: (dirty: boolean) => void
  children?: ReactNode
  reportStatus?: 'complete' | 'partial' | 'blocked'
  protectedObjectCount?: number
  unsupportedObjectCount?: number
  diagnostics?: DesignImportDiagnostic[]
  protectedSourceIds?: Array<{ pageIndex: number; id: string; sourcePart?: string; reason?: string }>
  referencePreview?: string
}
const LIMITS = { maxInputBytes: 200 * 1024 * 1024, maxUncompressedBytes: 500 * 1024 * 1024, maxEntries: 20_000, maxSlides: 500, maxShapes: 30_000 }
type ViewerThemeMode = 'light' | 'dark'

function currentViewerThemeMode(): ViewerThemeMode {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function viewerThemeFor(mode: ViewerThemeMode): ViewerTheme {
  return mode === 'dark' ? vermilionDarkTheme : vermilionLightTheme
}

export function PptxEditorAdapter(props: PptxEditorAdapterProps): ReactElement {
  const { documentName, documentId, workspaceRoot, expectedSourceSha256, slidesRailOpen, panelsOpen,
    onUseCanvas, onToggleSlides, onTogglePanels, diagnostics = [], reportStatus = 'partial',
    protectedObjectCount = 0, unsupportedObjectCount = 0 } = props
  const { t, i18n } = useTranslation('common')
  const zh = /^zh/i.test(i18n.resolvedLanguage || i18n.language)
  const callbacks = useRef(props)
  callbacks.current = props
  const editorHost = useRef<HTMLDivElement>(null)
  const referenceHost = useRef<HTMLDivElement>(null)
  const editorRef = useRef<PptxViewerInstance | null>(null)
  const referenceRef = useRef<PptxViewerInstance | null>(null)
  const revisionRef = useRef<DesignPptxRevisionMetadata | null>(null)
  const revisionCounter = useRef(0)
  const loadToken = useRef(0)
  const saveStateRef = useRef<SaveState>('saved')
  const savePromise = useRef<Promise<boolean> | null>(null)
  const canvasSize = useRef({ width: 1280, height: 720 })
  const protectedBaselines = useRef<Map<string, string>>(new Map())
  const revertingProtectedEdit = useRef(false)
  const originalIndexes = useRef(new Map<string, number>())
  const viewerThemeRef = useRef<ViewerTheme>(viewerThemeFor(currentViewerThemeMode()))
  const [viewerThemeMode, setViewerThemeMode] = useState<ViewerThemeMode>(currentViewerThemeMode)
  const [nativeState, setNativeState] = useState<NativeEditorState>('loading')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [message, setMessage] = useState<string | null>(null)
  const [displayMode, setDisplayMode] = useState<'edit' | 'reference' | 'compare'>('edit')
  const [referenceState, setReferenceState] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const markSave = useCallback((state: SaveState): void => {
    saveStateRef.current = state
    setSaveState(state)
    callbacks.current.onDirtyChange?.(state !== 'saved')
  }, [])
  useEffect(() => {
    const root = document.documentElement
    const syncTheme = (): void => {
      const mode = currentViewerThemeMode()
      viewerThemeRef.current = viewerThemeFor(mode)
      setViewerThemeMode(mode)
    }
    syncTheme()
    const observer = new MutationObserver(syncTheme)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const theme = viewerThemeRef.current
    editorRef.current?.setTheme(theme)
    referenceRef.current?.setTheme(theme)
  }, [viewerThemeMode])
  const protectedElement = useCallback((element: PptxElement, slide: PptxSlide): boolean => {
    const identity = slide.sourceSlideId || slide.id
    return isProtectedNativeElement(element) || (callbacks.current.protectedSourceIds ?? []).some((item) =>
      item.id === element.shapeId && (item.sourcePart === identity || item.pageIndex === originalIndexes.current.get(identity)))
  }, [])
  const syncReference = useCallback((): void => {
    const viewer = editorRef.current
    const reference = referenceRef.current
    if (!viewer || !reference) return
    const slide = viewer.getActiveSlide?.()
    const identity = slide?.sourceSlideId || slide?.id
    const index = reference.getSlides().findIndex((item) => (item.sourceSlideId || item.id) === identity)
    if (index >= 0) { reference.goToSlide(index); setReferenceState('ready') } else setReferenceState('missing')
  }, [])
  const validateBytes = useCallback(async (bytes: Uint8Array): Promise<void> => {
    const expected = editorRef.current?.getSlides?.()
    if (!expected) throw new Error('Native PPTX model is unavailable.')
    const loaded = await loadPresentation(new Uint8Array(bytes).buffer, { limits: LIMITS, allowExternalImages: false })
    try { assertNativePptxRoundTrip(expected, loaded.slides) } finally { revokeBlobUrls(loaded.blobUrls); loaded.handler.dispose() }
  }, [])
  const persistBytes = useCallback(async (bytes: Uint8Array): Promise<void> => {
    const current = revisionRef.current
    if (!current) throw new Error(t('designPptxNativeSourceUnavailable'))
    markSave('saving')
    await validateBytes(bytes)
    const saved = await window.workwise.saveDesignPptxRevision({ workspaceRoot, documentId, expectedSha256: current.sha256, bytes })
    if (!saved.ok || !saved.revision) throw new Error(saved.message || t('designPptxNativeSaveFailed'))
    revisionRef.current = saved.revision
    markSave('saved')
  }, [documentId, markSave, t, validateBytes, workspaceRoot])

  useEffect(() => {
    const currentToken = ++loadToken.current
    let mounted = true
    revisionRef.current = null
    setNativeState('loading'); setMessage(null); markSave('saved')
    const api = window.workwise
    if (!workspaceRoot || typeof api?.readDesignPptxRevision !== 'function') {
      setNativeState('unavailable'); setMessage(t('designPptxNativeApiUnavailable')); return
    }
    void api.readDesignPptxRevision({ workspaceRoot, documentId }).then((result) => {
      if (!mounted || currentToken !== loadToken.current) return
      if (!result.ok || !result.revision || !result.bytes) throw new Error(result.message || t('designPptxNativeSourceUnavailable'))
      if (result.revision.kind === 'source' && expectedSourceSha256 && result.revision.sha256 !== expectedSourceSha256) throw new Error(t('designPptxNativeSourceMismatch'))
      revisionRef.current = result.revision
      const viewer = createPptxViewer(editorHost.current!, {
        source: new Uint8Array(result.bytes), fileName: documentName,
        theme: viewerThemeRef.current,
        locale: zh ? 'zh-CN' : 'en', defaultLocale: zh ? 'zh-CN' : 'en', messages: { 'zh-CN': translationsZhCN },
        editable: true, readOnly: false, showToolbar: true, showThumbnails: true, showInspector: true,
        inspectorInitiallyOpen: false, showCompatibilityToasts: true,
        allowExternalContent: false, googleFonts: false, autosave: false, limits: LIMITS,
        hiddenActions: ['file', 'export', 'share', 'broadcast', 'record'],
        customization: {
          hiddenPanels: ['titleBar', 'quickAccessToolbar'], disabledFeatures: ['ai', 'collaboration'],
          ribbon: { hiddenTabs: ['design', 'animations'], hiddenGroups: ['view.masterViews'] },
          inspector: { hiddenCards: ['theme', 'themeOverride', 'templateBackground', 'notesHandout'] }
        },
        onHyperlinkClick: () => false,
        onLoad: (info) => { if (mounted && currentToken === loadToken.current) {
          canvasSize.current = info.canvasSize
          originalIndexes.current = new Map(editorRef.current?.getSlides?.().map((slide, index) => [slide.sourceSlideId || slide.id, index]) ?? [])
          protectedBaselines.current = new Map(editorRef.current?.getSlides?.().flatMap((slide) => nativeElementEntries(slide.elements).filter(({ element }) => protectedElement(element, slide)).map(({ element }) => [element.id, JSON.stringify(element)] as const)) ?? [])
          setNativeState('ready')
        } },
        onChange: () => {
          revisionCounter.current += 1
          if (revertingProtectedEdit.current) return
          const viewer = editorRef.current
          const changed = viewer?.getSlides?.().some((slide) => nativeElementEntries(slide.elements).some(({ element }) => protectedBaselines.current.has(element.id) && protectedBaselines.current.get(element.id) !== JSON.stringify(element)))
          if (changed && viewer) {
            revertingProtectedEdit.current = true
            try { viewer.undo() } finally { revertingProtectedEdit.current = false }
            setMessage(zh ? '此高级对象受保护，修改已撤销。' : 'This advanced object is protected. The edit was undone.')
          }
        },
        onSelectionChange: () => {
          const viewer = editorRef.current
          const entries = nativeElementEntries(viewer?.getElements?.() ?? [])
          const selected = viewer?.getSelectedElementIds?.() ?? []
          const slide = viewer?.getActiveSlide()
          if (slide && entries.some(({ element, ancestors }) => selected.includes(element.id) &&
            (protectedElement(element, slide) || ancestors.some((parent) => protectedElement(parent, slide)) || (element.type === 'group' && nativeElementEntries(element.children).some((child) => protectedElement(child.element, slide)))))) {
            viewer?.clearSelection()
            setMessage(zh ? '暂不支持直接编辑此高级对象；原件及其 OOXML 会保留。' : 'Direct editing of this advanced object is unavailable. Its original OOXML is retained.')
          }
        },
        onSlideChange: (index) => { callbacks.current.onActiveSlideChange?.(index); syncReference() },
        onDirtyChange: (dirty) => { if (mounted) markSave(dirty ? 'dirty' : 'saved') },
        onError: (error) => { if (mounted) { setMessage(error); markSave('error') } },
        storage: { save: async (bytes: Uint8Array) => { try { await persistBytes(bytes) } catch (error) { markSave('error'); throw error } } }
      } satisfies PptxViewerOptions)
      editorRef.current = viewer
    }).catch((error: unknown) => { if (mounted && currentToken === loadToken.current) { setNativeState('error'); setMessage(error instanceof Error ? error.message : String(error)) } })
    return () => {
      mounted = false; loadToken.current += 1
      callbacks.current.onControllerReady?.(null)
      editorRef.current?.destroy(); referenceRef.current?.destroy()
      editorRef.current = null; referenceRef.current = null
    }
  }, [documentId, documentName, expectedSourceSha256, markSave, persistBytes, protectedElement, syncReference, t, workspaceRoot, zh])

  useEffect(() => {
    const viewer = editorRef.current
    if (nativeState !== 'ready' || !viewer) return
    viewer.setPanelVisible?.('slidesPane', slidesRailOpen)
    viewer.setPanelVisible?.('inspector', panelsOpen)
  }, [nativeState, panelsOpen, slidesRailOpen])
  useEffect(() => {
    if (displayMode === 'edit' || nativeState !== 'ready' || referenceRef.current) return
    let canceled = false
    const currentToken = loadToken.current
    setReferenceState('loading')
    void window.workwise.readDesignPptxRevision({ workspaceRoot, documentId, kind: 'source' }).then((result) => {
      if (canceled) return
      if (!result.ok || !result.bytes || result.revision?.kind !== 'source' || (expectedSourceSha256 && result.revision.sha256 !== expectedSourceSha256)) throw new Error('Original PPTX is unavailable.')
      referenceRef.current = createPptxViewer(referenceHost.current!, {
        source: new Uint8Array(result.bytes), fileName: documentName, theme: viewerThemeRef.current, locale: zh ? 'zh-CN' : 'en', messages: { 'zh-CN': translationsZhCN },
        editable: false, readOnly: true, showToolbar: false, showThumbnails: false, showInspector: false,
        allowExternalContent: false, googleFonts: false, autosave: false, limits: LIMITS,
        showCompatibilityToasts: false, onHyperlinkClick: () => false,
        onLoad: () => { if (currentToken === loadToken.current) { setReferenceState('ready'); syncReference() } },
        onError: () => { if (currentToken === loadToken.current) setReferenceState('missing') }
      })
    }).catch(() => { if (!canceled) setReferenceState('missing') })
    return () => { canceled = true }
  }, [displayMode, documentId, documentName, expectedSourceSha256, nativeState, syncReference, workspaceRoot, zh])

  const save = useCallback(async (): Promise<boolean> => {
    if (savePromise.current) return savePromise.current
    const viewer = editorRef.current
    if (!viewer || nativeState !== 'ready') return false
    const pending = (async () => {
      try { setMessage(null); markSave('saving'); await persistBytes(await viewer.save()); return true } catch (error) {
        markSave('error'); setMessage(error instanceof Error ? error.message : String(error)); return false
      } finally { savePromise.current = null }
    })()
    savePromise.current = pending
    return pending
  }, [markSave, nativeState, persistBytes])
  const captureImage = useCallback(async (format: 'png' | 'svg'): Promise<string> => {
    const viewer = editorRef.current
    const slide = viewer?.getActiveSlide()
    if (!slide) throw new Error('No active PPTX slide.')
    const { width, height } = canvasSize.current
    const svg = exportSlideToSvg(slide, width, height)
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    if (format === 'svg') return svgUrl
    const stage = editorHost.current?.querySelector<HTMLElement>('.pptxv-stage[aria-roledescription="slide"]')
    if (!stage) throw new Error('The current slide is not rendered yet.')
    const captureHost = document.createElement('div')
    Object.assign(captureHost.style, { position: 'fixed', left: '-100000px', top: '0', width: `${width}px`, height: `${height}px`, pointerEvents: 'none' })
    const clone = stage.cloneNode(true) as HTMLElement
    const computed = getComputedStyle(stage)
    for (const key of Array.from(computed)) if (key.startsWith('--')) clone.style.setProperty(key, computed.getPropertyValue(key))
    Object.assign(clone.style, { transform: 'none', width: `${width}px`, height: `${height}px`, margin: '0' })
    captureHost.append(clone); document.body.append(captureHost)
    try { return (await renderToCanvas(clone, { width, height, scale: 1, backgroundColor: null, useCORS: false, allowTaint: false })).toDataURL('image/png') } finally { captureHost.remove() }
  }, [])
  const exportImage = useCallback(async (format: 'png' | 'svg'): Promise<void> => {
    try {
      const url = await captureImage(format)
      const dataBase64 = format === 'png' ? url.split(',')[1] : btoa(Array.from(new TextEncoder().encode(decodeURIComponent(url.split(',')[1])), (byte) => String.fromCharCode(byte)).join(''))
      const result = await window.workwise.saveWorkspaceFileAs({ suggestedName: `${documentName.replace(/\.pptx$/i, '')}-${(editorRef.current?.getCurrentSlide() ?? 0) + 1}.${format}`, dataBase64, mimeType: `image/${format === 'svg' ? 'svg+xml' : 'png'}` })
      if (!result.ok && !result.canceled) throw new Error(result.message)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }, [captureImage, documentName])
  const exportPptx = useCallback(async (): Promise<void> => {
    const viewer = editorRef.current
    if (!viewer || nativeState !== 'ready') return
    const wasDirty = saveStateRef.current !== 'saved' || viewer.isDirty()
    try {
      setMessage(null)
      const bytes = await viewer.save()
      await validateBytes(bytes)
      const result = await window.workwise.exportDesignPptxBytes({ workspaceRoot, documentId, name: `${documentName.replace(/\.pptx$/i, '')}-edited.pptx`, expectedSlideCount: viewer.getSlideCount(), bytes })
      if (!result.ok && !result.canceled) throw new Error(result.message || t('designPptxNativeExportFailed'))
      if (wasDirty) markSave('dirty')
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); markSave('error') }
  }, [documentId, documentName, markSave, nativeState, t, validateBytes, workspaceRoot])
  useEffect(() => {
    const viewer = editorRef.current
    if (nativeState !== 'ready' || !viewer) return
    callbacks.current.onControllerReady?.({
      save, exportPptx, exportImage, captureImage,
      getCurrentSlide: () => viewer.getCurrentSlide(), goToSlide: (index) => viewer.goToSlide(index),
      addSlide: () => viewer.addSlide(viewer.getCurrentSlide()), moveSlide: (from, to) => viewer.moveSlide(from, to),
      deleteCurrentSlide: () => viewer.deleteSlides([viewer.getCurrentSlide()]), undo: () => viewer.undo(), redo: () => viewer.redo(),
      isDirty: () => saveStateRef.current !== 'saved' || viewer.isDirty()
    })
  }, [captureImage, exportImage, exportPptx, nativeState, save])
  const getSnapshot = useCallback(async (): Promise<NativePptxSnapshot> => {
    const viewer = editorRef.current
    const slide = viewer?.getActiveSlide()
    if (!viewer || !slide) throw new Error('No active slide.')
    const detached = structuredClone(slide)
    for (const entry of nativeElementEntries(detached.elements)) if (protectedElement(entry.element, slide)) entry.element.railwiseProtected = true
    return { documentId, slideId: slide.id, slideIndex: viewer.getCurrentSlide(), revision: revisionCounter.current,
      selectedIds: viewer.getSelectedElementIds(), slide: detached, preview: await captureImage('png') }
  }, [captureImage, documentId, protectedElement])
  const applyProposal = useCallback(async (proposal: NativePptxProposal): Promise<void> => {
    const viewer = editorRef.current
    if (!viewer || proposal.snapshot.documentId !== documentId || proposal.snapshot.revision !== revisionCounter.current || viewer.getActiveSlide()?.id !== proposal.snapshot.slideId) throw new Error(zh ? '文档已变化，请重新生成修改建议。' : 'The document changed. Generate a new proposal.')
    await viewer.updateElements(proposal.updates, { label: proposal.summary })
  }, [documentId, zh])
  const ready = nativeState === 'ready'
  const saveLabel = saveState === 'saving' ? t('designPptxNativeSaving') : saveState === 'dirty' ? t('designPptxNativeUnsaved') : saveState === 'error' ? t('designPptxNativeSaveFailed') : t('designPptxNativeSaved')
  return <div className="flex min-h-0 flex-1 flex-col bg-ds-canvas" data-testid="pptx-editor-adapter">
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-ds-border bg-ds-card px-2 py-1.5 text-xs">
      <div className="flex rounded border border-ds-border" role="tablist" aria-label={t('designPptxDisplayMode')}>
        {(['edit', 'reference', 'compare'] as const).map((mode) => <button type="button" key={mode} role="tab" aria-selected={displayMode === mode} onClick={() => setDisplayMode(mode)} className={`flex min-h-8 items-center gap-1 px-2 ${displayMode === mode ? 'bg-accent/10 text-accent' : ''}`}>
          {mode === 'edit' ? <Layers3 className="h-3 w-3" /> : <Eye className="h-3 w-3" />}{t(mode === 'edit' ? 'designPptxEditMode' : mode === 'reference' ? 'designPptxReferenceMode' : 'designPptxCompareMode')}
        </button>)}
      </div>
      <button type="button" onClick={onToggleSlides} className="min-h-8 rounded px-2 hover:bg-ds-hover" aria-pressed={slidesRailOpen} aria-label={t('designPptxToggleSlides')} title={t('designPptxToggleSlides')}><PanelLeft className="h-4 w-4" /></button>
      <button type="button" onClick={onTogglePanels} className="min-h-8 rounded px-2 hover:bg-ds-hover" aria-pressed={panelsOpen} aria-label={t('designPptxTogglePanels')} title={t('designPptxTogglePanels')}><PanelRight className="h-4 w-4" /></button>
      <button type="button" onClick={() => setAssistantOpen((open) => !open)} className="flex min-h-8 items-center gap-1 rounded px-2 hover:bg-ds-hover" aria-pressed={assistantOpen}><Sparkles className="h-3.5 w-3.5" />AI</button>
      <button type="button" disabled={!ready || saveState === 'saving'} onClick={() => void save()} className="flex min-h-8 items-center gap-1 rounded border border-ds-border px-2 disabled:opacity-50"><Save className="h-3.5 w-3.5" />{t('designPptxNativeSave')}</button>
      <details className="relative"><summary className="flex min-h-8 cursor-pointer items-center gap-1 rounded border border-ds-border px-2"><Download className="h-3.5 w-3.5" />{zh ? '导出' : 'Export'}</summary><div className="absolute right-0 z-40 w-40 rounded border border-ds-border bg-ds-card p-1 shadow-lg">
        <button type="button" disabled={!ready} onClick={() => void exportPptx()} className="min-h-9 w-full px-2 text-left hover:bg-ds-hover">{t('designPptxNativeExport')}</button>
        {(['png', 'svg'] as const).map((format) => <button type="button" key={format} disabled={!ready} onClick={() => void exportImage(format)} className="min-h-9 w-full px-2 text-left hover:bg-ds-hover">{format.toUpperCase()}</button>)}
      </div></details>
      <span className={`ml-auto text-[11px] ${saveState === 'error' ? 'text-red-600' : 'text-ds-muted'}`} data-testid="pptx-native-save-state">{saveLabel}</span>
      <button type="button" onClick={() => setDiagnosticsOpen((open) => !open)} className="flex min-h-8 items-center gap-1 rounded px-2 hover:bg-ds-hover" aria-expanded={diagnosticsOpen}><ShieldAlert className="h-3.5 w-3.5" />{t('designPptxDiagnostics', { count: diagnostics.filter((item) => item.severity !== 'info').length })}</button>
      <button type="button" onClick={onUseCanvas} className="flex min-h-8 items-center gap-1 rounded border border-ds-border px-2"><FileSliders className="h-3.5 w-3.5" />{zh ? '新建自由画布' : 'Create canvas'}</button>
    </div>
    {message ? <div role="alert" className="shrink-0 border-b border-amber-200 bg-amber-50 p-2 text-xs text-amber-950">{message}</div> : null}
    {diagnosticsOpen ? <div className="max-h-40 shrink-0 overflow-y-auto border-b border-ds-border bg-ds-card p-3 text-xs" data-testid="pptx-adapter-diagnostics">
      <p>{reportStatus === 'complete' ? t('designPptxImportComplete') : reportStatus === 'blocked' ? t('designPptxImportBlocked') : t('designPptxImportPartial')} · {t('designPptxProtectedObjects', { count: protectedObjectCount + unsupportedObjectCount })}</p>
      <ul>{diagnostics.map((item, index) => <li key={index}>{item.pageNumber ? `${t('designPage')} ${item.pageNumber}: ` : ''}{item.message}</li>)}</ul>
    </div> : null}
    <div className="relative flex min-h-0 flex-1 overflow-hidden" data-testid="pptx-editor-display">
      <div className={`relative min-h-0 min-w-0 flex-1 ${displayMode === 'compare' ? 'grid grid-cols-1 lg:grid-cols-2' : ''}`}>
        <div className={displayMode === 'reference' ? 'pointer-events-none absolute inset-0 opacity-0' : 'relative min-h-0 min-w-0 h-full'} data-testid="pptx-native-editor">
          <div ref={editorHost} className="h-full min-h-0 min-w-0 bg-white" data-testid="pptx-native-editor-host" />
          {!ready ? <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ds-main p-6 text-center text-sm" data-testid={nativeState === 'loading' ? 'pptx-native-loading' : 'pptx-native-unavailable'}>
            {nativeState === 'loading' ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <AlertTriangle className="h-5 w-5 text-amber-600" />}
            {nativeState === 'loading' ? t('designPptxNativeLoading') : (message || t('designPptxNativeSourceUnavailable'))}
          </div> : null}
        </div>
        <div className={displayMode === 'edit' ? 'pointer-events-none absolute inset-0 opacity-0' : displayMode === 'compare' ? 'hidden min-h-0 border-l border-ds-border lg:block' : 'absolute inset-0'} data-pptx-display-mode="reference">
          <div className="relative flex h-full min-h-0 flex-col">
            <p className="shrink-0 border-b border-ds-border px-3 py-2 text-xs text-ds-muted">{zh ? '原始 PPTX · 同一渲染引擎只读参考，非 PowerPoint 像素级保真证明' : 'Original PPTX · read-only reference using the same renderer; PowerPoint pixel fidelity is not certified'}</p>
            <div ref={referenceHost} className="min-h-0 flex-1 bg-white" />
            {referenceState !== 'ready' ? <p className="absolute inset-x-0 top-1/2 bg-ds-card p-3 text-center text-xs">{referenceState === 'loading' ? t('designPptxNativeLoading') : (zh ? '此页面没有对应的原件参考，或原件无法加载。' : 'No corresponding original slide is available.')}</p> : null}
          </div>
        </div>
        {displayMode === 'compare' ? <p className="absolute bottom-0 left-0 right-0 bg-ds-card p-2 text-center text-xs lg:hidden">{zh ? '窗口较窄，请切换“参考”查看原件。' : 'Use Reference to inspect the original in a narrow window.'}</p> : null}
      </div>
      {assistantOpen && ready ? <NativePptxAssistant key={documentId} documentId={documentId} documentName={documentName} workspaceRoot={workspaceRoot} getSnapshot={getSnapshot} applyProposal={applyProposal} onClose={() => setAssistantOpen(false)} /> : null}
    </div>
    <span className="sr-only" data-source={PPTX_EDITOR_SOURCE.name} data-license={PPTX_EDITOR_SOURCE.license} data-version={PPTX_EDITOR_SOURCE.version} />
  </div>
}
