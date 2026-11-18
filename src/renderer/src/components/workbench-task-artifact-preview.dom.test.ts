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
let selectedTaskId: string | null = null
vi.mock('../store/task-live-store', () => ({ useTaskState: () => ({ tasks, navigation: { selectedTaskId } }) }))
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
  selectedTaskId = null
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
  function Probe({ route }: { route: 'chat' | 'tasks' }) {
    const conversation = useTaskArtifactPreview(activeThreadId, route !== 'tasks')
    const workspace = useTaskArtifactPreview(null, route === 'tasks', { followSelectedTask: true })
    const preview = route === 'tasks' ? workspace : conversation
    const routeRef = useRef(route)
    routeRef.current = route
    const layout = useWorkbenchLayout({ activeThreadId: route === 'tasks' ? workspace.scopeKey ?? 'task-workspace-preview' : activeThreadId,
      latestAutoOpenDevPreviewKey: preview.key, latestAutoOpenDevPreviewUrl: preview.url,
      latestDevPreviewUrl: preview.url, route, workspaceRoot: '', writeAssistantOpen: false })
    const openArtifact = async (request: { taskId: string; artifactId: string }) => {
      try {
        await workspace.open(request)
        if (routeRef.current === 'tasks') layout.setRightPanelMode('browser')
      } catch { /* The task workspace renders the hook's error and retry action. */ }
    }
    return createElement('div', { className: 'flex min-h-0 min-w-0 flex-1' },
      createElement('section', { 'aria-label': route === 'tasks' ? '任务工作台' : '聊天' },
        route === 'tasks' && workspace.error ? createElement('div', { role: 'alert' }, workspace.error,
          createElement('button', { onClick: () => { void workspace.retry().then(() => {
            if (routeRef.current === 'tasks') layout.setRightPanelMode('browser')
          }).catch(() => undefined) } }, '重新打开网页成果')) : null,
        ...tasks.map(item => createElement('button', { key: item.id,
          onClick: () => void openArtifact({ taskId: item.id, artifactId: 'html' }) }, `打开${item.id}`))),
      layout.rightPanelVisible && layout.rightPanelMode === 'browser'
        ? createElement(DevBrowserPanel, { blocks: [], preferredUrl: preview.url, onCollapse: layout.closeDevPreview })
        : null)
  }
  const render = async (route: 'chat' | 'tasks') => { await act(async () => root!.render(createElement(Probe, { route }))) }
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

it('mounts the task workspace beside its preview and keeps task URLs outside conversation detection', async () => {
  const source = await readFile(resolve('src/renderer/src/components/Workbench.tsx'), 'utf8')
  const taskRenderer = source.slice(source.indexOf('const workbenchViewRenderers'), source.indexOf('    plugins: (module)'))
  // A single inspector now belongs to the shared shell. Keeping it outside the
  // route renderer preserves the live page when switching dock/drawer layouts.
  expect(source.match(/\{renderRightPanel\(\)\}/g)).toHaveLength(1)
  expect(source.indexOf('{renderRightPanel()}')).toBeGreaterThan(source.indexOf('</main>'))
  expect(taskRenderer).toContain('await openWorkspaceArtifact({ taskId: task.id, artifactId })')
  expect(taskRenderer).toContain('workspaceArtifactPreview.error')
  expect(taskRenderer).toContain('workspaceArtifactPreview.retry()')
  expect(taskRenderer).not.toContain('selectThread(')
  expect(taskRenderer).not.toContain('await taskArtifactPreview.open(')
  expect(source).toContain("useTaskArtifactPreview(null, runtimeConnection === 'ready' && route === 'tasks', { followSelectedTask: true })")
  expect(source).toContain("useTaskArtifactPreview(activeThreadId, runtimeConnection === 'ready' && route !== 'tasks')")
  expect(source).toContain("activeThreadId: route === 'tasks' ? workspaceArtifactPreview.scopeKey ?? 'task-workspace-preview' : activeThreadId")
  expect(source).toContain("blocks={route === 'tasks' ? [] : devPreviewBlocks}")
})

