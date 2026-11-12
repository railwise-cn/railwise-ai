import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedThread } from '../agent/types'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  readWriteWorkspaceRoots: vi.fn()
}))

vi.mock('../agent/registry', () => ({ getProvider: mocks.getProvider }))
vi.mock('../lib/apply-theme', () => ({ applyTheme: vi.fn(), applyUiFontScale: vi.fn() }))
vi.mock('./chat-store-runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('./chat-store-runtime')>(),
  readWriteWorkspaceRoots: mocks.readWriteWorkspaceRoots
}))

import { createNavigationActions } from './chat-store-navigation-actions'
import { createThreadActions } from './chat-store-thread-actions'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { WorkWiseRuntimeProvider } from '../agent/managed-runtime'
import type { WorkWiseSettingsV2 } from '@shared/app-settings'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function engineeringThread(id: string, projectId: string): NormalizedThread {
  return {
    id,
    projectId,
    domain: 'engineering',
    title: 'Survey AI · New Survey job',
    updatedAt: '2026-10-09T04:18:16.949Z',
    model: 'deepseek-v4-pro',
    mode: 'agent',
    workspace: '/workspace/survey',
    status: 'idle'
  }
}

function buildHarness(initialThreads: NormalizedThread[]) {
  const state = {
    activeThreadId: initialThreads[0]?.id ?? null,
    blocks: [],
    busy: false,
    clawChannels: [],
    codeWorkspaceRoots: [],
    error: null,
    queuedMessages: [],
    route: 'engineering',
    runtimeConnection: 'ready',
    threads: initialThreads,
    unreadThreadIds: {},
    watchTurnCompletion: {},
    workspaceRoot: '/workspace/survey'
  } as unknown as ChatState
  const set: ChatStoreSet = (partial) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  const get: ChatStoreGet = () => state
  const sseAbortRef = { current: null as AbortController | null }
  const context = { set, get, sseAbortRef }
  Object.assign(state, createNavigationActions(context), createThreadActions(context))
  return { state, sseAbortRef }
}

