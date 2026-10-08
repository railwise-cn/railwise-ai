import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, CheckCircle2, Download, FileText, Loader2, Square } from 'lucide-react'
import { SurveyDraftExportV1 } from '@shared/survey-collaboration'
import { openGeneratedWorkspaceFile, saveGeneratedWorkspaceFileAs } from '../../lib/generated-file-actions'

export type SurveyReviewRunDetails = {
  run: { id: string; status: string; input?: unknown; updatedAt: string }
  nodeRuns: Array<{ id: string; nodeId: string; status: string; attempt: number; output?: unknown; error?: string }>
  events: Array<{ id: string; type: string; payload: unknown; createdAt: string }>
}
type Action = 'resume' | 'retry' | 'approve' | 'reject'

/** Only a bound, successful export is a file list. Arbitrary node output is never a file action. */
export function surveyReviewExport(details: SurveyReviewRunDetails | null, draftId: string): SurveyDraftExportV1 | null {
  if (!details || details.run.status !== 'succeeded') return null
  const input = details.run.input as { draftId?: unknown; revision?: unknown; contentHash?: unknown } | undefined
  const output = details.nodeRuns.filter(node => node.nodeId === 'export' && node.status === 'succeeded').at(-1)
  const receipt = SurveyDraftExportV1.safeParse(output?.output)
  if (!receipt.success || input?.draftId !== draftId || receipt.data.draftId !== draftId
    || receipt.data.revision !== input.revision || receipt.data.contentHash !== input.contentHash
    || receipt.data.files.some(file => !/^\.workwise\/survey-drafts\/[^/]+\/exports-[a-f0-9]+\/[^/]+$/.test(file.path)
      || file.path.split('/')[2] !== draftId || !/\.(docx|pdf|xlsx|svg)$/i.test(file.path))) return null
  return receipt.data
}

