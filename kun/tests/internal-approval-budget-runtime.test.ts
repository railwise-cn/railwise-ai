import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'

const browserCli = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../src/services/browser-skill-cli.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/services/browser-skill-cli.js')>(), runBrowserCommand: browserCli.run
}))

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}
async function until(check: () => boolean, label: string) {
  const deadline = performance.now() + 5_000
  while (!check()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function fixture(kind: 'internal' | 'outer') {
  vi.useFakeTimers({ toFake: ['Date'] })
  let now = Date.parse('2026-11-14T04:00:00.000Z')
  vi.setSystemTime(now)
  const advance = (ms: number) => { now += ms; vi.setSystemTime(now) }
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '1')
  const root = await mkdtemp(join(tmpdir(), 'internal-approval-budget-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const toolResumed = deferred(), toolRelease = deferred(), modelResumed = deferred(), modelRelease = deferred()
  let sessionStarted = false, url = 'about:blank', currentValue = '', afterApproval = false, capturedTool = false
  const element = '<input id="search" aria-label="查询字段">'
  browserCli.run.mockReset()
  browserCli.run.mockImplementation(async (_config: unknown, args: readonly string[]) => {
    if (afterApproval && !capturedTool && args[0] === (kind === 'internal' ? 'get-html' : 'fill')) {
      capturedTool = true
      toolResumed.resolve()
      await toolRelease.promise
    }
    if (args[0] === 'status') return { ok: true, output: { daemon_version: '0.5.0', protocol_version: '1.9', pid: 7,
      browsers: [{ instance_id: 'budget-browser', browser_name: 'Chrome', extension_version: '0.5.0', extension_protocol_version: '1.9' }],
      sessions: sessionStarted ? [{ session_id: 'budget-session', browser_instance_id: 'budget-browser' }] : [] } }
    if (args[0] === 'session' && args[1] === 'start') { sessionStarted = true; return { ok: true, output: { session_id: 'budget-session', browser_instance_id: 'budget-browser' } } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: { state: 'ready', session: { session_id: 'budget-session', browser_instance_id: 'budget-browser' } } }
    if (args[0] === 'session' && args[1] === 'stop') return { ok: true, output: { stopped: ['budget-session'], failed: [] } }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 7, active: true, url, title: '合成字段', scope: 'agent' }] } }
    if (args[0] === 'navigate') { url = args[1]; return { ok: true, output: { final_url: url } } }
    if (args[0] === 'get-html') return { ok: true, output: { tab_id: 7, html: element, byte_size: Buffer.byteLength(element), truncated: false } }
    if (args[0] === 'cooperate') return { ok: true, output: { control_policy: args[args.indexOf('--policy') + 1], ready: true,
      context_id: 'budget-context', observation: { text: '合成字段 @e1' } } }
    if (args[0] === 'read') return { ok: true, output: { tab_id: 7, page_url: url, frame_url: url, scope: 'current_dom', truncated: false,
      items: [{ ref: '@e1', values: { exists: true, value: currentValue, text: '', id: 'search', 'aria-label': '查询字段' }, redacted: [] }] } }
    if (args[0] === 'fill') currentValue = '合成验收'
    return { ok: true, output: { tab_id: 7 } }
  })
  const actions = [
    { name: 'browser_session_start', arguments: {} },
    { name: 'browser_navigate', arguments: { sessionId: 'budget-session', url: 'https://example.test/search' } },
    { name: kind === 'internal' ? 'browser_authorize_action' : 'browser_fill', arguments: {
      sessionId: 'budget-session', contextId: 'budget-context', target: '@e1', value: '合成验收',
      ...(kind === 'internal' ? { action: 'fill', scope: 'task' } : {}) } }
  ]
  let modelCalls = 0
  const model = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { messages: unknown[] }
    expect(Array.isArray(body.messages)).toBe(true)
    const index = modelCalls++
    const action = actions[index]
    if (!action) { modelResumed.resolve(); await modelRelease.promise }
    const delta = action ? { tool_calls: [{ index: 0, id: `budget-call-${index}`, type: 'function', function: {
      name: action.name, arguments: JSON.stringify(action.arguments) } }] } : { content: '合成字段已按授权核对。' }
    return new Response(`data: ${JSON.stringify({ id: `budget-model-${index}`, choices: [{ index: 0, delta,
      finish_reason: action ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } })
  })
  vi.stubGlobal('fetch', model)
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'state'), runtimeToken: 'synthetic-budget',
    baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', endpointFormat: 'chat_completions', model: 'synthetic',
    approvalPolicy: 'on-request', sandboxMode: 'read-only', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' },
    capabilities: KunCapabilitiesConfig.parse({ browserSkill: { enabled: true, state: 'ready', version: '0.5.0',
      executablePath: '/synthetic/bsk', executableHash: 'a'.repeat(64), daemonProtocolVersion: '1.9', browserInstanceId: 'budget-browser',
      origins: ['https://example.test'], interaction: 'interact', revision: 1,
      browsers: [{ id: 'budget-browser', name: 'Chrome', label: '合成浏览器', extensionVersion: '0.5.0', protocolVersion: '1.9', connected: true, versionSkew: false }] } }) })
  const thread = await runtime.threadService.create({ workspace: root, model: 'synthetic', mode: 'agent' })
  const turn = await runtime.turnService.startTurn({ threadId: thread.id, request: {
    prompt: '使用 BrowserSkill 核对 https://example.test/search 的合成字段，在明确授权后填写。', taskIntent: 'new', taskVisibility: 'task', reasoningEffort: 'off' } })
  const task = runtime.taskRepository!.findByTurn(turn.turnId)!
  runtime.taskRepository!.update(task.id, task.revision, current => ({ ...current, budget: { ...current.budget,
    version: 2, maxExecutionMs: 120_000, maxDurationMs: 120_000 } }))
  const run = Promise.resolve(runtime.runTurn(thread.id, turn.turnId))
  cleanup.push(async () => {
    for (const pending of runtime.approvalGate.pending()) runtime.approvalGate.decide(pending.id, 'deny')
    toolRelease.resolve(); modelRelease.resolve()
    await run.catch(() => undefined)
    await runtime.shutdown?.()
  })
  function timing() {
    const waiting = runtime.taskRepository!.connection().prepare("SELECT started_at,finished_at FROM task_status_spans WHERE task_id=? AND status IN ('waiting_user','waiting_approval')").all(task.id) as Array<{started_at:string;finished_at:string|null}>
    const humanWaitMs = waiting.reduce((sum, span) => sum + (span.finished_at ? Date.parse(span.finished_at) : now) - Date.parse(span.started_at), 0)
    return { executionMs: runtime.taskRepository!.execution.usedExecutionMs(task.id, now), humanWaitMs,
      remainingMs: runtime.taskController!.workBudget(turn.turnId)!.remainingMs }
  }
  return { runtime, task, thread, turn, run, advance, timing, model, toolResumed, modelResumed,
    resume: () => { afterApproval = true }, releaseTool: toolRelease.resolve, releaseModel: modelRelease.resolve }
}

describe('real Runtime work budget while a browser tool waits for human approval', () => {
  it.each(['internal', 'outer'] as const)('excludes %s approval waiting and resumes tool/model charging afterward', async kind => {
    const f = await fixture(kind)
    await until(() => f.runtime.approvalGate.pending().length === 1, `${kind} approval`)
    const approval = f.runtime.approvalGate.pending()[0]!
    expect(approval.toolName).toBe(kind === 'internal' ? 'browser_authorize_action' : 'browser_fill')
    expect(f.runtime.taskRepository!.get(f.task.id)?.status).toBe('waiting_approval')
    const before = f.timing()
    f.advance(20_000)
    const waiting = f.timing()
    expect(waiting.humanWaitMs - before.humanWaitMs).toBe(20_000)
    expect(waiting.executionMs).toBe(before.executionMs)
    expect(waiting.remainingMs).toBe(before.remainingMs)
    f.resume()
    expect(f.runtime.approvalGate.decide(approval.id, 'allow')).toBe(true)
    await f.toolResumed.promise
    const toolBefore = f.timing()
    f.advance(1_500)
    const toolAfter = f.timing()
    expect(toolAfter.executionMs - toolBefore.executionMs).toBe(1_500)
    expect(toolAfter.remainingMs! - toolBefore.remainingMs!).toBe(-1_500)
    expect(toolAfter.humanWaitMs).toBe(waiting.humanWaitMs)
    f.releaseTool()
    await f.modelResumed.promise
    const modelBefore = f.timing()
    f.advance(2_000)
    const modelAfter = f.timing()
    expect(modelAfter.executionMs - modelBefore.executionMs).toBe(2_000)
    expect(modelAfter.remainingMs! - modelBefore.remainingMs!).toBe(-2_000)
    expect(modelAfter.humanWaitMs).toBe(waiting.humanWaitMs)
    f.releaseModel()
    await f.run
    expect(f.model).toHaveBeenCalledTimes(4)
    expect(f.runtime.approvalGate.get(approval.id)?.status).toBe('allowed')
    const spans = f.runtime.taskRepository!.connection().prepare('SELECT kind,started_ms,finished_ms FROM task_work_spans WHERE root_id=? ORDER BY started_ms').all(f.task.id) as Array<{kind:string;started_ms:number;finished_ms:number|null}>
    expect(spans.every(span => span.finished_ms !== null)).toBe(true)
  }, 15_000)
})
