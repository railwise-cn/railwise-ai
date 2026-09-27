#!/usr/bin/env node
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { boundedProcess } from './updater-acceptance-process.mjs'
import { createEvidenceReporter, createPrivateCertificate, requirePrivateRunner } from './run-private-macos-updater-acceptance.mjs'
import { startPrivateUpdaterFeed } from './private-updater-feed.mjs'

const localTransportOnly = process.argv.includes('--local-transport-only')
if (!localTransportOnly) requirePrivateRunner()
const scripts = dirname(fileURLToPath(import.meta.url))
const evidence = resolve(process.argv.find(value => value.startsWith('--evidence-dir='))?.slice('--evidence-dir='.length) ?? '')
const runnerTemp = realpathSync(localTransportOnly ? tmpdir() : process.env.RUNNER_TEMP)
if (!evidence.startsWith(`${runnerTemp}/`)) throw new Error('Preflight evidence must be inside RUNNER_TEMP.')
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const root = mkdtempSync(join(runnerTemp, 'workwise-private-tls-'))
const report = { schemaVersion: 1, status: 'running', scope: 'Electron HTTPS transport preflight only; not native updater acceptance', localTransportOnly, systemTrustModified: false }
const progress = createEvidenceReporter(join(evidence, 'tls-preflight.json'), report)
let feed
try {
  const { certificate, key, certificateSha256 } = createPrivateCertificate(root)
  const zipPath = join(root, 'WorkWise-Candidate-aaaaaaaaaaaa-0.5.0-mac-arm64.zip')
  const expectedBytes = 'private transport preflight; not an application package'
  writeFileSync(zipPath, expectedBytes)
  feed = await startPrivateUpdaterFeed({ cert: certificate, key, zipPath, version: '0.5.0' })
  const helper = join(root, 'private-updater-tls.cjs')
  await build({ entryPoints: [join(scripts, '../src/main/private-updater-tls.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: helper })
  const configPath = join(root, 'probe.json'); const resultPath = join(root, 'result.json')
  writeFileSync(configPath, JSON.stringify({ helper, feedUrl: feed.url, certificateSha256, download: join(root, 'download.zip'), result: resultPath, expectedBytes }), { mode: 0o600 })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const name of Object.keys(env)) if (/(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|CSC_|P12_BASE64)/i.test(name)) delete env[name]
  await boundedProcess(createRequire(import.meta.url)('electron'), [join(scripts, 'private-updater-tls-probe.cjs'), `--user-data-dir=${join(root, 'electron-data')}`, configPath], { timeoutMs: 60_000, env, progress, operation: 'Electron-TLS-transport-probe' })
  const result = JSON.parse(readFileSync(resultPath, 'utf8'))
  if (result.status !== 'passed' || feed.requests.manifest < 1 || feed.requests.zip < 1) throw new Error('TLS preflight did not fetch verified real HTTPS assets.')
  Object.assign(report, result, { feedRequests: feed.requests, certificateSha256 })
} catch (error) {
  report.status = 'failed'; report.failure = error.message
  process.exitCode = 1
} finally {
  try { await feed?.close(); rmSync(root, { recursive: true, force: true }) } catch (error) {
    report.status = 'failed'; report.failure = `${report.failure ?? ''} Cleanup: ${error.message}`.trim(); process.exitCode = 1
  }
  progress({ operation: 'TLS-preflight', status: report.status })
}
