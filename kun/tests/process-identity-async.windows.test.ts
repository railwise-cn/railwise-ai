import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { processIdentityAsync } from '../src/services/process-identity.js'

it.skipIf(process.platform !== 'win32')('verifies an actual owned Windows process without blocking the event loop', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
  const closed = once(child, 'close')
  try {
    await once(child, 'spawn')
    expect(child.pid).toBeGreaterThan(0)
    let probeFinished = false
    const pending = processIdentityAsync(child.pid).then(value => { probeFinished = true; return value })
    let timerRan = false
    await new Promise<void>(resolve => setTimeout(() => { timerRan = true; resolve() }, 0))
    expect(timerRan).toBe(true)
    expect(probeFinished).toBe(false)
    const first = await pending
    expect(first?.pid).toBe(child.pid)
    expect(first?.fingerprint).toMatch(/^win32:\d+$/)
    expect(await processIdentityAsync(child.pid)).toEqual(first)
    expect(child.exitCode).toBeNull()
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await closed
  }
}, 25_000)
