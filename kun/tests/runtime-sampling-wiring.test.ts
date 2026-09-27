import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'

it('wires authenticated sampling into the real factory and restores the same draw after shutdown', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'kun-sampling-wiring-'))
  const options = { host: '127.0.0.1', port: 0, dataDir, runtimeToken: 'sampling-test-token', apiKey: 'not-used',
    baseUrl: 'http://127.0.0.1:9', model: 'deepseek-v4-pro', approvalPolicy: 'on-request' as const,
    sandboxMode: 'workspace-write' as const, tokenEconomyMode: false, insecure: false, storage: { backend: 'file' as const } }
  let runtime: Awaited<ReturnType<typeof createKunServeRuntime>> | undefined
  try {
    runtime = await createKunServeRuntime(options)
    const project = runtime.engineeringService!.createProject({ name: 'sampling wiring', workspace: dataDir, expectedRevision: 0, idempotencyKey: 'project-wiring' })
    const path = `/v1/engineering/projects/${project.id}/sampling-populations`
    const router = buildRouter(runtime)
    const route = router.match('POST', path)!
    const input = { idempotencyKey: 'population-wiring', expectedProjectRevision: project.revision,
      productType: 'leveling', unitProductType: 'route', definitionStatement: 'Each declared route is one unit product.',
      orderedUnitProductIds: Array.from({ length: 30 }, (_, i) => `route-${i + 1}`) }
    const denied = await route.handler(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(input) }), { params: route.params })
    expect(denied.status).toBe(401)
    const response = await route.handler(new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(input), headers: { authorization: 'Bearer sampling-test-token' } }), { params: route.params })
    expect(response.status).toBe(201)
    const population = JSON.parse(response instanceof Response ? await response.text() : response.body)
    const run = runtime.surveySamplingWorkspaceService!.createRun(project.id, { populationId: population.id,
      idempotencyKey: 'run-wiring', stage: 'acceptance', inspectionMode: 'table-1-simple-random' })
    const samples = runtime.surveySamplingWorkspaceService!.listSamples(project.id, run.id)
    expect(samples.samples).toHaveLength(5)
    await runtime.shutdown?.()
    runtime = undefined
    runtime = await createKunServeRuntime(options)
    expect(runtime.surveySamplingWorkspaceService!.getRun(project.id, run.id)).toEqual(run)
    expect(runtime.surveySamplingWorkspaceService!.listSamples(project.id, run.id)).toEqual(samples)
  } finally {
    await runtime?.shutdown?.()
    await rm(dataDir, { recursive: true, force: true })
  }
}, 30_000)
