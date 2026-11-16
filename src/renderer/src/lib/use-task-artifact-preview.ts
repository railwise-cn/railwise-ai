import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskRunV1 } from '@shared/agent-workbench'
import { taskArtifactSourceEvidenceState } from '@shared/task-artifact-source-evidence'
import { currentTaskBranch } from '@shared/task-projection'
import { taskGroupForTask } from '@shared/task-workspace-projection'
import { useTaskState } from '../store/task-live-store'

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
  const candidates = tasks.filter(task => taskId ? task.id === taskId : (task.originThreadId ?? task.threadId) === threadId).flatMap(task => task.artifacts
    .filter(artifact => artifact.validation === 'valid' && artifact.sha256 && /\.html?$/i.test(artifact.relativePath))
    .map(artifact => ({ taskId: task.id, artifactId: artifact.id, key: previewVersion(task, artifact.id), at: task.updatedAt })))
  candidates.sort((a, b) => b.at.localeCompare(a.at) || a.artifactId.localeCompare(b.artifactId))
  return candidates[0] ?? null
}

export function useTaskArtifactPreview(threadId: string | null, enabled: boolean, { followSelectedTask = false }: { followSelectedTask?: boolean } = {}) {
  const state = useTaskState(enabled)
  const tasksRef = useRef(state.tasks)
  tasksRef.current = state.tasks
  const selectedTaskId = followSelectedTask ? state.navigation.selectedTaskId : null
  const currentTaskId = useMemo(() => {
    const group = taskGroupForTask(selectedTaskId, state.tasks)
    return group ? currentTaskBranch(group.all, group.root).current.id : null
  }, [selectedTaskId, state.tasks])
  const scopeKey = followSelectedTask ? currentTaskId ? `task-workspace-preview:${currentTaskId}` : null : threadId
  const candidate = useMemo(() => latestHtmlArtifact(state.tasks, threadId, currentTaskId), [state.tasks, threadId, currentTaskId])
  const [preview, setPreview] = useState<{ scopeKey: string | null; url: string; key: string; taskId: string; artifactId: string;
    sha256?: string; sourceEvidenceStatus: 'draft' | 'verified' | null } | null>(null)
  const [error, setError] = useState('')
  const opened = useRef<string | null>(null)
  const lastRequest = useRef<{ taskId: string; artifactId: string } | null>(null)
  const generation = useRef(0)
  useEffect(() => { generation.current++; opened.current = null; lastRequest.current = null; setPreview(null); setError('') }, [scopeKey])
  const open = useCallback(async (request: { taskId: string; artifactId: string }): Promise<void> => {
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
    void open(candidate).catch(() => undefined)
  }, [candidate, enabled, scopeKey, open])
  useEffect(() => () => { generation.current++ }, [])
  const retry = useCallback(() => lastRequest.current ? open(lastRequest.current) : candidate ? open(candidate) : Promise.resolve(), [candidate, open])
  const shown = preview?.scopeKey === scopeKey ? preview : null
  const shownTask = shown && state.tasks.find(task => task.id === shown.taskId)
  const currentArtifact = shown?.sha256 && shownTask?.artifacts.find(artifact => artifact.id === shown.artifactId && artifact.sha256 === shown.sha256)
  return { scopeKey, url: shown?.url ?? null, key: shown?.key ?? null,
    sourceEvidenceStatus: shownTask && currentArtifact ? taskArtifactSourceEvidenceState(shownTask, currentArtifact) : shown?.sourceEvidenceStatus ?? null,
    error, open, retry }
}
