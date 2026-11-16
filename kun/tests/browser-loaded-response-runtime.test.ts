import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createKunServeRuntime } from '../src/server/runtime-factory.js'
import { KunCapabilitiesConfig } from '../src/contracts/capabilities.js'
import { WebArtifactEvidenceInputSchema } from '../src/contracts/web-artifact-evidence.js'
import { buildRouter } from '../src/server/routes/index.js'
import { dispatchRequest } from '../src/server/http-server.js'
import { operationFingerprint } from '../src/services/task-run-repository.js'
import type { BrowserTaskBindingSnapshot } from '../src/contracts/browser-skill.js'
import { makeToolResultItem } from '../src/domain/item.js'
import { assessWebArtifactEvidence, webArtifactManifestSourceProof, webArtifactPublicationReadiness } from '../src/services/web-artifact-evidence.js'
import { renderStructuredWebReport } from '../src/services/structured-web-report.js'
import { publicArticleId, validLoadedResponseEvidence } from '../src/services/browser-loaded-response.js'

// Existing released 67-name tool scope; only public tool identifiers, no user identity or captured content.
const LEGACY_TOOL_NAMES = ["read", "grep", "find", "ls", "ppt_master", "ppt_master_env", "echo", "user_input", "request_user_input", "web_fetch", "list_attachment_sections", "search_attachment", "read_attachment_section", "read_delivery_sources", "read_task_context", "publish_artifact", "read_artifact", "verify_web_artifact", "run_flow", "schedule_task", "list_schedules", "browser_session_start", "browser_observe", "browser_navigate", "browser_get_html", "browser_authorize_action", "browser_click", "browser_fill", "browser_screenshot", "browser_session_stop", "monitoring_csv", "railwise.monitoring_csv", "deformation_rate", "railwise.deformation_rate", "monitoring_data_first_check", "railwise.monitoring_data_first_check", "chart_generator", "railwise.chart_generator", "report_export", "railwise.report_export", "excel_export", "railwise.excel_export", "standard_query", "tool_norm_cite", "survey_network_validate", "survey_adjustment_read", "survey_calculator", "control_network", "cpiii_adjustment", "coord_transform", "distance_calculator", "angle_convert", "railwise.survey_network_validate", "railwise.survey_adjustment_read", "railwise.survey_calculator", "railwise.control_network", "railwise.cpiii_adjustment", "railwise.coord_transform", "railwise.distance_calculator", "railwise.angle_convert", "request_host_shell", "host_shell_session", "get_goal", "create_goal", "update_goal", "todo_list", "todo_write"]

