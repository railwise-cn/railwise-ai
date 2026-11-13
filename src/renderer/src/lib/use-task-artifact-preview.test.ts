// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TaskRunV1 } from '@shared/agent-workbench'
import { latestHtmlArtifact, useTaskArtifactPreview } from './use-task-artifact-preview'

let tasks: TaskRunV1[] = []
vi.mock('../store/task-live-store', () => ({ useTaskState: () => ({ tasks }) }))
let mounted: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => { await act(async () => mounted?.unmount()); mounted = undefined; container?.remove(); tasks = []; Reflect.deleteProperty(window, 'workwise') })
async function mountPreview(thread: string) {
  container = document.createElement('div')
  document.body.append(container)
  mounted = createRoot(container)
  let value: ReturnType<typeof useTaskArtifactPreview>
  function Probe({ threadId }: { threadId: string }) { value = useTaskArtifactPreview(threadId, true); return null }
  async function render(threadId = thread) { await act(async () => mounted!.render(createElement(Probe, { threadId }))) }
  await render()
  return { current: () => value!, render }
}
function task(id: string, origin = 'chat', hash = 'hash'): TaskRunV1 {
  return { id, threadId: `internal-${id}`, originThreadId: origin, updatedAt: '2026-11-13T00:00:00Z', artifacts: [{ id: 'html', relativePath: '报告.html', sha256: hash, validation: 'valid', createdAt: 'now' }] } as TaskRunV1
}

describe('task-owned HTML auto preview', () => {
  it('selects only verified HTML belonging to the current origin conversation', () => {
    expect(latestHtmlArtifact([task('one'), task('other', 'other')], 'chat')?.taskId).toBe('one')
    expect(latestHtmlArtifact([task('other', 'other')], 'chat')).toBeNull()
    const invalid = task('bad'); invalid.artifacts[0]!.validation = 'invalid'
    expect(latestHtmlArtifact([invalid], 'chat')).toBeNull()
  })
  it('deduplicates event replay and opens a changed artifact once', async () => {
    tasks = [task('one')]
    const preview = vi.fn(async () => ({ ok: true, url: 'http://127.0.0.1:1/one', title: '报告' }))
    Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact: preview } })
    const hook = await mountPreview('chat')
    expect(hook.current().url).toBe('http://127.0.0.1:1/one')
    tasks = [task('one')]; await hook.render()
    expect(preview).toHaveBeenCalledTimes(1)
    tasks = [task('one', 'chat', 'changed')]; await hook.render()
    expect(preview).toHaveBeenCalledTimes(2)
  })
  it('discards a late preview response after switching conversations', async () => {
    tasks = [task('one')]
    let finish!: (value: unknown) => void
    Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact: vi.fn(() => new Promise(resolve => { finish = resolve })) } })
    const hook = await mountPreview('chat')
    await hook.render('other')
    await act(async () => finish({ ok: true, url: 'http://127.0.0.1:1/old', title: 'old' }))
    expect(hook.current().url).toBeNull()
  })
})
