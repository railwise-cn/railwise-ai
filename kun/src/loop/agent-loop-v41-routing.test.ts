import { describe, expect, it } from 'vitest'
import { AgentLoop } from './agent-loop.js'
import type { ModelClient, ModelRequest } from '../ports/model-client.js'
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

describe('AgentLoop V4.1 model routing', () => {
  it.each([
    { name: 'current Flash recommendation', selected: 'auto', reply: '{"model":"deepseek-flash","thinking":"high"}', expected: 'deepseek-flash', effort: 'high' },
    { name: 'legacy Flash recommendation', selected: 'auto', reply: '{"model":"deepseek-v4-flash","thinking":"high"}', expected: 'deepseek-flash', effort: 'high' },
    { name: 'Pro recommendation', selected: 'auto', reply: '{"model":"deepseek-v4-pro","thinking":"max"}', expected: 'deepseek-v4-pro', effort: 'max' },
    { name: 'invalid recommendation fallback', selected: 'auto', reply: 'not JSON', expected: 'deepseek-flash' },
    { name: 'classifier failure fallback', selected: 'auto', reply: null, expected: 'deepseek-flash' },
    { name: 'explicit saved legacy Flash', selected: 'deepseek-v4-flash', reply: null, expected: 'deepseek-v4-flash' },
    { name: 'explicit saved V4.1 Flash', selected: 'deepseek-flash', reply: null, expected: 'deepseek-flash' },
    { name: 'explicit saved Pro', selected: 'deepseek-v4-pro', reply: null, expected: 'deepseek-v4-pro' }
  ])('$name', async ({ selected, reply, expected, effort }) => {
    const threadId = 'thread_v41_routing'
    const nowIso = () => '2026-09-20T00:00:00.000Z'
    const threadStore = new InMemoryThreadStore()
    const sessionStore = new InMemorySessionStore()
    const eventBus = new InMemoryEventBus()
    const ids = new SequentialIdGenerator()
    const inflight = new InflightTracker()
    const steering = new SteeringQueue()
    const compactor = new ContextCompactor()
    const events = new RuntimeEventRecorder({
      eventBus, sessionStore, allocateSeq: (id) => eventBus.allocateSeq(id), nowIso
    })
    const turns = new TurnService({
      threadStore, sessionStore, events, inflight, steering, compactor, ids, nowIso
    })
    const requests: ModelRequest[] = []
    const model: ModelClient = {
      provider: 'test',
      model: 'deepseek-flash',
      async *stream(request) {
        requests.push(request)
        if (request.turnId.endsWith('_auto_router')) {
          if (reply === null) throw new Error('synthetic classifier unavailable')
          yield { kind: 'assistant_text_delta', text: reply }
        } else {
          yield { kind: 'assistant_text_delta', text: 'Ready.' }
        }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }
    const toolHost: ToolHost = {
      id: 'routing-test-host',
      async listTools() { return [] },
      async execute() { throw new Error('unexpected tool execution') }
    }
    await threadStore.upsert(createThreadRecord({
      id: threadId, title: 'V4.1 routing', workspace: '', model: selected, createdAt: nowIso()
    }))
    const started = await turns.startTurn({ threadId, request: { prompt: 'Hello' } })
    const loop = new AgentLoop({
      threadStore, sessionStore, approvalGate: new InMemoryApprovalGate(),
      userInputGate: new InMemoryUserInputGate(), model, toolHost,
      usage: new UsageService(), events, turns, inflight, steering, compactor,
      prefix: createImmutablePrefix(), ids, nowIso
    })

    await expect(loop.runTurn(threadId, started.turnId)).resolves.toBe('completed')
    const classifiers = requests.filter((request) => request.turnId.endsWith('_auto_router'))
    const completions = requests.filter((request) => !request.turnId.endsWith('_auto_router'))
    expect(completions).toHaveLength(1)
    expect(completions[0].model).toBe(expected)
    if (effort) expect(completions[0].reasoningEffort).toBe(effort)
    if (selected === 'auto') {
      expect(classifiers).toHaveLength(1)
      expect(classifiers[0]).toMatchObject({ model: 'deepseek-flash', stream: false, responseFormat: 'json_object', tools: [] })
      expect(classifiers[0].systemPrompt).toContain('"model":"deepseek-flash|deepseek-v4-pro"')
      expect(classifiers[0].systemPrompt).not.toContain('deepseek-v4-flash')
    } else {
      expect(classifiers).toHaveLength(0)
    }
    expect((await threadStore.get(threadId))?.model).toBe(selected)
    expect((await sessionStore.loadItems(threadId)).filter((item) => item.kind === 'assistant_text')).toHaveLength(1)
  })
})
