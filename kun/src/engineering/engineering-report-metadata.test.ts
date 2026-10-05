import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { expect, it } from 'vitest'
import { EngineeringService } from './engineering-service.js'
import { readReportPdf } from '../../tests/helpers/report-pdf.js'

it('reports the selected task type and readable units without rewriting legacy metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'railwise-report-metadata-'))
  const service = new EngineeringService({ rootDir: join(root, 'runtime') })
  try {
    const project = service.createProject({ name: '合成监测报告', taskType: 'deformation', monitoringType: 'control-network', workspace: root, unit: 'mm', thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'report-project' })
    const dataset = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'report-import', name: 'monitoring.csv', dataBase64: Buffer.from('监测项,测点,时间,数值,单位\n沉降,S01,2026-08-01,2,mm\n沉降,S01,2026-08-02,4,mm').toString('base64') })
    const checked = service.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'report-check' })
    const preview = await service.previewReport({ projectId: project.id, datasetId: dataset.id, expectedRevision: checked.revision, idempotencyKey: 'report-preview' })
    const docx = preview.files.find(file => file.path.endsWith('.docx'))!
    const pdf = preview.files.find(file => file.path.endsWith('.pdf'))!
    const archive = await JSZip.loadAsync(await readFile(join(root, docx.path)))
    const document = await archive.file('word/document.xml')!.async('text')
    const rendered = await readReportPdf(await readFile(join(root, pdf.path)))
    for (const text of [document, rendered.text]) {
      expect(text).toContain('作业类型：变形监测')
      expect(text).not.toContain('监测类型：control-network')
      expect(text).toContain('符号约定：正值为正向变形')
      expect(text).toContain('变化速率单位为各行所列单位/天')
      expect(text).toContain('监测日报与累计变化')
      expect(text).toContain('正常')
      expect(text).toContain('本稿未完成专业复核、审核、批准和签名')
      expect(text).not.toContain(dataset.id)
      expect(text).not.toContain(dataset.sourceFileHash)
    }
    const rows = [...document.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)].map(match =>
      [...match[1]!.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map(cell => cell[1]!.replace(/<[^>]+>/g, '')))
    const columns = rows.find(row => row.includes('本期值'))!
    const point = rows.find(row => row.includes('S01'))!
    for (const [column, value] of Object.entries({ 初始值: '2.0000', 上期值: '2.0000', 本期值: '4.0000', 本次变化: '2.0000', 累计变化: '2.0000', 变化速率: '2.0000', 单位: 'mm', 控制值: '10.0000', 原始行: '2,3' })) {
      expect(columns, `missing professional column ${column}`).toContain(column)
      expect(point[columns.indexOf(column)], column).toBe(value)
    }
    expect(rendered.text).toContain('4.0000')
    expect(rendered.text).toContain('10.0000')
    expect(service.getProjectOverview(project.id).project.monitoringType).toBe('control-network')
    expect(preview.run.status).toBe('completed')
  } finally {
    service.close()
  }
})
