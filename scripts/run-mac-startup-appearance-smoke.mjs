import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp } from './run-windows-ui-smoke.mjs'
import { createChineseTextPdf } from './verify-windows-composer-acceptance.mjs'
import { observeInstalledStartup } from './verify-packaged-startup-appearance.mjs'
import { PUBLIC_IDENTITY, RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './verify-reviewed-release-artifacts.mjs'

const require = createRequire(import.meta.url)
const acceptedDriverFiles = new Set([
  '.github/workflows/windows-install-smoke.yml',
  'scripts/run-mac-startup-appearance-smoke.mjs',
  'scripts/run-windows-ui-smoke.mjs',
  'scripts/verify-packaged-startup-appearance.mjs',
  'scripts/verify-windows-startup-appearance.test.mjs'
])
const command = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const git = (...args) => command('git', args)
const json = (path) => readFile(path, 'utf8').then(JSON.parse)

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}

export function validateMacStartupArtifact(source) {
  assert.equal(source.repository, RELEASE_REPOSITORY)
  assert.equal(source.workflow, RELEASE_WORKFLOW)
  for (const sha of [source.sourceHead, source.driverHead]) assert.match(sha, /^[a-f0-9]{40}$/)
  for (const number of [source.runId, source.runAttempt, source.artifactId]) assert.match(String(number), /^[1-9]\d*$/)
  assert.equal(source.buildConclusion, 'success')
  assert.equal(source.artifactName, 'release-mac')
  assert.match(source.artifactDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(source.artifactExpired, false)
  assert.ok(Array.isArray(source.changedFiles) && source.changedFiles.every(file => acceptedDriverFiles.has(file)), 'Application source differs from the reviewed build')
  return source
}

async function prepare(buildRunId, sourceFile) {
  assert.match(buildRunId, /^[1-9]\d*$/)
  const repository = process.env.GITHUB_REPOSITORY
  assert.equal(repository, RELEASE_REPOSITORY)
  const api = (suffix) => JSON.parse(command('gh', ['api', `repos/${repository}/${suffix}`]))
  const run = api(`actions/runs/${buildRunId}`)
  assert.equal(run.repository.full_name, repository)
  assert.equal(run.head_repository.full_name, repository)
  assert.equal(run.path, RELEASE_WORKFLOW)
  const driverHead = git('rev-parse', 'HEAD')
  assert.equal(driverHead, process.env.GITHUB_SHA)
  git('merge-base', '--is-ancestor', run.head_sha, driverHead)
  const jobs = api(`actions/runs/${buildRunId}/attempts/${run.run_attempt}/jobs?per_page=100`)
  const build = jobs.jobs.find(job => job.name === 'Build macOS')
  const artifacts = api(`actions/runs/${buildRunId}/artifacts?per_page=100`)
  const [artifact, duplicate] = artifacts.artifacts.filter(item => item.name === 'release-mac' && !item.expired)
  assert.ok(artifact && !duplicate, 'Expected one immutable macOS release artifact')
  assert.equal(artifact.workflow_run.head_sha, run.head_sha)
  const source = validateMacStartupArtifact({ repository, workflow: run.path, runId: Number(buildRunId), runAttempt: run.run_attempt,
    sourceHead: run.head_sha, driverHead, buildConclusion: build?.conclusion, artifactName: artifact.name, artifactId: artifact.id,
    artifactDigest: artifact.digest, artifactExpired: artifact.expired,
    changedFiles: git('diff', '--name-only', run.head_sha, driverHead).split('\n').filter(Boolean) })
  await writeFile(sourceFile, `${JSON.stringify(source, null, 2)}\n`, { flag: 'wx' })
  await appendFile(process.env.GITHUB_OUTPUT, `artifact_id=${source.artifactId}\n`)
}

function isolatedMacEnvironment(environment, root) {
  const home = join(root, 'home')
  return { PATH: environment.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, TMPDIR: root,
    LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
}

export const nativeMacFilePasteboard = `
import AppKit

let pasteboard = NSPasteboard.general
let args = CommandLine.arguments
switch args[1] {
case "write":
    let file = URL(fileURLWithPath: args[2])
    pasteboard.clearContents()
    if !pasteboard.writeObjects([file as NSURL]) {
        fatalError("NSPasteboard rejected the file URL")
    }
    guard let value = pasteboard.pasteboardItems?.first?.string(forType: .fileURL),
          let roundTrip = URL(string: value),
          roundTrip.isFileURL,
          roundTrip.path == file.path else {
        pasteboard.clearContents()
        fatalError("NSPasteboard did not return the written public.file-url")
    }
    print(pasteboard.changeCount)
case "clear":
    if pasteboard.changeCount == Int(args[2]) {
        pasteboard.clearContents()
    }
default:
    fatalError("Unsupported file pasteboard operation")
}
`

export async function dispatchMacFilePaste(cdp) {
  const key = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 9, modifiers: 8 }
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, commands: ['Paste'] })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

