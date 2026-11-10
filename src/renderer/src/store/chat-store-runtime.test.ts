import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatBlock } from '../agent/types'
import {
  buildThreadEventSink,
  clearWatchedCompletionNotification,
  clearWatchedCompletionNotifications,
  clearPendingClawFeishuMirrors,
  completionNotificationDedupeKeyForWatchedThread,
  MAX_PENDING_CLAW_FEISHU_MIRRORS,
  MAX_WATCHED_COMPLETION_NOTIFICATIONS,
  isCodeThread,
  rememberPendingClawFeishuMirror,
  syncTurnCompletionPoll,
  takePendingClawFeishuMirror,
  watchTurnCompletionNotification
} from './chat-store-runtime'
import { stopTurnCompletionPoll } from './chat-store-schedulers'
import { applyLiveUsageDelta } from './live-usage-projection'
import { dispatchRuntimeEvent } from '../agent/runtime-mapper'
import type { CoreRuntimeEventJson } from '../agent/runtime-contract'
import type { ChatState, ChatStoreSet } from './chat-store-types'

const registryMock = vi.hoisted(() => ({ getProvider: vi.fn() }))
vi.mock('../agent/registry', () => ({ getProvider: registryMock.getProvider }))

function makeSinkHarness(overrides: Partial<ChatState> = {}): {
  getState: () => ChatState
  set: ChatStoreSet
  get: () => ChatState
} {
  let state = {
    activeThreadId: 'thread-current',
    blocks: [],
    liveReasoning: '',
    liveAssistant: '',
    lastSeq: 0,
    usageRefreshKey: 0,
    liveUsageByThreadId: {},
    busy: true,
    error: null,
    currentTurnId: 'turn-current',
    currentTurnUserId: 'user-current',
    turnStartedAtByUserId: { 'user-current': 1000 },
    turnDurationByUserId: {},
    turnReasoningFirstAtByUserId: {},
    turnReasoningLastAtByUserId: {},
    watchTurnCompletion: {},
    unreadThreadIds: {},
    queuedMessages: [],
    threads: [],
    refreshThreads: vi.fn(async () => undefined),
    drainQueuedMessages: vi.fn(async () => undefined)
  } as unknown as ChatState
  state = { ...state, ...overrides }
  const get = (): ChatState => state
  const set: ChatStoreSet = (partial) => {
    const patch = typeof partial === 'function' ? partial(state) : partial
    state = { ...state, ...patch }
  }
  return {
    getState: () => state,
    set,
    get
  }
}

afterEach(() => {
  stopTurnCompletionPoll()
  vi.unstubAllGlobals()
})

it.each([false,true])('replays coordinator receipt messages without changing execution state (running=%s)', async running => {
  const harness = makeSinkHarness({busy:running,currentTurnId:running?'real-turn':null,currentTurnUserId:running?'real-user':null})
  const sink = buildThreadEventSink(harness.set,harness.get,{threadId:'thread-current'})
  const turnId = `command_${'b'.repeat(32)}`
  for (const [kind,suffix,role,text] of [['user_message','user','user','帮我处理飞书审批'],['assistant_text','receipt','assistant','请安装连接器']]) {
    await dispatchRuntimeEvent({kind:'item_created',seq:2,timestamp:'2026-11-10T00:00:00Z',threadId:'thread-current',turnId,
      itemId:`item_${turnId}_${suffix}`,item:{kind,id:`item_${turnId}_${suffix}`,turnId,threadId:'thread-current',role,status:'completed',createdAt:'2026-11-10T00:00:00Z',text}
    } as CoreRuntimeEventJson,sink,async () => undefined)
  }
  const state = harness.getState()
  expect(state.blocks.map(block => block.kind)).toEqual(['user','assistant'])
  expect(state.busy).toBe(running)
  expect(state.currentTurnId).toBe(running?'real-turn':null)
  expect(state.currentTurnUserId).toBe(running?'real-user':null)
  expect(state.turnStartedAtByUserId).toEqual({'user-current':1000})
  expect(state.liveUsageByThreadId).toEqual({})
})

