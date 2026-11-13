import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserTaskBindingSnapshot } from '../../../../../kun/src/contracts/browser-skill'

export function BrowserTaskBindingPanel({ taskId, onConfirmed }: { taskId: string; onConfirmed: (message: string) => void }) {
  const { t } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<BrowserTaskBindingSnapshot>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  useEffect(() => {
    let active = true
    void window.workwise.getBrowserTaskBinding(taskId).then(value => { if (active) setSnapshot(value) })
      .catch(error => { if (active) setError(String(error)) })
    return () => { active = false }
  }, [taskId])
  const confirm = async () => {
    if (!snapshot || pending) return
    setPending(true)
    setError('')
    try {
      await window.workwise.confirmBrowserTaskBinding(taskId, { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
        expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId,
        origins: snapshot.origins, interaction: snapshot.interaction, idempotencyKey: crypto.randomUUID() })
      setConfirmed(true)
      onConfirmed(t('browserTaskBindingConfirmed'))
    } catch (error) { setError(String(error)) }
    finally { setPending(false) }
  }
  return <div className="mt-3 rounded-lg border border-ds-border bg-ds-panel p-3 text-xs">
    <p>{t('browserTaskBindingReview')}</p>
    {snapshot ? <dl className="mt-2 grid grid-cols-[auto_1fr] gap-2">
      <dt>{t('browserSkillInstance')}</dt><dd>{snapshot.browserLabel}</dd>
      <dt>{t('browserSkillOrigins')}</dt><dd className="break-all whitespace-pre-wrap">{snapshot.origins.join('\n')}</dd>
      <dt>{t('capabilityRequestedScope')}</dt><dd>{t(snapshot.interaction === 'interact' ? 'browserSkillAllowInteraction' : 'browserTaskReadOnly')}</dd>
    </dl> : null}
    {snapshot?.previousInteraction === 'observe' && snapshot.interaction === 'interact' ? <p className="mt-2">{t('browserTaskInteractionExpansion')}</p> : null}
    {error ? <p role="alert" className="mt-2 break-all">{error}</p> : null}
    <button className="mt-3 rounded border border-ds-border px-3 py-1.5 disabled:opacity-50" disabled={!snapshot || pending || confirmed} onClick={() => void confirm()}>{t('browserTaskBindingConfirm')}</button>
  </div>
}
