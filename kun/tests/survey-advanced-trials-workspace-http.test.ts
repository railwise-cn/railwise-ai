import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineeringService } from '../src/engineering/engineering-service.js'
import { SurveyAdvancedTrialsWorkspaceService } from '../src/engineering/survey-advanced-trials-workspace.js'
import { advancedTrialTestRequest, maximumNewAdvancedTrialRequest } from '../src/engineering/survey-advanced-trials-test-helpers.js'
import * as C from '../src/contracts/survey-advanced-trials-workspace.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { buildHarness } from './http-server-test-harness.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const f of cleanup.splice(0)) await f() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'advanced-trials-http-')), data = join(root, 'runtime')
  const engineering = new EngineeringService({ rootDir: data })
  const services = [new SurveyAdvancedTrialsWorkspaceService({ rootDir: data, getProject: id => engineering.getProject(id) })]
  cleanup.push(async () => { services.forEach(s => s.close()); await engineering.flush(); engineering.close(); await rm(root, { recursive: true, force: true }) })
  const project = engineering.createProject({ name: '高级测量声明试算', workspace: join(root, 'workspace'), expectedRevision: 0, idempotencyKey: 'advanced-http-project' })
  const h = buildHarness(); h.runtime.surveyAdvancedTrialsWorkspaceService = services[0]!
  const headers = { authorization: 'Bearer tok-1', 'content-type': 'application/json' }
  const base = `http://localhost/v1/engineering/projects/${project.id}/advanced-trials`
  const raw = (path: string, method = 'GET', body?: string | ArrayBuffer, auth = true) => dispatchRequest(h.router, new Request(base + path, {
    method, headers: auth ? headers : {}, ...(body === undefined ? {} : { body })
  }))
  const send = (path: string, method = 'GET', body?: unknown, auth = true) => raw(path, method, body === undefined ? undefined : JSON.stringify(body), auth)
  return { root, data, project, engineering, service: services[0]!, h, headers, base, raw, send }
}