it('keeps legacy Write Assistant shells out of the Code session list', () => {
  expect(isCodeThread({
    id: 'thread-legacy-write',
    title: 'Write Assistant',
    workspace: '/workspace',
    model: 'deepseek-v4-pro',
    mode: 'agent',
    status: 'idle',
    updatedAt: '2026-09-04T00:00:00.000Z'
  })).toBe(false)
  expect(isCodeThread({
    id: 'thread-code',
    title: '真实编程会话',
    workspace: '/workspace',
    model: 'deepseek-v4-pro',
    mode: 'agent',
    status: 'idle',
    updatedAt: '2026-09-04T00:00:00.000Z'
  })).toBe(true)
})

it('clears live usage when a watched background thread completes', async () => {
  registryMock.getProvider.mockReturnValue({
    getThreadDetail: vi.fn(async () => ({
      blocks: [],
      threadStatus: 'idle',
      latestTurnId: 'turn-background',
      latestTurnStatus: 'completed'
    }))
  })
  vi.stubGlobal('window', { workwise: { showTurnCompleteNotification: vi.fn(async () => ({ ok: true })) } })
  const harness = makeSinkHarness({
    runtimeConnection: 'ready',
    activeThreadId: 'thread-current',
    watchTurnCompletion: { 'thread-background': true },
    liveUsageByThreadId: {
      'thread-background': applyLiveUsageDelta(undefined, 'turn-background', 'partial output')
    }
  })

  syncTurnCompletionPoll(harness.set, harness.get)

  await vi.waitFor(() => {
    expect(harness.getState().liveUsageByThreadId['thread-background']).toBeUndefined()
  })
})

