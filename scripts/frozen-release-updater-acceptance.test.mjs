import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse, stringify } from 'yaml'
import { parseByteRange, startFrozenReleaseFeed, validateFrozenFeed } from './frozen-release-updater-feed.mjs'
import { assertHistoricalRowsPreserved, assertRetainedFiles, snapshotFiles } from './frozen-release-updater-data.mjs'
import { BASELINE_PINS, CLOUDFLARED_PINS, assertFreshProfile, downloadPinned, productPaths, requireFrozenRunner, sanitizeRetainedText, stopOwnedApplications, validateNativeReport, validatePublicBundle, validateTunnelUrl } from './run-frozen-release-updater-acceptance.mjs'
import { expectedReleaseFiles, PUBLIC_IDENTITY, RELEASE_REPOSITORY, validateReviewedBuild } from './verify-reviewed-release-artifacts.mjs'

function temporary(t) { const root = mkdtempSync(join(tmpdir(), 'railwise-frozen-updater-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root }
function fixture(t) {
  const root = temporary(t); const zipPath = join(root, 'WorkWise-0.5.3-mac-arm64.zip'); const manifestPath = join(root, 'latest-mac.yml')
  const bytes = Buffer.from('test-only HTTP transport bytes, not a signed application or native updater test')
  writeFileSync(zipPath, bytes)
  const sha512 = createHash('sha512').update(bytes).digest('base64')
  const manifest = { version: '0.5.3', files: [{ url: 'WorkWise-0.5.3-mac-arm64.zip', sha512, size: bytes.length }], path: 'WorkWise-0.5.3-mac-arm64.zip', sha512 }
  const save = () => writeFileSync(manifestPath, stringify(manifest))
  save(); return { root, bytes, manifest, save, options: { zipPath, manifestPath, version: '0.5.3', arch: 'arm64' } }
}
function request(url, options = {}) {
  return new Promise((resolveRequest, reject) => {
    const call = httpRequest(url, options, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolveRequest({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) })) })
    call.once('error', reject); call.end()
  })
}

test('historical public updater runs only in its trusted fresh hosted macOS workflow', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'macOS', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: '/runner/temp', GITHUB_REPOSITORY: RELEASE_REPOSITORY, GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/.github/workflows/frozen-release-updater-acceptance.yml@refs/heads/main` }
  assert.doesNotThrow(() => requireFrozenRunner(env, 'darwin', '/Users/runner'))
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_TEMP: 'relative' }, { GITHUB_REPOSITORY: 'attacker/repo' }, { GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/.github/workflows/other.yml@refs/heads/main` }, { GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/.github/workflows/frozen-release-updater-acceptance.yml@refs/heads/codex/feature` }, { GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/.github/workflows/frozen-release-updater-acceptance.yml@refs/tags/v0.5.3` }, { WORKWISE_CANDIDATE: '1' }, { WORKWISE_UPDATE_URL: 'https://example.test' }, { RELEASE_CHANNEL: 'stable' }]) {
    assert.throws(() => requireFrozenRunner({ ...env, ...patch }, 'darwin', '/Users/runner'))
  }
  assert.throws(() => requireFrozenRunner(env, 'linux', '/Users/runner'))
})

test('existing public, legacy, runtime or updater profiles block acceptance without deleting them', t => {
  const root = temporary(t)
  assert.doesNotThrow(() => assertFreshProfile(root))
  for (const path of productPaths(root)) {
    mkdirSync(path, { recursive: true }); const sentinel = join(path, 'do-not-delete'); writeFileSync(sentinel, 'retained')
    assert.throws(() => assertFreshProfile(root), /Existing product data/)
    assert.equal(readFileSync(sentinel, 'utf8'), 'retained')
    rmSync(path, { recursive: true })
  }
})

