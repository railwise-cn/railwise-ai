import { createHash } from 'node:crypto'
import { browserPublicQueryTargetBlocked } from './browser-approval-summary.js'
import type { PublicQueryActionRule } from '../services/browser-public-query-authority.js'

export type PublicQueryDomContext = { search: boolean; pagination: boolean; filter: boolean; sort: boolean; sensitive: boolean; targetPresent: boolean;
  /** Host-only proof of the complete native date group, canonical target, frame and safe parent. */
  dateFacet?: boolean
  /** Exact native anchor proof. The model and page text cannot supply this marker. */
  documentLink?: { hrefHash: string; destinationHash: string; canonicalTarget?: string; frameHash?: string } }
const decode = (s: string) => s.replace(/&#(x[0-9a-f]+|\d+);/gi, (_m, n: string) => { const cp = Number.parseInt(n[0].toLowerCase() === 'x' ? n.slice(1) : n, n[0].toLowerCase() === 'x' ? 16 : 10); return cp <= 0x10ffff ? String.fromCodePoint(cp) : '' }).replace(/&(?:nbsp|amp|quot|apos|lt|gt);/gi, x => ({ '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' })[x.toLowerCase()] ?? '')
export function publicQueryElement(html: string) {
  const open = /^\s*<([a-z][\w:-]*)\b([^>]*)>/i.exec(html)
  if (!open) return undefined
  const attributes: Record<string, string> = {}
  for (const m of open[2].matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attributes[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '')
  const text = decode(html.replace(/<!--[^]*?-->|<(?:script|style)\b[^]*?<\/(?:script|style)>/gi, ' ').replace(/<[^>]*>/g, ' '))
  const label = `${attributes['aria-label'] ?? ''} ${attributes.title ?? ''} ${text}`.replace(/\s+/g, '').toLowerCase()
  return { tag: open[1].toLowerCase(), attributes, label }
}
const search = /^(?:(?:搜[索尋]|搜标题|搜全文|查询|检索)(?:(?:公开|合成)?(?:公告|新闻|信息|结果))?|search|searchannouncements|find)$/i
export const publicSearchLabel = (value: string) => search.test(value.replace(/\s+/g, '').toLowerCase())
const searchField = /关键[字词]|搜索|检索|查询|(?:^|[\s_-])(?:q|search(?:box|text|word|key|input)?|query(?:text|word|input)?|keyword(?:s|input)?|key_word)(?=$|[\s_-])/i
const filter = /(?:filter|category|筛选|分类|公告类型|项目类型|地区|区域|时间范围|日期范围|开始日期|起始日期|截止日期|结束日期|近[0-9一二三七]+[日天]|最近[0-9一二三七]+[日天])/i
const sort = /(?:sort|orderBy|排序|发布日期|发布时间|按时间|升序|降序|最新|最早)/i
const pageLabel = /^(?:下一页|上一页|首页|末页|尾页|next(?:page)?|previous(?:page)?|prev|first|last|[1-9]\d{0,3})$/i
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** A document GET, never a DOM click or a download. Dynamic HTML routes are valid. */
export function publicDocumentLinkDestination(html: string, pageUrl: string): string | undefined {
  const element = publicQueryElement(html)
  if (!element || element.tag !== 'a' || !element.attributes.href || html.length > 8192) return undefined
  const a = element.attributes
  if ('download' in a || 'disabled' in a || a['aria-disabled'] === 'true' || a.role && a.role !== 'link' ||
    a.target && !['_self', '_blank'].includes(a.target) || Object.keys(a).some(key => key.startsWith('on') || key.startsWith('form')) ||
    a.type && !['text/html', 'application/xhtml+xml'].includes(a.type.toLowerCase()) || /<(?:input|textarea|select|button|form|iframe|object|embed)\b/i.test(html)) return undefined
  if (browserPublicQueryTargetBlocked(`<a aria-label="${a['aria-label'] ?? ''}" title="${a.title ?? ''}"></a>`)) return undefined
  if (!a.href.trim() || a.href.length > 4096 || [...a.href].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return undefined
  try {
    const page = new URL(pageUrl), url = new URL(a.href, page)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== page.origin || url.username || url.password) return undefined
    const route = decodeURIComponent(url.pathname + (/^#!?\//.test(url.hash) ? url.hash : ''))
    if (/(?:account|profile|auth|oauth|login|register|logout|delete|remove|submit|upload|download|attachment|payment|purchase|checkout|approve|reject|transfer|send|save)/i.test(route)) return undefined
    if ([...url.searchParams.keys()].some(key => /(?:token|secret|password|authorization|session|oauth|download|attachment|action|method|command|operation|redirect|returnurl|callback|nexturl)/i.test(key) || /^(?:op|cmd)$/i.test(key))) return undefined
    const extension = /\.([a-z0-9]{1,8})$/i.exec(url.pathname)?.[1].toLowerCase()
    if (extension && !['html', 'htm', 'xhtml', 'php', 'aspx', 'asp', 'jsp', 'do', 'action'].includes(extension)) return undefined
    const ordinaryAnchor = url.origin === page.origin && url.pathname === page.pathname && url.search === page.search && !/^#!?\//.test(url.hash)
    if (url.href === page.href || ordinaryAnchor) return undefined
    return url.href
  } catch { return undefined }
}

/** Positive structural rules. A page's claims about safety never grant permission. */
export function classifyPublicQueryAction(input: { action: 'click' | 'fill'; html: string; value?: string; pageUrl: string;
  context?: PublicQueryDomContext; priorSearchInput?: boolean }): PublicQueryActionRule | undefined {
  try { const page = new URL(input.pageUrl); if (!['https:', 'http:'].includes(page.protocol) || page.username || page.password || [...page.searchParams.keys()].some(key => /token|secret|password|authorization|session|oauth/i.test(key))) return undefined } catch { return undefined }
  if (!input.html.trim() || input.html.length > 8192) return undefined
  const documentLink = input.context?.targetPresent && !input.context.sensitive && input.context.documentLink
  const destination = documentLink && input.action === 'click' && publicDocumentLinkDestination(input.html, input.pageUrl)
  if (destination && documentLink && documentLink.destinationHash === digest(destination) &&
    documentLink.hrefHash === digest(publicQueryElement(input.html)!.attributes.href)) return 'result_link'
  if (browserPublicQueryTargetBlocked(input.html)) return undefined
  const element = publicQueryElement(input.html)
  if (!element || 'disabled' in element.attributes || element.attributes['aria-disabled'] === 'true' || input.context?.sensitive) return undefined
  const { tag, attributes: a, label } = element, type = (a.type ?? 'text').toLowerCase()
  if (a.href) { try { const link = new URL(a.href, input.pageUrl); if (!['https:', 'http:'].includes(link.protocol) || link.origin !== new URL(input.pageUrl).origin || link.username || link.password || /(?:delete|remove|submit|account|login|payment|upload|approve)/i.test(link.pathname)) return undefined } catch { return undefined } }
  if ('form' in a || a.formmethod !== undefined && a.formmethod.trim().toLowerCase() !== 'get' || a.formtarget && a.formtarget !== '_self') return undefined
  if (a.formaction) { try { const url = new URL(a.formaction, input.pageUrl); if (!['http:', 'https:'].includes(url.protocol) || url.origin !== new URL(input.pageUrl).origin || url.username || url.password || /(?:delete|remove|submit|account|login|payment|upload|approve)/i.test(url.pathname)) return undefined } catch { return undefined } }
  const context = input.context?.targetPresent ? input.context : undefined
  const cue = [a.id, a.name, a.placeholder, a['aria-label'], a.title].filter(Boolean).join(' ')
  const dateFacet = context?.dateFacet === true && context.filter && tag === 'div' && a.class?.split(/\s+/).includes('level-content-timeItem') &&
    ['今日', '近3日', '近1月', '近3月', '近半年', '近一年', '全部'].includes(label)
  const clickable = dateFacet || ['a', 'button', 'option'].includes(tag) || ['div', 'span'].includes(tag) && Boolean(context && (context.search && search.test(label) || context.pagination && pageLabel.test(label) || context.filter && filter.test(cue + label) || context.sort && sort.test(cue + label))) || ['button', 'link', 'option', 'tab', 'checkbox', 'radio'].includes(a.role ?? '') || tag === 'input' && ['submit', 'button', 'radio', 'checkbox'].includes(type)
  if (input.action === 'fill') {
    if (!['input', 'textarea', 'select'].includes(tag) || ['password', 'file', 'hidden'].includes(type) || typeof input.value !== 'string' || input.value.length > 2048 || [...input.value].some(character => character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0)))) return undefined
    if (tag === 'select') {
      const values = [...input.html.matchAll(/<option\b[^>]*\bvalue\s*=\s*(["'])(.*?)\1/gi)].map(m => decode(m[2]))
      if (!values.includes(input.value)) return undefined
      return sort.test(cue) && context?.sort ? 'sort_control' : filter.test(cue) && context?.filter ? 'filter_control' : undefined
    }
    if (type === 'search' || ['text', 'search'].includes(type) && (searchField.test(cue) || (/^(?:title|标题)$/i.test(a.id ?? a.name ?? '') || /^(?:请输入内容|请输入标题|标题)$/.test(a.placeholder ?? '')) && context?.search)) return 'search_input'
    return context?.filter && filter.test(cue) ? 'filter_control' : context?.sort && sort.test(cue) ? 'sort_control' : undefined
  }
  if (!clickable) return undefined
  if (dateFacet) return 'filter_control'
  if (search.test(label) && (context?.search || input.priorSearchInput || /(?:search|query|检索|搜索)/i.test([a.class, a.id, a.role].join(' ')))) return 'search_trigger'
  if (!label && /(?:search|query)[_-]?(?:btn|button|icon)/i.test([a.class, a.id].join(' ')) && (context?.search || input.priorSearchInput)) return 'search_trigger'
  if (pageLabel.test(label)) {
    let pageLink = false
    try { const link = new URL(a.href ?? '', input.pageUrl); pageLink = Boolean(a.href) && link.origin === new URL(input.pageUrl).origin && [...link.searchParams.keys()].some(k => /^(?:page|pageNo|pageNum|pageIndex|current|p)$/i.test(k)) } catch { /* No positive URL proof. */ }
    if (pageLink || context?.pagination) return 'pagination'
  }
  if (context?.sort && (sort.test(cue + label) || tag === 'option' || a.role === 'option')) return 'sort_control'
  if (context?.filter && (filter.test(cue + label) || tag === 'option' || ['option', 'checkbox', 'radio'].includes(a.role ?? '') || ['checkbox', 'radio'].includes(type))) return 'filter_control'
  return undefined
}
