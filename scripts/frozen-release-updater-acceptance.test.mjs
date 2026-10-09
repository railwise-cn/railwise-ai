import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parse, stringify } from 'yaml'
import { parseByteRange, startFrozenReleaseFeed, validateFrozenFeed } from './frozen-release-updater-feed.mjs'
import { assertHistoricalRowsPreserved, assertRetainedFiles, fixtureServiceIdentity, persistedJsonValue, prepareCompatibilityService, resolveFixtureService, SERVICE_MODULES, snapshotFiles, validateFixtureExecution } from './frozen-release-updater-data.mjs'
import { BASELINE_PINS, CLOUDFLARED_PINS, assertFreshProfile, downloadPinned, productPaths, requireFrozenRunner, retainNativeUpdaterReport, sanitizeRetainedText, stopOwnedApplications, validateNativeReport, validatePublicBundle, validateTunnelUrl, validateUpdaterBuildProvenance, waitForFrozenManifest, waitForTunnelConnection } from './run-frozen-release-updater-acceptance.mjs'
import { expectedReleaseFiles, PUBLIC_IDENTITY, RELEASE_REPOSITORY, validateReviewedBuild } from './verify-reviewed-release-artifacts.mjs'

function temporary(t) { const root = mkdtempSync(join(tmpdir(), 'railwise-frozen-updater-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root }
function hostedEnvironment() {
  return { GITHUB_ACTIONS: 'true', RUNNER_OS: 'macOS', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: '/runner/temp', GITHUB_REPOSITORY: RELEASE_REPOSITORY,
    GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/.github/workflows/frozen-release-updater-acceptance.yml@refs/heads/main`,
    GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_WORKFLOW_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }
}
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

function serviceLayout(app, layout, modules = SERVICE_MODULES) {
  const root = join(app, 'Contents/Resources', layout === 'asar-unpacked' ? 'app.asar.unpacked/kun' : 'app.asar/kun')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  for (const path of modules) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), 'export const unitFixtureOnly = true\n') }
  return root
}

test('target readback uses the complete actual unpacked bundle and supports complete legacy ASAR layout', t => {
  const app = join(temporary(t), 'Unit fixture.app')
  const compatibilityRoot = serviceLayout(join(temporary(t), 'Checkout fixture.app'), 'asar')
  const legacy = serviceLayout(app, 'asar')
  assert.equal(resolveFixtureService({ app, mode: 'verify', compatibilityRoot }).root, legacy)
  const unpacked = serviceLayout(app, 'asar-unpacked')
  for (const mode of ['verify', 'inspect']) assert.deepEqual(resolveFixtureService({ app, mode, compatibilityRoot }), {
    root: unpacked, layout: 'asar-unpacked', present: [true, true], serviceSource: 'target-package'
  })
  assert.deepEqual(resolveFixtureService({ app, mode: 'seed', compatibilityRoot }), {
    root: compatibilityRoot, layout: 'source-compatibility', serviceSource: 'source-bound-compatibility-service'
  })
  assert.throws(() => resolveFixtureService({ app, mode: 'seed' }), /must be built/)
})

test('target missing services and partial/mixed layouts never fall back to a complete checkout', t => {
  const compatibilityRoot = serviceLayout(join(temporary(t), 'Checkout fixture.app'), 'asar')
  const app = join(temporary(t), 'Unit fixture.app')
  for (const mode of ['verify', 'inspect']) assert.throws(() => resolveFixtureService({ app, mode, compatibilityRoot }), /fallback is forbidden/)
  assert.equal(resolveFixtureService({ app, mode: 'seed', compatibilityRoot }).serviceSource, 'source-bound-compatibility-service')
  serviceLayout(app, 'asar-unpacked', [SERVICE_MODULES[0]])
  serviceLayout(app, 'asar', [SERVICE_MODULES[1]])
  for (const mode of ['seed', 'verify', 'inspect']) assert.throws(() => resolveFixtureService({ app, mode, compatibilityRoot }), /Incomplete packaged/)
  serviceLayout(app, 'asar')
  assert.throws(() => resolveFixtureService({ app, mode: 'verify', compatibilityRoot }), /Incomplete packaged/)
  assert.throws(() => resolveFixtureService({ app, mode: 'invalid', compatibilityRoot }), /mode/)
})

test('baseline compatibility cannot run without explicitly built services', t => {
  const app = join(temporary(t), 'Unit fixture.app')
  assert.throws(() => resolveFixtureService({ app, mode: 'seed' }), /must be built/)
  assert.throws(() => prepareCompatibilityService(app, temporary(t), join(temporary(t), 'staging')), /must be built/)
})

test('baseline compatibility stages frozen services with the baseline SQLite package', t => {
  const root = realpathSync(temporary(t)); const app = join(root, 'Baseline.app'); const resources = join(app, 'Contents/Resources')
  const baselineAsar = join(resources, 'app.asar'); const baselineSqlite = join(baselineAsar, 'node_modules/better-sqlite3')
  const checkout = join(root, 'Checkout'); const checkoutSqlite = join(checkout, 'node_modules/better-sqlite3')
  const destination = join(root, 'staged-compatibility')
  mkdirSync(join(baselineSqlite, 'lib'), { recursive: true }); mkdirSync(join(baselineSqlite, 'build/Release'), { recursive: true })
  writeFileSync(join(baselineAsar, 'package.json'), JSON.stringify({ name: 'baseline', type: 'commonjs' }))
  writeFileSync(join(baselineSqlite, 'package.json'), JSON.stringify({ name: 'better-sqlite3', main: 'lib/index.js' }))
  writeFileSync(join(baselineSqlite, 'lib/index.js'), "module.exports = class Database { prepare(sql) { if (sql !== 'SELECT 1 AS value') throw new Error('unexpected query'); return { get: () => ({ value: 1 }) } } close() {} }\n")
  const nativeBytes = Buffer.from('baseline SQLite ABI fixture bytes')
  writeFileSync(join(baselineSqlite, 'build/Release/better_sqlite3.node'), nativeBytes)
  mkdirSync(join(checkout, 'dist/engineering'), { recursive: true }); mkdirSync(join(checkoutSqlite, 'lib'), { recursive: true }); mkdirSync(join(checkoutSqlite, 'build/Release'), { recursive: true })
  writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'checkout', type: 'module' }))
  writeFileSync(join(checkout, 'dist/engineering/engineering-service.js'), 'export const service = "frozen"\n')
  writeFileSync(join(checkout, 'dist/engineering/survey-service.js'), 'export const service = "frozen"\n')
  writeFileSync(join(checkoutSqlite, 'package.json'), JSON.stringify({ name: 'better-sqlite3', main: 'lib/index.js' }))
  writeFileSync(join(checkoutSqlite, 'lib/index.js'), 'throw new Error("checkout SQLite must not be used")\n')
  writeFileSync(join(checkoutSqlite, 'build/Release/better_sqlite3.node'), 'checkout ABI must not be copied')

  prepareCompatibilityService(app, checkout, destination)
  assert.equal(readFileSync(join(destination, 'dist/engineering/survey-service.js'), 'utf8'), 'export const service = "frozen"\n')
  assert.deepEqual(readFileSync(join(destination, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')), nativeBytes)
  const stagedRequire = createRequire(join(destination, 'package.json'))
  assert.equal(stagedRequire.resolve('better-sqlite3'), join(destination, 'node_modules/better-sqlite3/lib/index.js'))
  const database = new (stagedRequire('better-sqlite3'))(':memory:')
  assert.equal(database.prepare('SELECT 1 AS value').get().value, 1)
  database.close()
})

test('JSON snapshot equality ignores only non-persisted undefined properties while preserving changed values', () => {
  const baseline = { x: 50, metadata: { parser: 'cosa' } }
  assert.deepEqual(persistedJsonValue({ ...baseline, optional: undefined, metadata: { parser: 'cosa', converterId: undefined } }), baseline)
  for (const changed of [{ ...baseline, x: 51 }, { ...baseline, optional: null }, { ...baseline, metadata: { parser: 'different' } }]) {
    assert.notDeepEqual(persistedJsonValue(changed), baseline)
  }
})

test('fixture execution binds the real selected executable, target version and frozen source', t => {
  const root = temporary(t); const app = join(root, 'Unit fixture.app'); const executable = join(app, 'Contents/MacOS/RailWise AI')
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true }); writeFileSync(executable, 'unit fixture executable')
  const head = 'a'.repeat(40); const metadata = { version: '0.5.3', buildProvenance: { sourceHead: head } }
  assert.doesNotThrow(() => validateFixtureExecution(app, executable, metadata, 'verify', head))
  const other = join(root, 'Other executable'); writeFileSync(other, 'unit fixture executable')
  assert.throws(() => validateFixtureExecution(app, other, metadata, 'verify', head), /selected packaged/)
  assert.throws(() => validateFixtureExecution(app, executable, { ...metadata, version: '0.5.2' }, 'verify', head), /version/)
  assert.throws(() => validateFixtureExecution(app, executable, metadata, 'verify', 'b'.repeat(40)), /source/)
  assert.throws(() => validateFixtureExecution(app, executable, metadata, 'verify', undefined), /frozen source/)
  assert.doesNotThrow(() => validateFixtureExecution(app, executable, { version: '0.5.2' }, 'seed', head))
})

test('service identity fails closed when a dependency is missing or resolves outside the bundle', t => {
  const app = join(temporary(t), 'Unit fixture.app'); const root = serviceLayout(app, 'asar-unpacked')
  const selection = resolveFixtureService({ app, mode: 'verify' })
  const options = { app, selection, metadata: { version: '0.5.3', buildProvenance: { sourceHead: 'a'.repeat(40) } }, sourceHead: 'a'.repeat(40) }
  assert.throws(() => fixtureServiceIdentity(options), /outside its selected package|Cannot find module/)
  const external = temporary(t); mkdirSync(join(external, 'lib'), { recursive: true })
  writeFileSync(join(external, 'package.json'), JSON.stringify({ main: 'lib/index.js' })); writeFileSync(join(external, 'lib/index.js'), 'module.exports = {}')
  mkdirSync(join(root, 'node_modules')); symlinkSync(external, join(root, 'node_modules/better-sqlite3'))
  assert.throws(() => fixtureServiceIdentity(options), /outside its selected package/)
})

test('package identity covers transitive service files and both ESM and CJS dependency files', t => {
  const app = join(realpathSync(temporary(t)), 'Unit fixture.app'); const root = serviceLayout(app, 'asar-unpacked')
  for (const name of ['better-sqlite3', 'jszip', 'pdfkit', 'zod']) {
    const packageRoot = join(root, 'node_modules', name); mkdirSync(join(packageRoot, 'lib'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name, main: 'lib/index.cjs' }))
    writeFileSync(join(packageRoot, 'lib/index.cjs'), 'module.exports = {}')
    writeFileSync(join(packageRoot, 'lib/index.js'), 'export const fixture = true')
  }
  const native = join(root, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')
  mkdirSync(join(native, '..'), { recursive: true }); writeFileSync(native, 'unit-only fake native bytes; not executable')
  const options = { app, selection: resolveFixtureService({ app, mode: 'verify' }), metadata: { version: '0.5.3', buildProvenance: { sourceHead: 'a'.repeat(40) } }, sourceHead: 'a'.repeat(40), diskRead: () => Buffer.from('unit-only fake archive bytes') }
  const before = fixtureServiceIdentity(options)
  const zod = before.dependencies.find(item => item.name === 'zod')
  assert.match(zod.path, /zod\/package\.json$/)
  writeFileSync(join(root, 'node_modules/zod/lib/index.js'), 'export const fixture = false')
  writeFileSync(join(root, 'dist/engineering/transitive-helper.js'), 'export const helper = true')
  const after = fixtureServiceIdentity(options)
  assert.deepEqual(after.modules, before.modules)
  assert.notEqual(after.serviceTreeSha256, before.serviceTreeSha256)
  assert.equal(after.dependencies.find(item => item.name === 'zod').sha256, zod.sha256)
  assert.notEqual(after.dependencies.find(item => item.name === 'zod').treeSha256, zod.treeSha256)
})

test('historical public updater runs only in its trusted fresh hosted macOS workflow', () => {
  const env = hostedEnvironment()
  assert.doesNotThrow(() => requireFrozenRunner(env, 'darwin', '/Users/runner'))
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { RUNNER_TEMP: 'relative' }, { GITHUB_REPOSITORY: 'attacker/repo' }, { GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/.github/workflows/other.yml@refs/heads/main` }, { GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/.github/workflows/frozen-release-updater-acceptance.yml@refs/heads/codex/feature` }, { GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/.github/workflows/frozen-release-updater-acceptance.yml@refs/tags/v0.5.3` }, { WORKWISE_CANDIDATE: '1' }, { WORKWISE_UPDATE_URL: 'https://example.test' }, { RELEASE_CHANNEL: 'stable' }]) {
    assert.throws(() => requireFrozenRunner({ ...env, ...patch }, 'darwin', '/Users/runner'))
  }
  assert.throws(() => requireFrozenRunner(env, 'linux', '/Users/runner'))
})

