import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyLiveUsageDelta } from './live-usage-projection'
import type { NormalizedThread } from '../agent/types'
import type {
  ChatState,
  ChatStoreGet,
  ChatStoreSet,
  GuiDesignMessageContext,
  GuiPlanMessageContext
} from './chat-store-types'
import { defaultManagedRuntimeSettings, type WorkWiseSettingsV2 } from '@shared/app-settings'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { DEEPSEEK_VISION_MODEL_ID } from '../lib/attachment-aware-model'

const registryMock = vi.hoisted(() => ({
  getProvider: vi.fn()
}))

vi.mock('../agent/registry', () => ({
  getProvider: registryMock.getProvider
}))

import { createThreadActions } from './chat-store-thread-actions'

function thread(id: string): NormalizedThread {
  return {
    id,
    title: id,
    updatedAt: '2026-06-09T00:00:00.000Z',
    model: 'deepseek-v4-pro',
    mode: 'agent',
    workspace: '/workspace/workwise',
    status: 'running'
  }
}

function buildHarness(): {
  actions: ReturnType<typeof createThreadActions>
  state: ChatState
} {
  let state: ChatState
  state = {
    activeThreadId: 'thr_existing',
    blocks: [],
    busy: true,
    clawChannels: [],
    composerModel: '',
    composerModelGroups: [],
    error: 'previous error',
    queuedMessages: [],
    recoverActiveTurn: vi.fn(async () => true),
    route: 'chat',
    runtimeConnection: 'ready',
    threads: [thread('thr_existing')]
  } as unknown as ChatState

  const set: ChatStoreSet = (partial) => {
    const update = typeof partial === 'function' ? partial(state) : partial
    Object.assign(state, update)
  }
  const get: ChatStoreGet = () => state
  const actions = createThreadActions({
    set,
    get,
    sseAbortRef: { current: null }
  })
  state.sendMessage = actions.sendMessage
  return { actions, state }
}

