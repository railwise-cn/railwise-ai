import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { safeStorage } from 'electron'
import brand from '../../shared/product-brand.json'
import type {
  McpCredentialReferenceV1,
  McpServerConfigV2,
  McpServerStatusV1
} from '../../shared/agent-workbench'
import { atomicWriteFile, readRecoveredFile, runSerialized } from './durable-file'
import { canonicalizeContainmentRoot, resolveContainedPath } from './canonical-containment'
import { isCandidateCredentialAccessAllowed } from '../candidate-runtime'

const execFileAsync = promisify(execFile)
const MAX_OAUTH_RESPONSE_BYTES = 1024 * 1024
const OAUTH_REQUEST_TIMEOUT_MS = 15_000
const OAUTH_STATE_TTL_MS = 10 * 60_000
const OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000
const OAUTH_COMPLETION_RETENTION_MS = 60_000

type McpManifestV2 = {
  schema: 'workwise.mcp-servers'
  version: 2
  revision: number
  servers: McpServerConfigV2[]
  mutationKeys: Record<string, string>
}

type CredentialPayload = {
  accessToken: string
  refreshToken?: string
  expiresAt?: string
  tokenType?: string
}

type EncryptionAdapter = {
  available(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
  storage: McpCredentialReferenceV1['storage']
}

type PendingOAuth = {
  serverId: string
  state: string
  verifier: string
  createdAt: number
  callbackServer?: Server
  callbackTimer?: ReturnType<typeof setTimeout>
  cleanupTimer?: ReturnType<typeof setTimeout>
  completion?: Promise<McpServerStatusV1>
  resolveCompletion?: (status: McpServerStatusV1) => void
  completed?: McpServerStatusV1
  processing?: boolean
}

type McpOAuthConfig = NonNullable<McpServerConfigV2['oauth']>

type OAuthDiscoveryResult = {
  authorizationUrl: string
  tokenUrl: string
  registrationUrl?: string
  scopes: string[]
  discovery: NonNullable<McpOAuthConfig['discovery']>
}

export type SaveMcpServerRequest = {
  config: Omit<McpServerConfigV2, 'revision'> & { revision?: number }
  expectedRevision: number
  idempotencyKey: string
}

export type AuthorizeMcpServerRequest = {
  serverId: string
  workspaceRoot?: string
  state?: string
  authorizationCode?: string
  useLocalCallback?: boolean
}

export type McpAuthorizationStateRequest = {
  serverId: string
  state: string
}

export type SetMcpServerCredentialRequest = {
  serverId: string
  workspaceRoot?: string
  accessToken: string
  tokenType?: string
  expectedRevision: number
  idempotencyKey: string
}

export type McpRuntimeSnapshotV1 = {
  servers: Record<string, Record<string, unknown>>
  environment: Record<string, string>
}

function emptyManifest(): McpManifestV2 {
  return {
    schema: 'workwise.mcp-servers',
    version: 2,
    revision: 0,
    servers: [],
    mutationKeys: {}
  }
}

function base64Url(value: Buffer): string {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function runtimeCredentialVariable(serverId: string, key: string): string {
  const digest = createHash('sha256').update(`${serverId}\0${key}`).digest('hex').slice(0, 24)
  return `WORKWISE_MCP_SECRET_${digest.toUpperCase()}`
}

function defaultEncryption(): EncryptionAdapter {
  if (!isCandidateCredentialAccessAllowed()) {
    return {
      available: () => false,
      encrypt: () => { throw new Error('Candidate protected storage access is disabled.') },
      decrypt: () => { throw new Error('Candidate protected storage access is disabled.') },
      storage: 'keychain'
    }
  }
  return {
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (value) => safeStorage.decryptString(value),
    storage: process.platform === 'darwin' ? 'keychain' : process.platform === 'win32' ? 'dpapi' : 'safe-storage'
  }
}

function assertHttpUrl(value: string, label: string): URL {
  if (value.length > 4_096) throw Object.assign(new Error(`${label} is too long.`), { code: 'unsafe_url' })
  const parsed = new URL(value)
  if (parsed.username || parsed.password) throw Object.assign(new Error(`${label} must not contain URL credentials.`), { code: 'unsafe_url' })
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw Object.assign(new Error(`${label} must use HTTPS, except for loopback development servers.`), { code: 'unsafe_url' })
  }
  return parsed
}

function assertRedirectUri(value: string): URL {
  const parsed = new URL(value)
  if (parsed.protocol === 'workwise:') return parsed
  return assertHttpUrl(value, 'OAuth redirect URL')
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + ' must be a JSON object.')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is required.')
  return value.trim()
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 256 ||
      value.some((entry) => typeof entry !== 'string' || !entry.trim() || entry.length > 4_096)) {
    throw new Error(label + ' must contain strings.')
  }
  return [...new Set(value.map((entry) => String(entry).trim()))]
}

function isObsoleteWorkWisePath(value: string): boolean {
  return /(?:^|[\\/])(?:private[\\/]tmp[\\/]WorkWise-|tmp[\\/]workwise-|WorkWise-0\.\d+\.\d+)/i.test(value)
}

