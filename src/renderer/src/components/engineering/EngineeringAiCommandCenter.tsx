import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, Circle, ClipboardList, Compass, FileCheck2, Loader2, LocateFixed, MessageSquareText, Play, Plus, RefreshCw, Upload } from 'lucide-react'
import type { TaskRunStatus, TaskRunV1 } from '@shared/agent-workbench'
import appI18n from '../../i18n'
import { formatRuntimeError } from '../../lib/format-runtime-error'
import { surveyLegacyDiagnosticText, surveyRuntimeErrorText } from './survey-diagnostic-text'
import { rendererRuntimeClient } from '../../agent/runtime-client'
import { useChatStore } from '../../store/chat-store'
import { MessageTimeline } from '../chat/MessageTimeline'
import { EngineeringComposer } from './EngineeringComposer'
import { composerReasoningEffortRequestValue } from '../chat/FloatingComposerModelPicker'
import { EngineeringProjectSuggestions } from './EngineeringProjectSuggestions'
import { engineeringPlanTranscriptText } from './engineering-plan-transcript'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'
import { evidenceCardNavigationTarget, planStepNavigationTarget, surveyNavigationTarget, type EngineeringEvidenceNavigationTarget, type EngineeringNavigationContext } from './engineering-evidence-navigation'

type Project = { id: string; name: string; taskType?: string; monitoringType: string; unit: string; revision: number; reportPeriod: { start?: string; end?: string } }
type Dataset = { sourceFileName: string; observationCount: number; status: string; findings: Array<{ severity: 'blocking' | 'warning' | 'info'; status: string }> }
type Analysis = { results: Array<{ thresholdStatus: string; anomaly: boolean }>; algorithmVersion: string }
type EvidenceCard = { id: string; kind: string; title: string; summary: string; sourceHash?: string; locator?: string }
type AiPlan = {
  id: string; projectId: string; contextHash: string; revision: number; goal: string; status: string; taskId?: string; executionTurnId?: string
  steps: Array<{ id: string; title: string; tool: string; risk: string; approval: string; parameters?: Record<string, unknown>; parameterBindings?: Array<{ parameter: string; stepId: string; output: string; asArray?: boolean }>; expectedOutputs?: string[]; reversibility?: string }>
  approval?: { token: string; stepIds: string[]; expiresAt: string }
  execution?: { complete: boolean; completedStepIds: string[]; pendingStepIds: string[] }
}
type Props = {
  workspaceRoot: string; runtimeReady: boolean; project: Project | null; dataset: Dataset | null; analysis: Analysis | null
  latestRun?: { id: string; status: string } | null
  compact?: boolean
  onCreateProject: () => void; onImportData: () => void
  onSurveyFiles: (files: File[]) => void
  onOpenTab: (tab: 'project' | 'data' | 'quality' | 'survey' | 'analysis' | 'deliverables' | 'review' | 'skills') => void
  onRefresh: () => void
  onExecutionSettled?: () => void
  navigationContext?: EngineeringNavigationContext | null
  onNavigateEvidence?: (target: EngineeringEvidenceNavigationTarget) => void
}
type Translate = (key: string, options?: Record<string, unknown>) => string
type PlanStep = { title: string; detail: string; state: 'ready' | 'active' | 'done' | 'blocked'; tool?: string }
type SessionResourceState = { status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'; error?: string }

const IDLE_RESOURCE_STATE: SessionResourceState = { status: 'idle' }

function readRuntimeMessage(body: string, fallback: string): string {
  return body.trim() || fallback
}
function phaseLabel(status: string, t: Translate): string {
  const keys: Record<string, string> = {
    draft: 'engineeringStatusDraft', validating: 'engineeringStatusValidating', approved: 'engineeringStatusApproved', awaiting_approval: 'engineeringStatusAwaitingApproval',
    started: 'engineeringStatusStarted', queued: 'engineeringStatusQueued', running: 'engineeringStatusRunning', retrying: 'engineeringStatusRetrying',
    waiting_user: 'engineeringStatusWaitingUser', waiting_approval: 'engineeringStatusWaitingApproval', stalled: 'engineeringStatusStalled',
    needs_attention: 'engineeringStatusNeedsAttention', stale: 'engineeringStatusStale', completed: 'engineeringStatusCompleted', failed: 'engineeringStatusFailed', cancelled: 'engineeringStatusCancelled'
  }
  return keys[status] ? t(keys[status]) : status
}
function hasCompleteExecutionEvidence(plan: AiPlan): boolean {
  return plan.execution?.complete === true && plan.execution.pendingStepIds.length === 0
    && plan.steps.length > 0 && plan.steps.every(step => plan.execution?.completedStepIds.includes(step.id))
}

export function projectAiPlanStatus(plan: AiPlan, taskStatus?: TaskRunStatus): string {
  if (['needs_attention', 'stale'].includes(plan.status)) return plan.status
  const status = taskStatus ?? plan.status
  return status === 'completed' && !hasCompleteExecutionEvidence(plan) ? 'needs_attention' : status
}

export function projectAiPlanSteps(plan: AiPlan, taskStatus?: TaskRunStatus, t?: Translate): PlanStep[] {
  const status = projectAiPlanStatus(plan, taskStatus)
  const blocked = ['stalled', 'waiting_user', 'waiting_approval', 'failed', 'cancelled', 'needs_attention', 'stale'].includes(status)
  const translate = t ?? appI18n.t.bind(appI18n)
  return plan.steps.map((step) => ({
    title: step.title,
    detail: `${step.tool} · ${step.risk === 'read' ? translate('engineeringRiskRead') : translate('engineeringRiskApproval')} · ${step.approval === 'approved' ? translate('engineeringApproved') : translate('engineeringPendingApproval')}`,
    state: plan.execution?.completedStepIds.includes(step.id) ? 'done' : blocked ? 'blocked' : 'ready', tool: step.tool
  }))
}

export function EngineeringAiCommandCenter({ workspaceRoot, runtimeReady, project, compact = false, onCreateProject, onImportData, onSurveyFiles, onOpenTab, onRefresh, onExecutionSettled, navigationContext, onNavigateEvidence }: Props): ReactElement {
  const { t, i18n } = useTranslation('common')
  const { activeThreadId, threads, blocks, liveReasoning, liveAssistant, busy, runtimeConnection, error, lastSeq, refreshThreads, selectThread, probeRuntime, openSettings, composerModel } = useChatStore(useShallow((state) => ({
    activeThreadId: state.activeThreadId, threads: state.threads, blocks: state.blocks,
    liveReasoning: state.liveReasoning, liveAssistant: state.liveAssistant, busy: state.busy,
    runtimeConnection: state.runtimeConnection, error: state.error, lastSeq: state.lastSeq,
    refreshThreads: state.refreshThreads, selectThread: state.selectThread, probeRuntime: state.probeRuntime,
    openSettings: state.openSettings, composerModel: state.composerModel
  })))
  const [notice, setNotice] = useState<string | null>(null)
  const [evidenceCards, setEvidenceCards] = useState<EvidenceCard[]>([])
  const [aiPlan, setAiPlan] = useState<AiPlan | null>(null)
  const [planThreadId, setPlanThreadId] = useState<string | null>(null)
  const [taskRun, setTaskRun] = useState<TaskRunV1 | null>(null)
  const [planReadState, setPlanReadState] = useState<SessionResourceState>(IDLE_RESOURCE_STATE)
  const [evidenceReadState, setEvidenceReadState] = useState<SessionResourceState>(IDLE_RESOURCE_STATE)
  const [sessionReadRevision, setSessionReadRevision] = useState(0)
  const [planBusy, setPlanBusy] = useState(false)
  const [showPlan, setShowPlan] = useState(true)
  const [approvedSteps, setApprovedSteps] = useState<string[]>([])
  const projectId = project?.id ?? ''
  const selectedEvidence = useEngineeringConversationDrafts(state => state.drafts[JSON.stringify([workspaceRoot, projectId])]?.evidenceContext)
  const reasoningEffort = useEngineeringConversationDrafts(state => state.drafts[JSON.stringify([workspaceRoot, projectId])]?.reasoningEffort ?? 'max')
  const selectedTarget = navigationContext && selectedEvidence ? surveyNavigationTarget(navigationContext, selectedEvidence) : null
  const navigationButton = (target: EngineeringEvidenceNavigationTarget | null): ReactElement => <button type="button" disabled={!target || !onNavigateEvidence} title={t(target ? 'engineeringOpenEvidence' : 'engineeringEvidenceUnavailable')} onClick={() => { if (target) onNavigateEvidence?.(target) }} className="mt-1 inline-flex min-h-8 items-center gap-1.5 text-[11px] text-accent disabled:text-ds-muted disabled:opacity-60"><LocateFixed className="h-3.5 w-3.5" />{t('engineeringOpenEvidence')}</button>
  const connected = runtimeReady && runtimeConnection === 'ready'
  const connectionMessage = runtimeReady ? t('engineeringConversationNotReady') : t('engineeringRuntimeNotConnected')
  const activeThread = threads.find((thread) => thread.id === activeThreadId)
  const engineeringThreadActive = Boolean(activeThread && project && activeThread.domain === 'engineering' && activeThread.projectId === project.id && activeThread.workspace === workspaceRoot)
  const timelineBlocks = engineeringThreadActive ? blocks.map(block => block.kind === 'assistant'
    ? { ...block, text: engineeringPlanTranscriptText(block.text, i18n.language) } : block) : []
  const timelineThreadId = engineeringThreadActive ? activeThreadId : null
  const refreshRef = useRef(onExecutionSettled ?? onRefresh)
  refreshRef.current = onExecutionSettled ?? onRefresh
  const refreshedExecutions = useRef(new Set<string>())
  const notifyExecutionSettled = useCallback((plan: AiPlan, status: string): void => {
    if (!timelineThreadId || plan.projectId !== projectId || !['completed', 'failed', 'cancelled', 'needs_attention', 'stalled', 'waiting_user', 'waiting_approval'].includes(status)) return
    const key = JSON.stringify([workspaceRoot, projectId, timelineThreadId, plan.id, plan.executionTurnId ?? plan.taskId, status])
    if (refreshedExecutions.current.has(key)) return
    refreshedExecutions.current.add(key)
    setSessionReadRevision((value) => value + 1)
    refreshRef.current()
  }, [workspaceRoot, projectId, timelineThreadId])
  const timelineHasActivity = timelineBlocks.length > 0 || (engineeringThreadActive && (busy || Boolean(liveReasoning || liveAssistant)))
  const scopedPlan = aiPlan?.projectId === projectId && planThreadId === timelineThreadId ? aiPlan : null
  const actionScope = JSON.stringify([workspaceRoot, projectId, timelineThreadId])
  const actionScopeRef = useRef(actionScope)
  actionScopeRef.current = actionScope
  const currentPlanRef = useRef(scopedPlan)
  currentPlanRef.current = scopedPlan
  const resumeInFlight = useRef<string | null>(null)
  const setGoal = (input: string): void => useEngineeringConversationDrafts.getState().update(JSON.stringify([workspaceRoot, projectId]), (draft) => ({ ...draft, input }))

  useEffect(() => {
    setNotice(null); setAiPlan(null); setPlanThreadId(null); setTaskRun(null); setEvidenceCards([]); setPlanBusy(false)
    setPlanReadState(IDLE_RESOURCE_STATE); setEvidenceReadState(IDLE_RESOURCE_STATE)
  }, [workspaceRoot, projectId, activeThreadId])
  useEffect(() => { setApprovedSteps([]) }, [scopedPlan?.id, scopedPlan?.revision])
  useEffect(() => {
    let cancelled = false
    if (!connected || !projectId || !timelineThreadId || busy) return
    const query = new URLSearchParams({ threadId: timelineThreadId, projectId })
    setPlanReadState({ status: 'loading' })
    setEvidenceReadState({ status: 'loading' })
    void rendererRuntimeClient.runtimeRequest(`/v1/engineering/ai/plans?${query.toString()}`).then((response) => {
      if (cancelled) return
      if (response.status === 404) { setAiPlan(null); setPlanReadState({ status: 'empty' }); return }
      if (!response.ok) throw new Error(readRuntimeMessage(response.body, t('engineeringPlanReadFailed')))
      try {
        const parsed = JSON.parse(response.body) as { plan: AiPlan | null; approval?: AiPlan['approval'] }
        if (!parsed.plan) { setAiPlan(null); setPlanReadState({ status: 'empty' }); return }
        setAiPlan({ ...parsed.plan, approval: parsed.approval })
        setPlanThreadId(timelineThreadId)
        setPlanReadState({ status: 'ready' })
        notifyExecutionSettled(parsed.plan, parsed.plan.status)
      } catch { throw new Error(t('engineeringNoticePlanUnreadable')) }
    }).catch((cause) => {
      if (!cancelled) setPlanReadState({ status: 'error', error: formatRuntimeError(cause, t('engineeringPlanReadFailed')) })
    })
    void rendererRuntimeClient.runtimeRequest(`/v1/engineering/ai/evidence/${encodeURIComponent(projectId)}`).then((response) => {
      if (cancelled) return
      if (!response.ok) throw new Error(readRuntimeMessage(response.body, t('engineeringEvidenceReadFailed')))
      try {
        const cards = (JSON.parse(response.body) as { cards?: EvidenceCard[] }).cards ?? []
        setEvidenceCards(cards)
        setEvidenceReadState({ status: cards.length ? 'ready' : 'empty' })
      } catch { throw new Error(t('engineeringEvidenceReadFailed')) }
    }).catch((cause) => {
      if (!cancelled) setEvidenceReadState({ status: 'error', error: formatRuntimeError(cause, t('engineeringEvidenceReadFailed')) })
    })
    return () => { cancelled = true }
  }, [busy, connected, lastSeq, projectId, sessionReadRevision, timelineThreadId, t, notifyExecutionSettled])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!connected || !scopedPlan?.taskId) return
    const taskId = scopedPlan.taskId
    const poll = async (): Promise<void> => {
      try {
        const next = await window.workwise.getTaskRun(taskId)
        if (cancelled) return
        setTaskRun(next)
        if (next?.id === taskId) notifyExecutionSettled(scopedPlan, next.status)
        if (next && ['queued', 'running', 'retrying'].includes(next.status)) timer = setTimeout(() => void poll(), 1_000)
      } catch { if (!cancelled) setTaskRun(null) }
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [connected, scopedPlan, busy, notifyExecutionSettled])

  const approveAndStartPlan = async (): Promise<void> => {
    if (!scopedPlan || !scopedPlan.steps.every(step => step.parameters && step.parameterBindings && step.expectedOutputs?.length && step.reversibility) || !connected || !engineeringThreadActive || busy || planBusy) return
    setPlanBusy(true); setNotice(null)
    const selection = { model: useChatStore.getState().composerModel || undefined, providerId: useChatStore.getState().composerProviderId, reasoningEffort: composerReasoningEffortRequestValue(reasoningEffort) }
    try {
      let approved = scopedPlan
      if (scopedPlan.status === 'awaiting_approval') {
        if (!scopedPlan.approval || scopedPlan.steps.some((step) => step.risk !== 'read' && !approvedSteps.includes(step.id))) return
        const response = await rendererRuntimeClient.runtimeRequest(`/v1/engineering/ai/plans/${encodeURIComponent(scopedPlan.id)}/approve`, 'POST', JSON.stringify({ expectedRevision: scopedPlan.revision, contextHash: scopedPlan.contextHash, stepIds: scopedPlan.approval.stepIds, token: scopedPlan.approval.token, idempotencyKey: `engineering-approve-${crypto.randomUUID()}` }))
        if (!response.ok) throw new Error(readRuntimeMessage(response.body, t('engineeringNoticeApprovalFailed')))
        approved = JSON.parse(response.body) as AiPlan
        setAiPlan(approved)
      }
      const response = await rendererRuntimeClient.runtimeRequest(`/v1/engineering/ai/plans/${encodeURIComponent(approved.id)}/start`, 'POST', JSON.stringify({ expectedRevision: approved.revision, contextHash: approved.contextHash, ...selection, idempotencyKey: `engineering-start-${crypto.randomUUID()}` }))
      if (!response.ok) throw new Error(readRuntimeMessage(response.body, t('engineeringNoticeStartFailed')))
      setAiPlan((JSON.parse(response.body) as { plan: AiPlan }).plan)
      await refreshThreads()
      if (useChatStore.getState().activeThreadId === timelineThreadId && timelineThreadId) await selectThread(timelineThreadId)
      onRefresh()
    } catch (cause) { setNotice(formatRuntimeError(cause, t('engineeringNoticeStartFailed'))) } finally { setPlanBusy(false) }
  }
  const resumeExecutionPlan = async (): Promise<void> => {
    if (!canResumePlan || !scopedPlan || !timelineThreadId || planBusy || resumeInFlight.current === actionScope) return
    const capturedScope = actionScope
    const capturedPlan = scopedPlan
    const capturedThreadId = timelineThreadId
    const selection = { model: useChatStore.getState().composerModel || undefined, providerId: useChatStore.getState().composerProviderId, reasoningEffort: composerReasoningEffortRequestValue(reasoningEffort) }
    const isCurrent = (): boolean => actionScopeRef.current === capturedScope && useChatStore.getState().activeThreadId === capturedThreadId
      && currentPlanRef.current?.id === capturedPlan.id && currentPlanRef.current?.taskId === capturedPlan.taskId
    if (!isCurrent()) return
    resumeInFlight.current = capturedScope
    setPlanBusy(true); setNotice(null)
    try {
      const response = await rendererRuntimeClient.runtimeRequest(`/v1/engineering/ai/plans/${encodeURIComponent(capturedPlan.id)}/resume`, 'POST', JSON.stringify({ expectedRevision: capturedPlan.revision, contextHash: capturedPlan.contextHash, ...selection, idempotencyKey: `engineering-resume-${crypto.randomUUID()}` }))
      if (!isCurrent() || currentPlanRef.current?.revision !== capturedPlan.revision) return
      if (!response.ok) throw new Error(readRuntimeMessage(response.body, t('engineeringNoticeResumeFailed')))
      const resumed = (JSON.parse(response.body) as { plan: AiPlan }).plan
      if (resumed.id !== capturedPlan.id || resumed.projectId !== capturedPlan.projectId || resumed.taskId !== capturedPlan.taskId || !Number.isSafeInteger(resumed.revision) || resumed.revision <= capturedPlan.revision) throw new Error('engineering resume response binding mismatch')
      setAiPlan(resumed); setTaskRun(null)
      await refreshThreads()
      if (!isCurrent()) return
      await selectThread(capturedThreadId)
      if (!isCurrent()) return
      onRefresh()
    } catch (cause) {
      if (isCurrent()) setNotice(formatRuntimeError(cause, t('engineeringNoticeResumeFailed')))
    } finally {
      if (resumeInFlight.current === capturedScope) {
        resumeInFlight.current = null
        if (actionScopeRef.current === capturedScope) setPlanBusy(false)
      }
    }
  }
  const replanStalePlan = async (): Promise<void> => {
    if (!scopedPlan || !canReplan || !connected || !engineeringThreadActive || !timelineThreadId || busy || planBusy) return
    setPlanBusy(true); setNotice(null)
    try {
      const response = await rendererRuntimeClient.runtimeRequest('/v1/engineering/ai/plans', 'POST', JSON.stringify({
        threadId: timelineThreadId,
        projectId,
        goal: scopedPlan.goal,
        replanOf: scopedPlan.id,
        idempotencyKey: `engineering-replan-${scopedPlan.id}-${crypto.randomUUID()}`
      }))
      if (!response.ok) throw new Error(readRuntimeMessage(response.body, t('engineeringNoticeReplanFailed')))
      const parsed = JSON.parse(response.body) as { plan: AiPlan; approval?: AiPlan['approval'] }
      setAiPlan({ ...parsed.plan, approval: parsed.approval })
      setTaskRun(null)
      setPlanReadState({ status: 'ready' })
      await refreshThreads()
      if (useChatStore.getState().activeThreadId === timelineThreadId) await selectThread(timelineThreadId)
      onRefresh()
    } catch (cause) { setNotice(formatRuntimeError(cause, t('engineeringNoticeReplanFailed'))) } finally { setPlanBusy(false) }
  }
  const retryRuntime = useCallback((): void => { void probeRuntime('user') }, [probeRuntime])
  const retrySessionRead = useCallback((): void => { setSessionReadRevision((revision) => revision + 1) }, [])
  const scopedTaskStatus = taskRun?.id === scopedPlan?.taskId ? taskRun?.status : undefined
  const planStatus = scopedPlan ? projectAiPlanStatus(scopedPlan, scopedTaskStatus) : undefined
  const taskDiagnostic = taskRun?.id === scopedPlan?.taskId && taskRun?.threadId === timelineThreadId
    ? ['stalled', 'failed', 'cancelled'].includes(taskRun?.status ?? '')
      ? taskRun?.stalledReason || taskRun?.waitingReason
      : ['waiting_user', 'waiting_approval'].includes(taskRun?.status ?? '')
        ? taskRun?.waitingReason || taskRun?.stalledReason
        : undefined
    : undefined
  const planSteps = scopedPlan ? projectAiPlanSteps(scopedPlan, scopedTaskStatus, t) : []
  const completedStepCount = planSteps.filter(step => step.state === 'done').length
  const planReviewComplete = scopedPlan?.steps.every(step => step.parameters && step.parameterBindings && step.expectedOutputs?.length && step.reversibility)
  const canResumePlan = Boolean(connected && engineeringThreadActive && !busy && scopedPlan && planReviewComplete
    && ['started', 'running', 'queued'].includes(scopedPlan.status)
    && taskRun?.id === scopedPlan.taskId && taskRun?.threadId === timelineThreadId
    && ['stalled', 'waiting_user', 'waiting_approval'].includes(taskRun?.status ?? '')
    && scopedPlan.execution && !scopedPlan.execution.complete && scopedPlan.execution.pendingStepIds.length > 0
    && scopedPlan.steps.every(step => step.approval === 'approved'))
  const canReplan = Boolean(scopedPlan && (!planReviewComplete || ['stale', 'needs_attention'].includes(planStatus ?? scopedPlan.status)
    || (taskRun?.id === scopedPlan.taskId && taskRun?.threadId === timelineThreadId && ['failed', 'cancelled'].includes(taskRun?.status ?? ''))))
  const needsApproval = scopedPlan?.status === 'awaiting_approval' && planReviewComplete
  const riskConfirmed = scopedPlan?.steps.every((step) => step.risk === 'read' || approvedSteps.includes(step.id))
  const sessionReadErrors = [planReadState.error, evidenceReadState.error].filter((value): value is string => Boolean(value))
  const sessionReadLoading = planReadState.status === 'loading' || evidenceReadState.status === 'loading'
  const sessionReadSettled = [planReadState.status, evidenceReadState.status].some((status) => status === 'ready' || status === 'empty')
  const sessionReadStatus = sessionReadErrors.length === 2 ? 'error' : sessionReadErrors.length || (sessionReadLoading && sessionReadSettled) ? 'partial' : sessionReadLoading ? 'loading' : 'ready'
  const sessionReadMessage = sessionReadStatus === 'loading'
    ? t('engineeringSessionLoading')
    : sessionReadStatus === 'partial'
      ? sessionReadErrors.length ? t('engineeringSessionPartialError', { detail: sessionReadErrors.join('；') }) : t('engineeringSessionPartialLoading')
      : sessionReadStatus === 'error' ? t('engineeringSessionReadError', { detail: sessionReadErrors.join('；') }) : ''
  const iconButton = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ds-muted hover:bg-ds-hover hover:text-ds-ink disabled:opacity-50'

  return <section className="engineering-conversation-surface flex h-full min-h-0 min-w-0 flex-col bg-ds-main" aria-label={t('engineeringSession')}>
    <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-ds-border-muted px-3">
      <MessageSquareText className="h-4 w-4 shrink-0 text-accent" />
      <div className="min-w-0 flex-1"><h2 className="truncate text-[13px] font-semibold">{t('engineeringSession')}</h2><p className="truncate text-[11px] text-ds-muted">{project?.name ?? t('engineeringWorkbenchTitle')}</p></div>
      <button type="button" className={iconButton} title={t('engineeringTabData')} aria-label={t('engineeringTabData')} disabled={!connected} onClick={onImportData}><Upload className="h-4 w-4" /></button>
      <button type="button" className={iconButton} title={t('engineeringTabSurvey')} aria-label={t('engineeringTabSurvey')} onClick={() => onOpenTab('survey')}><Compass className="h-4 w-4" /></button>
      <button type="button" className={iconButton} title={t('engineeringRefreshContext')} aria-label={t('engineeringRefreshContext')} onClick={onRefresh}><RefreshCw className="h-4 w-4" /></button>
    </header>
    {!connected || notice || error ? <div role="status" className="shrink-0 border-b border-ds-border-muted px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
      <p className="flex items-start gap-2 break-words"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{surveyRuntimeErrorText(notice || error || connectionMessage, i18n.language)}</p>
      <div className="mt-1 flex flex-wrap gap-3"><button type="button" onClick={retryRuntime}>{t('engineeringRuntimeRetry')}</button><button type="button" onClick={() => openSettings('agents')}>{t('engineeringCheckConfig')}</button></div>
    </div> : null}
    {connected && projectId && timelineThreadId && sessionReadStatus !== 'ready' ? <div
      role={sessionReadStatus === 'error' ? 'alert' : 'status'}
      aria-live={sessionReadStatus === 'error' ? 'assertive' : 'polite'}
      data-testid="engineering-session-read-state"
      data-state={sessionReadStatus}
      className={`shrink-0 border-b px-3 py-2 text-[12px] ${sessionReadStatus === 'error' ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200' : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'}`}
    >
      <p className="flex items-start gap-2 break-words">{sessionReadLoading && !sessionReadErrors.length ? <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}{sessionReadMessage}</p>
      {sessionReadErrors.length ? <button type="button" data-testid="engineering-session-retry" onClick={retrySessionRead} className="mt-1 font-medium underline underline-offset-2">{t('engineeringSessionRetry')}</button> : null}
    </div> : null}
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {timelineHasActivity ? <MessageTimeline blocks={timelineBlocks} liveReasoning={engineeringThreadActive ? liveReasoning : ''} live={engineeringThreadActive ? liveAssistant : ''} activeThreadId={timelineThreadId} runtimeConnection={runtimeConnection} runtimeError={error ? surveyRuntimeErrorText(error, i18n.language) : error} onRetryConnection={retryRuntime} onOpenSettings={() => openSettings('agents')} onSelectSuggestion={setGoal} /> :
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-5 py-6 text-center" data-testid="engineering-ai-empty-state">
          <Bot className="h-7 w-7 shrink-0 text-accent" />
          <h2 className="mt-3 text-[18px] font-semibold">{project ? t('engineeringAiTitle') : t('engineeringNoProject')}</h2>
          {!project ? <button type="button" onClick={onCreateProject} disabled={!connected} className="mt-4 inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-50"><Plus className="h-4 w-4" />{t('engineeringActionCreateProject')}</button> : !compact ? <div className="mt-4 flex flex-wrap justify-center gap-2"><button type="button" onClick={() => setGoal(t('engineeringQuestionPrecision'))} className="px-2 py-1 text-[12px] text-ds-muted hover:text-accent">{t('engineeringQuestionPrecision')}</button><button type="button" onClick={() => setGoal(t('engineeringQuestionResults'))} className="px-2 py-1 text-[12px] text-ds-muted hover:text-accent">{t('engineeringQuestionResults')}</button></div> : null}
        </div>}
    </div>
    <EngineeringProjectSuggestions key={`${projectId}:${timelineThreadId}`} projectId={projectId} threadId={timelineThreadId} connected={connected} busy={busy} refreshKey={lastSeq} onRefresh={onRefresh} />
    {scopedPlan ? <section className="max-h-[35%] shrink-0 overflow-y-auto border-t border-ds-border-muted" aria-label={t('engineeringTypedPlan')}>
      <button type="button" aria-expanded={showPlan} onClick={() => setShowPlan(!showPlan)} className="flex min-h-10 w-full items-center gap-2 px-3 text-left text-[12px]"><ClipboardList className="h-4 w-4 shrink-0 text-accent" /><span className="min-w-0 flex-1 truncate">{t('engineeringTypedPlan')}</span><span className="text-ds-muted">{phaseLabel(planStatus ?? scopedPlan.status, t)}</span><ChevronDown className={`h-4 w-4 ${showPlan ? 'rotate-180' : ''}`} /></button>
      {showPlan ? <div className="space-y-2 px-3 pb-3">
        <p className="break-words text-[12px] font-medium">{scopedPlan.goal}</p>
        {scopedPlan.steps.map((step, index) => <div key={step.id} className="border-b border-ds-border-muted pb-2 text-[12px]" data-testid="engineering-plan-step-review" data-step-id={step.id} data-step-state={planSteps[index]?.state}>
          <label className="flex items-start gap-2">
            {needsApproval && step.risk !== 'read' ? <input type="checkbox" checked={approvedSteps.includes(step.id)} onChange={(event) => setApprovedSteps((current) => event.target.checked ? [...current, step.id] : current.filter((id) => id !== step.id))} className="mt-0.5" /> : null}
            <span className="min-w-0 break-words">{surveyLegacyDiagnosticText(step.title, i18n.language)}<span className="ml-2 text-[11px] text-ds-muted">{step.risk === 'read' ? t('engineeringRiskRead') : t('engineeringRiskApproval')}</span></span>
          </label>
          <p className={`mt-1 flex items-center gap-1 text-[11px] ${planSteps[index]?.state === 'done' ? 'text-green-700 dark:text-green-300' : planSteps[index]?.state === 'blocked' ? 'text-amber-700 dark:text-amber-300' : 'text-ds-muted'}`}>
            {planSteps[index]?.state === 'done' ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : planSteps[index]?.state === 'blocked' ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <Circle className="h-3.5 w-3.5 shrink-0" />}
            {t(planSteps[index]?.state === 'done' ? 'engineeringPlanStepReceiptConfirmed' : planSteps[index]?.state === 'blocked' ? 'engineeringPlanStepReceiptMissing' : 'engineeringPlanStepReceiptPending')}
          </p>
          <dl className="mt-2 space-y-1 break-words text-[11px]">
            <div><dt className="inline text-ds-muted">{t('engineeringPlanTool')}: </dt><dd className="inline font-mono">{step.tool}</dd></div>
            <div><dt className="text-ds-muted">{t('engineeringPlanParameters')}</dt><dd><pre className="whitespace-pre-wrap break-all">{step.parameters ? JSON.stringify(step.parameters, null, 2) : t('engineeringPlanDetailsMissing')}</pre>{step.parameterBindings?.map(binding => <p key={binding.parameter} className="break-all font-mono">{binding.parameter} ← {binding.stepId}.{binding.output}{binding.asArray ? ' []' : ''}</p>)}</dd></div>
            <div><dt className="inline text-ds-muted">{t('engineeringPlanOutputs')}: </dt><dd className="inline">{step.expectedOutputs?.map(output => t(`engineeringPlanOutput.${output}`, { defaultValue: output })).join(' · ') ?? t('engineeringPlanDetailsMissing')}</dd></div>
            <div><dt className="inline text-ds-muted">{t('engineeringPlanReversibility')}: </dt><dd className="inline">{step.reversibility ? t(`engineeringPlanReversal.${step.reversibility}`, { defaultValue: step.reversibility }) : t('engineeringPlanDetailsMissing')}</dd></div>
          </dl>
          {navigationButton(navigationContext && scopedPlan.status !== 'stale' ? planStepNavigationTarget(navigationContext, scopedPlan.projectId, step) : null)}
        </div>)}
        {!planReviewComplete ? <p role="status" className="text-[11px] text-amber-700 dark:text-amber-300">{t('engineeringPlanDetailsMissing')}</p> : null}
        {planStatus === 'needs_attention' && !hasCompleteExecutionEvidence(scopedPlan) ? <p role="status" data-testid="engineering-plan-incomplete-evidence" className="text-[11px] text-amber-700 dark:text-amber-300">{t('engineeringPlanExecutionIncomplete', { completed: completedStepCount, total: scopedPlan.steps.length })}</p> : null}
        <p className="break-all font-mono text-[10px] text-ds-faint">{scopedPlan.id} · {scopedPlan.contextHash.slice(0, 22)}</p>
        {taskDiagnostic ? <p data-testid="engineering-task-diagnostic" className="break-words text-[11px] text-amber-700 dark:text-amber-300">{formatRuntimeError(new Error(taskDiagnostic), t('engineeringStatusNeedsAttention'))}</p> : null}
        {planReviewComplete && (needsApproval || scopedPlan.status === 'approved') ? <button type="button" onClick={() => void approveAndStartPlan()} disabled={planBusy || busy || !connected || !engineeringThreadActive || (needsApproval && !riskConfirmed)} className="inline-flex h-8 items-center gap-2 rounded-md bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-50">{planBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{t('engineeringApproveAndStart')}</button> : null}
        {canResumePlan ? <button type="button" data-testid="engineering-resume" onClick={() => void resumeExecutionPlan()} disabled={planBusy} className="inline-flex h-8 items-center gap-2 rounded-md bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-50">{planBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{t('engineeringResumePlan')}</button> : null}
        {canReplan ? <button type="button" data-testid="engineering-replan" onClick={() => void replanStalePlan()} disabled={planBusy || busy || !connected || !engineeringThreadActive} className="inline-flex h-8 items-center gap-2 rounded-md bg-accent px-3 text-[12px] font-medium text-white disabled:opacity-50">{planBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{planBusy ? t('engineeringReplanning') : t('engineeringReplan')}</button> : null}
      </div> : null}
    </section> : null}
    {selectedEvidence ? <div className="shrink-0 border-t border-ds-border-muted px-3 py-1 text-[11px]"><span>{t('engineeringEvidenceLocated')}</span>{navigationButton(selectedTarget)}</div> : null}
    {evidenceCards.length ? <details className="max-h-[20%] shrink-0 overflow-y-auto border-t border-ds-border-muted px-3 py-2 text-[11px]"><summary className="cursor-pointer text-ds-muted"><FileCheck2 className="mr-1 inline h-3.5 w-3.5" />{t('engineeringEvidenceReturn')} ({evidenceCards.length})</summary>{evidenceCards.map((card) => <div key={card.id} className="mt-2 break-words"><p className="font-medium">{surveyLegacyDiagnosticText(card.title, i18n.language)}</p><p className="text-ds-muted">{surveyLegacyDiagnosticText(card.summary, i18n.language)}</p>{navigationButton(navigationContext ? evidenceCardNavigationTarget(navigationContext, card) : null)}</div>)}</details> : null}
    <div className="flex shrink-0 justify-center px-3 pb-3 pt-2"><EngineeringComposer workspaceRoot={workspaceRoot} projectId={projectId} ready={connected} threadId={timelineThreadId} unavailableReason={connectionMessage} onSurveyFiles={onSurveyFiles} /></div>
  </section>
}
