// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineeringWorkspaceView } from './EngineeringWorkspaceView'
import i18n from '../../i18n'
import { dispatchEngineeringProjectCreate, dispatchEngineeringProjectOpen } from './engineering-project-navigation'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { EngineeringEvidenceNavigationTarget } from './engineering-evidence-navigation'

const { request, ensureThread, navigationFixture } = vi.hoisted(() => ({ request: vi.fn(), ensureThread: vi.fn(), navigationFixture: { target: null as unknown } }))
vi.mock('../../agent/runtime-client', () => ({ rendererRuntimeClient: { runtimeRequest: request } }))
vi.mock('../../store/chat-store', () => ({ useChatStore: (select: (s: unknown) => unknown) => select({ ensureEngineeringThread: ensureThread }) }))
vi.mock('./EngineeringAiCommandCenter', () => ({ EngineeringAiCommandCenter: ({ onRefresh, onExecutionSettled, onNavigateEvidence }: { onRefresh: () => void; onExecutionSettled: () => void; onNavigateEvidence: (target: EngineeringEvidenceNavigationTarget) => void }) => createElement('div', {}, createElement('button', { onClick: onRefresh }, 'Refresh confirmed project'), createElement('button', { onClick: onExecutionSettled }, 'Execution settled'), createElement('button', { onClick: () => onNavigateEvidence(navigationFixture.target as EngineeringEvidenceNavigationTarget) }, 'Locate exact test evidence')) }))
vi.mock('./SurveyAdjustmentPanel', () => ({ SurveyAdjustmentPanel: ({ refreshToken }: { refreshToken: number }) => createElement('span', { 'data-testid': 'survey-refresh-token' }, refreshToken) }))
vi.mock('./EngineeringSkillsPanel', () => ({ EngineeringSkillsPanel: () => null }))
const project = { id: 'job', name: 'Test control network', taskType: 'control-network', monitoringType: 'control-network', unit: 'm', signConvention: 'positive', thresholds: {}, reportPeriod: {}, workspace: '/test', revision: 2, updatedAt: '2026-09-19T00:00:00Z' }
const network = { id: 'net', revision: 2, networkType: 'plane-control', qualityStatus: 'validated', sourceFile: { name: 'survey.in2', disposition: 'adjustment-ready' } }
const adjustment = { run: { id: 'adjustment', networkId: 'net', status: 'completed' }, result: { validation: 'valid' }, sourceEligibility: { eligible: true } }
let adjustments: unknown[]
let datasets: unknown[]
let analyses: unknown[]
let manifests: unknown[]
let runs: unknown[]
let latestPreview: unknown
let container: HTMLDivElement
let root: Root
const file = { path: 'new-preview/report.pdf', mediaType: 'application/pdf', sha256: 'a'.repeat(64), sizeBytes: 100 }

async function settle(): Promise<void> { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function renderDelivery(): Promise<void> {
  await act(async () => root.render(createElement(EngineeringWorkspaceView, { workspaceRoot: '/test', runtimeReady: true })))
  await settle()
  const select = container.querySelector<HTMLSelectElement>('#engineering-view-select')!
  await act(async () => { select.value = 'delivery'; select.dispatchEvent(new Event('change', { bubbles: true })) })
}
function button(text: string): HTMLButtonElement {
  const result = [...container.querySelectorAll('button')].find(item => item.textContent === text)
  expect(result, text).toBeDefined()
  return result!
}
function visibleText(element: HTMLElement): string {
  const visible = element.cloneNode(true) as HTMLElement
  visible.querySelectorAll('details:not([open])').forEach((details) => details.remove())
  return visible.textContent ?? ''
}
function deferredResponse() {
  let resolve!: (body: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise<{ ok: boolean; status: number; body: string }>((accept, fail) => {
    resolve = body => accept({ ok: true, status: 200, body: JSON.stringify(body) })
    reject = fail
  })
  return { promise, resolve, reject }
}
function emptyOverview(value = project) { return { project: value, datasets: [], analyses: [], runs: [], manifests: [] } }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } })

  await i18n.changeLanguage('en')
  adjustments = [adjustment]; datasets = []; analyses = []; manifests = []; runs = []; latestPreview = undefined
  navigationFixture.target = null
  useEngineeringConversationDrafts.setState({ drafts: {} })
  request.mockReset()
  request.mockImplementation(async (path: string) => {
    let body: unknown
    if (path === '/v1/engineering/projects') body = { projects: [project] }
    else if (path.endsWith('/overview')) body = { project, datasets, analyses, runs, manifests, latestPreview }
    else if (path.includes('/survey/networks?')) body = { networks: [network] }
    else if (path.includes('/adjustments?')) body = { adjustments }
    else if (path.endsWith('/reports/preview')) body = { run: { id: 'preview' }, files: [file], charts: [], citations: [] }
    else throw new Error(`Unexpected request: ${path}`)
    return { ok: true, status: 200, body: JSON.stringify(body) }
  })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

