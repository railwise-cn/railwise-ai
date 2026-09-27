// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurveyQualityScoringWorkspaceService } from '../../../../../kun/src/engineering/survey-quality-scoring-workspace'
import { SurveyQualityScoringWorkspace } from './SurveyQualityScoringWorkspace'
import { qualityScoringSummary, readQualityScoring, validateQualityScoringInput, type QualityScoringBinding, type QualityScoringInput } from '../../agent/survey-quality-scoring-client'
import i18n from '../../i18n'
import { qualityScoringTestDeclaration } from '../../../../../kun/src/engineering/survey-quality-scoring-test-helpers'
import { qualityScoringExample } from './survey-quality-scoring-examples'
import { SurveyQualityScoringInputV1 } from '@shared/survey-quality-scoring'
import { EngineeringEvidenceQuestions } from './EngineeringEvidenceQuestion'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'

const response = (body: unknown) => ({ ok: true, status: 200, body: JSON.stringify(body) })
const runtimeRequest = vi.fn()
const saveWorkspaceFileAs = vi.fn()
let host: HTMLDivElement, root: Root, dir: string, binding: QualityScoringBinding, service: SurveyQualityScoringWorkspaceService, clock: number
const basis = '独立声明完整线性模型；来源未核实。\nSynthetic model, not a professional signature.'
const input = (kind: 'accuracy' | 'unit' = 'accuracy', model: unknown = qualityScoringTestDeclaration(kind)): QualityScoringInput => ({ kind, declarationJson: ` \n${JSON.stringify(model, null, 2)}\n`, modelBasisStatement: basis })
function stored(selected = input(), key = 'existing-trial-1') {
  clock += 60_001
  const summary = service.createRecord(binding.projectId, Buffer.from(JSON.stringify({ ...selected, acknowledged: true, expectedProjectRevision: binding.projectRevision, idempotencyKey: key })))
  return { summary, record: service.getRecord(binding.projectId, summary.id) }
}
function handle(path: string, method = 'GET', raw?: string) {
  clock += 60_001
  const url = new URL(path, 'http://localhost'), parts = url.pathname.split('/'), trialId = parts[6], action = parts[7]
  try {
    if (method === 'POST' && !trialId) return response(service.createRecord(binding.projectId, Buffer.from(raw!)))
    if (action === 'reverify') return response(service.reverifyRecord(binding.projectId, trialId!))
    if (trialId) return response(service.getRecord(binding.projectId, trialId))
    return response(service.listRecords(binding.projectId, Number(url.searchParams.get('limit') ?? 10), Number(url.searchParams.get('offset') ?? 0)))
  } catch (error) { return { ok: false, status: 409, body: JSON.stringify({ code: String((error as Error).message).replaceAll('-', '_') }) } }
}
async function render(overrides: Partial<Parameters<typeof SurveyQualityScoringWorkspace>[0]> = {}) {
  await act(async () => root.render(createElement(SurveyQualityScoringWorkspace, { binding, runtimeReady: true, ...overrides })))
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
const ack = () => field<HTMLInputElement>('I confirm saving this declared inspection trial. Evidence and classifications remain unverified; the result is not engineering approval or a signature.')
async function fill(selected = input()) {
  await edit('Scoring stage', selected.kind); await edit('Inspection basis and evidence statement', selected.modelBasisStatement)
  await edit('Complete scoring declaration JSON', selected.declarationJson)
}
async function save(selected = input()) { await fill(selected); await click(ack()); await click(button('Calculate and save declared record')); await loaded() }
async function loaded() { await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }); expect(button('Reverify and replay')).toBeDefined() }) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(crypto, 'subtle', { configurable: true, value: webcrypto.subtle })
  await i18n.changeLanguage('en')
  dir = mkdtempSync(join(tmpdir(), 'advanced-desktop-')); binding = { projectId: 'project-a', projectRevision: 1, workspaceRoot: join(dir, 'workspace') }
  clock = Date.parse('2026-09-20T00:00:00.000Z')
  service = new SurveyQualityScoringWorkspaceService({ rootDir: dir, getProject: id => id === binding.projectId ? { id, revision: binding.projectRevision, workspace: binding.workspaceRoot } : null, nowIso: () => new Date(clock).toISOString(), clockMs: () => clock })
  runtimeRequest.mockReset().mockImplementation(handle); saveWorkspaceFileAs.mockReset().mockResolvedValue({ ok: true, path: '/chosen/trial.json' })
  Object.assign(window, { workwise: { runtimeRequest, saveWorkspaceFileAs } })
  host = document.createElement('div'); host.style.width = '960px'; document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); service.close(); rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('declared advanced model desktop workflow', () => {
  it('prepares a node question from the selected saved score with no new calculation', async () => {
    const selected = stored(input('unit')), focus = vi.fn()
    useEngineeringConversationDrafts.setState({ drafts: {} })
    await act(async () => root.render(createElement(EngineeringEvidenceQuestions, { scope: { workspace: binding.workspaceRoot, projectId: binding.projectId, projectRevision: binding.projectRevision, ready: true, focus }, children: createElement(SurveyQualityScoringWorkspace, { binding, runtimeReady: true }) })))
    await click(button('Scoring record history'))
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect([...host.querySelectorAll('button')].some(item => item.textContent?.includes(selected.record.id))).toBe(true)
    })
    await click([...host.querySelectorAll('button')].find(item => item.textContent?.includes(selected.record.id))!); await loaded()
    const row = selected.record.result.trace[0]!
    runtimeRequest.mockClear(); await click(host.querySelector('tbody tr button')!)
    expect(runtimeRequest).not.toHaveBeenCalled(); expect(saveWorkspaceFileAs).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledOnce()
    expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify([binding.workspaceRoot, binding.projectId])]?.evidenceContext?.typedEvidence).toEqual({ schemaVersion: 1, projectId: binding.projectId, projectRevision: binding.projectRevision, kind: 'scoring', recordId: selected.record.id, recordHash: selected.record.recordHash, selector: { path: ['result', 'trace', 0], identity: { nodeId: row.nodeId, clause: row.clause } } })
    await click(button('Scoring record history'))
    await vi.waitFor(async () => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
      expect(host.querySelector('tbody tr button')).toBeNull()
    })
  })

  it('has complete Chinese and English messages for all displayed rules and static controls', () => {
    const components = ['SurveyQualityScoringWorkspace.tsx', 'SurveyQualityScoringResult.tsx'].map(name => readFileSync(join(process.cwd(), 'src/renderer/src/components/engineering', name), 'utf8')).join('\n')
    const rules = ['survey-quality-scoring.ts', 'survey-quality-scoring-rules.ts'].map(name => readFileSync(join(process.cwd(), 'kun/src/engineering', name), 'utf8')).join('\n')
    const reasonKeys = [...rules.matchAll(/(?:invalid|unavailable|nonconforming)\('([^']+)'\)/g)].map(match => `reasons.${match[1]}`)
    const controlKeys = [...components.matchAll(/'((?:scoring)[A-Z][A-Za-z]+)'/g)].map(match => match[1]!)
    for (const lng of ['en','zh']) for (const key of [...reasonKeys, ...controlKeys]) expect(i18n.exists(key!, { ns: 'qualityScoring', lng }), `${lng}:${key}`).toBe(true)
  })
  it('requires declaration and confirmation, preserves exact fractions, and localizes the result', async () => {
    await render(); expect(runtimeRequest).not.toHaveBeenCalled(); expect(button('Calculate and save declared record').disabled).toBe(true)
    await fill(); expect(ack().checked).toBe(false)
    await click(ack()); await edit('Inspection basis and evidence statement', basis + '\nchecked'); expect(ack().checked).toBe(false)
    await click(ack()); await click(button('Calculate and save declared record')); await loaded()
    expect(host.textContent).toContain('100/1'); expect(host.textContent).toContain('Declared component only')
    expect(host.textContent).toContain('Evidence references, defect classification and prior batch qualification are unverified')
    expect([...host.querySelectorAll('pre')].some(pre => pre.textContent === input().declarationJson)).toBe(true)
    expect(document.activeElement).toBe(host.querySelector('h3'))
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain('质量评分试算'); expect(host.textContent).toContain('仅本次声明单项'); expect(host.textContent).not.toContain('scoringTitle')
  })
  it('distinguishes exact partial grade from full-product qualification and retains pending/A veto traces', async () => {
    const model = qualityScoringTestDeclaration('unit')
    if (model.operation !== 'unit') throw new Error('fixture')
    model.leaves = model.leaves.map(leaf => leaf.subelementId === 'mathematical-accuracy' || leaf.elementId === 'point-quality' ? leaf : { elementId: leaf.elementId, subelementId: leaf.subelementId, state: 'excluded', reason: 'explicit scope', evidenceRefs: ['scope'] })
    const math = model.leaves[0]!, selection = model.leaves[3]!
    if (math.state === 'checked' && math.record.kind === 'accuracy') math.record.model.items[0]!.m = '1'
    if (selection.state === 'checked' && selection.record.kind === 'deduction') selection.record.defects.d = 20
    await render(); await save(input('unit', model))
    expect(host.textContent).toContain('285/4'); expect(host.textContent).toContain('Partial product scope only')
    expect(host.textContent).toContain('Grade for this partial scope (not full product)')
    expect(host.querySelector('[aria-label="Inspect calculation trace and hierarchical weights"]')).not.toBeNull()
    model.leaves[1] = { elementId: 'data-quality', subelementId: 'observation-quality', state: 'pending', reason: 'not yet inspected', evidenceRefs: ['pending'] }
    if (selection.state === 'checked' && selection.record.kind === 'deduction') selection.record.defects.a = 1
    await save(input('unit', model))
    expect(host.textContent).toContain('Product scope has pending items'); expect(host.textContent).toContain('Declared record nonconforming')
    expect(host.textContent).toContain('42/1'); expect(host.textContent).not.toContain('285/4')
  })
  it('offers strict templates for all seven stages in both product profiles without filling data', async () => {
    for (const kind of ['accuracy','deduction','unit','overview','sample','final-batch','acceptance-batch'] as const) for (const profile of ['planar-control-point','height-control-section'] as const) {
      expect(SurveyQualityScoringInputV1.safeParse(qualityScoringExample(kind, profile)).success).toBe(true)
    }
    await render(); await edit('Scoring stage', 'unit')
    expect(field<HTMLTextAreaElement>('Complete scoring declaration JSON').value).toBe('')
    await edit('Product profile', 'height-control-section')
    expect(host.textContent).toContain('"profileWeightTable": 45')
    expect(runtimeRequest).not.toHaveBeenCalled()
  })
  it.each(['full', 'child-veto', 'pending', 'multiple-sixty'] as const)('shows the packaged acceptance case without changing its raw JSON: %s', async name => {
    const declarationJson = readFileSync(join(process.cwd(), `docs/qa/evidence/railwise-quality-scoring-workspace/fixtures/quality-${name}.json`), 'utf8')
    await render(); await save({ kind: name === 'multiple-sixty' ? 'accuracy' : 'unit', declarationJson, modelBasisStatement: basis })
    expect([...host.querySelectorAll('pre')].some(pre => pre.textContent === declarationJson)).toBe(true)
    expect(host.textContent).toContain(name === 'full' ? '9141/100' : name === 'child-veto' ? '52/1' : name === 'pending' ? 'Product scope has pending items' : 'exactly 60')
    expect(host.textContent).toContain(name === 'full' ? 'Full product profile' : name === 'child-veto' ? 'Declared record nonconforming' : 'Insufficient evidence or unsupported branch')
  })
  it('restores height records with their own product and stage even while the draft selector is planar', async () => {
    const model = qualityScoringExample('accuracy', 'height-control-section')
    if (model.operation !== 'accuracy') throw new Error('fixture')
    model.model.items[0]!.m = '0.3'; model.model.items[0]!.m0 = '1'; model.model.aCount = 0
    const { summary } = stored({ kind: 'accuracy', declarationJson: JSON.stringify(model), modelBasisStatement: basis })
    await render(); await click(button('Scoring record history'))
    await vi.waitFor(() => expect(host.textContent).toContain(summary.id))
    await click([...host.querySelectorAll('button')].find(item => item.textContent?.includes('Strictly verify and restore'))!); await loaded()
    expect(host.textContent).toContain('Height control · Section (tables 45/46) · Mathematical accuracy · GB/T 24356-2023')
  })
  it('blocks malformed, duplicate-key and oversized UTF-8 declarations without truncation or requests', async () => {
    await render(); await fill(); const duplicate = input().declarationJson.replace('"schemaVersion": 1', '"schemaVersion": 1,"schemaVersion": 1')
    await edit('Complete scoring declaration JSON', duplicate); expect(button('Calculate and save declared record').disabled).toBe(true)
    const oversized = '中'.repeat(100_000); await edit('Complete scoring declaration JSON', oversized)
    expect(field<HTMLTextAreaElement>('Complete scoring declaration JSON').value).toBe(oversized)
    expect(runtimeRequest).not.toHaveBeenCalled(); expect(button('Calculate and save declared record').disabled).toBe(true)
  })
  it('paginates real history and isolates unavailable records', async () => {
    for (let index = 0; index < 11; index++) stored(input(), `history-item-${index}`)
    await render(); await click(button('Scoring record history'))
    await vi.waitFor(() => expect(host.querySelectorAll('button').length).toBeGreaterThan(12))
    expect(button('Next page').disabled).toBe(false); await click(button('Next page'))
    expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('offset=10')
    await vi.waitFor(() => expect(button('Next page').disabled).toBe(true))
    runtimeRequest.mockResolvedValueOnce(response({ records: [], unavailable: [{ id: 'damaged', reason: 'integrity' }, { id: 'old', reason: 'stale' }, { id: 'other-engine', reason: 'replay-environment' }], nextOffset: null }))
    await click(button('Scoring record history')); expect(host.textContent).toContain('damaged'); expect(host.textContent).toContain('This does not by itself mean the record was tampered with')
    expect([...host.querySelectorAll('button')].some(item => item.textContent?.includes('Strictly verify and restore'))).toBe(false)
  })
  it('retries an uncertain save with exactly the same original body and key and suppresses double clicks', async () => {
    await render(); await fill(); await click(ack())
    runtimeRequest.mockImplementationOnce((path, method, body) => { handle(path, method, body); return Promise.reject(new Error('connection lost after save')) })
    await click(button('Calculate and save declared record'))
    const first = runtimeRequest.mock.calls[0]![2]
    expect(field<HTMLTextAreaElement>('Complete scoring declaration JSON').disabled).toBe(true)
    await click(button('Retry original request')); await loaded()
    expect(runtimeRequest.mock.calls[1]![2]).toBe(first)
    expect(service.listRecords(binding.projectId).records).toHaveLength(1)
  })
  it('resolves an uncertain save by restoring the same request from history', async () => {
    await render(); await fill(); await click(ack())
    runtimeRequest.mockImplementationOnce((path, method, body) => { handle(path, method, body); return Promise.reject(new Error('lost response')) })
    await click(button('Calculate and save declared record')); expect(field<HTMLTextAreaElement>('Complete scoring declaration JSON').disabled).toBe(true)
    await click(button('Scoring record history'))
    await vi.waitFor(() => expect([...host.querySelectorAll('button')].some(item => item.textContent?.includes('Strictly verify and restore'))).toBe(true))
    await click([...host.querySelectorAll('button')].find(item => item.textContent?.includes('Strictly verify and restore'))!); await loaded()
    expect(field<HTMLTextAreaElement>('Complete scoring declaration JSON').disabled).toBe(false)
    expect(host.textContent).not.toContain('The save outcome is not confirmed')
  })
  it.each(['project', 'revision', 'workspace', 'offline', 'cancel'] as const)('discards a late create response after %s without fetching its detail', async change => {
    const wait = deferred<ReturnType<typeof response>>(); let saved: ReturnType<typeof response> | undefined
    runtimeRequest.mockImplementationOnce((path, method, body) => { saved = handle(path, method, body); return wait.promise })
    await render(); await fill(); await click(ack()); await click(button('Calculate and save declared record'))
    await click(button('Calculate and save declared record'))
    if (change === 'cancel') await click(button('Stop waiting'))
    else await render(change === 'offline' ? { runtimeReady: false } : { binding: { ...binding, ...(change === 'project' ? { projectId: 'other' } : change === 'revision' ? { projectRevision: 2 } : { workspaceRoot: '/other-workspace' }) } })
    await act(async () => wait.resolve(saved!)); await new Promise(resolve => setTimeout(resolve, 10))
    expect(runtimeRequest).toHaveBeenCalledTimes(1); expect(button('Reverify and replay')).toBeUndefined()
  })
  it.each(['project', 'offline'] as const)('discards a late restored detail after %s', async change => {
    const { summary, record } = stored(), wait = deferred<ReturnType<typeof response>>()
    runtimeRequest.mockResolvedValueOnce(response({ records: [summary], unavailable: [], nextOffset: null })).mockReturnValueOnce(wait.promise)
    await render(); await click(button('Scoring record history')); await vi.waitFor(() => expect(host.textContent).toContain(summary.id))
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
    const { summary, record } = stored(input('unit'))
    runtimeRequest.mockResolvedValue(response(Object.fromEntries(Object.entries(record).reverse())))
    vi.stubGlobal('Buffer', undefined)
    expect(await readQualityScoring(binding, summary)).toEqual(record)
    expect(validateQualityScoringInput(binding, input('unit'))).toBe(true)
    const corrupted = structuredClone(record); corrupted.modelBasisStatement += ' changed'
    runtimeRequest.mockResolvedValue(response(corrupted))
    await expect(readQualityScoring(binding, summary)).rejects.toMatchObject({ reason: 'invalid-response' })
    runtimeRequest.mockResolvedValue(response(record))
    await expect(readQualityScoring({ ...binding, workspaceRoot: '/different' }, summary)).rejects.toMatchObject({ reason: 'invalid-response' })
    expect(qualityScoringSummary(record)).toEqual(summary)
  })
  it('maps deterministic environment/validation errors without suggesting generic network retry', async () => {
    await render()
    runtimeRequest.mockResolvedValueOnce({ ok: false, status: 409, body: '{"code":"quality_scoring_replay_environment"}' })
    await click(button('Scoring record history')); expect(host.textContent).toContain('preventing exact replay'); expect(button('Retry original request')).toBeUndefined()
    runtimeRequest.mockResolvedValueOnce({ ok: false, status: 400, body: '{"code":"quality_scoring_validation"}' })
    await click(button('Scoring record history')); expect(host.textContent).toContain('contract'); expect(button('Retry original request')).toBeUndefined()
  })
  it('exports only a freshly replayed record through native Save As, preserving UTF-8 original input', async () => {
    await render(); await save(); await click(button('Reverify and export JSON'))
    await vi.waitFor(() => expect(saveWorkspaceFileAs).toHaveBeenCalledTimes(1))
    expect(runtimeRequest.mock.calls.at(-1)![0]).toMatch(/\/export$/)
    const payload = saveWorkspaceFileAs.mock.calls[0]![0]
    expect(payload).toMatchObject({ workspaceRoot: binding.workspaceRoot, suggestedName: 'survey-quality-accuracy-declared-score.json', mimeType: 'application/json' })
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
    const wait = deferred<ReturnType<typeof response>>(), latest = service.listRecords(binding.projectId).records[0]!
    const record = service.getRecord(binding.projectId, latest.id)
    runtimeRequest.mockReturnValueOnce(wait.promise); await click(button('Reverify and export JSON'))
    await render({ binding: { ...binding, projectRevision: 2 } })
    await act(async () => wait.resolve(response(record))); await new Promise(resolve => setTimeout(resolve, 10))
    expect(saveWorkspaceFileAs).not.toHaveBeenCalled()
  })
})
