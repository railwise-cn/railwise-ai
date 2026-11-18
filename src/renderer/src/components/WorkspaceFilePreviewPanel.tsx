import type { WorkspaceFileReadResult, WorkspaceFileTarget } from '@shared/workspace-file'
import {
  isDocumentQualityReasonV1,
  type DocumentParsingMode,
  type DocumentQualityReasonV1,
  type WorkspacePreviewResultV1
} from '@shared/agent-workbench'
import {
  Check,
  ChevronRight,
  Copy,
  ExternalLink,
  FileCode2,
  Loader2,
  PanelRightClose
} from 'lucide-react'
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import { useTranslation } from 'react-i18next'
import { WORKBOOK_SUFFIX } from '@shared/workspace-sheet'
import { formatFilePathForDisplay } from '../lib/diff-stats'
import { openWorkspacePathInEditor } from '../lib/open-workspace-path'
import { languageFromFilePath } from '../lib/code-highlighting'
import { WorkbenchPanelLoader } from './workbench-panel-loader'
import {
  builtinWorkspaceFileViewers,
  resolveBuiltinWorkspaceFileViewer
} from './workspace-file-viewers'

type Props = {
  target: WorkspaceFileTarget | null
  workspaceRoot: string
  className?: string
  onClose: () => void
}

const COPY_RESET_MS = 1400
const Spreadsheet = lazy(() => import('./WorkspaceSpreadsheet').then(module => ({ default: module.WorkspaceSpreadsheet })))

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

function splitPath(path: string): string[] {
  return path.split(/[/\\]/).filter(Boolean)
}

function relativePathSegments(path: string, workspaceRoot: string): string[] {
  const normalizedPath = path.replaceAll('\\', '/')
  const normalizedRoot = workspaceRoot.replaceAll('\\', '/').replace(/\/+$/, '')
  if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return splitPath(normalizedPath.slice(normalizedRoot.length + 1))
  }
  return splitPath(path)
}

function extensionBadge(path: string, language: string): string {
  const fileName = fileNameFromPath(path)
  const ext = fileName.includes('.') ? fileName.split('.').pop() ?? '' : ''
  const value = ext || language || 'txt'
  return value.slice(0, 3).toUpperCase()
}

