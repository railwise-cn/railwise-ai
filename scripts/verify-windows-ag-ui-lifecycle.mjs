import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const model = 'railwise-activity-fixture'
const missingFile = 'ag-ui-missing-fixture-0042.txt'
const firstText = '验收前段 0042。'
const replayedText = '验收断线期间 0042。'
const followingText = '同一会话已恢复。'
const callId = 'call-activity-fixture-read'
const composer = 'textarea[placeholder="向智能体提问…"]:not(:disabled)'
const ready = `Boolean(document.querySelector('${composer}'))`
const quote = JSON.stringify
const cutBudgetMs = 12_000

function writeDelta(response, delta, finishReason = null) {
  response.write(`data: ${quote({ id: 'activity-local-fixture', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
}

export async function startWindowsActivityModelFixture() {
  const observed = { requests: [], failure: undefined, streamedResponseClosed: false }
  let pending
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(quote({ data: [{ id: model }] }))
        return
      }
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/v1/chat/completions')
      const chunks = []
      let length = 0
      for await (const block of request) {
        length += block.length
        assert.ok(length < 2_000_000)
        chunks.push(block)
      }
      const { messages, tools } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const userMessage = messages.findLast(message => message.role === 'user')
      assert.ok(userMessage, 'Expected a normal conversation message')
      const latestUser = quote(userMessage.content)
      if (!latestUser.includes('普通会话活动验收')) {
        observed.requests.push('follow-up')
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        writeDelta(response, { content: followingText }, 'stop')
        response.end('data: [DONE]\n\n')
        return
      }
      const toolResult = messages.find(item => item.role === 'tool' && item.tool_call_id === callId)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (!toolResult) {
        assert.ok(tools.some(item => item.function?.name === 'read'), 'Packaged KUN must advertise its built-in read tool')
        observed.requests.push('read-failing-file')
        writeDelta(response, { tool_calls: [{ index: 0, id: callId, type: 'function',
          function: { name: 'read', arguments: quote({ path: missingFile }) } }] }, 'tool_calls')
        response.end('data: [DONE]\n\n')
      } else {
        assert.match(quote(toolResult.content), /ag-ui-missing-fixture-0042\.txt/)
        assert.equal(pending, undefined, 'Expected one active turn and no replayed model call')
        observed.requests.push('hold-stream-after-real-tool-error')
        pending = response
        response.once('close', () => { observed.streamedResponseClosed = true })
        writeDelta(response, { content: firstText })
      }
    } catch (error) {
      observed.failure = error.message
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  return {
    model,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    observed,
    continueDuringDisconnect() {
      assert.ok(pending && !pending.destroyed && !observed.failure)
      writeDelta(pending, { content: replayedText })
    },
    async close() {
      await new Promise(done => { server.close(done); server.closeAllConnections() })
    }
  }
}

function observeOwnedThreadSocket(origin, threadId) {
  const key = Symbol.for('railwise.windows.activity-acceptance')
  if (globalThis[key]) throw new Error('The owned inspector observer is already installed')
  const channel = process.getBuiltinModule('node:diagnostics_channel').channel('undici:client:sendHeaders')
  const pathname = `/v1/threads/${encodeURIComponent(threadId)}/events`
  const cursors = []
  let socket
  const observe = (event) => {
    if (event.request.origin !== origin) return
    const path = new URL(event.request.path, origin)
    if (path.pathname !== pathname) return
    const cursor = Number(path.searchParams.get('since_seq'))
    cursors.push(cursor)
    socket = event.socket
  }
  channel.subscribe(observe)
  globalThis[key] = {
    read: () => ({ cursors: [...cursors], live: Boolean(socket && !socket.destroyed) }),
    disconnect: () => {
      if (!socket || socket.destroyed || socket.remoteAddress !== '127.0.0.1') return false
      socket.destroy()
      return true
    },
    stop: () => { channel.unsubscribe(observe); delete globalThis[key] }
  }
  return true
}

export async function verifyWindowsActivityLifecycle(cdp, inspector, { version, fixture, audit }) {
  assert.ok(inspector, 'The acceptance runner must own the packaged main-process inspector')
  const release = 'main section[aria-label="本版更新"]'
  await cdp.wait(`document.querySelector(${quote(release)})?.innerText.includes(${quote(`本版更新 · ${version}`)})`, 'the exact-version notice on the initial home surface')
  await cdp.wait(ready, 'the ordinary Chinese composer below the first-run notice', 60_000)
  await cdp.click('button[aria-label="关闭本版更新"]')
  await cdp.wait(`!document.querySelector(${quote(release)})`, 'dismissal from the home surface')
  const firstPage = await cdp.evaluate('performance.timeOrigin')
  await cdp.send('Page.reload')
  let reloaded = false
  for (let attempt = 0; attempt < 60 && !reloaded; attempt += 1) {
    try {
      reloaded = await cdp.evaluate(`performance.timeOrigin!==${firstPage} && (${ready}) && window.workwise?.getAppVersion().then(value=>value===${quote(version)})`, 1500)
    } catch { /* A real reload can destroy the old CDP execution context. */ }
    if (!reloaded) await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.equal(reloaded, true, 'The same installed home must reopen in a fresh renderer context')
  assert.equal(await cdp.evaluate(`localStorage.getItem(${quote(`railwise.release-highlights.${version}`)})`), '1')
  assert.equal(await cdp.evaluate(`Boolean(document.querySelector(${quote(release)}))`), false)
  audit.homepage = { source: 'installed-home-before-first-conversation', version, shownOnFirstOpen: true, dismissedAndReloaded: true }

  const runtimeJson = (path) => `window.workwise.runtimeRequest(${quote(path)},'GET').then(result=>result.ok?JSON.parse(result.body):null)`
  const threads = '/v1/threads'
  const previous = (await cdp.wait(runtimeJson(threads), 'packaged KUN thread list', 60_000)).threads.map(thread => thread.id)
  await cdp.click('.ds-sidebar-shell button.w-full', '新建会话')
  const threadId = await cdp.wait(`${runtimeJson(threads)}.then(result=>result?.threads.find(thread=>!${quote(previous)}.includes(thread.id))?.id)`, 'the newly created normal conversation')
  const readThread = runtimeJson(`${threads}/${encodeURIComponent(threadId)}`)
  const port = await cdp.evaluate('window.workwise.getSettings().then(settings=>settings.agents.kun.port)')
  const observer = 'globalThis[Symbol.for("railwise.windows.activity-acceptance")]'
  const origin = `http://127.0.0.1:${port}`
  assert.equal(await inspector.evaluate(`(${observeOwnedThreadSocket})(${quote(origin)}, ${quote(threadId)})`), true)
  try {
    await cdp.fill(composer, '普通会话活动验收，请用本地文件工具做一次只读检查。')
    await cdp.click('button[aria-label="发送"]')
    await cdp.wait(`document.body.innerText.includes(${quote(firstText)}) && Boolean(document.querySelector('button[aria-label="停止"]'))`, 'a running normal KUN response after a real tool failure')
    const runningStatus = await cdp.wait(`Array.from(document.querySelectorAll('[role="status"]')).find(node=>/^正在(整理资料|推进任务|执行任务)/.test(node.innerText.trim()))?.innerText.trim()`, 'visible plain-language live task progress')
    const activeTurn = await cdp.wait(`${readThread}.then(thread=>thread?.turns.length===1 && thread.turns[0]?.id)`, 'one persisted input turn')
    const details = 'button[aria-expanded]'
    await cdp.wait(`Array.from(document.querySelectorAll(${quote(details)})).some(node=>node.querySelector('span')?.textContent==='执行详情' && node.getAttribute('aria-expanded')==='false')`, 'collapsed conversation execution details')
    assert.equal(await cdp.evaluate(`document.body.innerText.includes(${quote(missingFile)})`), false)
    await cdp.click(details, '执行详情')
    const tool = '[role="button"][aria-expanded]'
    const failureLabel = '执行失败'
    await cdp.wait(`Array.from(document.querySelectorAll(${quote(tool)})).some(node=>node.innerText.trim()===${quote(failureLabel)} && node.getAttribute('aria-expanded')==='false')`, 'the quiet, collapsed failed tool details')
    assert.equal(await cdp.evaluate(`document.body.innerText.includes(${quote(missingFile)})`), false)
    await cdp.click(tool, failureLabel)
    await cdp.wait(`document.body.innerText.includes(${quote(missingFile)})`, 'the actual file-read diagnostic after explicit expansion')
    await cdp.click(tool, failureLabel)
    await cdp.click(details, '执行详情')
    await cdp.wait(`!document.body.innerText.includes(${quote(missingFile)})`, 'the diagnostic to close again')
    audit.diagnostics = { renderedCollapsedByDefault: true, outputVisibleOnDemand: true, source: 'packaged-read-tool-error', runningStatus }

    const initial = await inspector.wait(`(() => {const state=${observer}.read();return state.live && state;})()`, 'owned loopback thread event transport', cutBudgetMs)
    assert.equal(await inspector.evaluate(`${observer}.disconnect()`), true, 'Drop only the exact intercepted loopback SSE socket')
    fixture.continueDuringDisconnect()
    const restored = await inspector.wait(`(() => {const state=${observer}.read();return state.live && state.cursors.length>${initial.cursors.length} && state;})()`, 'a new loopback event connection', cutBudgetMs)
    const resumedCursor = restored.cursors.at(-1)
    assert.ok(Number.isSafeInteger(resumedCursor) && resumedCursor > 0, 'The packaged client must reconnect from a durable cursor')
    const occurrences = (text) => `(document.body.innerText.split(${quote(text)}).length-1)`
    await cdp.wait(`${occurrences(replayedText)}===1 && ${occurrences(firstText)}===1`, 'single replay of the content generated across disconnect', cutBudgetMs)
    audit.reconnect = { transport: 'owned-loopback-thread-sse', fixtureResentModelRequest: false,
      startingCursor: initial.cursors.at(-1), resumedCursor, firstTextCount: 1, interruptedTextCount: 1 }

    await cdp.click('button[aria-label="停止"]')
    const endedTurn = await cdp.wait(`${readThread}.then(thread=>thread?.turns.find(turn=>turn.id===${quote(activeTurn)} && turn.status==='aborted'))`, 'the original persisted turn to be aborted by the real Stop button')
    assert.equal(endedTurn.items.filter(item => item.kind === 'tool_result' && item.callId === callId).length, 1)
    await cdp.wait(`!document.querySelector('button[aria-label="停止"]')`, 'the stopped composer to leave its busy state')
    await cdp.fill(composer, '请继续这一会话，只回复一句话。')
    await cdp.click('button[aria-label="发送"]')
    await cdp.wait(`document.body.innerText.includes(${quote(followingText)}) && !document.querySelector('button[aria-label="停止"]')`, 'the subsequent normal reply in the same conversation')
    const final = await cdp.evaluate(readThread)
    assert.deepEqual(final.turns.map(turn => turn.status), ['aborted', 'completed'])
    assert.equal(final.turns[0].id, activeTurn)
    assert.equal(fixture.observed.failure, undefined)
    assert.deepEqual(fixture.observed.requests, ['read-failing-file', 'hold-stream-after-real-tool-error', 'follow-up'])
    assert.equal(fixture.observed.streamedResponseClosed, true, 'Stopping must close the original model connection')
    audit.cancel = { source: 'composer-stop-button', originalTurnAborted: true, originalToolResultCount: 1,
      followUpCompleted: true, fixtureStreamClosed: fixture.observed.streamedResponseClosed }
    return audit
  } finally {
    await inspector.evaluate(`${observer}?.stop()`).catch(() => undefined)
  }
}
