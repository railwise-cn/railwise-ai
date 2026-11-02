import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { resolveWriteMarkdownResource, resolveWriteMarkdownResourcePath } from './write-markdown-resource'

const document = '/tmp/workspace/docs/报告.md'

describe('Markdown local resource URL decoding', () => {
  it.each([
    ['../assets/监测 图.png', '/tmp/workspace/assets/监测 图.png'],
    ['../assets/%E7%9B%91%E6%B5%8B%20%E5%9B%BE.png', '/tmp/workspace/assets/监测 图.png'],
    ['../assets/literal%2541.png', '/tmp/workspace/assets/literal%41.png'],
    ['../assets/100%25.png', '/tmp/workspace/assets/100%.png'],
    ['../assets/space%20%23%3F.png', '/tmp/workspace/assets/space #?.png'],
    ['../assets/literal%252F.png', '/tmp/workspace/assets/literal%2F.png']
  ])('decodes %s exactly once and re-encodes its file URL', (src, path) => {
    expect(resolveWriteMarkdownResourcePath(src, document)).toBe(path)
    expect(fileURLToPath(resolveWriteMarkdownResource(src, document)!)).toBe(path)
  })

  it.each([
    '../assets/bad%.png', '../assets/bad%E7.png', '../assets/a%00.png',
    '../assets/a%0a.png', '../assets/a%5c.png', '../assets/a%2f.png',
    '../assets/a\\b.png', '//server/image.png', '%2F%2Fserver/image.png',
    '%68ttps%3Aexample.png', 'file:///tmp/image.png', '../assets/image.png?size=2',
    '../assets/image.png#fragment', '../assets/a\u0000.png'
  ])('does not resolve malformed or ambiguous local resource %s', (src) => {
    expect(resolveWriteMarkdownResourcePath(src, document)).toBeUndefined()
  })

  it('continues resolving Windows document directories without changing source URL semantics', () => {
    expect(resolveWriteMarkdownResourcePath('../assets/%E5%9B%BE%20a.png', 'C:\\workspace\\docs\\报告.md'))
      .toBe('C:/workspace/assets/图 a.png')
  })
})