test('the exact signed public package identity is preserved across the upgrade', () => {
  const head = 'a'.repeat(40)
  const info = { CFBundleIdentifier: PUBLIC_IDENTITY.bundleId, CFBundleExecutable: PUBLIC_IDENTITY.productName, CFBundleShortVersionString: '0.5.3' }
  const metadata = { name: 'workwise', productName: 'RailWise AI', version: '0.5.3', buildHints: { macSigningEnabled: true, notarizationEnabled: true }, buildProvenance: { sourceHead: head }, updateChannel: 'stable' }
  const updater = { provider: 'generic', url: 'https://www.railwise.cn/downloads/workwise/channels/stable/latest/', updaterCacheDirName: 'workwise-updater' }
  assert.doesNotThrow(() => validatePublicBundle(info, metadata, updater, '0.5.3', head))
  for (const patch of [{ CFBundleIdentifier: PUBLIC_IDENTITY.bundleId + '.candidate' }, { CFBundleExecutable: 'RailWise AI Candidate' }, { CFBundleShortVersionString: '0.5.2' }]) assert.throws(() => validatePublicBundle({ ...info, ...patch }, metadata, updater, '0.5.3', head))
  for (const patch of [{ name: 'workwise-private' }, { productName: 'WorkWise' }, { buildProvenance: { sourceHead: 'b'.repeat(40) } }, { buildHints: { macSigningEnabled: false, notarizationEnabled: true } }, { updateChannel: 'frontier' }]) assert.throws(() => validatePublicBundle(info, { ...metadata, ...patch }, updater, '0.5.3', head))
  for (const patch of [{ url: 'https://127.0.0.1/' }, { updaterCacheDirName: 'candidate-cache' }, { provider: 'github' }]) assert.throws(() => validatePublicBundle(info, metadata, { ...updater, ...patch }, '0.5.3', head))
})

test('reviewed build inputs require immutable artifact IDs/digests and the exact 0.5.3 file set', () => {
  const head = 'a'.repeat(40)
  const build = { repository: RELEASE_REPOSITORY, workflowPath: '.github/workflows/release.yml', sourceHead: head, runId: 123, runAttempt: 1, publicIdentity: PUBLIC_IDENTITY,
    artifacts: [{ name: 'release-mac', id: 321, digest: `sha256:${'b'.repeat(64)}` }, { name: 'release-win', id: 322, digest: `sha256:${'c'.repeat(64)}` }], files: expectedReleaseFiles('0.5.3').map(file => ({ ...file, size: 1, sha256: 'd'.repeat(64) })) }
  assert.doesNotThrow(() => validateReviewedBuild(build, { version: '0.5.3', sourceHead: head }))
  for (const modify of [b => { b.artifacts[0].id = -1 }, b => { delete b.artifacts[0].digest }, b => { b.files[0].name = 'WorkWise-0.5.2-mac-arm64.dmg' }, b => { b.workflowPath = '.github/workflows/attacker.yml' }]) {
    const copy = structuredClone(build); modify(copy); assert.throws(() => validateReviewedBuild(copy, { version: '0.5.3', sourceHead: head }))
  }
})

test('frozen feed rejects wrong versions, duplicate assets, hash/size changes and links', async t => {
  for (const mutate of [f => { f.manifest.version = '0.5.2' }, f => { f.manifest.files.push(f.manifest.files[0]) }, f => { f.manifest.files[0].sha512 = 'wrong' }, f => { f.manifest.files[0].size++ }, f => { f.manifest.files.push({ url: 'https://example.org/other.zip' }) }]) {
    const f = fixture(t); mutate(f); f.save(); await assert.rejects(validateFrozenFeed(f.options))
  }
  const f = fixture(t); const original = join(f.root, 'original'); writeFileSync(original, f.bytes); rmSync(f.options.zipPath); symlinkSync(original, f.options.zipPath)
  await assert.rejects(validateFrozenFeed(f.options), /regular files/)
})

test('real temporary HTTP origin serves only random capability and exact frozen manifest/ZIP', async t => {
  const f = fixture(t); const feed = await startFrozenReleaseFeed(f.options); t.after(() => feed.close())
  assert.match(feed.prefix, /^\/private-[a-f0-9]{64}\/$/)
  const url = feed.origin + feed.prefix
  const manifest = await request(url + 'latest-mac.yml?noCache=1'); assert.equal(manifest.status, 200)
  assert.deepEqual(parse(manifest.body.toString()), f.manifest)
  const downloaded = await request(url + f.manifest.path); assert.equal(downloaded.status, 200); assert.deepEqual(downloaded.body, f.bytes)
  const partial = await request(url + f.manifest.path, { headers: { Range: 'bytes=2-5' } }); assert.equal(partial.status, 206); assert.deepEqual(partial.body, f.bytes.subarray(2, 6))
  const head = await request(url + f.manifest.path, { method: 'HEAD' }); assert.equal(head.body.length, 0); assert.equal(Number(head.headers['content-length']), f.bytes.length)
  for (const path of ['/latest-mac.yml', feed.prefix + 'missing.zip', feed.prefix + '%6catest-mac.yml', feed.prefix + '../latest-mac.yml', '/private-' + 'a'.repeat(64) + '/latest-mac.yml']) assert.equal((await request(feed.origin + path)).status, 404)
  assert.equal((await request(url + 'latest-mac.yml', { method: 'POST' })).status, 404)
  for (const value of ['bytes=99999-', 'bytes=2-1', 'bytes=-2', 'bytes=0-1,3-4', 'bytes=0-99999']) assert.equal((await request(url + f.manifest.path, { headers: { Range: value } })).status, 416)
  assert.equal(feed.requests.bytesServed, f.bytes.length + 4)
  await feed.close(); await assert.rejects(request(url + 'latest-mac.yml'))
})

