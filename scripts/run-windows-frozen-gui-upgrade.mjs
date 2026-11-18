import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { parseByteRange } from './frozen-release-updater-feed.mjs'
import { inspectInstaller, inspectInstalledPackage, installIdentity } from './verify-windows-install-smoke.mjs'
import {
  attachPackagedRenderer, installExactNsis, ownedInstallState, powershell, psQuote,
  registryState, sha256, waitUntil, windowsForExecutable
} from './run-windows-published-gui-update-smoke.mjs'

const releaseNotes = new URL('../docs/qa/release-gates/v0.5.7.json', import.meta.url)
const samePath = (left, right) => resolve(left).toLowerCase() === resolve(right).toLowerCase()
const oneHour = 60 * 60_000

export function verifyFrozenWindowsReadback({ expectedVersion, expectedSource, installerSha256, registry, packageMetadata, profilePreserved, threadPreserved }, target) {
  assert.equal(expectedVersion, target.identity.version)
  assert.equal(expectedSource, target.identity.sourceHead)
  assert.equal(installerSha256, target.installer.sha256)
  assert.equal(registry.displayVersion, expectedVersion)
  assert.equal(packageMetadata.version, expectedVersion)
  assert.equal(packageMetadata.sourceHead, expectedSource)
  assert.ok(/^[a-f0-9]{64}$/.test(packageMetadata.asarSha256))
  assert.equal(profilePreserved, true)
  assert.equal(threadPreserved, true)
}

function requireHostedWindows(env) {
  assert.ok(process.platform === 'win32' && process.arch === 'x64' && env.GITHUB_ACTIONS === 'true' &&
    env.RUNNER_ENVIRONMENT === 'github-hosted' && env.RUNNER_OS === 'Windows' && env.RUNNER_TEMP,
  'Only an ephemeral GitHub-hosted Windows x64 runner may use this acceptance driver')
}

async function verifiedTarget(directory, source, version) {
  const identity = installIdentity(version, source.packageSourceHead)
  const installer = inspectInstaller(join(directory, identity.installerName), identity)
  const receiptPath = join(directory, 'reviewed-build.json')
  const receipt = await readFile(receiptPath, 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (version === '0.5.8') assert.ok(receipt, 'Exact 0.5.8 must have its immutable reviewed build receipt')
  if (version === '0.5.9') {
    assert.equal(source.purpose, 'private-next-updater-fixture')
    assert.equal(source.packageSourceHead, process.env.GITHUB_SHA)
    assert.equal(String(source.runId), process.env.GITHUB_RUN_ID)
    assert.equal(String(source.runAttempt), process.env.GITHUB_RUN_ATTEMPT)
  }
  if (receipt) {
    assert.equal(receipt.version, version)
    assert.equal(receipt.sourceHead, source.packageSourceHead)
    assert.equal(receipt.runId, Number(source.runId))
    assert.equal(receipt.runAttempt, Number(source.runAttempt))
    const reviewed = receipt.files.find(file => file.name === installer.name)
    assert.equal(reviewed?.size, installer.size)
    assert.equal(reviewed.sha256, installer.sha256)
    for (const name of ['latest.yml', `${installer.name}.blockmap`]) {
      const expected = receipt.files.find(file => file.name === name)
      const verified = join(directory, name)
      assert.equal((await lstat(verified)).size, expected?.size)
      assert.equal(await sha256(verified), expected.sha256)
    }
  }
  return { identity, installer, directory, source }
}

async function officialBaseline(root) {
  const gate = JSON.parse(await readFile(releaseNotes, 'utf8'))
  const build = gate.package.reviewedBuild
  const identity = installIdentity('0.5.7', build.sourceHead)
  const release = build.files.find(file => file.name === identity.installerName)
  const path = join(root, identity.installerName)
  const source = `https://github.com/railwise-cn/railwise-ai/releases/download/v0.5.7/${identity.installerName}`
  const response = await fetch(source, { signal: AbortSignal.timeout(300_000) })
  assert.ok(response.ok && response.body, '0.5.7 released installer download failed')
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, { flags: 'wx' }))
  assert.equal((await lstat(path)).size, release.size)
  assert.equal(await sha256(path), release.sha256)
  return { identity, installer: { path, sha256: release.sha256, size: release.size } }
}

