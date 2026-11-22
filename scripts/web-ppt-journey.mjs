import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

export const webPptSourceHost = 'www.railwise.cn'
export const webPptSourceUrl = `https://${webPptSourceHost}/`
export const webPptQuestion = '请提供制作 PPT 所需的官网网址。'
const prompt = '请用所选技能制作单页可编辑演示文稿 deck/website.pptx。请先用自由文本提问工具问我官网网址，再用官网的工程测量和安全监测资料制作，并在演示文稿内列出来源。'
const project = 'deck'
const filename = 'website.pptx'
const artifactPath = `${project}/${filename}`
const composer = '.ds-chat-composer-dock textarea[placeholder="向智能体提问…"]:not(:disabled)'
const answerComposer = '.ds-chat-composer-dock textarea[placeholder="输入你的回答…"]:not(:disabled)'
const timeline = '.ds-message-timeline-content'
const resultRegion = `${timeline} section[aria-label="任务"]`
const literal = JSON.stringify
const digest = value => createHash('sha256').update(value).digest('hex')
const specLock = [
  '<!-- ppt-master-schema: spec-lock/v1 -->', '# Execution Lock', '',
  '## canvas', '- viewBox: 0 0 1280 720', '- format: ppt169', '', '## colors',
  '- bg: #FFFFFF', '- primary: #142335', '- accent: #2872D0', '- text: #142335', '',
  '## typography', '- font_family: Arial', '- title_family: Arial', '- body_family: Arial', '- body: 18', '- title: 36', '',
  '## pptx_structure', '- mode: flat', '', '## communication', '- primary_language: zh-CN', ''
].join('\n')

