import { describe, expect, it } from 'vitest'
import {
  AgentLoop,
  allowedToolNamesWithGuiStateTools,
  resolvePlanModeToolSpecs,
  turnRequestForRouting,
  webSearchCapabilityInstruction
} from './agent-loop.js'
import type { ModelClient, ModelToolSpec } from '../ports/model-client.js'
import type { ToolHost } from '../ports/tool-host.js'
import { InMemoryThreadStore } from '../adapters/in-memory-thread-store.js'
import { InMemorySessionStore } from '../adapters/in-memory-session-store.js'
import { InMemoryEventBus } from '../adapters/in-memory-event-bus.js'
import { InMemoryApprovalGate } from '../adapters/in-memory-approval-gate.js'
import { InMemoryUserInputGate } from '../adapters/in-memory-user-input-gate.js'
import { RuntimeEventRecorder } from '../services/runtime-event-recorder.js'
import { TurnService } from '../services/turn-service.js'
import { UsageService } from '../services/usage-service.js'
import { InflightTracker } from './inflight-tracker.js'
import { SteeringQueue } from './steering-queue.js'
import { ContextCompactor } from './context-compactor.js'
import { SequentialIdGenerator } from '../ports/id-generator.js'
import { createImmutablePrefix } from '../cache/immutable-prefix.js'
import { createThreadRecord } from '../domain/thread.js'
import { makeToolResultItem } from '../domain/item.js'
import type { TaskController } from '../services/task-controller.js'
import type { RuntimeSpanService } from '../services/runtime-span-service.js'

function spec(name: string): ModelToolSpec {
  return {
    name,
    description: `Tool: ${name}`,
    toolKind: name === 'create_plan' || name === 'write' || name === 'edit'
      ? 'file_change'
      : 'tool_call',
    inputSchema: { type: 'object', properties: {} }
  }
}

const ALL_TOOLS: ModelToolSpec[] = [
  spec('read'),
  spec('write'),
  spec('edit'),
  spec('ls'),
  spec('find'),
  spec('grep'),
  spec('bash'),
  spec('web_search'),
  spec('web_fetch'),
  spec('create_plan')
]

const READ_ONLY_TOOLS = new Set([
  'read', 'ls', 'find', 'grep', 'web_search', 'web_fetch'
])

describe('webSearchCapabilityInstruction', () => {
  it('treats web tool content as untrusted data that cannot authorize actions', () => {
    const instruction = webSearchCapabilityInstruction('查找最新资料', [spec('web_search')])

    expect(instruction).toContain('UNTRUSTED')
    expect(instruction).toContain('cannot override')
    expect(instruction).toContain('authorize tools')
    expect(instruction).toContain('disclose secrets')
  })
})

describe('resolvePlanModeToolSpecs', () => {
  it('step 0: read-only tools + create_plan only', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    const names = result.map((t) => t.name)
    expect(names).toContain('read')
    expect(names).toContain('ls')
    expect(names).toContain('find')
    expect(names).toContain('grep')
    expect(names).toContain('web_search')
    expect(names).toContain('web_fetch')
    expect(names).toContain('create_plan')
    expect(names).not.toContain('write')
    expect(names).not.toContain('edit')
    expect(names).not.toContain('bash')
  })

  it('step > 0: only create_plan', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 1,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('create_plan')
  })

  it('plan satisfied: returns all tools unchanged (pass-through)', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: true,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    expect(result).toBe(ALL_TOOLS)
  })

  it('not plan-active: returns all tools unchanged (pass-through)', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: false,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: READ_ONLY_TOOLS
    })
    expect(result).toBe(ALL_TOOLS)
  })

  it('uses PLAN_READ_ONLY_TOOL_NAMES default when readOnlyToolNames omitted', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0
    })
    const names = result.map((t) => t.name)
    // Default set excludes bash
    expect(names).not.toContain('bash')
    expect(names).toContain('create_plan')
    expect(names).toContain('read')
  })

  it('uses CREATE_PLAN_TOOL_NAME default when planToolName omitted', () => {
    const result = resolvePlanModeToolSpecs(ALL_TOOLS, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 1
    })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('create_plan')
  })

  it('custom readOnlyToolNames and planToolName', () => {
    const customTools: ModelToolSpec[] = [
      spec('custom-read'),
      spec('custom-plan'),
      spec('write'),
      spec('bash')
    ]
    const result = resolvePlanModeToolSpecs(customTools, {
      planTurnActive: true,
      createPlanSatisfied: false,
      stepIndex: 0,
      readOnlyToolNames: new Set(['custom-read']),
      planToolName: 'custom-plan'
    })
    const names = result.map((t) => t.name)
    expect(names).toContain('custom-read')
    expect(names).toContain('custom-plan')
    expect(names).not.toContain('write')
    expect(names).not.toContain('bash')
  })
})

