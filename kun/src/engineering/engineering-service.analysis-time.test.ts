import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ENGINEERING_ANALYSIS_ALGORITHM_VERSION, ReportPreviewRequest } from '../contracts/engineering.js'
import { EngineeringService } from './engineering-service.js'

async function fixture(rows: string) {
  const root = await mkdtemp(join(tmpdir(), 'railwise-analysis-time-'))
  const service = new EngineeringService({ rootDir: join(root, 'runtime') })
  const project = service.createProject({ name: '合成时间轴', workspace: root, thresholds: { default: 20 }, expectedRevision: 0, idempotencyKey: 'analysis-time-project' })
  const dataset = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'analysis-time-dataset', name: 'monitoring.csv', dataBase64: Buffer.from(`monitoringItem,point,time,value,unit\n${rows}`).toString('base64') })
  const checked = service.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'analysis-time-validate' })
  const request = { projectId: project.id, datasetId: dataset.id, expectedRevision: checked.revision, idempotencyKey: 'analysis-time-original' }
  return { root, service, project, dataset: checked, request }
}

it('uses the same absolute time ordering and elapsed days as the chart for different offsets', async () => {
  const { root, service, dataset, request } = await fixture('沉降,S01,2026-08-01T23:00:00-08:00,7,mm\n沉降,S01,2026-08-02T01:00:00+08:00,2,mm')
  try {
    expect(dataset.timeRange).toEqual({ start: '2026-08-02T01:00:00+08:00', end: '2026-08-01T23:00:00-08:00' })
    expect(dataset.findings).toContainEqual(expect.objectContaining({ code: 'time_order', severity: 'warning', row: 3 }))
    const analysis = service.createAnalysis(request)
    expect(analysis.algorithmVersion).toBe(ENGINEERING_ANALYSIS_ALGORITHM_VERSION)
    expect(analysis.results[0]).toMatchObject({ currentValue: 7, previousValue: 2, cumulativeChange: 5, trend: 'rising' })
    expect(analysis.results[0]!.changeRate).toBeCloseTo(60 / 7, 12)
    const chart = await service.createChart({ analysisId: analysis.id, chartType: 'trend', expectedRevision: 0, idempotencyKey: 'analysis-time-chart' })
    const svg = await readFile(join(root, chart.relativePath), 'utf8')
    expect(svg.indexOf('S01 · 2026-08-02T01:00:00+08:00 · 2')).toBeLessThan(svg.indexOf('S01 · 2026-08-01T23:00:00-08:00 · 7'))
  } finally { service.close() }
})

it('marks ambiguous dates as blocking without discarding original observations', async () => {
  const { service, dataset, request } = await fixture('沉降,S01,08/01/2026,2,mm')
  try {
    expect(dataset.observations).toHaveLength(1)
    expect(dataset.observations[0]!.timestamp).toBe('08/01/2026')
    expect(dataset.findings.filter(finding => finding.code === 'time_order')).toEqual([expect.objectContaining({ severity: 'blocking', row: 2 })])
    expect(() => service.createAnalysis(request)).toThrow(/ISO/)
  } finally { service.close() }
})

it('recognizes equal instants written with different offsets as duplicates and does not divide by zero', async () => {
  const { service, dataset, request } = await fixture('沉降,S01,2026-08-01T00:00:00Z,2,mm\n沉降,S01,2026-08-01T08:00:00+08:00,4,mm')
  try {
    expect(dataset.observations).toHaveLength(2)
    expect(dataset.findings.filter(finding => finding.code === 'duplicate_observation')).toEqual([expect.objectContaining({ severity: 'warning', row: 3 })])
    expect(service.createAnalysis(request).results[0]!.changeRate).toBeUndefined()
  } finally { service.close() }
})

it('keeps delimiter-containing item and point identities distinct in analysis and quality checks', async () => {
  const { service, dataset, request } = await fixture('c,a|b,2026-08-02,2,mm\nc|a,b,2026-08-01,4,mm')
  try {
    expect(dataset.findings.filter(finding => finding.code === 'duplicate_observation' || finding.code === 'time_order')).toEqual([])
    expect(service.createAnalysis(request).results).toEqual([
      expect.objectContaining({ monitoringItem: 'c', point: 'a|b', currentValue: 2, trend: 'unknown' }),
      expect.objectContaining({ monitoringItem: 'c|a', point: 'b', currentValue: 4, trend: 'unknown' })
    ])
  } finally { service.close() }
})

it.each([
  ['spring DST', '2026-03-07T12:00:00', '2026-03-08T12:00:00'],
  ['fall DST', '2026-10-31 12:00:00', '2026-11-01 12:00:00'],
  ['mixed naive and offset', '2026-03-07T12:00:00', '2026-03-08T20:00:00+08:00'],
  ['calendar dates', '2026-03-07', '2026-03-08']
])('interprets unzoned dates as UTC for %s, independent of the host timezone', async (_label, earlier, later) => {
  const { service, request } = await fixture(`沉降,S01,${earlier},2,mm\n沉降,S01,${later},6,mm`)
  try {
    expect(service.createAnalysis(request).results[0]).toMatchObject({ currentValue: 6, previousValue: 2, cumulativeChange: 4, changeRate: 4 })
  } finally { service.close() }
})

