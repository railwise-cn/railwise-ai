// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { SurveyProfessionalReviewV1 } from '@shared/survey-professional'
import { ProfessionalSurveyReview, SurveyProfessionalInputs, type ProfessionalSurveyNetwork } from './ProfessionalSurveyReview'

const sourceSha256 = 'a'.repeat(64)
const network: ProfessionalSurveyNetwork = {
  id: 'network-review', revision: 2, networkType: 'leveling', coordinateSystem: 'LOCAL', verticalDatum: 'PROJECT-DATUM', unit: 'm', qualityStatus: 'validated',
  sourceFile: { name: 'original.gsi', sha256: sourceSha256 },
  knownPoints: [{ id: 'BM01', height: 100, known: true }], unknownPoints: [{ id: 'P01', height: 100.2 }],
  observations: [{ id: 'obs1', from: 'BM01', to: 'P01' }, { id: 'obs2', from: 'P01', to: 'BM01' }]
}
const adjustment = { run: { id: 'run-review', networkId: network.id, status: 'completed' }, result: { id: 'result-review', inputHash: 'input-hash', algorithmVersion: 'survey-1' } }
const xyEllipse = {
  algorithmVersion: 'survey-xy-error-ellipse-1', coordinatePlane: 'solution-xy', covarianceUnit: 'm2', covarianceXY: [0.000064, 0, 0, 0.000016],
  semiMajor: 0.008, semiMinor: 0.004, axisUnit: 'm', orientationRad: 0.1,
  orientationConvention: 'positive-x-toward-positive-y-mod-pi', scale: 'unit-mahalanobis-radius', varianceBasis: 'a-posteriori'
}
const review = SurveyProfessionalReviewV1.parse({
  schemaVersion: 1, projectionVersion: 'survey-professional-review-1', projectId: 'project-review', networkId: network.id, runId: adjustment.run.id, resultId: adjustment.result.id,
  inputHash: adjustment.result.inputHash, algorithmVersion: adjustment.result.algorithmVersion, resultHash: 'b'.repeat(64), projectionHash: 'c'.repeat(64), resultCreatedAt: '2026-09-30T00:00:00Z',
  source: { networkRevision: network.revision, sha256: sourceSha256, formatId: 'leica-gsi8', status: 'bound', integrity: 'verified', anchoredObservationCount: 2, missingAnchorObservationIds: [] },
  reference: { coordinateSystem: 'LOCAL', projection: null, ellipsoid: null, verticalDatum: 'PROJECT-DATUM', linearUnit: 'm', angularUnit: 'rad', knownPoints: [{ id: 'BM01', pointClass: 'known', height: 100, known: true }], status: 'declared' },
  summary: { networkType: 'leveling', observationCount: 2, pointCount: 2, degreesOfFreedom: 1, unitWeightStdDev: 0.8, varianceFactor: 0.64, unitWeightStdDevUnit: 'dimensionless', varianceFactorUnit: 'dimensionless', weightingBasis: 'absolute-prior', varianceBasis: 'a-posteriori', validation: 'valid' },
  closures: [{ id: 'loop1', kind: 'loop', from: 'BM01', to: 'BM01', members: [{ observationId: 'obs1', direction: 1, from: 'BM01', to: 'P01', heightDifferenceMetres: 0.2, sourceRecordId: 'raw1' }, { observationId: 'obs2', direction: 1, from: 'P01', to: 'BM01', heightDifferenceMetres: -0.198, sourceRecordId: 'raw2' }], sumObservedMetres: 0.002, knownHeightDifferenceMetres: 0, misclosureMetres: 0.002, status: 'not-evaluated', reason: 'closure-tolerance-not-configured' }],
  residualNorms: [{ unit: 'm', value: 0.00141421356, count: 2, status: 'descriptive-only' }],
  observations: [{ id: 'observation1', observationId: 'obs1', type: 'height-difference', from: 'BM01', to: 'P01', observed: 0.2, adjusted: 0.199, correction: -0.001, residual: -0.001, unit: 'm', sourceRecordId: 'raw1', outlierCandidate: true, screeningStatus: 'legacy-not-recorded' }],
  points: [{ id: 'BM01', role: 'known', height: 100, precisionBasis: 'not-recorded', unit: 'm' }, { id: 'P01', role: 'unknown', height: 100.199, standardError: 0.0004, precisionBasis: 'a-posteriori', unit: 'm' }],
  weakestPoint: { status: 'available', criterion: 'largest-reported-point-standard-error', pointId: 'P01', standardErrorMetres: 0.0004 },
  weakestEdge: { status: 'not-evaluated', reason: 'cross-covariance-unavailable' },
  checks: [{ id: 'field-checks', status: 'not-evaluated', reason: 'station-readings-not-evaluated' }, { id: 'closure', status: 'not-evaluated', reason: 'closure-tolerance-not-configured' }, { id: 'numerical-result', status: 'pass' }], reviewStatus: 'unsigned', standardsConformity: 'not-evaluated'
})
let container: HTMLDivElement
let root: Root
let runtimeRequest: ReturnType<typeof vi.fn>
async function settle(): Promise<void> { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
const response = (value: unknown): { ok: true; status: number; body: string } => ({ ok: true, status: 200, body: JSON.stringify(value) })

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  runtimeRequest = vi.fn(async () => response({ review }))
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  window.workwise = { runtimeRequest } as unknown as typeof window.workwise
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks() })

