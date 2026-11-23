import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { TaskRunV1, TaskAttentionV1, TaskChangeEvent, TaskProgressV1 } from '@shared/agent-workbench'
import { pausedTaskQuestionRequestIds, type TaskFilter } from '@shared/task-workspace-projection'
import { taskArtifactSourceEvidenceState } from '@shared/task-artifact-source-evidence'
import i18n from '../i18n'
import { taskReasonKey } from '../agent/ag-ui-activity'

export type TaskNavigation = { selectedTaskId: string | null; selectedAttentionId: string | null; filter: TaskFilter; search: string; allWorkspaces: boolean }
type State = {
  navigation: TaskNavigation
  tasks: TaskRunV1[]
  attention: TaskAttentionV1[]
  watermark: number
  ready: boolean
  error: string | null
  generation: number
  progress: Record<string, TaskProgressV1>
}
const emptyState = (): State => ({ navigation: { selectedTaskId: null, selectedAttentionId: null, filter: 'all', search: '', allWorkspaces: false }, tasks: [], attention: [], watermark: 0, ready: false, error: null, generation: 0, progress: {} })
let state = emptyState()
let requestedTaskId: string | null = null
const listeners = new Set<() => void>()
let refs = 0
let stop: (() => void) | null = null
let refreshPromise: Promise<void> | null = null
let epoch = 0

