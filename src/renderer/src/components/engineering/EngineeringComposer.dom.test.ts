// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { FloatingComposer } from '../chat/FloatingComposer'
import { EngineeringComposer } from './EngineeringComposer'
import { useChatStore } from '../../store/chat-store'
import { prepareEngineeringQuestion, useEngineeringConversationDrafts } from './engineering-conversation-drafts'

let composer: ComponentProps<typeof FloatingComposer>
vi.mock('../chat/FloatingComposer', () => ({ FloatingComposer: (props: ComponentProps<typeof FloatingComposer>) => { composer = props; return createElement('textarea', { value: props.input, onChange: (event: { target: { value: string } }) => props.setInput(event.target.value) }) } }))
vi.mock('../../agent/registry', () => ({ getProvider: () => ({ getRuntimeInfo: async () => ({ capabilities: { attachments: { available: true } } }) }) }))

let root: Root
let container: HTMLDivElement
const sendMessage = vi.fn(async () => true)
const interrupt = vi.fn()
const importChatAttachment = vi.fn()
const onSurveyFiles = vi.fn()
const workspaceRoot = '/survey-workspace'

async function render(projectId = 'project-a', threadId = 'thread-a'): Promise<void> {
  await act(async () => { root.render(createElement(EngineeringComposer, { workspaceRoot, projectId, threadId, ready: true, onSurveyFiles })) })
}
function select(projectId: string, threadId: string): void {
  useChatStore.setState({ route: 'engineering', activeThreadId: threadId, threads: [{ id: threadId, domain: 'engineering', projectId, workspace: workspaceRoot }] as never, busy: false, queuedMessages: [], sendMessage, interrupt })
}
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { workwise: { getPathForFile: (file: File) => `/source/${file.name}`, importChatAttachment, cancelChatAttachmentImport: vi.fn() } })
  useEngineeringConversationDrafts.setState({ drafts: {} })
  useChatStore.setState({ composerModel: 'shared-model', composerProviderId: 'provider-a' })
  select('project-a', 'thread-a')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

