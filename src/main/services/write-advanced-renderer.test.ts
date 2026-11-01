import { beforeEach, describe, expect, it, vi } from 'vitest'

const windows = vi.hoisted(() => [] as any[])
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() },
  BrowserWindow: class {
    options: any
    destroyed = false
    webContents = {
      session: { webRequest: { onBeforeRequest: vi.fn() }, setPermissionRequestHandler: vi.fn() },
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      executeJavaScript: vi.fn(async (script: string) => {
        if (script.startsWith('mermaid.render')) return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 30"><foreignObject><div>unsafe</div></foreignObject><text>资料</text><script>alert(1)</script></svg>'
        if (script.includes('return {width:')) return { width: 184, height: 84 }
        return undefined
      }),
      capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from('local-png') }))
    }
    loadURL = vi.fn(async () => undefined)
    setContentSize = vi.fn()
    constructor(options: any) { this.options = options; windows.push(this) }
    isDestroyed(): boolean { return this.destroyed }
    destroy(): void { this.destroyed = true }
  }
}))

import { renderWriteMermaidDiagrams } from './write-advanced-renderer'

describe('local diagram export sandbox', () => {
  beforeEach(() => { windows.length = 0 })

  it('renders valid diagrams in an isolated session, denies external actions and sanitizes output before capture', async () => {
    const source = 'flowchart LR\nA[资料] --> B[审定]'
    const rendered = (await renderWriteMermaidDiagrams([source, source])).get(source)
    expect(windows).toHaveLength(1)
    const window = windows[0]
    expect(window.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true })
    expect(window.options.webPreferences.partition).toMatch(/^workwise-diagram-export-/)
    const denyRequest = window.webContents.session.webRequest.onBeforeRequest.mock.calls[0][1]
    const response = vi.fn()
    denyRequest({}, response)
    expect(response).toHaveBeenCalledWith({ cancel: true })
    const denyPermission = window.webContents.session.setPermissionRequestHandler.mock.calls[0][0]
    denyPermission(null, 'camera', response)
    expect(response).toHaveBeenLastCalledWith(false)
    expect(window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' })
    const script = window.webContents.executeJavaScript.mock.calls[0][0]
    expect(script).toContain("securityLevel:'strict'")
    expect(script).toContain('htmlLabels:false')
    expect(rendered?.svg).toContain('资料')
    expect(rendered?.svg).not.toMatch(/script|foreignObject|unsafe/)
    expect(rendered?.png).toEqual(Buffer.from('local-png'))
    expect(window.destroyed).toBe(true)
  })

  it('never creates a browser window for rejected source and bounds diagrams per export', async () => {
    const source = 'flowchart LR\nclick A "https://example.invalid"'
    expect((await renderWriteMermaidDiagrams([source])).get(source)).toBeNull()
    expect(windows).toHaveLength(0)
    await expect(renderWriteMermaidDiagrams(Array.from({ length: 33 }, (_, index) => `flowchart LR\nA${index}-->B${index}`))).rejects.toThrow('at most 32')
    expect(windows).toHaveLength(0)
  })
})
