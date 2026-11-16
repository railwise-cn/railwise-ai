import { createHash } from 'node:crypto'
import sax from 'sax'
import { BrowserLoadedResponseProofSchema, type BrowserLoadedResponseProof } from '../contracts/browser-skill.js'
import type { ExecutionGrant } from '../contracts/permissions.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import { assertGrantAllowsNetwork } from '../adapters/tool/sandbox-policy.js'
import { operationFingerprint } from './task-run-repository.js'

export type BrowserDocumentCommand = (args: string[]) => Promise<Record<string, unknown>>
type Json = Record<string, unknown>
const object = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function fail(code = 'browser_document_response_unverified'): never { throw Object.assign(new Error(code), { code }) }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const normalize = (text: string) => text.replace(/\s/gu, '')

export function publicArticleId(value: string): string | undefined {
  try {
    const url = new URL(value)
    // These are URI identifiers, not submitted form fields. URLSearchParams
    // converts a literal '+' into a space and breaks a browser URL's base64 ID
    // when its own loaded response correctly encodes that byte as '%2B'.
    // Decode exactly once: an encoded space or '%252B' is a different value.
    const entries = url.search.slice(1).split('&').map(pair => {
      const separator = pair.indexOf('=')
      return [decodeURIComponent(separator < 0 ? pair : pair.slice(0, separator)),
        decodeURIComponent(separator < 0 ? '' : pair.slice(separator + 1))] as const
    })
    const values = entries.filter(([key]) => key === 'articleId').map(([, id]) => id)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || entries.some(([key]) => /token|password|secret|cookie|authorization|signature/i.test(key)) ||
      values.length !== 1 || !identifier(values[0]) || /[\s\p{Cc}]/u.test(values[0])) return undefined
    return values[0]
  } catch { return undefined }
}

function plainHtml(html: string): string {
  const parser = sax.parser(false, { lowercase: true }), parts: string[] = []
  let hidden = 0
  parser.onopentag = node => { if (['script', 'style', 'template', 'noscript'].includes(node.name)) hidden++ }
  parser.onclosetag = name => { if (['script', 'style', 'template', 'noscript'].includes(name)) hidden = Math.max(0, hidden - 1) }
  parser.ontext = text => { if (!hidden) parts.push(text) }
  parser.oncdata = text => { if (!hidden) parts.push(text) }
  parser.onerror = () => { parser.resume() }
  try { parser.write(`<body>${html}</body>`).close() } catch { return '' }
  return normalize(parts.join(' '))
}

export type PrimaryResponseRepresentation = { html: string; title: string; pointer: string; association: 'title' | 'projectName' | 'metadata_identity'; associationHash: string }
/** A narrow representation contract, independent of hostnames and API paths.
 * A JSON wrapper is not authority: the independent URL ID and current native title
 * must exactly match one response object. Its visible body need not repeat metadata. */
export function primaryResponseRepresentation(text: string, articleId: string, nativeTitle: string): PrimaryResponseRepresentation | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return undefined }
  const matches: PrimaryResponseRepresentation[] = []
  let nodes = 0, exceeded = false
  const visit = (value: unknown, pointer: string, depth: number) => {
    if (++nodes > 4096 || depth > 8) { exceeded = true; return }
    if (!value || typeof value !== 'object') return
    if (!Array.isArray(value)) {
      const item = object(value)
      if (Object.hasOwn(item, 'articleId') && Object.hasOwn(item, 'title') && Object.hasOwn(item, 'content') &&
        item.articleId === articleId && item.title === nativeTitle && typeof item.content === 'string' && item.content.trim() &&
        Buffer.byteLength(item.content) <= 262144 && /<[a-z][^>]*>/i.test(item.content)) {
        const body = plainHtml(item.content), title = normalize(nativeTitle), project = typeof item.projectName === 'string' ? normalize(item.projectName) : ''
        // A title alone, hidden script/style payload or an empty app shell is not a document body.
        // Keep existing body associations first for old proof compatibility; metadata identity
        // proves only which complete response was read, never its facts or a full DOM.
        if (body && body !== title && (!project || body !== project)) {
          const contentPointer = `${pointer}/content`
          const association = title && body.includes(title) ? 'title' : [...project].length >= 8 && title.includes(project) && body.includes(project) ? 'projectName' : 'metadata_identity'
          const associationHash = association === 'metadata_identity'
            ? hash(JSON.stringify({ association, articleId, nativeTitle, contentPointer, htmlSha256: hash(item.content) }))
            : hash(association === 'title' ? title : project)
          matches.push({ html: item.content, title: nativeTitle, pointer: contentPointer, association, associationHash })
        }
      }
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, depth + 1)
  }
  visit(parsed, '', 0)
  return !exceeded && matches.length === 1 ? matches[0] : undefined
}

