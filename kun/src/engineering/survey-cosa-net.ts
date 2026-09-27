/**
 * Isolated COSA `.NET` reader and orientation checker.
 *
 * It deliberately has no registry, filesystem, or adjustment-kernel
 * dependency. A later adapter may decide how a validated topology participates
 * in an import, but this module never silently rewrites a clockwise record.
 */

const UTF8 = new TextEncoder()
const MAX_RAW_SNIPPET_CHARS = 2_048
const MAX_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_LINE_BYTES = 16_384
const MAX_RECORDS = 10_000
const MAX_COORDINATES = 10_000

export type CosaNetSource = string | Uint8Array

export type CosaNetCoordinate = Readonly<{
  x: number
  y: number
}>

export type CosaNetRecordAnchor = Readonly<{
  id: string
  sourceRecord: number
  line: number
  column: number
  byteOffset: number
  byteLength: number
  rawOffset: number
  rawLength: number
  rawSnippet: string
}>

export type CosaNetDiagnosticCode =
  | 'resource-limit'
  | 'invalid-encoding'
  | 'empty-source'
  | 'invalid-record'
  | 'empty-point-id'
  | 'duplicate-point-id'
  | 'missing-coordinate'
  | 'degenerate-triangle'
  | 'clockwise-triangle'

export type CosaNetDiagnostic = Readonly<{
  code: CosaNetDiagnosticCode
  severity: 'blocking' | 'warning'
  message: string
  suggestedAction: string
  /** Every result is actionable by correcting input and re-running. */
  recoverable: true
  recordAnchor: CosaNetRecordAnchor
}>

export type CosaNetTriangle = Readonly<{
  id: string
  points: readonly [string, string, string]
  /** Signed double area: positive is counter-clockwise. */
  signedDoubleArea: number
  orientation: 'counter-clockwise' | 'clockwise'
  recordAnchor: CosaNetRecordAnchor
}>

export type CosaNetParseResult = Readonly<{
  /** `blocked` always has an empty `triangles` array: no partial topology escapes. */
  state: 'valid' | 'blocked'
  triangles: readonly CosaNetTriangle[]
  records: readonly CosaNetRecordAnchor[]
  diagnostics: readonly CosaNetDiagnostic[]
}>

type SourceLine = Readonly<{
  line: number
  raw: string
  byteOffset: number
  byteLength: number
}>

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values])
}

function diagnostic(
  code: CosaNetDiagnosticCode,
  severity: CosaNetDiagnostic['severity'],
  message: string,
  suggestedAction: string,
  recordAnchor: CosaNetRecordAnchor
): CosaNetDiagnostic {
  return Object.freeze({ code, severity, message, suggestedAction, recoverable: true as const, recordAnchor })
}

function rawSnippet(value: string): string {
  return value.slice(0, MAX_RAW_SNIPPET_CHARS)
}

function virtualAnchor(rawSnippetValue = ''): CosaNetRecordAnchor {
  return Object.freeze({
    id: 'cosa-net-record-1',
    sourceRecord: 1,
    line: 1,
    column: 1,
    byteOffset: 0,
    byteLength: 0,
    rawOffset: 0,
    rawLength: 0,
    rawSnippet: rawSnippet(rawSnippetValue)
  })
}

function sourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let cursor = 0
  let byteOffset = 0
  let line = 1
  while (cursor < text.length) {
    let end = cursor
    while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end += 1
    const raw = text.slice(cursor, end)
    let next = end
    if (text[next] === '\r') {
      next += 1
      if (text[next] === '\n') next += 1
    } else if (text[next] === '\n') next += 1
    lines.push(Object.freeze({ line, raw, byteOffset, byteLength: raw.length }))
    // The source has already been restricted to ASCII, so character count and
    // UTF-8 byte count agree. Keep the expression explicit for provenance.
    byteOffset += UTF8.encode(text.slice(cursor, next)).byteLength
    cursor = next
    line += 1
  }
  return lines
}

