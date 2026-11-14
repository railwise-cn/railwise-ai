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
    version: '0.5.0', daemonProtocolVersion: '1.9', browsers: [{ id: 'browser-one', name: 'Chrome', label: 'Test', extensionVersion: '0.5.0', protocolVersion: '1.9', connected: true, versionSkew: false }], browserInstanceId: 'browser-one', revision: 1, origins: ['https://example.com'], interaction: 'interact' })
  repository.create(TaskRunSchema.parse({ id: 'task', threadId: 'thread', activeTurnId: 'turn', childTaskIds: [], workspaceRoot: root, goal: 'Read paginated products', status: 'running', agentId: 'default', acceptance: { kind: 'answer', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false }, budget: { maxAttempts: 3, maxDurationMs: 600000 }, attempts: 0, replans: 0, noProgressCount: 0, nodes: [], artifacts: [], revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }))
  let elementHtml = '<button id="next">Next page</button>'
  let started = false
  let starts = 0
  let sessionId = 'session-one'
  let url = 'about:blank'
  let title = ''
  const runner = vi.fn<BrowserCommandRunner>(async (_config, args) => {
    if (args[0] === 'status') return { ok: true, output: { daemon_version: '0.5.0', protocol_version: '1.9', pid: 10,
      browsers: [{ instance_id: 'browser-one', browser_name: 'Chrome', label: 'Test', extension_version: '0.5.0', extension_protocol_version: '1.9' }],
      sessions: started ? [{ session_id: sessionId, browser_instance_id: 'browser-one' }] : [] } }
    if (args[0] === 'session' && args[1] === 'start') { started = true; url = 'about:blank'; title = ''; starts += 1; sessionId = starts === 1 ? 'session-one' : 'session-two'; return { ok: true, output: { session_id: sessionId, browser_instance_id: 'browser-one' } } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: { state: 'ready', session: { session_id: sessionId, browser_instance_id: 'browser-one' } } }
    if (args[0] === 'session' && args[1] === 'stop') return { ok: true, output: { stopped: [sessionId], failed: [] } }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 7, active: true, url, title, scope: 'agent' }] } }
    if (args[0] === 'navigate') { url = args[1]; title = 'Normal source'; return { ok: true, output: { final_url: url } } }
    if (args[0] === 'get-html') return { ok: true, output: { tab_id: 7, html: elementHtml, byte_size: elementHtml.length, truncated: false } }
    if (args[0] === 'read') return { ok: true, output: { tab_id: 7, page_url: url, frame_url: url, scope: 'current_dom', truncated: false, items: [{ ref: '@e999', values: { exists: true, text: elementHtml.replace(/<[^>]*>/g, ''), value: '', placeholder: '公开查询' }, redacted: [] }] } }
    if (args[0] === 'cooperate') return { ok: true, output: { control_policy: args[args.indexOf('--policy') + 1], ready: true, context_id: 'context-one', observation_id: 'observation-one', observation: { text: 'Synthetic page content @e1' } } }
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

function publicQueryFixture() {
  const f = fixture()
  const scope = { ...f.context.executionGrant!.browserScope!, verificationPolicy: 'public_query_target' as const }
  f.context.executionGrant = ExecutionGrantSchema.parse({ ...f.context.executionGrant!, id: 'reviewed-public-grant', browserScope: scope })
  f.repository.update('task', 0, task => ({ ...task, goal: '用browser-skill搜索公开招标信息，无需账号', authority: {
    source: 'user', workspaceRoot: task.workspaceRoot, externalTargets: [], grantedAt: new Date().toISOString(), browserScope: scope
  } }))
  return f
}

