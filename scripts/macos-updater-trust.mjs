import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
export function verifyMacosUpdaterTrust(app, { boundary, run, record = () => {} }) {
  if (!/^[a-z][a-z0-9-]{2,80}$/.test(boundary ?? '')) throw new Error('A precise bundle trust boundary is required.')
  record({ operation: 'bundle-trust-boundary', status: 'started', boundary })
  const execute = (command, args, label, options = {}) => run(command, args, {
    ...options,
    onResult: result => record({
      operation: 'bundle-trust-diagnostic', boundary, command: label,
      status: result.error || result.status !== 0 ? 'failed' : 'completed',
      exitCode: result.status, signal: result.signal ?? null,
      ...(result.error ? { errorCode: result.error.code ?? 'command-error' } : {}),
      stdout: sanitizeTrustOutput(result.stdout), stderr: sanitizeTrustOutput(result.stderr),
    }),
  })
  const ticketFiles = ['Contents/Info.plist', 'Contents/CodeResources', 'Contents/_CodeSignature/CodeResources'].flatMap(name => {
    const path = join(app, name)
    if (!existsSync(path)) return []
    const stat = lstatSync(path)
    return stat.isFile() ? [{ path: name, size: stat.size, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }] : [{ path: name, type: stat.isSymbolicLink() ? 'symlink' : 'other' }]
  })
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
  const staple = execute('/usr/bin/xcrun', ['stapler', 'validate', '-v', app], 'stapler-validate', { allowedExitCodes: observedExitCodes })
  const assessment = execute('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', app], 'gatekeeper-assess', { allowedExitCodes: observedExitCodes })
  validateGatekeeperStatus(gatekeeperStatus)
  if (signature.status !== 0) throw new Error('Deep code-signature verification failed at the bundle trust boundary.')
  if (staple.status !== 0) throw new Error(`Stapled notarization validation failed at the bundle trust boundary (exit ${staple.status}).`)
  const gatekeeper = validateGatekeeperEvidence(gatekeeperStatus, assessment)
  record({ operation: 'bundle-trust-boundary', boundary, status: 'completed' })
  return { signature: 'verified', stapledNotarization: 'verified', ...gatekeeper }
}