// Match the real URI/form-encoding boundary without using any actual announcement.
const PARENT = 'https://primary.example.test/detail?articleId=synthetic+article=='
const PROJECT = '轨道控制网测量公开测试项目'
const TITLE = `关于${PROJECT}的公开公告`
const QUOTE = '预算金额（元）：400000；这是完整的公开原文正文。'
const SOURCE_HTML = `<article><h1>${PROJECT}</h1><p>${QUOTE}</p></article>`
const SOURCE_JSON = JSON.stringify({ result: { data: { articleId: 'synthetic+article==', title: TITLE, projectName: PROJECT, content: SOURCE_HTML } } })
const HIDDEN_QUALIFICATION = '仅隐藏脚本回退中声称的资质'
const METADATA_HTML = `<article><p>${QUOTE}</p><noscript>${HIDDEN_QUALIFICATION}</noscript></article>`
const responseJson = () => page.mode === 'metadata-title' ? JSON.stringify({ result: { data: { articleId: 'synthetic+article==', title: TITLE, projectName: PROJECT, content: METADATA_HTML } } }) : SOURCE_JSON
const page = vi.hoisted(() => ({ started: false, url: 'about:blank', name: '', capturing: false, calls: [] as string[][], context: 0, mode: 'valid', at: 0 }))
vi.mock('../src/services/browser-skill-cli.js', async original => ({
  ...await original<typeof import('../src/services/browser-skill-cli.js')>(),
  runBrowserCommand: vi.fn(async (_config: unknown, args: readonly string[]) => {
    page.calls.push([...args])
    const run = () => ({ id: 'owned-run', name: page.name, session_id: 'owned-session', tab_id: 1, state: page.capturing ? 'capturing' : 'stopped',
      requests: 2, dropped_requests: 0, active_rules: 0, coverage: ['from_start', 'task_tab'] })
    const parent = { id: 'owned-run:n1', run_id: 'owned-run', url: PARENT, method: 'GET', status: 200, state: 'complete', resource_type: 'Document', frame_id: 'root-frame', loader_id: 'loader', started_at: page.at }
    const source = () => ({ id: 'owned-run:n2', run_id: 'owned-run', url: 'https://primary.example.test/different-observed-path?articleId=synthetic%2Barticle%3D%3D&timestamp=1', method: 'GET',
      status: 200, state: 'complete', resource_type: 'XHR', frame_id: 'root-frame', loader_id: 'loader', mime_type: 'application/json', started_at: page.at + 1, finished_at: page.at + 2,
      integrity: { url: 'complete', metadata: 'complete' }, request_body: { state: 'empty' }, response_body: { state: 'available', chars: responseJson().length, redacted: page.mode === 'masked', replay_safe: false } })
    if (args[0] === 'status') return { ok: true, output: { protocol_version: '1.9', pid: 11, browsers: [{ instance_id: 'browser', browser_name: 'Chrome', label: '原文响应夹具', extension_version: '0.5.0', extension_protocol_version: '1.9' }], sessions: page.started ? [{ session_id: 'owned-session', browser_instance_id: 'browser' }] : [] } }
    if (args[0] === 'session' && args[1] === 'request') return { ok: true, output: {} }
    if (args[0] === 'session' && args[1] === 'start') { page.started = true; return { ok: true, output: { session_id: 'owned-session', browser_instance_id: 'browser' } } }
    if (args[0] === 'session' && args[1] === 'stop') { page.started = false; return { ok: true, output: { stopped: ['owned-session'], failed: [] } } }
    if (args[0] === 'tab') return { ok: true, output: { tabs: [{ tab_id: 1, url: page.url, title: TITLE, scope: 'agent' }] } }
    if (args[0] === 'navigate') { page.url = args[1]!; page.at = Date.now() - 50; return { ok: true, output: { final_url: page.url } } }
    if (args[0] === 'cooperate') return { ok: true, output: { tab_id: 1, control_policy: 'target', context_id: `native-context-${++page.context}`, observation_id: `native-observation-${page.context}`, observation: { text: `RootWebArea "${TITLE}"\n  Iframe\n    StaticText "${PROJECT}"`, truncated: false, ref_count: 0 } } }
    if (args[0] === 'get-html') {
      const html = page.mode === 'complete-dom' ? `<!doctype html><html><head><title>${TITLE}</title></head><body>${SOURCE_HTML}</body></html>` : page.mode === 'bodyless' ? `<html><head><title>${TITLE}</title></head></html>` : '<html><body><svg>loaded shell, original document does not fit</svg>'
      return { ok: true, output: { tab_id: 1, html, truncated: !['complete-dom', 'bodyless'].includes(page.mode), byte_size: ['complete-dom', 'bodyless'].includes(page.mode) ? Buffer.byteLength(html) : 3234390 } }
    }
    if (args[0] === 'wait-for-element') return { ok: true, output: { tab_id: 1, used_selector: 'body', satisfied: false, attached: false, visible: false, elapsed_ms: 5000 } }
    if (args[0] === 'read') return { ok: true, output: { tab_id: 1, page_url: PARENT, frame_url: PARENT, frame_id: 'root-frame', title: TITLE,
      captured_at: new Date().toISOString(), scope: 'current_dom', truncated: false, items: [{ ref: '@e1', values: { present: true }, redacted: [] }] } }
    if (args[0] === 'debug' && args[1] === 'start') { page.name = args[args.indexOf('--name') + 1]!; page.capturing = true; return { ok: true, output: { session_id: 'owned-session', run: { ...run(), ...(page.mode === 'foreign-capture' ? { name: 'different-owner', id: 'foreign-run' } : {}) } } } }
    if (args[0] === 'debug' && args[1] === 'stop') {
      expect(args).toContain('owned-run'); if (page.mode === 'cleanup-failed') return { ok: false, code: 'synthetic_cleanup_failed' }; page.capturing = false; return { ok: true, output: { session_id: 'owned-session', run: run() } }
    }
    if (args[0] === 'debug' && args[1] === 'requests') return { ok: true, output: { session_id: 'owned-session', run: run(), requests: [parent, source()], truncated: false } }
    if (args[0] === 'debug' && args[1] === 'request') {
      expect(args[2]).toBe('owned-run:n2'); expect(args[args.indexOf('--part') + 1]).toBe('response')
      const offset = Number(args[args.indexOf('--offset') + 1]), text = responseJson().slice(offset, offset + 16384), end = offset + text.length
      return { ok: true, output: { session_id: 'owned-session', run: run(), request: { ...source(), response_body: { ...source().response_body, offset, text, ...(end < responseJson().length ? { next_offset: end } : {}) } } } }
    }
    throw new Error(`Unexpected native command ${args[0]}/${args[1] ?? ''}`)
  })
}))
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanup.length) await cleanup.pop()!() })

