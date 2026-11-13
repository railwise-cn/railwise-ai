import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserCapabilityConfig } from '../contracts/browser-skill.js'
import { TaskRunSchema } from '../contracts/tasks.js'
import type { ThreadRecord } from '../contracts/threads.js'
import { TaskRunRepository } from './task-run-repository.js'
import { ManagedBrowserSkillRuntime } from './managed-browser-skill-runtime.js'
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(fn => fn()))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-binding-'))
  const repository = new TaskRunRepository(join(root, 'tasks.sqlite'))
  cleanups.push(() => { repository.close(); rmSync(root, { recursive: true, force: true }) })
  const config = BrowserCapabilityConfig.parse({ enabled: true, state: 'ready', browserInstanceId: 'browser-new', revision: 3, origins: ['https://example.com', 'https://new.example'], interaction: 'interact' })
  const old = { browserInstanceId: 'browser-old', revision: 1, origins: ['https://example.com'], interaction: 'observe' as const }
  repository.create(TaskRunSchema.parse({ id: 'task', threadId: 'thread', childTaskIds: [], workspaceRoot: root, goal: '浏览器 https://example.com', status: 'waiting_user', agentId: 'default', acceptance: { kind: 'answer', requiredNodeKinds: [], requireFinalResponse: true, requireActionableArtifactCard: false }, budget: { maxAttempts: 3, maxDurationMs: 600000 }, attempts: 0, replans: 0, noProgressCount: 0, nodes: [], artifacts: [], revision: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), authority: { source: 'user', workspaceRoot: root, grantedAt: new Date().toISOString(), browserScope: old } }))
  const runtime = new ManagedBrowserSkillRuntime({ config, configPath: join(root, 'config.json'), dataDir: root, repository, run: async () => ({ ok: true, output: { protocol_version: '1.7', pid: 7, browsers: [{ instance_id: 'browser-new', browser_name: 'Chrome', label: 'Test', extension_version: '0.4.0', extension_protocol_version: '1.7' }] } }), apply: () => undefined })
  return { runtime, repository, old, config }
}
describe('Browser task authority rebinding', () => {
  it.each(['browser-skill', 'broswer-skill', 'browse skill'])('preflights the requested %s capability before a model Turn', async spelling => {
    const f = fixture()
    expect(await f.runtime.preflight(`使用${spelling}，帮我读取 https://example.com`)).toMatchObject({ status: 'available', toolId: 'browser-skill' })
    expect(await f.runtime.preflight(`如何使用${spelling}`)).toBeNull()
  })
  it('accepts the real General wildcard and blocks a changed browser pending explicit task confirmation', async () => {
    const f = fixture()
    const thread = { id: 'thread', mode: 'agent', agentProfile: { toolAllowlist: ['*'] } } as ThreadRecord
    expect(await f.runtime.preflight('继续', thread)).toMatchObject({ errorCode: 'browser_binding_changed', status: 'needs_authorization',
      workspaceRoot: f.repository.get('task')!.workspaceRoot })
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(snapshot.origins).toEqual(['https://example.com'])
    const input = { confirmed: true as const, expectedTaskRevision: snapshot.taskRevision, expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, idempotencyKey: 'explicit-browser-review' }
    expect(f.runtime.confirmBinding('task', input).resumed).toBe(false)
    expect(f.runtime.confirmBinding('task', input).resumed).toBe(false)
    expect(f.repository.get('task')?.status).toBe('waiting_user')
    expect(f.repository.get('task')?.authority?.browserScope).toEqual({ browserInstanceId: 'browser-new', revision: 3, origins: ['https://example.com'], interaction: 'observe' })
    expect((await f.runtime.preflight('浏览器 https://example.com', thread))?.status).toBe('available')
  })
  it('uses the initiating workspace before a browser task has been created', async () => {
    const f = fixture()
    const thread = { id: 'new-thread', workspace: '/workspace/selected-project', mode: 'agent', agentProfile: { toolAllowlist: ['*'] } } as ThreadRecord
    expect(await f.runtime.preflight('使用browser-skill读取 https://example.com', thread)).toMatchObject({ status: 'available', workspaceRoot: thread.workspace })
  })
  it('requires explicit binding for an existing unbound waiting task after the browser is configured', async () => {
    const f = fixture()
    f.repository.update('task', 0, task => ({ ...task, authority: undefined }))
    const thread = { id: 'thread', workspace: '/different-chat-workspace', mode: 'agent', agentProfile: { toolAllowlist: ['*'] } } as ThreadRecord
    expect(await f.runtime.preflight('使用browser-skill读取 https://example.com', thread)).toMatchObject({
      status: 'needs_authorization', errorCode: 'browser_task_scope_required', workspaceRoot: f.repository.get('task')!.workspaceRoot,
      resolution: { kind: 'grant', route: 'task/browser-binding' }
    })
    expect(f.repository.get('task')!.authority?.browserScope).toBeUndefined()
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(snapshot).toMatchObject({ origins: ['https://example.com'], previousBrowserInstanceId: undefined })
    expect(f.runtime.confirmBinding('task', { ...snapshot, confirmed: true, expectedTaskRevision: snapshot.taskRevision,
      expectedBrowserRevision: snapshot.browserRevision, idempotencyKey: 'first-reviewed-binding' }).resumed).toBe(false)
    expect(f.repository.get('task')!.status).toBe('waiting_user')
    expect((await f.runtime.preflight('继续', thread))?.status).toBe('available')
  })
  it('never widens inherited origins from changed global config, prompt or network defaults', () => {
    const f = fixture()
    expect(f.runtime.scope('浏览器 https://new.example', f.old, ['*', 'https://other.example']).browserScope).toEqual(f.old)
  })
  it('offers configured sites for explicit first binding when an unbound task did not name a URL', () => {
    const f = fixture()
    f.repository.update('task', 0, task => ({ ...task, goal: '用browser-skill查询公开采购公告', authority: undefined }))
    expect(f.runtime.bindingSnapshot('task').origins).toEqual(f.config.origins)
    expect(f.repository.get('task')!.authority?.browserScope).toBeUndefined()
  })
  it('rejects stale reviewed revisions and active tasks without changing authority', () => {
    const f = fixture()
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(() => f.runtime.confirmBinding('task', { confirmed: true, expectedTaskRevision: 99, expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, idempotencyKey: 'stale' })).toThrow('browser_binding_changed')
    f.repository.update('task', 0, task => ({ ...task, status: 'running' }))
    expect(() => f.runtime.bindingSnapshot('task')).toThrow('browser_task_not_waiting')
    expect(f.repository.get('task')?.authority?.browserScope).toEqual(f.old)
  })
  it('widens a root task interaction only after explicit reviewed confirmation and preserves origins', () => {
    const f = fixture()
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(snapshot).toMatchObject({ interaction: 'interact', previousInteraction: 'observe' })
    expect(f.repository.get('task')?.authority?.browserScope).toEqual(f.old)
    const input = { confirmed: true as const, expectedTaskRevision: snapshot.taskRevision, expectedBrowserRevision: snapshot.browserRevision,
      browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins, interaction: 'interact' as const, idempotencyKey: 'widen-review' }
    expect(f.runtime.confirmBinding('task', input).binding.interaction).toBe('interact')
    expect(f.runtime.confirmBinding('task', input).binding.interaction).toBe('interact')
    expect(f.repository.get('task')?.authority?.browserScope).toMatchObject({ interaction: 'interact', origins: f.old.origins })
    expect(f.repository.get('task')?.status).toBe('waiting_user')
    expect(() => f.runtime.confirmBinding('task', { ...input, interaction: 'observe' })).toThrow()
  })
  it('keeps a child within its current parent browser authority', () => {
    const f = fixture()
    const original = f.repository.get('task')!
    f.repository.create({ ...original, id: 'parent', threadId: 'parent-thread', authority: { ...original.authority!, browserScope: {
      ...f.old, browserInstanceId: 'browser-new', revision: 3
    } } })
    f.repository.update('task', 0, task => ({ ...task, parentTaskId: 'parent' }))
    const snapshot = f.runtime.bindingSnapshot('task')
    expect(snapshot.interaction).toBe('observe')
    expect(() => f.runtime.confirmBinding('task', { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
      expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins,
      interaction: 'interact', idempotencyKey: 'child-widen' })).toThrow('browser_interaction_scope_required')
    expect(f.repository.get('task')?.authority?.browserScope).toEqual(f.old)
  })
  it('does not rebind a paused task held by another live Runtime lease', () => {
    const f = fixture()
    f.repository.acquireLease('task', 'other-runtime', new Date().toISOString(), new Date(Date.now() + 60000).toISOString())
    expect(() => f.runtime.bindingSnapshot('task')).toThrow('browser_task_not_waiting')
  })
  it('limits first binding of a child without a URL to the parent and current configuration intersection', () => {
    const f = fixture()
    const original = f.repository.get('task')!
    f.repository.create({ ...original, id: 'parent', threadId: 'parent-thread', authority: { ...original.authority!, browserScope: {
      ...f.old, browserInstanceId: 'browser-new', revision: 3
    } } })
    f.repository.update('task', 0, task => ({ ...task, parentTaskId: 'parent', goal: '用browser-skill查询公开采购公告', authority: undefined }))
    expect(f.runtime.bindingSnapshot('task')).toMatchObject({ origins: ['https://example.com'], interaction: 'observe' })
    expect(f.repository.get('task')!.authority?.browserScope).toBeUndefined()
    f.repository.update('parent', 0, task => ({ ...task, authority: { ...task.authority!, revokedAt: new Date().toISOString() } }))
    expect(() => f.runtime.bindingSnapshot('task')).toThrow('browser_parent_scope_blocked')
  })

})
