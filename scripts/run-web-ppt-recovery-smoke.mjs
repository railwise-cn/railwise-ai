#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import JSZip from 'jszip'
import { parseFixtureToolOutput } from './run-windows-ui-smoke.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const indexOfSidecar = process.argv.indexOf('--sidecar')
const sidecar = process.argv[indexOfSidecar + 1]
assert.ok(indexOfSidecar > 0 && sidecar, 'Pass --sidecar with the path of the bundled PPT Master sidecar.')
const indexOfDist = process.argv.indexOf('--runtime-dist')
const dist = indexOfDist > 0 ? resolve(process.argv[indexOfDist + 1]) : join(repo, 'kun/dist')
const root = await realpath(await mkdtemp(join(tmpdir(), 'railwise-web-ppt-acceptance-')))
const workspace = join(root, 'workspace')
const trust = join(root, 'workspace-trust.json')
const sourceHost = 'www.railwise.cn'
const sourceUrl = `https://${sourceHost}/`
const reportPath = join(root, 'acceptance.json')
const report = {
  scope: 'Local runtime HTTP integration with a synthetic model and a real public page and PPT Master sidecar',
  stages: [], sourceUrl, dist, platform: process.platform, arch: process.arch
}
const hash = value => createHash('sha256').update(value).digest('hex')
const escapeXml = value => value.replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char])
const specLock = [
  '<!-- ppt-master-schema: spec-lock/v1 -->', '# Execution Lock', '',
  '## canvas', '- viewBox: 0 0 1280 720', '- format: ppt169', '',
  '## colors', '- bg: #FFFFFF', '- primary: #142335', '- accent: #2872D0', '- text: #142335', '',
  '## typography', '- font_family: Arial', '- title_family: Arial', '- body_family: Arial', '- body: 18', '- title: 36', '',
  '## pptx_structure', '- mode: flat', '',
  '## communication', '- primary_language: zh-CN', ''
].join('\n')
let runtime
let localServer
let fixtureError

function createSlide(source) {
  const text = escapeXml(source)
  const rows = [text, '官网公开资料', sourceUrl].map((label, index) =>
    `<text x="80" y="${170 + index * 105}" fill="#142335" font-family="Arial" font-size="36">${label}</text>`)
  // The persisted write call must carry the complete SVG across the 1,000-character display limit.
  const details = Array.from({ length: 22 }, (_, i) => `<rect x="${80 + i * 38}" y="550" width="30" height="4" fill="#2872D0"/>`)
  return ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720">',
    '<rect width="1280" height="720" fill="#FFFFFF"/>', ...rows, ...details, '</svg>'].join('\n')
}

