// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskRunV1 } from '@shared/agent-workbench'
import { foregroundTaskArtifactPreview, useTaskArtifactPreview } from '../lib/use-task-artifact-preview'
import { useWorkbenchLayout } from './workbench-layout'
import { DevBrowserPanel } from './DevBrowserPanel'
import i18n from '../i18n'

let tasks: TaskRunV1[] = []
vi.mock('../store/task-live-store', () => ({ useTaskState: () => ({ tasks }) }))
let root: Root | undefined
let container: HTMLDivElement | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Chrome/132 Electron/34.2.0')
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
  tasks = []
  localStorage.clear()
  Reflect.deleteProperty(window, 'workwise')
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function task(id: string, originThreadId?: string): TaskRunV1 {
  return { id, threadId: `worker-${id}`, ...(originThreadId ? { originThreadId } : {}),
    createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z', artifacts: [{ id: 'html', relativePath: '报告.html',
      sha256: 'html-v1', validation: 'valid', createdAt: 'now' }] } as TaskRunV1
}

async function mount(activeThreadId: string | null = 'chat-a') {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  function Probe({ threadId }: { threadId: string | null }) {
    const preview = useTaskArtifactPreview(threadId, true)
    const currentThread = useRef(threadId)
    currentThread.current = threadId
    const layout = useWorkbenchLayout({ activeThreadId: threadId,
      latestAutoOpenDevPreviewKey: preview.key, latestAutoOpenDevPreviewUrl: preview.url,
      latestDevPreviewUrl: preview.url, route: 'chat', workspaceRoot: '', writeAssistantOpen: false })
    const openArtifact = async (request: { taskId: string; artifactId: string }) => {
      try {
        await preview.open(request)
        if (currentThread.current === threadId) layout.setRightPanelMode('browser')
      } catch { /* The conversation renders the hook's error and retry action. */ }
    }
    return createElement('div', { className: 'flex min-h-0 min-w-0 flex-1' },
      createElement('section', { 'aria-label': '聊天' },
        preview.error ? createElement('div', { role: 'status' }, preview.error,
          createElement('button', { onClick: () => { void preview.retry().catch(() => undefined) } }, '重新打开网页成果')) : null,
        ...tasks.filter(item => item.originThreadId === threadId || item.threadId === threadId)
          .map(item => createElement('button', { key: item.id,
            onClick: () => void openArtifact({ taskId: item.id, artifactId: 'html' }) }, `打开${item.id}`))),
      layout.rightPanelVisible && layout.rightPanelMode === 'browser'
        ? createElement(DevBrowserPanel, { blocks: [], preferredUrl: preview.url, onCollapse: layout.closeDevPreview })
        : null)
  }
  const render = async (threadId = activeThreadId) => { await act(async () => root!.render(createElement(Probe, { threadId }))) }
  const click = async (label: string) => {
    const button = [...container!.querySelectorAll('button')].find(item => item.textContent === label)!
    expect(button).toBeTruthy()
    await act(async () => button.click())
  }
  const close = async () => {
    const button = container!.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('rightPanelCollapse')}"]`)!
    expect(button).toBeTruthy()
    await act(async () => button.click())
  }
  const browser = () => container!.querySelector<HTMLElement>('webview')
  return { render, click, close, browser }
}

it('mounts task result previews through the chat composer and preserves the shared inspector', async () => {
  const source = await readFile(resolve('src/renderer/src/components/Workbench.tsx'), 'utf8')
  expect(source.match(/\{renderRightPanel\(\)\}/g)).toHaveLength(1)
  expect(source.indexOf('{renderRightPanel()}')).toBeGreaterThan(source.indexOf('</main>'))
  expect(source).toContain('await taskArtifactPreview.open(request)')
  expect(source).toContain('onOpenArtifact={(task, artifact) => openWorkspaceArtifact')
  expect(source).toContain('taskArtifactPreview.retry()')
  expect(source).not.toContain('TaskWorkspaceView')
  expect(source).toContain("useTaskArtifactPreview(activeThreadId, runtimeConnection === 'ready')")
})

