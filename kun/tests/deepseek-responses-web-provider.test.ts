import { describe, expect, it, vi } from 'vitest'
import {
  DeepSeekResponsesWebProvider,
  isDeepSeekResponsesWebSearchConfig
} from '../src/adapters/tool/deepseek-responses-web-provider.js'

function request() {
  return {
    query: '今天 AI 圈有哪些资讯',
    limit: 3,
    timeoutMs: 5_000,
    signal: new AbortController().signal
  }
}

describe('DeepSeek Responses web provider', () => {
  it.each(['deepseek-v4-flash', 'deepseek-v4-pro'])('uses the legacy Responses web_search tool with %s and parses URL citations', async model => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      id: 'resp_1',
      status: 'completed',
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: '今日资讯摘要',
          annotations: [
            { type: 'url_citation', url: 'https://news.example.com/a', title: '资讯 A' },
            { type: 'url_citation', url: 'https://news.example.com/b', title: '资讯 B' }
          ]
        }]
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const provider = new DeepSeekResponsesWebProvider({
      baseUrl: 'https://api.deepseek.com/beta',
      apiKey: 'sk-sensitive',
      model,
      fetchImpl: fetchImpl as typeof fetch,
      nowIso: () => '2026-08-13T00:00:00.000Z'
    })

    const results = await provider.search(request())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.deepseek.com/v1/responses')
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      model,
      input: '今天 AI 圈有哪些资讯',
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'web_search' },
      stream: false
    })
    expect(init.headers).toMatchObject({ authorization: 'Bearer sk-sensitive' })
    expect(JSON.stringify(body)).not.toContain('sk-sensitive')
    expect(results).toEqual([
      expect.objectContaining({ url: 'https://news.example.com/a', title: '资讯 A', rank: 1 }),
      expect.objectContaining({ url: 'https://news.example.com/b', title: '资讯 B', rank: 2 })
    ])
  })

  const credentialUrl = new URL('https://api.deepseek.com')
  credentialUrl.username = 'synthetic'
  credentialUrl.password = 'test-only'

  it.each([
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-flash' },
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek/deepseek-flash' },
    { baseUrl: 'https://third-party.example/v1', apiKey: 'sk-test', model: 'deepseek-flash' },
    { baseUrl: 'https://api.deepseek.com.attacker.example', apiKey: 'sk-test', model: 'deepseek-flash' },
    { baseUrl: 'http://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-flash' },
    { baseUrl: credentialUrl.href, apiKey: 'sk-test', model: 'deepseek-flash' },
    { baseUrl: 'https://api.deepseek.com', apiKey: '  ', model: 'deepseek-flash' },
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat' },
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-pro' },
    { baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-flash-preview' }
  ])('rejects unsupported official-search configuration before any network request: $baseUrl / $model', async config => {
    const fetchImpl = vi.fn()
    expect(isDeepSeekResponsesWebSearchConfig(config)).toBe(false)
    const provider = new DeepSeekResponsesWebProvider({ ...config, fetchImpl: fetchImpl as typeof fetch })
    await expect(provider.search(request())).rejects.toThrow('unavailable for this provider or model')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects unofficial providers, retired models, and uncited responses', async () => {
    expect(isDeepSeekResponsesWebSearchConfig({
      baseUrl: 'https://third-party.example/v1', apiKey: 'sk-test', model: 'deepseek-v4-pro'
    })).toBe(false)
    expect(isDeepSeekResponsesWebSearchConfig({
      baseUrl: 'https://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-chat'
    })).toBe(false)
    expect(isDeepSeekResponsesWebSearchConfig({
      baseUrl: 'http://api.deepseek.com', apiKey: 'sk-test', model: 'deepseek-v4-pro'
    })).toBe(false)
    expect(isDeepSeekResponsesWebSearchConfig({
      baseUrl: 'https://search.deepseek.com', apiKey: 'sk-test', model: 'deepseek-v4-pro'
    })).toBe(false)

    const provider = new DeepSeekResponsesWebProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-v4-flash',
      fetchImpl: async () => new Response(JSON.stringify({ output_text: '没有引用的回答' }), { status: 200 })
    })
    await expect(provider.search(request())).rejects.toThrow('no cited results')
  })

  it('uses completed open_page calls when DeepSeek omits URL citation annotations', async () => {
    const provider = new DeepSeekResponsesWebProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-sensitive',
      model: 'deepseek-v4-flash',
      fetchImpl: async () => new Response(JSON.stringify({
        status: 'completed',
        output: [
          {
            type: 'web_search_call',
            status: 'completed',
            action: {
              type: 'open_page',
              url: 'https://news.example.com/current#ws_call_id=call_123'
            }
          },
          {
            type: 'web_search_call',
            status: 'failed',
            action: {
              type: 'open_page',
              url: 'https://failed.example.com/ignored#ws_call_id=call_456'
            }
          },
          {
            type: 'message',
            status: 'completed',
            content: [{
              type: 'output_text',
              annotations: [],
              text: '这是 DeepSeek 联网检索生成的资讯摘要。'
            }]
          }
        ]
      }), { status: 200 }),
      nowIso: () => '2026-08-13T00:00:00.000Z'
    })

    await expect(provider.search(request())).resolves.toEqual([
      expect.objectContaining({
        url: 'https://news.example.com/current',
        snippet: '这是 DeepSeek 联网检索生成的资讯摘要。',
        provider: 'deepseek-responses',
        rank: 1
      })
    ])
  })

  it('cancels an oversized Responses body as soon as the byte limit is crossed', async () => {
    let cancelled = false
    const oneMiB = new Uint8Array(1024 * 1024).fill(0x61)
    let emitted = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1
        controller.enqueue(oneMiB)
        if (emitted === 20) controller.close()
      },
      cancel() {
        cancelled = true
      }
    })
    const provider = new DeepSeekResponsesWebProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-sensitive',
      model: 'deepseek-v4-pro',
      fetchImpl: async () => new Response(stream, { status: 200 })
    })

    await expect(provider.search(request())).rejects.toThrow(/size limit/u)
    expect(cancelled).toBe(true)
  })

  it('rejects Responses JSON nested beyond the traversal limit', async () => {
    let payload: Record<string, unknown> = {
      type: 'url_citation',
      url: 'https://news.example.com/deep'
    }
    for (let depth = 0; depth < 80; depth += 1) payload = { nested: payload }
    const provider = new DeepSeekResponsesWebProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-sensitive',
      model: 'deepseek-v4-pro',
      fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 })
    })

    await expect(provider.search(request())).rejects.toThrow(/nesting limit/u)
  })

  it('rejects shallow Responses JSON that exceeds the traversal node limit', async () => {
    const provider = new DeepSeekResponsesWebProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-sensitive',
      model: 'deepseek-v4-pro',
      fetchImpl: async () => new Response(JSON.stringify({
        noise: new Array(100_001).fill(0)
      }), { status: 200 })
    })

    await expect(provider.search(request())).rejects.toThrow(/node limit/u)
  })
})
