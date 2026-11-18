import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { extname, posix } from 'node:path'
import { DOMParser, type Document, type Element } from '@xmldom/xmldom'
import JSZip from 'jszip'
import { z } from 'zod'
import {
  MAX_WORKBOOK_BYTES,
  MAX_WORKBOOK_CELLS,
  MAX_WORKBOOK_COLUMNS,
  MAX_WORKBOOK_ROWS,
  MAX_WORKBOOK_SHEETS,
  WORKBOOK_SUFFIX,
  type OpenSpreadsheetResult,
  type SaveWorkbookRequest,
  type SaveWorkbookResult,
  type SheetFileTarget,
  type SpreadsheetCellValue,
  type SpreadsheetPreview
} from '../../shared/workspace-sheet'
import { recheckContainedParent, resolveContainedPath } from './canonical-containment'
import { atomicWriteFile } from './durable-file'
import { inspectOfficeArchive } from './office-archive-security'
import { readVerifiedTaskArtifact, type TaskArtifactReader } from './task-artifact-open'
import { invalidateWriteDocumentIndex } from './write-document-index'

const sheetId = z.string().regex(/^[a-z0-9_-]{1,128}$/i)
  .refine(key => !['__proto__', 'prototype', 'constructor'].includes(key))
const coordinate = z.string().regex(/^(0|[1-9]\d{0,4})$/)
const workbookFileSchema = z.object({
  version: z.literal(1),
  workbook: z.object({
    name: z.string().min(1).max(255),
    id: sheetId.optional(),
    sheetOrder: z.array(sheetId).max(MAX_WORKBOOK_SHEETS).optional(),
    sheets: z.record(sheetId, z.object({
      id: sheetId,
      name: z.string().min(1).max(255),
      rowCount: z.number().int().positive().max(MAX_WORKBOOK_ROWS).optional(),
      columnCount: z.number().int().positive().max(MAX_WORKBOOK_COLUMNS).optional(),
      cellData: z.record(coordinate, z.record(coordinate, z.object({
        v: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
        f: z.string().nullable().optional()
      }).passthrough())).optional()
    }).passthrough()).optional()
  }).passthrough()
}).strict()

function validateWorkbook(content: string): void {
  if (Buffer.byteLength(content) > MAX_WORKBOOK_BYTES) throw new Error('工作簿超过内置编辑大小上限。')
  const { workbook } = workbookFileSchema.parse(JSON.parse(content))
  const sheetKeys = Object.keys(workbook.sheets ?? {})
  const order = workbook.sheetOrder ?? []
  if (sheetKeys.length !== order.length || new Set(order).size !== sheetKeys.length ||
    order.some(id => !Object.hasOwn(workbook.sheets ?? {}, id) || workbook.sheets?.[id]?.id !== id)) {
    throw new Error('工作簿的工作表索引无效。')
  }
  let cellCount = 0
  for (const sheet of Object.values(workbook.sheets ?? {})) {
    for (const [rowIndex, cells] of Object.entries(sheet.cellData ?? {})) {
      const columns = Object.keys(cells)
      cellCount += columns.length
      if (cellCount > MAX_WORKBOOK_CELLS || Number(rowIndex) >= MAX_WORKBOOK_ROWS ||
        columns.some(columnIndex => Number(columnIndex) >= MAX_WORKBOOK_COLUMNS)) {
        throw new Error('工作表的行列或单元格数量超过内置表格范围。')
      }
    }
  }
}

async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.size > MAX_WORKBOOK_BYTES) throw new Error('文件超过内置表格读取上限。')
    const buffer = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (bytesRead === 0) break
      size += bytesRead
    }
    const after = await handle.stat()
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs) throw new Error('文件读取时发生了变化。')
    return buffer.subarray(0, size)
  } finally { await handle.close() }
}

function sha(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function spreadsheetPart(zip: JSZip, path: string): Promise<Document> {
  const entry = zip.file(path)
  if (!entry) throw new Error('Excel 文件缺少工作簿内容。')
  const xml = await entry.async('text')
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('Excel 文件包含不受支持的 XML 声明。')
  const document = new DOMParser({ onError: (_level, message) => { throw new Error(message) } })
    .parseFromString(xml, 'application/xml')
  if (!document.documentElement) throw new Error('Excel 文件格式无效。')
  return document
}

function descendants(node: Document | Element, name: string): Element[] {
  return Array.from(node.getElementsByTagNameNS('*', name))
}

function textOf(node: Document | Element): string {
  return descendants(node, 't').map(element => element.textContent ?? '').join('')
}

function position(ref: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref)
  if (!match) throw new Error('Excel 文件包含无效的单元格位置。')
  const column = [...match[1]].reduce((value, character) => value * 26 + character.charCodeAt(0) - 64, 0) - 1
  const row = Number(match[2]) - 1
  if (row >= MAX_WORKBOOK_ROWS || column >= MAX_WORKBOOK_COLUMNS) throw new Error('Excel 工作表的行列超出内置预览范围。')
  return { row, column }
}

function cellValue(cell: Element, strings: string[]): SpreadsheetCellValue | undefined {
  const type = cell.getAttribute('t')
  const text = descendants(cell, 'v')[0]?.textContent ?? ''
  if (type === 'inlineStr') return textOf(cell)
  if (!text) return descendants(cell, 'f').length ? '…' : undefined
  if (type === 's') {
    if (!/^\d+$/.test(text) || strings[Number(text)] === undefined) throw new Error('Excel 文件的共享字符串无效。')
    return strings[Number(text)]
  }
  if (type === 'b') return text === '1'
  if (!type || type === 'n') {
    const value = Number(text)
    if (Number.isFinite(value)) return value
  }
  return text
}