it.each(['root', 'child'] as const)('opens and reopens a %s task artifact in the original chat', async kind => {
  const selected = task('selected', 'chat-b')
  if (kind === 'child') selected.parentTaskId = 'parent'
  tasks = [task('conversation', 'chat-a'), selected]
  const previewTaskArtifact = vi.fn(async ({ taskId }: { taskId: string }) => ({ ok: true, title: '报告',
    url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/${taskId}.html` }))
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount('chat-b')
  await view.render()
  expect(view.browser()?.getAttribute('src')).toContain('/selected.html')
  expect(view.browser()?.getAttribute('webpreferences')).toBe('contextIsolation=yes,nodeIntegration=no,sandbox=yes')
  expect(view.browser()?.getAttribute('partition')).toBe(`railwise-artifact-${'a'.repeat(48)}`)
  await view.close()
  expect(view.browser()).toBeNull()
  await view.click('打开selected')
  expect(view.browser()?.getAttribute('src')).toContain('/selected.html')
  expect(previewTaskArtifact.mock.calls.filter(([request]) => request.taskId === selected.id)).toHaveLength(2)
  await view.render('chat-a')
  expect(view.browser()?.getAttribute('src')).toContain('/conversation.html')
})

it('keeps the current chat report when a same-origin scheduled child publishes in the background', async () => {
  const initial = { ...task('initial', 'chat-a'), status: 'completed' } as TaskRunV1
  tasks = [initial]
  const previewTaskArtifact = vi.fn(async ({ taskId }: { taskId: string }) => ({ ok: true, title: '报告',
    sha256: 'html-v1', url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/${taskId}.html` }))
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount('chat-a')
  await view.render()
  expect(view.browser()?.getAttribute('src')).toContain('/initial.html')
  const due = Object.assign(task('due', 'chat-a'), { parentTaskId: initial.id, status: 'running',
    updatedAt: '2026-11-13T19:00:00Z', scheduledBy: { scheduleId: 'daily', dueAt: '2026-11-13T19:00:00Z' } })
  tasks = [initial, due]
  await view.render()
  expect(view.browser()?.getAttribute('src')).toContain('/initial.html')
  expect(previewTaskArtifact.mock.calls.map(([request]) => request.taskId)).toEqual(['initial'])
  tasks = [initial, { ...due, status: 'completed', updatedAt: '2026-11-13T19:05:00Z' } as TaskRunV1]
  await view.render()
  expect(view.browser()?.getAttribute('src')).toContain('/initial.html')
  expect(previewTaskArtifact).toHaveBeenCalledOnce()
})

