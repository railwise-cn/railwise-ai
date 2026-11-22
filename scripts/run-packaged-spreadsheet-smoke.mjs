import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { installExactNsis, powershell, psQuote, ownedInstallState, registryState } from './run-windows-published-gui-update-smoke.mjs'
import { inspectInstaller, inspectInstalledPackage, installIdentity } from './verify-windows-install-smoke.mjs'
import { windowsUiEnvironment } from './run-windows-ui-smoke.mjs'
import { parse } from 'yaml'

const require = createRequire(import.meta.url)
const qaFiles = new Set(['.github/workflows/windows-install-smoke.yml', 'scripts/run-packaged-spreadsheet-smoke.mjs'])
const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const platform = isWindows ? 'win' : 'mac'
const command = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const json = path => readFile(path, 'utf8').then(JSON.parse)
const git = (...args) => command('git', args)
const asarPackage = path => JSON.parse(require('@electron/asar').extractFile(path, 'package.json').toString('utf8'))

async function digest(path, algorithm = 'sha256', encoding = 'hex') {
  const hash = createHash(algorithm)
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest(encoding)
}

const sha256 = path => digest(path)

function verifyHostedRunner(expectedArch) {
  assert.ok(isWindows || isMac)
  assert.equal(process.arch, expectedArch)
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.RUNNER_OS, isWindows ? 'Windows' : 'macOS')
  assert.ok(process.env.RUNNER_TEMP)
}

async function prepareExactSource(runId) {
  assert.match(runId, /^[1-9]\d*$/)
  const repository = process.env.GITHUB_REPOSITORY
  assert.equal(repository, 'railwise-cn/railwise-ai')
  const api = path => JSON.parse(command('gh', ['api', 'repos/' + repository + '/' + path]))
  const run = api('actions/runs/' + runId)
  assert.equal(run.path, '.github/workflows/release.yml')
  assert.equal(run.repository.full_name, repository)
  assert.equal(run.head_repository.full_name, repository)
  assert.equal(run.event, 'workflow_dispatch')
  assert.equal(run.conclusion, 'success')
  assert.match(run.head_sha, /^[a-f0-9]{40}$/)
  git('merge-base', '--is-ancestor', run.head_sha, 'HEAD')
  const files = git('diff', '--name-only', run.head_sha, 'HEAD').split('\n').filter(Boolean)
  assert.ok(files.length && files.every(file => qaFiles.has(file)), 'Application source differs from the freeze')
  const jobs = api('actions/runs/' + runId + '/attempts/' + run.run_attempt + '/jobs?per_page=100')
  const build = jobs.jobs.find(entry => entry.name === (isWindows ? 'Build Windows' : 'Build macOS'))
  assert.equal(build?.conclusion, 'success')
  assert.equal(jobs.jobs.find(entry => entry.name === 'Publish GitHub Release')?.conclusion, 'skipped')
  const artifacts = api('actions/runs/' + runId + '/artifacts?per_page=100')
  const name = 'release-' + platform
  const [artifact, duplicate] = artifacts.artifacts.filter(entry => entry.name === name && !entry.expired)
  assert.ok(artifact && !duplicate)
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(artifact.workflow_run.head_sha, run.head_sha)
  assert.equal(artifact.workflow_run.id, run.id)
  const version = JSON.parse(git('show', `${run.head_sha}:package.json`)).version
  assert.match(version, /^\d+\.\d+\.\d+$/)
  return { repository, version, runId: Number(runId), runAttempt: run.run_attempt, sourceHead: run.head_sha,
    driverHead: git('rev-parse', 'HEAD'), changedFiles: files, artifactId: artifact.id, artifactDigest: artifact.digest, artifactName: name }
}

async function downloadExactPackage(directory, source, report) {
  await mkdir(directory)
  const archive = join(directory, 'package.zip')
  const output = await open(archive, 'wx', 0o600)
  try {
    execFileSync('gh', ['api', '--hostname', 'github.com',
      `repos/${source.repository}/actions/artifacts/${source.artifactId}/zip`],
    { stdio: ['ignore', output.fd, 'pipe'], timeout: 10 * 60_000 })
  } finally { await output.close() }
  const archiveDigest = 'sha256:' + await sha256(archive)
  assert.equal(archiveDigest, source.artifactDigest)
  const { version } = source
  const metadataName = isWindows ? 'latest.yml' : 'latest-mac.yml'
  const fileName = isWindows ? `RailWise-AI-${version}-win-x64.exe` : `RailWise-AI-${version}-mac-${process.arch}.dmg`
  const list = command('tar', ['-tf', archive]).split(/\r?\n/)
  for (const member of [fileName, metadataName]) assert.equal(list.filter(name => name === member).length, 1)
  command('tar', ['-xf', archive, '-C', directory, fileName, metadataName])
  const path = join(directory, fileName)
  const metadata = parse(await readFile(join(directory, metadataName), 'utf8'))
  assert.equal(metadata.version, version)
  const record = metadata.files.find(file => file.url === fileName)
  assert.equal(record?.sha512, await digest(path, 'sha512', 'base64'))
  assert.equal((await stat(path)).size, record?.size)
  report.installer = { name: fileName, sha256: await sha256(path), bytes: record.size, archiveDigest }
  return path
}

