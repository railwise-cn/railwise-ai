// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurveyStatisticalDiagnostics } from './SurveyStatisticalDiagnostics'
import { readSurveyStatisticalDiagnostics, type SurveyStatisticalBinding } from '../../agent/survey-statistics-client'
import i18n from '../../i18n'
import { EngineeringEvidenceQuestions } from './EngineeringEvidenceQuestion'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'

const binding: SurveyStatisticalBinding = { projectId: 'project-stats', networkId: 'network-stats', runId: 'run-stats',
  resultId: 'result-stats', inputHash: 'a'.repeat(64), algorithmVersion: 'workwise-survey-adjustment-7', sourceSha256: 'b'.repeat(64) }
const fixture = {
  ...binding, schemaVersion: 1, diagnosticsVersion: 'leveling-deleted-t-1', calculationHash: 'c'.repeat(64),
  status: 'available', statistic: 'externally-studentized-residual-t', model: 'linear-independent-observations',
  varianceBasis: 'deleted-observation-posterior', weightBasis: 'inverse-declared-sigma-squared',
  assumptions: ['fixed-linear-model', 'independent-gaussian-errors', 'weights-proportional-to-inverse-variance', 'fixed-known-datum'],
  assumptionsVerified: false, decision: 'not-evaluated', residualUnit: 'm', statisticUnit: 'dimensionless',
  fullModelDegreesOfFreedom: 2, degreesOfFreedom: 1,
  observations: [1, 2, 3].map(i => ({ observationId: `obs-${i}`, sourceRecordId: `raw-${i}`, sourceRow: i,
    residual: 0.00012 * i, observationWeight: 1e6, residualCofactor: 2 / 3e6,
    redundancy: 2 / 3, leverage: 1 / 3, deletedWeightedResidualSum: 0.04,
    deletedVarianceFactor: 0.04, externallyStudentizedResidual: -1.2345 * i }))
}
const response = (body: unknown) => ({ ok: true, status: 200, body: JSON.stringify(body) })
let host: HTMLDivElement
let root: Root
const runtimeRequest = vi.fn()
const save = vi.fn()
const sourceRenderer = vi.fn((id: string) => createElement('p', null, `source-anchor:${id}`))
const defaults = { binding, contextRevision: '1:2:1', runtimeReady: true, eligible: true,
  workspace: '/survey', renderSourceRecord: sourceRenderer }