describe('thread event sink binding', () => {
  it('projects tool-call character deltas without exposing argument text and ignores replay duplicates', () => {
    const initial = makeSinkHarness()
    const sink = buildThreadEventSink(initial.set, initial.get, { threadId: 'thread-current' })
    sink.onUsageDelta?.(12, 8, 'turn-current')
    sink.onUsageDelta?.(12, 8, 'turn-current')
    expect(initial.getState().liveUsageByThreadId['thread-current']).toMatchObject({ estimatedOutputCharacters: 12, estimatedOutputTokens: 3, exactTotalTokens: null })
  })

  it('keeps tool-call estimates after exact usage and projects only subsequent deltas', () => {
    const initial = makeSinkHarness()
    const sink = buildThreadEventSink(initial.set, initial.get, { threadId: 'thread-current' })
    sink.onUsageDelta?.(8, 8, 'turn-current')
    sink.onUsage?.({
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheMissTokens: 10,
      cacheHitRate: null,
      totalTokens: 12,
      costUsd: 0,
      costCny: null,
      cacheSavingsUsd: 0,
      cacheSavingsCny: null,
      tokenEconomySavingsTokens: 0,
      tokenEconomySavingsUsd: 0,
      tokenEconomySavingsCny: null,
      turns: 1
    }, 9)
    sink.onUsageDelta?.(4, 8, 'turn-current')
    sink.onUsageDelta?.(4, 10, 'turn-current')
    expect(initial.getState().liveUsageByThreadId['thread-current']).toMatchObject({
      estimatedOutputCharacters: 12,
      exactTotalTokens: 12,
      exactOutputTokens: 2
    })
  })

  it('ignores a stale exact usage snapshot that arrives after a newer delta', () => {
    const initial = makeSinkHarness()
    const sink = buildThreadEventSink(initial.set, initial.get, { threadId: 'thread-current' })
    sink.onUsageDelta?.(8, 10, 'turn-current')
    sink.onUsage?.({
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheMissTokens: 10,
      cacheHitRate: null,
      totalTokens: 12,
      costUsd: 0,
      costCny: null,
      cacheSavingsUsd: 0,
      cacheSavingsCny: null,
      tokenEconomySavingsTokens: 0,
      tokenEconomySavingsUsd: 0,
      tokenEconomySavingsCny: null,
      turns: 1
    }, 9, 'turn-current')
    const projection = initial.getState().liveUsageByThreadId['thread-current']
    expect(projection).toMatchObject({ estimatedOutputCharacters: 8, exactTotalTokens: null })
  })

  it('ignores exact usage from an older turn while a newer turn is active', () => {
    const initial = makeSinkHarness()
    const sink = buildThreadEventSink(initial.set, initial.get, { threadId: 'thread-current' })
    sink.onUsage?.({
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cachedTokens: 0,
      cacheMissTokens: 10,
      cacheHitRate: null,
      totalTokens: 12,
      costUsd: 0,
      costCny: null,
      cacheSavingsUsd: 0,
      cacheSavingsCny: null,
      tokenEconomySavingsTokens: 0,
      tokenEconomySavingsUsd: 0,
      tokenEconomySavingsCny: null,
      turns: 1
    }, 9, 'turn-old')
    expect(initial.getState().liveUsageByThreadId['thread-current']).toBeUndefined()
  })

  it('projects attachment evidence status onto the matching user attachment', () => {
    const initial = makeSinkHarness({
      blocks: [{
        kind: 'user',
        id: 'user-current',
        text: 'inspect these images',
        meta: {
          attachments: [
            { id: 'att-ready', state: 'parsing' },
            { id: 'att-failed', state: 'parsing' }
          ]
        }
      }]
    })
    const sink = buildThreadEventSink(initial.set, initial.get, { threadId: 'thread-current' })

    sink.onAttachmentEvidence?.({
      attachmentId: 'att-ready',
      status: 'ready',
      createdAt: '2026-08-18T00:00:00.000Z'
    })
    sink.onAttachmentEvidence?.({
      attachmentId: 'att-failed',
      status: 'failed',
      createdAt: '2026-08-18T00:00:01.000Z',
      message: 'analysis unavailable'
    })

    const user = initial.getState().blocks[0]
    expect(user?.kind).toBe('user')
    if (user?.kind !== 'user') return
    expect(user.meta?.attachments).toEqual([
      { id: 'att-ready', state: 'ready' },
      { id: 'att-failed', state: 'degraded', degradationReasons: ['analysis unavailable'] }
    ])
  })

  it('seeds initial terminal history without notifying, then notifies for a new live turn', () => {
    const showTurnCompleteNotification = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', {
      workwise: {
        showTurnCompleteNotification,
        mirrorClawChannelMessage: vi.fn(async () => undefined)
      }
    })
    const shared = {
      activeThreadId: 'thread-current',
      threads: [{ id: 'thread-current', title: 'Current thread' }],
      refreshThreads: vi.fn(async () => undefined),
      drainQueuedMessages: vi.fn(async () => undefined),
      queuedMessages: []
    } as unknown as Partial<ChatState>
    const initial = makeSinkHarness({
      ...shared,
      busy: false,
      currentTurnId: null,
      currentTurnUserId: null,
      lastSeq: 100
    })

    buildThreadEventSink(initial.set, initial.get, {
      threadId: 'thread-current',
      sinceSeq: 100
    }).onTurnComplete({
      reason: 'completed',
      threadId: 'thread-current',
      turnId: 'historical-turn'
    })

    expect(showTurnCompleteNotification).not.toHaveBeenCalled()

    const live = makeSinkHarness({
      ...shared,
      busy: true,
      currentTurnId: 'live-turn',
      currentTurnUserId: 'live-user',
      blocks: [{ kind: 'user', id: 'live-user', text: 'new request' }]
    })
    buildThreadEventSink(live.set, live.get, {
      threadId: 'thread-current',
      sinceSeq: 100
    }).onTurnComplete({
      reason: 'completed',
      threadId: 'thread-current',
      turnId: 'live-turn'
    })

    expect(showTurnCompleteNotification).toHaveBeenCalledTimes(1)
    expect(showTurnCompleteNotification).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-current',
      turnId: 'live-turn',
      reason: 'completed'
    }))
  })

  it('dedupes terminal notifications by thread and turn together', () => {
    const showTurnCompleteNotification = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', { workwise: { showTurnCompleteNotification } })
    for (const threadId of ['thread-a', 'thread-b']) {
      const harness = makeSinkHarness({
        activeThreadId: threadId,
        currentTurnId: 'shared-turn',
        currentTurnUserId: `user-${threadId}`,
        threads: [{ id: threadId, title: threadId }] as ChatState['threads']
      })
      buildThreadEventSink(harness.set, harness.get, { threadId }).onTurnComplete({
        reason: 'completed',
        threadId,
        turnId: 'shared-turn'
      })
    }

    expect(showTurnCompleteNotification).toHaveBeenCalledTimes(2)
  })

  it.each([
    'completed',
    'error',
    'aborted',
    'blocked',
    'max_tokens'
  ] as const)('projects the %s terminal reason through the real notification entry point', (reason) => {
    const showTurnCompleteNotification = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', { workwise: { showTurnCompleteNotification } })
    const threadId = `thread-terminal-${reason}`
    const turnId = `turn-terminal-${reason}`
    const harness = makeSinkHarness({
      activeThreadId: threadId,
      currentTurnId: turnId,
      currentTurnUserId: `user-terminal-${reason}`,
      blocks: [{ kind: 'user', id: `user-terminal-${reason}`, text: 'run' }],
      threads: [{ id: threadId, title: `Terminal ${reason}` }] as ChatState['threads']
    })

    const sink = buildThreadEventSink(harness.set, harness.get, { threadId })
    if (reason === 'completed' || reason === 'aborted') {
      sink.onTurnComplete({ reason, threadId, turnId })
    } else {
      sink.onError(new Error(`terminal ${reason}`), {
        terminal: true,
        terminalReason: reason,
        threadId,
        turnId
      })
    }

    expect(showTurnCompleteNotification).toHaveBeenCalledTimes(1)
    expect(showTurnCompleteNotification).toHaveBeenCalledWith(expect.objectContaining({
      threadId,
      turnId,
      reason
    }))
  })

  it('does not label a selected thread active when another route is visible', () => {
    const showTurnCompleteNotification = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', { workwise: { showTurnCompleteNotification } })
    const harness = makeSinkHarness({
      activeThreadId: 'thread-current',
      route: 'settings',
      currentTurnId: 'route-turn',
      threads: [{ id: 'thread-current', title: 'Current' }] as ChatState['threads']
    })

    buildThreadEventSink(harness.set, harness.get, { threadId: 'thread-current' }).onTurnComplete({
      reason: 'completed',
      threadId: 'thread-current',
      turnId: 'route-turn'
    })

    expect(showTurnCompleteNotification).toHaveBeenCalledWith(expect.objectContaining({
      activeThread: false
    }))
  })

  it('clears completed-turn TPS and resets projection when a new turn starts', () => {
    const harness = makeSinkHarness({
      liveUsageByThreadId: {
        'thread-current': {
          turnId: 'turn-current',
          estimatedOutputCharacters: 8,
          estimatedOutputTokens: 2,
          estimatedOutputTokensAtExactUsage: null,
          exactUsageSeq: null,
          exactTotalTokens: null,
          exactOutputTokens: null,
          firstOutputAt: 1_000,
          lastOutputAt: 2_000,
          tokensPerSecond: 2
        }
      }
    })
    const sink = buildThreadEventSink(harness.set, harness.get, { threadId: 'thread-current' })

    sink.onTurnComplete({ threadId: 'thread-current', turnId: 'turn-current' })
    expect(harness.getState().liveUsageByThreadId['thread-current']).toBeUndefined()

    harness.set({ busy: true, currentTurnId: null })
    sink.onUserMessage({ itemId: 'user-next', turnId: 'turn-next', text: 'next' })
    expect(harness.getState().liveUsageByThreadId['thread-current']).toMatchObject({
      turnId: 'turn-next',
      estimatedOutputTokens: 0,
      tokensPerSecond: null
    })
  })

  it('resets stale usage when the next turn id was assigned before user replay', () => {
    const harness = makeSinkHarness({
      currentTurnId: 'turn-next',
      liveUsageByThreadId: {
        'thread-current': applyLiveUsageDelta(undefined, 'turn-old', 'old output')
      }
    })
    const sink = buildThreadEventSink(harness.set, harness.get, { threadId: 'thread-current' })

    sink.onUserMessage({ itemId: 'user-next', turnId: 'turn-next', text: 'next' })

    expect(harness.getState().liveUsageByThreadId['thread-current']).toMatchObject({
      turnId: 'turn-next',
      estimatedOutputTokens: 0,
      tokensPerSecond: null
    })
  })

  it.each([
    ['completed', (sink: ReturnType<typeof buildThreadEventSink>) => sink.onTurnComplete({
      reason: 'completed', threadId: 'thread-current', turnId: 'turn-old'
    })],
    ['aborted', (sink: ReturnType<typeof buildThreadEventSink>) => sink.onTurnComplete({
      reason: 'aborted', threadId: 'thread-current', turnId: 'turn-old'
    })],
    ['failed', (sink: ReturnType<typeof buildThreadEventSink>) => sink.onError(
      new Error('old turn failed'),
      { terminal: true, threadId: 'thread-current', turnId: 'turn-old' }
    )]
  ])('does not let an old %s event settle the current turn', (_kind, emit) => {
    const initial = makeSinkHarness({
      busy: true,
      currentTurnId: 'turn-current',
      currentTurnUserId: 'user-current',
      liveAssistant: 'current answer',
      liveReasoning: 'current reasoning',
      blocks: [{ kind: 'user', id: 'user-current', text: 'current request' }],
      watchTurnCompletion: { 'thread-current': true },
      unreadThreadIds: { 'thread-current': true }
    })

    emit(buildThreadEventSink(initial.set, initial.get, { threadId: 'thread-current' }))

    expect(initial.getState()).toMatchObject({
      busy: true,
      currentTurnId: 'turn-current',
      currentTurnUserId: 'user-current',
      liveAssistant: 'current answer',
      liveReasoning: 'current reasoning',
      error: null,
      watchTurnCompletion: { 'thread-current': true },
      unreadThreadIds: { 'thread-current': true }
    })
  })

  it('ignores reasoning deltas from a stream bound to a different active thread', () => {
    const { getState, set, get } = makeSinkHarness({ activeThreadId: 'thread-new' })
    const controller = new AbortController()
    const sink = buildThreadEventSink(set, get, {
      threadId: 'thread-old',
      signal: controller.signal
    })

    sink.onDeltas([{ kind: 'agent_reasoning', text: 'old reasoning', seq: 7 }])

    expect(getState().liveReasoning).toBe('')
    expect(getState().lastSeq).toBe(0)
  })

  it('ignores queued callbacks after a stream has been aborted', () => {
    const { getState, set, get } = makeSinkHarness({
      activeThreadId: 'thread-current',
      liveReasoning: 'current reasoning'
    })
    const controller = new AbortController()
    const sink = buildThreadEventSink(set, get, {
      threadId: 'thread-current',
      signal: controller.signal
    })

    controller.abort()
    sink.onDeltas([{ kind: 'agent_reasoning', text: 'late old reasoning', seq: 8 }])
    sink.onTurnComplete()

    expect(getState().liveReasoning).toBe('current reasoning')
    expect(getState().blocks).toEqual([])
    expect(getState().busy).toBe(true)
  })

  it('accepts reasoning deltas from the current active stream', () => {
    const { getState, set, get } = makeSinkHarness({ activeThreadId: 'thread-current' })
    const controller = new AbortController()
    const sink = buildThreadEventSink(set, get, {
      threadId: 'thread-current',
      signal: controller.signal
    })

    sink.onDeltas([{ kind: 'agent_reasoning', text: 'fresh reasoning', seq: 9 }])

    expect(getState().liveReasoning).toBe('fresh reasoning')
    expect(getState().lastSeq).toBe(9)
    expect(getState().turnReasoningFirstAtByUserId['user-current']).toEqual(expect.any(Number))
  })

  it('drops replayed deltas at or below the subscription floor', () => {
    const { getState, set, get } = makeSinkHarness({ activeThreadId: 'thread-current', lastSeq: 100 })
    const sink = buildThreadEventSink(set, get, {
      threadId: 'thread-current',
      sinceSeq: 100
    })

    sink.onDeltas([
      { kind: 'agent_message', text: 'replayed history', seq: 90 },
      { kind: 'agent_message', text: 'fresh answer', seq: 101 }
    ])

    expect(getState().liveAssistant).toBe('fresh answer')
    expect(getState().lastSeq).toBe(101)
  })

  it('drops duplicate delta seqs across batches', () => {
    const { getState, set, get } = makeSinkHarness({ activeThreadId: 'thread-current' })
    const sink = buildThreadEventSink(set, get, { threadId: 'thread-current' })

    sink.onDeltas([{ kind: 'agent_message', text: 'hello', seq: 11 }])
    sink.onDeltas([{ kind: 'agent_message', text: 'hello', seq: 11 }])
    sink.onDeltas([{ kind: 'agent_message', text: ' world', seq: 12 }])

    expect(getState().liveAssistant).toBe('hello world')
  })

  it('does not count tool snapshots as generated model output', () => {
    const { getState, set, get } = makeSinkHarness({ activeThreadId: 'thread-current' })
    const sink = buildThreadEventSink(set, get, { threadId: 'thread-current' })
    const tool = {
      itemId: 'tool-1',
      summary: 'read_file',
      status: 'running' as const,
      detail: 'package.json'
    }

    sink.onTool(tool)
    sink.onTool(tool)

    expect(getState().liveUsageByThreadId['thread-current']).toBeUndefined()
  })

  it('never rewinds lastSeq when a stale heartbeat seq arrives', () => {
    const { getState, set, get } = makeSinkHarness({ activeThreadId: 'thread-current', lastSeq: 500 })
    const sink = buildThreadEventSink(set, get, { threadId: 'thread-current' })

    sink.onSeq(3)

    expect(getState().lastSeq).toBe(500)
  })

  it('keeps a 10,000-delta long session bounded and ignores replayed history', () => {
    const { getState, set, get } = makeSinkHarness({ activeThreadId: 'thread-current' })
    const sink = buildThreadEventSink(set, get, { threadId: 'thread-current' })
    const totalDeltas = 10_000
    const batchSize = 100
    const startedAt = performance.now()

    for (let offset = 0; offset < totalDeltas; offset += batchSize) {
      sink.onDeltas(Array.from({ length: batchSize }, (_, index) => ({
        kind: 'agent_message' as const,
        text: 'abcd',
        seq: offset + index + 1
      })))
    }

    const elapsedMs = performance.now() - startedAt
    const settled = getState()
    expect(settled.liveAssistant).toBe('abcd'.repeat(totalDeltas))
    expect(settled.lastSeq).toBe(totalDeltas)
    expect(settled.liveUsageByThreadId['thread-current']).toMatchObject({
      turnId: 'turn-current',
      estimatedOutputTokens: totalDeltas
    })
    expect(elapsedMs).toBeLessThan(2_000)

    sink.onDeltas(Array.from({ length: batchSize }, (_, index) => ({
      kind: 'agent_message' as const,
      text: 'duplicate',
      seq: totalDeltas - batchSize + index + 1
    })))

    expect(getState()).toBe(settled)
  })
})

