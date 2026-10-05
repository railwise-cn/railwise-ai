import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { readReportPdf } from '../../tests/helpers/report-pdf.js'
import { EngineeringService } from './engineering-service.js'
import { SurveyService } from './survey-service.js'

describe('survey results in engineering deliverables', () => {
  it('keeps adjustment results and displacement evidence in manifest and XLSX', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-deliverable-'))
    const workspace = join(root, 'workspace')
    let engineering!: EngineeringService
    let omitSourceEligibilityFromLookup = false
    const survey = new SurveyService({ rootDir: join(root, 'runtime'), getProject: (id) => engineering.getProject(id) })
    engineering = new EngineeringService({
      rootDir: join(root, 'runtime'),
      getAdjustments: (projectId, ids) => ids.flatMap((id) => {
        const stored = survey.getAdjustment(id)
        return stored?.run.projectId === projectId && stored.result ? [stored.result] : []
      }),
      getAdjustmentEvidence: (projectId, ids) => ids.flatMap((id) => {
        const stored = survey.getAdjustment(id)
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
      getDeformations: (projectId, ids) => ids.flatMap((id) => {
        const result = survey.getDeformation(id)
        return result?.projectId === projectId ? [result] : []
      }),
      getSurveySources: (projectId, ids) => ids.flatMap((id) => {
        const network = survey.getNetwork(id)
        if (!network || network.projectId !== projectId) return []
        const source = {
          networkId: id,
          ...(network.sourceFile ? { sourceFile: network.sourceFile } : {}),
          observations: network.observations.map(({ id: observationId, type, sourceRecordId }) => ({ id: observationId, type, sourceRecordId })),
          points: [...network.knownPoints, ...network.unknownPoints].map(({ id: pointId }) => ({ id: pointId })),
          rawSourceIntegrity: survey.getRawSourceIntegrity(id),
          sourceEligibility: survey.getSourceEligibility(id)
        }
        // Simulate a stale/out-of-contract integration at runtime. The
        // required TypeScript contract catches normal callers; review must
        // still reject a malformed provider instead of assuming readiness.
        if (omitSourceEligibilityFromLookup) Reflect.deleteProperty(source, 'sourceEligibility')
        return [source]
      })
    })
    const project = engineering.createProject({ name: '平差成果测试', workspace, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'survey-delivery-project' })
    const network = await survey.importNetwork({
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: 'survey-delivery-import',
      networkType: 'leveling',
      name: 'level-network.json',
      dataBase64: Buffer.from(JSON.stringify({
        format: 'workwise-survey-network',
        formatVersion: 1,
        network: {
          networkType: 'leveling',
          coordinateSystem: 'local-grid', projection: 'none', ellipsoid: 'none', verticalDatum: '1985-height', observationEpoch: '2026-08-01T00:00:00.000Z', unit: 'm',
          knownPoints: [{ id: 'BM', pointClass: 'known', height: 10, known: true }],
          unknownPoints: [{ id: 'P1', pointClass: 'unknown', height: 10.1, known: false }],
          observations: [{ id: 'obs-1', type: 'height-difference', from: 'BM', to: 'P1', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
        }
      })).toString('base64')
    })
    const checkedNetwork = survey.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'survey-delivery-validate' })
    const adjustment = survey.createAdjustment({ networkId: network.id, expectedRevision: checkedNetwork.revision, idempotencyKey: 'survey-delivery-adjust' })
    expect(adjustment.result.displacements.find((item) => item.pointId === 'P1')?.dH).toBeCloseTo(0, 8)
    const currentNetwork = await survey.importNetwork({
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: 'survey-delivery-import-current',
      networkType: 'leveling',
      name: 'level-network-current.json',
      dataBase64: Buffer.from(JSON.stringify({
        format: 'workwise-survey-network',
        formatVersion: 1,
        network: {
          networkType: 'leveling',
          coordinateSystem: 'local-grid', projection: 'none', ellipsoid: 'none', verticalDatum: '1985-height', observationEpoch: '2026-08-11T00:00:00.000Z', unit: 'm',
          knownPoints: [{ id: 'BM', pointClass: 'known', height: 10, known: true }],
          unknownPoints: [{ id: 'P1', pointClass: 'unknown', height: 10.09, known: false }],
          observations: [{ id: 'obs-2', type: 'height-difference', from: 'BM', to: 'P1', value: 0.09, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
        }
      })).toString('base64')
    })
    const currentAdjustment = survey.createAdjustment({ networkId: currentNetwork.id, expectedRevision: currentNetwork.revision, idempotencyKey: 'survey-delivery-adjust-current' })
    const deformation = survey.compareDeformation({ projectId: project.id, adjustmentIds: [adjustment.run.id, currentAdjustment.run.id], pairs: [{ id: 'tilt-pair', firstPointId: 'BM', secondPointId: 'P1', kind: 'tilt', baselineM: 10 }], expectedRevision: currentAdjustment.run.revision, idempotencyKey: 'survey-delivery-deformation' })

    const dataset = await engineering.importDataset({
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: 'survey-delivery-dataset',
      name: 'monitoring.csv',
      dataBase64: Buffer.from('point,time,value\nP1,2026-08-01,1\nP1,2026-08-02,2').toString('base64')
    })
    const validated = engineering.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'survey-delivery-data-validate' })
    const analysis = engineering.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: validated.revision, idempotencyKey: 'survey-delivery-analysis' })
    const preview = await engineering.previewReport({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, adjustmentIds: [adjustment.run.id, currentAdjustment.run.id], deformationIds: [deformation.id], expectedRevision: validated.revision, idempotencyKey: 'survey-delivery-preview' })
    expect(preview.adjustments.map((item) => item.id)).toEqual([adjustment.result.id, currentAdjustment.result.id])
    expect(preview.deformations.map((item) => item.id)).toEqual([deformation.id])
    const previewReplay = await engineering.previewReport({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, adjustmentIds: [adjustment.run.id, currentAdjustment.run.id], deformationIds: [deformation.id], expectedRevision: validated.revision, idempotencyKey: 'survey-delivery-preview' })
    expect(previewReplay.run.id).toBe(preview.run.id)
    expect(previewReplay.surveySources.map((item) => item.networkId).sort()).toEqual(preview.surveySources.map((item) => item.networkId).sort())
    // A delivery key is bound to every provenance-bearing input.  Reusing it
    // with otherwise admissible but different sources/citations must not make
    // the old report appear to describe the new evidence set.
    await expect(engineering.previewReport({
      projectId: project.id,
      datasetId: dataset.id,
      analysisId: analysis.id,
      adjustmentIds: [currentAdjustment.run.id],
      deformationIds: [deformation.id],
      expectedRevision: validated.revision,
      idempotencyKey: 'survey-delivery-preview'
    })).rejects.toThrow(/idempotency key is already bound/)
    await expect(engineering.previewReport({
      projectId: project.id,
      datasetId: dataset.id,
      analysisId: analysis.id,
      adjustmentIds: [adjustment.run.id, currentAdjustment.run.id],
      deformationIds: [],
      expectedRevision: validated.revision,
      idempotencyKey: 'survey-delivery-preview'
    })).rejects.toThrow(/idempotency key is already bound/)
    await expect(engineering.previewReport({
      projectId: project.id,
      datasetId: dataset.id,
      analysisId: analysis.id,
      adjustmentIds: [adjustment.run.id, currentAdjustment.run.id],
      deformationIds: [deformation.id],
      citations: [{ id: 'preview-replay-mismatch-citation', sourceType: 'other', source: 'changed request citation' }],
      expectedRevision: validated.revision,
      idempotencyKey: 'survey-delivery-preview'
    })).rejects.toThrow(/idempotency key is already bound/)
    const evidencePath = join(workspace, preview.files.find((file) => file.mediaType.includes('spreadsheet'))!.path)
    const workbook = await JSZip.loadAsync(await readFile(evidencePath))
    const workbookXml = await workbook.file('xl/workbook.xml')!.async('text')
    expect(workbookXml).toContain('survey_adjustments')
    expect(workbookXml).toContain('survey_sources')
    expect(workbookXml).toContain('survey_source_diagnostics')
    expect(workbookXml).toContain('survey_raw_anchors')
    expect(workbookXml).toContain('survey_closures')
    expect(workbookXml).toContain('survey_parameters')
    expect(workbookXml).toContain('survey_points')
    expect(workbookXml).toContain('survey_residuals')
    expect(workbookXml).toContain('survey_statistical_scope')
    expect(workbookXml).toContain('survey_residual_semantics')
    expect(workbookXml).toContain('survey_displacements')
    expect(workbookXml).toContain('deformation_epochs')
    expect(workbookXml).toContain('deformation_points')
    expect(workbookXml).toContain('deformation_pairs')
    const evidenceXml = (await Promise.all(Object.keys(workbook.files)
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .map((name) => workbook.file(name)!.async('text')))).join('\n')
    expect(evidenceXml).toContain('unitWeightStdDevUnit')
    expect(evidenceXml).toContain('varianceFactor')
    expect(evidenceXml).toContain('varianceFactorUnit')
    expect(evidenceXml).toContain('varianceFactorEstimated')
    expect(evidenceXml).toContain('standardsConformity')
    expect(evidenceXml).toContain('not-evaluated')
    expect(evidenceXml).toContain('observation-sigma-ratio')
    expect(evidenceXml).toContain('strategyId')
    expect(evidenceXml).toContain('algorithmVersion')
    expect(evidenceXml).toContain('dimensionless')
    expect(evidenceXml).toContain('maxPointStdDevUnit')
    expect(evidenceXml).toContain('standardizedResidualUnit')
    expect(evidenceXml).toContain('sourceRecordId')
    expect(evidenceXml).toContain('workwise-json-observation-1')
    expect(evidenceXml).toContain('level-network.json')
    expect(evidenceXml).toContain('workwise-json')
    expect(evidenceXml).toContain(network.sourceFile!.sha256)
    const manifest = await engineering.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, adjustmentIds: [adjustment.run.id, currentAdjustment.run.id], deformationIds: [deformation.id], expectedRevision: validated.revision, idempotencyKey: 'survey-delivery-finalize', acknowledgeWarnings: true })
    expect(manifest.reviewStatus).toBe('draft')
    expect(manifest.validation.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('尚未完成复核、审核、批准与签名流程')
    ]))
    expect(manifest.validation.warnings.some((warning) => warning.includes('旧结构化/兼容输入'))).toBe(false)
    expect(manifest.adjustments.map((item) => item.id)).toEqual([adjustment.result.id, currentAdjustment.result.id])
    expect(manifest.adjustments[0]?.inputHash).toBe(adjustment.result.inputHash)
    expect(manifest.deformations.map((item) => item.id)).toEqual([deformation.id])
    expect(manifest.surveySources).toEqual(expect.arrayContaining([
      expect.objectContaining({ networkId: network.id, source: expect.objectContaining({ name: 'level-network.json', sha256: network.sourceFile!.sha256 }) }),
      expect.objectContaining({ networkId: currentNetwork.id, source: expect.objectContaining({ name: 'level-network-current.json', sha256: currentNetwork.sourceFile!.sha256 }) })
    ]))
    const manifestReplay = await engineering.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, adjustmentIds: [adjustment.run.id, currentAdjustment.run.id], deformationIds: [deformation.id], expectedRevision: validated.revision, idempotencyKey: 'survey-delivery-finalize', acknowledgeWarnings: true })
    expect(manifestReplay.id).toBe(manifest.id)
    await expect(engineering.finalize({
      projectId: project.id,
      datasetId: dataset.id,
      analysisId: analysis.id,
      adjustmentIds: [currentAdjustment.run.id],
      deformationIds: [deformation.id],
      expectedRevision: validated.revision,
      idempotencyKey: 'survey-delivery-finalize',
      acknowledgeWarnings: true
    })).rejects.toThrow(/idempotency key is already bound/)
    await expect(engineering.finalize({
      projectId: project.id,
      datasetId: dataset.id,
      analysisId: analysis.id,
      adjustmentIds: [adjustment.run.id, currentAdjustment.run.id],
      deformationIds: [],
      expectedRevision: validated.revision,
      idempotencyKey: 'survey-delivery-finalize',
      acknowledgeWarnings: true
    })).rejects.toThrow(/idempotency key is already bound/)
    await expect(engineering.finalize({
      projectId: project.id,
      datasetId: dataset.id,
      analysisId: analysis.id,
      adjustmentIds: [adjustment.run.id, currentAdjustment.run.id],
      deformationIds: [deformation.id],
      citations: [{ id: 'finalize-replay-mismatch-citation', sourceType: 'other', source: 'changed request citation' }],
      expectedRevision: validated.revision,
      idempotencyKey: 'survey-delivery-finalize',
      acknowledgeWarnings: true
    })).rejects.toThrow(/idempotency key is already bound/)
    const docxPath = join(workspace, preview.files.find((file) => file.mediaType.includes('word'))!.path)
    const docx = await JSZip.loadAsync(await readFile(docxPath))
    const documentXml = await docx.file('word/document.xml')!.async('text')
    expect(documentXml).toContain('平差统计与检查状态')
    expect(documentXml).toContain('资料与版本绑定')
    expect(documentXml).toContain('level-network.json')
    expect(documentXml).toContain('点位成果与精度')
    expect(documentXml).toContain('单位权中误差 (无量纲)')
    expect(documentXml).toContain('方差因子 (无量纲)')
    expect(documentXml).toContain('点位中误差 (mm)')
    expect(documentXml).toContain('残差范数仅作描述性统计，不等同闭合差')
    expect(documentXml).not.toContain('策略=')
    expect(documentXml).not.toContain('格式=workwise-json')
    expect(documentXml).not.toContain(adjustment.run.id)
    expect(documentXml).toContain('<w:tbl>')
    expect(documentXml).toContain('<w:tblHeader/>')
    expect(documentXml).toContain('闭合与附合检核')
    expect(documentXml).toContain('签认状态：未签认')
    expect(documentXml).toContain('点位变形成果')
    expect(documentXml).toContain('P1')
    expect(documentXml).toContain('倾斜')
    expect(documentXml).toContain('tilt-pair')
    const pdfPath = join(workspace, preview.files.find((file) => file.mediaType === 'application/pdf')!.path)
    const { text: pdfText } = await readReportPdf(await readFile(pdfPath))
    expect(pdfText).toContain('level-network.json')
    expect(pdfText).not.toContain('格式=workwise-json')
    expect(pdfText).not.toContain('策略=')

    // A source can remain byte-verifiable while an adjustment row is damaged
    // or no longer represents its live run. Formal delivery must fail before
    // creating another output, rather than treating the source check alone as
    // proof of numerical-result admission.
    const adjustmentDatabase = new Database(join(root, 'runtime', 'survey.sqlite3'))
    const originalAdjustmentRow = adjustmentDatabase.prepare('SELECT data_json FROM survey_adjustments WHERE id = ?').get(adjustment.run.id) as { data_json: string }
    const adjustmentDeliverableDirectory = join(workspace, '.workwise', 'deliverables', project.id)
    const outputDirectoriesBeforeAdjustmentEvidenceFailure = (await readdir(adjustmentDeliverableDirectory)).sort()
    const assertRejectedAdjustmentEvidence = async (
      suffix: string,
      mutate: (stored: { run: Record<string, unknown>; result: Record<string, unknown> }) => void,
      expected: RegExp,
      checkFinalize = false
    ) => {
      const tampered = JSON.parse(originalAdjustmentRow.data_json) as { run: Record<string, unknown>; result: Record<string, unknown> }
      mutate(tampered)
      adjustmentDatabase.prepare('UPDATE survey_adjustments SET data_json = ? WHERE id = ?').run(JSON.stringify(tampered), adjustment.run.id)
      try {
        await expect(engineering.previewReport({
          projectId: project.id,
          datasetId: dataset.id,
          analysisId: analysis.id,
          adjustmentIds: [adjustment.run.id],
          expectedRevision: validated.revision,
          idempotencyKey: `survey-delivery-preview-invalid-adjustment-${suffix}`
        })).rejects.toThrow(expected)
        if (checkFinalize) {
          await expect(engineering.finalize({
            projectId: project.id,
            datasetId: dataset.id,
            analysisId: analysis.id,
            adjustmentIds: [adjustment.run.id],
            expectedRevision: validated.revision,
            idempotencyKey: `survey-delivery-finalize-invalid-adjustment-${suffix}`,
            acknowledgeWarnings: true
          })).rejects.toThrow(expected)
        }
        expect((await readdir(adjustmentDeliverableDirectory)).sort()).toEqual(outputDirectoriesBeforeAdjustmentEvidenceFailure)
      } finally {
        adjustmentDatabase.prepare('UPDATE survey_adjustments SET data_json = ? WHERE id = ?').run(originalAdjustmentRow.data_json, adjustment.run.id)
      }
    }
    await assertRejectedAdjustmentEvidence('failed-run', (stored) => { stored.run.status = 'failed' }, /不是 completed/, true)
    await assertRejectedAdjustmentEvidence('invalid-result', (stored) => { stored.result.validation = 'invalid' }, /不是 valid/)
    await assertRejectedAdjustmentEvidence('wrong-network', (stored) => { stored.result.networkId = currentNetwork.id }, /结果网络编号/)
    await assertRejectedAdjustmentEvidence('wrong-input', (stored) => { stored.result.inputHash = 'f'.repeat(64) }, /结果输入哈希/)
    adjustmentDatabase.close()

    // Historical deformation rows remain readable, but a new preview/finalize
    // must not accept a persisted epoch whose result hash no longer binds to
    // the live adjustment result. Restore the row afterwards so the separate
    // source-admission assertions below exercise their own gate.
    const deformationDatabase = new Database(join(root, 'runtime', 'survey.sqlite3'))
    const originalDeformationRow = deformationDatabase.prepare('SELECT data_json FROM survey_deformations WHERE id = ?').get(deformation.id) as { data_json: string }
    const tamperedDeformation = JSON.parse(originalDeformationRow.data_json) as { epochs: Array<{ resultHash: string }> }
    tamperedDeformation.epochs[0]!.resultHash = '0'.repeat(64)
    deformationDatabase.prepare('UPDATE survey_deformations SET data_json = ? WHERE id = ?').run(JSON.stringify(tamperedDeformation), deformation.id)
    try {
      expect(survey.getDeformation(deformation.id)).toMatchObject({ id: deformation.id, epochs: expect.arrayContaining([expect.objectContaining({ resultHash: '0'.repeat(64) })]) })
      const evidenceDeliverableDirectory = join(workspace, '.workwise', 'deliverables', project.id)
      const outputDirectoriesBeforeEvidenceFailure = (await readdir(evidenceDeliverableDirectory)).sort()
      await expect(engineering.previewReport({
        projectId: project.id,
        datasetId: dataset.id,
        analysisId: analysis.id,
        adjustmentIds: [adjustment.run.id, currentAdjustment.run.id],
        deformationIds: [deformation.id],
        expectedRevision: validated.revision,
        idempotencyKey: 'survey-delivery-preview-tampered-deformation-evidence'
      })).rejects.toThrow(/deformation epoch evidence check failed[\s\S]*结果哈希/)
      await expect(engineering.finalize({
        projectId: project.id,
        datasetId: dataset.id,
        analysisId: analysis.id,
        adjustmentIds: [adjustment.run.id, currentAdjustment.run.id],
        deformationIds: [deformation.id],
        expectedRevision: validated.revision,
        idempotencyKey: 'survey-delivery-finalize-tampered-deformation-evidence',
        acknowledgeWarnings: true
      })).rejects.toThrow(/deformation epoch evidence check failed[\s\S]*结果哈希/)
      expect((await readdir(evidenceDeliverableDirectory)).sort()).toEqual(outputDirectoriesBeforeEvidenceFailure)
    } finally {
      deformationDatabase.prepare('UPDATE survey_deformations SET data_json = ? WHERE id = ?').run(originalDeformationRow.data_json, deformation.id)
      deformationDatabase.close()
    }

    // Epoch binding alone is insufficient for an idempotent re-issue: a
    // changed deformation metric can retain the same valid epoch evidence.
    // The cached preview/manifest must therefore remain bound to the complete
    // live deformation comparison, not merely to its stable ID.
    const replayDeformationDatabase = new Database(join(root, 'runtime', 'survey.sqlite3'))
    try {
      const tamperedReplayDeformation = JSON.parse(originalDeformationRow.data_json) as { stabilityRateMPerDay: number }
      tamperedReplayDeformation.stabilityRateMPerDay += 0.000001
      replayDeformationDatabase.prepare('UPDATE survey_deformations SET data_json = ? WHERE id = ?').run(JSON.stringify(tamperedReplayDeformation), deformation.id)
      await expect(engineering.previewReport({
        projectId: project.id,
        datasetId: dataset.id,
        analysisId: analysis.id,
        adjustmentIds: [adjustment.run.id, currentAdjustment.run.id],
        deformationIds: [deformation.id],
        expectedRevision: validated.revision,
        idempotencyKey: 'survey-delivery-preview'
      })).rejects.toThrow(/stored preview deformation evidence no longer matches/)
      await expect(engineering.finalize({
        projectId: project.id,
        datasetId: dataset.id,
        analysisId: analysis.id,
        adjustmentIds: [adjustment.run.id, currentAdjustment.run.id],
        deformationIds: [deformation.id],
        expectedRevision: validated.revision,
        idempotencyKey: 'survey-delivery-finalize',
        acknowledgeWarnings: true
      })).rejects.toThrow(/stored deliverable manifest deformation evidence no longer matches/)
    } finally {
      replayDeformationDatabase.prepare('UPDATE survey_deformations SET data_json = ? WHERE id = ?').run(originalDeformationRow.data_json, deformation.id)
      replayDeformationDatabase.close()
    }

    // Simulate a legacy persisted network whose unit was later changed. Its
    // source bytes and append-only ledger are untouched and still verify, but
    // `ft` has no confirmed canonical conversion. This is deliberately not a
    // duplicate source-file or integrity failure: delivery must consume the
    // SurveyService's complete current source-eligibility verdict.
    const database = new Database(join(root, 'runtime', 'survey.sqlite3'))
    try {
      const row = database.prepare('SELECT data_json FROM survey_networks WHERE id = ?').get(network.id) as { data_json: string }
      const storedNetwork = JSON.parse(row.data_json) as { unit: string }
      storedNetwork.unit = 'ft'
      database.prepare('UPDATE survey_networks SET data_json = ? WHERE id = ?').run(JSON.stringify(storedNetwork), network.id)
    } finally {
      database.close()
    }
    expect(survey.getRawSourceIntegrity(network.id)).toMatchObject({ status: 'verified' })
    expect(survey.getSourceEligibility(network.id)).toMatchObject({
      eligible: false,
      findings: expect.arrayContaining([expect.objectContaining({ code: 'unit_conflict', message: expect.stringContaining('网络长度单位 ft') })])
    })

    // A failed current-eligibility check must block both cached and fresh
    // previews before either can allocate another deliverable directory.
    const deliverableDirectory = join(workspace, '.workwise', 'deliverables', project.id)
    const outputDirectoriesBeforeFailedAdmission = (await readdir(deliverableDirectory)).sort()
    await expect(engineering.previewReport({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, adjustmentIds: [adjustment.run.id, currentAdjustment.run.id], deformationIds: [deformation.id], expectedRevision: validated.revision, idempotencyKey: 'survey-delivery-preview' })).rejects.toThrow(/raw survey source integrity check failed[\s\S]*unit_conflict/)
    await expect(engineering.previewReport({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, adjustmentIds: [adjustment.run.id, currentAdjustment.run.id], deformationIds: [deformation.id], expectedRevision: validated.revision, idempotencyKey: 'survey-delivery-preview-after-unit-conflict' })).rejects.toThrow(/raw survey source integrity check failed[\s\S]*unit_conflict/)
    expect((await readdir(deliverableDirectory)).sort()).toEqual(outputDirectoriesBeforeFailedAdmission)

    // The historical manifest remains readable, but neither its prior key
    // nor a fresh key may produce another formal deliverable now that source
    // eligibility has failed.
    await expect(engineering.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, adjustmentIds: [adjustment.run.id, currentAdjustment.run.id], deformationIds: [deformation.id], expectedRevision: validated.revision, idempotencyKey: 'survey-delivery-finalize', acknowledgeWarnings: true })).rejects.toThrow(/raw survey source integrity check failed[\s\S]*unit_conflict/)
    expect(engineering.getProjectOverview(project.id).manifests).toEqual(expect.arrayContaining([expect.objectContaining({ id: manifest.id })]))
    await expect(engineering.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, adjustmentIds: [adjustment.run.id, currentAdjustment.run.id], deformationIds: [deformation.id], expectedRevision: validated.revision, idempotencyKey: 'survey-delivery-finalize-after-unit-conflict', acknowledgeWarnings: true })).rejects.toThrow(/raw survey source integrity check failed[\s\S]*unit_conflict/)

    // A stale JavaScript provider can still omit the required field at
    // runtime. Missing current admission is also a hard failure, rather than
    // a reason to fall back to the older source-file/integrity checks.
    omitSourceEligibilityFromLookup = true
    await expect(engineering.previewReport({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, adjustmentIds: [adjustment.run.id, currentAdjustment.run.id], deformationIds: [deformation.id], expectedRevision: validated.revision, idempotencyKey: 'survey-delivery-preview-missing-source-eligibility' })).rejects.toThrow(/当前服务端来源资格校验；服务端未提供/)
    await expect(engineering.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, adjustmentIds: [adjustment.run.id, currentAdjustment.run.id], deformationIds: [deformation.id], expectedRevision: validated.revision, idempotencyKey: 'survey-delivery-finalize-missing-source-eligibility', acknowledgeWarnings: true })).rejects.toThrow(/当前服务端来源资格校验；服务端未提供/)
    engineering.close()
    survey.close()
  })

  it('does not persist a preview when strict adjustment evidence changes while files are generated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-survey-delivery-toctou-'))
    const workspace = join(root, 'workspace')
    let engineering!: EngineeringService
    let evidenceReads = 0
    const survey = new SurveyService({ rootDir: join(root, 'runtime'), getProject: (id) => engineering.getProject(id) })
    engineering = new EngineeringService({
      rootDir: join(root, 'runtime'),
      getAdjustmentEvidence: (projectId, ids) => ids.flatMap((id) => {
        const stored = survey.getAdjustmentForProjectNewUse(projectId, id)
        if (!stored?.result) return []
        evidenceReads += 1
        const result = evidenceReads < 2
          ? stored.result
          : {
              ...stored.result,
              points: stored.result.points.map((point) => point.id === 'P1' && point.height !== undefined
                ? { ...point, height: point.height + 1 }
                : point)
            }
        return [{
          run: {
            id: stored.run.id,
            projectId: stored.run.projectId,
            networkId: stored.run.networkId,
            inputHash: stored.run.inputHash,
            status: stored.run.status
          },
          result
        }]
      }),
      getSurveySources: (projectId, ids) => ids.flatMap((id) => {
        const network = survey.getNetwork(id)
        return network?.projectId === projectId
          ? [{
              networkId: network.id,
              ...(network.sourceFile ? { sourceFile: network.sourceFile } : {}),
              rawSourceIntegrity: survey.getRawSourceIntegrity(network.id),
              sourceEligibility: survey.getSourceEligibility(network.id),
              observations: network.observations.map(({ id: observationId, type, sourceRecordId }) => ({ id: observationId, type, sourceRecordId })),
              points: [...network.knownPoints, ...network.unknownPoints].map(({ id: pointId }) => ({ id: pointId }))
            }]
          : []
      })
    })
    const project = engineering.createProject({ name: '交付证据竞态', workspace, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'delivery-toctou-project' })
    const network = await survey.importNetwork({
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: 'delivery-toctou-network',
      networkType: 'leveling',
      name: 'level.json',
      dataBase64: Buffer.from(JSON.stringify({
        format: 'workwise-survey-network', formatVersion: 1,
        network: {
          networkType: 'leveling', coordinateSystem: 'local-grid', projection: 'none', ellipsoid: 'none', verticalDatum: '1985-height', unit: 'm',
          knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }],
          unknownPoints: [{ id: 'P1', pointClass: 'unknown', known: false, height: 10.1 }],
          observations: [{ id: 'dh-1', type: 'height-difference', from: 'BM', to: 'P1', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
        }
      })).toString('base64')
    })
    const adjustment = survey.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'delivery-toctou-adjustment' })
    const dataset = await engineering.importDataset({
      projectId: project.id,
      expectedRevision: project.revision,
      idempotencyKey: 'delivery-toctou-dataset',
      name: 'monitoring.csv',
      dataBase64: Buffer.from('point,time,value\nP1,2026-08-01,1\nP1,2026-08-02,2').toString('base64')
    })
    const validated = engineering.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'delivery-toctou-validate' })
    const analysis = engineering.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: validated.revision, idempotencyKey: 'delivery-toctou-analysis' })

    await expect(engineering.previewReport({
      projectId: project.id,
      datasetId: dataset.id,
      analysisId: analysis.id,
      adjustmentIds: [adjustment.run.id],
      deformationIds: [],
      expectedRevision: validated.revision,
      idempotencyKey: 'delivery-toctou-preview'
    })).rejects.toThrow(/preview publication adjustment evidence no longer matches/)
    expect(evidenceReads).toBeGreaterThanOrEqual(2)
    expect(engineering.getProjectOverview(project.id).runs).toEqual([])
    // The chart may have its own independent artifact directory, but an
    // evidence-revoked report must never escape the staging tree as a public
    // `run_*` delivery directory. Its random staging directory is removed as
    // part of the same failed preview.
    const publicDeliverables = await readdir(join(workspace, '.workwise', 'deliverables', project.id)).catch(() => [])
    expect(publicDeliverables.filter((name) => name.startsWith('run_'))).toEqual([])
    const stagedDeliverables = await readdir(join(workspace, '.workwise', '.staging', 'deliverables', project.id)).catch(() => [])
    expect(stagedDeliverables).toEqual([])
    engineering.close()
    survey.close()
  })
})
