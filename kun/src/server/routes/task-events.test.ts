import { describe, expect, it } from 'vitest'
import { buildTaskEventStreamResponse } from './task-events.js'

describe('task event stream', () => {
  it('replays events after Last-Event-ID without duplicating older events', async () => {
    const repository = {
      events: (_taskId: string, afterSequence: number) => [
        { taskId: 'task-1', sequence: 1, eventKey: 'one', kind: 'task_created', payload: {}, createdAt: '2026-11-09T00:00:00.000Z' },
        { taskId: 'task-1', sequence: 2, eventKey: 'two', kind: 'task_updated', payload: { status: 'running' }, createdAt: '2026-11-09T00:00:01.000Z' }
      ].filter(event => event.sequence > afterSequence)
    } as never
    const abort = new AbortController()
    const response = buildTaskEventStreamResponse({
      request: new Request('http://localhost/v1/tasks/task-1/stream', { headers: { 'Last-Event-ID': '1' }, signal: abort.signal }),
      taskId: 'task-1',
      repository
    })
    const reader = response.body!.getReader()
    const first = await reader.read()
    const text = new TextDecoder().decode(first.value)
    expect(text).toContain('id: 2')
    expect(text).not.toContain('id: 1')
    abort.abort()
    await reader.cancel()
  })
})