function legacyStdioLaunch(value: unknown): { command: string; args: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const command = typeof raw.command === 'string' ? raw.command.trim() : ''
  const args = Array.isArray(raw.args)
    ? raw.args.filter((item): item is string => typeof item === 'string').slice(0, 256)
    : []
  if (!command || typeof raw.url === 'string' && raw.url.trim()) return null
  if ([command, ...args].some(isObsoleteWorkWisePath)) return null
  return { command, args }
}

function sameOAuthIdentifier(left: string, right: string): boolean {
  return left.replace(/\/$/, '') === right.replace(/\/$/, '')
}

function wellKnownUrls(value: string, name: string): string[] {
  const parsed = assertHttpUrl(value, 'OAuth discovery resource')
  const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
  const withPath = new URL(parsed.origin)
  withPath.pathname = `/.well-known/${name}${path}`
  const root = new URL(parsed.origin)
  root.pathname = `/.well-known/${name}`
  return path ? [withPath.toString(), root.toString()] : [root.toString()]
}

function normalizedManifest(value: unknown): McpManifestV2 {
  if (!value || typeof value !== 'object') return emptyManifest()
  const raw = value as Partial<McpManifestV2>
  if (raw.schema !== 'workwise.mcp-servers' || raw.version !== 2 || !Array.isArray(raw.servers)) return emptyManifest()
  return {
    schema: 'workwise.mcp-servers',
    version: 2,
    revision: Number.isInteger(raw.revision) ? raw.revision! : 0,
    servers: raw.servers,
    mutationKeys: raw.mutationKeys && typeof raw.mutationKeys === 'object' ? raw.mutationKeys : {}
  }
}

export class McpConfigService {
  private readonly manifestPath: string
  private readonly legacyPath: string
  private readonly credentialRoot: string
  private readonly encryption: EncryptionAdapter
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private readonly oauthCallbackTimeoutMs: number
  private readonly oauthResponseTimers = new WeakMap<Response, ReturnType<typeof setTimeout>>()
  private readonly sessionCredentials = new Map<string, CredentialPayload>()
  private readonly pendingOAuth = new Map<string, PendingOAuth>()

  constructor(options: {
    manifestPath?: string
    legacyPath?: string
    credentialRoot?: string
    encryption?: EncryptionAdapter
    fetch?: typeof fetch
    now?: () => Date
    oauthCallbackTimeoutMs?: number
  } = {}) {
    this.manifestPath = resolve(options.manifestPath ?? join(homedir(), '.workwise', 'mcp-v2.json'))
    this.legacyPath = resolve(options.legacyPath ?? join(dirname(this.manifestPath), 'mcp.json'))
    this.credentialRoot = resolve(options.credentialRoot ?? join(homedir(), '.workwise', 'credentials', 'mcp'))
    this.encryption = options.encryption ?? defaultEncryption()
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.now = options.now ?? (() => new Date())
    this.oauthCallbackTimeoutMs = options.oauthCallbackTimeoutMs ?? OAUTH_CALLBACK_TIMEOUT_MS
  }

  async list(workspaceRoot?: string): Promise<McpServerConfigV2[]> {
    const manifest = await this.read()
    const canonicalWorkspace = workspaceRoot ? await canonicalizeContainmentRoot(workspaceRoot) : undefined
    return manifest.servers.filter((server) =>
      server.scope === 'global' || (canonicalWorkspace && server.workspaceRoot === canonicalWorkspace)
    )
  }

  async runtimeSnapshot(): Promise<McpRuntimeSnapshotV1> {
    const manifest = await this.read()
    const servers: Record<string, Record<string, unknown>> = {}
    const environment: Record<string, string> = {}
    for (const server of manifest.servers) {
      const credential = await this.readCredential(server.credentialRef)
      const trust = server.scope === 'workspace' && server.workspaceRoot
        ? { trustScope: 'workspace', trustedWorkspaceRoots: [server.workspaceRoot] }
        : { trustScope: 'user', trustedWorkspaceRoots: [] }
      if (server.transport === 'stdio') {
        const env: Record<string, string> = {}
        for (const key of server.credentialEnvironmentVariables ?? []) {
          const variable = runtimeCredentialVariable(server.id, key)
          env[key] = `\${${variable}}`
          if (credential) environment[variable] = credential.accessToken
        }
        servers[server.id] = {
          enabled: server.enabled,
          transport: 'stdio',
          command: server.command,
          args: server.args ?? [],
          env,
          ...trust,
          timeoutMs: server.timeoutMs
        }
        continue
      }
      const headers: Record<string, string> = {}
      if (credential) {
        const variable = runtimeCredentialVariable(server.id, 'authorization')
        headers.Authorization = `\${${variable}}`
        environment[variable] = `${credential.tokenType ?? 'Bearer'} ${credential.accessToken}`
      }
      servers[server.id] = {
        enabled: server.enabled,
        transport: 'streamable-http',
        url: server.url,
        headers,
        ...trust,
        timeoutMs: server.timeoutMs
      }
    }
    return { servers, environment }
  }

