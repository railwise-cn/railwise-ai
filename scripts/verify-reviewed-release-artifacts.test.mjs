import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { expectedReleaseFiles, PUBLIC_IDENTITY, RELEASE_REPOSITORY, RELEASE_WORKFLOW, RELEASE_WORKFLOW_REF, recordReviewedBuild, validateReviewedBuild, verifyReviewedBuildSource, verifyDownloadedReleaseArtifacts } from './verify-reviewed-release-artifacts.mjs'

const version = '0.5.3'
const sourceHead = 'a'.repeat(40)
const verifySource = head => assert.equal(head, sourceHead)
const require = createRequire(import.meta.url)
const sha = text => createHash('sha256').update(text).digest('hex')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'railwise-frozen-artifacts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const downloads = join(root, 'downloads')
  const output = join(root, 'verified')
  const build = {
    repository: RELEASE_REPOSITORY, workflowPath: RELEASE_WORKFLOW, runId: 123, runAttempt: 2, sourceHead,
    publicIdentity: { ...PUBLIC_IDENTITY },
    artifacts: [{ name: 'release-mac', id: 321, digest: `sha256:${'b'.repeat(64)}` }, { name: 'release-win', id: 322, digest: `sha256:${'c'.repeat(64)}` }],
    files: expectedReleaseFiles(version).map(file => ({ ...file, size: Buffer.byteLength(file.name), sha256: sha(file.name) })),
  }
  const receipts = {}
  for (const artifact of build.artifacts) {
    mkdirSync(join(downloads, artifact.name), { recursive: true })
    const files = build.files.filter(file => file.artifact === artifact.name)
    for (const file of files) writeFileSync(join(downloads, artifact.name, file.name), file.name)
    const platforms = artifact.name === 'release-mac' ? ['darwin-arm64', 'darwin-x64'] : ['win32-x64']
    receipts[artifact.name] = { schemaVersion: 1, purpose: 'frozen-public-release', repository: RELEASE_REPOSITORY,
      workflowPath: RELEASE_WORKFLOW, runId: build.runId, runAttempt: build.runAttempt, sourceHead,
      candidateOnly: true, preparePublicArtifacts: true, publishRelease: false, artifact: artifact.name, version,
      identities: Object.fromEntries(platforms.map(platform => [platform, { ...PUBLIC_IDENTITY, version, sourceHead, updateUrl: 'https://www.railwise.cn/downloads/workwise/channels/stable/latest/' }])),
      files: structuredClone(files) }
  }
  const save = () => {
    for (const [artifact, receipt] of Object.entries(receipts)) writeFileSync(join(downloads, artifact, 'reviewed-build.json'), JSON.stringify(receipt))
  }
  save()
  const verify = () => verifyDownloadedReleaseArtifacts({ build, version, sourceHead, downloads, output })
  return { root, build, downloads, output, receipts, save, verify }
}

