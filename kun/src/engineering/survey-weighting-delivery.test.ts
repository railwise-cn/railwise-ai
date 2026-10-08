import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it, onTestFinished } from 'vitest'
import { EngineeringService } from './engineering-service.js'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'

async function evidenceRows(zip: JSZip, name: string): Promise<Array<Record<string, string>>> {
  const workbook = await zip.file('xl/workbook.xml')!.async('text')
  const sheet = [...workbook.matchAll(/<sheet name="([^"]+)" sheetId="(\d+)"/g)].find(match => match[1] === name)
  expect(sheet, `${name} worksheet missing`).toBeDefined()
  const xml = await zip.file(`xl/worksheets/sheet${sheet![2]}.xml`)!.async('text')
  const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(row =>
    [...row[1]!.matchAll(/<c[^>]*>[\s\S]*?<t>([\s\S]*?)<\/t>[\s\S]*?<\/c>/g)].map(cell => cell[1]!))
  const header = rows.shift()!
  return rows.map(row => Object.fromEntries(header.map((key, index) => [key, row[index]!])) )
}

async function preview(kind: 'absolute' | 'relative' | 'nonredundant-relative' | 'equal-relative') {
  const root = await mkdtemp(join(tmpdir(), 'survey-weight-delivery-'))
  let engineering!: EngineeringService
  const survey = new SurveyService({ rootDir: join(root, 'runtime'), getProject: id => engineering.getProject(id) })
  engineering = new EngineeringService({
    rootDir: join(root, 'runtime'),
    getAdjustments: (projectId, ids) => ids.flatMap(id => {
      const output = survey.getAdjustmentForProjectNewUse(projectId, id)
      return output?.result ? [output.result] : []
    }),
    getAdjustmentEvidence: (projectId, ids) => ids.flatMap(id => {
      const output = survey.getAdjustmentForProjectNewUse(projectId, id)
      return output?.result ? [{ run: output.run, result: output.result }] : []
    }),
    getProfessionalReview: (projectId, id) => survey.getAdjustment(id)?.run.projectId === projectId ? survey.getProfessionalReview(id) : null,
    getSurveySources: (projectId, ids) => ids.flatMap(id => {
      const network = survey.getNetwork(id)
      return network?.projectId === projectId && network.sourceFile ? [{
        networkId: network.id, sourceFile: network.sourceFile,
        rawSourceIntegrity: survey.getRawSourceIntegrity(network.id), sourceEligibility: survey.getSourceEligibility(network.id),
        observations: network.observations.map(({ id, type, sourceRecordId }) => ({ id, type, sourceRecordId })),
        points: [...network.knownPoints, ...network.unknownPoints].map(({ id }) => ({ id }))
      }] : []
    })
  })
  onTestFinished(async () => { survey.close(); engineering.close(); await rm(root, { recursive: true, force: true }) })
  const project = engineering.createProject({ name: '公开合成定权交付检核', workspace: join(root, 'workspace'), expectedRevision: 0, idempotencyKey: 'weight-project' })
  const absolute = kind === 'absolute', nonredundant = kind === 'nonredundant-relative', equal = kind === 'equal-relative'
  const network = await importWorkwiseSurveyNetwork(survey, { projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'weight-import', networkType: 'leveling', network: {
    knownPoints: [{ id: 'BM', known: true, height: 10 }], unknownPoints: [{ id: 'P', known: false, height: 11 }],
    observations: [
      { id: 'out', type: 'height-difference', from: 'BM', to: 'P', value: 1, unit: 'm',
        ...(!equal ? { routeLength: 1 } : {}), ...(absolute ? { sigma: .002, sigmaUnit: 'm' } : {}) },
      ...(!nonredundant ? [{ id: 'back', type: 'height-difference', from: 'P', to: 'BM', value: -.999, unit: 'm',
        ...(!equal ? { routeLength: 4 } : {}), ...(absolute ? { sigma: .004, sigmaUnit: 'm' } : {}) }] : [])
    ], instrumentParameters: {}
  } })
  const output = survey.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'weight-adjust' })
  expect(output.result.validation).toBe('valid')
  const original = JSON.stringify(survey.getAdjustment(output.run.id))
  const generated = await engineering.previewReport({ projectId: project.id, adjustmentIds: [output.run.id], expectedRevision: project.revision, idempotencyKey: 'weight-preview' })
  const artifact = generated.files.find(file => file.path.endsWith('/evidence.xlsx'))!
  expect(artifact).toBeDefined()
  const workbook = await JSZip.loadAsync(await readFile(join(project.workspace, artifact.path)))
  expect(JSON.stringify(survey.getAdjustment(output.run.id))).toBe(original)
  return { output, workbook }
}

describe('production delivery weighting evidence', () => {
  it.each(['absolute', 'relative', 'equal-relative'] as const)('exports %s scales, units and assumptions without changing numeric results', async kind => {
    const { output, workbook } = await preview(kind)
    const [row] = await evidenceRows(workbook, 'survey_adjustments')
    expect(row).toMatchObject({ weightingBasis: kind === 'absolute' ? 'absolute-prior' : 'relative-route-length',
      unitWeightStdDevUnit: kind === 'absolute' ? 'dimensionless' : 'm', varianceFactorUnit: kind === 'absolute' ? 'dimensionless' : 'm2',
      weightingStatus: 'recorded', scaleStatus: 'estimated-posterior', pointPrecisionStatus: 'available', maxPointStdDevUnit: 'm',
      relativeWeightReferenceLengthMetres: kind === 'absolute' ? '' : '1', equalWeightObservationIds: kind === 'equal-relative' ? 'out;back' : '' })
    expect(Number(row!.unitWeightStdDev)).toBe(output.result.unitWeightStdDev)
    expect(Number(row!.varianceFactor)).toBe(output.result.varianceFactor)
    expect(Number(row!.maxPointStdDev)).toBe(output.result.precision.maxPointStdDev)
    const observations = await evidenceRows(workbook, 'survey_residuals')
    if (kind !== 'absolute') observations.forEach(observation => expect(observation).toMatchObject({
      standardizedResidual: '', standardizedResidualUnit: '', outlier: ''
    }))
  })

  it('leaves unassessed absolute scale and precision cells empty for a nonredundant relative result', async () => {
    const { output, workbook } = await preview('nonredundant-relative')
    const [row] = await evidenceRows(workbook, 'survey_adjustments')
    expect(row).toMatchObject({ weightingBasis: 'relative-route-length', unitWeightStdDevUnit: 'm', varianceFactorUnit: 'm2',
      unitWeightStdDev: '', varianceFactor: '', maxPointStdDev: '', maxPointStdDevUnit: '', varianceFactorEstimated: 'false',
      weightingStatus: 'recorded', scaleStatus: 'not-evaluated', pointPrecisionStatus: 'not-evaluated', relativeWeightReferenceLengthMetres: '1' })
    const point = (await evidenceRows(workbook, 'survey_points')).find(row => row.pointId === 'P')!
    expect(point).toMatchObject({ height: '11', standardError: '', linearUnit: 'm' })
    expect(output.result.points.find(point => point.id === 'P')!.standardError).toBeUndefined()
  })
})