export type BrowserResponseCapture = {
  taskId: string; turnId: string; sessionId: string; tabId: number; parentSourceUrl: string;
  runId: string; name: string; grantFingerprint: string; configurationFingerprint: string
}

export async function startBrowserResponseCapture(command: BrowserDocumentCommand,
  input: Omit<BrowserResponseCapture, 'runId'>): Promise<BrowserResponseCapture> {
  if (!publicArticleId(input.parentSourceUrl)) fail('browser_document_representation_unsupported')
  const result = await command(['debug', 'start', '--session', input.sessionId, '--tab-id', String(input.tabId), '--name', input.name])
  const run = object(result.run)
  if (result.session_id !== input.sessionId || run.session_id !== input.sessionId || run.tab_id !== input.tabId ||
    run.name !== input.name || run.state !== 'capturing' || !identifier(run.id)) fail('browser_document_capture_not_owned')
  return { ...input, runId: run.id }
}

export async function stopBrowserResponseCapture(command: BrowserDocumentCommand, capture: BrowserResponseCapture): Promise<void> {
  const result = await command(['debug', 'stop', '--session', capture.sessionId, '--tab-id', String(capture.tabId), '--run-id', capture.runId])
  const run = object(result.run)
  if (result.session_id !== capture.sessionId || run.id !== capture.runId || run.session_id !== capture.sessionId ||
    run.tab_id !== capture.tabId || run.name !== capture.name || run.state !== 'stopped') fail('browser_document_capture_cleanup_failed')
}

function metadataRows(result: Json, capture: BrowserResponseCapture): Json[] {
  const run = object(result.run), output = object(result.output)
  if (result.session_id !== capture.sessionId || run.id !== capture.runId || run.session_id !== capture.sessionId || run.tab_id !== capture.tabId ||
    run.name !== capture.name || run.state !== 'capturing' || run.dropped_requests !== 0 || Number(run.active_rules ?? 0) !== 0 ||
    result.truncated === true || Array.isArray(output.omitted) && output.omitted.some(value => value !== 'inline_url_content') || !Array.isArray(result.requests) ||
    result.requests.length > 100 || run.requests !== result.requests.length || !Array.isArray(run.coverage) ||
    !['from_start', 'task_tab'].every(value => (run.coverage as unknown[]).includes(value))) fail()
  return result.requests.map(object)
}

function currentParentDocument(rows: Json[], frameId: string, capture: BrowserResponseCapture): Json {
  const docs = rows.filter(row => row.frame_id === frameId && row.resource_type === 'Document')
  if (!docs.length || docs.some(row => !finite(row.started_at))) fail()
  const latest = docs.sort((a, b) => Number(b.started_at) - Number(a.started_at))[0]!
  if (latest.url !== capture.parentSourceUrl || latest.method !== 'GET' || latest.state !== 'complete' || latest.status !== 200 ||
    !identifier(latest.loader_id) || !identifier(latest.id) || latest.run_id !== capture.runId || latest.intervention || latest.replay_id || latest.replay_from) fail()
  return latest
}