function createSlide(title) {
  const escape = value => value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
  const rows = [title, '官网公开资料', webPptSourceUrl].map((text, index) =>
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

export async function submitWebPptJourney(cdp, { promptText = prompt, expectedQuestion = webPptQuestion } = {}) {
  const priorThreads = (await cdp.evaluate(readRuntime('/v1/threads'))).threads.map(thread => thread.id)
  await cdp.click('.ds-sidebar-shell button.w-full', '新建会话')
  await cdp.fill(composer, '/ppt')
  await cdp.click('[role="option"] .truncate', 'PPT Master')
  await cdp.wait(`Array.from(document.querySelectorAll('[data-composer-skill]')).some(chip=>chip.textContent.includes('PPT Master'))`, 'the selected PPT Master skill')
  await cdp.fill(composer, promptText)
  await cdp.click('button[aria-label="发送"]:not(:disabled)')
  const questionCheck = expectedQuestion instanceof RegExp
    ? `new RegExp(${literal(expectedQuestion.source)},${literal(expectedQuestion.flags)}).test(document.querySelector(${literal(timeline)})?.innerText ?? '')`
    : `document.querySelector(${literal(timeline)})?.innerText.includes(${literal(expectedQuestion)})`
  await cdp.wait(`Boolean(document.querySelector(${literal(answerComposer)}) &&
    (${questionCheck}))`, 'the source question in the original conversation', 120_000)
  const newThreads = (await cdp.evaluate(readRuntime('/v1/threads'))).threads.filter(thread => !priorThreads.includes(thread.id))
  assert.equal(newThreads.length, 1, 'Selecting PPT Master must create only one conversation')
  const [thread] = newThreads
  const task = await cdp.wait(`${readRuntime('/v1/tasks?limit=100')}.then(tasks=>tasks.find(task=>task.originThreadId===${literal(thread.id)} && task.activeTurnId))`,
    'the active task from that conversation')
  assert.equal(task.threadId, thread.id, 'PPT execution must stay in the original conversation')
  await cdp.fill(answerComposer, webPptSourceHost)
  await cdp.click('button[aria-label="提交"]:not(:disabled)')
  return { prompt: promptText, threadId: thread.id, taskId: task.id, turnId: task.activeTurnId }
}

export async function verifyEditableWebPpt(path, artifact) {
  const { default: JSZip } = await import('jszip')
  const info = await lstat(path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'The artifact must be a regular PPTX file')
  const bytes = await readFile(path)
  assert.equal(digest(bytes), artifact.sha256, 'Artifact bytes must match the registered output')
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true })
  assert.ok(archive.file('ppt/presentation.xml'), 'The ZIP must be a PowerPoint presentation')
  const slideXml = await archive.file('ppt/slides/slide1.xml')?.async('string')
  assert.match(slideXml ?? '', /<p:sp>.*?<a:t[^>]*>[^<]+<\/a:t>/s, 'The slide must contain editable native text')
  assert.match(slideXml, /工程测量/)
  assert.match(slideXml, /安全监测/)
  const links = await archive.file('ppt/slides/_rels/slide1.xml.rels')?.async('string')
  assert.match(`${slideXml}\n${links ?? ''}`, /www\.railwise\.cn/)
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

export function createWebPptJourney({ workspace, sidecar, parseToolOutput, live = false }) {
  const observed = {}
  return {
    modelAction(body) {
      const { messages, tools = [] } = body
      if (!messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes(prompt))) return undefined
      const output = id => {
        const item = messages.find(message => message.role === 'tool' && message.tool_call_id === `web-ppt-${id}`)
        if (!item) return undefined
        const value = parseToolOutput(item.content)
        assert.ok(value && !value.error && value.ok !== false, `The installed Runtime tool failed: ${id}`)
        return value
      }
      const call = (name, args, id) => toolCall(tools, name, args, id)
      const answer = output('request_user_input')
      if (!answer) return call('request_user_input', { question: webPptQuestion })
      assert.equal(answer.answers?.[0]?.value, webPptSourceHost, 'The exact bare URL must reach the waiting run')
      const source = output('web_fetch')
      if (!source) return call('web_fetch', { url: webPptSourceHost })
      assert.equal(source.finalUrl, webPptSourceUrl)
      assert.match(source.text, /工程测量/)
      assert.match(source.text, /安全监测/)
      assert.match(source.resultHash, /^[a-f0-9]{64}$/)
      observed.source = { url: source.finalUrl, sha256: source.resultHash, bytes: source.byteCount, tool: 'web_fetch' }
      if (!output('spec-lock')) return call('write', { path: `${project}/spec_lock.md`, content: specLock }, 'spec-lock')
      const slide = createSlide(source.title)
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
    async verify(cdp, { openArtifact } = {}) {
      const journey = await submitWebPptJourney(cdp, { expectedQuestion: live ? '网址' : webPptQuestion })
      const task = await cdp.wait(`${readRuntime(`/v1/tasks/${encodeURIComponent(journey.taskId)}`)}.then(task=>
        ['completed','failed','stalled','cancelled'].includes(task.status) ? task : null)`, 'completion in the original conversation', live ? 480_000 : 180_000)
      assert.equal(task.status, 'completed', task.waitingReason ?? task.stalledReason)
      assert.equal(task.activeTurnId, journey.turnId, 'The source answer must continue the waiting turn')
      assert.equal(task.threadId, journey.threadId)
      if (!live) assert.equal(observed.complete, true, 'The installed tool results must reach the controlled model')
      const saved = await cdp.evaluate(readRuntime(`/v1/threads/${encodeURIComponent(journey.threadId)}`))
      const turn = saved.turns.find(item => item.id === journey.turnId)
      assert.ok(turn?.activeSkillIds.includes('ppt-master'))
      assert.deepEqual(turn.items.find(item => item.kind === 'user_message' && item.skillSelections?.length)?.skillSelections,
        [{ id: 'ppt-master', name: 'PPT Master' }])
      assert.equal(turn.items.filter(item => item.kind === 'tool_result' && item.toolName === 'request_user_input').length, 1)
      let source = observed.source
      if (live) {
        const fetched = turn.items.find(item => item.kind === 'tool_result' && item.toolName === 'web_fetch' && !item.isError && item.output?.finalUrl === webPptSourceUrl)
        const receipt = fetched?.output
        assert.ok(receipt, 'The live model must read the public source in the waiting turn')
        assert.match(receipt.resultHash, /^[a-f0-9]{64}$/)
        assert.ok(receipt.byteCount > 0)
        source = { url: receipt.finalUrl, sha256: receipt.resultHash, bytes: receipt.byteCount, tool: 'web_fetch' }
      }
      const artifact = task.artifacts.find(item => item.relativePath.replaceAll('\\', '/') === artifactPath)
      assert.equal(artifact?.validation, 'valid')
      const output = join(workspace, artifactPath)
      const fromWorkspace = relative(await realpath(workspace), await realpath(output))
      assert.ok(fromWorkspace && !isAbsolute(fromWorkspace) && fromWorkspace !== '..' && !fromWorkspace.startsWith(`..${sep}`))
      const contents = await verifyEditableWebPpt(output, artifact)
      const selector = await revealArtifact(cdp)
      await cdp.click(selector, filename)
      const open = openArtifact ? await openArtifact(cdp, { task, artifact, path: output }) : { status: 'ui-click-only' }
      return { status: 'passed', model: live ? 'live-model' : 'controlled-protocol', input: 'installed-chat-ui', source,
        quality: observed.quality, sameThread: true, sameTurn: true, artifact: { id: artifact.id, ...contents, originalChatButtonClicked: true }, open }
    }
  }
}