async function verifyMacFilePaste(cdp, { root, workspace }, report) {
  assert.equal(process.platform, 'darwin')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  const name = 'Finder 中文粘贴样本.pdf'
  const pdf = join(workspace, name)
  const swift = join(root, 'native-file-pasteboard.swift')
  const helper = join(root, 'native-file-pasteboard')
  await Promise.all([writeFile(pdf, createChineseTextPdf()), writeFile(swift, nativeMacFilePasteboard)])
  report.fixture = { name, size: (await stat(pdf)).size, sha256: await sha256(pdf) }
  command('/usr/bin/swiftc', ['-module-cache-path', join(root, 'swift-cache'), swift, '-o', helper])

  const composer = 'textarea[placeholder="向智能体提问…"]:not(:disabled)'
  await cdp.wait("window.workwise.runtimeRequest('/v1/threads','GET').then(result=>result.ok).catch(()=>false)", 'the isolated local Runtime', 60_000)
  await cdp.click('.ds-sidebar-shell button.w-full', '新建会话')
  await cdp.click(composer)
  const selector = JSON.stringify(composer)
  assert.ok(await cdp.evaluate(`document.activeElement?.matches(${selector})`), 'The visible chat composer must have keyboard focus')
  await cdp.evaluate(`document.addEventListener('paste', (event) => {
    if (!event.target.matches(${selector})) return;
    window.nativeMacAttachmentPaste = {
      trusted: event.isTrusted, types: Array.from(event.clipboardData?.types ?? []),
      files: Array.from(event.clipboardData?.files ?? [], ({ name, size }) => ({ name, size }))
    };
  }, { capture: true, once: true })`)

  const changeCount = command(helper, ['write', pdf])
  assert.match(changeCount, /^\d+$/)
  report.writtenFormat = 'public.file-url'
  try {
    await dispatchMacFilePaste(cdp)
    report.event = await cdp.wait('window.nativeMacAttachmentPaste', 'a real Cmd+V paste event', 15_000)
    assert.equal(report.event.trusted, true)
    assert.deepEqual(report.event.files, [{ name, size: report.fixture.size }])
    report.attachment = await cdp.wait(`(() => {
      const label = [...document.querySelectorAll('.ds-floating-composer span')].find(item=>item.textContent.trim()===${JSON.stringify(name)});
      const chip = label?.parentElement;
      if (!chip) return null;
      const state = [...chip.children].find(item=>/^(已就绪|文字提取受限|读取失败|已取消)$/.test(item.textContent))?.textContent;
      return state ? { state, managedOriginal: Boolean(chip.querySelector('[aria-label="在文件夹中显示原件"]')) } : null;
    })()`, 'the PDF attachment to finish loading', 120_000)
    assert.match(report.attachment.state, /^(已就绪|文字提取受限)$/)
    assert.equal(report.attachment.managedOriginal, true)
    assert.equal(await sha256(pdf), report.fixture.sha256)
    report.sourceUnchanged = true
  } finally {
    command(helper, ['clear', changeCount])
  }
}

