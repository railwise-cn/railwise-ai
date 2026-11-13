#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const driverFiles = new Set([
  '.github/workflows/release.yml',
  '.github/workflows/windows-install-smoke.yml',
  'scripts/prepare-windows-install-smoke.mjs',
  'scripts/run-windows-install-smoke.ps1',
  'scripts/run-windows-ui-smoke.mjs',
  'scripts/prepare-browser-skill-smoke.mjs',
  'scripts/verify-windows-install-smoke.mjs',
  'scripts/verify-release-approval.mjs',
  'scripts/deploy-website-release.mjs',
  'docs/qa/general-execution-delivery-2026-11-13.md',
  'kun/tests/browser-skill-live.test.ts',
  'src/renderer/src/components/connectors/ManagedLarkConnection.test.ts'
])

export function validateWindowsSmokeSource(source, { packageSourceHead, driverSourceHead } = source) {
  assert.match(source.repository, /^[\w.-]+\/[\w.-]+$/)
  assert.match(source.packageSourceHead, /^[a-f0-9]{40}$/)
  assert.match(source.driverSourceHead, /^[a-f0-9]{40}$/)
  assert.equal(source.packageSourceHead, packageSourceHead)
  assert.equal(source.driverSourceHead, driverSourceHead)
  assert.equal(source.workflow, '.github/workflows/release.yml')
  assert.equal(source.windowsBuildConclusion, 'success')
  assert.match(String(source.runId), /^[1-9]\d*$/)
  assert.match(String(source.runAttempt), /^[1-9]\d*$/)
  assert.match(String(source.artifactId), /^[1-9]\d*$/)
  assert.equal(source.artifactName, 'release-win')
  assert.match(source.artifactDigest, /^sha256:[a-f0-9]{64}$/)
  assert.equal(source.artifactExpired, false)
  assert.ok(Array.isArray(source.changedFiles))
  for (const file of source.changedFiles) {
    assert.ok(driverFiles.has(file) || /^scripts\/[^/]+\.test\.[cm]?js$/.test(file),
      `Packaged application or build source changed since the original package: ${file}`)
  }
  return source
}

export function prepareWindowsInstallSmoke(runId, outputPath, environment = process.env) {
  assert.match(runId, /^[1-9]\d*$/)
  const repository = environment.GITHUB_REPOSITORY
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/)
  const api = path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }))
  const run = api(`repos/${repository}/actions/runs/${runId}`)
  assert.equal(run.repository.full_name, repository)
  assert.equal(run.head_repository.full_name, repository)
  assert.equal(run.path, '.github/workflows/release.yml')
  const jobs = api(`repos/${repository}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`)
  const build = jobs.jobs.find(job => job.name === 'Build Windows')
  assert.equal(build?.conclusion, 'success', 'The original Windows build must have succeeded')
  const artifacts = api(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`)
  const matches = artifacts.artifacts.filter(artifact => artifact.name === 'release-win' && !artifact.expired)
  assert.equal(matches.length, 1, 'Expected one immutable Windows package artifact')
  const artifact = matches[0]
  assert.equal(artifact.workflow_run.head_sha, run.head_sha)
  const driverSourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.equal(driverSourceHead, environment.GITHUB_SHA)
  const changedFiles = execFileSync('git', ['diff', '--name-only', run.head_sha, driverSourceHead], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  const source = validateWindowsSmokeSource({ repository, runId, runAttempt: run.run_attempt,
    workflow: run.path, packageSourceHead: run.head_sha, driverSourceHead,
    windowsBuildConclusion: build.conclusion, artifactId: artifact.id, artifactName: artifact.name,
    artifactDigest: artifact.digest, artifactExpired: artifact.expired, changedFiles })
  writeFileSync(outputPath, `${JSON.stringify(source, null, 2)}\n`, { flag: 'wx' })
  appendFileSync(environment.GITHUB_OUTPUT, `artifact_id=${source.artifactId}\npackage_source_head=${source.packageSourceHead}\n`)
  return source
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareWindowsInstallSmoke(process.argv[2], process.argv[3])
}
