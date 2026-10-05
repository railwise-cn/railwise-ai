import { createHash } from 'node:crypto'
import { extname, posix } from 'node:path'
import JSZip from 'jszip'
import { parse } from 'csv-parse/sync'
import sax from 'sax'
import { EMPTY_SURVEY_CORRECTION_STATE, SurveyObservationV1, SurveyPointV1, type SurveyRawRecordAnchorV1 } from '../contracts/survey.js'
import { SurveyTabularMappingV1, SurveyTabularProbeV1, type SurveyTabularVisibilityV1 } from '../contracts/survey-tabular.js'

export const SURVEY_TABULAR_PARSER_VERSION = '1.0.2'
export const SURVEY_TABULAR_PARSER_ID = 'survey-confirmed-tabular-parser'
const MAX_BYTES = 64 * 1024 * 1024
const MAX_EXPANDED = 128 * 1024 * 1024
const MAX_ROWS = 100_001
const MAX_COLUMNS = 64
type Delimiter = ',' | '\t' | ';'
type Row = { values: string[]; row: number; rawOffset: number; rawLength: number; rawSnippet: string; containerMember?: SurveyRawRecordAnchorV1['containerMember'] }
type Table = { id: string; name: string; visibility: SurveyTabularVisibilityV1; importable: boolean; failure?: string; rows: Row[] }
type Tables = { formatId: 'delimited-text' | 'xlsx'; sourceSha256: string; delimiter?: Delimiter; tables: Table[] }
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')

function strictText(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw new Error('Tabular input must be valid UTF-8; confirm encoding before import') }
}
function validateRows(rows: Row[]): void {
  if (rows.length < 2 || rows.length > MAX_ROWS) throw new Error('Tabular input requires a header and 1 to 100000 data rows')
  const width = rows[0]!.values.length
  if (!width || width > MAX_COLUMNS || rows[0]!.row !== 1) throw new Error('Tabular input must use row 1 as a bounded header')
  const names = rows[0]!.values.map((value) => value.trim())
  if (names.some((value) => !value) || new Set(names).size !== width) throw new Error('Tabular column names must be nonempty and unique')
  if (rows.some((row) => row.values.length !== width)) throw new Error('Tabular rows have inconsistent column counts')
}
function csvRows(bytes: Buffer, delimiter: Delimiter): Row[] {
  strictText(bytes)
  const parsed = parse(bytes, { delimiter, bom: true, info: true, raw: true, relax_column_count: false, max_record_size: 128 * 1024, skip_empty_lines: false }) as unknown as Array<{ record: string[]; raw: string; info: { bytes: number; lines: number } }>
  let offset = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? 3 : 0
  let line = 1
  const rows = parsed.map((item) => {
    const rawLength = item.info.bytes - offset
    const row = { values: item.record, row: line, rawOffset: offset, rawLength, rawSnippet: bytes.subarray(offset, item.info.bytes).toString('utf8').slice(0, 2_048) }
    offset = item.info.bytes; line = item.info.lines + 1
    return row
  })
  validateRows(rows)
  return rows
}
function chooseCsv(bytes: Buffer, supplied?: Delimiter): { delimiter: Delimiter; rows: Row[] } {
  if (supplied) return { delimiter: supplied, rows: csvRows(bytes, supplied) }
  const candidates = ([',', '\t', ';'] as const).flatMap((delimiter) => {
    try { const rows = csvRows(bytes, delimiter); return rows[0]!.values.length >= 3 ? [{ delimiter, rows }] : [] } catch { return [] }
  })
  if (candidates.length !== 1) throw new Error('CSV delimiter is ambiguous or invalid; explicitly select comma, tab or semicolon')
  return candidates[0]!
}

