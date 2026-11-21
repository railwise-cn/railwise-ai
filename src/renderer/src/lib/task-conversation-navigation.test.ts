import { describe, expect, it, vi } from 'vitest'
import { findTaskOriginConversation } from './task-conversation-navigation'

function runtime(records: Record<string, unknown>) {
  return vi.fn(async (path: string) => path in records
    ? { ok: true, status: 200, body: JSON.stringify(records[path]) }
    : { ok: false, status: 404, body: '{}' })
}

describe('findTaskOriginConversation', () => {
  it('focuses the original archived chat for a native task link', async () => {
    const request = runtime({
      '/v1/tasks/task': { id: 'task', threadId: 'thr_task_worker', originThreadId: 'archived' },
      '/v1/threads/archived': { id: 'archived', relation: 'primary', archived: true }
    })
    await expect(findTaskOriginConversation('task', request)).resolves.toBe('archived')
    expect(request.mock.calls).toEqual([['/v1/tasks/task'], ['/v1/threads/archived']])
  })

  it('follows an older child or retry link to its task group origin', async () => {
    const request = runtime({
      '/v1/tasks/child': { task: { id: 'child', threadId: 'worker', parentTaskId: 'retry' } },
      '/v1/tasks/retry': { id: 'retry', threadId: 'old-worker', retryOfTaskId: 'root' },
      '/v1/tasks/root': { id: 'root', originThreadId: 'fork' },
      '/v1/threads/fork': { thread: { id: 'fork', relation: 'fork', parentThreadId: 'first-chat' } }
    })
    await expect(findTaskOriginConversation('child', request)).resolves.toBe('fork')
    expect(request).not.toHaveBeenCalledWith('/v1/threads/worker')
  })

  it('uses a visible parent for a task that only records an execution thread', async () => {
    const request = runtime({
      '/v1/tasks/old%20task': { id: 'old task', threadId: 'thr_task_worker' },
      '/v1/threads/thr_task_worker': { id: 'thr_task_worker', relation: 'side', parentThreadId: 'chat' },
      '/v1/threads/chat': { id: 'chat' }
    })
    await expect(findTaskOriginConversation('old task', request)).resolves.toBe('chat')
  })

  it('rejects an orphaned execution and terminates malformed cyclic links', async () => {
    const request = runtime({
      '/v1/tasks/orphan': { id: 'orphan', threadId: 'thr_task_worker', rootTaskId: 'orphan', parentTaskId: 'other' },
      '/v1/tasks/other': { id: 'unexpected', threadId: 'unrelated-chat' },
      '/v1/threads/thr_task_worker': { id: 'thr_task_worker', relation: 'primary', parentThreadId: 'thr_task_worker' }
    })
    await expect(findTaskOriginConversation('orphan', request)).resolves.toBeNull()
    expect(request).toHaveBeenCalledTimes(3)
  })
})
