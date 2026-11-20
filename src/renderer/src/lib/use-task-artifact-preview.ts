import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskRunV1 } from '@shared/agent-workbench'
import { taskArtifactSourceEvidenceState } from '@shared/task-artifact-source-evidence'
import { currentTaskBranch } from '@shared/task-projection'
import { taskGroupForTask } from '@shared/task-workspace-projection'
import { useTaskState } from '../store/task-live-store'

const FOREGROUND_PREVIEW_EVENT = 'railwise:foreground-task-artifact-preview'

/** UI intent only: a real user command started a Turn, or explicitly opened an artifact. */
export function foregroundTaskArtifactPreview(threadId: string, taskId: string): void {
  if (!threadId || !taskId || typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(new CustomEvent(FOREGROUND_PREVIEW_EVENT, { detail: { threadId, taskId } }))
}

export function listenToForegroundTask(listener: (selection: { threadId: string; taskId: string }) => void): () => void {
  const handle = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail
    if (!detail || typeof detail !== 'object' || !('threadId' in detail) || !('taskId' in detail)
      || typeof detail.threadId !== 'string' || !detail.threadId || typeof detail.taskId !== 'string' || !detail.taskId) return
    listener({ threadId: detail.threadId, taskId: detail.taskId })
  }
  window.addEventListener(FOREGROUND_PREVIEW_EVENT, handle)
  return () => window.removeEventListener(FOREGROUND_PREVIEW_EVENT, handle)
}

function belongsToConversation(task: TaskRunV1, threadId: string | null): boolean {
  return task.threadId === threadId || (task.originThreadId ?? task.threadId) === threadId
}

function isScheduledTask(task: TaskRunV1): boolean {
  // Runtime page/SSE preserve this server field; legacy renderer readers did not declare it.
  return 'scheduledBy' in task && task.scheduledBy != null
}

function previewVersion(task: TaskRunV1, artifactId: string): string {
  const primary = task.artifacts.find(artifact => artifact.id === artifactId)
  const files = task.artifacts
    .filter(artifact => artifact.validation === 'valid' && artifact.sha256 &&
      (!primary?.authorizedRoot || artifact.authorizedRoot === primary.authorizedRoot))
    .map(artifact => [artifact.id, artifact.relativePath, artifact.sha256, artifact.authorizedRoot ?? ''])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify([task.id, artifactId, files])
}

export function latestHtmlArtifact(tasks: TaskRunV1[], threadId: string | null, taskId?: string | null): { taskId: string; artifactId: string; key: string } | null {
  if (!threadId && !taskId) return null
  const candidates = tasks.filter(task => taskId ? task.id === taskId : belongsToConversation(task, threadId)).flatMap(task => task.artifacts
    .filter(artifact => artifact.validation === 'valid' && artifact.sha256 && /\.html?$/i.test(artifact.relativePath))
    .map(artifact => ({ taskId: task.id, artifactId: artifact.id, key: previewVersion(task, artifact.id), at: task.updatedAt })))
  candidates.sort((a, b) => b.at.localeCompare(a.at) || a.artifactId.localeCompare(b.artifactId))
  return candidates[0] ?? null
}

