const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { createServer } = require('node:http')
const { pathToFileURL } = require('node:url')
const { spawnSync } = require('node:child_process')

const [rootArg, appArg, head, expectedAsar, expectation = 'reject'] = process.argv.slice(2)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const modelAnswer = 'The approved survey work is complete. All observations have been processed and the results are ready.'

async function main() {
  assert(process.versions.electron, 'Run with the selected packaged Electron')
  assert.match(head || '', /^[a-f0-9]{40}$/)
  assert.match(expectedAsar || '', /^[a-f0-9]{64}$/)
  assert(['reject', 'reproduce'].includes(expectation))
  const root = fs.realpathSync(rootArg)
  assert.equal(root, path.resolve(rootArg))
  assert.match(root, /^\/private\/tmp\/railwise-survey-[a-zA-Z0-9-]+$/)
  const app = fs.realpathSync(appArg)
  assert.equal(app, path.join(root, 'Applications', `RAILWISE AI Candidate ${head.slice(0, 12)}.app`))
  assert.equal(fs.realpathSync(path.dirname(process.execPath)), path.join(app, 'Contents', 'MacOS'))
  const resources = path.join(app, 'Contents', 'Resources')
  const asar = path.join(resources, 'app.asar')
  const asarSha256 = hash(require('original-fs').readFileSync(asar))
  assert.equal(asarSha256, expectedAsar)
  const metadata = JSON.parse(fs.readFileSync(path.join(asar, 'package.json'), 'utf8'))
  assert.equal(metadata.version, '0.5.0')
  assert.equal(metadata.buildProvenance.sourceHead, head)
  const signature = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(signature.status, 0, signature.stderr || 'Package signature verification failed')
  const moduleRoot = path.join(resources, 'app.asar.unpacked', 'kun', 'dist')
  assert.equal(fs.realpathSync(moduleRoot), moduleRoot)
  const load = name => {
    const modulePath = path.join(moduleRoot, `${name}.js`)
    assert.equal(fs.realpathSync(modulePath), modulePath)
    return import(pathToFileURL(modulePath).href)
  }
  const { createKunServeRuntime } = await load('server/runtime-factory')
  const { KunCapabilitiesConfig } = await load('contracts/capabilities')
  const { EngineeringAiRepository } = await load('engineering/engineering-ai-repository')
  const fixture = fs.mkdtempSync(path.join(root, 'completion-probe-'))
  const evidence = path.join(root, 'evidence')
  fs.mkdirSync(evidence, { recursive: true })
  assert.equal(fs.realpathSync(evidence), evidence)
  let modelCalls = 0
  let unexpectedRequests = 0
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      unexpectedRequests += 1
      response.writeHead(400).end()
      return
    }
    let requestBytes = 0
    for await (const chunk of request) {
      requestBytes += chunk.length
      if (requestBytes > 2_000_000) { response.writeHead(413).end(); return }
    }
    modelCalls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: 'synthetic-text-only', choices: [{ index: 0, delta: { content: modelAnswer }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let runtime
  let repo
  try {
    const dataDir = path.join(fixture, 'runtime')
    runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir,
      runtimeToken: 'synthetic-only', apiKey: '', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      model: 'synthetic-model', approvalPolicy: 'auto', sandboxMode: 'workspace-write',
      tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
    repo = new EngineeringAiRepository({ rootDir: path.join(dataDir, 'engineering') })
    const project = runtime.engineeringService.createProject({ name: 'SYNTHETIC packaged completion probe', workspace: fixture, expectedRevision: 0, idempotencyKey: 'probe-project' })
    const source = Buffer.from(JSON.stringify({ format: 'workwise-survey-network', formatVersion: 1, network: {
      networkType: 'leveling', unit: 'm',
      knownPoints: [{ id: 'BM', pointClass: 'known', height: 10, known: true }],
      unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 10.1, known: false }],
      observations: [0.1, 0.1001].map((value, i) => ({ id: `dh-${i}`, type: 'height-difference', from: 'BM', to: 'P', value, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }))
    } }))
    const network = await runtime.surveyService.importNetwork({ projectId: project.id, expectedRevision: 1, idempotencyKey: 'probe-network', networkType: 'leveling', name: 'workwise-survey-network.json', dataBase64: source.toString('base64') })
    const thread = await runtime.threadService.create({ workspace: fixture, model: 'synthetic-model', mode: 'agent', domain: 'engineering', projectId: project.id })
    const created = await runtime.engineeringAi.createPlan({ threadId: thread.id, projectId: project.id, goal: 'Synthetic leveling adjustment and report', idempotencyKey: 'probe-plan' })
    assert.equal(created.plan.status, 'awaiting_approval')
    const approved = runtime.engineeringAi.approvePlan(created.plan.id, { expectedRevision: created.plan.revision, contextHash: created.plan.contextHash, stepIds: created.approval.stepIds, token: created.approval.token, idempotencyKey: 'probe-approve' })
    const started = await runtime.engineeringAi.startPlan(approved.id, { expectedRevision: approved.revision, contextHash: approved.contextHash, model: 'synthetic-model', idempotencyKey: 'probe-start' })
    let turn
    const deadline = Date.now() + 30_000
    do {
      turn = await runtime.turnService.getTurn(thread.id, started.turn.turnId)
      if (turn?.status !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 25))
    } while (Date.now() < deadline)
    const task = runtime.taskRepository.get(started.plan.taskId)
    const items = await runtime.sessionStore.loadItems(thread.id)
    const steps = started.plan.steps.map(step => ({ id: step.id, tool: step.tool, receipt: repo.stepEvidence(started.plan.id, step.id) }))
    const projected = runtime.engineeringAi.getPlan(started.plan.id)
    const assistantAnswers = items.filter(item => item.turnId === turn?.id && item.kind === 'assistant_text').map(item => item.text)
    const result = {
      expectation, syntheticOnly: true, realModelUsed: false, checkedAt: new Date().toISOString(),
      sourceHead: head, packageVersion: metadata.version, asarSha256, sourceSha256: hash(source), signatureVerifiedBeforeImports: true,
      fixture, projectId: project.id, networkId: network.id, threadId: thread.id, planId: started.plan.id,
      steps, modelCalls, unexpectedRequests, taskStatus: task.status, turnStatus: turn?.status,
      taskAcceptance: task.acceptance, taskError: task.error ?? null, stalledReason: task.stalledReason ?? null, waitingReason: task.waitingReason ?? null,
      rawPlanStatus: repo.getPlan(started.plan.id)?.status, projectedPlanStatus: projected?.status, execution: projected?.execution ?? null,
      toolCalls: items.filter(item => item.turnId === turn?.id && item.kind === 'tool_call').length,
      adjustmentCount: runtime.surveyService.listAdjustments(project.id).length,
      finalResponse: task.finalResponse ?? null, assistantAnswers
    }
    fs.writeFileSync(path.join(evidence, `packaged-text-only-${path.basename(fixture)}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify(result, null, 2))
    assert(modelCalls > 0)
    assert.equal(unexpectedRequests, 0)
    assert(assistantAnswers.includes(modelAnswer), 'The synthetic completion text must actually reach the persisted transcript')
    assert.equal(result.toolCalls, 0)
    assert.equal(result.adjustmentCount, 0)
    assert.equal(steps.length, 4)
    assert(steps.every(step => step.receipt === null))
    if (expectation === 'reproduce') {
      assert.equal(task.status, 'completed')
      assert.equal(turn.status, 'completed')
    } else {
      assert.notEqual(turn.status, 'running', 'Probe timed out')
      assert.notEqual(task.status, 'completed', 'Missing receipts must block completion')
      assert(['stalled', 'failed', 'waiting_user'].includes(task.status), 'Expected a bounded, non-success terminal state')
      assert.match(JSON.stringify([task.error, task.stalledReason, task.waitingReason]), /engineering_plan_steps_incomplete/, 'Reject for missing receipts, not an unrelated transport or parse failure')
      assert.notEqual(projected?.status, 'completed')
    }
  } finally {
    repo?.close()
    await runtime?.shutdown?.()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
