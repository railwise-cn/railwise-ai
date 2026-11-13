import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskRunV1 } from '@shared/agent-workbench'
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

export function latestHtmlArtifact(tasks: TaskRunV1[], threadId: string | null): { taskId: string; artifactId: string; key: string } | null {
  if (!threadId) return null
  const candidates = tasks.filter(task => (task.originThreadId ?? task.threadId) === threadId).flatMap(task => task.artifacts
    .filter(artifact => artifact.validation === 'valid' && artifact.sha256 && /\.html?$/i.test(artifact.relativePath))
    .map(artifact => ({ taskId: task.id, artifactId: artifact.id, key: previewVersion(task, artifact.id), at: task.updatedAt })))
  candidates.sort((a, b) => b.at.localeCompare(a.at) || a.artifactId.localeCompare(b.artifactId))
  return candidates[0] ?? null
}

export function useTaskArtifactPreview(threadId: string | null, enabled: boolean) {
  const state = useTaskState(enabled)
  const candidate = useMemo(() => latestHtmlArtifact(state.tasks, threadId), [state.tasks, threadId])
  const [preview, setPreview] = useState<{ threadId: string | null; url: string; key: string } | null>(null)
  const [error, setError] = useState('')
  const opened = useRef<string | null>(null)
  const generation = useRef(0)
  useEffect(() => { generation.current++; opened.current = null; setPreview(null); setError('') }, [threadId])
  const open = useCallback(async (request: { taskId: string; artifactId: string }): Promise<void> => {
    const current = ++generation.current
    const task = state.tasks.find(task => task.id === request.taskId)
    const key = task ? previewVersion(task, request.artifactId) : JSON.stringify([request.taskId, request.artifactId])
    try {
      const result = await window.workwise.previewTaskArtifact({ taskId: request.taskId, artifactId: request.artifactId })
      if (current !== generation.current) return
      if (!result.ok) throw new Error(result.message)
      setError('')
      setPreview({ threadId, url: result.url, key })
    } catch (cause) {
      if (current !== generation.current) return
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      throw new Error(message)
    }
  }, [state.tasks, threadId])
  useEffect(() => {
    if (!enabled || !candidate || !threadId || opened.current === candidate.key) return
    opened.current = candidate.key
    void open(candidate).catch(() => undefined)
  }, [candidate, enabled, threadId, open])
  useEffect(() => () => { generation.current++ }, [])
  const retry = useCallback(() => candidate ? open(candidate) : Promise.resolve(), [candidate, open])
  return { url: preview?.threadId === threadId ? preview.url : null,
    key: preview?.threadId === threadId ? preview.key : null, error, open, retry }
}
