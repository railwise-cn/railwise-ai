import { z } from 'zod'
import { WebArtifactEvidenceInputSchema, evidenceDisplayText } from '../contracts/web-artifact-evidence.js'

const ScreeningSchema = z.object({
  sectionId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/),
  decision: z.enum(['relevant', 'excluded', 'pending']),
  reason: z.string().trim().min(1).max(1200),
  businessTypes: z.array(z.string().trim().min(1).max(80)).max(8).optional(),
  region: z.string().trim().min(1).max(120).optional()
}).strict()

/** Layout and evidence share one typed manifest. Rendering does not attest source authenticity. */
export const StructuredWebReportSchema = z.object({
  title: z.string().trim().min(1).max(160),
  collectedAt: z.string().datetime({ offset: true }).optional(),
  presentation: z.object({
    summary: z.string().trim().min(1).max(1200).optional(),
    coverageNote: z.string().trim().min(1).max(1200).optional(),
    screening: z.array(ScreeningSchema).max(100).optional()
  }).strict().optional(),
  evidence: z.object({
    coverage: WebArtifactEvidenceInputSchema.shape.coverage,
    items: WebArtifactEvidenceInputSchema.shape.items,
    noMatches: WebArtifactEvidenceInputSchema.shape.noMatches
  }).strict()
}).strict().superRefine((report, context) => {
  const itemIds = new Set(report.evidence.items.map(item => item.sectionId)), screened = new Set<string>()
  for (const [index, entry] of (report.presentation?.screening ?? []).entries()) {
    const path = ['presentation', 'screening', index, 'sectionId']
    if (!itemIds.has(entry.sectionId)) context.addIssue({ code: 'custom', path, message: 'Screening must reference an existing evidence sectionId.' })
    if (screened.has(entry.sectionId)) context.addIssue({ code: 'custom', path, message: 'Each evidence item may have only one AI screening decision.' })
    screened.add(entry.sectionId)
  }
})

export type StructuredWebReport = z.infer<typeof StructuredWebReportSchema>
const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const labels: Record<string, string> = { title: '项目名称', publication_date: '发布日期', budget: '预算', deadline: '截止时间', status: '状态', qualification: '资质要求', other: '原文' }
const classifications = { opportunity: '当前机会', intent: '采购意向', historical: '历史公告', source: '来源' }
const fieldOrder = ['title', 'publication_date', 'budget', 'deadline', 'status', 'qualification', 'other']
const screeningOrder = ['relevant', 'pending', 'excluded'] as const
const screeningLabels = { relevant: '相关记录', pending: '待判断', excluded: '排除附录' }
const decisionLabels = { relevant: '相关', pending: '待判断', excluded: '排除' }

