// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { SurveyPeriodComparison } from './SurveyPeriodComparison'
import type { SurveyProfessionalReviewV1 } from '@shared/survey-professional'
import type { SurveyInitialValueEventV1, SurveySegmentComparisonRequestV1, SurveySegmentComparisonV1 } from '@shared/survey-monitoring'

const periods = [
  { run: { id: 'run1', networkId: 'network1' }, result: { id: 'result1' }, observationEpoch: '2026-09-01T00:00:00Z' },
  { run: { id: 'run2', networkId: 'network2' }, result: { id: 'result2' }, observationEpoch: '2026-09-02T00:00:00Z' }
]
function review(index: number, projectId = 'project1'): SurveyProfessionalReviewV1 {
  return {
    schemaVersion: 1, projectionVersion: 'survey-professional-review-1', projectId, networkId: `network${index}`, runId: `run${index}`, resultId: `result${index}`,
    inputHash: `input${index}`, resultHash: `${index}`.repeat(64), projectionHash: `${index + 2}`.repeat(64), algorithmVersion: 'survey-1', resultCreatedAt: `2026-09-0${index}T00:00:00Z`,
    source: { status: 'bound', integrity: 'verified', networkRevision: 2, sha256: 'a'.repeat(64), anchoredObservationCount: 2, missingAnchorObservationIds: [] },
    reference: { coordinateSystem: 'LOCAL', projection: null, ellipsoid: null, verticalDatum: 'PROJECT', linearUnit: 'm', angularUnit: 'rad', knownPoints: [{ id: 'BM01', pointClass: 'known', height: 100, known: true }], status: 'declared' },
    summary: { networkType: 'leveling', observationCount: 2, pointCount: 3, degreesOfFreedom: 1, unitWeightStdDev: 1, varianceFactor: 1, varianceBasis: 'a-posteriori', validation: 'valid' },
    closures: [], residualNorms: [], observations: ['a', 'b'].map((letter, row) => ({ id: `row-${index}-${letter}`, observationId: `${letter}${index}`, type: 'height-difference', from: row ? 'P01' : 'BM01', to: row ? 'P02' : 'P01', observed: 0.2 + index * 0.001, adjusted: 0.2 + index * 0.001, residual: 0, correction: 0, unit: 'm', sourceRecordId: `raw-${index}-${letter}`, outlierCandidate: false, screeningStatus: 'legacy-not-recorded' })),
    points: [], weakestPoint: { status: 'not-evaluated', criterion: 'largest-reported-point-standard-error' }, weakestEdge: { status: 'not-evaluated', reason: 'cross-covariance-unavailable' }, checks: [], reviewStatus: 'unsigned', standardsConformity: 'not-evaluated'
  }
}
const initialEvent: SurveyInitialValueEventV1 = { schemaVersion: 1, id: 'event1', projectId: 'project1', previousEventId: null, previousHash: null, adjustmentId: 'run1', resultId: 'result1', resultHash: '1'.repeat(64), inputHash: 'input1', sourceSha256: 'a'.repeat(64), networkRevision: 2, reason: '原基准复核', confirmation: 'user-confirmed', signoff: 'unsigned', createdAt: '2026-09-01T00:00:00Z', eventHash: 'e'.repeat(64) }
function comparison(input: SurveySegmentComparisonRequestV1, projectId = 'project1'): SurveySegmentComparisonV1 { return { schemaVersion: 1, id: 'comparison1', projectId, referenceAdjustmentId: input.referenceAdjustmentId, currentAdjustmentId: input.currentAdjustmentId, referenceResultHash: '1'.repeat(64), currentResultHash: '2'.repeat(64), referenceProjectionHash: '3'.repeat(64), currentProjectionHash: '4'.repeat(64), referenceEpoch: periods[0].observationEpoch, currentEpoch: periods[1].observationEpoch, inputHash: 'c'.repeat(64), createdAt: '2026-09-30T00:00:00Z', segments: input.segments.map(segment => ({ ...segment, referenceObservedMetres: 0.201, currentObservedMetres: 0.202, observedChangeMetres: 0.001, referenceAdjustedMetres: 0.201, currentAdjustedMetres: 0.202, adjustedChangeMetres: 0.001, interpretation: 'current-minus-reference-height-difference', standardsConformity: 'not-evaluated' })), rawObservationCongruence: { schemaVersion: 1, method: 'raw-observation-two-epoch-congruence-trial', status: 'common-movement', trialOnly: true, engineeringDecision: 'not-evaluated', segmentCount: input.segments.length, meanObservedChangeMetres: 0.001, maximumResidualMetres: 0, toleranceMetres: 0.003 } } }
const response = (body: unknown): { ok: true; status: 200; body: string } => ({ ok: true, status: 200, body: JSON.stringify(body) })
let container: HTMLDivElement
let root: Root
let runtimeRequest: ReturnType<typeof vi.fn<(path: string, method: string, body?: string) => Promise<{ ok: boolean; status: number; body: string }>>>
async function settle(): Promise<void> { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function render(extra: Record<string, unknown> = {}): Promise<void> { await act(async () => root.render(createElement(SurveyPeriodComparison, { projectId: 'project1', runtimeReady: true, adjustments: periods, ...extra }))); await settle() }
function button(text: string): HTMLButtonElement { const result = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.trim() === text || item.getAttribute('aria-label') === text); if (!result) throw new Error(`Missing button ${text}`); return result }
async function change(label: string, value: string): Promise<void> { const element = container.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; await act(async () => { const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })) }) }
async function append(label: string, id: string): Promise<void> { await change(label, id); await act(async () => button(`添加${label}`).click()) }
async function validSegment(): Promise<void> { await change('测段起点', 'BM01'); await change('测段终点', 'P01'); await append('基准期观测', 'a1'); await append('当前期观测', 'a2') }

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); await i18n.changeLanguage('zh')
  runtimeRequest = vi.fn(async (path: string, method: string, body?: string) => {
    if (path.endsWith('/initial-values') && method === 'GET') return response({ events: [initialEvent] })
    if (path.endsWith('/run1/professional-review')) return response({ review: review(1) })
    if (path.endsWith('/run2/professional-review')) return response({ review: review(2) })
    if (path.endsWith('/segment-comparisons')) return response({ comparison: comparison(JSON.parse(body!)) })
    if (path.endsWith('/initial-values') && method === 'POST') { const input = JSON.parse(body!); return response({ event: { ...initialEvent, id: 'event2', adjustmentId: input.adjustmentId, resultId: `result${input.adjustmentId.slice(-1)}`, previousEventId: input.expectedPreviousEventId, previousHash: initialEvent.eventHash, reason: input.reason, eventHash: 'f'.repeat(64) } }) }
    throw new Error(`Unexpected ${method} ${path}`)
  })
  window.workwise = { runtimeRequest } as unknown as typeof window.workwise
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(window, 'workwise'); vi.restoreAllMocks() })

