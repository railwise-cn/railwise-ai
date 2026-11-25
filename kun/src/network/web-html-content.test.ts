import { describe, expect, it } from 'vitest'
import { extractReadableHtml, parseYuanbaoSearchResults } from './web-html-content.js'

describe('HTML source extraction', () => {
  it('keeps article text and links while excluding navigation, hidden content and scripts', () => {
    const result = extractReadableHtml(`<!doctype html><title>Source &amp; Title</title><body>
      <nav>Unrelated navigation</nav>
      <main><article><h1>Official notice</h1><p>Budget is 100,000 yuan. <a href="/notice/1">Read the notice</a>.</p>
      <div hidden>hidden claim</div><script>untrusted shell text</script></article></main>
      <footer>Footer links</footer>
    </body>`, 'https://example.test/list')
    expect(result).toEqual({
      title: 'Source & Title',
      text: 'Official notice\n\nBudget is 100,000 yuan. [Read the notice](https://example.test/notice/1).'
    })
  })

  it('extracts structured Yuanbao search cards with verified result hrefs', () => {
    const results = parseYuanbaoSearchResults({
      query: 'RailWise AI',
      limit: 5,
      retrievedAt: '2026-11-24T00:00:00.000Z',
      html: `<html><body>
        <article class="result-card"><a data-log='{"linkid":"title"}' href="https://docs.example.test/page">Official title</a>
          <a data-log='{"linkid":"summary"}' href="https://docs.example.test/page">Page summary and useful facts.</a></article>
        <article class="result-card"><a class="text-yb-h2" href="https://other.example/news">Other result</a></article>
        <article class="result-card"><a class="text-yb-h2" href="javascript:alert(1)">Unsafe</a></article>
      </body></html>`
    })
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      url: 'https://docs.example.test/page', title: 'Official title', snippet: 'Page summary and useful facts.',
      provider: 'yuanbao-opensearch', rank: 1, retrievedAt: '2026-11-24T00:00:00.000Z'
    })
    expect(results[1]?.url).toBe('https://other.example/news')
  })

  it('rejects unknown Yuanbao result markup and recognizes explicit no-result pages', () => {
    expect(() => parseYuanbaoSearchResults({ html: '<main><h1>Sign in</h1></main>', query: 'test', limit: 5, retrievedAt: 'now' }))
      .toThrow('unrecognized result page')
    expect(parseYuanbaoSearchResults({ html: '<main>未找到相关结果</main>', query: 'test', limit: 5, retrievedAt: 'now' })).toEqual([])
  })

  it('prefers readable article content over a larger navigation shell', () => {
    const result = extractReadableHtml(`<!doctype html><body><header>${'Navigation '.repeat(80)}</header>
      <article><h1>Notice</h1><p>${'Verified project text. '.repeat(14)}</p></article></body>`, 'https://example.test')
    expect(result.text).toContain('Verified project text.')
    expect(result.text).not.toContain('Navigation')
  })
})
