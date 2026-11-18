import type { TurnItem } from '../contracts/items.js'
import { createHash } from 'node:crypto'
import sax from 'sax'

export type RequestHistoryHygieneOptions = {
  maxToolResultLines?: number
  maxToolResultBytes?: number
  maxToolResultTokens?: number
  maxToolArgumentStringBytes?: number
  maxToolArgumentStringTokens?: number
  maxArrayItems?: number
}

const DEFAULT_MAX_TOOL_RESULT_LINES = 320
const DEFAULT_MAX_TOOL_RESULT_BYTES = 32 * 1024
const DEFAULT_MAX_TOOL_RESULT_TOKENS = 8_000
const DEFAULT_MAX_TOOL_ARGUMENT_STRING_BYTES = 8 * 1024
const DEFAULT_MAX_TOOL_ARGUMENT_STRING_TOKENS = 2_000
const DEFAULT_MAX_ARRAY_ITEMS = 80
const MAX_SIGNAL_LINES = 48
const MAX_LINE_CHARS = 280
const LONG_ARGUMENT_PREVIEW_CHARS = 160
const ESC = String.fromCharCode(27)

const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g')
const SIGNAL_LINE_RE =
  /\b(error|failed?|fatal|panic|exception|traceback|warning|warn|denied|timeout|timed out|not found|cannot|invalid)\b/i
const BASE64_KEY_RE = /(?:^|_)(?:data_)?base64$/i
const DATA_URL_RE = /^data:[^;,]+;base64,/i

type JsonRecord = Record<string, unknown>

type CompactResult<T> = {
  value: T
  changed: boolean
  unabridged?: T
}

// Send-time bridge only. TaskContextRuntime persists these complete sources in
// its existing task-scoped context store before advertising a recall reference.
const documentSources = new WeakMap<TurnItem, unknown>()
export function unabridgedHistoryToolOutput(item: TurnItem): unknown {
  return documentSources.get(item)
}

/**
 * Applies Reasonix-style send-time history hygiene without mutating the
 * persisted session log. This keeps dynamic tool history bounded so the
 * warmed immutable prefix accounts for a larger share of each request.
 */
export function applyRequestHistoryHygiene(
  items: TurnItem[],
  options: RequestHistoryHygieneOptions = {}
): TurnItem[] {
  const limits = normalizeOptions(options)
  const pairedToolCallIds = new Set(
    items
      .filter((item) => item.kind === 'tool_result')
      .map((item) => item.callId)
  )
  let changed = false
  const next = items.map((item) => {
    if (item.kind === 'tool_result') {
      const output = item.toolName === 'read_task_context'
        ? compactContextSlice(item.output, limits) ?? compactToolResultOutput(item.output, limits, item.toolName)
        : compactToolResultOutput(item.output, limits, item.toolName)
      if (!output.changed) return item
      changed = true
      const projected = { ...item, output: output.value }
      if (output.unabridged !== undefined) documentSources.set(projected, output.unabridged)
      return projected
    }
    if (item.kind === 'tool_call' && pairedToolCallIds.has(item.callId)) {
      const args = compactCompletedToolArguments(item.arguments, {
        toolName: item.toolName,
        maxStringBytes: limits.maxToolArgumentStringBytes,
        maxStringTokens: limits.maxToolArgumentStringTokens,
        maxArrayItems: limits.maxArrayItems
      })
      if (!args.changed) return item
      changed = true
      return { ...item, arguments: args.value }
    }
    return item
  })
  return changed ? next : items
}

function normalizeOptions(options: RequestHistoryHygieneOptions): Required<RequestHistoryHygieneOptions> {
  return {
    maxToolResultLines: Math.min(
      DEFAULT_MAX_TOOL_RESULT_LINES,
      Math.max(1, Math.floor(options.maxToolResultLines ?? DEFAULT_MAX_TOOL_RESULT_LINES))
    ),
    maxToolResultBytes: Math.min(
      DEFAULT_MAX_TOOL_RESULT_BYTES,
      Math.max(512, Math.floor(options.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES))
    ),
    maxToolResultTokens: Math.min(
      DEFAULT_MAX_TOOL_RESULT_TOKENS,
      Math.max(128, Math.floor(options.maxToolResultTokens ?? DEFAULT_MAX_TOOL_RESULT_TOKENS))
    ),
    maxToolArgumentStringBytes:
      Math.max(512, Math.floor(options.maxToolArgumentStringBytes ?? DEFAULT_MAX_TOOL_ARGUMENT_STRING_BYTES)),
    maxToolArgumentStringTokens:
      Math.max(128, Math.floor(options.maxToolArgumentStringTokens ?? DEFAULT_MAX_TOOL_ARGUMENT_STRING_TOKENS)),
    maxArrayItems: Math.max(1, Math.floor(options.maxArrayItems ?? DEFAULT_MAX_ARRAY_ITEMS))
  }
}

