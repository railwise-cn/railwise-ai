// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'
import { SurveyAdjustmentPanel } from './SurveyAdjustmentPanel'
import i18n from '../../i18n'
import type { SurveyEvidenceNavigationTarget } from './engineering-evidence-navigation'

let container: HTMLDivElement
let root: Root
let runtimeRequest: ReturnType<typeof vi.fn>
let validationResponse: unknown

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function runtimeResponse(body: unknown): { ok: true; status: 200; body: string } {
  return { ok: true, status: 200, body: JSON.stringify(body) }
}

const network = {
  id: 'network-restored-001',
  revision: 2,
  networkType: 'leveling',
  coordinateSystem: '工程独立坐标系',
  verticalDatum: '1985 国家高程基准',
  knownPoints: [{ id: 'BM-01', pointClass: 'known', height: 100, known: true }],
  unknownPoints: [{ id: 'P-01', pointClass: 'unknown', height: 100.2, known: false }],
  observations: [{ id: 'obs-1', type: 'height-difference', from: 'BM-01', to: 'P-01', value: 0.2, unit: 'm', sigma: 0.002 }],
  rawSourceIntegrity: { status: 'verified', ledgerEntryCount: 2, errors: [] },
  sourceEligibility: { eligible: true, findings: [] },
  sourceFile: {
    name: 'level.gsi',
    size: 512,
    sha256: 'a'.repeat(64),
    originalPreserved: true,
    formatId: 'leica-gsi8',
    vendor: 'Leica/Hexagon',
    formatVersion: '8',
    detectionMethod: 'content-signature',
    detectionConfidence: 0.98,
    extensionClaimed: '.gsi',
    extensionContentConflict: false,
    requiresManualConfirmation: false,
    detection: { format: 'leica-gsi8', vendor: 'Leica/Hexagon', version: '8', method: 'content-signature', confidence: 0.98, extension: '.gsi', matchedSignatures: ['GSI word index/sign/value'], extensionConflict: false },
    disposition: 'adjustment-ready',
    dispositionReason: '内容签名、记录结构和单位声明均已通过预检。',
    parserId: 'survey-format-registry',
    parserVersion: 'workwise-survey-formats-1',
    parserSourceHash: 'p'.repeat(64),
    linearUnitRaw: 'GSI 米制末位 1 mm',
    angularUnitRaw: 'gon',
    linearUnitCanonical: 'm',
    angularUnitCanonical: 'rad',
    datumDeclared: 'CGCS2000',
    heightSystemDeclared: '1985 国家高程基准',
    recordCount: 1,
    summary: { pointCount: 2, stationCount: 1, observationCount: 1, recordCount: 1, skippedRecordCount: 0 },
    diagnostics: [
      { code: 'format_detected', severity: 'info', message: '识别为 Leica GSI-8' },
      { code: 'mapping_required', severity: 'warning', message: '字段映射需要确认。', suggestedAction: '确认字段映射、单位和基准后重新导入。', localized: { en: { message: 'Field mapping requires confirmation for record 19.', suggestedAction: 'Confirm units for record 19 and reimport.' } } }
    ],
    records: [{ id: 'record-1', sourceRecord: 1, rawOffset: 137, rawLength: 29, rawLineNo: 1, line: 1, recordType: 'GSI', section: 'network.observations', rawSnippet: '{"id":"obs-1","value":0.2}' }],
    rawRecordAnchors: [{ id: 'record-1', sourceRecord: 1, rawOffset: 137, rawLength: 29, rawLineNo: 1, line: 1, recordType: 'GSI', section: 'network.observations', rawSnippet: '{"id":"obs-1","value":0.2}' }]
  },
  qualityStatus: 'validated',
  findings: []
}

const archiveOnlyNetwork = {
  ...network,
  id: 'network-archive-only-002',
  revision: 1,
  sourceEligibility: {
    eligible: false,
    findings: [{ code: 'converter_required', severity: 'blocking', message: '需要受审计的本地转换器。', suggestion: '安装并授权受审计的本地转换器后重新导入。' }]
  },
  sourceFile: {
    ...network.sourceFile,
    name: 'misnamed.dat',
    size: 256,
    sha256: 'b'.repeat(64),
    formatId: 'trimble-t02',
    vendor: 'Trimble',
    formatVersion: 'T02',
    detectionMethod: 'content-signature',
    detectionConfidence: 0.99,
    extensionClaimed: '.dat',
    extensionContentConflict: true,
    requiresManualConfirmation: true,
    detection: { format: 'trimble-t02', vendor: 'Trimble', version: 'T02', method: 'content-signature', confidence: 0.99, extension: '.dat', matchedSignatures: ['Trimble T02 binary signature'], extensionConflict: true },
    disposition: 'converter-required',
    dispositionReason: 'converter-required: 未安装经审计的本地转换器。',
    parserId: 'trimble-container-probe',
    parserVersion: 'workwise-survey-formats-1',
    parserSourceHash: 'q'.repeat(64),
    converterId: 'fixture-trimble-converter',
    converterVersion: '1.0.0',
    converterBinaryHash: 'c'.repeat(64),
    converter: { id: 'fixture-trimble-converter', version: '1.0.0', license: 'fixture-only', executableHash: 'c'.repeat(64), inputHash: 'b'.repeat(64), networkAccess: 'none', arguments: ['--input', '{input}', '--output', '{output}'], status: 'blocked' },
    recordCount: 2,
    summary: { pointCount: 0, stationCount: 0, observationCount: 0, recordCount: 2, skippedRecordCount: 2 },
    diagnostics: [{ code: 'converter_required', severity: 'blocking', message: '需要受审计的本地转换器。', suggestedAction: '安装并授权受审计的本地转换器后重新导入。' }],
    rawRecordAnchors: []
  },
  qualityStatus: 'blocked',
  findings: [{ code: 'source_not_adjustment_ready', severity: 'blocking', message: '源文件仅可转换后重导。' }]
}

const legacyNetwork = {
  ...network,
  id: 'network-legacy-003',
  revision: 1,
  rawSourceIntegrity: { status: 'legacy-unverified', ledgerEntryCount: 0, errors: ['原始资料未由当前导入链路验证'] },
  sourceEligibility: {
    eligible: false,
    findings: [{ code: 'source_not_adjustment_ready', severity: 'blocking', message: '旧版来源未通过当前运行时资格核验。', suggestion: '从保留的原始文件重新导入。' }]
  },
  sourceFile: {
    name: 'legacy.gsi',
    size: 128,
    sha256: 'd'.repeat(64),
    originalPreserved: true,
    detection: { format: 'leica-gsi8', vendor: 'Leica/Hexagon', confidence: 0.9, extension: '.gsi', matchedSignatures: ['legacy signature'], extensionConflict: false },
    disposition: 'archive-only',
    parserId: 'legacy-parser',
    parserVersion: 'legacy-1',
    datumDeclared: null,
    heightSystemDeclared: null,
    recordCount: 1,
    diagnostics: [],
    rawRecordAnchors: []
  },
  qualityStatus: 'blocked',
  findings: []
}

