import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { inspectInstalledPackage, inspectInstaller, installIdentity } from './verify-windows-install-smoke.mjs'
import { connectCdp, summarizeWindowsUpdateMetadata } from './run-windows-ui-smoke.mjs'

const baseVersion = '0.5.6'
const targetVersion = '0.5.7'
const baseSource = 'ce5b00cc41c3a53144144c85ecc772efe5872718'
const targetAsar = 'd0b02f0cf4ff19c7891a1722706932d10c33ee77f3b03c53f3fdd3ab3998ce3a'
const targetInstallerSha512 = 'uMwIBK7dFby0e3J6Ln6ZOA31iFMUjW1zy6kRtKx95+PxPO0Vr2wECHvSBuE5CUtMQtlH5mIf6oY+Ras2FBv0tA=='
const officialFeed = 'https://www.railwise.cn/downloads/railwise-ai/channels/stable/latest/'
const baselines = JSON.parse(await readFile(new URL('../release/updater-acceptance-baselines.json', import.meta.url), 'utf8'))
const releaseGate = JSON.parse(await readFile(new URL('../docs/qa/release-gates/v0.5.7.json', import.meta.url), 'utf8'))
const baseline = baselines.versions[baseVersion]['win32-x64']
const reviewedBuild = releaseGate.package.reviewedBuild
const target = reviewedBuild.files.find(file => file.name === `RailWise-AI-${targetVersion}-win-x64.exe`)
const rootIdentity = installIdentity(baseVersion, baseSource)
const targetIdentity = installIdentity(targetVersion, reviewedBuild.sourceHead)
const pathEquals = (one, other) => resolve(one).toLowerCase() === resolve(other).toLowerCase()
const hourMs = 60 * 60 * 1000

export function repairedScheduleSeed(nowMs) {
  return { appVersion: baseVersion, lastCheckedAt: new Date(nowMs - hourMs).toISOString() }
}

export function verifyPublishedWindowsManifest(manifest) {
  assert.equal(manifest.version, targetVersion, 'The current Stable feed must match the pinned target')
  assert.equal(manifest.path, target.name)
  assert.equal(manifest.sha512, targetInstallerSha512)
  const choices = manifest.files?.filter(file => file.url === target.name)
  assert.equal(choices?.length, 1, 'The Stable Windows installer must be unambiguous')
  assert.equal(choices[0].size, target.size)
  assert.equal(choices[0].sha512, targetInstallerSha512)
  return { version: manifest.version, ...choices[0], reviewedSha256: target.sha256 }
}

export function assertPublishedWindowsUpgrade(report) {
  assert.equal(report.baseline?.package?.version, baseVersion)
  if (report.scope === 'private-repaired-windows-gui-upgrade') {
    assert.ok(/^[a-f0-9]{40}$/.test(report.provenance?.driverSourceHead ?? ''))
    assert.equal(report.baseline.package.sourceHead, report.provenance.driverSourceHead)
    assert.match(report.baseline?.installer?.sha256 ?? '', /^[a-f0-9]{64}$/)
    assert.notEqual(report.baseline.installer.sha256, baseline.sha256)
    assert.equal(report.schedule?.seededRecord?.appVersion, baseVersion)
    assert.equal(report.schedule?.automaticRecord?.appVersion, baseVersion)
    assert.equal(Date.parse(report.schedule.seededAt) - Date.parse(report.schedule.seededRecord.lastCheckedAt), hourMs)
    assert.ok(Date.parse(report.schedule.automaticRecord.lastCheckedAt) >= Date.parse(report.schedule.seededAt),
      'The normal baseline updater must recheck after the one-hour seed')
  } else {
    assert.equal(report.scope, 'published-windows-gui-upgrade')
    assert.equal(report.baseline?.installer?.sha256, baseline.sha256)
  }
  assert.equal(report.offer?.status, 'available')
  assert.equal(report.offer?.hasUpdate, true)
  assert.equal(report.action?.method, 'trusted-pointer-on-sidebar')
  assert.equal(report.action?.manualOnly, false)
  assert.equal(report.action?.latestVersion, targetVersion)
  assert.equal(report.target?.package?.version, targetVersion)
  assert.equal(report.target?.package?.asarSha256, targetAsar)
  assert.ok(report.target?.window?.handle > 0, 'The relaunched process must expose a native window')
  assert.ok(report.target?.window?.pid > 0 && report.baseline?.pid > 0)
  assert.notEqual(report.target.window.pid, report.baseline.pid)
  assert.equal(report.target.window.title, targetIdentity.productName)
  assert.ok(pathEquals(report.target.window.path, report.baseline.executable))
  assert.ok(pathEquals(report.target.registry.installLocation, report.baseline.registry.installLocation))
  assert.equal(report.target.registry.displayVersion, targetVersion)
  assert.equal(report.profile?.sentinelPreserved, true)
}