describe('chat-store-thread-actions queued messages', () => {
  it('pins provider identity at enqueue time for explicit and default selections', async () => {
    const settings = { agents: { kun: { ...defaultManagedRuntimeSettings(), providerId: 'provider-a' } }, provider: { providers: [{ id: 'provider-a', name: 'A', baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', endpointFormat: 'chat_completions', models: ['shared-model'] }], baseUrl: 'http://127.0.0.1:1/v1', apiKey: '' } } as unknown as WorkWiseSettingsV2
    vi.spyOn(rendererRuntimeClient, 'getSettings').mockResolvedValue(settings)
    const { actions, state } = buildHarness()
    state.composerModel = 'shared-model'
    state.composerProviderId = 'provider-b'
    expect(await actions.sendMessage('explicit', 'agent', { reasoningEffort: 'off' })).toBe(true)
    state.composerProviderId = undefined
    expect(await actions.sendMessage('default', 'agent')).toBe(true)
    state.composerProviderId = 'provider-c'
    expect(state.queuedMessages).toMatchObject([
      { text: 'explicit', model: 'shared-model', providerId: 'provider-b', reasoningEffort: 'off' },
      { text: 'default', model: 'shared-model', providerId: 'provider-a' }
    ])
    expect(await actions.sendMessage('explicit', 'agent', { queued: state.queuedMessages[0] })).toBe(true)
    expect(state.queuedMessages.at(-1)).toMatchObject({ providerId: 'provider-b', model: 'shared-model' })
  })
  beforeEach(() => {
    registryMock.getProvider.mockReset()
    registryMock.getProvider.mockReturnValue({})
    vi.restoreAllMocks()
  })

  it('passes the composer provider identity to the review action', async () => {
    const reviewThread = vi.fn(async () => ({ threadId: 'thr_existing', turnId: 'turn_review', reviewItemId: 'review_item' }))
    registryMock.getProvider.mockReturnValue({ reviewThread, subscribeThreadEvents: vi.fn(async () => undefined) })
    const { actions, state } = buildHarness()
    state.busy = false
    state.composerModel = 'shared-model'
    state.composerProviderId = 'compatible-b'
    state.lastSeq = 0
    state.refreshThreads = vi.fn(async () => undefined)
    const target = { kind: 'custom' as const, instructions: 'Review synthetic input.' }
    await expect(actions.reviewActiveThread(target)).resolves.toBe(true)
    expect(reviewThread).toHaveBeenCalledWith('thr_existing', target, { model: 'shared-model', providerId: 'compatible-b' })
  })

  it('stores the resolved vision model on queued auto image messages', async () => {
    vi.spyOn(rendererRuntimeClient, 'getSettings').mockResolvedValue({
      agents: {
        kun: {
          ...defaultManagedRuntimeSettings(),
          providerId: 'third-party'
        }
      },
      provider: {
        apiKey: '',
        baseUrl: 'https://third-party.example/v1',
        providers: [{
          id: 'third-party',
          name: 'Third Party',
          apiKey: 'sk-test',
          baseUrl: 'https://third-party.example/v1',
          endpointFormat: 'chat_completions',
          models: [DEEPSEEK_VISION_MODEL_ID]
        }]
      }
    } as unknown as WorkWiseSettingsV2)
    const { actions, state } = buildHarness()
    state.composerModel = 'auto'

    await expect(actions.sendMessage('describe this', 'agent', {
      attachmentIds: ['att_image'],
      attachments: [{ id: 'att_image', kind: 'image', mimeType: 'image/png' }]
    })).resolves.toBe(true)

    expect(state.queuedMessages).toEqual([
      expect.objectContaining({
        text: 'describe this',
        model: DEEPSEEK_VISION_MODEL_ID,
        attachmentIds: ['att_image']
      })
    ])
  })

  it('does not queue a default-auto image message when the active provider is unconfirmed', async () => {
    vi.spyOn(rendererRuntimeClient, 'getSettings').mockResolvedValue({
      agents: {
        kun: {
          ...defaultManagedRuntimeSettings(),
          providerId: 'deepseek',
          baseUrl: 'https://third-party.example/v1'
        }
      },
      provider: {
        apiKey: '',
        baseUrl: 'https://third-party.example/v1',
        providers: []
      }
    } as unknown as WorkWiseSettingsV2)
    const { actions, state } = buildHarness()
    state.composerModel = ''

    await expect(actions.sendMessage('describe this', 'agent', {
      attachmentIds: ['att_image'],
      attachments: [{ id: 'att_image', kind: 'image', mimeType: 'image/png' }]
    })).resolves.toBe(false)

    expect(state.queuedMessages).toEqual([])
    expect(state.error).toContain('provider is unavailable')
  })

  it('returns a recoverable failure when image routing settings cannot be read', async () => {
    vi.spyOn(rendererRuntimeClient, 'getSettings').mockRejectedValue(new Error('settings unavailable'))
    const { actions, state } = buildHarness()
    state.composerModel = 'auto'

    await expect(actions.sendMessage('describe this', 'agent', {
      attachmentIds: ['att_image'],
      attachments: [{ id: 'att_image', kind: 'image', mimeType: 'image/png' }]
    })).resolves.toBe(false)

    expect(state.queuedMessages).toEqual([])
    expect(state.error).toContain('settings unavailable')
  })

  it('routes the default empty composer selection as auto for a non-busy image send', async () => {
    vi.spyOn(rendererRuntimeClient, 'getSettings').mockResolvedValue({
      workspaceRoot: '/workspace/workwise',
      agents: {
        kun: {
          ...defaultManagedRuntimeSettings(),
          providerId: 'third-party'
        }
      },
      provider: {
        apiKey: '',
        baseUrl: 'https://third-party.example/v1',
        providers: [{
          id: 'third-party',
          name: 'Third Party',
          apiKey: 'sk-test',
          baseUrl: 'https://third-party.example/v1',
          endpointFormat: 'chat_completions',
          models: [DEEPSEEK_VISION_MODEL_ID]
        }]
      }
    } as unknown as WorkWiseSettingsV2)
    const sendUserMessage = vi.fn(async () => ({
      turnId: 'turn_image',
      userMessageItemId: 'item_image_user'
    }))
    registryMock.getProvider.mockReturnValue({
      sendUserMessage,
      subscribeThreadEvents: vi.fn(async () => undefined)
    })
    const { actions, state } = buildHarness()
    state.busy = false
    state.composerModel = ''
    state.lastSeq = 0
    state.currentTurnId = null
    state.currentTurnUserId = null
    state.turnStartedAtByUserId = {}
    state.turnDurationByUserId = {}
    state.turnReasoningFirstAtByUserId = {}
    state.turnReasoningLastAtByUserId = {}
    state.refreshThreads = vi.fn(async () => undefined)

    await expect(actions.sendMessage('describe this GIF', 'agent', {
      attachmentIds: ['att_gif'],
      attachments: [{ id: 'att_gif', kind: 'image', mimeType: 'image/gif' }]
    })).resolves.toBe(true)

    expect(sendUserMessage).toHaveBeenCalledWith(
      'thr_existing',
      expect.any(String),
      expect.objectContaining({
        model: DEEPSEEK_VISION_MODEL_ID,
        attachmentIds: ['att_gif']
      })
    )
  })

  it('does not queue GUI plan messages while another turn is active', async () => {
    const { actions, state } = buildHarness()
    const guiPlan: GuiPlanMessageContext = {
      operation: 'draft',
      workspaceRoot: '/workspace/workwise',
      relativePath: '.workwise/plans/feature.md',
      planId: 'plan-1',
      sourceRequest: 'feature'
    }

    await expect(actions.sendMessage('prompt one', 'plan', {
      displayText: 'Generate implementation plan',
      guiPlan
    })).resolves.toBe(false)

    expect(state.queuedMessages).toHaveLength(0)
    expect(state.error).toBeTruthy()
  })

  it('does not queue stale GUI Design messages while another turn is active', async () => {
    const { actions, state } = buildHarness()
    const guiDesign: GuiDesignMessageContext = {
      workspaceRoot: '/workspace/workwise',
      documentId: 'design-1',
      pageId: 'page-1',
      expectedRevision: 3
    }

    await expect(actions.sendMessage('internal canvas prompt', 'agent', {
      displayText: '把标题改成绿色',
      guiDesign
    })).resolves.toBe(false)

    expect(state.queuedMessages).toHaveLength(0)
    expect(state.error).toBeTruthy()
  })

  it('removes stale queued GUI plan messages before draining normal queued messages', async () => {
    const { actions, state } = buildHarness()
    const sendMessage = vi.fn(async (_text, _mode, overrides) => {
      state.queuedMessages = state.queuedMessages.filter((message) => message.id !== overrides?.queued?.id)
      return true
    })
    state.busy = false
    state.sendMessage = sendMessage as unknown as ChatState['sendMessage']
    state.queuedMessages = [
      {
        id: 'q-plan',
        text: 'internal plan prompt',
        mode: 'plan',
        guiPlan: {
          operation: 'draft',
          workspaceRoot: '/workspace/workwise',
          relativePath: '.workwise/plans/one.md',
          planId: 'plan-1'
        }
      },
      {
        id: 'q-user',
        text: 'normal follow-up',
        mode: 'agent'
      }
    ]

    await actions.drainQueuedMessages()

    expect(state.queuedMessages).toEqual([])
    expect(sendMessage).toHaveBeenCalledWith('normal follow-up', 'agent', {
      queued: expect.objectContaining({ id: 'q-user' })
    })
  })
})

describe('chat-store-thread-actions recovery', () => {
  beforeEach(() => {
    registryMock.getProvider.mockReset()
    vi.unstubAllGlobals()
  })

  it('projects a terminal snapshot that completed while the stream was disconnected', async () => {
    const showTurnCompleteNotification = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('window', { workwise: { showTurnCompleteNotification } })
    const provider = {
      getThreadDetail: vi.fn(async () => ({
        blocks: [],
        latestSeq: 42,
        threadStatus: 'idle',
        latestTurnId: 'turn-recovered',
        latestTurnStatus: 'failed',
        latestTurnError: 'network failed'
      })),
      subscribeThreadEvents: vi.fn(async () => undefined)
    }
    registryMock.getProvider.mockReturnValue(provider)
    const { actions, state } = buildHarness()
    state.currentTurnId = 'turn-recovered'
    state.currentTurnUserId = 'user-recovered'
    state.liveUsageByThreadId = {
      thr_existing: applyLiveUsageDelta(undefined, 'turn-recovered', 'partial output')
    }
    state.watchTurnCompletion = {}
    state.unreadThreadIds = {}
    state.turnStartedAtByUserId = {}
    state.turnDurationByUserId = {}
    state.turnReasoningFirstAtByUserId = {}
    state.turnReasoningLastAtByUserId = {}
    state.refreshThreads = vi.fn(async () => undefined)
    state.drainQueuedMessages = vi.fn(async () => undefined)

    await expect(actions.recoverActiveTurn()).resolves.toBe(false)

    expect(showTurnCompleteNotification).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thr_existing',
      turnId: 'turn-recovered',
      reason: 'error'
    }))
    expect(state.liveUsageByThreadId.thr_existing).toBeUndefined()
  })
})