const pendingEligibilityNetwork = {
  ...network,
  id: 'network-pending-eligibility-004',
  revision: 1,
  sourceEligibility: undefined,
  sourceFile: {
    ...network.sourceFile,
    name: 'pending-eligibility.gsi'
  }
}

const historicalIneligibleNetwork = {
  ...network,
  id: 'network-historical-ineligible-004',
  revision: 3,
  rawSourceIntegrity: { status: 'failed' as const, ledgerEntryCount: 2, errors: ['保留的原始文件内容与导入账本不一致'] },
  sourceEligibility: {
    eligible: false,
    findings: [{ code: 'raw_source_integrity_failed', severity: 'blocking', message: '原始资料完整性校验失败。', suggestion: '恢复保留原件或重新导入。' }]
  },
  sourceFile: { ...network.sourceFile, name: 'historical-source-revoked.gsi' },
  qualityStatus: 'blocked'
}

const adjustment = {
  observationEpoch: '2026-08-22T00:00:00.000Z',
  networkType: 'leveling',
  coordinateSystem: network.coordinateSystem,
  verticalDatum: network.verticalDatum,
  rawSourceIntegrity: { status: 'verified' as const, ledgerEntryCount: 2, errors: [] },
  sourceEligibility: { eligible: true, findings: [] },
  run: {
    id: 'adjustment-restored-001',
    networkId: network.id,
    status: 'completed',
    revision: 1,
    createdAt: '2026-08-22T00:01:00.000Z'
  },
  result: {
    id: 'result-restored-001',
    validation: 'valid',
    strategyId: 'leveling',
    algorithmVersion: 'survey-wls-v1',
    observationCount: 1,
    unknownCount: 1,
    redundancy: 1,
    degreesOfFreedom: 1,
    linearUnit: 'm',
    angularUnit: 'rad',
    unitWeightStdDev: 0.0004472136,
    unitWeightStdDevUnit: 'dimensionless',
    varianceFactor: 0.0000002,
    varianceFactorUnit: 'dimensionless',
    varianceFactorEstimated: true,
    closure: { heightDifference: 0.0001 },
    closureUnits: { heightDifference: 'm' },
    precision: { maxPointStdDev: 0.0005, passed: true },
    qualityFindings: [],
    covariance: [[0.00000025]],
    points: [{ id: 'P-01', height: 100.2001, correctionHeight: 0.0001, standardError: 0.0005 }, { id: 'XY-test', x: 1, y: 2, xyErrorEllipse: { semiMajor: 0.006, semiMinor: 0.003, orientationRad: Math.PI / 6, varianceBasis: 'a-posteriori' } }],
    observations: [
      { observationId: 'obs-1', residual: 0.0001, unit: 'm', standardizedResidual: 0.2, standardizedResidualUnit: 'sigma', sourceRecordId: 'record-1' },
      { observationId: 'obs-without-source', residual: 0.0002, unit: 'm', standardizedResidual: 0.4, standardizedResidualUnit: 'sigma' }
    ]
  }
}

const historicalIneligibleAdjustment = {
  ...adjustment,
  rawSourceIntegrity: { status: 'failed' as const, ledgerEntryCount: 2, errors: ['保留的原始文件内容与导入账本不一致'] },
  sourceEligibility: {
    eligible: false,
    findings: [{ code: 'raw_source_integrity_failed', severity: 'blocking', message: '原始资料完整性校验失败。', suggestion: '恢复保留原件或重新导入。' }]
  },
  run: { ...adjustment.run, id: 'adjustment-historical-ineligible-004', networkId: historicalIneligibleNetwork.id },
  result: { ...adjustment.result, id: 'result-historical-ineligible-004' }
}

const outOfRangeAnchor = { id: 'record-1', sourceRecord: 1, rawOffset: 500, rawLength: 20, rawLineNo: 1, line: 1, recordType: 'GSI', section: 'network.observations', rawSnippet: '{"id":"obs-1","value":0.2}' }
const outOfRangeNetwork = {
  ...network,
  id: 'network-out-of-range-anchor-005',
  sourceFile: {
    ...network.sourceFile,
    name: 'out-of-range-anchor.gsi',
    records: [outOfRangeAnchor],
    rawRecordAnchors: [outOfRangeAnchor]
  }
}

const wholeFileAnchor = { id: 'record-1', sourceRecord: 1, rawOffset: 0, rawLength: 512, rawLineNo: 1, line: 1, recordType: 'GSI', section: 'network.observations', rawSnippet: '{"id":"obs-1","value":0.2}' }
const secondRawRecordAnchor = { id: 'record-2', sourceRecord: 2, rawOffset: 137, rawLength: 29, rawLineNo: 2, line: 2, recordType: 'GSI', section: 'network.observations', rawSnippet: '{"id":"obs-2","value":0.3}' }
const wholeFileAnchorNetwork = {
  ...network,
  id: 'network-whole-file-anchor-006',
  sourceFile: {
    ...network.sourceFile,
    name: 'whole-file-anchor.gsi',
    recordCount: 2,
    summary: { ...network.sourceFile.summary, recordCount: 2 },
    records: [wholeFileAnchor, secondRawRecordAnchor],
    rawRecordAnchors: [wholeFileAnchor, secondRawRecordAnchor]
  }
}

const outOfRangeAdjustment = {
  ...adjustment,
  run: { ...adjustment.run, id: 'adjustment-out-of-range-005', networkId: outOfRangeNetwork.id },
  result: {
    ...adjustment.result,
    id: 'result-out-of-range-005',
    observations: [{ observationId: 'obs-1', residual: 0.0001, unit: 'm', standardizedResidual: 0.2, standardizedResidualUnit: 'sigma', sourceRecordId: 'record-1' }]
  }
}

const wholeFileAnchorAdjustment = {
  ...adjustment,
  run: { ...adjustment.run, id: 'adjustment-whole-file-006', networkId: wholeFileAnchorNetwork.id },
  result: {
    ...adjustment.result,
    id: 'result-whole-file-006',
    observations: [{ observationId: 'obs-1', residual: 0.0001, unit: 'm', standardizedResidual: 0.2, standardizedResidualUnit: 'sigma', sourceRecordId: 'record-1' }]
  }
}

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  validationResponse = undefined
  runtimeRequest = vi.fn(async (path: string, method?: string) => {
    if (path === '/v1/engineering/survey/networks?projectId=project-restored-001' && method === 'GET') {
      return runtimeResponse({ networks: [network, archiveOnlyNetwork, legacyNetwork, pendingEligibilityNetwork, historicalIneligibleNetwork, outOfRangeNetwork, wholeFileAnchorNetwork] })
    }
    if (path === '/v1/engineering/adjustments?projectId=project-restored-001' && method === 'GET') {
      return runtimeResponse({ adjustments: [adjustment, historicalIneligibleAdjustment, outOfRangeAdjustment, wholeFileAnchorAdjustment] })
    }
    if (path === `/v1/engineering/survey/networks/${network.id}/validate` && method === 'POST') {
      return runtimeResponse({ network: validationResponse ?? network })
    }
    if (path === '/v1/engineering/adjustments' && method === 'POST') {
      return runtimeResponse(adjustment)
    }
    throw new Error(`Unexpected Runtime request: ${method} ${path}`)
  })
  Object.defineProperty(window, 'workwise', {
    configurable: true,
    value: {
      runtimeRequest
    }
  })

  container = globalThis.document.createElement('div')
  globalThis.document.body.append(container)
  root = createRoot(container)
  await act(async () => {
    root.render(createElement(SurveyAdjustmentPanel, {
      project: { id: 'project-restored-001', revision: 1 },
      runtimeReady: true
    }))
  })
  await settle()
  await settle()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  Reflect.deleteProperty(window, 'workwise')
  vi.restoreAllMocks()
})

