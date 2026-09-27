import { weightedLeastSquares } from './survey-adjustment-core.js'
import type { CosaIn1ParseResult } from './survey-cosa-in1.js'

export type CosaOu1Height = Readonly<{
  id: string
  height: number
  standardErrorMm?: number
  printedResolutionMetres: number
  sourceLine: number
  raw: string
}>

export type CosaOu1Heights = Readonly<{
  state: 'valid' | 'blocked'
  points: readonly CosaOu1Height[]
  reason?: string
}>

function referenceLines(text: string): string[] | null {
  if (text.length > 8 * 1024 * 1024) return null
  let lineCount = 1
  let lineLength = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\r' || text[i] === '\n') {
      if (text[i] === '\r' && text[i + 1] === '\n') i += 1
      lineCount += 1
      lineLength = 0
    } else lineLength += 1
    if (lineCount > 100_000 || lineLength > 16_384) return null
  }
  return text.split(/\r\n|\r|\n/)
}

/** Read only the labelled adjusted-height table, never the approximate table. */
export function parseCosaOu1Heights(text: string): CosaOu1Heights {
  const blocked = (reason: string): CosaOu1Heights => ({ state: 'blocked', points: [], reason })
  const lines = referenceLines(text)
  if (!lines) return blocked('reference-resource-limit')
  const headings = lines.flatMap((line, index) => line.trim() === '高程平差值及其精度' ? [index] : [])
  if (headings.length !== 1) return blocked('adjusted-height-section-required')
  const heading = headings[0]!
  const header = lines[heading + 2]?.trim()
  if (!/^-+$/.test(lines[heading + 1]?.trim() ?? '') || !/^序号\s+点号\s+高程\(m\)\s+中误差\(mm\)$/.test(header ?? '')) return blocked('height-table-units-required')
  const points: CosaOu1Height[] = []
  const ids = new Set<string>()
  let terminated = false
  for (let i = heading + 3; i < lines.length; i += 1) {
    const raw = lines[i]!
    if (/^-+$/.test(raw.trim())) { terminated = true; break }
    if (!raw.trim()) continue
    const row = /^\s*(\d+)\s+(\S+)\s+([+-]?\d+\.(\d+))(?:\s+(\d+(?:\.\d+)?))?\s*$/.exec(raw)
    if (!row || Number(row[1]) !== points.length + 1 || ids.has(row[2]!) || !Number.isFinite(Number(row[3])) || (row[5] !== undefined && !Number.isFinite(Number(row[5])))) return blocked(`invalid-height-row:${i + 1}`)
    if (points.length >= 10_000 || row[4]!.length > 12) return blocked('reference-point-limit')
    ids.add(row[2]!)
    points.push(Object.freeze({ id: row[2]!, height: Number(row[3]), ...(row[5] === undefined ? {} : { standardErrorMm: Number(row[5]) }), printedResolutionMetres: 10 ** -row[4]!.length, sourceLine: i + 1, raw }))
  }
  if (!terminated || !points.length) return blocked('incomplete-height-table')
  return Object.freeze({ state: 'valid', points: Object.freeze(points) })
}

type PrintedValue = Readonly<{ value: number; resolution: number }>
type ReferenceKnownPoint = Readonly<{ id: string; height: PrintedValue; line: number }>
type ReferenceObservation = Readonly<{ from: string; to: string; heightDifference: PrintedValue; distanceKm: PrintedValue; weight: PrintedValue; line: number }>
export type CosaOu1SourceEvidence = Readonly<{
  state: 'valid' | 'blocked'
  knownPoints: readonly ReferenceKnownPoint[]
  observations: readonly ReferenceObservation[]
  reason?: string
}>

