import type { MonitoringAnalysisV1, MonitoringObservationV1, RailwiseProjectV1 } from '../contracts/engineering.js'
import { monitoringTrendInstant } from './engineering-trend-chart.js'

/** Preserve v2 operation order and floating-point behavior; no storage/cache access. */
export function calculateMonitoringAnalysisV2(project: RailwiseProjectV1, observations: readonly MonitoringObservationV1[]): MonitoringAnalysisV1['results'] {
  const instants = new Map(observations.map(observation => [observation.id, monitoringTrendInstant(observation.timestamp).instant]))
  const grouped = new Map<string, MonitoringObservationV1[]>()
  for (const observation of observations) { const key = JSON.stringify([observation.monitoringItem, observation.point]); const list = grouped.get(key) ?? []; list.push(observation); grouped.set(key, list) }
  return [...grouped.values()].map((items) => {
    items.sort((a, b) => instants.get(a.id)! - instants.get(b.id)! || a.id.localeCompare(b.id)); const current = items.at(-1); const previous = items.at(-2); const first = items[0]
    const change = current && first && current !== first ? (current.cumulative ?? current.value) - (first.cumulative ?? first.value) : undefined; const intervalDays = current && previous ? (instants.get(current.id)! - instants.get(previous.id)!) / 86_400_000 : undefined; const rate = current && previous && Number.isFinite(intervalDays) && intervalDays! > 0 ? (current.value - previous.value) / intervalDays! : undefined
    const trend = change === undefined ? 'unknown' : Math.abs(change) < 1e-9 ? 'stable' : change > 0 ? 'rising' : 'falling'
    const threshold = project.thresholds[current?.monitoringItem ?? ''] ?? project.thresholds.default
    const magnitude = Math.abs(current?.value ?? 0)
    const thresholdStatus = threshold === undefined ? 'unresolved' : magnitude >= threshold ? 'alarm' : magnitude >= threshold * 0.8 ? 'warning' : 'normal'
    return { monitoringItem: current?.monitoringItem ?? items[0].monitoringItem, point: current?.point ?? items[0].point, currentValue: current?.value, previousValue: previous?.value, cumulativeChange: change, changeRate: rate, trend, anomaly: Math.abs(change ?? 0) > (threshold ?? Number.POSITIVE_INFINITY), thresholdStatus }
  })
}
