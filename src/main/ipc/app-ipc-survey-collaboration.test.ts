import { describe, expect, it } from 'vitest'
import { runtimeRequestPayloadSchema } from './app-ipc-schemas'

const base = '/v1/engineering/projects/project-1/collaboration-drafts'
const resolve = '/v1/engineering/collaboration-drafts/resolve'
const create = { manifestId: 'manifest-1', expectedProjectRevision: 2, idempotencyKey: 'draft-key-1' }
const revision = { expectedRevision: 1 }
const request = (path: string, value: unknown) => ({ path, method: 'POST', body: JSON.stringify(value) })
const valid = (payload: unknown): boolean => runtimeRequestPayloadSchema.safeParse(payload).success

describe('Survey collaboration desktop IPC boundary', () => {
  it('allows the exact list, detail, create, review, seal and editor selection contracts', () => {
    for (const payload of [
      { path: base }, { path: `${base}/draft-1`, method: 'GET' },
      request(base, create), request(`${base}/draft-1/review`, revision), request(`${base}/draft-1/seal`, revision),
      request(resolve, { workspace: '/tmp/survey', path: 'notes/draft.md' }),
      request(resolve, { workspace: '/tmp/survey', documentId: 'drawing-1' })
    ]) expect(valid(payload), JSON.stringify(payload)).toBe(true)
  })

  it('rejects reads with bodies, query parameters, fragments and unsupported routes or methods', () => {
    for (const payload of [
      { path: base, body: '{}' }, { path: `${base}/draft-1`, body: '' },
      { path: `${base}?limit=30` }, { path: `${base}/draft-1?latest=1` },
      { path: `${base}#ignored` }, { path: `${base}/draft-1#ignored` },
      { path: base, method: 'DELETE' }, { path: `${base}/draft-1`, method: 'POST', body: '{}' },
      { path: `${base}/draft-1/review` }, { path: `${base}/draft-1/seal`, method: 'PUT', body: JSON.stringify(revision) },
      request(`${base}/draft-1/approve`, revision), { path: `${base}/draft-1/export` },
      request('/v1/engineering/projects/project-1/unregistered', create),
      request('/v1/engineering/collaboration-drafts', create), { path: resolve }
    ]) expect(valid(payload), JSON.stringify(payload)).toBe(false)
  })

  it('requires strict revision and source identities for mutations without caller approval claims', () => {
    for (const payload of [
      { path: base, method: 'POST' }, { path: base, method: 'POST', body: '{' },
      request(base, { ...create, manifestId: '' }), request(base, { ...create, manifestId: 'x'.repeat(181) }),
      request(base, { ...create, expectedProjectRevision: 0 }), request(base, { ...create, expectedProjectRevision: 1.5 }),
      request(base, { ...create, idempotencyKey: 'short' }), request(base, { ...create, approved: true }),
      request(`${base}/draft-1/review`, {}), request(`${base}/draft-1/seal`, { expectedRevision: -1 }),
      request(`${base}/draft-1/seal`, { ...revision, professionalSignature: 'signed' }),
      request(`${base}/draft-1/review?force=1`, revision), request(`${base}/draft-1/seal#ignored`, revision),
      { path: base, method: 'POST', body: ' '.repeat(8192) + JSON.stringify(create) },
      { path: `${base}/draft-1/review`, method: 'POST', body: ' '.repeat(8192) + JSON.stringify(revision) }
    ]) expect(valid(payload), JSON.stringify(payload).slice(0, 300)).toBe(false)
  })

  it('bounds editor selection and rejects missing selections and unexpected fields', () => {
    for (const value of [
      { workspace: '/tmp/survey' }, { workspace: '', path: 'notes.md' },
      { workspace: 'x'.repeat(4097), path: 'notes.md' }, { workspace: '/tmp/survey', path: '' },
      { workspace: '/tmp/survey', path: 'x'.repeat(4097) }, { workspace: '/tmp/survey', documentId: '' },
      { workspace: '/tmp/survey', documentId: 'x'.repeat(181) },
      { workspace: '/tmp/survey', path: 'notes.md', latest: true }
    ]) expect(valid(request(resolve, value)), JSON.stringify(value).slice(0, 300)).toBe(false)
    expect(valid(request(`${resolve}?workspace=/tmp/other`, { workspace: '/tmp/survey', path: 'notes.md' }))).toBe(false)
    expect(valid(request(`${resolve}#ignored`, { workspace: '/tmp/survey', path: 'notes.md' }))).toBe(false)
    expect(valid({ path: resolve, method: 'POST', body: ' '.repeat(8192) + JSON.stringify({ workspace: '/tmp/survey', path: 'notes.md' }) })).toBe(false)
  })
})