async function fixture(mode: 'valid' | 'masked' | 'injected-args' | 'cleanup-failed' | 'foreign-capture' | 'complete-dom' | 'bodyless' | 'subtree' | 'metadata-title') {
  page.started = false; page.url = 'about:blank'; page.name = ''; page.capturing = false; page.calls = []; page.context = 0; page.mode = mode; page.at = Date.now() - 50
  const root = await realpath(await mkdtemp(join(tmpdir(), 'browser-loaded-response-runtime-')))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, '只读 中文 资料'); await mkdir(workspace)
  let runtime: Awaited<ReturnType<typeof createKunServeRuntime>> | undefined, taskId = '', modelCalls = 0
  let advertised: Array<{ function: { name: string; parameters: Record<string, unknown> } }> = []
  const output = (name: string) => ((runtime!.taskRepository!.operations(taskId, 'tool').find(row => row.request?.toolName === name)?.result as { item?: { output?: Record<string, unknown> } } | undefined)?.item?.output ?? {})
  const steps = ['browser_session_start', 'browser_navigate', 'browser_get_html', 'publish_artifact', 'read_artifact', 'verify_web_artifact']
  const model = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw) as { tools?: typeof advertised }; advertised = body.tools ?? []
    const index = modelCalls++, tool = steps[index]
    const source = output('browser_get_html')
    if (!tool || index >= 3 && (source.status !== 'succeeded' || source.truncated === true)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ id: 'response-model', choices: [{ index: 0, delta: { content: source.status === 'succeeded' ? '原文及报告已经保存并核验。' : '当前原文尚未取得，不能交付已核验报告。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`); return
    }
    let args: Record<string, unknown> = index === 0 ? {} : index === 1 ? { sessionId: 'owned-session', url: PARENT } : { sessionId: 'owned-session' }
    if (index === 2 && mode === 'subtree') args = { ...args, target: '@e1' }
    if (index === 2 && mode === 'injected-args') args = { ...args, requestId: 'foreign', url: 'https://foreign.example.test/steal', expression: 'not allowed' }
    const itemTitle = mode === 'metadata-title' ? TITLE : PROJECT
    const evidence = { coverage: [{ url: PARENT, resultHash: source.resultHash }], items: [{ sectionId: 'primary', title: itemTitle,
      source: { url: PARENT, resultHash: source.resultHash }, discovery: { url: PARENT, resultHash: source.resultHash }, classification: 'source',
      fields: [{ field: 'title', value: itemTitle, quote: itemTitle }, { field: 'other', value: QUOTE, quote: QUOTE }], unverifiedFields: [] }], noMatches: [] }
    if (index === 3) args = { path: 'report.html', report: { title: '原文核验报告', evidence } }
    if (index === 4) args = { path: 'report.html' }
    if (index === 5) args = output('publish_artifact').verificationInput as Record<string, unknown>
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(`data: ${JSON.stringify({ id: 'response-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `response-${index}`, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections() }))
  runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'response-test', apiKey: 'synthetic-local-only',
    baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, model: 'response-model', endpointFormat: 'chat_completions', approvalPolicy: 'on-request', sandboxMode: 'read-only',
    tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({ browserSkill: { enabled: true, state: 'ready',
      executablePath: join(root, 'synthetic-bsk'), executableHash: 'a'.repeat(64), version: '0.5.0', daemonProtocolVersion: '1.9', browserInstanceId: 'browser',
      browsers: [{ id: 'browser', name: 'Chrome', label: '原文响应夹具', extensionVersion: '0.5.0', protocolVersion: '1.9', connected: true, versionSkew: false }],
      origins: ['https://primary.example.test'], interaction: 'observe', revision: 1 } }) })
  const live = runtime; cleanup.push(async () => live.shutdown?.())
  const router = buildRouter(runtime)
  const api = (path: string, method = 'POST', body?: unknown) => dispatchRequest(router, new Request(`http://localhost${path}`, { method,
    headers: { authorization: 'Bearer response-test', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }))
  const origin = await runtime.threadService.create({ workspace, mode: 'agent', model: 'response-model', approvalPolicy: 'on-request' })
  await runtime.threadService.setAgent(origin.id, { agentId: 'legacy-agent', expectedRevision: origin.agentRevision, idempotencyKey: 'legacy-agent-scope',
    profile: { id: 'legacy-agent', name: 'Legacy scope', role: 'Read public documents', color: 'blue', systemPrompt: 'Use only the existing authorized tools.',
      toolAllowlist: [...LEGACY_TOOL_NAMES], mcpAllowlist: [], trustLevel: 'read-only', budget: { maxAttempts: 3, maxDurationMs: 600000 }, revision: 1 } })
  const started = await runtime.taskCoordinator!.command({ threadId: origin.id, intent: 'new', idempotencyKey: 'loaded-primary', request: { prompt: `使用BrowserSkill读取 ${PARENT} 的公开文档正文，生成HTML报告。` } }); taskId = started.task!.id
  const snapshot = await api(`/v1/tasks/${taskId}/browser-binding`, 'GET'); expect(snapshot.status, await snapshot.clone().text()).toBe(200)
  const binding = await snapshot.json() as BrowserTaskBindingSnapshot
  const bound = await api(`/v1/tasks/${taskId}/browser-binding`, 'POST', { expectedTaskRevision: binding.taskRevision, expectedBrowserRevision: binding.browserRevision,
    browserInstanceId: binding.browserInstanceId, origins: binding.origins, interaction: 'observe', verificationPolicy: 'public_query_target', confirmed: true, idempotencyKey: 'response-bind' })
  expect(bound.status, await bound.clone().text()).toBe(200)
  const resumed = await api(`/v1/tasks/${taskId}/resume`, 'POST', { expectedRevision: runtime.taskRepository!.get(taskId)!.revision, idempotencyKey: 'response-resume' })
  expect(resumed.status, await resumed.clone().text()).toBe(202)
  await expect.poll(() => ['completed', 'waiting_user', 'failed', 'stalled'].includes(live.taskRepository!.get(taskId)!.status), { timeout: 15000 }).toBe(true)
  await expect.poll(() => modelCalls, { timeout: 15000 }).toBeGreaterThanOrEqual(3)
  return { runtime: live, taskId, output, advertised }
}

it('uses the actual catalog, immutable Grant, native representation and saved-file gate through Runtime/HTTP/SQLite', async () => {
  const f = await fixture('valid'), task = f.runtime.taskRepository!.get(f.taskId)!
  expect(LEGACY_TOOL_NAMES).toHaveLength(67)
  expect(f.advertised.map(tool => tool.function.name)).not.toContain('browser_read_document')
  expect(f.advertised.map(tool => tool.function.name).filter(name => name.startsWith('browser_')).every(name => LEGACY_TOOL_NAMES.includes(name))).toBe(true)
  const turn = (await f.runtime.threadService.get(task.threadId))!.turns.find(turn => turn.id === task.activeTurnId)!
  expect(turn.executionGrant!.allowedToolNames).not.toContain('browser_read_document')
  expect(turn.executionGrant!.allowedToolNames).toContain('browser_get_html')
  expect(turn.executionGrant!.allowedToolNames!.every(name => LEGACY_TOOL_NAMES.includes(name))).toBe(true)
  expect(f.output('browser_get_html')).toMatchObject({ status: 'succeeded', sourceKind: 'actual_loaded_response', html: SOURCE_HTML,
    readScope: 'response_document', nativeProof: { responseBodyRedacted: false, association: 'projectName' } })
  expect(f.output('publish_artifact'), 'The first publication must pass the real source-first gate before any file read or verification.').toMatchObject({ bytes_written: expect.any(Number) })
  const originalInput = WebArtifactEvidenceInputSchema.parse({ path: 'report.html', coverage: [{ url: PARENT, resultHash: f.output('browser_get_html').resultHash }],
    items: [{ sectionId: 'primary', title: PROJECT, source: { url: PARENT, resultHash: f.output('browser_get_html').resultHash },
      discovery: { url: PARENT, resultHash: f.output('browser_get_html').resultHash }, classification: 'source',
      fields: [{ field: 'title', value: PROJECT, quote: PROJECT }, { field: 'other', value: QUOTE, quote: QUOTE }], unverifiedFields: [] }], noMatches: [] })
  const published = f.output('publish_artifact')
  expect(published.verificationInput).toEqual({ path: 'report.html', manifestRef: expect.stringMatching(/^web-manifest:[a-f0-9]{64}$/) })
  expect(published.verificationInputHash).toBe(operationFingerprint(originalInput))
  const manifestRef = (published.verificationInput as { manifestRef: string }).manifestRef
  const storedInput = WebArtifactEvidenceInputSchema.parse(f.runtime.taskRepository!.operation(f.taskId, manifestRef)?.request?.input)
  expect(storedInput).toEqual(originalInput)
  expect(publicArticleId(storedInput.items[0]!.source.url)).toBe('synthetic+article==')
  expect(storedInput.items[0]!.source.url).toBe(PARENT)
  expect(f.output('verify_web_artifact')).toMatchObject({ complete: true })
  expect(task.status).toBe('completed')
  expect(task.artifacts[0]).toMatchObject({ validation: 'valid', sourceEvidenceStatus: 'verified', sourceEvidenceReceiptId: expect.any(String) })
  expect(page.calls.filter(args => args[0] === 'navigate')).toHaveLength(1)
  expect(page.calls.filter(args => args[0] === 'debug' && args[1] === 'stop')).toHaveLength(1)
  expect(page.calls.some(args => args[0] === 'evaluate' || args[1] === 'replay' || args.includes('headers'))).toBe(false)
}, 25000)

it.each(['masked', 'injected-args'] as const)('does not expose a source, verify a file or claim completion for %s', async mode => {
  const f = await fixture(mode), task = f.runtime.taskRepository!.get(f.taskId)!
  expect(f.output('browser_get_html').status).not.toBe('succeeded')
  expect(task.status).not.toBe('completed')
  expect(task.artifacts.some(artifact => artifact.sourceEvidenceStatus === 'verified')).toBe(false)
  expect(page.calls.some(args => args[0] === 'debug' && args[1] === 'request')).toBe(false)
}, 25000)


it('retains an actionable failed cleanup audit and never publishes source evidence when its own capture cannot stop', async () => {
  const f = await fixture('cleanup-failed'), task = f.runtime.taskRepository!.get(f.taskId)!
  expect(f.output('browser_get_html')).toMatchObject({ status: 'failed', code: 'browser_document_capture_cleanup_failed' })
  expect(f.output('browser_get_html')).not.toHaveProperty('html')
  expect(f.runtime.taskRepository!.operations(f.taskId, 'browser_document_capture')).toMatchObject([{ status: 'failed', result: { active: true, cleanup: 'failed' } }])
  expect(task.status).not.toBe('completed')
  expect(task.artifacts.some(artifact => artifact.sourceEvidenceStatus === 'verified')).toBe(false)
  expect(page.calls.filter(args => args[0] === 'navigate')).toHaveLength(1)
  expect(page.calls.filter(args => args[0] === 'debug' && args[1] === 'stop').every(args => args.includes('owned-run'))).toBe(true)
}, 25000)

it('neither adopts nor stops a native capture returned for a different owner', async () => {
  const f = await fixture('foreign-capture'), task = f.runtime.taskRepository!.get(f.taskId)!
  expect(f.output('browser_navigate')).toMatchObject({ status: 'failed', code: 'browser_document_capture_not_owned' })
  expect(f.runtime.taskRepository!.operations(f.taskId, 'browser_document_capture')).toMatchObject([{ status: 'failed', result: { phase: 'start_unverified', cleanup: 'unverified' } }])
  expect(page.calls.filter(args => args[0] === 'navigate')).toHaveLength(0)
  expect(page.calls.filter(args => args[0] === 'debug' && args[1] === 'stop')).toHaveLength(0)
  expect(page.calls.filter(args => args[0] === 'debug' && args[1] === 'request')).toHaveLength(0)
  expect(task.status).not.toBe('completed')
}, 25000)


it('automatically uses the same validated response path for a bodyless document after one fixed native wait', async () => {
  const f = await fixture('bodyless')
  expect(f.output('browser_get_html')).toMatchObject({ status: 'succeeded', sourceKind: 'actual_loaded_response', html: SOURCE_HTML, readScope: 'response_document' })
  expect(f.runtime.taskRepository!.get(f.taskId)!.status).toBe('completed')
  expect(page.calls.filter(args => args[0] === 'wait-for-element')).toHaveLength(1)
  expect(page.calls.filter(args => args[0] === 'navigate')).toHaveLength(1)
}, 25000)

it('keeps complete primary DOM reads on the original channel with no response-body access', async () => {
  const f = await fixture('complete-dom')
  expect(f.output('browser_get_html')).toMatchObject({ status: 'succeeded', readScope: 'document', truncated: false })
  expect(f.output('browser_get_html')).not.toHaveProperty('nativeProof')
  expect(f.output('browser_get_html')).not.toHaveProperty('sourceKind')
  expect(page.calls.filter(args => args[0] === 'debug' && args[1] === 'request')).toHaveLength(0)
  expect(f.runtime.taskRepository!.get(f.taskId)!.status).toBe('completed')
}, 25000)

it('preserves an explicitly requested element subtree without substituting the primary response', async () => {
  const f = await fixture('subtree')
  expect(f.output('browser_get_html')).toMatchObject({ status: 'succeeded', readScope: 'element', truncated: true })
  expect(f.output('browser_get_html')).not.toHaveProperty('nativeProof')
  expect(page.calls.filter(args => args[0] === 'debug' && args[1] === 'request')).toHaveLength(0)
  expect(f.runtime.taskRepository!.get(f.taskId)!.status).not.toBe('completed')
}, 25000)

it('verifies a report whose exact title comes only from independently proved response metadata', async () => {
  const f = await fixture('metadata-title'), task = f.runtime.taskRepository!.get(f.taskId)!
  const source = f.output('browser_get_html'), hash = createHash('sha256').update(METADATA_HTML).digest('hex')
  expect(METADATA_HTML).not.toContain(TITLE)
  expect(METADATA_HTML).not.toContain(PROJECT)
  expect(source).toMatchObject({ status: 'succeeded', sourceKind: 'actual_loaded_response', readScope: 'response_document', html: METADATA_HTML,
    title: TITLE, resultHash: hash, nativeProof: { association: 'metadata_identity' } })
  expect(f.output('publish_artifact')).toMatchObject({ bytes_written: expect.any(Number), verificationInput: { manifestRef: expect.stringMatching(/^web-manifest:[a-f0-9]{64}$/) } })
  expect(f.output('verify_web_artifact')).toMatchObject({ complete: true, sourceReceipts: [expect.objectContaining({ title: TITLE, resultHash: hash })] })
  expect(task.status).toBe('completed')
  expect(task.artifacts[0]).toMatchObject({ sourceEvidenceStatus: 'verified', validation: 'valid' })
  expect(page.calls.filter(args => args[0] === 'navigate')).toHaveLength(1)
  expect(page.calls.some(args => args[0] === 'evaluate' || args[1] === 'replay' || args.includes('headers'))).toBe(false)
}, 25000)

it('keeps metadata title scoped to authenticated response titles and rejects conflicting identities for the same body', async () => {
  const f = await fixture('metadata-title'), repository = f.runtime.taskRepository!, task = repository.get(f.taskId)!
  const original = repository.operations(task.id, 'tool').find(row => row.request?.toolName === 'browser_get_html')!
  const published = f.output('publish_artifact'), ref = (published.verificationInput as { manifestRef: string }).manifestRef
  const input = WebArtifactEvidenceInputSchema.parse(repository.operation(task.id, ref)!.request!.input)
  const turns = (await f.runtime.threadService.get(task.threadId))!.turns
  const grant = turns.find(turn => turn.id === original.request!.turnId)!.executionGrant!
  const assessment = async (proof = input) => assessWebArtifactEvidence(repository, task, await f.runtime.sessionStore.loadItems(task.threadId), turns,
    renderStructuredWebReport(proof.path, { title: '原文核验报告', evidence: { coverage: proof.coverage, items: proof.items, noMatches: proof.noMatches } }).content, proof)
  const wrongTitle = structuredClone(input)
  wrongTitle.items[0]!.title = PROJECT
  wrongTitle.items[0]!.fields[0] = { field: 'title', value: PROJECT, quote: TITLE }
  expect((await assessment(wrongTitle)).reasons).toEqual(expect.arrayContaining(['条目尚缺真实链接发现及完整正文读取：primary', '字段缺少正文与成果的精确依据：primary/title']))
  for (const field of ['other', 'budget', 'deadline', 'qualification'] as const) {
    const nonTitle = structuredClone(input)
    nonTitle.items[0]!.fields[1] = { field, value: TITLE, quote: TITLE }
    expect((await assessment(nonTitle)).reasons).toContain(`字段缺少正文与成果的精确依据：primary/${field}`)
  }
  const hidden = structuredClone(input)
  hidden.items[0]!.fields[1] = { field: 'qualification', value: HIDDEN_QUALIFICATION, quote: HIDDEN_QUALIFICATION }
  expect((await assessment(hidden)).reasons).toContain('字段缺少正文与成果的精确依据：primary/qualification')
  let next = 0
  const appendControlledHostRead = async (output: Record<string, unknown>, providerId = 'browser-skill') => {
    const id = `additional-controlled-read-${++next}`, request = { ...original.request!, callId: id, providerId }
    const item = makeToolResultItem({ id, threadId: task.threadId, turnId: grant.turnId, callId: id, toolName: 'browser_get_html', output })
    repository.beginOperation({ ownerId: task.id, idempotencyKey: id, kind: 'tool', request, nowIso: original.createdAt })
    repository.finishOperation(task.id, id, { status: 'succeeded', result: { approved: true, item } }, original.updatedAt)
    await f.runtime.sessionStore.appendItem(task.threadId, item)
  }
  // A legacy DOM receipt has no metadata title and must not conflict with a proved title.
  const legacy = structuredClone(f.output('browser_get_html'))
  delete legacy.sourceKind; delete legacy.nativeProof; delete legacy.responseText; delete legacy.title
  legacy.readScope = 'document'
  await appendControlledHostRead(legacy)
  expect(await assessment()).toMatchObject({ complete: true, sourceReceipts: [expect.objectContaining({ title: TITLE })] })
  // Model/MCP labels cannot add another metadata identity even with an otherwise copied proof.
  const conflict = structuredClone(f.output('browser_get_html')), otherTitle = `${TITLE}（修订）`
  const json = JSON.parse(String(conflict.responseText)) as { result: { data: { title: string } } }
  json.result.data.title = otherTitle
  const responseText = JSON.stringify(json), sha = (value: string) => createHash('sha256').update(value).digest('hex')
  conflict.title = otherTitle; conflict.responseText = responseText
  const proof = conflict.nativeProof as Record<string, unknown>
  Object.assign(proof, { titleHash: sha(otherTitle), responseUtf16Units: responseText.length, responseUtf8Bytes: Buffer.byteLength(responseText), responseSha256: sha(responseText),
    associationHash: sha(JSON.stringify({ association: 'metadata_identity', articleId: 'synthetic+article==', nativeTitle: otherTitle, contentPointer: proof.contentPointer, htmlSha256: sha(METADATA_HTML) })),
    chunks: [{ offset: 0, end: responseText.length, utf16Units: responseText.length, utf8Bytes: Buffer.byteLength(responseText), sha256: sha(responseText) }] })
  expect(validLoadedResponseEvidence(conflict, grant)).toBe(true)
  await appendControlledHostRead(conflict, 'untrusted-mcp')
  expect((await assessment()).complete).toBe(true)
  // Two distinct, fully authenticated native titles for identical URL/body bytes are ambiguous.
  await appendControlledHostRead(conflict)
  const items = await f.runtime.sessionStore.loadItems(task.threadId)
  expect(webArtifactPublicationReadiness(repository, task, items, turns, input).ready).toBe(false)
  expect((await assessment()).reasons).toContain(`来源没有匹配的可信读取回执：${PARENT}`)
  expect(() => webArtifactManifestSourceProof(repository, task, items, turns, input)).toThrow('发布清单引用的URL没有本任务可信来源读取回执。')
}, 25000)