function compactToolResultOutput(
  output: unknown,
  limits: Required<RequestHistoryHygieneOptions>,
  toolName: string
): CompactResult<unknown> {
  // Only the actual top-level browser document contract is projected. Arbitrary
  // nested tool objects/arrays retain their existing bounded JSON treatment.
  if (/^(?:ego_browser_(?:open|read|next_page)|browser_get_html)$/.test(toolName) && isRecord(output)) {
    const document = compactBrowserDocument(output, limits)
    if (document) return document
  }
  return compactToolResultValue(output, '', limits)
}

function compactToolResultValue(
  value: unknown,
  key: string,
  limits: Required<RequestHistoryHygieneOptions>
): CompactResult<unknown> {
  if (typeof value === 'string') {
    if (shouldOmitBase64(key, value)) {
      return {
        value: `[cache hygiene: omitted base64 data, ${formatBytes(Buffer.byteLength(value, 'utf8'))}]`,
        changed: true
      }
    }
    return compactToolResultText(value, limits)
  }
  if (Array.isArray(value)) {
    return compactArray(value, limits)
  }
  if (!isRecord(value)) return { value, changed: false }

  let changed = false
  const out: JsonRecord = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    const child = compactToolResultValue(childValue, childKey, limits)
    out[childKey] = child.value
    changed ||= child.changed
  }
  return changed ? { value: out, changed: true } : { value, changed: false }
}

/** Source documents are ordered data, not command logs. Never sample their
 * middle or shorten individual content lines. No page code is evaluated. */
function compactBrowserDocument(value: JsonRecord, limits: Required<RequestHistoryHygieneOptions>): CompactResult<unknown> | null {
  if (typeof value.html !== 'string' || typeof value.sourceUrl !== 'string' || !/^https?:\/\//i.test(value.sourceUrl) ||
    !/<[a-z][^>]*>/i.test(value.html) || withinTextLimits(value.html, limits)) return null
  const html = value.html, semantic = documentTextAndLinks(html, value.sourceUrl)
  const text = semantic ?? html, shown = sourcePrefix(text, limits)
  const otherFields = compactToolResultValue({ ...value, html: '' }, '', limits).value as JsonRecord
  const projection = { untrusted: true, sourceField: 'html', representation: semantic === null ? 'source-html' : 'text-and-links',
    sourceHtmlSha256: createHash('sha256').update(html).digest('hex'), sourceHtmlBytes: Buffer.byteLength(html),
    sourceTruncated: value.truncated === true, sourceReadScope: value.readScope ?? 'source-html', textUtf8Bytes: Buffer.byteLength(text), offsetUnit: 'utf8-bytes' }
  const metadata = (part: string) => ({ ...projection, shownUtf8Bytes: Buffer.byteLength(part),
    complete: part === text && semantic !== null && value.truncated !== true,
    ...(part !== text || semantic === null ? { instruction: 'Incomplete model document projection. Do not infer omitted records or full source coverage. Read the task-scoped contextSpill reference when provided; otherwise obtain an authorized narrower document read before reporting.' } : {}) })
  return { changed: true, value: { ...otherFields, html: shown, modelDocumentProjection: metadata(shown) },
    ...(shown !== text || semantic === null ? { unabridged: { ...otherFields, html: text, modelDocumentProjection: metadata(text) } } : {}) }
}

