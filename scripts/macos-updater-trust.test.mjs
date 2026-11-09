import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureMacosTrustEnvironment, sanitizeTrustOutput, validateGatekeeperEvidence, verifyMacosUpdaterTrust } from './macos-updater-trust.mjs'

const enabled = { status: 0, stdout: '', stderr: 'assessments enabled\n' }
const accepted = { status: 0, stdout: '', stderr: 'accepted\nsource=Notarized Developer ID\n' }
const cdhash = '8747a7e9782b590c95d51545aca9c540e7cc2c23'
const stapleIdentity = `Props are {\n    cdhash = {length = 20, bytes = 0x${cdhash}};\n    signingId = com.wangjiawei508.workgpt;\n    teamId = R35G7F4A9U;\n}\n`
const codeIdentity = `Identifier=com.wangjiawei508.workgpt\nCDHash=${cdhash}\nTeamIdentifier=R35G7F4A9U\n`
const cloudKitFailure = {
  status: 68, stderr: '', stdout: stapleIdentity + 'Domain is api.apple-cloudkit.com\nResponse is (null)\n'
    + 'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost." UserInfo={}\n'
    + "Size of data is 0\nCloudKit's response is inconsistent with expections: (null)\nThe validate action failed! Error 68.\n",
}
const stapleSuccess = { status: 0, stderr: '', stdout: stapleIdentity + 'The validate action worked!\n' }

function signedFixture() {
  const app = mkdtempSync(join(tmpdir(), 'updater-trust-sealed-'))
  mkdirSync(join(app, 'Contents/_CodeSignature'), { recursive: true })
  writeFileSync(join(app, 'Contents/Info.plist'), 'synthetic bundle metadata')
  writeFileSync(join(app, 'Contents/_CodeSignature/CodeResources'), 'synthetic signed resource seal')
  return app
}

test('trust diagnostic streams redact credential values and every URL before retention', () => {
  const output = sanitizeTrustOutput('ticket error https://apple.example/path?key=private test-token-123 /private-' + 'f'.repeat(64) + '/', { API_KEY: 'test-token-123' })
  assert.doesNotMatch(output, /apple\.example|private test-token|f{64}/)
  assert.match(output, /ticket error/)
})

test('runner diagnostics retain macOS/Xcode/stapler identities with both streams', () => {
  const events = []; const calls = []
  captureMacosTrustEnvironment({
    run: (command, args, options) => {
      calls.push([command, ...args])
      const result = { status: 0, stdout: 'tool-version\n', stderr: 'diagnostic\n' }
      options.onResult(result)
      return result
    },
    record: event => events.push(event),
  })
  assert.deepEqual(events.map(event => event.command), ['macos-version', 'xcode-selection', 'xcode-version', 'stapler-location'])
  assert.ok(calls.some(call => call[0] === '/usr/bin/sw_vers'))
  assert.ok(calls.some(call => call[0] === '/usr/bin/xcodebuild'))
  assert.equal(events.every(event => event.stdout === 'tool-version\n' && event.stderr === 'diagnostic\n'), true)
})

