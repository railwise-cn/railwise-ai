import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type AppSettingsV1,
  type ClawImChannelV1,
  type ClawImConversationV1
} from '../shared/app-settings'
import {
  createClawRuntime,
  FEISHU_HANDSHAKE_TIMEOUT_MS,
  FEISHU_PING_TIMEOUT_SECONDS,
  feishuWebSocketReliabilityOptions,
  resolveImResponseTimeoutMs
} from './claw-runtime'
import { ImDeliveryLedger } from './services/im-delivery-ledger'
import {
  IM_LEDGER_LEASE_RENEW_INTERVAL_MS,
  IM_LEDGER_PROVIDER_DELIVERY_LEASE_MS
} from '../shared/im-communication'

function deliveryOperationStubs(record: () => { id: string; provider: string; chatId: string }) {
  const operations = new Map<string, { operationId: string; recordId: string; phase: string; requestHash: string; status: string; remoteOperationId?: string }>()
  return {
    getById: vi.fn(record),
    deliveryOperation: vi.fn((id: string) => operations.get(id)),
    beginDeliveryOperation: vi.fn((recordId: string, operationId: string, phase: string, requestHash: string) => {
      const existing = operations.get(operationId)
      if (existing) return { operation: existing, created: false }
      const operation = { operationId, recordId, phase, requestHash, status: 'started' }
      operations.set(operationId, operation)
      return { operation, created: true }
    }),
    finishDeliveryOperation: vi.fn((id: string, status: string, remoteOperationId?: string) => {
      const operation = { ...operations.get(id)!, status, remoteOperationId }
      operations.set(id, operation)
      return operation
    }),
    pendingRuntimeObservations: vi.fn(() => []),
    acknowledgeRuntimeObservation: vi.fn(),
    markDeliveryUnknown: vi.fn()
  }
}

function buildSettings(): AppSettingsV1 {
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 'small',
    provider: defaultModelProviderSettings(),
    agents: {
      kun: defaultManagedRuntimeSettings()
    },
    workspaceRoot: '/tmp/workspace',
    log: { enabled: true, retentionDays: 7 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    schedule: defaultScheduleSettings(),
    claw: {
      ...defaultClawSettings(),
      enabled: true,
      tasks: [
        {
          id: 'task_1',
          title: 'Task 1',
          enabled: true,
          prompt: 'Summarize changes',
          workspaceRoot: '/tmp/workspace',
          model: 'auto',
          reasoningEffort: 'medium',
          mode: 'agent',
          schedule: { kind: 'manual', everyMinutes: 60, timeOfDay: '09:00', atTime: '' },
          createdAt: '2026-06-02T00:00:00.000Z',
          updatedAt: '2026-06-02T00:00:00.000Z',
          lastRunAt: '',
          nextRunAt: '',
          lastStatus: 'idle',
          lastMessage: '',
          lastThreadId: ''
        }
      ]
    },
    guiUpdate: { channel: 'stable' },
    codePromptPrefix: ''
  }
}

function buildConversation(overrides: Partial<ClawImConversationV1> = {}): ClawImConversationV1 {
  return {
    id: 'conv_1',
    chatId: 'oc_chat_a',
    remoteThreadId: '',
    latestMessageId: 'om_previous',
    senderId: 'ou_1',
    senderName: 'Alice',
    localThreadId: 'thr_old',
    workspaceRoot: '/tmp/workspace/conversations/oc_chat_a',
    createdAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    ...overrides
  }
}

function buildChannel(overrides: Partial<ClawImChannelV1> = {}): ClawImChannelV1 {
  return {
    id: 'channel_1',
    provider: 'feishu' as const,
    label: 'Phone',
    enabled: true,
    model: 'auto',
    threadId: 'thr_old',
    workspaceRoot: '/tmp/workspace',
    agentProfile: {
      name: 'kun',
      description: '',
      identity: '',
      personality: '',
      userContext: '',
      replyRules: ''
    },
    conversations: [],
    // Most tests model an already-greeted channel; welcome tests reset
    // this to '' to exercise the first-contact intro.
    welcomeSentAt: '2026-06-02T00:00:00.000Z',
    createdAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    ...overrides
  }
}

function mutableSettingsStore(initialSettings: AppSettingsV1): {
  current: () => AppSettingsV1
  store: {
    load: ReturnType<typeof vi.fn>
    patch: ReturnType<typeof vi.fn>
  }
} {
  let currentSettings = initialSettings
  const store = {
    load: vi.fn(async () => currentSettings),
    patch: vi.fn(async (partial: Partial<AppSettingsV1>) => {
      currentSettings = {
        ...currentSettings,
        ...partial,
        claw: partial.claw
          ? {
              ...currentSettings.claw,
              ...partial.claw,
              im: partial.claw.im
                ? { ...currentSettings.claw.im, ...partial.claw.im }
                : currentSettings.claw.im
            }
          : currentSettings.claw
      }
      return currentSettings
    })
  }
  return { current: () => currentSettings, store }
}

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return (server.address() as AddressInfo).port
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function postRuntimeWebhook(
  runtime: ReturnType<typeof createClawRuntime>,
  url: string,
  payload: Record<string, unknown>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = JSON.stringify(payload)
  const req = {
    method: 'POST',
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body)
    }
  }
  let status = 0
  let responseBody = ''
  const res = {
    writeHead: vi.fn((nextStatus: number) => {
      status = nextStatus
    }),
    end: vi.fn((nextBody: string) => {
      responseBody = nextBody
    })
  }
  await (runtime as unknown as {
    handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
  }).handleWebhook(req, res)
  return { status, body: JSON.parse(responseBody) as Record<string, unknown> }
}

