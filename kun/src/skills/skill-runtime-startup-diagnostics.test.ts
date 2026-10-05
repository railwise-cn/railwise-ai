import { readdir, stat } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillRuntime } from './skill-runtime.js'

vi.mock('node:fs/promises', () => ({ readdir: vi.fn(), readFile: vi.fn(), stat: vi.fn() }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(stat).mockRejectedValue(new Error('missing optional manifest'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

const config = { enabled: true, roots: ['/test/skills'], legacySkillMd: true }

describe('pending skill root startup diagnostics', () => {
  it('logs a stalled root once after five seconds and waits for its original result', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    let complete!: (value: []) => void
    vi.mocked(readdir).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    let completed = false
    const pending = SkillRuntime.create(config, { discoveryWaitMs: 20_000 }).then((runtime) => { completed = true; return runtime })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(log).not.toHaveBeenCalled()
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(log.mock.calls).toEqual([['[runtime startup] skills pending-root="/test/skills" elapsedMs=5000']])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(log).toHaveBeenCalledTimes(1)
    expect(completed).toBe(false)
    complete([])
    expect((await pending).diagnostics().validationErrors).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer when a root completes quickly', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.mocked(readdir).mockResolvedValueOnce([])
    await SkillRuntime.create(config)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(log).not.toHaveBeenCalled()
  })

  it('retains discovery errors in diagnostics and never logs their payloads', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.mocked(readdir).mockRejectedValueOnce(new Error('private filesystem error'))
    const runtime = await SkillRuntime.create(config)
    expect(runtime.diagnostics().validationErrors).toEqual([
      { root: '/test/skills', message: 'private filesystem error' }
    ])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(log).not.toHaveBeenCalled()
  })
})
