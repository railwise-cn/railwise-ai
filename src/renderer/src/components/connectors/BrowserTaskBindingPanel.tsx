import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { redactSecretText } from '@shared/secret-redaction'
import type { BrowserTaskBindingSnapshot } from '../../../../../kun/src/contracts/browser-skill'
import { getRuntimeErrorCode } from '../../lib/format-runtime-error'

function bindingError(error: unknown, fallback: 'browserTaskBindingLoadFailed' | 'browserTaskBindingConfirmFailed') {
  const detail = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : getRuntimeErrorCode(error)
  const changed = ['conflict', 'stale_request', 'browser_binding_changed'].includes(code ?? '') ||
    /\b(?:conflict|stale_request|browser_binding_changed)\b/.test(detail)
  return { messageKey: changed ? 'browserTaskBindingChanged' : fallback, detail: redactSecretText(detail) }
}

export function BrowserTaskBindingPanel({ taskId, onConfirmed }: { taskId: string; onConfirmed: (message: string) => void }) {
  const { t } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<BrowserTaskBindingSnapshot>()
  const [pending, setPending] = useState(true)
  const [error, setError] = useState<ReturnType<typeof bindingError>>()
  const [confirmed, setConfirmed] = useState(false)
  const requestGeneration = useRef(0)
  const load = useCallback(async () => {
    const generation = ++requestGeneration.current
    setPending(true)
    setSnapshot(undefined)
    setError(undefined)
    setConfirmed(false)
    try {
      const value = await window.workwise.getBrowserTaskBinding(taskId)
      if (value.taskId !== taskId) throw new Error('browser_binding_changed')
      if (generation === requestGeneration.current) setSnapshot(value)
    } catch (error) {
      if (generation === requestGeneration.current) setError(bindingError(error, 'browserTaskBindingLoadFailed'))
    } finally {
      if (generation === requestGeneration.current) setPending(false)
    }
  }, [taskId])
  useEffect(() => {
    void load()
    return () => { requestGeneration.current += 1 }
  }, [load])
  const confirm = async () => {
    if (!snapshot || snapshot.taskId !== taskId || pending || confirmed) return
    const generation = ++requestGeneration.current
    setPending(true)
    setError(undefined)
    try {
      const result = await window.workwise.confirmBrowserTaskBinding(taskId, { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
        expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId,
        origins: snapshot.origins, interaction: snapshot.interaction, idempotencyKey: crypto.randomUUID() })
      if (generation !== requestGeneration.current) return
      if (result.binding.taskId !== taskId) throw new Error('browser_binding_changed')
      setConfirmed(true)
      onConfirmed(t('browserTaskBindingConfirmed'))
    } catch (error) {
      if (generation === requestGeneration.current) {
        setSnapshot(undefined)
        setError(bindingError(error, 'browserTaskBindingConfirmFailed'))
      }
    } finally {
      if (generation === requestGeneration.current) setPending(false)
    }
  }
  const currentSnapshot = snapshot?.taskId === taskId ? snapshot : undefined
  return <div aria-busy={pending} className="mt-3 rounded-lg border border-ds-border bg-ds-panel p-3 text-xs">
    <p>{t('browserTaskBindingReview')}</p>
    {pending && !currentSnapshot ? <p role="status" className="mt-2">{t('browserTaskBindingLoading')}</p> : null}
    {currentSnapshot ? <dl className="mt-2 grid grid-cols-[auto_1fr] gap-2">
      <dt>{t('browserSkillInstance')}</dt><dd>{currentSnapshot.browserLabel}</dd>
      <dt>{t('browserSkillOrigins')}</dt><dd className="break-all whitespace-pre-wrap">{currentSnapshot.origins.join('\n')}</dd>
      <dt>{t('capabilityRequestedScope')}</dt><dd>{t(currentSnapshot.interaction === 'interact' ? 'browserSkillAllowInteraction' : 'browserTaskReadOnly')}</dd>
    </dl> : null}
    {currentSnapshot?.previousInteraction === 'observe' && currentSnapshot.interaction === 'interact' ? <p className="mt-2">{t('browserTaskInteractionExpansion')}</p> : null}
    {error ? <>
      <p role="alert" className="mt-2">{t(error.messageKey)}</p>
      <button type="button" className="mt-2 rounded border border-ds-border px-3 py-1.5 disabled:opacity-50" disabled={pending} onClick={() => void load()}>{t('browserTaskBindingReload')}</button>
      <details className="mt-2 text-ds-muted">
        <summary className="cursor-pointer">{t('browserSkillDiagnostics')}</summary>
        <pre className="mt-2 whitespace-pre-wrap break-all">{error.detail}</pre>
      </details>
    </> : null}
    <button type="button" className="mt-3 rounded border border-ds-border px-3 py-1.5 disabled:opacity-50" disabled={!currentSnapshot || pending || confirmed} onClick={() => void confirm()}>{t('browserTaskBindingConfirm')}</button>
  </div>
}
