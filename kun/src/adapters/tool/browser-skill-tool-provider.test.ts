import { createHash } from 'node:crypto'
import type { BrowserScheduleResolution } from '../../contracts/browser-schedule-actions.js'
import { listApprovedBrowserScheduleActions } from '../../services/browser-schedule-action-authority.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserCapabilityConfig } from '../../contracts/browser-skill.js'
import { TaskRunSchema } from '../../contracts/tasks.js'
import { ExecutionGrantSchema } from '../../contracts/permissions.js'
import type { ToolHostContext } from '../../ports/tool-host.js'
import { TaskRunRepository } from '../../services/task-run-repository.js'
import type { BrowserCommandRunner } from '../../services/browser-skill-cli.js'
import { TaskController } from '../../services/task-controller.js'
import { InMemoryThreadStore } from '../in-memory-thread-store.js'
import { InMemorySessionStore } from '../in-memory-session-store.js'
import { PersistentApprovalGate } from '../persistent-human-gates.js'
import { LocalToolHost } from './local-tool-host.js'
import { CapabilityRegistry } from './capability-registry.js'
import { buildBrowserSkillToolProvider } from './browser-skill-tool-provider.js'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-provider-'))
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite'))
  cleanups.push(() => { repository.close(); rmSync(root, { recursive: true, force: true }) })
  const config = BrowserCapabilityConfig.parse({ enabled: true, state: 'ready', executablePath: '/fixed/bsk', executableHash: 'a'.repeat(64),
    browserInstanceId: 'browser-one', revision: 1, origins: ['https://example.com'], interaction: 'interact' })
  repository.create(TaskRunSchema.parse({ id: 'task', threadId: 'thread', activeTurnId: 'turn', childTaskIds: [], workspaceRoot: root, goal: 'Read paginated products', status: 'running', agentId: 'default', acceptance: { kind: 'answer', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false }, budget: { maxAttempts: 3, maxDurationMs: 600000 }, attempts: 0, replans: 0, noProgressCount: 0, nodes: [], artifacts: [], revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }))
  let elementHtml = '<button id="next">Next page</button>'
  let started = false
  let starts = 0
  let sessionId = 'session-one'
  let url = 'about:blank'
  let title = ''
  const runner = vi.fn<BrowserCommandRunner>(async (_config, args) => {
    if (args[0] === 'status') return { ok: true, output: { daemon_version: '0.4.0', protocol_version: '1.7', pid: 10,
      browsers: [{ instance_id: 'browser-one', browser_name: 'Chrome', label: 'Test', extension_version: '0.4.0', extension_protocol_version: '1.7' }],
      sessions: started ? [{ session_id: sessionId, browser_instance_id: 'browser-one' }] : [] } }
    if (args[0] === 'session' && args[1] === 'start') { started = true; url = 'about:blank'; title = ''; starts += 1; sessionId = starts === 1 ? 'session-one' : 'session-two'; return { ok: true, output: { session_id: sessionId, browser_instance_id: 'browser-one' } } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: { state: 'ready', session: { session_id: sessionId, browser_instance_id: 'browser-one' } } }
    if (args[0] === 'session' && args[1] === 'stop') return { ok: true, output: { stopped: [sessionId], failed: [] } }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 7, active: true, url, title, scope: 'agent' }] } }
    if (args[0] === 'navigate') { url = args[1]; title = 'Normal source'; return { ok: true, output: { final_url: url } } }
    if (args[0] === 'get-html') return { ok: true, output: { tab_id: 7, html: elementHtml, byte_size: elementHtml.length, truncated: false } }
    if (args[0] === 'cooperate') return { ok: true, output: { ready: true, context_id: 'context-one', observation: { text: 'Synthetic page content @e1' } } }
    return { ok: true, output: { tab_id: 7 } }
  })
  let scheduleResolution: BrowserScheduleResolution | undefined
  let scheduleFailure: string | undefined
  const provider = buildBrowserSkillToolProvider({ config: () => config, repository, dataDir: root, run: runner, resolveSchedule: async () => { if (scheduleFailure) throw Object.assign(new Error(scheduleFailure), { code: scheduleFailure }); return scheduleResolution } })
  const context: ToolHostContext = { threadId: 'thread', turnId: 'turn', workspace: root, approvalPolicy: 'on-request', sandboxMode: 'read-only',
    abortSignal: new AbortController().signal, awaitApproval: async () => 'allow',
    executionGrant: ExecutionGrantSchema.parse({ id: 'grant', taskId: 'task', threadId: 'thread', turnId: 'turn', workspaceRoot: root,
      workspaceTrust: 'read-only', agentTrust: 'read-only', sandboxMode: 'read-only', approvalPolicy: 'on-request', networkAllowlist: ['https://example.com'],
      browserScope: { browserInstanceId: 'browser-one', origins: ['https://example.com'], interaction: 'interact', revision: 1 },
      workspaceRevision: 0, agentRevision: 0, revision: 0, idempotencyKey: 'grant', issuedAt: new Date().toISOString() }) }
  const execute = (name: string, args = {}, ctx = context) => provider.tools.find(tool => tool.name === name)!.execute(args, ctx)
  return { repository, config, runner, provider, context, execute, setSchedule: (value: BrowserScheduleResolution | undefined) => { scheduleResolution = value }, failSchedule: (code: string) => { scheduleFailure = code }, setTitle: (next: string) => { title = next }, setElement: (html: string) => { elementHtml = html }, setUrl: (next: string) => { url = next } }
}

