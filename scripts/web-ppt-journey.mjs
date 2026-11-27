import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import { isAbsolute, join, relative, sep, win32 } from 'node:path'
import { browserSmokeDependency } from './prepare-browser-skill-smoke.mjs'

export const webPptSourceHost = 'www.railwise.cn'
export const webPptSourceUrl = `https://${webPptSourceHost}/`
export const webPptQuestion = '请提供制作 PPT 所需的官网网址。'
export const webPptMonitoringTopic = /自动化监测|工程监测|变形监测|安全监测/
export const webPptJourneyPrompt = '请用所选技能制作单页可编辑演示文稿 deck/website.pptx。请先用自由文本提问工具问我官网网址，再用官网的工程测量和自动化监测资料制作，并在演示文稿内列出来源。网页读取失败时不要重复相同请求；如有已连接的浏览器技能则用它读取，否则说明具体原因并停止。'
export const liveWebPptJourneyPrompt = `${webPptJourneyPrompt}制作要求：1）只读写当前工作区 deck/ 下的相对路径，不要调用 request_host_shell、ppt_master 或访问工作区外路径；2）先用 write 写入 deck/spec_lock.md（首行 <!-- ppt-master-schema: spec-lock/v1 -->，包含 ## canvas 的 viewBox: 0 0 1280 720 与 format: ppt169、## colors 的 bg/primary/accent/text、## typography 的 font_family/title_family/body_family: Arial 及 body: 18 和 title: 36、## pptx_structure 的 mode: flat、## communication 的 primary_language: zh-CN），再用 write 写入单页 deck/svg_output/slide_01.svg（1280x720 纯 <rect> 与不重叠的 <text> 元素，包含官网读取到的工程测量与自动化监测要点及来源 www.railwise.cn）；3）每次修改 SVG 后必须紧接着执行 ppt_master_quality_check（project_path="deck", stage="final"），通过后不再改文件并立即调用 ppt_master_export（project_path="deck", output_path="deck/website.pptx", source="output", format="ppt169"）。`
const project = 'deck'
const filename = 'website.pptx'
const artifactPath = `${project}/${filename}`
const composer = '.ds-chat-composer-dock textarea:not(:disabled)'
const answerComposer = '.ds-chat-composer-dock textarea[placeholder="输入你的回答…"]:not(:disabled)'
const timeline = '.ds-message-timeline-content'
const resultRegion = `${timeline} section[aria-label="任务"]`
const literal = JSON.stringify
const digest = value => createHash('sha256').update(value).digest('hex')
const sha256 = /^[a-f0-9]{64}$/
const specLock = [
  '<!-- ppt-master-schema: spec-lock/v1 -->', '# Execution Lock', '',
  '## canvas', '- viewBox: 0 0 1280 720', '- format: ppt169', '', '## colors',
  '- bg: #FFFFFF', '- primary: #142335', '- accent: #2872D0', '- text: #142335', '',
  '## typography', '- font_family: Arial', '- title_family: Arial', '- body_family: Arial', '- body: 18', '- title: 36', '',
  '## pptx_structure', '- mode: flat', '', '## communication', '- primary_language: zh-CN', ''
].join('\n')

const browserTools = ['browser_session_start', 'browser_navigate', 'browser_get_html', 'browser_session_stop']
const fallbackTitle = '合成工程测量与安全监测资料'

export async function startWebPptFallbackSource() {
  const marker = `RAILWISE_PPT_DOM_${randomUUID()}`
  const payload = Buffer.from(JSON.stringify({ title: fallbackTitle, marker })).toString('base64')
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/ppt-source') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>BrowserSkill 合成验收</title></head>
<body><main></main><script>
const source = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('${payload}'), char => char.charCodeAt(0))));
const title = document.createElement('h1');
title.textContent = source.title;
const body = document.createElement('p');
body.textContent = source.marker;
document.querySelector('main').append(title, body);
</script></body></html>`)
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  return { url: `http://127.0.0.1:${server.address().port}/ppt-source`, marker,
    close: () => new Promise(done => { server.close(done); server.closeAllConnections() }) }
}

function createSlide(title, sourceUrl, marker) {
  const escape = value => value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
  const rows = [title, marker ?? '工程测量与自动化监测公开资料', sourceUrl].map((text, index) =>
    `<text x="80" y="${170 + index * 105}" fill="#142335" font-family="Arial" font-size="36">${escape(text)}</text>`)
  // Keep the generated write argument longer than the persisted display summary limit.
  const details = Array.from({ length: 22 }, (_, index) =>
    `<rect x="${80 + index * 38}" y="550" width="30" height="4" fill="#2872D0"/>`)
  return ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">',
    '<rect width="1280" height="720" fill="#FFFFFF"/>', ...rows, ...details, '</svg>'].join('\n')
}

function toolCall(tools, name, args, id = name) {
  assert.ok(tools.some(tool => tool.function.name === name), `The installed Runtime did not expose ${name}`)
  return { tool_calls: [{ index: 0, id: `web-ppt-${id}`, type: 'function', function: { name, arguments: literal(args) } }] }
}

function readRuntime(path) {
  return `window.workwise.runtimeRequest(${literal(path)},'GET').then(response=>{
    if(!response.ok)throw new Error('Runtime read failed: '+response.status);
    return JSON.parse(response.body)
  })`
}

function conversationTextProbe() {
  return `Array.from(document.querySelectorAll(${literal(timeline)})).map(node=>node.innerText).join('\\n')`
}

export function safeWebPptErrorCode(item) {
  const candidate = item?.kind === 'error' ? item.code
    : item?.kind === 'tool_result' && item.isError === true ? item.output?.code : undefined
  return typeof candidate === 'string' && /^[a-z][a-z0-9_:-]{0,79}$/i.test(candidate) ? candidate : undefined
}

export function safeWebPptRuntimeSpans(spans) {
  if (!Array.isArray(spans)) return []
  return spans.map(span => ({
    kind: span.kind,
    status: span.status,
    ...(safeWebPptErrorCode({ kind: 'error', code: span.errorCode })
      ? { errorCode: span.errorCode }
      : {}),
    ...(Number.isFinite(span.retryCount) ? { retryCount: span.retryCount } : {}),
    ...(Number.isFinite(span.durationMs) ? { durationMs: span.durationMs } : {}),
    ...(Number.isFinite(span.inputTokens) ? { inputTokens: span.inputTokens } : {}),
    ...(Number.isFinite(span.outputTokens) ? { outputTokens: span.outputTokens } : {})
  }))
}

export function safeWebPptRuntimeSummary(summary) {
  if (!summary || typeof summary !== 'object') return undefined
  return Object.fromEntries(['total', 'running', 'errors', 'retries', 'durationMs']
    .filter(key => Number.isFinite(summary[key]))
    .map(key => [key, summary[key]]))
}

export function safeWebPptToolDetails(item) {
  const args = item?.kind === 'tool_call' && item.arguments && typeof item.arguments === 'object'
    ? item.arguments
    : undefined
  const relativePath = value => typeof value === 'string' && value.length <= 512 &&
    !value.startsWith('/') && !value.startsWith('\\') && !/^[a-z]:/i.test(value) &&
    !Array.from(value).some(character => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f) &&
    !value.split(/[\\/]/).includes('..')
    ? value
    : undefined
  const details = {}
  if (item.toolName === 'read_skill_resource') {
    if (typeof args?.skill_id === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(args.skill_id)) {
      details.skillId = args.skill_id
    }
    const path = relativePath(args?.path)
    if (path) details.resourcePath = path
  }
  if (['ppt_master_quality_check', 'ppt_master_export', 'ppt_master'].includes(item.toolName)) {
    const projectPath = relativePath(args?.project_path ?? args?.projectDir)
    const outputPath = relativePath(args?.output_path ?? args?.outputPath)
    if (projectPath) details.projectPath = projectPath
    if (outputPath) details.outputExtension = outputPath.split('.').at(-1)?.slice(0, 12).toLowerCase()
    if (['output', 'final'].includes(args?.source)) details.source = args.source
    if (['ppt169', 'ppt43'].includes(args?.format)) details.format = args.format
    if (['first-page', 'final'].includes(args?.stage)) details.stage = args.stage
  }
  return Object.keys(details).length ? details : undefined
}

