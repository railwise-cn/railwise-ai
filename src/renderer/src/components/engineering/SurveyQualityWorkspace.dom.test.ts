// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurveyQualityWorkspace } from './SurveyQualityWorkspace'
import {
  parseQualityPlan, parseQualityRecord, appendQualityBytesCheck, readQualityRecord, listQualityPlans,
  type QualityBinding, type QualityPlan, type QualityRecord
} from '../../agent/survey-quality-client'
import i18n from '../../i18n'
import { EngineeringEvidenceQuestions } from './EngineeringEvidenceQuestion'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'

const hash = (value: string) => value.repeat(64)
const createdAt = '2026-09-20T00:00:00.000Z'
const output = { path: '.workwise/deliverables/project/run/report.pdf', sha256: hash('a'), sizeBytes: 100, mediaType: 'application/pdf' }
const binding: QualityBinding = { projectId: 'project', projectRevision: 2, manifestId: 'manifest', outputs: [output] }
const plan: QualityPlan = {
  plan: { schemaVersion: 1, id: 'plan-1', projectId: 'project', projectRevision: 2, projectBindingHash: hash('b'), manifestId: 'manifest',
    manifestHash: hash('c'), artifactId: 'artifact-1', artifactHash: hash('d'), requiredEvidence: [{ id: 'output-1', memberId: 'output-1', title: 'Output file 1: report.pdf' }],
    requiredCheckIds: ['artifact-bytes', 'evidence:output-1'], purpose: 'evidence-retention-only', createdAt, standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated' },
  artifact: { schemaVersion: 1, id: 'artifact-1', projectId: 'project', manifestId: 'manifest', manifestHash: hash('c'), bundleHash: hash('d'), snapshotEvidenceSha256: hash('e'), createdAt,
    members: [{ id: 'manifest', path: '.workwise/deliverables/project/run/manifest.json', mediaType: 'application/json', sha256: hash('f'), sizeBytes: 200 }, { id: 'output-1', ...output }] }
}
const emptyRecord: QualityRecord = {
  record: { schemaVersion: 1, id: 'record-1', projectId: 'project', planId: 'plan-1', planHash: hash('b'), artifactId: 'artifact-1', artifactHash: hash('d'), createdAt }, events: [],
  verification: { schemaVersion: 1, projectId: 'project', recordId: 'record-1', planId: 'plan-1', artifactHash: hash('d'), headHash: hash('0'), checkedAt: createdAt,
    localRecordIntegrity: true, artifactIntegrity: 'verified', checkpointTrust: 'local-records-only', coverageStatus: 'not-evaluated', reason: 'independent-checkpoint-unavailable',
    assessmentBasis: 'recorded-retention-checks-only', checks: [{ checkId: 'artifact-bytes', status: 'missing' }, { checkId: 'evidence:output-1', status: 'missing' }],
    standardConformity: 'not-evaluated', humanSignatureVerification: 'not-evaluated' }
}
function appendRecord(current: QualityRecord, checkId: string): QualityRecord {
  const sequence = current.events.length + 1
  const event: QualityRecord['events'][number] = {
    schemaVersion: 1, id: `event-${sequence}`, projectId: 'project', artifactSha256: hash('d'), sequence,
    previousHash: current.verification.headHash, thisHash: sequence.toString(16).padStart(64, '0'), occurredAt: createdAt,
    actor: { id: 'survey-quality-workspace', kind: 'system' }, stage: 'workspace-evidence',
    event: { kind: 'check', checkId, outcome: 'passed', evidenceSha256: checkId === 'artifact-bytes' ? hash('d') : hash('a') }
  }
  return { ...current, events: [...current.events, event], verification: { ...current.verification, headHash: event.thisHash,
    checks: current.verification.checks.map(check => check.checkId === checkId ? { checkId, status: 'passed', eventId: event.id } : check) } }
}
const response = (value: unknown) => ({ ok: true, status: 200, body: JSON.stringify(value) })
const evidence = { schemaVersion: 1, id: 'evidence-1', projectId: 'project', artifactId: 'artifact-1', memberId: 'output-1', sha256: hash('a'), sizeBytes: 100, createdAt, semantics: 'retained-bytes-only' }
const runtimeRequest = vi.fn()
let storedRecord: QualityRecord
let host: HTMLDivElement
let root: Root
async function render(overrides: Partial<Parameters<typeof SurveyQualityWorkspace>[0]> = {}): Promise<void> {
  await act(async () => root.render(createElement(SurveyQualityWorkspace, { binding, runtimeReady: true, ...overrides })))
}
const button = (label: string): HTMLButtonElement => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!
async function click(target: HTMLElement): Promise<void> { await act(async () => target.click()) }
async function open(): Promise<void> { await act(async () => { const details = host.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) }) }
async function freeze(): Promise<void> { await click(host.querySelector('input')!); await click(button('Freeze this retention plan')) }
async function createRecord(): Promise<void> { await click(button('Create a retention record for this plan')) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en'); storedRecord = structuredClone(emptyRecord)
  runtimeRequest.mockReset().mockImplementation(async (path: string, method = 'GET', body?: string) => {
    if (path.endsWith('/quality-plans') && method === 'POST') return response(plan)
    if (path.includes('/quality-plans?')) return response({ plans: [plan], nextOffset: null })
    if (path.endsWith('/quality-plans/plan-1')) return response(plan)
    if (path.endsWith('/quality-records') && method === 'POST') return response(storedRecord)
    if (path.includes('/quality-records?')) return response({ records: [{ record: storedRecord.record, verification: storedRecord.verification }], nextOffset: null })
    if (path.endsWith('/quality-records/record-1')) return response(storedRecord)
    if (path.endsWith('/quality-evidence')) return response(evidence)
    if (path.endsWith('/checks')) { storedRecord = appendRecord(storedRecord, JSON.parse(body!).checkId); return response(storedRecord) }
    if (path.endsWith('/verify')) return response(storedRecord.verification)
    throw new Error('unexpected request')
  })
  Object.assign(window, { workwise: { runtimeRequest } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('quality retention desktop workspace', () => {
  it('binds material checks and audit questions to the exact verified record head without writes', async () => {
    const focus = vi.fn()
    useEngineeringConversationDrafts.setState({ drafts: {} })
    await act(async () => root.render(createElement(EngineeringEvidenceQuestions, { scope: { workspace: '/test', projectId: 'project', projectRevision: 2, ready: true, focus }, children: createElement(SurveyQualityWorkspace, { binding, runtimeReady: true }) })))
    await open(); await freeze(); await createRecord(); await click(button('Record bundle byte check'))
    const question = host.querySelector('button[aria-label*="event-1"]') as HTMLButtonElement
    runtimeRequest.mockClear(); await click(question)
    expect(runtimeRequest).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledOnce()
    expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify(['/test', 'project'])]?.evidenceContext?.typedEvidence).toEqual({ schemaVersion: 1, projectId: 'project', projectRevision: 2, kind: 'retention-record', recordId: storedRecord.record.id, planHash: storedRecord.record.planHash, headHash: storedRecord.verification.headHash, selector: { path: ['events', 0], identity: { id: 'event-1', sequence: 1, thisHash: storedRecord.verification.headHash } } })
    await click(button('Read plan history')); expect(host.querySelector('button[aria-label*="event-1"]')).toBeNull()
  })

  it('requires explicit freeze and individual checks, binds each material to its member, and never labels retention as approval', async () => {
    await render(); expect(runtimeRequest).not.toHaveBeenCalled()
    await open(); expect(runtimeRequest).not.toHaveBeenCalled()
    expect(button('Freeze this retention plan').disabled).toBe(true)
    expect(host.textContent).toContain(output.path)
    expect(host.textContent).toContain('not quality approval')
    await freeze()
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
    expect(JSON.parse(runtimeRequest.mock.calls[0]![2])).toEqual({ manifestId: 'manifest', expectedProjectRevision: 2, idempotencyKey: expect.any(String), requiredEvidence: plan.plan.requiredEvidence })
    await createRecord()
    expect(runtimeRequest).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Not yet recorded')
    await click(button('Record bundle byte check'))
    expect(JSON.parse(runtimeRequest.mock.calls.at(-1)![2])).toEqual({ expectedHeadHash: hash('0'), idempotencyKey: expect.any(String), checkId: 'artifact-bytes' })
    await click(button('Retain selected member and record this check'))
    const retain = runtimeRequest.mock.calls.find(([path]) => path.endsWith('/quality-evidence'))!
    expect(JSON.parse(retain[2])).toEqual({ artifactId: 'artifact-1', memberId: 'output-1', idempotencyKey: expect.any(String) })
    expect(JSON.parse(runtimeRequest.mock.calls.at(-1)![2])).toEqual({ expectedHeadHash: '1'.padStart(64, '0'), idempotencyKey: expect.any(String), checkId: 'evidence:output-1', evidenceId: 'evidence-1' })
    expect(host.querySelector('select')).toBeNull()
    expect(storedRecord.events).toHaveLength(2)
    expect(host.textContent).toContain('Recorded (byte retention only)')
    expect(host.textContent).toContain('History coverage, standards conformity and human signatures remain unevaluated')
    await click(button('Reverify local records and frozen bytes'))
    expect(runtimeRequest.mock.calls.at(-2)!.slice(0, 3)).toEqual(['/v1/engineering/projects/project/quality-records/record-1/verify', 'POST', '{}'])
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain('不代表质量批准')
    expect(host.textContent).toContain('已记录（仅字节留存）')
  })

  it('restores a selected plan and its records through bounded history pages and fresh reads', async () => {
    await render(); await open()
    runtimeRequest.mockResolvedValueOnce(response({ plans: [plan], unavailable: [{ id: 'old-plan', reason: 'stale' }, { id: 'damaged-plan', reason: 'integrity' }], nextOffset: 20 }))
    await click(button('Read plan history'))
    expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('?limit=20&offset=0')
    expect(host.textContent).toContain('old-plan')
    expect(host.textContent).toContain('damaged-plan')
    expect(host.textContent).toContain('cannot restore')
    expect(Array.from(host.querySelectorAll('button')).some(item => item.textContent?.includes('old-plan'))).toBe(false)
    await click(button('Next page')); expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('offset=20')
    await click(button('Previous page'))
    await click(Array.from(host.querySelectorAll('button')).find(item => item.textContent?.startsWith('Validate and restore plan'))!)
    await click(button('Read records for this plan'))
    expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('/quality-records?limit=20&offset=0')
    await click(Array.from(host.querySelectorAll('button')).find(item => item.textContent?.startsWith('Validate and restore record'))!)
    expect(runtimeRequest).toHaveBeenLastCalledWith('/v1/engineering/projects/project/quality-records/record-1', 'GET')
    expect(host.textContent).toContain('Local retention record')
    expect(runtimeRequest.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  })

  it('retries an ambiguous mutation with exactly the original head and idempotency identity and clears stale displays', async () => {
    await render(); await open(); await freeze(); await createRecord()
    runtimeRequest.mockRejectedValueOnce(new Error('network disconnected'))
    await click(button('Record bundle byte check'))
    const original = runtimeRequest.mock.calls.at(-1)!
    expect(host.textContent).not.toContain('Local retention record')
    await click(button('Retry the same request'))
    expect(runtimeRequest.mock.calls.at(-1)).toEqual(original)
    runtimeRequest.mockResolvedValueOnce({ ok: false, status: 409, body: JSON.stringify({ code: 'quality_workspace_stale', message: 'PRIVATE /path' }) })
    await click(button('Record bundle byte check'))
    expect(host.textContent).toContain('project revision, manifest or source files changed')
    expect(host.textContent).not.toContain('Local retention record')
    expect(host.textContent).not.toContain('PRIVATE')
    expect(button('Retry the same request')).toBeUndefined()
  })

  it.each([{ runtimeReady: false }, { binding: { ...binding, projectRevision: 3 } }, { binding: { ...binding, manifestId: 'other' } }, { binding: { ...binding, projectId: 'other' } }])('ignores responses from an obsolete scope: %o', async override => {
    await render(); await open()
    let complete!: (value: unknown) => void
    runtimeRequest.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await click(host.querySelector('input')!)
    await act(async () => { button('Freeze this retention plan').click(); button('Freeze this retention plan').click() })
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
    await render(override)
    await act(async () => complete(response(plan)))
    expect(host.textContent).not.toContain('plan-1')
    expect(host.querySelector<HTMLInputElement>('input')?.checked).toBe(false)
  })

  it('does not append a check if the scope changes while retaining its member', async () => {
    await render(); await open(); await freeze(); await createRecord()
    let complete!: (value: unknown) => void
    runtimeRequest.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await click(button('Retain selected member and record this check'))
    await render({ binding: { ...binding, projectId: 'other' } })
    await act(async () => complete(response(evidence)))
    expect(runtimeRequest.mock.calls.some(([path]) => path.endsWith('/checks'))).toBe(false)
  })

  it('clears hidden workspace results and ignores a freeze that finishes after closing', async () => {
    await render(); await open()
    let complete!: (value: unknown) => void
    runtimeRequest.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await freeze()
    await act(async () => { const details = host.querySelector('details')!; details.open = false; details.dispatchEvent(new Event('toggle')) })
    await act(async () => complete(response(plan)))
    await open()
    expect(host.textContent).not.toContain('plan-1')
    expect(host.querySelector<HTMLInputElement>('input')?.checked).toBe(false)
  })
})

describe('quality workspace client boundaries', () => {
  it('rejects changed project, revision, manifest, output bytes and declared members', () => {
    for (const mutate of [
      { plan: { ...plan.plan, projectId: 'other' } }, { plan: { ...plan.plan, projectRevision: 3 } },
      { plan: { ...plan.plan, manifestId: 'other' } }, { plan: { ...plan.plan, standardConformity: 'approved' } },
      { plan: { ...plan.plan, requiredCheckIds: [] } },
      { plan: { ...plan.plan, requiredEvidence: [{ ...plan.plan.requiredEvidence[0], memberId: 'missing' }] } },
      { artifact: { ...plan.artifact, members: plan.artifact.members.map(member => ({ ...member, sha256: hash('b') })) } }
    ]) expect(() => parseQualityPlan({ ...plan, ...mutate }, binding)).toThrow('invalid-response')
  })
  it('rejects invented acceptance, human actors, changed heads and check statuses without event evidence', () => {
    const valid = appendRecord(emptyRecord, 'artifact-bytes')
    for (const mutate of [
      { record: { ...valid.record, projectId: 'other' } },
      { verification: { ...valid.verification, coverageStatus: 'verified' } },
      { verification: { ...valid.verification, headHash: hash('f') } },
      { verification: { ...valid.verification, checks: valid.verification.checks.map(check => ({ ...check, status: 'passed' })) } },
      { events: valid.events.map(event => ({ ...event, actor: { id: 'engineer', kind: 'human' } })) },
      { events: valid.events.map(event => ({ ...event, previousHash: hash('f') })) }
    ]) expect(() => parseQualityRecord({ ...valid, ...mutate }, binding, plan)).toThrow('invalid-response')
    expect(parseQualityRecord(valid, binding, plan).events).toHaveLength(1)
  })
  it('blocks substituting another bundle member before retaining it', async () => {
    await expect(appendQualityBytesCheck(binding, plan, emptyRecord, 'evidence:output-1', 'append-key', 'manifest', 'retain-key')).rejects.toMatchObject({ reason: 'invalid-response' })
    expect(runtimeRequest).not.toHaveBeenCalled()
  })
  it('rejects oversized responses, duplicate history and invalid pagination', async () => {
    runtimeRequest.mockResolvedValueOnce({ ok: true, status: 200, body: ' '.repeat(4 * 1024 * 1024 + 1) })
    await expect(readQualityRecord(binding, plan, emptyRecord)).rejects.toMatchObject({ reason: 'invalid-response' })
    for (const value of [{ plans: [plan, plan], nextOffset: null }, { plans: [plan], nextOffset: 0 }]) {
      runtimeRequest.mockResolvedValueOnce(response(value))
      await expect(listQualityPlans(binding)).rejects.toMatchObject({ reason: 'invalid-response' })
    }
  })
})