export function renderStructuredWebReport(path: string, value: StructuredWebReport, basis?: 'primary_document' | 'observed_feed') {
  const feed = basis === 'observed_feed'
  const report = StructuredWebReportSchema.parse(value)
  const evidence = feed ? { ...report.evidence, items: report.evidence.items.map(item => {
    if (item.fields.some(field => field.field === 'title')) return item
    // The required name must appear in both the page and its candidate manifest.
    // This proposes literal evidence; the authenticated same-record check still decides truth.
    const quote = item.title.length >= 12 ? item.title : item.fields.find(field => field.quote.includes(item.title))?.quote
    if (!quote) throw Object.assign(new Error('订阅记录标题较短，请提供同一记录中包含完整标题的原文 title quote（至少12个字符）。'), { code: 'artifact_title_quote_required' })
    return { ...item, fields: [{ field: 'title' as const, value: item.title, quote }, ...item.fields] }
  }) } : report.evidence
  const verificationInput = WebArtifactEvidenceInputSchema.parse({ path, ...evidence })
  const sourceLinks = verificationInput.coverage.map(source => `<a href="${escape(source.url)}">${escape(new URL(source.url).hostname)}</a>`).join('')
  const hasScreening = report.presentation?.screening !== undefined
  const screening = new Map((report.presentation?.screening ?? []).map(entry => [entry.sectionId, entry]))
  const groups = screeningOrder.map(decision => ({ decision, items: verificationInput.items.filter(item => (screening.get(item.sectionId)?.decision ?? 'pending') === decision) }))
  const orderedItems = hasScreening ? groups.flatMap(group => group.items) : verificationInput.items
  // AI interpretation stays outside the formal evidence region. Source verification
  // continues to inspect exactly the original literal fields and neutral classes.
  const businessSummary = hasScreening ? `<section class="screening" data-report-presentation="screening" aria-labelledby="ai-screening-title"><h2 id="ai-screening-title">AI筛选参考</h2><p class="screening-note">以下为AI筛选判断，不代表已核验事实、资质认定或投标资格。原始列表字段见来源附录。</p><div class="screening-counts">${groups.map(group => `<span data-screening-count="${group.decision}">${screeningLabels[group.decision]}：${group.items.length}</span>`).join('')}</div>${groups.filter(group => group.items.length).map(group => `<section class="screening-group" data-screening-group="${group.decision}"><h3>${screeningLabels[group.decision]}（${group.items.length}）</h3><div class="screening-cards">${group.items.map(item => {
    const entry = screening.get(item.sectionId)
    return `<section class="screening-card" data-report-screening-item="${item.sectionId}" data-screening-decision="${group.decision}"><p class="screening-decision">AI判断：${decisionLabels[group.decision]}</p><h4><a href="#${item.sectionId}">${escape(evidenceDisplayText(item.title))}</a></h4><p><strong>AI筛选理由：</strong>${escape(entry?.reason ?? '本条尚未提供AI筛选判断。')}</p><p><strong>AI业务类型判断：</strong>${escape(entry?.businessTypes?.length ? entry.businessTypes.join('、') : '未判断')}</p><p><strong>AI区域判断：</strong>${escape(entry?.region ?? '未判断')}</p><a class="evidence-jump" href="#${item.sectionId}">查看来源字段</a></section>`
  }).join('')}</div></section>`).join('')}</section>` : ''
  const cards = orderedItems.map(item => {
    const fields = [...item.fields].sort((a, b) => fieldOrder.indexOf(a.field) - fieldOrder.indexOf(b.field)).map(field => `<div class="field"><dt>${escape(feed && field.field === 'publication_date' ? '列表标注日期' : feed && field.field === 'other' ? '列表原文摘录' : labels[field.field]!)}</dt><dd><span data-evidence-field="${field.field}">${escape(evidenceDisplayText(field.value))}</span></dd></div>`).join('')
    const unknown = item.unverifiedFields.map(field => `<div class="field"><dt>${escape(feed && field === 'publication_date' ? '列表标注日期' : labels[field]!)}</dt><dd><span data-evidence-field="${field}" data-evidence-unverified>待核验</span></dd></div>`).join('')
    return `<article id="${item.sectionId}" data-evidence-item="${item.sectionId}" data-evidence-classification="${item.classification}"><p class="classification">${feed ? '订阅记录' : classifications[item.classification]}</p><dl>${fields}${unknown}</dl><a data-evidence-source href="${escape(item.source.url)}">${feed ? '列表来源' : '公告原文'}</a>${feed ? item.recordUrl ? `<a data-evidence-record href="${escape(item.recordUrl)}">条目链接（正文未读取）</a>` : '<p>无独立条目链接（正文未读取）</p>' : ''}</article>`
  }).join('')
  const empty = verificationInput.noMatches.map(entry => `<p class="empty">${escape(entry.quote)}</p>`).join('')
  const content = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(report.title)}</title><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#142638;background:#f3f6fa;color-scheme:light}*{box-sizing:border-box}body{margin:0;line-height:1.65}.page{max-width:1080px;margin:0 auto;padding:32px 24px 48px}header{margin-bottom:24px}h1{font-size:clamp(22px,3vw,30px);line-height:1.35;letter-spacing:-.02em;margin:0 0 12px;overflow-wrap:anywhere}h2{font-size:22px;margin:0 0 8px}h3{font-size:18px;margin:0 0 12px}h4{font-size:17px;line-height:1.5;margin:0 0 12px}.status{display:inline-block;border-radius:30px;padding:4px 12px;background:#fff1cc;color:#735013;font-size:13px}.meta,.screening-note,.source-note{color:#596d80;font-size:13px}.report-summary,.coverage-note{white-space:pre-wrap;overflow-wrap:anywhere}.report-summary{margin:12px 0}.coverage-note{border-left:3px solid #bdcddb;padding-left:12px;font-size:14px}.sources{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}a{color:#135d95;text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere}.sources a{padding:6px 12px;background:#fff;border:1px solid #dce4ed;border-radius:8px;font-size:13px}.screening{margin:28px 0 36px}.screening-counts{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 20px}.screening-counts span{background:#e8eef4;border-radius:6px;padding:5px 10px;font-size:13px}.screening-group{margin-top:24px}.screening-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.screening-card{background:#fff;border:1px solid #dce4ed;border-radius:12px;padding:18px;min-width:0}.screening-card p{font-size:14px;margin:8px 0;overflow-wrap:anywhere}.screening-card strong{font-weight:600}.screening-card .screening-decision{font-size:12px;font-weight:650;color:#285878;margin:0 0 8px}.screening-card[data-screening-decision="excluded"]{border-left:3px solid #a8afb8}.screening-card[data-screening-decision="pending"]{border-left:3px solid #bd9441}.evidence-jump{font-size:13px}.source-heading{margin:30px 0 16px}main{display:grid;gap:14px}article{background:#fff;border:1px solid #dce4ed;border-radius:12px;padding:20px;scroll-margin-top:16px}.classification{display:inline-block;margin:0 0 12px;padding:2px 9px;border-radius:20px;background:#e9f2f9;color:#216e9b;font-size:12px}dl{margin:0}.field{display:grid;grid-template-columns:110px minmax(0,1fr);gap:14px;border-bottom:1px solid #edf0f4;padding:8px 0}.field:first-child{padding-top:0}.field:first-child dd{font-size:17px;font-weight:650}.field:last-child{border:0}dt{color:#6b7d8d;font-size:13px}dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}article>a{display:inline-block;margin-top:10px;font-size:13px}[data-evidence-unverified]{color:#8a6414}.empty{background:#fff;padding:18px;border:1px solid #dce4ed;border-radius:12px}footer{font-size:12px;color:#6b7d8d;margin-top:24px}@media(max-width:560px){.page{padding:24px 16px 36px}.screening-cards{grid-template-columns:1fr}.screening-card,article{padding:16px}.field{grid-template-columns:1fr;gap:2px}}@media print{:root{background:#fff;color:#111}.page{max-width:none;padding:0}.screening-cards,main{display:block}.screening-card,article{break-inside:avoid;page-break-inside:avoid;border-color:#aaa;margin:0 0 12px;box-shadow:none}h2,h3,h4{break-after:avoid}a{color:inherit}.screening-counts span,.classification,.status{background:transparent;border:1px solid #aaa}footer{margin-top:16px}}
