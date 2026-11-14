import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityRegistry } from '../adapters/tool/capability-registry.js'
import { LocalToolHost } from '../adapters/tool/local-tool-host.js'
import { buildToolCatalogFingerprint } from '../cache/tool-catalog-fingerprint.js'
import { BrowserCapabilityConfig } from '../contracts/browser-skill.js'
import { ExecutionGrantSchema } from '../contracts/permissions.js'
import { TaskRunSchema } from '../contracts/tasks.js'
import type { ToolHostContext } from '../ports/tool-host.js'
import type { BrowserCommandRunner } from './browser-skill-cli.js'
import { ManagedBrowserSkillRuntime } from './managed-browser-skill-runtime.js'
import { TaskRunRepository } from './task-run-repository.js'

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-lifecycle-'))
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite'))
  cleanups.push(() => { repository.close(); rmSync(root, { recursive: true, force: true }) })
  const configPath = join(root, 'config.json')
  const config = BrowserCapabilityConfig.parse({ enabled: true, state: 'ready', executablePath: '/fixed/bsk', executableHash: 'a'.repeat(64),
    version: '0.4.0', homeDirectory: join(root, 'bsk'), browserInstanceId: 'browser-one', revision: 1,
    origins: ['https://example.com', 'https://second.example'], interaction: 'interact', daemonProtocolVersion: '1.7',
    browsers: [{ id: 'browser-one', name: 'Chrome', label: 'Original label', extensionVersion: '0.4.0', protocolVersion: '1.7', connected: true, versionSkew: false }] })
  repository.create(TaskRunSchema.parse({ id: 'task', threadId: 'thread', activeTurnId: 'turn', childTaskIds: [], workspaceRoot: root,
    goal: 'Read the public search page', status: 'running', agentId: 'default',
    acceptance: { kind: 'answer', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false },
    budget: { maxAttempts: 3, maxDurationMs: 600000 }, attempts: 1, replans: 0, noProgressCount: 0, nodes: [], artifacts: [], revision: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }))
  let url = 'about:blank'
  let started = false
  const runner = vi.fn<BrowserCommandRunner>(async (_config, args) => {
    if (args[0] === 'status') return { ok: true, output: { protocol_version: '1.7', pid: 10,
      browsers: [{ instance_id: 'browser-one', browser_name: 'Chrome', label: 'Test', extension_version: '0.4.0', extension_protocol_version: '1.7' }],
      sessions: started ? [{ session_id: 'session-one', browser_instance_id: 'browser-one' }] : [] } }
    if (args[0] === 'session' && args[1] === 'start') { started = true; return { ok: true, output: { session_id: 'session-one', browser_instance_id: 'browser-one' } } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: { state: 'ready', session: { session_id: 'session-one', browser_instance_id: 'browser-one' } } }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 7, active: true, url, title: 'Public search', scope: 'agent' }] } }
    if (args[0] === 'navigate') { url = args[1]; return { ok: true, output: { final_url: url } } }
    if (args[0] === 'get-html') return { ok: true, output: { tab_id: 7, html: '<input type="search" aria-label="采购关键词">', byte_size: 57, truncated: false } }
    if (args[0] === 'cooperate') return { ok: true, output: { ready: true, context_id: 'context-one', observation: { text: 'Public search @e1' } } }
    return { ok: true, output: { tab_id: 7 } }
  })
  const registry = new CapabilityRegistry()
  const apply = vi.fn((provider: ReturnType<ManagedBrowserSkillRuntime['provider']>) => registry.replaceProvider('browser-skill', provider))
  const runtime = new ManagedBrowserSkillRuntime({ config, configPath, dataDir: root, repository, run: runner, apply, resolveSchedule: async () => undefined })
  registry.registerProvider(runtime.provider())
  const host = new LocalToolHost({ registry })
  const approvals = vi.fn<ToolHostContext['awaitApproval']>(async () => 'allow')
  const context: ToolHostContext = { threadId: 'thread', turnId: 'turn', workspace: root, approvalPolicy: 'on-request', sandboxMode: 'read-only',
    abortSignal: new AbortController().signal, awaitApproval: approvals,
    executionGrant: ExecutionGrantSchema.parse({ id: 'grant', taskId: 'task', threadId: 'thread', turnId: 'turn', workspaceRoot: root,
      workspaceTrust: 'read-only', agentTrust: 'read-only', sandboxMode: 'read-only', approvalPolicy: 'on-request',
      ...runtime.scope('browser-skill https://example.com'), workspaceRevision: 0, agentRevision: 0, revision: 0,
      idempotencyKey: 'grant', issuedAt: new Date().toISOString() }) }
  const execute = (toolName: string, args = {}, callId = toolName) => host.execute({ callId, toolName, arguments: args }, context)
  const refresh = async (value: BrowserCapabilityConfig) => {
    writeFileSync(configPath, JSON.stringify({ capabilities: { browserSkill: value } }))
    return runtime.refresh()
  }
  const prepare = async () => {
    expect(await execute('browser_session_start')).toMatchObject({ item: { output: { status: 'succeeded', sessionId: 'session-one' } } })
    expect(await execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' }))
      .toMatchObject({ item: { output: { status: 'succeeded', observation: { context_id: 'context-one' } } } })
  }
  return { config, runtime, repository, runner, apply, host, context, approvals, execute, refresh, prepare }
}

