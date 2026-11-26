import { createHash } from 'node:crypto'
import { assertGrantAllowsNetwork } from './sandbox-policy.js'
import type { KunCapabilitiesConfig, WebCapabilityConfig } from '../../contracts/capabilities.js'
import { parseWebSourceAddress } from '../../contracts/task-source-intent.js'
import type { WebFetchResult, WebProvider, WebSearchResult } from '../../ports/web-provider.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { sourceIdFor, UnavailableWebProvider } from '../../ports/web-provider.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import { SafeWebFetchError, safeWebFetch } from '../../network/safe-web-fetch.js'
import { extractReadableHtml } from '../../network/web-html-content.js'

const DEFAULT_WEB_TIMEOUT_MS = 15_000
const DEFAULT_DEEPSEEK_RESPONSES_SEARCH_TIMEOUT_MS = 90_000
const MAX_DEEPSEEK_RESPONSES_SEARCH_TIMEOUT_MS = 120_000
const DEFAULT_WEB_MAX_BYTES = 1024 * 1024
// Models sometimes pass tiny max_bytes budgets (2000 was common in the
// wild); below this floor the extracted text is too small to be useful.
const MIN_WEB_FETCH_BYTES = 4_096
const DEFAULT_SEARCH_LIMIT = 5
const MAX_SEARCH_LIMIT = 10

export type WebProviderDiagnostic = {
  id: string
  enabled: boolean
  available: boolean
  fetchAvailable: boolean
  searchAvailable: boolean
  provider?: string
  reason?: string
}

export type WebToolProviderBuildResult = {
  providers: CapabilityToolProvider[]
  diagnostics: WebProviderDiagnostic[]
  fetchAvailable: boolean
  searchAvailable: boolean
  provider?: string
}

export type WebToolProviderOptions = {
  provider?: WebProvider
  fetchProvider?: WebProvider
  searchProvider?: WebProvider
  searchResultUrls?: (taskId: string, turnId: string) => readonly string[]
  nowIso?: () => string
}

export function buildWebToolProviders(
  config: KunCapabilitiesConfig['web'] | undefined,
  options: WebToolProviderOptions = {}
): WebToolProviderBuildResult {
  const web = config
  if (!web?.enabled) {
    return {
      providers: [],
      diagnostics: [],
      fetchAvailable: false,
      searchAvailable: false
    }
  }

  const fallbackProvider: WebProvider = options.provider ?? (web.fetchEnabled
    ? new FetchWebProvider(web, options.nowIso)
    : new UnavailableWebProvider(web.provider))
  const fetchProvider = options.fetchProvider ?? fallbackProvider
  const searchProvider = options.searchProvider ?? fallbackProvider
  const tools = []
  if (web.fetchEnabled && fetchProvider.fetch) {
    tools.push(createFetchTool(web, fetchProvider, options.searchResultUrls))
  }
  if (web.searchEnabled && searchProvider.search) {
    tools.push(createSearchTool(web, searchProvider))
  }
  const fetchAvailable = Boolean(web.fetchEnabled && fetchProvider.fetch)
  const searchAvailable = Boolean(web.searchEnabled && searchProvider.search)
  const reason = !web.fetchEnabled && !web.searchEnabled
    ? 'web tools are disabled by config'
    : !fetchAvailable && !searchAvailable
      ? 'web provider is unavailable'
      : undefined

  return {
    providers: tools.length
      ? [{
          id: 'web',
          kind: 'web',
          enabled: true,
          available: true,
          ...(reason ? { reason } : {}),
          tools
        }]
      : [],
    diagnostics: [{
      id: 'web',
      enabled: true,
      available: fetchAvailable || searchAvailable,
      fetchAvailable,
      searchAvailable,
      provider: diagnosticProviderId(fetchProvider, searchProvider, web),
      ...(reason ? { reason } : {})
    }],
    fetchAvailable,
    searchAvailable,
    provider: diagnosticProviderId(fetchProvider, searchProvider, web)
  }
}

function diagnosticProviderId(
  fetchProvider: WebProvider,
  searchProvider: WebProvider,
  config: WebCapabilityConfig
): string {
  if (config.fetchEnabled && config.searchEnabled && fetchProvider.id !== searchProvider.id) {
    return `${fetchProvider.id}+${searchProvider.id}`
  }
  return config.searchEnabled ? searchProvider.id : fetchProvider.id
}

