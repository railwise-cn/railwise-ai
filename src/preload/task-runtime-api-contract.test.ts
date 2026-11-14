import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { WorkWiseApi } from '../shared/workwise-api'
import { mcpServerSavePayloadSchema, runtimeRequestPayloadSchema, sseStartPayloadSchema } from '../main/ipc/app-ipc-schemas'

const bridge = vi.hoisted(() => ({ exposed: new Map<string, unknown>(), invoke: vi.fn() }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => bridge.exposed.set(name, api) },
  ipcRenderer: { invoke: bridge.invoke, on: vi.fn(), removeListener: vi.fn() },
  webUtils: { getPathForFile: vi.fn() }
}))

describe('production preload task API and main IPC contract', () => {
  let api: WorkWiseApi
  beforeAll(async () => {
    bridge.invoke.mockImplementation(async (channel: string, payload: unknown) => {
      if (channel === 'runtime:request') {
        runtimeRequestPayloadSchema.parse(payload)
        return { ok: true, status: 200, body: '{}' }
      }
      if (channel === 'runtime:sse:start') return sseStartPayloadSchema.parse(payload)
      if (channel === 'shell:open-dingtalk-desktop') return { ok: true }
      if (channel === 'mcp-server:save') return mcpServerSavePayloadSchema.parse(payload).config
      if (channel === 'mcp-server:test') return { id: 'amap', state: 'connected', authorized: true, verification: 'tool_discovery', toolCount: 11, checkedAt: '2026-11-12T01:02:03.000Z' }
      throw new Error(`Unexpected task API channel: ${channel}`)
    })
    await import('./index')
    api = bridge.exposed.get('workwise') as WorkWiseApi
  })

  it('passes the fixed DingTalk desktop action without renderer-supplied launch arguments', async () => {
    expect(await api.openDingTalkDesktop()).toEqual({ ok: true })
    expect(bridge.invoke).toHaveBeenCalledWith('shell:open-dingtalk-desktop')
  })

  it('keeps main-owned connection evidence out of save payloads while forwarding actual diagnostic results', async () => {
    const config = { id: 'amap', name: 'Amap', scope: 'global' as const, transport: 'http' as const, url: 'https://mcp.amap.com/mcp', timeoutMs: 1000, source: 'managed-tool' as const, toolPolicy: {}, enabled: true, revision: 2,
      connectionCheck: { serverRevision: 2, configurationHash: 'a'.repeat(64), checkedAt: '2026-11-12T01:02:03.000Z', state: 'connected' as const, authorized: true } }
    await api.saveMcpServer({ config, expectedRevision: 2, idempotencyKey: 'test-save' })
    const sent = [...bridge.invoke.mock.calls].reverse().find(call => call[0] === 'mcp-server:save')![1] as { config: Record<string, unknown> }
    expect(sent.config).not.toHaveProperty('connectionCheck')
    expect(config.connectionCheck.authorized).toBe(true)
    expect(await api.testMcpServer('amap')).toMatchObject({ verification: 'tool_discovery', toolCount: 11, checkedAt: '2026-11-12T01:02:03.000Z' })
  })

  it('passes actual task list, detail, mutation, inbox, template and Shell requests through the desktop boundary', async () => {
    const mutation = { expectedRevision: 1, idempotencyKey: 'mutation-1' }
    const cursor = Buffer.from(JSON.stringify({ id: 'snapshot_1', offset: 200 })).toString('base64url')
    await api.listTaskPage({ filter: 'all', limit: 200 })
    await api.listTaskPage({ filter: 'all', limit: 200, cursor })
    await api.listTaskPage({ filter: 'ongoing', workspaceRoot: '/workspace', threadId: 'origin_1', search: '报告', limit: 50 })
    await api.listTaskRuns({ threadId: 'origin_1', status: 'running', workspaceRoot: '/workspace', search: '报告', limit: 100, offset: 2, cursor })
    await api.getTaskRun('task_1')
    await api.listTaskOperationReceipts('task_1')
    await api.verifyTaskOperationReceipt('task_1', 'receipt_1', mutation)
    await api.resumeTask('task_1', mutation)
    await api.retryTask('task_1', mutation)
    await api.cancelTask('task_1', mutation)
    await api.pauseTask('task_1', mutation)
    await api.listTaskInputs('task_1')
    await api.appendTaskInput('task_1', { ...mutation, text: '补充风险分析。' })
    await api.listTaskEvents('task_1', 2)
    await api.listTaskInbox('/workspace')
    await api.listTaskTemplates()
    await api.startTaskTemplate('research-document', { ...mutation, workspaceRoot: '/workspace', goal: '交付研究报告', sourcePaths: ['source.md'] })
    await api.saveTaskTemplate('research-document', { workspaceRoot: '/workspace', goal: '交付研究报告', name: '用户研究模板' })
    await api.getTaskDiagnostics('task_1')
    await api.listShellSessions('task_1')
    await api.terminateShellSession('shell_1', { expectedRevision: 1, idempotencyKey: 'terminate-1' })
    expect(bridge.invoke).toHaveBeenCalledWith('runtime:request', { path: '/v1/tasks?pagination=cursor&filter=all&limit=200', method: 'GET' })
    expect(bridge.invoke).toHaveBeenCalledWith('runtime:request', { path: '/v1/tasks/task_1/receipts', method: 'GET' })
    expect(bridge.invoke).toHaveBeenCalledWith('runtime:request', { path: '/v1/tasks/task_1/receipts/receipt_1/verify', method: 'POST', body: JSON.stringify(mutation) })
  })

  it('passes both browser binding methods used by the review panel through the real main validator', async () => {
    const request = { expectedTaskRevision: 6, expectedBrowserRevision: 8, browserInstanceId: 'chrome-current',
      origins: ['https://example.com'], interaction: 'interact' as const, confirmed: true as const, idempotencyKey: 'binding-reviewed' }
    await api.getBrowserTaskBinding('task-original')
    await api.confirmBrowserTaskBinding('task-original', request)
    expect(bridge.invoke).toHaveBeenCalledWith('runtime:request', { path: '/v1/tasks/task-original/browser-binding', method: 'GET' })
    expect(bridge.invoke).toHaveBeenCalledWith('runtime:request', { path: '/v1/tasks/task-original/browser-binding', method: 'POST', body: JSON.stringify(request) })
    for (const duration of ['task', 'schedule'] as const) {
      await api.confirmBrowserTaskBinding('task-original', { ...request, publicQueryAuthorization: duration })
      expect(bridge.invoke).toHaveBeenCalledWith('runtime:request', { path: '/v1/tasks/task-original/browser-binding', method: 'POST', body: JSON.stringify({ ...request, publicQueryAuthorization: duration }) })
    }
    await expect(api.getBrowserTaskBinding('task-original/../task-other')).rejects.toThrow()
    await expect(api.confirmBrowserTaskBinding('task-original', { ...request, taskId: 'task-other' } as typeof request)).rejects.toThrow()
  })

  it('passes real chat/model and candidate review commands, and the aggregate task stream, through their typed boundaries', async () => {
    await api.coordinateTaskCommand({ threadId: 'origin_1', intent: 'auto', idempotencyKey: 'chat-1', request: {
      prompt: '根据资料形成报告', displayText: '形成报告', mode: 'agent', model: 'deepseek-flash', providerId: 'deepseek', reasoningEffort: 'high', attachmentIds: ['attachment_1'], workspaceReferences: [{ path: 'source.md', kind: 'file' }]
    } })
    await api.coordinateTaskCommand({ threadId: 'hidden_execution_1', taskId: 'task_1', intent: 'new', idempotencyKey: 'regenerate-1', request: { prompt: '重读资料，只重生成风险章节。', model: 'deepseek-flash' } })
    await api.startTaskSse(12, 'stream_1')
    expect(bridge.invoke).toHaveBeenCalledWith('runtime:sse:start', { scope: 'tasks', sinceSeq: 12, streamId: 'stream_1' })
  })
})
