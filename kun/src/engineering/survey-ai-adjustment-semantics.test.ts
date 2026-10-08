import { readFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { EngineeringService } from './engineering-service.js'
import { EngineeringContextService } from './engineering-context-service.js'
import { SurveyService } from './survey-service.js'
import { importWorkwiseSurveyNetwork } from './survey-test-helpers.js'
import { buildRailwiseToolProviders } from '../adapters/tool/railwise-tool-provider.js'
import { surveyAiAdjustmentSemantics } from './survey-ai-adjustment-semantics.js'
import { buildSurveyProfessionalReview } from './survey-professional-review.js'
import { SurveyNetworkV1 } from '../contracts/survey.js'

async function fixture(kind: 'plane-control' | 'leveling', options: { noRedundancy?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'survey-ai-closure-'))
  const engineering = new EngineeringService({ rootDir: root })
  const survey = new SurveyService({ rootDir: root, getProject: id => engineering.getProject(id) })
  onTestFinished(() => { survey.close(); engineering.close() })
  const project = engineering.createProject({ name: 'closure evidence', workspace: root, expectedRevision: 0, idempotencyKey: 'closure-project' })
  const network = kind === 'plane-control'
    ? await survey.importNetwork({
      projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'closure-source', networkType: kind,
      name: 'golden-plane-control-e2e.in2',
      referenceDeclaration: { coordinateSystem: '公开合成样例独立坐标系' },
      dataBase64: (await readFile(new URL('./fixtures/survey-formats/cosa-in2/golden-plane-control-e2e.in2', import.meta.url))).toString('base64')
    })
    : await importWorkwiseSurveyNetwork(survey, {
      projectId: project.id, expectedRevision: project.revision, idempotencyKey: 'closure-source', networkType: kind,
      network: {
        coordinateSystem: 'LOCAL', verticalDatum: 'LOCAL-BM',
        knownPoints: [{ id: 'A', known: true, height: 10 }], unknownPoints: [{ id: 'P', height: 11 }],
        instrumentParameters: { closureTolerance: 0.004 }, observations: [
          { id: 'forward', type: 'height-difference', from: 'A', to: 'P', value: 1000, unit: 'mm', routeLength: 100 },
          ...(!options.noRedundancy ? [{ id: 'back', type: 'height-difference', from: 'P', to: 'A', value: -0.998, unit: 'm', routeLength: 200 }] : [])
        ]
      }
    })
  const checked = survey.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'closure-precheck' })
  const output = survey.createAdjustment({ networkId: checked.id, expectedRevision: checked.revision, idempotencyKey: 'closure-adjust' })
  expect(output.result.validation).toBe('valid')
  const context = new EngineeringContextService(engineering, undefined, survey)
  const evidence = context.conversationEvidence(project.id, { adjustmentId: output.run.id }) as { adjustments: Array<ReturnType<typeof surveyAiAdjustmentSemantics>> }
  const tool = buildRailwiseToolProviders(engineering, survey)[0]!.tools.find(tool => tool.name === 'survey_adjustment_read')!
  const read = await tool.execute({ networkId: checked.id, adjustmentId: output.run.id }, {} as never)
  expect(read.isError).not.toBe(true)
  return { project, survey, network: checked, output, contextEvidence: evidence.adjustments[0]!, toolEvidence: (read.output as { result: ReturnType<typeof surveyAiAdjustmentSemantics> }).result }
}

