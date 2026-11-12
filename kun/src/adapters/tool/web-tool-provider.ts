import { assertGrantAllowsNetwork } from './sandbox-policy.js'
import type { KunCapabilitiesConfig, WebCapabilityConfig } from '../../contracts/capabilities.js'
import type { WebFetchResult, WebProvider, WebSearchResult } from '../../ports/web-provider.js'
import { sourceIdFor, UnavailableWebProvider } from '../../ports/web-provider.js'
import type { CapabilityToolProvider } from './capability-registry.js'
import { LocalToolHost } from './local-tool-host.js'
import { SafeWebFetchError, safeWebFetch } from '../../network/safe-web-fetch.js'

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
  if (web.fetchEnabled) {
    tools.push(createFetchTool(web, fetchProvider))
  }
  if (web.searchEnabled) {
    tools.push(createSearchTool(web, searchProvider))
  }
  const fetchAvailable = Boolean(web.fetchEnabled && fetchProvider.fetch)
  const searchAvailable = Boolean(web.searchEnabled && searchProvider.search)
  const reason = !tools.length
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

function createFetchTool(config: WebCapabilityConfig, provider: WebProvider) {
  return LocalToolHost.defineTool({
    name: 'web_fetch',
    description: 'Fetch an allowed HTTP or HTTPS URL and return extracted text with source metadata.',
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
      assertGrantAllowsNetwork(policy.url.href, context)
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
        const result = await provider.fetch({
          url: policy.url.href,
          maxBytes,
          timeoutMs,
          signal: context.abortSignal
          ,allowedOrigins: context.executionGrant?.networkAllowlist
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
    description: 'Search the web through the configured provider and return ranked results with source metadata.',
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
      const deepSeekResponses = provider.id === 'deepseek-responses'
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
          signal: context.abortSignal
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
  }): Promise<WebFetchResult> {
    const response = await safeWebFetch(request.url, {
      allowDomains: this.policy.allowDomains,
      allowedOrigins: request.allowedOrigins,
      denyDomains: this.policy.denyDomains,
      maxBytes: request.maxBytes,
      totalTimeoutMs: Math.min(request.timeoutMs, DEFAULT_WEB_TIMEOUT_MS)
    }, request.signal)
    const contentType = response.headers['content-type']
    const raw = response.body.toString('utf8')
    const extracted = extractReadableText(raw, contentType)
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
    url = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'URL must be absolute' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'only http and https URLs are allowed' }
  }
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

function extractReadableText(raw: string, contentType: string | undefined): { title?: string; text: string } {
  if (!contentType?.toLowerCase().includes('html')) {
    return { text: normalizeWhitespace(raw) }
  }
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const withoutScripts = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  const text = withoutScripts
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return {
    ...(title ? { title: normalizeWhitespace(decodeHtmlEntities(title)) } : {}),
    text: normalizeWhitespace(decodeHtmlEntities(text))
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
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