async function readWebPptTaskDiagnostics(cdp, taskId, executionThreadId) {
  const [task, inputs, inbox, thread, runtimeDiagnostics] = await Promise.all([
    cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(taskId)}`)),
    cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(taskId)}/inputs`)),
    cdp.evaluate(readRuntime('/v1/inbox')),
    cdp.evaluate(readRuntime(`/v1/threads/${encodeURIComponent(executionThreadId)}`)),
    cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(taskId)}/diagnostics`))
  ])
  return {
    task: { id: task.id, status: task.status, originThreadId: task.originThreadId, threadId: task.threadId,
      activeTurnId: task.activeTurnId, waitingReason: task.waitingReason, stalledReason: task.stalledReason,
      blockCode: task.blockCode, revision: task.revision },
    inputs: inputs.map(input => ({ id: input.id, kind: input.kind, status: input.status, sourceId: input.sourceId,
      textLength: typeof input.text === 'string' ? input.text.length : undefined })),
    attention: inbox.filter(item => item.taskId === taskId).map(item => ({ kind: item.kind, status: item.status,
      requestId: item.requestId, payloadKind: item.payload?.kind, provider: item.payload?.capability?.provider,
      errorCode: item.payload?.capability?.errorCode, resolutionRoute: item.payload?.capability?.resolution?.route ?? item.payload?.capability?.action?.route })),
    runtime: {
      summary: safeWebPptRuntimeSummary(runtimeDiagnostics.summary),
      spans: safeWebPptRuntimeSpans(runtimeDiagnostics.spans)
    },
    turns: thread.turns.map(turn => ({ id: turn.id, status: turn.status,
      ...(turn.executionGrant ? { executionGrant: { taskId: turn.executionGrant.taskId,
        approvalPolicy: turn.executionGrant.approvalPolicy, networkAllowlist: turn.executionGrant.networkAllowlist,
        taskPermissionId: turn.executionGrant.taskPermissionId, webTools: turn.executionGrant.allowedToolNames?.filter(name => ['web_fetch', 'web_search'].includes(name)) } } : {}),
      itemKinds: turn.items.map(item => ({ kind: item.kind, toolName: item.toolName, requestId: item.requestId,
        status: item.status, isError: item.isError, errorCode: safeWebPptErrorCode(item),
        ...((item.kind === 'tool_call' ? safeWebPptToolDetails(item) : undefined) ?? {}) })) }))
  }
}

export function inspectLiveWebPptSourceRead(completedTurn, expectedUrl, browserInstanceId) {
  const results = completedTurn.items.filter(item => item.kind === 'tool_result' && !item.isError)
  const webFetch = results.find(item => item.toolName === 'web_fetch' && item.output?.finalUrl === expectedUrl)
  if (webFetch) {
    const receipt = webFetch.output
    assert.equal(typeof receipt.text, 'string')
    assert.ok(receipt.text.includes('工程测量') && webPptMonitoringTopic.test(receipt.text))
    assert.match(receipt.resultHash, /^[a-f0-9]{64}$/)
    assert.ok(receipt.byteCount > 0)
    return { source: { url: receipt.finalUrl, sha256: receipt.resultHash, bytes: receipt.byteCount, tool: 'web_fetch' }, provider: 'fetch' }
  }

  const reads = [
    { toolName: 'ego_browser_read', provider: 'ego-browser' },
    { toolName: 'browser_get_html', provider: 'browser-skill' }
  ]
  for (const read of reads) {
    const item = results.find(candidate => candidate.toolName === read.toolName && candidate.output?.sourceUrl === expectedUrl)
    if (!item) continue
    const output = item.output
    assert.equal(output.status, 'succeeded')
    assert.equal(output.readScope, 'document')
    assert.equal(typeof output.html, 'string')
    assert.ok(output.html.includes('工程测量') && webPptMonitoringTopic.test(output.html))
    const resultHash = digest(output.html)
    assert.equal(output.resultHash, resultHash)
    assert.equal(output.evidence?.verified, true)
    assert.equal(output.evidence?.contentRead, true)
    if (read.provider === 'browser-skill') {
      assert.equal(output.evidence?.sourceUrl, expectedUrl)
      assert.ok(completedTurn.executionGrant?.connectorIdentityFingerprints?.['browser-skill'])
      assert.ok(completedTurn.executionGrant?.browserScope?.origins.includes(new URL(expectedUrl).origin))
      if (browserInstanceId) assert.equal(completedTurn.executionGrant.browserScope.browserInstanceId, browserInstanceId)
    } else {
      assert.ok(output.taskSpaceId > 0)
      assert.equal(completedTurn.executionGrant?.browserScope?.provider, 'ego-browser')
      assert.ok(completedTurn.executionGrant?.browserScope?.origins.includes(new URL(expectedUrl).origin))
    }
    return { source: { url: expectedUrl, sha256: resultHash, bytes: Buffer.byteLength(output.html), tool: read.provider },
      provider: read.provider, ...(read.provider === 'ego-browser' ? { taskSpaceId: output.taskSpaceId } : {}) }
  }
  assert.fail('The live model must read the official website through an available, verified source tool')
}

export function inspectLiveWebPptApproval(attention, { taskId, workspace, skillGuardPath, platform = process.platform }) {
  assert.ok(attention && attention.kind === 'approval' && attention.status === 'pending')
  assert.equal(attention.taskId, taskId, 'The approval must belong to this exact task')
  const approval = attention.payload?.approval
  assert.ok(approval && approval.id === attention.requestId && approval.status === 'pending')
  assert.match(approval.requestHash ?? '', sha256)
  assert.ok(approval.callId)

  if (approval.toolName === 'web_fetch') {
    const origin = `https://${webPptSourceHost}`
    const englishSummary = `Read public web page\nOrigin: ${origin}\nEffect: Read page content only.`
    const chineseSummary = `读取公开网页\n网站：${origin}\n范围：仅当前任务\n影响：只读取网页内容，不会登录、填写或提交数据。`
    assert.ok([englishSummary, chineseSummary].includes(approval.summary), 'Only the exact public-origin read-only approval may be accepted')
    return { id: approval.id, tool: approval.toolName, scope: 'read-only-public-origin', origin: `https://${webPptSourceHost}`,
      requestHash: approval.requestHash }
  }

  assert.equal(approval.toolName, 'request_host_shell', 'Unexpected tool approvals must never be accepted by this journey')
  assert.ok(workspace && skillGuardPath, 'The isolated workspace and installed integrity-check path are required')
  const lines = approval.summary.split(/\r?\n/)
  const field = name => lines.find(line => line.startsWith(`${name}: `))?.slice(name.length + 2)
  assert.equal(lines[0], 'Run request_host_shell')
  assert.equal(lines[1], 'Authority: Full host access for this exact command only; workspace trust remains unchanged')
  const reviewedWorkspace = JSON.parse(field('Workspace (JSON)') ?? 'null')
  const command = JSON.parse(field('Command (JSON)') ?? 'null')
  assert.equal(reviewedWorkspace, workspace, 'The host command must be confined to the isolated acceptance workspace')
  const pathApi = platform === 'win32' ? win32 : { normalize: value => value }
  const commandPath = /^(?:&\s*)?(?:python3?|py)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s]+))$/i.exec(command ?? '')
  assert.ok(commandPath, 'Only a single Python invocation with one quoted script path is eligible')
  const executable = commandPath[1] ?? commandPath[2] ?? commandPath[3]
  assert.equal(pathApi.normalize(executable), pathApi.normalize(skillGuardPath), 'Only the packaged PPT Master attribution guard is eligible')
  assert.equal(field('Workspace SHA256'), digest(workspace))
  assert.equal(field('Command SHA256'), digest(command))
  assert.equal(field('Request SHA256'), approval.requestHash)
  assert.ok(Number(field('Lifetime seconds')) >= 1 && Number(field('Lifetime seconds')) <= 300)
  assert.ok(Number(field('Timeout seconds')) >= 1 && Number(field('Timeout seconds')) <= Number(field('Lifetime seconds')))
  assert.equal(field('Session'), 'Read output or stop only; no stdin writes, connector proxy or automatic replay')
  return { id: approval.id, tool: approval.toolName, scope: 'single-integrity-check-command',
    commandSha256: field('Command SHA256'), workspaceSha256: field('Workspace SHA256'), requestHash: approval.requestHash }
}