describe('typed BrowserSkill production provider', () => {
  it('passes the exact official context/observation pair when navigating to a second authorized source under 0.5', async () => {
    const f = fixture()
    const origins = ['https://example.com', 'https://second.example']
    f.config.origins = origins
    f.context.executionGrant = ExecutionGrantSchema.parse({ ...f.context.executionGrant, networkAllowlist: origins,
      browserScope: { ...f.context.executionGrant!.browserScope, origins } })
    const original = f.runner.getMockImplementation()!
    let sequence = 0
    f.runner.mockImplementation(async (config, argv, signal) => {
      if (argv[0] === 'navigate' && argv[1] === 'https://second.example/two' && !argv.includes('--observation')) {
        return { ok: false, code: 'permission_denied', output: { code: 'permission_denied', data: { reason: 'observation_required', effect_state: 'none' } } }
      }
      const result = await original(config, argv, signal)
      return argv[0] === 'cooperate' ? { ...result, output: { ...result.output as object,
        context_id: `official-context-${++sequence}`, observation_id: `official-observation-${sequence}` } } : result
    })
    await f.execute('browser_session_start')
    const first = (await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/one' })).output as {
      observation: { context_id: string; observation_id: string }
    }
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://second.example/two', contextId: first.observation.context_id }))
      .toMatchObject({ output: { status: 'succeeded', sourceUrl: 'https://second.example/two' } })
    const second = f.runner.mock.calls.filter(([, argv]) => argv[0] === 'navigate')[1][1]
    expect(second[second.indexOf('--context') + 1]).toBe(first.observation.context_id)
    expect(second[second.indexOf('--observation') + 1]).toBe(first.observation.observation_id)
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'navigate')).toHaveLength(2)
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'cooperate').every(([, argv]) => argv[argv.indexOf('--policy') + 1] === 'strict')).toBe(true)
  })

  it('rejects fabricated caller context/observation and a pair from a different page before navigation', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/one' })
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/two', contextId: 'invented-context' }))
      .toMatchObject({ isError: true, output: { code: 'browser_context_stale' } })
    await expect(f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/two', contextId: 'context-one', observationId: 'invented-observation' }))
      .rejects.toThrow('observationId')
    f.setUrl('https://example.com/a-different-page')
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/two', contextId: 'context-one' }))
      .toMatchObject({ isError: true, output: { code: 'browser_context_stale' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'navigate')).toHaveLength(1)
  })

  it('does not invent a missing official observation ID for modern navigation', async () => {
    const f = fixture(), original = f.runner.getMockImplementation()!
    f.runner.mockImplementation(async (config, argv, signal) => {
      const result = await original(config, argv, signal)
      return argv[0] === 'cooperate' ? { ...result, output: { ...result.output as object, observation_id: undefined } } : result
    })
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/one' })
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/two', contextId: 'context-one' }))
      .toMatchObject({ isError: true, output: { code: 'browser_observation_required' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'navigate')).toHaveLength(1)
  })

  it.each(['missing_context', 'different_tab'] as const)('does not reuse an older pair after a newer sync returns %s', async mismatch => {
    const f = fixture(), original = f.runner.getMockImplementation()!
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/one' })
    f.runner.mockImplementation(async (config, argv, signal) => {
      const result = await original(config, argv, signal)
      return argv[0] === 'cooperate' ? { ...result, output: { ...result.output as object,
        ...(mismatch === 'missing_context' ? { context_id: undefined } : { tab_id: 8 }) } } : result
    })
    await f.execute('browser_observe', { sessionId: 'session-one' })
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/two', contextId: 'context-one' }))
      .toMatchObject({ isError: true, output: { code: 'browser_context_stale' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'navigate')).toHaveLength(1)
  })

  it.each(['outcome_unknown', 'readback_pending'] as const)('blocks automatic metadata sync/navigation while %s is unresolved', async state => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/one' })
    f.repository.beginOperation({ ownerId: 'task', idempotencyKey: state, kind: 'browser_action_dispatch',
      request: { action: 'click', sessionId: 'session-one', pageUrl: 'https://example.com/one', tabId: 7 }, nowIso: new Date().toISOString() })
    f.repository.finishOperation('task', state, { status: state === 'outcome_unknown' ? 'outcome_unknown' : 'succeeded',
      ...(state === 'readback_pending' ? { result: { actionAcknowledged: true, readbackPending: true } } : {}) })
    const calls = f.runner.mock.calls.filter(([, argv]) => ['navigate', 'cooperate'].includes(argv[0])).length
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/two' }))
      .toMatchObject({ isError: true, output: { code: state === 'outcome_unknown' ? 'browser_schedule_outcome_unknown' : 'browser_readback_blocked' } })
    expect(f.runner.mock.calls.filter(([, argv]) => ['navigate', 'cooperate'].includes(argv[0]))).toHaveLength(calls)
    expect(f.repository.operation('task', state)?.status).toBe(state === 'outcome_unknown' ? 'outcome_unknown' : 'succeeded')
  })

  it('preserves the legacy 0.4 strict navigation argument contract', async () => {
    const f = fixture()
    f.config.version = '0.4.0'
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/one' })
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/two' }))
      .toMatchObject({ isError: true, output: { code: 'browser_context_required' } })
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/two', contextId: 'context-one' }))
      .toMatchObject({ output: { status: 'succeeded' } })
    const argv = f.runner.mock.calls.filter(([, argv]) => argv[0] === 'navigate')[1][1]
    expect(argv).toContain('--context')
    expect(argv).not.toContain('--observation')
    expect(f.runner.mock.calls.filter(([, args]) => args[0] === 'cooperate').every(([, args]) => !args.includes('--policy'))).toBe(true)
  })

  it('requires reviewed public-query authorization before fixed native DOM expectations, including direct approved calls', async () => {
    const f = publicQueryFixture()
    const approval = vi.fn<ToolHostContext['awaitApproval']>(async () => 'allow')
    f.context.awaitApproval = approval
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<input aria-label="公开查询">')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '工程测量' }
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    expect(await host.execute({ toolName: 'browser_fill', callId: 'missing-public-review', arguments: args }, f.context))
      .toMatchObject({ item: { isError: true, output: { code: 'browser_public_query_action_required' } } })
    expect(await f.execute('browser_fill', args, { ...f.context, explicitApproval: { callId: 'legacy-direct-call', toolName: 'browser_fill', requestHash: 'a'.repeat(64) } }))
      .toMatchObject({ isError: true, output: { code: 'browser_public_query_action_required' } })
    expect(approval).not.toHaveBeenCalled()
    expect(f.runner.mock.calls.some(([, args]) => args[0] === 'fill')).toBe(false)
    expect(await f.execute('browser_authorize_action', { ...args, action: 'fill' })).toMatchObject({ isError: true, output: { code: 'browser_public_query_action_required' } })
    await f.execute('browser_authorize_action', { ...args, action: 'fill', access: 'public_query' })
    expect(approval).toHaveBeenCalledTimes(1)
    expect(approval.mock.calls[0]![0].summary).toContain('校验范围 "公开查询目标及明确依赖"')
    const before = JSON.stringify(f.context.executionGrant)
    expect(await host.execute({ toolName: 'browser_fill', callId: 'reviewed-public-fill', arguments: args }, f.context))
      .toMatchObject({ item: { isError: false, output: { status: 'succeeded' } } })
    expect(JSON.stringify(f.context.executionGrant)).toBe(before)
    const command = f.runner.mock.calls.map(([, argv]) => argv).find(argv => argv[0] === 'fill')!
    expect(command).not.toContain('--depends-on')
    expect(JSON.parse(String(command[command.indexOf('--expect') + 1]))).toEqual(expect.arrayContaining([{ target: '@e1', field: 'value', equals: '' }, { target: '@e1', field: 'exists', equals: true }]))
    expect(f.repository.operations('task', 'browser_action_dispatch')[0]!.request).toMatchObject({
      verificationPolicy: 'public_query_target', targetRef: '@e1', dependsOn: [], expectationVersion: 'native-dom-v1', expectationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      authorizationReceiptId: f.repository.operations('task', 'browser_action_authorization')[0]!.id
    })
  })

  it('blocks legacy public policy before creating a session and keeps strict0.4 compatible', async () => {
    const f = publicQueryFixture()
    f.config.version = '0.4.0'
    expect(await f.execute('browser_session_start')).toMatchObject({ isError: true, output: { code: 'browser_target_policy_upgrade_required' } })
    expect(f.runner.mock.calls.some(([, argv]) => argv[0] === 'session')).toBe(false)
  })

  it('explicitly selects strict on modern CLI even when historical cached peer metadata is absent', async () => {
    const f = fixture()
    delete f.config.daemonProtocolVersion
    f.config.browsers = []
    await f.execute('browser_session_start')
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })).toMatchObject({ output: { status: 'succeeded' } })
    const sync = f.runner.mock.calls.find(([, argv]) => argv[0] === 'cooperate')![1]
    expect(sync[sync.indexOf('--policy') + 1]).toBe('strict')
  })

  it('uses immutable strict/target session policies and a new session after a separately confirmed policy change', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    const scope = { ...f.context.executionGrant!.browserScope!, verificationPolicy: 'public_query_target' as const }
    f.context.executionGrant!.browserScope = scope
    f.repository.update('task', 0, task => ({ ...task, goal: 'browser-skill搜索公开公告', authority: { source: 'user', workspaceRoot: task.workspaceRoot, externalTargets: [], grantedAt: new Date().toISOString(), browserScope: scope } }))
    expect(await f.execute('browser_observe', { sessionId: 'session-one' })).toMatchObject({ isError: true, output: { code: 'browser_session_policy_changed' } })
    expect(await f.execute('browser_session_start')).toMatchObject({ output: { sessionId: 'session-two' } })
    await f.execute('browser_navigate', { sessionId: 'session-two', url: 'https://example.com/search' })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'cooperate').map(([, argv]) => argv[argv.indexOf('--policy') + 1])).toEqual(['strict', 'target'])
  })

  it('binds a later search click to the approved fill value using real native reads and settles navigation ACK without replay', async () => {
    const f = publicQueryFixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    let value = ''
    const original = f.runner.getMockImplementation()!
    f.runner.mockImplementation(async (config, argv, signal) => {
      if (argv[0] === 'read') {
        const input = argv[argv.indexOf('--ref') + 1] === '@e1'
        return { ok: true, output: { tab_id: 7, page_url: 'https://example.com/search', frame_url: 'https://example.com/search', scope: 'current_dom', truncated: false,
          items: [{ ref: '@e900', values: { exists: true, text: input ? '' : '\n  搜标题\n', value: input ? value : null }, redacted: [] }] } }
      }
      if (argv[0] === 'fill') value = String(argv[argv.indexOf('--value') + 1])
      if (argv[0] === 'click') f.setUrl('https://example.com/search?k=measurement')
      if (argv[0] === 'get-html' && argv[argv.indexOf('--ref') + 1] === '@e1') return { ok: true, output: { tab_id: 7, html: '<input placeholder="公开查询">', truncated: false } }
      return original(config, argv, signal)
    })
    f.setElement('<input placeholder="公开查询">')
    const fill = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '工程测量' }
    await f.execute('browser_authorize_action', { ...fill, action: 'fill', access: 'public_query' })
    expect(await f.execute('browser_fill', fill)).toMatchObject({ output: { status: 'succeeded' } })
    f.setElement('<button>搜标题</button>')
    const click = { sessionId: 'session-one', contextId: 'context-one', target: '@e2' }
    await f.execute('browser_authorize_action', { ...click, action: 'click', access: 'public_query' })
    value = '未经授权的查询'
    expect(await f.execute('browser_click', click)).toMatchObject({ isError: true, output: { code: 'browser_query_input_changed' } })
    expect(f.runner.mock.calls.some(([, argv]) => argv[0] === 'click')).toBe(false)
    value = '工程测量'
    expect(await f.execute('browser_click', click)).toMatchObject({ output: { status: 'succeeded', sourceUrl: 'https://example.com/search?k=measurement' } })
    const dispatched = f.runner.mock.calls.filter(([, argv]) => argv[0] === 'click')
    expect(dispatched).toHaveLength(1)
    const argv = dispatched[0]![1]
    expect(JSON.parse(String(argv[argv.indexOf('--expect') + 1]))).toEqual(expect.arrayContaining([
      { target: '@e2', field: 'text', equals: '\n  搜标题\n' }, { target: '@e1', field: 'value', equals: '工程测量' }
    ]))
    expect(f.repository.operations('task', 'browser_action_dispatch').every(receipt => (receipt.result as { readbackPending?: boolean }).readbackPending === false)).toBe(true)
  })

  it('checks both filled inputs when distinct observed targets have identical HTML', async () => {
    const f = publicQueryFixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    const html = '<input class="query">', elementHash = createHash('sha256').update(html).digest('hex')
    const values = new Map([['@e1', '工程测量'], ['@e2', '工程监测']])
    for (const [target, value] of values) {
      f.repository.beginOperation({ ownerId: 'task', idempotencyKey: `filled:${target}`, kind: 'browser_action_dispatch', nowIso: new Date().toISOString(),
        request: { action: 'fill', sessionId: 'session-one', pageUrl: 'https://example.com/search', tabId: 7, verificationPolicy: 'public_query_target' } })
      f.repository.finishOperation('task', `filled:${target}`, { status: 'succeeded', result: { actionAcknowledged: true, readbackPending: false,
        publicQueryInput: { target, value, elementHash, frameUrl: 'https://example.com/search' } } })
    }
    const original = f.runner.getMockImplementation()!
    f.runner.mockImplementation((config, argv, signal) => {
      const target = argv[argv.indexOf('--ref') + 1]
      if (argv[0] === 'get-html' && values.has(String(target))) return Promise.resolve({ ok: true, output: { tab_id: 7, html, truncated: false } })
      if (argv[0] === 'read') return Promise.resolve({ ok: true, output: { tab_id: 7, page_url: 'https://example.com/search', frame_url: 'https://example.com/search', scope: 'current_dom', truncated: false,
        items: [{ ref: '@e900', values: { exists: true, text: '搜索', value: values.get(String(target)) ?? '' }, redacted: [] }] } })
      return original(config, argv, signal)
    })
    f.setElement('<button>搜索</button>')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e3' }
    await f.execute('browser_authorize_action', { ...args, action: 'click', access: 'public_query' })
    expect(await f.execute('browser_click', args)).toMatchObject({ output: { status: 'succeeded' } })
    const argv = f.runner.mock.calls.find(([, argv]) => argv[0] === 'click')![1]
    expect(JSON.parse(String(argv[argv.indexOf('--expect') + 1]))).toEqual(expect.arrayContaining([
      { target: '@e1', field: 'value', equals: '工程测量' }, { target: '@e2', field: 'value', equals: '工程监测' }
    ]))
    values.set('@e1', 'changed')
    expect(await f.execute('browser_click', args)).toMatchObject({ isError: true, output: { code: 'browser_query_input_changed' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'click')).toHaveLength(1)
  })

  it.each(['truncated', 'redacted', 'wrong-page', 'empty'] as const)('does not dispatch public input from %s native facts', async invalid => {
    const f = publicQueryFixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<input placeholder="公开查询">')
    const fill = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '工程测量' }
    await f.execute('browser_authorize_action', { ...fill, action: 'fill', access: 'public_query' })
    const original = f.runner.getMockImplementation()!
    f.runner.mockImplementation((config, argv, signal) => argv[0] === 'read' ? Promise.resolve({ ok: true, output: {
      tab_id: 7, page_url: invalid === 'wrong-page' ? 'https://example.com/elsewhere' : 'https://example.com/search', frame_url: 'https://example.com/search', scope: 'current_dom', truncated: invalid === 'truncated',
      items: invalid === 'empty' ? [] : [{ ref: '@e900', values: { exists: true, value: '' }, redacted: invalid === 'redacted' ? ['value'] : [] }]
    } }) : original(config, argv, signal))
    expect(await f.execute('browser_fill', fill)).toMatchObject({ isError: true, output: { code: 'browser_element_unverified' } })
    expect(f.runner.mock.calls.some(([, argv]) => argv[0] === 'fill')).toBe(false)
  })

  it('keeps historical strict grants and approvals strict without dependency arguments', async () => {
    const f = fixture()
    expect(Object.hasOwn(f.context.executionGrant!.browserScope!, 'verificationPolicy')).toBe(false)
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    const args = { sessionId: 'session-one', contextId: 'context-one', target: 'e1' }
    expect(await f.execute('browser_click', args, { ...f.context, explicitApproval: { callId: 'legacy-direct-call', toolName: 'browser_fill', requestHash: 'a'.repeat(64) } })).toMatchObject({ output: { status: 'succeeded' } })
    expect(f.runner.mock.calls.find(([, args]) => args[0] === 'click')![1]).not.toContain('--depends-on')
    expect(f.repository.operations('task', 'browser_action_dispatch')[0]!.request).toMatchObject({ verificationPolicy: 'strict', dependsOn: [] })
  })

  it.each(['expired', 'revoked', 'target-changed', 'policy-missing'] as const)('never dispatches a public-query action with %s approval', async change => {
    const f = publicQueryFixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<input aria-label="公开查询">')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: 'e1', value: '工程测量' }
    await f.execute('browser_authorize_action', { ...args, action: 'fill', access: 'public_query' })
    const receipt = f.repository.operations('task', 'browser_action_authorization')[0]!
    if (change === 'target-changed') f.setElement('<input aria-label="另一个目标">')
    else if (change === 'policy-missing') {
      const { verificationPolicy: _policy, ...legacy } = receipt.request!
      f.repository.connection().prepare('UPDATE operation_receipts SET data_json=? WHERE owner_id=? AND idempotency_key=?')
        .run(JSON.stringify({ ...receipt, request: legacy }), 'task', receipt.idempotencyKey)
    } else f.repository.finishOperation('task', receipt.idempotencyKey, { status: 'succeeded', result: {
      ...(receipt.result as Record<string, unknown>), ...(change === 'expired' ? { expiresAt: '2000-01-01T00:00:00Z' } : { revoked: true })
    } })
    expect(await f.execute('browser_fill', args, { ...f.context, explicitApproval: { callId: 'legacy-direct-call', toolName: 'browser_fill', requestHash: 'a'.repeat(64) } })).toMatchObject({ isError: true, output: { code: 'browser_public_query_action_required' } })
    expect(f.runner.mock.calls.some(([, argv]) => argv[0] === 'fill')).toBe(false)
  })

  it('rejects press and account fields in public mode before asking for approval or sending input', async () => {
    const f = publicQueryFixture()
    const approval = vi.fn<ToolHostContext['awaitApproval']>(async () => 'allow')
    f.context.awaitApproval = approval
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    expect((await host.listTools(f.context)).some(tool => tool.name === 'browser_press')).toBe(false)
    expect(await f.execute('browser_press', { sessionId: 'session-one', contextId: 'context-one', key: 'Enter' }, { ...f.context, explicitApproval: { callId: 'legacy-direct-call', toolName: 'browser_fill', requestHash: 'a'.repeat(64) } }))
      .toMatchObject({ isError: true, output: { code: 'browser_public_query_action_required' } })
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<input type="password" aria-label="账号密码">')
    expect(await f.execute('browser_authorize_action', { sessionId: 'session-one', contextId: 'context-one', target: 'e1', action: 'fill', value: 'synthetic', access: 'public_query' }))
      .toMatchObject({ isError: true, output: { code: 'browser_public_query_target_blocked' } })
    expect(approval).not.toHaveBeenCalled()
    expect(f.runner.mock.calls.some(([, argv]) => ['press', 'fill'].includes(argv[0]))).toBe(false)
  })

  it.each(['<button>提交审批</button>', '<button>删除账户</button>', '<button title="转交待办">确定</button>',
    '<input placeholder="付款金额">', '<button>&#25552;&#20132;</button>'])('blocks a business target before authorization and dispatch: %s', async html => {
    const f = publicQueryFixture()
    const approval = vi.fn<ToolHostContext['awaitApproval']>(async () => 'allow')
    f.context.awaitApproval = approval
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1' }
    f.setElement('<button>搜索</button>')
    await f.execute('browser_authorize_action', { ...args, action: 'click', access: 'public_query' })
    approval.mockClear()
    f.setElement(html)
    expect(await f.execute('browser_authorize_action', { ...args, action: 'click', access: 'public_query' }))
      .toMatchObject({ isError: true, output: { code: 'browser_public_query_target_blocked' } })
    expect(await f.execute('browser_click', args, { ...f.context, explicitApproval: { callId: 'old', toolName: 'browser_click', requestHash: 'a'.repeat(64) } }))
      .toMatchObject({ isError: true, output: { code: 'browser_public_query_target_blocked' } })
    expect(approval).not.toHaveBeenCalled()
    expect(f.runner.mock.calls.some(([, argv]) => argv[0] === 'click')).toBe(false)
  })

  it.each(['<button type="submit">搜索</button>', '<a aria-label="下一页">2</a>', '<button>Search</button>'])('permits a reviewed public search or pagination target: %s', async html => {
    const f = publicQueryFixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement(html)
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1' }
    expect(await f.execute('browser_authorize_action', { ...args, action: 'click', access: 'public_query' }))
      .toMatchObject({ output: { status: 'succeeded' } })
    expect(await f.execute('browser_click', args)).toMatchObject({ output: { status: 'succeeded' } })
    expect(f.runner.mock.calls.find(([, argv]) => argv[0] === 'click')![1]).toContain('--expect')
  })

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
      if (argv[0] === 'cooperate' && fresh) return { ok: true, output: { control_policy: 'strict', context_id: 'context-two', observation: { text: 'Fresh public search @e1' } } }
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
      ? Promise.resolve({ ok: true, output: { control_policy: 'strict', context_id: 'unchanged-context', unchanged: true } })
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

  it('blocks further navigation while ACK readback is pending, but reads a legitimate click navigation in the owned tab', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/original' })
    f.repository.beginOperation({ ownerId: 'task', idempotencyKey: 'original-ack', kind: 'browser_action_dispatch',
      request: { action: 'click', sessionId: 'session-one', pageUrl: 'https://example.com/original', tabId: 7 }, nowIso: new Date().toISOString() })
    f.repository.finishOperation('task', 'original-ack', { status: 'succeeded', result: { actionAcknowledged: true, acknowledgementHash: 'a'.repeat(64), readbackPending: true } })
    const navigationCount = f.runner.mock.calls.filter(([, argv]) => argv[0] === 'navigate').length
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', contextId: 'context-one', url: 'https://example.com/different' }))
      .toMatchObject({ isError: true, output: { code: 'browser_readback_blocked' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'navigate')).toHaveLength(navigationCount)
    f.setUrl('https://example.com/search?k=measurement') // the acknowledged click navigated this same owned tab
    expect(await f.execute('browser_observe', { sessionId: 'session-one' }))
      .toMatchObject({ output: { status: 'succeeded', evidence: { businessOutcomeVerified: false, contentRead: true } } })
    expect(f.repository.operation('task', 'original-ack')).toMatchObject({ status: 'succeeded', result: {
      actionAcknowledged: true, acknowledgementHash: 'a'.repeat(64), sourceUrl: 'https://example.com/search?k=measurement', readbackPending: false } })
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
    expect(await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/two' })).toMatchObject({ output: { sourceUrl: 'https://example.com/two' } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'navigate')[1][1]).toContain('--context')
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === 'navigate')[1][1]).toContain('--observation')
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
      ? Promise.resolve({ ok: true, output: { control_policy: 'strict', context_id: 'denied-context', observation: { text: '@vom 1\nL1 page\n RootWebArea "403 Forbidden"\n StaticText "Forbidden"' } } })
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
    const approval = vi.fn<ToolHostContext['awaitApproval']>(async () => 'allow')
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
    const approval = vi.fn<ToolHostContext['awaitApproval']>(async () => 'allow')
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
    const approval = vi.fn<ToolHostContext['awaitApproval']>(async () => 'allow')
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
    const approval = vi.fn<ToolHostContext['awaitApproval']>(async () => 'allow')
    const host = new LocalToolHost({ registry: new CapabilityRegistry([f.provider]) })
    expect(await host.execute({ callId: 'legacy-occurrence', toolName: 'browser_fill', arguments: {
      sessionId: 'new-session', contextId: 'fresh-context', target: '@e1', value: 'query'
    } }, { ...f.context, awaitApproval: approval })).toMatchObject({ item: { isError: true, output: { code: 'browser_schedule_action_scope_required' } } })
    expect(approval).not.toHaveBeenCalled()
    expect(f.runner).not.toHaveBeenCalled()
  })

})