export function SurveyReviewFlowPanel({ name, draftId, workspace, details, busy, error, onAction, onCancel, onReturn, onAdvanced }: {
  name: string; draftId: string; workspace?: string; details: SurveyReviewRunDetails | null; busy: boolean; error: boolean
  onAction: (action: Action, nodeId?: string) => void; onCancel: () => void; onReturn: () => void; onAdvanced: () => ReactElement
}): ReactElement {
  const { t } = useTranslation('common')
  const [fileError, setFileError] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const status = details?.run.status ?? 'loading'
  const latest = (id: string) => details?.nodeRuns.filter(node => node.nodeId === id).at(-1)
  const approval = latest('approval')
  const failed = details?.nodeRuns.filter(node => node.status === 'failed').at(-1)
  const receipt = surveyReviewExport(details, draftId)
  const active = ['queued', 'running', 'waiting_approval', 'paused', 'interrupted'].includes(status)
  const fileAction = async (path: string, save: boolean): Promise<void> => {
    if (!workspace) { setFileError(true); return }
    setFileBusy(true); setFileError(false)
    const result = save
      ? await saveGeneratedWorkspaceFileAs({ workspaceRoot: workspace, sourcePath: path, suggestedName: path.split('/').at(-1) })
      : await openGeneratedWorkspaceFile({ workspaceRoot: workspace, path })
    if (!result.ok && !('canceled' in result && result.canceled)) setFileError(true)
    setFileBusy(false)
  }
  return <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" aria-label={t('surveyReviewFlowTitle')}>
    <div className="mx-auto max-w-4xl space-y-4">
      <section className="rounded-lg border border-ds-border bg-ds-card p-4 sm:p-5">
        <h2 className="text-base font-semibold text-ds-ink">{t('surveyReviewFlowTitle')}</h2>
        <p className="mt-2 break-words text-sm text-ds-ink">{name}</p>
        <p className="mt-2 text-xs leading-5 text-ds-muted">{t('surveyReviewFlowDescription')}</p>
        <div role="status" aria-live="polite" className="mt-4 flex items-center gap-2 text-sm font-medium text-ds-ink">
          {status === 'succeeded' && receipt ? <CheckCircle2 className="h-4 w-4 text-green-700 dark:text-green-300" aria-hidden="true" /> : error || status === 'failed' ? <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-300" aria-hidden="true" /> : active || status === 'loading' ? <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden="true" /> : null}
          {t(`surveyReviewFlowStatus.${error ? 'unavailable' : status}`)}
        </div>
        <ol className="mt-4 grid gap-3 sm:grid-cols-3">
          {(['check', 'approval', 'export'] as const).map((id, index) => <li key={id} className="rounded-md border border-ds-border-muted bg-ds-main p-3">
            <p className="text-xs font-medium text-ds-ink">{index + 1}. {t(`surveyReviewFlowStep.${id}`)}</p>
            <p className="mt-2 text-xs text-ds-muted">{t(`surveyReviewFlowStepStatus.${latest(id)?.status ?? 'pending'}`)}</p>
          </li>)}
        </ol>
        {error || status === 'failed' ? <p role="alert" className="mt-3 text-xs leading-5 text-amber-700 dark:text-amber-300">{t('surveyReviewFlowRecovery')}</p> : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {approval?.status === 'waiting_approval' && status === 'waiting_approval' ? <>
            <button type="button" disabled={busy} onClick={() => onAction('approve', 'approval')} className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50">{t('surveyReviewFlowApprove')}</button>
            <button type="button" disabled={busy} onClick={() => onAction('reject', 'approval')} className="min-h-11 rounded-md border border-ds-border px-3 text-sm text-ds-muted disabled:opacity-50">{t('surveyReviewFlowReject')}</button>
          </> : null}
          {['interrupted', 'paused'].includes(status) ? <button type="button" disabled={busy} onClick={() => onAction('resume')} className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50">{t('surveyReviewFlowContinue')}</button> : null}
          {status === 'failed' && failed ? <button type="button" disabled={busy} onClick={() => onAction('retry', failed.nodeId)} className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-white disabled:opacity-50">{t('surveyReviewFlowRetry')}</button> : null}
          {status === 'failed' || status === 'cancelled' ? <button type="button" disabled={busy} onClick={onReturn} className="min-h-11 rounded-md border border-ds-border px-3 text-sm text-ds-ink disabled:opacity-50">{t('surveyReviewFlowReplan')}</button> : null}
          {active ? <button type="button" disabled={busy} onClick={onCancel} className="inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm text-ds-muted disabled:opacity-50"><Square className="h-3.5 w-3.5" aria-hidden="true" />{t('surveyReviewFlowCancel')}</button> : null}
          <button type="button" onClick={onReturn} className="min-h-11 rounded-md px-3 text-sm text-accent">{t('surveyReviewFlowReturn')}</button>
        </div>
      </section>
      {receipt ? <section className="rounded-lg border border-ds-border bg-ds-card p-4 sm:p-5" aria-label={t('surveyReviewFlowFiles')}>
        <h3 className="text-sm font-semibold text-ds-ink">{t('surveyReviewFlowFiles')}</h3>
        <p className="mt-2 text-xs leading-5 text-ds-muted">{t('surveyDraftUnsigned')}</p>
        <ul className="mt-3 divide-y divide-ds-border-muted">{receipt.files.map(file => <li key={file.path} className="flex flex-wrap items-center gap-2 py-2">
          <FileText className="h-4 w-4 text-accent" aria-hidden="true" /><span className="min-w-0 flex-1 text-sm text-ds-ink">{file.path.split('/').at(-1)}</span>
          <button type="button" disabled={fileBusy} onClick={() => void fileAction(file.path, false)} className="min-h-11 rounded-md border border-ds-border px-3 text-xs text-ds-ink disabled:opacity-50">{t('surveyReviewFlowOpenFile')}</button>
          <button type="button" disabled={fileBusy} onClick={() => void fileAction(file.path, true)} className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-xs text-accent disabled:opacity-50"><Download className="h-3.5 w-3.5" aria-hidden="true" />{t('surveyReviewFlowSaveFile')}</button>
        </li>)}</ul>
        {fileError ? <p role="alert" className="mt-2 text-xs text-amber-700 dark:text-amber-300">{t('surveyReviewFlowFileUnavailable')}</p> : null}
      </section> : null}
      <details className="rounded-lg border border-ds-border bg-ds-card px-4"><summary className="min-h-11 cursor-pointer py-3 text-xs font-medium text-ds-muted">{t('surveyReviewFlowAdvanced')}</summary>{onAdvanced()}</details>
    </div>
  </main>
}
