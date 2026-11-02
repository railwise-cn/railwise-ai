import { type ReactElement } from 'react'
import { diffLines } from 'diff'
import { useTranslation } from 'react-i18next'
import type { WriteInlineEditResolvedScope } from '../../write/inline-edit'
import { useWriteDialogFocus } from './use-write-dialog-focus'

export type PendingWriteAiEdit = {
  workspaceRoot: string
  path: string
  instruction: string
  scope: WriteInlineEditResolvedScope
  replacement: string
  sourceContent: string
}

export function WriteAiReviewDialog({ edit, error, onApply, onClose }: {
  edit: PendingWriteAiEdit | null
  error: string | null
  onApply: () => void
  onClose: () => void
}): ReactElement | null {
  const { t } = useTranslation('common')
  useWriteDialogFocus(Boolean(edit), 'write-ai-review-title', onClose)
  if (!edit) return null
  const parts = diffLines(edit.scope.text, edit.replacement)
  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40 p-4">
      <section role="dialog" aria-modal="true" aria-labelledby="write-ai-review-title" className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-ds-border bg-ds-card p-5 shadow-2xl">
        <h2 id="write-ai-review-title" className="text-[16px] font-semibold text-ds-ink">{t('writeAiReviewTitle', { defaultValue: '审阅 AI 修改' })}</h2>
        <p className="mt-2 text-[12px] leading-5 text-ds-muted">{edit.instruction}</p>
        <div className="mt-3 min-h-0 flex-1 overflow-auto rounded-xl border border-ds-border-muted bg-ds-panel p-3 font-mono text-[12px] leading-6" aria-label={t('writeAiReviewDiff', { defaultValue: '修改差异' })}>
          {parts.map((part, index) => (
            <div key={index} className={`whitespace-pre-wrap break-words border-l-2 px-2 ${part.added ? 'border-emerald-500 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200' : part.removed ? 'border-red-500 bg-red-500/10 text-red-800 dark:text-red-200' : 'border-transparent text-ds-muted'}`}>
              <span aria-hidden="true" className="mr-2 select-none">{part.added ? '+' : part.removed ? '−' : ' '}</span>{part.value}
            </div>
          ))}
        </div>
        {error ? <p role="alert" className="mt-3 text-[12px] text-red-600 dark:text-red-300">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button autoFocus type="button" onClick={onClose} className="rounded-lg border border-ds-border px-4 py-2 text-[12px] text-ds-ink hover:bg-ds-hover">{t('writeAiReviewDiscard', { defaultValue: '放弃修改' })}</button>
          <button type="button" onClick={onApply} className="rounded-lg bg-accent px-4 py-2 text-[12px] font-semibold text-white hover:brightness-105">{t('writeAiReviewAccept', { defaultValue: '接受修改' })}</button>
        </div>
      </section>
    </div>
  )
}
