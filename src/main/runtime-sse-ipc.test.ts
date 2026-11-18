import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { createServer, type ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettingsV1 } from '../shared/app-settings'
import { defaultKunRuntimeSettings } from '../shared/app-settings'
import { appCancellationRegistry } from './cancellation-registry'
import { registerRuntimeSseIpc, stopAllRuntimeSse } from './runtime-sse-ipc'

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
const nativeFetch = globalThis.fetch

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

  it('reconnects a severed real SSE socket with the same subscription and delivers each reply fragment once', async () => {
    vi.stubGlobal('fetch', nativeFetch)
    const harness = createHarness()
    let firstResponse: ServerResponse | undefined
    const cursors: { since: string | null; lastId: string | undefined }[] = []
    const part = (seq: number, text: string) => `id: ${seq}\nevent: assistant_text_delta\ndata: ${JSON.stringify({ item: { text } })}\n\n`
    const server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1')
      cursors.push({ since: url.searchParams.get('since_seq'), lastId: request.headers['last-event-id'] as string | undefined })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (cursors.length === 1) {
        firstResponse = response
        response.write(part(7, 'before disconnect'))
      } else {
        response.write(part(8, 'during disconnect'))
      }
    })
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected an owned loopback SSE server')
    harness.settings.agents.kun.port = address.port
    const batches = () => harness.sender.send.mock.calls.filter(([channel]) => channel === 'runtime:sse-event').map(([, batch]) => batch)
    try {
      await harness.start('actual-stream', 'thread-fixture')
      await vi.waitFor(() => expect(batches()).toHaveLength(1))
      firstResponse!.destroy()
      await vi.waitFor(() => expect(batches()).toHaveLength(2), { timeout: 4_000 })
      expect(cursors).toEqual([{ since: '0', lastId: undefined }, { since: '7', lastId: '7' }])
      expect(batches().map(batch => batch.streamId)).toEqual(['actual-stream', 'actual-stream'])
      expect(batches().flatMap(batch => batch.events.map((event: { seq: number; item: { text: string } }) => [event.seq, event.item.text])))
        .toEqual([[7, 'before disconnect'], [8, 'during disconnect']])
      expect(harness.sender.send).not.toHaveBeenCalledWith('runtime:sse-error', expect.anything())
      expect(harness.sender.send).not.toHaveBeenCalledWith('runtime:sse-end', expect.anything())
    } finally {
      await harness.stop('actual-stream')
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    }
  })

  it('carries task progress without allocating a durable cursor and reconnects from the original task change', async () => {
    vi.useFakeTimers()
    const harness=createHarness(),progress={kind:'task_progress',taskId:'task-fixture',payload:{taskId:'task-fixture',taskRevision:2,turnId:'turn',sampledAt:'2026-11-16T12:00:15Z'}}
    const read=vi.fn().mockResolvedValueOnce({done:false,value:new TextEncoder().encode(`id: 9\nevent: task_changed\ndata: {"seq":9,"kind":"task_changed","payload":{"id":"task-fixture"}}\n\nevent: task_progress\ndata: ${JSON.stringify(progress)}\n\n`)})
      .mockRejectedValueOnce(new Error('network disconnected'))
    const fetchMock=vi.fn().mockResolvedValueOnce({ok:true,body:{getReader:()=>({read})}}).mockImplementation(()=>new Promise<Response>(()=>undefined))
    vi.stubGlobal('fetch',fetchMock)
    await harness.start('progress-stream','unused','tasks');await vi.advanceTimersByTimeAsync(0)
    const batches=harness.sender.send.mock.calls.filter(([name])=>name==='runtime:sse-event').flatMap(([,value])=>value.events)
    expect(batches.find(value=>value.kind==='task_progress')).toEqual(progress)
    expect(batches.find(value=>value.kind==='task_progress')).not.toHaveProperty('seq')
    await vi.advanceTimersByTimeAsync(750)
    expect(fetchMock.mock.calls[1][0].searchParams.get('since_seq')).toBe('9')
    expect(fetchMock.mock.calls[1][1].headers['Last-Event-ID']).toBe('9')
    await harness.stop('progress-stream')
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
