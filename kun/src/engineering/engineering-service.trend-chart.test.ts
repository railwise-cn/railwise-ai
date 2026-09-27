import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { expect, it } from 'vitest'
import { EngineeringService } from './engineering-service.js'
import { ChartArtifactV1, ENGINEERING_TREND_RENDERER_VERSION } from '../contracts/engineering.js'

it('binds all trend observations, chart bytes, XLSX source rows and idempotent replay to the current analysis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-trend-chart-'))
  const service = new EngineeringService({ rootDir: join(root, 'runtime') })
  try {
    const project = service.createProject({ name: '合成趋势', workspace: root, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'trend-project' })
    const dataset = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'trend-data', name: 'monitoring.csv', dataBase64: Buffer.from('monitoringItem,point,time,value,unit\n沉降,S01,2026-08-01,2,mm\n沉降,S01,2026-08-02,4,mm').toString('base64') })
    const checked = service.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'trend-check' })
    const analysis = service.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: checked.revision, idempotencyKey: 'trend-analysis' })
    const request = { analysisId: analysis.id, chartType: 'trend', expectedRevision: 0, idempotencyKey: 'trend-chart' }
    const chart = await service.createChart(request)
    const svg = await readFile(join(root, chart.relativePath), 'utf8')
    expect([...svg.matchAll(/data-role="observation"/g)]).toHaveLength(2)
    expect(svg).toMatch(/points="[^" ]+ [^" ]+"/)
    expect(chart.dataRange).toEqual({ min: 2, max: 4 })
    expect(chart.inputHash).toBe(analysis.inputHash)
    expect(chart.rendererVersion).toBe(ENGINEERING_TREND_RENDERER_VERSION)
    expect(chart.sha256).toBe(createHash('sha256').update(svg).digest('hex'))
    expect(await service.createChart(request)).toEqual(chart)
    for (const chartType of ['bar', '../outside', 'cumulative', '']) await expect(service.createChart({ ...request, chartType })).rejects.toThrow(/unsupported/)
    // An upgraded installation retains old charts and explicit old replay keys.
    const oldSvg = '<svg xmlns="http://www.w3.org/2000/svg"><polyline points="40,40"/></svg>'
    const legacy = ChartArtifactV1.parse({ ...chart, id: 'legacy_chart', rendererVersion: undefined, relativePath: 'legacy-chart.svg',
      sha256: createHash('sha256').update(oldSvg).digest('hex'), createdAt: '2099-01-01T00:00:00Z' })
    await writeFile(join(root, legacy.relativePath), oldSvg)
    const db = (service as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): unknown; get(...values: unknown[]): { data_json: string } } } }).db
    db.prepare('INSERT INTO engineering_charts(id, analysis_id, data_json, created_at) VALUES (?, ?, ?, ?)').run(legacy.id, legacy.analysisId, JSON.stringify(legacy), legacy.createdAt)
    db.prepare('INSERT INTO engineering_idempotency(key, result_json, created_at) VALUES (?, ?, ?)').run('legacy-chart-key', JSON.stringify(legacy), legacy.createdAt)
    expect(await service.createChart({ ...request, idempotencyKey: 'legacy-chart-key' })).toEqual(legacy)
    const preview = await service.previewReport({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: checked.revision, idempotencyKey: 'trend-preview' })
    expect(preview.charts[0]!.rendererVersion).toBe(ENGINEERING_TREND_RENDERER_VERSION)
    expect(preview.charts[0]!.id).not.toBe(legacy.id)
    expect(await readFile(join(root, legacy.relativePath), 'utf8')).toBe(oldSvg)
    expect(JSON.parse(db.prepare('SELECT data_json FROM engineering_charts WHERE id = ?').get(legacy.id).data_json)).toEqual(JSON.parse(JSON.stringify(legacy)))
    const xlsx = await JSZip.loadAsync(await readFile(join(root, preview.files.find(file => file.path.endsWith('.xlsx'))!.path)))
    const workbook = await xlsx.file('xl/workbook.xml')!.async('text')
    const sheetId = workbook.match(/name="chart_data" sheetId="(\d+)"/)![1]
    const sheet = await xlsx.file(`xl/worksheets/sheet${sheetId}.xml`)!.async('text')
    expect([...sheet.matchAll(/<row /g)]).toHaveLength(3)
    for (const label of ['observationValue', 'observationTimestamp', 'sourceRow', 'sourceFileHash', 'unzoned-as-UTC', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', dataset.sourceFileHash]) expect(sheet).toContain(label)
    expect(sheet).not.toContain('currentValue')
    // chart_data must not be mistaken for another observation sheet on reimport.
    const imported = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'trend-reimport', name: 'roundtrip.xlsx', dataBase64: (await xlsx.generateAsync({ type: 'nodebuffer' })).toString('base64') })
    expect(imported.observationCount).toBe(2)
    service.updateProject(project.id, { expectedRevision: project.revision, idempotencyKey: 'trend-update', name: 'changed' })
    await expect(service.createChart(request)).rejects.toThrow(/no longer matches/)
  } finally { service.close() }
})