describe('thread event sink runtime errors', () => {
  it('adds runtime error events to the timeline with details', () => {
    const { getState, set, get } = makeSinkHarness({
      activeThreadId: 'thread-current',
      busy: true,
      blocks: [{ kind: 'user', id: 'user-current', text: 'hello' }]
    })
    const sink = buildThreadEventSink(set, get, { threadId: 'thread-current' })

    sink.onRuntimeError?.({
      itemId: 'error-1',
      createdAt: '2026-06-08T00:00:00.000Z',
      message: 'Authorization: Bearer secret-token failed',
      code: 'provider_unavailable',
      details: { token: 'secret-token' },
      severity: 'error'
    })
    sink.onRuntimeError?.({
      itemId: 'error-1',
      createdAt: '2026-06-08T00:00:00.000Z',
      message: 'Authorization: Bearer secret-token failed again',
      code: 'provider_unavailable',
      severity: 'error'
    })

    const systemBlocks = getState().blocks.filter((block) => block.kind === 'system')
    expect(systemBlocks).toHaveLength(1)
    expect(systemBlocks[0]).toMatchObject({
      kind: 'system',
      id: 'error-1',
      code: 'provider_unavailable',
      severity: 'error'
    })
    expect(systemBlocks[0].text).toContain('<redacted>')
    expect(systemBlocks[0].detail).not.toContain('secret-token')
  })

  it('does not keep an aborted turn busy after interrupt', () => {
    const blocks: ChatBlock[] = [
      { kind: 'user', id: 'user-1', text: 'run command' },
      {
        kind: 'tool',
        id: 'tool-1',
        summary: 'Running command',
        status: 'running',
        toolKind: 'command_execution'
      }
    ]
    const state = {
      activeThreadId: 'thr-1',
      blocks,
      busy: true,
      currentTurnId: 'turn-1',
      currentTurnUserId: 'user-1',
      error: null,
      liveAssistant: '',
      liveReasoning: '',
      turnStartedAtByUserId: { 'user-1': Date.now() - 1000 },
      turnDurationByUserId: {},
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {}
    } as unknown as ChatState
    const set = (partial: Partial<ChatState> | ((value: ChatState) => Partial<ChatState>)): void => {
      Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
    }

    buildThreadEventSink(set, () => state).onError(new Error('turn aborted'))

    expect(state.busy).toBe(false)
    expect(state.currentTurnId).toBeNull()
    expect(state.currentTurnUserId).toBeNull()
    expect(state.error).toBeNull()
    expect(state.blocks.map((block) => ('status' in block ? block.status : block.kind))).toEqual([
      'user',
      'error'
    ])
  })

  it('settles terminal turn failures instead of keeping the composer busy', () => {
    const blocks: ChatBlock[] = [
      { kind: 'user', id: 'user-1', text: 'work toward goal' },
      {
        kind: 'tool',
        id: 'tool-1',
        summary: 'Running command',
        status: 'running',
        toolKind: 'command_execution'
      }
    ]
    const state = {
      activeThreadId: 'thr-1',
      blocks,
      busy: true,
      currentTurnId: 'turn-1',
      currentTurnUserId: 'user-1',
      error: null,
      runtimeErrorDetail: null,
      liveAssistant: '',
      liveReasoning: '',
      turnStartedAtByUserId: { 'user-1': Date.now() - 1000 },
      turnDurationByUserId: {},
      turnReasoningFirstAtByUserId: {},
      turnReasoningLastAtByUserId: {},
      watchTurnCompletion: { 'thr-1': true },
      unreadThreadIds: { 'thr-1': true },
      queuedMessages: []
    } as unknown as ChatState
    const set = (partial: Partial<ChatState> | ((value: ChatState) => Partial<ChatState>)): void => {
      Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
    }

    buildThreadEventSink(set, () => state).onError(
      new Error(JSON.stringify({
        code: 'http_400',
        message: 'model stream exploded',
        severity: 'error'
      })),
      { terminal: true }
    )

    expect(state.busy).toBe(false)
    expect(state.currentTurnId).toBeNull()
    expect(state.currentTurnUserId).toBeNull()
    expect(state.error).toBe('model stream exploded')
    expect(state.runtimeErrorDetail).toContain('Code: http_400')
    expect(state.watchTurnCompletion).toEqual({})
    expect(state.unreadThreadIds).toEqual({})
    expect(state.blocks.map((block) => ('status' in block ? block.status : block.kind))).toEqual([
      'user',
      'error'
    ])
  })
})

