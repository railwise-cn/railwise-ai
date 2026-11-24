export type WebSource = {
  sourceId: string
  url: string
  title?: string
  retrievedAt: string
}

export type WebFetchRequest = {
  url: string
  maxBytes: number
  timeoutMs: number
  signal: AbortSignal
  allowedOrigins?: string[]
  allowedUrls?: string[]
}

export type WebFetchResult = WebSource & {
  finalUrl: string
  contentType?: string
  text: string
  byteCount: number
  truncated: boolean
}

export type WebSearchRequest = {
  query: string
  limit: number
  timeoutMs: number
  signal: AbortSignal
  allowedOrigins?: string[]
  denyDomains?: readonly string[]
}

export type WebSearchResult = WebSource & {
  snippet: string
  provider: string
  rank: number
}

export interface WebProvider {
  readonly id: string
  /** Exact network origins contacted to perform search, separate from result URLs. */
  readonly searchOrigins?: readonly string[]
  fetch?(request: WebFetchRequest): Promise<WebFetchResult>
  search?(request: WebSearchRequest): Promise<WebSearchResult[]>
  supportsQuery?(query: string): boolean
  canSearchWithin?(allowedOrigins?: readonly string[], denyDomains?: readonly string[]): boolean
}

/** Search sources run in order until one returns usable results. */
export class FallbackWebSearchProvider implements WebProvider {
  readonly id: string
  readonly searchOrigins: readonly string[]

  constructor(private readonly providers: readonly WebProvider[]) {
    this.id = providers.map(provider => provider.id).join('+') || 'unavailable'
    this.searchOrigins = [...new Set(providers.flatMap(provider => provider.searchOrigins ?? []))]
  }

  canSearchWithin(allowedOrigins?: readonly string[], denyDomains?: readonly string[]): boolean {
    return this.providers.some(provider => provider.search && providerAllowedByOrigins(provider, allowedOrigins) &&
      !providerDeniedByDomains(provider, denyDomains))
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    if (request.signal.aborted) throw request.signal.reason ?? new Error('Web search was cancelled.')
    let lastError: unknown
    const matchingProviders = this.providers.filter(provider => provider.supportsQuery?.(request.query))
    const orderedProviders = matchingProviders.length
      ? [...matchingProviders, ...this.providers.filter(provider => !matchingProviders.includes(provider))]
      : this.providers
    const providers = orderedProviders.filter((provider): provider is WebProvider & { search: NonNullable<WebProvider['search']> } =>
      Boolean(provider.search) && providerAllowedByOrigins(provider, request.allowedOrigins) &&
      !providerDeniedByDomains(provider, request.denyDomains))
    if (providers.length === 0) throw new Error('No web search provider is within the task network scope.')
    const deadline = Date.now() + Math.max(1, request.timeoutMs)
    for (let index = 0; index < providers.length; index += 1) {
      if (request.signal.aborted) throw request.signal.reason ?? new Error('Web search was cancelled.')
      const provider = providers[index]!
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) break
      const providersRemaining = providers.length - index
      const providerTimeoutMs = Math.max(1, Math.floor(remainingMs / providersRemaining))
      const controller = new AbortController()
      const abortFromRequest = (): void => controller.abort(request.signal.reason)
      request.signal.addEventListener('abort', abortFromRequest, { once: true })
      const timeout = setTimeout(() => controller.abort(new Error('Web search provider timed out.')), providerTimeoutMs)
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason ?? new Error('Web search provider aborted.')), { once: true })
      })
      try {
        const results = await Promise.race([
          provider.search({ ...request, timeoutMs: providerTimeoutMs, signal: controller.signal }),
          aborted
        ])
        if (results.length) return results.slice(0, request.limit)
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason ?? error
        lastError = error
      } finally {
        clearTimeout(timeout)
        request.signal.removeEventListener('abort', abortFromRequest)
      }
    }
    if (lastError) throw lastError
    return []
  }
}

function providerAllowedByOrigins(provider: WebProvider, allowedOrigins?: readonly string[]): boolean {
  if (!allowedOrigins || allowedOrigins.includes('*')) return true
  const requiredOrigins = provider.searchOrigins
  return Boolean(requiredOrigins?.length && requiredOrigins.every(origin => allowedOrigins.includes(origin)))
}

function providerDeniedByDomains(provider: WebProvider, denyDomains?: readonly string[]): boolean {
  return Boolean(denyDomains?.length && (provider.searchOrigins ?? []).some(origin => {
    const hostname = new URL(origin).hostname.toLowerCase()
    return denyDomains.some(domain => {
      const normalized = domain.trim().toLowerCase().replace(/^\./, '')
      return Boolean(normalized) && (hostname === normalized || hostname.endsWith(`.${normalized}`))
    })
  }))
}

export class UnavailableWebProvider implements WebProvider {
  readonly id: string
  readonly searchOrigins: readonly string[] = []

  constructor(id = 'unavailable') {
    this.id = id
  }
}

export class DeterministicWebProvider implements WebProvider {
  readonly id: string
  private readonly pages: Map<string, Omit<WebFetchResult, 'sourceId' | 'retrievedAt' | 'byteCount' | 'truncated'>>
  private readonly searchResults: Map<string, Array<Omit<WebSearchResult, 'sourceId' | 'retrievedAt' | 'provider' | 'rank'>>>
  private readonly nowIso: () => string

  constructor(input: {
    id?: string
    nowIso?: () => string
    pages?: Record<string, Omit<WebFetchResult, 'sourceId' | 'retrievedAt' | 'byteCount' | 'truncated'>>
    searchResults?: Record<string, Array<Omit<WebSearchResult, 'sourceId' | 'retrievedAt' | 'provider' | 'rank'>>>
  } = {}) {
    this.id = input.id ?? 'deterministic'
    this.nowIso = input.nowIso ?? (() => new Date().toISOString())
    this.pages = new Map(Object.entries(input.pages ?? {}))
    this.searchResults = new Map(Object.entries(input.searchResults ?? {}))
  }

  async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
    const page = this.pages.get(request.url)
    if (!page) throw new Error(`test web page not found: ${request.url}`)
    const bytes = Buffer.byteLength(page.text, 'utf8')
    if (bytes > request.maxBytes) {
      throw new Error(`content exceeds ${request.maxBytes} byte limit`)
    }
    return {
      ...page,
      url: page.url,
      finalUrl: page.finalUrl,
      sourceId: sourceIdFor('fetch', page.finalUrl),
      retrievedAt: this.nowIso(),
      byteCount: bytes,
      truncated: false
    }
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    return (this.searchResults.get(request.query) ?? [])
      .slice(0, request.limit)
      .map((result, index) => ({
        ...result,
        sourceId: sourceIdFor('search', `${request.query}:${result.url}:${index}`),
        retrievedAt: this.nowIso(),
        provider: this.id,
        rank: index + 1
      }))
  }
}

export function sourceIdFor(kind: 'fetch' | 'search', value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0
  }
  return `web_${kind}_${Math.abs(hash).toString(36)}`
}
