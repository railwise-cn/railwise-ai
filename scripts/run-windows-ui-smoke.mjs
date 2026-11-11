#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectInstalledPackage, installIdentity } from './verify-windows-install-smoke.mjs'

const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))
const requiredChecks = [
  'installed-chinese-renderer', 'skills-default-and-tab-order', 'plugins-tab',
  'connectors-tab', 'github-actionable-setup', 'no-update-control-hidden', 'offline-help-thirteen-chapters',
  'offline-help-search-and-navigation', 'offline-help-images', 'personal-homepage-absent'
]

export function windowsUiEnvironment(environment, root) {
  const clean = { ...environment }
  for (const name of Object.keys(clean)) {
    if (/SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|^(?:CSC_|APPLE_|R2_|S3_|WORKWISE_|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|RELEASE_CHANNEL)/i.test(name)) delete clean[name]
  }
  const home = join(root, 'home')
  return { ...clean, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'), WORKWISE_TOOLS_ROOT: join(home, '.workwise', 'tools') }
}

export function validateWindowsUiReport(report, identity) {
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.scope, 'private-exact-package-chinese-ui')
  assert.equal(report.platform, 'win32')
  assert.equal(report.sourceHead, identity.sourceHead)
  assert.equal(report.version, identity.version)
  assert.equal(report.locale, 'zh')
  assert.equal(report.theme, 'dark')
  assert.equal(report.productionTouched, false)
  assert.equal(report.packageUnchanged, true)
  assert.equal(report.cleanExit, true)
  assert.equal(report.errors.length, 0)
  assert.deepEqual(report.tabs, ['技能', '插件', '连接器'])
  assert.deepEqual(report.chapters, Array.from({ length: 13 }, (_, index) => index + 1))
  assert.equal(report.update.ok, true)
  assert.equal(report.update.hasUpdate, false)
  assert.equal(report.helpOffline, true)
  for (const check of requiredChecks) assert.ok(report.checks.includes(check), `Missing actual UI observation: ${check}`)
  return true
}

function contained(root, path) {
  const part = relative(root, path)
  return Boolean(part && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part))
}

async function availablePort() {
  const server = createServer()
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}

