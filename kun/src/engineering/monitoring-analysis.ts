import type { MonitoringAnalysisV1, MonitoringObservationV1, RailwiseProjectV1 } from '../contracts/engineering.js'
import { monitoringTrendInstant } from './engineering-trend-chart.js'

/** Preserve v2 operation order and floating-point behavior; no storage/cache access. */
export function calculateMonitoringAnalysisV2(project: RailwiseProjectV1, observations: readonly MonitoringObservationV1[]): MonitoringAnalysisV1['results'] {
  const instants = new Map(observations.map(observation => [observation.id, monitoringTrendInstant(observation.timestamp).instant]))
  const grouped = new Map<string, MonitoringObservationV1[]>()
  for (const observation of observations) { const key = JSON.stringify([observation.monitoringItem, observation.point]); const list = grouped.get(key) ?? []; list.push(observation); grouped.set(key, list) }
  return [...grouped.values()].map((items) => {
    items.sort((a, b) => instants.get(a.id)! - instants.get(b.id)! || a.id.localeCompare(b.id)); const current = items.at(-1); const previous = items.at(-2); const first = items[0]
    const projectUnit = project.unit.trim()
    const units = new Set(items.map(item => item.unit?.trim() || projectUnit))
    const currentUnit = current?.unit?.trim() || projectUnit
    const unitStatus = units.size > 1 ? 'conflict' as const : currentUnit === projectUnit ? 'aligned' as const : 'source-differs' as const
    const ambiguousPeriod = items.some((item, index) => index > 0 && instants.get(item.id) === instants.get(items[index - 1]!.id))
    const cumulativeFlags = items.map(item => item.cumulative !== undefined)
    const cumulativeBasis = cumulativeFlags.every(Boolean) ? 'source-cumulative' as const : cumulativeFlags.every(flag => !flag) ? 'observed-value' as const : 'mixed-unavailable' as const
    // A consistent source unit can support changes in that source unit even
    // when the project declaration differs; threshold conclusions still need
    // an aligned project unit below.
    const safeForArithmetic = unitStatus !== 'conflict' && !ambiguousPeriod
    const safeForThreshold = unitStatus === 'aligned' && !ambiguousPeriod
    const safeCumulative = safeForArithmetic && cumulativeBasis !== 'mixed-unavailable'
    const cumulativeChange = safeCumulative && current && first && current !== first ? (cumulativeBasis === 'source-cumulative' ? current.cumulative! - first.cumulative! : current.value - first.value) : undefined
    const intervalDays = current && previous ? (instants.get(current.id)! - instants.get(previous.id)!) / 86_400_000 : undefined
    const rate = safeForArithmetic && current && previous && Number.isFinite(intervalDays) && intervalDays! > 0 ? (current.value - previous.value) / intervalDays! : undefined
    const trend = cumulativeChange === undefined ? 'unknown' : Math.abs(cumulativeChange) < 1e-9 ? 'stable' : cumulativeChange > 0 ? 'rising' : 'falling'
    const threshold = project.thresholds[current?.monitoringItem ?? ''] ?? project.thresholds.default
    const magnitude = Math.abs(current?.value ?? 0)
    const thresholdStatus = !safeForThreshold || threshold === undefined ? 'unresolved' as const : magnitude >= threshold ? 'alarm' as const : magnitude >= threshold * 0.8 ? 'warning' as const : 'normal' as const
    return { monitoringItem: current?.monitoringItem ?? items[0].monitoringItem, point: current?.point ?? items[0].point, currentValue: current?.value, previousValue: previous?.value, cumulativeChange, changeRate: rate, trend, anomaly: safeForThreshold && Math.abs(cumulativeChange ?? 0) > (threshold ?? Number.POSITIVE_INFINITY), thresholdStatus, unit: currentUnit, unitStatus, cumulativeBasis }
  })
}