async function findInstallation(path, root, source, report) {
  const { version } = source
  if (isWindows) {
    const identity = installIdentity(version, source.sourceHead)
    inspectInstaller(path, identity)
    const install = join(root, 'installed')
    assert.deepEqual(registryState(), [], 'The ephemeral runner must start without a public RailWise installation')
    installExactNsis(path, install)
    const registry = ownedInstallState(install, version)
    const executable = join(install, identity.executableName)
    const metadata = inspectInstalledPackage(install, identity)
    const getSignature = target => powershell('(Get-AuthenticodeSignature -LiteralPath ' + psQuote(target) + ').Status.ToString()')
    const installerSignature = getSignature(path)
    const executableSignature = getSignature(executable)
    for (const signature of [installerSignature, executableSignature]) assert.ok(['Valid', 'NotSigned'].includes(signature))
    report.installed = { version: metadata.version, sourceHead: metadata.sourceHead, asarSha256: metadata.asarSha256,
      asarSize: metadata.asarSize, installerSignature, executableSignature, registryVersion: registry.displayVersion }
    return { executable, asar: join(install, 'resources', 'app.asar'), cleanup: () => {
      ownedInstallState(install, version)
      powershell('Start-Process -FilePath ' + psQuote(join(install, identity.uninstallerName)) + " -ArgumentList '/S /currentuser' -Wait")
    } }
  }
  const mount = join(root, 'mount')
  await mkdir(mount)
  command('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, path])
  const install = join(root, 'RailWise AI.app')
  try {
    command('/usr/bin/ditto', [join(mount, 'RailWise AI.app'), install])
  } finally { command('/usr/bin/hdiutil', ['detach', mount]) }
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', install])
  command('/usr/bin/xcrun', ['stapler', 'validate', install])
  const info = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(install, 'Contents', 'Info.plist')]))
  const asar = join(install, 'Contents', 'Resources', 'app.asar')
  const meta = asarPackage(asar)
  const executable = join(install, 'Contents', 'MacOS', info.CFBundleExecutable)
  const executableArchitecture = command('/usr/bin/lipo', ['-archs', executable]).split(' ')
  assert.deepEqual(executableArchitecture, [process.arch === 'x64' ? 'x86_64' : 'arm64'])
  assert.equal(info.CFBundleShortVersionString, version)
  assert.equal(info.CFBundleIdentifier, 'com.wangjiawei508.workgpt')
  assert.equal(meta.version, version)
  assert.equal(meta.buildProvenance?.sourceHead, source.sourceHead)
  report.installed = { version, sourceHead: source.sourceHead,
    bundleId: info.CFBundleIdentifier, asarSha256: await sha256(asar),
    asarSize: (await stat(asar)).size, signature: 'verified', notarization: 'staple-verified' }
  return { executable, asar }
}

async function until(label, callable, milliseconds = 25_000) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    const value = await callable()
    if (value) return value
    await wait(120)
  }
  throw new Error('Timed out waiting for ' + label)
}

