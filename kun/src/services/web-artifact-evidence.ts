import { createHash } from 'node:crypto'
import { taskScheduleConnectorIdentities } from '../contracts/task-schedule-policy.js'
import type { TaskRun, TaskArtifact, OperationReceipt } from '../contracts/tasks.js'
import type { Turn } from '../contracts/turns.js'
import type { TurnItem } from '../contracts/items.js'
import type { WebArtifactEvidenceInput, WebSourceReference } from '../contracts/web-artifact-evidence.js'
import { validLoadedResponseEvidence } from './browser-loaded-response.js'
import { taskPublicQueryAuthority } from './browser-public-query-authority.js'
import { assertGrantAllowsNetwork } from '../adapters/tool/sandbox-policy.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { operationFingerprint, type TaskRunRepository } from './task-run-repository.js'

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export const webArtifactRequirementHash = (task: TaskRun) => operationFingerprint({ goal: task.goal, acceptance: task.acceptance })
export const isProcurementWebReport = (task: TaskRun) => /招标|投标|采购|tender|procurement/i.test(task.goal)
export const needsPrimaryWebDocuments = (task: TaskRun) => /招标|投标|采购|公告|正文|详情|primary\s+(?:source|document)|tender|procurement/i.test(task.goal)
const decode = (value: string) => value.replace(/&#(?:x([a-f0-9]+)|(\d+));/gi, (_, hex, decimal) => { const code = parseInt(hex ?? decimal, hex ? 16 : 10); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '' }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[key as 'amp'])
const markup = (value: string) => value.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
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

type Source = { receiptId: string; receiptHash: string; turnId: string; url: string; resultHash: string; content: string; full: boolean; readAt: string }
export type WebArtifactEvidenceAssessment = { complete: boolean; reasons: string[]; sourceReceipts: Array<Omit<Source, 'content'>> }

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
    if ((!browser && !web) || browser && (request.providerId !== 'browser-skill' || output.status !== 'succeeded' || evidence.verified !== true || evidence.contentRead !== true)) continue
    const loadedResponse = output.sourceKind === 'actual_loaded_response'
    if (browser && output.sourceKind !== undefined && !loadedResponse) continue
    if ((output.readScope === 'response_document' || output.nativeProof !== undefined) && !loadedResponse) continue
    if (loadedResponse && (item.toolName !== 'browser_get_html' || object(request.arguments).target !== undefined || !validLoadedResponseEvidence(output, grant))) continue
    const url = canonical(String(browser ? output.sourceUrl : output.finalUrl ?? output.url ?? ''))
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
    } else {
      if (request.providerId !== 'web') continue
      try { assertGrantAllowsNetwork(url, { executionGrant: grant }) } catch { continue }
    }
    const content = typeof output.html === 'string' ? output.html : typeof output.text === 'string' ? output.text : String(object(object(output.observation).observation).text ?? '')
    if (!content.trim()) continue
    const resultHash = typeof output.resultHash === 'string' ? output.resultHash : web ? hash(content) : undefined
    if (!resultHash || !/^[a-f0-9]{64}$/i.test(resultHash)) continue
    if (typeof output.html === 'string' && hash(output.html) !== resultHash) continue
    const full = item.toolName === 'browser_get_html' && output.sourceKind === 'actual_loaded_response' && validLoadedResponseEvidence(output, grant) || web && output.truncated === false || item.toolName === 'browser_get_html' && output.truncated === false && (output.readScope === 'document' || output.readScope === undefined && /<html\b/i.test(content) && /<body\b/i.test(content) && /<\/html\s*>/i.test(content))
    result.push({ receiptId: receipt.id, receiptHash: operationFingerprint({ request: receipt.request, status: receipt.status, result: receipt.result }), turnId: item.turnId, url, resultHash, content, full, readAt: receipt.updatedAt })
  }
  return result
}