</style></head><body><div class="page"><header><p class="status">${feed ? '列表数据 / 正文未核验' : '原文摘录与待核验项'}</p><h1>${escape(report.title)}</h1>${report.presentation?.summary ? `<p class="report-summary" data-report-presentation="summary">${escape(report.presentation.summary)}</p>` : ''}${report.presentation?.coverageNote ? `<p class="coverage-note" data-report-presentation="coverage"><strong>覆盖说明（AI整理）：</strong>${escape(report.presentation.coverageNote)}</p>` : ''}${report.collectedAt ? `<p class="meta">报告标注时间：${escape(report.collectedAt)}</p>` : ''}${feed ? `<p class="meta">本报告列出 ${verificationInput.items.length} 条列表记录，关联 ${new Set(verificationInput.coverage.map(source => source.url)).size} 个来源页面；后续分页覆盖尚未确认，不代表今日全量。</p>` : ''}<nav class="sources" aria-label="检索来源">${sourceLinks}</nav></header>${businessSummary}${hasScreening ? '<section class="source-heading"><h2>来源字段附录</h2><p class="source-note">以下保留实际列表字段及待核验项，AI筛选判断不属于来源事实核验。</p></section>' : ''}<main data-evidence-report>${cards}${empty}</main><footer>来源核验以应用任务中的验证回执为准。</footer></div></body></html>`
  if (content.length > 8 * 1024 * 1024) throw new Error('结构化报告超过受管理成果的内容上限，请拆分报告。')
  return { content, verificationInput }
}