/** Verify that a same-stem OU1 actually reports the supplied IN1's inputs. */
export function parseCosaOu1SourceEvidence(text: string): CosaOu1SourceEvidence {
  const blocked = (reason: string): CosaOu1SourceEvidence => ({ state: 'blocked', knownPoints: [], observations: [], reason })
  const lines = referenceLines(text)
  if (!lines) return blocked('reference-resource-limit')
  const table = (title: string, header: RegExp): { cells: string[]; line: number }[] | null => {
    const headings = lines.flatMap((line, i) => line.trim() === title ? [i] : [])
    if (headings.length !== 1) return null
    const start = headings[0]!
    if (!/^-+$/.test(lines[start + 1]?.trim() ?? '') || !header.test(lines[start + 2]?.trim() ?? '')) return null
    const rows: { cells: string[]; line: number }[] = []
    for (let i = start + 3; i < lines.length; i += 1) {
      const raw = lines[i]!.trim()
      if (/^-+$/.test(raw)) return rows.length ? rows : null
      if (!raw) continue
      const cells = raw.split(/\s+/)
      if (rows.length >= 10_000 || !/^\d+$/.test(cells[0]!) || Number(cells[0]) !== rows.length + 1) return null
      rows.push({ cells, line: i + 1 })
    }
    return null
  }
  const knownRows = table('已知点信息', /^序号\s+点号\s+高程\(m\)$/)
  const observationRows = table('测段实测高差数据统计', /^序号\s+起点\s+终点\s+高差\(m\)\s+距离\(km\)\s+权$/)
  if (!knownRows || !observationRows) return blocked('source-tables-and-units-required')
  const decimal = (raw: string): PrintedValue | null => {
    const match = /^[+-]?\d+\.(\d{1,12})$/.exec(raw)
    return match && Number.isFinite(Number(raw)) ? { value: Number(raw), resolution: 10 ** -match[1]!.length } : null
  }
  const knownPoints: ReferenceKnownPoint[] = []
  const observations: ReferenceObservation[] = []
  const ids = new Set<string>()
  for (const { cells, line } of knownRows) {
    const height = decimal(cells[2] ?? '')
    if (cells.length !== 3 || !height || ids.has(cells[1]!)) return blocked(`invalid-known-source-row:${line}`)
    ids.add(cells[1]!)
    knownPoints.push({ id: cells[1]!, height, line })
  }
  for (const { cells, line } of observationRows) {
    const heightDifference = decimal(cells[3] ?? '')
    const distanceKm = decimal(cells[4] ?? '')
    const weight = decimal(cells[5] ?? '')
    if (cells.length !== 6 || !heightDifference || !distanceKm || !weight || distanceKm.value <= 0 || weight.value <= 0 || cells[1] === cells[2]) return blocked(`invalid-observation-source-row:${line}`)
    observations.push({ from: cells[1]!, to: cells[2]!, heightDifference, distanceKm, weight, line })
  }
  return { state: 'valid', knownPoints, observations }
}

export type CosaSourceEvidenceComparison = Readonly<{
  status: 'matched' | 'different' | 'blocked'
  reason?: string
  knownPointCount?: number
  observationCount?: number
  mismatches?: readonly Readonly<{ sourceRecord: number; referenceLine?: number; fields: readonly string[] }>[]
}>

export function compareCosaLevelSourceEvidence(input: CosaIn1ParseResult, reference: CosaOu1SourceEvidence): CosaSourceEvidenceComparison {
  if (input.state !== 'valid' || reference.state !== 'valid') return { status: 'blocked', reason: 'invalid-input-or-reference-source' }
  if ([input.knownPoints, input.observations, reference.knownPoints, reference.observations].some((items) => items.length > 10_000)) return { status: 'blocked', reason: 'comparison-dimension-limit' }
  if (input.knownPoints.length !== reference.knownPoints.length || input.observations.length !== reference.observations.length) return { status: 'blocked', reason: 'reference-source-count-mismatch' }
  const matches = (value: number, printed: PrintedValue): boolean => Number.isFinite(value) && Math.abs(value - printed.value) <= printed.resolution / 2 + 1e-9
  const mismatches: { sourceRecord: number; referenceLine?: number; fields: string[] }[] = []
  const known = new Map(reference.knownPoints.map((point) => [point.id, point]))
  for (const point of input.knownPoints) {
    const record = known.get(point.id)
    if (!record || !matches(point.height, record.height)) mismatches.push({ sourceRecord: point.recordAnchor.line, referenceLine: record?.line, fields: [record ? 'knownHeight' : 'pointId'] })
  }
  for (const [index, observation] of input.observations.entries()) {
    const record = reference.observations[index]!
    const fields: string[] = []
    if (record.from !== observation.from || record.to !== observation.to) fields.push('endpoints')
    if (!matches(observation.value, record.heightDifference)) fields.push('heightDifference')
    if (!matches(observation.routeLengthKm, record.distanceKm)) fields.push('distanceKm')
    if (!matches(1 / observation.routeLengthKm, record.weight)) fields.push('inverseDistanceWeight')
    if (fields.length) mismatches.push({ sourceRecord: observation.recordAnchor.line, referenceLine: record.line, fields })
  }
  return { status: mismatches.length ? 'different' : 'matched', knownPointCount: input.knownPoints.length, observationCount: input.observations.length, mismatches }
}

