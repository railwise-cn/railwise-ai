import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startWindowsActivityModelFixture } from './verify-windows-ag-ui-lifecycle.mjs'

test('activity fixture drives one bounded read failure and holds the actual stream until cancellation', async t => {
  const fixture = await startWindowsActivityModelFixture()
  t.after(() => fixture.close())
  const endpoint = `${fixture.baseUrl}/chat/completions`
  const post = (messages, signal) => fetch(endpoint, { method: 'POST', signal, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, tools: [{ function: { name: 'read' } }] }) })
  const user = { role: 'user', content: '普通会话活动验收' }
  const request = await post([user])
  const [call] = JSON.parse((await request.text()).split('\n')[0].slice('data: '.length)).choices[0].delta.tool_calls
  assert.equal(call.function.name, 'read')
  assert.equal(JSON.parse(call.function.arguments).path, 'ag-ui-missing-fixture-0042.txt')
  const error = { role: 'tool', tool_call_id: call.id, content: 'ENOENT: ag-ui-missing-fixture-0042.txt' }
  const controller = new AbortController()
  const live = await post([user, error], controller.signal)
  const reader = live.body.getReader()
  const decode = result => new TextDecoder().decode(result.value)
  assert.match(decode(await reader.read()), /验收前段/)
  fixture.continueDuringDisconnect()
  assert.match(decode(await reader.read()), /验收断线期间/)
  controller.abort()
  await assert.rejects(reader.read(), /abort/i)
  const next = await post([{ role: 'user', content: '请继续这一会话。' }])
  assert.match(await next.text(), /同一会话已恢复/)
  assert.deepEqual(fixture.observed.requests, ['read-failing-file', 'hold-stream-after-real-tool-error', 'follow-up'])
  assert.equal(fixture.observed.failure, undefined)
})
