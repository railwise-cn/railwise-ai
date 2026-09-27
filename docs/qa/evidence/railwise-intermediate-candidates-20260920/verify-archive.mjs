import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const bytes = readFileSync(join(root, 'candidate-summary.json'))
const provenance = JSON.parse(readFileSync(join(root, 'source-provenance.json')))
assert.equal(provenance.archive.path, 'candidate-summary.json')
assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.archive.sha256)
const summary = JSON.parse(bytes)
assert.equal(summary.candidates.length, 2)
const [installed, cloud] = summary.candidates
assert.equal(installed.sourceHead, '267aadeafebeecdbbb3bc012f3844793d060990a')
assert.equal(cloud.sourceHead, '27738f42dc9d1774b9cfafe000d87e65158cd554')
for (const candidate of summary.candidates) {
  assert.equal(candidate.version, '0.5.0')
  assert.equal(candidate.workflowConclusion, 'success')
  assert.equal(candidate.guiAcceptance, 'not-tested')
  assert.equal(candidate.userAcceptance, 'not-performed')
  assert.equal(candidate.guiLaunched, false)
  assert.equal(candidate.userDataReadOrModified, false)
  assert.equal(candidate.publicReleaseOperation, false)
  assert.equal(candidate.nativeUpdater.status, 'passed')
  assert.equal(candidate.cloudGatekeeperStatus, 'assessments enabled')
  assert.equal(candidate.systemTrustModified, false)
  assert.equal(candidate.evidenceArtifactOuterDigestRehashed, true)
  assert.ok(Object.values(candidate.tlsChecks).every(value => value === true))
}
assert.equal(installed.targetArtifactSha256, '3ff87e86d9abf9c2027db2d0033563b09840a2a9578e453232f0c90fce859b17')
assert.equal(installed.localGatekeeperStatus, 'assessments disabled')
assert.equal(installed.asarEntriesVerified, 18363)
assert.equal(installed.localInstallationPerformed, true)
assert.equal(installed.targetArtifactOuterDigestRehashed, true)
assert.equal(installed.downloadRecovery.completeRangesRetained, 561)
assert.deepEqual(installed.downloadRecovery.shortRanges.map(range => range.range), [464, 478])
assert.equal(installed.downloadRecovery.fullArtifactRehashedAfterRecovery, true)
assert.equal(cloud.targetArtifactDownloaded, false)
assert.equal(cloud.targetArtifactOuterDigestRehashed, false)
assert.equal(cloud.localInstallationPerformed, false)
assert.doesNotMatch(bytes.toString(), /https?:\/\/|Bearer\s|BEGIN .*PRIVATE KEY|gh[opusr]_[A-Za-z0-9]+/)
console.log('Intermediate candidate archive verified; neither candidate has GUI/user acceptance')