export function WorkspaceFilePreviewPanel({
  target,
  workspaceRoot,
  className,
  onClose
}: Props): ReactElement {
  const { t } = useTranslation('common')
  const isSpreadsheet = target?.path.toLowerCase().endsWith(WORKBOOK_SUFFIX) || /\.xlsx$/i.test(target?.path ?? '')
  const [result, setResult] = useState<WorkspaceFileReadResult | null>(null)
  const [richResult, setRichResult] = useState<WorkspacePreviewResultV1 | null>(null)
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef<number | null>(null)
  const activeParseIdRef = useRef<string | null>(null)
  const previewGenerationRef = useRef(0)

  const cancelActiveParse = (): void => {
    previewGenerationRef.current += 1
    const parseId = activeParseIdRef.current
    if (!parseId) return
    activeParseIdRef.current = null
    void window.workwise.cancelDocumentParse(parseId).catch(() => undefined)
  }

  const closePreview = (): void => {
    cancelActiveParse()
    onClose()
  }

  useEffect(() => {
    if (!target || isSpreadsheet) {
      setResult(null)
      setRichResult(null)
      setLoading(false)
      return
    }

    let cancelled = false
    const previewGeneration = ++previewGenerationRef.current
    setLoading(true)
    setResult(null)
    setRichResult(null)

    const extension = target.path.split('.').at(-1)?.toLowerCase() ?? ''
    const rich = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'md', 'markdown', 'txt', 'pdf', 'docx', 'pptx', 'xlsx'].includes(extension)
    const workspace = target.workspaceRoot ?? workspaceRoot
    const parseId = `preview:${workspace}:${target.path}`
    const documentBacked = ['pdf', 'docx', 'pptx', 'xlsx'].includes(extension)
    activeParseIdRef.current = documentBacked ? parseId : null
    const pending = rich
      ? window.workwise.previewWorkspaceFile({
          workspaceRoot: workspace,
          relativePath: target.path,
          idempotencyKey: parseId
        })
      : window.workwise.readWorkspaceFile({ ...target, workspaceRoot: workspace })

    void pending
      .then((next) => {
        if (cancelled || previewGenerationRef.current !== previewGeneration) return
        if (rich) setRichResult(next as WorkspacePreviewResultV1)
        else setResult(next as WorkspaceFileReadResult)
      })
      .catch((error) => {
        if (!cancelled && previewGenerationRef.current === previewGeneration) {
          setResult({
            ok: false,
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
      .finally(() => {
        if (!cancelled && previewGenerationRef.current === previewGeneration) setLoading(false)
        if (activeParseIdRef.current === parseId) activeParseIdRef.current = null
      })

    return () => {
      cancelled = true
      cancelActiveParse()
    }
  }, [target, workspaceRoot, isSpreadsheet])

  useEffect(
    () => () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
    },
    []
  )

  const displayPath = useMemo(() => {
    if (result?.ok) return formatFilePathForDisplay(result.path, workspaceRoot) ?? result.path
    return target?.path ?? ''
  }, [result, target, workspaceRoot])
  const language = useMemo(() => {
    if (result?.ok) return languageFromFilePath(result.path)
    return target?.path ? languageFromFilePath(target.path) : ''
  }, [result, target])
  const breadcrumbSegments = useMemo(() => {
    const path = result?.ok ? result.path : target?.path ?? ''
    if (!path) return []
    const projectName = workspaceRoot ? fileNameFromPath(workspaceRoot) : 'Project'
    return ['Project', projectName, ...relativePathSegments(path, workspaceRoot)]
  }, [result, target, workspaceRoot])
  const currentFileName = displayPath ? fileNameFromPath(displayPath) : t('filePreviewTitle')
  const badge = extensionBadge(result?.ok ? result.path : target?.path ?? '', language)
  const activeViewer = useMemo(() => {
    if (!richResult && !result?.ok) return null
    return resolveBuiltinWorkspaceFileViewer({
      fileName: result?.ok ? result.path : target?.path ?? '',
      ...(result?.ok
        ? { bytes: new TextEncoder().encode(result.content.slice(0, 4096)) }
        : {})
    })
  }, [result, richResult, target])

  const openInEditor = (): void => {
    const path = result?.ok ? result.path : target?.path
    if (!path) return
    void openWorkspacePathInEditor(
      {
        path,
        line: result?.ok ? result.line : target?.line,
        column: result?.ok ? result.column : target?.column
      },
      target?.workspaceRoot ?? workspaceRoot
    ).then((next) => {
      if (!next.ok) {
        void window.workwise?.logError?.('editor-open', 'Failed to open previewed file', {
          message: next.message,
          target
        })?.catch(() => undefined)
      }
    })
  }

  const copyPath = async (): Promise<void> => {
    const path = result?.ok ? result.path : target?.path
    if (!path || !navigator?.clipboard?.writeText) return
    try {
      await navigator.clipboard.writeText(path)
      setCopied(true)
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
      copyResetRef.current = window.setTimeout(() => setCopied(false), COPY_RESET_MS)
    } catch {
      setCopied(false)
    }
  }

  const requestAccuratePdf = (): void => {
    if (!target || target.path.split('.').at(-1)?.toLowerCase() !== 'pdf') return
    const workspace = target.workspaceRoot ?? workspaceRoot
    const parseId = `preview:${workspace}:${target.path}:accurate`
    const retryReasons: DocumentQualityReasonV1[] = richResult?.kind === 'pdf'
      ? [...new Set([
          ...(richResult.retryReasons ?? []),
          ...(richResult.document?.route.switchReason ?? []),
          ...(richResult.document?.quality.reasons ?? [])
        ].filter(isDocumentQualityReasonV1))]
      : []
    const previewGeneration = ++previewGenerationRef.current
    activeParseIdRef.current = parseId
    setLoading(true)
    void window.workwise.previewWorkspaceFile({
      workspaceRoot: workspace,
      relativePath: target.path,
      parsingMode: 'accurate' as DocumentParsingMode,
      ...(retryReasons.length ? { retryReasons } : {}),
      idempotencyKey: parseId
    }).then((next) => {
      if (previewGenerationRef.current !== previewGeneration) return
      const mergedRetryReasons: DocumentQualityReasonV1[] = next.kind === 'pdf'
        ? [...new Set([...(next.retryReasons ?? []), ...retryReasons])]
        : []
      const accurateResult = next.kind === 'pdf' && mergedRetryReasons.length > 0
        ? {
            ...next,
            retryReasons: mergedRetryReasons
          }
        : next
      setResult(null)
      setRichResult(accurateResult)
    }).catch((error) => {
      if (previewGenerationRef.current !== previewGeneration) return
      setResult({ ok: false, message: error instanceof Error ? error.message : String(error) })
    }).finally(() => {
      if (previewGenerationRef.current === previewGeneration) setLoading(false)
      if (activeParseIdRef.current === parseId) activeParseIdRef.current = null
    })
  }

  return (
    <aside
      className={`ds-opaque-work-surface ds-no-drag ds-code-sidebar flex min-h-0 flex-col border-l border-ds-border-muted ${className ?? ''}`}
    >
      <div className="ds-code-sidebar-topbar">
        <button
          type="button"
          onDoubleClick={openInEditor}
          className="ds-code-sidebar-tab"
          title={displayPath}
          disabled={!target}
        >
          <span className="ds-code-sidebar-file-badge">{badge}</span>
          <span className="truncate">{currentFileName}</span>
        </button>

        <div className="ds-code-sidebar-actions">
          <button
            type="button"
            onClick={openInEditor}
            disabled={!target}
            className="ds-code-sidebar-icon-button"
            title={t('filePreviewOpenEditor')}
            aria-label={t('filePreviewOpenEditor')}
          >
            <ExternalLink className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => void copyPath()}
            disabled={!target}
            className="ds-code-sidebar-icon-button"
            title={copied ? t('copySuccess') : t('filePreviewCopyPath')}
            aria-label={copied ? t('copySuccess') : t('filePreviewCopyPath')}
          >
            {copied ? (
              <Check className="h-4 w-4 text-emerald-600" strokeWidth={2} />
            ) : (
              <Copy className="h-4 w-4" strokeWidth={1.75} />
            )}
          </button>
          <button
            type="button"
            onClick={closePreview}
            className="ds-code-sidebar-icon-button"
            title={t('rightPanelCollapse')}
            aria-label={t('rightPanelCollapse')}
          >
            <PanelRightClose className="h-4 w-4" strokeWidth={1.85} />
          </button>
        </div>
      </div>

      <div className="ds-code-sidebar-breadcrumbs">
        <div className="min-w-0 flex flex-1 items-center gap-1 overflow-hidden">
          {breadcrumbSegments.length ? breadcrumbSegments.map((segment, index) => (
            <span key={`${segment}-${index}`} className="contents">
              {index > 0 ? (
                <ChevronRight className="h-3 w-3 shrink-0 text-ds-faint/70" strokeWidth={1.8} />
              ) : null}
              <span
                className={[
                  'truncate',
                  index === breadcrumbSegments.length - 1 ? 'text-ds-ink' : 'text-ds-muted'
                ].join(' ')}
                title={segment}
              >
                {segment}
              </span>
            </span>
          )) : (
            <span className="truncate text-ds-muted">{t('filePreviewEmpty')}</span>
          )}
        </div>
        {result?.ok || richResult ? (
          <span className="shrink-0 font-mono text-[10px] text-ds-faint">
            {formatBytes(result?.ok ? result.size : richResult?.sizeBytes ?? 0)}
            {language ? ` · ${language}` : ''}
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {!target ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] leading-6 text-ds-muted">
            <div className="flex flex-col items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-ds-border-muted text-ds-faint">
                <FileCode2 className="h-5 w-5" strokeWidth={1.7} />
              </div>
              {t('filePreviewEmpty')}
            </div>
          </div>
        ) : isSpreadsheet ? (
          <Suspense fallback={<p className="px-3 py-2 text-xs text-ds-muted">{t('filePreviewLoading')}</p>}>
            <Spreadsheet
              key={`${target.workspaceRoot ?? workspaceRoot}:${target.path}`}
              target={{ workspaceRoot: target.workspaceRoot ?? workspaceRoot, path: target.path }}
              displayName={currentFileName}
              onOpenSystem={/\.xlsx$/i.test(target.path) ? () => {
                void window.workwise.openWorkspaceFile({ path: target.path, workspaceRoot: target.workspaceRoot ?? workspaceRoot })
              } : undefined}
            />
          </Suspense>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-ds-muted">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.8} />
            {t('filePreviewLoading')}
          </div>
        ) : activeViewer && (richResult || result?.ok) ? (
          <WorkbenchPanelLoader
            registry={builtinWorkspaceFileViewers}
            kind="viewer"
            panelId={activeViewer.id}
            title={t('workbenchPanelErrorTitle')}
            retryLabel={t('workbenchPanelRetry')}
          >
            {(module) => activeViewer.render(module, {
              richResult,
              textResult: result?.ok ? result : null,
              language,
              onRequestAccuratePdf: requestAccuratePdf
            })}
          </WorkbenchPanelLoader>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] leading-6 text-red-700 dark:text-red-300">
            {(result && !result.ok ? result.message : undefined) ?? t('filePreviewFailed')}
          </div>
        )}
      </div>
    </aside>
  )
}
