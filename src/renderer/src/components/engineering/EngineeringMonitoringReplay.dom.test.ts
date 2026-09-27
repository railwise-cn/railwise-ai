// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { EngineeringMonitoringReplay } from './EngineeringMonitoringReplay'
import { parseMonitoringReplay } from './engineering-monitoring-replay'
import { EngineeringEvidenceQuestions } from './EngineeringEvidenceQuestion'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'

const hash = 'a'.repeat(64)
const analysis = { analysisId: 'analysis_1', datasetId: 'dataset_1', algorithmVersion: 'workwise-engineering-2', inputHash: hash,
  storedResultsHash: hash, recomputedResultsHash: hash, sourceFileHash: hash, sourceContextHash: hash, status: 'passed', reasonCode: 'matched' }
const result = { schemaVersion: 1, attemptId: 'attempt_1', projectId: 'project', manifestId: 'manifest', checkedAt: '2026-09-21T00:00:00.000Z',
  status: 'passed', reasonCode: 'matched', comparisonVersion: 'monitoring-results-exact-1',
  execution: { runtimeVersion: 'test', node: '24', v8: 'test', icu: 'test', platform: 'darwin', arch: 'arm64', timezone: 'Asia/Shanghai', locale: 'zh-CN', timeBasis: 'ISO-unzoned-UTC' },
  analyses: [analysis] }
const request = vi.fn()
let host: HTMLDivElement
let root: Root
async function render(overrides: Record<string, unknown> = {}): Promise<void> {
  await act(async () => root.render(createElement(EngineeringMonitoringReplay, { projectId: 'project', manifestId: 'manifest', reviewStatus: 'draft', contextRevision: 1, runtimeReady: true, request, ...overrides })))
}
async function click(): Promise<void> { await act(async () => host.querySelector('button')!.click()) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  request.mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

it('requests only the bound manifest and shows exact replay evidence in both languages', async () => {
  request.mockResolvedValue({ replay: result })
  await render(); await click()
  expect(request).toHaveBeenCalledExactlyOnceWith('/v1/engineering/projects/project/manifests/manifest/monitoring-replay', 'POST')
  expect(host.textContent).toContain('Monitoring results match')
  expect(host.textContent).toContain('Recorded results exactly match recomputation')
  expect(host.textContent).toContain(hash)
  expect(host.textContent).toContain('does not establish source authenticity')
  expect(host.querySelector('details')!.open).toBe(false)
  expect(host.querySelector('time')!.dateTime).toBe(result.checkedAt)
  await act(async () => { await i18n.changeLanguage('zh') })
  expect(host.textContent).toContain('监测数值一致')
  expect(host.textContent).toContain('原分析和成果保持不变')
})

it('prepares the persisted replay attempt without running another replay', async () => {
  const focus = vi.fn()
  useEngineeringConversationDrafts.setState({ drafts: {} })
  request.mockResolvedValue({ replay: result })
  await act(async () => root.render(createElement(EngineeringEvidenceQuestions, { scope: { workspace: '/survey', projectId: 'project', projectRevision: 1, ready: true, focus }, children: createElement(EngineeringMonitoringReplay, { projectId: 'project', manifestId: 'manifest', reviewStatus: 'draft', contextRevision: 1, runtimeReady: true, request }) })))
  await click(); request.mockClear()
  await act(async () => host.querySelector<HTMLButtonElement>('button[title]')!.click())
  expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify(['/survey', 'project'])]!.evidenceContext!.typedEvidence).toEqual({ schemaVersion: 1, projectId: 'project', projectRevision: 1, kind: 'monitoring-replay', manifestId: result.manifestId, attemptId: result.attemptId, checkedAt: result.checkedAt })
  expect(request).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledOnce()
})

it('keeps missing historical sources and unsupported algorithms unassessed, never passed', async () => {
  for (const reasonCode of ['source-unavailable', 'unsupported-algorithm', 'ambiguous-tie-order']) {
    const legacy = { ...analysis, algorithmVersion: 'workwise-engineering-1', status: 'not-evaluated', reasonCode, recomputedResultsHash: undefined }
    request.mockResolvedValueOnce({ replay: { ...result, status: 'not-evaluated', reasonCode, analyses: [legacy] } })
    await render(); await click()
    expect(host.textContent).toContain('Monitoring results not evaluated')
    expect(host.textContent).not.toContain('Monitoring results match')
  }
  request.mockResolvedValueOnce({ replay: { ...result, status: 'not-applicable', reasonCode: 'no-monitoring-analysis', analyses: [] } })
  await click()
  expect(host.textContent).toContain('This deliverable contains no monitoring analysis')
  expect(host.textContent).not.toContain('Monitoring results match')
})

