import { describe, expect, it, vi } from 'vitest'
import type { EngineeringContextSnapshotV1 } from '../../contracts/engineering-ai.js'
import { createSurveyContextReader, type SurveyContextReadDependencies } from './survey-context-reader.js'

function fixture(): EngineeringContextSnapshotV1 {
  return {
    schemaVersion: 1, projectId: 'project-a', projectRevision: 3,
    contextHash: 'sha256-current', generatedAt: '2026-09-19T00:00:00Z',
    project: { name: 'PRIVATE_NAME', monitoringType: 'survey', unit: 'm', reportPeriod: {}, thresholds: {} },
    datasets: [], analyses: [], runs: [], citations: [], watchDrafts: [],
    surveyNetworks: [{ id: 'network-a', revision: 2, networkType: 'leveling', coordinateSystem: 'PRIVATE_CRS', verticalDatum: 'PRIVATE_DATUM', pointCount: 3, observationCount: 4, qualityStatus: 'valid' }],
    surveyAdjustments: [{ id: 'adjustment-a', networkId: 'network-a', revision: 1, status: 'completed', algorithmVersion: 'test-1', inputHash: 'sha256-input', sourceAdmission: {
      status: 'current-admissible', rawSourceIntegrity: { status: 'verified', ledgerEntryCount: 1, errors: ['PRIVATE_ERROR_PATH'] }, sourceEligibility: { eligible: true, findings: [{ code: 'private', severity: 'info', message: 'PRIVATE_FINDING' }] }
    } }]
  }
}

describe('Survey context read boundary', () => {
  it('requires a literal boolean grant and redacts authorization failures', () => {
    const snapshot = vi.fn(fixture)
    for (const grant of ['false', {}, Promise.resolve(false), 1, null, undefined]) {
      const canReadProject = (() => grant) as unknown as SurveyContextReadDependencies['canReadProject']
      expect(() => createSurveyContextReader({ canReadProject, snapshot })({ projectId: 'project-a' })).toThrow('access_denied')
    }
    expect(snapshot).not.toHaveBeenCalled()
    const read = createSurveyContextReader({ canReadProject: () => { throw new Error('PRIVATE_AUTH_SECRET') }, snapshot })
    expect(() => read({ projectId: 'project-a' })).toThrow(/^survey_context_unavailable$/)
  })

  it('rejects malformed projected metadata before serializing private objects', () => {
    const toJSON = vi.fn(() => 'PRIVATE_CREDENTIAL')
    for (const patch of [{ id: { toJSON } }, { pointCount: NaN }, { observationCount: -1 }, { revision: 0 }]) {
      const source = fixture()
      Object.assign(source.surveyNetworks[0]!, patch)
      const read = createSurveyContextReader({ canReadProject: () => true, snapshot: () => source })
      expect(() => read({ projectId: 'project-a' })).toThrow(/^survey_context_unavailable$/)
    }
    expect(toJSON).not.toHaveBeenCalled()
  })

  it('denies unauthorized access before touching project storage and honors revocation on each request', () => {
    let allowed = false
    const snapshot = vi.fn(fixture)
    const read = createSurveyContextReader({ canReadProject: () => allowed, snapshot })
    expect(() => read({ projectId: 'project-a' })).toThrow('access_denied')
    expect(snapshot).not.toHaveBeenCalled()
    allowed = true
    expect(read({ projectId: 'project-a' }).projectId).toBe('project-a')
    allowed = false
    expect(() => read({ projectId: 'project-a' })).toThrow('access_denied')
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  it('does not accept client-granted scope, write operations, arbitrary selectors or missing scope', () => {
    const snapshot = vi.fn(fixture)
    const read = createSurveyContextReader({ canReadProject: () => true, snapshot })
    for (const input of [{}, { projectId: 'project-a', allowedProjects: ['project-a'] }, { projectId: 'project-a', operation: 'archive' }, { projectId: 'project-a', path: '/private/file' }]) {
      expect(() => read(input)).toThrow('invalid_request')
    }
    expect(snapshot).not.toHaveBeenCalled()
  })

  it('rejects a cross-project response, a stale revision or changed context', () => {
    const read = createSurveyContextReader({ canReadProject: () => true, snapshot: fixture })
    expect(() => read({ projectId: 'project-b' })).toThrow('project_mismatch')
    expect(() => read({ projectId: 'project-a', expectedProjectRevision: 2 })).toThrow('stale')
    expect(() => read({ projectId: 'project-a', expectedContextHash: 'old' })).toThrow('stale')
    expect(read({ projectId: 'project-a', expectedProjectRevision: 3, expectedContextHash: 'sha256-current' }).access).toBe('read-only-summary')
  })

  it('projects explicit metadata and never exposes source records, private text or future internal fields', () => {
    const source = { ...fixture(), futureSecret: 'PRIVATE_FUTURE', workspace: '/PRIVATE_PATH' }
    Object.assign(source.surveyNetworks[0]!, { observations: [{ value: 'PRIVATE_OBSERVATION' }], path: '/PRIVATE_PATH' })
    const before = JSON.stringify(source)
    const read = createSurveyContextReader({ canReadProject: () => true, snapshot: () => source })
    const result = read({ projectId: 'project-a' })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(result.verification).toBe('context-metadata-only')
    expect(result.untrusted).toBe(true)
    expect(JSON.stringify(source)).toBe(before)
  })

  it('does not promote old admissibility after source integrity fails', () => {
    const source = fixture()
    source.surveyAdjustments[0]!.sourceAdmission.rawSourceIntegrity.status = 'failed'
    const read = createSurveyContextReader({ canReadProject: () => true, snapshot: () => source })
    expect(read({ projectId: 'project-a' }).adjustments[0]!.sourceAdmission.status).toBe('historical-non-admissible')
  })

  it('fails closed on revocation during reading and hides storage error details', () => {
    let allowed = true
    const read = createSurveyContextReader({ canReadProject: () => allowed, snapshot: () => { allowed = false; return fixture() } })
    expect(() => read({ projectId: 'project-a' })).toThrow('access_denied')
    const failed = createSurveyContextReader({ canReadProject: () => true, snapshot: () => { throw new Error('/private/project/secret.sqlite3') } })
    expect(() => failed({ projectId: 'project-a' })).toThrow(/^survey_context_unavailable$/)
  })

  it('bounds collections without claiming a complete inventory and rejects oversized summaries', () => {
    const source = fixture()
    source.surveyNetworks = Array.from({ length: 30 }, (_, i) => ({ ...source.surveyNetworks[0]!, id: `network-${i}` }))
    const read = createSurveyContextReader({ canReadProject: () => true, snapshot: () => source })
    expect(read({ projectId: 'project-a' }).networks).toHaveLength(20)
    expect(read({ projectId: 'project-a' }).coverage).toBe('bounded-snapshot-not-project-inventory')
    source.surveyNetworks[0]!.id = 'a'.repeat(70 * 1024)
    expect(() => read({ projectId: 'project-a' })).toThrow('response_too_large')
  })
})
