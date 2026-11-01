import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer, build } from 'vite'
import JSZip from 'jszip'

// Real Chromium + the pinned viewer. This deliberately does not use a mocked
// viewer, a mock DOM, or the SVG compatibility importer.
const args = process.argv.slice(2)
function argument(name, fallback) {
  const at = args.indexOf(name)
  return at < 0 ? fallback : args[at + 1]
}
const input = resolve(argument('--input', '/Users/wangjiawei/Desktop/Coding Agent实战培训coding_agent_training_20260729_171858.pptx'))
const output = resolve(argument('--output', await mkdtemp(join(tmpdir(), 'railwise-native-roundtrip-'))))
await mkdir(output, { recursive: true })
const inputBytes = await readFile(input)
if (inputBytes.length > 200 * 1024 * 1024) throw new Error('Input exceeds 200 MiB')
const expectedPages = (await (await JSZip.loadAsync(inputBytes)).file('ppt/presentation.xml').async('string')).match(/<(?:\w+:)?sldId\b/g)?.length ?? 0
const marker = 'RailWise native round-trip verified'
const coreDist = resolve('node_modules/pptx-vanilla-viewer/node_modules/ooxml-core/dist')
let resolveReport
const finished = new Promise((resolve) => { resolveReport = resolve })
let reportReceived = false
let outputBytes
let html
const client = `
import { createPptxViewer } from '/node_modules/pptx-vanilla-viewer/dist/index.js';
import { translationsZhCN } from '/node_modules/pptx-vanilla-viewer/dist/i18n/zh-CN.mjs';
import '/node_modules/pptx-vanilla-viewer/dist/styles.css';
const errors=[]; addEventListener('error',e=>errors.push(String(e.message))); addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
const report={status:'running', expectedPages:${expectedPages}, checks:[], consoleErrors:errors};
let viewer;
function flatten(elements){return elements.flatMap(element=>[element,...flatten(element.children||[])]);}
function locate(id){return flatten(viewer.getElements()).find(element=>element.id===id);}
function patch(id, updates){
 viewer.updateElement(id, updates);
}
async function open(bytes){
  viewer?.destroy();
  return await new Promise((resolve,reject)=>{
    let loaded=false;
    viewer=createPptxViewer(document.getElementById('editor'),{source:bytes,locale:'zh-CN',messages:{'zh-CN':translationsZhCN},editable:true,readOnly:false,allowExternalContent:false,googleFonts:false,autosave:false,showToolbar:true,showThumbnails:true,showInspector:false,limits:{maxInputBytes:209715200,maxUncompressedBytes:524288000,maxEntries:20000,maxSlides:500,maxShapes:30000},onLoad:()=>{loaded=true;resolve(viewer)},onError:message=>{if(!loaded)reject(new Error(message));else errors.push(message)}});
  });
}
try{
 const bytes=new Uint8Array(await (await fetch('/__native_acceptance/input.pptx')).arrayBuffer());
 await open(bytes);
 report.slideCount=viewer.getSlideCount();
 if(report.slideCount!==report.expectedPages) throw new Error('Source slide count mismatch');
 const elements=flatten(viewer.getElements());
 const title=elements.filter(e=>e.type==='text' && (e.text || e.paragraphs?.length)).sort((a,b)=>(b.textStyle?.fontSize||0)-(a.textStyle?.fontSize||0))[0];
 report.firstPageElementCount=elements.length;
 report.firstPageTypes=Object.fromEntries([...new Set(elements.map(e=>e.type))].map(t=>[t,elements.filter(e=>e.type===t).length]));
 if(!title) throw new Error('No editable title found on the first slide');
 report.titleBefore=JSON.parse(JSON.stringify(title));
 const changedText=${JSON.stringify(marker)};
 patch(title.id,{text:changedText,textSegments:[{text:changedText,style:title.textSegments?.[0]?.style||title.textStyle}]});
 report.titleAfterEdit=JSON.parse(JSON.stringify(locate(title.id)));
 const live=locate(title.id);
 if(live.text!==changedText) throw new Error('Title edit did not update the native model');
 if(!viewer.canUndo()) throw new Error('Title edit was not undoable');
 viewer.undo();
 if(locate(title.id).text===changedText) throw new Error('Undo did not restore title');
 viewer.redo();
 const originalColor=locate(title.id).textStyle?.color;
 const colorXml={'a:srgbClr':{'@_val':'E85D04'}};
 const colorStyle=style=>({...style,color:'#E85D04',colorXml});
 const currentTitle=locate(title.id);
 patch(title.id,{textStyle:colorStyle(currentTitle.textStyle),textSegments:currentTitle.textSegments?.map(segment=>({...segment,style:colorStyle(segment.style)}))});
 report.colorBefore=originalColor; report.colorAfterEdit=locate(title.id).textStyle?.color;
 if(report.colorAfterEdit!=='#E85D04') throw new Error('Color edit did not update native model');
 report.checks.push('load-all-slides','native-title-edit','native-color-edit','undo-redo');
 for(const index of [26,37].filter(i=>i<report.slideCount)){
   viewer.goToSlide(index); const page=flatten(viewer.getElements());
   report['page'+(index+1)]={elementCount:page.length,ids:page.map(e=>e.id)};
   if(page.length>120){const target=page[page.length-1];viewer.selectElements([target.id]);if(!viewer.getSelectedElementIds().includes(target.id))throw new Error('High element index selection failed');report.checks.push('select-after-120-page-'+(index+1));}
 }
 viewer.goToSlide(0);
 report.titleBeforeSave=JSON.parse(JSON.stringify(locate(title.id)));
 const saved=await viewer.save();
 report.savedBytes=saved.length;
 await fetch('/__native_acceptance/output.pptx',{method:'POST',body:saved});
 await open(saved);
 if(viewer.getSlideCount()!==report.expectedPages) throw new Error('Round-trip slide count mismatch');
 const reopened=flatten(viewer.getElements()).find(e=>e.id===title.id) ?? flatten(viewer.getElements()).find(e=>e.text===changedText);
 report.titleReopened=reopened;
 if(!reopened || reopened.text!==changedText) throw new Error('Reopened PPTX does not contain title edit');
 if(reopened.textStyle?.color!=='#E85D04' && reopened.textStyle?.color!=='E85D04') throw new Error('Reopened PPTX does not contain color edit');
 report.checks.push('native-save','reopen-all-slides','persisted-title-edit','persisted-color-edit');
 report.status='passed';
}catch(error){report.status='failed';report.error=String(error?.stack||error)}
window.__nativePptxReport=report;
await fetch('/__native_acceptance/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
`
const coreResolver = {
  name: 'native-pptx-core-esm', enforce: 'pre',
  resolveId(source) {
    if (!source.startsWith('ooxml-core/')) return null
    const part = source.slice('ooxml-core/'.length).replace(/\.mjs$/, '')
    for (const candidate of [join(coreDist, part + '.mjs'), join(coreDist, part, 'index.mjs')]) if (existsSync(candidate)) return candidate
    return null
  }
}
const entry = join(output, 'harness-entry.mjs')
await writeFile(entry, client.replaceAll("'/node_modules/", `'${resolve('node_modules')}/`))
const bundled = await build({
  configFile: false, logLevel: 'error', resolve: { dedupe: ['zod'] }, plugins: [coreResolver],
  build: { target: 'esnext', outDir: join(output, 'harness'), emptyOutDir: true, minify: false, rollupOptions: { input: entry, output: { entryFileNames: 'client.js' } } }
})
const styles = bundled.output.filter(item => item.fileName.endsWith('.css')).map(item => `<link rel="stylesheet" href="/__native_acceptance/harness/${item.fileName}">`).join('')
html = `<!doctype html><html><head><meta charset="UTF-8"><title>Native PPTX acceptance</title>${styles}<style>html,body,#editor{height:100%;margin:0}</style></head><body><div id="editor"></div><script>window.__nativeBootErrors=[];addEventListener('error',e=>window.__nativeBootErrors.push(String(e.message)));addEventListener('unhandledrejection',e=>window.__nativeBootErrors.push(String(e.reason)))</script><script type="module" src="/__native_acceptance/harness/client.js"></script></body></html>`
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: [] },
  resolve: { dedupe: ['zod'] },
  plugins: [{
    name: 'native-pptx-acceptance',
    enforce: 'pre',
    resolveId(source) {
      if (!source.startsWith('ooxml-core/')) return null
      const part = source.slice('ooxml-core/'.length).replace(/\.mjs$/, '')
      for (const candidate of [join(coreDist, part + '.mjs'), join(coreDist, part, 'index.mjs')]) if (existsSync(candidate)) return candidate
      return null
    },
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        const path = request.url?.split('?')[0]
        if (path === '/__native_acceptance/index.html') { response.setHeader('Content-Type', 'text/html'); response.end(html); return }
        if (path?.startsWith('/__native_acceptance/harness/')) {
          const name = path.slice('/__native_acceptance/harness/'.length)
          if (name.includes('..') || name.startsWith('/')) { response.writeHead(400); response.end(); return }
          try { const bytes = await readFile(join(output, 'harness', name)); response.setHeader('Content-Type', name.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(bytes) } catch { response.writeHead(404); response.end() }
          return
        }
        if (path === '/__native_acceptance/input.pptx') { response.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'); response.end(inputBytes); return }
        if (path === '/__native_acceptance/output.pptx' || path === '/__native_acceptance/report') {
          const chunks = []; let size = 0
          for await (const chunk of request) { size += chunk.length; if (size > 200 * 1024 * 1024) { response.writeHead(413); response.end(); return }; chunks.push(chunk) }
          const bytes = Buffer.concat(chunks)
          if (path.endsWith('output.pptx')) { outputBytes = bytes; await writeFile(join(output, 'edited.pptx'), bytes) }
          else { reportReceived = true; resolveReport(JSON.parse(bytes.toString('utf8'))) }
          response.end('ok'); return
        }
        next()
      })
    }
  }],
  server: { host: '127.0.0.1', port: 0 }
})
await server.listen()
const port = server.httpServer.address().port
const chromePath = argument('--chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
const profile = await mkdtemp(join(tmpdir(), 'railwise-native-chrome-'))
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] })
let chromeLog = ''
chrome.stderr.on('data', (chunk) => { chromeLog = (chromeLog + chunk).slice(-20000) })
let socket
let report
try {
  const deadline = Date.now() + 30_000
  let devPort
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) throw new Error(`Chromium exited: ${chrome.exitCode}; ${chromeLog}`)
    try { devPort = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  if (!devPort) throw new Error('Chromium DevTools did not become available')
  const targets = await (await fetch(`http://127.0.0.1:${devPort}/json/list`)).json()
  const target = targets.find(item => item.type === 'page')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (message.id) { const handlers = pending.get(message.id); pending.delete(message.id); if (message.error) handlers?.reject(new Error(JSON.stringify(message.error))); else handlers?.resolve(message.result) } })
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })) })
  await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/__native_acceptance/index.html` })
  report = await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error('Native PPTX round-trip exceeded 150 seconds')), 150_000))])
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(output, 'native-viewer.png'), Buffer.from(shot.data, 'base64'))
} catch (error) {
  report = { status: 'failed', error: String(error?.stack || error), reportReceived, chromeLog }
} finally {
  socket?.close()
  chrome.kill('SIGTERM')
  await server.close()
}
report.source = { path: input, bytes: inputBytes.length, sha256: createHash('sha256').update(inputBytes).digest('hex'), slideCount: expectedPages }
report.editor = { name: 'pptx-vanilla-viewer', version: JSON.parse(await readFile(resolve('node_modules/pptx-vanilla-viewer/package.json'))).version }
report.output = output
if (outputBytes) report.outputSha256 = createHash('sha256').update(outputBytes).digest('hex')
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({ status: report.status, output, checks: report.checks, error: report.error }, null, 2))
process.exit(report.status === 'passed' ? 0 : 1)