describe('survey period comparison', () => {
  it('does not reveal raw internal HTTP errors in period-comparison details', async () => {
    const original = runtimeRequest.getMockImplementation()!
    const rawError = '{"error":{"code":"internal_plan_binding_mismatch","message":"failed at src/server/routes/engineering.ts"}}'
    runtimeRequest.mockImplementation((path, method, body) => path.endsWith('/segment-comparisons')
      ? Promise.resolve({ ok: false, status: 500, body: rawError })
      : original(path, method, body))

    await render(); await validSegment()
    await act(async () => button('生成测段比较').click()); await settle()

    expect(container.textContent).toContain('操作未完成')
    expect(container.textContent).not.toContain('internal_plan_binding_mismatch')
    expect(container.textContent).not.toContain('src/server/routes/engineering.ts')
    expect(container.querySelector('details')).toBeNull()
  })

  it('does not reveal response-binding errors in period-comparison details', async () => {
    const original = runtimeRequest.getMockImplementation()!
    runtimeRequest.mockImplementation((path, method, body) => {
      if (path.endsWith('/segment-comparisons')) return Promise.resolve(response({ comparison: comparison(JSON.parse(body!), 'other-project') }))
      return original(path, method, body)
    })

    await render(); await validSegment()
    await act(async () => button('生成测段比较').click()); await settle()

    expect(container.textContent).toContain('操作未完成')
    expect(container.textContent).not.toContain('does not match the selected inputs')
    expect(container.querySelector('details')).toBeNull()
  })

  it('submits source-backed ordered observation routes and freezes controls during computation', async () => {
    let finish: ((body: ReturnType<typeof response>) => void) | undefined
    const original = runtimeRequest.getMockImplementation()!
    runtimeRequest.mockImplementation((path, method, body) => path.endsWith('/segment-comparisons') ? new Promise(resolve => { finish = resolve }) : original(path, method, body))
    await render(); await validSegment()
    await act(async () => button('生成测段比较').click())
    const call = runtimeRequest.mock.calls.find(([path]) => path.endsWith('/segment-comparisons'))!
    const input = JSON.parse(call[2]!) as SurveySegmentComparisonRequestV1
    expect(input.segments).toEqual([{ id: 'segment-1', from: 'BM01', to: 'P01', referenceObservationIds: ['a1'], currentObservationIds: ['a2'] }])
    expect(Array.from(container.querySelectorAll('select,textarea')).every(item => (item as HTMLInputElement).disabled || item.closest('fieldset')?.disabled)).toBe(true)
    expect(button('添加测段').disabled).toBe(true)
    await change('当前期次', 'run1')
    finish?.(response({ comparison: comparison(input) })); await settle()
    expect(container.querySelector('[aria-label="测段比较成果"]')?.textContent).toContain('0.001000')
    expect(container.querySelector('[aria-label="原始观测一致性试算"]')?.textContent).toContain('共同变动候选')
    expect((container.querySelector('[aria-label="当前期次"]') as HTMLSelectElement).value).toBe('run2')
  })
  it('assigns unique segment identities after removing the middle segment and appending another', async () => {
    await render(); await act(async () => button('添加测段').click()); await act(async () => button('添加测段').click())
    await act(async () => button('移除测段 2').click()); await act(async () => button('添加测段').click())
    expect(Array.from(container.querySelectorAll('[data-segment-id]')).map(element => element.getAttribute('data-segment-id'))).toEqual(['segment-1', 'segment-3', 'segment-4'])
  })
  it('allows observation ordering and clears a result when its selected route changes', async () => {
    await render(); await validSegment(); await act(async () => button('生成测段比较').click()); await settle()
    expect(container.querySelector('[aria-label="测段比较成果"]')).not.toBeNull()
    await append('基准期观测', 'b1'); expect(container.querySelector('[aria-label="测段比较成果"]')).toBeNull()
    await act(async () => button('将观测 b1 · P01 → P02 · 高差 · 观测 2 前移').click())
    const list = container.querySelector('[aria-label="基准期观测"]')?.closest('div')?.querySelector('ol')
    expect(Array.from(list?.querySelectorAll('li') ?? []).map(row => row.textContent?.slice(0, 5))).toEqual(['1. b1', '2. a1'])
  })
  it('exports only the confirmed comparison after it has been created', async () => {
    const onExport = vi.fn(async () => undefined)
    await render({ onExport })
    await validSegment(); await act(async () => button('生成测段比较').click()); await settle()
    const exportButton = button('生成比较成果册')
    await act(async () => exportButton.click()); await settle()
    expect(onExport).toHaveBeenCalledOnce()
    const exported = (onExport.mock.calls.at(0) as unknown as [SurveySegmentComparisonV1] | undefined)?.[0]
    expect(exported).toMatchObject({ id: 'comparison1', referenceAdjustmentId: 'run1', currentAdjustmentId: 'run2' })
  })
  it('ignores a late comparison after the result version changes', async () => {
    let finish: ((body: ReturnType<typeof response>) => void) | undefined
    let input: SurveySegmentComparisonRequestV1 | undefined
    const original = runtimeRequest.getMockImplementation()!
    runtimeRequest.mockImplementation((path, method, body) => path.endsWith('/segment-comparisons') ? new Promise(resolve => { finish = resolve; input = JSON.parse(body!) }) : original(path, method, body))
    await render(); await validSegment(); await act(async () => button('生成测段比较').click())
    await render({ adjustments: [periods[0], { ...periods[1], result: { id: 'result2-new' } }] })
    finish?.(response({ comparison: comparison(input!) })); await settle()
    expect(container.querySelector('[aria-label="测段比较成果"]')).toBeNull()
    expect(container.textContent).not.toContain('测段比较已生成')
    expect(button('生成测段比较').disabled).toBe(true)
  })
  it('keeps initial-value history readable and records a confirmed change against its preceding event', async () => {
    await render()
    expect(container.textContent).toContain('用户已确认')
    expect(container.textContent).not.toContain('user-confirmed')
    expect(container.textContent).not.toContain('unsigned')
    await change('计算期', 'run2'); await change('变更理由', '基准复核后建立新初始期')
    await act(async () => button('确认并记录').click()); await settle()
    const input = JSON.parse(runtimeRequest.mock.calls.find(([path, method]) => path.endsWith('/initial-values') && method === 'POST')![2]!)
    expect(input).toMatchObject({ adjustmentId: 'run2', expectedPreviousEventId: 'event1', reason: '基准复核后建立新初始期', confirmed: true })
    expect(container.querySelectorAll('[data-initial-value-event]')).toHaveLength(2)
    expect(container.textContent).toContain('初值变更已记录，待专业复核')
  })
  it('discards late history and mutation responses after switching projects', async () => {
    let finishHistory: ((body: ReturnType<typeof response>) => void) | undefined
    let finishMutation: ((body: ReturnType<typeof response>) => void) | undefined
    const original = runtimeRequest.getMockImplementation()!
    runtimeRequest.mockImplementation((path, method, body) => {
      if (path.endsWith('/initial-values') && method === 'GET' && path.includes('/project2/')) return new Promise(resolve => { finishHistory = resolve })
      if (path.endsWith('/initial-values') && method === 'POST') return new Promise(resolve => { finishMutation = resolve })
      return original(path, method, body)
    })
    await render(); await change('计算期', 'run2'); await change('变更理由', '旧项目变更'); await act(async () => button('确认并记录').click())
    await render({ projectId: 'project2' }); expect(container.querySelectorAll('[data-initial-value-event]')).toHaveLength(0)
    finishMutation?.(response({ event: { ...initialEvent, id: 'event2', adjustmentId: 'run2', resultId: 'result2', reason: '旧项目变更', previousEventId: 'event1', previousHash: initialEvent.eventHash } })); await settle()
    expect(container.textContent).not.toContain('旧项目变更')
    await render({ projectId: 'project3' }); finishHistory?.(response({ events: [{ ...initialEvent, projectId: 'project2' }] })); await settle()
    expect(container.querySelectorAll('[data-initial-value-event]')).toHaveLength(0)
  })
  it('blocks recording when history could not be loaded and refuses incorrectly bound reviews', async () => {
    runtimeRequest.mockImplementation(async path => path.endsWith('/initial-values') ? { ok: false, status: 503, body: 'unavailable' } : response({ review: { ...review(1), runId: 'other-run' } }))
    await render()
    expect(button('确认并记录').disabled).toBe(true)
    expect(button('生成测段比较').disabled).toBe(true)
    expect(container.querySelectorAll('[aria-label="基准期观测"] option')).toHaveLength(1)
    expect(container.textContent).toContain('初值事件历史暂不可用')
    expect(runtimeRequest.mock.calls.some(([, method]) => method === 'POST')).toBe(false)
  })
})
