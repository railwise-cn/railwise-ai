import { describe, expect, it } from 'vitest'
import { buildMonitoringProfessionalReport } from './engineering-monitoring-report.js'
import type { MonitoringAnalysisV1, MonitoringDatasetV1, MonitoringObservationV1, RailwiseProjectV1 } from '../contracts/engineering.js'

const project = { schemaVersion: 1, id: 'project', name: 'Test', taskType: 'deformation', monitoringType: 'deformation', unit: 'mm', signConvention: 'positive', thresholds: { settlement: 10 }, reportPeriod: {}, workspace: '/tmp/project', revision: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' } as RailwiseProjectV1
const observation = (id: string, timestamp: string, value: number, sourceRow: number, cumulative?: number): MonitoringObservationV1 => ({ schemaVersion: 1, id, projectId: 'project', datasetId: 'dataset', monitoringItem: 'settlement', point: 'P-01', timestamp, value, unit: 'mm', ...(cumulative === undefined ? {} : { cumulative }), sourceRow, sourceFields: {} })
const dataset = { schemaVersion: 1, id: 'dataset', projectId: 'project', sourceFileName: 'daily.csv', sourceFileHash: 'a'.repeat(64), fieldMapping: {}, unknownColumns: [], rowCount: 2, columnCount: 5, observationCount: 2, timeRange: { start: '2026-01-01', end: '2026-01-02' }, status: 'validated', revision: 2, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', observations: [observation('o1', '2026-01-01', 2, 2, 100), observation('o2', '2026-01-02', 5, 3, 105)], findings: [] } as MonitoringDatasetV1 & { observations: MonitoringObservationV1[]; findings: [] }
const analysis = { schemaVersion: 1, id: 'analysis', projectId: 'project', datasetId: 'dataset', inputHash: 'b'.repeat(64), algorithmVersion: 'algorithm', results: [{ monitoringItem: 'settlement', point: 'P-01', currentValue: 5, previousValue: 2, cumulativeChange: 5, changeRate: 3, trend: 'rising', anomaly: false, thresholdStatus: 'normal' }], createdAt: '2026-01-02T00:00:00Z' } as MonitoringAnalysisV1

describe('monitoring professional report projection', () => {
  it('keeps the initial, previous, current and source continuity columns explicit', () => {
    const report = buildMonitoringProfessionalReport({ project, dataset, analysis, generatedAt: '2026-01-02T00:00:00Z' })
    expect(report.rows).toEqual([expect.objectContaining({ point: 'P-01', initialValue: 2, previousValue: 2, currentValue: 5, periodChange: 3, cumulativeChange: 5, ratePerDay: 3, thresholdStatus: 'normal', continuity: 'continuous', sourceRows: [2, 3] })])
  })

  it('leaves rate and cumulative change unavailable for a newly added point', () => {
    const next = { ...dataset, observations: [observation('o3', '2026-01-02', 7, 4)], observationCount: 1 }
    const report = buildMonitoringProfessionalReport({ project, dataset: next, generatedAt: '2026-01-02T00:00:00Z' })
    expect(report.rows[0]?.continuity).toBe('new-point')
    expect(report.rows[0]?.cumulativeChange).toBeUndefined()
    expect(report.rows[0]?.ratePerDay).toBeUndefined()
  })

  it('rejects stale bindings and preserves mixed-unit histories without cross-unit arithmetic', () => {
    expect(() => buildMonitoringProfessionalReport({ project, dataset: { ...dataset, projectId: 'other' }, generatedAt: '2026-01-02T00:00:00Z' })).toThrow('does not belong')
    const report = buildMonitoringProfessionalReport({ project, dataset: { ...dataset, observations: [observation('o1', '2026-01-01', 2, 2), { ...observation('o2', '2026-01-02', 5, 3), unit: 'm' }] }, analysis, generatedAt: '2026-01-02T00:00:00Z' })
    expect(report.rows[0]).toMatchObject({ initialTimestamp: '2026-01-01', initialValue: 2, initialUnit: 'mm', previousValue: 2, previousUnit: 'mm', unit: 'm', unitStatus: 'conflict', unitConflictUnits: ['m', 'mm'], continuity: 'missing-prior', thresholdStatus: 'unresolved', sourceRows: [2, 3] })
    expect(report.rows[0]?.periodChange).toBeUndefined()
    expect(report.rows[0]?.cumulativeChange).toBeUndefined()
    expect(report.rows[0]?.ratePerDay).toBeUndefined()
    expect(report.rows[0]?.threshold).toBeUndefined()
  })

  it('does not skip a conflicting intermediate period even if the current unit matches the first', () => {
    const report = buildMonitoringProfessionalReport({ project, dataset: { ...dataset, observations: [observation('o1', '2026-01-01', 2, 2), { ...observation('o2', '2026-01-02', 5, 3), unit: 'm' }, observation('o3', '2026-01-03', 7, 4)] }, analysis, generatedAt: '2026-01-03T00:00:00Z' })
    expect(report.rows[0]).toMatchObject({ initialValue: 2, initialUnit: 'mm', previousValue: 5, previousUnit: 'm', currentValue: 7, unit: 'mm', unitStatus: 'conflict', sourceRows: [2, 3, 4], thresholdStatus: 'unresolved' })
    expect(report.rows[0]?.periodChange).toBeUndefined()
    expect(report.rows[0]?.cumulativeChange).toBeUndefined()
    expect(report.rows[0]?.ratePerDay).toBeUndefined()
  })

  it('does not compare a consistent source unit against a threshold declared in a different project unit', () => {
    const report = buildMonitoringProfessionalReport({ project, dataset: { ...dataset, observations: dataset.observations.map(item => ({ ...item, unit: 'm' })) }, analysis, generatedAt: '2026-01-02T00:00:00Z' })
    expect(report.rows[0]).toMatchObject({ unit: 'm', unitStatus: 'consistent', periodChange: 3, thresholdStatus: 'unresolved' })
    expect(report.rows[0]).toMatchObject({ projectUnit: 'mm', unitAlignment: 'source-differs' })
    expect(report.rows[0]?.threshold).toBeUndefined()
  })

  it('does not interpret records at the same instant as separate monitoring periods', () => {
    const report = buildMonitoringProfessionalReport({ project, dataset: { ...dataset, observations: [observation('o1', '2026-01-01T00:00:00Z', 2, 2), observation('o2', '2026-01-01T08:00:00+08:00', 5, 3)] }, generatedAt: '2026-01-02' })
    expect(report.rows[0]).toMatchObject({ continuity: 'missing-prior', sourceRows: [2, 3] })
    expect(report.rows[0]?.periodChange).toBeUndefined()
    expect(report.rows[0]?.cumulativeChange).toBeUndefined()
    expect(report.rows[0]?.ratePerDay).toBeUndefined()
  })

  it('does not mix a partial cumulative column with observed values', () => {
    const report = buildMonitoringProfessionalReport({ project, dataset: { ...dataset, observations: [observation('o1', '2026-01-01', 2, 2, 100), observation('o2', '2026-01-02', 5, 3)] }, generatedAt: '2026-01-02' })
    expect(report.rows[0]?.cumulativeBasis).toBe('mixed-unavailable')
    expect(report.rows[0]?.cumulativeChange).toBeUndefined()
  })
})