export function useTaskArtifactPreview(threadId: string | null, enabled: boolean, { followSelectedTask = false }: { followSelectedTask?: boolean } = {}) {
  const state = useTaskState(enabled)
  const tasksRef = useRef(state.tasks)
  tasksRef.current = state.tasks
  const opened = useRef<string | null>(null)
  const lastRequest = useRef<{ taskId: string; artifactId: string } | null>(null)
  const generation = useRef(0)
  const foregroundTasksRef = useRef<Record<string, string>>({})
  const [foregroundTasks, setForegroundTasks] = useState<Record<string, string>>({})
  useEffect(() => listenToForegroundTask(({ threadId: foregroundThreadId, taskId }) => {
    if (!followSelectedTask && foregroundThreadId === threadId && lastRequest.current?.taskId !== taskId) {
      // Keep the visible page, but a late response for the old foreground must not replace it.
      generation.current++
      opened.current = null
      lastRequest.current = null
    }
    if (foregroundTasksRef.current[foregroundThreadId] === taskId) return
    foregroundTasksRef.current = { ...foregroundTasksRef.current, [foregroundThreadId]: taskId }
    setForegroundTasks(foregroundTasksRef.current)
  }), [threadId, followSelectedTask])
  const selectedTaskId = followSelectedTask ? state.navigation.selectedTaskId : null
  const currentTaskId = useMemo(() => {
    const group = taskGroupForTask(selectedTaskId, state.tasks)
    return group ? currentTaskBranch(group.all, group.root).current.id : null
  }, [selectedTaskId, state.tasks])
  const scopeKey = followSelectedTask ? currentTaskId ? `task-workspace-preview:${currentTaskId}` : null : threadId
  const foregroundTaskId = threadId ? foregroundTasks[threadId] : undefined
  const candidate = useMemo(() => {
    if (followSelectedTask) return latestHtmlArtifact(state.tasks, null, currentTaskId)
    const conversationTasks = state.tasks.filter(task => belongsToConversation(task, threadId))
    if (foregroundTaskId) return latestHtmlArtifact(conversationTasks, threadId, foregroundTaskId)
    return latestHtmlArtifact(conversationTasks.filter(task => !isScheduledTask(task) || task.threadId === threadId), threadId)
  }, [state.tasks, threadId, currentTaskId, followSelectedTask, foregroundTaskId])
  const [preview, setPreview] = useState<{ scopeKey: string | null; url: string; key: string; taskId: string; artifactId: string;
    sha256?: string; sourceEvidenceStatus: 'draft' | 'verified' | null } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { generation.current++; opened.current = null; lastRequest.current = null; setPreview(null); setError('') }, [scopeKey])
  const load = useCallback(async (request: { taskId: string; artifactId: string }): Promise<void> => {
    const current = ++generation.current
    lastRequest.current = request
    const task = state.tasks.find(task => task.id === request.taskId)
    const artifact = task?.artifacts.find(artifact => artifact.id === request.artifactId)
    const key = task ? previewVersion(task, request.artifactId) : JSON.stringify([request.taskId, request.artifactId])
    try {
      const result = await window.workwise.previewTaskArtifact({ taskId: request.taskId, artifactId: request.artifactId })
      if (current !== generation.current) return
      if (!result.ok) throw new Error(result.message)
      setError('')
      const sha256 = typeof result.sha256 === 'string' && result.sha256 ? result.sha256 : undefined
      const actualTask = tasksRef.current.find(task => task.id === request.taskId)
      const actualArtifact = sha256 && actualTask?.artifacts.find(artifact => artifact.id === request.artifactId && artifact.sha256 === sha256)
      const hasWebSourceRequirement = task && artifact && taskArtifactSourceEvidenceState(task, artifact) !== null
      setPreview({ scopeKey, url: result.url, key, ...request, sha256,
        sourceEvidenceStatus: actualTask && actualArtifact ? taskArtifactSourceEvidenceState(actualTask, actualArtifact) : hasWebSourceRequirement ? 'draft' : null })
    } catch (cause) {
      if (current !== generation.current) return
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      throw new Error(message)
    }
  }, [state.tasks, scopeKey])
  useEffect(() => {
    if (!enabled || !candidate || !scopeKey || opened.current === candidate.key) return
    opened.current = candidate.key
    void load(candidate).catch(() => undefined)
  }, [candidate, enabled, scopeKey, load])
  useEffect(() => () => { generation.current++ }, [])
  const open = useCallback((request: { taskId: string; artifactId: string }): Promise<void> => {
    const task = tasksRef.current.find(item => item.id === request.taskId)
    if (task) {
      opened.current = previewVersion(task, request.artifactId)
    }
    const pending = load(request)
    if (task) foregroundTaskArtifactPreview(task.originThreadId ?? task.threadId, task.id)
    return pending
  }, [load])
  const retry = useCallback(() => lastRequest.current ? load(lastRequest.current) : candidate ? load(candidate) : Promise.resolve(), [candidate, load])
  const shown = preview?.scopeKey === scopeKey ? preview : null
  const shownTask = shown && state.tasks.find(task => task.id === shown.taskId)
  const currentArtifact = shown?.sha256 && shownTask?.artifacts.find(artifact => artifact.id === shown.artifactId && artifact.sha256 === shown.sha256)
  return { scopeKey, url: shown?.url ?? null, key: shown?.key ?? null,
    sourceEvidenceStatus: shownTask && currentArtifact ? taskArtifactSourceEvidenceState(shownTask, currentArtifact) : shown?.sourceEvidenceStatus ?? null,
    error, open, retry }
}