const model = createServer(async (request, response) => {
  try {
    const parts = []
    for await (const part of request) parts.push(part)
    const { messages, tools } = JSON.parse(Buffer.concat(parts).toString('utf8'))
    const names = new Set(tools.map(tool => tool.function.name))
    const toolResult = name => {
      const item = messages.find(message => message.role === 'tool' && message.tool_call_id === `fixture-${name}`)
      if (!item) return undefined
      const result = parseFixtureToolOutput(item.content)
      assert.ok(result, `Unable to read the ${name} result.`)
      assert.ok(!result.error, `${name} failed: ${JSON.stringify(result.error)}`)
      return result
    }
    const send = (name, args, id = name) => {
      assert.ok(names.has(name), `Required tool is missing: ${name}`)
      response.end(`data: ${JSON.stringify({ id: 'fixture-ppt', choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: `fixture-${id}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
      }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
    }
    response.setHeader('content-type', 'text/event-stream')
    const answer = toolResult('request_user_input')
    if (!answer) return send('request_user_input', { question: '请提供制作 PPT 所需的官网网址。' })
    const url = answer.answers?.[0]?.value
    assert.equal(url, sourceHost, 'The reply must reach the running turn without changing the input.')
    const source = toolResult('web_fetch')
    if (!source) return send('web_fetch', { url })
    assert.equal(source.finalUrl, sourceUrl, 'The public source read must return a verified final URL.')
    assert.match(source.text, /工程测量/)
    assert.match(source.text, /安全监测/)
    report.source = { title: source.title, bytes: source.byteCount, resultHash: source.resultHash, readTool: 'web_fetch' }
    const slide = createSlide(source.title)
    const write = toolResult('write')
    if (!toolResult('spec-lock')) return send('write', { path: 'deck/spec_lock.md', content: specLock }, 'spec-lock')
    if (!write) {
      report.slideInput = { length: slide.length, sha256: hash(slide) }
      return send('write', { path: 'deck/svg_output/slide_01.svg', content: slide })
    }
    assert.equal(write.sha256, report.slideInput.sha256, 'The complete generated SVG must be written.')
    const exported = toolResult('ppt_master_export')
    if (!exported) {
      // Match the standalone native sidecar acceptance before testing its export through KUN.
      const quality = spawnSync(resolve(sidecar), [], {
        cwd: workspace, encoding: 'utf8', timeout: 15_000,
        input: JSON.stringify({ operation: 'ppt-master-quality-check', workspaceRoot: workspace, projectPath: join(workspace, 'deck'), stage: 'final' })
      })
      assert.equal(quality.status, 0, quality.error?.message ?? quality.stderr)
      const result = JSON.parse(quality.stdout)
      assert.equal(result.ok, true, result.message)
      report.stages.push('fixture invoked the bundled native final SVG quality check')
      return send('ppt_master_export', { project_path: 'deck', output_path: 'deck/website.pptx' })
    }
    assert.equal(exported.ok, true, `PPT Master export failed: ${JSON.stringify(exported)}`)
    response.end(`data: ${JSON.stringify({ id: 'fixture-ppt', choices: [{ index: 0, delta: {
      content: '已根据睿威官网公开资料生成并核对 deck/website.pptx。'
    }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
  } catch (error) {
    fixtureError = error
    response.statusCode = 400
    response.end('Synthetic model assertion failed')
  }
})

async function until(read, predicate, label) {
  for (let tick = 0; tick < 400; tick++) {
    if (fixtureError) throw fixtureError
    const value = await read()
    if (predicate(value)) return value
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

try {
  await mkdir(workspace)
  await writeFile(trust, JSON.stringify({ schema: 'workwise.workspace-trust', version: 1,
    workspaces: [{ canonicalRoot: workspace, level: 'workspace-write', revision: 1 }] }))
  const skill = join(repo, 'src/asset/skills/ppt-master')
  process.env.WORKWISE_PPT_MASTER_ROOT = skill
  process.env.WORKWISE_PPT_MASTER_SIDECAR = resolve(sidecar)
  process.env.RAILWISE_TASK_SCHEDULING_DISABLED = '1'
  const fromDist = relative => import(pathToFileURL(join(dist, relative)).href)
  const { createKunServeRuntime } = await fromDist('server/runtime-factory.js')
  const { buildRouter } = await fromDist('server/routes/index.js')
  const { startNodeHttpServer } = await fromDist('server/node-http-server.js')
  const { KunCapabilitiesConfig } = await fromDist('contracts/capabilities.js')
  await new Promise(done => model.listen(0, '127.0.0.1', done))
  runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), workspaceTrustPath: trust,
    runtimeToken: 'isolated-runtime-test', apiKey: 'isolated-model-test', baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
    endpointFormat: 'chat_completions', model: 'fixture', approvalPolicy: 'auto', sandboxMode: 'workspace-write',
    tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({
      web: { enabled: true, fetchEnabled: true }, skills: { enabled: true, legacySkillMd: true, roots: [skill] }
    }) })
  localServer = await startNodeHttpServer({ host: '127.0.0.1', port: 0, router: buildRouter(runtime) })
  const api = async (path, body, status = 202) => {
    const response = await fetch(`http://127.0.0.1:${localServer.port}${path}`, {
      method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer isolated-runtime-test', 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    const result = await response.json()
    assert.equal(response.status, status, JSON.stringify(result))
    return result
  }
  const thread = await api('/v1/threads', { workspace, model: 'fixture', mode: 'agent', sandboxMode: 'workspace-write', approvalPolicy: 'auto' }, 201)
  const turn = await api(`/v1/threads/${thread.id}/turns`, { prompt: '请用所选技能，根据我下一条消息提供的官网制作一个单页可编辑 PPTX。', capabilityReferences: [{ kind: 'skill', id: 'ppt-master' }] })
  await until(() => runtime.userInputGate.pending(), list => list.length === 1, 'the source question')
  const task = runtime.taskRepository.findActiveByThread(thread.id)
  assert.equal(task.activeTurnId, turn.turnId)
  report.stages.push('skill selected, source question in original conversation')
  await api(`/v1/threads/${thread.id}/turns`, { prompt: sourceHost, idempotencyKey: 'fixture-source' })
  const final = await until(() => runtime.taskRepository.get(task.id), value => ['completed', 'failed', 'stalled', 'cancelled'].includes(value.status), 'the presentation')
  assert.equal(final.status, 'completed', JSON.stringify({ status: final.status, waitingReason: final.waitingReason, stalledReason: final.stalledReason }))
  assert.equal(final.threadId, thread.id)
  assert.equal(final.activeTurnId, turn.turnId)
  const saved = await api(`/v1/threads/${thread.id}`, undefined, 200)
  const savedTurn = saved.turns.find(item => item.id === turn.turnId)
  assert.ok(savedTurn?.activeSkillIds.includes('ppt-master'))
  const initialMessage = savedTurn.items.find(item => item.kind === 'user_message' && item.skillSelections?.length)
  assert.deepEqual(initialMessage?.skillSelections, [{ id: 'ppt-master', name: 'PPT Master' }])
  assert.equal(runtime.taskRepository.inputs(task.id).filter(input => input.text === sourceHost).length, 1)
  assert.equal(runtime.approvalGate.pending().length, 0)
  const artifact = final.artifacts.find(item => item.relativePath === join('deck', 'website.pptx'))
  assert.equal(artifact?.validation, 'valid')
  const outputPath = join(workspace, artifact.relativePath)
  const bytes = await readFile(outputPath)
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
  const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string')
  assert.ok(zip.file('ppt/presentation.xml'))
  assert.match(slideXml, /<p:sp>/, 'Exported slide should be editable.')
  assert.match(slideXml, /www\.railwise\.cn/)
  assert.match(slideXml, /工程测量/)
  assert.equal(hash(bytes), artifact.sha256)
  report.stages.push('source supplied in chat, public homepage text returned, original task completed, editable PPTX read back')
  report.artifact = { path: outputPath, bytes: bytes.length, sha256: artifact.sha256 }
  report.passed = true
} catch (error) {
  report.passed = false
  report.failure = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  if (localServer) {
    localServer.server.closeAllConnections()
    await localServer.close()
  }
  await runtime?.shutdown?.()
  await new Promise(done => { model.close(done); model.closeAllConnections() })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ path: reportPath, ...report }, null, 2))
}
