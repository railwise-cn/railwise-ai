import { afterEach, describe, expect, it, vi } from 'vitest'
import { traceRuntimeStartupPhase } from './runtime-startup-diagnostics.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('internal startup phase diagnostics', () => {
  it('records phase timing without including the operation result', async () => {
    vi.useFakeTimers()
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const result = { privateData: 'must never be logged' }
    const pending = traceRuntimeStartupPhase('skills', async () => {
      await new Promise((resolve) => setTimeout(resolve, 120))
      return result
    })
    expect(log.mock.calls).toEqual([['[runtime startup] skills begin']])
    await vi.advanceTimersByTimeAsync(120)
    expect(await pending).toBe(result)
    expect(log.mock.calls).toEqual([
      ['[runtime startup] skills begin'],
      ['[runtime startup] skills done elapsedMs=120']
    ])
  })

  it('preserves an error without logging its potentially sensitive message', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const failure = new Error('credential-bearing internal error')
    await expect(traceRuntimeStartupPhase('attachment-cleanup', async () => {
      throw failure
    })).rejects.toBe(failure)
    expect(log.mock.calls).toHaveLength(2)
    expect(log.mock.calls[1]?.[0]).toMatch(/^\[runtime startup\] attachment-cleanup failed elapsedMs=\d+$/)
    expect(JSON.stringify(log.mock.calls)).not.toContain(failure.message)
  })
})