export function requestTaskDetail(id: string): void {
  requestedTaskId = id
  updateTaskNavigation({ selectedTaskId: id, selectedAttentionId: null, filter: 'all', allWorkspaces: true })
  window.dispatchEvent(new CustomEvent('railwise:open-task', { detail: id }))
}
export function takeRequestedTask(): string | null {
  const id = requestedTaskId
  requestedTaskId = null
  return id
}
export function updateTaskNavigation(patch: Partial<TaskNavigation>): void {
  const navigation = { ...state.navigation, ...patch }
  // Selection effects also run on empty snapshots. Publishing an unchanged
  // selection would cause a render/subscription loop without any data change.
  if ((Object.keys(navigation) as Array<keyof TaskNavigation>).every(key => navigation[key] === state.navigation[key])) return
  emit({ navigation })
}
export function getTaskState(): State { return state }
function emit(patch: Partial<State>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}
function notifyAttention(item: TaskAttentionV1): void {
  if (item.status !== 'pending' || (!item.taskId && !item.flowRunId)) return
  void window.workwise.notifyTask({
    key: `attention:${item.id}:${item.createdAt}`, taskId: item.taskId, flowId:item.flowId,flowRunId:item.flowRunId,
    kind: 'attention',
    title: i18n.t('common:taskWorkspaceTitle'),
    body: i18n.t(`common:${taskReasonKey(item.presentation?.reason ??
      (item.kind === 'approval' ? 'approval_required' : item.kind === 'question' ? 'input_required' : 'blocked'))}`)
  }).catch(() => undefined)
}
export async function refreshTaskState(): Promise<void> {
  if (refreshPromise) return refreshPromise
  const capturedEpoch = epoch
  refreshPromise = (async () => {
    try {
      const loaded = new Map<string, TaskRunV1>()
      let cursor: string | undefined
      let attention: TaskAttentionV1[] = []
      let watermark = 0
      do {
        const page = await window.workwise.listTaskPage({ filter: 'all', limit: 200, ...(cursor ? { cursor } : {}) })
        for (const task of [...page.items, ...page.relatedTasks]) loaded.set(task.id, task)
        attention = page.attention
        watermark = page.eventWatermark
        cursor = page.nextCursor
      } while (cursor)
      if (capturedEpoch !== epoch || watermark < state.watermark) return
      // Keep one fixed query snapshot across all pages; newer live events win.
      emit({ tasks: [...loaded.values()], attention, watermark, ready: true, error: null, generation: state.generation + 1 })
      for (const item of attention) notifyAttention(item)
    } catch (error) {
      if (capturedEpoch === epoch) emit({ error: error instanceof Error ? error.message : String(error), ready: true })
    }
  })().finally(() => { if (capturedEpoch === epoch) refreshPromise = null })
  return refreshPromise
}
function apply(value: unknown): void {
  const event = value as TaskChangeEvent
  if (event?.kind === 'task_progress') {
    const sample = event.payload, task = state.tasks.find(task => task.id === event.taskId)
    if (!task || sample?.taskId !== task.id || !Number.isSafeInteger(sample.taskRevision) || sample.taskRevision < 0 || sample.taskRevision !== task.revision || !sample.turnId || sample.turnId !== task.activeTurnId ||
      !sample.executionId || !Number.isSafeInteger(sample.leaseRevision) || sample.leaseRevision < 0 || !Number.isFinite(Date.parse(sample.leaseExpiresAt)) || typeof sample.active !== 'boolean' ||
      !['running','retrying'].includes(task.status) || !Number.isFinite(Date.parse(sample.sampledAt))) return
    const previous = state.progress[task.id]
    if (previous && (Date.parse(sample.sampledAt) <= Date.parse(previous.sampledAt) || sample.leaseRevision < previous.leaseRevision)) return
    const phases = ['thinking','searching','reading','writing','verifying','working']
    if (sample.activity && (!sample.active || Date.parse(sample.leaseExpiresAt) <= Date.parse(sample.sampledAt) || !phases.includes(sample.activity.phase))) return
    const timing = sample.timing
    if (timing && (timing.sampledAt !== sample.sampledAt || !['complete','partial'].includes(timing.coverage) ||
      [timing.executionMs,timing.queuedMs,timing.humanWaitMs,timing.pausedMs].some(value => !Number.isFinite(value) || value < 0))) return
    // Projection data has its own clock. Never advance the durable cursor or replace task/Grant bytes.
    emit({ progress: { ...state.progress, [task.id]: sample }, error: null })
    return
  }
  if (!event || !Number.isSafeInteger(event.seq) || event.seq <= state.watermark) return
  if (event.kind === 'task_changed') {
    const task = event.payload as unknown as TaskRunV1
    if (typeof task.id !== 'string') return
    for (const artifact of task.artifacts ?? []) {
      if (artifact.validation !== 'valid' || taskArtifactSourceEvidenceState(task, artifact) === 'draft') continue
      void window.workwise.notifyTask({
        key: `artifact:${task.id}:${artifact.id}:${artifact.sha256 ?? artifact.createdAt}`,
        taskId: task.rootTaskId ?? task.id, kind: 'artifact', title: 'RailWise AI', body: artifact.relativePath
      }).catch(() => undefined)
    }
    const progress = { ...state.progress }
    if (progress[task.id] && (progress[task.id].taskRevision !== task.revision || progress[task.id].turnId !== task.activeTurnId || !['running','retrying'].includes(task.status))) delete progress[task.id]
    emit({ tasks: [...state.tasks.filter(t => t.id !== task.id), task], progress, watermark: event.seq, error: null, generation: state.generation + 1 })
  } else if (event.kind === 'attention_changed') {
    const item = event.payload as unknown as TaskAttentionV1
    if (typeof item.id !== 'string') return
    notifyAttention(item)
    emit({ attention: [...state.attention.filter(i => i.id !== item.id), item].filter(i => i.status === 'pending'), watermark: event.seq, error: null, generation: state.generation + 1 })
  }
}
function connect(): () => void {
  let disposed = false
  let streamId = ''
  let retry: ReturnType<typeof setTimeout> | undefined
  let delay = 1_000
  const clearActivity = (): void => {
    if (!Object.values(state.progress).some(sample => sample.activity || sample.active)) return
    emit({ progress: Object.fromEntries(Object.entries(state.progress).map(([id,sample]) => [id,{...sample,active:false,activity:undefined}])) })
  }
  const offEvent = window.workwise.onSseEvent(payload => {
    if (!disposed && payload.streamId === streamId) for (const event of payload.events) apply(event)
  })
  const restart = (): void => {
    if (disposed || retry) return
    retry = setTimeout(() => { retry = undefined; void start() }, delay)
    delay = Math.min(delay * 2, 30_000)
  }
  const offEnd = window.workwise.onSseEnd(payload => { if (!disposed && payload.streamId === streamId) { clearActivity();restart() } })
  const offError = window.workwise.onSseError(payload => {
    if (disposed || payload.streamId !== streamId) return
    clearActivity()
    emit({ error: payload.message ?? 'Task connection interrupted.' })
    // The main bridge reconnects an open stream. If it terminates, onSseEnd
    // starts one bounded retry; no independent full-list polling is allocated.
  })
  const start = async (): Promise<void> => {
    await refreshTaskState()
    if (disposed) return
    streamId = crypto.randomUUID()
    try { await window.workwise.startTaskSse(state.watermark, streamId); delay = 1_000 } catch { restart() }
  }
  void start()
  return () => {
    disposed = true
    if (retry) clearTimeout(retry)
    offEvent(); offEnd(); offError()
    clearActivity()
    if (streamId) void window.workwise.stopSse(streamId)
  }
}
export function retainTaskState(): () => void {
  if (++refs === 1) stop = connect()
  let released = false
  return () => {
    if (released) return
    released = true
    if (--refs === 0) { stop?.(); stop = null }
  }
}
export function useTaskState(enabled = true): State {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener)
    const release = enabled ? retainTaskState() : () => undefined
    return () => { listeners.delete(listener); release() }
  }, [enabled])
  return useSyncExternalStore(subscribe, getTaskState)
}

export function usePausedTaskQuestionRequestIds(threadId: string | null): ReadonlySet<string> {
  const snapshot = useRef<{ threadId: string | null; tasks: State['tasks']; attention: State['attention']; requestIds: ReadonlySet<string> } | null>(null)
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  const getSnapshot = useCallback(() => {
    const current = state
    const cached = snapshot.current
    if (cached && cached.threadId === threadId && cached.tasks === current.tasks && cached.attention === current.attention) return cached.requestIds
    const requestIds = pausedTaskQuestionRequestIds(current.tasks, current.attention, threadId)
    snapshot.current = { threadId, tasks: current.tasks, attention: current.attention, requestIds }
    return requestIds
  }, [threadId])
  return useSyncExternalStore(subscribe, getSnapshot)
}
/** Reset only after all subscribers unmount; prevents pending test IPC from crossing cases. */
export function resetTaskStateForTests(): void {
  if (refs) throw new Error('Unmount task subscriptions before resetting the store.')
  epoch++
  stop?.(); stop = null; refreshPromise = null
  requestedTaskId = null
  state = emptyState()
}
