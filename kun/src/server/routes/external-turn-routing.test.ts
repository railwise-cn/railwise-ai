import { describe, expect, it, vi } from 'vitest'
import { buildRouter } from './index.js'
import type { ServerRuntime } from './server-runtime.js'
import type { JsonResponse } from '../response.js'

async function responseJson(response: JsonResponse | Response): Promise<unknown> {
  return typeof response.body === 'string' ? JSON.parse(response.body) : (response as Response).json()
}

const capability = {
  provider: 'dingtalk', status: 'unsupported', message: '钉钉连接器尚未配置。',
  credentialState: 'missing', networkState: 'unknown', workspaceState: 'unknown', sandboxState: 'allowed',
  approvalState: 'not_required', checkedAt: '2026-11-10T00:00:00.000Z'
} as const

function routeFor(runtime: Partial<ServerRuntime>) {
  const route = buildRouter({ runtimeToken: 'route-test-token', insecure: false, ...runtime } as ServerRuntime)
    .match('POST', '/v1/threads/origin/turns')!
  return (body: unknown) => route.handler(new Request('http://runtime/v1/threads/origin/turns', {
    method: 'POST', headers: { authorization: 'Bearer route-test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }), { params: route.params })
}

describe('legacy thread turn route and task coordinator', () => {
  it('answers status locally even when no task exists, without provider checks or a model Turn', async () => {
    const command = vi.fn(async () => ({kind:'snapshot' as const,task:null}))
    const preflightExternalTask = vi.fn()
    const startTurn = vi.fn()
    const runTurn = vi.fn()
    const handler = routeFor({preflightExternalTask,
      taskCoordinator:{command} as unknown as ServerRuntime['taskCoordinator'],
      turnService:{startTurn} as unknown as ServerRuntime['turnService'],runTurn})
    const response = await handler({prompt:'WRAPPER: execute tools',displayText:'现在做到哪了',taskIntent:'new'})
    expect(response.status).toBe(200)
    expect(await responseJson(response)).toMatchObject({kind:'snapshot',message:'当前没有进行中的任务。'})
    expect(command).toHaveBeenCalledWith(expect.objectContaining({threadId:'origin',intent:'status'}))
    expect(preflightExternalTask).not.toHaveBeenCalled()
    expect(startTurn).not.toHaveBeenCalled()
    expect(runTurn).not.toHaveBeenCalled()
  })
  it('admits a dual-platform action through the coordinator without a single-provider preflight result', async () => {
    const command = vi.fn(async () => ({kind:'attention_required' as const,attentionId:'provider-choice',message:'选择一个平台'}))
    const startTurn = vi.fn()
    const handler = routeFor({
      preflightExternalTask:vi.fn(() => null),
      taskCoordinator:{command} as unknown as ServerRuntime['taskCoordinator'],
      turnService:{startTurn} as unknown as ServerRuntime['turnService']
    })
    const response = await handler({prompt:'帮我处理钉钉和飞书待办'})
    expect(command).toHaveBeenCalledOnce()
    expect(startTurn).not.toHaveBeenCalled()
    expect(await responseJson(response)).toMatchObject({kind:'attention_required',attentionId:'provider-choice'})
  })
  it('persists unsupported external work through TaskCoordinator without allocating a Turn', async () => {
    const command = vi.fn(async () => ({
      kind: 'capability_required' as const, message: capability.message, capability, attentionId: 'attention-1',
      task: { id: 'task-1' }
    }))
    const startTurn = vi.fn()
    const handler = routeFor({
      preflightExternalTask: vi.fn(() => capability),
      taskCoordinator: { command } as unknown as ServerRuntime['taskCoordinator'],
      turnService: { startTurn } as unknown as ServerRuntime['turnService']
    })

    const response = await handler({ prompt: '处理钉钉里的待办事项', idempotencyKey: 'dingtalk-request' })
    expect(response.status).toBe(409)
    expect(await responseJson(response)).toMatchObject({ code: 'capability_required', taskId: 'task-1', capability })
    expect(command).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'origin', idempotencyKey: 'dingtalk-request', request: expect.objectContaining({ prompt: '处理钉钉里的待办事项' })
    }))
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('routes configured external work through the task command and returns the actual execution Turn', async () => {
    const turn = { threadId: 'execution-thread', turnId: 'turn-1', userMessageItemId: 'item-1' }
    const command = vi.fn(async () => ({ kind: 'task_started' as const, task: { id: 'task-1' }, turn }))
    const startTurn = vi.fn()
    const handler = routeFor({
      preflightExternalTask: vi.fn(() => ({ ...capability, status: 'available' as const, credentialState: 'valid' as const })),
      taskCoordinator: { command } as unknown as ServerRuntime['taskCoordinator'],
      turnService: { startTurn } as unknown as ServerRuntime['turnService']
    })

    const response = await handler({ prompt: '处理钉钉里的待办事项', displayText: '处理钉钉里的待办事项' })
    expect(response.status).toBe(202)
    expect(await responseJson(response)).toEqual(turn)
    expect(command).toHaveBeenCalledOnce()
    expect(startTurn).not.toHaveBeenCalled()
  })

  it('routes follow-up messages on an active task through TaskCoordinator while preserving ordinary chat', async () => {
    const command = vi.fn(async () => ({ kind: 'snapshot' as const, task: { id: 'task-1', goal: '处理飞书待办', status: 'running' } }))
    const startTurn = vi.fn(async () => ({ threadId: 'origin', turnId: 'chat-turn', userMessageItemId: 'item-2' }))
    const handler = routeFor({
      taskRepository: { findActiveByOrigin: () => ({ id: 'task-1' }), findActiveByThread: () => null } as unknown as ServerRuntime['taskRepository'],
      taskCoordinator: { command } as unknown as ServerRuntime['taskCoordinator'],
      turnService: { startTurn } as unknown as ServerRuntime['turnService'],
      runTurn: vi.fn()
    })

    const routed = await handler({ prompt: '现在做到哪了' })
    expect(routed.status).toBe(200)
    expect(await responseJson(routed)).toMatchObject({ kind: 'snapshot', taskId: 'task-1' })
    expect(command).toHaveBeenCalledOnce()
    expect(startTurn).not.toHaveBeenCalled()

    const directHandler = routeFor({ turnService: { startTurn } as unknown as ServerRuntime['turnService'], runTurn: vi.fn() })
    const direct = await directHandler({ prompt: '写一首关于雨天的短诗' })
    expect(direct.status).toBe(202)
    expect(await responseJson(direct)).toMatchObject({ turnId: 'chat-turn' })
    expect(startTurn).toHaveBeenCalledOnce()
  })

  it('routes an explicit new task through TaskCoordinator even without an active task or external provider', async () => {
    const command = vi.fn(async () => ({ kind: 'task_started' as const, turn: { threadId: 'execution-thread', turnId: 'task-turn' } }))
    const startTurn = vi.fn()
    const handler = routeFor({
      taskCoordinator: { command } as unknown as ServerRuntime['taskCoordinator'],
      turnService: { startTurn } as unknown as ServerRuntime['turnService']
    })

    const response = await handler({ prompt: '整理本月监测资料并生成报告', taskIntent: 'new' })
    expect(response.status).toBe(202)
    expect(await responseJson(response)).toMatchObject({ threadId: 'execution-thread', turnId: 'task-turn' })
    expect(command).toHaveBeenCalledOnce()
    expect(startTurn).not.toHaveBeenCalled()
  })
})
