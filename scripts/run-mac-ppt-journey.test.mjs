import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { installedChineseWorkbenchReadyExpression } from './run-mac-ppt-journey.mjs'

const expression = installedChineseWorkbenchReadyExpression()

function evaluate(document) {
  return vm.runInNewContext(expression, { document, window: { workwise: { getAppVersion() {} } } })
}

test('Mac PPT readiness waits for a parsed document body', () => {
  assert.equal(evaluate({ readyState: 'loading', visibilityState: 'visible', body: null }), false)
  assert.equal(evaluate({ readyState: 'interactive', visibilityState: 'visible', body: null }), false)
  assert.equal(evaluate({ readyState: 'complete', visibilityState: 'visible', body: { innerText: '' } }), false)
  assert.equal(evaluate({ readyState: 'complete', visibilityState: 'visible', body: { innerText: '技能与连接器' } }), true)
})