  async save(request: SaveMcpServerRequest): Promise<McpServerConfigV2> {
    return runSerialized('mcp-config:' + this.manifestPath, async () => {
      const manifest = await this.read()
      const previousId = manifest.mutationKeys[request.idempotencyKey]
      if (previousId) {
        const previous = manifest.servers.find((server) => server.id === previousId)
        if (previous) return previous
      }
      const index = manifest.servers.findIndex((server) => server.id === request.config.id)
      const current = index >= 0 ? manifest.servers[index]! : null
      const revision = current?.revision ?? 0
      if (revision !== request.expectedRevision) {
        throw Object.assign(new Error('MCP server revision conflict.'), { code: 'stale_request' })
      }
      const workspaceRoot = request.config.scope === 'workspace'
        ? await canonicalizeContainmentRoot(request.config.workspaceRoot ?? '')
        : undefined
      let canonicalCwd: string | undefined
      if (request.config.transport === 'stdio') {
        if (!request.config.command?.trim()) throw Object.assign(new Error('stdio MCP server requires a command.'), { code: 'invalid_state' })
        if (request.config.cwd) {
          if (!workspaceRoot) throw Object.assign(new Error('stdio cwd requires workspace scope.'), { code: 'unsafe_path' })
          canonicalCwd = await canonicalizeContainmentRoot(request.config.cwd)
          await resolveContainedPath({
            root: workspaceRoot,
            target: canonicalCwd,
            allowRoot: true,
            mustExist: true,
            expect: 'directory'
          })
        }
      } else {
        if (!request.config.url) throw Object.assign(new Error('HTTP MCP server requires a URL.'), { code: 'invalid_state' })
        assertHttpUrl(request.config.url, 'MCP server URL')
      }
      const oauth = request.config.oauth ? await this.resolveOAuth(request.config.oauth) : undefined
      const next: McpServerConfigV2 = {
        ...request.config,
        ...(oauth ? { oauth } : {}),
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(canonicalCwd ? { cwd: canonicalCwd } : {}),
        timeoutMs: Math.min(Math.max(request.config.timeoutMs, 1_000), 120_000),
        revision: revision + 1
      }
      const servers = [...manifest.servers]
      if (index >= 0) servers[index] = next
      else servers.push(next)
      const mutationKeys = { ...manifest.mutationKeys, [request.idempotencyKey]: next.id }
      const trimmedKeys = Object.fromEntries(Object.entries(mutationKeys).slice(-256))
      await this.write({ ...manifest, revision: manifest.revision + 1, servers, mutationKeys: trimmedKeys })
      return next
    })
  }

