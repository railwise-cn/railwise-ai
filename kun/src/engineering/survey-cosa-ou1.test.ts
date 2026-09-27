import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCosaIn1 } from './survey-cosa-in1.js'
import { compareCosaLevelHeights, compareCosaLevelSourceEvidence, parseCosaOu1Heights, parseCosaOu1SourceEvidence } from './survey-cosa-ou1.js'

const mapping = JSON.parse(readFileSync(new URL('./fixtures/survey-formats/professional/cosa-in1-mapping.json', import.meta.url), 'utf8'))
const input = parseCosaIn1('A,100\nB,101\n\nA,P,0.25,0.1\nP,B,0.75,0.2\n', mapping)
const table = [
  '概略高程', '1 P 12345.67890',
  '高程平差值及其精度', '--------------------',
  '序号 点号 高程(m) 中误差(mm)',
  '1 A 100.00000', '2 B 101.00000', '3 P 100.25000 0.50',
  '--------------------'
].join('\n')

describe('COSA OU1 read-only adjusted-height reference', () => {
  it('reads the labelled result table and preserves printed precision, not approximate heights', () => {
    const result = parseCosaOu1Heights(table)
    expect(result.state).toBe('valid')
    expect(result.points[2]).toMatchObject({ id: 'P', height: 100.25, standardErrorMm: 0.5, sourceLine: 8 })
    expect(result.points[2]?.printedResolutionMetres).toBeCloseTo(0.00001, 12)
    expect(compareCosaLevelHeights(input, result)).toMatchObject({ status: 'matched', comparedPointCount: 3, mismatchCount: 0, observationCount: 2 })
  })

  it('detects a numerical mismatch rather than treating successful parsing as acceptance', () => {
    expect(compareCosaLevelHeights(input, parseCosaOu1Heights(table.replace('100.25000', '100.25100')))).toMatchObject({ status: 'different', mismatchCount: 1 })
  })

  it('allows only the rounding error implied by the printed reference', () => {
    expect(compareCosaLevelHeights(input, parseCosaOu1Heights(table.replace('100.25000', '100.250004')))).toMatchObject({ status: 'different' })
  })

  it.each([
    table + '\n' + table,
    table.replace('高程(m)', '高程(ft)'),
    table.replace('3 P', '3 A'),
    table.replace('3 P', '4 P'),
    table.replace('100.25000', 'NaN'),
    table.slice(0, table.lastIndexOf('--------------------'))
  ])('fails closed on ambiguous or incomplete tables', (text) => {
    expect(parseCosaOu1Heights(text)).toMatchObject({ state: 'blocked', points: [] })
  })

  it('requires identical point sets and a valid source mapping', () => {
    expect(compareCosaLevelHeights(input, parseCosaOu1Heights(table.replace('3 P', '3 OTHER')))).toMatchObject({ status: 'blocked', reason: 'reference-point-set-mismatch' })
    expect(compareCosaLevelHeights(parseCosaIn1(''), parseCosaOu1Heights(table))).toMatchObject({ status: 'blocked' })
  })

  it('compares the paired source tables before treating a report as a reference', () => {
    const source = [
      '已知点信息', '--------------------', '序号 点号 高程(m)',
      '1 A 100.00000', '2 B 101.00000', '--------------------',
      '测段实测高差数据统计', '--------------------', '序号 起点 终点 高差(m) 距离(km) 权',
      '1 A P 0.25000 0.1000 10.000', '2 P B 0.75000 0.2000 5.000', '--------------------'
    ].join('\n')
    const evidence = parseCosaOu1SourceEvidence(source)
    expect(evidence.state).toBe('valid')
    expect(compareCosaLevelSourceEvidence(input, evidence)).toMatchObject({ status: 'matched', knownPointCount: 2, observationCount: 2 })
    expect(compareCosaLevelSourceEvidence(input, parseCosaOu1SourceEvidence(source.replace('2 P B 0.75000', '2 P B 0.75100')))).toMatchObject({ status: 'different' })
  })

  it('blocks a report whose measured-section count does not match the source', () => {
    const source = [
      '已知点信息', '--------------------', '序号 点号 高程(m)',
      '1 A 100.00000', '2 B 101.00000', '--------------------',
      '测段实测高差数据统计', '--------------------', '序号 起点 终点 高差(m) 距离(km) 权',
      '1 A P 0.25000 0.1000 10.000', '--------------------'
    ].join('\n')
    expect(compareCosaLevelSourceEvidence(input, parseCosaOu1SourceEvidence(source))).toMatchObject({ status: 'blocked', reason: 'reference-source-count-mismatch' })
  })

  it('enforces character, line count and line length limits in both reference readers', () => {
    for (const source of [' '.repeat(8 * 1024 * 1024 + 1), '\r\n'.repeat(100_000), ' '.repeat(16_385) + '\n' + table]) {
      expect(parseCosaOu1Heights(source)).toMatchObject({ state: 'blocked', points: [], reason: 'reference-resource-limit' })
      expect(parseCosaOu1SourceEvidence(source)).toMatchObject({ state: 'blocked', knownPoints: [], observations: [], reason: 'reference-resource-limit' })
    }
    expect(parseCosaOu1Heights(' '.repeat(16_384) + '\n' + table).state).toBe('valid')
    expect(parseCosaOu1Heights('\n'.repeat(100_000 - table.split('\n').length) + table).state).toBe('valid')
  })

  it('accepts the reference point limit and rejects an extra point without returning a prefix', () => {
    const heights = (count: number) => ['高程平差值及其精度', '---', '序号 点号 高程(m) 中误差(mm)', ...Array.from({ length: count }, (_, i) => `${i + 1} P${i} 100.00000 0.50`), '---'].join('\n')
    expect(parseCosaOu1Heights(heights(10_000)).points).toHaveLength(10_000)
    expect(parseCosaOu1Heights(heights(10_001))).toMatchObject({ state: 'blocked', points: [], reason: 'reference-point-limit' })
    const source = (known: number, observations: number) => [
      '已知点信息', '---', '序号 点号 高程(m)', ...Array.from({ length: known }, (_, i) => `${i + 1} P${i} 100.00000`), '---',
      '测段实测高差数据统计', '---', '序号 起点 终点 高差(m) 距离(km) 权', ...Array.from({ length: observations }, (_, i) => `${i + 1} A P${i} 0.25000 0.1000 10.000`), '---'
    ].join('\n')
    expect(parseCosaOu1SourceEvidence(source(10_000, 10_000))).toMatchObject({ state: 'valid' })
    for (const text of [source(10_001, 1), source(1, 10_001)]) {
      expect(parseCosaOu1SourceEvidence(text)).toMatchObject({ state: 'blocked', knownPoints: [], observations: [] })
    }
  })

  it('rejects oversized comparison arrays before allocating a least-squares system', () => {
    const reference = parseCosaOu1Heights(table)
    expect(compareCosaLevelHeights({ ...input, observations: Array(10_001).fill(input.observations[0]) }, reference)).toMatchObject({ status: 'blocked', reason: 'comparison-dimension-limit' })
    expect(compareCosaLevelHeights({ ...input, knownPoints: Array(1_001).fill(input.knownPoints[0]) }, reference)).toMatchObject({ status: 'blocked', reason: 'comparison-dimension-limit' })
    expect(compareCosaLevelHeights(input, { ...reference, points: Array(1_001).fill(reference.points[0]) })).toMatchObject({ status: 'blocked', reason: 'comparison-dimension-limit' })
    const evidence = parseCosaOu1SourceEvidence(['已知点信息', '---', '序号 点号 高程(m)', '1 A 100.00000', '---', '测段实测高差数据统计', '---', '序号 起点 终点 高差(m) 距离(km) 权', '1 A P 0.25000 0.1000 10.000', '---'].join('\n'))
    for (const key of ['knownPoints', 'observations'] as const) {
      expect(compareCosaLevelSourceEvidence({ ...input, [key]: Array(10_001).fill(input[key][0]) }, evidence)).toMatchObject({ status: 'blocked', reason: 'comparison-dimension-limit' })
      expect(compareCosaLevelSourceEvidence(input, { ...evidence, [key]: Array(10_001).fill(evidence[key][0]) })).toMatchObject({ status: 'blocked', reason: 'comparison-dimension-limit' })
    }
  })
})
