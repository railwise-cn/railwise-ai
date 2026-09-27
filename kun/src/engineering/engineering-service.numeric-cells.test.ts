import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { EngineeringService } from './engineering-service.js'

describe('monitoring numeric cell semantics', () => {
  it('preserves absent cumulative values and the analysis through an exported XLSX round-trip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-monitoring-roundtrip-'))
    const service = new EngineeringService({ rootDir: join(root, 'runtime') })
    try {
      const project = service.createProject({ name: 'Monitoring round-trip', workspace: root, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'create-roundtrip' })
      const source = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'import-csv', name: 'source.csv', dataBase64: Buffer.from('point,time,value,unit\nS01,2026-08-01T00:00:00Z,2,mm\nS01,2026-08-02T00:00:00Z,4,mm').toString('base64') })
      const validated = service.validateDataset({ datasetId: source.id, expectedRevision: source.revision, idempotencyKey: 'validate-source' })
      const originalAnalysis = service.createAnalysis({ projectId: project.id, datasetId: source.id, expectedRevision: validated.revision, idempotencyKey: 'analyse-source' })
      expect(originalAnalysis.results[0]).toMatchObject({ currentValue: 4, cumulativeChange: 2, changeRate: 2, trend: 'rising' })
      const preview = await service.previewReport({ projectId: project.id, datasetId: source.id, analysisId: originalAnalysis.id, expectedRevision: validated.revision, idempotencyKey: 'export-source' })
      const output = preview.files.find(file => file.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')!
      const exported = await readFile(join(root, output.path))
      const imported = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'import-exported-xlsx', name: 'evidence.xlsx', dataBase64: exported.toString('base64') })
      expect(imported.observationCount).toBe(2)
      expect(imported.observations.map(({ value, cumulative, rate }) => ({ value, cumulative, rate }))).toEqual([
        { value: 2, cumulative: undefined, rate: undefined },
        { value: 4, cumulative: undefined, rate: undefined }
      ])
      expect(imported.observations.every(observation => observation.sourceFields.cumulative === '' && observation.sourceFields.rate === '')).toBe(true)
      const checked = service.validateDataset({ datasetId: imported.id, expectedRevision: imported.revision, idempotencyKey: 'validate-roundtrip' })
      const roundtrip = service.createAnalysis({ projectId: project.id, datasetId: imported.id, expectedRevision: checked.revision, idempotencyKey: 'analyse-roundtrip' })
      expect(roundtrip.results).toEqual(originalAnalysis.results)
    } finally {
      service.close()
    }
  })

  it.each(['csv', 'json', 'xlsx'] as const)('distinguishes missing, whitespace, zero and finite cells in %s', async format => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-monitoring-numeric-'))
    const service = new EngineeringService({ rootDir: join(root, 'runtime') })
    try {
      const project = service.createProject({ name: 'Numeric cells', workspace: root, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'create-numeric' })
      const headers = ['point', 'time', 'value', 'cumulative', 'rate', 'unit']
      const rows = [
        ['zero', '2026-08-01', '0', '0', '0', 'mm'],
        ['absent', '2026-08-01', '2', '', ' \t ', 'mm'],
        ['finite', '2026-08-01', '3', '-1.5', '+0.25', 'mm'],
        ['missing', '2026-08-01', '', '', '', 'mm'],
        ['whitespace', '2026-08-01', ' \t ', '', '', 'mm'],
        ['invalid', '2026-08-01', 'not-a-number', '', '', 'mm']
      ]
      let bytes: Buffer
      if (format === 'xlsx') {
        const workbook = new JSZip()
        workbook.file('xl/worksheets/sheet1.xml', `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${[headers, ...rows].map((row, i) => `<row r="${i + 1}">${row.map((cell, j) => `<c r="${String.fromCharCode(65 + j)}${i + 1}" t="inlineStr"><is><t xml:space="preserve">${cell}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`)
        bytes = await workbook.generateAsync({ type: 'nodebuffer' })
      } else if (format === 'json') {
        bytes = Buffer.from(JSON.stringify(rows.map(row => Object.fromEntries(headers.map((key, i) => [key, row[i] === '' ? null : row[i]])))))
      } else {
        bytes = Buffer.from([headers, ...rows].map(row => row.join(',')).join('\n'))
      }
      const dataset = await service.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'import-numeric', name: `numeric.${format}`, dataBase64: bytes.toString('base64') })
      expect(dataset.observations.map(({ point, value, cumulative, rate }) => ({ point, value, cumulative, rate }))).toEqual([
        { point: 'zero', value: 0, cumulative: 0, rate: 0 },
        { point: 'absent', value: 2, cumulative: undefined, rate: undefined },
        { point: 'finite', value: 3, cumulative: -1.5, rate: 0.25 }
      ])
      expect(dataset.findings.filter(finding => finding.code === 'missing_value').map(finding => finding.row)).toEqual([5, 6])
      expect(dataset.findings.filter(finding => finding.code === 'invalid_number').map(finding => finding.row)).toEqual([7])
      expect(dataset.observations[1].sourceFields.rate).toBe(' \t ')
    } finally {
      service.close()
    }
  })
})
