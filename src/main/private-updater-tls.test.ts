import { spawnSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { configurePrivateUpdaterTls, privateUpdaterCertificateResult, privateUpdaterRequestAllowed, validatePrivateUpdaterTls } from './private-updater-tls'

describe.skipIf(process.platform !== 'darwin')('private updater certificate pinning', () => {
  let root: string
  let executable: string
  let env: NodeJS.ProcessEnv
  let data: string
  let certificateSha256: string
  let input: { certificateSha256: string; sourceHead: string }
  let policy: { certificateSha256: string; feedUrl: string }
  const head = 'a'.repeat(40)
  const feedUrl = `https://127.0.0.1:49999/private-${'c'.repeat(64)}/`
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'workwise-private-updater-')))
    const name = `RailWise AI Candidate ${head.slice(0, 12)}`
    executable = join(root, 'Applications', `${name}.app`, 'Contents/MacOS', name)
    mkdirSync(dirname(executable), { recursive: true }); writeFileSync(executable, '')
    mkdirSync(join(root, 'user-data'))
    env = {
      GITHUB_ACTIONS: 'true', RUNNER_OS: 'macOS', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: dirname(root),
      WORKWISE_CANDIDATE: '1', WORKWISE_CANDIDATE_ROOT: root, WORKWISE_CANDIDATE_OUTBOUND_DISABLED: '1',
      WORKWISE_CANDIDATE_INBOUND_DISABLED: '1', WORKWISE_CANDIDATE_CREDENTIAL_ACCESS: '0'
    }
    const config = join(root, 'openssl.cnf')
    writeFileSync(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\n')
    const result = spawnSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-x509', '-nodes', '-days', '1', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'), '-config', config], { encoding: 'utf8', timeout: 10_000 })
    if (result.status !== 0) throw new Error(result.stderr)
    data = readFileSync(join(root, 'cert.pem'), 'utf8')
    certificateSha256 = createHash('sha256').update(new X509Certificate(data).raw).digest('hex')
    input = { certificateSha256, sourceHead: head }
    policy = { certificateSha256, feedUrl }
  })
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }) })
  it('never obtains or mutates the updater session on an ordinary launch', () => {
    const session = vi.fn()
    configurePrivateUpdaterTls(session, 'https://updates.example.org/')
    expect(session).not.toHaveBeenCalled()
  })

  it('requires a full pin, hosted runner, isolated candidate executable and user data', () => {
    expect(validatePrivateUpdaterTls(input, feedUrl, join(root, 'user-data'), env, executable)).toEqual(policy)
    for (const patch of [{ GITHUB_ACTIONS: 'false' }, { WORKWISE_CANDIDATE: '0' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { WORKWISE_CANDIDATE_CREDENTIAL_ACCESS: '1' }]) {
      expect(() => validatePrivateUpdaterTls(input, feedUrl, join(root, 'user-data'), { ...env, ...patch }, executable)).toThrow()
    }
    expect(() => validatePrivateUpdaterTls(input, feedUrl, join(root, 'user-data'), env, process.execPath)).toThrow()
    expect(() => validatePrivateUpdaterTls(input, feedUrl, root, env, executable)).toThrow()
    expect(() => validatePrivateUpdaterTls({ ...input, certificateSha256: certificateSha256.slice(0, 12) }, feedUrl, join(root, 'user-data'), env, executable)).toThrow()
    expect(() => validatePrivateUpdaterTls({ ...input, sourceHead: 'b'.repeat(40) }, feedUrl, join(root, 'user-data'), env, executable)).toThrow()
    for (const url of [feedUrl.replace('127.0.0.1', 'localhost'), feedUrl.replace('https:', 'http:'), feedUrl.replace(':49999', ''), `${feedUrl}?foo=bar`]) {
      expect(() => validatePrivateUpdaterTls(input, url, join(root, 'user-data'), env, executable)).toThrow()
    }
  })

  it('accepts only the full pinned certificate for loopback within validity dates', () => {
    expect(privateUpdaterCertificateResult(policy, { hostname: '127.0.0.1', certificate: { data } })).toBe(0)
    expect(privateUpdaterCertificateResult({ ...policy, certificateSha256: 'f'.repeat(64) }, { hostname: '127.0.0.1', certificate: { data } })).toBe(-2)
    expect(privateUpdaterCertificateResult(policy, { hostname: 'example.org', certificate: { data } })).toBe(-2)
    expect(privateUpdaterCertificateResult(policy, { hostname: '127.0.0.1', certificate: { data: 'not a certificate' } })).toBe(-2)
    expect(privateUpdaterCertificateResult(policy, { hostname: '127.0.0.1', certificate: { data } }, 0)).toBe(-2)
    expect(privateUpdaterCertificateResult(policy, { hostname: '127.0.0.1', certificate: { data } }, Date.now() + 7 * 86400_000)).toBe(-2)
  })

  it('blocks wrong ports, outside paths, credentials, remote hosts and redirects', () => {
    expect(privateUpdaterRequestAllowed(policy, `${feedUrl}latest-mac.yml?noCache=1`)).toBe(true)
    for (const url of [feedUrl.replace('49999', '49998'), feedUrl.replace('https:', 'http:'), feedUrl.replace('127.0.0.1', 'example.org'), 'https://127.0.0.1:49999/latest-mac.yml', feedUrl.replace('https://', 'https://user@'), `${feedUrl}../escape`, 'invalid']) {
      expect(privateUpdaterRequestAllowed(policy, url)).toBe(false)
    }
  })
})
