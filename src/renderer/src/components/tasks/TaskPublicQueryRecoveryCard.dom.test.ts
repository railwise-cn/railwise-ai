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
  getTaskPublicQueryRecovery: vi.fn(), prepareTaskPublicQueryRecovery: vi.fn(), retryTask: vi.fn(), resumeTask: vi.fn(), revokeTaskPublicQueryRecovery: vi.fn()
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
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-16T04:00:00.000Z'))
  current = { ...original }
  runtimeReady = true
  disabled = false
  api.getTaskPublicQueryRecovery.mockReset().mockResolvedValue(eligible)
  api.prepareTaskPublicQueryRecovery.mockReset().mockResolvedValue({ task: { ...original, revision: 4 }, recovery: prepared, prepared: true, resumed: false })
  api.retryTask.mockReset().mockResolvedValue({ task: { ...original, id: 'new-query-attempt', revision: 0 } })
  api.resumeTask.mockReset()
  api.revokeTaskPublicQueryRecovery.mockReset().mockResolvedValue({ task: { ...original, revision: 5 } })
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


const oneOffReview: NonNullable<TaskPublicQueryRecoverySnapshotV1['scopeReview']> = {
  reviewHash: 'a'.repeat(64), environmentHash: 'b'.repeat(64), purpose: 'Read the public engineering notices', browserLabel: 'Personal Chrome', browserIdentity: 'c'.repeat(64),
  scope: { browserInstanceId: 'private-browser-instance', revision: 6, origins: ['https://public.example.test'], interaction: 'interact', verificationPolicy: 'public_query_target' },
  allowedToolNames: ['browser_get_html', 'publish_artifact'], allowedProviderIds: ['browser-skill', 'managed-artifacts'], maxTtlSeconds: 900
}
const freshScope: TaskPublicQueryRecoverySnapshotV1 = { ...eligible, state: 'needs_scope_review', mode: 'task_reauthorization', scopeReview: oneOffReview }
const freshPrepared: TaskPublicQueryRecoverySnapshotV1 = { ...prepared, mode: 'task_reauthorization', scopeReview: oneOffReview, consentReceiptId: 'private-consent-id', consentExpiresAt: '2026-11-16T04:15:00.000Z' }
async function confirmScope(): Promise<void> {
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
  expect(checkbox).not.toBeNull()
  await act(async () => checkbox!.click()); await settle()
}
function action(label: string): HTMLButtonElement | undefined { return [...container.querySelectorAll('button')].find(element => element.textContent === label) }

