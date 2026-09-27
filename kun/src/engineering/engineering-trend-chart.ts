import type { MonitoringObservationV1 } from '../contracts/engineering.js'

type Observation = Pick<MonitoringObservationV1, 'id' | 'monitoringItem' | 'point' | 'timestamp' | 'value' | 'unit'>
type Sample = Observation & { instant: number; assumedUtc: boolean }
const COLORS = ['#2563eb', '#dc2626', '#16a34a', '#ca8a04', '#9333ea', '#0891b2', '#e11d48', '#65a30d', '#c026d3', '#ea580c']
export const TREND_CHART_LIMITS = { observations: 20000, panels: 24, seriesPerPanel: 10, labelCodePoints: 512 } as const
const WIDTH = 960, PANEL_HEIGHT = 420, LEFT = 106, RIGHT = 924, TOP = 100, BOTTOM = 320

/** Reject unsupported/ambiguous date grammars; ISO local/date-only values explicitly use UTC. */
export function monitoringTrendInstant(text: string): { instant: number; assumedUtc: boolean } {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(text)
  if (!match) throw new Error('trend chart requires ISO calendar dates or timestamps')
  const [, year, month, day, hour, minute, second, fraction, zone] = match
  const calendar = new Date(0)
  calendar.setUTCFullYear(Number(year), Number(month) - 1, Number(day)); calendar.setUTCHours(0, 0, 0, 0)
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() !== Number(month) - 1 || calendar.getUTCDate() !== Number(day)
    || Number(hour ?? 0) > 23 || Number(minute ?? 0) > 59 || Number(second ?? 0) > 59
    || (zone && zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) throw new Error('trend chart timestamp is invalid')
  const value = Date.parse(`${year}-${month}-${day}T${hour ?? '00'}:${minute ?? '00'}:${second ?? '00'}${fraction ? `.${fraction}` : ''}${zone ?? 'Z'}`)
  if (!Number.isFinite(value)) throw new Error('trend chart timestamp is invalid')
  return { instant: value, assumedUtc: !zone }
}