async function createPrivateTrust(root) {
  const certificate = join(root, 'private-updater.pfx')
  const publicRoot = join(root, 'private-updater-root.cer')
  const password = randomUUID()
  const name = `RailWise QA ${randomUUID()}`
  const issuerSubject = `CN=${name} root`
  const leafSubject = `CN=${name} loopback`
  const remove = () => powershell(`
    $ErrorActionPreference = 'Stop'
    Get-ChildItem 'Cert:\\LocalMachine\\Root' | Where-Object Subject -eq ${psQuote(issuerSubject)} | Remove-Item
    Get-ChildItem 'Cert:\\CurrentUser\\My' | Where-Object Subject -in @(${psQuote(issuerSubject)},${psQuote(leafSubject)}) | ForEach-Object {
      Remove-Item -LiteralPath "Cert:\\CurrentUser\\My\\$($_.Thumbprint)" -DeleteKey
    }
  `)
  try {
    const command = `
      $ErrorActionPreference = 'Stop'
      $admin = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
      if (!$admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'The ephemeral runner is required to be an administrator' }
      $issuer = New-SelfSignedCertificate -Type Custom -Subject ${psQuote(issuerSubject)} -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddHours(1) -HashAlgorithm SHA256 -KeyUsage CertSign,CRLSign -TextExtension '2.5.29.19={critical}{text}ca=1&pathlength=0'
      $cert = New-SelfSignedCertificate -Type Custom -Subject ${psQuote(leafSubject)} -Signer $issuer -CertStoreLocation 'Cert:\\CurrentUser\\My' -NotAfter (Get-Date).AddMinutes(50) -KeyExportPolicy Exportable -HashAlgorithm SHA256 -KeyUsage DigitalSignature,KeyEncipherment -TextExtension @('2.5.29.17={text}ipaddress=127.0.0.1','2.5.29.37={text}1.3.6.1.5.5.7.3.1')
      $secure = ConvertTo-SecureString $env:RAILWISE_TEST_PFX_PASSWORD -AsPlainText -Force
      Export-PfxCertificate -Cert $cert -FilePath ${psQuote(certificate)} -Password $secure -CryptoAlgorithmOption AES256_SHA256 | Out-Null
      Export-Certificate -Cert $issuer -FilePath ${psQuote(publicRoot)} | Out-Null
      $trusted = Import-Certificate -FilePath ${psQuote(publicRoot)} -CertStoreLocation 'Cert:\\LocalMachine\\Root' -Confirm:$false
      if ($trusted.Thumbprint -ne $issuer.Thumbprint) { throw 'The disposable trust root did not match the generated certificate' }
    `
    execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...process.env, RAILWISE_TEST_PFX_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 45_000
    })
    return { pfx: await readFile(certificate), passphrase: password, remove }
  } catch (error) {
    try { remove() } catch { /* The ephemeral machine will discard an incomplete trust setup. */ }
    throw new Error(`Could not establish the ephemeral Windows updater HTTPS trust (${error.code ?? error.status ?? 'setup-failed'})`)
  }
}

async function openPrivateFeed(trust, target) {
  const prefix = `/private-${randomUUID()}/`
  const name = target.installer.name
  const manifest = await readFile(join(target.directory, 'latest.yml'))
  const files = new Map([[name, { path: target.installer.path, size: target.installer.size }]])
  const blockmap = join(target.directory, `${name}.blockmap`)
  const blockmapStat = await lstat(blockmap).catch(() => null)
  if (blockmapStat?.isFile()) files.set(`${name}.blockmap`, { path: blockmap, size: blockmapStat.size })
  const requests = { manifest: 0, installerBytes: 0 }
  const server = createServer({ pfx: trust.pfx, passphrase: trust.passphrase }, (request, response) => {
    const path = request.url?.split('?')[0]
    response.setHeader('Cache-Control', 'no-store')
    if (!['GET', 'HEAD'].includes(request.method) || !path?.startsWith(prefix)) { response.writeHead(404).end(); return }
    const requested = path.slice(prefix.length)
    if (requested === 'latest.yml') {
      requests.manifest++
      response.writeHead(200, { 'Content-Type': 'application/yaml', 'Content-Length': manifest.length })
      response.end(request.method === 'HEAD' ? undefined : manifest)
      return
    }
    const file = files.get(requested)
    if (!file) { response.writeHead(404).end(); return }
    let range
    try { range = parseByteRange(request.headers.range, file.size) }
    catch { response.writeHead(416, { 'Content-Range': `bytes */${file.size}` }).end(); return }
    if (range.partial) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
    response.writeHead(range.partial ? 206 : 200, { 'Accept-Ranges': 'bytes', 'Content-Length': range.end - range.start + 1 })
    if (request.method === 'HEAD') { response.end(); return }
    const stream = createReadStream(file.path, range)
    if (requested === name) stream.on('data', bytes => { requests.installerBytes += bytes.length })
    stream.on('error', () => response.destroy())
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  })
  await new Promise((ready, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, ready) })
  const url = `https://127.0.0.1:${server.address().port}${prefix}`
  const close = () => new Promise(done => { server.close(done); server.closeAllConnections() })
  return { url, requests, close }
}

