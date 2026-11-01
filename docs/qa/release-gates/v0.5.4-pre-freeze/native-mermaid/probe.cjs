const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { createHash, randomUUID } = require('node:crypto')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { sanitizeWriteMermaidSvg } = require('/private/tmp/railwise-054-mermaid-policy-probe.cjs')

const root = process.env.RAILWISE_PROBE_OUTPUT || '/private/tmp/railwise-054-mermaid-native-probe'
const source = '/private/tmp/railwise-release-0.5.4-20261101'
mkdirSync(root, { recursive: true, mode: 0o700 })
app.setPath('userData', join(root, 'electron-user-data'))
app.setPath('logs', join(root, 'electron-logs'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { schemaVersion: 1, scope: 'Real Electron sandboxed offline bundle probe; not final packaged application UI acceptance.',
  startedAt: new Date().toISOString(), status: 'running', versions: process.versions, source,
  sandbox: { nodeIntegration: false, sandbox: true, contextIsolation: true, webSecurity: true },
  requests: [], permissionRequests: [], permissionChecks: [], navigations: [], windowOpen: [], console: [], cases: [] }
const save = () => writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const deadline = (promise, ms = 20_000) => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`Probe timeout ${ms}ms`)), ms); timer.unref() })])
const cases = [
  { name: 'flowchart-zh', source: 'flowchart LR\n A[开始编写] --> B{资料完整吗}\n B -->|是| C[生成报告]\n B -->|否| D[补充资料]\n D --> A', expected: ['开始编写', '生成报告'] },
  { name: 'sequence', source: 'sequenceDiagram\n participant U as 用户\n participant A as RailWise AI\n U->>A: 整理工程资料\n A-->>U: 返回可审阅草稿\n Note over U,A: 本地文档工作台', expected: ['用户', '返回可审阅草稿'] },
  { name: 'class', source: 'classDiagram\n class Document {\n +String title\n +save()\n }\n class Revision {\n +String fingerprint\n }\n Document "1" --> "many" Revision : history', expected: ['Document', 'Revision', 'fingerprint'] },
  { name: 'state', source: 'stateDiagram-v2\n [*] --> Draft\n Draft --> Review: submit\n Review --> Published: accept\n Review --> Draft: revise\n Published --> [*]', expected: ['Draft', 'Review', 'Published'] },
  { name: 'math-label-katex', source: 'flowchart LR\n A["$$\\int_0^1 x^2\\,dx=\\frac{1}{3}$$"] --> B["$$E=mc^2$$"]', expected: ['$$E=mc^2$$'], literalMath: true }
]