function xml(value: string): string {
  // XML 1.0 cannot represent these controls, unpaired surrogates or noncharacters.
  const safe = Array.from(value).map(character => {
    const code = character.codePointAt(0)!
    return (code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0xd7ff
      || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff) ? character : '\uFFFD'
  }).join('')
  return safe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
function short(value: string, maximum: number): string {
  const chars = Array.from(value.replace(/\s+/g, ' '))
  return chars.length > maximum ? chars.slice(0, maximum - 1).join('') + '…' : chars.join('')
}
const number = (value: number): string => value === 0 ? '0' : Number(value.toPrecision(7)).toString()
const position = (value: number): string => {
  if (!Number.isFinite(value)) throw new Error('trend chart coordinate is not finite')
  return value.toFixed(3)
}

/** A point belongs to exactly one item/unit panel; no line ever crosses point IDs. */
export function renderMonitoringTrendChart(observations: readonly Observation[], project: { name: string; unit: string }): { svg: string; dataRange?: { min: number; max: number } } {
  if (!observations.length || observations.length > TREND_CHART_LIMITS.observations) throw new Error('trend chart requires 1–20000 observations; split the dataset without dropping records')
  const label = (value: string): string => {
    if (typeof value !== 'string' || Array.from(value).length > TREND_CHART_LIMITS.labelCodePoints) throw new Error('trend chart label exceeds supported length')
    return value
  }
  label(project.name); label(project.unit)
  const panels = new Map<string, { item: string; unit: string; series: Map<string, Sample[]> }>()
  let min = Infinity, max = -Infinity, first = Infinity, last = -Infinity, assumedUtc = false
  const ids = new Set<string>()
  for (const observation of observations) {
    if (!Number.isFinite(observation.value) || !observation.id || ids.has(observation.id)) throw new Error('trend chart requires finite values and unique observation IDs')
    ids.add(observation.id)
    const item = label(observation.monitoringItem), point = label(observation.point)
    if (!item.trim() || !point.trim()) throw new Error('trend chart requires item and point identities')
    const unit = label(observation.unit?.trim() ? observation.unit : project.unit)
    const sample = { ...observation, ...monitoringTrendInstant(observation.timestamp) }
    assumedUtc ||= sample.assumedUtc
    min = Math.min(min, sample.value); max = Math.max(max, sample.value)
    first = Math.min(first, sample.instant); last = Math.max(last, sample.instant)
    const key = JSON.stringify([item, unit])
    const panel = panels.get(key) ?? { item, unit, series: new Map<string, Sample[]>() }
    const series = panel.series.get(point) ?? []
    series.push(sample); panel.series.set(point, series); panels.set(key, panel)
    if (panels.size > TREND_CHART_LIMITS.panels || panel.series.size > TREND_CHART_LIMITS.seriesPerPanel) throw new Error('trend chart has too many panels or series; split the dataset without dropping records')
  }
  const height = 100 + panels.size * PANEL_HEIGHT + 40
  const body: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="chart-title chart-description">`,
    '<title id="chart-title">监测趋势 / Monitoring trends</title>',
    '<desc id="chart-description">原始观测值按监测项、单位与测点分组，横轴为实际时间；不同测点不连线。Observation values grouped by item, unit and point; time is proportional. No lines cross point identities.</desc>',
    '<rect width="100%" height="100%" fill="#ffffff"/>',
    '<g font-family="PingFang SC, Microsoft YaHei, sans-serif" fill="#172033" font-variant-numeric="tabular-nums">',
    '<text x="32" y="29" font-size="20" font-weight="600">监测趋势 / Monitoring trends</text>',
    `<text x="32" y="53" font-size="13"><title>${xml(project.name)}</title>${xml(short(project.name, 70))}</text>`,
    `<text x="32" y="77" font-size="11" fill="#526176">${observations.length} 观测 / observations · ${panels.size} 分组 / panels · UTC${assumedUtc ? ' · 未标时区按 UTC / Unzoned times interpreted as UTC' : ''}</text>`
  ]
  let panelIndex = 0
  for (const panel of panels.values()) {
    const samples = [...panel.series.values()].flat()
    let panelMin = Infinity, panelMax = -Infinity
    for (const sample of samples) { panelMin = Math.min(panelMin, sample.value); panelMax = Math.max(panelMax, sample.value) }
    // Normalize before subtraction so opposite-sign finite extremes cannot overflow.
    const magnitude = Math.max(Math.abs(panelMin), Math.abs(panelMax)) || 1
    let lower = panelMin / magnitude, upper = panelMax / magnitude
    const padding = upper === lower ? 0.1 : (upper - lower) * 0.08
    lower = Math.max(-1, lower - padding); upper = Math.min(1, upper + padding)
    const x = (time: number): number => first === last ? (LEFT + RIGHT) / 2 : LEFT + (time - first) / (last - first) * (RIGHT - LEFT)
    const y = (value: number): number => BOTTOM - (value / magnitude - lower) / (upper - lower) * (BOTTOM - TOP)
    body.push(`<g transform="translate(0,${100 + panelIndex * PANEL_HEIGHT})" data-panel-index="${panelIndex}">`,
      `<text x="32" y="22" font-size="15" font-weight="600"><title>${xml(panel.item)}</title>${xml(short(panel.item, 60))}</text>`,
      `<text x="${LEFT}" y="89" font-size="11" fill="#526176"><title>${xml(panel.unit)}</title>观测值 / Value (${xml(short(panel.unit || '未声明 / unspecified', 35))})</text>`)
    for (let index = 0; index <= 4; index++) {
      const py = BOTTOM - index / 4 * (BOTTOM - TOP), value = (lower + (upper - lower) * index / 4) * magnitude
      body.push(`<line x1="${LEFT}" y1="${py}" x2="${RIGHT}" y2="${py}" stroke="#e5e7eb"/>`,
        `<text x="${LEFT - 12}" y="${py + 4}" text-anchor="end" font-size="11">${xml(number(value))}</text>`)
    }
    const tickCount = first === last ? 1 : 5
    for (let index = 0; index < tickCount; index++) {
      const time = first === last ? first : first + (last - first) * index / (tickCount - 1), px = x(time)
      const iso = new Date(time).toISOString()
      const clock = last - first < 10000 ? iso.slice(11, 23) : iso.slice(11, 19)
      body.push(`<line x1="${position(px)}" y1="${BOTTOM}" x2="${position(px)}" y2="${BOTTOM + 5}" stroke="#8a97a8"/>`,
        `<text x="${position(px)}" y="${BOTTOM + 22}" text-anchor="middle" font-size="10">${iso.slice(0, 10)}</text>`,
        `<text x="${position(px)}" y="${BOTTOM + 37}" text-anchor="middle" font-size="10" fill="#526176">${clock}</text>`)
    }
    body.push(`<line x1="${LEFT}" y1="${TOP}" x2="${LEFT}" y2="${BOTTOM}" stroke="#8a97a8"/>`,
      `<line x1="${LEFT}" y1="${BOTTOM}" x2="${RIGHT}" y2="${BOTTOM}" stroke="#8a97a8"/>`,
      `<text x="${(LEFT + RIGHT) / 2}" y="${BOTTOM + 62}" text-anchor="middle" font-size="11">日期与时间 / Date and time (UTC)</text>`)
    let seriesIndex = 0
    for (const [point, series] of panel.series) {
      series.sort((a, b) => a.instant - b.instant || a.id.localeCompare(b.id))
      const color = COLORS[seriesIndex]!, lx = 32 + seriesIndex % 5 * 184, ly = 47 + Math.floor(seriesIndex / 5) * 20
      body.push(`<g data-series-index="${seriesIndex}"><title>${xml(panel.item)} / ${xml(point)} (${xml(panel.unit)})</title>`,
        `<line x1="${lx}" y1="${ly - 4}" x2="${lx + 18}" y2="${ly - 4}" stroke="${color}" stroke-width="2"/>`,
        `<circle cx="${lx + 9}" cy="${ly - 4}" r="3" fill="${color}"/>`,
        `<text x="${lx + 24}" y="${ly}" font-size="11"><title>${xml(point)}</title>${xml(short(point, 12))}</text>`)
      // Duplicate instants remain visible markers, but are not connected through an arbitrary tie order.
      let segment: Sample[] = []
      const flush = (): void => {
        if (segment.length > 1) body.push(`<polyline data-role="trend-line" fill="none" stroke="${color}" stroke-width="2" points="${segment.map(s => `${position(x(s.instant))},${position(y(s.value))}`).join(' ')}"/>`)
        segment = []
      }
      for (let index = 0; index < series.length; index++) {
        const sample = series[index]!, duplicate = series[index - 1]?.instant === sample.instant || series[index + 1]?.instant === sample.instant
        if (duplicate) flush()
        else segment.push(sample)
        body.push(`<circle data-role="observation" cx="${position(x(sample.instant))}" cy="${position(y(sample.value))}" r="3.5" fill="${color}" stroke="#fff" stroke-width="1"><title>${xml(point)} · ${xml(sample.timestamp)} · ${xml(String(sample.value))} ${xml(panel.unit)}</title></circle>`)
      }
      flush(); body.push('</g>'); seriesIndex++
    }
    body.push(`<text x="32" y="408" font-size="10" fill="#526176">${samples.length} 条观测 / observations · 同时刻重复记录仅标点 / Duplicate times: markers only</text>`, '</g>')
    panelIndex++
  }
  body.push(`<text x="32" y="${height - 15}" font-size="10" fill="#526176">原始观测值；不代表累计变化或速率 / Observation values, not cumulative changes or rates.</text>`, '</g></svg>')
  // The legacy scalar range has no unit field; omit it rather than aggregate incompatible units.
  return { svg: body.join('\n'), ...(new Set([...panels.values()].map(panel => panel.unit)).size === 1 ? { dataRange: { min, max } } : {}) }
}
