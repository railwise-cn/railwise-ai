import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { McpConfigService } from './mcp-config-service'
import { GITHUB_MCP_READONLY_URL } from '../../shared/github-connector'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))
const execFileAsync = promisify(execFile)

it.skipIf(process.env.RAILWISE_GITHUB_MCP_LIVE !== '1')('checks official GitHub MCP authentication and tool discovery with an in-memory existing login', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-github-live-'))
  const evidenceRoot = process.env.RAILWISE_GITHUB_ACCEPTANCE_ROOT
  if (!evidenceRoot) throw new Error('Set a private RAILWISE_GITHUB_ACCEPTANCE_ROOT for observed results')
  const started = Date.now()
  try {
    const service = new McpConfigService({ manifestPath: join(root, 'mcp.json'), credentialRoot: join(root, 'credentials'), legacyPath: join(root, 'legacy.json'),
      // Exercise the existing session-only credential mode. Native protected
      // storage is untouched and the real token is never written to a file.
      encryption: { available: () => false, storage: 'session', encrypt: () => { throw new Error('Persistent credential storage is disabled for this check') }, decrypt: () => { throw new Error('Persistent credential storage is disabled for this check') } } })
    const saved = await service.save({ config: { id: 'github-live-readonly', name: 'GitHub isolated acceptance', transport: 'http', url: GITHUB_MCP_READONLY_URL,
      timeoutMs: 30_000, scope: 'global', source: 'user', toolPolicy: {}, enabled: false }, expectedRevision: 0, idempotencyKey: 'live-create' })
    let token = ''
    try {
      token = (await execFileAsync('gh', ['auth', 'token', '--hostname', 'github.com'], { timeout: 10_000, maxBuffer: 64 * 1024 })).stdout.trim()
    } catch { throw new Error('An existing GitHub CLI login could not be read for the authorized isolated check') }
    if (!token) throw new Error('The existing GitHub CLI login returned no credential')
    const credential = await service.setCredential({ serverId: saved.id, accessToken: token, expectedRevision: saved.revision, idempotencyKey: 'live-memory-credential' })
    token = ''
    expect(credential.credentialRef?.storage).toBe('session')
    const result = await service.test(saved.id)
    const source = await readFile(resolve('src/main/services/mcp-config-service.ts'))
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'])).stdout.trim()
    const evidence = { schemaVersion: 1, checkedAt: new Date().toISOString(), sourceHead: head,
      serviceSourceSha256: createHash('sha256').update(source).digest('hex'), endpoint: GITHUB_MCP_READONLY_URL,
      storage: 'session-only', operations: ['initialize', 'tools/list'], businessToolCalls: 0, enabledForTasks: false,
      status: result.state, authorized: result.authorized, toolCount: result.toolCount ?? 0, errorCode: result.errorCode ?? null,
      elapsedMs: Date.now() - started }
    await mkdir(evidenceRoot, { recursive: true })
    await writeFile(join(evidenceRoot, 'github-mcp-live-readonly.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
    expect(result.authorized, `Actual GitHub MCP check returned ${result.errorCode ?? result.state}`).toBe(true)
    expect(result.state).toBe('connected')
    expect(result.toolCount).toBeGreaterThan(0)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60_000)
