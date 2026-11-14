import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  McpCapabilityConfig,
  McpServerConfig
} from '../../contracts/capabilities.js'
import { redactSecretText } from '../../config/secret-redaction.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import { assertGrantAllowsNetwork } from './sandbox-policy.js'
import {
  createMcpSearchProvider,
  mcpSearchDiagnostic,
  type McpSearchCatalogRecord,
  type McpSearchCatalogState,
  type McpSearchRuntimeDiagnostic
} from './mcp-tool-search.js'

export type McpToolDescriptor = {
  name: string
  title?: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
  execution?: unknown
  icons?: unknown
  _meta?: Record<string, unknown>
}

export type McpClientLike = {
  listTools(options?: {
    cursor?: string
    signal?: AbortSignal
    timeout?: number
  }): Promise<{ tools: McpToolDescriptor[]; nextCursor?: string }>
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    options?: { signal?: AbortSignal; timeout?: number }
  ): Promise<unknown>
  close(): Promise<void>
}

export type McpServerDiagnostic = {
  id: string
  enabled: boolean
  transport: McpServerConfig['transport']
  trustScope: McpServerConfig['trustScope']
  available: boolean
  status: 'disabled' | 'connected' | 'error'
  toolCount: number
  catalogFingerprint?: string
  catalogDrift?: boolean
  lastConnectedAt?: string
  lastError?: string
  authRequired?: boolean
}

export type McpToolProviderBuildResult = {
  authorityFingerprints: Record<string, string>
  providers: CapabilityToolProvider[]
  diagnostics: McpServerDiagnostic[]
  search: McpSearchRuntimeDiagnostic
  connectedServers: number
  toolCount: number
  close: () => Promise<void>
  retire: () => void
}

export type McpToolProviderOptions = {
  /** Trusted main-process credential snapshot, held only by this generation. */
  environment?: Readonly<Record<string, string>>
  /** Reviewed application policy. Server-provided hints alone do not authorize replay. */
  readOnlyTools?: Readonly<Record<string, readonly string[]>>
  clientFactory?: (serverId: string, server: McpServerConfig) => Promise<McpClientLike>
  nowIso?: () => string
  /**
   * Upper bound for connect + initial tool listing per server during startup.
   * A slow or hung server (e.g. an npx-based stdio server resolving packages)
   * must not keep the whole runtime from reporting ready.
   */
  startupConnectTimeoutMs?: number
}

const DEFAULT_MCP_STARTUP_CONNECT_TIMEOUT_MS = 10_000
const executionContext = new AsyncLocalStorage<ToolHostContext>()

type McpConnectionState = {
  configurationFingerprint: string
  authorityFingerprint: string
  retired: boolean
  pendingCalls: Set<Promise<unknown>>
  retiredClients: Set<Promise<void>>
  reconnecting?: Promise<McpClientLike>
  readOnlyTools: ReadonlySet<string>
  serverId: string
  server: McpServerConfig
  client: McpClientLike
  clientFactory: (serverId: string, server: McpServerConfig) => Promise<McpClientLike>
  nowIso: () => string
  catalogFingerprint?: string
  catalogDrift?: boolean
  lastConnectedAt?: string
  lastError?: string
  diagnostic?: McpServerDiagnostic
}

