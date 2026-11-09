import type { IpcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'
import type { AppSettingsV1 } from '../shared/app-settings'
import { RUNTIME_RESOURCE_LIMITS_V1 } from '../shared/runtime-resource-limits'
import { runtimeThreadEventsPath } from '../shared/runtime-endpoints'
import { sseStartPayloadSchema, streamIdSchema } from './ipc/app-ipc-schemas'
import type { JsonSettingsStore } from './settings-store'
import { getRuntimeBaseUrlForSettings, runtimeAuthHeaders } from './runtime/managed-runtime-adapter'
import { appCancellationRegistry } from './cancellation-registry'

type SseControllerState = {
  controller: AbortController
  stoppedByClient: boolean
  rendererId: number
  threadId: string
  releaseCancellation: () => void
}

const SSE_RECONNECT_BASE_MS = 750
const SSE_RECONNECT_MAX_MS = 5_000
const SSE_START_TIMEOUT_MS = 15_000
const MAX_PRESTOPPED_STREAM_IDS = 256


const sseControllers = new Map<string, SseControllerState>()
// Renderer route switches can abort a subscription while the matching start
// IPC is still awaiting settings/runtime startup. Remember those early stops
// so the delayed start cannot register an orphaned stream after both renderer
// cleanup calls have already returned.
const preStoppedSseIds = new Set<string>()

function rememberPreStoppedSse(id: string): void {
  preStoppedSseIds.delete(id)
  preStoppedSseIds.add(id)
  while (preStoppedSseIds.size > MAX_PRESTOPPED_STREAM_IDS) {
    const oldest = preStoppedSseIds.values().next().value
    if (typeof oldest !== 'string') break
    preStoppedSseIds.delete(oldest)
  }
}

function consumePreStoppedSse(id: string): boolean {
  if (!preStoppedSseIds.has(id)) return false
  preStoppedSseIds.delete(id)
  return true
}

function stopSseController(id: string, reason = 'operation_cancelled'): boolean {
  const state = sseControllers.get(id)
  if (!state) return false

  state.stoppedByClient = true
  // Remove the stream before aborting the pending fetch. A renderer can start
  // its replacement subscription immediately, while the old fetch may take a
  // later microtask (or an unresponsive network stack) to reach `finally`.
  if (sseControllers.get(id) === state) {
    sseControllers.delete(id)
  }
  state.controller.abort(reason)
  state.releaseCancellation()
  return true
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function resourceLimitError(message: string): Error {
  return Object.assign(new Error(message), { code: 'resource_limit' })
}

function activeRendererStreams(rendererId: number): number {
  let count = 0
  for (const state of sseControllers.values()) {
    if (state.rendererId === rendererId) count += 1
  }
  return count
}

function stopRendererThreadSseControllers(
  rendererId: number,
  threadId: string,
  reason = 'renderer_thread_stream_replaced'
): void {
  for (const [id, state] of [...sseControllers.entries()]) {
    if (state.rendererId === rendererId && state.threadId === threadId) {
      stopSseController(id, reason)
    }
  }
}

export async function stopAllRuntimeSse(reason = 'application_exit'): Promise<void> {
  const ids = [...sseControllers.keys()]
  for (const id of ids) stopSseController(id, reason)
  preStoppedSseIds.clear()
  await Promise.all(
    ids.map((id) => appCancellationRegistry.cancel({ scope: 'subtask', id: `sse:${id}` }, reason))
  )
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function parseSseData(raw: string): { data: unknown; event?: string; id?: string } | null {
  const lines = raw.split('\n')
  const dataLines: string[] = []
  let eventName = ''
  let eventId = ''
  for (const line of lines) {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
    if (normalized.startsWith('event:')) {
      eventName = normalized.slice(6).trim()
      continue
    }
    if (normalized.startsWith('id:')) {
      eventId = normalized.slice(3).trim()
      continue
    }
    if (normalized.startsWith('data:')) {
      dataLines.push(normalized.slice(5).trimStart())
    }
  }
  if (!dataLines.length) return null
  const payload = dataLines.join('\n')
  try {
    return {
      data: JSON.parse(payload),
      ...(eventName ? { event: eventName } : {}),
      ...(eventId ? { id: eventId } : {})
    }
  } catch {
    return null
  }
}

function takeSseBlock(buffer: string): { block: string; rest: string } | null {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return null
  if (crlf !== -1 && (lf === -1 || crlf < lf)) {
    return {
      block: buffer.slice(0, crlf),
      rest: buffer.slice(crlf + 4)
    }
  }
  return {
    block: buffer.slice(0, lf),
    rest: buffer.slice(lf + 2)
  }
}

function coerceSsePayload(parsed: { data: unknown; event?: string; id?: string }): Record<string, unknown> {
  const payload: Record<string, unknown> =
    parsed.data && typeof parsed.data === 'object'
      ? { ...(parsed.data as Record<string, unknown>) }
      : { value: parsed.data }
  if (typeof payload.seq !== 'number' && parsed.id && /^\d+$/.test(parsed.id)) {
    payload.seq = Number(parsed.id)
  }
  if (typeof payload.kind !== 'string' && parsed.event) {
    payload.kind = parsed.event
  }
  return payload
}

function isFatalSseStatus(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429
}

async function fetchSseWithStartTimeout(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  timeoutMs: number
): Promise<Response> {
  const attempt = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    attempt.abort()
  }, timeoutMs)
  const onAbort = (): void => {
    attempt.abort()
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetch(url, { signal: attempt.signal, headers })
  } catch (error) {
    if (timedOut) {
      throw new Error('sse start timeout')
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export function registerRuntimeSseIpc(options: {
  ipcMain: IpcMain
  store: JsonSettingsStore
  ensureRuntime: (settings: AppSettingsV1) => Promise<void>
  logError: (category: string, message: string, detail?: unknown) => void
}): void {
  const { ipcMain, store, ensureRuntime, logError } = options
  ipcMain.handle('runtime:sse:start', async (event, args: unknown) => {
    const parsedRequest = sseStartPayloadSchema.parse(args)
    if (parsedRequest.scope === 'thread' && !parsedRequest.threadId) throw new Error('A thread stream requires threadId.')
    const request = { ...parsedRequest, threadId: parsedRequest.threadId ?? '@tasks' }
    const s = await store.load()
    await ensureRuntime(s)
    const requestedId = request.streamId?.trim() ?? ''
    const id = requestedId || randomUUID()
    if (consumePreStoppedSse(id)) {
      return { streamId: id }
    }
    stopSseController(id, 'stream_replaced')
    // A route switch, turn recovery, or React remount can race with the old
    // stop IPC and generate a new stream id for the same thread. Retire only
    // that thread's previous subscription. Other thread subscriptions can be
    // legitimate side conversations and must remain connected.
    stopRendererThreadSseControllers(event.sender.id, request.threadId)
    if (sseControllers.size >= RUNTIME_RESOURCE_LIMITS_V1.sseApplication) {
      logError('sse', 'Application SSE connection limit reached', {
        activeStreams: sseControllers.size,
        rendererId: event.sender.id,
        threadId: request.threadId
      })
      throw resourceLimitError('The application SSE connection limit has been reached.')
    }
    const rendererStreams = activeRendererStreams(event.sender.id)
    if (rendererStreams >= RUNTIME_RESOURCE_LIMITS_V1.ssePerRenderer) {
      logError('sse', 'Window SSE connection limit reached', {
        activeStreams: rendererStreams,
        rendererId: event.sender.id,
        threadId: request.threadId
      })
      throw resourceLimitError('The window SSE connection limit has been reached.')
    }
    const ac = new AbortController()
    const stateRef: { current?: SseControllerState } = {}
    const cancellation = appCancellationRegistry.register(
      { scope: 'subtask', id: `sse:${id}` },
      {
        parent: { scope: 'window', id: String(event.sender.id) },
        cleanup: (reason) => {
          const current = stateRef.current
          if (current && sseControllers.get(id) === current) {
            current.stoppedByClient = true
            sseControllers.delete(id)
          }
          ac.abort(reason)
        }
      }
    )
    const state: SseControllerState = {
      controller: ac,
      stoppedByClient: false,
      rendererId: event.sender.id,
      threadId: request.threadId,
      releaseCancellation: cancellation.release
    }
    stateRef.current = state
    sseControllers.set(id, state)
    const base = getRuntimeBaseUrlForSettings(s)

    ;(async () => {
      const wc = event.sender
      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      runtimeAuthHeaders(s).forEach((value, key) => {
        headers[key] = value
      })
      let nextSinceSeq = request.sinceSeq
      let reconnectDelayMs = SSE_RECONNECT_BASE_MS
      try {
        while (!state.stoppedByClient && !ac.signal.aborted) {
          const url = new URL(`${base}${request.scope === 'tasks' ? '/v1/tasks/stream' : runtimeThreadEventsPath(request.threadId)}`)
          url.searchParams.set('since_seq', String(nextSinceSeq))
          if (request.scope === 'tasks') headers['Last-Event-ID'] = String(nextSinceSeq)
          const requestHeaders = { ...headers }
          if (nextSinceSeq > 0) {
            requestHeaders['Last-Event-ID'] = String(nextSinceSeq)
          } else {
            delete requestHeaders['Last-Event-ID']
          }
          try {
            const res = await fetchSseWithStartTimeout(url, requestHeaders, ac.signal, SSE_START_TIMEOUT_MS)
            if (!res.ok || !res.body) {
              if (isFatalSseStatus(res.status)) {
                wc.send('runtime:sse-error', { streamId: id, status: res.status })
                logError('sse', `SSE connection failed for thread ${request.threadId}`, {
                  status: res.status,
                  streamId: id
                })
                return
              }
              await sleepWithAbort(reconnectDelayMs, ac.signal)
              reconnectDelayMs = Math.min(reconnectDelayMs * 2, SSE_RECONNECT_MAX_MS)
              continue
            }
            reconnectDelayMs = SSE_RECONNECT_BASE_MS
            const reader = res.body.getReader()
            const dec = new TextDecoder()
            let buffer = ''
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buffer += dec.decode(value, { stream: true })
              // Batch every event parsed from this network chunk into one IPC
              // message — streaming turns otherwise pay a structured-clone
              // send per token delta.
              const batch: Record<string, unknown>[] = []
              let batchBytes = 0
              let next: { block: string; rest: string } | null
              while ((next = takeSseBlock(buffer)) !== null) {
                const block = next.block
                buffer = next.rest
                const blockBytes = byteLength(block)
                if (blockBytes > RUNTIME_RESOURCE_LIMITS_V1.sseEventBytes) {
                  throw resourceLimitError('An SSE event exceeded its hard limit.')
                }
                const parsed = parseSseData(block)
                if (parsed !== null) {
                  const payload = coerceSsePayload(parsed)
                  if (typeof payload.seq === 'number') {
                    nextSinceSeq = Math.max(nextSinceSeq, payload.seq)
                  }
                  if (
                    (payload.kind === 'turn_completed' || payload.kind === 'turn_failed' || payload.kind === 'turn_aborted') &&
                    typeof payload.turnId === 'string'
                  ) {
                    appCancellationRegistry.release({ scope: 'turn', id: payload.turnId })
                    appCancellationRegistry.release({ scope: 'thread', id: request.threadId })
                  }
                  const payloadBytes = byteLength(JSON.stringify(payload))
                  if (payloadBytes > RUNTIME_RESOURCE_LIMITS_V1.sseEventBytes) {
                    throw resourceLimitError('An SSE event exceeded its hard limit.')
                  }
                  if (
                    batch.length >= RUNTIME_RESOURCE_LIMITS_V1.sseBatchEvents ||
                    batchBytes + payloadBytes > RUNTIME_RESOURCE_LIMITS_V1.sseBatchBytes
                  ) {
                    if (batch.length > 0) {
                      if (!wc.isDestroyed()) {
                        wc.send('runtime:sse-event', { streamId: id, events: batch.splice(0) })
                      } else {
                        batch.splice(0)
                      }
                      batchBytes = 0
                    }
                  }
                  batch.push(payload)
                  batchBytes += payloadBytes
                }
              }
              if (byteLength(buffer) > RUNTIME_RESOURCE_LIMITS_V1.sseBufferBytes) {
                throw resourceLimitError('The SSE receive buffer exceeded its hard limit.')
              }
              if (batch.length > 0) {
                if (!wc.isDestroyed()) wc.send('runtime:sse-event', { streamId: id, events: batch })
              }
            }
            buffer += dec.decode()
            const trailing = buffer.trim()
            if (trailing) {
              if (byteLength(trailing) > RUNTIME_RESOURCE_LIMITS_V1.sseEventBytes) {
                throw resourceLimitError('An SSE event exceeded its hard limit.')
              }
              const parsed = parseSseData(trailing)
              if (parsed !== null) {
                const payload = coerceSsePayload(parsed)
                if (byteLength(JSON.stringify(payload)) > RUNTIME_RESOURCE_LIMITS_V1.sseEventBytes) {
                  throw resourceLimitError('An SSE event exceeded its hard limit.')
                }
                if (typeof payload.seq === 'number') {
                  nextSinceSeq = Math.max(nextSinceSeq, payload.seq)
                }
                if (!wc.isDestroyed()) wc.send('runtime:sse-event', { streamId: id, events: [payload] })
              }
            }
          } catch (e) {
            if (state.stoppedByClient || ac.signal.aborted) return
            const msg = e instanceof Error ? e.message : String(e)
            if (/sse start timeout/i.test(msg) || /fetch failed/i.test(msg) || /network/i.test(msg)) {
              await sleepWithAbort(reconnectDelayMs, ac.signal)
              reconnectDelayMs = Math.min(reconnectDelayMs * 2, SSE_RECONNECT_MAX_MS)
              continue
            }
            if (!wc.isDestroyed()) {
              wc.send('runtime:sse-error', {
                streamId: id,
                message: msg,
                code: (e as { code?: unknown })?.code === 'resource_limit' ? 'resource_limit' : undefined
              })
            }
            logError('sse', `SSE stream error for thread ${request.threadId}`, { message: msg, streamId: id })
            return
          }
        }
      } finally {
        if (!state.stoppedByClient && !ac.signal.aborted) {
          if (!wc.isDestroyed()) wc.send('runtime:sse-end', { streamId: id })
        }
        // An earlier stream with the same id must never delete its replacement.
        if (sseControllers.get(id) === state) sseControllers.delete(id)
        state.releaseCancellation()
      }
    })()

    return { streamId: id }
  })

  ipcMain.handle('runtime:sse:stop', async (_, streamId: unknown) => {
    const normalizedStreamId = streamIdSchema.parse(streamId)
    const stopped = stopSseController(normalizedStreamId)
    if (!stopped) rememberPreStoppedSse(normalizedStreamId)
    return stopped
  })
}
