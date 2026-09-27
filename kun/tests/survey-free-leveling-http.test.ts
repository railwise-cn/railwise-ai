import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { dispatchRequest } from '../src/server/http-server.js'
import { SurveyService } from '../src/engineering/survey-service.js'
import { importWorkwiseSurveyNetwork } from '../src/engineering/survey-test-helpers.js'
import { buildHarness } from './http-server-test-harness.js'
import { SurveyFreeLevelingTrialV1, SurveyFreeLevelingTrialListV1 } from '../src/contracts/survey-free-leveling.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0)) await action() })

describe('authenticated free leveling trial HTTP', () => {
  it('creates, lists, restores and exports isolated records while refusing unauthorized/stale access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'free-leveling-http-'))
    const service = new SurveyService({ rootDir: root })
    cleanup.push(async () => { await service.flush(); service.close(); await rm(root, { recursive: true, force: true }) })
    const network = await importWorkwiseSurveyNetwork(service, {
      projectId: 'trial-http-project', expectedRevision: 0, idempotencyKey: 'trial-http-import',
      network: { networkType: 'leveling', knownPoints: [{ id: 'A', known: true, height: 0 }], unknownPoints: [{ id: 'B', known: false, height: 0 }, { id: 'C', known: false, height: 0 }],
        observations: [['A', 'B', 1], ['B', 'C', 2], ['C', 'A', -2.7]].map(([from, to, value], i) => ({ id: `e${i}`, from, to, value, unit: 'm', type: 'height-difference' })), instrumentParameters: {} }
    })
    const h = buildHarness(); h.runtime.surveyService = service
    const url = `http://localhost/v1/engineering/projects/${network.projectId}/networks/${network.id}/free-leveling-trials`
    const body = { expectedRevision: network.revision, idempotencyKey: 'create-1', constraint: 'sum-height-corrections-zero', acknowledgeDatumRelease: true, weightPolicy: 'source-or-unit-fallback' }
    const headers = { authorization: 'Bearer tok-1', 'content-type': 'application/json' }
    const create = vi.spyOn(service, 'createFreeLevelingTrial'), list = vi.spyOn(service, 'listFreeLevelingTrials'), read = vi.spyOn(service, 'getFreeLevelingTrial')
    for (const path of [url, `${url}/unknown`]) for (const method of path === url ? ['GET', 'POST'] : ['GET']) {
      for (const auth of ['', 'Bearer wrong']) expect((await dispatchRequest(h.router, new Request(path, { method, headers: { authorization: auth }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }))).status).toBe(401)
    }
    expect(create).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
    for (const change of [{ acknowledgeDatumRelease: false }, { weightPolicy: undefined }, { expectedRevision: 0 }, { injected: 1 }]) {
      expect((await dispatchRequest(h.router, new Request(url, { method: 'POST', headers, body: JSON.stringify({ ...body, ...change }) }))).status).toBe(400)
    }
    const created = await dispatchRequest(h.router, new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }))
    expect(created.status).toBe(201); expect(created.headers.get('cache-control')).toBe('no-store')
    const record = SurveyFreeLevelingTrialV1.parse(await created.json())
    expect(record.output).toMatchObject({ status: 'trial-only', aprioriCovariance: null, engineeringDecision: 'not-evaluated' })
    const page = await dispatchRequest(h.router, new Request(`${url}?limit=1&offset=0`, { headers }))
    expect(page.status).toBe(200)
    const summary = SurveyFreeLevelingTrialListV1.parse(await page.json())
    expect(summary.trials).toHaveLength(1); expect(summary.trials[0]).not.toHaveProperty('output')
    const detailUrl = `${url}/${record.id}`
    const detail = await dispatchRequest(h.router, new Request(`${detailUrl}?download=1`, { headers }))
    expect(detail.status).toBe(200); expect(detail.headers.get('content-disposition')).toContain('survey-free-leveling-trial.json')
    expect(await detail.json()).toEqual(record)
    for (const path of [url, detailUrl]) {
      const response = await dispatchRequest(h.router, new Request(path.replace(network.projectId, 'other-project'), { headers }))
      expect(response.status).toBe(404); expect(await response.text()).not.toContain(record.sourceSha256)
    }
    expect((await dispatchRequest(h.router, new Request(url.replace(network.projectId, 'other-project'), { method: 'POST', headers, body: JSON.stringify(body) }))).status).toBe(404)
    expect((await dispatchRequest(h.router, new Request(`${url}?limit=51`, { headers }))).status).toBe(400)
    const staleRevision = await dispatchRequest(h.router, new Request(url, { method: 'POST', headers, body: JSON.stringify({ ...body, expectedRevision: 999 }) }))
    expect(staleRevision.status).toBe(409); expect(await staleRevision.json()).toMatchObject({ code: 'free_leveling_stale' })
    read.mockImplementationOnce(() => { throw new Error('sensitive raw bytes at /private/secret-path') })
    const hidden = await dispatchRequest(h.router, new Request(detailUrl, { headers }))
    expect(hidden.status).toBe(409); expect(await hidden.text()).not.toContain('secret-path')
    await writeFile(join(root, 'sources', network.sourceFile!.sha256, 'original'), 'changed')
    for (const path of [url, detailUrl]) {
      const stale = await dispatchRequest(h.router, new Request(path, { headers }))
      expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'free_leveling_source_ineligible' })
    }
    expect((await dispatchRequest(h.router, new Request(url, { method: 'POST', headers, body: JSON.stringify(body) }))).status).toBe(409)
  })

  it('returns unavailable only after authentication', async () => {
    const h = buildHarness(), url = 'http://localhost/v1/engineering/projects/p/networks/n/free-leveling-trials'
    for (const method of ['GET', 'POST']) {
      expect((await dispatchRequest(h.router, new Request(url, { method }))).status).toBe(401)
      expect((await dispatchRequest(h.router, new Request(url, { method, headers: { authorization: 'Bearer tok-1' } }))).status).toBe(503)
    }
  })
})
