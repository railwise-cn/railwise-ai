// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { EngineeringEvidenceQuestion, EngineeringEvidenceQuestions, EngineeringSelectedEvidence } from './EngineeringEvidenceQuestion'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'

let host: HTMLDivElement, root: Root
const focus = vi.fn(), request = vi.fn(), send = vi.fn(), approve = vi.fn()
const scope = { workspace: '/survey', projectId: 'project', projectRevision: 4, ready: true, focus }
const key = JSON.stringify([scope.workspace, scope.projectId])
const reference = { kind: 'advanced-trial' as const, trialId: 'trial-selected', recordHash: 'a'.repeat(64) }
const selector = { path: ['result', 'states', 2], identity: { iteration: 2 } }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { workwise: { runtimeRequest: request, sendMessage: send, approve } })
  await i18n.changeLanguage('en')
  vi.clearAllMocks(); useEngineeringConversationDrafts.setState({ drafts: {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
async function render(props: Partial<ComponentProps<typeof EngineeringEvidenceQuestion>> = {}, selectedScope: typeof scope | null = scope) {
  await act(async () => root.render(createElement(EngineeringEvidenceQuestions, { scope: selectedScope, children: createElement(EngineeringSelectedEvidence, { reference, children: createElement(EngineeringEvidenceQuestion, { label: 'Iteration 2', selector, ...props }) }) })))
}

it('prepares only the selected exact evidence and preserves the existing question, attachments and errors', async () => {
  useEngineeringConversationDrafts.getState().update(key, draft => ({ ...draft, input: 'Keep my question', attachments: [{ id: 'pdf-1' }] as never, uploading: true, error: 'attachment pending', reasoningEffort: 'high', viewContext: { section: 'result', adjustmentId: 'unrelated-adjustment' } }))
  await render(); await act(async () => host.querySelector('button')!.click())
  expect(useEngineeringConversationDrafts.getState().drafts[key]).toMatchObject({ input: 'Keep my question', attachments: [{ id: 'pdf-1' }], uploading: true, error: 'attachment pending', reasoningEffort: 'high', evidenceContext: { projectId: 'project', projectRevision: 4, section: 'advanced-trial', typedEvidence: { schemaVersion: 1, projectId: 'project', projectRevision: 4, ...reference, selector } } })
  expect(useEngineeringConversationDrafts.getState().drafts[key]!.evidenceContext).not.toHaveProperty('adjustmentId')
  expect(focus).toHaveBeenCalledOnce(); expect(request).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled()
})

it('keeps separate project drafts and does not act while offline, unbound, mismatched or explicitly disabled', async () => {
  for (const [props, current] of [
    [{}, { ...scope, ready: false }], [{}, { ...scope, workspace: '' }],
    [{ reference: { ...reference, recordHash: 'missing' } }, scope],
    [{ reference: { ...reference, schemaVersion: 1, projectId: 'other', projectRevision: 4 } }, scope],
    [{ reference: { ...reference, schemaVersion: 1, projectId: 'project', projectRevision: 3 } }, scope],
    [{ disabled: true }, scope]
  ] as Array<[Partial<ComponentProps<typeof EngineeringEvidenceQuestion>>, typeof scope]>) {
    await render(props, current); expect(host.querySelector('button')!.disabled).toBe(true)
    await act(async () => host.querySelector('button')!.click())
  }
  expect(focus).not.toHaveBeenCalled(); expect(useEngineeringConversationDrafts.getState().drafts).toEqual({})
  await render({}, { ...scope, projectId: 'other' }); await act(async () => host.querySelector('button')!.click())
  expect(useEngineeringConversationDrafts.getState().drafts[key]).toBeUndefined()
  expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify(['/survey', 'other'])]!.evidenceContext!.typedEvidence!.projectId).toBe('other')
  await render({}, null); expect(host.querySelector('button')).toBeNull()
})

it('uses a localized accessible icon and stops row actions from executing', async () => {
  const rowClick = vi.fn()
  await act(async () => root.render(createElement(EngineeringEvidenceQuestions, { scope, children: createElement('div', { onClick: rowClick }, createElement(EngineeringEvidenceQuestion, { label: 'trial-selected', reference })) })))
  const button = host.querySelector('button')!
  expect(button.textContent).toBe(''); expect(button.getAttribute('title')).toContain('trial-selected')
  await act(async () => button.click()); expect(rowClick).not.toHaveBeenCalled()
  const english = button.getAttribute('aria-label')
  await act(async () => { await i18n.changeLanguage('zh') })
  expect(button.getAttribute('aria-label')).not.toBe(english)
  expect(button.getAttribute('aria-label')).toContain('trial-selected')
})
