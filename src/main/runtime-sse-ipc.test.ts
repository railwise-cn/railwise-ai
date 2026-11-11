import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettingsV1 } from '../shared/app-settings'
import { defaultKunRuntimeSettings } from '../shared/app-settings'
import { appCancellationRegistry } from './cancellation-registry'
import { registerRuntimeSseIpc, stopAllRuntimeSse } from './runtime-sse-ipc'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown

function createHarness(options: { ensureRuntime?: () => Promise<void> } = {}) {
  const handlers = new Map<string, InvokeHandler>()
  const ipcMain = {
    handle: vi.fn((channel: string, handler: InvokeHandler) => {
      handlers.set(channel, handler)
    })
  } as unknown as IpcMain
  const settings = {
    agents: { kun: defaultKunRuntimeSettings() }
  } as AppSettingsV1
  const load = vi.fn(async () => settings)
  const ensureRuntime = vi.fn(options.ensureRuntime ?? (async () => undefined))

  registerRuntimeSseIpc({
    ipcMain,
    store: { load } as never,
    ensureRuntime,
    logError: vi.fn()
  })

  const sender = {
    id: 42,
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  }
  const event = { sender } as unknown as IpcMainInvokeEvent

  return {
    settings, load, ensureRuntime, sender,
    start: (streamId: string, threadId = 'thread-1', scope: 'thread' | 'tasks' = 'thread') =>
      handlers.get('runtime:sse:start')?.(event, {
        ...(scope === 'thread' ? { threadId } : {}),
        scope,
        sinceSeq: 0,
        streamId
      }),
    stop: (streamId: string) =>
      handlers.get('runtime:sse:stop')?.(event, streamId)
  }
}

