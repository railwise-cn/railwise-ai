import type { ReactElement } from 'react'
import { useState } from 'react'
import { ChevronDown, ChevronRight, Copy, FolderOpen } from 'lucide-react'

export function RuntimeBanner({
  message,
  detail,
  code,
  logPath,
  onOpenLogDir,
  onOpenSettings,
  onRetryConnection,
  runtimeReady,
  stageInsetClass,
  inConversation = false,
  t
}: {
  message: string
  detail?: string | null
  code?: string | null
  logPath?: string | null
  onOpenLogDir?: () => Promise<{ ok: boolean; message?: string }>
  onOpenSettings: () => void
  onRetryConnection: () => void
  runtimeReady: boolean
  stageInsetClass: string
  inConversation?: boolean
  t: (key: string) => string
}): ReactElement {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [logOpenError, setLogOpenError] = useState<string | null>(null)
  const cleanedLogPath = logPath?.trim() ?? ''
  const technicalDetailText = [
    code ? `Code: ${code}` : '',
    detail?.trim() ?? ''
  ].filter(Boolean).join('\n\n')
  const detailText = [
    technicalDetailText,
    cleanedLogPath ? `${t('runtimeErrorLogPath')}: ${cleanedLogPath}` : ''
  ].filter(Boolean).join('\n\n')
  const hasDetail = detailText.trim().length > 0
  const textTone = inConversation ? 'text-ds-muted' : 'text-amber-950 dark:text-amber-100'
  const detailActionTone = inConversation
    ? 'text-ds-muted hover:bg-ds-hover'
    : 'text-amber-900/80 hover:bg-amber-50/70 dark:text-amber-100 dark:hover:bg-amber-900/30'

  const copyDetails = async (): Promise<void> => {
    if (!hasDetail || !navigator?.clipboard?.writeText) return
    await navigator.clipboard.writeText(detailText)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1400)
  }

  const openLogDir = async (): Promise<void> => {
    if (!onOpenLogDir) return
    setLogOpenError(null)
    try {
      const result = await onOpenLogDir()
      if (!result.ok) setLogOpenError(result.message ?? t('runtimeErrorOpenLogsFailed'))
    } catch (error) {
      setLogOpenError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className={inConversation
      ? 'ds-no-drag shrink-0 rounded-lg border border-ds-border bg-ds-card'
      : 'ds-no-drag shrink-0 border-b border-amber-200/70 bg-[rgba(255,248,235,0.82)] backdrop-blur-lg dark:border-amber-800/50 dark:bg-amber-950/35'}>
      <div className={`${stageInsetClass} flex w-full min-w-0 flex-col gap-2 py-3`}>
        <div className="flex w-full min-w-0 items-start justify-between gap-3">
          <p role="status" className={`min-w-0 flex-1 break-words text-[14px] leading-6 ${textTone}`}>
            {message}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {hasDetail ? (
              <button
                type="button"
                aria-expanded={detailsOpen}
                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] font-medium transition ${detailActionTone}`}
                onClick={() => setDetailsOpen((value) => !value)}
              >
                {detailsOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" strokeWidth={2} />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
                )}
                {t('runtimeErrorDetails')}
              </button>
            ) : null}
            {!runtimeReady ? (
              <>
                <button
                  type="button"
                  className="rounded-lg border border-amber-300/70 bg-white px-3 py-1 text-[12px] font-medium text-amber-950 transition hover:bg-amber-100/80 dark:border-amber-700/60 dark:bg-amber-900/20 dark:text-amber-100 dark:hover:bg-amber-900/40"
                  onClick={onRetryConnection}
                >
                  {t('retryConnection')}
                </button>
                <button
                  type="button"
                  className="rounded-lg px-3 py-1 text-[12px] font-medium text-amber-900/80 transition hover:bg-amber-50/70 dark:text-amber-100 dark:hover:bg-amber-900/30"
                  onClick={onOpenSettings}
                >
                  {t('openSettings')}
                </button>
              </>
            ) : null}
          </div>
        </div>
        {cleanedLogPath && detailsOpen ? (
          <div className={`flex min-w-0 flex-wrap items-center gap-2 text-[12px] leading-5 ${textTone}`}>
            <span className="font-medium">{t('runtimeErrorLogPath')}</span>
            <code className={`min-w-0 max-w-full break-all rounded-md px-2 py-0.5 font-mono text-[12px] ${textTone}`}>
              {cleanedLogPath}
            </code>
            {onOpenLogDir ? (
              <button
                type="button"
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] font-medium transition ${detailActionTone}`}
                onClick={() => void openLogDir()}
              >
                <FolderOpen className="h-3.5 w-3.5" strokeWidth={2} />
                {t('windowsMenuOpenLogDir')}
              </button>
            ) : null}
            {logOpenError ? (
              <span className={textTone}>{logOpenError}</span>
            ) : null}
          </div>
        ) : null}
        {hasDetail && detailsOpen ? (
          <div className={inConversation ? 'border-t border-ds-border pt-2' : 'rounded-lg border border-amber-300/60 bg-white/70 p-3 dark:border-amber-800/50 dark:bg-amber-950/25'}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span className={`text-[12px] font-semibold ${textTone}`}>
                {t('runtimeErrorTechnicalDetails')}
              </span>
              <button
                type="button"
                className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium transition ${detailActionTone}`}
                onClick={() => void copyDetails()}
              >
                <Copy className="h-3.5 w-3.5" strokeWidth={2} />
                {copied ? t('copySuccess') : t('copyDetails')}
              </button>
            </div>
            <pre className={`max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 ${textTone}`}>
              {detailText}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  )
}
