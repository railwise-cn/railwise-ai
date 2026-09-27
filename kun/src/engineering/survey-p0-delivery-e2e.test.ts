import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import Database from 'better-sqlite3'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { CosaIn1Mapping } from './survey-cosa-in1.js'
import { EngineeringService } from './engineering-service.js'
import { SurveyService } from './survey-service.js'
import type { AdjustmentRunV1, AdjustmentResultV1, SurveyNetworkV1 } from '../contracts/survey.js'
import { readReportPdf } from '../../tests/helpers/report-pdf.js'

const fixtures = new URL('./fixtures/survey-formats/', import.meta.url)

describe('P0 professional survey delivery', () => {
  it('delivers mapped COSA .in1 and COSA .in2 adjustments with traceable closure and precision evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-p0-delivery-'))
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
          observations: network.observations.map(({ id, type, sourceRecordId }) => ({ id, type, sourceRecordId })),
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
      name: 'P0 格式交付验收',
      workspace,
      expectedRevision: 0,
      idempotencyKey: 'p0-delivery-project'
    })
    const [in1Bytes, in1MappingBytes, in2Bytes] = await Promise.all([
      readFile(new URL('professional/cosa-in1-level-golden-a.in1', fixtures)),
      readFile(new URL('professional/cosa-in1-mapping.json', fixtures)),
      readFile(new URL('cosa-in2/golden-plane-control-e2e.in2', fixtures))
    ])
    const cosaIn1Mapping = JSON.parse(in1MappingBytes.toString('utf8')) as CosaIn1Mapping

    const levelNetwork = await survey.importNetwork({
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: 'p0-import-cosa-in1',
      name: 'cosa-in1-level-golden-a.in1',
      networkType: 'leveling',
      cosaIn1Mapping,
      dataBase64: in1Bytes.toString('base64')
    })
    const planeNetwork = await survey.importNetwork({
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: 'p0-import-cosa-in2',
      name: 'golden-plane-control-e2e.in2',
      networkType: 'plane-control',
      dataBase64: in2Bytes.toString('base64')
    })

    expect(levelNetwork.sourceFile).toMatchObject({
      disposition: 'adjustment-ready',
      detection: { format: 'cosa-in1' },
      linearUnitCanonical: 'm',
      angularUnitCanonical: 'rad'
    })
    expect(planeNetwork.sourceFile).toMatchObject({
      disposition: 'adjustment-ready',
      detection: { format: 'cosa-in2' },
      linearUnitCanonical: 'm',
      angularUnitCanonical: 'rad'
    })
    expect(levelNetwork.sourceFile!.rawRecordAnchors.length).toBeGreaterThan(0)
    expect(planeNetwork.sourceFile!.rawRecordAnchors.length).toBeGreaterThan(0)

    const checkedLevel = survey.validateNetwork(levelNetwork.id, {
      expectedRevision: levelNetwork.revision,
      idempotencyKey: 'p0-validate-cosa-in1'
    })
    const checkedPlane = survey.validateNetwork(planeNetwork.id, {
      expectedRevision: planeNetwork.revision,
      idempotencyKey: 'p0-validate-cosa-in2'
    })
    expect(checkedLevel.qualityStatus).toBe('validated')
    expect(checkedPlane.qualityStatus).toBe('validated')

    const levelAdjustment = survey.createAdjustment({
      networkId: checkedLevel.id,
      expectedRevision: checkedLevel.revision,
      idempotencyKey: 'p0-adjust-cosa-in1'
    })
    const planeAdjustment = survey.createAdjustment({
      networkId: checkedPlane.id,
      expectedRevision: checkedPlane.revision,
      idempotencyKey: 'p0-adjust-cosa-in2'
    })
    expect(levelAdjustment.run.status).toBe('completed')
    expect(levelAdjustment.result).toMatchObject({ strategyId: 'leveling', validation: 'valid', linearUnit: 'm', angularUnit: 'rad' })
    expect(levelAdjustment.result.closure).not.toEqual({})
    expect(levelAdjustment.result.precision.passed).toBe(true)
    expect(planeAdjustment.run.status).toBe('completed')
    expect(planeAdjustment.result).toMatchObject({ strategyId: 'plane-control', validation: 'valid', linearUnit: 'm', angularUnit: 'rad' })
    expect(planeAdjustment.result.closure).not.toEqual({})
    expect(planeAdjustment.result.precision.passed).toBe(true)
    // Exercise the retained v6 dispatch in the current host as well as the
    // separately recorded replay of an actual v6 packaged-app database.
    const legacyRun = { ...planeAdjustment.run, algorithmVersion: 'workwise-survey-adjustment-6' }
    const legacyResult = (survey as unknown as { calculateAdjustmentResult(network: SurveyNetworkV1, run: AdjustmentRunV1): AdjustmentResultV1 })
      .calculateAdjustmentResult(checkedPlane, legacyRun)
    expect(legacyResult.algorithmVersion).toBe('workwise-survey-adjustment-6')
    expect(legacyResult.points).toEqual(planeAdjustment.result.points.map(({ xyErrorEllipse: _ellipse, ...point }) => point))
    expect(legacyResult.observations).toEqual(planeAdjustment.result.observations)

    const adjustmentIds = [levelAdjustment.run.id, planeAdjustment.run.id]
    const previewRequest = {
      projectId: project.id,
      adjustmentIds,
      deformationIds: [],
      expectedRevision: project.revision,
      idempotencyKey: 'p0-delivery-preview'
    }
    const preview = await engineering.previewReport(previewRequest)
    expect((await engineering.previewReport(previewRequest)).run.id).toBe(preview.run.id)
    expect(preview.run.datasetId).toBeUndefined()
    expect(preview.run.analysisId).toBeUndefined()
    expect(preview.charts).toEqual([])
    const finalizeRequest = {
      projectId: project.id,
      adjustmentIds,
      deformationIds: [],
      expectedRevision: project.revision,
      idempotencyKey: 'p0-delivery-finalize',
      acknowledgeWarnings: true
    }
    const manifest = await engineering.finalize(finalizeRequest)
    expect((await engineering.finalize(finalizeRequest)).id).toBe(manifest.id)
    expect(manifest).toMatchObject({ inputDatasets: [], analyses: [], charts: [], reviewStatus: 'draft' })

    expect(manifest.surveySources.map((item) => item.source.detection.format).sort()).toEqual(['cosa-in1', 'cosa-in2'])
    expect(manifest.surveySources.map((item) => item.source.sha256).sort()).toEqual([
      levelNetwork.sourceFile!.sha256,
      planeNetwork.sourceFile!.sha256
    ].sort())
    expect(manifest.adjustments.map((item) => item.strategyId).sort()).toEqual(['leveling', 'plane-control'])
    expect(manifest.adjustments.every((item) => Object.keys(item.closure).length > 0 && item.precision.passed)).toBe(true)

    const outputs = new Map(preview.files.map((file) => [file.mediaType, join(workspace, file.path)]))
    const docxPath = outputs.get('application/vnd.openxmlformats-officedocument.wordprocessingml.document')!
    const pdfPath = outputs.get('application/pdf')!
    const xlsxPath = outputs.get('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')!
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
    for (const expected of ['cosa-in1-level-golden-a.in1', 'golden-plane-control-e2e.in2', '格式=cosa-in1', '格式=cosa-in2']) {
      expect(documentXml).toContain(expected)
      expect(pdf.text).toContain(expected)
    }
    expect(workbookXml).toContain('survey_sources')
    expect(workbookXml).toContain('survey_closures')
    expect(workbookXml).toContain('survey_parameters')
    expect(workbookXml).toContain('survey_error_ellipses')
    const ellipse = planeAdjustment.result.points.find(point => point.id === 'S1')!.xyErrorEllipse!
    expect(ellipse).toBeDefined()
    expect(documentXml).toContain(`长半轴=${ellipse.semiMajor} m`)
    expect(documentXml).toContain('单位马氏半径，非置信百分比')
    expect(pdf.text).toContain('survey-xy-error-ellipse-1')
    expect(worksheetXml).toContain('Cxx_m2')
    expect(worksheetXml).toContain(String(ellipse.semiMajor))
    expect(worksheetXml).toContain('unit-mahalanobis-radius')
    expect(JSON.parse(persistedManifest).adjustments.find((a: { strategyId: string }) => a.strategyId === 'plane-control').points.find((p: { id: string }) => p.id === 'S1').xyErrorEllipse).toEqual(ellipse)
    expect(workbookXml).not.toContain('normalized_data')
    expect(workbookXml).not.toContain('analysis_results')
    expect(documentXml).not.toContain('监测类型')
    expect(documentXml).not.toContain('阈值配置')
    expect(worksheetXml).toContain('cosa-in1')
    expect(worksheetXml).toContain('cosa-in2')
    expect(worksheetXml).toContain(levelNetwork.sourceFile!.sha256)
    expect(worksheetXml).toContain(planeNetwork.sourceFile!.sha256)
    expect(persistedManifest).toContain('cosa-in1')
    expect(persistedManifest).toContain('cosa-in2')
    expect(persistedManifest).toContain('closure')
    expect(persistedManifest).toContain('precision')
    for (const adjustment of manifest.adjustments) {
      for (const [key, value] of Object.entries(adjustment.closure)) {
        expect(worksheetXml).toContain(key)
        expect(worksheetXml).toContain(String(value))
        expect(adjustment.closureUnits[key]).toMatch(/^(m|rad)$/)
      }
    }
    await expect(engineering.previewReport({ ...previewRequest, adjustmentIds: [], idempotencyKey: 'p0-empty-report' })).rejects.toThrow(/selected survey results/)
    await expect(engineering.previewReport({ ...previewRequest, analysisId: 'unrelated-analysis', idempotencyKey: 'p0-orphan-analysis' })).rejects.toThrow(/analysisId requires datasetId/)
    await expect(engineering.previewReport({ ...previewRequest, expectedRevision: project.revision + 1, idempotencyKey: 'p0-stale-project' })).rejects.toThrow(/project revision conflict/)
    const verification = engineering.verifyDeliverable(project.id, manifest.id)
    expect(verification).toMatchObject({ valid: true, reviewStatus: 'draft' })
    expect(verification.checks).toHaveLength(5)
    expect(verification.checks.every(item => item.status === 'passed')).toBe(true)
    expect(() => engineering.verifyDeliverable('other-project', manifest.id)).toThrow(/not found in project/)
    const sealedOutput = join(workspace, manifest.outputs[0]!.path)
    const original = await readFile(sealedOutput)
    await writeFile(sealedOutput, 'tampered')
    expect(engineering.verifyDeliverable(project.id, manifest.id)).toMatchObject({ valid: false, checks: expect.arrayContaining([{ id: 'outputs', status: 'failed', detail: expect.stringContaining('recorded hash') }]) })
    await writeFile(sealedOutput, original)
    await writeFile(manifestPath, persistedManifest + '\n')
    expect(engineering.verifyDeliverable(project.id, manifest.id)).toMatchObject({ valid: false, checks: expect.arrayContaining([{ id: 'manifest', status: 'failed', detail: expect.stringContaining('durable manifest') }]) })
    await writeFile(manifestPath, persistedManifest)
    expect(engineering.verifyDeliverable(project.id, manifest.id).valid).toBe(true)
    expect(await readFile(manifestPath, 'utf8')).toBe(persistedManifest)
    const db = new Database(join(root, 'runtime', 'survey.sqlite3'))
    try {
      const adjustmentId = manifest.adjustments[0]!.runId
      const before = db.prepare('SELECT data_json FROM survey_adjustments WHERE id = ?').get(adjustmentId) as { data_json: string }
      const altered = JSON.parse(before.data_json)
      altered.result.unitWeightStdDev += 0.123
      db.prepare('UPDATE survey_adjustments SET data_json = ? WHERE id = ?').run(JSON.stringify(altered), adjustmentId)
      const rejected = engineering.verifyDeliverable(project.id, manifest.id)
      expect(rejected.valid).toBe(false)
      expect(rejected.checks.find(item => item.id === 'surveyReplay')?.status).toBe('failed')
      db.prepare('UPDATE survey_adjustments SET data_json = ? WHERE id = ?').run(before.data_json, adjustmentId)
    } finally { db.close() }
    expect(engineering.verifyDeliverable(project.id, manifest.id).valid).toBe(true)

    engineering.updateProject(project.id, { name: 'Changed project', expectedRevision: project.revision, idempotencyKey: 'p0-change-project' })
    await expect(engineering.previewReport({ ...previewRequest, expectedRevision: 0 })).rejects.toThrow()
    await expect(engineering.finalize({ ...finalizeRequest, expectedRevision: 0 })).rejects.toThrow()
    expect(engineering.verifyDeliverable(project.id, manifest.id)).toMatchObject({ valid: false, checks: expect.arrayContaining([{ id: 'inputs', status: 'failed', detail: expect.any(String) }]) })
  })
})
