// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurveyFreeLevelingTrial } from './SurveyFreeLevelingTrial'
import { createFreeLevelingTrial, listFreeLevelingTrials, readFreeLevelingTrial, type FreeLevelingBinding } from '../../agent/survey-free-leveling-client'
import i18n from '../../i18n'
import { EngineeringEvidenceQuestions } from './EngineeringEvidenceQuestion'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'

const binding: FreeLevelingBinding = { projectId: 'project-trial', networkId: 'network-trial', networkRevision: 2, sourceSha256: 'a'.repeat(64) }
const fixture = {
  ...binding, schemaVersion: 1, id: 'trial-1', inputHash: 'b'.repeat(64), sourceAdmissionHash: 'c'.repeat(64),
  algorithmVersion: 'free-leveling-trial-1', constraint: 'sum-height-corrections-zero', acknowledgeDatumRelease: true,
  weightPolicy: 'source-or-unit-fallback', weightBasis: 'inverse-route-length-with-unit-default',
  originalPointRoles: [
    { id: 'A', known: true, collection: 'knownPoints', originalPoint: { id: 'A', known: true, height: 0 }, referenceHeightBasis: 'declared-height' },
    { id: 'B', known: false, collection: 'unknownPoints', originalPoint: { id: 'B', known: false }, referenceHeightBasis: 'zero-initial-approximation' }
  ],
  defaultWeightObservationIds: ['obs-1', 'obs-2'], pointCount: 2, observationCount: 2, degreesOfFreedom: 1,
  createdAt: '2026-09-20T00:00:00.000Z', requestHash: 'd'.repeat(64), outputHash: 'e'.repeat(64), recordHash: 'f'.repeat(64),
  output: {
    algorithmVersion: 'free-leveling-trial-1', status: 'trial-only', model: 'independent-linear-height-differences',
    modelAssumptions: 'not-verified', engineeringDecision: 'not-evaluated', unit: 'm', squaredUnit: 'm2',
    constraint: { type: 'sum-height-corrections-zero', pointIds: ['A', 'B'] }, pointIds: ['A', 'B'], observationIds: ['obs-1', 'obs-2'],
    points: [{ id: 'A', referenceHeight: 0, correction: -0.55, height: -0.55 }, { id: 'B', referenceHeight: 0, correction: 0.55, height: 0.55 }],
    observations: [1, 2].map((i) => ({ id: `obs-${i}`, from: 'A', to: 'B', heightDifference: i === 1 ? 1 : 1.2,
      weight: 1, weightSource: 'unit-default', sourceAnchor: `raw-${i}`, adjustedHeightDifference: 1.1, residual: i === 1 ? -0.1 : 0.1 })),
    residualConvention: 'observed-minus-adjusted', rank: 1, datumDefect: 1, degreesOfFreedom: 1,
    heightCofactor: [[0.125, -0.125], [-0.125, 0.125]], residualCofactor: [[0.5, -0.5], [-0.5, 0.5]], adjustedHeightDifferenceCofactor: [[0.5, 0.5], [0.5, 0.5]],
    weightedSSE: 0.02, posteriorVarianceFactorEstimate: 0.02, aprioriCovariance: null,
    numerical: { reducedNormalConditionInfinity: 1, weightRatio: 1, stationarityError: 0, constraintError: 0,
      limits: { maxPoints: 64, maxObservations: 256, maxWeightRatio: 1e8, maxReducedNormalCondition: 1e10, backwardTolerance: 1e-10, outputResolutionTolerance: 1e-10 } }
  }
}
const summary = Object.fromEntries(Object.entries(fixture).filter(([key]) => key !== 'output' && key !== 'originalPointRoles'))
const response = (body: unknown) => ({ ok: true, status: 200, body: JSON.stringify(body) })
const runtimeRequest = vi.fn()
const sourceRenderer = vi.fn((id: string, dismiss: () => void) => createElement('div', null,
  createElement('p', null, `source-anchor:${id}`), createElement('button', { type: 'button', onClick: dismiss }, 'Close source')))
