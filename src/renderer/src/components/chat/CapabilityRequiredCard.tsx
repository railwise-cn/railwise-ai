import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { ExternalTaskCapabilityCard } from '@shared/task-command'
import { ManagedLarkConnection } from '../connectors/ManagedLarkConnection'
import { ManagedDingTalkConnection } from '../connectors/ManagedDingTalkConnection'
import { BrowserTaskBindingPanel } from '../connectors/BrowserTaskBindingPanel'
import { ManagedBrowserSkillConnection } from '../connectors/ManagedBrowserSkillConnection'
import { TaskPermissionPanel } from './TaskPermissionPanel'
import { requestFlowDetail } from '../../store/flow-navigation'
import { useChatStore, type SettingsRouteSection } from '../../store/chat-store'

/** A capability failure is a durable waiting task, never a completed answer. */
export function CapabilityRequiredCard({ card }: { card: ExternalTaskCapabilityCard }): ReactElement {
  const { t } = useTranslation('common')
  const openFlow = useChatStore((state) => state.openFlow)
  const openPlugins = useChatStore((state) => state.openPlugins)
  const openSettings = useChatStore((state) => state.openSettings)
  const chooseWorkspace = useChatStore((state) => state.chooseWorkspace)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [settled, setSettled] = useState(false)
  const [capability, setCapability] = useState(card.capability)
  const [showPermissions, setShowPermissions] = useState(false)
  const [showBrowserBinding, setShowBrowserBinding] = useState(false)
  const [browserBindingGeneration, setBrowserBindingGeneration] = useState(0)
  const isLark = capability.provider === 'lark' || capability.provider === 'feishu'
  const isDingTalk = capability.provider === 'dingtalk'
  const isBrowser = capability.provider === 'browser-skill'
  const connector = isBrowser ? 'browser-skill' : isLark ? 'lark' : isDingTalk ? 'dingtalk' : undefined
  const action = capability.resolution ?? capability.action
  const configure = (): void => {
    if (action?.kind === 'switch_workspace') {
      void run(async () => { await chooseWorkspace({ createThreadAfter: false, selectThreadAfter: false }) })
      return
    }
    const route = action?.route ?? ''
    if (capability.provider === 'schedule' && route === 'task/schedule-review') {
      void run(recheck)
      return
    }
    if (capability.provider === 'schedule' && route.startsWith('flow/')) {
      requestFlowDetail({ flowId: route.slice('flow/'.length) })
      openFlow()
      return
    }
    if (isBrowser && capability.errorCode === 'browser_origin_scope_required') {
      openPlugins(undefined, 'browser-skill')
      return
    }
    if (isBrowser && (action?.route === 'task/browser-binding' || ['browser_binding_changed', 'browser_interaction_scope_required'].includes(capability.errorCode ?? ''))) { setShowBrowserBinding(true); return }
    if (action?.kind === 'grant') {
      setShowPermissions(true)
      return
    }
    if (action?.kind === 'connect' || action?.kind === 'install' || (!action && capability.provider === 'dingtalk')) {
      openPlugins(undefined, connector)
      return
    }
    if (route === 'settings' || route.startsWith('settings/')) {
      // Account setup and task authority are separate. A connector page cannot
      // widen an existing task's execution grant.
      const section = route.slice('settings/'.length)
      const sections: SettingsRouteSection[] = ['general', 'providers', 'write', 'imageGeneration', 'agents', 'skill', 'mcp', 'shortcuts', 'claw', 'help']
      openSettings(sections.includes(section as SettingsRouteSection) ? section as SettingsRouteSection
          : capability.errorCode === 'agent_tool_blocked' ? 'agents' : 'general')
      return
    }
    if (route === 'marketplace' || connector) openPlugins(undefined, connector)
    else openSettings('general')
  }
  const execution = capability.executionContext
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (pending) return
    setPending(true)
    setMessage('')
    try { await operation() } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setPending(false) }
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
        <dt className="text-ds-muted">{t('capabilityProvider')}</dt><dd>{t(isLark ? 'capabilityLark' : isDingTalk ? 'capabilityDingTalk' : isBrowser ? 'connectorHubBrowserSkill' : capability.provider === 'schedule' ? 'capabilitySchedule' : 'capabilityWorkspaceFiles')}</dd>
        <dt className="text-ds-muted">{t('capabilityCurrentStatus')}</dt><dd>{t(`capabilityStatus_${capability.status}`)}</dd>
        <dt className="text-ds-muted">{t('capabilityWorkspace')}</dt><dd className="break-all">{execution?.workspaceRoot || capability.workspaceRoot || t('capabilityWorkspaceUnknown')}</dd>
        <dt className="text-ds-muted">{t('capabilityRequestedScope')}</dt><dd>{capability.requiredScopes?.join(', ') || t('capabilityScopeNotGranted')}</dd>
        {execution ? <>
          <dt className="text-ds-muted">{t('capabilityWorkspaceTrust')}</dt><dd>{t(`settings:agentCenterTrust_${execution.workspaceTrust}`)}</dd>
          <dt className="text-ds-muted">{t('capabilityAgentTrust')}</dt><dd>{t(`settings:agentCenterTrust_${execution.agentTrust}`)}</dd>
          <dt className="text-ds-muted">{t('capabilitySandbox')}</dt><dd>{t(({ 'read-only': 'sandboxReadOnlyShort', 'workspace-write': 'sandboxWorkspaceWriteShort', 'danger-full-access': 'sandboxFullAccessShort', 'external-sandbox': 'sandboxExternalShort' } as Record<string, string>)[execution.sandboxMode] ?? 'capabilityStateUnknown')}</dd>
          <dt className="text-ds-muted">{t('composerApprovalShort')}</dt><dd>{t(({ auto: 'approvalAutoShort', 'on-request': 'approvalOnRequestShort', untrusted: 'approvalUntrustedShort', suggest: 'approvalSuggestShort', never: 'approvalNeverShort' } as Record<string, string>)[execution.approvalPolicy] ?? 'capabilityStateUnknown')}</dd>
        </> : null}
      </dl>
      {execution?.availableTools ? <details className="mt-2 text-xs text-ds-muted"><summary className="cursor-pointer">{t('capabilityAvailableTools', { count: execution.availableTools.length })}</summary><p className="mt-1 break-all">{execution.availableTools.join(', ') || t('capabilityNoTools')}</p></details> : null}
      {isLark && !settled && action?.kind !== 'grant' ? <ManagedLarkConnection compact initialState={capability.status === 'not_installed' ? 'not_installed' : undefined} /> : null}
      {isDingTalk && !settled && action?.kind !== 'grant' ? <div className="mt-3"><ManagedDingTalkConnection /></div> : null}
      {isBrowser && !settled ? <ManagedBrowserSkillConnection onChanged={() => setBrowserBindingGeneration(value => value + 1)} /> : null}
      {showBrowserBinding && !settled ? <BrowserTaskBindingPanel key={browserBindingGeneration} taskId={card.taskId} onConfirmed={setMessage} /> : null}
      {showPermissions && !settled ? <TaskPermissionPanel taskId={card.taskId} autoLoad onConfirmed={value => { setMessage(value); void useChatStore.getState().refreshThreads() }} /> : null}
      {message ? <p role="status" className="mt-3 whitespace-pre-wrap text-xs">{message}</p> : null}
      {!settled ? <div className="mt-3 flex flex-wrap gap-2 [&_button]:rounded-md [&_button]:border [&_button]:border-ds-border [&_button]:px-3 [&_button]:py-1.5 [&_button:disabled]:opacity-50">
        <button type="button" disabled={pending} onClick={configure}>{isLark && action?.kind === 'install' ? t('capabilityOpenMarketplace') : action?.label || t(isDingTalk ? 'capabilityConfigureDingTalk' : 'capabilityOpenMarketplace')}</button>
        <button type="button" disabled={pending} onClick={() => void run(recheck)}>{t('capabilityRecheckResume')}</button>
        <button type="button" disabled={pending} onClick={() => void run(decline)}>{t('capabilityDecline')}</button>
      </div> : null}
    </section>
  )
}
