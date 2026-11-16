import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { inspectProcess, processIdentity } from './process-identity.js'

vi.mock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }))

describe('persistent macOS birth identity', () => {
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    vi.mocked(execFileSync).mockReset().mockReturnValue('Sat Nov 14 00:54:04 2026\n')
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('uses fixed locale and UTC regardless of the launching shell', () => {
    const first = processIdentity(17040)
    expect(first).toEqual({ pid: 17040, fingerprint: 'darwin-utc:Sat Nov 14 00:54:04 2026' })
    expect(execFileSync).toHaveBeenCalledWith('/bin/ps', ['-p', '17040', '-o', 'lstart='],
      expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C', LANG: 'C', TZ: 'UTC' }) }))
    expect(inspectProcess(first!)).toBe('alive')
  })

  it.each(['darwin:六 11月/14 07:54:04 2026', 'darwin:Sat Nov 14 07:54:04 2026'])('does not mistake a legacy locale-dependent birth mismatch for an exited owner', fingerprint => {
    expect(inspectProcess({ pid: 17040, fingerprint })).toBe('unknown')
  })

  it('detects different canonical birth times without adopting a recycled PID', () => {
    expect(inspectProcess({ pid: 17040, fingerprint: 'darwin-utc:Sat Nov 14 00:53:04 2026' })).toBe('exited')
  })
})
