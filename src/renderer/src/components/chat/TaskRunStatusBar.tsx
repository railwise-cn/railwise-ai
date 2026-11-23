import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { AlertTriangle, CheckCircle2, FileText, Loader2, PauseCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TaskAttentionV1, TaskInputV1, TaskOperationReceiptV1, TaskRunStatus, TaskRunV1 } from '@shared/agent-workbench'
import type { ExternalTaskCapabilityCard } from '@shared/task-command'
import { currentTaskBranch } from '@shared/task-projection'
import { groupWorkspaceTasks, taskGroupArtifacts, type TaskWorkspaceTaskGroup } from '@shared/task-workspace-projection'
import { isExecutionGrantExpiredCapability, isMatchingExecutionGrantExpiredAttention, taskDisplayTitle, taskProgressReason } from '@shared/task-presentation'
import { taskArtifactValidationLabelKey } from '@shared/task-artifact-source-evidence'
import { refreshTaskState, useTaskState } from '../../store/task-live-store'
import { projectTaskRunActivity, taskReasonKey } from '../../agent/ag-ui-activity'
import { getProvider } from '../../agent/registry'
import type { ChatBlock, ThreadTodoList } from '../../agent/types'
import { foregroundTaskArtifactPreview } from '../../lib/use-task-artifact-preview'
import { TaskAttentionCard, type TaskComposerQuestion } from '../tasks/TaskAttentionCard'
import { TaskBudgetControl } from '../tasks/TaskBudgetControl'
import { TaskExecutionEvidence } from '../tasks/TaskExecutionEvidence'
import { TaskPublicQueryRecoveryCard } from '../tasks/TaskPublicQueryRecoveryCard'
import { AssistantMarkdown } from './AssistantMarkdown'
import { capabilityCardMatchesAttention } from './CapabilityRequiredCard'
import { ConversationChecklistDetails } from './ConversationChecklist'
import { redactRuntimeText } from './conversation-visibility'

type Props = {
  threadId: string | null
  runtimeReady: boolean
  linkedTask?: { id: string; threadId: string }
  conversationControls?: readonly ChatBlock[]
  composerReplies?: boolean
  inlineCapabilityCards?: readonly ExternalTaskCapabilityCard[]
  inlineRequests?: readonly string[]
  visibleMessageIds?: ReadonlySet<string>
  onSupplement?: () => void
  onPickAttachments?: () => void
  onComposerQuestionChange?: (question: TaskComposerQuestion | null) => void
  onOpenArtifact?: (task: TaskRunV1, artifact: TaskRunV1['artifacts'][number]) => void | Promise<void>
}

type TaskAction = 'resume' | 'retry' | 'pause' | 'cancel'
type RevisionRequest = { expectedRevision: number; idempotencyKey: string }
const ACTIVE_STATUSES = new Set<TaskRunStatus>(['queued', 'running', 'retrying'])
const TERMINAL_STATUSES = new Set<TaskRunStatus>(['completed', 'failed', 'cancelled'])
const EMPTY_CONTROLS: readonly ChatBlock[] = []
const taskButtonClass = 'max-w-full rounded-md border border-ds-border px-2.5 py-1.5 text-left text-xs font-medium hover:bg-ds-hover disabled:opacity-50'

type AnsweredTaskQuestion = { requestId: string; question: string; answer: string }

function answeredQuestionsFromThread(thread: unknown, inputs: TaskInputV1[]): AnsweredTaskQuestion[] {
  if (!thread || typeof thread !== 'object' || !('turns' in thread) || !Array.isArray(thread.turns)) return []
  const answers = new Map(inputs.filter(input => input.kind === 'supplement' && input.idempotencyKey.startsWith('user-input:'))
    .map(input => [input.idempotencyKey.slice('user-input:'.length), input.text]))
  const result: AnsweredTaskQuestion[] = []
  for (const turn of thread.turns) {
    if (!turn || typeof turn !== 'object' || !('items' in turn) || !Array.isArray(turn.items)) continue
    for (const item of turn.items) {
      if (!item || typeof item !== 'object' || !('kind' in item) || item.kind !== 'user_input' ||
        !('inputId' in item) || typeof item.inputId !== 'string' || !('questions' in item) || !Array.isArray(item.questions) || item.questions.length !== 1) continue
      const question = item.questions[0]
      if (!question || typeof question !== 'object' || !('question' in question) || typeof question.question !== 'string' ||
        !('options' in question) || !Array.isArray(question.options) || question.options.length > 0) continue
      const answer = answers.get(item.inputId)
      if (answer === undefined) continue
      result.push({ requestId: item.inputId, question: question.question, answer })
    }
  }
  return result
}

