import { safeWebFetch } from '../../network/safe-web-fetch.js'
import { parseYuanbaoSearchResults } from '../../network/web-html-content.js'
import type { WebProvider, WebSearchRequest, WebSearchResult } from '../../ports/web-provider.js'

const YUANBAO_ORIGIN = 'https://so.qq.com'
const MAX_QUERY_LENGTH = 512
const MAX_SEARCH_RESPONSE_BYTES = 3 * 1024 * 1024

export type YuanbaoSearchPageFetcher = typeof safeWebFetch

export class YuanbaoWebSearchProvider implements WebProvider {
  readonly id = 'yuanbao-opensearch'
  readonly searchOrigins = [YUANBAO_ORIGIN]

  constructor(private readonly options: {
    fetchPage?: YuanbaoSearchPageFetcher
    nowIso?: () => string
    denyDomains?: readonly string[]
  } = {}) {}

  async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    const query = request.query.trim()
    if (!query || query.length > MAX_QUERY_LENGTH) throw new Error('Search query must be between 1 and 512 characters.')
    if (request.allowedOrigins && !request.allowedOrigins.includes('*') && !request.allowedOrigins.includes(YUANBAO_ORIGIN)) {
      throw new Error('Yuanbao Search is outside the task network scope.')
    }
    if (this.options.denyDomains?.some(domain => matchesDomain('so.qq.com', domain))) {
      throw new Error('Yuanbao Search is blocked by the configured web domain policy.')
    }

    const url = new URL('/isearch', YUANBAO_ORIGIN)
    url.searchParams.set('query', query)
    const fetchPage = this.options.fetchPage ?? safeWebFetch
    const response = await fetchPage(url.href, {
      allowedOrigins: [YUANBAO_ORIGIN],
      denyDomains: this.options.denyDomains ? [...this.options.denyDomains] : undefined,
      maxBytes: MAX_SEARCH_RESPONSE_BYTES,
      maxRedirects: 2,
      totalTimeoutMs: request.timeoutMs
    }, request.signal)
    if (new URL(response.finalUrl).origin !== YUANBAO_ORIGIN) throw new Error('Yuanbao Search redirected outside its approved origin.')
    const contentType = response.headers['content-type'] ?? ''
    if (!contentType.toLowerCase().includes('html')) throw new Error('Yuanbao Search returned a non-HTML response.')
    const charset = contentType.match(/charset\s*=\s*["']?([a-zA-Z0-9_-]+)/i)?.[1] ?? 'utf-8'
    let html: string
    try { html = new TextDecoder(charset).decode(response.body) }
    catch { throw new Error('Yuanbao Search returned an unsupported character encoding.') }

    return parseYuanbaoSearchResults({
      html,
      query,
      limit: request.limit,
      retrievedAt: this.options.nowIso?.() ?? new Date().toISOString()
    })
  }
}

function matchesDomain(hostname: string, domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^\./, '')
  return Boolean(normalized) && (hostname === normalized || hostname.endsWith(`.${normalized}`))
}