describe('BrowserSkill diagnostic refresh lifecycle', () => {
  it.each(['task', 'schedule'] as const)('preserves the %s-reviewed provider, scope fingerprint and tool catalog after an unchanged diagnostic refresh', async scope => {
    const f = fixture()
    if (scope === 'schedule') f.repository.update('task', 0, task => ({ ...task,
      acceptance: { ...task.acceptance, schedule: { kind: 'daily', times: ['09:00'], timezone: 'Asia/Shanghai' } },
      authority: { source: 'user', workspaceRoot: task.workspaceRoot, grantedAt: new Date().toISOString(), externalTargets: [], browserScope: f.context.executionGrant!.browserScope }
    }))
    await f.prepare()
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '轨道监测' }
    expect(await f.execute('browser_authorize_action', { ...args, action: 'fill', scope,
      ...(scope === 'schedule' ? { scheduleAccess: 'public_query' } : {}) })).toMatchObject({ item: { output: { status: 'succeeded' } } })
    const provider = f.runtime.provider()
    const grantFingerprint = f.context.executionGrant!.connectorIdentityFingerprints!['browser-skill']
    const catalog = buildToolCatalogFingerprint(await f.host.listTools(f.context))
    const observations = f.runner.mock.calls.filter(([, args]) => args[0] === 'cooperate').length
    const fresh = { ...f.config, checkedAt: new Date().toISOString(), message: 'Diagnostic completed', code: undefined,
      origins: [...f.config.origins].reverse(), browsers: [
        { ...f.config.browsers[0], id: 'unrelated-browser', label: 'Other browser' },
        { ...f.config.browsers[0], label: 'Updated display label' }
      ] }
    expect(await f.refresh(fresh)).toMatchObject({ checkedAt: fresh.checkedAt })
    expect(f.runtime.provider()).toBe(provider)
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.runtime.scope('browser-skill https://example.com').connectorIdentityFingerprints?.['browser-skill']).toBe(grantFingerprint)
    expect(buildToolCatalogFingerprint(await f.host.listTools(f.context))).toEqual(catalog)
    expect(f.runner.mock.calls.filter(([, args]) => args[0] === 'cooperate')).toHaveLength(observations)
    expect(await f.execute('browser_fill', args)).toMatchObject({ item: { output: { status: 'succeeded', sessionId: 'session-one' } } })
    expect(f.approvals).toHaveBeenCalledOnce()
    expect(f.runner.mock.calls.filter(([, args]) => args[0] === 'fill')).toHaveLength(1)
    expect(f.runner.mock.calls.filter(([, args]) => args[0] === 'session' && args[1] === 'start')).toHaveLength(1)
  })

  it('retires only the ended task session and fences its obsolete abort listener from the replacement', async () => {
    const f = fixture(), original = f.runner.getMockImplementation()!
    const oldAbort = new AbortController(), nextAbort = new AbortController(), otherAbort = new AbortController()
    f.context.abortSignal = oldAbort.signal
    await f.prepare()
    let replacement = false
    f.runner.mockImplementation(async (config, args, signal) => {
      if (args[0] === 'status') { const response = await original(config, args, signal); return { ...response, output: { ...response.output as object, sessions: [] } } }
      if (args[0] === 'tab' && args.includes('session-one')) return { ok: false, code: 'not_found', exitCode: 1, outcomeUnknown: false,
        output: { code: 'not_found', data: { reason: 'session_idle_timeout', ended_unix_ms: Date.now() } } }
      if (args[0] === 'session' && args[1] === 'start') { const id = replacement ? 'other-session' : 'replacement'; replacement = true; return { ok: true, output: { session_id: id, browser_instance_id: 'browser-one' } } }
      return original(config, args, signal)
    })
    const provider = f.runtime.provider()
    const resumed: ToolHostContext = { ...f.context, abortSignal: nextAbort.signal, turnId: 'next-turn',
      executionGrant: { ...f.context.executionGrant!, id: 'next-grant', turnId: 'next-turn' } }
    expect(await provider.tools.find(tool => tool.name === 'browser_session_start')!.execute({}, resumed)).toMatchObject({ output: { sessionId: 'replacement' } })
    const originalTask = f.repository.get('task')!
    f.repository.create({ ...originalTask, id: 'other-task', threadId: 'other-thread', activeTurnId: 'other-turn' })
    const other: ToolHostContext = { ...f.context, abortSignal: otherAbort.signal, threadId: 'other-thread', turnId: 'other-turn',
      executionGrant: { ...f.context.executionGrant!, id: 'other-grant', taskId: 'other-task', threadId: 'other-thread', turnId: 'other-turn' } }
    expect(await provider.tools.find(tool => tool.name === 'browser_session_start')!.execute({}, other)).toMatchObject({ output: { sessionId: 'other-session' } })
    expect(await provider.tools.find(tool => tool.name === 'browser_observe')!.execute({ sessionId: 'session-one' }, resumed))
      .toMatchObject({ isError: true, output: { code: 'browser_session_not_owned' } })
    const stop = vi.spyOn(f.runtime, 'stopThread').mockResolvedValue()
    oldAbort.abort()
    expect(stop).not.toHaveBeenCalled()
    nextAbort.abort()
    expect(stop.mock.calls).toEqual([['thread']])
    otherAbort.abort()
    expect(stop.mock.calls).toEqual([['thread'], ['other-thread']])
    expect(f.repository.operations('other-task', 'browser_session_retirement')).toHaveLength(0)
  })

  it('retains the per-task in-flight queue through same-config diagnostic refresh', async () => {
    const f = fixture()
    await f.execute('browser_session_start')
    const original = f.runner.getMockImplementation()!
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    f.runner.mockImplementation(async (config, args, signal) => {
      if (args[0] === 'navigate') await waiting
      return original(config, args, signal)
    })
    const navigation = f.execute('browser_navigate', { sessionId: 'session-one', url: 'https://example.com/search' })
    await expect.poll(() => f.runner.mock.calls.some(([, args]) => args[0] === 'navigate')).toBe(true)
    await f.refresh({ ...f.config, checkedAt: new Date().toISOString() })
    const read = f.execute('browser_get_html', { sessionId: 'session-one' })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.runner.mock.calls.some(([, args]) => args[0] === 'get-html')).toBe(false)
    release()
    expect(await navigation).toMatchObject({ item: { output: { status: 'succeeded' } } })
    expect(await read).toMatchObject({ item: { output: { status: 'succeeded' } } })
    expect(f.apply).not.toHaveBeenCalled()
  })

  it('rejects late work and queued calls from a provider replaced during a read', async () => {
    const f = fixture()
    await f.prepare()
    const original = f.runner.getMockImplementation()!
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    f.runner.mockImplementation(async (config, args, signal) => {
      if (args[0] === 'get-html') await waiting
      return original(config, args, signal)
    })
    const read = f.execute('browser_get_html', { sessionId: 'session-one' })
    await expect.poll(() => f.runner.mock.calls.some(([, args]) => args[0] === 'get-html')).toBe(true)
    const observations = f.runner.mock.calls.filter(([, args]) => args[0] === 'cooperate').length
    const queued = f.execute('browser_observe', { sessionId: 'session-one' })
    await f.refresh({ ...f.config, executableHash: 'b'.repeat(64) })
    release()
    expect(await read).toMatchObject({ item: { isError: true, output: { code: 'browser_binding_changed' } } })
    expect(await queued).toMatchObject({ item: { isError: true, output: { code: 'browser_binding_changed' } } })
    expect(f.runner.mock.calls.filter(([, args]) => args[0] === 'cooperate')).toHaveLength(observations)
  })

  it.each([
    ['revision', { revision: 2 }], ['instance', { browserInstanceId: 'browser-other' }],
    ['CLI path', { executablePath: '/different/bsk' }], ['CLI digest', { executableHash: 'b'.repeat(64) }],
    ['CLI home', { homeDirectory: '/different/browser-home' }], ['interaction', { interaction: 'observe' }],
    ['origins', { origins: ['https://second.example'] }], ['disabled', { enabled: false }],
    ['unavailable', { state: 'needs_extension' }], ['protocol', { daemonProtocolVersion: '2.0' }]
  ] as Array<[string, Partial<BrowserCapabilityConfig>]>)('invalidates old provider and Grant on changed %s before CLI dispatch', async (_name, patch) => {
    const f = fixture()
    await f.prepare()
    const previous = f.runtime.provider()
    const before = f.runner.mock.calls.length
    await f.refresh({ ...f.config, ...patch })
    expect(f.runtime.provider()).not.toBe(previous)
    expect(f.apply).toHaveBeenCalledOnce()
    const args = { sessionId: 'session-one', contextId: 'context-one', target: '@e1', value: '轨道监测' }
    expect(await previous.tools.find(tool => tool.name === 'browser_fill')!.execute(args, f.context))
      .toMatchObject({ isError: true, output: { code: 'browser_binding_changed' } })
    if (patch.enabled === false || patch.state === 'needs_extension') await expect(f.execute('browser_fill', args)).rejects.toThrow('not advertised')
    else expect((await f.execute('browser_fill', args)).item).toMatchObject({ isError: true })
    expect(f.runner).toHaveBeenCalledTimes(before)
    expect(f.approvals).not.toHaveBeenCalled()
  })

  it('retries a failed registry replacement without reviving the old provider', async () => {
    const f = fixture()
    const previous = f.runtime.provider()
    f.apply.mockImplementationOnce(() => { throw new Error('Synthetic registry failure') })
    const changed = { ...f.config, revision: 2 }
    await expect(f.refresh(changed)).rejects.toThrow('Synthetic registry failure')
    expect(await previous.tools.find(tool => tool.name === 'browser_session_start')!.execute({}, f.context)).toMatchObject({ isError: true, output: { code: 'browser_binding_changed' } })
    await f.refresh(changed)
    expect(f.apply).toHaveBeenCalledTimes(2)
    await f.refresh(changed)
    expect(f.apply).toHaveBeenCalledTimes(2)
  })
})
