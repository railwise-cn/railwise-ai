import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ManagedDwsResult } from '../../shared/managed-dws'
import {
  mergeScheduleSettings,
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  type AppSettingsPatch,
  type AppSettingsV1
} from '../../shared/app-settings'

const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>()
const desktopDingTalkMocks = vi.hoisted(() => ({ open: vi.fn(async () => ({ ok: true })) }))
vi.mock('../services/dingtalk-desktop-service', () => ({ openDingTalkDesktop: desktopDingTalkMocks.open }))
const dwsMocks = vi.hoisted(() => ({
  diagnose: vi.fn(async () => ({ ok: true, status: { state: 'needs_login' } })),
  install: vi.fn(async () => ({ ok: true, status: { state: 'needs_login' } })),
  begin: vi.fn<() => Promise<ManagedDwsResult>>(async () => ({ ok: true, state: 'waiting', verificationUrl: 'https://login.dingtalk.com/device' })),
  check: vi.fn(async () => ({ ok: true, state: 'succeeded', status: { state: 'installed', identityFingerprint: 'synthetic-fingerprint' } })),
  cancel: vi.fn(async () => ({ ok: true, state: 'cancelled' }))
}))
const dwsReadCheck = vi.hoisted(() => vi.fn(async (_status: unknown) => ({
  ok: true,
  itemCount: 0,
  checkedAt: '2026-11-11T00:00:00.000Z',
  message: '待办读取已验证。'
})))
vi.mock('../services/dws-connection-check', () => ({
  checkDingTalkTaskAccess: dwsReadCheck,
  dwsTaskAccessFailure: (code: string) => ({ ok: false, code })
}))
vi.mock('../services/managed-dws-service', () => ({
  diagnoseManagedDingTalk: dwsMocks.diagnose,
  installManagedDingTalk: dwsMocks.install,
  beginManagedDingTalkLogin: dwsMocks.begin,
  checkManagedDingTalkLogin: dwsMocks.check,
  cancelManagedDingTalkLogin: dwsMocks.cancel
}))
const managedToolMocks = vi.hoisted(() => ({
  beginLogin: vi.fn(async () => ({ ok: true, verificationUrl: 'https://accounts.feishu.cn/device', expiresAt: '2026-11-10T00:00:00.000Z' })),
  completeLogin: vi.fn(async () => ({ ok: true, status: { id: 'lark-cli', state: 'installed', scopes: ['task:task:read'], brand: 'feishu' } })),
  beginAppSetup: vi.fn(async () => ({ ok: true, state: 'waiting', verificationUrl: 'https://accounts.feishu.cn/device' })),
  checkAppSetup: vi.fn(async () => ({ ok: true, state: 'configured' })),
  cancelAppSetup: vi.fn(async () => ({ ok: true, state: 'cancelled' })),
  list: vi.fn(async () => ({ ok: true, tools: [] })),
  install: vi.fn(async () => ({ ok: false, message: 'fixture' })),
  update: vi.fn(async () => ({ ok: false, message: 'fixture' })),
  diagnose: vi.fn(async (id: string) => ({ ok: true, status: { id, state: 'not_installed' } })),
  remove: vi.fn(async () => ({ ok: false, message: 'fixture' }))
}))

vi.mock('../services/managed-tool-service', () => ({
  beginManagedLarkLogin: managedToolMocks.beginLogin,
  completeManagedLarkLogin: managedToolMocks.completeLogin,
  beginManagedLarkAppSetup: managedToolMocks.beginAppSetup,
  checkManagedLarkAppSetup: managedToolMocks.checkAppSetup,
  cancelManagedLarkAppSetup: managedToolMocks.cancelAppSetup,
  listManagedTools: managedToolMocks.list,
  installManagedTool: managedToolMocks.install,
  updateManagedTool: managedToolMocks.update,
  diagnoseManagedTool: managedToolMocks.diagnose,
  removeManagedTool: managedToolMocks.remove
}))

vi.mock('electron', () => ({
  app: {
    quit: vi.fn(),
    getPath: vi.fn(() => '/tmp')
  },
  dialog: {},
  shell: {
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn()
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) => {
      handlers.set(channel, handler)
    })
  }
}))

function settings(): AppSettingsV1 {
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
    log: { enabled: false, retentionDays: 7 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    schedule: defaultScheduleSettings(),
    guiUpdate: { channel: 'stable' },
    codePromptPrefix: ''
  }
}

function registerOptions(overrides: Partial<Parameters<typeof import('./register-app-ipc-handlers').registerAppIpcHandlers>[0]> = {}) {
  const applySettingsPatch = vi.fn(async () => settings())
  return {
    store: { load: vi.fn(async () => settings()) } as never,
    getMainWindow: () => null,
    applySettingsPatch,
    runtimeRequest: vi.fn() as never,
    fetchUpstreamModels: vi.fn() as never,
    getClawRuntime: () => null,
    getScheduleRuntime: () => null,
    startFeishuInstallQrcode: vi.fn() as never,
    pollFeishuInstall: vi.fn() as never,
    startWeixinInstallQrcode: vi.fn() as never,
    pollWeixinInstall: vi.fn() as never,
    getWeixinBridgeAccountStatuses: vi.fn(async () => []),
    isWeixinBridgeAccountConfigured: vi.fn(async () => false),
    resolveRuntimeConfigPath: () => '/tmp/kun.json',
    showTurnCompleteNotification: vi.fn() as never,
    getAppVersion: () => '0.1.0',
    readGuiUpdateState: vi.fn() as never,
    loadGuiUpdaterModule: vi.fn() as never,
    resolveLogDirectory: () => '/tmp/logs',
    logError: vi.fn(),
    ...overrides
  }
}

