import assert from 'node:assert/strict'
import { execFile as execFileCallback, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createChineseTextPdf } from './verify-windows-composer-acceptance.mjs'
import { revealWindowsChatTaskArtifact, validateWindowsTaskChatLayout, windowsTaskChatLayoutExpression, windowsTaskChatRegion } from './windows-task-chat-ui.mjs'

const execFile = promisify(execFileCallback)
const digest = value => createHash('sha256').update(value).digest('hex')
const literal = JSON.stringify
const version = '4.0.484'
const model = 'windows-video-evaluation-fixture'
const filename = 'railwise-synthetic-evaluation.mp4'
const script = 'render-evaluation.mjs'
const composition = 'RailWiseSyntheticEvaluation'
const pdfName = '合成视频资料.pdf'
const pdfText = '铁路合成验收'

// Original geometry only. This evaluation does not rely on the media omitted from the Skill.
const scene = `import React from 'react';
import { AbsoluteFill, Composition, registerRoot, useCurrentFrame } from 'remotion';
const Scene = () => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{background:'#17263d', alignItems:'center', justifyContent:'center'}}>
    <svg width="320" height="180" viewBox="0 0 320 180">
      <path d="M38 113H282M38 129H282" fill="none" stroke="#c5e2ef" strokeWidth="4"/>
      <text x="38" y="52" fill="#d8e9f8" fontSize="18">${pdfText}</text>
      <circle cx={52 + frame * 9} cy="92" r="24" fill="#74e1be"/>
    </svg>
  </AbsoluteFill>;
};
registerRoot(() => <Composition id="${composition}" component={Scene} width={320} height={180} fps={24} durationInFrames={24} />);
`

async function provision(workspace, environment) {
  const browser = join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')
  await access(browser)
  const root = join(workspace, 'synthetic-evaluation')
  await mkdir(root)
  await writeFile(join(root, 'package.json'), literal({ name: model, private: true, dependencies: {
    '@remotion/cli': version, remotion: version, react: '19.2.7', 'react-dom': '19.2.7'
  } }))
  await writeFile(join(root, 'index.jsx'), scene)
  const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const packageEnvironment = Object.fromEntries(Object.entries(environment).filter(([name]) => !/^npm_config_/i.test(name)))
  await execFile(process.execPath, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund',
    '--registry', 'https://registry.npmjs.org', '--cache', join(workspace, 'evaluation-npm-cache'),
    '--userconfig', join(root, 'fixture-user.npmrc'), '--globalconfig', join(root, 'fixture-global.npmrc')], { cwd: root,
    env: packageEnvironment, windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 })
  const cli = join(root, 'node_modules', '@remotion', 'cli', 'remotion-cli.js')
  const binaries = join(root, 'node_modules', '@remotion', 'compositor-win32-x64-msvc')
  const ffprobe = join(binaries, 'ffprobe.exe')
  const ffmpeg = join(binaries, 'ffmpeg.exe')
  for (const path of [cli, ffmpeg, ffprobe]) await access(path)
  assert.equal(JSON.parse(await readFile(join(dirname(cli), 'package.json'), 'utf8')).version, version)
  const target = join(workspace, filename)
  const renderDiagnostic = join(root, 'render-diagnostic.json')
  await writeFile(join(workspace, script), `import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
const report = ${literal(renderDiagnostic)};
writeFileSync(report, JSON.stringify({stage: 'started'}));
const result = spawnSync(${literal(process.execPath)}, ${literal([cli, 'render', 'index.jsx', composition, target, '--codec=h264',
    '--concurrency=1', '--chrome-mode=chrome-for-testing', '--browser-executable', browser])}, {cwd:${literal(root)},encoding:'utf8',windowsHide:true,timeout:140000,maxBuffer:4*1024*1024});
const output = (result.stdout ?? '') + '\\n' + (result.stderr ?? '');
const issue = [
  [/invalid.*(?:option|flag|chrome-mode)|unknown option|not a valid option/i, 'invalid-option'],
  [/could not find.*chrome|browser.*failed|browser process|failed to launch|WebSocket/i, 'browser-startup'],
  [/cannot find (?:module|package)|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i, 'module-not-found'],
  [/ffmpeg|ffprobe|compositor/i, 'media-toolchain'],
  [/timed? out|ETIMEDOUT/i, 'timeout'],
  [/permission denied|access is denied|EPERM/i, 'access-denied'],
  [/ESBuild|Webpack|compile|Parsing error|syntax error/i, 'bundle'],
].find(([pattern]) => pattern.test(output))?.[1] ?? 'unclassified';
const code = typeof result.error?.code === 'string' && /^[A-Z_]{3,32}$/.test(result.error.code) ? result.error.code : undefined;
writeFileSync(report, JSON.stringify({stage: 'exited', exitCode: result.status, issue: result.status === 0 ? undefined : issue, code}));
if (result.status !== 0) { console.error('Synthetic render failed:', issue, code ?? ''); process.exitCode = result.status || 1; }
else console.log(${literal(target)});
`)
  return { target, ffmpeg, ffprobe, renderDiagnostic }
}