export function canResolvePptJourneyApproval({ live, allowControlledHostShell, toolName }) {
  return live === true || allowControlledHostShell === true && ['web_fetch', 'request_host_shell'].includes(toolName)
}

export function inspectLiveWebPptApprovalResolution(inputs, attention, expectedDecision = 'allow') {
  assert.ok(Array.isArray(inputs), 'The actual task inputs API must return an array')
  const rows = inputs.filter(input => input.kind === 'approval_resolution' && input.sourceId === attention.requestId)
  assert.ok(rows.length <= 1, 'The reviewed approval must have at most one durable decision')
  if (!rows.length) return undefined
  assert.equal(rows[0].taskId, attention.taskId)
  // TaskInput stores the durable human-gate envelope in text, not a top-level
  // resolution property. Bind the read-back to the exact request the UI showed.
  const saved = JSON.parse(rows[0].text)
  assert.equal(saved.request, attention.payload.approval.summary)
  assert.equal(saved.resolution?.decision, expectedDecision)
  return { status: expectedDecision === 'allow' ? 'allowed' : 'denied', inputId: rows[0].id }
}

async function resolveLiveWebPptApproval(cdp, taskId, { live, workspace, skillGuardPath, onStage, reviewedScopes }) {
  await onStage?.('review-pending-task-approval')
  const pending = await cdp.evaluate(`${readRuntime('/v1/inbox')}.then(items=>items.filter(item=>item.taskId===${literal(taskId)} && item.kind==='approval' && item.status==='pending'))`)
  assert.equal(pending.length, 1, 'Only one exact approval may be pending for the isolated website-to-PPT task')
  const button = 'section[aria-label="任务"] button'
  let receipt
  try {
    receipt = inspectLiveWebPptApproval(pending[0], { taskId, workspace, skillGuardPath })
  } catch (error) {
    if (!live) throw error
    await onStage?.('deny-unapproved-live-host-action')
    await cdp.wait(`(() => {const buttons=[...document.querySelectorAll(${literal(button)})].filter(node=>
      node.getClientRects().length && !node.disabled && node.textContent.trim()==='拒绝');return buttons.length===1;})()`,
      'the single visible deny control for the unapproved live action', 30_000)
    await cdp.click(button, '拒绝')
    const denyDeadline = Date.now() + 30_000
    while (Date.now() < denyDeadline) {
      const inputs = await cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(taskId)}/inputs`))
      const resolution = inspectLiveWebPptApprovalResolution(inputs, pending[0], 'deny')
      if (resolution) {
        return {
          id: pending[0].requestId,
          tool: pending[0].payload?.approval?.toolName ?? 'unknown',
          scope: 'denied-unapproved-live-action',
          decision: 'deny',
          method: 'installed-task-card',
          inputId: resolution.inputId
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    throw new Error('The denied live approval did not produce one durable decision')
  }
  assert.ok(!reviewedScopes.has(receipt.scope), 'The same bounded action must not require repeated approval')
  reviewedScopes.add(receipt.scope)
  const stage = receipt.tool === 'web_fetch' ? 'approve-read-only-official-site' : 'approve-packaged-attribution-check'
  await onStage?.(stage)
  await cdp.wait(`(() => {const buttons=[...document.querySelectorAll(${literal(button)})].filter(node=>
    node.getClientRects().length && !node.disabled && node.textContent.trim()==='允许此操作');return buttons.length===1;})()`,
    'the single visible approval control for the isolated task', 30_000)
  await cdp.click(button, '允许此操作')
  await onStage?.('verify-single-durable-approval-decision')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const inputs = await cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(taskId)}/inputs`))
    const resolution = inspectLiveWebPptApprovalResolution(inputs, pending[0])
    if (resolution) return { ...receipt, decision: 'allow', method: 'installed-task-card', inputId: resolution.inputId }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('The reviewed approval did not produce one durable decision')
}