export async function buildMcpToolProviders(
  config: McpCapabilityConfig | undefined,
  options: McpToolProviderOptions = {}
): Promise<McpToolProviderBuildResult> {
  const providers: CapabilityToolProvider[] = []
  const directProviders: CapabilityToolProvider[] = []
  const diagnostics: McpServerDiagnostic[] = []
  const connected: McpConnectionState[] = []
  const catalogState: McpSearchCatalogState = { records: [] }
  const mcp = config
  const nowIso = options.nowIso ?? (() => new Date().toISOString())
  if (!mcp?.enabled) {
    return {
      providers,
      diagnostics,
      search: mcpSearchDiagnostic({
        config: config?.search ?? {
          enabled: false,
          mode: 'auto',
          autoThresholdToolCount: 24,
          topKDefault: 5,
          topKMax: 10,
          minScore: 0.15,
          bm25: { k1: 1.2, b: 0.75 }
        },
        active: false,
        indexedToolCount: 0,
        advertisedToolCount: 0,
        state: catalogState
      }),
      connectedServers: 0,
      toolCount: 0,
      authorityFingerprints: {},
      close: async () => undefined,
      retire: () => undefined
    }
  }

  // Connect all servers in parallel — startup previously paid the sum of
  // every server's connect + list latency, and a single hung server (e.g.
  // npx resolving a package) blocked the runtime ready signal forever.
  const startupTimeoutMs = options.startupConnectTimeoutMs ?? DEFAULT_MCP_STARTUP_CONNECT_TIMEOUT_MS
  type ConnectOutcome =
    | { serverId: string; server: McpServerConfig; status: 'disabled' }
    | { serverId: string; server: McpServerConfig; status: 'error'; error: unknown }
    | {
        serverId: string
        server: McpServerConfig
        status: 'connected'
        state: McpConnectionState
        listed: McpToolDescriptor[]
      }
  const outcomes = await Promise.all(
    Object.entries(mcp.servers).map(async ([serverId, server]): Promise<ConnectOutcome> => {
      if (!server.enabled) {
        return { serverId, server, status: 'disabled' }
      }
      const attempt = (async () => {
        const environment = mcpCredentialEnvironment(server, options.environment)
        const clientFactory = options.clientFactory ?? ((id: string, configuration: McpServerConfig) => createSdkMcpClient(id, configuration, environment))
        const authorityFingerprint = mcpAuthorityFingerprint(server, environment)
        const client = await clientFactory(serverId, server)
        const state: McpConnectionState = {
          configurationFingerprint: authorityFingerprint,
          authorityFingerprint,
          retired: false,
          pendingCalls: new Set(),
          retiredClients: new Set(),
          readOnlyTools: new Set(server.toolPolicy?.readOnlyTools ?? options.readOnlyTools?.[serverId] ?? []),
          serverId,
          server,
          client,
          clientFactory,
          nowIso,
          lastConnectedAt: nowIso()
        }
        try {
          const listed = await refreshMcpConnectionCatalog(state)
          if (server.toolPolicy && listed.length === 0) throw new Error('The configured connector did not provide any of its reviewed tools.')
          return { state, listed }
        } catch (error) {
          await client.close().catch(() => undefined)
          throw error
        }
      })()
      try {
        const result = await raceStartupTimeout(attempt, startupTimeoutMs, serverId)
        return { serverId, server, status: 'connected', ...result }
      } catch (error) {
        return { serverId, server, status: 'error', error }
      }
    })
  )

  for (const outcome of outcomes) {
    if (outcome.status === 'disabled') {
      diagnostics.push(serverDiagnostic({ serverId: outcome.serverId, server: outcome.server }, 'disabled', 0))
      continue
    }
    if (outcome.status === 'error') {
      diagnostics.push(
        serverDiagnostic({ serverId: outcome.serverId, server: outcome.server }, 'error', 0, errorMessage(outcome.error))
      )
      continue
    }
    const { state, listed } = outcome
    connected.push(state)
    catalogState.records.push(...listed.map((tool) => createMcpSearchCatalogRecord(state, tool)))
    const tools = listed.map((tool) => createMcpLocalTool(state, tool))
    directProviders.push({
      id: `mcp:${outcome.serverId}`,
      kind: 'mcp',
      enabled: true,
      available: true,
      tools
    })
    diagnostics.push(serverDiagnostic(state, 'connected', tools.length))
  }

  const connectedServers = diagnostics.filter((diagnostic) => diagnostic.status === 'connected').length
  const toolCount = catalogState.records.length
  catalogState.lastRefreshedAt = nowIso()
  catalogState.catalogFingerprint = catalogFingerprint(catalogState.records.map((record) => record.toolId))
  const searchActive = shouldUseMcpSearch(mcp.search, toolCount) && connectedServers > 0
  if (searchActive) {
    providers.push(createMcpSearchProvider({
      config: mcp.search,
      state: catalogState,
      refreshCatalog: async () => {
        try {
          const records: McpSearchCatalogRecord[] = []
          const previousFingerprint = catalogState.catalogFingerprint
          for (const state of connected) {
            const listed = await refreshMcpConnectionCatalog(state)
            records.push(...listed.map((tool) => createMcpSearchCatalogRecord(state, tool)))
          }
          catalogState.records = records
          catalogState.lastError = undefined
          catalogState.lastRefreshedAt = nowIso()
          catalogState.catalogFingerprint = catalogFingerprint(records.map((record) => record.toolId))
          catalogState.catalogDrift = Boolean(previousFingerprint && previousFingerprint !== catalogState.catalogFingerprint)
          return records
        } catch (error) {
          catalogState.lastError = redactSecretText(errorMessage(error))
          throw error
        }
      },
      isServerTrusted: isMcpServerTrusted
    }))
  } else {
    providers.push(...directProviders)
  }
  const advertisedToolCount = providers.reduce((total, provider) => total + provider.tools.length, 0)
  return {
    providers,
    diagnostics,
    search: mcpSearchDiagnostic({
      config: mcp.search,
      active: searchActive,
      indexedToolCount: toolCount,
      advertisedToolCount,
      state: catalogState
    }),
    get connectedServers() { return diagnostics.filter(server => server.status === 'connected').length },
    get toolCount() { return diagnostics.filter(server => server.available).reduce((total, server) => total + server.toolCount, 0) },
    get authorityFingerprints() { return Object.fromEntries(connected.map(state => [`mcp:${state.serverId}`, state.authorityFingerprint])) },
    retire: () => { for (const state of connected) state.retired = true },
    close: async () => {
      for (const state of connected) state.retired = true
      await Promise.all(connected.map(async state => {
        await Promise.allSettled([...state.pendingCalls])
        await Promise.allSettled([...state.retiredClients])
        await state.client.close().catch(() => undefined)
      }))
    }
  }
}