function anchorFor(line: SourceLine): CosaNetRecordAnchor {
  return Object.freeze({
    id: `cosa-net-record-${line.line}`,
    sourceRecord: line.line,
    line: line.line,
    column: 1,
    byteOffset: line.byteOffset,
    byteLength: line.byteLength,
    rawOffset: line.byteOffset,
    rawLength: line.byteLength,
    rawSnippet: rawSnippet(line.raw)
  })
}

function sourceText(source: CosaNetSource): { text: string } | { diagnostic: CosaNetDiagnostic } {
  if (source.length > MAX_SOURCE_BYTES) return { diagnostic: resourceLimit() }
  const bytes = typeof source === 'string' ? UTF8.encode(source) : source
  if (bytes.length > MAX_SOURCE_BYTES) return { diagnostic: resourceLimit() }
  let lineLength = 0
  let records = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 13 || bytes[index] === 10) {
      if (bytes[index] === 13 && bytes[index + 1] === 10) index += 1
      records += 1
      lineLength = 0
    } else lineLength += 1
    if (lineLength > MAX_LINE_BYTES || records > MAX_RECORDS) return { diagnostic: resourceLimit() }
  }
  if (lineLength && records >= MAX_RECORDS) return { diagnostic: resourceLimit() }
  const nonAsciiOffset = bytes.findIndex((value) => value > 0x7f)
  if (nonAsciiOffset >= 0) {
    const excerpt = Array.from(bytes.subarray(nonAsciiOffset, Math.min(bytes.length, nonAsciiOffset + 64)))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('')
    const anchor = Object.freeze({
      ...virtualAnchor(`hex:${excerpt}`),
      column: nonAsciiOffset + 1,
      byteOffset: nonAsciiOffset,
      rawOffset: nonAsciiOffset,
      rawLength: 1
    })
    return {
      diagnostic: diagnostic(
        'invalid-encoding',
        'blocking',
        'COSA .NET 仅接受 ASCII 文本；源文件含有非 ASCII 字节。',
        '请从 COSA 导出 ASCII .NET 文件，或确认文件编码后重新导入。',
        anchor
      )
    }
  }
  return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
}

function resourceLimit(): CosaNetDiagnostic {
  return diagnostic('resource-limit', 'blocking', 'COSA .NET 超过文件大小、行长、记录数或坐标数量上限。', '请将文件控制在 8 MiB、每行 16384 字节、10000 条记录及 10000 个坐标以内。', virtualAnchor())
}

function validCoordinate(value: CosaNetCoordinate | undefined): value is CosaNetCoordinate {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y))
}

function parseResult(
  records: readonly CosaNetRecordAnchor[],
  triangles: readonly CosaNetTriangle[],
  diagnostics: readonly CosaNetDiagnostic[]
): CosaNetParseResult {
  const blocked = diagnostics.some((item) => item.severity === 'blocking')
  return Object.freeze({
    state: blocked ? 'blocked' as const : 'valid' as const,
    triangles: blocked ? Object.freeze([]) : freezeArray(triangles),
    records: freezeArray(records),
    diagnostics: freezeArray(diagnostics)
  })
}

/**
 * Read one strict `point1,point2,point3` record per ASCII line and verify its
 * orientation from caller-provided known/approximate coordinates. A clockwise
 * line remains present, with a warning and an explicit swap suggestion; any
 * blocking line makes the whole result unusable rather than returning a prefix.
 */
