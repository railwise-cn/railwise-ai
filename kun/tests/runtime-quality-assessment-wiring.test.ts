import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { SurveyQualityAssessmentPlanV1, SurveyQualityAssessmentV1 } from '../src/contracts/survey-quality-assessment.js'

it('wires readonly assessment dependencies, authenticated dispatch, durable records and shutdown', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'assessment-factory-'))
  const options = { host: '127.0.0.1', port: 0, dataDir, runtimeToken: 'assessment-test-token', apiKey: 'unused',
    baseUrl: 'http://127.0.0.1:9', model: 'deepseek-v4-pro', approvalPolicy: 'on-request' as const,
    sandboxMode: 'workspace-write' as const, tokenEconomyMode: false, insecure: false, storage: { backend: 'file' as const } }
  let runtime: Awaited<ReturnType<typeof createKunServeRuntime>> | undefined
  try {
    runtime = await createKunServeRuntime(options)
    const engineering = runtime.engineeringService!
    const project = engineering.createProject({ name: 'Declared association fixture', workspace: join(dataDir, 'workspace'), expectedRevision: 0, idempotencyKey: 'fixture-project' })
    const dataset = await engineering.importDataset({ projectId: project.id, expectedRevision: 1, idempotencyKey: 'fixture-dataset', name: 'synthetic.csv', dataBase64: Buffer.from('point,time,value\nP,2026-09-01,1\nP,2026-09-02,2').toString('base64') })
    const validated = engineering.validateDataset({ datasetId: dataset.id, expectedRevision: dataset.revision, idempotencyKey: 'fixture-validation' })
    const analysis = engineering.createAnalysis({ projectId: project.id, datasetId: dataset.id, expectedRevision: validated.revision, idempotencyKey: 'fixture-analysis' })
    const manifest = await engineering.finalize({ projectId: project.id, datasetId: dataset.id, analysisId: analysis.id, expectedRevision: validated.revision, idempotencyKey: 'fixture-finalize', acknowledgeWarnings: true })
    const retained = runtime.surveyQualityWorkspaceService!.createPlan(project.id, { manifestId: manifest.id, expectedProjectRevision: 1, idempotencyKey: 'fixture-retention-plan', requiredEvidence: [{ id: 'report', title: 'Declared report', memberId: 'output-1' }] })
    const evidence = runtime.surveyQualityWorkspaceService!.createRecord(project.id, { planId: retained.plan.id, idempotencyKey: 'fixture-retention-record' })
    const population = runtime.surveySamplingWorkspaceService!.createPopulation(project.id, { expectedProjectRevision: 1, idempotencyKey: 'fixture-population', productType: 'control', unitProductType: 'point', definitionStatement: 'Synthetic declared one-point population.', orderedUnitProductIds: ['P'] })
    const run = runtime.surveySamplingWorkspaceService!.createRun(project.id, { populationId: population.id, idempotencyKey: 'fixture-run', stage: 'final-office', inspectionMode: 'census' })
    const router = buildRouter(runtime), base = `http://localhost/v1/engineering/projects/${project.id}`
    const send = (path: string, method = 'GET', body?: unknown, auth = true) => dispatchRequest(router, new Request(base + path, { method,
      headers: auth ? { authorization: 'Bearer assessment-test-token', 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) }))
    expect((await send('/quality-assessment-plans', 'GET', undefined, false)).status).toBe(401)
    const planResponse = await send('/quality-assessment-plans', 'POST', { schemaVersion: 1, acknowledged: true, expectedProjectRevision: 1, idempotencyKey: 'fixture-assessment-plan', retentionPlanId: retained.plan.id, retentionRecordId: evidence.record.id, samplingRunId: run.id, productProfileId: 'planar-control-point', basisStatement: 'Synthetic linkage only.', unitMaterials: [{ unitId: 'P', requirements: [{ reference: 'synthetic', retentionCheckId: 'evidence:report', memberId: 'output-1', locatorStatement: 'Synthetic report' }] }] })
    expect(planResponse.status).toBe(201)
    const plan = SurveyQualityAssessmentPlanV1.parse(await planResponse.json())
    const response = await send('/quality-assessments', 'POST', { schemaVersion: 1, acknowledged: true, expectedProjectRevision: 1, idempotencyKey: 'fixture-assessment', assessmentPlanId: plan.id, expectedPlanHash: plan.planHash, unitScores: [] })
    expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store')
    const record = SurveyQualityAssessmentV1.parse(await response.json())
    expect(record.result.overallLinkage).toBe('incomplete-declared-linkage')
    expect(record.manifestReviewStatus).toBe('draft')
    expect(runtime.engineeringService!.getProject(project.id)).toEqual(project)
    const closed = runtime.surveyQualityAssessmentService!
    await runtime.shutdown?.(); runtime = undefined
    expect(() => closed.getAssessment(project.id, record.id)).toThrow()
    runtime = await createKunServeRuntime(options)
    expect(runtime.surveyQualityAssessmentService!.getAssessment(project.id, record.id)).toEqual(record)
  } finally { await runtime?.shutdown?.(); await rm(dataDir, { recursive: true, force: true }) }
}, 30_000)
