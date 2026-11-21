import { describeRuntimeError, type RuntimeErrorView } from '../../lib/format-runtime-error'
import { TechnicalDetails } from '../ui/TechnicalDetails'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TaskAttentionV1, TaskPermissionSnapshotV1, TaskRunV1 } from '@shared/agent-workbench'
import { redactSecretText } from '@shared/secret-redaction'
import type { ExternalTaskCapabilityCard } from '@shared/task-command'
import { ManagedLarkConnection } from '../connectors/ManagedLarkConnection'
import { ManagedDingTalkConnection } from '../connectors/ManagedDingTalkConnection'
import { BrowserTaskBindingPanel } from '../connectors/BrowserTaskBindingPanel'
import { ManagedBrowserSkillConnection } from '../connectors/ManagedBrowserSkillConnection'
import { TaskPermissionPanel } from './TaskPermissionPanel'
import { TaskPublicQueryRecoveryCard } from '../tasks/TaskPublicQueryRecoveryCard'
import { requestFlowDetail } from '../../store/flow-navigation'
import { useChatStore, type SettingsRouteSection } from '../../store/chat-store'
import { getTaskState, refreshTaskState, useTaskState } from '../../store/task-live-store'
import { isExecutionGrantExpiredCapability, taskHasExecutionEvidence } from '@shared/task-presentation'
import { foregroundTaskArtifactPreview } from '../../lib/use-task-artifact-preview'

export function capabilityCardMatchesAttention(card: ExternalTaskCapabilityCard, item: TaskAttentionV1): boolean {
  if (item.id !== (card.attentionId ?? `capability_${card.taskId}`) ||
    item.taskId !== card.taskId || item.status !== 'pending' || item.payload?.kind !== 'capability_required') return false
  const current = item.payload.capability as ExternalTaskCapabilityCard['capability'] | undefined
  const capability = card.capability
  if (!current || current.provider !== capability.provider || current.status !== capability.status || current.errorCode !== capability.errorCode) return false
  // The coordinator reuses attention IDs. checkedAt distinguishes subsequent requests.
  if (capability.checkedAt || current.checkedAt) return Boolean(capability.checkedAt && capability.checkedAt === current.checkedAt)
  const legacyRequestKey = (value: ExternalTaskCapabilityCard['capability']) => JSON.stringify([
    value.message, value.workspaceRoot, value.requiredScopes, value.action?.kind, value.action?.route,
    value.resolution?.kind, value.resolution?.route
  ])
  return legacyRequestKey(capability) === legacyRequestKey(current)
}