async function verify(directory, sourceFile, evidenceDir, temporary) {
  const source = validateMacStartupArtifact(await json(sourceFile))
  assert.equal(source.driverHead, process.env.GITHUB_SHA)
  const receipt = await json(join(directory, 'reviewed-build.json'))
  for (const name of ['runId', 'runAttempt', 'sourceHead']) assert.equal(receipt[name], source[name])
  const { version } = await json(new URL('../package.json', import.meta.url))
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.equal(receipt.version, version)
  const name = `RailWise-AI-${version}-mac-${process.arch}.dmg`
  const installer = join(directory, name)
  const digest = await sha256(installer)
  const size = (await stat(installer)).size
  const record = receipt.files.find(file => file.name === name)
  assert.equal(digest, record?.sha256)
  assert.equal(size, record.size)
  const root = await mkdtemp(join(temporary, 'railwise-mac-startup-'))
  const mountPoint = join(root, 'mounted')
  const install = join(root, 'RailWise AI.app')
  await Promise.all([mountPoint, evidenceDir].map(path => mkdir(path, { recursive: true })))
  command('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, installer])
  try { command('/usr/bin/ditto', [join(mountPoint, 'RailWise AI.app'), install]) }
  finally { command('/usr/bin/hdiutil', ['detach', mountPoint]) }
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', install])
  command('/usr/bin/xcrun', ['stapler', 'validate', install])
  const info = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(install, 'Contents', 'Info.plist')]))
  assert.equal(info.CFBundleIdentifier, PUBLIC_IDENTITY.bundleId)
  assert.equal(info.CFBundleExecutable, PUBLIC_IDENTITY.productName)
  assert.equal(info.CFBundleShortVersionString, version)
  const executable = join(install, 'Contents', 'MacOS', info.CFBundleExecutable)
  const installedArch = command('/usr/bin/lipo', ['-archs', executable])
  assert.equal(installedArch, process.arch === 'x64' ? 'x86_64' : 'arm64')
  const path = join(install, 'Contents', 'Resources', 'app.asar')
  const packaged = JSON.parse(require('@electron/asar').extractFile(path, 'package.json').toString('utf8'))
  assert.equal(packaged.name, PUBLIC_IDENTITY.packageName)
  assert.equal(packaged.productName, PUBLIC_IDENTITY.productName)
  assert.equal(packaged.version, version)
  assert.equal(packaged.buildProvenance?.sourceHead, source.sourceHead)
  const installedAsarSha256 = await sha256(path)
  const report = { schemaVersion: 1, status: 'failed', startupStatus: 'failed', source, arch: process.arch, version,
    installer: { name, sha256: digest, size }, installed: { bundleId: info.CFBundleIdentifier, installedArch,
      signature: 'verified', notarization: 'staple-verified', asarSha256: installedAsarSha256 },
    observations: [], nativeFilePaste: { status: 'not-run' } }
  try {
    for (const expected of [{ locale: 'en', htmlLang: 'en', theme: 'light' }, { locale: 'zh', htmlLang: 'zh-CN', theme: 'dark' }]) {
      const onWorkbench = expected.locale === 'zh' ? async (cdp, paths) => {
        try {
          await verifyMacFilePaste(cdp, paths, report.nativeFilePaste)
          report.nativeFilePaste.status = 'passed'
        } catch (error) {
          report.nativeFilePaste.status = 'failed'
          report.nativeFilePaste.error = error.message
        }
      } : undefined
      report.observations.push(await observeInstalledStartup({ executable, version, evidenceDir, temporary }, expected,
        { connectCdp, environmentForRoot: isolatedMacEnvironment, onWorkbench }))
    }
    assert.equal(await sha256(path), installedAsarSha256)
    report.startupStatus = 'passed'
    assert.equal(report.nativeFilePaste.status, 'passed', report.nativeFilePaste.error ?? 'Native Mac PDF paste did not run')
    report.status = 'passed'
  } catch (error) {
    report.error = error.message
    throw error
  } finally {
    await writeFile(join(evidenceDir, 'mac-startup-appearance.json'), `${JSON.stringify(report, null, 2)}\n`)
  }
}

async function main([mode, directory, source, evidenceDir, arch]) {
  assert.equal(process.platform, 'darwin')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.RUNNER_OS, 'macOS')
  if (mode === '--prepare') {
    assert.equal(process.arch, evidenceDir)
    return prepare(directory, source)
  }
  assert.equal(mode, '--run')
  assert.equal(process.arch, arch)
  const temporary = resolve(process.env.RUNNER_TEMP)
  for (const path of [directory, source, evidenceDir]) {
    const child = relative(temporary, resolve(path))
    assert.ok(child && !child.startsWith('..') && !isAbsolute(child), 'macOS acceptance paths must be owned by the runner')
  }
  return verify(directory, source, evidenceDir, temporary)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2))
