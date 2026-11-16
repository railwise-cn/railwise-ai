import { expect, it } from 'vitest'
import { ToolStormBreaker } from '../src/loop/tool-storm-breaker.js'
import { validEgoNavigationProgress } from '../src/services/ego-browser-evidence.js'
import { createEgoBrowserFixture } from './ego-browser-test-fixture.js'
import type { ToolCallLike, ToolHostResult } from '../src/ports/tool-host.js'
import type { ExecutionGrant } from '../src/contracts/permissions.js'

async function fixture() {
  const f = await createEgoBrowserFixture()
  const breaker = new ToolStormBreaker({ validateEgoNavigationProgress: (call, result, grant) => result.item.kind === 'tool_result' &&
    validEgoNavigationProgress(f.repo, f.task, result.item.output as Record<string, unknown>, grant, call) })
  const run = async (toolName: 'ego_browser_open' | 'ego_browser_observe' | 'ego_browser_read' | 'ego_browser_next_page', args: Record<string, unknown> = {}) => {
    const call: ToolCallLike = { toolName, callId: 'call-'+(f.repo.operations(f.task.id, 'tool').length+1), providerId: 'ego-browser', arguments: args }
    const result = breaker.inspect(call, f.grant())
    if (result.suppress) return { suppressed: true, output: {} as Record<string, unknown> }
    const output = await f.execute(toolName, args), host = f.repo.operations(f.task.id, 'tool').at(-1)!.result as ToolHostResult
    breaker.observeResult(call, host, f.grant())
    return { suppressed: false, output, call, host }
  }
  return { ...f, breaker, run }
}

it('allows the next same-args read after a real new Ego page and content, retaining unrelated protection', async () => {
  const f = await fixture()
  try {
    await f.run('ego_browser_open', { url: 'https://feed.test/list' })
    for (let i = 0; i < 2; i++) expect((await f.run('ego_browser_read')).suppressed).toBe(false)
    for (let i = 0; i < 2; i++) f.breaker.inspect({ callId: 'other-'+i, toolName: 'read', arguments: { path: 'same' } })
    const previous = (f.repo.operations(f.task.id, 'ego_document_read').at(-1)!.result as { nextPages: Array<{ targetId: string }> }).nextPages[0]!
    const observationId = f.repo.operations(f.task.id, 'ego_document_read').at(-1)!.id
    f.setHtml('<body><article><h2>新的工程测量项目</h2><time>2026-11-17</time></article></body>')
    const moved = await f.run('ego_browser_next_page', { observationId, targetId: previous.targetId })
    expect(moved.output.status).toBe('succeeded')
    expect((await f.run('ego_browser_read')).suppressed).toBe(false)
    expect(f.breaker.inspect({ callId: 'other-3', toolName: 'read', arguments: { path: 'same' } }).suppress).toBe(true)
  } finally { await f.dispose() }
})

it.each(['same-page', 'same-content-next'] as const)('keeps the third unchanged Ego read blocked without actual page/content progress: %s', async boundary => {
  const f = await fixture()
  try {
    await f.run('ego_browser_open', { url: 'https://feed.test/list' })
    await f.run('ego_browser_read');const read = await f.run('ego_browser_read')
    if (boundary === 'same-page') await f.run('ego_browser_open', { url: 'https://feed.test/list' })
    else await f.run('ego_browser_next_page', { observationId: read.output.observationId, targetId: (read.output.nextPages as Array<{ targetId: string }>)[0]!.targetId })
    expect((await f.run('ego_browser_read')).suppressed).toBe(true)
  } finally { await f.dispose() }
})

it.each(['forged-output', 'other-space', 'other-grant', 'mcp', 'unknown', 'replayed-first-open'] as const)('does not clear Ego reads from borrowed or forged progress: %s', async boundary => {
  const f = await fixture()
  try {
    const opened = await f.run('ego_browser_open', { url: 'https://feed.test/list' })
    await f.run('ego_browser_read');await f.run('ego_browser_read')
    const call = { ...opened.call!, callId: opened.host!.item.kind === 'tool_result' ? opened.host!.item.callId : '', providerId: boundary === 'mcp' ? 'mcp:forged' : 'ego-browser' }
    const original = opened.host!, output = original.item.kind === 'tool_result' ? original.item.output as Record<string, unknown> : {}
    const fake = { ...original, item: { ...original.item, output: { ...output,
      ...(boundary === 'other-space' ? { sessionId: '99', taskSpaceId: 99 } : {}), ...(boundary === 'unknown' ? { status: 'outcome_unknown' } : {}),
      ...(boundary === 'forged-output' ? { resultHash: 'f'.repeat(64) } : {}) } } } as ToolHostResult
    const grant = boundary === 'other-grant' ? { ...f.grant(), id: 'unrelated-grant' } as ExecutionGrant : f.grant()
    f.breaker.observeResult(call, fake, grant)
    expect((await f.run('ego_browser_read')).suppressed).toBe(true)
  } finally { await f.dispose() }
})
