import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineeringService } from '../src/engineering/engineering-service.js'
import { SurveySamplingWorkspaceService } from '../src/engineering/survey-sampling-workspace.js'
import * as C from '../src/contracts/survey-quality-sampling-workspace.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { buildHarness } from './http-server-test-harness.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0)) await action() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'survey-sampling-http-')), runtime = join(root, 'runtime')
  const engineering = new EngineeringService({ rootDir: runtime })
  const services = [new SurveySamplingWorkspaceService({ rootDir: runtime, getProject: id => engineering.getProject(id) })]
  cleanup.push(async () => { await engineering.flush(); services.forEach(service => service.close()); engineering.close(); await rm(root, { recursive: true, force: true }) })
  const project = engineering.createProject({ name: '抽样验收项目', workspace: join(root, 'workspace'), expectedRevision: 0, idempotencyKey: 'sampling-project' })
  const h = buildHarness(); h.runtime.surveySamplingWorkspaceService = services[0]!
  const headers = { authorization: 'Bearer tok-1', 'content-type': 'application/json' }
  const base = `http://localhost/v1/engineering/projects/${project.id}`
  const raw = (path: string, method: string, body?: string | ArrayBuffer, auth = true) => dispatchRequest(h.router, new Request(base + path, {
    method, headers: auth ? headers : {}, ...(body === undefined ? {} : { body })
  }))
  const send = (path: string, method = 'GET', body?: unknown, auth = true) => raw(path, method, body === undefined ? undefined : JSON.stringify(body), auth)
  const request = { idempotencyKey: 'sampling-population', expectedProjectRevision: project.revision, productType: '工程测量', unitProductType: '单位成果',
    definitionStatement: '每个独立提交的工程成果为一个单位产品。\n', orderedUnitProductIds: Array.from({ length: 120 }, (_, i) => `成果-${i + 1}`) }
  const restart = () => {
    services.splice(0).forEach(service => service.close())
    const service = new SurveySamplingWorkspaceService({ rootDir: runtime, getProject: id => engineering.getProject(id) })
    services.push(service); h.runtime.surveySamplingWorkspaceService = service
    return service
  }
  const db = () => new Database(join(runtime, 'survey-sampling.sqlite3'))
  return { root, runtime, project, engineering, h, service: services[0]!, base, headers, send, raw, request, restart, db }
}