export type CosaLevelReferenceComparison = Readonly<{
  status: 'matched' | 'different' | 'blocked'
  reason?: string
  knownPointCount?: number
  unknownPointCount?: number
  observationCount?: number
  comparedPointCount?: number
  mismatchCount?: number
  degreesOfFreedom?: number
  maxHeightDifferenceMetres?: number
}>

/** Research comparison only: no network admission, mutations or deliverables. */
export function compareCosaLevelHeights(input: CosaIn1ParseResult, reference: CosaOu1Heights): CosaLevelReferenceComparison {
  if (input.state !== 'valid' || reference.state !== 'valid') return { status: 'blocked', reason: 'invalid-input-or-reference' }
  if (input.knownPoints.length > 1_000 || reference.points.length > 1_000 || input.observations.length > 10_000) return { status: 'blocked', reason: 'comparison-dimension-limit' }
  const known = new Map(input.knownPoints.map((point) => [point.id, point.height]))
  const ids = new Set(known.keys())
  for (const observation of input.observations) { ids.add(observation.from); ids.add(observation.to) }
  if (ids.size > 1_000 || input.observations.length > 10_000) return { status: 'blocked', reason: 'comparison-dimension-limit' }
  const unknown = [...ids].filter((id) => !known.has(id))
  const indexes = new Map(unknown.map((id, index) => [id, index]))
  if (!unknown.length || reference.points.length !== ids.size || reference.points.some((point) => !ids.has(point.id))) return { status: 'blocked', reason: 'reference-point-set-mismatch' }
  const equations = input.observations.map((observation) => {
    const coefficients = Array<number>(unknown.length).fill(0)
    const from = indexes.get(observation.from)
    const to = indexes.get(observation.to)
    if (from !== undefined) coefficients[from] = -1
    if (to !== undefined) coefficients[to] = 1
    return { coefficients, misclosure: observation.value - ((known.get(observation.to) ?? 0) - (known.get(observation.from) ?? 0)), weight: 1 / observation.routeLengthKm }
  })
  const solved = weightedLeastSquares(equations)
  if (!solved) return { status: 'blocked', reason: 'rank-deficient' }
  if (solved.corrections.some((value) => !Number.isFinite(value)) || solved.residuals.some((value) => !Number.isFinite(value)) || !Number.isFinite(solved.varianceFactor)) return { status: 'blocked', reason: 'non-finite-solution' }
  let maxDifference = 0
  let mismatches = 0
  for (const point of reference.points) {
    const height = known.get(point.id) ?? solved.corrections[indexes.get(point.id)!]!
    const difference = Math.abs(height - point.height)
    maxDifference = Math.max(maxDifference, difference)
    // OU1 is rounded text, not a full-precision binary reference.
    if (difference > point.printedResolutionMetres / 2 + 1e-9) mismatches += 1
  }
  return {
    status: mismatches ? 'different' : 'matched', knownPointCount: known.size, unknownPointCount: unknown.length,
    observationCount: equations.length, comparedPointCount: reference.points.length, mismatchCount: mismatches,
    degreesOfFreedom: solved.dof, maxHeightDifferenceMetres: maxDifference
  }
}