describe('pending Claw Feishu mirrors', () => {
  afterEach(() => {
    clearPendingClawFeishuMirrors()
  })

  it('normalizes pending mirror fields before storing', () => {
    rememberPendingClawFeishuMirror(' turn-1 ', {
      threadId: ' thread-1 ',
      userBlockId: ' user-1 ',
      userText: ' hello '
    })

    expect(takePendingClawFeishuMirror('turn-1')).toEqual({
      threadId: 'thread-1',
      userBlockId: 'user-1',
      userText: 'hello'
    })
  })

  it('ignores invalid pending mirrors', () => {
    rememberPendingClawFeishuMirror('', {
      threadId: 'thread-1',
      userBlockId: 'user-1',
      userText: 'hello'
    })
    rememberPendingClawFeishuMirror('turn-2', {
      threadId: ' ',
      userBlockId: 'user-2',
      userText: 'hello'
    })
    rememberPendingClawFeishuMirror('turn-3', {
      threadId: 'thread-3',
      userBlockId: 'user-3',
      userText: ' '
    })

    expect(takePendingClawFeishuMirror('')).toBeUndefined()
    expect(takePendingClawFeishuMirror('turn-2')).toBeUndefined()
    expect(takePendingClawFeishuMirror('turn-3')).toBeUndefined()
  })

  it('caps pending mirrors and keeps the latest turns', () => {
    for (let index = 0; index < MAX_PENDING_CLAW_FEISHU_MIRRORS + 5; index += 1) {
      rememberPendingClawFeishuMirror(`turn-${index}`, {
        threadId: `thread-${index}`,
        userBlockId: `user-${index}`,
        userText: `hello-${index}`
      })
    }

    expect(takePendingClawFeishuMirror('turn-0')).toBeUndefined()
    expect(takePendingClawFeishuMirror('turn-4')).toBeUndefined()
    expect(takePendingClawFeishuMirror('turn-5')).toEqual({
      threadId: 'thread-5',
      userBlockId: 'user-5',
      userText: 'hello-5'
    })
    expect(takePendingClawFeishuMirror(`turn-${MAX_PENDING_CLAW_FEISHU_MIRRORS + 4}`)).toEqual({
      threadId: `thread-${MAX_PENDING_CLAW_FEISHU_MIRRORS + 4}`,
      userBlockId: `user-${MAX_PENDING_CLAW_FEISHU_MIRRORS + 4}`,
      userText: `hello-${MAX_PENDING_CLAW_FEISHU_MIRRORS + 4}`
    })
  })

  it('removes a pending mirror when taking it', () => {
    rememberPendingClawFeishuMirror('turn-1', {
      threadId: 'thread-1',
      userBlockId: 'user-1',
      userText: 'hello'
    })

    expect(takePendingClawFeishuMirror(' turn-1 ')).toEqual({
      threadId: 'thread-1',
      userBlockId: 'user-1',
      userText: 'hello'
    })
    expect(takePendingClawFeishuMirror('turn-1')).toBeUndefined()
  })
})

