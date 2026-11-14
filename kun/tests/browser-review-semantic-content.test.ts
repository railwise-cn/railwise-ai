import { expect, it } from 'vitest'
import { browserReviewSemanticContent } from '../src/services/browser-operation-verification.js'

const observation = (ref = 1, value = '工程  测量') => `@vom 1\n@view 756x413\n@layers 1 focus=L1\nL1 page\n  RootWebArea "公开公告"\n    @e${ref} searchbox "关键词" value="${value}"\n    @e${ref + 1} checkbox "仅公告" [checked]\n    @e${ref + 2} link "查询"`
const html = (noise = 1, body = '查询结果：工程监测') => `<html><head><title>公开公告</title><style>.active { opacity: ${noise} }</style><script>window.nonce="${noise}"</script></head><body data-render="${noise}"><!-- nonce ${noise} --><section style="display:${noise === 1 ? 'block' : 'none'}"><p>轮播标题一</p><p>轮播标题二</p></section><p>${body}</p><input placeholder="关键词"></body></html>`

it('shows and compares complete DOM text and exact current controls, ignoring only nonsemantic markup and generated observation references', () => {
  const first = browserReviewSemanticContent(html(1), false, observation())
  const second = browserReviewSemanticContent(html(2), false, observation(91))
  expect(second).toEqual(first)
  expect(first.coverage.source).toBe('html_semantic_text')
  expect(first.text).toContain('轮播标题一 轮播标题二')
  expect(first.text).toContain('searchbox "关键词" value="工程  测量"')
  expect(first.text).toContain('checkbox "仅公告" [checked]')
  expect(first.text).not.toMatch(/window\.nonce|opacity|data-render|@e\d|@view|@layers/)
})

it.each(['result', 'paragraph', 'value', 'value-spaces', 'checked', 'empty', 'option'])('rejects a change to displayed %s semantics', change => {
  const before = browserReviewSemanticContent(html(), false, observation())
  const changedHtml = change === 'result' ? html(1, '查询结果：桥梁检查') : change === 'paragraph' ? html().replace('轮播标题一', '新的公告标题') : html()
  let changedObservation = change === 'value' ? observation(1, '桥梁检查') : change === 'value-spaces' ? observation(1, '工程 测量') : observation()
  if (change === 'checked') changedObservation = changedObservation.replace('[checked]', '[unchecked]')
  if (change === 'empty') changedObservation = changedObservation.replace('value="工程  测量"', '[empty]')
  if (change === 'option') changedObservation += '\n    @e8 combobox "分类"\n      @e9 option "工程" [selected]'
  expect(browserReviewSemanticContent(changedHtml, false, changedObservation)).not.toEqual(before)
})

it('excludes the undisplayed body tail while retaining visible controls beyond the summary budget', () => {
  const prefix = '公开结果 '.repeat(2500)
  const first = browserReviewSemanticContent(html(1, `${prefix}尾部一`), false, observation())
  const second = browserReviewSemanticContent(html(2, `${prefix}尾部二`), false, observation(21))
  expect(first).toEqual(second)
  expect(first.coverage.textTruncated).toBe(true)
  expect(first.text).not.toContain('尾部一')
  expect(first.text).toContain('value="工程  测量"')
  expect(browserReviewSemanticContent(html(2, `${prefix}尾部二`), false, observation(21, '不同输入'))).not.toEqual(first)
})

it('uses only normalized visible observation for truncated HTML and still rejects changed visible results', () => {
  const first = browserReviewSemanticContent('<script>incomplete-a', true, `${observation()}\n    paragraph "公告一"`)
  const second = browserReviewSemanticContent('<script>incomplete-b', true, `${observation(91)}\n    paragraph "公告一"`)
  expect(first).toEqual(second)
  expect(first.coverage.source).toBe('visible_observation')
  expect(first.text).not.toContain('incomplete-a')
  expect(browserReviewSemanticContent('<script>incomplete-b', true, `${observation(91)}\n    paragraph "公告二"`)).not.toEqual(first)
})

it('does not infer a live input value from an absent HTML value attribute and refuses absent or oversized control observations', () => {
  expect(browserReviewSemanticContent(html(), false, observation()).text).toContain('value="工程  测量"')
  expect(() => browserReviewSemanticContent(html(), false, '')).toThrow('browser_review_read_failed')
  expect(() => browserReviewSemanticContent(html(), true, '')).toThrow('browser_review_read_failed')
  expect(() => browserReviewSemanticContent(html(), false, observation(1, 'x'.repeat(12001)))).toThrow('browser_review_read_failed')
})

it('preserves whitespace, newlines, case and metadata-like text inside observed control values', () => {
  const value = 'A  B \n@view literal input\n C'
  const before = browserReviewSemanticContent(html(), false, observation(1, value))
  expect(before.text).toContain(`value="${value}"`)
  for (const changed of [value.replace('  ', ' '), value.replace(' \n', '\n'), value.replace('\n C', '\nC'), value.replace('A', 'a'), value.replace('\n', ' ')]) {
    expect(browserReviewSemanticContent(html(), false, observation(91, changed))).not.toEqual(before)
  }
})
