import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const { notarizeArchive, notarySettings, runNotaryToolJson, notaryError } = require('../../scripts/mac-notarize.cjs')._internals
const submissionId = 'a1234567-1234-1234-1234-123456789abc'
const otherId = 'b1234567-1234-1234-1234-123456789abc'
const creds = { keyPath: '/private/secret/AuthKey.p8', keyId: 'SECRETKEYID', issuer: 'SECRETISSUER' }
const roots: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'railwise-notary-test-'))
  roots.push(root)
  const archive = join(root, 'Candidate-notary.zip')
  const app = join(root, 'Candidate.app')
  const evidencePath = join(root, 'notarization-Candidate.json')
  writeFileSync(archive, 'exact archive bytes')
  let clock = Date.parse('2026-10-07T00:00:00Z')
  return {
    root, archive, app, evidencePath,
    evidence: () => JSON.parse(readFileSync(evidencePath, 'utf8')),
    options: {
      evidencePath,
      now: () => clock,
      wait: async (ms: number) => { clock += ms },
      settings: { uploadTimeoutMs: 100, queryTimeoutMs: 20, processingTimeoutMs: 100, pollIntervalMs: 10, staplerTimeoutMs: 30 }
    }
  }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('macOS notarization phases and release gate', () => {
  it('persists the upload ID and archive hash before querying Apple, then staples only an Accepted submission', async () => {
    const f = fixture()
    const actions: string[] = []
    let query = 0
    const run = vi.fn((args: string[], options: { timeoutMs: number }) => {
      actions.push(args[0])
      if (args[0] === 'submit') {
        expect(args).not.toContain('--wait')
        expect(options.timeoutMs).toBe(100)
        return { id: submissionId, message: 'Successfully uploaded file' }
      }
      const persisted = f.evidence()
      expect(persisted.submissionId).toBe(submissionId)
      expect(persisted.archiveSha256).toBe(createHash('sha256').update('exact archive bytes').digest('hex'))
      expect(persisted.stapled).toBe(false)
      expect(options.timeoutMs).toBeLessThanOrEqual(20)
      return { id: submissionId, status: ++query === 1 ? 'In Progress' : 'Accepted' }
    })
    const staple = vi.fn((args: string[]) => {
      expect(f.evidence().appleStatus).toBe('Accepted')
      actions.push(args[0])
    })

    const result = await notarizeArchive(f.archive, f.app, creds, { ...f.options, run, staple })

    expect(actions).toEqual(['submit', 'info', 'info', 'staple', 'validate'])
    expect(result).toMatchObject({ phase: 'complete', submissionId, appleStatus: 'Accepted', stapled: true, stapleValidated: true })
    expect(f.evidence()).toEqual(result)
  })

  it('retains a queued submission ID on the total processing deadline without claiming a service outage', async () => {
    const f = fixture()
    const run = vi.fn(() => ({ id: submissionId, status: 'In Progress' }))
    const staple = vi.fn()

    await expect(notarizeArchive(f.archive, f.app, creds, { ...f.options, run, staple })).rejects.toThrow('does not identify the cause')

    expect(f.evidence()).toMatchObject({
      phase: 'failed', submissionId, appleStatus: 'In Progress', stapled: false,
      failure: { stage: 'waiting', kind: 'processing-timeout' }
    })
    expect(staple).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(10)
  })

  it('distinguishes an upload timeout from queue processing and never fabricates a submission ID', async () => {
    const f = fixture()
    const run = vi.fn(() => { throw notaryError('command-timeout', 'notarytool submit did not return within 100 ms') })
    const staple = vi.fn()

    await expect(notarizeArchive(f.archive, f.app, creds, { ...f.options, run, staple })).rejects.toThrow('notarytool submit')

    expect(f.evidence()).toMatchObject({ submissionId: null, appleStatus: null, failure: { stage: 'uploading', kind: 'command-timeout' } })
    expect(staple).not.toHaveBeenCalled()
  })

  it('archives the actual rejected-submission log with credential and signed-URL redaction', async () => {
    const f = fixture()
    const run = vi.fn((args: string[]) => args[0] === 'submit'
      ? { id: submissionId, status: 'Invalid' }
      : { issues: [{ severity: 'error', message: `Missing timestamp ${creds.keyId} ${creds.keyPath} ${creds.issuer}` }], developerLogUrl: 'https://apple.example/log?token=SECRETQUERY' })
    const staple = vi.fn()

    await expect(notarizeArchive(f.archive, f.app, creds, { ...f.options, run, staple })).rejects.toThrow('returned Invalid')

    expect(run.mock.calls.map(([args]) => args[0])).toEqual(['submit', 'log'])
    const saved = readFileSync(`${f.evidencePath}.apple-log.json`, 'utf8')
    expect(saved).toContain('Missing timestamp')
    for (const secret of [creds.keyId, creds.keyPath, creds.issuer, 'SECRETQUERY']) expect(saved).not.toContain(secret)
    expect(JSON.parse(saved).developerLogUrl).toBe('https://apple.example/log?[redacted]')
    expect(f.evidence()).toMatchObject({ appleStatus: 'Invalid', failure: { kind: 'notarization-rejected' } })
    expect(staple).not.toHaveBeenCalled()
  })

  it('retries a bounded transient status-query failure while preserving the same submission identity', async () => {
    const f = fixture()
    let query = 0
    const run = vi.fn((args: string[]) => {
      if (args[0] === 'submit') return { id: submissionId }
      if (++query === 1) throw notaryError('command-timeout', 'notarytool info did not return')
      return { id: submissionId, status: 'Accepted' }
    })
    const staple = vi.fn()

    await notarizeArchive(f.archive, f.app, creds, { ...f.options, run, staple })

    expect(run.mock.calls.filter(([args]) => args[0] === 'info').map(([args]) => args[1])).toEqual([submissionId, submissionId])
    expect(f.evidence().events).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'status-query-failed', consecutiveFailures: 1 })]))
    expect(staple).toHaveBeenCalledTimes(2)
  })

  it('stops after three consecutive status-query failures or immediately on an authorization failure', async () => {
    for (const [message, expectedQueries] of [['connection reset', 3], ['HTTP 401 Unauthorized', 1]] as const) {
      const f = fixture()
      const run = vi.fn((args: string[]) => {
        if (args[0] === 'submit') return { id: submissionId }
        throw notaryError('tool-failure', message)
      })
      const staple = vi.fn()

      await expect(notarizeArchive(f.archive, f.app, creds, { ...f.options, run, staple })).rejects.toThrow(message)

      expect(run.mock.calls.filter(([args]) => args[0] === 'info')).toHaveLength(expectedQueries)
      expect(f.evidence().submissionId).toBe(submissionId)
      expect(staple).not.toHaveBeenCalled()
    }
  })

  it('rejects a different submission or unknown state even if a response claims acceptance', async () => {
    for (const reply of [{ id: otherId, status: 'Accepted' }, { id: submissionId, status: 'New Unknown State' }]) {
      const f = fixture()
      const run = vi.fn((args: string[]) => args[0] === 'submit' ? { id: submissionId } : reply)
      const staple = vi.fn()

      await expect(notarizeArchive(f.archive, f.app, creds, { ...f.options, run, staple })).rejects.toThrow()

      expect(f.evidence().failure.kind).toBe('invalid-response')
      expect(staple).not.toHaveBeenCalled()
    }
  })

  it('blocks release when ticket validation fails after Apple acceptance and successful stapling', async () => {
    const f = fixture()
    const run = vi.fn(() => ({ id: submissionId, status: 'Accepted' }))
    const staple = vi.fn((args: string[]) => {
      if (args[0] === 'validate') throw notaryError('stapler-failure', 'stapler validate failed')
    })

    await expect(notarizeArchive(f.archive, f.app, creds, { ...f.options, run, staple })).rejects.toThrow('validate failed')

    expect(f.evidence()).toMatchObject({ appleStatus: 'Accepted', stapled: true, stapleValidated: false, failure: { stage: 'validating-staple', kind: 'stapler-failure' } })
  })

  it('separates upload/query/processing timeouts and rejects invalid configuration', () => {
    expect(notarySettings({ WORKWISE_NOTARY_TIMEOUT_MS: '123' })).toMatchObject({ uploadTimeoutMs: 123, queryTimeoutMs: 60_000, processingTimeoutMs: 1_800_000 })
    expect(notarySettings({ WORKWISE_NOTARY_UPLOAD_TIMEOUT_MS: '234', WORKWISE_NOTARY_TIMEOUT_MS: '123' }).uploadTimeoutMs).toBe(234)
    for (const invalid of ['NaN', '0', '-1', '1.5']) expect(() => notarySettings({ WORKWISE_NOTARY_PROCESSING_TIMEOUT_MS: invalid })).toThrow('positive integer')
  })

  it('reports actual subprocess failures without exposing auth arguments or signed-URL query strings', () => {
    const f = fixture()
    const xcrun = join(f.root, 'xcrun')
    writeFileSync(xcrun, `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(`${creds.keyPath} ${creds.keyId} ${creds.issuer} https://apple.example/log?token=SECRETSIGNEDURL`)}); process.exit(3)\n`)
    chmodSync(xcrun, 0o755)
    vi.stubEnv('PATH', `${f.root}:${process.env.PATH}`)
    const stderr = vi.spyOn(process.stderr, 'write')

    let failure = ''
    try {
      runNotaryToolJson(['info', submissionId, '--key', creds.keyPath, '--key-id', creds.keyId, '--issuer', creds.issuer], { timeoutMs: 5000, creds })
    } catch (error) {
      failure = (error as Error).message
    }

    expect(failure).toContain('exit 3')
    expect(failure).toContain('[redacted]')
    for (const secret of [creds.keyPath, creds.keyId, creds.issuer, 'SECRETSIGNEDURL']) expect(failure).not.toContain(secret)
    expect(failure).not.toContain('--key')
    expect(stderr).not.toHaveBeenCalled()
  })

  it('bounds a stalled subprocess and suppresses raw snippets from malformed JSON responses', () => {
    const f = fixture()
    const xcrun = join(f.root, 'xcrun')
    vi.stubEnv('PATH', `${f.root}:${process.env.PATH}`)
    writeFileSync(xcrun, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n')
    chmodSync(xcrun, 0o755)
    expect(() => runNotaryToolJson(['submit', f.archive], { timeoutMs: 100, creds })).toThrow('submit did not return within 100 ms')

    writeFileSync(xcrun, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(creds.keyId)})\n`)
    expect(() => runNotaryToolJson(['info', submissionId], { timeoutMs: 5000, creds })).toThrow('info returned invalid JSON')
  })
})