async function render(overrides: Partial<Parameters<typeof SurveyStatisticalDiagnostics>[0]> = {}): Promise<void> {
  await act(async () => root.render(createElement(SurveyStatisticalDiagnostics, { ...defaults, ...overrides })))
}
function readButton(): HTMLButtonElement { return host.querySelector('button')! }
function downloadButton(): HTMLButtonElement { return host.querySelectorAll('button')[1]! }
async function click(button = readButton()): Promise<void> { await act(async () => button.click()) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  runtimeRequest.mockReset().mockResolvedValue(response(fixture))
  save.mockReset().mockResolvedValue({ ok: true, path: '/saved/stats.json' })
  sourceRenderer.mockClear()
  Object.assign(window, { workwise: { runtimeRequest, saveWorkspaceFileAs: save } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('desktop leveling statistical diagnostics', () => {
  it('pins the chosen diagnostic observation with its actual network revision and calculation hash', async () => {
    const focus = vi.fn()
    useEngineeringConversationDrafts.setState({ drafts: {} })
    await act(async () => root.render(createElement(EngineeringEvidenceQuestions, { scope: { workspace: '/survey', projectId: binding.projectId, projectRevision: 1, ready: true, focus }, children: createElement(SurveyStatisticalDiagnostics, { ...defaults, networkRevision: 7 }) })))
    await click(); runtimeRequest.mockClear()
    await click(host.querySelector<HTMLButtonElement>('tbody tr:nth-child(2) button[title]')!)
    expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify(['/survey', binding.projectId])]!.evidenceContext!.typedEvidence).toEqual({ schemaVersion: 1, projectId: binding.projectId, projectRevision: 1, kind: 'statistics', networkId: binding.networkId, networkRevision: 7, sourceSha256: binding.sourceSha256, adjustmentId: binding.runId, inputHash: binding.inputHash, calculationHash: fixture.calculationHash, diagnosticsVersion: fixture.diagnosticsVersion, selector: { path: ['observations', 1], identity: { observationId: 'obs-2' } } })
    expect(runtimeRequest).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledOnce()
  })

  it('uses the exact project-scoped Runtime payload, shows assumptions in both locales and locates original records', async () => {
    await render()
    expect(runtimeRequest).not.toHaveBeenCalled()
    expect(downloadButton().disabled).toBe(true)
    await click()
    expect(runtimeRequest).toHaveBeenCalledExactlyOnceWith('/v1/engineering/projects/project-stats/adjustments/run-stats/statistical-diagnostics', 'GET')
    expect(host.textContent).toContain('Statistical assumptions: not verified.')
    expect(host.textContent).toContain('No statistical decision has been made.')
    expect(host.textContent).toContain('-1.2345')
    expect(host.querySelector('[role="region"]')?.getAttribute('tabindex')).toBe('0')
    const locator = host.querySelector('tbody button') as HTMLButtonElement
    await click(locator)
    expect(sourceRenderer).toHaveBeenCalledWith('raw-1', expect.any(Function))
    expect(host.textContent).toContain('source-anchor:raw-1')
    expect(document.activeElement?.textContent).toContain('source-anchor:raw-1')
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain('统计假设：尚未验证。')
    expect(host.textContent).toContain('未作统计判定')
    expect(host.textContent).toContain('全模型自由度')
  })

  it('revalidates before native JSON save and preserves the source binding and undecided status', async () => {
    await render(); await click()
    const fresh = { ...fixture, observations: fixture.observations.map(row => ({ ...row, externallyStudentizedResidual: 2.5 })) }
    runtimeRequest.mockResolvedValueOnce(response(fresh))
    await click(downloadButton())
    expect(runtimeRequest).toHaveBeenLastCalledWith('/v1/engineering/projects/project-stats/adjustments/run-stats/statistical-diagnostics?download=1', 'GET')
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ suggestedName: 'survey-statistical-diagnostics.json', workspaceRoot: '/survey', mimeType: 'application/json' }))
    const payload = save.mock.calls[0]![0] as { dataBase64: string }
    expect(JSON.parse(Buffer.from(payload.dataBase64, 'base64').toString('utf8'))).toEqual(fresh)
    expect(host.textContent).toContain('Diagnostics JSON saved.')
  })

  it('clears older diagnostics when a revalidation fails and never saves unverified output', async () => {
    await render(); await click()
    runtimeRequest.mockResolvedValueOnce({ ok: false, status: 409, body: 'PRIVATE raw-source values' })
    await click(downloadButton())
    expect(save).not.toHaveBeenCalled()
    expect(host.querySelector('table')).toBeNull()
    expect(host.textContent).toContain('evidence is missing, changed, or inconsistent')
    expect(host.textContent).not.toContain('PRIVATE')
    expect(downloadButton().disabled).toBe(true)
  })

  it('shows a localized unavailable reason without inventing t values', async () => {
    runtimeRequest.mockResolvedValueOnce(response({ ...binding, schemaVersion: 1, diagnosticsVersion: 'leveling-deleted-t-1',
      calculationHash: 'c'.repeat(64), status: 'unavailable', decision: 'not-evaluated', reason: 'insufficient-redundancy' }))
    await render(); await click()
    expect(host.textContent).toContain('too few degrees of freedom')
    expect(host.querySelector('table')).toBeNull()
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain('自由度不足')
  })

  it('coalesces duplicate clicks and ignores a pending response after project, revision or connection changes', async () => {
    for (const overrides of [{ runtimeReady: false }, { contextRevision: '1:3:1' }, { binding: { ...binding, projectId: 'other' } }]) {
      let complete!: (value: unknown) => void
      runtimeRequest.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
      await render()
      const count = runtimeRequest.mock.calls.length
      await act(async () => { readButton().click(); readButton().click() })
      expect(runtimeRequest.mock.calls.length).toBe(count + 1)
      await render(overrides)
      await act(async () => complete(response(fixture)))
      expect(host.querySelector('table')).toBeNull()
      expect(downloadButton().disabled).toBe(true)
    }
  })

  it('disables missing provenance and revoked admission, and clears results on an offline transition', async () => {
    await render({ binding: null }); expect(readButton().disabled).toBe(true)
    expect(host.textContent).toContain('missing the input or source binding')
    await render({ eligible: false }); expect(readButton().disabled).toBe(true)
    await render(); await click(); expect(host.querySelector('table')).not.toBeNull()
    await render({ runtimeReady: false }); expect(readButton().disabled).toBe(true)
    expect(host.querySelector('table')).toBeNull()
    await render(); expect(host.querySelector('table')).toBeNull()
  })

  it('does not announce success after a canceled or failed native save', async () => {
    await render(); await click()
    save.mockResolvedValueOnce({ ok: false, canceled: true, message: 'Save cancelled.' })
    await click(downloadButton())
    expect(host.textContent).not.toContain('Diagnostics JSON saved.')
    save.mockResolvedValueOnce({ ok: false, message: 'PRIVATE path' })
    await click(downloadButton())
    expect(host.textContent).toContain('could not be saved')
    expect(host.textContent).not.toContain('PRIVATE')
  })
})

