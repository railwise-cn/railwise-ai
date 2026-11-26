import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { canResolvePptJourneyApproval, inspectLiveWebPptApproval, inspectLiveWebPptApprovalResolution, safeWebPptErrorCode, safeWebPptRuntimeSpans, safeWebPptRuntimeSummary, validatePostRestartTurnFlow } from './web-ppt-journey.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

function approval(summary, toolName = 'web_fetch') {
  return { taskId: 'website-ppt-task', kind: 'approval', status: 'pending', requestId: 'read-approval',
    payload: { approval: { id: 'read-approval', status: 'pending', callId: 'source-read', toolName,
      summary, requestHash: hash(summary) } } }
}

function hostApproval(workspace, command) {
  const requestHash = hash(JSON.stringify({ workspace, command }))
  const summary = ['Run request_host_shell',
    'Authority: Full host access for this exact command only; workspace trust remains unchanged',
    `Workspace (JSON): ${JSON.stringify(workspace)}`, `Workspace SHA256: ${hash(workspace)}`,
    `Command (JSON): ${JSON.stringify(command)}`, `Command SHA256: ${hash(command)}`,
    `Request SHA256: ${requestHash}`, 'Lifetime seconds: 120', 'Timeout seconds: 60',
    'Session: Read output or stop only; no stdin writes, connector proxy or automatic replay'].join('\n')
  const value = approval(summary, 'request_host_shell')
  value.payload.approval.requestHash = requestHash
  return value
}

test('PPT live approval is limited to the official read-only origin', () => {
  const summary = 'Read public web page\nOrigin: https://www.railwise.cn\nEffect: Read page content only.'
  const value = approval(summary)
  assert.equal(inspectLiveWebPptApproval(value, { taskId: value.taskId }).scope, 'read-only-public-origin')
  const chinese = approval('读取公开网页\n网站：https://www.railwise.cn\n范围：仅当前任务\n影响：只读取网页内容，不会登录、填写或提交数据。')
  assert.equal(inspectLiveWebPptApproval(chinese, { taskId: chinese.taskId }).scope, 'read-only-public-origin')
  for (const changed of [
    { ...value, taskId: 'another-task' },
    approval(summary.replace('www.railwise.cn', 'example.com')),
    approval(summary.replace('Read page content only.', 'Write page content.')),
    approval('读取公开网页\n网站：https://www.railwise.cn\n范围：所有任务\n影响：只读取网页内容，不会登录、填写或提交数据。'),
    approval('读取公开网页\n网站：https://www.railwise.cn\n范围：仅当前任务\n影响：读取并提交网页表单。'),
    approval(summary, 'exec')
  ]) assert.throws(() => inspectLiveWebPptApproval(changed, { taskId: value.taskId }))
})

test('PPT live host approval accepts the actual packaged guard command on both platforms only', () => {
  const samples = [
    { platform: 'darwin', workspace: '/private/tmp/qa workspace', skillGuardPath: '/Applications/RailWise AI.app/Contents/Resources/app.asar.unpacked/src/asset/skills/ppt-master/scripts/attribution_guard.py', prefix: 'python3' },
    { platform: 'win32', workspace: 'D:\\a\\_temp\\中文 验收工作区', skillGuardPath: 'D:\\a\\_temp\\RailWise AI\\resources\\app.asar.unpacked\\src\\asset\\skills\\ppt-master\\scripts\\attribution_guard.py', prefix: '& python' }
  ]
  for (const sample of samples) {
    const command = `${sample.prefix} "${sample.skillGuardPath}"`
    const value = hostApproval(sample.workspace, command)
    const options = { ...sample, taskId: value.taskId }
    assert.equal(inspectLiveWebPptApproval(value, options).scope, 'single-integrity-check-command')
    assert.throws(() => inspectLiveWebPptApproval(value, { ...options, skillGuardPath: undefined }))
    assert.throws(() => inspectLiveWebPptApproval(value, { ...options, workspace: `${sample.workspace}/other` }))
    for (const unsafe of [command + ' --rewrite', command + '; echo extra', `${sample.prefix} "other.py"`]) {
      assert.throws(() => inspectLiveWebPptApproval(hostApproval(sample.workspace, unsafe), options))
    }
  }
})

