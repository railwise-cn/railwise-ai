import { MonitoringProfessionalDailyRowV1, MonitoringProfessionalReportV1, type MonitoringProfessionalDailyRowV1 as DailyRow } from '../contracts/engineering-monitoring-report.js'
import type { MonitoringAnalysisV1, MonitoringDatasetV1, MonitoringObservationV1, RailwiseProjectV1 } from '../contracts/engineering.js'
import { monitoringTrendInstant } from './engineering-trend-chart.js'

type Dataset = MonitoringDatasetV1 & { observations: MonitoringObservationV1[] }

function valueForCumulative(observation: MonitoringObservationV1): number {
  return observation.cumulative ?? observation.value
}

function sortObservations(observations: readonly MonitoringObservationV1[]): MonitoringObservationV1[] {
  return [...observations].sort((a, b) => monitoringTrendInstant(a.timestamp).instant - monitoringTrendInstant(b.timestamp).instant || a.id.localeCompare(b.id))
}

function observationUnit(observation: MonitoringObservationV1, projectUnit: string): string {
  const unit = observation.unit?.trim()
  return unit || projectUnit
}

/** Build one current row per monitoring item and point, preserving source anchors. */
export function buildMonitoringProfessionalReport(input: {
  project: RailwiseProjectV1
  dataset: Dataset
  analysis?: MonitoringAnalysisV1
  generatedAt: string
}): MonitoringProfessionalReportV1 {
  if (input.dataset.projectId !== input.project.id) throw new Error('monitoring report dataset does not belong to the selected project')
  if (input.analysis && (input.analysis.projectId !== input.project.id || input.analysis.datasetId !== input.dataset.id)) {
    throw new Error('monitoring report analysis does not belong to the selected dataset')
  }
  const groups = new Map<string, MonitoringObservationV1[]>()
  for (const observation of input.dataset.observations) {
    if (observation.projectId !== input.project.id || observation.datasetId !== input.dataset.id) {
      throw new Error(`monitoring report observation ${observation.id} is not bound to the selected dataset`)
    }
    const key = `${observation.monitoringItem}\u0000${observation.point}`
    const group = groups.get(key) ?? []
    group.push(observation)
    groups.set(key, group)
  }
  const analysisByKey = new Map((input.analysis?.results ?? []).map(result => [`${result.monitoringItem}\u0000${result.point}`, result]))
  const rows: DailyRow[] = []
  for (const observations of groups.values()) {
    const ordered = sortObservations(observations)
    const units = new Set(ordered.map((observation) => observationUnit(observation, input.project.unit)))
    const current = ordered.at(-1)
    if (!current) continue
    const currentUnit = observationUnit(current, input.project.unit)
    const unitConflict = units.size > 1
    const declaredUnits = new Set(ordered.flatMap((observation) => observation.unit?.trim() ? [observation.unit.trim()] : []))
    const unitAlignment = declaredUnits.size === 0
      ? 'not-declared' as const
      : [...declaredUnits].every((unit) => unit === input.project.unit.trim())
        ? 'aligned' as const
        : 'source-differs' as const
    // Keep the actual first and previous periods even when units conflict.
    // Such histories cannot support changes, rates or a threshold conclusion.
    const first = ordered[0]
    if (!first) continue
    const previous = ordered.length > 1 ? ordered.at(-2) : undefined
    const analysis = analysisByKey.get(`${current.monitoringItem}\u0000${current.point}`)
    const cumulativeFlags = ordered.map(observation => observation.cumulative !== undefined)
    const cumulativeBasis = cumulativeFlags.every(Boolean) ? 'source-cumulative' as const : cumulativeFlags.every(flag => !flag) ? 'observed-value' as const : 'mixed-unavailable' as const
    const firstCumulative = valueForCumulative(first)
    const currentCumulative = valueForCumulative(current)
    const currentInstant = monitoringTrendInstant(current.timestamp).instant
    const previousInstant = previous ? monitoringTrendInstant(previous.timestamp).instant : undefined
    const intervalDays = previousInstant === undefined ? undefined : (currentInstant - previousInstant) / 86_400_000
    const ambiguousPeriod = ordered.some((observation, index) => index > 0 && monitoringTrendInstant(observation.timestamp).instant === monitoringTrendInstant(ordered[index - 1]!.timestamp).instant)
    const periodChange = !unitConflict && !ambiguousPeriod && previous ? current.value - previous.value : undefined
    const cumulativeChange = !unitConflict && !ambiguousPeriod && cumulativeBasis !== 'mixed-unavailable' && ordered.length > 1 ? currentCumulative - firstCumulative : undefined
    const ratePerDay = !unitConflict && !ambiguousPeriod && intervalDays !== undefined && intervalDays > 0 && previous
      ? (current.value - previous.value) / intervalDays
      : undefined
    const thresholdCompatible = !unitConflict && currentUnit === input.project.unit.trim()
    const threshold = thresholdCompatible ? input.project.thresholds[current.monitoringItem] ?? input.project.thresholds.default : undefined
    rows.push(MonitoringProfessionalDailyRowV1.parse({
      schemaVersion: 1, projectId: input.project.id, datasetId: input.dataset.id,
      monitoringItem: current.monitoringItem, point: current.point,
      initialTimestamp: first.timestamp, ...(previous ? { previousTimestamp: previous.timestamp } : {}), currentTimestamp: current.timestamp,
      initialValue: first.value, initialUnit: observationUnit(first, input.project.unit),
      ...(previous ? { previousValue: previous.value, previousUnit: observationUnit(previous, input.project.unit) } : {}), currentValue: current.value,
      ...(periodChange === undefined ? {} : { periodChange }), ...(cumulativeChange === undefined ? {} : { cumulativeChange }), cumulativeBasis,
      ...(ratePerDay === undefined ? {} : { ratePerDay }), unit: observationUnit(current, input.project.unit),
      projectUnit: input.project.unit.trim(), unitAlignment,
      ...(threshold === undefined ? {} : { threshold }), thresholdStatus: thresholdCompatible ? analysis?.thresholdStatus ?? 'unresolved' : 'unresolved',
      continuity: unitConflict || ambiguousPeriod ? 'missing-prior' : ordered.length > 1 ? 'continuous' : 'new-point',
      ...(unitConflict ? { unitStatus: 'conflict' as const, unitConflictUnits: [...units].sort() } : { unitStatus: 'consistent' as const }),
      sourceRows: ordered.map(item => item.sourceRow), sourceFileHash: input.dataset.sourceFileHash
    }))
  }
  rows.sort((a, b) => a.monitoringItem.localeCompare(b.monitoringItem) || a.point.localeCompare(b.point))
  return MonitoringProfessionalReportV1.parse({ schemaVersion: 1, projectId: input.project.id, datasetId: input.dataset.id, sourceFileHash: input.dataset.sourceFileHash, algorithmVersion: input.analysis?.algorithmVersion ?? 'not-run', rows, status: 'draft', generatedAt: input.generatedAt })
}
