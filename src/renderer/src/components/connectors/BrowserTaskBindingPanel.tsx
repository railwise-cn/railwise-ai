import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { redactSecretText } from '@shared/secret-redaction'
import type { BrowserTaskBindingSnapshot } from '../../../../../kun/src/contracts/browser-skill'
import { getRuntimeErrorCode } from '../../lib/format-runtime-error'
import { requestTaskDetail } from '../../store/task-live-store'
import { useChatStore } from '../../store/chat-store'

type VerificationPolicy = 'strict' | 'public_query_target'
const policyValue = (value: unknown): VerificationPolicy => value === 'public_query_target' ? value : 'strict'
function allowedPolicies(snapshot: BrowserTaskBindingSnapshot): VerificationPolicy[] {
  return [...new Set(snapshot.allowedVerificationPolicies?.filter(value => value === 'strict' || value === 'public_query_target') ?? ['strict'])]
}

function bindingError(error: unknown, fallback: 'browserTaskBindingLoadFailed' | 'browserTaskBindingConfirmFailed') {
  const detail = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : getRuntimeErrorCode(error)
  const changed = ['conflict', 'stale_request', 'browser_binding_changed'].includes(code ?? '') ||
    /\b(?:conflict|stale_request|browser_binding_changed)\b/.test(detail)
  const blocked = ['browser_verification_policy_blocked', 'browser_unresolved_operation'].find(value => code === value || new RegExp(`\\b${value}\\b`).test(detail))
  return { messageKey: blocked === 'browser_unresolved_operation' ? 'browserTaskUnresolvedOperation'
    : blocked ? 'browserTaskVerificationPolicyBlocked' : changed ? 'browserTaskBindingChanged' : fallback,
  detail: redactSecretText(detail), unresolved: blocked === 'browser_unresolved_operation' }
}

