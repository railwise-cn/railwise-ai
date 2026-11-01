import { describe, expect, it } from 'vitest'
import {
  autoModelHeuristic,
  parseAutoRouteRecommendation,
  recentAutoRouterContext,
  resolveAutoModelRoute
} from '../src/loop/auto-model-router.js'
import { makeAssistantTextItem, makeToolResultItem, makeUserItem } from '../src/domain/item.js'
import type { ModelClient, ModelRequest, ModelStreamChunk } from '../src/ports/model-client.js'

describe('auto model router', () => {
  it('normalizes old router recommendations to the current default without changing effort', () => {
    expect(parseAutoRouteRecommendation('{"model":"pro","thinking":"max"}')).toEqual({
      model: 'deepseek-flash',
      reasoningEffort: 'max'
    })
    expect(parseAutoRouteRecommendation('noise {"model":"v4-flash"} tail')).toEqual({
      model: 'deepseek-flash'
    })
    expect(parseAutoRouteRecommendation('{"model":"auto"}')).toBeNull()
    expect(parseAutoRouteRecommendation('not json')).toBeNull()
  })

  it('keeps the V4.1 default for complex, long and simple fallback requests', () => {
    expect(autoModelHeuristic('hello')).toBe('deepseek-flash')
    expect(autoModelHeuristic('please debug this failing migration')).toBe('deepseek-flash')
    expect(autoModelHeuristic('x'.repeat(501))).toBe('deepseek-flash')
    expect(autoModelHeuristic('x'.repeat(200))).toBe('deepseek-flash')
  })

  it('retains the V4.1 default and reasoning effort when the classifier fails for a complex task', async () => {
    const modelClient: ModelClient = {
      provider: 'fake', model: 'fake',
      async *stream(): AsyncIterable<ModelStreamChunk> {
        yield { kind: 'error', message: 'synthetic classifier unavailable' }
      }
    }
    await expect(resolveAutoModelRoute({
      modelClient, threadId: 'thr_1', turnId: 'turn_1',
      latestRequest: 'Please debug the security migration before release.', recentContext: '',
      selectedModelMode: 'auto', abortSignal: new AbortController().signal
    })).resolves.toEqual({ model: 'deepseek-flash', reasoningEffort: 'max', source: 'heuristic' })
  })

  it('builds recent context without the active turn', () => {
    const items = [
      makeUserItem({ id: 'u1', threadId: 'thr_1', turnId: 'turn_1', text: 'hello' }),
      makeAssistantTextItem({ id: 'a1', threadId: 'thr_1', turnId: 'turn_1', text: 'hi', status: 'completed' }),
      makeToolResultItem({
        id: 'r1',
        threadId: 'thr_1',
        turnId: 'turn_2',
        callId: 'call_1',
        toolName: 'read',
        output: 'file content'
      }),
      makeUserItem({ id: 'u2', threadId: 'thr_1', turnId: 'turn_3', text: 'latest' })
    ]

    expect(recentAutoRouterContext(items, 'turn_3')).toContain('user: hello')
    expect(recentAutoRouterContext(items, 'turn_3')).toContain('assistant: hi')
    expect(recentAutoRouterContext(items, 'turn_3')).toContain('tool: [tool result] file content')
    expect(recentAutoRouterContext(items, 'turn_3')).not.toContain('latest')
  })

  it('uses the short JSON response path without advertising tools', async () => {
    let seenRequest: ModelRequest | null = null
    const modelClient: ModelClient = {
      provider: 'fake',
      model: 'fake',
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamChunk> {
        seenRequest = request
        yield { kind: 'assistant_text_delta', text: '{"model":"deepseek-v4-flash","thinking":"off"}' }
        yield { kind: 'completed', stopReason: 'stop' }
      }
    }

    const route = await resolveAutoModelRoute({
      modelClient,
      threadId: 'thr_1',
      turnId: 'turn_1',
      latestRequest: 'hello',
      recentContext: '',
      selectedModelMode: 'auto',
      abortSignal: new AbortController().signal
    })

    const capturedRequest = seenRequest as ModelRequest | null
    expect(route).toMatchObject({ model: 'deepseek-flash', reasoningEffort: 'off', source: 'flash-router' })
    expect(capturedRequest?.model).toBe('deepseek-flash')
    expect(capturedRequest?.tools).toEqual([])
    expect(capturedRequest?.responseFormat).toBe('json_object')
  })
})
