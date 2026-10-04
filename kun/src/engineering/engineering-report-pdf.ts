import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'
import PDFDocument from 'pdfkit'
import { professionalReportCellText, type ProfessionalReportModel, type ProfessionalReportTable } from './survey-professional-report.js'

const fontUrl = new URL('../../assets/fonts/NotoSansSC-Regular.ttf', import.meta.url)
let fontBytes: Promise<Buffer> | undefined

async function reportFont(): Promise<Buffer> {
  fontBytes ??= readFile(fontUrl).then((bytes) => {
    if (createHash('sha256').update(bytes).digest('hex') !== 'eeb06b8a64fd04a2744d95579db1571b51027cda61ed78c62e4b730791525461') {
      throw new Error('bundled report font integrity check failed; reinstall the verified application package')
    }
    return bytes
  }).catch((error) => { fontBytes = undefined; throw error })
  return fontBytes
}

/** Tables are chunked at row boundaries and every continuation repeats the
 * actual header. A pathological cell is rejected rather than clipped. */
export async function makeProfessionalReportPdf(model: ProfessionalReportModel): Promise<Buffer> {
  if (JSON.stringify(model).length > 2_000_000) throw new Error('report exceeds the PDF layout limit; split the selected results into separate reports')
  const font = await reportFont()
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 42, bufferPages: true, info: { Title: model.title, Creator: 'RailWise Survey', Subject: '待审查草稿 · 未签认' } })
    const chunks: Buffer[] = []
    document.on('data', (chunk: Buffer) => chunks.push(chunk))
    document.on('error', reject)
    document.on('end', () => resolve(Buffer.concat(chunks)))
    const textValue = professionalReportCellText
    const endY = (): number => document.page.height - 54
    const ensureSpace = (height: number): void => { if (document.y + height > endY()) document.addPage() }
    const renderTable = (table: ProfessionalReportTable): void => {
      ensureSpace(85)
      document.fontSize(12).fillColor('#17212B').text(table.title, { paragraphGap: 8 })
      const width = document.page.width - 84
      const cellWidth = width / table.columns.length
      const headers = table.columns.map(column => column.unit ? `${column.label} (${column.unit})` : column.label)
      document.fontSize(9)
      const dataRows = table.rows.length ? table.rows.map(row => table.columns.map(column => textValue(row[column.key], column.decimals))) : [table.columns.map((_, index) => index === 0 ? '无可用记录 / 未评估' : '')]
      // Keep displayed numbers intact; text columns absorb the remaining width.
      const columnWidths = table.columns.map((column, index) => column.numeric ? Math.max(cellWidth, ...dataRows.map(row => document.widthOfString(row[index]!) + 10)) : cellWidth)
      const textColumnCount = table.columns.filter(column => !column.numeric).length
      const numericWidth = columnWidths.reduce((total, value, index) => total + (table.columns[index]!.numeric ? value : 0), 0)
      if (numericWidth > width - textColumnCount * 32) throw new Error(`professional table ${table.id} contains numbers too wide for one printable page; split this result before exporting`)
      if (textColumnCount) for (let index = 0; index < columnWidths.length; index += 1) if (!table.columns[index]!.numeric) columnWidths[index] = (width - numericWidth) / textColumnCount
      const rowHeight = (cells: string[]): number => Math.max(...cells.map((cell, index) => document.heightOfString(cell, { width: columnWidths[index]! - 10, lineGap: 1 }))) + 10
      const headerHeight = rowHeight(headers)
      let start = 0
      while (start < dataRows.length) {
        let required = headerHeight
        let end = start
        while (end < dataRows.length) {
          const height = rowHeight(dataRows[end]!)
          if (height + headerHeight > document.page.height - 114) throw new Error(`professional table ${table.id} contains a cell too long for one printable page; split this result before exporting`)
          if (document.y + required + height > endY()) break
          required += height
          end += 1
        }
        if (end === start) { document.addPage(); continue }
        const data = [headers.map(text => ({ text, type: 'TH' as const, backgroundColor: '#E8EEF3' })), ...dataRows.slice(start, end).map(row => row.map(text => ({ text }))) ]
        document.table({ maxWidth: width, columnStyles: columnWidths, defaultStyle: { border: 0.4, borderColor: '#B5BEC8', padding: 5, textOptions: { lineGap: 1 } }, data })
        start = end
        if (start < dataRows.length) {
          document.addPage()
          document.fontSize(10).fillColor('#17212B').text(`${table.title}（续）`, { paragraphGap: 6 })
          document.fontSize(9)
        }
      }
      if (table.note) {
        ensureSpace(document.heightOfString(table.note, { width }) + 12)
        document.fontSize(9).fillColor('#475564').text(`说明：${table.note}`, { width, paragraphGap: 8 })
      }
      document.moveDown(0.6)
    }
    try {
      document.font(font).fontSize(18).fillColor('#17212B').text(model.title, { paragraphGap: 12 })
      document.fontSize(10.5).text(`项目：${model.projectName}    作业类型：${model.taskType}`, { paragraphGap: 5 })
      document.text(`生成时间：${model.generatedAt}    状态：待审查草稿 · 未签认`, { paragraphGap: 8 })
      for (const note of model.notes) document.fontSize(9).fillColor('#475564').text(note, { paragraphGap: 4 })
      document.moveDown(0.8)
      for (const table of model.tables) renderTable(table)
      renderTable({ id: 'signoff', title: '签认栏（空白 / 未签认）', columns: [{ key: 'role', label: '角色' }, { key: 'name', label: '姓名' }, { key: 'date', label: '日期' }, { key: 'signature', label: '签名' }], rows: model.signoff.map(item => ({ ...item, name: '________________', date: '________________', signature: '________________' })) })
      if (model.appendix?.length) {
        document.addPage()
        document.fontSize(12).fillColor('#17212B').text('计算与来源明细附件', { paragraphGap: 8 })
        document.fontSize(9)
        for (const line of model.appendix) {
          if (!line) { document.moveDown(0.4); continue }
          document.text(line, { width: document.page.width - 84, lineGap: 2, paragraphGap: 4 })
        }
      }
      const pages = document.bufferedPageRange()
      for (let index = pages.start; index < pages.start + pages.count; index += 1) {
        document.switchToPage(index)
        document.fontSize(8).fillColor('#566372').text(`RailWise Survey · 待审查 · ${index + 1} / ${pages.count}`, 42, document.page.height - 27, { lineBreak: false })
      }
      document.end()
    } catch (error) {
      ;(document as unknown as Readable).destroy()
      reject(error)
    }
  })
}

