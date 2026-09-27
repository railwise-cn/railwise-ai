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
      expect(text).toContain('任务类型：变形监测')
      expect(text).not.toContain('监测类型：control-network')
      expect(text).toContain('符号约定：正值为正向变形')
      expect(text).toContain('当前=4 mm 上期=2 mm 累计=2 mm 速率=2 mm/d 趋势=上升')
      expect(text).toContain('阈值=正常')
      expect(text).toContain('当前为待审查草稿，不代表专业复核、批准或签名')
    }
    expect(service.getProjectOverview(project.id).project.monitoringType).toBe('control-network')
    expect(preview.run.status).toBe('completed')
  } finally {
    service.close()
  }
})
