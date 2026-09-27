import { describe, expect, it } from 'vitest'
import { runtimeRequestPayloadSchema } from './app-ipc-schemas'
const base = '/v1/engineering/projects/project/quality-workflows'
const source = { planId: 'plan-1', recordId: 'record-1', expectedRetentionHeadHash: '0'.repeat(64) }
const create = { ...source, expectedProjectRevision: 2, idempotencyKey: 'create-key' }
const append = { expectedHeadHash: '0'.repeat(64), idempotencyKey: 'append-key', event: { kind: 'check', checkId: 'check-1', outcome: 'failed', evidence: { ...source, memberId: 'output-1' } } }
describe('declared remediation IPC boundary', () => {
  it('allows only the bounded create/read/list/append contract', () => {
    for (const request of [{ path: base, method: 'POST', body: JSON.stringify(create) }, { path: `${base}?limit=20&offset=20` }, { path: `${base}/workflow-1` }, { path: `${base}/workflow-1/events`, method: 'POST', body: JSON.stringify(append) }]) expect(runtimeRequestPayloadSchema.safeParse(request).success).toBe(true)
  })
  it('rejects approval impersonation, source hashes, raw callers, duplicate keys and unbounded pages', () => {
    for (const request of [
      { path: `${base}/workflow-1/events`, method: 'POST', body: JSON.stringify({ ...append, event: { ...append.event, outcome: 'passed' } }) },
      { path: `${base}/workflow-1/events`, method: 'POST', body: JSON.stringify({ ...append, actor: { kind: 'human', id: 'engineer' } }) },
      { path: `${base}/workflow-1/events`, method: 'POST', body: JSON.stringify({ ...append, event: { ...append.event, evidenceSha256: 'a'.repeat(64) } }) },
      { path: `${base}/workflow-1/events`, method: 'POST', body: JSON.stringify(append).replace('"outcome":"failed"', '"outcome":"not-evaluated","outcome":"failed"') },
      { path: base, method: 'POST', body: ' '.repeat(32768) + JSON.stringify(create) },
      { path: `${base}?limit=21` }, { path: `${base}?offset=129` }, { path: `${base}?limit=20&limit=20` },
      { path: `${base}/workflow-1?offset=0` }, { path: `${base}/workflow-1`, body: '{}' },
      { path: `${base}/workflow-1/events` }, { path: `${base}/workflow-1`, method: 'DELETE' },
      { path: `${base}/workflow-1/approve`, method: 'POST', body: '{}' }
    ]) expect(runtimeRequestPayloadSchema.safeParse(request).success, JSON.stringify(request).slice(0, 200)).toBe(false)
  })
})