test('hosted updater provenance identifies the exact main workflow execution and rejects malformed or mixed revisions', () => {
  const env = hostedEnvironment()
  assert.deepEqual(requireFrozenRunner(env, 'darwin', '/Users/runner'), {
    repository: RELEASE_REPOSITORY, workflowPath: '.github/workflows/frozen-release-updater-acceptance.yml', workflowRef: env.GITHUB_WORKFLOW_REF,
    workflowSha: env.GITHUB_WORKFLOW_SHA, sourceHead: env.GITHUB_SHA, runId: 123, runAttempt: 2
  })
  const patches = [{ GITHUB_REF: 'refs/tags/v0.5.3' }, { GITHUB_REF: 'refs/heads/codex/feature' }, { GITHUB_REF: undefined },
    { GITHUB_SHA: undefined }, { GITHUB_SHA: 'not-a-sha', GITHUB_WORKFLOW_SHA: 'not-a-sha' }, { GITHUB_SHA: 'A'.repeat(40), GITHUB_WORKFLOW_SHA: 'A'.repeat(40) },
    { GITHUB_WORKFLOW_SHA: undefined }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }]
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) for (const value of [undefined, '', '0', '-1', '1.5', '1e2', '0x10', ' 2', '02', '9007199254740993']) patches.push({ [name]: value })
  for (const patch of patches) assert.throws(() => requireFrozenRunner({ ...env, ...patch }, 'darwin', '/Users/runner'), /trusted fresh/)
})