async function waitForWebPptTask(cdp, taskId, options) {
  const deadline = Date.now() + options.timeoutMs
  const resolutions = []
  const visited = new Set()
  const reviewedScopes = new Set()
  while (Date.now() < deadline) {
    const task = await cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(taskId)}`))
    if (['completed', 'failed', 'stalled', 'cancelled', 'waiting_user', 'paused'].includes(task.status)) return { task, resolutions }
    if (task.status === 'waiting_approval') {
      const pending = await cdp.evaluate(`${readRuntime('/v1/inbox')}.then(items=>items.filter(item=>item.taskId===${literal(taskId)}&&item.kind==='approval'&&item.status==='pending'))`)
      assert.equal(pending.length, 1, 'The task may have only one real approval pending at once')
      assert.ok(canResolvePptJourneyApproval({ live: options.live,
        allowControlledHostShell: options.allowControlledHostShell, toolName: pending[0].payload?.approval?.toolName }),
      'Only the official read-only page or the exact packaged attribution check may request an approval')
      const receipt = await resolveLiveWebPptApproval(cdp, taskId, { ...options, reviewedScopes })
      assert.ok(!visited.has(receipt.id), 'An approval may be resolved only once')
      visited.add(receipt.id)
      resolutions.push(receipt)
      await options.onStage?.('wait-for-original-task-completion-after-approval')
      continue
    }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for the original task state')
}

async function readWebPptAdmissionDiagnostics(cdp, priorThreadIds) {
  const [threadList, tasks, inbox] = await Promise.all([
    cdp.evaluate(readRuntime('/v1/threads')),
    cdp.evaluate(readRuntime('/v1/tasks?limit=100')),
    cdp.evaluate(readRuntime('/v1/inbox'))
  ])
  const newThreads = threadList.threads.filter(thread => !priorThreadIds.includes(thread.id))
  const threads = await Promise.all(newThreads.map(thread => cdp.evaluate(readRuntime(`/v1/threads/${encodeURIComponent(thread.id)}`))))
  const threadIds = new Set(newThreads.map(thread => thread.id))
  const newTasks = tasks.filter(task => threadIds.has(task.originThreadId))
  const taskIds = new Set(newTasks.map(task => task.id))
  const executionThreadIds = [...new Set(newTasks.map(task => task.threadId).filter(threadId => !threadIds.has(threadId)))]
  const executionThreads = await Promise.all(executionThreadIds.map(threadId =>
    cdp.evaluate(readRuntime(`/v1/threads/${encodeURIComponent(threadId)}`))))
  return {
    threads: threads.map(thread => ({ id: thread.id, turns: thread.turns.map(turn => ({ id: turn.id, status: turn.status,
      activeSkillIds: turn.activeSkillIds, items: turn.items.map(item => ({ kind: item.kind, toolName: item.toolName,
        status: item.status, isError: item.isError })) })) })),
    executionThreads: executionThreads.map(thread => ({ id: thread.id, turns: thread.turns.map(turn => ({ id: turn.id,
      status: turn.status, activeSkillIds: turn.activeSkillIds,
      ...(turn.executionGrant ? { executionGrant: { taskId: turn.executionGrant.taskId,
        approvalPolicy: turn.executionGrant.approvalPolicy, networkAllowlist: turn.executionGrant.networkAllowlist,
        taskPermissionId: turn.executionGrant.taskPermissionId, webTools: turn.executionGrant.allowedToolNames?.filter(name => ['web_fetch', 'web_search'].includes(name)) } } : {}),
      items: turn.items.map(item => ({ kind: item.kind,
        toolName: item.toolName, status: item.status, isError: item.isError })) })) })),
    tasks: tasks.filter(task => taskIds.has(task.id)).map(task => ({ id: task.id, status: task.status,
      activeTurnId: task.activeTurnId, threadId: task.threadId, waitingReason: task.waitingReason,
      stalledReason: task.stalledReason, blockCode: task.blockCode, revision: task.revision })),
    attention: inbox.filter(item => taskIds.has(item.taskId)).map(item => ({ kind: item.kind, status: item.status,
      requestId: item.requestId, errorCode: item.payload?.capability?.errorCode,
      resolutionRoute: item.payload?.capability?.resolution?.route ?? item.payload?.capability?.action?.route }))
  }
}

async function readWebPptReplyState(cdp, taskId, executionThreadId) {
  const [ui, task, inputs, inbox, thread] = await Promise.all([
    cdp.evaluate(`({
      answerComposerVisible: Boolean(document.querySelector(${literal(answerComposer)})?.getClientRects().length),
      composerPlaceholder: document.querySelector('.ds-chat-composer-dock textarea')?.placeholder,
      taskQuestionRequestId: document.querySelector('.ds-chat-composer-dock')?.getAttribute('data-task-question-request-id'),
      replyHintVisible: ${conversationTextProbe()}.includes('在下方输入框直接回复'),
      submitButtonVisible: [...document.querySelectorAll('button')].some(button =>
        button.getClientRects().length && button.getAttribute('aria-label') === '提交')
    })`),
    cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(taskId)}`)),
    cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(taskId)}/inputs`)),
    cdp.evaluate(readRuntime('/v1/inbox')),
    cdp.evaluate(readRuntime(`/v1/threads/${encodeURIComponent(executionThreadId)}`))
  ])
  return {
    ui,
    task: { id: task.id, originThreadId: task.originThreadId, status: task.status,
      activeTurnId: task.activeTurnId, presentationReason: task.presentation?.reason },
    inputs: inputs.map(input => ({ kind: input.kind, idempotencyKey: input.idempotencyKey, status: input.status, sourceId: input.sourceId,
      textLength: typeof input.text === 'string' ? input.text.length : undefined })),
    attention: inbox.filter(item => item.taskId === taskId).map(item => ({ kind: item.kind, status: item.status,
      requestId: item.requestId, questionCount: Array.isArray(item.payload?.questions) ? item.payload.questions.length : 0,
      textQuestion: Array.isArray(item.payload?.questions) && item.payload.questions.every(question =>
        !Array.isArray(question?.options) || question.options.length === 0),
      questionId: item.payload?.questions?.[0]?.id,
      questionLabel: item.payload?.questions?.[0]?.label ?? item.payload?.questions?.[0]?.question ?? item.title })),
    turns: thread.turns.map(turn => ({ id: turn.id, status: turn.status,
      pendingInputs: turn.items.filter(item => item.kind === 'user_input' && item.status === 'pending').map(item => item.requestId) }))
  }
}

export async function submitWebPptJourney(cdp, { promptText = webPptJourneyPrompt, expectedQuestion = webPptQuestion,
  sourceAnswer = webPptSourceHost, requireNewTurn = false, stopAtQuestion = false, onStage } = {}) {
  await onStage?.('read-prior-conversations')
  const priorThreads = (await cdp.evaluate(readRuntime('/v1/threads'))).threads.map(thread => thread.id)
  await onStage?.('create-new-conversation')
  await cdp.click('.ds-sidebar-shell button.w-full', '新建会话')
  await onStage?.('enter-ppt-master-search')
  await cdp.fill(composer, '/ppt')
  await onStage?.('select-ppt-master')
  await cdp.click('[role="option"] .truncate', 'PPT Master')
  await onStage?.('verify-ppt-master-selection')
  await cdp.wait(`Array.from(document.querySelectorAll('[data-composer-skill]')).some(chip=>chip.textContent.includes('PPT Master'))`, 'the selected PPT Master skill')
  await onStage?.('enter-ppt-task-prompt')
  await cdp.fill(composer, promptText)
  await onStage?.('send-ppt-task-prompt')
  await cdp.click('button[aria-label="发送"]:not(:disabled)')
  const questionCheck = expectedQuestion instanceof RegExp
    ? `new RegExp(${literal(expectedQuestion.source)},${literal(expectedQuestion.flags)}).test(${conversationTextProbe()})`
    : `${conversationTextProbe()}.includes(${literal(expectedQuestion)})`
  await onStage?.('wait-for-source-question-in-original-conversation')
  try {
    await cdp.wait(`Boolean(document.querySelector(${literal(answerComposer)}) &&
      (${questionCheck}))`, 'the source question in the original conversation', 120_000)
  } catch {
    const diagnostics = await readWebPptAdmissionDiagnostics(cdp, priorThreads).catch(() => undefined)
    throw Object.assign(new Error('Timed out waiting for the source question'), { webPptDiagnostics: diagnostics })
  }
  const newThreads = (await cdp.evaluate(readRuntime('/v1/threads'))).threads.filter(thread => !priorThreads.includes(thread.id))
  assert.equal(newThreads.length, 1, 'Selecting PPT Master must create only one conversation')
  const [thread] = newThreads
  const task = await cdp.wait(`${readRuntime('/v1/tasks?limit=100')}.then(tasks=>tasks.find(task=>task.originThreadId===${literal(thread.id)} && task.activeTurnId))`,
    'the active task from that conversation')
  assert.equal(task.originThreadId, thread.id, 'The task must remain attached to the original conversation')
  assert.ok(task.threadId, 'KUN must assign an execution thread to the task')
  const replyBefore = await readWebPptReplyState(cdp, task.id, task.threadId)
  const replyTrace = { before: replyBefore }
  if (stopAtQuestion) {
    const pendingQuestion = replyBefore.attention.find(item => item.status === 'pending' && item.kind === 'question' && item.textQuestion && item.questionCount === 1)
    assert.ok(replyBefore.ui.answerComposerVisible && replyBefore.ui.replyHintVisible && replyBefore.ui.submitButtonVisible &&
      typeof pendingQuestion?.requestId === 'string' && replyBefore.ui.taskQuestionRequestId === pendingQuestion.requestId,
      `The task question was not bound to the original chat composer: ${JSON.stringify(replyBefore)}`)
    return { prompt: promptText, conversationThreadId: thread.id, executionThreadId: task.threadId,
      taskId: task.id, turnId: task.activeTurnId, replyTrace, pendingQuestion }
  }
  try {
    const pendingQuestion = replyBefore.attention.find(item => item.status === 'pending' && item.kind === 'question' && item.textQuestion && item.questionCount === 1)
    assert.ok(replyBefore.ui.answerComposerVisible && replyBefore.ui.replyHintVisible && replyBefore.ui.submitButtonVisible &&
      typeof pendingQuestion?.requestId === 'string' && replyBefore.ui.taskQuestionRequestId === pendingQuestion.requestId,
      `The task question was not bound to the original chat composer: ${JSON.stringify(replyBefore)}`)
    const requestId = pendingQuestion.requestId
    const originalTurnId = task.activeTurnId
    const answerKey = `user-input:${requestId}`
    await onStage?.('submit-website-address-in-original-conversation')
    await cdp.fill(answerComposer, sourceAnswer)
    await cdp.click('button[aria-label="提交"]:not(:disabled)')
    const answerReceipt = await cdp.wait(`${readRuntime(`/v1/tasks/${encodeURIComponent(task.id)}/inputs`)}.then(inputs=>{
      const answers=inputs.filter(input=>input.kind==='supplement' && input.idempotencyKey===${literal(answerKey)});
      if(answers.length!==1)return null;
      const answer=answers[0];
      return {idempotencyKey:answer.idempotencyKey,count:answers.length,questionId:${literal(pendingQuestion.questionId)},
        answerLength:typeof answer.text==='string'?answer.text.length:0,answerMatchesExpected:answer.text===${literal(sourceAnswer)}};
    })`, 'KUN to persist the exact request-id answer once', 45_000)
    assert.equal(answerReceipt.questionId, pendingQuestion.questionId)
    assert.equal(answerReceipt.answerMatchesExpected, true)
    assert.ok(answerReceipt.answerLength > 0)
    replyTrace.answerReceipt = answerReceipt
    await onStage?.('verify-question-settlement-and-task-resume')
    await cdp.wait(`${readRuntime('/v1/inbox')}.then(items=>
      !items.some(item=>item.requestId===${literal(requestId)} && item.status==='pending'))`,
    'KUN to resolve the exact pending question', 45_000)
    if (requireNewTurn) {
      await cdp.wait(`${readRuntime(`/v1/tasks/${encodeURIComponent(task.id)}`)}.then(task=>
        task.id===${literal(task.id)} && task.originThreadId===${literal(thread.id)} && task.activeTurnId &&
        task.activeTurnId!==${literal(originalTurnId)} ? task : null)`,
      'the same task in the original conversation to resume in a new Turn', 45_000)
    }
    replyTrace.after = await readWebPptReplyState(cdp, task.id, task.threadId)
    const acceptedAnswers = replyTrace.after.inputs.filter(input => input.kind === 'supplement' && input.idempotencyKey === answerKey)
    assert.equal(acceptedAnswers.length, 1, 'KUN must record exactly one answer for the original task question')
    assert.equal(replyTrace.after.task.id, task.id)
    assert.equal(replyTrace.after.task.originThreadId, thread.id)
    assert.equal(replyTrace.after.task.activeTurnId !== originalTurnId, requireNewTurn)
  } catch (error) {
    replyTrace.after = await readWebPptReplyState(cdp, task.id, task.threadId).catch(() => undefined)
    if (error && typeof error === 'object') error.webPptDiagnostics = replyTrace
    throw error
  }
  return { prompt: promptText, conversationThreadId: thread.id, executionThreadId: task.threadId,
    taskId: task.id, turnId: task.activeTurnId, replyTrace }
}

/** Answer the one open text question after an explicit task resume. */
export async function answerWebPptQuestion(cdp, journey, { sourceAnswer = webPptSourceHost, requireNewTurn = false, onStage } = {}) {
  const task = await cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(journey.taskId)}`))
  assert.equal(task.originThreadId, journey.conversationThreadId)
  assert.equal(task.threadId, journey.executionThreadId)
  const replyBefore = await readWebPptReplyState(cdp, journey.taskId, journey.executionThreadId)
  const pendingQuestion = replyBefore.attention.find(item => item.status === 'pending' && item.kind === 'question' && item.textQuestion && item.questionCount === 1)
  assert.ok(replyBefore.ui.answerComposerVisible && replyBefore.ui.replyHintVisible && replyBefore.ui.submitButtonVisible &&
    typeof pendingQuestion?.requestId === 'string' && replyBefore.ui.taskQuestionRequestId === pendingQuestion.requestId,
    `The resumed task question was not bound to the original chat composer: ${JSON.stringify(replyBefore)}`)
  const requestId = pendingQuestion.requestId
  const originalTurnId = task.activeTurnId
  const answerKey = `user-input:${requestId}`
  await onStage?.('submit-website-address-after-restart')
  await cdp.fill(answerComposer, sourceAnswer)
  await cdp.click('button[aria-label="提交"]:not(:disabled)')
  const answerReceipt = await cdp.wait(`${readRuntime(`/v1/tasks/${encodeURIComponent(journey.taskId)}/inputs`)}.then(inputs=>{
    const answers=inputs.filter(input=>input.kind==='supplement' && input.idempotencyKey===${literal(answerKey)});
    if(answers.length!==1)return null;
    const answer=answers[0];
    return {idempotencyKey:answer.idempotencyKey,count:answers.length,questionId:${literal(pendingQuestion.questionId)},
      answerLength:typeof answer.text==='string'?answer.text.length:0,answerMatchesExpected:answer.text===${literal(sourceAnswer)}};
  })`, 'KUN to persist the post-restart request-id answer once', 45_000)
  assert.equal(answerReceipt.questionId, pendingQuestion.questionId)
  assert.equal(answerReceipt.answerMatchesExpected, true)
  assert.ok(answerReceipt.answerLength > 0)
  await onStage?.('verify-post-restart-question-settlement')
  await cdp.wait(`${readRuntime('/v1/inbox')}.then(items=>!items.some(item=>item.requestId===${literal(requestId)} && item.status==='pending'))`,
    'KUN to resolve the post-restart question', 45_000)
  if (requireNewTurn) {
    await cdp.wait(`${readRuntime(`/v1/tasks/${encodeURIComponent(journey.taskId)}`)}.then(task=>task.activeTurnId && task.activeTurnId!==${literal(originalTurnId)} ? task : null)`,
      'the same task to resume in a new Turn after restart', 45_000)
  }
  const replyAfter = await readWebPptReplyState(cdp, journey.taskId, journey.executionThreadId)
  const acceptedAnswers = replyAfter.inputs.filter(input => input.kind === 'supplement' && input.idempotencyKey === answerKey)
  assert.equal(acceptedAnswers.length, 1, 'KUN must record exactly one post-restart answer for the task question')
  assert.equal(replyAfter.task.originThreadId, journey.conversationThreadId)
  assert.equal(replyAfter.task.activeTurnId !== originalTurnId, requireNewTurn)
  return { ...journey, replyTrace: {
    before: replyBefore, answerReceipt, after: replyAfter
  } }
}

