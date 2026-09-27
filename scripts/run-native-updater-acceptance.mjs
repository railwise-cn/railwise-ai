#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boundedCommand } from './updater-acceptance-process.mjs'

export function validateCandidateAcceptanceRoot(root, env = process.env) {
  const prefix = env.RUNNER_TEMP && realpathSync(env.RUNNER_TEMP)
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_OS !== 'macOS' || !prefix
    || env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || !isAbsolute(root) || dirname(realpathSync(root)) !== prefix
    || !/^workwise-private-updater-[A-Za-z0-9]+$/.test(basename(root))) {
    throw new Error('Private candidate acceptance requires a dedicated directory in an ephemeral macOS Actions runner.')
  }
  if (!existsSync(join(root, 'candidate.env'))) throw new Error('Private candidate environment is missing.')
  return realpathSync(root)
}

function argument(name, fallback = '') {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback
}

function required(name) {
  const value = argument(name).trim()
  if (!value) throw new Error(`Missing --${name}=...`)
  return value
}

function progress(event) {
  console.info(`[native-updater] ${event.operation}: ${event.status}`)
}

function run(command, args) {
  boundedCommand(command, args, { stdio: 'inherit', windowsHide: true, progress })
}

function installMac(installer, root, candidateHead = '') {
  if (!installer.toLowerCase().endsWith('.dmg')) throw new Error('macOS base installer must be a DMG.')
  const mount = join(root, 'mount')
  const applications = join(root, 'Applications')
  mkdirSync(mount, { recursive: true })
  mkdirSync(applications, { recursive: true })
  run('hdiutil', ['attach', installer, '-nobrowse', '-readonly', '-mountpoint', mount])
  try {
    const appName = readdirSync(mount).find((name) => name.endsWith('.app'))
    if (!appName) throw new Error('DMG does not contain an application bundle.')
    if (candidateHead && appName !== `RailWise AI Candidate ${candidateHead.slice(0, 12)}.app`) {
      throw new Error('Private acceptance installer has an unexpected candidate identity.')
    }
    const destination = join(applications, appName)
    run('ditto', [join(mount, appName), destination])
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', destination])
    run('spctl', ['--assess', '--type', 'execute', '--verbose=2', destination])
    const updaterMetadata = join(destination, 'Contents', 'Resources', 'app-update.yml')
    if (!existsSync(updaterMetadata)) {
      throw new Error(
        'Installed macOS baseline lacks Contents/Resources/app-update.yml; '
        + 'an updater-disabled candidate cannot be used as a native updater acceptance baseline.'
      )
    }
    return destination
  } finally {
    run('hdiutil', ['detach', mount])
  }
}

function installWindows(installer, root) {
  if (!installer.toLowerCase().endsWith('.exe')) throw new Error('Windows base installer must be an EXE.')
  const destination = join(root, 'app')
  mkdirSync(destination, { recursive: true })
  // NSIS requires /D to be the final argument and does not accept quotes around it.
  run(installer, ['/S', `/D=${destination}`])
  const executableName = readdirSync(destination).find((name) => name.endsWith('.exe'))
  const executable = executableName ? join(destination, executableName) : ''
  if (!executable || !existsSync(executable)) throw new Error(`NSIS did not install an executable in ${destination}`)
  return executable
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function waitForReport(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let latest = null
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        latest = JSON.parse(readFileSync(path, 'utf8'))
        if (latest.status === 'passed' || latest.status === 'failed') return latest
      } catch {
        // Atomic app writes can still race with antivirus/indexer visibility.
      }
    }
    await sleep(2_000)
  }
  throw new Error(`Timed out waiting for updater acceptance report. Last report: ${JSON.stringify(latest)}`)
}

function validateReport(report, expected) {
  if (report.status !== 'passed') throw new Error(`Updater acceptance failed: ${report.failure || 'unknown failure'}`)
  if (report.baseVersion !== expected.baseVersion || report.targetVersion !== expected.targetVersion) {
    throw new Error(`Acceptance version mismatch: ${report.baseVersion} -> ${report.targetVersion}`)
  }
  if (report.platform !== process.platform || report.arch !== process.arch) {
    throw new Error(`Acceptance platform mismatch: ${report.platform}-${report.arch}, runner is ${process.platform}-${process.arch}`)
  }
  if (report.browserOpened !== false) throw new Error('Acceptance report did not prove the no-browser updater path.')
  if (report.userDataPreserved !== true) {
    throw new Error('Acceptance report did not prove that user data survived the native update.')
  }
  const expectedStages = [
    'base_started',
    'update_available',
    'download_completed',
    'install_requested',
    'target_relaunched',
    'user_data_preserved'
  ]
  const stages = report.stages?.map((stage) => stage.name)
  if (JSON.stringify(stages) !== JSON.stringify(expectedStages)) {
    throw new Error(`Acceptance stages are incomplete: ${JSON.stringify(stages)}`)
  }
}

