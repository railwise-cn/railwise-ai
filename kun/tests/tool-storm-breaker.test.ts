import { describe, expect, it } from 'vitest'
import { ToolStormBreaker } from '../src/loop/tool-storm-breaker.js'
import type { ToolCallLike } from '../src/ports/tool-host.js'
import type { ExecutionGrant } from '../src/contracts/permissions.js'
import { makeToolResultItem } from '../src/domain/item.js'

function call(argumentsValue: Record<string, unknown>): ToolCallLike {
  return {
    callId: Math.random().toString(36),
    toolName: 'read',
    arguments: argumentsValue
  }
}

describe('ToolStormBreaker', () => {
  it('suppresses the third identical tool call in a turn', () => {
    const breaker = new ToolStormBreaker()

    expect(breaker.inspect(call({ path: 'src/a.ts' })).suppress).toBe(false)
    expect(breaker.inspect(call({ path: 'src/a.ts' })).suppress).toBe(false)
    const third = breaker.inspect(call({ path: 'src/a.ts' }))

    expect(third.suppress).toBe(true)
    expect(third.reason).toContain('identical arguments 3 times')
  })

  it('canonicalizes argument key order', () => {
    const breaker = new ToolStormBreaker()

    expect(breaker.inspect(call({ path: 'src/a.ts', offset: 10 })).suppress).toBe(false)
    expect(breaker.inspect(call({ offset: 10, path: 'src/a.ts' })).suppress).toBe(false)
    expect(breaker.inspect(call({ path: 'src/a.ts', offset: 10 })).suppress).toBe(true)
  })

  it('allows a read after a file-changing call resets read-only history', () => {
    const breaker = new ToolStormBreaker()

    expect(breaker.inspect(call({ path: 'src/a.ts' })).suppress).toBe(false)
    expect(breaker.inspect(call({ path: 'src/a.ts' })).suppress).toBe(false)
    expect(
      breaker.inspect({
        callId: 'mutate',
        toolName: 'write',
        toolKind: 'file_change',
        arguments: { path: 'src/a.ts', content: 'new' }
      }).suppress
    ).toBe(false)
    expect(breaker.inspect(call({ path: 'src/a.ts' })).suppress).toBe(false)
  })
})