test('range parsing accepts only single bounded safe-integer ranges', () => {
  assert.deepEqual(parseByteRange(undefined, 10), { start: 0, end: 9, partial: false })
  assert.deepEqual(parseByteRange('bytes=2-', 10), { start: 2, end: 9, partial: true })
  for (const range of ['bytes=9007199254740993-', 'bytes=-4', 'bytes=1-2,5-6', 'bytes=10-', 'bytes=2-10']) assert.throws(() => parseByteRange(range, 10))
})

test('default-trust tunnel endpoints reject aliases, credentials and unexpected origins', () => {
  assert.equal(validateTunnelUrl('https://ephemeral-words.trycloudflare.com'), 'https://ephemeral-words.trycloudflare.com')
  for (const url of ['http://ephemeral-words.trycloudflare.com', 'https://ephemeral-words.trycloudflare.com.evil.test', 'https://user@ephemeral-words.trycloudflare.com', 'https://ephemeral-words.trycloudflare.com:8443', 'https://ephemeral-words.trycloudflare.com/path', 'https://ephemeral-words.trycloudflare.com?secret=1']) assert.throws(() => validateTunnelUrl(url))
})

test('retained logs/report fields remove feed capabilities, temporary origins and tokens', () => {
  const secret = '/private-' + 'a'.repeat(64) + '/'
  const text = `failed https://ephemeral-words.trycloudflare.com${secret}latest-mac.yml\n${secret}\nBearer-token-sensitive\nAuthorization: Bearer abc123`
  const retained = sanitizeRetainedText(text, [secret], { GH_TOKEN: 'Bearer-token-sensitive' })
  assert.doesNotMatch(retained, /trycloudflare|a{64}|Bearer-token-sensitive|abc123/)
  assert.match(retained, /failed/)
})

test('native round trip requires the real six stages and strict nonce verification', () => {
  const names = ['base_started', 'update_available', 'download_completed', 'install_requested', 'target_relaunched', 'user_data_preserved']
  const report = { schemaVersion: 1, status: 'passed', platform: 'darwin', arch: 'arm64', baseVersion: '0.5.2', targetVersion: '0.5.3', browserOpened: false, userDataPreserved: true, stages: names.map(name => ({ name, detail: name === 'user_data_preserved' ? '0.5.2' : undefined })) }
  assert.doesNotThrow(() => validateNativeReport(report, 'arm64'))
  for (const patch of [{ status: 'failed' }, { baseVersion: '0.0.0' }, { browserOpened: true }, { userDataPreserved: false }, { stages: report.stages.slice(1) }, { stages: report.stages.map(s => s.name === 'user_data_preserved' ? { ...s, detail: 'legacy-state:0.5.2' } : s) }]) assert.throws(() => validateNativeReport({ ...report, ...patch }, 'arm64'))
})

