import { expect, it } from 'vitest'
import { classifyPublicQueryAction, type PublicQueryDomContext } from './browser-public-query-rules.js'

const context: PublicQueryDomContext = { search: true, pagination: false, filter: false, sort: false, sensitive: false, targetPresent: true }
const classify = (html: string, action: 'fill' | 'click' = 'click', patch: Partial<PublicQueryDomContext> = {}, value = '工程监测') =>
  classifyPublicQueryAction({ html, action, value, pageUrl: 'https://public.example/search', context: { ...context, ...patch } })

it.each([
  ['<input type="search" placeholder="输入关键字，搜索公告或新闻">', 'fill', 'search_input'],
  ['<input id="title" type="text">', 'fill', 'search_input'],
  ['<a class="search_btn">搜 索</a>', 'click', 'search_trigger'],
  ['<div role="button"><svg aria-hidden="true"></svg><span>搜 标 题</span></div>', 'click', 'search_trigger'],
  ['<div class="query-button">搜全文</div>', 'click', 'search_trigger'],
  ['<button aria-label="搜索"><svg></svg></button>', 'click', 'search_trigger'],
] as const)('recognizes a bounded public query control from actual DOM: %s', (html, action, rule) => {
  expect(classify(html, action)).toBe(rule)
})

it('requires the positive container for generic title/div controls', () => {
  expect(classify('<input id="title">', 'fill', { search: false })).toBeUndefined()
  expect(classify('<div>搜标题</div>', 'click', { search: false })).toBeUndefined()
  expect(classify('<div>随便继续</div>')).toBeUndefined()
  expect(classify('<input name="researcher">', 'fill')).toBeUndefined()
  expect(classify('<div>近3日</div>', 'click', { filter: true })).toBe('filter_control')
  expect(classify('<div>按时间降序</div>', 'click', { sort: true })).toBe('sort_control')
  expect(classify('<input placeholder="开始日期">', 'fill', { filter: true })).toBe('filter_control')
})

it('allows pagination, filter and sorting only with their actual structural scope', () => {
  expect(classify('<a href="/search?page=2">下一页</a>')).toBe('pagination')
  expect(classify('<div>下一页</div>', 'click', { pagination: true })).toBe('pagination')
  expect(classify('<button>下一步</button>', 'click', { pagination: true })).toBeUndefined()
  expect(classify('<div role="option">公告类型</div>', 'click', { filter: true })).toBe('filter_control')
  expect(classify('<div>发布时间排序</div>', 'click', { sort: true })).toBe('sort_control')
  expect(classify('<select name="sort"><option value="asc">时间升序</option><option value="desc">时间降序</option></select>', 'fill', { sort: true }, 'desc')).toBe('sort_control')
  expect(classify('<select name="sort"><option value="asc">升序</option></select>', 'fill', { sort: true }, 'invented')).toBeUndefined()
})

it.each([
  '<input type="password" name="keyword">', '<input type="hidden" name="query">', '<input type="file">',
  '<button>提交搜索</button>', '<button>保存</button>', '<button aria-label="登录">搜索</button>',
  '<a href="https://other.example/search">搜索</a>', '<a href="javascript:send()" class="search_btn">搜索</a>',
  '<a href="/account/delete" class="search_btn">搜索</a>', '<button disabled>搜索</button>', '<div role="button">发布公告</div>'
])('never turns a business/account/unknown target into scope authority: %s', html => {
  expect(classify(html, html.startsWith('<input') ? 'fill' : 'click')).toBeUndefined()
})

it('does not allow a sensitive container, malformed page or oversized target', () => {
  expect(classify('<input type="search">', 'fill', { sensitive: true })).toBeUndefined()
  expect(classifyPublicQueryAction({ action: 'fill', html: '<input type="search">', value: 'x', pageUrl: 'https://public.example/?token=private', context })).toBeUndefined()
  expect(classify('<button>' + 'x'.repeat(8192) + '</button>')).toBeUndefined()
})

it.each(['今日', '近3日', '近1月', '近3月', '近半年', '近一年', '全部'])('recognizes %s only as the proved native date component after common guards', label => {
  expect(classify(`<div class="level-content-timeItem active">${label}</div>`, 'click', { filter: true, dateFacet: true })).toBe('filter_control')
  expect(classify(`<div class="level-content-timeItem active">${label}</div>`, 'click', { filter: true, dateFacet: true, sensitive: true })).toBeUndefined()
})

it.each([
  '<div class="level-content-timeItem">任意时间</div>', '<div class="level-content-timeItem">提交审批</div>',
  '<div class="other">今日</div>', '<span class="level-content-timeItem">今日</span>',
  '<div class="level-content-timeItem" disabled>今日</div>', '<div class="level-content-timeItem" aria-disabled="true">今日</div>',
  '<div class="level-content-timeItem" form="account">今日</div>', '<div class="level-content-timeItem" formmethod="post">今日</div>',
  '<div class="level-content-timeItem" formaction="https://outside.example/search">今日</div>',
  '<div class="level-content-timeItem" href="/account/delete">今日</div>'
])('does not let the host date marker bypass component or universal safety guards: %s', html => {
  expect(classify(html, 'click', { filter: true, dateFacet: true })).toBeUndefined()
})

it('does not infer the host-only complete date proof from text, class or page claims', () => {
  const html = '<div class="level-content-timeItem">今日</div>'
  expect(classify(html, 'click', { filter: true })).toBeUndefined()
  expect(classify(html, 'click', { dateFacet: true, filter: false })).toBeUndefined()
  expect(classify(html, 'click', { dateFacet: true, filter: true, targetPresent: false })).toBeUndefined()
  expect(classify('<div class="level-content-timeItem" data-date-facet="true">今日</div>', 'click', { filter: true })).toBeUndefined()
})
