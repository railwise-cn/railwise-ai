import { runInNewContext } from 'node:vm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const windows = vi.hoisted(() => [] as any[])
const diagramSize = vi.hoisted(() => ({ width: 80, height: 30 }))
const svgSize = vi.hoisted(() => ({ width: 0, height: 0 }))
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
        if (svgSize.width && script.includes('await image.decode()')) {
          const image = { naturalWidth: svgSize.width, naturalHeight: svgSize.height, style: {}, decode: async () => undefined }
          return runInNewContext(script, { document: { createElement: () => image, body: { append: () => undefined } } })
        }
        if (script.includes('const naturalWidth=box.width')) {
          const diagram = { viewBox: { baseVal: diagramSize }, getAttribute: () => null, setAttribute: vi.fn() }
          return runInNewContext(script, { document: { getElementById: () => ({ innerHTML: '', querySelector: () => diagram }) } })
        }
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

import { renderWriteMermaidDiagrams, renderWriteSvgImage } from './write-advanced-renderer'

describe('local diagram export sandbox', () => {
  beforeEach(() => { windows.length = 0; diagramSize.width = 80; diagramSize.height = 30; svgSize.width = 0; svgSize.height = 0 })

  it('rasterizes a passive local SVG with no network, scripts, permissions or navigation', async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><text x="10" y="30">监测趋势</text></svg>'
    expect(await renderWriteSvgImage(source)).toMatchObject({ png: Buffer.from('local-png'), width: 184, height: 84 })
    const window = windows[0]
    expect(window.options.webPreferences).toMatchObject({ sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true })
    expect(window.options.webPreferences.partition).toMatch(/^railwise-svg-export-/)
    expect(decodeURIComponent(window.loadURL.mock.calls[0][0])).toContain("default-src 'none'")
    expect(decodeURIComponent(window.loadURL.mock.calls[0][0])).not.toContain("script-src 'unsafe-inline'")
    const request = vi.fn()
    window.webContents.session.webRequest.onBeforeRequest.mock.calls[0][1]({}, request)
    expect(request).toHaveBeenCalledWith({ cancel: true })
    expect(window.webContents.executeJavaScript.mock.calls[0][0]).toContain('await image.decode()')
    expect(window.destroyed).toBe(true)
  })

  it('retains a valid 1552px SVG at the export raster width limit', async () => {
    svgSize.width = 1552
    svgSize.height = 64
    const source = '<svg xmlns="http://www.w3.org/2000/svg" width="1552" height="64"><text x="10" y="30">监测趋势</text></svg>'
    expect(await renderWriteSvgImage(source)).toMatchObject({ width: 2000, height: 83, png: Buffer.from('local-png') })
    expect(windows[0].setContentSize).toHaveBeenCalledWith(2000, 83)
    expect(windows[0].webContents.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 2000, height: 83 })
  })

  it('rejects active SVG before constructing a renderer', async () => {
    expect(await renderWriteSvgImage('<svg><image href="https://example.invalid/private.png" /></svg>')).toBeNull()
    expect(await renderWriteSvgImage('<svg onload="alert(1)"></svg>')).toBeNull()
    expect(windows).toHaveLength(0)
  })

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

  it('keeps a valid wide Chinese flowchart within the integer capture limit', async () => {
    const source = 'flowchart LR\nA[原始文件] --> B[识别与来源预检]\nB --> C[网型、控制点、单位与基准]\nC --> D[确定性计算]\nD --> E[结果、残差、闭合差与精度]\nE --> F[待审查成果]\nF --> G[人工专业复核]'
    // The packaged help diagram produces this viewBox; IEEE-754 rounding makes
    // Math.ceil(1552 * (2000 / 1552)) equal 2001 before the integer clamp.
    diagramSize.width = 1552
    diagramSize.height = 64
    const rendered = (await renderWriteMermaidDiagrams([source])).get(source)
    expect(rendered).toMatchObject({ width: 2024, height: 107, png: Buffer.from('local-png') })
    expect(windows[0].setContentSize).toHaveBeenCalledWith(2024, 107)
    expect(windows[0].webContents.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 2024, height: 107 })
  })

  it('rejects invalid viewBox dimensions before capture', async () => {
    diagramSize.width = -1
    const source = 'flowchart LR\nA --> B'
    expect((await renderWriteMermaidDiagrams([source])).get(source)).toBeNull()
    expect(windows[0].webContents.capturePage).not.toHaveBeenCalled()
  })

  it('never creates a browser window for rejected source and bounds diagrams per export', async () => {
    const source = 'flowchart LR\nclick A "https://example.invalid"'
    expect((await renderWriteMermaidDiagrams([source])).get(source)).toBeNull()
    expect(windows).toHaveLength(0)
    await expect(renderWriteMermaidDiagrams(Array.from({ length: 33 }, (_, index) => `flowchart LR\nA${index}-->B${index}`))).rejects.toThrow('at most 32')
    expect(windows).toHaveLength(0)
  })
})