async function cdpConnect(url, report) {
  const ws = new WebSocket(url)
  await Promise.race([once(ws, 'open'), wait(10_000).then(() => { throw new Error('CDP connection timed out') })])
  const pending = new Map()
  let sequence = 0
  const send = (method, params = {}) => new Promise((ok, fail) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); fail(new Error('CDP timed out for ' + method)) }, 12_000)
    pending.set(id, { ok, fail, timer })
    ws.send(JSON.stringify({ id, method, params }))
  })
  ws.addEventListener('message', event => {
    const data = JSON.parse(event.data)
    const call = pending.get(data.id)
    if (call) {
      pending.delete(data.id)
      clearTimeout(call.timer)
      if (data.error) call.fail(new Error(data.error.message))
      else call.ok(data.result)
    } else if (data.method === 'Fetch.requestPaused') {
      report.blockedRendererRequests++
      void send('Fetch.failRequest', { requestId: data.params.requestId, errorReason: 'BlockedByClient' })
        .catch(() => undefined)
    } else if (data.method === 'Runtime.exceptionThrown') report.rendererExceptions++
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  await send('Runtime.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: 'http*' }] })
  return { send, evaluate, close: () => ws.close() }
}

async function withOwnedApplication(install, root, report, verify) {
  const workspace = join(root, '工程测量验收')
  const profile = join(root, 'profile')
  const runtime = join(root, 'runtime')
  const home = join(root, 'home')
  const baseEnvironment = isWindows ? windowsUiEnvironment(process.env, root) : {
    PATH: process.env.PATH, HOME: home, TMPDIR: root, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
    LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8'
  }
  const cache = join(root, 'cache')
  const logs = join(root, 'logs')
  const environment = {
    ...baseEnvironment,
    WORKWISE_CANDIDATE: '1', WORKWISE_CANDIDATE_ROOT: root, WORKWISE_CANDIDATE_USER_DATA: profile,
    WORKWISE_CANDIDATE_CACHE: cache, WORKWISE_CANDIDATE_LOGS: logs, WORKWISE_CANDIDATE_HOME: home,
    WORKWISE_CANDIDATE_OUTBOUND_DISABLED: '1', WORKWISE_CANDIDATE_INBOUND_DISABLED: '1', WORKWISE_CANDIDATE_CREDENTIAL_ACCESS: '0',
  }
  for (const directory of [workspace, profile, runtime, home, cache, logs, environment.APPDATA, environment.LOCALAPPDATA].filter(Boolean)) {
    await mkdir(directory, { recursive: true })
  }
  await writeFile(join(profile, 'workwise-settings.json'), JSON.stringify({
    schema: 'workwise.settings', version: 2, revision: 0, locale: 'zh', theme: 'light', workspaceRoot: workspace,
    appBehavior: { closeToTray: false, startMinimized: false, openAtLogin: false },
    agents: { kun: { autoStart: false, dataDir: runtime, port: 58931 } }
  }))
  const child = spawn(install.executable, [
    '--user-data-dir=' + profile, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--lang=zh-CN', '--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>'
  ], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  let launchError
  child.once('error', error => { launchError = error })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-5000) })
  let cdp
  try {
    const socket = await until('owned packaged renderer', async () => {
      if (launchError) throw launchError
      if (child.exitCode !== null) throw new Error('Packaged application exited before connecting')
      const port = log.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]
        ?? await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then(text => text.split('\n')[0]).catch(() => '')
      if (!/^\d+$/.test(port)) return
      const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then(response => response.json()).catch(() => [])
      const renderer = realpath(install.asar).then(path => join(path, 'out', 'renderer', 'index.html'))
      const expected = await renderer
      const normalize = path => isWindows ? resolve(path).toLowerCase() : resolve(path)
      return targets.find(target => target.type === 'page' && target.url?.startsWith('file:') &&
        normalize(fileURLToPath(target.url)) === normalize(expected) &&
        target.webSocketDebuggerUrl?.startsWith('ws://127.0.0.1:' + port + '/'))?.webSocketDebuggerUrl
    }, 75_000)
    cdp = await cdpConnect(socket, report)
    return await verify(cdp, workspace)
  } catch (error) {
    report.rendererEndState = await cdp?.evaluate('document.body.innerText.slice(-1200)').catch(() => undefined)
    throw error
  } finally {
    cdp?.close()
    child.kill('SIGTERM')
    await Promise.race([once(child, 'exit'), wait(6000)]).catch(() => undefined)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

async function validateWorkbook(cdp, workspace, root, report, evidenceDir) {
  const { send, evaluate } = cdp
  const clickButton = text => evaluate('Array.from(document.querySelectorAll("button")).find(button=>button.innerText===' +
    JSON.stringify(text) + ')?.click()')
  const ui = (label, expression, timeout) => until(label, () => evaluate(expression), timeout)
  const workbookReady = 'Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="保存表格"&&!b.disabled)'
  const openWorkbook = path => evaluate('window.dispatchEvent(new CustomEvent("kun:workspace-file-preview", {detail:{workspaceRoot:' +
    JSON.stringify(workspace) + ',path:' + JSON.stringify(path) + '}}))')
  const fixture = new (require('jszip'))()
  fixture.file('xl/workbook.xml', '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="工程监测" r:id="s1"/><sheet name="复核记录" r:id="s2"/></sheets></workbook>')
  fixture.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="s1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="s2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
  fixture.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="4"><c r="B4" t="inlineStr"><is><t>点位001</t></is></c><c r="D4"><f>3*4</f><v>12</v></c></row></sheetData></worksheet>')
  fixture.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="2"><c r="A2" t="inlineStr"><is><t>已复核</t></is></c></row></sheetData></worksheet>')
  const excel = join(workspace, '监测.xlsx')
  await writeFile(excel, await fixture.generateAsync({ type: 'nodebuffer' }))
  const excelHash = await sha256(excel)
  const csv = join(root, '监测导入.csv')
  await writeFile(csv, '\uFEFF点位,位移\r\n001,"4.20"\r\n')
  await ui('Chinese new workbook action', 'Boolean(document.querySelector(\'[aria-label="新建表格"]\'))')
  assert.equal(await evaluate('window.workwise.getAppVersion()'), report.source.version)
  assert.equal(await evaluate('window.workwise.getSettings().then(settings => settings.locale)'), 'zh')
  assert.equal(await evaluate('document.querySelector(\'[aria-label="打开表格"]\')?.tagName'), 'BUTTON')
  const start = Date.now()
  await evaluate('document.querySelector(\'[aria-label="新建表格"]\').click()')
  const grid = '[...document.querySelectorAll("canvas")].map(c=>c.getBoundingClientRect().toJSON()).find(box=>box.width>200&&box.height>150)'
  await ui('sized native spreadsheet canvas', workbookReady + ' && (' + grid + ')')
  report.firstOpenMs = Date.now() - start
  report.checks.push('native-create-and-render')
  const save = () => clickButton('保存表格')
  const filename = (await readdir(workspace)).find(name => name.endsWith('.rwsheet'))
  assert.ok(filename)
  const original = join(workspace, filename)
  const workbook = async path => {
    const saved = await json(path)
    assert.equal(saved.version, 1)
    return saved.workbook
  }
  const cell = (book, row, column) => book.sheets[book.sheetOrder[0]].cellData?.[row]?.[column]
  const key = async (key, code, windowsVirtualKeyCode, modifiers = 0) => {
    const event = { key, code, windowsVirtualKeyCode, modifiers }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }
  const clickCell = async (row, column, count = 1) => {
    const canvas = await ui('visible canvas for cell selection', grid)
    const point = { x: canvas.x + 68 + column * 79, y: canvas.y + 30 + row * 22, button: 'left' }
    for (let clickCount = 1; clickCount <= count; clickCount++) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', clickCount, ...point })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', clickCount, ...point })
    }
  }
  const edit = async (row, column, text) => {
    await clickCell(row, column, 2)
    await send('Input.insertText', { text })
    await key('Enter', 'Enter', 13)
  }
  await edit(0, 0, '=SUM(4,5)')
  await wait(300)
  await save()
  report.formula = await until('saved live calculated formula', async () => {
    const current = cell(await workbook(original), 0, 0)
    return current?.f === '=SUM(4,5)' && current.v === 9 && { expression: current.f, value: current.v }
  })
  report.checks.push('canvas-formula-calculated-and-persisted')
  await edit(0, 1, '撤销前')
  await wait(200)
  await save()
  await until('saved text before undo', async () => cell(await workbook(original), 0, 1)?.v === '撤销前')
  await clickCell(1, 1)
  await key('z', 'KeyZ', 90, isWindows ? 2 : 4)
  await wait(200)
  await save()
  await until('undo retained formula and removed later text', async () => {
    const book = await workbook(original)
    return cell(book, 0, 0)?.v === 9 && cell(book, 0, 1)?.v !== '撤销前'
  })
  report.checks.push('platform-keyboard-undo-restored-previous-values')

  await edit(0, 1, '保留未保存修改')
  await wait(200)
  const external = await json(original)
  external.workbook.name = '同时被外部程序修改'
  const externalBytes = JSON.stringify(external)
  await writeFile(original, externalBytes)
  await save()
  const copyLabel = await ui('save conflict copy input', 'document.querySelector(\'input[aria-label="新文件名"]\')?.value')
  assert.match(copyLabel, /^[^/\\]+副本$/)
  const copyName = copyLabel + '.rwsheet'
  const copy = join(workspace, copyName)
  assert.equal(await readFile(original, 'utf8'), externalBytes)
  await clickButton('保存副本')
  await ui('copy saved', 'document.body.innerText.includes(' + JSON.stringify('已保存 · ' + copyName) + ')')
  const copied = await workbook(copy)
  assert.equal(cell(copied, 0, 0)?.v, 9)
  assert.equal(cell(copied, 0, 1)?.v, '保留未保存修改')
  assert.equal(await readFile(original, 'utf8'), externalBytes)
  report.checks.push('external-modification-conflict-original-unchanged-copy-retains-edits')

  const rootNode = (await send('DOM.getDocument')).root.nodeId
  const input = (await send('DOM.querySelector', { nodeId: rootNode, selector: 'input[accept=".csv,text/csv"]' })).nodeId
  await send('DOM.setFileInputFiles', { nodeId: input, files: [csv] })
  await ui('Chinese CSV import', 'document.body.innerText.includes("已导入 · 监测导入")')
  const downloads = join(root, 'downloads')
  await mkdir(downloads)
  await send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads })
  await clickButton('导出当前表为 CSV')
  report.csvExportBytes = await until('exported Chinese CSV with leading zero', async () => {
    const name = (await readdir(downloads)).find(file => file.endsWith('.csv'))
    if (!name) return false
    const text = await readFile(join(downloads, name), 'utf8')
    return text.includes('点位,位移') && text.includes('001,4.20') && Buffer.byteLength(text)
  })
  await save()
  await ui('checked workbook save', 'document.body.innerText.includes("已保存 · ")')
  const saved = await until('copy contains two saved sheets', async () => {
    const book = await workbook(copy)
    return book.sheetOrder.length === 2 && book
  })
  assert.equal(cell(saved, 0, 0)?.v, 9)
  const imported = Object.values(saved.sheets).find(sheet => sheet.name === '监测导入')
  assert.equal(imported.cellData[1][0].v, '001')
  assert.equal(imported.cellData[1][1].v, '4.20')
  report.checks.push('chinese-csv-import-export-leading-zero-two-sheets-save')
  await openWorkbook(excel)
  await ui('read-only Excel grid with both sheet names', 'document.body.innerText.includes("工程监测")&&document.body.innerText.includes("复核记录")&&document.body.innerText.includes("只读预览")&&document.body.innerText.includes("在系统应用打开")&&document.querySelectorAll("canvas").length>0')
  const xlsx = await evaluate('window.workwise.openSpreadsheet(' + JSON.stringify({ path: excel, workspaceRoot: workspace }) + ')')
  assert.equal(xlsx.kind, 'xlsx')
  report.excelOriginalSha256 = excelHash
  assert.equal(await sha256(excel), excelHash)
  report.checks.push('xlsx-read-only-multiple-sheets-original-unchanged')
  await openWorkbook(copy)
  await ui('reopened workbook', workbookReady + ' && document.body.innerText.includes("监测导入")')
  const reopened = await evaluate('window.workwise.openSpreadsheet(' + JSON.stringify({ path: copy, workspaceRoot: workspace }) + ')')
  assert.equal(reopened.kind, 'workbook')
  assert.equal(cell(JSON.parse(reopened.content).workbook, 0, 0)?.v, 9)
  assert.equal(await readFile(original, 'utf8'), externalBytes)
  report.checks.push('existing-workbook-reopened')
  const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(evidenceDir, 'spreadsheet.png'), Buffer.from(screenshot.data, 'base64'))
}