describe('Survey delivery without a monitoring dataset', () => {
  it('saves structured monitoring limits with the existing project keys and refuses an incomplete value', async () => {
    const limitsProject = { ...project, thresholds: { default: 8, settlement: 10, '隧道收敛': -2.5 } }
    request.mockImplementation(async (path: string, method?: string, requestBody?: string) => {
      const body = method === 'PATCH' ? { project: { ...limitsProject, ...JSON.parse(requestBody!), revision: 3 } }
        : path === '/v1/engineering/projects' ? { projects: [limitsProject] }
          : path.endsWith('/overview') ? emptyOverview(limitsProject)
            : path.includes('/survey/networks?') ? { networks: [network] } : { adjustments: [] }
      return { ok: true, status: 200, body: JSON.stringify(body) }
    })
    await renderDelivery()
    await act(async () => button(i18n.t('engineeringAdvancedNavigation')).click())
    await act(async () => button(i18n.t('engineeringTabProject')).click())
    const limit = container.querySelector<HTMLInputElement>('input[aria-label="Limit (m) 1"]')!
    const setLimit = async (value: string): Promise<void> => { await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(limit, value)
      limit.dispatchEvent(new Event('input', { bubbles: true }))
    }) }
    await setLimit('')
    request.mockClear()
    await act(async () => button(i18n.t('engineeringSaveConfig')).click())
    expect(request.mock.calls.filter(([, method]) => method === 'PATCH')).toHaveLength(0)
    expect(container.textContent).toContain(i18n.t('engineeringThresholdValueError'))
    await setLimit('9')
    await act(async () => button(i18n.t('engineeringSaveConfig')).click())
    const saved = request.mock.calls.find(([, method]) => method === 'PATCH')!
    expect(saved).toBeDefined()
    expect(JSON.parse(saved[2])).toMatchObject({ thresholds: { default: 9, settlement: 10, '隧道收敛': -2.5 } })
    expect(container.querySelector('fieldset legend')?.textContent).toBe(i18n.t('engineeringThresholds'))
  })

  it('shows professional file, source, export and review information without technical identifiers', async () => {
    const outputPath = '/private/var/tmp/railwise-internal/manifest-internal-42/report.pdf'
    const outputHash = 'f'.repeat(64)
    manifests = [{
      id: 'manifest-internal-42', runId: 'run-internal-42', reviewStatus: 'draft',
      outputs: [{ ...file, path: outputPath, sha256: outputHash }],
      citations: [{ id: 'citation-1', sourceType: 'attachment', source: 'COSA.in2', locator: '第 2-5 行' }],
      validation: { valid: true, errors: [], warnings: [] }, finalizedAt: '2026-09-20T00:00:00Z'
    }]
    runs = [{ id: 'run-internal-42', status: 'completed', revision: 1, createdAt: project.updatedAt, updatedAt: project.updatedAt }]
    await renderDelivery()

    let text = visibleText(container)
    expect(text).toContain('report.pdf')
    expect(text).toContain('PDF')
    expect(text).not.toContain('application/pdf')
    expect(text).toContain('COSA.in2')
    expect(text).toContain('第 2-5 行')
    expect(text).toContain(i18n.t('engineeringDraftReady'))
    expect(text).toContain(i18n.t('engineeringStatusDraft'))
    expect(text).not.toContain('manifest-internal-42')
    expect(text).not.toContain('run-internal-42')
    expect(text).not.toContain(outputPath)
    expect(text).not.toContain(outputHash)
    expect(button('Export PDF')).toBeDefined()

    const saveWorkspaceFileAs = vi.fn(async () => ({ ok: true as const, path: '/exports/report.pdf' }))
    const originalWorkwise = Object.getOwnPropertyDescriptor(window, 'workwise')
    Object.defineProperty(window, 'workwise', { configurable: true, value: { saveWorkspaceFileAs } })
    try {
      await act(async () => button('Export PDF').click())
      await settle()
      expect(saveWorkspaceFileAs).toHaveBeenCalledWith({ workspaceRoot: '/test', sourcePath: outputPath, suggestedName: 'report.pdf', mimeType: 'application/pdf' })
      expect(visibleText(container)).toContain(i18n.t('engineeringOutputSaved'))
    } finally {
      if (originalWorkwise) Object.defineProperty(window, 'workwise', originalWorkwise)
      else Reflect.deleteProperty(window, 'workwise')
    }

    const technicalDetailSummaries = [...container.querySelectorAll('details > summary')]
      .filter(summary => [i18n.t('engineeringSourceVersion'), i18n.t('engineeringAdvancedDetails')].includes(summary.textContent ?? ''))
    await act(async () => {
      for (const summary of technicalDetailSummaries) {
        const details = summary.parentElement as HTMLDetailsElement
        details.open = true
        details.dispatchEvent(new Event('toggle'))
      }
    })
    text = container.textContent ?? ''
    expect(text).not.toContain('manifest-internal-42')
    expect(text).not.toContain('run-internal-42')
    expect(text).not.toContain(outputPath)
    expect(text).not.toContain(outputHash)
  })

  it('keeps internal JSON review records out of the default delivery view', async () => {
    manifests = [{
      id: 'manifest-json', runId: 'run-json', reviewStatus: 'draft',
      outputs: [
        { ...file, path: 'report.pdf' },
        { path: 'professional-review.json', mediaType: 'application/json', sha256: 'b'.repeat(64), sizeBytes: 220 }
      ],
      citations: [], validation: { valid: true, errors: [], warnings: [] }
    }]
    await renderDelivery()

    expect(visibleText(container)).toContain('report.pdf')
    expect(visibleText(container)).not.toContain('professional-review.json')
    const internal = [...container.querySelectorAll('details')].find(item => item.querySelector(':scope > summary')?.textContent === i18n.t('engineeringInternalRecords'))
    expect(internal).toBeDefined()
    await act(async () => { internal!.open = true; internal!.dispatchEvent(new Event('toggle')) })
    expect(visibleText(internal!)).toContain('professional-review.json')
    expect(visibleText(internal!)).toContain(i18n.t('engineeringExportFile', { format: 'JSON' }))
  })

  it('keeps project revision counters out of the default delivery view', async () => {
    await renderDelivery()
    await act(async () => button('Deliverables').click())
    const archiveDetails = [...container.querySelectorAll('details')].find(item => item.textContent?.includes(i18n.t('engineeringArchiveDetails')))
    expect(archiveDetails).toBeDefined()
    await act(async () => { archiveDetails!.open = true; archiveDetails!.dispatchEvent(new Event('toggle')) })
    const text = visibleText(container)
    expect(text).toContain(i18n.t('engineeringReviewStatus'))
    expect(text).not.toMatch(/project revision|项目修订|revision 2/i)
  })

  it('maps unrecognized processing states to a professional status label', async () => {
    manifests = [{
      id: 'manifest-unknown-state', runId: 'run-unknown-state', reviewStatus: 'vendor_internal_state_9',
      outputs: [{ ...file, path: 'review.pdf' }],
      validation: { valid: true, errors: [], warnings: [] }, finalizedAt: '2026-09-20T00:00:00Z'
    }]
    await renderDelivery()

    const text = visibleText(container)
    expect(text).toContain(i18n.t('engineeringStatusUnknown'))
    expect(text).not.toContain('vendor_internal_state_9')
  })

  it.each([
    ['failed', 'engineeringStatusFailed'], ['running', 'engineeringStatusRunning'],
    ['queued', 'engineeringStatusQueued'], ['invalid', 'surveyProfessionalFailed'],
    ['blocked', 'engineeringStatusBlocked'], ['needs_attention', 'engineeringStatusNeedsAttention'],
    ['waiting_user', 'engineeringStatusWaitingUser'], ['waiting_approval', 'engineeringStatusWaitingApproval'],
    ['stalled', 'engineeringStatusStalled'], ['retrying', 'engineeringStatusRetrying']
  ])('retains the action-relevant meaning of a %s run without exposing its internal value', async (status, key) => {
    runs = [{ id: 'run-status', status, revision: 1, createdAt: project.updatedAt, updatedAt: project.updatedAt }]
    await renderDelivery()
    const details = [...container.querySelectorAll('details')].find(item => item.querySelector(':scope > summary')?.textContent === i18n.t('engineeringAdvancedDetails'))!
    expect(details).toBeDefined()
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
    expect(visibleText(details)).toContain(i18n.t(key))
    expect(visibleText(details)).not.toContain(i18n.t('engineeringStatusUnknown'))
  })

  it('uses survey language for the visible processing status', async () => {
    const pending = deferredResponse()
    await renderDelivery()
    request.mockImplementation((path: string) => path.endsWith('/reports/preview') ? pending.promise : Promise.resolve({ ok: true, status: 200, body: JSON.stringify(path === '/v1/engineering/projects' ? { projects: [project] } : path.endsWith('/overview') ? { ...emptyOverview(), manifests, latestPreview } : path.includes('/survey/networks?') ? { networks: [network] } : { adjustments }) }))
    await act(async () => button('Generate review draft').click())
    await settle()
    const text = visibleText(container)
    expect(text).toContain('Processing survey data…')
    expect(text).not.toMatch(/local processing|runtime/i)
    await act(async () => pending.resolve({ run: { id: 'preview' }, files: [file], charts: [], citations: [] }))
  })

  it('opens monitoring data and trend analysis from stage navigation when a dataset is selected', async () => {
    datasets = [{ id: 'data', sourceFileName: 'monitor.csv', sourceFileHash: 'a'.repeat(64), fieldMapping: {}, unknownColumns: [], rowCount: 2, columnCount: 3, observationCount: 2, timeRange: {}, status: 'validated', revision: 1, findings: [], updatedAt: project.updatedAt }]
    await renderDelivery()
    const stage = container.querySelector<HTMLSelectElement>('#engineering-view-select')!
    await act(async () => { stage.value = 'import'; stage.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe(i18n.t('engineeringTabData'))
    await act(async () => { stage.value = 'analysis'; stage.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe(i18n.t('engineeringTabAnalysis'))
    expect(container.textContent).toContain(i18n.t('engineeringRunDeterministicAnalysis'))
  })

  it.each(['zh', 'en'])('shows professional mapping labels and preserves original column headings in %s', async language => {
    await i18n.changeLanguage(language)
    const fieldMapping = { monitoringItem: '测量项目原始列', warningThreshold: '预警线（mm）', timestamp: '外业记录时间' }
    datasets = [{ id: 'data', sourceFileName: 'monitor.csv', sourceFileHash: 'a'.repeat(64), fieldMapping, unknownColumns: [], rowCount: 2, columnCount: 3, observationCount: 2, timeRange: {}, status: 'validated', revision: 1, findings: [], updatedAt: project.updatedAt }]
    await renderDelivery()
    const stage = container.querySelector<HTMLSelectElement>('#engineering-view-select')!
    await act(async () => { stage.value = 'import'; stage.dispatchEvent(new Event('change', { bubbles: true })) })
    const labels = [...container.querySelectorAll('dt')].map(item => item.textContent)
    expect(labels).toEqual(expect.arrayContaining([i18n.t('engineeringFieldMonitoringItem'), i18n.t('engineeringFieldWarningThreshold'), i18n.t('engineeringFieldTimestamp')]))
    expect(labels).not.toEqual(expect.arrayContaining(Object.keys(fieldMapping)))
    for (const source of Object.values(fieldMapping)) expect(container.textContent).toContain(source)
    expect(fieldMapping).toEqual({ monitoringItem: '测量项目原始列', warningThreshold: '预警线（mm）', timestamp: '外业记录时间' })
  })

  it('refreshes overview and the mounted survey panel after AI execution without replacing the project draft', async () => {
    adjustments = []
    await act(async () => root.render(createElement(EngineeringWorkspaceView, { workspaceRoot: '/test', runtimeReady: true })))
    await settle()
    const stage = container.querySelector<HTMLSelectElement>('#engineering-view-select')!
    await act(async () => { stage.value = 'adjustment'; stage.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(container.querySelector('[data-testid="survey-refresh-token"]')?.textContent).toBe('0')
    adjustments = [{ ...adjustment, result: { validation: 'valid', precision: { maxPointStdDev: 0.002 } } }]
    request.mockClear()
    await act(async () => button('Execution settled').click())
    await settle()
    expect(container.querySelector('[data-testid="survey-refresh-token"]')?.textContent).toBe('1')
    expect(container.querySelector('[data-testid="engineering-summary-strip"]')?.textContent).toContain('0.002 m')
    expect(request.mock.calls.some(([path]) => path.endsWith('/overview'))).toBe(true)
    expect(request.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true)
    await act(async () => { stage.value = 'import'; stage.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => button('Project setup').click())
    const field = [...container.querySelectorAll('input')].find(input => input.value === project.name)!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, 'Unsubmitted project draft')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Execution settled').click())
    await settle()
    expect(field.value).toBe('Unsubmitted project draft')
  })

  it('opens and focuses the exact dataset finding while keeping the conversation mounted', async () => {
    const sha = 'a'.repeat(64)
    datasets = [{ id: 'data', sourceFileName: 'source.csv', sourceFileHash: sha, fieldMapping: {}, unknownColumns: [], rowCount: 25, columnCount: 2, observationCount: 25, timeRange: {}, status: 'validated', revision: 4, findings: [{ id: 'finding-25', code: 'missing', severity: 'blocking', status: 'open', message: 'Missing record', suggestion: 'Check record', row: 25 }], updatedAt: project.updatedAt }]
    await renderDelivery()
    const chat = container.querySelector('[data-testid="engineering-persistent-chat"]')
    navigationFixture.target = { kind: 'dataset', workspaceRoot: '/test', projectId: 'job', projectRevision: 2, datasetId: 'data', datasetRevision: 4, sourceSha256: sha, findingId: 'finding-25' }
    request.mockClear()
    await act(async () => button('Locate exact test evidence').click())
    expect(document.activeElement?.getAttribute('data-evidence-key')).toBe(JSON.stringify(['finding', 'finding-25']))
    expect(container.querySelector('[data-testid="engineering-persistent-chat"]')).toBe(chat)
    expect(request).not.toHaveBeenCalled()
    await act(async () => container.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t('surveyAskEvidence', { label: 'Missing record' })}"]`)!.click())
    expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify(['/test', 'job'])]!.evidenceContext!.typedEvidence).toEqual({ schemaVersion: 1, projectId: 'job', projectRevision: 2, kind: 'monitoring-dataset', datasetId: 'data', datasetRevision: 4, sourceFileHash: sha, selector: { path: ['findings', 0], identity: { id: 'finding-25' } } })
    expect(request).not.toHaveBeenCalled()
    const initialNoticeClose = container.querySelector<HTMLDivElement>('[role="alert"] button')
    if (initialNoticeClose) await act(async () => initialNoticeClose.click())
    navigationFixture.target = { ...(navigationFixture.target as object), datasetRevision: 3 }
    await act(async () => button('Locate exact test evidence').click())
    await settle()
    expect(container.querySelector('[data-testid="engineering-persistent-chat"]')).toBe(chat)
    expect(request).not.toHaveBeenCalled()
  })

  it('selects the exact monitoring result row without starting a new analysis', async () => {
    const hash = 'a'.repeat(64), inputHash = 'b'.repeat(64)
    datasets = [{ id: 'data', sourceFileName: 'source.csv', sourceFileHash: hash, fieldMapping: {}, unknownColumns: [], rowCount: 2, columnCount: 2, observationCount: 2, timeRange: {}, status: 'validated', revision: 4, findings: [], updatedAt: project.updatedAt }]
    analyses = [{ id: 'analysis', datasetId: 'data', algorithmVersion: 'workwise-engineering-2', inputHash, results: [{ monitoringItem: 'settlement', point: 'P-2', currentValue: 1, cumulativeChange: 1, changeRate: 1, trend: 'stable', anomaly: false, thresholdStatus: 'normal' }] }]
    await renderDelivery()
    navigationFixture.target = { kind: 'analysis', workspaceRoot: '/test', projectId: 'job', projectRevision: 2, analysisId: 'analysis', datasetId: 'data', inputHash, algorithmVersion: 'workwise-engineering-2' }
    await act(async () => button('Locate exact test evidence').click())
    request.mockClear()
    const ask = container.querySelector<HTMLButtonElement>(`[aria-label="${i18n.t('surveyAskEvidence', { label: 'settlement / P-2' })}"]`)!
    expect(ask).not.toBeNull(); await act(async () => ask.click())
    expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify(['/test', 'job'])]!.evidenceContext!.typedEvidence).toEqual({ schemaVersion: 1, projectId: 'job', projectRevision: 2, kind: 'monitoring-analysis', analysisId: 'analysis', datasetId: 'data', inputHash, algorithmVersion: 'workwise-engineering-2', selector: { path: ['results', 0], identity: { monitoringItem: 'settlement', point: 'P-2' } } })
    expect(request).not.toHaveBeenCalled()
  })

  it('opens a non-latest manifest output by exact digest and path', async () => {
    manifests = ['first', 'second'].map(id => ({ id, runId: `run-${id}`, reviewStatus: 'draft', outputs: [{ ...file, path: `${id}/report.pdf` }], citations: [], validation: { valid: true, errors: [], warnings: [] } }))
    await renderDelivery()
    navigationFixture.target = { kind: 'artifact', workspaceRoot: '/test', projectId: 'job', projectRevision: 2, manifestId: 'second', runId: 'run-second', outputPath: 'second/report.pdf', outputSha256: file.sha256 }
    request.mockClear()
    await act(async () => button('Locate exact test evidence').click())
    expect(document.activeElement?.getAttribute('data-evidence-key')).toBe(JSON.stringify(['artifact', 'second', 'second/report.pdf']))
    expect(document.activeElement?.textContent).toContain('report.pdf')
    expect(document.activeElement?.textContent).not.toContain(file.sha256)
    expect(request).not.toHaveBeenCalled()
  })

  it.each(['save', 'preview'] as const)('ignores a delayed %s response after another project is selected', async operation => {
    const original = request.getMockImplementation()!
    const nextProject = { ...project, id: 'next', name: 'Next task' }
    const pending = deferredResponse()
    request.mockImplementation((path: string, method?: string, payload?: string) => {
      if (method === 'PATCH' || path.endsWith('/reports/preview')) return pending.promise
      if (path === '/v1/engineering/projects') return Promise.resolve({ ok: true, status: 200, body: JSON.stringify({ projects: [project, nextProject] }) })
      if (path === '/v1/engineering/projects/next/overview') return Promise.resolve({ ok: true, status: 200, body: JSON.stringify(emptyOverview(nextProject)) })
      return original(path, method, payload)
    })
    await renderDelivery()
    if (operation === 'save') {
      const stage = container.querySelector<HTMLSelectElement>('#engineering-view-select')!
      await act(async () => { stage.value = 'import'; stage.dispatchEvent(new Event('change', { bubbles: true })) })
      await act(async () => button('Project setup').click())
      await act(async () => button('Save configuration').click())
    } else {
      await act(async () => button('Deliverables').click())
      await act(async () => button('Generate review draft').click())
    }
    await act(async () => dispatchEngineeringProjectOpen('next'))
    await settle()
    await act(async () => pending.resolve(operation === 'save'
      ? { project: { ...project, name: 'OLD saved project', revision: 3 } }
      : { run: { id: 'old-run' }, files: [{ ...file, path: 'OLD-preview.pdf' }], charts: [], citations: [] }))
    expect(container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent).toContain('Next task')
    expect(container.textContent).not.toContain('OLD')
    const stage = container.querySelector<HTMLSelectElement>('#engineering-view-select')!
    await act(async () => { stage.value = 'delivery'; stage.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => button('Deliverables').click())
    expect(container.textContent).not.toContain('OLD-preview.pdf')
  })

  it('does not select a project created by a previous workspace after its POST finishes', async () => {
    await renderDelivery()
    const original = request.getMockImplementation()!
    const pending = deferredResponse()
    request.mockImplementation((path: string, method?: string, payload?: string) => method === 'POST' ? pending.promise : original(path, method, payload))
    await act(async () => dispatchEngineeringProjectCreate())
    const nextProject = { ...project, id: 'next', workspace: '/other', name: 'Current workspace project' }
    request.mockImplementation(async path => ({ ok: true, status: 200, body: JSON.stringify(path === '/v1/engineering/projects' ? { projects: [nextProject] } : path.endsWith('/overview') ? emptyOverview(nextProject) : path.includes('/survey/networks?') ? { networks: [] } : { adjustments: [] }) }))
    await act(async () => root.render(createElement(EngineeringWorkspaceView, { workspaceRoot: '/other', runtimeReady: true })))
    await settle()
    await act(async () => pending.resolve({ project: { ...project, id: 'old-created', name: 'OLD created project' } }))
    expect(container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent).toContain('Current workspace project')
    expect(container.textContent).not.toContain('OLD')
    expect(container.querySelector<HTMLSelectElement>('#engineering-project-select')!.value).toBe('next')
  })

  it('keeps the newly created project selected when an older project list finishes last', async () => {
    await renderDelivery()
    const original = request.getMockImplementation()!
    const oldList = deferredResponse()
    const created = { ...project, id: 'new-project', name: 'Newly created project' }
    request.mockImplementation((path: string, method?: string, payload?: string) => {
      if (path === '/v1/engineering/projects') return method === 'POST'
        ? Promise.resolve({ ok: true, status: 200, body: JSON.stringify({ project: created }) }) : oldList.promise
      if (path === '/v1/engineering/projects/new-project/overview') return Promise.resolve({ ok: true, status: 200, body: JSON.stringify(emptyOverview(created)) })
      return original(path, method, payload)
    })
    await act(async () => button('Refresh confirmed project').click())
    await act(async () => dispatchEngineeringProjectCreate())
    await settle()
    await act(async () => oldList.resolve({ projects: [project] }))
    expect(container.querySelector<HTMLSelectElement>('#engineering-project-select')!.value).toBe(created.id)
    expect(container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent).toContain(created.name)
  })

  it('keeps a saved project revision when an older overview GET finishes afterwards', async () => {
    await renderDelivery()
    const original = request.getMockImplementation()!
    const pending = deferredResponse()
    request.mockImplementation((path: string, method?: string, payload?: string) => method === 'PATCH'
      ? Promise.resolve({ ok: true, status: 200, body: JSON.stringify({ project: { ...project, name: 'Saved revision', revision: 3 } }) })
      : path.endsWith('/overview') ? pending.promise : original(path, method, payload))
    await act(async () => button('Refresh confirmed project').click())
    const stage = container.querySelector<HTMLSelectElement>('#engineering-view-select')!
    await act(async () => { stage.value = 'import'; stage.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => button('Project setup').click())
    await act(async () => button('Save configuration').click())
    await act(async () => pending.resolve(emptyOverview({ ...project, name: 'OLD GET revision' })))
    expect(container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent).toContain('Saved revision')
    expect(container.textContent).not.toContain('OLD GET')
  })

  it('clears the previous task immediately and ignores its delayed overview and network responses', async () => {
    await renderDelivery()
    const original = request.getMockImplementation()!
    const oldOverview = deferredResponse(), oldNetworks = deferredResponse(), nextOverview = deferredResponse()
    const nextProject = { ...project, id: 'next', name: 'Next task' }
    request.mockImplementation((path: string) => {
      if (path === '/v1/engineering/projects') return Promise.resolve({ ok: true, status: 200, body: JSON.stringify({ projects: [project, nextProject] }) })
      if (path === '/v1/engineering/projects/job/overview') return oldOverview.promise
      if (path === '/v1/engineering/projects/next/overview') return nextOverview.promise
      if (path.includes('/survey/networks?')) return path.endsWith('job') ? oldNetworks.promise : Promise.resolve({ ok: true, status: 200, body: JSON.stringify({ networks: [{ ...network, id: 'next-net', sourceFile: { ...network.sourceFile, name: 'next.in2' } }] }) })
      return original(path)
    })
    await act(async () => button('Refresh confirmed project').click())
    await act(async () => dispatchEngineeringProjectOpen('next'))
    expect(container.querySelector('[data-testid="engineering-summary-strip"]')).toBeNull()
    await act(async () => nextOverview.resolve(emptyOverview(nextProject)))
    await settle()
    await act(async () => {
      oldOverview.resolve(emptyOverview({ ...project, name: 'STALE TASK' }))
      oldNetworks.resolve({ networks: [{ ...network, sourceFile: { ...network.sourceFile, name: 'stale.in2' } }] })
    })
    const summary = container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent!
    expect(summary).toContain('Next task')
    expect(summary).toContain('next.in2')
    expect(summary).not.toContain('STALE')
    expect(summary).not.toContain('stale.in2')
  })

  it('keeps the newest refresh when older reads of the same project finish last', async () => {
    await renderDelivery()
    const original = request.getMockImplementation()!
    const overviews = [deferredResponse(), deferredResponse()]
    const networks = [deferredResponse(), deferredResponse()]
    let overviewIndex = 0, networkIndex = 0
    request.mockImplementation((path: string) => {
      if (path.endsWith('/overview')) return overviews[overviewIndex++]!.promise
      if (path.includes('/survey/networks?')) return networks[networkIndex++]?.promise ?? original(path)
      return original(path)
    })
    await act(async () => button('Refresh confirmed project').click())
    await act(async () => button('Refresh confirmed project').click())
    await act(async () => {
      overviews[1]!.resolve(emptyOverview({ ...project, name: 'Newest revision', revision: 4 }))
      networks[1]!.resolve({ networks: [{ ...network, sourceFile: { ...network.sourceFile, name: 'newest.in2' } }] })
    })
    await act(async () => {
      overviews[0]!.resolve(emptyOverview({ ...project, name: 'STALE revision' }))
      networks[0]!.resolve({ networks: [] })
    })
    const summary = container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent!
    expect(summary).toContain('Newest revision')
    expect(summary).toContain('newest.in2')
    expect(summary).not.toContain('STALE')
  })

  it('ignores old errors after a newer overview and summary have succeeded', async () => {
    await renderDelivery()
    const original = request.getMockImplementation()!
    const oldOverview = deferredResponse(), oldNetworks = deferredResponse()
    request.mockImplementation((path: string) => path.endsWith('/overview') ? oldOverview.promise : path.includes('/survey/networks?') ? oldNetworks.promise : original(path))
    await act(async () => button('Refresh confirmed project').click())
    request.mockImplementation(original)
    await act(async () => button('Refresh confirmed project').click())
    await act(async () => {
      oldOverview.reject(new Error('STALE overview error'))
      oldNetworks.reject(new Error('STALE network error'))
    })
    expect(container.textContent).not.toContain('STALE')
    expect(container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent).toContain('survey.in2')
  })

  it('keeps internal service diagnostics out of user notices', async () => {
    await renderDelivery()
    const original = request.getMockImplementation()!
    request.mockImplementation((path: string, method?: string, payload?: string) => {
      if (path === '/v1/engineering/projects' && method === 'POST') {
        throw new Error(JSON.stringify({
          error: {
            code: 'survey_parser_contract',
            message: 'POST /v1/engineering/projects failed: sourceSha256=deadbeef contextHash=abc123'
          }
        }))
      }
      return original(path, method, payload)
    })

    await act(async () => dispatchEngineeringProjectCreate())
    await settle()

    const notice = container.querySelector('[role="alert"]')
    expect(notice).toBeDefined()
    expect(notice?.textContent).toContain('This action could not be completed. Please try again.')
    expect(notice?.textContent).not.toMatch(/survey_parser_contract|\/v1\/|sourceSha256|contextHash|deadbeef|abc123/i)
  })

  it('keeps the last valid survey snapshot when a refresh read temporarily fails', async () => {
    await renderDelivery()
    const original = request.getMockImplementation()!
    request.mockImplementation(async (path: string, method?: string, payload?: string) => {
      if (path.includes('/survey/networks?')) throw new Error('temporary survey read failure')
      return original(path, method, payload)
    })

    await act(async () => button('Refresh confirmed project').click())
    await settle()

    const summary = container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent!
    expect(summary).toContain('survey.in2')
    expect(summary).not.toContain(i18n.t('engineeringSummaryNoDataset'))
    expect(summary).toContain(i18n.t('engineeringReadiness.candidate'))
  })

  it('keeps the last valid survey snapshot when reconnect returns an empty read model', async () => {
    await renderDelivery()
    const original = request.getMockImplementation()!
    request.mockImplementation(async (path: string, method?: string, payload?: string) => {
      if (path.includes('/survey/networks?')) return { ok: true, status: 200, body: JSON.stringify({ networks: [] }) }
      if (path.includes('/adjustments?')) return { ok: true, status: 200, body: JSON.stringify({ adjustments: [] }) }
      return original(path, method, payload)
    })

    await act(async () => button('Refresh confirmed project').click())
    await settle()

    const summary = container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent!
    expect(summary).toContain('survey.in2')
    expect(summary).not.toContain(i18n.t('engineeringSummaryNoDataset'))
    expect(summary).toContain(i18n.t('engineeringReadiness.candidate'))
    expect(button('Generate review draft').disabled).toBe(false)
  })

  it.each(['workspace', 'runtime'] as const)('invalidates in-flight project lists and read models on %s changes', async change => {
    await renderDelivery()
    const original = request.getMockImplementation()!
    const oldList = deferredResponse(), oldOverview = deferredResponse(), oldNetworks = deferredResponse()
    request.mockImplementation((path: string) => path === '/v1/engineering/projects' ? oldList.promise : path.endsWith('/overview') ? oldOverview.promise : path.includes('/survey/networks?') ? oldNetworks.promise : original(path))
    await act(async () => button('Refresh confirmed project').click())
    const nextProject = { ...project, name: 'Current environment', workspace: change === 'workspace' ? '/other' : '/test' }
    request.mockImplementation((path: string) => Promise.resolve({ ok: true, status: 200, body: JSON.stringify(
      path === '/v1/engineering/projects' ? { projects: [nextProject] }
        : path.endsWith('/overview') ? emptyOverview(nextProject)
          : path.includes('/survey/networks?') ? { networks: [{ ...network, sourceFile: { ...network.sourceFile, name: 'current.in2' } }] }
            : { adjustments: [] }
    ) }))
    if (change === 'runtime') {
      await act(async () => root.render(createElement(EngineeringWorkspaceView, { workspaceRoot: '/test', runtimeReady: false })))
      expect(container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent).toContain(project.name)
    }
    await act(async () => root.render(createElement(EngineeringWorkspaceView, { workspaceRoot: nextProject.workspace, runtimeReady: true })))
    await settle()
    await act(async () => {
      oldList.resolve({ projects: [{ ...project, id: 'stale', name: 'STALE option' }] })
      oldOverview.resolve(emptyOverview({ ...project, name: 'STALE overview' }))
      oldNetworks.resolve({ networks: [] })
    })
    expect(container.textContent).not.toContain('STALE')
    const summary = container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent!
    expect(summary).toContain('Current environment')
    expect(summary).toContain('current.in2')
  })

  it('opens declared advanced models without a manifest, dataset or formal adjustment and without inferring input', async () => {
    adjustments = []; manifests = []; datasets = []; analyses = []
    await renderDelivery()
    const select = container.querySelector<HTMLSelectElement>('#engineering-view-select')!
    await act(async () => { select.value = 'adjustment'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    request.mockClear()
    await act(async () => button('Advanced model trials').click())
    expect(container.querySelector('section[aria-label="Advanced model trials"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Project job · Revision 2')
    const method = [...container.querySelectorAll('label')].find(label => label.querySelector('span')?.textContent === 'Trial method')!.querySelector('select')!
    expect(method.value).toBe('')
    expect(button('Confirm and save trial').disabled).toBe(true)
    expect(request).not.toHaveBeenCalled()
  })

  it('provides a separate retention entry for each historical manifest without starting mutations', async () => {
    manifests = ['manifest-one', 'manifest-two'].map(id => ({ id, runId: `run-${id}`, reviewStatus: 'draft', outputs: [{ ...file, path: `${id}/report.pdf` }], citations: [], validation: { valid: true, errors: [], warnings: [] } }))
    await renderDelivery(); await act(async () => button('Review and archive').click())
    request.mockClear()
    const entries = [...container.querySelectorAll('details')].filter(details => details.querySelector(':scope > summary')?.textContent === i18n.t('qualityWorkspaceOpen'))
    expect(entries).toHaveLength(2)
    const samplingEntries = [...container.querySelectorAll('details')].filter(details => details.querySelector(':scope > summary')?.textContent === 'Unit product populations and first-round sampling')
    expect(samplingEntries).toHaveLength(1)
    expect(entries.every(entry => !entry.contains(samplingEntries[0]!))).toBe(true)
    await act(async () => { entries[1]!.open = true; entries[1]!.dispatchEvent(new Event('toggle')) })
    expect(entries[1]!.textContent).toContain('Deliverable files included in this review')
    expect(entries[1]!.textContent).not.toContain('Manifest manifest-two · Project revision 2')
    expect(entries[1]!.textContent).toContain('report.pdf')
    expect(entries[1]!.textContent).not.toContain('manifest-two/report.pdf')
    expect(entries[1]!.textContent).not.toContain('manifest-one/report.pdf')
    expect(entries[1]!.querySelector('input')?.checked).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })

  it('announces each review condition and sizes the review columns against the data pane', async () => {
    await renderDelivery()
    await act(async () => button('Review and archive').click())
    const layout = container.querySelector('.engineering-review-layout')!
    expect(layout).not.toBeNull()
    const statuses = Array.from(layout.querySelectorAll('.sr-only')).map(element => element.textContent)
    expect(statuses).toHaveLength(5)
    expect(statuses).toContain(' · Condition met')
    expect(statuses).toContain(' · Condition not met')
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(layout.textContent).toContain('条件已满足')
    expect(layout.textContent).toContain('条件未满足')
    const reviewStyles = readFileSync(resolve(process.cwd(), 'src/renderer/src/components/engineering/engineering-review.css'), 'utf8')
    expect(reviewStyles).toMatch(/\.engineering-review-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/)
    expect(reviewStyles).toContain('@container survey-data (min-width: 900px)')
    expect(reviewStyles).not.toContain('@media')
  })

  it('shows saved project datum without a network, but never promotes unsaved form edits', async () => {
    let savedProject = { ...project, taskContext: { coordinateSystem: '', verticalDatum: '' } }
    request.mockImplementation(async (path: string, method = 'GET', payload?: string) => {
      let body: unknown
      if (path === `/v1/engineering/projects/${project.id}` && method === 'PATCH') {
        savedProject = { ...savedProject, ...JSON.parse(payload!), revision: 3 }
        body = { project: savedProject }
      } else if (path === '/v1/engineering/projects') body = { projects: [savedProject] }
      else if (path.endsWith('/overview')) body = { project: savedProject, datasets: [], analyses: [], runs: [], manifests: [] }
      else if (path.includes('/survey/networks?')) body = { networks: [] }
      else if (path.includes('/adjustments?')) body = { adjustments: [] }
      else throw new Error(`Unexpected request: ${path}`)
      return { ok: true, status: 200, body: JSON.stringify(body) }
    })
    await act(async () => root.render(createElement(EngineeringWorkspaceView, { workspaceRoot: '/test', runtimeReady: true })))
    await settle()
    await act(async () => button('Project setup').click())
    const datumText = () => container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent!
    for (const [field, value] of [['coordinateSystem', 'LOCAL-TEST-CRS'], ['verticalDatum', 'NO-HEIGHT']] as const) {
      const input = [...container.querySelectorAll('label')].find(label => label.textContent === i18n.t(`engineeringTaskContext.${field}`))!.querySelector('input')!
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(datumText()).not.toContain(value)
    }
    await act(async () => button('Save configuration').click())
    expect(savedProject.taskContext).toEqual({ coordinateSystem: 'LOCAL-TEST-CRS', verticalDatum: 'NO-HEIGHT' })
    expect(datumText()).toContain('NO-HEIGHT · LOCAL-TEST-CRS')
    await act(async () => button('Refresh confirmed project').click())
    await settle()
    expect(datumText()).toContain('NO-HEIGHT · LOCAL-TEST-CRS')
  })

  it.each([
    { coordinateSystem: 'NETWORK-CRS', verticalDatum: 'NETWORK-HEIGHT', expected: 'NETWORK-HEIGHT · NETWORK-CRS' },
    { coordinateSystem: '待确认', verticalDatum: '', expected: undefined }
  ])('keeps active network datum authoritative over saved project context: $coordinateSystem', async datum => {
    const configured = { ...project, taskContext: { coordinateSystem: 'PROJECT-CRS', verticalDatum: 'PROJECT-HEIGHT' } }
    request.mockImplementation(async (path: string) => ({ ok: true, status: 200, body: JSON.stringify(
      path === '/v1/engineering/projects' ? { projects: [configured] }
        : path.endsWith('/overview') ? { project: configured, datasets: [], analyses: [], runs: [], manifests: [] }
          : path.includes('/survey/networks?') ? { networks: [{ ...network, coordinateSystem: datum.coordinateSystem, verticalDatum: datum.verticalDatum }] }
            : { adjustments: [] }
    ) }))
    await renderDelivery()
    const summary = container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent!
    expect(summary).toContain(datum.expected ?? `${i18n.t('surveyPendingConfirmation')} · ${i18n.t('surveyPendingConfirmation')}`)
    expect(summary).not.toContain('PROJECT-CRS')
    expect(summary).not.toContain('PROJECT-HEIGHT')
  })

  it('exposes named data selection buttons and switches the reviewed dataset without mutating it', async () => {
    datasets = ['first.csv', 'second.csv'].map((name, index) => ({
      id: `dataset-${index}`, sourceFileName: name, sourceFileHash: 'b'.repeat(64),
      fieldMapping: { point: `point-column-${index}` }, unknownColumns: [], rowCount: 1,
      columnCount: 1, observationCount: 1, timeRange: {}, status: 'imported',
      revision: 1, findings: [], updatedAt: project.updatedAt
    }))
    await renderDelivery()
    const select = container.querySelector<HTMLSelectElement>('#engineering-view-select')!
    await act(async () => { select.value = 'import'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => button('Data assets').click())
    const second = button('second.csv')
    expect(second.tabIndex).toBe(0)
    second.focus()
    expect(document.activeElement).toBe(second)
    request.mockClear()
    await act(async () => second.click())
    expect(second.getAttribute('aria-pressed')).toBe('true')
    expect(button('first.csv').getAttribute('aria-pressed')).toBe('false')
    expect(container.textContent).toContain('point-column-1')
    expect(request.mock.calls.filter(([, method]) => method && method !== 'GET')).toHaveLength(0)
  })

  it('consumes one sidebar create action once across selection, locale and reconnect changes', async () => {
    const projects = [project]
    let creates = 0
    request.mockImplementation(async (path: string, method = 'GET') => {
      let body: unknown
      if (path === '/v1/engineering/projects' && method === 'POST') {
        creates += 1
        // Bound the broken effect loop so the pre-fix regression terminates.
        if (creates > 2) throw new Error('unexpected repeated creation')
        const created = { ...project, id: `created-${creates}` }
        projects.push(created)
        body = { project: created }
      } else if (path === '/v1/engineering/projects') body = { projects }
      else if (path.endsWith('/overview')) body = { project: projects.find(p => path.includes(`/${p.id}/`)), datasets: [], analyses: [], runs: [], manifests: [] }
      else if (path.includes('/survey/networks?')) body = { networks: [] }
      else body = { adjustments: [] }
      return { ok: true, status: 200, body: JSON.stringify(body) }
    })
    await renderDelivery()
    await act(async () => dispatchEngineeringProjectCreate())
    await settle()
    expect(creates).toBe(1)
    await act(async () => dispatchEngineeringProjectOpen(project.id))
    await act(async () => i18n.changeLanguage('zh'))
    await act(async () => root.render(createElement(EngineeringWorkspaceView, { workspaceRoot: '/test', runtimeReady: false })))
    await act(async () => dispatchEngineeringProjectCreate())
    await act(async () => root.render(createElement(EngineeringWorkspaceView, { workspaceRoot: '/test', runtimeReady: true })))
    await settle()
    expect(creates).toBe(1)
    await act(async () => dispatchEngineeringProjectCreate())
    await settle()
    expect(creates).toBe(2)
  })

  it('coalesces duplicate create actions while the original request is in flight', async () => {
    await renderDelivery()
    const original = request.getMockImplementation()!
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    request.mockImplementation((path: string, method?: string, body?: string) =>
      path === '/v1/engineering/projects' && method === 'POST' ? pending : original(path, method, body))
    await act(async () => { dispatchEngineeringProjectCreate(); dispatchEngineeringProjectCreate() })
    await settle()
    await act(async () => dispatchEngineeringProjectCreate())
    expect(request.mock.calls.filter(([path, method]) => path === '/v1/engineering/projects' && method === 'POST')).toHaveLength(1)
    await act(async () => finish({ ok: true, status: 200, body: JSON.stringify({ project }) }))
  })

  it('releases a failed creation for explicit retry without retrying on its own', async () => {
    await renderDelivery()
    const original = request.getMockImplementation()!
    let creates = 0
    request.mockImplementation((path: string, method?: string, body?: string) => {
      if (path === '/v1/engineering/projects' && method === 'POST') {
        creates += 1
        return Promise.resolve(creates === 1
          ? { ok: false, status: 503, body: 'creation unavailable' }
          : { ok: true, status: 200, body: JSON.stringify({ project }) })
      }
      return original(path, method, body)
    })
    await act(async () => dispatchEngineeringProjectCreate())
    await settle()
    expect(creates).toBe(1)
    expect(container.textContent).toContain('This action could not be completed. Please try again.')
    await act(async () => dispatchEngineeringProjectCreate())
    await settle()
    expect(creates).toBe(2)
  })

  it('preserves the summary, selected result and preview when reopening the current project thread', async () => {
    await renderDelivery()
    await act(async () => button('Generate review draft').click())
    const summary = container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent
    expect(summary).toContain('survey.in2')
    await act(async () => dispatchEngineeringProjectOpen(project.id))
    await settle()
    expect(container.querySelector('[data-testid="engineering-summary-strip"]')!.textContent).toBe(summary)
    expect(container.textContent).toContain('report.pdf')
    expect(container.textContent).not.toContain(file.path)
    expect(button('Generate review draft').disabled).toBe(false)
  })

  it('uses language-independent calendar input and blocks invalid or reversed report dates before saving', async () => {
    await act(async () => root.render(createElement(EngineeringWorkspaceView, { workspaceRoot: '/test', runtimeReady: true })))
    await settle()
    await act(async () => button('Project setup').click())
    const start = [...container.querySelectorAll('label')].find(label => label.textContent === 'Report start date')!.querySelector('input')!
    const end = [...container.querySelectorAll('label')].find(label => label.textContent === 'Report end date')!.querySelector('input')!
    expect(start.type).toBe('text')
    expect(start.placeholder).toBe('YYYY-MM-DD')
    const set = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    await set(start, '2026-02-29')
    request.mockClear()
    const initialNoticeClose = container.querySelector<HTMLDivElement>('[role="alert"] button')
    if (initialNoticeClose) await act(async () => initialNoticeClose.click())
    await act(async () => button('Save configuration').click())
    expect(request).not.toHaveBeenCalled()
    await set(start, '2026-09-20'); await set(end, '2026-09-19')
    await act(async () => button('Save configuration').click())
    expect(request).not.toHaveBeenCalled()
    await i18n.changeLanguage('zh')
    await settle()
    expect(start.placeholder).toContain('年-月-日')
  })
  it('refreshes the selector and sidebar after a confirmed project change without changing the selected task', async () => {
    await renderDelivery()
    const renamed = { ...project, name: 'Confirmed name', revision: 3 }
    request.mockImplementation(async (path: string) => ({ ok: true, status: 200, body: JSON.stringify(
      path === '/v1/engineering/projects' ? { projects: [renamed] }
        : path.endsWith('/overview') ? { project: renamed, datasets: [], analyses: [], runs: [], manifests: [] }
          : path.includes('/survey/networks?') ? { networks: [network] } : { adjustments }
    ) }))
    const sidebarRefresh = vi.fn()
    window.addEventListener('workwise:engineering-projects-changed', sidebarRefresh)
    try {
      await act(async () => button('Refresh confirmed project').click())
      await settle()
      const selectors = [...container.querySelectorAll('select')]
      expect(selectors.some(select => select.value === 'job' && select.selectedOptions[0]?.textContent === 'Confirmed name')).toBe(true)
      expect(sidebarRefresh).toHaveBeenCalledOnce()
      expect(container.textContent).toContain('Confirmed name')
    } finally { window.removeEventListener('workwise:engineering-projects-changed', sidebarRefresh) }
  })
  it('restores an admitted result and displays generated preview files and truthful review checks', async () => {
    await renderDelivery()
    expect(button('Generate review draft').disabled).toBe(false)
    await act(async () => button('Generate review draft').click())
    expect(container.textContent).toContain('report.pdf')
    expect(container.textContent).not.toContain(file.path)
    expect(container.textContent).not.toContain('Select delivery inputs')
    const payload = request.mock.calls.find(([path]) => path.endsWith('/reports/preview'))![2]
    expect(JSON.parse(payload)).toMatchObject({ adjustmentIds: ['adjustment'] })
    await act(async () => button('Review and archive').click())
    expect(container.textContent).toContain('1 adjustments passed data and calculation checks')
    expect(container.textContent).toContain('Adjustment is complete; current data passed pre-calculation checks.')
    expect(button('Generate review list').disabled).toBe(false)
    expect(container.textContent).not.toContain('Run trend and threshold analysis first')
  })

  it.each(['en', 'zh'])('restores an AI export as recorded draft evidence without a new export (%s)', async language => {
    latestPreview = { run: { id: 'ai-export', status: 'completed' }, files: [file] }
    await renderDelivery()
    await act(async () => button('Deliverables').click())
    await act(async () => { await i18n.changeLanguage(language) })
    expect(container.textContent).toContain(i18n.t('engineeringDraftRestored'))
    expect(container.textContent).toContain('report.pdf')
    expect(container.textContent).not.toContain(file.path)
    expect(container.textContent).not.toContain('ai-export')
    expect(container.textContent).not.toContain(file.sha256)
    expect(request.mock.calls.some(([path]) => path.endsWith('/reports/preview'))).toBe(false)
    const ask = container.querySelector<HTMLButtonElement>(language === 'en' ? '[aria-label="Ask Survey AI about report.pdf"]' : '[aria-label="询问 report.pdf 的测量 AI"]')!
    await act(async () => ask.click())
    expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify(['/test', 'job'])]?.evidenceContext).toMatchObject({ runId: 'ai-export', outputPath: file.path, outputSha256: file.sha256 })
    await act(async () => { await i18n.changeLanguage('en') })
    await act(async () => button('Review and archive').click())
    expect(container.textContent).toContain(i18n.t('engineeringReviewableOutputs', { count: 1 }))
    expect(container.textContent).not.toContain('SHA-256')
  })

  it('distinguishes restored manifest outputs from a session preview in both languages', async () => {
    manifests = [{ id: 'historical-manifest', runId: 'historical-run', reviewStatus: 'draft', outputs: [file], citations: [], validation: { valid: true, errors: [], warnings: [] } }]
    await renderDelivery()
    await act(async () => button('Deliverables').click())
    expect(container.textContent).toContain('report.pdf')
    expect(container.textContent).toContain(i18n.t('engineeringStatusDraft'))
    expect(container.textContent).not.toContain(file.path)
    expect(container.textContent).not.toContain(file.sha256)
    expect(container.textContent).not.toContain('historical-manifest')
    expect(container.textContent).not.toContain('Preview not generated')
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(container.textContent).toContain(i18n.t('engineeringStatusDraft'))
    expect(container.textContent).not.toContain('尚未生成预览')
    const shown = visibleText(container)
    expect(shown).toContain('report.pdf')
    expect(shown).toContain(i18n.t('engineeringExportFile', { format: 'PDF' }))
    expect(shown).toContain('100 B')
    expect(shown).not.toContain('historical-manifest')
    expect(shown).not.toContain(file.path)
    expect(shown).not.toContain(file.sha256)
    await act(async () => { await i18n.changeLanguage('en') })
    await act(async () => button('Generate review draft').click())
    expect(container.textContent).toContain(i18n.t('engineeringDraftReady'))
    expect(container.textContent).not.toContain('historical-manifest')
  })

  it.each([
    { name: 'no manifest', saved: [] },
    { name: 'empty manifest', saved: [{ id: 'empty-manifest', runId: 'empty-run', reviewStatus: 'draft', outputs: [], citations: [], validation: { valid: true, errors: [], warnings: [] } }] }
  ])('keeps the ungenerated subtitle when there are no saved outputs: $name', async ({ saved }) => {
    manifests = saved
    await renderDelivery()
    await act(async () => button('Deliverables').click())
    expect(container.textContent).toContain('Preview not generated')
    expect(container.textContent).not.toContain('Latest review-pending review record outputs')
  })

  it('keeps draft evidence readable and prevents new outputs while offline', async () => {
    await renderDelivery()
    await act(async () => button('Generate review draft').click())
    await act(async () => root.render(createElement(EngineeringWorkspaceView, { workspaceRoot: '/test', runtimeReady: false })))
    request.mockClear()
    expect(container.textContent).toContain('report.pdf')
    expect(container.textContent).not.toContain(file.path)
    expect(button('Generate review draft').disabled).toBe(true)
    await act(async () => button('Generate review draft').click())
    await act(async () => button('Review and archive').click())
    expect(button('Generate review list').disabled).toBe(true)
    await act(async () => button('Generate review list').click())
    expect(request).not.toHaveBeenCalled()
  })

  it('asks about an exact output or historical manifest without assigning the active network to it', async () => {
    manifests = [{ id: 'historical-manifest', runId: 'historical-run', reviewStatus: 'draft', outputs: [file], citations: [], validation: { valid: true, errors: [], warnings: [] } }]
    await renderDelivery()
    await act(async () => button('Deliverables').click())
    await act(async () => button('Generate review draft').click())
    request.mockClear()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Ask Survey AI about report.pdf"]')!.click())
    const scope = JSON.stringify(['/test', 'job'])
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.evidenceContext).toMatchObject({ projectId: 'job', projectRevision: 2, runId: 'preview', outputSha256: file.sha256 })
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.evidenceContext?.manifestId).toBeUndefined()
    await act(async () => button('Review and archive').click())
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Ask Survey AI about Review draft"]')!.click())
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.evidenceContext).toMatchObject({ manifestId: 'historical-manifest', runId: 'historical-run', reviewStatus: 'draft' })
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.evidenceContext?.networkId).toBeUndefined()
    expect(request).not.toHaveBeenCalled()
    await act(async () => button('Delivery overview').click())
    expect(container.textContent).not.toMatch(/archived/i)
    expect(container.textContent).toContain('1 review list(s)')
    expect(container.textContent).toContain('Professional review, approval and signing remain pending')
    expect(container.textContent).not.toContain('All gates are satisfied')
    expect(container.textContent).toContain('survey.in2')
    expect(container.textContent).not.toContain('Time-series data')
    expect(container.textContent).not.toContain('Trend and threshold analysis')
    const adjustmentStage = button(i18n.t('engineeringTabSurvey'))
    expect(adjustmentStage).toBeDefined()
    await act(async () => adjustmentStage.click())
    expect(container.querySelector<HTMLSelectElement>('#engineering-view-select')!.value).toBe('adjustment')
  })

  it('restores the last stage after leaving and remounting the task', async () => {
    await renderDelivery()
    await act(async () => button('Review and archive').click())
    await act(async () => root.render(null))
    await act(async () => root.render(createElement(EngineeringWorkspaceView, { workspaceRoot: '/test', runtimeReady: true })))
    await settle()
    expect(button('Generate review list').disabled).toBe(false)
    expect(container.querySelector<HTMLSelectElement>('#engineering-view-select')!.value).toBe('delivery')
  })

  it.each([
    { ...adjustment, sourceEligibility: undefined },
    { ...adjustment, sourceEligibility: { eligible: false } },
    { ...adjustment, run: { ...adjustment.run, status: 'failed' } },
    { ...adjustment, result: { validation: 'invalid' } }
  ])('keeps a missing, revoked or invalid result out of new delivery', async value => {
    adjustments = [value]
    await renderDelivery()
    expect(button('Generate review draft').disabled).toBe(true)
    await act(async () => button('Review and archive').click())
    expect(button('Generate review list').disabled).toBe(true)
    await act(async () => button('Delivery overview').click())
    expect(container.textContent).not.toContain('Adjustment is complete; current data passed pre-calculation checks.')
    expect(container.textContent).not.toContain('Basic checks are complete.')
    if (value.sourceEligibility?.eligible === false || value.run.status === 'failed' || value.result.validation === 'invalid') {
      expect(container.querySelector('[data-testid="engineering-summary-strip"]')?.textContent).toContain('Blocked')
    }
  })

  it('still requires monitoring analysis when a dataset is included alongside Survey results', async () => {
    datasets = [{ id: 'dataset', sourceFileName: 'monitor.csv', observationCount: 1, findings: [], status: 'validated' }]
    await renderDelivery()
    await act(async () => button('Review and archive').click())
    expect(button('Generate review list').disabled).toBe(true)
    expect(container.textContent).toContain('Complete monitoring analysis or a survey adjustment that passes data and result checks first')
  })
})

