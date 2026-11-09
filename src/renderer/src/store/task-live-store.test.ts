// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getTaskState, refreshTaskState, resetTaskStateForTests, retainTaskState } from './task-live-store'
let event: (payload: { streamId: string; events: unknown[] }) => void
const releases: Array<() => void> = []
beforeEach(() => {
  resetTaskStateForTests()
  Object.defineProperty(window, 'workwise', { configurable: true, value: {
    listTaskPage: vi.fn(async () => ({ items: [], relatedTasks: [], attention: [], eventWatermark: 4 })),
    startTaskSse: vi.fn(async () => undefined), stopSse: vi.fn(async () => undefined),
    notifyTask: vi.fn(async () => undefined),
    onSseEvent: vi.fn(cb => { event = cb; return () => undefined }),
    onSseEnd: vi.fn(() => () => undefined), onSseError: vi.fn(() => () => undefined)
  } })
})
afterEach(() => { for (const release of releases.splice(0)) release(); resetTaskStateForTests(); Reflect.deleteProperty(window, 'workwise') })
it('shares one stream and ignores repeated event sequence numbers', async () => {
  releases.push(retainTaskState(), retainTaskState())
  await refreshTaskState(); await Promise.resolve()
  expect(window.workwise.startTaskSse).toHaveBeenCalledTimes(1)
  const streamId = vi.mocked(window.workwise.startTaskSse).mock.calls[0][1]!
  const change = { seq: 5, kind: 'task_changed', payload: { id: 'root', artifacts: [] } }
  event({ streamId, events: [change, change] })
  expect(getTaskState().tasks).toHaveLength(1)
  expect(getTaskState().watermark).toBe(5)
  await refreshTaskState()
  expect(getTaskState().tasks).toHaveLength(1)
  releases.shift()!()
  expect(window.workwise.stopSse).not.toHaveBeenCalled()
  releases.shift()!()
  expect(window.workwise.stopSse).toHaveBeenCalledWith(streamId)
})
it('applies resolved attention and leaves OS deduplication to the persistent ledger', async () => {
  releases.push(retainTaskState()); await refreshTaskState(); await Promise.resolve()
  const streamId = vi.mocked(window.workwise.startTaskSse).mock.calls[0][1]!
  event({ streamId, events: [{ seq: 5, kind: 'attention_changed', payload: { id: 'a', taskId: 'root', status: 'pending', title: '缺少阈值', message: '请选择规范', createdAt: 'now' } }] })
  expect(getTaskState().attention).toHaveLength(1)
  expect(window.workwise.notifyTask).toHaveBeenCalledTimes(1)
  event({ streamId, events: [{ seq: 6, kind: 'attention_changed', payload: { id: 'a', status: 'answered' } }] })
  expect(getTaskState().attention).toEqual([])
})