async function main([runId, evidenceDir, expectedArch]) {
  verifyHostedRunner(expectedArch)
  const runnerTemp = resolve(process.env.RUNNER_TEMP)
  const desc = relative(runnerTemp, resolve(evidenceDir))
  assert.ok(desc && !desc.startsWith('..') && !isAbsolute(desc))
  const root = await mkdtemp(join(runnerTemp, 'railwise-exact-sheets-'))
  await mkdir(evidenceDir, { recursive: true })
  const report = { schemaVersion: 1, status: 'running', platform: process.platform, arch: process.arch,
    runId, runner: process.env.RUNNER_ENVIRONMENT, locale: 'zh', theme: 'light',
    network: 'Application outbound disabled, Chromium HTTP proxy refused and renderer HTTP blocked with CDP',
    blockedRendererRequests: 0, rendererExceptions: 0, checks: [] }
  let install
  try {
    const source = await prepareExactSource(runId)
    assert.equal(source.driverHead, process.env.GITHUB_SHA)
    report.source = source
    const installer = await downloadExactPackage(join(root, 'package'), source, report)
    install = await findInstallation(installer, root, source, report)
    await withOwnedApplication(install, root, report, (cdp, workspace) => validateWorkbook(cdp, workspace, root, report, evidenceDir))
    assert.equal(await sha256(install.asar), report.installed.asarSha256)
    assert.equal(report.rendererExceptions, 0)
    assert.equal(report.blockedRendererRequests, 0)
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error.message
    throw error
  } finally {
    if (install?.cleanup) {
      try { install.cleanup(); report.temporaryInstallationRemoved = registryState().length === 0 }
      catch { report.temporaryInstallationRemoved = false }
    }
    await writeFile(join(evidenceDir, 'spreadsheet-smoke.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report))
  }
}

await main(process.argv.slice(2))
