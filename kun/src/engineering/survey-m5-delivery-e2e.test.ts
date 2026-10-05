import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it, onTestFinished } from 'vitest'
import { EngineeringService } from './engineering-service.js'
import { SurveyService } from './survey-service.js'
import { readReportPdf } from '../../tests/helpers/report-pdf.js'

const fixture = new URL('./fixtures/survey-formats/professional/trimble-m5-abffb.dat', import.meta.url)

describe('M5 professional survey delivery', () => {
  it('imports aBFFB measurements, applies an explicit datum, and seals traceable deliverables', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-m5-delivery-'))
    const workspace = join(root, 'workspace')
    let engineering!: EngineeringService
    const survey = new SurveyService({
      rootDir: join(root, 'runtime'),
      getProject: (id) => engineering.getProject(id)
    })
    engineering = new EngineeringService({
      rootDir: join(root, 'runtime'),
      getAdjustments: (projectId, ids) => ids.flatMap((id) => {
        const stored = survey.getAdjustment(id)
        return stored?.run.projectId === projectId && stored.result ? [stored.result] : []
      }),
      getAdjustmentEvidence: (projectId, ids) => ids.flatMap((id) => {
        const stored = survey.getAdjustmentForProjectNewUse(projectId, id)
        return stored?.run.projectId === projectId && stored.result
          ? [{
              run: {
                id: stored.run.id,
                projectId: stored.run.projectId,
                networkId: stored.run.networkId,
                inputHash: stored.run.inputHash,
                status: stored.run.status
              },
              result: stored.result
            }]
          : []
      }),
      getDeformations: () => [],
      getSurveySources: (projectId, ids) => ids.flatMap((id) => {
        const network = survey.getNetwork(id)
        if (!network || network.projectId !== projectId || !network.sourceFile) return []
        return [{
          networkId: network.id,
          sourceFile: network.sourceFile,
          observations: network.observations.map(({ id: observationId, type, sourceRecordId }) => ({ id: observationId, type, sourceRecordId })),
          points: [...network.knownPoints, ...network.unknownPoints].map(({ id }) => ({ id })),
          rawSourceIntegrity: survey.getRawSourceIntegrity(network.id),
          sourceEligibility: survey.getSourceEligibility(network.id)
        }]
      })
    })
    onTestFinished(() => {
      survey.close()
      engineering.close()
    })

    const project = engineering.createProject({
      name: 'Trimble M5 aBFFB 受控交付验收',
      workspace,
      expectedRevision: 0,
      idempotencyKey: 'm5-delivery-project'
    })
    const bytes = await readFile(fixture)
    const network = await survey.importNetwork({
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: 'm5-import-abffb',
      networkType: 'height-control',
      name: 'trimble-m5-abffb.dat',
      dataBase64: bytes.toString('base64'),
      // M5 Z records are instrument readings. The adjustment datum must be
      // supplied explicitly by the surveyor rather than inferred by the parser.
      knownPoints: [
        { id: 'sy730', height: -14.2884 },
        // The four aBFFB segments form a controlled route ending at S6G03.
        // Supplying both endpoint elevations makes route closure auditable.
        { id: 'S6G03', height: -9.297595 }
      ]
    })

    expect(network.sourceFile).toMatchObject({
      disposition: 'adjustment-ready',
      detection: { format: 'trimble-m5' },
      parserId: 'trimble-m5-abffb-parser',
      parserVersion: '0.2.0',
      linearUnitCanonical: 'm',
      angularUnitCanonical: 'rad'
    })
    expect(network.sourceFile!.rawRecordAnchors).toHaveLength(19)
    expect(network.sourceFile!.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(network.knownPoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'sy730', known: true, height: -14.2884 }),
      expect.objectContaining({ id: 'S6G03', known: true, height: -9.297595 })
    ]))
    expect(network.unknownPoints.map((point) => point.id)).toEqual(['z1', 'z2', 'z3'])
    expect(network.observations).toHaveLength(4)
    expect(network.observations.every((observation) => observation.type === 'height-difference' && observation.unit === 'm')).toBe(true)

    const checked = survey.validateNetwork(network.id, {
      expectedRevision: network.revision,
      idempotencyKey: 'm5-validate-abffb'
    })
    expect(checked.qualityStatus).toBe('validated')
    expect(checked.findings.filter((finding) => finding.status === 'open' && finding.severity === 'blocking')).toHaveLength(0)

    const adjustment = survey.createAdjustment({
      networkId: checked.id,
      expectedRevision: checked.revision,
      idempotencyKey: 'm5-adjust-abffb'
    })
    expect(adjustment.run.status).toBe('completed')
    expect(adjustment.result).toMatchObject({
      strategyId: 'height-control',
      validation: 'valid',
      linearUnit: 'm',
      angularUnit: 'rad'
    })
    expect(adjustment.result?.closure).not.toEqual({})
    expect(adjustment.result?.precision.passed).toBe(true)
    expect(adjustment.result?.points).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'sy730', height: -14.2884 }),
      expect.objectContaining({ id: 'S6G03', height: -9.297595 }),
      expect.objectContaining({ id: 'z1' }),
      expect.objectContaining({ id: 'z2' }),
      expect.objectContaining({ id: 'z3' })
    ]))
    expect(adjustment.result?.inputHash).toBe(adjustment.run.inputHash)

    const previewRequest = {
      projectId: project.id,
      adjustmentIds: [adjustment.run.id],
      deformationIds: [],
      expectedRevision: project.revision,
      idempotencyKey: 'm5-delivery-preview'
    }
    const preview = await engineering.previewReport(previewRequest)
    const manifest = await engineering.finalize({
      ...previewRequest,
      idempotencyKey: 'm5-delivery-finalize',
      acknowledgeWarnings: true
    })
    expect(manifest).toMatchObject({ reviewStatus: 'draft' })
    expect(manifest.surveySources).toHaveLength(1)
    expect(manifest.surveySources[0]?.source.detection.format).toBe('trimble-m5')
    expect(manifest.surveySources[0]?.source.sha256).toBe(network.sourceFile!.sha256)
    expect(manifest.adjustments[0]?.strategyId).toBe('height-control')
    expect(manifest.adjustments[0]?.precision.passed).toBe(true)

    const outputs = new Map(preview.files.map((file) => [file.mediaType, join(workspace, file.path)]))
    const docxPath = outputs.get('application/vnd.openxmlformats-officedocument.wordprocessingml.document')!
    const pdfPath = outputs.get('application/pdf')!
    const xlsxPath = join(workspace, preview.files.find((file) => file.path.endsWith('/evidence.xlsx'))!.path)
    const manifestPath = join(workspace, '.workwise', 'deliverables', project.id, manifest.runId, 'manifest.json')
    await Promise.all([stat(docxPath), stat(pdfPath), stat(xlsxPath), stat(manifestPath)])

    const [docx, xlsx, pdf, persistedManifest] = await Promise.all([
      JSZip.loadAsync(await readFile(docxPath)),
      JSZip.loadAsync(await readFile(xlsxPath)),
      readFile(pdfPath).then(readReportPdf),
      readFile(manifestPath, 'utf8')
    ])
    const documentXml = await docx.file('word/document.xml')!.async('text')
    const workbookXml = await xlsx.file('xl/workbook.xml')!.async('text')
    const worksheetXml = (await Promise.all(Object.keys(xlsx.files)
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .map((name) => xlsx.file(name)!.async('text')))).join('\n')
    for (const expected of ['trimble-m5-abffb.dat', 'sy730', 'S6G03', '高程 (m)', '-14.288400', '-9.297595']) {
      expect(documentXml).toContain(expected)
      expect(pdf.text).toContain(expected)
    }
    for (const text of [documentXml, pdf.text]) {
      expect(text).not.toContain('格式=trimble-m5')
      expect(text).not.toContain(network.sourceFile!.sha256)
      expect(text).not.toContain(adjustment.run.id)
    }
    expect(workbookXml).toContain('survey_sources')
    expect(workbookXml).toContain('survey_closures')
    expect(worksheetXml).toContain(network.sourceFile!.sha256)
    expect(worksheetXml).toContain('trimble-m5')
    expect(persistedManifest).toContain(network.sourceFile!.sha256)
    expect(persistedManifest).toContain('closure')
    expect(persistedManifest).toContain('precision')
    expect(engineering.verifyDeliverable(project.id, manifest.id)).toMatchObject({ valid: true, reviewStatus: 'draft' })
  })
})