type MemberRange = { offset: number; length: number }
function zipMemberRanges(bytes: Buffer): Map<string, MemberRange> {
  let end = -1
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Unsupported split or malformed ZIP container')
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16)
  if (count > 2_048 || count === 0xffff || start === 0xffffffff) throw new Error('Unsupported ZIP64 or excessive workbook members')
  const ranges = new Map<string, MemberRange>()
  let totalExpanded = 0
  let cursor = start
  for (let entry = 0; entry < count; entry += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory')
    const size = bytes.readUInt32LE(cursor + 20), nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42)
    const expanded = bytes.readUInt32LE(cursor + 24)
    totalExpanded += expanded
    if (expanded === 0xffffffff || totalExpanded > MAX_EXPANDED || expanded / Math.max(size, 1) > 200) throw new Error('Workbook exceeds safe expansion limits')
    if (![0,8].includes(bytes.readUInt16LE(cursor+10))) throw new Error('Unsupported workbook compression')
    const name = strictText(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    if (ranges.has(name) || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\')) throw new Error('Unsafe or duplicate workbook member path')
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) & 1) throw new Error('Unsupported encrypted or invalid ZIP member')
    const offset = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    if (strictText(bytes.subarray(local+30,local+30+bytes.readUInt16LE(local+26))) !== name) throw new Error('Workbook member identity mismatch')
    if (offset + size > start) throw new Error('ZIP member range escapes its container data')
    ranges.set(name, { offset, length: size })
    cursor += 46 + nameLength + extra + comment
  }
  return ranges
}
function xmlParser(text: string): sax.SAXParser {
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || text.length > 32 * 1024 * 1024) throw new Error('Unsafe or excessive workbook XML')
  const parser = sax.parser(true, { trim: false, normalize: false, xmlns: false, position: true })
  let count = 0
  parser.onopentagstart = () => { if (++count > 500_000) throw new Error('Excessive workbook XML structure') }
  return parser
}
const localName = (value: string) => value.split(':').at(-1)!
function sharedStrings(text: string): string[] {
  const output: string[] = [], parser = xmlParser(text)
  let value = '', inside = false, textNode = false, depth = 0
  parser.onopentag = (node) => { if (++depth > 32) throw new Error('Excessive shared string nesting'); const tag = localName(node.name); if (tag === 'si') { inside = true; value = '' } if (tag === 't' && inside) textNode = true }
  parser.ontext = (chunk) => { if (textNode) value += chunk }
  parser.onclosetag = (tag) => { depth -= 1; if (localName(tag) === 't') textNode = false; if (localName(tag) === 'si') { output.push(value); inside = false } }
  parser.write(text).close()
  return output
}

type WorkbookSheet = { name: string; relationshipId: string; visibility: SurveyTabularVisibilityV1 }
type WorkbookRelationship = { target: string; type: string }
const WORKSHEET_RELATIONSHIP_TYPES = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet'
])

function parseWorkbookSheets(text: string): WorkbookSheet[] {
  const sheets: WorkbookSheet[] = [], names = new Set<string>(), parser = xmlParser(text)
  let inSheets = false
  parser.onopentag = (node) => {
    const tag = localName(node.name), attributes = node.attributes as Record<string, string>
    if (tag === 'sheets') inSheets = true
    if (tag !== 'sheet' || !inSheets) return
    const relationshipId = Object.entries(attributes).find(([key]) => key === 'id' || key.endsWith(':id'))?.[1]
    const name = attributes.name?.trim()
    const state = attributes.state ?? 'visible'
    if (!name || !relationshipId || names.has(name) || !['visible', 'hidden', 'veryHidden'].includes(state)) {
      throw new Error('Workbook sheets require unique names, relationship IDs and supported visibility states')
    }
    names.add(name)
    sheets.push({ name, relationshipId, visibility: state as SurveyTabularVisibilityV1 })
    if (sheets.length > 32) throw new Error('Workbook requires 1 to 32 supported worksheets')
  }
  parser.onclosetag = (name) => { if (localName(name) === 'sheets') inSheets = false }
  parser.write(text).close()
  if (!sheets.length) throw new Error('Workbook does not declare supported worksheets')
  return sheets
}

