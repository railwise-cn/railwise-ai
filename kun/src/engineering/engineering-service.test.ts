import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { EngineeringService } from './engineering-service.js'

describe('EngineeringService', () => {
  it('imports CSV, validates findings, analyses trends and writes reviewable deliverables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-'))
    const workspace = join(root, 'workspace')
    const service = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = service.createProject({ name: '宁波基坑', workspace, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'create-project-001' })
    const csv = ['监测项,测点,时间,数值,单位', '沉降,S01,2026-08-01T00:00:00Z,2,mm', '沉降,S01,2026-08-02T00:00:00Z,4,mm'].join('\n')
    const dataset = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'import-csv-001', name: 'data.csv', dataBase64: Buffer.from(csv).toString('base64') })
    expect(dataset.observationCount).toBe(2)
    expect(dataset.sourceFileHash).toHaveLength(64)
    const validated = service.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'validate-csv-001' })
    expect(validated.status).toBe('validated')
    const analysis = service.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: validated.revision, idempotencyKey: 'analysis-csv-001' })
    expect(analysis.results[0]?.changeRate).toBe(2)
    const preview = await service.previewReport({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: validated.revision, idempotencyKey: 'preview-csv-001' })
    expect(preview.files.map((file) => file.mediaType)).toEqual(expect.arrayContaining(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']))
    const evidence = await readFile(join(workspace, preview.files.find((file) => file.mediaType.includes('spreadsheet'))?.path ?? ''))
    const evidenceZip = await JSZip.loadAsync(evidence)
    const workbookXml = await evidenceZip.file('xl/workbook.xml')?.async('text')
    expect(workbookXml).toContain('field_mapping')
    expect(workbookXml).toContain('normalized_data')
    expect(workbookXml).toContain('quality_findings')
    expect(workbookXml).toContain('analysis_results')
    expect(workbookXml).toContain('manifest_summary')
    const manifest = await service.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: validated.revision, idempotencyKey: 'finalize-csv-001', acknowledgeWarnings: true })
    expect(manifest.reviewStatus).toBe('draft')
    expect(service.verifyDeliverable(project.id, manifest.id)).toMatchObject({ valid: true, reviewStatus: 'draft', checks: expect.arrayContaining([{ id: 'surveyReplay', status: 'not-applicable' }, { id: 'sources', status: 'not-applicable' }]) })
    expect(manifest.validation.warnings).toContain('尚未完成复核、审核、批准与签名流程；该成果清单仅供待审查使用，不得作为已批准交付。')
    expect(await readFile(join(workspace, '.workwise', 'deliverables', project.id, manifest.runId, 'manifest.json'), 'utf8')).toContain(manifest.id)
    service.close()
  })

  it('returns the original result for an idempotent import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-'))
    const service = new EngineeringService({ rootDir: root })
    const project = service.createProject({ name: 'idempotent', workspace: root, expectedRevision: 0, idempotencyKey: 'create-project-002' })
    const body = { projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'import-replay-001', name: 'data.csv', dataBase64: Buffer.from('point,time,value\nA,2026-01-01,1').toString('base64') }
    const first = await service.importDataset(body); const second = await service.importDataset(body)
    expect(second.id).toBe(first.id)
    service.close()
  })

  it('does not reissue a legacy unbound delivery key while retaining its historical manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-legacy-delivery-'))
    const workspace = join(root, 'workspace')
    const service = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = service.createProject({ name: '历史交付', workspace, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'legacy-delivery-project' })
    const dataset = await service.importDataset({
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: 'legacy-delivery-dataset',
      name: 'monitoring.csv',
      dataBase64: Buffer.from('point,time,value\nP1,2026-09-01,1\nP1,2026-09-02,2').toString('base64')
    })
    const validated = service.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'legacy-delivery-validate' })
    const analysis = service.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: validated.revision, idempotencyKey: 'legacy-delivery-analysis' })
    const request = {
      projectId: project.id,
      datasetId: dataset.id,
      analysisId: analysis.id,
      expectedRevision: validated.revision,
      idempotencyKey: 'legacy-delivery-finalize',
      acknowledgeWarnings: true
    }
    const manifest = await service.finalize(request)
    await expect(service.previewReport({
      projectId: project.id,
      datasetId: dataset.id,
      analysisId: analysis.id,
      expectedRevision: validated.revision,
      idempotencyKey: request.idempotencyKey
    })).rejects.toThrow(/idempotency key is already bound/)

    // Simulate an installation from before delivery requests were fingerprinted.
    // Its manifest remains in the historical table, but its bare generic
    // idempotency row must not be treated as a new delivery replay.
    const db = (service as unknown as {
      db: { prepare: (sql: string) => { run: (...parameters: unknown[]) => unknown } }
    }).db
    db.prepare('DELETE FROM engineering_delivery_idempotency WHERE key = ?').run(request.idempotencyKey)
    db.prepare('INSERT INTO engineering_idempotency(key, result_json, created_at) VALUES (?, ?, ?)').run(request.idempotencyKey, JSON.stringify(manifest), new Date().toISOString())

    await expect(service.finalize(request)).rejects.toThrow(/legacy unbound result/)
    expect(service.getProjectOverview(project.id).manifests).toEqual(expect.arrayContaining([expect.objectContaining({ id: manifest.id })]))
    service.close()
  })

  it('rejects stale analyses and regenerates automatic preview analyses after project inputs change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-analysis-freshness-'))
    const service = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = service.createProject({ name: '分析快照', workspace: root, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'analysis-freshness-project' })
    const dataset = await service.importDataset({
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: 'analysis-freshness-dataset',
      name: 'monitoring.csv',
      dataBase64: Buffer.from('point,time,value\nP1,2026-09-01,2\nP1,2026-09-02,2').toString('base64')
    })
    const validated = service.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'analysis-freshness-validate' })
    const analysis = service.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: validated.revision, idempotencyKey: 'analysis-freshness-analysis' })
    expect(analysis.results[0]?.thresholdStatus).toBe('normal')
    const manifest = await service.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: validated.revision, idempotencyKey: 'analysis-freshness-finalize', acknowledgeWarnings: true })

    service.updateProject(project.id, { expectedRevision: project.revision, thresholds: { default: 1 }, idempotencyKey: 'analysis-freshness-project-update' })

    expect(() => service.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: 0, idempotencyKey: 'analysis-freshness-analysis' }))
      .toThrow(/stale or different project\/dataset inputs/)
    await expect(service.previewReport({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: validated.revision, idempotencyKey: 'analysis-freshness-stale-preview' }))
      .rejects.toThrow(/analysis no longer matches/)
    await expect(service.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: validated.revision, idempotencyKey: 'analysis-freshness-finalize', acknowledgeWarnings: true }))
      .rejects.toThrow(/input snapshot|analysis no longer matches/)
    expect(service.getProjectOverview(project.id).manifests).toEqual(expect.arrayContaining([expect.objectContaining({ id: manifest.id })]))

    const automaticPreview = await service.previewReport({ projectId: project.id, datasetId: dataset.id, expectedRevision: validated.revision, idempotencyKey: 'analysis-freshness-current-preview' })
    expect(automaticPreview.run.analysisId).not.toBe(analysis.id)
    const currentAnalysis = (service as unknown as { getAnalysis: (id: string) => { results: Array<{ thresholdStatus: string }> } | null }).getAnalysis(automaticPreview.run.analysisId!)
    expect(currentAnalysis?.results[0]?.thresholdStatus).toBe('alarm')
    service.close()
  })

  it('does not finalize a cancelled preview replay or a replay whose published output changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-replay-boundary-'))
    const workspace = join(root, 'workspace')
    const service = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = service.createProject({ name: '交付重放边界', workspace, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'replay-boundary-project' })
    const dataset = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'replay-boundary-dataset', name: 'monitoring.csv', dataBase64: Buffer.from('point,time,value\nP1,2026-09-01,1\nP1,2026-09-02,2').toString('base64') })
    const validated = service.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'replay-boundary-validate' })
    const analysis = service.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: validated.revision, idempotencyKey: 'replay-boundary-analysis' })

    const cancelledFinalizeKey = 'replay-boundary-cancel-finalize'
    const cancelledPreview = await service.previewReport({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: validated.revision, idempotencyKey: `finalize-preview-${cancelledFinalizeKey}` })
    service.cancelRun(cancelledPreview.run.id, { expectedRevision: cancelledPreview.run.revision, idempotencyKey: 'replay-boundary-cancel-run' })
    await expect(service.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: validated.revision, idempotencyKey: cancelledFinalizeKey, acknowledgeWarnings: true }))
      .rejects.toThrow(/no longer the current completed run/)

    const tamperedFinalizeKey = 'replay-boundary-output-finalize'
    const tamperedPreview = await service.previewReport({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: validated.revision, idempotencyKey: `finalize-preview-${tamperedFinalizeKey}` })
    const pdf = tamperedPreview.files.find((file) => file.mediaType === 'application/pdf')
    if (!pdf) throw new Error('preview must generate a PDF')
    await writeFile(join(workspace, pdf.path), 'tampered-pdf')
    await expect(service.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: validated.revision, idempotencyKey: tamperedFinalizeKey, acknowledgeWarnings: true }))
      .rejects.toThrow(/delivery output no longer matches its recorded hash/)
    expect(service.getProjectOverview(project.id).manifests).toEqual([])
    service.close()
  })

  it('does not reissue a finalized manifest after its public bytes changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-manifest-replay-'))
    const workspace = join(root, 'workspace')
    const service = new EngineeringService({ rootDir: join(root, 'runtime') })
    const project = service.createProject({ name: '成果清单重放边界', workspace, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'manifest-replay-project' })
    const dataset = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'manifest-replay-dataset', name: 'monitoring.csv', dataBase64: Buffer.from('point,time,value\nP1,2026-09-01,1\nP1,2026-09-02,2').toString('base64') })
    const validated = service.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'manifest-replay-validate' })
    const analysis = service.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: validated.revision, idempotencyKey: 'manifest-replay-analysis' })
    const request = { projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: validated.revision, idempotencyKey: 'manifest-replay-finalize', acknowledgeWarnings: true }
    const manifest = await service.finalize(request)
    const manifestPath = join(workspace, '.workwise', 'deliverables', project.id, manifest.runId, 'manifest.json')
    service.close()

    // A byte-identical public manifest remains replayable across a Runtime
    // restart; this guards the fail-closed byte check against accidentally
    // rejecting its own durable serialization.
    const reopened = new EngineeringService({ rootDir: join(root, 'runtime') })
    await expect(reopened.finalize(request)).resolves.toEqual(manifest)
    await writeFile(manifestPath, JSON.stringify({
      ...manifest,
      validation: { ...manifest.validation, warnings: [...manifest.validation.warnings, 'forged manifest warning'] }
    }, null, 2))

    await expect(reopened.finalize(request)).rejects.toThrow(/published manifest no longer matches its durable manifest evidence/)
    expect(reopened.getProjectOverview(project.id).manifests).toEqual([expect.objectContaining({ id: manifest.id })])
    reopened.close()
  })

  it('serializes concurrent imports that reuse an idempotency key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-'))
    const service = new EngineeringService({ rootDir: root })
    const project = service.createProject({ name: 'concurrent', workspace: root, expectedRevision: 0, idempotencyKey: 'create-project-006' })
    const body = { projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'import-concurrent-001', name: 'data.csv', dataBase64: Buffer.from('point,time,value\nA,2026-01-01,1').toString('base64') }
    const results = await Promise.all([service.importDataset(body), service.importDataset(body), service.importDataset(body)])
    expect(new Set(results.map((item) => item.id)).size).toBe(1)
    expect((service as unknown as { db: { prepare: (sql: string) => { get: () => { count: number } } } }).db.prepare('SELECT COUNT(*) AS count FROM engineering_datasets').get().count).toBe(1)
    service.close()
  })

  it('keeps import blocking findings after re-validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-'))
    const service = new EngineeringService({ rootDir: root })
    const project = service.createProject({ name: 'quality', workspace: root, expectedRevision: 0, idempotencyKey: 'create-project-003' })
    const dataset = await service.importDataset({
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: 'import-quality-001',
      name: 'quality.csv',
      dataBase64: Buffer.from('point,time,value\nA,2026-01-01,not-a-number').toString('base64')
    })
    expect(dataset.findings.some((item) => item.code === 'invalid_number' && item.severity === 'blocking')).toBe(true)
    const validated = service.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'validate-quality-001' })
    expect(validated.findings.some((item) => item.code === 'invalid_number' && item.severity === 'blocking')).toBe(true)
    await expect(service.finalize({ projectId: project.id, datasetId: dataset.id, expectedRevision: validated.revision, idempotencyKey: 'finalize-quality-001' })).rejects.toThrow(/blocking findings remain/)
    service.close()
  })

  it('imports each XLSX worksheet with its own header and preserves worksheet provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-'))
    const service = new EngineeringService({ rootDir: root })
    const project = service.createProject({ name: 'xlsx', workspace: root, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'create-project-004' })
    const sheet = (point: string) => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>监测项</t></is></c><c r="B1" t="inlineStr"><is><t>测点</t></is></c><c r="C1" t="inlineStr"><is><t>时间</t></is></c><c r="D1" t="inlineStr"><is><t>数值</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>沉降</t></is></c><c r="B2" t="inlineStr"><is><t>${point}</t></is></c><c r="C2" t="inlineStr"><is><t>2026-08-01</t></is></c><c r="D2" t="inlineStr"><is><t>1</t></is></c></row></sheetData></worksheet>`
    const workbook = new JSZip()
    workbook.file('xl/worksheets/sheet1.xml', sheet('S01'))
    workbook.file('xl/worksheets/sheet2.xml', sheet('S02'))
    const dataset = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'import-xlsx-001', name: 'monitoring.xlsx', dataBase64: (await workbook.generateAsync({ type: 'nodebuffer' })).toString('base64') })
    expect(dataset.rowCount).toBe(2)
    expect(dataset.observationCount).toBe(2)
    expect(dataset.findings.some((item) => item.code === 'invalid_number')).toBe(false)
    service.close()
  })

  it('preserves columns introduced by later XLSX worksheets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-'))
    const service = new EngineeringService({ rootDir: root })
    const project = service.createProject({ name: 'xlsx-columns', workspace: root, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'create-project-005' })
    const sheet = (extraHeader: string, extraValue: string) => `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>监测项</t></is></c><c r="B1" t="inlineStr"><is><t>测点</t></is></c><c r="C1" t="inlineStr"><is><t>时间</t></is></c><c r="D1" t="inlineStr"><is><t>数值</t></is></c><c r="E1" t="inlineStr"><is><t>${extraHeader}</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>沉降</t></is></c><c r="B2" t="inlineStr"><is><t>S01</t></is></c><c r="C2" t="inlineStr"><is><t>2026-08-01</t></is></c><c r="D2" t="inlineStr"><is><t>1</t></is></c><c r="E2" t="inlineStr"><is><t>${extraValue}</t></is></c></row></sheetData></worksheet>`
    const workbook = new JSZip()
    workbook.file('xl/worksheets/sheet1.xml', sheet('首表字段', 'a'))
    workbook.file('xl/worksheets/sheet2.xml', sheet('后表字段', 'b'))
    const dataset = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'import-xlsx-columns-001', name: 'monitoring.xlsx', dataBase64: (await workbook.generateAsync({ type: 'nodebuffer' })).toString('base64') })
    expect(dataset.columnCount).toBe(6)
    expect(dataset.unknownColumns).toEqual(['首表字段', '后表字段'])
    service.close()
  })

  it('imports structured JSON rows and preserves unknown fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-json-'))
    const service = new EngineeringService({ rootDir: root })
    const project = service.createProject({ name: 'json', workspace: root, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'create-json-001' })
    const json = JSON.stringify({ rows: [
      { 监测项: '沉降', 测点: 'S01', 时间: '2026-08-01T00:00:00Z', 数值: 1.5, 单位: 'mm', 自定义备注: '首期' },
      { 监测项: '沉降', 测点: 'S01', 时间: '2026-08-02T00:00:00Z', 数值: 2.5, 单位: 'mm', 自定义备注: '复测' }
    ] })
    const dataset = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'import-json-001', name: 'monitoring.json', dataBase64: Buffer.from(json).toString('base64') })
    expect(dataset.rowCount).toBe(2)
    expect(dataset.observationCount).toBe(2)
    expect(dataset.fieldMapping.monitoringItem).toBe('监测项')
    expect(dataset.unknownColumns).toEqual(['自定义备注'])
    expect(dataset.status).toBe('imported')
    service.close()
  })

  it('rejects malformed or non-tabular JSON with a stable error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-engineering-json-invalid-'))
    const service = new EngineeringService({ rootDir: root })
    const project = service.createProject({ name: 'json-invalid', workspace: root, expectedRevision: 0, idempotencyKey: 'create-json-002' })
    await expect(service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'import-json-002', name: 'bad.json', dataBase64: Buffer.from('{"project":"not rows"').toString('base64') })).rejects.toThrow('invalid JSON dataset')
    await expect(service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'import-json-003', name: 'bad-shape.json', dataBase64: Buffer.from('{"project":"not rows"}').toString('base64') })).rejects.toThrow('must be an array')
    service.close()
  })
})
