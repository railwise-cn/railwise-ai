// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { advancedTrialTestRequest, maximumNewAdvancedTrialRequest, maximumReferenceDatumRequest, maximumStaticIncrementalRequest } from '../../../../../kun/src/engineering/survey-advanced-trials-test-helpers'
import { SurveyAdvancedTrialsWorkspaceService } from '../../../../../kun/src/engineering/survey-advanced-trials-workspace'
import { SurveyAdvancedModelWorkspace } from './SurveyAdvancedModelWorkspace'
import { advancedTrialSummary, readAdvancedTrial, validateAdvancedTrialInput, type AdvancedTrialBinding, type AdvancedTrialInput } from '../../agent/survey-advanced-trials-client'
import i18n from '../../i18n'
import { EngineeringEvidenceQuestions } from './EngineeringEvidenceQuestion'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'
import { selectSurveyEvidence } from '../../../../../kun/src/engineering/survey-evidence-reader'

const response = (body: unknown) => ({ ok: true, status: 200, body: JSON.stringify(body) })
const runtimeRequest = vi.fn()
const saveWorkspaceFileAs = vi.fn()
let host: HTMLDivElement, root: Root, dir: string, binding: AdvancedTrialBinding, service: SurveyAdvancedTrialsWorkspaceService, clock: number
const basis = '独立声明完整线性模型；来源未核实。\nSynthetic model, not a professional signature.'
const w = {
  schemaVersion: 1, model: 'fixed-linear-full-column-rank', purpose: 'declared-model-readonly-diagnostic', residualConvention: 'observed-minus-adjusted',
  observationUnit: 'm', observationIds: ['a', 'b', 'c'], parameterIds: ['mean'], parameterUnits: ['m'], designMatrix: [[1], [1], [1]], observations: [0, 11, 2],
  covariance: { kind: 'known-apriori-absolute-observation-covariance', basisStatement: 'Synthetic known C.', matrix: [[4, 1, 0], [1, 9, 0], [0, 0, 1]] },
  family: { id: 'family', alpha: .05, tail: 'two-sided', declaration: 'caller-declared-before-evaluation' },
  biasDirections: [{ id: 'first-axis', coefficients: [1, 0, 0] }, { id: 'common-mode', coefficients: [1, 1, 1] }]
}
const vce = {
  schemaVersion: 1, model: 'fixed-linear-independent-disjoint-variance-groups', unit: 'mm', parameterIds: [' mean '],
  groups: [{ id: ' group ', initialVariance: 1, sourceAnchor: ' source ' }],
  observations: [0, 1, 2].map((value, i) => ({ id: ` observation-${i} `, value, coefficients: [1], groupId: ' group ', relativeVariance: 1, sourceAnchor: ' source ' })),
  maxIterations: 30, relativeTolerance: 1e-10
}
const input = (kind: AdvancedTrialInput['kind'] = 'generalized-w', model: unknown = kind === 'generalized-w' ? w : vce): AdvancedTrialInput => ({ kind, declarationJson: ` \n${JSON.stringify(model, null, 2)}\n`, modelBasisStatement: basis })
function stored(selected = input(), key = 'existing-trial-1') {
  clock += 60_001
  const summary = service.createTrial(binding.projectId, Buffer.from(JSON.stringify({ ...selected, acknowledged: true, expectedProjectRevision: binding.projectRevision, idempotencyKey: key })))
  return { summary, record: service.getTrial(binding.projectId, summary.id) }
}
function handle(path: string, method = 'GET', raw?: string) {
  clock += 60_001
  const url = new URL(path, 'http://localhost'), parts = url.pathname.split('/'), trialId = parts[6], action = parts[7]
  try {
    if (method === 'POST' && !trialId) return response(service.createTrial(binding.projectId, Buffer.from(raw!)))
    if (action === 'reverify') return response(service.reverifyTrial(binding.projectId, trialId!))
    if (trialId) return response(service.getTrial(binding.projectId, trialId))
    return response(service.listTrials(binding.projectId, Number(url.searchParams.get('limit') ?? 10), Number(url.searchParams.get('offset') ?? 0)))
  } catch (error) { return { ok: false, status: 409, body: JSON.stringify({ code: String((error as Error).message).replaceAll('-', '_') }) } }
}
async function render(overrides: Partial<Parameters<typeof SurveyAdvancedModelWorkspace>[0]> = {}) {
  await act(async () => root.render(createElement(SurveyAdvancedModelWorkspace, { binding, runtimeReady: true, ...overrides })))
}
async function click(target: HTMLElement) { await act(async () => target.click()) }
const button = (text: string): HTMLButtonElement => [...host.querySelectorAll('button')].find(item => item.textContent === text)!
function field<T extends HTMLElement>(text: string): T { return [...host.querySelectorAll('label')].find(label => label.querySelector('span')?.textContent === text)!.querySelector('input,textarea,select') as unknown as T }
async function edit(label: string, value: string) {
  const target = field<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(label)
  await act(async () => {
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : target instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(target, value)
    target.dispatchEvent(new Event(target instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
}
const ack = () => field<HTMLInputElement>('I have checked the declared model and basis and confirm saving an independent experimental trial only. I understand that assumptions are unverified and results do not constitute engineering approval.')
async function fill(selected = input()) {
  await edit('Trial method', selected.kind); await edit('Model basis statement', selected.modelBasisStatement)
  await edit('Complete trial request JSON', selected.declarationJson)
}
async function save(selected = input()) { await fill(selected); await click(ack()); await click(button('Confirm and save trial')); await loaded() }
async function loaded() { await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); expect(button('Reverify and replay')).toBeDefined() }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(crypto, 'subtle', { configurable: true, value: webcrypto.subtle })
  await i18n.changeLanguage('en')
  dir = mkdtempSync(join(tmpdir(), 'advanced-desktop-')); binding = { projectId: 'project-a', projectRevision: 1, workspaceRoot: join(dir, 'workspace') }
  clock = Date.parse('2026-09-20T00:00:00.000Z')
  service = new SurveyAdvancedTrialsWorkspaceService({ rootDir: dir, getProject: id => id === binding.projectId ? { id, revision: binding.projectRevision, workspace: binding.workspaceRoot } : null, nowIso: () => new Date(clock).toISOString(), clockMs: () => clock })
  runtimeRequest.mockReset().mockImplementation(handle); saveWorkspaceFileAs.mockReset().mockResolvedValue({ ok: true, path: '/chosen/trial.json' })
  Object.assign(window, { workwise: { runtimeRequest, saveWorkspaceFileAs } })
  host = document.createElement('div'); host.style.width = '960px'; document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); service.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('declared advanced model desktop workflow', () => {
  it.each(['generalized-w', 'vce', 'huber', 'statistical-family', 'reference-datum', 'static-incremental'] as const)('prepares exact stored %s evidence and a resolvable selected result without another Runtime call', async kind => {
    const focus = vi.fn(), key = JSON.stringify([binding.workspaceRoot, binding.projectId])
    useEngineeringConversationDrafts.setState({ drafts: {} })
    await act(async () => root.render(createElement(EngineeringEvidenceQuestions, { scope: { workspace: binding.workspaceRoot, projectId: binding.projectId, projectRevision: binding.projectRevision, ready: true, focus }, children: createElement(SurveyAdvancedModelWorkspace, { binding, runtimeReady: true }) })))
    await save(input(kind, JSON.parse(advancedTrialTestRequest(kind).declarationJson)))
    const record = service.getTrial(binding.projectId, service.listTrials(binding.projectId).trials[0]!.id)
    runtimeRequest.mockClear()
    const questions = [...host.querySelectorAll<HTMLButtonElement>('button[title]')].filter(button => button.getAttribute('aria-label')?.startsWith('Ask Survey AI'))
    expect(questions.length).toBeGreaterThan(1)
    await click(questions[0]!)
    expect(useEngineeringConversationDrafts.getState().drafts[key]!.evidenceContext!.typedEvidence).toEqual({ schemaVersion: 1, projectId: binding.projectId, projectRevision: binding.projectRevision, kind: 'advanced-trial', trialId: record.id, recordHash: record.recordHash })
    await click(questions.at(-1)!)
    const evidence = useEngineeringConversationDrafts.getState().drafts[key]!.evidenceContext!.typedEvidence!
    expect(evidence).toMatchObject({ kind: 'advanced-trial', trialId: record.id, recordHash: record.recordHash })
    expect(evidence.selector).toBeDefined()
    expect(selectSurveyEvidence(record, evidence.selector)).toBeDefined()
    expect(runtimeRequest).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledTimes(2)
    expect(useEngineeringConversationDrafts.getState().drafts[key]!.evidenceContext).not.toHaveProperty('adjustmentId')
  })

  it('requires an explicit model and confirmation, preserves raw evidence, and displays null directions plus all covariance cells', async () => {
    await render(); expect(runtimeRequest).not.toHaveBeenCalled(); expect(button('Confirm and save trial').disabled).toBe(true)
    expect(field<HTMLSelectElement>('Trial method').value).toBe('')
    await fill(); expect(ack().checked).toBe(false); expect(button('Confirm and save trial').disabled).toBe(true)
    await click(ack()); await edit('Model basis statement', basis + '\nchecked'); expect(ack().checked).toBe(false)
    await click(ack()); await click(button('Confirm and save trial')); await loaded()
    const raw = runtimeRequest.mock.calls[0]![2] as string, sent = JSON.parse(raw)
    expect(sent).toMatchObject({ ...input(), modelBasisStatement: basis + '\nchecked', acknowledged: true, expectedProjectRevision: 1, idempotencyKey: expect.any(String) })
    expect(host.textContent).toContain('Undetectable or numerically unresolved'); expect(host.textContent).toContain('Not computed')
    const covariance = host.querySelector('[aria-label="Full residual covariance matrix"]')!
    expect(covariance.querySelectorAll('tbody td')).toHaveLength(9)
    expect([...host.querySelectorAll('pre')].some(pre => pre.textContent === input().declarationJson)).toBe(true)
    expect(document.activeElement).toBe(host.querySelector('h3'))
    expect(host.querySelectorAll('[role="region"][tabindex="0"]').length).toBeGreaterThan(2)
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain('高级模型试算'); expect(host.textContent).toContain('不可探测或数值未分辨'); expect(host.textContent).not.toContain('advancedTitle')
  })
  it.each(['huber', 'statistical-family'] as const)('saves, restores, replays and exports %s with bilingual boundary information', async kind => {
    const model = JSON.parse(advancedTrialTestRequest(kind).declarationJson), selected = input(kind, model)
    await render(); await save(selected)
    if (kind === 'huber') {
      expect(host.textContent).toContain('Declared stopping conditions met')
      expect(host.textContent).toContain('Derived IRLS weight'); expect(host.textContent).toContain('0.333333')
      expect(host.querySelectorAll('[aria-label="Read-only Huber observation values"]')).toHaveLength(1)
      expect(host.textContent).toContain('No covariance, Gaussian WLS precision')
    } else {
      expect(host.textContent).toContain('full denominator 3')
      expect(host.textContent).toContain('No statistic supplied; retained in denominator')
      expect(host.querySelector('[aria-label="All declared statistical family members"]')?.querySelectorAll('tbody tr')).toHaveLength(3)
    }
    await click(button('Reverify and replay')); await loaded()
    await click(button('Reverify and export JSON')); await vi.waitFor(() => expect(saveWorkspaceFileAs).toHaveBeenCalledTimes(1))
    const payload = saveWorkspaceFileAs.mock.calls[0]![0], exported = JSON.parse(Buffer.from(payload.dataBase64, 'base64').toString('utf8'))
    expect(payload.suggestedName).toBe(`survey-${kind}-trial.json`)
    expect(exported.kind).toBe(kind); expect(exported.declarationJson).toBe(selected.declarationJson)
    await click(button('Trial history')); await vi.waitFor(() => expect(host.textContent).toContain('Strictly verify and restore'))
    await click([...host.querySelectorAll('button')].find(item => item.textContent?.includes('Strictly verify and restore'))!); await loaded()
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain(kind === 'huber' ? 'Huber 试算结果' : '统计检验族结果')
    expect(host.textContent).toContain(kind === 'huber' ? '派生 IRLS 权' : '完整分母 3')
    expect(host.textContent).not.toContain('advancedHuber'); expect(host.textContent).not.toContain('advancedStatistical')
  })
  it('shows declared degrees of freedom beside distinct Student t probabilities and the chi-square prior scale', async () => {
    const model = JSON.parse(advancedTrialTestRequest('statistical-family').declarationJson)
    model.members = [1, 30].map(df => ({ id: `t-${df}`, sourceAnchor: `unaltered-t-source-${df}`, distribution: { kind: 'student-t', tail: 'two-sided', statisticBasis: 'externally-studentized', degreesOfFreedom: df } }))
    model.members.push({ id: 'chi', sourceAnchor: 'unaltered-chi-source', distribution: { kind: 'chi-square', tail: 'upper', statisticBasis: 'quadratic-form-divided-by-known-prior-variance', degreesOfFreedom: 20, scaleBasis: 'caller-declared-known-prior-standard-deviation', priorStandardDeviation: 2, scaleUnit: 'mm' } })
    model.statistics = [{ memberId: 't-1', status: 'available', value: 3 }, { memberId: 't-30', status: 'available', value: 3 }, { memberId: 'chi', status: 'available', value: 20 }]
    await render(); await save(input('statistical-family', model))
    const rows = host.querySelector('[aria-label="All declared statistical family members"]')!.querySelectorAll('tbody tr')
    expect(rows[0]!.textContent).toContain('df 1'); expect(rows[1]!.textContent).toContain('df 30')
    expect(Number(rows[0]!.querySelectorAll('td')[2]!.textContent)).toBeGreaterThan(.2)
    expect(Number(rows[1]!.querySelectorAll('td')[2]!.textContent)).toBeLessThan(.006)
    expect(rows[2]!.textContent).toContain('df 20'); expect(rows[2]!.textContent).toContain('Declared prior standard deviation 2 mm')
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain('自由度 30'); expect(host.textContent).toContain('声明先验标准差 2 mm')
    expect(host.textContent).toContain('unaltered-t-source-30')
  })
  it('does not collapse a narrow statistical resolution interval through display rounding', async () => {
    const selected = input('statistical-family', JSON.parse(maximumNewAdvancedTrialRequest('statistical-family').declarationJson))
    const { record } = stored(selected)
    if (record.kind !== 'statistical-family' || record.result.outcome !== 'evaluated') throw new Error('Expected evaluated family')
    const narrow = record.result.results.find(member => member.status === 'calculated'
      && member.numericalResolutionInterval[0].toPrecision(12) === member.numericalResolutionInterval[1].toPrecision(12))
    if (!narrow || narrow.status !== 'calculated') throw new Error('Expected a narrow high-df interval')
    const [lower, upper] = narrow.numericalResolutionInterval
    expect(lower).toBeLessThan(upper)
    await render(); await save(selected)
    expect(host.textContent).toContain(`[${lower}, ${upper}]`)
  })
  it('restores reordered statistical subsets using the frozen kernel normalization while retaining raw evidence and family order', async () => {
    const model = JSON.parse(advancedTrialTestRequest('statistical-family').declarationJson)
    model.statistics.reverse(); model.members.reverse(); model.familyId = ' padded-family '; model.members[0].sourceAnchor = ' padded-source '
    const selected = input('statistical-family', model), { summary, record } = stored(selected)
    expect(record.kind).toBe('statistical-family')
    if (record.kind !== 'statistical-family' || record.result.outcome !== 'evaluated') throw new Error('Expected evaluated statistical family')
    expect(record.declaration.statistics.map(item => item.memberId)).toEqual(['c', 'a'])
    expect(record.result.request.statistics.map(item => item.memberId)).toEqual(['a', 'c'])
    expect(record.result.results.map(item => item.memberId)).toEqual(['c', 'b', 'a'])
    expect(record.declarationJson).toBe(selected.declarationJson)
    runtimeRequest.mockResolvedValue(response(record))
    expect(await readAdvancedTrial(binding, summary)).toEqual(record)
    runtimeRequest.mockImplementation(handle)
    await render(); await save(selected); expect(host.textContent).toContain('padded-family')
    await click(button('Reverify and export JSON')); await vi.waitFor(() => expect(saveWorkspaceFileAs).toHaveBeenCalledTimes(1))
    const exported = JSON.parse(Buffer.from(saveWorkspaceFileAs.mock.calls[0]![0].dataBase64, 'base64').toString('utf8'))
    expect(exported.declarationJson).toBe(selected.declarationJson)
    expect(exported.declaration.statistics.map((item: { memberId: string }) => item.memberId)).toEqual(['c', 'a'])
  })
  it('keeps flat Huber uniqueness unestablished and exhausted iterates unaccepted', async () => {
    const model = JSON.parse(advancedTrialTestRequest('huber').declarationJson)
    model.observations[2].value = 10; model.initialParameters = [5]
    await render(); await save(input('huber', model))
    expect(host.textContent).toContain('Uniqueness is not established')
    const exhausted = JSON.parse(advancedTrialTestRequest('huber').declarationJson); exhausted.stopping.maxIterations = 1
    await save(input('huber', exhausted))
    expect(host.textContent).toContain('Iteration limit')
    expect(host.querySelector('[aria-label="Parameters"]')).toBeNull()
  })
  it.each(['huber', 'statistical-family'] as const)('rejects altered %s result requests before exposing a restored record', async kind => {
    const { summary, record } = stored(input(kind, JSON.parse(advancedTrialTestRequest(kind).declarationJson)))
    runtimeRequest.mockResolvedValue(response(record))
    expect(await readAdvancedTrial(binding, summary)).toEqual(record)
    const corrupted = structuredClone(record)
    if (corrupted.kind === 'huber') corrupted.result.request!.initialParameters[0] = 999
    else if (corrupted.kind === 'statistical-family' && corrupted.result.outcome === 'evaluated') corrupted.result.request.familyId = 'other-family'
    runtimeRequest.mockResolvedValue(response(corrupted))
    await expect(readAdvancedTrial(binding, summary)).rejects.toMatchObject({ reason: 'invalid-response' })
  })
  it('shows VCE normalization, initial groups, numerical convergence and the final refit without approval wording', async () => {
    await render(); await save(input('vce'))
    expect(host.textContent).toContain('Numerical trial convergence · Not engineering acceptance')
    expect(host.textContent).toContain('Declared groups and initial variances')
    expect(host.textContent).toContain('Parameters refitted under final variances (mm)')
    const normalized = [...host.querySelectorAll('pre')].map(item => item.textContent).find(text => text?.includes('"groupId": "group"'))
    expect(normalized).toBeDefined(); expect([...host.querySelectorAll('pre')].some(pre => pre.textContent === input('vce').declarationJson)).toBe(true)
  })
  it('shows a negative VCE candidate and stops without presenting a converged fit', async () => {
    const model = { ...vce, parameterIds: ['mean'], groups: ['g0', 'g1'].map(id => ({ id, initialVariance: 1, sourceAnchor: 'paper-example' })), observations: [1.6, .9, -.9, 3.6].map((value, i) => ({ id: `o${i}`, value, coefficients: [1], groupId: i < 2 ? 'g0' : 'g1', relativeVariance: 1, sourceAnchor: 'paper-example' })) }
    await render(); await save(input('vce', model))
    expect(host.textContent).toContain('Stopped at a nonpositive component'); expect(host.textContent).toContain('-1.48')
    expect(host.textContent).not.toContain('Parameters refitted under final variances')
  })
  it('blocks malformed, duplicate-key and oversized UTF-8 declarations without truncation or requests', async () => {
    await render(); await fill(); const duplicate = input().declarationJson.replace('"schemaVersion": 1', '"schemaVersion": 1,"schemaVersion": 1')
    await edit('Complete trial request JSON', duplicate); expect(button('Confirm and save trial').disabled).toBe(true)
    const oversized = '中'.repeat(100_000); await edit('Complete trial request JSON', oversized)
    expect(field<HTMLTextAreaElement>('Complete trial request JSON').value).toBe(oversized)
    expect(runtimeRequest).not.toHaveBeenCalled(); expect(button('Confirm and save trial').disabled).toBe(true)
  })
  it('paginates real history and isolates unavailable records', async () => {
    for (let index = 0; index < 11; index++) stored(input(), `history-item-${index}`)
    await render(); await click(button('Trial history'))
    await vi.waitFor(() => expect(host.querySelectorAll('button').length).toBeGreaterThan(12))
    expect(button('Next page').disabled).toBe(false); await click(button('Next page'))
    expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('offset=10')
    await vi.waitFor(() => expect(button('Next page').disabled).toBe(true))
    runtimeRequest.mockResolvedValueOnce(response({ trials: [], unavailable: [{ id: 'damaged', reason: 'integrity' }, { id: 'old', reason: 'stale' }, { id: 'other-engine', reason: 'replay-environment' }], nextOffset: null }))
    await click(button('Trial history')); expect(host.textContent).toContain('damaged'); expect(host.textContent).toContain('This does not by itself mean the record was tampered with')
    expect([...host.querySelectorAll('button')].some(item => item.textContent?.includes('Strictly verify and restore'))).toBe(false)
  })
  it('retries an uncertain save with exactly the same original body and key and suppresses double clicks', async () => {
    await render(); await fill(); await click(ack())
    runtimeRequest.mockImplementationOnce((path, method, body) => { handle(path, method, body); return Promise.reject(new Error('connection lost after save')) })
    await click(button('Confirm and save trial'))
    const first = runtimeRequest.mock.calls[0]![2]
    expect(field<HTMLTextAreaElement>('Complete trial request JSON').disabled).toBe(true)
    await click(button('Retry original request')); await loaded()
    expect(runtimeRequest.mock.calls[1]![2]).toBe(first)
    expect(service.listTrials(binding.projectId).trials).toHaveLength(1)
  })
  it('resolves an uncertain save by restoring the same request from history', async () => {
    await render(); await fill(); await click(ack())
    runtimeRequest.mockImplementationOnce((path, method, body) => { handle(path, method, body); return Promise.reject(new Error('lost response')) })
    await click(button('Confirm and save trial')); expect(field<HTMLTextAreaElement>('Complete trial request JSON').disabled).toBe(true)
    await click(button('Trial history'))
    await vi.waitFor(() => expect([...host.querySelectorAll('button')].some(item => item.textContent?.includes('Strictly verify and restore'))).toBe(true))
    await click([...host.querySelectorAll('button')].find(item => item.textContent?.includes('Strictly verify and restore'))!); await loaded()
    expect(field<HTMLTextAreaElement>('Complete trial request JSON').disabled).toBe(false)
    expect(host.textContent).not.toContain('The save outcome is not confirmed')
  })
  it.each(['project', 'revision', 'workspace', 'offline', 'cancel'] as const)('discards a late create response after %s without fetching its detail', async change => {
    const wait = deferred<ReturnType<typeof response>>(); let saved: ReturnType<typeof response> | undefined
    runtimeRequest.mockImplementationOnce((path, method, body) => { saved = handle(path, method, body); return wait.promise })
    await render(); await fill(); await click(ack()); await click(button('Confirm and save trial'))
    await click(button('Confirm and save trial'))
    if (change === 'cancel') await click(button('Stop waiting'))
    else await render(change === 'offline' ? { runtimeReady: false } : { binding: { ...binding, ...(change === 'project' ? { projectId: 'other' } : change === 'revision' ? { projectRevision: 2 } : { workspaceRoot: '/other-workspace' }) } })
    await act(async () => wait.resolve(saved!)); await new Promise(resolve => setTimeout(resolve, 10))
    expect(runtimeRequest).toHaveBeenCalledTimes(1); expect(button('Reverify and replay')).toBeUndefined()
  })
  it.each(['project', 'offline'] as const)('discards a late restored detail after %s', async change => {
    const { summary, record } = stored(), wait = deferred<ReturnType<typeof response>>()
    runtimeRequest.mockResolvedValueOnce(response({ trials: [summary], unavailable: [], nextOffset: null })).mockReturnValueOnce(wait.promise)
    await render(); await click(button('Trial history')); await vi.waitFor(() => expect(host.textContent).toContain(summary.id))
    await click([...host.querySelectorAll('button')].find(item => item.textContent?.includes('Strictly verify and restore'))!)
    await render(change === 'offline' ? { runtimeReady: false } : { binding: { ...binding, projectId: 'other' } })
    await act(async () => wait.resolve(response(record))); await new Promise(resolve => setTimeout(resolve, 10))
    expect(host.textContent).not.toContain(record.id); expect(button('Reverify and replay')).toBeUndefined()
  })
  it('does not issue the second GET if scope changes during reverify', async () => {
    await render(); await save(); const path = runtimeRequest.mock.calls[1]![0] as string
    const wait = deferred<ReturnType<typeof response>>(), result = handle(`${path}/reverify`, 'POST', '{}')
    runtimeRequest.mockReturnValueOnce(wait.promise); await click(button('Reverify and replay'))
    await render({ binding: { ...binding, projectRevision: 2 } })
    await act(async () => wait.resolve(result)); await new Promise(resolve => setTimeout(resolve, 10))
    expect(runtimeRequest).toHaveBeenCalledTimes(3)
  })
  it('strictly binds real records, normalized data and hashes without browser Buffer', async () => {
    const { summary, record } = stored(input('vce'))
    runtimeRequest.mockResolvedValue(response(Object.fromEntries(Object.entries(record).reverse())))
    vi.stubGlobal('Buffer', undefined)
    expect(await readAdvancedTrial(binding, summary)).toEqual(record)
    expect(validateAdvancedTrialInput(binding, input('vce'))).toBe(true)
    const corrupted = structuredClone(record); corrupted.modelBasisStatement += ' changed'
    runtimeRequest.mockResolvedValue(response(corrupted))
    await expect(readAdvancedTrial(binding, summary)).rejects.toMatchObject({ reason: 'invalid-response' })
    runtimeRequest.mockResolvedValue(response(record))
    await expect(readAdvancedTrial({ ...binding, workspaceRoot: '/different' }, summary)).rejects.toMatchObject({ reason: 'invalid-response' })
    expect(advancedTrialSummary(record)).toEqual(summary)
  })
  it('maps deterministic environment/validation errors without suggesting generic network retry', async () => {
    await render()
    runtimeRequest.mockResolvedValueOnce({ ok: false, status: 409, body: '{"code":"advanced_trials_replay_environment"}' })
    await click(button('Trial history')); expect(host.textContent).toContain('preventing exact replay'); expect(button('Retry original request')).toBeUndefined()
    runtimeRequest.mockResolvedValueOnce({ ok: false, status: 400, body: '{"code":"advanced_trials_validation"}' })
    await click(button('Trial history')); expect(host.textContent).toContain('strict contract'); expect(button('Retry original request')).toBeUndefined()
  })
  it('exports only a freshly replayed record through native Save As, preserving UTF-8 original input', async () => {
    await render(); await save(); await click(button('Reverify and export JSON'))
    await vi.waitFor(() => expect(saveWorkspaceFileAs).toHaveBeenCalledTimes(1))
    expect(runtimeRequest.mock.calls.at(-1)![0]).toMatch(/\/export$/)
    const payload = saveWorkspaceFileAs.mock.calls[0]![0]
    expect(payload).toMatchObject({ workspaceRoot: binding.workspaceRoot, suggestedName: 'survey-generalized-w-trial.json', mimeType: 'application/json' })
    const exported = JSON.parse(Buffer.from(payload.dataBase64, 'base64').toString('utf8'))
    expect(exported.declarationJson).toBe(input().declarationJson); expect(exported.modelBasisStatement).toBe(basis)
    expect(host.textContent).toContain('Saved as /chosen/trial.json')
    saveWorkspaceFileAs.mockResolvedValueOnce({ ok: false, canceled: true, message: 'cancelled' })
    await click(button('Reverify and export JSON')); await vi.waitFor(() => expect(host.textContent).toContain('Save As was cancelled'))
    saveWorkspaceFileAs.mockResolvedValueOnce({ ok: false, message: 'disk error' })
    await click(button('Reverify and export JSON')); await vi.waitFor(() => expect(host.textContent).toContain('Save As failed'))
    expect(button('Reverify and export JSON')).toBeDefined()
  })
  it('does not open Save As for a corrupted export or a late response after the scope changes', async () => {
    await render(); await save()
    runtimeRequest.mockResolvedValueOnce(response({ tampered: true }))
    await click(button('Reverify and export JSON')); expect(saveWorkspaceFileAs).not.toHaveBeenCalled()
    await save()
    const wait = deferred<ReturnType<typeof response>>(), latest = service.listTrials(binding.projectId).trials[0]!
    const record = service.getTrial(binding.projectId, latest.id)
    runtimeRequest.mockReturnValueOnce(wait.promise); await click(button('Reverify and export JSON'))
    await render({ binding: { ...binding, projectRevision: 2 } })
    await act(async () => wait.resolve(response(record))); await new Promise(resolve => setTimeout(resolve, 10))
    expect(saveWorkspaceFileAs).not.toHaveBeenCalled()
  })
})


describe('reference datum desktop workflow', () => {
  it('saves mapped epoch evidence and exposes the complete covariance without claiming stable points', async () => {
    const req = advancedTrialTestRequest('reference-datum')
    await render(); await save(input('reference-datum', JSON.parse(req.declarationJson)))
    expect(host.textContent).toContain('physical stability is not evaluated')
    expect(host.textContent).toContain('Reference shift 3 mm; shift variance 1 mm²')
    expect(host.textContent).toContain('caller-declared independence')
    expect(host.querySelector('[aria-label="Full displacement covariance"]')!.querySelectorAll('tbody td')).toHaveLength(9)
    const table = host.querySelector('[aria-label="Point mapping, reference weights and displacements"]')!
    expect([...table.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(x => x.textContent))).toEqual([['2','0.5','-1','0'],['4','0.5','1','0'],['7','0','4','-1']])
    await click(button('Reverify and export JSON'))
    await vi.waitFor(() => expect(saveWorkspaceFileAs).toHaveBeenCalledTimes(1))
    const payload = saveWorkspaceFileAs.mock.calls[0]![0]
    expect(payload.suggestedName).toBe('survey-reference-datum-trial.json')
    const exported = JSON.parse(Buffer.from(payload.dataBase64, 'base64').toString())
    expect(exported.declarationJson).toBe(input('reference-datum', JSON.parse(req.declarationJson)).declarationJson)
    expect(exported.result.sourceRecordsVerified).toBe(false)
    const summary = advancedTrialSummary(exported)
    runtimeRequest.mockResolvedValue(response(exported))
    vi.stubGlobal('Buffer', undefined)
    expect(await readAdvancedTrial(binding, summary)).toEqual(exported)
    await act(async () => i18n.changeLanguage('zh'))
    expect(host.textContent).toContain('物理稳定性未判定')
    expect(host.textContent).not.toMatch(/advancedReference[A-Z]/)
  })
  it('shows singular GLS failure and retained semidefinite qualification on an explicitly different method', async () => {
    const model = JSON.parse(advancedTrialTestRequest('reference-datum').declarationJson)
    model.firstEpoch.covariance = model.secondEpoch.covariance = [[1,-1,0],[-1,1,0],[0,0,1]]
    await render(); await save(input('reference-datum', model))
    expect(host.textContent).toContain('Reference covariance is singular, ill-conditioned or unresolved')
    expect(host.querySelector('[aria-label="Full displacement covariance"]')).toBeNull()
    model.method = 'equal-reference-mean'
    await save(input('reference-datum', model))
    expect(host.textContent).toContain('equal mean; no optimal-precision or stable-reference claim')
    expect(host.textContent).toContain('semidefinite or unresolved within numerical tolerance')
    expect(host.querySelector('[aria-label="Full displacement covariance"]')).not.toBeNull()
  })
  it('renders maximum cross-epoch covariance and mappings from a strictly replayed real record', async () => {
    const req = maximumReferenceDatumRequest()
    const { record } = stored(input('reference-datum', JSON.parse(req.declarationJson)))
    await render(); await click(button('Trial history'))
    await vi.waitFor(() => expect(host.textContent).toContain(record.id))
    await click([...host.querySelectorAll('button')].find(b => b.textContent?.includes('Strictly verify and restore'))!)
    await loaded()
    expect(host.textContent).toContain('caller-declared full cross covariance')
    expect(host.querySelector('[aria-label="Full displacement covariance"]')!.querySelectorAll('tbody td')).toHaveLength(1024)
    expect(host.querySelector('[aria-label="Point mapping, reference weights and displacements"]')!.querySelectorAll('tbody tr')).toHaveLength(32)
    expect(host.querySelector('[aria-label="Two-epoch comparison under declared references"]')!.textContent).not.toMatch(/NaN|Infinity|undefined|advancedReference[A-Z]/)
  })
})

describe('static append desktop workflow', () => {
  it('saves the explicit model, displays counts/prior covariance/steps, replays, restores and natively exports exact evidence', async () => {
    const model = JSON.parse(advancedTrialTestRequest('static-incremental').declarationJson), selected = input('static-incremental', model)
    await render(); await save(selected)
    expect(host.textContent).toContain('Existing 3 · Appended 2 · Total observations 5')
    expect(host.textContent).toContain('not authenticated source files or prior runtime state')
    expect(host.textContent).toContain('no normality claim')
    expect(host.querySelector('[aria-label="Updated prior parameter covariance"]')?.querySelectorAll('tbody td')).toHaveLength(1)
    expect(host.querySelector('[aria-label="Per-observation update state"]')?.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(host.textContent).toContain('not used to scale prior covariance')
    await click(button('Reverify and replay')); await loaded()
    await click(button('Reverify and export JSON')); await vi.waitFor(() => expect(saveWorkspaceFileAs).toHaveBeenCalledTimes(1))
    const payload = saveWorkspaceFileAs.mock.calls[0]![0], exported = JSON.parse(Buffer.from(payload.dataBase64, 'base64').toString('utf8'))
    expect(payload.suggestedName).toBe('survey-static-incremental-trial.json')
    expect(exported).toMatchObject({ kind: 'static-incremental', baseObservationCount: 3, appendedObservationCount: 2, observationCount: 5, declarationJson: selected.declarationJson })
    expect(exported.result.request.base.observations).toEqual(model.base.observations)
    await click(button('Trial history')); await vi.waitFor(() => expect(host.textContent).toContain('Strictly verify and restore'))
    expect(host.textContent).toContain('Existing 3 · Appended 2 · Total observations 5')
    await click([...host.querySelectorAll('button')].find(item => item.textContent?.includes('Strictly verify and restore'))!); await loaded()
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain('静态观测追加结果'); expect(host.textContent).toContain('原有 3 条 · 追加 2 条 · 总观测 5 条')
    expect(host.textContent).toContain('先验协方差'); expect(host.textContent).toContain('来源、独立性、零均值与先验方差均未验真')
    expect(host.textContent).not.toContain('advancedStatic')
  })
  it('renders an unavailable fingerprint mismatch without an accepted fit and keeps the raw declaration', async () => {
    const model = JSON.parse(advancedTrialTestRequest('static-incremental').declarationJson)
    model.base.observations[0].value += 1
    const selected = input('static-incremental', model)
    await render(); await save(selected)
    expect(host.textContent).toContain('Append refused: base fingerprint differs from the declaration.')
    expect(host.querySelector('[aria-label="Parameter comparison"]')).toBeNull()
    expect([...host.querySelectorAll('pre')].some(pre => pre.textContent === selected.declarationJson)).toBe(true)
  })
  it('rejects missing zero-mean declaration before any Runtime request', async () => {
    const model = JSON.parse(advancedTrialTestRequest('static-incremental').declarationJson)
    delete model.base.errorModel
    await render(); await fill(input('static-incremental', model))
    expect(button('Confirm and save trial').disabled).toBe(true)
    expect(runtimeRequest).not.toHaveBeenCalled()
  })
  it('does not relabel native export cancellation as success', async () => {
    saveWorkspaceFileAs.mockResolvedValueOnce({ ok: false, canceled: true })
    await render(); await save(input('static-incremental', JSON.parse(advancedTrialTestRequest('static-incremental').declarationJson)))
    await click(button('Reverify and export JSON'))
    await vi.waitFor(() => expect(host.textContent).toContain('Save As was cancelled'))
    expect(host.textContent).not.toContain('Saved to')
  })
})


it('restores all 128 appended rows and 16-by-16 prior covariance matrices at the declared capacity', async () => {
  const req = maximumStaticIncrementalRequest(), selected = input('static-incremental', JSON.parse(req.declarationJson))
  stored(selected)
  await render(); await click(button('Trial history'))
  await vi.waitFor(() => expect(host.textContent).toContain('Existing 128 · Appended 128 · Total observations 256'))
  await click([...host.querySelectorAll('button')].find(item => item.textContent?.includes('Strictly verify and restore'))!); await loaded()
  expect(host.querySelector('[aria-label="Per-observation update state"]')?.querySelectorAll('tbody tr')).toHaveLength(128)
  expect(host.querySelector('[aria-label="Updated prior parameter covariance"]')?.querySelectorAll('tbody td')).toHaveLength(256)
  expect(host.querySelector('[aria-label="Existing prior parameter covariance"]')?.querySelectorAll('tbody td')).toHaveLength(256)
  expect(host.querySelector('[aria-label="Parameter comparison"]')?.querySelectorAll('tbody tr')).toHaveLength(16)
})
