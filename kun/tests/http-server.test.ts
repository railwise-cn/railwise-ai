import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchRequest } from '../src/server/http-server.js'
import { createApprovalRequest } from '../src/domain/approval.js'
import { makeAssistantTextItem, makeToolCallItem, makeToolResultItem } from '../src/domain/item.js'
import { encodeSseEvent } from '../src/server/sse.js'
import { buildHarness, readJson, readSseEvents, usageSnapshot } from './http-server-test-harness.js'
import { WORKWISE_RUNTIME_PROTOCOL_VERSION } from '../src/contracts/runtime-protocol.js'
import type { TurnItem } from '../src/contracts/items.js'
import { fingerprintDshUiBlock } from '../src/contracts/dsh-ui.js'
import { RUNTIME_RESOURCE_LIMITS_V1 } from '../src/contracts/resource-limits.js'
import { SkillRuntime } from '../src/skills/skill-runtime.js'

describe('HTTP server', () => {
  let dataDir = ''
  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'kun-http-'))
  })
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('returns 200 on /health without auth', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(h.router, new Request('http://localhost/health'))
    expect(response.status).toBe(200)
    const body = await readJson(response)
    expect(body).toEqual({
      status: 'ok',
      service: 'kun',
      mode: 'serve',
      protocolVersion: WORKWISE_RUNTIME_PROTOCOL_VERSION
    })
  })

  it('returns runtime info with disabled capability defaults', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/runtime/info', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = await readJson(response) as {
      model?: string
      capabilities?: {
        contractVersion?: number
        mcp?: { available?: boolean; reason?: string }
        web?: { available?: boolean; fetch?: { available?: boolean } }
        attachments?: { available?: boolean; allowedMimeTypes?: string[] }
        cli?: { serve?: { available?: boolean }; run?: { available?: boolean; reason?: string } }
        model?: { inputModalities?: string[]; supportsToolCalling?: boolean; contextWindowTokens?: number }
      }
    }
    expect(body.model).toBe('deepseek-chat')
    expect(body.capabilities?.contractVersion).toBe(1)
    expect(body.capabilities?.model?.inputModalities).toContain('text')
    expect(body.capabilities?.model?.supportsToolCalling).toBe(true)
    expect(body.capabilities?.model?.contextWindowTokens).toBe(1_000_000)
    expect(body.capabilities?.mcp?.available).toBe(false)
    expect(body.capabilities?.mcp?.reason).toMatch(/disabled/)
    expect(body.capabilities?.web?.fetch?.available).toBe(false)
    expect(body.capabilities?.attachments?.allowedMimeTypes).toContain('image/png')
    expect(body.capabilities?.cli?.serve?.available).toBe(true)
    expect(body.capabilities?.cli?.run?.available).toBe(false)
  })

  it('starts validated UI actions through the authenticated route and replays their audit event', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_ui_route', title: 'UI route' }
    )
    const { turnId } = await h.turnService.startTurn({
      threadId: 'thr_ui_route',
      request: { prompt: 'Show controls' }
    })
    const uiBlocks = [{
      id: 'card',
      root: {
        id: 'button',
        type: 'button' as const,
        label: 'Apply',
        actionId: 'apply'
      }
    }]
    await h.turnService.applyItem(
      'thr_ui_route',
      makeAssistantTextItem({
        id: 'item_ui_route_card',
        turnId,
        threadId: 'thr_ui_route',
        text: 'Apply the change.',
        uiBlocks,
        status: 'completed'
      })
    )
    await h.turnService.finishTurn({ threadId: 'thr_ui_route', turnId, status: 'completed' })

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_ui_route/ui-actions', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          messageId: 'item_ui_route_card',
          blockId: 'card',
          actionId: 'apply',
          specFingerprint: fingerprintDshUiBlock(uiBlocks[0]!),
          idempotencyKey: 'ui-route-1'
        })
      })
    )

    expect(response.status).toBe(202)
    const body = await readJson(response) as { turnId: string; uiActionItemId: string }
    expect(body.turnId).toBeTruthy()
    expect(body.uiActionItemId).toBeTruthy()
    const events = await h.sessionStore.loadEventsSince('thr_ui_route', 0)
    expect(events.some((event) => event.kind === 'ui_action')).toBe(true)

    const genericConflict = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_ui_route/turns', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'must not reuse a UI action key', idempotencyKey: 'ui-route-1' })
      })
    )
    expect(genericConflict.status).toBe(409)
    expect(await readJson(genericConflict)).toMatchObject({ code: 'conflict' })

    const staleAction = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_ui_route/ui-actions', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          messageId: 'item_ui_route_card',
          blockId: 'card',
          actionId: 'apply',
          specFingerprint: '0'.repeat(16),
          idempotencyKey: 'ui-route-stale'
        })
      })
    )
    expect(staleAction.status).toBe(409)
    expect(await readJson(staleAction)).toMatchObject({ code: 'stale_request' })

    const consumedAction = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_ui_route/ui-actions', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          messageId: 'item_ui_route_card',
          blockId: 'card',
          actionId: 'apply',
          specFingerprint: fingerprintDshUiBlock(uiBlocks[0]!),
          idempotencyKey: 'ui-route-second-click'
        })
      })
    )
    expect(consumedAction.status).toBe(409)
    expect(await readJson(consumedAction)).toMatchObject({ code: 'conflict' })
  })

  it('requires auth for runtime info', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/runtime/info')
    )

    expect(response.status).toBe(401)
  })

  it('returns structured validation errors for invalid JSON bodies', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: '{'
      })
    )

    expect(response.status).toBe(400)
    expect(await readJson(response)).toMatchObject({
      code: 'validation_error',
      message: 'invalid JSON body'
    })
  })

  it('returns runtime tool diagnostics', async () => {
    const h = buildHarness()
    h.runtime.toolDiagnostics = () => ({
      providers: [
        {
          id: 'mcp:github',
          kind: 'mcp',
          enabled: true,
          available: false,
          reason: 'token=provider-secret'
        }
      ],
      mcpServers: [
        {
          id: 'github',
          enabled: true,
          transport: 'stdio',
          trustScope: 'user',
          available: false,
          status: 'error',
          toolCount: 0,
          lastError: 'Authorization: Bearer server-secret'
        }
      ],
      webProviders: [],
      skills: {
        enabled: false,
        roots: [],
        skills: [],
        validationErrors: [],
        lastActivations: []
      },
      attachments: {
        enabled: false,
        rootDir: '',
        count: 0,
        totalBytes: 0
      },
      memory: {
        enabled: false,
        rootDir: '',
        activeCount: 0,
        tombstoneCount: 0,
        lastInjectedIds: []
      }
    })
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/runtime/tools', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = await readJson(response) as {
      providers: Array<{ id: string; reason?: string }>
      mcpServers: Array<{ id: string; lastError?: string }>
      webProviders: unknown[]
      skills: unknown
      attachments: unknown
      memory: unknown
    }
    expect(body.providers[0]).toMatchObject({ id: 'mcp:github', reason: 'token=<redacted>' })
    expect(body.mcpServers[0]).toMatchObject({
      id: 'github',
      lastError: 'Authorization=<redacted>'
    })
    expect(JSON.stringify(body)).not.toContain('provider-secret')
    expect(JSON.stringify(body)).not.toContain('server-secret')
  })

  it('requires auth for runtime tool diagnostics', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/runtime/tools')
    )

    expect(response.status).toBe(401)
  })

  it('lists discovered skills through the HTTP layer', async () => {
    const h = buildHarness()
    h.runtime.skills = () => ({
      enabled: true,
      roots: ['/tmp/skills'],
      skills: [
        {
          id: 'review',
          name: 'Review',
          description: 'Review the current change',
          version: '1.0.0',
          root: '/tmp/skills/review',
          legacy: false,
          triggers: { commands: ['/review'], promptPatterns: [], fileTypes: [] },
          allowedTools: ['read']
        }
      ],
      validationErrors: [],
      lastActivations: []
    })

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/skills', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = await readJson(response) as { skills: Array<{ id: string; description?: string }> }
    expect(body.skills[0]).toMatchObject({
      id: 'review',
      description: 'Review the current change'
    })
  })

  it('uses the actual thread workspace for the picker and rejects a removed skill before admitting a turn', async () => {
    const skillPath = join(dataDir, '.agents', 'skills', 'file-review')
    await mkdir(skillPath, { recursive: true })
    await writeFile(join(skillPath, 'SKILL.md'), '---\nname: 审阅文件\n---\nReview a document.\n')
    const skillRuntime = await SkillRuntime.create({ enabled: true, roots: [], legacySkillMd: true })
    const h = buildHarness({ skillRuntime })
    const threadId = 'thr_slash_skill'
    await h.threadService.create({ workspace: dataDir, model: 'fake', mode: 'agent' }, { id: threadId })
    const headers = { authorization: 'Bearer tok-1' }
    const catalog = await dispatchRequest(h.router, new Request(
      `http://localhost/v1/skills?scope=available&threadId=${threadId}&workspace=/tmp/unrelated`,
      { headers }
    ))
    expect(await readJson(catalog)).toMatchObject({
      scope: 'available',
      skills: [expect.objectContaining({ id: 'file-review', name: '审阅文件', scope: 'project' })]
    })
    await rm(skillPath, { recursive: true })
    const rejected = await dispatchRequest(h.router, new Request(`http://localhost/v1/threads/${threadId}/turns`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'Managed instructions\n/skill:file-review 审阅', displayText: '/skill:file-review 审阅' })
    }))
    expect(rejected.status).toBe(409)
    expect(await readJson(rejected)).toMatchObject({ code: 'skill_unavailable' })
    expect((await h.threadService.get(threadId))?.turns).toEqual([])
  })

  it('returns the real user message item id when starting a turn', async () => {
    const h = buildHarness()
    await h.threadService.create({
      workspace: '/tmp',
      model: 'deepseek-chat',
      mode: 'agent',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write'
    }, { id: 'thr_1', title: 'demo' })

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_1/turns', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' })
      })
    )

    expect(response.status).toBe(202)
    const body = await readJson(response) as { turnId: string; userMessageItemId: string }
    expect(body.turnId).toMatch(/^turn_/)
    expect(body.userMessageItemId).toBe(`item_${body.turnId}_user`)
  })

  it('searches only the authoritative thread workspace and persists bounded references', async () => {
    const h = buildHarness()
    await writeFile(join(dataDir, '报价 表.md'), 'PRIVATE-FILE-BODY')
    await h.threadService.create({
      workspace: dataDir,
      model: 'deepseek-chat',
      mode: 'agent',
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write'
    }, { id: 'thr_workspace', title: 'workspace' })

    const searchResponse = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_workspace/workspace/references/search', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ query: '报价', limit: 10 })
      })
    )
    expect(searchResponse.status).toBe(200)
    expect(await readJson(searchResponse)).toMatchObject({
      entries: [{ path: '报价 表.md', name: '报价 表.md', kind: 'file', depth: 1 }],
      truncated: false
    })

    const startResponse = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_workspace/turns', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Review the referenced file.',
          workspaceReferences: [{ path: '报价 表.md', kind: 'file' }]
        })
      })
    )
    expect(startResponse.status).toBe(202)
    const started = await readJson(startResponse) as { turnId: string }
    const turn = await h.turnService.getTurn('thr_workspace', started.turnId)
    expect(turn?.prompt).toBe('Review the referenced file.')
    expect(turn?.prompt).not.toContain('PRIVATE-FILE-BODY')
    expect(turn?.workspaceReferences).toEqual([{ path: '报价 表.md', kind: 'file' }])
    expect(turn?.items[0]).toMatchObject({
      kind: 'user_message',
      workspaceReferences: [{ path: '报价 表.md', kind: 'file' }]
    })
  })

  it('searches a validated workspace before a thread exists', async () => {
    const h = buildHarness()
    await mkdir(join(dataDir, '资料 目录'))
    await writeFile(join(dataDir, '资料 目录', '报价 表.md'), 'PRIVATE-WORKSPACE-BODY')
    await symlink(join(dataDir, '资料 目录'), join(dataDir, 'linked-directory'))

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/workspace/references/search', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceRoot: dataDir, query: '资料', limit: 20 })
      })
    )

    expect(response.status).toBe(200)
    expect(await readJson(response)).toMatchObject({
      entries: expect.arrayContaining([
        { path: '资料 目录', name: '资料 目录', kind: 'directory', depth: 1 }
      ]),
      truncated: false,
      indexedAt: expect.any(String)
    })
    const body = await readJson(await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/workspace/references/search', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceRoot: dataDir, query: '', limit: 20 })
      })
    )) as { entries: Array<{ path: string }> }
    expect(body.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '资料 目录' }),
      expect.objectContaining({ path: '资料 目录/报价 表.md' })
    ]))
    expect(body.entries.some((entry) => entry.path === 'linked-directory')).toBe(false)
  })

  it('rejects missing and invalid roots for workspace-scoped reference search', async () => {
    const h = buildHarness()
    const request = (body: unknown) => dispatchRequest(
      h.router,
      new Request('http://localhost/v1/workspace/references/search', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    )

    await expect(request({ query: '' }).then((response) => response.status)).resolves.toBe(400)
    await expect(request({ workspaceRoot: join(dataDir, 'missing'), query: '' })
      .then((response) => response.status)).resolves.toBe(400)
  })

  it('rejects invalid workspace reference search limits and unknown threads', async () => {
    const h = buildHarness()
    const invalid = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/missing/workspace/references/search', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ query: '', limit: 51 })
      })
    )
    expect(invalid.status).toBe(400)

    const missing = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/missing/workspace/references/search', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ query: '', limit: 10 })
      })
    )
    expect(missing.status).toBe(404)
  })

  it('applies per-turn execution policy to the active thread', async () => {
    const h = buildHarness()
    await h.threadService.create({
      workspace: '/tmp',
      model: 'deepseek-chat',
      mode: 'agent',
      approvalPolicy: 'auto',
      sandboxMode: 'danger-full-access'
    }, { id: 'thr_policy', title: 'policy' })

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_policy/turns', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'inspect only',
          approvalPolicy: 'on-request',
          sandboxMode: 'read-only'
        })
      })
    )

    expect(response.status).toBe(202)
    const thread = await h.threadService.get('thr_policy')
    expect(thread?.approvalPolicy).toBe('on-request')
    expect(thread?.sandboxMode).toBe('read-only')
  })

  it('creates and lists threads through the HTTP layer', async () => {
    const h = buildHarness()
    const create = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: '/tmp', model: 'deepseek-chat' })
      })
    )
    expect(create.status).toBe(201)
    const created = (await readJson(create)) as { id: string }
    const list = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const listed = (await readJson(list)) as { threads: { id: string }[] }
    expect(listed.threads.map((t) => t.id)).toContain(created.id)
  })

  it('sets, reads, and clears thread goals through the HTTP layer', async () => {
    const h = buildHarness()
    await h.threadService.create({
      workspace: '/tmp',
      model: 'deepseek-chat',
      mode: 'agent'
    }, { id: 'thr_goal', title: 'Goal' })

    const setGoal = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_goal/goal', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ objective: 'ship goal mode', status: 'active' })
      })
    )
    expect(setGoal.status).toBe(200)
    const setBody = await readJson(setGoal) as { goal?: { objective?: string; status?: string } }
    expect(setBody.goal).toMatchObject({ objective: 'ship goal mode', status: 'active' })

    const readGoal = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_goal/goal', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(readGoal.status).toBe(200)
    const readBody = await readJson(readGoal) as { goal?: { objective?: string } | null }
    expect(readBody.goal?.objective).toBe('ship goal mode')

    const clearGoal = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_goal/goal', {
        method: 'DELETE',
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(clearGoal.status).toBe(200)
    expect(await readJson(clearGoal)).toEqual({ cleared: true })
  })

  it('sets, reads, and clears thread todos through the HTTP layer', async () => {
    const h = buildHarness()
    await h.threadService.create({
      workspace: '/tmp',
      model: 'deepseek-chat',
      mode: 'agent'
    }, { id: 'thr_todos', title: 'Todos' })

    const setTodos = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_todos/todos', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          todos: [
            { content: 'Wire API', status: 'completed' },
            { content: 'Render panel', status: 'pending' }
          ]
        })
      })
    )
    expect(setTodos.status).toBe(200)
    const setBody = await readJson(setTodos) as { todos?: { items?: Array<{ content?: string; status?: string }> } }
    expect(setBody.todos?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'Wire API', status: 'completed' })
    ]))

    const readTodos = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_todos/todos', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(readTodos.status).toBe(200)
    const readBody = await readJson(readTodos) as { todos?: { items?: Array<{ content?: string }> } | null }
    expect(readBody.todos?.items?.[0]?.content).toBe('Wire API')

    const clearTodos = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_todos/todos', {
        method: 'DELETE',
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(clearTodos.status).toBe(200)
    expect(await readJson(clearTodos)).toEqual({ cleared: true })
  })

  it('filters thread lists for search, archives, and limits', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/alpha', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_alpha', title: 'Alpha Project' }
    )
    await h.threadService.create(
      { workspace: '/tmp/beta', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_beta', title: 'Beta Archive' }
    )
    await h.threadService.update('thr_beta', { status: 'archived' })

    const active = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(active.status).toBe(200)
    const activeBody = (await readJson(active)) as {
      threads: Array<{ id: string; messageCount?: number; preview?: string }>
    }
    expect(activeBody.threads.map((thread) => thread.id)).toEqual(['thr_alpha'])
    expect(activeBody.threads[0]).toMatchObject({ messageCount: 0, preview: '' })

    const archived = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads?archived_only=true', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const archivedBody = (await readJson(archived)) as { threads: Array<{ id: string }> }
    expect(archivedBody.threads.map((thread) => thread.id)).toEqual(['thr_beta'])

    const search = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads?include_archived=true&search=archive', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const searchBody = (await readJson(search)) as { threads: Array<{ id: string }> }
    expect(searchBody.threads.map((thread) => thread.id)).toEqual(['thr_beta'])

    const limited = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads?include_archived=true&limit=1', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const limitedBody = (await readJson(limited)) as { threads: Array<{ id: string }> }
    expect(limitedBody.threads).toHaveLength(1)
  })

  it('idempotently reuses the primary Engineering thread for one workspace and project', async () => {
    const h = buildHarness()
    const request = (): Promise<Response> => dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace: '/tmp/survey-project',
          model: 'deepseek-chat',
          mode: 'agent',
          domain: 'engineering',
          projectId: 'project-survey-1',
          title: '工程测量 AI · 重启恢复'
        })
      })
    )

    const [firstResponse, replayResponse] = await Promise.all([request(), request()])
    const first = await readJson(firstResponse) as { id: string }
    const replay = await readJson(replayResponse) as { id: string }

    expect(firstResponse.status).toBe(201)
    expect(replayResponse.status).toBe(200)
    expect(replay.id).toBe(first.id)

    const listed = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads?domain=engineering&project_id=project-survey-1&include_archived=true', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const body = await readJson(listed) as { threads: Array<{ id: string }> }
    expect(body.threads).toEqual([expect.objectContaining({ id: first.id })])
  })

  it('deletes threads through the HTTP layer', async () => {
    const h = buildHarness()
    const create = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: '/tmp/delete-me', model: 'deepseek-chat' })
      })
    )
    expect(create.status).toBe(201)
    const created = (await readJson(create)) as { id: string }

    const deleted = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${created.id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(deleted.status).toBe(200)
    expect(await readJson(deleted)).toEqual({ id: created.id, deleted: true })

    const list = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads?include_archived=true', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const listed = (await readJson(list)) as { threads: Array<{ id: string }> }
    expect(listed.threads.map((thread) => thread.id)).not.toContain(created.id)

    const detail = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${created.id}`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(detail.status).toBe(404)
  })

  it('returns 404 when deleting a missing thread', async () => {
    const h = buildHarness()
    const deleted = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/missing-thread', {
        method: 'DELETE',
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(deleted.status).toBe(404)
    expect(await readJson(deleted)).toMatchObject({
      code: 'not_found',
      message: 'thread not found: missing-thread'
    })
  })

  it('rejects invalid thread creation bodies with 400', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: '', model: '' })
      })
    )
    expect(response.status).toBe(400)
  })

  it('starts a turn and serves the SSE backlog', async () => {
    const h = buildHarness()
    const create = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: '/tmp', model: 'deepseek-chat' })
      })
    )
    const thread = (await readJson(create)) as { id: string }
    const turn = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/turns`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' })
      })
    )
    expect(turn.status).toBe(202)
    const turnBody = (await readJson(turn)) as { threadId: string; turnId: string }
    expect(turnBody.threadId).toBe(thread.id)
    const detail = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const detailBody = (await readJson(detail)) as {
      latestSeq: number
      turns: Array<{ items: Array<{ kind: string }> }>
    }
    expect(detailBody.latestSeq).toBeGreaterThan(0)
    expect(detailBody.turns.at(-1)?.items.some((item) => item.kind === 'user_message')).toBe(true)
    const eventStream = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/events?since_seq=0`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const events = await readSseEvents(eventStream)
    const kinds = events.flatMap((frame) =>
      frame
        .split('\n')
        .filter((line) => line.startsWith('event:'))
        .map((line) => line.slice(7))
    )
    expect(kinds).toContain('turn_started')
  })

  it('hydrates thread detail items from the session log when the thread snapshot lags', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_lag', title: 'Lagging snapshot' }
    )
    const { turnId } = await h.turnService.startTurn({
      threadId: 'thr_lag',
      request: { prompt: 'hi' }
    })
    await h.sessionStore.appendItem('thr_lag', makeAssistantTextItem({
      id: 'item_answer',
      turnId,
      threadId: 'thr_lag',
      text: 'hello after reload',
      status: 'completed'
    }))
    const snapshot = await h.threadService.get('thr_lag')
    expect(snapshot?.turns.at(-1)?.items.map((item) => item.kind)).toEqual(['user_message'])

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_lag', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = (await readJson(response)) as {
      turns: Array<{ items: Array<{ kind: string; text?: string }> }>
    }
    expect(body.turns.at(-1)?.items.map((item) => item.kind)).toEqual(['user_message', 'assistant_text'])
    expect(body.turns.at(-1)?.items.at(-1)).toMatchObject({
      kind: 'assistant_text',
      text: 'hello after reload'
    })
  })

  it('never persists or returns raw tool-call arguments from the Runtime boundary', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_private_args', title: 'Private args' }
    )
    const { turnId } = await h.turnService.startTurn({
      threadId: 'thr_private_args',
      request: { prompt: 'run a private tool' }
    })
    await h.turnService.applyItem(
      'thr_private_args',
      makeToolCallItem({
        id: 'item_private_args',
        turnId,
        threadId: 'thr_private_args',
        callId: 'call_private_args',
        toolName: 'private_tool',
        arguments: { token: 'runtime-boundary-secret' }
      })
    )

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_private_args', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const body = await readJson(response)
    const events = await h.sessionStore.loadEventsSince('thr_private_args', 0)
    const items = await h.sessionStore.loadItems('thr_private_args')

    expect(response.status).toBe(200)
    expect(JSON.stringify(body)).not.toContain('runtime-boundary-secret')
    expect(JSON.stringify(events)).not.toContain('runtime-boundary-secret')
    expect(JSON.stringify(items)).not.toContain('runtime-boundary-secret')
  })

  it('heals stale open session items for finished turns when loading thread detail', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_heal', title: 'Stale session' }
    )
    const { turnId } = await h.turnService.startTurn({
      threadId: 'thr_heal',
      request: { prompt: 'run a tool' }
    })
    await h.turnService.applyItem(
      'thr_heal',
      makeToolCallItem({
        id: 'item_tool_stale',
        turnId,
        threadId: 'thr_heal',
        callId: 'call_stale',
        toolName: 'echo',
        arguments: { text: 'hi' }
      })
    )
    await h.turnService.applyItem(
      'thr_heal',
      makeToolResultItem({
        id: 'item_result_stale',
        turnId,
        threadId: 'thr_heal',
        callId: 'call_stale',
        toolName: 'echo',
        output: { partial: true },
        status: 'running'
      })
    )
    const staleThread = await h.threadStore.get('thr_heal')
    if (!staleThread) throw new Error('expected thread')
    const finishedAt = '2026-06-05T00:00:00.000Z'
    await h.threadStore.upsert({
      ...staleThread,
      status: 'idle',
      turns: staleThread.turns.map((turn) =>
        turn.id === turnId
          ? {
              ...turn,
              status: 'aborted',
              finishedAt,
              items: turn.items.map((item): TurnItem =>
                item.id === 'item_tool_stale' || item.id === 'item_result_stale'
                  ? ({ ...item, status: 'aborted', finishedAt } as TurnItem)
                  : item
              )
            }
          : turn
      )
    })
    const staleById = new Map((await h.sessionStore.loadItems('thr_heal')).map((item) => [item.id, item.status]))
    expect(staleById.get('item_tool_stale')).toBe('pending')
    expect(staleById.get('item_result_stale')).toBe('running')

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_heal', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = (await readJson(response)) as {
      turns: Array<{ id: string; items: Array<{ id: string; status: string }> }>
    }
    const responseItems = new Map(
      (body.turns.find((turn) => turn.id === turnId)?.items ?? []).map((item) => [item.id, item.status])
    )
    expect(responseItems.get('item_tool_stale')).toBe('aborted')
    expect(responseItems.get('item_result_stale')).toBe('aborted')
    const healedById = new Map((await h.sessionStore.loadItems('thr_heal')).map((item) => [item.id, item.status]))
    expect(healedById.get('item_tool_stale')).toBe('aborted')
    expect(healedById.get('item_result_stale')).toBe('aborted')
  })

  it('persists GUI plan context from start-turn requests', async () => {
    const h = buildHarness()
    const create = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: '/tmp', model: 'deepseek-chat' })
      })
    )
    const thread = (await readJson(create)) as { id: string }
    const turn = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/turns`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'Plan auth',
          guiPlan: {
            operation: 'draft',
            workspaceRoot: '/tmp',
            relativePath: '.deepseekgui/plan/auth.md',
            planId: '/tmp:.deepseekgui/plan/auth.md',
            sourceRequest: 'Add auth',
            title: 'Auth'
          }
        })
      })
    )
    expect(turn.status).toBe(202)
    const turnBody = (await readJson(turn)) as { turnId: string }
    const detail = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/turns/${turnBody.turnId}`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(detail.status).toBe(200)
    const detailBody = (await readJson(detail)) as { guiPlan?: { relativePath?: string; operation?: string } }
    expect(detailBody.guiPlan).toMatchObject({
      operation: 'draft',
      relativePath: '.deepseekgui/plan/auth.md'
    })
  })

  it('groups usage by the usage event model instead of the thread default model', async () => {
    const h = buildHarness()
    const today = new Date().toISOString().slice(0, 10)
    const create = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: '/tmp', model: 'deepseek-chat' })
      })
    )
    expect(create.status).toBe(201)
    const thread = (await readJson(create)) as { id: string }
    const turn = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/turns`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' })
      })
    )
    expect(turn.status).toBe(202)
    const turnBody = (await readJson(turn)) as { turnId: string }
    await h.runtime.events.record({
      kind: 'usage',
      threadId: thread.id,
      turnId: turnBody.turnId,
      model: 'deepseek-v4-pro',
      usage: usageSnapshot({ promptTokens: 30, completionTokens: 10, totalTokens: 40 })
    })

    const usage = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/usage?group_by=model&from=${today}&to=${today}&timezone=UTC`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(usage.status).toBe(200)
    const body = (await readJson(usage)) as {
      buckets: Array<{ model: string; total_tokens: number }>
    }
    expect(body.buckets).toEqual([
      expect.objectContaining({
        model: 'deepseek-v4-pro',
        total_tokens: 40
      })
    ])
  })

  it('replays SSE backlog from Last-Event-ID when since_seq is omitted', async () => {
    const h = buildHarness()
    const create = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: '/tmp', model: 'deepseek-chat' })
      })
    )
    const thread = (await readJson(create)) as { id: string }
    const turn = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/turns`, {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hi' })
      })
    )
    expect(turn.status).toBe(202)

    const allEvents = await h.sessionStore.loadEventsSince(thread.id, 0)
    const secondSeq = allEvents[1]?.seq ?? 0
    const eventStream = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/events`, {
        headers: { authorization: 'Bearer tok-1', 'Last-Event-ID': String(secondSeq) }
      })
    )
    const events = await readSseEvents(eventStream)
    const ids = events.flatMap((frame) =>
      frame
        .split('\n')
        .filter((line) => line.startsWith('id:'))
        .map((line) => Number(line.slice(3).trim()))
    )
    expect(ids.every((id) => id > secondSeq)).toBe(true)
  })

  it('delivers an event exactly once when it lands in both backlog and live bus', async () => {
    const h = buildHarness()
    const thread = await h.threadService.create(
      { workspace: '/tmp', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_dedup', title: 'Dedup' }
    )
    const recorded = await h.runtime.events.record({ kind: 'heartbeat', threadId: thread.id })

    const eventStream = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/events?since_seq=0`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    // Simulate the persist/publish race: the event is already in the replayed
    // backlog when the live bus re-delivers it after the subscription starts.
    await new Promise((resolve) => setTimeout(resolve, 20))
    h.bus.publish(recorded)

    const frames = await readSseEvents(eventStream)
    const occurrences = frames.filter((frame) => frame.includes(`id: ${recorded.seq}\n`))
    expect(occurrences).toHaveLength(1)
  })

  it('sanitizes raw tool arguments and bash commands at the live SSE boundary', async () => {
    const h = buildHarness()
    const thread = await h.threadService.create(
      { workspace: '/tmp', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_sse_tool_privacy', title: 'SSE tool privacy' }
    )
    const eventStream = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/events?since_seq=0`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const secret = 'sse-live-secret-token'
    const turnId = 'turn_sse_tool_privacy'
    const call = makeToolCallItem({
      id: 'sse_raw_call',
      turnId,
      threadId: thread.id,
      callId: 'call_sse_raw',
      toolName: 'bash',
      arguments: { command: `git push https://user:${secret}@example.com/repo`, token: secret }
    })
    const result = makeToolResultItem({
      id: 'sse_raw_result',
      turnId,
      threadId: thread.id,
      callId: 'call_sse_raw',
      toolName: 'bash',
      output: { command: `git push https://user:${secret}@example.com/repo`, output: 'ok' }
    })
    h.bus.publish({
      kind: 'item_created',
      seq: h.bus.allocateSeq(thread.id),
      timestamp: h.nowIso(),
      threadId: thread.id,
      turnId,
      itemId: call.id,
      item: call
    })
    h.bus.publish({
      kind: 'item_completed',
      seq: h.bus.allocateSeq(thread.id),
      timestamp: h.nowIso(),
      threadId: thread.id,
      turnId,
      itemId: result.id,
      item: result
    })

    const frames = await readSseEvents(eventStream)
    const serialized = frames.join('\n')
    expect(serialized).toContain('argumentSummary')
    expect(serialized).toContain('Command: git push')
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('"command"')
  })

  it('does not lose a live event published while the replay backlog is loading', async () => {
    const h = buildHarness()
    const thread = await h.threadService.create(
      { workspace: '/tmp', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_replay_race', title: 'Replay race' }
    )
    const originalLoadEventsSince = h.sessionStore.loadEventsSince.bind(h.sessionStore)
    let replayStartedResolve: (() => void) | undefined
    const replayStarted = new Promise<void>((resolve) => {
      replayStartedResolve = resolve
    })
    let releaseReplayResolve: (() => void) | undefined
    const releaseReplay = new Promise<void>((resolve) => {
      releaseReplayResolve = resolve
    })
    vi.spyOn(h.sessionStore, 'loadEventsSince').mockImplementation(async (threadId, sinceSeq) => {
      const backlog = await originalLoadEventsSince(threadId, sinceSeq)
      replayStartedResolve?.()
      await releaseReplay
      return backlog
    })

    const responsePromise = dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/events?since_seq=0`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    await replayStarted
    const recorded = await h.runtime.events.record({ kind: 'heartbeat', threadId: thread.id })
    releaseReplayResolve?.()

    const frames = await readSseEvents(await responsePromise)
    expect(frames.filter((frame) => frame.includes(`id: ${recorded.seq}\n`))).toHaveLength(1)
  })

  it('closes cleanly when the client aborts while replay is loading', async () => {
    const h = buildHarness()
    const thread = await h.threadService.create(
      { workspace: '/tmp', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_replay_abort', title: 'Replay abort' }
    )
    const originalLoadEventsSince = h.sessionStore.loadEventsSince.bind(h.sessionStore)
    let replayStartedResolve: (() => void) | undefined
    const replayStarted = new Promise<void>((resolve) => {
      replayStartedResolve = resolve
    })
    let releaseReplayResolve: (() => void) | undefined
    const releaseReplay = new Promise<void>((resolve) => {
      releaseReplayResolve = resolve
    })
    vi.spyOn(h.sessionStore, 'loadEventsSince').mockImplementation(async (threadId, sinceSeq) => {
      const backlog = await originalLoadEventsSince(threadId, sinceSeq)
      replayStartedResolve?.()
      await releaseReplay
      return backlog
    })
    const unsubscribe = vi.fn()
    const subscribe = h.bus.subscribe.bind(h.bus)
    vi.spyOn(h.bus, 'subscribe').mockImplementation((threadId, handler) => {
      const actualUnsubscribe = subscribe(threadId, handler)
      return () => {
        unsubscribe()
        actualUnsubscribe()
      }
    })
    const abortController = new AbortController()
    const responsePromise = dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/events?since_seq=0`, {
        headers: { authorization: 'Bearer tok-1' },
        signal: abortController.signal
      })
    )
    await replayStarted
    abortController.abort()
    releaseReplayResolve?.()

    const response = await responsePromise
    const reader = response.body!.getReader()
    await expect(reader.read()).resolves.toMatchObject({ done: true })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('bounds live events buffered while replay is loading', async () => {
    const h = buildHarness()
    const thread = await h.threadService.create(
      { workspace: '/tmp', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_replay_overflow', title: 'Replay overflow' }
    )
    await h.runtime.events.record({ kind: 'heartbeat', threadId: thread.id })
    const originalLoadEventsSince = h.sessionStore.loadEventsSince.bind(h.sessionStore)
    let replayStartedResolve: (() => void) | undefined
    const replayStarted = new Promise<void>((resolve) => {
      replayStartedResolve = resolve
    })
    let releaseReplayResolve: (() => void) | undefined
    const releaseReplay = new Promise<void>((resolve) => {
      releaseReplayResolve = resolve
    })
    vi.spyOn(h.sessionStore, 'loadEventsSince').mockImplementation(async (threadId, sinceSeq) => {
      const backlog = await originalLoadEventsSince(threadId, sinceSeq)
      replayStartedResolve?.()
      await releaseReplay
      return backlog
    })
    const responsePromise = dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/events?since_seq=0`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    await replayStarted
    const firstLiveSeq = 2
    for (let index = 0; index <= RUNTIME_RESOURCE_LIMITS_V1.sseReplayEvents; index += 1) {
      h.bus.publish({
        kind: 'heartbeat',
        threadId: thread.id,
        seq: firstLiveSeq + index,
        timestamp: new Date().toISOString()
      })
    }
    releaseReplayResolve?.()

    const frames = await readSseEvents(await responsePromise, { idleMs: 100 })
    expect(frames.filter((frame) => frame.includes('event: replay_reset'))).toHaveLength(1)
    expect(frames.some((frame) => frame.includes('event: heartbeat'))).toBe(false)
  })

  it('skips SSE backlog replay when the client is already caught up', async () => {
    const h = buildHarness()
    const thread = await h.threadService.create(
      { workspace: '/tmp', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_caught_up', title: 'Caught up' }
    )
    const latestSeq = await h.sessionStore.highestSeq(thread.id)
    const loadEventsSince = vi.spyOn(h.sessionStore, 'loadEventsSince')

    const eventStream = await dispatchRequest(
      h.router,
      new Request(`http://localhost/v1/threads/${thread.id}/events?since_seq=${latestSeq}`, {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const events = await readSseEvents(eventStream)

    expect(events).toEqual([])
    expect(loadEventsSince).not.toHaveBeenCalled()
  })

  it('resolves an approval through the HTTP endpoint', async () => {
    const h = buildHarness()
    const approval = createApprovalRequest({
      id: 'appr_1',
      threadId: 'thr_1',
      turnId: 'turn_1',
      toolName: 'echo',
      summary: 'run echo'
    })
    const pending = h.approvalGate.request(approval)
    const decide = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/approvals/appr_1', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'allow' })
      })
    )
    expect(decide.status).toBe(200)
    const body = (await readJson(decide)) as { decision: string }
    expect(body.decision).toBe('allow')
    await expect(pending).resolves.toBe('allow')
  })

  it('resolves GUI user input through both HTTP compatibility endpoints', async () => {
    const h = buildHarness()
    const pending = h.userInputGate.request({
      id: 'in_1',
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemId: 'item_in_1',
      prompt: 'Pick one',
      questions: []
    })
    const submit = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/user-inputs/in_1', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({
          answers: [{ id: 'choice', label: 'Yes', value: 'yes' }]
        })
      })
    )
    expect(submit.status).toBe(200)
    await expect(pending).resolves.toEqual({
      status: 'submitted',
      answers: [{ id: 'choice', label: 'Yes', value: 'yes' }]
    })

    const cancelPending = h.userInputGate.request({
      id: 'in_2',
      threadId: 'thr_1',
      turnId: 'turn_1',
      itemId: 'item_in_2',
      prompt: 'Cancel?',
      questions: []
    })
    const cancel = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/user-input/in_2', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ cancelled: true })
      })
    )
    expect(cancel.status).toBe(200)
    await expect(cancelPending).resolves.toEqual({ status: 'cancelled' })
    const events = await h.sessionStore.loadEventsSince('thr_1', 0)
    expect(events.filter((event) => event.kind === 'user_input_resolved')).toHaveLength(2)
  })

  it('forks a thread with copied history and lineage metadata', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_parent', title: 'Parent' }
    )
    await h.turnService.startTurn({
      threadId: 'thr_parent',
      request: { prompt: 'hello' }
    })

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_parent/fork', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(201)
    const fork = (await readJson(response)) as {
      id: string
      forkedFromThreadId?: string
      forkedFromTitle?: string
      forkedFromMessageCount?: number
      forkedFromTurnCount?: number
      turns: Array<{ threadId: string; items: Array<{ threadId: string; kind: string }> }>
    }
    expect(fork.forkedFromThreadId).toBe('thr_parent')
    expect(fork.forkedFromTitle).toBe('Parent')
    expect(fork.forkedFromMessageCount).toBe(1)
    expect(fork.forkedFromTurnCount).toBe(1)
    expect(fork.turns[0]?.threadId).toBe(fork.id)
    expect(fork.turns[0]?.items[0]).toMatchObject({ threadId: fork.id, kind: 'user_message' })
    const copiedItems = await h.sessionStore.loadItems(fork.id)
    expect(copiedItems).toHaveLength(1)
    expect(copiedItems[0]).toMatchObject({ threadId: fork.id, kind: 'user_message' })
  })

  it('forks with relation: side, attaches parentThreadId, and is excluded from the default list', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_parent', title: 'Parent' }
    )
    await h.turnService.startTurn({
      threadId: 'thr_parent',
      request: { prompt: 'seed turn' }
    })

    const forkResponse = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_parent/fork', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ relation: 'side' })
      })
    )
    expect(forkResponse.status).toBe(201)
    const fork = (await readJson(forkResponse)) as {
      id: string
      relation?: string
      parentThreadId?: string
      title: string
    }
    expect(fork.relation).toBe('side')
    expect(fork.parentThreadId).toBe('thr_parent')
    expect(fork.title).toBe('Parent · side')

    // Default list hides side threads.
    const listResponse = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const listBody = (await readJson(listResponse)) as {
      threads: Array<{ id: string; relation?: string }>
    }
    expect(listBody.threads.find((t) => t.id === fork.id)).toBeUndefined()
    expect(listBody.threads.find((t) => t.id === 'thr_parent')).toBeDefined()

    // Opt-in include=side surfaces them.
    const includeResponse = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads?include=side', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    const includeBody = (await readJson(includeResponse)) as {
      threads: Array<{ id: string; relation?: string }>
    }
    expect(includeBody.threads.find((t) => t.id === fork.id)).toMatchObject({ relation: 'side' })
  })

  it('bodyless fork still defaults to relation: fork', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_default_fork', title: 'Forker' }
    )
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/threads/thr_default_fork/fork', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(response.status).toBe(201)
    const body = (await readJson(response)) as { relation?: string; parentThreadId?: string }
    expect(body.relation).toBe('fork')
    expect(body.parentThreadId).toBe('thr_default_fork')
  })

  it('resumes a persisted session into a new Kun thread', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_source', title: 'Source Thread' }
    )
    await h.turnService.startTurn({
      threadId: 'thr_source',
      request: { prompt: 'restore this' }
    })

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/sessions/thr_source/resume-thread', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: '/tmp/override', model: 'deepseek-coder', mode: 'plan' })
      })
    )

    expect(response.status).toBe(201)
    const body = (await readJson(response)) as {
      thread_id: string
      session_id: string
      message_count: number
      summary: string
    }
    expect(body.session_id).toBe('thr_source')
    expect(body.message_count).toBe(1)
    expect(body.summary).toBe('Source Thread resumed')
    const resumed = await h.threadService.get(body.thread_id)
    expect(resumed).toMatchObject({
      workspace: '/tmp/override',
      model: 'deepseek-coder',
      mode: 'plan',
      status: 'idle',
      forkedFromThreadId: 'thr_source'
    })
    expect(resumed?.turns[0]?.status).toBe('completed')
    expect(resumed?.turns[0]?.items[0]).toMatchObject({
      threadId: body.thread_id,
      kind: 'user_message',
      text: 'restore this'
    })
    const copiedItems = await h.sessionStore.loadItems(body.thread_id)
    expect(copiedItems).toHaveLength(1)
  })

  it('returns 404 when resuming an unknown session', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/sessions/missing/resume-thread', {
        method: 'POST',
        headers: { authorization: 'Bearer tok-1', 'content-type': 'application/json' },
        body: JSON.stringify({})
      })
    )

    expect(response.status).toBe(404)
  })

  it('returns cumulative usage from /v1/usage', async () => {
    const h = buildHarness()
    h.runtime.usageService.record('thr_1', {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cachedTokens: 2,
      cacheHitTokens: 2,
      cacheMissTokens: 3,
      cacheHitRate: 0.4,
      turns: 1
    })
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/usage', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(response.status).toBe(200)
    const body = (await readJson(response)) as { total: { promptTokens: number } }
    expect(body.total.promptTokens).toBe(5)
  })

  it('returns live thread-grouped usage buckets from /v1/usage?group_by=thread', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_live', title: 'Live usage' }
    )
    h.runtime.usageService.record('thr_live', usageSnapshot({ promptTokens: 12, completionTokens: 8 }))

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/usage?group_by=thread', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = (await readJson(response)) as {
      group_by: string
      buckets: Array<{ thread_id: string; total_tokens: number; turns: number }>
    }
    expect(body.group_by).toBe('thread')
    expect(body.buckets).toEqual([
      expect.objectContaining({ thread_id: 'thr_live', total_tokens: 20, turns: 1 })
    ])
  })

  it('filters thread-grouped usage buckets by thread_id', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_live', title: 'Live usage' }
    )
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_other', title: 'Other usage' }
    )
    h.runtime.usageService.record('thr_live', usageSnapshot({ promptTokens: 12, completionTokens: 8 }))
    h.runtime.usageService.record('thr_other', usageSnapshot({ promptTokens: 90, completionTokens: 10 }))

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/usage?group_by=thread&thread_id=thr_live', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = (await readJson(response)) as {
      group_by: string
      buckets: Array<{ thread_id: string; total_tokens: number; turns: number }>
    }
    expect(body.group_by).toBe('thread')
    expect(body.buckets).toEqual([
      expect.objectContaining({ thread_id: 'thr_live', total_tokens: 20, turns: 1 })
    ])
  })

  it('derives daily usage from persisted cumulative usage events', async () => {
    const h = buildHarness()
    await h.threadService.create(
      { workspace: '/tmp/project', model: 'deepseek-chat', mode: 'agent' },
      { id: 'thr_usage', title: 'Persisted usage' }
    )
    await h.sessionStore.appendEvent('thr_usage', {
      kind: 'usage',
      seq: 2,
      timestamp: '2026-06-02T09:00:00.000Z',
      threadId: 'thr_usage',
      usage: usageSnapshot({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        turns: 1,
        tokenEconomySavingsTokens: 100,
        tokenEconomySavingsUsd: 0.001
      })
    })
    await h.sessionStore.appendEvent('thr_usage', {
      kind: 'usage',
      seq: 3,
      timestamp: '2026-06-02T09:05:00.000Z',
      threadId: 'thr_usage',
      usage: usageSnapshot({
        promptTokens: 30,
        completionTokens: 10,
        totalTokens: 40,
        turns: 2,
        tokenEconomySavingsTokens: 250,
        tokenEconomySavingsUsd: 0.0025
      })
    })

    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/usage?group_by=day&from=2026-06-02&to=2026-06-02&timezone=UTC', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )

    expect(response.status).toBe(200)
    const body = (await readJson(response)) as {
      group_by: string
      buckets: Array<{ date: string; total_tokens: number; turns: number; thread_count: number }>
      totals: {
        total_tokens: number
        turns: number
        active_days: number
        token_economy_savings_tokens: number
        token_economy_savings_usd: number
      }
    }
    expect(body.group_by).toBe('day')
    expect(body.buckets[0]).toMatchObject({
      date: '2026-06-02',
      total_tokens: 40,
      turns: 2,
      thread_count: 1
    })
    expect(body.totals).toMatchObject({
      total_tokens: 40,
      turns: 2,
      active_days: 1,
      token_economy_savings_tokens: 250,
      token_economy_savings_usd: 0.0025
    })
  })

  it('encodes SSE events with sequence numbers and event names', () => {
    const frame = encodeSseEvent({
      kind: 'heartbeat',
      seq: 7,
      timestamp: 't',
      threadId: 'th'
    })
    expect(frame).toContain('id: 7')
    expect(frame).toContain('event: heartbeat')
    expect(frame.endsWith('\n\n')).toBe(true)
  })

  it('returns a 404 for unknown routes', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/unknown')
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await readJson(response)).toEqual({
      code: 'not_found',
      message: 'route not found'
    })
  })

  it('streams a workspace status response', async () => {
    const h = buildHarness()
    const response = await dispatchRequest(
      h.router,
      new Request('http://localhost/v1/workspace/status?path=/tmp', {
        headers: { authorization: 'Bearer tok-1' }
      })
    )
    expect(response.status).toBe(200)
    const body = (await readJson(response)) as { path: string }
    expect(body.path).toBe('/tmp')
  })
})
