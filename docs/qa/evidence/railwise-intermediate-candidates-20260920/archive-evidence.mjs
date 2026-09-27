import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outputRoot = dirname(fileURLToPath(import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourcePaths = [
  '/private/tmp/railwise-survey-267aade/evidence/installation-context.json',
  '/private/tmp/railwise-survey-27738f4/evidence/cloud-context.json',
]
const inputs = sourcePaths.map(path => ({ path, bytes: readFileSync(path) }))
const [installed, cloud] = inputs.map(input => JSON.parse(input.bytes))
assert.equal(installed.sourceHead, '267aadeafebeecdbbb3bc012f3844793d060990a')
assert.equal(cloud.sourceHead, '27738f42dc9d1774b9cfafe000d87e65158cd554')
assert.equal(installed.workflowRunId, 35503443821)
assert.equal(cloud.workflowRunId, 35504596329)
for (const record of [installed, cloud]) {
  assert.equal(record.workflowConclusion, 'success')
  assert.equal(record.guiAcceptance, 'not-tested')
  assert.equal(record.userAcceptance, 'not-performed')
  assert.equal(record.publicReleaseOperation, false)
  assert.equal(record.evidenceArtifactOuterDigestRehashed, true)
}
assert.equal(installed.guiLaunchedByInstallerAgent, false)
assert.equal(installed.userDataReadOrModifiedByInstallerAgent, false)
assert.equal(cloud.userDataReadOrModifiedByEvidenceAgent, false)
assert.equal(installed.targetArtifactOuterDigestRehashed, true)
assert.equal(cloud.targetArtifactDownloaded, false)
assert.equal(cloud.localInstallationPerformed, false)
const pick = (record, names) => Object.fromEntries(names.map(name => {
  assert.notEqual(record[name], undefined, `Missing ${name}`)
  return [name, record[name]]
}))
const common = ['sourceHead', 'version', 'workflowRunId', 'workflowConclusion', 'evidenceArtifactId', 'evidenceArtifactSha256', 'evidenceArtifactOuterDigestRehashed', 'cloudEvidenceSha256', 'targetArtifactId', 'targetArtifactBytes', 'cloudGatekeeperStatus', 'nativeUpdater', 'tlsChecks', 'systemTrustModified', 'guiAcceptance', 'userAcceptance', 'publicReleaseOperation']
const summary = {
  schemaVersion: 1, purpose: 'Intermediate candidates only; no GUI acceptance, no release approval',
  candidates: [
    {
      ...pick(installed, common), scope: 'Local isolated installation and cloud native updater only',
      ...pick(installed, ['targetArtifactSha256', 'targetArtifactOuterDigestRehashed', 'targetZipSha256', 'installedAsarSha256', 'matchesCloudUpdaterInstalledTarget', 'embeddedSourceProvenanceVerified', 'asarEntriesVerified', 'embeddedUpdaterHost', 'localGatekeeperStatus', 'localSignatureVerified', 'localStapledNotarizationVerified']),
      localInstallationPerformed: true, guiLaunched: false, userDataReadOrModified: false,
      localSignatureCheckExitCodes: installed.signatureChecks.map(check => ({ executable: check.command[0], operation: check.command[1], exitCode: check.exitCode })),
      downloadRecovery: {
        initialDownloadFailed: true, initialFailure: 'Artifact range download failed; underlying transport cause not determined',
        completeRangesRetained: 561, totalRanges: 563,
        shortRanges: [{ range: 464, receivedBytes: 965571, expectedBytes: 1048576 }, { range: 478, receivedBytes: 129987, expectedBytes: 1048576 }],
        retryAttemptsPerShortRange: 1, fullArtifactRehashedAfterRecovery: true, fullArchiveCrcVerifiedAfterRecovery: true,
      },
    },
    {
      ...pick(cloud, common), scope: 'Cloud evidence only; target package not downloaded locally',
      ...pick(cloud, ['targetArtifactDeclaredDigest', 'targetArtifactDownloaded', 'targetArtifactOuterDigestRehashed', 'cloudTargetZipSha256', 'cloudInstalledAsarSha256', 'cloudSignatureVerified', 'cloudStapledNotarizationVerified', 'localInstallationPerformed']),
      guiLaunched: false, userDataReadOrModified: false,
    },
  ],
}
const summaryBytes = Buffer.from(JSON.stringify(summary, null, 2) + '\n')
const provenance = {
  schemaVersion: 1,
  sources: inputs.map(input => ({ path: input.path, sha256: hash(input.bytes) })),
  archive: { path: 'candidate-summary.json', sha256: hash(summaryBytes) },
  excluded: ['candidate.env', 'credentials', 'private feed URLs', 'raw logs', 'user data'],
}
writeFileSync(join(outputRoot, 'candidate-summary.json'), summaryBytes, { flag: 'wx' })
writeFileSync(join(outputRoot, 'source-provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' })
console.log('Archived sanitized intermediate candidate identity and acceptance boundaries')