export function parseCosaNet(source: CosaNetSource, coordinates: ReadonlyMap<string, CosaNetCoordinate>): CosaNetParseResult {
  if (coordinates.size > MAX_COORDINATES) {
    const limit = resourceLimit()
    return parseResult([limit.recordAnchor], [], [limit])
  }
  const decoded = sourceText(source)
  if ('diagnostic' in decoded) return parseResult([decoded.diagnostic.recordAnchor], [], [decoded.diagnostic])

  const lines = sourceLines(decoded.text)
  if (!lines.length) {
    const anchor = virtualAnchor()
    return parseResult([], [], [diagnostic('empty-source', 'blocking', 'COSA .NET 文件为空，未找到三点网形记录。', '至少提供一行 point1,point2,point3 三点记录后重新导入。', anchor)])
  }

  const records = lines.map(anchorFor)
  const triangles: CosaNetTriangle[] = []
  const diagnostics: CosaNetDiagnostic[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const recordAnchor = records[index]!
    const fields = line.raw.split(',')
    if (fields.length !== 3) {
      diagnostics.push(diagnostic(
        'invalid-record',
        'blocking',
        `COSA .NET 第 ${line.line} 行必须恰好包含三个逗号分隔的点名。`,
        '将该行改为 point1,point2,point3，且不要添加额外逗号或字段。',
        recordAnchor
      ))
      continue
    }

    const pointIds = fields.map((field) => field.trim()) as [string, string, string]
    const emptyIndex = pointIds.findIndex((pointId) => !pointId)
    if (emptyIndex >= 0) {
      diagnostics.push(diagnostic(
        'empty-point-id',
        'blocking',
        `COSA .NET 第 ${line.line} 行第 ${emptyIndex + 1} 个点名为空。`,
        '为三角形的三个顶点分别提供非空点名。',
        recordAnchor
      ))
      continue
    }
    if (new Set(pointIds).size !== 3) {
      diagnostics.push(diagnostic(
        'duplicate-point-id',
        'blocking',
        `COSA .NET 第 ${line.line} 行重复使用了同一个点名，不能形成三角形。`,
        '将该行改为三个互不相同的顶点点名。',
        recordAnchor
      ))
      continue
    }

    const coordinateValues = pointIds.map((pointId) => coordinates.get(pointId)) as [CosaNetCoordinate | undefined, CosaNetCoordinate | undefined, CosaNetCoordinate | undefined]
    const missingPointIds = pointIds.filter((pointId, pointIndex) => !validCoordinate(coordinateValues[pointIndex]))
    if (missingPointIds.length) {
      diagnostics.push(diagnostic(
        'missing-coordinate',
        'blocking',
        `COSA .NET 第 ${line.line} 行缺少点 ${missingPointIds.join('、')} 的有效已知或概略坐标。`,
        '在导入该 .NET 前提供每个顶点的有限 X、Y 坐标，或补充同名 .XYO 概略坐标文件。',
        recordAnchor
      ))
      continue
    }

    const [first, second, third] = coordinateValues as [CosaNetCoordinate, CosaNetCoordinate, CosaNetCoordinate]
    const signedDoubleArea = (second.x - first.x) * (third.y - first.y) - (third.x - first.x) * (second.y - first.y)
    if (signedDoubleArea === 0) {
      diagnostics.push(diagnostic(
        'degenerate-triangle',
        'blocking',
        `COSA .NET 第 ${line.line} 行三个顶点共线，无法验证逆时针网形。`,
        '检查已知/概略坐标，并使用三个不共线的三角形顶点。',
        recordAnchor
      ))
      continue
    }

    const orientation = signedDoubleArea > 0 ? 'counter-clockwise' as const : 'clockwise' as const
    const points = Object.freeze([...pointIds]) as readonly [string, string, string]
    const triangle = Object.freeze({
      id: `cosa-net-triangle-${line.line}`,
      points,
      signedDoubleArea,
      orientation,
      recordAnchor
    })
    triangles.push(triangle)

    if (orientation === 'clockwise') {
      diagnostics.push(diagnostic(
        'clockwise-triangle',
        'warning',
        `COSA .NET 第 ${line.line} 行的顶点顺序为顺时针（2S=${signedDoubleArea}），文件内容未被修改。`,
        `建议交换后两点：将“${pointIds.join(',')}”改为“${pointIds[0]},${pointIds[2]},${pointIds[1]}”。`,
        recordAnchor
      ))
    }
  }

  return parseResult(records, triangles, diagnostics)
}
