import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeUpdateLifecycle, type UpdateActiveWork } from './runtime-update-lifecycle.js'

const work: UpdateActiveWork = { kind: 'agent', id: 'task', label: '报告', status: 'running', recoverable: true }
afterEach(() => vi.useRealTimers())

describe('Runtime update handoff', () => {
  it('checks the complete stable snapshot after suspending admission', async () => {
    const active = Array.from({ length: 620 }, (_, i) => ({ ...work, id: String(i) }))
    const stop = vi.fn(async () => undefined)
    const resume = vi.fn()
    const lifecycle = new RuntimeUpdateLifecycle({ snapshot: () => active, suspend: async () => undefined, resume, stop })
    const snapshot = lifecycle.snapshot()
    expect(snapshot.activeWork).toHaveLength(620)
    active.push({ ...work, id: 'new-task' })
    await expect(lifecycle.prepare(snapshot.snapshotId)).rejects.toThrow('运行任务已变化')
    expect(stop).not.toHaveBeenCalled()
    expect(resume).toHaveBeenCalledOnce()
    expect(lifecycle.isSuspended()).toBe(false)
    await lifecycle.prepare(lifecycle.snapshot().snapshotId)
    expect(lifecycle.isSuspended()).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('refuses unsafe work even with a matching snapshot and restores normal admission', async () => {
    const stop = vi.fn(async () => undefined)
    const resume = vi.fn()
    const lifecycle = new RuntimeUpdateLifecycle({ snapshot: () => [{ ...work, recoverable: false }], suspend: async () => undefined, resume, stop })
    await expect(lifecycle.prepare(lifecycle.snapshot().snapshotId)).rejects.toThrow('无法安全暂停')
    expect(stop).not.toHaveBeenCalled()
    expect(lifecycle.isSuspended()).toBe(false)
    expect(resume).toHaveBeenCalledOnce()
  })

  it('retains one handoff on timeout and can verify its later completion', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const stop = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const lifecycle = new RuntimeUpdateLifecycle({ snapshot: () => [], suspend: async () => undefined, resume: vi.fn(), stop, timeoutMs: 100 })
    const pending = expect(lifecycle.prepare()).rejects.toThrow('更新包已保留')
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(lifecycle.isSuspended()).toBe(true)
    const retry = lifecycle.prepare()
    finish()
    await retry
    expect(stop).toHaveBeenCalledOnce()
  })
})
