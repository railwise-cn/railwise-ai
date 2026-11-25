import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { installedChineseWorkbenchReadyExpression, parseMacWindowObservation } from './run-mac-ppt-journey.mjs'

const expression = installedChineseWorkbenchReadyExpression()
const runnerSourcePath = fileURLToPath(new URL('./run-mac-ppt-journey.mjs', import.meta.url))
const journeySourcePath = fileURLToPath(new URL('./web-ppt-journey.mjs', import.meta.url))

function evaluate(document) {
  return vm.runInNewContext(expression, { document, window: { workwise: { getAppVersion() {} } } })
}

test('Mac PPT readiness waits for a parsed document body', () => {
  assert.equal(evaluate({ readyState: 'loading', visibilityState: 'visible', body: null }), false)
  assert.equal(evaluate({ readyState: 'interactive', visibilityState: 'visible', body: null }), false)
  assert.equal(evaluate({ readyState: 'complete', visibilityState: 'visible', body: { innerText: '' } }), false)
  assert.equal(evaluate({ readyState: 'complete', visibilityState: 'visible', body: { innerText: '技能与连接器' } }), true)
})

test('Mac PPT receipts retain the last chat journey stage when CDP stalls', async () => {
  const [runner, journey] = await Promise.all([
    readFile(runnerSourcePath, 'utf8'),
    readFile(journeySourcePath, 'utf8')
  ])

  assert.match(runner, /receipt\.stageHistory\.push\(\{ stage, at: new Date\(\)\.toISOString\(\) \}\)/)
  assert.match(runner, /stage: receipt\.lastStage/)
  for (const stage of [
    'create-new-conversation',
    'enter-ppt-master-search',
    'select-ppt-master',
    'verify-ppt-master-selection',
    'enter-ppt-task-prompt',
    'send-ppt-task-prompt',
    'wait-for-source-question-in-original-conversation',
    'submit-website-address-in-original-conversation',
    'wait-for-original-task-completion',
    'verify-registered-editable-pptx',
    'open-pptx-through-system-application'
  ]) assert.ok(journey.includes(stage), `Missing journey checkpoint ${stage}`)
  assert.match(runner, /spawnSync\('duti', \['-x', 'pptx'\][\s\S]+?env: process\.env/)
  assert.match(runner, /every application process/)
  assert.match(runner, /windows of appProcess/)
  assert.match(runner, /renderer\.visibleFailure/)
  assert.match(runner, /defaultHandler, processes, windows: system\.windows, frontmostProcess: system\.frontmostProcess/)
  assert.doesNotMatch(runner, /soffice', \['--headless', '--terminate_after_init'\]/,
    'The external app must first launch from the delivered-file open action')
  const nativeOpenStart = runner.indexOf('async function waitForNativeMacDocument')
  const nativeOpenEnd = runner.indexOf('\n}\n\nasync function readNativeOpenResult', nativeOpenStart)
  const nativeOpenObserver = runner.slice(nativeOpenStart, nativeOpenEnd)
  assert.match(nativeOpenObserver, /readArtifactOpenFailure\(cdp\)/, 'The observer should read visible failure state after the original UI click')
  assert.doesNotMatch(nativeOpenObserver, /openTaskArtifact\(|openWorkspaceFile\(/,
    'The observer must not invoke the same open IPC a second time')
})

test('new-conversation PPT entry accepts its workspace-specific placeholder', async () => {
  const journey = await readFile(journeySourcePath, 'utf8')
  assert.ok(journey.includes("const composer = '.ds-chat-composer-dock textarea:not(:disabled)'"))
  assert.doesNotMatch(journey, /const composer = '[^']*placeholder="向智能体提问/)
})

test('incomplete PPT tasks retain only the sanitized runtime diagnostics', async () => {
  const journey = await readFile(journeySourcePath, 'utf8')
  const admissionDiagnostics = journey.slice(journey.indexOf('async function readWebPptAdmissionDiagnostics'),
    journey.indexOf('\n}\n\nasync function readWebPptReplyState'))
  assert.match(journey, /readWebPptTaskDiagnostics\(cdp, journey\.taskId, journey\.executionThreadId\)[\s\S]*?webPptDiagnostics: diagnostics/)
  assert.match(journey, /catch \{[\s\S]*?Timed out or blocked waiting for the original task state/)
  assert.match(journey, /readWebPptAdmissionDiagnostics\(cdp, priorThreads\)[\s\S]*?Timed out waiting for the source question/)
  assert.match(admissionDiagnostics, /activeSkillIds: turn\.activeSkillIds, items: turn\.items\.map\(item => \(\{ kind: item\.kind, toolName: item\.toolName/)
  assert.match(admissionDiagnostics, /executionThreads: executionThreads\.map\(thread => \(\{ id: thread\.id, turns: thread\.turns/)
  assert.match(admissionDiagnostics, /activeTurnId: task\.activeTurnId, threadId: task\.threadId/)
  assert.doesNotMatch(admissionDiagnostics, /toolCallArguments|requestHeaders|apiKey|item\.content|prompt|arguments/)
})

test('Mac document-window observations retain the app and title for every visible app window', () => {
  assert.deepEqual(parseMacWindowObservation([
    'FRONTMOST|LibreOffice',
    'WINDOW|RailWise AI|RailWise AI',
    'WINDOW|LibreOffice|website.pptx - LibreOffice',
    ''
  ].join('\n')), {
    frontmostProcess: 'LibreOffice',
    windows: [
      { processName: 'RailWise AI', title: 'RailWise AI' },
      { processName: 'LibreOffice', title: 'website.pptx - LibreOffice' }
    ]
  })
})
