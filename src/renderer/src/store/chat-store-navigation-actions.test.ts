import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedThread } from '../agent/types'
import type { ChatState, ChatStoreGet, ChatStoreSet } from './chat-store-types'

const mocks = vi.hoisted(() => ({
  getProvider: vi.fn(),
  readWriteWorkspaceRoots: vi.fn()
}))

vi.mock('../agent/registry', () => ({ getProvider: mocks.getProvider }))
vi.mock('./chat-store-runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('./chat-store-runtime')>(),
  readWriteWorkspaceRoots: mocks.readWriteWorkspaceRoots
}))

import { createNavigationActions } from './chat-store-navigation-actions'
import { createThreadActions } from './chat-store-thread-actions'

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

describe('chat-store-navigation-actions thread refresh races', () => {
  beforeEach(() => {
    mocks.getProvider.mockReset()
    mocks.readWriteWorkspaceRoots.mockReset().mockResolvedValue([])
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
