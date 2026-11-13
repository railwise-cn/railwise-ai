import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskRunV1 } from '@shared/agent-workbench'
import { useTaskState } from '../store/task-live-store'

export function latestHtmlArtifact(tasks: TaskRunV1[], threadId: string | null): { taskId: string; artifactId: string; key: string } | null {
  if (!threadId) return null
  const candidates = tasks.filter(task => (task.originThreadId ?? task.threadId) === threadId).flatMap(task => task.artifacts
    .filter(artifact => artifact.validation === 'valid' && artifact.sha256 && /\.html?$/i.test(artifact.relativePath))
    .map(artifact => ({ taskId: task.id, artifactId: artifact.id, key: `${task.id}:${artifact.id}:${artifact.sha256}`, at: task.updatedAt })))
  candidates.sort((a, b) => b.at.localeCompare(a.at) || a.artifactId.localeCompare(b.artifactId))
  return candidates[0] ?? null
}

export function useTaskArtifactPreview(threadId: string | null, enabled: boolean) {
  const state = useTaskState(enabled)
  const candidate = useMemo(() => latestHtmlArtifact(state.tasks, threadId), [state.tasks, threadId])
  const [preview, setPreview] = useState<{ threadId: string | null; url: string } | null>(null)
  const [error, setError] = useState('')
  const opened = useRef(new Map<string, string>())
  const generation = useRef(0)
  useEffect(() => { generation.current++; setPreview(null); setError('') }, [threadId])
  const open = useCallback(async (request: { taskId: string; artifactId: string }): Promise<void> => {
    const current = ++generation.current
    const result = await window.workwise.previewTaskArtifact(request)
    if (current !== generation.current) return
    if (!result.ok) { setError(result.message); throw new Error(result.message) }
    setError('')
    setPreview({ threadId, url: result.url })
  }, [threadId])
  useEffect(() => {
    if (!enabled || !candidate || !threadId || opened.current.get(threadId) === candidate.key) return
    opened.current.set(threadId, candidate.key)
    void open(candidate).catch(() => undefined)
  }, [candidate?.key, enabled, threadId, open])
  useEffect(() => () => { generation.current++ }, [])
  const retry = useCallback(() => candidate ? open(candidate) : Promise.resolve(), [candidate, open])
  return { url: preview?.threadId === threadId ? preview.url : null, error, open, retry }
}