export function validatePostRestartTurnFlow({ originalTurnId, resumedTurnId, answerTurnId }) {
  assert.ok(typeof originalTurnId === 'string' && originalTurnId.length > 0)
  assert.ok(typeof resumedTurnId === 'string' && resumedTurnId.length > 0)
  assert.ok(resumedTurnId !== originalTurnId, 'Continuing a paused task must start a new Turn')
  assert.equal(answerTurnId, resumedTurnId, 'Answering the resumed question must continue that Turn')
  return true
}

export async function verifyEditableWebPpt(path, artifact, { source = webPptSourceHost, marker } = {}) {
  const { default: JSZip } = await import('jszip')
  const info = await lstat(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'The artifact must be a regular PPTX file')
  const bytes = await readFile(path)
  assert.equal(digest(bytes), artifact.sha256, 'Artifact bytes must match the registered output')
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true })
  assert.ok(archive.file('ppt/presentation.xml'), 'The ZIP must be a PowerPoint presentation')
  const slideEntries = Object.keys(archive.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  assert.ok(slideEntries.length >= 1, 'The presentation must contain at least one slide')
  const slideXmls = await Promise.all(slideEntries.map(name => archive.file(name).async('string')))
  const slideXml = slideXmls[0]
  assert.match(slideXml ?? '', /<p:sp>.*?<a:t[^>]*>[^<]+<\/a:t>/s, 'The slide must contain editable native text')
  const allSlideXml = slideXmls.join('\n')
  const allSlideText = [...allSlideXml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map(match => match[1]).join('')
  const searchableContent = `${allSlideText}\n${allSlideXml}`
  assert.match(searchableContent, /工程测量/)
  assert.match(searchableContent, webPptMonitoringTopic)
  const relEntries = Object.keys(archive.files).filter(name => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name))
  const links = (await Promise.all(relEntries.map(name => archive.file(name).async('string')))).join('\n')
  const citationHaystack = `${searchableContent}\n${links}`
  const acceptedSources = source === webPptSourceHost ? [webPptSourceHost, 'railwise.cn'] : [source]
  assert.ok(acceptedSources.some(candidate => citationHaystack.includes(candidate)), 'The editable presentation must cite the actual source')
  if (marker) assert.ok(searchableContent.includes(marker), 'The editable slide must contain the rendered fixture marker')
  return { bytes: bytes.length, sha256: artifact.sha256, nativeEditableText: true }
}

export async function revealArtifact(cdp, label = filename) {
  const list = `${resultRegion} ul[aria-label="成果"]`
  if (!await cdp.evaluate(`Boolean(document.querySelector(${literal(list)})?.getClientRects().length)`)) {
    const toggle = `${resultRegion} button[aria-expanded="false"]`
    const label = await cdp.wait(`[...document.querySelectorAll(${literal(toggle)})]
      .map(button=>button.textContent.trim()).find(text=>/^\\d+ 个成果$/.test(text))`, 'the original chat artifact count')
    await cdp.click(toggle, label)
  }
  const selector = `${list} button`
  await cdp.wait(`[...document.querySelectorAll(${literal(selector)})].some(button=>
    button.getClientRects().length && button.textContent.trim()===${literal(label)})`, 'the delivered PPTX in the original chat')
  return selector
}

