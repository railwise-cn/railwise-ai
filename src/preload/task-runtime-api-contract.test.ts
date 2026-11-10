import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { WorkWiseApi } from '../shared/workwise-api'
import { runtimeRequestPayloadSchema, sseStartPayloadSchema } from '../main/ipc/app-ipc-schemas'

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
      throw new Error(`Unexpected task API channel: ${channel}`)
    })
    await import('./index')
    api = bridge.exposed.get('workwise') as WorkWiseApi
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

  it('passes real chat/model and candidate review commands, and the aggregate task stream, through their typed boundaries', async () => {
    await api.coordinateTaskCommand({ threadId: 'origin_1', intent: 'auto', idempotencyKey: 'chat-1', request: {
      prompt: '根据资料形成报告', displayText: '形成报告', mode: 'agent', model: 'deepseek-flash', providerId: 'deepseek', reasoningEffort: 'high', attachmentIds: ['attachment_1'], workspaceReferences: [{ path: 'source.md', kind: 'file' }]
    } })
    await api.coordinateTaskCommand({ threadId: 'hidden_execution_1', taskId: 'task_1', intent: 'new', idempotencyKey: 'regenerate-1', request: { prompt: '重读资料，只重生成风险章节。', model: 'deepseek-flash' } })
    await api.startTaskSse(12, 'stream_1')
    expect(bridge.invoke).toHaveBeenCalledWith('runtime:sse:start', { scope: 'tasks', sinceSeq: 12, streamId: 'stream_1' })
  })
})
