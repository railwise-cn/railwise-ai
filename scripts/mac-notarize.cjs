const { execFileSync, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { createReadStream, existsSync, lstatSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, join } = require('node:path')

function getNotaryCredentials() {
  const keyId = process.env.APPLE_API_KEY_ID
  const issuer = process.env.APPLE_API_ISSUER
  const keyPath = process.env.APPLE_API_KEY
  const keyBase64 = process.env.APPLE_API_KEY_BASE64

  if (!keyId || !issuer || (!keyPath && !keyBase64)) {
    return null
  }

  if (keyPath) {
    return { keyId, issuer, keyPath, cleanup: null }
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'workwise-notary-'))
  const tempKeyPath = join(tempDir, `AuthKey_${keyId}.p8`)
  writeFileSync(tempKeyPath, Buffer.from(keyBase64, 'base64'), { mode: 0o600 })

  return {
    keyId,
    issuer,
    keyPath: tempKeyPath,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true })
  }
}

function redactNotaryText(value, creds) {
  let text = String(value || '')
  for (const secret of [creds?.keyPath, creds?.keyId, creds?.issuer, process.env.APPLE_API_KEY_BASE64]) {
    if (secret) text = text.split(secret).join('[redacted]')
  }
  // Apple may return a signed log URL. Keep its origin/path, never its query.
  return text.replace(/(https?:\/\/[^\s"?]+)\?[^\s"]+/g, '$1?[redacted]')
}

function notaryError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function positiveDuration(value, fallback, name) {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer in milliseconds`)
  }
  return parsed
}

function notarySettings(env = process.env) {
  return {
    // Upload and Apple's processing queue are different operations. The old
    // timeout remains an alias for the upload command, not the entire queue.
    uploadTimeoutMs: positiveDuration(env.WORKWISE_NOTARY_UPLOAD_TIMEOUT_MS ?? env.WORKWISE_NOTARY_TIMEOUT_MS, 10 * 60_000, 'WORKWISE_NOTARY_UPLOAD_TIMEOUT_MS'),
    queryTimeoutMs: positiveDuration(env.WORKWISE_NOTARY_QUERY_TIMEOUT_MS, 60_000, 'WORKWISE_NOTARY_QUERY_TIMEOUT_MS'),
    processingTimeoutMs: positiveDuration(env.WORKWISE_NOTARY_PROCESSING_TIMEOUT_MS, 30 * 60_000, 'WORKWISE_NOTARY_PROCESSING_TIMEOUT_MS'),
    pollIntervalMs: positiveDuration(env.WORKWISE_NOTARY_POLL_INTERVAL_MS, 15_000, 'WORKWISE_NOTARY_POLL_INTERVAL_MS'),
    staplerTimeoutMs: positiveDuration(env.WORKWISE_STAPLER_TIMEOUT_MS, 3 * 60_000, 'WORKWISE_STAPLER_TIMEOUT_MS')
  }
}

function runNotaryToolJson(args, { timeoutMs, creds } = {}) {
  const phase = args[0]
  let output
  try {
    output = execFileSync('xcrun', ['notarytool', ...args, '--output-format', 'json'], {
      encoding: 'utf8',
      // An explicit pipe prevents execFileSync from mirroring failed-command
      // stderr to the parent before it can be redacted.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs ?? notarySettings().queryTimeoutMs,
      killSignal: 'SIGKILL'
    })
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') {
      throw notaryError('command-timeout', `notarytool ${phase} did not return within ${timeoutMs ?? notarySettings().queryTimeoutMs} ms`)
    }
    // execFileSync's message includes the complete command and credential
    // arguments. Report only redacted tool output and the exit status.
    const detail = redactNotaryText(`${error?.stderr || ''}\n${error?.stdout || ''}`.trim(), creds).slice(0, 8000)
    throw notaryError('tool-failure', `notarytool ${phase} failed (exit ${error?.status ?? error?.code ?? 'unknown'})${detail ? `: ${detail}` : ''}`)
  }

  try {
    return JSON.parse(output)
  } catch {
    // JSON.parse can embed a raw output snippet in its error message.
    throw notaryError('invalid-response', `notarytool ${phase} returned invalid JSON`)
  }
}

function writeNotaryEvidence(path, evidence) {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function runStapler(args, { timeoutMs }) {
  try {
    execFileSync('xcrun', ['stapler', ...args], { stdio: 'inherit', timeout: timeoutMs, killSignal: 'SIGKILL' })
  } catch (error) {
    throw notaryError(
      error?.code === 'ETIMEDOUT' ? 'command-timeout' : 'stapler-failure',
      `stapler ${args[0]} ${error?.code === 'ETIMEDOUT' ? `did not return within ${timeoutMs} ms` : `failed (exit ${error?.status ?? error?.code ?? 'unknown'})`}`
    )
  }
}

async function notarizeArchive(zipPath, appBundle, creds, options = {}) {
  const settings = options.settings ?? notarySettings()
  const run = options.run ?? runNotaryToolJson
  const staple = options.staple ?? runStapler
  const now = options.now ?? Date.now
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const evidencePath = options.evidencePath ?? join(join(appBundle, '..'), `notarization-${basename(appBundle, '.app')}.json`)
  const auth = ['--key', creds.keyPath, '--key-id', creds.keyId, '--issuer', creds.issuer]
  const evidence = {
    schemaVersion: 1,
    appBundle: basename(appBundle),
    archive: basename(zipPath),
    archiveSha256: await sha256File(zipPath),
    startedAt: new Date(now()).toISOString(),
    phase: 'uploading',
    submissionId: null,
    appleStatus: null,
    settings,
    stapled: false,
    stapleValidated: false,
    events: []
  }
  const record = (phase, detail = {}) => {
    evidence.phase = phase
    evidence.events.push({ at: new Date(now()).toISOString(), phase, ...detail })
    writeNotaryEvidence(evidencePath, evidence)
    console.log(`[mac-notarize] ${phase}${evidence.submissionId ? ` submission=${evidence.submissionId}` : ''}${evidence.appleStatus ? ` status=${evidence.appleStatus}` : ''}${detail.message ? `: ${detail.message}` : ''}`)
  }
  const validateResult = (result, expectedId, allowMissingStatus = false) => {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result?.id || '') || (expectedId && result.id !== expectedId)) {
      throw notaryError('invalid-response', `notarytool returned a missing or mismatched submission ID`)
    }
    // submit --no-wait can acknowledge the upload with only id/message. Only
    // info (or an explicitly returned status) establishes the processing state.
    if (!(allowMissingStatus && result.status === undefined) && !['In Progress', 'Accepted', 'Invalid', 'Rejected'].includes(result.status)) {
      throw notaryError('invalid-response', `notarytool returned an unrecognized submission status`)
    }
  }

  try {
    record('uploading', { timeoutMs: settings.uploadTimeoutMs })
    // Never combine upload with --wait: save the ID before the processing queue.
    let result = await run(['submit', zipPath, ...auth], { timeoutMs: settings.uploadTimeoutMs, creds })
    validateResult(result, undefined, true)
    evidence.submissionId = result.id
    evidence.appleStatus = result.status ?? null
    record('submitted')
    const deadline = now() + settings.processingTimeoutMs
    let queryFailures = 0

    while (evidence.appleStatus === null || evidence.appleStatus === 'In Progress') {
      let remainingMs = deadline - now()
      if (remainingMs <= 0) {
        throw notaryError('processing-timeout', `Apple processing did not reach a final status within ${settings.processingTimeoutMs} ms. Submission ${evidence.submissionId} last reported ${evidence.appleStatus ?? 'no processing status yet'}; the submission ID is retained for further status checks. This does not identify the cause of the delay.`)
      }
      record('waiting', { remainingMs })
      await wait(Math.min(settings.pollIntervalMs, remainingMs))
      remainingMs = deadline - now()
      if (remainingMs <= 0) continue
      try {
        result = await run(['info', evidence.submissionId, ...auth], { timeoutMs: Math.min(settings.queryTimeoutMs, remainingMs), creds })
      } catch (error) {
        queryFailures += 1
        const message = redactNotaryText(error.message, creds)
        record('status-query-failed', { kind: error.code || 'tool-failure', message, consecutiveFailures: queryFailures })
        if (queryFailures >= 3 || /(?:\b40[13]\b|unauthori[sz]ed|forbidden|invalid credentials|unable to authenticate)/i.test(message)) throw error
        continue
      }
      validateResult(result, evidence.submissionId)
      queryFailures = 0
      evidence.appleStatus = result.status
      record('status-received')
    }

    if (evidence.appleStatus !== 'Accepted') {
      try {
        const log = await run(['log', evidence.submissionId, ...auth], { timeoutMs: settings.queryTimeoutMs, creds })
        const logPath = `${evidencePath}.apple-log.json`
        writeFileSync(logPath, `${redactNotaryText(JSON.stringify(log, null, 2), creds)}\n`, { mode: 0o600 })
        evidence.appleLog = basename(logPath)
        record('rejected', { message: `Apple diagnostic log saved to ${basename(logPath)}` })
      } catch (error) {
        record('log-unavailable', { message: redactNotaryText(error.message, creds) })
      }
      throw notaryError('notarization-rejected', `Apple notarization returned ${evidence.appleStatus} for submission ${evidence.submissionId}; see ${evidencePath}`)
    }

    record('accepted')
    record('stapling')
    await staple(['staple', appBundle], { timeoutMs: settings.staplerTimeoutMs })
    evidence.stapled = true
    record('validating-staple')
    await staple(['validate', appBundle], { timeoutMs: settings.staplerTimeoutMs })
    evidence.stapleValidated = true
    evidence.completedAt = new Date(now()).toISOString()
    record('complete')
    return evidence
  } catch (error) {
    evidence.failure = { stage: evidence.phase, kind: error.code || 'tool-failure', message: redactNotaryText(error.message, creds) }
    record('failed', evidence.failure)
    throw notaryError(evidence.failure.kind, `${evidence.failure.message}. Diagnostics: ${evidencePath}`)
  }
}

function isBundleLike(path) {
  return /\.(app|appex|bundle|framework|plugin|xpc)$/i.test(path)
}

function isLikelySignedFile(path, info) {
  if (/\.(dylib|node|so)$/i.test(path)) return true
  if (/\/app\.asar\.unpacked\/sidecars\/markitdown\/_internal\/Python\.framework\/Versions\/[^/]+\/Python$/i.test(path)) {
    return info.isFile() && (info.mode & 0o111) !== 0
  }
  return info.isFile() && (info.mode & 0o111) !== 0 && /\/Contents\/(?:MacOS|Frameworks)\//.test(path)
}

function collectSignedCodeCandidates(appBundle) {
  const candidates = new Set([appBundle])
  const stack = [appBundle]

  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) continue

      if (info.isDirectory()) {
        if (isBundleLike(path)) candidates.add(path)
        stack.push(path)
        continue
      }

      if (isLikelySignedFile(path, info)) {
        candidates.add(path)
      }
    }
  }

  return Array.from(candidates).sort()
}

function readCodeSignatureDetails(path) {
  const result = spawnSync('codesign', ['--display', '--verbose=4', path], {
    encoding: 'utf8',
    timeout: Number(process.env.WORKWISE_CODESIGN_TIMEOUT_MS || 30_000),
    killSignal: 'SIGKILL'
  })
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(`codesign --display timed out after ${process.env.WORKWISE_CODESIGN_TIMEOUT_MS || 30_000} ms: ${path}`)
    }
    throw result.error
  }
  const details = `${result.stdout || ''}${result.stderr || ''}`

  if (result.status !== 0) {
    throw new Error(`codesign --display failed for ${path} with status ${result.status}\n${details}`)
  }

  return details
}

const REQUIRED_RUNTIME_ENTITLEMENTS = [
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation'
]

function collectRuntimeExecutables(appBundle) {
  const executables = []
  const stack = [appBundle]

  while (stack.length) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        stack.push(path)
        continue
      }
      if (path.includes('/Contents/MacOS/') && (info.mode & 0o111) !== 0) {
        executables.push(path)
      }
    }
  }

  return executables.sort()
}

function readEntitlements(path) {
  const result = spawnSync('codesign', ['--display', '--entitlements', ':-', path], {
    encoding: 'utf8'
  })
  if (result.error) throw result.error
  const details = `${result.stdout || ''}${result.stderr || ''}`
  if (result.status !== 0) {
    throw new Error(`codesign entitlement inspection failed for ${path} with status ${result.status}\n${details}`)
  }
  return result.stdout || ''
}

function missingRuntimeEntitlements(entitlements) {
  return REQUIRED_RUNTIME_ENTITLEMENTS.filter((key) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return !new RegExp(`<key>${escaped}</key>\\s*<true\\s*/>`, 's').test(entitlements)
  })
}

function verifyMacRuntimeEntitlements(appBundle) {
  const executables = collectRuntimeExecutables(appBundle)
  if (!executables.length) {
    throw new Error(`No macOS runtime executables found under ${appBundle}`)
  }

  for (const executable of executables) {
    const entitlements = readEntitlements(executable)
    const missing = missingRuntimeEntitlements(entitlements)
    if (missing.length) {
      throw new Error(
        `macOS runtime signature is missing required Electron/V8 entitlements (${missing.join(', ')}): ${executable}`
      )
    }
  }

  console.log(`[mac-notarize] Verified Electron/V8 entitlements on ${executables.length} macOS runtime executable(s).`)
}

function verifySecureTimestamps(appBundle) {
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle], {
    stdio: 'inherit'
  })

  const candidates = collectSignedCodeCandidates(appBundle)
  console.log(`[mac-notarize] Verifying secure timestamps for ${candidates.length} signed code candidate(s).`)
  for (const [index, candidate] of candidates.entries()) {
    console.log(`[mac-notarize] Checking secure timestamp ${index + 1}/${candidates.length}: ${candidate}`)
    const details = readCodeSignatureDetails(candidate)
    if (!/^Timestamp=/m.test(details)) {
      throw new Error(
        `The signature is missing a secure timestamp: ${candidate}. Ensure electron-builder mac.timestamp is enabled.`
      )
    }
  }
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') {
    return
  }

  const appBundle = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!existsSync(appBundle)) {
    throw new Error(`App bundle not found for notarization: ${appBundle}`)
  }

  // Validate the runtime signature even when notarization credentials are not
  // present. A bad hardened-runtime signature crashes Electron/V8 before JS
  // starts, so allowing the build to continue would produce an unusable app.
  verifyMacRuntimeEntitlements(appBundle)

  const creds = getNotaryCredentials()
  if (!creds) {
    console.log('[mac-notarize] No Apple notary credentials found, skipping notarization.')
    return
  }

  const zipPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}-notary.zip`)

  try {
    verifySecureTimestamps(appBundle)

    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appBundle, zipPath], {
      stdio: 'inherit'
    })

    await notarizeArchive(zipPath, appBundle, creds)
  } finally {
    rmSync(zipPath, { force: true })
    creds.cleanup?.()
  }
}

exports._internals = {
  notarizeArchive,
  notarySettings,
  runNotaryToolJson,
  redactNotaryText,
  notaryError,
  collectSignedCodeCandidates,
  isBundleLike,
  isLikelySignedFile,
  readCodeSignatureDetails,
  collectRuntimeExecutables,
  readEntitlements,
  missingRuntimeEntitlements,
  verifyMacRuntimeEntitlements,
  REQUIRED_RUNTIME_ENTITLEMENTS
}
