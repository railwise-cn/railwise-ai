import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskOperationReceiptV1, TaskOperationVerificationV1, TaskResultEvidenceV1, TaskRunV1 } from '@shared/agent-workbench'
import { BrowserOperationEvidence } from './BrowserOperationEvidence'

function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

export function TaskExecutionEvidence({ task, relatedTasks, receipts, onVerify, onConfirmBrowser, onConfigureProvider, onConfigureReplyDelivery }: {
  task: TaskRunV1
  relatedTasks: TaskRunV1[]
  receipts: TaskOperationReceiptV1[]
  onVerify?: (receipt: TaskOperationReceiptV1) => Promise<TaskOperationVerificationV1>
  onConfirmBrowser?: (receipt: TaskOperationReceiptV1, reviewId: string, decision: 'completed' | 'not_completed') => Promise<TaskOperationVerificationV1>
  onConfigureProvider?: (provider: string) => void
  onConfigureReplyDelivery?: () => void
}): ReactElement | null {
  const { t } = useTranslation('common')
  const [verifying, setVerifying] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, string>>({})
  const pollAttempts = useRef(new Map<string, number>())
  const verify = useCallback(async (receipt: TaskOperationReceiptV1): Promise<void> => {
    if (!onVerify || verifying) return
    setVerifying(receipt.id)
    setMessages(current => ({ ...current, [receipt.id]: '' }))
    try {
      const result = await onVerify(receipt)
      setMessages(current => ({ ...current, [receipt.id]: result.shell?.message ?? (result.status === 'verified' ? t('taskEffectReadbackVerified') : `${t('taskEffectReadbackUnconfirmed')}${result.errorCode ? ` (${result.errorCode})` : ''}`) }))
    } catch (error) { setMessages(current => ({ ...current, [receipt.id]: error instanceof Error ? error.message : String(error) })) }
    finally { setVerifying(null) }
  }, [onVerify, t, verifying])
  useEffect(() => {
    if (verifying || !onVerify) return
    const receipt = receipts.find(item => item.purpose === 'host_shell' && item.shell?.canPoll && ['running', 'outcome_unknown'].includes(item.status) && (pollAttempts.current.get(item.id) ?? 0) < 10)
    if (!receipt) return
    const timer = window.setTimeout(() => {
      pollAttempts.current.set(receipt.id, (pollAttempts.current.get(receipt.id) ?? 0) + 1)
      void verify(receipt)
    }, 2000)
    return () => window.clearTimeout(timer)
  }, [receipts, verifying, onVerify, verify])
  const hostShell = receipts.filter(receipt => receipt.purpose === 'host_shell')
  const deliveries = receipts.filter(receipt => receipt.purpose === 'assistant_reply')
  const browser = receipts.filter(receipt => receipt.purpose === 'browser_action' && (receipt.status === 'outcome_unknown' || receipt.resolution))
  const effects = receipts.filter(receipt => receipt.purpose !== 'assistant_reply' && receipt.purpose !== 'host_shell' && receipt.purpose !== 'browser_action')
  const effect = task.acceptance.effect
  const evidence = [...new Map(relatedTasks.flatMap(item => item.resultEvidence ?? []).filter(item => !(item.provider === 'browser-skill' && item.kind === 'human_confirmation')).map(item =>
    [JSON.stringify([item.provider, item.operation, item.target, item.resultHash]), item] as const)).values()]
  if (!effect && !evidence.length && !receipts.length) return null
  const provider = (name: string) => t(`taskEffectProvider_${name}`, { defaultValue: name })
  const operation = (name: string) => t(`taskEffectOperation_${name}`, { defaultValue: name })
  const evidenceDetails = (item: TaskResultEvidenceV1): ReactElement => <details className="mt-2 text-[11px] text-ds-muted">
    <summary className="cursor-pointer">{t('taskEffectVerificationDetails')}</summary>
    <dl className="mt-2 space-y-1 break-all">
      <div><dt className="inline font-medium">{t('taskEffectRemoteStatus')}: </dt><dd className="inline">{item.status}</dd></div>
      {item.remoteOperationId ? <div><dt className="inline font-medium">{t('taskEffectRemoteOperation')}: </dt><dd className="inline">{item.remoteOperationId}</dd></div> : null}
      <div><dt className="inline font-medium">{t('taskEffectResultHash')}: </dt><dd className="inline">{item.resultHash}</dd></div>
      {item.sourceVersion ? <div><dt className="inline font-medium">{t('taskEffectSourceVersion')}: </dt><dd className="inline">{item.sourceVersion}</dd></div> : null}
      {item.targetVersion ? <div><dt className="inline font-medium">{t('taskEffectTargetVersion')}: </dt><dd className="inline">{item.targetVersion}</dd></div> : null}
    </dl>
  </details>
  return <>{browser.length ? <section aria-label={t('taskBrowserEvidence')} className="mb-4 rounded-xl border border-ds-border bg-ds-card p-3"><h3 className="text-xs font-semibold">{t('taskBrowserEvidence')}</h3><ul className="mt-2 space-y-2">{browser.map(receipt => <BrowserOperationEvidence key={receipt.id} receipt={receipt} ended={['completed', 'failed', 'cancelled'].includes(relatedTasks.find(item => item.id === receipt.taskId)?.status ?? task.status)} onVerify={onVerify} onConfirm={onConfirmBrowser} onConfigure={onConfigureProvider ? () => onConfigureProvider('browser-skill') : undefined} />)}</ul></section> : null}{hostShell.length ? <section aria-label={t('taskHostShellEvidence')} className="mb-4 rounded-xl border border-ds-border bg-ds-card p-3">
    <h3 className="text-xs font-semibold">{t('taskHostShellEvidence')}</h3>
    <ul className="mt-2 space-y-2">{hostShell.map(receipt => <li key={receipt.id} className="rounded-lg bg-ds-main p-2 text-xs">
      <p className={receipt.status === 'failed' ? 'text-red-700 dark:text-red-300' : 'text-ds-muted'}>{t(receipt.status === 'succeeded' && receipt.shell?.exitCode === 0 ? 'taskHostShellSucceeded' : `taskReceiptStatus_${receipt.status}`)}{receipt.shell?.exitCode !== undefined ? ` · ${t('taskHostShellExitCode')} ${receipt.shell.exitCode}` : ''}</p>
      {messages[receipt.id] || receipt.shell?.message ? <p role="status" className="mt-1 text-ds-muted">{messages[receipt.id] || receipt.shell?.message}</p> : null}
      {onVerify && ['running', 'outcome_unknown', 'prepared'].includes(receipt.status) ? <button type="button" disabled={verifying !== null} onClick={() => { pollAttempts.current.set(receipt.id, 0); void verify(receipt) }} className="mt-2 rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t(verifying === receipt.id ? 'taskEffectVerifying' : 'taskHostShellReadback')}</button> : null}
      <details className="mt-2 text-ds-muted"><summary className="cursor-pointer">{t('taskEffectReceiptDetails')}</summary><p className="mt-1 break-all">{receipt.id}</p>{receipt.shell?.outputSha256 ? <p className="break-all">SHA256 {receipt.shell.outputSha256}</p> : null}</details>
    </li>)}</ul>
  </section> : null}{effect || evidence.length || effects.length ? <section aria-label={t('taskEffectExecution')} className="mb-4 rounded-xl border border-ds-border bg-ds-card p-3">
    <h3 className="text-xs font-semibold">{t('taskEffectExecution')}</h3>
    {effect ? <div className="mt-2 text-xs">
      <p><span className="text-ds-muted">{t('taskEffectProvider')}: </span>{provider(effect.provider)}</p>
      {effect.requiredEffects?.length ? <ul className="mt-2 space-y-1">{effect.requiredEffects.map((item, index) => <li key={`${item.provider}:${item.operation}:${item.target}:${index}`} className="break-all">{operation(item.operation)} · {item.target}</li>)}</ul>
        : <p className="mt-1 break-all"><span className="text-ds-muted">{t('taskEffectTarget')}: </span>{effect.target ? `${operation(effect.operation)} · ${effect.target}` : t('taskEffectTargetPending')}</p>}
    </div> : null}
    <h4 className="mt-3 text-xs font-semibold text-ds-muted">{t('taskEffectEvidence')}</h4>
    {evidence.length ? <ul className="mt-2 space-y-2">{evidence.map((item, index) => <li key={`${item.provider}:${item.target}:${item.resultHash}:${index}`} className="rounded-lg bg-ds-main p-2 text-xs">
      <p className="break-all">{provider(item.provider)} · {operation(item.operation)} · {item.target}</p>
      <p className={`mt-1 ${item.verified ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>{t(item.verified ? 'taskEffectVerified' : 'taskEffectUnverified')} · {dateLabel(item.verifiedAt)}</p>
      {evidenceDetails(item)}
    </li>)}</ul> : <p className="mt-1 text-xs text-ds-muted">{t('taskEffectNoEvidence')}</p>}
    <h4 className="mt-3 text-xs font-semibold text-ds-muted">{t('taskEffectReceipts')} ({effects.length})</h4>
    {effects.length ? <ul className="mt-2 space-y-2">{effects.map(receipt => <li key={receipt.id} className="rounded-lg border border-ds-border p-2 text-xs">
      <p className="break-all">{provider(receipt.provider)} · {operation(receipt.operation)} · {receipt.target || t('taskEffectTargetPending')}</p>
      <p className={`mt-1 ${receipt.status === 'failed' ? 'text-red-700 dark:text-red-300' : receipt.status === 'outcome_unknown' && !receipt.resolution ? 'text-amber-700 dark:text-amber-300' : 'text-ds-muted'}`}>{t(receipt.resolution ? 'taskEffectReadbackVerified' : receipt.status === 'succeeded' && receipt.evidence?.verified ? 'taskEffectVerified' : `taskReceiptStatus_${receipt.status}`)} · {dateLabel(receipt.resolution?.resolvedAt ?? receipt.updatedAt)}</p>
      {receipt.errorCode ? <p className="mt-1 break-all text-ds-muted">{t('taskEffectErrorCode')}: {receipt.errorCode}</p> : null}
      {receipt.status === 'failed' ? <p className="mt-1 text-ds-muted">{t('taskEffectFailedRetryGuidance')}</p> : null}
      {receipt.remoteOperationId && !receipt.evidence?.remoteOperationId ? <p className="mt-1 break-all text-ds-muted">{t('taskEffectRemoteOperation')}: {receipt.remoteOperationId}</p> : null}
      {receipt.status === 'outcome_unknown' && !receipt.resolution ? <>
        <p className="mt-1 text-amber-700 dark:text-amber-300">{t('taskEffectUnknownGuidance')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {onVerify && !['cancelled', 'completed', 'failed'].includes(relatedTasks.find(item => item.id === receipt.taskId)?.status ?? task.status) ? <button type="button" disabled={verifying !== null} onClick={() => void verify(receipt)} className="rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t(verifying === receipt.id ? 'taskEffectVerifying' : 'taskEffectVerifyResult')}</button> : null}
          {onConfigureProvider ? <button type="button" onClick={() => onConfigureProvider(receipt.provider)} className="rounded-md border border-ds-border px-3 py-1.5">{t('taskEffectConfigureProvider')}</button> : null}
        </div>
      </> : null}
      {messages[receipt.id] ? <p role="status" className="mt-2 text-ds-muted">{messages[receipt.id]}</p> : null}
      {receipt.evidence ? evidenceDetails(receipt.evidence) : null}
      {receipt.resolution ? <><p className="mt-1 text-ds-muted">{t('taskEffectOriginalUnknownPreserved')}</p>{evidenceDetails(receipt.resolution.evidence)}</> : null}
      <details className="mt-2 text-[11px] text-ds-muted"><summary className="cursor-pointer">{t('taskEffectReceiptDetails')}</summary><dl className="mt-2 space-y-1 break-all"><div><dt className="inline font-medium">{t('taskEffectReceiptReference')}: </dt><dd className="inline">{receipt.id}</dd></div><div><dt className="inline font-medium">{t('taskEffectRequestHash')}: </dt><dd className="inline">{receipt.requestHash}</dd></div></dl></details>
    </li>)}</ul> : <p className="mt-1 text-xs text-ds-muted">{t('taskEffectNotExecuted')}</p>}
  </section> : null}
    {deliveries.length ? <section aria-label={t('taskReplyDelivery')} className="mb-4 rounded-xl border border-ds-border bg-ds-card p-3">
      <h3 className="text-xs font-semibold">{t('taskReplyDelivery')}</h3>
      <ul className="mt-2 space-y-2">{deliveries.map(receipt => <li key={receipt.id} className="rounded-lg border border-ds-border p-2 text-xs">
        <p>{receipt.provider === 'feishu' ? provider('lark') : t('taskReplyWeixin')} · {t(receipt.phase === 'upload' ? 'taskReplyAttachment' : 'taskReplyMessage')}</p>
        <p className="mt-1 text-ds-muted">{t(receipt.status === 'succeeded' ? 'taskReplyAccepted' : receipt.status === 'outcome_unknown' ? 'taskReplyUnknown' : `taskReceiptStatus_${receipt.status}`)} · {dateLabel(receipt.updatedAt)}</p>
        {receipt.status === 'outcome_unknown' ? <p className="mt-1 text-amber-700 dark:text-amber-300">{t('taskReplyCheckPlatform')}</p> : null}
        {receipt.remoteOperationId ? <details className="mt-2 text-ds-muted"><summary className="cursor-pointer">{t('taskEffectReceiptDetails')}</summary><p className="mt-1 break-all">{receipt.remoteOperationId}</p></details> : null}
      </li>)}</ul>
      {onConfigureReplyDelivery ? <button type="button" onClick={onConfigureReplyDelivery} className="mt-3 rounded-md border border-ds-border px-3 py-1.5 text-xs">{t('taskReplyConfigure')}</button> : null}
    </section> : null}
  </>
}