describe('ClawRuntime', () => {
  it('rebinds to a changed IM port instead of reusing the candidate reservation', async () => {
    const reservedServer = createServer()
    const targetReservation = createServer()
    const reservedPort = await listenOnLoopback(reservedServer)
    const targetPort = await listenOnLoopback(targetReservation)
    await closeServer(targetReservation)
    const initial = buildSettings()
    initial.claw.im = { ...initial.claw.im, port: reservedPort, secret: 'private-secret' }
    const runtime = createClawRuntime({
      store: mutableSettingsStore(initial).store as never,
      runtimeRequest: vi.fn() as never,
      logError: vi.fn(),
      webhookServer: reservedServer
    })
    const internalRuntime = runtime as unknown as {
      server: Server | null
      syncWebhook: (settings: AppSettingsV1) => void
      closeWebhook: () => Promise<void>
    }
    try {
      internalRuntime.syncWebhook(initial)
      expect(internalRuntime.server).toBe(reservedServer)
      const moved = buildSettings()
      moved.claw.im = { ...moved.claw.im, port: targetPort, secret: 'private-secret' }
      internalRuntime.syncWebhook(moved)
      const rebound = internalRuntime.server
      expect(rebound).not.toBe(reservedServer)
      if (!rebound?.listening) await new Promise<void>((resolve) => rebound?.once('listening', resolve))
      expect((rebound?.address() as AddressInfo).port).toBe(targetPort)
      const health = await fetch(`http://127.0.0.1:${targetPort}/claw/internal/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ status: 'ok', service: 'claw' })
    } finally {
      await internalRuntime.closeWebhook()
      await closeServer(reservedServer)
    }
  })

  it('bounds Feishu WebSocket handshakes and enables pong liveness detection', () => {
    expect(feishuWebSocketReliabilityOptions()).toEqual({
      transport: 'websocket',
      handshakeTimeoutMs: FEISHU_HANDSHAKE_TIMEOUT_MS,
      wsConfig: { pingTimeout: FEISHU_PING_TIMEOUT_SECONDS }
    })
    expect(FEISHU_HANDSHAKE_TIMEOUT_MS).toBeGreaterThan(0)
    expect(FEISHU_HANDSHAKE_TIMEOUT_MS).toBeLessThan(90_000)
    expect(FEISHU_PING_TIMEOUT_SECONDS).toBeGreaterThan(0)
  })

  it('reports a Feishu bridge available only while its WebSocket is connected', async () => {
    const settings = buildSettings()
    settings.claw.channels = [buildChannel()]
    const connection = { state: 'connected' }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined
    })
    const bridge = { getConnectionStatus: vi.fn(() => connection) }
    ;(runtime as unknown as { feishuChannels: Map<string, typeof bridge> })
      .feishuChannels.set('channel_1', bridge)

    await expect(runtime.isChannelBridgeAvailable('channel_1')).resolves.toBe(true)
    connection.state = 'reconnecting'
    await expect(runtime.isChannelBridgeAvailable('channel_1')).resolves.toBe(false)
    connection.state = 'failed'
    await expect(runtime.isChannelBridgeAvailable('channel_1')).resolves.toBe(false)
  })

  it('maps Feishu WebSocket lifecycle snapshots into authoritative health', () => {
    const settings = buildSettings()
    settings.claw.channels = [buildChannel()]
    const connection = { state: 'connected' }
    const imHealth = { heartbeat: vi.fn(), fail: vi.fn() }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      imHealth: imHealth as never
    })
    const bridge = { getConnectionStatus: vi.fn(() => connection) }
    ;(runtime as unknown as { feishuChannels: Map<string, typeof bridge> })
      .feishuChannels.set('channel_1', bridge)

    runtime.refreshChannelHealth()
    expect(imHealth.heartbeat).toHaveBeenCalledWith('channel_1', '飞书连接正常。')

    connection.state = 'reconnecting'
    runtime.refreshChannelHealth()
    expect(imHealth.fail).toHaveBeenCalledWith('channel_1', {
      reasonCode: 'network',
      message: '飞书连接正在重连。'
    })

    connection.state = 'failed'
    runtime.refreshChannelHealth()
    expect(imHealth.fail).toHaveBeenCalledWith('channel_1', {
      reasonCode: 'bridge_unavailable',
      message: '飞书连接不可用。'
    })
  })

  it('refreshes persisted channel counts from active ledger states only', () => {
    const settings = buildSettings()
    settings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'app-1',
        appSecret: 'secret',
        domain: 'feishu',
        createdAt: '2026-08-15T00:00:00.000Z'
      }
    })]
    const imLedger = {
      counts: vi.fn(() => ({ pending: 0, processing: 0, delivery: 0 }))
    }
    const imHealth = { updateCounts: vi.fn() }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      imLedger: imLedger as never,
      imHealth: imHealth as never
    })

    runtime.refreshChannelHealth(settings)

    expect(imLedger.counts).toHaveBeenCalledWith('feishu', 'app-1')
    expect(imHealth.updateCounts).toHaveBeenCalledWith('channel_1', {
      pendingMessages: 0,
      processingMessages: 0,
      deliveryMessages: 0
    })
  })

  it('keeps an unchanged connected Feishu bridge connected during settings sync', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'app-1',
        appSecret: 'secret',
        domain: 'feishu',
        createdAt: '2026-08-15T00:00:00.000Z'
      }
    })]
    const imHealth = {
      get: vi.fn(() => ({ status: 'connected' })),
      start: vi.fn(),
      heartbeat: vi.fn(),
      fail: vi.fn()
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      resolveImCredential: vi.fn(async () => 'secret'),
      imHealth: imHealth as never
    })
    const bridge = { getConnectionStatus: vi.fn(() => ({ state: 'connected' })) }
    const internal = runtime as unknown as {
      feishuChannels: Map<string, typeof bridge>
      feishuChannelKeys: Map<string, string>
      syncFeishuChannels(settings: AppSettingsV1): Promise<void>
    }
    internal.feishuChannels.set('channel_1', bridge)
    internal.feishuChannelKeys.set('channel_1', 'channel_1|app-1|secret|feishu|/tmp/workspace')

    await internal.syncFeishuChannels(settings)

    expect(imHealth.start).not.toHaveBeenCalled()
    expect(imHealth.heartbeat).toHaveBeenCalledWith('channel_1', '飞书连接正常。')
  })

  it('handles a Feishu message dispatched before connect resolves', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'app-1',
        appSecret: 'secret',
        domain: 'feishu',
        createdAt: '2026-08-15T00:00:00.000Z'
      }
    })]
    const handlers = new Map<string, (payload: any) => Promise<void> | void>()
    const send = vi.fn(async () => ({ messageId: 'om_reply' }))
    const bridge = {
      botIdentity: { openId: 'ou_bot' },
      dispatcher: { register: vi.fn() },
      disconnect: vi.fn(async () => undefined),
      getConnectionStatus: vi.fn(() => ({ state: 'connected' })),
      on: vi.fn((event: string, handler: (payload: any) => Promise<void> | void) => {
        handlers.set(event, handler)
      }),
      send,
      connect: vi.fn(async () => {
        await handlers.get('message')?.({
          messageId: 'om_during_connect',
          chatId: 'oc_chat_1',
          chatType: 'p2p',
          senderId: 'ou_user',
          senderName: 'Alice',
          content: '/status',
          rawContentType: 'text',
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false
        })
      })
    }
    const imHealth = {
      get: vi.fn(() => ({
        status: 'starting',
        message: '正在建立连接。',
        updatedAt: '2026-08-15T00:00:00.000Z'
      })),
      start: vi.fn(),
      heartbeat: vi.fn(),
      inbound: vi.fn(),
      outbound: vi.fn(),
      fail: vi.fn()
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      createFeishuChannel: vi.fn(() => bridge) as never,
      resolveImCredential: vi.fn(async () => 'secret'),
      imHealth: imHealth as never
    })

    await (runtime as unknown as {
      syncFeishuChannels(value: AppSettingsV1): Promise<void>
    }).syncFeishuChannels(settings)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      'oc_chat_1',
      { markdown: expect.stringContaining('Feishu') },
      { replyTo: 'om_during_connect', replyInThread: false }
    )
    expect(imHealth.inbound).toHaveBeenCalledWith('channel_1')
  })

  it('does not revive a Feishu bridge stopped while connect is pending', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'app-1',
        appSecret: 'secret',
        domain: 'feishu',
        createdAt: '2026-08-15T00:00:00.000Z'
      }
    })]
    let releaseConnect: (() => void) | undefined
    let notifyConnectStarted: (() => void) | undefined
    const connectStarted = new Promise<void>((resolve) => {
      notifyConnectStarted = resolve
    })
    const connectPending = new Promise<void>((resolve) => {
      releaseConnect = resolve
    })
    const bridge = {
      dispatcher: { register: vi.fn() },
      disconnect: vi.fn(async () => undefined),
      on: vi.fn(),
      connect: vi.fn(async () => {
        notifyConnectStarted?.()
        await connectPending
      })
    }
    const imHealth = {
      get: vi.fn(() => ({ status: 'starting' })),
      start: vi.fn(),
      stop: vi.fn(),
      heartbeat: vi.fn(),
      fail: vi.fn()
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      createFeishuChannel: vi.fn(() => bridge) as never,
      resolveImCredential: vi.fn(async () => 'secret'),
      imHealth: imHealth as never
    })
    const internal = runtime as unknown as {
      feishuChannels: Map<string, typeof bridge>
      syncFeishuChannels(value: AppSettingsV1): Promise<void>
    }

    const syncing = internal.syncFeishuChannels(settings)
    await connectStarted
    await runtime.stopChannel('channel_1')
    releaseConnect?.()
    await syncing

    expect(internal.feishuChannels.has('channel_1')).toBe(false)
    expect(imHealth.stop).toHaveBeenCalledWith('channel_1')
    expect(imHealth.heartbeat).not.toHaveBeenCalled()
    expect(bridge.disconnect).toHaveBeenCalled()
  })

  it('keeps a pending Feishu bridge when an equivalent settings sync reuses it', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'app-1',
        appSecret: 'secret',
        domain: 'feishu',
        createdAt: '2026-08-15T00:00:00.000Z'
      }
    })]
    let releaseConnect: (() => void) | undefined
    let notifyConnectStarted: (() => void) | undefined
    const connectStarted = new Promise<void>((resolve) => {
      notifyConnectStarted = resolve
    })
    const connectPending = new Promise<void>((resolve) => {
      releaseConnect = resolve
    })
    const bridge = {
      dispatcher: { register: vi.fn() },
      disconnect: vi.fn(async () => undefined),
      getConnectionStatus: vi.fn(() => ({ state: 'connecting' })),
      on: vi.fn(),
      connect: vi.fn(async () => {
        notifyConnectStarted?.()
        await connectPending
      })
    }
    const imHealth = {
      get: vi.fn(() => ({ status: 'starting' })),
      start: vi.fn(),
      heartbeat: vi.fn(),
      fail: vi.fn()
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      createFeishuChannel: vi.fn(() => bridge) as never,
      resolveImCredential: vi.fn(async () => 'secret'),
      imHealth: imHealth as never
    })
    const internal = runtime as unknown as {
      feishuChannels: Map<string, typeof bridge>
      syncFeishuChannels(value: AppSettingsV1): Promise<void>
    }

    const firstSync = internal.syncFeishuChannels(settings)
    await connectStarted
    await internal.syncFeishuChannels(settings)
    releaseConnect?.()
    await firstSync

    expect(internal.feishuChannels.get('channel_1')).toBe(bridge)
    expect(bridge.disconnect).not.toHaveBeenCalled()
    expect(imHealth.heartbeat).toHaveBeenCalledWith('channel_1', '飞书连接正常。')
  })

  it('does not let a stale Feishu sync disconnect a newer bridge with different credentials', async () => {
    const oldSettings = buildSettings()
    oldSettings.claw.im.enabled = true
    oldSettings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'app-old',
        appSecret: 'old-secret',
        domain: 'feishu',
        createdAt: '2026-08-15T00:00:00.000Z'
      }
    })]
    const newSettings = buildSettings()
    newSettings.claw.im.enabled = true
    newSettings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'app-new',
        appSecret: 'new-secret',
        domain: 'feishu',
        createdAt: '2026-08-15T00:01:00.000Z'
      }
    })]
    let releaseOldCredential: (() => void) | undefined
    let notifyOldCredentialStarted: (() => void) | undefined
    const oldCredentialStarted = new Promise<void>((resolve) => {
      notifyOldCredentialStarted = resolve
    })
    const oldCredentialPending = new Promise<void>((resolve) => {
      releaseOldCredential = resolve
    })
    const newBridge = {
      dispatcher: { register: vi.fn() },
      disconnect: vi.fn(async () => undefined),
      getConnectionStatus: vi.fn(() => ({ state: 'connected' })),
      on: vi.fn(),
      connect: vi.fn(async () => undefined)
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => newSettings), patch: vi.fn(async () => newSettings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      createFeishuChannel: vi.fn(() => newBridge) as never,
      resolveImCredential: vi.fn(async (channel) => {
        if (channel.platformCredential?.kind === 'feishu' && channel.platformCredential.appId === 'app-old') {
          notifyOldCredentialStarted?.()
          await oldCredentialPending
          return 'old-secret'
        }
        return 'new-secret'
      }),
      imHealth: {
        get: vi.fn(() => ({ status: 'starting' })),
        start: vi.fn(),
        heartbeat: vi.fn(),
        fail: vi.fn()
      } as never
    })
    const internal = runtime as unknown as {
      feishuChannels: Map<string, typeof newBridge>
      syncFeishuChannels(value: AppSettingsV1): Promise<void>
    }

    const oldSync = internal.syncFeishuChannels(oldSettings)
    await oldCredentialStarted
    await internal.syncFeishuChannels(newSettings)
    releaseOldCredential?.()
    await oldSync

    expect(internal.feishuChannels.get('channel_1')).toBe(newBridge)
    expect(newBridge.disconnect).not.toHaveBeenCalled()
    expect(newBridge.connect).toHaveBeenCalledTimes(1)
  })

  it('does not revive a user-stopped Feishu channel during automatic settings sync', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'app-1',
        appSecret: 'secret',
        domain: 'feishu',
        createdAt: '2026-08-15T00:00:00.000Z'
      }
    })]
    const imHealth = {
      get: vi.fn(() => ({ status: 'stopped' })),
      start: vi.fn(),
      heartbeat: vi.fn(),
      fail: vi.fn()
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      imHealth: imHealth as never
    })

    await (runtime as unknown as {
      syncFeishuChannels(settings: AppSettingsV1): Promise<void>
    }).syncFeishuChannels(settings)

    expect(imHealth.start).not.toHaveBeenCalled()
    expect(imHealth.heartbeat).not.toHaveBeenCalled()
    expect(imHealth.fail).not.toHaveBeenCalled()
  })

  it('does not reopen Keychain for Feishu during automatic settings sync', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'app-1',
        domain: 'feishu',
        createdAt: '2026-08-15T00:00:00.000Z'
      },
      credentialRef: {
        id: 'credential-ref',
        storage: 'keychain',
        createdAt: '2026-08-15T00:00:00.000Z'
      }
    })]
    const resolveImCredential = vi.fn(async () => 'secret')
    const imHealth = {
      get: vi.fn(() => ({ status: 'error', reasonCode: 'credential_unavailable' })),
      start: vi.fn(),
      heartbeat: vi.fn(),
      fail: vi.fn()
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      resolveImCredential,
      imHealth: imHealth as never
    })

    await (runtime as unknown as {
      syncFeishuChannels(settings: AppSettingsV1): Promise<void>
    }).syncFeishuChannels(settings)

    expect(resolveImCredential).not.toHaveBeenCalled()
    expect(imHealth.start).not.toHaveBeenCalled()
    expect(imHealth.heartbeat).not.toHaveBeenCalled()
    expect(imHealth.fail).not.toHaveBeenCalled()
  })

  it('defers protected Feishu credentials during cold-start sync', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'app-1',
        domain: 'feishu',
        createdAt: '2026-08-15T00:00:00.000Z'
      },
      credentialRef: {
        id: 'credential-ref',
        storage: 'keychain',
        createdAt: '2026-08-15T00:00:00.000Z'
      }
    })]
    const resolveImCredential = vi.fn(async () => 'secret')
    const imHealth = {
      get: vi.fn(() => undefined),
      start: vi.fn(),
      fail: vi.fn()
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      resolveImCredential,
      imHealth: imHealth as never
    })

    await (runtime as unknown as {
      syncFeishuChannels(value: AppSettingsV1, options?: { deferProtectedCredentialAccess?: boolean }): Promise<void>
    }).syncFeishuChannels(settings, { deferProtectedCredentialAccess: true })

    expect(resolveImCredential).not.toHaveBeenCalled()
    expect(imHealth.fail).toHaveBeenCalledWith('channel_1', expect.objectContaining({
      reasonCode: 'credential_unavailable'
    }))
  })

  it('does not read credentials or create a Feishu bridge for a disabled candidate', async () => {
    const previousCandidate = process.env.WORKWISE_CANDIDATE
    const previousInbound = process.env.WORKWISE_CANDIDATE_INBOUND_DISABLED
    const previousOutbound = process.env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED
    process.env.WORKWISE_CANDIDATE = '1'
    process.env.WORKWISE_CANDIDATE_INBOUND_DISABLED = '1'
    process.env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED = '1'
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.channels = [buildChannel({
        platformCredential: {
          kind: 'feishu',
          appId: 'app-1',
          domain: 'feishu',
          createdAt: '2026-08-15T00:00:00.000Z'
        },
        credentialRef: {
          id: 'credential-ref',
          storage: 'keychain',
          createdAt: '2026-08-15T00:00:00.000Z'
        }
      })]
      const resolveImCredential = vi.fn(async () => 'secret')
      const createFeishuChannel = vi.fn()
      const imHealth = { get: vi.fn(), start: vi.fn(), heartbeat: vi.fn(), fail: vi.fn() }
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest: vi.fn() as never,
        logError: () => undefined,
        resolveImCredential,
        createFeishuChannel: createFeishuChannel as never,
        imHealth: imHealth as never
      })

      await (runtime as unknown as {
        syncFeishuChannels(settings: AppSettingsV1): Promise<void>
      }).syncFeishuChannels(settings)
      await runtime.startChannel('channel_1')
      await runtime.reconnectChannel('channel_1')

      expect(resolveImCredential).not.toHaveBeenCalled()
      expect(createFeishuChannel).not.toHaveBeenCalled()
      expect(imHealth.start).not.toHaveBeenCalled()
    } finally {
      if (previousCandidate === undefined) delete process.env.WORKWISE_CANDIDATE
      else process.env.WORKWISE_CANDIDATE = previousCandidate
      if (previousInbound === undefined) delete process.env.WORKWISE_CANDIDATE_INBOUND_DISABLED
      else process.env.WORKWISE_CANDIDATE_INBOUND_DISABLED = previousInbound
      if (previousOutbound === undefined) delete process.env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED
      else process.env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED = previousOutbound
    }
  })

  it('disconnects the old Feishu bridge before reconnecting the channel', async () => {
    const settings = buildSettings()
    settings.claw.channels = [buildChannel()]
    const imHealth = { start: vi.fn(), stop: vi.fn() }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      imHealth: imHealth as never
    })
    const bridge = { disconnect: vi.fn(async () => undefined) }
    ;(runtime as unknown as { feishuChannels: Map<string, typeof bridge> })
      .feishuChannels.set('channel_1', bridge)
    const sync = vi.spyOn(runtime, 'sync').mockImplementation(() => undefined)

    await runtime.reconnectChannel('channel_1')

    expect(bridge.disconnect).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledWith(settings)
    expect(imHealth.start).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'channel_1',
      provider: 'feishu'
    }))
    expect(imHealth.stop).toHaveBeenCalledWith('channel_1')
    expect(await runtime.isChannelBridgeAvailable('channel_1')).toBe(false)
  })

  it('disconnects Feishu on runtime shutdown without recording a user pause', async () => {
    const settings = buildSettings()
    settings.claw.channels = [buildChannel()]
    const imHealth = { stop: vi.fn() }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      imHealth: imHealth as never
    })
    const bridge = { disconnect: vi.fn(async () => undefined) }
    ;(runtime as unknown as { feishuChannels: Map<string, typeof bridge> })
      .feishuChannels.set('channel_1', bridge)

    await runtime.stop()

    expect(bridge.disconnect).toHaveBeenCalledTimes(1)
    expect(imHealth.stop).not.toHaveBeenCalled()
    expect(await runtime.isChannelBridgeAvailable('channel_1')).toBe(false)
  })

  it('records an explicit Feishu stop as a user pause', async () => {
    const settings = buildSettings()
    settings.claw.channels = [buildChannel()]
    const imHealth = { stop: vi.fn() }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      imHealth: imHealth as never
    })
    const bridge = { disconnect: vi.fn(async () => undefined) }
    ;(runtime as unknown as { feishuChannels: Map<string, typeof bridge> })
      .feishuChannels.set('channel_1', bridge)

    await runtime.stopChannel('channel_1')

    expect(bridge.disconnect).toHaveBeenCalledTimes(1)
    expect(imHealth.stop).toHaveBeenCalledWith('channel_1')
  })

  it('reports a missing Feishu credential instead of leaving the channel in starting', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'cli_test',
        domain: 'feishu',
        createdAt: '2026-08-14T00:00:00.000Z'
      },
      credentialRef: {
        id: 'credential-ref',
        storage: 'keychain',
        createdAt: '2026-08-14T00:00:00.000Z'
      }
    })]
    const imHealth = {
      start: vi.fn(),
      fail: vi.fn()
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: vi.fn(),
      resolveImCredential: vi.fn(async () => undefined),
      imHealth: imHealth as never
    })

    await (runtime as unknown as { syncFeishuChannels(value: AppSettingsV1): Promise<void> })
      .syncFeishuChannels(settings)

    expect(imHealth.start).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'channel_1',
      credentialStorage: 'keychain'
    }))
    expect(imHealth.fail).toHaveBeenCalledWith('channel_1', expect.objectContaining({
      reasonCode: 'credential_missing'
    }))
  })

  it('reports a transient Feishu Keychain failure as retryable instead of missing', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'cli_test',
        domain: 'feishu',
        createdAt: '2026-08-14T00:00:00.000Z'
      },
      credentialRef: {
        id: 'credential-ref',
        storage: 'keychain',
        createdAt: '2026-08-14T00:00:00.000Z'
      }
    })]
    const imHealth = { start: vi.fn(), fail: vi.fn() }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: vi.fn(),
      resolveImCredential: vi.fn(async () => {
        throw Object.assign(new Error('Keychain helper timed out.'), { code: 'credential_unavailable' })
      }),
      imHealth: imHealth as never
    })

    await (runtime as unknown as { syncFeishuChannels(value: AppSettingsV1): Promise<void> })
      .syncFeishuChannels(settings)

    expect(imHealth.fail).toHaveBeenCalledWith('channel_1', expect.objectContaining({
      reasonCode: 'credential_unavailable',
      message: '现有飞书凭据仍在，请通过“重新连接”恢复系统钥匙串访问。'
    }))
    expect(imHealth.fail).not.toHaveBeenCalledWith('channel_1', expect.objectContaining({
      reasonCode: 'credential_missing'
    }))
  })

  it('allows long Feishu and WeChat research while preserving explicit short timeouts', () => {
    expect(resolveImResponseTimeoutMs('feishu', 120_000)).toBe(600_000)
    expect(resolveImResponseTimeoutMs('feishu', 300_000)).toBe(600_000)
    expect(resolveImResponseTimeoutMs('feishu', 900_000)).toBe(900_000)
    expect(resolveImResponseTimeoutMs('feishu', 2_000)).toBe(2_000)
    expect(resolveImResponseTimeoutMs('weixin', 120_000)).toBe(600_000)
    expect(resolveImResponseTimeoutMs('weixin', 300_000)).toBe(600_000)
    expect(resolveImResponseTimeoutMs('weixin', 900_000)).toBe(900_000)
    expect(resolveImResponseTimeoutMs('weixin', 2_000)).toBe(2_000)
  })

  it('bases Feishu conversation workspaces on the configured Claw workspace', () => {
    const settings = buildSettings()
    settings.claw.im.workspaceRoot = '/tmp/claw-default'
    const channel: ClawImChannelV1 = {
      id: 'channel_1',
      provider: 'feishu' as const,
      label: 'Phone',
      enabled: true,
      model: 'auto',
      threadId: '',
      workspaceRoot: '',
      agentProfile: {
        name: 'kun',
        description: '',
        identity: '',
        personality: '',
        userContext: '',
        replyRules: ''
      },
      conversations: [],
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z'
    }
    settings.claw.channels = [channel]
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined
    })

    const root = (runtime as unknown as {
      resolveIncomingWorkspaceRoot: (
        settingsArg: AppSettingsV1,
        channelArg: typeof channel,
        conversationArg: undefined,
        remoteSessionArg: { chatId: string; threadId: string }
      ) => string
    }).resolveIncomingWorkspaceRoot(settings, channel, undefined, {
      chatId: 'oc_chat_a',
      threadId: ''
    })

    expect(root).toMatch(/^\/tmp\/claw-default\/conversations\/oc_chat_a-[0-9a-f]{12}$/)
  })

  it('repairs legacy Feishu conversation workspaces created from an empty channel root', () => {
    const settings = buildSettings()
    settings.claw.im.workspaceRoot = '/tmp/claw-default'
    const conversation: ClawImConversationV1 = {
      id: 'conv_1',
      chatId: 'oc_chat_a',
      remoteThreadId: '',
      latestMessageId: 'msg_1',
      senderId: 'ou_1',
      senderName: 'Alice',
      localThreadId: 'thr_1',
      workspaceRoot: '/conversations/oc_chat_a',
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z'
    }
    const channel: ClawImChannelV1 = {
      id: 'channel_1',
      provider: 'feishu' as const,
      label: 'Phone',
      enabled: true,
      model: 'auto',
      threadId: '',
      workspaceRoot: '',
      agentProfile: {
        name: 'kun',
        description: '',
        identity: '',
        personality: '',
        userContext: '',
        replyRules: ''
      },
      conversations: [conversation],
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z'
    }
    settings.claw.channels = [channel]
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined
    })

    const root = (runtime as unknown as {
      resolveIncomingWorkspaceRoot: (
        settingsArg: AppSettingsV1,
        channelArg: typeof channel,
        conversationArg: typeof conversation,
        remoteSessionArg: { chatId: string; threadId: string }
      ) => string
    }).resolveIncomingWorkspaceRoot(settings, channel, conversation, {
      chatId: 'oc_chat_a',
      threadId: ''
    })

    expect(root).toMatch(/^\/tmp\/claw-default\/conversations\/oc_chat_a-[0-9a-f]{12}$/)
  })

  it('uses collision-resistant workspace paths for remote chat ids that sanitize to the same label', () => {
    const settings = buildSettings()
    settings.claw.im.workspaceRoot = '/tmp/claw-default'
    const channel = buildChannel({ workspaceRoot: '' })
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined
    })
    const resolveRoot = (runtime as unknown as {
      resolveConversationWorkspaceRoot: (
        settingsArg: AppSettingsV1,
        channelArg: ClawImChannelV1,
        session: { chatId: string; threadId: string }
      ) => string
    }).resolveConversationWorkspaceRoot.bind(runtime)

    const atRoot = resolveRoot(settings, channel, { chatId: 'same@im.wechat', threadId: '' })
    const dashRoot = resolveRoot(settings, channel, { chatId: 'same-im.wechat', threadId: '' })

    expect(atRoot).not.toBe(dashRoot)
    expect(atRoot).toMatch(/\/conversations\/same-im\.wechat-[0-9a-f]{12}$/)
    expect(dashRoot).toMatch(/\/conversations\/same-im\.wechat-[0-9a-f]{12}$/)
  })

  it('delegates reminder creation to Schedule without writing claw tasks', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    const store = {
      load: vi.fn(async () => settings),
      patch: vi.fn(async () => settings)
    }
    const createScheduledTaskFromText = vi.fn(async () => ({
      kind: 'created' as const,
      taskId: 'schedule-task-1',
      title: 'Reminder',
      scheduleAt: '2026-06-03T09:00:00.000+08:00',
      confirmationText: 'Scheduled.'
    }))
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      createScheduledTaskFromText
    })
    const body = JSON.stringify({ text: 'Remind me tomorrow to ship the review.' })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    let status = 0
    let responseBody = ''
    const res = {
      writeHead: vi.fn((nextStatus: number) => {
        status = nextStatus
      }),
      end: vi.fn((payload: string) => {
        responseBody = payload
      })
    }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    expect(status).toBe(200)
    expect(JSON.parse(responseBody)).toEqual({
      ok: true,
      createdTaskId: 'schedule-task-1',
      reply: 'Scheduled.'
    })
    expect(createScheduledTaskFromText).toHaveBeenCalledWith('Remind me tomorrow to ship the review.', {
      workspaceRoot: settings.workspaceRoot,
      modelHint: settings.claw.im.model,
      mode: settings.claw.im.mode
    })
    expect(store.patch).not.toHaveBeenCalled()
    expect(settings.claw.tasks).toHaveLength(1)
  })

  it('reports that scheduled tasks have moved to Schedule', async () => {
    const settings = buildSettings()
    let currentSettings = settings
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads') {
        return { ok: true, status: 200, body: JSON.stringify({ id: 'thr_1' }) }
      }
      if (path === '/v1/threads/thr_1') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_1/turns') {
        return { ok: true, status: 202, body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_1' }) }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const store = {
      load: vi.fn(async () => currentSettings),
      patch: vi.fn(async (partial: Partial<AppSettingsV1>) => {
        currentSettings = {
          ...currentSettings,
          ...partial,
          claw: { ...currentSettings.claw, ...(partial.claw ?? {}) }
        }
        return currentSettings
      })
    }
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest,
      logError: () => undefined
    })

    const result = await runtime.runTask('task_1')

    expect(result).toEqual({
      ok: false,
      reason: 'failed',
      message: 'Claw scheduled tasks have moved to Schedule.'
    })
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('accepts assistant_text items when waiting for a Claw turn result', async () => {
    const settings = buildSettings()
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads') {
        return { ok: true, status: 200, body: JSON.stringify({ id: 'thr_1' }) }
      }
      if (path === '/v1/threads/thr_1' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_1' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            thread: { id: 'thr_1', status: 'completed' },
            turns: [{ id: 'turn_1', status: 'completed' }],
            items: [{ kind: 'assistant_text', detail: 'hello from claw' }]
          })
        }
      }
      if (path === '/v1/threads/thr_1/turns') {
        return { ok: true, status: 202, body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_1' }) }
      }
      return { ok: true, status: 200, body: '{}' }
    })
    const store = {
      load: vi.fn(async () => settings),
      patch: vi.fn(async () => settings)
    }
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest,
      logError: () => undefined
    })

    const result = await (runtime as unknown as {
      runPrompt: (
        settingsArg: AppSettingsV1,
        options: {
          prompt: string
          title: string
          workspaceRoot: string
          model: string
          mode: 'agent' | 'plan'
          waitForResult: boolean
          responseTimeoutMs: number
          source: 'task' | 'im'
        }
      ) => Promise<{ ok: boolean; text?: string }>
    }).runPrompt(settings, {
      prompt: 'hello',
      title: 'demo',
      workspaceRoot: '/tmp/workspace',
      model: 'auto',
      mode: 'agent',
      waitForResult: true,
      responseTimeoutMs: 10,
      source: 'im'
    })

    expect(result).toMatchObject({ ok: true, text: 'hello from claw' })
    const createThreadCall = runtimeRequest.mock.calls.find(
      ([, path, init]) => path === '/v1/threads' && init?.method === 'POST'
    )
    expect(JSON.parse(String(createThreadCall?.[2]?.body ?? '{}'))).toMatchObject({
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access'
    })
    const turnCall = runtimeRequest.mock.calls.find(
      ([, path, init]) => path === '/v1/threads/thr_1/turns' && init?.method === 'POST'
    )
    expect(JSON.parse(String(turnCall?.[2]?.body ?? '{}'))).toMatchObject({
      disableUserInput: true,
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access'
    })
  })

  it('reads assistant text from the WorkWise Runtime thread detail shape used by the real runtime', async () => {
    const settings = buildSettings()
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads') {
        return { ok: true, status: 200, body: JSON.stringify({ id: 'thr_1' }) }
      }
      if (path === '/v1/threads/thr_1' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_1' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_1',
            status: 'idle',
            latestSeq: 3,
            turns: [
              {
                id: 'turn_1',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: 'hello from nested turn items' }]
              }
            ]
          })
        }
      }
      if (path === '/v1/threads/thr_1/turns') {
        return { ok: true, status: 202, body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_1' }) }
      }
      return { ok: true, status: 200, body: '{}' }
    })
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest,
      logError: () => undefined
    })

    const result = await (runtime as unknown as {
      runPrompt: (
        settingsArg: AppSettingsV1,
        options: {
          prompt: string
          title: string
          workspaceRoot: string
          model: string
          mode: 'agent' | 'plan'
          waitForResult: boolean
          responseTimeoutMs: number
          source: 'task' | 'im'
        }
      ) => Promise<{ ok: boolean; text?: string }>
    }).runPrompt(settings, {
      prompt: 'hello',
      title: 'demo',
      workspaceRoot: '/tmp/workspace',
      model: 'auto',
      mode: 'agent',
      waitForResult: true,
      responseTimeoutMs: 2_000,
      source: 'im'
    })

    expect(result).toMatchObject({ ok: true, text: 'hello from nested turn items' })
  })

  it('distinguishes file-only, empty, approval-waiting, and input-waiting turn results', async () => {
    vi.useFakeTimers()
    const settings: AppSettingsV1 = { ...buildSettings(), locale: 'zh' }
    const runWithDetail = async (detail: Record<string, unknown>) => {
      const runtimeRequest = vi.fn(async (_settings, path, init) => {
        if (path === '/v1/threads') return { ok: true, status: 200, body: JSON.stringify({ id: 'thr_1' }) }
        if (path === '/v1/threads/thr_1' && init?.method === 'PATCH') return { ok: true, status: 200, body: '{}' }
        if (path === '/v1/threads/thr_1/turns') {
          return { ok: true, status: 202, body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_1' }) }
        }
        if (path === '/v1/threads/thr_1' && init?.method === 'GET') {
          return { ok: true, status: 200, body: JSON.stringify(detail) }
        }
        throw new Error(`unexpected path ${path}`)
      })
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest,
        logError: () => undefined
      })
      const resultPromise = (runtime as unknown as {
        runPrompt: (settingsArg: AppSettingsV1, options: {
          prompt: string
          title: string
          workspaceRoot: string
          model: string
          mode: 'agent' | 'plan'
          waitForResult: boolean
          responseTimeoutMs: number
          source: 'task' | 'im'
        }) => Promise<{ ok: boolean; message: string; text?: string; files?: Array<{ path: string }> }>
      }).runPrompt(settings, {
        prompt: 'hello',
        title: 'demo',
        workspaceRoot: '/tmp/workspace',
        model: 'auto',
        mode: 'agent',
        waitForResult: true,
        responseTimeoutMs: 10_000,
        source: 'im'
      })
      await vi.advanceTimersByTimeAsync(1_500)
      return resultPromise
    }

    try {
      await expect(runWithDetail({
        id: 'thr_1',
        turns: [{
          id: 'turn_1',
          status: 'completed',
          items: [{
            kind: 'tool_result',
            turnId: 'turn_1',
            toolName: 'generate_image',
            output: { files: [{ absolutePath: '/tmp/workspace/current.png' }] }
          }]
        }]
      })).resolves.toMatchObject({ ok: true, text: '', files: [{ path: '/tmp/workspace/current.png' }] })

      await expect(runWithDetail({
        id: 'thr_1',
        turns: [
          {
            id: 'turn_old',
            status: 'completed',
            items: [{
              kind: 'tool_result',
              turnId: 'turn_old',
              toolName: 'generate_image',
              output: { files: [{ absolutePath: '/tmp/workspace/old.png' }] }
            }]
          },
          { id: 'turn_1', status: 'completed', items: [] }
        ]
      })).resolves.toMatchObject({
        ok: false,
        reason: 'empty_result',
        message: '任务已结束，但没有产生可交付的文本或文件。'
      })

      await expect(runWithDetail({
        id: 'thr_1',
        turns: [{ id: 'turn_1', status: 'running', items: [{ kind: 'approval', status: 'pending' }] }]
      })).resolves.toMatchObject({
        ok: false,
        reason: 'authorization_required',
        message: '任务正在等待授权，尚未完成。请在 RailWise AI 中处理授权后重试。'
      })

      await expect(runWithDetail({
        id: 'thr_1',
        turns: [{ id: 'turn_1', status: 'running', items: [{ kind: 'user_input', status: 'pending' }] }]
      })).resolves.toMatchObject({
        ok: false,
        reason: 'user_input_required',
        message: '任务正在等待补充信息，尚未完成。请在 RailWise AI 中处理后重试。'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns a validated Task artifact when a shell turn only names its relative file', async () => {
    vi.useFakeTimers()
    try {
      const settings: AppSettingsV1 = { ...buildSettings(), locale: 'zh' }
      const runtimeRequest = vi.fn(async (_settings, path, init) => {
        if (path === '/v1/threads') return { ok: true, status: 200, body: JSON.stringify({ id: 'thr_task_file' }) }
        if (path === '/v1/threads/thr_task_file' && init?.method === 'PATCH') return { ok: true, status: 200, body: '{}' }
        if (path === '/v1/threads/thr_task_file/turns') {
          return { ok: true, status: 202, body: JSON.stringify({ threadId: 'thr_task_file', turnId: 'turn_task_file' }) }
        }
        if (path === '/v1/threads/thr_task_file' && init?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              id: 'thr_task_file',
              turns: [{
                id: 'turn_task_file',
                status: 'completed',
                items: [{
                  kind: 'assistant_text',
                  turnId: 'turn_task_file',
                  text: '文件 result.txt 已创建并验证。'
                }]
              }]
            })
          }
        }
        if (path === '/v1/tasks?threadId=thr_task_file&limit=20' && init?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify([{
              activeTurnId: 'turn_task_file',
              status: 'completed',
              workspaceRoot: '/tmp/runtime-thread-workspace',
              artifacts: [{ relativePath: 'result.txt', validation: 'valid' }]
            }])
          }
        }
        throw new Error(`unexpected path ${path}`)
      })
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest,
        logError: () => undefined
      })
      const resultPromise = (runtime as unknown as {
        runPrompt: (settingsArg: AppSettingsV1, options: {
          prompt: string
          title: string
          workspaceRoot: string
          model: string
          mode: 'agent' | 'plan'
          waitForResult: boolean
          responseTimeoutMs: number
          source: 'task' | 'im'
        }) => Promise<{ ok: boolean; files?: Array<{ path: string; relativePath?: string }> }>
      }).runPrompt(settings, {
        prompt: '请创建 result.txt 并作为附件发送给我。',
        title: 'task artifact delivery',
        workspaceRoot: '/tmp/workspace',
        model: 'auto',
        mode: 'agent',
        waitForResult: true,
        responseTimeoutMs: 10_000,
        source: 'im'
      })

      await vi.advanceTimersByTimeAsync(1_500)
      await expect(resultPromise).resolves.toMatchObject({
        ok: true,
        files: [{ path: '/tmp/runtime-thread-workspace/result.txt', relativePath: 'result.txt' }]
      })
      expect(runtimeRequest).toHaveBeenCalledWith(
        settings,
        '/v1/tasks?threadId=thr_task_file&limit=20',
        { method: 'GET' }
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('accepts a current-turn artifact from the channel root while keeping other paths blocked', async () => {
    const channelRoot = await mkdtemp(join(tmpdir(), 'workwise-im-channel-root-'))
    const conversationRoot = join(channelRoot, 'conversations', 'conversation-a')
    const channelFile = join(channelRoot, 'result.txt')
    const outsideRoot = await mkdtemp(join(tmpdir(), 'workwise-im-outside-root-'))
    const outsideFile = join(outsideRoot, 'outside.txt')
    await mkdir(conversationRoot, { recursive: true })
    await writeFile(channelFile, 'CHANNEL')
    await writeFile(outsideFile, 'OUTSIDE')
    try {
      const logError = vi.fn()
      const runtime = createClawRuntime({
        store: { load: vi.fn(), patch: vi.fn() } as never,
        runtimeRequest: vi.fn() as never,
        logError
      })

      const files = await (runtime as unknown as {
        resolveImGeneratedFiles: (
          candidates: Array<{ path: string; fileName: string }>,
          workspaceRoots: string[],
          context: Record<string, unknown>
        ) => Promise<Array<{ path: string; fileName: string }>>
      }).resolveImGeneratedFiles([
        { path: channelFile, fileName: 'result.txt' },
        { path: outsideFile, fileName: 'outside.txt' }
      ], [conversationRoot, channelRoot], { purpose: 'test' })

      expect(files).toEqual([{ path: await realpath(channelFile), fileName: 'result.txt' }])
      expect(logError).toHaveBeenCalledWith(
        'claw-im',
        'Skipping generated file outside the IM workspace',
        expect.objectContaining({ filePath: outsideFile })
      )
    } finally {
      await rm(channelRoot, { recursive: true, force: true })
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })

  it('returns a stable timeout reason instead of partial in-progress text', async () => {
    vi.useFakeTimers()
    try {
      const settings: AppSettingsV1 = { ...buildSettings(), locale: 'zh' }
      const runtimeRequest = vi.fn(async (_settings, path, init) => {
        if (path === '/v1/threads') return { ok: true, status: 200, body: JSON.stringify({ id: 'thr_timeout' }) }
        if (path === '/v1/threads/thr_timeout' && init?.method === 'PATCH') return { ok: true, status: 200, body: '{}' }
        if (path === '/v1/threads/thr_timeout/turns') {
          return { ok: true, status: 202, body: JSON.stringify({ threadId: 'thr_timeout', turnId: 'turn_timeout' }) }
        }
        if (path === '/v1/threads/thr_timeout' && init?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              id: 'thr_timeout',
              turns: [{
                id: 'turn_timeout',
                status: 'running',
                items: [{ kind: 'assistant_text', turnId: 'turn_timeout', text: '仍在处理中' }]
              }]
            })
          }
        }
        if (path === '/v1/threads/thr_timeout/turns/turn_timeout/interrupt' && init?.method === 'POST') {
          return { ok: true, status: 200, body: JSON.stringify({ status: 'aborted' }) }
        }
        throw new Error(`unexpected path ${path}`)
      })
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest,
        logError: () => undefined
      })
      const resultPromise = (runtime as unknown as {
        runPrompt(settingsArg: AppSettingsV1, options: {
          prompt: string
          title: string
          workspaceRoot: string
          model: string
          mode: 'agent' | 'plan'
          waitForResult: boolean
          responseTimeoutMs: number
          source: 'task' | 'im'
        }): Promise<{ ok: boolean; reason?: string; message: string }>
      }).runPrompt(settings, {
        prompt: '需要较长时间的任务',
        title: 'timeout',
        workspaceRoot: '/tmp/workspace',
        model: 'auto',
        mode: 'agent',
        waitForResult: true,
        responseTimeoutMs: 2_000,
        source: 'im'
      })

      await vi.advanceTimersByTimeAsync(4_500)
      await expect(resultPromise).resolves.toMatchObject({
        ok: false,
        reason: 'timeout',
        message: '任务处理超时，尚未完成。请稍后重试。'
      })
      expect(runtimeRequest).toHaveBeenCalledWith(
        settings,
        '/v1/threads/thr_timeout/turns/turn_timeout/interrupt',
        { method: 'POST', body: JSON.stringify({ discard: false }) }
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('replaces a missing configured IM thread before starting a new inbound turn', async () => {
    const settings = buildSettings()
    const logError = vi.fn()
    const onTurnStarted = vi.fn()
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads/thr_missing/turns') {
        return {
          ok: false,
          status: 404,
          body: JSON.stringify({ code: 'not_found', message: 'thread not found: thr_missing' })
        }
      }
      if (path === '/v1/threads') {
        return { ok: true, status: 200, body: JSON.stringify({ id: 'thr_replacement' }) }
      }
      if (path === '/v1/threads/thr_replacement' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_replacement/turns') {
        return {
          ok: true,
          status: 202,
          body: JSON.stringify({ threadId: 'thr_replacement', turnId: 'turn_replacement' })
        }
      }
      if (path === '/v1/threads/thr_replacement' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_replacement',
            status: 'idle',
            turns: [
              {
                id: 'turn_replacement',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: 'recovered reply' }]
              }
            ]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest,
      logError
    })

    const result = await (runtime as unknown as {
      runPrompt: (
        settingsArg: AppSettingsV1,
        options: {
          prompt: string
          title: string
          workspaceRoot: string
          model: string
          mode: 'agent' | 'plan'
          waitForResult: boolean
          responseTimeoutMs: number
          source: 'task' | 'im'
          threadId?: string
          onTurnStarted?: (payload: { threadId: string; turnId: string }) => Promise<void> | void
        }
      ) => Promise<{ ok: boolean; threadId?: string; turnId?: string; text?: string }>
    }).runPrompt(settings, {
      prompt: 'hello',
      title: 'demo',
      workspaceRoot: '/tmp/workspace',
      model: 'auto',
      mode: 'agent',
      waitForResult: true,
      responseTimeoutMs: 2_000,
      source: 'im',
      threadId: 'thr_missing',
      onTurnStarted
    })

    expect(result).toMatchObject({
      ok: true,
      threadId: 'thr_replacement',
      turnId: 'turn_replacement',
      text: 'recovered reply'
    })
    expect(onTurnStarted).toHaveBeenCalledWith({
      threadId: 'thr_replacement',
      turnId: 'turn_replacement'
    })
    expect(logError).toHaveBeenCalledWith(
      'claw-runtime',
      'Configured IM thread was missing; creating a replacement thread.',
      expect.objectContaining({ threadId: 'thr_missing', source: 'im' })
    )
  })

  it('keeps an ambiguous Feishu reply unknown without changing its target', async () => {
    const send = vi.fn().mockRejectedValue(new Error('reply response lost'))
    const runtime = createClawRuntime({ store: { load: async () => buildSettings() } as never, runtimeRequest: vi.fn(), logError: vi.fn() })
    const pending = (runtime as unknown as { sendFeishuMessage: (...args: unknown[]) => Promise<unknown> }).sendFeishuMessage(
      { send }, 'oc_chat_a', { markdown: 'agent reply' }, { replyTo: 'om_inbound', replyInThread: true }, { purpose: 'agent-reply' })
    await expect(pending).rejects.toMatchObject({ code: 'im_delivery_outcome_unknown' })
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][2]).toEqual({ replyTo: 'om_inbound', replyInThread: true })
  })

  it('retains the outbound UUID and stops after an ambiguous Feishu send', async () => {
    const reply = vi.fn().mockRejectedValue(new Error('temporary timeout'))
    const create = vi.fn()
    const runtime = createClawRuntime({ store: { load: async () => buildSettings() } as never, runtimeRequest: vi.fn(), logError: vi.fn() })
    const pending = (runtime as unknown as { sendFeishuMessage: (...args: unknown[]) => Promise<unknown> }).sendFeishuMessage(
      { rawClient: { im: { v1: { message: { reply, create } } } } }, 'oc_chat_a', { markdown: '**done**' },
      { replyTo: 'om_inbound' }, {}, 'ww_stable_delivery')
    await expect(pending).rejects.toMatchObject({ code: 'im_delivery_outcome_unknown' })
    expect(reply).toHaveBeenCalledOnce()
    expect(reply.mock.calls[0][0].data.uuid).toBe('ww_stable_delivery')
    expect(create).not.toHaveBeenCalled()
  })

  it('does not replay a Feishu upload whose result is unknown', async () => {
    const upload = vi.fn().mockRejectedValue(new Error('upload response lost'))
    const reply = vi.fn()
    const runtime = createClawRuntime({ store: { load: async () => buildSettings() } as never, runtimeRequest: vi.fn(), logError: vi.fn() })
    const pending = (runtime as unknown as { sendFeishuMessage: (...args: unknown[]) => Promise<unknown> }).sendFeishuMessage(
      { rawClient: { im: { v1: { file: { create: upload }, message: { reply, create: vi.fn() } } } } },
      'oc_chat_a', { file: { source: Buffer.from('pptx'), fileName: 'proposal.pptx' } }, { replyTo: 'om_inbound' }, {}, 'ww_stable_file')
    await expect(pending).rejects.toMatchObject({ code: 'im_delivery_outcome_unknown' })
    expect(upload).toHaveBeenCalledOnce()
    expect(reply).not.toHaveBeenCalled()
  })

  it('deduplicates a Feishu command and marks it delivered only after the provider send', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel()]
    const state = {
      status: 'received',
      resultJson: undefined as string | undefined,
      leased: false
    }
    const transitions: string[] = []
    const baseRecord = {
      id: 'ledger-1', provider: 'feishu', accountId: 'app-1', channelId: 'channel_1',
      remoteMessageId: 'om_command_once', chatId: 'oc_chat_a', senderId: 'ou_1', threadId: '',
      prompt: '/help', payloadJson: '{}', idempotencyKey: 'im:feishu:app-1:om_command_once',
      retryCount: 0, createdAt: '2026-06-02T00:00:00.000Z', updatedAt: '2026-06-02T00:00:00.000Z'
    }
    const currentRecord = () => ({ ...baseRecord, status: state.status, resultJson: state.resultJson })
    const ledger = {
      ...deliveryOperationStubs(currentRecord),
      receive: vi.fn(() => currentRecord()),
      claim: vi.fn(() => {
        if (state.leased || state.status === 'delivered') return undefined
        state.leased = true
        state.status = 'turn_starting'
        return currentRecord()
      }),
      getByRemoteId: vi.fn(() => currentRecord()),
      markResultReady: vi.fn((_id: string, resultJson: string) => {
        transitions.push('result_ready')
        state.status = 'result_ready'
        state.resultJson = resultJson
        return currentRecord()
      }),
      markDelivering: vi.fn(() => {
        transitions.push('delivering')
        state.status = 'delivering'
        return currentRecord()
      }),
      markDelivered: vi.fn(() => {
        transitions.push('delivered')
        state.status = 'delivered'
        state.leased = false
        return currentRecord()
      }),
      markDeliveryRetry: vi.fn(),
      counts: vi.fn(() => ({ pending: 0, processing: 0, delivery: 0 })),
      listRecoverable: vi.fn(() => []),
      prune: vi.fn()
    }
    const runtimeRequest = vi.fn()
    const rawReply = vi.fn(async () => {
      transitions.push('provider_send')
      return { data: { message_id: 'om_reply_once' } }
    })
    const bridge = {
      rawClient: { im: { v1: { message: { reply: rawReply, create: vi.fn() } } } },
      send: vi.fn(),
      addReaction: vi.fn()
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      imLedger: ledger as never
    })
    ;(runtime as unknown as { feishuChannels: Map<string, typeof bridge> }).feishuChannels.set('channel_1', bridge)
    const message = {
      chatId: 'oc_chat_a', messageId: 'om_command_once', senderId: 'ou_1', senderName: 'Alice',
      chatType: 'p2p' as const, mentionedBot: false, mentionAll: false, content: '/help',
      rawContentType: 'text', mentions: []
    }
    const handle = (runtime as unknown as {
      handleFeishuMessage: (channelId: string, value: typeof message) => Promise<void>
    }).handleFeishuMessage.bind(runtime)

    await handle('channel_1', message)
    await handle('channel_1', message)

    expect(runtimeRequest).not.toHaveBeenCalled()
    expect(rawReply).toHaveBeenCalledTimes(1)
    expect(transitions).toEqual(['result_ready', 'delivering', 'provider_send', 'delivered'])
  })

  it('records transmitted Feishu failures as failed and successful replies as delivered in SQLite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-feishu-result-status-'))
    const ledger = new ImDeliveryLedger(join(root, 'messages.sqlite3'))
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'app-1',
        domain: 'feishu',
        createdAt: '2026-08-17T00:00:00.000Z'
      }
    })]
    const rawReply = vi.fn(async () => ({ data: { message_id: 'om_reply' } }))
    const bridge = {
      rawClient: { im: { v1: { message: { reply: rawReply, create: vi.fn() } } } },
      send: vi.fn(),
      addReaction: vi.fn()
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      imLedger: ledger,
      createScheduledTaskFromText: vi.fn(async (text: string) => text === 'fail schedule'
        ? { kind: 'error' as const, message: 'scheduler unavailable' }
        : { kind: 'noop' as const })
    })
    ;(runtime as unknown as { feishuChannels: Map<string, typeof bridge> }).feishuChannels.set('channel_1', bridge)
    const handle = (runtime as unknown as {
      handleFeishuMessage: (channelId: string, message: {
        chatId: string
        messageId: string
        senderId: string
        senderName: string
        chatType: 'p2p'
        mentionedBot: boolean
        mentionAll: boolean
        content: string
        rawContentType: string
        mentions: unknown[]
      }) => Promise<void>
    }).handleFeishuMessage.bind(runtime)
    const baseMessage = {
      chatId: 'oc_result_status',
      senderId: 'ou_1',
      senderName: 'Alice',
      chatType: 'p2p' as const,
      mentionedBot: false,
      mentionAll: false,
      rawContentType: 'text',
      mentions: []
    }

    await handle('channel_1', { ...baseMessage, messageId: 'om_failed', content: 'fail schedule' })
    await handle('channel_1', { ...baseMessage, messageId: 'om_success', content: '/help' })

    const failed = ledger.getByRemoteId('feishu', 'app-1', 'om_failed')
    const delivered = ledger.getByRemoteId('feishu', 'app-1', 'om_success')
    expect(failed).toMatchObject({ status: 'failed', errorMessage: 'scheduler unavailable' })
    expect(JSON.parse(failed?.resultJson ?? '{}')).toMatchObject({
      ok: false,
      message: 'scheduler unavailable'
    })
    expect(delivered).toMatchObject({ status: 'delivered', errorMessage: undefined })
    expect(JSON.parse(delivered?.resultJson ?? '{}')).toMatchObject({ ok: true })
    expect(rawReply).toHaveBeenCalledTimes(2)
    ledger.close()
  })

  it('keeps WeChat credentials on stop and removes bridge credentials on disconnect', async () => {
    const settings = buildSettings()
    settings.claw.channels = [buildChannel({
      id: 'channel_weixin',
      provider: 'weixin',
      platformCredential: { kind: 'weixin', accountId: 'wx-account-1', createdAt: '2026-08-14T00:00:00.000Z' },
      credentialRef: { id: 'secure-ref', storage: 'keychain', createdAt: '2026-08-14T00:00:00.000Z' }
    })]
    const { current, store } = mutableSettingsStore(settings)
    const start = vi.fn(async () => undefined)
    const reconnect = vi.fn(async () => undefined)
    const stop = vi.fn(async () => undefined)
    const disconnect = vi.fn(async () => undefined)
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      startWeixinBridgeAccount: start,
      reconnectWeixinBridgeAccount: reconnect,
      stopWeixinBridgeAccount: stop,
      disconnectWeixinBridgeAccount: disconnect
    })

    await runtime.startChannel('channel_weixin')
    await runtime.reconnectChannel('channel_weixin')
    await runtime.stopChannel('channel_weixin')
    await runtime.disconnectChannel('channel_weixin')

    expect(start).toHaveBeenCalledWith('wx-account-1')
    expect(reconnect).toHaveBeenCalledWith('wx-account-1')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledWith('wx-account-1')
    expect(current().claw.channels[0]).toMatchObject({
      enabled: false,
      credentialRef: { id: 'secure-ref', storage: 'keychain' },
      platformCredential: { kind: 'weixin', accountId: 'wx-account-1' }
    })
  })

  it('starts only one Runtime Turn for a duplicated Feishu remote message', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.im.responseTimeoutMs = 2_000
    settings.claw.channels = [buildChannel({
      platformCredential: {
        kind: 'feishu',
        appId: 'app-1',
        domain: 'https://open.feishu.cn',
        createdAt: '2026-08-14T00:00:00.000Z'
      },
      threadId: 'thr_1',
      conversations: [buildConversation({ localThreadId: 'thr_1' })]
    })]
    let status = 'received'
    let leased = false
    let resultJson: string | undefined
    const baseRecord = {
      id: 'ledger-turn-1', provider: 'feishu', accountId: 'app-1', channelId: 'channel_1',
      remoteMessageId: 'om_turn_once', chatId: 'oc_chat_a', senderId: 'ou_1', threadId: '',
      prompt: 'do one thing', payloadJson: '{}', idempotencyKey: 'im:feishu:app-1:om_turn_once',
      retryCount: 0, createdAt: '2026-06-02T00:00:00.000Z', updatedAt: '2026-06-02T00:00:00.000Z'
    }
    const record = () => ({ ...baseRecord, status, resultJson })
    const ledger = {
      ...deliveryOperationStubs(record),
      receive: vi.fn(() => record()),
      claim: vi.fn(() => {
        if (leased || status === 'delivered') return undefined
        leased = true
        status = 'turn_starting'
        return record()
      }),
      update: vi.fn((_id: string, patch: { status?: string }) => {
        status = patch.status ?? status
        return record()
      }),
      getByRemoteId: vi.fn(() => record()),
      markResultReady: vi.fn((_id: string, json: string) => {
        status = 'result_ready'
        resultJson = json
        return record()
      }),
      markDelivering: vi.fn(() => {
        status = 'delivering'
        return record()
      }),
      markDelivered: vi.fn(() => {
        status = 'delivered'
        leased = false
        return record()
      }),
      markDeliveryRetry: vi.fn(),
      counts: vi.fn(() => ({ pending: 0, processing: 0, delivery: 0 })),
      listRecoverable: vi.fn(() => []),
      prune: vi.fn()
    }
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads/thr_1/turns' && init?.method === 'POST') {
        expect(JSON.parse(init.body ?? '{}')).toMatchObject({ idempotencyKey: 'im:feishu:app-1:om_turn_once' })
        return { ok: true, status: 202, body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_once' }) }
      }
      if (path === '/v1/threads/thr_1' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_1', status: 'idle',
            turns: [{ id: 'turn_once', status: 'completed', items: [{ kind: 'assistant_text', text: 'done once' }] }]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const rawReply = vi.fn(async () => ({ data: { message_id: 'om_turn_reply' } }))
    const bridge = {
      rawClient: { im: { v1: { message: { reply: rawReply, create: vi.fn() } } } },
      send: vi.fn(),
      addReaction: vi.fn(async () => 'reaction-1')
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest,
      logError: () => undefined,
      imLedger: ledger as never,
      createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
    })
    ;(runtime as unknown as { feishuChannels: Map<string, typeof bridge> }).feishuChannels.set('channel_1', bridge)
    const message = {
      chatId: 'oc_chat_a', messageId: 'om_turn_once', senderId: 'ou_1', senderName: 'Alice',
      chatType: 'p2p' as const, mentionedBot: false, mentionAll: false, content: 'do one thing',
      rawContentType: 'text', mentions: []
    }
    const handle = (runtime as unknown as {
      handleFeishuMessage: (channelId: string, value: typeof message) => Promise<void>
    }).handleFeishuMessage.bind(runtime)

    await handle('channel_1', message)
    await handle('channel_1', message)

    expect(runtimeRequest.mock.calls.filter(([, path, init]) => path === '/v1/threads/thr_1/turns' && init?.method === 'POST')).toHaveLength(1)
    expect(rawReply).toHaveBeenCalledTimes(1)
    expect(status).toBe('delivered')
  })

  it('recovers a result-ready WeChat delivery without starting another Turn', async () => {
    const settings = buildSettings()
    const ledgerRecord = {
      id: 'ledger-wx-recovery', provider: 'weixin' as const, accountId: 'wx-account-1', channelId: 'channel_weixin',
      remoteMessageId: 'wx-message-1', chatId: 'wx-user-1', senderId: 'wx-user-1', threadId: '', prompt: 'hello',
      payloadJson: '{"text":"hello"}', status: 'result_ready' as const,
      idempotencyKey: 'im:weixin:wx-account-1:wx-message-1',
      resultJson: JSON.stringify({ ok: true, reply: 'recovered answer', outboundId: 'ww_recovered' }),
      retryCount: 0, createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:01.000Z'
    }
    const ledger = {
      ...deliveryOperationStubs(() => ledgerRecord),
      listRecoverable: vi.fn(() => [ledgerRecord]),
      prune: vi.fn(),
      claim: vi.fn(() => ledgerRecord),
      markDelivering: vi.fn(() => ledgerRecord),
      markDelivered: vi.fn(() => ledgerRecord),
      markDeliveryRetry: vi.fn(),
      counts: vi.fn(() => ({ pending: 0, processing: 0, delivery: 0 }))
    }
    const send = vi.fn(async () => ({ ok: true as const, messageId: 'wx-outbound-1' }))
    const runtimeRequest = vi.fn()
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      imLedger: ledger as never,
      sendWeixinBridgeMessage: send
    })

    await (runtime as unknown as { recoverPendingMessages: () => Promise<void> }).recoverPendingMessages()

    expect(send).toHaveBeenCalledWith({
      accountId: 'wx-account-1',
      to: 'wx-user-1',
      text: 'recovered answer',
      clientId: 'ww_recovered'
    })
    expect(ledger.markDelivering).toHaveBeenCalledWith('ledger-wx-recovery')
    expect(ledger.markDelivered).toHaveBeenCalledWith('ledger-wx-recovery')
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('does not produce a delivery after another worker has taken the expired ledger lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-stale-delivery-'))
    const ledger = new ImDeliveryLedger(join(root, 'messages.sqlite3'))
    try {
      const record = ledger.receive({
        provider: 'weixin', accountId: 'wx-account-1', channelId: 'channel_weixin', remoteMessageId: 'message-1',
        chatId: 'wx-user-1', senderId: 'wx-user-1', threadId: '', prompt: 'hello', payloadJson: '{}',
        idempotencyKey: 'im:weixin:wx-account-1:message-1'
      })
      const oldWorker = ledger.claim(record.id, 'worker-old', 1_000, '2026-01-01T00:00:00.000Z')
      expect(oldWorker).toBeDefined()
      ledger.claim(record.id, 'worker-new', 60_000, '2026-01-01T00:00:02.000Z')
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => buildSettings()), patch: vi.fn(async () => buildSettings()) } as never,
        runtimeRequest: vi.fn() as never,
        logError: () => undefined,
        imLedger: ledger
      })

      const delivery = (runtime as unknown as {
        prepareInboundDelivery: (value: NonNullable<typeof oldWorker>, input: { ok: true; reply: string }) => unknown
      }).prepareInboundDelivery(oldWorker!, { ok: true, reply: 'stale result' })

      expect(delivery).toBeUndefined()
      expect(ledger.getById(record.id)).toMatchObject({ status: 'turn_starting', leaseRunId: 'worker-new' })
    } finally {
      ledger.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not start a queued Runtime Turn after losing the inbound ledger lease', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      label: 'WeChat',
      threadId: '',
      conversations: []
    })]
    const { store } = mutableSettingsStore(settings)
    const record = {
      id: 'ledger-queued-1',
      provider: 'weixin' as const,
      accountId: 'channel_weixin',
      channelId: 'channel_weixin',
      remoteMessageId: 'wx-queued-1',
      chatId: 'wx-user-1',
      senderId: 'wx-user-1',
      threadId: '',
      prompt: 'queued request',
      payloadJson: '{}',
      status: 'turn_starting' as const,
      idempotencyKey: 'im:weixin:channel_weixin:wx-queued-1',
      retryCount: 0,
      leaseRunId: 'worker-old',
      leaseUntil: '2099-01-01T00:00:00.000Z',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z'
    }
    const ledger = {
      receive: vi.fn(() => record),
      claim: vi.fn(() => record),
      renewLease: vi.fn(() => undefined),
      markResultReady: vi.fn(() => undefined),
      counts: vi.fn(() => ({ pending: 0, processing: 1, delivery: 0 }))
    }
    const runtimeRequest = vi.fn()
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      imLedger: ledger as never,
      createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
    })
    const body = JSON.stringify({
      text: 'queued request',
      provider: 'weixin',
      channelId: 'channel_weixin',
      chatId: 'wx-user-1',
      messageId: 'wx-queued-1',
      senderId: 'wx-user-1',
      senderName: 'Alice'
    })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    let status = 0
    let responseBody = ''
    const res = {
      writeHead: vi.fn((nextStatus: number) => {
        status = nextStatus
      }),
      end: vi.fn((payload: string) => {
        responseBody = payload
      })
    }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    expect(ledger.renewLease).toHaveBeenCalledWith(record.id, record.leaseRunId, expect.any(Number))
    expect(runtimeRequest).not.toHaveBeenCalled()
    expect(ledger.markResultReady).not.toHaveBeenCalled()
    expect(status).toBe(202)
    expect(JSON.parse(responseBody)).toMatchObject({
      ok: true,
      pending: true,
      idempotencyKey: record.idempotencyKey
    })
  })

  it('recovers a Feishu reply and PPTX from a reopened SQLite ledger without starting another Turn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-feishu-sqlite-recovery-'))
    const ledgerPath = join(root, 'messages.sqlite3')
    const pptxPath = join(root, 'recovered-deck.pptx')
    await writeFile(pptxPath, Buffer.from('pptx-recovery-fixture'))
    const firstLedger = new ImDeliveryLedger(ledgerPath)
    const message = {
      chatId: 'oc_recovery', messageId: 'om_recovery', senderId: 'ou_recovery', senderName: 'Alice',
      chatType: 'p2p' as const, mentionedBot: false, mentionAll: false, content: '发送 PPTX',
      rawContentType: 'text', mentions: []
    }
    const record = firstLedger.receive({
      provider: 'feishu', accountId: 'app-recovery', channelId: 'channel_recovery',
      remoteMessageId: message.messageId, chatId: message.chatId, senderId: message.senderId,
      threadId: '', prompt: message.content, payloadJson: JSON.stringify({
        text: message.content,
        provider: 'feishu',
        channelId: 'channel_recovery',
        chatId: message.chatId,
        messageId: message.messageId,
        senderId: message.senderId,
        senderName: message.senderName
      }),
      idempotencyKey: 'im:feishu:app-recovery:om_recovery'
    })
    firstLedger.markResultReady(record.id, JSON.stringify({
      ok: true,
      reply: '恢复后的结果',
      files: [{ path: pptxPath, fileName: 'recovered-deck.pptx' }],
      threadId: 'thr_recovery',
      turnId: 'turn_recovery'
    }), { threadId: 'thr_recovery', turnId: 'turn_recovery' })
    firstLedger.close()

    const reopenedLedger = new ImDeliveryLedger(ledgerPath)
    try {
      const settings = buildSettings()
      settings.claw.channels = [buildChannel({
        id: 'channel_recovery',
        platformCredential: {
          kind: 'feishu', appId: 'app-recovery', domain: 'https://open.feishu.cn',
          createdAt: '2026-08-15T00:00:00.000Z'
        }
      })]
      const runtimeRequest = vi.fn()
      const reply = vi.fn(async () => ({ data: { message_id: 'om_recovered_reply' } }))
      const create = vi.fn(async () => ({ data: { message_id: 'om_recovered_file' } }))
      const upload = vi.fn(async () => ({ file_key: 'file_recovered' }))
      const bridge = {
        rawClient: { im: { v1: { file: { create: upload }, message: { reply, create } } } },
        send: vi.fn(), addReaction: vi.fn(), disconnect: vi.fn(async () => undefined)
      }
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest: runtimeRequest as never,
        logError: () => undefined,
        imLedger: reopenedLedger
      })
      ;(runtime as unknown as { feishuChannels: Map<string, typeof bridge> }).feishuChannels.set('channel_recovery', bridge)

      await runtime.recoverPendingMessages()

      expect(runtimeRequest.mock.calls.every(([, path]) => String(path).endsWith('/delivery-observations'))).toBe(true)
      expect(reply).toHaveBeenCalledTimes(2)
      expect(upload).toHaveBeenCalledTimes(1)
      expect(reply).toHaveBeenNthCalledWith(1, expect.objectContaining({
        data: expect.objectContaining({
          msg_type: 'file',
          content: JSON.stringify({ file_key: 'file_recovered' })
        })
      }))
      expect(reopenedLedger.getById(record.id)).toMatchObject({
        status: 'delivered', runtimeThreadId: 'thr_recovery', runtimeTurnId: 'turn_recovery'
      })
    } finally {
      reopenedLedger.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('terminalizes a malformed Feishu ledger payload during recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-feishu-malformed-recovery-'))
    const ledger = new ImDeliveryLedger(join(root, 'messages.sqlite3'))
    try {
      const record = ledger.receive({
        provider: 'feishu', accountId: 'app-malformed', channelId: 'channel-malformed',
        remoteMessageId: 'om-malformed', chatId: 'oc-malformed', senderId: 'ou-malformed', threadId: '',
        prompt: 'broken payload', payloadJson: '{not-json', idempotencyKey: 'im:feishu:app-malformed:om-malformed'
      })
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => buildSettings()), patch: vi.fn(async () => buildSettings()) } as never,
        runtimeRequest: vi.fn() as never,
        logError: () => undefined,
        imLedger: ledger
      })

      await runtime.recoverPendingMessages()

      expect(ledger.getById(record.id)).toMatchObject({
        status: 'failed',
        errorMessage: 'Stored Feishu inbound payload is invalid.'
      })
      expect(ledger.listRecoverable('2099-01-01T00:00:00.000Z')).toEqual([])
    } finally {
      ledger.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('terminalizes a malformed WeChat delivery result during recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-weixin-malformed-recovery-'))
    const ledger = new ImDeliveryLedger(join(root, 'messages.sqlite3'))
    try {
      const record = ledger.receive({
        provider: 'weixin', accountId: 'wx-malformed', channelId: 'channel-weixin',
        remoteMessageId: 'wx-malformed', chatId: 'wx-user', senderId: 'wx-user', threadId: '',
        prompt: 'broken result', payloadJson: '{}', idempotencyKey: 'im:weixin:wx-malformed:wx-malformed'
      })
      ledger.markResultReady(record.id, '{"ok":true}')
      const send = vi.fn()
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => buildSettings()), patch: vi.fn(async () => buildSettings()) } as never,
        runtimeRequest: vi.fn() as never,
        logError: () => undefined,
        imLedger: ledger,
        sendWeixinBridgeMessage: send
      })

      await runtime.recoverPendingMessages()

      expect(send).not.toHaveBeenCalled()
      expect(ledger.getById(record.id)).toMatchObject({
        status: 'failed',
        errorMessage: 'Stored WeChat delivery payload is invalid.'
      })
      expect(ledger.listRecoverable('2099-01-01T00:00:00.000Z')).toEqual([])
    } finally {
      ledger.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('renews the ledger lease while a Feishu reply is still sending', async () => {
    vi.useFakeTimers()
    try {
      const record = {
        id: 'ledger-long-send', provider: 'feishu' as const, accountId: 'app-long-send', channelId: 'channel_1',
        remoteMessageId: 'om-long-send', chatId: 'oc-long-send', senderId: 'ou-1', threadId: '',
        prompt: 'long send', payloadJson: '{}', status: 'result_ready' as const,
        idempotencyKey: 'im:feishu:app-long-send:om-long-send', retryCount: 0,
        leaseRunId: 'worker-long-send', leaseUntil: '2026-08-17T00:02:00.000Z',
        createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z'
      }
      const renewLease = vi.fn(() => record)
      const markDelivering = vi.fn(() => ({ ...record, status: 'delivering' as const }))
      const markDelivered = vi.fn(() => ({ ...record, status: 'delivered' as const }))
      const ledger = {
      ...deliveryOperationStubs(() => record),
        markDelivering,
        markDelivered,
        renewLease,
        counts: vi.fn(() => ({ pending: 0, processing: 0, delivery: 0 }))
      }
      let release!: () => void
      const reply = vi.fn(() => new Promise<{ data: { message_id: string } }>((resolve) => {
        release = () => resolve({ data: { message_id: 'om-long-send-reply' } })
      }))
      const bridge = {
        rawClient: { im: { v1: { message: { reply, create: vi.fn() } } } },
        send: vi.fn(), addReaction: vi.fn()
      }
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => buildSettings()), patch: vi.fn(async () => buildSettings()) } as never,
        runtimeRequest: vi.fn() as never,
        logError: () => undefined,
        imLedger: ledger as never
      })
      const deliver = (runtime as unknown as {
        deliverFeishuReply: (
          value: typeof record,
          currentBridge: typeof bridge,
          to: string,
          delivery: { ok: true; reply: string; outboundId: string },
          options: { replyTo: string; replyInThread: boolean },
          context: Record<string, unknown>
        ) => Promise<void>
      }).deliverFeishuReply.bind(runtime)

      const pending = deliver(
        record,
        bridge,
        record.chatId,
        { ok: true, reply: 'long reply', outboundId: 'ww_long_send' },
        { replyTo: record.remoteMessageId, replyInThread: false },
        { purpose: 'lease-test', channelId: record.channelId }
      )
      await vi.advanceTimersByTimeAsync(IM_LEDGER_LEASE_RENEW_INTERVAL_MS)
      expect(renewLease).toHaveBeenCalledWith(record.id, record.leaseRunId, expect.any(Number))
      release()
      await pending
      expect(markDelivered).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not send a Feishu reply after losing the inbound delivery lease', async () => {
    const record = {
      id: 'ledger-lost-send', provider: 'feishu' as const, accountId: 'app-lost-send', channelId: 'channel_1',
      remoteMessageId: 'om-lost-send', chatId: 'oc-lost-send', senderId: 'ou-1', threadId: '',
      prompt: 'stale send', payloadJson: '{}', status: 'result_ready' as const,
      idempotencyKey: 'im:feishu:app-lost-send:om-lost-send', retryCount: 0,
      leaseRunId: 'worker-lost-send', leaseUntil: '2026-08-17T00:02:00.000Z',
      createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z'
    }
    const markDelivered = vi.fn()
    const markDeliveryRetry = vi.fn()
    const ledger = {
      markDelivering: vi.fn(() => ({ ...record, status: 'delivering' as const })),
      markDelivered,
      markDeliveryRetry,
      renewLease: vi.fn(() => undefined),
      counts: vi.fn(() => ({ pending: 0, processing: 0, delivery: 1 }))
    }
    const reply = vi.fn(async () => ({ data: { message_id: 'om-stale-reply' } }))
    const bridge = {
      rawClient: { im: { v1: { message: { reply, create: vi.fn() } } } },
      send: vi.fn(), addReaction: vi.fn()
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => buildSettings()), patch: vi.fn(async () => buildSettings()) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      imLedger: ledger as never
    })
    const deliver = (runtime as unknown as {
      deliverFeishuReply: (
        value: typeof record,
        currentBridge: typeof bridge,
        to: string,
        delivery: { ok: true; reply: string; outboundId: string },
        options: { replyTo: string; replyInThread: boolean },
        context: Record<string, unknown>
      ) => Promise<void>
    }).deliverFeishuReply.bind(runtime)

    await expect(deliver(
      record,
      bridge,
      record.chatId,
      { ok: true, reply: 'must not send', outboundId: 'ww_lost_send' },
      { replyTo: record.remoteMessageId, replyInThread: false },
      { purpose: 'lost-lease-test', channelId: record.channelId }
    )).rejects.toThrow('IM delivery lease was lost')

    expect(reply).not.toHaveBeenCalled()
    expect(markDelivered).not.toHaveBeenCalled()
    expect(markDeliveryRetry).not.toHaveBeenCalled()
  })

  it('treats a ledger renewal exception as lease loss instead of leaking it from the timer', async () => {
    const record = {
      id: 'ledger-renew-error', provider: 'feishu' as const, accountId: 'app-renew-error', channelId: 'channel_1',
      remoteMessageId: 'om-renew-error', chatId: 'oc-renew-error', senderId: 'ou-1', threadId: '',
      prompt: 'renew error', payloadJson: '{}', status: 'result_ready' as const,
      idempotencyKey: 'im:feishu:app-renew-error:om-renew-error', retryCount: 0,
      leaseRunId: 'worker-renew-error', leaseUntil: '2026-08-17T00:02:00.000Z',
      createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z'
    }
    const logError = vi.fn()
    const reply = vi.fn(async () => ({ data: { message_id: 'om-must-not-send' } }))
    const ledger = {
      markDelivering: vi.fn(() => ({ ...record, status: 'delivering' as const })),
      markDelivered: vi.fn(),
      markDeliveryRetry: vi.fn(),
      renewLease: vi.fn(() => {
        throw new Error('SQLite busy')
      }),
      counts: vi.fn(() => ({ pending: 0, processing: 0, delivery: 1 }))
    }
    const bridge = {
      rawClient: { im: { v1: { message: { reply, create: vi.fn() } } } },
      send: vi.fn(), addReaction: vi.fn()
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => buildSettings()), patch: vi.fn(async () => buildSettings()) } as never,
      runtimeRequest: vi.fn() as never,
      logError,
      imLedger: ledger as never
    })
    const deliver = (runtime as unknown as {
      deliverFeishuReply: (
        value: typeof record,
        currentBridge: typeof bridge,
        to: string,
        delivery: { ok: true; reply: string; outboundId: string },
        options: { replyTo: string; replyInThread: boolean },
        context: Record<string, unknown>
      ) => Promise<void>
    }).deliverFeishuReply.bind(runtime)

    await expect(deliver(
      record,
      bridge,
      record.chatId,
      { ok: true, reply: 'must not send', outboundId: 'ww_renew_error' },
      { replyTo: record.remoteMessageId, replyInThread: false },
      { purpose: 'renew-error-test', channelId: record.channelId }
    )).rejects.toThrow('IM delivery lease was lost')

    expect(reply).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'claw-im',
      expect.stringContaining('lease renewal was rejected'),
      expect.objectContaining({ message: 'SQLite busy' })
    )
  })

  it('does not finish a Feishu delivery when lease renewal fails during the provider send', async () => {
    vi.useFakeTimers()
    try {
      const record = {
        id: 'ledger-mid-send-loss', provider: 'feishu' as const, accountId: 'app-mid-send', channelId: 'channel_1',
        remoteMessageId: 'om-mid-send', chatId: 'oc-mid-send', senderId: 'ou-1', threadId: '',
        prompt: 'mid send', payloadJson: '{}', status: 'result_ready' as const,
        idempotencyKey: 'im:feishu:app-mid-send:om-mid-send', retryCount: 0,
        leaseRunId: 'worker-mid-send', leaseUntil: '2026-08-17T00:02:00.000Z',
        createdAt: '2026-08-17T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z'
      }
      const renewLease = vi.fn(() => renewLease.mock.calls.length <= 3 ? record : undefined)
      const markDelivered = vi.fn()
      const markDeliveryRetry = vi.fn()
      const ledger = {
      ...deliveryOperationStubs(() => record),
        markDelivering: vi.fn(() => ({ ...record, status: 'delivering' as const })),
        markDelivered,
        markDeliveryRetry,
        renewLease,
        counts: vi.fn(() => ({ pending: 0, processing: 0, delivery: 1 }))
      }
      let release!: () => void
      const reply = vi.fn(() => new Promise<{ data: { message_id: string } }>((resolve) => {
        release = () => resolve({ data: { message_id: 'om-mid-send-reply' } })
      }))
      const create = vi.fn()
      const bridge = {
        rawClient: { im: { v1: { message: { reply, create } } } },
        send: vi.fn(), addReaction: vi.fn()
      }
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => buildSettings()), patch: vi.fn(async () => buildSettings()) } as never,
        runtimeRequest: vi.fn() as never,
        logError: () => undefined,
        imLedger: ledger as never
      })
      const deliver = (runtime as unknown as {
        deliverFeishuReply: (
          value: typeof record,
          currentBridge: typeof bridge,
          to: string,
          delivery: { ok: true; reply: string; outboundId: string },
          options: { replyTo: string; replyInThread: boolean },
          context: Record<string, unknown>
        ) => Promise<void>
      }).deliverFeishuReply.bind(runtime)

      const pending = deliver(
        record,
        bridge,
        record.chatId,
        { ok: true, reply: 'mid-send reply', outboundId: 'ww_mid_send' },
        { replyTo: record.remoteMessageId, replyInThread: false },
        { purpose: 'mid-send-loss-test', channelId: record.channelId }
      )
      await vi.advanceTimersByTimeAsync(IM_LEDGER_LEASE_RENEW_INTERVAL_MS)
      release()

      await expect(pending).rejects.toThrow('IM delivery lease was lost')
      expect(reply).toHaveBeenCalledTimes(1)
      expect(create).not.toHaveBeenCalled()
      expect(markDelivered).not.toHaveBeenCalled()
      expect(markDeliveryRetry).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not send a recovered WeChat result after losing the delivery lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-weixin-lost-recovery-'))
    const ledger = new ImDeliveryLedger(join(root, 'messages.sqlite3'))
    try {
      const record = ledger.receive({
        provider: 'weixin', accountId: 'wx-lost-recovery', channelId: 'channel_weixin',
        remoteMessageId: 'wx-lost-recovery-message', chatId: 'wx-user-1', senderId: 'wx-user-1',
        threadId: '', prompt: 'recover me', payloadJson: '{"text":"recover me"}',
        idempotencyKey: 'im:weixin:wx-lost-recovery:wx-lost-recovery-message'
      })
      ledger.markResultReady(record.id, JSON.stringify({
        ok: true,
        reply: 'stale recovered answer',
        outboundId: 'ww_lost_recovery'
      }))
      vi.spyOn(ledger, 'renewLease').mockReturnValue(undefined)
      const send = vi.fn(async () => ({ ok: true as const, messageId: 'wx-stale-outbound' }))
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => buildSettings()), patch: vi.fn(async () => buildSettings()) } as never,
        runtimeRequest: vi.fn() as never,
        logError: () => undefined,
        imLedger: ledger,
        sendWeixinBridgeMessage: send
      })

      await runtime.recoverPendingMessages()

      expect(send).not.toHaveBeenCalled()
      expect(ledger.getById(record.id)).toMatchObject({
        status: 'delivering',
        leaseRunId: expect.any(String)
      })
    } finally {
      ledger.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resumes a crash-interrupted Feishu Turn from a webhook-shaped SQLite payload without receiving it again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-feishu-turn-recovery-'))
    const ledgerPath = join(root, 'messages.sqlite3')
    const firstLedger = new ImDeliveryLedger(ledgerPath)
    const record = firstLedger.receive({
      provider: 'feishu', accountId: 'app-recovery', channelId: 'channel_recovery',
      remoteMessageId: 'om_turn_recovery', chatId: 'oc_recovery', senderId: 'ou_recovery',
      threadId: '', prompt: '恢复这个飞书任务', payloadJson: JSON.stringify({
        text: '恢复这个飞书任务',
        provider: 'feishu',
        channelId: 'channel_recovery',
        chatId: 'oc_recovery',
        messageId: 'om_turn_recovery',
        senderId: 'ou_recovery',
        senderName: 'Alice'
      }),
      idempotencyKey: 'im:feishu:app-recovery:om_turn_recovery'
    })
    firstLedger.update(record.id, {
      status: 'turn_started',
      runtimeThreadId: 'thr_feishu_recovery',
      runtimeTurnId: 'turn_feishu_recovery',
      leaseRunId: 'crashed-run',
      leaseUntil: '2000-01-01T00:00:00.000Z'
    })
    firstLedger.close()

    const reopenedLedger = new ImDeliveryLedger(ledgerPath)
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.im.responseTimeoutMs = 3_000
      settings.claw.channels = [buildChannel({
        id: 'channel_recovery',
        welcomeSentAt: '2026-08-15T00:00:00.000Z',
        platformCredential: {
          kind: 'feishu', appId: 'app-recovery', domain: 'https://open.feishu.cn',
          createdAt: '2026-08-15T00:00:00.000Z'
        }
      })]
      const runtimeRequest = vi.fn(async (_settings, path, init) => {
        if (path === '/v1/threads/thr_feishu_recovery/turns' && init?.method === 'POST') {
          expect(JSON.parse(init.body ?? '{}')).toMatchObject({
            idempotencyKey: 'im:feishu:app-recovery:om_turn_recovery'
          })
          return {
            ok: true,
            status: 202,
            body: JSON.stringify({ threadId: 'thr_feishu_recovery', turnId: 'turn_feishu_recovery' })
          }
        }
        if (path === '/v1/threads/thr_feishu_recovery' && init?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              id: 'thr_feishu_recovery',
              status: 'idle',
              turns: [{
                id: 'turn_feishu_recovery',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: '飞书恢复结果' }]
              }]
            })
          }
        }
        throw new Error(`unexpected path ${path}`)
      })
      const reply = vi.fn(async () => ({ data: { message_id: 'om_recovered_reply' } }))
      const bridge = {
        rawClient: { im: { v1: { message: { reply, create: vi.fn() } } } },
        send: vi.fn(), addReaction: vi.fn(async () => 'reaction'), disconnect: vi.fn(async () => undefined)
      }
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest,
        logError: () => undefined,
        imLedger: reopenedLedger,
        createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
      })
      ;(runtime as unknown as { feishuChannels: Map<string, typeof bridge> }).feishuChannels.set('channel_recovery', bridge)

      await runtime.recoverPendingMessages()

      expect(runtimeRequest.mock.calls.filter(([, path]) => path === '/v1/threads/thr_feishu_recovery/turns')).toHaveLength(1)
      expect(reply).toHaveBeenCalledTimes(1)
      expect(reopenedLedger.getById(record.id)).toMatchObject({
        status: 'delivered',
        runtimeThreadId: 'thr_feishu_recovery',
        runtimeTurnId: 'turn_feishu_recovery'
      })
    } finally {
      reopenedLedger.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('persists the Runtime thread before starting an idempotent Feishu Turn', async () => {
    const settings = buildSettings()
    settings.claw.channels = [buildChannel({
      welcomeSentAt: '2026-08-15T00:00:00.000Z',
      platformCredential: {
        kind: 'feishu', appId: 'app-thread-first', domain: 'https://open.feishu.cn',
        createdAt: '2026-08-15T00:00:00.000Z'
      }
    })]
    const transitions: Array<{ status?: string; runtimeThreadId?: string; runtimeTurnId?: string }> = []
    const ledgerRecord = {
      id: 'ledger-thread-first', provider: 'feishu' as const, accountId: 'app-thread-first', channelId: 'channel_1',
      remoteMessageId: 'om_thread_first', chatId: 'oc_thread_first', senderId: 'ou_thread_first', threadId: '',
      prompt: 'do this once', payloadJson: '{}', status: 'turn_starting' as const,
      idempotencyKey: 'im:feishu:app-thread-first:om_thread_first', retryCount: 0,
      createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z'
    }
    const ledger = {
      update: vi.fn((_id: string, patch: typeof transitions[number]) => {
        transitions.push(patch)
        return { ...ledgerRecord, ...patch }
      }),
      counts: vi.fn(() => ({ pending: 0, processing: 1, delivery: 0 }))
    }
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads' && init?.method === 'POST') {
        return { ok: true, status: 201, body: JSON.stringify({ id: 'thr_thread_first' }) }
      }
      if (path === '/v1/threads/thr_thread_first' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_thread_first/turns' && init?.method === 'POST') {
        expect(transitions).toContainEqual({ status: 'turn_starting', runtimeThreadId: 'thr_thread_first' })
        expect(JSON.parse(init.body ?? '{}')).toMatchObject({
          idempotencyKey: 'im:feishu:app-thread-first:om_thread_first'
        })
        return {
          ok: true,
          status: 202,
          body: JSON.stringify({ threadId: 'thr_thread_first', turnId: 'turn_thread_first' })
        }
      }
      if (path === '/v1/threads/thr_thread_first' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_thread_first', status: 'idle',
            turns: [{ id: 'turn_thread_first', status: 'completed', items: [{ kind: 'assistant_text', text: 'done once' }] }]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest,
      logError: () => undefined,
      imLedger: ledger as never
    })

    const result = await (runtime as unknown as {
      processIncomingImPrompt: (current: typeof settings, input: Record<string, unknown>) => Promise<{ ok: boolean }>
    }).processIncomingImPrompt(settings, {
      prompt: 'do this once', sender: 'Alice', provider: 'feishu', channel: settings.claw.channels[0],
      remoteSession: {
        chatId: 'oc_thread_first', messageId: 'om_thread_first', threadId: '',
        senderId: 'ou_thread_first', senderName: 'Alice'
      },
      idempotencyKey: ledgerRecord.idempotencyKey, ledgerRecord
    })

    expect(result.ok).toBe(true)
    expect(transitions[0]).toEqual({ status: 'turn_starting', runtimeThreadId: 'thr_thread_first' })
    expect(transitions[1]).toEqual({
      status: 'turn_started', runtimeThreadId: 'thr_thread_first', runtimeTurnId: 'turn_thread_first'
    })
  })

  it('resumes a crash-interrupted WeChat Turn from the ledger thread and idempotency key', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.im.responseTimeoutMs = 2_000
    settings.claw.channels = [buildChannel({
      id: 'channel_weixin',
      provider: 'weixin',
      platformCredential: { kind: 'weixin', accountId: 'wx-account-1', createdAt: '2026-08-14T00:00:00.000Z' },
      threadId: '',
      conversations: []
    })]
    let status = 'turn_started'
    let resultJson: string | undefined
    const baseRecord = {
      id: 'ledger-wx-turn', provider: 'weixin' as const, accountId: 'wx-account-1', channelId: 'channel_weixin',
      remoteMessageId: 'wx-message-turn', chatId: 'wx-user-1', senderId: 'wx-user-1', threadId: '', prompt: 'resume me',
      payloadJson: JSON.stringify({
        text: 'resume me', provider: 'weixin', channelId: 'channel_weixin', chatId: 'wx-user-1',
        messageId: 'wx-message-turn', senderId: 'wx-user-1', senderName: 'Alice'
      }),
      idempotencyKey: 'im:weixin:wx-account-1:wx-message-turn',
      runtimeThreadId: 'thr_recovery', runtimeTurnId: 'turn_recovery', retryCount: 0,
      createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:01.000Z'
    }
    const current = () => ({ ...baseRecord, status, resultJson })
    const ledger = {
      ...deliveryOperationStubs(current),
      listRecoverable: vi.fn(() => [current()]),
      prune: vi.fn(),
      receive: vi.fn(() => current()),
      claim: vi.fn(() => current()),
      update: vi.fn((_id: string, patch: { status?: string }) => {
        status = patch.status ?? status
        return current()
      }),
      getById: vi.fn(() => current()),
      getByRemoteId: vi.fn(() => current()),
      markResultReady: vi.fn((_id: string, json: string) => {
        status = 'result_ready'
        resultJson = json
        return current()
      }),
      markDelivering: vi.fn(() => {
        status = 'delivering'
        return current()
      }),
      markDelivered: vi.fn(() => {
        status = 'delivered'
        return current()
      }),
      markDeliveryRetry: vi.fn(),
      counts: vi.fn(() => ({ pending: 0, processing: 0, delivery: 0 }))
    }
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads/thr_recovery/turns' && init?.method === 'POST') {
        expect(JSON.parse(init.body ?? '{}')).toMatchObject({ idempotencyKey: baseRecord.idempotencyKey })
        return { ok: true, status: 202, body: JSON.stringify({ threadId: 'thr_recovery', turnId: 'turn_recovery' }) }
      }
      if (path === '/v1/threads/thr_recovery' && init?.method === 'GET') {
        return {
          ok: true, status: 200,
          body: JSON.stringify({
            id: 'thr_recovery', status: 'idle',
            turns: [{ id: 'turn_recovery', status: 'completed', items: [{ kind: 'assistant_text', text: 'recovered result' }] }]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const send = vi.fn(async () => ({ ok: true as const, messageId: 'wx-recovered-send' }))
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest,
      logError: () => undefined,
      imLedger: ledger as never,
      sendWeixinBridgeMessage: send,
      createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
    })

    await runtime.recoverPendingMessages()

    expect(runtimeRequest.mock.calls.some(([, path]) => path === '/v1/threads')).toBe(false)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'wx-account-1', to: 'wx-user-1', text: 'recovered result'
    }))
    expect(status).toBe('delivered')
  })

  it('shares the global inbound concurrency limit across WeChat and Feishu', async () => {
    const settings = buildSettings()
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      imMaxConcurrency: 1
    })
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let active = 0
    let maxActive = 0
    const run = async (gate?: Promise<void>) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await gate
      active -= 1
    }
    const enqueue = (runtime as unknown as {
      enqueueInbound: (key: string, task: () => Promise<void>) => Promise<void>
    }).enqueueInbound.bind(runtime)

    const weixin = enqueue('weixin:account:chat-a:root', () => run(firstGate))
    await vi.waitFor(() => expect(active).toBe(1))
    const feishu = enqueue('feishu:channel:chat-b:root', () => run())
    await Promise.resolve()
    expect(active).toBe(1)
    releaseFirst()
    await Promise.all([weixin, feishu])

    expect(maxActive).toBe(1)
  })

  it('serializes messages within the same remote conversation', async () => {
    const settings = buildSettings()
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      imMaxConcurrency: 2
    })
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const enqueue = (runtime as unknown as {
      enqueueInbound: (key: string, task: () => Promise<void>) => Promise<void>
    }).enqueueInbound.bind(runtime)
    const key = 'weixin:account:chat-a:root'

    const first = enqueue(key, async () => {
      order.push('first:start')
      await firstGate
      order.push('first:end')
    })
    await vi.waitFor(() => expect(order).toEqual(['first:start']))
    const second = enqueue(key, async () => {
      order.push('second:start')
      order.push('second:end')
    })
    await Promise.resolve()
    expect(order).toEqual(['first:start'])

    releaseFirst()
    await Promise.all([first, second])

    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('transfers a released inbound slot before a new message can steal it', async () => {
    const settings = buildSettings()
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      imMaxConcurrency: 1
    })
    const semaphore = runtime as unknown as {
      acquireInboundSlot: () => Promise<void>
      releaseInboundSlot: () => void
      inboundActive: number
      inboundWaiters: Array<() => void>
    }

    await semaphore.acquireInboundSlot()
    const waiting = semaphore.acquireInboundSlot()
    expect(semaphore.inboundWaiters).toHaveLength(1)

    semaphore.releaseInboundSlot()
    const newcomer = semaphore.acquireInboundSlot()
    await waiting

    expect(semaphore.inboundActive).toBe(1)
    expect(semaphore.inboundWaiters).toHaveLength(1)

    semaphore.releaseInboundSlot()
    await newcomer
    expect(semaphore.inboundActive).toBe(1)

    semaphore.releaseInboundSlot()
    expect(semaphore.inboundActive).toBe(0)
  })

  it('handles Feishu /new locally by clearing the mapped IM thread', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    const conversation = buildConversation()
    settings.claw.channels = [buildChannel({ conversations: [conversation] })]
    const { current, store } = mutableSettingsStore(settings)
    const runtimeRequest = vi.fn()
    const send = vi.fn(async () => ({ messageId: 'om_sent' }))
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined
    })
    ;(runtime as unknown as { feishuChannels: Map<string, { send: typeof send }> })
      .feishuChannels
      .set('channel_1', { send })

    await (runtime as unknown as {
      handleFeishuMessage: (channelId: string, message: {
        chatId: string
        messageId: string
        threadId?: string
        senderId: string
        senderName?: string
        chatType: 'p2p' | 'group'
        mentionedBot: boolean
        mentionAll: boolean
        content: string
        rawContentType: string
        mentions: unknown[]
      }) => Promise<void>
    }).handleFeishuMessage('channel_1', {
      chatId: 'oc_chat_a',
      messageId: 'om_inbound',
      senderId: 'ou_1',
      senderName: 'Alice',
      chatType: 'p2p',
      mentionedBot: false,
      mentionAll: false,
      content: '/new',
      rawContentType: 'text',
      mentions: []
    })

    expect(runtimeRequest).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      'oc_chat_a',
      { markdown: 'Started a new topic. The next message will create a fresh local conversation.' },
      { replyTo: 'om_inbound', replyInThread: false }
    )
    expect(current().claw.channels[0].threadId).toBe('')
    expect(current().claw.channels[0].conversations[0].localThreadId).toBe('')
    expect(current().claw.channels[0].remoteSession?.messageId).toBe('om_inbound')
  })

  it('handles Feishu model commands locally for the current IM channel', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel()]
    const { current, store } = mutableSettingsStore(settings)
    const runtimeRequest = vi.fn()
    const send = vi.fn(async () => ({ messageId: 'om_sent' }))
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined
    })
    ;(runtime as unknown as { feishuChannels: Map<string, { send: typeof send }> })
      .feishuChannels
      .set('channel_1', { send })

    await (runtime as unknown as {
      handleFeishuMessage: (channelId: string, message: {
        chatId: string
        messageId: string
        senderId: string
        senderName?: string
        chatType: 'p2p' | 'group'
        mentionedBot: boolean
        mentionAll: boolean
        content: string
        rawContentType: string
        mentions: unknown[]
      }) => Promise<void>
    }).handleFeishuMessage('channel_1', {
      chatId: 'oc_chat_a',
      messageId: 'om_inbound',
      senderId: 'ou_1',
      senderName: 'Alice',
      chatType: 'p2p',
      mentionedBot: false,
      mentionAll: false,
      content: '-model deepseek-v4-pro',
      rawContentType: 'text',
      mentions: []
    })

    expect(runtimeRequest).not.toHaveBeenCalled()
    expect(current().claw.channels[0].model).toBe('deepseek-flash')
    expect(send).toHaveBeenCalledWith(
      'oc_chat_a',
      { markdown: 'Claw IM model switched to `deepseek-flash`.' },
      { replyTo: 'om_inbound', replyInThread: false }
    )
  })

  it('handles webhook /help as an IM command before starting a WorkWise Runtime turn', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({ provider: 'weixin' as const, id: 'channel_weixin' })]
    const { store } = mutableSettingsStore(settings)
    const runtimeRequest = vi.fn()
    const createScheduledTaskFromText = vi.fn()
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      createScheduledTaskFromText
    })
    const body = JSON.stringify({ text: '/help', provider: 'weixin', channelId: 'channel_weixin' })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    let status = 0
    let responseBody = ''
    const res = {
      writeHead: vi.fn((nextStatus: number) => {
        status = nextStatus
      }),
      end: vi.fn((payload: string) => {
        responseBody = payload
      })
    }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    expect(status).toBe(200)
    expect(JSON.parse(responseBody)).toMatchObject({
      ok: true,
      reply: expect.stringContaining('Claw IM commands:')
    })
    expect(JSON.parse(responseBody).reply).toContain('/model auto|flash')
    expect(JSON.parse(responseBody).reply).not.toContain('/model pro')
    expect(JSON.parse(responseBody).reply).not.toContain('deepseek-v4-')
    expect(createScheduledTaskFromText).not.toHaveBeenCalled()
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('extends the provider delivery lease before returning a webhook result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-provider-delivery-lease-'))
    const ledger = new ImDeliveryLedger(join(root, 'messages.sqlite3'))
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.channels = [buildChannel({ provider: 'weixin', id: 'channel_weixin' })]
      const renewLease = vi.spyOn(ledger, 'renewLease')
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest: vi.fn() as never,
        logError: () => undefined,
        imLedger: ledger,
        createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
      })
      const body = JSON.stringify({
        text: '/help',
        provider: 'weixin',
        channelId: 'channel_weixin',
        chatId: 'wx-provider-delivery',
        messageId: 'wx-provider-delivery-1',
        senderId: 'wx-provider-delivery'
      })
      const req = {
        method: 'POST',
        url: settings.claw.im.path,
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(body)
        }
      }
      let status = 0
      let responseBody = ''
      const res = {
        writeHead: vi.fn((nextStatus: number) => {
          status = nextStatus
        }),
        end: vi.fn((payload: string) => {
          responseBody = payload
        })
      }

      await (runtime as unknown as {
        handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
      }).handleWebhook(req, res)

      const record = ledger.getByRemoteId('weixin', 'channel_weixin', 'wx-provider-delivery-1')
      expect(status).toBe(200)
      expect(JSON.parse(responseBody)).toMatchObject({ ok: true, deliveryId: record?.id })
      expect(record).toMatchObject({ status: 'result_ready' })
      expect(record?.leaseRunId).toEqual(expect.any(String))
      expect(renewLease).toHaveBeenCalledWith(
        record?.id,
        record?.leaseRunId,
        IM_LEDGER_PROVIDER_DELIVERY_LEASE_MS
      )
    } finally {
      ledger.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('enforces delivery start, renew, and idempotent completion receipts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-delivery-receipts-'))
    const ledger = new ImDeliveryLedger(join(root, 'messages.sqlite3'))
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest: vi.fn() as never,
        logError: () => undefined,
        imLedger: ledger
      })
      const received = ledger.receive({
        provider: 'weixin', accountId: 'wx-receipts', channelId: 'channel_weixin',
        remoteMessageId: 'wx-receipts-message', chatId: 'wx-user', senderId: 'wx-user',
        threadId: '', prompt: 'receipt test', payloadJson: '{}',
        idempotencyKey: 'im:weixin:wx-receipts:wx-receipts-message'
      })
      const claimed = ledger.claim(received.id, 'receipt-owner')!
      const outboundId = `ww_${createHash('sha256')
        .update(`${received.idempotencyKey}:reply`)
        .digest('hex')
        .slice(0, 32)}`
      ledger.markResultReady(received.id, JSON.stringify({
        ok: true,
        reply: 'delivered once',
        deliveryId: received.id,
        outboundId,
        deliveryLeaseRunId: claimed.leaseRunId
      }), undefined, new Date().toISOString(), claimed.leaseRunId)
      const markDelivered = vi.spyOn(ledger, 'markDelivered')
      const renewLease = vi.spyOn(ledger, 'renewLease')
      const deliveryUrl = `${settings.claw.im.path.replace(/\/$/, '')}/delivery`
      const receipt = {
        deliveryId: received.id,
        outboundId,
        leaseRunId: claimed.leaseRunId
      }

      await expect(postRuntimeWebhook(runtime, deliveryUrl, { ...receipt, phase: 'start' }))
        .resolves.toMatchObject({
          status: 200,
          body: { ok: true, phase: 'start', leaseUntil: expect.any(String) }
        })
      expect(renewLease).toHaveBeenLastCalledWith(
        received.id,
        claimed.leaseRunId,
        IM_LEDGER_PROVIDER_DELIVERY_LEASE_MS
      )
      await expect(postRuntimeWebhook(runtime, deliveryUrl, {
        ...receipt,
        phase: 'renew',
        leaseRunId: 'wrong-owner'
      })).resolves.toMatchObject({ status: 409, body: { ok: false } })
      await expect(postRuntimeWebhook(runtime, deliveryUrl, { ...receipt, phase: 'renew' }))
        .resolves.toMatchObject({ status: 200, body: { ok: true, phase: 'renew' } })
      expect(renewLease).toHaveBeenLastCalledWith(
        received.id,
        claimed.leaseRunId,
        IM_LEDGER_PROVIDER_DELIVERY_LEASE_MS
      )
      await expect(postRuntimeWebhook(runtime, deliveryUrl, { ...receipt, phase: 'complete', ok: true }))
        .resolves.toMatchObject({ status: 200, body: { ok: true, status: 'delivered' } })
      await expect(postRuntimeWebhook(runtime, deliveryUrl, { ...receipt, phase: 'complete', ok: true }))
        .resolves.toMatchObject({ status: 200, body: { ok: true, alreadyDelivered: true } })

      expect(markDelivered).toHaveBeenCalledTimes(1)
      expect(ledger.getById(received.id)).toMatchObject({
        status: 'delivered',
        leaseRunId: undefined,
        leaseUntil: undefined
      })
    } finally {
      ledger.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects stale delivery owners and preserves unknown provider failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workwise-im-delivery-owner-'))
    const ledger = new ImDeliveryLedger(join(root, 'messages.sqlite3'))
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest: vi.fn() as never,
        logError: () => undefined,
        imLedger: ledger
      })
      const received = ledger.receive({
        provider: 'weixin', accountId: 'wx-owner', channelId: 'channel_weixin',
        remoteMessageId: 'wx-owner-message', chatId: 'wx-user', senderId: 'wx-user',
        threadId: '', prompt: 'owner test', payloadJson: '{}',
        idempotencyKey: 'im:weixin:wx-owner:wx-owner-message'
      })
      const expiredAt = new Date(Date.now() - 5_000).toISOString()
      ledger.claim(received.id, 'old-owner', 1_000, expiredAt)
      const current = ledger.claim(received.id, 'current-owner')!
      const outboundId = `ww_${createHash('sha256')
        .update(`${received.idempotencyKey}:reply`)
        .digest('hex')
        .slice(0, 32)}`
      ledger.markResultReady(received.id, JSON.stringify({
        ok: true,
        reply: 'retry me',
        deliveryId: received.id,
        outboundId,
        deliveryLeaseRunId: current.leaseRunId
      }), undefined, new Date().toISOString(), current.leaseRunId)
      const deliveryUrl = `${settings.claw.im.path.replace(/\/$/, '')}/delivery`
      const base = { deliveryId: received.id, outboundId }

      await expect(postRuntimeWebhook(runtime, deliveryUrl, {
        ...base,
        phase: 'renew',
        leaseRunId: 'old-owner'
      })).resolves.toMatchObject({ status: 409, body: { ok: false } })
      await expect(postRuntimeWebhook(runtime, deliveryUrl, {
        ...base,
        phase: 'complete',
        leaseRunId: 'old-owner',
        ok: true
      })).resolves.toMatchObject({ status: 409, body: { ok: false } })
      await expect(postRuntimeWebhook(runtime, deliveryUrl, {
        ...base,
        phase: 'start',
        leaseRunId: current.leaseRunId
      })).resolves.toMatchObject({ status: 200, body: { ok: true, phase: 'start' } })
      await expect(postRuntimeWebhook(runtime, deliveryUrl, {
        ...base,
        phase: 'complete',
        leaseRunId: current.leaseRunId,
        ok: false,
        message: 'provider unavailable'
      })).resolves.toMatchObject({ status: 200, body: { ok: true, status: 'delivery_unknown' } })

      expect(ledger.getById(received.id)).toMatchObject({
        status: 'delivery_unknown',
        retryCount: 0,
        errorMessage: 'provider unavailable',
        leaseRunId: undefined,
        nextAttemptAt: undefined
      })
    } finally {
      ledger.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers webhook /status from the current local WeChat bridge without calling Runtime', async () => {
    const settings = buildSettings()
    settings.locale = 'zh'
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      platformCredential: {
        kind: 'weixin',
        accountId: 'wx-account-current',
        sessionKey: 'must-not-be-returned',
        createdAt: '2026-08-14T00:00:00.000Z'
      }
    })]
    const { store } = mutableSettingsStore(settings)
    const runtimeRequest = vi.fn()
    const getWeixinBridgeAccountStatuses = vi.fn(async () => [{
      accountId: 'wx-account-current',
      status: 'connected' as const,
      message: '微信已连接。',
      updatedAt: '2026-08-14T01:02:03.000Z',
      lastSuccessfulPollAt: '2026-08-14T01:02:03.000Z'
    }])
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      getWeixinBridgeAccountStatuses
    })
    const body = JSON.stringify({
      text: '/status',
      provider: 'weixin',
      channelId: 'channel_weixin'
    })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    let responseBody = ''
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((payload: string) => {
        responseBody = payload
      })
    }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    const reply = String(JSON.parse(responseBody).reply)
    expect(reply).toContain('微信连接：已连接')
    expect(reply).toContain('最近成功轮询')
    expect(reply).toContain('未调用 AI 模型')
    expect(reply).not.toContain('must-not-be-returned')
    expect(getWeixinBridgeAccountStatuses).toHaveBeenCalledWith('wx-account-current')
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('answers Feishu /status from unified health without calling Runtime', async () => {
    const settings = buildSettings()
    settings.locale = 'zh'
    settings.claw.channels = [buildChannel()]
    const channel = settings.claw.channels[0]
    const runtimeRequest = vi.fn()
    const health = {
      channelId: channel.id,
      provider: 'feishu',
      status: 'connected',
      message: '飞书连接正常。',
      lastSuccessfulHeartbeatAt: '2026-08-14T01:02:03.000Z',
      updatedAt: '2026-08-14T01:02:03.000Z'
    }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      imHealth: { get: vi.fn(() => health) } as never
    })

    const reply = await (runtime as unknown as {
      handleIncomingImCommand(
        settingsArg: AppSettingsV1,
        input: { text: string; channel: typeof channel }
      ): Promise<string | null>
    }).handleIncomingImCommand(settings, { text: '/status', channel })

    expect(reply).toContain('飞书连接：已连接')
    expect(reply).toContain('最近成功心跳')
    expect(reply).toContain('未调用 AI 模型')
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('returns a local fallback when the WeChat status reader fails', async () => {
    const settings = buildSettings()
    settings.locale = 'zh'
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      platformCredential: {
        kind: 'weixin',
        accountId: 'wx-account-current',
        sessionKey: 'secret',
        createdAt: '2026-08-14T00:00:00.000Z'
      }
    })]
    const { store } = mutableSettingsStore(settings)
    const runtimeRequest = vi.fn()
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      getWeixinBridgeAccountStatuses: vi.fn(async () => {
        throw new Error('status file unavailable')
      })
    })
    const body = JSON.stringify({ text: '/status', provider: 'weixin', channelId: 'channel_weixin' })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    let status = 0
    let responseBody = ''
    const res = {
      writeHead: vi.fn((nextStatus: number) => {
        status = nextStatus
      }),
      end: vi.fn((payload: string) => {
        responseBody = payload
      })
    }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    expect(status).toBe(200)
    expect(JSON.parse(responseBody)).toMatchObject({
      ok: true,
      reply: expect.stringContaining('暂时无法读取当前微信连接状态')
    })
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('records WeChat webhook conversations and returns the GUI-generated reply', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.im.responseTimeoutMs = 2_500
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      label: 'WeChat',
      threadId: '',
      conversations: []
    })]
    const { current, store } = mutableSettingsStore(settings)
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads' && init?.method === 'POST') {
        return { ok: true, status: 201, body: JSON.stringify({ id: 'thr_weixin' }) }
      }
      if (path === '/v1/threads/thr_weixin' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_weixin/turns' && init?.method === 'POST') {
        return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_weixin' }) }
      }
      if (path === '/v1/threads/thr_weixin' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_weixin',
            status: 'idle',
            turns: [
              {
                id: 'turn_weixin',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: 'hello from GUI' }]
              }
            ]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
    })
    const body = JSON.stringify({
      text: '你好',
      provider: 'weixin',
      channelId: 'channel_weixin',
      chatId: 'wx_user_1',
      messageId: 7493584052974092000,
      senderId: 'wx_user_1',
      senderName: 'Alice'
    })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    let status = 0
    let responseBody = ''
    const res = {
      writeHead: vi.fn((nextStatus: number) => {
        status = nextStatus
      }),
      end: vi.fn((payload: string) => {
        responseBody = payload
      })
    }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    expect(status).toBe(200)
    expect(JSON.parse(responseBody)).toMatchObject({
      ok: true,
      reply: 'hello from GUI'
    })
    expect(current().claw.channels[0].threadId).toBe('thr_weixin')
    expect(current().claw.channels[0].conversations[0]).toMatchObject({
      chatId: 'wx_user_1',
      latestMessageId: '7493584052974092000',
      senderId: 'wx_user_1',
      senderName: 'Alice',
      localThreadId: 'thr_weixin'
    })
    const turnCall = runtimeRequest.mock.calls.find(
      ([, path, init]) => path === '/v1/threads/thr_weixin/turns' && init?.method === 'POST'
    )
    expect(turnCall).toBeDefined()
    expect(JSON.parse(String(turnCall?.[2]?.body ?? '{}'))).toMatchObject({
      disableUserInput: true,
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access',
      idempotencyKey: 'im:weixin:channel_weixin:7493584052974092000'
    })
  })

  it('creates a separate Runtime thread for a previously unseen remote WeChat conversation', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.im.responseTimeoutMs = 2_500
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      label: 'WeChat',
      threadId: 'thr_existing',
      conversations: [buildConversation({
        chatId: 'wx_existing_chat',
        localThreadId: 'thr_existing'
      })]
    })]
    const { current, store } = mutableSettingsStore(settings)
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads' && init?.method === 'POST') {
        return { ok: true, status: 201, body: JSON.stringify({ id: 'thr_new_chat' }) }
      }
      if (path === '/v1/threads/thr_new_chat' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_new_chat/turns' && init?.method === 'POST') {
        return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_new_chat' }) }
      }
      if (path === '/v1/threads/thr_new_chat' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_new_chat',
            status: 'idle',
            turns: [{
              id: 'turn_new_chat',
              status: 'completed',
              items: [{ kind: 'assistant_text', text: 'new chat reply' }]
            }]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
    })
    const body = JSON.stringify({
      text: '来自另一个微信会话',
      provider: 'weixin',
      channelId: 'channel_weixin',
      chatId: 'wx_new_chat',
      messageId: 'wx_new_message',
      senderId: 'wx_new_sender',
      senderName: 'Bob'
    })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    let responseBody = ''
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((payload: string) => {
        responseBody = payload
      })
    }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    expect(JSON.parse(responseBody)).toMatchObject({ ok: true, reply: 'new chat reply' })
    expect(runtimeRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      '/v1/threads/thr_existing/turns',
      expect.anything()
    )
    expect(current().claw.channels[0].conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ chatId: 'wx_existing_chat', localThreadId: 'thr_existing' }),
      expect.objectContaining({ chatId: 'wx_new_chat', localThreadId: 'thr_new_chat' })
    ]))
  })

  it('detaches an inbound WeChat conversation from a shared legacy thread and workspace', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.im.responseTimeoutMs = 2_500
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      label: 'WeChat',
      threadId: 'thr_shared',
      conversations: [
        buildConversation({
          id: 'conversation_at',
          chatId: 'same@im.wechat',
          localThreadId: 'thr_shared',
          workspaceRoot: '/tmp/workspace/conversations/same-im.wechat'
        }),
        buildConversation({
          id: 'conversation_dash',
          chatId: 'same-im.wechat',
          localThreadId: 'thr_shared',
          workspaceRoot: '/tmp/workspace/conversations/same-im.wechat'
        })
      ]
    })]
    const { current, store } = mutableSettingsStore(settings)
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads' && init?.method === 'POST') {
        return { ok: true, status: 201, body: JSON.stringify({ id: 'thr_isolated_at' }) }
      }
      if (path === '/v1/threads/thr_isolated_at' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_isolated_at/turns' && init?.method === 'POST') {
        return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_isolated_at' }) }
      }
      if (path === '/v1/threads/thr_isolated_at' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_isolated_at',
            status: 'idle',
            turns: [{
              id: 'turn_isolated_at',
              status: 'completed',
              items: [{ kind: 'assistant_text', text: 'isolated reply' }]
            }]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
    })
    const body = JSON.stringify({
      text: '隔离旧会话',
      provider: 'weixin',
      channelId: 'channel_weixin',
      chatId: 'same@im.wechat',
      messageId: 'wx_isolate_message',
      senderId: 'wx_isolate_sender',
      senderName: 'Alice'
    })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    const res = { writeHead: vi.fn(), end: vi.fn() }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    const atConversation = current().claw.channels[0].conversations.find((item) => item.id === 'conversation_at')
    const dashConversation = current().claw.channels[0].conversations.find((item) => item.id === 'conversation_dash')
    expect(atConversation).toMatchObject({ localThreadId: 'thr_isolated_at' })
    expect(atConversation?.workspaceRoot).toMatch(/^\/tmp\/workspace\/conversations\/same-im\.wechat-[0-9a-f]{12}$/)
    expect(atConversation?.workspaceRoot).not.toBe(dashConversation?.workspaceRoot)
    expect(dashConversation).toMatchObject({
      localThreadId: 'thr_shared',
      workspaceRoot: '/tmp/workspace/conversations/same-im.wechat'
    })
    expect(runtimeRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      '/v1/threads/thr_shared/turns',
      expect.anything()
    )
  })

  it('sends the channel intro before handling the first Feishu message', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({ welcomeSentAt: '' })]
    const { current, store } = mutableSettingsStore(settings)
    const send = vi.fn(async () => ({ messageId: 'om_sent' }))
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined
    })
    ;(runtime as unknown as { feishuChannels: Map<string, { send: typeof send }> })
      .feishuChannels
      .set('channel_1', { send })

    await (runtime as unknown as {
      handleFeishuMessage: (channelId: string, message: {
        chatId: string
        messageId: string
        senderId: string
        senderName?: string
        chatType: 'p2p' | 'group'
        mentionedBot: boolean
        mentionAll: boolean
        content: string
        rawContentType: string
        mentions: unknown[]
      }) => Promise<void>
    }).handleFeishuMessage('channel_1', {
      chatId: 'oc_chat_a',
      messageId: 'om_inbound',
      senderId: 'ou_1',
      senderName: 'Alice',
      chatType: 'p2p',
      mentionedBot: false,
      mentionAll: false,
      content: '/help',
      rawContentType: 'text',
      mentions: []
    })

    expect(send).toHaveBeenCalledTimes(2)
    const welcomeCall = send.mock.calls[0] as unknown as [string, { markdown?: string }, Record<string, unknown>]
    expect(welcomeCall[0]).toBe('oc_chat_a')
    expect(welcomeCall[1].markdown).toContain('RailWise AI Runtime')
    expect(welcomeCall[1].markdown).toContain('`/new`')
    expect(welcomeCall[1].markdown).toContain('`/model`')
    expect(welcomeCall[2]).toEqual({})
    expect(current().claw.channels[0].welcomeSentAt).toBeTruthy()

    send.mockClear()
    await (runtime as unknown as {
      handleFeishuMessage: (channelId: string, message: Record<string, unknown>) => Promise<void>
    }).handleFeishuMessage('channel_1', {
      chatId: 'oc_chat_a',
      messageId: 'om_inbound_2',
      senderId: 'ou_1',
      senderName: 'Alice',
      chatType: 'p2p',
      mentionedBot: false,
      mentionAll: false,
      content: '/help',
      rawContentType: 'text',
      mentions: []
    })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('pushes the WeChat intro as its own message on first contact and keeps the reply clean', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.im.responseTimeoutMs = 2_500
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      label: 'WeChat',
      threadId: '',
      conversations: [],
      welcomeSentAt: '',
      platformCredential: {
        kind: 'weixin',
        accountId: 'acc_1',
        sessionKey: 'sess_1',
        createdAt: '2026-06-02T00:00:00.000Z'
      }
    })]
    const { current, store } = mutableSettingsStore(settings)
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads' && init?.method === 'POST') {
        return { ok: true, status: 201, body: JSON.stringify({ id: 'thr_weixin' }) }
      }
      if (path === '/v1/threads/thr_weixin' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_weixin/turns' && init?.method === 'POST') {
        return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_weixin' }) }
      }
      if (path === '/v1/threads/thr_weixin' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_weixin',
            status: 'idle',
            turns: [
              {
                id: 'turn_weixin',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: 'hello from GUI' }]
              }
            ]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const sendWeixinBridgeMessage = vi.fn(async () => ({ ok: true as const, messageId: 'wx_out_1' }))
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      sendWeixinBridgeMessage,
      createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
    })
    const body = JSON.stringify({
      text: '你好',
      provider: 'weixin',
      channelId: 'channel_weixin',
      chatId: 'wx_user_1',
      messageId: 'wx_msg_1',
      senderId: 'wx_user_1',
      senderName: 'Alice'
    })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    let status = 0
    let responseBody = ''
    const res = {
      writeHead: vi.fn((nextStatus: number) => {
        status = nextStatus
      }),
      end: vi.fn((payload: string) => {
        responseBody = payload
      })
    }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    expect(status).toBe(200)
    expect(JSON.parse(responseBody)).toMatchObject({ ok: true, reply: 'hello from GUI' })
    expect(sendWeixinBridgeMessage).toHaveBeenCalledTimes(1)
    expect(sendWeixinBridgeMessage).toHaveBeenCalledWith({
      accountId: 'acc_1',
      to: 'wx_user_1',
      text: expect.stringContaining('`/new`')
    })
    expect(current().claw.channels[0].welcomeSentAt).toBeTruthy()
  })

  it('prepends the intro to the first webhook reply when no push channel exists', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.im.responseTimeoutMs = 2_500
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      label: 'WeChat',
      threadId: '',
      conversations: [],
      welcomeSentAt: ''
    })]
    const { current, store } = mutableSettingsStore(settings)
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads' && init?.method === 'POST') {
        return { ok: true, status: 201, body: JSON.stringify({ id: 'thr_weixin' }) }
      }
      if (path === '/v1/threads/thr_weixin' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_weixin/turns' && init?.method === 'POST') {
        return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_weixin' }) }
      }
      if (path === '/v1/threads/thr_weixin' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_weixin',
            status: 'idle',
            turns: [
              {
                id: 'turn_weixin',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: 'hello from GUI' }]
              }
            ]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
    })
    const body = JSON.stringify({
      text: '你好',
      provider: 'weixin',
      channelId: 'channel_weixin',
      chatId: 'wx_user_1',
      messageId: 'wx_msg_1',
      senderId: 'wx_user_1',
      senderName: 'Alice'
    })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    let responseBody = ''
    const res = {
      writeHead: vi.fn(),
      end: vi.fn((payload: string) => {
        responseBody = payload
      })
    }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    const reply = String(JSON.parse(responseBody).reply)
    expect(reply).toContain('RailWise AI Runtime')
    expect(reply).toContain('`/new`')
    expect(reply.endsWith('hello from GUI')).toBe(true)
    expect(current().claw.channels[0].welcomeSentAt).toBeTruthy()
  })

  it('greets the WeChat owner right after the channel is first connected', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      welcomeSentAt: '',
      platformCredential: {
        kind: 'weixin',
        accountId: 'acc_1',
        sessionKey: 'sess_1',
        createdAt: '2026-06-02T00:00:00.000Z'
      }
    })]
    const { current, store } = mutableSettingsStore(settings)
    const sendWeixinBridgeMessage = vi.fn(async () => ({ ok: true as const, messageId: 'wx_out_1' }))
    const resolveWeixinAccountUserId = vi.fn(async () => 'owner_1')
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      sendWeixinBridgeMessage,
      resolveWeixinAccountUserId
    })

    const internals = runtime as unknown as {
      syncWeixinConnectWelcomes: (settings: AppSettingsV1) => Promise<void>
    }
    await internals.syncWeixinConnectWelcomes(settings)

    expect(resolveWeixinAccountUserId).toHaveBeenCalledWith('acc_1')
    expect(sendWeixinBridgeMessage).toHaveBeenCalledTimes(1)
    expect(sendWeixinBridgeMessage).toHaveBeenCalledWith({
      accountId: 'acc_1',
      to: 'owner_1',
      text: expect.stringContaining('`/help`')
    })
    expect(current().claw.channels[0].welcomeSentAt).toBeTruthy()

    await internals.syncWeixinConnectWelcomes(current())
    expect(sendWeixinBridgeMessage).toHaveBeenCalledTimes(1)
  })

  it('waits for the current WeChat turn to complete before returning the final reply', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.im.responseTimeoutMs = 2_500
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      label: 'WeChat',
      threadId: '',
      conversations: []
    })]
    const { store } = mutableSettingsStore(settings)
    let getCount = 0
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads' && init?.method === 'POST') {
        return { ok: true, status: 201, body: JSON.stringify({ id: 'thr_weixin' }) }
      }
      if (path === '/v1/threads/thr_weixin' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_weixin/turns' && init?.method === 'POST') {
        return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_weixin' }) }
      }
      if (path === '/v1/threads/thr_weixin' && init?.method === 'GET') {
        getCount += 1
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(getCount === 1
            ? {
                id: 'thr_weixin',
                status: 'running',
                turns: [
                  {
                    id: 'turn_previous',
                    status: 'completed',
                    items: [{ kind: 'assistant_text', text: 'previous reply' }]
                  },
                  {
                    id: 'turn_weixin',
                    status: 'running',
                    items: [
                      { kind: 'assistant_text', text: 'intermediate reply' },
                      { kind: 'tool_call', detail: 'checking disk usage' }
                    ]
                  }
                ]
              }
            : {
                id: 'thr_weixin',
                status: 'idle',
                turns: [
                  {
                    id: 'turn_previous',
                    status: 'completed',
                    items: [{ kind: 'assistant_text', text: 'previous reply' }]
                  },
                  {
                    id: 'turn_weixin',
                    status: 'completed',
                    items: [
                      { kind: 'assistant_text', text: 'intermediate reply' },
                      { kind: 'tool_result', detail: 'tool finished' },
                      { kind: 'assistant_text', text: 'final result' }
                    ]
                  }
                ]
              })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
    })
    const body = JSON.stringify({
      text: 'clean disk',
      provider: 'weixin',
      channelId: 'channel_weixin',
      chatId: 'wx_user_1',
      messageId: 'wx_msg_1',
      senderId: 'wx_user_1',
      senderName: 'Alice'
    })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    let status = 0
    let responseBody = ''
    const res = {
      writeHead: vi.fn((nextStatus: number) => {
        status = nextStatus
      }),
      end: vi.fn((payload: string) => {
        responseBody = payload
      })
    }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    expect(status).toBe(200)
    expect(JSON.parse(responseBody)).toMatchObject({
      ok: true,
      reply: 'final result'
    })
    expect(getCount).toBe(2)
  })

  it('does not return a previous WeChat session reply for a new turn', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.im.responseTimeoutMs = 10
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      label: 'WeChat',
      threadId: 'thr_weixin',
      conversations: [buildConversation({
        chatId: 'wx_user_1',
        latestMessageId: 'wx_previous',
        senderId: 'wx_user_1',
        senderName: 'Alice',
        localThreadId: 'thr_weixin'
      })]
    })]
    const { store } = mutableSettingsStore(settings)
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads/thr_weixin/turns' && init?.method === 'POST') {
        return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_current' }) }
      }
      if (path === '/v1/threads/thr_weixin' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_weixin',
            status: 'idle',
            turns: [
              {
                id: 'turn_previous',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: 'previous reply' }]
              },
              {
                id: 'turn_current',
                status: 'completed',
                items: []
              }
            ]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
    })
    const body = JSON.stringify({
      text: 'new question',
      provider: 'weixin',
      channelId: 'channel_weixin',
      chatId: 'wx_user_1',
      messageId: 'wx_msg_2',
      senderId: 'wx_user_1',
      senderName: 'Alice'
    })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    let status = 0
    let responseBody = ''
    const res = {
      writeHead: vi.fn((nextStatus: number) => {
        status = nextStatus
      }),
      end: vi.fn((payload: string) => {
        responseBody = payload
      })
    }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    expect(status).toBe(500)
    expect(JSON.parse(responseBody)).toMatchObject({
      ok: false,
      message: 'The task completed without text or files to deliver.'
    })
  })

  it('does not treat an in-progress assistant message as a completed result after timeout', async () => {
    vi.useFakeTimers()
    try {
      const settings = buildSettings()
      const runtimeRequest = vi.fn(async (_settings, path, init) => {
        if (path === '/v1/threads/thr_progress' && init?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              id: 'thr_progress',
              status: 'running',
              turns: [{
                id: 'turn_progress',
                status: 'running',
                items: [{ kind: 'assistant_text', text: '我来搜索一下最新动态。' }]
              }]
            })
          }
        }
        throw new Error(`unexpected path ${path}`)
      })
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest: runtimeRequest as never,
        logError: () => undefined
      })
      const pending = (runtime as unknown as {
        waitForAssistantResult: (
          settingsArg: AppSettingsV1,
          threadId: string,
          turnId: string,
          timeoutMs: number
        ) => Promise<{ text: string }>
      }).waitForAssistantResult(settings, 'thr_progress', 'turn_progress', 2_000)

      const rejected = expect(pending).rejects.toThrow('Timed out waiting for agent response.')
      await vi.advanceTimersByTimeAsync(3_000)
      await rejected
      expect(runtimeRequest).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns an explicit WeChat failure without replaying historical text when web access fails', async () => {
    const settings = buildSettings()
    settings.locale = 'zh'
    settings.claw.im.enabled = true
    settings.claw.im.responseTimeoutMs = 2_000
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      label: 'WeChat',
      threadId: 'thr_weixin',
      conversations: [buildConversation({
        chatId: 'wx_user_1',
        latestMessageId: 'wx_previous',
        senderId: 'wx_user_1',
        senderName: 'Alice',
        localThreadId: 'thr_weixin'
      })]
    })]
    const { store } = mutableSettingsStore(settings)
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads/thr_weixin/turns' && init?.method === 'POST') {
        return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_current' }) }
      }
      if (path === '/v1/threads/thr_weixin' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_weixin',
            status: 'idle',
            turns: [
              {
                id: 'turn_previous',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: 'previous reply' }]
              },
              {
                id: 'turn_current',
                status: 'failed',
                error: '在线搜索连续失败，无法核实当前资讯。本次任务未完成，请稍后重试或提供可访问的信息来源。',
                items: [{ kind: 'assistant_text', text: '我无法核实实时资讯。' }]
              }
            ]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: runtimeRequest as never,
      logError: () => undefined,
      createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
    })
    const body = JSON.stringify({
      text: 'new question',
      provider: 'weixin',
      channelId: 'channel_weixin',
      chatId: 'wx_user_1',
      messageId: 'wx_msg_2',
      senderId: 'wx_user_1',
      senderName: 'Alice'
    })
    const req = {
      method: 'POST',
      url: settings.claw.im.path,
      headers: {},
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(body)
      }
    }
    let status = 0
    let responseBody = ''
    const res = {
      writeHead: vi.fn((nextStatus: number) => {
        status = nextStatus
      }),
      end: vi.fn((payload: string) => {
        responseBody = payload
      })
    }

    await (runtime as unknown as {
      handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
    }).handleWebhook(req, res)

    expect(status).toBe(500)
    expect(JSON.parse(responseBody)).toMatchObject({
      ok: false,
      message: expect.stringContaining('任务未完成')
    })
    expect(responseBody).not.toContain('previous reply')
  })

  it('mirrors local user messages to WeChat with a stable turn-scoped outbound id', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      threadId: 'thr_weixin',
      platformCredential: {
        kind: 'weixin',
        accountId: 'wx_account',
        sessionKey: 'wx_session',
        createdAt: '2026-06-02T00:00:00.000Z'
      },
      conversations: [buildConversation({
        chatId: 'wx_user_1',
        localThreadId: 'thr_weixin'
      })]
    })]
    const sendWeixinBridgeMessage = vi.fn(async () => ({
      ok: true as const,
      messageId: 'wx_out_1'
    }))
    const imHealth = { outbound: vi.fn() }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      sendWeixinBridgeMessage,
      imHealth: imHealth as never
    })

    const result = await runtime.mirrorThreadMessageToIm(
      'thr_weixin',
      'hello from local',
      'user',
      { turnId: 'turn_local_user', requestText: 'hello from local' }
    )

    expect(result).toEqual({ ok: true })
    expect(sendWeixinBridgeMessage).toHaveBeenCalledWith({
      accountId: 'wx_account',
      to: 'wx_user_1',
      text: 'hello from local',
      clientId: expect.stringMatching(/^ww_mirror_[0-9a-f]{32}$/)
    })
    expect(imHealth.outbound).toHaveBeenCalledWith('channel_weixin')
  })

  it('blocks candidate Feishu local mirroring outside the exact allowed chat', async () => {
    const previousCandidate = process.env.WORKWISE_CANDIDATE
    const previousOutbound = process.env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED
    const previousProvider = process.env.WORKWISE_CANDIDATE_OUTBOUND_PROVIDER
    const previousChatId = process.env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_CHAT_ID
    process.env.WORKWISE_CANDIDATE = '1'
    process.env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED = '0'
    process.env.WORKWISE_CANDIDATE_OUTBOUND_PROVIDER = 'feishu'
    process.env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_CHAT_ID = 'oc_self_test'
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.channels = [buildChannel({
        id: 'channel_feishu',
        threadId: 'thr_feishu',
        platformCredential: {
          kind: 'feishu',
          appId: 'app-id',
          domain: 'feishu',
          createdAt: '2026-06-02T00:00:00.000Z'
        },
        conversations: [buildConversation({
          chatId: 'oc_chat_a',
          localThreadId: 'thr_feishu'
        })]
      })]
      const create = vi.fn()
      const send = vi.fn()
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest: vi.fn() as never,
        logError: () => undefined
      })
      ;(runtime as unknown as { feishuChannels: Map<string, unknown> }).feishuChannels.set('channel_feishu', {
        send,
        rawClient: { im: { v1: { message: { create }, file: { create } } } }
      })

      await expect(runtime.mirrorThreadMessageToIm('thr_feishu', 'candidate message', 'assistant'))
        .resolves.toEqual({ ok: false, message: 'Candidate IM outbound is disabled.' })
      expect(send).not.toHaveBeenCalled()
      expect(create).not.toHaveBeenCalled()
    } finally {
      if (previousCandidate === undefined) delete process.env.WORKWISE_CANDIDATE
      else process.env.WORKWISE_CANDIDATE = previousCandidate
      if (previousOutbound === undefined) delete process.env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED
      else process.env.WORKWISE_CANDIDATE_OUTBOUND_DISABLED = previousOutbound
      if (previousProvider === undefined) delete process.env.WORKWISE_CANDIDATE_OUTBOUND_PROVIDER
      else process.env.WORKWISE_CANDIDATE_OUTBOUND_PROVIDER = previousProvider
      if (previousChatId === undefined) delete process.env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_CHAT_ID
      else process.env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_CHAT_ID = previousChatId
    }
  })

  it('ignores candidate Feishu input outside the explicit acceptance command without starting a Turn', async () => {
    const previousCandidate = process.env.WORKWISE_CANDIDATE
    const previousInboundDisabled = process.env.WORKWISE_CANDIDATE_INBOUND_DISABLED
    const previousInboundProvider = process.env.WORKWISE_CANDIDATE_INBOUND_PROVIDER
    const previousChatId = process.env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_CHAT_ID
    const previousCommand = process.env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_COMMAND
    process.env.WORKWISE_CANDIDATE = '1'
    process.env.WORKWISE_CANDIDATE_INBOUND_DISABLED = '0'
    process.env.WORKWISE_CANDIDATE_INBOUND_PROVIDER = 'feishu'
    process.env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_CHAT_ID = 'oc_self_test'
    process.env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_COMMAND = '/status'
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.channels = [buildChannel()]
      const runtimeRequest = vi.fn()
      const send = vi.fn()
      const logError = vi.fn()
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest: runtimeRequest as never,
        logError
      })
      ;(runtime as unknown as { feishuChannels: Map<string, { send: typeof send }> })
        .feishuChannels
        .set('channel_1', { send })

      await (runtime as unknown as {
        handleFeishuMessage: (channelId: string, message: Record<string, unknown>) => Promise<void>
      }).handleFeishuMessage('channel_1', {
        chatId: 'oc_self_test',
        messageId: 'om_unapproved',
        senderId: 'ou_1',
        chatType: 'p2p',
        mentionedBot: false,
        mentionAll: false,
        content: 'make a presentation',
        rawContentType: 'text',
        mentions: []
      })

      expect(runtimeRequest).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
      expect(logError).toHaveBeenCalledWith('claw-feishu', 'Candidate Feishu message ignored by the inbound safety gate.', expect.objectContaining({
        chatId: 'oc_self_test',
        messageId: 'om_unapproved'
      }))
    } finally {
      if (previousCandidate === undefined) delete process.env.WORKWISE_CANDIDATE
      else process.env.WORKWISE_CANDIDATE = previousCandidate
      if (previousInboundDisabled === undefined) delete process.env.WORKWISE_CANDIDATE_INBOUND_DISABLED
      else process.env.WORKWISE_CANDIDATE_INBOUND_DISABLED = previousInboundDisabled
      if (previousInboundProvider === undefined) delete process.env.WORKWISE_CANDIDATE_INBOUND_PROVIDER
      else process.env.WORKWISE_CANDIDATE_INBOUND_PROVIDER = previousInboundProvider
      if (previousChatId === undefined) delete process.env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_CHAT_ID
      else process.env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_CHAT_ID = previousChatId
      if (previousCommand === undefined) delete process.env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_COMMAND
      else process.env.WORKWISE_CANDIDATE_ALLOWED_FEISHU_COMMAND = previousCommand
    }
  })

  it('ignores candidate WeChat webhooks outside the explicit acceptance gate before writing the ledger', async () => {
    const previousCandidate = process.env.WORKWISE_CANDIDATE
    const previousInboundDisabled = process.env.WORKWISE_CANDIDATE_INBOUND_DISABLED
    const previousInboundProvider = process.env.WORKWISE_CANDIDATE_INBOUND_PROVIDER
    const previousChatId = process.env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_CHAT_ID
    const previousCommand = process.env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_COMMAND
    process.env.WORKWISE_CANDIDATE = '1'
    process.env.WORKWISE_CANDIDATE_INBOUND_DISABLED = '0'
    process.env.WORKWISE_CANDIDATE_INBOUND_PROVIDER = 'feishu'
    delete process.env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_CHAT_ID
    delete process.env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_COMMAND
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.channels = [buildChannel({
        id: 'channel_weixin',
        provider: 'weixin',
        platformCredential: {
          kind: 'weixin',
          accountId: 'wx_candidate',
          sessionKey: '',
          createdAt: '2026-08-17T00:00:00.000Z'
        }
      })]
      const runtimeRequest = vi.fn()
      const createScheduledTaskFromText = vi.fn()
      const receive = vi.fn()
      const logError = vi.fn()
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest: runtimeRequest as never,
        createScheduledTaskFromText,
        imLedger: { receive } as never,
        logError
      })
      const body = JSON.stringify({
        provider: 'weixin',
        channelId: 'channel_weixin',
        chatId: 'wx_unapproved_chat',
        messageId: 'wx_unapproved_message',
        senderId: 'wx_sender',
        text: 'create a presentation'
      })
      const req = {
        method: 'POST',
        url: settings.claw.im.path,
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(body)
        }
      }
      let status = 0
      let responseBody = ''
      const res = {
        writeHead: vi.fn((nextStatus: number) => {
          status = nextStatus
        }),
        end: vi.fn((payload: string) => {
          responseBody = payload
        })
      }

      await (runtime as unknown as {
        handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
      }).handleWebhook(req, res)

      expect(status).toBe(202)
      expect(JSON.parse(responseBody)).toEqual({ ok: true, ignored: true })
      expect(receive).not.toHaveBeenCalled()
      expect(createScheduledTaskFromText).not.toHaveBeenCalled()
      expect(runtimeRequest).not.toHaveBeenCalled()
      expect(logError).toHaveBeenCalledWith(
        'claw-webhook',
        'Candidate IM webhook ignored by the inbound safety gate.',
        expect.objectContaining({
          provider: 'weixin',
          channelId: 'channel_weixin',
          chatId: 'wx_unapproved_chat',
          messageId: 'wx_unapproved_message'
        })
      )
    } finally {
      if (previousCandidate === undefined) delete process.env.WORKWISE_CANDIDATE
      else process.env.WORKWISE_CANDIDATE = previousCandidate
      if (previousInboundDisabled === undefined) delete process.env.WORKWISE_CANDIDATE_INBOUND_DISABLED
      else process.env.WORKWISE_CANDIDATE_INBOUND_DISABLED = previousInboundDisabled
      if (previousInboundProvider === undefined) delete process.env.WORKWISE_CANDIDATE_INBOUND_PROVIDER
      else process.env.WORKWISE_CANDIDATE_INBOUND_PROVIDER = previousInboundProvider
      if (previousChatId === undefined) delete process.env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_CHAT_ID
      else process.env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_CHAT_ID = previousChatId
      if (previousCommand === undefined) delete process.env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_COMMAND
      else process.env.WORKWISE_CANDIDATE_ALLOWED_WEIXIN_COMMAND = previousCommand
    }
  })

  it('blocks local mirroring when one Runtime thread is bound to multiple remote chats', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      provider: 'weixin' as const,
      id: 'channel_weixin',
      threadId: 'thr_shared',
      platformCredential: {
        kind: 'weixin',
        accountId: 'wx_account',
        sessionKey: 'wx_session',
        createdAt: '2026-06-02T00:00:00.000Z'
      },
      conversations: [
        buildConversation({ id: 'conversation_a', chatId: 'wx_chat_a', localThreadId: 'thr_shared' }),
        buildConversation({ id: 'conversation_b', chatId: 'wx_chat_b', localThreadId: 'thr_shared' })
      ]
    })]
    const sendWeixinBridgeMessage = vi.fn(async () => ({ ok: true as const, messageId: 'unexpected' }))
    const logError = vi.fn()
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError,
      sendWeixinBridgeMessage
    })

    await expect(runtime.mirrorThreadMessageToIm('thr_shared', 'do not misroute', 'assistant')).resolves.toEqual({
      ok: false,
      message: 'This Runtime conversation is bound to multiple phone chats. Sending was blocked to prevent delivery to the wrong chat.'
    })
    expect(sendWeixinBridgeMessage).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'claw-im',
      'Blocked outbound mirror because the Runtime thread has multiple remote targets.',
      expect.objectContaining({ threadId: 'thr_shared', targetCount: 2 })
    )
  })

  it('mirrors generated files from a completed local turn to WeChat with one stable outbound id', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workwise-weixin-local-mirror-'))
    const filePath = join(workspaceRoot, 'wechat-cdn-roundtrip.txt')
    await writeFile(filePath, 'WECHAT-CDN-ROUNDTRIP')
    const realFilePath = await realpath(filePath)
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.channels = [buildChannel({
        provider: 'weixin' as const,
        id: 'channel_weixin',
        threadId: 'thr_weixin',
        platformCredential: {
          kind: 'weixin',
          accountId: 'wx_account',
          sessionKey: 'wx_session',
          createdAt: '2026-06-02T00:00:00.000Z'
        },
        conversations: [buildConversation({
          chatId: 'wx_user_1',
          localThreadId: 'thr_weixin',
          workspaceRoot
        })]
      })]
      const runtimeRequest = vi.fn(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: 'thr_weixin',
          turns: [{
            id: 'turn_file',
            status: 'completed',
            items: [{
              kind: 'tool_result',
              toolKind: 'command_execution',
              status: 'completed',
              output: {
                exit_code: 0,
                output: `created\n${realFilePath}\n`
              }
            }]
          }]
        })
      }))
      const sendWeixinBridgeMessage = vi.fn(async () => ({
        ok: true as const,
        messageId: 'wx_out_file'
      }))
      const imHealth = { outbound: vi.fn() }
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest,
        logError: () => undefined,
        sendWeixinBridgeMessage,
        imHealth: imHealth as never
      })

      const result = await runtime.mirrorThreadMessageToIm(
        'thr_weixin',
        '我无法把文件作为附件发送。',
        'assistant',
        { turnId: 'turn_file', requestText: '请创建 TXT 并作为附件发送给我' }
      )

      expect(result).toEqual({ ok: true })
      expect(runtimeRequest).toHaveBeenCalledWith(settings, '/v1/threads/thr_weixin', { method: 'GET' })
      expect(sendWeixinBridgeMessage).toHaveBeenCalledWith({
        accountId: 'wx_account',
        to: 'wx_user_1',
        text: '文件已生成并发送：wechat-cdn-roundtrip.txt。请在当前会话中下载并打开附件。',
        clientId: expect.stringMatching(/^ww_mirror_[0-9a-f]{32}$/),
        files: [{ path: realFilePath, fileName: 'wechat-cdn-roundtrip.txt' }]
      })
      expect(imHealth.outbound).toHaveBeenCalledWith('channel_weixin')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('does not report a local WeChat mirror successful when its attachment fails', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workwise-weixin-local-mirror-fail-'))
    const filePath = join(workspaceRoot, 'failed.txt')
    await writeFile(filePath, 'failed')
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.channels = [buildChannel({
        provider: 'weixin' as const,
        id: 'channel_weixin',
        threadId: 'thr_weixin',
        platformCredential: {
          kind: 'weixin',
          accountId: 'wx_account',
          sessionKey: 'wx_session',
          createdAt: '2026-06-02T00:00:00.000Z'
        },
        conversations: [buildConversation({
          chatId: 'wx_user_1',
          localThreadId: 'thr_weixin',
          workspaceRoot
        })]
      })]
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest: vi.fn(async () => ({
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_weixin',
            turns: [{
              id: 'turn_file',
              status: 'completed',
              items: [{
                kind: 'tool_result',
                toolKind: 'file_change',
                output: { path: filePath }
              }]
            }]
          })
        })),
        logError: () => undefined,
        sendWeixinBridgeMessage: vi.fn(async () => ({
          ok: false as const,
          message: 'WeChat file delivery failed: upload rejected'
        }))
      })

      await expect(runtime.mirrorThreadMessageToIm(
        'thr_weixin',
        'done',
        'assistant',
        { turnId: 'turn_file', requestText: '把 TXT 附件发给我' }
      )).resolves.toEqual({
        ok: false,
        message: 'WeChat file delivery failed: upload rejected'
      })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('records successful local Feishu mirrors as authoritative outbound health', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel({
      conversations: [buildConversation({ localThreadId: 'thr_feishu' })]
    })]
    const send = vi.fn(async () => ({ messageId: 'om_mirror_1' }))
    const imHealth = { outbound: vi.fn() }
    const runtime = createClawRuntime({
      store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined,
      imHealth: imHealth as never
    })
    ;(runtime as unknown as { feishuChannels: Map<string, { send: typeof send }> })
      .feishuChannels.set('channel_1', { send })

    const result = await runtime.mirrorThreadMessageToIm('thr_feishu', 'hello from local', 'assistant')

    expect(result).toEqual({ ok: true })
    expect(send).toHaveBeenCalledWith('oc_chat_a', { markdown: 'hello from local' }, {})
    expect(imHealth.outbound).toHaveBeenCalledWith('channel_1')
  })

  it('mirrors generated files from a completed local turn to Feishu with stable uuids', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workwise-feishu-local-mirror-'))
    const filePath = join(workspaceRoot, 'result.txt')
    await writeFile(filePath, 'result')
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.channels = [buildChannel({
        threadId: 'thr_feishu',
        conversations: [buildConversation({
          localThreadId: 'thr_feishu',
          workspaceRoot
        })]
      })]
      const runtimeRequest = vi.fn(async () => ({
        ok: true,
        status: 200,
        body: JSON.stringify({
          id: 'thr_feishu',
          turns: [{
            id: 'turn_file',
            status: 'completed',
            items: [{
              kind: 'tool_result',
              toolKind: 'file_change',
              status: 'completed',
              output: { path: filePath }
            }]
          }]
        })
      }))
      const uploadFile = vi.fn(async () => ({ file_key: 'file_key_1' }))
      const createMessage = vi.fn(async (_request: {
        data: { uuid: string; msg_type: string; content: string }
      }) => ({ data: { message_id: 'om_out_1' } }))
      const bridge = {
        rawClient: {
          im: {
            v1: {
              file: { create: uploadFile },
              message: { create: createMessage }
            }
          }
        }
      }
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest,
        logError: () => undefined
      })
      ;(runtime as unknown as { feishuChannels: Map<string, typeof bridge> })
        .feishuChannels.set('channel_1', bridge)

      const result = await runtime.mirrorThreadMessageToIm(
        'thr_feishu',
        '文件已完成。',
        'assistant',
        { turnId: 'turn_file', requestText: '请把 TXT 文件作为附件发送给我' }
      )

      expect(result).toEqual({ ok: true })
      expect(uploadFile).toHaveBeenCalledOnce()
      expect(createMessage).toHaveBeenCalledTimes(2)
      const fileUuid = createMessage.mock.calls[0]?.[0].data.uuid
      const textUuid = createMessage.mock.calls[1]?.[0].data.uuid
      expect(textUuid).toMatch(/^ww_mirror_[0-9a-f]{32}$/)
      expect(fileUuid).toBe(`${textUuid}-file-1`)
      expect(createMessage.mock.calls[0]?.[0].data).toMatchObject({
        msg_type: 'file',
        content: JSON.stringify({ file_key: 'file_key_1' })
      })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('does not send a Feishu success text when the mirrored attachment fails', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workwise-feishu-local-mirror-fail-'))
    const filePath = join(workspaceRoot, 'failed.txt')
    await writeFile(filePath, 'failed')
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.channels = [buildChannel({
        threadId: 'thr_feishu',
        conversations: [buildConversation({ localThreadId: 'thr_feishu', workspaceRoot })]
      })]
      const createMessage = vi.fn(async (_request: {
        data: { uuid: string; msg_type: string; content: string }
      }) => ({ data: { message_id: 'om_failure_notice' } }))
      const runtime = createClawRuntime({
        store: { load: vi.fn(async () => settings), patch: vi.fn(async () => settings) } as never,
        runtimeRequest: vi.fn(async () => ({
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_feishu',
            turns: [{
              id: 'turn_file',
              status: 'completed',
              items: [{
                kind: 'tool_result',
                toolKind: 'file_change',
                status: 'completed',
                output: { path: filePath }
              }]
            }]
          })
        })),
        logError: () => undefined
      })
      ;(runtime as unknown as { feishuChannels: Map<string, unknown> }).feishuChannels.set('channel_1', {
        rawClient: {
          im: {
            v1: {
              file: { create: vi.fn(async () => { throw new Error('upload rejected') }) },
              message: { create: createMessage }
            }
          }
        }
      })

      await expect(runtime.mirrorThreadMessageToIm(
        'thr_feishu',
        '文件已完成。',
        'assistant',
        { turnId: 'turn_file', requestText: '请把 TXT 文件作为附件发送给我' }
      )).resolves.toMatchObject({ ok: false, message: expect.stringContaining('upload rejected') })
      expect(createMessage).not.toHaveBeenCalled()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('sends the latest generated workspace file to Feishu when the user asks for it', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workwise-feishu-file-'))
    const filePath = join(workspaceRoot, 'hello.md')
    await writeFile(filePath, '# Hello\n')
    const realFilePath = await realpath(filePath)
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.im.responseTimeoutMs = 2_000
      const conversation: ClawImConversationV1 = {
        id: 'conv_1',
        chatId: 'oc_chat_a',
        remoteThreadId: '',
        latestMessageId: 'om_previous',
        senderId: 'ou_1',
        senderName: 'Alice',
        localThreadId: 'thr_1',
        workspaceRoot,
        createdAt: '2026-06-02T00:00:00.000Z',
        updatedAt: '2026-06-02T00:00:00.000Z'
      }
      const channel: ClawImChannelV1 = {
        id: 'channel_1',
        provider: 'feishu' as const,
        label: 'Phone',
        enabled: true,
        model: 'auto',
        threadId: '',
        workspaceRoot,
        agentProfile: {
          name: 'kun',
          description: '',
          identity: '',
          personality: '',
          userContext: '',
          replyRules: ''
        },
        conversations: [conversation],
        welcomeSentAt: '2026-06-02T00:00:00.000Z',
        createdAt: '2026-06-02T00:00:00.000Z',
        updatedAt: '2026-06-02T00:00:00.000Z'
      }
      settings.claw.channels = [channel]
      const store = {
        load: vi.fn(async () => settings),
        patch: vi.fn(async () => settings)
      }
      const runtimeRequest = vi.fn(async (_settings, path, init) => {
        if (path === '/v1/threads/thr_1/turns') {
          return { ok: true, status: 202, body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_2' }) }
        }
        if (path === '/v1/threads/thr_1' && init?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              id: 'thr_1',
              status: 'idle',
              turns: [
                {
                  id: 'turn_1',
                  status: 'completed',
                  items: [
                    {
                      kind: 'tool_result',
                      toolKind: 'file_change',
                      output: {
                        path: filePath,
                        relative_path: 'hello.md',
                        bytes_written: 8
                      },
                      isError: false
                    }
                  ]
                },
                {
                  id: 'turn_2',
                  status: 'completed',
                  items: [
                    {
                      kind: 'assistant_text',
                      text: '我无法直接通过飞书发送文件给你，但文件已经创建在 workspace 中。'
                    }
                  ]
                }
              ]
            })
          }
        }
        throw new Error(`unexpected path ${path}`)
      })
      const send = vi.fn(async () => ({ messageId: 'om_sent' }))
      const addReaction = vi.fn(async () => 'rc_file_1')
      const runtime = createClawRuntime({
        store: store as never,
        runtimeRequest,
        logError: () => undefined
      })
      ;(runtime as unknown as { feishuChannels: Map<string, { send: typeof send, addReaction: typeof addReaction }> })
        .feishuChannels
        .set('channel_1', { send, addReaction })

      await (runtime as unknown as {
        handleFeishuMessage: (channelId: string, message: {
          chatId: string
          messageId: string
          threadId?: string
          senderId: string
          senderName?: string
          chatType: 'p2p' | 'group'
          mentionedBot: boolean
          mentionAll: boolean
          content: string
          rawContentType: string
          mentions: unknown[]
        }) => Promise<void>
      }).handleFeishuMessage('channel_1', {
        chatId: 'oc_chat_a',
        messageId: 'om_inbound',
        senderId: 'ou_1',
        senderName: 'Alice',
        chatType: 'p2p',
        mentionedBot: false,
        mentionAll: false,
        content: '发给我',
        rawContentType: 'text',
        mentions: []
      })

      expect(send).toHaveBeenNthCalledWith(
        1,
        'oc_chat_a',
        { file: { source: realFilePath, fileName: 'hello.md' } },
        { replyTo: 'om_inbound', replyInThread: false }
      )
      expect(send).toHaveBeenNthCalledWith(
        2,
        'oc_chat_a',
        { markdown: '文件已生成并发送：hello.md。请在当前会话中下载并打开附件。' },
        { replyTo: 'om_inbound', replyInThread: false }
      )
      // The direct-file path is fast (synchronous file lookup + upload) and
      // The direct-file path is fast (synchronous file lookup + upload) and
      // must NOT add a pending reaction — that would be visually noisy.
      const addReactionSpy = (runtime as unknown as { feishuChannels: Map<string, { addReaction: ReturnType<typeof vi.fn> }> })
        .feishuChannels.get('channel_1')?.addReaction
      expect(addReactionSpy).not.toHaveBeenCalled()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('sends generated image tool output to Feishu for image requests', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workwise-feishu-image-'))
    const imageDir = join(workspaceRoot, '.deepseekgui-images')
    const imagePath = join(imageDir, 'img-20260611000100-abcd.png')
    await mkdir(imageDir, { recursive: true })
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const realImagePath = await realpath(imagePath)
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.im.responseTimeoutMs = 2_000
      settings.agents.kun.imageGeneration = {
        enabled: true,
        providerId: '',
        protocol: 'openai-images',
        baseUrl: 'https://images.example.test/v1',
        apiKey: 'sk-image',
        model: 'test-image-model',
        defaultSize: '1024x1024',
        timeoutMs: 180000
      }
      settings.claw.channels = [
        buildChannel({
          threadId: 'thr_1',
          workspaceRoot,
          conversations: [buildConversation({ localThreadId: 'thr_1', workspaceRoot })]
        })
      ]
      const store = {
        load: vi.fn(async () => settings),
        patch: vi.fn(async () => settings)
      }
      const runtimeRequest = vi.fn(async (_settings, path, init) => {
        if (path === '/v1/threads/thr_1/turns') {
          const body = JSON.parse(init?.body ?? '{}') as { prompt?: string }
          expect(body.prompt).toContain('generate_image')
          return { ok: true, status: 202, body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_img' }) }
        }
        if (path === '/v1/threads/thr_1' && init?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              id: 'thr_1',
              status: 'idle',
              turns: [
                {
                  id: 'turn_img',
                  status: 'completed',
                  items: [
                    {
                      kind: 'tool_result',
                      toolName: 'generate_image',
                      toolKind: 'tool_call',
                      output: {
                        files: [{
                          absolutePath: imagePath,
                          relativePath: '.deepseekgui-images/img-20260611000100-abcd.png',
                          mimeType: 'image/png'
                        }],
                        endpoint: 'generations'
                      },
                      isError: false
                    },
                    {
                      kind: 'assistant_text',
                      text: '图片已生成。'
                    }
                  ]
                }
              ]
            })
          }
        }
        throw new Error(`unexpected path ${path}`)
      })
      const send = vi.fn(async () => ({ messageId: 'om_sent' }))
      const addReaction = vi.fn(async () => 'rc_image_1')
      const runtime = createClawRuntime({
        store: store as never,
        runtimeRequest,
        logError: () => undefined
      })
      ;(runtime as unknown as { feishuChannels: Map<string, { send: typeof send, addReaction: typeof addReaction }> })
        .feishuChannels
        .set('channel_1', { send, addReaction })

      await (runtime as unknown as {
        handleFeishuMessage: (channelId: string, message: {
          chatId: string
          messageId: string
          threadId?: string
          senderId: string
          senderName?: string
          chatType: 'p2p' | 'group'
          mentionedBot: boolean
          mentionAll: boolean
          content: string
          rawContentType: string
          mentions: unknown[]
        }) => Promise<void>
      }).handleFeishuMessage('channel_1', {
        chatId: 'oc_chat_a',
        messageId: 'om_inbound',
        senderId: 'ou_1',
        senderName: 'Alice',
        chatType: 'p2p',
        mentionedBot: false,
        mentionAll: false,
        content: '帮我生成一张图片',
        rawContentType: 'text',
        mentions: []
      })

      expect(addReaction).toHaveBeenCalledWith('om_inbound', 'OnIt')
      expect(send).toHaveBeenNthCalledWith(
        1,
        'oc_chat_a',
        { file: { source: realImagePath, fileName: 'img-20260611000100-abcd.png' } },
        { replyTo: 'om_inbound', replyInThread: false }
      )
      expect(send).toHaveBeenNthCalledWith(
        2,
        'oc_chat_a',
        { markdown: '图片已生成。' },
        { replyTo: 'om_inbound', replyInThread: false }
      )
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('returns gated generated files in the WeChat webhook reply for image requests', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workwise-weixin-image-'))
    const imageDir = join(workspaceRoot, '.deepseekgui-images')
    const imagePath = join(imageDir, 'img-20260611000200-beef.png')
    await mkdir(imageDir, { recursive: true })
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const realImagePath = await realpath(imagePath)
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.im.responseTimeoutMs = 2_000
      settings.agents.kun.imageGeneration = {
        enabled: true,
        providerId: '',
        protocol: 'openai-images',
        baseUrl: 'https://images.example.test/v1',
        apiKey: 'sk-image',
        model: 'test-image-model',
        defaultSize: '1024x1024',
        timeoutMs: 180000
      }
      settings.claw.channels = [
        buildChannel({
          provider: 'weixin' as const,
          id: 'channel_weixin',
          label: 'WeChat',
          threadId: 'thr_wx',
          conversations: [
            buildConversation({
              chatId: 'wx_user_1',
              senderId: 'wx_user_1',
              localThreadId: 'thr_wx',
              workspaceRoot
            })
          ]
        })
      ]
      const { store } = mutableSettingsStore(settings)
      const runtimeRequest = vi.fn(async (_settings, path, init) => {
        if (path === '/v1/threads/thr_wx/turns' && init?.method === 'POST') {
          const body = JSON.parse(init?.body ?? '{}') as { prompt?: string }
          expect(body.prompt).toContain('generate_image')
          return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_wx_img' }) }
        }
        if (path === '/v1/threads/thr_wx' && init?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              id: 'thr_wx',
              status: 'idle',
              turns: [
                {
                  id: 'turn_wx_img',
                  status: 'completed',
                  items: [
                    {
                      kind: 'tool_result',
                      toolName: 'generate_image',
                      toolKind: 'tool_call',
                      output: {
                        files: [{
                          absolutePath: imagePath,
                          relativePath: '.deepseekgui-images/img-20260611000200-beef.png',
                          mimeType: 'image/png'
                        }],
                        endpoint: 'generations'
                      },
                      isError: false
                    },
                    { kind: 'assistant_text', text: '图片已生成。' }
                  ]
                }
              ]
            })
          }
        }
        throw new Error(`unexpected path ${path}`)
      })
      const runtime = createClawRuntime({
        store: store as never,
        runtimeRequest: runtimeRequest as never,
        logError: () => undefined,
        createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
      })
      const body = JSON.stringify({
        text: '帮我画一张猫的图片',
        provider: 'weixin',
        channelId: 'channel_weixin',
        chatId: 'wx_user_1',
        messageId: 'wx_msg_img',
        senderId: 'wx_user_1',
        senderName: 'Alice'
      })
      const req = {
        method: 'POST',
        url: settings.claw.im.path,
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(body)
        }
      }
      let status = 0
      let responseBody = ''
      const res = {
        writeHead: vi.fn((nextStatus: number) => {
          status = nextStatus
        }),
        end: vi.fn((payload: string) => {
          responseBody = payload
        })
      }

      await (runtime as unknown as {
        handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
      }).handleWebhook(req, res)

      expect(status).toBe(200)
      const parsed = JSON.parse(responseBody)
      expect(parsed).toMatchObject({ ok: true, reply: '图片已生成。' })
      expect(parsed.files).toEqual([
        {
          path: realImagePath,
          relativePath: '.deepseekgui-images/img-20260611000200-beef.png',
          fileName: 'img-20260611000200-beef.png'
        }
      ])
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('directly sends a previously exported PPTX from the WeChat conversation workspace', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workwise-weixin-pptx-'))
    const exportDir = join(workspaceRoot, 'projects', 'guide', 'exports')
    const svgDir = join(workspaceRoot, 'projects', 'guide', 'svg_output')
    const pptxPath = join(exportDir, 'WorkWise使用指南_可编辑版.pptx')
    await mkdir(exportDir, { recursive: true })
    await mkdir(svgDir, { recursive: true })
    await writeFile(pptxPath, Buffer.from('pptx-fixture'))
    await writeFile(join(svgDir, 'slide_11.svg'), '<svg/>')
    await writeFile(join(svgDir, 'slide_12.svg'), '<svg/>')
    const realPptxPath = await realpath(pptxPath)
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.channels = [buildChannel({
        provider: 'weixin' as const,
        id: 'channel_weixin',
        label: 'WeChat',
        threadId: 'thr_wx_pptx',
        conversations: [buildConversation({
          chatId: 'wx_user_1',
          senderId: 'wx_user_1',
          localThreadId: 'thr_wx_pptx',
          workspaceRoot
        })]
      })]
      const { store } = mutableSettingsStore(settings)
      const runtimeRequest = vi.fn(async (_settings, path, init) => {
        if (path === '/v1/threads/thr_wx_pptx' && init?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              id: 'thr_wx_pptx',
              status: 'idle',
              turns: [{
                id: 'turn_wx_pptx',
                status: 'completed',
                items: [{
                  kind: 'tool_result',
                  toolKind: 'tool_call',
                  output: {
                    ok: true,
                    format: 'pptx',
                    generatedFiles: [
                      {
                        name: 'slide_11.svg',
                        path: 'projects/guide/svg_output/slide_11.svg'
                      },
                      {
                        name: 'slide_12.svg',
                        path: 'projects/guide/svg_output/slide_12.svg'
                      },
                      {
                        name: 'WorkWise使用指南_可编辑版.pptx',
                        path: 'projects/guide/exports/WorkWise使用指南_可编辑版.pptx',
                        relativePath: 'projects/guide/exports/WorkWise使用指南_可编辑版.pptx',
                        absolutePath: realPptxPath
                      }
                    ]
                  },
                  isError: false
                }, {
                  kind: 'assistant_text',
                  text: 'PPTX 已导出。'
                }]
              }]
            })
          }
        }
        throw new Error(`unexpected path ${path}`)
      })
      const runtime = createClawRuntime({
        store: store as never,
        runtimeRequest: runtimeRequest as never,
        logError: () => undefined,
        createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
      })
      const body = JSON.stringify({
        text: '把刚才的 PPTX 文件发给我',
        provider: 'weixin',
        channelId: 'channel_weixin',
        chatId: 'wx_user_1',
        messageId: 'wx_msg_send_pptx',
        senderId: 'wx_user_1',
        senderName: 'Alice'
      })
      const req = {
        method: 'POST',
        url: settings.claw.im.path,
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(body)
        }
      }
      let status = 0
      let responseBody = ''
      const res = {
        writeHead: vi.fn((nextStatus: number) => {
          status = nextStatus
        }),
        end: vi.fn((payload: string) => {
          responseBody = payload
        })
      }

      await (runtime as unknown as {
        handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
      }).handleWebhook(req, res)

      expect(status).toBe(200)
      expect(JSON.parse(responseBody)).toMatchObject({
        ok: true,
        reply: '文件已生成并发送：WorkWise使用指南_可编辑版.pptx。请在当前会话中下载并打开附件。',
        files: [{ path: realPptxPath, fileName: 'WorkWise使用指南_可编辑版.pptx' }]
      })
      expect(runtimeRequest).toHaveBeenCalledTimes(1)
      expect(runtimeRequest).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('/turns'),
        expect.anything()
      )
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('starts a new WeChat Turn instead of resending stale files when creation is requested', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'workwise-weixin-new-file-'))
    const stalePath = join(workspaceRoot, 'stale-result.txt')
    const currentPath = join(workspaceRoot, 'wechat-file-e2e-current.txt')
    await writeFile(stalePath, 'STALE')
    await writeFile(currentPath, 'WECHAT-FILE-E2E-CURRENT')
    const realCurrentPath = await realpath(currentPath)
    try {
      const settings = buildSettings()
      settings.claw.im.enabled = true
      settings.claw.im.responseTimeoutMs = 2_000
      settings.claw.channels = [buildChannel({
        provider: 'weixin' as const,
        id: 'channel_weixin',
        label: 'WeChat',
        threadId: 'thr_wx_new_file',
        conversations: [buildConversation({
          chatId: 'wx_user_1',
          senderId: 'wx_user_1',
          localThreadId: 'thr_wx_new_file',
          workspaceRoot
        })]
      })]
      const { store } = mutableSettingsStore(settings)
      const runtimeRequest = vi.fn(async (_settings, path, init) => {
        if (path === '/v1/threads/thr_wx_new_file/turns' && init?.method === 'POST') {
          return {
            ok: true,
            status: 202,
            body: JSON.stringify({ threadId: 'thr_wx_new_file', turnId: 'turn_current' })
          }
        }
        if (path === '/v1/threads/thr_wx_new_file' && init?.method === 'GET') {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              id: 'thr_wx_new_file',
              status: 'idle',
              turns: [{
                id: 'turn_stale',
                status: 'completed',
                items: [{
                  kind: 'tool_result',
                  toolKind: 'file_change',
                  output: { path: stalePath },
                  isError: false
                }]
              }, {
                id: 'turn_current',
                status: 'completed',
                items: [{
                  kind: 'tool_result',
                  toolKind: 'file_change',
                  output: { path: currentPath },
                  isError: false
                }, {
                  kind: 'assistant_text',
                  text: '本轮工具集没有发送附件工具。'
                }]
              }]
            })
          }
        }
        throw new Error(`unexpected path ${path}`)
      })
      const runtime = createClawRuntime({
        store: store as never,
        runtimeRequest: runtimeRequest as never,
        logError: () => undefined,
        createScheduledTaskFromText: vi.fn(async () => ({ kind: 'noop' as const }))
      })
      const body = JSON.stringify({
        text: '请创建内容完全等于 WECHAT-FILE-E2E-CURRENT 的 wechat-file-e2e-current.txt，并作为附件发送给我。',
        provider: 'weixin',
        channelId: 'channel_weixin',
        chatId: 'wx_user_1',
        messageId: 'wx_msg_create_current',
        senderId: 'wx_user_1',
        senderName: 'Alice'
      })
      const req = {
        method: 'POST',
        url: settings.claw.im.path,
        headers: {},
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(body)
        }
      }
      let status = 0
      let responseBody = ''
      const res = {
        writeHead: vi.fn((nextStatus: number) => {
          status = nextStatus
        }),
        end: vi.fn((payload: string) => {
          responseBody = payload
        })
      }

      await (runtime as unknown as {
        handleWebhook: (request: typeof req, response: typeof res) => Promise<void>
      }).handleWebhook(req, res)

      expect(status).toBe(200)
      expect(runtimeRequest).toHaveBeenCalledWith(
        settings,
        '/v1/threads/thr_wx_new_file/turns',
        expect.objectContaining({ method: 'POST' })
      )
      expect(JSON.parse(responseBody)).toMatchObject({
        ok: true,
        reply: '文件已生成并发送：wechat-file-e2e-current.txt。请在当前会话中下载并打开附件。',
        files: [{ path: realCurrentPath, fileName: 'wechat-file-e2e-current.txt' }]
      })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('sends agent reply containing markdown as Feishu / Lark markdown', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.im.responseTimeoutMs = 2_000
    settings.claw.channels = [buildChannel({ threadId: 'thr_1', conversations: [buildConversation({ localThreadId: 'thr_1' })] })]
    const store = {
      load: vi.fn(async () => settings),
      patch: vi.fn(async () => settings)
    }
    const markdownReply = '**bold** `code`\n- item 1\n- item 2'
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads/thr_1/turns') {
        return { ok: true, status: 202, body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_md' }) }
      }
      if (path === '/v1/threads/thr_1' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_1',
            status: 'idle',
            turns: [
              {
                id: 'turn_md',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: markdownReply }]
              }
            ]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const send = vi.fn(async () => ({ messageId: 'om_md' }))
    const addReaction = vi.fn(async () => 'rc_test_1')
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest,
      logError: () => undefined
    })
    ;(runtime as unknown as { feishuChannels: Map<string, { send: typeof send, addReaction: typeof addReaction }> })
      .feishuChannels
      .set('channel_1', { send, addReaction })

    await (runtime as unknown as {
      handleFeishuMessage: (channelId: string, message: {
        chatId: string
        messageId: string
        threadId?: string
        senderId: string
        senderName?: string
        chatType: 'p2p' | 'group'
        mentionedBot: boolean
        mentionAll: boolean
        content: string
        rawContentType: string
        mentions: unknown[]
      }) => Promise<void>
    }).handleFeishuMessage('channel_1', {
      chatId: 'oc_chat_a',
      messageId: 'om_inbound',
      senderId: 'ou_1',
      senderName: 'Alice',
      chatType: 'p2p',
      mentionedBot: false,
      mentionAll: false,
      content: 'tell me a story',
      rawContentType: 'text',
      mentions: []
    })

    // The pending reaction is added on the user's inbound message BEFORE
    // the agent reply is sent.
    expect(addReaction).toHaveBeenCalledWith('om_inbound', 'OnIt')
    expect(send).toHaveBeenCalledWith(
      'oc_chat_a',
      { markdown: markdownReply },
      { replyTo: 'om_inbound', replyInThread: false }
    )
    const textFormCall = (send.mock.calls as unknown as Array<[string, Record<string, unknown>]>)
      .find(([, input]) => typeof input?.text === 'string')
    expect(textFormCall).toBeUndefined()
  })

  it('preserves markdown and reply scope when an IM transport result is unknown', async () => {
    const send = vi.fn().mockRejectedValue(new Error('lost response'))
    const runtime = createClawRuntime({ store: { load: async () => buildSettings() } as never, runtimeRequest: vi.fn(), logError: vi.fn() })
    const pending = (runtime as unknown as { sendFeishuMessage: (...args: unknown[]) => Promise<unknown> }).sendFeishuMessage(
      { send }, 'oc_chat_a', { markdown: '**hello**' }, { replyTo: 'om_inbound', replyInThread: true }, {})
    await expect(pending).rejects.toMatchObject({ code: 'im_delivery_outcome_unknown' })
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][1]).toEqual({ markdown: '**hello**' })
  })

  it('continues agent flow when pending reaction add fails', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.im.responseTimeoutMs = 2_000
    settings.claw.channels = [buildChannel({ threadId: 'thr_1', conversations: [buildConversation({ localThreadId: 'thr_1' })] })]
    const store = {
      load: vi.fn(async () => settings),
      patch: vi.fn(async () => settings)
    }
    const logError = vi.fn()
    const agentReply = 'all good'
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads/thr_1/turns') {
        return { ok: true, status: 202, body: JSON.stringify({ threadId: 'thr_1', turnId: 'turn_react_fail' }) }
      }
      if (path === '/v1/threads/thr_1' && init?.method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            id: 'thr_1',
            status: 'idle',
            turns: [
              {
                id: 'turn_react_fail',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: agentReply }]
              }
            ]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const addReaction = vi.fn().mockRejectedValue(new Error('addReaction API error'))
    const send = vi.fn(async () => ({ messageId: 'om_agent_after_react_fail' }))
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest,
      logError
    })
    ;(runtime as unknown as { feishuChannels: Map<string, { send: typeof send, addReaction: typeof addReaction }> })
      .feishuChannels
      .set('channel_1', { send, addReaction })

    await (runtime as unknown as {
      handleFeishuMessage: (channelId: string, message: {
        chatId: string
        messageId: string
        threadId?: string
        senderId: string
        senderName?: string
        chatType: 'p2p' | 'group'
        mentionedBot: boolean
        mentionAll: boolean
        content: string
        rawContentType: string
        mentions: unknown[]
      }) => Promise<void>
    }).handleFeishuMessage('channel_1', {
      chatId: 'oc_chat_a',
      messageId: 'om_inbound_react_fail',
      senderId: 'ou_1',
      senderName: 'Alice',
      chatType: 'p2p',
      mentionedBot: false,
      mentionAll: false,
      content: 'do something',
      rawContentType: 'text',
      mentions: []
    })

    // The pending reaction failure must be logged and swallowed.
    expect(logError).toHaveBeenCalledWith(
      'claw-feishu',
      expect.stringContaining('pending reaction'),
      expect.objectContaining({
        message: 'addReaction API error',
        chatId: 'oc_chat_a',
        messageId: 'om_inbound_react_fail'
      })
    )
    // The agent reply is still dispatched despite the reaction failure.
    expect(send).toHaveBeenCalledWith(
      'oc_chat_a',
      { markdown: agentReply },
      { replyTo: 'om_inbound_react_fail', replyInThread: false }
    )
  })

  it('does not add a pending reaction for IM commands', async () => {
    const settings = buildSettings()
    settings.claw.im.enabled = true
    settings.claw.channels = [buildChannel()]
    const store = {
      load: vi.fn(async () => settings),
      patch: vi.fn(async () => settings)
    }
    const send = vi.fn(async () => ({ messageId: 'om_cmd' }))
    const addReaction = vi.fn(async () => 'rc_cmd_1')
    const runtime = createClawRuntime({
      store: store as never,
      runtimeRequest: vi.fn() as never,
      logError: () => undefined
    })
    ;(runtime as unknown as { feishuChannels: Map<string, { send: typeof send, addReaction: typeof addReaction }> })
      .feishuChannels
      .set('channel_1', { send, addReaction })

    await (runtime as unknown as {
      handleFeishuMessage: (channelId: string, message: {
        chatId: string
        messageId: string
        threadId?: string
        senderId: string
        senderName?: string
        chatType: 'p2p' | 'group'
        mentionedBot: boolean
        mentionAll: boolean
        content: string
        rawContentType: string
        mentions: unknown[]
      }) => Promise<void>
    }).handleFeishuMessage('channel_1', {
      chatId: 'oc_chat_a',
      messageId: 'om_inbound_cmd',
      senderId: 'ou_1',
      senderName: 'Alice',
      chatType: 'p2p',
      mentionedBot: false,
      mentionAll: false,
      content: '/help',
      rawContentType: 'text',
      mentions: []
    })

    // /help produces a single IM command reply; no pending reaction.
    expect(send).toHaveBeenCalledTimes(1)
    expect(addReaction).not.toHaveBeenCalled()
  })
})
