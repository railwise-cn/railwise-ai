import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConfirmedQuit, stopRuntimeAfterCleanup } from './confirmed-shutdown'

afterEach(() => vi.useRealTimers())

describe('confirmed application shutdown', () => {
  it('waits beyond the former GUI deadline and shares simultaneous quit attempts', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const stop = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const quit = vi.fn()
    const onFailure = vi.fn()
    const requestQuit = createConfirmedQuit({ stop, quit, onFailure })
    const first = requestQuit()
    expect(requestQuit()).toBe(first)
    await vi.advanceTimersByTimeAsync(6000)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
    release()
    await expect(first).resolves.toBe(true)
    expect(quit).toHaveBeenCalledTimes(1)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('does not quit on a failed stop and permits a subsequent confirmed retry', async () => {
    const failure = new Error('Runtime exit unconfirmed')
    const stop = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)
    const quit = vi.fn()
    const onFailure = vi.fn()
    const requestQuit = createConfirmedQuit({ stop, quit, onFailure })
    await expect(requestQuit()).resolves.toBe(false)
    expect(quit).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith(failure)
    await expect(requestQuit()).resolves.toBe(true)
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('attempts the actual Runtime stop even when earlier cleanup fails', async () => {
    const cleanupFailure = new Error('Pending settings write failed')
    const stopRuntime = vi.fn().mockResolvedValue(undefined)
    const stop = () => stopRuntimeAfterCleanup({
      cleanup: async () => { throw cleanupFailure }, stopRuntime, isRuntimeRunning: () => false
    })
    const quit = vi.fn()
    const onFailure = vi.fn()
    await expect(createConfirmedQuit({ stop, quit, onFailure })()).resolves.toBe(false)
    expect(stopRuntime).toHaveBeenCalledTimes(1)
    expect(quit).not.toHaveBeenCalled()
    expect(onFailure).toHaveBeenCalledWith(cleanupFailure)
  })

  it('rejects a resolved stop when the owned Runtime remains alive', async () => {
    const quit = vi.fn()
    const onFailure = vi.fn()
    const stop = () => stopRuntimeAfterCleanup({
      cleanup: async () => {}, stopRuntime: async () => {}, isRuntimeRunning: () => true
    })
    await expect(createConfirmedQuit({ stop, quit, onFailure })()).resolves.toBe(false)
    expect(quit).not.toHaveBeenCalled()
    expect(onFailure.mock.calls[0][0].message).toContain('exit could not be confirmed')
  })

  it('retains both cleanup and process-stop failures for diagnosis', async () => {
    const cleanupFailure = new Error('cleanup failed')
    const stopFailure = new Error('stop failed')
    await expect(stopRuntimeAfterCleanup({
      cleanup: async () => { throw cleanupFailure },
      stopRuntime: async () => { throw stopFailure },
      isRuntimeRunning: () => true
    })).rejects.toMatchObject({ errors: [cleanupFailure, stopFailure] })
  })

  it('wires normal Electron quit events through confirmed shutdown while retaining strict updater stopping', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const quit = source.slice(source.indexOf('async function stopManagedRuntimesForQuit'), source.indexOf('async function loadGuiUpdaterModule'))
    expect(quit).toContain('await stopManagedRuntimes()')
    expect(quit).toContain('await disposeManagedBrowserForExit()')
    expect(quit).not.toContain('Promise.race')
    expect(quit).not.toContain('managedRuntimesStoppedForQuit = true')
    const events = source.slice(source.indexOf("app.on('window-all-closed'"))
    expect(events.match(/void requestConfirmedQuit\(\)/g)).toHaveLength(2)
    expect(events).not.toContain('.finally(')
    expect(events).not.toContain('managedRuntimesStoppedForQuit = true')
    expect(source).toContain('requireCleanExit: true, timeoutMs: 30_000')
    expect(source).toContain('await stopManagedRuntimes(true)')
  })
})