async function launchOwned(executable, cwd, feedUrl) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|^(WORKWISE_|CSC_|R2_|S3_|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|ELECTRON_RUN_AS_NODE|RELEASE_CHANNEL)/i.test(key)) delete env[key]
  if (feedUrl) Object.assign(env, { WORKWISE_UPDATE_URL_STABLE: feedUrl, WORKWISE_UPDATE_PROVIDER: 'generic' })
  const child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--lang=zh-CN'], { cwd, env })
  let port, failure, output = ''
  child.once('error', error => { failure = error })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
    output = (output + bytes).slice(-8_000)
    port ??= output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]
  })
  try {
    const cdp = await attachPackagedRenderer(child, executable, () => { if (failure) throw failure; return port })
    await cdp.wait('Boolean(window.workwise?.getAppVersion && document.querySelector("button"))', 'the installed window')
    return { child, cdp }
  } catch (error) { child.kill(); throw error }
}

async function closeOwnedWindows(executable) {
  for (const { pid } of windowsForExecutable(executable)) powershell(`
    $process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
    if ($process.Path -eq ${psQuote(executable)} -and $process.MainWindowHandle -ne 0) { $null = $process.CloseMainWindow() }
  `)
  await waitUntil(() => powershell(`
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object Path -eq ${psQuote(executable)})
    $running.Count
  `) === '0', 'the owned RailWise process to exit', 60_000)
}

async function exerciseSidebar({ running, target, feed, executable, allowLegacyFallback }) {
  const { cdp, child } = running
  const version = target.identity.version
  const control = `button[title^="升级到 ${version}，"], button[title^="Update to ${version},"]`
  await cdp.wait(`Boolean([...document.querySelectorAll(${JSON.stringify(control)})].find(el => !el.disabled && el.getClientRects().length))`, 'the automatic sidebar update offer', 90_000).catch(async error => {
    const state = await cdp.evaluate('window.workwise.getGuiUpdateState()').catch(() => ({}))
    throw new Error(`${error.message}: ${JSON.stringify({ status: state.status, code: state.code, latestVersion: state.info?.latestVersion, privateManifestReads: feed.requests.manifest })}`)
  })
  const available = await cdp.evaluate('window.workwise.getGuiUpdateState()')
  assert.equal(available.status, 'available')
  assert.equal(available.info?.latestVersion, version)
  assert.equal(available.info?.manualOnly, false)
  await cdp.click(control)
  const result = await waitUntil(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const state = await cdp.evaluate('window.workwise.getGuiUpdateState()', 3_000).catch(() => null)
      if (state?.status === 'error') return { method: 'native-updater-error', code: state.code ?? '', downloaded: feed.requests.installerBytes >= target.installer.size }
      return null
    }
    const window = windowsForExecutable(executable).find(item => item.pid !== child.pid && item.title === target.identity.productName)
    return window ? { method: 'trusted-pointer-on-sidebar', window } : null
  }, 'native NSIS handoff and relaunch', 600_000, 1_000)
  assert.ok(feed.requests.manifest > 0 && feed.requests.installerBytes > 0, 'The private feed must serve the requested installer')
  if (result.method === 'native-updater-error') {
    assert.ok(allowLegacyFallback && result.code === 'install_failed' && result.downloaded, 'Only a demonstrated old updater handoff failure may use overlay')
    await closeOwnedWindows(executable)
    installExactNsis(target.installer.path, target.installDirectory)
    return { method: 'exact-installer-overlay', oldUpdaterError: result.code }
  }
  return result
}