function githubFixture(build) {
  const root = `repos/${RELEASE_REPOSITORY}`
  const jobs = ['Build macOS', 'Build Windows', 'Two-hour pre-release stability', 'Verify three-client candidate', 'Verify final candidate on macOS'].map(name => ({ name, conclusion: 'success', steps: [{ name: 'Record frozen public package identity', conclusion: 'success' }] }))
  const responses = {
    [root]: { id: 98, full_name: RELEASE_REPOSITORY },
    [`${root}/actions/workflows/release.yml`]: { id: 55, path: RELEASE_WORKFLOW },
    [`${root}/actions/runs/${build.runId}`]: { id: build.runId, run_attempt: build.runAttempt, workflow_id: 55, path: RELEASE_WORKFLOW, workflow_ref: RELEASE_WORKFLOW_REF, head_branch: 'main', repository: { id: 98 }, head_repository: { id: 98 }, head_sha: sourceHead, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' },
    [`${root}/actions/runs/${build.runId}/attempts/${build.runAttempt}/jobs?per_page=100&page=1`]: { total_count: jobs.length, jobs },
  }
  for (const artifact of build.artifacts) responses[`${root}/actions/artifacts/${artifact.id}`] = { ...artifact, expired: false, workflow_run: { id: build.runId, run_attempt: build.runAttempt, head_sha: sourceHead, repository_id: 98, head_repository_id: 98 } }
  const api = path => { assert.ok(responses[path], `unexpected API request: ${path}`); return responses[path] }
  return { root, responses, jobs, api, run: responses[`${root}/actions/runs/${build.runId}`], artifacts: build.artifacts.map(artifact => responses[`${root}/actions/artifacts/${artifact.id}`]) }
}

test('a frozen exact installer/update file set is copied without changing bytes', async t => {
  const f = fixture(t)
  const result = await f.verify()
  assert.equal(result.files, 8)
  assert.equal(result.runId, 123)
  assert.deepEqual(readdirSync(f.output).sort(), f.build.files.map(file => file.name).sort())
  for (const file of f.build.files) assert.equal(sha(readFileSync(join(f.output, file.name))), file.sha256)
  assert.equal(existsSync(join(f.output, 'reviewed-build.json')), false)
})

test('file tampering, set mismatches and unsafe filesystem entries fail before output', async t => {
  const changes = {
    missing: f => rmSync(join(f.downloads, 'release-win', `WorkWise-${version}-win-x64.exe.blockmap`)),
    extra: f => writeFileSync(join(f.downloads, 'release-win', 'secret.txt'), 'unexpected'),
    nested: f => mkdirSync(join(f.downloads, 'release-win', 'nested')),
    hash: f => writeFileSync(join(f.downloads, 'release-win', 'latest.yml'), 'x'.repeat('latest.yml'.length)),
    size: f => writeFileSync(join(f.downloads, 'release-win', 'latest.yml'), 'bad'),
    duplicateArtifact: f => mkdirSync(join(f.downloads, 'release-other')),
    symlinkFile: f => { const path = join(f.downloads, 'release-win', 'latest.yml'); rmSync(path); symlinkSync('../release-mac/latest-mac.yml', path) },
    symlinkDirectory: f => { rmSync(join(f.downloads, 'release-win'), { recursive: true }); symlinkSync('release-mac', join(f.downloads, 'release-win')) },
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, async st => {
    const f = fixture(st); change(f)
    await assert.rejects(f.verify)
    assert.equal(existsSync(f.output), false)
  })
})

test('reviewed manifest rejects candidates, missing/duplicate/extra files and wrong platform', async t => {
  const changes = {
    candidateBundle: f => { f.build.publicIdentity.bundleId += '.candidate' },
    privateName: f => { f.build.publicIdentity.packageName = 'workwise-private-updater-aaaa' },
    candidateProduct: f => { f.build.publicIdentity.productName = 'RailWise AI Candidate aaaa' },
    missing: f => f.build.files.pop(),
    duplicate: f => { f.build.files[1] = { ...f.build.files[0] } },
    extra: f => f.build.files.push({ ...f.build.files[0], name: 'extra.exe' }),
    privateFilename: f => { f.build.files[0].name = `WorkWise-Candidate-${version}-mac-arm64.dmg` },
    wrongVersion: f => { f.build.files[0].name = 'WorkWise-0.5.2-mac-arm64.dmg' },
    wrongPlatform: f => { f.build.files[0].platform = 'darwin-x64' },
    duplicateArtifactId: f => { f.build.artifacts[1].id = f.build.artifacts[0].id },
    unexpectedArtifact: f => { f.build.artifacts[0].name = 'private-updater-target-arm64' },
    wrongHead: f => { f.build.sourceHead = 'd'.repeat(40) },
    wrongRepo: f => { f.build.repository = 'attacker/railwise-ai' },
    wrongWorkflow: f => { f.build.workflowPath = '.github/workflows/other.yml' },
    missingDigest: f => { delete f.build.artifacts[0].digest },
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, st => {
    const f = fixture(st); change(f)
    assert.throws(() => validateReviewedBuild(f.build, { version, sourceHead }))
  })
})

test('build receipt cannot substitute a different source, candidate or unreviewed bytes', async t => {
  const changes = {
    head: r => { r.sourceHead = 'e'.repeat(40) },
    run: r => { r.runId += 1 },
    attempt: r => { r.runAttempt += 1 },
    notCandidateBuild: r => { r.candidateOnly = false },
    notPublicIdentityBuild: r => { r.preparePublicArtifacts = false },
    publishingBuild: r => { r.publishRelease = true },
    candidateBundle: r => { r.identities['darwin-arm64'].bundleId += '.candidate' },
    privatePackageName: r => { r.identities['darwin-arm64'].packageName += '-private' },
    privateFeed: r => { r.identities['darwin-arm64'].updateUrl = 'https://127.0.0.1/' },
    identityHead: r => { r.identities['darwin-arm64'].sourceHead = 'e'.repeat(40) },
    missingIntel: r => { delete r.identities['darwin-x64'] },
    receiptHash: r => { r.files[0].sha256 = 'f'.repeat(64) },
    duplicateFile: r => { r.files[1] = { ...r.files[0] } },
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, async st => {
    const f = fixture(st); change(f.receipts['release-mac']); f.save()
    await assert.rejects(f.verify)
    assert.equal(existsSync(f.output), false)
  })
})

test('verified output cannot overwrite previous files', async t => {
  const f = fixture(t)
  mkdirSync(f.output); writeFileSync(join(f.output, 'keep'), 'keep')
  await assert.rejects(f.verify, /must not already exist/)
  assert.equal(readFileSync(join(f.output, 'keep'), 'utf8'), 'keep')
})

test('source provenance requires successful trusted workflow and immutable artifact identities', t => {
  const f = fixture(t); const g = githubFixture(f.build)
  assert.equal(verifyReviewedBuildSource(f.build, { version, sourceHead }, g.api), f.build)
})

test('wrong repository, workflow, source, attempt, failed runs and arbitrary artifacts are rejected', async t => {
  const changes = {
    workflowId: g => { g.run.workflow_id += 1 },
    workflowPath: g => { g.run.path = '.github/workflows/other.yml' },
    headBranch: g => { g.run.head_branch = 'codex/feature' },
    workflowRef: g => { g.run.workflow_ref = `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@refs/heads/codex/feature` },
    fork: g => { g.run.head_repository.id += 1 },
    repository: g => { g.run.repository.id += 1 },
    source: g => { g.run.head_sha = 'f'.repeat(40) },
    event: g => { g.run.event = 'pull_request' },
    inProgress: g => { g.run.status = 'in_progress' },
    failed: g => { g.run.conclusion = 'failure' },
    rerun: g => { g.run.run_attempt += 1 },
    skippedStability: g => { g.jobs.find(job => job.name === 'Two-hour pre-release stability').conclusion = 'skipped' },
    ordinaryCandidate: g => { g.jobs[0].steps[0].conclusion = 'skipped' },
    duplicateBuildJob: g => g.jobs.push({ ...g.jobs[0] }),
    artifactId: g => { g.artifacts[0].id += 1 },
    artifactName: g => { g.artifacts[0].name = 'release-website' },
    artifactDigest: g => { g.artifacts[0].digest = `sha256:${'d'.repeat(64)}` },
    artifactExpiry: g => { g.artifacts[0].expired = true },
    artifactRun: g => { g.artifacts[0].workflow_run.id += 1 },
    artifactAttempt: g => { g.artifacts[0].workflow_run.run_attempt += 1 },
    artifactHead: g => { g.artifacts[0].workflow_run.head_sha = 'f'.repeat(40) },
    artifactRepository: g => { g.artifacts[0].workflow_run.repository_id += 1 },
  }
  for (const [name, change] of Object.entries(changes)) await t.test(name, st => {
    const f = fixture(st); const g = githubFixture(f.build); change(g)
    assert.throws(() => verifyReviewedBuildSource(f.build, { version, sourceHead }, g.api))
  })
})

test('receipt generation is limited to private public-identity builds and hashes actual outputs', async t => {
  const f = fixture(t)
  const dist = join(f.downloads, 'release-win')
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: RELEASE_REPOSITORY, CANDIDATE_ONLY: 'true', PREPARE_PUBLIC_ARTIFACTS: 'true', PUBLISH_RELEASE: 'false',
    GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@refs/heads/codex/test`, GITHUB_SHA: sourceHead, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }
  const inspect = () => f.receipts['release-win'].identities['win32-x64']
  const receipt = await recordReviewedBuild({ dist, platform: 'win', version, env, inspect, verifySource })
  assert.deepEqual(receipt.files, f.build.files.filter(file => file.artifact === 'release-win'))
  for (const patch of [{ CANDIDATE_ONLY: 'false' }, { PREPARE_PUBLIC_ARTIFACTS: 'false' }, { PUBLISH_RELEASE: 'true' }, { WORKWISE_CANDIDATE: '1' }, { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_WORKFLOW_REF: 'other/workflow' }]) {
    await assert.rejects(() => recordReviewedBuild({ dist, platform: 'win', version, env: { ...env, ...patch }, inspect, verifySource }))
  }
})

test('freezing inspects the actual packaged ASAR and updater identity', async t => {
  const f = fixture(t)
  const dist = join(f.downloads, 'release-win')
  const resources = join(dist, 'win-unpacked', 'resources')
  const input = join(f.root, 'asar-input')
  mkdirSync(resources, { recursive: true }); mkdirSync(input)
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: RELEASE_REPOSITORY, CANDIDATE_ONLY: 'true', PREPARE_PUBLIC_ARTIFACTS: 'true', PUBLISH_RELEASE: 'false',
    GITHUB_WORKFLOW_REF: `${RELEASE_REPOSITORY}/${RELEASE_WORKFLOW}@refs/heads/codex/test`, GITHUB_SHA: sourceHead, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }
  const metadata = { name: 'workwise', productName: 'RailWise AI', version, updateChannel: 'stable', buildProvenance: { sourceHead } }
  const updater = { provider: 'generic', url: 'https://www.railwise.cn/downloads/workwise/channels/stable/latest/', updaterCacheDirName: 'workwise-updater' }
  const pack = async () => {
    writeFileSync(join(input, 'package.json'), JSON.stringify(metadata))
    rmSync(join(resources, 'app.asar'), { force: true })
    await require('@electron/asar').createPackage(input, join(resources, 'app.asar'))
    require('@electron/asar').uncache(join(resources, 'app.asar'))
    writeFileSync(join(resources, 'app-update.yml'), JSON.stringify(updater))
  }
  await pack()
  const receipt = await recordReviewedBuild({ dist, platform: 'win', version, env, verifySource })
  assert.equal(receipt.identities['win32-x64'].packageName, 'workwise')
  updater.url = 'https://127.0.0.1/'
  await pack()
  await assert.rejects(() => recordReviewedBuild({ dist, platform: 'win', version, env, verifySource }), /public updater URL mismatch/)
  updater.url = 'https://www.railwise.cn/downloads/workwise/channels/stable/latest/'
  metadata.name = 'workwise-private-updater-test'
  await pack()
  await assert.rejects(() => recordReviewedBuild({ dist, platform: 'win', version, env, verifySource }), /public package packageName mismatch/)
  metadata.name = 'workwise'; metadata.buildProvenance.sourceHead = 'f'.repeat(40)
  await pack()
  await assert.rejects(() => recordReviewedBuild({ dist, platform: 'win', version, env, verifySource }), /packaged source HEAD mismatch/)
  await assert.rejects(() => recordReviewedBuild({ dist, platform: 'win', version, env }), /checked-out source HEAD mismatch/)
})
