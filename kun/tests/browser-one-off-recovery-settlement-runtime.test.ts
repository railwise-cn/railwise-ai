import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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
import { operationFingerprint } from '../src/services/task-run-repository.js'
import { OneOffPublicQueryRecoveryService } from '../src/services/one-off-public-query-recovery.js'
// @ts-expect-error The exact-package smoke driver is deliberately native JavaScript.
import { startWindowsTaskModelFixture } from '../../scripts/run-windows-ui-smoke.mjs'

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

type Runtime = Awaited<ReturnType<typeof createKunServeRuntime>>
function registerRuntime(runtime: Runtime): () => Promise<void> {
  let open = true
  const close = async (): Promise<void> => { if (open) { open = false; await runtime.shutdown?.() } }
  cleanup.push(close)
  return close
}
function apiFor(runtime: Runtime) {
  const router = buildRouter(runtime)
  return (path: string, method = 'POST', body?: unknown) => dispatchRequest(router, new Request('http://localhost' + path,
    { method, headers: { authorization: 'Bearer synthetic-windows-web', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
}

async function preparedScenario() {
  // Real Runtime, HTTP router, SQLite, permission and served documents. The
  // external model and official native CLI protocol are controlled fixtures.
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '0')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'one-off-settlement-runtime-'))), workspace = join(root, 'workspace')
  await mkdir(workspace); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const fixture = await startWindowsTaskModelFixture({ browser: true, postPlanQuery: false, documentLinkClick: true })
  cleanup.push(() => fixture.close())
  let isolateCurrentTurn = false
  const proxy = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString())
    if (isolateCurrentTurn) {
      // The owned external fixture interprets only the new user turn. Real
      // Runtime history and every persisted receipt remain untouched.
      const start = body.messages.findLastIndex((message: { role: string }) => message.role === 'user')
      expect(start).toBeGreaterThanOrEqual(0)
      body.messages = [...body.messages.slice(0, start).filter((message: { role: string }) => message.role === 'system'), ...body.messages.slice(start)]
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
  const options: Parameters<typeof createKunServeRuntime>[0] = { host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-windows-web',
    apiKey: 'synthetic-local-only', baseUrl: proxyBaseUrl, endpointFormat: 'chat_completions', model: 'windows-task-fixture',
    approvalPolicy: 'on-request', sandboxMode: 'read-only', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' },
    capabilities: KunCapabilitiesConfig.parse({ browserSkill: { enabled: true, state: 'ready', executablePath: join(root, 'synthetic-cli'), executableHash: 'a'.repeat(64),
      version: '0.5.0', daemonProtocolVersion: '1.9', browserInstanceId: 'synthetic-browser', origins: [new URL(fixture.fixtureUrl).origin], interaction: 'interact', revision: 1,
      browsers: [{ id: 'synthetic-browser', name: 'Chrome', label: 'Controlled protocol fixture', connected: true, versionSkew: false, extensionVersion: '0.5.0', protocolVersion: '1.9' }] } }) }
  const runtime = await createKunServeRuntime(options)
  const closeRuntime = registerRuntime(runtime)
  const repository = runtime.taskRepository!, router = buildRouter(runtime)
  const api = (path: string, method = 'POST', body?: unknown) => dispatchRequest(router, new Request('http://localhost' + path,
    { method, headers: { authorization: 'Bearer synthetic-windows-web', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'windows-task-fixture', approvalPolicy: 'on-request' })
  const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'windows-web-source', request: { prompt: `使用 BrowserSkill 公开检索 ${fixture.fixtureUrl} 的工程监测采购公告，读取正文并生成 HTML 报告，仅本次执行。` } })
  expect(started.kind).toBe('capability_required')
  const sourceId = started.task!.id
  const snapshot = await (await api(`/v1/tasks/${sourceId}/browser-binding`, 'GET')).json() as BrowserTaskBindingSnapshot
  const binding = await api(`/v1/tasks/${sourceId}/browser-binding`, 'POST', { confirmed: true, expectedTaskRevision: snapshot.taskRevision,
    expectedBrowserRevision: snapshot.browserRevision, browserInstanceId: snapshot.browserInstanceId, origins: snapshot.origins,
    interaction: 'interact', verificationPolicy: 'public_query_target', publicQueryAuthorization: 'task', idempotencyKey: 'confirm-source' })
  expect(binding.status, await binding.clone().text()).toBe(200)
  expect(repository.get(sourceId)!.status).toBe('waiting_user')
  expect((await runtime.threadService.get(started.task!.threadId))!.turns).toHaveLength(0)
  failNextClick = true
  expect((await api(`/v1/tasks/${sourceId}/resume`, 'POST', { expectedRevision: repository.get(sourceId)!.revision, idempotencyKey: 'start-source' })).status).toBe(202)
  await expect.poll(() => repository.get(sourceId)?.status, { timeout: 30_000 }).toBe('stalled')
  await expect.poll(async () => (await runtime.threadService.get(repository.get(sourceId)!.threadId))!.turns.some(turn => turn.status === 'queued' || turn.status === 'running'), { timeout: 5_000 }).toBe(false)
  expect(repository.get(sourceId)!.acceptance.schedule).toBeUndefined()
  expect(runtime.flowService!.get('schedule_' + sourceId)).toBeNull()
  const unknown = repository.operations(sourceId, 'tool').find(row => row.status === 'outcome_unknown')!
  expect(unknown).toBeTruthy(); expect(unknownNativeAttempts).toBe(1)
  const before = repository.unsettledOperations(sourceId).map(row => JSON.stringify(row))
  sessions.delete(failedSessionId!)
  const review = await api(`/v1/tasks/${sourceId}/receipts/${unknown.id}/verify`, 'POST', { expectedRevision: repository.get(sourceId)!.revision, idempotencyKey: 'one-off-lost-review' })
  expect(await review.json()).toMatchObject({ status: 'outcome_unknown', errorCode: 'not_found' })
  const projectionResponse = await api(`/v1/tasks/${sourceId}/public-query-recovery`, 'GET')
  expect(projectionResponse.status).toBe(200)
  const projection = await projectionResponse.json() as BrowserPublicQueryRecoverySnapshot
  expect(projection, JSON.stringify(projection)).toMatchObject({ taskId: sourceId, state: 'needs_scope_review', mode: 'task_reauthorization' })
  const r = projection.scopeReview!
  const preparation = { expectedRevision: repository.get(sourceId)!.revision, idempotencyKey: 'fresh-settlement', confirmed: true,
    scopeConfirmation: { reviewHash: r.reviewHash, expectedBrowserRevision: r.scope.revision, browserInstanceId: r.scope.browserInstanceId, origins: r.scope.origins, duration: 'task', ttlSeconds: 900, confirmed: true } }
  const modelCalls = fixture.observed.requests.length
  const turnsBefore = (await runtime.threadService.get(started.task!.threadId))!.turns.length
  const preparedResponse = await api(`/v1/tasks/${sourceId}/prepare-public-query-recovery`, 'POST', preparation)
  expect(preparedResponse.status, await preparedResponse.clone().text()).toBe(200)
  const prepared = await preparedResponse.json() as { task: TaskRun; recovery: BrowserPublicQueryRecoverySnapshot; prepared: true; resumed: false }
  expect(prepared).toMatchObject({ prepared: true, resumed: false, recovery: { state: 'prepared' } })
  expect(fixture.observed.requests).toHaveLength(modelCalls)
  expect((await runtime.threadService.get(started.task!.threadId))!.turns).toHaveLength(turnsBefore)
  expect(repository.unsettledOperations(sourceId).map(row => JSON.stringify(row))).toEqual(before)
  return { runtime, closeRuntime, options, fixture, sourceId, prepared, before, modelCalls, turnsBefore, writes, nativeTrace,
    retryRequest: { expectedRevision: prepared.task.revision, idempotencyKey: 'continue-settlement', publicQueryRecoveryReceiptId: prepared.recovery.receiptId },
    isolateModel: () => { isolateCurrentTurn = true; delete fixture.observed.failure } }
}