app.whenReady().then(async () => {
  const bundlePath = process.env.RAILWISE_PROBE_BUNDLE || join(source, 'out/markdown-rendering/mermaid.js')
  const bundle = readFileSync(bundlePath)
  const build = JSON.parse(readFileSync(join(source, 'out/markdown-rendering/mermaid-build.json'), 'utf8'))
  report.bundle = { path: bundlePath, bytes: bundle.length, sha256: digest(bundle), versions: build.versions }
  if (!process.env.RAILWISE_PROBE_BUNDLE) { assert.equal(report.bundle.sha256, build.sha256); assert.equal(bundle.length, build.bytes) }
  report.bundle.kind=process.env.RAILWISE_PROBE_BUNDLE?'upstream-UMD-control':'reviewed-core-IIFE'
  assert.equal(process.versions.electron, '43.1.1')
  const window = new BrowserWindow({ show: false, width: 1200, height: 900, backgroundColor: '#ffffff',
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, webSecurity: true, backgroundThrottling: false, partition: `mermaid-probe-${randomUUID()}` } })
  try {
    const session = window.webContents.session
    session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => { report.requests.push({ url: details.url, resourceType: details.resourceType }); callback({ cancel: true }) })
    session.setPermissionRequestHandler((_wc, permission, callback) => { report.permissionRequests.push(permission); callback(false) })
    session.setPermissionCheckHandler((_wc, permission) => { report.permissionChecks.push(permission); return false })
    window.webContents.setWindowOpenHandler(details => { report.windowOpen.push(details.url); return { action: 'deny' } })
    window.webContents.on('will-navigate', (event, url) => { report.navigations.push(url); event.preventDefault() })
    window.webContents.on('will-redirect', (event, url) => { report.navigations.push(url); event.preventDefault() })
    window.webContents.on('console-message', (_event, details) => report.console.push({ level: details.level, message: details.message }))
    window.webContents.on('render-process-gone', (_event, details) => { report.rendererGone = details; save() })
    const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
    report.csp = csp
    const html = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="'+csp+'"><style>html,body{margin:0;background:white;font-family:Arial,"PingFang SC",sans-serif}#diagram{display:inline-block;padding:12px}svg{display:block;max-width:none!important}</style></head><body><div id="diagram"></div></body></html>'
    await deadline(window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)))
    report.rendererEnvironment = await window.webContents.executeJavaScript('({require:typeof require,process:typeof process,Buffer:typeof Buffer,MathMLElement:typeof MathMLElement,userAgent:navigator.userAgent})')
    assert.equal(report.rendererEnvironment.require, 'undefined'); assert.equal(report.rendererEnvironment.process, 'undefined'); assert.equal(report.rendererEnvironment.Buffer, 'undefined')
    await deadline(window.webContents.executeJavaScript("window.__probeViolations=[];window.__probeExecuted=false;document.addEventListener('securitypolicyviolation',e=>window.__probeViolations.push({directive:e.violatedDirective,blockedURI:e.blockedURI}));"))
    const config = { startOnLoad: false, securityLevel: 'strict', theme: 'default', htmlLabels: false, maxTextSize: 50000, maxEdges: 500, suppressErrorRendering: true,
      fontFamily: 'Arial, PingFang SC, sans-serif', flowchart: { htmlLabels: false, useMaxWidth: false }, sequence: { useMaxWidth: false } }
    report.mermaidConfig = config
    await deadline(window.webContents.executeJavaScript(bundle.toString('utf8') + '\n;mermaid.initialize(' + JSON.stringify(config) + ');undefined'))
    for (const [index, specimen] of cases.entries()) {
      const item = { name: specimen.name, source: specimen.source, status: 'running' }; report.cases.push(item)
      writeFileSync(join(root, specimen.name + '.mmd'), specimen.source + '\n')
      try {
        const result = await deadline(window.webContents.executeJavaScript(`mermaid.render('probe${index}',${JSON.stringify(specimen.source)}).then(result=>({svg:result.svg,diagramType:result.diagramType}))`))
        writeFileSync(join(root, specimen.name + '.svg'), result.svg)
        const sanitized = sanitizeWriteMermaidSvg(result.svg)
        writeFileSync(join(root, specimen.name + '.sanitized.svg'), sanitized)
        item.sanitizedSvgBytes=Buffer.byteLength(sanitized);item.sanitizedSvgSha256=digest(sanitized)
        const inspected = await deadline(window.webContents.executeJavaScript(`(() => {
          const raw=${JSON.stringify(result.svg)}; const parsed=new DOMParser().parseFromString(raw,'image/svg+xml'); const svg=parsed.documentElement;
          const active=[];for(const el of parsed.querySelectorAll('*')) {
            if(['script','iframe','object','embed','audio','video','animate','animatetransform','set'].includes(el.localName.toLowerCase())) active.push({tag:el.localName});
            for(const a of el.attributes) if(/^on/i.test(a.name)||(/^(?:href|xlink:href|src)$/i.test(a.name)&&a.value&&!a.value.startsWith('#'))||/javascript:|@import|url\\(\\s*['"]?(?!#|data:)/i.test(a.value)) active.push({tag:el.localName,attribute:a.name,value:a.value.slice(0,120)});
          }
          for(const style of parsed.querySelectorAll('style')) if(/@import|url\\(\\s*['"]?(?!#|data:)/i.test(style.textContent)) active.push({style:true});
          const host=document.getElementById('diagram');host.innerHTML=raw;
          const live=host.querySelector('svg');const box=live.viewBox.baseVal;const width=box.width||parseFloat(live.getAttribute('width'));const height=box.height||parseFloat(live.getAttribute('height'));
          const scale=Math.min(1.5,1500/width,1100/height);live.setAttribute('width',String(Math.ceil(width*scale)));live.setAttribute('height',String(Math.ceil(height*scale)));
          return {parserErrors:parsed.querySelectorAll('parsererror').length,activeContent:active,text:[...svg.querySelectorAll('text')].map(el=>el.textContent).join(' | '),viewBox:{x:box.x,y:box.y,width:box.width,height:box.height},
            width:Math.ceil(width*scale)+24,height:Math.ceil(height*scale)+24,paths:svg.querySelectorAll('path').length,textElements:svg.querySelectorAll('text').length,foreignObjects:svg.querySelectorAll('foreignObject').length,
            mathML:svg.querySelectorAll('math').length,katexNodes:svg.querySelectorAll('.katex').length,mermaidError:svg.querySelectorAll('.error-icon,.error-text').length};
        })()`))
        Object.assign(item, inspected, { diagramType: result.diagramType, svgBytes: Buffer.byteLength(result.svg), svgSha256: digest(result.svg) })
        item.sanitizedMathML=(sanitized.match(/<math(?:\s|>)/g)||[]).length;item.sanitizedForeignObjects=(sanitized.match(/<foreignObject(?:\s|>)/g)||[]).length
        assert.equal(item.parserErrors, 0); assert.deepEqual(item.activeContent, []); assert.equal(item.mermaidError, 0)
        assert.ok(item.width > 30 && item.height > 30 && Number.isFinite(item.width) && Number.isFinite(item.height))
        window.setContentSize(item.width, item.height)
        await deadline(window.webContents.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))'))
        const image = await deadline(window.webContents.capturePage({ x: 0, y: 0, width: item.width, height: item.height }))
        const png = image.toPNG(); writeFileSync(join(root, specimen.name + '.png'), png)
        item.pngBytes = png.length; item.pngSha256 = digest(png); item.pngSize = image.getSize()
        assert.ok(!image.isEmpty() && png.length > 500)
        for (const text of specimen.expected) assert.ok(item.text.includes(text), 'missing expected diagram text ' + text)
        if (specimen.math) assert.ok(item.mathML > 0 || item.katexNodes > 0, 'KaTeX math nodes must be present')
        if (specimen.literalMath) { assert.equal(item.mathML,0);assert.equal(item.katexNodes,0);item.scope='htmlLabels:false intentionally retains Mermaid math-label source as SVG text; standalone KaTeX inline/block math is outside this bundle probe.' }
        item.status = 'passed'
      } catch (error) { item.status = 'failed'; item.failure = error.stack || String(error) }
      save()
    }
    report.cspViolations = await window.webContents.executeJavaScript('window.__probeViolations')
    report.executedActiveContent = await window.webContents.executeJavaScript('window.__probeExecuted')
    assert.equal(report.executedActiveContent, false)
    assert.deepEqual(report.requests, []); assert.deepEqual(report.permissionRequests, []); assert.deepEqual(report.navigations, []); assert.deepEqual(report.windowOpen, [])
    assert.ok(report.cases.every(item => item.status === 'passed'))
    report.status = 'passed'
  } finally { if (!window.isDestroyed()) window.destroy() }
}).catch(error => { report.status = 'failed'; report.failure = error.stack || String(error); process.exitCode = 1 }).finally(() => { report.completedAt = new Date().toISOString(); save(); app.exit(report.status === 'passed' ? 0 : 1) })

setTimeout(() => { report.status = 'failed'; report.failure = 'Overall native probe deadline exceeded'; save(); app.exit(2) }, 120_000).unref()
