import type { TaskRunRepository } from '../../services/task-run-repository.js'

const HEARTBEAT_MS = 15_000

function frame(event: { sequence: number; kind: string; payload: Record<string, unknown>; taskId: string; createdAt: string }): Uint8Array {
  const data = JSON.stringify({
    taskId: event.taskId,
    sequence: event.sequence,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt
  })
  return new TextEncoder().encode(`id: ${event.sequence}\nevent: ${event.kind}\ndata: ${data}\n\n`)
}

/** Durable task event stream with Last-Event-ID replay. */
export function buildTaskEventStreamResponse(input: {
  request: Request
  taskId: string
  repository: TaskRunRepository
}): Response {
  const url = new URL(input.request.url)
  const querySeq = Number(url.searchParams.get('since_seq') ?? '0') || 0
  const headerSeq = Number(input.request.headers.get('Last-Event-ID') ?? '0') || 0
  let lastSequence = Math.max(querySeq, headerSeq)
  let closed = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        if (pollTimer) clearInterval(pollTimer)
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        try { controller.close() } catch { /* client already closed */ }
      }
      input.request.signal.addEventListener('abort', close)
      const deliver = () => {
        if (closed) return
        try {
          const events = input.repository.events(input.taskId, lastSequence)
          for (const event of events) {
            if (event.sequence <= lastSequence) continue
            lastSequence = event.sequence
            controller.enqueue(frame(event))
          }
        } catch {
          close()
        }
      }
      deliver()
      pollTimer = setInterval(deliver, 750)
      heartbeatTimer = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`: heartbeat ${lastSequence}\n\n`))
        } catch { close() }
      }, HEARTBEAT_MS)
    },
    cancel() {
      closed = true
      if (pollTimer) clearInterval(pollTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
    }
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    }
  })
}