function documentTextAndLinks(html: string, sourceUrl: string): string | null {
  const parser = sax.parser(false, { lowercase: true }), parts: string[] = []
  const excluded = new Set(['script', 'style', 'template', 'noscript', 'textarea', 'select'])
  const block = /^(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|th|thead|tr|ul)$/
  let skipped = 0, invalid = false
  parser.onopentag = node => {
    if (skipped || excluded.has(node.name)) { skipped++; return }
    if (block.test(node.name)) parts.push('\n')
    for (const key of ['alt', 'title', 'aria-label', 'datetime']) {
      const attribute = node.attributes[key]
      if (typeof attribute === 'string' && attribute.trim()) parts.push(` [${key}=${JSON.stringify(attribute)}] `)
    }
    if (node.name === 'a' && typeof node.attributes.href === 'string') {
      try { const url = new URL(node.attributes.href, sourceUrl)
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) parts.push(` [link=${JSON.stringify(url.href)}] `)
      } catch { /* Keep the source label without inventing a usable link. */ }
    }
  }
  parser.onclosetag = name => { if (skipped) { skipped--; return }; if (block.test(name)) parts.push('\n') }
  parser.ontext = text => { if (!skipped) parts.push(text) }
  parser.oncdata = text => { if (!skipped) parts.push(text) }
  parser.onerror = () => { invalid = true; parser.resume() }
  try { parser.write(html).close() } catch { return null }
  if (invalid) return null
  return parts.join('').split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
}

function withinTextLimits(text: string, limits: Required<RequestHistoryHygieneOptions>): boolean {
  return Buffer.byteLength(text) <= limits.maxToolResultBytes && countLines(text) <= limits.maxToolResultLines && estimateTokens(text) <= limits.maxToolResultTokens
}

/** A contiguous prefix at Unicode boundaries; offsets refer to these exact
 * UTF-8 source bytes, never to normalized or re-encoded HTML positions. */
function sourcePrefix(text: string, limits: Required<RequestHistoryHygieneOptions>): string {
  if (withinTextLimits(text, limits)) return text
  let end = 0, bytes = 0, tokens = 0, asciiRun = 0, newlines = 0
  for (const char of text) {
    const charBytes = Buffer.byteLength(char), ascii = char.charCodeAt(0) <= 0x7f
    const charTokens = ascii ? (asciiRun % 4 === 0 ? 1 : 0) : isCombiningMark(char) ? 0 : 1
    const nextNewlines = newlines + (char === '\n' ? 1 : 0)
    if (bytes + charBytes > limits.maxToolResultBytes || tokens + charTokens > limits.maxToolResultTokens || nextNewlines + (char === '\n' ? 0 : 1) > limits.maxToolResultLines) break
    bytes += charBytes; tokens += charTokens; asciiRun = ascii ? asciiRun + 1 : 0; newlines = nextNewlines
    end += char.length
  }
  return text.slice(0, end)
}

function compactContextSlice(value: unknown, limits: Required<RequestHistoryHygieneOptions>): CompactResult<unknown> | null {
  if (!isRecord(value) || typeof value.text !== 'string' || !Number.isSafeInteger(value.offset) || Number(value.offset) < 0 ||
    !Number.isSafeInteger(value.totalBytes) || typeof value.sha256 !== 'string') return null
  const text = sourcePrefix(value.text, limits)
  if (text === value.text) return { value, changed: false }
  const nextOffset = Number(value.offset) + Buffer.byteLength(text)
  return { changed: true, value: { ...value, text, nextOffset, modelContextSlice: {
    complete: false, offsetUnit: 'utf8-bytes', shownUtf8Bytes: Buffer.byteLength(text),
    instruction: 'Continue read_task_context on the same bundle_id/object_id at nextOffset before relying on unseen source bytes.' } } }
}

function compactArray(
  values: unknown[],
  limits: Required<RequestHistoryHygieneOptions>
): CompactResult<unknown[]> {
  const keepHead = Math.max(1, Math.floor(limits.maxArrayItems * 0.75))
  const keepTail = Math.max(0, limits.maxArrayItems - keepHead)
  const tail = keepTail > 0 ? values.slice(values.length - keepTail) : []
  const selected = values.length > limits.maxArrayItems
    ? [
        ...values.slice(0, keepHead),
        { cache_hygiene_omitted_items: values.length - limits.maxArrayItems },
        ...tail
      ]
    : values
  let changed = selected !== values
  const out = selected.map((value) => {
    const compacted = compactToolResultValue(value, '', limits)
    changed ||= compacted.changed
    return compacted.value
  })
  return changed ? { value: out, changed: true } : { value: values, changed: false }
}

