import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Window, type HTMLElement, type HTMLInputElement } from 'happy-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import type { BrowserTaskBindingSnapshot } from '../src/contracts/browser-skill.js'
import type { TaskRun } from '../src/contracts/tasks.js'
import type { BrowserCommandRunner } from '../src/services/browser-skill-cli.js'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { buildRouter } from '../src/server/routes/index.js'
import { TaskScheduleService } from '../src/services/task-schedule-service.js'
import { dispatchRequest } from '../src/server/http-server.js'
// @ts-expect-error The exact-package smoke driver is deliberately native JavaScript.
import { startWindowsTaskModelFixture, windowsTaskPrompt, inspectWindowsPersistedWebArtifact, inspectWindowsBrowserPolicy, inspectWindowsQueryThread } from '../../scripts/run-windows-ui-smoke.mjs'

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

it.each(['current-only', 'post-plan-query', 'other-running', 'unresolved-outcome'] as const)('validates an existing source plan with %s through the real Host and Provider dispatch boundaries', async fault => {
  // This exercises real Runtime/HTTP/SQLite/Flow and served fixture documents.
  // The BrowserSkill CLI protocol is a local DOM fixture, not a real browser.
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '0')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'windows-web-artifact-runtime-'))), workspace = join(root, 'workspace')
  await mkdir(workspace); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const postPlanQuery = fault === 'post-plan-query'
  const fixture = await startWindowsTaskModelFixture({ browser: true, postPlanQuery })
  cleanup.push(() => fixture.close())
  // The same served source/model fixture now creates its real durable plan
  // before the first fill, matching the production failure's chronology.
  let insertedPlan = false, faultInjected = false, proofBoundariesChecked = false
  let currentCall: { callId: string; toolName: string; providerId: string; arguments: Record<string, unknown> } | undefined
  let beforeFirstFill: (() => Promise<void>) | undefined
  let activeResolution: { service: TaskScheduleService; context: Parameters<TaskScheduleService['resolveBrowserActions']>[0]; sourceId?: string } | undefined
  const originalResolver = TaskScheduleService.prototype.resolveBrowserActions
  vi.spyOn(TaskScheduleService.prototype, 'resolveBrowserActions').mockImplementation(async function (this: TaskScheduleService, context, sourceId) {
    activeResolution = { service: this, context, sourceId }
    const identity = context.currentToolOperation?.()
    if (fault === 'current-only' && !proofBoundariesChecked && currentCall && identity?.toolName === 'browser_fill' &&
      repository.operation(identity.taskId, identity.idempotencyKey)?.status === 'running') {
      proofBoundariesChecked = true
      const exactCall = currentCall
      const controller = runtime.taskController!, token = controller.tokenForTurn(context.turnId)!, grant = context.executionGrant!
      expect(controller.currentToolOperation(token, identity.idempotencyKey, exactCall, grant)).toEqual(identity)
      for (const changed of [
        { ...currentCall, callId: 'other-call' }, { ...currentCall, providerId: 'other-provider' },
        { ...currentCall, arguments: { ...currentCall.arguments, value: 'different-query' } }
      ]) expect(() => controller.currentToolOperation(token, identity.idempotencyKey, changed, grant)).toThrow()
      expect(() => controller.currentToolOperation(token, identity.idempotencyKey, exactCall, { ...grant, id: 'different-grant' })).toThrow()
      expect(() => controller.currentToolOperation({ ...token, executionId: 'old-attempt' }, identity.idempotencyKey, exactCall, grant)).toThrow()
      for (const changed of [
        { ...identity, operationId: 'another-operation' }, { ...identity, turnId: 'another-turn' },
        { ...identity, argumentsHash: '0'.repeat(64) }, { ...identity, executionId: 'old-attempt' },
        { ...identity, providerId: 'other-provider' }, { ...identity, executionGrantFingerprint: '0'.repeat(64) }
      ]) await expect(originalResolver.call(this, { ...context, currentToolOperation: () => changed }, sourceId))
        .rejects.toMatchObject({ code: 'browser_schedule_outcome_unknown' })
      await expect(originalResolver.call(this, { ...context, currentToolOperation: undefined }, sourceId))
        .rejects.toMatchObject({ code: 'browser_schedule_outcome_unknown' })
      // Saving/publishing a plan is never allowed to borrow the current-action
      // exception, even when called with the genuine runtime callback.
      await expect(this.create(context)).rejects.toMatchObject({ code: 'browser_schedule_outcome_unknown' })
    }
    return originalResolver.call(this, context, sourceId)
  })
  let dispatchedRecheckBlocked = false
  const modelProxy = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const upstream = await fetch(fixture.baseUrl + '/chat/completions', { method: request.method,
      headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) })
    let output = await upstream.text()
    if (!postPlanQuery && !insertedPlan && output.includes('"id":"smoke-fill"')) {
      expect(output).toContain('"name":"browser_fill"')
      insertedPlan = true
      output = output.replace('"id":"smoke-fill"', '"id":"smoke-schedule"')
        .replace(/"name":"browser_fill","arguments":"(?:[^"\\]|\\.)*"/, '"name":"schedule_task","arguments":"{}"')
    }
    if (insertedPlan && !faultInjected && output.includes('"id":"smoke-fill"')) {
      faultInjected = true
      await beforeFirstFill?.()
    }
    const data = output.split('\n').find(line => line.startsWith('data: {'))
    const call = data && JSON.parse(data.slice(6)).choices?.[0]?.delta?.tool_calls?.[0]
    if (call?.function?.name === 'browser_fill') currentCall = { callId: call.id, toolName: call.function.name,
      providerId: 'browser-skill', arguments: JSON.parse(call.function.arguments) }
    response.writeHead(upstream.status, { 'content-type': 'text/event-stream' }); response.end(output)
  })
  await new Promise<void>(resolve => modelProxy.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { modelProxy.close(() => resolve()); modelProxy.closeAllConnections() }))
  const proxyAddress = modelProxy.address() as { port: number }
  type Session = { url: string; tab: number; context: number; window: Window }
  const sessions = new Map<string, Session>(), windows: Window[] = [], writes: Array<{ sessionId: string; action: string }> = []
  let count = 0
  cleanup.push(async () => { for (const window of windows) await window.happyDOM.close() })
  browser.run = async (_configuration, args) => {
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
    if (!session) throw new Error('Unknown local protocol session')
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
      const controls = [...doc.querySelectorAll('input,[role="button"],button')].map(node => {
        const input = node.tagName === 'INPUT'
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
      if (args[0] === 'fill' && !dispatchedRecheckBlocked && activeResolution?.context.executionGrant?.taskId && runtime.flowService!.get('schedule_' + activeResolution.context.executionGrant.taskId)) {
        // A real Provider dispatch row already exists and the CLI boundary has
        // now been entered. Even the exact current Host proof must not exempt it.
        expect(activeResolution).toBeTruthy()
        await expect(originalResolver.call(activeResolution!.service, activeResolution!.context, activeResolution!.sourceId))
          .rejects.toMatchObject({ code: 'browser_schedule_outcome_unknown' })
        dispatchedRecheckBlocked = true
      }
      writes.push({ sessionId, action: args[0] })
      if (args[0] === 'fill') (target as HTMLInputElement).value = args[args.indexOf('--value') + 1]!
      else (target as HTMLElement).click()
      return { ok: true, output: { tab_id: session.tab } }
    }
    throw new Error('Unexpected local native protocol command')
  }
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-windows-web',
    apiKey: 'synthetic-local-only', baseUrl: `http://127.0.0.1:${proxyAddress.port}/v1`, endpointFormat: 'chat_completions', model: 'windows-task-fixture',
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
  let injectedReceiptId: string | undefined
  beforeFirstFill = async () => {
    if (fault === 'current-only' || postPlanQuery) return
    const task = repository.get(sourceId)!
    if (fault === 'other-running') {
      const thread = (await runtime.threadService.get(task.threadId))!
      const grant = thread.turns.find(turn => turn.id === task.activeTurnId)!.executionGrant!
      const pending = runtime.taskController!.beginToolOperation(task.activeTurnId!, {
        callId: 'other-unfinished-query', toolName: 'browser_click', providerId: 'browser-skill',
        arguments: { sessionId: 'other-session', contextId: 'other-context', target: '@e99' }
      }, grant)!
      runtime.taskController!.recordToolDispatch(pending.token, pending.key)
      injectedReceiptId = repository.operation(task.id, pending.key)!.id
    } else {
      const pending = repository.beginOperation({ ownerId: task.id, idempotencyKey: 'unresolved-earlier-browser-result',
        kind: 'browser_schedule_action_outcome', request: { turnId: 'previous-turn', action: 'click' }, nowIso: new Date().toISOString() })
      injectedReceiptId = repository.finishOperation(task.id, pending.receipt.idempotencyKey, { status: 'outcome_unknown' }, new Date().toISOString())!.id
    }
  }
  expect((await api(`/v1/tasks/${sourceId}/resume`, 'POST', { expectedRevision: repository.get(sourceId)!.revision, idempotencyKey: 'start-source' })).status).toBe(202)
  if (fault === 'other-running' || fault === 'unresolved-outcome') {
    await expect.poll(async () => {
      const task = repository.get(sourceId)!, thread = (await runtime.threadService.get(task.threadId))!
      return thread.turns.flatMap(turn => turn.items).some(item => item.kind === 'tool_result' && item.callId === 'smoke-fill' &&
        item.isError === true && (item.output as { code?: string })?.code === 'browser_schedule_outcome_unknown')
    }, { timeout: 10_000 }).toBe(true)
    expect(injectedReceiptId).toBeTruthy()
    expect(repository.operations(sourceId).find(receipt => receipt.id === injectedReceiptId)?.status)
      .toBe(fault === 'other-running' ? 'running' : 'outcome_unknown')
    expect(repository.operations(sourceId, 'browser_action_dispatch')).toHaveLength(0)
    expect(writes).toHaveLength(0)
    expect(repository.get(sourceId)!.status).not.toBe('completed')
    return
  }

  const completed = async (id: string) => {
    try { await expect.poll(() => {
      const task = repository.get(id)!
      return { status: task.status, reason: task.waitingReason ?? task.stalledReason ?? null }
    }, { timeout: 30_000 }).toEqual({ status: 'completed', reason: null }) } catch (error) {
      const saved = repository.get(id)!, thread = await runtime.threadService.get(saved.threadId)
      throw new Error(JSON.stringify({ state: saved.status, requests: fixture.observed.requests.slice(-4), turns: thread?.turns.map(turn => ({ status: turn.status, error: turn.error,
        results: turn.items.filter(item => item.kind === 'tool_result' && item.isError) })) }), { cause: error })
    }
    return repository.get(id)!
  }
  const verify = async (task: TaskRun) => {
    const thread = (await runtime.threadService.get(task.threadId))!, receipts = repository.operations(task.id)
    const artifact = task.artifacts.find(item => item.format === 'html' && item.validation === 'valid')!
    const bytes = await readFile(artifact.absolutePath!)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256)
    const result = inspectWindowsPersistedWebArtifact(task, thread, receipts, artifact, fixture)
    if (postPlanQuery) {
      const query = inspectWindowsQueryThread(thread, fixture, { initial: !task.scheduledBy })
      expect(query.actions).toBe(task.scheduledBy ? 2 : 4)
      if (!task.scheduledBy) expect(query.postPlanQuery).toMatchObject({ verified: true, actions: 2,
        startedAfterScheduleReadback: true, freshSession: true, acknowledgementAndReadbackVerified: true })
      const policy = inspectWindowsBrowserPolicy(task, thread,
        [...repository.operations(sourceId, 'browser_binding'), ...receipts], fixture)
      expect(policy.dispatches).toHaveLength(task.scheduledBy ? 2 : 4)
      expect(policy.dispatches.filter((item: { phase: string }) => item.phase === 'post_plan')).toHaveLength(task.scheduledBy ? 0 : 2)
    }
    expect(result.persistedReceiptVerified).toBe(true)
    expect(artifact).toMatchObject({ sourceEvidenceStatus: 'verified', sourceEvidenceReceiptId: result.evidenceReceiptId })
    expect(receipts.filter(item => item.kind === 'web_artifact_evidence')).toHaveLength(1)
    expect(receipts.filter(item => item.kind === 'browser_action_dispatch')).toHaveLength(postPlanQuery && !task.scheduledBy ? 4 : 2)
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
    return { task, thread, artifact, result, grant: thread.turns.find(turn => turn.executionGrant)!.executionGrant! }
  }
  const source = await verify(await completed(sourceId))
  expect(insertedPlan).toBe(!postPlanQuery)
  expect(dispatchedRecheckBlocked).toBe(true)
  expect(proofBoundariesChecked).toBe(!postPlanQuery)
  const sourceReceipts = repository.operations(sourceId)
  const savedPlan = sourceReceipts.find(receipt => receipt.kind === 'schedule_authority' && receipt.status === 'succeeded')!
  const firstDispatch = sourceReceipts.filter(receipt => receipt.kind === 'browser_action_dispatch')[postPlanQuery ? 2 : 0]!
  expect(Date.parse(savedPlan.createdAt)).toBeLessThanOrEqual(Date.parse(firstDispatch.createdAt))
  const hosts = sourceReceipts.filter(receipt => receipt.kind === 'tool' && ['browser_click', 'browser_fill'].includes(String(receipt.request?.toolName)))
  expect(hosts).toHaveLength(postPlanQuery ? 4 : 2)
  expect(hosts.every(receipt => receipt.status === 'succeeded' && typeof receipt.request?.executionId === 'string')).toBe(true)
  const flow = runtime.flowService!.get('schedule_' + sourceId)!
  expect(flow).toBeTruthy()
  const dueAt = runtime.flowService!.repository.getTriggerState(flow.id, 'schedule')!.nextRunAt!
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(dueAt))
  await runtime.flowService!.tickSchedules(new Date())
  const occurrence = () => repository.list().find(task => task.scheduledBy?.scheduleId === flow.id && task.scheduledBy.dueAt === dueAt)
  await expect.poll(() => occurrence()?.id, { timeout: 5_000 }).toBeTruthy()
  const due = await verify(await completed(occurrence()!.id))
  expect(due.task.id).not.toBe(source.task.id)
  expect(due.task.threadId).not.toBe(source.task.threadId)
  expect(due.grant.id).not.toBe(source.grant.id)
  expect(due.grant.browserScheduleBinding).toMatchObject({ sourceTaskId: sourceId, scheduleId: flow.id, versionId: flow.publishedVersionId })
  expect(due.artifact.absolutePath).not.toBe(source.artifact.absolutePath)
  // This controlled source changes a real read-version per GET. Unchanged
  // real-world sources may legitimately produce the same content hash.
  expect(due.artifact.sha256).not.toBe(source.artifact.sha256)
  expect(due.result.evidenceReceiptId).not.toBe(source.result.evidenceReceiptId)
  expect(due.result.sourceReceipts.every((receipt: { turnId: string }) => receipt.turnId === due.task.activeTurnId)).toBe(true)
  expect(repository.operations(due.task.id, 'browser_binding')).toHaveLength(0)
  expect(repository.operations(due.task.id, 'browser_derived_action_authorization')).toHaveLength(2)
  expect(repository.operation(due.task.threadId, 'scheduled-task-context')).toMatchObject({ kind: 'scheduled_task_prepare', status: 'succeeded',
    request: { scheduleId: flow.id, versionId: flow.publishedVersionId, dueAt } })
  expect(sessions.size).toBe(0)
  expect(writes).toHaveLength(postPlanQuery ? 6 : 4)
  expect(new Set(writes.map(write => write.sessionId)).size).toBe(postPlanQuery ? 3 : 2)
  expect(fixture.observed.requests.every((request: { status: number }) => request.status === 200)).toBe(true)
  expect(fixture.observed.catalogs.every((names: string[]) => names.includes('verify_web_artifact'))).toBe(true)
  console.info('[controlled-runtime-evidence]', JSON.stringify({ scope: 'local-model-and-native-browser-protocol-fixture',
    source: { taskId: source.task.id, artifactSha256: source.artifact.sha256, evidence: source.result },
    due: { taskId: due.task.id, artifactSha256: due.artifact.sha256, evidence: due.result, publishedFlowVersionId: flow.publishedVersionId },
    separateTasks: true, separateGrants: true, changedSourceVersion: true, modelRequests: fixture.observed.requests.length,
    browserDispatches: writes.length, perActionApprovals: 0, unknownOutcomes: 0 }))
}, 45_000)
