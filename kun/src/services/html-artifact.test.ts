import { describe, expect, it } from 'vitest'
import { prepareHtmlArtifact } from './html-artifact.js'

describe('offline HTML report presentation', () => {
  it('keeps Chinese content and source links while supplying responsive and print styling', () => {
    const body = '<h1>工程监测招标简报</h1><a href="https://example.com/notice">公告原文</a><p>截止日期待核验</p>'
    const html = prepareHtmlArtifact(body)
    expect(html).toContain(body)
    expect(html).toContain('charset="utf-8"')
    expect(html).toContain('data-railwise-report')
    expect(html).toContain('@media print')
    expect(html).toContain('@media(max-width:720px)')
    expect(html).not.toMatch(/https?:\/\/[^"<>]*\.(?:css|js)/)
    expect(prepareHtmlArtifact(html)).toBe(html)
  })
  it('preserves authored HTML and stylesheet bytes', () => {
    const html = '<!doctype html><html><head><style>body{color:navy}</style></head><body>正文</body></html>'
    expect(prepareHtmlArtifact(html)).toBe(html)
  })
})
