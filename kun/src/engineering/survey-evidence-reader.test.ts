import { describe, expect, it, vi } from 'vitest'
import { SurveyEvidenceReferenceV1 } from '../contracts/survey-evidence-reference.js'
import { getSurveyStandardBasisCatalog } from './survey-standard-basis.js'
import { selectSurveyEvidence, SurveyEvidenceReader, type SurveyEvidenceSources } from './survey-evidence-reader.js'

const hash = 'a'.repeat(64), otherHash = 'b'.repeat(64)
const base = { schemaVersion: 1, projectId: 'project', projectRevision: 1 } as const
const scope = { projectId: 'project', workspace: '/workspace' }
function fixture() {
  const network = { id: 'network', projectId: 'project', revision: 2, sourceFile: { sha256: hash }, unknownPoints: Array.from({ length: 51 }, (_, index) => ({ id: `P${index}`, height: index })) }
  const deps = {
    engineering: { getProject: vi.fn(() => ({ id: 'project', revision: 1, workspace: '/workspace' })),
      readMonitoringDatasetEvidence: vi.fn(() => ({ id: 'dataset', projectId: 'project', revision: 2, sourceFileHash: hash, findings: [{ id: 'finding', status: 'open' }] })),
      readMonitoringAnalysisEvidence: vi.fn(() => ({ id: 'analysis', projectId: 'project', datasetId: 'dataset', inputHash: hash, algorithmVersion: 'v2', results: [{ monitoringItem: 'settlement', point: 'P1', latestValue: 2 }] })),
      readDeliverableVerificationEvidence: vi.fn(() => ({ checks: [{ id: 'files', status: 'passed' }] })),
      readMonitoringReplayEvidence: vi.fn(() => ({ attemptId: 'attempt', status: 'not-evaluated' })) },
    survey: { getNetwork: vi.fn(() => network), getRawSourceIntegrity: vi.fn(() => ({ status: 'verified', ledgerEntryCount: 1, errors: [] })),
      getDeformationForProjectNewUse: vi.fn(() => ({ id: 'comparison', projectId: 'project', inputHash: hash, algorithmVersion: 'v1', referenceAdjustmentId: 'old', currentAdjustmentId: 'new', points: [{ pointId: 'P1', delta: 1 }] })),
      getAdjustmentStatisticalDiagnostics: vi.fn(() => ({ projectId: 'project', networkId: 'network', runId: 'adjustment', inputHash: hash, calculationHash: hash, sourceSha256: hash, diagnosticsVersion: 'leveling-deleted-t-1', status: 'unavailable', reason: 'insufficient-redundancy' })),
      getFreeLevelingTrial: vi.fn(() => ({ id: 'trial', projectId: 'project', recordHash: hash, networkRevision: 2, sourceSha256: hash, output: { points: [{ id: 'P1', height: 2 }] } })) },
    advanced: { getTrial: vi.fn(() => ({ id: 'trial', projectId: 'project', recordHash: hash, result: { rows: [{ observationId: 'obs', value: 7 }] } })) },
    scoring: { getRecord: vi.fn(() => ({ id: 'record', projectId: 'project', recordHash: hash, result: { score: { numerator: '100', denominator: '3' } } })) },
    retention: { getPlan: vi.fn(() => ({ plan: { id: 'plan', projectId: 'project', manifestHash: hash, artifactHash: hash }, artifact: { members: [{ id: 'member', sha256: hash }] } })),
      getRecord: vi.fn(() => ({ record: { id: 'record', projectId: 'project', planHash: hash }, verification: { headHash: hash, checks: [{ checkId: 'check', status: 'passed' }] } })) },
    sampling: { getPopulation: vi.fn(() => ({ id: 'population', projectId: 'project', populationHash: hash })), getRun: vi.fn(() => ({ id: 'run', projectId: 'project', runHash: hash, planHash: hash })),
      listUnits: vi.fn(() => ({ populationHash: hash, units: [{ index: 200, unitProductId: 'unit-200' }] })), listSamples: vi.fn(() => ({ planHash: hash, samples: [{ index: 200, batchIndex: 2, unitProductId: 'unit-200' }] })) },
    assessment: { getPlan: vi.fn(() => ({ id: 'plan', projectId: 'project', planHash: hash })), getAssessment: vi.fn(() => ({ id: 'record', projectId: 'project', recordHash: hash, result: { unitRows: [{ unitId: 'unit', fullProfileResult: false }] } })) }
  }
  return { deps, reader: new SurveyEvidenceReader(deps as unknown as SurveyEvidenceSources) }
}
const networkBinding = { networkId: 'network', networkRevision: 2, sourceSha256: hash }
const examples = [
  { kind: 'network', ...networkBinding, selector: { path: ['unknownPoints', 50], identity: { id: 'P50' } } },
  { kind: 'deformation', comparisonId: 'comparison', inputHash: hash, algorithmVersion: 'v1', referenceAdjustmentId: 'old', currentAdjustmentId: 'new' },
  { kind: 'statistics', ...networkBinding, adjustmentId: 'adjustment', inputHash: hash, calculationHash: hash, diagnosticsVersion: 'leveling-deleted-t-1' },
  { kind: 'free-leveling', ...networkBinding, trialId: 'trial', recordHash: hash },
  { kind: 'advanced-trial', trialId: 'trial', recordHash: hash },
  { kind: 'scoring', recordId: 'record', recordHash: hash },
  { kind: 'sampling-population', populationId: 'population', populationHash: hash, unitIndex: 200, unitId: 'unit-200' },
  { kind: 'sampling-run', runId: 'run', runHash: hash, planHash: hash, sampleIndex: 200, unitId: 'unit-200' },
  { kind: 'retention-plan', planId: 'plan', manifestHash: hash, artifactHash: hash },
  { kind: 'retention-record', recordId: 'record', planHash: hash, headHash: hash },
  { kind: 'assessment-plan', planId: 'plan', planHash: hash },
  { kind: 'assessment', recordId: 'record', recordHash: hash },
  { kind: 'monitoring-dataset', datasetId: 'dataset', datasetRevision: 2, sourceFileHash: hash },
  { kind: 'monitoring-analysis', analysisId: 'analysis', datasetId: 'dataset', inputHash: hash, algorithmVersion: 'v2', selector: { path: ['results', 0], identity: { monitoringItem: 'settlement', point: 'P1' } } },
  { kind: 'deliverable-verification', manifestId: 'manifest', checkedAt: '2026-09-21T00:00:00Z' },
  { kind: 'monitoring-replay', manifestId: 'manifest', attemptId: 'attempt', checkedAt: '2026-09-21T00:00:00Z' }
]