export function normalizeMcpToolName(serverId: string, toolName: string): string {
  return `mcp_${slug(serverId)}_${slug(toolName)}`
}

export function isMcpServerTrusted(server: McpServerConfig, workspace: string): boolean {
  if (server.trustScope === 'user') return true
  const normalizedWorkspace = normalizePathForTrust(workspace)
  return server.trustedWorkspaceRoots.some((root) => {
    const normalizedRoot = normalizePathForTrust(root)
    return normalizedWorkspace === normalizedRoot || normalizedWorkspace.startsWith(`${normalizedRoot}/`)
  })
}

function allowsMcpNetwork(server: McpServerConfig, context: ToolHostContext): boolean {
  if (!server.url) return true
  try { assertGrantAllowsNetwork(server.url, context); return true } catch { return false }
}

function mcpAuthorityFingerprint(server: McpServerConfig, environment?: Readonly<Record<string, string>>): string {
  return createHash('sha256').update(JSON.stringify({ ...server, env: resolveMcpSecrets(server.env, environment),
    headers: resolveMcpSecrets(server.headers, environment), url: server.url ? resolveMcpServerUrl(server.url, environment) : undefined })).digest('hex')
}

function mcpCredentialEnvironment(server: McpServerConfig, snapshot?: Readonly<Record<string, string>>): Record<string, string> {
  const values = [...Object.values(server.env), ...Object.values(server.headers)]
  if (server.url) values.push(...new URL(server.url).searchParams.values())
  const environment: Record<string, string> = {}
  for (const value of values) {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
    if (!match) continue
    const key = match[1]!
    // V2 deletions must revoke old injected credentials. Explicit legacy env
    // references keep their existing reader, captured once for this generation.
    const secret = snapshot?.[key] ?? (snapshot && key.startsWith('WORKWISE_MCP_SECRET_') ? undefined : process.env[key])
    if (secret !== undefined) environment[key] = secret
  }
  return environment
}