test('PPT live approval reads the real TaskInput JSON envelope and rejects a stale or duplicate decision', () => {
  const attention = approval('the exact reviewed request')
  const input = { id: 'input-once', taskId: attention.taskId, kind: 'approval_resolution', sourceId: attention.requestId,
    text: JSON.stringify({ request: attention.payload.approval.summary, resolution: { decision: 'allow' } }) }
  assert.equal(input.resolution, undefined, 'KUN persists the decision in text, not as a top-level property')
  assert.equal(inspectLiveWebPptApprovalResolution([], attention), undefined)
  assert.deepEqual(inspectLiveWebPptApprovalResolution([input], attention), { status: 'allowed', inputId: input.id })
  assert.equal(inspectLiveWebPptApprovalResolution([{ ...input, sourceId: 'other-request' }], attention), undefined)
  for (const inputs of [
    [input, { ...input, id: 'duplicate' }],
    [{ ...input, taskId: 'other-task' }],
    [{ ...input, text: JSON.stringify({ request: 'stale request', resolution: { decision: 'allow' } }) }],
    [{ ...input, text: JSON.stringify({ request: attention.payload.approval.summary, resolution: { decision: 'deny' } }) }],
    [{ ...input, text: 'invalid-json' }]
  ]) assert.throws(() => inspectLiveWebPptApprovalResolution(inputs, attention))
})

test('paused PPT continuation creates one new Turn and its answer continues that Turn', () => {
  assert.equal(validatePostRestartTurnFlow({ originalTurnId: 'turn-before-pause', resumedTurnId: 'turn-after-resume', answerTurnId: 'turn-after-resume' }), true)
  assert.throws(() => validatePostRestartTurnFlow({ originalTurnId: 'turn-before-pause', resumedTurnId: 'turn-before-pause', answerTurnId: 'turn-before-pause' }), /must start a new Turn/)
  assert.throws(() => validatePostRestartTurnFlow({ originalTurnId: 'turn-before-pause', resumedTurnId: 'turn-after-resume', answerTurnId: 'another-turn' }), /must continue that Turn/)
})

test('controlled pause recovery permits only the scoped web read and exact attribution check approvals', () => {
  for (const toolName of ['web_fetch', 'request_host_shell']) {
    assert.equal(canResolvePptJourneyApproval({ live: false, allowControlledHostShell: true, toolName }), true)
  }
  for (const toolName of ['browser_click', 'write', 'exec']) {
    assert.equal(canResolvePptJourneyApproval({ live: false, allowControlledHostShell: true, toolName }), false)
  }
  assert.equal(canResolvePptJourneyApproval({ live: false, allowControlledHostShell: false, toolName: 'web_fetch' }), false)
  assert.equal(canResolvePptJourneyApproval({ live: true, allowControlledHostShell: false, toolName: 'unexpected' }), true)
})

test('PPT failure diagnostics retain error codes while excluding error messages and unsafe values', () => {
  assert.equal(safeWebPptErrorCode({ kind: 'error', code: 'turn_attempt_exception', message: 'private response text' }), 'turn_attempt_exception')
  assert.equal(safeWebPptErrorCode({ kind: 'tool_result', isError: true, output: { code: 'web_fetch_failed', error: 'private response text' } }), 'web_fetch_failed')
  assert.equal(safeWebPptErrorCode({ kind: 'tool_result', isError: false, output: { code: 'ok' } }), undefined)
  assert.equal(safeWebPptErrorCode({ kind: 'error', code: 'private response text' }), undefined)
})

test('PPT runtime diagnostics retain safe span fields and omit names, model and attributes', () => {
  assert.deepEqual(safeWebPptRuntimeSpans([{
    kind: 'model', status: 'error', errorCode: 'model_stream_incomplete', retryCount: 2,
    durationMs: 1200, inputTokens: 500, outputTokens: 40, name: 'private request', model: 'private model',
    attributes: { prompt: 'private response', requestUrl: 'https://private.example' }
  }, {
    kind: 'tool', status: 'error', errorCode: 'Authorization: secret-value', retryCount: 1,
    attributes: { command: 'private command' }
  }]), [
    { kind: 'model', status: 'error', errorCode: 'model_stream_incomplete', retryCount: 2,
      durationMs: 1200, inputTokens: 500, outputTokens: 40 },
    { kind: 'tool', status: 'error', retryCount: 1 }
  ])
  assert.deepEqual(safeWebPptRuntimeSpans(undefined), [])
  assert.deepEqual(safeWebPptRuntimeSummary({ total: 4, running: 0, errors: 1, retries: 2, durationMs: 900,
    prompt: 'private response', model: 'private model' }), { total: 4, running: 0, errors: 1, retries: 2, durationMs: 900 })
  assert.equal(safeWebPptRuntimeSummary(undefined), undefined)
})