it('serializes the same fresh-consent retry across two real Runtime instances without duplicate child, use or Turn', async () => {
  const scenario = await preparedScenario()
  const second = await createKunServeRuntime(scenario.options); registerRuntime(second)
  const repository = second.taskRepository!, firstApi = apiFor(scenario.runtime), secondApi = apiFor(second)
  scenario.isolateModel()
  let arrivals = 0, release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const original = OneOffPublicQueryRecoveryService.prototype.forRetry
  const readGate = vi.spyOn(OneOffPublicQueryRecoveryService.prototype, 'forRetry').mockImplementation(async function (this: OneOffPublicQueryRecoveryService, ...args) {
    const result = await original.apply(this, args)
    if (args[0].id === scenario.sourceId && args[1] === scenario.prepared.recovery.receiptId) { arrivals++; await barrier }
    return result
  })
  const requests = [firstApi(`/v1/tasks/${scenario.sourceId}/retry`, 'POST', scenario.retryRequest), secondApi(`/v1/tasks/${scenario.sourceId}/retry`, 'POST', scenario.retryRequest)]
  try { await expect.poll(() => arrivals, { timeout: 5_000 }).toBe(2) } finally { release() }
  const responses = await Promise.all(requests)
  const bodies = await Promise.all(responses.map(response => response.json()))
  expect(responses.map(response => response.status), JSON.stringify(bodies)).toContain(202)
  expect(responses.every(response => [202, 409].includes(response.status)), JSON.stringify(bodies)).toBe(true)
  readGate.mockRestore()
  const turnKey = `task:${scenario.sourceId}:retry:${scenario.retryRequest.idempotencyKey}`
  const childId = `task_retry_${createHash('sha256').update(turnKey).digest('hex')}`
  await expect.poll(() => repository.get(childId)?.status, { timeout: 30_000 }).toBe('completed')
  const child = repository.get(childId)!
  expect(child.artifacts.some(artifact => artifact.sourceEvidenceStatus === 'verified')).toBe(true)
  const binding = repository.operations(child.id, 'browser_binding')
  expect(binding).toHaveLength(1)
  const browserHost = repository.operations(child.id, 'tool').find(row => row.request?.toolName === 'browser_get_html')!
  const grant = browserHost.request?.executionGrant as { id: string; taskId: string; threadId: string; expiresAt: string; browserScope: { publicQueryAuthorization: { receiptId: string } } }
  expect(grant).toMatchObject({ taskId: child.id, threadId: child.threadId, browserScope: { publicQueryAuthorization: { receiptId: binding[0]!.id } } })
  expect(Date.parse(grant.expiresAt)).toBeLessThanOrEqual(Date.parse(scenario.prepared.recovery.consentExpiresAt!))
  const oldHost = repository.operations(scenario.sourceId, 'tool').find(row => row.status === 'outcome_unknown')!
  expect(grant.id).not.toBe((oldHost.request?.executionGrant as { id: string }).id)
  expect(repository.operations(scenario.sourceId, 'browser_public_query_recovery_use')).toHaveLength(1)
  expect(repository.list({ threadId: child.threadId }).filter(task => task.retryOfTaskId === scenario.sourceId).map(task => task.id)).toEqual([childId])
  expect(repository.operation(scenario.sourceId, scenario.retryRequest.idempotencyKey)?.status).toBe('succeeded')
  expect((await second.threadService.get(child.threadId))!.turns).toHaveLength(scenario.turnsBefore + 1)
  expect(repository.unsettledOperations(scenario.sourceId).map(row => JSON.stringify(row))).toEqual(scenario.before)
  expect(second.flowService!.get(`schedule_${scenario.sourceId}`)).toBeNull()
  for (const api of [firstApi, secondApi]) {
    const response = await api(`/v1/tasks/${scenario.sourceId}/retry`, 'POST', scenario.retryRequest)
    expect(response.status, await response.clone().text()).toBe(202)
    expect(await response.json()).toMatchObject({ task: { id: childId } })
  }
  expect((await second.threadService.get(child.threadId))!.turns).toHaveLength(scenario.turnsBefore + 1)
  expect(repository.operations(scenario.sourceId, 'browser_public_query_recovery_use')).toHaveLength(1)
}, 45_000)