test('native updater cleanup waits for owned applications after SIGTERM', async t => {
  const root = temporary(t); const nativeRoot = join(root, 'native-temp'); const applicationRoot = join(nativeRoot, 'workwise-native-updater-fixture', 'Applications')
  mkdirSync(applicationRoot, { recursive: true })
  let running = new Set([123, 456]); const signals = []; let clock = 0
  const run = () => ({ stdout: [...running].map(pid => `${pid} ${join(applicationRoot, 'RailWise AI.app')}`).join('\n') })
  const kill = (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGTERM') running.delete(pid) }
  await stopOwnedApplications(nativeRoot, run, { kill, sleep: async ms => { clock += ms }, now: () => clock, termTimeoutMs: 10, pollMs: 1 })
  assert.deepEqual(signals, [[123, 'SIGTERM'], [456, 'SIGTERM']])
})

test('native updater cleanup escalates stubborn owned applications to SIGKILL', async t => {
  const root = temporary(t); const nativeRoot = join(root, 'native-temp'); const applicationRoot = join(nativeRoot, 'workwise-native-updater-fixture', 'Applications')
  mkdirSync(applicationRoot, { recursive: true })
  let running = new Set([789]); const signals = []; let clock = 0
  const run = () => ({ stdout: [...running].map(pid => `${pid} ${join(applicationRoot, 'RailWise AI.app')}`).join('\n') })
  const kill = (pid, signal) => { signals.push([pid, signal]); if (signal === 'SIGKILL') running.delete(pid) }
  await stopOwnedApplications(nativeRoot, run, { kill, sleep: async ms => { clock += ms }, now: () => clock, termTimeoutMs: 3, killTimeoutMs: 3, pollMs: 1 })
  assert.deepEqual(signals, [[789, 'SIGTERM'], [789, 'SIGKILL']])
})

test('native updater cleanup reports processes that survive forced termination', async t => {
  const root = temporary(t); const nativeRoot = join(root, 'native-temp'); const applicationRoot = join(nativeRoot, 'workwise-native-updater-fixture', 'Applications')
  mkdirSync(applicationRoot, { recursive: true })
  const signals = []; let clock = 0
  const run = () => ({ stdout: `321 ${join(applicationRoot, 'RailWise AI.app')}` })
  const kill = (pid, signal) => { signals.push([pid, signal]) }
  await assert.rejects(stopOwnedApplications(nativeRoot, run, { kill, sleep: async ms => { clock += ms }, now: () => clock, termTimeoutMs: 3, killTimeoutMs: 3, pollMs: 1 }), /cleanup failed; still running: 321/)
  assert.deepEqual(signals, [[321, 'SIGTERM'], [321, 'SIGKILL']])
})

test('historical database rows and configuration bytes cannot be altered or dropped', t => {
  const before = { 'survey.sqlite3': { survey_networks: { count: 1, sha256: 'abc' } } }
  assert.doesNotThrow(() => assertHistoricalRowsPreserved(before, { ...before, 'new.sqlite3': {} }))
  assert.throws(() => assertHistoricalRowsPreserved(before, { 'survey.sqlite3': {} }))
  assert.throws(() => assertHistoricalRowsPreserved(before, { 'survey.sqlite3': { survey_networks: { count: 0, sha256: 'abc' } } }))
  const root = temporary(t); writeFileSync(join(root, 'mcp.json'), 'inert credential reference'); const snapshot = snapshotFiles(root)
  writeFileSync(join(root, 'added.json'), '{}'); assertRetainedFiles(snapshot, snapshotFiles(root))
  writeFileSync(join(root, 'mcp.json'), 'changed'); assert.throws(() => assertRetainedFiles(snapshot, snapshotFiles(root)))
})

test('pinned asset download validates body size and digest before trusting its bytes', async t => {
  const root = temporary(t); const payload = Buffer.from('test-only network asset pin')
  const sha256 = createHash('sha256').update(payload).digest('hex')
  const fetchOriginal = globalThis.fetch
  t.after(() => { globalThis.fetch = fetchOriginal })
  globalThis.fetch = async () => new Response(payload, { headers: { 'content-length': String(payload.length) } })
  await downloadPinned('https://test.invalid/pinned', join(root, 'valid'), { size: payload.length, sha256 })
  assert.deepEqual(readFileSync(join(root, 'valid')), payload)
  await assert.rejects(downloadPinned('https://test.invalid/pinned', join(root, 'hash-mismatch'), { size: payload.length, sha256: 'a'.repeat(64) }), /SHA256 mismatch/)
  await assert.rejects(downloadPinned('https://test.invalid/pinned', join(root, 'size-mismatch'), { size: payload.length - 1, sha256 }), /Content-Length mismatch/)
  assert.equal(existsSync(join(root, 'size-mismatch')), false)
})

test('workflow is read-only, fresh hosted and preserves only redacted acceptance evidence', () => {
  const workflowPath = new URL('../.github/workflows/frozen-release-updater-acceptance.yml', import.meta.url)
  const text = readFileSync(workflowPath, 'utf8'); const workflow = parse(text)
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' })
  assert.equal(workflow.jobs['native-macos']['runs-on'], 'macos-15')
  assert.equal(workflow.jobs['native-macos'].steps.find(step => step.env?.REVIEWED_BUILD_JSON)?.env.REVIEWED_BUILD_JSON, '${{ inputs.reviewed_build }}')
  assert.doesNotMatch(text, /secrets\.|publish-r2|deploy-website|gh release|--candidate-root|--candidate-source-head/)
  const script = readFileSync(new URL('./run-frozen-release-updater-acceptance.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(script, /add-trusted-cert|authorizationdb|NODE_TLS_REJECT_UNAUTHORIZED|ignore-certificate-errors|rejectUnauthorized:\s*false|--candidate-root|--candidate-source-head|--certificate-sha256/)
  assert.match(script, /verifyReviewedBuildSource/)
  assert.match(script, /Installed\/exact frozen ZIP ASAR/)
  for (const arch of ['arm64', 'x64']) { assert.match(BASELINE_PINS[arch].sha256, /^[a-f0-9]{64}$/); assert.match(CLOUDFLARED_PINS[arch].sha256, /^[a-f0-9]{64}$/) }
})
