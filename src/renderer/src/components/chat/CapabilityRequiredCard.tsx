import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExternalTaskCapabilityCard } from '@shared/task-command'
import type { ManagedToolResult } from '@shared/workwise-api'
import { useChatStore } from '../../store/chat-store'

type LoginStartResult = { ok: true; verificationUrl: string; userCode: string; expiresAt: string } | { ok: false; message: string }
type LoginApi = {
  beginManagedLarkLogin?: () => Promise<LoginStartResult>
  completeManagedLarkLogin?: () => Promise<ManagedToolResult>
}

/** A capability failure is a durable waiting task, never a completed answer. */
export function CapabilityRequiredCard({ card }: { card: ExternalTaskCapabilityCard }): ReactElement {
  const { t } = useTranslation('common')
  const openPlugins = useChatStore((state) => state.openPlugins)
  const openSettings = useChatStore((state) => state.openSettings)
  const chooseWorkspace = useChatStore((state) => state.chooseWorkspace)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [login, setLogin] = useState<Extract<LoginStartResult, { ok: true }> | null>(null)
  const [settled, setSettled] = useState(false)
  const [managedState, setManagedState] = useState<string | null>(null)
  const [capability, setCapability] = useState(card.capability)
  const isLark = capability.provider === 'lark' || capability.provider === 'feishu'
  const action = capability.resolution ?? capability.action
  const loginApi: LoginApi = typeof window === 'undefined' ? {} : window.workwise as typeof window.workwise & LoginApi
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (pending) return
    setPending(true)
    setMessage('')
    try { await operation() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setPending(false) }
  }
  const managed = async (install: boolean): Promise<void> => {
    const result = await (install ? window.workwise.installManagedTool('lark-cli') : window.workwise.diagnoseManagedTool('lark-cli'))
    if (!result.ok) throw new Error(result.message)
    setManagedState(result.status.state)
    setMessage(result.status.message ?? t(`capabilityManaged_${result.status.state}`))
  }
  const recheck = async (): Promise<void> => {
    const result = await window.workwise.coordinateTaskCommand({
      threadId: card.threadId, taskId: card.taskId, resolveAttentionId: card.attentionId,
      intent: 'resume', idempotencyKey: crypto.randomUUID(), request: { prompt: card.prompt }
    })
    if (result.kind === 'capability_required' || result.kind === 'attention_required') {
      if (result.kind === 'capability_required') setCapability(result.capability)
      setMessage(result.message)
    } else {
      setSettled(true)
      setMessage(result.kind === 'snapshot' ? t('capabilityStateChecked') : t('capabilityResumed'))
    }
    // Refresh only the original conversation. Never switch a user away from
    // another conversation while a delayed authorization finishes.
    const store = useChatStore.getState()
    await store.refreshThreads()
    if (store.activeThreadId === card.threadId) await store.selectThread(card.threadId)
  }
  const beginLogin = async (): Promise<void> => {
    if (!loginApi.beginManagedLarkLogin) throw new Error(t('capabilityLoginUnavailable'))
    const result = await loginApi.beginManagedLarkLogin()
    if (!result.ok) throw new Error(result.message)
    setLogin(result)
    // The main-process login service validates the official authorization URL.
    await window.workwise.openExternal(result.verificationUrl)
  }
  const finishLogin = async (): Promise<void> => {
    if (!loginApi.completeManagedLarkLogin) throw new Error(t('capabilityLoginUnavailable'))
    const result = await loginApi.completeManagedLarkLogin()
    if (!result.ok) throw new Error(result.message)
    setLogin(null)
    setMessage(result.status.state === 'installed' ? t('capabilityLoginReady') : result.status.message ?? t('capabilityLoginIncomplete'))
    // Login does not silently resume or authorize the queued external action.
  }
  const decline = async (): Promise<void> => {
    const result = await window.workwise.coordinateTaskCommand({
      threadId: card.threadId, taskId: card.taskId, intent: 'cancel',
      idempotencyKey: crypto.randomUUID(), request: { prompt: t('capabilityDeclined') }
    })
    if (result.kind !== 'task_updated' || result.action !== 'cancel') throw new Error(t('capabilityCancelFailed'))
    setSettled(true)
    setMessage(t('capabilityDeclined'))
  }
  return (
    <section aria-label={t('capabilityRequiredTitle')} className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-ds-ink dark:border-amber-800 dark:bg-zinc-900">
      <div className="font-semibold">{t(settled ? 'capabilityStateChecked' : 'capabilityRequiredTitle')}</div>
      <p className="mt-1 whitespace-pre-wrap">{capability.message}</p>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-ds-muted">{t('capabilityProvider')}</dt><dd>{isLark ? t('capabilityLark') : t('capabilityDingTalk')}</dd>
        <dt className="text-ds-muted">{t('capabilityCurrentStatus')}</dt><dd>{t(`capabilityStatus_${capability.status}`)}</dd>
        <dt className="text-ds-muted">{t('capabilityWorkspace')}</dt><dd className="break-all">{capability.workspaceRoot || t('capabilityWorkspaceUnknown')}</dd>
        <dt className="text-ds-muted">{t('capabilityRequestedScope')}</dt><dd>{capability.requiredScopes?.join(', ') || t('capabilityScopeNotGranted')}</dd>
      </dl>
      {login ? <div role="status" className="mt-3 rounded-lg border border-ds-border bg-ds-surface p-3">
        <p>{t('capabilityLoginCode', { code: login.userCode })}</p>
        <p className="mt-1 text-xs text-ds-muted">{t('capabilityLoginExpires', { expiresAt: new Date(login.expiresAt).toLocaleString() })}</p>
        <button type="button" disabled={pending} onClick={() => void run(finishLogin)} className="mt-2 rounded-md border border-ds-border px-3 py-1.5 disabled:opacity-50">{t('capabilityLoginCompleted')}</button>
      </div> : null}
      {message ? <p role="status" className="mt-3 whitespace-pre-wrap text-xs">{message}</p> : null}
      {!settled ? <div className="mt-3 flex flex-wrap gap-2 [&_button]:rounded-md [&_button]:border [&_button]:border-ds-border [&_button]:px-3 [&_button]:py-1.5 [&_button:disabled]:opacity-50">
        {isLark && capability.status === 'not_installed' && (!managedState || managedState === 'not_installed') ? <button type="button" disabled={pending} onClick={() => void run(() => managed(true))}>{t('capabilityInstallLark')}</button> : null}
        {isLark ? <>
          <button type="button" disabled={pending} onClick={() => void run(() => managed(false))}>{t('capabilityDiagnose')}</button>
          {(capability.status !== 'not_installed' || managedState === 'needs_login' || managedState === 'installed') && loginApi.beginManagedLarkLogin ? <button type="button" disabled={pending} onClick={() => void run(beginLogin)}>{t('capabilityLoginLark')}</button> : null}
        </> : null}
        <button type="button" disabled={pending} onClick={() => {
          if (action?.kind === 'switch_workspace') void run(async () => { await chooseWorkspace({ createThreadAfter: false, selectThreadAfter: false }) })
          else if (isLark) openPlugins()
          else openSettings('general')
        }}>{t(isLark ? 'capabilityOpenMarketplace' : 'capabilityConfigureDingTalk')}</button>
        <button type="button" disabled={pending} onClick={() => void run(recheck)}>{t('capabilityRecheckResume')}</button>
        <button type="button" disabled={pending} onClick={() => void run(decline)}>{t('capabilityDecline')}</button>
      </div> : null}
    </section>
  )
}
