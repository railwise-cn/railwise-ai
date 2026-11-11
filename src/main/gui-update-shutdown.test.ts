import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGuiUpdateShutdown } from './gui-update-shutdown'

afterEach(() => vi.useRealTimers())

describe('update shutdown confirmation', () => {
  it('times out without declaring success and reuses the same live shutdown on retry', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const stop = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const shutdown = createGuiUpdateShutdown(stop, 100)
    const first = expect(shutdown()).rejects.toThrow('更新包已保留')
    await vi.advanceTimersByTimeAsync(100)
    await first
    const retry = shutdown()
    expect(stop).toHaveBeenCalledTimes(1)
    finish()
    await retry
    await shutdown()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('permits another attempt after an observed cleanup failure', async () => {
    const stop = vi.fn().mockRejectedValueOnce(new Error('persistence failed')).mockResolvedValue(undefined)
    const shutdown = createGuiUpdateShutdown(stop)
    await expect(shutdown()).rejects.toThrow('persistence failed')
    await expect(shutdown()).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledTimes(2)
  })
})