export async function readBrowserLoadedDocument(input: {
  capture: BrowserResponseCapture; command: BrowserDocumentCommand; guard(): Promise<void>;
  currentTab(): Promise<{ id: number; url: string }>; allowResponseUrl(url: string): void
}): Promise<Json> {
  const { capture, command } = input, articleId = publicArticleId(capture.parentSourceUrl)
  if (!articleId) fail('browser_document_representation_unsupported')
  const nativeParent = async () => {
    await input.guard()
    const tab = await input.currentTab()
    if (tab.id !== capture.tabId || tab.url !== capture.parentSourceUrl) fail('browser_page_changed')
    const read = await command(['read', '--session', capture.sessionId, '--tab-id', String(capture.tabId), '--selector', 'html',
      '--fields-json', '[{"key":"present","read":"exists"}]', '--max-nodes', '1', '--max-bytes', '4096'])
    await input.guard()
    if (read.scope !== 'current_dom' || read.truncated !== false || read.tab_id !== capture.tabId || read.page_url !== capture.parentSourceUrl ||
      read.frame_url !== capture.parentSourceUrl || !identifier(read.frame_id) || typeof read.title !== 'string' || !read.title.trim() ||
      !finite(Date.parse(String(read.captured_at))) || !Array.isArray(read.items) || read.items.length !== 1 || object(object(read.items[0]).values).present !== true ||
      Array.isArray(object(read.items[0]).redacted) && (object(read.items[0]).redacted as unknown[]).length) fail()
    return read
  }
  const metadata = async () => metadataRows(await command(['debug', 'requests', '--session', capture.sessionId, '--tab-id', String(capture.tabId),
    '--run-id', capture.runId, '--limit', '100', '--budget', '262144', '--fields', 'resource_type,frame_id,loader_id,status,mime_type,finished_at']), capture)
  const before = await nativeParent(), rows = await metadata(), frameId = String(before.frame_id), parent = currentParentDocument(rows, frameId, capture)
  const parentOrigin = new URL(capture.parentSourceUrl).origin
  const candidates = rows.filter(row => {
    try {
      const url = new URL(String(row.url)), integrity = object(row.integrity), body = object(row.response_body)
      return row.run_id === capture.runId && row.method === 'GET' && row.status === 200 && row.state === 'complete' && ['XHR', 'Fetch'].includes(String(row.resource_type)) &&
        row.frame_id === frameId && row.loader_id === parent.loader_id && identifier(row.id) && url.origin === parentOrigin && !url.username && !url.password &&
        publicArticleId(url.href) === articleId && ![...url.searchParams.keys()].some(key => /token|password|secret|cookie|authorization|signature/i.test(key)) &&
        integrity.url === 'complete' && integrity.metadata === 'complete' && /json/i.test(String(row.mime_type)) &&
        finite(row.started_at) && finite(row.finished_at) && row.started_at >= Number(parent.started_at) && row.finished_at >= row.started_at &&
        object(row.request_body).state === 'empty' && !row.truncated && !row.intervention && !row.replay_id && !row.replay_from &&
        body.state === 'available' && body.redacted === false && Number.isSafeInteger(body.chars) && Number(body.chars) >= JSON.stringify({ articleId, title: before.title, content: '' }).length && Number(body.chars) <= 65536
    } catch { return false }
  })
  if (!candidates.length || candidates.length > 4) fail('browser_document_response_unavailable')
  const matches: Array<{ row: Json; text: string; representation: PrimaryResponseRepresentation; chunks: BrowserLoadedResponseProof['chunks'] }> = []
  for (const row of candidates) {
    input.allowResponseUrl(String(row.url))
    const total = Number(object(row.response_body).chars), pieces: string[] = [], chunks: BrowserLoadedResponseProof['chunks'] = []
    let offset = 0
    while (offset < total) {
      await input.guard()
      if (chunks.length >= 5) fail()
      const detail = await command(['debug', 'request', String(row.id), '--session', capture.sessionId, '--tab-id', String(capture.tabId), '--run-id', capture.runId,
        '--part', 'response', '--offset', String(offset), '--max-chars', '16384', '--budget', '262144'])
      await input.guard()
      const current = object(detail.request), body = object(current.response_body), run = object(detail.run)
      if (detail.session_id !== capture.sessionId || run.id !== capture.runId || run.session_id !== capture.sessionId || run.tab_id !== capture.tabId || run.name !== capture.name || run.state !== 'capturing' ||
        current.id !== row.id || current.run_id !== capture.runId || current.url !== row.url || current.frame_id !== frameId || current.loader_id !== parent.loader_id ||
        current.state !== 'complete' || current.status !== 200 || current.intervention || current.replay_id || current.replay_from || current.request_headers || current.response_headers ||
        body.state !== 'available' || body.redacted !== false || body.chars !== total || body.offset !== offset || typeof body.text !== 'string' || !body.text || body.text.length > 16384) fail()
      const text = body.text, end = offset + text.length
      if (end > total || body.next_offset !== (end < total ? end : undefined)) fail()
      pieces.push(text); chunks.push({ offset, end, utf16Units: text.length, utf8Bytes: Buffer.byteLength(text), sha256: hash(text) }); offset = end
    }
    const text = pieces.join('')
    if (text.length !== total || Buffer.byteLength(text) > 262144) fail()
    const representation = primaryResponseRepresentation(text, articleId, String(before.title))
    if (representation) matches.push({ row, text, representation, chunks })
  }
  if (matches.length !== 1) fail('browser_document_representation_ambiguous')
  const selected = matches[0]!, after = await nativeParent(), afterRows = await metadata(), afterParent = currentParentDocument(afterRows, frameId, capture)
  if (after.frame_id !== before.frame_id || after.title !== before.title || afterParent.id !== parent.id || afterParent.loader_id !== parent.loader_id ||
    Date.parse(String(after.captured_at)) < Number(selected.row.finished_at)) fail('browser_page_changed')
  await input.guard()
  const proof = BrowserLoadedResponseProofSchema.parse({ schemaVersion: 1, sourceKind: 'actual_loaded_response', taskId: capture.taskId, turnId: capture.turnId,
    sessionId: capture.sessionId, tabId: capture.tabId, captureRunId: capture.runId, captureName: capture.name,
    parentSourceUrl: capture.parentSourceUrl, responseUrl: String(selected.row.url), parentFrameId: frameId, loaderId: String(parent.loader_id),
    parentDocumentRequestId: String(parent.id), responseRequestId: String(selected.row.id), grantFingerprint: capture.grantFingerprint,
    configurationFingerprint: capture.configurationFingerprint, articleIdHash: hash(articleId), titleHash: hash(selected.representation.title),
    association: selected.representation.association, associationHash: selected.representation.associationHash, contentPointer: selected.representation.pointer,
    responseUtf16Units: selected.text.length, responseUtf8Bytes: Buffer.byteLength(selected.text), responseSha256: hash(selected.text),
    htmlUtf8Bytes: Buffer.byteLength(selected.representation.html), htmlSha256: hash(selected.representation.html),
    responseBodyState: 'available', responseBodyRedacted: false, nativeParentIdentityMatched: true, latestParentLoaderMatched: true, chunks: selected.chunks })
  return { sourceKind: 'actual_loaded_response', sourceUrl: capture.parentSourceUrl, responseUrl: proof.responseUrl, tabId: capture.tabId,
    title: selected.representation.title, html: selected.representation.html, responseText: selected.text, resultHash: proof.htmlSha256,
    truncated: false, byteSize: proof.htmlUtf8Bytes, readScope: 'response_document', nativeProof: proof }
}

