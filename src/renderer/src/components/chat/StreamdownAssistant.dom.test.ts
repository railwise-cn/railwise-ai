// @vitest-environment happy-dom
import { act, createElement, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearFileReferenceValidationCache } from '../../lib/file-reference-validation'
import { WORKSPACE_FILE_PREVIEW_EVENT } from '../../lib/workspace-file-preview'
import { useChatStore } from '../../store/chat-store'
import { StreamdownAssistant } from './StreamdownAssistant'

let host: HTMLDivElement
let root: Root
let previousWorkspace: string
const resolveWorkspaceFile = vi.fn(async (request: { path: string; workspaceRoot?: string }) => request.workspaceRoot
  ? { ok: true, path: `${request.workspaceRoot}/${request.path}` }
  : { ok: false, error: 'No selected workspace' })

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  clearFileReferenceValidationCache()
  previousWorkspace = useChatStore.getState().workspaceRoot
  useChatStore.setState({ workspaceRoot: '/active-chat' })
  resolveWorkspaceFile.mockClear()
  Object.defineProperty(window, 'workwise', { configurable: true, value: { resolveWorkspaceFile } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  Reflect.deleteProperty(window, 'workwise')
  useChatStore.setState({ workspaceRoot: previousWorkspace })
  clearFileReferenceValidationCache()
  vi.restoreAllMocks()
})

async function render(props: Parameters<typeof StreamdownAssistant>[0]): Promise<void> {
  let commits = 0
  await act(async () => root.render(createElement(Profiler, { id: 'markdown', onRender: () => { if (++commits > 30) throw new Error('Unexpected repeated Markdown commits') } }, createElement(StreamdownAssistant, props))))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('static Markdown delivery notes', () => {
  it('contains local links and inline file references to their explicit result workspace', async () => {
    const previews: unknown[] = []
    const listener = (event: Event): void => { previews.push((event as CustomEvent).detail) }
    window.addEventListener(WORKSPACE_FILE_PREVIEW_EVENT, listener)
    try {
      await render({ text: '[最终报告](reports/final.md)\n\n源资料：`reports/source.txt`', streaming: false, workspaceRoot: '/selected-task', restricted: true })
      expect(resolveWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'reports/final.md', workspaceRoot: '/selected-task' }))
      expect(resolveWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'reports/source.txt', workspaceRoot: '/selected-task' }))
      expect(resolveWorkspaceFile.mock.calls.every(([request]) => request.workspaceRoot === '/selected-task')).toBe(true)
      const link = host.querySelector<HTMLAnchorElement>('a.ds-file-reference-link')!
      const code = host.querySelector<HTMLButtonElement>('button.ds-file-reference-code')!
      expect(link?.textContent).toBe('最终报告')
      expect(code?.textContent).toBe('reports/source.txt')
      await act(async () => { link.click(); code.click() })
      expect(previews).toEqual([
        expect.objectContaining({ path: '/selected-task/reports/final.md', workspaceRoot: '/selected-task' }),
        expect.objectContaining({ path: '/selected-task/reports/source.txt', workspaceRoot: '/selected-task' })
      ])
    } finally { window.removeEventListener(WORKSPACE_FILE_PREVIEW_EVENT, listener) }
  })

  it('preserves the active chat default without an explicit workspace and never replaces an explicit empty scope', async () => {
    await render({ text: '[聊天资料](notes/chat.md)', streaming: false })
    expect(resolveWorkspaceFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'notes/chat.md', workspaceRoot: '/active-chat' }))
    await render({ text: '[无工作区资料](notes/unscoped.md)', streaming: false, workspaceRoot: '', restricted: true })
    expect(resolveWorkspaceFile).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'notes/unscoped.md', workspaceRoot: '' }))
    expect(host.querySelector('a.ds-file-reference-link')).toBeNull()
  })

  it('renders Markdown structure without activating HTML or fetching image assets', async () => {
    const fetch = vi.spyOn(window, 'fetch')
    await render({ text: '## 交付说明\n\n**已完成**\n\n- 报告\n- 单位 `毫米`\n\n<script>alert(1)</script>\n<iframe src="https://invalid.example/frame"></iframe>\n<img src="https://invalid.example/raw.png">\n\n![远程示意图](https://invalid.example/image.png)\n\n```html\n<script>window.untrustedExecution = true</script>\n```\n\n[不安全链接](javascript:alert(1))', streaming: false, workspaceRoot: '', restricted: true })
    expect(host.querySelector('h2')?.textContent).toBe('交付说明')
    expect(host.querySelector('[data-streamdown="strong"]')?.textContent).toBe('已完成')
    expect(host.querySelectorAll('ul > li')).toHaveLength(2)
    expect(host.querySelector('code')?.textContent).toBe('毫米')
    expect(host.textContent).toContain('远程示意图')
    expect(host.querySelector('script, iframe, img, object, embed, style')).toBeNull()
    expect(host.querySelector('pre')?.textContent).toContain('<script>window.untrustedExecution = true</script>')
    expect(host.querySelector('button[aria-label*="执行"], button[aria-label*="运行"], button[aria-label*="preview"]')).toBeNull()
    expect([...host.querySelectorAll('a')].some(link => /^javascript:/i.test(link.href))).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})
