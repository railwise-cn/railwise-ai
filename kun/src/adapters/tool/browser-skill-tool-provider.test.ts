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
    if (args[0] === 'session' && args[1] === 'start') { started = true; starts += 1; sessionId = starts === 1 ? 'session-one' : 'session-two'; return { ok: true, output: { session_id: sessionId, browser_instance_id: 'browser-one' } } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: { state: 'ready', session: { session_id: sessionId, browser_instance_id: 'browser-one' } } }
    if (args[0] === 'session' && args[1] === 'stop') return { ok: true, output: { stopped: [sessionId], failed: [] } }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 7, active: true, url, title, scope: 'agent' }] } }
    if (args[0] === 'navigate') { url = args[1]; title = 'Normal source'; return { ok: true, output: { final_url: url } } }
    if (args[0] === 'get-html') return { ok: true, output: { tab_id: 7, html: elementHtml, byte_size: elementHtml.length, truncated: false } }
    if (args[0] === 'cooperate') return { ok: true, output: { ready: true, context_id: 'context-one', observation: { text: 'Synthetic page content @e1' } } }
    return { ok: true, output: { tab_id: 7 } }
  })
  const provider = buildBrowserSkillToolProvider({ config: () => config, repository, dataDir: root, run: runner })
  const context: ToolHostContext = { threadId: 'thread', turnId: 'turn', workspace: root, approvalPolicy: 'on-request', sandboxMode: 'read-only',
    abortSignal: new AbortController().signal, awaitApproval: async () => 'allow',
    executionGrant: ExecutionGrantSchema.parse({ id: 'grant', taskId: 'task', threadId: 'thread', turnId: 'turn', workspaceRoot: root,
      workspaceTrust: 'read-only', agentTrust: 'read-only', sandboxMode: 'read-only', approvalPolicy: 'on-request', networkAllowlist: ['https://example.com'],
      browserScope: { browserInstanceId: 'browser-one', origins: ['https://example.com'], interaction: 'interact', revision: 1 },
      workspaceRevision: 0, agentRevision: 0, revision: 0, idempotencyKey: 'grant', issuedAt: new Date().toISOString() }) }
  const execute = (name: string, args = {}, ctx = context) => provider.tools.find(tool => tool.name === name)!.execute(args, ctx)
  return { repository, config, runner, provider, context, execute, setTitle: (next: string) => { title = next }, setElement: (html: string) => { elementHtml = html }, setUrl: (next: string) => { url = next } }
}

describe('typed BrowserSkill production provider', () => {
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

})