describe('Survey composer continuity', () => {
  it('keeps technical observation identifiers in the request but out of the reference label', async () => {
    prepareEngineeringQuestion(workspaceRoot, 'project-a', 'Explain this observation', { section: 'observations', observationId: 'cosa-in2-6-backsight-reset', diagnosticCode: 'format_detected' })
    await render()
    expect(container.textContent).toContain('Selected observation')
    expect(container.textContent).not.toMatch(/cosa-in2|format_detected/)
    await act(async () => composer.onSend())
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('cosa-in2-6-backsight-reset'), 'agent', expect.any(Object))
  })

  it('waits for explicit Send and requests exact read-only resolution of the selected typed evidence', async () => {
    const typedEvidence = { schemaVersion: 1 as const, projectId: 'project-a', projectRevision: 3, kind: 'advanced-trial' as const, trialId: 'selected-trial', recordHash: 'a'.repeat(64), selector: { path: ['result', 'states', 1], identity: { iteration: 1 } } }
    prepareEngineeringQuestion(workspaceRoot, 'project-a', 'Explain this iteration', { projectId: 'project-a', projectRevision: 3, section: 'advanced-trial', typedEvidence })
    await render()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Current result')
    await act(async () => composer.onSend())
    expect(sendMessage).toHaveBeenCalledOnce()
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining(JSON.stringify(typedEvidence)), 'agent', expect.objectContaining({ displayText: 'Explain this iteration' }))
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('survey_read_evidence'), 'agent', expect.any(Object))
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('Do not substitute another record or execute a calculation'), 'agent', expect.any(Object))
    expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify([workspaceRoot, 'project-a'])]!.evidenceContext).toBeUndefined()
    expect(useEngineeringConversationDrafts.getState().drafts[JSON.stringify([workspaceRoot, 'project-a'])]!.viewContext).toBeUndefined()
    await act(async () => composer.setInput('A new independent question'))
    await act(async () => composer.onSend())
    expect(sendMessage).toHaveBeenLastCalledWith('A new independent question', 'agent', expect.any(Object))
  })

  it('preserves a new evidence selection and input made while the previous question is sending', async () => {
    const scope = JSON.stringify([workspaceRoot, 'project-a'])
    const first = { section: 'advanced-trial', typedEvidence: { schemaVersion: 1 as const, projectId: 'project-a', projectRevision: 1, kind: 'advanced-trial' as const, trialId: 'first', recordHash: 'a'.repeat(64) } }
    const second = { ...first, typedEvidence: { ...first.typedEvidence, trialId: 'second', recordHash: 'b'.repeat(64) } }
    let resolve!: (value: boolean) => void
    sendMessage.mockImplementationOnce(() => new Promise<boolean>(done => { resolve = done }))
    prepareEngineeringQuestion(workspaceRoot, 'project-a', 'First question', first)
    await render()
    let pending: void | Promise<void>
    await act(async () => { pending = composer.onSend() })
    await act(async () => { prepareEngineeringQuestion(workspaceRoot, 'project-a', 'Second question', second); composer.setInput('Second question') })
    await act(async () => { resolve(true); await pending })
    expect(useEngineeringConversationDrafts.getState().drafts[scope]).toMatchObject({ input: 'Second question', evidenceContext: second, viewContext: second })
  })

  it('explains missing project and pending thread without claiming Runtime is offline', async () => {
    await act(async () => root.render(createElement(EngineeringComposer, { workspaceRoot, projectId: '', threadId: null, ready: true, onSurveyFiles })))
    expect(composer.runtimeReady).toBe(false)
    expect(composer.unavailableReason).toBeTruthy()
    const missingProject = composer.unavailableReason
    await act(async () => root.render(createElement(EngineeringComposer, { workspaceRoot, projectId: 'project-a', threadId: null, ready: true, onSurveyFiles })))
    expect(composer.runtimeReady).toBe(false)
    expect(composer.unavailableReason).not.toBe(missingProject)
    await act(async () => composer.onSend())
    expect(sendMessage).not.toHaveBeenCalled()
    await render()
    expect(composer.runtimeReady).toBe(true)
    expect(composer.unavailableReason).toBeUndefined()
  })

  it('retains the conversation failure reason and draft until connection recovers', async () => {
    await render()
    await act(async () => composer.setInput('Keep this question'))
    await act(async () => root.render(createElement(EngineeringComposer, { workspaceRoot, projectId: 'project-a', threadId: 'thread-a', ready: false, unavailableReason: 'AI conversation is not ready', onSurveyFiles })))
    expect(composer.unavailableReason).toBe('AI conversation is not ready')
    await act(async () => composer.onSend())
    expect(sendMessage).not.toHaveBeenCalled()
    expect(composer.input).toBe('Keep this question')
    await render()
    expect(composer.unavailableReason).toBeUndefined()
    expect(composer.input).toBe('Keep this question')
  })

  it('sends a normal question through the shared chat action and clears only its own draft', async () => {
    await render()
    await act(async () => composer.setInput('Explain the residuals'))
    await act(async () => composer.onSend())
    expect(sendMessage).toHaveBeenCalledWith('Explain the residuals', 'agent', expect.objectContaining({ attachmentIds: [] }))
    expect(composer.input).toBe('')
  })

  it('sends explicit off for Low and retains the selected effort after successful send', async () => {
    await render()
    await act(async () => {
      composer.setInput('Explain without extended reasoning')
      composer.onComposerReasoningEffortChange?.('low')
    })
    await act(async () => composer.onSend())
    expect(sendMessage).toHaveBeenCalledWith('Explain without extended reasoning', 'agent', expect.objectContaining({ reasoningEffort: 'off' }))
    expect(composer.input).toBe('')
    expect(composer.composerReasoningEffort).toBe('low')
  })

  it('passes provider identity to the shared picker even when model names match', async () => {
    await render()
    expect(composer.hideModelPicker).toBe(true)
    expect(composer.composerModel).toBe('shared-model')
    expect(composer.composerProviderId).toBe('provider-a')
    await act(async () => useChatStore.setState({ composerProviderId: 'provider-b' }))
    expect(composer.composerModel).toBe('shared-model')
    expect(composer.composerProviderId).toBe('provider-b')
  })

  it('restores project drafts and independent efforts after switching and after settings remount', async () => {
    await render()
    expect(composer.composerReasoningEffort).toBe('max')
    await act(async () => {
      composer.setInput('Project A question')
      composer.onComposerReasoningEffortChange?.('low')
    })
    await act(async () => select('project-b', 'thread-b'))
    await render('project-b', 'thread-b')
    expect(composer.input).toBe('')
    expect(composer.composerReasoningEffort).toBe('max')
    await act(async () => {
      composer.setInput('Project B question')
      composer.onComposerReasoningEffortChange?.('high')
    })
    await act(async () => {
      root.render(null)
      useChatStore.setState({ route: 'settings' })
    })
    await act(async () => select('project-a', 'thread-a'))
    await render()
    expect(composer.input).toBe('Project A question')
    expect(composer.composerReasoningEffort).toBe('low')
    await act(async () => select('project-b', 'thread-b'))
    await render('project-b', 'thread-b')
    expect(composer.input).toBe('Project B question')
    expect(composer.composerReasoningEffort).toBe('high')
  })

  it('carries selected result IDs into a follow-up while keeping the visible message concise', async () => {
    const scope = JSON.stringify([workspaceRoot, 'project-a'])
    useEngineeringConversationDrafts.getState().update(scope, (draft) => ({ ...draft, input: 'Explain this result', viewContext: { networkId: 'network-1', adjustmentId: 'adjustment-1', networkRevision: 3, sourceSha256: 'source-hash', sourceRecordId: 'record-19', observationId: 'obs-19', section: 'result' } }))
    await render()
    await act(async () => composer.onSend())
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('"adjustmentId":"adjustment-1"'), 'agent', expect.objectContaining({ displayText: 'Explain this result' }))
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('"sourceRecordId":"record-19"'), 'agent', expect.any(Object))
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('"networkRevision":3'), 'agent', expect.any(Object))
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('Read these exact legacy selectors using survey_read_context before answering.'), 'agent', expect.any(Object))
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('This selection has no typedEvidence; do not invent a typed reference'), 'agent', expect.any(Object))
  })

  it('pins a selected record across page navigation and clears it only after successful send', async () => {
    const scope = JSON.stringify([workspaceRoot, 'project-a'])
    prepareEngineeringQuestion(workspaceRoot, 'project-a', 'Explain the selected record', { section: 'preflight', networkId: 'old-network', networkRevision: 2, sourceRecordId: 'record-19', sourceSha256: 'old-hash' })
    useEngineeringConversationDrafts.getState().update(scope, draft => ({ ...draft, viewContext: { section: 'result', networkId: 'new-network', networkRevision: 8 } }))
    await render()
    sendMessage.mockResolvedValueOnce(false)
    await act(async () => composer.onSend())
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.evidenceContext?.sourceRecordId).toBe('record-19')
    await act(async () => composer.onSend())
    expect(sendMessage).toHaveBeenLastCalledWith(expect.stringContaining('"networkId":"old-network"'), 'agent', expect.objectContaining({ displayText: 'Explain the selected record' }))
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.evidenceContext).toBeUndefined()
  })

  it('shows and removes the selected reference without deleting the question', async () => {
    const scope = JSON.stringify([workspaceRoot, 'project-a'])
    prepareEngineeringQuestion(workspaceRoot, 'project-a', 'Explain this observation', { section: 'observations', observationId: 'obs-31' })
    await render()
    expect(container.textContent).toContain('Selected observation')
    expect(container.textContent).not.toContain('obs-31')
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    expect(useEngineeringConversationDrafts.getState().drafts[scope]).toMatchObject({ input: 'Explain this observation', evidenceContext: undefined, viewContext: undefined })
    expect(container.textContent).not.toContain('obs-31')
  })

  it('routes professional files to preflight without parsing them as documents or losing the question', async () => {
    await render()
    await act(async () => composer.setInput('Review this network'))
    const files = [new File(['original records'], 'observations.in2')]
    await act(async () => composer.onPickAttachments?.(files))
    expect(onSurveyFiles).toHaveBeenCalledWith(files)
    expect(importChatAttachment).not.toHaveBeenCalled()
    expect(composer.input).toBe('Review this network')
    expect(composer.attachmentAccept).toContain('.in2')
    expect(composer.isAdditionalAttachment?.(files[0]!)).toBe(true)
  })

  it('keeps the standard document pipeline and blocks sends until attachments are ready', async () => {
    let resolveImport!: (result: unknown) => void
    importChatAttachment.mockImplementationOnce(() => new Promise((resolve) => { resolveImport = resolve }))
    await render()
    await act(async () => composer.onPickAttachments?.([new File(['document'], 'report.pdf', { type: 'application/pdf' })]))
    expect(composer.attachmentUploadBusy).toBe(true)
    await act(async () => composer.onSend())
    expect(sendMessage).not.toHaveBeenCalled()
    await act(async () => resolveImport({ attachment: { id: 'attachment-pdf', name: 'report.pdf', state: 'ready' }, managedPath: '/managed/report.pdf' }))
    expect(composer.attachmentUploadBusy).toBe(false)
    await act(async () => composer.onSend())
    expect(sendMessage).toHaveBeenCalledWith(expect.any(String), 'agent', expect.objectContaining({ attachmentIds: ['attachment-pdf'] }))
  })

  it('guards send and stop against another active thread', async () => {
    await render()
    await act(async () => composer.setInput('Do not send to Code'))
    await act(async () => useChatStore.setState({ route: 'chat', activeThreadId: 'code-thread' }))
    await act(async () => { composer.onSend(); composer.onInterrupt() })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
    await act(async () => select('project-a', 'thread-a'))
    await act(async () => composer.onInterrupt())
    expect(interrupt).toHaveBeenCalledOnce()
  })
})