/** Offline Unicode layout with a bundled OFL font; never truncate report facts. */
export async function makeReportPdf(text: string): Promise<Buffer> {
  if (text.length > 2_000_000) throw new Error('report exceeds the PDF layout limit; split the selected results into separate reports')
  const font = await reportFont()
  return new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: 'RailWise Survey - Review Draft', Creator: 'RailWise AI' } })
    const chunks: Buffer[] = []
    document.on('data', (chunk: Buffer) => chunks.push(chunk))
    document.on('error', reject)
    document.on('end', () => resolve(Buffer.concat(chunks)))
    try {
      document.font(font).fontSize(10.5).fillColor('#222222')
      for (const line of text.split('\n')) {
        if (!line) { document.moveDown(0.5); continue }
        document.text(line, { width: document.page.width - 100, lineGap: 3, paragraphGap: 5 })
      }
      const pages = document.bufferedPageRange()
      for (let index = pages.start; index < pages.start + pages.count; index += 1) {
        document.switchToPage(index)
        document.fontSize(8).fillColor('#555555').text(`${index + 1} / ${pages.count}`, 50, document.page.height - 32, { lineBreak: false })
      }
      document.end()
    } catch (error) {
      ;(document as unknown as Readable).destroy()
      reject(error)
    }
  })
}