describe('authenticated Survey sampling workspace HTTP', () => {
  it('freezes a real engineering project, draws once, pages samples and replays unchanged after restart', async () => {
    const f = await fixture()
    const frozen = await f.send('/sampling-populations', 'POST', f.request)
    expect(frozen.status).toBe(201); expect(frozen.headers.get('cache-control')).toBe('no-store')
    const population = C.SurveySamplingPopulationDetailV1.parse(await frozen.json())
    expect(population.definitionStatement).toBe(f.request.definitionStatement)
    const units = C.SurveySamplingUnitPageV1.parse(await (await f.send(`/sampling-populations/${population.id}/units?limit=100&offset=100`)).json())
    expect(units.units).toHaveLength(20); expect(units.nextOffset).toBeNull()
    const input = { populationId: population.id, idempotencyKey: 'http-sampling-run', stage: 'final-field', inspectionMode: 'table-1-simple-random' }
    const response = await f.send('/sampling-runs', 'POST', input)
    expect(response.status).toBe(201)
    const run = C.SurveySamplingRunSummaryV1.parse(await response.json())
    expect(run).toMatchObject({ sampleSize: 11, unitCount: 120, randomSource: 'runtime-generated-local-unwitnessed', decision: 'not-evaluated' })
    const samples = C.SurveySamplingSamplePageV1.parse(await (await f.send(`/sampling-runs/${run.id}/samples?limit=5`)).json())
    expect(samples.samples).toHaveLength(5); expect(samples.nextOffset).toBe(5)
    expect(await (await f.send('/sampling-runs', 'POST', input)).json()).toEqual(run)
    expect((await f.send('/sampling-runs', 'POST', { ...input, idempotencyKey: 'attempted-http-reroll' })).status).toBe(409)
    const db = f.db()
    try { expect(db.prepare('SELECT count(*) AS count FROM sampling_runs').get()).toEqual({ count: 1 }) }
    finally { db.close() }
    f.restart()
    expect(await (await f.send(`/sampling-runs/${run.id}`)).json()).toEqual(run)
    expect(await (await f.send(`/sampling-runs/${run.id}/samples?limit=5`)).json()).toEqual(samples)
    const verification = C.SurveySamplingVerificationV1.parse(await (await f.send(`/sampling-runs/${run.id}/verify`, 'POST', {})).json())
    expect(verification).toMatchObject({ recomputed: true, planHash: run.planHash, runHash: run.runHash, recordIntegrity: 'verified', standardConformity: 'not-evaluated' })
    expect(C.SurveySamplingPopulationListV1.parse(await (await f.send('/sampling-populations')).json()).populations).toHaveLength(1)
    expect(C.SurveySamplingRunListV1.parse(await (await f.send('/sampling-runs')).json()).runs).toEqual([run])
  })

  it('authenticates all nine route forms before service resolution or oversized body parsing', async () => {
    const f = await fixture(), create = vi.spyOn(f.service, 'createPopulation')
    for (const [method, path] of [['POST', '/sampling-populations'], ['GET', '/sampling-populations'], ['GET', '/sampling-populations/unknown'],
      ['GET', '/sampling-populations/unknown/units'], ['POST', '/sampling-runs'], ['GET', '/sampling-runs'], ['GET', '/sampling-runs/unknown'],
      ['GET', '/sampling-runs/unknown/samples'], ['POST', '/sampling-runs/unknown/verify']]) {
      expect((await f.send(path!, method!, method === 'POST' ? {} : undefined, false)).status).toBe(401)
    }
    expect((await f.raw('/sampling-populations', 'POST', ' '.repeat(C.SURVEY_SAMPLING_WORKSPACE_LIMITS.requestBytes + 1), false)).status).toBe(401)
    expect(create).not.toHaveBeenCalled()
    f.h.runtime.surveySamplingWorkspaceService = undefined
    expect((await f.send('/sampling-populations', 'POST', f.request, false)).status).toBe(401)
    expect((await f.send('/sampling-populations', 'POST', f.request)).status).toBe(503)
  })

  it('enforces the raw 1 MiB limit including whitespace, and rejects invalid UTF-8 before persistence', async () => {
    const f = await fixture(), limit = C.SURVEY_SAMPLING_WORKSPACE_LIMITS.requestBytes
    const serialized = JSON.stringify(f.request), bytes = Buffer.byteLength(serialized)
    const exactRaw = ' '.repeat(limit - bytes) + serialized
    expect((await f.raw('/sampling-populations', 'POST', ' ' + exactRaw)).status).toBe(413)
    const invalidUtf8 = new Uint8Array(Buffer.concat([Buffer.from('{"definitionStatement":"'), Buffer.from([0xff]), Buffer.from('"}')])).buffer
    expect((await f.raw('/sampling-populations', 'POST', invalidUtf8)).status).toBe(400)
    const db = f.db()
    try { expect(db.prepare('SELECT count(*) AS count FROM sampling_populations').get()).toEqual({ count: 0 }) }
    finally { db.close() }
    expect((await f.raw('/sampling-populations', 'POST', exactRaw)).status).toBe(201)
  })

  it('rejects field and query injection, missing freeze references and cross-project paths', async () => {
    const f = await fixture()
    for (const injection of [{ definitionEvidenceSha256: '0'.repeat(64) }, { populationHash: '0'.repeat(64) }, { actor: 'professional' }]) {
      expect((await f.send('/sampling-populations', 'POST', { ...f.request, ...injection })).status).toBe(400)
    }
    const population = C.SurveySamplingPopulationDetailV1.parse(await (await f.send('/sampling-populations', 'POST', f.request)).json())
    const input = { populationId: population.id, idempotencyKey: 'injection-run-key', stage: 'final-field', inspectionMode: 'table-1-simple-random' }
    for (const injection of [{ seedHex: '1'.repeat(64) }, { randomSource: {} }, { round: 1 }, { actor: { id: 'human', kind: 'human' } }, { decision: 'passed' }]) {
      expect((await f.send('/sampling-runs', 'POST', { ...input, ...injection })).status).toBe(400)
    }
    expect((await f.send('/sampling-runs', 'POST', { ...input, populationId: 'unfrozen-population' })).status).toBe(404)
    for (const stage of ['process', 'final-office']) expect((await f.send('/sampling-runs', 'POST', { ...input, stage })).status).toBe(400)
    const run = C.SurveySamplingRunSummaryV1.parse(await (await f.send('/sampling-runs', 'POST', input)).json())
    for (const query of ['limit=1e1', 'offset=', 'limit=1&limit=2', 'projectId=other-project', 'limit=0', 'limit=101', 'offset=-1', 'offset=10001', 'limit=01']) {
      for (const path of ['/sampling-populations', '/sampling-runs', `/sampling-populations/${population.id}/units`, `/sampling-runs/${run.id}/samples`]) {
        expect((await f.send(`${path}?${query}`)).status).toBe(400)
      }
    }
    for (const path of [`/sampling-populations/${population.id}`, `/sampling-runs/${run.id}`]) expect((await f.send(`${path}?limit=1`)).status).toBe(400)
    for (const [path, body] of [['/sampling-populations', f.request], ['/sampling-runs', input], [`/sampling-runs/${run.id}/verify`, {}]] as const) {
      expect((await f.send(`${path}?offset=0`, 'POST', body)).status).toBe(400)
    }
    expect((await f.send(`/sampling-runs/${run.id}/verify`, 'POST', { planHash: run.planHash })).status).toBe(400)
    for (const path of [`/sampling-populations/${population.id}`, `/sampling-populations/${population.id}/units`, `/sampling-runs/${run.id}`, `/sampling-runs/${run.id}/samples`]) {
      const response = await dispatchRequest(f.h.router, new Request((f.base + path).replace(f.project.id, 'other-project'), { headers: f.headers }))
      expect(response.status).toBe(404); expect(await response.text()).not.toContain(f.request.definitionStatement)
    }
  })

  it('returns sanitized integrity failures after persisted bytes change and retains unavailable history', async () => {
    const f = await fixture(), population = C.SurveySamplingPopulationDetailV1.parse(await (await f.send('/sampling-populations', 'POST', f.request)).json())
    const run = C.SurveySamplingRunSummaryV1.parse(await (await f.send('/sampling-runs', 'POST', { populationId: population.id,
      idempotencyKey: 'corruption-run-key', stage: 'acceptance', inspectionMode: 'census' })).json())
    const db = f.db()
    try { db.exec("DROP TRIGGER sampling_runs_no_update; UPDATE sampling_runs SET data_json='invalid stored JSON'") }
    finally { db.close() }
    const failed = await f.send(`/sampling-runs/${run.id}/verify`, 'POST', {})
    expect(failed.status).toBe(409); expect(failed.headers.get('cache-control')).toBe('no-store')
    const text = await failed.text()
    expect(text).not.toContain(f.root); expect(text).not.toContain('invalid stored JSON')
    expect(JSON.parse(text).code).toBe('sampling_workspace_integrity')
    expect(await (await f.send('/sampling-runs')).json()).toEqual({ runs: [], unavailable: [{ id: run.id, reason: 'integrity' }], nextOffset: null })
    expect((await f.send(`/sampling-populations/${population.id}`)).status).toBe(200)
  })
})
