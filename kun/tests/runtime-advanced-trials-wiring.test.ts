import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { importWorkwiseSurveyNetwork } from '../src/engineering/survey-test-helpers.js'
import { SurveySourceFixedModelV1 } from '../src/contracts/survey-source-fixed-model.js'
import { buildSourceTrialDeclaration } from '../src/contracts/survey-source-trial-adapter.js'
import { advancedTrialTestRequest } from '../src/engineering/survey-advanced-trials-test-helpers.js'
import { SurveyAdvancedTrialSummaryV1, type SurveyAdvancedTrialRecordV1 } from '../src/contracts/survey-advanced-trials-workspace.js'

it('factory wires authentication, durable experimental records, and shutdown without formal survey mutations', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kun-advanced-wiring-'))
  const options = { host: '127.0.0.1', port: 0, dataDir, runtimeToken: 'advanced-test-token', apiKey: 'not-used',
    baseUrl: 'http://127.0.0.1:9', model: 'deepseek-v4-pro', approvalPolicy: 'on-request' as const,
    sandboxMode: 'workspace-write' as const, tokenEconomyMode: false, insecure: false, storage: { backend: 'file' as const } }
  let runtime: Awaited<ReturnType<typeof createKunServeRuntime>> | undefined
  try {
    runtime = await createKunServeRuntime(options)
    const project = runtime.engineeringService!.createProject({ name: 'advanced wiring', workspace: dataDir, expectedRevision: 0, idempotencyKey: 'advanced-project' })
    const path = `/v1/engineering/projects/${project.id}/advanced-trials`, router = buildRouter(runtime)
    const survey = runtime.surveyService!
    const network = await importWorkwiseSurveyNetwork(survey, { projectId: project.id, expectedRevision: 0, idempotencyKey: 'wiring-source-import', networkType: 'leveling',
      network: { networkType: 'leveling', knownPoints: [{ id: 'BM', pointClass: 'known', known: true, height: 10 }], unknownPoints: [{ id: 'P', pointClass: 'unknown', known: false, height: 10.1 }],
        observations: [.100,.101,.099].map((value,i) => ({ id:`dh${i}`,type:'height-difference',from:'BM',to:'P',value,unit:'m',sigma:.002,sigmaUnit:'m' })), instrumentParameters: {} } })
    const checked = survey.validateNetwork(network.id, { expectedRevision: network.revision, idempotencyKey: 'wiring-source-check' })!
    const formal = survey.createAdjustment({ networkId: network.id, expectedRevision: checked.revision, idempotencyKey: 'wiring-source-adjust' })
    const formalBefore = JSON.stringify(survey.getAdjustment(formal.run.id))
    const sourcePath = `/v1/engineering/projects/${project.id}/advanced-trial-model`, sourceRoute = router.match('POST',sourcePath)!
    const readSource = async (input: unknown, authenticated = true, suffix = '') => sourceRoute.handler(new Request(`http://localhost${sourcePath}${suffix}`, { method:'POST', body:JSON.stringify(input), headers:authenticated ? {authorization:'Bearer advanced-test-token'} : {} }), { params:sourceRoute.params })
    const selection = {adjustmentId:formal.run.id,expectedProjectRevision:project.revision,expectedNetworkRevision:checked.revision}
    expect((await readSource(selection,false)).status).toBe(401)
    expect((await readSource({...selection,latest:true})).status).toBe(400)
    expect((await readSource({...selection,expectedNetworkRevision:999})).status).toBe(409)
    expect((await readSource(selection,true,'?latest=true')).status).toBe(400)
    const sourceResponse = await readSource(selection)
    expect(sourceResponse.status).toBe(200)
    const source = SurveySourceFixedModelV1.parse(JSON.parse(sourceResponse instanceof Response ? await sourceResponse.text() : sourceResponse.body))
    expect(source.model.priorParameterCovariance[0]![0]).toBeCloseTo(4e-6/3,14)
    const route = router.match('POST', path)!
    const records: SurveyAdvancedTrialRecordV1[] = []
    for (const kind of ['generalized-w','vce'] as const) {
      const input = advancedTrialTestRequest(kind, `wiring-${kind}`)
      const denied = await route.handler(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(input) }), { params: route.params })
      expect(denied.status).toBe(401)
      const response = await route.handler(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(input), headers: { authorization: 'Bearer advanced-test-token' } }), { params: route.params })
      expect(response.status).toBe(201)
      const summary = SurveyAdvancedTrialSummaryV1.parse(JSON.parse(response instanceof Response ? await response.text() : response.body))
      records.push(runtime.surveyAdvancedTrialsWorkspaceService!.getTrial(project.id, summary.id))
    }
    const sourced = buildSourceTrialDeclaration(source,'vce',{familyId:'before-evaluation',alpha:.05,externalScale:.002,externalScaleBasis:'external declared',huberK:1.345,appended:[]})
    const request = {kind:'vce',acknowledged:true,expectedProjectRevision:project.revision,idempotencyKey:'wiring-source-vce',declarationJson:JSON.stringify(sourced),modelBasisStatement:'Source-declared precision, field assumptions not authenticated.',sourceModel:source.binding}
    const created = await route.handler(new Request(`http://localhost${path}`,{method:'POST',body:JSON.stringify(request),headers:{authorization:'Bearer advanced-test-token'}}),{params:route.params})
    expect(created.status).toBe(201)
    const summary = SurveyAdvancedTrialSummaryV1.parse(JSON.parse(created instanceof Response ? await created.text() : created.body))
    records.push(runtime.surveyAdvancedTrialsWorkspaceService!.getTrial(project.id,summary.id))
    expect(JSON.stringify(survey.getAdjustment(formal.run.id))).toBe(formalBefore)
    expect(runtime.engineeringService!.getProject(project.id)).toEqual(project)
    const closed = runtime.surveyAdvancedTrialsWorkspaceService!
    await runtime.shutdown?.(); runtime = undefined
    expect(() => closed.getTrial(project.id, records[0]!.id)).toThrow()
    runtime = await createKunServeRuntime(options)
    for (const record of records) expect(runtime.surveyAdvancedTrialsWorkspaceService!.getTrial(project.id, record.id)).toEqual(record)
  } finally { await runtime?.shutdown?.(); await rm(dataDir, { recursive: true, force: true }) }
}, 30_000)