describe('watched completion notifications', () => {
  afterEach(() => {
    clearWatchedCompletionNotifications()
  })

  it('normalizes watched thread ids before storing and clearing', () => {
    watchTurnCompletionNotification(' thread-1 ', 1000)

    expect(completionNotificationDedupeKeyForWatchedThread('thread-1', 2000)).toBe('watch:thread-1:1000')

    clearWatchedCompletionNotification(' thread-1 ')

    expect(completionNotificationDedupeKeyForWatchedThread('thread-1', 2000)).toBe('watch:thread-1:2000')
  })

  it('ignores empty watched thread ids', () => {
    watchTurnCompletionNotification(' ', 1000)

    expect(completionNotificationDedupeKeyForWatchedThread('', 2000)).toBe('watch:unknown:2000')
  })

  it('caps watched completion notifications and keeps the latest thread watches', () => {
    for (let index = 0; index < MAX_WATCHED_COMPLETION_NOTIFICATIONS + 5; index += 1) {
      watchTurnCompletionNotification(`thread-${index}`, index)
    }

    expect(completionNotificationDedupeKeyForWatchedThread('thread-0', 999)).toBe('watch:thread-0:999')
    expect(completionNotificationDedupeKeyForWatchedThread('thread-4', 999)).toBe('watch:thread-4:999')
    expect(completionNotificationDedupeKeyForWatchedThread('thread-5', 999)).toBe('watch:thread-5:5')
    expect(
      completionNotificationDedupeKeyForWatchedThread(`thread-${MAX_WATCHED_COMPLETION_NOTIFICATIONS + 4}`, 999)
    ).toBe(`watch:thread-${MAX_WATCHED_COMPLETION_NOTIFICATIONS + 4}:${MAX_WATCHED_COMPLETION_NOTIFICATIONS + 4}`)
  })

  it('refreshes existing watched threads as the most recent entry', () => {
    watchTurnCompletionNotification('thread-0', 0)
    for (let index = 1; index < MAX_WATCHED_COMPLETION_NOTIFICATIONS; index += 1) {
      watchTurnCompletionNotification(`thread-${index}`, index)
    }
    watchTurnCompletionNotification('thread-0', 1000)
    watchTurnCompletionNotification(`thread-${MAX_WATCHED_COMPLETION_NOTIFICATIONS}`, 2000)

    expect(completionNotificationDedupeKeyForWatchedThread('thread-1', 999)).toBe('watch:thread-1:999')
    expect(completionNotificationDedupeKeyForWatchedThread('thread-0', 999)).toBe('watch:thread-0:1000')
  })
})