export function taskProgress(task: TaskRunV1): { completed: number; total: number } {
  return { completed: task.nodes.filter((node) => node.status === 'completed').length, total: task.nodes.length }
}

export function taskNeedsAttention(task: TaskRunV1): boolean {
  return ['stalled', 'waiting_user', 'waiting_approval', 'failed'].includes(task.status)
}

function pendingForBranch(members: TaskRunV1[], attention: readonly TaskAttentionV1[], allowThreadFallback = true): TaskAttentionV1[] {
  return attention.filter(item => item.status === 'pending' && members.some(owner => !TERMINAL_STATUSES.has(owner.status) &&
    (item.taskId ? item.taskId === owner.id : allowThreadFallback && item.threadId && item.threadId === owner.threadId)))
}

function isInTimeline(item: TaskAttentionV1, { inlineRequests, inlineCapabilityCards }: Pick<Props, 'inlineRequests' | 'inlineCapabilityCards'>): boolean {
  return Boolean(inlineRequests?.includes(item.id) || item.requestId && inlineRequests?.includes(item.requestId) ||
    inlineCapabilityCards?.some(card => capabilityCardMatchesAttention(card, item)))
}

export function TaskRunStatusBar(props: Props): ReactElement | null {
  const live = useTaskState(props.runtimeReady)
  const linkedId = props.linkedTask?.threadId === props.threadId ? props.linkedTask?.id : undefined
  const groups = useMemo(() => props.threadId ? groupWorkspaceTasks(live.tasks).filter(({ root, all }) =>
    !root.parentTaskId && root.visible !== false && !['chat', 'internal'].includes(root.visibility ?? '') &&
    (root.originThreadId === props.threadId || root.threadId === props.threadId || all.some(item => item.id === linkedId))) : [],
  [live.tasks, props.threadId, linkedId])
  const primary = groups.find(({ all }) => all.some(item => item.id === (linkedId ?? live.navigation.selectedTaskId))) ?? groups[0]
  const conversationControls = (props.threadId && props.conversationControls) || EMPTY_CONTROLS
  const presented = useMemo(() => ({
    inlineRequests: props.inlineRequests ?? conversationControls.flatMap(block => {
      if (block.kind === 'approval') return [block.approvalId]
      if (block.kind === 'user_input') return [block.requestId]
      if (block.kind === 'assistant' && block.intentCard) return [block.intentCard.attentionId]
      return []
    }),
    inlineCapabilityCards: props.inlineCapabilityCards ?? conversationControls.flatMap(block =>
      block.kind === 'assistant' && block.capabilityCard ? [block.capabilityCard] : [])
  }), [conversationControls, props.inlineRequests, props.inlineCapabilityCards])

  if (!primary) return null
  const otherActive = groups.filter(group => {
    if (group === primary) return false
    const branch = currentTaskBranch(group.all, group.root)
    return ACTIVE_STATUSES.has(branch.current.status) || branch.current.status === 'paused' ||
      pendingForBranch(branch.members, live.attention, false).some(item => !isInTimeline(item, presented))
  })
  const current = primary ? [primary, ...otherActive] : []
  return <div className="min-w-0 border-l border-ds-border-muted pl-3 empty:hidden">
    {current.map(group => <ConversationTask key={group.root.id} {...props} {...presented} group={group} live={live}
      composerReplies={props.composerReplies && current.length === 1}
      showTitle={current.length > 1} isPrimary={group === primary} />)}
  </div>
}

