import { MAX_WORKBOOK_CELLS, MAX_WORKBOOK_COLUMNS, MAX_WORKBOOK_ROWS } from '@shared/workspace-sheet'

export function parseSpreadsheetCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let quoteClosed = false
  let cells = 0
  const pushField = () => {
    row.push(field)
    if (++cells > MAX_WORKBOOK_CELLS || row.length > MAX_WORKBOOK_COLUMNS) throw new Error('CSV 数据超过内置表格范围。')
    field = ''
    quoteClosed = false
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    if (rows.length > MAX_WORKBOOK_ROWS) throw new Error('CSV 行数超过内置表格范围。')
    row = []
  }
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (quoted) {
      if (character !== '"') field += character
      else if (source[index + 1] === '"') { field += '"'; index++ }
      else { quoted = false; quoteClosed = true }
    } else if (character === ',') pushField()
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index++
      pushRow()
    } else if (quoteClosed) throw new Error('CSV 引号后的内容无效。')
    else if (character === '"' && !field) quoted = true
    else field += character
  }
  if (quoted) throw new Error('CSV 文件包含未关闭的引号。')
  if (field || row.length || quoteClosed) pushRow()
  return rows
}

export function exportSpreadsheetCsv(rows: Array<Array<string | number | boolean | undefined | null>>): string {
  return '\uFEFF' + rows.map(row => row.map(value => {
    const raw = value == null ? '' : String(value)
    const literal = typeof value === 'string' && /^[\s\uFEFF]*[=+@-]/u.test(raw) ? `'${raw}` : raw
    return /[",\n\r]/.test(literal) ? `"${literal.replaceAll('"', '""')}"` : literal
  }).join(',')).join('\r\n')
}
