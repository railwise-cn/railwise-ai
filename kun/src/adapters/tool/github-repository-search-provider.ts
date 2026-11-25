import { safeWebFetch } from '../../network/safe-web-fetch.js'
import type { WebProvider, WebSearchRequest, WebSearchResult } from '../../ports/web-provider.js'
import { sourceIdFor } from '../../ports/web-provider.js'

const GITHUB_API_ORIGIN = 'https://api.github.com'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

type RepositoryRecord = {
  full_name?: unknown
  html_url?: unknown
  description?: unknown
  language?: unknown
  stargazers_count?: unknown
  updated_at?: unknown
  private?: unknown
  license?: { spdx_id?: unknown } | null
}

export type GithubRepositorySearchFetcher = typeof safeWebFetch

export class GithubRepositorySearchProvider implements WebProvider {
  readonly id = 'github-repository-search'
  readonly searchOrigins = [GITHUB_API_ORIGIN]

  constructor(private readonly options: {
    fetchPage?: GithubRepositorySearchFetcher
    nowIso?: () => string
  } = {}) {}

  supportsQuery(query: string): boolean {
    return Boolean(repositoryReference(query)) || /\bgithub(?:\.com)?\b|\brepositories?\b|\brepos?\b|仓库|开源项目/i.test(query)
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    const query = request.query.trim()
    if (!query || query.length > 512) throw new Error('Search query must be between 1 and 512 characters.')
    if (request.allowedOrigins && !request.allowedOrigins.includes('*') &&
      !request.allowedOrigins.includes(GITHUB_API_ORIGIN)) {
      throw new Error('GitHub repository search is outside the task network scope.')
    }
    if (request.denyDomains?.some(domain => matchesDomain('api.github.com', domain))) {
      throw new Error('GitHub repository search is blocked by the configured web domain policy.')
    }

    const reference = repositoryReference(query)
    const url = new URL(reference
      ? `/repos/${encodeURIComponent(reference.owner)}/${encodeURIComponent(reference.repo)}`
      : '/search/repositories', GITHUB_API_ORIGIN)
    if (!reference) {
      const searchTerms = query
        .replace(/https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+/gi, ' ')
        .replace(/\bgithub(?:\.com)?\b|\brepositories?\b|\brepos?\b|仓库|开源项目/gi, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
      url.searchParams.set('q', searchTerms || query)
      url.searchParams.set('sort', 'stars')
      url.searchParams.set('order', 'desc')
      url.searchParams.set('per_page', String(Math.min(Math.max(Math.floor(request.limit), 1), 10)))
    }

    const fetchPage = this.options.fetchPage ?? safeWebFetch
    const response = await fetchPage(url.href, {
      allowedOrigins: [GITHUB_API_ORIGIN],
      denyDomains: request.denyDomains ? [...request.denyDomains] : undefined,
      maxBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 1,
      totalTimeoutMs: request.timeoutMs
    }, request.signal)
    if (new URL(response.finalUrl).origin !== GITHUB_API_ORIGIN) throw new Error('GitHub API redirected outside its approved origin.')
    if (response.status !== 200) throw new Error(`GitHub repository search returned HTTP ${response.status}.`)
    if (!(response.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
      throw new Error('GitHub repository search returned a non-JSON response.')
    }

    let payload: unknown
    try { payload = JSON.parse(response.body.toString('utf8')) }
    catch { throw new Error('GitHub repository search returned invalid JSON.') }
    const repositoryResponse = recordValue(payload)
    const records: RepositoryRecord[] = reference
      ? [repositoryResponse as RepositoryRecord]
      : Array.isArray(repositoryResponse.items) ? repositoryResponse.items as RepositoryRecord[] : []
    const retrievedAt = this.options.nowIso?.() ?? new Date().toISOString()
    const results: WebSearchResult[] = []
    for (const record of records) {
      if (!record || typeof record !== 'object' || record.private === true) continue
      const fullName = typeof record.full_name === 'string' ? record.full_name.trim() : ''
      const url = canonicalRepositoryUrl(record.html_url)
      if (!fullName || !url) continue
      const rank = results.length + 1
      const description = typeof record.description === 'string' ? record.description.trim() : ''
      const language = typeof record.language === 'string' ? record.language.trim() : ''
      const stars = typeof record.stargazers_count === 'number' && Number.isFinite(record.stargazers_count)
        ? `${record.stargazers_count.toLocaleString('en-US')} stars`
        : ''
      const license = record.license && typeof record.license.spdx_id === 'string' && record.license.spdx_id !== 'NOASSERTION'
        ? `${record.license.spdx_id} license`
        : 'license not identified by GitHub'
      const updatedAt = typeof record.updated_at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(record.updated_at)
        ? `updated ${record.updated_at.slice(0, 10)}`
        : ''
      const snippet = [description, language, stars, license, updatedAt].filter(Boolean).join(' | ') || fullName
      results.push({
        sourceId: sourceIdFor('search', `${query}:${url}:${rank}`),
        url,
        title: fullName,
        snippet: snippet.slice(0, 1_600),
        retrievedAt,
        provider: this.id,
        rank
      })
      if (results.length >= request.limit) break
    }
    return results
  }
}

function repositoryReference(query: string): { owner: string; repo: string } | undefined {
  const match = query.match(/(?:https?:\/\/(?:www\.)?github\.com\/)?([a-z\d](?:[a-z\d-]{0,38})?)\/([a-z\d._-]{1,100})(?:\.git)?(?=$|[/?#\s])/i)
  if (!match) return undefined
  const repo = match[2]!.replace(/\.git$/i, '')
  return repo ? { owner: match[1]!, repo } : undefined
}

function canonicalRepositoryUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password) return undefined
    const segments = url.pathname.split('/').filter(Boolean)
    if (segments.length !== 2 || segments.some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment))) return undefined
    return `https://github.com/${segments[0]}/${segments[1]}`
  } catch {
    return undefined
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function matchesDomain(hostname: string, domain: string): boolean {
  const normalized = domain.trim().toLowerCase().replace(/^\./, '')
  return Boolean(normalized) && (hostname === normalized || hostname.endsWith(`.${normalized}`))
}