function ConversationTask({ group, live, threadId, runtimeReady, inlineCapabilityCards, inlineRequests, composerReplies, visibleMessageIds, onSupplement, onPickAttachments, onComposerQuestionChange, onOpenArtifact, showTitle, isPrimary }: Props & {
  group: TaskWorkspaceTaskGroup
  live: ReturnType<typeof useTaskState>
  showTitle: boolean
  isPrimary: boolean
}): ReactElement {
  const { t } = useTranslation('common')
  const { current: task, members } = currentTaskBranch(group.all, group.root)
  const pending = pendingForBranch(members, live.attention, isPrimary)
  const onlyAttention = pending.length === 1 ? pending[0] : undefined
  const attentionKind = onlyAttention?.kind
  const attentionId = onlyAttention?.requestId
  const attentionTitle = onlyAttention?.title
  const attentionQuestions = onlyAttention?.payload?.questions
  const questionForHistory = isPrimary && onlyAttention?.kind === 'question' && Array.isArray(attentionQuestions) && attentionQuestions.length === 1
    ? attentionQuestions[0] as Record<string, unknown> : undefined
  const questionHistoryRequestId = typeof onlyAttention?.requestId === 'string' && questionForHistory &&
    (!Array.isArray(questionForHistory.options) || questionForHistory.options.length === 0) ? onlyAttention.requestId : undefined
  const questionHistoryText = questionForHistory
    ? (typeof questionForHistory.label === 'string' ? questionForHistory.label
      : typeof questionForHistory.question === 'string' ? questionForHistory.question : onlyAttention?.message)
    : undefined
  const [answeredQuestions, setAnsweredQuestions] = useState<AnsweredTaskQuestion[]>([])
  const questionHistoryLoadKey = useRef('')
  const taskQuestion = useMemo(() => {
    if (!composerReplies || !['waiting_user', 'paused'].includes(task.status) || !task.activeTurnId || attentionKind !== 'question' ||
      !threadId || !attentionId || !Array.isArray(attentionQuestions) || attentionQuestions.length !== 1) return null
    const value = attentionQuestions[0]
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') return null
    const record = value as Record<string, unknown>
    if (Array.isArray(record.options) && record.options.length > 0) return null
    return { taskId: task.id, threadId, requestId: attentionId, questionId: value.id,
      label: typeof record.label === 'string' ? record.label : typeof record.question === 'string' ? record.question : attentionTitle ?? '需要补充信息' }
  }, [attentionId, attentionKind, attentionQuestions, attentionTitle, composerReplies, task.activeTurnId, task.id, task.status, threadId])
  useEffect(() => {
    if (!onComposerQuestionChange) return
    onComposerQuestionChange(taskQuestion)
    return () => onComposerQuestionChange(null)
  }, [onComposerQuestionChange, taskQuestion])
  useEffect(() => {
    if (!runtimeReady || !task.threadId || typeof window.workwise?.runtimeRequest !== 'function' ||
      typeof window.workwise.listTaskInputs !== 'function') return
    const loadKey = [task.id, task.threadId, task.activeTurnId ?? '', task.status, questionHistoryRequestId ?? ''].join(':')
    if (questionHistoryLoadKey.current === loadKey) return
    questionHistoryLoadKey.current = loadKey
    let active = true
    void Promise.all([
      window.workwise.runtimeRequest(`/v1/threads/${encodeURIComponent(task.threadId)}`, 'GET'),
      window.workwise.listTaskInputs(task.id)
    ]).then(([threadResponse, inputs]) => {
      if (!active) return
      const history = threadResponse.ok
        ? answeredQuestionsFromThread(JSON.parse(threadResponse.body), inputs)
        : []
      if (questionHistoryRequestId && questionHistoryText) {
        const answer = inputs.find(input => input.kind === 'supplement' && input.idempotencyKey === `user-input:${questionHistoryRequestId}`)?.text
        if (answer !== undefined && !history.some(item => item.requestId === questionHistoryRequestId)) {
          history.push({ requestId: questionHistoryRequestId, question: questionHistoryText, answer })
        }
      }
      setAnsweredQuestions(history)
    }).catch(() => {
      if (questionHistoryLoadKey.current === loadKey) questionHistoryLoadKey.current = ''
    })
    return () => { active = false }
  }, [questionHistoryRequestId, questionHistoryText, runtimeReady, task.activeTurnId, task.id, task.status, task.threadId])
  const isInline = (item: TaskAttentionV1): boolean => isInTimeline(item, { inlineRequests, inlineCapabilityCards })
  const remainingAttention = pending.filter(item => {
    if (isInline(item)) return false
    if (item.kind === 'approval' || item.kind === 'question') return true
    if (item.payload?.kind !== 'capability_required') return ['task_input_intent', 'external_provider_choice'].includes(String(item.payload?.kind))
    if (!isExecutionGrantExpiredCapability(item.payload.capability)) return true
    const owner = members.find(member => member.id === item.taskId)
    return Boolean(owner && taskProgressReason(owner, '') === item.message && isMatchingExecutionGrantExpiredAttention(item, owner))
  })
  const artifacts = taskGroupArtifacts(group)
  const legacyWorkerResponse = task.status === 'completed' && task.threadId !== threadId &&
    !visibleMessageIds?.has(`item_command_task_result_${task.id}_receipt`) ? task.finalResponse : undefined
  const sample = live.progress?.[task.id]
  const workerThreadId = task.threadId === threadId ? undefined : task.threadId
  const [workerChecklist, setWorkerChecklist] = useState<ThreadTodoList | null>(null)
  const checklist = workerChecklist?.threadId === workerThreadId ? workerChecklist : null
  // The worker records steps on its own thread. Read the snapshot on durable
  // changes and on the existing progress feed without opening its approval stream.
  useEffect(() => {
    if (!runtimeReady || !workerThreadId) return
    let active = true
    void getProvider().getThreadTodos?.(workerThreadId).then(todos => {
      if (active && (!todos || todos.threadId === workerThreadId)) setWorkerChecklist(todos)
    }).catch(() => undefined)
    return () => { active = false }
  }, [runtimeReady, workerThreadId, task.revision, sample?.sampledAt])
  const activity = projectTaskRunActivity(task, sample, artifacts.length, pending, artifacts.map(entry => ({ taskId: entry.task.id, artifactId: entry.artifact.id })))
  const running = ACTIVE_STATUSES.has(task.status)
  const actions = task.presentation?.actions
  const verify = actions?.includes('verify') || pending.some(item => item.presentation?.actions.includes('verify'))
  const needsReview = pending.length > 0
  const canReplyInComposer = isPrimary && composerReplies && ['waiting_user', 'paused'].includes(task.status) && Boolean(task.activeTurnId) &&
    (!task.presentation || task.presentation.reason === 'input_required') && pending.length === 1
  const canResume = !verify && (task.status === 'paused' || !needsReview && (actions?.includes('resume') ?? ['stalled', 'waiting_user'].includes(task.status)))
  const canRetry = !verify && !needsReview && (actions?.includes('retry') ?? task.status === 'failed')
  const canSupplement = !verify && !(pending.some(item => item.kind === 'question' || item.kind === 'approval')) &&
    (actions?.includes('supplement') || !actions && ['stalled', 'waiting_user', 'paused'].includes(task.status))
  const canPickSource = canSupplement || pending.some(item => item.kind === 'approval' &&
    (item.presentation?.scope === 'host' || item.message.startsWith('Run request_host_shell\n')))
  const [busy, setBusy] = useState<TaskAction | null>(null)
  const inFlight = useRef(false)
  const requests = useRef(new Map<string, RevisionRequest>())
  const [message, setMessage] = useState('')
  const [acknowledgement, setAcknowledgement] = useState<{ text: string; taskId: string; turnId?: string; status: TaskRunStatus }>()
  const [resultsOpen, setResultsOpen] = useState(false)
  const [verifyOpen, setVerifyOpen] = useState(false)
  const notice = message || (acknowledgement?.taskId === task.id && acknowledgement.turnId === task.activeTurnId &&
    acknowledgement.status === task.status ? acknowledgement.text : '')
  const acknowledge = (text: string): void => {
    setAcknowledgement({ text, taskId: task.id, turnId: task.activeTurnId, status: task.status })
  }
  const disabled = !runtimeReady || Boolean(live.error) || Boolean(busy)
  const rawReason = taskProgressReason(task, t('taskApprovalReviewHint'))
  const legacyReason = rawReason && !/\n|request_host_shell|SHA256|[a-f0-9]{48,}|(?:^|\s)\{/i.test(rawReason) ? redactRuntimeText(rawReason) : undefined
  const capability = pending.find(item => item.taskId === task.id && item.payload?.kind === 'capability_required')?.payload?.capability
  const reason = pending.some(isInline) || remainingAttention.some(item => item.kind === 'question' || item.kind === 'approval') ? undefined :
    task.status === 'waiting_user' && isExecutionGrantExpiredCapability(capability) && rawReason === capability.message
      ? t('capabilityExecutionGrantExpiredSummary')
      : activity?.presentation?.reason && (task.presentation || !legacyReason) ? t(taskReasonKey(activity.presentation.reason)) : legacyReason
  const statusIcon = running ? <Loader2 className="h-4 w-4 animate-spin" /> : task.status === 'completed' ? <CheckCircle2 className="h-4 w-4" /> :
    taskNeedsAttention(task) ? <AlertTriangle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />

  const run = async (action: TaskAction): Promise<void> => {
    if (disabled || inFlight.current) return
    inFlight.current = true
    setBusy(action)
    setMessage('')
    setAcknowledgement(undefined)
    const key = `${task.id}:${action}`
    const request = requests.current.get(key) ?? { expectedRevision: task.revision, idempotencyKey: crypto.randomUUID() }
    requests.current.set(key, request)
    try {
      const api = window.workwise
      if (action === 'resume' || action === 'retry') {
        const result = await (action === 'resume' ? api.resumeTask(task.id, request) : api.retryTask(task.id, request))
        if (!result.capability) acknowledge(t('taskWorkspaceResumeSubmitted'))
        if (result.turn && threadId) foregroundTaskArtifactPreview(threadId, result.task.id)
      } else if (action === 'pause') await api.pauseTask(task.id, request)
      else await api.cancelTask(task.id, request)
      requests.current.delete(key)
      await refreshTaskState()
    } catch (error) {
      if ((error as { status?: number })?.status === 409) requests.current.delete(key)
      setMessage(t('taskWorkspaceActionFailed'))
      await refreshTaskState()
    } finally {
      setBusy(null)
      inFlight.current = false
    }
  }

  const openArtifact = async (owner: TaskRunV1, artifact: TaskRunV1['artifacts'][number]): Promise<void> => {
    setMessage('')
    try {
      if (/\.html?$/i.test(artifact.relativePath) && onOpenArtifact) await onOpenArtifact(owner, artifact)
      else {
        const result = artifact.absolutePath || artifact.storage === 'task'
          ? await window.workwise.openTaskArtifact({ taskId: owner.id, artifactId: artifact.id })
          : await window.workwise.openWorkspaceFile({ workspaceRoot: owner.workspaceRoot, path: artifact.relativePath })
        if (!result.ok) {
          const message = result.message?.trim()
          const safeMessage = message ? redactRuntimeText(message) : ''
          setMessage(safeMessage || t('taskWorkspaceActionFailed'))
        }
      }
    } catch { setMessage(t('taskWorkspaceActionFailed')) }
  }

  const onResolved = (notice?: string): void => {
    if (notice) acknowledge(notice)
    void refreshTaskState()
  }

  if (task.status === 'completed' && !artifacts.length && !legacyWorkerResponse && !notice) {
    return <ConversationChecklistDetails checklist={checklist} />
  }

  return <section aria-label={showTitle ? taskDisplayTitle(group.root) : t('taskWorkspaceTitle')} className="min-w-0 text-ds-ink [&+section]:border-t [&+section]:border-ds-border-muted">
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
      {showTitle ? <span className="min-w-0 truncate text-xs font-medium text-ds-ink">{taskDisplayTitle(group.root)}</span> : null}
      <span role="status" className="inline-flex items-center gap-1.5 text-xs font-semibold">
        <span aria-hidden="true">{statusIcon}</span>{t(`taskRunStatus_${activity?.status ?? task.status}`)}
      </span>
      {running && activity?.phase ? <span className="text-xs text-ds-muted">{t(`taskActivity_${activity.phase}`)}</span> : null}
      {reason ? <span className="min-w-0 flex-1 break-words text-xs text-ds-muted">{reason}</span> : <span className="flex-1" />}
      {artifacts.length > 0 ? <button type="button" aria-expanded={resultsOpen} onClick={() => setResultsOpen(open => !open)} className={taskButtonClass}>{t('taskWorkspaceArtifactCount', { count: artifacts.length })}</button> : null}
      {canResume ? <button type="button" disabled={disabled} onClick={() => void run('resume')} className={taskButtonClass}>{t('taskRunResume')}</button> : null}
      {canRetry ? <button type="button" disabled={disabled} onClick={() => void run('retry')} className={taskButtonClass}>{t('taskRunRetry')}</button> : null}
      {canSupplement && onSupplement ? <button type="button" disabled={disabled} onClick={onSupplement} className={taskButtonClass}>{t('taskWorkspaceSupplement')}</button> : null}
      {canPickSource && onPickAttachments ? <button type="button" disabled={disabled} onClick={onPickAttachments} className={taskButtonClass}>{t('taskWorkspaceAttachmentPick')}</button> : null}
      {verify ? <button type="button" aria-expanded={verifyOpen} onClick={() => setVerifyOpen(open => !open)} className={taskButtonClass}>{t('taskEffectVerifyResult')}</button> : null}
      {running ? <button type="button" disabled={disabled} onClick={() => void run('pause')} className={taskButtonClass}>{t('taskWorkspacePause')}</button> : null}
      {!TERMINAL_STATUSES.has(task.status) ? <button type="button" disabled={disabled} onClick={() => void run('cancel')} className={taskButtonClass}>{t('taskRunCancel')}</button> : null}
    </div>
    {answeredQuestions.length > 0 ? <div aria-label={t('taskRunQuestionHistory')} className="space-y-0.5 pb-1 text-xs text-ds-muted">
      {answeredQuestions.map(item => <div key={item.requestId} className="min-w-0 break-words">
        <p><span className="font-medium">{t('taskRunQuestionLabel')}</span> {item.question}</p>
        <p><span className="font-medium">{t('taskRunAnswerLabel')}</span> {item.answer}</p>
      </div>)}
    </div> : null}
    {remainingAttention.length || resultsOpen || verifyOpen || legacyWorkerResponse ? <div className="space-y-1 pb-1">
      {remainingAttention.map(item => <TaskAttentionCard key={`${item.id}:${item.revision}`} item={item} ownerTask={members.find(owner => owner.id === item.taskId)}
        conversationThreadId={threadId ?? undefined} onResolved={onResolved} replyInComposer={canReplyInComposer} />)}
      {resultsOpen ? <ul className="space-y-1" aria-label={t('taskRunArtifacts')}>{artifacts.map(({ task: owner, artifact }) => <li key={`${owner.id}:${artifact.id}`} className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <button type="button" onClick={() => void openArtifact(owner, artifact)} className="inline-flex min-w-0 items-center gap-1.5 text-left text-accent hover:underline">
          <FileText className="h-3.5 w-3.5 shrink-0" /><span className="break-all">{artifact.relativePath.split(/[\\/]/).at(-1)}</span>
        </button>
        <span className="text-ds-muted">{t(taskArtifactValidationLabelKey(owner, artifact))}</span>
      </li>)}</ul> : null}
      {verify && verifyOpen ? <ConversationTaskVerification task={task} runtimeReady={runtimeReady} onNotice={setMessage} /> : null}
      {legacyWorkerResponse ? <details open className="text-xs text-ds-muted">
        <summary className="cursor-pointer py-1">{t('taskWorkspaceResult')}</summary>
        <AssistantMarkdown text={legacyWorkerResponse} streaming={false} workspaceRoot={task.workspaceRoot} restricted className="ds-markdown min-w-0 break-words text-sm text-ds-ink" />
      </details> : null}
    </div> : null}
    <ConversationChecklistDetails checklist={checklist} />
    {actions?.includes('extend_budget') ? <TaskBudgetControl task={task} onChanged={refreshTaskState} /> : null}
    {notice || live.error ? <p role="status" className="pb-1 text-xs text-ds-muted">{notice || t('taskRunUnavailable')}</p> : null}
  </section>
}

function ConversationTaskVerification({ task, runtimeReady, onNotice }: { task: TaskRunV1; runtimeReady: boolean; onNotice: (message: string) => void }): ReactElement {
  const { t } = useTranslation('common')
  const [receipts, setReceipts] = useState<TaskOperationReceiptV1[]>([])
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!runtimeReady) return
    let active = true
    void window.workwise.listTaskOperationReceipts(task.id).then(items => {
      if (active) { setReceipts(items); setError(false) }
    }).catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [runtimeReady, task.id, task.revision])
  const revision = (): RevisionRequest => ({ expectedRevision: task.revision, idempotencyKey: crypto.randomUUID() })
  return <>
    <TaskPublicQueryRecoveryCard task={task} runtimeReady={runtimeReady} onChanged={refreshTaskState} onNotice={onNotice} />
    {error ? <p role="status" className="text-xs text-ds-muted">{t('taskRunUnavailable')}</p> : null}
    <TaskExecutionEvidence task={task} relatedTasks={[task]} compact receipts={receipts} onVerify={async receipt => {
      const result = await window.workwise.verifyTaskOperationReceipt(task.id, receipt.id, revision())
      if (!result.browserReview) await refreshTaskState()
      return result
    }} onConfirmBrowser={async (receipt, reviewId, decision) => {
      const response = await window.workwise.runtimeRequest(`/v1/tasks/${encodeURIComponent(task.id)}/receipts/${encodeURIComponent(receipt.id)}/browser-confirm`, 'POST', JSON.stringify({ ...revision(), reviewId, decision }))
      if (!response.ok) return { taskId: task.id, receiptId: receipt.id, status: 'outcome_unknown', errorCode: 'browser_review_unavailable' }
      await refreshTaskState()
      return JSON.parse(response.body)
    }} />
  </>
}