  async test(serverId: string, workspaceRoot?: string): Promise<McpServerStatusV1> {
    const server = (await this.list(workspaceRoot)).find((entry) => entry.id === serverId)
    if (!server) return { id: serverId, state: 'error', authorized: false, message: 'MCP server was not found.' }
    const startedAt = Date.now()
    try {
      if (server.transport === 'stdio') {
        if (server.cwd && server.workspaceRoot) {
          const cwd = await canonicalizeContainmentRoot(server.cwd)
          await resolveContainedPath({ root: server.workspaceRoot, target: cwd, allowRoot: true, mustExist: true, expect: 'directory' })
        }
        const lookup = process.platform === 'win32' ? ['where', [server.command!]] as const : ['which', [server.command!]] as const
        await execFileAsync(lookup[0], lookup[1], { timeout: Math.min(server.timeoutMs, 10_000), windowsHide: true })
        return { id: server.id, state: 'connected', authorized: true, latencyMs: Date.now() - startedAt }
      }
      const credential = await this.readCredential(server.credentialRef)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), server.timeoutMs)
      const response = await fetch(server.url!, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: credential ? { Authorization: `${credential.tokenType ?? 'Bearer'} ${credential.accessToken}` } : undefined
      }).finally(() => clearTimeout(timer))
      if (response.status === 401 || response.status === 403) {
        return { id: server.id, state: 'needs_authorization', authorized: false, latencyMs: Date.now() - startedAt, message: 'Authorization is required.' }
      }
      return { id: server.id, state: 'connected', authorized: Boolean(credential || !server.oauth), latencyMs: Date.now() - startedAt }
    } catch (error) {
      return {
        id: server.id,
        state: server.oauth && !(await this.readCredential(server.credentialRef)) ? 'needs_authorization' : 'error',
        authorized: false,
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async authorize(request: AuthorizeMcpServerRequest): Promise<McpServerStatusV1> {
    const server = (await this.list(request.workspaceRoot)).find((entry) => entry.id === request.serverId)
    if (!server) return { id: request.serverId, state: 'error', authorized: false, message: 'MCP server was not found.' }
    if (!server.oauth) return { id: server.id, state: 'connected', authorized: true, message: 'This server does not require OAuth.' }
    if (!request.authorizationCode) {
      const verifier = base64Url(randomBytes(48))
      const challenge = base64Url(createHash('sha256').update(verifier).digest())
      const state = base64Url(randomBytes(24))
      if (!server.oauth.authorizationUrl || !server.oauth.clientId) {
        return { id: server.id, state: 'error', authorized: false, message: 'OAuth discovery is incomplete.' }
      }
      this.cancelPendingForServer(server.id)
      const pending: PendingOAuth = {
        serverId: server.id,
        state,
        verifier,
        createdAt: this.now().getTime()
      }
      this.pendingOAuth.set(state, pending)
      let callback: McpServerStatusV1['authorizationCallback'] = 'manual'
      if (request.useLocalCallback) {
        try {
          await this.startOAuthCallback(server, pending)
          callback = 'loopback'
        } catch (error) {
          this.pendingOAuth.delete(state)
          throw error
        }
      }
      const authorizationUrl = new URL(server.oauth.authorizationUrl)
      authorizationUrl.searchParams.set('response_type', 'code')
      authorizationUrl.searchParams.set('client_id', server.oauth.clientId)
      authorizationUrl.searchParams.set('redirect_uri', server.oauth.redirectUri)
      authorizationUrl.searchParams.set('code_challenge', challenge)
      authorizationUrl.searchParams.set('code_challenge_method', 'S256')
      authorizationUrl.searchParams.set('state', state)
      if (server.oauth.scopes.length > 0) authorizationUrl.searchParams.set('scope', server.oauth.scopes.join(' '))
      if (server.oauth.resource) authorizationUrl.searchParams.set('resource', server.oauth.resource)
      return {
        id: server.id,
        state: 'needs_authorization',
        authorized: false,
        authorizationUrl: authorizationUrl.toString(),
        authorizationState: state,
        authorizationCallback: callback,
        authorizationExpiresAt: new Date(
          pending.createdAt + (callback === 'loopback' ? this.oauthCallbackTimeoutMs : OAUTH_STATE_TTL_MS)
        ).toISOString(),
        message: callback === 'loopback'
          ? `Complete authorization in the browser. ${brand.platform} is waiting for the local callback.`
          : 'Open the authorization URL and return the authorization code.'
      }
    }
    const pending = request.state ? this.pendingOAuth.get(request.state) : undefined
    if (!pending || pending.completed || pending.serverId !== server.id ||
        this.now().getTime() - pending.createdAt > OAUTH_STATE_TTL_MS) {
      return { id: server.id, state: 'error', authorized: false, message: 'OAuth state is missing or expired.' }
    }
    const result = await this.completeAuthorization(server, pending, request.authorizationCode)
    this.disposePendingOAuth(pending)
    return result
  }

  async waitForAuthorization(request: McpAuthorizationStateRequest): Promise<McpServerStatusV1> {
    const pending = this.pendingOAuth.get(request.state)
    if (!pending || pending.serverId !== request.serverId) {
      return { id: request.serverId, state: 'error', authorized: false, message: 'OAuth state is missing or expired.' }
    }
    if (!pending.completion) {
      return { id: request.serverId, state: 'error', authorized: false, message: 'OAuth flow is waiting for a manual authorization code.' }
    }
    const result = await pending.completion
    this.disposePendingOAuth(pending)
    return result
  }

  cancelAuthorization(request: McpAuthorizationStateRequest): boolean {
    const pending = this.pendingOAuth.get(request.state)
    if (!pending || pending.serverId !== request.serverId) return false
    this.settleOAuthCallback(pending, {
      id: request.serverId,
      state: 'error',
      authorized: false,
      message: 'OAuth authorization was cancelled.'
    })
    return true
  }

  dispose(): void {
    for (const pending of this.pendingOAuth.values()) {
      if (pending.callbackTimer) clearTimeout(pending.callbackTimer)
      if (pending.cleanupTimer) clearTimeout(pending.cleanupTimer)
      pending.callbackServer?.close()
      pending.resolveCompletion?.({
        id: pending.serverId,
        state: 'error',
        authorized: false,
        message: `OAuth authorization stopped because ${brand.platform} is closing.`
      })
    }
    this.pendingOAuth.clear()
  }

  private async completeAuthorization(
    server: McpServerConfigV2,
    pending: PendingOAuth,
    authorizationCode: string
  ): Promise<McpServerStatusV1> {
    const oauth = server.oauth
    if (!oauth?.tokenUrl || !oauth.clientId) {
      return { id: server.id, state: 'error', authorized: false, message: 'OAuth discovery is incomplete.' }
    }
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: authorizationCode,
      client_id: oauth.clientId,
      redirect_uri: oauth.redirectUri,
      code_verifier: pending.verifier
    })
    if (oauth.resource) body.set('resource', oauth.resource)
    const response = await this.fetchOAuth(oauth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept-Encoding': 'identity' },
      body
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      this.releaseOAuthResponse(response)
      return { id: server.id, state: 'error', authorized: false, message: `OAuth token exchange failed (${response.status}).` }
    }
    const value = await this.readOAuthJson(response, 'OAuth token response')
    if (typeof value.access_token !== 'string' || value.access_token.length > 64 * 1024) {
      return { id: server.id, state: 'error', authorized: false, message: 'OAuth response did not contain a valid access token.' }
    }
    if (typeof value.refresh_token === 'string' && value.refresh_token.length > 64 * 1024) {
      return { id: server.id, state: 'error', authorized: false, message: 'OAuth refresh token exceeds its safety limit.' }
    }
    const credential: CredentialPayload = {
      accessToken: value.access_token,
      ...(typeof value.refresh_token === 'string' ? { refreshToken: value.refresh_token } : {}),
      ...(typeof value.token_type === 'string' ? { tokenType: value.token_type } : {}),
      ...(typeof value.expires_in === 'number'
        ? { expiresAt: new Date(this.now().getTime() + value.expires_in * 1000).toISOString() }
        : {})
    }
    const credentialRef = await this.writeCredential(server.id, credential)
    let saved: McpServerConfigV2
    try {
      saved = await this.save({
        config: { ...server, credentialRef },
        expectedRevision: server.revision,
        idempotencyKey: `oauth:${server.id}:${pending.state}`
      })
    } catch (error) {
      await this.removeCredential(credentialRef)
      throw error
    }
    if (saved.credentialRef?.id !== credentialRef.id) {
      await this.removeCredential(credentialRef)
    } else if (server.credentialRef && server.credentialRef.id !== credentialRef.id) {
      await this.removeCredential(server.credentialRef)
    }
    return { id: server.id, state: 'connected', authorized: true, message: 'Authorization completed.' }
  }

  private async startOAuthCallback(server: McpServerConfigV2, pending: PendingOAuth): Promise<void> {
    const redirect = assertRedirectUri(server.oauth!.redirectUri)
    const hostname = redirect.hostname.replace(/^\[|\]$/g, '')
    if (redirect.protocol !== 'http:' || !new Set(['127.0.0.1', '::1']).has(hostname) || !redirect.port) {
      throw new Error('Automatic OAuth callback requires an explicit 127.0.0.1 or ::1 HTTP port.')
    }
    const port = Number.parseInt(redirect.port, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('OAuth callback port is invalid.')
    }

    pending.completion = new Promise((resolve) => {
      pending.resolveCompletion = resolve
    })
    const callbackServer = createServer((request, response) => {
      if (request.method !== 'GET' || !request.url || request.url.length > 8_192) {
        this.writeOAuthCallbackResponse(response, false)
        return
      }
      let callbackUrl: URL
      try {
        callbackUrl = new URL(request.url, redirect.origin)
      } catch {
        this.writeOAuthCallbackResponse(response, false)
        return
      }
      if (callbackUrl.pathname !== redirect.pathname || callbackUrl.searchParams.get('state') !== pending.state) {
        this.writeOAuthCallbackResponse(response, false)
        return
      }
      if (pending.processing || pending.completed) {
        this.writeOAuthCallbackResponse(response, Boolean(pending.completed?.authorized))
        return
      }
      const code = callbackUrl.searchParams.get('code')?.trim()
      const denied = callbackUrl.searchParams.has('error')
      if (!code || code.length > 8_192 || denied) {
        const status = {
          id: server.id,
          state: 'error' as const,
          authorized: false,
          message: denied
            ? 'OAuth authorization was denied by the provider.'
            : 'OAuth callback did not contain a valid authorization code.'
        }
        this.writeOAuthCallbackResponse(response, false)
        this.settleOAuthCallback(pending, status)
        return
      }
      pending.processing = true
      void this.completeAuthorization(server, pending, code)
        .then((status) => {
          this.writeOAuthCallbackResponse(response, status.authorized)
          this.settleOAuthCallback(pending, status)
        })
        .catch((error) => {
          this.writeOAuthCallbackResponse(response, false)
          this.settleOAuthCallback(pending, {
            id: server.id,
            state: 'error',
            authorized: false,
            message: error instanceof Error ? error.message : String(error)
          })
        })
    })
    pending.callbackServer = callbackServer
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => rejectListen(error)
      callbackServer.once('error', onError)
      callbackServer.listen(port, hostname, () => {
        callbackServer.removeListener('error', onError)
        resolveListen()
      })
    }).catch((error) => {
      callbackServer.close()
      pending.callbackServer = undefined
      throw new Error(
        `Unable to start the local OAuth callback on ${hostname}:${port}: ${error instanceof Error ? error.message : String(error)}`
      )
    })
    pending.callbackTimer = setTimeout(() => {
      this.settleOAuthCallback(pending, {
        id: server.id,
        state: 'error',
        authorized: false,
        message: 'OAuth authorization timed out.'
      })
    }, this.oauthCallbackTimeoutMs)
    pending.callbackTimer.unref?.()
  }

  private writeOAuthCallbackResponse(response: import('node:http').ServerResponse, ok: boolean): void {
    response.statusCode = ok ? 200 : 400
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${brand.platform}</title><style>body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#f5f7fa;color:#20242b}.message{max-width:360px;padding:28px;text-align:center}</style></head><body><main class="message"><h1>${brand.platform}</h1><p>${ok ? `Authorization completed. You can return to ${brand.platform}.` : `Authorization could not be completed. Return to ${brand.platform} for details.`}</p></main></body></html>`)
  }

  private settleOAuthCallback(pending: PendingOAuth, status: McpServerStatusV1): void {
    if (pending.completed) return
    pending.completed = status
    if (pending.callbackTimer) clearTimeout(pending.callbackTimer)
    pending.callbackTimer = undefined
    pending.callbackServer?.close()
    pending.callbackServer = undefined
    pending.resolveCompletion?.(status)
    pending.cleanupTimer = setTimeout(() => this.disposePendingOAuth(pending), OAUTH_COMPLETION_RETENTION_MS)
    pending.cleanupTimer.unref?.()
  }

  private cancelPendingForServer(serverId: string): void {
    for (const pending of this.pendingOAuth.values()) {
      if (pending.serverId !== serverId) continue
      this.settleOAuthCallback(pending, {
        id: serverId,
        state: 'error',
        authorized: false,
        message: 'OAuth authorization was replaced by a new request.'
      })
    }
  }

  private disposePendingOAuth(pending: PendingOAuth): void {
    if (pending.callbackTimer) clearTimeout(pending.callbackTimer)
    if (pending.cleanupTimer) clearTimeout(pending.cleanupTimer)
    pending.callbackServer?.close()
    if (this.pendingOAuth.get(pending.state) === pending) this.pendingOAuth.delete(pending.state)
  }

  async setCredential(request: SetMcpServerCredentialRequest): Promise<McpServerConfigV2> {
    const manifest = await this.read()
    const replayId = manifest.mutationKeys[request.idempotencyKey]
    if (replayId) {
      if (replayId !== request.serverId) {
        throw new Error('MCP credential idempotency key was used for another server.')
      }
      const replay = manifest.servers.find((entry) => entry.id === replayId)
      if (replay) return replay
    }
    const server = (await this.list(request.workspaceRoot)).find((entry) => entry.id === request.serverId)
    if (!server) throw new Error('MCP server was not found.')
    if (server.revision !== request.expectedRevision) {
      throw Object.assign(new Error('MCP server revision conflict.'), { code: 'stale_request' })
    }
    const accessToken = request.accessToken.trim()
    if (!accessToken || accessToken.includes('\0') || accessToken.length > 64 * 1024) {
      throw new Error('MCP credential token is invalid or exceeds 64 KiB.')
    }
    const tokenType = request.tokenType?.trim() || 'Bearer'
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(tokenType)) {
      throw new Error('MCP credential token type is invalid.')
    }
    const credentialRef = await this.writeCredential(server.id, { accessToken, tokenType })
    let saved: McpServerConfigV2
    try {
      saved = await this.save({
        config: { ...server, credentialRef },
        expectedRevision: request.expectedRevision,
        idempotencyKey: request.idempotencyKey
      })
    } catch (error) {
      await this.removeCredential(credentialRef)
      throw error
    }
    if (saved.credentialRef?.id !== credentialRef.id) {
      await this.removeCredential(credentialRef)
    } else if (server.credentialRef && server.credentialRef.id !== credentialRef.id) {
      await this.removeCredential(server.credentialRef)
    }
    return saved
  }

  private async resolveOAuth(input: McpOAuthConfig): Promise<McpOAuthConfig> {
    const redirectUri = assertRedirectUri(requiredString(input.redirectUri, 'OAuth redirect URL')).toString()
    const resource = input.resource
      ? assertHttpUrl(input.resource, 'OAuth protected resource').toString()
      : undefined
    let authorizationUrl = input.authorizationUrl
      ? assertHttpUrl(input.authorizationUrl, 'OAuth authorization URL').toString()
      : undefined
    let tokenUrl = input.tokenUrl
      ? assertHttpUrl(input.tokenUrl, 'OAuth token URL').toString()
      : undefined
    let registrationUrl = input.registrationUrl
      ? assertHttpUrl(input.registrationUrl, 'OAuth registration URL').toString()
      : undefined
    let scopes = [...new Set(input.scopes)]
    let discovery = input.discovery

    if (resource && (!authorizationUrl || !tokenUrl || !input.clientId)) {
      const discovered = await this.discoverOAuth(resource)
      authorizationUrl ??= discovered.authorizationUrl
      tokenUrl ??= discovered.tokenUrl
      registrationUrl ??= discovered.registrationUrl
      if (scopes.length === 0) scopes = discovered.scopes
      discovery = discovered.discovery
    }
    if (!authorizationUrl || !tokenUrl) {
      throw new Error('OAuth authorization and token endpoints are required or must be discoverable.')
    }
    if (discovery?.codeChallengeMethodsSupported.length &&
        !discovery.codeChallengeMethodsSupported.includes('S256')) {
      throw new Error('OAuth authorization server does not support S256 PKCE.')
    }

    let clientId = input.clientId?.trim()
    let clientRegistration: 'static' | 'dynamic' = clientId ? 'static' : 'dynamic'
    if (!clientId) {
      if (!registrationUrl) throw new Error('OAuth client ID is missing and dynamic registration is unavailable.')
      clientId = await this.registerOAuthClient(registrationUrl, redirectUri)
    }
    if (discovery) clientRegistration = discovery.clientRegistration === 'static' && input.clientId
      ? 'static'
      : clientRegistration
    return {
      ...(resource ? { resource } : {}),
      authorizationUrl,
      tokenUrl,
      ...(registrationUrl ? { registrationUrl } : {}),
      clientId,
      redirectUri,
      scopes,
      ...(discovery ? {
        discovery: { ...discovery, clientRegistration }
      } : {})
    }
  }

  private async discoverOAuth(resource: string): Promise<OAuthDiscoveryResult> {
    const protectedResult = await this.firstOAuthMetadata(
      wellKnownUrls(resource, 'oauth-protected-resource'),
      'OAuth protected resource metadata'
    )
    const protectedMetadata = protectedResult.value
    if (protectedMetadata.resource !== undefined &&
        !sameOAuthIdentifier(requiredString(protectedMetadata.resource, 'OAuth metadata resource'), resource)) {
      throw new Error('OAuth protected resource metadata does not match the requested resource.')
    }
    const authorizationServers = stringArray(
      protectedMetadata.authorization_servers,
      'OAuth authorization_servers'
    )
    if (authorizationServers.length === 0) {
      throw new Error('OAuth protected resource metadata has no authorization server.')
    }
    const authorizationServer = assertHttpUrl(
      authorizationServers[0]!,
      'OAuth authorization server'
    ).toString()
    const authorizationResult = await this.firstOAuthMetadata(
      [
        ...wellKnownUrls(authorizationServer, 'oauth-authorization-server'),
        ...wellKnownUrls(authorizationServer, 'openid-configuration')
      ],
      'OAuth authorization server metadata'
    )
    const metadata = authorizationResult.value
    if (metadata.issuer !== undefined &&
        !sameOAuthIdentifier(requiredString(metadata.issuer, 'OAuth issuer'), authorizationServer)) {
      throw new Error('OAuth authorization server metadata issuer does not match discovery.')
    }
    const authorizationUrl = assertHttpUrl(
      requiredString(metadata.authorization_endpoint, 'OAuth authorization_endpoint'),
      'OAuth authorization endpoint'
    ).toString()
    const tokenUrl = assertHttpUrl(
      requiredString(metadata.token_endpoint, 'OAuth token_endpoint'),
      'OAuth token endpoint'
    ).toString()
    const registrationUrl = metadata.registration_endpoint === undefined
      ? undefined
      : assertHttpUrl(
        requiredString(metadata.registration_endpoint, 'OAuth registration_endpoint'),
        'OAuth registration endpoint'
      ).toString()
    const codeChallengeMethodsSupported = stringArray(
      metadata.code_challenge_methods_supported,
      'OAuth code_challenge_methods_supported'
    )
    if (codeChallengeMethodsSupported.length > 0 && !codeChallengeMethodsSupported.includes('S256')) {
      throw new Error('OAuth authorization server does not support S256 PKCE.')
    }
    return {
      authorizationUrl,
      tokenUrl,
      ...(registrationUrl ? { registrationUrl } : {}),
      scopes: stringArray(metadata.scopes_supported, 'OAuth scopes_supported'),
      discovery: {
        protectedResourceMetadataUrl: protectedResult.url,
        authorizationServer,
        authorizationServerMetadataUrl: authorizationResult.url,
        codeChallengeMethodsSupported,
        clientRegistration: 'dynamic'
      }
    }
  }

  private async registerOAuthClient(registrationUrl: string, redirectUri: string): Promise<string> {
    const response = await this.fetchOAuth(registrationUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: brand.platform,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none'
      })
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      this.releaseOAuthResponse(response)
      throw new Error(`OAuth dynamic client registration failed (${response.status}).`)
    }
    const value = await this.readOAuthJson(response, 'OAuth client registration response')
    const method = value.token_endpoint_auth_method
    if (method !== undefined && method !== 'none') {
      throw new Error('OAuth dynamic registration requires an unsupported client secret.')
    }
    const clientId = requiredString(value.client_id, 'OAuth dynamic client ID')
    if (clientId.length > 512) throw new Error('OAuth dynamic client ID is too long.')
    return clientId
  }

  private async firstOAuthMetadata(
    urls: string[],
    label: string
  ): Promise<{ url: string; value: Record<string, unknown> }> {
    let lastStatus = 0
    for (const url of [...new Set(urls)]) {
      const response = await this.fetchOAuth(url, { headers: { Accept: 'application/json' } })
      if (response.ok) return { url, value: await this.readOAuthJson(response, label) }
      lastStatus = response.status
      await response.body?.cancel().catch(() => undefined)
      this.releaseOAuthResponse(response)
      if (response.status !== 404 && response.status !== 400) {
        throw new Error(`${label} request failed (${response.status}).`)
      }
    }
    throw new Error(`${label} was not found (${lastStatus}).`)
  }

  private async fetchOAuth(url: string, init: RequestInit): Promise<Response> {
    assertHttpUrl(url, 'OAuth request URL')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), OAUTH_REQUEST_TIMEOUT_MS)
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: 'manual',
        signal: controller.signal
      })
      this.oauthResponseTimers.set(response, timer)
      return response
    } catch (error) {
      clearTimeout(timer)
      throw error
    }
  }

  private releaseOAuthResponse(response: Response): void {
    const timer = this.oauthResponseTimers.get(response)
    if (timer) clearTimeout(timer)
    this.oauthResponseTimers.delete(response)
  }

  private async readOAuthJson(response: Response, label: string): Promise<Record<string, unknown>> {
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_OAUTH_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      this.releaseOAuthResponse(response)
      throw new Error(label + ' exceeds 1 MiB.')
    }
    if (!response.body) {
      this.releaseOAuthResponse(response)
      throw new Error(label + ' is empty.')
    }
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) break
        const chunk = Buffer.from(result.value)
        total += chunk.byteLength
        if (total > MAX_OAUTH_RESPONSE_BYTES) {
          await reader.cancel(label + ' exceeds 1 MiB.')
          throw new Error(label + ' exceeds 1 MiB.')
        }
        chunks.push(chunk)
      }
    } finally {
      reader.releaseLock()
      this.releaseOAuthResponse(response)
    }
    try {
      return record(JSON.parse(Buffer.concat(chunks, total).toString('utf8')), label)
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(label + ' is not valid JSON.')
      throw error
    }
  }

  private async writeCredential(serverId: string, credential: CredentialPayload): Promise<McpCredentialReferenceV1> {
    const id = `mcp_${createHash('sha256').update(serverId).digest('hex').slice(0, 16)}_` +
      base64Url(randomBytes(9))
    if (!this.encryption.available()) {
      this.sessionCredentials.set(id, credential)
      return { id, storage: 'session' }
    }
    await mkdir(this.credentialRoot, { recursive: true })
    const encrypted = this.encryption.encrypt(JSON.stringify(credential)).toString('base64')
    await atomicWriteFile(join(this.credentialRoot, `${id}.json`), `${JSON.stringify({ version: 1, encrypted })}\n`)
    return { id, storage: this.encryption.storage }
  }

  private async removeCredential(reference: McpCredentialReferenceV1): Promise<void> {
    this.sessionCredentials.delete(reference.id)
    if (reference.storage !== 'session') {
      await rm(join(this.credentialRoot, `${reference.id}.json`), { force: true }).catch(() => undefined)
    }
  }

  private async readCredential(reference?: McpCredentialReferenceV1): Promise<CredentialPayload | null> {
    if (!reference) return null
    if (reference.storage === 'session') return this.sessionCredentials.get(reference.id) ?? null
    if (!this.encryption.available()) return null
    try {
      const raw = JSON.parse(await readRecoveredFile(join(this.credentialRoot, `${reference.id}.json`))) as { encrypted: string }
      return JSON.parse(this.encryption.decrypt(Buffer.from(raw.encrypted, 'base64'))) as CredentialPayload
    } catch {
      return null
    }
  }

  private async read(): Promise<McpManifestV2> {
    try {
      const manifest = normalizedManifest(JSON.parse(await readRecoveredFile(this.manifestPath)))
      return this.repairObsoleteMigratedPaths(manifest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.migrateLegacy()
      throw error
    }
  }

  private async readLegacyObject(): Promise<Record<string, unknown> | null> {
    try {
      const parsed = JSON.parse(await readRecoveredFile(this.legacyPath)) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }

  private async repairObsoleteMigratedPaths(manifest: McpManifestV2): Promise<McpManifestV2> {
    const hasObsoletePath = manifest.servers.some((server) =>
      server.transport === 'stdio' && [server.command ?? '', ...(server.args ?? [])].some(isObsoleteWorkWisePath)
    )
    if (!hasObsoletePath) return manifest

    const legacy = await this.readLegacyObject()
    const rawServers = legacy && legacy.servers && typeof legacy.servers === 'object' && !Array.isArray(legacy.servers)
      ? legacy.servers as Record<string, unknown>
      : {}
    let changed = false
    const servers = manifest.servers.map((server) => {
      if (server.transport !== 'stdio' || ![server.command ?? '', ...(server.args ?? [])].some(isObsoleteWorkWisePath)) {
        return server
      }
      const launch = legacyStdioLaunch(rawServers[server.id])
      if (!launch) return server
      changed = true
      return { ...server, command: launch.command, args: launch.args }
    })
    if (!changed) return manifest
    const repaired = { ...manifest, revision: manifest.revision + 1, servers }
    await this.write(repaired)
    return repaired
  }

  private async migrateLegacy(): Promise<McpManifestV2> {
    const legacy = await this.readLegacyObject()
    if (!legacy) return emptyManifest()
    const root = legacy && typeof legacy === 'object' ? legacy as Record<string, unknown> : {}
    const rawServers = root.mcpServers && typeof root.mcpServers === 'object'
      ? root.mcpServers as Record<string, unknown>
      : root.servers && typeof root.servers === 'object'
        ? root.servers as Record<string, unknown>
        : {}
    const servers: McpServerConfigV2[] = []
    for (const [id, value] of Object.entries(rawServers)) {
      if (!value || typeof value !== 'object') continue
      const raw = value as Record<string, unknown>
      const launch = legacyStdioLaunch(raw)
      const command = launch?.command ?? ''
      const url = typeof raw.url === 'string' ? raw.url.trim() : ''
      if (!command && !url) continue
      if (url) {
        try {
          assertHttpUrl(url, 'MCP server URL')
        } catch {
          continue
        }
      }
      servers.push({
        id,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
        scope: 'global',
        transport: url ? 'http' : 'stdio',
        ...(command ? { command } : {}),
        ...(launch?.args.length ? { args: launch.args } : {}),
        ...(url ? { url } : {}),
        timeoutMs: typeof raw.timeoutMs === 'number' ? Math.min(Math.max(raw.timeoutMs, 1_000), 120_000) : 30_000,
        source: 'migration',
        toolPolicy: {},
        enabled: raw.enabled !== false,
        revision: 1
      })
    }
    const migrated: McpManifestV2 = {
      schema: 'workwise.mcp-servers',
      version: 2,
      revision: servers.length > 0 ? 1 : 0,
      servers,
      mutationKeys: {}
    }
    if (servers.length > 0) await this.write(migrated)
    return migrated
  }

  private async write(manifest: McpManifestV2): Promise<void> {
    await mkdir(dirname(this.manifestPath), { recursive: true })
    await atomicWriteFile(this.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
}