describe('typed BrowserSkill production provider', () => {
  it('refreshes once only after an explicit vendor none rejection, reuses the reviewed target/input and then fills with the fresh context', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<input aria-label="公开查询">')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '工程监测' }
    await f.execute('browser_authorize_action', { ...args, action: 'fill' })
    const original = f.runner.getMockImplementation()!
    let sent = 0
    let fresh = false
    f.runner.mockImplementation(async (config, argv, signal) => {
      if (argv[0] === 'fill' && ++sent === 1) return { ok: false, output: { code: 'permission_denied', data: { reason: 'cooperation_sync_required', effect_state: 'none' } }, code: 'permission_denied' }
      if (argv[0] === 'cooperate' && argv[1] === 'wait') { fresh = true; return { ok: true, output: { ready: true } } }
      if (argv[0] === 'cooperate' && fresh) return { ok: true, output: { context_id: 'context-two', observation: { text: 'Fresh public search @e1' } } }
      return original(config, argv, signal)
    })
    expect(await f.execute('browser_fill', args)).toMatchObject({ output: { status: 'succeeded', action: 'fill' } })
    const calls = f.runner.mock.calls.map(([, argv]) => argv).filter(argv => argv[0] === 'fill')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(expect.arrayContaining(['context-one', '工程监测', '@e1']))
    expect(calls[1]).toEqual(expect.arrayContaining(['context-two', '工程监测', '@e1']))
    expect(f.repository.operations('task', 'browser_action_dispatch').map(item => ({ status: item.status, result: item.result })))
      .toMatchObject([{ status: 'failed', result: { notDispatched: true, effectState: 'none', vendorReason: 'cooperation_sync_required' } }, { status: 'succeeded', result: { actionAcknowledged: true, readbackPending: false } }])
  })

  it.each(['unknown', undefined] as const)('does not retry an uncertain vendor effect (%s) despite a sync-required reason', async effect => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<input aria-label="公开查询">')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '工程监测' }
    await f.execute('browser_authorize_action', { ...args, action: 'fill' })
    const original = f.runner.getMockImplementation()!
    f.runner.mockImplementation((config, argv, signal) => argv[0] === 'fill'
      ? Promise.resolve({ ok: false, output: { data: { reason: 'cooperation_sync_required', ...(effect ? { effect_state: effect } : {}) } }, code: 'permission_denied' }) : original(config, argv, signal))
    expect(await f.execute('browser_fill', args)).toMatchObject({ isError: true, output: { status: 'outcome_unknown', stage: 'action', vendorReason: 'cooperation_sync_required' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'fill')).toHaveLength(1)
    expect(f.runner.mock.calls.some(([, argv]) => argv[0] === 'cooperate' && argv[1] === 'wait')).toBe(false)
  })

  it('bounds repeated vendor none rejections and gives control rejection its own durable reason without taking control', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<input aria-label="公开查询">')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '工程监测' }
    await f.execute('browser_authorize_action', { ...args, action: 'fill' })
    const original = f.runner.getMockImplementation()!
    let reason = 'cooperation_sync_required'
    f.runner.mockImplementation((config, argv, signal) => argv[0] === 'fill'
      ? Promise.resolve({ ok: false, output: { data: { reason, effect_state: 'none' } }, code: 'permission_denied' }) : original(config, argv, signal))
    expect(await f.execute('browser_fill', args)).toMatchObject({ isError: true, output: { status: 'failed', code: 'browser_sync_blocked', effectState: 'none' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'fill')).toHaveLength(2)
    await f.execute('browser_observe', { sessionId: 'session-one' })
    expect(await f.execute('browser_fill', args)).toMatchObject({ isError: true, output: { code: 'browser_sync_blocked' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'fill')).toHaveLength(2)
    // A different input is a different reviewed action, and never inherits the old approval.
    reason = 'control_authority_required'
    const changed = { ...args, value: '新查询' }
    await f.execute('browser_authorize_action', { ...changed, action: 'fill' })
    expect(await f.execute('browser_fill', changed)).toMatchObject({ isError: true, output: { status: 'failed', code: 'browser_control_required', effectState: 'none' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'fill')).toHaveLength(3)
  })

  it('retains an acknowledged action when readback fails, does not repeat it, and settles only after an actual readonly observation', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<input aria-label="公开查询">')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '工程监测' }
    await f.execute('browser_authorize_action', { ...args, action: 'fill' })
    const original = f.runner.getMockImplementation()!
    let sent = false, broken = true
    f.runner.mockImplementation((config, argv, signal) => {
      if (argv[0] === 'fill') sent = true
      if (sent && broken && argv[0] === 'cooperate') return Promise.resolve({ ok: false, output: { data: { reason: 'control_authority_required', effect_state: 'none' } }, code: 'permission_denied' })
      return original(config, argv, signal)
    })
    expect(await f.execute('browser_fill', args)).toMatchObject({ isError: true, output: { status: 'failed', code: 'browser_readback_blocked', actionAcknowledged: true, stage: 'readback', readbackPending: true } })
    const dispatch = f.repository.operations('task', 'browser_action_dispatch')[0]
    expect(dispatch).toMatchObject({ status: 'succeeded', result: { actionAcknowledged: true, readbackPending: true } })
    expect(await f.execute('browser_fill', args)).toMatchObject({ isError: true, output: { code: 'browser_readback_blocked' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'fill')).toHaveLength(1)
    broken = false
    await f.execute('browser_observe', { sessionId: 'session-one' })
    expect(f.repository.operation('task', dispatch.idempotencyKey)).toMatchObject({ status: 'succeeded', result: { readbackPending: false } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'fill')).toHaveLength(1)
  })
  it('stops with an actionable sync block when the one readonly refresh fails before another page action', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<input aria-label="公开查询">')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '工程监测' }
    await f.execute('browser_authorize_action', { ...args, action: 'fill' })
    const original = f.runner.getMockImplementation()!
    f.runner.mockImplementation((config, argv, signal) => argv[0] === 'fill'
      ? Promise.resolve({ ok: false, output: { data: { reason: 'cooperation_sync_required', effect_state: 'none' } }, code: 'permission_denied' })
      : argv[0] === 'cooperate' && argv[1] === 'wait' ? Promise.resolve({ ok: false, output: {}, code: 'browser_request_timeout' }) : original(config, argv, signal))
    expect(await f.execute('browser_fill', args)).toMatchObject({ isError: true, output: { status: 'failed', stage: 'preflight', code: 'browser_sync_blocked' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'fill')).toHaveLength(1)
    expect(f.repository.operations('task', 'browser_action_dispatch')).toMatchObject([{ status: 'failed', result: { notDispatched: true, effectState: 'none' } }])
  })

  it('does not settle an acknowledged action from an unchanged snapshot or an empty HTML result', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.repository.beginOperation({ ownerId: 'task', idempotencyKey: 'ack-before-read', kind: 'browser_action_dispatch',
      request: { action: 'click', sessionId: 'session-one', pageUrl: 'https://example.com/search', tabId: 7 }, nowIso: new Date().toISOString() })
    f.repository.finishOperation('task', 'ack-before-read', { status: 'succeeded', result: { actionAcknowledged: true, readbackPending: true } })
    const original = f.runner.getMockImplementation()!
    let html = ''
    f.runner.mockImplementation((config, argv, signal) => argv[0] === 'cooperate'
      ? Promise.resolve({ ok: true, output: { context_id: 'unchanged-context', unchanged: true } })
      : argv[0] === 'get-html' ? Promise.resolve({ ok: true, output: { tab_id: 7, html, truncated: false } }) : original(config, argv, signal))
    expect(await f.execute('browser_observe', { sessionId: 'session-one' })).toMatchObject({ isError: true, output: { code: 'browser_readback_blocked' } })
    await f.execute('browser_get_html', { sessionId: 'session-one' })
    expect(f.repository.operation('task', 'ack-before-read')).toMatchObject({ status: 'succeeded', result: { readbackPending: true } })
    // A different target cannot bypass the pending read and send another input.
    expect(await f.execute('browser_fill', { sessionId: 'session-one', contextId: 'unchanged-context', target: '@e2', value: 'another' })).toMatchObject({ isError: true, output: { code: 'browser_readback_blocked' } })
    html = '<html><body>当前原页面内容</body></html>'
    expect(await f.execute('browser_observe', { sessionId: 'session-one' })).toMatchObject({ output: { status: 'succeeded', evidence: { contentRead: true } } })
    expect(f.repository.operation('task', 'ack-before-read')).toMatchObject({ status: 'succeeded', result: { readbackPending: false } })
    expect(f.runner.mock.calls.some(([, argv]) => ['click', 'fill', 'press'].includes(argv[0]))).toBe(false)
  })

  it('does not settle a pending action by reading or navigating to a different same-origin page', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/original' })
    f.repository.beginOperation({ ownerId: 'task', idempotencyKey: 'original-ack', kind: 'browser_action_dispatch',
      request: { action: 'click', sessionId: 'session-one', pageUrl: 'https://example.com/original', tabId: 7 }, nowIso: new Date().toISOString() })
    f.repository.finishOperation('task', 'original-ack', { status: 'succeeded', result: { actionAcknowledged: true, readbackPending: true } })
    await f.execute('browser_navigate', { sessionId: 'session-one', contextId: 'context-one', url: 'https://example.com/different' })
    await f.execute('browser_get_html', { sessionId: 'session-one' })
    await f.execute('browser_observe', { sessionId: 'session-one' })
    expect(f.repository.operation('task', 'original-ack')).toMatchObject({ status: 'succeeded', result: { readbackPending: true } })
    f.setUrl('https://example.com/original')
    await f.execute('browser_get_html', { sessionId: 'session-one' })
    expect(f.repository.operation('task', 'original-ack')).toMatchObject({ status: 'succeeded', result: { readbackPending: false } })
    expect(f.runner.mock.calls.some(([, argv]) => ['click', 'fill', 'press'].includes(argv[0]))).toBe(false)
  })

  it('binds task and single-operation approval fingerprints to the full page URL on the same origin', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/first' })
    f.setElement('<button>确认处理</button>')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1' }
    const click = f.provider.tools.find(tool => tool.name === 'browser_click')!
    const firstSummary = await click.approvalSummary!(args, f.context)
    await f.execute('browser_authorize_action', { ...args, action: 'click' })
    expect(await click.hasScopedApproval!(args, f.context)).toBe(true)
    expect(f.repository.operations('task', 'browser_action_authorization')[0]?.request?.pageUrl).toBe('https://example.com/first')
    await f.execute('browser_navigate', { sessionId: 'session-one', contextId: 'context-one', url: 'https://example.com/second' })
    expect(await click.hasScopedApproval!(args, f.context)).toBe(false)
    expect(await click.approvalSummary!(args, f.context)).not.toBe(firstSummary)
    expect(await f.execute('browser_click', args)).toMatchObject({ isError: true, output: { code: 'browser_operation_approval_required' } })
    expect(f.runner.mock.calls.some(([, argv]) => argv[0] === 'click')).toBe(false)
    // Legacy origin-only records remain readable but never authorize the new page binding.
    const old = f.repository.operations('task', 'browser_action_authorization')[0]!
    const { pageUrl: _pageUrl, ...legacy } = old.request!
    f.repository.beginOperation({ ownerId: 'task', idempotencyKey: 'legacy-origin-only', kind: 'browser_action_authorization', request: legacy, nowIso: new Date().toISOString() })
    f.repository.finishOperation('task', 'legacy-origin-only', { status: 'succeeded', result: old.result })
    expect(await click.hasScopedApproval!(args, f.context)).toBe(false)
    expect(f.repository.operation('task', 'legacy-origin-only')).toBeTruthy()
  })

  it('persists a recoverable request before one session start and reuses the same task session', async () => {
    const f = fixture()
    expect(await f.execute('browser_session_start')).toMatchObject({ output: { sessionId: 'session-one', status: 'succeeded' } })
    expect(await f.execute('browser_session_start')).toMatchObject({ output: { sessionId: 'session-one', reused: true } })
    expect(f.runner.mock.calls.filter(([, args]) => args[0] === 'session' && args[1] === 'start')).toHaveLength(1)
    const sessionCalls = f.runner.mock.calls.map(([, args]) => args).filter(args => args[0] === 'session')
    expect(sessionCalls[0]).toEqual(['session', 'request', expect.stringMatching(/^\d+:[a-f0-9-]+$/), '--prepare'])
    expect(sessionCalls[1][1]).toBe('start')
    expect(f.repository.operations('task', 'browser_session')[0].request).toMatchObject({ browserInstanceId: 'browser-one', requestId: expect.stringMatching(/^\d+:[a-f0-9-]+$/) })
    expect(f.repository.operations('task', 'browser_session')[0].result).toMatchObject({ tabId: 7 })
  })
  it('reads an authorized page under a read-only workspace without advertising Shell or evaluate', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/fixture' })).toMatchObject({ output: {
      sourceUrl: 'https://example.com/fixture', evidence: { verified: true, contentRead: true, businessOutcomeVerified: false } } })
    expect(f.provider.tools.map(tool => tool.name)).not.toContain('bash')
    expect(f.provider.tools.map(tool => tool.name)).not.toContain('browser_evaluate')
    expect(f.runner.mock.calls.every(([, args]) => !args.includes('--scope') || args.includes('agent'))).toBe(true)
  })
  it('rejects another task session and origin before navigation', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    expect(await f.execute('browser_observe', { sessionId: 'foreign-session' })).toMatchObject({ isError: true, output: { code: 'browser_session_not_owned' } })
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://other.example/' })).toMatchObject({ isError: true, output: { code: 'browser_origin_blocked' } })
    expect(f.runner.mock.calls.some(([, args]) => args[0] === 'navigate')).toBe(false)
  })
  it('withholds page content after navigation outside the original site scope', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    f.setUrl('https://other.example/account')
    expect(await f.execute('browser_observe', { sessionId: 'session-one' })).toMatchObject({ isError: true, output: { code: 'browser_origin_blocked' } })
    expect(f.runner.mock.calls.some(([, args]) => args[0] === 'cooperate')).toBe(false)
  })
  it('requires an explicit approval and fresh context for potential writes', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/' })
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1' }
    expect(await f.execute('browser_click', args)).toMatchObject({ isError: true, output: { code: 'browser_operation_approval_required' } })
    const ctx = { ...f.context, explicitApproval: { callId: 'call', toolName: 'browser_click', requestHash: 'approved' } }
    expect(await f.execute('browser_click', args, ctx)).toMatchObject({ output: { evidence: { actionAcknowledged: true, businessOutcomeVerified: false } } })
    expect(f.runner.mock.calls.find(([, argv]) => argv[0] === 'click')?.[1]).toEqual(['click', '--session', 'session-one', '--tab-id', '7', '--context', 'context-one', '@e1'])
  })
  it('blocks stale browser binding revisions before any CLI call', async () => {
    const f = fixture()
    f.config.revision += 1
    expect(await f.execute('browser_session_start')).toMatchObject({ isError: true, output: { code: 'browser_binding_changed' } })
    expect(f.runner).not.toHaveBeenCalled()
  })
  it('records an unknown session start and reconciles it without another creation', async () => {
    const f = fixture()
    const original = f.runner.getMockImplementation()!
    let interrupted = true
    f.runner.mockImplementation(async (config, args, signal) => {
      const result = await original(config, args, signal)
      if (args[0] === 'session' && args[1] === 'start' && interrupted) { interrupted = false; return { ok: false, output: {}, outcomeUnknown: true } }
      return result
    })
    expect(await f.execute('browser_session_start')).toMatchObject({ isError: true })
    expect(f.repository.operations('task', 'browser_session')[0].status).toBe('outcome_unknown')
    expect(await f.execute('browser_session_start')).toMatchObject({ output: { reused: true } })
    expect(f.runner.mock.calls.filter(([, args]) => args[0] === 'session' && args[1] === 'start')).toHaveLength(1)
  })
  it('reads HTML and uses the current observed context for automatic link pagination', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/one' })
    expect(await f.execute('browser_get_html', { sessionId: 'session-one' })).toMatchObject({ output: { truncated: false, evidence: { contentRead: true } } })
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/two' })).toMatchObject({ isError: true, output: { code: 'browser_context_required' } })
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/two', contextId: 'context-one' })).toMatchObject({ output: { sourceUrl: 'https://example.com/two' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'navigate')[1][1]).toContain('--context')
  })
  it('reuses only a reviewed task element and value within the finite authorization', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/' })
    const approval = vi.fn<ToolHostContext['awaitApproval']>(async () => 'allow' as const)
    f.context.awaitApproval = approval
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1' }
    expect(await f.execute('browser_authorize_action', { ...args, action: 'click' })).toMatchObject({ output: { status: 'succeeded', elementHash: expect.any(String) } })
    expect(approval.mock.calls[0][0].summary).toContain('Next page')
    expect(await f.execute('browser_click', args)).toMatchObject({ output: { status: 'succeeded' } })
    expect(await f.execute('browser_click', args)).toMatchObject({ output: { status: 'succeeded' } })
    expect(approval).toHaveBeenCalledTimes(1)
    f.setElement('<button id="delete">Delete all</button>')
    expect(await f.execute('browser_click', args)).toMatchObject({ isError: true, output: { code: 'browser_operation_approval_required' } })
    f.setElement('<button id="next">Next page</button>')
    const saved = f.repository.operations('task', 'browser_action_authorization')[0]
    f.repository.finishOperation('task', saved.idempotencyKey, { status: 'succeeded', result: { ...(saved.result as Record<string, unknown>), expiresAt: '2000-01-01T00:00:00.000Z' } })
    expect(await f.execute('browser_click', args)).toMatchObject({ isError: true })
  })
  it('does not reuse interaction grants after pause, goal change or changed fill content', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/' })
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: 'search one' }
    await f.execute('browser_authorize_action', { ...args, action: 'fill' })
    expect(await f.execute('browser_fill', { ...args, value: 'other content' })).toMatchObject({ isError: true })
    f.repository.update('task', f.repository.get('task')!.revision, task => ({ ...task, status: 'paused' }))
    expect(await f.execute('browser_fill', args)).toMatchObject({ isError: true })
    f.repository.update('task', f.repository.get('task')!.revision, task => ({ ...task, status: 'running', goal: 'Different task goal' }))
    expect(await f.execute('browser_fill', args)).toMatchObject({ isError: true })
  })

  it('the production ToolHost reuses the server-verified browser authorization and asks for a changed target', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/' })
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1' }
    await f.execute('browser_authorize_action', { ...args, action: 'click' })
    const approvals = vi.fn<ToolHostContext['awaitApproval']>(async () => 'allow')
    f.context.awaitApproval = approvals
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    const result = await host.execute({ callId: 'reuse-click', toolName: 'browser_click', toolKind: 'tool_call', arguments: args }, f.context)
    expect(result.item).toMatchObject({ output: { status: 'succeeded' } })
    expect(approvals).not.toHaveBeenCalled()
    f.setElement('<button id="delete">Delete</button>')
    await host.execute({ callId: 'changed-click', toolName: 'browser_click', toolKind: 'tool_call', arguments: args }, f.context)
    expect(approvals).toHaveBeenCalledOnce()
  })

  it('creates a new owned session after a verified stop only in a later task turn', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_session_stop', { sessionId: 'session-one' })
    expect(await f.execute('browser_session_start')).toMatchObject({ isError: true, output: { code: 'browser_session_ended' } })
    const resumed = { ...f.context, turnId: 'resumed-turn', executionGrant: { ...f.context.executionGrant!, turnId: 'resumed-turn' } }
    expect(await f.execute('browser_session_start', {}, resumed)).toMatchObject({ output: { status: 'succeeded' } })
    expect(f.runner.mock.calls.filter(([, args]) => args[0] === 'session' && args[1] === 'start')).toHaveLength(2)
  })

  it('keeps internal browser scope approval separate from the actual TaskController outer operation hash', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/' })
    const tasks = new TaskController({ repository: f.repository, threadStore: new InMemoryThreadStore(), sessionStore: new InMemorySessionStore(), nowIso: () => new Date().toISOString() })
    tasks.beginAttempt('thread', 'turn')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', action: 'click' }
    const call = { callId: 'authorize-model-call', toolName: 'browser_authorize_action', toolKind: 'tool_call' as const, arguments: args }
    const operation = tasks.beginToolOperation('turn', call, f.context.executionGrant)!
    const gate = new PersistentApprovalGate(f.repository, () => new Date().toISOString())
    const recordApproval = vi.fn((approval: { toolName: string; requestHash: string }) => tasks.recordToolApproval(operation.token, operation.key, approval))
    const context = { ...f.context, recordExplicitApproval: recordApproval, assertExecution: () => tasks.assertToken(operation.token),
      awaitApproval: async (approval: Parameters<ToolHostContext['awaitApproval']>[0]) => {
        const pending = gate.request(approval)
        expect(gate.decide(approval.id, 'allow')).toBe(true)
        return pending
      } }
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    const result = await host.execute(call, context)
    expect(result.item).toMatchObject({ output: { status: 'succeeded' } })
    tasks.finishToolOperation(operation.token, operation.key, result)
    expect(recordApproval).not.toHaveBeenCalled()
    expect(f.repository.operation('task', operation.key)?.status).toBe('succeeded')
    const authorization = f.repository.operations('task', 'browser_action_authorization')[0]
    expect(gate.get((authorization.result as { approvalId: string }).approvalId)?.status).toBe('allowed')
  })

  it.each(['403 Forbidden', '401 Unauthorized', 'Login', 'Just a moment...', '人机验证'])('withholds source evidence for a real %s document title', async title => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/' })
    f.setElement(`<html><head><title>${title}</title></head><body>Restricted</body></html>`)
    expect(await f.execute('browser_get_html', { sessionId: 'session-one' })).toMatchObject({ isError: true, output: {
      code: 'web_access_blocked', sourceUrl: 'https://example.com/', evidence: { verified: false, contentRead: false } } })
  })
  it('does not mistake an article discussing HTTP errors for an access-denied page', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/' })
    f.setElement('<html><title>HTTP 403 troubleshooting guide</title><body>This article explains 403 Forbidden and login failures.</body></html>')
    expect(await f.execute('browser_get_html', { sessionId: 'session-one' })).toMatchObject({ output: { evidence: { contentRead: true, verified: true } } })
  })
  it('uses the same access-denied evidence rule for the actual observed document title', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    const original = f.runner.getMockImplementation()!
    f.runner.mockImplementation((config, args, signal) => args[0] === 'cooperate'
      ? Promise.resolve({ ok: true, output: { context_id: 'denied-context', observation: { text: '@vom 1\nL1 page\n RootWebArea "403 Forbidden"\n StaticText "Forbidden"' } } })
      : original(config, args, signal))
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/' })).toMatchObject({ isError: true, output: { code: 'web_access_blocked', evidence: { contentRead: false, verified: false } } })
  })

  it('checks the official tab title before a target subtree read and can navigate away using a fresh blocked-page context', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/denied' })
    f.setTitle('403 Forbidden')
    f.setElement('<div>Restricted subtree without a document title</div>')
    expect(await f.execute('browser_get_html', { sessionId: 'session-one', target: '@e1' })).toMatchObject({ isError: true, output: {
      code: 'web_access_blocked', evidence: { verified: false, contentRead: false } } })
    expect(f.runner.mock.calls.some(([, args]) => args[0] === 'get-html')).toBe(false)
    const blocked = await f.execute('browser_observe', { sessionId: 'session-one' })
    expect(blocked).toMatchObject({ isError: true, output: { contextId: 'context-one', code: 'web_access_blocked' } })
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/readable', contextId: 'context-one' }))
      .toMatchObject({ output: { sourceUrl: 'https://example.com/readable', evidence: { verified: true, contentRead: true } } })
  })

  it('advertises a scope request while hiding interactive tools, and blocks legacy dispatch before approval', async () => {
    const f = fixture()
    f.context.executionGrant!.browserScope!.interaction = 'observe'
    const approval = vi.fn(async () => 'allow' as const)
    f.context.awaitApproval = approval
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    const names = (await host.listTools(f.context)).map(item => item.name)
    expect(names).toContain('browser_request_interaction')
    expect(names).toContain('browser_navigate')
    for (const toolName of ['browser_click', 'browser_fill', 'browser_press', 'browser_authorize_action']) {
      expect(names).not.toContain(toolName)
      const result = await host.execute({ callId: toolName, toolName, arguments: {} }, f.context)
      expect(result).toMatchObject({ approved: false, item: { isError: true, output: { code: 'browser_interaction_scope_required' } } })
    }
    expect(await host.execute({ callId: 'scope-request', toolName: 'browser_request_interaction', arguments: { reason: '需要填写搜索框' } }, f.context))
      .toMatchObject({ item: { isError: true, output: { code: 'browser_interaction_scope_required' } } })
    expect(approval).not.toHaveBeenCalled()
    expect(f.runner.mock.calls.some(([, args]) => ['click', 'fill', 'press'].includes(args[0]))).toBe(false)
  })
  it('reviews the actual site, target and complete safe input with the original argument fingerprint', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<input type="search" aria-label="采购公告关键词">')
    const approval = vi.fn(async (_approval: Parameters<ToolHostContext['awaitApproval']>[0]) => 'allow' as const)
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '轨道交通监测' }
    expect(await host.execute({ callId: 'fill-search', toolName: 'browser_fill', arguments: args }, { ...f.context, awaitApproval: approval }))
      .toMatchObject({ item: { output: { status: 'succeeded' } } })
    const reviewed = approval.mock.calls[0][0] as { summary: string; requestHash: string }
    expect(reviewed.summary).toContain('https://example.com')
    expect(reviewed.summary).toContain('采购公告关键词')
    expect(reviewed.summary).toContain('轨道交通监测')
    expect(reviewed.summary).not.toContain('browser_fill')
    expect(reviewed.summary).not.toContain('session-one')
    expect(reviewed.summary).toContain(reviewed.requestHash)
    expect(f.runner.mock.calls.filter(([, args]) => args[0] === 'fill')).toHaveLength(1)
  })
  it('rejects a same-origin page change during single-operation review even when the button and arguments are identical', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/approval-one' })
    f.setElement('<button>确认处理</button>')
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    expect(await host.execute({ callId: 'click-reviewed-page', toolName: 'browser_click', arguments: {
      sessionId: 'session-one', contextId: 'context-one', target: '@e1'
    } }, { ...f.context, awaitApproval: async approval => {
      expect(approval.summary).toContain('https://example.com')
      expect(approval.summary).toContain('页面摘要')
      f.setUrl('https://example.com/approval-two')
      await f.execute('browser_observe', { sessionId: 'session-one' })
      return 'allow'
    } })).toMatchObject({ item: { isError: true, output: { code: 'approval_target_changed' } } })
    expect(f.runner.mock.calls.some(([, argv]) => argv[0] === 'click')).toBe(false)
  })

  it('hashes the full page query for review drift without exposing query credentials in approval summaries', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search?code=private-code-for-review&access_token=private-token-for-review' })
    f.setElement('<button>公开查询</button>')
    const tool = f.provider.tools.find(item => item.name === 'browser_click')!
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1' }
    const summary = await tool.approvalSummary!(args, f.context)
    expect(summary).toContain('页面摘要')
    expect(summary).not.toContain('private-code-for-review')
    expect(summary).not.toContain('private-token-for-review')
    expect(summary).not.toContain('access_token=')
    f.setUrl('https://example.com/search?code=another-code&access_token=another-token')
    await f.execute('browser_observe', { sessionId: 'session-one' })
    expect(await tool.approvalSummary!(args, f.context)).not.toBe(summary)
    let taskSummary = ''
    await f.execute('browser_authorize_action', { ...args, action: 'click' }, { ...f.context, awaitApproval: async approval => { taskSummary = approval.summary; return 'allow' } })
    expect(taskSummary).toContain('页面摘要')
    expect(taskSummary).not.toContain('another-code')
    expect(taskSummary).not.toContain('another-token')
    expect(f.runner.mock.calls.some(([, argv]) => argv[0] === 'click')).toBe(false)
  })

  it('masks a password input and rejects target drift after approval without dispatch', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/login-form' })
    f.setElement('<input type="password" aria-label="密码" value="previous-secret">')
    let summary = ''
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    const result = await host.execute({ callId: 'fill-secret', toolName: 'browser_fill', arguments: {
      sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: 'private-credential-value'
    } }, { ...f.context, awaitApproval: async approval => {
      summary = approval.summary
      f.setElement('<input type="password" aria-label="另一账户密码">')
      return 'allow'
    } })
    expect(summary).toContain('敏感输入已隐藏')
    expect(summary).not.toContain('private-credential-value')
    expect(summary).not.toContain('previous-secret')
    expect(result).toMatchObject({ item: { isError: true, output: { code: 'approval_target_changed' } } })
    expect(f.runner.mock.calls.some(([, args]) => args[0] === 'fill')).toBe(false)
  })

  it('requires an actual recurring source task and explicit public-query scope before durable authorization', async () => {
    const f = fixture()
    const approval = vi.fn(async () => 'allow' as const)
    f.context.awaitApproval = approval
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/' })
    expect(await f.execute('browser_authorize_action', { sessionId: 'session-one', contextId: 'context-one', target: '@e1', action: 'click', scope: 'schedule', scheduleAccess: 'public_query' }))
      .toMatchObject({ isError: true, output: { code: 'browser_schedule_authorization_unavailable' } })
    expect(approval).not.toHaveBeenCalled()
    expect(f.repository.operations('task', 'browser_schedule_action_authorization')).toHaveLength(0)
  })

  it('derives a fresh occurrence authorization beyond 15 minutes and blocks target drift or a disabled schedule before dispatch', async () => {
    const f = fixture()
    f.repository.update('task', 0, task => ({ ...task, acceptance: { ...task.acceptance, schedule: { kind: 'daily', times: ['09:00'], timezone: 'Asia/Shanghai' } },
      authority: { source: 'user', workspaceRoot: task.workspaceRoot, grantedAt: new Date().toISOString(), externalTargets: [], browserScope: f.context.executionGrant!.browserScope } }))
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<input type="search" aria-label="采购关键词">')
    const approved = vi.fn(async (_request: Parameters<ToolHostContext['awaitApproval']>[0]) => 'allow' as const)
    f.context.awaitApproval = approved
    const arguments_ = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', action: 'fill', value: '轨道监测', scope: 'schedule', scheduleAccess: 'public_query' }
    expect(await f.execute('browser_authorize_action', arguments_)).toMatchObject({ output: { status: 'succeeded', scope: 'schedule', accountState: 'unknown' } })
    expect(approved).toHaveBeenCalledOnce()
    expect(approved.mock.calls[0][0].summary).toContain('持续到计划停用或授权撤销')
    expect(approved.mock.calls[0][0].summary).toContain('仅授权无需账号的公开查询')
    const actions = listApprovedBrowserScheduleActions(f.repository, f.repository.get('task')!)
    expect(actions).toHaveLength(1)
    const initialReceipt = f.repository.operations('task', 'browser_action_authorization')[0]
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    expect(await host.execute({ callId: 'initial-fill', toolName: 'browser_fill', arguments: { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '轨道监测' } }, f.context))
      .toMatchObject({ item: { output: { status: 'succeeded' } } })
    expect(approved).toHaveBeenCalledOnce()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 2 * 86400000)
    try {
      expect(await host.execute({ callId: 'source-renewed-derived', toolName: 'browser_fill', arguments: { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '轨道监测' } }, f.context))
        .toMatchObject({ item: { output: { status: 'succeeded' } } })
      expect(approved).toHaveBeenCalledOnce()
      const binding = { scheduleId: 'schedule_task', versionId: 'published-v1', sourceTaskId: 'task', scopeHash: 'a'.repeat(64),
        actionsHash: createHash('sha256').update(JSON.stringify(actions)).digest('hex') }
      f.setSchedule({ binding, actions })
      const original = f.repository.get('task')!
      f.repository.create({ ...original, id: 'occurrence', threadId: 'due-thread', activeTurnId: 'due-turn', scheduledBy: { scheduleId: binding.scheduleId, dueAt: new Date().toISOString() } })
      const noApproval = vi.fn(async () => { throw new Error('The confirmed plan must derive an exact short authorization') })
      const context = { ...f.context, threadId: 'due-thread', turnId: 'due-turn', awaitApproval: noApproval,
        executionGrant: { ...f.context.executionGrant!, id: 'due-grant', taskId: 'occurrence', threadId: 'due-thread', turnId: 'due-turn', issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(), scheduleScopeHash: binding.scopeHash, browserScheduleBinding: binding } }
      await f.execute('browser_session_start', {}, context)
      await f.execute('browser_navigate', { sessionId: 'session-two', url: 'https://example.com/search' }, context)
      const args = { sessionId: 'session-two', contextId: 'context-one', target: '@e1', value: '轨道监测' }
      expect(await host.execute({ callId: 'due-fill', toolName: 'browser_fill', arguments: args }, context)).toMatchObject({ item: { output: { status: 'succeeded' } } })
      expect(noApproval).not.toHaveBeenCalled()
      expect(f.repository.operations('occurrence', 'browser_derived_action_authorization')).toHaveLength(1)
      expect(f.repository.operations('task', 'browser_action_authorization')[0]).toEqual(initialReceipt)
      const writes = f.runner.mock.calls.filter(([, args]) => args[0] === 'fill').length
      f.setElement('<input type="search" aria-label="另一目标">')
      expect(await host.execute({ callId: 'changed-fill', toolName: 'browser_fill', arguments: args }, context))
        .toMatchObject({ item: { isError: true, output: { code: 'browser_schedule_action_scope_changed' } } })
      f.failSchedule('schedule_authority_changed')
      expect(await host.execute({ callId: 'disabled-fill', toolName: 'browser_fill', arguments: args }, context))
        .toMatchObject({ item: { isError: true, output: { code: 'browser_schedule_authority_changed' } } })
      expect(f.runner.mock.calls.filter(([, args]) => args[0] === 'fill')).toHaveLength(writes)
      expect(noApproval).not.toHaveBeenCalled()
      f.failSchedule('')
      f.setElement('<input type="search" aria-label="采购关键词">')
      const originalRunner = f.runner.getMockImplementation()!
      f.runner.mockImplementation((config, argv, signal) => argv[0] === 'fill'
        ? Promise.resolve({ ok: false, output: {}, code: 'connection_lost', outcomeUnknown: true }) : originalRunner(config, argv, signal))
      expect(await host.execute({ callId: 'unknown-fill', toolName: 'browser_fill', arguments: args }, context))
        .toMatchObject({ item: { isError: true, output: { status: 'outcome_unknown' } } })
      expect(f.repository.operations('task', 'browser_schedule_action_outcome')[0]?.status).toBe('outcome_unknown')
      await f.execute('browser_observe', { sessionId: 'session-two' }, context)
      expect(await host.execute({ callId: 'must-not-replay', toolName: 'browser_fill', arguments: args }, context))
        .toMatchObject({ item: { isError: true, output: { code: 'browser_schedule_outcome_unknown' } } })
      expect(f.runner.mock.calls.filter(([, args]) => args[0] === 'fill')).toHaveLength(writes + 1)

    } finally { vi.useRealTimers() }
  })

  it('retains an unknown initial schedule action before any plan or occurrence exists', async () => {
    const f = fixture()
    f.repository.update('task', 0, task => ({ ...task, acceptance: { ...task.acceptance, schedule: { kind: 'daily', times: ['09:00'], timezone: 'Asia/Shanghai' } } }))
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<input type="search" aria-label="公开查询">')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '轨道监测' }
    await f.execute('browser_authorize_action', { ...args, action: 'fill', scope: 'schedule', scheduleAccess: 'public_query' })
    const originalRunner = f.runner.getMockImplementation()!
    f.runner.mockImplementation((config, argv, signal) => argv[0] === 'fill'
      ? Promise.resolve({ ok: false, output: {}, code: 'connection_lost', outcomeUnknown: true }) : originalRunner(config, argv, signal))
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    expect(await host.execute({ callId: 'initial-unknown', toolName: 'browser_fill', arguments: args }, f.context))
      .toMatchObject({ item: { isError: true, output: { status: 'outcome_unknown' } } })
    expect(f.repository.operations('task', 'browser_schedule_action_outcome')[0]).toMatchObject({ status: 'outcome_unknown', request: { scheduleId: 'schedule_task' } })
    await f.execute('browser_observe', { sessionId: 'session-one' })
    expect(await host.execute({ callId: 'no-initial-replay', toolName: 'browser_fill', arguments: args }, f.context))
      .toMatchObject({ item: { isError: true, output: { code: 'browser_schedule_outcome_unknown' } } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'fill')).toHaveLength(1)
  })

  it('blocks omitted periodic scope and old temporary approvals before any ordinary approval or page write', async () => {
    const f = fixture()
    const approval = vi.fn(async () => 'allow' as const)
    f.context.awaitApproval = approval
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '轨道监测' }
    await f.execute('browser_authorize_action', { ...args, action: 'fill' })
    expect(approval).toHaveBeenCalledOnce()
    f.repository.update('task', 0, task => ({ ...task, acceptance: { ...task.acceptance, schedule: { kind: 'daily', times: ['09:00'], timezone: 'Asia/Shanghai' } } }))
    approval.mockClear()
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    expect((await host.listTools(f.context)).some(tool => tool.name === 'browser_press')).toBe(false)
    for (const [name, parameters] of [['browser_fill', args], ['browser_click', { ...args, value: undefined }],
      ['browser_authorize_action', { ...args, action: 'fill' }], ['browser_press', { sessionId: 'session-one', contextId: 'context-one', key: 'Enter' }]] as const) {
      const input = Object.fromEntries(Object.entries(parameters).filter(([, value]) => value !== undefined))
      expect(await host.execute({ callId: name, toolName: name, arguments: input }, f.context))
        .toMatchObject({ item: { isError: true, output: { code: 'browser_schedule_action_scope_required' } } })
    }
    expect(await f.execute('browser_fill', args, { ...f.context, explicitApproval: { callId: 'legacy', toolName: 'browser_fill', requestHash: 'a'.repeat(64) } }))
      .toMatchObject({ isError: true, output: { code: 'browser_schedule_action_scope_required' } })
    expect(approval).not.toHaveBeenCalled()
    expect(f.runner.mock.calls.some(([, argv]) => ['fill', 'click', 'press'].includes(argv[0]))).toBe(false)
    expect(f.repository.operations('task', 'browser_action_dispatch')).toHaveLength(0)
  })

  it('blocks an old recurring occurrence without continuous action binding instead of asking for one-time approval', async () => {
    const f = fixture()
    f.repository.update('task', 0, task => ({ ...task, scheduledBy: { scheduleId: 'existing-plan', dueAt: new Date().toISOString() } }))
    const approval = vi.fn(async () => 'allow' as const)
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    expect(await host.execute({ callId: 'legacy-occurrence', toolName: 'browser_fill', arguments: {
      sessionId: 'new-session', contextId: 'fresh-context', target: '@e1', value: 'query'
    } }, { ...f.context, awaitApproval: approval })).toMatchObject({ item: { isError: true, output: { code: 'browser_schedule_action_scope_required' } } })
    expect(approval).not.toHaveBeenCalled()
    expect(f.runner).not.toHaveBeenCalled()
  })

})
