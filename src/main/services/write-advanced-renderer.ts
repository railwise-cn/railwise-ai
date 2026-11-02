import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderWriteMath, WRITE_MATH_MAX_LENGTH } from '../../shared/write-advanced-markdown'
import { sanitizeWriteMermaidSvg, validateWriteMermaidSource } from '../../shared/write-mermaid-policy'

const MAX_DIAGRAMS = 32
const MAX_RENDER_MS = 20_000
const MAX_RENDER_WIDTH = 2_000
const MAX_RENDER_HEIGHT = 2_400

/** Rasterization size is independent of the final document's logical font size. */
export const WRITE_MATH_RASTER_FONT_SIZE_PX = 30

export type WriteRenderedDiagram = {
  svg: string
  png: Buffer
  width: number
  height: number
}

export type WriteRenderedMath = { png: Buffer; width: number; height: number }

async function readBundledDependencyAsset(path: string): Promise<Buffer> {
  // Packaged runs read only the shipped dependency tree. The development
  // fallback also supports source-level export tests without Electron's app path.
  const roots = app.isPackaged ? [app.getAppPath()] : [app.getAppPath(), process.cwd()]
  let lastError: unknown
  for (const root of roots) {
    try { return await readFile(join(root, 'node_modules', path)) } catch (error) { lastError = error }
  }
  throw lastError
}

let mathCss: Promise<string> | undefined

/** A standalone export includes its own fonts and never requests a CDN. */
export function loadWriteMathExportCss(): Promise<string> {
  mathCss ??= (async () => {
    const css = (await readBundledDependencyAsset('katex/dist/katex.min.css')).toString('utf8')
    const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1].replace(/^["']|["']$/g, '')))]
    const replacements = new Map<string, string>()
    await Promise.all(urls.map(async (url) => {
      if (!/^fonts\/[A-Za-z0-9_-]+\.(?:woff2?|ttf)$/.test(url)) {
        replacements.set(url, '')
        return
      }
      const bytes = await readBundledDependencyAsset(`katex/dist/${url}`)
      const mime = url.endsWith('.woff2') ? 'font/woff2' : url.endsWith('.woff') ? 'font/woff' : 'font/ttf'
      replacements.set(url, `data:${mime};base64,${bytes.toString('base64')}`)
    }))
    return css.replace(/url\(([^)]+)\)/g, (_match, raw: string) => `url("${replacements.get(raw.replace(/^["']|["']$/g, '')) ?? ''}")`)
  })()
  return mathCss
}

function withRenderDeadline<T>(operation: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local diagram rendering timed out.')), MAX_RENDER_MS)
    operation.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
  })
}

