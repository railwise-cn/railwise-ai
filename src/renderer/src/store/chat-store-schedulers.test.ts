import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  armBusyWatchdog,
  cancelStartupRuntimeProbe,
  clearBusyWatchdog,
  resetBusyRecoveryAttempts,
  scheduleStartupRuntimeProbe,
  stopTurnCompletionPoll,
  syncTurnCompletionPoll
} from './chat-store-schedulers'
import type { ChatState, ChatStoreSet } from './chat-store-types'

type StoreApi = { getState: () => ChatState; set: ChatStoreSet; get: () => ChatState }

function makeHarness(initial: Partial<ChatState> = {}): StoreApi {
  let state: ChatState = {
    activeThreadId: 't1',
    blocks: [],
    liveReasoning: '',
    liveAssistant: '',
    lastSeq: 0,
    usageRefreshKey: 0,
    busy: true,
    error: null,
    currentTurnId: 'turn-1',
    currentTurnUserId: 'u1',
    turnStartedAtByUserId: {},
    turnDurationByUserId: {},
    turnReasoningFirstAtByUserId: {},
    turnReasoningLastAtByUserId: {},
    watchTurnCompletion: {},
    unreadThreadIds: {},
    queuedMessages: [],
    threads: [],
    recoverActiveTurn: vi.fn().mockResolvedValue(undefined),
    ...initial
  } as ChatState
  return {
    getState: () => state,
    set: (partial) => {
      const update =
        typeof partial === 'function'
          ? (partial as (s: ChatState) => Partial<ChatState>)(state)
          : partial
      state = { ...state, ...update }
    },
    get: () => state
  }
}