test('a current updater execution cannot accept an older build or another repository', () => {
  const provenance = requireFrozenRunner(hostedEnvironment(), 'darwin', '/Users/runner')
  const build = { repository: RELEASE_REPOSITORY, sourceHead: provenance.sourceHead }
  assert.doesNotThrow(() => validateUpdaterBuildProvenance(provenance, build))
  for (const patch of [{ sourceHead: 'b'.repeat(40) }, { sourceHead: undefined }, { repository: 'other/repo' }]) assert.throws(() => validateUpdaterBuildProvenance(provenance, { ...build, ...patch }), /Updater\/build/)
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

const readinessOrigin = 'https://unit-readiness.trycloudflare.com'
const readinessPrefix = `/private-${'f'.repeat(64)}/`
const readinessBytes = Buffer.from('version: 0.5.3\nunit-test-only: manifest readiness, not updater acceptance\n')
const readinessUrl = readinessOrigin + readinessPrefix + 'latest-mac.yml'
function readinessFixture(fetchImpl, patches = {}) {
  let clock = 0; const events = []; const sleeps = []
  return { events, sleeps, options: { origin: readinessOrigin, prefix: readinessPrefix, manifestSize: readinessBytes.length,
    manifestSha256: createHash('sha256').update(readinessBytes).digest('hex'), isRunning: () => true, progress: event => events.push(event), ...patches },
  timing: { fetchImpl, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms }, timeoutMs: 20, retryMs: 2, requestTimeoutMs: 10, maxAttempts: 10 }, advance: ms => { clock += ms } }
}
function readinessResponse({ bytes = readinessBytes, status = 200, url = readinessUrl, redirected = false, length = bytes.length } = {}) {
  const response = new Response(bytes, { status, headers: { 'content-length': String(length) } })
  Object.defineProperties(response, { url: { value: url }, redirected: { value: redirected } })
  return response
}
function readinessNetworkError(code) {
  return new TypeError(`fetch failed at ${readinessUrl}`, { cause: Object.assign(new Error('private connection details'), { code }) })
}

test('tunnel readiness requires a unique endpoint, live process and registered connection after delayed setup', async () => {
  let clock = 0; let reads = 0; const events = []
  const result = await waitForTunnelConnection({ readLog: () => {
    reads += 1
    return reads === 1 ? 'INF Requesting quick Tunnel' : reads === 2 ? `INF Created ${readinessOrigin}`
      : `INF Created ${readinessOrigin}\n2026-10-09T00:00:00Z INF Registered tunnel connection connIndex=0 protocol=quic`
  }, isRunning: () => true, progress: event => events.push(event) }, { now: () => clock, sleep: async ms => { clock += ms }, timeoutMs: 10, pollMs: 2 })
  assert.equal(result.origin, readinessOrigin); assert.equal(result.attempts, 3); assert.equal(result.elapsedMs, 4)
  assert.deepEqual(events.map(event => event.category), ['endpoint-pending', 'connection-pending', 'connected'])
  assert.doesNotMatch(JSON.stringify(events), /trycloudflare|private-|https/)
})

test('tunnel readiness terminates on process exit or changing endpoints and respects its deadline', async () => {
  const log = `INF Created ${readinessOrigin}\nINF Registered tunnel connection connIndex=0`
  await assert.rejects(waitForTunnelConnection({ readLog: () => log, isRunning: () => false }), /tunnel-stopped/)
  await assert.rejects(waitForTunnelConnection({ readLog: () => `${log}\nhttps://changed-origin.trycloudflare.com`, isRunning: () => true }), /tunnel-origin-changed/)
  let clock = 0; const events = []
  await assert.rejects(waitForTunnelConnection({ readLog: () => `INF Created ${readinessOrigin}`, isRunning: () => true, progress: event => events.push(event) },
    { now: () => clock, sleep: async ms => { clock += ms }, timeoutMs: 5, pollMs: 2 }), /tunnel-deadline/)
  assert.equal(clock, 5); assert.equal(events.at(-1).category, 'deadline')
})

test('frozen manifest readiness retries allowlisted DNS, connection and gateway startup failures then verifies exact bytes', async () => {
  const queue = [readinessNetworkError('ENOTFOUND'), readinessNetworkError('ECONNREFUSED'), readinessNetworkError('ECONNRESET'), readinessResponse({ status: 502 }), readinessResponse({ status: 530 }), readinessResponse()]
  const calls = []
  const f = readinessFixture(async (url, options) => {
    calls.push({ url, options }); const next = queue.shift()
    if (next instanceof Error) throw next
    return next
  })
  const result = await waitForFrozenManifest(f.options, f.timing)
  assert.equal(result.attempts, 6); assert.equal(result.elapsedMs, 10)
  assert.deepEqual(f.events.map(event => event.category), ['dns-transient', 'connection-transient', 'connection-transient', 'gateway-transient', 'gateway-transient', 'identity-verified'])
  for (const call of calls) {
    assert.equal(call.url, readinessUrl)
    assert.equal(call.options.redirect, 'manual'); assert.equal(call.options.credentials, 'omit')
    assert.equal(call.options.cache, 'no-store'); assert.ok(call.options.signal instanceof AbortSignal)
    assert.deepEqual(call.options.headers, { 'Accept-Encoding': 'identity' })
    assert.deepEqual(Object.keys(call.options).sort(), ['cache', 'credentials', 'headers', 'redirect', 'signal'])
  }
  assert.doesNotMatch(JSON.stringify(f.events), /trycloudflare|private-|private connection|fetch failed/)
})

test('all explicit transient network codes and gateway statuses remain bounded readiness retries', async () => {
  for (const failure of ['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 502, 503, 504, 530]) {
    let calls = 0
    const f = readinessFixture(async () => { calls += 1; if (calls > 1) return readinessResponse(); if (typeof failure === 'string') throw readinessNetworkError(failure); return readinessResponse({ status: failure }) })
    assert.equal((await waitForFrozenManifest(f.options, f.timing)).attempts, 2, String(failure))
    assert.equal(f.events[0].retryable, true)
  }
})

test('TLS errors outrank nested transient errors and unknown errors never enter readiness retry', async () => {
  const errors = [readinessNetworkError('CERT_HAS_EXPIRED'), readinessNetworkError('ERR_TLS_CERT_ALTNAME_INVALID'), readinessNetworkError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
    new TypeError('fetch failed', { cause: new AggregateError([Object.assign(new Error('retryable'), { code: 'EAI_AGAIN' }), Object.assign(new Error('invalid certificate'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })]) }),
    readinessNetworkError('EACCES'), new TypeError(`unknown failure at ${readinessUrl}`)]
  for (const [index, error] of errors.entries()) {
    let calls = 0; const f = readinessFixture(async () => { calls += 1; throw error })
    await assert.rejects(waitForFrozenManifest(f.options, f.timing), index < 4 ? /tls-verification/ : /network-terminal/)
    assert.equal(calls, 1); assert.deepEqual(f.sleeps, [])
    assert.doesNotMatch(JSON.stringify(f.events), /trycloudflare|private-|invalid certificate|unknown failure/)
  }
  const manyCauses = new AggregateError([...Array.from({ length: 33 }, () => Object.assign(new Error('temporary'), { code: 'EAI_AGAIN' })), readinessNetworkError('CERT_HAS_EXPIRED')])
  const truncated = readinessFixture(async () => { throw manyCauses })
  await assert.rejects(waitForFrozenManifest(truncated.options, truncated.timing), /network-terminal/)
  assert.deepEqual(truncated.sleeps, [])
})

test('redirects, alternate origins/paths, terminal HTTP and manifest identity mismatch fail without retry', async () => {
  const responses = [readinessResponse({ status: 302 }), readinessResponse({ redirected: true }),
    readinessResponse({ url: 'https://different.trycloudflare.com' + readinessPrefix + 'latest-mac.yml' }),
    readinessResponse({ url: readinessOrigin + readinessPrefix + 'other.yml' }), readinessResponse({ status: 404 }), readinessResponse({ status: 429 }),
    readinessResponse({ bytes: Buffer.alloc(readinessBytes.length, 1) }), readinessResponse({ length: readinessBytes.length + 1 }),
    readinessResponse({ bytes: readinessBytes.subarray(1), length: readinessBytes.length }),
    readinessResponse({ bytes: Buffer.concat([readinessBytes, Buffer.from('x')]), length: readinessBytes.length })]
  for (const response of responses) {
    let calls = 0; const f = readinessFixture(async () => { calls += 1; return response })
    await assert.rejects(waitForFrozenManifest(f.options, f.timing), /manifest-(?:redirect|origin-changed|http-status|identity)/)
    assert.equal(calls, 1); assert.deepEqual(f.sleeps, [])
  }
  const encoded = readinessResponse(); encoded.headers.set('content-encoding', 'gzip')
  const f = readinessFixture(async () => encoded)
  await assert.rejects(waitForFrozenManifest(f.options, f.timing), /manifest-identity/); assert.deepEqual(f.sleeps, [])
  const chunked = readinessResponse(); chunked.headers.delete('content-length')
  const accepted = readinessFixture(async () => chunked)
  assert.equal((await waitForFrozenManifest(accepted.options, accepted.timing)).attempts, 1)
})

test('manifest readiness bounds repeated transient failures, attempt count and a stalled response body', async () => {
  let calls = 0; const f = readinessFixture(async () => { calls += 1; throw readinessNetworkError('EAI_AGAIN') })
  await assert.rejects(waitForFrozenManifest(f.options, { ...f.timing, timeoutMs: 5 }), /manifest-deadline/)
  assert.equal(calls, 3); assert.equal(f.sleeps.at(-1), 1); assert.equal(f.events.at(-1).category, 'deadline')
  const limited = readinessFixture(async () => { throw readinessNetworkError('EAI_AGAIN') })
  await assert.rejects(waitForFrozenManifest(limited.options, { ...limited.timing, maxAttempts: 2 }), /manifest-deadline/)
  assert.equal(limited.events.filter(event => event.retryable).length, 2)
  const stalled = readinessFixture(async () => {
    const response = new Response(new ReadableStream({ start() {}, cancel() { return new Promise(() => {}) } }), { headers: { 'content-length': String(readinessBytes.length) } })
    Object.defineProperty(response, 'url', { value: readinessUrl }); return response
  })
  await assert.rejects(waitForFrozenManifest(stalled.options, { ...stalled.timing, maxAttempts: 1, requestTimeoutMs: 2 }), /manifest-deadline/)
  assert.equal(stalled.events[0].category, 'request-timeout')
  const stalledHeaders = readinessFixture(async () => new Promise(() => {}))
  await assert.rejects(waitForFrozenManifest(stalledHeaders.options, { ...stalledHeaders.timing, maxAttempts: 1, requestTimeoutMs: 2 }), /manifest-deadline/)
  assert.equal(stalledHeaders.events[0].category, 'request-timeout')
})

test('default manifest attempts cover the complete timeout at the configured retry interval', async () => {
  let calls = 0
  const f = readinessFixture(async () => { calls += 1; throw readinessNetworkError('ENOTFOUND') })
  await assert.rejects(waitForFrozenManifest(f.options, { ...f.timing, timeoutMs: 120_000, retryMs: 1_000, maxAttempts: undefined }), /manifest-deadline/)
  assert.equal(calls, 120)
  assert.equal(f.sleeps.length, 120)
  assert.ok(f.sleeps.every(ms => ms === 1_000))
  assert.equal(f.events.at(-1).category, 'deadline')
  assert.equal(f.events.at(-1).attempt, 120)
})

test('readiness checks cannot start for an exited tunnel or unbound manifest inputs', async () => {
  let calls = 0; const f = readinessFixture(async () => { calls += 1; return readinessResponse() }, { isRunning: () => false })
  await assert.rejects(waitForFrozenManifest(f.options, f.timing), /tunnel-stopped/); assert.equal(calls, 0)
  let running = true
  const exited = readinessFixture(async () => { running = false; return readinessResponse() }, { isRunning: () => running })
  await assert.rejects(waitForFrozenManifest(exited.options, exited.timing), /tunnel-stopped/)
  for (const patch of [{ prefix: '/public/' }, { manifestSize: 0 }, { manifestSha256: 'wrong' }]) {
    await assert.rejects(waitForFrozenManifest({ ...f.options, ...patch }, f.timing), /manifest-input/)
  }
})

test('retained logs/report fields remove feed capabilities, temporary origins and tokens', () => {
  const secret = '/private-' + 'a'.repeat(64) + '/'
  const text = `failed https://ephemeral-words.trycloudflare.com${secret}latest-mac.yml\n${secret}\nBearer-token-sensitive\nAuthorization: Bearer abc123`
  const retained = sanitizeRetainedText(text, [secret], { GH_TOKEN: 'Bearer-token-sensitive' })
  assert.doesNotMatch(retained, /trycloudflare|a{64}|Bearer-token-sensitive|abc123/)
  assert.match(retained, /failed/)
})

test('native report fingerprint binds the final redacted retained bytes including their newline', t => {
  const root = temporary(t); const source = join(root, 'original.json'); const destination = join(root, 'native-updater.json')
  const secret = 'only-this-run-sensitive-token'
  const original = JSON.stringify({ schemaVersion: 1, status: 'passed', note: `Read ${secret} at https://ephemeral-words.trycloudflare.com/private-${'a'.repeat(64)}/latest-mac.yml` })
  writeFileSync(source, original)
  const fingerprint = retainNativeUpdaterReport(source, destination, [secret], {})
  const retained = readFileSync(destination)
  assert.equal(fingerprint, createHash('sha256').update(retained).digest('hex'))
  assert.notEqual(fingerprint, createHash('sha256').update(original).digest('hex'))
  assert.notEqual(fingerprint, createHash('sha256').update(retained.subarray(0, retained.length - 1)).digest('hex'))
  assert.equal(retained.at(-1), 10)
  assert.doesNotMatch(retained.toString(), /only-this-run-sensitive-token|trycloudflare|a{64}/)
  assert.equal(JSON.parse(retained).status, 'passed')
  writeFileSync(destination, retained.toString().replace('passed', 'failed'))
  assert.notEqual(fingerprint, createHash('sha256').update(readFileSync(destination)).digest('hex'))
})

test('native evidence retention rejects unreadable or linked reports before creating a substitute', t => {
  const root = temporary(t); const source = join(root, 'source.json'); const destination = join(root, 'retained.json')
  assert.throws(() => retainNativeUpdaterReport(source, destination, [], {}), /Required native updater report is missing/)
  assert.equal(existsSync(destination), false)
  for (const text of ['not JSON', JSON.stringify({ padding: 'x'.repeat(260_000) })]) {
    writeFileSync(source, text); assert.throws(() => retainNativeUpdaterReport(source, destination, [], {})); assert.equal(existsSync(destination), false)
  }
  const linked = join(root, 'linked.json'); symlinkSync(source, linked)
  assert.throws(() => retainNativeUpdaterReport(linked, destination, [], {}), /regular JSON/)
  assert.equal(existsSync(destination), false)
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
  const steps = workflow.jobs['native-macos'].steps
  const nativeIdentity = steps.find(step => step.id === 'native-identity')
  assert.match(nativeIdentity.run, /process\.arch/)
  assert.match(nativeIdentity.run, /\['arm64', 'x64'\]/)
  assert.match(nativeIdentity.run, /GITHUB_OUTPUT/)
  const retained = steps.find(step => step.uses === 'actions/upload-artifact@v4')
  assert.equal(retained.with.name, 'frozen-updater-${{ steps.native-identity.outputs.arch }}-${{ github.run_id }}')
  assert.match(retained.with.path, /verify-restart-data\.json/)
  assert.match(retained.with.path, /target-services\.json/)
  const compatibilityBuild = steps.findIndex(step => step.name === 'Build source-bound baseline compatibility services')
  assert.match(steps[compatibilityBuild].run, /npm --prefix kun ci --ignore-scripts/)
  assert.match(steps[compatibilityBuild].run, /npm --prefix kun run build/)
  assert.ok(compatibilityBuild < steps.findIndex(step => step.name?.startsWith('Run default-trust')))
  assert.equal(workflow.jobs['native-macos'].steps.find(step => step.env?.REVIEWED_BUILD_JSON)?.env.REVIEWED_BUILD_JSON, '${{ inputs.reviewed_build }}')
  assert.doesNotMatch(text, /secrets\.|publish-r2|deploy-website|gh release|--candidate-root|--candidate-source-head/)
  const script = readFileSync(new URL('./run-frozen-release-updater-acceptance.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(script, /add-trusted-cert|authorizationdb|NODE_TLS_REJECT_UNAUTHORIZED|ignore-certificate-errors|rejectUnauthorized:\s*false|--candidate-root|--candidate-source-head|--certificate-sha256/)
  assert.match(script, /verifyReviewedBuildSource/)
  assert.match(script, /Installed\/exact frozen ZIP ASAR/)
  for (const arch of ['arm64', 'x64']) { assert.match(BASELINE_PINS[arch].sha256, /^[a-f0-9]{64}$/); assert.match(CLOUDFLARED_PINS[arch].sha256, /^[a-f0-9]{64}$/) }
})
