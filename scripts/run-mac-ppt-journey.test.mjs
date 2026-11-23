import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { installedChineseWorkbenchReadyExpression } from './run-mac-ppt-journey.mjs'

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
    'wait-for-source-question-in-original-conversation',
    'submit-website-address-in-original-conversation',
    'wait-for-original-task-completion',
    'verify-registered-editable-pptx',
    'open-pptx-through-system-application'
  ]) assert.ok(journey.includes(stage), `Missing journey checkpoint ${stage}`)
  assert.match(runner, /soffice', \['--headless', '--terminate_after_init'\]/)
  assert.match(runner, /get name of every window of process "LibreOffice"/)
  const nativeOpenStart = runner.indexOf('async function readNativeOpenResult')
  const nativeOpenEnd = runner.indexOf('\n}\n\nexport async function runInstalledMacPptJourney', nativeOpenStart)
  const nativeOpenObserver = runner.slice(nativeOpenStart, nativeOpenEnd)
  assert.doesNotMatch(nativeOpenObserver, /cdp\.evaluate\(/, 'The observer must not invoke the same open IPC a second time')
})