function readBrowserPptSource(result, fallback) {
  assert.equal(result.status, 'succeeded')
  assert.equal(result.provider, 'browser-skill')
  assert.equal(result.sourceUrl, fallback.url)
  assert.equal(result.readScope, 'document')
  assert.equal(result.truncated, false)
  assert.equal(result.evidence?.verified, true)
  assert.equal(result.evidence?.contentRead, true)
  assert.equal(result.evidence?.sourceUrl, fallback.url)
  assert.equal(typeof result.html, 'string')
  const hash = digest(result.html)
  assert.equal(result.resultHash, hash)
  assert.equal(result.evidence.resultHash, hash)
  const body = /<main>\s*<h1>([^<]+)<\/h1>\s*<p>([^<]+)<\/p>\s*<\/main>/.exec(result.html)
  assert.equal(body?.[1], fallbackTitle)
  assert.equal(body?.[2], fallback.marker)
  return { url: result.sourceUrl, title: body[1], marker: body[2], sha256: hash,
    bytes: Buffer.byteLength(result.html), tool: 'browser_get_html' }
}

export function inspectWebPptFallback({ initialTurn, completedTurn, fallback, task, inputs, browserInstanceId, conversationThreadId }) {
  assert.equal(task.originThreadId, conversationThreadId, 'The same task must remain attached to the original conversation')
  assert.ok(task.threadId, 'The task execution thread must be recorded separately from the conversation')
  assert.equal(initialTurn.status, 'aborted', 'The retired question Turn must stop before the resumed task reads the source')
  assert.notEqual(completedTurn.id, initialTurn.id)
  assert.equal(completedTurn.status, 'completed')
  assert.ok(!initialTurn.executionGrant?.browserScope?.origins.includes(new URL(fallback.url).origin))
  const grant = completedTurn.executionGrant
  assert.equal(grant?.taskId, task.id)
  assert.deepEqual(grant.browserScope?.origins, [new URL(fallback.url).origin])
  assert.equal(grant.browserScope.interaction, 'observe')
  assert.equal(grant.browserScope.sourceReadOnly, true)
  assert.equal(grant.browserScope.browserInstanceId, browserInstanceId)
  assert.ok(grant.connectorIdentityFingerprints?.['browser-skill'])
  assert.equal(initialTurn.items.filter(item => item.kind === 'user_input').length, 1)
  assert.ok(!completedTurn.items.some(item => item.kind === 'user_input' || item.kind === 'approval'))
  const urls = inputs.filter(input => input.kind === 'supplement' && input.text === fallback.url)
  assert.equal(urls.length, 1, 'The URL typed into the chat must be retained once on the original task')
  assert.equal(urls[0].taskId, task.id)

  const tools = completedTurn.items.filter(item => item.kind === 'tool_result' &&
    (item.toolName === 'web_fetch' || item.toolName.startsWith('browser_')))
  assert.deepEqual(tools.map(item => item.toolName), ['web_fetch', ...browserTools])
  const [fetch, start, navigate, read, stop] = tools
  assert.ok(new Set(tools.map(item => item.callId)).size === tools.length)
  assert.equal(fetch.isError, true)
  assert.equal(fetch.output?.error?.code, 'policy_blocked')
  assert.equal(fetch.output.telemetry?.policy, 'blocked')
  assert.equal(fetch.output.telemetry?.url, fallback.url)
  for (const item of [start, navigate, read, stop]) {
    assert.notEqual(item.isError, true)
    assert.equal(item.output?.status, 'succeeded')
    assert.equal(item.output.sessionId, start.output.sessionId)
  }
  assert.ok(start.output.sessionId)
  assert.equal(start.output.browserInstanceId, browserInstanceId)
  assert.equal(navigate.output.sourceUrl, fallback.url)
  assert.equal(stop.output.stopped, true)
  const source = readBrowserPptSource(read.output, fallback)
  return { source, taskId: task.id, originThreadId: task.originThreadId, executionThreadId: task.threadId,
    initialTurnId: initialTurn.id, completedTurnId: completedTurn.id,
    originalQuestionCount: 1, supplements: urls.length, directFetchBlock: fetch.output.error.code, directFetchUrl: fetch.output.telemetry.url,
    browserInstanceId, sessionId: start.output.sessionId, toolNames: tools.map(item => item.toolName),
    readOnlyOrigins: grant.browserScope.origins, sourceReadOnly: true }
}

export function validateWebPptTurnIdentity(proof) {
  assert.equal(proof.sameConversation, true)
  assert.ok(proof.taskId && proof.conversationThreadId && proof.executionThreadId)
  assert.equal(proof.originThreadId, proof.conversationThreadId)
  assert.equal(proof.originalConversation?.questionVisible, true)
  assert.equal(proof.originalConversation?.artifactVisible, true)
  const replyTrace = proof.replyTrace
  assert.ok(replyTrace?.before && replyTrace?.after, 'The installed UI must record the original task question and its KUN receipt')
  const questions = replyTrace.before.attention.filter(item => item.status === 'pending' && item.kind === 'question' &&
    item.textQuestion && item.questionCount === 1)
  assert.equal(questions.length, 1, 'Exactly one open text question must be bound to the composer')
  const requestId = questions[0].requestId
  assert.ok(requestId)
  assert.equal(replyTrace.before.ui.taskQuestionRequestId, requestId)
  assert.ok(questions[0].questionId)
  assert.equal(typeof questions[0].questionLabel, 'string')
  assert.equal(replyTrace.answerReceipt?.idempotencyKey, `user-input:${requestId}`)
  assert.equal(replyTrace.answerReceipt?.count, 1)
  assert.equal(replyTrace.answerReceipt?.questionId, questions[0].questionId)
  assert.equal(replyTrace.answerReceipt?.answerMatchesExpected, true)
  assert.ok(replyTrace.answerReceipt?.answerLength > 0)
  const answers = replyTrace.after.inputs.filter(input => input.kind === 'supplement' && input.idempotencyKey === `user-input:${requestId}`)
  assert.equal(answers.length, 1, 'The exact question answer must be persisted once by KUN')
  assert.equal(replyTrace.after.task.id, proof.taskId)
  assert.equal(replyTrace.after.task.originThreadId, proof.conversationThreadId)
  assert.ok(!replyTrace.after.attention.some(item => item.requestId === requestId && item.status === 'pending'),
    'The exact answered question must be absent from the pending inbox')
  const expectedSameAnswerTurn = proof.restartRecovery ? true : proof.sameTurn
  assert.equal(replyTrace.after.task.activeTurnId === replyTrace.before.task.activeTurnId, expectedSameAnswerTurn)
  if (proof.sameTurn === true && !proof.initialTurnId && !proof.completedTurnId) return
  assert.ok(proof.initialTurnId && proof.completedTurnId, 'Both execution Turn IDs are required')
  assert.equal(proof.sameTurn, proof.initialTurnId === proof.completedTurnId)
}