/** Consumer-side integrity checks supplement the immutable trusted Host receipt.
 * No model-supplied metadata or general MCP claim can enter this source kind. */
export function validLoadedResponseEvidence(output: Json, grant: ExecutionGrant): boolean {
  try {
    const proof = BrowserLoadedResponseProofSchema.parse(output.nativeProof), source = String(output.sourceUrl), response = String(output.responseUrl)
    const articleId = publicArticleId(source), json = output.responseText, html = output.html
    if (output.sourceKind !== 'actual_loaded_response' || output.readScope !== 'response_document' || output.truncated !== false ||
      proof.taskId !== grant.taskId || proof.turnId !== grant.turnId || proof.grantFingerprint !== operationFingerprint(grant) ||
      proof.configurationFingerprint !== grant.connectorIdentityFingerprints?.['browser-skill'] || proof.parentSourceUrl !== source || proof.responseUrl !== response ||
      !articleId || publicArticleId(response) !== articleId || new URL(source).origin !== new URL(response).origin ||
      !grant.browserScope?.origins.includes(new URL(response).origin) || typeof json !== 'string' || typeof html !== 'string' || typeof output.title !== 'string' ||
      proof.articleIdHash !== hash(articleId) || proof.titleHash !== hash(output.title) || json.length !== proof.responseUtf16Units ||
      Buffer.byteLength(json) !== proof.responseUtf8Bytes || hash(json) !== proof.responseSha256 || Buffer.byteLength(html) !== proof.htmlUtf8Bytes || hash(html) !== proof.htmlSha256 || output.resultHash !== proof.htmlSha256) return false
    assertGrantAllowsNetwork(response, { executionGrant: grant } as ToolHostContext)
    const representation = primaryResponseRepresentation(json, articleId, output.title)
    if (!representation || representation.html !== html || representation.pointer !== proof.contentPointer || representation.association !== proof.association || representation.associationHash !== proof.associationHash) return false
    let offset = 0
    for (const chunk of proof.chunks) {
      if (chunk.offset !== offset || chunk.end !== offset + chunk.utf16Units) return false
      const text = json.slice(chunk.offset, chunk.end)
      if (text.length !== chunk.utf16Units || Buffer.byteLength(text) !== chunk.utf8Bytes || hash(text) !== chunk.sha256) return false
      offset = chunk.end
    }
    return offset === json.length
  } catch { return false }
}
