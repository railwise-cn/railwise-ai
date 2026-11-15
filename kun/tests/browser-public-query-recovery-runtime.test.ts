import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Window, type HTMLElement, type HTMLInputElement } from 'happy-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { BrowserTaskBindingSnapshot } from '../src/contracts/browser-skill.js'
import type { TaskRun } from '../src/contracts/tasks.js'
import type { BrowserPublicQueryRecoverySnapshot } from '../src/contracts/browser-public-query-recovery.js'
import type { BrowserCommandRunner } from '../src/services/browser-skill-cli.js'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { ManagedBrowserSkillRuntime } from '../src/services/managed-browser-skill-runtime.js'
import { operationFingerprint } from '../src/services/task-run-repository.js'
// @ts-expect-error The exact-package smoke driver is deliberately native JavaScript.
import { startWindowsTaskModelFixture, windowsTaskPrompt, inspectWindowsPersistedWebArtifact, inspectWindowsDocumentNavigation } from '../../scripts/run-windows-ui-smoke.mjs'

const browser = vi.hoisted(() => ({ run: undefined as BrowserCommandRunner | undefined }))
vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn((config, args, signal) => browser.run!(config, args, signal))
}))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
  browser.run = undefined
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function recoveryScenario(sourceProviderFailure: boolean): Promise<void> {
  // This exercises real Runtime/HTTP/SQLite/Flow and served fixture documents.
  // The BrowserSkill CLI protocol is a local DOM fixture, not a real browser.
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '0')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'windows-web-artifact-runtime-'))), workspace = join(root, 'workspace')
  await mkdir(workspace); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const fixture = await startWindowsTaskModelFixture({ browser: true, postPlanQuery: true, documentLinkClick: true })
  cleanup.push(() => fixture.close())
  // Only this controlled external model proxy isolates the new turn's messages.
  // Runtime checkpoints/history and all real receipts remain untouched.
  let isolateCurrentTurn = false
  let rootPlanOnly = false
  let rootPlanModelCalls = 0
  let rootPlanMissingCatalog: string[] | undefined
  let sourceFinalFailures = 0
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (isolateCurrentTurn) {
      const start = body.messages.findLastIndex((message: { role: string }) => message.role === 'user')
      expect(start).toBeGreaterThanOrEqual(0)
      body.messages = [...body.messages.slice(0, start).filter((message: { role: string }) => message.role === 'system'), ...body.messages.slice(start)]
    }
    const sourceCalled = new Set(body.messages.flatMap((message: { tool_calls?: Array<{ id: string }> }) => message.tool_calls?.map(call => call.id) ?? []))
    if (sourceProviderFailure && !isolateCurrentTurn && sourceCalled.has('smoke-post-plan-stop') && sourceCalled.has('smoke-verify-web-artifact') && sourceCalled.has('smoke-read-schedule')) {
      // Synthetic model output-limit failure AFTER actual sources, verification,
      // plan readback and post-plan queries. Runtime owns the failed transition.
      sourceFinalFailures++
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'synthetic-source-output-limit', choices: [{ index: 0, delta: { content: 'Synthetic model output limit after the verified file and plan.' }, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    if (rootPlanOnly) {
      // An explicit service-gate fixture: choose only the ACTUAL advertised local
      // schedule tools. No tool catalog or Runtime history is rewritten.
      const names = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
      if (!names.includes('list_schedules')) {
        rootPlanMissingCatalog = names
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ id: 'root-plan-missing-tools', choices: [{ index: 0, delta: { content: 'The actual tool catalog lacks the required existing-plan operation. This fixture did not save or read back a plan.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
        return
      }
      const called = new Set(body.messages.flatMap((message: { tool_calls?: Array<{ id: string }> }) => message.tool_calls?.map(call => call.id) ?? []))
      const failed = body.messages.some((message: { role: string; content?: unknown }) => message.role === 'tool' && typeof message.content === 'string' && /"(?:isError)"\s*:\s*true|"status"\s*:\s*"(?:failed|outcome_unknown)"|"error"\s*:/.test(message.content))
      const next = failed ? undefined : !called.has('root-plan-read') ? ['root-plan-read', 'list_schedules'] : undefined
      const delta = next ? { tool_calls: [{ index: 0, id: next[0], type: 'function', function: { name: next[1], arguments: '{}' } }] }
        : { content: failed ? 'Local plan validation failed; no report was generated.' : 'Existing plan was read back. This service-gate check did not produce a new report.' }
      rootPlanModelCalls++
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${JSON.stringify({ id: 'root-plan-service-fixture', choices: [{ index: 0, delta, finish_reason: next ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
      return
    }
    const result = await fetch(new URL(request.url!, fixture.baseUrl), { method: request.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    response.writeHead(result.status, { 'content-type': result.headers.get('content-type') ?? 'text/event-stream' })
    response.end(Buffer.from(await result.arrayBuffer()))
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())))
  const proxyBaseUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1`
  let failNextClick = false
  let failedSessionId: string | undefined
  let unknownNativeAttempts = 0
  type Session = { url: string; tab: number; context: number; window: Window }
  const sessions = new Map<string, Session>(), windows: Window[] = [], writes: Array<{ sessionId: string; action: string }> = []
  let count = 0
  cleanup.push(async () => { for (const window of windows) await window.happyDOM.close() })
  const nativeTrace: Array<{ argv: string[]; state: string; code?: string }> = []
  const protocolRunner: BrowserCommandRunner = async (_configuration, args) => {
    if (args[0] === 'status') return { ok: true, output: { protocol_version: '1.9', pid: 7,
      browsers: [{ instance_id: 'synthetic-browser', browser_name: 'Chrome', extension_version: '0.5.0', extension_protocol_version: '1.9' }],
      sessions: [...sessions.keys()].map(session_id => ({ session_id, browser_instance_id: 'synthetic-browser' })) } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: { state: 'prepared' } }
    if (args[0] === 'session' && args[1] === 'start') {
      const tab = ++count, sessionId = 'fixture-session-' + tab
      // Only scripts served by this owned loopback fixture are evaluated.
      const window = new Window({ url: fixture.fixtureUrl, settings: { enableJavaScriptEvaluation: true } })
      windows.push(window); sessions.set(sessionId, { window, tab, context: 0, url: 'about:blank' })
      return { ok: true, output: { session_id: sessionId, browser_instance_id: 'synthetic-browser' } }
    }
    if (args[0] === 'session' && args[1] === 'stop') {
      expect(sessions.delete(args[2]!)).toBe(true)
      return { ok: true, output: { stopped: [args[2]], failed: [] } }
    }
    const sessionId = args[args.indexOf('--session') + 1]!, session = sessions.get(sessionId)
    if (!session) return { ok: false, code: 'not_found', exitCode: 1, outcomeUnknown: false, output: { code: 'not_found' } }
    const doc = session.window.document
    const refs = () => new Map([...doc.querySelectorAll('*')].map((node, index) => [node, '@e' + (index + 1)]))
    const resolve = (reference: string) => [...refs()].find(([, value]) => value === (reference.startsWith('@') ? reference : '@' + reference))?.[0]
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: session.tab, active: true, scope: 'agent', url: session.url, title: doc.title }] } }
    if (args[0] === 'navigate') {
      const url = args[1]!
      expect([fixture.fixtureUrl, fixture.detailUrl]).toContain(url)
      if (session.url !== 'about:blank') {
        expect(args[args.indexOf('--context') + 1]).toBe(sessionId + '-context-' + session.context)
        expect(args[args.indexOf('--observation') + 1]).toBe(sessionId + '-observation-' + session.context)
      }
      const response = await fetch(url)
      expect(response.status).toBe(200)
      const html = await response.text()
      doc.open(); doc.write(html); doc.close(); session.url = url
      return { ok: true, output: { final_url: url } }
    }
    if (args[0] === 'cooperate') {
      const references = refs()
      const controls = [...doc.querySelectorAll('input,[role="button"],button,a:not([hidden])')].map(node => {
        const input = node.tagName === 'INPUT'
        if (node.tagName === 'A') return references.get(node) + ' link ' + node.textContent + ' href=' + node.getAttribute('href')
        return references.get(node) + (input ? ' textbox ' + node.getAttribute('placeholder') + ' ' + (node as HTMLInputElement).value : ' button ' + node.textContent)
      })
      return { ok: true, output: { ready: true, context_id: sessionId + '-context-' + (++session.context),
        observation_id: sessionId + '-observation-' + session.context, tab_id: session.tab, control_policy: 'target',
        observation: { text: controls.join('\n') + '\n' + doc.body.innerText } } }
    }
    if (args[0] === 'get-html') {
      const target = args.includes('--ref') ? resolve(args[args.indexOf('--ref') + 1]!) : doc.documentElement
      expect(target).toBeTruthy()
      const html = target!.outerHTML
      return { ok: true, output: { tab_id: session.tab, html, byte_size: Buffer.byteLength(html), truncated: false } }
    }
    if (args[0] === 'read') {
      const nodes = args.includes('--selector') ? [...doc.querySelectorAll(args[args.indexOf('--selector') + 1]!)] : [resolve(args[args.indexOf('--ref') + 1]!)!]
      const maximum = args.includes('--max-nodes') ? Number(args[args.indexOf('--max-nodes') + 1]) : 100
      const fields = JSON.parse(args[args.indexOf('--fields-json') + 1]!) as Array<{ key: string; read: string; selector?: string; attribute?: string }>
      const items = []
      for (const node of nodes.slice(0, maximum)) {
        const values: Record<string, unknown> = {}
        for (const field of fields) {
          const found = field.selector ? [...node.querySelectorAll(field.selector)] : [node]
          if (found.length > 1) return { ok: false, code: 'invalid_params', exitCode: 1, outcomeUnknown: false, output: { data: { reason: 'read_field_ambiguous' } } }
          values[field.key] = field.read === 'exists' ? found.length === 1 : field.read === 'attribute' ? found[0]?.getAttribute(field.attribute!) ?? null
            : field.read === 'value' ? (found[0] as HTMLInputElement | undefined)?.value ?? '' : found[0]?.textContent ?? null
        }
        items.push({ ref: refs().get(node), values, redacted: [] })
      }
      return { ok: true, output: { tab_id: session.tab, page_url: session.url, frame_url: session.url, frame_id: 'MAIN-' + sessionId,
        scope: 'current_dom', truncated: nodes.length > maximum, items } }
    }
    if (args[0] === 'fill' || args[0] === 'click') {
      expect(args).toContain('--expect')
      const expected = JSON.parse(args[args.indexOf('--expect') + 1]!) as Array<{ target: string; field: string; attribute?: string; equals: unknown }>
      for (const fact of expected) {
        const node = resolve(fact.target)
        const value = fact.field === 'exists' ? Boolean(node) : fact.field === 'value' ? (node as HTMLInputElement).value
          : fact.field === 'text' ? node?.textContent : node?.getAttribute(fact.attribute!)
        expect(value).toEqual(fact.equals)
      }
      const target = resolve(args.find(value => /^@?e\d+$/.test(value))!)!
      writes.push({ sessionId, action: args[0] })
      if (args[0] === 'click' && failNextClick) {
        failNextClick = false; failedSessionId = sessionId; unknownNativeAttempts++
        return { ok: false, code: 'operation_failed', exitCode: 1, outcomeUnknown: true,
          vendorReason: 'control_context_invalid', effectState: 'unknown',
          output: { code: 'operation_failed', data: { reason: 'control_context_invalid', effect_state: 'unknown' } } }
      }
      if (args[0] === 'fill') (target as HTMLInputElement).value = args[args.indexOf('--value') + 1]!
      else (target as HTMLElement).click()
      return { ok: true, output: { tab_id: session.tab } }
    }
    throw new Error('Unexpected local native protocol command')
  }
  browser.run = async (configuration, args, signal) => {
    const entry: { argv: string[]; state: string; code?: string } = { argv: [...args], state: 'running' }
    nativeTrace.push(entry)
    try { const result = await protocolRunner(configuration, args, signal); entry.state = result.ok ? 'succeeded' : 'failed'; entry.code = result.code; return result }
    catch (error) { entry.state = 'threw'; throw error }
  }
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-windows-web',
    apiKey: 'synthetic-local-only', baseUrl: proxyBaseUrl, endpointFormat: 'chat_completions', model: 'windows-task-fixture',
    approvalPolicy: 'on-request', sandboxMode: 'read-only', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' },
    capabilities: KunCapabilitiesConfig.parse({ browserSkill: { enabled: true, state: 'ready', executablePath: join(root, 'synthetic-cli'), executableHash: 'a'.repeat(64),
      version: '0.5.0', daemonProtocolVersion: '1.9', browserInstanceId: 'synthetic-browser', origins: [new URL(fixture.fixtureUrl).origin], interaction: 'interact', revision: 1,
      browsers: [{ id: 'synthetic-browser', name: 'Chrome', label: 'Controlled protocol fixture', connected: true, versionSkew: false, extensionVersion: '0.5.0', protocolVersion: '1.9' }] } }) })
  cleanup.push(async () => runtime.shutdown?.())
  const repository = runtime.taskRepository!, router = buildRouter(runtime)
  const api = (path: string, method = 'POST', body?: unknown) => dispatchRequest(router, new Request('http://localhost' + path,
    { method, headers: { authorization: 'Bearer synthetic-windows-web', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'windows-task-fixture', approvalPolicy: 'on-request' })
  const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'windows-web-source', request: { prompt: windowsTaskPrompt(fixture, true) } })
  expect(started.kind).toBe('capability_required')
  const sourceId = started.task!.id
  const snapshot = await (await api(`/v1/tasks/${sourceId}/browser-binding`, 'GET')).json() as BrowserTaskBindingSnapshot
  const binding = await api(`/v1/tasks/${sourceId}/browser-binding`, 'POST', { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
    expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins,
    interaction: 'interact', verificationPolicy: 'public_query_target', publicQueryAuthorization: 'schedule', idempotencyKey: 'confirm-source' })
  expect(binding.status, await binding.clone().text()).toBe(200)
  expect(repository.get(sourceId)!.status).toBe('waiting_user')
  expect((await runtime.threadService.get(started.task!.threadId))!.turns).toHaveLength(0)
  expect((await api(`/v1/tasks/${sourceId}/resume`, 'POST', { expectedRevision: repository.get(sourceId)!.revision, idempotencyKey: 'start-source' })).status).toBe(202)
  const completed = async (id: string) => {
    try { await expect.poll(() => {
      const task = repository.get(id)!
      return { status: task.status, reason: task.waitingReason ?? task.stalledReason ?? null }
    }, { timeout: 30_000 }).toEqual({ status: 'completed', reason: null }) } catch (error) {
      const saved = repository.get(id)!, thread = await runtime.threadService.get(saved.threadId)
      throw new Error(JSON.stringify({ state: saved.status, activeTurnId: saved.activeTurnId, requests: fixture.observed.requests.slice(-4), turns: thread?.turns.map(turn => ({ id: turn.id, status: turn.status, error: turn.error,
        lastItems: turn.items.slice(-8).map(item => ({ kind: item.kind, status: item.status, ...('callId' in item ? { callId: item.callId, toolName: item.toolName } : {}), ...('text' in item ? { text: item.text.slice(0, 250) } : {}) })),
        results: turn.items.filter(item => item.kind === 'tool_result' && item.isError) })), nativeTrace: nativeTrace.slice(-10), activeNativeRunners: nativeTrace.filter(entry => entry.state === 'running').length, humanRequests: repository.humanRequests('approval'), scopeRequests: repository.operations(id).filter(row => ['browser_action_scope_request', 'browser_scope_action_authorization'].includes(row.kind)), receipts: repository.operations(id).slice(-8).map(row => ({ kind: row.kind, status: row.status, error: row.error, request: row.request && { toolName: row.request.toolName, turnId: row.request.turnId, callId: row.request.callId } })) }), { cause: error })
    }
    return repository.get(id)!
  }
  const verify = async (task: TaskRun) => {
    const thread = (await runtime.threadService.get(task.threadId))!, receipts = repository.operations(task.id)
    const artifact = task.artifacts.find(item => item.format === 'html' && item.validation === 'valid')!
    const bytes = await readFile(artifact.absolutePath!)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256)
    const result = inspectWindowsPersistedWebArtifact(task, thread, receipts, artifact, fixture)
    expect(result.persistedReceiptVerified).toBe(true)
    expect(result.sourceReceipts.every((receipt: { turnId: string }) => receipt.turnId === task.activeTurnId)).toBe(true)
    if (sourceProviderFailure && task.id === sourceId) {
      // A failed final response keeps the task projection a draft even though
      // the earlier real file/source verification receipt is retained.
      expect(task.status).toBe('failed')
      expect(artifact.sourceEvidenceStatus).toBe('draft')
      expect(artifact.sourceEvidenceReceiptId).toBeUndefined()
    } else expect(artifact).toMatchObject({ sourceEvidenceStatus: 'verified', sourceEvidenceReceiptId: result.evidenceReceiptId })
    expect(receipts.filter(item => item.kind === 'web_artifact_evidence')).toHaveLength(1)
    expect(receipts.filter(item => item.kind === 'browser_action_dispatch')).toHaveLength(task.scheduledBy ? 3 : 5)
    const navigation = inspectWindowsDocumentNavigation(task, thread, task.scheduledBy ? [...repository.operations(sourceId), ...receipts] : receipts, fixture)
    expect(navigation).toMatchObject({ verified: true, clickDispatched: false, actionAcknowledged: false, navigationAcknowledged: true, freshContextVerified: true })
    expect(receipts.filter(item => item.status === 'outcome_unknown')).toHaveLength(0)
    expect(thread.turns.flatMap(turn => turn.items).filter(item => item.kind === 'approval')).toHaveLength(0)
    expect(runtime.approvalGate.pending()).toHaveLength(0)
    const calls = thread.turns.flatMap(turn => turn.items).filter(item => item.kind === 'tool_call')
    expect(calls.filter(item => item.toolName === 'verify_web_artifact')).toHaveLength(1)
    expect(thread.turns.flatMap(turn => turn.items).find(item => item.kind === 'tool_result' && item.callId === 'smoke-read-detail')).toMatchObject({
      output: { sourceUrl: fixture.detailUrl, truncated: false, readScope: 'document' }
    })
    const reads = calls.filter(item => item.toolName === 'read_artifact')
    expect(reads).toHaveLength(1)
    const grant = thread.turns.find(turn => turn.id === task.activeTurnId)!.executionGrant!
    expect(grant).toMatchObject({ taskId: task.id, turnId: task.activeTurnId })
    return { task, thread, artifact, result, grant }
  }
  if (sourceProviderFailure) await expect.poll(() => repository.get(sourceId)?.status, { timeout: 30_000 }).toBe('failed')
  const source = await verify(sourceProviderFailure ? repository.get(sourceId)! : await completed(sourceId))
  if (sourceProviderFailure) expect(sourceFinalFailures).toBeGreaterThan(0)
  const flow = runtime.flowService!.get('schedule_' + sourceId)!
  expect(flow).toBeTruthy()
  const sealedPlan = JSON.stringify(flow)
  const sealedAuthorities = JSON.stringify(repository.operations(sourceId, 'schedule_authority'))
  const dueAt = runtime.flowService!.repository.getTriggerState(flow.id, 'schedule')!.nextRunAt!
  failNextClick = true
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(dueAt))
  await runtime.flowService!.tickSchedules(new Date())
  const occurrence = () => repository.list().find(task => task.scheduledBy?.scheduleId === flow.id && task.scheduledBy.dueAt === dueAt)
  await expect.poll(() => occurrence()?.id, { timeout: 5_000 }).toBeTruthy()
  const dueId = occurrence()!.id
  await expect.poll(() => repository.get(dueId)?.status, { timeout: 30_000 }).toBe('stalled')
  expect(unknownNativeAttempts).toBe(1)
  const unknownHost = repository.operations(dueId, 'tool').find(row => row.status === 'outcome_unknown')!
  expect(unknownHost.request).toMatchObject({ providerId: 'browser-skill', toolName: 'browser_click' })
  const unknownDispatch = repository.operations(dueId, 'browser_action_dispatch').find(row => row.status === 'outcome_unknown')!
  const rootLocks = repository.operations(sourceId, 'browser_schedule_action_outcome').filter(row => row.status === 'outcome_unknown')
  expect(rootLocks).toHaveLength(1)
  const unknownRows = [unknownHost, unknownDispatch, ...rootLocks]
  const oldBytes = new Map(unknownRows.map(row => [row.id, JSON.stringify(row)]))
  const unchangedUnknowns = () => {
    for (const before of unknownRows) {
      const row = repository.operations(before.ownerId).find(value => value.id === before.id)!
      expect(JSON.stringify(row)).toBe(oldBytes.get(row.id))
      expect(row.status).toBe('outcome_unknown')
      expect(row.resolution).toBeUndefined()
      expect(repository.verifiedOperationResolution(row)).toBeUndefined()
    }
  }
  expect((await (await api(`/v1/tasks/${dueId}/public-query-recovery`, 'GET')).json() as BrowserPublicQueryRecoverySnapshot).state).toBe('unavailable')
  // The external protocol fixture's old session disappears; no Runtime row is edited.
  expect(failedSessionId).toBeTruthy()
  sessions.delete(failedSessionId!)
  const oldTask = repository.get(dueId)!
  const reviewResponse = await api(`/v1/tasks/${dueId}/receipts/${unknownHost.id}/verify`, 'POST', { expectedRevision: oldTask.revision, idempotencyKey: 'read-expired-context' })
  expect(reviewResponse.status, await reviewResponse.clone().text()).toBe(200)
  expect(await reviewResponse.json()).toMatchObject({ status: 'outcome_unknown', errorCode: 'not_found' })
  const eligibilityResponse = await api(`/v1/tasks/${dueId}/public-query-recovery`, 'GET')
  expect(eligibilityResponse.status).toBe(200)
  expect(await eligibilityResponse.json()).toMatchObject({ taskId: dueId, state: 'eligible', unknownOperationCount: 3 })
  const identity = vi.spyOn(ManagedBrowserSkillRuntime.prototype, 'identityFingerprint').mockReturnValue('b'.repeat(64))
  try {
    expect((await (await api(`/v1/tasks/${dueId}/public-query-recovery`, 'GET')).json() as BrowserPublicQueryRecoverySnapshot).state).toBe('unavailable')
    const changedIdentity = await api(`/v1/tasks/${dueId}/prepare-public-query-recovery`, 'POST', { expectedRevision: repository.get(dueId)!.revision, idempotencyKey: 'identity-drift-negative', confirmed: true })
    expect(changedIdentity.status).toBe(409)
    expect(await changedIdentity.json()).toMatchObject({ code: 'browser_binding_changed' })
    expect(repository.operations(dueId, 'browser_public_query_recovery')).toHaveLength(0)
    unchangedUnknowns()
  } finally { identity.mockRestore() }
  const beforePrepare = repository.get(dueId)!
  expect(repository.attention(`unknown_${dueId}`)?.status).toBe('pending')
  const oldThread = (await runtime.threadService.get(beforePrepare.threadId))!
  const beforeModelCount = fixture.observed.requests.length
  const prepareRequest = { expectedRevision: beforePrepare.revision, idempotencyKey: 'prepare-new-query', confirmed: true }
  const preparation = await api(`/v1/tasks/${dueId}/prepare-public-query-recovery`, 'POST', prepareRequest)
  expect(preparation.status, await preparation.clone().text()).toBe(200)
  type Prepared = { task: TaskRun; recovery: BrowserPublicQueryRecoverySnapshot; prepared: true; resumed: false }
  const prepared = await preparation.json() as Prepared
  expect(prepared).toMatchObject({ prepared: true, resumed: false, task: { id: dueId, status: 'stalled' }, recovery: { state: 'prepared' } })
  expect(fixture.observed.requests).toHaveLength(beforeModelCount)
  expect((await runtime.threadService.get(beforePrepare.threadId))!.turns).toHaveLength(oldThread.turns.length)
  const duplicatePrepare = await api(`/v1/tasks/${dueId}/prepare-public-query-recovery`, 'POST', prepareRequest)
  expect(duplicatePrepare.status).toBe(200)
  expect((await duplicatePrepare.json() as Prepared).recovery.receiptId).toBe(prepared.recovery.receiptId)
  expect(repository.operations(dueId, 'browser_public_query_recovery')).toHaveLength(1)
  unchangedUnknowns()
  isolateCurrentTurn = true
  delete fixture.observed.failure // Isolated model-fixture bookkeeping, never Runtime history.
  const retryRequest = { expectedRevision: prepared.task.revision, idempotencyKey: 'continue-new-query', publicQueryRecoveryReceiptId: prepared.recovery.receiptId }
  const retryResponse = await api(`/v1/tasks/${dueId}/retry`, 'POST', retryRequest)
  expect(retryResponse.status, await retryResponse.clone().text()).toBe(202)
  const retryResult = await retryResponse.json() as { task: TaskRun }, retryId = retryResult.task.id
  expect(retryId).not.toBe(dueId)
  expect(repository.get(dueId)!.status).toBe('failed')
  expect(repository.attention(`unknown_${dueId}`)?.status).toBe('answered')
  const retry = await verify(await completed(retryId))
  expect(retry.task).toMatchObject({ retryOfTaskId: dueId, rootTaskId: beforePrepare.rootTaskId ?? dueId, goal: beforePrepare.goal, acceptance: beforePrepare.acceptance, scheduledBy: beforePrepare.scheduledBy })
  expect(retry.grant.id).not.toBe((unknownHost.request!.executionGrant as { id: string }).id)
  expect(retry.grant.browserPublicQueryRecovery).toMatchObject({ receiptId: prepared.recovery.receiptId })
  expect(retry.grant.externalTargets).toEqual([])
  expect(retry.grant.allowedToolNames).not.toContain('request_host_shell')
  expect(repository.operations(retryId, 'browser_action_dispatch').every(row => row.request?.sessionId !== failedSessionId)).toBe(true)
  const duplicateRetry = await api(`/v1/tasks/${dueId}/retry`, 'POST', retryRequest)
  expect(duplicateRetry.status).toBe(202)
  expect((await duplicateRetry.json() as { task: TaskRun }).task.id).toBe(retryId)
  unchangedUnknowns()
  expect(JSON.stringify(runtime.flowService!.get(flow.id))).toBe(sealedPlan)
  expect(JSON.stringify(repository.operations(sourceId, 'schedule_authority'))).toBe(sealedAuthorities)
  const nextDueAt = runtime.flowService!.repository.getTriggerState(flow.id, 'schedule')!.nextRunAt!
  expect(nextDueAt).not.toBe(dueAt)
  vi.setSystemTime(new Date(nextDueAt))
  await runtime.flowService!.tickSchedules(new Date())
  const nextOccurrence = () => repository.list().find(task => task.scheduledBy?.scheduleId === flow.id && task.scheduledBy.dueAt === nextDueAt)
  await expect.poll(() => nextOccurrence()?.id, { timeout: 5_000 }).toBeTruthy()
  const future = await verify(await completed(nextOccurrence()!.id))
  expect(future.grant.id).not.toBe(retry.grant.id)
  expect(future.grant.browserPublicQueryRecovery).toMatchObject({ receiptId: prepared.recovery.receiptId })
  expect(future.artifact.sha256).not.toBe(retry.artifact.sha256)
  const tasksBeforeDuplicateTick = repository.list().length
  await runtime.flowService!.tickSchedules(new Date())
  expect(repository.list()).toHaveLength(tasksBeforeDuplicateTick)
  unchangedUnknowns()
  expect(JSON.stringify(runtime.flowService!.get(flow.id))).toBe(sealedPlan)
  expect(JSON.stringify(repository.operations(sourceId, 'schedule_authority'))).toBe(sealedAuthorities)
  expect(unknownNativeAttempts).toBe(1)
  expect(runtime.approvalGate.pending()).toHaveLength(0)
  if (sourceProviderFailure) {
  // The Root failed naturally through the controlled provider above. This second
  // model chooses the local existing-plan reader only and claims no new report.
  expect(repository.get(sourceId)!.status).toBe('failed')
  rootPlanOnly = true
  const rootRetryResponse = await api(`/v1/tasks/${sourceId}/retry`, 'POST', { expectedRevision: repository.get(sourceId)!.revision, idempotencyKey: 'ordinary-source-retry' })
  expect(rootRetryResponse.status, await rootRetryResponse.clone().text()).toBe(202)
  const rootRetryId = (await rootRetryResponse.json() as { task: TaskRun }).task.id
  const rootReadback = () => repository.operations(rootRetryId, 'tool').find(row => row.request?.toolName === 'list_schedules')
  await expect.poll(() => Boolean(rootPlanMissingCatalog) || ['succeeded', 'failed', 'outcome_unknown'].includes(rootReadback()?.status ?? ''), { timeout: 30_000 }).toBe(true)
  expect(rootPlanMissingCatalog, `Missing Root plan reader in actual catalog: ${JSON.stringify(rootPlanMissingCatalog)}`).toBeUndefined()
  expect(rootReadback()?.status, JSON.stringify(rootReadback())).toBe('succeeded')
  const rootReadOutput = (rootReadback()!.result as { item: { output: { schedules: Array<Record<string, unknown>> } } }).item.output
  const expectedAuthorization = (flow.variables.taskSchedule as { authorization: { scopeHash: string } }).authorization
  expect(rootReadOutput.schedules).toContainEqual(expect.objectContaining({ id: flow.id, requirement: source.task.acceptance.schedule,
    sourceTaskId: sourceId, enabled: true, nextRunAt: runtime.flowService!.repository.getTriggerState(flow.id, 'schedule')!.nextRunAt }))
  expect(rootReadOutput.schedules.find(schedule => schedule.id === flow.id)?.authorization).toBe('<omitted>')
  const rawReadbacks = repository.operations(rootRetryId, 'schedule_readback')
  expect(rawReadbacks).toHaveLength(1)
  const rawReadback = rawReadbacks[0]!
  expect(rawReadback.status).toBe('succeeded')
  expect(rawReadback.fingerprint).toBe(operationFingerprint(rawReadback.request))
  expect(rawReadback.request?.retrySourceTaskId).toBe(sourceId)
  expect(Date.parse(rawReadback.createdAt)).toBeGreaterThanOrEqual(Date.parse(rootReadback()!.createdAt))
  expect(Date.parse(rawReadback.updatedAt)).toBeLessThanOrEqual(Date.parse(rootReadback()!.updatedAt))
  expect((rawReadback.result as { schedules: unknown[] }).schedules).toContainEqual(expect.objectContaining({ id: flow.id,
    requirement: source.task.acceptance.schedule, enabled: true, authorization: expect.objectContaining({ scopeHash: expectedAuthorization.scopeHash }) }))
  expect(repository.operations(rootRetryId, 'tool').some(row => row.request?.toolName === 'schedule_task')).toBe(false)
  expect(repository.operations(rootRetryId, 'schedule_authority')).toHaveLength(0)
  expect(runtime.flowService!.list()).toHaveLength(1)
  expect(JSON.stringify(runtime.flowService!.get(flow.id))).toBe(sealedPlan)
  expect(JSON.stringify(repository.operations(sourceId, 'schedule_authority'))).toBe(sealedAuthorities)
  const rootRetryTask = repository.get(rootRetryId)!, rootRetryThread = (await runtime.threadService.get(rootRetryTask.threadId))!
  const rootRetryGrant = rootRetryThread.turns.find(turn => turn.id === rootRetryTask.activeTurnId)!.executionGrant!
  expect(rootRetryGrant).toMatchObject({ taskId: rootRetryId, browserPublicQueryRecovery: { receiptId: prepared.recovery.receiptId, scheduleId: flow.id, versionId: flow.publishedVersionId, planScopeHash: expectedAuthorization.scopeHash } })
  expect(rootRetryGrant.id).not.toBe(source.grant.id)
  expect(rootRetryTask.status).not.toBe('completed')
  expect((await api(`/v1/tasks/${rootRetryId}/pause`, 'POST', { expectedRevision: rootRetryTask.revision, idempotencyKey: 'pause-service-fixture' })).status).toBe(200)
  unchangedUnknowns()
  }
  console.info('[controlled-public-query-recovery]', JSON.stringify({ actualPublicSite: false, actualBrowser: false, realRuntimeHttpSqliteFlow: true,
    initialTaskStatus: source.task.status, stalledDue: dueId, retriedCompleted: retry.task.status, futureDueCompleted: future.task.status,
    unknownReceiptsPreserved: unknownRows.length, oldUnknownResolutionCount: 0, duplicateRetryTasks: 0, duplicateTickTasks: 0,
    prepareModelCalls: 0, oldNativeActionReplays: 0, originalPlanAndSealUnchanged: true, sourceProviderFailure, sourceFinalFailures, sourceRootRetryPlanReadback: sourceProviderFailure, rootPlanModelCalls }))
}

it.each([false, true])('keeps unknown public-query receipts and recovers due runs (source provider failure: %s)', recoveryScenario, 120_000)