function fakeRunner({ staplerExit = 0, staplerResults, signatureExit = 0, identityOutput = codeIdentity, gatekeeperStatus = enabled, assessment = accepted } = {}) {
  const calls = []
  let staplerAttempt = 0
  const run = (command, args, options = {}) => {
    calls.push([command, ...args])
    let result = { status: 0, stdout: '', stderr: '' }
    if (command.endsWith('/xattr') && args.length === 1 && args[0] !== '-px') result.stdout = 'com.apple.quarantine\n'
    if (command.endsWith('/xattr') && args[0] === '-px') result.stdout = '616263\n'
    if (args[0] === '--status') result = gatekeeperStatus
    if (args[0] === '--assess') result = assessment
    if (command.endsWith('/codesign') && args[0] === '--verify') result.status = signatureExit
    if (command.endsWith('/codesign') && args[0] === '--display') result.stderr = identityOutput
    if (args[0] === 'stapler') {
      result = staplerResults ? staplerResults[Math.min(staplerAttempt, staplerResults.length - 1)]
        : { status: staplerExit, stdout: '', stderr: staplerExit ? 'ticket validation failed\n' : 'The ticket is valid.\n' }
      staplerAttempt += 1
    }
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

test('CloudKit -1005 retries only stapler, preserves failed attempts, and requires a successful ticket', () => {
  const app = signedFixture()
  try {
    const { run, calls } = fakeRunner({ staplerResults: [cloudKitFailure, stapleSuccess] })
    const events = []; const delays = []
    const result = verifyMacosUpdaterTrust(app, { boundary: 'native-installed-target', run,
      record: event => events.push(event), waitForRetry: ms => delays.push(ms) })
    assert.equal(result.stapledNotarization, 'verified')
    assert.deepEqual(delays, [500])
    assert.deepEqual(events.filter(event => event.command === 'stapler-validate' && event.operation === 'bundle-trust-diagnostic')
      .map(({ attempt, status, exitCode }) => ({ attempt, status, exitCode })), [
      { attempt: 1, status: 'failed', exitCode: 68 }, { attempt: 2, status: 'completed', exitCode: 0 },
    ])
    assert.match(events.find(event => event.command === 'stapler-validate').stdout, /Code=-1005/)
    assert.equal(events.filter(event => event.operation === 'bundle-trust-retry-identity' && event.status === 'verified').length, 1)
    assert.equal(events.filter(event => event.operation === 'bundle-trust-retry-result-identity' && event.status === 'verified').length, 1)
    assert.equal(calls.filter(call => call.includes('stapler')).length, 2)
    assert.equal(calls.every(call => ['/usr/bin/xattr', '/usr/sbin/spctl', '/usr/bin/codesign', '/usr/bin/xcrun'].includes(call[0])), true,
      'read-only trust retry must never invoke the updater, installer, or application')
  } finally { rmSync(app, { recursive: true, force: true }) }
})

test('persistent CloudKit transport interruption stops after three recorded attempts', () => {
  const app = signedFixture()
  try {
    const { run, calls } = fakeRunner({ staplerResults: [cloudKitFailure] })
    const events = []; const delays = []
    assert.throws(() => verifyMacosUpdaterTrust(app, { boundary: 'native-installed-target', run,
      record: event => events.push(event), waitForRetry: ms => delays.push(ms) }), /Stapled notarization validation failed.*exit 68/)
    assert.deepEqual(delays, [500, 1_000])
    assert.deepEqual(events.filter(event => event.operation === 'bundle-trust-diagnostic' && event.command === 'stapler-validate')
      .map(event => event.attempt), [1, 2, 3])
    assert.equal(calls.filter(call => call.includes('stapler')).length, 3)
    assert.equal(events.some(event => event.operation === 'bundle-trust-boundary' && event.status === 'completed'), false)
  } finally { rmSync(app, { recursive: true, force: true }) }
})

test('invalid tickets, server responses, unrelated errors and process failures never retry', () => {
  const app = signedFixture()
  try {
    const failures = [
      { ...cloudKitFailure, stdout: cloudKitFailure.stdout + 'The ticket is invalid.\n' },
      { ...cloudKitFailure, stdout: cloudKitFailure.stdout + 'Status Code: 403\n' },
      { ...cloudKitFailure, stdout: cloudKitFailure.stdout.replace('api.apple-cloudkit.com', 'example.invalid') },
      { ...cloudKitFailure, stdout: cloudKitFailure.stdout.replace('Code=-1005', 'Code=-1001') },
      { ...cloudKitFailure, status: 1 },
      { ...cloudKitFailure, signal: 'SIGTERM' },
      { ...cloudKitFailure, error: { code: 'ETIMEDOUT' } },
      { status: 68, stdout: 'Could not validate ticket.\n', stderr: '' },
    ]
    for (const failure of failures) {
      const { run, calls } = fakeRunner({ staplerResults: [failure, stapleSuccess] })
      const delays = []
      assert.throws(() => verifyMacosUpdaterTrust(app, { boundary: 'target-zip-preflight', run,
        waitForRetry: ms => delays.push(ms) }), /Stapled notarization validation failed/)
      assert.equal(calls.filter(call => call.includes('stapler')).length, 1)
      assert.deepEqual(delays, [])
    }
  } finally { rmSync(app, { recursive: true, force: true }) }
})

test('a replaced resource seal or code identity prevents the next stapler attempt', () => {
  for (const mutation of ['resource-seal', 'code-identity']) {
    const app = signedFixture()
    try {
      const { run, calls } = fakeRunner({ staplerResults: [cloudKitFailure, stapleSuccess],
        ...(mutation === 'code-identity' ? { identityOutput: codeIdentity.replace(cdhash, 'f'.repeat(40)) } : {}) })
      const events = []
      assert.throws(() => verifyMacosUpdaterTrust(app, { boundary: 'native-installed-target', run,
        record: event => events.push(event), waitForRetry: () => {
          if (mutation === 'resource-seal') writeFileSync(join(app, 'Contents/_CodeSignature/CodeResources'), 'replaced seal')
        } }), /sealed identity changed.*before notarization retry/)
      assert.equal(calls.filter(call => call.includes('stapler')).length, 1)
      assert.equal(events.find(event => event.operation === 'bundle-trust-retry-identity').status, 'failed')
    } finally { rmSync(app, { recursive: true, force: true }) }
  }
})

test('a different bundle returned by a successful retry cannot satisfy the trust boundary', () => {
  const app = signedFixture()
  try {
    const changedBundle = { ...stapleSuccess, stdout: stapleSuccess.stdout.replace(cdhash, 'f'.repeat(40)) }
    const { run, calls } = fakeRunner({ staplerResults: [cloudKitFailure, changedBundle] })
    const events = []
    assert.throws(() => verifyMacosUpdaterTrust(app, { boundary: 'native-installed-target', run,
      record: event => events.push(event), waitForRetry: () => {} }), /sealed identity changed.*during notarization retry/)
    assert.equal(calls.filter(call => call.includes('stapler')).length, 2)
    assert.equal(events.find(event => event.operation === 'bundle-trust-retry-result-identity').status, 'failed')
    assert.equal(events.some(event => event.operation === 'bundle-trust-boundary' && event.status === 'completed'), false)
  } finally { rmSync(app, { recursive: true, force: true }) }
})

test('missing identity evidence or failed initial signature cannot enable transport retries', () => {
  for (const unavailable of ['resource-seal', 'stapler-identity', 'code-signature']) {
    const app = unavailable === 'resource-seal' ? mkdtempSync(join(tmpdir(), 'updater-trust-no-seal-')) : signedFixture()
    try {
      const failure = unavailable === 'stapler-identity' ? { ...cloudKitFailure, stdout: cloudKitFailure.stdout.replace(stapleIdentity, '') } : cloudKitFailure
      const { run, calls } = fakeRunner({ staplerResults: [failure, stapleSuccess], signatureExit: unavailable === 'code-signature' ? 1 : 0 })
      assert.throws(() => verifyMacosUpdaterTrust(app, { boundary: 'native-installed-target', run,
        waitForRetry: () => assert.fail('unverifiable bundle must not schedule a retry') }), /verification failed|validation failed/)
      assert.equal(calls.filter(call => call.includes('stapler')).length, 1)
    } finally { rmSync(app, { recursive: true, force: true }) }
  }
})