describe('fresh one-off public query scope', () => {
  it('refreshes an already expired projection without offering continue or mutating consent', async () => {
    current.revision = freshPrepared.taskRevision
    api.getTaskPublicQueryRecovery.mockResolvedValueOnce({ ...freshPrepared, consentExpiresAt: '2026-11-16T03:59:59.000Z' })
      .mockResolvedValue({ ...freshScope, taskRevision: current.revision })
    await render()
    expect(api.getTaskPublicQueryRecovery).toHaveBeenCalledTimes(2)
    expect(action('Continue the new search')).toBeUndefined()
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
    expect(button()?.disabled).toBe(true)
    expect(api.prepareTaskPublicQueryRecovery).not.toHaveBeenCalled()
    expect(api.retryTask).not.toHaveBeenCalled()
    expect(api.revokeTaskPublicQueryRecovery).not.toHaveBeenCalled()
  })

  it('refreshes once at absolute expiry and requires a new unchecked server review', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let now = Date.parse('2026-11-16T04:00:00.000Z')
    vi.mocked(Date.now).mockImplementation(() => now)
    current.revision = freshPrepared.taskRevision
    api.getTaskPublicQueryRecovery.mockResolvedValueOnce({ ...freshPrepared, consentExpiresAt: '2026-11-16T04:00:01.000Z' })
      .mockResolvedValue({ ...freshScope, taskRevision: current.revision })
    try {
      await act(async () => root.render(createElement(TaskPublicQueryRecoveryCard, { task: current, runtimeReady, disabled, onChanged, onProjectionChange, onNotice })))
      expect(action('Continue the new search')).toBeDefined()
      now += 1001
      await act(async () => { await vi.advanceTimersByTimeAsync(1001) })
      expect(api.getTaskPublicQueryRecovery).toHaveBeenCalledTimes(2)
      expect(action('Continue the new search')).toBeUndefined()
      expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
      expect(button()?.disabled).toBe(true)
      expect(api.prepareTaskPublicQueryRecovery).not.toHaveBeenCalled()
      expect(api.retryTask).not.toHaveBeenCalled()
      expect(api.revokeTaskPublicQueryRecovery).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it.each([
    { ...freshScope, scopeReview: undefined },
    { ...freshScope, scopeReview: { ...oneOffReview, scope: { ...oneOffReview.scope, origins: [] } } },
    { ...freshPrepared, consentReceiptId: undefined },
    { ...freshPrepared, consentExpiresAt: undefined },
    { ...freshPrepared, consentRevoked: true }
  ])('offers no action for an incomplete or revoked one-off projection (%j)', async snapshot => {
    current.revision = snapshot.taskRevision
    api.getTaskPublicQueryRecovery.mockResolvedValue(snapshot)
    await render()
    expect(button()).toBeNull()
    expect(api.prepareTaskPublicQueryRecovery).not.toHaveBeenCalled()
    expect(api.retryTask).not.toHaveBeenCalled()
    expect(api.revokeTaskPublicQueryRecovery).not.toHaveBeenCalled()
  })

  it('keeps checked consent through unrelated UI changes', async () => {
    api.getTaskPublicQueryRecovery.mockResolvedValue(freshScope)
    await render(); await confirmScope()
    disabled = true; await render()
    disabled = false; await render()
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
    expect(button()?.disabled).toBe(false)
    expect(api.getTaskPublicQueryRecovery).toHaveBeenCalledTimes(1)
    expect(api.prepareTaskPublicQueryRecovery).not.toHaveBeenCalled()
  })

  it('resets checked consent on a changed browser identity even when the task revision is unchanged', async () => {
    api.getTaskPublicQueryRecovery.mockResolvedValue(freshScope)
    api.prepareTaskPublicQueryRecovery.mockRejectedValueOnce(Object.assign(new Error('identity changed'), { status: 409 }))
    await render(); await confirmScope()
    api.getTaskPublicQueryRecovery.mockResolvedValue({ ...freshScope, scopeReview: { ...oneOffReview, scope: { ...oneOffReview.scope, browserInstanceId: 'new-private-browser', revision: 7 } } })
    await click()
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
    expect(button()?.disabled).toBe(true)
    expect(api.prepareTaskPublicQueryRecovery).toHaveBeenCalledTimes(1)
    expect(api.retryTask).not.toHaveBeenCalled()
  })

  it('requires fresh scope consent and keeps prepare separate from continue', async () => {
    api.getTaskPublicQueryRecovery.mockResolvedValue(freshScope)
    api.prepareTaskPublicQueryRecovery.mockResolvedValue({ task: { ...original, revision: 4 }, recovery: freshPrepared, prepared: true, resumed: false })
    await render()
    expect(container.textContent).toContain(oneOffReview.purpose)
    expect(container.textContent).toContain(oneOffReview.browserLabel)
    expect(container.textContent).toContain('https://public.example.test')
    expect(button()?.disabled).toBe(true)
    await click(); expect(api.prepareTaskPublicQueryRecovery).not.toHaveBeenCalled()
    await confirmScope(); await click()
    expect(api.prepareTaskPublicQueryRecovery).toHaveBeenCalledExactlyOnceWith(original.id, expect.objectContaining({ expectedRevision: 3, confirmed: true, scopeConfirmation: {
      reviewHash: oneOffReview.reviewHash, expectedBrowserRevision: 6, browserInstanceId: oneOffReview.scope.browserInstanceId, origins: oneOffReview.scope.origins, duration: 'task', ttlSeconds: 900, confirmed: true
    } }))
    expect(api.retryTask).not.toHaveBeenCalled()
    expect(container.querySelector('time')?.dateTime).toBe(freshPrepared.consentExpiresAt)
    expect(container.textContent).not.toContain('private-consent-id')
    expect(container.textContent).not.toContain('private-browser-instance')
    expect(container.textContent).not.toContain(oneOffReview.reviewHash)
    await act(async () => action('Continue the new search')!.click()); await settle()
    expect(api.retryTask).toHaveBeenCalledExactlyOnceWith(original.id, expect.objectContaining({ expectedRevision: 4, publicQueryRecoveryReceiptId: prepared.receiptId }))
  })

  it('resets the checkbox when the reviewed task/revision/range changes', async () => {
    api.getTaskPublicQueryRecovery.mockResolvedValue(freshScope)
    await render(); await confirmScope(); expect(button()?.disabled).toBe(false)
    current = { ...current, revision: 4 }
    api.getTaskPublicQueryRecovery.mockResolvedValue({ ...freshScope, taskRevision: 4, scopeReview: { ...oneOffReview, reviewHash: 'd'.repeat(64), scope: { ...oneOffReview.scope, origins: ['https://changed.example.test'] } } })
    await render()
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
    expect(button()?.disabled).toBe(true)
    expect(container.textContent).not.toContain('https://public.example.test')
    expect(container.textContent).toContain('https://changed.example.test')
    expect(api.prepareTaskPublicQueryRecovery).not.toHaveBeenCalled()
  })

  it('reuses the same explicit consent and idempotency key after transport uncertainty', async () => {
    api.getTaskPublicQueryRecovery.mockResolvedValue(freshScope)
    api.prepareTaskPublicQueryRecovery.mockRejectedValueOnce(new Error('private transport details'))
    api.prepareTaskPublicQueryRecovery.mockResolvedValueOnce({ task: { ...original, revision: 4 }, recovery: freshPrepared, prepared: true, resumed: false })
    await render(); await confirmScope(); await click(); await click()
    expect(api.prepareTaskPublicQueryRecovery.mock.calls[0][1]).toEqual(api.prepareTaskPublicQueryRecovery.mock.calls[1][1])
    expect(api.retryTask).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('private transport details')
  })

  it('uses the server active-scope projection for revoke without offering prepare/continue', async () => {
    api.getTaskPublicQueryRecovery.mockResolvedValue({ ...freshPrepared, taskRevision: 3, state: 'unavailable', reason: 'browser_public_query_current_scope_active', unknownOperationCount: 0 })
    await render()
    expect(action('Prepare a new search')).toBeUndefined()
    expect(action('Continue the new search')).toBeUndefined()
    const revoke = action('Revoke this scope'); expect(revoke).toBeDefined()
    api.revokeTaskPublicQueryRecovery.mockRejectedValueOnce(new Error('transport uncertainty'))
    await act(async () => revoke!.click()); await settle()
    await act(async () => action('Revoke this scope')!.click()); await settle()
    expect(api.revokeTaskPublicQueryRecovery.mock.calls[0][1]).toEqual(api.revokeTaskPublicQueryRecovery.mock.calls[1][1])
    expect(api.revokeTaskPublicQueryRecovery).toHaveBeenCalledWith(original.id, expect.objectContaining({ expectedRevision: 3, confirmed: true, consentReceiptId: freshPrepared.consentReceiptId }))
    expect(api.retryTask).not.toHaveBeenCalled(); expect(api.prepareTaskPublicQueryRecovery).not.toHaveBeenCalled()
    expect(onChanged).toHaveBeenCalled()
  })

  it('never continues an expired/revoked server projection without a new checked review', async () => {
    api.getTaskPublicQueryRecovery.mockResolvedValue({ ...freshScope, consentExpiresAt: '2026-01-01T00:00:00.000Z', consentRevoked: true, consentReceiptId: 'old-private-consent' })
    await render()
    expect(button()?.disabled).toBe(true)
    expect(action('Continue the new search')).toBeUndefined()
    expect(action('Revoke this scope')).toBeUndefined()
    expect(container.textContent).not.toContain('old-private-consent')
    expect(api.retryTask).not.toHaveBeenCalled()
  })

  it('does not reuse checked consent after a stale server review conflict', async () => {
    api.getTaskPublicQueryRecovery.mockResolvedValue(freshScope)
    api.prepareTaskPublicQueryRecovery.mockRejectedValueOnce(Object.assign(new Error('changed browser revision'), { status: 409 }))
    await render(); await confirmScope()
    api.getTaskPublicQueryRecovery.mockResolvedValue({ ...freshScope, scopeReview: { ...oneOffReview, reviewHash: 'f'.repeat(64) } })
    await click()
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
    expect(button()?.disabled).toBe(true)
    expect(api.retryTask).not.toHaveBeenCalled()
  })
})
