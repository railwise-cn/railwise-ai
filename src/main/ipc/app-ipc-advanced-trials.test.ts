import { describe, expect, it } from 'vitest'
import { runtimeRequestPayloadSchema } from './app-ipc-schemas'
import { advancedTrialTestRequest } from '../../../kun/src/engineering/survey-advanced-trials-test-helpers'

const base = '/v1/engineering/projects/project-1/advanced-trials'
const declaration = {
  schemaVersion: 1, model: 'fixed-linear-independent-disjoint-variance-groups', unit: 'mm', parameterIds: ['mean'],
  groups: [{ id: 'g', initialVariance: 1, sourceAnchor: 'synthetic' }],
  observations: [0, 1, 2].map((value, i) => ({ id: `o${i}`, value, coefficients: [1], groupId: 'g', relativeVariance: 1, sourceAnchor: 'synthetic' })),
  maxIterations: 10, relativeTolerance: 1e-10
}
const create = { kind: 'vce', acknowledged: true, expectedProjectRevision: 1, idempotencyKey: 'test-create-1', declarationJson: JSON.stringify(declaration), modelBasisStatement: '独立合成模型，非工程签认。' }

describe('advanced trial strict desktop IPC', () => {
  it('allows only bounded create, history, restore, reverify and export requests', () => {
    for (const payload of [
      { path: base, method: 'POST', body: JSON.stringify(create) },
      { path: `${base}?limit=10&offset=128` }, { path: `${base}/trial-1` }, { path: `${base}/trial-1/export` },
      { path: `${base}/trial-1/reverify`, method: 'POST', body: '{}' }
    ]) expect(runtimeRequestPayloadSchema.safeParse(payload).success).toBe(true)
  })
  it.each(['huber', 'statistical-family', 'reference-datum', 'static-incremental'] as const)('validates %s exact declarations and refuses cross-kind or inferred fields', kind => {
    const request = advancedTrialTestRequest(kind)
    const parse = (value: unknown) => runtimeRequestPayloadSchema.safeParse({ path: base, method: 'POST', body: JSON.stringify(value) }).success
    expect(parse(request)).toBe(true)
    expect(parse({ ...request, kind: kind === 'huber' ? 'statistical-family' : 'huber' })).toBe(false)
    expect(parse({ ...request, declarationJson: JSON.stringify({ ...JSON.parse(request.declarationJson), approve: true }) })).toBe(false)
    expect(parse({ ...request, acknowledged: false })).toBe(false)
  })
  it('rejects ambiguous or unbounded JSON and unknown model/approval fields before Runtime', () => {
    const bodies = [
      { ...create, acknowledged: false }, { ...create, kind: 'generalized-w' }, { ...create, manifestId: 'inferred' },
      { ...create, modelBasisStatement: '\ud800' }, { ...create, modelBasisStatement: ' ' },
      { ...create, declarationJson: JSON.stringify({ ...declaration, approve: true }) },
      { ...create, declarationJson: create.declarationJson.replace('"schemaVersion":1', '"schemaVersion":1,"\\u0073chemaVersion":1') },
      { ...create, declarationJson: '['.repeat(33) + '0' + ']'.repeat(33) },
      { ...create, declarationJson: '中'.repeat(100_000) },
      { ...create, declarationJson: JSON.stringify({ ...declaration, observations: [{ ...declaration.observations[0], value: null }] }) }
    ].map(value => JSON.stringify(value))
    bodies.push(' '.repeat(512 * 1024) + JSON.stringify(create), JSON.stringify(create).replace('"acknowledged":true', '"acknowledged":false,"acknowledged":true'))
    for (const body of bodies) expect(runtimeRequestPayloadSchema.safeParse({ path: base, method: 'POST', body }).success).toBe(false)
  })
  it('rejects method, query, body and traversal confusion', () => {
    for (const payload of [
      { path: base, method: 'DELETE' }, { path: `${base}/trial-1`, method: 'POST', body: JSON.stringify(create) },
      { path: `${base}/trial-1`, body: '{}' }, { path: `${base}/trial-1?limit=1` },
      { path: `${base}/trial-1/reverify`, method: 'POST', body: '{"approved":true}' },
      { path: `${base}/trial-1/reverify?offset=0`, method: 'POST', body: '{}' },
      { path: `${base}?limit=1`, method: 'POST', body: JSON.stringify(create) },
      { path: `${base}/trial-1/export`, method: 'POST', body: '{}' },
      ...['limit=11', 'limit=01', 'limit=0', 'offset=129', 'offset=-1', 'offset=01', 'limit=1&limit=2', 'seed=x'].map(query => ({ path: `${base}?${query}` }))
    ]) expect(runtimeRequestPayloadSchema.safeParse(payload).success).toBe(false)
  })
})