function matchesMcpAuthority(state: McpConnectionState, context: ToolHostContext): boolean {
  if (state.retired || state.diagnostic?.available === false) return false
  const providerId = `mcp:${state.serverId}`
  for (const allowed of [context.allowedMcpProviderIds, context.executionGrant?.allowedMcpProviderIds]) {
    if (allowed && !allowed.includes(providerId) && !allowed.includes(state.serverId)) return false
  }
  return !context.executionGrant || context.executionGrant.connectorIdentityFingerprints?.[providerId] === state.authorityFingerprint
}

function assertMcpAuthority(state: McpConnectionState, context: ToolHostContext): void {
  const bridgeBlock = taskScheduleBridgeBlock(state.serverId, context)
  if (bridgeBlock) throw Object.assign(new Error(bridgeBlock.message), { code: bridgeBlock.code })
  if (!matchesMcpAuthority(state, context)) throw Object.assign(new Error('MCP configuration or account changed. Resume the task with a newly authorized execution.'), { code: 'connector_configuration_changed' })
}

/** Task schedules must use their task-owned authority and readback, including on replay. */
function taskScheduleBridgeBlock(serverId: string, context: ToolHostContext): { code: string; message: string } | undefined {
  if (!context.executionGrant?.taskId || !['gui_schedule', 'claw_schedule'].includes(serverId)) return undefined
  return { code: 'execution_grant_scope', message: '当前任务不能使用兼容定时桥。请使用 schedule_task 建立本任务计划，再用 list_schedules 读回验收。' }
}

async function createSdkMcpClient(serverId: string, server: McpServerConfig, environment?: Readonly<Record<string, string>>): Promise<McpClientLike> {
  const client = new Client({ name: `railwise-ai-${serverId}`, version: '0.1.0' })
  const transport = createTransport(server, environment)
  await client.connect(transport, { timeout: server.timeoutMs })
  return {
    listTools: (options) => {
      const params = options?.cursor ? { cursor: options.cursor } : undefined
      return client.listTools(params, {
        signal: options?.signal,
        timeout: options?.timeout
      })
    },
    callTool: (input, options) => client.callTool(input, undefined, { signal: options?.signal, timeout: options?.timeout }),
    close: () => client.close()
  }
}

function createTransport(server: McpServerConfig, environment?: Readonly<Record<string, string>>): Transport {
  const env = resolveMcpSecrets(server.env, environment)
  const headers = resolveMcpSecrets(server.headers, environment)
  switch (server.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: server.command ?? '',
        args: server.args,
        cwd: server.cwd,
        env,
        stderr: 'pipe'
      })
    case 'streamable-http':
      return new StreamableHTTPClientTransport(new URL(resolveMcpServerUrl(server.url ?? '', environment)), {
        requestInit: { headers }, fetch: scopedMcpFetch(headers)
      })
    case 'sse':
      return new SSEClientTransport(new URL(resolveMcpServerUrl(server.url ?? '', environment)), {
        requestInit: { headers },
        fetch: scopedMcpFetch(headers),
        eventSourceInit: { fetch: scopedMcpFetch(headers) }
      })
  }
}

/** Only complete query values can reference secrets. The configured origin and path stay fixed. */
export function resolveMcpServerUrl(value: string, environment: Readonly<Record<string, string | undefined>> = process.env): string {
  const url = new URL(value)
  for (const [key, query] of url.searchParams) {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(query)
    if (!match) continue
    const secret = environment[match[1]!]
    if (!secret) throw Object.assign(new Error('The connector credential is unavailable. Configure this connection and retry.'), { code: 'connector_credentials_missing' })
    url.searchParams.set(key, secret)
  }
  return url.href
}

export function resolveMcpSecrets(values: Record<string, string>, environment: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
    if (!match) return [key, value]
    return [key, environment[match[1]!] ?? '']
  }))
}

