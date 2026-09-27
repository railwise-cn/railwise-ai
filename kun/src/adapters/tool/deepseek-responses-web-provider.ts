import type { WebProvider, WebSearchRequest, WebSearchResult } from '../../ports/web-provider.js'
import { sourceIdFor } from '../../ports/web-provider.js'

const DEFAULT_DEEPSEEK_RESPONSES_BASE_URL = 'https://api.deepseek.com'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_JSON_DEPTH = 64
const MAX_JSON_NODES = 100_000

type DeepSeekResponsesWebProviderOptions = {
  baseUrl: string
  apiKey: string
  model: string
  fetchImpl?: typeof fetch
  nowIso?: () => string
}

type Citation = {
  url: string
  title?: string
  snippet?: string
}

type DeepSeekSearchPayload = {
  citations: Citation[]
  summary?: string
}

/** Uses DeepSeek's server-side Responses web_search without changing the chat model protocol. */
export class DeepSeekResponsesWebProvider implements WebProvider {
  readonly id = 'deepseek-responses'
  private readonly fetchImpl: typeof fetch
  private readonly nowIso: () => string

  constructor(private readonly options: DeepSeekResponsesWebProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
    this.nowIso = options.nowIso ?? (() => new Date().toISOString())
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    if (!isDeepSeekResponsesWebSearchConfig(this.options)) {
      throw new Error('DeepSeek Responses web search is unavailable for this provider or model.')
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)])
    const response = await this.fetchImpl(deepSeekResponsesUrl(this.options.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`
      },
      body: JSON.stringify({
        model: this.options.model,
        input: request.query,
        tools: [{ type: 'web_search' }],
        tool_choice: { type: 'web_search' },
        max_output_tokens: 4_096,
        stream: false
      }),
      signal
    })
    const text = await readBoundedResponseText(response, signal)
    let payload: unknown
    try {
      payload = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`DeepSeek Responses web search returned invalid JSON (HTTP ${response.status}).`)
    }
    if (!response.ok) {
      throw new Error(`DeepSeek Responses web search failed with HTTP ${response.status}.`)
    }
    const searchPayload = searchPayloadFromResponse(payload)
    const citations = searchPayload.citations
    if (citations.length === 0) {
      throw new Error('DeepSeek Responses web search returned no cited results.')
    }
    return citations
      .slice(0, request.limit)
      .map((citation, index) => ({
        sourceId: sourceIdFor('search', `${request.query}:${citation.url}:${index}`),
        url: citation.url,
        ...(citation.title ? { title: citation.title } : {}),
        snippet: citation.snippet || (index === 0 ? searchPayload.summary : undefined) || citation.title || citation.url,
        retrievedAt: this.nowIso(),
        provider: this.id,
        rank: index + 1
      }))
  }
}

export function isDeepSeekResponsesWebSearchConfig(input: {
  baseUrl: string
  apiKey: string
  model: string
}): boolean {
  // V4.1 accepts Responses but ignores built-in web_search; keep this adapter
  // restricted to the historical V4 model IDs instead of advertising a no-op.
  return officialDeepSeekResponsesOrigin(input.baseUrl) != null &&
    Boolean(input.apiKey.trim()) &&
    /^(?:[^/]+\/)?deepseek-v4-(?:pro|flash)$/i.test(input.model.trim())
}

function deepSeekResponsesUrl(baseUrl: string): string {
  const origin = officialDeepSeekResponsesOrigin(baseUrl)
  return `${origin ?? DEFAULT_DEEPSEEK_RESPONSES_BASE_URL}/v1/responses`
}

function officialDeepSeekResponsesOrigin(baseUrl: string): string | null {
  const trimmed = baseUrl.trim() || DEFAULT_DEEPSEEK_RESPONSES_BASE_URL
  try {
    const parsed = new URL(trimmed)
    if (
      parsed.protocol === 'https:' &&
      parsed.hostname.toLowerCase() === 'api.deepseek.com' &&
      !parsed.username &&
      !parsed.password
    ) return parsed.origin
  } catch {
    return null
  }
  return null
}

function searchPayloadFromResponse(payload: unknown): DeepSeekSearchPayload {
  const found: Citation[] = []
  const seen = new Set<string>()
  let summary = ''
  const addCitation = (input: Citation): void => {
    const url = normalizedSourceUrl(input.url)
    if (!url || seen.has(url)) return
    seen.add(url)
    found.push({
      url,
      ...(input.title ? { title: input.title } : {}),
      ...(input.snippet ? { snippet: input.snippet } : {})
    })
  }

  walk(payload, (record) => {
    const type = stringValue(record.type).toLowerCase()
    const url = stringValue(record.url)
    if (!url || (type && !type.includes('citation') && type !== 'url')) return
    addCitation({
      url,
      title: stringValue(record.title) || undefined,
      snippet: stringValue(record.snippet) || stringValue(record.text) || undefined
    })
  })

  const output = objectArrayValue(objectValue(payload).output)
  for (const item of output) {
    const type = stringValue(item.type).toLowerCase()
    if (type === 'message' && stringValue(item.status).toLowerCase() === 'completed') {
      for (const content of objectArrayValue(item.content)) {
        if (stringValue(content.type).toLowerCase() !== 'output_text') continue
        const text = stringValue(content.text)
        if (text.length > summary.length) summary = text
      }
      continue
    }
    if (type !== 'web_search_call' || stringValue(item.status).toLowerCase() !== 'completed') continue
    const action = objectValue(item.action)
    if (stringValue(action.type).toLowerCase() !== 'open_page') continue
    addCitation({ url: stringValue(action.url) })
  }

  return {
    citations: found,
    ...(summary ? { summary } : {})
  }
}

function normalizedSourceUrl(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null
  if (/^#ws_call_id=/i.test(parsed.hash)) parsed.hash = ''
  return parsed.href
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  type WalkFrame =
    | { kind: 'value'; value: unknown; depth: number }
    | { kind: 'iterator'; iterator: Iterator<unknown>; depth: number }

  const pending: WalkFrame[] = [{ kind: 'value', value, depth: 0 }]
  let visitedNodes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) break
    if (current.kind === 'iterator') {
      const next = current.iterator.next()
      if (!next.done) {
        pending.push(current, { kind: 'value', value: next.value, depth: current.depth })
      }
      continue
    }
    visitedNodes += 1
    if (visitedNodes > MAX_JSON_NODES) {
      throw new Error('DeepSeek Responses web search exceeded the JSON node limit.')
    }
    if (current.depth > MAX_JSON_DEPTH) {
      throw new Error('DeepSeek Responses web search exceeded the JSON nesting limit.')
    }
    if (Array.isArray(current.value)) {
      pending.push({ kind: 'iterator', iterator: current.value.values(), depth: current.depth + 1 })
      continue
    }
    if (!current.value || typeof current.value !== 'object') continue
    const record = current.value as Record<string, unknown>
    visit(record)
    pending.push({ kind: 'iterator', iterator: recordValues(record), depth: current.depth + 1 })
  }
}

function* recordValues(record: Record<string, unknown>): Generator<unknown> {
  for (const key in record) {
    if (Object.prototype.hasOwnProperty.call(record, key)) yield record[key]
  }
}

async function readBoundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
  const advertisedBytes = Number(response.headers.get('content-length'))
  if (Number.isFinite(advertisedBytes) && advertisedBytes > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('DeepSeek Responses web search response exceeded the size limit.')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  const onAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (signal.aborted) throw signal.reason
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new Error('DeepSeek Responses web search response exceeded the size limit.')
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function objectArrayValue(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(objectValue).filter((record) => Object.keys(record).length > 0)
    : []
}