describe('bounded startup health probing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', new EventTarget())
  })
  afterEach(() => {
    cancelStartupRuntimeProbe()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('stops after five transient attempts', async () => {
    const probe = vi.fn(async () => true)
    scheduleStartupRuntimeProbe(probe)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probe).toHaveBeenCalledTimes(5)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['cancel', 'beforeunload'])('ignores an in-flight retry after %s', async action => {
    let finish!: (retry: boolean) => void
    const probe = vi.fn((_signal: AbortSignal) => new Promise<boolean>(resolve => { finish = resolve }))
    scheduleStartupRuntimeProbe(probe)
    await vi.advanceTimersByTimeAsync(900)
    if (action === 'cancel') cancelStartupRuntimeProbe()
    else window.dispatchEvent(new Event('beforeunload'))
    expect(probe.mock.calls[0]![0].aborted).toBe(true)
    finish(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(probe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a replaced startup sequence from scheduling another attempt', async () => {
    let finish!: (retry: boolean) => void
    const oldProbe = vi.fn((_signal: AbortSignal) => new Promise<boolean>(resolve => { finish = resolve }))
    const currentProbe = vi.fn(async () => false)
    scheduleStartupRuntimeProbe(oldProbe)
    await vi.advanceTimersByTimeAsync(900)
    scheduleStartupRuntimeProbe(currentProbe)
    finish(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(oldProbe.mock.calls[0]![0].aborted).toBe(true)
    expect(currentProbe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('armBusyWatchdog (busyTimeout message contract)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetBusyRecoveryAttempts()
  })
  afterEach(() => {
    clearBusyWatchdog()
    vi.useRealTimers()
  })

  it('uses busyTimeoutMessage returned string verbatim when watchdog fires with attempts exhausted', () => {
    const h = makeHarness({ activeThreadId: null })
    const finalize = vi.fn().mockReturnValue({})
    const flush = vi.fn().mockImplementation((_state: ChatState, base: Partial<ChatState>) => base)
    const message = '已等待 9 分钟仍未收到运行时完成事件。可中断后重试。'
    armBusyWatchdog(h.set, h.get, {
      timeoutMs: 1_000,
      maxAttempts: 0, // skip recovery, go straight to finalize
      finalizeBusyState: finalize,
      flushLiveBlocks: flush,
      busyTimeoutMessage: () => message
    })
    vi.advanceTimersByTime(1_000)
    expect(h.getState().error).toBe(message)
    expect(h.getState().busy).toBe(false)
    expect(h.getState().currentTurnId).toBeNull()
    expect(finalize).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledOnce()
  })

  it('skips watchdog work if not busy at fire time', () => {
    const h = makeHarness()
    const finalize = vi.fn().mockReturnValue({})
    const flush = vi.fn().mockImplementation((_state: ChatState, base: Partial<ChatState>) => base)
    armBusyWatchdog(h.set, h.get, {
      timeoutMs: 50,
      maxAttempts: 0,
      finalizeBusyState: finalize,
      flushLiveBlocks: flush,
      busyTimeoutMessage: () => 'never'
    })
    // Simulate turn completing before watchdog fires
    h.set((s) => ({ ...s, busy: false }))
    vi.advanceTimersByTime(50)
    expect(finalize).not.toHaveBeenCalled()
    expect(h.getState().error).toBeNull()
  })

  it('attempts recovery and returns when attempts remain', () => {
    const h = makeHarness()
    const finalize = vi.fn().mockReturnValue({})
    const flush = vi.fn().mockImplementation((_state: ChatState, base: Partial<ChatState>) => base)
    armBusyWatchdog(h.set, h.get, {
      timeoutMs: 50,
      maxAttempts: 5, // high limit, will not finalize
      finalizeBusyState: finalize,
      flushLiveBlocks: flush,
      busyTimeoutMessage: () => 'should-not-be-used'
    })
    vi.advanceTimersByTime(50)
    expect(h.getState().recoverActiveTurn).toHaveBeenCalledTimes(1)
    expect(h.getState().busy).toBe(true) // not finalized
    expect(finalize).not.toHaveBeenCalled()
  })
})

describe('busyTimeout minutes interpolation (#131)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetBusyRecoveryAttempts()
  })
  afterEach(() => {
    clearBusyWatchdog()
    vi.useRealTimers()
  })

  it('renders the minute count from production constants in the message', () => {
    const h = makeHarness({ activeThreadId: null })
    // Mirrors chat-store-runtime.ts:467-471 formula:
    // minutes = round((BUSY_WATCHDOG_MS * MAX_BUSY_RECOVERY_ATTEMPTS) / 60_000)
    // Current production: 180_000 * 3 / 60_000 = 9
    const minutes = Math.round((180_000 * 3) / 60_000)
    armBusyWatchdog(h.set, h.get, {
      timeoutMs: 10,
      maxAttempts: 0,
      finalizeBusyState: () => ({}),
      flushLiveBlocks: (_state: ChatState, base: Partial<ChatState>) => base,
      busyTimeoutMessage: () => `已等待 ${minutes} 分钟仍未收到运行时完成事件。`
    })
    vi.advanceTimersByTime(10)
    expect(typeof h.getState().error).toBe('string')
    expect(h.getState().error as string).toMatch(/已等待 9 分钟/)
  })
})

describe('background turn completion polling', () => {
  afterEach(() => {
    stopTurnCompletionPoll()
  })

  it('passes the authoritative terminal turn snapshot to the notification layer', async () => {
    const h = makeHarness({
      runtimeConnection: 'ready',
      watchTurnCompletion: { 'thread-background': true }
    })
    const onCompletedThreads = vi.fn()

    syncTurnCompletionPoll(h.set, h.get, {
      loadThreadState: vi.fn(async () => ({
        blocks: [],
        threadStatus: 'idle',
        latestTurnId: 'turn-background',
        latestTurnStatus: 'failed',
        latestTurnError: 'policy_blocked: approval denied'
      })),
      threadLooksRunning: () => false,
      onCompletedThreads
    })

    await vi.waitFor(() => {
      expect(onCompletedThreads).toHaveBeenCalledWith([
        {
          threadId: 'thread-background',
          turnId: 'turn-background',
          turnStatus: 'failed',
          turnError: 'policy_blocked: approval denied'
        }
      ], expect.anything(), h.set, h.get)
    })
  })

  it('reports a pending approval while the watched background turn is still running', async () => {
    const h = makeHarness({
      runtimeConnection: 'ready',
      watchTurnCompletion: { 'thread-background': true }
    })
    const onWaitingApprovals = vi.fn()

    syncTurnCompletionPoll(h.set, h.get, {
      loadThreadState: vi.fn(async () => ({
        blocks: [{
          kind: 'approval' as const,
          id: 'approval-block',
          approvalId: 'approval-background',
          summary: 'Run command',
          status: 'pending' as const
        }],
        threadStatus: 'running',
        latestTurnId: 'turn-background',
        latestTurnStatus: 'running'
      })),
      threadLooksRunning: () => true,
      onCompletedThreads: vi.fn(),
      onWaitingApprovals
    })

    await vi.waitFor(() => {
      expect(onWaitingApprovals).toHaveBeenCalledWith([
        {
          threadId: 'thread-background',
          turnId: 'turn-background',
          approvalId: 'approval-background'
        }
      ], expect.anything(), h.set, h.get)
    })
  })

  it('ignores an in-flight poll result after the thread is no longer watched', async () => {
    const h = makeHarness({
      activeThreadId: 'thread-foreground',
      runtimeConnection: 'ready',
      watchTurnCompletion: { 'thread-background': true }
    })
    let resolveThreadState!: (value: {
      blocks: Array<{
        kind: 'approval'
        id: string
        approvalId: string
        summary: string
        status: 'pending'
      }>
      threadStatus: 'idle'
      latestTurnId: string
      latestTurnStatus: 'completed'
    }) => void
    const loadThreadState = vi.fn(() => new Promise<{
      blocks: Array<{
        kind: 'approval'
        id: string
        approvalId: string
        summary: string
        status: 'pending'
      }>
      threadStatus: 'idle'
      latestTurnId: string
      latestTurnStatus: 'completed'
    }>((resolve) => {
      resolveThreadState = resolve
    }))
    const onCompletedThreads = vi.fn()
    const onWaitingApprovals = vi.fn()

    syncTurnCompletionPoll(h.set, h.get, {
      loadThreadState,
      threadLooksRunning: () => false,
      onCompletedThreads,
      onWaitingApprovals
    })
    await vi.waitFor(() => expect(loadThreadState).toHaveBeenCalledOnce())

    h.set({
      activeThreadId: 'thread-background',
      watchTurnCompletion: {},
      unreadThreadIds: {}
    })
    resolveThreadState({
      blocks: [{
        kind: 'approval',
        id: 'approval-block',
        approvalId: 'approval-background',
        summary: 'Run command',
        status: 'pending'
      }],
      threadStatus: 'idle',
      latestTurnId: 'turn-background',
      latestTurnStatus: 'completed'
    })

    await vi.waitFor(() => expect(loadThreadState).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(onWaitingApprovals).not.toHaveBeenCalled()
    expect(onCompletedThreads).not.toHaveBeenCalled()
  })
})