it.each(['new task', 'continued scheduled task'])('follows a user-started %s while preserving the visible page until its first HTML and ignoring late parallel files', async kind => {
  const initial = task('initial', 'chat-a')
  const foreground = { ...task('foreground', 'chat-a'), artifacts: [] } as TaskRunV1
  if (kind === 'continued scheduled task') Object.assign(foreground, { scheduledBy: { scheduleId: 'daily', dueAt: '2026-11-13T19:00:00Z' } })
  tasks = [initial, foreground]
  const previewTaskArtifact = vi.fn(async ({ taskId, artifactId }: { taskId: string; artifactId: string }) => {
    const artifact = tasks.find(item => item.id === taskId)!.artifacts.find(item => item.id === artifactId)!
    return { ok: true, title: '报告', sha256: artifact.sha256,
      url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/${taskId}-${artifact.sha256}.html` }
  })
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount('chat-a')
  await view.render()
  expect(view.browser()?.getAttribute('src')).toContain('/initial-html-v1.html')
  await act(async () => foregroundTaskArtifactPreview('chat-a', foreground.id))
  tasks = [{ ...initial, updatedAt: '2029-01-01T00:00:00Z', artifacts: [{ ...initial.artifacts[0]!, sha256: 'late-parallel' }] }, foreground]
  await view.render()
  expect(view.browser()?.getAttribute('src')).toContain('/initial-html-v1.html')
  expect(previewTaskArtifact).toHaveBeenCalledOnce()
  tasks = [tasks[0]!, { ...foreground, artifacts: task('foreground').artifacts }]
  await view.render()
  expect(view.browser()?.getAttribute('src')).toContain('/foreground-html-v1.html')
  expect(previewTaskArtifact.mock.calls.map(([request]) => request.taskId)).toEqual(['initial', 'foreground'])
  await view.close()
  await view.render()
  expect(view.browser()).toBeNull()
  tasks = tasks.map(item => item.id === foreground.id ? { ...item, artifacts: [{ ...item.artifacts[0]!, sha256: 'html-v2' }] } : item)
  await view.render()
  expect(view.browser()?.getAttribute('src')).toContain('/foreground-html-v2.html')
  expect(previewTaskArtifact).toHaveBeenCalledTimes(3)
})

it('opens an explicitly selected scheduled task artifact from its chat', async () => {
  const due = Object.assign(task('due', 'chat-a'), { scheduledBy: { scheduleId: 'daily', dueAt: '2026-11-13T19:00:00Z' } })
  tasks = [task('initial', 'chat-a'), due]
  const previewTaskArtifact = vi.fn(async ({ taskId }: { taskId: string }) => ({ ok: true, title: '报告',
    url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/${taskId}.html` }))
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount('chat-a')
  await view.render()
  expect(view.browser()?.getAttribute('src')).toContain('/initial.html')
  await view.click('打开due')
  expect(view.browser()?.getAttribute('src')).toContain('/due.html')
  await view.close()
  expect(view.browser()).toBeNull()
  await view.click('打开due')
  expect(view.browser()?.getAttribute('src')).toContain('/due.html')
  expect(previewTaskArtifact.mock.calls.map(([input]) => input.taskId)).toEqual(['initial', 'due', 'due'])
})

it('discards a late task preview when the user switches chats', async () => {
  tasks = [task('one', 'chat-b'), task('two', 'chat-c')]
  let finish!: (value: unknown) => void
  const previewTaskArtifact = vi.fn(({ taskId }: { taskId: string }) => taskId === 'one'
    ? new Promise(resolve => { finish = resolve })
    : Promise.resolve({ ok: true, title: '报告', sha256: 'html-v1', url: `http://127.0.0.1:1234/task-preview/${'b'.repeat(48)}/two.html` }))
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount('chat-b')
  await view.render()
  expect(previewTaskArtifact).toHaveBeenCalledWith({ taskId: 'one', artifactId: 'html' })
  await view.render('chat-c')
  expect(view.browser()?.getAttribute('src')).toContain('/two.html')
  await act(async () => finish({ ok: true, title: '旧报告', sha256: 'html-v1', url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/one.html` }))
  expect(view.browser()?.getAttribute('src')).toContain('/two.html')
  expect(previewTaskArtifact).toHaveBeenCalledTimes(2)
})

it.each(['business', 'transport'])('shows a %s preview error and retries the exact artifact in its chat', async failure => {
  tasks = [task('report', 'chat-a')]
  const message = failure === 'business' ? '成果版本已变化，请重新打开。' : '预览服务暂时不可用。'
  const previewTaskArtifact = vi.fn()
  if (failure === 'business') previewTaskArtifact.mockResolvedValueOnce({ ok: false, message })
  else previewTaskArtifact.mockRejectedValueOnce(new Error(message))
  previewTaskArtifact.mockResolvedValueOnce({ ok: true, title: '报告',
    url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/report.html` })
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount()
  await view.render()
  expect(container!.querySelector('[role="status"]')?.textContent).toContain(message)
  expect(view.browser()).toBeNull()
  await view.click('重新打开网页成果')
  expect(container!.querySelector('button')?.textContent).not.toContain('重新打开网页成果')
  expect(view.browser()?.getAttribute('src')).toContain('/report.html')
  expect(previewTaskArtifact.mock.calls).toEqual([
    [{ taskId: 'report', artifactId: 'html' }], [{ taskId: 'report', artifactId: 'html' }]
  ])
})