function matchesPdfText(value) {
  return typeof value === 'string' && value.replace(/[\s\u0000]/gu, '').includes(pdfText)
}

function sectionResultStatus(result, key) {
  if (Array.isArray(result?.[key])) return `${result[key].length} sections`
  if (typeof result !== 'object' || !result) return 'unreadable'
  const error = typeof result.error === 'string' ? result.error : typeof result.message === 'string' ? result.message : ''
  const diagnostic = [
    [/attachment is not authorized for this turn/i, 'attachment scope rejected'], [/attachment not found/i, 'attachment not found'],
    [/not authorized|permission|sandbox/i, 'execution policy rejected'], [/database|sqlite|could not locate the bindings/i, 'attachment index error'],
    [/not available|unknown tool|tool not found/i, 'tool unavailable'], [/invalid|must be|is required/i, 'argument rejected']
  ].find(([pattern]) => pattern.test(error))?.[1]
  const code = typeof result.code === 'string' && /^[a-z_]{3,48}$/.test(result.code) ? result.code : undefined
  return [code, diagnostic, `keys=${Object.keys(result).filter(name => /^[a-z_]{2,32}$/i.test(name)).sort().join(',')}`].filter(Boolean).join(' ')
}

function recoverWorkflow(resource, prefix, tools, results, selection) {
  if (!resource?.contextSpill) return { resource }
  assert.ok(tools.has('read_task_context'), 'The installed workflow has a scoped context reference')
  const reference = resource.contextSpill
  const pinned = (selection.workflowReferences ??= {})[prefix] ??= reference
  assert.ok(pinned.bundle_id && pinned.object_id === reference.object_id && pinned.sha256 === reference.sha256 &&
    /^[a-f0-9]{64}$/.test(pinned.sha256) && pinned.totalBytes === reference.totalBytes &&
    Number.isInteger(pinned.totalBytes) && pinned.totalBytes > 0 && pinned.totalBytes <= 64 * 1024)
  const parts = []
  let offset = 0
  for (let index = 0; index < 16; index++) {
    const id = `${prefix}-recall-workflow-${index}`
    if (!results.has(id)) return { action: [id, 'read_task_context', {
      bundle_id: pinned.bundle_id, object_id: pinned.object_id, offset, max_bytes: 8192
    }] }
    const page = results.get(id)
    assert.ok(page?.untrusted && page.bundleId === pinned.bundle_id && page.objectId === pinned.object_id &&
      page.offset === offset && page.totalBytes === pinned.totalBytes && page.sha256 === pinned.sha256 && typeof page.text === 'string',
    `The scoped workflow page must have the reviewed identity and next UTF-8 offset (${sectionResultStatus(page, 'sections')})`)
    const pageBytes = Buffer.from(page.text, 'utf8')
    assert.ok(pageBytes.length > 0 && pageBytes.length <= 8192)
    parts.push(pageBytes)
    offset += pageBytes.length
    if (page.nextOffset === null) {
      const bytes = Buffer.concat(parts)
      assert.equal(bytes.length, pinned.totalBytes)
      assert.equal(digest(bytes), pinned.sha256)
      return { resource: JSON.parse(bytes.toString('utf8')) }
    }
    assert.ok(page.nextOffset === offset && offset < pinned.totalBytes)
  }
  assert.fail('The installed workflow did not fit its bounded context recall')
}

