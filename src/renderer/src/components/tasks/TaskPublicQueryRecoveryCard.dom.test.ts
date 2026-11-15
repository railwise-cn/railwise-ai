// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskPublicQueryRecoverySnapshotV1, TaskRunV1 } from '@shared/agent-workbench'
import i18n from '../../i18n'
import { TaskPublicQueryRecoveryCard } from './TaskPublicQueryRecoveryCard'

const original: TaskRunV1 = {
  id: 'query-task', threadId: 'query-thread', childTaskIds: [], workspaceRoot: '/workspace', goal: 'Read public notices', status: 'stalled',
  acceptance: { kind: 'files', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: true },
  agentId: 'default', budget: { maxAttempts: 8, maxDurationMs: 1800000 }, attempts: 1, replans: 0, noProgressCount: 0,
  nodes: [], artifacts: [], revision: 3, createdAt: '2026-11-15T01:00:00Z', updatedAt: '2026-11-15T01:00:00Z'
}
const eligible: TaskPublicQueryRecoverySnapshotV1 = { taskId: original.id, taskRevision: 3, state: 'eligible', unknownOperationCount: 2, message: 'safe server projection' }
const prepared: TaskPublicQueryRecoverySnapshotV1 = { ...eligible, taskRevision: 4, state: 'prepared', receiptId: 'private-recovery-receipt' }
let container: HTMLDivElement
let root: Root
let current: TaskRunV1
let runtimeReady: boolean
let disabled: boolean
const api = {
  getTaskPublicQueryRecovery: vi.fn(), prepareTaskPublicQueryRecovery: vi.fn(), retryTask: vi.fn(), resumeTask: vi.fn()
}
const onChanged = vi.fn(async () => undefined)
const onProjectionChange = vi.fn()
const onNotice = vi.fn()
async function settle(): Promise<void> { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) }) }
async function render(): Promise<void> {
  await act(async () => root.render(createElement(TaskPublicQueryRecoveryCard, { task: current, runtimeReady, disabled, onChanged, onProjectionChange, onNotice })))
  await settle()
}
function button(): HTMLButtonElement | null { return container.querySelector('button') }
async function click(): Promise<void> { expect(button()).not.toBeNull(); await act(async () => button()!.click()); await settle() }

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  vi.clearAllMocks()
  current = { ...original }
  runtimeReady = true
  disabled = false
  api.getTaskPublicQueryRecovery.mockReset().mockResolvedValue(eligible)
  api.prepareTaskPublicQueryRecovery.mockReset().mockResolvedValue({ task: { ...original, revision: 4 }, recovery: prepared, prepared: true, resumed: false })
  api.retryTask.mockReset().mockResolvedValue({ task: { ...original, id: 'new-query-attempt', revision: 0 } })
  api.resumeTask.mockReset()
  Object.defineProperty(window, 'workwise', { configurable: true, value: api })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); Reflect.deleteProperty(window, 'workwise'); vi.restoreAllMocks() })