async function main(args) {
  requireHostedWindows(process.env)
  assert.ok(args.length === 3 || args.length === 6, 'Pass exact package directory, provenance JSON, evidence directory, and optional private next package directory, provenance and version')
  const [directory, sourceFile, evidence, nextDirectory, nextSourceFile, nextVersion] = args.map(String)
  const readSource = async path => JSON.parse(await readFile(path, 'utf8'))
  const target = await verifiedTarget(directory, await readSource(sourceFile), '0.5.8')
  if (nextDirectory) assert.equal(nextVersion, '0.5.9', 'Use the private 0.5.9 test installer for the next upgrade')
  const next = nextDirectory ? await verifiedTarget(nextDirectory, await readSource(nextSourceFile), nextVersion) : undefined
  const root = await mkdtemp(join(process.env.RUNNER_TEMP, 'railwise-frozen-windows-update-'))
  const baseline = await officialBaseline(root)
  const installDirectory = join(root, 'install')
  const executable = join(installDirectory, target.identity.executableName)
  const profile = join(process.env.APPDATA, target.identity.productName)
  const workspace = join(root, '工程 升级验收')
  assert.deepEqual(registryState(), [], 'Existing RailWise installation found on the runner')
  await mkdir(profile) // fails if existing user data is present
  await mkdir(workspace)
  await mkdir(evidence, { recursive: true })
  const settings = { schema: 'workwise.settings', version: 2, revision: 0, locale: 'zh', theme: 'light', workspaceRoot: workspace,
    appBehavior: { closeToTray: false, startMinimized: false, openAtLogin: false }, agents: { kun: { autoStart: true, dataDir: join(root, 'runtime') } } }
  const sentinel = randomUUID()
  const sentinelFile = join(profile, 'railwise-updater-fixture.txt')
  await writeFile(sentinelFile, sentinel, { flag: 'wx' })
  await writeFile(join(profile, 'workwise-settings.json'), JSON.stringify(settings), { flag: 'wx' })
  const seedSchedule = version => writeFile(join(profile, 'gui-update-schedule.json'), JSON.stringify({ appVersion: version, lastCheckedAt: new Date(Date.now() - oneHour).toISOString() }))

  const report = { status: 'running', scope: 'private-frozen-windows-gui-upgrade', productionTouched: false,
    driverSource: process.env.GITHUB_SHA, baseline: { installer: baseline.installer }, targetBuild: target.source, steps: [] }
  const save = () => writeFile(join(evidence, 'frozen-windows-update.json'), `${JSON.stringify(report, null, 2)}\n`)
  let trust, feed, running, thread
  try {
    await save()
    installExactNsis(baseline.installer.path, installDirectory)
    report.baseline.package = inspectInstalledPackage(installDirectory, baseline.identity)
    report.baseline.registry = ownedInstallState(installDirectory, '0.5.7')
    await save()
    await seedSchedule('0.5.7')
    trust = await createPrivateTrust(root)
    feed = await openPrivateFeed(trust, target)
    running = await launchOwned(executable, root, feed.url)
    assert.equal(await running.cdp.evaluate('window.workwise.getAppVersion()'), '0.5.7')
    await running.cdp.wait(`window.workwise.runtimeRequest('/v1/runtime/info','GET').then(r=>r.ok)`, 'installed KUN service')
    thread = await running.cdp.evaluate(`(async()=>{
      const r=await window.workwise.runtimeRequest('/v1/threads','POST',JSON.stringify({workspace:${JSON.stringify(workspace)}, title:'升级验收会话', model:'deepseek-flash', mode:'agent'}));
      if(!r.ok) throw new Error('Could not seed a real local KUN conversation'); return JSON.parse(r.body).id;
    })()`)
    assert.ok(/^[A-Za-z0-9_-]+$/.test(thread), 'Real KUN conversation identity required')
    for (const [index, item] of [target, next].entries()) {
      if (!item) break
      const action = await exerciseSidebar({ running, target: { ...item, installDirectory }, executable, feed, allowLegacyFallback: index === 0 })
      running.cdp.close()
      await closeOwnedWindows(executable)
      await feed.close()
      feed = index === 0 && next ? await openPrivateFeed(trust, next) : null
      await seedSchedule(item.identity.version)
      running = await launchOwned(executable, root, feed?.url)
      assert.equal(await running.cdp.evaluate('window.workwise.getAppVersion()'), item.identity.version)
      await running.cdp.wait(`window.workwise.runtimeRequest('/v1/runtime/info','GET').then(r=>r.ok)`, 'upgraded KUN service')
      const actual = { expectedVersion: item.identity.version, expectedSource: item.identity.sourceHead, installerSha256: item.installer.sha256,
        registry: ownedInstallState(installDirectory, item.identity.version), packageMetadata: inspectInstalledPackage(installDirectory, item.identity),
        profilePreserved: (await readFile(sentinelFile, 'utf8')) === sentinel && samePath(await running.cdp.evaluate('window.workwise.getSettings().then(s=>s.workspaceRoot)'), workspace),
        threadPreserved: await running.cdp.evaluate(`window.workwise.runtimeRequest('/v1/threads/${thread}','GET').then(r=>r.ok&&JSON.parse(r.body).id===${JSON.stringify(thread)})`) }
      verifyFrozenWindowsReadback(actual, item)
      report.steps.push({ ...actual, action })
      await save()
    }
    report.status = next ? 'passed' : 'overlay-verified-next-upgrade-pending'
  } catch (error) {
    report.status = 'failed'
    report.failure = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : 'Unexpected smoke failure'
    throw error
  } finally {
    running?.cdp.close()
    await closeOwnedWindows(executable).catch(() => undefined)
    await feed?.close()
    try {
      trust?.remove()
    } catch {
      report.cleanupError = 'Could not remove the owned QA certificates before the temporary runner shut down'
      report.status = 'failed'
    } finally {
      await save()
    }
    if (report.cleanupError && !report.failure) throw new Error(report.cleanupError)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