function scopedMcpFetch(headers: Record<string, string>): typeof fetch {
  return (input, init) => {
    const context = executionContext.getStore()
    if (context) assertGrantAllowsNetwork(input instanceof Request ? input.url : String(input), context)
    const mergedHeaders = new Headers(init?.headers)
    for (const [key, value] of Object.entries(headers)) {
      mergedHeaders.set(key, value)
    }
    return fetch(input, { ...init, headers: mergedHeaders, redirect: 'error' })
  }
}

function createMcpLocalTool(
  state: McpConnectionState,
  descriptor: McpToolDescriptor
): LocalTool {
  return LocalToolHost.defineTool({
    name: normalizeMcpToolName(state.serverId, descriptor.name),
    description: descriptor.description ?? `MCP tool ${descriptor.name} from ${state.serverId}`,
    inputSchema: descriptor.inputSchema ?? { type: 'object' },
    policy: policyFromAnnotations(descriptor.annotations),
    contextBlock: context => taskScheduleBridgeBlock(state.serverId, context),
    shouldAdvertise: (context: ToolHostContext) => matchesMcpAuthority(state, context) && isMcpServerTrusted(state.server, context.workspace) && allowsMcpNetwork(state.server, context),
    execute: async (args, context) => {
      assertMcpAuthority(state, context)
      if (!isMcpServerTrusted(state.server, context.workspace)) {
        return {
          output: { error: `MCP server ${state.serverId} is not trusted for this workspace` },
          isError: true
        }
      }
      if (state.server.url) assertGrantAllowsNetwork(state.server.url, context)
      const result = await executionContext.run(context, () => callMcpToolWithReconnect(
        state, { name: descriptor.name, arguments: args }, context.abortSignal
      ))
      return {
        output: {
          serverId: state.serverId,
          toolName: descriptor.name,
          result
        },
        isError: typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError === true
      }
    }
  })
}

async function listAllMcpTools(client: McpClientLike, timeout: number): Promise<McpToolDescriptor[]> {
  const tools: McpToolDescriptor[] = []
  let cursor: string | undefined
  do {
    const listed = await client.listTools({ cursor, timeout })
    tools.push(...listed.tools)
    cursor = listed.nextCursor
  } while (cursor)
  return tools
}

function createMcpSearchCatalogRecord(
  state: McpConnectionState,
  descriptor: McpToolDescriptor
): McpSearchCatalogRecord {
  return {
    toolId: `${state.serverId}/${descriptor.name}`,
    serverId: state.serverId,
    server: state.server,
    contextBlock: context => taskScheduleBridgeBlock(state.serverId, context),
    isAvailable: context => matchesMcpAuthority(state, context),
    client: {
      callTool: (input, options) => {
        if (!options?.context) throw new Error('MCP execution context is required')
        assertMcpAuthority(state, options.context)
        if (state.server.url) assertGrantAllowsNetwork(state.server.url, options.context)
        return executionContext.run(options.context, () => callMcpToolWithReconnect(state, input, options.signal, options.timeout))
      }
    },
    descriptor,
    normalizedName: normalizeMcpToolName(state.serverId, descriptor.name),
    policy: policyFromAnnotations(descriptor.annotations)
  }
}

async function refreshMcpConnectionCatalog(state: McpConnectionState): Promise<McpToolDescriptor[]> {
  if (state.retired) throw Object.assign(new Error('MCP configuration has been replaced.'), { code: 'connector_configuration_changed' })
  const pending = listAllMcpTools(state.client, state.server.timeoutMs)
  state.pendingCalls.add(pending)
  let discovered: McpToolDescriptor[]
  try { discovered = await pending } finally { state.pendingCalls.delete(pending) }
  const listed = state.server.toolPolicy
    ? discovered.filter(tool => state.server.toolPolicy!.allowedTools.includes(tool.name))
    : discovered
  const nextFingerprint = catalogFingerprint(listed.map(tool => JSON.stringify({ name: tool.name, inputSchema: tool.inputSchema, annotations: tool.annotations })))
  state.catalogDrift = Boolean(state.catalogFingerprint && state.catalogFingerprint !== nextFingerprint)
  state.catalogFingerprint = nextFingerprint
  state.authorityFingerprint = createHash('sha256').update(`${state.configurationFingerprint}:${nextFingerprint}`).digest('hex')
  clearMcpConnectionError(state)
  return listed
}