describe('TaskPublicQueryRecoveryCard', () => {
  it.each([
    { ...eligible, state: 'unavailable' as const },
    { ...eligible, taskId: 'other-task' },
    { ...eligible, taskRevision: 2 },
    { ...eligible, unknownOperationCount: 0 },
    { ...eligible, state: 'prepared' as const },
  ])('offers no action without a matching actionable server projection (%j)', async snapshot => {
    api.getTaskPublicQueryRecovery.mockResolvedValue(snapshot)
    await render()
    expect(button()).toBeNull()
    expect(api.prepareTaskPublicQueryRecovery).not.toHaveBeenCalled()
    expect(api.retryTask).not.toHaveBeenCalled()
  })

  it('keeps preparation separate from continuation and sends the server revision and recovery receipt', async () => {
    await render()
    expect(button()?.textContent).toBe('Prepare a new search')
    await click()
    expect(api.prepareTaskPublicQueryRecovery).toHaveBeenCalledExactlyOnceWith(original.id, expect.objectContaining({ expectedRevision: 3, confirmed: true }))
    expect(api.retryTask).not.toHaveBeenCalled()
    expect(api.resumeTask).not.toHaveBeenCalled()
    expect(button()?.textContent).toBe('Continue the new search')
    expect(container.textContent).toContain('No new search has started')
    expect(container.textContent).not.toContain(prepared.receiptId)
    await click()
    expect(api.retryTask).toHaveBeenCalledExactlyOnceWith(original.id, expect.objectContaining({ expectedRevision: 4, publicQueryRecoveryReceiptId: prepared.receiptId }))
    expect(api.resumeTask).not.toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalledTimes(2)
    expect(onNotice).toHaveBeenCalledWith(i18n.t('common:taskPublicQueryRecoveryStarted'))
  })

  it('restores the separate continue action after reopening a server-prepared task', async () => {
    current.revision = prepared.taskRevision
    api.getTaskPublicQueryRecovery.mockResolvedValue(prepared)
    await render()
    expect(button()?.textContent).toBe('Continue the new search')
    expect(api.prepareTaskPublicQueryRecovery).not.toHaveBeenCalled()
    expect(api.retryTask).not.toHaveBeenCalled()
  })

  it('shows only the server-verified sites and explains when fresh scope review is required', async () => {
    api.getTaskPublicQueryRecovery.mockResolvedValue({ ...eligible, origins: ['https://public.example.test'] })
    await render()
    expect(container.textContent).toContain('https://public.example.test')
    expect(container.textContent).not.toContain('private-recovery-receipt')
    current = { ...current, revision: current.revision + 1 }
    api.getTaskPublicQueryRecovery.mockResolvedValue({ ...eligible, taskRevision: current.revision, state: 'unavailable', reason: 'browser_public_query_schedule_scope_required' })
    await render()
    expect(container.textContent).toContain(i18n.t('common:taskPublicQueryRecoveryFreshScopeRequired'))
    expect(container.textContent).not.toContain('https://public.example.test')
    expect(button()).toBeNull()
    expect(api.prepareTaskPublicQueryRecovery).not.toHaveBeenCalled()
    expect(api.retryTask).not.toHaveBeenCalled()
  })

  it('reuses the preparation key after an uncertain response and hides internal errors', async () => {
    api.prepareTaskPublicQueryRecovery.mockRejectedValueOnce(new Error('{"receiptId":"private-id","operation":"internal"}'))
    await render(); await click()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(i18n.t('common:taskPublicQueryRecoveryPrepareFailed'))
    expect(container.textContent).not.toContain('private-id')
    await click()
    expect(api.prepareTaskPublicQueryRecovery.mock.calls[0][1]).toEqual(api.prepareTaskPublicQueryRecovery.mock.calls[1][1])
    expect(api.retryTask).not.toHaveBeenCalled()
  })

  it('reuses the continuation key and exact receipt after an uncertain retry response', async () => {
    current.revision = 4; api.getTaskPublicQueryRecovery.mockResolvedValue(prepared)
    api.retryTask.mockRejectedValueOnce(new Error('transport disconnected'))
    await render(); await click(); await click()
    expect(api.retryTask.mock.calls[0][1]).toEqual(api.retryTask.mock.calls[1][1])
    expect(api.retryTask.mock.calls[1][1].publicQueryRecoveryReceiptId).toBe(prepared.receiptId)
    expect(api.prepareTaskPublicQueryRecovery).not.toHaveBeenCalled()
  })

  it('does not dispatch twice while preparation is pending', async () => {
    let resolve!: (value: unknown) => void
    api.prepareTaskPublicQueryRecovery.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await render()
    await act(async () => { button()!.click(); button()!.click() })
    expect(api.prepareTaskPublicQueryRecovery).toHaveBeenCalledTimes(1)
    expect(button()?.disabled).toBe(true)
    await act(async () => resolve({ task: { ...original, revision: 4 }, recovery: prepared, prepared: true, resumed: false }))
    await settle()
    expect(api.retryTask).not.toHaveBeenCalled()
  })

  it('refreshes a stale revision and removes actions if the new server state is unavailable', async () => {
    api.prepareTaskPublicQueryRecovery.mockRejectedValueOnce(Object.assign(new Error('raw technical conflict'), { status: 409 }))
    await render()
    api.getTaskPublicQueryRecovery.mockResolvedValue({ ...eligible, state: 'unavailable' })
    await click()
    expect(onChanged).toHaveBeenCalledTimes(1)
    expect(api.getTaskPublicQueryRecovery).toHaveBeenCalledTimes(2)
    expect(button()).toBeNull()
    expect(api.retryTask).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('raw technical conflict')
  })

  it('ignores a late eligibility response after the user selects another task', async () => {
    let resolve!: (value: unknown) => void
    api.getTaskPublicQueryRecovery.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await render()
    current = { ...original, id: 'other-task' }
    api.getTaskPublicQueryRecovery.mockResolvedValue({ ...eligible, taskId: current.id, state: 'unavailable' })
    await render()
    await act(async () => resolve(eligible)); await settle()
    expect(button()).toBeNull()
    expect(onProjectionChange).not.toHaveBeenCalledWith({ taskId: original.id, state: 'eligible' })
  })

  it('does not apply an old preparation response after the task revision changes', async () => {
    let resolve!: (value: unknown) => void
    api.prepareTaskPublicQueryRecovery.mockImplementationOnce(() => new Promise(done => { resolve = done }))
    await render()
    await act(async () => button()!.click())
    current = { ...original, revision: 5, status: 'paused' }
    api.getTaskPublicQueryRecovery.mockResolvedValue({ ...eligible, taskRevision: 5, state: 'unavailable' })
    await render()
    await act(async () => resolve({ task: { ...original, revision: 4 }, recovery: prepared, prepared: true, resumed: false }))
    await settle()
    expect(button()).toBeNull()
    expect(onProjectionChange).not.toHaveBeenCalledWith({ taskId: original.id, state: 'prepared' })
    expect(api.retryTask).not.toHaveBeenCalled()
  })

  it('does not advertise recovery when the server check fails or Runtime is unavailable', async () => {
    api.getTaskPublicQueryRecovery.mockRejectedValueOnce(new Error('not connected'))
    await render(); expect(button()).toBeNull()
    runtimeReady = false; await render()
    expect(api.getTaskPublicQueryRecovery).toHaveBeenCalledTimes(1)
    expect(api.prepareTaskPublicQueryRecovery).not.toHaveBeenCalled()
  })

  it('uses concise Chinese business actions and respects other task controls being busy', async () => {
    await i18n.changeLanguage('zh'); disabled = true
    await render()
    expect(button()?.textContent).toBe('准备重新检索')
    expect(button()?.disabled).toBe(true)
    expect(container.textContent).not.toContain('receiptId')
    expect(container.textContent).not.toContain(original.id)
  })
})