const psQuote = value => "'" + value.replaceAll("'", "''") + "'"
function powershell(script, timeout = 12_000) {
  return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', maxBuffer: 128 * 1024, timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

function registryState() {
  const base = psQuote(rootIdentity.installRegistryKey)
  const uninstall = psQuote(rootIdentity.uninstallRegistryKey)
  return JSON.parse(powershell(`
    $ErrorActionPreference = 'Stop'
    $entries = @(
      foreach ($hive in @('CurrentUser','LocalMachine')) {
        foreach ($view in @('Registry64','Registry32')) {
          $root = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
            [Microsoft.Win32.RegistryHive]::$hive, [Microsoft.Win32.RegistryView]::$view)
          try {
            $install = $root.OpenSubKey(${base})
            $remove = $root.OpenSubKey(${uninstall})
            if ($null -ne $install -or $null -ne $remove) {
              @{ hive = $hive; view = $view
                 installLocation = $(if ($null -ne $install) { $install.GetValue('InstallLocation') })
                 displayVersion = $(if ($null -ne $remove) { $remove.GetValue('DisplayVersion') }) }
            }
          } finally { $root.Dispose() }
        }
      }
    )
    ConvertTo-Json -InputObject $entries -Compress
  `))
}

function ownedInstallState(directory, version) {
  const entries = registryState().filter(entry => entry.hive === 'CurrentUser' && entry.view === 'Registry64')
  assert.equal(entries.length, 1, 'The public NSIS identity must be installed for this user')
  const registry = entries[0]
  assert.ok(registry.installLocation && pathEquals(registry.installLocation, directory), 'NSIS registry must point to the smoke installation')
  assert.equal(registry.displayVersion, version)
  return registry
}

function windowsForExecutable(executable) {
  return JSON.parse(powershell(`
    $ErrorActionPreference = 'Stop'
    $windows = @(Get-Process -Name ${psQuote(basename(executable, '.exe'))} -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq ${psQuote(executable)} -and $_.MainWindowHandle -ne 0 } |
      ForEach-Object { @{ pid = $_.Id; path = $_.Path; title = $_.MainWindowTitle; handle = $_.MainWindowHandle.ToInt64() } })
    ConvertTo-Json -InputObject $windows -Compress
  `))
}

async function waitUntil(read, label, timeout, interval = 250) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await sleep(interval)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function sha256(path) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(path)) digest.update(bytes)
  return digest.digest('hex')
}

async function downloadBaseline(directory) {
  const url = `https://github.com/railwise-cn/railwise-ai/releases/download/v${baseVersion}/${baseline.name}`
  const path = join(directory, baseline.name)
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  assert.ok(response.ok && response.body, `Baseline installer download returned HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(path, { flags: 'wx' }))
  const info = await lstat(path)
  const digest = await sha256(path)
  assert.equal(info.size, baseline.size)
  assert.equal(digest, baseline.sha256)
  return { path, name: baseline.name, url, size: info.size, sha256: digest }
}

async function attachPackagedRenderer(child, executable, devtoolsPort) {
  return waitUntil(async () => {
    if (child.exitCode !== null) throw new Error(`Baseline exited before renderer inspection (${child.exitCode})`)
    const port = devtoolsPort()
    if (!port) return null
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3_000) })
      .then(response => response.json()).catch(() => [])
    const packagedRenderer = join(dirname(executable), 'resources', 'app.asar', 'out', 'renderer', 'index.html')
    const tab = targets.find(entry => entry.type === 'page' && entry.url.startsWith('file:') &&
      pathEquals(fileURLToPath(entry.url), packagedRenderer) &&
      entry.webSocketDebuggerUrl?.startsWith(`ws://127.0.0.1:${port}/`))
    return tab ? connectCdp(tab.webSocketDebuggerUrl) : null
  }, 'the owned packaged renderer', 90_000)
}

