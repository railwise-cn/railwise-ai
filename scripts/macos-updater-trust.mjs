import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const STAPLER_MAX_ATTEMPTS = 3
const STAPLER_RETRY_DELAYS_MS = [500, 1_000]

function ticketFileFingerprints(app) {
  return ['Contents/Info.plist', 'Contents/CodeResources', 'Contents/_CodeSignature/CodeResources'].flatMap(name => {
    const path = join(app, name)
    if (!existsSync(path)) return []
    const stat = lstatSync(path)
    return stat.isFile() ? [{ path: name, size: stat.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }] : [{ path: name, type: stat.isSymbolicLink() ? 'symlink' : 'other' }]
  })
}

function staplerIdentity(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const hash = /^\s*cdhash = \{length = (20|32), bytes = 0x([a-f0-9]+)\};\s*$/im.exec(output)
  const identifier = /^\s*signingId = ([A-Za-z0-9.-]+);\s*$/m.exec(output)?.[1]
  const team = /^\s*teamId = ([A-Z0-9]{10});\s*$/m.exec(output)?.[1]
  if (!hash || hash[2].length !== Number(hash[1]) * 2 || !identifier || !team) return undefined
  return { cdhash: hash[2].toLowerCase(), identifier, team }
}

function codesignIdentity(result) {
  if (result.error || result.status !== 0) return undefined
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const cdhash = /^CDHash=([a-f0-9]{40}|[a-f0-9]{64})\s*$/im.exec(output)?.[1]?.toLowerCase()
  const identifier = /^Identifier=([A-Za-z0-9.-]+)\s*$/m.exec(output)?.[1]
  const team = /^TeamIdentifier=([A-Z0-9]{10})\s*$/m.exec(output)?.[1]
  return cdhash && identifier && team ? { cdhash, identifier, team } : undefined
}

// Retry only the observed Apple CloudKit transport failure. An invalid/missing
// ticket, a server response, a process timeout, or another network error stays
// a hard failure. This retries a read-only query, never the updater operation.
function isCloudKitConnectionLoss(result) {
  if (result.error || result.signal || result.status !== 68) return false
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  return /^Domain is api\.apple-cloudkit\.com\s*$/m.test(output)
    && /^Response is \(null\)\s*$/m.test(output)
    && /^error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost\."(?:\s|$)/m.test(output)
    && /^Size of data is 0\s*$/m.test(output)
    && /^CloudKit's response is inconsistent with expections: \(null\)\s*$/m.test(output)
    && /^The validate action failed! Error 68\.\s*$/m.test(output)
    && !/Status Code:|(?:invalid|rejected|revoked|malformed|missing) ticket|ticket (?:is |was )?(?:invalid|rejected|revoked|malformed|missing)/i.test(output)
}

