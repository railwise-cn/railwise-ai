import { describe, expect, it } from 'vitest'
import { runtimeRequestPayloadSchema } from './app-ipc-schemas'
import { RUNTIME_STANDARD_BASIS_PATH, runtimeStandardBasisPath } from '../../shared/survey-standard-basis'

const reference = { standardCode: 'GB/T 24356-2023', standardVersion: '2023', ruleId: 'gbt24356-2023.scoring.unit', ruleVersion: '1',
  sourceSha256: 'a'.repeat(64), algorithmVersion: 'gbt24356-declared-exact-quality-scoring-1', profileId: 'planar-control-point', profileVersion: 'gbt24356-2023-control-declared-counts-1' }
const path = runtimeStandardBasisPath(reference)
const valid = (payload: unknown): boolean => runtimeRequestPayloadSchema.safeParse(payload).success

describe('read-only standard basis IPC', () => {
  it('allows catalog and complete exact identity reads only', () => {
    expect(valid({ path: RUNTIME_STANDARD_BASIS_PATH })).toBe(true)
    expect(valid({ path, method: 'GET' })).toBe(true)
  })
  it('rejects writes, bodies, unknown/duplicate/missing identity and malformed paths', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(valid({ path, method })).toBe(false)
    for (const candidate of [
      `${RUNTIME_STANDARD_BASIS_PATH}?latest=true`, `${RUNTIME_STANDARD_BASIS_PATH}/x`, `${RUNTIME_STANDARD_BASIS_PATH}/x/1`,
      `${path}&sourceSha256=${reference.sourceSha256}`, `${path}&approve=true`, `${path}#ignored`,
      path.replace(/&sourceSha256=[^&]+/, ''), path.replace(reference.sourceSha256, 'a'.repeat(63)),
      path.replace('/1?', '/%2f?'), path.replace('/1?', '/x/y?')
    ]) expect(valid({ path: candidate }), candidate).toBe(false)
    expect(valid({ path, body: '{}' })).toBe(false)
    expect(valid({ path: RUNTIME_STANDARD_BASIS_PATH, body: '' })).toBe(false)
  })
})
