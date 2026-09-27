import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, constants, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const out = dirname(fileURLToPath(import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const phases = ['before', 'afterrestart'].map(phase => {
  const source = `/private/tmp/railwise-53213-p0-${phase}/public-summary.json`
  const bytes = readFileSync(source), text = bytes.toString('utf8'), summary = JSON.parse(text)
  assert.equal(summary.sourceHead, '53213de739d0b1f3f173f883dcdac21cdc4fdfc9')
  assert.equal(summary.phase, phase); assert.equal(summary.status, 'passed-selected-evidence-checks')
  assert(!/\/Users\/|\/private\/tmp\/|https?:\/\/|gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{32,}/.test(text))
  assert.equal(summary.guiExecutionVerified, false); assert.equal(summary.restartVerifiedByScript, false)
  const file = `p0-${phase}-public-summary.json`
  if (!existsSync(join(out, file))) copyFileSync(source, join(out, file), constants.COPYFILE_EXCL)
  assert.equal(sha(readFileSync(join(out, file))), sha(bytes))
  return { file, summary, sha256: sha(bytes), originalBytesPreserved: true }
})
for (const before of phases[0].summary.networks) {
  const after = phases[1].summary.networks.find(network => network.format === before.format)
  assert(after)
  for (const key of ['ids', 'sourceSha256', 'sourceSizeBytes', 'points', 'observations', 'rawAnchors', 'algorithmVersion', 'inputHash', 'degreesOfFreedom', 'reviewStatus', 'outputs']) assert.deepEqual(after[key], before[key])
  assert.equal(after.reviewStatus, 'draft')
  assert.equal(after.verification.startedCount, 2); assert.equal(after.verification.finishedCount, 2); assert.equal(after.verification.incompleteCount, 0)
  assert.deepEqual(after.verification.attempts.slice(0, 1), before.verification.attempts)
  assert(after.verification.attempts.every(attempt => attempt.outcome === 'passed'))
}
writeFileSync(join(out, 'p0-summary-provenance.json'), JSON.stringify({ sourceLabel: 'interface-agent-reviewed-public-summary', phases: phases.map(({ file, sha256, originalBytesPreserved }) => ({ file, sha256, originalBytesPreserved })), contains: 'opaque identifiers, hashes, counts and bounded numerical comparison summaries only', originalAuditScriptSha256: sha(readFileSync('/private/tmp/railwise-53213-p0-audit.py')), excluded: ['private records', 'private source paths', 'point names and coordinates', 'full snapshot provenance', 'real-data screenshots and files'], restartPhase: 'selected-record-and-file-comparison-passed', comparison: { unchangedIdentityCount: 8, unchangedOutputCount: 6, eachNetworkStarted: 2, eachNetworkFinished: 2, eachNetworkIncomplete: 0, eachNetworkPassed: 2, draftStatusPreserved: true }, guiObservation: 'Parent agent observed normal exit, process absence, same-bundle restart and five checks passed for GSI at 17:23:42 and IN2 at 17:24:20 Asia/Shanghai on 2026-09-20; private AX retained locally, not published. The audit script itself does not certify GUI or restart.' }, null, 2) + '\n')
console.log(JSON.stringify({ status: 'copied-and-compared', phases: phases.map(({ file, sha256 }) => ({ file, sha256 })) }))
