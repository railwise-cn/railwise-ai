import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { qualityScoringTestRequest } from '../src/engineering/survey-quality-scoring-test-helpers.js'
import { SurveyQualityScoringSummaryV1, type SurveyQualityScoringRecordV1 } from '../src/contracts/survey-quality-scoring-workspace.js'

it('factory wires authentication, durable experimental records, and shutdown without formal survey mutations', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kun-advanced-wiring-'))
  const options = { host: '127.0.0.1', port: 0, dataDir, runtimeToken: 'advanced-test-token', apiKey: 'not-used',
    baseUrl: 'http://127.0.0.1:9', model: 'deepseek-v4-pro', approvalPolicy: 'on-request' as const,
    sandboxMode: 'workspace-write' as const, tokenEconomyMode: false, insecure: false, storage: { backend: 'file' as const } }
  let runtime: Awaited<ReturnType<typeof createKunServeRuntime>> | undefined
  try {
    runtime = await createKunServeRuntime(options)
    const project = runtime.engineeringService!.createProject({ name: 'advanced wiring', workspace: dataDir, expectedRevision: 0, idempotencyKey: 'advanced-project' })
    const path = `/v1/engineering/projects/${project.id}/quality-scoring`, router = buildRouter(runtime)
    const route = router.match('POST', path)!
    const records: SurveyQualityScoringRecordV1[] = []
    for (const kind of ['accuracy','unit'] as const) {
      const input = qualityScoringTestRequest(kind, `wiring-${kind}`)
      const denied = await route.handler(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(input) }), { params: route.params })
      expect(denied.status).toBe(401)
      const response = await route.handler(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(input), headers: { authorization: 'Bearer advanced-test-token' } }), { params: route.params })
      expect(response.status).toBe(201)
      const summary = SurveyQualityScoringSummaryV1.parse(JSON.parse(response instanceof Response ? await response.text() : response.body))
      records.push(runtime.surveyQualityScoringWorkspaceService!.getRecord(project.id, summary.id))
    }
    expect(runtime.engineeringService!.getProject(project.id)).toEqual(project)
    const closed = runtime.surveyQualityScoringWorkspaceService!
    await runtime.shutdown?.(); runtime = undefined
    expect(() => closed.getRecord(project.id, records[0]!.id)).toThrow()
    runtime = await createKunServeRuntime(options)
    for (const record of records) expect(runtime.surveyQualityScoringWorkspaceService!.getRecord(project.id, record.id)).toEqual(record)
  } finally { await runtime?.shutdown?.(); await rm(dataDir, { recursive: true, force: true }) }
}, 30_000)
