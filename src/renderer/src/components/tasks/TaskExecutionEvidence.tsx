import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskOperationReceiptV1, TaskOperationVerificationV1, TaskResultEvidenceV1, TaskRunV1 } from '@shared/agent-workbench'

function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

export function TaskExecutionEvidence({ task, relatedTasks, receipts, onVerify, onConfigureProvider }: {
  task: TaskRunV1
  relatedTasks: TaskRunV1[]
  receipts: TaskOperationReceiptV1[]
  onVerify?: (receipt: TaskOperationReceiptV1) => Promise<TaskOperationVerificationV1>
  onConfigureProvider?: (provider: string) => void
}): ReactElement | null {
  const { t } = useTranslation('common')
  const [verifying, setVerifying] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, string>>({})
  const verify = async (receipt: TaskOperationReceiptV1): Promise<void> => {
    if (!onVerify || verifying) return
    setVerifying(receipt.id)
    setMessages(current => ({ ...current, [receipt.id]: '' }))
    try {
      const result = await onVerify(receipt)
      setMessages(current => ({ ...current, [receipt.id]: result.status === 'verified' ? t('taskEffectReadbackVerified') : `${t('taskEffectReadbackUnconfirmed')}${result.errorCode ? ` (${result.errorCode})` : ''}` }))
    } catch (error) { setMessages(current => ({ ...current, [receipt.id]: error instanceof Error ? error.message : String(error) })) }
    finally { setVerifying(null) }
  }
  const effect = task.acceptance.effect
  const evidence = [...new Map(relatedTasks.flatMap(item => item.resultEvidence ?? []).map(item =>
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
  return <section aria-label={t('taskEffectExecution')} className="mb-4 rounded-xl border border-ds-border bg-ds-card p-3">
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
    <h4 className="mt-3 text-xs font-semibold text-ds-muted">{t('taskEffectReceipts')} ({receipts.length})</h4>
    {receipts.length ? <ul className="mt-2 space-y-2">{receipts.map(receipt => <li key={receipt.id} className="rounded-lg border border-ds-border p-2 text-xs">
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
  </section>
}
