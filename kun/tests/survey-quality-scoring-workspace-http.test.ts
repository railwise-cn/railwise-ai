import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineeringService } from '../src/engineering/engineering-service.js'
import { SurveyQualityScoringWorkspaceService } from '../src/engineering/survey-quality-scoring-workspace.js'
import { qualityScoringTestRequest } from '../src/engineering/survey-quality-scoring-test-helpers.js'
import * as C from '../src/contracts/survey-quality-scoring-workspace.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { buildHarness } from './http-server-test-harness.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const f of cleanup.splice(0)) await f() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'quality-scoring-http-')), data = join(root, 'runtime')
  const engineering = new EngineeringService({ rootDir: data })
  const services = [new SurveyQualityScoringWorkspaceService({ rootDir: data, getProject: id => engineering.getProject(id) })]
  cleanup.push(async () => { services.forEach(s => s.close()); await engineering.flush(); engineering.close(); await rm(root, { recursive: true, force: true }) })
  const project = engineering.createProject({ name: '高级测量声明试算', workspace: join(root, 'workspace'), expectedRevision: 0, idempotencyKey: 'advanced-http-project' })
  const h = buildHarness(); h.runtime.surveyQualityScoringWorkspaceService = services[0]!
  const headers = { authorization: 'Bearer tok-1', 'content-type': 'application/json' }
  const base = `http://localhost/v1/engineering/projects/${project.id}/quality-scoring`
  const raw = (path: string, method = 'GET', body?: string | ArrayBuffer, auth = true) => dispatchRequest(h.router, new Request(base + path, {
    method, headers: auth ? headers : {}, ...(body === undefined ? {} : { body })
  }))
  const send = (path: string, method = 'GET', body?: unknown, auth = true) => raw(path, method, body === undefined ? undefined : JSON.stringify(body), auth)
  return { root, data, project, engineering, service: services[0]!, h, headers, base, raw, send }
}