function compactToolResultText(
  text: string,
  limits: Required<RequestHistoryHygieneOptions>
): CompactResult<string> {
  const originalBytes = Buffer.byteLength(text, 'utf8')
  const originalLines = countLines(text)
  const originalTokens = estimateTokens(text)
  if (
    originalBytes <= limits.maxToolResultBytes &&
    originalLines <= limits.maxToolResultLines &&
    originalTokens <= limits.maxToolResultTokens
  ) {
    return { value: text, changed: false }
  }

  const normalized = normalizeTextBlock(text)
  const lines = normalized ? normalized.split('\n') : []
  const selected = selectCacheUsefulLines(lines, limits.maxToolResultLines)
  const omittedBytes = Math.max(0, originalBytes - Buffer.byteLength(selected.join('\n'), 'utf8'))
  const selectedTokens = estimateTokens(selected.join('\n'))
  const omittedTokens = Math.max(0, originalTokens - selectedTokens)
  const marker = [
    `[cache hygiene: omitted ${Math.max(0, lines.length - selected.length)} line(s), `,
    `${formatBytes(omittedBytes)}, approx ${omittedTokens} token(s); use narrower read/grep/bash ranges for details]`
  ].join('')
  const budgetForText = Math.max(0, limits.maxToolResultBytes - Buffer.byteLength(marker, 'utf8') - 1)
  const budgetForTokens = Math.max(0, limits.maxToolResultTokens - estimateTokens(marker) - 1)
  const fitted = fitLinesToBudget(selected.map(compactLine), {
    maxBytes: budgetForText,
    maxTokens: budgetForTokens
  })
  return {
    value: [...fitted, marker].join('\n'),
    changed: true
  }
}

function selectCacheUsefulLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines
  const indexes = new Set<number>()
  const headCount = Math.min(80, Math.max(1, Math.floor(maxLines * 0.25)))
  const tailCount = Math.min(120, Math.max(1, Math.floor(maxLines * 0.35)))
  for (let index = 0; index < Math.min(headCount, lines.length); index += 1) {
    indexes.add(index)
  }
  for (let index = Math.max(0, lines.length - tailCount); index < lines.length; index += 1) {
    indexes.add(index)
  }
  let signalCount = 0
  for (let index = 0; index < lines.length && indexes.size < maxLines; index += 1) {
    if (!SIGNAL_LINE_RE.test(lines[index] ?? '')) continue
    indexes.add(index)
    signalCount += 1
    if (signalCount >= MAX_SIGNAL_LINES) break
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .slice(0, maxLines)
    .map((index) => lines[index] ?? '')
}

function compactCompletedToolArguments(
  args: Record<string, unknown>,
  options: { toolName: string; maxStringBytes: number; maxStringTokens: number; maxArrayItems: number }
): CompactResult<Record<string, unknown>> {
  let changed = false
  const out: JsonRecord = {}
  for (const [key, value] of Object.entries(args)) {
    const compacted = compactArgumentValue(value, key, options)
    out[key] = compacted.value
    changed ||= compacted.changed
  }
  return changed ? { value: out, changed: true } : { value: args, changed: false }
}

function compactArgumentValue(
  value: unknown,
  key: string,
  options: { toolName: string; maxStringBytes: number; maxStringTokens: number; maxArrayItems: number }
): CompactResult<unknown> {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8')
    const tokens = estimateTokens(value)
    if (bytes <= options.maxStringBytes && tokens <= options.maxStringTokens) return { value, changed: false }
    const preview = value.slice(0, LONG_ARGUMENT_PREVIEW_CHARS).replace(/\s+/g, ' ').trim()
    const suffix = preview ? ` preview=${JSON.stringify(preview)}` : ''
    return {
      value:
        `[cache hygiene: omitted completed ${options.toolName}.${key} argument, ` +
        `${formatBytes(bytes)}, approx ${tokens} token(s), ${countLines(value)} line(s); see following tool result]${suffix}`,
      changed: true
    }
  }
  if (Array.isArray(value)) {
    if (value.length <= options.maxArrayItems) {
      let changed = false
      const out = value.map((child) => {
        const compacted = compactArgumentValue(child, key, options)
        changed ||= compacted.changed
        return compacted.value
      })
      return changed ? { value: out, changed: true } : { value, changed: false }
    }
    return {
      value: [
        ...value.slice(0, Math.max(1, options.maxArrayItems - 1)),
        { cache_hygiene_omitted_items: value.length - options.maxArrayItems }
      ],
      changed: true
    }
  }
  if (!isRecord(value)) return { value, changed: false }
  let changed = false
  const out: JsonRecord = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    const compacted = compactArgumentValue(childValue, childKey, options)
    out[childKey] = compacted.value
    changed ||= compacted.changed
  }
  return changed ? { value: out, changed: true } : { value, changed: false }
}

