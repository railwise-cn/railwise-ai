// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurveyQualityWorkflowWorkspace } from './SurveyQualityWorkflowWorkspace'
import { appendFixture, emptyWorkflow, workflowFixture } from '../../agent/survey-quality-workflow-test-fixtures'
import type { QualityWorkflow, WorkflowEvent } from '../../agent/survey-quality-workflow-client'
import i18n from '../../i18n'

const context = workflowFixture(), corrected = workflowFixture('2')
const runtimeRequest = vi.fn()
let stored: QualityWorkflow
let host: HTMLDivElement, root: Root
const response = (value: unknown) => ({ ok: true, status: 200, body: JSON.stringify(value) })
async function render(overrides: Partial<Parameters<typeof SurveyQualityWorkflowWorkspace>[0]> = {}): Promise<void> {
  await act(async () => root.render(createElement(SurveyQualityWorkflowWorkspace, { ...context, runtimeReady: true, ...overrides })))
}
const button = (label: string): HTMLButtonElement => Array.from(host.querySelectorAll('button')).find(item => item.textContent === label)!
const label = (text: string): HTMLLabelElement => Array.from(host.querySelectorAll('label')).find(item => item.firstChild?.textContent === text)!
async function click(element: HTMLElement, settle = true): Promise<void> {
  await act(async () => element.click())
  if (settle) await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(host.textContent).not.toContain(i18n.t('qualityWorkspaceLoading'))
  })
}
async function input(text: string, value: string): Promise<void> {
  const element = label(text).querySelector('input,select') as HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  })
}
async function open(): Promise<void> { await act(async () => { const details = host.querySelector('details')!; details.open = true; details.dispatchEvent(new Event('toggle')) }) }
async function begin(): Promise<void> { await render(); await open(); await click(button('Create declared workflow')) }
async function saveCheck(): Promise<void> { await input('Check ID', 'closure'); await input('Retained evidence material', 'output-1'); await click(host.querySelector('input[type=checkbox]')!); await click(button('Save declaration')) }

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en'); stored = emptyWorkflow(context)
  runtimeRequest.mockReset().mockImplementation(async (path: string, method = 'GET', body?: string) => {
    if (path.endsWith('/quality-workflows') && method === 'POST') { stored = emptyWorkflow(context, JSON.parse(body!).idempotencyKey); return response(stored) }
    if (path.includes('/quality-workflows?')) return response({ workflows: [stored], unavailable: [], nextOffset: null })
    if (path.endsWith('/quality-workflows/workflow-1')) return response(stored)
    if (path.endsWith('/events')) {
      const request = JSON.parse(body!) as { event: WorkflowEvent; idempotencyKey: string }
      const evidenceContext = request.event.evidence.planId === corrected.plan.plan.id ? corrected : context
      stored = appendFixture(stored, request.event, request.idempotencyKey, evidenceContext, request.event.kind === 'correction-recorded' || request.event.kind === 'issue-rechecked' ? evidenceContext : undefined)
      return response(stored)
    }
    if (path.includes('/quality-plans?')) return response({ plans: [context.plan, corrected.plan], unavailable: [], nextOffset: null })
    if (path.includes('/quality-records?')) return response({ records: [{ record: corrected.record.record, verification: corrected.record.verification }], unavailable: [], nextOffset: null })
    if (path.endsWith('/quality-plans/plan-2')) return response(corrected.plan)
    if (path.endsWith('/quality-records/record-2')) return response(corrected.record)
    throw new Error(`unexpected path ${path}`)
  })
  Object.assign(window, { workwise: { runtimeRequest } })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('declared quality workflow desktop', () => {
  it('records a failure, issue, changed retained artifact and explicitly unresolved/resolved rechecks', async () => {
    await begin()
    expect(host.textContent).toContain('not professional approval')
    expect(host.querySelector('option[value=passed]')).toBeNull()
    expect(button('Save declaration').disabled).toBe(true)
    await saveCheck()
    expect(stored.recordedCheckCount).toBe(1)
    await input('Entry type', 'issue-opened'); await input('Check ID', 'closure'); await input('Issue ID', 'issue-1'); await input('Retained evidence material', 'output-1')
    await click(host.querySelector('input[type=checkbox]')!); await click(button('Save declaration'))
    expect(stored.openIssueCount).toBe(1)
    await input('Entry type', 'correction-recorded'); await input('Issue ID', 'issue-1'); await input('Correction ID', 'correction-1')
    await click(button('Find retained correction artifacts'))
    const choosePlan = Array.from(host.querySelectorAll('button')).filter(item => item.textContent?.startsWith('Choose correction retention plan'))
    expect(choosePlan).toHaveLength(1); await click(choosePlan[0]!)
    await click(Array.from(host.querySelectorAll('button')).find(item => item.textContent?.startsWith('Verify and select retention record'))!)
    await input('Retained evidence material', 'output-1'); await click(host.querySelector('input[type=checkbox]')!); await click(button('Save declaration'))
    expect(stored.entries.at(-1)!.targetBinding?.artifactHash).toBe(corrected.plan.artifact.bundleHash)
    await input('Entry type', 'issue-rechecked'); await input('Issue ID', 'issue-1'); await input('Retained evidence material', 'output-1')
    expect(host.querySelector('select option[value=not-evaluated]')).toBeNull()
    expect((label('Declared outcome').querySelector('select') as HTMLSelectElement).value).toBe('unresolved')
    await click(host.querySelector('input[type=checkbox]')!); await click(button('Save declaration')); expect(stored.openIssueCount).toBe(1)
    await input('Declared outcome', 'resolved'); await click(host.querySelector('input[type=checkbox]')!); await click(button('Save declaration'))
    expect(stored.openIssueCount).toBe(0); expect(stored.deliveryApproval).toBe('not-granted')
    expect(host.textContent).toContain('correction-1'); expect(host.textContent).toContain('closure')
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(host.textContent).toContain('声明已解决（不代表批准）'); expect(host.textContent).toContain('不代表专业批准')
  })

  it.each(['transport', 'invalid-response'])('keeps exact create retry and blocks history from discarding it after %s', async mode => {
    await render(); await open()
    if (mode === 'transport') runtimeRequest.mockRejectedValueOnce(new Error('network'))
    else runtimeRequest.mockResolvedValueOnce({ ok: true, status: 200, body: '{truncated' })
    await click(button('Create declared workflow'))
    const original = runtimeRequest.mock.calls.at(-1)!
    expect(button('Read independent workflow history').disabled).toBe(true)
    await click(button('Retry the same request'))
    expect(runtimeRequest.mock.calls.at(-1)).toEqual(original)
  })

  it('retains original append key and CAS head when response is lost', async () => {
    await begin()
    runtimeRequest.mockRejectedValueOnce(new Error('network'))
    await saveCheck(); const original = runtimeRequest.mock.calls.at(-1)!
    expect(host.textContent).not.toContain('Current declared workflow')
    await click(button('Retry the same request'))
    expect(runtimeRequest.mock.calls.at(-1)).toEqual(original)
    expect(JSON.parse(original[2]).expectedHeadHash).toBe('0'.repeat(64))
  })

  it.each([
    { runtimeReady: false }, { binding: { ...context.binding, projectId: 'other' } },
    { binding: { ...context.binding, projectRevision: 3 } },
    { record: { ...context.record, record: { ...context.record.record, id: 'other' } } },
    { record: { ...context.record, verification: { ...context.record.verification, headHash: 'f'.repeat(64) } } }
  ])('ignores late create responses after scope change %o', async override => {
    await render(); await open()
    let complete!: (value: unknown) => void
    runtimeRequest.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await click(button('Create declared workflow'), false)
    const key = JSON.parse(runtimeRequest.mock.calls.at(-1)![2]).idempotencyKey
    await render(override); await act(async () => complete(response(emptyWorkflow(context, key))))
    expect(host.textContent).not.toContain('Current declared workflow')
  })

  it('restores short history pages and uses actual previous offsets', async () => {
    await begin()
    runtimeRequest.mockResolvedValueOnce(response({ workflows: [], unavailable: [{ id: 'damaged-1', reason: 'integrity' }], nextOffset: 1 }))
    await click(button('Read independent workflow history'))
    expect(host.textContent).toContain('damaged-1')
    await click(button('Next page')); expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('offset=1')
    await click(button('Previous page')); expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('offset=0')
    await click(Array.from(host.querySelectorAll('button')).find(item => item.textContent?.startsWith('Verify and restore workflow'))!)
    expect(runtimeRequest.mock.calls.at(-1)![0]).toContain('/workflow-1')
  })

  it('ignores a restore completed after collapse and starts with no inherited selection', async () => {
    await begin(); await click(button('Read independent workflow history'))
    let complete!: (value: unknown) => void
    runtimeRequest.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await click(Array.from(host.querySelectorAll('button')).find(item => item.textContent?.startsWith('Verify and restore workflow'))!, false)
    await act(async () => { const details = host.querySelector('details')!; details.open = false; details.dispatchEvent(new Event('toggle')) })
    await act(async () => { complete(response(stored)); await new Promise(resolve => setTimeout(resolve, 10)) })
    await open(); expect(host.textContent).not.toContain('Current declared workflow')
    expect(button('Create declared workflow').disabled).toBe(false)
  })

  it('does not schedule writes after unmount while preflight hashing is pending', async () => {
    await begin(); await input('Check ID', 'closure'); await input('Retained evidence material', 'output-1'); await click(host.querySelector('input[type=checkbox]')!)
    runtimeRequest.mockClear()
    await act(async () => { button('Save declaration').click(); root.unmount() })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(runtimeRequest).not.toHaveBeenCalled()
    root = createRoot(host)
  })
})
