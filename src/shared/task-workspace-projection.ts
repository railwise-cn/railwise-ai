import type { TaskRunV1, TaskAttentionV1 } from './agent-workbench'
import { currentTaskBranch } from './task-projection'
import { taskDisplayGoal } from './task-presentation'

export type TaskFilter = 'ongoing' | 'attention' | 'completed' | 'all'
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const ATTENTION = new Set(['waiting_user', 'waiting_approval', 'stalled', 'failed'])

export function pausedTaskQuestionRequestIds(tasks: readonly TaskRunV1[], attention: readonly TaskAttentionV1[], threadId: string | null): Set<string> {
  if (!threadId) return new Set()
  const pausedTaskIds = new Set(tasks.filter(task => task.status === 'paused' &&
    (task.originThreadId ?? task.threadId) === threadId).map(task => task.id))
  return new Set(attention.flatMap(item => item.kind === 'question' && item.status === 'pending' && item.requestId &&
    item.taskId && pausedTaskIds.has(item.taskId) ? [item.requestId] : []))
}

export type TaskWorkspaceTaskGroup = {
  root: TaskRunV1
  children: TaskRunV1[]
  all: TaskRunV1[]
}

function rootIdForTask(task: TaskRunV1, byId: Map<string, TaskRunV1>): string {
  const declaredRoot = task.rootTaskId?.trim()
  if (declaredRoot && byId.has(declaredRoot)) return declaredRoot
  const seen = new Set<string>()
  let current = task
  while (current.parentTaskId && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = byId.get(current.parentTaskId)
    if (!parent) break
    current = parent
  }
  return current.id
}

export function groupWorkspaceTasks(tasks: TaskRunV1[]): TaskWorkspaceTaskGroup[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const groups = new Map<string, TaskRunV1[]>()
  for (const task of tasks) {
    const rootId = rootIdForTask(task, byId)
    const members = groups.get(rootId) ?? []
    members.push(task)
    groups.set(rootId, members)
  }
  return [...groups.entries()].map(([rootId, all]) => {
    const root = all.find(task => task.id === rootId) ?? all.find(task => !task.parentTaskId) ?? all[0]
    const group = { root, children: all.filter(task => task.id !== root.id), all }
    // Historical attempts stay inspectable without changing current navigation recency.
    const updatedAt = currentTaskBranch(all, root).members.reduce((latest, task) => task.updatedAt > latest ? task.updatedAt : latest, '')
    return { group, updatedAt }
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.group.root.id.localeCompare(b.group.root.id))
    .map(({ group }) => group)
}

export function taskGroupForTask(taskId: string | null, tasks: TaskRunV1[]): TaskWorkspaceTaskGroup | null {
  if (!taskId) return null
  return groupWorkspaceTasks(tasks).find(group => group.all.some(task => task.id === taskId)) ?? null
}

export function taskGroupProgress(group: TaskWorkspaceTaskGroup): { completed: number; total: number } {
  return {
    completed: currentTaskBranch(group.all, group.root).members.reduce((count, task) => count + task.nodes.filter(node => node.status === 'completed').length, 0),
    total: currentTaskBranch(group.all, group.root).members.reduce((count, task) => count + task.nodes.length, 0)
  }
}

export function taskGroupArtifacts(group: TaskWorkspaceTaskGroup): Array<{ task: TaskRunV1; artifact: TaskRunV1['artifacts'][number] }> {
  return group.all.flatMap(task => task.artifacts.map(artifact => ({ task, artifact })))
}

export function taskNeedsUser(task: TaskRunV1, inbox: TaskAttentionV1[], relatedTasks: TaskRunV1[] = []): boolean {
  const group = currentTaskBranch([task, ...relatedTasks], task).members
  return group.some(candidate => ATTENTION.has(candidate.status) || inbox.some(item => item.status === 'pending' && (item.taskId === candidate.id || item.threadId === candidate.threadId)))
}

export function filterWorkspaceTasks(tasks: TaskRunV1[], inbox: TaskAttentionV1[], filter: TaskFilter, search = ''): TaskRunV1[] {
  const query = search.trim().toLocaleLowerCase()
  return groupWorkspaceTasks(tasks).flatMap(group => {
    const task = group.root
    const current = currentTaskBranch(group.all, task).current
    const searchable = group.all.flatMap(item => [taskDisplayGoal(item), item.workspaceRoot, ...item.artifacts.map(artifact => artifact.relativePath)]).join('\n')
    if (query && !searchable.toLocaleLowerCase().includes(query)) return []
    if (filter === 'ongoing' && (TERMINAL.has(current.status) || taskNeedsUser(task, inbox, group.children))) return []
    if (filter === 'attention' && !taskNeedsUser(task, inbox, group.children)) return []
    if (filter === 'completed' && current.status !== 'completed') return []
    return [task]
  })
}

/** Root visibility and workspace membership are shared by navigation and detail. */
export function scopeWorkspaceTasks(all: TaskRunV1[], scope?: string): TaskRunV1[] {
  const roots = all.filter(task => !task.parentTaskId && (!task.rootTaskId || task.rootTaskId === task.id) && task.visible !== false && !['chat', 'internal'].includes(task.visibility ?? '') && (!scope || task.workspaceRoot === scope))
  const included = new Set(roots.map(task => task.id))
  let changed = true
  while (changed) { changed = false; for (const task of all) if (((task.rootTaskId && included.has(task.rootTaskId)) || (task.parentTaskId && included.has(task.parentTaskId))) && !included.has(task.id)) { included.add(task.id); changed = true } }
  return all.filter(task => included.has(task.id))
}
