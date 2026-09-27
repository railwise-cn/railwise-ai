import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const out = dirname(fileURLToPath(import.meta.url))
const repo = process.cwd()
const root = '/private/tmp/railwise-survey-53213de'
const auditRoot = '/private/tmp/railwise-candidate-audit.byCLwE'
const oracleRoot = '/private/tmp/railwise-independent-plane-oracle.w8rWDa'
const head = '53213de739d0b1f3f173f883dcdac21cdc4fdfc9'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
const artifacts = []
const patterns = {
  githubToken: /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/g,
  privateKey: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  apiToken: /sk-[A-Za-z0-9_-]{32,}/g,
  credentialUrl: /https?:\/\/[^\s/:]+:[^\s/@]+@/g,
  unmaskedAuthorization: /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]{30,}/g,
  privateFeed: /https:\/\/127\.0\.0\.1:\d+\/private-[a-f0-9]+/g,
  personalAbsolutePath: /\/Users\/[^/\s"']+/g
}
function scan(name, bytes) {
  const text = bytes.toString('utf8')
  const hits = Object.fromEntries(Object.entries(patterns).map(([key, pattern]) => [key, [...text.matchAll(pattern)].length]))
  assert(Object.values(hits).every(count => count === 0), `Restricted data in ${name}`)
  return hits
}
function redact(text) {
  return text.replaceAll(repo, '<repository>').replace(/\/Users\/[^/\s"']+/g, '<user-home>')
}
function store(name, bytes) {
  mkdirSync(dirname(join(out, name)), { recursive: true })
  if (existsSync(join(out, name))) { assert.equal(sha(readFileSync(join(out, name))), sha(bytes), `Existing archive bytes differ: ${name}`); return }
  writeFileSync(join(out, name), bytes, { flag: 'wx' })
}
function json(name, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n')
  scan(name, bytes)
  store(name, bytes)
}
function copy(source, name, binary = false) {
  const original = readFileSync(source)
  const bytes = binary ? original : Buffer.from(redact(original.toString('utf8')))
  const hits = binary ? null : scan(name, bytes)
  if (binary) { mkdirSync(dirname(join(out, name)), { recursive: true }); if (!existsSync(join(out, name))) copyFileSync(source, join(out, name), constants.COPYFILE_EXCL) }
  else store(name, bytes)
  assert.equal(sha(readFileSync(join(out, name))), sha(bytes))
  artifacts.push({ file: name, sourceLabel: source.startsWith(root) ? '<candidate>/' + relative(root, source) : source.startsWith(repo) ? '<repository>/' + relative(repo, source) : '<local-evidence>/' + source.split('/').at(-1), sourceSha256: sha(original), sha256: sha(bytes), bytes: bytes.length, originalBytesPreserved: bytes.equals(original), transformation: bytes.equals(original) ? 'none' : 'personal absolute repository/home path replaced with placeholder; all other bytes retained', credentialScan: hits })
}
const installationPath = join(root, 'evidence/installation-context.json')
const installation = read(installationPath)
const pkg = read(join(root, 'evidence/package.json'))
assert.equal(pkg.sourceHead, head)
json('package-summary.json', {
  schemaVersion: 1, status: 'partial-not-release-approval', sourceHead: head,
  ...pick(pkg, ['version', 'bundleId', 'asarSha256', 'zipSha256', 'matchesNativeUpdaterInstalledTarget', 'installationSource']),
  ...pick(installation, ['workflowRunId', 'workflowConclusion', 'embeddedSourceProvenanceVerified', 'embeddedUpdaterHost', 'sourceWorktreeClean', 'evidenceArtifactFullDigestVerified', 'targetArtifactOuterDigestRehashed', 'targetDownloadMethod', 'matchesCloudUpdaterInstalledTarget', 'cloudGatekeeperStatus', 'localGatekeeperStatus', 'localSignatureVerified', 'localStapledNotarizationVerified', 'candidateCredentialAccess', 'candidateImInboundDisabled', 'candidateImOutboundDisabled', 'candidateUpdateProvider', 'publicReleaseOperation']),
  quality: pick(installation.quality, ['workflowRunId', 'status', 'rawLogSha256', 'desktopPassed', 'desktopSkipped', 'runtimePassed', 'runtimeSkipped', 'windowsCoreSecurityPassed', 'windowsPluginSecurityPassed', 'windowsPersistencePassed', 'windowsPersistenceSkipped']),
  supersededCandidate: pick(installation.supersededCandidate, ['sourceHead', 'privateWorkflowRunId', 'privateWorkflowConclusion', 'qualityWorkflowRunId', 'qualityConclusion', 'qualityFailure', 'qualityRawLogSha256', 'applicationDownloadedOrInstalled']),
  installationSourceReportSha256: sha(readFileSync(installationPath)), userAcceptance: 'not-performed', uiAcceptance: 'failed-stale-waitingReason'
})
const updaterPath = join(root, 'cloud-evidence/private-updater.json'), nativePath = join(root, 'cloud-evidence/native-updater.json')
const updater = read(updaterPath), native = read(nativePath)
assert.equal(updater.sourceHead, head); assert.equal(updater.status, 'passed')
json('private-updater-summary.json', {
  schemaVersion: 1, workflowRunId: installation.workflowRunId,
  ...pick(updater, ['status', 'sourceHead', 'baseVersion', 'targetVersion', 'platform', 'arch', 'productionTouched', 'publicFeedUploaded', 'privateTransport', 'baselinePurpose', 'systemTrustModified', 'updatedAt', 'bundleId', 'signature', 'stapledNotarization', 'gatekeeperStatus', 'gatekeeperStatusExitCode', 'baseDmgSha256', 'targetZipSha256', 'targetAsarSha256', 'installedAsarSha256', 'userDataSentinelPreserved', 'feedRequests', 'manifestSha256']),
  native: { ...pick(native, ['status', 'startedAt', 'completedAt', 'browserOpened', 'userDataPreserved']), isolatedTestChannel: native.channel, feedUrl: '<omitted-private-loopback-feed>', stages: native.stages.map(stage => pick(stage, ['name', 'at'])) },
  sourceReports: { updaterSha256: sha(readFileSync(updaterPath)), nativeSha256: sha(readFileSync(nativePath)) },
  limitations: ['Same-source 0.0.0 updater probe, not historical user-data migration.', 'No public channel promotion.', 'Cloud Gatekeeper enabled; local pre-existing Gatekeeper disabled.']
})
const reportNames = [
  'before-resume-zero-receipts-53213.json', 'failed-real-resume-53213.json', 'second-before-resume-zero-receipts-53213.json',
  'strict-before-restart-audit-53213.json', 'strict-after-restart-audit-53213.json', 'scenario-lineage-before-restart-53213.json',
  'after-restart-known-ui-defect-53213.json', 'independent-selected-result-53213.json', 'independent-oracle-comparison-53213.json',
  'mock-completion-report-650cec4a29fd3f75.json', 'mock-completion-report-943a464105dc837f.json',
  'relay-report-d6fabac586b96a85.json', 'relay-report-43151fd88b293414.json', 'relay-report-193aa816ded2eb21.json', 'relay-report-bc7039f02b81c32f.json',
  'consultation-healthcheck-1789894523837.json', 'consultation-healthcheck-1789894568710.json',
  'packaged-text-only-completion-probe-3peCSU.json', 'gui-review-fixture-first-both.json', 'legacy-completion-copy.json'
]
for (const name of reportNames) copy(join(root, 'evidence', name), name)
for (const name of readdirSync(join(root, 'evidence/gui')).sort()) {
  assert(/^(?:0[1-9]|1[01])-[a-z0-9-]+\.(?:png|ax\.txt)$/.test(name), `Unexpected GUI artifact ${name}`)
  copy(join(root, 'evidence/gui', name), 'gui/' + name, name.endsWith('.png'))
}
const audit = read(join(root, 'evidence/strict-after-restart-audit-53213.json'))
for (const file of audit.delivery.files) {
  const source = join(root, 'home/.workwise/default_workspace', file.relativePath)
  assert.equal(sha(readFileSync(source)), file.sha256)
  const inspect = file.name.endsWith('.pdf')
    ? execFileSync(join(process.env.HOME, '.cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/poppler/bin/pdftotext'), [source, '-'])
    : execFileSync('/usr/bin/unzip', ['-p', source], { maxBuffer: 8 * 1024 * 1024 })
  scan('extracted-' + file.name, inspect)
  copy(source, 'synthetic-deliverables/' + file.name, true)
}
for (const name of ['audit-candidate-execution.mjs', 'verify-resume-history.mjs', 'verify-relay-cleanup.mjs', 'freeze-53213-before-resume.mjs', 'freeze-53213-failed-resume.mjs', 'freeze-53213-second-before-resume.mjs', 'retain-53213-scenario-lineage.mjs', 'run-53213-after-restart.mjs', 'resume-history.test.mjs', 'relay-cleanup.test.mjs']) copy(join(auditRoot, name), 'helpers/' + name + '.source.txt')
for (const name of ['53213-before-restart-input.json', '53213-after-restart-input.json', '53213-audit-method.md', 'relay-cleanup-amendment.md', 'resume-history-selfcheck.tap', 'relay-cleanup-selfcheck.tap', 'strict-mode-selfcheck.json']) copy(join(auditRoot, name), 'helpers/' + name)
for (const name of ['railwise-local-completion-fixture.mjs', 'railwise-typed-acceptance-relay.mjs', 'railwise-typed-relay-guard.mjs', 'railwise-typed-acceptance-relay.test.mjs', 'railwise-helper-boundaries.test.mjs', 'railwise-mock-runtime-selfcheck.test.ts', 'railwise-mock-runtime-vitest.config.mts']) copy('/private/tmp/' + name, 'helpers/' + name + '.source.txt')
for (const name of ['railwise-helper-selftests.tap', 'railwise-mock-runtime-selfcheck.json']) copy('/private/tmp/' + name, 'helpers/' + name)
for (const name of ['build_oracle.py', 'compare_result.py', 'extract_selected_result.py', 'export_reference.py', 'test_oracle.py']) copy(join(oracleRoot, name), 'oracle/' + name + '.source.txt')
for (const name of ['independent-oracle.json', 'reference-result.json', 'comparator-selfcheck.txt', 'README.md']) copy(join(oracleRoot, name), 'oracle/' + name)
copy(join(repo, 'kun/src/engineering/fixtures/survey-formats/cosa-in2/golden-plane-control-e2e.in2'), 'oracle/golden-plane-control-e2e.in2')
for (const name of ['desktop-tests', 'runtime-tests', 'build', 'lint', 'openspec']) copy('/private/tmp/railwise-post53213-' + name + '.log', 'post-package-fix/' + name + '.log')
const sourceFiles = ['kun/src/services/task-controller.test.ts', 'kun/src/services/task-controller.ts', 'src/renderer/src/components/engineering/EngineeringAiCommandCenter.dom.test.ts', 'src/renderer/src/components/engineering/EngineeringAiCommandCenter.tsx']
const fixHead = '7d4f454feecb09028007ae9b436a318db6856201'
const diff = execFileSync('git', ['show', '--format=', fixHead, '--', ...sourceFiles], { cwd: repo })
assert(diff.length > 0)
scan('post-package-fix/reviewed.diff', diff)
store('post-package-fix/reviewed.diff', diff)
json('post-package-fix/validation-summary.json', { scope: 'source-only; not included in reviewed 53213 package', sourceHead: fixHead, diffSha256: sha(diff), sourceFiles: sourceFiles.map(path => ({ path, sha256: sha(execFileSync('git', ['show', `${fixHead}:${path}`], { cwd: repo })) })), desktop: { passed: 2818, skipped: 2 }, runtime: { passed: 2821, skipped: 22 }, build: 'passed', lint: { errors: 0, existingWarnings: 1 }, strictOpenSpec: { passed: 11, failed: 0 }, typechecks: 'both passed earlier in parent session; no separate raw log included here', independentReview: 'no definite regression found; optional reason fields remain serialization-compatible; history events unchanged', packagedUiAcceptance: 'pending-new-signed-candidate' })
json('source-artifacts.json', { schemaVersion: 1, sourceHead: head, artifacts, screenshotReview: 'Nine PNGs individually visually inspected: synthetic fixture only, no visible credential or private source path.', omissions: ['P0 private source details and coordinates', 'Raw database and user settings', 'Actual keys and temporary token files', 'Private feed URL', 'Application binaries and original private source paths'], preservation: 'Original local evidence remains unchanged. Manifest hashes describe archived bytes; source-artifacts records original hashes and any path redaction.' })
console.log(JSON.stringify({ status: 'copied', artifacts: artifacts.length, next: 'Run verify-archive.mjs to generate and verify the final manifest after documentation is complete.' }))
