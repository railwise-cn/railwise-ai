// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getTaskState, refreshTaskState, resetTaskStateForTests, retainTaskState, updateTaskNavigation } from './task-live-store'
let event: (payload: { streamId: string; events: unknown[] }) => void
let ended: (payload: { streamId: string }) => void
let failed: (payload: { streamId: string; message?: string }) => void
const releases: Array<() => void> = []
beforeEach(() => {
  resetTaskStateForTests()
  Object.defineProperty(window, 'workwise', { configurable: true, value: {
    listTaskPage: vi.fn(async () => ({ items: [], relatedTasks: [], attention: [], eventWatermark: 4 })),
    startTaskSse: vi.fn(async () => undefined), stopSse: vi.fn(async () => undefined),
    notifyTask: vi.fn(async () => undefined),
    onSseEvent: vi.fn(cb => { event = cb; return () => undefined }),
    onSseEnd: vi.fn(cb => { ended=cb;return () => undefined }), onSseError: vi.fn(cb => { failed=cb;return () => undefined })
  } })
})
afterEach(() => { for (const release of releases.splice(0)) release(); resetTaskStateForTests(); Reflect.deleteProperty(window, 'workwise');vi.useRealTimers() })
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

it('applies only current streamed progress without replacing task bytes, advancing replay, refreshing lists, or notifying artifacts', async () => {
  const task={id:'root',revision:7,activeTurnId:'turn-current',status:'running',artifacts:[],budget:{maxAttempts:8},attempts:2}
  vi.mocked(window.workwise.listTaskPage).mockResolvedValue({items:[task],relatedTasks:[],attention:[],eventWatermark:4} as never)
  releases.push(retainTaskState());await refreshTaskState();await Promise.resolve()
  const streamId=vi.mocked(window.workwise.startTaskSse).mock.calls[0][1]!,before=getTaskState(),tasks=before.tasks
  const sample={taskId:'root',taskRevision:7,turnId:'turn-current',executionId:'execution-current',leaseRevision:3,leaseExpiresAt:'2026-11-16T12:01:00Z',active:true,
    sampledAt:'2026-11-16T12:00:15Z',timing:{executionMs:15000,queuedMs:0,humanWaitMs:0,pausedMs:0,sampledAt:'2026-11-16T12:00:15Z',coverage:'complete'},activity:{phase:'reading'}}
  const change={kind:'task_progress',taskId:'root',payload:sample}
  event({streamId:'old-stream',events:[change]});expect(getTaskState()).toBe(before)
  event({streamId,events:[change,change]})
  const projected=getTaskState();expect(projected.progress.root.activity?.phase).toBe('reading');expect(projected.progress.root.timing?.executionMs).toBe(15000)
  expect(projected.tasks).toBe(tasks);expect(projected.tasks[0]).toEqual(task);expect(projected.watermark).toBe(4);expect(projected.generation).toBe(before.generation)
  expect(window.workwise.listTaskPage).toHaveBeenCalledTimes(1);expect(window.workwise.notifyTask).not.toHaveBeenCalled()
  for(const patch of [{taskRevision:6},{taskRevision:undefined},{turnId:'old-turn'},{turnId:undefined},{executionId:undefined},{leaseRevision:undefined},
    {taskId:'other'},{sampledAt:'invalid'},{activity:{phase:'model-controlled-message'}},{leaseExpiresAt:'2026-11-16T11:59:00Z'}]){
    event({streamId,events:[{...change,payload:{...sample,sampledAt:'2026-11-16T12:00:30Z',...patch}}]});expect(getTaskState()).toBe(projected)
  }
  event({streamId,events:[{...change,payload:{...sample,sampledAt:'2026-11-16T12:00:30Z',timing:undefined,active:false,activity:undefined}}]})
  expect(getTaskState().progress.root.activity).toBeUndefined()
  event({streamId,events:[{seq:5,kind:'task_changed',payload:{...task,status:'waiting_user',revision:8}}]})
  expect(getTaskState().progress.root).toBeUndefined();expect(getTaskState().watermark).toBe(5)
  event({streamId,events:[{...change,payload:{...sample,taskRevision:8,sampledAt:'2026-11-16T12:00:45Z'}}]})
  expect(getTaskState().progress.root).toBeUndefined()
  releases.shift()!();const stopped=getTaskState();event({streamId,events:[change]});expect(getTaskState()).toBe(stopped)
})

it('stops the phase on a current stream error/end and restores it only from a fresh sample of the replacement stream', async () => {
  vi.useFakeTimers();vi.setSystemTime('2026-11-16T12:00:15Z')
  const task={id:'root',revision:1,activeTurnId:'turn',status:'running',artifacts:[]}
  vi.mocked(window.workwise.listTaskPage).mockResolvedValue({items:[task],relatedTasks:[],attention:[],eventWatermark:4} as never)
  releases.push(retainTaskState());await refreshTaskState();await Promise.resolve()
  const streamId=vi.mocked(window.workwise.startTaskSse).mock.calls[0][1]!
  const sample={kind:'task_progress',taskId:'root',payload:{taskId:'root',taskRevision:1,turnId:'turn',executionId:'attempt',leaseRevision:0,leaseExpiresAt:'2026-11-16T12:01:00Z',active:true,
    sampledAt:'2026-11-16T12:00:15Z',activity:{phase:'reading'},timing:{executionMs:15000,queuedMs:0,humanWaitMs:0,pausedMs:0,sampledAt:'2026-11-16T12:00:15Z',coverage:'complete'}}}
  event({streamId,events:[sample]});expect(getTaskState().progress.root.activity?.phase).toBe('reading')
  failed({streamId,message:'Connection lost'})
  expect(getTaskState().progress.root.activity).toBeUndefined();expect(getTaskState().progress.root.timing?.executionMs).toBe(15000);expect(getTaskState().tasks[0]).toEqual(task)
  ended({streamId});ended({streamId});await vi.advanceTimersByTimeAsync(1000);await Promise.resolve()
  expect(window.workwise.startTaskSse).toHaveBeenCalledTimes(2)
  const nextId=vi.mocked(window.workwise.startTaskSse).mock.calls[1][1]!
  const fresh={...sample,payload:{...sample.payload,sampledAt:'2026-11-16T12:00:16Z',timing:undefined}}
  event({streamId,events:[fresh]});expect(getTaskState().progress.root.activity).toBeUndefined()
  event({streamId:nextId,events:[fresh]});expect(getTaskState().progress.root.activity?.phase).toBe('reading');expect(getTaskState().error).toBeNull()
  ended({streamId:'old-stream'});expect(getTaskState().progress.root.activity?.phase).toBe('reading')
  ended({streamId:nextId});expect(getTaskState().progress.root.activity).toBeUndefined()
})