describe('exact read-only Survey evidence', () => {
  it.each(examples)('resolves $kind through its designated strict getter', example => {
    const { reader } = fixture()
    expect(reader.read({ ...base, ...example }, scope)).toMatchObject({ status: 'resolved', boundaries: { readOnly: true, approvalCapability: 'none', callerDeclarationsAuthenticated: false } })
  })
  it('reads rows beyond the first page and validates exact sampled unit identity', () => {
    const { reader, deps } = fixture()
    expect(reader.read({ ...base, ...examples[0] }, scope)).toMatchObject({ value: { id: 'P50', height: 50 } })
    expect(reader.read({ ...base, ...examples[7] }, scope)).toMatchObject({ value: { sample: { index: 200, unitProductId: 'unit-200' } } })
    expect(deps.sampling.listSamples).toHaveBeenCalledWith('project', 'run', 1, 200)
    expect(reader.read({ ...base, ...examples[7], unitId: 'wrong' }, scope)).toMatchObject({ status: 'unavailable', reason: 'binding-mismatch' })
  })
  it.each(['project', 'revision', 'workspace', 'hash'])('rejects mismatched %s without fallback', mode => {
    const { reader, deps } = fixture()
    const ref = { ...base, ...examples[4], ...(mode === 'revision' ? { projectRevision: 2 } : {}), ...(mode === 'hash' ? { recordHash: otherHash } : {}) }
    expect(reader.read(ref, { projectId: mode === 'project' ? 'other' : 'project', workspace: mode === 'workspace' ? '/other' : '/workspace' })).toMatchObject({ status: 'unavailable', reason: 'binding-mismatch' })
    if (mode !== 'hash') expect(deps.advanced.getTrial).not.toHaveBeenCalled()
    else expect(deps.advanced.getTrial).toHaveBeenCalledExactlyOnceWith('project', 'trial')
  })
  it('never resolves a stale getter through another getter or starts a new trial', () => {
    const { reader, deps } = fixture()
    deps.advanced.getTrial.mockImplementation(() => { throw new Error('stale') })
    expect(reader.read({ ...base, ...examples[4] }, scope)).toMatchObject({ status: 'unavailable', reason: 'record-unavailable-or-integrity-failed' })
    expect(deps.scoring.getRecord).not.toHaveBeenCalled()
    expect(deps.advanced.getTrial).toHaveBeenCalledTimes(1)
  })
  it('requires object row identity, checks scalar paths against their row, and permits hash-bound matrix coordinates', () => {
    const value = { rows: [{ id: 'P', scalar: 3 }], matrix: [[1, 2], [3, 4]] }
    expect(() => selectSurveyEvidence(value, { path: ['rows', 0, 'scalar'] })).toThrow('selector-identity-required')
    expect(() => selectSurveyEvidence(value, { path: ['rows', 0], identity: { id: 'other' } })).toThrow('selector-identity-mismatch')
    expect(selectSurveyEvidence(value, { path: ['rows', 0, 'scalar'], identity: { id: 'P' } })).toBe(3)
    expect(selectSurveyEvidence(value, { path: ['matrix', 1, 0] })).toBe(3)
    expect(() => selectSurveyEvidence(value, { path: ['rows', 10], identity: { id: 'P' } })).toThrow('selector-missing')
  })
  it('binds ID-less standard locators using actual nested descriptions and clause coordinates', () => {
    const value = { locators: [{ description: { zh: 'Actual retained locator' }, clauses: ['6.1.3'] }] }
    const selector = { path: ['locators', 0], identityPaths: [{ path: ['description', 'zh'], equals: 'Actual retained locator' }, { path: ['clauses', 0], equals: '6.1.3' }] }
    expect(selectSurveyEvidence(value, selector)).toEqual(value.locators[0])
    expect(() => selectSurveyEvidence(value, { ...selector, identityPaths: [{ path: ['clauses', 0], equals: '6.1.2' }] })).toThrow('selector-identity-mismatch')
  })
  it('refuses an invalid raw-source ledger before returning raw network points', () => {
    const { reader, deps } = fixture()
    deps.survey.getRawSourceIntegrity.mockReturnValue({ status: 'failed', ledgerEntryCount: 1, errors: [] })
    expect(reader.read({ ...base, ...examples[0] }, scope)).toMatchObject({ status: 'unavailable', reason: 'binding-mismatch' })
  })
  it.each(['__proto__', 'constructor', 'prototype'])('rejects %s and unknown request properties', key => {
    const ref = { ...base, ...examples[4], selector: { path: [key] } }
    expect(SurveyEvidenceReferenceV1.safeParse(ref).success).toBe(false)
    expect(() => selectSurveyEvidence({}, { path: [key] })).toThrow()
    expect(SurveyEvidenceReferenceV1.safeParse({ ...base, ...examples[4], approve: true }).success).toBe(false)
  })
  it('returns explicit output-limit instead of partial evidence', () => {
    const { reader, deps } = fixture()
    deps.advanced.getTrial.mockReturnValue({ id: 'trial', projectId: 'project', recordHash: hash, result: { rows: Array.from({ length: 1600 }, (_, i) => ({ observationId: `obs-${i}`, value: i })) } })
    const ref = { ...base, ...examples[4] }
    expect(reader.read(ref, scope)).toMatchObject({ status: 'selector-required', reason: 'output-limit' })
    expect(reader.read({ ...ref, selector: { path: ['result', 'rows', 1550], identity: { observationId: 'obs-1550' } } }, scope)).toMatchObject({ status: 'resolved', value: { value: 1550 } })
  })
  it('resolves the exact standard rule/source/profile and rejects a different digest', () => {
    const { reader, deps } = fixture()
    const entry = getSurveyStandardBasisCatalog().rules[0]!, rule = entry.rule, profile = rule.profiles[0]!
    const ref = { ...base, kind: 'standard-basis', ruleDigest: entry.ruleDigest, reference: { standardCode: rule.standardCode, standardVersion: rule.standardVersion,
      ruleId: rule.ruleId, ruleVersion: rule.ruleVersion, sourceSha256: rule.source.sha256, algorithmVersion: rule.executor.algorithmVersion, profileId: profile.profileId, profileVersion: profile.profileVersion } }
    expect(reader.read(ref, scope)).toMatchObject({ status: 'resolved', value: { status: 'resolved-basis-only', historicalRecordsModified: false } })
    expect(reader.read({ ...ref, ruleDigest: otherHash }, scope)).toMatchObject({ status: 'unavailable', reason: 'binding-mismatch' })
    const parent = { kind: 'sampling-run', runId: 'run', runHash: hash, planHash: hash }
    deps.sampling.getRun.mockReturnValue({ id: 'run', projectId: 'project', runHash: hash, planHash: hash, algorithmVersion: rule.executor.algorithmVersion, inspectionMode: rule.executor.operation,
      source: { standard: rule.standardCode, sourceSha256: rule.source.sha256 } } as never)
    expect(reader.read({ ...ref, parent }, scope)).toMatchObject({ status: 'resolved' })
    expect(reader.read({ ...ref, parent: { ...parent, runHash: otherHash } }, scope)).toMatchObject({ status: 'unavailable', reason: 'binding-mismatch' })
  })
  it('refuses a different diagnostic algorithm for the same calculation', () => {
    const { reader } = fixture()
    expect(reader.read({ ...base, ...examples[2], diagnosticsVersion: 'leveling-deleted-t-0' }, scope)).toMatchObject({ status: 'unavailable', reason: 'binding-mismatch' })
  })
  it('refuses a valid alternate scoring product profile attached to another profile record', () => {
    const { reader, deps } = fixture()
    const entry = getSurveyStandardBasisCatalog().rules.find(item => item.rule.executor.family === 'declared-scoring')!, rule = entry.rule
    const [first, second] = rule.profiles
    expect(first).toBeDefined(); expect(second).toBeDefined()
    const reference = { standardCode: rule.standardCode, standardVersion: rule.standardVersion, ruleId: rule.ruleId, ruleVersion: rule.ruleVersion,
      sourceSha256: rule.source.sha256, algorithmVersion: rule.executor.algorithmVersion, profileId: first!.profileId, profileVersion: first!.profileVersion }
    deps.scoring.getRecord.mockReturnValue({ id: 'record', projectId: 'project', recordHash: hash, kind: rule.executor.operation, algorithmVersion: rule.executor.algorithmVersion,
      result: { source: { standardCode: rule.standardCode, sha256: rule.source.sha256 }, request: { productProfileId: first!.profileId, productProfileVersion: first!.profileVersion } } } as never)
    const ref = { ...base, kind: 'standard-basis', reference, ruleDigest: entry.ruleDigest, parent: { kind: 'scoring', recordId: 'record', recordHash: hash } }
    expect(reader.read(ref, scope)).toMatchObject({ status: 'resolved' })
    expect(reader.read({ ...ref, reference: { ...reference, profileId: second!.profileId, profileVersion: second!.profileVersion } }, scope)).toMatchObject({ status: 'unavailable', reason: 'binding-mismatch' })
  })
})
