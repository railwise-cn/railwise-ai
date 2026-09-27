import { describe, expect, it } from 'vitest'
import { monitoringTrendInstant, renderMonitoringTrendChart, TREND_CHART_LIMITS } from './engineering-trend-chart.js'

const project = { name: '合成监测工程', unit: 'mm' }
const observation = (id: string, timestamp: string, value: number, point = 'S01', monitoringItem = '沉降', unit = 'mm') => ({ id, timestamp, value, point, monitoringItem, unit })
const markers = (svg: string) => [...svg.matchAll(/<circle data-role="observation" cx="([^"]+)" cy="([^"]+)"/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
const lines = (svg: string) => [...svg.matchAll(/<polyline data-role="trend-line"[^>]+points="([^"]+)"/g)].map(match => match[1]!.split(' ').map(pair => pair.split(',').map(Number)))

describe('monitoring trend chart', () => {
  it('plots both actual epochs for one point, sorts offset timestamps and uses proportional time distance', () => {
    const { svg, dataRange } = renderMonitoringTrendChart([
      observation('third', '2026-08-05T00:00:00Z', 8),
      observation('first', '2026-08-01T08:00:00+08:00', 2),
      observation('second', '2026-08-02T00:00:00Z', 4)
    ], project)
    const points = lines(svg)[0]!
    expect(points).toHaveLength(3)
    expect((points[1]![0]! - points[0]![0]!) / (points[2]![0]! - points[0]![0]!)).toBeCloseTo(.25, 5)
    expect(points[0]![1]).toBeGreaterThan(points[1]![1]!)
    expect(markers(svg)).toHaveLength(3)
    expect(dataRange).toEqual({ min: 2, max: 8 })
    expect(svg).toContain('Value (mm)')
    expect(svg).toContain('2026-08-01')
    expect(svg).toContain('2026-08-05')
  })
  it('never joins different points, monitoring items, units or delimiter-colliding identities', () => {
    const observations = [
      observation('a1', '2026-08-01', 1, 'a|b', 'c'), observation('a2', '2026-08-02', 2, 'a|b', 'c'),
      observation('b1', '2026-08-01', 5, 'b', 'c|a'), observation('b2', '2026-08-02', 6, 'b', 'c|a'),
      observation('c1', '2026-08-01', 7, 'other', 'c'), observation('c2', '2026-08-02', 8, 'other', 'c'),
      observation('d1', '2026-08-01', .001, 'a|b', 'c', 'm'), observation('d2', '2026-08-02', .002, 'a|b', 'c', 'm')
    ]
    const { svg, dataRange } = renderMonitoringTrendChart(observations, project)
    expect(lines(svg)).toHaveLength(4)
    expect(lines(svg).every(line => line.length === 2)).toBe(true)
    expect([...svg.matchAll(/data-panel-index=/g)]).toHaveLength(3)
    expect(markers(svg)).toHaveLength(8)
    expect(dataRange).toBeUndefined()
  })
  it('shows a single zero observation as a visible centered marker', () => {
    const { svg, dataRange } = renderMonitoringTrendChart([observation('zero', '2026-08-01', 0)], project)
    expect(lines(svg)).toHaveLength(0)
    expect(markers(svg)).toEqual([{ x: 515, y: 210 }])
    expect(svg).toContain('r="3.5"')
    expect(dataRange).toEqual({ min: 0, max: 0 })
    expect(svg).toContain('Unzoned times interpreted as UTC')
  })
  it('retains repeated timestamps as markers without inventing an ordered path through duplicates', () => {
    const { svg } = renderMonitoringTrendChart([
      observation('a', '2026-08-01', 1), observation('b', '2026-08-02', 2),
      observation('c', '2026-08-02', 3), observation('d', '2026-08-03', 4)
    ], project)
    expect(markers(svg)).toHaveLength(4)
    expect(lines(svg)).toHaveLength(0)
  })
  it('escapes hostile labels and strips forbidden XML characters without external resources', () => {
    const hostile = '<script>alert("x")</script>&\u0000\ud800'
    const { svg } = renderMonitoringTrendChart([observation('x', '2026-08-01', 1, hostile, hostile, hostile)], { name: hostile, unit: 'mm' })
    expect(svg).not.toMatch(/<script|<foreignObject|href=|onload=/)
    expect(svg.includes('\u0000')).toBe(false)
    expect(svg.includes('\ud800')).toBe(false)
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('&amp;')
    expect(svg).toContain('\uFFFD')
  })
  it.each([Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, 0])('keeps a constant finite magnitude %s drawable', value => {
    const { svg } = renderMonitoringTrendChart([observation('a', '2026-08-01', value), observation('b', '2026-08-02', value)], project)
    expect(svg).not.toMatch(/NaN|Infinity/)
    expect(markers(svg).every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true)
  })
  it('handles opposite finite extremes without arithmetic overflow', () => {
    const { svg } = renderMonitoringTrendChart([observation('a', '2026-08-01', -Number.MAX_VALUE), observation('b', '2026-08-02', Number.MAX_VALUE)], project)
    expect(svg).not.toMatch(/NaN|Infinity/)
  })
  it.each(['2026-02-30', '2026-13-01', '2026-08-01T24:01:00Z', '08/01/2026', 'bad-date'])('rejects ambiguous or invalid date %s', timestamp => {
    expect(() => renderMonitoringTrendChart([observation('x', timestamp, 1)], project)).toThrow(/date|timestamp/)
  })
  it('declares naive timestamp timezone explicitly and respects explicit offsets', () => {
    expect(monitoringTrendInstant('2026-08-01 08:00:00')).toEqual({ instant: Date.parse('2026-08-01T08:00:00Z'), assumedUtc: true })
    expect(monitoringTrendInstant('2026-08-01T08:00:00+08:00')).toEqual({ instant: Date.parse('2026-08-01T00:00:00Z'), assumedUtc: false })
  })
  it('fails explicitly for empty, nonfinite, duplicate identity or excessive input rather than truncating it', () => {
    expect(() => renderMonitoringTrendChart([], project)).toThrow()
    for (const value of [NaN, Infinity, -Infinity]) expect(() => renderMonitoringTrendChart([observation('x', '2026-08-01', value)], project)).toThrow(/finite/)
    expect(() => renderMonitoringTrendChart([observation('x', '2026-08-01', 1), observation('x', '2026-08-02', 2)], project)).toThrow(/unique/)
    expect(() => renderMonitoringTrendChart(Array.from({ length: TREND_CHART_LIMITS.seriesPerPanel + 1 }, (_, i) => observation(String(i), '2026-08-01', i, String(i))), project)).toThrow(/too many/)
    expect(() => renderMonitoringTrendChart([observation('x', '2026-08-01', 1, 'x'.repeat(513))], project)).toThrow(/label/)
  })
})