describe('registerAppIpcHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('exposes an isolated legacy workspace report and requires explicit snapshot consent', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const { WorkspaceMigrationService } = await import('../services/workspace-migration-service')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'workwise-migration-ipc-')))
    const source = join(root, '.workgpt', 'default_workspace')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'draft.md'), 'local data')
    const service = new WorkspaceMigrationService({ home: root, stateRoot: join(root, 'state') })
    registerAppIpcHandlers(registerOptions({ workspaceMigrationService: service }))
    const report = await handlers.get('workspace-migration:scan')?.({ sender: { id: 1 } }) as Awaited<ReturnType<InstanceType<typeof WorkspaceMigrationService>['scan']>>
    const legacy = report.entries.find(entry => entry.id === '.workgpt:default')!
    expect(legacy.status).toBe('populated')
    await expect(handlers.get('workspace-migration:import-snapshot')?.({ sender: { id: 1 } }, {
      sourceId: legacy.id, expectedFingerprint: legacy.fingerprint, confirmed: false, idempotencyKey: 'blocked'
    })).rejects.toMatchObject({ code: 'approval_required' })
    const result = await handlers.get('workspace-migration:import-snapshot')?.({ sender: { id: 1 } }, {
      sourceId: legacy.id, expectedFingerprint: legacy.fingerprint, confirmed: true, idempotencyKey: 'snapshot'
    }) as Awaited<ReturnType<InstanceType<typeof WorkspaceMigrationService>['importSnapshot']>>
    expect(result.status).toBe('completed')
    expect(readFileSync(join(source, 'draft.md'), 'utf8')).toBe('local data')
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps the same workspace-watch IPC subscription across atomic saves and later deletion', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const { atomicWriteFile } = await import('../services/durable-file')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'workwise-watch-ipc-')))
    const path = join(root, 'draft.md')
    writeFileSync(path, 'initial')
    const sender = { id: 901, isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
    registerAppIpcHandlers(registerOptions())
    const result = await handlers.get('file:watch-workspace')?.({ sender }, { workspaceRoot: root, path }) as { ok: boolean; watchId: string; path: string; content: string }
    try {
      expect(result).toMatchObject({ ok: true, path, content: 'initial' })
      const changed = (content: string): void => expect(sender.send).toHaveBeenCalledWith('file:workspace-changed', expect.objectContaining({
        ok: true, watchId: result.watchId, workspaceRoot: root, path, content, truncated: false
      }))
      await atomicWriteFile(path, 'atomic save')
      await vi.waitFor(() => changed('atomic save'), { timeout: 3_000, interval: 10 })
      writeFileSync(path, 'external after atomic save')
      await vi.waitFor(() => changed('external after atomic save'), { timeout: 3_000, interval: 10 })
      rmSync(path)
      await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith('file:workspace-changed', expect.objectContaining({
        ok: false, watchId: result.watchId, workspaceRoot: root, path, message: expect.any(String)
      })), { timeout: 3_000, interval: 10 })
      await expect(handlers.get('file:unwatch-workspace')?.({ sender }, result.watchId)).resolves.toBe(true)
      const notifications = sender.send.mock.calls.length
      writeFileSync(path, 'recreated after unwatch')
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(sender.send).toHaveBeenCalledTimes(notifications)
    } finally {
      if (result?.watchId) await handlers.get('file:unwatch-workspace')?.({ sender }, result.watchId)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([false, true])('rereads after watch setup when a replacement becomes its baseline (early event: %s)', async (earlyEvent) => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const service = await import('../services/workspace-file-watch-service')
    const start = service.startWorkspaceFileWatch
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'workwise-watch-initial-')))
    const path = join(root, 'draft.md')
    writeFileSync(path, 'old initial read')
    const sender = { id: 902, isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
    const setup = vi.spyOn(service, 'startWorkspaceFileWatch').mockImplementationOnce(async (options) => {
      writeFileSync(path, 'replacement before watcher baseline')
      if (earlyEvent) options.onChange()
      return start(options)
    })
    registerAppIpcHandlers(registerOptions())
    let watchId = ''
    try {
      const result = await handlers.get('file:watch-workspace')?.({ sender }, { workspaceRoot: root, path }) as { ok: boolean; watchId: string; content: string }
      watchId = result.watchId
      expect(result).toMatchObject({ ok: true, content: 'replacement before watcher baseline' })
      expect(sender.send).not.toHaveBeenCalled()
    } finally {
      setup.mockRestore()
      if (watchId) await handlers.get('file:unwatch-workspace')?.({ sender }, watchId)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retries an initial snapshot invalidated by a newer event without emitting before the watch ID is returned', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const service = await import('../services/workspace-file-watch-service')
    const files = await import('../services/workspace-service')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'workwise-watch-init-retry-')))
    const path = join(root, 'draft.md')
    writeFileSync(path, 'initial')
    const sender = { id: 903, isDestroyed: () => false, send: vi.fn(), once: vi.fn() }
    let changed = (): void => undefined
    const close = vi.fn()
    const setup = vi.spyOn(service, 'startWorkspaceFileWatch').mockImplementationOnce(async (options) => {
      changed = options.onChange
      return { close }
    })
    const read = files.readWorkspaceFile
    let reads = 0
    let snapshotReady = (): void => undefined
    const started = new Promise<void>((resolve) => { snapshotReady = resolve })
    let finishSnapshot = (_value: Awaited<ReturnType<typeof read>>): void => undefined
    const held = new Promise<Awaited<ReturnType<typeof read>>>((resolve) => { finishSnapshot = resolve })
    const snapshot = vi.spyOn(files, 'readWorkspaceFile').mockImplementation(async (payload) => {
      const result = await read(payload)
      reads += 1
      if (reads === 2) { snapshotReady(); return held }
      return result
    })
    registerAppIpcHandlers(registerOptions())
    let watchId = ''
    try {
      const pending = handlers.get('file:watch-workspace')!({ sender }, { workspaceRoot: root, path })
      await started
      writeFileSync(path, 'newer during setup snapshot')
      changed()
      finishSnapshot({ ok: true, path, content: 'stale setup snapshot', size: 20, truncated: false })
      const result = await pending as { ok: boolean; watchId: string; content: string }
      watchId = result.watchId
      expect(result).toMatchObject({ ok: true, content: 'newer during setup snapshot' })
      expect(reads).toBe(3)
      expect(sender.send).not.toHaveBeenCalled()
    } finally {
      snapshot.mockRestore(); setup.mockRestore()
      if (watchId) await handlers.get('file:unwatch-workspace')?.({ sender }, watchId)
      rmSync(root, { recursive: true, force: true })
    }
    expect(close).toHaveBeenCalledOnce()
  })

  it('disposes a watch closed by its sender during the registered initial read', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const service = await import('../services/workspace-file-watch-service')
    const files = await import('../services/workspace-service')
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'workwise-watch-init-close-')))
    const path = join(root, 'draft.md')
    writeFileSync(path, 'initial')
    let destroy = (): void => undefined
    const sender = { id: 904, isDestroyed: vi.fn(() => false), send: vi.fn(), once: vi.fn((_name: string, callback: () => void) => { destroy = callback }) }
    const close = vi.fn()
    const setup = vi.spyOn(service, 'startWorkspaceFileWatch').mockResolvedValueOnce({ close })
    const read = files.readWorkspaceFile
    let reads = 0
    const snapshot = vi.spyOn(files, 'readWorkspaceFile').mockImplementation(async (payload) => {
      const result = await read(payload)
      if (++reads === 2) { sender.isDestroyed.mockReturnValue(true); destroy() }
      return result
    })
    registerAppIpcHandlers(registerOptions())
    try {
      await expect(handlers.get('file:watch-workspace')?.({ sender }, { workspaceRoot: root, path })).resolves.toMatchObject({ ok: false })
      expect(close).toHaveBeenCalledOnce()
      expect(sender.send).not.toHaveBeenCalled()
    } finally {
      snapshot.mockRestore(); setup.mockRestore()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('forwards valid Survey draft requests through the desktop runtime handler', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const response = { ok: true, status: 200, body: '{"drafts":[]}' }
    const runtimeRequest = vi.fn(async () => response)
    registerAppIpcHandlers(registerOptions({ runtimeRequest: runtimeRequest as never }))
    const base = '/v1/engineering/projects/project-1/collaboration-drafts'
    const requests = [
      { path: base, method: 'GET', body: undefined },
      { path: base, method: 'POST', body: JSON.stringify({ manifestId: 'manifest-1', expectedProjectRevision: 2, idempotencyKey: 'draft-key-1' }) },
      { path: `${base}/draft-1/review`, method: 'POST', body: '{"expectedRevision":1}' },
      { path: `${base}/draft-1/seal`, method: 'POST', body: '{"expectedRevision":1}' },
      { path: '/v1/engineering/collaboration-drafts/resolve', method: 'POST', body: '{"workspace":"/tmp/survey","path":"notes.md"}' }
    ]
    for (const request of requests) {
      await expect(handlers.get('runtime:request')?.({}, request)).resolves.toEqual(response)
      expect(runtimeRequest).toHaveBeenLastCalledWith(request.path, request.method, request.body)
    }
  })

  it('forwards task workspace pagination and typed coordinator commands through the real desktop IPC handler', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const response = { ok: true, status: 200, body: '{"items":[],"kind":"snapshot"}' }
    const runtimeRequest = vi.fn(async () => response)
    registerAppIpcHandlers(registerOptions({ runtimeRequest: runtimeRequest as never }))
    const query = new URLSearchParams({ pagination: 'cursor', filter: 'all', limit: '200' })
    const cursor = Buffer.from(JSON.stringify({ id: 'snapshot_1', offset: 200 })).toString('base64url')
    const command = { threadId: 'origin_1', taskId: 'task_1', intent: 'status', idempotencyKey: 'query_1', request: { prompt: '现在做到哪了', model: 'deepseek-flash', providerId: 'deepseek' } }
    const requests = [
      { path: `/v1/tasks?${query}`, method: 'GET', body: undefined },
      { path: `/v1/tasks?${query}&cursor=${cursor}`, method: 'GET', body: undefined },
      { path: '/v1/task-commands', method: 'POST', body: JSON.stringify(command) },
      { path: '/v1/task-commands', method: 'POST', body: JSON.stringify({ ...command, intent: 'new', request: { prompt: '重读合成资料并只更新风险章节。', model: 'deepseek-flash' } }) }
    ]
    for (const request of requests) {
      await expect(handlers.get('runtime:request')?.({}, request)).resolves.toEqual(response)
      expect(runtimeRequest).toHaveBeenLastCalledWith(request.path, request.method, request.body)
    }
    const calls = runtimeRequest.mock.calls.length
    for (const request of [
      { path: '/v1/tasks?pagination=cursor&filter=all&unexpected=1', method: 'GET' },
      { path: '/v1/task-commands', method: 'GET' },
      { path: '/v1/task-commands', method: 'POST', body: JSON.stringify({ ...command, request: { prompt: 'x', arbitrary: true } }) }
    ]) await expect(handlers.get('runtime:request')?.({}, request)).rejects.toThrow(/Invalid payload for runtime:request/)
    expect(runtimeRequest).toHaveBeenCalledTimes(calls)
  })

  it('registers native PPTX revision IPC channels and rejects malformed payloads', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    registerAppIpcHandlers(registerOptions())
    const readRevision = handlers.get('design:pptx-revision:read')
    const saveRevision = handlers.get('design:pptx-revision:save')
    expect(readRevision).toBeTypeOf('function')
    expect(saveRevision).toBeTypeOf('function')
    await expect(readRevision?.({}, { workspaceRoot: '/tmp/workspace', documentId: '../outside' }))
      .rejects.toThrow(/Invalid payload for design:pptx-revision:read/)
    await expect(saveRevision?.({}, {
      workspaceRoot: '/tmp/workspace',
      documentId: 'doc_test',
      expectedSha256: 'not-a-digest',
      bytes: [80, 75]
    })).rejects.toThrow(/Invalid payload for design:pptx-revision:save/)
  })

  it('rejects invalid Survey draft requests before reaching the runtime', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
    registerAppIpcHandlers(registerOptions({ runtimeRequest: runtimeRequest as never }))
    for (const request of [
      { path: '/v1/engineering/projects/project-1/collaboration-drafts?latest=1' },
      { path: '/v1/engineering/projects/project-1/collaboration-drafts/draft-1/seal', method: 'POST', body: '{"expectedRevision":1,"professionalSignature":"signed"}' },
      { path: '/v1/engineering/projects/project-1/collaboration-drafts/draft-1/approve', method: 'POST', body: '{}' }
    ]) await expect(handlers.get('runtime:request')?.({}, request)).rejects.toThrow(/Invalid payload for runtime:request/)
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('accepts the active-thread flag for terminal notifications', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const showTurnCompleteNotification = vi.fn(async () => ({ ok: true as const, shown: true }))
    registerAppIpcHandlers(registerOptions({ showTurnCompleteNotification }))

    await expect(handlers.get('notification:turn-complete')?.({}, {
      threadId: 'thread-1',
      reason: 'completed',
      activeThread: true,
      title: 'Done',
      body: 'The turn completed.'
    })).resolves.toEqual({ ok: true, shown: true })
    expect(showTurnCompleteNotification).toHaveBeenCalledWith(expect.objectContaining({ activeThread: true }))
  })

  it('requires the confirmed Runtime snapshot and performs one fenced install', async () => {
    const installGuiUpdate = vi.fn(async () => ({ ok: true as const }))
    const snapshotId = 'a'.repeat(64)
    const activeWork = [{ kind: 'agent', id: 'task-1', label: '编制投标文件', status: 'running', recoverable: true }]
    const runtimeRequest = vi.fn(async (path: string, _method: string, body?: string) => {
      if (path === '/v1/runtime/update') return { ok: true, status: 200, body: JSON.stringify({ ok: true, activeWork, snapshotId }) }
      if (path === '/v1/runtime/update/prepare') {
        const accepted = JSON.parse(body ?? '{}').confirmedSnapshotId === snapshotId
        return { ok: accepted, status: accepted ? 200 : 409, body: JSON.stringify(accepted ? { ok: true, activeWork, snapshotId } : { message: 'Active work changed' }) }
      }
      return { ok: false, status: 404, body: '{}' }
    })
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    registerAppIpcHandlers(registerOptions({
      runtimeRequest: runtimeRequest as never,
      loadGuiUpdaterModule: vi.fn(async () => ({ installGuiUpdate, getGuiUpdateState: () => ({ status: 'downloaded' }) })) as never
    }))
    await expect(handlers.get('gui:update-install-preflight')?.({})).resolves.toMatchObject({ ok: true, activeWork, snapshotId })
    await expect(handlers.get('gui:update-install')?.({}, { confirmActiveWork: true })).resolves.toMatchObject({ ok: false })
    expect(installGuiUpdate).not.toHaveBeenCalled()
    await expect(handlers.get('gui:update-install')?.({}, { confirmActiveWork: true, confirmedSnapshotId: snapshotId })).resolves.toEqual({ ok: true })
    expect(installGuiUpdate).toHaveBeenCalledTimes(1)
  })

  it('rejects renderer-supplied paths at the task artifact opening boundary', async () => {
    const runtimeRequest = vi.fn()
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    registerAppIpcHandlers(registerOptions({ runtimeRequest }))
    await expect(handlers.get('task-artifact:open')?.({}, { taskId: 'task', artifactId: 'artifact', absolutePath: '/arbitrary/file.md' })).rejects.toThrow('Invalid payload')
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('applies saved MCP settings through a main-owned snapshot and blocks renderer config injection', async () => {
    const snapshot = { revision: 1, servers: {}, environment: { SYNTHETIC_KEY: 'fixture-only' } }
    const saved = { id: 'amap', revision: 1 }
    const mcpConfigService = { save: vi.fn(async () => saved), runtimeSnapshot: vi.fn(async () => snapshot) }
    const onMcpServersChanged = vi.fn(async () => undefined)
    const runtimeRequest = vi.fn()
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    registerAppIpcHandlers(registerOptions({ mcpConfigService: mcpConfigService as never, onMcpServersChanged, runtimeRequest }))
    await expect(handlers.get('mcp-server:save')?.({}, {
      config: { id: 'amap', name: 'Amap', scope: 'global', transport: 'http', url: 'https://mcp.amap.com/mcp', timeoutMs: 5000, source: 'managed-tool', managedPreset: 'amap-readonly', toolPolicy: {}, enabled: false },
      expectedRevision: 0, idempotencyKey: 'save-synthetic-mcp'
    })).resolves.toEqual(saved)
    expect(onMcpServersChanged).toHaveBeenCalledWith(snapshot)
    await expect(handlers.get('runtime:request')?.({}, { path: '/v1/runtime/mcp-config', method: 'POST', body: '{}' })).rejects.toThrow(/not allowed|仅能通过连接器设置/)
    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('forwards real MCP check evidence and rejects renderer-injected verification fields', async () => {
    const result = { id: 'amap', state: 'connected', authorized: true, verification: 'tool_discovery', toolCount: 11, checkedAt: '2026-11-12T01:02:03.000Z' }
    const mcpConfigService = { test: vi.fn(async () => result), save: vi.fn() }
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    registerAppIpcHandlers(registerOptions({ mcpConfigService: mcpConfigService as never }))
    await expect(handlers.get('mcp-server:test')?.({}, { serverId: 'amap' })).resolves.toEqual(result)
    expect(mcpConfigService.test).toHaveBeenCalledWith('amap', undefined)
    await expect(handlers.get('mcp-server:save')?.({}, {
      config: { id: 'amap', name: 'Amap', scope: 'global', transport: 'http', url: 'https://mcp.amap.com/mcp', timeoutMs: 5000, source: 'managed-tool', toolPolicy: {}, enabled: true, connectionCheck: result },
      expectedRevision: 1, idempotencyKey: 'spoof-check'
    })).rejects.toThrow('Invalid payload')
    expect(mcpConfigService.save).not.toHaveBeenCalled()
  })

  it('blocks update preflight on an unavailable or malformed Runtime snapshot', async () => {
    const runtimeRequest = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, body: JSON.stringify({ message: 'Runtime unavailable' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, body: JSON.stringify({ ok: true, activeWork: [] }) })
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    registerAppIpcHandlers(registerOptions({ runtimeRequest }))
    await expect(handlers.get('gui:update-install-preflight')?.({})).resolves.toMatchObject({ ok: false, message: 'Runtime unavailable' })
    await expect(handlers.get('gui:update-install-preflight')?.({})).resolves.toMatchObject({ ok: false })
  })

  it('preserves heading, page, table, worksheet, and slide provenance in attachment sections', async () => {
    const { buildAttachmentParserProvenance, buildAttachmentSections } = await import('./register-app-ipc-handlers')
    const sections = buildAttachmentSections(
      'att_fixture',
      '# 报价条款\n\n报价表\n\n<!-- Slide number: 3 -->\n\n| 条款 | 金额 |\n| --- | --- |\n| A | 100 |',
      {
        headings: [{ text: '报价条款', page: 7 }],
        tables: [{ markdown: '| 条款 | 金额 |\n| --- | --- |\n| A | 100 |', page: 8 }],
        sourceStructure: { worksheets: ['报价表'], slideCount: 3 }
      }
    )
    expect(sections[0]?.provenance).toEqual({
      heading: '报价条款', worksheet: '报价表', slide: 3, table: 'table-1', page: 8
    })
    expect(buildAttachmentParserProvenance({
      engine: 'unlimited-ocr-local',
      engineVersion: 'unlimited-ocr-api-v1'
    })).toMatchObject({
      engine: 'unlimited-ocr-local',
      version: 'unlimited-ocr-api-v1',
      local: true
    })
  })

  it('uses OCR page markers as attachment provenance without exposing marker syntax', async () => {
    const { buildAttachmentSections } = await import('./register-app-ipc-handlers')
    const sections = buildAttachmentSections(
      'att_ocr',
      '<!-- page:2 -->\n\n# 扫描标题\n\n扫描正文\n\n<!-- page:999 -->\n\n越界页',
      { headings: [], tables: [], sourceStructure: { pageCount: 2 } }
    )

    expect(sections[0]?.provenance).toMatchObject({ page: 2 })
    expect(sections[0]?.text).toMatch(/扫\s*描\s*正\s*文/)
    expect(sections[0]?.text).not.toContain('page:2')
    expect(sections.some((section) => section.provenance.page === 999)).toBe(false)
  })

  it('rejects invalid settings patches at the handler boundary', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const applySettingsPatch = vi.fn(async () => settings())

    registerAppIpcHandlers(registerOptions({ applySettingsPatch }))

    const handler = handlers.get('settings:set')
    expect(handler).toBeTypeOf('function')
    await expect(
      handler?.({}, { agents: { kun: { mysteryFlag: true } } })
    ).rejects.toThrow(/Invalid payload for settings:set/)
    expect(applySettingsPatch).not.toHaveBeenCalled()
  })

  it('returns a stable Git result when the requested root is outside the active workspace', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const configured = settings()
    const activeRoot = mkdtempSync(join(tmpdir(), 'workwise-active-workspace-'))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'workwise-outside-workspace-'))
    try {
      configured.workspaceRoot = activeRoot
      registerAppIpcHandlers(registerOptions({
        store: { load: vi.fn(async () => configured) } as never
      }))

      await expect(handlers.get('git:branches')?.({}, outsideRoot))
        .resolves.toMatchObject({
          ok: false,
          reason: 'workspace_not_allowed',
          message: 'Git workspace must stay within the active workspace.'
        })
    } finally {
      rmSync(activeRoot, { recursive: true, force: true })
      rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  it('rejects Git checkpoint creation outside the active workspace', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const configured = settings()
    const activeRoot = mkdtempSync(join(tmpdir(), 'workwise-active-workspace-'))
    const outsideRoot = mkdtempSync(join(tmpdir(), 'workwise-outside-workspace-'))
    try {
      configured.workspaceRoot = activeRoot
      registerAppIpcHandlers(registerOptions({
        store: { load: vi.fn(async () => configured) } as never
      }))

      await expect(handlers.get('git:checkpoint:create')?.({}, {
        taskId: 'task-outside',
        workspaceRoot: outsideRoot,
        repositoryRoot: outsideRoot,
        relatedPaths: [],
        idempotencyKey: 'checkpoint-outside'
      })).rejects.toMatchObject({ code: 'workspace_not_allowed' })
    } finally {
      rmSync(activeRoot, { recursive: true, force: true })
      rmSync(outsideRoot, { recursive: true, force: true })
    }
  })

  it('passes valid settings patches through to applySettingsPatch', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const applySettingsPatch = vi.fn(async () => settings())

    registerAppIpcHandlers(registerOptions({ applySettingsPatch }))

    const payload = {
      theme: 'dark' as const,
      agents: {
        kun: {
          port: 9000
        }
      }
    }
    const handler = handlers.get('settings:set')
    await expect(handler?.({}, payload)).resolves.toEqual(settings())
    expect(applySettingsPatch).toHaveBeenCalledWith(payload)
  })

  it('redacts legacy IM secrets from settings:get while keeping them in the main-process store', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const configured = settings()
    configured.claw.im.secret = 'legacy-im-secret'
    configured.claw.channels = [{
      id: 'legacy-feishu', provider: 'feishu', label: 'Feishu', enabled: true, model: 'auto', threadId: '', workspaceRoot: '',
      agentProfile: { name: 'Agent', description: '', identity: '', personality: '', userContext: '', replyRules: '' },
      platformCredential: { kind: 'feishu', appId: 'app-1', appSecret: 'legacy-app-secret', domain: 'feishu', createdAt: new Date().toISOString() },
      conversations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
    registerAppIpcHandlers(registerOptions({ store: { load: vi.fn(async () => configured) } as never }))

    const exposed = await handlers.get('settings:get')?.({}) as AppSettingsV1

    expect(exposed.claw.im.secret).toBe('')
    expect(exposed.claw.channels[0]?.platformCredential).toEqual(expect.objectContaining({ appId: 'app-1' }))
    expect(exposed.claw.channels[0]?.platformCredential).not.toHaveProperty('appSecret')
    expect(JSON.stringify(exposed)).not.toContain('legacy-app-secret')
    expect(JSON.stringify(exposed)).not.toContain('legacy-im-secret')
  })

  it('registers unified IM lifecycle, health, self-check, and diagnostics handlers', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const health = {
      schema: 'workwise.im-health' as const,
      version: 1 as const,
      channelId: 'channel-1', provider: 'feishu' as const, accountId: 'app-1', status: 'connected' as const,
      reasonCode: 'none' as const, message: '连接正常。', runId: 'run-1', updatedAt: new Date().toISOString(),
      failureCount: 0, pendingMessages: 0, processingMessages: 0, deliveryMessages: 0
    }
    const service = {
      list: vi.fn(() => [health]),
      get: vi.fn(() => health),
      start: vi.fn(() => health),
      stop: vi.fn(() => ({ ...health, status: 'stopped' as const })),
      selfCheck: vi.fn(() => ({ schema: 'workwise.im-self-check', version: 1, overall: 'PASS', checkedAt: new Date().toISOString(), runId: 'run-1', checks: [] })),
      diagnostics: vi.fn(() => ({ schema: 'workwise.im-diagnostics', version: 1, generatedAt: new Date().toISOString(), appVersion: '0.1.0', userDataFingerprint: 'abc123', channels: [] }))
    }
    const configured = settings()
    configured.claw.channels = [{
      id: 'channel-1', provider: 'feishu', label: 'Feishu', enabled: true, model: 'deepseek-chat', threadId: '', workspaceRoot: '',
      agentProfile: { name: 'Agent', description: '', identity: '', personality: '', userContext: '', replyRules: '' },
      platformCredential: { kind: 'feishu', appId: 'app-1', domain: 'feishu', createdAt: new Date().toISOString() },
      credentialRef: { id: 'credential-1', storage: 'keychain', createdAt: new Date().toISOString() },
      conversations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
    const runtime = { sync: vi.fn(), stop: vi.fn(), isChannelBridgeAvailable: vi.fn(async () => true) }
    registerAppIpcHandlers(registerOptions({
      store: { load: vi.fn(async () => configured) } as never,
      getClawRuntime: () => runtime as never,
      getImHealthService: () => service as never,
      getImCredentialService: () => ({ resolve: vi.fn(async () => 'secret') }) as never,
      getImDeliveryLedger: () => ({ integrityCheck: () => true }) as never,
      getUserDataPath: () => '/tmp/workwise-test',
      runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: '{}' })) as never
    }))

    for (const channel of ['claw:im:health', 'claw:im:start', 'claw:im:reconnect', 'claw:im:stop', 'claw:im:disconnect', 'claw:im:self-check', 'claw:im:diagnostics']) {
      expect(handlers.get(channel), channel).toBeTypeOf('function')
    }
    await expect(handlers.get('claw:im:health')?.({}, { channelId: 'channel-1' })).resolves.toEqual([health])
    await expect(handlers.get('claw:im:start')?.({}, { channelId: 'channel-1' })).resolves.toMatchObject({ ok: true })
    await expect(handlers.get('claw:im:self-check')?.({}, { channelId: 'channel-1' })).resolves.toMatchObject({ overall: 'PASS' })
    expect(service.selfCheck).toHaveBeenCalledWith(expect.objectContaining({
      credentialAvailable: true,
      bridgeAvailable: true,
      runtimeAvailable: true,
      ledgerHealthy: true
    }))
    await expect(handlers.get('claw:im:diagnostics')?.({})).resolves.toMatchObject({ schema: 'workwise.im-diagnostics' })
    await expect(handlers.get('claw:im:stop')?.({}, { channelId: '' }))
      .rejects.toThrow(/Invalid payload for claw:im:stop/)
  })

  it('returns a structured lifecycle failure when the IM Runtime is unavailable', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const configured = settings()
    configured.claw.channels = [{
      id: 'channel-offline', provider: 'feishu', label: 'Feishu', enabled: true, model: 'deepseek-chat', threadId: '', workspaceRoot: '',
      agentProfile: { name: 'Agent', description: '', identity: '', personality: '', userContext: '', replyRules: '' },
      conversations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
    const health = {
      channelId: 'channel-offline',
      provider: 'feishu',
      accountId: 'channel-offline',
      status: 'connected'
    }
    const imHealth = { get: vi.fn(() => health), list: vi.fn(() => [health]) }
    registerAppIpcHandlers(registerOptions({
      store: { load: vi.fn(async () => configured) } as never,
      getClawRuntime: () => null,
      getImHealthService: () => imHealth as never
    }))

    await expect(handlers.get('claw:im:stop')?.({}, { channelId: 'channel-offline' }))
      .resolves.toEqual({
        ok: false,
        code: 'runtime_unavailable',
        message: 'IM Runtime is unavailable.',
        health
      })
  })

  it('reports a paused IM connection without probing its credential or bridge as a failure', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const health = {
      schema: 'workwise.im-health' as const,
      version: 1 as const,
      channelId: 'channel-paused', provider: 'feishu' as const, accountId: 'app-1', status: 'stopped' as const,
      reasonCode: 'user_stopped' as const, message: '连接已暂停。', runId: 'run-paused', updatedAt: new Date().toISOString(),
      failureCount: 0, pendingMessages: 0, processingMessages: 0, deliveryMessages: 0
    }
    const selfCheck = vi.fn()
    const isChannelBridgeAvailable = vi.fn()
    const resolveCredential = vi.fn()
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: '{}' }))
    registerAppIpcHandlers(registerOptions({
      getClawRuntime: () => ({ isChannelBridgeAvailable }) as never,
      getImHealthService: () => ({ get: vi.fn(() => health), selfCheck }) as never,
      getImCredentialService: () => ({ resolve: resolveCredential }) as never,
      getImDeliveryLedger: () => ({ integrityCheck: () => true }) as never,
      runtimeRequest: runtimeRequest as never
    }))

    await expect(handlers.get('claw:im:self-check')?.({}, { channelId: 'channel-paused' }))
      .resolves.toMatchObject({
        overall: 'PASS',
        runId: 'run-paused',
        checks: expect.arrayContaining([
          expect.objectContaining({ id: 'connection_state', code: 'user_paused', pass: true }),
          expect.objectContaining({ id: 'runtime', pass: true }),
          expect.objectContaining({ id: 'ledger', pass: true })
        ])
      })
    expect(runtimeRequest).toHaveBeenCalledWith('/health', 'GET')
    expect(selfCheck).not.toHaveBeenCalled()
    expect(isChannelBridgeAvailable).not.toHaveBeenCalled()
    expect(resolveCredential).not.toHaveBeenCalled()
  })

  it('reports failed WeChat self-check inputs when credentials and bridge are unavailable', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const health = {
      schema: 'workwise.im-health' as const,
      version: 1 as const,
      channelId: 'channel-wx', provider: 'weixin' as const, accountId: 'wx-1', status: 'disconnected' as const,
      reasonCode: 'credential_missing' as const, message: '凭据不可用。', runId: 'run-wx', updatedAt: new Date().toISOString(),
      failureCount: 1, pendingMessages: 0, processingMessages: 0, deliveryMessages: 0
    }
    const selfCheck = vi.fn((input: { credentialAvailable: boolean; bridgeAvailable: boolean }) => ({
      schema: 'workwise.im-self-check' as const,
      version: 1 as const,
      overall: input.credentialAvailable && input.bridgeAvailable ? 'PASS' as const : 'FAIL' as const,
      checkedAt: new Date().toISOString(),
      runId: 'run-wx',
      checks: []
    }))
    const configured = settings()
    configured.claw.channels = [{
      id: 'channel-wx', provider: 'weixin', label: '微信', enabled: true, model: 'deepseek-chat', threadId: '', workspaceRoot: '',
      agentProfile: { name: 'Agent', description: '', identity: '', personality: '', userContext: '', replyRules: '' },
      platformCredential: { kind: 'weixin', accountId: 'wx-1', createdAt: new Date().toISOString() },
      conversations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
    registerAppIpcHandlers(registerOptions({
      store: { load: vi.fn(async () => configured) } as never,
      getClawRuntime: () => ({ isChannelBridgeAvailable: vi.fn(async () => false) }) as never,
      getImHealthService: () => ({ get: vi.fn(() => health), selfCheck }) as never,
      isWeixinBridgeAccountConfigured: vi.fn(async () => false),
      getImDeliveryLedger: () => ({ integrityCheck: () => true }) as never,
      getUserDataPath: () => '/tmp/workwise-test',
      runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: '{}' })) as never
    }))

    await expect(
      handlers.get('claw:im:self-check')?.({}, { channelId: 'channel-wx' })
    ).resolves.toMatchObject({ overall: 'FAIL' })
    expect(selfCheck).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'channel-wx',
      credentialAvailable: false,
      bridgeAvailable: false,
      runtimeAvailable: true,
      ledgerHealthy: true
    }))
  })

  it('trusts an active WeChat bridge credential without resolving the redundant channel credential ref', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const health = {
      schema: 'workwise.im-health' as const,
      version: 1 as const,
      channelId: 'channel-wx', provider: 'weixin' as const, accountId: 'wx-1', status: 'connected' as const,
      reasonCode: 'none' as const, message: '微信已连接。', runId: 'run-wx', updatedAt: new Date().toISOString(),
      lastSuccessfulHeartbeatAt: new Date().toISOString(),
      failureCount: 0, pendingMessages: 0, processingMessages: 0, deliveryMessages: 0
    }
    const selfCheck = vi.fn((input: { credentialAvailable: boolean; bridgeAvailable: boolean }) => ({
      schema: 'workwise.im-self-check' as const,
      version: 1 as const,
      overall: input.credentialAvailable && input.bridgeAvailable ? 'PASS' as const : 'FAIL' as const,
      checkedAt: new Date().toISOString(),
      runId: 'run-wx',
      checks: []
    }))
    const configured = settings()
    configured.claw.channels = [{
      id: 'channel-wx', provider: 'weixin', label: '微信', enabled: true, model: 'deepseek-chat', threadId: '', workspaceRoot: '',
      agentProfile: { name: 'Agent', description: '', identity: '', personality: '', userContext: '', replyRules: '' },
      platformCredential: { kind: 'weixin', accountId: 'wx-1', createdAt: new Date().toISOString() },
      credentialRef: { id: 'redundant-ref', storage: 'keychain', createdAt: new Date().toISOString() },
      conversations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
    const resolveCredential = vi.fn(async () => { throw new Error('helper unavailable') })
    const configuredAccount = vi.fn(async () => true)
    registerAppIpcHandlers(registerOptions({
      store: { load: vi.fn(async () => configured) } as never,
      getClawRuntime: () => ({ isChannelBridgeAvailable: vi.fn(async () => true) }) as never,
      getImHealthService: () => ({ get: vi.fn(() => health), selfCheck }) as never,
      getImCredentialService: () => ({ resolve: resolveCredential }) as never,
      isWeixinBridgeAccountConfigured: configuredAccount,
      getImDeliveryLedger: () => ({ integrityCheck: () => true }) as never,
      getUserDataPath: () => '/tmp/workwise-test',
      runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: '{}' })) as never
    }))

    await expect(
      handlers.get('claw:im:self-check')?.({}, { channelId: 'channel-wx' })
    ).resolves.toMatchObject({ overall: 'PASS' })
    expect(configuredAccount).toHaveBeenCalledWith('wx-1')
    expect(resolveCredential).not.toHaveBeenCalled()
    expect(selfCheck).toHaveBeenCalledWith(expect.objectContaining({
      credentialAvailable: true,
      bridgeAvailable: true,
      runtimeAvailable: true,
      ledgerHealthy: true
    }))
  })

  it('removes a disconnected IM channel through the protected settings path', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const configured = settings()
    configured.claw.channels = [{
      id: 'channel-disconnect', provider: 'feishu', label: 'Feishu', enabled: true, model: 'deepseek-chat', threadId: '', workspaceRoot: '',
      agentProfile: { name: 'Agent', description: '', identity: '', personality: '', userContext: '', replyRules: '' },
      platformCredential: { kind: 'feishu', appId: 'app-1', domain: 'feishu', createdAt: new Date().toISOString() },
      credentialRef: { id: 'credential-1', storage: 'keychain', createdAt: new Date().toISOString() },
      conversations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
    const applySettingsPatch = vi.fn(async () => ({ ...configured, claw: { ...configured.claw, channels: [] } }))
    const disconnectChannel = vi.fn(async () => undefined)
    const health = {
      schema: 'workwise.im-health' as const,
      version: 1 as const,
      channelId: 'channel-disconnect', provider: 'feishu' as const, accountId: 'app-1', status: 'connected' as const,
      reasonCode: 'none' as const, message: '连接正常。', runId: 'run-1', updatedAt: new Date().toISOString(),
      failureCount: 0, pendingMessages: 0, processingMessages: 0, deliveryMessages: 0
    }
    const stop = vi.fn(() => ({ ...health, status: 'stopped' as const }))
    registerAppIpcHandlers(registerOptions({
      store: { load: vi.fn(async () => configured) } as never,
      applySettingsPatch,
      getClawRuntime: () => ({ disconnectChannel }) as never,
      getImHealthService: () => ({ get: () => health, stop }) as never
    }))

    await expect(handlers.get('claw:im:disconnect')?.({}, { channelId: 'channel-disconnect' }))
      .resolves.toMatchObject({ ok: true })
    expect(disconnectChannel).toHaveBeenCalledWith('channel-disconnect')
    expect(applySettingsPatch).toHaveBeenCalledWith({ claw: { channels: [] } })
    expect(stop).toHaveBeenCalledWith('channel-disconnect', '连接已断开，凭据已清除。')
  })

  it('returns stopped health when stop begins without a persisted health snapshot', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const configured = settings()
    configured.claw.channels = [{
      id: 'channel-stop', provider: 'feishu', label: 'Feishu', enabled: true, model: 'deepseek-chat', threadId: '', workspaceRoot: '',
      agentProfile: { name: 'Agent', description: '', identity: '', personality: '', userContext: '', replyRules: '' },
      platformCredential: { kind: 'feishu', appId: 'app-1', domain: 'feishu', createdAt: new Date().toISOString() },
      conversations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
    let health: Record<string, unknown> | undefined
    const service = {
      stop: vi.fn((_channelId: string, message = '连接已暂停。') => {
        if (!health) return undefined
        health = { ...health, status: 'stopped', reasonCode: 'user_stopped', message }
        return health
      }),
      start: vi.fn(() => {
        health = { channelId: 'channel-stop', provider: 'feishu', accountId: 'app-1', status: 'starting' }
        return health
      })
    }
    const stopChannel = vi.fn(async () => undefined)
    const applySettingsPatch = vi.fn(async () => configured)
    registerAppIpcHandlers(registerOptions({
      store: { load: vi.fn(async () => configured) } as never,
      applySettingsPatch,
      getClawRuntime: () => ({ stopChannel }) as never,
      getImHealthService: () => service as never
    }))

    await expect(handlers.get('claw:im:stop')?.({}, { channelId: 'channel-stop' }))
      .resolves.toMatchObject({ ok: true, health: { status: 'stopped', reasonCode: 'user_stopped' } })
    expect(service.start).toHaveBeenCalledTimes(1)
    expect(service.stop).toHaveBeenCalledTimes(2)
    expect(stopChannel).toHaveBeenCalledWith('channel-stop')
    expect(applySettingsPatch).toHaveBeenCalledWith({
      claw: {
        channels: [expect.objectContaining({ id: 'channel-stop', enabled: false })]
      }
    })
  })

  it('persists a stopped channel as enabled before reconnecting it', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const configured = settings()
    configured.claw.channels = [{
      id: 'channel-reconnect', provider: 'feishu', label: 'Feishu', enabled: false, model: 'deepseek-chat', threadId: '', workspaceRoot: '',
      agentProfile: { name: 'Agent', description: '', identity: '', personality: '', userContext: '', replyRules: '' },
      platformCredential: { kind: 'feishu', appId: 'app-1', domain: 'feishu', createdAt: new Date().toISOString() },
      conversations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
    const health = {
      schema: 'workwise.im-health' as const,
      version: 1 as const,
      channelId: 'channel-reconnect', provider: 'feishu' as const, accountId: 'app-1', status: 'starting' as const,
      reasonCode: 'none' as const, message: '正在建立连接。', runId: 'runtime-run', updatedAt: new Date().toISOString(),
      failureCount: 0, pendingMessages: 0, processingMessages: 0, deliveryMessages: 0
    }
    const reconnectChannel = vi.fn(async () => undefined)
    const retryProtectedStorage = vi.fn(async () => undefined)
    const start = vi.fn(() => ({ ...health, runId: 'ipc-reset-run' }))
    const applySettingsPatch = vi.fn(async () => ({
      ...configured,
      claw: {
        ...configured.claw,
        channels: configured.claw.channels.map((channel) => ({ ...channel, enabled: true }))
      }
    }))
    registerAppIpcHandlers(registerOptions({
      store: { load: vi.fn(async () => configured) } as never,
      applySettingsPatch,
      getClawRuntime: () => ({ reconnectChannel }) as never,
      getImCredentialService: () => ({ retryProtectedStorage }) as never,
      getImHealthService: () => ({ get: vi.fn(() => health), start }) as never
    }))

    await expect(handlers.get('claw:im:reconnect')?.({}, { channelId: 'channel-reconnect' }))
      .resolves.toMatchObject({ ok: true, health: { runId: 'runtime-run' } })
    expect(reconnectChannel).toHaveBeenCalledWith('channel-reconnect')
    expect(retryProtectedStorage).toHaveBeenCalledTimes(1)
    expect(retryProtectedStorage.mock.invocationCallOrder[0]).toBeLessThan(
      reconnectChannel.mock.invocationCallOrder[0]
    )
    expect(applySettingsPatch).toHaveBeenCalledWith({
      claw: {
        channels: [expect.objectContaining({ id: 'channel-reconnect', enabled: true })]
      }
    })
    expect(applySettingsPatch.mock.invocationCallOrder[0]).toBeLessThan(
      reconnectChannel.mock.invocationCallOrder[0]
    )
    expect(start).not.toHaveBeenCalled()
  })

  it('migrates a legacy Feishu secret to protected storage before reconnecting', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const configured = settings()
    configured.claw.channels = [{
      id: 'channel-legacy', provider: 'feishu', label: 'Feishu', enabled: true, model: 'deepseek-chat', threadId: '', workspaceRoot: '',
      agentProfile: { name: 'Agent', description: '', identity: '', personality: '', userContext: '', replyRules: '' },
      platformCredential: { kind: 'feishu', appId: 'app-legacy', appSecret: 'legacy-secret', domain: 'feishu', createdAt: new Date().toISOString() },
      conversations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
    const retryProtectedStorage = vi.fn(async () => undefined)
    const set = vi.fn(async () => ({
      id: 'protected-ref', storage: 'keychain' as const, createdAt: new Date().toISOString()
    }))
    const applySettingsPatch = vi.fn(async (_patch: AppSettingsPatch) => configured)
    const reconnectChannel = vi.fn(async () => undefined)
    const health = { channelId: 'channel-legacy', status: 'starting' }
    registerAppIpcHandlers(registerOptions({
      store: { load: vi.fn(async () => configured) } as never,
      applySettingsPatch,
      getClawRuntime: () => ({ reconnectChannel }) as never,
      getImCredentialService: () => ({ retryProtectedStorage, set }) as never,
      getImHealthService: () => ({ get: vi.fn(() => health) }) as never
    }))

    await expect(handlers.get('claw:im:reconnect')?.({}, { channelId: 'channel-legacy' }))
      .resolves.toMatchObject({ ok: true })

    expect(set).toHaveBeenCalledWith('feishu', 'app-legacy', 'legacy-secret')
    expect(applySettingsPatch).toHaveBeenCalledWith({
      claw: {
        channels: [expect.objectContaining({
          credentialRef: expect.objectContaining({ id: 'protected-ref', storage: 'keychain' }),
          platformCredential: expect.not.objectContaining({ appSecret: expect.anything() })
        })]
      }
    })
    expect(reconnectChannel).toHaveBeenCalledWith('channel-legacy')
    expect(applySettingsPatch.mock.invocationCallOrder[0]).toBeLessThan(
      reconnectChannel.mock.invocationCallOrder[0]
    )
  })

  it('returns an explicit reconnect failure instead of rejecting the IPC call', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const configured = settings()
    configured.claw.channels = [{
      id: 'channel-reconnect', provider: 'feishu', label: 'Feishu', enabled: true, model: 'deepseek-chat', threadId: '', workspaceRoot: '',
      agentProfile: { name: 'Agent', description: '', identity: '', personality: '', userContext: '', replyRules: '' },
      platformCredential: { kind: 'feishu', appId: 'app-1', domain: 'feishu', createdAt: new Date().toISOString() },
      conversations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
    const health = { channelId: 'channel-reconnect', status: 'retrying' }
    registerAppIpcHandlers(registerOptions({
      store: { load: vi.fn(async () => configured) } as never,
      getClawRuntime: () => ({ reconnectChannel: vi.fn(async () => { throw new Error('bridge unavailable') }) }) as never,
      getImHealthService: () => ({ get: vi.fn(() => health) }) as never
    }))

    await expect(handlers.get('claw:im:reconnect')?.({}, { channelId: 'channel-reconnect' }))
      .resolves.toEqual({
        ok: false,
        code: 'reconnect_failed',
        message: 'bridge unavailable',
        health
      })
  })

  it('reports a failed self-check when Feishu protected storage rejects', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const configured = settings()
    configured.claw.channels = [{
      id: 'channel-keychain', provider: 'feishu', label: 'Feishu', enabled: true, model: 'deepseek-chat', threadId: '', workspaceRoot: '',
      agentProfile: { name: 'Agent', description: '', identity: '', personality: '', userContext: '', replyRules: '' },
      platformCredential: { kind: 'feishu', appId: 'app-1', domain: 'feishu', createdAt: new Date().toISOString() },
      credentialRef: { id: 'credential-1', storage: 'keychain', createdAt: new Date().toISOString() },
      conversations: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }]
    const health = { channelId: 'channel-keychain', runId: 'run-1' }
    const selfCheck = vi.fn((input: { credentialAvailable: boolean }) => ({
      schema: 'workwise.im-self-check', version: 1, overall: input.credentialAvailable ? 'PASS' : 'FAIL',
      checkedAt: new Date().toISOString(), runId: 'run-1', checks: []
    }))
    registerAppIpcHandlers(registerOptions({
      store: { load: vi.fn(async () => configured) } as never,
      getClawRuntime: () => ({ isChannelBridgeAvailable: vi.fn(async () => true) }) as never,
      getImHealthService: () => ({ get: vi.fn(() => health), selfCheck }) as never,
      getImCredentialService: () => ({ resolve: vi.fn(async () => { throw new Error('credential_unavailable') }) }) as never,
      getImDeliveryLedger: () => ({ integrityCheck: () => true }) as never,
      runtimeRequest: vi.fn(async () => ({ ok: true, status: 200, body: '{}' })) as never
    }))

    await expect(handlers.get('claw:im:self-check')?.({}, { channelId: 'channel-keychain' }))
      .resolves.toMatchObject({ overall: 'FAIL' })
    expect(selfCheck).toHaveBeenCalledWith(expect.objectContaining({
      credentialAvailable: false,
      bridgeAvailable: true,
      runtimeAvailable: true,
      ledgerHealthy: true
    }))
  })

  it('opens only the fixed DingTalk desktop target and rejects renderer-supplied paths', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    registerAppIpcHandlers(registerOptions())
    const handler = handlers.get('shell:open-dingtalk-desktop')!
    expect(await handler({})).toEqual({ ok: true })
    expect(desktopDingTalkMocks.open).toHaveBeenCalledOnce()
    for (const payload of ['/Applications/Other.app', { path: '/tmp/Other.app' }, 'dingtalk://untrusted']) {
      await expect(handler({}, payload)).rejects.toThrow(/Invalid payload/)
    }
    expect(desktopDingTalkMocks.open).toHaveBeenCalledOnce()
  })

  it('registers every managed-tool IPC handler and validates tool ids', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')

    registerAppIpcHandlers(registerOptions())

    for (const channel of [
      'tool:lark-login:begin',
      'tool:lark-login:complete',
      'tool:lark-app-setup:begin',
      'tool:lark-app-setup:check',
      'tool:lark-app-setup:cancel',
      'tool:list-managed',
      'tool:install-managed',
      'tool:update-managed',
      'tool:diagnose-managed',
      'tool:remove-managed'
    ]) {
      expect(handlers.get(channel), channel).toBeTypeOf('function')
    }

    await expect(
      handlers.get('tool:install-managed')?.({}, 'unknown-tool')
    ).rejects.toThrow(/Invalid payload for tool:install-managed/)

    await expect(handlers.get('tool:list-managed')?.({})).resolves.toEqual({ ok: true, tools: [] })
    await expect(handlers.get('tool:install-managed')?.({}, 'lark-cli')).resolves.toMatchObject({ ok: false })
    await expect(handlers.get('tool:update-managed')?.({}, 'officecli')).resolves.toMatchObject({ ok: false })
    await expect(handlers.get('tool:diagnose-managed')?.({}, 'ego-browser')).resolves.toMatchObject({
      ok: true,
      status: { id: 'ego-browser' }
    })
    await expect(handlers.get('tool:remove-managed')?.({}, 'officecli')).resolves.toMatchObject({ ok: false })
    expect(managedToolMocks.list).toHaveBeenCalledOnce()
    expect(managedToolMocks.install).toHaveBeenCalledWith('lark-cli')
    expect(managedToolMocks.update).toHaveBeenCalledWith('officecli')
    expect(managedToolMocks.diagnose).toHaveBeenCalledWith('ego-browser')
    expect(managedToolMocks.remove).toHaveBeenCalledWith('officecli')
  })

  it('refreshes the trusted Runtime capability snapshot after managed user login', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const refresh = vi.fn(async () => undefined)
    registerAppIpcHandlers({ ...registerOptions(), refreshManagedCapabilities: refresh })
    expect(await handlers.get('tool:lark-app-setup:begin')?.({})).toMatchObject({ ok: true, state: 'waiting' })
    expect(await handlers.get('tool:lark-app-setup:check')?.({})).toMatchObject({ ok: true, state: 'configured' })
    expect(await handlers.get('tool:lark-app-setup:cancel')?.({})).toMatchObject({ ok: true, state: 'cancelled' })
    expect(refresh).not.toHaveBeenCalled()
    expect(await handlers.get('tool:lark-login:begin')?.({})).toMatchObject({ ok: true })
    expect(await handlers.get('tool:lark-login:complete')?.({})).toMatchObject({ ok: true, status: { state: 'installed' } })
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ id: 'lark-cli', scopes: ['task:task:read'] }))
  })

  it('exposes independent DingTalk installation and scan flow without treating a waiting scan as connected', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const refresh = vi.fn(async () => undefined)
    registerAppIpcHandlers({ ...registerOptions(), refreshManagedDingTalkCapabilities: refresh })
    expect(await handlers.get('tool:dingtalk:diagnose')?.({})).toMatchObject({ ok: true, status: { state: 'needs_login' } })
    expect(await handlers.get('tool:dingtalk:install')?.({})).toMatchObject({ ok: true })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(await handlers.get('tool:dingtalk:login-begin')?.({})).toMatchObject({ state: 'waiting' })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(await handlers.get('tool:dingtalk:login-check')?.({})).toMatchObject({ state: 'succeeded' })
    expect(refresh).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'installed', identityFingerprint: 'synthetic-fingerprint' }))
    expect(await handlers.get('tool:dingtalk:login-cancel')?.({})).toMatchObject({ state: 'cancelled' })
  })

  it('refreshes Runtime when DingTalk authorization finishes and verifies before returning its first page', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const status = { state: 'installed' as const, identityFingerprint: 'synthetic-fast-completion' }
    dwsMocks.begin.mockResolvedValueOnce({ ok: true, state: 'succeeded', status })
    const refresh = vi.fn(async () => ({ enabled: true }))
    registerAppIpcHandlers({ ...registerOptions(), refreshManagedDingTalkCapabilities: refresh })
    expect(await handlers.get('tool:dingtalk:login-begin')?.({})).toMatchObject({ state: 'succeeded', status: { ...status, enabled: true } })
    expect(refresh).toHaveBeenCalledExactlyOnceWith(status)
    expect(dwsMocks.check).not.toHaveBeenCalled()
  })

  it('changes DingTalk enablement only through an explicit strict boolean command without reading accounts', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const setEnabled = vi.fn(async (enabled: boolean) => ({ ok: true as const, status: { state: 'needs_login' as const, enabled } }))
    registerAppIpcHandlers({ ...registerOptions(), setManagedDingTalkEnabled: setEnabled })
    expect(await handlers.get('tool:dingtalk:set-enabled')?.({}, true)).toEqual({ ok: true, status: { state: 'needs_login', enabled: true } })
    expect(await handlers.get('tool:dingtalk:set-enabled')?.({}, false)).toEqual({ ok: true, status: { state: 'needs_login', enabled: false } })
    for (const payload of ['true', 'false', 1, 0, null, { enabled: true }]) await expect(handlers.get('tool:dingtalk:set-enabled')?.({}, payload)).rejects.toThrow(/Invalid payload/)
    expect(setEnabled.mock.calls).toEqual([[true], [false]])
    expect(dwsMocks.diagnose).not.toHaveBeenCalled()
    expect(dwsMocks.begin).not.toHaveBeenCalled()
  })

  it('offers a fixed read check after trusted diagnosis and rejects arbitrary input', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    registerAppIpcHandlers({ ...registerOptions(), refreshManagedDingTalkCapabilities: async () => ({ enabled: true }) })
    expect(await handlers.get('tool:dingtalk:check-task-access')?.({})).toMatchObject({ ok: true, itemCount: 0 })
    expect(dwsReadCheck).toHaveBeenCalledWith({ state: 'needs_login', enabled: true })
    for (const payload of [{ pageSize: 100 }, { command: 'approve' }, 'read', null]) {
      await expect(handlers.get('tool:dingtalk:check-task-access')?.({}, payload)).rejects.toThrow(/Invalid payload/)
    }
    expect(dwsReadCheck).toHaveBeenCalledOnce()
  })

  it('stops the business read when connector Runtime refresh fails', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    registerAppIpcHandlers({ ...registerOptions(), refreshManagedDingTalkCapabilities: async () => { throw new Error('refresh failed') } })
    expect(await handlers.get('tool:dingtalk:check-task-access')?.({})).toMatchObject({ ok: false, code: 'connector_identity_unverified' })
    expect(dwsReadCheck).not.toHaveBeenCalled()
  })

  it('shares a concurrent read diagnostic instead of dispatching a second query', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    let finish!: (value: Awaited<ReturnType<typeof dwsReadCheck>>) => void
    dwsReadCheck.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    registerAppIpcHandlers({ ...registerOptions(), refreshManagedDingTalkCapabilities: async () => ({ enabled: true }) })
    const first = handlers.get('tool:dingtalk:check-task-access')?.({})
    const second = handlers.get('tool:dingtalk:check-task-access')?.({})
    await vi.waitFor(() => expect(dwsReadCheck).toHaveBeenCalledOnce())
    finish({ ok: true, itemCount: 0, checkedAt: '2026-11-11T00:00:00.000Z', message: '待办读取已验证。' })
    expect(await first).toEqual(await second)
    expect(dwsMocks.diagnose).toHaveBeenCalledOnce()
  })

  it('returns persisted disabled state from a trusted refresh without replacing installation or identity diagnosis', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    registerAppIpcHandlers({ ...registerOptions(), refreshManagedDingTalkCapabilities: async () => ({ enabled: false }) })
    expect(await handlers.get('tool:dingtalk:diagnose')?.({})).toMatchObject({ ok: true, status: { state: 'needs_login', enabled: false } })
    expect(await handlers.get('tool:dingtalk:login-check')?.({})).toMatchObject({ ok: true, status: { state: 'installed', enabled: false, identityFingerprint: 'synthetic-fingerprint' } })
    expect(await handlers.get('tool:dingtalk:set-enabled')?.({}, true)).toMatchObject({ ok: false })
  })

  it('routes unified catalog and plugin operations through validated IPC payloads', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const catalogService = {
      listSources: vi.fn(async () => []),
      listPackages: vi.fn(async () => ({ packages: [], conflicts: [] })),
      getSnapshot: vi.fn(async () => null),
      upsertSource: vi.fn(async (source) => source),
      removeSource: vi.fn(async () => undefined),
      syncSource: vi.fn(async (sourceId: string) => ({ sourceId, status: 'synced', stale: false }))
    }
    const pluginService = {
      listInstalled: vi.fn(async () => []),
      prepareImport: vi.fn(async (request) => ({ id: 'prepared-1', ...request })),
      cancelPrepared: vi.fn(async () => true),
      installPrepared: vi.fn(async (request) => ({ packageId: 'example', request })),
      rollback: vi.fn(async (request) => ({ packageId: request.packageId }))
    }
    const catalogCredentialService = {
      status: vi.fn(async (sourceId: string) => ({ sourceId, configured: true, storage: 'keychain' })),
      set: vi.fn(async () => 'keychain'),
      remove: vi.fn(async () => undefined),
      resolve: vi.fn(async () => undefined)
    }
    registerAppIpcHandlers(registerOptions({
      marketplaceCatalogService: catalogService as never,
      catalogCredentialService: catalogCredentialService as never,
      pluginManagementService: pluginService as never
    }))

    for (const channel of [
      'catalog:list-sources',
      'catalog:list-packages',
      'catalog:get-snapshot',
      'catalog:upsert-source',
      'catalog:list-credential-statuses',
      'catalog:set-credential',
      'catalog:clear-credential',
      'catalog:remove-source',
      'catalog:sync-source',
      'plugin:list-installed',
      'plugin:prepare-import',
      'plugin:cancel-import',
      'plugin:install',
      'plugin:rollback',
      'plugin:update-permissions'
    ]) {
      expect(handlers.get(channel), channel).toBeTypeOf('function')
    }

    await expect(handlers.get('catalog:list-packages')?.({})).resolves.toEqual({
      packages: [],
      conflicts: []
    })
    await expect(handlers.get('plugin:prepare-import')?.({}, {
      sourcePath: '/tmp/example.wwx',
      format: 'wwx'
    })).resolves.toMatchObject({ id: 'prepared-1', format: 'wwx' })
    expect(pluginService.prepareImport).toHaveBeenCalledWith({
      sourcePath: '/tmp/example.wwx',
      format: 'wwx',
      catalogSourceId: undefined
    })

    await expect(handlers.get('plugin:install')?.({}, {
      preparedId: 'prepared-1',
      reviewSha256: 'invalid',
      expectedCurrentVersion: null,
      scope: 'user',
      permissions: [],
      idempotencyKey: 'install-1'
    })).rejects.toThrow(/Invalid payload for plugin:install/)
    expect(pluginService.installPrepared).not.toHaveBeenCalled()

    await expect(handlers.get('catalog:upsert-source')?.({}, {
      schemaVersion: 1,
      id: 'unsafe',
      name: 'Unsafe',
      type: 'https',
      scope: 'team',
      location: 'https://plugins.example.com/catalog.json',
      trust: 'unverified',
      searchable: true,
      auth: { type: 'token', secretKey: 'catalog.token', token: 'plaintext' },
      sync: { mode: 'manual', state: 'idle', mirroredByDefault: false, installedByDefault: false }
    })).rejects.toThrow(/Invalid payload for catalog:upsert-source/)
    expect(catalogService.upsertSource).not.toHaveBeenCalled()

    const privateSource = {
      schemaVersion: 1,
      id: 'private',
      name: 'Private',
      type: 'https',
      scope: 'team',
      location: 'https://plugins.example.com/catalog.json',
      trust: 'unverified',
      searchable: true,
      auth: { type: 'token', secretKey: 'catalog.private.token' },
      sync: { mode: 'manual', state: 'idle', mirroredByDefault: false, installedByDefault: false }
    }
    catalogService.listSources.mockResolvedValue([privateSource] as never)
    await expect(handlers.get('catalog:set-credential')?.({}, {
      sourceId: 'private',
      accessToken: 'renderer-secret'
    })).resolves.toEqual({ sourceId: 'private', configured: true, storage: 'keychain' })
    expect(catalogCredentialService.set).toHaveBeenCalledWith('catalog.private.token', 'renderer-secret')
    await expect(handlers.get('catalog:list-credential-statuses')?.({})).resolves.toEqual([{
      sourceId: 'private',
      configured: true,
      storage: 'keychain'
    }])
    await expect(handlers.get('catalog:clear-credential')?.({}, { sourceId: 'private' }))
      .resolves.toEqual({ sourceId: 'private', configured: false })
    expect(catalogCredentialService.remove).toHaveBeenCalledWith('catalog.private.token')
  })

  it('reactivates MCP V2 after rollback and reviewed permission changes', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const source = {
      id: 'remote-source',
      catalogSourceId: 'workwise-official',
      kind: 'remote',
      location: 'https://mcp.example.test/'
    }
    const item = {
      schemaVersion: 1,
      id: 'remote-plugin',
      name: 'Remote Plugin',
      summary: 'IPC activation fixture.',
      tier: 'recommended',
      version: '1.0.0',
      publisher: { id: 'example', name: 'Example', verified: true },
      license: 'MIT',
      source,
      sources: [source],
      components: [{
        id: 'remote-mcp',
        name: 'Remote MCP',
        type: 'mcp',
        sourceId: source.id,
        runtime: {
          kind: 'remote',
          transport: 'streamable-http',
          endpoint: source.location
        }
      }],
      permissions: [{
        id: 'network-connect',
        kind: 'network',
        access: 'connect',
        default: 'review',
        reviewRequired: true,
        description: 'Connect to the remote MCP.'
      }],
      auth: { type: 'none' },
      licenseEvidence: [],
      dependencies: [],
      updatePolicy: { strategy: 'pinned', channel: 'stable', allowMajor: false },
      compatibility: {
        workwise: '>=0.3.5',
        platforms: ['darwin', 'win32', 'linux'],
        architectures: ['arm64', 'x64']
      },
      availability: { status: 'available' },
      installation: { mode: 'direct-mirror', installedByDefault: false, reinstallable: true }
    }
    const installed = {
      schemaVersion: 1,
      packageId: item.id,
      version: item.version,
      license: item.license,
      reviewSha256: 'a'.repeat(64),
      source,
      sources: [source],
      components: [{ componentId: 'remote-mcp', sourceId: source.id }],
      scope: 'user',
      artifact: { sha256: 'b'.repeat(64), location: '/tmp/plugin', fileCount: 1, totalBytes: 1 },
      permissions: [{ permissionId: 'network-connect', decision: 'granted' }],
      timestamps: { installedAt: '2026-08-08T00:00:00.000Z' },
      updatePolicy: item.updatePolicy,
      rollback: { available: false },
      health: { status: 'healthy' }
    }
    const rollback = vi.fn(async (request, afterRollback) => {
      await afterRollback(installed, item)
      return installed
    })
    const updatePermissions = vi.fn(async (_catalogItem, _request, afterUpdate) => {
      await afterUpdate(installed, item)
      return installed
    })
    const pluginService = {
      listInstalled: vi.fn(async () => [installed]),
      rollback,
      updatePermissions
    }
    const save = vi.fn(async ({ config }) => ({ ...config, revision: 1 }))
    registerAppIpcHandlers(registerOptions({
      marketplaceCatalogService: {
        listPackages: vi.fn(async () => ({
          packages: [{ key: 'official:remote-plugin', sourceId: 'workwise-official', package: item, conflicted: false }],
          conflicts: []
        }))
      } as never,
      pluginManagementService: pluginService as never,
      mcpConfigService: { list: vi.fn(async () => []), save, dispose: vi.fn() } as never
    }))

    await expect(handlers.get('plugin:rollback')?.({}, {
      packageId: item.id,
      expectedCurrentVersion: item.version,
      idempotencyKey: 'rollback-remote-plugin'
    })).resolves.toEqual(installed)
    await expect(handlers.get('plugin:update-permissions')?.({}, {
      packageId: item.id,
      expectedCurrentVersion: item.version,
      reviewSha256: 'a'.repeat(64),
      permissions: [{ permissionId: 'network-connect', decision: 'granted' }],
      idempotencyKey: 'permissions-remote-plugin'
    })).resolves.toEqual(installed)

    expect(rollback).toHaveBeenCalledWith(expect.objectContaining({ packageId: item.id }), expect.any(Function))
    expect(updatePermissions).toHaveBeenCalledWith(
      item,
      expect.objectContaining({ reviewSha256: 'a'.repeat(64) }),
      expect.any(Function)
    )
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        id: 'remote-mcp',
        transport: 'http',
        url: source.location,
        enabled: true
      })
    }))
  })

  it('saves generated files to a user-selected path', async () => {
    const { dialog } = await import('electron')
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const temp = mkdtempSync(join(tmpdir(), 'kun-save-as-'))
    const source = join(temp, 'source.png')
    const target = join(temp, 'downloaded.png')
    writeFileSync(source, 'generated-image')
    ;(dialog as unknown as { showSaveDialog: ReturnType<typeof vi.fn> }).showSaveDialog = vi.fn(async () => ({
      canceled: false,
      filePath: target
    }))

    try {
      registerAppIpcHandlers(registerOptions())

      const handler = handlers.get('file:save-as')
      await expect(handler?.({}, {
        sourcePath: source,
        suggestedName: 'source.png',
        mimeType: 'image/png'
      })).resolves.toEqual({ ok: true, path: target })
      expect(readFileSync(target, 'utf8')).toBe('generated-image')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('uses the current settings locale for native JSON save options and preserves exported bytes', async () => {
    const { dialog } = await import('electron')
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const temp = mkdtempSync(join(tmpdir(), 'workwise-save-locale-'))
    const target = join(temp, 'selected.json')
    const bytes = Buffer.from('{"name":"测量记录","value":0.005}\n')
    const configured = settings()
    configured.locale = 'zh'
    const window = {} as Electron.BrowserWindow
    const showSaveDialog = vi.fn(async () => ({ canceled: false, filePath: target }))
    ;(dialog as unknown as { showSaveDialog: typeof showSaveDialog }).showSaveDialog = showSaveDialog

    try {
      registerAppIpcHandlers(registerOptions({
        store: { load: vi.fn(async () => configured) } as never,
        getMainWindow: () => window
      }))
      const handler = handlers.get('file:save-as')
      const payload = {
        suggestedName: '../evidence.json',
        workspaceRoot: temp,
        dataBase64: bytes.toString('base64'),
        mimeType: 'application/json'
      }
      await expect(handler?.({}, payload)).resolves.toEqual({ ok: true, path: target })
      expect(showSaveDialog).toHaveBeenLastCalledWith(window, {
        title: '保存生成的文件',
        defaultPath: join(temp, 'evidence.json'),
        filters: [{ name: 'JSON 文件', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }]
      })
      expect(readFileSync(target)).toEqual(bytes)

      configured.locale = 'en'
      await expect(handler?.({}, payload)).resolves.toEqual({ ok: true, path: target })
      expect(showSaveDialog).toHaveBeenLastCalledWith(window, {
        title: 'Save generated file',
        defaultPath: join(temp, 'evidence.json'),
        filters: [{ name: 'JSON file', extensions: ['json'] }, { name: 'All Files', extensions: ['*'] }]
      })
      expect(readFileSync(target)).toEqual(bytes)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('keeps JSON save cancellation non-writing and rejects an escaped source before opening the dialog', async () => {
    const { dialog } = await import('electron')
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const temp = mkdtempSync(join(tmpdir(), 'workwise-save-cancel-'))
    const workspace = mkdtempSync(join(temp, 'workspace-'))
    const outsideSource = join(temp, 'outside.json')
    const target = join(workspace, 'untouched.json')
    writeFileSync(outsideSource, 'outside-source')
    writeFileSync(target, 'existing-target')
    const configured = { ...settings(), locale: 'zh' as const }
    const showSaveDialog = vi.fn(async () => ({ canceled: true, filePath: target }))
    ;(dialog as unknown as { showSaveDialog: typeof showSaveDialog }).showSaveDialog = showSaveDialog

    try {
      registerAppIpcHandlers(registerOptions({ store: { load: vi.fn(async () => configured) } as never }))
      const handler = handlers.get('file:save-as')
      await expect(handler?.({}, {
        workspaceRoot: workspace,
        suggestedName: 'evidence.json',
        mimeType: 'application/json',
        dataBase64: Buffer.from('replacement').toString('base64')
      })).resolves.toEqual({ ok: false, canceled: true, message: 'Save cancelled.' })
      expect(showSaveDialog).toHaveBeenCalledWith({
        title: '保存生成的文件',
        defaultPath: join(workspace, 'evidence.json'),
        filters: [{ name: 'JSON 文件', extensions: ['json'] }, { name: '所有文件', extensions: ['*'] }]
      })
      expect(readFileSync(target, 'utf8')).toBe('existing-target')

      await expect(handler?.({}, {
        workspaceRoot: workspace,
        sourcePath: '../outside.json'
      })).resolves.toMatchObject({ ok: false })
      expect(showSaveDialog).toHaveBeenCalledTimes(1)
      expect(readFileSync(outsideSource, 'utf8')).toBe('outside-source')
      expect(readFileSync(target, 'utf8')).toBe('existing-target')
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('opens and reveals verified workspace artifacts', async () => {
    const { shell } = await import('electron')
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const temp = mkdtempSync(join(tmpdir(), 'workwise-artifact-actions-'))
    const source = join(temp, 'deck.pptx')
    writeFileSync(source, 'fixture')

    try {
      registerAppIpcHandlers(registerOptions())

      await expect(handlers.get('file:open-workspace')?.({}, {
        path: 'deck.pptx',
        workspaceRoot: temp
      })).resolves.toEqual({ ok: true })
      await expect(handlers.get('file:reveal-workspace')?.({}, {
        path: 'deck.pptx',
        workspaceRoot: temp
      })).resolves.toEqual({ ok: true })
      const canonicalSource = realpathSync(source)
      expect(shell.openPath).toHaveBeenCalledWith(canonicalSource)
      expect(shell.showItemInFolder).toHaveBeenCalledWith(canonicalSource)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })

  it('accepts the full settings snapshot emitted by SettingsView auto-apply', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const applySettingsPatch = vi.fn(async () => settings())

    registerAppIpcHandlers(registerOptions({ applySettingsPatch }))

    const payload = { ...settings(), locale: 'zh' as const }
    const handler = handlers.get('settings:set')
    await expect(handler?.({}, payload)).resolves.toEqual(settings())
    expect(applySettingsPatch).toHaveBeenCalledWith(payload)
  })

  it('passes schedule settings patches through to applySettingsPatch', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const applySettingsPatch = vi.fn(async (partial: AppSettingsPatch) => ({
      ...settings(),
      schedule: mergeScheduleSettings(settings().schedule, partial.schedule)
    }))

    registerAppIpcHandlers(registerOptions({ applySettingsPatch }))

    const payload = {
      schedule: {
        enabled: true,
        keepAwake: true,
        tasks: [{
          id: 'task-1',
          title: 'Daily',
          enabled: true,
          prompt: 'Run',
          schedule: { kind: 'manual' as const }
        }]
      }
    }
    const handler = handlers.get('settings:set')
    await expect(handler?.({}, payload)).resolves.toMatchObject({
      schedule: {
        enabled: true,
        keepAwake: true,
        tasks: [{ id: 'task-1', prompt: 'Run' }]
      }
    })
    expect(applySettingsPatch).toHaveBeenCalledWith(payload)
  })

  it('writes MCP config JSON and notifies the runtime apply hook', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const tempRoot = mkdtempSync(join(tmpdir(), 'workwise-ipc-'))
    const configPath = join(tempRoot, 'mcp.json')
    const onRuntimeMcpConfigWritten = vi.fn(async () => undefined)
    const content = `${JSON.stringify({
      servers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/project']
        }
      }
    }, null, 2)}\n`

    try {
      registerAppIpcHandlers(registerOptions({
        resolveRuntimeConfigPath: () => configPath,
        onRuntimeMcpConfigWritten
      }))

      await expect(handlers.get('runtime:config:write')?.({}, content)).resolves.toEqual({
        ok: true,
        path: configPath
      })
      expect(readFileSync(configPath, 'utf8')).toBe(content)
      expect(onRuntimeMcpConfigWritten).toHaveBeenCalledWith(configPath, content)
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects invalid MCP config JSON before writing or applying it', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const tempRoot = mkdtempSync(join(tmpdir(), 'workwise-ipc-'))
    const configPath = join(tempRoot, 'mcp.json')
    const onRuntimeMcpConfigWritten = vi.fn(async () => undefined)

    try {
      registerAppIpcHandlers(registerOptions({
        resolveRuntimeConfigPath: () => configPath,
        onRuntimeMcpConfigWritten
      }))

      await expect(handlers.get('runtime:config:write')?.({}, '{')).rejects.toThrow(
        /MCP config must be JSON/
      )
      await expect(handlers.get('runtime:config:write')?.({}, '[]')).rejects.toThrow(
        /MCP config must be a JSON object/
      )
      expect(existsSync(configPath)).toBe(false)
      expect(onRuntimeMcpConfigWritten).not.toHaveBeenCalled()
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('uses the GUI-managed WeChat bridge for WeChat install handlers', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const configuredSettings = settings()
    configuredSettings.claw.im.weixinBridgeUrl = 'http://127.0.0.1:8787/rpc'
    const store = { load: vi.fn(async () => configuredSettings) }
    const startWeixinInstallQrcode = vi.fn(async () => ({
      ok: false as const,
      message: 'expected test response'
    }))
    const pollWeixinInstall = vi.fn(async () => ({ done: false as const }))

    registerAppIpcHandlers(registerOptions({
      store: store as never,
      startWeixinInstallQrcode,
      pollWeixinInstall
    }))

    await expect(
      handlers.get('claw:im-install:qrcode')?.({}, { provider: 'weixin' })
    ).resolves.toMatchObject({ ok: false })
    await expect(
      handlers.get('claw:im-install:poll')?.({}, { provider: 'weixin', deviceCode: 'device-1' })
    ).resolves.toEqual({ done: false })

    expect(startWeixinInstallQrcode).toHaveBeenCalledWith()
    expect(pollWeixinInstall).toHaveBeenCalledWith('device-1')
  })

  it('routes schedule task IPC calls to the Schedule runtime', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const scheduleRuntime = {
      status: vi.fn(async () => ({
        internalServerRunning: true,
        internalUrl: 'http://127.0.0.1:8788',
        runningTaskIds: ['task-1'],
        powerSaveBlockerActive: true
      })),
      runTask: vi.fn(async (taskId: string) => ({ ok: true as const, taskId, message: 'Started' })),
      createScheduledTaskFromText: vi.fn(async () => ({
        kind: 'created' as const,
        taskId: 'task-2',
        title: 'Reminder',
        scheduleAt: '2026-06-03T09:00:00.000+08:00',
        confirmationText: 'Scheduled.'
      }))
    }
    registerAppIpcHandlers(registerOptions({
      getScheduleRuntime: () => scheduleRuntime as never
    }))

    await expect(handlers.get('schedule:status')?.({})).resolves.toMatchObject({
      internalServerRunning: true,
      runningTaskIds: ['task-1'],
      powerSaveBlockerActive: true
    })
    await expect(handlers.get('schedule:task:run')?.({}, 'task-1')).resolves.toMatchObject({
      ok: true,
      taskId: 'task-1'
    })
    await expect(
      handlers.get('schedule:task:create-from-text')?.({}, {
        text: 'Remind me tomorrow.',
        workspaceRoot: '/tmp/schedule',
        modelHint: 'deepseek-v4-flash',
        mode: 'plan'
      })
    ).resolves.toMatchObject({
      kind: 'created',
      taskId: 'task-2'
    })

    expect(scheduleRuntime.runTask).toHaveBeenCalledWith('task-1')
    expect(scheduleRuntime.createScheduledTaskFromText).toHaveBeenCalledWith('Remind me tomorrow.', {
      workspaceRoot: '/tmp/schedule',
      modelHint: 'deepseek-v4-flash',
      mode: 'plan'
    })
  })

  it('routes desktop command IPC calls to the focused window and web contents', async () => {
    const { registerAppIpcHandlers } = await import('./register-app-ipc-handlers')
    const webContents = {
      undo: vi.fn(),
      redo: vi.fn(),
      cut: vi.fn(),
      copy: vi.fn(),
      paste: vi.fn(),
      selectAll: vi.fn(),
      reload: vi.fn(),
      getZoomLevel: vi.fn(() => 0),
      setZoomLevel: vi.fn(),
      toggleDevTools: vi.fn()
    }
    const mainWindow = {
      isDestroyed: vi.fn(() => false),
      webContents,
      minimize: vi.fn(),
      isMaximized: vi.fn(() => false),
      maximize: vi.fn(),
      unmaximize: vi.fn(),
      close: vi.fn()
    }

    registerAppIpcHandlers(registerOptions({
      getMainWindow: () => mainWindow as never
    }))

    const handler = handlers.get('desktop:command')
    await handler?.({ sender: webContents }, 'copy')
    await handler?.({ sender: webContents }, 'zoomIn')
    await handler?.({ sender: webContents }, 'toggleMaximize')
    await handler?.({ sender: webContents }, 'close')

    expect(webContents.copy).toHaveBeenCalledTimes(1)
    expect(webContents.setZoomLevel).toHaveBeenCalledWith(1)
    expect(mainWindow.maximize).toHaveBeenCalledTimes(1)
    expect(mainWindow.close).toHaveBeenCalledTimes(1)
  })
})
