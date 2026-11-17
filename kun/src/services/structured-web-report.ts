import { z } from 'zod'
import { WebArtifactEvidenceInputSchema, evidenceDisplayText } from '../contracts/web-artifact-evidence.js'

/** Layout and evidence share one typed manifest. Rendering does not attest source authenticity. */
export const StructuredWebReportSchema = z.object({
  title: z.string().trim().min(1).max(160),
  collectedAt: z.string().datetime({ offset: true }).optional(),
  evidence: z.object({
    coverage: WebArtifactEvidenceInputSchema.shape.coverage,
    items: WebArtifactEvidenceInputSchema.shape.items,
    noMatches: WebArtifactEvidenceInputSchema.shape.noMatches
  }).strict()
}).strict()

export type StructuredWebReport = z.infer<typeof StructuredWebReportSchema>
const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const labels: Record<string, string> = { title: '项目名称', publication_date: '发布日期', budget: '预算', deadline: '截止时间', status: '状态', qualification: '资质要求', other: '原文' }
const classifications = { opportunity: '当前机会', intent: '采购意向', historical: '历史公告', source: '来源' }
const fieldOrder = ['title', 'publication_date', 'budget', 'deadline', 'status', 'qualification', 'other']

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
  const cards = verificationInput.items.map(item => {
    const fields = [...item.fields].sort((a, b) => fieldOrder.indexOf(a.field) - fieldOrder.indexOf(b.field)).map(field => `<div class="field"><dt>${escape(feed && field.field === 'publication_date' ? '列表标注日期' : feed && field.field === 'other' ? '列表原文摘录' : labels[field.field]!)}</dt><dd><span data-evidence-field="${field.field}">${escape(evidenceDisplayText(field.value))}</span></dd></div>`).join('')
    const unknown = item.unverifiedFields.map(field => `<div class="field"><dt>${escape(feed && field === 'publication_date' ? '列表标注日期' : labels[field]!)}</dt><dd><span data-evidence-field="${field}" data-evidence-unverified>待核验</span></dd></div>`).join('')
    return `<article id="${item.sectionId}" data-evidence-item="${item.sectionId}" data-evidence-classification="${item.classification}"><p class="classification">${feed ? '订阅记录' : classifications[item.classification]}</p><dl>${fields}${unknown}</dl><a data-evidence-source href="${escape(item.source.url)}">${feed ? '列表来源' : '公告原文'}</a>${feed ? item.recordUrl ? `<a data-evidence-record href="${escape(item.recordUrl)}">条目链接（正文未读取）</a>` : '<p>无独立条目链接（正文未读取）</p>' : ''}</article>`
  }).join('')
  const empty = verificationInput.noMatches.map(entry => `<p class="empty">${escape(entry.quote)}</p>`).join('')
  const content = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(report.title)}</title><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#142638;background:#f3f6fa;color-scheme:light}*{box-sizing:border-box}body{margin:0;line-height:1.7}.page{max-width:1080px;margin:0 auto;padding:40px 24px 64px}header{margin-bottom:28px}h1{font-size:clamp(24px,4vw,36px);line-height:1.3;letter-spacing:-.03em;margin:0 0 12px}.status{display:inline-block;border-radius:30px;padding:4px 12px;background:#fff1cc;color:#735013;font-size:13px}.meta{color:#596d80;font-size:13px}.sources{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}a{color:#135d95;text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere}.sources a{padding:6px 12px;background:white;border:1px solid #dce4ed;border-radius:8px;font-size:13px}main{display:grid;gap:18px}article{background:#fff;border:1px solid #dce4ed;border-radius:16px;padding:24px;box-shadow:0 8px 24px #16273806}.classification{display:inline-block;margin:0 0 14px;padding:2px 9px;border-radius:20px;background:#e9f2f9;color:#216e9b;font-size:12px}dl{margin:0}.field{display:grid;grid-template-columns:110px minmax(0,1fr);gap:16px;border-bottom:1px solid #edf0f4;padding:10px 0}.field:first-child{padding-top:0}.field:first-child dd{font-size:18px;font-weight:650}.field:last-child{border:0}dt{color:#6b7d8d;font-size:13px}dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}article>a{display:inline-block;margin-top:12px;font-size:13px}[data-evidence-unverified]{color:#8a6414}.empty{background:#fff;padding:20px;border:1px solid #dce4ed;border-radius:12px}footer{font-size:12px;color:#6b7d8d;margin-top:28px}@media(max-width:560px){.page{padding:24px 16px 40px}article{padding:18px}.field{grid-template-columns:1fr;gap:2px}}
</style></head><body><div class="page"><header><p class="status">${feed ? '列表数据 / 正文未核验' : '原文摘录与待核验项'}</p><h1>${escape(report.title)}</h1>${report.collectedAt ? `<p class="meta">报告标注时间：${escape(report.collectedAt)}</p>` : ''}${feed ? `<p class="meta">本报告列出 ${verificationInput.items.length} 条列表记录，关联 ${new Set(verificationInput.coverage.map(source => source.url)).size} 个来源页面；后续分页覆盖尚未确认，不代表今日全量。</p>` : ''}<nav class="sources" aria-label="检索来源">${sourceLinks}</nav></header><main data-evidence-report>${cards}${empty}</main><footer>来源核验以应用任务中的验证回执为准。</footer></div></body></html>`
  if (content.length > 8 * 1024 * 1024) throw new Error('结构化报告超过受管理成果的内容上限，请拆分报告。')
  return { content, verificationInput }
}