describe('simplified continuous task flow', () => {
  it('automatically checks an imported CSV, acknowledges warnings once, and reaches results', async () => {
    adjustments = []
    let dataset = {
      id: 'imported-data', sourceFileName: 'observations.csv', sourceFileHash: 'c'.repeat(64), fieldMapping: {}, unknownColumns: [], rowCount: 2,
      columnCount: 3, observationCount: 2, timeRange: {}, status: 'imported', revision: 1,
      findings: ['warning-one', 'warning-two'].map(id => ({ id, code: 'review', severity: 'warning', status: 'open', message: id, suggestion: 'Review source' })), updatedAt: project.updatedAt
    }
    const original = request.getMockImplementation()!
    request.mockImplementation(async (path: string, method?: string, payload?: string) => {
      if (method !== 'POST') return original(path, method, payload)
      const input = JSON.parse(payload ?? '{}')
      if (path === '/v1/engineering/datasets/import') { datasets = [dataset]; return { ok: true, status: 200, body: JSON.stringify({ dataset }) } }
      if (path.endsWith('/validate')) {
        expect(input.expectedRevision).toBe(1)
        dataset = { ...dataset, status: 'validated', revision: 2 }; datasets = [dataset]
        return { ok: true, status: 200, body: JSON.stringify({ dataset }) }
      }
      if (path.endsWith('/accept')) {
        expect(input.expectedRevision).toBe(dataset.revision)
        dataset = { ...dataset, revision: dataset.revision + 1, findings: dataset.findings.map(f => path.includes(f.id) ? { ...f, status: 'accepted' } : f) }; datasets = [dataset]
        return { ok: true, status: 200, body: JSON.stringify({ dataset }) }
      }
      if (path === '/v1/engineering/analyses') {
        expect(input.expectedRevision).toBe(4)
        const analysis = { id: 'analysis-new', datasetId: dataset.id, datasetRevision: dataset.revision, inputHash: 'd'.repeat(64), algorithmVersion: 'test', results: [] }
        analyses = [analysis]
        return { ok: true, status: 200, body: JSON.stringify({ analysis }) }
      }
      throw new Error(`Unexpected mutation: ${path}`)
    })
    await renderDelivery()
    await act(async () => button(i18n.t('engineeringPrimaryProcess')).click())
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${i18n.t('engineeringUnifiedImport')}"]`)!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['point,timestamp,value\nP1,2026-01-01,1'], 'observations.csv', { type: 'text/csv' })] })
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 30)) })
    await vi.waitFor(() => expect(request.mock.calls.some(([path]) => path.endsWith('/validate'))).toBe(true))
    expect(request.mock.calls.some(([path]) => path === '/v1/engineering/analyses')).toBe(false)
    const confirmation = button(i18n.t('engineeringConfirmContinue', { count: 2 }))
    await act(async () => confirmation.click())
    expect(request.mock.calls.filter(([path]) => path.endsWith('/accept'))).toHaveLength(2)
    await act(async () => button(i18n.t('surveyStartCalculation')).click())
    await settle()
    expect(container.querySelector('[aria-current="step"]')?.textContent).toBe(i18n.t('engineeringPrimaryResults'))
    expect(container.textContent).toContain(i18n.t('engineeringExportDraft'))
  })

  it('keeps calculation blocked and offers an actionable replacement when preflight finds a blocker', async () => {
    datasets = [{ id: 'blocked-data', sourceFileName: 'bad.csv', sourceFileHash: 'e'.repeat(64), fieldMapping: {}, unknownColumns: [], rowCount: 1, columnCount: 3, observationCount: 0, timeRange: {}, status: 'validated', revision: 2, findings: [{ id: 'blocking', code: 'missing_identifier', severity: 'blocking', status: 'open', message: 'Missing point', suggestion: 'Fix point' }], updatedAt: project.updatedAt }]
    await renderDelivery()
    await act(async () => button(i18n.t('engineeringPrimaryProcess')).click())
    expect(button(i18n.t('surveyStartCalculation')).disabled).toBe(true)
    expect(button(i18n.t('engineeringReplaceSource')).disabled).toBe(false)
    expect(request.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true)
  })

  it('keeps the two legacy delivery routes on the same export and review page', async () => {
    await renderDelivery()
    for (const route of ['engineeringTabDeliverables', 'engineeringTabReview']) {
      await act(async () => button(i18n.t(route)).click())
      expect(button(i18n.t('engineeringGeneratePreview'))).toBeDefined()
      expect(button(i18n.t('engineeringGenerateReviewManifest'))).toBeDefined()
      expect(container.querySelector('[aria-current="step"]')?.textContent).toBe(i18n.t('engineeringPrimaryDelivery'))
    }
  })
})
