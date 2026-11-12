import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  defaultClawSettings,
  defaultKeyboardShortcuts,
  defaultManagedRuntimeSettings,
  defaultModelProviderSettings,
  defaultScheduleSettings,
  defaultWriteSettings,
  getManagedRuntimeSettings,
  mergeScheduleSettings,
  type AppSettingsPatch,
  type AppSettingsV1,
  type ScheduledTaskV1
} from '../shared/app-settings'
import { ScheduleRuntime, computeScheduleNextRunAt, scheduledThreadTitle } from './schedule-runtime'

function makeTask(patch: Partial<ScheduledTaskV1> = {}): ScheduledTaskV1 {
  const schedule = {
    kind: 'manual' as const,
    everyMinutes: 60,
    timeOfDay: '09:00',
    atTime: '',
    ...patch.schedule
  }
  return {
    id: 'task-1',
    title: 'Task 1',
    enabled: true,
    prompt: 'Run the task',
    workspaceRoot: '/tmp/workspace',
    model: 'auto',
    reasoningEffort: 'medium',
    mode: 'agent',
    createdAt: '2026-06-02T00:00:00.000Z',
    updatedAt: '2026-06-02T00:00:00.000Z',
    lastRunAt: '',
    nextRunAt: '',
    lastStatus: 'idle',
    lastMessage: '',
    lastThreadId: '',
    ...patch,
    schedule
  }
}

function settingsWith(
  tasks: ScheduledTaskV1[] = [],
  schedulePatch: AppSettingsPatch['schedule'] = {},
  providerId = ''
): AppSettingsV1 {
  return {
    version: 1,
    locale: 'en',
    theme: 'system',
    uiFontScale: 'small',
    provider: defaultModelProviderSettings(),
    agents: {
      kun: { ...defaultManagedRuntimeSettings(), apiKey: 'test-key', providerId }
    },
    workspaceRoot: '/tmp/workspace',
    log: { enabled: true, retentionDays: 7 },
    notifications: { turnComplete: true },
    appBehavior: { openAtLogin: false, startMinimized: false, closeToTray: false },
    keyboardShortcuts: defaultKeyboardShortcuts(),
    write: defaultWriteSettings(),
    claw: defaultClawSettings(),
    schedule: mergeScheduleSettings(defaultScheduleSettings(), {
      enabled: true,
      tasks,
      ...schedulePatch
    }, providerId || undefined),
    guiUpdate: { channel: 'stable' },
    codePromptPrefix: ''
  }
}

function createStore(initial: AppSettingsV1) {
  let current = initial
  return {
    load: vi.fn(async () => current),
    patch: vi.fn(async (partial: AppSettingsPatch) => {
      current = {
        ...current,
        schedule: mergeScheduleSettings(
          current.schedule,
          partial.schedule,
          getManagedRuntimeSettings(current).providerId || undefined
        ),
        claw: current.claw
      }
      return current
    }),
    replace: (next: AppSettingsV1) => { current = next },
    read: () => current
  }
}