describe('professional closure meaning in real AI inputs', () => {
  it('provides the relative weighting model and actual scale units to both real AI read paths', async () => {
    const { output, contextEvidence, toolEvidence } = await fixture('leveling')
    for (const evidence of [contextEvidence, toolEvidence]) {
      expect(evidence).toMatchObject({ weightingBasis: 'relative-route-length', relativeWeightReferenceLengthMetres: 1,
        relativeWeightDefaultLengthObservationIds: [], unitWeightStdDevUnit: 'm', varianceFactorUnit: 'm2' })
      expect(evidence.weightingSemantics).toMatchObject({ status: 'recorded', scaleStatus: 'estimated-posterior', precisionStatus: 'available' })
      expect(evidence.unitWeightStdDev).toBeCloseTo(output.result.unitWeightStdDev, 15)
      expect(evidence.varianceFactor).toBeCloseTo(output.result.varianceFactor, 15)
      expect(evidence.weightingSemantics.meaning).toContain('not per kilometre')
      expect(evidence.weightingSemantics.meaning).toContain('not be compared with dimensionless 1')
    }
  })

  it('does not give AI nominal scale numbers or an absolute precision pass for a nonredundant relative network', async () => {
    const { output, contextEvidence, toolEvidence } = await fixture('leveling', { noRedundancy: true })
    expect(output.result.points.find(point => point.id === 'P')!.height).toBe(11)
    for (const evidence of [contextEvidence, toolEvidence]) {
      expect(evidence).toMatchObject({ weightingBasis: 'relative-route-length', unitWeightStdDevUnit: 'm', varianceFactorUnit: 'm2',
        unitWeightStdDev: null, varianceFactor: null, precision: { maxPointStdDev: null, passed: null, assessmentStatus: 'not-evaluated' } })
      expect(evidence.weightingSemantics).toMatchObject({ status: 'recorded', scaleStatus: 'not-evaluated', precisionStatus: 'not-evaluated',
        unitWeightStdDev: null, varianceFactor: null })
    }
  })

  it('marks IN2 fitted plane norms as post-adjustment while independent closure remains unevaluated in both read paths', async () => {
    const { survey, output, contextEvidence, toolEvidence } = await fixture('plane-control')
    const storedBefore = JSON.stringify(survey.getAdjustment(output.run.id)?.result)
    for (const evidence of [contextEvidence, toolEvidence]) {
      expect(evidence.independentClosureCheck).toMatchObject({ status: 'not-evaluated', reason: 'plane-closures-not-evaluated', sourceBinding: 'bound', routeCount: 0, routes: [] })
      expect(evidence.fittedResidualSummary).toMatchObject({ status: 'descriptive-only', computationStage: 'after-adjustment' })
      expect(evidence.legacyClosureSemantics.entries).toEqual([
        { key: 'horizontal', meaning: 'fitted-residual-norm-not-pre-adjustment-route-closure', computationStage: 'after-adjustment' },
        { key: 'angular', meaning: 'fitted-residual-norm-not-pre-adjustment-route-closure', computationStage: 'after-adjustment' }
      ])
      expect(evidence.fittedResidualSummary.residualNorms.find(row => row.unit === 'm')!.value).toBeCloseTo(output.result.closure.horizontal!, 16)
      expect(evidence.fittedResidualSummary.residualNorms.find(row => row.unit === 'rad')!.value).toBeCloseTo(output.result.closure.angular!, 16)
    }
    expect(JSON.stringify(survey.getAdjustment(output.run.id)?.result)).toBe(storedBefore)
  })

  it('returns the original water-level route and limit separately from the fitted residual norm', async () => {
    const { contextEvidence, toolEvidence } = await fixture('leveling')
    for (const evidence of [contextEvidence, toolEvidence]) {
      expect(evidence.independentClosureCheck).toMatchObject({ status: 'pass', sourceBinding: 'bound', computationStage: 'before-adjustment', routeCount: 1 })
      const route = evidence.independentClosureCheck.routes[0]!
      expect(route.misclosureMetres).toBeCloseTo(0.002, 14)
      expect(route).toMatchObject({ toleranceMetres: 0.004, totalLengthMetres: 300, memberCount: 2, membersTruncated: false })
      expect(route.members.map(row => row.observationId).sort()).toEqual(['back', 'forward'])
      expect(evidence.fittedResidualSummary.residualNorms[0]!.value).not.toBeCloseTo(Math.abs(route.misclosureMetres), 10)
    }
  })

  it('does not infer a closure pass from tiny legacy values when a professional projection is unavailable', async () => {
    const { output } = await fixture('plane-control')
    const evidence = surveyAiAdjustmentSemantics(output.result)
    expect(evidence.independentClosureCheck).toMatchObject({ status: 'not-evaluated', reason: 'professional-review-unavailable', sourceBinding: 'unavailable', routes: [] })
    expect(evidence.fittedResidualSummary.computationStage).toBe('after-adjustment')
  })

  it('does not project new source closures onto a stored result after the datum changes', async () => {
    const { project, output, network } = await fixture('leveling')
    const changed = SurveyNetworkV1.parse({ ...network, verticalDatum: 'CHANGED', revision: network.revision + 1 })
    const review = buildSurveyProfessionalReview({ projectId: project.id, network: changed, result: output.result, sourceIntegrity: 'verified' })
    const evidence = surveyAiAdjustmentSemantics(output.result, review)
    expect(evidence.independentClosureCheck).toMatchObject({ status: 'not-evaluated', reason: 'input-mismatch', sourceBinding: 'mismatch', routes: [] })
  })

  it.each(['failed', 'not-verified'] as const)('does not certify a numerically passing route when source integrity is %s', async sourceIntegrity => {
    const { project, output, network } = await fixture('leveling')
    const review = buildSurveyProfessionalReview({ projectId: project.id, network, result: output.result, sourceIntegrity })
    expect(review.closures[0]!.status).toBe('pass')
    const evidence = surveyAiAdjustmentSemantics(output.result, review)
    expect(evidence.independentClosureCheck).toMatchObject({ status: 'not-evaluated', reason: 'source-unverified', sourceBinding: 'unverified', routeCount: 0, routes: [] })
  })
})
