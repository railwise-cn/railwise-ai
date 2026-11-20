import { useId, useRef, useState, type ReactElement } from 'react'
import { ChevronDown, FileText, FolderSearch, Loader2, RotateCcw, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AttachmentReference } from '../../agent/types'

export function AttachmentFileName({ name }: { name: string }): ReactElement {
  const extension = name.match(/\.[\p{L}\p{N}]{1,8}$/u)?.[0] || ''
  const hasExtension = extension.length > 0 && extension !== name
  return (
    <span className="ds-chat-attachment-filename" title={name}>
      <span className="sr-only">{name}</span>
      <span className="ds-chat-attachment-basename" aria-hidden>{hasExtension ? name.slice(0, -extension.length) : name}</span>
      {hasExtension ? <span aria-hidden>{extension}</span> : null}
    </span>
  )
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`
}

function isAttachmentInterrupted(attachment: AttachmentReference): boolean {
  return attachment.state === 'failed' || attachment.state === 'cancelled'
}

export function FloatingComposerAttachments({
  attachments,
  error,
  onRemove,
  onRetry
}: {
  attachments: AttachmentReference[]
  error?: string | null
  onRemove?: (id: string) => void
  onRetry?: (id: string) => void
}): ReactElement | null {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState(false)
  const firstNameRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  if (!attachments.length && !error) return null

  const failedCount = attachments.filter(isAttachmentInterrupted).length
  const restrictedCount = attachments.filter((attachment) => attachment.state === 'degraded').length
  const summary = [
    failedCount ? t('composerAttachmentsNeedAttention', { count: failedCount }) : '',
    restrictedCount ? t('composerAttachmentsLimited', { count: restrictedCount }) : ''
  ].filter(Boolean).join(' · ')
  const batchError = error && !attachments.some((attachment) => attachment.degradationReasons?.includes(error))
    ? error : null
  const collapse = (target: HTMLElement): void => {
    const row = target.closest('li')
    if (!row || row !== row.parentElement?.firstElementChild) firstNameRef.current?.focus()
    setExpanded(false)
  }

  return (
    <section
      aria-label={t('composerAttachmentsLabel')}
      className="ds-no-drag ds-composer-attachments"
      data-expanded={expanded}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !expanded) return
        event.preventDefault()
        event.stopPropagation()
        collapse(event.target as HTMLElement)
      }}
    >
      {attachments.length ? (
        <>
          <ul id={listId} className="ds-composer-attachment-list">
            {attachments.map((attachment, index) => {
              const nameId = `${listId}-name-${index}`
              const name = attachment.name || t('composerAttachmentUnnamed')
              const progress = typeof attachment.progress === 'number' && attachment.progress > 0 && attachment.progress < 1
                ? `${Math.round(attachment.progress * 100)}%` : ''
              const processing = attachment.state === 'uploading' || attachment.state === 'parsing'
              const status = attachment.state && attachment.state !== 'ready'
                ? [t(`composerAttachmentState.${attachment.state}`), progress].filter(Boolean).join(' ') : ''
              const size = typeof attachment.byteSize === 'number' ? formatAttachmentBytes(attachment.byteSize) : ''
              const imageOnly = attachment.state === 'degraded' && attachment.degradationReasons?.includes('no_extractable_pdf_text')
              const canRetry = onRetry && attachment.localSourcePath && isAttachmentInterrupted(attachment)
              const description = imageOnly ? t('composerAttachmentImageOnlyPdf') : isAttachmentInterrupted(attachment)
                ? attachment.degradationReasons?.[0] : undefined

              return (
                <li key={attachment.id} className="ds-composer-attachment-item">
                  <div className="ds-composer-attachment-tile">
                    <span className="ds-composer-attachment-icon" aria-hidden>
                      {attachment.previewUrl ? <img src={attachment.previewUrl} alt="" />
                        : processing ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                          : <FileText className="h-4 w-4" strokeWidth={1.8} />}
                    </span>
                    <div className="min-w-0">
                      <button
                        type="button"
                        id={nameId}
                        ref={index === 0 ? firstNameRef : undefined}
                        className="ds-composer-attachment-name ds-composer-attachment-control"
                        aria-controls={listId}
                        aria-expanded={expanded}
                        onClick={(event) => expanded ? collapse(event.currentTarget) : setExpanded(true)}
                      >
                        <AttachmentFileName name={name} />
                      </button>
                      {size || status ? (
                        <p title={description} className="ds-composer-attachment-meta">
                          {[size, status].filter(Boolean).join(' · ')}
                        </p>
                      ) : null}
                    </div>
                    <div className="ds-composer-attachment-actions">
                      {canRetry ? (
                        <button type="button" onClick={() => onRetry(attachment.id)} className="ds-composer-attachment-control" aria-label={t('composerAttachmentRetry')} aria-describedby={nameId} title={t('composerAttachmentRetry')}>
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                      {attachment.managedPath ? (
                        <button type="button" onClick={() => void window.workwise.openChatAttachmentOriginal(attachment.managedPath!)} className="ds-composer-attachment-control" aria-label={t('composerAttachmentRevealOriginal')} aria-describedby={nameId} title={t('composerAttachmentRevealOriginal')}>
                          <FolderSearch className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                      {onRemove ? (
                        <button type="button" onClick={() => onRemove(attachment.id)} className="ds-composer-attachment-control" aria-label={t('composerRemoveAttachment')} aria-describedby={nameId} title={t('composerRemoveAttachment')}>
                          <X className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {description ? <p className="ds-composer-attachment-description">{description}</p> : null}
                </li>
              )
            })}
          </ul>
          <button
            type="button"
            className="ds-composer-attachment-toggle ds-composer-attachment-control"
            data-attachment-count={attachments.length}
            data-has-summary={Boolean(summary)}
            aria-controls={listId}
            aria-expanded={expanded}
            onClick={(event) => expanded ? collapse(event.currentTarget) : setExpanded(true)}
          >
            <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {expanded ? t('composerAttachmentsCollapse') : [t('composerAttachmentsShow', { count: attachments.length }), summary].filter(Boolean).join(' · ')}
            </span>
          </button>
        </>
      ) : null}
      {batchError ? <p role="status" className="ds-composer-attachment-batch-error">{batchError}</p> : null}
    </section>
  )
}
