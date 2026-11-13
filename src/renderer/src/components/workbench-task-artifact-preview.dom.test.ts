// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { act, createElement, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskRunV1 } from '@shared/agent-workbench'
import { useTaskArtifactPreview } from '../lib/use-task-artifact-preview'
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
    updatedAt: '2026-11-13T00:00:00Z', artifacts: [{ id: 'html', relativePath: '报告.html',
      sha256: 'html-v1', validation: 'valid', createdAt: 'now' }] } as TaskRunV1
}

async function mount(activeThreadId: string | null = 'chat-a') {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  function Probe({ route }: { route: 'chat' | 'tasks' }) {
    const conversation = useTaskArtifactPreview(activeThreadId, true)
    const workspace = useTaskArtifactPreview(null, route === 'tasks')
    const lastRequest = useRef<{ taskId: string; artifactId: string } | null>(null)
    const preview = route === 'tasks' ? workspace : conversation
    const routeRef = useRef(route)
    routeRef.current = route
    const layout = useWorkbenchLayout({ activeThreadId: route === 'tasks' ? 'task-workspace-preview' : activeThreadId,
      latestAutoOpenDevPreviewKey: preview.key, latestAutoOpenDevPreviewUrl: preview.url,
      latestDevPreviewUrl: preview.url, route, workspaceRoot: '', writeAssistantOpen: false })
    const openArtifact = async (request: { taskId: string; artifactId: string }) => {
      lastRequest.current = request
      try {
        await workspace.open(request)
        if (routeRef.current === 'tasks') layout.setRightPanelMode('browser')
      } catch { /* The task workspace renders the hook's error and retry action. */ }
    }
    return createElement('div', { className: 'flex min-h-0 min-w-0 flex-1' },
      createElement('section', { 'aria-label': route === 'tasks' ? '任务工作台' : '聊天' },
        route === 'tasks' && workspace.error ? createElement('div', { role: 'alert' }, workspace.error,
          createElement('button', { onClick: () => { if (lastRequest.current) void openArtifact(lastRequest.current) } }, '重新打开网页成果')) : null,
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
  expect(taskRenderer).toContain('{renderRightPanel()}')
  expect(taskRenderer).toContain('await openWorkspaceArtifact({ taskId: task.id, artifactId })')
  expect(taskRenderer).toContain('workspaceArtifactPreview.error')
  expect(taskRenderer).toContain('void openWorkspaceArtifact(lastWorkspaceArtifactRequest.current)')
  expect(taskRenderer).not.toContain('workspaceArtifactPreview.retry(')
  expect(taskRenderer).not.toContain('selectThread(')
  expect(taskRenderer).not.toContain('await taskArtifactPreview.open(')
  expect(source).toContain("activeThreadId: route === 'tasks' ? 'task-workspace-preview' : activeThreadId")
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
