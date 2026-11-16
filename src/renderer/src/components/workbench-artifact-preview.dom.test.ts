// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { TaskRunV1 } from '@shared/agent-workbench'
import { useTaskArtifactPreview } from '../lib/use-task-artifact-preview'
import { useWorkbenchLayout } from './workbench-layout'

let tasks: TaskRunV1[] = []
vi.mock('../store/task-live-store', () => ({ useTaskState: () => ({ tasks }) }))
let root: Root | undefined
let container: HTMLDivElement | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  container?.remove()
  tasks = []
  localStorage.clear()
  Reflect.deleteProperty(window, 'workwise')
})

function task(id: string, hash = 'html-v1'): TaskRunV1 {
  return { id, threadId: `worker-${id}`, originThreadId: id, updatedAt: '2026-11-13T00:00:00Z',
    artifacts: [{ id: 'html', relativePath: '报告.html', sha256: hash, validation: 'valid', createdAt: 'now' }] } as TaskRunV1
}

async function mount() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  let current!: { preview: ReturnType<typeof useTaskArtifactPreview>; layout: ReturnType<typeof useWorkbenchLayout> }
  function Probe({ threadId }: { threadId: string }) {
    const preview = useTaskArtifactPreview(threadId, true)
    const layout = useWorkbenchLayout({ activeThreadId: threadId, latestAutoOpenDevPreviewKey: preview.key,
      latestAutoOpenDevPreviewUrl: preview.url, latestDevPreviewUrl: preview.url, route: 'chat', workspaceRoot: '', writeAssistantOpen: false })
    current = { preview, layout }
    return createElement('section', { 'aria-label': '工作台预览' },
      createElement('button', { onClick: layout.closeDevPreview }, '关闭预览'),
      createElement('button', { onClick: layout.openDevPreview }, '打开成果'),
      createElement('output', null, layout.rightPanelMode ?? 'closed'))
  }
  const render = async (threadId: string) => { await act(async () => root!.render(createElement(Probe, { threadId }))) }
  const click = async (label: string) => {
    const button = [...container!.querySelectorAll('button')].find(button => button.textContent === label)!
    await act(async () => button.click())
  }
  await render('a')
  return { current: () => current, render, click }
}

it('restores an open HTML panel after changing conversations while keeping a user-closed version closed', async () => {
  tasks = [task('a'), task('b')]
  let sequence = 0
  const previewTaskArtifact = vi.fn(async ({ taskId }: { taskId: string }) => ({ ok: true, title: '报告', url: `http://127.0.0.1:1/${taskId}/${++sequence}` }))
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact } })
  const view = await mount()
  expect(view.current().layout.rightPanelMode).toBe('browser')
  const originalUrl = view.current().preview.url
  await view.render('b')
  await view.render('a')
  expect(view.current().preview.url).not.toBe(originalUrl)
  expect(view.current().layout.rightPanelMode).toBe('browser')
  await view.click('关闭预览')
  expect(view.current().layout.rightPanelMode).toBeNull()
  tasks = [task('a'), task('b')]
  await view.render('a')
  expect(previewTaskArtifact).toHaveBeenCalledTimes(3)
  expect(view.current().layout.rightPanelMode).toBeNull()
  await view.render('b')
  expect(view.current().layout.rightPanelMode).toBe('browser')
  await view.render('a')
  expect(view.current().preview.url).toBeTruthy()
  expect(view.current().layout.rightPanelMode).toBeNull()
  await view.click('打开成果')
  expect(view.current().layout.rightPanelMode).toBe('browser')
})

it('opens a new companion version once after the previous report was explicitly closed', async () => {
  const report = task('a')
  report.artifacts.push({ ...report.artifacts[0]!, id: 'css', relativePath: 'report.css', sha256: 'css-v1' })
  tasks = [report]
  let sequence = 0
  const previewTaskArtifact = vi.fn(async () => ({ ok: true, title: '报告', url: `http://127.0.0.1:1/a/${++sequence}` }))
  Object.defineProperty(window, 'workwise', { configurable: true, value: { previewTaskArtifact } })
  const view = await mount()
  await view.click('关闭预览')
  tasks = [{ ...report, artifacts: report.artifacts.map(file => file.id === 'css' ? { ...file, sha256: 'css-v2' } : file) }]
  await view.render('a')
  expect(view.current().layout.rightPanelMode).toBe('browser')
  expect(previewTaskArtifact).toHaveBeenCalledTimes(2)
  await view.click('关闭预览')
  tasks = [{ ...tasks[0]!, artifacts: [...tasks[0]!.artifacts].reverse() }]
  await view.render('a')
  expect(previewTaskArtifact).toHaveBeenCalledTimes(2)
  expect(view.current().layout.rightPanelMode).toBeNull()
})
