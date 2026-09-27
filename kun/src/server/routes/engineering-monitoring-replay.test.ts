import { expect, it, vi } from 'vitest'
import type { EngineeringService } from '../../engineering/engineering-service.js'
import { replayMonitoringDeliverable } from './engineering.js'
import { buildRouter } from './index.js'
import { startNodeHttpServer } from '../node-http-server.js'
import type { ServerRuntime } from './server-runtime.js'

const result = { schemaVersion: 1, attemptId: 'monitoring_replay_test', projectId: 'project', manifestId: 'manifest', checkedAt: '2026-09-21T00:00:00Z', status: 'not-applicable', reasonCode: 'no-monitoring-analysis', comparisonVersion: 'monitoring-results-exact-1', execution: { runtimeVersion: 'test', node: '22', v8: 'test', icu: 'test', platform: 'test', arch: 'test', timezone: 'UTC', locale: 'en-US', timeBasis: 'ISO-unzoned-UTC' }, analyses: [] }
const request = (body?: string, query = '') => new Request(`http://localhost/v1/engineering/projects/project/manifests/manifest/monitoring-replay${query}`, { method: 'POST', ...(body === undefined ? {} : { body }) })
it.each([undefined, '{}'])('accepts an empty request and returns uncached scoped evidence (%s)', async body => {
  const replay = vi.fn().mockResolvedValue(result)
  const response = await replayMonitoringDeliverable({ replayMonitoringDeliverable: replay } as unknown as EngineeringService, request(body), 'project', 'manifest')
  expect(response.status).toBe(200)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(JSON.parse(response.body)).toEqual({ replay: result })
  expect(replay).toHaveBeenCalledExactlyOnceWith('project', 'manifest')
})
it.each(['null', '[]', '{"force":true}', 'invalid', '"text"'])('rejects nonempty or invalid bodies %s without starting an audit', async body => {
  const replay = vi.fn()
  const response = await replayMonitoringDeliverable({ replayMonitoringDeliverable: replay } as unknown as EngineeringService, request(body), 'project', 'manifest')
  expect(response.status).toBe(400)
  expect(replay).not.toHaveBeenCalled()
})
it('rejects query parameters and oversized bodies before invoking the service', async () => {
  const replay = vi.fn()
  const service = { replayMonitoringDeliverable: replay } as unknown as EngineeringService
  expect((await replayMonitoringDeliverable(service, request('{}', '?force=true'), 'project', 'manifest')).status).toBe(400)
  expect((await replayMonitoringDeliverable(service, request(' '.repeat(1025)), 'project', 'manifest')).status).toBe(413)
  expect(replay).not.toHaveBeenCalled()
})
it('does not claim success when evidence cannot be persisted or the contract is invalid', async () => {
  expect((await replayMonitoringDeliverable(undefined, request(), 'project', 'manifest')).status).toBe(503)
  for (const replay of [vi.fn().mockRejectedValue(new Error('/private/path secret')), vi.fn().mockResolvedValue({ ...result, status: 'passed' })]) {
    const response = await replayMonitoringDeliverable({ replayMonitoringDeliverable: replay } as unknown as EngineeringService, request(), 'project', 'manifest')
    expect(response.status).toBe(503)
    expect(response.body).not.toContain('/private/path')
  }
})

it('enforces the real registered HTTP route bearer gate before replay and admits the authenticated request', async () => {
  const replay = vi.fn().mockResolvedValue(result)
  const router = buildRouter({ runtimeToken: 'local-replay-test-token', insecure: false, engineeringService: { replayMonitoringDeliverable: replay } } as unknown as ServerRuntime)
  const server = await startNodeHttpServer({ router, host: '127.0.0.1', port: 0 })
  try {
    const url = `http://127.0.0.1:${server.port}/v1/engineering/projects/project/manifests/manifest/monitoring-replay`
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }]) {
      const response = await fetch(url, { method: 'POST', headers, body: '{}' })
      expect(response.status).toBe(401)
      await response.text()
    }
    expect(replay).not.toHaveBeenCalled()
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer local-replay-test-token' }, body: '{}' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ replay: result })
    expect(replay).toHaveBeenCalledExactlyOnceWith('project', 'manifest')
  } finally { await server.close() }
})