it.each(['active', 'expired', 'revoked'] as const)('settles a genuine pre-Turn crash with %s consent to waiting_user without executing or renewing it', async state => {
  const scenario = await preparedScenario(), repository = scenario.runtime.taskRepository!
  const nativeWritesBefore = scenario.writes.length
  const nativeStarts = () => scenario.nativeTrace.filter(entry => entry.argv[0] === 'session' && entry.argv[1] === 'start').length
  const nativeStartsBefore = nativeStarts()
  let entered = false, terminate!: () => void, terminated = false
  const termination = new Promise<void>(resolve => { terminate = resolve })
  // Hold BEFORE the public original startTurn. TaskControl's actual transaction
  // has persisted child, own binding and use; there is no Turn pending-start.
  vi.spyOn(scenario.runtime.turnService, 'startTurn').mockImplementationOnce(async () => {
    entered = true
    await termination
    // Explicit termination after evidence collection never invokes startTurn.
    throw Object.assign(new Error('test-owned stopped Runtime'), { code: 'runtime_stopped' })
  })
  const pendingHttp = apiFor(scenario.runtime)(`/v1/tasks/${scenario.sourceId}/retry`, 'POST', scenario.retryRequest)
  const stopOldRequest = async (): Promise<void> => {
    if (terminated) return
    terminated = true
    await scenario.closeRuntime()
    terminate()
    expect((await pendingHttp).status).toBe(500)
  }
  cleanup.push(stopOldRequest)
  await expect.poll(() => entered, { timeout: 5_000 }).toBe(true)
  const turnKey = `task:${scenario.sourceId}:retry:${scenario.retryRequest.idempotencyKey}`
  const childId = `task_retry_${createHash('sha256').update(turnKey).digest('hex')}`
  const child = repository.get(childId)!
  expect(child).toMatchObject({ status: 'queued', retryOfTaskId: scenario.sourceId })
  expect(child.activeTurnId).toBeUndefined()
  expect(repository.operation(scenario.sourceId, scenario.retryRequest.idempotencyKey)).toMatchObject({ status: 'prepared' })
  const ownBinding = repository.operations(childId, 'browser_binding')
  expect(ownBinding).toHaveLength(1)
  expect(ownBinding[0]!.fingerprint).toBe(operationFingerprint(ownBinding[0]!.request))
  const uses = repository.operations(scenario.sourceId, 'browser_public_query_recovery_use')
  expect(uses).toHaveLength(1); expect(uses[0]!.status).toBe('succeeded')
  const consent = repository.operationById(scenario.sourceId, scenario.prepared.recovery.consentReceiptId!)!
  const originalConsent = JSON.stringify(consent), bindingBytes = JSON.stringify(ownBinding)
  const usedBudget = repository.execution.usedExecutionMs(scenario.sourceId, Date.now())
  expect((await scenario.runtime.threadService.get(child.threadId))!.turns).toHaveLength(scenario.turnsBefore)
  expect(scenario.fixture.observed.requests).toHaveLength(scenario.modelCalls)
  await scenario.closeRuntime()
  if (state === 'expired') { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 901_000) }
  const restarted = await createKunServeRuntime(scenario.options); registerRuntime(restarted)
  const freshRepository = restarted.taskRepository!, api = apiFor(restarted)
  if (state === 'revoked') {
    const response = await api(`/v1/tasks/${scenario.sourceId}/revoke-public-query-recovery`, 'POST', { expectedRevision: freshRepository.get(scenario.sourceId)!.revision, idempotencyKey: 'revoke-crashed-consent', confirmed: true, consentReceiptId: consent.id })
    expect(response.status, await response.clone().text()).toBe(200)
  }
  const describe = async () => ({ source: freshRepository.get(scenario.sourceId), child: freshRepository.get(childId), control: freshRepository.operation(scenario.sourceId, scenario.retryRequest.idempotencyKey), childOperations: freshRepository.operations(childId), childLease: freshRepository.getLease(childId), thread: await restarted.threadService.get(child.threadId), modelCalls: scenario.fixture.observed.requests.length, expectedModelCalls: scenario.modelCalls, unknownRowHashes: freshRepository.unsettledOperations(scenario.sourceId).map(row => ({ id: row.id, kind: row.kind, sha256: createHash('sha256').update(JSON.stringify(row)).digest('hex') })) })
  const beforeSettlement = await describe()
  const settled = await api(`/v1/tasks/${scenario.sourceId}/retry`, 'POST', scenario.retryRequest)
  const evidence = { state, beforeSettlement, afterSettlement: await describe(), httpStatus: settled.status, httpBody: await settled.clone().text() }
  if (process.env.RAILWISE_SETTLEMENT_TRACE_DIR) await writeFile(join(process.env.RAILWISE_SETTLEMENT_TRACE_DIR, `oneoff-settlement-${state}.json`), JSON.stringify(evidence, null, 2) + '\n')
  expect(settled.status, JSON.stringify(evidence)).toBe(202)
  expect(await settled.json()).toMatchObject({ task: { id: childId, status: 'waiting_user' } })
  expect(freshRepository.get(childId)!.activeTurnId).toBeUndefined()
  expect((await restarted.threadService.get(child.threadId))!.turns).toHaveLength(scenario.turnsBefore)
  expect(scenario.fixture.observed.requests).toHaveLength(scenario.modelCalls)
  expect(freshRepository.unsettledOperations(scenario.sourceId).map(row => JSON.stringify(row))).toEqual(scenario.before)
  expect(JSON.stringify(freshRepository.operationById(scenario.sourceId, consent.id))).toBe(originalConsent)
  expect(JSON.stringify(freshRepository.operations(childId, 'browser_binding'))).toBe(bindingBytes)
  expect(freshRepository.operations(scenario.sourceId, 'browser_public_query_recovery_use')).toHaveLength(1)
  expect(freshRepository.list({ threadId: child.threadId }).filter(task => task.retryOfTaskId === scenario.sourceId).map(task => task.id)).toEqual([childId])
  expect(freshRepository.execution.usedExecutionMs(scenario.sourceId, Date.now())).toBe(usedBudget)
  expect(scenario.writes).toHaveLength(nativeWritesBefore)
  expect(nativeStarts()).toBe(nativeStartsBefore)
  const duplicate = await api(`/v1/tasks/${scenario.sourceId}/retry`, 'POST', scenario.retryRequest)
  expect(duplicate.status).toBe(202)
  expect(await duplicate.json()).toMatchObject({ task: { id: childId, status: 'waiting_user' } })
  if (state !== 'active') {
    const projection = await api(`/v1/tasks/${childId}/public-query-recovery`, 'GET')
    expect(await projection.json()).toMatchObject({ state: 'needs_scope_review', mode: 'task_reauthorization' })
  }
  await stopOldRequest()
  expect(scenario.writes).toHaveLength(nativeWritesBefore)
  expect(nativeStarts()).toBe(nativeStartsBefore)
  // Even after terminating its old HTTP request, that stopped instance cannot
  // create a late Turn, change the sealed consent or replay native commands.
  expect(scenario.fixture.observed.requests).toHaveLength(scenario.modelCalls)
  expect((await restarted.threadService.get(child.threadId))!.turns).toHaveLength(scenario.turnsBefore)
  expect(JSON.stringify(freshRepository.operationById(scenario.sourceId, consent.id))).toBe(originalConsent)
  expect(freshRepository.unsettledOperations(scenario.sourceId).map(row => JSON.stringify(row))).toEqual(scenario.before)
}, 45_000)