describe('startup runtime recovery through navigation actions', () => {
  function startupState() {
    const { state } = buildHarness([])
    Object.assign(state, { runtimeConnection: 'idle', route: 'chat', composerPickList: [], applyI18nFromSettings: vi.fn(async () => undefined),
      loadComposerModels: vi.fn(async () => undefined), refreshThreads: vi.fn(async () => undefined) })
    return state
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.restoreAllMocks()
    mocks.getProvider.mockReset()
    const windowTarget = Object.assign(new EventTarget(), { workwise: {} })
    vi.stubGlobal('window', windowTarget)
    vi.spyOn(rendererRuntimeClient, 'getSettings').mockResolvedValue({
      revision: 18, workspaceRoot: '', locale: 'zh', theme: 'dark', uiFontScale: 'medium', claw: { channels: [] }
    } as unknown as WorkWiseSettingsV2)
  })
  afterEach(async () => {
    window.dispatchEvent(new Event('beforeunload'))
    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each(['runtime_offline', 'timeout'])('recovers after an initial transient %s without a model request', async code => {
    const connect = vi.fn().mockRejectedValueOnce(new Error(JSON.stringify({ code, message: 'runtime is starting' }))).mockResolvedValue(undefined)
    const startTurn = vi.fn()
    mocks.getProvider.mockReturnValue({ connect, startTurn, getRuntimeInfo: vi.fn(async () => ({ capabilities: {} })) })
    const state = startupState()
    await state.boot()
    await vi.advanceTimersByTimeAsync(900)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(state.runtimeConnection).toBe('offline')
    await vi.advanceTimersByTimeAsync(1500)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(state.runtimeConnection).toBe('ready')
    expect(state.refreshThreads).toHaveBeenCalledOnce()
    expect(startTurn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it.each(['runtime_auth_required', 'runtime_port_conflict', 'missing_api_key', 'model_provider_unavailable'])('stops automatic probing for persistent %s', async code => {
    const connect = vi.fn().mockRejectedValue(new Error(JSON.stringify({ code, message: 'configuration requires attention' })))
    mocks.getProvider.mockReturnValue({ connect })
    const state = startupState()
    await state.boot()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(connect).toHaveBeenCalledOnce()
    expect(state.runtimeConnection).toBe('offline')
  })

  it('lets a manual probe replace startup work without a late failure overriding success', async () => {
    let failStartup!: (error: Error) => void
    const connect = vi.fn().mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { failStartup = reject })).mockResolvedValue(undefined)
    mocks.getProvider.mockReturnValue({ connect })
    const state = startupState()
    await state.boot()
    await vi.advanceTimersByTimeAsync(900)
    await state.probeRuntime('user')
    expect(state.runtimeConnection).toBe('ready')
    failStartup(new Error(JSON.stringify({ code: 'runtime_offline' })))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.runtimeConnection).toBe('ready')
    expect(state.error).toBeNull()
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('keeps local health and thread reads available for an existing profile without a model key', async () => {
    const runtimeRequest = vi.spyOn(rendererRuntimeClient, 'runtimeRequest').mockResolvedValue({ ok: true, status: 200, body: '{}' })
    mocks.getProvider.mockReturnValue(new WorkWiseRuntimeProvider())
    const state = startupState()
    await state.boot()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(state.runtimeConnection).toBe('ready')
    expect(state.refreshThreads).toHaveBeenCalledOnce()
    expect(runtimeRequest.mock.calls).toEqual([
      ['/health', 'GET'], ['/v1/threads?limit=1', 'GET'], ['/v1/runtime/info', 'GET']
    ])
  })
})

describe('chat-store-navigation-actions thread refresh races', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mocks.getProvider.mockReset()
    mocks.readWriteWorkspaceRoots.mockReset().mockResolvedValue([])
  })

  it('keeps an explicitly cleared workspace empty when starting another chat without rewriting old history', async () => {
    const previous = { ...engineeringThread('old', 'unused'), domain: undefined, projectId: undefined, workspace: '/Users/test/.workwise/default_workspace' }
    const settings = { workspaceRoot: '' } as WorkWiseSettingsV2
    const setSettings = vi.fn(async () => settings)
    vi.stubGlobal('window', { workwise: { setSettings } })
    vi.spyOn(rendererRuntimeClient, 'setSettings').mockImplementation(setSettings)
    vi.spyOn(rendererRuntimeClient, 'getSettings').mockResolvedValue(settings)
    mocks.getProvider.mockReturnValue({ listThreads: vi.fn(async () => [previous]) })
    const { state, sseAbortRef } = buildHarness([previous])
    const stream = new AbortController()
    sseAbortRef.current = stream
    state.route = 'chat'
    state.chooseWorkspace = vi.fn(async () => null)
    await state.clearWorkspace()
    expect(state.workspaceRoot).toBe('')
    expect(state.activeThreadId).toBeNull()
    expect(stream.signal.aborted).toBe(true)
    expect(state.threads[0]?.workspace).toBe(previous.workspace)
    await state.createThread()
    expect(state.chooseWorkspace).toHaveBeenCalledWith({ createThreadAfter: true })
    vi.unstubAllGlobals()
  })

  it.each([false, true])('keeps a newly created Survey conversation selected when an older refresh resumes (previous task: %s)', async (hasPreviousTask) => {
    const previous = engineeringThread('thr_previous', 'project_previous')
    const initialThreads = hasPreviousTask ? [previous] : []
    const created = engineeringThread('thr_created', 'project_created')
    const roots = deferred<string[]>()
    const rootsReadStarted = deferred<void>()
    mocks.readWriteWorkspaceRoots.mockImplementationOnce(() => {
      rootsReadStarted.resolve()
      return roots.promise
    })

    let registered = false
    mocks.getProvider.mockReturnValue({
      listThreads: vi.fn(async (options?: { projectId?: string }) => {
        if (options?.projectId === created.projectId) return registered ? [created] : []
        return registered ? [created, ...initialThreads] : initialThreads
      }),
      createThread: vi.fn(async () => { registered = true; return created }),
      getThreadDetail: vi.fn(async () => ({ blocks: [], latestSeq: 0, threadStatus: 'idle' })),
      subscribeThreadEvents: vi.fn(async () => undefined)
    })
    const { state, sseAbortRef } = buildHarness(initialThreads)

    const staleRefresh = state.refreshThreads()
    await rootsReadStarted.promise
    await expect(state.ensureEngineeringThread('project_created', '/workspace/survey')).resolves.toBe(created.id)
    expect(state.activeThreadId).toBe(created.id)
    const activeSubscription = sseAbortRef.current
    expect(activeSubscription).not.toBeNull()

    roots.resolve([])
    await staleRefresh
    expect(state.activeThreadId).toBe(created.id)
    expect(state.threads).toContainEqual(created)
    expect(activeSubscription?.signal.aborted).toBe(false)
    // The next ordinary list refresh must not be needed to recover this selection.
    await state.refreshThreads()

    expect(state.runtimeConnection).toBe('ready')
    expect(state.error).toBeNull()
    expect(state.activeThreadId).toBe(created.id)
    expect(state.threads).toContainEqual(created)
    expect(activeSubscription?.signal.aborted).toBe(false)
  })

  it('still removes a filtered internal code conversation and aborts its subscription', async () => {
    const hidden = { ...engineeringThread('thr_internal', 'unused'), domain: undefined, projectId: undefined, title: '__codex_parent_title__' }
    mocks.getProvider.mockReturnValue({ listThreads: vi.fn(async () => [hidden]) })
    const { state, sseAbortRef } = buildHarness([hidden])
    state.route = 'chat'
    const subscription = new AbortController()
    sseAbortRef.current = subscription

    await state.refreshThreads()

    expect(state.threads).toEqual([])
    expect(state.activeThreadId).toBeNull()
    expect(subscription.signal.aborted).toBe(true)
    expect(sseAbortRef.current).toBeNull()
  })

  it('still maps a Write conversation to its canonical workspace after reading the roots', async () => {
    const writing = { ...engineeringThread('thr_write', 'unused'), domain: undefined, projectId: undefined, title: 'Write Assistant', workspace: '/workspace/write/' }
    mocks.getProvider.mockReturnValue({ listThreads: vi.fn(async () => [writing]) })
    mocks.readWriteWorkspaceRoots.mockResolvedValue(['/workspace/write'])
    const { state, sseAbortRef } = buildHarness([writing])
    state.route = 'write'
    const subscription = new AbortController()
    sseAbortRef.current = subscription

    await state.refreshThreads()

    expect(state.threads).toEqual([{ ...writing, workspace: '/workspace/write' }])
    expect(state.activeThreadId).toBe(writing.id)
    expect(state.route).toBe('write')
    expect(subscription.signal.aborted).toBe(false)
  })
})