const defaults = { binding, contextRevision: 1, runtimeReady: true, eligible: true, renderSourceRecord: sourceRenderer }
let host: HTMLDivElement
let root: Root
async function render(overrides: Partial<Parameters<typeof SurveyFreeLevelingTrial>[0]> = {}): Promise<void> {
  await act(async () => root.render(createElement(SurveyFreeLevelingTrial, { ...defaults, ...overrides })))
}
const button = (label: string): HTMLButtonElement => Array.from(host.querySelectorAll('button')).find(item => item.textContent?.includes(label))!
async function click(target: HTMLElement): Promise<void> { await act(async () => target.click()) }
async function acknowledge(): Promise<void> { await click(host.querySelector('input')!) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  runtimeRequest.mockReset().mockResolvedValue(response(fixture)); sourceRenderer.mockClear()
  Object.assign(window, { workwise: { runtimeRequest } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('free leveling desktop trial', () => {
  it('pins the trial point and observation using their stored record hash without inheriting a fixed-datum result', async () => {
    const focus = vi.fn(), key = JSON.stringify(['/survey', binding.projectId])
    useEngineeringConversationDrafts.setState({ drafts: {} })
    await act(async () => root.render(createElement(EngineeringEvidenceQuestions, { scope: { workspace: '/survey', projectId: binding.projectId, projectRevision: 1, ready: true, focus }, children: createElement(SurveyFreeLevelingTrial, defaults) })))
    await acknowledge(); await click(button('Run trial')); runtimeRequest.mockClear()
    for (const [tableIndex, collection, id] of [[0, 'points', 'B'], [1, 'observations', 'obs-2']] as const) {
      await click(host.querySelectorAll('table')[tableIndex]!.querySelector<HTMLButtonElement>('tbody tr:nth-child(2) button[title]')!)
      expect(useEngineeringConversationDrafts.getState().drafts[key]!.evidenceContext!.typedEvidence).toEqual({ schemaVersion: 1, projectId: binding.projectId, projectRevision: 1, kind: 'free-leveling', networkId: binding.networkId, networkRevision: binding.networkRevision, sourceSha256: binding.sourceSha256, trialId: fixture.id, recordHash: fixture.recordHash, selector: { path: ['output', collection, 1], identity: { id } } })
      expect(useEngineeringConversationDrafts.getState().drafts[key]!.evidenceContext).not.toHaveProperty('adjustmentId')
    }
    expect(runtimeRequest).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledTimes(2)
  })

  it('requires explicit datum acknowledgement, sends only the strict trial request, and renders both languages with source locators', async () => {
    await render()
    expect(runtimeRequest).not.toHaveBeenCalled(); expect(button('Run trial').disabled).toBe(true)
    expect(host.textContent).toContain('Σ(H − H₀) = 0')
    expect(host.textContent).toContain('does not establish a physical height datum')
    await acknowledge(); await click(button('Run trial'))
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
    const [path, method, body] = runtimeRequest.mock.calls[0]!
    expect(path).toBe('/v1/engineering/projects/project-trial/networks/network-trial/free-leveling-trials'); expect(method).toBe('POST')
    expect(JSON.parse(body)).toEqual({ expectedRevision: 2, idempotencyKey: expect.any(String), constraint: 'sum-height-corrections-zero', acknowledgeDatumRelease: true, weightPolicy: 'source-or-unit-fallback' })
    expect(host.querySelectorAll('table')).toHaveLength(2)
    expect(host.textContent).toContain('-0.55'); expect(host.textContent).toContain('observed − adjusted')
    expect(host.textContent).toContain('Missing height: zero initial approximation')
    expect(host.textContent).toContain('Engineering decision not evaluated')
    for (const region of host.querySelectorAll('[role="region"]')) expect(region.getAttribute('tabindex')).toBe('0')
    await click(button('Locate obs-1'))
    expect(sourceRenderer).toHaveBeenCalledWith('raw-1', expect.any(Function))
    expect(document.activeElement?.textContent).toContain('source-anchor:raw-1')
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain('仅供试算'); expect(host.textContent).toContain('自由度'); expect(host.textContent).toContain('原固定点')
    expect(host.textContent).toContain('缺失高程：零初始近似')
  })

  it('revalidates history details and supports both pagination directions', async () => {
    runtimeRequest.mockResolvedValueOnce(response({ trials: [summary], nextOffset: 20 }))
    await render(); await click(button('Read trial history'))
    expect(runtimeRequest).toHaveBeenLastCalledWith('/v1/engineering/projects/project-trial/networks/network-trial/free-leveling-trials?limit=20&offset=0', 'GET')
    runtimeRequest.mockResolvedValueOnce(response({ trials: [summary], nextOffset: null }))
    await click(button('Next page'))
    expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('offset=20')
    runtimeRequest.mockResolvedValueOnce(response({ trials: [summary], nextOffset: 20 }))
    await click(button('Previous page')); expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('offset=0')
    await click(button('Validate and restore'))
    expect(runtimeRequest).toHaveBeenLastCalledWith('/v1/engineering/projects/project-trial/networks/network-trial/free-leveling-trials/trial-1', 'GET')
    expect(host.querySelectorAll('table')).toHaveLength(2)
    expect((host.querySelector('input') as HTMLInputElement).checked).toBe(false)
  })

  it('returns keyboard focus to the exact source locator after closing its record', async () => {
    await render(); await acknowledge(); await click(button('Run trial'))
    const locator = button('Locate obs-2')
    locator.focus(); await click(locator)
    expect(document.activeElement?.textContent).toContain('source-anchor:raw-2')
    const close = button('Close source'); close.focus(); await click(close)
    expect(document.activeElement).toBe(locator)
    expect(host.textContent).not.toContain('source-anchor:raw-2')
  })

  it('keeps keyboard focus on a persistent control after pagination, restore and failure', async () => {
    runtimeRequest.mockResolvedValueOnce(response({ trials: [summary], nextOffset: 20 }))
    await render()
    const history = button('Read trial history'); history.focus(); await click(history)
    expect(document.activeElement).toBe(history)
    runtimeRequest.mockResolvedValueOnce(response({ trials: [summary], nextOffset: null }))
    const next = button('Next page'); next.focus(); await click(next)
    expect(document.activeElement).toBe(history)
    const restore = button('Validate and restore'); restore.focus(); await click(restore)
    expect(document.activeElement).toBe(history)
    expect(host.querySelectorAll('table')).toHaveLength(2)
    for (let index = 0; index < 2; index++) {
      runtimeRequest.mockRejectedValueOnce(new Error('failed'))
      await click(history)
      expect(document.activeElement).toBe(history)
    }
  })

  it.each(['moved-focus', 'hidden', 'scope-change'] as const)('never steals focus after a history request when %s', async scenario => {
    let complete!: (value: unknown) => void
    runtimeRequest.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await render()
    const history = button('Read trial history'); history.focus(); await click(history)
    expect(document.activeElement).toBe(host.querySelector('h4'))
    const outside = document.createElement('button'); document.body.append(outside)
    if (scenario === 'moved-focus') outside.focus()
    if (scenario === 'hidden') host.hidden = true
    if (scenario === 'scope-change') { await render({ binding: { ...binding, projectId: 'other' } }); outside.focus() }
    const expectedFocus = document.activeElement
    await act(async () => complete(response({ trials: [summary], nextOffset: null })))
    expect(document.activeElement).toBe(expectedFocus)
    expect(document.activeElement).not.toBe(history)
    outside.remove()
  })

  it('ignores an obsolete source dismissal after the scope changes and does not focus hidden controls', async () => {
    await render(); await acknowledge(); await click(button('Run trial'))
    await click(button('Locate obs-1'))
    const dismiss = sourceRenderer.mock.calls.at(-1)![1]
    await render({ binding: { ...binding, projectId: 'other' } })
    const outside = document.createElement('button'); document.body.append(outside); outside.focus()
    await act(async () => dismiss())
    expect(document.activeElement).toBe(outside)
    await render(); await acknowledge(); await click(button('Run trial')); await click(button('Locate obs-1'))
    host.style.display = 'none'; outside.focus()
    await act(async () => sourceRenderer.mock.calls.at(-1)![1]())
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('clears all output on retry, localizes specific failures, and hides raw server text', async () => {
    await render(); await acknowledge(); await click(button('Run trial'))
    runtimeRequest.mockResolvedValueOnce({ ok: false, status: 409, body: JSON.stringify({ code: 'free_leveling_mixed_weights', message: 'PRIVATE /disk/path', details: { reason: 'mixed-weights' } }) })
    await click(button('Run trial'))
    expect(host.querySelector('table')).toBeNull()
    expect(host.textContent).toContain('Weight declarations are incomplete or mixed')
    expect(host.textContent).not.toContain('PRIVATE')
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain('权值声明不完整或混用')
  })

  it('coalesces rapid clicks and preserves the idempotency key across ambiguous request retries', async () => {
    runtimeRequest.mockRejectedValueOnce(new Error('private network error'))
    await render(); await acknowledge()
    await act(async () => { button('Run trial').click(); button('Run trial').click() })
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
    const first = JSON.parse(runtimeRequest.mock.calls[0]![2]).idempotencyKey
    await click(button('Run trial'))
    expect(JSON.parse(runtimeRequest.mock.calls[1]![2]).idempotencyKey).toBe(first)
    await click(button('Run trial'))
    expect(JSON.parse(runtimeRequest.mock.calls[2]![2]).idempotencyKey).not.toBe(first)
  })

  it.each([
    { runtimeReady: false }, { eligible: false }, { contextRevision: 3 },
    { binding: { ...binding, networkRevision: 3 } }, { binding: { ...binding, projectId: 'other' } },
    { binding: { ...binding, networkId: 'other' } }, { binding: { ...binding, sourceSha256: 'c'.repeat(64) } }
  ])('clears completed and pending results when scope changes: %o', async overrides => {
    await render(); await acknowledge(); await click(button('Run trial'))
    await click(button('Locate obs-1'))
    let complete!: (value: unknown) => void
    runtimeRequest.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await click(button('Run trial')); expect(host.querySelector('table')).toBeNull()
    await render(overrides)
    await act(async () => complete(response(fixture)))
    expect(host.querySelector('table')).toBeNull(); expect(host.textContent).not.toContain('source-anchor:')
    expect((host.querySelector('input') as HTMLInputElement).checked).toBe(false)
    await render(); expect(host.querySelector('table')).toBeNull()
  })
})

describe('free leveling client trust boundary', () => {
  it.each(Object.keys(binding) as Array<keyof FreeLevelingBinding>)('rejects mismatched %s', async key => {
    runtimeRequest.mockResolvedValueOnce(response({ ...fixture, [key]: key === 'networkRevision' ? 3 : 'wrong' }))
    await expect(readFreeLevelingTrial(binding, fixture.id)).rejects.toMatchObject({ reason: 'invalid-response' })
  })
  it('rejects identity substitution, malformed output, changed trial status, and excessive payloads', async () => {
    for (const value of [
      { ...fixture, id: 'other' }, { ...fixture, pointCount: 3 },
      { ...fixture, output: { ...fixture.output, engineeringDecision: 'passed' } },
      { ...fixture, output: { ...fixture.output, modelAssumptions: 'verified' } },
      { ...fixture, output: { ...fixture.output, points: [] } },
      { ...fixture, originalPointRoles: fixture.originalPointRoles.map(role => ({ ...role, originalPoint: { ...role.originalPoint, id: 'other' } })) },
      { ...fixture, output: { ...fixture.output, constraint: { ...fixture.output.constraint, pointIds: ['B', 'A'] } } },
      { ...fixture, output: { ...fixture.output, residualCofactor: [[1]] } },
      { ...fixture, output: { ...fixture.output, observations: fixture.output.observations.map(row => ({ ...row, sourceAnchor: '' })) } },
      { ...fixture, output: { ...fixture.output, observations: fixture.output.observations.map(row => ({ ...row, to: 'missing' })) } }
    ]) {
      runtimeRequest.mockResolvedValueOnce(response(value))
      await expect(readFreeLevelingTrial(binding, fixture.id)).rejects.toMatchObject({ reason: 'invalid-response' })
    }
    runtimeRequest.mockResolvedValueOnce({ ok: true, status: 200, body: ' '.repeat(8 * 1024 * 1024 + 1) })
    await expect(readFreeLevelingTrial(binding, fixture.id)).rejects.toMatchObject({ reason: 'invalid-response' })
  })
  it('rejects substituted history fingerprints after selecting a summary', async () => {
    runtimeRequest.mockResolvedValueOnce(response({ ...fixture, outputHash: 'a'.repeat(64) }))
    await expect(readFreeLevelingTrial(binding, fixture.id, fixture)).rejects.toMatchObject({ reason: 'invalid-response' })
  })
  it('encodes identifiers, rejects stale list bindings and nonadvancing pagination, and never leaks an unknown error', async () => {
    const encoded = { ...binding, projectId: 'p/a', networkId: 'n ?' }
    runtimeRequest.mockResolvedValueOnce(response({ ...fixture, ...encoded }))
    await createFreeLevelingTrial(encoded, 'request-1')
    expect(runtimeRequest.mock.calls[0]![0]).toContain('/projects/p%2Fa/networks/n%20%3F/')
    for (const value of [{ trials: [{ ...summary, networkRevision: 3 }], nextOffset: null }, { trials: [summary], nextOffset: 0 }]) {
      runtimeRequest.mockResolvedValueOnce(response(value))
      await expect(listFreeLevelingTrials(binding)).rejects.toMatchObject({ reason: 'invalid-response' })
    }
    runtimeRequest.mockResolvedValueOnce({ ok: false, status: 500, body: 'PRIVATE /path' })
    await expect(readFreeLevelingTrial(binding, fixture.id)).rejects.toMatchObject({ reason: 'request-failed', message: 'request-failed' })
  })
})
