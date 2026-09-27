// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { EngineeringManifestVerification } from './EngineeringManifestVerification'
import { parseEngineeringVerification } from './engineering-verification'
import { EngineeringEvidenceQuestions } from './EngineeringEvidenceQuestion'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'

let host: HTMLDivElement
let root: Root
const request = vi.fn()
const result = { schemaVersion: 1, projectId: 'project', manifestId: 'manifest', reviewStatus: 'draft', checkedAt: new Date().toISOString(), valid: true,
  checks: ['manifest', 'outputs', 'inputs', 'surveyReplay', 'sources'].map(id => ({ id, status: 'passed' })) }
async function render(runtimeReady = true, manifestId = 'manifest', contextRevision = 1, reviewStatus = 'draft'): Promise<void> {
  await act(async () => root.render(createElement(EngineeringManifestVerification, { projectId: 'project', manifestId, reviewStatus, contextRevision, runtimeReady, request })))
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  request.mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

it('checks only the selected manifest and explains the review boundary in both languages', async () => {
  request.mockResolvedValue({ verification: result })
  await render()
  await act(async () => host.querySelector('button')!.click())
  expect(request).toHaveBeenCalledExactlyOnceWith('/v1/engineering/projects/project/manifests/manifest/verify', 'POST')
  expect(host.textContent).toContain('Exact Survey recomputation: Passed')
  expect(host.textContent).toContain('not professional review')
  expect(host.querySelector('[role="status"]')).not.toBeNull()
  await act(async () => { await i18n.changeLanguage('zh') })
  expect(host.textContent).toContain('测量结果严格重算: 通过')
  expect(host.textContent).toContain('不是专业复核')
})

it('selects a stored check without starting another verification and clears it after revision changes', async () => {
  const focus = vi.fn()
  useEngineeringConversationDrafts.setState({ drafts: {} })
  const draw = async (revision: number) => { await act(async () => root.render(createElement(EngineeringEvidenceQuestions, { scope: { workspace: '/survey', projectId: 'project', projectRevision: revision, ready: true, focus }, children: createElement(EngineeringManifestVerification, { projectId: 'project', manifestId: 'manifest', reviewStatus: 'draft', contextRevision: revision, runtimeReady: true, request }) }))) }
  request.mockResolvedValue({ verification: result })
  await draw(1); await act(async () => host.querySelector('button')!.click())
  request.mockClear()
  await act(async () => host.querySelector<HTMLButtonElement>('li button')!.click())
  expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify(['/survey', 'project'])]!.evidenceContext!.typedEvidence).toEqual({ schemaVersion: 1, projectId: 'project', projectRevision: 1, kind: 'deliverable-verification', manifestId: 'manifest', checkedAt: result.checkedAt, selector: { path: ['checks', 0], identity: { id: 'manifest' } } })
  expect(request).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledOnce()
  await draw(2); expect(host.querySelector('li button')).toBeNull()
})

it('rejects mismatched results and clears an older success before retry failure', async () => {
  request.mockResolvedValueOnce({ verification: result }).mockRejectedValueOnce(new Error('output unavailable')).mockResolvedValueOnce({ verification: { ...result, manifestId: 'other' } })
  await render()
  await act(async () => host.querySelector('button')!.click())
  expect(host.textContent).toContain('Evidence checks passed')
  await act(async () => host.querySelector('button')!.click())
  expect(host.textContent).not.toContain('Evidence checks passed')
  expect(host.textContent).toContain('output unavailable')
  await act(async () => host.querySelector('button')!.click())
  expect(host.textContent).toContain('The verification version, identity, time or checks are inconsistent')
})

