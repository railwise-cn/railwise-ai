// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getTaskState, refreshTaskState, resetTaskStateForTests, retainTaskState, updateTaskNavigation } from './task-live-store'
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
it('keeps drafts and old unverified web HTML silent, then notifies a verified version without changing ordinary file notifications', async () => {
  releases.push(retainTaskState()); await refreshTaskState(); await Promise.resolve()
  const streamId = vi.mocked(window.workwise.startTaskSse).mock.calls[0][1]!
  const base = { id: 'root', acceptance: { requiresWebEvidence: true }, artifacts: [
    { id: 'draft', relativePath: 'draft.html', validation: 'valid', sha256: 'same-hash', sourceEvidenceStatus: 'draft' },
    { id: 'legacy', relativePath: 'legacy.htm', validation: 'valid', sha256: 'legacy-hash' },
    { id: 'invalid-proof', relativePath: 'missing-proof.html', validation: 'valid', sha256: 'missing-proof', sourceEvidenceStatus: 'verified' },
    { id: 'file', relativePath: 'data.csv', validation: 'valid', sha256: 'csv-hash' }
  ] }
  event({ streamId, events: [{ seq: 5, kind: 'task_changed', payload: base }] })
  expect(vi.mocked(window.workwise.notifyTask).mock.calls.map(([value]) => value.body)).toEqual(['data.csv'])
  vi.mocked(window.workwise.notifyTask).mockClear()
  const verified = { ...base, artifacts: [{ ...base.artifacts[0], sourceEvidenceStatus: 'verified', sourceEvidenceReceiptId: 'proof-exact-hash' }] }
  event({ streamId, events: [{ seq: 6, kind: 'task_changed', payload: verified }, { seq: 6, kind: 'task_changed', payload: verified }] })
  expect(window.workwise.notifyTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: 'artifact:root:draft:same-hash', kind: 'artifact', body: 'draft.html' }))
})
it('preserves notifications for an ordinary HTML file that has no web-source requirement', async () => {
  releases.push(retainTaskState()); await refreshTaskState(); await Promise.resolve()
  const streamId = vi.mocked(window.workwise.startTaskSse).mock.calls[0][1]!
  event({ streamId, events: [{ seq: 5, kind: 'task_changed', payload: { id: 'local-page', acceptance: { requiresWebEvidence: false },
    artifacts: [{ id: 'html', relativePath: 'calculator.html', sha256: 'local-hash', validation: 'valid' }] } }] })
  expect(window.workwise.notifyTask).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'artifact', body: 'calculator.html' }))
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

it('keeps unchanged navigation snapshots stable, including empty task selection', () => {
  const before = getTaskState()
  updateTaskNavigation({ selectedTaskId: null, selectedAttentionId: null })
  expect(getTaskState()).toBe(before)
  updateTaskNavigation({ search: 'report' })
  const changed = getTaskState()
  expect(changed.navigation.search).toBe('report')
  updateTaskNavigation({ search: 'report' })
  expect(getTaskState()).toBe(changed)
})