function shouldOmitBase64(key: string, value: string): boolean {
  return value.length > 256 && (BASE64_KEY_RE.test(key) || DATA_URL_RE.test(value))
}

function normalizeTextBlock(text: string): string {
  const stripped = text.replace(/\r\n/g, '\n').replace(ANSI_RE, '')
  const lines = stripped.split('\n').map((line) => line.trimEnd())
  const out: string[] = []
  let blankRun = 0
  let previous = ''
  let repeatCount = 0
  const flushRepeat = () => {
    if (repeatCount > 1) out.push(`[previous line repeated ${repeatCount - 1} time(s)]`)
    repeatCount = 0
  }
  for (const line of lines) {
    if (!line.trim()) {
      flushRepeat()
      blankRun += 1
      if (blankRun <= 2) out.push('')
      previous = ''
      continue
    }
    blankRun = 0
    if (line === previous) {
      repeatCount += 1
      continue
    }
    flushRepeat()
    out.push(line)
    previous = line
    repeatCount = 1
  }
  flushRepeat()
  return out.join('\n').trim()
}

function fitLinesToBudget(lines: string[], budget: { maxBytes: number; maxTokens: number }): string[] {
  const out: string[] = []
  let bytes = 0
  let tokens = 0
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + (out.length > 0 ? 1 : 0)
    const lineTokens = estimateTokens(line) + (out.length > 0 ? 1 : 0)
    if (bytes + lineBytes > budget.maxBytes || tokens + lineTokens > budget.maxTokens) break
    out.push(line)
    bytes += lineBytes
    tokens += lineTokens
  }
  if (out.length === 0 && lines.length > 0 && budget.maxBytes > 0 && budget.maxTokens > 0) {
    out.push(truncateStringToBudget(lines[0] ?? '', budget))
  }
  return out
}

function compactLine(line: string): string {
  const trimmed = line.trimEnd()
  if (trimmed.length <= MAX_LINE_CHARS) return trimmed
  const head = Math.floor(MAX_LINE_CHARS * 0.6)
  const tail = Math.max(0, MAX_LINE_CHARS - head - 5)
  return `${trimmed.slice(0, head).trimEnd()} ... ${trimmed.slice(-tail).trimStart()}`
}

function truncateStringToBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1
  }
  return buffer.subarray(0, end).toString('utf8')
}

function truncateStringToBudget(text: string, budget: { maxBytes: number; maxTokens: number }): string {
  let out = ''
  let bytes = 0
  let tokens = 0
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    const charTokens = estimateTokens(char)
    if (bytes + charBytes > budget.maxBytes || tokens + charTokens > budget.maxTokens) break
    out += char
    bytes += charBytes
    tokens += charTokens
  }
  return out || truncateStringToBytes(text, budget.maxBytes)
}

function countLines(text: string): number {
  if (!text) return 0
  const lines = text.split('\n')
  return text.endsWith('\n') ? lines.length - 1 : lines.length
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function estimateTokens(text: string): number {
  if (!text) return 0
  let asciiRun = 0
  let tokens = 0
  const flushAscii = () => {
    if (asciiRun > 0) {
      tokens += Math.ceil(asciiRun / 4)
      asciiRun = 0
    }
  }
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) {
      asciiRun += 1
      continue
    }
    flushAscii()
    tokens += isCombiningMark(char) ? 0 : 1
  }
  flushAscii()
  return Math.max(1, tokens)
}

function isCombiningMark(char: string): boolean {
  return /[\u0300-\u036f\ufe00-\ufe0f]/u.test(char)
}