async function main(args) {
  assert.ok(process.platform === 'win32' && process.arch === 'x64' && process.env.GITHUB_ACTIONS === 'true' &&
    process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.RUNNER_OS === 'Windows',
    'Published GUI upgrade requires an ephemeral GitHub-hosted Windows x64 runner')
  const repaired = args.length === 1 && args[0] === '--repaired-baseline'
  assert.ok(!args.length || repaired, 'Unsupported Windows GUI updater smoke arguments')
  const evidenceDir = join(process.env.RUNNER_TEMP, 'published-windows-gui-upgrade-evidence')
  await mkdir(evidenceDir)
  const report = { schemaVersion: 1, scope: repaired ? 'private-repaired-windows-gui-upgrade' : 'published-windows-gui-upgrade', status: 'running',
    provenance: { driverSourceHead: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT },
    baseVersion, targetVersion, phase: 'preflight', baseline: {},
    officialFeed, directTargetInstallerLaunches: 0, applicationUpdaterOverrides: 0 }
  const save = () => writeFile(join(evidenceDir, 'windows-published-gui-upgrade.json'), JSON.stringify(report, null, 2) + '\n')
  const capture = async (cdp, filename) => {
    const image = await cdp.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(join(evidenceDir, filename), Buffer.from(image.data, 'base64'))
  }
  let cdp
  let child
  try {
    await save()
    assert.deepEqual(registryState(), [], 'An existing public installation was found')
    const profile = join(process.env.APPDATA, rootIdentity.productName)
    const profiles = [profile, join(process.env.APPDATA, rootIdentity.packageName)]
    for (const path of profiles) {
      const present = await lstat(path).then(() => true, error => {
        if (error.code === 'ENOENT') return false
        throw error
      })
      assert.equal(present, false, 'An existing RailWise profile was found')
    }
    const response = await fetch(new URL('latest.yml', officialFeed), {
      cache: 'no-store', signal: AbortSignal.timeout(30_000)
    })
    assert.ok(response.ok, `Current Stable feed returned HTTP ${response.status}`)
    report.manifest = verifyPublishedWindowsManifest(parse(await response.text()))
    const root = await mkdtemp(join(process.env.RUNNER_TEMP, 'railwise-published-gui-upgrade-'))
    const directory = join(root, 'install')
    const executable = join(directory, rootIdentity.executableName)
    report.phase = 'baseline-install'
    const baselineIdentity = repaired ? installIdentity(baseVersion, process.env.GITHUB_SHA) : rootIdentity
    report.baseline.installer = repaired
      ? inspectInstaller(join(process.env.RUNNER_TEMP, 'repaired-updater-baseline', baselineIdentity.installerName), baselineIdentity)
      : await downloadBaseline(root)
    await save()
    // /D must be last. A raw NSIS argument string preserves paths with spaces.
    const exitCode = powershell(`
      $ErrorActionPreference = 'Stop'
      $start = [Diagnostics.ProcessStartInfo]::new()
      $start.FileName = ${psQuote(report.baseline.installer.path)}
      $start.Arguments = ${psQuote(`/S /currentuser /D=${directory}`)}
      $start.UseShellExecute = $false
      $installer = [Diagnostics.Process]::Start($start)
      if (-not $installer.WaitForExit(300000)) {
        $installer.Kill($true)
        throw 'Released baseline installer timed out'
      }
      $installer.ExitCode
    `, 310_000)
    assert.equal(Number(exitCode), 0, 'Released baseline installer exit code')
    report.baseline.executable = executable
    report.baseline.package = inspectInstalledPackage(directory, baselineIdentity)
    report.baseline.registry = ownedInstallState(directory, baseVersion)
    const appUpdate = parse(await readFile(join(directory, 'resources', 'app-update.yml'), 'utf8'))
    assert.equal(appUpdate.provider, 'generic')
    assert.match(appUpdate.url, /^https:\/\/www\.railwise\.cn\/downloads\/(?:railwise-ai|workwise)\/channels\/stable\/latest\/?$/)
    report.baseline.packagedFeed = appUpdate.url
    report.phase = 'baseline-renderer'
    const cleanEnvironment = { ...process.env }
    for (const name of Object.keys(cleanEnvironment)) {
      if (/SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|^(?:APPLE_|CSC_|R2_|S3_|WORKWISE_|ELECTRON_RUN_AS_NODE|NODE_OPTIONS|RELEASE_CHANNEL|PUBLIC_DOWNLOAD_BASE_URL)/i.test(name)) delete cleanEnvironment[name]
    }
    if (repaired) {
      await mkdir(profile)
      const seededAt = Date.now()
      const seededRecord = repairedScheduleSeed(seededAt)
      const file = join(profile, 'gui-update-schedule.json')
      await writeFile(file, JSON.stringify(seededRecord) + '\n', { flag: 'wx' })
      report.schedule = { seededAt: new Date(seededAt).toISOString(), seededRecord }
      await save()
    }
    child = spawn(executable, ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--lang=zh-CN'],
      { env: cleanEnvironment, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let devtoolsPort
    let output = ''
    let launchError
    child.once('error', error => { launchError = error })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      output = (output + chunk).slice(-8_000)
      devtoolsPort ??= output.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)?.[1]
    })
    cdp = await attachPackagedRenderer(child, executable, () => {
      if (launchError) throw launchError
      return devtoolsPort
    })
    await cdp.wait('Boolean(window.workwise?.getAppVersion && document.querySelector("button"))', 'baseline workbench')
    assert.equal(await cdp.evaluate('window.workwise.getAppVersion()'), baseVersion)
    report.baseline.pid = child.pid
    report.phase = 'automatic-offer'
    const control = 'button[title^="升级到 0.5.7"], button[title^="Upgrade to 0.5.7"]'
    const button = await cdp.wait(`(() => {
      const element = document.querySelector(${JSON.stringify(control)})
      if (!element || element.disabled || !element.getClientRects().length) return null
      const box = element.getBoundingClientRect()
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
      return hit && element.contains(hit) ? { text: element.innerText, title: element.title } : null
    })()`, 'a visible sidebar upgrade from the automatic updater check', 90_000)
    const available = await cdp.evaluate('window.workwise.getGuiUpdateState()')
    report.offer = { button, status: available.status, ...summarizeWindowsUpdateMetadata(available.info) }
    assert.equal(available.status, 'available')
    assert.equal(available.info?.currentVersion, baseVersion)
    assert.equal(available.info?.latestVersion, targetVersion)
    assert.equal(available.info?.channel, 'stable')
    assert.equal(available.info?.manualOnly, false)
    await capture(cdp, 'windows-056-sidebar-upgrade.png')
    await save()

    // The clean baseline writes its schedule file before making the automatic
    // check. It identifies the normal Windows profile that NSIS will reopen.
    const activeProfiles = []
    for (const path of profiles) {
      const schedule = await lstat(join(path, 'gui-update-schedule.json')).catch(error => {
        if (error.code !== 'ENOENT') throw error
      })
      if (schedule?.isFile()) activeProfiles.push(path)
    }
    assert.equal(activeProfiles.length, 1, 'Expected the automatic updater schedule in the owned profile')
    if (repaired) {
      assert.ok(pathEquals(activeProfiles[0], profile), 'The fixture must reuse the profile seeded before launch')
      report.schedule.automaticRecord = JSON.parse(await readFile(join(profile, 'gui-update-schedule.json'), 'utf8'))
      await save()
    }
    const sentinel = join(activeProfiles[0], 'railwise-published-updater-smoke.txt')
    const sentinelValue = `Synthetic updater continuity marker ${randomUUID()}\n`
    await writeFile(sentinel, sentinelValue, { flag: 'wx' })
    report.profile = { directory: activeProfiles[0], sentinelSha256: await sha256(sentinel) }

    report.phase = 'sidebar-upgrade'
    await cdp.click(control)
    report.action = { method: 'trusted-pointer-on-sidebar', latestVersion: available.info.latestVersion, manualOnly: available.info.manualOnly }
    await save()
    report.updaterStates = []
    const relaunched = await waitUntil(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const state = await cdp.evaluate('window.workwise.getGuiUpdateState()', 3_000).catch(() => null)
        if (state?.status && report.updaterStates.at(-1) !== state.status) report.updaterStates.push(state.status)
        if (state?.status === 'error') {
          report.lastUpdateState = { status: state.status, ...summarizeWindowsUpdateMetadata({ ...state.info, ok: false, code: state.code, message: state.message }) }
          throw new Error('The packaged updater reported a failure after the sidebar click')
        }
        return null
      }
      return windowsForExecutable(executable).find(window => window.pid !== child.pid && window.title === targetIdentity.productName)
    }, 'the automatic NSIS relaunch of RailWise AI', 600_000, 1_000)
    report.target = { window: relaunched }
    report.phase = 'target-identity'
    report.target.package = inspectInstalledPackage(directory, targetIdentity)
    report.target.registry = ownedInstallState(directory, targetVersion)
    report.profile.sentinelPreserved = await readFile(sentinel, 'utf8') === sentinelValue
    report.baseline.exitedWith = child.exitCode
    assertPublishedWindowsUpgrade(report)
    report.status = 'passed'
    report.phase = 'complete'
  } catch (error) {
    report.status = 'failed'
    report.failure = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] : 'Unexpected smoke failure'
    if (cdp && child?.exitCode === null) {
      const state = await cdp.evaluate('window.workwise.getGuiUpdateState()', 3_000).catch(() => null)
      if (state && !report.lastUpdateState) report.lastUpdateState = { status: state.status, ...summarizeWindowsUpdateMetadata(state.info ?? state) }
      await capture(cdp, 'windows-published-upgrade-failure.png').catch(() => undefined)
    }
    throw error
  } finally {
    cdp?.close()
    // The runner is disposable. Leave its owned installation intact for the
    // evidence upload and close only the child this driver launched.
    if (child?.exitCode === null) child.kill()
    await save()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