async function renderReview(extra: Record<string, unknown> = {}): Promise<void> {
  await act(async () => root.render(createElement(ProfessionalSurveyReview, { projectId: 'project-review', projectRevision: 3, network, adjustment, runtimeReady: true, ...extra })))
  await settle()
}

describe('professional survey review', () => {
  it('shows a professional observation label while retaining exact evidence identity', async () => {
    const ask = vi.fn()
    runtimeRequest.mockResolvedValue(response({ review: { ...review, observations: [{ ...review.observations[0], observationId: 'cosa-in2-6-backsight-reset', type: 'direction', from: 'S1', to: 'A', sourceRow: 6 }] } }))
    await renderReview({ onAsk: ask })
    const row = container.querySelector('[data-professional-observation="cosa-in2-6-backsight-reset"]')!
    expect(row.textContent).toContain('S1 → A · 方向 · 来源第 6 行')
    expect(row.textContent).not.toContain('cosa-in2')
    const button = row.querySelector<HTMLButtonElement>('button')!
    expect(button.getAttribute('aria-label')).not.toContain('cosa-in2')
    await act(async () => button.click())
    expect(ask.mock.calls[0][0]).toBe('S1 → A · 方向 · 来源第 6 行')
    expect(ask.mock.calls[0][1].observationId).toBe('cosa-in2-6-backsight-reset')
  })

  it('shows solver rank and datum semantics while keeping legacy records unevaluated', async () => {
    runtimeRequest.mockResolvedValue(response({ review: {
      ...review,
      solver: { rank: 2, parameterCount: 3, datumDefect: 1, rankStatus: 'available', datumStatus: 'fixed-datum', constraint: 'fixed-known-points', constraintBasis: 'adjustment-run' }
    } }))
    await renderReview()
    expect(container.textContent).toContain('法方程秩 / 参数数')
    expect(container.textContent).toContain('2 / 3')
    expect(container.textContent).toContain('基准缺陷（代数）')
    expect(container.textContent).toContain('固定已知点')
    expect(container.textContent).toContain('固定基准')

    const legacyReview = { ...review, resultId: 'result-review-legacy' }
    runtimeRequest.mockResolvedValue(response({ review: legacyReview }))
    await renderReview({ adjustment: { ...adjustment, result: { ...adjustment.result, id: 'result-review-legacy' } } })
    expect(container.textContent).toContain('法方程秩 / 参数数')
    expect(container.textContent).toContain('未评估')
  })

  it('keeps professional inputs visible before calculation with source-based network geometry', async () => {
    await act(async () => root.render(createElement(SurveyProfessionalInputs, { network })))
    expect(container.textContent).toContain('网形、基准与已知点')
    expect(container.textContent).toContain('PROJECT-DATUM')
    expect(container.querySelectorAll('svg[role="img"] line')).toHaveLength(2)
    expect(container.querySelectorAll('tbody tr')).toHaveLength(1)
  })
  it.each(['leveling', 'height-control'])('shows only height fields for %s even when unrelated XY data is retained', async (networkType) => {
    const heightNetwork = { ...network, networkType, knownPoints: [{ ...network.knownPoints[0], x: 531111, y: 262222 }], unknownPoints: [{ ...network.unknownPoints[0], x: 531112, y: 262223 }] }
    runtimeRequest.mockResolvedValue(response({ review: {
      ...review, summary: { ...review.summary, networkType },
      reference: { ...review.reference, projection: 'UNRELATED-PROJECTION', ellipsoid: 'UNRELATED-ELLIPSOID', centralMeridian: 117 },
      points: review.points.map(point => ({ ...point, x: 531111, y: 262222, correctionHeight: -0.00025, xyErrorEllipse: xyEllipse }))
    } }))
    await renderReview({ network: heightNetwork })
    await settle()
    const tables = container.querySelectorAll('table')
    const knownHeaders = Array.from(tables[0].querySelectorAll('th')).map(item => item.textContent)
    expect(knownHeaders).toContain('H (m)')
    expect(knownHeaders).not.toContain('X (m)')
    expect(knownHeaders).not.toContain('Y (m)')
    const point = container.querySelector('[data-professional-point="P01"]')!
    const pointHeaders = point.closest('table')!.querySelector('thead')!.textContent!
    expect(pointHeaders).toContain('高程中误差（mm）')
    expect(pointHeaders).toContain('高程改正数（mm）')
    expect(pointHeaders).not.toContain('X (m)')
    expect(pointHeaders).not.toContain('Y (m)')
    expect(pointHeaders).not.toContain('误差椭圆')
    expect(point.querySelectorAll('td')[3].textContent).toBe('-0.25')
    const observation = container.querySelector('[data-professional-observation="obs1"]')!
    expect(observation.closest('table')!.querySelector('thead')!.textContent).toContain('观测高差（m）')
    expect(observation.closest('table')!.querySelector('thead')!.textContent).toContain('平差高差（m）')
    expect(observation.querySelectorAll('td')[4].textContent).toBe('-1')
    expect(container.textContent).not.toContain('UNRELATED-PROJECTION')
    expect(container.textContent).not.toContain('UNRELATED-ELLIPSOID')
    expect(container.textContent).not.toContain('中央子午线')
    expect(container.textContent).not.toContain('rad')
    expect(container.querySelector('svg[role="img"]')!.getAttribute('aria-label')).toContain(i18n.t('surveySchematicLayout', { ns: 'common' }))
  })
  it('keeps plane coordinates, error ellipses and each observation unit while omitting unrelated heights', async () => {
    const planeNetwork = { ...network, networkType: 'plane-control', knownPoints: [{ id: 'BM01', x: 100, y: 200, height: 900 }], unknownPoints: [{ id: 'P01', x: 103, y: 204, height: 999 }] }
    runtimeRequest.mockResolvedValue(response({ review: {
      ...review, summary: { ...review.summary, networkType: 'plane-control' }, closures: [],
      reference: { ...review.reference, projection: 'GAUSS-KRUGER', ellipsoid: 'CGCS2000', centralMeridian: 117 },
      observations: [{ ...review.observations[0], type: 'distance', observed: 5.0001, adjusted: 5, correction: -0.0001 }, { ...review.observations[0], id: 'direction2', observationId: 'dir2', type: 'direction', observed: 0.9, adjusted: 0.90001, correction: 0.00001, unit: 'rad' }],
      points: [{ ...review.points[1], x: 103, y: 204, height: 999, correctionX: 0.0012, correctionY: -0.0003, xyErrorEllipse: xyEllipse }]
    } }))
    await renderReview({ network: planeNetwork })
    await settle()
    const knownHeaders = container.querySelector('table thead')!.textContent!
    expect(knownHeaders).toContain('X (m)')
    expect(knownHeaders).toContain('Y (m)')
    expect(knownHeaders).not.toContain('H (m)')
    const point = container.querySelector('[data-professional-point="P01"]')!
    expect(point.closest('table')!.querySelector('thead')!.textContent).toContain('XY 标准误差椭圆')
    expect(point.closest('table')!.querySelector('thead')!.textContent).toContain('dX 改正数（mm）')
    expect(point.closest('table')!.querySelector('thead')!.textContent).toContain('dY 改正数（mm）')
    expect(point.closest('table')!.querySelector('thead')!.textContent).not.toContain('H (m)')
    expect(point.textContent).toContain('8 / 4')
    expect(point.textContent).toContain('1.2')
    expect(point.textContent).toContain('-0.3')
    expect(point.textContent).not.toContain('999')
    expect(container.textContent).toContain('GAUSS-KRUGER')
    expect(container.textContent).toContain('CGCS2000')
    const observationHeaders = container.querySelector('[data-professional-observation="obs1"]')!.closest('table')!.querySelector('thead')!.textContent
    expect(observationHeaders).toContain('观测值 (m / rad)')
    expect(container.querySelector('[data-professional-observation="dir2"]')!.querySelectorAll('td')[5].textContent).toBe('rad')
  })
  it('aligns topology edge labels inward and retains full long identities in tooltips', async () => {
    const first = 'gsi-block-1:Z01'
    const second = 'gsi-block-1:Z02-with-a-long-source-identity'
    const topologyNetwork = { ...network, knownPoints: [{ id: first, height: 100 }], unknownPoints: [{ id: second, height: 101 }], observations: [{ id: 'obs', from: first, to: second }] }
    await act(async () => root.render(createElement(SurveyProfessionalInputs, { network: topologyNetwork })))
    const texts = container.querySelectorAll('svg[role="img"] text')
    expect(texts[0].getAttribute('text-anchor')).toBe('start')
    expect(texts[1].getAttribute('text-anchor')).toBe('end')
    expect(texts[1].getAttribute('aria-label')).toBe(second)
    expect(texts[1].textContent!.length).toBeLessThanOrEqual(26)
    expect(texts[1].parentElement!.querySelector('title')!.textContent).toBe(second)
  })
  it('separates independent closure from residual norms and leaves unspecified tolerances unevaluated', async () => {
    await renderReview()
    const closure = container.querySelector('[data-professional-closure="loop1"]')!
    expect(closure.textContent).toContain('未配置具有明确依据的闭合限差')
    expect(closure.querySelectorAll('td')[3].textContent).toBe('2')
    expect(container.textContent).toContain('残差范数描述平差后的拟合量')
    expect(container.textContent).toContain('单位权中误差')
    expect(container.textContent).toContain('0.8 无量纲')
    expect(container.textContent).toContain('按观测精度模型定权')
    expect(container.querySelector('[data-professional-point="P01"]')?.textContent).toContain('0.4')
    expect(container.textContent).toContain('异常候选 · 待核实')
    expect(container.textContent).toContain('待专业复核与签认')
    expect(container.textContent).not.toContain('projectionHash')
  })
  it.each(['zh', 'en'])('shows recorded route weighting and dimensional scales in %s', async language => {
    await i18n.changeLanguage(language)
    runtimeRequest.mockResolvedValue(response({ review: { ...review, summary: {
      ...review.summary, weightingBasis: 'relative-route-length', unitWeightStdDevUnit: 'm', varianceFactorUnit: 'm2',
      relativeWeightReferenceLengthMetres: 1, relativeWeightDefaultLengthObservationIds: []
    } } }))
    await renderReview()
    const datumValue = (key: string): string | null | undefined => Array.from(container.querySelectorAll('dt')).find(item => item.textContent === i18n.t(key, { ns: 'common' }))?.nextElementSibling?.textContent
    expect(datumValue('surveyProfessionalSigma0')).toBe('0.8 m')
    expect(datumValue('surveyProfessionalVarianceFactor')).toBe('0.64 m²')
    expect(container.textContent).toContain(i18n.t('surveyWeightingRouteLength', { ns: 'common' }))
    expect(container.textContent).not.toContain(i18n.t('surveyWeightingAbsolute', { ns: 'common' }))
  })
  it('distinguishes nominal equal weights from recorded route lengths without inferring partial records', async () => {
    const summary = { ...review.summary, weightingBasis: 'relative-route-length', unitWeightStdDevUnit: 'm', varianceFactorUnit: 'm2', relativeWeightReferenceLengthMetres: 1 }
    runtimeRequest.mockResolvedValue(response({ review: { ...review, summary: { ...summary, relativeWeightDefaultLengthObservationIds: ['obs1', 'obs2'] } } }))
    await renderReview()
    expect(container.textContent).toContain(i18n.t('surveyWeightingEqual', { ns: 'common' }))
    runtimeRequest.mockResolvedValue(response({ review: { ...review, resultId: 'partial', summary: { ...summary, relativeWeightDefaultLengthObservationIds: ['obs1'] } } }))
    await renderReview({ adjustment: { ...adjustment, result: { ...adjustment.result, id: 'partial' } } })
    expect(container.textContent).toContain(i18n.t('surveyWeightingUnconfirmed', { ns: 'common' }))
    expect(container.textContent).toContain('0.8 · 单位未核定')
    expect(container.textContent).not.toContain(i18n.t('surveyWeightingRouteLength', { ns: 'common' }))
  })
  it('keeps historical units unconfirmed even when old defaults declare dimensionless scales', async () => {
    const { weightingBasis: _basis, ...historicalSummary } = review.summary
    runtimeRequest.mockResolvedValue(response({ review: { ...review, summary: historicalSummary } }))
    await renderReview()
    expect(container.textContent).toContain(i18n.t('surveyWeightingUnconfirmed', { ns: 'common' }))
    expect(container.textContent).toContain('0.8 · 单位未核定')
    expect(container.textContent).not.toContain('0.8 无量纲')
  })
  it('does not present unestimated zero scales as absolute prior precision', async () => {
    runtimeRequest.mockResolvedValue(response({ review: {
      ...review, summary: { ...review.summary, degreesOfFreedom: 0, unitWeightStdDev: 0, varianceFactor: 0,
        weightingBasis: 'relative-route-length', unitWeightStdDevUnit: 'm', varianceFactorUnit: 'm2',
        relativeWeightReferenceLengthMetres: 1, relativeWeightDefaultLengthObservationIds: [], varianceBasis: 'not-estimated' },
      points: review.points.map(({ standardError: _error, ...point }) => ({ ...point, precisionBasis: 'not-recorded' })),
      weakestPoint: { status: 'not-evaluated', criterion: 'largest-reported-point-standard-error', reason: 'no-redundancy' }
    } }))
    await renderReview()
    for (const key of ['surveyProfessionalSigma0', 'surveyProfessionalVarianceFactor']) {
      const value = Array.from(container.querySelectorAll('dt')).find(item => item.textContent === i18n.t(key, { ns: 'common' }))?.nextElementSibling
      expect(value?.textContent).toBe(i18n.t('surveyPrecisionNotAssessed', { ns: 'common' }))
    }
    expect(container.querySelector('[data-professional-point="P01"]')!.textContent).not.toContain('0.4')
    expect(container.textContent).not.toContain('0 m²')
  })
  it('binds an AI explanation to the exact projection, source and selected observation', async () => {
    const ask = vi.fn()
    await renderReview({ onAsk: ask })
    const button = container.querySelector('[data-professional-observation="obs1"] button') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
    expect(ask.mock.calls[0][1]).toMatchObject({ observationId: 'obs1', sourceRecordId: 'raw1', typedEvidence: {
      kind: 'professional-review', projectRevision: 3, networkRevision: 2, sourceSha256,
      adjustmentId: review.runId, resultId: review.resultId, inputHash: review.inputHash, resultHash: review.resultHash,
      projectionHash: review.projectionHash, selector: { path: ['observations', 0], identity: { id: 'observation1' } }
    } })
    expect(runtimeRequest.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  })
  it('fails closed when a server response is malformed or belongs to another version', async () => {
    const delivery = vi.fn()
    runtimeRequest.mockResolvedValue(response({ review: { ...review, resultId: 'other-result' } }))
    await renderReview({ onViewDelivery: delivery })
    expect(container.textContent).toContain('专业成果记录暂不可用')
    expect(container.querySelector('[data-professional-point]')).toBeNull()
    const draft = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('生成专业审查稿'))!
    expect(draft.disabled).toBe(true)
    runtimeRequest.mockResolvedValue(response({ review: { ...review, closures: [{ id: 'incomplete' }] } }))
    const reload = Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('重新读取'))!
    await act(async () => reload.click()); await settle()
    expect(container.textContent).toContain('专业成果记录暂不可用')
  })
  it('cancels late results after changing the active input version', async () => {
    let finish: ((value: ReturnType<typeof response>) => void) | undefined
    runtimeRequest.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await renderReview()
    await renderReview({ network: { ...network, revision: 3 } })
    finish?.(response({ review })); await settle()
    expect(container.querySelector('[data-professional-point]')).toBeNull()
    expect(container.textContent).toContain('专业成果记录暂不可用')
  })
  it('shows inspectable unbound history without linking the current network or enabling AI/delivery', async () => {
    runtimeRequest.mockResolvedValue(response({ review: { ...review, source: { ...review.source, status: 'mismatch', reason: 'input-mismatch' } } }))
    await renderReview({ onAsk: vi.fn(), onViewDelivery: vi.fn() })
    expect(container.querySelector('[data-professional-point="P01"]')).not.toBeNull()
    expect(container.querySelector('svg[role="img"]')).toBeNull()
    expect((container.querySelector('[data-professional-point="P01"] button') as HTMLButtonElement).disabled).toBe(true)
    expect(Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('生成专业审查稿'))?.disabled).toBe(true)
  })
  it('uses English professional labels and reason text without raw technical fields', async () => {
    await i18n.changeLanguage('en'); await renderReview()
    expect(container.textContent).toContain('Independent closure checks')
    expect(container.textContent).toContain('No closure tolerance with a stated basis is configured')
    expect(container.textContent).toContain('Candidate · needs verification')
    expect(container.textContent).not.toMatch(/[\u3400-\u9fff]/)
  })
})