async function connectCdp(url) {
  const socket = new WebSocket(url)
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Installed renderer connection timed out')), 10_000)
    socket.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Installed renderer connection failed')) }, { once: true })
  })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`))
    else entry.done(message.result)
  })
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Installed renderer closed')) }
    pending.clear()
  })
  const send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 60_000)
    pending.set(id, { done, reject, timer, method })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value
  }
  const wait = async (expression, label, timeout = 30_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await evaluate(expression)
      if (value) return value
      await sleep(100)
    }
    throw new Error(`Installed UI did not show ${label}`)
  }
  const click = async (selector, label) => {
    const expression = `(() => {
      const candidates = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      const node = candidates.find(node => node.getClientRects().length && !node.disabled &&
        ${label ? `(node.textContent.trim() === ${JSON.stringify(label)} || node.getAttribute('aria-label') === ${JSON.stringify(label)} || node.querySelector('span')?.textContent.trim() === ${JSON.stringify(label)})` : 'true'});
      if (!node) return null;
      node.scrollIntoView({block:'center',inline:'center'});
      const bounds = node.getBoundingClientRect();
      const point = {x:bounds.x+bounds.width/2,y:bounds.y+bounds.height/2};
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || !node.contains(hit)) throw new Error('UI target is covered: ' + (node.getAttribute('aria-label') || node.textContent.trim()));
      return point;
    })()`
    const point = await wait(expression, label ?? selector)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  return { send, evaluate, wait, click, close: () => socket.close() }
}

export async function runWindowsUiSmoke({ executable, version, sourceHead, evidenceDir }) {
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
    throw new Error('Exact Windows UI smoke requires the existing clean GitHub-hosted Windows installation runner')
  }
  assert.equal(sourceHead, process.env.GITHUB_SHA)
  const temporary = resolve(process.env.RUNNER_TEMP)
  for (const path of [executable, evidenceDir]) assert.ok(contained(temporary, resolve(path)), 'Smoke paths must remain inside RUNNER_TEMP')
  assert.ok((await lstat(executable)).isFile())
  const identity = installIdentity(version, sourceHead)
  const before = inspectInstalledPackage(dirname(executable), identity)
  const root = await mkdtemp(join(temporary, 'railwise-windows-ui-'))
  const profile = join(root, 'profile')
  const workspace = join(root, 'workspace')
  const environment = windowsUiEnvironment(process.env, root)
  await Promise.all([profile, workspace, evidenceDir, environment.USERPROFILE, environment.APPDATA, environment.LOCALAPPDATA, environment.WORKWISE_TOOLS_ROOT].map(path => mkdir(path, { recursive: true })))
  const settingsPath = join(profile, 'workwise-settings.json')
  await writeFile(settingsPath, JSON.stringify({ schema: 'workwise.settings', version: 2, revision: 0,
    locale: 'zh', theme: 'dark', workspaceRoot: workspace, uiFontScale: 'small',
    appBehavior: { closeToTray: false, startMinimized: false, openAtLogin: false },
    agents: { kun: { autoStart: true, port: await availablePort(), dataDir: join(root, 'runtime') } } }))
  const report = { schemaVersion: 1, status: 'running', scope: 'private-exact-package-chinese-ui', platform: 'win32',
    sourceHead, version, locale: 'zh', theme: 'dark', productionTouched: false, checks: [], errors: [],
    installedAsarSha256: before.asarSha256, profile, cleanExit: false, packageUnchanged: false }
  // Electron's supported --user-data-dir overrides chrome::DIR_USER_DATA
  // before application startup. The installed EXE/ASAR and public identity
  // are used unchanged; candidate mode and updater overrides are absent.
  const child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--lang=zh-CN'],
    { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let launchError
  child.once('error', error => { launchError = error })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-50_000) })
  let cdp
  try {
    const deadline = Date.now() + 90_000
    while (!cdp && Date.now() < deadline) {
      if (launchError) throw launchError
      if (child.exitCode !== null) throw new Error(`Installed application exited before UI inspection (${child.exitCode})`)
      let port = output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]
      if (!port) {
        try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0] } catch { /* not yet ready */ }
      }
      if (port && /^\d+$/.test(port)) {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) }).then(response => response.json()).catch(() => [])
        const target = targets.find(item => item.type === 'page' && /^file:/.test(item.url) && /\/renderer\/index\.html(?:[?#]|$)/.test(item.url))
        if (target) cdp = await connectCdp(target.webSocketDebuggerUrl)
      }
      if (!cdp) await sleep(200)
    }
    if (!cdp) throw new Error('The installed application did not expose its packaged renderer')
    await cdp.wait(`Boolean(window.workwise?.getAppVersion && document.querySelector('button') && document.body.innerText.includes('技能与连接器'))`, 'Chinese navigation', 60_000)
    assert.equal(await cdp.evaluate('window.workwise.getAppVersion()'), version)
    const actualSettings = await cdp.evaluate(`window.workwise.getSettings().then(settings => ({locale:settings.locale,theme:settings.theme,workspaceRoot:settings.workspaceRoot}))`)
    assert.equal(actualSettings.locale, 'zh')
    assert.equal(actualSettings.theme, 'dark')
    assert.equal(actualSettings.workspaceRoot, workspace)
    report.viewport = await cdp.evaluate('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})')
    report.checks.push('installed-chinese-renderer')

    await cdp.click('button', '技能与连接器')
    report.tabs = await cdp.wait(`(() => { const tabs=Array.from(document.querySelectorAll('[role="tablist"][aria-label="技能与连接器分类"] [role="tab"]')); return tabs.length===3 && tabs.map(tab=>tab.textContent.trim()); })()`, 'marketplace tabs')
    assert.deepEqual(report.tabs, ['技能', '插件', '连接器'])
    assert.equal(await cdp.evaluate(`document.querySelector('[role="tablist"][aria-label="技能与连接器分类"] [aria-selected="true"]')?.textContent.trim()`), '技能')
    report.checks.push('skills-default-and-tab-order')
    await cdp.click('[role="tab"]', '插件')
    await cdp.wait(`document.querySelector('[role="tablist"][aria-label="技能与连接器分类"] [aria-selected="true"]')?.textContent.trim()==='插件'`, 'Plugins selected')
    report.checks.push('plugins-tab')
    await cdp.click('[role="tab"]', '连接器')
    await cdp.wait(`document.querySelector('[role="tablist"][aria-label="技能与连接器分类"] [aria-selected="true"]')?.textContent.trim()==='连接器' && document.body.innerText.includes('钉钉') && document.body.innerText.includes('飞书')`, 'native connector catalog')
    report.checks.push('connectors-tab')
    const connectorsScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(join(evidenceDir, 'windows-connectors-zh-dark.png'), Buffer.from(connectorsScreenshot.data, 'base64'))
    const connectionsBefore = await cdp.evaluate('window.workwise.listMcpServers().then(servers=>JSON.stringify(servers))')
    await cdp.click('button[aria-label="查看 GitHub MCP 连接详情"]')
    await cdp.wait(`document.querySelector('[role="dialog"][aria-label="GitHub 连接"] input[type="password"]') && document.body.innerText.includes('在 GitHub 创建令牌')`, 'actionable GitHub connection setup')
    assert.equal(await cdp.evaluate(`document.body.innerText.includes('这个 MCP 服务需要先配置 OAuth Client ID')`), false)
    assert.equal(await cdp.evaluate('window.workwise.listMcpServers().then(servers=>JSON.stringify(servers))'), connectionsBefore)
    report.checks.push('github-actionable-setup')
    await cdp.click('button[aria-label="关闭 GitHub 连接详情"]')

    const update = await cdp.evaluate('window.workwise.checkGuiUpdate()')
    report.update = { ok: update.ok, hasUpdate: update.hasUpdate, currentVersion: update.currentVersion, latestVersion: update.latestVersion, code: update.code }
    assert.equal(update.ok, true, 'The real updater metadata check must succeed')
    assert.equal(update.hasUpdate, false, 'This exact private target must have no newer published update')
    await cdp.wait(`window.workwise.getGuiUpdateState().then(state=>state.status==='not_available')`, 'no-update state')
    assert.equal(await cdp.evaluate(`document.querySelectorAll('button[title^="升级到"]').length`), 0)
    report.checks.push('no-update-control-hidden')

    // Help must continue to work without network. Only this renderer is put
    // offline; no API responses, application globals or DOM are substituted.
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
    report.helpOffline = true
    await cdp.click('button', '设置')
    await cdp.click('button', '帮助')
    report.chapters = await cdp.wait(`(() => { const headings=Array.from(document.querySelectorAll('[aria-label="用户使用手册"] .write-markdown-preview h2')); const numbers=headings.map(heading=>Number(/^(\\d+)\\./.exec(heading.textContent.trim())?.[1])).filter(Number.isInteger); return numbers.length===13 && numbers; })()`, 'the complete thirteen-chapter manual')
    assert.deepEqual(report.chapters, Array.from({ length: 13 }, (_, index) => index + 1))
    await cdp.wait(`document.querySelector('[aria-label="手册目录"]')?.innerText.includes('12. 版本更新')`, 'manual table of contents')
    report.checks.push('offline-help-thirteen-chapters')
    assert.equal(await cdp.evaluate(`Array.from(document.querySelectorAll('a,button')).some(node=>/个人主页|personal homepage/i.test(node.textContent))`), false)
    report.checks.push('personal-homepage-absent')
    await cdp.click('[aria-label="手册目录"] button', '1.4 现有界面截图')
    await cdp.wait(`Array.from(document.querySelectorAll('[aria-label="用户使用手册"] img')).some(image=>image.complete && image.naturalWidth>0)`, 'a packaged manual image offline')
    report.checks.push('offline-help-images')
    await cdp.click('input[aria-label="搜索帮助"]')
    await cdp.send('Input.insertText', { text: '版本更新' })
    await cdp.wait(`Array.from(document.querySelectorAll('[aria-label="帮助搜索结果"] button > span:first-child')).some(heading=>heading.textContent==='12. 版本更新')`, 'manual search results')
    await cdp.click('[aria-label="帮助搜索结果"] button', '12. 版本更新')
    await cdp.wait(`!document.querySelector('[aria-label="帮助搜索结果"]') && document.querySelector('[aria-label="用户使用手册"] .write-markdown-preview h2[id="12-版本更新"]')`, 'search result navigation')
    const updateHeading = await cdp.evaluate(`(() => { const heading=document.getElementById('12-版本更新'); const rect=heading.getBoundingClientRect(); return {top:rect.top,bottom:rect.bottom}; })()`)
    assert.ok(updateHeading.bottom > 0 && updateHeading.top < report.viewport.height, 'Search must scroll to the actual result heading')
    report.checks.push('offline-help-search-and-navigation')
    const helpScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(join(evidenceDir, 'windows-help-zh-dark.png'), Buffer.from(helpScreenshot.data, 'base64'))
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error))
  } finally {
    if (cdp) {
      await cdp.send('Page.close').catch(() => undefined)
      cdp.close()
    }
    const deadline = Date.now() + 30_000
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(200)
    report.cleanExit = child.exitCode === 0
    if (!report.cleanExit) {
      report.errors.push('The owned installed application did not exit cleanly')
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        // Kill only the process tree created by this smoke, never by name.
        const cleanup = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        await new Promise(done => { cleanup.once('error', done); cleanup.once('close', done) })
      }
    }
    report.packageUnchanged = inspectInstalledPackage(dirname(executable), identity).asarSha256 === before.asarSha256
    try { validateWindowsUiReport(report, identity); report.status = 'passed' } catch (error) {
      report.status = 'failed'
      if (!report.errors.length) report.errors.push(error.message)
    }
    await writeFile(join(evidenceDir, 'windows-ui-smoke.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
  if (report.status !== 'passed') throw new Error(`Exact Windows Chinese UI smoke failed: ${report.errors.join('; ')}`)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [executable, version, sourceHead, evidenceDir] = process.argv.slice(2)
  await runWindowsUiSmoke({ executable, version, sourceHead, evidenceDir })
}