describe('statistical diagnostic client contract', () => {
  it.each(Object.keys(binding) as Array<keyof SurveyStatisticalBinding>)('rejects a mismatched %s binding', async key => {
    runtimeRequest.mockResolvedValueOnce(response({ ...fixture, [key]: key.endsWith('Hash') || key === 'sourceSha256' ? 'd'.repeat(64) : 'wrong' }))
    await expect(readSurveyStatisticalDiagnostics(binding)).rejects.toMatchObject({ reason: 'invalid-response' })
  })
  it('rejects a contract that claims acceptance or verified statistical assumptions', async () => {
    for (const mutation of [{ decision: 'passed' }, { assumptionsVerified: true }, { degreesOfFreedom: 2 }]) {
      runtimeRequest.mockResolvedValueOnce(response({ ...fixture, ...mutation }))
      await expect(readSurveyStatisticalDiagnostics(binding)).rejects.toMatchObject({ reason: 'invalid-response' })
    }
  })
  it('encodes project and run identifiers as individual path components', async () => {
    const escaped = { ...binding, projectId: 'project / #?', runId: 'run / #?' }
    runtimeRequest.mockResolvedValueOnce(response({ ...fixture, ...escaped }))
    await readSurveyStatisticalDiagnostics(escaped)
    expect(runtimeRequest).toHaveBeenCalledExactlyOnceWith('/v1/engineering/projects/project%20%2F%20%23%3F/adjustments/run%20%2F%20%23%3F/statistical-diagnostics', 'GET')
  })
  it('accepts at most 256 numeric rows and rejects oversized responses before JSON parsing', async () => {
    const maximum = { ...fixture, observations: Array.from({ length: 256 }, (_, i) => ({ ...fixture.observations[0], observationId: `obs-${i}` })) }
    runtimeRequest.mockResolvedValueOnce(response(maximum))
    expect((await readSurveyStatisticalDiagnostics(binding)).status).toBe('available')
    runtimeRequest.mockResolvedValueOnce(response({ ...maximum, observations: [...maximum.observations, { ...fixture.observations[0], observationId: 'obs-256' }] }))
    await expect(readSurveyStatisticalDiagnostics(binding)).rejects.toMatchObject({ reason: 'invalid-response' })
    runtimeRequest.mockResolvedValueOnce({ ok: true, status: 200, body: ' '.repeat(1024 * 1024 + 1) })
    await expect(readSurveyStatisticalDiagnostics(binding)).rejects.toMatchObject({ reason: 'invalid-response' })
  })
})