it('announces localized failures while keeping original diagnostics in collapsed technical details', async () => {
  await i18n.changeLanguage('zh')
  request.mockResolvedValueOnce({ verification: { ...result, valid: false, checks: result.checks.map(check => check.id === 'outputs' ? { ...check, status: 'failed', detail: 'delivery output no longer matches its recorded hash: /project/report.pdf' } : check) } })
  await render(); await act(async () => host.querySelector('button')!.click())
  expect(host.textContent).toContain('成果文件缺失、不可读取，或大小与哈希已变化')
  const details = host.querySelector('details')!
  expect(details.open).toBe(false)
  expect(details.textContent).toContain('/project/report.pdf')
  expect(host.querySelector('ul li:nth-child(2)')!.textContent).toContain('失败')
  request.mockRejectedValueOnce(new Error('deliverable verification audit could not be saved; no persisted verification evidence is available for this attempt'))
  await act(async () => host.querySelector('button')!.click())
  expect(host.textContent).toContain('本次复验审计记录未能保存')
  expect(host.textContent).not.toContain('/project/report.pdf')
  await act(async () => { await i18n.changeLanguage('en') })
  expect(host.textContent).toContain('The verification audit could not be saved')
})

it('coalesces duplicate clicks and invalidates completed and pending results on revision or review status changes', async () => {
  request.mockResolvedValueOnce({ verification: result })
  await render(); await act(async () => { host.querySelector('button')!.click(); host.querySelector('button')!.click() })
  expect(request).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain('Evidence checks passed')
  await render(true, 'manifest', 2)
  expect(host.textContent).not.toContain('Evidence checks passed')
  let finish!: (value: unknown) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await act(async () => host.querySelector('button')!.click())
  await render(true, 'manifest', 2, 'archived')
  await act(async () => finish({ verification: result }))
  expect(host.textContent).not.toContain('Evidence checks passed')
})

it('rejects missing, duplicate, contradictory and malformed verification evidence', () => {
  for (const change of [
    { schemaVersion: 2 }, { projectId: 'other' }, { manifestId: 'other' }, { reviewStatus: 'approved' },
    { checkedAt: 'not-a-date' }, { checkedAt: '2026-02-31T00:00:00Z' },
    { checks: [] }, { checks: result.checks.slice(1) }, { checks: [...result.checks.slice(1), result.checks[1]] },
    { valid: false }, { checks: result.checks.map(check => ({ ...check, status: 'failed' })) },
    { checks: result.checks.map(check => check.id === 'manifest' ? { ...check, status: 'not-applicable' } : check) },
    { checks: result.checks.map(check => check.id === 'sources' ? { ...check, status: 'not-applicable' } : check) },
    { checks: result.checks.map(check => ({ ...check, detail: 'x'.repeat(16_385) })) }
  ]) expect(() => parseEngineeringVerification({ ...result, ...change }, result), JSON.stringify(change).slice(0, 300)).toThrow('invalid verification response')
  expect(parseEngineeringVerification(result, result).valid).toBe(true)
  const monitoring = { ...result, checks: result.checks.map(check => ['surveyReplay', 'sources'].includes(check.id) ? { ...check, status: 'not-applicable' } : check) }
  expect(parseEngineeringVerification(monitoring, result).valid).toBe(true)
})

it('accepts a well-formed response across a wall-clock correction without inferring freshness from timestamps', async () => {
  const beforeCorrection = Date.parse(result.checkedAt)
  vi.spyOn(Date, 'now').mockReturnValue(beforeCorrection)
  let finish!: (value: unknown) => void
  request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await render(); await act(async () => host.querySelector('button')!.click())
  vi.mocked(Date.now).mockReturnValue(beforeCorrection - 120_000)
  await act(async () => finish({ verification: { ...result, checkedAt: new Date(beforeCorrection - 120_000).toISOString() } }))
  expect(host.textContent).toContain('Evidence checks passed')
  vi.restoreAllMocks()
})

it('disables offline verification and ignores a response after connectivity changes', async () => {
  let complete!: (value: unknown) => void
  request.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  await render()
  await act(async () => host.querySelector('button')!.click())
  await render(false)
  await act(async () => complete({ verification: result }))
  expect(host.querySelector('button')!.disabled).toBe(true)
  expect(host.textContent).not.toContain('Evidence checks passed')
})
