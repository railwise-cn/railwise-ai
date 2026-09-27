// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import i18n from '../../i18n'
import { useChatStore } from '../../store/chat-store'
import { EngineeringAiCommandCenter } from './EngineeringAiCommandCenter'
import { useEngineeringConversationDrafts } from './engineering-conversation-drafts'
import type { EngineeringNavigationContext } from './engineering-evidence-navigation'

vi.mock('./EngineeringProjectSuggestions', () => ({ EngineeringProjectSuggestions: () => null }))

vi.mock('../chat/MessageTimeline', () => ({ MessageTimeline: ({ runtimeError }: { runtimeError?: string | null }) => createElement('div', { 'data-testid': 'message-timeline' }, runtimeError) }))
vi.mock('./EngineeringComposer', () => ({ EngineeringComposer: () => createElement('textarea', { 'aria-label': 'Survey composer' }) }))

type RuntimeResponse = { ok: boolean; status: number; body: string }
type RuntimeRequest = (path: string, method?: string, body?: string) => Promise<RuntimeResponse>

const workspaceRoot = '/survey-workspace'
const project = { id: 'project-a', name: 'Project A', monitoringType: 'survey', unit: 'm', revision: 1, reportPeriod: {} }
const stalePlan = {
  id: 'plan-stale', projectId: project.id, contextHash: 'context-old', revision: 2, goal: 'Adjust the current control network', status: 'stale',
  steps: [{ id: 'adjust', title: 'Run adjustment', tool: 'control_network', risk: 'write', approval: 'pending' }]
}
const refreshedPlan = {
  ...stalePlan, id: 'plan-current', contextHash: 'context-current', revision: 1, status: 'awaiting_approval',
  steps: stalePlan.steps.map(step => ({ ...step, parameters: { networkId: 'net-1', expectedRevision: 2 }, parameterBindings: [], expectedOutputs: ['adjustment-run'], reversibility: 'append-only' })),
  approval: { token: 'approval-token-current', stepIds: ['adjust'], expiresAt: '2026-09-09T00:00:00.000Z' }
}
const resumablePlan = {
  ...refreshedPlan, status: 'started', revision: 3, taskId: 'resumable-task', executionTurnId: 'first-execution',
  steps: ['validate', 'adjust'].map(id => ({ ...refreshedPlan.steps[0], id, title: id, approval: 'approved' })),
  execution: { complete: false, completedStepIds: ['validate'], pendingStepIds: ['adjust'] }
}

let container: HTMLDivElement
let root: Root
let runtimeRequest: Mock<RuntimeRequest>
let refreshThreads: Mock<() => Promise<void>>
let selectThread: Mock<(id: string) => Promise<void>>
let onRefresh: Mock<() => void>

