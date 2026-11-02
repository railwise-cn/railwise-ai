import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { sanitizeTrustOutput, validateGatekeeperEvidence, verifyMacosUpdaterTrust } from './macos-updater-trust.mjs'

const enabled = { status: 0, stdout: '', stderr: 'assessments enabled\n' }
const accepted = { status: 0, stdout: '', stderr: 'accepted\nsource=Notarized Developer ID\n' }

test('trust diagnostic streams redact credential values and every URL before retention', () => {
  const output = sanitizeTrustOutput('ticket error https://apple.example/path?key=private test-token-123 /private-' + 'f'.repeat(64) + '/', { API_KEY: 'test-token-123' })
  assert.doesNotMatch(output, /apple\.example|private test-token|f{64}/)
  assert.match(output, /ticket error/)
})

function fakeRunner({ staplerExit = 0, gatekeeperStatus = enabled, assessment = accepted } = {}) {
  const calls = []
  const run = (command, args, options = {}) => {
    calls.push([command, ...args])
    let result = { status: 0, stdout: '', stderr: '' }
    if (command.endsWith('/xattr') && args.length === 1 && args[0] !== '-px') result.stdout = 'com.apple.quarantine\n'
    if (command.endsWith('/xattr') && args[0] === '-px') result.stdout = '616263\n'
    if (args[0] === '--status') result = gatekeeperStatus
    if (args[0] === '--assess') result = assessment
    if (args[0] === 'stapler') result = { status: staplerExit, stdout: '', stderr: staplerExit ? 'ticket validation failed\n' : 'The ticket is valid.\n' }
    options.onResult?.(result)
    if (result.status !== 0 && !(options.allowedExitCodes ?? [0]).includes(result.status)) {
      throw new Error(`${args[0]} failed (${result.status})`)
    }
    return result
  }
  return { run, calls }
}

test('trust check requires enabled Gatekeeper and Notarized Developer ID before accepting the bundle', () => {
  assert.deepEqual(validateGatekeeperEvidence(enabled, accepted), {
    gatekeeper: 'accepted', gatekeeperAssessments: 'enabled', gatekeeperSource: 'Notarized Developer ID',
  })
  assert.throws(() => validateGatekeeperEvidence({ ...enabled, stderr: 'assessments disabled\n' }, accepted), /must be enabled/)
  assert.throws(() => validateGatekeeperEvidence(enabled, { ...accepted, stderr: 'accepted\nsource=Developer ID\n' }), /Notarized Developer ID/)
  assert.throws(() => validateGatekeeperEvidence(enabled, { ...accepted, status: 1 }), /Notarized Developer ID/)
})

test('every trust boundary fails closed on stapler errors and preserves sanitized diagnostics', () => {
  const app = mkdtempSync(join(tmpdir(), 'updater-trust-boundary-'))
  try {
    const { run, calls } = fakeRunner({ staplerExit: 68 })
    const events = []
    assert.throws(() => verifyMacosUpdaterTrust(app, { boundary: 'target-zip-preflight', run, record: event => events.push(event) }), /Stapled notarization validation failed.*exit 68/)
    assert.ok(calls.some(call => call.includes('stapler')))
    assert.equal(events.find(event => event.command === 'stapler-validate').boundary, 'target-zip-preflight')
    assert.equal(events.find(event => event.command === 'stapler-validate').exitCode, 68)
    assert.equal(events.find(event => event.command === 'stapler-validate').stderr, 'ticket validation failed\n')
    assert.ok(calls.some(call => call.includes('--assess')), 'Gatekeeper assessment should still be captured after stapler failure')
    assert.equal(events.some(event => event.operation === 'bundle-trust-boundary' && event.status === 'completed'), false)
  } finally { rmSync(app, { recursive: true, force: true }) }
})

test('trust check captures xattr names and fingerprints but not raw attribute values', () => {
  const app = mkdtempSync(join(tmpdir(), 'updater-trust-xattr-'))
  try {
    const { run } = fakeRunner()
    const events = []
    const result = verifyMacosUpdaterTrust(app, { boundary: 'target-zip-preflight', run, record: event => events.push(event) })
    assert.deepEqual(result, {
      signature: 'verified', stapledNotarization: 'verified', gatekeeper: 'accepted',
      gatekeeperAssessments: 'enabled', gatekeeperSource: 'Notarized Developer ID',
    })
    const fingerprint = events.find(event => event.operation === 'bundle-xattr-fingerprint')
    assert.deepEqual({ name: fingerprint.name, size: fingerprint.size, sha256: fingerprint.sha256 }, {
      name: 'com.apple.quarantine', size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    })
    assert.equal(JSON.stringify(events).includes('616263'), false)
  } finally { rmSync(app, { recursive: true, force: true }) }
})

test('disabled Gatekeeper is diagnosed without relaxing the package trust checks', () => {
  const app = mkdtempSync(join(tmpdir(), 'updater-trust-gatekeeper-'))
  try {
    const { run, calls } = fakeRunner({ gatekeeperStatus: { status: 0, stdout: '', stderr: 'assessments disabled\n' } })
    const events = []
    assert.throws(() => verifyMacosUpdaterTrust(app, { boundary: 'target-zip-preflight', run, record: event => events.push(event) }), /must be enabled/)
    assert.equal(calls.some(call => call.includes('stapler')), true)
    assert.equal(events.find(event => event.command === 'gatekeeper-status').stderr, 'assessments disabled\n')
  } finally { rmSync(app, { recursive: true, force: true }) }
})