describe('runtime SSE IPC lifecycle', () => {
  beforeEach(async () => {
    await stopAllRuntimeSse('test_reset')
    // Deliberately never settle. This simulates a fetch implementation that
    // does not observe abort immediately and exposes stale controller leaks.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))
  })

  afterEach(async () => {
    await stopAllRuntimeSse('test_cleanup')
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each(['tasks', 'thread'] as const)('reloads the endpoint and auth while retaining the %s cursor on reconnect', async scope => {
    vi.useFakeTimers()
    const harness = createHarness()
    harness.settings.agents.kun.port = 43101
    harness.settings.agents.kun.runtimeToken = 'old-test-token'
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('id: 7\nevent: task_updated\ndata: {"taskId":"task-fixture"}\n\n') })
      .mockRejectedValueOnce(new Error('network disconnected'))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, body: { getReader: () => ({ read }) } })
      .mockImplementation(() => new Promise<Response>(() => undefined))
    vi.stubGlobal('fetch', fetchMock)

    await harness.start('reconnect-stream', 'thread-fixture', scope)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const nextSettings = structuredClone(harness.settings)
    nextSettings.agents.kun.port = 43102
    nextSettings.agents.kun.runtimeToken = 'new-test-token'
    harness.load.mockResolvedValue(nextSettings)
    await vi.advanceTimersByTimeAsync(750)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, options] = fetchMock.mock.calls[1]!
    expect(url.port).toBe('43102')
    expect(url.searchParams.get('since_seq')).toBe('7')
    expect(url.pathname).toBe(scope === 'tasks' ? '/v1/tasks/stream' : '/v1/threads/thread-fixture/events')
    expect(options.headers.authorization).toBe('Bearer new-test-token')
    expect(options.headers['Last-Event-ID']).toBe('7')
    expect(harness.ensureRuntime).toHaveBeenLastCalledWith(nextSettings)
    await harness.stop('reconnect-stream')
    expect(options.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['settings', 'runtime'] as const)('keeps a stopped subscription stopped during reconnect %s refresh', async phase => {
    vi.useFakeTimers()
    const harness = createHarness()
    const fetchMock = vi.fn().mockRejectedValue(new Error('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    await harness.start('stopped-reconnect', 'thread-fixture', 'tasks')
    await vi.advanceTimersByTimeAsync(0)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    if (phase === 'settings') harness.load.mockImplementationOnce(async () => { await pending; return harness.settings })
    else harness.ensureRuntime.mockImplementationOnce(() => pending)
    await vi.advanceTimersByTimeAsync(750)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(harness.stop('stopped-reconnect')).resolves.toBe(true)
    release()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('releases stopped streams synchronously before a replacement starts', async () => {
    const harness = createHarness()

    for (let index = 0; index < 12; index += 1) {
      const streamId = `stream-${index}`
      await expect(harness.start(streamId)).resolves.toEqual({ streamId })
      await expect(harness.stop(streamId)).resolves.toBe(true)
    }
  })

  it('does not let a replaced stream consume an additional connection slot', async () => {
    const harness = createHarness()

    await expect(harness.start('stable-stream')).resolves.toEqual({ streamId: 'stable-stream' })
    await expect(harness.start('stable-stream')).resolves.toEqual({ streamId: 'stable-stream' })
    await expect(harness.stop('stable-stream')).resolves.toBe(true)
  })

  it('retires a stale stream with a different id when the same window subscribes again', async () => {
    const harness = createHarness()

    await expect(harness.start('stale-stream')).resolves.toEqual({ streamId: 'stale-stream' })
    await expect(harness.start('current-stream')).resolves.toEqual({ streamId: 'current-stream' })
    await expect(harness.stop('stale-stream')).resolves.toBe(false)
    await expect(harness.stop('current-stream')).resolves.toBe(true)
  })

  it('does not accumulate connection slots when one thread repeatedly resubscribes', async () => {
    const harness = createHarness()

    for (let index = 0; index < 12; index += 1) {
      const streamId = `recovery-stream-${index}`
      await expect(harness.start(streamId, 'recovering-thread')).resolves.toEqual({ streamId })
    }
    await expect(harness.stop('recovery-stream-0')).resolves.toBe(false)
    await expect(harness.stop('recovery-stream-11')).resolves.toBe(true)
  })

  it('does not register an orphaned stream when stop wins the start IPC race', async () => {
    let releaseRuntime!: () => void
    const runtimeReady = new Promise<void>((resolve) => {
      releaseRuntime = resolve
    })
    const harness = createHarness({ ensureRuntime: () => runtimeReady })

    const pendingStart = harness.start('early-stopped-stream', 'thread-race')
    await expect(harness.stop('early-stopped-stream')).resolves.toBe(false)
    releaseRuntime()
    await expect(pendingStart).resolves.toEqual({ streamId: 'early-stopped-stream' })
    await expect(harness.stop('early-stopped-stream')).resolves.toBe(false)

    for (let index = 0; index < 12; index += 1) {
      const streamId = `post-race-stream-${index}`
      await expect(harness.start(streamId, `thread-${index}`)).resolves.toEqual({ streamId })
      await expect(harness.stop(streamId)).resolves.toBe(true)
    }
  })

  it('keeps distinct side conversation streams connected in the same window', async () => {
    const harness = createHarness()

    await expect(harness.start('main-stream', 'main-thread')).resolves.toEqual({ streamId: 'main-stream' })
    await expect(harness.start('side-stream', 'side-thread')).resolves.toEqual({ streamId: 'side-stream' })
    await expect(harness.stop('main-stream')).resolves.toBe(true)
    await expect(harness.stop('side-stream')).resolves.toBe(true)
  })

  it('releases the stream slot when its renderer window is cancelled', async () => {
    const harness = createHarness()

    await expect(harness.start('window-stream')).resolves.toEqual({ streamId: 'window-stream' })
    await appCancellationRegistry.cancel({ scope: 'window', id: '42' }, 'window_destroyed')
    await expect(harness.start('replacement-stream')).resolves.toEqual({ streamId: 'replacement-stream' })
    await expect(harness.stop('replacement-stream')).resolves.toBe(true)
  })
})