function createFetchTool(
  config: WebCapabilityConfig,
  provider: WebProvider,
  searchResultUrls?: WebToolProviderOptions['searchResultUrls']
) {
  const exactSearchResultUrl = (address: string, context: ToolHostContext): string | undefined => {
    const taskId = context.executionGrant?.taskId
    if (!taskId) return undefined
    let url: URL
    try { url = parseWebSourceAddress(address) } catch { return undefined }
    return searchResultUrls?.(taskId, context.turnId).find(candidate => {
      try { return new URL(candidate).href === url.href } catch { return false }
    })
  }
  const authorizedByGrant = (url: URL, context: ToolHostContext): boolean => {
    const origins = context.executionGrant?.networkAllowlist ?? []
    return origins.includes('*') || origins.includes(url.origin)
  }
  return LocalToolHost.defineTool({
    name: 'web_fetch',
    description: 'Fetch an allowed HTTP or HTTPS page and return extracted text with source metadata. A pasted www address defaults to HTTPS. Read-only; no browser setup is needed.',
    approvalSummary: async args => {
      const address = pickString(args.url)
      if (!address) return '读取公开网页\n网站：无法识别\n影响：只读取网页内容。'
      try {
        const url = parseWebSourceAddress(address)
        return `读取公开网页\n网站：${url.origin}\n范围：仅当前任务\n影响：只读取网页内容，不会登录、填写或提交数据。`
      } catch {
        return '读取公开网页\n网站：无法识别\n影响：只读取网页内容。'
      }
    },
    approvalNetworkReadOrigin: async args => {
      const address = pickString(args.url)
      if (!address) return undefined
      try { return parseWebSourceAddress(address).origin } catch { return undefined }
    },
    hasScopedApproval: async (args, context) => {
      const grant = context.executionGrant
      const address = pickString(args.url)
      if (!grant?.taskId || !address) return false
      try {
        const url = parseWebSourceAddress(address)
        if (await context.isTaskWebReadOriginApproved?.(url.origin)) return true
        if (grant.networkAllowlist.includes('*')) return false
        return grant.networkAllowlist.includes(url.origin) || Boolean(exactSearchResultUrl(address, context))
      } catch {
        return false
      }
    },
    validateArguments: (args, context) => {
      const address = pickString(args.url)
      if (!address) return
      let url: URL
      try { url = parseWebSourceAddress(address) } catch { return }
      if (!authorizedByGrant(url, context) && !exactSearchResultUrl(address, context)) assertGrantAllowsNetwork(url.href, context)
    },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_bytes: { type: 'number' },
        timeout_ms: { type: 'number' }
      },
      required: ['url'],
      additionalProperties: false
    },
    policy: 'untrusted',
    execute: async (args, context) => {
      const startedAt = Date.now()
      const rawUrl = pickString(args.url)
      if (!rawUrl) return toolError('invalid_url', 'url is required')
      const policy = validateUrlPolicy(rawUrl, config)
      if (!policy.ok) return toolError('policy_blocked', policy.reason, telemetry({ startedAt, policy: 'blocked', url: rawUrl }))
      const authorizedSearchUrl = exactSearchResultUrl(rawUrl, context)
      if (!authorizedByGrant(policy.url, context) && !authorizedSearchUrl) assertGrantAllowsNetwork(policy.url.href, context)
      if (!provider.fetch) return toolError('provider_unavailable', 'web fetch provider is unavailable')
      const maxBytesCap = config.maxFetchBytes ?? DEFAULT_WEB_MAX_BYTES
      const maxBytes = boundedInt(
        args.max_bytes,
        maxBytesCap,
        Math.min(MIN_WEB_FETCH_BYTES, maxBytesCap),
        maxBytesCap
      )
      const timeoutMs = boundedInt(args.timeout_ms, DEFAULT_WEB_TIMEOUT_MS, 1, DEFAULT_WEB_TIMEOUT_MS)
      try {
        let allowedOrigins = context.executionGrant?.networkAllowlist
        if (allowedOrigins?.includes('*')) {
          if (authorizedSearchUrl) allowedOrigins = []
          else if (await context.isTaskWebReadOriginApproved?.(policy.url.origin)) allowedOrigins = [policy.url.origin]
        }
        const result = await provider.fetch({
          url: policy.url.href,
          maxBytes,
          timeoutMs,
          signal: context.abortSignal,
          allowedOrigins,
          ...(authorizedSearchUrl ? { allowedUrls: [authorizedSearchUrl] } : {})
        })
        return {
          output: fetchOutput(result, telemetry({
            startedAt,
            policy: 'allowed',
            url: policy.url.href,
            provider: provider.id,
            byteCount: result.byteCount
          }))
        }
      } catch (error) {
        const code = error instanceof SafeWebFetchError ? error.code : 'fetch_failed'
        return toolError(code, errorMessage(error), telemetry({
          startedAt,
          policy: 'allowed',
          url: policy.url.href,
          provider: provider.id
        }))
      }
    }
  })
}

