import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
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
    expect(runtime.engineeringService!.getProject(project.id)).toEqual(project)
    const closed = runtime.surveyAdvancedTrialsWorkspaceService!
    await runtime.shutdown?.(); runtime = undefined
    expect(() => closed.getTrial(project.id, records[0]!.id)).toThrow()
    runtime = await createKunServeRuntime(options)
    for (const record of records) expect(runtime.surveyAdvancedTrialsWorkspaceService!.getTrial(project.id, record.id)).toEqual(record)
  } finally { await runtime?.shutdown?.(); await rm(dataDir, { recursive: true, force: true }) }
}, 30_000)