describe('authenticated advanced trials HTTP', () => {
  it.each(['generalized-w','vce','huber','statistical-family','reference-datum', 'static-incremental'] as const)('creates, restores, reverifies and exports %s with explicit declarations', async kind => {
    const f = await fixture(), input = advancedTrialTestRequest(kind)
    const raw = `\n  ${JSON.stringify(input)}\n`
    const response = await f.raw('', 'POST', raw)
    expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store')
    const summary = C.SurveyAdvancedTrialSummaryV1.parse(await response.json())
    expect(summary).not.toHaveProperty('result')
    const detailResponse = await f.send(`/${summary.id}`)
    const record = C.SurveyAdvancedTrialRecordV1.parse(await detailResponse.json())
    expect(record.requestJson).toBe(raw)
    expect(record.declarationJson).toBe(input.declarationJson)
    expect(record.modelBasisStatement).toBe(input.modelBasisStatement)
    expect(C.SurveyAdvancedTrialListV1.parse(await (await f.send('?limit=1')).json())).toEqual({ trials: [summary], unavailable: [], nextOffset: null })
    expect(C.SurveyAdvancedTrialVerificationV1.parse(await (await f.send(`/${summary.id}/reverify`, 'POST', {})).json())).toMatchObject({ recordHash: record.recordHash, recomputed: true })
    const exported = await f.send(`/${summary.id}/export`)
    expect(exported.headers.get('content-disposition')).toContain('attachment')
    expect(await exported.json()).toEqual(record)
    expect(f.engineering.getProject(f.project.id)).toEqual(f.project)
  })
  it('authenticates every operation before service/body parsing', async () => {
    const f = await fixture(), spy = vi.spyOn(f.service, 'createTrial')
    for (const [path, method] of [['','POST'],['','GET'],['/unknown','GET'],['/unknown/reverify','POST'],['/unknown/export','GET']]) {
      expect((await f.send(path!, method!, method === 'POST' ? {} : undefined, false)).status).toBe(401)
    }
    expect((await f.raw('', 'POST', ' '.repeat(C.SURVEY_ADVANCED_TRIAL_LIMITS.requestBytes + 1), false)).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
    f.h.runtime.surveyAdvancedTrialsWorkspaceService = undefined
    expect((await f.send('', 'POST', {}, false)).status).toBe(401)
    expect((await f.send('', 'POST', {})).status).toBe(503)
  })
  it('enforces actual raw bytes including whitespace and fatal UTF-8 decoding', async () => {
    const f = await fixture(), input = JSON.stringify(advancedTrialTestRequest('vce'))
    const maximum = ' '.repeat(C.SURVEY_ADVANCED_TRIAL_LIMITS.requestBytes - Buffer.byteLength(input)) + input
    expect((await f.raw('', 'POST', maximum + ' ')).status).toBe(413)
    expect((await f.raw('', 'POST', new Uint8Array([0xff]).buffer)).status).toBe(400)
    expect((await f.raw('', 'POST', '\ufeff' + input)).status).toBe(400)
    const created = await f.raw('', 'POST', maximum)
    expect(created.status).toBe(201)
    const summary = C.SurveyAdvancedTrialSummaryV1.parse(await created.json())
    expect(summary.requestSizeBytes).toBe(C.SURVEY_ADVANCED_TRIAL_LIMITS.requestBytes)
    const record = C.SurveyAdvancedTrialRecordV1.parse(await (await f.send(`/${summary.id}`)).json())
    expect(record.requestJson).toBe(maximum)
  })
  it('rejects absent acknowledgement, duplicate fields, duplicate queries and nonempty reverify', async () => {
    const f = await fixture(), input = advancedTrialTestRequest('vce')
    for (const changes of [{ acknowledged: false }, { acknowledged: undefined }, { verified: true }, { expectedProjectRevision: 0 }]) {
      expect((await f.send('', 'POST', { ...input, ...changes })).status).toBe(400)
    }
    expect((await f.raw('', 'POST', JSON.stringify(input).replace('"acknowledged":true','"acknowledged":false,"acknowledged":true'))).status).toBe(400)
    const created = C.SurveyAdvancedTrialSummaryV1.parse(await (await f.send('', 'POST', input)).json())
    for (const query of ['limit=0','limit=11','limit=01','offset=1e1','offset=129','limit=1&limit=2','kind=vce','offset=']) {
      expect((await f.send(`?${query}`)).status).toBe(400)
    }
    expect((await f.send(`/${created.id}?limit=1`)).status).toBe(400)
    expect((await f.send(`/${created.id}/reverify?limit=1`, 'POST', {})).status).toBe(400)
    expect((await f.send(`/${created.id}/reverify`, 'POST', { acknowledged: true })).status).toBe(400)
    expect((await f.raw(`/${created.id}/reverify`, 'POST', '')).status).toBe(400)
  })
  it('isolates cross-project requests and returns sanitized corruption errors with healthy history', async () => {
    const f = await fixture(), bad = C.SurveyAdvancedTrialSummaryV1.parse(await (await f.send('', 'POST', advancedTrialTestRequest('vce'))).json())
    const good = C.SurveyAdvancedTrialSummaryV1.parse(await (await f.send('', 'POST', advancedTrialTestRequest('generalized-w', 'healthy-model'))).json())
    const other = f.engineering.createProject({ name: '隔离项目', workspace: join(f.root, 'other'), expectedRevision: 0, idempotencyKey: 'other-project-key' })
    for (const path of [`/${bad.id}`, `/${bad.id}/export`, `/${bad.id}/reverify`]) {
      const response = await dispatchRequest(f.h.router, new Request((f.base + path).replace(f.project.id, other.id), {
        method: path.endsWith('reverify') ? 'POST' : 'GET', headers: f.headers, ...(path.endsWith('reverify') ? { body: '{}' } : {})
      }))
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain('模拟数据')
    }
    const db = new Database(join(f.data, 'survey-advanced-trials.sqlite3'))
    try { db.exec('DROP TRIGGER advanced_trials_no_update'); db.prepare('UPDATE advanced_trials SET data_json=? WHERE id=?').run('secret corruption path /private/sensitive', bad.id) }
    finally { db.close() }
    const response = await f.send(`/${bad.id}`)
    expect(response.status).toBe(409); expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).not.toContain('secret')
    const list = C.SurveyAdvancedTrialListV1.parse(await (await f.send('')).json())
    expect(list.trials).toEqual([good]); expect(list.unavailable).toEqual([{ id: bad.id, reason: 'integrity' }])
  })
  it.each(['generalized-w', 'vce'] as const)('exports a maximum-dimension %s model within the explicit response bound', async kind => {
    const f = await fixture(), request = advancedTrialTestRequest(kind)
    const n = kind === 'vce' ? 128 : 64, p = kind === 'vce' ? 32 : 16
    const design = Array.from({ length:n }, (_,i) => Array.from({ length:p }, (_,j) => i % p === j ? 1 : 0))
    const observations = Array.from({ length:n }, (_,i) => i % p * .1 + [1,-1,2,-2][Math.floor(i / p)]!)
    const model = kind === 'vce' ? {
      schemaVersion:1, model:'fixed-linear-independent-disjoint-variance-groups',unit:'mm',parameterIds:Array.from({length:p},(_,i)=>`x${i}`),
      groups:Array.from({length:8},(_,i)=>({id:`g${i}`,initialVariance:1,sourceAnchor:'maximum-size-synthetic'})),
      observations:observations.map((value,i)=>({id:`o${i}`,value,coefficients:design[i],groupId:`g${Math.floor(i/16)}`,relativeVariance:1,sourceAnchor:'maximum-size-synthetic'})),
      maxIterations:100,relativeTolerance:1e-12
    } : {
      ...JSON.parse(request.declarationJson), observationIds: observations.map((_,i)=>`o${i}`), observations, designMatrix:design,
      parameterIds: Array.from({length:p},(_,i)=>`x${i}`), parameterUnits: Array(p).fill('m'),
      covariance:{kind:'known-apriori-absolute-observation-covariance',basisStatement:'Synthetic absolute covariance declaration.',matrix:Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?1:0))},
      biasDirections:observations.map((_,i)=>({id:`b${i}`,coefficients:Array.from({length:n},(_,j)=>i===j?1:0)}))
    }
    request.declarationJson=JSON.stringify(model)
    const created=await f.send('', 'POST', request)
    expect(created.status).toBe(201)
    const summary=C.SurveyAdvancedTrialSummaryV1.parse(await created.json())
    const exported=await f.send(`/${summary.id}/export`)
    expect(exported.status).toBe(200)
    const raw=await exported.text(), record=C.SurveyAdvancedTrialRecordV1.parse(JSON.parse(raw))
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(C.SURVEY_ADVANCED_TRIAL_LIMITS.recordBytes)
    expect(record.observationCount).toBe(n); expect(record.parameterCount).toBe(p)
    if(record.kind==='generalized-w') expect(record.result.modelStatus).toBe('resolved')
    else if(record.kind==='vce') expect(record.result.iterations.length).toBeGreaterThan(1)
    console.info(`advanced-trial-size ${kind}: ${Buffer.byteLength(raw)} bytes; ${record.kind === 'vce' ? record.result.iterations.length : 0} iterations`)
  // CI runs the full suite concurrently on shared Linux CPUs. This is a
  // size/replay correctness probe, not a 15-second performance guarantee.
  }, 60_000)
  it.each(['huber', 'statistical-family'] as const)('exports a real maximum-size %s result within the response bound', async kind => {
    const f = await fixture(), request = maximumNewAdvancedTrialRequest(kind)
    const created = await f.send('', 'POST', request)
    expect(created.status).toBe(201)
    const summary = C.SurveyAdvancedTrialSummaryV1.parse(await created.json())
    const exported = await f.send(`/${summary.id}/export`)
    expect(exported.status).toBe(200)
    const raw = await exported.text(), record = C.SurveyAdvancedTrialRecordV1.parse(JSON.parse(raw))
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(C.SURVEY_ADVANCED_TRIAL_LIMITS.recordBytes)
    if (record.kind === 'huber') {
      expect(record.result.states).toHaveLength(201); expect(record.result.acceptedParameters).toBeNull()
      expect(record.observationCount).toBe(128); expect(record.parameterCount).toBe(16)
    } else if (record.kind === 'statistical-family') {
      expect(record.familyMemberCount).toBe(256); expect(record.observationCount).toBe(0); expect(record.parameterCount).toBe(0)
      expect(record.result.outcome).toBe('evaluated')
      if (record.result.outcome === 'evaluated') expect(record.result.results).toHaveLength(256)
    }
    console.info(`advanced-new-size ${kind}: ${Buffer.byteLength(raw)} bytes`)
  }, 60_000)
  it('returns 429 with a retry header when replay work is exhausted', async () => {
    const f = await fixture()
    const created = C.SurveyAdvancedTrialSummaryV1.parse(await (await f.send('', 'POST', advancedTrialTestRequest('vce'))).json())
    for (let i=0; i<38; i++) expect((await f.send(`/${created.id}`)).status).toBe(200)
    const limited = await f.send(`/${created.id}`)
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60')
  })
})