describe('SurveyAdjustmentPanel persisted state restoration', () => {
  it('refreshes external results while preserving the manually selected network and input draft', async () => {
    const selector = container.querySelector<HTMLSelectElement>('#survey-existing-network')!
    await act(async () => { selector.value = archiveOnlyNetwork.id; selector.dispatchEvent(new Event('change', { bubbles: true })) })
    const draft = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${i18n.t('surveyKnownPointsInput')}"]`)!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(draft, 'BM-DRAFT,123.456')
      draft.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const renderRefresh = async (refreshToken: number): Promise<void> => {
      await act(async () => root.render(createElement(SurveyAdjustmentPanel, { project: { id: 'project-restored-001', revision: 1 }, runtimeReady: true, refreshToken })))
      await settle()
    }
    runtimeRequest.mockImplementation(async path => runtimeResponse(path.includes('/survey/networks?')
      ? { networks: [network, { ...archiveOnlyNetwork, revision: 3, sourceFile: { ...archiveOnlyNetwork.sourceFile, name: 'updated-selected.dat' } }] }
      : { adjustments: [] }))
    await renderRefresh(1)
    expect(selector.value).toBe(archiveOnlyNetwork.id)
    expect(container.textContent).toContain('updated-selected.dat')
    expect(container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${i18n.t('surveyKnownPointsInput')}"]`)?.value).toBe('BM-DRAFT,123.456')
    expect(container.querySelector('[data-evidence-key="survey-selection"]')).toBeNull()
    expect(runtimeRequest.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true)
    const preserved = container.textContent
    runtimeRequest.mockRejectedValue(new Error('read unavailable'))
    await renderRefresh(2)
    expect(selector.value).toBe(archiveOnlyNetwork.id)
    expect(container.textContent).toContain('updated-selected.dat')
    expect(container.textContent).toContain('read unavailable')
    expect(preserved).toContain('updated-selected.dat')
  })

  it('reads a completed external adjustment without requiring a selection or remount', async () => {
    runtimeRequest.mockImplementation(async path => runtimeResponse(path.includes('/survey/networks?')
      ? { networks: [{ ...network, revision: 3 }] }
      : { adjustments: [{ ...adjustment, result: { ...adjustment.result, algorithmVersion: 'external-adjustment-v2' } }] }))
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, { project: { id: 'project-restored-001', revision: 1 }, runtimeReady: true, refreshToken: 1 })))
    await settle()
    expect(container.textContent).toContain('external-adjustment-v2')
    expect(container.querySelector<HTMLSelectElement>('#survey-existing-network')?.value).toBe(network.id)
  })

  const navigationTarget: SurveyEvidenceNavigationTarget = { kind: 'survey', workspaceRoot: '/survey', projectId: 'project-restored-001', projectRevision: 1, networkId: network.id, networkRevision: network.revision, sourceSha256: network.sourceFile.sha256, adjustmentId: adjustment.run.id, section: 'result', observationId: 'obs-1', sourceRecordId: 'record-1' }
  async function navigate(target: SurveyEvidenceNavigationTarget) {
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, { project: { id: 'project-restored-001', revision: 1, workspace: '/survey' }, runtimeReady: true, navigationTarget: target })))
    await settle()
  }

  it('locates the exact residual and original record without writing data or changing the draft', async () => {
    const scope = JSON.stringify(['/survey', 'project-restored-001'])
    useEngineeringConversationDrafts.getState().update(scope, draft => ({ ...draft, input: 'Keep this question', evidenceContext: { ...navigationTarget } }))
    runtimeRequest.mockClear()
    await navigate(navigationTarget)
    expect(document.activeElement?.getAttribute('data-evidence-key')).toBe(JSON.stringify(['observation', 'obs-1']))
    expect(container.textContent).toContain('{"id":"obs-1","value":0.2}')
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.input).toBe('Keep this question')
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.evidenceContext?.sourceRecordId).toBe('record-1')
    expect(runtimeRequest.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  })

  it('re-reads an already mounted network before locating and rejects a revision changed outside the panel', async () => {
    runtimeRequest.mockImplementation(async path => runtimeResponse(path.includes('/survey/networks?') ? { networks: [{ ...network, revision: network.revision + 1 }] } : { adjustments: [adjustment] }))
    await navigate(navigationTarget)
    expect(container.textContent).toContain(i18n.t('engineeringEvidenceUnavailable'))
    expect(container.querySelector('[data-evidence-key="survey-selection"]')).toBeNull()
    expect(runtimeRequest.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  })

  it('consumes a navigation request once and preserves a later manual network selection', async () => {
    await navigate(navigationTarget)
    const selector = container.querySelector<HTMLSelectElement>('#survey-existing-network')!
    await act(async () => { selector.value = archiveOnlyNetwork.id; selector.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => { await i18n.changeLanguage('en') })
    expect(selector.value).toBe(archiveOnlyNetwork.id)
    expect(container.querySelector('[data-evidence-key="survey-selection"]')).toBeNull()
    await navigate({ ...navigationTarget })
    expect(selector.value).toBe(network.id)
    expect(container.querySelector('[data-evidence-key="survey-selection"]')).not.toBeNull()
  })

  it.each([
    { projectId: 'other-project' }, { workspaceRoot: '/other' }, { projectRevision: 9 },
    { networkRevision: 99 }, { sourceSha256: 'c'.repeat(64) }, { adjustmentId: 'missing-run' },
    { observationId: 'missing-observation' }, { sourceRecordId: 'missing-record' },
    { diagnosticIndex: 99 }, { pointId: 'missing-point' }
  ])('refuses an unavailable or mismatched navigation binding: %j', async patch => {
    await navigate({ ...navigationTarget, ...patch })
    expect(container.textContent).toContain(i18n.t('engineeringEvidenceUnavailable'))
    expect(container.querySelector('[data-evidence-key="survey-selection"]')).toBeNull()
  })

  it('locates diagnostics and source anchors beyond the first twenty displayed rows', async () => {
    const many = { ...network, sourceFile: { ...network.sourceFile,
      diagnostics: Array.from({ length: 31 }, (_, index) => ({ code: `diagnostic-${index}`, severity: 'warning', message: `Exact diagnostic ${index}` })),
      records: Array.from({ length: 31 }, (_, index) => ({ ...network.sourceFile.records[0]!, id: `record-${index}`, rawOffset: index, rawLength: 1, rawSnippet: `Exact raw record ${index}` }))
    } }
    runtimeRequest.mockImplementation(async path => runtimeResponse(path.includes('/survey/networks?') ? { networks: [many] } : { adjustments: [adjustment] }))
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, { project: { id: 'project-restored-001', revision: 1, workspace: '/survey' }, runtimeReady: false })))
    await navigate({ ...navigationTarget, section: 'network', adjustmentId: undefined, observationId: undefined, diagnosticIndex: 30, sourceRecordId: 'record-30' })
    expect(container.textContent).toContain('Exact diagnostic 30')
    expect(container.textContent).toContain('Exact raw record 30')
    expect(document.activeElement?.getAttribute('data-evidence-key')).toBe('source-record')
    expect(runtimeRequest.mock.calls.every(([, method]) => method === 'GET')).toBe(true)
  })

  it('opens a separate trial entry with explicit constraints and leaves formal operations untouched', async () => {
    const trialNav = Array.from(container.querySelectorAll('nav button')).find(item => item.textContent?.includes('自由水准试算')) as HTMLButtonElement
    expect(trialNav).toBeTruthy()
    const callsBefore = runtimeRequest.mock.calls.length
    await act(async () => trialNav.click())
    expect(runtimeRequest.mock.calls).toHaveLength(callsBefore)
    const strip = container.querySelector('.survey-instrument-strip')!
    expect(strip.textContent).toContain('Σ(H − H₀) = 0')
    expect(strip.textContent).toContain('权模型未验证')
    expect(strip.textContent).toContain('仅供试算 · 未作合格判定')
    const panel = container.querySelector('section[aria-label="自由水准试算"]')!
    expect(panel.textContent).toContain('该约束不建立物理高程基准')
    const run = Array.from(panel.querySelectorAll('button')).find(item => item.textContent === '运行试算')!
    expect(run.disabled).toBe(true)
    const resultNav = Array.from(container.querySelectorAll('nav button')).find(item => item.textContent?.includes('平差成果')) as HTMLButtonElement | undefined
    if (resultNav) await act(async () => resultNav.click())
    expect(runtimeRequest.mock.calls).toHaveLength(callsBefore)
  })

  it('connects the leveling precision page to diagnostics using the restored input and source bindings', async () => {
    const inputHash = 'e'.repeat(64)
    const baseRequest = runtimeRequest.getMockImplementation() as (path: string, method: string) => Promise<unknown>
    runtimeRequest.mockImplementation(async (path: string, method: string) => {
      if (path === '/v1/engineering/adjustments?projectId=project-restored-001') {
        return runtimeResponse({ adjustments: [{ ...adjustment, result: { ...adjustment.result, inputHash } }] })
      }
      if (path.endsWith('/statistical-diagnostics')) return runtimeResponse({
        schemaVersion: 1, diagnosticsVersion: 'leveling-deleted-t-1', projectId: 'project-restored-001',
        networkId: network.id, runId: adjustment.run.id, resultId: adjustment.result.id, inputHash,
        algorithmVersion: adjustment.result.algorithmVersion, sourceSha256: network.sourceFile.sha256,
        calculationHash: 'f'.repeat(64), status: 'unavailable', reason: 'insufficient-redundancy', decision: 'not-evaluated'
      })
      return baseRequest(path, method)
    })
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, {
      key: 'statistics-binding', project: { id: 'project-restored-001', revision: 1 }, runtimeReady: true, preferredSection: 'result'
    })))
    await settle(); await settle()
    const panel = container.querySelector('section[aria-label="水准统计诊断"]')!
    const read = panel.querySelector('button') as HTMLButtonElement
    expect(read.disabled).toBe(false)
    await act(async () => read.click())
    expect(runtimeRequest).toHaveBeenLastCalledWith(`/v1/engineering/projects/project-restored-001/adjustments/${adjustment.run.id}/statistical-diagnostics`, 'GET')
    expect(panel.textContent).toContain('自由度不足')
    expect(panel.textContent).toContain('未作统计判定')
    expect(panel.querySelector('table')).toBeNull()
  })

  it('prepares a residual question with exact revision and source identity without executing a model or calculation', async () => {
    const focus = vi.fn()
    const scope = JSON.stringify(['/acceptance', 'project-restored-001'])
    useEngineeringConversationDrafts.setState({ drafts: {} })
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, {
      project: { id: 'project-restored-001', revision: 1, workspace: '/acceptance' },
      runtimeReady: true, preferredSection: 'result', onOpenAi: focus
    })))
    await settle()
    runtimeRequest.mockClear()
    const ask = container.querySelector<HTMLButtonElement>('[aria-label="询问观测 obs-1 的测量 AI"]')!
    await act(async () => ask.click())
    expect(focus).toHaveBeenCalledOnce()
    expect(runtimeRequest).not.toHaveBeenCalled()
    expect(useEngineeringConversationDrafts.getState().drafts[scope]).toMatchObject({
      input: '请解释观测 obs-1 的结果、原始依据及需要复核的问题。',
      viewContext: { networkId: network.id, networkRevision: network.revision, sourceSha256: network.sourceFile.sha256, adjustmentId: adjustment.run.id, algorithmVersion: adjustment.result.algorithmVersion, section: 'result', observationId: 'obs-1', sourceRecordId: 'record-1' }
    })
    useEngineeringConversationDrafts.getState().update(scope, (draft) => ({ ...draft, input: 'Keep my question' }))
    await act(async () => ask.click())
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.input).toBe('Keep my question')
  })

  it('selects the exact known or unknown point from the original network without carrying the current adjustment', async () => {
    const focus = vi.fn(), scope = JSON.stringify(['/survey', 'project-restored-001'])
    useEngineeringConversationDrafts.setState({ drafts: {} })
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, { project: { id: 'project-restored-001', revision: 1, workspace: '/survey' }, runtimeReady: true, preferredSection: 'points', onOpenAi: focus })))
    await settle(); runtimeRequest.mockClear()
    for (const [id, collection] of [['BM-01', 'knownPoints'], ['P-01', 'unknownPoints']]) {
      const ask = container.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t('surveyAskEvidence', { label: id })}"]`)!
      expect(ask).not.toBeNull(); await act(async () => ask.click())
      expect(useEngineeringConversationDrafts.getState().drafts[scope]!.evidenceContext!.typedEvidence).toEqual({ schemaVersion: 1, projectId: 'project-restored-001', projectRevision: 1, kind: 'network', networkId: network.id, networkRevision: network.revision, sourceSha256: network.sourceFile.sha256, selector: { path: [collection, 0], identity: { id } } })
      expect(useEngineeringConversationDrafts.getState().drafts[scope]!.evidenceContext).not.toHaveProperty('adjustmentId')
    }
    expect(runtimeRequest).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledTimes(2)
  })

  it('selects deformation points and pairs bound to both epochs, never the currently displayed adjustment', async () => {
    const focus = vi.fn(), scope = JSON.stringify(['/survey', 'project-restored-001'])
    const comparison = { id: 'comparison-selected', referenceAdjustmentId: 'epoch-reference', currentAdjustmentId: 'epoch-current', inputHash: 'e'.repeat(64), algorithmVersion: 'survey-deformation-1', durationDays: 1, referenceEpoch: '2026-01-01', currentEpoch: '2026-01-02', points: [{ pointId: 'P-01', significant: false, rates: { spatialPerDay: 0 } }], pairs: [{ id: 'pair-1', kind: 'convergence', firstPointId: 'P-01', secondPointId: 'BM-01' }] }
    const original = runtimeRequest.getMockImplementation() as (path: string, method?: string) => Promise<ReturnType<typeof runtimeResponse>>
    runtimeRequest.mockImplementation(async (path: string, method?: string) => path === '/v1/engineering/deformations' ? runtimeResponse({ deformation: comparison }) : original(path, method))
    useEngineeringConversationDrafts.setState({ drafts: {} })
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, { project: { id: 'project-restored-001', revision: 1, workspace: '/survey' }, runtimeReady: true, preferredSection: 'deformation', onOpenAi: focus })))
    await settle()
    const compare = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === i18n.t('surveyCompareEpochs'))!
    expect(compare.disabled).toBe(false); await act(async () => compare.click()); runtimeRequest.mockClear()
    for (const [label, collection, identity] of [['P-01', 'points', { pointId: 'P-01' }], ['pair-1', 'pairs', { id: 'pair-1' }]] as const) {
      await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t('surveyAskEvidence', { label })}"]`)!.click())
      expect(useEngineeringConversationDrafts.getState().drafts[scope]!.evidenceContext!.typedEvidence).toEqual({ schemaVersion: 1, projectId: 'project-restored-001', projectRevision: 1, kind: 'deformation', comparisonId: comparison.id, referenceAdjustmentId: comparison.referenceAdjustmentId, currentAdjustmentId: comparison.currentAdjustmentId, inputHash: comparison.inputHash, algorithmVersion: comparison.algorithmVersion, selector: { path: [collection, 0], identity } })
      expect(useEngineeringConversationDrafts.getState().drafts[scope]!.evidenceContext).not.toHaveProperty('adjustmentId')
    }
    expect(runtimeRequest).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledTimes(2)
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, { project: { id: 'project-restored-001', revision: 2, workspace: '/survey' }, runtimeReady: true, preferredSection: 'deformation', onOpenAi: focus })))
    expect(container.querySelector(`[aria-label="${i18n.t('surveyAskEvidence', { label: 'pair-1' })}"]`)).toBeNull()
  })

  it('keeps duplicate point IDs bound to their displayed collection and offset and disables them during project loading', async () => {
    const focus = vi.fn(), scope = JSON.stringify(['/survey', 'project-restored-001'])
    const duplicated = { ...network, knownPoints: [{ id: 'DUP', height: 100 }, { id: 'DUP', height: 101 }], unknownPoints: [{ id: 'DUP', height: 102 }] }
    const original = runtimeRequest.getMockImplementation() as (path: string, method?: string) => Promise<ReturnType<typeof runtimeResponse>>
    runtimeRequest.mockImplementation(async (path: string, method?: string) => path.startsWith('/v1/engineering/survey/networks?') ? runtimeResponse({ networks: [duplicated] }) : original(path, method))
    useEngineeringConversationDrafts.setState({ drafts: {} })
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, { key: 'duplicates', project: { id: 'project-restored-001', revision: 1, workspace: '/survey' }, runtimeReady: true, preferredSection: 'points', onOpenAi: focus })))
    await settle(); runtimeRequest.mockClear()
    const questions = [...container.querySelectorAll<HTMLButtonElement>(`[aria-label="${i18n.t('surveyAskEvidence', { label: 'DUP' })}"]`)]
    expect(questions).toHaveLength(3)
    for (const [index, path] of [['knownPoints', 0], ['knownPoints', 1], ['unknownPoints', 0]].entries()) {
      await act(async () => questions[index]!.click())
      expect(useEngineeringConversationDrafts.getState().drafts[scope]!.evidenceContext!.typedEvidence!.selector).toEqual({ path, identity: { id: 'DUP' } })
    }
    runtimeRequest.mockImplementation(() => new Promise(() => {}))
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, { key: 'duplicates', project: { id: 'project-other', revision: 1, workspace: '/survey' }, runtimeReady: true, preferredSection: 'points', onOpenAi: focus })))
    for (const ask of container.querySelectorAll<HTMLButtonElement>(`[aria-label="${i18n.t('surveyAskEvidence', { label: 'DUP' })}"]`)) {
      expect(ask.disabled).toBe(true); await act(async () => ask.click())
    }
    expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify(['/survey', 'project-other'])]).toBeUndefined()
    expect(focus).toHaveBeenCalledTimes(3)
  })

  it('prepares preflight, observation, closure and precision questions with exact source references', async () => {
    const focus = vi.fn()
    const scope = JSON.stringify(['/survey', 'project-restored-001'])
    const renderSection = async (preferredSection: 'network' | 'observations' | 'result'): Promise<void> => {
      await act(async () => root.render(createElement(SurveyAdjustmentPanel, {
        project: { id: 'project-restored-001', revision: 1, workspace: '/survey' }, runtimeReady: true, preferredSection, onOpenAi: focus
      })))
      await settle()
    }
    await renderSection('network')
    runtimeRequest.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="询问 mapping_required #2 的测量 AI"]')!.click())
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.evidenceContext).toMatchObject({ networkId: network.id, sourceSha256: network.sourceFile.sha256, diagnosticCode: 'mapping_required', diagnosticIndex: 1, section: 'preflight', parserVersion: network.sourceFile.parserVersion })
    await renderSection('observations')
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="询问观测 obs-1 的测量 AI"]')!.click())
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.evidenceContext?.observationId).toBe('obs-1')
    await renderSection('result')
    for (const metric of ['closure', 'precision']) {
      const label = i18n.t(metric === 'closure' ? 'surveyClosureReview' : 'surveyMaxPointError')
      const aria = i18n.t('surveyAskEvidence', { label })
      const ask = [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === aria)!
      await act(async () => ask.click())
      expect(useEngineeringConversationDrafts.getState().drafts[scope]?.evidenceContext).toMatchObject({ metric, adjustmentId: adjustment.run.id, networkRevision: network.revision, algorithmVersion: adjustment.result.algorithmVersion })
    }
    expect(focus).toHaveBeenCalledTimes(4)
    expect(runtimeRequest.mock.calls.filter(([, method]) => method !== 'GET')).toHaveLength(0)
  })

  it('keeps saved evidence readable but locks all computation entries after Runtime disconnects', async () => {
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, {
      project: { id: 'project-restored-001', revision: 1 }, runtimeReady: false, preferredSection: 'network'
    })))
    await settle()
    runtimeRequest.mockClear()
    for (const label of ['质量校核', '运行平差', '导入结构化网络']) {
      const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)
      expect(button, label).toBeDefined()
      expect(button?.disabled, label).toBe(true)
      await act(async () => button?.click())
    }
    expect(container.textContent).toContain(network.sourceFile.name)
    const observations = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.startsWith('观测表'))!
    await act(async () => observations.click())
    const revalidate = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === '重新校核')!
    expect(revalidate.disabled).toBe(true)
    await act(async () => revalidate.click())
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('does not equate residual checks with compliance to an unspecified project tolerance', async () => {
    expect(container.textContent).toContain('计算校核通过')
    expect(container.textContent).toContain('项目限差需另行复核')
    expect(container.textContent).not.toContain('满足项目精度')
    await act(async () => i18n.changeLanguage('en'))
    expect(container.textContent).toContain('project tolerance requires separate review')
    expect(container.textContent).not.toContain('Within project precision')
  })

  it('uses a keyboard accessible localized file button without exposing the system file-input label', async () => {
    await act(async () => i18n.changeLanguage('en'))
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, {
      project: { id: 'project-restored-001', revision: 1 }, runtimeReady: true, preferredSection: 'network'
    })))
    const picker = container.querySelector<HTMLButtonElement>('button[aria-label="Choose survey files"]')!
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(picker.disabled).toBe(false)
    expect(input.hidden).toBe(true)
    expect(input.tabIndex).toBe(-1)
    const open = vi.spyOn(input, 'click').mockImplementation(() => {})
    await act(async () => picker.click())
    expect(open).toHaveBeenCalledOnce()
  })

  it('admits a valid one-off adjustment to delivery without inventing an observation epoch', async () => {
    const oneOff = { ...adjustment, observationEpoch: undefined }
    runtimeRequest.mockImplementation(async (path: string, method?: string) => {
      if (path.includes('/survey/networks?')) return runtimeResponse({ networks: [network] })
      if (path.includes('/adjustments?')) return runtimeResponse({ adjustments: [oneOff] })
      if (path === '/v1/engineering/adjustments' && method === 'POST') return runtimeResponse(oneOff)
      throw new Error(path)
    })
    const delivered = vi.fn()
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, {
      key: 'one-off', project: { id: 'one-off', revision: 1 }, runtimeReady: true,
      preferredSection: 'network', onAdjustmentComplete: delivered
    })))
    await settle()
    const run = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '运行平差')!
    expect(run.disabled).toBe(false)
    await act(async () => run.click())
    await settle()
    expect(delivered).toHaveBeenCalledWith(oneOff.run.id)
    expect(container.textContent).not.toContain('历史平差结果不可用于新计算')
    const epoch = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.startsWith('期次变形'))!
    expect(epoch.textContent).toContain('0')
  })

  it('opens each requested production section while preserving the current network', async () => {
    for (const section of ['network', 'points', 'result'] as const) {
      await act(async () => root.render(createElement(SurveyAdjustmentPanel, {
        project: { id: 'project-restored-001', revision: 1 }, runtimeReady: true, preferredSection: section
      })))
      await settle()
      const selected = container.querySelector<HTMLSelectElement>('#survey-existing-network')
      expect(selected?.value).toBe(network.id)
      const labels = { network: '网形与基准', points: '点位与坐标', result: '平差结果' }
      expect(container.querySelector('nav button[aria-current="page"]')?.textContent).toContain(labels[section])
    }
  })

  it('requires quality validation before enabling adjustment even when source admission succeeds', async () => {
    runtimeRequest.mockImplementation(async (path: string) => path.includes('/survey/networks?')
      ? runtimeResponse({ networks: [{ ...network, qualityStatus: 'imported' }] })
      : runtimeResponse({ adjustments: [] }))
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, {
      key: 'unvalidated', project: { id: 'unvalidated', revision: 1 }, runtimeReady: true
    })))
    await settle()
    const run = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '运行平差')!
    const validate = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '质量校核')!
    expect(run.disabled).toBe(true)
    expect(validate.disabled).toBe(false)
  })

  it.each(['archive-only', 'converter-required', 'gnss-processing-required', 'quality-blocked'])('omits the adjustment command for %s', async (state) => {
    const blocked = state === 'quality-blocked'
      ? { ...network, qualityStatus: 'blocked', findings: [{ severity: 'blocking', message: 'Declared datum is incomplete.' }] }
      : { ...archiveOnlyNetwork, sourceFile: { ...archiveOnlyNetwork.sourceFile, disposition: state } }
    runtimeRequest.mockImplementation(async (path: string) => path.includes('/survey/networks?')
      ? runtimeResponse({ networks: [blocked] })
      : runtimeResponse({ adjustments: [] }))
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, {
      key: state, project: { id: 'blocked', revision: 1 }, runtimeReady: true
    })))
    await settle()
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '运行平差')).toBe(false)
    expect(runtimeRequest.mock.calls.some(([path, method]) => path === '/v1/engineering/adjustments' && method === 'POST')).toBe(false)
  })

  it('retains the blocked source identity when asking AI to plan missing data', async () => {
    const focus = vi.fn()
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, {
      project: { id: 'project-restored-001', revision: 1, workspace: '/blocked-survey' },
      runtimeReady: true, preferredSection: 'network', onOpenAi: focus
    })))
    await settle()
    const selector = container.querySelector<HTMLSelectElement>('#survey-existing-network')!
    await act(async () => {
      selector.value = archiveOnlyNetwork.id
      selector.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const ask = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === i18n.t('surveyPlanMissingData'))!
    await act(async () => ask.click())
    expect(focus).toHaveBeenCalledOnce()
    expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify(['/blocked-survey', 'project-restored-001'])]?.evidenceContext).toMatchObject({
      projectId: 'project-restored-001', networkId: archiveOnlyNetwork.id,
      networkRevision: archiveOnlyNetwork.revision, sourceSha256: archiveOnlyNetwork.sourceFile.sha256,
      parserId: archiveOnlyNetwork.sourceFile.parserId, section: 'preflight'
    })
  })

  it('requires separate mappings for each IN1 attachment and imports the batch only after confirmation', async () => {
    const files = [new File(['K1,10\nK2,11\nK1,P1,0.5,0.1\nP1,K2,0.5,0.1'], 'first.in1'), new File(['second file'], 'second.in1'), new File(['plane file'], 'plane.in2')]
    const removePending = vi.fn()
    const baseRequest = runtimeRequest.getMockImplementation() as (path: string, method: string, body?: string) => Promise<unknown>
    runtimeRequest.mockImplementation(async (path: string, method: string, body?: string) => {
      if (path === '/v1/engineering/survey/networks/import') {
        const input = JSON.parse(body!)
        return runtimeResponse({ network: { ...network, id: `imported-${input.name}`, sourceFile: { ...network.sourceFile, name: input.name } } })
      }
      if (path === '/v1/engineering/survey/source-groups/cosa/inspect') return runtimeResponse({ inspection: { groups: [], diagnostics: [] } })
      return baseRequest(path, method, body)
    })
    await act(async () => root.render(createElement(SurveyAdjustmentPanel, { project: { id: 'project-restored-001', revision: 1 }, runtimeReady: true, pendingFiles: files, onRemovePendingFile: removePending })))
    const imports = (): Record<string, unknown>[] => runtimeRequest.mock.calls.filter(([path]) => path === '/v1/engineering/survey/networks/import').map(([, , body]) => JSON.parse(body as string))
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.includes('导入预检'))!
    await act(async () => button.click())
    expect(imports()).toHaveLength(0)
    expect(container.querySelector('form')?.textContent).toContain('first.in1')
    for (const count of ['2', '3']) {
      await act(async () => {
        const input = container.querySelector<HTMLInputElement>('form input[type=number]')!
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, count)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
      if (count === '2') {
        expect(imports()).toHaveLength(0)
        expect(container.querySelector('form')?.textContent).toContain('second.in1')
      }
    }
    await vi.waitFor(() => expect(imports()).toHaveLength(3))
    await settle()
    expect(imports()[0]).toMatchObject({ name: 'first.in1', cosaIn1Mapping: { knownPointRecordCount: 2, heightUnit: 'm', routeLengthUnit: 'km' } })
    expect(imports()[1]).toMatchObject({ name: 'second.in1', cosaIn1Mapping: { knownPointRecordCount: 3 } })
    expect(imports()[2]).not.toHaveProperty('cosaIn1Mapping')
    expect(removePending).toHaveBeenCalledTimes(3)
    expect(container.querySelector('form')).toBeNull()
  })

  it('follows the global language switch without resetting selection or opening a blocked gate', async () => {
    const selector = container.querySelector<HTMLSelectElement>('[aria-label="已有测量网络"]')
    expect(selector?.value).toBe(network.id)

    await act(async () => { await i18n.changeLanguage('en') })
    await settle()
    expect(container.querySelector('h3')?.textContent).toContain('Survey and adjustment console')
    const networkTab = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Network and datum'))
    await act(async () => networkTab?.click())
    await settle()
    expect(container.textContent).toContain('Field mapping requires confirmation for record 19.')
    expect(container.textContent).toContain('Confirm units for record 19 and reimport.')
    expect(container.textContent).not.toContain('字段映射需要确认。')
    expect(selector?.value).toBe(network.id)

    await act(async () => {
      if (selector) {
        selector.value = archiveOnlyNetwork.id
        selector.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    await settle()
    const adjustButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Run adjustment'))
    expect(adjustButton).toBeUndefined()
    expect(container.textContent).toContain('Original retained only')
  })

  it('advertises P0 COSA and South chooser extensions, while showing only implemented execution semantics', async () => {
    const networkTab = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('网形与基准'))
    await act(async () => networkTab?.click())
    const input = container.querySelector<HTMLInputElement>('input[aria-label="选择专业测量文件"]')
    expect(input?.accept).toContain('.in1')
    expect(input?.accept).toContain('.in2')
    expect(input?.accept).toContain('.net')
    expect(input?.accept).toContain('.ou1')
    expect(input?.accept).toContain('.ou2')
    expect(input?.accept).toContain('.xyo')
    expect(input?.accept).toContain('.clo')
    expect(input?.accept).toContain('.gco')
    expect(input?.accept).toContain('.txt')
    expect(container.querySelector('#survey-adjustment-method')?.textContent).toContain('平差方法 / 权模型')
    expect(container.querySelector('#survey-adjustment-method')?.textContent).toContain('加权最小二乘')
    expect(container.querySelector('#survey-constraint-mode')?.textContent).toContain('固定已知点')
    expect(container.querySelector('[aria-label="当前 Runtime 约束"]')?.textContent).toContain('固定已知点')
    expect(container.querySelector('[aria-label="当前 Runtime 执行方式"]')?.textContent).toContain('加权最小二乘')

    const adjustButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('运行平差'))
    await act(async () => adjustButton?.click())
    await settle()

    const adjustmentCall = runtimeRequest.mock.calls.find(([path, method]) => path === '/v1/engineering/adjustments' && method === 'POST')
    expect(adjustmentCall).toBeDefined()
    const requestBody = JSON.parse(String(adjustmentCall?.[2])) as Record<string, unknown>
    expect(requestBody).not.toHaveProperty('method')
    expect(requestBody).not.toHaveProperty('constraint')
  })

  it('does not label a validation replay as passed after current source eligibility is revoked', async () => {
    validationResponse = {
      ...network,
      sourceEligibility: {
        eligible: false,
        findings: [{ code: 'raw_source_integrity_failed', severity: 'blocking', message: '原始资料完整性校验失败。' }]
      }
    }
    const networkTab = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('网形与基准'))
    await act(async () => networkTab?.click())
    const validateButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('质量校核'))
    await act(async () => validateButton?.click())
    await settle()

    expect(container.textContent).toContain('当前来源资格已失效；结果仅可审计查看，不能运行平差。')
    expect(container.textContent).not.toContain('质量校核通过，可以运行平差。')
  })

  it('restores the latest network and its deterministic result after remount', () => {
    const selector = container.querySelector<HTMLSelectElement>('[aria-label="已有测量网络"]')
    expect(selector).not.toBeNull()
    expect(selector?.value).toBe(network.id)
    expect(container.querySelector('[aria-current="page"]')?.textContent).toContain('平差结果')
    expect(container.textContent).toContain('观测 / 未知数')
    expect(container.textContent).toContain('1 / 1')
    expect(container.textContent).toContain('2e-7')
    expect(container.textContent).toContain('adjustment-restored-001')
    expect(container.textContent).toContain('点位成果与复核摘要')
    expect(container.textContent).toContain('Leica GSI-8')
    expect(container.textContent).toContain('可进入校核与平差')
  })

  it('shows Runtime ellipse axes and conventions in both languages without inventing legacy precision', async () => {
    expect(container.textContent).toContain('长半轴 0.006 m · 短半轴 0.003 m')
    expect(container.textContent).toContain('轴向：30°')
    expect(container.textContent).toContain('不代表置信百分比')
    const legacyRow = [...container.querySelectorAll('tr')].find(row => row.textContent?.startsWith('P-01'))
    expect(legacyRow?.lastElementChild?.textContent).toBe('—')
    await act(async () => { await i18n.changeLanguage('en') })
    expect(container.textContent).toContain('a = 0.006 m · b = 0.003 m')
    expect(container.textContent).toContain('Orientation: 30°')
    expect(container.textContent).toContain('GNSS XY is not local east/north')
    expect(container.textContent).toContain('Posterior variance')
  })

  it('shows professional source preflight, diagnostics, hashes, filters, and raw anchors', async () => {
    const networkTab = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('网形与基准'))
    expect(networkTab).toBeDefined()
    await act(async () => networkTab?.click())

    expect(container.querySelector('[aria-label="专业测量来源预检"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="来源合同明细"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="按来源格式筛选"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="按平差就绪状态筛选"]')).not.toBeNull()
    expect(container.textContent).toContain('survey-format-registry')
    expect(container.textContent).toContain('a'.repeat(64))
    expect(container.textContent).toContain('声明扩展名')
    expect(container.textContent).toContain('内容探测格式')
    expect(container.textContent).toContain('GSI 米制末位 1 mm → m')
    expect(container.textContent).toContain('gon → rad')
    expect(container.textContent).toContain('CGCS2000 / 1985 国家高程基准')
    expect(container.textContent).toContain('内容签名、记录结构和单位声明均已通过预检。')
    expect(container.textContent).toContain('p'.repeat(64))
    expect(container.textContent).toContain('2 / 1')
    expect(container.textContent).toContain('1 / 1 / 0')
    expect(container.textContent).toContain('未使用转换器')
    expect(container.textContent).toContain('识别为 Leica GSI-8')
    expect(container.textContent).toContain('下一步：确认字段映射、单位和基准后重新导入。')
    expect(container.textContent).toContain('原始资料身份已验证')

    const recordsButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('查看 1'))
    await act(async () => recordsButton?.click())
    expect(container.textContent).toContain('GSI')
    expect(container.textContent).toContain('行 1')
    expect(container.textContent).not.toContain('{"id":"obs-1","value":0.2}')

    const input = container.querySelector<HTMLInputElement>('input[aria-label="选择专业测量文件"]')
    expect(input?.accept).toContain('.gsi')
    expect(input?.accept).toContain('.suc')
    expect(input?.accept).toContain('.t02')
    expect(input?.accept).toContain('.ubx')
    expect(input?.accept).toContain('.sbf')
    expect(input?.accept).toContain('.gts')
    expect(input?.accept).toContain('.survey')
    expect(input?.accept).toContain('.sth')
    expect(input?.accept).toContain('.zhd')
    expect(input?.accept).toContain('.19o')
    expect(input?.accept).toContain('.rtcm3')
  })

  it('links a residual to its exact raw-source anchor and keeps missing source IDs explicit', async () => {
    expect(container.textContent).toContain('原始记录')
    expect(container.textContent).toContain('record-1')
    expect(container.textContent).toContain('未关联原始记录')

    const locateButton = container.querySelector<HTMLButtonElement>('[aria-label="定位 obs-1 的原始记录 record-1"]')
    expect(locateButton).not.toBeNull()
    await act(async () => locateButton?.click())

    const locator = container.querySelector('[aria-label="残差原始记录定位"]')
    expect(locator).not.toBeNull()
    expect(locator?.textContent).toContain('原始记录定位')
    expect(locator?.textContent).toContain('record-1')
    expect(locator?.textContent).toContain('network.observations')
    expect(locator?.textContent).toContain('字节偏移')
    expect(locator?.textContent).toContain('137')
    expect(locator?.textContent).toContain('字节长度')
    expect(locator?.textContent).toContain('29')
    expect(locator?.textContent).toContain('{"id":"obs-1","value":0.2}')
  })

  it('does not present out-of-range or multi-record whole-file anchors as precise raw evidence', async () => {
    const selector = container.querySelector<HTMLSelectElement>('[aria-label="已有测量网络"]')
    expect(selector).not.toBeNull()

    await act(async () => {
      if (!selector) return
      selector.value = outOfRangeNetwork.id
      selector.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const firstLocateButton = container.querySelector<HTMLButtonElement>('[aria-label="定位 obs-1 的原始记录 record-1"]')
    await act(async () => firstLocateButton?.click())
    let locator = container.querySelector('[aria-label="残差原始记录定位"]')
    expect(locator?.textContent).toContain('原始记录不可定位')
    expect(locator?.textContent).toContain('超出保留源文件边界')
    expect(locator?.textContent).not.toContain('字节偏移')

    await act(async () => {
      if (!selector) return
      selector.value = wholeFileAnchorNetwork.id
      selector.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const secondLocateButton = container.querySelector<HTMLButtonElement>('[aria-label="定位 obs-1 的原始记录 record-1"]')
    await act(async () => secondLocateButton?.click())
    locator = container.querySelector('[aria-label="残差原始记录定位"]')
    expect(locator?.textContent).toContain('原始记录不可定位')
    expect(locator?.textContent).toContain('覆盖整份源文件')
    expect(locator?.textContent).not.toContain('字节长度')
  })

  it('keeps converter-required sources locked across network and observation validation entries', async () => {
    const selector = container.querySelector<HTMLSelectElement>('[aria-label="已有测量网络"]')
    expect(selector).not.toBeNull()
    await act(async () => {
      if (!selector) return
      selector.value = archiveOnlyNetwork.id
      selector.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(container.textContent).toContain('声明扩展名')
    expect(container.textContent).toContain('.dat')
    expect(container.textContent).toContain('Trimble T02')
    expect(container.textContent).toContain('与内容冲突')
    expect(container.textContent).toContain('需要人工确认')
    expect(container.textContent).toContain('converter-required: 未安装经审计的本地转换器。')
    expect(container.textContent).toContain('下一步：安装并授权受审计的本地转换器后重新导入。')
    expect(container.textContent).toContain('fixture-trimble-converter 1.0.0')
    expect(container.textContent).toContain('c'.repeat(64))

    const validateButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('质量校核'))
    const adjustButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('运行平差'))
    expect(validateButton?.disabled).toBe(true)
    expect(adjustButton).toBeUndefined()

    const observationsTab = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('观测表'))
    await act(async () => observationsTab?.click())
    const revalidateButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('重新校核'))
    expect(revalidateButton?.disabled).toBe(true)
    expect(revalidateButton?.title).toContain('未安装经审计的本地转换器')
  })

  it('fails closed while source eligibility is absent, even when the source disposition is adjustment-ready', async () => {
    const selector = container.querySelector<HTMLSelectElement>('[aria-label="已有测量网络"]')
    expect(selector).not.toBeNull()
    await act(async () => {
      if (!selector) return
      selector.value = pendingEligibilityNetwork.id
      selector.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(container.textContent).toContain('正在核验来源资格 / 请重新加载。')
    const validateButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('质量校核'))
    const adjustButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('运行平差'))
    expect(validateButton?.disabled).toBe(true)
    expect(adjustButton).toBeUndefined()
  })

  it('keeps a source-revoked historical adjustment readable but excludes it from new period calculations', async () => {
    const selector = container.querySelector<HTMLSelectElement>('[aria-label="已有测量网络"]')
    expect(selector).not.toBeNull()
    await act(async () => {
      if (!selector) return
      selector.value = historicalIneligibleNetwork.id
      selector.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const auditOnlyNotice = container.querySelector('[aria-label="历史平差结果不可用于新计算"]')
    expect(auditOnlyNotice?.textContent).toContain('原始资料完整性校验失败')
    expect(auditOnlyNotice?.textContent).toContain('不可用于期次比较、派生计算或正式成果')
    expect(container.textContent).toContain('仅历史审计')

    const deformationTab = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('期次变形'))
    await act(async () => deformationTab?.click())
    const referenceSelector = container.querySelector<HTMLSelectElement>('[aria-label="参考平差期次"]')
    expect(referenceSelector).not.toBeNull()
    expect([...referenceSelector!.options].map((option) => option.value)).not.toContain(historicalIneligibleAdjustment.run.id)
  })

  it('renders missing legacy provenance as explicit unknown values', async () => {
    const selector = container.querySelector<HTMLSelectElement>('[aria-label="已有测量网络"]')
    expect(selector).not.toBeNull()
    await act(async () => {
      if (!selector) return
      selector.value = legacyNetwork.id
      selector.dispatchEvent(new Event('change', { bubbles: true }))
    })

    expect(container.textContent).toContain('旧记录未提供')
    expect(container.textContent).toContain('未声明')
    expect(container.textContent).toContain('原始资料未验证')
  })
})