/** A capability failure is a durable waiting task, never a completed answer. */
export function CapabilityRequiredCard({ card, workspaceRoot }: { card: ExternalTaskCapabilityCard; workspaceRoot?: string }): ReactElement {
  const { t, i18n } = useTranslation('common')
  const openFlow = useChatStore((state) => state.openFlow)
  const openPlugins = useChatStore((state) => state.openPlugins)
  const openSettings = useChatStore((state) => state.openSettings)
  const chooseWorkspace = useChatStore((state) => state.chooseWorkspace)
  const live = useTaskState()
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState<RuntimeErrorView>()
  const [settledCapability, setSettled] = useState<ExternalTaskCapabilityCard['capability']>()
  const [rechecked, setRechecked] = useState<{ source: ExternalTaskCapabilityCard['capability']; capability: ExternalTaskCapabilityCard['capability'] }>()
  const capability = rechecked?.source === card.capability ? rechecked.capability : card.capability
  const [showPermissions, setShowPermissions] = useState(false)
  const [showQueryRecovery, setShowQueryRecovery] = useState(false)
  const [showBrowserBinding, setShowBrowserBinding] = useState(false)
  const [browserBindingGeneration, setBrowserBindingGeneration] = useState(0)
  const [checkedRequest, setCheckedRequest] = useState('')
  const requestKey = JSON.stringify([card.taskId, card.attentionId])
  const continuationKey = JSON.stringify([card.threadId, card.taskId, card.attentionId, card.prompt, capability])
  const currentContinuation = useRef<string | undefined>(continuationKey)
  currentContinuation.current = continuationKey
  useEffect(() => {
    currentContinuation.current = continuationKey
    return () => { currentContinuation.current = undefined }
  }, [continuationKey])
  useEffect(() => {
    let active = true
    // All mounted cards share the store's in-flight refresh. Cached attention
    // from a previous subscription must not trigger connector diagnosis first.
    void refreshTaskState().then(() => { if (active) setCheckedRequest(requestKey) })
    return () => { active = false }
  }, [requestKey])
  const isLark = capability.provider === 'lark' || capability.provider === 'feishu'
  const isDingTalk = capability.provider === 'dingtalk'
  const isBrowser = capability.provider === 'browser-skill'
  const isEgo = capability.provider === 'ego-browser'
  const connector = isBrowser ? 'browser-skill' : isLark ? 'lark' : isDingTalk ? 'dingtalk' : undefined
  const action = capability.resolution ?? capability.action
  const egoTaskReview = isEgo && ['blocked', 'needs_authorization'].includes(capability.status) && action?.route === 'task/ego-browser-review'
  const scopeFallbackKey = capability.provider === 'workspace' ? 'capabilityScopeReviewRequired'
    : isEgo ? 'capabilityScopeRecheckOnResume' : 'capabilityScopeNotGranted'
  const currentRequest = live.attention.some(item => capabilityCardMatchesAttention({ ...card, capability }, item))
  const stateKnown = checkedRequest === requestKey && live.ready && !live.error
  const ownerTask = live.tasks.find(task => task.id === card.taskId)
  const settled = settledCapability === card.capability || Boolean(stateKnown && (
    ownerTask?.status === 'completed' || ownerTask?.status === 'cancelled' ||
    !currentRequest && (card.attentionId || ownerTask)))
  const interactive = !settled && stateKnown && currentRequest
  const titleKey = interactive
    ? ownerTask && !taskHasExecutionEvidence(ownerTask) ? 'capabilityRequiredTitle' : 'capabilityBlockedAfterProgressTitle'
    : settled ? 'capabilityHistoryTitle' : 'capabilityRecordTitle'
  const executionGrantExpired = isExecutionGrantExpiredCapability(capability)
  const reviewedAttention = live.attention.find(item => capabilityCardMatchesAttention({ ...card, capability }, item))
  // Only known task-authority blockers can combine a scope grant with execution.
  // Agent/configuration changes and browser effect reviews keep their own actions.
  const canGrantAndContinue = interactive && Boolean(card.attentionId) && reviewedAttention?.threadId === card.threadId && ownerTask?.status === 'waiting_user' &&
    (ownerTask.originThreadId ?? ownerTask.threadId) === card.threadId &&
    ownerTask.presentation?.reason !== 'outcome_unknown' && action?.kind === 'grant' &&
    ['workspace', 'lark', 'feishu', 'dingtalk'].includes(capability.provider) && capability.errorCode === 'approval_policy_blocked'
  const openConfiguration = (): void => {
    if (isEgo) openPlugins()
    else if (connector) openPlugins(undefined, connector)
    else if (capability.provider === 'schedule' && action?.route.startsWith('flow/')) {
      requestFlowDetail({ flowId: action.route.slice('flow/'.length) })
      openFlow()
    } else openSettings('general')
  }
  const configure = (): void => {
    if (action?.kind === 'switch_workspace') {
      void run(async () => { await chooseWorkspace({ createThreadAfter: false, selectThreadAfter: false }) })
      return
    }
    const route = action?.route ?? ''
    if (isEgo && route === 'task/ego-browser-review') {
      setShowPermissions(value => !value)
      return
    }
    if (isBrowser && route === 'task/public-query-recovery') {
      setShowQueryRecovery(value => !value)
      return
    }
    if (capability.provider === 'schedule' && route === 'task/schedule-review') {
      void run(recheck)
      return
    }
    if (isBrowser && route === 'task/browser-action-review') {
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
  const recordedWorkspaceRoot = execution?.workspaceRoot || capability.workspaceRoot
  const ownerWorkspaceRoot = ownerTask?.workspaceRoot || workspaceRoot
  const displayedWorkspaceRoot = interactive ? ownerWorkspaceRoot || recordedWorkspaceRoot : recordedWorkspaceRoot || ownerWorkspaceRoot
  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (pending) return
    setPending(true)
    setMessage('')
    setFailure(undefined)
    try { await operation() } catch (error) { setFailure(describeRuntimeError(error, t('taskWorkspaceActionFailed'))) }
    finally { setPending(false) }
  }
  const presentMessage = (value: string): string => {
    if (/(?:\bCLI\b|\bspawn\s+(?:EINVAL|ENOENT|EACCES)\b|Error invoking remote method|\bSHA-?[0-9]+\b)/i.test(value)) {
      return t(isEgo ? 'capabilityEgoNeedsConnection' : isBrowser ? 'capabilityBrowserNeedsConnection' : 'capabilityCheckToContinue')
    }
    const chinese = (i18n.resolvedLanguage ?? i18n.language).startsWith('zh')
    return redactSecretText(value).replace(/\s*\bscopes?\b/gi, chinese ? '权限' : ' permissions')
  }
  const recheck = async (expectedRevision?: number, expectedAttentionRevision?: number): Promise<void> => {
    const result = await window.workwise.coordinateTaskCommand({
      threadId: card.threadId, taskId: card.taskId, resolveAttentionId: card.attentionId,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...(expectedAttentionRevision === undefined ? {} : { expectedAttentionRevision }),
      intent: 'resume', idempotencyKey: crypto.randomUUID(), request: { prompt: card.prompt }
    })
    if (expectedRevision !== undefined && (result.task && result.task.id !== card.taskId ||
      !['task_started', 'capability_required', 'attention_required', 'snapshot'].includes(result.kind) ||
      result.kind === 'task_started' && (!result.task || !result.turn?.turnId))) {
      throw new Error(t('taskPermissionContinueUnavailable'))
    }
    if (result.kind === 'task_started' && result.task && result.turn?.turnId) {
      foregroundTaskArtifactPreview(card.threadId, result.task.id)
    }
    if (result.kind === 'capability_required' || result.kind === 'attention_required') {
      if (result.kind === 'capability_required') {
        setRechecked({ source: card.capability, capability: result.capability })
        setMessage(isExecutionGrantExpiredCapability(result.capability)
          ? t('capabilityExecutionGrantExpiredSummary') : presentMessage(result.message))
      } else {
        setMessage(presentMessage(result.message))
      }
    } else if (result.kind === 'snapshot' && expectedRevision !== undefined) {
      // Permission confirmation succeeded, but a snapshot is not a new execution.
      setMessage(t('taskPermissionContinueNotStarted'))
    } else {
      setSettled(card.capability)
      setMessage(result.kind === 'snapshot' ? t('capabilityStateChecked') : t('capabilityResumed'))
    }
    // Refresh only the original conversation. Never switch a user away from
    // another conversation while a delayed authorization finishes.
    await refreshTaskState()
    const store = useChatStore.getState()
    await store.refreshThreads()
    if (store.activeThreadId === card.threadId) await store.selectThread(card.threadId)
  }
  const continueGrantedTask = async (task: TaskRunV1, permission: TaskPermissionSnapshotV1): Promise<void> => {
    // Finish any pre-confirmation store read before requesting a new snapshot.
    // The shared store otherwise coalesces both reads into the old response.
    await refreshTaskState()
    await refreshTaskState()
    const current = getTaskState()
    const owner = current.tasks.find(item => item.id === card.taskId)
    const attention = current.attention.find(item => capabilityCardMatchesAttention({ ...card, capability }, item))
    if (!canGrantAndContinue || currentContinuation.current !== continuationKey || !current.ready || current.error ||
      owner?.status !== 'waiting_user' || (owner.originThreadId ?? owner.threadId) !== card.threadId || owner.presentation?.reason === 'outcome_unknown' || owner.revision !== task.revision ||
      task.id !== card.taskId || permission.taskId !== card.taskId || permission.taskRevision !== owner.revision ||
      permission.grant?.status !== 'active' || Date.parse(permission.grant.expiresAt) <= Date.now() ||
      !attention || attention.revision !== reviewedAttention?.revision || attention.threadId !== card.threadId) {
      throw new Error(t('taskPermissionContinueUnavailable'))
    }
    await recheck(task.revision, attention.revision)
  }
  const decline = async (): Promise<void> => {
    const result = await window.workwise.coordinateTaskCommand({
      threadId: card.threadId, taskId: card.taskId, intent: 'cancel',
      idempotencyKey: crypto.randomUUID(), request: { prompt: t('capabilityDeclined') }
    })
    if (result.kind !== 'task_updated' || result.action !== 'cancel') throw new Error(t('capabilityCancelFailed'))
    setSettled(card.capability)
    setMessage(t('capabilityDeclined'))
    await refreshTaskState()
  }
  const displayedMessage = presentMessage(capability.message)
  const capabilitySummary = executionGrantExpired ? t('capabilityExecutionGrantExpiredMessage') : displayedMessage
  const snapshot = (<>
      <p className="mt-1 whitespace-pre-wrap">{capabilitySummary}</p>
      {executionGrantExpired || displayedMessage !== capability.message
        ? <TechnicalDetails detail={[redactSecretText(capability.message), capability.errorCode].filter(Boolean).join('\n')} label={t('capabilityDiagnosticDetails')} />
        : null}
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-ds-muted">{t(capability.provider === 'workspace' ? 'capabilityPermissionType' : 'capabilityProvider')}</dt><dd>{t(isLark ? 'capabilityLark' : isDingTalk ? 'capabilityDingTalk' : isBrowser ? 'connectorHubBrowserSkill' : isEgo ? 'pluginCliEgoTitle' : capability.provider === 'schedule' ? 'capabilitySchedule' : 'capabilityWorkspaceFiles')}</dd>
        <dt className="text-ds-muted">{t(interactive ? 'capabilityCurrentStatus' : 'capabilityRecordedStatus')}</dt><dd>{t(`capabilityStatus_${capability.status}`)}</dd>
        <dt className="text-ds-muted">{t(interactive ? 'capabilityWorkspace' : 'capabilityRecordedWorkspace')}</dt><dd className="break-all">{displayedWorkspaceRoot || t('capabilityWorkspaceUnknown')}</dd>
        <dt className="text-ds-muted">{t(interactive ? 'capabilityRequestedScope' : 'capabilityRecordedScope')}</dt><dd>{capability.requiredScopes?.join(', ') || t(scopeFallbackKey)}</dd>
        {execution ? <>
          <dt className="text-ds-muted">{t('capabilityWorkspaceTrust')}</dt><dd>{t(`settings:agentCenterTrust_${execution.workspaceTrust}`)}</dd>
          <dt className="text-ds-muted">{t('capabilityAgentTrust')}</dt><dd>{t(`settings:agentCenterTrust_${execution.agentTrust}`)}</dd>
          <dt className="text-ds-muted">{t('capabilitySandbox')}</dt><dd>{t(({ 'read-only': 'sandboxReadOnlyShort', 'workspace-write': 'sandboxWorkspaceWriteShort', 'danger-full-access': 'sandboxFullAccessShort', 'external-sandbox': 'sandboxExternalShort' } as Record<string, string>)[execution.sandboxMode] ?? 'capabilityStateUnknown')}</dd>
          <dt className="text-ds-muted">{t('composerApprovalShort')}</dt><dd>{t(({ auto: 'approvalAutoShort', 'on-request': 'approvalOnRequestShort', untrusted: 'approvalUntrustedShort', suggest: 'approvalSuggestShort', never: 'approvalNeverShort' } as Record<string, string>)[execution.approvalPolicy] ?? 'capabilityStateUnknown')}</dd>
        </> : null}
      </dl>
      {execution?.availableTools ? <details className="mt-2 text-xs text-ds-muted"><summary className="cursor-pointer">{t('capabilityAvailableTools', { count: execution.availableTools.length })}</summary><p className="mt-1 break-all">{execution.availableTools.join(', ') || t('capabilityNoTools')}</p></details> : null}
  </>)
  return (
    <section aria-label={t(titleKey)} className={`mt-3 rounded-xl border p-4 text-sm text-ds-ink dark:bg-zinc-900 ${interactive ? 'border-amber-300 bg-amber-50 dark:border-amber-800' : 'border-ds-border bg-ds-surface'}`}>
      <div className="font-semibold">{t(titleKey)}</div>
      {interactive ? snapshot : <>
        {!settled ? <p role="status" className="mt-1 text-xs text-ds-muted">{t(live.error || stateKnown ? 'capabilityRecordUnverified' : 'capabilityRecordLoading')}</p> : null}
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-ds-muted">{t('capabilityRecordDetails')}</summary>
          {snapshot}
        </details>
      </>}
      {isLark && interactive && action?.kind !== 'grant' ? <ManagedLarkConnection compact initialState={capability.status === 'not_installed' ? 'not_installed' : undefined} /> : null}
      {isDingTalk && interactive && action?.kind !== 'grant' ? <div className="mt-3"><ManagedDingTalkConnection /></div> : null}
      {isBrowser && interactive ? <ManagedBrowserSkillConnection onChanged={() => setBrowserBindingGeneration(value => value + 1)} /> : null}
      {showBrowserBinding && interactive ? <BrowserTaskBindingPanel key={browserBindingGeneration} taskId={card.taskId} onConfirmed={setMessage} /> : null}
      {showPermissions && interactive ? <TaskPermissionPanel key={continuationKey} taskId={card.taskId} autoLoad onContinue={canGrantAndContinue ? continueGrantedTask : undefined} onConfirmed={value => { setMessage(value); void useChatStore.getState().refreshThreads() }} /> : null}
      {showQueryRecovery && interactive && ownerTask ? <TaskPublicQueryRecoveryCard task={ownerTask} runtimeReady={stateKnown} onChanged={refreshTaskState} onNotice={setMessage} /> : null}
      {failure ? <div className="mt-3 text-xs"><p role="alert">{failure.summary}</p><TechnicalDetails detail={failure.detail} /></div> : null}
      {message && (!interactive || message !== capabilitySummary) ? <p role="status" className="mt-3 whitespace-pre-wrap text-xs">{message}</p> : null}
      {interactive ? <div className="mt-3 flex flex-wrap gap-2 [&_button]:rounded-md [&_button]:border [&_button]:border-ds-border [&_button]:px-3 [&_button]:py-1.5 [&_button:disabled]:opacity-50">
        <button type="button" disabled={pending} onClick={configure}>{egoTaskReview ? t('capabilityViewTaskRecoveryOptions') : isLark && action?.kind === 'install' ? t('capabilityOpenMarketplace') : action?.label || t(isDingTalk ? 'capabilityConfigureDingTalk' : 'capabilityOpenMarketplace')}</button>
        <button type="button" disabled={pending} onClick={() => void run(recheck)}>{t('capabilityRecheckResume')}</button>
        <button type="button" disabled={pending} onClick={() => void run(decline)}>{t('capabilityDecline')}</button>
      </div> : <div className="mt-3 flex flex-wrap gap-2 [&_button]:rounded-md [&_button]:border [&_button]:border-ds-border [&_button]:px-3 [&_button]:py-1.5 [&_button:disabled]:opacity-50">
        <button type="button" onClick={openConfiguration}>{t('capabilityViewConfiguration')}</button>
        {!stateKnown ? <button type="button" disabled={pending} onClick={() => void run(refreshTaskState)}>{t('capabilityRefreshTaskState')}</button> : null}
      </div>}
    </section>
  )
}
