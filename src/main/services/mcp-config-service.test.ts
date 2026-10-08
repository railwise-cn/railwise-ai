import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfigV2 } from '../../shared/agent-workbench'
import { McpConfigService } from './mcp-config-service'
import brand from '../../shared/product-brand.json'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => ''
  }
}))

let root = ''
let workspace = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'workwise-mcp-config-'))
  workspace = await mkdtemp(join(tmpdir(), 'workwise-mcp-workspace-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all([root, workspace].filter(Boolean).map((path) => rm(path, { recursive: true, force: true })))
})

function config(overrides: Partial<McpServerConfigV2> = {}): Omit<McpServerConfigV2, 'revision'> {
  return {
    id: 'docs',
    name: 'Docs',
    scope: 'workspace',
    workspaceRoot: workspace,
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    cwd: workspace,
    timeoutMs: 5_000,
    source: 'user',
    toolPolicy: { search: 'allow' },
    enabled: true,
    ...overrides
  }
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function assertLoopbackPortAvailable(port: number): Promise<void> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

describe('McpConfigService', () => {
  it('uses session storage for a candidate without touching protected storage', async () => {
    const previousCandidate = process.env.WORKWISE_CANDIDATE
    const previousAccess = process.env.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS
    process.env.WORKWISE_CANDIDATE = '1'
    delete process.env.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS
    try {
      const service = new McpConfigService({
        manifestPath: join(root, 'mcp-v2.json'),
        credentialRoot: join(root, 'credentials')
      })
      const saved = await service.save({
        config: config({ scope: 'global', transport: 'http', url: 'https://mcp.example.test' }),
        expectedRevision: 0,
        idempotencyKey: 'candidate-mcp-save'
      })
      const updated = await service.setCredential({
        serverId: saved.id,
        accessToken: 'candidate-token',
        expectedRevision: saved.revision,
        idempotencyKey: 'candidate-mcp-credential'
      })
      expect(updated.credentialRef?.storage).toBe('session')
    } finally {
      if (previousCandidate === undefined) delete process.env.WORKWISE_CANDIDATE
      else process.env.WORKWISE_CANDIDATE = previousCandidate
      if (previousAccess === undefined) delete process.env.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS
      else process.env.WORKWISE_CANDIDATE_CREDENTIAL_ACCESS = previousAccess
    }
  })

  it('exports credentials only as process environment values with placeholder config references', async () => {
    const key = 0x2a
    const service = new McpConfigService({
      manifestPath: join(root, 'mcp-v2.json'),
      credentialRoot: join(root, 'credentials'),
      encryption: {
        available: () => true,
        encrypt: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ key)),
        decrypt: (value) => Buffer.from([...value].map((byte) => byte ^ key)).toString('utf8'),
        storage: 'keychain'
      }
    })
    const saved = await service.save({
      config: config({ credentialEnvironmentVariables: ['DOCS_API_TOKEN'] }),
      expectedRevision: 0,
      idempotencyKey: 'save-runtime-export'
    })
    await service.setCredential({
      serverId: saved.id,
      workspaceRoot: workspace,
      accessToken: 'runtime-only-secret',
      expectedRevision: saved.revision,
      idempotencyKey: 'credential-runtime-export'
    })

    const snapshot = await service.runtimeSnapshot()
    const serialized = JSON.stringify(snapshot.servers)
    expect(serialized).not.toContain('runtime-only-secret')
    expect(snapshot.servers.docs).toMatchObject({
      transport: 'stdio',
      env: { DOCS_API_TOKEN: expect.stringMatching(/^\$\{WORKWISE_MCP_SECRET_[A-F0-9]+\}$/) }
    })
    expect(Object.values(snapshot.environment)).toContain('runtime-only-secret')
  })

  it('persists scoped V2 config with revision and idempotency', async () => {
    const service = new McpConfigService({
      manifestPath: join(root, 'mcp-v2.json'),
      credentialRoot: join(root, 'credentials'),
      encryption: {
        available: () => false,
        encrypt: () => Buffer.alloc(0),
        decrypt: () => '',
        storage: 'session'
      }
    })
    const request = { config: config(), expectedRevision: 0, idempotencyKey: 'save-docs' }
    const first = await service.save(request)
    const second = await service.save(request)
    expect(first.revision).toBe(1)
    expect(second).toEqual(first)
    expect(await service.list(workspace)).toEqual([first])
  })

  it('serializes concurrent MCP manifest mutations without losing independent servers', async () => {
    const service = new McpConfigService({ manifestPath: join(root, 'mcp-v2.json') })
    await Promise.all([
      service.save({
        config: config({ id: 'first', name: 'First', scope: 'global', workspaceRoot: undefined, cwd: undefined }),
        expectedRevision: 0,
        idempotencyKey: 'save-first'
      }),
      service.save({
        config: config({ id: 'second', name: 'Second', scope: 'global', workspaceRoot: undefined, cwd: undefined }),
        expectedRevision: 0,
        idempotencyKey: 'save-second'
      })
    ])

    expect((await service.list()).map((server) => server.id).sort()).toEqual(['first', 'second'])
  })

  it('uses Authorization Code + PKCE and stores tokens only in encrypted form', async () => {
    const key = 0x5a
    const service = new McpConfigService({
      manifestPath: join(root, 'mcp-v2.json'),
      credentialRoot: join(root, 'credentials'),
      encryption: {
        available: () => true,
        encrypt: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ key)),
        decrypt: (value) => Buffer.from([...value].map((byte) => byte ^ key)).toString('utf8'),
        storage: 'keychain'
      }
    })
    await service.save({
      config: config({
        transport: 'http',
        command: undefined,
        args: undefined,
        cwd: undefined,
        url: 'https://mcp.example.com/api',
        oauth: {
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          clientId: 'workwise-client',
          redirectUri: 'http://127.0.0.1:43119/callback',
          scopes: ['mcp.tools']
        }
      }),
      expectedRevision: 0,
      idempotencyKey: 'save-oauth'
    })
    const started = await service.authorize({ serverId: 'docs', workspaceRoot: workspace })
    const url = new URL(started.authorizationUrl!)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(started.authorizationState).toBeTruthy()

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'super-secret-token',
      refresh_token: 'refresh-secret',
      token_type: 'Bearer',
      expires_in: 3600
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    const completed = await service.authorize({
      serverId: 'docs',
      workspaceRoot: workspace,
      state: started.authorizationState,
      authorizationCode: 'authorization-code'
    })
    expect(completed).toMatchObject({ state: 'connected', authorized: true })
    const saved = (await service.list(workspace))[0]!
    expect(saved.credentialRef?.storage).toBe('keychain')
    const credentialFile = await readFile(join(root, 'credentials', `${saved.credentialRef!.id}.json`), 'utf8')
    expect(credentialFile).not.toContain('super-secret-token')
    expect(credentialFile).not.toContain('refresh-secret')
  })

  it('captures a validated loopback callback and completes OAuth without exposing the code to the renderer', async () => {
    const port = await freeLoopbackPort()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      const body = new URLSearchParams(String(init?.body))
      expect(body.get('code')).toBe('loopback-code')
      expect(body.get('code_verifier')).toBeTruthy()
      return new Response(JSON.stringify({ access_token: 'loopback-secret', token_type: 'Bearer' }), {
        status: 200
      })
    })
    const service = new McpConfigService({
      manifestPath: join(root, 'mcp-v2.json'),
      credentialRoot: join(root, 'credentials'),
      fetch: fetchMock as typeof fetch,
      oauthCallbackTimeoutMs: 5_000
    })
    await service.save({
      config: config({
        transport: 'http',
        command: undefined,
        args: undefined,
        cwd: undefined,
        url: 'https://mcp.example.com/api',
        oauth: {
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          clientId: 'workwise-client',
          redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
          scopes: ['mcp.tools']
        }
      }),
      expectedRevision: 0,
      idempotencyKey: 'save-loopback-oauth'
    })

    const started = await service.authorize({
      serverId: 'docs',
      workspaceRoot: workspace,
      useLocalCallback: true
    })
    expect(started.authorizationCallback).toBe('loopback')
    const wait = service.waitForAuthorization({
      serverId: 'docs',
      state: started.authorizationState!
    })
    const callback = new URL(`http://127.0.0.1:${port}/oauth/callback`)
    callback.searchParams.set('code', 'loopback-code')
    callback.searchParams.set('state', started.authorizationState!)
    const callbackResponse = await fetch(callback)
    expect(callbackResponse.status).toBe(200)
    const callbackPage = await callbackResponse.text()
    expect(callbackPage).not.toContain('loopback-code')
    expect(callbackPage).toContain(`<title>${brand.platform}</title>`)
    expect(callbackPage).toContain(`<h1>${brand.platform}</h1>`)
    expect(callbackPage).not.toContain('WorkWise')
    await expect(wait).resolves.toMatchObject({ state: 'connected', authorized: true })
    expect(JSON.stringify(await service.list(workspace))).not.toContain('loopback-secret')
  })

  it('rejects mismatched callback state and supports explicit cancellation', async () => {
    const port = await freeLoopbackPort()
    const service = new McpConfigService({
      manifestPath: join(root, 'mcp-v2.json'),
      credentialRoot: join(root, 'credentials'),
      oauthCallbackTimeoutMs: 5_000
    })
    await service.save({
      config: config({
        transport: 'http',
        command: undefined,
        args: undefined,
        cwd: undefined,
        url: 'https://mcp.example.com/api',
        oauth: {
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          clientId: 'workwise-client',
          redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
          scopes: []
        }
      }),
      expectedRevision: 0,
      idempotencyKey: 'save-cancel-oauth'
    })
    const started = await service.authorize({ serverId: 'docs', workspaceRoot: workspace, useLocalCallback: true })
    const invalid = await fetch(`http://127.0.0.1:${port}/oauth/callback?code=secret&state=wrong`)
    expect(invalid.status).toBe(400)
    const wait = service.waitForAuthorization({ serverId: 'docs', state: started.authorizationState! })
    expect(service.cancelAuthorization({ serverId: 'docs', state: started.authorizationState! })).toBe(true)
    await expect(wait).resolves.toMatchObject({ state: 'error', message: expect.stringMatching(/cancelled/i) })
  })

  it('releases the loopback listener after an authorization timeout', async () => {
    const port = await freeLoopbackPort()
    const service = new McpConfigService({
      manifestPath: join(root, 'mcp-v2.json'),
      credentialRoot: join(root, 'credentials'),
      oauthCallbackTimeoutMs: 20
    })
    await service.save({
      config: config({
        transport: 'http',
        command: undefined,
        args: undefined,
        cwd: undefined,
        url: 'https://mcp.example.com/api',
        oauth: {
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          clientId: 'workwise-client',
          redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
          scopes: []
        }
      }),
      expectedRevision: 0,
      idempotencyKey: 'save-timeout-oauth'
    })

    const started = await service.authorize({ serverId: 'docs', workspaceRoot: workspace, useLocalCallback: true })
    await expect(service.waitForAuthorization({
      serverId: 'docs',
      state: started.authorizationState!
    })).resolves.toMatchObject({ state: 'error', message: expect.stringMatching(/timed out/i) })
    await assertLoopbackPortAvailable(port)
  })

  it('settles waiting OAuth callers and releases listeners when disposed', async () => {
    const port = await freeLoopbackPort()
    const service = new McpConfigService({
      manifestPath: join(root, 'mcp-v2.json'),
      credentialRoot: join(root, 'credentials'),
      oauthCallbackTimeoutMs: 5_000
    })
    await service.save({
      config: config({
        transport: 'http',
        command: undefined,
        args: undefined,
        cwd: undefined,
        url: 'https://mcp.example.com/api',
        oauth: {
          authorizationUrl: 'https://auth.example.com/authorize',
          tokenUrl: 'https://auth.example.com/token',
          clientId: 'workwise-client',
          redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
          scopes: []
        }
      }),
      expectedRevision: 0,
      idempotencyKey: 'save-dispose-oauth'
    })

    const started = await service.authorize({ serverId: 'docs', workspaceRoot: workspace, useLocalCallback: true })
    const waiting = service.waitForAuthorization({ serverId: 'docs', state: started.authorizationState! })
    service.dispose()
    await expect(waiting).resolves.toMatchObject({
      state: 'error',
      message: expect.stringContaining(`${brand.platform} is closing`)
    })
    await assertLoopbackPortAvailable(port)
  })

  it('discovers protected resource metadata and dynamically registers a public PKCE client', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
        return new Response(JSON.stringify({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com/tenant']
        }), { status: 200 })
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server/tenant') {
        return new Response(JSON.stringify({
          issuer: 'https://auth.example.com/tenant',
          authorization_endpoint: 'https://auth.example.com/tenant/authorize',
          token_endpoint: 'https://auth.example.com/tenant/token',
          registration_endpoint: 'https://auth.example.com/tenant/register',
          scopes_supported: ['mcp.tools', 'mcp.resources'],
          code_challenge_methods_supported: ['S256']
        }), { status: 200 })
      }
      if (url === 'https://auth.example.com/tenant/register') {
        expect(init?.method).toBe('POST')
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect(request).toMatchObject({
          client_name: brand.platform,
          token_endpoint_auth_method: 'none',
          redirect_uris: ['http://127.0.0.1:43119/callback']
        })
        expect(JSON.stringify(request)).not.toMatch(/secret/i)
        return new Response(JSON.stringify({
          client_id: 'dynamic-workwise-client',
          token_endpoint_auth_method: 'none'
        }), { status: 201 })
      }
      throw new Error('Unexpected OAuth request: ' + url)
    })
    const service = new McpConfigService({
      manifestPath: join(root, 'mcp-v2.json'),
      credentialRoot: join(root, 'credentials'),
      fetch: fetchMock as typeof fetch
    })

    const saved = await service.save({
      config: config({
        transport: 'http',
        command: undefined,
        args: undefined,
        cwd: undefined,
        url: 'https://mcp.example.com/mcp',
        oauth: {
          resource: 'https://mcp.example.com/mcp',
          redirectUri: 'http://127.0.0.1:43119/callback',
          scopes: []
        }
      }),
      expectedRevision: 0,
      idempotencyKey: 'discover-oauth'
    })

    expect(saved.oauth).toMatchObject({
      authorizationUrl: 'https://auth.example.com/tenant/authorize',
      tokenUrl: 'https://auth.example.com/tenant/token',
      registrationUrl: 'https://auth.example.com/tenant/register',
      clientId: 'dynamic-workwise-client',
      scopes: ['mcp.tools', 'mcp.resources'],
      discovery: {
        protectedResourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
        authorizationServerMetadataUrl: 'https://auth.example.com/.well-known/oauth-authorization-server/tenant',
        codeChallengeMethodsSupported: ['S256'],
        clientRegistration: 'dynamic'
      }
    })
    const started = await service.authorize({ serverId: 'docs', workspaceRoot: workspace })
    const authorizationUrl = new URL(started.authorizationUrl!)
    expect(authorizationUrl.searchParams.get('resource')).toBe('https://mcp.example.com/mcp')
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('rejects OAuth discovery that does not advertise S256 PKCE', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('oauth-protected-resource')) {
        return new Response(JSON.stringify({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com']
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
        code_challenge_methods_supported: ['plain']
      }), { status: 200 })
    })
    const service = new McpConfigService({
      manifestPath: join(root, 'mcp-v2.json'),
      fetch: fetchMock as typeof fetch
    })

    await expect(service.save({
      config: config({
        transport: 'http',
        command: undefined,
        cwd: undefined,
        url: 'https://mcp.example.com/mcp',
        oauth: {
          resource: 'https://mcp.example.com/mcp',
          redirectUri: 'http://127.0.0.1:43119/callback',
          scopes: []
        }
      }),
      expectedRevision: 0,
      idempotencyKey: 'reject-plain-pkce'
    })).rejects.toThrow(/S256 PKCE/i)
  })

  it('rejects insecure non-loopback HTTP endpoints', async () => {
    const service = new McpConfigService({ manifestPath: join(root, 'mcp-v2.json') })
    await expect(service.save({
      config: config({ transport: 'http', command: undefined, url: 'http://example.com/mcp' }),
      expectedRevision: 0,
      idempotencyKey: 'unsafe-http'
    })).rejects.toMatchObject({ code: 'unsafe_url' })
  })

  it('stores manually supplied MCP tokens only in encrypted credential files', async () => {
    const key = 0x33
    const service = new McpConfigService({
      manifestPath: join(root, 'mcp-v2.json'),
      credentialRoot: join(root, 'credentials'),
      encryption: {
        available: () => true,
        encrypt: (value) => Buffer.from([...Buffer.from(value)].map((byte) => byte ^ key)),
        decrypt: (value) => Buffer.from([...value].map((byte) => byte ^ key)).toString('utf8'),
        storage: 'keychain'
      }
    })
    const server = await service.save({
      config: config({
        transport: 'http',
        command: undefined,
        args: undefined,
        cwd: undefined,
        url: 'https://api.githubcopilot.com/mcp/'
      }),
      expectedRevision: 0,
      idempotencyKey: 'save-token-server'
    })
    const request = {
      serverId: server.id,
      workspaceRoot: workspace,
      accessToken: 'github-super-secret-token',
      expectedRevision: server.revision,
      idempotencyKey: 'set-token'
    }

    const saved = await service.setCredential(request)
    const replayed = await service.setCredential(request)

    expect(replayed).toEqual(saved)
    expect(saved.credentialRef?.storage).toBe('keychain')
    const manifest = await readFile(join(root, 'mcp-v2.json'), 'utf8')
    expect(manifest).not.toContain('github-super-secret-token')
    const credentialFiles = await readdir(join(root, 'credentials'))
    expect(credentialFiles).toHaveLength(1)
    const credential = await readFile(join(root, 'credentials', credentialFiles[0]!), 'utf8')
    expect(credential).not.toContain('github-super-secret-token')
  })

  it('imports legacy servers without copying plaintext environment credentials', async () => {
    const legacyPath = join(root, 'mcp.json')
    await writeFile(legacyPath, JSON.stringify({
      mcpServers: {
        legacy: {
          command: 'node',
          args: ['legacy.js'],
          env: { API_TOKEN: 'must-not-migrate' }
        }
      }
    }))
    const manifestPath = join(root, 'mcp-v2.json')
    const service = new McpConfigService({ manifestPath, legacyPath })
    const migrated = await service.list()
    expect(migrated[0]).toMatchObject({ id: 'legacy', source: 'migration', transport: 'stdio' })
    expect(await readFile(manifestPath, 'utf8')).not.toContain('must-not-migrate')
  })

  it('repairs stale migrated WorkWise paths from the preserved legacy config', async () => {
    const legacyPath = join(root, 'mcp.json')
    const manifestPath = join(root, 'mcp-v2.json')
    const legacyCommand = '/Applications/WorkWise.app/Contents/Frameworks/WorkWise Helper.app/Contents/MacOS/WorkWise Helper'
    const legacyArgs = [
      '/Applications/WorkWise.app/Contents/Resources/app.asar/out/main/claw-schedule-mcp-node-entry.js',
      '--gui-schedule-mcp-server'
    ]
    await writeFile(legacyPath, JSON.stringify({
      servers: {
        gui_schedule: { command: legacyCommand, args: legacyArgs, env: { ELECTRON_RUN_AS_NODE: '1' } }
      }
    }))
    await writeFile(manifestPath, JSON.stringify({
      schema: 'workwise.mcp-servers',
      version: 2,
      revision: 1,
      servers: [{
        id: 'gui_schedule',
        name: 'gui_schedule',
        scope: 'global',
        transport: 'stdio',
        command: '/private/tmp/WorkWise-0.3.4-gui-hotfix/dist/mac-arm64/WorkWise.app/Contents/Frameworks/WorkWise Helper.app/Contents/MacOS/WorkWise Helper',
        args: ['/private/tmp/WorkWise-0.3.4-gui-hotfix/dist/mac-arm64/WorkWise.app/Contents/Resources/app.asar/out/main/claw-schedule-mcp-node-entry.js'],
        timeoutMs: 30_000,
        source: 'migration',
        toolPolicy: {},
        enabled: true,
        revision: 1
      }],
      mutationKeys: {}
    }))

    const service = new McpConfigService({ manifestPath, legacyPath })
    const repaired = await service.list()
    expect(repaired[0]).toMatchObject({
      id: 'gui_schedule',
      command: legacyCommand,
      args: legacyArgs
    })
    expect(await readFile(manifestPath, 'utf8')).toContain(legacyCommand)
    expect(await readFile(legacyPath, 'utf8')).toContain(legacyCommand)
  })
})
