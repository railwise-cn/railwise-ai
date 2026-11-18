import assert from 'node:assert/strict'
import { execFile as execFileCallback, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const digest = value => createHash('sha256').update(value).digest('hex')
const literal = JSON.stringify
const version = '4.0.484'
const model = 'windows-video-evaluation-fixture'
const filename = 'railwise-synthetic-evaluation.mp4'
const script = 'render-evaluation.mjs'
const composition = 'RailWiseSyntheticEvaluation'

// Original geometry only. This evaluation does not rely on the media omitted from the Skill.
const scene = `import React from 'react';
import { AbsoluteFill, Composition, registerRoot, useCurrentFrame } from 'remotion';
const Scene = () => {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{background:'#17263d', alignItems:'center', justifyContent:'center'}}>
    <svg width="320" height="180" viewBox="0 0 320 180">
      <path d="M38 113H282M38 129H282" fill="none" stroke="#c5e2ef" strokeWidth="4"/>
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
  await writeFile(join(workspace, script), `import {execFileSync} from 'node:child_process';
execFileSync(${literal(process.execPath)}, ${literal([cli, 'render', 'index.jsx', composition, target, '--codec=h264',
    '--concurrency=1', '--chrome-mode=chrome-for-testing', '--browser-executable', browser])}, {cwd:${literal(root)},stdio:'inherit',windowsHide:true,timeout:140000});
console.log(${literal(target)});
`)
  return { target, ffmpeg, ffprobe }
}

function modelAction(body, selection, render, parseFixtureToolOutput) {
  const tools = new Set(body.tools?.map(tool => tool.function?.name))
  const messages = new Map(body.messages?.filter(message => message.role === 'tool').map(message => [message.tool_call_id, message.content]))
  const setup = 'RAILWISE-DISTRIBUTION.md'
  if (!messages.has('eval-read-setup')) {
    assert.ok(tools.has('read_skill_resource'), 'The installed Skill must offer its scoped document reader')
    return ['eval-read-setup', 'read_skill_resource', { skill_id: selection.skillId, path: setup, offset_bytes: 0 }]
  }
  const raw = messages.get('eval-read-setup')
  const resource = parseFixtureToolOutput(raw)
  const typed = { idMatches: resource?.skill_id === selection.skillId, pathMatches: resource?.path === setup,
    code: /^[a-z0-9_-]{1,80}$/i.test(resource?.code ?? '') ? resource.code : undefined,
    bytes: resource?.bytes_returned, contentType: typeof raw, wireCharacters: raw?.length,
    recordedResult: typeof raw === 'string' && raw.includes('Recorded result:'),
    firstToken: typeof raw === 'string' ? /^[A-Za-z_][A-Za-z0-9_]{0,48}/.exec(raw)?.[0] : undefined }
  assert.ok(typed.idMatches && typed.pathMatches && typeof resource.content === 'string' && resource.content.includes(`Remotion ${version}`),
    `The installed Skill setup guidance could not be read: ${literal(typed)}`)
  selection.read = true
  assert.ok(tools.has('request_host_shell'), 'KUN must offer a scoped command with explicit approval in the isolated evaluation profile')
  if (!messages.has('eval-render')) return ['eval-render', 'request_host_shell', render]
  let output = parseFixtureToolOutput(messages.get('eval-render'))
  const visibleSession = output?.session_id
  const supportsSession = body.tools?.some(tool => tool.function?.name === 'host_shell_session' &&
    Object.hasOwn(tool.function.parameters?.properties ?? {}, 'session_id'))
  for (let index = 1; output?.status === 'running' && index < 45; index++) {
    const id = `eval-poll-${index}`
    if (messages.has(id)) { output = parseFixtureToolOutput(messages.get(id)); continue }
    assert.ok(tools.has('host_shell_session'), 'The running approved command must expose scoped read-only polling')
    if (supportsSession) {
      assert.ok(typeof visibleSession === 'string' && /^bash_[a-f0-9-]+$/i.test(visibleSession) && output.session_id === visibleSession,
        'Always poll only the exact original session returned to the model after approval')
      return [id, 'host_shell_session', { action: 'poll', session_id: visibleSession, yield_seconds: 10 }]
    }
    assert.ok(typeof output.authorizationId === 'string' && /^host_shell_[a-f0-9-]+$/i.test(output.authorizationId),
      `The model cannot poll the running approved command: ${literal({ status: output.status,
        authorizationRedacted: output.authorizationId === '<redacted>', sessionReturned: typeof output.session_id === 'string' })}`)
    return [id, 'host_shell_session', { action: 'poll', authorization_id: output.authorizationId, yield_seconds: 10 }]
  }
  const completed = {
    status: output?.status,
    exitCode: output?.exit_code,
    code: output?.code,
    commandHashMatches: output?.commandHash === digest(render.command),
    tail: typeof output?.output === 'string'
      ? output.output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/(?:[A-Za-z]:[\\/])[^\r\n"']+/g, '<runner-path>')
        .split(/\r?\n/).filter(Boolean).slice(-7).join(' ').slice(-650)
      : undefined
  }
  assert.ok(completed.exitCode === 0 && completed.commandHashMatches,
    `The exact user-approved render did not report success: ${literal(completed)}`)
  selection.rendered = true
  return null
}

export async function startWindowsVideoEvaluation(workspace, environment, parseFixtureToolOutput) {
  const toolchain = await provision(workspace, environment)
  const quote = value => `'${value.replace(/'/g, "''")}'`
  const render = { command: `& ${quote(process.execPath)} ${quote(join(workspace, script))}`,
    timeout_seconds: 180, ttl_seconds: 240, idempotency_key: 'private-synthetic-render-once' }
  const marker = '独立的 Video Shotcraft 非商用合成评估'
  const selection = { read: false, rendered: false, requests: [] }
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(literal({ data: [{ id: model, object: 'model' }] }))
      return
    }
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.ok(selection.skillId && body.messages?.some(message => message.role === 'user' && literal(message.content).includes(marker)))
      const action = modelAction(body, selection, render, parseFixtureToolOutput)
      selection.requests.push(action?.[1] ?? 'final-response')
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
  return { model, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, observed: selection,
    close: () => new Promise(done => { server.close(done); server.closeAllConnections() }),
    async verify(cdp, skillId) {
      selection.skillId = skillId
      const composer = 'textarea[placeholder="向智能体提问…"]:not(:disabled)'
      await cdp.fill(composer, `/skill:${skillId} ${marker}，请读取已安装技能的流水线说明，用本工作区准备的原创一秒合成场景实际制作成片，输出 ${filename} 。请通过明确审批运行本工作区的 ${script} 。`)
      const key = { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 }
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
      const pending = (taskId = null) => `window.workwise.listTaskInbox(${literal(workspace)}).then(items=>items.filter(item=>
        item.status==='pending'&&item.kind==='approval'&&(!${literal(taskId)}||item.taskId===${literal(taskId)})))`
      const firstApproval = await cdp.wait(`${pending()}.then(items=>items.find(item=>item.payload?.approval?.requestHash===${literal(digest(literal(render)))}))`,
        'the exact reviewed isolated render approval', 90_000).catch(error => { throw new Error(selection.failure ?? error.message) })
      assert.equal(selection.read, true)
      await cdp.click('button', '打开任务工作台')
      const detail = 'article[aria-label="任务详情"]'
      const approved = new Set()
      const approve = async item => {
        const request = item.payload?.approval
        assert.equal(request?.toolName, 'request_host_shell')
        assert.equal(item.taskId, firstApproval.taskId)
        assert.equal(request.turnId, firstApproval.payload.approval.turnId)
        assert.equal(request.requestHash, digest(literal(render)), 'Unexpected command or arguments in the approval request')
        assert.ok(!approved.has(item.requestId), 'One request must not be approved twice')
        const button = await cdp.wait(`(() => {
          const article=document.querySelector(${literal(detail)});
          const options=[...(article?.querySelectorAll('button')??[])].filter(button=>
            button.textContent.trim()==='允许此操作'&&!button.disabled&&button.getClientRects().length&&
            [...button.parentElement.parentElement.querySelectorAll('p')].some(text=>text.textContent===${literal(item.message)}));
          if(options.length!==1)return null;
          const button=options[0];
          button.scrollIntoView({block:'center'});
          const box=button.getBoundingClientRect();
          const point={x:box.x+box.width/2,y:box.y+box.height/2};
          return button.contains(document.elementFromPoint(point.x,point.y))?point:null;
        })()`, 'the visible approval for the exact workspace command')
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...button })
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...button })
        approved.add(item.requestId)
      }
      await approve(firstApproval)
      const taskPath = `/v1/tasks/${encodeURIComponent(firstApproval.taskId)}`
      const deadline = Date.now() + 240_000
      let artifact
      while (!artifact && Date.now() < deadline) {
        if (selection.failure) {
          const file = await lstat(toolchain.target).catch(() => null)
          throw new Error(`${selection.failure} Synthetic output bytes on disk: ${file?.isFile() ? file.size : 0}.`)
        }
        const waiting = await cdp.evaluate(pending(firstApproval.taskId))
        for (const approval of waiting) if (!approved.has(approval.requestId)) await approve(approval)
        artifact = await cdp.evaluate(`window.workwise.runtimeRequest(${literal(taskPath)},'GET').then(result=>{
          if(!result.ok)return null;
          const payload=JSON.parse(result.body),task=payload.task??payload;
          return task.status==='completed'&&task.artifacts.find(item=>item.format==='mp4'&&item.validation==='valid'&&item.relativePath===${literal(filename)});
        })`)
        if (!artifact) await sleep(300)
      }
      assert.ok(artifact, 'The installed app did not complete and register the private MP4')
      assert.equal(selection.rendered, true)
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
        installedSkillResourceRead: true, execution: 'explicit-host-shell-approval', runtimeApprovalIds: [...approved], decoded: true }
    } }
}