export function assessWebArtifactEvidence(repository: TaskRunRepository, task: TaskRun, items: TurnItem[], turns: Turn[], html: string, input: WebArtifactEvidenceInput, nowIso = new Date().toISOString()): WebArtifactEvidenceAssessment {
  const reasons: string[] = [], used = new Map<string, Source>(), available = sources(repository, task, items, turns), artifactLinks = links(html)
  const find = (reference: WebSourceReference) => {
    const source = available.find(source => source.url === canonical(reference.url) && source.resultHash === reference.resultHash)
    if (!source) reasons.push(`来源没有匹配的可信读取回执：${reference.url}`)
    else used.set(source.receiptId, source)
    return source
  }
  const coverage = input.coverage.map(find).filter((source): source is Source => Boolean(source)), origins = new Set(coverage.map(source => new URL(source.url).origin))
  for (const origin of task.acceptance.requiredSourceOrigins ?? []) if (!origins.has(origin)) reasons.push(`尚缺来源实际读取：${origin}`)
  for (const source of coverage) if (!artifactLinks.has(source.url)) reasons.push(`成果缺少已读来源入口：${source.url}`)
  const approvedText: HtmlNode[] = []
  const primaryOrigins = new Set<string>()
  const primary = needsPrimaryWebDocuments(task), procurement = isProcurementWebReport(task), sectionIds = new Set<string>(), clean = markup(html), elements = nodes(clean)
  if (!elements) return { complete: false, reasons: ['HTML 节点超过 5000 个，来源验收未完成；请拆分报告后重新核验。'], sourceReceipts: [] }
  const reports = elements.filter(node => attr(node.attrs, 'data-evidence-report') !== undefined)
  if (primary && reports.length !== 1) reasons.push('正式数据区须使用唯一 data-evidence-report 标记；旧网页继续保留为草稿。')
  const declared = new Set(input.items.map(item => item.sectionId))
  for (const node of elements) {
    const id = attr(node.attrs, 'data-evidence-item')
    if (id !== undefined && (!declared.has(id) || !reports.some(report => inside(node, report)))) reasons.push(`存在未声明或不在正式区内的报告条目：${id}`)
    if (primary && node.tag === 'tr' && elements.some(child => child.tag === 'td' && inside(child, node)) && !id) reasons.push('表格存在未关联来源证据的数据行。')
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
    if (node) approvedText.push(...elements.filter(link => link.tag === 'a' && inside(link, node) && attr(link.attrs, 'data-evidence-source') !== undefined && /^(?:原文|公告原文|查看原文|正式公告|来源|详情|source|readsource)$/i.test(text(clean.slice(link.start, link.end)))))
    const fields = new Map(item.fields.map(field => [field.field, field]))
    if (fields.size !== item.fields.length) reasons.push(`字段声明重复：${item.sectionId}`)
    for (const fieldNode of fieldNodes) {
      const name = attr(fieldNode.attrs, 'data-evidence-field')!
      const unverified = attr(fieldNode.attrs, 'data-evidence-unverified') !== undefined
      if (unverified ? !item.unverifiedFields.includes(name as typeof item.unverifiedFields[number]) : !fields.has(name as typeof item.fields[number]['field'])) reasons.push(`存在未声明字段：${item.sectionId}/${name}`)
    }
    if (!source || !discovery) continue
    // Discovery is actual returned HTML, not invented paths, model labels or the site's origin.
    if (procurement && item.classification === 'source') reasons.push(`采购报告条目必须区分机会、意向或历史：${item.sectionId}`)
    const explicitUrl = [...task.goal.matchAll(/https?:\/\/[^\s<>"'）)，。]+/gi)].some(match => canonical(match[0]) === source.url)
    const discovered = explicitUrl || source.url !== discovery.url && links(discovery.content, discovery.url).has(source.url)
    const deadline = item.fields.find(field => field.field === 'deadline')?.value
    if (item.classification === 'opportunity' && deadline) {
      const match = /(20\d{2})[-年](\d{1,2})[-月](\d{1,2})(?:日)?(?:[T\s]*(\d{1,2})[:：](\d{2}))?/.exec(deadline)
      const calendar = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : undefined
      const calendarValid = Boolean(match && calendar?.getUTCFullYear() === Number(match[1]) && calendar?.getUTCMonth() === Number(match[2]) - 1 && calendar?.getUTCDate() === Number(match[3]) && Number(match[4] ?? '23') < 24 && Number(match[5] ?? '59') < 60)
      const cutoff = match && calendarValid ? Date.parse(`${match[1]}-${match[2]!.padStart(2, '0')}-${match[3]!.padStart(2, '0')}T${(match[4] ?? '23').padStart(2, '0')}:${match[5] ?? '59'}:59+08:00`) : NaN
      if (!Number.isFinite(cutoff) || cutoff <= Date.parse(nowIso)) reasons.push(`当前机会缺少可核验的有效截止时间，请保留为历史或待核验：${item.sectionId}`)
    }
    if (item.classification === 'opportunity' && item.fields.some(field => field.field === 'status' && /已结束|已截止|已中标|已成交|已定标|已完成采购|closed|awarded/i.test(field.value))) reasons.push(`已结束条目不能标为当前机会：${item.sectionId}`)
    if (!source.full || !discovered || !text(source.content).includes(text(item.title))) reasons.push(`条目尚缺真实链接发现及完整正文读取：${item.sectionId}`)
    if (source.full && discovered && (!procurement || item.classification !== 'historical')) primaryOrigins.add(new URL(source.url).origin)
    for (const field of item.fields) {
      if (!text(source.content).includes(text(field.quote)) || !text(field.quote).includes(text(field.value)) || !fieldNodes.some(node => attr(node.attrs, 'data-evidence-field') === field.field && attr(node.attrs, 'data-evidence-unverified') === undefined && text(clean.slice(node.start, node.end)) === text(field.value))) reasons.push(`字段缺少正文与成果的精确依据：${item.sectionId}/${field.field}`)
    }
    if (!item.fields.some(field => field.field === 'title' && text(field.value) === text(item.title))) reasons.push(`条目缺少正文标题证据：${item.sectionId}`)
    if (procurement && item.classification === 'opportunity' && !item.fields.some(field => ['deadline', 'status'].includes(field.field))) reasons.push(`当前可跟进条目缺少截止或有效状态证据：${item.sectionId}`)
    if (procurement) for (const name of ['title', 'publication_date', 'budget', 'deadline', 'status', 'qualification'] as const) if (!fields.has(name) && !item.unverifiedFields.includes(name as typeof item.unverifiedFields[number])) reasons.push(`条目字段既无依据也无未核验标注：${item.sectionId}/${name}`)
    for (const field of item.unverifiedFields) if (!fieldNodes.some(node => attr(node.attrs, 'data-evidence-field') === field && attr(node.attrs, 'data-evidence-unverified') !== undefined && /^(?:待核验|未披露|未读取|unverified|notdisclosed)$/i.test(text(clean.slice(node.start, node.end)))) || item.fields.some(verified => verified.field === field)) reasons.push(`未核验字段标注冲突：${item.sectionId}/${field}`)
  }
  if (primary) {
    const noMatchOrigins = new Set<string>()
    for (const entry of input.noMatches) {
      const source = find(entry.source)
      if (source && text(task.goal).includes(text(entry.query)) && text(source.content).includes(text(entry.query)) && text(source.content).includes(text(entry.quote)) && /共找到\s*0\s*条|暂无(?:相关)?(?:数据|记录|结果|公告)|no\s+(?:matching\s+)?results/i.test(entry.quote) && text(html).includes(text(entry.quote))) noMatchOrigins.add(new URL(source.url).origin)
      else reasons.push(`未匹配结论缺少实际零结果页面：${entry.source.url}`)
    }
    for (const origin of task.acceptance.requiredSourceOrigins?.length ? task.acceptance.requiredSourceOrigins : origins) if (!primaryOrigins.has(origin) && !noMatchOrigins.has(origin)) reasons.push(`正式公告正文尚未核验：${origin}`)
  }
  if (primary && reports.length === 1) {
    const captions = new Set(['项目名称', '公告名称', '标题', '发布日期', '预算', '投标截止', '截止时间', '状态', '资格', '资质要求', '分类', '来源', '原文', '公告URL', '当前机会', '采购意向', '历史公告'])
    let previous = 0
    for (const tag of clean.matchAll(/<\/?[a-z][a-z0-9:-]*\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
      const start = previous, end = tag.index!, literal = text(clean.slice(start, end))
      previous = tag.index! + tag[0].length
      if (!literal || start < reports[0]!.contentStart || end > reports[0]!.end || approvedText.some(node => start >= node.contentStart && end <= node.end)) continue
      if (captions.has(literal.replace(/[：:]$/, '')) || input.noMatches.some(entry => text(entry.quote) === literal)) continue
      reasons.push('正式数据区存在未绑定字段证据的正文；请将事实放入已声明 data-evidence-field 或保留为区外未核验说明。')
    }
  }
  return { complete: reasons.length === 0, reasons: [...new Set(reasons)].slice(0, 30), sourceReceipts: [...used.values()].map(({ content: _content, ...source }) => source) }
}

export function verifiedWebArtifactEvidence(repository: TaskRunRepository, task: TaskRun, artifact: TaskArtifact, writerReceiptId: string): OperationReceipt | undefined {
  return repository.operations(task.id, 'web_artifact_evidence').reverse().find(receipt => receipt.status === 'succeeded' && receipt.fingerprint === operationFingerprint(receipt.request) && receipt.request?.artifactHash === artifact.sha256 &&
    receipt.request?.artifactPath === (artifact.absolutePath ?? artifact.relativePath) && receipt.request.writerReceiptId === writerReceiptId &&
    receipt.request.requirementHash === webArtifactRequirementHash(task) && object(receipt.result).complete === true &&
    Array.isArray(object(receipt.result).sourceReceipts) && (object(receipt.result).sourceReceipts as Array<Record<string, unknown>>).every(reference => {
      const source = repository.operations(task.id, 'tool').find(source => source.id === reference.receiptId)
      return source?.status === 'succeeded' && operationFingerprint({ request: source.request, status: source.status, result: source.result }) === reference.receiptHash
    }))
}

export function webEvidenceRepair(task: TaskRun): string {
  return `成果文件已保留为草稿，但尚未通过来源验收。继续原任务，使用已授权工具实际读取${(task.acceptance.requiredSourceOrigins ?? []).join('、') || '所需来源'}；使用 browser_get_html 读取真实结果链接元素以取得 href，再打开并完整读取正文。遇到SVG/iframe使HTML截断或缺body时，browser_get_html会在原授权内自动检查本会话已加载且身份匹配的完整原文响应。sourceKind=actual_loaded_response是独立的响应文档表示，不是完整DOM；未取得完整响应仍须保持草稿，不重复导航。更新同一成果文件，逐条提供原文URL、实际字段与原文依据；历史合同、采购意向和当前可投标公告分开。调用 verify_web_artifact(path, coverage[{url,resultHash}], items[{sectionId,title,source,discovery,classification,fields[{field,value,quote}],unverifiedFields}]) 核验。正式数据区使用main[data-evidence-report]；每个tr/article/section同时用id及data-evidence-item=sectionId、data-evidence-classification，正文链接加data-evidence-source。每个title/publication_date/budget/deadline/status/qualification值用data-evidence-field对应字段名，未读字段再加data-evidence-unverified并写待核验。所有报告数据行/条目/字段都须声明，不能用一条真实数据为其余旧草稿背书。只有实际列表明确零匹配才使用noMatches；不能虚构线索。待核验不等于已完成核验；不要让用户手工搜索或复制网页。有效跨Turn原文回执可以复用，无须无条件重采。只有真实登录、权限或网络阻断才说明影响并等待；不得凭旧入口访问或自写说明完成任务。`
}
