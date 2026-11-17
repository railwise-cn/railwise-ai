import { createHash } from 'node:crypto'
import { evidenceDeadlineCutoff } from './web-evidence-deadline.js'
import { taskScheduleConnectorIdentities } from '../contracts/task-schedule-policy.js'
import type { TaskRun, TaskArtifact, OperationReceipt } from '../contracts/tasks.js'
import type { Turn } from '../contracts/turns.js'
import type { TurnItem } from '../contracts/items.js'
import type { WebArtifactEvidenceInput, WebSourceReference } from '../contracts/web-artifact-evidence.js'
import { validEgoDocumentEvidence } from './ego-browser-evidence.js'
import { validLoadedResponseEvidence } from './browser-loaded-response.js'
import { taskPublicQueryAuthority } from './browser-public-query-authority.js'
import { assertGrantAllowsNetwork } from '../adapters/tool/sandbox-policy.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const webArtifactRequirementHash = (task: TaskRun) => operationFingerprint({ goal: task.goal, acceptance: task.acceptance })
export const isObservedFeedReport = (task: TaskRun) => task.acceptance.webEvidenceBasis === 'observed_feed'
export const isProcurementWebReport = (task: TaskRun) => !isObservedFeedReport(task) && /招标|投标|采购|tender|procurement/i.test(task.goal)
export const needsPrimaryWebDocuments = (task: TaskRun) => !isObservedFeedReport(task) && /招标|投标|采购|公告|正文|详情|primary\s+(?:source|document)|tender|procurement/i.test(task.goal)
const decode = (value: string) => value.replace(/&#(?:x([a-f0-9]+)|(\d+));/gi, (_, hex, decimal) => { const code = parseInt(hex ?? decimal, hex ? 16 : 10); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '' }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key as 'amp'])
const markup = (value: string) => value.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
const text = (value: string) => decode(markup(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, '')
const attr = (tag: string, key: string) => {
  const match = new RegExp(`(?:^|\\s)${key}(?:\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))|(?=\\s|/?>))`, 'i').exec(tag)
  return match ? decode(match[1] ?? match[2] ?? match[3] ?? '') : undefined
}
const canonical = (value: string, base?: string) => {
  try { const u = new URL(value, base); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return undefined
    if (!/^#!?\//.test(u.hash)) u.hash = ''
    return u.href
  } catch { return undefined }
}
const links = (html: string, base?: string) => new Set((markup(html).match(/<a\b[^>]*>/gi) ?? []).map(tag => { const href = attr(tag, 'href'); return href ? canonical(href, base) : undefined }).filter((v): v is string => Boolean(v)))

type HtmlNode = { tag: string; start: number; contentStart: number; end: number; attrs: string; parent?: HtmlNode }
function nodes(html: string): HtmlNode[] | undefined {
  const result: HtmlNode[] = [], stack: HtmlNode[] = []
  for (const match of html.matchAll(/<\/?([a-z][a-z0-9:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    const tag = match[1]!.toLowerCase(), end = match.index! + match[0].length
    if (match[0].startsWith('</')) {
      const index = stack.map(node => node.tag).lastIndexOf(tag)
      if (index >= 0) { for (const node of stack.splice(index)) node.end = end }
    } else {
      if (result.length >= 5000) return undefined
      const node: HtmlNode = { tag, start: match.index!, contentStart: end, end: html.length, attrs: match[0], parent: stack.at(-1) }
      result.push(node)
      if (!/^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag) && !match[0].endsWith('/>')) stack.push(node)
      else node.end = end
    }
  }
  return result
}
const inside = (node: HtmlNode, parent: HtmlNode) => node.start > parent.start && node.end <= parent.end

type Source = { receiptId: string; receiptHash: string; turnId: string; url: string; resultHash: string; content: string; title?: string; full: boolean; feedElement?: boolean; loadingObserved?: boolean; emptyObserved?: boolean; startedAt: string; readAt: string }
export type ObservedFeedCollectionFreshness = {
  basis: 'observed_feed'; collectionTurnId: string; currentCollectionReady: boolean
  nowUtc: string; nowBeijing: string; requestedUrls: string[]; historyNotice: string; nextStep: string; readAt?: string
  /** Capture and source-row readiness are separate from explicit file verification. */
  currentDocumentCaptured?: boolean; reportEvidenceReady?: boolean | null; readinessMeaning?: 'current_capture_only'
}

/** Authority comes from the persisted user control/input path, never a model-selected epoch. */
function collectionAuthority(repository: TaskRunRepository, task: TaskRun, items: TurnItem[], turns: Turn[]): { epoch: string; notBefore: number } | undefined {
  const turn = turns.find(row => row.id === task.activeTurnId)
  if (!turn?.executionGrant || turn.executionGrant.taskId !== task.id || turn.executionGrant.threadId !== task.threadId || turn.executionGrant.turnId !== turn.id) return undefined
  const candidates: Array<{ epoch: string; notBefore: number }> = []
  const initial = repository.execution.attempts(task.id)[0]?.turnId ?? turns.find(row => row.executionGrant?.taskId === task.id)?.id
  if (initial === turn.id) candidates.push({ epoch: `initial:${task.id}:${turn.id}`, notBefore: Date.parse(task.createdAt) })
  const seen = new Set<string>(); let owner: TaskRun | null = task
  while (owner && !seen.has(owner.id)) {
    seen.add(owner.id)
    if (repository.currentExecution(owner.id)?.id !== task.id) break
    for (const receipt of repository.operations(owner.id, 'resume')) {
      const result = object(receipt.result), resumed = object(result.task), started = object(result.turn)
      if (receipt.status === 'succeeded' && receipt.fingerprint === operationFingerprint(receipt.request) && receipt.request?.idempotencyKey === receipt.idempotencyKey &&
        turn.idempotencyKey === `task:${owner.id}:resume:${receipt.idempotencyKey}` && result.capability === undefined &&
        resumed.id === task.id && resumed.threadId === task.threadId && started.threadId === task.threadId && started.turnId === turn.id &&
        typeof started.userMessageItemId === 'string' && started.userMessageItemId) candidates.push({ epoch: `resume:${receipt.id}`, notBefore: Date.parse(receipt.createdAt) })
    }
    owner = owner.retryOfTaskId ? repository.get(owner.retryOfTaskId) : null
  }
  // A genuinely delivered user supplement may begin a new collection within a Turn.
  // Recalling history, capability-original input and automatic re-prompts cannot.
  const deliveries = repository.execution.deliveriesForThread(task.threadId)
  for (const input of repository.inputs(task.id)) {
    if (input.kind !== 'supplement' || input.sourceId) continue
    const message = items.find(item => item.kind === 'user_message' && item.turnId === turn.id && item.threadId === task.threadId && item.taskInputId === input.id && item.text === input.text)
    if (message && deliveries.some(delivery => {
      if (delivery.taskId !== task.id || delivery.inputId !== input.id || delivery.status === 'queued' || delivery.messageItemId !== message.id || !delivery.sessionHash) return false
      const group = deliveries.filter(row => row.taskId === task.id && row.status !== 'queued' && row.sessionHash === delivery.sessionHash && row.sessionItemId === delivery.sessionItemId)
      const included = items.filter(item => group.some(row => row.messageItemId === item.id))
      return included.length === group.length && included.at(-1)?.id === delivery.sessionItemId && hash(JSON.stringify(included)) === delivery.sessionHash
    })) {
      candidates.push({ epoch: `input:${input.id}:${turn.id}`, notBefore: Date.parse(message.createdAt) })
    }
  }
  return candidates.filter(row => Number.isFinite(row.notBefore)).sort((a, b) => b.notBefore - a.notBefore)[0]
}

function actualCollectionRead(source: Source): boolean {
  const clean = markup(source.content), visible = text(clean)
  return Boolean((source.full || source.feedElement) && !source.loadingObserved && !source.emptyObserved && visible &&
    !/aria-busy\s*=\s*["']true/i.test(clean) && !/^(?:(?:页面|数据)?(?:加载中|正在加载)|请稍[候等]|loading)[.。…!！,，]*(?:请稍[候等])?[.。…!！]*$/i.test(visible))
}

function collectionSources(repository: TaskRunRepository, task: TaskRun, items: TurnItem[], turns: Turn[], history: Source[]) {
  if (!isObservedFeedReport(task)) return { available: history, epoch: undefined }
  const authority = collectionAuthority(repository, task, items, turns)
  const available = history.filter(source => source.turnId === task.activeTurnId && (!authority || Date.parse(source.startedAt) >= authority.notBefore))
  const actual = available.some(actualCollectionRead)
  return { available, epoch: actual ? authority?.epoch : undefined }
}

export function observedFeedCollectionFreshness(repository: TaskRunRepository, task: TaskRun, items: TurnItem[], turns: Turn[], allowedOrigins: readonly string[] = [], nowIso = new Date().toISOString()): ObservedFeedCollectionFreshness | null {
  if (!isObservedFeedReport(task) || !task.activeTurnId) return null
  const { available } = collectionSources(repository, task, items, turns, sources(repository, task, items, turns))
  const actual = available.filter(actualCollectionRead)
  const requestedUrls = [...new Set([...task.goal.matchAll(/https?:\/\/[^\s<>"'`）)，。]+/gi)].flatMap(match => {
    try { const url = new URL(match[0]); return !url.username && !url.password && allowedOrigins.includes(url.origin) ? [url.href] : [] } catch { return [] }
  }))]
  const required = task.acceptance.requiredSourceOrigins?.length ? task.acceptance.requiredSourceOrigins
    : requestedUrls.length ? [...new Set(requestedUrls.map(url => new URL(url).origin))] : allowedOrigins
  const covered = new Set(actual.map(source => new URL(source.url).origin))
  const documents = new Set(actual.filter(source => source.full).map(source => new URL(source.url).origin))
  const ego = turns.find(turn => turn.id === task.activeTurnId)?.executionGrant?.browserScope?.provider === 'ego-browser'
  return { basis: 'observed_feed', collectionTurnId: task.activeTurnId, currentCollectionReady: required.length > 0 && required.every(origin => covered.has(origin)),
    currentDocumentCaptured: required.length > 0 && required.every(origin => documents.has(origin)), reportEvidenceReady: null, readinessMeaning: 'current_capture_only',
    nowUtc: nowIso, nowBeijing: new Date(Date.parse(nowIso) + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00'), requestedUrls,
    ...(actual.length ? { readAt: actual.map(source => source.readAt).sort().at(-1) } : {}),
    historyNotice: '此前读取和成果保留为历史素材；回看旧内容不代表本轮已采集当前列表。',
    nextStep: ego ? 'currentCollectionReady仅表示本轮已捕获来源，不表示报告记录已核验。已有本任务Ego空间时，读取失败或只有导航内容可先调用ego_browser_read({})读取当前完整文档；不传selector或旧observationId，不必再次open或新建空间。只按实际同记录原文生成report；没有真实列表记录或明确零结果就保持未核验，不重复发布。' : '先用原任务已授权的原生浏览器工具完整读取当前订阅列表或真实单条记录，再整理、发布并核验本轮报告。已捕获来源不代表报告记录已核验；不要另建任务或扩大权限。' }
}
// Only independently validated loaded-response metadata has a title. Legacy DOM reads
// without metadata may coexist; two actual metadata identities for the same bytes may not.
function findSource(available: Source[], reference: WebSourceReference): Source | undefined {
  const matches = available.filter(source => source.url === canonical(reference.url) && source.resultHash === reference.resultHash)
  if (new Set(matches.flatMap(source => source.title ? [source.title] : [])).size > 1) return undefined
  return matches.find(source => source.title) ?? matches[0]
}
const sourceHasTitle = (source: Source, title: string) => text(source.content).includes(text(title)) || Boolean(source.title && text(source.title) === text(title))
/** A list item is proven by one actual anchor and its smallest record container,
 * never by combining fields found anywhere on the page. No model HTML is trusted. */
function feedRecord(source: Source | undefined, discovery: Source | undefined, item: WebArtifactEvidenceInput['items'][number]): string | undefined {
  if (!(source?.full || source?.feedElement) || source.loadingObserved || source.emptyObserved || !discovery || source.url !== discovery.url || source.resultHash !== discovery.resultHash) return undefined
  const clean = markup(source.content), elements = nodes(clean)
  if (!elements) return undefined
  const target = item.recordUrl ? canonical(item.recordUrl) : undefined
  const titleNodes = elements.filter(node => text(clean.slice(node.contentStart, node.end)) === text(item.title))
  const matches = target ? titleNodes.filter(node => node.tag === 'a' && canonical(attr(node.attrs, 'href') ?? '', source.url) === target)
    : titleNodes.filter(node => !titleNodes.some(child => inside(child, node)))
  if (matches.length !== 1) return undefined
  if (!target) for (let parent: HtmlNode | undefined = matches[0]; parent; parent = parent.parent) {
    if (parent.tag === 'a' && canonical(attr(parent.attrs, 'href') ?? '', source.url)) return undefined
  }
  let semantic: HtmlNode | undefined
  for (let parent: HtmlNode | undefined = matches[0]; parent; parent = parent.parent) {
    if (['article', 'li', 'tr'].includes(parent.tag) || ['article', 'row', 'listitem'].includes(attr(parent.attrs, 'role') ?? '')) { semantic = parent; break }
  }
  for (let parent: HtmlNode | undefined = semantic ?? matches[0]; parent; parent = semantic ? undefined : parent.parent) {
    if (!['article', 'li', 'tr', 'div', 'section'].includes(parent.tag)) continue
    const block = clean.slice(parent.start, parent.end)
    const linksInRecord = elements.filter(node => node.tag === 'a' && inside(node, parent) && text(clean.slice(node.contentStart, node.end)))
    // A larger container holding a different item cannot authorize cross-row fields.
    if (linksInRecord.some(node => canonical(attr(node.attrs, 'href') ?? '', source.url) !== target)) return undefined
    if (item.fields.every(field => text(block).includes(text(field.quote)))) return block
    // The first container with record text is the boundary. Do not climb into
    // the surrounding list merely because a different row has the missing value.
    if (semantic || text(block) !== text(item.title)) return undefined
  }
  return undefined
}
export type WebArtifactEvidenceAssessment = { complete: boolean; reasons: string[]; sourceReceipts: Array<Omit<Source, 'content' | 'startedAt'>> }
export type WebArtifactSourceGate = {
  ready: boolean; missingOrigins: string[]; evidenceFingerprint: string
  failureEvidenceFingerprints: Record<string, string>
  reportManifestRequired: boolean
  collectionFreshness?: ObservedFeedCollectionFreshness
  nextReads: Array<{ origin: string; url: string; discovery: WebSourceReference }>
  reportReadiness?: { typedManifestProvided: boolean; reportEvidenceReady: boolean; declaredRecords: number; boundRecords: number; gaps: string[] }
}

function actualZeroMatch(task: TaskRun, source: Source | undefined, entry: WebArtifactEvidenceInput['noMatches'][number]): boolean {
  return Boolean(source && (!isObservedFeedReport(task) || source.full && !source.loadingObserved && !source.emptyObserved && !/加载中|正在加载|请稍[候等]|loading|aria-busy\s*=\s*["']true/i.test(source.content)) && text(task.goal).includes(text(entry.query)) && text(source.content).includes(text(entry.query)) &&
    text(source.content).includes(text(entry.quote)) && /共找到\s*0\s*条|暂无(?:相关)?(?:数据|记录|结果|公告)|no\s+(?:matching\s+)?results/i.test(entry.quote))
}

/** Publication readiness reuses the exact authenticated read extractor; it never verifies a report. */
export function webArtifactPublicationReadiness(repository: TaskRunRepository, task: TaskRun, items: TurnItem[], turns: Turn[], input?: WebArtifactEvidenceInput, allowedOrigins: string[] = [], progressInputs: readonly WebArtifactEvidenceInput[] = []): WebArtifactSourceGate {
  const history = sources(repository, task, items, turns), { available, epoch } = collectionSources(repository, task, items, turns, history)
  const baseline = isObservedFeedReport(task) && !epoch ? repository.operations(task.id).reverse().find(receipt =>
    ['web_artifact_evidence', 'web_artifact_source_gate'].includes(receipt.kind) && receipt.status === 'failed' && receipt.fingerprint === operationFingerprint(receipt.request) &&
    receipt.request?.requirementHash === webArtifactRequirementHash(task) && /^[a-f0-9]{64}$/.test(String(receipt.request.evidenceFingerprint)) && object(receipt.result).complete === false)?.request : undefined
  const material = (pool: Source[]) => [...new Set(pool.map(source => JSON.stringify({ url: source.url, resultHash: source.resultHash, full: source.full, title: source.title, ...(source.feedElement ? { feedElement: true } : {}) })))].sort()
  // Preserve the exact old fingerprint until an authorized collection has a real read.
  // Neither loading this version nor a receipt with the same bytes can reset a stall.
  const evidenceFingerprint = epoch ? operationFingerprint({ collection: epoch, sources: material(available.filter(actualCollectionRead)) }) : typeof baseline?.evidenceFingerprint === 'string' ? baseline.evidenceFingerprint : operationFingerprint(material(history))
  const required = task.acceptance.requiredSourceOrigins?.length ? task.acceptance.requiredSourceOrigins
    : [...new Set((input ? input.coverage : history).map(source => new URL(source.url).origin))]
  const covered = new Set<string>(), primary = needsPrimaryWebDocuments(task), feed = isObservedFeedReport(task)
  const qualifying = new Map<string, Set<string>>()
  const remember = (source: Source) => {
    const origin = new URL(source.url).origin
    const proofs = qualifying.get(origin) ?? new Set<string>()
    proofs.add(JSON.stringify({ url: source.url, resultHash: source.resultHash, full: source.full, title: source.title, ...(source.feedElement ? { feedElement: true } : {}), ...(epoch ? { collection: epoch } : {}) }))
    qualifying.set(origin, proofs)
  }
  const explicitlyRequested = (source: Source) => [...task.goal.matchAll(/https?:\/\/[^\s<>"'）)，。]+/gi)].some(match => canonical(match[0]) === source.url)
  const qualify = (proof: WebArtifactEvidenceInput, accept: (source: Source) => void, pool = available) => {
    const find = (reference: WebSourceReference) => findSource(pool, reference)
    if (!primary && !feed) for (const reference of proof.coverage) {
      const source = find(reference)
      if (source?.full) accept(source)
    }
    for (const item of proof.items) {
      const source = find(item.source), discovery = find(item.discovery)
      if (feed ? item.classification === 'source' && Boolean(feedRecord(source, discovery, item)) : source?.full && discovery && (explicitlyRequested(source) || source.url !== discovery.url && links(discovery.content, discovery.url).has(source.url)) &&
        sourceHasTitle(source, item.title) && (!isProcurementWebReport(task) || item.classification !== 'historical')) accept(source!)
    }
    for (const entry of proof.noMatches) {
      const source = find(entry.source)
      if ((!feed || source?.full) && actualZeroMatch(task, source, entry)) accept(source!)
    }
  }
  const cover = (source: Source) => { covered.add(new URL(source.url).origin); remember(source) }
  if (input) {
    qualify(input, cover)
  } else {
    // A homepage/list can be full and linked. Without a typed primary-source
    // manifest it must never stand in for a formal document or a query-zero proof.
    if (!primary && !feed) for (const source of available) if (source.full) cover(source)
  }
  // Recompute progress from authenticated source bytes and trusted prior typed
  // declarations. Dropping a manifest or changing its path cannot roll back a
  // completed source repair. This union never supplies current report coverage.
  if (isObservedFeedReport(task) && !epoch && input) qualify(input, remember, history)
  for (const prior of progressInputs) qualify(prior, remember, epoch ? available : history)
  const missingOrigins = required.filter(origin => !covered.has(origin))
  const nextReads: WebArtifactSourceGate['nextReads'] = []
  const seen = new Set<string>()
  // Feed recovery reads the owned current document; unrelated navigation links
  // must not replace the task's explicitly requested SPA hash route.
  if (!feed) for (const discovery of history) for (const url of links(discovery.content, discovery.url)) {
    const origin = new URL(url).origin
    if (!missingOrigins.includes(origin) || !allowedOrigins.includes(origin) || seen.has(url) || nextReads.length >= 20) continue
    seen.add(url); nextReads.push({ origin, url, discovery: { url: discovery.url, resultHash: discovery.resultHash } })
  }
  // A source deficit can advance only through the same primary/zero-match
  // predicate that actually covers that origin. Raw observations, truncated
  // lists, unrelated full pages and another origin's progress are not repairs.
  let failureEvidenceFingerprints = Object.fromEntries(required.map(origin => [
    `source_origin:${origin}`, operationFingerprint([...(qualifying.get(origin) ?? [])].sort())
  ]))
  const qualifiedFingerprint = operationFingerprint(required.flatMap(origin => [...(qualifying.get(origin) ?? [])]).sort())
  failureEvidenceFingerprints.source_manifest_required = qualifiedFingerprint
  failureEvidenceFingerprints.source_read_required = qualifiedFingerprint
  const preserved = object(baseline?.failureEvidenceFingerprints)
  if (Object.keys(preserved).length && Object.values(preserved).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) failureEvidenceFingerprints = preserved as Record<string, string>
  const collectionFreshness = observedFeedCollectionFreshness(repository, task, items, turns, allowedOrigins)
  let reportReadiness: WebArtifactSourceGate['reportReadiness']
  if (feed) {
    const gaps = new Set<string>(), declaredRecords = input?.items.length ?? 0
    if (!input) gaps.add('typed_manifest_required')
    if (collectionFreshness?.currentCollectionReady === false) gaps.add('current_source_read_required')
    let boundRecords = 0
    for (const item of input?.items ?? []) {
      const source = findSource(available, item.source), discovery = findSource(available, item.discovery)
      if (!source || !discovery) gaps.add('source_reference_unmatched')
      if (item.classification === 'source' && feedRecord(source, discovery, item)) boundRecords++
      else gaps.add('record_binding_required')
    }
    const zeroMatches = input?.noMatches.filter(entry => actualZeroMatch(task, findSource(available, entry.source), entry)).length ?? 0
    if (input && !declaredRecords && !input.noMatches.length) gaps.add('records_or_actual_zero_required')
    if (input && zeroMatches !== input.noMatches.length) gaps.add('actual_zero_unverified')
    if (missingOrigins.length) gaps.add('source_origin_unverified')
    reportReadiness = { typedManifestProvided: Boolean(input), declaredRecords, boundRecords,
      reportEvidenceReady: Boolean(input && !gaps.size && (boundRecords || zeroMatches)), gaps: [...gaps] }
    if (collectionFreshness) collectionFreshness.reportEvidenceReady = reportReadiness.reportEvidenceReady
  }
  return { ready: required.length > 0 && missingOrigins.length === 0, missingOrigins, evidenceFingerprint,
    failureEvidenceFingerprints, nextReads, reportManifestRequired: (primary || feed) && !input, ...(collectionFreshness ? { collectionFreshness } : {}), ...(reportReadiness ? { reportReadiness } : {}) }
}

/** Canonical validator failures exclude model-chosen section IDs and artifact byte churn. */
export function webArtifactFailureKinds(reasons: string[]): string[] {
  return [...new Set(reasons.map(reason => {
    const origin = /^(?:尚缺来源实际读取|正式公告正文尚未核验|订阅列表记录尚未核验)：(.+)$/.exec(reason)?.[1]
    if (origin) return `source_origin:${origin}`
    if (reason.startsWith('来源没有匹配的可信读取回执：')) return 'source_receipt'
    if (reason.startsWith('条目尚缺真实链接发现及完整正文读取：')) return 'primary_document'
    const field = /^字段缺少正文与成果的精确依据：.+\/(title|publication_date|budget|deadline|status|qualification|other)$/.exec(reason)?.[1]
    return field ? `field_evidence:${field}` : `validator:${reason}`
  }))].sort()
}

/** Read receipts prove immutable source bytes, never a model's source label or a homepage visit. */
function sources(repository: TaskRunRepository, task: TaskRun, items: TurnItem[], turns: Turn[]): Source[] {
  const result: Source[] = []
  for (const receipt of repository.operations(task.id, 'tool')) {
    if (receipt.status !== 'succeeded' || receipt.fingerprint !== operationFingerprint(receipt.request)) continue
    const host = object(receipt.result), saved = object(host.item), request = object(receipt.request)
    const item = items.find(item => item.kind === 'tool_result' && item.id === saved.id && item.callId === request.callId && item.turnId === request.turnId && item.toolName === request.toolName)
    if (host.approved !== true || !item || item.kind !== 'tool_result' || item.isError || operationFingerprint(item.output) !== operationFingerprint(saved.output)) continue
    const parsed = ExecutionGrantSchema.safeParse(request.executionGrant)
    if (!parsed.success) continue
    const grant = parsed.data, turn = turns.find(turn => turn.id === item.turnId)
    if (grant.taskId !== task.id || grant.threadId !== task.threadId || grant.turnId !== item.turnId || grant.workspaceRoot !== task.workspaceRoot ||
      !turn?.executionGrant || operationFingerprint(turn.executionGrant) !== operationFingerprint(grant) ||
      grant.allowedToolNames && !grant.allowedToolNames.includes(item.toolName) || grant.allowedProviderIds && !grant.allowedProviderIds.includes(String(request.providerId))) continue
    const at = Date.parse(receipt.createdAt), finished = Date.parse(receipt.updatedAt)
    if (!Number.isFinite(at) || !Number.isFinite(finished) || finished < at || Date.parse(grant.issuedAt) > at || grant.expiresAt && Date.parse(grant.expiresAt) < finished) continue
    const output = object(item.output), evidence = object(output.evidence)
    const browser = /^browser_(?:navigate|observe|get_html|read|extract|click)$/.test(item.toolName)
    const web = item.toolName === 'web_fetch'
    const ego = /^ego_browser_(?:open|read|next_page)$/.test(item.toolName) && request.providerId === 'ego-browser'
    if (ego) { try { if (!validEgoDocumentEvidence(repository, task, output, grant)) continue } catch { continue } }
    if ((!browser && !web && !ego) || browser && (request.providerId !== 'browser-skill' || output.status !== 'succeeded' || evidence.verified !== true || evidence.contentRead !== true)) continue
    const loadedResponse = output.sourceKind === 'actual_loaded_response'
    if (browser && output.sourceKind !== undefined && !loadedResponse) continue
    if ((output.readScope === 'response_document' || output.nativeProof !== undefined) && !loadedResponse) continue
    if (loadedResponse && (item.toolName !== 'browser_get_html' || object(request.arguments).target !== undefined || !validLoadedResponseEvidence(output, grant))) continue
    const url = canonical(String(browser || ego ? output.sourceUrl : output.finalUrl ?? output.url ?? ''))
    if (!url || task.acceptance.requiredSourceOrigins?.length && !task.acceptance.requiredSourceOrigins.includes(new URL(url).origin)) continue
    if (browser) {
      const scope = grant.browserScope
      if (!scope?.origins.includes(new URL(url).origin)) continue
      // A completed read retains its original scope. Rebinding does not reauthorize new actions.
      const sealed = (row: OperationReceipt | undefined | null) => Boolean(row && row.status === 'succeeded' && row.fingerprint === operationFingerprint(row.request) &&
        Number.isFinite(Date.parse(row.createdAt)) && Number.isFinite(Date.parse(row.updatedAt)) && Date.parse(row.updatedAt) >= Date.parse(row.createdAt) && Date.parse(row.updatedAt) <= at)
      let sourceTask = task
      if (task.scheduledBy || grant.browserScheduleBinding) {
        const captured = grant.browserScheduleBinding, preparation = repository.operation(task.threadId, 'scheduled-task-context')
        const sourceId = captured?.sourceTaskId ?? (task.scheduledBy?.scheduleId.startsWith('schedule_') ? task.scheduledBy.scheduleId.slice('schedule_'.length) : '')
        const original = sourceId ? repository.get(sourceId) : null
        if (!task.scheduledBy || !original || !sealed(preparation) || preparation!.kind !== 'scheduled_task_prepare' ||
          preparation!.request?.scheduleId !== task.scheduledBy.scheduleId || preparation!.request?.dueAt !== task.scheduledBy.dueAt ||
          typeof preparation!.request?.versionId !== 'string' || !preparation!.request.versionId || !grant.scheduleScopeHash ||
          captured && (captured.scheduleId !== task.scheduledBy.scheduleId || captured.versionId !== preparation!.request.versionId || captured.scopeHash !== grant.scheduleScopeHash)) continue
        sourceTask = original
        const authorityReceipt = repository.operations(sourceId, 'schedule_authority').find(row => sealed(row) && object(row.result).authorityHash === preparation!.request?.authorityHash)
        const authority = object(object(authorityReceipt?.result).authority), sourceScope = object(authority.scope), authorization = object(authority.authorization)
        // Match the persisted authority bytes, not a claimed scheduledBy flag or a newly invented approval.
        if (!authorityReceipt || hash(JSON.stringify(authority)) !== preparation!.request?.authorityHash || authority.taskId !== sourceId ||
          authority.prompt !== task.goal || original.goal !== task.goal || authorization.scopeHash !== grant.scheduleScopeHash || authorityReceipt.request?.scopeHash !== grant.scheduleScopeHash ||
          operationFingerprint(sourceScope.browserScope) !== operationFingerprint(scope) ||
          captured && captured.actionsHash !== hash(JSON.stringify(sourceScope.browserScheduleActions ?? [])) ||
          operationFingerprint(taskScheduleConnectorIdentities(sourceScope.connectorIdentityFingerprints)) !== operationFingerprint(taskScheduleConnectorIdentities(grant.connectorIdentityFingerprints))) continue
      }
      if (scope.publicQueryAuthorization) {
        const authority = taskPublicQueryAuthority(repository, task, scope, { historical: true, sourceTaskId: sourceTask.id })
        if (!authority || authority.source.goal !== task.goal || !sealed(authority.binding)) continue
      } else {
        const bindings = repository.operations(sourceTask.id, 'browser_binding').filter(row => row.request?.browserInstanceId === scope.browserInstanceId && row.request?.expectedBrowserRevision === scope.revision)
        if (bindings.length) {
          if (!bindings.some(row => sealed(row) && object(row.result).purpose === task.goal && Array.isArray(object(row.result).origins) &&
            (object(row.result).origins as string[]).includes(new URL(url).origin))) continue
        } else if (!/^[a-f0-9]{64}$/i.test(grant.connectorIdentityFingerprints?.['browser-skill'] ?? '')) continue
        // Configured observe-only readers and legacy per-action schedules had no higher-level binding.
        // Their successful read is authenticated by its sealed Turn grant/provider fingerprint;
        // this only preserves source bytes and never grants interaction or schedule dispatch rights.
      }
    } else if (!ego) {
      if (request.providerId !== 'web') continue
      try { assertGrantAllowsNetwork(url, { executionGrant: grant }) } catch { continue }
    }
    const content = typeof output.html === 'string' ? output.html : typeof output.text === 'string' ? output.text : String(object(object(output.observation).observation).text ?? '')
    if (!content.trim()) continue
    const resultHash = typeof output.resultHash === 'string' ? output.resultHash : web ? hash(content) : undefined
    if (!resultHash || !/^[a-f0-9]{64}$/i.test(resultHash)) continue
    if (typeof output.html === 'string' && hash(output.html) !== resultHash) continue
    const full = ego && output.readScope === 'document' || item.toolName === 'browser_get_html' && output.sourceKind === 'actual_loaded_response' && validLoadedResponseEvidence(output, grant) || web && output.truncated === false || item.toolName === 'browser_get_html' && output.truncated === false && (output.readScope === 'document' || output.readScope === undefined && /<html\b/i.test(content) && /<body\b/i.test(content) && /<\/html\s*>/i.test(content))
    result.push({ receiptId: receipt.id, receiptHash: operationFingerprint({ request: receipt.request, status: receipt.status, result: receipt.result }), turnId: item.turnId, url, resultHash, content, ...(loadedResponse && typeof output.title === 'string' ? { title: output.title } : {}), full, ...(ego && output.readScope === 'element' ? { feedElement: true } : {}), ...(output.loadingObserved === true ? { loadingObserved: true } : {}), ...(output.emptyObserved === true ? { emptyObserved: true } : {}), startedAt: receipt.createdAt, readAt: receipt.updatedAt })
  }
  return result
}

/** Private publication manifests may refer only to this task's authenticated source bytes. */
export function webArtifactManifestSourceProof(repository: TaskRunRepository, task: TaskRun, items: TurnItem[], turns: Turn[], input: WebArtifactEvidenceInput, sealedProof?: unknown) {
  const history = sources(repository, task, items, turns), used = new Map<string, Source>()
  const available = sealedProof === undefined ? collectionSources(repository, task, items, turns, history).available
    : history.filter(source => Array.isArray(sealedProof) && sealedProof.some(proof => object(proof).receiptId === source.receiptId && object(proof).receiptHash === source.receiptHash))
  const references = [...input.coverage, ...input.items.flatMap(item => [item.source, item.discovery]), ...input.noMatches.map(entry => entry.source)]
  for (const reference of references) {
    const source = findSource(available, reference)
    if (!source) throw Object.assign(new Error('发布清单引用的URL没有本任务可信来源读取回执。'), { code: 'artifact_manifest_source_proof_required' })
    used.set(source.receiptId, source)
  }
  return [...used.values()].map(source => ({ receiptId: source.receiptId, receiptHash: source.receiptHash })).sort((a, b) => a.receiptId.localeCompare(b.receiptId))
}

export function assessWebArtifactEvidence(repository: TaskRunRepository, task: TaskRun, items: TurnItem[], turns: Turn[], html: string, input: WebArtifactEvidenceInput, nowIso = new Date().toISOString()): WebArtifactEvidenceAssessment {
  const reasons: string[] = [], used = new Map<string, Source>(), history = sources(repository, task, items, turns),
    available = collectionSources(repository, task, items, turns, history).available, artifactLinks = links(html)
  const find = (reference: WebSourceReference) => {
    const source = findSource(available, reference)
    if (!source) reasons.push(`来源没有匹配的可信读取回执：${reference.url}`)
    else used.set(source.receiptId, source)
    return source
  }
  const coverage = input.coverage.map(find).filter((source): source is Source => Boolean(source)), origins = new Set(coverage.map(source => new URL(source.url).origin))
  for (const origin of task.acceptance.requiredSourceOrigins ?? []) if (!origins.has(origin)) reasons.push(`尚缺来源实际读取：${origin}`)
  for (const source of coverage) if (!artifactLinks.has(source.url)) reasons.push(`成果缺少已读来源入口：${source.url}`)
  const approvedText: HtmlNode[] = []
  const primaryOrigins = new Set<string>()
  const primary = needsPrimaryWebDocuments(task), feed = isObservedFeedReport(task), procurement = isProcurementWebReport(task), sectionIds = new Set<string>(), clean = markup(html), elements = nodes(clean)
  if (!elements) return { complete: false, reasons: ['HTML 节点超过 5000 个，来源验收未完成；请拆分报告后重新核验。'], sourceReceipts: [] }
  const reports = elements.filter(node => attr(node.attrs, 'data-evidence-report') !== undefined)
  if ((primary || feed) && reports.length !== 1) reasons.push('正式数据区须使用唯一 data-evidence-report 标记；旧网页继续保留为草稿。')
  const declared = new Set(input.items.map(item => item.sectionId))
  for (const node of elements) {
    const id = attr(node.attrs, 'data-evidence-item')
    if (id !== undefined && (!declared.has(id) || !reports.some(report => inside(node, report)))) reasons.push(`存在未声明或不在正式区内的报告条目：${id}`)
    if ((primary || feed) && node.tag === 'tr' && elements.some(child => child.tag === 'td' && inside(child, node)) && !id) reasons.push('表格存在未关联来源证据的数据行。')
  }
  for (const item of input.items) {
    if (sectionIds.has(item.sectionId)) reasons.push(`成果条目标识重复：${item.sectionId}`)
    sectionIds.add(item.sectionId)
    const source = find(item.source), discovery = find(item.discovery)
    const marked = elements.filter(node => attr(node.attrs, 'data-evidence-item') === item.sectionId)
    const node = marked.length === 1 ? marked[0] : undefined
    const block = node ? clean.slice(node.start, node.end) : undefined
    if (!node || !['tr', 'article', 'section'].includes(node.tag) || attr(node.attrs, 'id') !== item.sectionId ||
      attr(node.attrs, 'data-evidence-classification') !== item.classification || !reports.some(report => inside(node, report)) ||
      !block || !text(block).includes(text(item.title)) || !elements.some(link => link.tag === 'a' && inside(link, node) &&
        attr(link.attrs, 'data-evidence-source') !== undefined && canonical(attr(link.attrs, 'href') ?? '') === canonical(item.source.url))) reasons.push(`条目缺少对应正文链接、分类或标题标记：${item.sectionId}`)
    const fieldNodes = node ? elements.filter(field => inside(field, node) && attr(field.attrs, 'data-evidence-field') !== undefined) : []
    approvedText.push(...fieldNodes)
    if (node) approvedText.push(...elements.filter(link => link.tag === 'a' && inside(link, node) && attr(link.attrs, 'data-evidence-source') !== undefined && /^(?:原文|公告原文|查看原文|正式公告|来源|详情|列表来源|source|readsource)$/i.test(text(clean.slice(link.start, link.end)))))
    const fields = new Map(item.fields.map(field => [field.field, field]))
    if (fields.size !== item.fields.length) reasons.push(`字段声明重复：${item.sectionId}`)
    for (const fieldNode of fieldNodes) {
      const name = attr(fieldNode.attrs, 'data-evidence-field')!
      const unverified = attr(fieldNode.attrs, 'data-evidence-unverified') !== undefined
      if (unverified ? !item.unverifiedFields.includes(name as typeof item.unverifiedFields[number]) : !fields.has(name as typeof item.fields[number]['field'])) reasons.push(`存在未声明字段：${item.sectionId}/${name}`)
    }
    if (!source || !discovery) continue
    const record = feed ? feedRecord(source, discovery, item) : undefined
    if (feed) {
      if (item.classification !== 'source') reasons.push(`订阅列表只能标记为来源记录，不代表可投机会或采购意向：${item.sectionId}`)
      if (!record) reasons.push(`订阅记录缺少同一真实记录内的标题、日期及实际链接依据：${item.sectionId}`)
      if (!node || (item.recordUrl ? !elements.some(link => link.tag === 'a' && inside(link, node) && attr(link.attrs, 'data-evidence-record') !== undefined && canonical(attr(link.attrs, 'href') ?? '') === canonical(item.recordUrl ?? '') && text(clean.slice(link.contentStart, link.end)) === '条目链接（正文未读取）') : elements.some(link => inside(link, node) && attr(link.attrs, 'data-evidence-record') !== undefined) || !text(block!).includes('无独立条目链接（正文未读取）'))) reasons.push(`订阅条目链接缺失或未明确正文未读取：${item.sectionId}`)
      if (node) approvedText.push(...elements.filter(link => link.tag === 'a' && inside(link, node) && attr(link.attrs, 'data-evidence-record') !== undefined))
    } else if (item.recordUrl) reasons.push(`正文验收合同不能由订阅记录链接替代：${item.sectionId}`)
    // Discovery is actual returned HTML, not invented paths, model labels or the site's origin.
    if (procurement && item.classification === 'source') reasons.push(`采购报告条目必须区分机会、意向或历史：${item.sectionId}`)
    const explicitUrl = [...task.goal.matchAll(/https?:\/\/[^\s<>"'）)，。]+/gi)].some(match => canonical(match[0]) === source.url)
    const discovered = explicitUrl || source.url !== discovery.url && links(discovery.content, discovery.url).has(source.url)
    const deadline = item.fields.find(field => field.field === 'deadline')?.value
    if (item.classification === 'opportunity' && deadline) {
      const cutoff = evidenceDeadlineCutoff(deadline)
      if (cutoff === undefined || cutoff <= Date.parse(nowIso)) reasons.push(`当前机会缺少可核验的有效截止时间，请保留为历史或待核验：${item.sectionId}`)
    }
    if (item.classification === 'opportunity' && item.fields.some(field => field.field === 'status' && /已结束|已截止|已中标|已成交|已定标|已完成采购|closed|awarded/i.test(field.value))) reasons.push(`已结束条目不能标为当前机会：${item.sectionId}`)
    if (!feed && (!source.full || !discovered || !sourceHasTitle(source, item.title))) reasons.push(`条目尚缺真实链接发现及完整正文读取：${item.sectionId}`)
    if (feed ? Boolean(record) && item.classification === 'source' : source.full && discovered && (!procurement || item.classification !== 'historical')) primaryOrigins.add(new URL(source.url).origin)
    for (const field of item.fields) {
      const metadataTitle = !feed && field.field === 'title' && source.title && text(field.value) === text(source.title) && text(field.quote) === text(source.title)
      const bodyQuote = text(feed ? record ?? '' : source.content).includes(text(field.quote)) && text(field.quote).includes(text(field.value))
      if ((!metadataTitle && !bodyQuote) || !fieldNodes.some(node => attr(node.attrs, 'data-evidence-field') === field.field && attr(node.attrs, 'data-evidence-unverified') === undefined && text(clean.slice(node.start, node.end)) === text(field.value))) reasons.push(`字段缺少正文与成果的精确依据：${item.sectionId}/${field.field}`)
    }
    if (!item.fields.some(field => field.field === 'title' && text(field.value) === text(item.title))) reasons.push(`条目缺少正文标题证据：${item.sectionId}`)
    if (procurement && item.classification === 'opportunity' && !item.fields.some(field => ['deadline', 'status'].includes(field.field))) reasons.push(`当前可跟进条目缺少截止或有效状态证据：${item.sectionId}`)
    if (procurement || feed) for (const name of ['title', 'publication_date', 'budget', 'deadline', 'status', 'qualification'] as const) if (!fields.has(name) && !item.unverifiedFields.includes(name as typeof item.unverifiedFields[number])) reasons.push(`条目字段既无依据也无未核验标注：${item.sectionId}/${name}`)
    for (const field of item.unverifiedFields) if (!fieldNodes.some(node => attr(node.attrs, 'data-evidence-field') === field && attr(node.attrs, 'data-evidence-unverified') !== undefined && /^(?:待核验|未披露|未读取|unverified|notdisclosed)$/i.test(text(clean.slice(node.start, node.end)))) || item.fields.some(verified => verified.field === field)) reasons.push(`未核验字段标注冲突：${item.sectionId}/${field}`)
  }
  if (primary || feed) {
    const noMatchOrigins = new Set<string>()
    for (const entry of input.noMatches) {
      const source = find(entry.source)
      if ((!feed || source?.full) && actualZeroMatch(task, source, entry) && text(html).includes(text(entry.quote))) noMatchOrigins.add(new URL(entry.source.url).origin)
      else reasons.push(`未匹配结论缺少实际零结果页面：${entry.source.url}`)
    }
    for (const origin of task.acceptance.requiredSourceOrigins?.length ? task.acceptance.requiredSourceOrigins : origins) if (!primaryOrigins.has(origin) && !noMatchOrigins.has(origin)) reasons.push(`${feed ? '订阅列表记录尚未核验' : '正式公告正文尚未核验'}：${origin}`)
  }
  if ((primary || feed) && reports.length === 1) {
    const captions = new Set(['项目名称', '公告名称', '标题', '发布日期', '预算', '投标截止', '截止时间', '状态', '资格', '资质要求', '分类', '来源', '原文', '公告URL', '当前机会', '采购意向', '历史公告', '订阅记录', '列表标注日期', '匹配依据（列表原文）', '无独立条目链接（正文未读取）'])
    let previous = 0
    for (const tag of clean.matchAll(/<\/?[a-z][a-z0-9:-]*\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
      const start = previous, end = tag.index!, literal = text(clean.slice(start, end))
      previous = tag.index! + tag[0].length
      if (!literal || start < reports[0]!.contentStart || end > reports[0]!.end || approvedText.some(node => start >= node.contentStart && end <= node.end)) continue
      if (captions.has(literal.replace(/[：:]$/, '')) || input.noMatches.some(entry => text(entry.quote) === literal)) continue
      reasons.push('正式数据区存在未绑定字段证据的正文；请将事实放入已声明 data-evidence-field 或保留为区外未核验说明。')
    }
  }
  return { complete: reasons.length === 0, reasons: [...new Set(reasons)].slice(0, 30), sourceReceipts: [...used.values()].map(({ content: _content, startedAt: _startedAt, ...source }) => source) }
}

export function verifiedWebArtifactEvidence(repository: TaskRunRepository, task: TaskRun, artifact: TaskArtifact, writerReceiptId: string): OperationReceipt | undefined {
  return repository.operations(task.id, 'web_artifact_evidence').reverse().find(receipt => receipt.status === 'succeeded' && receipt.fingerprint === operationFingerprint(receipt.request) && receipt.request?.artifactHash === artifact.sha256 &&
    (!isObservedFeedReport(task) || receipt.request?.turnId === task.activeTurnId) &&
    receipt.request?.artifactPath === (artifact.absolutePath ?? artifact.relativePath) && receipt.request.writerReceiptId === writerReceiptId &&
    receipt.request.requirementHash === webArtifactRequirementHash(task) && object(receipt.result).complete === true &&
    Array.isArray(object(receipt.result).sourceReceipts) && (object(receipt.result).sourceReceipts as Array<Record<string, unknown>>).every(reference => {
      const source = repository.operations(task.id, 'tool').find(source => source.id === reference.receiptId)
      return source?.status === 'succeeded' && (!isObservedFeedReport(task) || source.request?.turnId === task.activeTurnId) && operationFingerprint({ request: source.request, status: source.status, result: source.result }) === reference.receiptHash
    }))
}

export function webEvidenceRepair(task: TaskRun): string {
  if (isObservedFeedReport(task)) return '本任务只汇总用户已授权的订阅列表，不核验条目链接的官方正文。先用已授权工具实际完整读取所需列表；report的每条item必须classification=source，source和discovery为同一已读列表URL/resultHash，recordUrl仅在实际观察到该记录href时填写；无href时省略并显示无独立条目链接，仍须唯一标题与同记录结构容器。title、日期和所有quote必须位于同一实际记录容器，不得跨行拼字段或猜链接；value逐字取自quote且HTML由同一report生成。预算、截止、状态、资质等未知字段列入unverifiedFields并显示待核验，不能标成当前机会或采购意向。仅实际完整零结果页才能使用noMatches，截断/登录/超时不是零结果；未读分页不得声称全量。使用publish_artifact的report模式保留列表数据/正文未核验说明，再read_artifact并显式调用verify_web_artifact返回的verificationInput；发布仍是草稿，不自动完成。不得通过更换文件名或改manifest清除原缺失证据。'
  return `成果文件已保留为草稿，但尚未通过来源验收。继续原任务，使用已授权工具实际读取${(task.acceptance.requiredSourceOrigins ?? []).join('、') || '所需来源'}；使用 browser_get_html 读取真实结果链接元素以取得 href，再打开并完整读取正文。遇到SVG/iframe使HTML截断或缺body时，browser_get_html会在原授权内自动检查本会话已加载且身份匹配的完整原文响应。sourceKind=actual_loaded_response是独立的响应文档表示，不是完整DOM；未取得完整响应仍须保持草稿，不重复导航。更新同一成果文件，逐条提供原文URL、实际字段与原文依据。value必须是quote中的逐字连续原文片段（仅忽略空白），quote必须实际存在于已读正文；仅经独立原生标题与响应JSON共同核验的actual_loaded_response标题，可将完整实际metadata标题同时用作title的value和quote，其它字段仍只能引用正文。HTML中data-evidence-field的可见文本须直接等于同一value。不要把日期改为ISO、给金额增加限定词、推断状态或改写资质。网页采集首次发布必须使用publish_artifact的report结构化模式，从同一typed数据生成HTML并返回verificationInput，再显式调用verify_web_artifact；仅同一文件已有可信核验输入时可用legacy content修复，普通本地HTML/SVG创作不受此限制。发布仍是草稿，不会自动完成。不能逐字支持的字段须从fields删除，列入unverifiedFields，并只显示带data-evidence-unverified的“待核验”；同一字段不得两边同时声明。title、真实发现链接、完整正文与必需来源不能用待核验替代。历史合同、采购意向和当前可投标公告分开。调用 verify_web_artifact(path, coverage[{url,resultHash}], items[{sectionId,title,source,discovery,classification,fields[{field,value,quote}],unverifiedFields}]) 核验。正式数据区使用main[data-evidence-report]；每个tr/article/section同时用id及data-evidence-item=sectionId、data-evidence-classification，正文链接加data-evidence-source。每个title/publication_date/budget/deadline/status/qualification值用data-evidence-field对应字段名，未读字段再加data-evidence-unverified并写待核验。所有报告数据行/条目/字段都须声明，不能用一条真实数据为其余旧草稿背书。只有实际列表明确零匹配才使用noMatches；不能虚构线索。待核验不等于已完成核验；不要让用户手工搜索或复制网页。有效跨Turn原文回执可以复用，无须无条件重采。只有真实登录、权限或网络阻断才说明影响并等待；不得凭旧入口访问或自写说明完成任务。`
}