function parseWorkbookRelationships(text: string): Map<string, WorkbookRelationship> {
  const relationships = new Map<string, WorkbookRelationship>(), parser = xmlParser(text)
  parser.onopentag = (node) => {
    if (localName(node.name) !== 'Relationship') return
    const attributes = node.attributes as Record<string, string>
    const id = attributes.Id, target = attributes.Target, type = attributes.Type
    if (!id || !target || !type || relationships.has(id)) throw new Error('Workbook relationships require unique IDs, targets and types')
    if (attributes.TargetMode === 'External') throw new Error('External workbook references are unsupported')
    relationships.set(id, { target, type })
  }
  parser.write(text).close()
  return relationships
}

function workbookMemberPath(target: string): string {
  let decoded: string
  try { decoded = decodeURIComponent(target) } catch { throw new Error('Workbook worksheet relationship has an invalid target') }
  if (!decoded || decoded.includes('\\') || decoded.includes('?') || decoded.includes('#') || /^[a-z][a-z\d+.-]*:/i.test(decoded)) {
    throw new Error('Workbook worksheet relationship has an unsafe target')
  }
  const normalized = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join('xl', decoded))
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || posix.isAbsolute(normalized)) {
    throw new Error('Workbook worksheet relationship escapes the package root')
  }
  return normalized
}