describe('allowedToolNamesWithGuiStateTools', () => {
  it('adds the Design canvas bridge only for an explicit Design turn', () => {
    expect(allowedToolNamesWithGuiStateTools(['read'], false, true)).toContain(
      'design_apply_canvas_commands'
    )
    expect(allowedToolNamesWithGuiStateTools(['read'], false, false)).not.toContain(
      'design_apply_canvas_commands'
    )
  })

  it('preserves an unrestricted tool catalog', () => {
    expect(allowedToolNamesWithGuiStateTools(undefined, false, true)).toBeUndefined()
  })
})

describe('turnRequestForRouting', () => {
  it('preserves structured UI action context when the turn prompt is empty', () => {
    const request = turnRequestForRouting(
      { prompt: '' },
      [{
        id: 'item_action',
        turnId: 'turn_action',
        threadId: 'thread_action',
        role: 'user',
        status: 'completed',
        createdAt: '2026-07-18T00:00:00.000Z',
        finishedAt: '2026-07-18T00:00:00.000Z',
        kind: 'ui_action',
        messageId: 'message_card',
        blockId: 'filters',
        actionId: 'choose-kind',
        specFingerprint: 'fingerprint',
        nodeId: 'kind',
        nodeType: 'select',
        fieldName: 'kind',
        value: 'two'
      }],
      'turn_action'
    )

    expect(request).toContain('choose-kind')
    expect(request).toContain('select')
    expect(request).toContain('two')
  })
})