export async function renderWriteMathImage(source: string, display: boolean): Promise<WriteRenderedMath | null> {
  if (source.length > WRITE_MATH_MAX_LENGTH) return null
  const markup = renderWriteMath(source, display)
  if (!markup.includes('class="katex"')) return null
  const css = await loadWriteMathExportCss()
  const window = new BrowserWindow({
    show: false,
    width: 1_200,
    height: 900,
    backgroundColor: '#ffffff',
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, backgroundThrottling: false, partition: `workwise-math-export-${randomUUID()}` }
  })
  try {
    window.webContents.session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (_details, callback) => callback({ cancel: true }))
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-redirect', (event) => event.preventDefault())
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; font-src data:; img-src data:; object-src \'none\'; connect-src \'none\'"></head><body></body></html>'))
    const size = await withRenderDeadline(window.webContents.executeJavaScript(`(async()=>{
      const style=document.createElement('style');style.textContent=${JSON.stringify(css + `\nbody{margin:0;background:white}#formula{display:inline-block;padding:8px;font-size:${WRITE_MATH_RASTER_FONT_SIZE_PX}px}.katex-display{margin:0}`)};document.head.append(style);
      const formula=document.createElement('div');formula.id='formula';formula.innerHTML=${JSON.stringify(markup)};document.body.append(formula);
      await document.fonts.ready;
      const box=formula.getBoundingClientRect();return{width:Math.ceil(box.width),height:Math.ceil(box.height)};
    })()`)) as { width: number; height: number }
    if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width < 1 || size.height < 1 || size.width > MAX_RENDER_WIDTH || size.height > MAX_RENDER_HEIGHT) return null
    window.setContentSize(size.width, size.height)
    const image = await withRenderDeadline(window.webContents.capturePage({ x: 0, y: 0, ...size }))
    return { png: image.toPNG(), ...size }
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}

/**
 * Mermaid needs a real layout engine. It runs in a separate sandboxed Chromium
 * session with no Node, network, permissions, navigation or persistent storage.
 * The resulting SVG is sanitized again before it reaches an export or screenshot.
 */
export async function renderWriteMermaidDiagrams(sources: readonly string[]): Promise<Map<string, WriteRenderedDiagram | null>> {
  const unique = [...new Set(sources)]
  if (unique.length > MAX_DIAGRAMS) throw new Error(`A document can export at most ${MAX_DIAGRAMS} Mermaid diagrams.`)
  const results = new Map<string, WriteRenderedDiagram | null>()
  const valid = unique.filter((source) => {
    if (validateWriteMermaidSource(source).ok) return true
    results.set(source, null)
    return false
  })
  if (!valid.length) return results

  // Use the core ESM bundle built against our reviewed dependency tree. The
  // upstream UMD embeds older sanitizer/math copies independently of npm locks.
  const script = (await readFile(join(app.getAppPath(), 'out/markdown-rendering/mermaid.js'))).toString('utf8')
  const window = new BrowserWindow({
    show: false,
    width: 1_200,
    height: 900,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      backgroundThrottling: false,
      partition: `workwise-diagram-export-${randomUUID()}`
    }
  })
  try {
    const session = window.webContents.session
    session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (_details, callback) => callback({ cancel: true }))
    session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => event.preventDefault())
    window.webContents.on('will-redirect', (event) => event.preventDefault())
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'"><style>html,body{margin:0;background:white;font-family:Arial,"PingFang SC",sans-serif}#diagram{display:inline-block;padding:12px}svg{display:block;max-width:none!important}</style></head><body><div id="diagram"></div></body></html>'))
    await withRenderDeadline(window.webContents.executeJavaScript(`${script}\n;mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'default',htmlLabels:false,maxTextSize:50000,maxEdges:500,suppressErrorRendering:true,fontFamily:'Arial, PingFang SC, sans-serif',flowchart:{htmlLabels:false,useMaxWidth:false},sequence:{useMaxWidth:false}});undefined`))
    for (const source of valid) {
      try {
        const raw = await withRenderDeadline(window.webContents.executeJavaScript(`mermaid.render(${JSON.stringify(`writeDiagram${randomUUID().replaceAll('-', '')}`)},${JSON.stringify(source)}).then(result=>result.svg)`)) as string
        const svg = sanitizeWriteMermaidSvg(raw)
        if (!svg) { results.set(source, null); continue }
        const size = await withRenderDeadline(window.webContents.executeJavaScript(`(() => {
          const container=document.getElementById('diagram');container.innerHTML=${JSON.stringify(svg)};
          const diagram=container.querySelector('svg');
          const box=diagram.viewBox.baseVal;
          const naturalWidth=box.width||Number.parseFloat(diagram.getAttribute('width'))||600;
          const naturalHeight=box.height||Number.parseFloat(diagram.getAttribute('height'))||400;
          const scale=Math.min(2,${MAX_RENDER_WIDTH}/naturalWidth,${MAX_RENDER_HEIGHT}/naturalHeight);
          diagram.setAttribute('width',String(Math.max(1,Math.ceil(naturalWidth*scale))));
          diagram.setAttribute('height',String(Math.max(1,Math.ceil(naturalHeight*scale))));
          return {width:Math.ceil(naturalWidth*scale)+24,height:Math.ceil(naturalHeight*scale)+24};
        })()`)) as { width: number; height: number }
        if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width < 1 || size.height < 1 || size.width > MAX_RENDER_WIDTH + 24 || size.height > MAX_RENDER_HEIGHT + 24) {
          results.set(source, null)
          continue
        }
        window.setContentSize(size.width, size.height)
        await withRenderDeadline(window.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))'))
        const image = await withRenderDeadline(window.webContents.capturePage({ x: 0, y: 0, width: size.width, height: size.height }))
        results.set(source, { svg, png: image.toPNG(), ...size })
      } catch {
        // Export retains a visible source/error fallback for a malformed diagram.
        results.set(source, null)
      }
    }
    return results
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}