function response(status: number, body: unknown): RuntimeResponse {
  return { ok: status >= 200 && status < 300, status, body: JSON.stringify(body) }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve }
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(EngineeringAiCommandCenter, {
      workspaceRoot, runtimeReady: true, project, dataset: null, analysis: null,
      onCreateProject: () => undefined, onImportData: () => undefined, onSurveyFiles: () => undefined, onOpenTab: () => undefined, onRefresh
    }))
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  await i18n.changeLanguage('en')
  runtimeRequest = vi.fn<RuntimeRequest>()
  refreshThreads = vi.fn<() => Promise<void>>(async () => undefined)
  selectThread = vi.fn<(id: string) => Promise<void>>(async () => undefined)
  onRefresh = vi.fn<() => void>()
  Object.assign(window, { workwise: { runtimeRequest, getTaskRun: vi.fn(async () => null) } })
  useChatStore.setState({
    route: 'engineering', workspaceRoot, runtimeConnection: 'ready', activeThreadId: 'thread-a',
    threads: [{ id: 'thread-a', domain: 'engineering', projectId: project.id, workspace: workspaceRoot }] as never,
    blocks: [], liveReasoning: '', liveAssistant: '', busy: false, error: null, lastSeq: 0, composerModel: 'test-model', composerProviderId: 'provider-a',
    refreshThreads, selectThread, probeRuntime: vi.fn(async () => undefined), openSettings: vi.fn()
  })
  useEngineeringConversationDrafts.setState({ drafts: {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('Engineering AI session recovery states', () => {
  it('allows explicit typed continuation after zero-tool stalling without inventing completed receipts', async () => {
    const plan = { ...resumablePlan, execution: { complete: false, completedStepIds: [], pendingStepIds: resumablePlan.steps.map(step => step.id) } }
    Object.assign(window.workwise, { getTaskRun: vi.fn(async () => ({ id: plan.taskId, threadId: 'thread-a', status: 'stalled' })) })
    runtimeRequest.mockImplementation(async (path, method) => path.endsWith('/resume') && method === 'POST'
      ? response(202, { plan: { ...plan, revision: 4, executionTurnId: 'continued-zero-receipt' } })
      : response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan } : { cards: [] }))
    await render(); await settle()
    expect([...container.querySelectorAll('[data-step-state]')].map(node => node.getAttribute('data-step-state'))).toEqual(['blocked', 'blocked'])
    const resume = container.querySelector<HTMLButtonElement>('[data-testid="engineering-resume"]')!
    expect(resume.disabled).toBe(false)
    await act(async () => resume.click()); await settle()
    expect(runtimeRequest.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1)
    expect(runtimeRequest.mock.calls.find(([, method]) => method === 'POST')?.[0]).toBe(`/v1/engineering/ai/plans/${plan.id}/resume`)
    expect(selectThread).toHaveBeenCalledWith('thread-a')
  })

  it.each(['failed', 'cancelled'])('offers explicit replanning instead of continuing the terminal %s task', async status => {
    Object.assign(window.workwise, { getTaskRun: vi.fn(async () => ({ id: resumablePlan.taskId, threadId: 'thread-a', status })) })
    runtimeRequest.mockImplementation(async (path, method, body) => {
      if (path === '/v1/engineering/ai/plans' && method === 'POST') {
        expect(JSON.parse(body!)).toMatchObject({ threadId: 'thread-a', projectId: project.id, replanOf: resumablePlan.id, goal: resumablePlan.goal })
        return response(201, { plan: refreshedPlan, approval: refreshedPlan.approval })
      }
      return response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan: resumablePlan } : { cards: [] })
    })
    await render(); await settle()
    expect(container.querySelector('[data-testid="engineering-resume"]')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="engineering-replan"]')!.click()); await settle()
    const mutations = runtimeRequest.mock.calls.filter(([, method]) => method === 'POST')
    expect(mutations).toHaveLength(1)
    expect(mutations[0]?.[0]).toBe('/v1/engineering/ai/plans')
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
    const start = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(i18n.t('engineeringApproveAndStart')))
    expect(start?.disabled).toBe(true)
  })

  it('does not replace a newer plan revision with a late resume response', async () => {
    const pending = deferred<RuntimeResponse>()
    let plan = resumablePlan
    Object.assign(window.workwise, { getTaskRun: vi.fn(async () => ({ id: plan.taskId, threadId: 'thread-a', status: 'stalled' })) })
    runtimeRequest.mockImplementation(async (path, method) => path.endsWith('/resume') && method === 'POST' ? pending.promise
      : response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan } : { cards: [] }))
    await render(); await settle()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="engineering-resume"]')!.click())
    plan = { ...resumablePlan, revision: 5, goal: 'Newer reviewed plan' }
    await act(async () => useChatStore.setState({ lastSeq: 1 })); await settle()
    await act(async () => pending.resolve(response(202, { plan: { ...resumablePlan, revision: 4 } }))); await settle()
    expect(container.textContent).toContain('Newer reviewed plan')
    expect(refreshThreads).not.toHaveBeenCalled()
    expect(selectThread).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLButtonElement>('[data-testid="engineering-resume"]')?.disabled).toBe(false)
  })

  it.each(['stalled', 'waiting_user', 'waiting_approval'])('continues a %s approved partial plan through the typed endpoint once with the captured selection', async status => {
    const pending = deferred<RuntimeResponse>()
    Object.assign(window.workwise, { getTaskRun: vi.fn(async () => ({ id: resumablePlan.taskId, threadId: 'thread-a', status })) })
    runtimeRequest.mockImplementation(async (path, method) => {
      if (path.endsWith('/resume') && method === 'POST') return pending.promise
      return response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan: resumablePlan } : { cards: [] })
    })
    const scope = JSON.stringify([workspaceRoot, project.id])
    useEngineeringConversationDrafts.getState().update(scope, draft => ({ ...draft, reasoningEffort: 'low', input: 'Keep my question' }))
    await render(); await settle()
    const resume = container.querySelector<HTMLButtonElement>('[data-testid="engineering-resume"]')!
    expect(resume).not.toBeNull()
    onRefresh.mockClear()
    await act(async () => { resume.click(); resume.click() })
    const calls = runtimeRequest.mock.calls.filter(([, method]) => method === 'POST')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe(`/v1/engineering/ai/plans/${resumablePlan.id}/resume`)
    expect(JSON.parse(calls[0]![2]!)).toMatchObject({ expectedRevision: 3, contextHash: resumablePlan.contextHash, model: 'test-model', providerId: 'provider-a', reasoningEffort: 'off' })
    await act(async () => {
      useChatStore.setState({ composerModel: 'changed-model', composerProviderId: 'provider-b' })
      useEngineeringConversationDrafts.getState().update(scope, draft => ({ ...draft, reasoningEffort: 'max' }))
    })
    await act(async () => pending.resolve(response(202, { plan: { ...resumablePlan, revision: 4, executionTurnId: 'continued-execution' } })))
    await settle()
    expect(refreshThreads).toHaveBeenCalledOnce()
    expect(selectThread).toHaveBeenCalledWith('thread-a')
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.input).toBe('Keep my question')
    expect(runtimeRequest.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1)
  })

  it.each(['completed', 'retrying', 'running', 'failed'])('does not offer typed continuation for a %s task', async status => {
    Object.assign(window.workwise, { getTaskRun: vi.fn(async () => ({ id: resumablePlan.taskId, threadId: 'thread-a', status })) })
    runtimeRequest.mockImplementation(async path => response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan: resumablePlan } : { cards: [] }))
    await render(); await settle()
    expect(container.querySelector('[data-testid="engineering-resume"]')).toBeNull()
    if (status === 'completed') expect(container.querySelector('[data-testid="engineering-replan"]')).not.toBeNull()
    expect(runtimeRequest.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true)
  })

  it.each(['other-task', 'other-thread'])('hides typed continuation when the current task binding differs: %s', async mismatch => {
    Object.assign(window.workwise, { getTaskRun: vi.fn(async () => ({ id: mismatch === 'other-task' ? mismatch : resumablePlan.taskId, threadId: mismatch === 'other-thread' ? mismatch : 'thread-a', status: 'stalled' })) })
    runtimeRequest.mockImplementation(async path => response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan: resumablePlan } : { cards: [] }))
    await render(); await settle()
    expect(container.querySelector('[data-testid="engineering-resume"]')).toBeNull()
  })

  it.each([202, 409])('ignores a late typed resume %s response after switching projects', async status => {
    const pending = deferred<RuntimeResponse>()
    Object.assign(window.workwise, { getTaskRun: vi.fn(async () => ({ id: resumablePlan.taskId, threadId: 'thread-a', status: 'stalled' })) })
    runtimeRequest.mockImplementation(async (path, method) => path.endsWith('/resume') && method === 'POST' ? pending.promise
      : response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan: path.includes('other-thread') ? null : resumablePlan } : { cards: [] }))
    await render(); await settle()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="engineering-resume"]')!.click())
    onRefresh.mockClear()
    await act(async () => {
      useChatStore.setState({ activeThreadId: 'other-thread', threads: [{ id: 'other-thread', domain: 'engineering', projectId: 'other-project', workspace: workspaceRoot }] as never })
      root.render(createElement(EngineeringAiCommandCenter, { workspaceRoot, runtimeReady: true, project: { ...project, id: 'other-project' }, dataset: null, analysis: null, onCreateProject: vi.fn(), onImportData: vi.fn(), onSurveyFiles: vi.fn(), onOpenTab: vi.fn(), onRefresh }))
    })
    await settle()
    await act(async () => pending.resolve(response(status, status === 202 ? { plan: { ...resumablePlan, revision: 4 } } : { code: 'engineering_plan_stale', message: 'PRIVATE' })))
    await settle()
    expect(refreshThreads).not.toHaveBeenCalled()
    expect(selectThread).not.toHaveBeenCalled()
    expect(onRefresh).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('PRIVATE')
    expect(container.textContent).not.toContain(i18n.t('runtimeEngineeringPlanStale'))
  })

  it.each(['en', 'zh'])('shows a localized typed resume failure without exposing the service message in %s', async language => {
    await i18n.changeLanguage(language)
    Object.assign(window.workwise, { getTaskRun: vi.fn(async () => ({ id: resumablePlan.taskId, threadId: 'thread-a', status: 'stalled' })) })
    runtimeRequest.mockImplementation(async (path, method) => path.endsWith('/resume') && method === 'POST'
      ? response(500, { code: 'internal_error', message: 'PRIVATE' })
      : response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan: resumablePlan } : { cards: [] }))
    await render(); await settle()
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="engineering-resume"]')!.click())
    await settle()
    expect(container.textContent).toContain(i18n.t('engineeringNoticeResumeFailed'))
    expect(container.textContent).not.toContain('PRIVATE')
    expect(container.querySelector<HTMLButtonElement>('[data-testid="engineering-resume"]')?.disabled).toBe(false)
  })

  it.each(['en', 'zh'])('shows only verified step receipts as complete and keeps historical false completion visible in %s', async language => {
    await i18n.changeLanguage(language)
    const steps = ['validate', 'adjust', 'read', 'report'].map(id => ({ ...refreshedPlan.steps[0], id, title: id }))
    let plan: typeof refreshedPlan & { taskId: string; execution?: { complete: boolean; completedStepIds: string[]; pendingStepIds: string[] } } = { ...refreshedPlan, status: 'completed', taskId: 'historical-task', steps }
    Object.assign(window.workwise, { getTaskRun: vi.fn(async () => ({ id: 'historical-task', status: 'completed' })) })
    runtimeRequest.mockImplementation(async path => response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan } : { cards: [] }))
    await render(); await settle()
    const states = () => [...container.querySelectorAll('[data-step-state]')].map(node => node.getAttribute('data-step-state'))
    expect(states()).toEqual(['blocked', 'blocked', 'blocked', 'blocked'])
    expect(container.textContent).toContain(i18n.t('engineeringStatusNeedsAttention'))
    expect(container.querySelector('[data-testid="engineering-plan-incomplete-evidence"]')?.textContent).toContain(i18n.t('engineeringPlanExecutionIncomplete', { completed: 0, total: 4 }))
    plan = { ...plan, status: 'needs_attention', execution: { complete: false, completedStepIds: ['validate'], pendingStepIds: ['adjust', 'read', 'report'] } }
    await act(async () => useChatStore.setState({ lastSeq: 1 })); await settle()
    expect(states()).toEqual(['done', 'blocked', 'blocked', 'blocked'])
    expect(container.textContent).toContain(i18n.t('engineeringStatusNeedsAttention'))
    expect(container.textContent).toContain(i18n.t('engineeringPlanStepReceiptConfirmed'))
    plan = { ...plan, status: 'completed', execution: { complete: true, completedStepIds: steps.map(step => step.id), pendingStepIds: [] } }
    await act(async () => useChatStore.setState({ lastSeq: 2 })); await settle()
    expect(states()).toEqual(['done', 'done', 'done', 'done'])
    expect(container.textContent).toContain(i18n.t('engineeringStatusCompleted'))
    expect(container.querySelector('[data-testid="engineering-plan-incomplete-evidence"]')).toBeNull()
    expect(runtimeRequest.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true)
  })

  it.each(['en', 'zh'])('hides obsolete diagnostics after verified completion in %s', async language => {
    await i18n.changeLanguage(language)
    const steps = ['validate', 'adjust', 'read', 'report'].map(id => ({ ...refreshedPlan.steps[0], id }))
    const plan = { ...resumablePlan, status: 'completed', steps, execution: { complete: true, completedStepIds: steps.map(step => step.id), pendingStepIds: [] } }
    Object.assign(window.workwise, { getTaskRun: vi.fn(async () => ({ id: plan.taskId, threadId: 'thread-a', status: 'completed', waitingReason: 'User requested continuation from checkpoint.', stalledReason: 'model_provider_unavailable' })) })
    runtimeRequest.mockImplementation(async path => response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan } : { cards: [] }))
    await render(); await settle()
    expect([...container.querySelectorAll('[data-step-state]')].map(node => node.getAttribute('data-step-state'))).toEqual(['done', 'done', 'done', 'done'])
    expect(container.textContent).toContain(i18n.t('engineeringStatusCompleted'))
    expect(container.textContent).not.toContain(i18n.t('engineeringStatusNeedsAttention'))
    expect(container.querySelector('[data-testid="engineering-task-diagnostic"]')).toBeNull()
  })

  it.each(['stalled', 'failed', 'cancelled', 'waiting_user', 'waiting_approval'])('keeps current %s diagnostics, including a plan needing attention', async status => {
    const plan = { ...resumablePlan, status: 'needs_attention' }
    Object.assign(window.workwise, { getTaskRun: vi.fn(async () => ({ id: plan.taskId, threadId: 'thread-a', status, stalledReason: 'model_provider_unavailable', waitingReason: 'model_provider_unavailable' })) })
    runtimeRequest.mockImplementation(async path => response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan } : { cards: [] }))
    await render(); await settle()
    expect(container.querySelector('[data-testid="engineering-task-diagnostic"]')?.textContent).toBe(i18n.t('runtimeModelProviderUnavailable'))
    expect(container.querySelector('[data-testid="engineering-plan-incomplete-evidence"]')).not.toBeNull()
  })

  it.each([
    { id: 'other-task', threadId: 'thread-a', status: 'failed' },
    { id: resumablePlan.taskId, threadId: 'other-thread', status: 'stalled' },
    { id: resumablePlan.taskId, threadId: 'thread-a', status: 'running' },
    { id: resumablePlan.taskId, threadId: 'thread-a', status: 'retrying' }
  ])('hides diagnostics from an unbound or active task: %o', async task => {
    Object.assign(window.workwise, { getTaskRun: vi.fn(async () => ({ ...task, stalledReason: 'model_provider_unavailable', waitingReason: 'model_provider_unavailable' })) })
    runtimeRequest.mockImplementation(async path => response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan: resumablePlan } : { cards: [] }))
    await render(); await settle()
    expect(container.querySelector('[data-testid="engineering-task-diagnostic"]')).toBeNull()
  })

  it.each(['completed', 'failed', 'cancelled', 'stalled', 'waiting_user', 'waiting_approval'])('refreshes authoritative project data once when execution becomes %s', async status => {
    const plan = { ...refreshedPlan, status: 'started', taskId: 'task-1', executionTurnId: 'execution-1' }
    const getTaskRun = vi.fn().mockResolvedValueOnce({ id: 'task-1', status: 'running' }).mockResolvedValue({ id: 'task-1', status })
    Object.assign(window.workwise, { getTaskRun })
    runtimeRequest.mockImplementation(async path => response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan } : { cards: [] }))
    await render(); await settle()
    expect(onRefresh).not.toHaveBeenCalled()
    await act(async () => useChatStore.setState({ busy: true }))
    await settle()
    expect(onRefresh).toHaveBeenCalledOnce()
    plan.status = status
    await act(async () => useChatStore.setState({ busy: false, lastSeq: 1 }))
    await settle()
    await act(async () => useChatStore.setState({ lastSeq: 2 }))
    await settle()
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(runtimeRequest.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true)
  })

  it('refreshes verified partial results when the execution stalls without replaying any tool', async () => {
    const steps = ['validate', 'adjust', 'report'].map(id => ({ ...refreshedPlan.steps[0], id, title: id }))
    let reads = 0
    const getTaskRun = vi.fn().mockResolvedValueOnce({ id: 'partial-task', threadId: 'thread-a', status: 'running' }).mockResolvedValue({ id: 'partial-task', threadId: 'thread-a', status: 'stalled', stalledReason: 'engineering_plan_steps_incomplete: adjust, report' })
    Object.assign(window.workwise, { getTaskRun })
    runtimeRequest.mockImplementation(async path => {
      if (!path.startsWith('/v1/engineering/ai/plans?')) return response(200, { cards: [] })
      reads += 1
      return response(200, { plan: { ...refreshedPlan, steps, status: 'started', taskId: 'partial-task', executionTurnId: 'partial-turn',
        execution: { complete: false, completedStepIds: reads > 1 ? ['validate'] : [], pendingStepIds: reads > 1 ? ['adjust', 'report'] : steps.map(step => step.id) } } })
    })
    await render(); await settle()
    expect(onRefresh).not.toHaveBeenCalled()
    await act(async () => useChatStore.setState({ busy: true })); await settle()
    expect(onRefresh).toHaveBeenCalledOnce()
    await act(async () => useChatStore.setState({ busy: false })); await settle()
    expect([...container.querySelectorAll('[data-step-state]')].map(node => node.getAttribute('data-step-state'))).toEqual(['done', 'blocked', 'blocked'])
    expect(container.textContent).toContain(i18n.t('engineeringStatusStalled'))
    expect(container.textContent).toContain(i18n.t('runtimeEngineeringPlanStepsIncomplete'))
    expect(container.textContent).not.toContain('engineering_plan_steps_incomplete:')
    expect(reads).toBeGreaterThan(1)
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(runtimeRequest.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true)
  })

  it.each(['other-project', project.id])('ignores a late completed task after switching conversation to %s', async nextProjectId => {
    const pendingTask = deferred<never>()
    Object.assign(window.workwise, { getTaskRun: vi.fn(() => pendingTask.promise) })
    const plan = { ...refreshedPlan, status: 'started', taskId: 'old-task', executionTurnId: 'old-execution' }
    runtimeRequest.mockImplementation(async path => response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan: path.includes('other-thread') ? null : plan } : { cards: [] }))
    await render(); await settle()
    await act(async () => {
      useChatStore.setState({ activeThreadId: 'other-thread', threads: [{ id: 'other-thread', domain: 'engineering', projectId: nextProjectId, workspace: workspaceRoot }] as never })
      root.render(createElement(EngineeringAiCommandCenter, { workspaceRoot, runtimeReady: true, project: { ...project, id: nextProjectId }, dataset: null, analysis: null, onCreateProject: vi.fn(), onImportData: vi.fn(), onSurveyFiles: vi.fn(), onOpenTab: vi.fn(), onRefresh }))
    })
    await settle()
    await act(async () => pendingTask.resolve({ id: 'old-task', status: 'completed' } as never))
    await settle()
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it.each(['en', 'zh'])('localizes stale plan rejection without exposing service content in %s', async language => {
    await i18n.changeLanguage(language)
    runtimeRequest.mockImplementation(async (path, method) => {
      if (path.startsWith('/v1/engineering/ai/plans?')) return response(200, { plan: refreshedPlan, approval: refreshedPlan.approval })
      if (path.startsWith('/v1/engineering/ai/evidence/')) return response(200, { cards: [] })
      if (path.endsWith('/approve') && method === 'POST') return response(200, { ...refreshedPlan, status: 'approved', revision: 2 })
      if (path.endsWith('/start') && method === 'POST') return response(409, { code: 'engineering_plan_stale', message: 'PRIVATE backend details' })
      throw new Error('unexpected request')
    })
    await render(); await settle()
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    const start = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(i18n.t('engineeringApproveAndStart')))!
    await act(async () => start.click())
    await settle()
    expect(container.textContent).toContain(i18n.t('runtimeEngineeringPlanStale'))
    expect(container.textContent).not.toContain('PRIVATE')
    expect(container.textContent).not.toContain('engineering_plan_stale')
    expect(onRefresh).not.toHaveBeenCalled()
  })
  it('offers exact navigation in compact mode without losing the ninth card or changing the conversation', async () => {
    const sha = 'a'.repeat(64)
    const navigationContext: EngineeringNavigationContext = { workspaceRoot, project, networks: [{ id: 'net-1', revision: 2, sourceFile: { sha256: sha } }], adjustments: [], datasets: [{ id: 'dataset', revision: 1, sourceFileHash: sha, findings: [] }], analyses: [], manifests: [] }
    const cards = Array.from({ length: 9 }, (_, index) => ({ id: index === 8 ? 'dataset' : `unbound-${index}`, kind: 'status', title: `Card ${index}`, summary: 'Evidence', sourceHash: sha }))
    runtimeRequest.mockImplementation(async path => response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan: refreshedPlan } : { cards }))
    const onNavigateEvidence = vi.fn()
    await act(async () => root.render(createElement(EngineeringAiCommandCenter, { workspaceRoot, runtimeReady: true, project, compact: true, dataset: null, analysis: null, onCreateProject: vi.fn(), onImportData: vi.fn(), onSurveyFiles: vi.fn(), onOpenTab: vi.fn(), onRefresh, navigationContext, onNavigateEvidence })))
    await settle()
    expect(container.textContent).toContain('Card 8')
    const links = [...container.querySelectorAll('button')].filter(button => button.textContent === i18n.t('engineeringOpenEvidence'))
    expect(links.filter(button => !button.disabled)).toHaveLength(2)
    expect(links.filter(button => button.disabled)).toHaveLength(8)
    await act(async () => links.find(button => !button.disabled)!.click())
    expect(onNavigateEvidence).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'survey', networkId: 'net-1', networkRevision: 2 }))
    await act(async () => links.at(-1)!.click())
    expect(onNavigateEvidence).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'dataset', datasetId: 'dataset' }))
    expect(selectThread).not.toHaveBeenCalled()
    expect(runtimeRequest.mock.calls.every(([, method]) => method === undefined || method === 'GET')).toBe(true)
  })

  it('distinguishes unavailable AI conversation from the available Survey service', async () => {
    useChatStore.setState({ runtimeConnection: 'idle' })
    await render()
    expect(container.textContent).toContain('Survey processing is available, but the AI conversation is not ready.')
    expect(container.textContent).not.toContain('Runtime is not connected.')
    expect(runtimeRequest).not.toHaveBeenCalled()
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(container.textContent).toContain('内业计算服务可用，AI 对话尚未就绪')
  })

  it('localizes a recorded model failure in both recovery surfaces without rewriting stored state', async () => {
    const error = '本次模型或工具尝试失败，任务将从检查点继续。'
    useChatStore.setState({ error, blocks: [{ id: 'question', kind: 'user', text: 'Explain precision' }] as never })
    runtimeRequest.mockImplementation(async path => response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan: null } : { cards: [] }))
    await render(); await settle()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('This model or tool attempt failed.')
    expect(container.querySelector('[data-testid="message-timeline"]')?.textContent).toContain('This model or tool attempt failed.')
    expect(container.textContent).not.toContain(error)
    expect(useChatStore.getState().error).toBe(error)
    await act(async () => { await i18n.changeLanguage('zh') })
    expect(container.querySelector('[data-testid="message-timeline"]')?.textContent).toBe(error)
  })

  it('displays reviewed parameters, bindings, outputs and reversibility before enabling execution', async () => {
    const plan = { ...refreshedPlan, steps: refreshedPlan.steps.map(step => ({ ...step, parameterBindings: [{ parameter: 'expectedRevision', stepId: 'validate', output: 'network.revision' }] })) }
    runtimeRequest.mockImplementation(async path => response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan, approval: plan.approval } : { cards: [] }))
    await render(); await settle()
    expect(container.textContent).toContain('net-1')
    expect(container.textContent).toContain('expectedRevision ← validate.network.revision')
    expect(container.textContent).toContain('control_network')
    expect(container.querySelector('[data-testid="engineering-plan-step-review"]')?.textContent).toContain('Expected outputs')
    const start = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(i18n.t('engineeringApproveAndStart')))
    expect(start?.disabled).toBe(true)
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click())
    expect(start?.disabled).toBe(false)
  })

  it('keeps legacy review information readable without an execute button', async () => {
    runtimeRequest.mockImplementation(async path => response(200, path.startsWith('/v1/engineering/ai/plans?') ? { plan: { ...stalePlan, status: 'approved' } } : { cards: [] }))
    await render(); await settle()
    expect(container.textContent).toContain(stalePlan.goal)
    expect([...container.querySelectorAll('button')].some(button => button.textContent?.includes(i18n.t('engineeringApproveAndStart')))).toBe(false)
    expect(container.querySelector('[data-testid="engineering-replan"]')).not.toBeNull()
  })

  it.each([
    { effort: 'low', requestEffort: 'off' },
    { effort: 'high', requestEffort: 'high' }
  ] as const)('captures the model/provider/$effort selection before approval and retains it while the picker changes', async ({ effort, requestEffort }) => {
    const approval = deferred<RuntimeResponse>()
    const approvedPlan = { ...refreshedPlan, status: 'approved', revision: 2 }
    const scope = JSON.stringify([workspaceRoot, project.id])
    useEngineeringConversationDrafts.getState().update(scope, draft => ({ ...draft, reasoningEffort: effort }))
    runtimeRequest.mockImplementation(async (path, method) => {
      if (path.startsWith('/v1/engineering/ai/plans?')) return response(200, { plan: refreshedPlan, approval: refreshedPlan.approval })
      if (path.startsWith('/v1/engineering/ai/evidence/')) return response(200, { cards: [] })
      if (path.endsWith('/approve') && method === 'POST') return approval.promise
      if (path.endsWith('/start') && method === 'POST') return response(200, { plan: { ...approvedPlan, status: 'started', revision: 3 } })
      throw new Error(`unexpected request: ${method ?? 'GET'} ${path}`)
    })
    await render(); await settle()
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    const start = [...container.querySelectorAll('button')].find(button => button.textContent?.includes(i18n.t('engineeringApproveAndStart')))!
    expect(start.disabled).toBe(false)
    await act(async () => start.click())
    expect(runtimeRequest.mock.calls.filter(([path]) => path.endsWith('/approve'))).toHaveLength(1)
    expect(runtimeRequest.mock.calls.filter(([path]) => path.endsWith('/start'))).toHaveLength(0)
    await act(async () => {
      useChatStore.setState({ composerModel: 'other-model', composerProviderId: 'provider-b' })
      useEngineeringConversationDrafts.getState().update(scope, draft => ({ ...draft, reasoningEffort: 'max' }))
    })
    await act(async () => approval.resolve(response(200, approvedPlan)))
    await settle()
    const starts = runtimeRequest.mock.calls.filter(([path]) => path.endsWith('/start'))
    expect(starts).toHaveLength(1)
    expect(JSON.parse(starts[0]![2]!)).toMatchObject({
      expectedRevision: 2, contextHash: refreshedPlan.contextHash,
      model: 'test-model', providerId: 'provider-a', reasoningEffort: requestEffort
    })
    expect(useChatStore.getState()).toMatchObject({ composerModel: 'other-model', composerProviderId: 'provider-b' })
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.reasoningEffort).toBe('max')
    expect(onRefresh).toHaveBeenCalledOnce()
  })

  it('shows loading, error, and partial states and retries both resources without clearing the draft', async () => {
    const initialPlan = deferred<RuntimeResponse>()
    const initialEvidence = deferred<RuntimeResponse>()
    const planResponses = [initialPlan.promise, Promise.resolve(response(200, { plan: refreshedPlan, approval: refreshedPlan.approval })), Promise.resolve(response(200, { plan: refreshedPlan, approval: refreshedPlan.approval }))]
    const evidenceResponses = [initialEvidence.promise, Promise.resolve(response(503, { message: 'Evidence index unavailable' })), Promise.resolve(response(200, { cards: [{ id: 'evidence-1', kind: 'result', title: 'Adjusted result', summary: 'Verified' }] }))]
    let planReads = 0
    let evidenceReads = 0
    runtimeRequest.mockImplementation((path: string) => path.startsWith('/v1/engineering/ai/plans?') ? planResponses[planReads++] : evidenceResponses[evidenceReads++])
    const scope = JSON.stringify([workspaceRoot, project.id])
    useEngineeringConversationDrafts.getState().update(scope, (draft) => ({
      ...draft,
      input: 'Keep this question',
      attachments: [{ id: 'attachment-1', name: 'observations.in2', mimeType: 'text/plain', byteSize: 12, state: 'ready' }] as never
    }))

    await render()
    expect(container.querySelector('[data-testid="engineering-session-read-state"]')?.getAttribute('data-state')).toBe('loading')

    await act(async () => {
      initialPlan.resolve(response(503, { message: 'Plan store unavailable' }))
      initialEvidence.resolve(response(503, { message: 'Evidence index unavailable' }))
    })
    await settle()
    expect(container.querySelector('[data-testid="engineering-session-read-state"]')?.getAttribute('data-state')).toBe('error')
    expect(container.textContent).toContain(i18n.t('engineeringPlanReadFailed'))
    expect(container.textContent).not.toContain('Plan store unavailable')

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="engineering-session-retry"]')?.click())
    await settle()
    expect(container.querySelector('[data-testid="engineering-session-read-state"]')?.getAttribute('data-state')).toBe('partial')
    expect(container.textContent).toContain(i18n.t('engineeringEvidenceReadFailed'))
    expect(container.textContent).not.toContain('Evidence index unavailable')

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="engineering-session-retry"]')?.click())
    await settle()
    expect(container.querySelector('[data-testid="engineering-session-read-state"]')).toBeNull()
    expect(container.textContent).toContain('Adjusted result')
    expect(planReads).toBe(3)
    expect(evidenceReads).toBe(3)
    expect(useEngineeringConversationDrafts.getState().drafts[scope]).toMatchObject({
      input: 'Keep this question', attachments: [expect.objectContaining({ id: 'attachment-1', state: 'ready' })]
    })
  })

  it('creates a new plan from current context when the stored plan is stale and preserves session input', async () => {
    runtimeRequest.mockImplementation((path: string, method?: string, body?: string) => {
      if (path.startsWith('/v1/engineering/ai/plans?')) return Promise.resolve(response(200, { plan: stalePlan }))
      if (path.startsWith('/v1/engineering/ai/evidence/')) return Promise.resolve(response(200, { cards: [] }))
      if (path === '/v1/engineering/ai/plans' && method === 'POST') {
        const request = JSON.parse(body ?? '{}') as Record<string, unknown>
        expect(request).toMatchObject({ threadId: 'thread-a', projectId: project.id, goal: stalePlan.goal, replanOf: stalePlan.id })
        expect(request.contextHash).toBeUndefined()
        expect(request.idempotencyKey).toMatch(/^engineering-replan-plan-stale-/)
        return Promise.resolve(response(201, { plan: refreshedPlan, approval: refreshedPlan.approval }))
      }
      throw new Error(`unexpected request: ${method ?? 'GET'} ${path}`)
    })
    const scope = JSON.stringify([workspaceRoot, project.id])
    useEngineeringConversationDrafts.getState().update(scope, (draft) => ({ ...draft, input: 'Question in progress' }))

    await render()
    await settle()
    const replan = container.querySelector<HTMLButtonElement>('[data-testid="engineering-replan"]')
    expect(replan).not.toBeNull()

    await act(async () => replan?.click())
    await settle()
    expect(container.querySelector('[data-testid="engineering-replan"]')).toBeNull()
    expect(container.textContent).toContain('Awaiting approval')
    expect(refreshThreads).toHaveBeenCalledOnce()
    expect(selectThread).toHaveBeenCalledWith('thread-a')
    expect(onRefresh).toHaveBeenCalledOnce()
    expect(useEngineeringConversationDrafts.getState().drafts[scope]?.input).toBe('Question in progress')
  })
})