export async function parseSpreadsheetPreview(bytes: Buffer): Promise<SpreadsheetPreview> {
  if (inspectOfficeArchive(bytes).uncompressedBytes > 24 * 1024 * 1024) {
    throw new Error('Excel 工作簿内容超过内置预览上限。')
  }
  const zip = await JSZip.loadAsync(bytes)
  const [workbook, relations, sharedStrings] = await Promise.all([
    spreadsheetPart(zip, 'xl/workbook.xml'),
    spreadsheetPart(zip, 'xl/_rels/workbook.xml.rels'),
    zip.file('xl/sharedStrings.xml') ? spreadsheetPart(zip, 'xl/sharedStrings.xml') : null
  ])
  const worksheets = descendants(workbook, 'sheet').filter(sheet => {
    const state = sheet.getAttribute('state')
    return !state || state === 'visible'
  })
  if (!worksheets.length || worksheets.length > MAX_WORKBOOK_SHEETS) throw new Error('此 Excel 文件的工作表无法在内置网格中显示。')
  const relationships = new Map(descendants(relations, 'Relationship').map(relation =>
    [relation.getAttribute('Id'), relation] as const))
  const strings = sharedStrings ? descendants(sharedStrings, 'si').map(textOf) : []
  const result: SpreadsheetPreview = {
    sheets: [],
    simplified: Object.keys(zip.files).some(name => /^xl\/(?:drawings|externalLinks|pivot|charts)\b/i.test(name))
  }
  let cellCount = 0
  let textLength = 0
  for (const item of worksheets) {
    const id = item.getAttribute('r:id') || item.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
    const relationship = relationships.get(id)
    const target = relationship?.getAttribute('Target') ?? ''
    const path = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join('xl', target))
    if (!relationship?.getAttribute('Type')?.endsWith('/worksheet') ||
      relationship.getAttribute('TargetMode') === 'External' || !/^xl\/worksheets\/[\w.-]+\.xml$/i.test(path)) {
      throw new Error('此 Excel 文件的工作表类型需要在系统应用中查看。')
    }
    const worksheet = await spreadsheetPart(zip, path)
    const cells: SpreadsheetPreview['sheets'][number]['cells'] = []
    for (const cell of descendants(worksheet, 'c')) {
      const value = cellValue(cell, strings)
      if (cell.hasAttribute('s') || descendants(cell, 'f').length) result.simplified = true
      if (value === undefined) continue
      if (typeof value === 'string') textLength += value.length
      if (++cellCount > MAX_WORKBOOK_CELLS || textLength > MAX_WORKBOOK_BYTES) {
        throw new Error('Excel 工作簿的单元格超过内置预览上限。')
      }
      cells.push({ ...position(cell.getAttribute('r') ?? ''), value })
    }
    result.sheets.push({ name: item.getAttribute('name') || `Sheet ${result.sheets.length + 1}`, cells })
  }
  return result
}

export async function openSpreadsheet(target: SheetFileTarget, artifactReader: TaskArtifactReader): Promise<OpenSpreadsheetResult> {
  try {
    if ('taskId' in target) {
      const { proof, bytes } = await readVerifiedTaskArtifact(target, artifactReader, MAX_WORKBOOK_BYTES)
      if (extname(proof.absolutePath).toLowerCase() !== '.xlsx') throw new Error('此成果没有可用的表格预览。')
      return { kind: 'xlsx', preview: await parseSpreadsheetPreview(bytes) }
    }
    const path = await resolveContainedPath({ root: target.workspaceRoot, target: target.path, mustExist: true, rejectFinalLink: true, expect: 'file' })
    const extension = extname(path).toLowerCase()
    if (extension !== WORKBOOK_SUFFIX && extension !== '.xlsx') throw new Error('此文件没有可用的表格预览。')
    const bytes = await readBounded(path)
    if (extension === '.xlsx') return { kind: 'xlsx', preview: await parseSpreadsheetPreview(bytes) }
    const content = bytes.toString('utf8')
    validateWorkbook(content)
    return { kind: 'workbook', content, sha256: sha(bytes) }
  } catch (error) {
    return { kind: 'error', message: error instanceof z.ZodError ? '本地工作簿格式无效。' : error instanceof Error ? error.message : String(error) }
  }
}

class WorkbookConflict extends Error {}

export async function saveWorkbook(request: SaveWorkbookRequest): Promise<SaveWorkbookResult> {
  try {
    validateWorkbook(request.content)
    if (extname(request.path).toLowerCase() !== WORKBOOK_SUFFIX) throw new Error('请选择 .rwsheet 表格文件。')
    const path = await resolveContainedPath({
      root: request.workspaceRoot, target: request.path, rejectFinalLink: true, expect: 'file'
    })
    await atomicWriteFile(path, request.content, {
      async beforeReplace() {
        await recheckContainedParent(request.workspaceRoot, path)
        const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null
          throw error
        })
        const matching = request.expectedSha256 === null ? !existing
          : existing?.isFile() && existing.size <= MAX_WORKBOOK_BYTES && sha(await readBounded(path)) === request.expectedSha256
        if (!matching) throw new WorkbookConflict('文件已存在或已被修改，请另存为新的工作簿。')
      }
    })
    invalidateWriteDocumentIndex(request.workspaceRoot)
    return { ok: true, path, sha256: sha(request.content) }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof z.ZodError ? '本地工作簿格式无效。' : error instanceof Error ? error.message : String(error),
      ...(error instanceof WorkbookConflict ? { conflict: true } : {})
    }
  }
}