function createRuntime(initial: AppSettingsV1, runtimeRequest = vi.fn()) {
  const store = createStore(initial)
  const runtime = new ScheduleRuntime({
    store: store as never,
    runtimeRequest: runtimeRequest as never,
    logError: vi.fn()
  })
  return { runtime, store, runtimeRequest }
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

describe('ScheduleRuntime', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rebinds to a changed schedule port instead of reusing the candidate reservation', async () => {
    const reservedServer = createServer()
    const targetReservation = createServer()
    const reservedPort = await listenOnLoopback(reservedServer)
    const targetPort = await listenOnLoopback(targetReservation)
    await closeServer(targetReservation)
    const initial = settingsWith([], { internal: { port: reservedPort, secret: 'private-secret' } })
    const runtime = new ScheduleRuntime({
      store: createStore(initial) as never,
      runtimeRequest: vi.fn() as never,
      logError: vi.fn(),
      internalServer: reservedServer
    })
    const internalRuntime = runtime as unknown as {
      server: Server | null
      syncInternalServer: (settings: AppSettingsV1) => void
      closeInternalServer: () => void
    }
    try {
      internalRuntime.syncInternalServer(initial)
      expect(internalRuntime.server).toBe(reservedServer)
      const moved = settingsWith([], { internal: { port: targetPort, secret: 'private-secret' } })
      internalRuntime.syncInternalServer(moved)
      const rebound = internalRuntime.server
      expect(rebound).not.toBe(reservedServer)
      if (!rebound?.listening) await new Promise<void>((resolve) => rebound?.once('listening', resolve))
      expect((rebound?.address() as AddressInfo).port).toBe(targetPort)
      const health = await fetch(`http://127.0.0.1:${targetPort}/schedule/internal/health`)
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ status: 'ok', service: 'schedule' })
    } finally {
      internalRuntime.closeInternalServer()
      await closeServer(reservedServer)
    }
  })

  it('computes nextRunAt for supported schedule kinds', () => {
    const from = new Date('2026-06-02T00:00:00.000Z')

    expect(computeScheduleNextRunAt(makeTask(), from)).toBe('')
    expect(computeScheduleNextRunAt(makeTask({
      schedule: { kind: 'interval', everyMinutes: 15, timeOfDay: '09:00', atTime: '' }
    }), from)).toBe('2026-06-02T00:15:00.000Z')
    expect(computeScheduleNextRunAt(makeTask({
      schedule: {
        kind: 'at',
        everyMinutes: 60,
        timeOfDay: '09:00',
        atTime: '2026-06-03T09:00:00.000+08:00'
      }
    }), from)).toBe('2026-06-03T09:00:00.000+08:00')
  })

  it('builds compact Scheduled task thread titles from task names', () => {
    expect(scheduledThreadTitle('每日A股行情盘')).toBe('[Scheduled task] 每日A股')
    expect(scheduledThreadTitle('Task 1')).toBe('[Scheduled task] Task')
    expect(scheduledThreadTitle('   ')).toBe('[Scheduled task]')
  })

  it('creates detected reminder requests into top-level schedule settings', async () => {
    const future = '2099-06-03T09:00:00.000Z'
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              shouldCreateTask: true,
              scheduleAt: future,
              reminderBody: 'ship the review',
              taskName: 'Ship review'
            })
          }
        }]
      })
    })))
    const { runtime, store } = createRuntime(settingsWith())
    vi.spyOn(runtime, 'sync').mockImplementation(() => undefined)

    const result = await runtime.createScheduledTaskFromText('Remind me tomorrow to ship the review.', {
      workspaceRoot: '/tmp/schedule',
      modelHint: 'deepseek-v4-flash',
      mode: 'plan'
    })

    expect(result).toMatchObject({
      kind: 'created',
      title: 'Ship review reminder',
      scheduleAt: future
    })
    expect(store.read().schedule.enabled).toBe(true)
    expect(store.read().schedule.tasks[0]).toMatchObject({
      title: 'Ship review reminder',
      workspaceRoot: '/tmp/schedule',
      model: 'deepseek-flash',
      mode: 'plan',
      schedule: { kind: 'at', atTime: future }
    })
    expect(store.read().claw.tasks).toEqual([])
  })

  it('starts a WorkWise Runtime thread with a Schedule title and records running status', async () => {
    const task = makeTask({ reasoningEffort: 'max', model: 'deepseek-v4-pro' })
    const initial = settingsWith([task])
    initial.schedule.tasks[0].model = 'deepseek-v4-pro'
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads') {
        return { ok: true, status: 200, body: JSON.stringify({ id: 'thr_1' }) }
      }
      if (path === '/v1/threads/thr_1' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_1/turns') {
        return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_1' }) }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const { runtime, store } = createRuntime(initial, runtimeRequest)
    ;(runtime as unknown as { monitorTaskTurn: () => void }).monitorTaskTurn = vi.fn()

    await expect(runtime.runTask(task.id)).resolves.toMatchObject({
      ok: true,
      threadId: 'thr_1',
      turnId: 'turn_1'
    })

    const createRequest = runtimeRequest.mock.calls.find(([, path, init]) =>
      path === '/v1/threads' && init?.method === 'POST'
    )?.[2]?.body
    const turnRequest = runtimeRequest.mock.calls.find(([, path]) =>
      path === '/v1/threads/thr_1/turns'
    )?.[2]?.body
    expect(JSON.parse(String(createRequest))).toMatchObject({
      title: '[Scheduled task] Task',
      workspace: '/tmp/workspace',
      model: 'deepseek-flash',
      mode: 'agent'
    })
    expect(JSON.parse(String(turnRequest))).toMatchObject({
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // Headless turn: a user_input request would hang until timeout.
      disableUserInput: true
    })
    expect(store.read().schedule.tasks[0]).toMatchObject({
      lastStatus: 'running',
      lastThreadId: 'thr_1',
      lastMessage: 'Started'
    })
  })

  it('keeps an explicit model id when a custom provider runs a scheduled task', async () => {
    const task = makeTask({ model: 'deepseek-v4-pro' })
    const initial = settingsWith([task], {}, 'custom-provider')
    const { runtime } = createRuntime(initial)
    const runPrompt = vi.spyOn(runtime as unknown as {
      runPrompt: (settings: AppSettingsV1, options: Record<string, unknown>) => Promise<{
        ok: boolean
        threadId: string
        turnId: string
      }>
    }, 'runPrompt').mockResolvedValue({ ok: true, threadId: 'thr_custom', turnId: 'turn_custom' })
    ;(runtime as unknown as { monitorTaskTurn: () => void }).monitorTaskTurn = vi.fn()

    await expect(runtime.runTask(task.id)).resolves.toMatchObject({ ok: true, threadId: 'thr_custom' })
    expect(runPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ agents: expect.any(Object) }),
      expect.objectContaining({ model: 'deepseek-v4-pro' })
    )
  })

  it.each([
    { ok: false, status: 409, body: { code: 'capability_required', taskId: 'task_blocked', attentionId: 'attention_1', message: '请先授权飞书。' } },
    { ok: true, status: 202, body: { kind: 'attention_required', taskId: 'task_blocked', attentionId: 'attention_1', message: '请选择任务范围。' } },
    { ok: true, status: 202, body: { kind: 'input_queued', taskId: 'task_blocked', message: '补充已保存。' } }
  ])('preserves a coordinated no-Turn response as waiting, not an error or completed run ($status)', async (response) => {
    const task = makeTask({
      prompt: '帮我处理飞书待办',
      schedule: { kind: 'at', everyMinutes: 60, timeOfDay: '09:00', atTime: '2099-06-03T09:00:00.000Z' }
    })
    const runtimeRequest = vi.fn(async (_settings, path, _init?: { body?: unknown }) => {
      if (path === '/v1/threads') return { ok: true, status: 200, body: JSON.stringify({ id: 'thr_origin' }) }
      if (path === '/v1/threads/thr_origin/turns') return { ...response, body: JSON.stringify(response.body) }
      if (path === '/v1/tasks/task_blocked') return { ok: true, status: 200, body: JSON.stringify({ id: 'task_blocked', originThreadId: 'thr_origin', status: 'waiting_user' }) }
      throw new Error(`unexpected path ${path}`)
    })
    const { runtime, store } = createRuntime(settingsWith([task]), runtimeRequest)
    const monitor = vi.spyOn(runtime as unknown as { monitorTaskTurn: (...args: string[]) => Promise<void> }, 'monitorTaskTurn')

    await expect(runtime.runTask(task.id)).resolves.toMatchObject({
      ok: false,
      status: 'waiting_user',
      threadId: 'thr_origin',
      taskId: 'task_blocked',
      message: response.body.message
    })
    expect(store.read().schedule.tasks[0]).toMatchObject({
      enabled: true,
      lastStatus: 'waiting_user',
      nextRunAt: '',
      lastThreadId: 'thr_origin',
      runtimeTaskId: 'task_blocked',
      lastMessage: response.body.message
    })
    expect(monitor).not.toHaveBeenCalled()
    expect((await runtime.status()).runningTaskIds).toEqual([])
    const request = runtimeRequest.mock.calls.find(([, path]) => path === '/v1/threads/thr_origin/turns')?.[2]
    expect(JSON.parse(String(request?.body))).toMatchObject({ displayText: '帮我处理飞书待办' })

    await (runtime as unknown as { tick: () => Promise<void> }).tick()
    expect(runtimeRequest).toHaveBeenCalledTimes(3)
    expect(runtimeRequest.mock.calls.filter(([, path]) => path === '/v1/threads/thr_origin/turns')).toHaveLength(1)
  })

  it('reconciles a resumed task only after verified completion and restores the next occurrence', async () => {
    const task = makeTask({
      lastStatus: 'waiting_user', lastThreadId: 'thr_origin', runtimeTaskId: 'runtime_task',
      schedule: { kind: 'interval', everyMinutes: 15, timeOfDay: '09:00', atTime: '' }
    })
    const runtimeRequest = vi.fn(async (_settings, path) => {
      if (path !== '/v1/tasks/runtime_task') throw new Error(`unexpected path ${path}`)
      return { ok: true, status: 200, body: JSON.stringify({
        id: 'runtime_task', originThreadId: 'thr_origin', status: 'completed',
        finalResponse: '待办已完成并验证。', finishedAt: '2026-11-10T00:00:00.000Z',
        nodes: [{ kind: 'execute', status: 'completed' }, { kind: 'verify', status: 'completed' }],
        acceptance: { kind: 'effect', requiredNodeKinds: ['execute', 'verify'], effect: { provider: 'lark', operation: 'complete', target: 'todo_1' } },
        resultEvidence: [{ kind: 'external_operation', provider: 'lark', operation: 'complete', target: 'todo_1', verified: true, status: 'done', resultHash: 'sha256', verifiedAt: '2026-11-10T00:00:00.000Z' }]
      }) }
    })
    const { runtime, store } = createRuntime(settingsWith([task]), runtimeRequest)
    await (runtime as unknown as { tick: () => Promise<void> }).tick()
    expect(store.read().schedule.tasks[0]).toMatchObject({
      lastStatus: 'success', lastMessage: '待办已完成并验证。', lastThreadId: 'thr_origin', runtimeTaskId: 'runtime_task'
    })
    expect(Date.parse(store.read().schedule.tasks[0].nextRunAt)).toBeGreaterThan(Date.now())
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
  })

  it.each([
    { requiredEffects: undefined, completedTargets: ['todo_1'], expected: 'waiting_user' },
    { requiredEffects: [], completedTargets: ['todo_1', 'todo_2'], expected: 'waiting_user' },
    { requiredEffects: ['todo_1', 'todo_2'], completedTargets: ['todo_1'], expected: 'waiting_user' },
    { requiredEffects: ['todo_1', 'todo_2'], completedTargets: ['todo_1', 'todo_2'], expected: 'success' }
  ])('requires every persisted target before reconciling a broad process goal ($expected)', async ({ requiredEffects, completedTargets, expected }) => {
    const task = makeTask({ lastStatus: 'waiting_user', lastThreadId: 'thr_origin', runtimeTaskId: 'runtime_task' })
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: JSON.stringify({
      id: 'runtime_task', originThreadId: 'thr_origin', status: 'completed', finalResponse: '已处理待办。', finishedAt: '2026-11-10T00:00:00.000Z',
      nodes: [{ kind: 'execute', status: 'completed' }],
      acceptance: { kind: 'effect', requiredNodeKinds: ['execute'], effect: {
        provider: 'lark', operation: 'process',
        requiredEffects: requiredEffects?.map(target => ({ provider: 'lark', operation: 'complete', target }))
      } },
      resultEvidence: completedTargets.map(target => ({
        kind: 'external_operation', provider: 'lark', operation: 'complete', target, verified: true,
        status: 'done', resultHash: `sha256_${target}`, verifiedAt: '2026-11-10T00:00:00.000Z'
      }))
    }) }))
    const { runtime, store } = createRuntime(settingsWith([task]), runtimeRequest)
    await (runtime as unknown as { tick: () => Promise<void> }).tick()
    expect(store.read().schedule.tasks[0].lastStatus).toBe(expected)
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
  })

  it.each([
    { status: 'completed', resultEvidence: [] },
    { status: 'running' },
    { status: 'stalled' },
    { status: 'failed', originThreadId: 'different_conversation' }
  ])('keeps waiting for an unverified or nonterminal runtime snapshot ($status)', async (patch) => {
    const task = makeTask({ lastStatus: 'waiting_user', lastThreadId: 'thr_origin', runtimeTaskId: 'runtime_task' })
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: JSON.stringify({
      id: 'runtime_task', originThreadId: 'thr_origin', finalResponse: '模型声称已完成', finishedAt: '2026-11-10T00:00:00.000Z',
      nodes: [{ kind: 'execute', status: 'completed' }],
      acceptance: { kind: 'effect', requiredNodeKinds: ['execute'], effect: { provider: 'lark', operation: 'complete', target: 'todo_1' } }, ...patch
    }) }))
    const { runtime, store } = createRuntime(settingsWith([task]), runtimeRequest)
    await (runtime as unknown as { tick: () => Promise<void> }).tick()
    expect(store.read().schedule.tasks[0].lastStatus).toBe('waiting_user')
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
  })

  it.each(['failed', 'cancelled'])('reconciles terminal runtime %s without retrying the occurrence', async (status) => {
    const task = makeTask({
      lastStatus: 'waiting_user', lastThreadId: 'thr_origin', runtimeTaskId: 'runtime_task',
      schedule: { kind: 'at', everyMinutes: 60, timeOfDay: '09:00', atTime: '2099-06-03T09:00:00.000Z' }
    })
    const runtimeRequest = vi.fn(async () => ({ ok: true, status: 200, body: JSON.stringify({
      id: 'runtime_task', originThreadId: 'thr_origin', status, stalledReason: '用户取消或远端失败。'
    }) }))
    const { runtime, store } = createRuntime(settingsWith([task]), runtimeRequest)
    await (runtime as unknown as { tick: () => Promise<void> }).tick()
    expect(store.read().schedule.tasks[0]).toMatchObject({ lastStatus: 'error', enabled: false, nextRunAt: '' })
    expect(runtimeRequest).toHaveBeenCalledTimes(1)
  })

  it('bounds waiting-task reconciliation and retains waiting state when Runtime cannot be read', async () => {
    const tasks = Array.from({ length: 10 }, (_, index) => makeTask({
      id: `scheduled_${index}`, lastStatus: 'waiting_user', lastThreadId: `origin_${index}`, runtimeTaskId: `runtime_${index}`
    }))
    const runtimeRequest = vi.fn(async (_settings: unknown, _path: string) => ({ ok: false, status: 503, body: '{}' }))
    const { runtime, store } = createRuntime(settingsWith(tasks), runtimeRequest)
    const tick = () => (runtime as unknown as { tick: () => Promise<void> }).tick()
    await tick()
    expect(runtimeRequest).toHaveBeenCalledTimes(8)
    await tick()
    expect(runtimeRequest).toHaveBeenCalledTimes(16)
    expect(runtimeRequest.mock.calls.map(call => call[1])).toEqual(expect.arrayContaining(['/v1/tasks/runtime_8', '/v1/tasks/runtime_9']))
    expect(store.read().schedule.tasks.every(task => task.lastStatus === 'waiting_user')).toBe(true)
  })

  it('reads assistant text from the real WorkWise Runtime thread detail shape', async () => {
    const task = makeTask()
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads') {
        return { ok: true, status: 200, body: JSON.stringify({ id: 'thr_1' }) }
      }
      if (path === '/v1/threads/thr_1' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_1/turns') {
        return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_1' }) }
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
                items: [{ kind: 'assistant_text', text: 'scheduled task completed' }]
              }
            ]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const { runtime } = createRuntime(settingsWith([task]), runtimeRequest)

    const result = await (runtime as unknown as {
      runPrompt: (
        settingsArg: AppSettingsV1,
        options: {
          prompt: string
          title: string
          workspaceRoot: string
          model: string
          reasoningEffort: ScheduledTaskV1['reasoningEffort']
          mode: ScheduledTaskV1['mode']
          waitForResult: boolean
          responseTimeoutMs: number
        }
      ) => Promise<{ ok: boolean; text?: string }>
    }).runPrompt(settingsWith([task]), {
      prompt: 'hello',
      title: 'demo',
      workspaceRoot: '/tmp/workspace',
      model: 'auto',
      reasoningEffort: 'medium',
      mode: 'agent',
      waitForResult: true,
      responseTimeoutMs: 2_000
    })

    expect(result).toMatchObject({ ok: true, text: 'scheduled task completed' })
  })

  it('waits for the current scheduled turn to complete before returning final text', async () => {
    const task = makeTask()
    let getCount = 0
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads') {
        return { ok: true, status: 200, body: JSON.stringify({ id: 'thr_1' }) }
      }
      if (path === '/v1/threads/thr_1' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_1/turns') {
        return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_current' }) }
      }
      if (path === '/v1/threads/thr_1' && init?.method === 'GET') {
        getCount += 1
        return {
          ok: true,
          status: 200,
          body: JSON.stringify(getCount === 1
            ? {
                id: 'thr_1',
                status: 'running',
                turns: [
                  {
                    id: 'turn_previous',
                    status: 'completed',
                    items: [{ kind: 'assistant_text', text: 'previous scheduled reply' }]
                  },
                  {
                    id: 'turn_current',
                    status: 'running',
                    items: [{ kind: 'assistant_text', text: 'intermediate scheduled reply' }]
                  }
                ]
              }
            : {
                id: 'thr_1',
                status: 'idle',
                turns: [
                  {
                    id: 'turn_previous',
                    status: 'completed',
                    items: [{ kind: 'assistant_text', text: 'previous scheduled reply' }]
                  },
                  {
                    id: 'turn_current',
                    status: 'completed',
                    items: [
                      { kind: 'assistant_text', text: 'intermediate scheduled reply' },
                      { kind: 'assistant_text', text: 'final scheduled reply' }
                    ]
                  }
                ]
              })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const { runtime } = createRuntime(settingsWith([task]), runtimeRequest)

    const result = await (runtime as unknown as {
      runPrompt: (
        settingsArg: AppSettingsV1,
        options: {
          prompt: string
          title: string
          workspaceRoot: string
          model: string
          reasoningEffort: ScheduledTaskV1['reasoningEffort']
          mode: ScheduledTaskV1['mode']
          waitForResult: boolean
          responseTimeoutMs: number
        }
      ) => Promise<{ ok: boolean; text?: string }>
    }).runPrompt(settingsWith([task]), {
      prompt: 'hello',
      title: 'demo',
      workspaceRoot: '/tmp/workspace',
      model: 'auto',
      reasoningEffort: 'medium',
      mode: 'agent',
      waitForResult: true,
      responseTimeoutMs: 2_500
    })

    expect(result).toMatchObject({ ok: true, text: 'final scheduled reply' })
    expect(getCount).toBe(2)
  })

  it('does not return historical scheduled text when the current turn fails', async () => {
    const task = makeTask()
    const runtimeRequest = vi.fn(async (_settings, path, init) => {
      if (path === '/v1/threads') {
        return { ok: true, status: 200, body: JSON.stringify({ id: 'thr_1' }) }
      }
      if (path === '/v1/threads/thr_1' && init?.method === 'PATCH') {
        return { ok: true, status: 200, body: '{}' }
      }
      if (path === '/v1/threads/thr_1/turns') {
        return { ok: true, status: 202, body: JSON.stringify({ turnId: 'turn_current' }) }
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
                id: 'turn_previous',
                status: 'completed',
                items: [{ kind: 'assistant_text', text: 'previous scheduled reply' }]
              },
              {
                id: 'turn_current',
                status: 'failed',
                items: []
              }
            ]
          })
        }
      }
      throw new Error(`unexpected path ${path}`)
    })
    const { runtime } = createRuntime(settingsWith([task]), runtimeRequest)

    await expect((runtime as unknown as {
      runPrompt: (
        settingsArg: AppSettingsV1,
        options: {
          prompt: string
          title: string
          workspaceRoot: string
          model: string
          reasoningEffort: ScheduledTaskV1['reasoningEffort']
          mode: ScheduledTaskV1['mode']
          waitForResult: boolean
          responseTimeoutMs: number
        }
      ) => Promise<{ ok: boolean; text?: string }>
    }).runPrompt(settingsWith([task]), {
      prompt: 'hello',
      title: 'demo',
      workspaceRoot: '/tmp/workspace',
      model: 'auto',
      reasoningEffort: 'medium',
      mode: 'agent',
      waitForResult: true,
      responseTimeoutMs: 2_000
    })).rejects.toThrow('Agent turn failed.')
  })

  it('disables one-time tasks after monitored completion', async () => {
    const task = makeTask({
      lastStatus: 'running',
      schedule: {
        kind: 'at',
        everyMinutes: 60,
        timeOfDay: '09:00',
        atTime: '2099-06-03T09:00:00.000Z'
      }
    })
    const { runtime, store } = createRuntime(settingsWith([task]))
    ;(runtime as unknown as {
      waitForAssistantText: () => Promise<string>
    }).waitForAssistantText = vi.fn(async () => 'done')

    await (runtime as unknown as {
      monitorTaskTurn: (taskId: string, threadId: string, turnId: string) => Promise<void>
    }).monitorTaskTurn(task.id, 'thr_1', 'turn_1')

    expect(store.read().schedule.tasks[0]).toMatchObject({
      enabled: false,
      nextRunAt: '',
      lastStatus: 'success',
      lastMessage: 'done',
      lastThreadId: 'thr_1'
    })
  })

  it('does not auto-run manual tasks during tick', async () => {
    const task = makeTask({
      schedule: { kind: 'manual', everyMinutes: 60, timeOfDay: '09:00', atTime: '' },
      nextRunAt: '2026-06-02T00:00:00.000Z'
    })
    const runtimeRequest = vi.fn()
    const { runtime } = createRuntime(settingsWith([task]), runtimeRequest)

    await (runtime as unknown as { tick: () => Promise<void> }).tick()

    expect(runtimeRequest).not.toHaveBeenCalled()
  })

  it('marks interrupted running tasks as errors during next-run recovery', async () => {
    const task = makeTask({
      lastStatus: 'running',
      schedule: { kind: 'interval', everyMinutes: 10, timeOfDay: '09:00', atTime: '' }
    })
    const initial = settingsWith([task])
    const { runtime, store } = createRuntime(initial)

    await (runtime as unknown as {
      ensureNextRuns: (settings: AppSettingsV1) => Promise<void>
    }).ensureNextRuns(initial)

    expect(store.read().schedule.tasks[0].lastStatus).toBe('error')
    expect(store.read().schedule.tasks[0].lastMessage).toBe('Task was interrupted before completion.')
    expect(Date.parse(store.read().schedule.tasks[0].nextRunAt)).toBeGreaterThan(0)
  })

  it('uses the power save blocker only for enabled automatic schedules', () => {
    const started = new Set<number>()
    const powerSaveBlocker = {
      start: vi.fn(() => {
        started.add(1)
        return 1
      }),
      stop: vi.fn((id: number) => {
        started.delete(id)
      }),
      isStarted: vi.fn((id: number) => started.has(id))
    }
    const runtime = new ScheduleRuntime({
      store: createStore(settingsWith()) as never,
      runtimeRequest: vi.fn() as never,
      logError: vi.fn(),
      powerSaveBlocker
    })
    const scheduled = settingsWith([
      makeTask({ schedule: { kind: 'daily', everyMinutes: 60, timeOfDay: '09:00', atTime: '' } })
    ], { keepAwake: true })

    ;(runtime as unknown as { syncPowerSaveBlocker: (settings: AppSettingsV1) => void })
      .syncPowerSaveBlocker(scheduled)
    expect(powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension')

    ;(runtime as unknown as { syncPowerSaveBlocker: (settings: AppSettingsV1) => void })
      .syncPowerSaveBlocker({ ...scheduled, schedule: { ...scheduled.schedule, keepAwake: false } })
    expect(powerSaveBlocker.stop).toHaveBeenCalledWith(1)
  })

  it('migrates legacy Flow schedule models before listing or running them', async () => {
    const task = makeTask({ model: 'deepseek-v4-pro' }); let tasks = [task]
    const calls: string[] = []
    const runtimeRequest = vi.fn(async (_settings: AppSettingsV1, path: string, init: { method?: string; body?: string }) => {
      calls.push(`${init.method} ${path}`)
      if (path === '/v1/legacy-schedules' && init.method === 'GET') return { ok: true, status: 200, body: JSON.stringify({ tasks }) }
      if (path === '/v1/legacy-schedules' && init.method === 'POST') { const created = JSON.parse(init.body!) as ScheduledTaskV1; tasks.push(created); return { ok: true, status: 201, body: JSON.stringify({ task: created }) } }
      if (path.endsWith('/run')) return { ok: true, status: 202, body: JSON.stringify({ run: { id: 'flow-run-1' } }) }
      if (init.method === 'PUT') { const updated = JSON.parse(init.body!) as ScheduledTaskV1; tasks = tasks.map((item) => item.id === updated.id ? updated : item); return { ok: true, status: 200, body: JSON.stringify({ task: updated }) } }
      if (init.method === 'DELETE') { tasks = tasks.filter((item) => !path.includes(item.id)); return { ok: true, status: 200, body: JSON.stringify({ archived: true }) } }
      return { ok: false, status: 404, body: 'not found' }
    })
    const { runtime, store } = createRuntime(settingsWith([task], { enabled: false }), runtimeRequest)
    expect(await runtime.listTasks()).toMatchObject([{ id: task.id, model: 'deepseek-flash' }])
    expect(await runtime.runTask(task.id)).toMatchObject({ ok: true, threadId: 'flow-run-1' })
    expect(calls.indexOf('PUT /v1/legacy-schedules/task-1'))
      .toBeLessThan(calls.indexOf('POST /v1/legacy-schedules/task-1/run'))
    const updated = await runtime.updateTaskById(task.id, { title: 'Updated', model: 'deepseek-v4-pro' })
    expect(updated).toMatchObject({ title: 'Updated', model: 'deepseek-flash' })
    const updateBody = runtimeRequest.mock.calls.find((call) => call[2].method === 'PUT')?.[2].body
    expect(JSON.parse(String(updateBody)).model).toBe('deepseek-flash')
    const created = makeTask({ id: 'task-2', model: 'deepseek-v4-pro' })
    expect((await runtime.createTask(created)).model).toBe('deepseek-flash')
    expect(await runtime.deleteTaskById(task.id)).toBe(true); expect(store.patch).not.toHaveBeenCalled()
    expect(runtimeRequest.mock.calls.map((call) => [call[1], call[2].method])).toEqual(expect.arrayContaining([
      ['/v1/legacy-schedules', 'GET'], ['/v1/legacy-schedules', 'POST'], ['/v1/legacy-schedules/task-1/run', 'POST'], ['/v1/legacy-schedules/task-1', 'PUT'], ['/v1/legacy-schedules/task-1', 'DELETE']
    ]))
  })

  it('preserves legacy Flow model ids for a custom provider', async () => {
    const task = makeTask({ model: 'deepseek-v4-pro' }); let tasks = [task]
    const runtimeRequest = vi.fn(async (_settings: AppSettingsV1, path: string, init: { method?: string }) => {
      if (path === '/v1/legacy-schedules' && init.method === 'GET') return { ok: true, status: 200, body: JSON.stringify({ tasks }) }
      if (path.endsWith('/run')) return { ok: true, status: 202, body: JSON.stringify({ run: { id: 'flow-run-custom' } }) }
      return { ok: false, status: 404, body: 'not found' }
    })
    const { runtime } = createRuntime(settingsWith([task], { enabled: false }, 'custom-provider'), runtimeRequest)

    expect(await runtime.listTasks()).toEqual([task])
    expect(await runtime.runTask(task.id)).toMatchObject({ ok: true, threadId: 'flow-run-custom' })
    expect(runtimeRequest.mock.calls.some(([, , init]) => init.method === 'PUT')).toBe(false)
  })

  it('starts legacy Flow model migration during runtime sync', async () => {
    const task = makeTask({ model: 'deepseek-v4-flash' }); let savedTask = task
    const runtimeRequest = vi.fn(async (_settings: AppSettingsV1, path: string, init: { method?: string; body?: string }) => {
      if (path === '/v1/legacy-schedules' && init.method === 'GET') return { ok: true, status: 200, body: JSON.stringify({ tasks: [savedTask] }) }
      if (init.method === 'PUT') {
        savedTask = JSON.parse(init.body!) as ScheduledTaskV1
        return { ok: true, status: 200, body: JSON.stringify({ task: savedTask }) }
      }
      return { ok: false, status: 404, body: 'not found' }
    })
    const { runtime } = createRuntime(settingsWith([task], { enabled: false }), runtimeRequest)

    runtime.sync(settingsWith([task], { enabled: false }))
    await expect(runtime.listTasks()).resolves.toMatchObject([{ model: 'deepseek-flash' }])
    expect(runtimeRequest.mock.calls.map(([, path, init]) => [path, init.method])).toEqual([
      ['/v1/legacy-schedules', 'GET'],
      ['/v1/legacy-schedules/task-1', 'PUT']
    ])
  })

  it('restores a legacy Flow model when the provider changes during migration', async () => {
    const task = makeTask({ model: 'deepseek-v4-pro' }); let savedTask = task
    let finishFirstUpdate!: () => void
    let firstUpdateStarted!: () => void
    const firstUpdateStartedPromise = new Promise<void>((resolve) => { firstUpdateStarted = resolve })
    const firstUpdateGate = new Promise<void>((resolve) => { finishFirstUpdate = resolve })
    let updateCount = 0
    const runtimeRequest = vi.fn(async (_settings: AppSettingsV1, path: string, init: { method?: string; body?: string }) => {
      if (path === '/v1/legacy-schedules' && init.method === 'GET') return { ok: true, status: 200, body: JSON.stringify({ tasks: [savedTask] }) }
      if (init.method === 'PUT') {
        updateCount += 1
        const update = JSON.parse(init.body!) as ScheduledTaskV1
        if (updateCount === 1) {
          firstUpdateStarted()
          await firstUpdateGate
        }
        savedTask = update
        return { ok: true, status: 200, body: JSON.stringify({ task: savedTask }) }
      }
      return { ok: false, status: 404, body: 'not found' }
    })
    const { runtime, store } = createRuntime(settingsWith([task], { enabled: false }), runtimeRequest)
    const listing = runtime.listTasks()
    await firstUpdateStartedPromise
    store.replace(settingsWith([task], { enabled: false }, 'custom-provider'))
    finishFirstUpdate()

    await expect(listing).resolves.toMatchObject([{ model: 'deepseek-v4-pro' }])
    expect(updateCount).toBe(2)
    expect(savedTask.model).toBe('deepseek-v4-pro')
  })
})