describe('AgentLoop completion guard', () => {
  it('persists bounded tool-call character deltas without argument contents', async () => {
    const threadId = 'thread_tool_delta_usage'
    const nowIso = () => '2026-08-20T00:00:00.000Z'
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const ids = new SequentialIdGenerator()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const compactor = new ContextCompactor()
    const approvalGate = new InMemoryApprovalGate()
    const userInputGate = new InMemoryUserInputGate()
    const events = new RuntimeEventRecorder({
      eventBus, sessionStore, allocateSeq: (id) => eventBus.allocateSeq(id), nowIso
    })
    const turns = new TurnService({
      threadStore, sessionStore, events, inflight, steering, compactor, ids, nowIso
    })
    const model: ModelClient = {
      provider: 'test',
      model: 'fixture-model',
      async *stream() {
        yield { kind: 'tool_call_delta', callId: 'call_1', toolName: 'read_file', argumentsDelta: '{"token":"secret😀"}' }
        yield { kind: 'tool_call_delta', callId: 'call_1', argumentsDelta: 'x'.repeat(1_000_001) }
        yield { kind: 'assistant_text_delta', text: 'done' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const toolHost: ToolHost = {
      id: 'tool-delta-host',
      async listTools() { return [] },
      async execute() { throw new Error('no tool should be called') }
    }
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'tool delta usage',
      workspace: '',
      model: model.model,
      createdAt: nowIso()
    }))
    const started = await turns.startTurn({ threadId, request: { prompt: 'estimate' } })
    const loop = new AgentLoop({
      threadStore, sessionStore, approvalGate, userInputGate, model, toolHost,
      usage: new UsageService(), events, turns, inflight, steering, compactor,
      prefix: createImmutablePrefix(), ids, nowIso
    })

    await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('completed')
    const persistedEvents = await sessionStore.loadEventsSince(threadId, 0)
    const toolDelta = persistedEvents.find((event) => event.kind === 'tool_call_delta')
    expect(toolDelta).toMatchObject({
      kind: 'tool_call_delta',
      callId: 'call_1',
      toolName: 'read_file',
      characterCount: 19
    })
    expect(JSON.stringify(toolDelta)).not.toContain('secret')
    expect(JSON.stringify(toolDelta)).not.toContain('argumentsDelta')
    expect(persistedEvents.filter((event) => event.kind === 'tool_call_delta'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ characterCount: 1_000_000 })
      ]))
  })

  it('records redacted model and MCP spans around the actual stream and tool execution', async () => {
    const threadId = 'thread_runtime_spans'
    const nowIso = () => '2026-07-18T00:00:00.000Z'
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const ids = new SequentialIdGenerator()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const compactor = new ContextCompactor()
    const approvalGate = new InMemoryApprovalGate()
    const userInputGate = new InMemoryUserInputGate()
    const events = new RuntimeEventRecorder({
      eventBus, sessionStore, allocateSeq: (id) => eventBus.allocateSeq(id), nowIso
    })
    const activeTask = { id: 'task_runtime_spans', attempts: 1 }
    const starts: Array<Record<string, unknown>> = []
    const finishes: Array<{ id: string; input: Record<string, unknown> }> = []
    const spanService = {
      start(input: Record<string, unknown>) { starts.push(input); return input },
      finish(id: string, input: Record<string, unknown>) { finishes.push({ id, input }); return null }
    } as unknown as RuntimeSpanService
    const tasks = {
      activeTask: () => activeTask,
      registerExecutionAbort: () => () => undefined,
      beginAttempt: () => activeTask,
      pendingDeliveries: () => [],
      tokenForTurn: () => undefined,
      beginWork: () => () => undefined,
      workBudget: () => undefined,
      recordCost: () => undefined,
      beginToolOperation: () => undefined,
      endRun: () => undefined,
      assessCandidate: async () => ({ kind: 'completed', task: activeTask })
    } as unknown as TaskController
    const turns = new TurnService({
      threadStore, sessionStore, events, inflight, steering, compactor, ids, nowIso
    })
    let modelStep = 0
    const model: ModelClient = {
      provider: 'test',
      model: 'fixture-model',
      async *stream() {
        modelStep += 1
        if (modelStep === 1) {
          yield { kind: 'tool_call_complete', callId: 'call_1', toolName: 'knowledge_search', arguments: { token: 'secret' } }
          yield {
            kind: 'usage',
            usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15, cachedTokens: 4, cacheHitRate: 1 / 3, turns: 1 }
          }
          yield { kind: 'completed', stopReason: 'tool_calls' }
          return
        }
        yield { kind: 'assistant_text_delta', text: '检索完成并给出最终答复。' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    let dispatchedArguments: Record<string, unknown> | undefined
    const toolHost: ToolHost = {
      id: 'span-host',
      async listTools() {
        return [{ ...spec('knowledge_search'), providerId: 'mcp:knowledge', providerKind: 'mcp' }]
      },
      async execute(call) {
        dispatchedArguments = call.arguments
        return {
          item: makeToolResultItem({
            id: `item_${call.callId}`,
            threadId,
            turnId: 'turn_runtime_spans',
            callId: call.callId,
            toolName: call.toolName,
            output: { matches: 2 }
          }),
          approved: true
        }
      }
    }
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'runtime spans',
      workspace: '',
      model: model.model,
      createdAt: nowIso()
    }))
    const started = await turns.startTurn({ threadId, request: { prompt: '检索并回答。' } })
    const loop = new AgentLoop({
      threadStore, sessionStore, approvalGate, userInputGate, model, toolHost,
      usage: new UsageService(), events, turns, inflight, steering, compactor,
      prefix: createImmutablePrefix(), ids, nowIso, tasks, spanService
    })

    await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('completed')
    expect(starts.map((span) => span.kind)).toEqual(['model', 'mcp', 'model'])
    expect(JSON.stringify(starts)).not.toContain('secret')
    expect(finishes.find((entry) => entry.id.includes('span_model'))?.input).toMatchObject({
      status: 'ok', inputTokens: 12, outputTokens: 3, cacheHit: true
    })
    expect(finishes.find((entry) => entry.id.includes('span_tool'))?.input).toMatchObject({
      status: 'ok', attributes: { approved: true, isError: false }
    })
    expect(dispatchedArguments).toEqual({ token: 'secret' })
    const persistedItems = await sessionStore.loadItems(threadId)
    const persistedEvents = await sessionStore.loadEventsSince(threadId, 0)
    expect(JSON.stringify(persistedItems)).not.toContain('secret')
    expect(JSON.stringify(persistedEvents)).not.toContain('secret')
  })

  it('applies the selected Agent model, prompt, tool/MCP allowlists, and trust cap', async () => {
    const threadId = 'thread_agent_policy'
    const nowIso = () => '2026-07-18T00:00:00.000Z'
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const ids = new SequentialIdGenerator()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const compactor = new ContextCompactor()
    const approvalGate = new InMemoryApprovalGate()
    const userInputGate = new InMemoryUserInputGate()
    const events = new RuntimeEventRecorder({
      eventBus, sessionStore, allocateSeq: (id) => eventBus.allocateSeq(id), nowIso
    })
    const turns = new TurnService({
      threadStore, sessionStore, events, inflight, steering, compactor, ids, nowIso
    })
    let requestModel = ''
    let requestInstructions: readonly string[] = []
    let requestTools: string[] = []
    const model: ModelClient = {
      provider: 'test',
      model: 'fallback-model',
      async *stream(request) {
        requestModel = request.model
        requestInstructions = request.contextInstructions ?? []
        requestTools = request.tools.map((tool) => tool.name)
        yield { kind: 'assistant_text_delta', text: '审查完成：未发现阻断项。' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    let capturedContext: Parameters<ToolHost['listTools']>[0]
    const toolHost: ToolHost = {
      id: 'agent-policy-host',
      async listTools(context) {
        capturedContext = context
        return [spec('read'), spec('write')]
          .filter((tool) => !context?.allowedToolNames || context.allowedToolNames.includes(tool.name))
      },
      async execute() { throw new Error('no tool should be called') }
    }
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Agent policy',
      workspace: '',
      model: 'thread-model',
      sandboxMode: 'danger-full-access',
      agentId: 'review',
      agentRevision: 1,
      agentProfile: {
        id: 'review', name: 'Review', role: '审查', color: '#f59e0b',
        systemPrompt: '只读审查并给出证据。', model: 'review-model',
        toolAllowlist: ['read'], mcpAllowlist: [], trustLevel: 'read-only',
        budget: { maxAttempts: 3, maxDurationMs: 60_000 }, revision: 1
      },
      createdAt: nowIso()
    }))
    const started = await turns.startTurn({ threadId, request: { prompt: '审查实现。' } })
    const loop = new AgentLoop({
      threadStore, sessionStore, approvalGate, userInputGate, model, toolHost,
      usage: new UsageService(), events, turns, inflight, steering, compactor,
      prefix: createImmutablePrefix(), ids, nowIso
    })

    await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('completed')
    expect(requestModel).toBe('review-model')
    expect(requestInstructions.join('\n')).toContain('只读审查并给出证据。')
    expect(requestTools).toEqual(['read'])
    expect(capturedContext?.sandboxMode).toBe('read-only')
    expect(capturedContext?.allowedMcpProviderIds).toEqual([])
  })

  it('completes a marked Write knowledge reply with one model step and one assistant message', async () => {
    const threadId = 'thread_write_kb'
    const nowIso = () => '2026-07-17T00:00:00.000Z'
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const ids = new SequentialIdGenerator()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const compactor = new ContextCompactor()
    const approvalGate = new InMemoryApprovalGate()
    const userInputGate = new InMemoryUserInputGate()
    const events = new RuntimeEventRecorder({
      eventBus,
      sessionStore,
      allocateSeq: (id) => eventBus.allocateSeq(id),
      nowIso
    })
    const turns = new TurnService({
      threadStore,
      sessionStore,
      events,
      inflight,
      steering,
      compactor,
      ids,
      nowIso
    })
    let modelSteps = 0
    const model: ModelClient = {
      provider: 'test',
      model: 'deepseek-v4-flash',
      async *stream() {
        modelSteps += 1
        yield {
          kind: 'assistant_text_delta',
          text: [
            '1. 检查监测点完损状态。',
            '2. 检查自动化采集设备运行状态。',
            '3. 核对异常检测与预警记录。',
            '',
            '任务已完成'
          ].join('\n')
        }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const toolHost: ToolHost = {
      id: 'empty-test-host',
      async listTools() {
        return []
      },
      async execute() {
        throw new Error('no tool should be called')
      }
    }

    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'Write KB completion guard',
      workspace: '',
      model: model.model,
      createdAt: nowIso()
    }))
    const prompt = [
      '[写作上下文]',
      '当前文件: qa-ppt-source.md',
      '',
      '[RailWise 知识库检索结果]',
      '[RailWise 1] AI监测报告生成工具',
      '生成报告的参考资料。',
      '',
      '[用户请求]',
      '基于知识库生成最多 6 项现场巡检清单，并在末尾写“任务已完成”。不要生成文件，不要调用工具，不要继续追问。'
    ].join('\n')
    const started = await turns.startTurn({
      threadId,
      request: { prompt }
    })
    const loop = new AgentLoop({
      threadStore,
      sessionStore,
      approvalGate,
      userInputGate,
      model,
      toolHost,
      usage: new UsageService(),
      events,
      turns,
      inflight,
      steering,
      compactor,
      prefix: createImmutablePrefix(),
      ids,
      nowIso
    })

    await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('completed')

    const items = await sessionStore.loadItems(threadId)
    const persistedEvents = await sessionStore.loadEventsSince(threadId, 0)
    expect(modelSteps).toBe(1)
    expect(items.filter((item) => item.kind === 'assistant_text')).toHaveLength(1)
    expect(items.filter((item) => item.kind === 'error')).toHaveLength(0)
    expect(persistedEvents.filter((event) => event.kind === 'turn_completed')).toHaveLength(1)
    expect(persistedEvents.filter((event) => event.kind === 'turn_failed')).toHaveLength(0)
  })

  it('stops after one blocked file attempt when the task waits for provider configuration', async () => {
    const threadId = 'thread_image_provider_blocked'
    const nowIso = () => '2026-07-26T00:00:00.000Z'
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const ids = new SequentialIdGenerator()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const compactor = new ContextCompactor()
    const approvalGate = new InMemoryApprovalGate()
    const userInputGate = new InMemoryUserInputGate()
    const events = new RuntimeEventRecorder({
      eventBus, sessionStore, allocateSeq: (id) => eventBus.allocateSeq(id), nowIso
    })
    const activeTask = { id: 'task_provider_blocked', attempts: 1 }
    const tasks = {
      activeTask: () => activeTask,
      registerExecutionAbort: () => () => undefined,
      beginAttempt: () => activeTask,
      pendingDeliveries: () => [],
      tokenForTurn: () => undefined,
      beginWork: () => () => undefined,
      workBudget: () => undefined,
      recordCost: () => undefined,
      beginToolOperation: () => undefined,
      endRun: () => undefined,
      assessCandidate: async () => ({
        kind: 'waiting_user',
        task: activeTask,
        reason: '继续前需要配置图片生成提供商。'
      })
    } as unknown as TaskController
    const turns = new TurnService({
      threadStore, sessionStore, events, inflight, steering, compactor, ids, nowIso
    })
    let modelSteps = 0
    const model: ModelClient = {
      provider: 'test',
      model: 'fixture-model',
      async *stream() {
        modelSteps += 1
        yield {
          kind: 'assistant_text_delta',
          text: '图片生成能力未配置，无法继续。请到设置 → 图片生成配置提供商、模型和凭据后重试。'
        }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const toolHost: ToolHost = {
      id: 'provider-blocked-host',
      async listTools() { return [] },
      async execute() { throw new Error('no tool should be called') }
    }
    await threadStore.upsert(createThreadRecord({
      id: threadId,
      title: 'provider blocked',
      workspace: '',
      model: model.model,
      createdAt: nowIso()
    }))
    const started = await turns.startTurn({
      threadId,
      request: { prompt: '请使用 Document Illustrator 生成并插入一张章节头图文件。' }
    })
    const loop = new AgentLoop({
      threadStore, sessionStore, approvalGate, userInputGate, model, toolHost,
      usage: new UsageService(), events, turns, inflight, steering, compactor,
      prefix: createImmutablePrefix(), ids, nowIso, tasks
    })

    await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('completed')
    expect(modelSteps).toBe(1)
    const items = await sessionStore.loadItems(threadId)
    expect(items.filter((item) => item.kind === 'error')).toHaveLength(0)
    const persistedEvents = await sessionStore.loadEventsSince(threadId, 0)
    expect(persistedEvents.filter((event) => event.kind === 'turn_completed')).toHaveLength(1)
    expect(persistedEvents.filter((event) => event.kind === 'turn_failed')).toHaveLength(0)
  })
})
