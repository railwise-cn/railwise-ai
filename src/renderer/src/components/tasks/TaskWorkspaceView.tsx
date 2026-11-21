import { useTaskState, refreshTaskState, takeRequestedTask, updateTaskNavigation } from '../../store/task-live-store'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react'
import { CheckCircle2, ChevronRight, FileText, Loader2, MessageSquare, Paperclip, Pause, Play, Plus, RefreshCw, Square, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TaskAttentionV1, TaskEventV1, TaskInputV1, TaskOperationReceiptV1, TaskPublicQueryRecoverySnapshotV1, TaskRunV1, TaskTemplateId, TaskTemplateStartV1, TaskTemplateV1 } from '@shared/agent-workbench'
import { SidebarTitlebarToggleButton } from '../sidebar/SidebarPrimitives'
import { TaskArtifactReview } from './TaskArtifactReview'
import { TaskAttentionCard } from './TaskAttentionCard'
import { AssistantMarkdown } from '../chat/AssistantMarkdown'
import { TaskExecutionEvidence } from './TaskExecutionEvidence'
import { currentTaskBranch } from '@shared/task-projection'
import { taskDisplayGoal, taskDisplayTitle } from '@shared/task-presentation'
import { taskArtifactValidationLabelKey } from '@shared/task-artifact-source-evidence'
import { redactRuntimeText } from '../chat/conversation-visibility'
import { filterWorkspaceTasks, taskGroupForTask, taskGroupArtifacts, scopeWorkspaceTasks } from '@shared/task-workspace-projection'
export { filterWorkspaceTasks, groupWorkspaceTasks, taskGroupProgress } from '@shared/task-workspace-projection'
import { legacyLocalArtifactSourceMismatch } from '@shared/task-source-intent'
import { TaskBudgetControl } from './TaskBudgetControl'
import { TaskPublicQueryRecoveryCard } from './TaskPublicQueryRecoveryCard'
import { TaskPermissionPanel } from '../chat/TaskPermissionPanel'
import { useChatStore } from '../../store/chat-store'
import { foregroundTaskArtifactPreview } from '../../lib/use-task-artifact-preview'
import { projectTaskRunActivity, taskReasonKey } from '../../agent/ag-ui-activity'
import { attachmentImportErrorKey, isChatDocumentAttachment } from '../../lib/attachment-selection'