function createSearchTool(config: WebCapabilityConfig, provider: WebProvider) {
  return LocalToolHost.defineTool({
    name: 'web_search',
    description: 'Search public web results through the configured provider. Returns untrusted titles, snippets, exact source URLs and ranks. A successful search result authorizes fetching only its exact URL in the same task and Turn; it does not authorize the site origin or other URLs. Redirects are allowed only when their destination is independently covered by the task network scope.',
    hasScopedApproval: async (_args, context) => {
      const grant = context.executionGrant
      if (!grant?.taskId) return false
      return provider.canSearchWithin
        ? provider.canSearchWithin(grant.networkAllowlist, config.denyDomains)
        : providerHasScopedSearchApproval(provider, grant.networkAllowlist, config.denyDomains)
    },
    validateArguments: (args, context) => {
      const query = pickString(args.query)
      if (!query || query.length > 512) throw new Error('Search query must be between 1 and 512 characters.')
      if (context.executionGrant && (provider.canSearchWithin
        ? !provider.canSearchWithin(context.executionGrant.networkAllowlist, config.denyDomains)
        : provider.searchOrigins?.length && !providerHasScopedSearchApproval(provider, context.executionGrant.networkAllowlist, config.denyDomains))) {
        throw Object.assign(new Error('No configured search provider is allowed by the task network scope.'), { code: 'network_scope_blocked' })
      }
    },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        timeout_ms: { type: 'number' }
      },
      required: ['query'],
      additionalProperties: false
    },
    policy: 'untrusted',
    execute: async (args, context) => {
      const startedAt = Date.now()
      const query = pickString(args.query)
      if (!query) return toolError('invalid_query', 'query is required')
      if (!provider.search) return toolError('provider_unavailable', 'web search provider is unavailable')
      const limit = boundedInt(args.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
      const deepSeekResponses = provider.id.split('+').includes('deepseek-responses')
      const defaultTimeoutMs = deepSeekResponses
        ? DEFAULT_DEEPSEEK_RESPONSES_SEARCH_TIMEOUT_MS
        : DEFAULT_WEB_TIMEOUT_MS
      const maxTimeoutMs = deepSeekResponses
        ? MAX_DEEPSEEK_RESPONSES_SEARCH_TIMEOUT_MS
        : DEFAULT_WEB_TIMEOUT_MS
      const timeoutMs = boundedInt(args.timeout_ms, defaultTimeoutMs, 1, maxTimeoutMs)
      try {
        const results = await provider.search({
          query,
          limit,
          timeoutMs,
          signal: context.abortSignal,
          allowedOrigins: context.executionGrant?.networkAllowlist,
          denyDomains: config.denyDomains
        })
        return {
          output: searchOutput(query, provider.id, results, telemetry({
            startedAt,
            policy: 'allowed',
            provider: provider.id,
            query,
            resultCount: results.length
          }))
        }
      } catch (error) {
        return toolError('search_failed', errorMessage(error), telemetry({
          startedAt,
          policy: 'allowed',
          provider: provider.id,
          query
        }))
      }
    }
  })
}

function providerHasScopedSearchApproval(
  provider: WebProvider,
  allowedOrigins: readonly string[],
  denyDomains: readonly string[]
): boolean {
  const origins = provider.searchOrigins
  if (!origins?.length) return false
  return origins.every(origin => {
    const url = new URL(origin)
    const hostname = url.hostname.toLowerCase()
    const originAllowed = allowedOrigins.includes('*') || allowedOrigins.includes(url.origin)
    const domainDenied = denyDomains.some(domain => domainMatches(hostname, domain))
    return originAllowed && !domainDenied
  })
}

class FetchWebProvider implements WebProvider {
  readonly id = 'fetch'
  private readonly nowIso: () => string

  constructor(
    private readonly policy: Pick<WebCapabilityConfig, 'allowDomains' | 'denyDomains'>,
    nowIso: (() => string) | undefined
  ) {
    this.nowIso = nowIso ?? (() => new Date().toISOString())
  }

