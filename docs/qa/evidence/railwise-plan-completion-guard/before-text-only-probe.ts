import { createServer } from 'node:http'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { expect, it } from '/Users/wangjiawei/Documents/WorkWise/kun/node_modules/vitest/dist/index.js'
import { createKunServeRuntime } from '/Users/wangjiawei/Documents/WorkWise/kun/src/server/runtime-factory.ts'
import { KunCapabilitiesConfig } from '/Users/wangjiawei/Documents/WorkWise/kun/src/contracts/capabilities.ts'
import { importWorkwiseSurveyNetwork } from '/Users/wangjiawei/Documents/WorkWise/kun/src/engineering/survey-test-helpers.ts'
import { EngineeringAiRepository } from '/Users/wangjiawei/Documents/WorkWise/kun/src/engineering/engineering-ai-repository.ts'

it('records whether an approved typed plan completes without executing any tools', async () => {
  const root = '/private/tmp/railwise-plan-completion-probe.ztYSwB'
  let calls = 0
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Drain the synthetic model request. */ }
    calls += 1
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ id: 'synthetic-text-only', choices: [{ index: 0, delta: { content: 'The approved survey work is complete. All observations have been processed and the results are ready.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const runtime = await createKunServeRuntime({ host: '127.0.0.1', port: 0, dataDir: join(root, 'runtime'), runtimeToken: 'synthetic-only', apiKey: '', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'synthetic-model', approvalPolicy: 'auto', sandboxMode: 'workspace-write', tokenEconomyMode: false, insecure: false, storage: { backend: 'file' }, capabilities: KunCapabilitiesConfig.parse({}) })
  const repo = new EngineeringAiRepository({ rootDir: join(root, 'runtime', 'engineering') })
  try {
    const project = runtime.engineeringService!.createProject({ name: 'SYNTHETIC text-only completion probe', workspace: root, expectedRevision: 0, idempotencyKey: 'probe-project' })
    const network = await importWorkwiseSurveyNetwork(runtime.surveyService!, { projectId: project.id, expectedRevision: 1, idempotencyKey: 'probe-network', networkType: 'leveling', network: {
      knownPoints: [{ id: 'BM', pointClass: 'known', height: 10, known: true }], unknownPoints: [{ id: 'P', pointClass: 'unknown', height: 10.1, known: false }],
      observations: [{ id: 'one', type: 'height-difference', from: 'BM', to: 'P', value: 0.1, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }, { id: 'two', type: 'height-difference', from: 'BM', to: 'P', value: 0.1001, unit: 'm', sigma: 0.001, sigmaUnit: 'm' }]
    } })
    const thread = await runtime.threadService.create({ workspace: root, model: 'synthetic-model', mode: 'agent', domain: 'engineering', projectId: project.id })
    const created = await runtime.engineeringAi!.createPlan({ threadId: thread.id, projectId: project.id, goal: '水准网平差和成果', idempotencyKey: 'probe-plan' })
    expect(created.plan.status).toBe('awaiting_approval')
    const approved = runtime.engineeringAi!.approvePlan(created.plan.id, { expectedRevision: created.plan.revision, contextHash: created.plan.contextHash, stepIds: created.approval.stepIds, token: created.approval.token, idempotencyKey: 'probe-approve' })
    const started = await runtime.engineeringAi!.startPlan(approved.id, { expectedRevision: approved.revision, contextHash: approved.contextHash, model: 'synthetic-model', idempotencyKey: 'probe-start' })
    let turn = await runtime.turnService.getTurn(thread.id, started.turn.turnId)
    const deadline = Date.now() + 10_000
    while (turn?.status === 'running' && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 20)); turn = await runtime.turnService.getTurn(thread.id, started.turn.turnId) }
    const task = runtime.taskRepository!.get(started.plan.taskId!)!
    const items = await runtime.sessionStore.loadItems(thread.id)
    const evidence = started.plan.steps.map(step => ({ id: step.id, tool: step.tool, receipt: repo.stepEvidence(started.plan.id, step.id) }))
    const report = { syntheticOnly: true, realModelUsed: false, planId: started.plan.id, networkId: network.id, steps: evidence, modelCalls: calls, turnStatus: turn?.status, taskStatus: task.status, taskAcceptance: task.acceptance, rawPlanStatus: runtime.engineeringAi!.getPlan(started.plan.id)?.status, toolCalls: items.filter(item => item.turnId === turn?.id && item.kind === 'tool_call').length, adjustmentCount: runtime.surveyService!.listAdjustments(project.id).length, finalResponse: task.finalResponse }
    await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    expect(report.taskStatus).toBe('completed')
    expect(report.toolCalls).toBe(0)
    expect(evidence.every(step => step.receipt === null)).toBe(true)
  } finally {
    repo.close(); await runtime.shutdown?.(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
}, 15_000)
