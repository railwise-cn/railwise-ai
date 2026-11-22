import type { RuntimeRequestResult } from '@shared/workwise-api'

type Request = (path: string) => Promise<RuntimeRequestResult>
const MAX_LINKED_RECORDS = 12

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

async function readRecord(request: Request, kind: 'task' | 'thread', id: string): Promise<Record<string, unknown> | null> {
  const response = await request(`/v1/${kind}s/${encodeURIComponent(id)}`)
  if (!response.ok) return null
  try {
    const payload = record(JSON.parse(response.body))
    const entity = record(payload?.[kind]) ?? payload
    return entity?.id === id ? entity : null
  } catch {
    return null
  }
}

export async function findTaskOriginConversation(taskId: string, request: Request): Promise<string | null> {
  const visitedThreads = new Set<string>()
  const visitedTasks = new Set<string>()
  const pendingTasks = [taskId]
  const executionThreads: string[] = []

  async function findVisibleThread(firstThreadId: string): Promise<string | null> {
    let threadId: string | null = firstThreadId
    while (threadId && !visitedThreads.has(threadId) && visitedThreads.size < MAX_LINKED_RECORDS) {
      visitedThreads.add(threadId)
      const thread = await readRecord(request, 'thread', threadId)
      if (!thread) return null
      const parentId = identifier(thread.parentThreadId)
      const relation = thread.relation
      const isExecutionThread = threadId.startsWith('thr_task_')
      if (!isExecutionThread && (relation === 'primary' || relation === 'fork' || (relation == null && !parentId))) {
        return threadId
      }
      threadId = isExecutionThread || relation === 'side' || relation == null ? parentId : null
    }
    return null
  }

  while (pendingTasks.length && visitedTasks.size < MAX_LINKED_RECORDS) {
    const id = pendingTasks.shift()!
    if (visitedTasks.has(id)) continue
    visitedTasks.add(id)
    const task = await readRecord(request, 'task', id)
    if (!task) continue
    const explicitOrigin = identifier(task.originThreadId)
    if (explicitOrigin) {
      const threadId = await findVisibleThread(explicitOrigin)
      if (threadId) return threadId
    }
    const executionId = identifier(task.threadId)
    if (executionId) executionThreads.push(executionId)
    for (const link of [task.rootTaskId, task.parentTaskId, task.retryOfTaskId]) {
      const relatedId = identifier(link)
      if (relatedId) pendingTasks.push(relatedId)
    }
  }

  // Older records were stored on the chat or referenced it through a side thread.
  for (const executionId of executionThreads) {
    const threadId = await findVisibleThread(executionId)
    if (threadId) return threadId
  }
  return null
}