  async fetch(request: {
    url: string
    maxBytes: number
    timeoutMs: number
    signal: AbortSignal
    allowedOrigins?: string[]
    allowedUrls?: string[]
  }): Promise<WebFetchResult> {
    const response = await safeWebFetch(request.url, {
      allowDomains: this.policy.allowDomains,
      allowedOrigins: request.allowedOrigins,
      allowedUrls: request.allowedUrls,
      denyDomains: this.policy.denyDomains,
      maxBytes: request.maxBytes,
      totalTimeoutMs: Math.min(request.timeoutMs, DEFAULT_WEB_TIMEOUT_MS)
    }, request.signal)
    const contentType = response.headers['content-type']
    if (contentType?.toLowerCase().includes('application/pdf')) {
      throw new SafeWebFetchError('invalid_response', 'PDF content needs a document reader. Use the browser or add the PDF to the conversation for parsing.')
    }
    if (contentType && !/^(?:text\/|application\/(?:json|xml|xhtml\+xml))/i.test(contentType)) {
      throw new SafeWebFetchError('invalid_response', 'The response is not a readable text or HTML page.')
    }
    const declared = contentType?.match(/charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i)?.[1]
      ?? response.body.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i)?.[1]
    let raw: string
    try { raw = new TextDecoder(declared ?? 'utf-8').decode(response.body) }
    catch { throw new SafeWebFetchError('invalid_response', 'The page declares an unsupported text encoding.') }
    const extracted = contentType?.toLowerCase().includes('html')
      ? extractReadableHtml(raw, response.finalUrl)
      : { text: normalizeWhitespace(raw) }
    if (!extracted.text) {
      throw new SafeWebFetchError('invalid_response', 'The page returned no readable text. Use an authorized browser for pages that require JavaScript.')
    }
    return {
      sourceId: sourceIdFor('fetch', response.finalUrl),
      url: request.url,
      finalUrl: response.finalUrl,
      title: extracted.title,
      contentType,
      text: extracted.text,
      retrievedAt: this.nowIso(),
      byteCount: response.body.byteLength,
      truncated: false
    }
  }
}

function fetchOutput(result: WebFetchResult, toolTelemetry: Record<string, unknown>) {
  const source = {
    sourceId: result.sourceId,
    url: result.finalUrl,
    title: result.title,
    retrievedAt: result.retrievedAt
  }
  return {
    untrusted: true,
    sourceId: result.sourceId,
    url: result.url,
    finalUrl: result.finalUrl,
    title: result.title,
    retrievedAt: result.retrievedAt,
    contentType: result.contentType,
    text: result.text,
    resultHash: createHash('sha256').update(result.text).digest('hex'),
    byteCount: result.byteCount,
    truncated: result.truncated,
    sources: [source],
    citations: [source],
    telemetry: toolTelemetry
  }
}

function searchOutput(
  query: string,
  provider: string,
  results: WebSearchResult[],
  toolTelemetry: Record<string, unknown>
) {
  const sources = results.map((result) => ({
    sourceId: result.sourceId,
    url: result.url,
    title: result.title,
    retrievedAt: result.retrievedAt
  }))
  return {
    untrusted: true,
    query,
    provider,
    results,
    sources,
    citations: sources,
    telemetry: toolTelemetry
  }
}

function validateUrlPolicy(rawUrl: string, config: WebCapabilityConfig): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL
  try {
    url = parseWebSourceAddress(rawUrl)
  } catch {
    return { ok: false, reason: 'URL must be absolute' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'only http and https URLs are allowed' }
  }
  if (url.username || url.password) return { ok: false, reason: 'URL credentials are not allowed' }
  const hostname = url.hostname.toLowerCase()
  if (config.denyDomains.some((domain) => domainMatches(hostname, domain))) {
    return { ok: false, reason: `domain is denied: ${hostname}` }
  }
  if (config.allowDomains.length > 0 && !config.allowDomains.some((domain) => domainMatches(hostname, domain))) {
    return { ok: false, reason: `domain is not allowed: ${hostname}` }
  }
  return { ok: true, url }
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = domain.toLowerCase().replace(/^\./, '')
  return hostname === normalized || hostname.endsWith(`.${normalized}`)
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

function telemetry(input: {
  startedAt: number
  policy: 'allowed' | 'blocked'
  provider?: string
  url?: string
  query?: string
  byteCount?: number
  resultCount?: number
}): Record<string, unknown> {
  return {
    provider: input.provider,
    url: input.url,
    query: input.query,
    byteCount: input.byteCount,
    resultCount: input.resultCount,
    durationMs: Date.now() - input.startedAt,
    cacheStatus: 'miss',
    policy: input.policy
  }
}

function toolError(code: string, message: string, toolTelemetry?: Record<string, unknown>) {
  return {
    output: {
      error: {
        code,
        message
      },
      ...(toolTelemetry ? { telemetry: toolTelemetry } : {})
    },
    isError: true
  }
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.floor(value), min), max)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