export function validateWebPptFallbackProof(proof, browser) {
  assert.equal(proof.status, 'passed')
  assert.equal(proof.input, 'installed-chat-ui')
  assert.equal(proof.model, 'controlled-protocol')
  validateWebPptTurnIdentity(proof)
  assert.equal(proof.sameTurn, false)
  const recovery = proof.browserRecovery
  assert.ok(recovery.taskId && recovery.sessionId && recovery.browserInstanceId)
  assert.equal(recovery.taskId, proof.taskId)
  assert.equal(recovery.originThreadId, proof.conversationThreadId)
  assert.equal(recovery.executionThreadId, proof.executionThreadId)
  assert.equal(recovery.initialTurnId, proof.initialTurnId)
  assert.equal(recovery.completedTurnId, proof.completedTurnId)
  assert.equal(recovery.originalQuestionCount, 1)
  assert.equal(recovery.supplements, 1)
  assert.equal(recovery.directFetchBlock, 'policy_blocked')
  assert.equal(recovery.directFetchUrl, proof.source.url)
  assert.deepEqual(recovery.toolNames, ['web_fetch', ...browserTools])
  assert.equal(recovery.sourceReadOnly, true)
  const source = new URL(proof.source.url)
  assert.equal(source.protocol, 'http:')
  assert.equal(source.hostname, '127.0.0.1')
  assert.equal(source.pathname, '/ppt-source')
  assert.deepEqual(recovery.readOnlyOrigins, [source.origin])
  assert.equal(proof.source.tool, 'browser_get_html')
  assert.match(proof.source.sha256, sha256)
  assert.ok(Number.isSafeInteger(proof.source.bytes) && proof.source.bytes > 0)
  assert.equal(browser.browserInstanceId, recovery.browserInstanceId)
  assert.equal(browser.isolatedTestCredentialStore, true)
  assert.equal(browser.cliVersion, '0.5.0')
  assert.match(browser.cliSha256, sha256)
  assert.equal(browser.protocolVersion, '1.9')
  assert.match(browser.extensionId, /^[a-p]{32}$/)
  assert.equal(browser.extension.version, browserSmokeDependency.extensionVersion)
  assert.equal(browser.extension.sha256, browserSmokeDependency.extensionSha256)
  assert.equal(browser.browser.version, browserSmokeDependency.chromeVersion)
  assert.match(browser.browser.executableSha256, sha256)
  assert.ok(proof.artifact.id)
  assert.equal(proof.artifact.nativeEditableText, true)
  assert.equal(proof.artifact.originalChatButtonClicked, true)
  assert.match(proof.artifact.sha256, sha256)
  assert.ok(Number.isSafeInteger(proof.artifact.bytes) && proof.artifact.bytes > 0)
  assert.equal(proof.open.status, 'desktop-open-request-accepted')
}