async function callMcpToolWithReconnect(
  state: McpConnectionState,
  input: { name: string; arguments: Record<string, unknown> },
  signal: AbortSignal | undefined,
  timeout = state.server.timeoutMs
): Promise<unknown> {
  if (state.retired) throw Object.assign(new Error('MCP configuration changed. Start a newly authorized execution.'), { code: 'connector_configuration_changed' })
  const pending = callCurrentMcpTool(state, input, signal, timeout)
  state.pendingCalls.add(pending)
  try { return await pending } finally { state.pendingCalls.delete(pending) }
}

async function callCurrentMcpTool(state: McpConnectionState, input: { name: string; arguments: Record<string, unknown> }, signal: AbortSignal | undefined, timeout: number): Promise<unknown> {
  if (state.server.toolPolicy && !state.server.toolPolicy.allowedTools.includes(input.name)) {
    throw Object.assign(new Error('This connector tool is outside its configured capability scope.'), { code: 'execution_grant_scope' })
  }
  try {
    const result = await state.client.callTool(input, { signal, timeout })
    observeMcpToolResult(state, result)
    return result
  } catch (error) {
    setMcpConnectionError(state, errorMessage(error))
    if (signal?.aborted) throw error
    if (!looksLikeMcpTransportError(error)) throw error
    if (!state.readOnlyTools.has(input.name)) {
      throw Object.assign(new Error('MCP connection failed after dispatch. Verify the original operation before retrying.'), {
        code: 'outcome_unknown', cause: error
      })
    }
    if (state.retired) throw Object.assign(new Error('MCP configuration changed while the connection was interrupted.'), { code: 'connector_configuration_changed' })
    const client = await reconnectMcpConnection(state)
    try {
      const result = await client.callTool(input, { signal, timeout })
      observeMcpToolResult(state, result)
      return result
    } catch (retryError) {
      setMcpConnectionError(state, errorMessage(retryError))
      throw retryError
    }
  }
}

function looksLikeMcpTransportError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase()
  return (
    message.includes('connect') ||
    message.includes('connection') ||
    message.includes('transport') ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('epipe') ||
    message.includes('broken pipe') ||
    message.includes('socket') ||
    message.includes('stream closed') ||
    message.includes('fetch failed') ||
    message.includes('network')
  )
}