type Props = {
  workspaceRoot: string
  runtimeReady: boolean
  leftSidebarCollapsed: boolean
  onToggleLeftSidebar: () => void
  onOpenThread: (threadId: string) => void
  onOpenArtifact: (task: TaskRunV1, relativePath: string, artifactId?: string) => void | Promise<void>
  onOpenFlow?: (flowId?: string, flowRunId?: string) => void
  onConfigureProvider?: (provider: string) => void
  onConfigureReplyDelivery?: () => void
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const Spreadsheet = lazy(() => import('../WorkspaceSpreadsheet').then(module => ({ default: module.WorkspaceSpreadsheet })))

// An explicit owner must never be replaced by another task sharing its thread.
function attentionMatchesTask(item: TaskAttentionV1, task: TaskRunV1): boolean {
  return item.taskId ? item.taskId === task.id : Boolean(item.threadId && item.threadId === task.threadId)
}

function retryAncestorIds(current: TaskRunV1, tasks: TaskRunV1[]): Set<string> {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const ancestors = new Set<string>(), seen = new Set([current.id])
  let previousId = current.retryOfTaskId
  while (previousId) {
    const previous = byId.get(previousId)
    // Incomplete or cyclic lineage cannot establish that an old capability was superseded.
    if (!previous || seen.has(previousId)) return new Set()
    seen.add(previousId); ancestors.add(previousId)
    previousId = previous.retryOfTaskId
  }
  return ancestors
}

// A stored running node is historical while its execution task is waiting or stopped.
function nodeStatusLabelKey(taskStatus: TaskRunV1['status'], nodeStatus: TaskRunV1['nodes'][number]['status']): string {
  if (nodeStatus !== 'running') return `taskNodeStatus_${nodeStatus}`
  if (taskStatus === 'failed' || taskStatus === 'cancelled') return 'taskNodeExecutionStopped'
  if (taskStatus === 'completed') return 'taskNodeExecutionNeedsReview'
  if (taskStatus === 'stalled') return 'taskNodeStatus_blocked'
  if (['paused', 'waiting_user', 'waiting_approval', 'queued'].includes(taskStatus)) return `taskRunStatus_${taskStatus}`
  return 'taskNodeStatus_running'
}
const BUILTIN_TEMPLATES: TaskTemplateV1[] = [
  { id: 'monitoring-report', name: 'Monitoring report', description: 'Check sources and data, then produce a cited report.', stages: [], outputs: [], requiredInputs: [] },
  { id: 'tender-document', name: 'Tender document', description: 'Build a response matrix and draft a checked technical file.', stages: [], outputs: [], requiredInputs: [] },
  { id: 'research-document', name: 'Research and documents', description: 'Turn selected sources into cited, editable documents.', stages: [], outputs: [], requiredInputs: [] }
]

function operationKey(): string {
  return globalThis.crypto.randomUUID()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value
}

export function TaskWorkspaceView({ workspaceRoot, runtimeReady, leftSidebarCollapsed, onToggleLeftSidebar, onOpenThread, onOpenArtifact, onOpenFlow, onConfigureProvider, onConfigureReplyDelivery }: Props): ReactElement {
  const [artifactOpenError, setArtifactOpenError] = useState('')
  const [spreadsheet, setSpreadsheet] = useState<{ taskId: string; artifactId: string } | null>(null)
  const openArtifact = async (task: TaskRunV1, artifact: TaskRunV1['artifacts'][number]): Promise<void> => {
    setArtifactOpenError('')
    try {
      if (/\.xlsx$/i.test(artifact.relativePath) && artifact.absolutePath) {
        setSpreadsheet({ taskId: task.id, artifactId: artifact.id })
      } else if (/\.html?$/i.test(artifact.relativePath)) {
        await onOpenArtifact(task, artifact.relativePath, artifact.id)
      } else if (artifact.absolutePath) {
        const result = await window.workwise.openTaskArtifact({ taskId: task.id, artifactId: artifact.id })
        if (!result.ok) throw new Error(result.message)
      } else await onOpenArtifact(task, artifact.relativePath)
    } catch (error) { setArtifactOpenError(error instanceof Error ? error.message : String(error)) }
  }
  const { t } = useTranslation('common')
  const live=useTaskState(runtimeReady)
  const [templates, setTemplates] = useState<TaskTemplateV1[]>(BUILTIN_TEMPLATES)
  const { selectedTaskId: selectedId, filter, search, allWorkspaces, selectedAttentionId } = live.navigation
  const setSelectedId = useCallback((id: string | null): void => updateTaskNavigation({ selectedTaskId: id, selectedAttentionId: null }), [])
  const setFilter = useCallback((value: typeof filter): void => updateTaskNavigation({ filter: value }), [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [controlNotice, setControlNotice] = useState('')
  const [actionBusy, setActionBusy] = useState(false)
  const [publicQueryRecovery, setPublicQueryRecovery] = useState<Pick<TaskPublicQueryRecoverySnapshotV1, 'taskId' | 'state' | 'reason'> | null>(null)
  const recoveryProjectionChanged = useCallback((projection: Pick<TaskPublicQueryRecoverySnapshotV1, 'taskId' | 'state' | 'reason'>): void => setPublicQueryRecovery(projection), [])
  const [inputs, setInputs] = useState<TaskInputV1[]>([])
  const [events, setEvents] = useState<TaskEventV1[]>([])
  const [receipts, setReceipts] = useState<TaskOperationReceiptV1[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [attachments, setAttachments] = useState<Record<string, { id: string; name: string; scan?: boolean }>>({})
  const [attachmentError, setAttachmentError] = useState<Record<string, string>>({})
  const [importingTask, setImportingTask] = useState<string | null>(null)
  const [templateId, setTemplateId] = useState<TaskTemplateId | null>(null)
  const [goal, setGoal] = useState('')
  const [sources, setSources] = useState('')
  const [outputDirectory, setOutputDirectory] = useState('')
  const [outputFormats, setOutputFormats] = useState<Array<'md'|'docx'|'pdf'>>(['md', 'docx', 'pdf'])
  const openSettings = useChatStore(state => state.openSettings)
  const openWrite = useChatStore(state => state.openWrite)
  const activeTemplate = templates.find(template => template.id === templateId)
  const [templateMessage, setTemplateMessage] = useState('')
  const detailGeneration = useRef(0)
  const detailRootId = useRef<string | null>(null)
  const scope = allWorkspaces ? undefined : workspaceRoot
  const tasks = useMemo(() => scopeWorkspaceTasks(live.tasks, scope), [live.tasks, scope])
  const inbox=useMemo(()=>live.attention.filter(item=>!scope||item.workspaceRoot===scope||tasks.some(task=>attentionMatchesTask(item,task))),[live.attention,tasks,scope])
  const standaloneAttention = inbox.filter(item => !tasks.some(task => attentionMatchesTask(item, task))).filter(item => !search.trim() || `${item.title}\n${item.message}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  const mutationRequests = useRef(new Map<string, { expectedRevision: number; idempotencyKey: string; text?: string; attachmentId?: string }>())
  const templateRequest = useRef<{ id: TaskTemplateId; request: TaskTemplateStartV1 } | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if(!runtimeReady)return
    setLoading(true)
    try { await refreshTaskState() } finally { setLoading(false) }
  },[runtimeReady])

  useEffect(()=> { const requested=takeRequestedTask();if(requested){setFilter('all');setSelectedId(requested)} },[scope,setFilter,setSelectedId])
  useEffect(()=>{const open=(event:Event)=>{setFilter('all');setSelectedId((event as CustomEvent<string>).detail)};window.addEventListener('railwise:open-task',open);return()=>window.removeEventListener('railwise:open-task',open)},[setFilter,setSelectedId])

  useEffect(() => {
    if (!runtimeReady) return
    let active = true
    void window.workwise.listTaskTemplates().then(result => { if (active && result.templates.length) setTemplates(result.templates) }).catch(nextError => { if (active) setError(errorMessage(nextError)) })
    return () => { active = false }
  }, [runtimeReady])

  const visible = useMemo(() => filterWorkspaceTasks(tasks, inbox, filter, search), [tasks, inbox, filter, search])
  const selectedGroup = useMemo(() => taskGroupForTask(selectedId, tasks), [selectedId, tasks])
  const selectedGroupRevision = selectedGroup?.all.map(task => `${task.id}:${task.revision}`).join('|') ?? ''
  const selected = selectedGroup?.root ?? null
  const currentExecution = selectedGroup ? currentTaskBranch(selectedGroup.all, selectedGroup.root).current : null
  const progressSample = currentExecution ? live.progress?.[currentExecution.id] : undefined
  const currentProgress = currentExecution && progressSample?.taskRevision === currentExecution.revision && progressSample.turnId === currentExecution.activeTurnId &&
    ['running','retrying'].includes(currentExecution.status) ? progressSample : undefined
  const currentTiming = currentProgress?.timing ?? currentExecution?.timing
  const artifactEntries = useMemo(() => selectedGroup ? taskGroupArtifacts(selectedGroup) : [], [selectedGroup])
  const selectedSpreadsheet = spreadsheet && artifactEntries.find(entry =>
    entry.task.id === spreadsheet.taskId && entry.artifact.id === spreadsheet.artifactId
  )
  const detailTask = currentExecution ?? selected
  const hasPublicQueryRecovery = publicQueryRecovery?.taskId === (currentExecution ?? selected)?.id
    && (publicQueryRecovery?.state !== 'unavailable' || publicQueryRecovery?.reason === 'browser_public_query_schedule_scope_required')
  useEffect(() => {
    if (!live.ready) return
    if (selectedAttentionId) {
      if (standaloneAttention.some(item => item.id === selectedAttentionId)) return
      updateTaskNavigation({ selectedAttentionId: null, selectedTaskId: visible[0]?.id ?? null })
      return
    }
    if (selectedGroup) return
    if ((filter === 'attention' || !visible.length) && standaloneAttention[0] && (filter === 'attention' || filter === 'all')) {
      updateTaskNavigation({ selectedTaskId: null, selectedAttentionId: standaloneAttention[0].id })
      return
    }
    if (!visible.some(task => task.id === selectedId)) setSelectedId(visible[0]?.id ?? null)
  }, [visible, selectedId, live.ready, selectedGroup, selectedAttentionId, filter, standaloneAttention, setSelectedId])

  useEffect(() => {
    const generation = ++detailGeneration.current
    const nextRootId = runtimeReady ? selectedGroup?.root.id ?? null : null
    if (detailRootId.current !== nextRootId) {
      detailRootId.current = nextRootId
      setInputs([])
      setEvents([])
      setReceipts([])
    }
    // A same-task refresh must not unmount receipt cards while they report a
    // verification result. Replace their data only when the fresh read arrives.
    if (!selectedGroup || !runtimeReady) return
    void Promise.all(selectedGroup.all.map(async task => {
      const [nextInputs, nextEvents, nextReceipts] = await Promise.all([window.workwise.listTaskInputs(task.id), window.workwise.listTaskEvents(task.id), window.workwise.listTaskOperationReceipts(task.id)])
      return { inputs: nextInputs, events: nextEvents, receipts: nextReceipts }
    })).then(results => {
      if (generation === detailGeneration.current) {
        setInputs(results.flatMap(result => result.inputs).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
        setEvents(results.flatMap(result => result.events).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
        setReceipts(results.flatMap(result => result.receipts).sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
      }
    }).catch(nextError => { if (generation === detailGeneration.current) setError(errorMessage(nextError)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { if (detailGeneration.current === generation) ++detailGeneration.current }
  }, [runtimeReady, selectedGroup, selectedGroupRevision])

  const addFile = async (file: File): Promise<void> => {
    if (!selected || !detailTask || importingTask) return
    const rootId = selected.id
    setAttachmentError(current => ({ ...current, [rootId]: '' }))
    if (!isChatDocumentAttachment(file)) {
      setAttachmentError(current => ({ ...current, [rootId]: t('taskWorkspaceAttachmentInvalid') }))
      return
    }
    setImportingTask(rootId)
    try {
      const sourcePath = window.workwise.getPathForFile(file)
      if (!sourcePath) throw new Error('attachment original path unavailable')
      const { attachment } = await window.workwise.importChatAttachment({
        sourcePath,
        threadId: detailTask.originThreadId ?? detailTask.threadId,
        workspace: detailTask.workspaceRoot
      })
      if (!['ready', 'degraded'].includes(attachment.state)) throw new Error('attachment import failed')
      setAttachments(current => ({ ...current, [rootId]: {
        id: attachment.id, name: attachment.name, scan: attachment.degradationReasons?.includes('no_extractable_pdf_text')
      } }))
    } catch (nextError) {
      setAttachmentError(current => ({ ...current, [rootId]: t(attachmentImportErrorKey(nextError), { name: file.name }) }))
    } finally { setImportingTask(null) }
  }

  const mutate = async (action: 'pause' | 'resume' | 'retry' | 'cancel' | 'input' | 'revalidate'): Promise<void> => {
    if (!selected || actionBusy) return
    const task = currentExecution ?? selected
    const attachment = action === 'input' ? attachments[selected.id] : undefined
    const text = action === 'input' ? drafts[selected.id]?.trim() || (attachment ? t('taskWorkspaceAttachmentPrompt') : '') : undefined
    if (action === 'input' && !text) return
    const key = `${task.id}:${action}`
    const previous = mutationRequests.current.get(key)
    const request = previous && previous.text === text && previous.attachmentId === attachment?.id ? previous
      : { expectedRevision: task.revision, idempotencyKey: operationKey(), ...(text ? { text } : {}), ...(attachment ? { attachmentId: attachment.id } : {}) }
    mutationRequests.current.set(key, request)
    setActionBusy(true)
    setError('')
    setControlNotice('')
    try {
      if (action === 'revalidate') {
        const result = await window.workwise.revalidateTaskArtifacts(task.id, { ...request, confirmed: true })
        setControlNotice(result.reason ?? '')
        if (result.completed) updateTaskNavigation({ filter: 'completed', selectedTaskId: selected.id, selectedAttentionId: null })
      }
      else if (action === 'pause') await window.workwise.pauseTask(task.id, request)
      else if (action === 'resume' || action === 'retry') {
        const result = action === 'resume' ? await window.workwise.resumeTask(task.id, request) : await window.workwise.retryTask(task.id, request)
        if (result.capability) {
          mutationRequests.current.delete(key)
          setControlNotice(result.capability.message)
          await refresh()
          setFilter('attention')
          setSelectedId(selected.id)
          return
        }
        if (result.turn && typeof result.turn === 'object' && 'turnId' in result.turn && typeof result.turn.turnId === 'string' && result.turn.turnId) {
          setControlNotice(t('taskWorkspaceResumeSubmitted'))
          foregroundTaskArtifactPreview(result.task.originThreadId ?? task.originThreadId ?? result.task.threadId, result.task.id)
        }
      }
      else if (action === 'cancel') await window.workwise.cancelTask(task.id, request)
      else {
        if (attachment) {
          const result = await window.workwise.coordinateTaskCommand({
            threadId: task.originThreadId ?? task.threadId,
            taskId: task.id,
            intent: 'supplement',
            expectedRevision: request.expectedRevision,
            idempotencyKey: request.idempotencyKey,
            request: { prompt: text!, attachmentIds: [attachment.id] }
          })
          if (result.kind !== 'input_queued') throw new Error(t('taskWorkspaceActionFailed'))
          setAttachments(current => {
            if (current[selected.id]?.id !== attachment.id) return current
            const remaining = { ...current }
            delete remaining[selected.id]
            return remaining
          })
        } else await window.workwise.appendTaskInput(task.id, { ...request, text: text!, kind: 'supplement' })
        setDrafts(current => !current[selected.id]?.trim() || current[selected.id]?.trim() === text ? { ...current, [selected.id]: '' } : current)
        setControlNotice(t('taskWorkspaceSupplementSaved'))
      }
      mutationRequests.current.delete(key)
      await refresh()
    } catch (nextError) {
      // A known revision conflict is safe to retry explicitly with the latest revision.
      // Keep the previous key after transport uncertainty.
      if ((nextError as { status?: number })?.status === 409) mutationRequests.current.delete(key)
      setError(errorMessage(nextError))
      await refresh()
    }
    finally { setActionBusy(false) }
  }

  const launchTemplate = async (event: FormEvent, save = false): Promise<void> => {
    event.preventDefault()
    if (!templateId || !goal.trim() || !workspaceRoot || actionBusy) return
    const candidate = { workspaceRoot, goal: goal.trim(), sourcePaths: sources.split('\n').map(line => line.trim()).filter(Boolean), outputFormats, ...(outputDirectory.trim() ? { outputDirectory: outputDirectory.trim() } : {}) }
    setActionBusy(true)
    setError('')
    setTemplateMessage('')
    try {
      if (save) {
        await window.workwise.saveTaskTemplate(templateId, candidate)
        setTemplateMessage(t('taskWorkspaceTemplateSaved'))
      } else {
        const cached = templateRequest.current
        const request = cached?.id === templateId && JSON.stringify({ ...cached.request, idempotencyKey: undefined }) === JSON.stringify(candidate) ? cached.request : { ...candidate, idempotencyKey: operationKey() }
        templateRequest.current = { id: templateId, request }
        const result = await window.workwise.startTaskTemplate(templateId, request)
        templateRequest.current = null
        setTemplateId(null)
        setGoal('')
        setSources('')
        setOutputDirectory('')
        setFilter('all')
        await refresh()
        if (result.taskId) setSelectedId(result.taskId)
        else if (result.flowId) { setTemplateMessage(t('taskWorkspaceFlowStarted')); onOpenFlow?.(result.flowId, result.flowRunId) }
      }
    } catch (nextError) { setError(errorMessage(nextError)) } finally { setActionBusy(false) }
  }

  const conversationForAttention = (item:TaskAttentionV1):string|undefined => {
    const owner=tasks.find(task=>attentionMatchesTask(item,task))
    if(!owner)return item.threadId
    const root=taskGroupForTask(owner.id,tasks)?.root??owner
    return owner.originThreadId??root.originThreadId??(!owner.visibility?owner.threadId:undefined)
  }
  const supersededOwners = selectedGroup && currentExecution ? retryAncestorIds(currentExecution, selectedGroup.all) : new Set<string>()
  const selectedAttention = selectedGroup ? inbox.filter(item => {
    const owners = selectedGroup.all.filter(task => attentionMatchesTask(item, task))
    if (!owners.length) return false
    // Preserve other retry branches, parallel child blockers and every non-capability review.
    // A legacy thread-only record stays visible if any possible owner is still current.
    return !(item.payload?.kind === 'capability_required' && owners.every(owner => supersededOwners.has(owner.id)))
  }) : []
  const runActivity = detailTask ? projectTaskRunActivity(detailTask, currentProgress, artifactEntries.length, selectedAttention,
    artifactEntries.map(({ task, artifact }) => ({ taskId: task.id, artifactId: artifact.id }))) : undefined
  // Older records remain readable even if they predate structured presentation.
  const visibleAttention = new Set(runActivity?.attentionIds ?? selectedAttention.map(item => item.id))
  const artifactIds = new Set(runActivity?.artifacts?.map(artifact => JSON.stringify([artifact.taskId, artifact.artifactId])))
  const visibleArtifacts = runActivity?.artifacts ? artifactEntries.filter(({ task, artifact }) => artifactIds.has(JSON.stringify([task.id, artifact.id]))) : artifactEntries
  const reason = runActivity?.presentation?.reason
  const actions = runActivity?.presentation?.actions ?? []
  const shouldVerify = actions.includes('verify') || Boolean(detailTask && receipts.some(receipt =>
    receipt.taskId === detailTask.id && receipt.status === 'outcome_unknown' && !receipt.resolution))
  const canResume = !hasPublicQueryRecovery && !shouldVerify && Boolean(detailTask &&
    (detailTask.status === 'paused' || !selectedAttention.length &&
      (actions.includes('resume') || !detailTask.presentation && ['stalled', 'waiting_user'].includes(detailTask.status))))
  const onAttentionResolved = (notice?: string): void => {
    if (notice) setControlNotice(notice)
    void refresh()
  }

  return <section className="ds-task-workspace ds-no-drag flex h-full min-h-0 min-w-0 flex-col bg-ds-main text-ds-ink" aria-label={t('taskWorkspaceTitle')}>
    <header className="flex flex-wrap items-center gap-3 border-b border-ds-border px-5 py-4">
      <SidebarTitlebarToggleButton onClick={onToggleLeftSidebar} title={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')} ariaLabel={leftSidebarCollapsed ? t('sidebarExpand') : t('sidebarCollapse')} />
      <div className="min-w-0 flex-1"><h1 className="text-lg font-semibold">{t('taskWorkspaceTitle')}</h1><p className="mt-0.5 text-xs text-ds-muted">{t('taskWorkspaceSubtitle')}</p></div>
      <button type="button" disabled={!runtimeReady || loading} onClick={() => void refresh()} className="inline-flex items-center gap-2 rounded-lg border border-ds-border bg-ds-card px-3 py-2 text-xs disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />{t('taskWorkspaceRefresh')}</button>
    </header>
    {!runtimeReady ? <p role="status" className="m-5 rounded-xl border border-ds-border bg-ds-card p-4 text-sm text-ds-muted">{t('runtimeActionNeedsConnection')}</p> : null}
    {error || live.error ? <div role="alert" className="mx-5 mt-3 rounded-xl border border-amber-300/60 bg-ds-card p-3 text-xs text-ds-ink">
      <p>{t('taskWorkspaceActionFailed')}</p>
      <details className="mt-1 text-ds-muted"><summary className="cursor-pointer">{t('taskEvidenceExecutionDetails')}</summary><p className="mt-1 break-words">{redactRuntimeText(error || live.error || '')}</p></details>
    </div> : null}
    {controlNotice ? <p role="status" className="mx-5 mt-3 text-sm text-ds-ink">{controlNotice}</p> : null}
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="px-5 pt-4">
        <details className="rounded-lg border border-ds-border bg-ds-card p-3"><summary className="cursor-pointer text-xs font-medium text-ds-muted">{t('taskWorkspaceTemplates')}</summary><div className="ds-task-workspace-templates mt-3 grid gap-2">{templates.map(template => <button type="button" key={template.id} disabled={!runtimeReady || !workspaceRoot} onClick={() => { setTemplateId(template.id); setTemplateMessage('') }} className="rounded-xl border border-ds-border bg-ds-card p-3 text-left transition hover:border-accent disabled:opacity-50"><div className="flex items-center gap-2 text-sm font-semibold"><Plus className="h-4 w-4 text-accent" />{t(`taskTemplate_${template.id}`, { defaultValue: template.name })}</div><p className="mt-1 text-xs leading-relaxed text-ds-muted">{t(`taskTemplateDescription_${template.id}`, { defaultValue: template.description })}</p></button>)}</div></details>
      </div>
      <div className="ds-task-workspace-detail min-w-0 flex-1 p-5">
        {selectedAttentionId ? standaloneAttention.filter(item => item.id === selectedAttentionId).map(item => <TaskAttentionCard key={item.id} item={item} conversationThreadId={conversationForAttention(item)} onResolved={onAttentionResolved} onOpenThread={onOpenThread} onOpenFlow={onOpenFlow} />) : null}
        {selected ? <article aria-label={t('taskWorkspaceDetails')} className="mx-auto w-full min-w-0 max-w-4xl rounded-xl border border-ds-border bg-ds-card p-4 sm:p-5">
          <h2 className="break-words text-lg font-semibold">{taskDisplayTitle(selected)}</h2>
          <p className="mt-2 text-xs font-semibold text-ds-ink">{t(`taskRunStatus_${runActivity?.status ?? (currentExecution ?? selected).status}`)}</p>
          {reason && !selectedAttention.length && reason !== 'queued' ? <p className="mt-1 text-sm text-ds-muted">{t(taskReasonKey(reason))}</p> : null}
          {selectedAttention.length ? <div className="mb-4 mt-3 space-y-2">{selectedAttention.filter(item => visibleAttention.has(item.id)).map(item => <TaskAttentionCard key={`${item.id}:${item.revision}`} item={item} ownerTask={selectedGroup?.all.find(task => task.id === item.taskId)} conversationThreadId={conversationForAttention(item)} workspaceRoot={selectedGroup?.all.find(task => task.id === item.taskId)?.workspaceRoot} onResolved={onAttentionResolved} onOpenThread={onOpenThread} onOpenFlow={onOpenFlow} />)}</div> : null}
          <details className="mt-3 text-xs text-ds-muted"><summary className="cursor-pointer">{t('taskWorkspaceOriginalRequest')}</summary><p className="mt-2 whitespace-pre-wrap break-words leading-relaxed">{taskDisplayGoal(selected)}</p><p className="mt-2 break-all">{t('taskWorkspaceLocation')}: {selected.workspaceRoot}</p></details>
          <div className="my-4 flex min-w-0 max-w-full flex-wrap gap-2 [&>button]:min-w-0 [&>button]:max-w-full [&>button]:whitespace-normal">
            {['stalled', 'failed', 'paused'].includes((currentExecution ?? selected).status) && legacyLocalArtifactSourceMismatch(currentExecution ?? selected) ? <button type="button" disabled={actionBusy} onClick={() => void mutate('revalidate')} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{t('taskWorkspaceRevalidateArtifacts')}</button> : null}
            {selected.originThreadId || currentExecution?.originThreadId || !selected.visibility ? <button type="button" onClick={() => onOpenThread((selected.originThreadId ?? currentExecution?.originThreadId ?? selected.threadId))} className="inline-flex items-center gap-1 rounded-lg border border-ds-border px-3 py-2 text-xs"><MessageSquare className="h-3.5 w-3.5" />{t('taskWorkspaceOpenConversation')}</button> : null}
            {!TERMINAL.has(currentExecution?.status ?? selected.status) && (currentExecution?.status ?? selected.status) !== 'paused' ? <button type="button" disabled={actionBusy} onClick={() => void mutate('pause')} className="inline-flex items-center gap-1 rounded-lg border border-ds-border px-3 py-2 text-xs disabled:opacity-50"><Pause className="h-3.5 w-3.5" />{t('taskWorkspacePause')}</button> : null}
            {canResume ? <button type="button" disabled={actionBusy} onClick={() => void mutate('resume')} className="inline-flex items-center gap-1 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"><Play className="h-3.5 w-3.5" />{t('taskRunResume')}</button> : null}
            {(actions.includes('retry') || !detailTask?.presentation && ['failed', 'cancelled'].includes(detailTask?.status ?? '')) ? <button type="button" disabled={actionBusy} onClick={() => void mutate('retry')} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{t('taskRunRetry')}</button> : null}
            {!TERMINAL.has(currentExecution?.status ?? selected.status) ? <button type="button" disabled={actionBusy} onClick={() => void mutate('cancel')} className="inline-flex items-center gap-1 rounded-lg border border-ds-border px-3 py-2 text-xs disabled:opacity-50"><Square className="h-3.5 w-3.5" />{t('taskRunCancel')}</button> : null}
          </div>
          <TaskPublicQueryRecoveryCard key={`public-query-recovery:${(currentExecution ?? selected).id}`} task={currentExecution ?? selected} runtimeReady={runtimeReady} disabled={actionBusy} onChanged={() => refresh()} onProjectionChange={recoveryProjectionChanged} onNotice={setControlNotice} />
          {actions.includes('extend_budget') ? <TaskBudgetControl key={selected.id} task={selected} onChanged={() => refresh()} /> : null}
          <h3 className="mb-2 text-xs font-semibold text-ds-muted">{t('taskRunArtifacts')}</h3>
          {artifactOpenError ? <p role="alert" className="mb-3 text-xs text-red-600">{artifactOpenError}</p> : null}
          {visibleArtifacts.length ? <ul className="mb-4 space-y-2">{visibleArtifacts.map(({ task: artifactTask, artifact }) => <li key={`${artifactTask.id}:${artifact.id}`} className="rounded-lg border border-ds-border px-3 py-2"><button type="button" onClick={() => void openArtifact(artifactTask, artifact)} className="flex w-full items-start gap-2 text-left text-xs text-accent"><FileText className="h-4 w-4 shrink-0" /><span className="break-all">{artifact.absolutePath ? artifact.relativePath.split(/[\\/]/).at(-1) : artifact.relativePath}</span></button><p className="mt-1 text-[11px] text-ds-muted">{artifact.storage === 'task' ? `${t('taskArtifactManagedStorage')} · ` : ''}{t(taskArtifactValidationLabelKey(artifactTask, artifact))} · {dateLabel(artifact.createdAt)}</p>{artifact.validationMessage ? <p className="mt-1 text-xs text-ds-muted">{artifact.validationMessage}</p> : null}<TaskArtifactReview task={artifactTask} artifact={artifact} onOpen={() => openArtifact(artifactTask, artifact)} /></li>)}</ul> : <p className="mb-4 text-xs text-ds-faint">{t('taskRunNoArtifacts')}</p>}
          {spreadsheet && selectedSpreadsheet ? <div className="mb-4 flex h-[420px] min-w-0 flex-col rounded-lg border border-ds-border">
            <div className="flex items-center justify-between gap-2 border-b border-ds-border px-3 py-2 text-xs">
              <span className="truncate">{selectedSpreadsheet.artifact.relativePath.split(/[\\/]/).at(-1)}</span>
              <button type="button" aria-label={t('rightPanelCollapse')} onClick={() => setSpreadsheet(null)}><X className="h-4 w-4" /></button>
            </div>
            <Suspense fallback={<p className="px-3 py-2 text-xs text-ds-muted">{t('filePreviewLoading')}</p>}>
              <Spreadsheet key={`${spreadsheet.taskId}:${spreadsheet.artifactId}:${selectedSpreadsheet.artifact.sha256}`}
                target={spreadsheet} displayName={selectedSpreadsheet.artifact.relativePath}
                onOpenSystem={() => void window.workwise.openTaskArtifact(spreadsheet).then(result => {
                  if (!result.ok) setArtifactOpenError(result.message)
                }).catch(error => setArtifactOpenError(errorMessage(error)))} />
            </Suspense>
          </div> : null}

          {runActivity?.phase || ['running', 'retrying'].includes(detailTask?.status ?? '') ? <p role="status" className="mb-2 text-sm text-ds-muted">{t(`taskActivity_${runActivity?.phase ?? 'working'}`)}</p> : null}
          {detailTask ? <p className="mb-4 text-xs text-ds-muted">{t('taskWorkspaceLatestUpdate', { time: dateLabel(currentProgress?.sampledAt ?? detailTask.updatedAt) })}</p> : null}
          <TaskExecutionEvidence compact task={currentExecution ?? selected} relatedTasks={selectedGroup ? currentTaskBranch(selectedGroup.all, selectedGroup.root).members : [selected]} receipts={receipts.filter(receipt => (selectedGroup ? currentTaskBranch(selectedGroup.all, selectedGroup.root).members : [selected]).some(task => task.id === receipt.taskId))} onConfigureProvider={onConfigureProvider} onConfigureReplyDelivery={onConfigureReplyDelivery} onVerify={async receipt => {
            const owner = selectedGroup?.all.find(task => task.id === receipt.taskId)
            if (!owner) throw new Error(t('taskEffectReadbackUnconfirmed'))
            const result = await window.workwise.verifyTaskOperationReceipt(owner.id, receipt.id, { expectedRevision: owner.revision, idempotencyKey: operationKey() })
            if (!result.browserReview) await refresh()
            return result
          }} onConfirmBrowser={async (receipt, reviewId, decision) => {
            const owner = selectedGroup?.all.find(task => task.id === receipt.taskId)
            if (!owner) throw new Error(t('taskBrowserReviewUnavailable'))
            const response = await window.workwise.runtimeRequest(`/v1/tasks/${encodeURIComponent(owner.id)}/receipts/${encodeURIComponent(receipt.id)}/browser-confirm`, 'POST', JSON.stringify({ expectedRevision: owner.revision, idempotencyKey: operationKey(), reviewId, decision }))
            if (!response.ok) {
              let code = 'browser_review_unavailable'
              try { const body = JSON.parse(response.body); if (/^[a-z][a-z0-9_]{0,99}$/.test(body.message)) code = body.message } catch { /* Keep the safe scoped failure code. */ }
              return { taskId: owner.id, receiptId: receipt.id, status: 'outcome_unknown' as const, errorCode: code }
            }
            await refresh()
            return JSON.parse(response.body)
          }} />
          {!TERMINAL.has(currentExecution?.status ?? selected.status) ? <form onSubmit={event => { event.preventDefault(); void mutate('input') }} className="mb-4 rounded-xl border border-ds-border bg-ds-main p-3">
            <label htmlFor="task-supplement" className="text-xs font-semibold">{t('taskWorkspaceSupplement')}</label>
            <textarea id="task-supplement" value={drafts[selected.id] ?? ''} onChange={event => setDrafts(current => ({ ...current, [selected.id]: event.target.value }))} rows={2} placeholder={t('taskWorkspaceSupplementHint')} className="mt-2 block w-full rounded-lg border border-ds-border bg-ds-card p-2 text-sm" />
            {attachments[selected.id] ? <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ds-muted">
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span className="break-all">{attachments[selected.id].name}</span>
              <button type="button" aria-label={t('taskWorkspaceAttachmentRemove')} onClick={() => setAttachments(current => {
                const remaining = { ...current }
                delete remaining[selected.id]
                return remaining
              })} className="rounded p-1 hover:bg-ds-hover"><X className="h-3.5 w-3.5" /></button>
              {attachments[selected.id].scan ? <p className="w-full">{t('taskWorkspaceAttachmentScan')}</p> : null}
            </div> : null}
            {attachmentError[selected.id] ? <p role="alert" className="mt-2 text-xs text-ds-muted">{attachmentError[selected.id]}</p> : null}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="relative flex items-center gap-1.5 rounded-lg border border-ds-border bg-ds-card px-3 py-2 text-xs focus-within:ring-2 focus-within:ring-accent">
                <Paperclip className="h-3.5 w-3.5 shrink-0" />
                {t(importingTask === selected.id ? 'taskWorkspaceAttachmentReading' : 'taskWorkspaceAttachmentPick')}
                <input type="file" accept=".pdf,.docx,.xlsx,.pptx,.txt,.md,.markdown,.csv" disabled={Boolean(importingTask) || actionBusy}
                  className="sr-only" onChange={event => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    if (file) void addFile(file)
                  }} />
              </label>
              <button type="submit" disabled={actionBusy || importingTask === selected.id || !drafts[selected.id]?.trim() && !attachments[selected.id]} className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{t('taskWorkspaceSendSupplement')}</button>
            </div>
          </form> : null}
          {inputs.length ? <details className="mb-4"><summary className="cursor-pointer text-xs font-semibold">{t('taskWorkspaceInputs')} ({inputs.length})</summary><ul className="mt-2 space-y-2 text-ds-muted">{inputs.map(input => <li key={input.id} className="rounded-lg bg-ds-main p-2 text-xs"><p className="whitespace-pre-wrap">{input.text}</p><p className="mt-1 text-ds-faint">{dateLabel(input.createdAt)} · {input.consumedAt ? t('taskWorkspaceInputConsumed') : input.deliveredAt ? t('taskWorkspaceInputDelivered') : t('taskWorkspaceInputSaved')}</p></li>)}</ul></details> : null}
          {selectedGroup && selectedGroup.children.length ? <details className="mb-4"><summary className="cursor-pointer text-xs font-semibold">{t('taskWorkspaceSubtasks')}</summary><ul className="mt-2 space-y-1.5">{selectedGroup.children.map(child => <li key={child.id} className="flex items-center gap-2 rounded-lg bg-ds-main px-3 py-2 text-xs"><span className="min-w-0 flex-1 truncate">{taskDisplayGoal(child)}</span><span className="shrink-0 text-ds-muted">{t(`taskRunStatus_${child.status}`)}</span></li>)}</ul></details> : null}
          {(currentExecution ?? selected).finalResponse ? <details className="mb-4"><summary className="cursor-pointer text-xs font-semibold">{t('taskWorkspaceResult')}</summary><AssistantMarkdown text={(currentExecution ?? selected).finalResponse!} streaming={false} workspaceRoot={(currentExecution ?? selected).workspaceRoot} restricted className="ds-markdown mt-2 min-w-0 break-words text-sm leading-relaxed" /></details> : null}
          <details className="text-ds-muted">
            <summary className="cursor-pointer text-xs">{t('taskEvidenceExecutionDetails')}</summary>
            <div className="mt-3">
          <details key={`permissions:${(currentExecution ?? selected).id}`} className="mb-4 rounded-lg border border-ds-border p-3 text-xs"><summary className="cursor-pointer font-medium">{t('taskPermissionReview')}</summary><TaskPermissionPanel key={(currentExecution ?? selected).id} taskId={(currentExecution ?? selected).id} revision={(currentExecution ?? selected).revision} autoLoad onConfirmed={message => { setControlNotice(message); void refresh() }} /></details>
          <h3 className="mb-2 text-xs font-semibold text-ds-muted">{t('taskRunNodes')}</h3>
          <ol className="mb-4 space-y-1.5">{(currentExecution ?? selected).nodes.map(node => <li key={node.id} className="flex items-center gap-2 rounded-lg bg-ds-main px-3 py-2 text-xs"><span className="min-w-0 flex-1">{node.title}</span><span className="shrink-0 text-ds-muted">{t(nodeStatusLabelKey((currentExecution ?? selected).status, node.status))}</span></li>)}</ol>
          {currentTiming ? <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ds-muted" title={t(currentTiming.coverage === 'complete' ? 'taskTimingComplete' : 'taskTimingPartial')}>
            <span>{t('taskTimingExecution')}: {Math.round(currentTiming.executionMs / 1000)}s</span>
            <span>{t('taskTimingQueued')}: {Math.round(currentTiming.queuedMs / 1000)}s</span>
            <span>{t('taskTimingHumanWait')}: {Math.round(currentTiming.humanWaitMs / 1000)}s</span>
          </p> : null}
            </div>
            <details className="mt-3"><summary className="cursor-pointer text-xs text-ds-muted">{t('taskWorkspaceActivity')} ({events.length})</summary><ol className="mt-2 space-y-2">{events.map(event => <li key={`${event.taskId}:${event.sequence}`} className="text-xs"><time className="text-ds-faint">{dateLabel(event.createdAt)}</time><p>{t(`taskEvent_${event.kind}`, { defaultValue: t('taskWorkspaceStatusUpdated') })}</p></li>)}</ol></details>
          </details>
        </article> : selectedAttentionId ? null : <div className="ds-task-workspace-empty rounded-xl border border-dashed border-ds-border p-8 text-center text-sm text-ds-faint">{t('taskSidebarSelect')}</div>}
      </div>
    </div>
    {templateId ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-5" onClick={() => { if (!actionBusy) setTemplateId(null) }}><form role="dialog" aria-modal="true" aria-labelledby="task-template-title" onSubmit={event => void launchTemplate(event)} onClick={event => event.stopPropagation()} className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-ds-border bg-ds-card p-5 shadow-xl"><div className="flex items-center gap-3"><h2 id="task-template-title" className="flex-1 text-base font-semibold">{t(`taskTemplate_${templateId}`)}</h2><button type="button" disabled={actionBusy} aria-label={t('taskWorkspaceClose')} onClick={() => setTemplateId(null)}><X className="h-4 w-4" /></button></div><p className="mt-2 break-all text-xs text-ds-muted">{workspaceRoot}</p><div className="mt-4 space-y-2 rounded-lg border border-ds-border p-3 text-xs">
      <p>{t('taskTemplateCurrentModel', { model: activeTemplate?.availability?.model || t('capabilityStateUnknown') })}</p>
      <p>{t(activeTemplate?.availability?.exportStatus === 'configured' ? 'taskTemplateExportConfigured' : activeTemplate?.availability?.exportStatus === 'unavailable' ? 'taskTemplateExportUnconfigured' : 'taskTemplateExportUnknown')}</p>
      {activeTemplate?.availability?.draftAvailable === false ? <p>{t('taskTemplateDraftUnavailable')}</p> : null}
      <div className="flex gap-3"><button type="button" onClick={() => openSettings('providers')} className="text-accent">{t('taskTemplateConfigureModel')}</button><button type="button" onClick={() => void openWrite()} className="text-accent">{t('taskTemplateOpenWriting')}</button></div>
      <fieldset><legend className="mb-1 font-semibold">{t('taskTemplateOutputFormats')}</legend><div className="flex gap-4">{(['md', 'docx', 'pdf'] as const).map(format => <label className="flex items-center gap-1.5" key={format}><input type="checkbox" checked={outputFormats.includes(format)} disabled={format === 'md'} onChange={event => setOutputFormats(current => event.target.checked ? [...current, format] : current.filter(value => value !== format))} />{format === 'md' ? t('taskTemplateMarkdownDraft') : format.toUpperCase()}</label>)}</div></fieldset>
    </div><label className="mt-4 block text-xs font-semibold">{t('taskWorkspaceGoal')}<textarea autoFocus required rows={4} value={goal} onChange={event => setGoal(event.target.value)} className="mt-2 block w-full rounded-lg border border-ds-border bg-ds-main p-3 text-sm" /></label><label className="mt-4 block text-xs font-semibold">{t('taskWorkspaceSources')}<textarea rows={3} value={sources} onChange={event => setSources(event.target.value)} placeholder={t('taskWorkspaceSourcesHint')} className="mt-2 block w-full rounded-lg border border-ds-border bg-ds-main p-3 text-sm" /></label><label className="mt-4 block text-xs font-semibold">{t('taskWorkspaceOutputDirectory')}<input value={outputDirectory} onChange={event => setOutputDirectory(event.target.value)} placeholder={t('taskWorkspaceOutputHint')} className="mt-2 block w-full rounded-lg border border-ds-border bg-ds-main p-3 text-sm" /></label>{templateMessage ? <p role="status" className="mt-3 text-xs text-emerald-700 dark:text-emerald-300">{templateMessage}</p> : null}<div className="mt-5 flex justify-end gap-2"><button type="button" disabled={actionBusy || !goal.trim()} onClick={event => void launchTemplate(event, true)} className="rounded-lg border border-ds-border px-3 py-2 text-xs disabled:opacity-50">{t('taskWorkspaceSaveTemplate')}</button><button type="submit" disabled={actionBusy || !goal.trim() || activeTemplate?.availability?.draftAvailable === false} className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white disabled:opacity-50">{actionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}{t('taskWorkspaceStartTask')}</button></div></form></div> : null}
  </section>
}
