import { describe, expect, it, vi } from 'vitest'
import type { SafeWebFetchResult } from '../../network/safe-web-fetch.js'
import { YuanbaoWebSearchProvider } from './yuanbao-web-search-provider.js'
import { GithubRepositorySearchProvider } from './github-repository-search-provider.js'

function response(html: string, finalUrl = 'https://so.qq.com/isearch?query=RailWise') : SafeWebFetchResult {
  return { finalUrl, status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html), redirects: 0 }
}

const resultPage = `<article class="result-card">
  <a data-log='{"linkid":"title"}' href="https://docs.example.test/source">Source page</a>
  <a data-log='{"linkid":"summary"}' href="https://docs.example.test/source">A result summary with actual source content.</a>
</article>`

describe('Yuanbao OpenSearch provider', () => {
  it('fetches only the published OpenSearch endpoint and returns structured sources', async () => {
    const fetchPage = vi.fn(async () => response(resultPage))
    const provider = new YuanbaoWebSearchProvider({ fetchPage: fetchPage as never, nowIso: () => '2026-11-24T00:00:00.000Z' })
    const results = await provider.search({ query: 'RailWise', limit: 5, timeoutMs: 10_000, signal: new AbortController().signal,
      allowedOrigins: ['https://so.qq.com'] })
    expect(fetchPage).toHaveBeenCalledWith('https://so.qq.com/isearch?query=RailWise', expect.objectContaining({
      allowedOrigins: ['https://so.qq.com'], maxRedirects: 2
    }), expect.any(AbortSignal))
    expect(results).toMatchObject([{ url: 'https://docs.example.test/source', title: 'Source page', provider: 'yuanbao-opensearch', rank: 1 }])
  })

  it('does not apply result-site allowlists to the search service endpoint', async () => {
    const fetchPage = vi.fn(async () => response(resultPage))
    const provider = new YuanbaoWebSearchProvider({ fetchPage: fetchPage as never })
    const results = await provider.search({ query: 'RailWise', limit: 5, timeoutMs: 10_000,
      signal: new AbortController().signal, allowedOrigins: ['https://so.qq.com'] })
    expect(results).toHaveLength(1)
    expect(fetchPage).toHaveBeenCalledOnce()
  })

  it('refuses an unapproved network origin, configured deny rule, or foreign redirect', async () => {
    const fetchPage = vi.fn(async () => response(resultPage, 'https://outside.example/search'))
    const provider = new YuanbaoWebSearchProvider({ fetchPage: fetchPage as never, denyDomains: ['qq.com'] })
    await expect(provider.search({ query: 'x', limit: 3, timeoutMs: 1_000, signal: new AbortController().signal,
      allowedOrigins: ['https://so.qq.com'] })).rejects.toThrow('blocked by the configured web domain policy')
    expect(fetchPage).not.toHaveBeenCalled()

    const allowed = new YuanbaoWebSearchProvider({ fetchPage: fetchPage as never })
    await expect(allowed.search({ query: 'x', limit: 3, timeoutMs: 1_000, signal: new AbortController().signal,
      allowedOrigins: ['https://so.qq.com'] })).rejects.toThrow('redirected outside its approved origin')
    await expect(allowed.search({ query: 'x', limit: 3, timeoutMs: 1_000, signal: new AbortController().signal,
      allowedOrigins: ['https://different.example'] })).rejects.toThrow('outside the task network scope')
  })

  it('rejects empty and oversized queries before networking', async () => {
    const fetchPage = vi.fn()
    const provider = new YuanbaoWebSearchProvider({ fetchPage: fetchPage as never })
    for (const query of ['', 'x'.repeat(513)]) {
      await expect(provider.search({ query, limit: 5, timeoutMs: 1_000, signal: new AbortController().signal })).rejects.toThrow('Search query')
    }
    expect(fetchPage).not.toHaveBeenCalled()
  })
})

describe('GitHub repository search provider', () => {
  const repository = {
    full_name: 'SID1ART/agentfetch',
    html_url: 'https://github.com/SID1ART/agentfetch',
    description: 'Open-source web retrieval and research agent.',
    language: 'Python',
    stargazers_count: 2,
    updated_at: '2026-10-19T08:41:42Z',
    private: false,
    license: null
  }

  it('only takes priority for explicit repository-oriented queries', () => {
    const provider = new GithubRepositorySearchProvider()
    expect(provider.supportsQuery('Search GitHub for agentfetch')).toBe(true)
    expect(provider.supportsQuery('Find open source projects for agent workflows')).toBe(false)
    expect(provider.supportsQuery('今日天气预报')).toBe(false)
  })

  it('looks up an exact public repository and marks missing license metadata as unverified', async () => {
    const fetchPage = vi.fn(async () => ({
      finalUrl: 'https://api.github.com/repos/SID1ART/agentfetch', status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: Buffer.from(JSON.stringify(repository)), redirects: 0
    }))
    const provider = new GithubRepositorySearchProvider({ fetchPage: fetchPage as never,
      nowIso: () => '2026-11-25T00:00:00.000Z' })
    const results = await provider.search({ query: 'SID1ART/agentfetch on GitHub', limit: 5, timeoutMs: 10_000,
      signal: new AbortController().signal, allowedOrigins: ['https://api.github.com'] })

    expect(fetchPage).toHaveBeenCalledWith('https://api.github.com/repos/SID1ART/agentfetch', expect.objectContaining({
      allowedOrigins: ['https://api.github.com']
    }), expect.any(AbortSignal))
    expect(results).toMatchObject([{
      title: 'SID1ART/agentfetch', url: 'https://github.com/SID1ART/agentfetch', provider: 'github-repository-search', rank: 1,
      snippet: expect.stringContaining('license not identified by GitHub')
    }])
  })

  it('does not query GitHub unless its API origin is in task scope', async () => {
    const fetchPage = vi.fn()
    const provider = new GithubRepositorySearchProvider({ fetchPage: fetchPage as never })
    await expect(provider.search({ query: 'SID1ART/agentfetch', limit: 5, timeoutMs: 10_000,
      signal: new AbortController().signal, allowedOrigins: ['https://so.qq.com'] })).rejects.toThrow('outside the task network scope')
    expect(fetchPage).not.toHaveBeenCalled()
  })
})
