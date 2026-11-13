import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { processIdentityAsync } from './process-identity.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }))

describe('asynchronous Windows process birth verification', () => {
  beforeEach(() => { vi.stubGlobal('process', { ...process, platform: 'win32' }); vi.mocked(execFile).mockReset() })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('keeps the event loop responsive while a cold probe exceeds the old three second limit', async () => {
    vi.useFakeTimers()
    vi.mocked(execFile).mockImplementation((_path, _args, _options, callback: any) => {
      setTimeout(() => callback(null, '638986138361234567\r\n'), 4500)
      return {} as any
    })
    let finished = false
    const pending = processIdentityAsync(3324).then(value => { finished = true; return value })
    await vi.advanceTimersByTimeAsync(3001)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1499)
    expect(await pending).toEqual({ pid: 3324, fingerprint: 'win32:638986138361234567' })
    expect(execFile).toHaveBeenCalledExactlyOnceWith('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-Process -Id 3324 -ErrorAction Stop).StartTime.ToUniversalTime().Ticks'],
    expect.objectContaining({ timeout: 10_000, windowsHide: true, encoding: 'utf8' }), expect.any(Function))
  })

  it.each(['', '123 invalid', 'unverified:3324'])('does not treat malformed output as a birth fingerprint: %j', async stdout => {
    vi.mocked(execFile).mockImplementation((_path, _args, _options, callback: any) => { callback(null, stdout); return {} as any })
    expect(await processIdentityAsync(3324)).toBeNull()
  })

  it('passes a smaller remaining budget and refuses timeout or aborted late success', async () => {
    const controller = new AbortController()
    let complete!: (error: Error | null, stdout: string) => void
    vi.mocked(execFile).mockImplementation((_path, _args, _options, callback: any) => { complete = callback; return {} as any })
    const pending = processIdentityAsync(3324, { timeoutMs: 1750, signal: controller.signal })
    expect(execFile).toHaveBeenCalledWith(expect.any(String), expect.any(Array),
      expect.objectContaining({ timeout: 1750, signal: controller.signal }), expect.any(Function))
    controller.abort()
    complete(null, '638986138361234567')
    expect(await pending).toBeNull()
    const failed = processIdentityAsync(3324)
    complete(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), '638986138361234567')
    expect(await failed).toBeNull()
  })

  it('never launches a probe for an invalid PID, expired budget or pre-aborted signal', async () => {
    const controller = new AbortController(); controller.abort()
    for (const pid of [-1, 0, 1.5, Number.NaN]) expect(await processIdentityAsync(pid)).toBeNull()
    for (const timeoutMs of [0, -1, 10_001, Number.NaN]) expect(await processIdentityAsync(3324, { timeoutMs })).toBeNull()
    expect(await processIdentityAsync(3324, { signal: controller.signal })).toBeNull()
    expect(execFile).not.toHaveBeenCalled()
  })

  it('fails closed if spawning the verifier throws', async () => {
    vi.mocked(execFile).mockImplementation(() => { throw new Error('spawn unavailable') })
    expect(await processIdentityAsync(3324)).toBeNull()
  })
})
