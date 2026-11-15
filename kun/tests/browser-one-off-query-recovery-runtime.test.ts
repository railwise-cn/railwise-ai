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
import { RuntimeEventRecorder } from '../src/services/runtime-event-recorder.js'
import { OneOffPublicQueryRecoveryService,type OneOffPrepare } from '../src/services/one-off-public-query-recovery.js'
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

async function oneOffScenario(requirePermission: boolean, renewScope=false): Promise<void> {
  const sourceProviderFailure = false
  // This exercises real Runtime/HTTP/SQLite/Flow and served fixture documents.
  // The BrowserSkill CLI protocol is a local DOM fixture, not a real browser.
  vi.stubEnv('RAILWISE_TASK_SCHEDULING_DISABLED', '0')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'windows-web-artifact-runtime-'))), workspace = join(root, 'workspace')
  await mkdir(workspace); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const fixture = await startWindowsTaskModelFixture({ browser: true, postPlanQuery: false, documentLinkClick: true })
  cleanup.push(() => fixture.close())
  // Only this controlled external model proxy isolates the new turn's messages.
  // Runtime checkpoints/history and all real receipts remain untouched.
  let isolateCurrentTurn = false
  let rootPlanOnly = false
  let rootPlanModelCalls = 0
  let rootPlanMissingCatalog: string[] | undefined
  let sourceFinalFailures = 0
  let freshOutputFailures=0
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
    if(renewScope&&isolateCurrentTurn&&!freshOutputFailures&&sourceCalled.has('smoke-verify-web-artifact')){
      freshOutputFailures++
      response.writeHead(200,{'content-type':'text/event-stream'})
      response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:'Synthetic output limit after the actual verified report.'},finish_reason:'length'}]})}\n\ndata: [DONE]\n\n`)
      return
    }
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
  // Hold the genuine async event boundary after Task becomes stalled but
  // before the original Turn is durably terminal. No Runtime row is edited.
  let releaseUnknownTurn: (() => void) | undefined
  let heldUnknownTurn: { threadId: string; turnId: string } | undefined
  const unknownTurnBarrier = new Promise<void>(resolve => { releaseUnknownTurn = resolve })
  const originalRecord = RuntimeEventRecorder.prototype.record
  if (sourceProviderFailure) vi.spyOn(RuntimeEventRecorder.prototype, 'record').mockImplementation(async function (this: RuntimeEventRecorder, draft) {
    if (!heldUnknownTurn && draft.kind === 'error' && draft.code === 'outcome_unknown' && draft.turnId) {
      heldUnknownTurn = { threadId: draft.threadId, turnId: draft.turnId }
      await unknownTurnBarrier
    }
    return originalRecord.call(this, draft)
  })
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
  cleanup.push(async () => { releaseUnknownTurn?.() })
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
  if(requirePermission){
    const permission=await (await api(`/v1/tasks/${sourceId}/permissions`,'GET')).json() as import('../src/services/task-permission-service.js').TaskPermissionSnapshot
    expect(permission.canConfirm,JSON.stringify(permission)).toBe(true)
    expect((await api(`/v1/tasks/${sourceId}/permissions`,'POST',{expectedRevision:permission.taskRevision,idempotencyKey:'source-temporary-permission',scopeHash:permission.scopeHash,confirmed:true,approvalPolicy:'on-request',ttlSeconds:60})).status).toBe(200)
  }
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
  if(requirePermission){vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+61_000)}
  const response = await api(`/v1/tasks/${sourceId}/public-query-recovery`, 'GET')
  const projection = await response.json() as BrowserPublicQueryRecoverySnapshot
  expect(projection,JSON.stringify(projection)).toMatchObject({ taskId: sourceId, state: 'needs_scope_review', mode: 'task_reauthorization' })
  expect(repository.unsettledOperations(sourceId).map(row => JSON.stringify(row))).toEqual(before)
  const r = projection.scopeReview!
  const request:OneOffPrepare={expectedRevision:repository.get(sourceId)!.revision,idempotencyKey:'fresh-once',confirmed:true,scopeConfirmation:{reviewHash:r.reviewHash,expectedBrowserRevision:r.scope.revision,browserInstanceId:r.scope.browserInstanceId,origins:r.scope.origins,duration:'task',ttlSeconds:900,confirmed:true}}
  const callsBefore=fixture.observed.requests.length,turnsBefore=(await runtime.threadService.get(started.task!.threadId))!.turns.length
  const beforeBad=JSON.stringify(repository.get(sourceId))
  expect((await api(`/v1/tasks/${sourceId}/prepare-public-query-recovery`,'POST',{expectedRevision:request.expectedRevision,idempotencyKey:'missing-checkbox-scope',confirmed:true})).status).toBe(409)
  expect((await api(`/v1/tasks/${sourceId}/prepare-public-query-recovery`,'POST',{...request,idempotencyKey:'bad-ttl',scopeConfirmation:{...request.scopeConfirmation,ttlSeconds:901}})).status).toBe(400)
  expect((await api(`/v1/tasks/${sourceId}/prepare-public-query-recovery`,'POST',{...request,idempotencyKey:'scope-mismatch',scopeConfirmation:{...request.scopeConfirmation,origins:['https://other.invalid']}})).status).toBe(409)
  expect(JSON.stringify(repository.get(sourceId))).toBe(beforeBad)
  const contextMethod=OneOffPublicQueryRecoveryService.prototype.context
  let arrivals=0,releasePrepare!:()=>void,concurrentPrepare:ReturnType<OneOffPublicQueryRecoveryService['prepare']>|undefined
  const prepareBarrier=new Promise<void>(resolve=>{releasePrepare=resolve})
  const contextSpy=vi.spyOn(OneOffPublicQueryRecoveryService.prototype,'context').mockImplementation(async function(this:OneOffPublicQueryRecoveryService,task){
    const context=await contextMethod.call(this,task)
    if(task.id===sourceId&&arrivals<2){
      // HTTP mutations within one Runtime are intentionally queued. Exercise the
      // service's cross-await transaction race directly using the same real
      // provenance, as a competing Runtime would, without bypassing validation.
      if(++arrivals===1)concurrentPrepare=this.prepare(sourceId,request)
      else releasePrepare()
      await prepareBarrier
    }
    return context
  })
  const prepResponse=await api(`/v1/tasks/${sourceId}/prepare-public-query-recovery`,'POST',request).finally(()=>contextSpy.mockRestore())
  expect(prepResponse.status,await prepResponse.clone().text()).toBe(200)
  let prepared=await prepResponse.json() as {task:TaskRun;recovery:BrowserPublicQueryRecoverySnapshot;prepared:true;resumed:false}
  expect((await concurrentPrepare!).recovery.receiptId).toBe(prepared.recovery.receiptId)
  expect(repository.operations(sourceId,'browser_public_query_scope_consent')).toHaveLength(1)
  expect(prepared).toMatchObject({prepared:true,resumed:false,recovery:{state:'prepared',mode:'task_reauthorization'}})
  expect(fixture.observed.requests).toHaveLength(callsBefore)
  expect((await runtime.threadService.get(started.task!.threadId))!.turns).toHaveLength(turnsBefore)
  expect(count).toBe(1)
  const consentBefore=repository.operationById(sourceId,prepared.recovery.consentReceiptId!)!
  const duplicate=await api(`/v1/tasks/${sourceId}/prepare-public-query-recovery`,'POST',request)
  expect(duplicate.status).toBe(200)
  expect((await duplicate.json() as typeof prepared).recovery.receiptId).toBe(prepared.recovery.receiptId)
  if(!requirePermission){
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+901_000)
    const expired=await (await api(`/v1/tasks/${sourceId}/public-query-recovery`,'GET')).json() as BrowserPublicQueryRecoverySnapshot
    expect(expired).toMatchObject({state:'needs_scope_review',consentReceiptId:prepared.recovery.consentReceiptId})
    expect((await api(`/v1/tasks/${sourceId}/retry`,'POST',{expectedRevision:prepared.task.revision,idempotencyKey:'expired-must-not-run',publicQueryRecoveryReceiptId:prepared.recovery.receiptId})).status).toBe(409)
    expect(repository.operations(sourceId,'retry')).toHaveLength(0)
    expect((await api(`/v1/tasks/${sourceId}/prepare-public-query-recovery`,'POST',request)).status).toBe(200)
    expect(repository.operationById(sourceId,consentBefore.id)).toEqual(consentBefore)
    request.expectedRevision=repository.get(sourceId)!.revision;request.idempotencyKey='fresh-once-after-expiry'
    prepared=await (await api(`/v1/tasks/${sourceId}/prepare-public-query-recovery`,'POST',request)).json() as typeof prepared
    const revoked=await api(`/v1/tasks/${sourceId}/revoke-public-query-recovery`,'POST',{expectedRevision:prepared.task.revision,idempotencyKey:'revoke-once',confirmed:true,consentReceiptId:prepared.recovery.consentReceiptId})
    expect(revoked.status,await revoked.clone().text()).toBe(200)
    expect(await (await api(`/v1/tasks/${sourceId}/public-query-recovery`,'GET')).json()).toMatchObject({state:'needs_scope_review',consentRevoked:true})
    expect((await api(`/v1/tasks/${sourceId}/retry`,'POST',{expectedRevision:repository.get(sourceId)!.revision,idempotencyKey:'revoked-must-not-run',publicQueryRecoveryReceiptId:prepared.recovery.receiptId})).status).toBe(409)
    expect(repository.operations(sourceId,'retry')).toHaveLength(0)
    request.expectedRevision=repository.get(sourceId)!.revision;request.idempotencyKey='fresh-once-after-revoke'
    prepared=await (await api(`/v1/tasks/${sourceId}/prepare-public-query-recovery`,'POST',request)).json() as typeof prepared
  }
  expect(fixture.observed.requests).toHaveLength(callsBefore)
  isolateCurrentTurn=true; delete fixture.observed.failure
  const retryResponse=await api(`/v1/tasks/${sourceId}/retry`,'POST',{expectedRevision:prepared.task.revision,idempotencyKey:'continue-once',publicQueryRecoveryReceiptId:prepared.recovery.receiptId})
  expect(retryResponse.status,await retryResponse.clone().text()).toBe(202)
  const retryResult=await retryResponse.json() as {task:TaskRun;capability?:{errorCode?:string}},retry=retryResult.task as TaskRun
  if(requirePermission){
    expect(retry).toMatchObject({status:'waiting_user'})
    expect(retryResult.capability).toMatchObject({errorCode:'task_permission_expired'})
    expect(fixture.observed.requests).toHaveLength(callsBefore)
    expect((await runtime.threadService.get(retry.threadId))!.turns).toHaveLength(turnsBefore)
    const permission=await (await api(`/v1/tasks/${retry.id}/permissions`,'GET')).json() as import('../src/services/task-permission-service.js').TaskPermissionSnapshot
    expect(permission.canConfirm,JSON.stringify(permission)).toBe(true)
    expect(permission.grant).toBeUndefined()
    expect((await api(`/v1/tasks/${retry.id}/permissions`,'POST',{expectedRevision:permission.taskRevision,idempotencyKey:'child-own-permission',scopeHash:permission.scopeHash,confirmed:true,approvalPolicy:'on-request',ttlSeconds:600})).status).toBe(200)
    expect(repository.get(retry.id)!.authority!.taskApprovalGrant!.taskId).toBe(retry.id)
    const resumed=await api(`/v1/tasks/${retry.id}/resume`,'POST',{expectedRevision:repository.get(retry.id)!.revision,idempotencyKey:'continue-own-permission'})
    expect(resumed.status,await resumed.clone().text()).toBe(202)
  }
  try { await expect.poll(()=>repository.get(retry.id)?.status,{timeout:30_000}).toBe(renewScope?'failed':'completed') }
  catch(error){throw new Error(JSON.stringify({task:repository.get(retry.id),requests:fixture.observed.requests.slice(-3),ops:repository.operations(retry.id).slice(-6),human:repository.humanRequests('approval')}),{cause:error})}
  const child=repository.get(retry.id)!,newBinding=repository.operations(child.id,'browser_binding')
  expect(newBinding).toHaveLength(1);expect(child.authority!.browserScope!.publicQueryAuthorization!.receiptId).toBe(newBinding[0]!.id)
  expect(child.authority!.browserScope!.publicQueryAuthorization!.receiptId).not.toBe(snapshot.publicQueryAuthorization?.receiptId)
  expect(repository.operations(child.id,'web_artifact_evidence').some(r=>r.status==='succeeded')).toBe(true)
  expect(repository.unsettledOperations(sourceId).map(row=>JSON.stringify(row))).toEqual(before)
  if(renewScope){
    await expect.poll(async()=>(await runtime.threadService.get(child.threadId))!.turns.some(t=>t.status==='queued'||t.status==='running'),{timeout:5_000}).toBe(false)
    vi.setSystemTime(Date.parse(prepared.recovery.consentExpiresAt!)+1)
    const nextReview=await (await api(`/v1/tasks/${child.id}/public-query-recovery`,'GET')).json() as BrowserPublicQueryRecoverySnapshot
    expect(nextReview).toMatchObject({state:'needs_scope_review',mode:'task_reauthorization',unknownOperationCount:before.length})
    const nextScope=nextReview.scopeReview!
    const again=await api(`/v1/tasks/${child.id}/prepare-public-query-recovery`,'POST',{expectedRevision:child.revision,idempotencyKey:'renew-expired-own-scope',confirmed:true,scopeConfirmation:{reviewHash:nextScope.reviewHash,expectedBrowserRevision:nextScope.scope.revision,browserInstanceId:nextScope.scope.browserInstanceId,origins:nextScope.scope.origins,duration:'task',ttlSeconds:900,confirmed:true}})
    expect(again.status,await again.clone().text()).toBe(200)
    const next=await again.json() as typeof prepared
    const againContinue=await api(`/v1/tasks/${child.id}/retry`,'POST',{expectedRevision:next.task.revision,idempotencyKey:'continue-renewed-once',publicQueryRecoveryReceiptId:next.recovery.receiptId})
    expect(againContinue.status,await againContinue.clone().text()).toBe(202)
    const last=(await againContinue.json() as {task:TaskRun}).task
    await expect.poll(()=>repository.get(last.id)?.status,{timeout:30_000}).toBe('completed')
    expect(repository.get(last.id)!.rootTaskId).toBe(sourceId)
    expect(repository.unsettledOperations(sourceId).map(row=>JSON.stringify(row))).toEqual(before)
  }
}
it('requires a genuinely new task-scope consent after a finite one-off query loses its owned session', async () => { await oneOffScenario(false) }, 45_000)

it('keeps an expired independent permission blocked until the new child confirms its own permission', async()=>{await oneOffScenario(true)},45_000)

it('requires another explicit scope after expiry without invalidating the permanent fence or borrowing the expired consent',async()=>{await oneOffScenario(false,true)},45_000)