it('preserves explicit legacy analyses, reports and manifests while automatic requests compute the new algorithm', async () => {
  const { root, service, project, dataset, request } = await fixture('沉降,S01,2026-08-01T23:00:00-08:00,7,mm\n沉降,S01,2026-08-02T01:00:00+08:00,2,mm')
  try {
    const generated = service.createAnalysis(request)
    // Seed a prior-installation record with the old lexicographic result and a future timestamp.
    const legacy = { ...generated, algorithmVersion: 'workwise-engineering-1', createdAt: '2099-01-01T00:00:00Z',
      results: [{ ...generated.results[0]!, currentValue: 2, previousValue: 7, cumulativeChange: -5, changeRate: undefined, trend: 'falling' as const }] }
    const legacyJson = JSON.stringify(legacy)
    const internal = service as unknown as {
      db: { prepare(sql: string): { run(...values: unknown[]): unknown; get(...values: unknown[]): { data_json: string; result_json: string } } }
      rememberDelivery(operation: string, request: unknown, value: unknown): unknown
    }
    internal.db.prepare('UPDATE engineering_analyses SET data_json = ?, created_at = ? WHERE id = ?').run(legacyJson, legacy.createdAt, legacy.id)
    internal.db.prepare('UPDATE engineering_idempotency SET result_json = ? WHERE key = ?').run(legacyJson, request.idempotencyKey)
    expect(service.createAnalysis(request)).toEqual(JSON.parse(legacyJson))

    const explicitRequest = { projectId: project.id, datasetId: dataset.id, analysisId: legacy.id, expectedRevision: dataset.revision, idempotencyKey: 'analysis-time-legacy-preview' }
    const oldPreview = await service.previewReport(explicitRequest)
    const oldBytes = await Promise.all(oldPreview.files.map(file => readFile(join(root, file.path))))
    const oldManifest = await service.finalize({ ...explicitRequest, idempotencyKey: 'analysis-time-legacy-manifest', acknowledgeWarnings: true })
    // Prior automatic previews were also request-bound, but did not include an analysisId.
    const oldAutoRequest = ReportPreviewRequest.parse({ ...explicitRequest, analysisId: undefined, idempotencyKey: 'analysis-time-old-auto-preview' })
    internal.rememberDelivery('report-preview', oldAutoRequest, oldPreview)
    const oldAutoRecord = internal.db.prepare('SELECT result_json FROM engineering_delivery_idempotency WHERE key = ?').get(oldAutoRequest.idempotencyKey).result_json

    const current = service.createAnalysis({ ...request, idempotencyKey: 'analysis-time-upgraded' })
    expect(current.id).not.toBe(legacy.id)
    expect(current.algorithmVersion).toBe(ENGINEERING_ANALYSIS_ALGORITHM_VERSION)
    expect(current.results[0]).toMatchObject({ currentValue: 7, previousValue: 2, cumulativeChange: 5 })
    expect(service.createAnalysis({ ...request, idempotencyKey: 'analysis-time-cache' })).toEqual(current)
    expect(service.createAnalysis(request)).toEqual(JSON.parse(legacyJson))

    const autoPreview = await service.previewReport({ ...oldAutoRequest, idempotencyKey: 'analysis-time-new-auto-preview' })
    expect(autoPreview.run.analysisId).toBe(current.id)
    const versionedKey = `preview-analysis-${ENGINEERING_ANALYSIS_ALGORITHM_VERSION}-${dataset.id}-${current.inputHash}`
    expect(JSON.parse(internal.db.prepare('SELECT result_json FROM engineering_idempotency WHERE key = ?').get(versionedKey).result_json).id).toBe(current.id)
    expect(await service.previewReport(oldAutoRequest)).toEqual(oldPreview)
    expect(await service.previewReport(explicitRequest)).toEqual(oldPreview)
    expect(await Promise.all(oldPreview.files.map(file => readFile(join(root, file.path))))).toEqual(oldBytes)
    expect(internal.db.prepare('SELECT data_json FROM engineering_analyses WHERE id = ?').get(legacy.id).data_json).toBe(legacyJson)
    expect(internal.db.prepare('SELECT result_json FROM engineering_delivery_idempotency WHERE key = ?').get(oldAutoRequest.idempotencyKey).result_json).toBe(oldAutoRecord)
    expect(service.getProjectOverview(project.id).manifests).toContainEqual(oldManifest)
    expect(service.verifyDeliverable(project.id, oldManifest.id).valid).toBe(true)
  } finally { service.close() }
})