it('removes prior success before a failed retry and rejects malformed envelopes', async () => {
  request.mockResolvedValueOnce({ replay: result }).mockRejectedValueOnce(new Error('private raw path must not leak')).mockResolvedValueOnce({ verification: result })
  await render(); await click()
  expect(host.textContent).toContain('Monitoring results match')
  await click()
  expect(host.textContent).not.toContain('Monitoring results match')
  expect(host.textContent).toContain('could not be completed or its audit could not be saved')
  expect(host.textContent).not.toContain('private raw path')
  await click()
  expect(host.textContent).toContain('The verification version, identity, time or checks are inconsistent')
})

it('invalidates pending successes and failures on every binding or connectivity change', async () => {
  for (const override of [{ projectId: 'other' }, { manifestId: 'other' }, { contextRevision: 2 }, { reviewStatus: 'archived' }, { runtimeReady: false }]) {
    for (const reject of [false, true]) {
      await render()
      let finish!: (value: unknown) => void
      let fail!: (error: Error) => void
      request.mockImplementationOnce(() => new Promise((resolve, rejectPromise) => { finish = resolve; fail = rejectPromise }))
      await click()
      await render(override)
      await act(async () => { if (reject) fail(new Error('late failure')); else finish({ replay: result }) })
      expect(host.textContent).not.toContain('Monitoring results match')
      expect(host.textContent).not.toContain('could not be completed')
      if (override.runtimeReady === false) expect(host.querySelector('button')!.disabled).toBe(true)
    }
  }
})

it('coalesces duplicate actions and discards earlier requests when returning to a project', async () => {
  let finish!: (value: unknown) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await render()
  await act(async () => { host.querySelector('button')!.click(); host.querySelector('button')!.click() })
  expect(request).toHaveBeenCalledTimes(1)
  await render({ projectId: 'other' }); await render()
  await act(async () => finish({ replay: result }))
  expect(host.textContent).not.toContain('Monitoring results match')
})

it('rejects incorrect identities, status/hash contradictions and unsupported response versions', () => {
  for (const change of [
    { schemaVersion: 2 }, { comparisonVersion: 'latest' }, { projectId: 'other' }, { manifestId: 'other' },
    { checkedAt: '2026-02-31T00:00:00Z' }, { checkedAt: 'yesterday' }, { checkedAt: '2026-09-21T00:00:00+08:00' },
    { status: 'not-evaluated' }, { reasonCode: 'source-unavailable' }, { analyses: [] },
    { analyses: [analysis, analysis] }, { analyses: [{ ...analysis, recomputedResultsHash: undefined }] },
    { analyses: [{ ...analysis, recomputedResultsHash: 'b'.repeat(64) }] },
    { analyses: [{ ...analysis, algorithmVersion: 'workwise-engineering-1' }] },
    { analyses: [{ ...analysis, status: 'not-evaluated', reasonCode: 'unsupported-algorithm' }] }
  ]) expect(() => parseMonitoringReplay({ ...result, ...change }, result)).toThrow('invalid verification response')
  expect(parseMonitoringReplay(result, result).status).toBe('passed')
})

it('shows a numerical mismatch as failure with its recorded and recomputed hashes', async () => {
  request.mockResolvedValue({ replay: { ...result, status: 'failed', reasonCode: 'result-mismatch',
    analyses: [{ ...analysis, status: 'failed', reasonCode: 'result-mismatch', recomputedResultsHash: 'b'.repeat(64) }] } })
  await render(); await click()
  expect(host.textContent).toContain('Monitoring recomputation failed')
  expect(host.textContent).toContain('Recorded monitoring results differ')
  expect(host.textContent).toContain('b'.repeat(64))
  expect(host.textContent).not.toContain('Monitoring results match')
})
