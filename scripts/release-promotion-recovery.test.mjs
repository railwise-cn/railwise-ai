import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import YAML from 'yaml'
import { capturePromotionState, commitPublication, markPromotionStarted, mergeRecoveryFile, preparePromotionStart, publicationState, recoverPromotion, trustedAttempt, verifyArchivePointers, verifyDraftRelease, verifyPublishedInstallers } from './release-promotion-recovery.mjs'
import { buildLatestManifest } from './publish-r2.mjs'
import { _internals as website } from './deploy-website-release.mjs'

const TARGET = 'v0.5.3'; const OLD = 'v0.5.2'
const attempt = { repository: 'railwise-cn/railwise-ai', sourceHead: 'a'.repeat(40), runId: '1234', runAttempt: '1' }
function pointers(tag) {
  return Object.fromEntries(['workwise/channels/stable/latest', 'workwise/latest'].flatMap(base => [
    [`${base}/latest.json`, JSON.stringify({ tag, version: tag.slice(1), generatedAt: 'before', downloads: [{ fileName: `package-${tag}.zip`, sha512: 'old hash' }] })],
    [`${base}/latest.yml`, `version: ${tag.slice(1)}\npath: WorkWise-${tag.slice(1)}-win-x64.exe\n`],
    [`${base}/latest-mac.yml`, `version: ${tag.slice(1)}\npath: WorkWise-${tag.slice(1)}-mac-arm64.zip\n`],
  ]))
}
function fixture() {
  const old = { r2: pointers(OLD), website: pointers(OLD) }
  const targetPointers = { r2: pointers(TARGET), website: pointers(TARGET) }
  const prepared = capturePromotionState({ targetTag: TARGET, attempt, pointers: old, targetPointers })
  const started = markPromotionStarted(prepared, old)
  const current = structuredClone(old); const calls = []
  const transport = { readSurface: async surface => structuredClone(current[surface]),
    verifyArchive: async () => {}, getPublicationState: async () => 'draft', verifyPublishedRelease: async () => {},
    restoreSurface: async (surface, state) => {
      calls.push([surface, state.previousTag]); current[surface] = structuredClone(state.pointers[surface])
    } }
  return { old, prepared, started, current, calls, transport }
}
test('uploads, draft failures and an unstarted attempt do not change official pointers', async () => {
  const f = fixture()
  assert.deepEqual(await recoverPromotion(f.prepared, f.transport), { status: 'not-started', restored: [] })
  assert.deepEqual(await recoverPromotion(f.started, f.transport), { status: 'restored', restored: [] })
  assert.deepEqual(f.calls, [])
})
test('partial R2 copies recover changed YAML even while latest.json still selects the old version', async () => {
  const f = fixture()
  f.current.r2['workwise/channels/stable/latest/latest-mac.yml'] = pointers(TARGET)['workwise/channels/stable/latest/latest-mac.yml']
  assert.equal(JSON.parse(f.current.r2['workwise/channels/stable/latest/latest.json']).tag, OLD)
  const result = await recoverPromotion(f.started, f.transport)
  assert.deepEqual(result.restored, ['r2'])
  assert.deepEqual(f.calls, [['r2', OLD]])
  assert.deepEqual(f.current.website, f.old.website)
  assert.deepEqual(f.current.r2, f.old.r2)
})
test('partial website promotion restores both pointer sets without touching an unchanged R2 surface', async () => {
  const f = fixture()
  for (const key of Object.keys(f.current.website).filter(key => key.includes('/channels/'))) f.current.website[key] = pointers(TARGET)[key]
  assert.deepEqual((await recoverPromotion(f.started, f.transport)).restored, ['website'])
  assert.deepEqual(f.calls, [['website', OLD]])
})
test('both promoted surfaces recover their exact old release metadata', async () => {
  const f = fixture(); f.current.r2 = pointers(TARGET); f.current.website = pointers(TARGET)
  assert.deepEqual((await recoverPromotion(f.started, f.transport)).restored, ['r2', 'website'])
  assert.deepEqual(f.current, f.old)
})
test('another release is never overwritten, and the other affected surface still recovers', async () => {
  const f = fixture(); f.current.r2 = pointers('v0.5.4'); f.current.website = pointers(TARGET)
  await assert.rejects(recoverPromotion(f.started, f.transport), /another release now owns r2/)
  assert.deepEqual(f.calls, [['website', OLD]])
  assert.equal(JSON.parse(f.current.r2['workwise/channels/stable/latest/latest.json']).tag, 'v0.5.4')
})
test('failed R2 recovery does not suppress website recovery, and stale recovery bytes fail verification', async () => {
  const f = fixture(); f.current.r2 = pointers(TARGET); f.current.website = pointers(TARGET)
  f.transport.restoreSurface = async (surface, state) => {
    f.calls.push([surface, state.previousTag]); if (surface === 'r2') throw new Error('R2 unavailable')
    f.current[surface] = pointers(state.previousTag)
    f.current[surface]['workwise/latest/latest-mac.yml'] = pointers(TARGET)['workwise/latest/latest-mac.yml']
  }
  await assert.rejects(recoverPromotion(f.started, f.transport), /R2 unavailable.*public pointers disagree/)
  assert.deepEqual(f.calls, [['r2', OLD], ['website', OLD]])
})
test('preexisting inconsistent pointers, an already-selected target and a changed prepared snapshot block promotion', () => {
  const f = fixture()
  const targetPointers = f.prepared.targetPointers
  assert.throws(() => capturePromotionState({ targetTag: TARGET, attempt, targetPointers, pointers: { r2: pointers(OLD), website: pointers('v0.5.1') } }), /public pointers disagree/)
  assert.throws(() => capturePromotionState({ targetTag: TARGET, attempt, targetPointers, pointers: { r2: pointers(TARGET), website: pointers(TARGET) } }), /must be newer/)
  f.current.r2 = pointers(TARGET)
  assert.throws(() => markPromotionStarted(f.prepared, f.current), /changed after preparation/)
  assert.throws(() => capturePromotionState({ targetTag: 'v0.5.3', attempt, targetPointers, pointers: { r2: pointers('v0.5.4'), website: pointers('v0.5.4') } }), /must be newer/)
})
test('an unavailable or mismatched previous archive blocks start before any public write', async () => {
  const f = fixture()
  f.transport.verifyArchive = async (state, surface) => {
    if (surface === 'r2') throw new Error('previous package hash mismatch')
  }
  await assert.rejects(preparePromotionStart(f.prepared, f.transport), /previous package hash mismatch/)
  assert.deepEqual(f.calls, [])
  assert.equal(f.prepared.status, 'prepared')
  const archive = structuredClone(f.old.website)
  archive['workwise/latest/latest.json'] += '\n'
  assert.throws(() => verifyArchivePointers(f.prepared, 'website', archive), /archive metadata differs/)
  verifyArchivePointers(f.prepared, 'website', f.old.website)
})
test('start rereads public pointers after lengthy archive verification and detects a concurrent mutation', async () => {
  const f = fixture()
  f.transport.verifyArchive = async () => { f.current.website['workwise/latest/latest.yml'] += '# another attempt\n' }
  await assert.rejects(preparePromotionStart(f.prepared, f.transport), /changed after preparation/)
  assert.deepEqual(f.calls, [])
})
test('same-version changes do not belong to this attempt and cannot be overwritten', async () => {
  for (const tag of [OLD, TARGET]) {
    const f = fixture(); f.current.r2 = pointers(tag)
    f.current.r2['workwise/latest/latest.json'] += '\n'
    await assert.rejects(recoverPromotion(f.started, f.transport), /another release now owns r2/)
    assert.deepEqual(f.calls, [])
  }
})
test('recovery revalidates ownership immediately after archive verification', async () => {
  const f = fixture(); f.current.r2 = pointers(TARGET); f.current.website = pointers(TARGET)
  f.transport.verifyArchive = async (state, surface) => {
    if (surface === 'r2') f.current.r2['workwise/latest/latest.yml'] += '# concurrent mutation\n'
  }
  await assert.rejects(recoverPromotion(f.started, f.transport), /changed during recovery validation/)
  assert.deepEqual(f.calls, [['website', OLD]])
})
test('an old regenerated timestamp is not accepted as an exact successful recovery', async () => {
  const f = fixture(); f.current.r2 = pointers(TARGET)
  f.transport.restoreSurface = async (surface, state) => {
    f.current[surface] = pointers(state.previousTag)
    f.current[surface]['workwise/latest/latest.json'] += '\n'
  }
  await assert.rejects(recoverPromotion(f.started, f.transport), /exact saved public metadata/)
})
test('a remotely published final release is reconciled after a lost response without restoring public pointers', async () => {
  const f = fixture(); f.current.r2 = pointers(TARGET); f.current.website = pointers(TARGET)
  f.transport.getPublicationState = async () => 'published'
  assert.deepEqual(await recoverPromotion(f.started, f.transport), { status: 'published-reconciled', restored: [] })
  assert.deepEqual(f.calls, [])
  f.current.website = pointers(OLD)
  await assert.rejects(recoverPromotion(f.started, f.transport), /published GitHub release has inconsistent website/)
  assert.deepEqual(f.calls, [])
})
test('unknown GitHub commit status refuses rollback, while authoritative absent or draft permits recovery', async () => {
  const f = fixture(); f.current.r2 = pointers(TARGET)
  f.transport.getPublicationState = async () => 'unknown'
  await assert.rejects(recoverPromotion(f.started, f.transport), /status is unknown/)
  assert.deepEqual(f.calls, [])
  f.transport.getPublicationState = async () => 'absent'
  assert.deepEqual((await recoverPromotion(f.started, f.transport)).restored, ['r2'])
  assert.equal(publicationState([[{ tag_name: TARGET, draft: false }]], TARGET), 'published')
  assert.equal(publicationState([[{ tag_name: TARGET, draft: true }]], TARGET), 'draft')
  assert.equal(publicationState([[]], TARGET), 'absent')
  assert.throws(() => publicationState([[{ tag_name: TARGET }]], TARGET), /ambiguous/)
})
test('final commit succeeds only after a fresh public status, reviewed installers and both pointer sets are verified', async () => {
  const f = fixture(); f.current.r2 = pointers(TARGET); f.current.website = pointers(TARGET)
  let checks = 0
  f.transport.getPublicationState = async () => 'published'
  f.transport.verifyPublishedRelease = async () => { checks += 1 }
  f.transport.publishRelease = async () => {}
  assert.equal((await commitPublication(f.started, f.transport)).status, 'published')
  f.transport.publishRelease = async () => { throw new Error('lost final response') }
  assert.equal((await commitPublication(f.started, f.transport)).status, 'published-reconciled')
  assert.equal(checks, 2)
  f.transport.getPublicationState = async () => 'unknown'
  await assert.rejects(commitPublication(f.started, f.transport), /status is unknown/)
  assert.deepEqual(f.calls, [])
})
test('published reconciliation refuses missing, extra or changed installer bytes and cannot roll back a committed release', async () => {
  const f = fixture(); f.current.r2 = pointers(TARGET); f.current.website = pointers(TARGET)
  f.transport.getPublicationState = async () => 'published'
  f.transport.verifyPublishedRelease = async () => { throw new Error('published installer bytes differ') }
  await assert.rejects(recoverPromotion(f.started, f.transport), /installer bytes differ/)
  assert.deepEqual(f.calls, [])
  const state = { targetTag: TARGET, installers: { 'one.dmg': { sha256: 'a'.repeat(64), size: 42 } } }
  const release = { tag_name: TARGET, draft: false, prerelease: false, assets: [{ name: 'one.dmg', size: 42, digest: `sha256:${'a'.repeat(64)}` }] }
  verifyPublishedInstallers(release, state)
  assert.throws(() => verifyPublishedInstallers({ ...release, assets: [] }, state), /reviewed set/)
  assert.throws(() => verifyPublishedInstallers({ ...release, assets: [...release.assets, { name: 'extra.zip' }] }, state), /reviewed set/)
  assert.throws(() => verifyPublishedInstallers({ ...release, assets: [{ ...release.assets[0], digest: `sha256:${'b'.repeat(64)}` }] }, state), /digest differs/)
  assert.throws(() => verifyPublishedInstallers({ ...release, prerelease: true }, state), /not a stable/)
})
test('R2 expected target metadata is deterministic for this publication attempt', () => {
  const generatedAt = '2026-10-08T01:00:00.000Z'
  const manifests = ['mac', 'win'].map(platform => ({ platform, releaseDate: '2026-10-07T01:00:00.000Z',
    updateMetadata: { fileName: platform === 'mac' ? 'latest-mac.yml' : 'latest.yml' },
    downloads: [{ fileName: `${platform}.zip`, sha512: 'accepted' }] }))
  const input = { platformManifests: manifests, channel: 'stable', tag: TARGET, publicBaseUrl: 'https://www.railwise.cn/downloads', basePath: 'workwise/channels/stable', generatedAt }
  const first = buildLatestManifest(input)
  assert.deepEqual(first, buildLatestManifest(input))
  assert.equal(first.generatedAt, generatedAt)
  assert.equal(first.version, '0.5.3')
  assert.equal(first.downloads[0].url, 'https://www.railwise.cn/downloads/workwise/channels/stable/latest/mac.zip')
})
test('all saved references to one previous R2 package agree on hash and known size', () => {
  const files = new Map(); const file = { fileName: 'package.zip', sha512: 'accepted', size: 42 }
  mergeRecoveryFile(files, 'latest/package.zip', file)
  mergeRecoveryFile(files, 'latest/package.zip', { fileName: file.fileName, sha512: file.sha512 })
  assert.equal(files.get('latest/package.zip').size, 42)
  assert.throws(() => mergeRecoveryFile(files, 'latest/package.zip', { ...file, sha512: 'different' }), /conflicting saved R2 package hashes/)
  assert.throws(() => mergeRecoveryFile(files, 'latest/package.zip', { ...file, size: 43 }), /conflicting saved R2 package sizes/)
})
test('same-tag public GitHub releases are refused before notes or installers can be overwritten', () => {
  assert.deepEqual(verifyDraftRelease([[{ tag_name: OLD, draft: false }]], TARGET), { exists: false })
  assert.deepEqual(verifyDraftRelease([[{ tag_name: TARGET, draft: true }]], TARGET), { exists: true })
  assert.throws(() => verifyDraftRelease([[{ tag_name: TARGET, draft: false }]], TARGET), /already-published/)
  assert.throws(() => verifyDraftRelease([[{ tag_name: TARGET }]], TARGET), /already-published/)
})
test('recovery is bound to the exact tagged workflow and publication attempt', () => {
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: attempt.repository, GITHUB_REF: `refs/tags/${TARGET}`, GITHUB_REF_NAME: TARGET,
    GITHUB_WORKFLOW_REF: `railwise-cn/railwise-ai/.github/workflows/release.yml@refs/tags/${TARGET}`, GITHUB_SHA: attempt.sourceHead,
    GITHUB_WORKFLOW_SHA: attempt.sourceHead, GITHUB_RUN_ID: attempt.runId, GITHUB_RUN_ATTEMPT: attempt.runAttempt }
  assert.deepEqual(trustedAttempt(env, TARGET), attempt)
  for (const patch of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/main' }, { GITHUB_REF_NAME: OLD },
    { GITHUB_WORKFLOW_REF: 'railwise-cn/railwise-ai/.github/workflows/release.yml@refs/heads/main' }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) }, { GITHUB_RUN_ATTEMPT: '0' }]) {
    assert.throws(() => trustedAttempt({ ...env, ...patch }, TARGET), /exact tagged public release workflow/)
  }
})
test('publication prepares verified draft bytes before promotion, with failure recovery only after a captured attempt', () => {
  const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
  const steps = workflow.jobs.publish.steps
  const index = name => steps.findIndex(step => step.name === name)
  const promotion = index('Promote verified R2 and official website latest pointers')
  for (const name of ['Generate release notes', 'Create or update draft GitHub Release', 'Keep GitHub Release limited to the three client installers', 'Verify GitHub Release downloads']) assert.ok(index(name) >= 0 && index(name) < promotion)
  const downloads = steps[index('Verify GitHub Release downloads')].run
  assert.match(downloads, /cmp "public-release-assets\/\$\{file\}" "downloaded-release\/\$\{file\}"/)
  assert.ok(index('Verify promoted official updater feed') > promotion)
  assert.ok(index('Publish GitHub Release') > index('Verify promoted official updater feed'))
  assert.match(steps[index('Publish GitHub Release')].run, /release-promotion-recovery\.mjs publish[\s\S]+--result=/)
  const recovery = steps[index('Restore the previous official pointers if this promotion attempt fails')]
  assert.match(recovery.if, /failure\(\) \|\| cancelled\(\)/)
  assert.match(recovery.if, /capture_promotion.outcome == 'success'/)
  assert.match(recovery.if, /stable_promotion.outcome != 'skipped'/)
  assert.match(recovery.run, /--result=/)
  assert.match(steps[promotion].run, /publish-r2\.mjs promote[^\n]+--skip-retention[^\n]+--generated-at/)
  assert.match(steps[promotion].run, /deploy-website-release\.mjs promote[\s\S]+--skip-retention/)
  const evidence = steps[index('Preserve private publication transaction evidence')]
  assert.match(evidence.if, /always\(\)/)
  assert.match(evidence.with.path, /official-promotion-state\.json/)
  assert.match(evidence.with.path, /official-promotion-result\.json/)
  for (const job of ['publish', 'rollback-stable', 'repair-website-cache']) {
    assert.deepEqual(workflow.jobs[job].concurrency, { group: 'production-release-public', 'cancel-in-progress': false })
  }
  const cache = YAML.parse(readFileSync(new URL('../.github/workflows/repair-website-cache.yml', import.meta.url), 'utf8'))
  assert.deepEqual(cache.concurrency, { group: 'production-release-public', 'cancel-in-progress': false })
  const page = YAML.parse(readFileSync(new URL('../.github/workflows/deploy-workwise-product-page.yml', import.meta.url), 'utf8'))
  assert.match(page.concurrency.group, /production-release-public/)
  assert.equal(page.concurrency['cancel-in-progress'], false)
})
test('website transactional promotion retains the selected archive instead of pruning it', async () => {
  assert.match(website.PROMOTE_SCRIPT, /if \[\[ "\$6" != skip-retention \]\]; then\npython3 - "\$channel_dir\/releases"/)
  assert.equal(website.parseArgs(['promote', '--tag', OLD, '--skip-retention']).flags.get('skip-retention'), true)
  assert.equal(website.parseArgs(['promote', '--tag', OLD]).flags.has('skip-retention'), false)
  const r2 = readFileSync(new URL('./publish-r2.mjs', import.meta.url), 'utf8')
  assert.match(r2, /if \(!flags\.has\('skip-retention'\)\) await enforceReleaseRetention/)
})