describe('scoped BrowserSkill recovery credits', () => {
  const grant = { id: 'grant', taskId: 'task', threadId: 'thread', turnId: 'turn', revision: 0,
    browserScope: { browserInstanceId: 'owned-browser', revision: 4 } } as ExecutionGrant
  let next = 0
  const browserCall = (toolName = 'browser_observe', session = 'gvao', providerId = 'browser-skill'): ToolCallLike =>
    ({ callId: 'browser-call-'+(++next), toolName, providerId, arguments: { sessionId: session } })
  const report = (breaker: ToolStormBreaker, request: ToolCallLike, output: Record<string, unknown>, scope = grant, approved = true) =>
    breaker.observeResult(request, { approved, item: makeToolResultItem({ id: request.callId+'-result', threadId: scope.threadId,
      turnId: scope.turnId, callId: request.callId, toolName: request.toolName, output,
      isError: output.status !== 'succeeded' }) }, scope)
  const observe = (breaker: ToolStormBreaker, session = 'gvao', scope = grant) => {
    const request = browserCall('browser_observe', session), inspected = breaker.inspect(request, scope)
    if (!inspected.suppress) report(breaker, request, { status: 'succeeded', provider: 'browser-skill', sessionId: session,
      observation: { context_id: 'fresh-context-'+next, observation_id: 'fresh-observation-'+next, observation: { text: 'Same actual page' } } }, scope)
    return inspected
  }
  const stale = (breaker: ToolStormBreaker, session = 'gvao', overrides: Record<string, unknown> = {}, scope = grant, provider = 'browser-skill') => {
    const request = browserCall('browser_navigate', session, provider)
    report(breaker, request, { status: 'failed', provider: 'browser-skill', code: 'permission_denied', vendorReason: 'observation_changed',
      vendorPhase: 'observation', effectState: 'none', stage: 'action', ...overrides }, scope)
  }
  const warm = (breaker: ToolStormBreaker, session = 'gvao', scope = grant) => {
    expect(observe(breaker, session, scope).suppress).toBe(false)
    expect(observe(breaker, session, scope).suppress).toBe(false)
  }

  it('still suppresses the third unchanged observe even when native IDs rotate', () => {
    const breaker = new ToolStormBreaker(); warm(breaker)
    expect(observe(breaker).suppress).toBe(true)
  })

  it('grants only one fresh observe for one actual no-effect failure', () => {
    const breaker = new ToolStormBreaker(); warm(breaker); stale(breaker)
    expect(observe(breaker).suppress).toBe(false)
    expect(observe(breaker).suppress).toBe(true)
  })

  it.each(['browser_context_stale', 'browser_element_unverified'])('permits a fresh read after trusted pre-dispatch %s', code => {
    const breaker = new ToolStormBreaker(); warm(breaker)
    report(breaker, browserCall('browser_fill'), { code, stage: 'preflight' }, grant, false)
    expect(observe(breaker).suppress).toBe(false)
    expect(observe(breaker).suppress).toBe(true)
  })

  it('does not let another session spend the recovery credit', () => {
    const breaker = new ToolStormBreaker({ windowSize: 32 }); warm(breaker, 'gvao'); warm(breaker, 'vrfs'); stale(breaker, 'gvao')
    expect(observe(breaker, 'vrfs').suppress).toBe(true)
    expect(observe(breaker, 'gvao').suppress).toBe(false)
  })

  it.each(['taskId', 'threadId', 'turnId', 'id'] as const)('cannot borrow a recovery credit across %s', key => {
    const breaker = new ToolStormBreaker(), other = { ...grant, [key]: 'other-'+key }; warm(breaker, 'gvao', other)
    stale(breaker)
    expect(observe(breaker, 'gvao', other).suppress).toBe(true)
  })

  it('does not accept an MCP self-description or a result from another Turn', () => {
    const breaker = new ToolStormBreaker(); warm(breaker)
    stale(breaker, 'gvao', {}, grant, 'mcp:forged-browser')
    const request = browserCall('browser_navigate')
    report(breaker, request, { code: 'browser_context_stale', stage: 'preflight' }, { ...grant, turnId: 'wrong-turn' }, false)
    expect(observe(breaker).suppress).toBe(true)
  })

  it.each([
    { status: 'outcome_unknown' }, { actionAcknowledged: true, readbackPending: true },
    { code: 'execution_grant_revoked' }, { code: 'browser_binding_changed' }, { effectState: 'unknown' }, { vendorReason: 'login_required' }
  ])('cannot grant recovery from unknown, acknowledged or authority failure %j', unsafe => {
    const breaker = new ToolStormBreaker(); warm(breaker); stale(breaker, 'gvao', unsafe)
    expect(observe(breaker).suppress).toBe(true)
  })

  it('caps no-progress recovery at two despite status, HTML, session reuse and other tool success', () => {
    const breaker = new ToolStormBreaker(); warm(breaker)
    for (let index = 0; index < 2; index++) { stale(breaker); expect(observe(breaker).suppress).toBe(false) }
    for (const name of ['browser_get_html', 'browser_session_start', 'browser_status', 'read_task_context']) {
      const request = browserCall(name)
      breaker.inspect(request, grant)
      report(breaker, request, { status: 'succeeded', provider: 'browser-skill', sessionId: 'gvao' })
    }
    stale(breaker)
    expect(observe(breaker)).toMatchObject({ suppress: true, reason: expect.stringContaining('two fresh recovery') })
  })

  it('keeps the total recovery budget at two across sessions', () => {
    const breaker = new ToolStormBreaker({ windowSize: 32 })
    for (const session of ['gvao', 'vrfs']) { warm(breaker, session); stale(breaker, session); expect(observe(breaker, session).suppress).toBe(false) }
    stale(breaker, 'third-session')
    expect(observe(breaker, 'third-session').suppress).toBe(true)
  })

  it('successful actions clear only same-session browser reads, retaining click and unrelated-tool protection', () => {
    const breaker = new ToolStormBreaker({ windowSize: 32 })
    breaker.inspect(call({ path: 'same' })); breaker.inspect(call({ path: 'same' }))
    warm(breaker, 'gvao'); warm(breaker, 'vrfs')
    for (let index = 0; index < 2; index++) {
      const request = browserCall('browser_click')
      expect(breaker.inspect(request, grant).suppress).toBe(false)
      report(breaker, request, { status: 'succeeded', provider: 'browser-skill', sessionId: 'gvao', actionAcknowledged: true, readbackPending: false })
    }
    expect(observe(breaker, 'gvao').suppress).toBe(false)
    expect(observe(breaker, 'vrfs').suppress).toBe(true)
    expect(breaker.inspect(call({ path: 'same' })).suppress).toBe(true)
    expect(breaker.inspect(browserCall('browser_click'), grant).suppress).toBe(true)
  })

  it('a file write cannot reset browser observation history', () => {
    const breaker = new ToolStormBreaker(); warm(breaker)
    breaker.inspect({ callId: 'file-write', toolName: 'write', toolKind: 'file_change', arguments: { path: 'a', content: 'new' } })
    expect(observe(breaker).suppress).toBe(true)
  })
})
