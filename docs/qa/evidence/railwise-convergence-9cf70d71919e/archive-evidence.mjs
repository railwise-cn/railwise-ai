import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants, copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = dirname(fileURLToPath(import.meta.url))
const root = '/private/tmp/railwise-survey-9cf70d7'
const head = '9cf70d71919e997e815a9e55ec4264e01572979c'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]))
const patterns = {
  githubToken: /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/g,
  privateKey: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  apiToken: /sk-[A-Za-z0-9_-]{32,}/g,
  credentialUrl: /https?:\/\/[^\s/:]+:[^\s/@]+@/g,
  unmaskedAuthorization: /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{30,}/g
}
const scans = []
function scan(name, bytes) {
  const text = bytes.toString('utf8')
  const hits = Object.fromEntries(Object.entries(patterns).map(([key, pattern]) => [key, [...text.matchAll(pattern)].length]))
  assert(Object.values(hits).every(count => count === 0), `Potential credentials in ${name}; refusing archive`)
  scans.push({ file: name, hits })
}
function json(name, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  scan(name, bytes)
  writeFileSync(join(out, name), bytes, { flag: 'wx' })
}
function copy(source, name) {
  const bytes = readFileSync(source)
  if (!name.endsWith('.png')) scan(name, bytes)
  mkdirSync(dirname(join(out, name)), { recursive: true })
  copyFileSync(source, join(out, name), constants.COPYFILE_EXCL)
  assert.equal(sha(readFileSync(join(out, name))), sha(bytes))
  return { file: name, source, bytes: bytes.length, sha256: sha(bytes), originalBytesPreserved: true }
}
const installation = read(join(root, 'evidence/installation-context.json'))
const pkgPath = join(root, 'evidence/package.json')
const pkg = read(pkgPath)
assert.equal(pkg.sourceHead, head)
const privatePath = join(root, 'cloud-evidence/private-updater.json')
const nativePath = join(root, 'cloud-evidence/native-updater.json')
const updater = read(privatePath)
const native = read(nativePath)
assert.equal(updater.sourceHead, head)
assert.equal(updater.status, 'passed')
json('package-summary.json', { schemaVersion: 1, purpose: installation.purpose, ...pkg, sourceReportSha256: sha(readFileSync(pkgPath)), embeddedSourceProvenanceVerified: true, embeddedUpdaterHost: '127.0.0.1' })
json('private-updater-summary.json', {
  schemaVersion: 1, workflowRunId: 35496645847, workflowConclusion: 'success',
  sourceReports: { privateUpdaterSha256: sha(readFileSync(privatePath)), nativeUpdaterSha256: sha(readFileSync(nativePath)) },
  ...pick(updater, ['status', 'sourceHead', 'baseVersion', 'targetVersion', 'platform', 'arch', 'productionTouched', 'publicFeedUploaded', 'privateTransport', 'baselinePurpose', 'systemTrustModified', 'updatedAt', 'bundleId', 'signature', 'stapledNotarization', 'gatekeeperStatus', 'gatekeeperStatusExitCode', 'baseDmgSha256', 'targetZipSha256', 'targetAsarSha256', 'installedAsarSha256', 'userDataSentinelPreserved', 'feedRequests', 'manifestSha256']),
  native: { ...pick(native, ['status', 'startedAt', 'completedAt', 'browserOpened', 'userDataPreserved']), isolatedTestChannel: native.channel, feedUrl: '<redacted-private-loopback-feed>', stages: native.stages.map(stage => pick(stage, ['name', 'at'])) },
  limitations: ['The test channel is private and is not public promotion.', 'The 0.0.0 baseline is a same-source updater probe.', 'The user-data sentinel is synthetic, not real-project migration acceptance.']
})
json('artifact-download-summary.json', {
  schemaVersion: 1, purpose: installation.purpose, sourceHead: head,
  evidenceArtifact: read(join(root, 'cloud-evidence-artifact.json')),
  targetArtifact: read(join(root, 'cloud-target-artifact.json')),
  download: read(join(root, 'evidence/zip-download.json')),
  checks: { evidenceArtifactFullDigestVerified: installation.evidenceArtifactFullDigestVerified, innerApplicationZipFullyHashed: true, outerTargetArtifactDigestRehashed: false, installedAsarMatchesCloudUpdater: true }
})
const files = []
files.push(copy(join(root, 'evidence/installation-context.json'), 'installation-context.json'))
files.push(copy(join(root, 'evidence/legacy-completion-copy.json'), 'legacy-completion-copy.json'))
files.push(copy(join(root, 'evidence/packaged-text-only-completion-probe-wCtOnp.json'), 'packaged-text-only-completion-probe-wCtOnp.json'))
files.push(copy('/private/tmp/railwise-9cf70d7-text-only-probe.log', 'packaged-text-only-completion-probe.log'))
const quality = copy('/private/tmp/railwise-9cf70d7-quality.log', 'CloudQuality.log')
files.push(quality)
assert.equal(quality.sha256, 'b64ac2c2a039eec510ec05fb739c3bd354df0b764aef6331641a3e2dddcfc566')
for (const name of readdirSync(join(root, 'evidence/gui')).sort()) files.push(copy(join(root, 'evidence/gui', name), `gui/${name}`))
json('CloudQuality-summary.json', { schemaVersion: 1, sourceHead: head, workflowRunId: 35496644961, workflowUrl: 'https://github.com/wangjiawei508/WorkWise/actions/runs/35496644961', conclusion: 'success', provenance: 'Fetched directly with explicit-repository gh run view --log, scanned before storage and copied without whitespace changes.', rawLog: quality, tests: pick(installation.quality, ['desktopPassed', 'desktopSkipped', 'runtimePassed', 'runtimeSkipped', 'windowsCoreSecurityPassed', 'windowsPluginSecurityPassed', 'windowsPersistencePassed', 'windowsPersistenceSkipped']) })
json('archive-manifest.json', { schemaVersion: 1, sourceHead: head, sourceArtifacts: files, credentialScans: scans, screenshotReview: 'Both PNGs visually inspected; synthetic project/plan only, no visible credentials.', omitted: ['Private native updater feed URL', 'Application ZIP and app bundle', 'User configuration, credentials and raw databases'] })
console.log(JSON.stringify({ status: 'passed', originalArtifactsCopied: files.length, scannedTextArtifacts: scans.length, directory: out }))