export function windowsVideoModelAction(body, selection, render, parseFixtureToolOutput) {
  const tools = new Set(body.tools?.map(tool => tool.function?.name))
  const results = new Map(body.messages?.filter(message => message.role === 'tool')
    .map(message => [message.tool_call_id, parseFixtureToolOutput(message.content)]))
  const prefix = selection.interrupted ? 'eval-resume' : 'eval'
  const findPdfId = `${prefix}-find-pdf`
  const listPdfId = `${prefix}-list-pdf`
  const readPdfId = `${prefix}-read-pdf`
  const readPipelineId = `${prefix}-read-pipeline`
  const context = body.messages?.map(message => typeof message.content === 'string' ? message.content : '').join('\n') ?? ''
  const attachmentId = context.match(/合成视频资料\.pdf [^\n]*?id=([\w-]+)/)?.[1]
  assert.ok(attachmentId, 'The approved task receives its original document attachment')
  if (!results.has(findPdfId)) {
    assert.ok(tools.has('search_attachment'))
    return [findPdfId, 'search_attachment', { attachment_id: attachmentId, query: pdfText }]
  }
  const search = results.get(findPdfId)
  const match = sections => Array.isArray(sections) ? sections.find(section =>
    section?.attachmentId === attachmentId && typeof section.id === 'string' && matchesPdfText(section.text)) : undefined
  let section = match(search?.results)
  if (!section) {
    if (!results.has(listPdfId)) {
      assert.ok(tools.has('list_attachment_sections'))
      return [listPdfId, 'list_attachment_sections', { attachment_id: attachmentId, offset: 0, limit: 5 }]
    }
    const list = results.get(listPdfId)
    section = match(list?.sections)
    assert.ok(section, `No matching indexed PDF section from the runtime (search: ${sectionResultStatus(search, 'results')}; list: ${sectionResultStatus(list, 'sections')})`)
  }
  if (!results.has(readPdfId)) {
    assert.ok(tools.has('read_attachment_section'))
    return [readPdfId, 'read_attachment_section', { attachment_id: attachmentId, section_id: section.id }]
  }
  const readSection = results.get(readPdfId)?.section
  assert.ok(readSection?.id === section.id && readSection.attachmentId === attachmentId && matchesPdfText(readSection.text),
    'The renderer input must have come from the exact authorized PDF section')
  selection.pdfRead = true
  if (!results.has(readPipelineId)) return tools.has('read_skill_resource') ?
    [readPipelineId, 'read_skill_resource', { skill_id: selection.skillId, path: 'references/pipeline.md' }] : null
  const { resource, action } = recoverWorkflow(results.get(readPipelineId), prefix, tools, results, selection)
  if (action) return action
  const workflow = { skillMatches: resource?.skill_id === selection.skillId, pathMatches: resource?.path === 'references/pipeline.md',
    bytes: typeof resource?.content === 'string' ? Buffer.byteLength(resource.content) : 0,
    includesRender: /remotion render/i.test(resource?.content ?? '') }
  assert.ok(workflow.skillMatches && workflow.pathMatches && workflow.includesRender,
    `The installed Skill workflow must be read before rendering (${JSON.stringify(workflow)}; ${sectionResultStatus(resource, 'sections')})`)
  selection.read = true
  if (!results.has('eval-render')) return tools.has('request_host_shell') ? ['eval-render', 'request_host_shell', render] : null
  let output = results.get('eval-render')
  for (let index = 1; output?.status === 'running' && index < 45; index++) {
    const id = `eval-poll-${index}`
    if (results.has(id)) { output = results.get(id); continue }
    assert.ok(tools.has('host_shell_session') && /^bash_[\da-f-]+$/i.test(output.session_id ?? ''),
      'The approved command must return its task-owned Shell session')
    return [id, 'host_shell_session', { action: 'poll', session_id: output.session_id, yield_seconds: 10 }]
  }
  const execution = { status: typeof output?.status === 'string' && /^[a-z_]{3,32}$/.test(output.status) ? output.status : undefined,
    exitCode: Number.isInteger(output?.exit_code) ? output.exit_code : null, commandMatches: output?.commandHash === digest(render.command) }
  assert.ok(execution.exitCode === 0 && execution.commandMatches,
    `The exact approved render must exit successfully (${JSON.stringify(execution)}; ${sectionResultStatus(output, 'sections')})`)
  const shell = { ...execution, cwdAbsolute: typeof output.cwd === 'string' && isAbsolute(output.cwd),
    cwdMatches: typeof output.cwd === 'string' && typeof selection.workspace === 'string' && normalize(output.cwd).toLowerCase() === normalize(selection.workspace).toLowerCase(),
    started: typeof output.started_at === 'string' ? Date.parse(output.started_at) : null,
    finished: typeof output.finished_at === 'string' ? Date.parse(output.finished_at) : null,
    outputNamesFile: typeof output.output === 'string' && output.output.includes(filename) }
  selection.shell = shell
  selection.rendered = true
  return null
}