export function BrowserTaskBindingPanel({ taskId, onConfirmed }: { taskId: string; onConfirmed: (message: string) => void }) {
  const { t } = useTranslation('common')
  const [snapshot, setSnapshot] = useState<BrowserTaskBindingSnapshot>()
  const [pending, setPending] = useState(true)
  const [error, setError] = useState<ReturnType<typeof bindingError>>()
  const [confirmed, setConfirmed] = useState(false)
  const [verificationPolicy, setVerificationPolicy] = useState<VerificationPolicy>('strict')
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const requestGeneration = useRef(0)
  const load = useCallback(async () => {
    const generation = ++requestGeneration.current
    setPending(true)
    setSnapshot(undefined)
    setError(undefined)
    setConfirmed(false)
    setVerificationPolicy('strict')
    setShowDiagnostics(false)
    try {
      const value = await window.workwise.getBrowserTaskBinding(taskId)
      if (value.taskId !== taskId) throw new Error('browser_binding_changed')
      if (generation === requestGeneration.current) {
        const policies = allowedPolicies(value)
        if (!policies.length) throw new Error('browser_verification_policy_blocked')
        const current = policyValue(value.verificationPolicy)
        const recommended = policyValue(value.policyChangeBlocked ? value.verificationPolicy : value.recommendedVerificationPolicy)
        setVerificationPolicy(policies.includes(recommended) ? recommended : policies.includes(current) ? current : policies[0])
        setSnapshot(value)
      }
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
    if (!snapshot || snapshot.taskId !== taskId || pending || confirmed || !allowedPolicies(snapshot).includes(verificationPolicy)) return
    const generation = ++requestGeneration.current
    setPending(true)
    setError(undefined)
    try {
      const result = await window.workwise.confirmBrowserTaskBinding(taskId, { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
        expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId,
        origins: snapshot.origins, interaction: snapshot.interaction, verificationPolicy, idempotencyKey: crypto.randomUUID() })
      if (generation !== requestGeneration.current) return
      if (result.resumed !== false || result.binding.taskId !== taskId || result.binding.browserInstanceId !== snapshot.browserInstanceId ||
        result.binding.browserRevision !== snapshot.browserRevision || result.binding.taskRevision < snapshot.taskRevision ||
        result.binding.interaction !== snapshot.interaction || JSON.stringify([...result.binding.origins].sort()) !== JSON.stringify([...snapshot.origins].sort()) ||
        policyValue(result.binding.verificationPolicy) !== verificationPolicy) throw new Error('browser_binding_changed')
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
  const policyBlocked = currentSnapshot?.policyChangeBlocked === 'browser_unresolved_operation' || error?.unresolved
  const openOriginalTask = () => { requestTaskDetail(taskId); useChatStore.getState().setRoute('tasks') }
  return <div aria-busy={pending} className="mt-3 rounded-lg border border-ds-border bg-ds-panel p-3 text-xs">
    <p>{t('browserTaskBindingReview')}</p>
    {pending && !currentSnapshot ? <p role="status" className="mt-2">{t('browserTaskBindingLoading')}</p> : null}
    {currentSnapshot ? <dl className="mt-2 grid grid-cols-[auto_1fr] gap-2">
      <dt>{t('browserSkillInstance')}</dt><dd>{currentSnapshot.browserLabel}</dd>
      <dt>{t('browserSkillOrigins')}</dt><dd className="break-all whitespace-pre-wrap">{currentSnapshot.origins.join('\n')}</dd>
      {currentSnapshot.purpose ? <><dt>{t('browserTaskPurpose')}</dt><dd className="whitespace-pre-wrap break-words">{currentSnapshot.purpose}</dd></> : null}
      <dt>{t('capabilityRequestedScope')}</dt><dd>{t(currentSnapshot.interaction === 'interact' ? 'browserSkillAllowInteraction' : 'browserTaskReadOnly')}</dd>
      <dt><label htmlFor={`browser-policy-${taskId}`}>{t('browserTaskVerificationPolicy')}</label></dt><dd>
        <select id={`browser-policy-${taskId}`} aria-label={t('browserTaskVerificationPolicy')} value={verificationPolicy}
          disabled={pending || confirmed || Boolean(policyBlocked) || allowedPolicies(currentSnapshot).length < 2}
          onChange={event => { const value = policyValue(event.target.value); if (allowedPolicies(currentSnapshot).includes(value)) setVerificationPolicy(value) }}
          className="rounded border border-ds-border bg-ds-card px-2 py-1 text-ds-ink disabled:opacity-70">
          <option value="strict" disabled={!allowedPolicies(currentSnapshot).includes('strict')}>{t('browserTaskPolicyStrict')}</option>
          <option value="public_query_target" disabled={!allowedPolicies(currentSnapshot).includes('public_query_target')}>{t('browserTaskPolicyPublicQuery')}</option>
        </select>
        <p className="mt-1 leading-relaxed">{t(verificationPolicy === 'public_query_target' ? 'browserTaskPolicyPublicQueryDescription' : 'browserTaskPolicyStrictDescription')}</p>
        <p className="mt-1 text-ds-muted">{t(confirmed ? 'browserTaskBindingConfirmed' : 'browserTaskPolicyNotApplied')}</p>
      </dd>
    </dl> : null}
    {currentSnapshot?.previousInteraction === 'observe' && currentSnapshot.interaction === 'interact' ? <p className="mt-2">{t('browserTaskInteractionExpansion')}</p> : null}
    {error ? <>
      <p role="alert" className="mt-2">{t(error.messageKey)}</p>
      <button type="button" className="mt-2 rounded border border-ds-border px-3 py-1.5 disabled:opacity-50" disabled={pending} onClick={() => void load()}>{t('browserTaskBindingReload')}</button>
    </> : null}
    {policyBlocked ? <>
      {!error?.unresolved ? <p role="status" className="mt-2">{t('browserTaskUnresolvedOperation')}</p> : null}
      <button type="button" className="mt-2 rounded border border-ds-border px-3 py-1.5" onClick={openOriginalTask}>{t('browserTaskOpenOriginalReview')}</button>
    </> : null}
    {currentSnapshot || error ? <details className="mt-2 text-ds-muted" onToggle={event => setShowDiagnostics(event.currentTarget.open)}>
      <summary className="cursor-pointer">{t('browserSkillDiagnostics')}</summary>
      {error ? <pre className="mt-2 whitespace-pre-wrap break-all">{error.detail}</pre> : null}
      {currentSnapshot && showDiagnostics ? <code className="mt-2 block break-all">verificationPolicy: {verificationPolicy}</code> : null}
    </details> : null}
    <button type="button" className="mt-3 rounded border border-ds-border px-3 py-1.5 disabled:opacity-50" disabled={!currentSnapshot || pending || confirmed} onClick={() => void confirm()}>{t('browserTaskBindingConfirm')}</button>
  </div>
}
