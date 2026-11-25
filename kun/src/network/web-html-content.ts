import { parse, type DefaultTreeAdapterTypes } from 'parse5'
import { sourceIdFor, type WebSearchResult } from '../ports/web-provider.js'

type HtmlNode = DefaultTreeAdapterTypes.Node
type HtmlElement = DefaultTreeAdapterTypes.Element

const ignoredTags = new Set([
  'script', 'style', 'noscript', 'template', 'svg', 'nav', 'header', 'footer', 'aside', 'menu', 'dialog', 'form',
  'button', 'input', 'select', 'textarea', 'iframe', 'video', 'audio', 'canvas'
])
const blockTags = new Set(['address', 'article', 'blockquote', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'main', 'ol', 'p', 'section', 'ul'])

export function extractReadableHtml(raw: string, sourceUrl: string): { title?: string; text: string } {
  const document = parse(raw)
  const elements = allElements(document)
  const titleElement = elements.find(element => element.tagName === 'title')
  const title = titleElement ? plainText(titleElement).slice(0, 500) : undefined
  const body = elements.find(element => element.tagName === 'body') ?? document
  const candidates = elements.filter(element => {
    if (element.tagName === 'article' || element.tagName === 'main') return true
    return attribute(element, 'role') === 'main' || attribute(element, 'itemprop') === 'articleBody'
  })
  const contentRoot = candidates
    .map(element => ({ element, score: contentScore(element) }))
    .filter(candidate => candidate.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.element ?? body
  const text = renderText(contentRoot, sourceUrl)
  return { ...(title ? { title } : {}), text: normalizeWhitespace(text) }
}

export function parseYuanbaoSearchResults(input: {
  html: string
  query: string
  limit: number
  retrievedAt: string
}): WebSearchResult[] {
  const document = parse(input.html)
  const cards = allElements(document).filter(element => element.tagName === 'article' &&
    classTokens(element).includes('result-card'))
  const results: WebSearchResult[] = []
  const seen = new Set<string>()

  for (const card of cards) {
    const anchors = allElements(card).filter(element => element.tagName === 'a')
    const titleAnchor = anchors.find(element => dataLogValue(element, 'linkid') === 'title') ??
      anchors.find(element => classTokens(element).includes('text-yb-h2'))
    const summaryAnchor = anchors.find(element => dataLogValue(element, 'linkid') === 'summary')
    const title = titleAnchor ? plainText(titleAnchor) : ''
    const snippet = summaryAnchor ? plainText(summaryAnchor) : ''
    const url = safeResultUrl(attribute(titleAnchor ?? summaryAnchor ?? anchors[0], 'href'))
    if (!url || !title || seen.has(url)) continue
    seen.add(url)
    const rank = results.length + 1
    results.push({
      sourceId: sourceIdFor('search', `${input.query}:${url}:${rank}`),
      url,
      title: title.slice(0, 500),
      snippet: (snippet || title).slice(0, 1_600),
      retrievedAt: input.retrievedAt,
      provider: 'yuanbao-opensearch',
      rank
    })
    if (results.length >= input.limit) break
  }

  if (cards.length === 0 && !isKnownNoResultsPage(document)) {
    throw new Error('Yuanbao Search returned an unrecognized result page.')
  }
  if (cards.length > 0 && results.length === 0) throw new Error('Yuanbao Search returned no usable source links.')
  return results
}

function allElements(root: HtmlNode): HtmlElement[] {
  const elements: HtmlElement[] = []
  const pending = [root]
  while (pending.length) {
    const node = pending.pop()!
    if (isElement(node)) elements.push(node)
    if ('childNodes' in node) pending.push(...node.childNodes.slice().reverse())
  }
  return elements
}

function contentScore(element: HtmlElement): number {
  const text = plainText(element)
  const links = allElements(element).filter(node => node.tagName === 'a').reduce((total, node) => total + plainText(node).length, 0)
  return text.length - links * 0.8
}

function renderText(node: HtmlNode, baseUrl: string): string {
  if (isText(node)) return node.value
  if (!isElement(node)) return 'childNodes' in node ? node.childNodes.map(child => renderText(child, baseUrl)).join('') : ''
  if (ignoredTags.has(node.tagName) || attribute(node, 'aria-hidden') === 'true' || attribute(node, 'hidden') !== undefined) return ''

  const content = node.childNodes.map(child => renderText(child, baseUrl)).join('')
  if (node.tagName === 'br') return '\n'
  if (node.tagName === 'a') {
    const href = safeResultUrl(attribute(node, 'href'), baseUrl)
    const label = normalizeWhitespace(content)
    return href && label ? `[${label}](${href})` : label
  }
  if (blockTags.has(node.tagName)) return `\n${content}\n`
  return content
}

function plainText(node: HtmlNode): string {
  if (isText(node)) return node.value
  if (!('childNodes' in node) || isElement(node) && ignoredTags.has(node.tagName)) return ''
  return node.childNodes.map(plainText).join(' ')
}

function dataLogValue(element: HtmlElement, key: string): string | undefined {
  const raw = attribute(element, 'data-log')
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    return typeof value[key] === 'string' ? value[key] as string : undefined
  } catch {
    return undefined
  }
}

function safeResultUrl(value: string | undefined, baseUrl?: string): string | undefined {
  if (!value) return undefined
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) return undefined
    return url.href
  } catch {
    return undefined
  }
}

function classTokens(element: HtmlElement): string[] {
  return (attribute(element, 'class') ?? '').split(/\s+/).filter(Boolean)
}

function attribute(element: HtmlElement | undefined, name: string): string | undefined {
  return element?.attrs.find(item => item.name === name)?.value
}

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node
}

function isText(node: HtmlNode): node is DefaultTreeAdapterTypes.TextNode {
  return node.nodeName === '#text'
}

function isKnownNoResultsPage(document: HtmlNode): boolean {
  return /未找到|没有找到|暂无结果|没有相关结果|没有搜到|未搜索到|no results/i.test(plainText(document))
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
