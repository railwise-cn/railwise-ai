import { describe, expect, it } from 'vitest'
import { makeReportPdf } from './engineering-report-pdf.js'
import { readReportPdf } from '../../tests/helpers/report-pdf.js'

describe('engineering PDF layout', () => {
  it('embeds Chinese text and paginates the entire report beyond the former truncation limit', async () => {
    const lines = Array.from({ length: 120 }, (_, index) => `观测 ${String(index).padStart(3, '0')}: 平差成果 高程=101.234567 m；角度残差=0.000012 rad；标准化残差=1.2 sigma。`)
    const text = ['测量平差成果报告（待审查）', ...lines, '末行核验：原始观测不改写，成果待人工复核。'].join('\n')
    expect(text.length).toBeGreaterThan(5000)
    const bytes = await makeReportPdf(text)
    const parsed = await readReportPdf(bytes)
    expect(parsed.pageCount).toBeGreaterThan(1)
    expect(parsed.text).toContain('测量平差成果报告')
    expect(parsed.text).toContain('末行核验：原始观测不改写，成果待人工复核。')
    for (const line of lines) expect(parsed.text).toContain(line)
    expect(bytes.toString('latin1')).toContain('/FontFile2')
    expect(bytes.toString('latin1')).toContain('/ToUnicode')
    expect(bytes.toString('latin1')).toContain('NotoSansSC-Regular')
  })

  it('rejects oversized reports explicitly instead of publishing truncated facts', async () => {
    await expect(makeReportPdf('x'.repeat(2_000_001))).rejects.toThrow(/split the selected results/)
  })
})
