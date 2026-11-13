import { describe, expect, it } from 'vitest'
import { WebToolFailureGuard } from '../src/loop/web-tool-failure-guard.js'

function call(toolName: string, callId = toolName) {
  return {
    callId,
    toolName,
    arguments: {}
  }
}

describe('WebToolFailureGuard', () => {
  it('limits retries per tool and source while preserving other capabilities', () => {
    const guard = new WebToolFailureGuard({ threshold: 2 })

    expect(guard.inspect(call('web_fetch')).suppress).toBe(false)
    guard.observe(call('web_fetch'), true)
    expect(guard.inspect(call('web_search')).suppress).toBe(false)
    guard.observe(call('web_fetch'), true)

    const blocked = guard.inspect(call('web_fetch', 'third'))
    expect(blocked.suppress).toBe(true)
    expect(blocked.reason).toContain('bounded retries')
    expect(guard.recoveryInstruction()).toContain('Other sources')
    expect(guard.shouldFailDegradedCompletion()).toBe(true)
    expect(guard.inspect(call('web_search')).suppress).toBe(false)
    expect(guard.inspect({ ...call('web_fetch'), arguments: {url:'https://another.example/page'} }).suppress).toBe(false)
  })

  it('does not block non-web tools and resets after a successful web call', () => {
    const guard = new WebToolFailureGuard({ threshold: 2 })

    guard.observe(call('web_fetch'), true)
    guard.observe(call('read'), true)
    expect(guard.inspect(call('grep')).suppress).toBe(false)
    expect(guard.inspect(call('web_search')).suppress).toBe(false)

    guard.observe(call('web_search'), false)
    expect(guard.inspect(call('web_fetch')).suppress).toBe(false)
    expect(guard.shouldFailDegradedCompletion()).toBe(false)
  })

  it('keeps earlier successful search evidence after later fetch failures', () => {
    const guard = new WebToolFailureGuard({ threshold: 2 })

    guard.observe(call('web_search'), false)
    guard.observe(call('web_fetch', 'fetch_1'), true)
    guard.observe(call('web_fetch', 'fetch_2'), true)

    expect(guard.isBlocked()).toBe(false)
    expect(guard.shouldFailDegradedCompletion()).toBe(false)
    expect(guard.recoveryInstruction()).toContain('Report source coverage accurately')
  })
})