function waitForTrustRetry(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function sanitizeTrustOutput(value, env = process.env) {
  let text = String(value ?? '').slice(-16_000)
  for (const [name, secret] of Object.entries(env)) {
    if (/SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|CSC_LINK|P12_BASE64/i.test(name) && secret?.length >= 4) text = text.replaceAll(secret, '[redacted]')
  }
  return text.replace(/https?:\/\/[^\s"'<>]+/g, '[URL redacted]')
    .replace(/\/private-[a-f0-9]{64}(?:\/)?/gi, '/private-[redacted]/')
}

export function validateGatekeeperStatus(status) {
  if (status.error || status.status !== 0 || !/^assessments enabled\s*$/im.test(`${status.stdout ?? ''}\n${status.stderr ?? ''}`)) {
    throw new Error('Gatekeeper assessments must be enabled for updater acceptance.')
  }
}

export function validateGatekeeperEvidence(status, assessment) {
  validateGatekeeperStatus(status)
  const output = `${assessment.stdout ?? ''}\n${assessment.stderr ?? ''}`
  if (assessment.error || assessment.status !== 0 || !/(?:^|\n)[^\n]*\baccepted\s*$/im.test(output)
    || !/^source=Notarized Developer ID\s*$/m.test(output)) {
    throw new Error('Gatekeeper must accept the bundle as Notarized Developer ID.')
  }
  return { gatekeeper: 'accepted', gatekeeperAssessments: 'enabled', gatekeeperSource: 'Notarized Developer ID' }
}

export function captureMacosTrustEnvironment({ run, record = () => {} }) {
  const diagnostics = [
    ['/usr/bin/sw_vers', [], 'macos-version'],
    ['/usr/bin/xcode-select', ['-p'], 'xcode-selection'],
    ['/usr/bin/xcodebuild', ['-version'], 'xcode-version'],
    ['/usr/bin/xcrun', ['--find', 'stapler'], 'stapler-location'],
  ]
  for (const [command, args, label] of diagnostics) {
    run(command, args, {
      allowedExitCodes: Array.from({ length: 256 }, (_, code) => code),
      onResult: result => record({ operation: 'trust-runner-environment', command: label,
        status: result.error || result.status !== 0 ? 'failed' : 'recorded', exitCode: result.status,
        stdout: sanitizeTrustOutput(result.stdout), stderr: sanitizeTrustOutput(result.stderr),
      }),
    })
  }
}

// Boundary labels and diagnostic streams are retained before an exception can
// stop the harness. A failed command never becomes a successful trust result.
export function verifyMacosUpdaterTrust(app, { boundary, run, record = () => {}, waitForRetry = waitForTrustRetry }) {
  if (!/^[a-z][a-z0-9-]{2,80}$/.test(boundary ?? '')) throw new Error('A precise bundle trust boundary is required.')
  record({ operation: 'bundle-trust-boundary', status: 'started', boundary })
  const execute = (command, args, label, { attempt, ...options } = {}) => run(command, args, {
    ...options,
    onResult: result => record({
      operation: 'bundle-trust-diagnostic', boundary, command: label,
      ...(attempt ? { attempt, maxAttempts: STAPLER_MAX_ATTEMPTS } : {}),
      status: result.error || result.status !== 0 ? 'failed' : 'completed',
      exitCode: result.status, signal: result.signal ?? null,
      ...(result.error ? { errorCode: result.error.code ?? 'command-error' } : {}),
      stdout: sanitizeTrustOutput(result.stdout), stderr: sanitizeTrustOutput(result.stderr),
    }),
  })
  const ticketFiles = ticketFileFingerprints(app)
  record({ operation: 'bundle-ticket-files', boundary, status: 'recorded', files: ticketFiles })
  // Retain attribute names and value hashes, never raw resource-fork,
  // quarantine or provenance payloads. This is diagnostic only.
  const xattrs = execute('/usr/bin/xattr', [app], 'bundle-xattr-names', { allowedExitCodes: [0, 1] })
  for (const name of (xattrs.stdout ?? '').split(/\r?\n/).filter(name => /^[A-Za-z0-9_.:-]{1,200}$/.test(name)).slice(0, 64)) {
    run('/usr/bin/xattr', ['-px', name, app], {
      onResult: result => {
        const bytes = Buffer.from(String(result.stdout ?? '').replace(/\s/g, ''), 'hex')
        record({ operation: 'bundle-xattr-fingerprint', boundary, name,
          status: result.error || result.status !== 0 ? 'failed' : 'recorded', exitCode: result.status,
          ...(result.status === 0 ? { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } : {}),
          ...(result.status !== 0 ? { stderr: sanitizeTrustOutput(result.stderr) } : {}),
        })
      },
    })
  }
  const observedExitCodes = Array.from({ length: 256 }, (_, code) => code)
  const gatekeeperStatus = execute('/usr/sbin/spctl', ['--status'], 'gatekeeper-status', { allowedExitCodes: observedExitCodes })
  const signature = execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], 'codesign-verify', { allowedExitCodes: observedExitCodes })
  let staple = execute('/usr/bin/xcrun', ['stapler', 'validate', '-v', app], 'stapler-validate', { allowedExitCodes: observedExitCodes, attempt: 1 })
  const originalIdentity = staplerIdentity(staple)
  let gatekeeperEnabled = true
  try { validateGatekeeperStatus(gatekeeperStatus) } catch { gatekeeperEnabled = false }
  for (let attempt = 2; attempt <= STAPLER_MAX_ATTEMPTS && isCloudKitConnectionLoss(staple)
    && !signature.error && signature.status === 0 && gatekeeperEnabled; attempt += 1) {
    // Without both a signed code identity and its resource seal, fail closed
    // rather than validating a potentially replaced bundle on another attempt.
    if (!originalIdentity || !['Contents/Info.plist', 'Contents/_CodeSignature/CodeResources'].every(path => ticketFiles.some(file => file.path === path && file.sha256))) {
      record({ operation: 'bundle-trust-retry', boundary, command: 'stapler-validate', status: 'declined', reason: 'sealed-identity-unavailable', failedAttempt: attempt - 1 })
      break
    }
    const delayMs = STAPLER_RETRY_DELAYS_MS[attempt - 2]
    record({ operation: 'bundle-trust-retry', boundary, command: 'stapler-validate', status: 'scheduled',
      reason: 'apple-cloudkit-connection-lost', failedAttempt: attempt - 1, nextAttempt: attempt, maxAttempts: STAPLER_MAX_ATTEMPTS, delayMs })
    waitForRetry(delayMs)
    const files = ticketFileFingerprints(app)
    const retrySignature = execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], 'codesign-retry-verify', { allowedExitCodes: observedExitCodes, attempt })
    const identity = codesignIdentity(execute('/usr/bin/codesign', ['--display', '--verbose=4', app], 'codesign-retry-identity', { allowedExitCodes: observedExitCodes, attempt }))
    const unchanged = !retrySignature.error && retrySignature.status === 0
      && isDeepStrictEqual(files, ticketFiles) && isDeepStrictEqual(identity, originalIdentity)
    record({ operation: 'bundle-trust-retry-identity', boundary, attempt, status: unchanged ? 'verified' : 'failed', files, identity })
    if (!unchanged) throw new Error('Bundle sealed identity changed or could not be verified before notarization retry.')
    staple = execute('/usr/bin/xcrun', ['stapler', 'validate', '-v', app], 'stapler-validate', { allowedExitCodes: observedExitCodes, attempt })
    const sameResultIdentity = isDeepStrictEqual(staplerIdentity(staple), originalIdentity)
      && isDeepStrictEqual(ticketFileFingerprints(app), ticketFiles)
    record({ operation: 'bundle-trust-retry-result-identity', boundary, attempt, status: sameResultIdentity ? 'verified' : 'failed' })
    if (!sameResultIdentity) throw new Error('Bundle sealed identity changed or was unavailable during notarization retry.')
  }
  const assessment = execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], 'gatekeeper-assess', { allowedExitCodes: observedExitCodes })
  validateGatekeeperStatus(gatekeeperStatus)
  if (signature.error || signature.status !== 0) throw new Error('Deep code-signature verification failed at the bundle trust boundary.')
  if (staple.error || staple.status !== 0) throw new Error(`Stapled notarization validation failed at the bundle trust boundary (exit ${staple.status}).`)
  const gatekeeper = validateGatekeeperEvidence(gatekeeperStatus, assessment)
  record({ operation: 'bundle-trust-boundary', boundary, status: 'completed' })
  return { signature: 'verified', stapledNotarization: 'verified', ...gatekeeper }
}