function worksheetRows(text: string, memberPath: string, range: MemberRange, shared: string[]): Row[] {
  const rows: Row[] = [], parser = xmlParser(text), memberHash = sha256(Buffer.from(text))
  let rowNumber = 0, rowStart = 0, values: string[] = [], cellIndex = -1, cellType = '', cellValue = '', collect = false, depth = 0, byteCursor = 0, charCursor = 0
  parser.onopentag = (node) => {
    if (++depth > 32) throw new Error('Excessive worksheet nesting')
    const tag = localName(node.name), attributes = node.attributes as Record<string, string>
    if (tag === 'row') {
      rowNumber = Number(attributes.r)
      if (!Number.isSafeInteger(rowNumber) || rowNumber <= 0 || (rows.length && rowNumber <= rows.at(-1)!.row)) throw new Error('Worksheet requires ordered explicit row identifiers')
      rowStart = (parser as sax.SAXParser & { startTagPosition: number }).startTagPosition - 1
      values = []
    } else if (tag === 'c') {
      const match = /^([A-Z]+)([1-9]\d*)$/.exec(attributes.r ?? '')
      if (!match || Number(match[2]) !== rowNumber) throw new Error('Worksheet cell references must match their row')
      cellIndex = 0
      for (const char of match[1]!) cellIndex = cellIndex * 26 + char.charCodeAt(0) - 64
      cellIndex -= 1
      if (cellIndex >= MAX_COLUMNS || values[cellIndex] !== undefined) throw new Error('Worksheet has excess or duplicate columns')
      cellType = attributes.t ?? 'n'; cellValue = ''
      if (!['n', 's', 'inlineStr', 'str'].includes(cellType)) throw new Error('Boolean, date or error cells require explicit preprocessing')
    } else if (tag === 'f' || tag === 'mergeCell' || tag === 'externalLink') throw new Error('Formulas, merged cells and external workbook references are not accepted as observations')
    else if (tag === 'v' || tag === 't') collect = true
  }
  parser.ontext = (chunk) => { if (collect) cellValue += chunk }
  parser.onclosetag = (name) => {
    depth -= 1
    const tag = localName(name)
    if (tag === 'v' || tag === 't') collect = false
    if (tag === 'c') {
      const index = Number(cellValue)
      if (cellType === 's' && (!/^\d+$/.test(cellValue) || shared[index] === undefined)) throw new Error('Invalid shared string reference')
      values[cellIndex] = cellType === 's' ? shared[index]! : cellValue
    }
    if (tag === 'row') {
      if (rows.length >= MAX_ROWS) throw new Error('Worksheet exceeds supported row count')
      const raw = text.slice(rowStart, parser.position)
      byteCursor += Buffer.byteLength(text.slice(charCursor, rowStart)); charCursor = rowStart
      const memberOffset = byteCursor
      const memberLength = Buffer.byteLength(raw)
      rows.push({ values: Array.from({ length: values.length }, (_, index) => values[index] ?? ''), row: rowNumber, rawOffset: range.offset, rawLength: range.length, rawSnippet: raw.slice(0, 2_048), containerMember: { path: memberPath, sha256: memberHash, byteOffset: memberOffset, byteLength: memberLength, row: rowNumber } })
    }
  }
  parser.write(text).close()
  validateRows(rows)
  return rows
}
async function xlsxTables(bytes: Buffer): Promise<Table[]> {
  const ranges = zipMemberRanges(bytes), zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false })
  const workbookFile = zip.file('xl/workbook.xml'), relationshipsFile = zip.file('xl/_rels/workbook.xml.rels')
  if (!zip.file('[Content_Types].xml') || !workbookFile || !relationshipsFile) throw new Error('XLSX is not a supported OOXML workbook')
  let expanded = 0
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    const metadata = (entry as unknown as { _data: { uncompressedSize: number } })._data
    expanded += metadata.uncompressedSize
    if (expanded > MAX_EXPANDED || metadata.uncompressedSize / Math.max(1, ranges.get(entry.name)?.length ?? 0) > 200) throw new Error('Workbook exceeds safe expansion limits')
    if (/vbaProject|externalLinks\//i.test(entry.name)) throw new Error('Macros and external workbook references are unsupported')
    if (entry.name.endsWith('.rels')) {
      const parser = xmlParser(await entry.async('text'))
      parser.onopentag = node => { if (localName(node.name) === 'Relationship' && (node.attributes as Record<string,string>).TargetMode === 'External') throw new Error('External workbook references are unsupported') }
      parser.write(await entry.async('text')).close()
    }
  }
  const shared = zip.file('xl/sharedStrings.xml') ? sharedStrings(await zip.file('xl/sharedStrings.xml')!.async('text')) : []
  const workbookSheets = parseWorkbookSheets(await workbookFile.async('text'))
  const relationships = parseWorkbookRelationships(await relationshipsFile.async('text'))
  const tables: Table[] = []
  for (const sheet of workbookSheets) {
    const relationship = relationships.get(sheet.relationshipId)
    if (!relationship) throw new Error(`Workbook sheet relationship is missing: ${sheet.name}`)
    if (!WORKSHEET_RELATIONSHIP_TYPES.has(relationship.type)) throw new Error(`Unsupported workbook sheet relationship type: ${sheet.name}`)
    const id = workbookMemberPath(relationship.target)
    const member = zip.file(id), range = ranges.get(id)
    if (!member || !range) throw new Error(`Workbook worksheet member is missing: ${sheet.name}`)
    let rows: Row[] = []
    let importable = false
    let failure: string | undefined
    if (sheet.visibility === 'visible') {
      try {
        rows = worksheetRows(strictText(await member.async('nodebuffer')), id, range, shared)
        importable = true
      } catch (error) {
        // Valid workbooks often include visible cover, instruction or summary sheets.
        failure = error instanceof Error ? error.message : 'Worksheet cannot be used as a tabular observation source'
      }
    }
    tables.push({
      id,
      name: sheet.name,
      visibility: sheet.visibility,
      importable,
      ...(failure ? { failure } : {}),
      rows
    })
  }
  if (!tables.length) throw new Error('Workbook requires at least one worksheet')
  return tables
}
async function readTables(name: string, bytes: Buffer, delimiter?: Delimiter): Promise<Tables> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Tabular source must be between 1 byte and 64 MiB')
  const sourceSha256 = sha256(bytes)
  if (extname(name).toLowerCase() === '.xlsx') return { formatId: 'xlsx', sourceSha256, tables: await xlsxTables(bytes) }
  if (!['.csv', '.tsv'].includes(extname(name).toLowerCase())) throw new Error('Confirmed tabular input supports .csv, .tsv and .xlsx only')
  const parsed = chooseCsv(bytes, delimiter)
  return { formatId: 'delimited-text', sourceSha256, delimiter: parsed.delimiter, tables: [{ id: 'csv', name, visibility: 'visible', importable: true, rows: parsed.rows }] }
}
export async function probeSurveyTabular(name: string, bytes: Buffer, delimiter?: Delimiter): Promise<SurveyTabularProbeV1> {
  const parsed = await readTables(name, bytes, delimiter)
  return SurveyTabularProbeV1.parse({ ...parsed, tables: parsed.tables.map((table) => ({ id: table.id, name: table.name, visibility: table.visibility, importable: table.importable, columns: table.rows[0]?.values ?? [], previewRows: table.rows.slice(1, 6).map((row) => row.values), rowCount: Math.max(0, table.rows.length - 1), headerRow: 1 })), requiresMapping: true })
}
function numeric(value: string, field: string, row: number): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) || !Number.isFinite(Number(value))) throw new Error(`Invalid ${field} at row ${row}; a finite decimal is required`)
  return Number(value)
}
export async function parseSurveyTabular(name: string, bytes: Buffer, mappingInput: SurveyTabularMappingV1) {
  const mapping = SurveyTabularMappingV1.parse(mappingInput), parsed = await readTables(name, bytes, mapping.delimiter)
  if (mapping.sourceSha256 !== parsed.sourceSha256) throw new Error('Confirmed mapping does not match the original source hash')
  if (parsed.formatId === 'delimited-text' && !mapping.delimiter) throw new Error('CSV imports require an explicit confirmed delimiter')
  const table = parsed.tables.find((candidate) => candidate.id === mapping.tableId)
  if (!table) throw new Error('Confirmed worksheet does not exist in the preserved source')
  if (table.visibility !== 'visible') throw new Error('Hidden worksheets must be made visible in the original workbook before mapping')
  if (!table.importable) throw new Error(table.failure ?? 'Selected worksheet is not a supported tabular observation table')
  if (mapping.bindings.some((binding) => binding.columnIndex >= table.rows[0]!.values.length)) throw new Error('Confirmed column binding exceeds the selected table')
  const bindings = new Map(mapping.bindings.map((binding) => [binding.field, binding.columnIndex]))
  const linearFactor = ({ m: 1, mm: 0.001, cm: 0.01, km: 1_000 })[mapping.linearUnit]
  const angularFactor = ({ rad: 1, 'degree-decimal': Math.PI / 180, gon: Math.PI / 200 })[mapping.angularUnit]
  const observationIds = new Set<string>(), endpointIds = new Set<string>()
  const anchors: SurveyRawRecordAnchorV1[] = [], observations: SurveyObservationV1[] = []
  for (const row of table.rows.slice(1)) {
    const read = (field: SurveyTabularMappingV1['bindings'][number]['field']) => bindings.has(field) ? row.values[bindings.get(field)!]!.trim() : undefined
    const from = read('from')!, to = read('to')!, id = read('id') ?? `tabular-${row.row}`
    if (!from || !to || from === to || !id || observationIds.has(id)) throw new Error(`Invalid or duplicate observation identity at row ${row.row}`)
    observationIds.add(id); endpointIds.add(from); endpointIds.add(to)
    const factor = mapping.observationType === 'direction' ? angularFactor : linearFactor
    const value = numeric(read('value')!, 'value', row.row) * factor
    const sigma = read('sigma') === undefined ? undefined : numeric(read('sigma')!, 'sigma', row.row) * factor
    const routeLength = read('routeLength') === undefined ? undefined : numeric(read('routeLength')!, 'routeLength', row.row) * (mapping.routeLengthUnit === 'km' ? 1_000 : 1)
    const stationCount = read('stationCount') === undefined ? undefined : numeric(read('stationCount')!, 'stationCount', row.row)
    if (!Number.isFinite(value) || sigma !== undefined && !(sigma > 0) || routeLength !== undefined && !(routeLength > 0) || stationCount !== undefined && (!Number.isSafeInteger(stationCount) || stationCount < 1)) throw new Error(`Invalid mapped units, uncertainty, length or station count at row ${row.row}`)
    const anchorId = `${parsed.formatId}:${mapping.tableId}:${row.row}`
    anchors.push({ id: anchorId, sourceRecord: row.row, rawOffset: row.rawOffset, rawLength: row.rawLength, byteOffset: row.rawOffset, byteLength: row.rawLength, ...(row.containerMember ? { containerMember: row.containerMember } : { line: row.row, rawLineNo: row.row }), rawSnippet: row.rawSnippet, recordType: 'confirmed-observation', section: mapping.tableId })
    observations.push(SurveyObservationV1.parse({ id, type: mapping.observationType, from, to, ...(mapping.observationType === 'direction' ? { station: from, target: to } : {}), value, unit: mapping.observationType === 'direction' ? 'rad' : 'm', ...(sigma === undefined ? {} : { sigma, sigmaUnit: mapping.observationType === 'direction' ? 'rad' : 'm' }), ...(routeLength === undefined ? {} : { routeLength }), correctionState: EMPTY_SURVEY_CORRECTION_STATE, sourceRecordId: anchorId, sourceRow: row.row, sourceLocator: `${mapping.tableId}!${row.row}`, rawFields: { originalValue: read('value')!, originalUnit: mapping.observationType === 'direction' ? mapping.angularUnit : mapping.linearUnit, mappingId: mapping.mappingId, ...(stationCount === undefined ? {} : { stationCount }) } }))
  }
  const supplied = [...mapping.knownPoints.map((point) => SurveyPointV1.parse({ ...point, known: true, pointClass: 'known', sourceLocator: `confirmed-mapping:${mapping.mappingId}` })), ...(mapping.unknownPoints ?? []).map((point) => SurveyPointV1.parse({ ...point, known: false, pointClass: 'unknown', sourceLocator: `confirmed-mapping:${mapping.mappingId}` }))]
  const points = new Map(supplied.map((point) => [point.id, point]))
  for (const id of endpointIds) if (!points.has(id)) points.set(id, SurveyPointV1.parse({ id, known: false, pointClass: 'unknown' }))
  return {
    formatId: parsed.formatId, networkType: mapping.networkType,
    tabularMapping: mapping,
    knownPoints: [...points.values()].filter((point) => point.known), unknownPoints: [...points.values()].filter((point) => !point.known), observations, anchors,
    coordinateSystem: mapping.coordinateSystem, verticalDatum: mapping.verticalDatum, projection: mapping.projection ?? 'LOCAL', ellipsoid: mapping.ellipsoid ?? 'LOCAL', unit: 'm',
    linearUnitRaw: mapping.linearUnit, angularUnitRaw: mapping.angularUnit, canonicalUnitsVerified: true,
    parserId: SURVEY_TABULAR_PARSER_ID, parserVersion: SURVEY_TABULAR_PARSER_VERSION,
    parserSourceHash: sha256(`survey-tabular:${SURVEY_TABULAR_PARSER_VERSION}`),
    sourceRawFields: { 'tabular.mapping': JSON.stringify(mapping), 'tabular.mappingHash': sha256(JSON.stringify(mapping)), 'tabular.table': mapping.tableId },
    requiresManualConfirmation: false, disposition: 'adjustment-ready' as const,
    dispositionReason: 'Confirmed, source-bound tabular column/units/reference mapping; deterministic network checks remain required'
  }
}
