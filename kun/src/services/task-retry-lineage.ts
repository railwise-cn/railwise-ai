import type { TaskRun } from '../contracts/tasks.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const origin = (task: Pick<TaskRun, 'originThreadId' | 'threadId'>) => task.originThreadId ?? task.threadId

/** Read-only server proof of an explicit Retry family. A claimed root ID never grants authority. */
export function verifiedTaskRetryLineage(repository: TaskRunRepository, task: TaskRun): { root: TaskRun; tasks: TaskRun[] } | undefined {
  const tasks: TaskRun[] = [], seen = new Set<string>(), rootId = task.rootTaskId ?? task.id
  let current = task
  while (tasks.length < 32 && !seen.has(current.id)) {
    seen.add(current.id); tasks.push(current)
    if (!current.retryOfTaskId) return current.id === rootId ? { root: current, tasks } : undefined
    const source = repository.get(current.retryOfTaskId)
    if (!source || !['failed', 'cancelled'].includes(source.status) || (source.rootTaskId ?? source.id) !== rootId ||
      current.workspaceRoot !== source.workspaceRoot || origin(current) !== origin(source) || current.goal !== source.goal ||
      current.parentTaskId !== source.parentTaskId || operationFingerprint(current.scheduledBy) !== operationFingerprint(source.scheduledBy) ||
      operationFingerprint(current.acceptance) !== operationFingerprint(source.acceptance)) return undefined
    const event = repository.events(current.id).find(item => item.kind === 'task_retried' && item.payload?.retryOfTaskId === source.id && item.payload.rootTaskId === rootId)
    if (!event) return undefined
    const owners = [...new Set([source.id, rootId])]
    const control = owners.flatMap(owner => repository.operations(owner, 'retry')).find(receipt => {
      const result = object(receipt.result), child = object(result.task), request = object(receipt.request)
      return receipt.status === 'succeeded' && receipt.fingerprint === operationFingerprint(request) && Number.isInteger(request.expectedRevision) &&
        Number(request.expectedRevision) <= source.revision && child.id === current.id && child.retryOfTaskId === source.id && child.rootTaskId === rootId &&
        child.threadId === current.threadId && (child.originThreadId ?? child.threadId) === origin(current) && child.workspaceRoot === current.workspaceRoot &&
        child.goal === current.goal && operationFingerprint(child.acceptance) === operationFingerprint(current.acceptance) &&
        Date.parse(receipt.createdAt) <= Date.parse(event.createdAt) && Date.parse(receipt.updatedAt) >= Date.parse(event.createdAt)
    })
    if (!control) return undefined
    current = source
  }
  return undefined
}
