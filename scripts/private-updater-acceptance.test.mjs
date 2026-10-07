import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { get } from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { parse } from 'yaml'
import { startPrivateUpdaterFeed } from './private-updater-feed.mjs'
import { createEvidenceReporter, parseDesignatedRequirement, redactAcceptanceLog, requirePrivateRunner, validateBundleIdentity, validatePrivateUpdateMetadata } from './run-private-macos-updater-acceptance.mjs'
import { validateCandidateAcceptanceRoot } from './run-native-updater-acceptance.mjs'
import { boundedCommand, boundedProcess } from './updater-acceptance-process.mjs'

test('private transport refuses local and self-hosted machines', () => {
  const hosted = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'macOS', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: '/runner/temp' }
  assert.doesNotThrow(() => requirePrivateRunner(hosted, 'darwin'))
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_OS: 'Linux' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_TEMP: '' }]) {
    assert.throws(() => requirePrivateRunner({ ...hosted, ...patch }, 'darwin'))
  }
  assert.throws(() => requirePrivateRunner(hosted, 'linux'))
})

test('baseline install scope requires a dedicated runner directory and candidate.env', () => {
  const root = mkdtempSync(join(tmpdir(), 'workwise-private-updater-'))
  try {
    const env = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'macOS', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: dirname(root) }
    assert.throws(() => validateCandidateAcceptanceRoot(root, env), /environment is missing/)
    writeFileSync(join(root, 'candidate.env'), '')
    assert.equal(validateCandidateAcceptanceRoot(root, env), realpathSync(root))
    for (const path of ['/Applications', join(root, '..'), join(root, 'child'), '/tmp/WorkWise']) assert.throws(() => validateCandidateAcceptanceRoot(path, env))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('isolated package identity rejects public app, stale head and wrong version', () => {
  const head = 'a'.repeat(40)
  const info = { CFBundleIdentifier: `com.wangjiawei508.workwise.candidate.head${head.slice(0, 12)}`, CFBundleExecutable: `RailWise AI Candidate ${head.slice(0, 12)}`, CFBundleShortVersionString: '0.5.0' }
  assert.doesNotThrow(() => validateBundleIdentity(info, head, '0.5.0'))
  for (const patch of [{ CFBundleIdentifier: 'com.example.unrelated' }, { CFBundleExecutable: 'WorkWise' }, { CFBundleShortVersionString: '0.0.0' }]) assert.throws(() => validateBundleIdentity({ ...info, ...patch }, head, '0.5.0'))
  assert.throws(() => validateBundleIdentity(info, 'b'.repeat(40), '0.5.0'))
})

test('packaged feed validation rejects external URLs, comment spoofing and shared caches', () => {
  const head = 'a'.repeat(40)
  const metadata = `provider: generic\nurl: https://127.0.0.1/\nupdaterCacheDirName: workwise-private-updater-aaaaaaaaaaaa-updater\n`
  assert.doesNotThrow(() => validatePrivateUpdateMetadata(metadata, head))
  for (const malformed of [
    metadata.replace('url: https://127.0.0.1/', 'url: https://example.org/\n# https://127.0.0.1/'),
    metadata.replace('provider: generic', 'provider: github'),
    metadata.replace('https://127.0.0.1/', 'https://127.0.0.1.evil.test/'),
    metadata.replace('https://127.0.0.1/', 'https://example-user@127.0.0.1/'),
    metadata.replace('workwise-private-updater-aaaaaaaaaaaa-updater', 'shared-updater')
  ]) assert.throws(() => validatePrivateUpdateMetadata(malformed, head))
})

test('codesign requirements are read from stdout independently of stderr diagnostics', () => {
  const requirement = 'designated => identifier "com.example.candidate" and anchor apple generic'
  assert.equal(parseDesignatedRequirement({ status: 0, stdout: requirement + '\n', stderr: 'Executable=/candidate.app/Contents/MacOS/candidate\n' }), requirement)
  assert.equal(parseDesignatedRequirement({ status: 0, stdout: '', stderr: requirement }), requirement)
  assert.throws(() => parseDesignatedRequirement({ status: 1, stdout: requirement, stderr: '' }))
  assert.throws(() => parseDesignatedRequirement({ status: 0, stdout: 'designated => ', stderr: '' }))
  assert.throws(() => parseDesignatedRequirement({ status: 0, stdout: requirement, stderr: 'designated => identifier "com.example.other"' }))
})

test('actual macOS codesign display yields a designated requirement without mutating the executable', { skip: process.platform !== 'darwin' }, () => {
  const result = spawnSync('/usr/bin/codesign', ['-d', '-r-', '/usr/bin/true'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^designated => /m)
  assert.match(parseDesignatedRequirement(result), /^designated => /)
})

test('hung commands are forcibly terminated and their timeout evidence survives', () => {
  const root = mkdtempSync(join(tmpdir(), 'updater-timeout-test-'))
  try {
    const path = join(root, 'report.json')
    const report = { status: 'running' }
    const progress = createEvidenceReporter(path, report)
    assert.equal(JSON.parse(readFileSync(path)).status, 'running')
    const started = Date.now()
    assert.throws(() => boundedCommand(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { timeoutMs: 100, progress }), /timed out/)
    assert.ok(Date.now() - started < 5_000)
    const persisted = JSON.parse(readFileSync(path))
    assert.equal(persisted.steps.at(-1).status, 'timed-out')
    assert.equal(persisted.steps.at(-1).signal, 'SIGKILL')
    assert.equal(persisted.steps[0].status, 'started')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('outer harness timeout rejects promptly and retains a timed-out checkpoint', async () => {
  const events = []
  await assert.rejects(boundedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 100, progress: event => events.push(event)
  }), /timed out/)
  assert.equal(events.some(event => event.status === 'timed-out'), true)
  assert.equal(events.some(event => event.status === 'completed'), false)
})

test('private runner never changes macOS trust or disables TLS validation', () => {
  const source = readFileSync(new URL('./run-private-macos-updater-acceptance.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /add-trusted-cert|authorizationdb|NODE_TLS_REJECT_UNAUTHORIZED|ignore-certificate-errors|rejectUnauthorized:\s*false/)
})

test('retained logs redact secrets, credentials, private keys and the random feed path', () => {
  const pemBoundary = '-'.repeat(5)
  const log = `updater failed; build-key-123; Authorization: Bearer aaa; password="bbb"\n${pemBoundary}BEGIN PRIVATE KEY${pemBoundary}\nxxx\n${pemBoundary}END PRIVATE KEY${pemBoundary}\n/private-` + 'a'.repeat(64) + '/latest-mac.yml'
  const output = redactAcceptanceLog(log, { APPLE_API_KEY: 'build-key-123' })
  assert.doesNotMatch(output, /build-key-123|aaa|bbb|xxx|a{64}/)
  assert.match(output, /updater failed/)
})

test('release dispatch private mode excludes public jobs even with conflicting switches', () => {
  const release = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  const evaluate = (expression, inputs) => Function('github', 'inputs', `return (${expression.slice(3, -2)})`)({ event_name: 'workflow_dispatch' }, inputs)
  const inputs = {
    private_updater_acceptance: true, isolated_survey_candidate: true, run_updater_acceptance: true,
    cleanup_acceptance_run_id: '123', repair_website_cache: true, repair_website_cache_mode: 'apply',
    repair_website_cache_confirmation: 'REPAIR-WORKWISE-METADATA-CACHE', rollback_stable_tag: 'v0.5.0',
    rollback_stable_confirmation: 'ROLLBACK-STABLE-TO-v0.5.0', skip_stability: true, candidate_only: false
  }
  assert.equal(evaluate(release.jobs['private-updater-acceptance'].if, inputs), true)
  for (const name of ['isolated-survey-candidate', 'native-updater-acceptance', 'cleanup-updater-acceptance', 'repair-website-cache', 'rollback-stable', 'prepare']) {
    assert.equal(evaluate(release.jobs[name].if, inputs), false, name)
  }
  assert.equal(release.jobs['private-updater-acceptance'].permissions.contents, 'read')
  const privateWorkflow = parse(readFileSync(new URL('../.github/workflows/private-updater-acceptance.yml', import.meta.url), 'utf8'))
  assert.ok(privateWorkflow.jobs['native-macos']['timeout-minutes'] >= 150, 'two notarizations plus setup and updater execution need a 150-minute runner budget')
  const privateWorkflowSource = readFileSync(new URL('../.github/workflows/private-updater-acceptance.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(privateWorkflowSource, /publish-r2|deploy-website|secrets\.R2_|secrets\.WORKWISE_WEBSITE_|--publish always|gh release/)
  assert.match(privateWorkflowSource, /--publish never/)
})

function request(url, options = {}) {
  return new Promise((resolveRequest, reject) => {
    get(url, { agent: false, ...options }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolveRequest({ status: response.statusCode, body: Buffer.concat(chunks), headers: response.headers }))
    }).once('error', reject)
  })
}

test('real HTTPS transport serves only immutable candidate assets and verifies hashes/ranges', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-feed-test-'))
  let feed
  try {
    const key = join(root, 'key.pem'); const cert = join(root, 'cert.pem'); const config = join(root, 'openssl.cnf')
    writeFileSync(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n')
    const result = spawnSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-x509', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-config', config], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const zipPath = join(root, 'WorkWise-Candidate-aaaaaaaaaaaa-0.5.0-mac-arm64.zip')
    const bytes = Buffer.from('test-only-transport-bytes; not a signed updater or native acceptance')
    writeFileSync(zipPath, bytes)
    feed = await startPrivateUpdaterFeed({ key, cert, zipPath, version: '0.5.0' })
    assert.equal(new URL(feed.url).hostname, '127.0.0.1')
    await assert.rejects(request(feed.url + 'latest-mac.yml'), /self-signed|unable to verify/)
    const options = { ca: readFileSync(cert) }
    const metadata = await request(feed.url + 'latest-mac.yml?noCache=1', options)
    assert.equal(metadata.status, 200)
    const manifest = parse(metadata.body.toString())
    assert.equal(manifest.sha512, createHash('sha512').update(bytes).digest('base64'))
    const downloaded = await request(feed.url + manifest.files[0].url, options)
    assert.deepEqual(downloaded.body, bytes)
    const partial = await request(feed.url + manifest.files[0].url, { ...options, headers: { Range: 'bytes=2-5' } })
    assert.equal(partial.status, 206); assert.deepEqual(partial.body, bytes.subarray(2, 6))
    assert.equal((await request(feed.url + manifest.files[0].url, { ...options, headers: { Range: 'bytes=9999-' } })).status, 416)
    assert.equal((await request(new URL('/latest-mac.yml', feed.url), options)).status, 404)
    assert.equal((await request(feed.url + '../key.pem', options)).status, 404)
    assert.equal((await request(feed.url + 'missing.zip', options)).status, 404)
    assert.ok(feed.requests.zip >= 2)
  } finally { await feed?.close(); rmSync(root, { recursive: true, force: true }) }
})
