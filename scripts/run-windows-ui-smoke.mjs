#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectInstalledPackage, installIdentity, windowsSmokeProvenance } from './verify-windows-install-smoke.mjs'

const sleep = milliseconds => new Promise(done => setTimeout(done, milliseconds))
const requiredChecks = [
  'installed-chinese-renderer', 'skills-default-and-tab-order', 'plugins-tab',
  'connectors-tab', 'github-actionable-setup', 'no-update-control-hidden', 'offline-help-thirteen-chapters',
  'offline-help-search-and-navigation', 'offline-help-images', 'personal-homepage-absent',
  'packaged-skills-and-engineering-entries', 'amap-zotero-actionable-setup', 'autocad-fixed-upstream-entries'
]
const defaultSkillIds = ['ppt-master', 'tender-master', 'di-bao-monitoring']
const engineeringSkillNames = ['资料盘点与来源索引', '监测质检与图表', '工程文档差异审阅', '会议纪要与待办']
const cadEntries = [
  { id: 'autocad-dwg-redraw', name: 'AutoCAD DWG 重绘', dependencies: ['Python', 'AutoCAD', 'pywin32'] },
  { id: 'autocad-image-redraw', name: '图片转 CAD 重绘', dependencies: ['Python', 'AutoCAD', 'opencv-python-headless==4.14.0.94', 'ezdxf'] }
]
const cadCommit = 'ed182ec5966caaaf1d82d6ad4015435a27a8a909'
const asar = createRequire(import.meta.url)('@electron/asar')

export function validateDefaultSkillSources(skills) {
  return defaultSkillIds.map(id => {
    const skill = skills.find(skill => skill.id === id)
    assert.ok(skill, `Missing installed default Skill: ${id}`)
    const source = skill.source
    const auditedPptOverlay = id === 'ppt-master' && source?.type === 'github' &&
      source.owner === 'hugohe3' && source.repo === 'ppt-master' && source.ref === 'v6.8.0' &&
      source.installedSha === '5e8856be0da8e6bc85c4aa28acc614478f7b7137' &&
      source.overlaySkillId === 'ppt-master' && source.autoUpdate === false
    assert.ok(id === 'ppt-master' ? auditedPptOverlay : source?.type === 'bundled' && source.id === id, `Unverified default Skill source: ${id}`)
    return skill
  })
}

export function readonlyConnectorSetupExpression(connector) {
  const selector = `[role="dialog"][aria-label="${connector.name}"]`
  const ready = connector.id === 'amap-maps'
    ? `Boolean(drawer.querySelector('input[type="password"]'))&&drawer.innerText.includes('获取高德 Web 服务 Key')`
    : `drawer.innerText.includes('0.17.0')&&drawer.innerText.includes('MIT AND AGPL-3.0-or-later')&&drawer.innerText.includes('本机只读工具')&&Array.from(drawer.querySelectorAll('button')).some(button=>button.textContent.trim()==='审阅并安装'&&!button.disabled)`
  return `(() => { const drawer=document.querySelector(${JSON.stringify(selector)}); return Boolean(drawer && (${ready})); })()`
}

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
  assert.deepEqual(validateDefaultSkillSources(report.resources.defaultSkills).map(skill => skill.id), defaultSkillIds)
  for (const skill of report.resources.defaultSkills) {
    assert.equal(skill.entryRelativePath, `resources/app.asar.unpacked/src/asset/skills/${skill.id}/SKILL.md`)
    assert.match(skill.entrySha256, /^[a-f0-9]{64}$/)
    assert.equal(skill.entryRegisteredInAsar, true)
  }
  assert.deepEqual(report.resources.engineeringSkills.map(skill => skill.name), engineeringSkillNames)
  assert.ok(report.resources.engineeringSkills.every(skill => skill.installEnabled))
  assert.deepEqual(report.resources.connectors.map(connector => connector.id), ['amap-maps', 'zotero-mcp'])
  assert.ok(report.resources.connectors.every(connector => connector.detailsReady && connector.catalogSourceType === 'built-in'))
  assert.equal(report.resources.connectionsUnchanged, true)
  assert.deepEqual(report.resources.cad.map(item => item.id), cadEntries.map(item => item.id))
  for (const item of report.resources.cad) {
    assert.equal(item.catalogSourceType, 'built-in')
    assert.equal(item.commit, cadCommit)
    assert.equal(item.archiveSha256, '1981737a34085f1e9d1e9f9cb5a1d989b6bb75506f2d9b064bc20cda35239b0e')
    assert.equal(item.sourceUrl, `https://github.com/pengxiaoan/autocad-dwg-redraw-skill/tree/${cadCommit}/skills/${item.id}`)
    assert.equal(item.installEnabled, true)
    assert.equal(item.dependenciesVisible, true)
    assert.equal(item.licenseNoticeVisible, true)
  }
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
  const fill = async (selector, text) => {
    await click(selector)
    assert.ok(await evaluate(`document.activeElement?.matches(${JSON.stringify(selector)})`), 'The real resource search input must receive keyboard focus')
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 })
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    if (text) await send('Input.insertText', { text })
    await wait(`document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(text)}`, 'the typed resource query')
  }
  return { send, evaluate, wait, click, fill, close: () => socket.close() }
}