export function createWebPptJourney({ workspace, sidecar, parseToolOutput, live = false, fallback, skillGuardPath, pauseAndRestart = false }) {
  assert.ok(!live || !fallback, 'The real-browser fallback uses a controlled model')
  const observed = {}
  return {
    modelAction(body) {
      const { messages, tools = [] } = body
      if (!messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(webPptJourneyPrompt))) return undefined
      const output = (id, acceptError = false) => {
        const item = messages.find(message => message.role === 'tool' && message.tool_call_id === `web-ppt-${id}`)
        if (!item) return undefined
        const value = parseToolOutput(item.content)
        assert.ok(value && (acceptError || !value.error && value.ok !== false), `The installed Runtime tool failed: ${id}`)
        return value
      }
      const call = (name, args, id) => toolCall(tools, name, args, id)
      const supplied = fallback?.url ?? webPptSourceHost
      const sourceInSupplement = messages.some(message => message.role === 'user' &&
        typeof message.content === 'string' && message.content.includes(supplied))
      const answer = output('request_user_input', Boolean(fallback))
      if (!answer && !sourceInSupplement) return call('request_user_input', { question: webPptQuestion })
      if (!sourceInSupplement) assert.equal(answer.answers?.[0]?.value, supplied, 'The exact source address must reach the waiting run')
      const direct = output('web_fetch', Boolean(fallback))
      if (!direct) return call('web_fetch', { url: supplied })
      let source
      if (fallback) {
        assert.equal(direct.error?.code, 'policy_blocked', 'The built-in reader must explicitly reject the isolated fixture')
        assert.equal(direct.telemetry?.url, fallback.url)
        const started = output('browser_session_start')
        if (!started) return call('browser_session_start', {})
        const sessionId = started.sessionId
        assert.ok(sessionId)
        const navigated = output('browser_navigate')
        if (!navigated) return call('browser_navigate', { sessionId, url: fallback.url })
        assert.equal(navigated.sourceUrl, fallback.url)
        const read = output('browser_get_html')
        if (!read) return call('browser_get_html', { sessionId })
        source = readBrowserPptSource(read, fallback)
        const stopped = output('browser_session_stop')
        if (!stopped) return call('browser_session_stop', { sessionId })
        assert.equal(stopped.stopped, true)
      } else {
        assert.equal(direct.finalUrl, webPptSourceUrl)
        assert.match(direct.text, /工程测量/)
        assert.match(direct.text, webPptMonitoringTopic)
        assert.match(direct.resultHash, /^[a-f0-9]{64}$/)
        source = { url: direct.finalUrl, title: direct.title, sha256: direct.resultHash, bytes: direct.byteCount, tool: 'web_fetch' }
      }
      observed.source = { url: source.url, sha256: source.sha256, bytes: source.bytes, tool: source.tool }
      if (pauseAndRestart) {
        const guard = output('ppt-master-attribution-guard', true)
        if (!guard) return call('request_host_shell', {
          command: `${process.platform === 'win32' ? 'python' : 'python3'} "${skillGuardPath}"`, timeout_seconds: 20, ttl_seconds: 120, idempotency_key: 'ppt-master-attribution-guard'
        }, 'ppt-master-attribution-guard')
        assert.notEqual(guard.isError, true, 'The installed attribution check must succeed after its one approval')
        assert.notEqual(guard.code, 'outcome_unknown', 'The approved command result must be verified')
        observed.approval = { scope: 'single-installed-skill-integrity-check', status: 'verified' }
      }
      if (!output('spec-lock')) return call('write', { path: `${project}/spec_lock.md`, content: specLock }, 'spec-lock')
      const slide = createSlide(source.title, source.url, source.marker)
      const written = output('slide')
      if (!written) return call('write', { path: `${project}/svg_output/slide_01.svg`, content: slide }, 'slide')
      assert.ok(slide.length > 1000)
      assert.equal(written.sha256, digest(slide), 'The long display summary must not truncate the file write')
      if (!output('ppt_master_export')) {
        const run = spawnSync(sidecar, [], {
          cwd: workspace, encoding: 'utf8', timeout: 30_000, windowsHide: true,
          input: literal({ operation: 'ppt-master-quality-check', workspaceRoot: workspace, projectPath: join(workspace, project), stage: 'final' })
        })
        assert.equal(run.status, 0, run.error?.message ?? 'Installed quality checker failed')
        assert.equal(JSON.parse(run.stdout).ok, true, 'The installed quality checker must approve the native slide')
        observed.quality = 'fixture-invoked-installed-sidecar'
        return call('ppt_master_export', { project_path: project, output_path: artifactPath })
      }
      observed.complete = true
      return { content: '已根据睿威官网公开资料生成并核对演示文稿。' }
    },
    async verify(cdp, { openArtifact, browserInstanceId, onStage, pauseAndRestart } = {}) {
      await onStage?.('start-original-conversation-journey')
      let journey = await submitWebPptJourney(cdp, {
        promptText: live ? liveWebPptJourneyPrompt : webPptJourneyPrompt,
        expectedQuestion: live ? '网址' : webPptQuestion,
        sourceAnswer: fallback?.url ?? webPptSourceHost, requireNewTurn: Boolean(fallback),
        stopAtQuestion: Boolean(pauseAndRestart), onStage })
      let restartRecovery
      if (pauseAndRestart) {
        const restarted = await pauseAndRestart({ journey, task: await cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(journey.taskId)}`)) })
        assert.ok(restarted?.cdp, 'The owned application must expose a renderer after restart')
        cdp = restarted.cdp
        journey = await answerWebPptQuestion(cdp, journey, {
          sourceAnswer: fallback?.url ?? webPptSourceHost,
          requireNewTurn: Boolean(fallback), onStage
        })
        restartRecovery = restarted.evidence
        restartRecovery.afterRestart.answerTurnId = journey.replyTrace.after.task.activeTurnId
        validatePostRestartTurnFlow({ originalTurnId: restartRecovery.beforeRestart.activeTurnId,
          resumedTurnId: restartRecovery.afterRestart.resumedTurnId,
          answerTurnId: journey.replyTrace.after.task.activeTurnId })
        restartRecovery.answerReceiptCount = journey.replyTrace.answerReceipt?.count ?? 0
        restartRecovery.answerReceiptRequestId = journey.replyTrace.answerReceipt?.idempotencyKey?.slice('user-input:'.length)
        const inputs = await cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(journey.taskId)}/inputs`))
        restartRecovery.answeredQuestionRequestCount = inputs.filter(input => input.kind === 'supplement' &&
          input.idempotencyKey === `user-input:${restartRecovery.afterRestart.resumedQuestionRequestId}`).length
      }
      await onStage?.('wait-for-original-task-completion')
      let task, approvals = []
      try {
        const waited = await waitForWebPptTask(cdp, journey.taskId, { live, allowControlledHostShell: Boolean(pauseAndRestart), workspace, skillGuardPath, onStage,
          timeoutMs: live ? 480_000 : 180_000 })
        task = waited.task
        approvals = waited.resolutions
      } catch {
        const diagnostics = await readWebPptTaskDiagnostics(cdp, journey.taskId, journey.executionThreadId)
        throw Object.assign(new Error('Timed out or blocked waiting for the original task state'), { webPptDiagnostics: diagnostics })
      }
      if (task.status !== 'completed') {
        const diagnostics = await readWebPptTaskDiagnostics(cdp, journey.taskId, journey.executionThreadId)
        throw Object.assign(new Error('PPT task did not complete'), { webPptDiagnostics: diagnostics })
      }
      if (restartRecovery) {
        const inputs = await cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(journey.taskId)}/inputs`))
        const approvalInputs = inputs.filter(input => input.kind === 'approval_resolution')
        const approvalIds = approvals.map(approval => approval.id)
        const approvalInputIds = approvalInputs.map(input => input.sourceId)
        assert.deepEqual(approvalInputIds, approvalIds, 'Every task approval must have exactly one matching durable UI decision')
        assert.deepEqual(approvalInputs.map(input => input.id), approvals.map(approval => approval.inputId),
          'The visible approval card and durable decision must resolve to the same TaskInput')
        restartRecovery.approvals = approvals
        restartRecovery.approvalCount = approvals.length
        restartRecovery.approvalCardCount = approvals.filter(approval => approval.method === 'installed-task-card').length
        restartRecovery.approvalResolutionCount = approvalInputs.length
        restartRecovery.approvalResolutionRequestIds = approvalInputIds
        const resolutionsByRequest = new Map()
        for (const input of approvalInputs) resolutionsByRequest.set(input.sourceId, (resolutionsByRequest.get(input.sourceId) ?? 0) + 1)
        restartRecovery.approvalResolutionDuplicateCount = [...resolutionsByRequest.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0)
      }
      assert.equal(task.originThreadId, journey.conversationThreadId)
      assert.equal(task.threadId, journey.executionThreadId)
      assert.equal(task.id, journey.taskId)
      if (!live) assert.equal(observed.complete, true, 'The installed tool results must reach the controlled model')
      await onStage?.('verify-saved-task-and-source-read')
      const saved = await cdp.evaluate(readRuntime(`/v1/threads/${encodeURIComponent(journey.executionThreadId)}`))
      const initialTurn = saved.turns.find(item => item.id === journey.turnId)
      const completedTurn = saved.turns.find(item => item.id === task.activeTurnId)
      assert.ok(initialTurn?.activeSkillIds.includes('ppt-master'))
      assert.ok(completedTurn, 'The original conversation must retain the completed Turn')
      assert.deepEqual(initialTurn.items.find(item => item.kind === 'user_message' && item.skillSelections?.length)?.skillSelections,
        [{ id: 'ppt-master', name: 'PPT Master' }])
      const sameTurn = initialTurn.id === completedTurn.id
      if (sameTurn) assert.equal(initialTurn.items.filter(item => item.kind === 'tool_result' && ['request_user_input', 'user_input'].includes(item.toolName)).length, 1)
      else assert.equal(initialTurn.status, 'aborted')
      let source = observed.source
      let browserRecovery
      if (fallback) {
        const inputs = await cdp.evaluate(readRuntime(`/v1/tasks/${encodeURIComponent(journey.taskId)}/inputs`))
        const { source: browserSource, ...recovery } = inspectWebPptFallback({ initialTurn, completedTurn, fallback, task, inputs, browserInstanceId,
          conversationThreadId: journey.conversationThreadId })
        assert.deepEqual(source, { url: browserSource.url, sha256: browserSource.sha256, bytes: browserSource.bytes, tool: browserSource.tool })
        browserRecovery = recovery
      }
      if (live) {
        const sourceRead = inspectLiveWebPptSourceRead(completedTurn, webPptSourceUrl, browserInstanceId)
        if (browserInstanceId) assert.equal(sourceRead.provider, 'browser-skill', 'A connected Chrome BrowserSkill must be used before web_fetch')
        source = sourceRead.source
        observed.sourceProvider = sourceRead.provider
        if (sourceRead.taskSpaceId) observed.egoTaskSpaceId = sourceRead.taskSpaceId
      }
      await onStage?.('verify-registered-editable-pptx')
      const artifact = task.artifacts.find(item => item.relativePath.replaceAll('\\', '/') === artifactPath)
        ?? (live ? task.artifacts.find(item => item.validation === 'valid' && item.relativePath.toLowerCase().endsWith('.pptx')) : undefined)
      let contents, selector, output
      try {
        assert.equal(artifact?.validation, 'valid')
        const deliveredRelativePath = artifact.relativePath.replaceAll('\\', '/')
        const deliveredFilename = deliveredRelativePath.split('/').at(-1)
        output = join(workspace, deliveredRelativePath)
        const fromWorkspace = relative(await realpath(workspace), await realpath(output))
        assert.ok(fromWorkspace && !isAbsolute(fromWorkspace) && fromWorkspace !== '..' && !fromWorkspace.startsWith(`..${sep}`))
        contents = await verifyEditableWebPpt(output, artifact, { source: fallback?.url, marker: fallback?.marker })
        selector = await revealArtifact(cdp, deliveredFilename)
        await cdp.click(selector, deliveredFilename)
      } catch (error) {
        const safeDiagnostics = {
          stage: 'verify-registered-editable-pptx',
          artifactCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
          pptxArtifactCount: Array.isArray(task.artifacts) ? task.artifacts.filter(item => typeof item?.relativePath === 'string' && item.relativePath.toLowerCase().endsWith('.pptx')).length : 0,
          matchedExpectedArtifactPath: Boolean(task.artifacts?.some(item => item.relativePath?.replaceAll('\\', '/') === artifactPath)),
          selectedValidation: artifact?.validation
        }
        throw Object.assign(error, { webPptDiagnostics: safeDiagnostics })
      }
      await onStage?.('open-pptx-through-system-application')
      const open = openArtifact ? await openArtifact(cdp, { task, artifact, path: output }) : { status: 'ui-click-only' }
      await onStage?.('verify-original-question-and-deliverable-remain-visible')
      await cdp.wait(`${conversationTextProbe()}.includes(${literal(live ? '网址' : webPptQuestion)})`,
        'the answered source question restored in the original conversation', 15_000)
      const originalConversationText = await cdp.evaluate(conversationTextProbe())
      assert.ok(originalConversationText.includes(live ? '网址' : webPptQuestion),
        'The source question must remain visible in the original conversation body')
      assert.ok(await cdp.evaluate(`Boolean(document.querySelector(${literal(selector)})?.getClientRects().length)`),
        'The delivered PPTX must remain visible in the original conversation body')
      return { status: 'passed', model: live ? 'live-model' : 'controlled-protocol', input: 'installed-chat-ui', source,
        quality: observed.quality, taskId: task.id, conversationThreadId: journey.conversationThreadId,
        originThreadId: task.originThreadId, executionThreadId: task.threadId, sameConversation: true,
        ...(observed.sourceProvider ? { sourceProvider: observed.sourceProvider } : {}),
        ...(observed.egoTaskSpaceId ? { egoTaskSpaceId: observed.egoTaskSpaceId } : {}),
        ...(approvals.length ? { approvals } : {}),
        originalConversation: { questionVisible: true, artifactVisible: true }, sameTurn, initialTurnId: initialTurn.id, completedTurnId: completedTurn.id,
        ...(restartRecovery ? { restartRecovery } : {}),
        replyTrace: journey.replyTrace, ...(browserRecovery ? { browserRecovery } : {}),
        artifact: { id: artifact.id, ...contents, originalChatButtonClicked: true }, open }
    }
  }
}
