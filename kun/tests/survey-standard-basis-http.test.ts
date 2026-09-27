import { describe, expect, it } from 'vitest'
import { dispatchRequest } from '../src/server/http-server.js'
import { buildHarness } from './http-server-test-harness.js'
import { SurveyStandardBasisCatalogV1, SurveyStandardBasisResolvedV1 } from '../src/contracts/survey-standard-basis.js'

describe('authenticated read-only standard basis HTTP', () => {
  const base = 'http://localhost/v1/engineering/standard-basis'
  function fixture() {
    const h = buildHarness()
    const call = (suffix = '', auth = true, method = 'GET') => dispatchRequest(h.router, new Request(base + suffix, {
      method, headers: auth ? { authorization: 'Bearer tok-1' } : {}, ...(method === 'POST' ? { body: '{"approved":true}' } : {})
    }))
    return { h, call }
  }
  it('authenticates before validation and exposes no write routes', async () => {
    const f = fixture()
    for (const suffix of ['', '?latest=true', '/unknown/latest?secret=anything']) {
      const response = await f.call(suffix, false)
      expect(response.status).toBe(401)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(f.h.router.match(method, '/v1/engineering/standard-basis')).toBeUndefined()
  })
  it('serves exact source-bound metadata through the actual Runtime router', async () => {
    const f = fixture(), response = await f.call()
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store')
    const catalog = SurveyStandardBasisCatalogV1.parse(await response.json())
    const { rule } = catalog.rules.find(entry => entry.rule.executor.operation === 'unit')!
    const profile = rule.profiles[1]!
    const query = new URLSearchParams({ standardCode: rule.standardCode, standardVersion: rule.standardVersion,
      sourceSha256: rule.source.sha256, algorithmVersion: rule.executor.algorithmVersion, profileId: profile.profileId, profileVersion: profile.profileVersion })
    const path = `/${rule.ruleId}/${rule.ruleVersion}`
    const detail = await f.call(`${path}?${query}`)
    expect(detail.status).toBe(200); expect(detail.headers.get('cache-control')).toBe('no-store')
    expect(SurveyStandardBasisResolvedV1.parse(await detail.json()).profile.unitProduct).toBe('section')
    for (const changes of [{ sourceSha256: 'f'.repeat(64) }, { algorithmVersion: 'future' }, { profileId: 'unsupported' }, { profileVersion: 'latest' }]) {
      const changed = new URLSearchParams(query); Object.entries(changes).forEach(([key, value]) => changed.set(key, value))
      const failure = await f.call(`${path}?${changed}`)
      expect(failure.status).toBe(409); expect(failure.headers.get('cache-control')).toBe('no-store')
    }
    expect((await f.call(`/${rule.ruleId}/latest?${query}`)).status).toBe(404)
    expect((await f.call(`/unknown/1?${query}`)).status).toBe(404)
    for (const suffix of ['?latest=1', `${path}`, `${path}?${query}&profileId=duplicate`, `${path}?${query}&approved=true`]) expect((await f.call(suffix)).status).toBe(400)
  })
})
