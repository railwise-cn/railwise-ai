import { useCallback, useSyncExternalStore } from 'react'
import type { TaskRunV1, TaskAttentionV1, TaskChangeEvent } from '@shared/agent-workbench'

type State = {
  tasks: TaskRunV1[]
  attention: TaskAttentionV1[]
  watermark: number
  ready: boolean
  error: string | null
  generation: number
}
const emptyState = (): State => ({ tasks: [], attention: [], watermark: 0, ready: false, error: null, generation: 0 })
let state = emptyState()
let requestedTaskId: string | null = null
const listeners = new Set<() => void>()
let refs = 0
let stop: (() => void) | null = null
let refreshPromise: Promise<void> | null = null
let epoch = 0

export function requestTaskDetail(id: string): void {
  requestedTaskId = id
  window.dispatchEvent(new CustomEvent('railwise:open-task', { detail: id }))
}
export function takeRequestedTask(): string | null {
  const id = requestedTaskId
  requestedTaskId = null
  return id
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
    kind: 'attention', title: item.title, body: item.message.slice(0, 500)
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
  if (!event || !Number.isSafeInteger(event.seq) || event.seq <= state.watermark) return
  if (event.kind === 'task_changed') {
    const task = event.payload as unknown as TaskRunV1
    if (typeof task.id !== 'string') return
    for (const artifact of task.artifacts ?? []) {
      if (artifact.validation !== 'valid') continue
      void window.workwise.notifyTask({
        key: `artifact:${task.id}:${artifact.id}:${artifact.sha256 ?? artifact.createdAt}`,
        taskId: task.rootTaskId ?? task.id, kind: 'artifact', title: 'RailWise AI', body: artifact.relativePath
      }).catch(() => undefined)
    }
    emit({ tasks: [...state.tasks.filter(t => t.id !== task.id), task], watermark: event.seq, error: null, generation: state.generation + 1 })
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
  const offEvent = window.workwise.onSseEvent(payload => {
    if (payload.streamId === streamId) for (const event of payload.events) apply(event)
  })
  const restart = (): void => {
    if (disposed || retry) return
    retry = setTimeout(() => { retry = undefined; void start() }, delay)
    delay = Math.min(delay * 2, 30_000)
  }
  const offEnd = window.workwise.onSseEnd(payload => { if (payload.streamId === streamId) restart() })
  const offError = window.workwise.onSseError(payload => {
    if (payload.streamId !== streamId) return
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
/** Reset only after all subscribers unmount; prevents pending test IPC from crossing cases. */
export function resetTaskStateForTests(): void {
  if (refs) throw new Error('Unmount task subscriptions before resetting the store.')
  epoch++
  stop?.(); stop = null; refreshPromise = null
  requestedTaskId = null
  state = emptyState()
}
