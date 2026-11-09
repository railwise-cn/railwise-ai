import type { TaskRunV1 } from './agent-workbench'

/** Old attempts stay inspectable; only the latest retry branch drives current status. */
export function currentTaskBranch<T extends Pick<TaskRunV1, 'id' | 'rootTaskId' | 'parentTaskId' | 'retryOfTaskId' | 'createdAt'>>(tasks: T[], root: T): { current: T; members: T[] } {
  const candidates = tasks.filter(task => !task.parentTaskId || Boolean(task.retryOfTaskId))
  const superseded = new Set(candidates.flatMap(task => task.retryOfTaskId ? [task.retryOfTaskId] : []))
  const current = candidates.filter(task => !superseded.has(task.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0] ?? root
  const included = new Set([current.id])
  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks) {
      if (task.parentTaskId && included.has(task.parentTaskId) && !included.has(task.id)) { included.add(task.id); changed = true }
    }
  }
  return { current, members: tasks.filter(task => included.has(task.id)) }
}
