import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { EngineeringService } from '../../engineering/engineering-service.js'
import { SurveyService } from '../../engineering/survey-service.js'
import { importWorkwiseSurveyNetwork } from '../../engineering/survey-test-helpers.js'
import { buildRailwiseToolProviders } from './railwise-tool-provider.js'

describe('RailWise survey tool bridge', () => {
  it('validates, adjusts and reads a bounded strategy-correct result with explicit units', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-railwise-survey-tools-'))
    let survey!: SurveyService
    const engineering = new EngineeringService({
      rootDir: root,
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
      getSurveySources: (projectId, ids) => ids.flatMap((id) => {
        const network = survey.getNetwork(id)
        return network?.projectId === projectId
          ? [{
            networkId: id,
            ...(network.sourceFile ? { sourceFile: network.sourceFile } : {}),
            rawSourceIntegrity: survey.getRawSourceIntegrity(id),
            sourceEligibility: survey.getSourceEligibility(id),
            observations: network.observations.map(({ id: observationId, type, sourceRecordId }) => ({ id: observationId, type, sourceRecordId })),
            points: [...network.knownPoints, ...network.unknownPoints].map(({ id: pointId }) => ({ id: pointId }))
          }]
          : []
      })
    })
    survey = new SurveyService({ rootDir: root, getProject: (id) => engineering.getProject(id) })
    const project = engineering.createProject({ name: '工具桥接', workspace: root, thresholds: { default: 10 }, expectedRevision: 0, idempotencyKey: 'railwise-tool-project' })
    const network = await importWorkwiseSurveyNetwork(survey, { projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'railwise-tool-network', networkType: 'leveling', network: {
      knownPoints: [{ id: 'BM', pointClass: 'known', height: 10, known: true }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 10.1, known: false }],
      observations: [
        { id: 'BM-P', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', routeLength: 1 },
        { id: 'P-BM', type: 'height-difference', from: 'P', to: 'BM', value: -0.099, unit: 'm', routeLength: 4 }
      ]
    } })
    const tools = buildRailwiseToolProviders(engineering, survey)[0]!.tools
    const execute = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name === name)
      expect(tool, `missing tool ${name}`).toBeDefined()
      return tool!.execute(args, {} as never)
    }

    const validated = await execute('survey_network_validate', { networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'railwise-tool-validate' })
    expect(validated.isError).not.toBe(true)
    expect(validated.output).toMatchObject({ network: { id: network.id, networkType: 'leveling', observationCount: 2, qualityStatus: 'validated', revision: 2 } })

    const wrongStrategy = await execute('cpiii_adjustment', { networkId: network.id, expectedRevision: 2 })
    expect(wrongStrategy).toMatchObject({ isError: true, output: { error: expect.stringContaining('expected cpiii-free-station, cpiii-resection') } })

    const adjusted = await execute('survey_calculator', { networkId: network.id, expectedRevision: 2, idempotencyKey: 'railwise-tool-adjust' })
    expect(adjusted.isError).not.toBe(true)
    expect(adjusted.output).toMatchObject({
      result: {
        strategyId: 'leveling',
        weightingBasis: 'relative-route-length', relativeWeightReferenceLengthMetres: 1,
        unitWeightStdDevUnit: 'm',
        varianceFactorUnit: 'm2',
        statisticalSummary: expect.objectContaining({ numericalStatus: 'not-evaluated', availableCount: 0, unavailableCount: 2, standardsConformity: 'not-evaluated' }),
        observations: expect.arrayContaining([expect.objectContaining({ standardizedResidualUnit: 'sigma',
          residualStatistic: expect.objectContaining({ status: 'not-testable', reason: 'missing-absolute-precision',
            method: 'weight-normalized-residual', scaleBasis: 'relative-weight', significance: 'not-evaluated' }) })])
      },
      boundedOutput: { observationsReturned: 2, observationsTotal: 2, covarianceStored: true }
    })
    const adjustedRunId = (adjusted.output as { run: { id: string } }).run.id
    const adjustedOutput = adjusted.output as { result: { observations: Array<{ standardizedResidual?: number }> } }
    expect(adjustedOutput.result.observations.every(row => row.standardizedResidual === undefined)).toBe(true)

    const read = await execute('survey_adjustment_read', { networkId: network.id })
    expect(read.output).toMatchObject({
      run: { id: adjustedRunId },
      result: { strategyId: 'leveling' },
      sourceAdmission: {
        status: 'current-admissible',
        rawSourceIntegrity: { status: 'verified' },
        sourceEligibility: { eligible: true }
      }
    })

    const dataset = await engineering.importDataset({ projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'railwise-tool-dataset', name: 'monitoring.csv', dataBase64: Buffer.from('point,time,value\nP,2026-09-01,1\nP,2026-09-02,2').toString('base64') })
    const checkedDataset = engineering.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'railwise-tool-dataset-check' })
    const analysis = engineering.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: checkedDataset.revision, idempotencyKey: 'railwise-tool-analysis' })
    const report = await execute('report_export', { projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, adjustmentIds: [adjustedRunId], expectedRevision: checkedDataset.revision, idempotencyKey: 'railwise-tool-report' })
    expect(report.isError).not.toBe(true)
    expect(report.output).toMatchObject({ adjustments: [expect.objectContaining({ runId: adjustedRunId, strategyId: 'leveling' })] })
    for (const name of ['report_export', 'railwise.report_export', 'excel_export', 'railwise.excel_export']) {
      const standalone = await execute(name, { projectId: project.id, adjustmentIds: [adjustedRunId], expectedRevision: project.revision, idempotencyKey: `survey-only-${name}` })
      expect(standalone.isError).not.toBe(true)
      expect(standalone.output).toMatchObject({ charts: [], adjustments: [expect.objectContaining({ runId: adjustedRunId })] })
      expect((standalone.output as { run: { datasetId?: string; analysisId?: string } }).run.datasetId).toBeUndefined()
      expect((standalone.output as { run: { datasetId?: string; analysisId?: string } }).run.analysisId).toBeUndefined()
    }

    // Preserve the completed numerical result, but emulate a historical source
    // whose current disposition has been downgraded. The read tool must expose
    // it as evidence only rather than silently presenting it as reusable.
    const database = new Database(join(root, 'survey.sqlite3'))
    try {
      const row = database.prepare('SELECT data_json FROM survey_networks WHERE id = ?').get(network.id) as { data_json: string }
      const persisted = JSON.parse(row.data_json) as { sourceFile: { disposition: string; dispositionReason: string } }
      persisted.sourceFile.disposition = 'archive-only'
      persisted.sourceFile.dispositionReason = 'historical source retained for audit only'
      database.prepare('UPDATE survey_networks SET data_json = ? WHERE id = ?').run(JSON.stringify(persisted), network.id)
    } finally {
      database.close()
    }
    const historicalRead = await execute('survey_adjustment_read', { networkId: network.id })
    expect(historicalRead.isError).not.toBe(true)
    expect(historicalRead.output).toMatchObject({
      run: { id: adjustedRunId },
      result: { validation: 'valid' },
      sourceAdmission: {
        status: 'historical-non-admissible',
        rawSourceIntegrity: { status: 'verified' },
        sourceEligibility: {
          eligible: false,
          findings: expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining('archive-only') })])
        }
      }
    })

    survey.close()
    engineering.close()
  })
})