export async function runWindowsUiSmoke({ executable, version, sourceHead, evidenceDir }) {
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
    throw new Error('Exact Windows UI smoke requires the existing clean GitHub-hosted Windows installation runner')
  }
  const provenance = windowsSmokeProvenance(sourceHead)
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
    sourceHead, version, provenance, locale: 'zh', theme: 'dark', productionTouched: false, checks: [], errors: [],
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
    // Read the installed application's built-in catalog and wait for its actual
    // rendered entries. Remote connector checks are not a readiness signal.
    const localCatalog = await cdp.evaluate(`Promise.all([window.workwise.listCatalogSources(),window.workwise.listCatalogPackages()]).then(([sources,catalog]) =>
      catalog.packages.filter(entry=>['amap-maps','zotero-mcp','autocad-dwg-redraw','autocad-image-redraw'].includes(entry.package.id)).map(entry=>({
        id:entry.package.id,name:entry.package.name,catalogSourceType:sources.find(source=>source.id===entry.sourceId)?.type,
        commit:entry.package.source.resolvedRef,sourceUrl:entry.package.source.location,archiveSha256:entry.package.source.digest?.value
      })))`)
    assert.equal(localCatalog.length, 4)
    assert.ok(localCatalog.every(entry => entry.catalogSourceType === 'built-in'))
    await cdp.wait(`['AutoCAD DWG 重绘','图片转 CAD 重绘'].every(name=>Array.from(document.querySelectorAll('section[aria-label="发现技能"] [role="button"] .truncate')).some(node=>node.textContent.trim()===name))`, 'both locally cataloged CAD skills', 60_000)
    report.resources = { defaultSkills: [], engineeringSkills: [], connectors: [], cad: [], connectionsUnchanged: false }
    report.resources.engineeringSkills = await cdp.evaluate(`Array.from(document.querySelectorAll('section[aria-label="工程技能"] article')).map(article=>({
      name:article.querySelector('h3')?.textContent.trim(),installEnabled:Array.from(article.querySelectorAll('button')).some(button=>button.textContent.trim()==='安装'&&!button.disabled)
    }))`)
    assert.deepEqual(report.resources.engineeringSkills.map(skill => skill.name), engineeringSkillNames)
    assert.ok(report.resources.engineeringSkills.every(skill => skill.installEnabled))
    const skills = await cdp.evaluate(`window.workwise.listSkills().then(result=>result.ok?result.skills.map(skill=>({id:skill.id,name:skill.name,root:skill.root,entryPath:skill.entryPath,
      source:skill.source&&{type:skill.source.type,id:skill.source.id,owner:skill.source.owner,repo:skill.source.repo,ref:skill.source.ref,
        installedSha:skill.source.installedSha,overlaySkillId:skill.source.overlaySkillId,autoUpdate:skill.source.autoUpdate}})):[])`)
    report.resources.defaultSkills = skills.filter(skill => defaultSkillIds.includes(skill.id))
    const defaultSkills = validateDefaultSkillSources(skills)
    for (const skill of defaultSkills) {
      const entry = `src/asset/skills/${skill.id}/SKILL.md`
      const expectedRoot = join(dirname(executable), 'resources', 'app.asar.unpacked', 'src', 'asset', 'skills', skill.id)
      assert.equal(resolve(skill.root).toLowerCase(), expectedRoot.toLowerCase())
      assert.equal(resolve(skill.entryPath).toLowerCase(), join(expectedRoot, 'SKILL.md').toLowerCase())
      const entryBytes = await readFile(skill.entryPath)
      assert.ok(entryBytes.equals(asar.extractFile(join(dirname(executable), 'resources', 'app.asar'), entry)))
      skill.entryRelativePath = relative(dirname(executable), skill.entryPath).replaceAll('\\', '/')
      skill.entrySha256 = createHash('sha256').update(entryBytes).digest('hex')
      skill.entryRegisteredInAsar = true
      await cdp.fill('input[placeholder*="已索引"]', skill.name || skill.id)
      await cdp.wait(`document.body.innerText.includes(${JSON.stringify(skill.root)}) && Array.from(document.querySelectorAll('main .truncate')).some(node=>node.textContent.trim()===${JSON.stringify(skill.name || skill.id)})`, `${skill.id} in its actual local package directory`)
    }
    await cdp.fill('input[placeholder*="已索引"]', '')
    await cdp.wait(`['AutoCAD DWG 重绘','图片转 CAD 重绘'].every(name=>Array.from(document.querySelectorAll('section[aria-label="发现技能"] [role="button"] .truncate')).some(node=>node.textContent.trim()===name))`, 'the catalog after clearing the local Skill search')
    report.resources.defaultSkills = defaultSkills
    report.checks.push('packaged-skills-and-engineering-entries')
    for (const expected of cadEntries) {
      await cdp.click('section[aria-label="发现技能"] [role="button"] .truncate', expected.name)
      const observation = await cdp.wait(`(() => {
        const drawer=Array.from(document.querySelectorAll('aside')).find(node=>node.querySelector('header h2')?.textContent.trim()===${JSON.stringify(expected.name)});
        if(!drawer)return null;
        const text=drawer.innerText;
        return {installEnabled:Array.from(drawer.querySelectorAll('button')).some(button=>button.textContent.trim()==='从上游安装'&&!button.disabled),
          dependenciesVisible:${JSON.stringify(expected.dependencies)}.every(value=>text.includes(value)),
          licenseNoticeVisible:text.includes('上游未声明许可证'),versionVisible:text.includes(${JSON.stringify(cadCommit)}),publisherVisible:text.includes('pengxiaoan')};
      })()`, `${expected.name} source, install entry and dependencies`)
      assert.ok(observation.installEnabled && observation.dependenciesVisible && observation.licenseNoticeVisible && observation.versionVisible && observation.publisherVisible)
      report.resources.cad.push({ ...localCatalog.find(item => item.id === expected.id), ...observation })
      if (expected.id === 'autocad-dwg-redraw') {
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        await writeFile(join(evidenceDir, 'windows-cad-details-zh-dark.png'), Buffer.from(screenshot.data, 'base64'))
      }
      // The generic package drawer supports dismissal through its backdrop.
      await cdp.click('div.fixed.inset-0.z-40:has(> aside > header > h2)')
      await cdp.wait(`!Array.from(document.querySelectorAll('aside')).some(node=>node.querySelector('header h2')?.textContent.trim()===${JSON.stringify(expected.name)})`, 'package drawer dismissed')
    }
    report.checks.push('autocad-fixed-upstream-entries')
    await cdp.click('[role="tab"]', '插件')
    await cdp.wait(`document.querySelector('[role="tablist"][aria-label="技能与连接器分类"] [aria-selected="true"]')?.textContent.trim()==='插件'`, 'Plugins selected')
    report.checks.push('plugins-tab')
    await cdp.click('[role="tab"]', '连接器')
    await cdp.wait(`document.querySelector('[role="tablist"][aria-label="技能与连接器分类"] [aria-selected="true"]')?.textContent.trim()==='连接器' && document.body.innerText.includes('钉钉') && document.body.innerText.includes('飞书')`, 'native connector catalog')
    await cdp.wait(`['查看 高德地图 连接详情','查看 Zotero 本机文献 连接详情'].every(label=>Array.from(document.querySelectorAll('button')).some(button=>button.getAttribute('aria-label')===label&&!button.disabled))`, 'the loaded local Amap and Zotero catalog entries', 60_000)
    report.checks.push('connectors-tab')
    const connectorsScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(join(evidenceDir, 'windows-connectors-zh-dark.png'), Buffer.from(connectorsScreenshot.data, 'base64'))
    const connectionsBefore = await cdp.evaluate('window.workwise.listMcpServers().then(servers=>JSON.stringify(servers))')
    for (const connector of [{ id: 'amap-maps', name: '高德地图' }, { id: 'zotero-mcp', name: 'Zotero 本机文献' }]) {
      await cdp.click(`button[aria-label="查看 ${connector.name} 连接详情"]`)
      const detailsReady = await cdp.wait(readonlyConnectorSetupExpression(connector), `${connector.name} actionable local setup details`)
      report.resources.connectors.push({ ...localCatalog.find(item => item.id === connector.id), detailsReady })
      const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      await writeFile(join(evidenceDir, `windows-${connector.id}-details-zh-dark.png`), Buffer.from(screenshot.data, 'base64'))
      await cdp.click('button[aria-label="关闭连接详情"]')
    }
    report.resources.connectionsUnchanged = await cdp.evaluate('window.workwise.listMcpServers().then(servers=>JSON.stringify(servers))') === connectionsBefore
    assert.equal(report.resources.connectionsUnchanged, true)
    report.checks.push('amap-zotero-actionable-setup')
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
    await cdp.click('.ds-settings-sidebar nav button', '帮助')
    report.chapters = await cdp.wait(`(() => { const headings=Array.from(document.querySelectorAll('[aria-label="用户使用手册"] .write-markdown-preview h2')); const numbers=headings.map(heading=>Number(/^(\\d+)\\./.exec(heading.textContent.trim())?.[1])).filter(Number.isInteger); return numbers.length===13 && numbers; })()`, 'the complete thirteen-chapter manual')
    assert.deepEqual(report.chapters, Array.from({ length: 13 }, (_, index) => index + 1))
    await cdp.wait(`document.querySelector('[aria-label="手册目录"]')?.innerText.includes('12. 版本更新')`, 'manual table of contents')
    report.checks.push('offline-help-thirteen-chapters')
    assert.equal(await cdp.evaluate(`Array.from(document.querySelectorAll('a,button')).some(node=>/个人主页|personal homepage/i.test(node.textContent))`), false)
    report.checks.push('personal-homepage-absent')
    // Search before anchor navigation, which can finish an asynchronous
    // diagram hydration scroll after a previously calculated click point.
    let searchFocused = false
    for (let attempt = 0; attempt < 3 && !searchFocused; attempt++) {
      await cdp.click('input[aria-label="搜索帮助"]')
      searchFocused = await cdp.evaluate(`document.activeElement?.matches('input[aria-label="搜索帮助"]')`)
      if (!searchFocused) await sleep(100)
    }
    assert.ok(searchFocused, 'The real help search input must receive keyboard focus')
    await cdp.send('Input.insertText', { text: '版本更新' })
    await cdp.wait(`document.querySelector('input[aria-label="搜索帮助"]')?.value === '版本更新'`, 'the typed search query')
    await cdp.wait(`Array.from(document.querySelectorAll('[aria-label="帮助搜索结果"] button > span:first-child')).some(heading=>heading.textContent==='12. 版本更新')`, 'manual search results')
    await cdp.click('[aria-label="帮助搜索结果"] button', '12. 版本更新')
    await cdp.wait(`!document.querySelector('[aria-label="帮助搜索结果"]') && document.querySelector('[aria-label="用户使用手册"] .write-markdown-preview h2[id="12-版本更新"]')`, 'search result navigation')
    const updateHeading = await cdp.evaluate(`(() => { const heading=document.getElementById('12-版本更新'); const rect=heading.getBoundingClientRect(); return {top:rect.top,bottom:rect.bottom}; })()`)
    assert.ok(updateHeading.bottom > 0 && updateHeading.top < report.viewport.height, 'Search must scroll to the actual result heading')
    report.checks.push('offline-help-search-and-navigation')
    const helpScreenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await writeFile(join(evidenceDir, 'windows-help-zh-dark.png'), Buffer.from(helpScreenshot.data, 'base64'))
    await cdp.click('[aria-label="手册目录"] button', '1.4 现有界面截图')
    await cdp.wait(`Array.from(document.querySelectorAll('[aria-label="用户使用手册"] img')).some(image=>image.complete && image.naturalWidth>0)`, 'a packaged manual image offline')
    report.checks.push('offline-help-images')
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error))
    if (cdp) {
      try {
        const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
        await writeFile(join(evidenceDir, 'windows-ui-failure.png'), Buffer.from(screenshot.data, 'base64'))
        report.failureObservation = await cdp.evaluate(`({
          helpVisible: Boolean(document.querySelector('[aria-label="用户使用手册"]')),
          searchValue: document.querySelector('input[aria-label="搜索帮助"]')?.value,
          focusedElement: {tag:document.activeElement?.tagName,label:document.activeElement?.getAttribute('aria-label')},
          activeMenus: Array.from(document.querySelectorAll('[role="menu"]')).map(menu => menu.getAttribute('aria-label')),
          headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(heading => heading.textContent.trim())
        })`)
      } catch { /* Preserve the original UI failure if its renderer has closed. */ }
    }
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