async function main() {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    throw new Error(`Unsupported updater acceptance platform: ${process.platform}`)
  }
  const expectedArch = required('expected-arch')
  if (process.arch !== expectedArch) throw new Error(`Expected ${expectedArch} runner, got ${process.arch}.`)

  const installer = resolve(required('installer'))
  if (!existsSync(installer)) throw new Error(`Base installer does not exist: ${installer}`)
  const feedUrl = required('feed-url').replace(/\/+$/, '') + '/'
  if (!/^https:\/\//i.test(feedUrl)) throw new Error('Test update feed must use HTTPS.')
  const baseVersion = required('base-version')
  const targetVersion = required('target-version')
  const channel = argument('channel', 'frontier')
  if (channel !== 'stable' && channel !== 'frontier') throw new Error('Channel must be stable or frontier.')
  const timeoutMinutes = Number.parseInt(argument('timeout-minutes', '20'), 10)
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) {
    throw new Error('timeout-minutes must be between 1 and 60.')
  }

  const candidateRoot = argument('candidate-root')
  const candidateHead = argument('candidate-source-head')
  const certificateSha256 = argument('certificate-sha256')
  if (certificateSha256 && (!candidateHead || !/^[a-f0-9]{64}$/.test(certificateSha256))) {
    throw new Error('A private certificate pin requires the isolated candidate and a complete SHA256.')
  }
  if (Boolean(candidateRoot) !== Boolean(candidateHead) || (candidateHead && !/^[a-f0-9]{40}$/.test(candidateHead))) {
    throw new Error('Private acceptance requires both candidate-root and the exact candidate source HEAD.')
  }
  const root = candidateRoot
    ? validateCandidateAcceptanceRoot(candidateRoot)
    : mkdtempSync(join(tmpdir(), 'workwise-native-updater-'))
  const reportPath = argument('report')
    ? resolve(argument('report'))
    : join(root, `updater-acceptance-${process.platform}-${process.arch}.json`)
  if (!isAbsolute(reportPath)) throw new Error('Report path must be absolute.')
  mkdirSync(dirname(reportPath), { recursive: true })
  const configPath = join(root, 'acceptance-config.json')
  writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    baseVersion,
    targetVersion,
    channel,
    feedUrl,
    reportPath,
    ...(certificateSha256 ? { privateTls: { certificateSha256, sourceHead: candidateHead } } : {})
  }, null, 2)}\n`, 'utf8')

  const executable = process.platform === 'darwin'
    ? installMac(installer, root, candidateHead)
    : installWindows(installer, root)
  if (candidateHead) {
    // Verify the app actually copied from the DMG, not merely the adjacent
    // unpacked build directory. Keep generic legacy harness runs dependency-free.
    const { verifyBundle } = await import('./run-private-macos-updater-acceptance.mjs')
    verifyBundle(executable, candidateHead, baseVersion, progress)
  }
  const logPath = join(dirname(reportPath), `${basename(reportPath, '.json')}.log`)
  const log = openSync(logPath, 'a')
  const acceptanceArgument = `--workwise-updater-acceptance=${configPath}`
  const launchCommand = process.platform === 'darwin' ? 'open' : executable
  const launchArguments = process.platform === 'darwin'
    ? [
        '-n',
        '--stdout', logPath,
        '--stderr', logPath,
        '--env', 'WORKWISE_STARTUP_TRACE=1',
        ...(certificateSha256 ? ['GITHUB_ACTIONS', 'RUNNER_OS', 'RUNNER_ENVIRONMENT', 'RUNNER_TEMP']
          .flatMap(name => ['--env', `${name}=${process.env[name] ?? ''}`]) : []),
        executable,
        '--args', acceptanceArgument,
        ...(candidateRoot ? [`--workwise-candidate-env-file=${join(root, 'candidate.env')}`] : [])
      ]
    : [acceptanceArgument]
  const child = spawn(launchCommand, launchArguments, {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, WORKWISE_STARTUP_TRACE: '1' }
  })
  child.unref()
  closeSync(log)

  const report = await waitForReport(reportPath, timeoutMinutes * 60_000)
  validateReport(report, { baseVersion, targetVersion })
  console.info(`Updater acceptance passed: ${baseVersion} -> ${targetVersion} on ${process.platform}-${process.arch}`)
  console.info(`Evidence: ${reportPath}`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}
