import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dispatchRequest } from '../src/server/http-server.js'
import { SurveyService } from '../src/engineering/survey-service.js'
import { importWorkwiseSurveyNetwork } from '../src/engineering/survey-test-helpers.js'
import { buildHarness } from './http-server-test-harness.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0)) await action() })

describe('project-scoped statistical diagnostics HTTP', () => {
  it('requires authorization, exports bound JSON, rejects cross-project and stale-source access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'survey-statistics-http-'))
    const service = new SurveyService({ rootDir: root })
    cleanup.push(async () => { await service.flush(); service.close(); await rm(root, { recursive: true, force: true }) })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'project-statistics-http', expectedRevision: 0, idempotencyKey: 'statistics-http-import',
      network: { networkType: 'leveling', knownPoints: [{ id: 'BM', known: true, height: 10 }],
        unknownPoints: [{ id: 'P', known: false, height: 10.1 }],
        observations: [0.1001, 0.1002, 0.1004, 0.1008].map((value, i) => ({
          id: `dh-${i}`, type: 'height-difference', from: 'BM', to: 'P', value, unit: 'm', sigma: 0.001, sigmaUnit: 'm'
        })), instrumentParameters: {} }
    })
    const created = service.createAdjustment({ networkId: network.id, expectedRevision: network.revision, idempotencyKey: 'statistics-http-adjust' })
    const h = buildHarness()
    h.runtime.surveyService = service
    const url = `http://localhost/v1/engineering/projects/${network.projectId}/adjustments/${created.run.id}/statistical-diagnostics`
    const read = vi.spyOn(service, 'getAdjustmentStatisticalDiagnostics')
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }]) {
      const unauthorized = await dispatchRequest(h.router, new Request(url, { headers }))
      expect(unauthorized.status).toBe(401)
    }
    expect(read).not.toHaveBeenCalled()
    const headers = { authorization: 'Bearer tok-1' }
    const response = await dispatchRequest(h.router, new Request(`${url}?download=1`, { headers }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="survey-statistical-diagnostics.json"')
    const body = await response.json()
    expect(body).toMatchObject({ status: 'available', projectId: network.projectId, runId: created.run.id,
      resultId: created.result.id, inputHash: created.run.inputHash, decision: 'not-evaluated' })
    const crossProject = await dispatchRequest(h.router, new Request(url.replace(network.projectId, 'another-project'), { headers }))
    expect(crossProject.status).toBe(404)
    expect(await crossProject.text()).not.toContain(created.result.id)
    read.mockImplementationOnce(() => { throw new Error('raw-source-fragment: sensitive-station-coordinate') })
    const sourceError = await dispatchRequest(h.router, new Request(url, { headers }))
    expect(sourceError.status).toBe(409)
    expect(await sourceError.text()).not.toContain('sensitive-station-coordinate')
    await writeFile(join(root, 'sources', network.sourceFile!.sha256, 'original'), 'changed')
    const stale = await dispatchRequest(h.router, new Request(url, { headers }))
    expect(stale.status).toBe(409)
    expect(await stale.text()).not.toContain('externallyStudentizedResidual')
  })

  it('reports unavailable runtime after passing authentication', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(h.router, new Request('http://localhost/v1/engineering/projects/project/adjustments/adjustment/statistical-diagnostics', { headers: { authorization: 'Bearer tok-1' } }))
    expect(response.status).toBe(503)
  })
})