async function raceStartupTimeout<T extends { state: McpConnectionState }>(
  attempt: Promise<T>,
  timeoutMs: number,
  serverId: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      attempt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`MCP server "${serverId}" did not connect within ${timeoutMs}ms during startup`)),
          timeoutMs
        )
      })
    ])
  } catch (error) {
    // A late successful connection would otherwise leak the child process.
    void attempt.then((result) => result.state.client.close()).catch(() => undefined)
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function reconnectMcpConnection(state: McpConnectionState): Promise<McpClientLike> {
  if (state.reconnecting) return state.reconnecting
  const previous = state.client
  const pending = (async () => {
    const client = await state.clientFactory(state.serverId, state.server)
    if (state.retired) {
      await client.close().catch(() => undefined)
      throw Object.assign(new Error('MCP configuration was revoked during reconnect.'), { code: 'connector_configuration_changed' })
    }
    state.client = client
    state.lastConnectedAt = state.nowIso()
    clearMcpConnectionError(state)
    const close = Promise.allSettled([...state.pendingCalls]).then(() => previous.close()).catch(() => undefined)
    state.retiredClients.add(close)
    void close.finally(() => state.retiredClients.delete(close))
    return client
  })()
  state.reconnecting = pending
  try { return await pending } finally { state.reconnecting = undefined }
}

function observeMcpToolResult(state: McpConnectionState, result: unknown): void {
  if (!mcpResultIsError(result)) {
    clearMcpConnectionError(state)
    return
  }
  const message = mcpResultErrorMessage(result)
  if (isLikelyMcpInfrastructureError(state.serverId, message)) {
    setMcpConnectionError(state, message)
  }
}

function setMcpConnectionError(state: McpConnectionState, message: string): void {
  const redacted = redactSecretText(message)
  state.lastError = redacted
  if (!state.diagnostic) return
  state.diagnostic.status = 'error'
  state.diagnostic.available = false
  state.diagnostic.lastError = redacted
  state.diagnostic.authRequired = mcpAuthRequired(state.serverId, redacted)
}

function clearMcpConnectionError(state: McpConnectionState): void {
  state.lastError = undefined
  if (!state.diagnostic) return
  state.diagnostic.status = 'connected'
  state.diagnostic.available = true
  if (state.lastConnectedAt) {
    state.diagnostic.lastConnectedAt = state.lastConnectedAt
  } else {
    delete state.diagnostic.lastConnectedAt
  }
  delete state.diagnostic.lastError
  delete state.diagnostic.authRequired
}

function shouldUseMcpSearch(config: NonNullable<McpCapabilityConfig['search']>, toolCount: number): boolean {
  if (!config.enabled) return false
  if (config.mode === 'direct') return false
  if (config.mode === 'search') return true
  return toolCount >= config.autoThresholdToolCount
}

function policyFromAnnotations(annotation: McpToolDescriptor['annotations']): LocalTool['policy'] {
  if (annotation?.readOnlyHint && !annotation.openWorldHint && !annotation.destructiveHint) return 'auto'
  if (annotation?.destructiveHint) return 'on-request'
  if (annotation?.openWorldHint) return 'untrusted'
  return 'on-request'
}

function serverDiagnostic(
  state: { serverId: string; server: McpServerConfig; catalogFingerprint?: string; catalogDrift?: boolean; lastConnectedAt?: string },
  status: McpServerDiagnostic['status'],
  toolCount: number,
  lastError?: string
): McpServerDiagnostic {
  const redactedError = lastError ? redactSecretText(lastError) : ''
  const authRequired = redactedError ? mcpAuthRequired(state.serverId, redactedError) : false
  return {
    id: state.serverId,
    enabled: state.server.enabled,
    transport: state.server.transport,
    trustScope: state.server.trustScope,
    available: status === 'connected',
    status,
    toolCount,
    ...(state.catalogFingerprint ? { catalogFingerprint: state.catalogFingerprint } : {}),
    ...(state.catalogDrift !== undefined ? { catalogDrift: state.catalogDrift } : {}),
    ...(state.lastConnectedAt ? { lastConnectedAt: state.lastConnectedAt } : {}),
    ...(redactedError ? { lastError: redactedError } : {}),
    ...(authRequired ? { authRequired: true } : {})
  }
}

function mcpResultIsError(result: unknown): boolean {
  return !!result && typeof result === 'object' && (result as { isError?: unknown }).isError === true
}

function mcpResultErrorMessage(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result)
  const record = result as Record<string, unknown>
  const direct = typeof record.error === 'string' ? record.error : ''
  const content = Array.isArray(record.content)
    ? record.content
        .map((item) => {
          if (!item || typeof item !== 'object') return ''
          const text = (item as Record<string, unknown>).text
          return typeof text === 'string' ? text : ''
        })
        .filter(Boolean)
        .join('\n')
    : ''
  return direct || content || JSON.stringify(result)
}

function isLikelyMcpInfrastructureError(serverId: string, message: string): boolean {
  return mcpAuthRequired(serverId, message) ||
    /32000|connection closed|closed|econnrefused|enoent|spawn|timeout|timed out/i.test(message)
}

export function mcpAuthRequired(serverId: string, message: string): boolean {
  const haystack = `${serverId} ${message}`.toLowerCase()
  return /subscription_token_invalid|provided subscription token is invalid|brave_api_key|api key|token.+invalid|invalid.+token|unauthorized|forbidden|401|403|bad credentials/.test(haystack)
}

function catalogFingerprint(values: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...values].sort()))
    .digest('hex')
    .slice(0, 16)
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'tool'
}

function normalizePathForTrust(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