describe('trusted finite public-query input dispatch refusal', () => {
  it.each([
    { action: 'click', data: { press_sent: false }, known: true },
    { action: 'click', data: { dispatched: false }, known: true },
    { action: 'fill', data: { dispatched: false }, known: true },
    { action: 'fill', data: { press_sent: false }, known: false },
    { action: 'click', data: {}, known: false },
    { action: 'click', data: { press_sent: true }, known: false },
    { action: 'click', data: { press_sent: 'false' }, known: false },
    { action: 'click', data: { dispatched: 'false' }, known: false },
    { action: 'click', data: { dispatched: false, press_sent: true }, known: false },
    { action: 'click', data: { press_sent: false, phase: 'after_press' }, known: false },
    { action: 'click', data: { press_sent: false }, known: false, timeout: true },
    { action: 'click', data: { press_sent: false }, known: false, business: true },
  ])('classifies $action $data without retry (known=$known timeout=$timeout business=$business)', async ({ action, data, known, timeout, business }) => {
    const f = business ? fixture() : publicQueryFixture()
    await f.execute('browser_session_start')
    await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement(action === 'click' ? business ? '<button>保存设置</button>' : '<button>搜索</button>' : '<input placeholder="公开查询">')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', ...(action === 'fill' ? { value: '工程监测' } : {}) }
    const authorization = await f.execute('browser_authorize_action', { ...args, action, ...(!business ? { access: 'public_query' } : {}) })
    expect(authorization).toMatchObject({ output: { status: 'succeeded' } })
    const original = f.runner.getMockImplementation()!
    f.runner.mockImplementation((config, argv, signal) => argv[0] === action ? Promise.resolve({ ok: false, code: 'permission_denied', outcomeUnknown: Boolean(timeout),
      output: { code: 'permission_denied', data: { reason: 'target_covered', effect_state: 'unknown', operation_id: 'op-official-123', ...data } } }) : original(config, argv, signal))
    const result = await f.execute(`browser_${action}`, args)
    expect(result).toMatchObject({ isError: true, output: { status: known ? 'failed' : 'outcome_unknown', vendorCode: 'permission_denied',
      vendorReason: 'target_covered', effectState: 'unknown', vendorOperationId: 'op-official-123', ...(known ? { code: 'browser_action_not_dispatched', actionDispatch: 'not_sent' } : {}) } })
    expect(f.runner.mock.calls.filter(([, argv]) => argv[0] === action)).toHaveLength(1)
    expect(f.runner.mock.calls.some(([, argv]) => argv[0] === 'cooperate' && argv[1] === 'wait')).toBe(false)
    const dispatch = f.repository.operations('task', 'browser_action_dispatch').at(-1)!
    expect(dispatch).toMatchObject({ status: known ? 'failed' : 'outcome_unknown', result: { effectState: 'unknown', vendorOperationId: 'op-official-123',
      ...(known ? { actionDispatch: 'not_sent', notDispatched: true } : {}) } })
    if (known) {
      expect(await f.execute('browser_observe', { sessionId: 'session-one' })).toMatchObject({ output: { status: 'succeeded' } })
      expect(f.repository.operations('task', 'browser_schedule_action_outcome')).toHaveLength(0)
    }
  })

  it('retains safe official success metadata alongside the durable ACK and readback', async () => {
    const f = publicQueryFixture(), original = f.runner.getMockImplementation()!
    await f.execute('browser_session_start'); await f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    f.setElement('<button>搜索</button>')
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1' }
    await f.execute('browser_authorize_action', { ...args, action: 'click', access: 'public_query' })
    f.runner.mockImplementation((config, argv, signal) => argv[0] === 'click' ? Promise.resolve({ ok: true, output: { data: { operation_id: 'op-ack-123', dispatched: true } } }) : original(config, argv, signal))
    expect(await f.execute('browser_click', args)).toMatchObject({ output: { status: 'succeeded' } })
    expect(f.repository.operations('task', 'browser_action_dispatch').at(-1)).toMatchObject({ status: 'succeeded', result: {
      actionAcknowledged: true, readbackPending: false, vendorOperationId: 'op-ack-123', vendorDispatched: true } })
  })
})