it.each(['root', 'child', 'flow'] as const)('shows a selected %s task artifact and reopens the same hash after closing', async kind => {
  const selected = task('selected', kind === 'flow' ? undefined : 'chat-b')
  if (kind === 'child') selected.parentTaskId = 'parent'
  if (kind === 'flow') Object.assign(selected, { flowRunId: 'synthetic-flow-run' })
  tasks = [task('conversation', 'chat-a'), selected]
  const previewTaskArtifact = vi.fn(async ({ taskId }: { taskId: string }) => ({ ok: true, title: '报告',
    url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/${taskId}.html` }))
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount(kind === 'flow' ? null : 'chat-a')
  await view.render('tasks')
  expect(view.browser()).toBeNull()
  await view.click('打开selected')
  expect(view.browser()?.getAttribute('src')).toContain('/selected.html')
  expect(view.browser()?.getAttribute('webpreferences')).toBe('contextIsolation=yes,nodeIntegration=no,sandbox=yes')
  expect(view.browser()?.getAttribute('partition')).toBe(`railwise-artifact-${'a'.repeat(48)}`)
  await view.close()
  expect(view.browser()).toBeNull()
  await view.render('tasks')
  expect(view.browser()).toBeNull()
  await view.click('打开selected')
  expect(view.browser()?.getAttribute('src')).toContain('/selected.html')
  expect(previewTaskArtifact.mock.calls.filter(([request]) => request.taskId === selected.id)).toHaveLength(2)
  await view.render('chat')
  if (kind === 'flow') expect(view.browser()).toBeNull()
  else expect(view.browser()?.getAttribute('src')).toContain('/conversation.html')
})

it('keeps a dismissed chat preview closed after a separate task preview and ignores its late open completion', async () => {
  tasks = [task('conversation', 'chat-a'), task('selected', 'chat-b')]
  let completeTaskPreview!: (value: { ok: true; title: string; url: string }) => void
  const previewTaskArtifact = vi.fn(({ taskId }: { taskId: string }) => taskId === 'selected'
    ? new Promise(resolve => { completeTaskPreview = resolve })
    : Promise.resolve({ ok: true, title: '报告', url: `http://127.0.0.1:1234/task-preview/${'b'.repeat(48)}/conversation.html` }))
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount()
  await view.render('chat')
  expect(view.browser()?.getAttribute('src')).toContain('/conversation.html')
  await view.close()
  await view.render('tasks')
  await view.click('打开selected')
  await view.render('chat')
  await act(async () => completeTaskPreview({ ok: true, title: '报告', url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/selected.html` }))
  expect(view.browser()).toBeNull()
})

it('automatically previews the selected task new hash, ignores parallel tasks and preserves dismissal for the same version', async () => {
  const selected = task('selected', 'chat-b')
  selected.acceptance = { kind: 'files', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: true, requiresWebEvidence: true }
  selected.artifacts[0] = { ...selected.artifacts[0]!, sourceEvidenceStatus: 'draft' }
  selectedTaskId = selected.id
  tasks = [{ ...selected, artifacts: [] }, task('parallel', 'chat-b')]
  const previewTaskArtifact = vi.fn(async ({ taskId, artifactId }: { taskId: string; artifactId: string }) => {
    const artifact = tasks.find(item => item.id === taskId)!.artifacts.find(item => item.id === artifactId)!
    return { ok: true, title: '报告', sha256: artifact.sha256,
      url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/${taskId}-${artifact.sha256}.html` }
  })
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount('chat-a')
  await view.render('tasks')
  expect(view.browser()).toBeNull()
  tasks = [selected, task('parallel', 'chat-b')]
  await view.render('tasks')
  tasks = [{ ...selected, status: 'completed', artifacts: [{ ...selected.artifacts[0]!, sha256: 'verified-v2', sourceEvidenceStatus: 'verified', sourceEvidenceReceiptId: 'proof-v2' }] },
    { ...task('parallel', 'chat-b'), updatedAt: '2027-01-01T00:00:00Z' }]
  await view.render('tasks')
  expect(view.browser()).not.toBeNull()
  expect(view.browser()?.getAttribute('src')).toContain('/selected-verified-v2.html')
  expect(previewTaskArtifact.mock.calls.map(([request]) => request.taskId)).toEqual(['selected', 'selected'])
  await view.close()
  tasks = tasks.map(item => ({ ...item, artifacts: [...item.artifacts] }))
  await view.render('tasks')
  expect(view.browser()).toBeNull()
  expect(previewTaskArtifact).toHaveBeenCalledTimes(2)
  tasks = tasks.map(item => item.id === selected.id ? { ...item, artifacts: [{ ...item.artifacts[0]!, sha256: 'verified-v3', sourceEvidenceReceiptId: 'proof-v3' }] } : item)
  await view.render('tasks')
  expect(view.browser()?.getAttribute('src')).toContain('/selected-verified-v3.html')
  expect(previewTaskArtifact).toHaveBeenCalledTimes(3)
})

it('keeps the current chat report when a same-origin scheduled child publishes in the background', async () => {
  const initial = { ...task('initial', 'chat-a'), status: 'completed' } as TaskRunV1
  tasks = [initial]
  const previewTaskArtifact = vi.fn(async ({ taskId }: { taskId: string }) => ({ ok: true, title: '报告',
    sha256: 'html-v1', url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/${taskId}.html` }))
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount('chat-a')
  await view.render('chat')
  expect(view.browser()?.getAttribute('src')).toContain('/initial.html')
  const due = Object.assign(task('due', 'chat-a'), { parentTaskId: initial.id, status: 'running',
    updatedAt: '2026-11-13T19:00:00Z', scheduledBy: { scheduleId: 'daily', dueAt: '2026-11-13T19:00:00Z' } })
  tasks = [initial, due]
  await view.render('chat')
  expect(view.browser()?.getAttribute('src')).toContain('/initial.html')
  expect(previewTaskArtifact.mock.calls.map(([request]) => request.taskId)).toEqual(['initial'])
  tasks = [initial, { ...due, status: 'completed', updatedAt: '2026-11-13T19:05:00Z' } as TaskRunV1]
  await view.render('chat')
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
  await view.render('chat')
  expect(view.browser()?.getAttribute('src')).toContain('/initial-html-v1.html')
  await act(async () => foregroundTaskArtifactPreview('chat-a', foreground.id))
  tasks = [{ ...initial, updatedAt: '2029-01-01T00:00:00Z', artifacts: [{ ...initial.artifacts[0]!, sha256: 'late-parallel' }] }, foreground]
  await view.render('chat')
  expect(view.browser()?.getAttribute('src')).toContain('/initial-html-v1.html')
  expect(previewTaskArtifact).toHaveBeenCalledOnce()
  tasks = [tasks[0]!, { ...foreground, artifacts: task('foreground').artifacts }]
  await view.render('chat')
  expect(view.browser()?.getAttribute('src')).toContain('/foreground-html-v1.html')
  expect(previewTaskArtifact.mock.calls.map(([request]) => request.taskId)).toEqual(['initial', 'foreground'])
  await view.close()
  await view.render('chat')
  expect(view.browser()).toBeNull()
  tasks = tasks.map(item => item.id === foreground.id ? { ...item, artifacts: [{ ...item.artifacts[0]!, sha256: 'html-v2' }] } : item)
  await view.render('chat')
  expect(view.browser()?.getAttribute('src')).toContain('/foreground-html-v2.html')
  expect(previewTaskArtifact).toHaveBeenCalledTimes(3)
})

it('automatically opens a scheduled task explicitly selected in the task workspace and lets the user open its artifact again', async () => {
  const due = Object.assign(task('due', 'chat-a'), { scheduledBy: { scheduleId: 'daily', dueAt: '2026-11-13T19:00:00Z' } })
  tasks = [task('initial', 'chat-a'), due]
  selectedTaskId = due.id
  const previewTaskArtifact = vi.fn(async ({ taskId }: { taskId: string }) => ({ ok: true, title: '报告',
    url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/${taskId}.html` }))
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount('chat-a')
  await view.render('tasks')
  expect(view.browser()?.getAttribute('src')).toContain('/due.html')
  await view.close()
  await view.render('tasks')
  expect(view.browser()).toBeNull()
  await view.click('打开due')
  expect(view.browser()?.getAttribute('src')).toContain('/due.html')
  expect(previewTaskArtifact).toHaveBeenCalledTimes(2)
})

it('discards the selected task late preview when the user selects another task', async () => {
  tasks = [task('one', 'chat-b'), task('two', 'chat-c')]
  selectedTaskId = 'one'
  let finish!: (value: unknown) => void
  const previewTaskArtifact = vi.fn(({ taskId }: { taskId: string }) => taskId === 'one'
    ? new Promise(resolve => { finish = resolve })
    : Promise.resolve({ ok: true, title: '报告', sha256: 'html-v1', url: `http://127.0.0.1:1234/task-preview/${'b'.repeat(48)}/two.html` }))
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount('chat-a')
  await view.render('tasks')
  expect(previewTaskArtifact).toHaveBeenCalledWith({ taskId: 'one', artifactId: 'html' })
  selectedTaskId = 'two'
  await view.render('tasks')
  expect(view.browser()?.getAttribute('src')).toContain('/two.html')
  await act(async () => finish({ ok: true, title: '旧报告', sha256: 'html-v1', url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/one.html` }))
  expect(view.browser()?.getAttribute('src')).toContain('/two.html')
  expect(previewTaskArtifact).toHaveBeenCalledTimes(2)
})

it.each(['business', 'transport'])('shows a %s preview error and retries the exact manual artifact without a chat', async failure => {
  tasks = [task('flow-artifact')]
  const message = failure === 'business' ? '成果版本已变化，请重新打开。' : '预览服务暂时不可用。'
  const previewTaskArtifact = vi.fn()
  if (failure === 'business') previewTaskArtifact.mockResolvedValueOnce({ ok: false, message })
  else previewTaskArtifact.mockRejectedValueOnce(new Error(message))
  previewTaskArtifact.mockResolvedValueOnce({ ok: true, title: '报告',
    url: `http://127.0.0.1:1234/task-preview/${'a'.repeat(48)}/flow-artifact.html` })
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact, openExternal: vi.fn() } })
  const view = await mount(null)
  await view.render('tasks')
  await view.click('打开flow-artifact')
  expect(container!.querySelector('[role="alert"]')?.textContent).toContain(message)
  expect(view.browser()).toBeNull()
  await view.render('chat')
  expect(container!.querySelector('[role="alert"]')).toBeNull()
  await view.render('tasks')
  await view.click('重新打开网页成果')
  expect(container!.querySelector('[role="alert"]')).toBeNull()
  expect(view.browser()?.getAttribute('src')).toContain('/flow-artifact.html')
  expect(previewTaskArtifact.mock.calls).toEqual([
    [{ taskId: 'flow-artifact', artifactId: 'html' }], [{ taskId: 'flow-artifact', artifactId: 'html' }]
  ])
})