export async function startWindowsVideoEvaluation(workspace, environment, parseFixtureToolOutput) {
  const toolchain = await provision(workspace, environment)
  const documentPath = join(workspace, pdfName)
  await writeFile(documentPath, createChineseTextPdf())
  const quote = value => `'${value.replace(/'/g, "''")}'`
  const render = { command: `& ${quote(process.execPath)} ${quote(join(workspace, script))}`,
    timeout_seconds: 180, ttl_seconds: 240, idempotency_key: 'private-synthetic-render-once' }
  const marker = '独立的 Video Shotcraft 非商用合成评估'
  const selection = { requests: 0, read: false, rendered: false, workspace }
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(literal({ data: [{ id: model, object: 'model' }] }))
      return
    }
    try {
      selection.requests++
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.ok(selection.skillId && body.messages?.some(message => message.role === 'user' && literal(message.content).includes(marker)))
      const action = windowsVideoModelAction(body, selection, render, parseFixtureToolOutput)
      if (action?.[0] === 'eval-render' && !selection.interrupted) {
        selection.interrupted = true
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${literal({ id: model, choices: [{ index: 0, delta: { content: '资料已核对，准备渲染。' }, finish_reason: null }] })}\n\n`)
        return
      }
      if (action?.[1] === 'host_shell_session') {
        // Pace the fixture by its own process lifecycle. The KUN poll still supplies the actual completion evidence.
        const until = Date.now() + 25_000
        while (Date.now() < until) {
          const progress = await readFile(toolchain.renderDiagnostic, 'utf8').then(JSON.parse).catch(() => null)
          if (progress?.stage === 'exited') break
          await delay(500)
        }
      }
      const delta = action ? { tool_calls: [{ index: 0, id: action[0], type: 'function',
        function: { name: action[1], arguments: literal(action[2]) } }] } :
        { content: selection.rendered ? `已渲染并保存 ${filename} 。` : '合成验收所需工具未就绪。' }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(`data: ${literal({ id: model, choices: [{ index: 0, delta, finish_reason: action ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    } catch (error) {
      selection.failure = error instanceof Error ? error.message : String(error)
      response.writeHead(400)
      response.end('The private evaluation fixture rejected the tool result')
    }
  })
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  return { model, observed: selection, baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(done => { server.close(done); server.closeAllConnections() }),
    async verify(cdp, skillId) {
      selection.skillId = skillId
      const composer = 'textarea[placeholder="向智能体提问…"]:not(:disabled)'
      await cdp.fill(composer, `/skill:${skillId} ${marker}，请读取已安装技能的流水线说明，用本工作区准备的原创一秒合成场景实际制作成片，输出 ${filename} 。请通过明确审批运行本工作区的 ${script} 。`)
      await cdp.click('button[aria-label="更多操作"]')
      await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true })
      await cdp.click('button', '添加文件或图片')
      const { root } = await cdp.send('DOM.getDocument')
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' })
      assert.ok(nodeId)
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [documentPath] })
      await cdp.send('Page.setInterceptFileChooserDialog', { enabled: false })
      await cdp.wait(`document.querySelector('.ds-floating-composer')?.innerText.includes(${literal(pdfName)})
        && /已就绪|文字提取受限/.test(document.querySelector('.ds-floating-composer').innerText)`, 'a parsed PDF attached through the composer', 120_000)
      await cdp.click('button[aria-label="发送"]:not(:disabled)')
      const interrupted = await cdp.wait(`window.workwise.listTaskPage({filter:'all',workspaceRoot:${literal(workspace)}}).then(page=>
        [...page.items, ...page.relatedTasks].find(task=>task.status==='stalled'&&task.presentation?.reason==='response_interrupted'))`, 'durable interrupted response in the same task', 120_000)
        .catch(error => { throw new Error(selection.failure ?? error.message) })
      const chat = windowsTaskChatLayoutExpression(marker)
      const interruptedChat = validateWindowsTaskChatLayout(await cdp.wait(chat, 'interrupted task controls in the original chat'))
      await cdp.click(`${windowsTaskChatRegion} button`, '继续任务')
      const approval = await cdp.wait(`window.workwise.listTaskInbox(${literal(workspace)}).then(items=>items.find(item=>item.status==='pending'&&item.kind==='approval'&&item.message.includes(${literal(`Command SHA256: ${digest(render.command)}`)})))`, 'the exact reviewed isolated render approval', 90_000)
        .catch(error => { throw new Error(selection.failure ?? error.message) })
      assert.equal(approval.payload?.approval?.toolName, 'request_host_shell')
      assert.equal(approval.payload.approval.requestHash, digest(literal(render)))
      assert.equal(selection.read, true)
      assert.equal(selection.pdfRead, true)
      assert.equal(approval.taskId, interrupted.id)
      const approvalChat = validateWindowsTaskChatLayout(await cdp.wait(chat, 'approval state in the original chat'))
      const commandFingerprint = `Command SHA256: ${digest(render.command)}`
      assert.equal(await cdp.evaluate(`document.querySelector('.ds-workbench-shell main')?.innerText.includes(${literal(commandFingerprint)})`), false)
      const button = await cdp.wait(`(() => {
        const conversation=document.querySelector('.ds-workbench-shell main');
        const options=[...(conversation?.querySelectorAll('button')??[])].filter(item=>
          ['允许此操作','允许本次'].includes(item.textContent.trim())&&!item.disabled&&item.getClientRects().length);
        if(options.length!==1)return null;
        const button=options[0];
        button.scrollIntoView({block:'center'});
        const box=button.getBoundingClientRect();
        const point={x:box.x+box.width/2,y:box.y+box.height/2};
        return button.contains(document.elementFromPoint(point.x,point.y))?point:null;
      })()`, 'the visible approval for the exact command')
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...button })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...button })
      const taskPath = `/v1/tasks/${encodeURIComponent(approval.taskId)}`
      const artifact = await cdp.wait(`window.workwise.runtimeRequest(${literal(taskPath)},'GET').then(result=>{
        if(!result.ok)return null;
        const payload=JSON.parse(result.body),task=payload.task??payload;
        return task.status==='completed'&&task.artifacts.find(item=>item.format==='mp4'&&item.validation==='valid'&&item.relativePath===${literal(filename)});
      })`, 'a completed real task and registered MP4', 240_000).catch(async error => {
        const [processReport, state, file] = await Promise.all([
          readFile(toolchain.renderDiagnostic, 'utf8').then(JSON.parse).catch(() => ({ stage: 'not-started' })),
          cdp.evaluate(`Promise.all([${literal(taskPath)},${literal(`${taskPath}/receipts`)},${literal(`${taskPath}/diagnostics`)}].map(path=>window.workwise.runtimeRequest(path,'GET'))).then(results=>{
            const parse=result=>result.ok?JSON.parse(result.body):{};
            const payload=parse(results[0]),task=payload.task??payload,receipts=parse(results[1]),diagnostics=parse(results[2]);
            return {status:task.status,reason:task.presentation?.reason,blockCode:task.blockCode,acceptance:task.acceptance?.kind,
              hasExpectedArtifact:task.artifacts?.some(item=>item.relativePath===${literal(filename)}),artifactCount:task.artifacts?.length,
              artifactStates:task.artifacts?.map(item=>({format:item.format,validation:item.validation})),
              receipts:Array.isArray(receipts)?receipts.filter(item=>item.purpose==='host_shell').map(item=>({status:item.status,exitCode:item.shell?.exitCode})):[],
              diagnosticKeys:Object.keys(diagnostics),spanErrors:diagnostics.spans?.map(item=>item.errorCode).filter(Boolean)};
          })`).catch(() => ({ diagnosticUnavailable: true })),
          lstat(toolchain.target).then(info => ({ present: info.isFile(), bytes: info.size, mtime: info.mtimeMs })).catch(() => ({ present: false }))
        ])
        if (file.present) {
          try {
            const streams = JSON.parse(execFileSync(toolchain.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', toolchain.target],
              { encoding: 'utf8', windowsHide: true, timeout: 15000 })).streams
            const [stream] = streams
            file.expectedVideo = stream.codec_name === 'h264' && stream.width === 320 && stream.height === 180 && Number(stream.nb_frames) === 24
          } catch { file.expectedVideo = false }
        }
        throw new Error(`${selection.failure ?? error.message}; ${JSON.stringify({ process: processReport, shell: selection.shell, state, file })}`)
      })
      assert.equal(selection.rendered, true)
      const completedChat = validateWindowsTaskChatLayout(await cdp.wait(chat, 'the completed task in its original chat'))
      const artifactButton = await revealWindowsChatTaskArtifact(cdp, filename)
      await cdp.click(artifactButton, filename)
      const openResult = await cdp.evaluate(artifact.absolutePath
        ? `window.workwise.openTaskArtifact({taskId:${literal(approval.taskId)},artifactId:${literal(artifact.id)}})`
        : `window.workwise.openWorkspaceFile({workspaceRoot:${literal(workspace)},path:${literal(filename)}})`)
      assert.ok(openResult?.ok, 'The installed application must be able to open the registered MP4')
      const video = await readFile(toolchain.target)
      assert.equal((await lstat(toolchain.target)).isSymbolicLink(), false)
      assert.equal(digest(video), artifact.sha256)
      assert.equal(video.length, artifact.sizeBytes)
      const probe = JSON.parse(execFileSync(toolchain.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', toolchain.target],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000 })).streams[0]
      assert.deepEqual([probe.codec_name, probe.width, probe.height, Number(probe.nb_frames)], ['h264', 320, 180, 24])
      execFileSync(toolchain.ffmpeg, ['-v', 'error', '-xerror', '-i', toolchain.target, '-f', 'null', '-'],
        { windowsHide: true, timeout: 30_000, stdio: 'ignore' })
      return { kind: 'private-noncommercial-synthetic-evaluation', remotionVersion: version, codec: probe.codec_name,
        width: probe.width, height: probe.height, frames: Number(probe.nb_frames), artifact: { id: artifact.id, sha256: artifact.sha256, bytes: video.length },
        installedSkillResourceRead: true, attachedPdfRead: true, sameTaskResumedAfterInterruption: true, appOpenedArtifact: true, runtimeApprovalId: approval.requestId, decoded: true,
        originalChat: { interrupted: interruptedChat, approval: approvalChat, completed: completedChat, artifactButtonClicked: true } }
    } }
}
