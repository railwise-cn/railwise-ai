export const WORKBOOK_SUFFIX = '.rwsheet'
export const MAX_WORKBOOK_BYTES = 8 * 1024 * 1024
export const MAX_WORKBOOK_ROWS = 20_000
export const MAX_WORKBOOK_COLUMNS = 512
export const MAX_WORKBOOK_CELLS = 100_000
export const MAX_WORKBOOK_SHEETS = 64

export type SheetFileTarget =
  | { workspaceRoot: string; path: string }
  | { taskId: string; artifactId: string }

export type SpreadsheetCellValue = string | number | boolean
export type SpreadsheetPreview = {
  sheets: Array<{
    name: string
    cells: Array<{ row: number; column: number; value: SpreadsheetCellValue }>
  }>
  simplified: boolean
}

export type OpenSpreadsheetResult =
  | { kind: 'workbook'; content: string; sha256: string }
  | { kind: 'xlsx'; preview: SpreadsheetPreview }
  | { kind: 'error'; message: string }

export type SaveWorkbookRequest = {
  workspaceRoot: string
  path: string
  content: string
  expectedSha256: string | null
}

export type SaveWorkbookResult =
  | { ok: true; path: string; sha256: string }
  | { ok: false; message: string; conflict?: boolean }

export function newWorkbookContent(name: string): string {
  return JSON.stringify({ version: 1, workbook: { name } })
}