describe('authenticated advanced trials HTTP', () => {
  it.each(['accuracy','unit'] as const)('creates, restores, reverifies and exports %s with explicit declarations', async kind => {
    const f = await fixture(), input = qualityScoringTestRequest(kind)
    const raw = `\n  ${JSON.stringify(input)}\n`
    const response = await f.raw('', 'POST', raw)
    expect(response.status).toBe(201); expect(response.headers.get('cache-control')).toBe('no-store')
    const summary = C.SurveyQualityScoringSummaryV1.parse(await response.json())
    expect(summary).not.toHaveProperty('result')
    const detailResponse = await f.send(`/${summary.id}`)
    const record = C.SurveyQualityScoringRecordV1.parse(await detailResponse.json())
    expect(record.requestJson).toBe(raw)
    expect(record.declarationJson).toBe(input.declarationJson)
    expect(record.modelBasisStatement).toBe(input.modelBasisStatement)
    expect(C.SurveyQualityScoringListV1.parse(await (await f.send('?limit=1')).json())).toEqual({ records: [summary], unavailable: [], nextOffset: null })
    expect(C.SurveyQualityScoringVerificationV1.parse(await (await f.send(`/${summary.id}/reverify`, 'POST', {})).json())).toMatchObject({ recordHash: record.recordHash, recomputed: true })
    const exported = await f.send(`/${summary.id}/export`)
    expect(exported.headers.get('content-disposition')).toContain('attachment')
    expect(await exported.json()).toEqual(record)
    expect(f.engineering.getProject(f.project.id)).toEqual(f.project)
  })
  it('authenticates every operation before service/body parsing', async () => {
    const f = await fixture(), spy = vi.spyOn(f.service, 'createRecord')
    for (const [path, method] of [['','POST'],['','GET'],['/unknown','GET'],['/unknown/reverify','POST'],['/unknown/export','GET']]) {
      expect((await f.send(path!, method!, method === 'POST' ? {} : undefined, false)).status).toBe(401)
    }
    expect((await f.raw('', 'POST', ' '.repeat(C.SURVEY_QUALITY_SCORING_WORKSPACE_LIMITS.requestBytes + 1), false)).status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
    f.h.runtime.surveyQualityScoringWorkspaceService = undefined
    expect((await f.send('', 'POST', {}, false)).status).toBe(401)
    expect((await f.send('', 'POST', {})).status).toBe(503)
  })
  it('enforces actual raw bytes including whitespace and fatal UTF-8 decoding', async () => {
    const f = await fixture(), input = JSON.stringify(qualityScoringTestRequest('unit'))
    const maximum = ' '.repeat(C.SURVEY_QUALITY_SCORING_WORKSPACE_LIMITS.requestBytes - Buffer.byteLength(input)) + input
    expect((await f.raw('', 'POST', maximum + ' ')).status).toBe(413)
    expect((await f.raw('', 'POST', new Uint8Array([0xff]).buffer)).status).toBe(400)
    expect((await f.raw('', 'POST', '\ufeff' + input)).status).toBe(400)
    const created = await f.raw('', 'POST', maximum)
    expect(created.status).toBe(201)
    const summary = C.SurveyQualityScoringSummaryV1.parse(await created.json())
    expect(summary.requestSizeBytes).toBe(C.SURVEY_QUALITY_SCORING_WORKSPACE_LIMITS.requestBytes)
    const record = C.SurveyQualityScoringRecordV1.parse(await (await f.send(`/${summary.id}`)).json())
    expect(record.requestJson).toBe(maximum)
  })
  it('rejects absent acknowledgement, duplicate fields, duplicate queries and nonempty reverify', async () => {
    const f = await fixture(), input = qualityScoringTestRequest('unit')
    for (const changes of [{ acknowledged: false }, { acknowledged: undefined }, { verified: true }, { expectedProjectRevision: 0 }]) {
      expect((await f.send('', 'POST', { ...input, ...changes })).status).toBe(400)
    }
    expect((await f.raw('', 'POST', JSON.stringify(input).replace('"acknowledged":true','"acknowledged":false,"acknowledged":true'))).status).toBe(400)
    const created = C.SurveyQualityScoringSummaryV1.parse(await (await f.send('', 'POST', input)).json())
    for (const query of ['limit=0','limit=11','limit=01','offset=1e1','offset=129','limit=1&limit=2','kind=vce','offset=']) {
      expect((await f.send(`?${query}`)).status).toBe(400)
    }
    expect((await f.send(`/${created.id}?limit=1`)).status).toBe(400)
    expect((await f.send(`/${created.id}/reverify?limit=1`, 'POST', {})).status).toBe(400)
    expect((await f.send(`/${created.id}/reverify`, 'POST', { acknowledged: true })).status).toBe(400)
    expect((await f.raw(`/${created.id}/reverify`, 'POST', '')).status).toBe(400)
  })
  it('isolates cross-project requests and returns sanitized corruption errors with healthy history', async () => {
    const f = await fixture(), bad = C.SurveyQualityScoringSummaryV1.parse(await (await f.send('', 'POST', qualityScoringTestRequest('unit'))).json())
    const good = C.SurveyQualityScoringSummaryV1.parse(await (await f.send('', 'POST', qualityScoringTestRequest('accuracy', 'healthy-model'))).json())
    const other = f.engineering.createProject({ name: '隔离项目', workspace: join(f.root, 'other'), expectedRevision: 0, idempotencyKey: 'other-project-key' })
    for (const path of [`/${bad.id}`, `/${bad.id}/export`, `/${bad.id}/reverify`]) {
      const response = await dispatchRequest(f.h.router, new Request((f.base + path).replace(f.project.id, other.id), {
        method: path.endsWith('reverify') ? 'POST' : 'GET', headers: f.headers, ...(path.endsWith('reverify') ? { body: '{}' } : {})
      }))
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain('模拟数据')
    }
    const db = new Database(join(f.data, 'survey-quality-scoring.sqlite3'))
    try { db.exec('DROP TRIGGER quality_scoring_records_no_update'); db.prepare('UPDATE quality_scoring_records SET data_json=? WHERE id=?').run('secret corruption path /private/sensitive', bad.id) }
    finally { db.close() }
    const response = await f.send(`/${bad.id}`)
    expect(response.status).toBe(409); expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).not.toContain('secret')
    const list = C.SurveyQualityScoringListV1.parse(await (await f.send('')).json())
    expect(list.records).toEqual([good]); expect(list.unavailable).toEqual([{ id: bad.id, reason: 'integrity' }])
  })
  it('exports the maximum 64-item precision declaration with original bytes', async () => {
    const f = await fixture(), input = qualityScoringTestRequest('accuracy')
    const model = JSON.parse(input.declarationJson)
    model.model.items = Array.from({ length: 64 }, (_, i) => ({ ...model.model.items[0], id: `precision-${i}` }))
    input.declarationJson = JSON.stringify(model)
    const created = await f.send('', 'POST', input)
    expect(created.status).toBe(201)
    const summary = C.SurveyQualityScoringSummaryV1.parse(await created.json())
    const exported = await f.send(`/${summary.id}/export`)
    expect(exported.status).toBe(200)
    const raw = await exported.text(), record = C.SurveyQualityScoringRecordV1.parse(JSON.parse(raw))
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(C.SURVEY_QUALITY_SCORING_WORKSPACE_LIMITS.recordBytes)
    expect(record.result.result.state).toBe('calculated')
    expect(record.declarationJson).toBe(input.declarationJson)
  })
  it('returns 429 with a retry header when replay work is exhausted', async () => {
    const f = await fixture()
    const created = C.SurveyQualityScoringSummaryV1.parse(await (await f.send('', 'POST', qualityScoringTestRequest('unit'))).json())
    let limited = await f.send(`/${created.id}`)
    for (let i = 0; i < 60 && limited.status !== 429; i++) limited = await f.send(`/${created.id}`)
    expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60')
  })
})
